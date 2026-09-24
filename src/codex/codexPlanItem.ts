// codexPlanItem.ts
// tailii (TS host) — Codex プランモード（collaboration mode = plan）の提案プランを chat へ写像する。
//
// プランモードの turn は最後に `<proposed_plan>…</proposed_plan>` を出し、App Server はそれを本文とは
// 別の item として配る（0.153.4 実測, codex-plan-mode）:
//   - live: `item/started` → `item/plan/delta`（断片）→ `item/completed { item: { type: "plan", id, text } }`
//     （id は `<turnId>-plan`。同じ turn の agentMessage としては配られない）
//   - rollout: `event_msg item_completed { item: { type: "Plan", id, text } }` と、mirror の
//     `response_item message`（role assistant, phase final_answer, 本文はタグ付きの `<proposed_plan>` ブロック）
// 両系統から同じ streamId / 本文の assistant chat_output を作り、Session Hub の occurrence 照合と iOS の
// 冪等化を成立させる。iOS は streamId の接頭辞でプランカード（見出し + 「このプランで実装」）として描く。

import { PROTOCOL_V1, type ControlMessage } from "../protocol.js";

/** プラン item の chat_output streamId 接頭辞（iOS `ChatLogModel.codexPlanStreamPrefix` と対）。 */
export const PLAN_STREAM_PREFIX = "codex-plan-";

/** App Server / rollout の plan item を assistant chat_output へ。本文が空なら null。 */
export function codexPlanChatOutput(id: string, text: string): ControlMessage | null {
  const body = normalizePlanText(text);
  if (id.length === 0 || body.length === 0) return null;
  return {
    type: "chat_output",
    v: PROTOCOL_V1,
    streamId: `${PLAN_STREAM_PREFIX}${id}`,
    role: "assistant",
    text: body,
    eof: true,
  };
}

/**
 * rollout の assistant mirror がプランモードの最終応答（`<proposed_plan>` ブロックだけ）か。
 * live はこの本文を agentMessage として配らないため、rollout 側も本文バブルにせず plan item だけを出す。
 */
export function isProposedPlanBlock(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<proposed_plan>") && trimmed.endsWith("</proposed_plan>");
}

const PROPOSED_PLAN_BLOCK = /<proposed_plan>[\s\S]*?<\/proposed_plan>/gu;

/** 本文に `<proposed_plan>` ブロックを含むか（前置き文付きの最終応答も対象）。 */
export function containsProposedPlanBlock(text: string): boolean {
  return /<proposed_plan>[\s\S]*?<\/proposed_plan>/u.test(text);
}

/** `<proposed_plan>` ブロックを本文から外した残り（前後の空白を落とす）。ブロックだけなら空文字。 */
export function stripProposedPlanBlocks(text: string): string {
  return text.replace(PROPOSED_PLAN_BLOCK, "").trim();
}

/** 末尾の改行だけを落とす（live / rollout どちらの本文も末尾 `\n` 付きで届く）。先頭や本文中は保つ。 */
function normalizePlanText(text: string): string {
  return text.replace(/\s+$/u, "");
}
