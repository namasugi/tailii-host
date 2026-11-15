// workdir/apiAgent.ts
// API 作業（Agent SDK で 1 ターンずつ動かす端末なしの Claude 会話）の作業フォルダの変更（session-workdir-change）の
// 差し込み口。
//
// 呼ばれる条件: 会話の記録が `executionRoute === "api"` で、枠の検証（実在するフォルダの実体パス・今と違う・hub の
// 処理中でも設問待ちでもない・同じ会話の変更が進行中でない）を通ったとき。枠は成功（`{ ok: true, cwd }`）の後に
// 記録の cwd を書き換え、hub へ知らせて購読者へ `pc:cwd` を配る。ここでは記録の書き換えと `pc:cwd` の配信をしない
// （types.ts の取り決め）。
//
// 作り: ターンの所有者は hub の ApiAgentManager なので、移す処理は hub へ頼む（`api_agent_relocate`）。hub は 1 回の
// 処理の中で、ターンの実行中・始める途中・送信待ち（API 作業の持ち越しと hub の chat queue）・設問や承認の保留・会話を
// 掴んでいる claude が無いことを確かめ、会話ログ（と付帯フォルダ）を移動先の slug へ移して `relocated` 行を書き足し
// （`moveClaudeTranscript`。Claude の `/cd` と同じ形）、API 作業が持つ cwd と開いている記録（`~/.tailii/api-agent/
// sessions`）を新しい値にする。次のターンの作業プロセスは新しいフォルダで `resume` する（会話 id は変わらない）。
// まだ 1 回も発話していない会話は値を変えるだけ（会話ログは最初のターンで新しいフォルダに作られる）。
//
// 断るもの:
//   - Claude 自身がワークツリーに入っている会話（会話ログの `worktree-state`）。Claude Code の resume が毎回ワークツリーへ
//     入り直すので、会話ログだけを移しても変更が効かない（apiAgent/transcriptPlacement.ts）。
//   - 移動先の slug に同じ会話の記録が既にある（conflict）。

import { randomUUID } from "node:crypto";
import type { HubServerMessage } from "../hub/hubProtocol.js";
import { WORKDIR_CHANGE_MESSAGES, workdirChangeFailure, type WorkdirChangeAdapter } from "./types.js";

type RelocateResult = Extract<HubServerMessage, { type: "api_agent_relocate_result" }>;

/** hub の処理は同期（会話ログの rename と記録の書き込み）なので短く待つ。 */
const HUB_TIMEOUT_MS = 5_000;

export const changeApiAgentWorkdir: WorkdirChangeAdapter = async (request) => {
  const { session, meta, cwd, ctx } = request;
  const conversationId = meta.providerSessionId ?? meta.claudeSessionId;
  if (conversationId === undefined || conversationId.length === 0) {
    return workdirChangeFailure("failed", "この会話の記録が古いため変更できません。開き直してからお試しください。");
  }
  const id = randomUUID();
  let result: RelocateResult;
  try {
    result = await ctx.hubRpc<RelocateResult>(
      { type: "api_agent_relocate", id, session, conversationId, fromCwd: meta.cwd, cwd }, id, HUB_TIMEOUT_MS,
    );
  } catch {
    return workdirChangeFailure("failed", WORKDIR_CHANGE_MESSAGES.failed);
  }
  if (result.type !== "api_agent_relocate_result") return workdirChangeFailure("failed", WORKDIR_CHANGE_MESSAGES.failed);
  switch (result.status) {
    case "ok":
      return { ok: true, cwd: result.cwd ?? cwd };
    case "busy":
      return workdirChangeFailure("busy", WORKDIR_CHANGE_MESSAGES.busy);
    case "worktree":
      return workdirChangeFailure("failed",
        "Claude がワークツリーで作業中のため変更できません。Claude にワークツリーから出てもらってからお試しください。");
    case "conflict":
      return workdirChangeFailure("failed", "移動先のフォルダに同じ会話の記録が既にあるため変更できません。");
    default:
      return workdirChangeFailure("failed", "会話の記録を移せませんでした。");
  }
};
