// pushContent.ts
// tailii (TS host) — 通知の題名・本文の材料を安く集める
//
// 設計 docs/push-notifications.md §5: 題名は会話タイトル、本文は種別ごとの要約
// （完了 = 最後の応答の先頭 180 字 / 設問 = 質問文 / 承認 = `ツール名 · 要約`）。
// hub が安く取れない情報は取りに行かず、呼び出し側が定型文に落とす（null を返す）。

import * as fs from "node:fs";
import * as path from "node:path";
import { apiErrorAssistantKind, extractTurn } from "../chat/transcriptTailer.js";
import { ClaudeSessionStore, transcriptTitle } from "../sessions/claudeSessionStore.js";
import { defaultCodexHome } from "../codex/codexSessionStore.js";
import type { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import type { ControlMessage, QuestionPromptQuestion } from "../protocol.js";
import { clipChars } from "./pushEnvelope.js";

/** 完了通知の本文に使う最後の応答の長さ（字）。 */
export const TURN_DONE_BODY_CHARS = 180;

/** 改行・連続空白を 1 つの空白へ畳み、前後を落とす（通知の 1 段落に収める）。 */
export function flattenNotificationText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 要約の整形（畳んでから最大 max 字）。空なら null。 */
export function summarizeForNotification(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  const flat = flattenNotificationText(text);
  return flat.length === 0 ? null : clipChars(flat, max);
}

/**
 * claude transcript の末尾から最後の assistant 応答の本文を返す（末尾 tailBytes だけ読む）。
 * API エラー終端の合成行は応答に数えない。読めない・見つからないは null。
 */
export function findTrailingAssistantText(transcriptPath: string, tailBytes = 256 * 1024): string | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const readStart = start > 0 ? start - 1 : 0;
    const buffer = Buffer.alloc(size - readStart);
    const read = fs.readSync(fd, buffer, 0, buffer.length, readStart);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = (lines[index] ?? "").replaceAll("\r", "");
      if (!line) continue;
      if (apiErrorAssistantKind(line) !== null) continue;
      const turn = extractTurn(line);
      if (turn === null || turn.role !== "assistant") continue;
      if (turn.text.trim().length === 0) continue;
      return turn.text;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 二重 close 等は無視。
    }
  }
}

/** hub の replay buffer から最後の assistant の chat_output 本文を返す（Codex 用。購読が無ければ空）。 */
export function lastAssistantTextFromReplay(events: readonly { payload: ControlMessage }[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]!.payload;
    if (payload.type === "chat_output" && payload.role === "assistant" && payload.text.trim().length > 0 &&
      !payload.streamId.startsWith("pc:")) {
      return payload.text;
    }
  }
  return null;
}

/** 設問の本文（最初の質問文。複数なら件数を添える）。 */
export function questionNotificationBody(questions: readonly QuestionPromptQuestion[]): string | null {
  const first = questions.find((question) => question.question.trim().length > 0);
  if (first === undefined) return null;
  const text = flattenNotificationText(first.question);
  return questions.length > 1 ? `${text}（ほか ${questions.length - 1} 問）` : text;
}

/** session_index.jsonl を後ろから読む上限（バイト）。これより前にしか無い会話は題名を定型文にする。 */
const CODEX_INDEX_SCAN_BYTES = 2 * 1024 * 1024;
const CODEX_INDEX_CHUNK_BYTES = 64 * 1024;

/**
 * Codex の `session_index.jsonl` を末尾から読み、その thread の最新の行の `thread_name` を返す（一覧と同じく
 * 後の行が勝つ。最新の行に名前が無ければ null）。毎回全体を読まない（索引は会話が増えるほど大きくなる）。
 */
export function findCodexThreadTitle(indexPath: string, threadId: string, maxBytes = CODEX_INDEX_SCAN_BYTES): string | null {
  let fd: number;
  try {
    fd = fs.openSync(indexPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    let position = size;
    let carry = Buffer.alloc(0);
    const needle = JSON.stringify(threadId);
    while (position > floor) {
      const start = Math.max(floor, position - CODEX_INDEX_CHUNK_BYTES);
      const chunk = Buffer.alloc(position - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      position = start;
      const buffer = Buffer.concat([chunk, carry]);
      const lines = buffer.toString("utf8").split("\n");
      // 先頭の行は途中から読んだかもしれないので次の周回へ持ち越す（ファイル先頭なら完全な行）。
      carry = position > floor ? Buffer.from(lines.shift() ?? "", "utf8") : Buffer.alloc(0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const title = codexIndexLineTitle(lines[index]!, threadId, needle);
        if (title !== undefined) return title;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* 二重 close は無視。 */ }
  }
}

/** 索引の 1 行がその thread のものなら題名（無ければ null）、違えば undefined。 */
function codexIndexLineTitle(line: string, threadId: string, needle: string): string | null | undefined {
  if (!line.includes(needle)) return undefined;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record["id"] !== threadId) return undefined;
    const name = record["thread_name"];
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return undefined;
  }
}

/**
 * 会話タイトルの解決子（一覧と同じ規則: Claude は transcript の明示タイトル → 最初の発話、Codex は
 * session_index の正式名）。取れなければ null（呼び出し側が種別の定型文にする）。
 */
export function makeSessionTitleResolver(metadataStore: SessionMetadataStore): (session: string) => string | null {
  return (session) => {
    try {
      const meta = metadataStore.get(session);
      if (meta === null) return null;
      if (meta.agent === "codex") {
        const threadId = meta.providerSessionId;
        if (threadId === undefined) return null;
        return findCodexThreadTitle(path.join(defaultCodexHome(), "session_index.jsonl"), threadId);
      }
      const sessionId = meta.providerSessionId ?? meta.claudeSessionId;
      if (sessionId === undefined) return null;
      const transcript = new ClaudeSessionStore().transcriptPath(sessionId);
      return transcript === null ? null : transcriptTitle(transcript);
    } catch {
      return null;
    }
  };
}
