// codexAsyncQuestion.ts
// tailii (TS host) — Codex の非同期質問（`request_user_input_async`, codex-async-question）の純ロジック
// （TESTABLE）。
//
// モデルは作業を止めずに利用者へ質問を投げられる。0.159.1 以降は既定モデル（gpt-6.1-sol）と
// gpt-6-sol / gpt-6-luna のカタログが `experimental_supported_tools` にこのツールを持つため、機能フラグ
// 無しで普通に出る（ツールの登録はカタログだけで決まる。codex-rs core/src/tools/spec_plan.rs）。
//
// 形（0.160 で確認）:
// - App Server: `item/completed` の `agentMessage` に `delivery: "async"` と
//   `questions: [{ title, options: string[] | null }]`。item id はツール呼び出しの call_id。
//   本文 `text` は「質問文 + `- 選択肢` 行」を空行で繋いだもの（通常の最終回答と同じ表示で読める）。
// - rollout: `event_msg` / `item_completed` の `item.type === "AgentMessage"` に同じ `delivery` / `questions`、
//   本文は `content: [{ type: "Text", text }]`。`event_msg/agent_message` には**出ない**。
//
// 回答（TUI / デスクトップと同じ形。codex-rs context-fragments/src/answered_question.rs）は、通常の
// ユーザー入力として送る封筒:
//   <send_user_message_question_reply>
//   [{"answer":"…","question":"…","questionItemId":"[\"request_user_input_async\",\"<itemId>\",<index>]"}]
//   </send_user_message_question_reply>
// 質問文は 512 バイトで切り詰めて改行を空白へ。質問 id が 512 バイトを超えるときは封筒を使わず
// `> 質問\n\n回答` の平文にする（同ファイルの旧形式）。TUI はターンが終わると未回答の質問を締め切る。

export interface CodexAsyncQuestion {
  /** item の `questions` 配列での元の位置（質問 id の番号。不正な要素を飛ばしても TUI とずらさない）。 */
  index: number;
  title: string;
  /** 選択肢（推奨が先頭）。null / 空は自由記述だけの質問。 */
  options: string[];
}

/**
 * 非同期質問を iOS へ出す設問 id の接頭辞。**この接頭辞の設問は turn を止めない**という取り決めで、
 * iOS（`ActiveQuestionPrompt.isNonBlocking`）はこれを見て処理中表示・停止ボタンを保つ。設問 id は
 * hub の永続化・hub_state の再配信・一覧バッジのどの経路でもそのまま運ばれるので、フィールドを
 * 足すより付け漏れが起きない。
 */
export const CODEX_ASYNC_QUESTION_ID_PREFIX = "codex-async:";

/** turn を止めない設問（Codex の非同期質問）の id か。止まらない設問を特別扱いする箇所は必ずこれで判定する。 */
export function isNonBlockingQuestionId(id: string): boolean {
  return id.startsWith(CODEX_ASYNC_QUESTION_ID_PREFIX);
}

export interface CodexAsyncQuestionItem {
  itemId: string;
  questions: CodexAsyncQuestion[];
}

export interface CodexAsyncQuestionReply {
  itemId: string;
  index: number;
  title: string;
  answer: string;
}

const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";
/** TUI が質問文・質問 id に課す上限（バイト）。 */
const REPLY_FIELD_LIMIT_BYTES = 512;
/** TUI が 1 問あたりに採る選択肢の上限と、1 選択肢の上限（バイト）。 */
const OPTION_LIMIT = 32;
const OPTION_LIMIT_BYTES = 512;

/**
 * App Server（`agentMessage`）/ rollout（`AgentMessage`）の item から非同期質問を取り出す。
 * 非同期でない・質問が無い・id が無いものは null。
 */
export function codexAsyncQuestionItem(item: Record<string, unknown>): CodexAsyncQuestionItem | null {
  const type = item["type"];
  if (type !== "agentMessage" && type !== "AgentMessage") return null;
  if (item["delivery"] !== "async") return null;
  const itemId = item["id"];
  if (typeof itemId !== "string" || itemId.length === 0) return null;
  const raw = item["questions"];
  if (!Array.isArray(raw)) return null;
  const questions = raw.flatMap((entry, index): CodexAsyncQuestion[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const title = record["title"];
    if (typeof title !== "string" || title.trim().length === 0) return [];
    // TUI と同じ絞り込み（先頭 32 件 → 512 バイト以下）。文字列でない要素だけ落とす。
    const options = Array.isArray(record["options"])
      ? record["options"]
        .slice(0, OPTION_LIMIT)
        .filter((option): option is string => typeof option === "string")
        .filter((option) => Buffer.byteLength(option, "utf8") <= OPTION_LIMIT_BYTES)
      : [];
    return [{ index, title, options }];
  });
  return questions.length > 0 ? { itemId, questions } : null;
}

/** 質問 1 件の識別子（デスクトップの `JSON.stringify([tool name, item id, question index])` と同値）。 */
export function codexAsyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify(["request_user_input_async", itemId, index]);
}

/**
 * 回答をユーザー入力の本文にする。複数の回答は 1 つの封筒（配列）にまとめる（TUI の読み取りは
 * 配列 / 単体の両方を受ける）。封筒に載せられない回答（質問 id が長すぎる）は平文で後ろへ繋ぐ。
 */
export function codexAsyncQuestionReplyText(replies: CodexAsyncQuestionReply[]): string {
  const enveloped: Record<string, string>[] = [];
  const plain: string[] = [];
  for (const reply of replies) {
    const question = truncateUtf8(reply.title, REPLY_FIELD_LIMIT_BYTES).replace(/[\r\n]/g, " ");
    const questionId = codexAsyncQuestionId(reply.itemId, reply.index);
    if (Buffer.byteLength(questionId, "utf8") > REPLY_FIELD_LIMIT_BYTES) {
      plain.push(`> ${question}\n\n${reply.answer}`);
      continue;
    }
    // キー順は TUI（serde_json の json! = 辞書順）に合わせる。
    enveloped.push({ answer: reply.answer, question, questionItemId: questionId });
  }
  const parts: string[] = [];
  if (enveloped.length > 0) parts.push(`${REPLY_OPEN}\n${JSON.stringify(enveloped)}\n${REPLY_CLOSE}`);
  parts.push(...plain);
  return parts.join("\n\n");
}

/**
 * 回答の封筒を会話表示用の `> 質問\n\n回答` へ写す（TUI の `display_text` と同じ規則）。
 * 封筒でない本文・壊れた封筒は null（呼び出し側は元の本文を出す）。
 */
export function codexAsyncQuestionReplyDisplayText(text: string): string | null {
  const entries = parseReplyEnvelope(text);
  if (entries === null) return null;
  return entries.map(({ question, answer }) => `> ${question}\n\n${answer}`).join("\n\n");
}

/** 封筒の中身（TUI の `parse` と同じ受理条件）。封筒でない・壊れている・空は null。 */
function parseReplyEnvelope(
  text: string,
): { questionItemId: string; question: string; answer: string }[] | null {
  let body = text.trim();
  // IDE 文脈の前置きが付いた入力（TUI の parse と同じ）。
  if (body.startsWith("# Context from my IDE setup:\n")) {
    const marker = "\n## My request for Codex:\n";
    const at = body.lastIndexOf(marker);
    if (at < 0) return null;
    body = body.slice(at + marker.length).trim();
  }
  if (!body.startsWith(REPLY_OPEN) || !body.endsWith(REPLY_CLOSE)) return null;
  const json = body.slice(REPLY_OPEN.length, body.length - REPLY_CLOSE.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const result: { questionItemId: string; question: string; answer: string }[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const questionItemId = record["questionItemId"];
    const question = record["question"];
    const answer = record["answer"];
    if (typeof questionItemId !== "string" || typeof question !== "string" || typeof answer !== "string") {
      return null;
    }
    result.push({ questionItemId, question, answer });
  }
  return result.length > 0 ? result : null;
}

/** 回答済みの質問の指し先。`index` が null は item 全体（旧デスクトップは item id だけで指す）。 */
export interface CodexAsyncQuestionTarget {
  itemId: string;
  index: number | null;
}

/**
 * ユーザー入力が回答の封筒なら、回答済みの質問の指し先を返す（他クライアントの回答で Tailii の設問を
 * 閉じる・開き直しで回答済みを除く。TUI の `resolve_answers` と同じ照合）。封筒でなければ null。
 */
export function codexAsyncQuestionReplyTargets(text: string): CodexAsyncQuestionTarget[] | null {
  const entries = parseReplyEnvelope(text);
  if (entries === null) return null;
  return entries.map(({ questionItemId }) => {
    try {
      const parsed: unknown = JSON.parse(questionItemId);
      if (Array.isArray(parsed) && parsed.length === 3 && parsed[0] === "request_user_input_async" &&
        typeof parsed[1] === "string" && Number.isInteger(parsed[2])) {
        return { itemId: parsed[1], index: parsed[2] as number };
      }
    } catch {
      // JSON でない id は item id そのもの（旧形式）。
    }
    return { itemId: questionItemId, index: null };
  });
}

/** UTF-8 で `limit` バイト以内に収まる最長の前置（文字の途中で切らない）。 */
function truncateUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}
