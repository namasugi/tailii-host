// gitService.ts
// tailii (TS host) — cwd Git 状態・差分・履歴・更新サービス

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { GitCommitInfo, GitStatusFile } from "./protocol.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const DIFF_CHARACTER_LIMIT = 200_000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function validRepositoryPath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !candidate.startsWith("~");
}

function runGit(repositoryPath: string, args: string[]): Promise<GitRunResult> {
  if (!validRepositoryPath(repositoryPath)) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "絶対パスを指定してください。" });
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repositoryPath, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout),
          stderr: String(stderr).trim() || (error === null ? "" : error.message),
        });
      },
    );
  });
}

async function isGitRepository(repositoryPath: string): Promise<boolean> {
  const result = await runGit(repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

export interface ParsedPorcelainV2 {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}

/** `git status --porcelain=v2 --branch` を wire 応答用に解析する。 */
export function parsePorcelainV2(output: string): ParsedPorcelainV2 {
  let branch = "";
  let oid = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  const records = output.includes("\0") ? output.split("\0") : output.split(/\r?\n/);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) oid = record.slice(13).trim();
    else if (record.startsWith("# branch.head ")) branch = record.slice(14).trim();
    else if (record.startsWith("# branch.upstream ")) upstream = record.slice(18).trim();
    else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number.parseInt(match[1]!, 10);
        behind = Number.parseInt(match[2]!, 10);
      }
    } else if (record.startsWith("1 ")) {
      const match = record.match(/^1 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) {
        const xy = match[1]!;
        files.push({
          path: decodeGitPath(match[2]!),
          indexStatus: xy[0] ?? ".",
          worktreeStatus: xy[1] ?? ".",
          renamedFrom: null,
        });
      }
    } else if (record.startsWith("2 ")) {
      const match = record.match(/^2 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) {
        const xy = match[1]!;
        let currentPath = match[2]!;
        let renamedFrom: string | null = null;
        if (output.includes("\0")) {
          renamedFrom = records[++index] ?? null;
        } else {
          const tab = currentPath.indexOf("\t");
          if (tab >= 0) {
            renamedFrom = decodeGitPath(currentPath.slice(tab + 1));
            currentPath = currentPath.slice(0, tab);
          }
        }
        files.push({
          path: decodeGitPath(currentPath),
          indexStatus: xy[0] ?? ".",
          worktreeStatus: xy[1] ?? ".",
          renamedFrom,
        });
      }
    } else if (record.startsWith("? ")) {
      files.push({
        path: decodeGitPath(record.slice(2)),
        indexStatus: "?",
        worktreeStatus: "?",
        renamedFrom: null,
      });
    }
  }

  if (branch === "(detached)") {
    const shortOid = oid && oid !== "(initial)" ? oid.slice(0, 7) : "unknown";
    branch = `(detached ${shortOid})`;
  }
  return { branch, upstream, ahead, behind, files };
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

export async function gitStatus(repositoryPath: string): Promise<{
  isRepo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}> {
  if (!(await isGitRepository(repositoryPath))) {
    return { isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
  }
  const result = await runGit(repositoryPath, ["status", "--porcelain=v2", "--branch", "-z"]);
  if (!result.ok) return { isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
  return { isRepo: true, ...parsePorcelainV2(result.stdout) };
}

export async function gitDiff(
  repositoryPath: string,
  options: { file?: string; staged?: boolean; commit?: string | null } = {},
): Promise<{ isRepo: boolean; diff: string; truncated: boolean }> {
  if (!(await isGitRepository(repositoryPath))) return { isRepo: false, diff: "", truncated: false };
  const args = options.commit
    ? ["show", options.commit]
    : ["diff", ...(options.staged ? ["--cached"] : []), ...(options.file ? ["--", options.file] : [])];
  const result = await runGit(repositoryPath, args);
  if (!result.ok && result.stdout.length === 0) return { isRepo: true, diff: "", truncated: false };
  return {
    isRepo: true,
    diff: result.stdout.slice(0, DIFF_CHARACTER_LIMIT),
    truncated: !result.ok || result.stdout.length > DIFF_CHARACTER_LIMIT,
  };
}

export async function gitLog(
  repositoryPath: string,
  limit = DEFAULT_LOG_LIMIT,
): Promise<{ isRepo: boolean; commits: GitCommitInfo[] }> {
  if (!(await isGitRepository(repositoryPath))) return { isRepo: false, commits: [] };
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, MAX_LOG_LIMIT)) : DEFAULT_LOG_LIMIT;
  const result = await runGit(repositoryPath, [
    "log",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e",
    "-n",
    String(safeLimit),
  ]);
  if (!result.ok) return { isRepo: true, commits: [] };
  const commits = result.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\r?\n/, ""))
    .filter(Boolean)
    .flatMap((record): GitCommitInfo[] => {
      const fields = record.split("\x1f");
      if (fields.length !== 5) return [];
      return [{
        hash: fields[0]!,
        shortHash: fields[1]!,
        authorName: fields[2]!,
        dateMs: Number.parseInt(fields[3]!, 10) * 1_000,
        subject: fields[4]!,
      }];
    });
  return { isRepo: true, commits };
}

export async function gitStage(
  repositoryPath: string,
  files: string[],
  unstage = false,
): Promise<{ ok: boolean; error: string | null }> {
  if (files.length === 0) return { ok: false, error: "files は1件以上必要です。" };
  if (!(await isGitRepository(repositoryPath))) return { ok: false, error: "Git リポジトリではありません。" };
  const result = await runGit(
    repositoryPath,
    unstage ? ["restore", "--staged", "--", ...files] : ["add", "--", ...files],
  );
  return { ok: result.ok, error: result.ok ? null : result.stderr };
}

export async function gitCommit(
  repositoryPath: string,
  message: string,
): Promise<{ ok: boolean; hash: string | null; error: string | null }> {
  if (!(await isGitRepository(repositoryPath))) {
    return { ok: false, hash: null, error: "Git リポジトリではありません。" };
  }
  if (message.trim().length === 0) return { ok: false, hash: null, error: "コミットメッセージが空です。" };
  const committed = await runGit(repositoryPath, ["commit", "-m", message]);
  if (!committed.ok) return { ok: false, hash: null, error: committed.stderr };
  const hash = await runGit(repositoryPath, ["rev-parse", "--short", "HEAD"]);
  if (!hash.ok) return { ok: false, hash: null, error: hash.stderr };
  return { ok: true, hash: hash.stdout.trim(), error: null };
}
