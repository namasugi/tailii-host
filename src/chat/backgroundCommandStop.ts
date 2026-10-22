// backgroundCommandStop.ts
// iPhone のバックグラウンドタスク一覧から、背景コマンド（Claude Code の Bash の背景実行）を止める。
//
// 背景コマンドは CLI が起動した `/bin/zsh -c …` を先頭とするプロセスグループで動き、先頭（と子）が
// 出力ファイル（`…/tasks/<taskId>.output`）を書き込み用に開いている（実測: fd 1/2 が `w`）。そこで
// 「出力ファイルを書き込み用に開いているプロセス」を探し、その先頭が書き込み元であるグループごと
// SIGTERM → 猶予 → SIGKILL する。出力ファイルを読んでいるだけのプロセス（`tail -f` 等）は対象外。
// グループの先頭が書き込み元でない場合（CLI がグループを分けずに起動した等）はグループを止めずに
// 書き込み元のプロセスだけを止める — claude 本体と同じグループを丸ごと止める事故を避けるため。
//
// 終わったかどうかは「送った対象（グループ / プロセス）がもう存在しないか」で確かめる。書き込み元が
// いなくなっただけでは、出力を別のファイルへ向けた孫（SIGTERM を無視して残る等）を見落とす。
// グループの誰かが生きている間はその pgid は再利用されないので、残りへの SIGKILL も安全。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import type { BackgroundCommandStopStatus } from "../protocol.js";

export interface BackgroundCommandStopResult {
  status: BackgroundCommandStopStatus;
  error?: string;
}

interface Writer {
  pid: number;
  pgid: number;
}

/** テスト用の差し替え口。 */
export interface BackgroundCommandStopDeps {
  /** 出力ファイルがあるか（消されていたら書き込み元を探せない）。 */
  fileExists(filePath: string): boolean;
  /** filePath を書き込み用に開いているプロセス。null = 調べられない。 */
  listWriters(filePath: string): Promise<Writer[] | null>;
  /** process.kill と同じ（負の pid はプロセスグループ）。 */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** 対象（負の数 = グループ）がまだ存在するか。 */
  exists(target: number): boolean;
  sleep(ms: number): Promise<void>;
  /** 自分（host）のプロセス／グループ。止めない。 */
  selfPid: number;
  selfPgid(): Promise<number | null>;
}

export interface BackgroundCommandStopHooks {
  /** 最初の SIGTERM を送る直前（CLI の完了通知より先に「利用者が止めた」記録を入れるため）。 */
  onSignal?(atMs: number): void;
}

const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const POLL_MS = 100;

export async function stopBackgroundCommandProcess(
  outputPath: string | null,
  hooks: BackgroundCommandStopHooks = {},
  deps: BackgroundCommandStopDeps = defaultDeps(),
): Promise<BackgroundCommandStopResult> {
  if (outputPath === null || !deps.fileExists(outputPath)) return { status: "not_found" };
  const writers = await deps.listWriters(outputPath);
  if (writers === null) return { status: "failed", error: "実行中のプロセスを調べられませんでした。" };
  const targets = stopTargets(writers, deps.selfPid, await deps.selfPgid());
  if (targets.length === 0) return { status: "not_running" };

  hooks.onSignal?.(Date.now());
  signalAll(targets, "SIGTERM", deps);
  if (await waitUntilGone(targets, TERM_GRACE_MS, deps)) return { status: "stopped" };
  const remaining = targets.filter((target) => deps.exists(target));
  signalAll(remaining, "SIGKILL", deps);
  if (await waitUntilGone(remaining, KILL_GRACE_MS, deps)) return { status: "stopped" };
  return { status: "failed", error: "プロセスが終了しませんでした。" };
}

/** 止める対象（負の数 = プロセスグループ）。host 自身とそのグループ、pid 1 以下は含めない。 */
function stopTargets(writers: Writer[], selfPid: number, selfPgid: number | null): number[] {
  const writerPids = new Set(writers.map((writer) => writer.pid));
  const targets = new Set<number>();
  for (const writer of writers) {
    if (writer.pid <= 1 || writer.pid === selfPid) continue;
    const groupLedByWriter = writer.pgid > 1 && writerPids.has(writer.pgid)
      && writer.pgid !== selfPgid && writer.pgid !== selfPid;
    targets.add(groupLedByWriter ? -writer.pgid : writer.pid);
  }
  return [...targets];
}

function signalAll(targets: number[], signal: NodeJS.Signals, deps: BackgroundCommandStopDeps): void {
  for (const target of targets) {
    try {
      deps.kill(target, signal);
    } catch {
      // 既に終わっている（ESRCH）等。生存確認は exists で行う。
    }
  }
}

async function waitUntilGone(targets: number[], graceMs: number, deps: BackgroundCommandStopDeps): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (targets.every((target) => !deps.exists(target))) return true;
    if (Date.now() >= deadline) return false;
    await deps.sleep(POLL_MS);
  }
}

let cachedSelfPgid: Promise<number | null> | null = null;

function defaultDeps(): BackgroundCommandStopDeps {
  return {
    fileExists: (filePath) => fs.existsSync(filePath),
    listWriters: async (filePath) => {
      const writers = await listWritersViaLsof(filePath);
      return writers !== undefined ? writers : listWritersViaProc(filePath);
    },
    kill: (pid, signal) => process.kill(pid, signal),
    exists: processExists,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    selfPid: process.pid,
    selfPgid: () => {
      cachedSelfPgid ??= withPgids([process.pid]).then((rows) => rows?.[0]?.pgid ?? null);
      return cachedSelfPgid;
    },
  };
}

/** signal 0 で存在を確かめる。EPERM（存在するが送れない）は存在扱い。 */
function processExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function run(cmd: string, args: string[]): Promise<{ code: unknown; stdout: string } | null> {
  return new Promise((resolve) => {
    // lsof は遅いマウント等で待たされることがある。hub RPC（20 秒）に収まるよう短めに切る。
    execFile(cmd, args, { timeout: 5_000 }, (error, stdout) => {
      if (error !== null && (error as { code?: unknown }).code === "ENOENT") {
        resolve(null);
        return;
      }
      resolve({ code: error === null ? 0 : (error as { code?: unknown }).code, stdout: stdout ?? "" });
    });
  });
}

/** `lsof -F pa` で書き込み用（a=w/u）の保持者を数える。lsof が無ければ undefined。 */
async function listWritersViaLsof(filePath: string): Promise<Writer[] | null | undefined> {
  const result = await run("lsof", ["-F", "pa", "--", filePath]);
  if (result === null) return undefined;
  // exit 1 = 保持者なし（ファイルの有無は呼び出し側で確かめ済み）。それ以外の失敗は調べられない。
  if (result.code !== 0) return result.code === 1 && result.stdout.trim() === "" ? [] : null;
  return withPgids(parseLsofWriters(result.stdout));
}

/** `lsof -F pa` の出力から、書き込み用に開いている pid を取り出す。 */
export function parseLsofWriters(stdout: string): number[] {
  const out = new Set<number>();
  let current: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) && pid > 0 ? pid : null;
    } else if (line.startsWith("a") && current !== null) {
      const access = line.slice(1);
      if (access === "w" || access === "u") out.add(current);
    }
  }
  return [...out];
}

async function withPgids(pids: number[]): Promise<Writer[] | null> {
  if (pids.length === 0) return [];
  const result = await run("ps", ["-o", "pid=,pgid=", "-p", pids.join(",")]);
  if (result === null) return null;
  // ps は対象が消えていると exit 1。読めた行だけ使う（消えたものは止める必要がない）。
  return parsePsPgids(result.stdout);
}

/** `ps -o pid=,pgid=` の出力を読む。 */
export function parsePsPgids(stdout: string): Writer[] {
  const out: Writer[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    out.push({ pid: Number(match[1]), pgid: Number(match[2]) });
  }
  return out;
}

/** lsof が無い Linux 向け。/proc/<pid>/fd と fdinfo の flags（O_WRONLY/O_RDWR）で数える。 */
function listWritersViaProc(filePath: string): Writer[] | null {
  let target: string;
  try {
    target = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const out: Writer[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    let writes = false;
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${entry}/fd/${fd}`) !== target) continue;
        const flags = /^flags:\s*([0-7]+)/m.exec(fs.readFileSync(`/proc/${entry}/fdinfo/${fd}`, "utf8"));
        if (flags !== null && (parseInt(flags[1]!, 8) & 3) !== 0) writes = true;
      } catch {
        // 走査中に消えた fd は無視。
      }
      if (writes) break;
    }
    if (!writes) continue;
    try {
      // /proc/<pid>/stat の 5 番目が pgrp（comm は括弧つきで空白を含みうるので閉じ括弧の後から数える）。
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(entry), pgid: Number(fields[2]) });
    } catch {
      // 消えたプロセスは止める必要がない。
    }
  }
  return out;
}
