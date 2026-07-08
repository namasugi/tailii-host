// sessionSearch.ts
// tailii (TS host) — Claude Code 会話本文の横断検索（session_search）

import * as fs from "node:fs";
import type { ClaudeSessionInfo, SessionSearchResult } from "./protocol.js";

export interface SessionSearchSource {
  list(): ClaudeSessionInfo[];
  transcriptPath(sessionId: string): string | null;
}

export interface SessionSearchOptions {
  limit?: number;
  nowMs?: () => number;
  timeBudgetMs?: number;
  perFileBytes?: number;
  fileCountLimit?: number;
  snippetContextChars?: number;
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
export const SESSION_SEARCH_TIME_BUDGET_MS = 120;
export const SESSION_SEARCH_PER_FILE_BYTES = 1024 * 1024;
export const SESSION_SEARCH_FILE_COUNT_LIMIT = 1000;
export const SESSION_SEARCH_SNIPPET_CONTEXT_CHARS = 40;

/** Claude 会話 jsonl の user/assistant テキストだけを対象に、大文字小文字を無視して部分一致検索する。 */
export function searchClaudeSessions(
  store: SessionSearchSource,
  query: string,
  options: SessionSearchOptions = {},
): SessionSearchResponse {
  const normalizedQuery = query.trim().toLocaleLowerCase();
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

  const sessions = store.list();
  const results: SessionSearchResult[] = [];
  let scannedFiles = 0;
  let truncated = false;

  for (const info of sessions) {
    if (results.length >= limit) break;
    if (scannedFiles >= fileCountLimit) {
      truncated = true;
      break;
    }
    if (nowMs() > deadline) {
      truncated = true;
      break;
    }
    const filePath = store.transcriptPath(info.sessionId);
    if (filePath === null) continue;
    scannedFiles += 1;
    const match = searchTranscriptFile(filePath, normalizedQuery, perFileBytes, snippetContext);
    if (match === null) continue;
    const result: SessionSearchResult = {
      sessionId: info.sessionId,
      title: info.title,
      cwd: info.cwd,
      snippet: match,
    };
    if (info.updatedAt !== undefined) result.updatedAt = info.updatedAt;
    results.push(result);
  }

  return { results, stats: { scannedFiles, truncated } };
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT, Math.floor(value)));
}

function searchTranscriptFile(
  filePath: string,
  normalizedQuery: string,
  byteLimit: number,
  snippetContext: number,
): string | null {
  let content: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = Math.max(0, Math.min(byteLimit, fs.fstatSync(fd).size));
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, 0);
      content = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  for (const line of content.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj["type"] !== "user" && obj["type"] !== "assistant") continue;
    const text = extractMessageText(obj);
    if (text === null) continue;
    const normalizedText = text.toLocaleLowerCase();
    const index = normalizedText.indexOf(normalizedQuery);
    if (index < 0) continue;
    return makeSnippet(text, index, normalizedQuery.length, snippetContext);
  }
  return null;
}

function extractMessageText(obj: Record<string, unknown>): string | null {
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const element of content) {
      if (typeof element === "string") {
        parts.push(element);
      } else if (typeof element === "object" && element !== null) {
        const block = element as Record<string, unknown>;
        const blockType = block["type"];
        const text = block["text"];
        if ((blockType === undefined || blockType === "text") && typeof text === "string") {
          parts.push(text);
        }
      }
    }
  }
  const text = parts.join(" ").replaceAll("\r", " ").replaceAll("\n", " ").trim();
  return text.length > 0 ? text : null;
}

function makeSnippet(text: string, matchIndex: number, matchLength: number, context: number): string {
  const start = Math.max(0, matchIndex - context);
  const end = Math.min(text.length, matchIndex + matchLength + context);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`.replaceAll(/\s+/g, " ").trim();
}
