// subagentTranscript.ts
// サブエージェント transcript を全文表示向けの軽量な行へ変換する。

import * as fs from "node:fs";
import type { SubagentTranscriptEntry } from "../protocol.js";
import {
  rolloutPatchApplyActivities,
  rolloutResponseItemToolActivities,
} from "../codex/codexToolActivity.js";

const MAX_ENTRIES = 200;
const MAX_TOOL_TEXT = 1_000;
const MAX_TOOL_INPUT = 300;

export interface SubagentTranscriptResult {
  entries: SubagentTranscriptEntry[];
  omitted: number;
}

/** 読めないファイルは空応答にする（要求元を待たせない）。 */
export function readSubagentTranscript(file: string | null): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    return parseSubagentTranscript(fs.readFileSync(file, "utf8"));
  } catch {
    return { entries: [], omitted: 0 };
  }
}

/** Codex sub-agent の rollout を全文表示向けの軽量な行へ変換する。 */
export function readCodexSubagentTranscript(file: string | null): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    return parseCodexSubagentTranscript(fs.readFileSync(file, "utf8"));
  } catch {
    return { entries: [], omitted: 0 };
  }
}

const MAX_OUTPUT_TAIL = 8_000;

/**
 * バックグラウンドコマンドの出力ファイル（プレーンテキスト）を末尾クランプで返す。
 * 先頭切り捨て時は omitted=1 で「省略あり」を明示する（行数は数えない）。
 */
export function readBackgroundOutput(file: string | null): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  let text: string;
  let ts: number | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtimeMs;
    ts = Number.isFinite(mtime) ? Math.floor(mtime) : undefined;
  } catch {
    return { entries: [], omitted: 0 };
  }
  const clamped = text.length > MAX_OUTPUT_TAIL;
  const tail = clamped ? text.slice(text.length - MAX_OUTPUT_TAIL) : text;
  if (tail.length === 0) return { entries: [], omitted: 0 };
  return {
    entries: [{
      role: "tool",
      text: tail,
      ...(ts === undefined ? {} : { ts }),
      kind: "tool_result",
    }],
    omitted: clamped ? 1 : 0,
  };
}

export function parseSubagentTranscript(jsonl: string): SubagentTranscriptResult {
  const all: SubagentTranscriptEntry[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const ts = parseTimestamp(record["timestamp"]);
    const message = object(record["message"]);
    const role = message?.["role"] ?? record["type"];
    if (role !== "user" && role !== "assistant") continue;
    const content = message?.["content"] ?? record["content"];
    if (typeof content === "string" && content) all.push(entry(role, content, ts));
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      const block = object(rawBlock);
      if (block === null) continue;
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"]) {
        all.push(entry(role, block["text"], ts));
      }
      if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        const input = snippet(block["input"], MAX_TOOL_INPUT);
        all.push(entry(
          "tool", input ? `${block["name"]}: ${input}` : block["name"], ts, "tool_use",
        ));
      }
      if (block["type"] === "tool_result") {
        const result = toolResultText(block["content"]);
        if (result) all.push(entry("tool", truncate(result, MAX_TOOL_TEXT), ts, "tool_result"));
      }
    }
  }
  const omitted = Math.max(0, all.length - MAX_ENTRIES);
  return { entries: all.slice(omitted), omitted };
}

/**
 * fork された Codex rollout には親の履歴も複製される。親→子の agent_message を境界にし、
 * それより後の子自身の発話・ツール実行だけを返す。
 */
export function parseCodexSubagentTranscript(jsonl: string): SubagentTranscriptResult {
  const records = jsonl.split(/\r?\n/).flatMap((line): Record<string, unknown>[] => {
    if (!line) return [];
    try {
      const value = JSON.parse(line) as unknown;
      return object(value) === null ? [] : [value as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const agentPath = codexAgentPath(records);
  let childHistoryStarted = false;
  const all: SubagentTranscriptEntry[] = [];

  for (const record of records) {
    const ts = parseTimestamp(record["timestamp"]);
    const recordType = record["type"];
    const payload = object(record["payload"]);
    if (payload === null) continue;

    if (recordType === "response_item" && payload["type"] === "agent_message" &&
      typeof payload["recipient"] === "string" &&
      (agentPath === null || payload["recipient"] === agentPath)) {
      childHistoryStarted = true;
      const task = interAgentPayloadText(payload["content"]);
      if (task !== null) all.push(entry("user", task, ts));
      continue;
    }
    if (!childHistoryStarted) continue;

    if (recordType === "event_msg") {
      if (payload["type"] === "agent_message" && typeof payload["message"] === "string" &&
        payload["message"].length > 0) {
        all.push(entry("assistant", payload["message"], ts));
      }
      for (const activity of rolloutPatchApplyActivities(payload)) {
        all.push(entry("tool", transcriptToolText(activity), ts, "tool_use"));
      }
      continue;
    }
    if (recordType !== "response_item") continue;

    const activities = rolloutResponseItemToolActivities(payload);
    for (const activity of activities) {
      all.push(entry("tool", transcriptToolText(activity), ts, "tool_use"));
    }
    if (activities.length === 0) {
      const genericTool = genericCodexToolText(payload);
      if (genericTool !== null) all.push(entry("tool", genericTool, ts, "tool_use"));
    }
    if (payload["type"] === "custom_tool_call_output" ||
      payload["type"] === "function_call_output") {
      const output = toolResultText(payload["output"]);
      if (output.length > 0) {
        all.push(entry("tool", truncate(output, MAX_TOOL_TEXT), ts, "tool_result"));
      }
    }
  }

  const omitted = Math.max(0, all.length - MAX_ENTRIES);
  return { entries: all.slice(omitted), omitted };
}

function codexAgentPath(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (record["type"] !== "session_meta") continue;
    const payload = object(record["payload"]);
    const source = object(payload?.["source"]);
    const subagent = object(source?.["subagent"] ?? source?.["subAgent"]);
    const spawn = object(subagent?.["thread_spawn"]);
    const path = spawn?.["agent_path"] ?? payload?.["agent_path"];
    if (typeof path === "string" && path.length > 0) return path;
  }
  return null;
}

function interAgentPayloadText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value.flatMap((raw): string[] => {
    const block = object(raw);
    return block?.["type"] === "input_text" && typeof block["text"] === "string"
      ? [block["text"]] : [];
  }).join("\n");
  const marker = "Payload:\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const payload = text.slice(markerIndex + marker.length).trim();
  return payload.length > 0 ? payload : null;
}

function transcriptToolText(activity: {
  name: string;
  label: string;
  command?: string;
  file?: string;
}): string {
  if (activity.command !== undefined) return `${activity.name}: ${activity.command}`;
  if (activity.file !== undefined) return `${activity.name}: ${activity.file}`;
  return activity.label;
}

function genericCodexToolText(payload: Record<string, unknown>): string | null {
  const kind = payload["type"];
  const name = payload["name"];
  if ((kind !== "custom_tool_call" && kind !== "function_call") ||
    typeof name !== "string" || name.length === 0) return null;
  // exec/apply_patch は専用カードまたは後続 patch_apply_end が詳細を表す。
  if (name === "exec" || name === "exec_command" || name === "update_plan" ||
    name === "apply_patch") return null;
  // collaboration payload は暗号化された長文を含む。会話履歴では操作名だけで十分。
  if (CODEX_COLLABORATION_TOOLS.has(name)) return name;
  const input = snippet(
    kind === "custom_tool_call" ? payload["input"] : payload["arguments"],
    MAX_TOOL_INPUT,
  );
  return input.length === 0 ? name : `${name}: ${input}`;
}

const CODEX_COLLABORATION_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
]);

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function entry(
  role: SubagentTranscriptEntry["role"],
  text: string,
  ts: number | undefined,
  kind?: SubagentTranscriptEntry["kind"],
): SubagentTranscriptEntry {
  return {
    role,
    text,
    ...(ts === undefined ? {} : { ts }),
    ...(kind === undefined ? {} : { kind }),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return snippet(value, MAX_TOOL_TEXT);
  return value.map((item) => {
    const block = object(item);
    return block !== null && typeof block["text"] === "string" ? block["text"] : "";
  }).filter(Boolean).join("\n");
}

function snippet(value: unknown, cap: number): string {
  if (value === undefined || value === null) return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return truncate(raw.replace(/\s+/g, " ").trim(), cap);
}

function truncate(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}…`;
}
