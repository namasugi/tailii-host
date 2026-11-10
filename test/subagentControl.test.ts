// subagentControl.test.ts — バックグラウンドタスクからのエージェント操作（subagent-control）。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { CodexNativeTurnController } from "../src/codex/codexNativeTurnController.js";
import { decodeHubClientLine, decodeHubServerLine, encodeHubMessage } from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { keybindingsTouchKillAgents, killAgentsKeyIsDefault } from "../src/shared/claudeKeybindings.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const hostRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("キー設定: エージェントの全停止（chat:killAgents）", () => {
  test("割り当てに触れていれば送らない", () => {
    expect(keybindingsTouchKillAgents('{"bindings":[{"context":"Chat","bindings":{"ctrl+x ctrl+k":null}}]}')).toBe(true);
    expect(keybindingsTouchKillAgents('{"bindings":[{"context":"Chat","bindings":{"ctrl+k":"chat:killAgents"}}]}')).toBe(true);
    expect(keybindingsTouchKillAgents('{"bindings":[{"context":"Chat","bindings":{"ctrl+x ctrl+e":"chat:externalEditor"}}]}')).toBe(false);
    // 前置キー単独の割り当て変更も送らない。
    expect(keybindingsTouchKillAgents('{"bindings":[{"context":"Chat","bindings":{"ctrl+k":"chat:clearInput"}}]}')).toBe(true);
    expect(keybindingsTouchKillAgents('{"bindings":[{"context":"Global","bindings":{"ctrl+x": null}}]}')).toBe(true);
  });

  test("keybindings.json が無ければ既定、読めなければ送らない", () => {
    const dir = makeTempDir("killagents-keys");
    expect(killAgentsKeyIsDefault(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, "keybindings.json"), '{"bindings":[]}');
    expect(killAgentsKeyIsDefault(dir)).toBe(true);
    fs.mkdirSync(path.join(dir, "bad"));
    fs.mkdirSync(path.join(dir, "bad", "keybindings.json"));
    expect(killAgentsKeyIsDefault(path.join(dir, "bad"))).toBe(false);
  });
});

describe("wire / hub protocol", () => {
  test("golden: subagent-control-v1.ndjson が byte-exact でラウンドトリップする", () => {
    const lines = fs.readFileSync(path.join(hostRoot, "protocol", "subagent-control-v1.ndjson"), "utf8")
      .split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect(() => decodeControlMessage('{"action":"explode","id":"x","type":"subagent_control_request","v":2}')).toThrow();
  });

  test("hub 内部メッセージの往復", () => {
    const request = { type: "subagent_control" as const, id: "c1", session: "work", action: "message" as const, nodeId: "t1", text: "続けて" };
    expect(decodeHubClientLine(encodeHubMessage(request))).toEqual(request);
    expect(decodeHubClientLine(JSON.stringify({ ...request, action: "nope" }))).toBeNull();
    const result = { type: "subagent_control_result" as const, id: "c1", status: "not_running" as const };
    expect(decodeHubServerLine(encodeHubMessage(result))).toEqual(result);
  });
});

describe("SessionHub: エージェント操作の振り分け", () => {
  const makeHub = (options: Partial<ConstructorParameters<typeof SessionHub>[0]> = {}, agent: "claude" | "codex" = "claude") => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0, providerSessionId: "p1", ...(agent === "codex" ? { agent } : {}) });
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("subagent-control-hb"), metadataStore, timeoutSeconds: 1800,
      ...options,
    });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    const send = (message: Record<string, unknown>) => hub.handleClientMessage(client, JSON.stringify({ type: "subagent_control", session: "work", ...message }));
    return { hub, received, send };
  };

  test("Claude: 全停止はキーを送り、個別の停止・メッセージは unsupported（iOS が会話本体へ頼む）", async () => {
    const killAllAgents = vi.fn(async () => true);
    const { received, send } = makeHub({ killAllAgents });
    send({ id: "a", action: "stop_all" });
    send({ id: "b", action: "stop", nodeId: "agent-1" });
    send({ id: "c", action: "message", nodeId: "agent-1", text: "x" });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(killAllAgents).toHaveBeenCalledWith("work");
    expect(received).toContainEqual({ type: "subagent_control_result", id: "a", status: "ok" });
    expect(received).toContainEqual({ type: "subagent_control_result", id: "b", status: "unsupported" });
    expect(received).toContainEqual({ type: "subagent_control_result", id: "c", status: "unsupported" });
  });

  test("Claude: キー設定が変えられていて送れなければ理由つきで failed", async () => {
    const { received, send } = makeHub({ killAllAgents: async () => false });
    send({ id: "a", action: "stop_all" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ status: "failed", error: expect.stringContaining("chat:killAgents") });
  });
});

describe("CodexNativeTurnController: 子 thread の操作", () => {
  test("会話を開いていなければ子を止めない・送れない", async () => {
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => { throw new Error("unused"); } } as never,
    });
    expect(await controller.interruptSubagent("work", "child")).toBe(false);
    await expect(controller.sendToSubagent("work", "child", "x")).rejects.toThrow();
  });
});

describe("会話一覧のエージェント数（session-agent-count）", () => {
  const makeHub = () => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0, providerSessionId: "p1" });
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("agent-count-hb"), metadataStore, timeoutSeconds: 1800,
    });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    return { hub, client, received };
  };

  test("hook の開始 / 終了で数え、変わったときだけ配る。接続直後は全件を送る", () => {
    const { hub, client, received } = makeHub();
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "start", agentId: "a1" });
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "start", agentId: "a2" });
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "start", agentId: "a2" });
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "stop", agentId: "a1" });
    expect(received).toEqual([
      { type: "session_agents", items: [{ session: "work", running: 1 }] },
      { type: "session_agents", items: [{ session: "work", running: 2 }] },
      { type: "session_agents", items: [{ session: "work", running: 1 }] },
    ]);
    received.length = 0;
    hub.handleClientMessage(client, JSON.stringify({ type: "hub_hello" }));
    expect(received).toEqual([{ type: "session_agents", items: [{ session: "work", running: 1 }], replace: true }]);
    expect(decodeHubServerLine(encodeHubMessage({ type: "session_agents", items: [{ session: "w", running: 0 }], replace: true })))
      .toEqual({ type: "session_agents", items: [{ session: "w", running: 0 }], replace: true });
  });

  test("tail している会話は transcript の状態で揃える（コマンドは数えない）", async () => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0, providerSessionId: "p1" });
    const writes: Array<(payload: import("../src/protocol.js").ControlMessage) => void> = [];
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("agent-count-tail-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: (write) => { writes.push(write); return { open() {}, stop() {} }; },
    });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    const node = (nodeId: string, status: "running" | "completed", kind?: "command") => ({
      type: "subagent_node" as const, v: 2,
      node: { nodeId, toolUseId: "t", parentNodeId: "root", agentType: "Explore", label: "x", depth: 1, status, ts: 1, ...(kind ? { kind } : {}) },
    });
    writes[0]!(node("a1", "running"));
    writes[0]!(node("b1", "running", "command"));
    writes[0]!(node("a1", "completed"));
    const counts = received.filter((m) => (m as { type: string }).type === "session_agents");
    expect(counts).toEqual([
      { type: "session_agents", items: [{ session: "work", running: 1 }] },
      { type: "session_agents", items: [{ session: "work", running: 0 }] },
    ]);
  });

  test("tail でしか知らないエージェントは購読が切れたら外し、hook で知ったものは残す", () => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0, providerSessionId: "p1" });
    const writes: Array<(payload: import("../src/protocol.js").ControlMessage) => void> = [];
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("agent-count-drop-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: (write) => { writes.push(write); return { open() {}, stop() {} }; },
    });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    const running = (nodeId: string) => ({
      type: "subagent_node" as const, v: 2,
      node: { nodeId, toolUseId: "t", parentNodeId: "root", agentType: "Explore", label: "x", depth: 1, status: "running" as const, ts: 1 },
    });
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "start", agentId: "hooked" });
    writes[0]!(running("hooked"));
    writes[0]!(running("tailOnly"));
    received.length = 0;
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_unsubscribe", session: "work" }));
    expect(received.filter((m) => (m as { type: string }).type === "session_agents"))
      .toEqual([{ type: "session_agents", items: [{ session: "work", running: 1 }] }]);
  });

  test("取りこぼしたエージェントは最後に見てから時間が経ったら外す", () => {
    // （tick はテスト環境では会話を生きていない扱いで先に片付けるので、間引きは全件一覧で確かめる）
    const { hub } = makeHub();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "start", agentId: "lost" });
    now.mockReturnValue(1_000_000 + 5 * 60 * 60 * 1000);
    expect(hub.runningAgentCounts).toEqual([{ session: "work", running: 1 }]);
    now.mockReturnValue(1_000_000 + 7 * 60 * 60 * 1000);
    expect(hub.runningAgentCounts).toEqual([]);
    now.mockRestore();
  });

  test("サブエージェントのツール呼び出し（session_processing の agentId）で最後に見た時刻を更新し、長く走っても外さない", () => {
    const { hub, received } = makeHub();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    hub.handleRelayMessage({ type: "subagent_lifecycle", session: "work", event: "start", agentId: "long" });
    now.mockReturnValue(1_000_000 + 5 * 60 * 60 * 1000);
    hub.handleRelayMessage({ type: "session_processing", session: "work", state: "active", event: "PreToolUse", agentId: "long" });
    now.mockReturnValue(1_000_000 + 7 * 60 * 60 * 1000);
    expect(hub.runningAgentCounts).toEqual([{ session: "work", running: 1 }]);
    now.mockReturnValue(1_000_000 + 12 * 60 * 60 * 1000);
    expect(hub.runningAgentCounts).toEqual([]);
    now.mockRestore();
    void received;
  });

  test("wire: session_agent_counts の往復", () => {
    const line = '{"items":[{"running":2,"session":"work"}],"replace":true,"type":"session_agent_counts","v":2}';
    expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect(() => decodeControlMessage('{"items":[{"running":-1,"session":"w"}],"type":"session_agent_counts","v":2}')).toThrow();
  });
});
