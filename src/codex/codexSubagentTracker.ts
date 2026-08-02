// Codex App Server の sub-agent lifecycle を Tailii 共通の subagent_node へ写像する。

import type { SubagentNode, SubagentNodeStatus } from "../protocol.js";

interface ThreadMetadata {
  parentThreadId: string;
  depth: number | null;
  label: string | null;
  agentType: string | null;
}

/**
 * App Server は spawn / wait / resume を collabAgentToolCall item として、子 thread 自体を
 * thread/* notification として流す。両方を nodeId（子 thread ID）で合流し、Claude と同じ
 * workflow UI が扱える安定したノードへ落とす。
 */
export class CodexSubagentTracker {
  private readonly metadata = new Map<string, ThreadMetadata>();
  private readonly nodes = new Map<string, SubagentNode>();

  constructor(private readonly rootThreadId: string) {}

  ingestThreadStarted(thread: Record<string, unknown>, nowMs: number): SubagentNode[] {
    const nodeId = stringValue(thread["id"]);
    const parentThreadId = stringValue(thread["parentThreadId"]);
    if (nodeId === null || nodeId === this.rootThreadId || parentThreadId === null) return [];

    const sourceMetadata = parseSubagentSource(thread["source"]);
    const metadata: ThreadMetadata = {
      parentThreadId,
      depth: sourceMetadata.depth,
      label: normalizedLabel(stringValue(thread["preview"])),
      agentType: firstNonEmptyString(
        stringValue(thread["agentRole"]),
        sourceMetadata.agentRole,
        sourceMetadata.agentNickname,
        stringValue(thread["agentNickname"]),
      ),
    };
    this.metadata.set(nodeId, metadata);

    return this.upsert(nodeId, {
      toolUseId: `thread:${nodeId}`,
      parentThreadId: metadata.parentThreadId,
      depth: metadata.depth,
      label: metadata.label,
      agentType: metadata.agentType,
      // thread/started は子 turn の開始直前に idle/notLoaded を持つことがある。
      // lifecycle 開始通知そのものを running とし、以後の status/changed で終端させる。
      status: threadStartedStatus(thread["status"]),
      currentActivity: null,
    }, nowMs);
  }

  ingestThreadStatus(
    threadId: string,
    rawStatus: unknown,
    nowMs: number,
  ): SubagentNode[] {
    if (threadId === this.rootThreadId || !this.nodes.has(threadId)) return [];
    return this.upsert(threadId, {
      status: threadStatus(rawStatus, this.nodes.get(threadId)!.status),
      currentActivity: null,
    }, nowMs);
  }

  /** 再オープン時の thread/read snapshot。live通知と違い、保存済み時刻へ置き換える。 */
  ingestThreadSnapshot(
    threadId: string,
    rawStatus: unknown,
    timestampMs: number,
  ): SubagentNode[] {
    if (threadId === this.rootThreadId || !this.nodes.has(threadId)) return [];
    return this.upsert(threadId, {
      status: threadStatus(rawStatus, this.nodes.get(threadId)!.status),
      currentActivity: null,
    }, timestampMs, true);
  }

  ingestThreadClosed(threadId: string, nowMs: number): SubagentNode[] {
    if (threadId === this.rootThreadId || !this.nodes.has(threadId)) return [];
    return this.upsert(threadId, { status: "completed", currentActivity: null }, nowMs);
  }

  settleRunning(status: SubagentNodeStatus, nowMs: number): SubagentNode[] {
    const updates: SubagentNode[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (node.status !== "running") continue;
      updates.push(...this.upsert(nodeId, { status, currentActivity: null }, nowMs));
    }
    return updates;
  }

  ingestItem(item: Record<string, unknown>, nowMs: number): SubagentNode[] {
    if (item["type"] === "subAgentActivity") return this.ingestSubagentActivity(item, nowMs);
    if (item["type"] !== "collabAgentToolCall") return [];

    const tool = stringValue(item["tool"]);
    const toolUseId = stringValue(item["id"]) ?? "codex-collab";
    const senderThreadId = stringValue(item["senderThreadId"]) ?? this.rootThreadId;
    const targets = collabTargets(item);
    const states = recordValue(item["agentsStates"]);
    const legacyState = item["agentStatus"];
    const updates: SubagentNode[] = [];

    for (const nodeId of targets) {
      if (nodeId === this.rootThreadId) continue;
      const existing = this.nodes.get(nodeId);
      const metadata = this.metadata.get(nodeId);
      const rawState = recordValue(states?.[nodeId]) ?? legacyAgentState(legacyState, nodeId);
      const mappedStatus = collabStatus(rawState?.["status"], item["status"], tool, existing?.status);
      const stateMessage = normalizedActivity(stringValue(rawState?.["message"]));
      const prompt = normalizedLabel(stringValue(item["prompt"]));
      const parentThreadId = metadata?.parentThreadId ?? senderThreadId;
      const depth = metadata?.depth ?? inferredDepth(this.nodes.get(parentThreadId));
      const existingLabel = existing?.label === "Codex sub-agent" ? null : existing?.label;
      const existingAgentType = existing?.agentType === "Codex" ? null : existing?.agentType;
      updates.push(...this.upsert(nodeId, {
        toolUseId: tool === "spawnAgent" || existing === undefined
          ? toolUseId
          : existing.toolUseId,
        parentThreadId,
        depth,
        label: metadata?.label ?? existingLabel ?? prompt,
        agentType: metadata?.agentType ?? existingAgentType ?? stringValue(item["model"]),
        status: mappedStatus,
        currentActivity: mappedStatus === "running" ? stateMessage : null,
      }, nowMs));
    }
    return updates;
  }

  private ingestSubagentActivity(item: Record<string, unknown>, nowMs: number): SubagentNode[] {
    const nodeId = stringValue(item["agentThreadId"]);
    if (nodeId === null || nodeId === this.rootThreadId) return [];
    const kind = stringValue(item["kind"]);
    const agentPath = stringValue(item["agentPath"]);
    const existing = this.nodes.get(nodeId);
    const metadata = this.metadata.get(nodeId);
    return this.upsert(nodeId, {
      toolUseId: existing?.toolUseId ?? (stringValue(item["id"]) ?? `thread:${nodeId}`),
      parentThreadId: existing?.parentNodeId ?? metadata?.parentThreadId ?? this.rootThreadId,
      depth: existing?.depth ?? metadata?.depth,
      label: existing?.label ?? metadata?.label ?? labelFromAgentPath(agentPath),
      agentType: metadata?.agentType ?? existing?.agentType,
      status: kind === "interrupted" ? "completed" : "running",
      currentActivity: kind === "interacted" ? "親エージェントと連携中" : null,
    }, nowMs);
  }

  private upsert(
    nodeId: string,
    update: {
      toolUseId?: string;
      parentThreadId?: string | null;
      depth?: number | null;
      label?: string | null;
      agentType?: string | null;
      status: SubagentNodeStatus;
      currentActivity?: string | null;
    },
    nowMs: number,
    replaceTimestamp = false,
  ): SubagentNode[] {
    const existing = this.nodes.get(nodeId);
    const parentThreadId = normalizeParent(
      update.parentThreadId ?? existing?.parentNodeId ?? this.rootThreadId,
      this.rootThreadId,
    );
    const statusChanged = existing !== undefined && existing.status !== update.status;
    const ts = existing === undefined || statusChanged || replaceTimestamp ? nowMs : existing.ts;
    const node: SubagentNode = {
      nodeId,
      toolUseId: update.toolUseId ?? existing?.toolUseId ?? `thread:${nodeId}`,
      parentNodeId: parentThreadId,
      agentType: update.agentType ?? existing?.agentType ?? "Codex",
      label: update.label ?? existing?.label ?? "Codex sub-agent",
      depth: update.depth ?? existing?.depth ?? inferredDepth(this.nodes.get(parentThreadId ?? "")),
      status: update.status,
      currentActivity: update.status === "running"
        ? (update.currentActivity ?? existing?.currentActivity ?? null)
        : null,
      ts,
    };
    if (existing !== undefined && stableNodeKey(existing) === stableNodeKey(node)) return [];
    this.nodes.set(nodeId, node);
    return [node];
  }
}

function collabTargets(item: Record<string, unknown>): string[] {
  const values: string[] = [];
  if (Array.isArray(item["receiverThreadIds"])) {
    for (const value of item["receiverThreadIds"]) {
      if (typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  for (const key of ["receiverThreadId", "newThreadId"] as const) {
    const value = stringValue(item[key]);
    if (value !== null) values.push(value);
  }
  const states = recordValue(item["agentsStates"]);
  if (states !== null) values.push(...Object.keys(states));
  return [...new Set(values)];
}

function legacyAgentState(value: unknown, nodeId: string): Record<string, unknown> | null {
  const record = recordValue(value);
  if (record !== null) {
    const perAgent = recordValue(record[nodeId]);
    return perAgent ?? record;
  }
  return typeof value === "string" ? { status: value } : null;
}

function collabStatus(
  rawAgentStatus: unknown,
  rawToolStatus: unknown,
  tool: string | null,
  existing: SubagentNodeStatus | undefined,
): SubagentNodeStatus {
  switch (rawAgentStatus) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
    case "interrupted":
    case "shutdown":
      return "completed";
    case "errored":
    case "notFound":
      return "error";
  }
  if (rawToolStatus === "failed") return "error";
  if (tool === "closeAgent" && rawToolStatus === "completed") return "completed";
  if (tool === "spawnAgent" || tool === "sendInput" || tool === "resumeAgent") return "running";
  return existing ?? "running";
}

function threadStatus(
  value: unknown,
  fallback: SubagentNodeStatus,
): SubagentNodeStatus {
  const type = stringValue(recordValue(value)?.["type"] ?? value);
  switch (type) {
    case "active": return "running";
    case "idle":
    case "notLoaded": return "completed";
    case "systemError": return "error";
    default: return fallback;
  }
}

function threadStartedStatus(value: unknown): SubagentNodeStatus {
  const type = stringValue(recordValue(value)?.["type"] ?? value);
  return type === "systemError" ? "error" : "running";
}

function parseSubagentSource(value: unknown): {
  depth: number | null;
  agentNickname: string | null;
  agentRole: string | null;
} {
  const source = recordValue(value);
  const subagent = recordValue(source?.["subAgent"] ?? source?.["subagent"]);
  const spawn = recordValue(subagent?.["thread_spawn"]);
  return {
    depth: nonNegativeInteger(spawn?.["depth"]),
    agentNickname: stringValue(spawn?.["agent_nickname"]),
    agentRole: stringValue(spawn?.["agent_role"]),
  };
}

function inferredDepth(parent: SubagentNode | undefined): number {
  return parent === undefined ? 1 : parent.depth + 1;
}

function normalizeParent(parentThreadId: string | null, rootThreadId: string): string | null {
  return parentThreadId === rootThreadId ? "root" : parentThreadId;
}

function normalizedLabel(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function normalizedActivity(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function labelFromAgentPath(value: string | null): string | null {
  if (value === null) return null;
  const segments = value.split("/").filter((segment) => segment.length > 0);
  return normalizedLabel(segments.at(-1) ?? null);
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

function firstNonEmptyString(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value !== null && value.trim().length > 0) return value;
  }
  return null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
