// Codex MCP の操作結果。接続失敗・操作失敗・成功（結果未確認を含む）を分け、
// chat の全体エラー注記ではなく、詳細を開ける tool_activity にする。

import type { ToolActivity } from "../protocol.js";

const DETAIL_LIMIT = 8_000;

export function codexMcpItemActivity(item: Record<string, unknown>): ToolActivity | null {
  if (item["type"] !== "mcpToolCall") return null;
  const status = item["status"];
  if (status !== "completed" && status !== "failed") return null;
  const error = record(item["error"]);
  return mcpActivity(item["id"], item["server"], item["tool"], item["arguments"], item["result"],
    string(error?.["message"]), status === "failed");
}

export function codexRolloutMcpActivity(payload: Record<string, unknown>): ToolActivity | null {
  if (payload["type"] !== "mcp_tool_call_end") return null;
  const result = record(payload["result"]);
  if (result === null) return null;
  const invocation = record(payload["invocation"]);
  const toolResult = record(result["Ok"]);
  const error = string(result["Err"]);
  // 未知の result を成功扱いしない。
  if (toolResult === null && error === null) return null;
  return mcpActivity(payload["call_id"], invocation?.["server"], invocation?.["tool"], invocation?.["arguments"],
    toolResult, error, toolResult?.["isError"] === true || toolResult?.["is_error"] === true);
}

function mcpActivity(
  idValue: unknown, server: unknown, tool: unknown, args: unknown, result: unknown,
  transportError: string | null, failed: boolean,
): ToolActivity | null {
  const id = string(idValue);
  if (id === null) return null;
  const parsed = mcpToolResultOutcome(result);
  const toolResult = record(result);
  const toolFailed = failed || toolResult?.["isError"] === true || toolResult?.["is_error"] === true;
  const outcome: ToolActivity["outcome"] = transportError !== null ? "connection_failed"
    : parsed.unverified ? "unverified" : toolFailed ? "failed" : "completed";
  const operation = string(record(args)?.["command"]);
  const label = `${clip(string(server) ?? "不明", 80)} / ${clip(string(tool) ?? "不明", 80)}` +
    (operation === null ? "" : ` · ${clip(operation, 80)}`);
  const command = args === undefined || args === null ? undefined : JSON.stringify(args, null, 2);
  const detail = transportError ?? parsed.detail;
  return {
    // live / rollout の同じ call_id は同じ id。コマンドカードの id 空間と分ける。
    id: `mcp-${id}`, name: "MCP", label,
    outcome,
    ...(command === undefined ? {} : { command: clip(command, DETAIL_LIMIT) }),
    commandTruncated: [...(command ?? "")].length > DETAIL_LIMIT,
    ...(detail === null ? {} : { description: clip(detail, DETAIL_LIMIT) }),
    descriptionTruncated: [...(detail ?? "")].length > DETAIL_LIMIT,
  };
}

/**
 * 本文の success / error はツール固有の任意データなので、通常の成否判定には使わない。
 * 実測した「操作成功・検証未完了」だけを中立の状態に分け、他は上位 status / isError に従う。
 */
function mcpToolResultOutcome(value: unknown): { unverified: boolean; detail: string | null } {
  const result = record(value);
  const parts = Array.isArray(result?.["content"]) ? result["content"].flatMap((entry: unknown) => {
    const text = string(typeof entry === "string" ? entry : record(entry)?.["text"]);
    return text === null ? [] : [text];
  }) : [];
  const text = parts.length > 0 ? parts.join("\n") : null;
  let body = record(result?.["structuredContent"]) ?? record(result?.["structured_content"]);
  if (body === null && text?.trim().startsWith("{")) {
    try { body = record(JSON.parse(text)); } catch { /* 通常のテキストはそのまま応答として使う。 */ }
  }
  const error = body?.["error"];
  const hasError = error !== undefined && error !== null && error !== false && error !== "" && error !== 0;
  const detail = string(error) ?? string(record(error)?.["message"]) ?? string(body?.["message"]) ?? string(body?.["reason"]);
  const hint = string(body?.["hint"]);
  return {
    unverified: body?.["success"] === true && body["verified"] === false && !hasError,
    detail: detail === null ? hint ?? text : hint === null || detail.includes(hint) ? detail : `${detail} — ${hint}`,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clip(value: string, limit: number): string {
  return [...value].slice(0, limit).join("");
}
