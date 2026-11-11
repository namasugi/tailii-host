// engine/worktreeJanitor.ts
// `.claude/worktrees` 配下の worktree の片付け（worktree-janitor）。
//   - 孤児の掃除: Tailii が作った（ロック理由 `tailii-session`）・使っている会話もセッションも無い・
//     変更なし・作成から猶予を過ぎた worktree だけを消す。変更ありは消さず一覧で見せる。
//   - 起動失敗の巻き戻し: session_start が失敗したとき、今作ったばかりの worktree を消す。
//   - 会話の完全削除の後片付け: 会話の cwd が worktree なら、変更なしは消し、変更ありは確認用の情報を返す。
// 削除系は判定できないとき必ず残す（一覧の取得失敗・git の失敗・状態不明はすべて「使用中」扱い）。

import * as fs from "node:fs";
import * as path from "node:path";
import { listPeerSessions } from "../services/peerSessions.js";
import { defaultClaudeSessionsDir } from "../sessions/claudeLiveStatus.js";
import {
  gitMissingWorktreeUnmergedCount,
  gitManagedWorktrees,
  gitWorktreeChangeSummary,
  gitWorktreeRemove,
  gitWorktreeUnlock,
  isTailiiSessionLock,
  isTailiiWorktreePath,
  resolveManagedWorktree,
  resolveManagedWorktreeForCwd,
  withWorktreeQueue,
  worktreeAgeMs,
  type GitWorktreeEntry,
  type WorktreeChangeSummary,
} from "../services/gitService.js";
import { engineDiag, type HandlerContext, type WorktreeResponseFields } from "./context.js";

/**
 * 作成から孤児掃除の対象にするまでの猶予。作成（ドラフトの送信）から session_start が届いて会話が
 * 始まるまでの間に、別の接続の一覧要求などで消してしまわないため。起動失敗はこの猶予と関係なく
 * session_start の失敗経路で即座に巻き戻す。
 */
export const ORPHAN_WORKTREE_GRACE_MS = 30 * 60 * 1_000;

/** 起動処理中の cwd（この engine 内）。起動の途中で巻き戻し・掃除の対象にしない。 */
const launchesInFlight = new Map<string, number>();

function normalized(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isSameOrInside(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

/** session_start の起動処理の間だけ cwd を「起動中」として登録する。戻り値で解除する。 */
export function beginWorktreeLaunch(cwd: string): () => void {
  const key = normalized(cwd);
  launchesInFlight.set(key, (launchesInFlight.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (launchesInFlight.get(key) ?? 1) - 1;
    if (remaining <= 0) launchesInFlight.delete(key);
    else launchesInFlight.set(key, remaining);
  };
}

/** cwd（またはその配下）への起動処理がこの engine で進行中か。 */
function launchInFlightUnder(worktreePath: string): boolean {
  const base = normalized(worktreePath);
  return [...launchesInFlight.keys()].some((cwd) => isSameOrInside(cwd, base));
}

/** Tailii の命名（`YYYYMMDD-HHmmss` と連番）。 */
const TAILII_SLUG_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;

/**
 * Tailii が作った worktree か。ロック理由 `tailii-session`、または（変更ありの終了でロックを外した後の）
 * ロック無しで Tailii の命名とブランチ名（`worktree-<slug>` / 旧 `tailii/<slug>`）がそろうもの。
 * Desktop / CLI / 手動で作ったものは false（会話の完全削除の後片付けでは触れない）。
 */
export function isTailiiCreatedWorktree(entry: GitWorktreeEntry): boolean {
  if (isTailiiSessionLock(entry)) return true;
  if (entry.lockReason !== null) return false;
  const slug = path.basename(entry.path);
  return TAILII_SLUG_PATTERN.test(slug) &&
    (entry.branch === `worktree-${slug}` || entry.branch === `tailii/${slug}`);
}

/** worktree を使っているものの一覧（1 回の判定の間だけ使う写し）。 */
export interface WorktreeUsage {
  /** 稼働中のセッション（Tailii のセッション・Tailii 外の claude・起動処理中）が使っているか。 */
  live(worktreePath: string): boolean;
  /** 会話一覧（Claude / Codex）にその cwd の会話があるか。 */
  conversation(worktreePath: string): boolean;
}

/** 使用状況から外すもの（終了処理中の当のセッションと、その会話の claude プロセス）。 */
export interface WorktreeUsageExclusions {
  sessions?: ReadonlySet<string>;
  conversationIds?: ReadonlySet<string>;
}

/**
 * 今の使用状況を集める。一覧が取れないなど判定できなければ null（呼び出し側は何も消さない）。
 */
export async function collectWorktreeUsage(
  ctx: HandlerContext,
  exclude: WorktreeUsageExclusions = {},
): Promise<WorktreeUsage | null> {
  try {
    const liveCwds: string[] = [];
    for (const info of await ctx.sessionManager.list()) {
      if (!info.alive || exclude.sessions?.has(info.name) === true) continue;
      liveCwds.push(ctx.metadataStore?.get(info.name)?.cwd ?? info.cwd);
      if (info.cwd.length > 0) liveCwds.push(info.cwd);
    }
    // Tailii 外（端末・公式アプリ）の claude も数える。終了した直後のセッションの claude は
    // 終了処理中で登録簿に残りうるので、その会話 id のものだけ外す。
    for (const peer of listPeerSessions({ dir: defaultClaudeSessionsDir() })) {
      if (exclude.conversationIds?.has(peer.sessionId) === true) continue;
      liveCwds.push(peer.cwd);
    }
    liveCwds.push(...launchesInFlight.keys());
    const conversationCwds = [
      ...(ctx.claudeSessionStore?.list() ?? []),
      ...(ctx.codexSessionStore?.list(undefined, Number.MAX_SAFE_INTEGER) ?? []),
    ].map((info) => info.cwd);
    const normalizedLive = liveCwds.filter((cwd) => cwd.length > 0).map(normalized);
    const normalizedConversations = conversationCwds.filter((cwd) => cwd.length > 0).map(normalized);
    return {
      live: (worktreePath) => {
        const base = normalized(worktreePath);
        return normalizedLive.some((cwd) => isSameOrInside(cwd, base));
      },
      conversation: (worktreePath) => {
        const base = normalized(worktreePath);
        return normalizedConversations.some((cwd) => isSameOrInside(cwd, base)) ||
          (ctx.claudeSessionStore?.hasTranscriptsAt(worktreePath) ?? false) ||
          (base !== worktreePath && (ctx.claudeSessionStore?.hasTranscriptsAt(base) ?? false));
      },
    };
  } catch (error) {
    engineDiag(`worktree 使用状況を取得できないため片付けを見送り: ${String(error)}`);
    return null;
  }
}

/** 変更件数を応答フィールドへ写す（判定不能なら件数は載せない）。 */
function dirtyFields(worktreePath: string, summary: WorktreeChangeSummary | null): WorktreeResponseFields {
  return {
    worktreePath,
    worktreeDirty: true,
    ...(summary !== null ? {
      worktreeUncommittedCount: summary.uncommitted,
      worktreeUnmergedCommitCount: summary.unmergedCommits,
    } : {}),
  };
}

function isClean(summary: WorktreeChangeSummary | null): boolean {
  return summary !== null && summary.uncommitted === 0 && summary.unmergedCommits === 0;
}

/** 孤児掃除の結果。 */
export interface OrphanSweepResult {
  removed: string[];
}

/**
 * 同じリポジトリの孤児 worktree を掃除する。削除の条件（すべて満たすときだけ）:
 * `.claude/worktrees` 配下の登録済み・ロック理由が `tailii-session` と完全一致・稼働中のセッションが無い・
 * 会話一覧に会話が無い・変更なし・作成から猶予（`graceMs`）を過ぎている。
 */
export async function sweepOrphanWorktrees(
  ctx: HandlerContext,
  repositoryPath: string,
  options: { graceMs?: number; now?: number } = {},
): Promise<OrphanSweepResult> {
  const removed: string[] = [];
  const managed = await gitManagedWorktrees(repositoryPath);
  if (managed === null) return { removed };
  const candidates = managed.worktrees.filter(isTailiiSessionLock);
  if (candidates.length === 0) return { removed };
  const graceMs = options.graceMs ?? ORPHAN_WORKTREE_GRACE_MS;
  await withWorktreeQueue(managed.mainRoot, async () => {
    const usage = await collectWorktreeUsage(ctx);
    if (usage === null) return;
    for (const listed of candidates) {
      // 一覧は列に入る前に取った写しなので、削除の直前に取り直す（ロック理由・フォルダの有無）。
      const current = await resolveManagedWorktree(listed.path);
      // フォルダが消えた登録は自動では消さない（移動しただけかもしれず、未保存の変更を判定できない）。
      if (current === null || current.missing || !isTailiiSessionLock(current.entry)) continue;
      const entry = current.entry;
      const age = worktreeAgeMs(entry.path, options.now);
      if (age === null || age < graceMs) continue;
      if (usage.live(entry.path) || usage.conversation(entry.path)) continue;
      if (!isClean(await gitWorktreeChangeSummary(entry.path))) continue;
      // 写しを取った後に始まった起動・会話（別の engine を含む）を見落とさないよう、消す直前に取り直す。
      if (launchInFlightUnder(entry.path)) continue;
      const fresh = await collectWorktreeUsage(ctx);
      if (fresh === null || fresh.live(entry.path) || fresh.conversation(entry.path)) continue;
      const result = await gitWorktreeRemove(entry.path, false);
      if (result.ok) {
        engineDiag(`孤児 worktree を削除 path=${entry.path}`);
        removed.push(entry.path);
      } else {
        engineDiag(`孤児 worktree の削除失敗 path=${entry.path}: ${result.error ?? "unknown"}`);
      }
    }
  });
  return { removed };
}

/**
 * session_start が失敗したとき、cwd が今作ったばかりの Tailii worktree なら巻き戻す。
 * 条件: 登録済みの worktree そのもの・ロック理由 `tailii-session`・変更なし・稼働中のセッションも会話も無い。
 * 失敗は握りつぶす（起動失敗の応答を妨げない）。
 */
export async function rollbackFailedLaunchWorktree(
  ctx: HandlerContext,
  cwd: string,
  options: { now?: number } = {},
): Promise<boolean> {
  if (!isTailiiWorktreePath(cwd)) return false;
  try {
    const managed = await resolveManagedWorktree(cwd);
    if (managed === null || managed.missing || !isTailiiSessionLock(managed.entry)) return false;
    // 「今作ったばかり」に限る（作業フォルダの履歴から既存の worktree を選んだ起動の失敗では消さない）。
    const age = worktreeAgeMs(managed.entry.path, options.now);
    if (age === null || age >= ORPHAN_WORKTREE_GRACE_MS) return false;
    return await withWorktreeQueue(managed.mainRoot, async () => {
      const usage = await collectWorktreeUsage(ctx);
      if (usage === null || usage.live(managed.entry.path) || usage.conversation(managed.entry.path)) return false;
      if (!isClean(await gitWorktreeChangeSummary(managed.entry.path))) return false;
      const result = await gitWorktreeRemove(managed.entry.path, false);
      engineDiag(`起動失敗の worktree 巻き戻し path=${managed.entry.path} ok=${result.ok}${result.error !== null ? ` error=${result.error}` : ""}`);
      return result.ok;
    });
  } catch (error) {
    engineDiag(`起動失敗の worktree 巻き戻し失敗 path=${cwd}: ${String(error)}`);
    return false;
  }
}

/**
 * 利用者の明示 kill の後片付け。cwd を収める worktree が変更なしなら消し、変更ありはロックを外して
 * 確認用の情報を返す。他の稼働中セッションが同じ worktree を使っていれば触れない。
 */
export async function settleWorktreeAfterKill(
  ctx: HandlerContext,
  killed: { name: string; cwd: string; conversationId: string | null },
  options: { tailiiOnly?: boolean } = {},
): Promise<WorktreeResponseFields | null> {
  if (!isTailiiWorktreePath(killed.cwd)) return null;
  const managed = await resolveManagedWorktreeForCwd(killed.cwd);
  // 既に無い・登録されていない worktree は片付けるものが無い。
  if (managed === null) return null;
  // 会話の完全削除から呼ばれたときは Tailii が作ったものだけ（Desktop / CLI / 手動のものには触れない）。
  if (options.tailiiOnly === true && !isTailiiCreatedWorktree(managed.entry)) return null;
  const worktreePath = managed.entry.path;
  const usage = await collectWorktreeUsage(ctx, {
    sessions: new Set([killed.name]),
    ...(killed.conversationId !== null ? { conversationIds: new Set([killed.conversationId]) } : {}),
  });
  if (usage === null) return { worktreePath };
  if (usage.live(worktreePath)) {
    engineDiag(`session_kill worktree は他のセッションが使用中のため保持 path=${worktreePath}`);
    return null;
  }
  const summary = await gitWorktreeChangeSummary(worktreePath);
  if (isClean(summary)) {
    const removed = await gitWorktreeRemove(worktreePath, false);
    if (removed.ok) return { worktreePath, worktreeRemoved: true };
    engineDiag(`session_kill worktree 削除失敗 path=${worktreePath}: ${removed.error ?? "unknown"}`);
    return { worktreePath };
  }
  engineDiag(`session_kill worktree dirty または clean 判定不能のため保持 path=${worktreePath}`);
  // ロックを外すのは Tailii のロックだけ（Desktop / CLI など他のツールのロックには触れない）。
  if (isTailiiSessionLock(managed.entry)) {
    const unlocked = await gitWorktreeUnlock(worktreePath);
    if (!unlocked.ok) {
      engineDiag(`session_kill worktree unlock 失敗 path=${worktreePath}: ${unlocked.error ?? "unknown"}`);
    }
  }
  return dirtyFields(worktreePath, summary);
}

/**
 * 会話の完全削除の後片付け。会話の cwd を収める worktree を、もう使う会話もセッションも無ければ
 * 変更なしは消し、変更ありは（ロックを外して）確認用の情報を返す。使っているものが残っていれば触れない。
 */
export async function settleWorktreeAfterConversationDelete(
  ctx: HandlerContext,
  cwd: string,
): Promise<WorktreeResponseFields | null> {
  if (!isTailiiWorktreePath(cwd)) return null;
  const managed = await resolveManagedWorktreeForCwd(cwd);
  // Tailii が作ったものだけ片付ける（Desktop / CLI / 手動の worktree は消さず、ロックも外さない）。
  if (managed === null || !isTailiiCreatedWorktree(managed.entry)) return null;
  const worktreePath = managed.entry.path;
  const usage = await collectWorktreeUsage(ctx);
  if (usage === null || usage.live(worktreePath) || usage.conversation(worktreePath)) {
    engineDiag(`conversation_delete worktree はまだ使われている（または判定不能）ため保持 path=${worktreePath}`);
    return null;
  }
  const summary = await gitWorktreeChangeSummary(worktreePath);
  if (isClean(summary)) {
    const removed = await gitWorktreeRemove(worktreePath, false);
    if (removed.ok) return { worktreePath, worktreeRemoved: true };
    engineDiag(`conversation_delete worktree 削除失敗 path=${worktreePath}: ${removed.error ?? "unknown"}`);
    return null;
  }
  if (isTailiiSessionLock(managed.entry)) {
    const unlocked = await gitWorktreeUnlock(worktreePath);
    if (!unlocked.ok) {
      engineDiag(`conversation_delete worktree unlock 失敗 path=${worktreePath}: ${unlocked.error ?? "unknown"}`);
    }
  }
  return dirtyFields(worktreePath, summary);
}

/** Git 画面のワークツリー一覧の 1 件。 */
export interface WorktreeListItem {
  path: string;
  branch: string | null;
  hasChanges: boolean;
  inUse: boolean;
  /** 登録は残っているがフォルダが見つからない（自動では消さない。手動削除のみ）。 */
  missing?: boolean;
  uncommittedCount?: number;
  unmergedCommitCount?: number;
}

/** Git 画面のワークツリー一覧（先に孤児を掃除してから列挙する）。リポジトリでなければ null。 */
export async function listWorktreesForApp(
  ctx: HandlerContext,
  repositoryPath: string,
): Promise<{ worktrees: WorktreeListItem[]; removedPaths: string[] } | null> {
  const swept = await sweepOrphanWorktrees(ctx, repositoryPath);
  const managed = await gitManagedWorktrees(repositoryPath);
  if (managed === null) return null;
  const usage = await collectWorktreeUsage(ctx);
  const worktrees: WorktreeListItem[] = [];
  for (const entry of managed.worktrees) {
    const missing = !fs.existsSync(entry.path);
    if (missing) {
      // 未保存の変更は判定できないので「変更あり」（二段階確認）。コミットは本体のブランチで数える
      // （削除してもどこにも無いコミットを持つブランチは残すが、確認文で知らせる）。
      const unmerged = await gitMissingWorktreeUnmergedCount(managed.mainRoot, entry);
      worktrees.push({
        path: entry.path,
        branch: entry.branch,
        missing: true,
        hasChanges: true,
        inUse: usage === null || usage.live(entry.path) || usage.conversation(entry.path),
        ...(unmerged !== null ? { unmergedCommitCount: unmerged } : {}),
      });
      continue;
    }
    const summary = await gitWorktreeChangeSummary(entry.path);
    worktrees.push({
      path: entry.path,
      branch: entry.branch,
      // 判定できないものは「変更あり」として見せる（削除に二段階確認を求める側へ倒す）。
      hasChanges: !isClean(summary),
      // 使用状況が取れなければ「使用中」として見せる。
      inUse: usage === null || usage.live(entry.path) || usage.conversation(entry.path),
      ...(summary !== null ? {
        uncommittedCount: summary.uncommitted,
        unmergedCommitCount: summary.unmergedCommits,
      } : {}),
    });
  }
  return { worktrees, removedPaths: swept.removed };
}
