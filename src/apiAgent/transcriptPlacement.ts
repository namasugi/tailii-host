// apiAgent/transcriptPlacement.ts
// API 作業の会話の「今の作業フォルダ」と「次のターンを起動するフォルダ」を、会話ログの今の場所から決める
// （session-workdir-change）。
//
// API 作業は毎ターン別プロセスで SDK を `cwd` と `resume: 会話 id` で起動する。ターンの中で Claude 自身が作業フォルダを
// 移すと（`EnterWorktree` / `ExitWorktree`。SDK の `tools: preset claude_code` に入っている）、Claude Code は会話ログを
// 移動先の slug へ移し `relocated` 行を書く（claudeTranscriptLocator.ts）。hub が持つ cwd のまま次のターンを起動すると
// 古い slug を見ることになるので、ターンの前に会話ログの今の場所から決め直す。
//
// Claude Code 2.1.325 の実測（2026-11-15。定額のログインの `claude -p`、作業用の git リポジトリ R とワークツリー W）:
//   - `-p`（端末なし）でも `EnterWorktree` は動く（遅延読み込みのツールなので、モデルは先に ToolSearch を使う）。
//     入ると会話ログは W の slug へ移り、`relocated`（relocatedCwd = W）と `worktree-state`（worktreeSession =
//     {originalCwd: R, worktreePath: W, worktreeName, worktreeBranch, originalBranch, originalHeadCommit, …}）が書かれる。
//     resume のたびに両方が末尾へ書き直される。
//   - W のフォルダで `--resume` しても、R のフォルダで `--resume` しても会話は見つかり、どちらも W で続く（R から起動すると
//     Claude が自分で W へ入り直す）。断りや確認は出ず、会話ログは W の slug に留まる。
//   - `ExitWorktree`（keep）で会話ログは R の slug へ戻り、`relocated`（R）と `worktree-state`（worktreeSession: null）が
//     書かれる。W はフォルダごと残る。
// なので起動フォルダは今の作業フォルダ（W にいれば W。端末の再開 launch.ts の relocatedResumeCwd と同じ）にする。
// ワークツリーの記録を読むのは、今の作業フォルダが消えているとき（入る前のフォルダへ戻す）と、利用者の変更を確かめる
// ときだけ（毎ターンは会話ログを読まない）。

import * as fs from "node:fs";
import { locateClaudeTranscript, moveClaudeTranscript } from "../sessions/claudeTranscriptLocator.js";
import { missingWorktreeFallback } from "../shared/paths.js";

/**
 * 初めて読む会話ログで、末尾から worktree-state 行を探す上限。2 回目からは前回の続き（伸びた分）だけを読む。
 * worktree-state は resume のたびに末尾へ書き直されるので、ワークツリーに入っている会話なら直近のターンの中にある。
 */
export const WORKTREE_STATE_SCAN_CAP_BYTES = 8 * 1024 * 1024;
/** 1 回に読む量。 */
const SCAN_CHUNK_BYTES = 256 * 1024;
/** 印が 2 つの読み取りにまたがっても見落とさないための重なり。 */
const MARKER_OVERLAP_BYTES = 32;
/** 見つけた印の前後に行の区切りを探す範囲（worktree-state 行は数 KB）。 */
const LINE_WINDOW_BYTES = 64 * 1024;
/** 覚えておく会話ログの数。 */
const CACHE_LIMIT = 64;
/** 記録の種類の印（JSON の値として現れる綴り。本文中の同じ語は引用符がエスケープされるので当たらない）。 */
const MARKER = Buffer.from('"worktree-state"');

/** Claude 自身が入ったワークツリー（会話ログの `worktree-state.worktreeSession`）。 */
export interface WorktreeBinding {
  worktreePath: string;
  /** ワークツリーに入る前のフォルダ。 */
  originalCwd: string;
}

export interface ConversationPlacement {
  /** 会話の今の作業フォルダ（記録・承認カード・`pc:cwd` に使う値）。 */
  cwd: string;
  /** 次のターンの SDK の `cwd`。 */
  launchCwd: string;
  /** 会話ログのパス（まだ無ければ null）。 */
  transcriptPath: string | null;
}

/**
 * 会話の今の作業フォルダと起動フォルダ。会話ログが記録上の cwd の slug に無く、別の slug にあって、その会話のフォルダが
 * 実在するときだけ記録上の cwd から変える。今の作業フォルダが消えていて、Claude がワークツリーに入っていた会話なら、
 * 会話ログを入る前のフォルダの slug へ戻してそこで起動する（端末の再開 launch.ts の rescueMissingWorktreeCwd と同じ考え。
 * 呼び手は会話を掴んでいる claude が無いことを確かめてから呼ぶ）。それ以外は記録どおり。
 * 普段（会話ログが記録どおりの slug にある）は会話ログの有無を見るだけで、中身は読まない。
 */
export function resolveConversationPlacement(
  conversationId: string,
  recordedCwd: string,
  options: { projectsDir?: string } = {},
): ConversationPlacement {
  const projects = options.projectsDir !== undefined ? { projectsDir: options.projectsDir } : {};
  const located = locateClaudeTranscript(conversationId, recordedCwd, projects);
  if (located === null) return { cwd: recordedCwd, launchCwd: recordedCwd, transcriptPath: null };
  const cwd = located.moved && located.cwd !== null && located.cwd !== recordedCwd && isDirectory(located.cwd)
    ? located.cwd : recordedCwd;
  if (isDirectory(cwd)) {
    // 一覧・hub が先に戻り先へ揃えた場合も、SDK の resume が読む slug へログを戻す。
    if (located.moved && located.cwd !== null && missingWorktreeFallback(located.cwd) !== null) {
      const moved = moveClaudeTranscript({ conversationId, toCwd: cwd, fromCwd: located.cwd, ...projects });
      if (moved.status === "moved" || moved.status === "in_place") {
        return { cwd, launchCwd: cwd, transcriptPath: moved.path };
      }
    }
    return { cwd, launchCwd: cwd, transcriptPath: located.path };
  }
  const fallback = activeWorktreeBinding(located.path)?.originalCwd ?? missingWorktreeFallback(cwd);
  if (fallback === null || !isDirectory(fallback)) return { cwd, launchCwd: cwd, transcriptPath: located.path };
  const moved = moveClaudeTranscript({ conversationId, toCwd: fallback, fromCwd: cwd, ...projects });
  if (moved.status !== "moved" && moved.status !== "in_place") return { cwd, launchCwd: cwd, transcriptPath: located.path };
  return { cwd: fallback, launchCwd: fallback, transcriptPath: moved.path };
}

/** 会話 id と記録上の cwd から、Claude が入っているワークツリー（無ければ null）。 */
export function conversationWorktreeBinding(
  conversationId: string,
  recordedCwd: string,
  options: { projectsDir?: string } = {},
): WorktreeBinding | null {
  const located = locateClaudeTranscript(conversationId, recordedCwd, options.projectsDir !== undefined
    ? { projectsDir: options.projectsDir } : {});
  return located === null ? null : activeWorktreeBinding(located.path);
}

interface BindingCacheEntry {
  dev: number;
  ino: number;
  /** ここまで（行の区切りの直後）読んだ。 */
  scannedTo: number;
  binding: WorktreeBinding | null;
}

/** 会話ログごとの読み取り済みの位置と結果（「無い」も覚える）。hub の 1 プロセスの中だけ。 */
const bindingCache = new Map<string, BindingCacheEntry>();

/**
 * 会話ログの最後の `worktree-state`（`EnterWorktree` で書かれ、`ExitWorktree` で `worktreeSession: null` が書かれる。
 * 最後の行が正）。ワークツリーに入っていなければ null。初めての会話ログは末尾から上限（8MB）まで、2 回目からは伸びた分
 * だけを読む（同じファイル・同じ大きさなら読まない）。`onRead` は読んだバイト数（テスト用）。
 */
export function activeWorktreeBinding(transcriptPath: string, onRead?: (bytes: number) => void): WorktreeBinding | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    bindingCache.delete(transcriptPath);
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const read = (position: number, length: number): Buffer => {
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, position);
      onRead?.(bytesRead);
      return buf.subarray(0, bytesRead);
    };
    const cached = bindingCache.get(transcriptPath);
    const sameFile = cached !== undefined && cached.dev === stat.dev && cached.ino === stat.ino && stat.size >= cached.scannedTo;
    if (sameFile && stat.size === cached.scannedTo) return touch(transcriptPath, cached).binding;
    const end = completeLinesEnd(stat.size, read);
    const from = sameFile ? cached.scannedTo : Math.max(0, end - WORKTREE_STATE_SCAN_CAP_BYTES);
    if (sameFile && end <= cached.scannedTo) return touch(transcriptPath, cached).binding;
    const found = lastWorktreeState(from, end, read);
    const binding = found !== undefined ? found : sameFile ? cached.binding : null;
    touch(transcriptPath, { dev: stat.dev, ino: stat.ino, scannedTo: end, binding });
    return binding;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** テスト用: 覚えた結果を捨てる。 */
export function resetWorktreeBindingCache(): void {
  bindingCache.clear();
}

function touch(key: string, entry: BindingCacheEntry): BindingCacheEntry {
  bindingCache.delete(key);
  bindingCache.set(key, entry);
  while (bindingCache.size > CACHE_LIMIT) {
    const oldest = bindingCache.keys().next().value;
    if (oldest === undefined) break;
    bindingCache.delete(oldest);
  }
  return entry;
}

/** 改行で終わった行の終わり（書き込み途中の最後の行は読まない）。末尾の窓に改行が無ければ 0。 */
function completeLinesEnd(size: number, read: (position: number, length: number) => Buffer): number {
  if (size === 0) return 0;
  const span = Math.min(size, LINE_WINDOW_BYTES);
  const tail = read(size - span, span);
  const nl = tail.lastIndexOf(0x0a);
  return nl < 0 ? 0 : size - span + nl + 1;
}

/**
 * `[from, end)`（どちらも行の区切り）を末尾から遡り、最後の worktree-state 行の中身を返す。行が無ければ undefined、
 * 空（出た後）・読めない形なら null。印をまとめて探し（Buffer.lastIndexOf）、当たった行だけを解く。
 */
function lastWorktreeState(
  from: number, end: number, read: (position: number, length: number) => Buffer,
): WorktreeBinding | null | undefined {
  let position = end;
  let checkedBelow = Number.POSITIVE_INFINITY;
  while (position > from) {
    const length = Math.min(SCAN_CHUNK_BYTES, position - from);
    position -= length;
    const chunk = read(position, Math.min(length + MARKER_OVERLAP_BYTES, end - position));
    for (let i = chunk.lastIndexOf(MARKER); i >= 0; i = i > 0 ? chunk.lastIndexOf(MARKER, i - 1) : -1) {
      const at = position + i;
      if (i >= length || at >= checkedBelow) continue;
      const line = readLineAround(at, from, end, read);
      if (line === null) continue;
      checkedBelow = line.start;
      const record = parseWorktreeState(line.text);
      if (record !== undefined) return record;
    }
  }
  return undefined;
}

function readLineAround(
  at: number, from: number, end: number, read: (position: number, length: number) => Buffer,
): { start: number; text: string } | null {
  const windowStart = Math.max(from, at - LINE_WINDOW_BYTES);
  const windowEnd = Math.min(end, at + LINE_WINDOW_BYTES);
  const window = read(windowStart, windowEnd - windowStart);
  const offset = at - windowStart;
  const nlBefore = window.lastIndexOf(0x0a, offset);
  if (nlBefore < 0 && windowStart > from) return null;
  const nlAfter = window.indexOf(0x0a, offset);
  if (nlAfter < 0) return null;
  return { start: windowStart + nlBefore + 1, text: window.subarray(nlBefore + 1, nlAfter).toString("utf8") };
}

/** worktree-state 行なら中身（空・読めない形は null）。ほかの行は undefined。 */
function parseWorktreeState(line: string): WorktreeBinding | null | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null || record["type"] !== "worktree-state") return undefined;
  const session = record["worktreeSession"];
  if (typeof session !== "object" || session === null) return null;
  const worktreePath = (session as Record<string, unknown>)["worktreePath"];
  const originalCwd = (session as Record<string, unknown>)["originalCwd"];
  return typeof worktreePath === "string" && worktreePath.startsWith("/") &&
    typeof originalCwd === "string" && originalCwd.startsWith("/") ? { worktreePath, originalCwd } : null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
