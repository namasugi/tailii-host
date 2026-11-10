// sessionSearch.ts
// tailii (TS host) — Claude Code / Codex 会話本文の横断検索（session_search）

import * as fs from "node:fs";
import { posix } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as yieldToEngine } from "node:timers/promises";
import { rolloutMessageText } from "../codex/codexSessionStore.js";
import { codexAsyncQuestionReplyDisplayText } from "../codex/codexAsyncQuestion.js";
import { codexPlanChatOutput } from "../codex/codexPlanItem.js";
import type { ClaudeSessionInfo, SessionSearchResult } from "../protocol.js";
import { isCompactSummaryRecord } from "../shared/compactSummary.js";
import { isLocalCommandModelCopyRecord } from "../shared/localCommandModelCopy.js";
import { isTurnCompanionRecord } from "../shared/commandExpansion.js";
import { narrationText } from "../shared/narration.js";
import { stripInjectedReminderBlocks, stripReminderTagBlocks } from "../shared/harnessReminder.js";
import { crossSessionOriginHint, crossSessionPreviewLine, presentCrossSessionMessage } from "../shared/crossSession.js";

export interface SessionSearchSource {
  list(): ClaudeSessionInfo[];
  listForSearch?(): ClaudeSessionInfo[];
  transcriptPath(sessionId: string): string | null;
}

export interface SessionSearchOptions {
  limit?: number;
  agents?: ("claude" | "codex")[];
  cwd?: string;
  nowMs?: () => number;
  timeBudgetMs?: number;
  perFileBytes?: number;
  fileCountLimit?: number;
  snippetContextChars?: number;
  signal?: AbortSignal;
  onProgress?: (results: SessionSearchResult[]) => void;
}

export interface SessionSearchStats {
  scannedFiles: number;
  truncated: boolean;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  stats: SessionSearchStats;
}

export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 100;
export const SESSION_SEARCH_TIME_BUDGET_MS = Number.POSITIVE_INFINITY;
export const SESSION_SEARCH_PER_FILE_BYTES = Number.POSITIVE_INFINITY;
export const SESSION_SEARCH_FILE_COUNT_LIMIT = Number.POSITIVE_INFINITY;
export const SESSION_SEARCH_SNIPPET_CONTEXT_CHARS = 40;

/** 既存の Claude 単独呼び出しも同じ非同期の全文検索を使う。 */
export async function searchClaudeSessions(
  store: SessionSearchSource,
  query: string,
  options: SessionSearchOptions = {},
): Promise<SessionSearchResponse> {
  return searchSessions([store], query, options);
}

/** ホストの全会話を新しい順に検索する。読取量・時間で黙って本文を捨てず、ストリームで読む。 */
export async function searchSessions(
  stores: SessionSearchSource[],
  query: string,
  options: SessionSearchOptions = {},
): Promise<SessionSearchResponse> {
  // 本文側（extractMessageText）と同じ空白正規化を掛ける。全角スペース（iOS 日本語キーボードの
  // 既定）や連続空白で区切った複数語クエリも、本文の空白 1 つに畳んだ形へ揃えて照合する。
  const normalizedQuery = query.trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return { results: [], stats: { scannedFiles: 0, truncated: false } };
  }

  const requested = options.limit ?? SESSION_SEARCH_DEFAULT_LIMIT;
  const limit = clampLimit(requested);
  const nowMs = options.nowMs ?? (() => Date.now());
  const deadline = nowMs() + (options.timeBudgetMs ?? SESSION_SEARCH_TIME_BUDGET_MS);
  const perFileBytes = options.perFileBytes ?? SESSION_SEARCH_PER_FILE_BYTES;
  const fileCountLimit = options.fileCountLimit ?? SESSION_SEARCH_FILE_COUNT_LIMIT;
  const snippetContext = options.snippetContextChars ?? SESSION_SEARCH_SNIPPET_CONTEXT_CHARS;

  options.signal?.throwIfAborted();
  const agents = options.agents === undefined ? undefined : new Set<string>(options.agents);
  if (agents?.size === 0) return { results: [], stats: { scannedFiles: 0, truncated: false } };
  const sessions = stores.flatMap((store) =>
    (store.listForSearch?.() ?? store.list())
      .filter((info) => (agents === undefined || agents.has(info.agent?.toLowerCase() ?? "claude"))
        && (options.cwd === undefined || sameSearchDirectory(info.cwd, options.cwd)))
      .map((info) => ({ info, filePath: store.transcriptPath(info.sessionId) })),
  ).sort((a, b) => (b.info.updatedAt ?? 0) - (a.info.updatedAt ?? 0) || a.info.sessionId.localeCompare(b.info.sessionId));
  const results: SessionSearchResult[] = [];
  let scannedFiles = 0;
  let truncated = false;

  for (const { info, filePath } of sessions) {
    options.signal?.throwIfAborted();
    if (results.length >= limit) break;
    if (scannedFiles >= fileCountLimit) {
      truncated = true;
      break;
    }
    if (nowMs() > deadline) {
      truncated = true;
      break;
    }
    if (filePath === null) continue;
    scannedFiles += 1;
    const match = await searchTranscriptFile(filePath, normalizedQuery, perFileBytes, snippetContext, info.agent, options.signal);
    if (match === null) continue;
    const result: SessionSearchResult = {
      sessionId: info.sessionId,
      title: info.title,
      cwd: info.cwd,
      snippet: match,
    };
    if (info.updatedAt !== undefined) result.updatedAt = info.updatedAt;
    if (info.agent !== undefined) result.agent = info.agent;
    results.push(result);
    options.onProgress?.([...results]);
  }

  return { results, stats: { scannedFiles, truncated } };
}

/** iOSのClaudeSessionSections.sameDirと同じ、完全一致＋worktreeからrepoへの正規化。IOは行わない。 */
function sameSearchDirectory(candidate: string, selected: string): boolean {
  const trim = (value: string): string => value.replace(/\/+$/, "") || (value.startsWith("/") ? "/" : "");
  const base = trim(selected);
  if (trim(candidate) === base) return true;
  const normalized = posix.normalize(candidate);
  const marker = normalized.indexOf("/.claude/worktrees/");
  return trim(marker < 0 ? normalized : normalized.slice(0, marker)) === base;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT, Math.floor(value)));
}

async function searchTranscriptFile(
  filePath: string,
  normalizedQuery: string,
  byteLimit: number,
  snippetContext: number,
  agent: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (byteLimit <= 0) return null;
  const input = fs.createReadStream(filePath, {
    encoding: "utf8",
    ...(Number.isFinite(byteLimit) ? { end: byteLimit - 1 } : {}),
    signal,
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lastYield = Date.now();
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      // まとめて届いた行の JSON 解析でも engine の制御ループへ定期的に実行権を戻す。
      if (Date.now() - lastYield >= 8) {
        await yieldToEngine();
        signal?.throwIfAborted();
        lastYield = Date.now();
      }
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (typeof parsed !== "object" || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      let text: string | null;
      if (agent === "codex") {
        text = extractCodexMessageText(obj);
      } else {
        if (obj["type"] !== "user" && obj["type"] !== "assistant") continue;
        // 画面に出ない要約・ローカルコマンドの写し・ターンの内部コンテキストは除外する。
        if (isCompactSummaryRecord(obj) || isLocalCommandModelCopyRecord(obj) || isTurnCompanionRecord(obj)) continue;
        text = extractMessageText(obj);
      }
      if (text === null) continue;
      text = text.replaceAll(/\s+/gu, " ").trim();
      const index = text.toLocaleLowerCase().indexOf(normalizedQuery);
      if (index < 0) continue;
      return makeSnippet(text, index, normalizedQuery.length, snippetContext);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // 削除・移動・読取不能になった履歴だけを飛ばし、他の会話の検索を続ける。
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

/** 一覧プレビューに加え、会話に表示する提案プランと質問回答の本文も検索する。 */
function extractCodexMessageText(obj: Record<string, unknown>): string | null {
  const payload = asRecord(obj["payload"]);
  const item = asRecord(payload?.["item"]);
  if (obj["type"] === "event_msg" && payload?.["type"] === "item_completed" && item?.["type"] === "Plan") {
    if (typeof item["id"] !== "string" || typeof item["text"] !== "string") return null;
    const plan = codexPlanChatOutput(item["id"], item["text"]);
    return plan?.type === "chat_output" ? plan.text : null;
  }
  const text = rolloutMessageText(obj);
  if (text === null) return null;
  const isUser = obj["type"] === "event_msg" && (payload?.["type"] === "user_message"
    || (payload?.["type"] === "item_completed" && item?.["type"] === "UserMessage"));
  return isUser ? codexAsyncQuestionReplyDisplayText(text) ?? text : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function extractMessageText(obj: Record<string, unknown>): string | null {
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  // harness 注入の <system-reminder>（user 行のリマインダ / assistant text 末尾の背景通知）は
  // 検索対象にもスニペットにも出さない（生 XML の混入と、通知本文でのヒットを防ぐ）。
  // 別セッション / 別エージェントからのメッセージ封筒（<cross-session-message> / <agent-message>）
  // は「⇄ 送信元名: 本文」へ転写して照合する（生タグでなく本文と送信元名でヒットし、スニペットも
  // 整形済みになる）。委任したサブエージェントの完了報告（hand-back）は「⇄ サブエージェントの報告:
  // レポート全文」で照合する（harness の定型前置きは対象外。判定の権威は行の origin.handback）。
  const strip = (raw: string): string => {
    if (obj["type"] === "assistant") return stripInjectedReminderBlocks(raw);
    const peer = presentCrossSessionMessage(raw, crossSessionOriginHint(obj));
    if (peer !== null) return crossSessionPreviewLine(peer);
    return stripReminderTagBlocks(raw);
  };
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(strip(content));
  } else if (Array.isArray(content)) {
    for (const element of content) {
      if (typeof element === "string") {
        parts.push(strip(element));
      } else if (typeof element === "object" && element !== null) {
        const block = element as Record<string, unknown>;
        const blockType = block["type"];
        const text = block["text"];
        if ((blockType === undefined || blockType === "text") && typeof text === "string") {
          parts.push(strip(text));
        }
        // thinking ブロックとして記録された途中経過の発話（narration）も会話画面に出るので検索対象。
        const narration = obj["type"] === "assistant" ? narrationText(block) : null;
        if (narration !== null) parts.push(strip(narration));
      }
    }
  }
  // 除去で空になった部分や段落区切りが二重空白にならないよう、照合前に空白を 1 つに畳む
  // （makeSnippet の整形と同じ正規化。二重空白のままだと複数語のクエリが外れる）。
  const text = parts.filter((part) => part.length > 0).join(" ").replaceAll(/\s+/gu, " ").trim();
  return text.length > 0 ? text : null;
}

function makeSnippet(text: string, matchIndex: number, matchLength: number, context: number): string {
  const start = Math.max(0, matchIndex - context);
  const end = Math.min(text.length, matchIndex + matchLength + context);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`.replaceAll(/\s+/g, " ").trim();
}
