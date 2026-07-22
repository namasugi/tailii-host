// serveService.ts
// tailii (TS host) — Mac 上で LISTEN 中の開発サーバー一覧と停止（serve-list）
//
// iOS の「Webサーバー」一覧は、この Mac で自ユーザーが LISTEN している TCP ポートを
// lsof で列挙して表示する。dev サーバー（vite / next / python -m http.server 等）は
// プロジェクト dir を cwd に持つため、cwd を返して iOS 側で会話 workdir との
// グルーピングに使う。ノイズ削減のため以下は host 側で除外する:
//   - engine 自身（previewServer の loopback 静的サーバーを含む）
//   - cwd が "/" のプロセス（launchd 起動の常駐アプリ・デーモン類。dev サーバーは
//     必ず実プロジェクトの cwd を持つ）
//   - loopback/wildcard 以外へ bind しているソケット（LAN 固定 bind は対象外）
//
// 停止は pid 再利用による誤 kill を防ぐため「その pid が今もそのポートで LISTEN
// している」ことを確認してから SIGTERM → 猶予後 SIGKILL の順で行う。

import { execFile } from "node:child_process";
import type { ServeProcessInfo } from "./protocol.js";

const LSOF_TIMEOUT_MS = 8_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
/** SIGTERM 後にプロセス終了を待つ最大時間。 */
const TERM_GRACE_MS = 1_500;
/** SIGKILL 後にプロセス終了を待つ最大時間。 */
const KILL_GRACE_MS = 700;
const POLL_INTERVAL_MS = 100;
const COMMAND_LINE_LIMIT = 160;

interface ExecResult {
  ok: boolean;
  stdout: string;
}

function run(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, encoding: "utf8" },
      (error, stdout) => {
        // lsof は「該当なし」でも exit 1 を返すため、stdout があれば成功扱いにする。
        resolve({ ok: error === null || String(stdout).length > 0, stdout: String(stdout) });
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `*:5173` / `127.0.0.1:5173` / `[::1]:5173` からポート番号を取り出す。 */
export function parseListenPort(name: string): number | null {
  const colon = name.lastIndexOf(":");
  if (colon < 0) return null;
  const port = Number(name.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = name.slice(0, colon);
  // loopback / wildcard のみ対象（明示的な LAN bind は開発サーバー一覧の対象外）。
  const allowed = new Set(["*", "127.0.0.1", "localhost", "[::1]", "[::]", "0.0.0.0"]);
  return allowed.has(host) ? port : null;
}

/**
 * `lsof -Fpcn` の機械可読出力を (pid, port) の組へパースする。
 * 出力はプロセスブロック（p/c 行）に n 行（bind 先）が続く形。
 */
export function parseLsofListenOutput(
  output: string,
): { pid: number; command: string; port: number }[] {
  const results: { pid: number; command: string; port: number }[] = [];
  const seen = new Set<string>();
  let pid: number | null = null;
  let command = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      command = "";
      continue;
    }
    if (line.startsWith("c")) {
      command = line.slice(1);
      continue;
    }
    if (line.startsWith("n") && pid !== null) {
      const port = parseListenPort(line.slice(1));
      if (port === null) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ pid, command, port });
    }
  }
  return results;
}

/** `lsof -a -d cwd -Fpn -p <pids>` の出力を pid → cwd へパースする。 */
export function parseLsofCwdOutput(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith("n") && pid !== null) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

async function fetchCwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const result = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]);
  return parseLsofCwdOutput(result.stdout);
}

async function fetchCommandLines(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const result = await run("ps", ["-o", "pid=,command=", "-p", pids.join(",")]);
  const lines = new Map<number, string>();
  for (const row of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row);
    if (match === null) continue;
    const commandLine = match[2]!.trim();
    lines.set(
      Number(match[1]),
      commandLine.length > COMMAND_LINE_LIMIT
        ? `${commandLine.slice(0, COMMAND_LINE_LIMIT)}…`
        : commandLine,
    );
  }
  return lines;
}

/**
 * 自ユーザーが loopback/wildcard で LISTEN している TCP サーバーを列挙する。
 * `excludePids` は engine 自身など一覧に出さない pid。
 */
export async function listServeProcesses(
  options: { excludePids?: number[] } = {},
): Promise<ServeProcessInfo[]> {
  const excluded = new Set(options.excludePids ?? []);
  const listen = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  const entries = parseLsofListenOutput(listen.stdout)
    .filter((entry) => !excluded.has(entry.pid));

  const pids = [...new Set(entries.map((entry) => entry.pid))];
  const [cwds, commandLines] = await Promise.all([fetchCwds(pids), fetchCommandLines(pids)]);

  return entries
    .map((entry) => {
      const cwd = cwds.get(entry.pid);
      return {
        pid: entry.pid,
        port: entry.port,
        command: entry.command,
        ...(commandLines.has(entry.pid) ? { commandLine: commandLines.get(entry.pid)! } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      };
    })
    // cwd "/" は launchd 起動アプリ・デーモン（dev サーバーは実 cwd を持つ）。
    // cwd 不明（取得失敗）は残す — 情報不足を理由に隠さない。
    .filter((entry) => entry.cwd !== "/")
    .sort((lhs, rhs) => lhs.port - rhs.port);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}

/**
 * pid のサーバーを停止する。pid 再利用の誤爆を防ぐため、その pid が今も
 * 指定 port で LISTEN していることを確認してから SIGTERM → SIGKILL する。
 */
export async function stopServeProcess(
  pid: number,
  port: number,
): Promise<{ ok: boolean; error: string | null }> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, error: `不正な pid: ${pid}` };
  }
  if (pid === process.pid) {
    return { ok: false, error: "host 自身は停止できません" };
  }
  const current = await listServeProcesses();
  const target = current.find((entry) => entry.pid === pid && entry.port === port);
  if (target === undefined) {
    return { ok: false, error: "対象のサーバーが見つかりません（すでに停止済み？）" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { ok: false, error: `停止に失敗しました: ${String(error)}` };
  }
  if (await waitForExit(pid, TERM_GRACE_MS)) return { ok: true, error: null };
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // SIGTERM 後に自然終了したレース。生存確認へ進む。
  }
  if (await waitForExit(pid, KILL_GRACE_MS)) return { ok: true, error: null };
  return { ok: false, error: "プロセスが終了しませんでした" };
}
