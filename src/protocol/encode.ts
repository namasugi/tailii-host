// protocol/encode.ts
// ControlMessage → canonical NDJSON 1 行のエンコード（キー辞書順 = golden 安定）。

import { PROTOCOL_LEGACY, type ControlMessage } from "./messages.js";
import type { Raw } from "./common.js";

/** `ControlMessage` を canonical NDJSON 1 行（改行なし）へエンコードする。 */
export function encodeControlMessage(message: ControlMessage): string {
  return JSON.stringify(canonicalize(wireObject(message)));
}

/** 型ごとの wire オブジェクトを組み立てる（v0 は v キーを持たない）。 */
function wireObject(message: ControlMessage): Raw {
  const out: Raw = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === "v" || key === "activity" || key === "node" || value === undefined) continue;
    out[key] = value;
  }
  if (message.v !== PROTOCOL_LEGACY) out["v"] = message.v;

  if (message.type === "tool_activity" || message.type === "session_tool_activity") {
    const activity = message.activity;
    out["id"] = activity.id;
    out["name"] = activity.name;
    out["label"] = activity.label;
    if (activity.file !== undefined) out["file"] = activity.file;
    if (activity.addedLines !== undefined) out["addedLines"] = activity.addedLines;
    if (activity.removedLines !== undefined) out["removedLines"] = activity.removedLines;
    if (activity.diff !== undefined) {
      const diff: Raw = {
        oldStringTruncated: activity.diff.oldStringTruncated,
        newStringTruncated: activity.diff.newStringTruncated,
      };
      if (activity.diff.oldString !== undefined) diff["oldString"] = activity.diff.oldString;
      if (activity.diff.newString !== undefined) diff["newString"] = activity.diff.newString;
      out["diff"] = diff;
    }
    if (activity.command !== undefined) {
      out["command"] = activity.command;
      out["commandTruncated"] = activity.commandTruncated;
    }
    if (activity.description !== undefined) {
      out["description"] = activity.description;
      out["descriptionTruncated"] = activity.descriptionTruncated;
    }
    if (activity.todos !== undefined) out["todos"] = activity.todos;
  }

  if (message.type === "subagent_node") {
    const node = message.node;
    out["agentType"] = node.agentType;
    if (node.currentActivity !== undefined) out["currentActivity"] = node.currentActivity;
    out["depth"] = node.depth;
    out["label"] = node.label;
    out["nodeId"] = node.nodeId;
    if (node.parentNodeId !== undefined) out["parentNodeId"] = node.parentNodeId;
    out["status"] = node.status;
    out["toolUseId"] = node.toolUseId;
    out["ts"] = node.ts;
  }

  return out;
}

/** オブジェクトのキーを再帰的に辞書順へ並べ替える（JSONEncoder .sortedKeys 相当）。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const sorted: Raw = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Raw)[key];
      if (inner !== undefined) sorted[key] = canonicalize(inner);
    }
    return sorted;
  }
  return value;
}
