// codexSystemNotice.ts
// tailii (TS host) — Codex App Server / rollout の利用者向けエラー・警告を
// chat_output(system) へ正規化する。live と rollout の二重経路は同じ streamId / 本文を
// 作り、Session Hub と iOS の双方で冪等に扱えるようにする。

import { createHash } from "node:crypto";
import { PROTOCOL_V1, type ControlMessage } from "../protocol.js";

const NOTICE_STREAM_PREFIX = "codex-notice-";
const NOTICE_DETAIL_LIMIT = 240;
const NOTICE_NAME_LIMIT = 80;

export interface CodexSystemNotice {
  /** App Server live item の重複排除キー。ThreadItem 由来なら生の item id を使う。 */
  itemId: string;
  payload: Extract<ControlMessage, { type: "chat_output" }>;
}

/** Codex 専用 system 注記だけを rollout/live occurrence 照合の対象にする。 */
export function codexSystemNoticeContentKey(payload: ControlMessage): string | null {
  if (payload.type !== "chat_output" || payload.role !== "system" ||
    !payload.streamId.startsWith(NOTICE_STREAM_PREFIX)) return null;
  return `system\u0000${payload.text}`;
}

/** App Server item/completed の mcpToolCall 失敗を表示用注記へ変換する。 */
export function codexMcpItemErrorNotice(
  item: Record<string, unknown>,
): CodexSystemNotice | null {
  if (item["type"] !== "mcpToolCall") return null;
  const id = nonEmptyString(item["id"]);
  if (id === null) return null;
  const error = asRecord(item["error"]);
  const errorMessage = nonEmptyString(error?.["message"]);
  if (item["status"] !== "failed" && errorMessage === null) return null;
  return notice(
    id,
    `mcp:${id}`,
    mcpErrorText(item["server"], item["tool"], errorMessage),
  );
}

/** rollout event_msg の利用者向け error / warning を表示用注記へ変換する。 */
export function codexRolloutSystemNotice(
  payload: Record<string, unknown>,
): CodexSystemNotice | null {
  const kind = payload["type"];
  if (kind === "mcp_tool_call_end") {
    const id = nonEmptyString(payload["call_id"]);
    if (id === null) return null;
    const result = asRecord(payload["result"]);
    if (result === null) return null;
    const transportError = nonEmptyString(result["Err"]);
    const toolResult = asRecord(result["Ok"]);
    const toolReportedError = toolResult?.["isError"] === true || toolResult?.["is_error"] === true;
    if (transportError === null && !toolReportedError) return null;
    const invocation = asRecord(payload["invocation"]);
    const detail = transportError ?? textContent(toolResult?.["content"]);
    return notice(
      id,
      `mcp:${id}`,
      mcpErrorText(invocation?.["server"], invocation?.["tool"], detail),
    );
  }

  if (kind !== "error" && kind !== "stream_error" && kind !== "warning") return null;
  const message = noticeMessage(payload);
  if (message === null) return null;
  const turnId = nonEmptyString(payload["turn_id"]) ?? "unknown-turn";
  const attempt = nonNegativeInteger(payload["retry_attempt"]);
  const maxRetries = nonNegativeInteger(payload["max_retries"]);
  const retrying = kind === "stream_error" &&
    (maxRetries === null || attempt === null || attempt < maxRetries);
  const detail = clip(message, NOTICE_DETAIL_LIMIT);
  const text = kind === "warning"
    ? `⚠️ Codex 警告: ${detail}`
    : retrying
      ? `⚠️ Codex エラー（自動再試行中）: ${detail}`
      : `❌ Codex エラー: ${detail}`;
  // 同じ stream_error の再試行は 1 件へ畳み、上限到達（retrying=false）だけ別注記にする。
  // retry attempt を ID に含めると 502 × 10 回のような一時障害で会話が埋まってしまう。
  const identity = `${String(kind)}:${turnId}:${retrying ? "retrying" : "terminal"}:${detail}`;
  return notice(`rollout:${identity}`, identity, text);
}

/** App Server の item 以外の error / warning 通知を表示用注記へ変換する。 */
export function codexAppServerSystemNotice(
  method: string,
  params: Record<string, unknown> | null,
): CodexSystemNotice | null {
  if (params === null) return null;

  if (method === "error") {
    const turnId = nonEmptyString(params["turnId"]) ?? "unknown-turn";
    const message = turnErrorMessage(params["error"]);
    const willRetry = params["willRetry"] === true;
    const detail = clip(message ?? "Codex でエラーが発生しました。", NOTICE_DETAIL_LIMIT);
    return willRetry
      ? notice(
        `turn-retry:${turnId}:${detail}`,
        `turn-retry:${turnId}:${detail}`,
        `⚠️ Codex エラー（自動再試行中）: ${detail}`,
      )
      : notice(
        `turn-error:${turnId}`,
        `turn-error:${turnId}`,
        `❌ Codex エラー: ${detail}`,
      );
  }

  if (method === "turn/completed") {
    const turn = asRecord(params["turn"]);
    if (turn?.["status"] !== "failed") return null;
    const turnId = nonEmptyString(turn["id"]) ?? "unknown-turn";
    const detail = clip(
      turnErrorMessage(turn["error"]) ?? "ターンを完了できませんでした。",
      NOTICE_DETAIL_LIMIT,
    );
    return notice(
      `turn-error:${turnId}`,
      `turn-error:${turnId}`,
      `❌ Codex エラー: ${detail}`,
    );
  }

  if (method === "mcpServer/startupStatus/updated") {
    if (params["status"] !== "failed") return null;
    const name = clip(nonEmptyString(params["name"]) ?? "不明", NOTICE_NAME_LIMIT);
    const detail = nonEmptyString(params["error"])
      ?? (params["failureReason"] === "reauthenticationRequired"
        ? "再認証が必要です。"
        : "起動できませんでした。");
    const text = `❌ MCP サーバー「${name}」の起動に失敗しました: ${clip(detail, NOTICE_DETAIL_LIMIT)}`;
    return notice(`mcp-startup:${name}:${detail}`, `mcp-startup:${name}:${detail}`, text);
  }

  if (method === "mcpServer/oauthLogin/completed" && params["success"] === false) {
    const name = clip(nonEmptyString(params["name"]) ?? "不明", NOTICE_NAME_LIMIT);
    const detail = clip(nonEmptyString(params["error"]) ?? "ログインできませんでした。", NOTICE_DETAIL_LIMIT);
    return notice(
      `mcp-login:${name}:${detail}`,
      `mcp-login:${name}:${detail}`,
      `❌ MCP サーバー「${name}」のログインに失敗しました: ${detail}`,
    );
  }

  if (method === "warning" || method === "guardianWarning") {
    const message = nonEmptyString(params["message"]);
    if (message === null) return null;
    const detail = clip(message, NOTICE_DETAIL_LIMIT);
    const label = method === "guardianWarning" ? "Codex セキュリティ警告" : "Codex 警告";
    return notice(`${method}:${detail}`, `${method}:${detail}`, `⚠️ ${label}: ${detail}`);
  }

  if (method === "configWarning" || method === "deprecationNotice") {
    const summary = nonEmptyString(params["summary"]);
    if (summary === null) return null;
    const details = nonEmptyString(params["details"]);
    const body = clip(details === null ? summary : `${summary} — ${details}`, NOTICE_DETAIL_LIMIT);
    const label = method === "configWarning" ? "Codex 設定警告" : "Codex 非推奨機能";
    return notice(`${method}:${body}`, `${method}:${body}`, `⚠️ ${label}: ${body}`);
  }

  return null;
}

function mcpErrorText(serverValue: unknown, toolValue: unknown, detailValue: string | null): string {
  const server = clip(nonEmptyString(serverValue) ?? "不明", NOTICE_NAME_LIMIT);
  const tool = clip(nonEmptyString(toolValue) ?? "不明", NOTICE_NAME_LIMIT);
  const detail = clip(detailValue ?? "ツールがエラーを返しました。", NOTICE_DETAIL_LIMIT);
  return `❌ MCP「${server} / ${tool}」エラー: ${detail}`;
}

function notice(itemId: string, identity: string, text: string): CodexSystemNotice {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return {
    itemId,
    payload: {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId: `${NOTICE_STREAM_PREFIX}${digest}`,
      role: "system",
      text,
      eof: true,
    },
  };
}

function noticeMessage(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyString(payload["message"]) ?? nonEmptyString(payload["content"]);
  if (direct !== null) return direct;
  return turnErrorMessage(payload["error"]);
}

function turnErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  const error = asRecord(value);
  if (error === null) return null;
  const message = nonEmptyString(error["message"]);
  const additional = nonEmptyString(error["additionalDetails"]);
  if (message === null) return additional;
  if (additional === null || message.includes(additional)) return message;
  return `${message} — ${additional}`;
}

function textContent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((entry): string[] => {
    if (typeof entry === "string" && entry.trim().length > 0) return [entry];
    const record = asRecord(entry);
    const text = nonEmptyString(record?.["text"]);
    return text === null ? [] : [text];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/** 改行を 1 段落へ畳み、Unicode scalar 単位で切り詰める。 */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  const characters = [...flat];
  return characters.length <= limit ? flat : characters.slice(0, limit).join("") + "…";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
