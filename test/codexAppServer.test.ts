// codexAppServer.test.ts — Codex App Server singleton 起動と thread/start のテスト

import * as path from "node:path";
import * as fs from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CodexAppServerManager,
  type CodexAppServerConnection,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerRequestId,
} from "../src/codexAppServer.js";
import { makeTempDir } from "./helpers.js";

class FakeConnection implements CodexAppServerConnection {
  initialized = 0;
  closed = 0;
  readonly requests: { method: string; params: unknown }[] = [];
  notificationHandler: ((notification: CodexAppServerNotification) => void) | null = null;
  serverRequestHandler: ((request: CodexAppServerRequest) => void) | null = null;
  readonly responses: { id: CodexAppServerRequestId; result?: unknown; error?: unknown }[] = [];

  constructor(private readonly threadId = "thread-new") {}

  async initialize(): Promise<void> {
    this.initialized += 1;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return { thread: { id: this.threadId } };
  }

  close(): void {
    this.closed += 1;
  }

  onNotification(handler: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationHandler = handler;
    return () => { this.notificationHandler = null; };
  }

  onServerRequest(handler: (request: CodexAppServerRequest) => void): () => void {
    this.serverRequestHandler = handler;
    return () => { this.serverRequestHandler = null; };
  }

  respond(id: CodexAppServerRequestId, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: CodexAppServerRequestId, code: number, message: string): void {
    this.responses.push({ id, error: { code, message } });
  }
}

describe("CodexAppServerManager", () => {
  test("connectIfRunning は停止中なら起動せず null を返す", async () => {
    let launches = 0;
    let connects = 0;
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-not-running"),
      connect: async () => {
        connects += 1;
        throw new Error("not running");
      },
      launch: () => {
        launches += 1;
      },
    });

    await expect(manager.connectIfRunning()).resolves.toBeNull();
    expect(connects).toBe(1);
    expect(launches).toBe(0);
  });

  test("thread/list を確認済みスキーマでページングし、最大件数で閉じる", async () => {
    const connection = new FakeConnection();
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      const cursor = (params as { cursor?: string }).cursor;
      return cursor === undefined
        ? {
            data: [{
              id: "thread-1", name: "first", preview: "preview", updatedAt: 100,
              cwd: "/work/one", source: "vscode", parentThreadId: null,
            }],
            nextCursor: "page-2",
            backwardsCursor: "back-1",
          }
        : {
            data: [{
              id: "thread-2", name: null, preview: "second", updatedAt: 90,
              cwd: "/work/two", source: "cli", parentThreadId: null,
            }],
            nextCursor: null,
            backwardsCursor: "back-2",
          };
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-list"),
      connect: async () => connection,
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.listThreads(2)).resolves.toEqual([
      {
        id: "thread-1", name: "first", preview: "preview", updatedAt: 100,
        cwd: "/work/one", source: "vscode", parentThreadId: null,
      },
      {
        id: "thread-2", name: null, preview: "second", updatedAt: 90,
        cwd: "/work/two", source: "cli", parentThreadId: null,
      },
    ]);
    expect(connection.requests).toEqual([
      {
        method: "thread/list",
        params: { limit: 2, sortKey: "updated_at", sortDirection: "desc" },
      },
      {
        method: "thread/list",
        params: { limit: 1, sortKey: "updated_at", sortDirection: "desc", cursor: "page-2" },
      },
    ]);
    expect(connection.initialized).toBe(1);
    expect(connection.closed).toBe(1);
  });

  test("共有 App Server の固定 Remote Control RPC を検証して返す", async () => {
    const requests: { method: string; params: unknown }[] = [];
    const connections: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-remote-control-rpc"),
      connect: async () => {
        const connection = new FakeConnection();
        connection.request = async (method, params) => {
          requests.push({ method, params });
          if (method === "remoteControl/status/read") {
            return { status: "disabled", serverName: "Mac", environmentId: null };
          }
          if (method === "remoteControl/enable") {
            return { status: "connecting", serverName: "Mac", environmentId: "env_1" };
          }
          if (method === "remoteControl/disable") {
            return { status: "disabled", serverName: "Mac", environmentId: "env_1" };
          }
          if (method === "remoteControl/pairing/start") {
            return {
              pairingCode: "opaque-secret",
              manualPairingCode: "ABCD-EFGH",
              environmentId: "env_1",
              expiresAt: 1_900_000_300,
            };
          }
          return {};
        };
        connections.push(connection);
        return connection;
      },
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.remoteControlStatus()).resolves.toEqual({
      status: "disabled",
      hasEnvironment: false,
    });
    await expect(manager.enableRemoteControl()).resolves.toEqual({
      status: "connecting",
      hasEnvironment: true,
    });
    await expect(manager.disableRemoteControl()).resolves.toEqual({
      status: "disabled",
      hasEnvironment: true,
    });
    await expect(manager.startRemoteControlPairing()).resolves.toEqual({
      pairingCode: "opaque-secret",
      manualPairingCode: "ABCD-EFGH",
      expiresAt: 1_900_000_300,
    });
    expect(requests).toEqual([
      { method: "remoteControl/status/read", params: {} },
      { method: "remoteControl/enable", params: {} },
      { method: "remoteControl/disable", params: {} },
      { method: "remoteControl/pairing/start", params: { manualCode: true } },
    ]);
    expect(connections.every((connection) => connection.closed === 1)).toBe(true);
  });

  test("server が停止中なら1回だけ起動し、thread/start の thread ID を返す", async () => {
    const home = makeTempDir("codex-app-server");
    let ready = false;
    const launched: { executable: string; args: string[] }[] = [];
    const connections: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      codexHome: home,
      codexPath: "/opt/codex",
      pollIntervalMs: 0,
      startupTimeoutMs: 100,
      launch: (executable, args) => {
        launched.push({ executable, args });
        ready = true;
      },
      connect: async () => {
        if (!ready) throw new Error("not ready");
        const connection = new FakeConnection();
        connections.push(connection);
        return connection;
      },
    });

    const threadId = await manager.startThread({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sandbox: "workspace-write",
    });

    expect(threadId).toBe("thread-new");
    expect(launched).toEqual([
      { executable: "/opt/codex", args: ["app-server", "--listen", "unix://"] },
    ]);
    expect(connections.at(-1)?.requests).toEqual([
      {
        method: "thread/start",
        params: {
          cwd: "/tmp/project",
          model: "gpt-5.4",
          sandbox: "workspace-write",
        },
      },
    ]);
    expect(manager.remoteEndpoint).toBe("unix://");
    expect(manager.socketPath).toBe(
      path.join(home, "app-server-control", "app-server-control.sock"),
    );
    expect(connections.at(-1)?.closed).toBe(0); // 空 thread を TUI/openThread まで生存させる。
  });

  test("既存 server が応答すれば起動せず再利用する", async () => {
    const connections: FakeConnection[] = [];
    let launches = 0;
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-live"),
      launch: () => {
        launches += 1;
      },
      connect: async () => {
        const connection = new FakeConnection("thread-live");
        connections.push(connection);
        return connection;
      },
    });

    expect(await manager.startThread({ cwd: "/tmp/live" })).toBe("thread-live");
    expect(launches).toBe(0);
    expect(connections).toHaveLength(2); // readiness probe + thread/start client
    expect(connections[0]?.closed).toBe(1); // readiness probe
    expect(connections[1]?.closed).toBe(0); // bootstrap subscriber
  });

  test("thread/start 応答に thread.id が無ければ失敗する", async () => {
    const connection: CodexAppServerConnection = {
      initialize: async () => {},
      request: async () => ({ thread: {} }),
      onNotification: () => () => {},
      onServerRequest: () => () => {},
      respond: () => {},
      respondError: () => {},
      close: () => {},
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-bad-response"),
      connect: async () => connection,
      launch: () => {},
    });

    await expect(manager.startThread({ cwd: "/tmp/bad" })).rejects.toThrow("thread.id");
  });

  test("openThread は resume で設定を上書きせず、turn RPC の明示設定だけを送る", async () => {
    const connections: FakeConnection[] = [];
    let calls = 0;
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-thread"),
      connect: async () => {
        const connection = new FakeConnection();
        const original = connection.request.bind(connection);
        connection.request = async (method, params) => {
          calls += 1;
          if (method === "turn/start") {
            connection.requests.push({ method, params });
            return { turn: { id: "turn-1" } };
          }
          return original(method, params);
        };
        connections.push(connection);
        return connection;
      },
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-live" });
    expect(await thread.startTurn(
      "hello",
      "client-1",
      "xhigh",
      "workspace-write",
      "on-request",
    )).toBe("turn-1");
    await expect(thread.steerTurn("turn-1", "")).rejects.toThrow("must not be empty");
    await thread.steerTurn("turn-1", "追加指示");
    await thread.interruptTurn("turn-1");
    const connection = connections.at(-1)!;
    expect(connection.requests).toContainEqual({
      method: "thread/resume",
      params: {
        threadId: "thread-live",
        excludeTurns: false,
      },
    });
    expect(connection.requests).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "thread-live",
        input: [{ type: "text", text: "hello" }],
        approvalPolicy: "on-request",
        clientUserMessageId: "client-1",
        effort: "xhigh",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
    expect(connection.requests).toContainEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-live",
        input: [{ type: "text", text: "追加指示" }],
        expectedTurnId: "turn-1",
      },
    });
    expect(connection.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-live", turnId: "turn-1" },
    });
    expect(calls).toBeGreaterThan(0);
    thread.close();
    expect(connection.closed).toBe(1);
  });

  test("turn の未指定セキュリティ設定は project-aware config/read から復元する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-inherit");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-inherit", turns: [] } };
      }
      if (method === "config/read") {
        return {
          config: {
            approval_policy: "never",
            approvals_reviewer: "user",
            sandbox_mode: "danger-full-access",
          },
          origins: {},
          layers: null,
        };
      }
      if (method === "turn/start") return { turn: { id: "turn-inherit" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-inherit"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({
      threadId: "thread-inherit",
      cwd: "/tmp/project",
    });
    await expect(thread.startTurn(
      "inherit",
      "client-inherit",
      null,
      null,
      null,
    )).resolves.toBe("turn-inherit");

    expect(connection.requests).toContainEqual({
      method: "config/read",
      params: { includeLayers: false, cwd: "/tmp/project" },
    });
    expect(connection.requests).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "thread-inherit",
        input: [{ type: "text", text: "inherit" }],
        clientUserMessageId: "client-inherit",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
  });

  test("未対応の granular approval は turn override に再送しない", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-granular");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-granular", turns: [] } };
      }
      if (method === "config/read") {
        return {
          config: {
            approval_policy: {
              granular: {
                sandbox_approval: true,
                rules: true,
                mcp_elicitations: true,
              },
            },
            approvals_reviewer: "auto_review",
            sandbox_mode: "workspace-write",
          },
          origins: {},
        };
      }
      if (method === "turn/start") return { turn: { id: "turn-granular" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-granular"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({
      threadId: "thread-granular",
      cwd: "/tmp/project",
    });
    await expect(thread.startTurn("inherit", "client-granular", null, null, null))
      .resolves.toBe("turn-granular");

    const turnStart = connection.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).not.toHaveProperty("approvalPolicy");
    expect(turnStart?.params).toMatchObject({
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
    });
  });

  test("未materialize threadはresume失敗後も同じ接続から最初のturnを開始する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-fresh");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        throw new Error("no rollout found for thread id thread-fresh");
      }
      if (method === "turn/start") return { turn: { id: "turn-first" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-unmaterialized"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-fresh" });
    expect(thread.initialItems).toEqual([]);
    expect(thread.initialActiveTurnId).toBeNull();
    expect(thread.liveSubscriptionReady).toBe(false);
    await expect(thread.startTurn("first", "client-first")).resolves.toBe("turn-first");
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    expect(connection.closed).toBe(0);
  });

  test("thread/resume から別 client が開始した実行中 turn ID を復元する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-running");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-running", turns: [
          { id: "turn-done", status: "completed", items: [] },
          { id: "turn-live", status: "inProgress", items: [] },
        ] } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-running-turn"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-running" });

    expect(thread.initialActiveTurnId).toBe("turn-live");
    expect(thread.liveSubscriptionReady).toBe(true);
  });

  test("未materialize以外のresume失敗は接続を閉じて伝播する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-missing");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      throw new Error("thread not found");
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-missing"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    await expect(manager.openThread({ threadId: "thread-missing" }))
      .rejects.toThrow("thread not found");
    expect(connection.closed).toBe(1);
  });

  test("model/list をページングし、APIキャッシュのモデル別実効contextを結合する", async () => {
    const home = makeTempDir("codex-model-list");
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          context_window: 372_000,
          effective_context_window_percent: 95,
        },
        {
          slug: "gpt-5.3-codex-spark",
          context_window: 128_000,
          effective_context_window_percent: 95,
        },
      ],
    }));
    const connections: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      codexHome: home,
      connect: async () => {
        const connection = new FakeConnection();
        connection.request = async (method, params) => {
          connection.requests.push({ method, params });
          if (method !== "model/list") return { thread: { id: "thread" } };
          const cursor = (params as { cursor?: string }).cursor;
          return cursor === undefined
            ? {
                data: [{
                  id: "gpt-5.6-sol",
                  model: "gpt-5.6-sol",
                  displayName: "GPT-5.6-Sol",
                  description: "Latest frontier agentic coding model.",
                  hidden: false,
                  isDefault: true,
                  defaultReasoningEffort: "medium",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low", description: "Fast" },
                    { reasoningEffort: "medium", description: "Balanced" },
                    { reasoningEffort: "xhigh", description: "Deep" },
                  ],
                }],
                nextCursor: "next",
              }
            : {
                data: [
                  {
                    id: "gpt-5.3-codex-spark",
                    model: "gpt-5.3-codex-spark",
                    displayName: "GPT-5.3-Codex-Spark",
                    description: "Ultra-fast coding model.",
                    hidden: false,
                    isDefault: false,
                  },
                  {
                    id: "hidden",
                    model: "hidden",
                    displayName: "Hidden",
                    description: "",
                    hidden: true,
                    isDefault: false,
                  },
                ],
                nextCursor: null,
              };
        };
        connections.push(connection);
        return connection;
      },
      launch: () => {},
    });

    await expect(manager.listModels()).resolves.toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        contextWindow: 353_400,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "xhigh"],
        isDefault: true,
      },
      {
        id: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3-Codex-Spark",
        description: "Ultra-fast coding model.",
        contextWindow: 121_600,
        isDefault: false,
      },
    ]);
    expect(connections.at(-1)?.requests).toEqual([
      { method: "model/list", params: { limit: 100, includeHidden: false } },
      { method: "model/list", params: { limit: 100, includeHidden: false, cursor: "next" } },
    ]);
    expect(connections.at(-1)?.closed).toBe(1);
  });
});
