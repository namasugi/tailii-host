// ローカルコマンドの出力を「モデルに読ませるための写し」として Claude Code が transcript へ
// 書く user 行の検出。ユーザー発話ではなく、同じ内容は直前の端末向け出力
// （`<local-command-stdout>` の system 行）が既に伝えているので、会話画面・一覧プレビュー・
// 検索へ転送せず、ターン境界の判定でも発話に数えない（isMeta の注記として扱う）。

/**
 * `/context` の出力の写し（claude 2.1.284 実測）。
 *
 * `/context` は端末向けの ANSI 版を `system/local_command` の `<local-command-stdout>` に書き、
 * 続けて同じ内容の Markdown 版（`## Context Usage` から始まる表。20KB を超えることもある）を
 * `isMeta: true` の user 行（parentUuid = 端末向け出力の行）に書く。実機 2026-09-30: 後者が
 * 利用者の発話バブルで表示されていた。isMeta は一律に注記ではない（cross-session の起こし等は
 * 本物のターン開始）ため、本文の書き出しまで一致したものだけを写しとみなす。
 */
const MODEL_COPY_BODY_PREFIXES = ["## Context Usage\n"];

/** user 行がローカルコマンド出力のモデル向けの写しか。 */
export function isLocalCommandModelCopyRecord(rec: Record<string, unknown>): boolean {
  if (rec["type"] !== "user" || rec["isMeta"] !== true) return false;
  // スキル本文の注入（sourceToolUseID 付き）は別の経路（Skill カードへ後付け）で扱う。
  if (typeof rec["sourceToolUseID"] === "string") return false;
  const message = rec["message"];
  if (typeof message !== "object" || message === null) return false;
  const content = (message as Record<string, unknown>)["content"];
  let body: string;
  if (typeof content === "string") {
    body = content;
  } else if (Array.isArray(content)) {
    const first = content.find((block) =>
      typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text");
    const text = first === undefined ? undefined : (first as Record<string, unknown>)["text"];
    if (typeof text !== "string") return false;
    body = text;
  } else {
    return false;
  }
  const head = body.replaceAll("\r", "").trimStart();
  return MODEL_COPY_BODY_PREFIXES.some((prefix) => head.startsWith(prefix));
}
