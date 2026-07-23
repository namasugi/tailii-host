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
/** title 取得の HTTP GET 全体タイムアウト。非 HTTP リスナーはここで切れる。 */
const TITLE_FETCH_TIMEOUT_MS = 1_200;
/** title 探索で読む HTML 先頭バイト数の上限。 */
const TITLE_BODY_LIMIT = 64 * 1024;
const TITLE_LIMIT = 80;

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
 * HTML 断片から `<title>` の中身を取り出す。空・見つからない場合は null。
 * 表示用に空白を畳み、基本的な文字参照を復号して TITLE_LIMIT で切り詰める。
 */
export function parseHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return null;
  const title = match[1]!
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) return null;
  // サロゲートペア（絵文字等）を割らないようコードポイント単位で切り詰める。
  const points = [...title];
  return points.length > TITLE_LIMIT ? `${points.slice(0, TITLE_LIMIT).join("")}…` : title;
}

/**
 * loopback の HTTP GET でページ title を 1 ポートぶん取得する。失敗は null。
 * `[::1]` のみで LISTEN するサーバーにも当たるよう IPv4/IPv6 両 loopback を並行試行する。
 */
async function probeTitle(port: number): Promise<string | null> {
  const results = await Promise.all([
    probeTitleAt(`http://127.0.0.1:${port}/`),
    probeTitleAt(`http://[::1]:${port}/`),
  ]);
  return results.find((title) => title !== null) ?? null;
}

async function probeTitleAt(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/html" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    // content-type 未設定の簡易サーバーは HTML の可能性を残して読む。
    if (contentType !== "" && !contentType.toLowerCase().includes("html")) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (response.body === null) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < TITLE_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/title>/i.test(html)) break;
    }
    await reader.cancel().catch(() => {});
    return parseHtmlTitle(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 各ポートの HTML title を並列取得する（全体は TITLE_FETCH_TIMEOUT_MS で頭打ち）。 */
async function fetchTitles(ports: number[]): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  await Promise.all(
    ports.map(async (port) => {
      const title = await probeTitle(port);
      if (title !== null) titles.set(port, title);
    }),
  );
  return titles;
}

/**
 * 自ユーザーが loopback/wildcard で LISTEN している TCP サーバーを列挙する。
 * `excludePids` は engine 自身など一覧に出さない pid。
 * `withTitles` で各ポートへ HTTP GET し HTML の `<title>` を付与する
 * （一覧表示用。停止前照合など内部利用では省く）。
 */
export async function listServeProcesses(
  options: { excludePids?: number[]; withTitles?: boolean } = {},
): Promise<ServeProcessInfo[]> {
  const excluded = new Set(options.excludePids ?? []);
  const listen = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  const entries = parseLsofListenOutput(listen.stdout)
    .filter((entry) => !excluded.has(entry.pid));

  const pids = [...new Set(entries.map((entry) => entry.pid))];
  const [cwds, commandLines] = await Promise.all([fetchCwds(pids), fetchCommandLines(pids)]);

  const servers: ServeProcessInfo[] = entries
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

  if (options.withTitles === true && servers.length > 0) {
    const titles = await fetchTitles([...new Set(servers.map((server) => server.port))]);
    for (const server of servers) {
      const title = titles.get(server.port);
      if (title !== undefined) server.title = title;
    }
  }
  return servers;
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
