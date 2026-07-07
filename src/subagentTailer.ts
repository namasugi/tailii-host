// subagentTailer.ts
// tailii (TS host) — サブエージェント進捗ツリー tail
// Swift 版 SubagentTailer.swift の移植。
// claude の `<sessionId>/subagents/agent-*.meta.json` と main/subagent transcript を監視し、
// subagent_node（spawn/running → completed/error）を engine チャネルへ流す。

import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_V2, type ControlMessage, type SubagentNode, type SubagentNodeStatus, type ToolActivity } from "./protocol.js";
import { abortableSleep } from "./sleep.js";
import { extractToolActivities, TranscriptTailer } from "./transcriptTailer.js";

export interface SubagentTailerOptions {
  /** 追記ポーリング間隔（ms）。既定 50ms。 */
  pollIntervalMs?: number;
  /** EOF 後も abort まで無期限に tail するか。既定 true。 */
  tailIndefinitely?: boolean;
}

interface Meta {
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
}

interface TrackedNode {
  nodeId: string;
  meta: Meta;
  metaPath: string;
  jsonlPath: string | null;
  firstJsonlTimestampMs: number | null;
  currentActivity: string | null;
  lastKey: string | null;
}

interface ToolResultHit {
  isError: boolean;
  ts: number | null;
}

interface FileTailState {
  position: number;
  lineBuf: Buffer;
  ownerByToolUseId: Map<string, string>;
  resultByToolUseId: Map<string, ToolResultHit>;
  firstTimestampMs: number | null;
}

/** サブエージェント meta/jsonl と親 transcript の tool_result を監視する。 */
export class SubagentTailer {
  private readonly pollIntervalMs: number;
  private readonly tailIndefinitely: boolean;

  constructor(options: SubagentTailerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.tailIndefinitely = options.tailIndefinitely ?? true;
  }

  async *streamProjectDir(
    projectDir: string,
    preferredSessionId: string | null,
    newerThanMs: number | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    const start = Date.now();
    let mainTranscript: string | null = null;
    while (!signal?.aborted) {
      mainTranscript = TranscriptTailer.resolveJsonl(projectDir, preferredSessionId, newerThanMs);
      if (mainTranscript !== null) break;
      if (!this.tailIndefinitely) return;
      await abortableSleep(this.pollIntervalMs, signal);
      if (!this.tailIndefinitely && Date.now() - start > this.pollIntervalMs) return;
    }
    if (mainTranscript === null || signal?.aborted) return;
    yield* this.streamSession(mainTranscript, signal);
  }

  async *streamSession(
    mainTranscript: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    const sessionId = path.basename(mainTranscript, ".jsonl");
    const subagentsDir = path.join(path.dirname(mainTranscript), sessionId, "subagents");
    const tracked = new Map<string, TrackedNode>();
    const fileStates = new Map<string, FileTailState>();
    const ownerByToolUseId = new Map<string, string>();
    const resultByToolUseId = new Map<string, ToolResultHit>();
    let aggregateDirty = true;

    while (!signal?.aborted) {
      if (discoverMetaFiles(subagentsDir, tracked)) aggregateDirty = true;

      const transcriptOwners = transcriptFiles(mainTranscript, tracked);
      for (const transcript of transcriptOwners) {
        const read = readNewLines(transcript.path, fileStates);
        const node = transcript.nodeId === null ? null : (tracked.get(transcript.nodeId) ?? null);
        if (read.reset) {
          aggregateDirty = true;
          if (node !== null) node.currentActivity = null;
        }
        if (node !== null) node.firstJsonlTimestampMs = read.state.firstTimestampMs;
        if (read.lines.length > 0) aggregateDirty = true;
        for (const line of read.lines) {
          if (read.state.firstTimestampMs === null) {
            const ts = timestampMs(line);
            if (ts !== null) read.state.firstTimestampMs = ts;
          }
          if (node !== null) node.firstJsonlTimestampMs = read.state.firstTimestampMs;
          for (const id of extractSpawnToolUseIds(line)) read.state.ownerByToolUseId.set(id, transcript.owner);
          for (const hit of extractToolResults(line)) {
            read.state.resultByToolUseId.set(hit.id, { isError: hit.isError, ts: hit.ts });
          }
          if (node !== null) {
            const activity = latestActivitySummary(line);
            if (activity !== null) node.currentActivity = activity;
          }
        }
      }
      if (aggregateDirty) {
        ownerByToolUseId.clear();
        resultByToolUseId.clear();
        for (const transcript of transcriptOwners) {
          const state = fileStates.get(transcript.path);
          if (state === undefined) continue;
          for (const [id, owner] of state.ownerByToolUseId) ownerByToolUseId.set(id, owner);
          for (const [id, result] of state.resultByToolUseId) resultByToolUseId.set(id, result);
        }
        aggregateDirty = false;
      }

      for (const node of tracked.values()) {
        const result = resultByToolUseId.get(node.meta.toolUseId) ?? null;
        const status: SubagentNodeStatus = result === null ? "running" : (result.isError ? "error" : "completed");
        const ts = result?.ts ?? node.firstJsonlTimestampMs ?? mtimeMs(node.metaPath);
        const parentNodeId = ownerByToolUseId.get(node.meta.toolUseId) ?? fallbackParent(node.meta.spawnDepth);
        const messageNode: SubagentNode = {
          nodeId: node.nodeId,
          toolUseId: node.meta.toolUseId,
          parentNodeId,
          agentType: node.meta.agentType,
          label: node.meta.description,
          depth: node.meta.spawnDepth,
          status,
          currentActivity: status === "running" ? node.currentActivity : null,
          ts,
        };
        const key = stableNodeKey(messageNode);
        if (key === node.lastKey) continue;
        node.lastKey = key;
        yield { type: "subagent_node", v: PROTOCOL_V2, node: messageNode };
      }

      if (!this.tailIndefinitely) return;
      await abortableSleep(this.pollIntervalMs, signal);
    }
  }
}

function discoverMetaFiles(dir: string, tracked: Map<string, TrackedNode>): boolean {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let changed = false;
  for (const file of files.sort()) {
    const match = /^agent-(.+)\.meta\.json$/.exec(file);
    if (match === null) continue;
    const nodeId = match[1]!;
    const existing = tracked.get(nodeId);
    if (existing !== undefined) {
      const jsonlPath = siblingJsonl(existing.metaPath);
      if (existing.jsonlPath !== jsonlPath) {
        existing.jsonlPath = jsonlPath;
        changed = true;
      }
      continue;
    }
    const metaPath = path.join(dir, file);
    const meta = readMeta(metaPath);
    if (meta === null) continue;
    tracked.set(nodeId, {
      nodeId,
      meta,
      metaPath,
      jsonlPath: siblingJsonl(metaPath),
      firstJsonlTimestampMs: null,
      currentActivity: null,
      lastKey: null,
    });
    changed = true;
  }
  return changed;
}

function readMeta(metaPath: string): Meta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed["agentType"] !== "string" ||
      typeof parsed["description"] !== "string" ||
      typeof parsed["toolUseId"] !== "string" ||
      typeof parsed["spawnDepth"] !== "number"
    ) {
      return null;
    }
    return {
      agentType: parsed["agentType"],
      description: parsed["description"],
      toolUseId: parsed["toolUseId"],
      spawnDepth: parsed["spawnDepth"],
    };
  } catch {
    return null;
  }
}

function siblingJsonl(metaPath: string): string | null {
  const jsonl = metaPath.replace(/\.meta\.json$/, ".jsonl");
  return fs.existsSync(jsonl) ? jsonl : null;
}

function transcriptFiles(
  mainTranscript: string,
  tracked: Map<string, TrackedNode>,
): { path: string; owner: string; nodeId: string | null }[] {
  const out: { path: string; owner: string; nodeId: string | null }[] = [
    { path: mainTranscript, owner: "root", nodeId: null },
  ];
  for (const node of tracked.values()) {
    if (node.jsonlPath !== null) out.push({ path: node.jsonlPath, owner: node.nodeId, nodeId: node.nodeId });
  }
  return out;
}

function readNewLines(
  file: string,
  states: Map<string, FileTailState>,
): { lines: string[]; reset: boolean; state: FileTailState } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    const state = ensureFileState(file, states);
    return { lines: [], reset: false, state };
  }

  const state = ensureFileState(file, states);
  let reset = false;
  if (stat.size < state.position) {
    state.position = 0;
    state.lineBuf = Buffer.alloc(0);
    state.ownerByToolUseId.clear();
    state.resultByToolUseId.clear();
    state.firstTimestampMs = null;
    reset = true;
  }

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { lines: [], reset, state };
  }

  const out: string[] = [];
  const chunk = Buffer.alloc(4096);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, state.position);
      if (bytesRead === 0) break;
      state.position += bytesRead;
      state.lineBuf = Buffer.concat([state.lineBuf, chunk.subarray(0, bytesRead)]);
      let nl = state.lineBuf.indexOf(0x0a);
      while (nl >= 0) {
        const line = state.lineBuf.subarray(0, nl).toString("utf8").replaceAll("\r", "");
        state.lineBuf = state.lineBuf.subarray(nl + 1);
        if (line.length > 0) out.push(line);
        nl = state.lineBuf.indexOf(0x0a);
      }
    }
  } catch {
    return { lines: out, reset, state };
  } finally {
    // Subagent tailing watches a changing set of files, so each tick opens only for
    // the incremental read and closes immediately. Offsets and partial lines stay cached.
    try {
      fs.closeSync(fd);
    } catch {
      // 二重 close 等は無視。
    }
  }
  return { lines: out, reset, state };
}

function ensureFileState(file: string, states: Map<string, FileTailState>): FileTailState {
  let state = states.get(file);
  if (state === undefined) {
    state = {
      position: 0,
      lineBuf: Buffer.alloc(0),
      ownerByToolUseId: new Map(),
      resultByToolUseId: new Map(),
      firstTimestampMs: null,
    };
    states.set(file, state);
  }
  return state;
}

function extractSpawnToolUseIds(line: string): string[] {
  const content = messageContent(line);
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_use") continue;
    // 実データでは Agent、brief のサンプル/旧名では Task。どちらも同じ spawn path として扱う。
    if (rec["name"] !== "Task" && rec["name"] !== "Agent") continue;
    if (typeof rec["id"] === "string") ids.push(rec["id"]);
  }
  return ids;
}

function extractToolResults(line: string): { id: string; isError: boolean; ts: number | null }[] {
  const content = messageContent(line);
  const ts = timestampMs(line);
  if (!Array.isArray(content)) return [];
  const out: { id: string; isError: boolean; ts: number | null }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_result") continue;
    if (typeof rec["tool_use_id"] === "string") {
      out.push({ id: rec["tool_use_id"], isError: rec["is_error"] === true, ts });
    }
  }
  return out;
}

function latestActivitySummary(line: string): string | null {
  const activities = extractToolActivities(messageContent(line));
  const latest = activities.at(-1);
  return latest === undefined ? null : truncateActivityLabel(formatActivityLabel(latest));
}

function formatActivityLabel(activity: ToolActivity): string {
  switch (activity.name) {
    case "Bash":
      return `Bash: ${activity.command ?? activity.description ?? stripActivityPrefix(activity.label, activity.name)}`;
    case "Edit":
    case "MultiEdit":
      return `${activity.name} ${displayActivityTarget(activity)}`;
    case "Write":
    case "NotebookEdit":
      return `${activity.name} ${displayActivityTarget(activity)}`;
    case "Read":
      return `Read ${displayActivityTarget(activity)}`;
    case "TodoWrite":
      return "Todo更新";
    default: {
      const detail = displayActivityTarget(activity);
      return detail === activity.name ? activity.name : `${activity.name}: ${detail}`;
    }
  }
}

function displayActivityTarget(activity: ToolActivity): string {
  if (activity.file !== undefined && activity.file.length > 0) {
    const base = path.basename(activity.file);
    return base.length > 0 ? base : activity.file;
  }
  return stripActivityPrefix(activity.label, activity.name);
}

function stripActivityPrefix(label: string, fallback: string): string {
  const stripped = label
    .replace(/^(実行済み|編集済み|作成済み|既読|検索済み)\s*/, "")
    .replace(/^Todoを更新しました$/, "Todo更新")
    .trim();
  return stripped.length > 0 ? stripped : fallback;
}

function truncateActivityLabel(label: string): string {
  const limit = 60;
  return label.length <= limit ? label : `${label.slice(0, limit - 1)}…`;
}

function messageContent(line: string): unknown {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const message = obj["message"];
    if (typeof message === "object" && message !== null) {
      return (message as Record<string, unknown>)["content"];
    }
    return obj["content"];
  } catch {
    return null;
  }
}

function timestampMs(line: string): number | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj["timestamp"] !== "string") return null;
    const ms = Date.parse(obj["timestamp"]);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function mtimeMs(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

function fallbackParent(depth: number): string | null {
  return depth <= 1 ? "root" : null;
}

function stableNodeKey(node: SubagentNode): string {
  return JSON.stringify([
    node.nodeId,
    node.toolUseId,
    node.parentNodeId ?? null,
    node.agentType,
    node.label,
    node.depth,
    node.status,
    node.currentActivity ?? null,
    node.ts,
  ]);
}
