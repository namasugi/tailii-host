// apiAgent/sdkInstaller.ts
// Agent SDK（API 作業）の導入。契機は 3 つだけ（それ以外では取得しない）:
//   1. `tailii setup`（省くときは `--no-api-agent` / `TAILII_SKIP_API_AGENT=1`）
//   2. 自己更新の後（導入済みの host だけ。使う claude と合わなくなっていれば入れ直す）
//   3. アプリで API 作業を始めようとして SDK が無い・使えないとき（利用者が API 作業を選んだことを導入の意思とみなす）
// 手動の `tailii api-agent install` も同じ処理を使う。
//
// 供給網: 取得するのは公式の `@anthropic-ai/claude-agent-sdk` だけ。版は導入前に正確な版へ解決して固定し、公式 registry
// （registry.npmjs.org）を明示し、インストールスクリプトは実行しない（--ignore-scripts）。本体同梱の実行ファイルは入れない
// （--omit=optional。導入済みの claude を使う）。導入後にパッケージ名・版・入口のファイル・claudeCodeVersion を確かめる。
// tailii-host 本体と違い、アプリが同梱する integrity のピンは無い（npm が registry の integrity で検証する範囲に留まる）。
//
// 原子性: 一時フォルダへ入れて確かめてから `sdk` と置き換える。途中で失敗・中断しても `sdk` は前の状態のまま（無ければ無いまま）
// なので、壊れかけを導入済みと判定しない。同時に 2 回走らないよう、プロセス内の single-flight とフォルダの lock を併用する。

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { versionAtLeast } from "../shared/cliVersions.js";
import { AGENT_SDK_PACKAGE, defaultAgentSdkDir, resolveInstalledClaude } from "./sdkLoader.js";
import { agentSdkStatus, installedClaudeVersion, readAgentSdkPackage, type AgentSdkStatus } from "./sdkStatus.js";

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;

export type SdkInstallError =
  | "npm_missing" | "registry_failed" | "install_failed" | "verify_failed" | "disk_failed"
  | "claude_missing" | "claude_update_required" | "timeout";

export type SdkInstallPhase = "resolving" | "downloading" | "verifying" | "switching";

/** 利用者向けの文言（アプリにもそのまま出す。「Mac」や端末名を出さない）。 */
export const SDK_INSTALL_MESSAGES: Record<SdkInstallError, string> = {
  npm_missing: "API 作業の準備に必要な npm がホストに見つかりません。Node.js（npm を含む）を入れてから、もう一度お試しください。",
  registry_failed: "API 作業の準備に必要なパッケージを取得できませんでした。ホストのネットワークを確かめて、もう一度お試しください。",
  install_failed: "API 作業の準備に失敗しました。ホストで `tailii api-agent install` を実行すると詳しい理由が分かります。",
  verify_failed: "取得したパッケージを確かめられなかったため、導入をやめました。もう一度お試しください。",
  disk_failed: "ホストの空き容量が足りないため、API 作業の準備ができませんでした。",
  claude_missing: "API 作業にはホストの Claude Code が必要です。Claude Code を入れてから、もう一度お試しください。",
  claude_update_required: "ホストの Claude Code が古いため、API 作業を準備できません。ホストで `claude update` を実行してください。",
  timeout: "API 作業の準備が時間内に終わりませんでした。もう一度お試しください。",
};

export type CommandRunner = (file: string, args: string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) =>
  Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;

export function defaultCommandRunner(): CommandRunner {
  return (file, args, options) => new Promise((resolve) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: options.env },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), ...(failure?.killed === true ? { timedOut: true } : {}) });
      });
  });
}

/** npm の場所（host と同じ node に付いてくる npm を優先し、無ければ既知の置き場所）。 */
export function resolveNpm(execPath: string = process.execPath, home: string = os.homedir()): string | null {
  const candidates = [
    path.join(path.dirname(execPath), "npm"),
    "/opt/homebrew/bin/npm", "/usr/local/bin/npm", path.join(home, ".local", "bin", "npm"),
  ];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* 次へ。 */ }
  }
  return null;
}

/**
 * npm を走らせる env。SSH 非対話・launchd の狭い PATH でも npm の `#!/usr/bin/env node` が同じ node を見つけるよう、
 * host の node の場所を先頭に足す。npm の設定（独自 registry 等）はコマンドの引数で上書きする。
 */
export function npmEnvironment(base: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): NodeJS.ProcessEnv {
  const dirs = [path.dirname(execPath), ...(base["PATH"] ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return { ...base, PATH: [...new Set(dirs.filter((d) => d.startsWith("/")))].join(":"), npm_config_update_notifier: "false", npm_config_fund: "false" };
}

/** 導入済みの claude（2.1.N）に対応する SDK の版の候補（0.3.N）。対応規則が外れていれば null。 */
export function matchingSdkVersionCandidate(claudeVersion: string | null): string | null {
  const match = claudeVersion === null ? null : /^2\.1\.(\d+)$/.exec(claudeVersion);
  return match === null ? null : `0.3.${match[1]}`;
}

function classify(stderr: string, timedOut: boolean | undefined): SdkInstallError {
  if (timedOut === true) return "timeout";
  if (/ENOSPC|no space left/i.test(stderr)) return "disk_failed";
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|E404|E5\d\d|network|socket hang up/i.test(stderr)) return "registry_failed";
  return "install_failed";
}

export interface SdkInstallDeps {
  runner?: CommandRunner;
  npm?: string | null;
  /** 導入済みの claude の版（null は見つからない）。 */
  claudeVersion?: () => string | null;
  dir?: string;
  onPhase?: (phase: SdkInstallPhase) => void;
  log?: (line: string) => void;
  /** 版を明示する（手動の --version）。省略時は claude に合わせて解決する。 */
  version?: string;
}

export type SdkInstallResult =
  | { ok: true; version: string; claudeCodeVersion: string | null; dir: string }
  | { ok: false; error: SdkInstallError; message: string; detail?: string };

function failure(error: SdkInstallError, detail?: string): SdkInstallResult {
  return { ok: false, error, message: SDK_INSTALL_MESSAGES[error], ...(detail !== undefined ? { detail } : {}) };
}

/**
 * 入れる版を正確な版へ解決する（`npm view` は最大 2 回）。claude 2.1.N に対する 0.3.N があれば、その claudeCodeVersion が
 * 導入済みの claude と一致することを確かめて使う。無ければ最新の版を、その claudeCodeVersion が導入済みの claude 以下の
 * ときだけ使う（claude の方が古ければ claude_update_required）。
 */
export async function resolveSdkVersion(deps: Required<Pick<SdkInstallDeps, "runner">> & { npm: string; claudeVersion: string; env: NodeJS.ProcessEnv }):
  Promise<{ ok: true; version: string } | { ok: false; error: SdkInstallError; detail?: string }> {
  const view = async (spec: string): Promise<{ version?: string; claudeCodeVersion?: string } | SdkInstallError> => {
    const result = await deps.runner(deps.npm, ["view", `${AGENT_SDK_PACKAGE}@${spec}`, "version", "claudeCodeVersion", "--json",
      `--registry=${OFFICIAL_REGISTRY}`], { timeoutMs: 60_000, env: deps.env });
    if (result.code !== 0) return classify(result.stderr, result.timedOut);
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      const record = (Array.isArray(parsed) ? parsed.at(-1) : parsed) as Record<string, unknown> | undefined;
      return {
        ...(typeof record?.["version"] === "string" ? { version: record["version"] } : {}),
        ...(typeof record?.["claudeCodeVersion"] === "string" ? { claudeCodeVersion: record["claudeCodeVersion"] } : {}),
      };
    } catch {
      return "registry_failed";
    }
  };
  const candidate = matchingSdkVersionCandidate(deps.claudeVersion);
  if (candidate !== null) {
    const matched = await view(candidate);
    if (typeof matched !== "string" && matched.version === candidate && matched.claudeCodeVersion === deps.claudeVersion) {
      return { ok: true, version: candidate };
    }
    // 合う版が無い（E404）・取得に失敗した → 最新の版を確かめる（そちらも取れなければ失敗にする）。
  }
  const latest = await view("latest");
  if (typeof latest === "string") return { ok: false, error: latest };
  if (latest.version === undefined || !EXACT_VERSION.test(latest.version)) return { ok: false, error: "registry_failed" };
  if (latest.claudeCodeVersion !== undefined && versionAtLeast(deps.claudeVersion, latest.claudeCodeVersion) === false) {
    return { ok: false, error: "claude_update_required", detail: `SDK ${latest.version} は claude ${latest.claudeCodeVersion} 以上が必要` };
  }
  return { ok: true, version: latest.version };
}

/** 一時フォルダに入ったパッケージを確かめる（名前・版・入口・claudeCodeVersion）。 */
export function verifyInstalledSdk(prefix: string, version: string): { ok: true; claudeCodeVersion: string | null } | { ok: false; detail: string } {
  const pkgDir = path.join(prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>; }
  catch { return { ok: false, detail: "package.json が読めない" }; }
  if (manifest["name"] !== AGENT_SDK_PACKAGE) return { ok: false, detail: "パッケージ名が違う" };
  if (manifest["version"] !== version) return { ok: false, detail: `版が違う（${String(manifest["version"])}）` };
  const main = typeof manifest["main"] === "string" ? manifest["main"] : "sdk.mjs";
  if (path.isAbsolute(main) || main.includes("..")) return { ok: false, detail: "入口の指定が不正" };
  try { if (!fs.statSync(path.join(pkgDir, main)).isFile()) return { ok: false, detail: "入口のファイルが無い" }; }
  catch { return { ok: false, detail: "入口のファイルが無い" }; }
  return { ok: true, claudeCodeVersion: typeof manifest["claudeCodeVersion"] === "string" ? manifest["claudeCodeVersion"] : null };
}

function removeQuietly(target: string): void {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 片付けの失敗は次回に回す。 */ }
}

/** 前回の中断で残った一時フォルダを片付ける（lock を持っているときだけ呼ぶ）。 */
function cleanupLeftovers(base: string): void {
  let entries: string[] = [];
  try { entries = fs.readdirSync(base); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(".sdk-install-") || entry.startsWith(".sdk-old-")) removeQuietly(path.join(base, entry));
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** フォルダの lock（別のプロセス = setup・自己更新・手動コマンド・engine が同時に入れない）。取れなければ null。 */
export function acquireInstallLock(base: string): (() => void) | null {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const lockPath = path.join(base, "install.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lockPath); } catch { /* 既に無い。 */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        const holder = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; startedAt?: unknown };
        const stale = typeof holder.pid !== "number" || !pidAlive(holder.pid) ||
          (typeof holder.startedAt === "number" && Date.now() - holder.startedAt > 30 * 60_000);
        if (!stale) return null;
      } catch { /* 読めない lock は残骸とみなす。 */ }
      try { fs.unlinkSync(lockPath); } catch { return null; }
    }
  }
  return null;
}

/**
 * SDK を導入する（一時フォルダ → 確かめる → 置き換え）。lock が取れないときは導入しない（呼び出し側が「準備中」とみなす）。
 */
export async function installAgentSdkAtomic(deps: SdkInstallDeps = {}): Promise<SdkInstallResult | { ok: false; error: "busy" }> {
  const dir = deps.dir ?? defaultAgentSdkDir();
  const base = path.dirname(dir);
  const runner = deps.runner ?? defaultCommandRunner();
  const npm = deps.npm === undefined ? resolveNpm() : deps.npm;
  if (npm === null) return failure("npm_missing");
  if (deps.version !== undefined && !EXACT_VERSION.test(deps.version)) return failure("install_failed", `版の指定が不正: ${deps.version}`);
  const release = acquireInstallLock(base);
  if (release === null) return { ok: false, error: "busy" };
  const env = npmEnvironment();
  const temporary = path.join(base, `.sdk-install-${randomUUID()}`);
  try {
    cleanupLeftovers(base);
    let version = deps.version;
    if (version === undefined) {
      deps.onPhase?.("resolving");
      const claudeVersion = (deps.claudeVersion ?? defaultClaudeVersion)();
      if (claudeVersion === null) return failure("claude_missing");
      const resolved = await resolveSdkVersion({ runner, npm, claudeVersion, env });
      if (!resolved.ok) return failure(resolved.error, resolved.detail);
      version = resolved.version;
    }
    deps.onPhase?.("downloading");
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(temporary, "package.json"),
      JSON.stringify({ name: "tailii-api-agent-sdk", private: true, description: "Tailii API 作業用の Agent SDK" }, null, 2) + "\n");
    const args = ["install", "--prefix", temporary, `--registry=${OFFICIAL_REGISTRY}`, "--no-audit", "--no-fund",
      "--ignore-scripts", "--save-exact", "--omit=optional", "--no-update-notifier", `${AGENT_SDK_PACKAGE}@${version}`];
    deps.log?.(`npm ${args.map((a) => (a === temporary ? "<一時フォルダ>" : a)).join(" ")}`);
    const installed = await runner(npm, args, { cwd: temporary, timeoutMs: 10 * 60_000, env });
    if (installed.code !== 0) {
      const error = classify(installed.stderr, installed.timedOut);
      return failure(error, installed.stderr.trim().split("\n").slice(-3).join(" "));
    }
    deps.onPhase?.("verifying");
    const verified = verifyInstalledSdk(temporary, version);
    if (!verified.ok) return failure("verify_failed", verified.detail);
    deps.onPhase?.("switching");
    // 置き換え: 旧 sdk を退避 → 新しい中身を sdk へ → 旧を消す。途中で失敗したら旧を戻す。
    const old = path.join(base, `.sdk-old-${randomUUID()}`);
    const hadOld = fs.existsSync(dir);
    if (hadOld) fs.renameSync(dir, old);
    try {
      fs.renameSync(temporary, dir);
    } catch (error) {
      if (hadOld) fs.renameSync(old, dir);
      throw error;
    }
    if (hadOld) removeQuietly(old);
    return { ok: true, version, claudeCodeVersion: verified.claudeCodeVersion, dir };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failure(code === "ENOSPC" ? "disk_failed" : "install_failed", String(error));
  } finally {
    removeQuietly(temporary);
    release();
  }
}

function defaultClaudeVersion(): string | null {
  const claude = resolveInstalledClaude();
  return claude === null ? null : installedClaudeVersion(claude);
}

/** 今の状態で導入（入れ直し）が必要か。claude_missing は SDK を入れても直らない。 */
export function sdkNeedsInstall(status: AgentSdkStatus): "install" | "none" | "claude_missing" {
  switch (status.compatibility) {
    case "not_installed": return "install";
    case "claude_older": return "install"; // claude に合う版へ入れ直せば直る（無ければ claude_update_required）。
    case "claude_missing": return "claude_missing";
    default: return "none";
  }
}

// MARK: - アプリからの準備（契機 3）

export type SdkPrepareStatus =
  | { state: "ready"; version: string | null }
  | { state: "installing"; phase: SdkInstallPhase | "waiting"; startedAtMs: number }
  | { state: "failed"; error: SdkInstallError; message: string };

/**
 * アプリの「API 作業を始める」から呼ぶ準備。`start` が true なら必要なときだけ導入を始め、すぐ今の状態を返す
 * （導入は 1 分程度かかり得るので、会話開始の応答待ちに入れない。アプリは状態を聞き直して待つ）。
 * 同じプロセス内では 1 本だけ走らせ、別プロセスが導入中（lock）なら「準備中」を返す。
 */
export class AgentSdkPreparer {
  private running: { phase: SdkInstallPhase | "waiting"; startedAtMs: number; promise: Promise<void> } | null = null;
  private lastFailure: { error: SdkInstallError; message: string } | null = null;

  constructor(private readonly deps: {
    status?: () => AgentSdkStatus;
    install?: (onPhase: (phase: SdkInstallPhase) => void) => Promise<SdkInstallResult | { ok: false; error: "busy" }>;
    /** 別のプロセスの導入中（lock がある）か。 */
    lockHeld?: () => boolean;
    waitMs?: number;
    now?: () => number;
    log?: (line: string) => void;
  } = {}) {}

  prepare(start: boolean): SdkPrepareStatus {
    if (this.running !== null) return { state: "installing", phase: this.running.phase, startedAtMs: this.running.startedAtMs };
    const status = (this.deps.status ?? (() => agentSdkStatus()))();
    const need = sdkNeedsInstall(status);
    if (need === "none") { this.lastFailure = null; return { state: "ready", version: status.sdkVersion }; }
    if (need === "claude_missing") return { state: "failed", error: "claude_missing", message: SDK_INSTALL_MESSAGES.claude_missing };
    // 失敗の後の聞き直し（start=false）では入れ直さない。利用者が「もう一度」を選んだときだけ start=true で始める。
    if (!start && this.lastFailure !== null) return { state: "failed", ...this.lastFailure };
    const startedAtMs = (this.deps.now ?? Date.now)();
    const install = this.deps.install ?? ((onPhase) => installAgentSdkAtomic({ onPhase, ...(this.deps.log ? { log: this.deps.log } : {}) }));
    const run = { phase: "resolving" as SdkInstallPhase | "waiting", startedAtMs, promise: Promise.resolve() };
    run.promise = (async () => {
      try {
        const result = await install((phase) => { run.phase = phase; });
        if (result.ok) {
          this.lastFailure = null;
          this.deps.log?.(`api-agent SDK 導入 ${result.version}`);
        } else if (result.error === "busy") {
          // 別のプロセス（setup・自己更新・手動コマンド）が導入中。lock が消えるまで待ち、状態は次の聞き直しで読み直す。
          run.phase = "waiting";
          const lockHeld = this.deps.lockHeld ?? (() => fs.existsSync(path.join(path.dirname(defaultAgentSdkDir()), "install.lock")));
          const deadline = (this.deps.now ?? Date.now)() + 15 * 60_000;
          while (lockHeld() && (this.deps.now ?? Date.now)() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, this.deps.waitMs ?? 2_000));
          }
        } else {
          this.lastFailure = { error: result.error, message: result.message };
          this.deps.log?.(`api-agent SDK 導入失敗 ${result.error}${"detail" in result && result.detail ? `: ${result.detail}` : ""}`);
        }
      } catch (error) {
        this.lastFailure = { error: "install_failed", message: SDK_INSTALL_MESSAGES.install_failed };
        this.deps.log?.(`api-agent SDK 導入失敗: ${String(error)}`);
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    this.lastFailure = null;
    return { state: "installing", phase: run.phase, startedAtMs };
  }

  /** テスト用: 走っている導入の終わりを待つ。 */
  async settled(): Promise<void> { await this.running?.promise; }
}

/** 導入済みの SDK の版（読み取りだけ）。 */
export function installedSdkVersion(dir: string = defaultAgentSdkDir()): string | null {
  const entry = path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  return fs.existsSync(entry) ? readAgentSdkPackage(entry).version : null;
}

/**
 * 自己更新の後の追従（導入の契機 2）。導入済みの host だけを対象にし、使う claude と合わなくなっていれば入れ直す。
 * 未導入の host には入れない。失敗しても投げない（更新のトランザクションとは切り離して呼ぶ）。
 */
export async function alignInstalledSdkAfterUpdate(options: {
  log: (line: string) => void;
  status?: () => AgentSdkStatus;
  install?: () => Promise<SdkInstallResult | { ok: false; error: "busy" }>;
}): Promise<"skipped" | "aligned" | "reinstalled" | "failed"> {
  try {
    const status = (options.status ?? (() => agentSdkStatus()))();
    if (!status.installed) return "skipped";
    if (sdkNeedsInstall(status) !== "install") return "aligned";
    options.log(`Agent SDK ${status.sdkVersion ?? "?"} が使う claude と合わないため入れ直します`);
    const result = await (options.install ?? (() => installAgentSdkAtomic()))();
    if (result.ok) { options.log(`Agent SDK を ${result.version} へ入れ直しました`); return "reinstalled"; }
    options.log(`Agent SDK の入れ直しに失敗（${result.error}）。アプリで API 作業を始めるときに再度準備します`);
    return "failed";
  } catch (error) {
    options.log(`Agent SDK の確認に失敗: ${String(error)}`);
    return "failed";
  }
}
