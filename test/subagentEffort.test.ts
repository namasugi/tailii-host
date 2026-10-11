// subagentEffort.test.ts — サブエージェントの工数（subagent-effort, 2026-10-11 の CLI 追随）
// Codex の `reasoningEffort`（spawnAgent の要求値 / subAgentActivity の確定値）と wire の往復。
// Claude 側（transcript の `effort`）は subagentTailer.test.ts。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexSubagentTracker } from "../src/codex/codexSubagentTracker.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";

const hostRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("subagent-effort: Codex のサブエージェント工数", () => {
  const spawn = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "spawn-a", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
    senderThreadId: "root", receiverThreadIds: ["child"], prompt: "調査", model: "gpt-6.1-sol",
    reasoningEffort: "high", agentsStates: { child: { status: "running", message: null } },
    ...overrides,
  });
  const activity = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "activity-a", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/task",
    ...overrides,
  });

  it("spawnAgent の要求値を載せ、subAgentActivity の確定値（0.162+）で上書きする", () => {
    const tracker = new CodexSubagentTracker("root");
    expect(tracker.ingestItem(spawn(), 1).map((node) => [node.model, node.effort])).toEqual([["gpt-6.1-sol", "high"]]);
    expect(tracker.ingestItem(activity({ model: "gpt-6.1-sol", reasoningEffort: "medium" }), 2)
      .map((node) => [node.model, node.effort])).toEqual([["gpt-6.1-sol", "medium"]]);
    // 以後の item（wait 等。工数は null）で確定値を落とさない / 要求値へ戻さない。
    expect(tracker.ingestItem(spawn({ id: "wait-a", tool: "wait", model: null, reasoningEffort: null }), 3)
      .every((node) => node.effort === "medium")).toBe(true);
    expect(tracker.ingestItem(spawn({ reasoningEffort: "low" }), 4).every((node) => node.effort === "medium")).toBe(true);
  });

  it("旧版（工数なし）・工数として読めない値では effort を載せない", () => {
    const tracker = new CodexSubagentTracker("root");
    const nodes = [
      ...tracker.ingestItem(activity(), 1),
      ...tracker.ingestItem(spawn({ reasoningEffort: null }), 2),
      ...tracker.ingestItem(activity({ id: "activity-b", reasoningEffort: "Very High!" }), 3),
      ...tracker.ingestItem(activity({ id: "activity-c", reasoningEffort: 3 }), 4),
    ];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((node) => node.effort === undefined)).toBe(true);
  });

  it("ノード生成前に届いたモデル変更（保留分）は、subAgentActivity の生成時モデルより優先する", () => {
    const tracker = new CodexSubagentTracker("root");
    tracker.ingestThreadModel("child", "gpt-6-luna", 1);
    expect(tracker.ingestItem(activity({ model: "gpt-6.1-sol", reasoningEffort: "medium" }), 2)[0])
      .toMatchObject({ model: "gpt-6-luna", effort: "medium" });
  });

  it("subAgentActivity のモデルは未判明のときだけ採り、子 thread 自身の申告を上書きしない", () => {
    const tracker = new CodexSubagentTracker("root");
    expect(tracker.ingestItem(activity({ model: "gpt-6.1-sol", reasoningEffort: "medium" }), 1)[0]?.model)
      .toBe("gpt-6.1-sol");
    tracker.ingestThreadStarted({ id: "child", parentThreadId: "root", model: "gpt-6-luna" }, 2);
    const later = tracker.ingestItem(activity({ id: "activity-b", kind: "interacted", model: "gpt-6.1-sol" }), 3);
    expect(later[0]).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
  });
});

describe("golden: subagent-effort-v1.ndjson", () => {
  const read = (name: string): string[] =>
    fs.readFileSync(path.join(hostRoot, "protocol", name), "utf8").split("\n").filter((line) => line.length > 0);

  it("全行が byte-exact でラウンドトリップし、effort を復号する", () => {
    const lines = read("subagent-effort-v1.ndjson");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect(lines.map((line) => (decodeControlMessage(line) as { node: { effort?: string | null } }).node.effort))
      .toEqual(["xhigh", "medium", undefined]);
  });
});
