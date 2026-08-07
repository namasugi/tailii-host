// selfUpdate.ts — host の自己更新（アプリのピン値へ収束させる pull 型アップデータ）
//
// iPhone アプリが channel_hello の serverVersion と自分のピン値を照合し、
// host が古ければ host_update_request → engine が本コマンドを detached で起動する。
// 本コマンドは「今走っている旧バージョンのコード」で新バージョンを設置する
// 自己完結トランザクション（新旧バージョン間の CLI 契約は `--version` のみ。凍結）。
//
// トランザクション:
//   検証(managed/ダウングレード/lock) → registry メタ取得 → engines.node 事前検査
//   → tarball DL + SRI 検証（アプリ同梱 integrity を優先） → system tar で展開
//   → deps(ws / qrcode-terminal / QUIC prebuilt) を registry から配置
//   → スモーク（新 cli --version） → シム atomic swap（旧シムは .prev に保存）
//   → QUIC LaunchAgent 再設置（設置済みホストのみ） → 旧版 GC
//
// 常駐プロセスの世代交代は既存機構に委ねる: アプリ再接続で旧 engine は EOF 死、
// 新 engine の ensureHubDaemon が version 不一致の旧 hub を SIGTERM で退かせる。
//
// 失敗は ~/.tailii/host/last-update.json に記録し、次回 channel_hello の
// updateError としてアプリへ届く（成功は serverVersion の変化そのものが証明）。

import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultShimBinDir, resolveOwnCliPath, shimContent } from "./doctor.js";
import { readPackageVersion } from "../shared/version.js";
import {
  installQuicLaunchAgent,
  quicLaunchAgentPlistPath,
} from "../services/quicGateway.js";

const PACKAGE_NAME = "tailii-host";

/** npm registry のベース URL（`TAILII_NPM_REGISTRY` でミラー/テスト差し替え可）。 */
function registryBase(): string {
  const override = process.env["TAILII_NPM_REGISTRY"];
  return override !== undefined && override !== "" ? override.replace(/\/$/, "") : "https://registry.npmjs.org";
}

// MARK: - 置き場所

/** self-update の管理ルート（この下だけを所有・GC する）。 */
export function selfUpdateRoot(): string {
  return path.join(os.homedir(), ".tailii", "host");
}

export function versionsDir(): string {
  return path.join(selfUpdateRoot(), "versions");
}

export function updateLockPath(): string {
  return path.join(selfUpdateRoot(), "update.lock");
}

export function lastUpdatePath(): string {
  return path.join(selfUpdateRoot(), "last-update.json");
}

export function updateLogPath(): string {
  return path.join(selfUpdateRoot(), "update.log");
}

// MARK: - semver（依存ゼロの最小実装。tailii-host の実運用範囲 = 素の x.y.z と ^x.y.z のみ）

/** "x.y.z" を数値トリプルへ。プレリリース等の非対応形式は null。 */
export function parseTriple(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** トリプル比較（a<b: -1, a==b: 0, a>b: 1）。 */
export function compareTriple(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * caret / 完全一致 range を満たす最大バージョンを候補から選ぶ。
 * 対応 range は "x.y.z" と "^x.y.z" のみ（package.json の実依存で使う形だけ）。
 * 非対応 range は null（呼び出し元が明示エラーにする — 黙って別解釈をしない）。
 */
export function maxSatisfying(versions: string[], range: string): string | null {
  const caret = range.startsWith("^");
  const base = parseTriple(caret ? range.slice(1) : range);
  if (base === null) return null;
  let best: [number, number, number] | null = null;
  let bestRaw: string | null = null;
  for (const raw of versions) {
    const v = parseTriple(raw);
    if (v === null) continue;
    if (caret) {
      // ^x.y.z: 同 major（major=0 は同 minor）かつ base 以上。
      if (base[0] === 0 ? v[0] !== 0 || v[1] !== base[1] : v[0] !== base[0]) continue;
      if (compareTriple(v, base) < 0) continue;
    } else if (compareTriple(v, base) !== 0) {
      continue;
    }
    if (best === null || compareTriple(v, best) > 0) {
      best = v;
      bestRaw = raw;
    }
  }
  return bestRaw;
}

/**
 * engines.node（">=x" / ">=x.y" / ">=x.y.z"）から最低バージョンを読む。
 * 解釈できない形式は null（スモークテストが実挙動の最終ゲートなので、ここは fast-fail 用）。
 */
export function parseEnginesNodeMinimum(range: string | undefined): [number, number, number] | null {
  if (range === undefined) return null;
  const m = /^\s*>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2] ?? "0"), Number(m[3] ?? "0")];
}

// MARK: - 整合性検証

/** SRI sha512 を計算する（npm dist.integrity と同形式）。 */
export function sriSha512(data: Buffer): string {
  return "sha512-" + crypto.createHash("sha512").update(data).digest("base64");
}

/** SRI（sha512-…）または旧 shasum（sha1 hex）で tarball を検証する。 */
export function verifyTarball(
  data: Buffer,
  expected: { integrity?: string; shasum?: string },
): { ok: boolean; detail: string } {
  if (expected.integrity !== undefined) {
    const actual = sriSha512(data);
    if (expected.integrity.startsWith("sha512-")) {
      return actual === expected.integrity
        ? { ok: true, detail: "sha512" }
        : { ok: false, detail: `integrity 不一致 expected=${expected.integrity} actual=${actual}` };
    }
    // sha512 以外の SRI は検証不能として shasum へフォールバックする。
  }
  if (expected.shasum !== undefined) {
    const actual = crypto.createHash("sha1").update(data).digest("hex");
    return actual === expected.shasum
      ? { ok: true, detail: "sha1" }
      : { ok: false, detail: `shasum 不一致 expected=${expected.shasum} actual=${actual}` };
  }
  return { ok: false, detail: "registry に検証可能なハッシュがありません" };
}

// MARK: - インストール状態の判定（channel_hello の managed / RPC のガードと共有）

export interface InstallState {
  /** self-update がシムを差し替えてよい設置か。 */
  managed: boolean;
  /** managed=false の人間可読な理由（診断・ログ用）。 */
  reason: "ok" | "dev-install" | "no-shim" | "foreign-shim";
}

/**
 * 現在の実行元が自動更新の対象かを判定する。
 *   dev-install  — パッケージルートに src/ や .git がある（git clone 開発機）。
 *                  published tarball は dist のみなので、この検査で確実に区別できる。
 *   no-shim      — アプリが実行するシムが無い（差し替え対象が存在しない）。
 *   foreign-shim — シムはあるがマーカーが無い（ユーザー手動管理。壊さない）。
 */
export function resolveInstallState(
  cliPath: string = resolveOwnCliPath(),
  shimBinDir: string = defaultShimBinDir(),
): InstallState {
  const pkgRoot = path.join(path.dirname(cliPath), "..");
  if (fs.existsSync(path.join(pkgRoot, "src")) || fs.existsSync(path.join(pkgRoot, ".git"))) {
    return { managed: false, reason: "dev-install" };
  }
  const shimPath = path.join(shimBinDir, "tailii-host");
  let shim: string;
  try {
    shim = fs.readFileSync(shimPath, "utf8");
  } catch {
    return { managed: false, reason: "no-shim" };
  }
  if (!shim.includes("Tailii host launcher")) return { managed: false, reason: "foreign-shim" };
  return { managed: true, reason: "ok" };
}

// MARK: - 失敗記録（channel_hello.updateError の供給源）

export interface LastUpdateRecord {
  target: string;
  ok: boolean;
  error?: string;
  tsMs: number;
}

export function writeLastUpdate(record: LastUpdateRecord, filePath: string = lastUpdatePath()): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record));
  } catch {
    // 記録は best-effort（更新自体の成否には影響させない）。
  }
}

/**
 * 直近の更新失敗を読む（24h 以内 かつ 現行版が目標に達していない場合のみ）。
 * hello に載せてアプリのバナーへ届けるための供給源。
 */
export function readRecentUpdateError(
  currentVersion: string | null,
  filePath: string = lastUpdatePath(),
): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<LastUpdateRecord>;
    if (record.ok !== false || typeof record.error !== "string") return undefined;
    if (typeof record.tsMs !== "number" || Date.now() - record.tsMs > 24 * 3600_000) return undefined;
    if (typeof record.target === "string" && record.target === currentVersion) return undefined;
    return record.error;
  } catch {
    return undefined;
  }
}

// MARK: - 更新 lock（複数端末の同時トリガを 1 本化する）

interface UpdateLock {
  pid: number;
  target: string;
  tsMs: number;
}

function readLock(): UpdateLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateLockPath(), "utf8")) as Partial<UpdateLock>;
    if (typeof parsed.pid !== "number" || typeof parsed.target !== "string") return null;
    return { pid: parsed.pid, target: parsed.target, tsMs: typeof parsed.tsMs === "number" ? parsed.tsMs : 0 };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 進行中の更新があるか（RPC ハンドラの in_progress 判定と共有）。 */
export function updateInProgress(): boolean {
  const lock = readLock();
  return lock !== null && pidAlive(lock.pid);
}

/** lock を獲得する。獲得できなければ false（進行中）。stale lock は奪う。 */
function acquireLock(target: string): boolean {
  fs.mkdirSync(selfUpdateRoot(), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, target, tsMs: Date.now() });
  try {
    fs.writeFileSync(updateLockPath(), payload, { flag: "wx" });
    return true;
  } catch {
    const lock = readLock();
    if (lock !== null && pidAlive(lock.pid)) return false;
    // 死んだ更新の残骸。上書きで奪う。
    fs.writeFileSync(updateLockPath(), payload);
    return true;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(updateLockPath());
  } catch {
    // 無ければそれでよい。
  }
}

// MARK: - registry アクセス

interface VersionMeta {
  version: string;
  dist: { tarball: string; integrity?: string; shasum?: string };
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function fetchJSON(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
  });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  return response.json();
}

async function fetchVersionMeta(name: string, version: string): Promise<VersionMeta> {
  const url = `${registryBase()}/${encodeURIComponent(name).replace("%2F", "/")}/${version}`;
  const raw = (await fetchJSON(url, 30_000)) as Partial<VersionMeta> | null;
  if (raw === null || typeof raw !== "object" || raw.dist?.tarball === undefined) {
    throw new Error(`${name}@${version} の registry メタデータが不正です`);
  }
  return raw as VersionMeta;
}

/** packument からバージョン一覧を取る（range 解決用・corgi 形式で軽量に）。 */
async function fetchVersionList(name: string): Promise<string[]> {
  const url = `${registryBase()}/${encodeURIComponent(name).replace("%2F", "/")}`;
  const raw = (await fetchJSON(url, 30_000)) as { versions?: Record<string, unknown> } | null;
  if (raw === null || typeof raw !== "object" || raw.versions === undefined) {
    throw new Error(`${name} の packument が不正です`);
  }
  return Object.keys(raw.versions);
}

async function downloadTarball(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// MARK: - 展開

function tarBinary(): string {
  return fs.existsSync("/usr/bin/tar") ? "/usr/bin/tar" : "tar";
}

/** npm tarball（gzip, ルート package/）を destDir へ展開する。 */
async function extractTarball(tgzPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(tarBinary(), ["-xzf", tgzPath, "-C", destDir], { timeout: 120_000 }, (error) => {
      if (error) reject(new Error(`tar 展開失敗: ${String(error)}`));
      else resolve();
    });
  });
}

// MARK: - 更新トランザクション本体

interface SelfUpdateIO {
  log: (line: string) => void;
}

async function installPackageTree(target: string, appIntegrity: string | undefined, io: SelfUpdateIO): Promise<string> {
  // 1. 目標バージョンのメタデータ。未 publish はここで確実に落ちる。
  const meta = await fetchVersionMeta(PACKAGE_NAME, target);

  // 2. アプリ同梱 integrity と registry の食い違いは供給網の警報（続行しない）。
  if (appIntegrity !== undefined && meta.dist.integrity !== undefined && appIntegrity !== meta.dist.integrity) {
    throw new Error(`integrity がアプリのピンと registry で食い違っています(供給網警報): app=${appIntegrity} registry=${meta.dist.integrity}`);
  }

  // 3. engines.node の fast-fail（最終ゲートは後段のスモーク）。
  const minimum = parseEnginesNodeMinimum(meta.engines?.node);
  const current = parseTriple(process.versions.node);
  if (minimum !== null && current !== null && compareTriple(current, minimum) < 0) {
    throw new Error(
      `Node.js が不足しています(必要 ${meta.engines?.node}, 現在 ${process.versions.node})。` +
        "ホストの Node.js を更新してから再試行してください",
    );
  }

  // 4. 本体 tarball の取得と検証（アプリ提供 integrity を優先）。
  io.log(`tarball 取得: ${meta.dist.tarball}`);
  const tarball = await downloadTarball(meta.dist.tarball);
  const verification = verifyTarball(tarball, {
    integrity: appIntegrity ?? meta.dist.integrity,
    shasum: meta.dist.shasum,
  });
  if (!verification.ok) throw new Error(`本体 tarball の検証失敗: ${verification.detail}`);

  // 5. 展開先を組み立てる（既存の中途半端な残骸は作り直す）。
  const installDir = path.join(versionsDir(), target);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });
  const tgzPath = path.join(installDir, "package.tgz");
  fs.writeFileSync(tgzPath, tarball);
  await extractTarball(tgzPath, installDir);
  fs.rmSync(tgzPath, { force: true });
  const packageDir = path.join(installDir, "package");
  if (!fs.existsSync(path.join(packageDir, "dist", "cli.js"))) {
    throw new Error("展開結果に dist/cli.js がありません");
  }

  // 6. deps の配置。通常 deps は全部、optional は現プラットフォームの QUIC prebuilt のみ。
  const nodeModules = path.join(packageDir, "node_modules");
  const wantedDeps: Array<[string, string]> = Object.entries(meta.dependencies ?? {});
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  const platformQuicPkg = `@tailii/quic-gw-darwin-${arch}`;
  for (const [name, range] of Object.entries(meta.optionalDependencies ?? {})) {
    if (process.platform === "darwin" && name === platformQuicPkg) wantedDeps.push([name, range]);
  }
  for (const [name, range] of wantedDeps) {
    const resolved = maxSatisfying(await fetchVersionList(name), range);
    if (resolved === null) {
      throw new Error(`依存 ${name}@${range} を解決できません(self-update は素の x.y.z と ^x.y.z のみ対応)`);
    }
    const depMeta = await fetchVersionMeta(name, resolved);
    io.log(`依存を配置: ${name}@${resolved}`);
    const depTarball = await downloadTarball(depMeta.dist.tarball);
    const depVerification = verifyTarball(depTarball, { integrity: depMeta.dist.integrity, shasum: depMeta.dist.shasum });
    if (!depVerification.ok) throw new Error(`依存 ${name} の検証失敗: ${depVerification.detail}`);
    const depTmp = path.join(installDir, "dep.tgz");
    fs.writeFileSync(depTmp, depTarball);
    const depExtract = path.join(installDir, "dep-extract");
    fs.rmSync(depExtract, { recursive: true, force: true });
    await extractTarball(depTmp, depExtract);
    const depDest = path.join(nodeModules, name);
    fs.mkdirSync(path.dirname(depDest), { recursive: true });
    fs.rmSync(depDest, { recursive: true, force: true });
    fs.renameSync(path.join(depExtract, "package"), depDest);
    fs.rmSync(depExtract, { recursive: true, force: true });
    fs.rmSync(depTmp, { force: true });
  }

  // 7. 実行ビット（bin 利用と手動起動の保険。シム経由は node 引数渡しなので必須ではない）。
  fs.chmodSync(path.join(packageDir, "dist", "cli.js"), 0o755);
  return packageDir;
}

/** 新 cli が現行 node で起動し正しい版を名乗るか（swap 前の最終ゲート）。 */
async function smokeTest(cliPath: string, expectVersion: string): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [cliPath, "--version"], { timeout: 30_000 }, (error, out) => {
      if (error) reject(new Error(`スモーク失敗(新版が起動しません): ${String(error)}`));
      else resolve(out);
    });
  });
  if (stdout.trim() !== expectVersion) {
    throw new Error(`スモーク失敗: --version が ${stdout.trim()}(期待 ${expectVersion})`);
  }
}

/** シムを新 cli へ向け直す。旧シムは .prev として保存（アプリ側の起動フォールバック用）。 */
function swapShim(newCliPath: string, shimBinDir: string = defaultShimBinDir()): void {
  const shimPath = path.join(shimBinDir, "tailii-host");
  const next = shimContent(process.execPath, newCliPath);
  const staging = shimPath + ".new";
  fs.writeFileSync(staging, next, { mode: 0o755 });
  try {
    fs.copyFileSync(shimPath, shimPath + ".prev");
    fs.chmodSync(shimPath + ".prev", 0o755);
  } catch {
    // 初回など .prev を作れなくても swap は続行する（保険が減るだけ）。
  }
  fs.renameSync(staging, shimPath);
}

/** シム内容から exec 先 cli パスを読む（GC の保護対象決定用）。 */
export function cliPathFromShim(content: string): string | null {
  const m = /^exec "[^"]+" "([^"]+)"/m.exec(content);
  return m === null ? null : m[1]!;
}

/** 設置済みホストに限り QUIC gateway を新版へ載せ替える（QUIC 未使用ホストでは何もしない）。 */
async function refreshQuicGateway(packageDir: string, io: SelfUpdateIO): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!fs.existsSync(quicLaunchAgentPlistPath())) return;
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  const prebuilt = path.join(packageDir, "node_modules", `@tailii/quic-gw-darwin-${arch}`, "bin", "tailii-quic-gw");
  if (!fs.existsSync(prebuilt)) {
    io.log("QUIC prebuilt が新版に無いため gateway は据え置き");
    return;
  }
  fs.chmodSync(prebuilt, 0o755);
  // installQuicGatewayBinary の「サイズ一致なら据え置き」最適化は npm tarball の
  // 正規化 mtime(過去日付)と噛み合い偽陰性になり得るため、更新時は必ずコピーする。
  await installQuicLaunchAgent({
    gatewayPath: prebuilt,
    installBinary: (source) => {
      const dest = path.join(os.homedir(), ".tailii", "bin", "tailii-quic-gw");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      fs.chmodSync(dest, 0o755);
      return dest;
    },
  });
  io.log("QUIC gateway を新版へ載せ替え");
}

/** 目標と .prev が指す版以外の管理ディレクトリを消す（管理外の設置には触れない）。 */
function gcOldVersions(target: string, shimBinDir: string = defaultShimBinDir()): void {
  let keepPrev: string | null = null;
  try {
    const prev = fs.readFileSync(path.join(shimBinDir, "tailii-host.prev"), "utf8");
    const cli = cliPathFromShim(prev);
    if (cli !== null && cli.startsWith(versionsDir() + path.sep)) {
      keepPrev = cli.slice((versionsDir() + path.sep).length).split(path.sep)[0] ?? null;
    }
  } catch {
    keepPrev = null;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(versionsDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === target || entry === keepPrev) continue;
    fs.rmSync(path.join(versionsDir(), entry), { recursive: true, force: true });
  }
}

/**
 * self-update の CLI エントリ。usage: tailii self-update <version> [--integrity <sri>]
 * 冪等: 既に目標版なら成功(0)。進行中なら成功(0)。検証失敗・環境不備は 1。
 */
export async function runSelfUpdateCommand(argv: string[]): Promise<number> {
  const positional: string[] = [];
  let integrity: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--integrity") {
      integrity = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]!);
    }
  }
  const target = positional[0];
  if (target === undefined || parseTriple(target) === null) {
    process.stderr.write("usage: tailii self-update <x.y.z> [--integrity <sha512-…>]\n");
    return 64;
  }
  const io: SelfUpdateIO = {
    log: (line) => process.stdout.write(`[self-update] ${line}\n`),
  };

  const current = readPackageVersion();
  if (current === target) {
    io.log(`既に ${target} です`);
    return 0;
  }
  const currentTriple = current !== null ? parseTriple(current) : null;
  // 拒否のみで記録しない: last-update.json は実際に走った更新の成否専用
  // （手動 CLI のダウングレード試行が channel_hello.updateError を汚さないように）。
  if (currentTriple !== null && compareTriple(parseTriple(target)!, currentTriple) < 0) {
    process.stderr.write(`[self-update] ダウングレードは行いません(現在 ${current} → 要求 ${target})\n`);
    return 1;
  }
  const installState = resolveInstallState();
  if (!installState.managed) {
    process.stderr.write(`[self-update] 自動更新の対象外です(${installState.reason})。手動で更新してください\n`);
    return 1;
  }
  if (!acquireLock(target)) {
    io.log("別の更新が進行中のため何もしません");
    return 0;
  }
  try {
    const packageDir = await installPackageTree(target, integrity, io);
    const newCliPath = path.join(packageDir, "dist", "cli.js");
    await smokeTest(newCliPath, target);
    swapShim(newCliPath);
    io.log(`シムを ${target} へ切替`);
    await refreshQuicGateway(packageDir, io);
    gcOldVersions(target);
    writeLastUpdate({ target, ok: true, tsMs: Date.now() });
    io.log(`完了: ${current ?? "?"} → ${target}(次回接続から新版)`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[self-update] 失敗: ${message}\n`);
    writeLastUpdate({ target, ok: false, error: message, tsMs: Date.now() });
    return 1;
  } finally {
    releaseLock();
  }
}

// MARK: - engine からの起動（RPC ハンドラ用）

/**
 * updater を現行 cli から detached で起動する（engine の生死と切り離す）。
 * ログは ~/.tailii/host/update.log へ追記。
 */
export function spawnDetachedSelfUpdate(version: string, integrity: string | undefined): void {
  fs.mkdirSync(selfUpdateRoot(), { recursive: true });
  const logFd = fs.openSync(updateLogPath(), "a");
  try {
    const args = [resolveOwnCliPath(), "self-update", version];
    if (integrity !== undefined) args.push("--integrity", integrity);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
}
