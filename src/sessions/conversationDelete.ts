// conversationDelete.ts
// 会話をホストから完全に削除する（conversation-delete）。engine の handler から依存を注入して呼ぶ。
//
// 動いているプロセスが残ったまま消すと、claude は transcript へ追記し直して会話が蘇る。そのため:
//   ① Claude は登録簿（`~/.claude/sessions/<pid>.json`）で会話を掴んでいる生存プロセスを列挙し、
//      それぞれを Tailii のセッションへ照合する（tmux は記録の `tmux` 欄、herdr は pane の前面 pid）。
//      照合できないプロセス（Mac の端末・公式アプリ・判別不能）が 1 つでもあれば、**何も終了せずに**
//      断る（Tailii 側だけ落として削除できない、という半端な結果を作らない）。
//   ② 会話を収容中の Tailii セッションを**すべて**終了する（同一会話の第 2 インスタンスを含む）。
//   ③ Claude は照合したプロセスが pid（+ 起動時刻）で死んだのを確かめてから消す。登録簿ファイルの
//      有無では判定しない（後片付けの順序次第で、消えた後に最後の追記が来うる）。
// Codex は Tailii 外の実行を検出する手段が無い（端末の `codex resume` は共有 App Server を使わない）
// ため、Tailii のセッションを終了してから App Server の `thread/delete` で消す（非対称は仕様）。

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionInfo } from "../protocol.js";
import { claudeProcessAlive } from "./claudeLiveStatus.js";
import { isConversationId } from "./claudeSessionStore.js";

/** 利用者へ返す理由（iOS のアラート本文。backend 名や生の例外は出さない）。 */
export const CONVERSATION_DELETE_MESSAGES = {
  invalidId: "会話 id が不正です。",
  claudeUnavailable: "このホストでは Claude の会話を扱えません。",
  codexUnavailable: "Codex を使えないため削除できません。",
  killFailed: "実行中のセッションを終了できなかったため削除できませんでした。",
  exitTimeout: "実行中のセッションの終了を待ちきれなかったため削除できませんでした。少し待ってから再度お試しください。",
  failed: "会話を削除できませんでした。",
} as const;

export function externalHolderMessage(names: readonly string[]): string {
  const label = names.length > 0 ? `（${names.join(", ")}）` : "";
  return `Tailii 以外（ターミナルや公式アプリ）でこの会話が実行中のため削除できません${label}。そちらを終了してから削除してください。`;
}

export interface ConversationDeleteDeps {
  sessionId: string;
  agent: "claude" | "codex";
  listSessions: () => Promise<SessionInfo[]>;
  killSession: (name: string) => Promise<unknown>;
  /** herdr pane の前面プロセスの pid 群（取得不能は null）。 */
  paneProcessIds: (name: string) => Promise<readonly number[] | null>;
  /** Claude の登録簿ディレクトリ（`CLAUDE_CONFIG_DIR` 追随は呼び出し側で解決済み）。 */
  claudeSessionsDir: string;
  deleteClaude: ((sessionId: string) => string[]) | null;
  deleteCodex: ((threadId: string) => Promise<void>) | null;
  log: (message: string) => void;
  /** 登録簿の pid 生存判定（既定は kill 0）。テスト注入用。 */
  peerPidAlive?: (pid: number) => boolean;
  /** 終了待ちの判定（既定は kill 0 + 起動時刻照合）。テスト注入用。 */
  processAlive?: (pid: number, procStart: string | null) => Promise<boolean>;
  exitWaitMs?: number;
  exitPollMs?: number;
}

interface ClaudeHolderProcess {
  pid: number;
  name: string;
  tmux: string | null;
  procStart: string | null;
}

/** 成功（対象が既に無い場合を含む）は null、拒否・失敗は利用者向けの理由。想定外の例外は throw する。 */
export async function deleteConversation(deps: ConversationDeleteDeps): Promise<string | null> {
  const { sessionId, agent } = deps;
  if (!isConversationId(sessionId)) return CONVERSATION_DELETE_MESSAGES.invalidId;
  if (agent === "claude" && deps.deleteClaude === null) return CONVERSATION_DELETE_MESSAGES.claudeUnavailable;
  if (agent === "codex" && deps.deleteCodex === null) return CONVERSATION_DELETE_MESSAGES.codexUnavailable;

  const holders = (await deps.listSessions()).filter((info) => holdsConversation(info, sessionId, agent));

  let tailiiProcesses: ClaudeHolderProcess[] = [];
  if (agent === "claude") {
    const processes = claudeHolderProcesses(deps.claudeSessionsDir, sessionId, deps.peerPidAlive ?? pidAlive);
    const external: ClaudeHolderProcess[] = [];
    const paneCache = new Map<string, readonly number[] | null>();
    for (const proc of processes) {
      if (await ownedByTailii(proc, holders, deps, paneCache)) tailiiProcesses.push(proc);
      else external.push(proc);
    }
    if (external.length > 0) {
      deps.log(`conversation_delete 拒否: Tailii 外の claude pid=${external.map((p) => p.pid).join(",")}`);
      return externalHolderMessage(external.map((p) => p.name));
    }
  }

  for (const holder of holders) {
    deps.log(`conversation_delete kill session=${holder.name}`);
    try {
      await deps.killSession(holder.name);
    } catch (error) {
      // list と kill の間に消えた（reaper・同時の終了操作・自然終了）なら目的は達している。
      deps.log(`conversation_delete kill 失敗 session=${holder.name}: ${String(error)}`);
      const stillAlive = (await deps.listSessions()).some((info) => info.name === holder.name && info.alive);
      if (stillAlive) return CONVERSATION_DELETE_MESSAGES.killFailed;
    }
  }

  if (tailiiProcesses.length > 0) {
    const alive = deps.processAlive ?? claudeProcessAlive;
    const deadline = Date.now() + (deps.exitWaitMs ?? 5_000);
    for (;;) {
      const remaining: ClaudeHolderProcess[] = [];
      for (const proc of tailiiProcesses) {
        if (await alive(proc.pid, proc.procStart)) remaining.push(proc);
      }
      tailiiProcesses = remaining;
      if (tailiiProcesses.length === 0) break;
      if (Date.now() >= deadline) {
        deps.log(`conversation_delete 終了待ち超過 pid=${tailiiProcesses.map((p) => p.pid).join(",")}`);
        return CONVERSATION_DELETE_MESSAGES.exitTimeout;
      }
      await new Promise((resolve) => setTimeout(resolve, deps.exitPollMs ?? 200));
    }
  }

  if (agent === "claude") {
    const removed = deps.deleteClaude!(sessionId);
    deps.log(`conversation_delete claude removed=${removed.length}`);
  } else {
    await deps.deleteCodex!(sessionId);
  }
  return null;
}

function holdsConversation(info: SessionInfo, sessionId: string, agent: "claude" | "codex"): boolean {
  return info.alive
    && (info.providerSessionId ?? info.claudeSessionId ?? null) === sessionId
    && (info.agent ?? "claude") === agent;
}

/**
 * 登録簿のうち、この会話を掴んでいる生存プロセス。削除の安全判定なので必須は pid と sessionId だけ
 * （`listPeerSessions` は name / cwd も必須で、欠けた旧形式の記録を黙って読み飛ばす）。
 */
function claudeHolderProcesses(
  dir: string,
  sessionId: string,
  isPidAlive: (pid: number) => boolean,
): ClaudeHolderProcess[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const result: ClaudeHolderProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const pid = record["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (record["sessionId"] !== sessionId || !isPidAlive(pid)) continue;
    result.push({
      pid,
      name: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : `pid ${pid}`,
      tmux: typeof record["tmux"] === "string" ? record["tmux"] : null,
      procStart: typeof record["procStart"] === "string" ? record["procStart"] : null,
    });
  }
  return result;
}

/** kill 0 で生存判定する（EPERM = 存在するが権限なし = 生存）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Tailii のセッション内の claude か（tmux 欄 → herdr pane の前面 pid の順。判別不能は false）。 */
async function ownedByTailii(
  proc: ClaudeHolderProcess,
  holders: readonly SessionInfo[],
  deps: ConversationDeleteDeps,
  paneCache: Map<string, readonly number[] | null>,
): Promise<boolean> {
  if (proc.tmux !== null && holders.some((holder) => proc.tmux!.startsWith(`${holder.name}:`))) {
    return true;
  }
  for (const holder of holders) {
    if (holder.backend !== "herdr") continue;
    if (!paneCache.has(holder.name)) paneCache.set(holder.name, await deps.paneProcessIds(holder.name));
    if (paneCache.get(holder.name)?.includes(proc.pid) === true) return true;
  }
  return false;
}
