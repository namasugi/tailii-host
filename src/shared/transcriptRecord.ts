/**
 * Claude Code transcript（JSONL）の行種別の判定。
 *
 * Claude Code 2.1.300 から、API へ送った messages の本体を role 付きでそのまま複製した行
 * `api-request-blob`（`{ type: "api-request-blob", hash, sessionId, message: { role, content } }`。
 * timestamp / uuid は無い）が、通常の user / assistant 行とは別に書かれる（実測 2.1.302,
 * 2026-10-17）。`message.role` だけで user / assistant を判定すると、送信のたびに直前の発話と
 * 応答本文が二重に表示され、ToolSearch の tool_result と同居する text「Tool loaded.」（本物の
 * user 行には無く複製行にだけある）が発話バブルになる。
 * `message.role` で user / assistant を判定する箇所（`extractTurn` / `parseSubagentTranscript`）は
 * `type` が user / assistant の行に限り（`isNonMessageRecordType`）、attachment / queue-operation も
 * 読む `subagentTailer` の行ループは複製行だけを読み飛ばす（`isApiRequestBlobLine`）。
 */
function isMessageRecordType(type: unknown): type is "user" | "assistant" {
  return type === "user" || type === "assistant";
}

/** `type` が user / assistant 以外（system / attachment / api-request-blob 等、null や数値も含む）なら true。`type` 欠落（undefined）は旧形互換で通す。 */
export function isNonMessageRecordType(type: unknown): boolean {
  return type !== undefined && !isMessageRecordType(type);
}

/** API リクエストの複製行（`api-request-blob`）か。 */
export function isApiRequestBlobLine(line: string): boolean {
  // 複製行は最大 1.6MB ある（実測）。全行の JSON.parse を避け、文字列で先に絞る。
  if (!line.includes('"api-request-blob"')) return false;
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed?.type === "api-request-blob";
  } catch {
    return false;
  }
}
