// スキル実行時に Claude Code が transcript へ注入する展開済み SKILL.md 本文の検出。
// ユーザー発話ではなく内部コンテキストなので、会話画面・一覧プレビューへ転送しない。

/**
 * user 行がスキル本文の注入か（claude 2.1.220 実測の 2 形式）。
 *
 * - スラッシュコマンド起動（`/name`）: "Base directory for this skill:" 前置の
 *   isMeta 行として記録される。
 * - Skill ツール起動（Claude 自身の呼び出し）: 前置なしの本文が
 *   isMeta + sourceToolUseID 付き user 行として記録される。
 */
export function isInjectedSkillContent(rec: Record<string, unknown>, text: string): boolean {
  if (text.trimStart().startsWith("Base directory for this skill:")) return true;
  return rec["isMeta"] === true && typeof rec["sourceToolUseID"] === "string";
}
