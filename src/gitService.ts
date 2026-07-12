// gitService.ts
// tailii (TS host) — cwd Git 状態・差分・履歴・更新サービス

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { GitBranchInfo, GitCommitInfo, GitStatusFile } from "./protocol.js";

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
    // Git の C-style quote は JSON にない \a / \v / 3桁8進 byte escape も使う。
    const inner = value.endsWith('"') ? value.slice(1, -1) : value.slice(1);
    const bytes: number[] = [];
    for (let index = 0; index < inner.length;) {
      if (inner[index] !== "\\") {
        const codePoint = inner.codePointAt(index)!;
        const literal = String.fromCodePoint(codePoint);
        bytes.push(...Buffer.from(literal));
        index += literal.length;
        continue;
      }
      const escaped = inner[index + 1];
      const simpleEscapes: Record<string, number> = {
        a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d,
        "\\": 0x5c, '"': 0x22,
      };
      const simpleEscape = escaped === undefined ? undefined : simpleEscapes[escaped];
      if (simpleEscape !== undefined) {
        bytes.push(simpleEscape);
        index += 2;
        continue;
      }
      const octal = inner.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal !== undefined) {
        bytes.push(Number.parseInt(octal, 8));
        index += 1 + octal.length;
        continue;
      }
      bytes.push(0x5c);
      index += 1;
    }
    return Buffer.from(bytes).toString("utf8");
  }
}

export async function gitStatus(repositoryPath: string): Promise<{
  isRepo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  repoRoot?: string;
  diffAdditions?: number;
  diffDeletions?: number;
}> {
  if (!(await isGitRepository(repositoryPath))) {
    return { isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
  }
  const result = await runGit(repositoryPath, ["status", "--porcelain=v2", "--branch", "-z"]);
  if (!result.ok) return { isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
  const repoRootResult = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const headDiffstat = await runGit(repositoryPath, ["diff", "--shortstat", "HEAD"]);
  const diffstat = headDiffstat.ok
    ? headDiffstat
    : await runGit(repositoryPath, ["diff", "--shortstat"]);
  const { additions: diffAdditions, deletions: diffDeletions } = parseDiffShortstat(diffstat.stdout);
  return {
    isRepo: true,
    ...parsePorcelainV2(result.stdout),
    repoRoot: repoRootResult.stdout.trim(),
    diffAdditions,
    diffDeletions,
  };
}

function parseDiffShortstat(output: string): { additions: number; deletions: number } {
  const additions = output.match(/(\d+) insertion(?:s)?\(\+\)/);
  const deletions = output.match(/(\d+) deletion(?:s)?\(-\)/);
  return {
    additions: additions ? Number.parseInt(additions[1]!, 10) : 0,
    deletions: deletions ? Number.parseInt(deletions[1]!, 10) : 0,
  };
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

export async function gitBranchList(
  repositoryPath: string,
): Promise<{ isRepo: boolean; branches: GitBranchInfo[] }> {
  if (!(await isGitRepository(repositoryPath))) return { isRepo: false, branches: [] };
  const result = await runGit(repositoryPath, [
    "for-each-ref",
    "refs/heads",
    "--sort=-committerdate",
    "--format=%(HEAD)%1f%(refname:short)%1f%(subject)%1f%(committerdate:unix)%1f%(upstream:track,nobracket)%1e",
  ]);
  if (!result.ok) return { isRepo: true, branches: [] };
  const branches = result.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\r?\n/, ""))
    .filter(Boolean)
    .flatMap((record): GitBranchInfo[] => {
      const fields = record.split("\x1f");
      if (fields.length !== 5) return [];
      const tracking = fields[4]!;
      const ahead = tracking.match(/(?:^|, )ahead (\d+)(?:,|$)/);
      const behind = tracking.match(/(?:^|, )behind (\d+)(?:,|$)/);
      return [{
        name: fields[1]!,
        subject: fields[2]!,
        dateMs: Number.parseInt(fields[3]!, 10) * 1_000,
        isCurrent: fields[0]!.trim() === "*",
        ahead: ahead ? Number.parseInt(ahead[1]!, 10) : 0,
        behind: behind ? Number.parseInt(behind[1]!, 10) : 0,
      }];
    });
  return { isRepo: true, branches };
}

export async function gitCheckout(
  repositoryPath: string,
  branch: string,
  create: boolean,
): Promise<{ ok: boolean; branch: string; error: string | null }> {
  const result = await runGit(repositoryPath, create ? ["checkout", "-b", branch] : ["checkout", branch]);
  return { ok: result.ok, branch, error: result.ok ? null : result.stderr };
}

export async function gitDiscard(
  repositoryPath: string,
  files: string[],
): Promise<{ ok: boolean; error: string | null }> {
  if (files.length === 0) return { ok: false, error: "files は1件以上必要です。" };
  const status = await gitStatus(repositoryPath);
  if (!status.isRepo) return { ok: false, error: "Git リポジトリではありません。" };

  const requested = files.map(normalizeGitPath);
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  for (const file of status.files) {
    const currentPath = normalizeGitPath(file.path);
    const previousPath = file.renamedFrom === null ? null : normalizeGitPath(file.renamedFrom);
    const selected = requested.some((candidate) =>
      currentPath === candidate || currentPath.startsWith(`${candidate}/`) ||
      previousPath === candidate || previousPath?.startsWith(`${candidate}/`) === true
    );
    if (!selected) continue;
    if (file.indexStatus === "?" && file.worktreeStatus === "?") {
      untracked.add(file.path);
    } else {
      tracked.add(file.path);
      if (file.renamedFrom !== null) tracked.add(file.renamedFrom);
    }
  }

  if (tracked.size > 0) {
    const restored = await runGit(repositoryPath, [
      "restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked,
    ]);
    if (!restored.ok) return { ok: false, error: restored.stderr };
  }
  if (untracked.size > 0) {
    const cleaned = await runGit(repositoryPath, ["clean", "-f", "-d", "--", ...untracked]);
    if (!cleaned.ok) return { ok: false, error: cleaned.stderr };
  }
  return { ok: true, error: null };
}

function normalizeGitPath(value: string): string {
  return path.normalize(value).replace(/\/+$/, "");
}

export async function gitInit(
  directoryPath: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (await isGitRepository(directoryPath)) {
    return { ok: false, error: "既に Git リポジトリです。" };
  }
  const result = await runGit(directoryPath, ["init", "-b", "main"]);
  return { ok: result.ok, error: result.ok ? null : result.stderr };
}

export async function gitEntryStatuses(
  directoryPath: string,
  names: string[],
): Promise<Map<string, string>> {
  const result = await runGit(directoryPath, [
    "-c", "core.quotePath=false", "status", "--porcelain=v2", "--untracked-files=all", "--", ".",
  ]);
  if (!result.ok) return new Map();

  const requestedNames = new Set(names);
  const statuses = new Map<string, string>();
  for (const file of parsePorcelainV2(result.stdout).files) {
    const [entryName, ...descendants] = file.path.split("/");
    if (entryName === undefined || !requestedNames.has(entryName)) continue;
    if (descendants.length > 0) {
      statuses.set(entryName, "M");
      continue;
    }
    const status = file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus;
    if (status !== ".") statuses.set(entryName, status);
  }
  return statuses;
}
