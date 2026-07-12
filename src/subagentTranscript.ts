// subagentTranscript.ts
// サブエージェント transcript を全文表示向けの軽量な行へ変換する。

import * as fs from "node:fs";
import type { SubagentTranscriptEntry } from "./protocol.js";

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
