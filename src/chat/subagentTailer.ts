// subagentTailer.ts
// tailii (TS host) — サブエージェント進捗ツリー tail
// Swift 版 SubagentTailer.swift の移植。
// claude の `<sessionId>/subagents/agent-*.meta.json` と main/subagent transcript を監視し、
// subagent_node（spawn/running → completed/error）を engine チャネルへ流す。

import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_V2, type ControlMessage, type SubagentNode, type SubagentNodeStatus, type ToolActivity } from "../protocol.js";
import { abortableSleep } from "../shared/sleep.js";
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
  lastJsonlTimestampMs: number | null;
  currentActivity: string | null;
  lastKey: string | null;
}

interface ToolResultHit {
  isError: boolean;
  ts: number | null;
  /** バックグラウンド起動の即時 ack（"Async agent launched…"）。終了扱いにしない。 */
  asyncLaunch: boolean;
}

/** 親 transcript の `<task-notification>` 行（バックグラウンド作業の真の完了信号）。 */
interface TaskNotification {
  status: string;
  exitCode: number | null;
  ts: number | null;
}

/** バックグラウンドコマンド（Bash run_in_background）の spawn 観測。 */
interface BackgroundSpawn {
  label: string;
  ts: number | null;
}

interface BackgroundCommand {
  taskId: string;
  toolUseId: string;
  owner: string;
  label: string;
  startTs: number | null;
  outputPath: string | null;
}

interface FileTailState {
  position: number;
  lineBuf: Buffer;
  ownerByToolUseId: Map<string, string>;
  resultByToolUseId: Map<string, ToolResultHit>;
  notificationByTaskId: Map<string, TaskNotification>;
  bgSpawnByToolUseId: Map<string, BackgroundSpawn>;
  bgCommandByTaskId: Map<string, BackgroundCommand>;
  firstTimestampMs: number | null;
}

/** サブエージェント meta/jsonl と親 transcript の tool_result を監視する。 */
export class SubagentTailer {
  private readonly pollIntervalMs: number;
  private readonly tailIndefinitely: boolean;
  private readonly jsonlPaths = new Map<string, string>();
  private readonly outputPaths = new Map<string, string>();

  constructor(options: SubagentTailerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.tailIndefinitely = options.tailIndefinitely ?? true;
  }

  /** 現在 tail 中の nodeId から transcript 実体を引く。 */
  jsonlPath(nodeId: string): string | null {
    return this.jsonlPaths.get(nodeId) ?? null;
  }

  /** バックグラウンドコマンドの nodeId(taskId) から出力ファイルを引く。 */
  outputPath(nodeId: string): string | null {
    return this.outputPaths.get(nodeId) ?? null;
  }

  async *streamProjectDir(
    projectDir: string,
    preferredSessionId: string | null,
    newerThanMs: number | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    this.jsonlPaths.clear();
    this.outputPaths.clear();
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
    const notificationByTaskId = new Map<string, TaskNotification>();
    const bgCommandByTaskId = new Map<string, BackgroundCommand>();
    const bgLastKeyByTaskId = new Map<string, string>();
    let aggregateDirty = true;

    while (!signal?.aborted) {
      if (discoverMetaFiles(subagentsDir, tracked)) aggregateDirty = true;
      for (const node of tracked.values()) {
        if (node.jsonlPath !== null) this.jsonlPaths.set(node.nodeId, node.jsonlPath);
      }

      const transcriptOwners = transcriptFiles(mainTranscript, tracked);
      for (const transcript of transcriptOwners) {
        const read = readNewLines(transcript.path, fileStates);
        const node = transcript.nodeId === null ? null : (tracked.get(transcript.nodeId) ?? null);
        if (read.reset) {
          aggregateDirty = true;
          if (node !== null) {
            node.currentActivity = null;
            node.lastJsonlTimestampMs = null;
          }
        }
        if (node !== null) node.firstJsonlTimestampMs = read.state.firstTimestampMs;
        if (read.lines.length > 0) aggregateDirty = true;
        for (const line of read.lines) {
          const lineTs = timestampMs(line);
          if (read.state.firstTimestampMs === null && lineTs !== null) {
            read.state.firstTimestampMs = lineTs;
          }
          if (node !== null) {
            node.firstJsonlTimestampMs = read.state.firstTimestampMs;
            if (lineTs !== null) node.lastJsonlTimestampMs = lineTs;
          }
          for (const id of extractSpawnToolUseIds(line)) read.state.ownerByToolUseId.set(id, transcript.owner);
          for (const spawn of extractBackgroundSpawns(line)) {
            read.state.bgSpawnByToolUseId.set(spawn.id, { label: spawn.label, ts: lineTs });
          }
          for (const hit of extractToolResults(line)) {
            read.state.resultByToolUseId.set(hit.id, {
              isError: hit.isError,
              ts: hit.ts,
              asyncLaunch: hit.asyncLaunch,
            });
            const launch = hit.backgroundLaunch;
            const spawn = read.state.bgSpawnByToolUseId.get(hit.id);
            if (launch !== null && spawn !== undefined) {
              read.state.bgCommandByTaskId.set(launch.taskId, {
                taskId: launch.taskId,
                toolUseId: hit.id,
                owner: transcript.owner,
                label: spawn.label,
                startTs: spawn.ts ?? hit.ts,
                outputPath: launch.outputPath,
              });
            }
            // TaskStop で停止されたタスクは task-notification を残さない。
            // 停止 ack を「静かな完了」として通知と同列に扱う。
            if (hit.stoppedTaskId !== null) {
              read.state.notificationByTaskId.set(hit.stoppedTaskId, {
                status: "completed",
                exitCode: null,
                ts: hit.ts ?? lineTs,
              });
            }
          }
          const notification = extractTaskNotification(line);
          if (notification !== null) {
            read.state.notificationByTaskId.set(notification.taskId, {
              status: notification.status,
              exitCode: notification.exitCode,
              ts: notification.ts ?? lineTs,
            });
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
        notificationByTaskId.clear();
        bgCommandByTaskId.clear();
        for (const transcript of transcriptOwners) {
          const state = fileStates.get(transcript.path);
          if (state === undefined) continue;
          for (const [id, owner] of state.ownerByToolUseId) ownerByToolUseId.set(id, owner);
          for (const [id, result] of state.resultByToolUseId) resultByToolUseId.set(id, result);
          for (const [id, notification] of state.notificationByTaskId) {
            const existing = notificationByTaskId.get(id);
            if (existing === undefined || (notification.ts ?? 0) >= (existing.ts ?? 0)) {
              notificationByTaskId.set(id, notification);
            }
          }
          for (const [id, command] of state.bgCommandByTaskId) bgCommandByTaskId.set(id, command);
        }
        aggregateDirty = false;
      }

      for (const node of tracked.values()) {
        const result = resultByToolUseId.get(node.meta.toolUseId) ?? null;
        let status: SubagentNodeStatus;
        let ts: number;
        if (result !== null && !result.asyncLaunch) {
          // 同期実行: 親 transcript の tool_result が終了信号。
          status = result.isError ? "error" : "completed";
          ts = result.ts ?? node.firstJsonlTimestampMs ?? mtimeMs(node.metaPath);
        } else {
          // バックグラウンド実行（または結果未着）: task-notification が終了信号。
          // 通知後に自分の transcript が伸びたら resume とみなし running へ戻す。
          const notification = notificationByTaskId.get(node.nodeId) ?? null;
          const resumedAfter = notification !== null && notification.ts !== null
            && (node.lastJsonlTimestampMs ?? 0) > notification.ts;
          if (notification !== null && !resumedAfter) {
            status = notification.status === "completed" ? "completed" : "error";
            ts = notification.ts ?? node.lastJsonlTimestampMs ?? mtimeMs(node.metaPath);
          } else {
            status = "running";
            ts = node.firstJsonlTimestampMs ?? mtimeMs(node.metaPath);
          }
        }
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

      for (const command of bgCommandByTaskId.values()) {
        if (command.outputPath !== null) this.outputPaths.set(command.taskId, command.outputPath);
        const notification = notificationByTaskId.get(command.taskId) ?? null;
        const failed = notification !== null
          && (notification.status !== "completed" || (notification.exitCode ?? 0) !== 0);
        const status: SubagentNodeStatus = notification === null ? "running" : (failed ? "error" : "completed");
        const ownerNode = tracked.get(command.owner) ?? null;
        const messageNode: SubagentNode = {
          nodeId: command.taskId,
          toolUseId: command.toolUseId,
          parentNodeId: command.owner,
          agentType: "Bash",
          label: command.label,
          depth: ownerNode === null ? 1 : ownerNode.meta.spawnDepth + 1,
          status,
          currentActivity: null,
          ts: notification?.ts ?? command.startTs ?? 0,
          kind: "command",
        };
        const key = stableNodeKey(messageNode);
        if (key === bgLastKeyByTaskId.get(command.taskId)) continue;
        bgLastKeyByTaskId.set(command.taskId, key);
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
      lastJsonlTimestampMs: null,
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
    state.notificationByTaskId.clear();
    state.bgSpawnByToolUseId.clear();
    state.bgCommandByTaskId.clear();
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
      notificationByTaskId: new Map(),
      bgSpawnByToolUseId: new Map(),
      bgCommandByTaskId: new Map(),
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

interface ToolResultExtract {
  id: string;
  isError: boolean;
  ts: number | null;
  asyncLaunch: boolean;
  backgroundLaunch: { taskId: string; outputPath: string | null } | null;
  /** TaskStop の停止 ack。停止されたタスクは task-notification を残さないため、これが終了信号。 */
  stoppedTaskId: string | null;
}

function extractToolResults(line: string): ToolResultExtract[] {
  const content = messageContent(line);
  const ts = timestampMs(line);
  if (!Array.isArray(content)) return [];
  const out: ToolResultExtract[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_result") continue;
    if (typeof rec["tool_use_id"] !== "string") continue;
    const text = toolResultPlainText(rec["content"]);
    const bgMatch = /Command running in background with ID: (\S+?)\.?(?:\s|$)/.exec(text);
    const outputMatch = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text);
    const stopMatch = /Successfully stopped task: ([A-Za-z0-9_-]+)/.exec(text);
    out.push({
      id: rec["tool_use_id"],
      isError: rec["is_error"] === true,
      ts,
      asyncLaunch: text.startsWith("Async agent launched successfully"),
      backgroundLaunch: bgMatch === null
        ? null
        : { taskId: bgMatch[1]!, outputPath: outputMatch?.[1] ?? null },
      stoppedTaskId: stopMatch?.[1] ?? null,
    });
  }
  return out;
}

function toolResultPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] === "text" && typeof rec["text"] === "string") parts.push(rec["text"]);
  }
  return parts.join("\n");
}

/** Bash の run_in_background 起動（バックグラウンドコマンド）の tool_use を抽出する。 */
function extractBackgroundSpawns(line: string): { id: string; label: string }[] {
  const content = messageContent(line);
  if (!Array.isArray(content)) return [];
  const out: { id: string; label: string }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_use" || rec["name"] !== "Bash") continue;
    if (typeof rec["id"] !== "string") continue;
    const input = typeof rec["input"] === "object" && rec["input"] !== null
      ? rec["input"] as Record<string, unknown>
      : null;
    if (input?.["run_in_background"] !== true) continue;
    const description = typeof input["description"] === "string" ? input["description"] : "";
    const command = typeof input["command"] === "string" ? input["command"] : "";
    const label = description.length > 0 ? description : truncateActivityLabel(command);
    out.push({ id: rec["id"], label: label.length > 0 ? label : "background command" });
  }
  return out;
}

/**
 * 親 transcript の `<task-notification>` 行（user メッセージの文字列 content）を解析する。
 * バックグラウンドのエージェント/コマンド共通の完了信号で、task-id はエージェントの
 * nodeId またはコマンドの taskId に一致する。
 */
function extractTaskNotification(
  line: string,
): { taskId: string; status: string; exitCode: number | null; ts: number | null } | null {
  const content = messageContent(line);
  if (typeof content !== "string" || !content.includes("<task-notification>")) return null;
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1];
  if (taskId === undefined) return null;
  const status = /<status>([^<]+)<\/status>/.exec(content)?.[1] ?? "completed";
  const summary = /<summary>([^<]*)<\/summary>/.exec(content)?.[1] ?? "";
  const exitCode = /exit code (\d+)/.exec(summary)?.[1];
  return {
    taskId,
    status,
    exitCode: exitCode === undefined ? null : Number(exitCode),
    ts: timestampMs(line),
  };
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
    node.kind ?? null,
  ]);
}
