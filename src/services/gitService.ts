// gitService.ts
// tailii (TS host) — cwd Git 状態・差分・履歴・更新サービス

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GitBranchInfo, GitCommitInfo, GitStatusFile } from "../protocol.js";

const GIT_TIMEOUT_MS = 10_000;
/**
 * worktree 作成（checkout）だけの実行上限。追跡 1 万ファイル・1.8GB の作業ツリーで実測 約 5.6 秒
 * （2026-11-11, SSD・温まった状態）。遅いディスクや冷えた状態では数倍かかるため余裕を大きく取る。
 * iOS の待ち時間（ConnectionSessionModel.worktreeCreateTimeout）はこれより長くすること。
 */
export const GIT_WORKTREE_CREATE_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const DIFF_CHARACTER_LIMIT = 200_000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const MAX_WORKTREE_INCLUDE_FILES = 500;
const WORKTREE_EXCLUDE_LINE = ".claude/worktrees/";
const WORKTREE_LOCK_REASON = "tailii-session";

interface GitRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function validRepositoryPath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !candidate.startsWith("~");
}

/**
 * git のメッセージだけ英語に固定する環境（衝突の判定など stderr の文言を見る箇所が翻訳で外れないように）。
 * 文字の扱い（LC_CTYPE 等）は利用者の設定のまま残す（フックが日本語ファイル名を扱えるように）。
 * LC_ALL は全カテゴリを上書きするので外し、その値は LANG として残す。
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const all = env["LC_ALL"];
  delete env["LC_ALL"];
  if (all !== undefined && all.length > 0) env["LANG"] = all;
  env["LC_MESSAGES"] = "C";
  env["LANGUAGE"] = "C";
  return env;
}

function runGit(
  repositoryPath: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitRunResult> {
  if (!validRepositoryPath(repositoryPath)) {
    return Promise.resolve({
      ok: false, exitCode: null, stdout: "", stderr: "絶対パスを指定してください。",
    });
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repositoryPath, ...args],
      { timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", env: gitEnvironment() },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          exitCode: error !== null && typeof error.code === "number" ? error.code : null,
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
  // 読むだけの status / diff は index.lock を取らない（--no-optional-locks）。engine は読み取りの
  // 要求を並行に処理する（engine-concurrent-rpc）ので、取ると並行中の checkout / discard や
  // エージェント自身の git 操作が「index.lock が既にある」で失敗する。
  const result = await runGit(repositoryPath, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"]);
  if (!result.ok) return { isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
  const repoRootResult = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const headDiffstat = await runGit(repositoryPath, ["--no-optional-locks", "diff", "--shortstat", "HEAD"]);
  const diffstat = headDiffstat.ok
    ? headDiffstat
    : await runGit(repositoryPath, ["--no-optional-locks", "diff", "--shortstat"]);
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

type UntrackedPathKind = "file" | "directory";

async function untrackedPathKind(
  repositoryPath: string,
  file: string,
): Promise<UntrackedPathKind | null> {
  const result = await runGit(repositoryPath, [
    "ls-files", "--others", "--exclude-standard", "-z", "--", file,
  ]);
  if (!result.ok) return null;
  const requested = normalizeGitPath(file);
  const candidates = parseNulSeparatedPaths(result.stdout).map(normalizeGitPath);
  if (candidates.includes(requested)) return "file";
  if (candidates.some((candidate) => candidate.startsWith(`${requested}/`))) return "directory";
  return null;
}

async function runUntrackedDiff(
  repositoryPath: string,
  file: string,
  kind: UntrackedPathKind,
): Promise<GitRunResult> {
  if (kind === "file") {
    return runGit(repositoryPath, ["diff", "--no-index", "--", "/dev/null", file]);
  }
  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-git-diff-empty-"));
  try {
    return await runGit(repositoryPath, [
      "diff", "--no-index", "--", emptyDirectory, file,
    ]);
  } finally {
    fs.rmSync(emptyDirectory, { recursive: true, force: true });
  }
}

export async function gitDiff(
  repositoryPath: string,
  options: { file?: string; staged?: boolean; commit?: string | null } = {},
): Promise<{ isRepo: boolean; diff: string; truncated: boolean }> {
  if (!(await isGitRepository(repositoryPath))) return { isRepo: false, diff: "", truncated: false };
  let showUntrackedPath = false;
  let result: GitRunResult;
  if (options.commit) {
    result = await runGit(repositoryPath, ["show", options.commit]);
  } else if (options.file !== undefined && options.staged !== true) {
    const kind = await untrackedPathKind(repositoryPath, options.file);
    if (kind !== null) {
      showUntrackedPath = true;
      result = await runUntrackedDiff(repositoryPath, options.file, kind);
    } else {
      result = await runGit(repositoryPath, ["diff", "--", options.file]);
    }
  } else {
    result = await runGit(repositoryPath, [
      "diff",
      ...(options.staged ? ["--cached"] : []),
      ...(options.file ? ["--", options.file] : []),
    ]);
  }
  const expectedNoIndexDifference = showUntrackedPath && result.exitCode === 1;
  if (!result.ok && !expectedNoIndexDifference && result.stdout.length === 0) {
    return { isRepo: true, diff: "", truncated: false };
  }
  return {
    isRepo: true,
    diff: result.stdout.slice(0, DIFF_CHARACTER_LIMIT),
    truncated: (!result.ok && !expectedNoIndexDifference)
      || result.stdout.length > DIFF_CHARACTER_LIMIT,
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

/** `git worktree list --porcelain` の 1 件。 */
export interface GitWorktreeEntry {
  path: string;
  head: string | null;
  /** `refs/heads/` を外したブランチ名（detached は null）。 */
  branch: string | null;
  bare: boolean;
  /** ロック理由（ロック無しは null、理由なしのロックは ""）。 */
  lockReason: string | null;
}

/** `git worktree list --porcelain` を解析する純関数（先頭が本体 = main worktree）。 */
export function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null, bare: false, lockReason: null };
      entries.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "bare") current.bare = true;
    else if (line === "locked") current.lockReason = "";
    else if (line.startsWith("locked ")) current.lockReason = line.slice("locked ".length);
  }
  return entries;
}

async function listWorktreeEntries(repositoryPath: string): Promise<GitWorktreeEntry[] | null> {
  const listed = await runGit(repositoryPath, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return null;
  return parseWorktreeList(listed.stdout);
}

/**
 * リポジトリ本体（main worktree）のルート。worktree の中から呼んでも本体を返す（入れ子の作成防止）。
 * bare リポジトリなど本体の作業ツリーが無い場合だけ `--show-toplevel` へ退く。
 */
export async function gitMainWorktreeRoot(repositoryPath: string): Promise<string | null> {
  const entries = await listWorktreeEntries(repositoryPath);
  const main = entries?.[0];
  if (main !== undefined && !main.bare && validRepositoryPath(main.path)) return main.path;
  const top = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const root = top.stdout.trim();
  return validRepositoryPath(root) ? root : null;
}

/** 本体ルート直下の `.claude/worktrees`。 */
export function worktreesDirectory(mainRoot: string): string {
  return path.join(mainRoot, ".claude", "worktrees");
}

/** `.claude/worktrees` 配下の登録済み worktree と、その本体ルート。 */
export interface ManagedWorktree {
  mainRoot: string;
  entry: GitWorktreeEntry;
  /** 登録は残っているがフォルダが消えている（`git worktree prune` 待ち）。 */
  missing: boolean;
}

/** 消えたパスも比べられる正規化（親フォルダだけ実パスにする）。 */
function normalizedMaybeMissingPath(value: string): string {
  if (pathEntryExists(value)) return normalizedExistingPath(value);
  return path.join(normalizedExistingPath(path.dirname(value)), path.basename(value));
}

/**
 * `candidate` が「本体の `.claude/worktrees/` 配下に登録された worktree そのもの」なら返す。
 * 配下のサブディレクトリ・本体・手動で別の場所に作った worktree・未登録のディレクトリは null。
 */
export async function resolveManagedWorktree(candidate: string): Promise<ManagedWorktree | null> {
  if (!validRepositoryPath(candidate)) return null;
  const missing = !pathEntryExists(candidate);
  // フォルダが消えた登録は本人からは git を呼べないので、パスの手前（本体ルート）から調べる。
  const lookupPath = missing ? tailiiWorktreeRepoRoot(candidate) : candidate;
  if (lookupPath === null || !pathEntryExists(lookupPath)) return null;
  const entries = await listWorktreeEntries(lookupPath);
  if (entries === null || entries.length < 2) return null;
  const main = entries[0]!;
  if (main.bare || !validRepositoryPath(main.path)) return null;
  const target = normalizedMaybeMissingPath(candidate);
  const container = normalizedExistingPath(worktreesDirectory(main.path));
  const entry = entries.slice(1).find((item) => normalizedMaybeMissingPath(item.path) === target);
  if (entry === undefined || !isPathInside(container, target)) return null;
  return { mainRoot: main.path, entry, missing };
}

/** 会話の cwd（worktree 内のサブディレクトリでもよい）から、それを収める管理対象 worktree を返す。 */
export async function resolveManagedWorktreeForCwd(cwd: string): Promise<ManagedWorktree | null> {
  if (!validRepositoryPath(cwd) || !fs.existsSync(cwd)) return null;
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  return resolveManagedWorktree(top.stdout.trim());
}

/** 本体の `.claude/worktrees` 配下に登録された worktree の一覧（本体ルートは worktree の中からでも解決）。 */
export async function gitManagedWorktrees(
  repositoryPath: string,
): Promise<{ mainRoot: string; worktrees: GitWorktreeEntry[] } | null> {
  const entries = await listWorktreeEntries(repositoryPath);
  if (entries === null || entries.length === 0) return null;
  const main = entries[0]!;
  if (main.bare || !validRepositoryPath(main.path)) return null;
  const container = normalizedExistingPath(worktreesDirectory(main.path));
  const worktrees = entries.slice(1).filter((entry) =>
    isPathInside(container, normalizedMaybeMissingPath(entry.path)));
  return { mainRoot: main.path, worktrees };
}

/** worktree 作成をリポジトリ単位で直列化する（同じ秒の並行作成でブランチ名が衝突しない）。 */
const worktreeQueues = new Map<string, Promise<unknown>>();

/** 同じリポジトリの worktree 作成・掃除を 1 本の列に並べて実行する。 */
export function withWorktreeQueue<T>(mainRoot: string, body: () => Promise<T>): Promise<T> {
  const key = normalizedExistingPath(mainRoot);
  const previous = worktreeQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(body);
  const tail = run.catch(() => undefined);
  worktreeQueues.set(key, tail);
  void tail.then(() => {
    if (worktreeQueues.get(key) === tail) worktreeQueues.delete(key);
  });
  return run;
}

/**
 * `worktree add` の失敗の分類（純関数）。git 自身が**今回のブランチ名・パスを名指しした** `fatal:` 行だけを
 * 衝突とみなす（checkout 後のフックの中で動いた git が出す別名の `fatal:` 行を取り違えない）。
 * - `branch-collision`: 今回のブランチが既にある / その ref を取れない（自分のブランチは作られていない。
 *   相手のものなので何も消さない）
 * - `name-collision`: 今回のパスが既にある（git が `-b` で先に作った自分のブランチが残りうる）
 * - `failure`: それ以外（打ち切り・フックの失敗など。作りかけを巻き戻す）
 */
export function classifyWorktreeAddFailure(
  stderr: string,
  branch: string,
  worktreePath: string,
): "branch-collision" | "name-collision" | "failure" {
  const fatalLines = stderr.split(/\r?\n/).filter((line) => line.startsWith("fatal: "));
  // 古い git は「A branch named '…' already exists.」（大文字始まり・末尾ピリオド）なので、大小と末尾の
  // ピリオドは問わない。名前・パスの部分は一字一句で比べる。
  const sameLine = (line: string, expected: string): boolean =>
    line.replace(/\.$/, "").toLowerCase() === expected.toLowerCase() &&
    line.includes(expected.slice(expected.indexOf("'")));
  if (fatalLines.some((line) => sameLine(line, `fatal: a branch named '${branch}' already exists`)) ||
    fatalLines.some((line) => line.startsWith(`fatal: cannot lock ref 'refs/heads/${branch}'`))) {
    return "branch-collision";
  }
  if (fatalLines.some((line) => sameLine(line, `fatal: '${worktreePath}' already exists`))) return "name-collision";
  return "failure";
}

/**
 * 作成先フォルダを先に作って名前を確保する（別プロセスと同じ名前を取り合わない。`mkdir` は原子的）。
 * 確保できなければ false（既にある）。git は空のフォルダへの `worktree add` を受け付ける。
 */
function claimWorktreeDirectory(worktreePath: string): boolean {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  try {
    fs.mkdirSync(worktreePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * 確保したフォルダだけを片付ける（ブランチ名の衝突時）。中身があれば（フォルダを確保しない旧版の
 * 作成者がこのフォルダへ作り終えていれば）消さない: 相手の worktree・ブランチ・登録には触れない。
 */
export function releaseClaimedDirectory(worktreePath: string): void {
  try {
    fs.rmdirSync(worktreePath);
  } catch (error) {
    gitServiceDiag(`確保したフォルダを残す path=${worktreePath}: ${String(error)}`);
  }
}

/**
 * 衝突で連番を進めるとき、git が `-b` で先に作ったまま残した自分のブランチを片付ける。
 * どの worktree にも登録されておらず、起点と同じコミットを指す（固有のコミットが無い）ときだけ消す。
 */
async function dropOrphanCreatedBranch(mainRoot: string, branch: string, baseBranch: string): Promise<void> {
  const tip = await runGit(mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!tip.ok) return;
  const base = await runGit(mainRoot, ["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
  if (!base.ok || base.stdout.trim() !== tip.stdout.trim()) return;
  const entries = await listWorktreeEntries(mainRoot);
  if (entries === null || entries.some((entry) => entry.branch === branch)) return;
  const deleted = await runGit(mainRoot, ["branch", "-D", branch]);
  if (!deleted.ok) gitServiceDiag(`衝突で残ったブランチの削除失敗 branch=${branch}: ${deleted.stderr}`);
}

/**
 * 作りかけの worktree を巻き戻す（作成の部分失敗・打ち切り）。今回作ったブランチと、
 * `.claude/worktrees` 配下の今回のディレクトリだけを消す。失敗は診断ログにだけ残す。
 */
export async function rollbackCreatedWorktree(mainRoot: string, worktreePath: string, branch: string): Promise<void> {
  // そのパスの登録が別のブランチなら他人の物なので触れない（登録が無い＝add が途中で止まった）。
  const entries = await listWorktreeEntries(mainRoot);
  const target = normalizedMaybeMissingPath(worktreePath);
  const registered = entries?.find((entry) => normalizedMaybeMissingPath(entry.path) === target) ?? null;
  if (entries === null || (registered !== null && registered.branch !== branch)) {
    gitServiceDiag(`巻き戻しを見送り（登録を確認できない・別のブランチ） path=${worktreePath}`);
    return;
  }
  if (registered !== null) {
    await runGit(mainRoot, ["worktree", "unlock", worktreePath]);
    const removed = await runGit(
      mainRoot, ["worktree", "remove", "--force", "--force", worktreePath], GIT_WORKTREE_CREATE_TIMEOUT_MS,
    );
    if (!removed.ok) gitServiceDiag(`巻き戻し worktree remove 失敗 path=${worktreePath}: ${removed.stderr}`);
  }
  if (pathEntryExists(worktreePath) && isPathInside(worktreesDirectory(mainRoot), worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (error) {
      gitServiceDiag(`巻き戻し ディレクトリ削除失敗 path=${worktreePath}: ${String(error)}`);
    }
  }
  const branchExists = await runGit(mainRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists.ok) {
    const deleted = await runGit(mainRoot, ["branch", "-D", branch]);
    if (!deleted.ok) gitServiceDiag(`巻き戻し branch 削除失敗 branch=${branch}: ${deleted.stderr}`);
  }
}

/** 起点ブランチ名の検証。`-` 始まり（git のオプション扱いになる）と、コミットを指さない名前を拒否する。 */
async function validateBaseBranch(repoRoot: string, baseBranch: string): Promise<string | null> {
  if (baseBranch.length === 0 || baseBranch.startsWith("-") || /[\0\r\n]/.test(baseBranch)) {
    return "起点ブランチ名が不正です。";
  }
  const resolved = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
  if (!resolved.ok || resolved.stdout.trim().length === 0) {
    return `起点ブランチ ${baseBranch} が見つかりません。`;
  }
  return null;
}

/** 作成の 1 回の試行の上限（同じ名前が別プロセスに取られ続けた場合の打ち切り）。 */
const MAX_WORKTREE_CREATE_ATTEMPTS = 20;

/** Claude Code Desktop と同じ `.claude/worktrees` 配下へセッション用 worktree を作る。 */
export async function gitWorktreeCreate(
  repositoryWorkdir: string,
  baseBranch: string,
): Promise<GitWorktreeCreateResult> {
  const failure = (error: string, branch = "", worktreePath = ""): GitWorktreeCreateResult =>
    ({ ok: false, branch, worktreePath, error });
  // worktree の中から作っても本体ルートを基準にする（`<worktree>/.claude/worktrees/…` の入れ子を作らない）。
  const repoRoot = await gitMainWorktreeRoot(repositoryWorkdir);
  if (repoRoot === null) {
    const top = await runGit(repositoryWorkdir, ["rev-parse", "--show-toplevel"]);
    return failure(top.ok ? "Git ルートが絶対パスではありません。" : top.stderr);
  }
  const baseError = await validateBaseBranch(repoRoot, baseBranch);
  if (baseError !== null) return failure(baseError);

  return withWorktreeQueue(repoRoot, async () => {
    const timestamp = formatWorktreeTimestamp(new Date());
    let suffix = 1;
    for (let attempt = 0; attempt < MAX_WORKTREE_CREATE_ATTEMPTS; attempt += 1) {
      let slug = suffix === 1 ? timestamp : `${timestamp}-${suffix}`;
      let branch = `worktree-${slug}`;
      let worktreePath = path.join(worktreesDirectory(repoRoot), slug);
      for (;;) {
        const branchExists = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        // フォルダの確保（mkdir）で名前を自分のものにする。以後このフォルダと同名のブランチは
        // 別の engine が作らない（同じ名前を確保できないため）ので、失敗時に巻き戻してよい。
        if (!branchExists.ok && !pathEntryExists(worktreePath) && claimWorktreeDirectory(worktreePath)) break;
        suffix += 1;
        slug = `${timestamp}-${suffix}`;
        branch = `worktree-${slug}`;
        worktreePath = path.join(worktreesDirectory(repoRoot), slug);
      }

      const added = await runGit(
        repoRoot, ["worktree", "add", worktreePath, "-b", branch, baseBranch], GIT_WORKTREE_CREATE_TIMEOUT_MS,
      );
      if (!added.ok) {
        const failureKind = classifyWorktreeAddFailure(added.stderr, branch, worktreePath);
        const registeredHere = (await listWorktreeEntries(repoRoot))?.find((entry) =>
          normalizedMaybeMissingPath(entry.path) === normalizedMaybeMissingPath(worktreePath)) ?? null;
        if (failureKind === "branch-collision") {
          // git 自身が「ブランチを作る前に断った」と言っている＝こちらは何も作っていない。このパスに
          // 登録があるなら、フォルダを確保しない旧版の作成者が同じ名前で作り終えた相手の物なので、
          // 何も消さずに失敗を返す（同名なので自分の物とは区別できない＝残す）。
          if (registeredHere !== null) {
            return failure("同じ名前のワークツリーが同時に作成されたため作成できませんでした。もう一度送信してください。");
          }
          releaseClaimedDirectory(worktreePath);
          suffix += 1;
          continue;
        }
        // それ以外で自分のブランチ名のまま登録済みなら、作り終えてから失敗が返った（checkout 後の
        // フックの失敗など）。文言に「already exists」があっても衝突ではないので巻き戻しへ進む。
        const registeredAsOurs = registeredHere !== null && registeredHere.branch === branch;
        if (failureKind === "name-collision" && !registeredAsOurs) {
          // パスの衝突: 確保したフォルダ（空のときだけ）と、git が `-b` で先に作ったまま残した
          // 自分のブランチ（どこにも登録されず起点と同じコミットのときだけ）を片付けて連番を進める。
          releaseClaimedDirectory(worktreePath);
          await dropOrphanCreatedBranch(repoRoot, branch, baseBranch);
          suffix += 1;
          continue;
        }
        // 打ち切り（checkout の途中）や失敗で作りかけが残りうる。今回確保した名前のものだけ巻き戻す。
        await rollbackCreatedWorktree(repoRoot, worktreePath, branch);
        return failure(added.stderr || "ワークツリーを作成できませんでした。", branch, worktreePath);
      }

      const errors: string[] = [];
      const excludeError = await appendWorktreeExclude(repoRoot);
      if (excludeError !== null) errors.push(excludeError);
      const includeError = await copyWorktreeIncludes(repoRoot, worktreePath);
      if (includeError !== null) {
        gitServiceDiag(`.worktreeinclude コピー失敗 path=${worktreePath}: ${includeError}`);
      }
      if (errors.length === 0) {
        const locked = await runGit(repoRoot, ["worktree", "lock", "--reason", WORKTREE_LOCK_REASON, worktreePath]);
        if (!locked.ok) errors.push(locked.stderr);
      }
      if (errors.length > 0) {
        // 半端な worktree（除外設定やロックの無いもの）を残さない。
        await rollbackCreatedWorktree(repoRoot, worktreePath, branch);
        return failure(errors.join("\n"), branch, worktreePath);
      }
      return { ok: true, branch, worktreePath, error: null };
    }
    return failure("ワークツリー名が他の作成と衝突し続けたため作成できませんでした。");
  });
}

/** worktree のロック解除。dirty worktree を残してセッションだけ終了する場合にも使う。 */
export async function gitWorktreeUnlock(
  worktreePath: string,
): Promise<{ ok: boolean; error: string | null }> {
  const result = await runGit(worktreePath, ["worktree", "unlock", worktreePath]);
  return { ok: result.ok, error: result.ok ? null : result.stderr };
}

/** worktree に残っている変更の件数。 */
export interface WorktreeChangeSummary {
  /** 未保存（未コミット・未追跡）のファイル数。 */
  uncommitted: number;
  /** 他のローカルブランチにもリモート追跡ブランチにも含まれないコミット数。 */
  unmergedCommits: number;
}

/**
 * HEAD のうち、自分以外のローカルブランチと `refs/remotes` のどれからも到達できないコミット数。
 * 判定できなければ null。
 */
async function unmergedCommitCount(
  repositoryPath: string,
  ownBranch: string | null,
  revision = "HEAD",
): Promise<number | null> {
  const counted = await runGit(repositoryPath, [
    "rev-list", "--count", revision, "--not",
    // ブランチ名に glob 文字（* ? [）は使えないので、exclude は自分のブランチだけに一致する。
    ...(ownBranch !== null ? [`--exclude=${ownBranch}`] : []),
    "--branches", "--remotes",
  ]);
  if (!counted.ok) return null;
  const value = Number.parseInt(counted.stdout.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * フォルダが消えた登録のコミットのうち、他のブランチにもリモートにも含まれない数（判定できなければ null）。
 * ブランチがあればそのブランチ（自分は除く）、detached ならその HEAD で数える。
 */
export async function gitMissingWorktreeUnmergedCount(
  mainRoot: string,
  entry: GitWorktreeEntry,
): Promise<number | null> {
  if (entry.branch !== null) return unmergedCommitCount(mainRoot, entry.branch, `refs/heads/${entry.branch}`);
  if (entry.head === null) return null;
  return unmergedCommitCount(mainRoot, null, entry.head);
}

/** worktree の変更件数。判定できない（壊れている・HEAD が無い等）なら null。 */
export async function gitWorktreeChangeSummary(worktreePath: string): Promise<WorktreeChangeSummary | null> {
  if (!validRepositoryPath(worktreePath) || !fs.existsSync(worktreePath)) return null;
  const status = await runGit(worktreePath, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok) return null;
  const head = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return null;
  const current = await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const unmerged = await unmergedCommitCount(worktreePath, current.ok ? current.stdout.trim() : null);
  if (unmerged === null) return null;
  return {
    uncommitted: status.stdout.split(/\r?\n/).filter((line) => line.length > 0).length,
    unmergedCommits: unmerged,
  };
}

/**
 * worktree に未保存変更がなく、HEAD が自分以外のローカルブランチか `refs/remotes` から到達可能なら clean。
 * 後者により worktree 上だけの新規コミットを自動削除しない（push 済みなら消してよい）。
 */
export async function gitWorktreeIsClean(worktreePath: string): Promise<boolean> {
  const summary = await gitWorktreeChangeSummary(worktreePath);
  return summary !== null && summary.uncommitted === 0 && summary.unmergedCommits === 0;
}

/** `.claude/worktrees` 配下を文字列だけで判定する純関数。 */
export function isTailiiWorktreePath(candidate: string): boolean {
  return candidate.replaceAll("\\", "/").includes("/.claude/worktrees/");
}

/** worktree パスから repo ルート（`/.claude/worktrees/` の手前）を文字列だけで取り出す純関数。 */
export function tailiiWorktreeRepoRoot(candidate: string): string | null {
  const index = candidate.replaceAll("\\", "/").indexOf("/.claude/worktrees/");
  if (index <= 0) return null;
  return candidate.slice(0, index);
}

/** Tailii が作ったロック（理由 `tailii-session` と完全一致）か。 */
export function isTailiiSessionLock(entry: GitWorktreeEntry): boolean {
  return entry.lockReason === WORKTREE_LOCK_REASON;
}

/**
 * worktree（対象 1 件の登録）と、安全な自動生成ブランチだけを削除する。
 * 対象は本体の `.claude/worktrees/` 配下に登録された worktree だけ（それ以外の場所は拒否）。
 * フォルダが消えた登録では、どこにも無いコミットを持つブランチは force でも消さない（移動先の
 * フォルダは git から外れるので、コミットを辿れるのはブランチだけになる）。
 */
export async function gitWorktreeRemove(
  worktreePath: string,
  force: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const managed = await resolveManagedWorktree(worktreePath);
  if (managed === null) {
    return { ok: false, error: ".claude/worktrees 配下のワークツリーではないため削除できません。" };
  }
  const managementPath = managed.mainRoot;
  const target = managed.entry.path;
  const branch = managed.entry.branch;
  const lockReason = managed.entry.lockReason;
  // detached の worktree は、外すとその HEAD を指す ref が無くなる。フォルダが消えた登録と、
  // 非 force の削除（一覧の後に増えたコミットを確認文で知らせていない）では、どこにも無い
  // コミットがある（または判定できない）なら外さない。ブランチ付きは削除後の `branch -d` が守る。
  if (branch === null && (managed.missing || !force)) {
    const head = managed.entry.head;
    const unmerged = head === null ? null : await unmergedCommitCount(managementPath, null, head);
    if (unmerged !== 0) {
      return {
        ok: false,
        error: managed.missing
          ? "フォルダが見つからず、どのブランチにも無いコミットがあるため登録を外せません。"
          : "どのブランチにも無いコミットがあるため削除できません。一覧を更新してください。",
      };
    }
  }
  if (lockReason !== null) await runGit(managementPath, ["worktree", "unlock", target]);

  const errors: string[] = [];
  // 対象の 1 件だけを外す（`worktree prune` はリポジトリ全体の消えた登録を巻き込むので使わない）。
  // フォルダが消えた登録にも `worktree remove` が効く。
  const removed = await runGit(managementPath, [
    "worktree", "remove", ...(force ? ["--force"] : []), target,
  ], GIT_WORKTREE_CREATE_TIMEOUT_MS);
  if (!removed.ok) {
    errors.push(removed.stderr);
    // 消せなかったら元のロックを掛け直す（ロックだけ外れて掃除の候補からも外れる、を防ぐ）。
    if (lockReason !== null) {
      const relocked = await runGit(managementPath, [
        "worktree", "lock", ...(lockReason.length > 0 ? ["--reason", lockReason] : []), target,
      ]);
      if (!relocked.ok) gitServiceDiag(`ロックの掛け直し失敗 path=${target}: ${relocked.stderr}`);
    }
  }
  if (removed.ok && branch !== null &&
    (branch.startsWith("worktree-") || branch.startsWith("tailii/"))) {
    // 消した後に判定し直す（確認から削除までの間に増えたコミットを -D で失わない）。自分以外の
    // ブランチかリモートに含まれていれば -D（`branch -d` は push 済みでも upstream 未設定だと断る）。
    const branchSafe = await unmergedCommitCount(managementPath, branch, `refs/heads/${branch}`) === 0;
    if (managed.missing && !branchSafe) {
      gitServiceDiag(`フォルダが消えた worktree のブランチは未マージのコミットがあるため残す branch=${branch}`);
    } else {
      const deleted = await runGit(managementPath, ["branch", force || branchSafe ? "-D" : "-d", branch]);
      if (!deleted.ok) errors.push(deleted.stderr);
    }
  }
  return { ok: errors.length === 0, error: errors.length === 0 ? null : errors.join("\n") };
}

/** worktree ディレクトリの古さ（ミリ秒）。作成直後の掃除を避けるための猶予判定に使う。不明は null。 */
export function worktreeAgeMs(worktreePath: string, now: number = Date.now()): number | null {
  try {
    const stat = fs.statSync(worktreePath);
    const created = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    return Math.max(0, now - created);
  } catch {
    return null;
  }
}

export async function gitEntryStatuses(
  directoryPath: string,
  names: string[],
): Promise<Map<string, string>> {
  // 読むだけなので index.lock を取らない（gitStatus と同じ理由, engine-concurrent-rpc）。
  const result = await runGit(directoryPath, [
    "--no-optional-locks", "-c", "core.quotePath=false",
    "status", "--porcelain=v2", "--untracked-files=all", "--", ".",
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
