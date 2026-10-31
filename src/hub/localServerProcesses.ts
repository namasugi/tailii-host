// ローカルサーバーの LISTEN と親子関係を、同じ reaper tick 内で共有する。
import { execFile } from "node:child_process";
import * as path from "node:path";
import type { ServeProcessInfo } from "../protocol.js";

export interface LocalServerProcesses {
  servers: readonly Pick<ServeProcessInfo, "pid" | "cwd" | "command">[];
  /** null は ps の失敗。空の親子関係とは区別する。 */
  parents: ReadonlyMap<number, number> | null;
  /** 制御端末。同じ pane に残った孤児プロセスも、端末終了時の SIGHUP の対象になる。 */
  terminals?: ReadonlyMap<number, string>;
}

export function parseProcessTable(stdout: string): {
  parents: ReadonlyMap<number, number>; terminals: ReadonlyMap<number, string>;
} | null {
  const parents = new Map<number, number>();
  const terminals = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null || Number(match[1]) <= 0) return null;
    parents.set(Number(match[1]), Number(match[2]));
    terminals.set(Number(match[1]), match[3]!);
  }
  return parents.size > 0 ? { parents, terminals } : null;
}

type InventoryCommandRunner = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const runInventoryCommand: InventoryCommandRunner = (command, args) => {
  return new Promise((resolve) => {
    execFile(command, args,
      { timeout: 8_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const typed = error as (Error & { code?: number | string; killed?: boolean; signal?: string | null }) | null;
        const empty = command === "lsof" && typed?.code === 1 && stdout.length === 0 &&
          stderr.length === 0 && typed.killed !== true && typed.signal == null;
        resolve({ ok: error === null || empty, stdout });
      });
  });
};

export async function listLocalServerProcesses(
  excludePids: number[], run: InventoryCommandRunner = runInventoryCommand,
): Promise<LocalServerProcesses | null> {
  // Web サーバー一覧の cwd / bind 先フィルターは使わない。端末を閉じれば巻き添えになる
  // TCP リスナーは、作業場所や公開アドレスによらず起動元の pane を保護する。
  const listen = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpc"]);
  if (!listen.ok) return null;
  const byPid = new Map<number, { pid: number; command: string }>();
  let current: { pid: number; command: string } | undefined;
  for (const line of listen.stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      current = { pid, command: "" };
      byPid.set(pid, current);
    } else if (line.startsWith("c")) {
      if (current === undefined) return null;
      current.command = line.slice(1);
    } else if (line !== "" && !line.startsWith("f")) {
      return null;
    }
  }
  // LISTEN 検出より後に読む。先に ps を読むと、間に起動したサーバーの親が見つからない。
  const processes = await run("ps", ["-axo", "pid=,ppid=,tty="]);
  const table = processes.ok ? parseProcessTable(processes.stdout) : null;
  return {
    servers: [...byPid.values()].filter((server) => !excludePids.includes(server.pid)),
    parents: table?.parents ?? null,
    terminals: table?.terminals,
  };
}

/** CLI 自身の制御用 LISTEN は開発サーバーとして会話を延命しない。 */
export function isAgentListener(command: string): boolean {
  return ["codex", "claude", "tailii", "tailii-host"].includes(path.basename(command).toLowerCase());
}

/** pane の子孫または同じ制御端末か。途中欠落・循環は null（判定不能）。 */
export function processBelongsToPane(
  pid: number, roots: readonly number[], parents: ReadonlyMap<number, number>,
  terminals?: ReadonlyMap<number, string>,
): boolean | null {
  const terminal = terminals?.get(pid);
  if (terminal !== undefined && !/^(?:\?+|-)$/.test(terminal) &&
    roots.some((root) => terminals?.get(root) === terminal)) return true;
  const visited = new Set<number>();
  while (pid > 0) {
    if (roots.includes(pid)) return true;
    if (pid === 1) return false;
    if (visited.has(pid)) return null;
    visited.add(pid);
    const parent = parents.get(pid);
    if (parent === undefined) return null;
    pid = parent;
  }
  return false;
}
