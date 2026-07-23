// Codex App Server native turn / approval bridge の単体テスト。

import { describe, expect, test } from "vitest";
import type { CodexAppServerThreadOptions } from "../src/codexAppServer.js";
import {
  CodexNativeTurnController,
  type CodexNativeApproval,
  type CodexThreadClient,
} from "../src/codexNativeTurnController.js";

class FakeThread implements CodexThreadClient {
  readonly starts: { text: string; clientId?: string | null; effort?: string | null }[] = [];
  readonly steers: { turnId: string; text: string }[] = [];
  readonly interrupts: string[] = [];
  nextTurnId = "turn-1";
  initialActiveTurnId: string | null = null;
  steerError: Error | null = null;
  closed = 0;

  async startTurn(text: string, clientId?: string | null, effort?: string | null): Promise<string> {
    this.starts.push({ text, clientId, effort });
    return this.nextTurnId;
  }

  async steerTurn(turnId: string, text: string): Promise<void> {
    this.steers.push({ turnId, text });
    if (this.steerError !== null) throw this.steerError;
  }

  async interruptTurn(turnId: string): Promise<void> {
    this.interrupts.push(turnId);
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
      effort: "xhigh", sandbox: "workspace-write",
    })).resolves.toBe("turn-1");

    expect(thread.steers).toEqual([{ turnId: "turn-1", text: "追加指示" }]);
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
    thread.steerError = new Error("turn already completed");
    await expect(controller.startTurn({
      session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "retry",
    })).resolves.toBe("turn-2");
    await controller.interruptTurn("work");

    expect(thread.steers).toEqual([{ turnId: "turn-1", text: "retry" }]);
    expect(thread.starts).toEqual([
      { text: "first", clientId: undefined, effort: undefined },
      { text: "retry", clientId: undefined, effort: undefined },
    ]);
    expect(thread.interrupts).toEqual(["turn-2"]);
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
