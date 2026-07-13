// gitService.ts
// tailii (TS host) — cwd Git 状態・差分・履歴・更新サービス

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GitBranchInfo, GitCommitInfo, GitStatusFile } from "./protocol.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const DIFF_CHARACTER_LIMIT = 200_000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const MAX_WORKTREE_INCLUDE_FILES = 500;
const WORKTREE_EXCLUDE_LINE = ".claude/worktrees/";
const WORKTREE_LOCK_REASON = "tailii-session";

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

function formatWorktreeTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function resolveGitPath(repositoryPath: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repositoryPath, value);
}

async function appendWorktreeExclude(repositoryPath: string): Promise<string | null> {
  const commonDir = await runGit(repositoryPath, ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok) return commonDir.stderr;
  try {
    const excludePath = path.join(resolveGitPath(repositoryPath, commonDir.stdout.trim()), "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === WORKTREE_EXCLUDE_LINE)) return null;
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${separator}${WORKTREE_EXCLUDE_LINE}\n`);
    return null;
  } catch (error) {
    return String(error);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function gitServiceDiag(message: string): void {
  if (process.env["TAILII_DEBUG"] === "1") process.stderr.write(`[tailii-host git] ${message}\n`);
}

function parseNulSeparatedPaths(output: string): string[] {
  if (output.length === 0) return [];
  const records = output.split("\0");
  if (records[records.length - 1] === "") records.pop();
  return records.filter((record) => record.length > 0);
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function worktreeDestination(worktreePath: string, relativePath: string): string | null {
  const destination = path.resolve(worktreePath, relativePath);
  if (!isPathInside(worktreePath, destination)) return null;

  let current = worktreePath;
  const parentRelative = path.relative(worktreePath, path.dirname(destination));
  for (const component of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (pathEntryExists(current)) {
      const status = fs.lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) return null;
    } else {
      fs.mkdirSync(current);
    }
  }
  return pathEntryExists(destination) ? null : destination;
}

async function copyWorktreeIncludes(repoRoot: string, worktreePath: string): Promise<string | null> {
  const includePath = path.join(repoRoot, ".worktreeinclude");
  if (!fs.existsSync(includePath)) return null;

  let temporaryDirectory: string | null = null;
  let errorMessage: string | null = null;
  try {
    const actuallyIgnored = await runGit(repoRoot, [
      "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
    ]);
    if (!actuallyIgnored.ok) {
      errorMessage = actuallyIgnored.stderr || "gitignore 対象ファイルを取得できませんでした。";
    } else {
      temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-worktreeinclude-"));
      const temporaryIncludePath = path.join(temporaryDirectory, "patterns");
      fs.copyFileSync(includePath, temporaryIncludePath);
      const matchingInclude = await runGit(repoRoot, [
        "ls-files", "--others", "--ignored", `--exclude-from=${temporaryIncludePath}`, "-z",
      ]);
      if (!matchingInclude.ok) {
        errorMessage = matchingInclude.stderr || ".worktreeinclude 対象ファイルを取得できませんでした。";
      } else {
        const ignoredPaths = new Set(parseNulSeparatedPaths(actuallyIgnored.stdout));
        const copyPaths = parseNulSeparatedPaths(matchingInclude.stdout)
          .filter((relativePath) => ignoredPaths.has(relativePath));
        let copiedFiles = 0;
        for (const relativePath of copyPaths) {
          if (copiedFiles >= MAX_WORKTREE_INCLUDE_FILES) break;
          const source = path.resolve(repoRoot, relativePath);
          if (!isPathInside(repoRoot, source) || !fs.existsSync(source)) continue;
          const sourceStatus = fs.lstatSync(source);
          if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) continue;
          const destination = worktreeDestination(worktreePath, relativePath);
          if (destination === null) continue;
          fs.copyFileSync(source, destination);
          copiedFiles += 1;
        }
      }
    }
  } catch (error) {
    errorMessage = String(error);
  } finally {
    if (temporaryDirectory !== null) {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        const cleanupError = String(error);
        errorMessage = errorMessage === null ? cleanupError : `${errorMessage}\n${cleanupError}`;
      }
    }
  }
  return errorMessage;
}

function normalizedExistingPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function worktreeManagementPath(listOutput: string, worktreePath: string): string | null {
  const target = normalizedExistingPath(worktreePath);
  const listed = listOutput.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return listed.find((candidate) => normalizedExistingPath(candidate) !== target) ?? listed[0] ?? null;
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

export interface GitWorktreeCreateResult {
  ok: boolean;
  branch: string;
  worktreePath: string;
  error: string | null;
}

/** Claude Code Desktop と同じ `.claude/worktrees` 配下へセッション用 worktree を作る。 */
export async function gitWorktreeCreate(
  repositoryWorkdir: string,
  baseBranch: string,
): Promise<GitWorktreeCreateResult> {
  const rootResult = await runGit(repositoryWorkdir, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    return { ok: false, branch: "", worktreePath: "", error: rootResult.stderr };
  }
  const repoRoot = rootResult.stdout.trim();
  if (!validRepositoryPath(repoRoot)) {
    return { ok: false, branch: "", worktreePath: "", error: "Git ルートが絶対パスではありません。" };
  }

  const timestamp = formatWorktreeTimestamp(new Date());
  let suffix = 1;
  let slug = timestamp;
  let branch = `worktree-${slug}`;
  let worktreePath = path.join(repoRoot, ".claude", "worktrees", slug);
  for (;;) {
    const branchExists = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (!fs.existsSync(worktreePath) && !branchExists.ok) break;
    suffix += 1;
    slug = `${timestamp}-${suffix}`;
    branch = `worktree-${slug}`;
    worktreePath = path.join(repoRoot, ".claude", "worktrees", slug);
  }

  const added = await runGit(repoRoot, ["worktree", "add", worktreePath, "-b", branch, baseBranch]);
  if (!added.ok) return { ok: false, branch, worktreePath, error: added.stderr };

  const errors: string[] = [];
  const excludeError = await appendWorktreeExclude(repoRoot);
  if (excludeError !== null) errors.push(excludeError);
  const includeError = await copyWorktreeIncludes(repoRoot, worktreePath);
  if (includeError !== null) {
    gitServiceDiag(`.worktreeinclude コピー失敗 path=${worktreePath}: ${includeError}`);
  }
  const locked = await runGit(repoRoot, ["worktree", "lock", "--reason", WORKTREE_LOCK_REASON, worktreePath]);
  if (!locked.ok) errors.push(locked.stderr);
  return {
    ok: errors.length === 0,
    branch,
    worktreePath,
    error: errors.length === 0 ? null : errors.join("\n"),
  };
}

/** worktree のロック解除。dirty worktree を残してセッションだけ終了する場合にも使う。 */
export async function gitWorktreeUnlock(
  worktreePath: string,
): Promise<{ ok: boolean; error: string | null }> {
  const result = await runGit(worktreePath, ["worktree", "unlock", worktreePath]);
  return { ok: result.ok, error: result.ok ? null : result.stderr };
}

/**
 * worktree に未保存変更がなく、HEAD が自分以外のローカルブランチから到達可能なら clean。
 * 後者により worktree 上だけの新規コミットを自動削除しない。
 */
export async function gitWorktreeIsClean(worktreePath: string): Promise<boolean> {
  const status = await runGit(worktreePath, ["status", "--porcelain"]);
  if (!status.ok || status.stdout.length !== 0) return false;
  const head = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return false;
  const current = await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branches = await runGit(worktreePath, [
    "for-each-ref", "--format=%(refname:short)", "--contains=HEAD", "refs/heads",
  ]);
  if (!branches.ok) return false;
  const currentBranch = current.ok ? current.stdout.trim() : null;
  return branches.stdout.split(/\r?\n/).some((branchName) =>
    branchName.length > 0 && branchName !== currentBranch
  );
}

/** `.claude/worktrees` 配下を文字列だけで判定する純関数。 */
export function isTailiiWorktreePath(candidate: string): boolean {
  return candidate.replaceAll("\\", "/").includes("/.claude/worktrees/");
}

/** worktree と、安全な自動生成ブランチだけを削除して管理情報を prune する。 */
export async function gitWorktreeRemove(
  worktreePath: string,
  force: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const listed = await runGit(worktreePath, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return { ok: false, error: listed.stderr };
  const managementPath = worktreeManagementPath(listed.stdout, worktreePath);
  if (managementPath === null || !validRepositoryPath(managementPath)) {
    return { ok: false, error: "worktree の管理リポジトリを特定できません。" };
  }
  const current = await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = current.ok ? current.stdout.trim() : null;
  await runGit(managementPath, ["worktree", "unlock", worktreePath]);

  const errors: string[] = [];
  const removed = await runGit(managementPath, [
    "worktree", "remove", ...(force ? ["--force"] : []), worktreePath,
  ]);
  if (!removed.ok) errors.push(removed.stderr);
  if (removed.ok && branch !== null &&
    (branch.startsWith("worktree-") || branch.startsWith("tailii/"))) {
    const deleted = await runGit(managementPath, ["branch", force ? "-D" : "-d", branch]);
    if (!deleted.ok) errors.push(deleted.stderr);
  }
  const pruned = await runGit(managementPath, ["worktree", "prune"]);
  if (!pruned.ok) errors.push(pruned.stderr);
  return { ok: errors.length === 0, error: errors.length === 0 ? null : errors.join("\n") };
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
