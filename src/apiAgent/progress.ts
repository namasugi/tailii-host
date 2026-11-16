// SDK のイベントを進捗の種類とツール名へ絞る。本文・思考の内容・ツール引数は転送しない。
import type { ApiAgentProgress } from "../protocol/messages.js";

const PHASES = ["starting", "thinking", "responding", "tool", "approval", "question"];
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseApiAgentProgress(value: unknown): ApiAgentProgress | null {
  const raw = record(value);
  if (raw === null || typeof raw["phase"] !== "string" || !PHASES.includes(raw["phase"])) return null;
  const toolName = raw["toolName"];
  if (toolName !== undefined && (typeof toolName !== "string" || !TOOL_NAME.test(toolName))) return null;
  return { phase: raw["phase"] as ApiAgentProgress["phase"], ...(typeof toolName === "string" ? { toolName } : {}) };
}

export function toolProgress(phase: ApiAgentProgress["phase"], name: unknown): ApiAgentProgress {
  return { phase, ...(typeof name === "string" && TOOL_NAME.test(name) ? { toolName: name } : {}) };
}

export function progressFromSdkMessage(message: Record<string, unknown>): ApiAgentProgress | null {
  // 子エージェントの進捗で、親が待っている設問や現在の状態を上書きしない。
  if (typeof message["parent_tool_use_id"] === "string") return null;
  if (message["type"] === "tool_progress") return toolProgress("tool", message["tool_name"]);
  if (message["type"] === "system" && message["subtype"] === "init") return { phase: "thinking" };
  if (message["type"] === "stream_event") {
    const event = record(message["event"]);
    if (event?.["type"] === "message_start") return { phase: "thinking" };
    if (event?.["type"] !== "content_block_start") return null;
    const block = record(event["content_block"]);
    switch (block?.["type"]) {
      case "thinking": case "redacted_thinking": return { phase: "thinking" };
      case "text": return { phase: "responding" };
      case "tool_use": case "server_tool_use": return toolProgress("tool", block["name"]);
      default: return null;
    }
  }
  const content = record(message["message"])?.["content"];
  if (!Array.isArray(content)) return null;
  if (message["type"] === "user" && content.some((item) => record(item)?.["type"] === "tool_result")) {
    return { phase: "thinking" };
  }
  if (message["type"] === "assistant") {
    const tool = content.map(record).reverse().find((item) => item?.["type"] === "tool_use");
    if (tool !== undefined && tool !== null) return toolProgress("tool", tool["name"]);
    if (content.some((item) => record(item)?.["type"] === "text")) return { phase: "responding" };
  }
  return null;
}
