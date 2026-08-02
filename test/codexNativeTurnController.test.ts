// Codex App Server native turn / approval bridge の単体テスト。

import { describe, expect, test } from "vitest";
import type { CodexAppServerThreadOptions } from "../src/codex/codexAppServer.js";
import {
  CodexNativeTurnController,
  type CodexNativeApproval,
  type CodexThreadClient,
} from "../src/codex/codexNativeTurnController.js";

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
      item: { id: "r1", type: "reasoning", summary: ["非表示"] },
    } });

    expect(chats).toEqual([
      { session: "work", itemId: "u1", payload: { type: "chat_output", v: 1,
        streamId: "codex-item-u1", role: "user", text: "質問", eof: true } },
      { session: "work", itemId: "a1", payload: { type: "chat_output", v: 1,
        streamId: "codex-item-a1", role: "assistant", text: "回答", eof: true } },
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
      id: "thread-child", parentThreadId: "thread-root", preview: "",
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
    } });
    expect(nodes[1]).toMatchObject({ node: {
      nodeId: "thread-child", toolUseId: "collab-spawn", status: "running",
      label: "型安全性を調査する", currentActivity: "関連箇所を検索中",
    } });
    expect(nodes[2]).toMatchObject({ node: {
      nodeId: "thread-child", toolUseId: "collab-spawn", status: "completed",
      currentActivity: null,
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
    });
    expect(payloads[1]?.node).toMatchObject({
      nodeId: "thread-child", parentNodeId: "thread-parent", depth: 2, status: "running",
    });
    expect(payloads[2]?.node).toMatchObject({
      nodeId: "thread-child", parentNodeId: "thread-parent", depth: 2, status: "error",
    });
  });

  test("Codex 会話の再購読時も initial collab item から完了済み workflow を復元する", async () => {
    const thread = Object.assign(new FakeThread(), { initialItems: [{
      id: "spawn-history", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-root", receiverThreadIds: ["thread-history"], prompt: "履歴を調査",
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
        nodeId: "thread-history", label: "履歴を調査", status: "completed",
      }) }),
    })]);
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
