// プロンプト展開系スラッシュコマンド（組み込みの `/doctor` 等）の展開済みプロンプト行の検出。
// 利用者が打ったのはコマンド名だけで、展開された本文は内部コンテキスト（CLI も表示しない）なので、
// 会話画面・一覧プレビューへ転送しない（スキル本文の注入 `skillInjection.ts` と同じ扱い）。
//
// 実測 claude 2.1.289（`/doctor`）: 起動行 → 展開行の 2 行で記録される。
//   { type: "user", message: { content: "<command-message>doctor</command-message>\n<command-name>/doctor</command-name>" }, uuid: A }
//   { type: "user", isMeta: true, turnCompanion: true, parentUuid: A, message: { content: [{ type: "text", text: "# Claude Code Doctor\n…" }] } }
// 展開行は本文に目印が無い（コマンドごとに違う Markdown）ので、構造（isMeta + turnCompanion +
// parentUuid が直前の起動行）で判定する。

/** プロンプト展開系スラッシュコマンドの起動行か（`<command-message>` 先頭の user 行）。 */
export function isPromptCommandText(text: string): boolean {
  return text.trimStart().startsWith("<command-message>");
}

/**
 * ターンの同伴行（`isMeta` + `turnCompanion`）か。利用者の発話ではなく harness が同じターンに添える
 * 行（画像の寸法注記・スキル本文・展開済みプロンプト・継続の促し）で、一覧のタイトル / プレビューには
 * 向かない。会話画面での扱いは行の種類ごとに違う（展開済みプロンプトだけ `isCommandExpansionRecord`）。
 */
export function isTurnCompanionRecord(rec: Record<string, unknown>): boolean {
  return rec["isMeta"] === true && rec["turnCompanion"] === true;
}

/**
 * 直前の起動行（uuid = `promptCommandUuid`）に続く展開済みプロンプト行か。
 * 起動行を見ていない（null）なら常に偽（継続の促し等、他の同伴行を巻き込まない）。
 */
export function isCommandExpansionRecord(rec: Record<string, unknown>, promptCommandUuid: string | null): boolean {
  if (promptCommandUuid === null || !isTurnCompanionRecord(rec)) return false;
  return rec["parentUuid"] === promptCommandUuid;
}
