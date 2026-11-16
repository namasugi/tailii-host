// 会話・engine 接続から独立したCLI更新。使用中のエージェントは停止しない。
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultInjectedPath } from "../commands/launch.js";
import { findCommand, resolveOwnCliPath } from "../commands/doctor.js";
import { compareTriple, parseTriple } from "../commands/selfUpdate.js";
import type { CodexUpdateInfo } from "../protocol.js";
import { acquireHubExclusiveLock, isNodeSqliteAvailable, readProcessArgsAsync } from "../hub/hubStartup.js";
import { sleep } from "../shared/sleep.js";

const CACHE_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const environment = (profile: CLIUpdateProfile): NodeJS.ProcessEnv => ({
  ...process.env, PATH: `${defaultInjectedPath()}:${process.env["PATH"] ?? ""}`,
  ...profile.env,
});

interface UpdateJob {
  token: string;
  status: "updating" | "updated" | "failed";
  pid: number;
  startedAt: number;
  target: string;
  installedVersion?: string;
  error?: string;
}

export interface CLIUpdaterOptions {
  root?: string;
  now?: () => number;
  resolveCommand?: () => string | null;
  version?: (command: string) => Promise<string | null>;
  latest?: () => Promise<string>;
  spawnWorker?: (token: string) => number;
}

const readJSON = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as unknown; } catch { return null; }
};
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const validVersion = (value: unknown): value is string => typeof value === "string" && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value);
const newer = (a: string, b: string): boolean => compareTriple(parseTriple(a)!, parseTriple(b)!) > 0;

function atomicJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function cliVersion(command: string, profile: CLIUpdateProfile): Promise<string | null> {
  return new Promise((resolve) => execFile(command, ["--version"], {
    env: environment(profile), timeout: 5000, maxBuffer: 32 * 1024,
  }, (error, stdout) => resolve(error ? null : profile.versionPattern.exec(stdout.trim())?.[1] ?? null)));
}

export interface CLIUpdateProfile {
  commandName: "codex" | "claude";
  displayName: string;
  workerCommand: string;
  versionPattern: RegExp;
  env: NodeJS.ProcessEnv;
  supports: (command: string) => boolean;
  latest: () => Promise<string>;
  releaseCacheKey?: () => string;
}

/** 実体が既知の版別ディレクトリにあるnativeインストールだけを更新する。 */
export function installedWithin(command: string, directory: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(command));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}

export class CLIUpdater {
  readonly root: string;
  private readonly options: CLIUpdaterOptions;
  private pendingCheck: Promise<CodexUpdateInfo> | null = null;

  constructor(private readonly profile: CLIUpdateProfile, options: CLIUpdaterOptions = {}) {
    this.options = options;
    this.root = options.root ?? path.join(os.homedir(), ".tailii", `${profile.commandName}-update`);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private reservationPending(job: UpdateJob): boolean {
    const age = this.now() - job.startedAt;
    return age >= 0 && age < 15_000;
  }
  private command(): string | null {
    return (this.options.resolveCommand ?? (() => findCommand(this.profile.commandName, environment(this.profile)["PATH"] ?? "")))();
  }

  supports(command: string): boolean { return this.profile.supports(command); }
  private version(command: string): Promise<string | null> {
    return (this.options.version ?? ((value) => cliVersion(value, this.profile)))(command);
  }

  private job(): UpdateJob | null {
    const job = record(readJSON(path.join(this.root, "job.json")));
    if (job === null || typeof job["token"] !== "string" || !/^[a-f0-9-]{36}$/.test(job["token"]) ||
      !validVersion(job["target"]) || typeof job["startedAt"] !== "number" || !Number.isFinite(job["startedAt"]) ||
      typeof job["pid"] !== "number" || !Number.isSafeInteger(job["pid"]) || job["pid"] < 0 || job["pid"] > 0x7fffffff ||
      (job["installedVersion"] !== undefined && !validVersion(job["installedVersion"])) ||
      (job["error"] !== undefined && typeof job["error"] !== "string") ||
      !["updating", "updated", "failed"].includes(String(job["status"]))) return null;
    return job as unknown as UpdateJob;
  }

  /** worker が落ちても、同じ process group のインストーラが残っていれば重複実行しない。 */
  private async updateGroupAlive(job: UpdateJob): Promise<boolean> {
    if (job.pid <= 0) return false;
    try { process.kill(-job.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    const leader = await readProcessArgsAsync(job.pid);
    // 親が消えた group は子の終了まで残る。不明の場合も勝手に別の更新を始めない。
    if (leader.kind === "gone" || leader.kind === "unknown") return true;
    if (leader.kind === "argv") {
      const index = leader.argv.indexOf(this.profile.workerCommand);
      return index >= 0 && leader.argv[index + 1] === job.token;
    }
    if (leader.command.includes("<defunct>") || /^\([^)]*\)$/.test(leader.command.trim())) return true;
    // PID が再利用された別の group を「更新中」として保持しない。
    return new RegExp(`(?:^|\\s)${this.profile.workerCommand}\\s+${job.token}(?:\\s|$)`).test(leader.command);
  }

  check(): Promise<CodexUpdateInfo> {
    if (this.pendingCheck !== null) return this.pendingCheck;
    this.pendingCheck = this.checkOnce().finally(() => { this.pendingCheck = null; });
    return this.pendingCheck;
  }

  private async pendingWithoutCli(): Promise<CodexUpdateInfo> {
    const job = this.job();
    const unavailable: CodexUpdateInfo = { status: "unavailable", canUpdate: false };
    if (job?.status !== "updating" && job?.status !== "failed") return unavailable;
    const pending: CodexUpdateInfo = { status: "updating", canUpdate: false, latestVersion: job.target };
    const lock = acquireHubExclusiveLock(path.join(this.root, "update.lock.db"));
    if (lock === null) return pending;
    if (lock === "unsupported") return unavailable;
    try {
      return (job.status === "updating" && this.reservationPending(job)) || await this.updateGroupAlive(job)
        ? pending : unavailable;
    } finally { lock.release(); }
  }

  private async checkOnce(): Promise<CodexUpdateInfo> {
    const command = this.command();
    if (command === null) return this.pendingWithoutCli();
    let currentVersion = await this.version(command);
    if (!validVersion(currentVersion)) return this.pendingWithoutCli();
    const canUpdate = this.supports(command) && isNodeSqliteAvailable();
    let job = this.job();
    if (job?.status === "updating" || job?.status === "failed") {
      // 更新を実行する worker は OS の排他を保持する。時刻・pid だけで lock を奪わない。
      const lock = acquireHubExclusiveLock(path.join(this.root, "update.lock.db"));
      if (lock === null) {
        return { status: "updating", canUpdate, currentVersion, latestVersion: job.target };
      }
      if (lock === "unsupported") return { status: "unsupported", canUpdate: false, currentVersion, latestVersion: job.target };
      try {
        job = this.job();
        if (job?.status === "failed") {
          // timeout 等で直接の子が終わっても、インストーラの孫が残っている間は再実行しない。
          if (await this.updateGroupAlive(job)) {
            job.status = "updating";
            delete job.error;
            atomicJSON(path.join(this.root, "job.json"), job);
            return { status: "updating", canUpdate, currentVersion, latestVersion: job.target };
          }
          const installed = await this.version(command);
          if (validVersion(installed) && !newer(job.target, installed)) {
            job.status = "updated";
            job.installedVersion = installed;
            currentVersion = installed;
            delete job.error;
            atomicJSON(path.join(this.root, "job.json"), job);
          }
        }
        if (job?.status === "updating") {
          if (this.reservationPending(job)) {
            return { status: "updating", canUpdate, currentVersion, latestVersion: job.target };
          }
          if (await this.updateGroupAlive(job)) {
            return { status: "updating", canUpdate, currentVersion, latestVersion: job.target };
          }
          const installed = await this.version(command);
          if (validVersion(installed) && !newer(job.target, installed)) {
            job.status = "updated";
            job.installedVersion = installed;
            currentVersion = installed;
          } else {
            job.status = "failed";
            job.error = "更新が途中で終了しました。もう一度お試しください。";
          }
          atomicJSON(path.join(this.root, "job.json"), job);
        }
      } finally { lock.release(); }
    }
    const releaseFile = path.join(this.root, this.profile.releaseCacheKey?.() ?? "release.json");
    const cached = record(readJSON(releaseFile));
    let latest = validVersion(cached?.["version"]) ? cached["version"] : null;
    const fresh = latest !== null && cached !== null && typeof cached["at"] === "number" &&
      this.now() - cached["at"] >= 0 && this.now() - cached["at"] < CACHE_MS;
    if (!fresh) {
      try {
        const candidate = await (this.options.latest ?? this.profile.latest)();
        if (!validVersion(candidate)) throw new Error("invalid version");
        latest = candidate;
        atomicJSON(releaseFile, { version: latest, at: this.now() });
      } catch {
        // オフラインでも最後に確認できた更新は提示できる。未知の版を最新とは断定しない。
        if (latest === null) return { status: "unavailable", canUpdate, currentVersion };
      }
    }
    if (latest === null) return { status: "unavailable", canUpdate, currentVersion };
    if (!newer(latest, currentVersion)) {
      return { status: job?.status === "updated" && job.installedVersion === currentVersion ? "updated" : "current",
        canUpdate, currentVersion, latestVersion: currentVersion };
    }
    if (!canUpdate) return { status: "unsupported", canUpdate, currentVersion, latestVersion: latest };
    if (job?.status === "failed" && job.target === latest) {
      return { status: "failed", canUpdate, currentVersion, latestVersion: latest, error: job.error };
    }
    return { status: "available", canUpdate, currentVersion, latestVersion: latest };
  }

  async install(): Promise<CodexUpdateInfo> {
    const info = await this.check();
    if (!info.canUpdate || info.status === "updating" || info.latestVersion === undefined ||
      info.currentVersion === undefined || !newer(info.latestVersion, info.currentVersion)) return info;
    const lock = acquireHubExclusiveLock(path.join(this.root, "update.lock.db"));
    if (lock === null) return { ...info, status: "updating" };
    if (lock === "unsupported") return { ...info, status: "unsupported", canUpdate: false };
    const job: UpdateJob = {
      token: randomUUID(), status: "updating", pid: 0, startedAt: this.now(), target: info.latestVersion,
    };
    try {
      // check を待つ間に別の端末が開始・完了した更新を上書きしない。
      const existing = this.job();
      if (existing?.status === "updating") return { ...info, status: "updating" };
      const command = this.command();
      if (command === null || !this.supports(command)) return { ...info, status: "unsupported", canUpdate: false };
      // 成功記録は履歴であり、今の設置版の根拠にはしない（巻き戻し・別端末での更新にも対応）。
      const installed = await this.version(command);
      if (!validVersion(installed)) return { ...info, status: "unavailable" };
      if (!newer(info.latestVersion, installed)) {
        return { ...info, status: existing?.status === "updated" && existing.installedVersion === installed ? "updated" : "current",
          currentVersion: installed, latestVersion: installed };
      }
      atomicJSON(path.join(this.root, "job.json"), job);
      (this.options.spawnWorker ?? ((token: string) => {
        const log = fs.openSync(path.join(this.root, "update.log"), "a", 0o600);
        try {
          const child = spawn(process.execPath, [resolveOwnCliPath(), this.profile.workerCommand, token], {
            detached: true, stdio: ["ignore", log, log], env: environment(this.profile), cwd: os.homedir(),
          });
          child.on("error", () => { /* pid があれば worker 消失を check が回収する。 */ });
          if (child.pid === undefined) throw new Error("worker did not start");
          child.unref();
          return child.pid;
        } finally { fs.closeSync(log); }
      }))(job.token);
      return { ...info, status: "updating" };
    } catch {
      job.status = "failed";
      job.error = "更新を開始できませんでした。もう一度お試しください。";
      atomicJSON(path.join(this.root, "job.json"), job);
      return { ...info, status: "failed", error: job.error };
    } finally { lock.release(); }
  }

  /** 内部 CLI 専用。入力からコマンドやパスを受けず、既知の standalone 更新だけを実行する。 */
  async runWorker(token: string, run: (command: string) => Promise<void> = (command) => new Promise((resolve, reject) => {
    execFile(command, ["update"], { env: environment(this.profile), timeout: UPDATE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        if (error) reject(error); else resolve();
      });
  })): Promise<void> {
    // 親が予約を書いてから排他を解放するまでだけ待つ。長い更新中の worker と重複実行しない。
    const deadline = Date.now() + 15_000;
    let lock = acquireHubExclusiveLock(path.join(this.root, "update.lock.db"));
    while (lock === null && Date.now() < deadline) {
      await sleep(30);
      lock = acquireHubExclusiveLock(path.join(this.root, "update.lock.db"));
    }
    if (lock === null || lock === "unsupported") return;
    const job = this.job();
    if (job?.status !== "updating" || job.token !== token) { lock.release(); return; }
    try {
      job.pid = process.pid;
      atomicJSON(path.join(this.root, "job.json"), job);
      const command = this.command();
      if (command === null || !this.supports(command)) throw new Error("unsupported installation");
      await run(command);
      const installed = await this.version(command);
      if (!validVersion(installed) || newer(job.target, installed)) throw new Error("version not updated");
      job.status = "updated";
      job.installedVersion = installed;
    } catch {
      job.status = "failed";
      job.error = `${this.profile.displayName}を更新できませんでした。接続や空き容量を確認して、もう一度お試しください。`;
    } finally {
      try {
        if (this.job()?.token === job.token) atomicJSON(path.join(this.root, "job.json"), job);
      } finally { lock.release(); }
    }
  }
}
