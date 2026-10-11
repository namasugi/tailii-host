// codex/codexMessagePhase.ts — assistant 本文の `phase` のうち会話に出す区分
//
// live（App Server の agentMessage）・履歴（rollout）・会話一覧の要約がこの判定を使う。
// 区分が増えたときに経路ごとの取りこぼしが出ないよう、許可する値はここだけに置く。

/** 会話に出す `phase`。欠落は「区分なし」（旧 rollout）。 */
export type VisibleCodexMessagePhase = "commentary" | "partial_answer" | "final_answer" | undefined;

/**
 * Codex の assistant 本文に付く `phase` が会話に出す区分か。
 * - `commentary`: 途中経過。
 * - `partial_answer`: 後ろに出力やツール実行が続く回答の断片（Codex 0.162+）。turn は終わっていない。
 * - `final_answer`: 最終回答。
 * - 欠落: 区分なし（旧 rollout）。本文として出す。
 * それ以外（`analysis` などの内部区分・未知の値・明示の null）は出さない。
 *
 * 明示の `null` は従来どおり出さない: 手元の rollout で `phase: null` を持つのは外部エージェントから
 * 取り込んだ会話（0.138 系）だけで、本文の大半が `[external_agent_tool_call: …]` などのツール転写。
 * 出すと転写がそのまま吹き出しになり、履歴の連番 streamId もずれて端末キャッシュと食い違う。
 * 会話一覧の要約（`codexSessionStore`）だけは従来から null も本文として読む（そちらで足す）。
 */
export function isVisibleCodexMessagePhase(phase: unknown): phase is VisibleCodexMessagePhase {
  return phase === undefined ||
    phase === "commentary" || phase === "partial_answer" || phase === "final_answer";
}
