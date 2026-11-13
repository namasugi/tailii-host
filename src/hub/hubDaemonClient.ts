// hubDaemonClient.ts — engine / hook 向けの軽い起動保証。hub 本体は読み込まない。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirectory0700 } from "../shared/paths.js";
import { readPackageVersion } from "../shared/version.js";
import { classifyHubProcess, classifyHubProcessAsync } from "./hubStartup.js";

export interface HubLock {
  pid: number;
  version: string | null;
}

export function defaultHubLockPath(): string {
  return path.join(os.homedir(), ".tailii", "hub.lock");
}

/** lockfile を読む。不在・壊れは null。 */
export function readHubLock(lockPath: string): HubLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      version?: unknown;
    };
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, version: typeof parsed.version === "string" ? parsed.version : null };
  } catch {
    return null;
  }
}

/** pid が生きているか。権限不足(EPERM)は生存扱い。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface EnsureHubDaemonOptions {
  /** `hub.lock` の pid の実体（テスト注入用。既定はコマンドラインで確かめる）。 */
  classifyProcess?: (pid: number) => "hub" | "other" | "gone" | "unknown";
  lockPath?: string;
  cliPath?: string;
  logPath?: string;
  spawnImpl?: typeof spawn;
}

/** hook 向け。既存の同期の起動保証と版違いの入れ替えを保つ。 */
export function ensureHubDaemon(options: EnsureHubDaemonOptions = {}): void {
  try {
    const currentVersion = readPackageVersion();
    const lock = readHubLock(options.lockPath ?? defaultHubLockPath());
    const identity = lock !== null && pidAlive(lock.pid)
      ? (options.classifyProcess ?? classifyHubProcess)(lock.pid) : "gone";
    finishEnsure(options, lock, identity, currentVersion);
  } catch { /* 次の engine 接続 / hook 発火で再試行する。 */ }
}

export interface EnsureHubDaemonAsyncOptions extends Omit<EnsureHubDaemonOptions, "classifyProcess"> {
  classifyProcess?: (pid: number) => ReturnType<typeof classifyHubProcess> | Promise<ReturnType<typeof classifyHubProcess>>;
}

/** engine 向け。ps を待つ間も hello / 要求の読み取りを止めない。 */
export async function ensureHubDaemonAsync(options: EnsureHubDaemonAsyncOptions = {}): Promise<void> {
  try {
    const currentVersion = readPackageVersion();
    const lock = readHubLock(options.lockPath ?? defaultHubLockPath());
    const identity = lock !== null && pidAlive(lock.pid)
      ? await (options.classifyProcess ?? classifyHubProcessAsync)(lock.pid) : "gone";
    const { classifyProcess: _classify, ...spawnOptions } = options;
    finishEnsure(spawnOptions, lock, identity, currentVersion);
  } catch { /* 次の engine 接続 / hook 発火で再試行する。 */ }
}

/** 確認済みの lock が変わっていなければ版を照合し、必要な hub を起こす。 */
function finishEnsure(
  options: EnsureHubDaemonOptions,
  lock: HubLock | null,
  identity: ReturnType<typeof classifyHubProcess>,
  currentVersion: string | null,
): void {
  let logFd: number | null = null;
  try {
    const current = readHubLock(options.lockPath ?? defaultHubLockPath());
    // 非同期の実体確認中に所有者が変わったら、古い確認結果で終了を要求しない。
    if (lock !== null && current?.pid === lock.pid && current.version === lock.version &&
        pidAlive(lock.pid) && identity === "hub") {
      if (lock.version === currentVersion) return;
      try { process.kill(lock.pid, "SIGTERM"); } catch { /* 消えていれば起動へ進む。 */ }
    }
    const cliPath = options.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
    const logPath = options.logPath ?? path.join(os.homedir(), ".tailii", "hub.log");
    ensureDirectory0700(path.dirname(logPath));
    logFd = fs.openSync(logPath, "a");
    // tmux 内の hook から ensure されると TMUX / TMUX_PANE を引き継ぐ。hub が起こす herdr server 経由で
    // herdr 内の Claude がこの tmux pane 名を状態ファイルの `tmux` 欄に書き、reaper が取り違えるので外す。
    const { TMUX: _tmux, TMUX_PANE: _pane, TAILII_HUB_VIA_GATEWAY: _viaGateway, ...withoutTmux } = process.env;
    const child = (options.spawnImpl ?? spawn)(process.execPath, [cliPath, "hub"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: withoutTmux,
    });
    child.unref();
  } catch {
    // 次の engine 接続 / hook 発火で再試行する。
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
}

