// remotePendingQuestions.ts
// tailii (TS host) — 設問を一覧の「回答待ち」ピル（remote_pending kind=question）へ写す共通処理。

import type { ControlMessage, QuestionPromptQuestion } from "../protocol.js";
import { isNonBlockingQuestionId } from "../codex/codexAsyncQuestion.js";
import type { PendingQuestionSnapshotEntry } from "../hub/hubProtocol.js";

/** 一覧のピル・バナーに出す設問の要約（1 問目の本文 → 見出し → 既定の文言）。 */
export function questionPendingSummary(questions: readonly QuestionPromptQuestion[]): string {
  const first = questions[0];
  return first?.question || first?.header || "Question prompt";
}

/**
 * Hub の未回答の設問 snapshot を、iOS の `remote_pending_snapshot`（kind=question）へ写す
 * （pending-question-snapshot）。turn を止めない設問（Codex の非同期質問）は「あなたの番」にしないので
 * 載せない（`remote_pending` へ変換するときと同じ規則）。
 */
export function remotePendingQuestionSnapshot(
  entries: readonly PendingQuestionSnapshotEntry[],
  v: number,
): Extract<ControlMessage, { type: "remote_pending_snapshot" }> {
  return {
    type: "remote_pending_snapshot",
    v,
    kind: "question",
    items: entries
      .filter((entry) => !isNonBlockingQuestionId(entry.id))
      .map((entry) => ({ id: entry.id, session: entry.session, summary: questionPendingSummary(entry.questions) })),
  };
}
