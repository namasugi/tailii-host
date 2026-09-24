// Codex App Server native turn / approval bridge の単体テスト。

import { describe, expect, test, vi } from "vitest";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerThreadOptions,
} from "../src/codex/codexAppServer.js";
import {
  CodexNativeTurnController,
  type CodexNativeApproval,
  type CodexThreadClient,
} from "../src/codex/codexNativeTurnController.js";
import type { CodexCollaborationMode, CodexGoalInfo, ControlMessage } from "../src/protocol.js";

class FakeThread implements CodexThreadClient {
  readonly starts: { text: string; clientId?: string | null; effort?: string | null }[] = [];
  readonly steers: { turnId: string; text: string; clientId?: string | null }[] = [];
  readonly interrupts: string[] = [];
  activeTurnReads = 0;
  activeTurnReadResult: string | null | undefined = undefined;
  activeTurnReadError: Error | null = null;
  nextTurnId = "turn-1";
  initialActiveTurnId: string | null = null;
  liveSubscriptionReady: boolean | undefined;
  steerError: Error | null = null;
  readonly steerFailures: Error[] = [];
  readonly interruptFailures: Error[] = [];
  closed = 0;

  async readActiveTurnId(): Promise<string | null | undefined> {
    this.activeTurnReads += 1;
    if (this.activeTurnReadError !== null) throw this.activeTurnReadError;
    return this.activeTurnReadResult;
  }

  async startTurn(text: string, clientId?: string | null, effort?: string | null): Promise<string> {
    this.starts.push({ text, clientId, effort });
    return this.nextTurnId;
  }

  async steerTurn(turnId: string, text: string, clientId?: string | null): Promise<void> {
    this.steers.push({ turnId, text, clientId });
    const failure = this.steerFailures.shift();
    if (failure !== undefined) throw failure;
    if (this.steerError !== null) throw this.steerError;
  }

  async interruptTurn(turnId: string): Promise<void> {
    this.interrupts.push(turnId);
    const failure = this.interruptFailures.shift();
    if (failure !== undefined) throw failure;
  }

  close(): void {
    this.closed += 1;
  }
}

describe("CodexNativeTurnController", () => {
  test("userMessage / agentMessage completed を rollout と同じ chat_output へ写像する", async () => {
    const thread = Object.assign(new FakeThread(), {
      initialItems: [{ id: "old", type: "agentMessage", text: "履歴" }],
    });
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: unknown[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });

    await expect(controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }))
      .resolves.toMatchObject({ itemIds: new Set(["old"]), liveSubscribed: true });
    openOptions?.onNotification?.({ method: "item/completed", params: {
      item: { id: "u1", type: "userMessage", content: [{ type: "text", text: "質問" }] },
    } });
    openOptions?.onNotification?.({ method: "item/completed", params: {
      item: { id: "a1", type: "agentMessage", text: "回答" },
    } });
    openOptions?.onNotification?.({ method: "item/completed", params: {
      item: { id: "u2", clientId: "client-attachment", type: "userMessage",
        content: [{ type: "text", text: "/Users/me/.tailii/uploads/img.jpg この画像を見て" }] },
    } });
    openOptions?.onNotification?.({ method: "item/completed", params: {
      item: { id: "r1", type: "reasoning", summary: ["非表示"] },
    } });

    expect(chats).toEqual([
      { session: "work", itemId: "u1", payload: { type: "chat_output", v: 1,
        streamId: "codex-item-u1", role: "user", text: "質問", eof: true } },
      { session: "work", itemId: "a1", payload: { type: "chat_output", v: 1,
        streamId: "codex-item-a1", role: "assistant", text: "回答", eof: true } },
      { session: "work", itemId: "u2", payload: { type: "chat_output", v: 1,
        streamId: "codex-user-client-attachment", role: "user",
        text: "/Users/me/.tailii/uploads/img.jpg この画像を見て", eof: true } },
    ]);
  });

  test("commandExecution / fileChange completed を tool_activity として流す（codex-tool-cards）", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { session: string; itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });

    // inProgress（item/started 相当）はカードにしない。completed で 1 カード。
    openOptions?.onNotification?.({ method: "item/started", params: { item: {
      id: "exec-1", type: "commandExecution", command: "/bin/zsh -lc 'ls'", status: "inProgress",
    } } });
    openOptions?.onNotification?.({ method: "item/completed", params: { item: {
      id: "exec-1", type: "commandExecution", command: "/bin/zsh -lc 'ls'", status: "completed",
      exitCode: 0, aggregatedOutput: "a.txt\n",
    } } });
    openOptions?.onNotification?.({ method: "item/completed", params: { item: {
      id: "exec-2", type: "fileChange", status: "completed", changes: [
        { path: "/tmp/work/a.txt", kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-old\n+new\n" },
      ],
    } } });

    expect(chats).toEqual([
      { session: "work", itemId: "exec-1#tool-0", payload: { type: "tool_activity", v: 1,
        activity: expect.objectContaining({ id: "exec-1", name: "Bash", command: "ls" }) } },
      { session: "work", itemId: "exec-2#tool-0", payload: { type: "tool_activity", v: 1,
        activity: expect.objectContaining({ id: "exec-2", name: "Edit",
          label: "編集済み a.txt", addedLines: 1, removedLines: 1 }) } },
    ]);
  });

  test("MCP item と App Server の error / warning 通知を system 注記として流す", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { session: string; itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "item/completed", params: {
      threadId: "thread-1",
      item: {
        id: "mcp-1", type: "mcpToolCall", server: "drive", tool: "search",
        status: "failed", error: { message: "permission denied" },
      },
    } });
    openOptions?.onNotification?.({ method: "mcpServer/startupStatus/updated", params: {
      threadId: "thread-1", name: "notion", status: "failed", error: "handshake failed",
    } });
    openOptions?.onNotification?.({ method: "error", params: {
      threadId: "thread-1", turnId: "turn-1", willRetry: true,
      error: { message: "connection lost" },
    } });
    openOptions?.onNotification?.({ method: "warning", params: {
      threadId: "thread-1", message: "context is nearly full",
    } });
    // 別 thread 宛ての通知はこの会話へ混ぜない。
    openOptions?.onNotification?.({ method: "warning", params: {
      threadId: "thread-other", message: "not for this thread",
    } });

    const texts = chats.flatMap((event) => {
      const payload = event.payload as { type?: string; role?: string; text?: string };
      return payload.type === "chat_output" && payload.role === "system" && payload.text
        ? [payload.text]
        : [];
    });
    expect(texts).toEqual([
      "❌ MCP「drive / search」エラー: permission denied",
      "❌ MCP サーバー「notion」の起動に失敗しました: handshake failed",
      "⚠️ Codex エラー（自動再試行中）: connection lost",
      "⚠️ Codex 警告: context is nearly full",
    ]);
    expect(chats[0]?.itemId).toBe("mcp-1");
  });

  test("deprecationNotice は chat へ流さず、同文はログへ 1 回だけ記録する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { session: string; itemId: string; payload: unknown }[] = [];
    const logs: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
      log: (message) => logs.push(message),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });

    const params = {
      summary: "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, " +
        "then page with `thread/turns/list` and `thread/items/list`.",
      details: null,
    };
    openOptions?.onNotification?.({ method: "deprecationNotice", params });
    openOptions?.onNotification?.({ method: "deprecationNotice", params });
    openOptions?.onNotification?.({ method: "deprecationNotice", params: { summary: "another", details: null } });

    expect(chats).toEqual([]);
    expect(logs).toEqual([
      "Codex App Server 非推奨通知（利用者には表示しない）: Full-history hydration is deprecated for " +
      "paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.",
      "Codex App Server 非推奨通知（利用者には表示しない）: another",
    ]);
  });

  test("deprecationNotice の記憶は 64 件で打ち切り、以後は同文でも再記録する（有界）", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const logs: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      log: (message) => logs.push(message),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });

    for (let index = 0; index < 64; index += 1) {
      openOptions?.onNotification?.({ method: "deprecationNotice", params: { summary: `n-${index}`, details: null } });
    }
    openOptions?.onNotification?.({ method: "deprecationNotice", params: { summary: "n-0", details: null } });
    expect(logs).toHaveLength(64); // 64 件までは同文を記録しない
    openOptions?.onNotification?.({ method: "deprecationNotice", params: { summary: "n-64", details: null } });
    openOptions?.onNotification?.({ method: "deprecationNotice", params: { summary: "n-0", details: null } });
    expect(logs).toHaveLength(66); // 上限到達で記憶を空にするため n-0 は再記録される
  });

  test("turn/plan/updated をプラン tool_activity として流す", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { session: string; itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "turn/plan/updated", params: {
      threadId: "thread-1", turnId: "turn-9",
      plan: [{ step: "実装", status: "inProgress" }, { step: "検証", status: "pending" }],
    } });
    // plan が空の更新はカードにしない。
    openOptions?.onNotification?.({ method: "turn/plan/updated", params: {
      threadId: "thread-1", turnId: "turn-9", plan: [],
    } });

    expect(chats).toEqual([
      { session: "work", itemId: "plan:turn-9:0", payload: { type: "tool_activity", v: 1,
        activity: expect.objectContaining({ name: "TodoWrite", todos: [
          { content: "実装", status: "in_progress" },
          { content: "検証", status: "pending" },
        ] }) } },
    ]);
  });

  test("Codex collab lifecycle を Claude と共通の subagent_node へ写像する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { session: string; itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      // thread/started 時点では最初の user message が未永続化で preview が空になり得る。
      id: "thread-child", parentThreadId: "thread-root", preview: "", model: "gpt-5.6-terra",
      agentRole: "explorer", agentNickname: "maple", status: { type: "active", activeFlags: [] },
      source: { subAgent: { thread_spawn: {
        parent_thread_id: "thread-root", depth: 1, agent_path: null,
        agent_nickname: "maple", agent_role: "explorer",
      } } },
    } } });
    openOptions?.onNotification?.({ method: "item/completed", params: {
      threadId: "thread-root",
      item: {
        id: "collab-spawn", type: "collabAgentToolCall", tool: "spawnAgent",
        status: "completed", senderThreadId: "thread-root", receiverThreadIds: ["thread-child"],
        prompt: "型安全性を調査する", model: "gpt-5.6-terra",
        agentsStates: { "thread-child": { status: "running", message: "関連箇所を検索中" } },
      },
    } });
    openOptions?.onNotification?.({ method: "item/completed", params: {
      threadId: "thread-root",
      item: {
        id: "collab-wait", type: "collabAgentToolCall", tool: "wait",
        status: "completed", senderThreadId: "thread-root", receiverThreadIds: ["thread-child"],
        prompt: null, model: null,
        agentsStates: { "thread-child": { status: "completed", message: "調査完了" } },
      },
    } });

    const nodes = chats.map((event) => event.payload).filter((payload): payload is {
      type: "subagent_node";
      v: number;
      node: Record<string, unknown>;
    } => typeof payload === "object" && payload !== null &&
      (payload as Record<string, unknown>)["type"] === "subagent_node");
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ type: "subagent_node", v: 2, node: {
      nodeId: "thread-child", toolUseId: "thread:thread-child", parentNodeId: "root",
      agentType: "explorer", label: "Codex sub-agent", depth: 1, status: "running",
      model: "gpt-5.6-terra",
    } });
    expect(nodes[1]).toMatchObject({ node: {
      nodeId: "thread-child", toolUseId: "collab-spawn", status: "running",
      label: "型安全性を調査する", currentActivity: "関連箇所を検索中", model: "gpt-5.6-terra",
    } });
    expect(nodes[2]).toMatchObject({ node: {
      nodeId: "thread-child", toolUseId: "collab-spawn", status: "completed",
      currentActivity: null, model: "gpt-5.6-terra",
    } });
    expect(chats.map((event) => event.itemId)).toEqual([
      "subagent:thread-child:0", "subagent:thread-child:1", "subagent:thread-child:2",
    ]);
  });

  test("Codex の子 thread status と入れ子 spawn を workflow tree へ反映する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "item/completed", params: { item: {
      id: "spawn-parent", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-parent"], prompt: "親タスク",
      model: "gpt-5.6-sol",
      agentsStates: { "thread-parent": { status: "running", message: null } },
    } } });
    openOptions?.onNotification?.({ method: "item/completed", params: { item: {
      id: "spawn-child", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-parent", receiverThreadIds: ["thread-child"], prompt: "子タスク",
      agentsStates: { "thread-child": { status: "running", message: null } },
    } } });
    openOptions?.onNotification?.({ method: "thread/status/changed", params: {
      threadId: "thread-child", status: { type: "systemError" },
    } });

    const payloads = chats.map((event) => event.payload as {
      type: string;
      node: Record<string, unknown>;
    });
    expect(payloads).toHaveLength(3);
    expect(payloads[0]?.node).toMatchObject({
      nodeId: "thread-parent", parentNodeId: "root", depth: 1, status: "running",
      model: "gpt-5.6-sol",
    });
    expect(payloads[1]?.node).toMatchObject({
      nodeId: "thread-child", parentNodeId: "thread-parent", depth: 2, status: "running",
    });
    // spawn item に model が無く thread/started も未着なら未判明（省略）のまま。
    expect(payloads[1]?.node["model"]).toBeUndefined();
    expect(payloads[2]?.node).toMatchObject({
      nodeId: "thread-child", parentNodeId: "thread-parent", depth: 2, status: "error",
    });
  });

  test("Codex 子 thread のモデル変更を subagent_node へ反映し、親会話のモデルには混ぜない", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const models: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
      onModel: (session, model) => models.push(`${session}:${model}`),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      id: "thread-child", parentThreadId: "thread-root", preview: "", model: "gpt-5.6-terra",
      agentRole: "explorer", status: { type: "active", activeFlags: [] },
    } } });
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
      threadId: "thread-child", threadSettings: { model: "gpt-5.6-luna" },
    } });
    openOptions?.onNotification?.({ method: "model/rerouted", params: {
      threadId: "thread-child", fromModel: "gpt-5.6-luna", toModel: "gpt-5.6-sol",
    } });
    // 未知 thread / threadId 無しのモデル変更は無視する。
    openOptions?.onNotification?.({ method: "model/rerouted", params: {
      threadId: "thread-unknown", toModel: "ignored",
    } });
    openOptions?.onNotification?.({ method: "model/rerouted", params: { toModel: "ignored" } });
    // 以後の wait item（model null）が thread/started 時点の古い値へ戻さない。
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: {
      id: "collab-wait", type: "collabAgentToolCall", tool: "wait", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-child"], prompt: null, model: null,
      agentsStates: { "thread-child": { status: "running", message: "継続中" } },
    } } });

    const nodes = chats.map((event) => event.payload).filter((payload): payload is {
      type: "subagent_node";
      node: Record<string, unknown>;
    } => typeof payload === "object" && payload !== null &&
      (payload as Record<string, unknown>)["type"] === "subagent_node");
    expect(nodes.map((payload) => payload.node["model"])).toEqual([
      "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-sol",
    ]);
    expect(nodes.map((payload) => payload.node["status"])).toEqual([
      "running", "running", "running", "running",
    ]);
    expect(nodes.at(-1)?.node).toMatchObject({ agentType: "explorer", currentActivity: "継続中" });
    expect(models).toEqual([]);
  });

  test("role / nickname の無い Codex サブエージェントは種別 Codex + model で送る（種別へ流用しない）", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: {
      id: "collab-spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-plain"], prompt: "調査",
      model: "gpt-5.6-terra",
      agentsStates: { "thread-plain": { status: "running", message: null } },
    } } });

    const payload = chats[0]?.payload as { type: string; node: Record<string, unknown> } | undefined;
    expect(payload?.node).toMatchObject({
      nodeId: "thread-plain", agentType: "Codex", model: "gpt-5.6-terra", label: "調査",
    });
  });

  test("Codex 再オープンでは thread/read の model を子ノードへ復元する（spawn item に model が無くても）", async () => {
    const thread = Object.assign(new FakeThread(), {
      initialItems: [{
        id: "spawn-history", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
        senderThreadId: "thread-root", receiverThreadIds: ["thread-history"], prompt: "履歴を調査",
        agentsStates: { "thread-history": { status: "completed", message: "完了" } },
      }],
      readThreadStatus: async (threadId: string) => {
        expect(threadId).toBe("thread-history");
        return { status: { type: "idle" }, timestampMs: 1_000, model: "gpt-5.6-terra" };
      },
    });
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onChatItem: (event) => chats.push(event),
    });

    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    const nodes = chats
      .map((event) => event.payload as { type: string; node: Record<string, unknown> })
      .filter((payload) => payload.type === "subagent_node");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.node).toMatchObject({
      nodeId: "thread-history", status: "completed", ts: 1_000, model: "gpt-5.6-terra",
    });
  });

  test("wait / sendInput item の model は子ノードのモデルに採らない", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: {
      id: "collab-spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-w"], prompt: "調査",
      model: "gpt-5.6-terra",
      agentsStates: { "thread-w": { status: "running", message: null } },
    } } });
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: {
      id: "collab-wait", type: "collabAgentToolCall", tool: "wait", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-w"], prompt: null,
      model: "gpt-5.6-sol",
      agentsStates: { "thread-w": { status: "running", message: "待機中" } },
    } } });

    const nodes = chats
      .map((event) => event.payload as { type: string; node: Record<string, unknown> })
      .filter((payload) => payload.type === "subagent_node");
    expect(nodes.map((payload) => payload.node["model"])).toEqual(["gpt-5.6-terra", "gpt-5.6-terra"]);
    expect(nodes.at(-1)?.node).toMatchObject({ currentActivity: "待機中" });
  });

  test("ノード生成前に届いた子 thread のモデル変更は保留し、生成時に採る（thread/started の申告が優先）", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
      threadId: "thread-early", threadSettings: { model: "gpt-5.6-luna" },
    } });
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
      threadId: "thread-late", threadSettings: { model: "gpt-5.6-luna" },
    } });
    expect(chats).toHaveLength(0);
    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      id: "thread-early", parentThreadId: "thread-root", preview: "", model: null,
      agentRole: "explorer", status: { type: "active", activeFlags: [] },
    } } });
    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      id: "thread-late", parentThreadId: "thread-root", preview: "", model: "gpt-5.6-terra",
      agentRole: "explorer", status: { type: "active", activeFlags: [] },
    } } });
    // 保留から採った子自身の申告は、後続の spawnAgent item の要求 slug で巻き戻らない。
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: {
      id: "collab-spawn-early", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-early"], prompt: "早い子",
      model: "gpt-5.6-terra",
      agentsStates: { "thread-early": { status: "running", message: "開始" } },
    } } });

    const nodes = chats
      .map((event) => event.payload as { type: string; node: Record<string, unknown> })
      .filter((payload) => payload.type === "subagent_node");
    expect(nodes.map((payload) => [payload.node["nodeId"], payload.node["model"]])).toEqual([
      ["thread-early", "gpt-5.6-luna"],
      ["thread-late", "gpt-5.6-terra"],
      ["thread-early", "gpt-5.6-luna"],
    ]);
    expect(nodes.at(-1)?.node).toMatchObject({ currentActivity: "開始", toolUseId: "collab-spawn-early" });
  });

  test("保留モデルは spawnAgent item がノードを新規生成する経路でも採られる（到着順に依らない）", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    const spawn = (receiver: string, id: string) => ({
      id, type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: [receiver], prompt: "調査",
      model: "gpt-5.6-sol",
      agentsStates: { [receiver]: { status: "running", message: null } },
    });
    // A: 子の settings/updated → 親の SpawnEnd（spawn item）が先にノードを作る。
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
      threadId: "thread-a", threadSettings: { model: "gpt-5.6-terra" },
    } });
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: spawn("thread-a", "spawn-a") } });
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: {
      id: "wait-a", type: "collabAgentToolCall", tool: "wait", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-a"], prompt: null, model: null,
      agentsStates: { "thread-a": { status: "running", message: "待機中" } },
    } } });
    // B: 間に subAgentActivity(started) が挟まる順序でも同じ結果になる。
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
      threadId: "thread-b", threadSettings: { model: "gpt-5.6-terra" },
    } });
    openOptions?.onNotification?.({ method: "item/started", params: { threadId: "thread-root", item: {
      id: "activity-b", type: "subAgentActivity", kind: "started", agentThreadId: "thread-b", agentPath: "/root/b_task",
    } } });
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: spawn("thread-b", "spawn-b") } });

    const nodes = chats
      .map((event) => event.payload as { type: string; node: Record<string, unknown> })
      .filter((payload) => payload.type === "subagent_node");
    expect(nodes.map((payload) => [payload.node["nodeId"], payload.node["model"]])).toEqual([
      ["thread-a", "gpt-5.6-terra"],
      ["thread-a", "gpt-5.6-terra"],
      ["thread-b", "gpt-5.6-terra"],
      ["thread-b", "gpt-5.6-terra"],
    ]);
  });

  test("再オープン後に再生された spawn item の要求 slug は thread/read の実モデルを上書きしない", async () => {
    const spawnItem = {
      id: "spawn-history", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-history"], prompt: "履歴を調査",
      model: "gpt-5.6-sol",
      agentsStates: { "thread-history": { status: "completed", message: "完了" } },
    };
    const thread = Object.assign(new FakeThread(), {
      initialItems: [spawnItem],
      readThreadStatus: async () => ({ status: { type: "idle" }, timestampMs: 1_000, model: "gpt-5.6-terra" }),
    });
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });
    // resume〜snapshot の窓で完了した spawn の item/completed が buffered 再生で届く形。
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-root", item: spawnItem } });

    const nodes = chats
      .map((event) => event.payload as { type: string; node: Record<string, unknown> })
      .filter((payload) => payload.type === "subagent_node");
    expect(nodes.map((payload) => payload.node["model"])).toEqual(["gpt-5.6-terra"]);
    expect(nodes[0]?.node).toMatchObject({ nodeId: "thread-history", status: "completed", ts: 1_000 });
  });

  test("保留モデルは上限付きで turn 完了時に破棄され、無関係な thread の分が溜まり続けない", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    for (let index = 1; index <= 40; index += 1) {
      openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
        threadId: `thread-p${index}`, threadSettings: { model: `m${index}` },
      } });
    }
    expect(chats).toHaveLength(0);
    // 最古（p1）は上限（32）で捨てられ、最新（p40）は残る。
    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      id: "thread-p1", parentThreadId: "thread-root", preview: "", model: null,
      status: { type: "active", activeFlags: [] },
    } } });
    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      id: "thread-p40", parentThreadId: "thread-root", preview: "", model: null,
      status: { type: "active", activeFlags: [] },
    } } });
    // turn 完了で残りの保留は全て破棄される。
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: {
      threadId: "thread-q", threadSettings: { model: "mq" },
    } });
    openOptions?.onNotification?.({ method: "turn/completed", params: {
      threadId: "thread-root", turn: { id: "turn-1", status: "completed" },
    } });
    openOptions?.onNotification?.({ method: "thread/started", params: { thread: {
      id: "thread-q", parentThreadId: "thread-root", preview: "", model: null,
      status: { type: "active", activeFlags: [] },
    } } });

    const nodes = chats
      .map((event) => event.payload as { type: string; node: Record<string, unknown> })
      .filter((payload) => payload.type === "subagent_node");
    // turn 完了の settle でも既知の model は保持される（p40 の 2 件目）。
    expect(nodes.map((payload) => [payload.node["nodeId"], payload.node["model"] ?? null])).toEqual([
      ["thread-p1", null],
      ["thread-p40", "m40"],
      ["thread-p1", null],
      ["thread-p40", "m40"],
      ["thread-q", null],
    ]);
  });

  test("Codex 会話の再購読時も initial collab item から完了済み workflow を復元する", async () => {
    const thread = Object.assign(new FakeThread(), { initialItems: [{
      id: "spawn-history", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-history"], prompt: "履歴を調査",
      model: "gpt-5.6-terra",
      agentsStates: { "thread-history": { status: "completed", message: "完了" } },
    }] });
    const chats: { itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onChatItem: (event) => chats.push(event),
    });

    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    expect(chats).toEqual([expect.objectContaining({
      itemId: "subagent:thread-history:0",
      payload: expect.objectContaining({ type: "subagent_node", v: 2, node: expect.objectContaining({
        nodeId: "thread-history", label: "履歴を調査", status: "completed", model: "gpt-5.6-terra",
      }) }),
    })]);
  });

  test("完了済み会話の initial subAgentActivity.started は履歴状態へ収束する", async () => {
    const childThreadId = "019fc076-4c1f-7fb3-bd89-a9a417451788";
    const thread = Object.assign(new FakeThread(), {
      initialActiveTurnId: null,
      initialItems: [{
        id: "spawn-history", type: "subAgentActivity", kind: "started",
        agentThreadId: childThreadId, agentPath: "/root/background_view_test",
      }],
    });
    const chats: { itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onChatItem: (event) => chats.push(event),
    });

    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    expect(chats).toEqual([expect.objectContaining({
      itemId: `subagent:${childThreadId}:0`,
      payload: expect.objectContaining({ type: "subagent_node", v: 2, node: expect.objectContaining({
        nodeId: childThreadId,
        label: "background_view_test",
        status: "completed",
        ts: Number.parseInt("019fc0764c1f", 16),
      }) }),
    })]);
  });

  test("親に新しい active turn があっても過去の idle sub-agent は完了として復元する", async () => {
    const thread = Object.assign(new FakeThread(), {
      initialActiveTurnId: "turn-current",
      initialItems: [{
        id: "spawn-old", type: "subAgentActivity", kind: "started",
        agentThreadId: "thread-old", agentPath: "/root/old_task",
      }],
      readThreadStatus: async (threadId: string) => {
        expect(threadId).toBe("thread-old");
        return { status: { type: "idle" }, timestampMs: 1_000 };
      },
    });
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onChatItem: (event) => chats.push(event),
    });

    await controller.subscribeSession({ session: "work", threadId: "thread-root", cwd: "/tmp/work" });

    expect(chats).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ node: expect.objectContaining({
        nodeId: "thread-old", label: "old_task", status: "completed", ts: 1_000,
      }) }),
    })]);
  });

  test("snapshot 構築中のlive通知は後から適用して新しい状態を保持する", async () => {
    let resolveStatus: ((value: { status: unknown; timestampMs: number }) => void) | null = null;
    const status = new Promise<{ status: unknown; timestampMs: number }>((resolve) => {
      resolveStatus = resolve;
    });
    let statusReadStarted = false;
    const thread = Object.assign(new FakeThread(), {
      initialActiveTurnId: "turn-current",
      initialItems: [{
        id: "spawn-old", type: "subAgentActivity", kind: "started",
        agentThreadId: "thread-old", agentPath: "/root/old_task",
      }],
      readThreadStatus: async () => {
        statusReadStarted = true;
        return await status;
      },
    });
    let openOptions: CodexAppServerThreadOptions | null = null;
    const statuses: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => {
        if (event.payload.type === "subagent_node") statuses.push(event.payload.node.status);
      },
    });

    const subscription = controller.subscribeSession({
      session: "work", threadId: "thread-root", cwd: "/tmp/work",
    });
    await vi.waitFor(() => expect(statusReadStarted).toBe(true));
    openOptions?.onNotification?.({ method: "thread/status/changed", params: {
      threadId: "thread-old", status: { type: "systemError" },
    } });
    resolveStatus?.({ status: { type: "idle" }, timestampMs: 1_000 });
    await subscription;

    expect(statuses).toEqual(["completed", "error"]);
  });

  test("同一 thread を購読して turn/start し、turn lifecycle を処理中状態へ反映する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const processing: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async (options) => {
          openOptions = options;
          return thread;
        },
      },
      approvalBroker: async () => "allow",
      onProcessing: (session, state) => processing.push(`${session}:${state}`),
    });

    await expect(controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "run tests",
      clientUserMessageId: "client-1",
      effort: "xhigh",
    })).resolves.toBe("turn-1");
    expect(thread.starts).toEqual([{ text: "run tests", clientId: "client-1", effort: "xhigh" }]);
    expect(processing).toEqual(["work:active"]);

    openOptions?.onNotification?.({ method: "turn/completed", params: { turn: { id: "turn-1" } } });
    expect(processing).toEqual(["work:active", "work:done"]);
    controller.close();
    expect(thread.closed).toBe(1);
  });

  test("最初の user turn 成功後だけタイトル生成を非同期起動する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const generations: { threadId: string; cwd: string; prompt: string }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async (options) => {
          openOptions = options;
          return thread;
        },
        generateThreadTitle: async (options) => {
          generations.push(options);
          return { title: "短いタイトル", source: "model" };
        },
      },
    });

    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "最初の質問",
    });
    expect(generations).toEqual([{
      threadId: "thread-1",
      cwd: "/tmp/work",
      prompt: "最初の質問",
    }]);

    openOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    thread.nextTurnId = "turn-2";
    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "二番目の質問",
    });
    expect(generations).toHaveLength(1);
  });

  test("履歴の有無に依存せずApp Serverへ一度だけ命名判定を委ねる", async () => {
    const thread = Object.assign(new FakeThread(), {
      initialItems: [{ id: "old-user", type: "userMessage", content: [] }],
    });
    const generations: unknown[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async () => thread,
        generateThreadTitle: async (options) => {
          generations.push(options);
          return { title: "上書き禁止", source: "model" };
        },
      },
    });

    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "続きの質問",
    });
    expect(generations).toEqual([{
      threadId: "thread-1",
      cwd: "/tmp/work",
      prompt: "続きの質問",
    }]);
  });

  test("既存active turnへのsteerが最初の入力ならタイトル生成も起動する", async () => {
    const thread = new FakeThread();
    thread.initialActiveTurnId = "turn-active";
    const generations: { threadId: string; cwd: string; prompt: string }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async () => thread,
        generateThreadTitle: async (options) => {
          generations.push(options);
          return { title: "steerのタイトル", source: "model" };
        },
      },
    });

    await expect(controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "実行中ターンへの追加入力",
    })).resolves.toBe("turn-active");
    expect(generations).toEqual([{
      threadId: "thread-1",
      cwd: "/tmp/work",
      prompt: "実行中ターンへの追加入力",
    }]);
  });

  test("タイトル生成の一時エラーは最大3回まで自動再試行する", async () => {
    const thread = new FakeThread();
    let attempts = 0;
    let resolveEvent: ((event: {
      title: string | null;
      source: string | null;
      attempts: number;
      error: string | null;
    }) => void) | undefined;
    const event = new Promise<{
      title: string | null;
      source: string | null;
      attempts: number;
      error: string | null;
    }>((resolve) => {
      resolveEvent = resolve;
    });
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async () => thread,
        generateThreadTitle: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`temporary-${attempts}`);
          return { title: "再試行後タイトル", source: "model" };
        },
      },
      onThreadTitle: (result) => resolveEvent?.(result),
    });

    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "再試行を確認",
    });

    await expect(event).resolves.toMatchObject({
      title: "再試行後タイトル",
      source: "model",
      attempts: 3,
      error: null,
    });
    expect(attempts).toBe(3);
  });

  test("実行中の startTurn は既存 turn へ steer し、同じ turnId を返す", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });

    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "first",
    });
    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "追加指示",
      clientUserMessageId: "client-steer-1",
      effort: "xhigh", sandbox: "workspace-write",
    })).resolves.toBe("turn-1");

    expect(thread.steers).toEqual([{
      turnId: "turn-1", text: "追加指示", clientId: "client-steer-1",
    }]);
    expect(thread.starts).toEqual([{ text: "first", clientId: undefined, effort: undefined }]);
  });

  test("steer 失敗時は turn/start へフォールバックし、activeTurnId を更新する", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });

    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "first",
    });
    thread.nextTurnId = "turn-2";
    thread.steerError = new Error("no active turn to steer");
    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "retry",
      clientUserMessageId: "client-retry",
    })).resolves.toBe("turn-2");
    await controller.interruptTurn("work");

    expect(thread.steers).toEqual([{
      turnId: "turn-1", text: "retry", clientId: "client-retry",
    }]);
    expect(thread.starts).toEqual([
      { text: "first", clientId: undefined, effort: undefined },
      { text: "retry", clientId: "client-retry", effort: undefined },
    ]);
    expect(thread.interrupts).toEqual(["turn-2"]);
  });

  test("未materialize再接続は実行中turnを読み直し、新規startではなくsteerする", async () => {
    const thread = new FakeThread();
    thread.liveSubscriptionReady = false;
    thread.activeTurnReadResult = "turn-real";
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });

    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "追加指示",
      clientUserMessageId: "client-reconnected",
    })).resolves.toBe("turn-real");
    await controller.interruptTurn("work");

    expect(thread.activeTurnReads).toBe(1);
    expect(thread.starts).toEqual([]);
    expect(thread.steers).toEqual([{
      turnId: "turn-real", text: "追加指示", clientId: "client-reconnected",
    }]);
    expect(thread.interrupts).toEqual(["turn-real"]);
  });

  test("未materializeのままなら従来どおり最初のturnを開始する", async () => {
    const thread = new FakeThread();
    thread.liveSubscriptionReady = false;
    thread.activeTurnReadResult = undefined;
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });

    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "最初の入力",
    })).resolves.toBe("turn-1");

    expect(thread.activeTurnReads).toBe(1);
    expect(thread.starts).toEqual([{
      text: "最初の入力", clientId: undefined, effort: undefined,
    }]);
    expect(thread.steers).toEqual([]);
  });

  test("steerのturn ID不一致はApp Serverの実IDへ同期して一度だけ再試行する", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });
    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "first",
    });
    thread.steerFailures.push(new Error(
      "expected active turn id turn-1 but found turn-real",
    ));

    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "追加",
      clientUserMessageId: "client-retry",
    })).resolves.toBe("turn-real");

    expect(thread.starts).toHaveLength(1);
    expect(thread.steers).toEqual([
      { turnId: "turn-1", text: "追加", clientId: "client-retry" },
      { turnId: "turn-real", text: "追加", clientId: "client-retry" },
    ]);
  });

  test("中断のturn ID不一致はApp Serverの実IDへ同期して一度だけ再試行する", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });
    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "run",
    });
    thread.interruptFailures.push(new Error(
      "expected active turn id turn-1 but found turn-real",
    ));

    await expect(controller.interruptTurn("work")).resolves.toBeUndefined();
    expect(thread.interrupts).toEqual(["turn-1", "turn-real"]);

    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "続き",
    })).resolves.toBe("turn-real");
    expect(thread.steers.at(-1)).toEqual({
      turnId: "turn-real", text: "続き", clientId: undefined,
    });
  });

  test("未materialize再接続直後の中断は実行中turnを読み直す", async () => {
    const thread = new FakeThread();
    thread.liveSubscriptionReady = false;
    thread.activeTurnReadResult = "turn-real";
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });
    await controller.subscribeSession({
      session: "work", threadId: "thread-1", cwd: "/tmp/work",
    });

    await expect(controller.interruptTurn("work")).resolves.toBeUndefined();

    expect(thread.activeTurnReads).toBe(1);
    expect(thread.interrupts).toEqual(["turn-real"]);
  });

  test("steer timeoutはturn/startへフォールバックせず到達不明として返す", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });

    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "first",
    });
    thread.steerError = new Error("Codex App Server request timed out: turn/steer");

    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "一度だけ",
      clientUserMessageId: "client-ambiguous-timeout",
    })).rejects.toThrow("timed out");

    expect(thread.steers).toEqual([{
      turnId: "turn-1", text: "一度だけ", clientId: "client-ambiguous-timeout",
    }]);
    expect(thread.starts).toEqual([
      { text: "first", clientId: undefined, effort: undefined },
    ]);
  });

  test("idle の startTurn は従来どおり turn/start を呼ぶ", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
    });

    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "start",
      clientUserMessageId: "client-1", effort: "high", sandbox: "read-only",
    })).resolves.toBe("turn-1");

    expect(thread.steers).toEqual([]);
    expect(thread.starts).toEqual([{ text: "start", clientId: "client-1", effort: "high" }]);
  });

  test("実行中 turnId を追跡して中断し、完了後と未 open session は no-op にする", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
    });

    await controller.interruptTurn("not-open");
    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "run",
    });
    await controller.interruptTurn("work");
    expect(thread.interrupts).toEqual(["turn-1"]);

    openOptions?.onNotification?.({
      method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    await controller.interruptTurn("work");
    expect(thread.interrupts).toEqual(["turn-1"]);
  });

  test("rollout task_completeは現在のturnIdと一致する場合だけ処理完了へ補完する", async () => {
    const thread = new FakeThread();
    const processing: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onProcessing: (session, state) => processing.push(`${session}:${state}`),
    });
    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "run",
    });

    expect(controller.reconcileCompletedTurn("work", "turn-old")).toBe(false);
    await controller.interruptTurn("work");
    expect(thread.interrupts).toEqual(["turn-1"]);
    expect(processing).toEqual(["work:active"]);

    expect(controller.reconcileCompletedTurn("work", "turn-1")).toBe(true);
    await controller.interruptTurn("work");
    expect(thread.interrupts).toEqual(["turn-1"]);
    expect(processing).toEqual(["work:active", "work:done"]);
    expect(controller.reconcileCompletedTurn("work", "turn-1")).toBe(false);
  });

  test("別 client の turn/started 通知から turnId を追跡して中断する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });

    openOptions?.onNotification?.({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-external", status: "inProgress" } },
    });
    await controller.interruptTurn("work");

    expect(thread.interrupts).toEqual(["turn-external"]);
  });

  test("古いturn/completed通知は新しいactive turnと処理中状態を維持する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const processing: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onProcessing: (session, state) => processing.push(`${session}:${state}`),
    });
    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "first",
    });
    openOptions?.onNotification?.({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } },
    });
    openOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });

    await controller.interruptTurn("work");
    expect(thread.interrupts).toEqual(["turn-2"]);
    expect(processing).toEqual(["work:active", "work:active"]);
  });

  test("別threadのlifecycle通知はactive turnを上書きしない", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
    });
    await controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "run",
    });
    openOptions?.onNotification?.({
      method: "turn/started",
      params: { threadId: "thread-other", turn: { id: "turn-other", status: "inProgress" } },
    });
    openOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: "thread-other", turn: { id: "turn-other", status: "completed" } },
    });

    await controller.interruptTurn("work");
    expect(thread.interrupts).toEqual(["turn-1"]);
  });

  test("再購読時の実行中 turnId を復元して中断する", async () => {
    const thread = new FakeThread();
    thread.initialActiveTurnId = "turn-resumed";
    const processing: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onProcessing: (session, state) => processing.push(`${session}:${state}`),
    });

    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    await controller.interruptTurn("work");

    expect(processing).toEqual(["work:active"]);
    expect(thread.interrupts).toEqual(["turn-resumed"]);
  });

  test("subscribeSession は購読時の thread モデルを snapshot に含める", async () => {
    const withModel = Object.assign(new FakeThread(), { model: "gpt-current" });
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => withModel },
    });
    await expect(controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }))
      .resolves.toMatchObject({ model: "gpt-current" });

    // 旧 App Server（応答に model が無い）は null で、Hub は購読時配信を行わない。
    const legacy = new CodexNativeTurnController({
      appServer: { openThread: async () => new FakeThread() },
    });
    await expect(legacy.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }))
      .resolves.toMatchObject({ model: null });
  });

  test("App Server の利用中モデルと token usage を session callback へ反映する", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const models: string[] = [];
    const usages: { session: string; totalTokens: number; contextWindow: number | null }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async (options) => {
          openOptions = options;
          return thread;
        },
      },
      onModel: (session, model) => models.push(`${session}:${model}`),
      onTokenUsage: (session, totalTokens, contextWindow) => {
        usages.push({ session, totalTokens, contextWindow });
      },
    });
    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "run",
    });

    openOptions?.onNotification?.({
      method: "thread/settings/updated",
      params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-sol" } },
    });
    // 子 thread（サブエージェント）の設定更新は親会話のモデル表示に反映しない。
    openOptions?.onNotification?.({
      method: "thread/settings/updated",
      params: { threadId: "thread-1-child", threadSettings: { model: "ignored-child-model" } },
    });
    openOptions?.onNotification?.({
      method: "model/rerouted",
      params: { threadId: "other-thread", toModel: "ignored-model" },
    });
    openOptions?.onNotification?.({
      method: "model/rerouted",
      params: { threadId: "thread-1", toModel: "gpt-5.6-terra" },
    });
    openOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          total: { totalTokens: 987_654 },
          last: { totalTokens: 12_345 },
          modelContextWindow: 353_400,
        },
      },
    });
    openOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          total: { totalTokens: 999_999 },
          last: { totalTokens: 12_500 },
          modelContextWindow: null,
        },
      },
    });

    expect(models).toEqual(["work:gpt-5.6-sol", "work:gpt-5.6-terra"]);
    expect(usages).toEqual([
      { session: "work", totalTokens: 12_345, contextWindow: 353_400 },
      { session: "work", totalTokens: 12_500, contextWindow: null },
    ]);
  });

  test("command approval を既存 iPhone broker 形式へ変換し、App Server decision を返す", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const approvals: CodexNativeApproval[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async (options) => {
          openOptions = options;
          return thread;
        },
      },
      approvalBroker: async (approval) => {
        approvals.push(approval);
        return "allow";
      },
    });
    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "run",
    });

    const result = await openOptions?.onServerRequest?.({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm test",
        cwd: "/tmp/work",
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(approvals).toEqual([{
      id: "codex:thread-1:42",
      session: "work",
      tool: "Bash",
      summary: "npm test",
      cwd: "/tmp/work",
    }]);
  });

  test("requestUserInput を既存 question_prompt へ変換し、iOS 回答を native response に戻す", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const prompts: unknown[] = [];
    const dismissed: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: {
        openThread: async (options) => {
          openOptions = options;
          return thread;
        },
      },
      onQuestion: (event) => prompts.push(event),
      onQuestionDismiss: (_session, id) => dismissed.push(id),
    });
    await controller.startTurn({
      session: "work",
      threadId: "thread-1",
      cwd: "/tmp/work",
      text: "ask",
    });

    const responsePromise = openOptions?.onServerRequest?.({
      id: "rpc-q1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-q1",
        questions: [{
          id: "language",
          header: "言語",
          question: "どちらにしますか？",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Swift", description: "iOS" },
            { label: "TypeScript", description: "Host" },
          ],
        }],
        autoResolutionMs: null,
      },
    });
    expect(prompts).toEqual([{
      session: "work",
      id: "codex-question:thread-1:rpc-q1",
      questions: [{
        header: "言語",
        question: "どちらにしますか？",
        multiSelect: false,
        options: [
          { label: "Swift", description: "iOS" },
          { label: "TypeScript", description: "Host" },
        ],
      }],
    }]);

    expect(controller.answerQuestion("codex-question:thread-1:rpc-q1", [{
      questionIndex: 0,
      selectedOptionIndexes: [1],
      otherText: "補足",
      multiSelect: false,
    }])).toBe(true);
    await expect(responsePromise).resolves.toEqual({
      answers: { language: { answers: ["TypeScript", "補足"] } },
    });
    expect(dismissed).toEqual(["codex-question:thread-1:rpc-q1"]);
  });
});

/** collaboration mode を受け取る fake thread（FakeThread は 3 引数までしか記録しない）。 */
class PlanFakeThread extends FakeThread {
  readonly planStarts: { text: string; collaborationMode: CodexCollaborationMode | null | undefined }[] = [];
  override async startTurn(
    text: string,
    clientId?: string | null,
    effort?: string | null,
    _sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null,
    _approvalPolicy?: CodexAppServerApprovalPolicy | null,
    collaborationMode?: CodexCollaborationMode | null,
  ): Promise<string> {
    this.planStarts.push({ text, collaborationMode });
    return super.startTurn(text, clientId, effort);
  }
}

describe("CodexNativeTurnController plan mode / goal（codex-plan-mode / codex-goal）", () => {
  test("collaborationMode を turn/start へ渡し、plan item を codex-plan- streamId の assistant chat_output へ写像する", async () => {
    const thread = new PlanFakeThread();
    thread.nextTurnId = "turn-plan";
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
    });
    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work",
      text: "計画して", clientUserMessageId: "client-plan", collaborationMode: "plan",
    })).resolves.toBe("turn-plan");
    expect(thread.planStarts).toEqual([{ text: "計画して", collaborationMode: "plan" }]);
    openOptions?.onNotification?.({ method: "item/completed", params: { threadId: "thread-1", item: {
      id: "turn-plan-plan", type: "plan", text: "- README を作る\n- 1 文だけにする\n",
    } } });
    expect(chats.map((event) => event.payload)).toContainEqual({
      type: "chat_output", v: 1, streamId: "codex-plan-turn-plan-plan", role: "assistant",
      text: "- README を作る\n- 1 文だけにする", eof: true,
    });
    // turn 完了後の未指定は従来どおり null（thread の現状のまま）で新規 turn を開始する。
    openOptions?.onNotification?.({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-plan", status: "completed" },
    } });
    await controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "続けて" });
    expect(thread.planStarts.at(-1)).toEqual({ text: "続けて", collaborationMode: null });
  });

  test("thread/goal/updated を onGoal と 🎯 注記へ写像し、進捗だけの更新では注記を繰り返さない", async () => {
    const thread = new FakeThread();
    let openOptions: CodexAppServerThreadOptions | null = null;
    const chats: { payload: unknown }[] = [];
    const goals: (CodexGoalInfo | null)[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onChatItem: (event) => chats.push(event),
      onGoal: (_session, goal) => goals.push(goal),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    const goal = {
      threadId: "thread-1", objective: "テストを緑にする", status: "active",
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    };
    openOptions?.onNotification?.({ method: "thread/goal/updated", params: { threadId: "thread-1", turnId: null, goal } });
    expect(controller.hasActiveGoal("work")).toBe(true);
    openOptions?.onNotification?.({ method: "thread/goal/updated", params: {
      threadId: "thread-1", turnId: "t", goal: { ...goal, tokensUsed: 500, timeUsedSeconds: 30, updatedAt: 2 },
    } });
    openOptions?.onNotification?.({ method: "thread/goal/updated", params: {
      threadId: "thread-1", turnId: "t", goal: { ...goal, status: "complete", updatedAt: 3 },
    } });
    openOptions?.onNotification?.({ method: "thread/goal/cleared", params: { threadId: "thread-1" } });
    // 別 thread の目標は無視する。
    openOptions?.onNotification?.({ method: "thread/goal/updated", params: { threadId: "thread-other", goal } });
    // 先頭の null は購読確立時の現在値配信（目標なし）。以後は通知ごとに配る。
    expect(goals.map((value) => value?.status ?? null)).toEqual([null, "active", "active", "complete", null]);
    expect(controller.hasActiveGoal("work")).toBe(false);
    const notices = chats
      .map((event) => event.payload as ControlMessage)
      .filter((payload): payload is Extract<ControlMessage, { type: "chat_output" }> =>
        payload.type === "chat_output" && payload.role === "system");
    expect(notices.map((notice) => notice.text)).toEqual([
      "🎯 目標（追求中）: テストを緑にする",
      "🎯 目標（達成）: テストを緑にする",
      "🎯 目標を解除しました",
    ]);
  });

  test("goal() は thread の goalGet / goalSet / goalClear を呼び、結果を onGoal と hasActiveGoal へ反映する", async () => {
    const calls: unknown[] = [];
    const goal = {
      threadId: "thread-1", objective: "ベンチ整備", status: "active", tokenBudget: 1000,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    };
    const thread = Object.assign(new FakeThread(), {
      goalGet: async (): Promise<CodexGoalInfo | null> => { calls.push("get"); return null; },
      goalSet: async (params: unknown): Promise<CodexGoalInfo> => { calls.push(["set", params]); return goal; },
      goalClear: async (): Promise<boolean> => { calls.push("clear"); return true; },
    });
    const goals: (CodexGoalInfo | null)[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onGoal: (_session, value) => goals.push(value),
    });
    const base = { session: "work", threadId: "thread-1", cwd: "/tmp/work" } as const;
    await expect(controller.goal({ ...base, action: "get" })).resolves.toEqual({ goal: null });
    await expect(controller.goal({
      ...base, action: "set", objective: "ベンチ整備", status: "active", tokenBudget: 1000,
    })).resolves.toEqual({ goal });
    expect(controller.hasActiveGoal("work")).toBe(true);
    await expect(controller.goal({ ...base, action: "clear" })).resolves.toEqual({ goal: null, cleared: true });
    expect(controller.hasActiveGoal("work")).toBe(false);
    // open 直後の自動読み取り（get）+ 明示 get + set + clear。
    expect(calls).toEqual([
      "get", "get", ["set", { objective: "ベンチ整備", status: "active", tokenBudget: 1000 }], "clear",
    ]);
    expect(goals).toEqual([null, goal, null]);
  });

  test("thread/settings/updated の collaborationMode を onCollaborationMode と thread.noteThreadSettings へ渡す", async () => {
    const noted: Record<string, unknown>[] = [];
    const thread = Object.assign(new FakeThread(), {
      noteThreadSettings: (settings: Record<string, unknown>): void => { noted.push(settings); },
    });
    let openOptions: CodexAppServerThreadOptions | null = null;
    const modes: string[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (options) => { openOptions = options; return thread; } },
      onCollaborationMode: (session, mode) => modes.push(`${session}:${mode}`),
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: { threadId: "thread-1",
      threadSettings: {
        model: "gpt-6-astra", effort: "low", collaborationMode: { mode: "plan", settings: { model: "gpt-6-astra" } },
      } } });
    // 子 thread の設定は親に混ぜない。
    openOptions?.onNotification?.({ method: "thread/settings/updated", params: { threadId: "thread-child",
      threadSettings: { model: "gpt-5.6-luna", collaborationMode: { mode: "default" } } } });
    expect(modes).toEqual(["work:plan"]);
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ effort: "low" });
  });
});

describe("CodexNativeTurnController plan mode（実行中 turn への送信）", () => {
  test("plan turn が実行中に default を送ると steer になり、mode 未反映の注記を出す（新規 turn は開始しない）", async () => {
    const thread = Object.assign(new PlanFakeThread(), { collaborationMode: "plan" as const });
    thread.nextTurnId = "turn-plan";
    const chats: { payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onChatItem: (event) => chats.push(event),
    });
    await controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work",
      text: "計画して", clientUserMessageId: "c1", collaborationMode: "plan" });
    // turn/completed が来る前に「実装して」（default）を送る = plan item 直後の操作。
    await controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work",
      text: "実装して", clientUserMessageId: "c2", collaborationMode: "default" });
    expect(thread.planStarts).toHaveLength(1);
    expect(thread.steers.map((s) => s.text)).toEqual(["実装して"]);
    const notices = chats
      .map((event) => event.payload as ControlMessage)
      .filter((payload): payload is Extract<ControlMessage, { type: "chat_output" }> =>
        payload.type === "chat_output" && payload.role === "system");
    expect(notices.map((n) => n.text)).toEqual([
      "⚠️ 実行中の turn には通常モードを反映できません。今の応答が終わってからの送信で切り替わります。",
    ]);
    // 同じ mode の steer（plan のまま追加指示）は注記しない。
    await controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work",
      text: "もう少し詳しく", clientUserMessageId: "c3", collaborationMode: "plan" });
    const noticesAfter = chats
      .map((event) => event.payload as ControlMessage)
      .filter((payload) => payload.type === "chat_output" && payload.role === "system");
    expect(noticesAfter).toHaveLength(1);
  });

  test("subscribeSession は既存 thread の再購読でも目標の現在値と collaboration mode を返す", async () => {
    const goal = {
      threadId: "thread-1", objective: "ベンチ整備", status: "active",
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    };
    const thread = Object.assign(new FakeThread(), {
      goalGet: async (): Promise<CodexGoalInfo | null> => goal,
      collaborationMode: "plan" as const,
    });
    const goals: (CodexGoalInfo | null)[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => thread },
      onGoal: (_session, value) => goals.push(value),
    });
    const first = await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    const second = await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    expect(first.collaborationMode).toBe("plan");
    expect(second.collaborationMode).toBe("plan");
    // 初回読み取り（notice 無し）+ 購読ごとに現在値を配る = 2 回。
    expect(goals).toEqual([goal, goal]);
    expect(controller.hasActiveGoal("work")).toBe(true);
  });
});


describe("CodexNativeTurnController threadFor の同時呼び出し / plan 前設定の引き継ぎ", () => {
  test("購読と目標 get が同時に来ても openThread は 1 回で、同じ OpenThread を共有する", async () => {
    let openCount = 0;
    const goal = {
      threadId: "thread-1", objective: "ベンチ整備", status: "active",
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    };
    const thread = Object.assign(new FakeThread(), {
      goalGet: async (): Promise<CodexGoalInfo | null> => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return goal;
      },
    });
    const goals: (CodexGoalInfo | null)[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => { openCount += 1; return thread; } },
      onGoal: (_session, value) => goals.push(value),
    });
    const [snapshot, result] = await Promise.all([
      controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }),
      controller.goal({ session: "work", threadId: "thread-1", cwd: "/tmp/work", action: "get" }),
    ]);
    expect(openCount).toBe(1);
    expect(snapshot.liveSubscribed).toBe(true);
    expect(result.goal).toEqual(goal);
    // 購読は読み込み済みの現在値（null ではなく goal）を配る。
    expect(goals.every((value) => value !== null)).toBe(true);
    expect(thread.closed).toBe(0);
  });

  test("plan 直前の設定は接続を畳んで作り直しても引き継がれる", async () => {
    const seeds: unknown[] = [];
    const makeThread = (): FakeThread => Object.assign(new FakeThread(), {
      planRestoreSnapshot: { model: "gpt-6-astra", effort: "high" },
      seedPlanRestoreSnapshot: (snapshot: unknown): void => { seeds.push(snapshot); },
    });
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => makeThread() },
    });
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    controller.closeSession("work");
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    expect(seeds).toEqual([{ model: "gpt-6-astra", effort: "high" }]);
  });
});

describe("CodexNativeTurnController threadFor（3 周目: 別 threadId の競合 / 開始中の close）", () => {
  test("同じ session に別 threadId の open が重なっても、同じ threadId の open は 1 回で孤児接続を残さない", async () => {
    const opened: FakeThread[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const thread = new FakeThread();
        opened.push(thread);
        return thread;
      } },
    });
    await Promise.all([
      controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }),
      controller.subscribeSession({ session: "work", threadId: "thread-2", cwd: "/tmp/work" }),
      controller.subscribeSession({ session: "work", threadId: "thread-2", cwd: "/tmp/work" }),
    ]);
    // thread-1 と thread-2 の 2 回だけ開き、閉じられなかった接続は最後の 1 本だけ。
    expect(opened).toHaveLength(2);
    expect(opened.filter((thread) => thread.closed === 0)).toHaveLength(1);
  });

  test("開始中に closeSession されたら、開き終わった時点で畳む", async () => {
    const thread = new FakeThread();
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return thread;
      } },
    });
    const subscribing = controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    controller.closeSession("work");
    await subscribing;
    expect(thread.closed).toBe(1);
    expect(controller.hasActiveGoal("work")).toBe(false);
    // 次の open は普通に開ける（close 要求が残らない）。
    const again = new FakeThread();
    const controller2 = controller as unknown as { appServer: { openThread: () => Promise<FakeThread> } };
    controller2.appServer.openThread = async () => again;
    await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    expect(again.closed).toBe(0);
  });

  test("open 失敗の後は次の呼び出しで開き直せる", async () => {
    let attempts = 0;
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return new FakeThread();
      } },
    });
    await expect(controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }))
      .rejects.toThrow("boom");
    await expect(controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }))
      .resolves.toMatchObject({ liveSubscribed: true });
    expect(attempts).toBe(2);
  });
});

describe("CodexNativeTurnController threadFor（4 周目 should-fix）", () => {
  test("同じ thread の open 失敗は待ち手にも同じエラーで伝え、順番に開き直さない", async () => {
    let attempts = 0;
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("boom");
      } },
    });
    const results = await Promise.allSettled([
      controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" }),
      controller.goal({ session: "work", threadId: "thread-1", cwd: "/tmp/work", action: "get" }),
      controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "run" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(attempts).toBe(1);
  });

  test("開始中に close 要求で畳まれても、turn 開始は生きた接続で行う（購読は畳まれたまま返す）", async () => {
    const threads: FakeThread[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const thread = new FakeThread();
        threads.push(thread);
        return thread;
      } },
    });
    const starting = controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "run" });
    controller.closeSession("work");
    await expect(starting).resolves.toBe("turn-1");
    expect(threads).toHaveLength(2);
    expect(threads[0]!.closed).toBe(1);
    expect(threads[1]!.starts.map((start) => start.text)).toEqual(["run"]);
    expect(threads[1]!.closed).toBe(0);
  });
});
