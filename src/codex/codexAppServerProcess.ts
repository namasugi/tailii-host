// codexAppServerProcess.ts
// 共有 Codex App Server daemon を入れ替えるための OS プロセス操作（socket を開いている pid の特定・
// コマンドラインの読み取り・シグナル送信）。入れ替えるかどうかの判定は codexAppServer.ts 側に置き、
// ここには OS 依存の部分だけを置く。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** daemon の入れ替えで使うプロセス操作（テストで差し替える）。 */
export interface CodexAppServerProcessControl {
  /** socket を開いているプロセスの pid。調べられなければ null。 */
  findSocketPids(socketPath: string): Promise<number[] | null>;
  /** pid のコマンドライン。取れなければ null。 */
  readCommand(pid: number): Promise<string | null>;
  /** シグナルを送る。送れなければ（既に居ない等）false。 */
  signal(pid: number, signal: NodeJS.Signals): boolean;
  isAlive(pid: number): boolean;
}

export const defaultCodexAppServerProcessControl: CodexAppServerProcessControl = {
  findSocketPids: findSocketPidsDefault,
  readCommand: readCommandDefault,
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

/**
 * lsof や /proc/net/unix に socket の名前として現れうるパス。0.158+ の socketPath は
 * `/tmp/codex-daemon-<uid>/<hash>` の実体への symlink で、一覧には実体の名前が出る
 * （macOS は `/tmp` が `/private/tmp` への symlink なので両方の綴りを含める）。
 */
export function socketPathCandidates(socketPath: string): string[] {
  const names = new Set<string>([socketPath]);
  try {
    names.add(path.resolve(path.dirname(socketPath), fs.readlinkSync(socketPath)));
  } catch {
    // symlink でなければ socketPath そのものが名前。
  }
  try {
    names.add(fs.realpathSync(socketPath));
  } catch {
    // 実体が無い（daemon 停止後の残骸）なら候補を増やさない。
  }
  return [...names];
}

/** `lsof -F pn` の出力から、名前が候補のどれかに一致するファイルを開いている pid を集める。 */
export function parseLsofSocketPids(output: string, candidates: readonly string[]): number[] {
  const pids = new Set<number>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isSafeInteger(value) && value > 0 ? value : null;
      continue;
    }
    if (pid === null || !line.startsWith("n")) continue;
    const name = line.slice(1);
    // Linux の lsof は unix socket の名前の後ろへ ` type=STREAM` 等を付ける版がある。
    if (candidates.some((candidate) => name === candidate || name.startsWith(`${candidate} `))) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/** `/proc/net/unix` から、パスが候補のどれかに一致する socket の inode を集める（Linux）。 */
export function parseProcNetUnixInodes(content: string, candidates: readonly string[]): string[] {
  const inodes = new Set<string>();
  // 1 行目は見出し。各行は `Num RefCount Protocol Flags Type St Inode Path`（Path は無いこともある）。
  for (const line of content.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const inode = fields[6];
    const socketName = fields.slice(7).join(" ");
    if (inode !== undefined && /^\d+$/.test(inode) && candidates.includes(socketName)) {
      inodes.add(inode);
    }
  }
  return [...inodes];
}

async function findSocketPidsDefault(socketPath: string): Promise<number[] | null> {
  const candidates = socketPathCandidates(socketPath);
  const lsofOutput = await runLsofUnixSockets();
  if (lsofOutput !== undefined) {
    return lsofOutput === null ? null : parseLsofSocketPids(lsofOutput, candidates);
  }
  return findSocketPidsViaProc(candidates);
}

/** 全 unix socket の `lsof -F pn` 出力。lsof が無ければ undefined、失敗・時間切れは null。 */
function runLsofUnixSockets(): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", "-U", "-F", "pn"],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const output = String(stdout ?? "");
        if (error === null) {
          resolve(output);
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ENOENT") {
          resolve(undefined);
          return;
        }
        // 一部プロセスを読めないだけでも exit 1 になる。時間切れの途中出力は信用しない。
        resolve(failure.killed !== true && output.length > 0 ? output : null);
      },
    );
  });
}

/** lsof が無い Linux 向け。/proc/net/unix の inode を /proc/<pid>/fd の `socket:[inode]` と照合する。 */
function findSocketPidsViaProc(candidates: readonly string[]): number[] | null {
  let content: string;
  try {
    content = fs.readFileSync("/proc/net/unix", "utf8");
  } catch {
    return null;
  }
  const targets = new Set(parseProcNetUnixInodes(content, candidates).map((inode) => `socket:[${inode}]`));
  if (targets.size === 0) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    const holds = fds.some((fd) => {
      try {
        return targets.has(fs.readlinkSync(`/proc/${entry}/fd/${fd}`));
      } catch {
        return false;
      }
    });
    if (holds) pids.push(Number(entry));
  }
  return pids;
}

function readCommandDefault(pid: number): Promise<string | null> {
  // Linux は /proc の argv（NUL 区切り）を読む。/proc が無い macOS は ps に聞く。
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((part) => part.length > 0);
    if (argv.length > 0) return Promise.resolve(argv.join(" "));
  } catch {
    // ps へ。
  }
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const command = error === null ? String(stdout).trim() : "";
      resolve(command.length > 0 ? command : null);
    });
  });
}
