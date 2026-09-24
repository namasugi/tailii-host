// 会話の圧縮（/compact・自動圧縮）で Claude Code が transcript へ書く要約行の検出。
// ユーザー発話ではなく Claude 側の文脈（次の応答が参照する記憶）なので、会話画面・一覧
// プレビューへ転送せず、ターン境界の判定でも発話に数えない。圧縮の事実は直前の
// `system/compact_boundary` 行が system 注記として伝える（shared/systemNotice.ts）。

/**
 * user 行が圧縮の要約か（claude 2.1.269 / 2.1.281 実測）。
 *
 * `compact_boundary` の直後（2.1.281 は attachment 数行を挟む）に `isCompactSummary: true` +
 * `isVisibleInTranscriptOnly: true` の user 行として、本文「This session is being continued from
 * a previous conversation that ran out of context. …」で書かれる。本文ではなく構造フラグで判定する
 * （文言は変わり得る）。実機 2026-09-24: 自動圧縮の直後に要約全文が利用者の発話バブルで出ていた。
 */
export function isCompactSummaryRecord(rec: Record<string, unknown>): boolean {
  return rec["type"] === "user" && rec["isCompactSummary"] === true;
}
