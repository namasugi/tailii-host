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
} from "../src/codex/codexAppServer.js";
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

function emitTitleTurn(
  connection: FakeConnection,
  text: string,
  status = "completed",
): void {
  queueMicrotask(() => {
    connection.notificationHandler?.({
      method: "turn/started",
      params: { threadId: "thread-title-ephemeral", turn: { id: "turn-title" } },
    });
    connection.notificationHandler?.({
      method: "item/completed",
      params: {
        threadId: "thread-title-ephemeral",
        turnId: "turn-title",
        item: { id: "title-answer", type: "agentMessage", text },
      },
    });
    connection.notificationHandler?.({
      method: "turn/completed",
      params: {
        threadId: "thread-title-ephemeral",
        turn: { id: "turn-title", status },
      },
    });
  });
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

  test("thread/name/set で正式タイトルを保存し空文字を送信前に拒否する", async () => {
    const connections: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-name-set"),
      connect: async () => {
        const connection = new FakeConnection();
        connections.push(connection);
        return connection;
      },
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await manager.setThreadName(" thread-1 ", "正式タイトル");

    expect(connections).toHaveLength(2);
    expect(connections[1]?.requests).toEqual([{
      method: "thread/name/set",
      params: { threadId: "thread-1", name: "正式タイトル" },
    }]);
    expect(connections.every((connection) => connection.closed === 1)).toBe(true);
    await expect(manager.setThreadName("  ", "x")).rejects.toThrow(
      "Codex thread id must not be empty",
    );
    await expect(manager.setThreadName("thread-1", " \n ")).rejects.toThrow(
      "Codex thread name must not be empty",
    );
    expect(connections).toHaveLength(2);
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

  test("gpt-5.6-luna の read-only ephemeral turn で短いタイトルを生成して保存する", async () => {
    const probe = new FakeConnection();
    const generation = new FakeConnection("thread-title-ephemeral");
    generation.request = async (method, params) => {
      generation.requests.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-target",
            name: null,
            turns: [{
              items: [{
                id: "first-user",
                type: "userMessage",
                content: [{ type: "text", text: "generateTitleが何をしているか調べられない？" }],
              }],
            }],
          },
        };
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-title-ephemeral" } };
      }
      if (method === "turn/start") {
        emitTitleTurn(generation, JSON.stringify({
          title: "generateTitleの仕組みを調査",
          description: "Codex Desktopのタイトル生成処理を確認",
        }));
        return { turn: { id: "turn-title" } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-title"),
      connect: async () => probe.closed === 0 ? probe : generation,
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.generateThreadTitle({
      threadId: "thread-target",
      cwd: "/tmp/project",
      prompt: "これは後続メッセージなのでタイトルには使わない",
    })).resolves.toEqual({
      title: "generateTitleの仕組みを調査",
      source: "model",
    });

    expect(generation.requests).toContainEqual({
      method: "thread/start",
      params: expect.objectContaining({
        model: "gpt-5.6-luna",
        allowProviderModelFallback: true,
        cwd: "/tmp/project",
        approvalPolicy: "never",
        permissions: ":read-only",
        ephemeral: true,
        threadSource: "system",
        config: expect.objectContaining({
          model_reasoning_effort: "low",
          "features.hooks": false,
          "features.plugins": false,
          web_search: "disabled",
        }),
      }),
    });
    expect(generation.requests).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thread-title-ephemeral",
        permissions: ":read-only",
        outputSchema: expect.objectContaining({
          required: ["title", "description"],
          properties: expect.objectContaining({
            title: { type: "string", minLength: 1, maxLength: 36 },
          }),
        }),
      }),
    });
    const titleTurn = generation.requests.find((request) => request.method === "turn/start");
    expect(titleTurn?.params).toEqual(expect.objectContaining({
      input: [expect.objectContaining({
        text: expect.stringContaining("generateTitleが何をしているか調べられない？"),
      })],
    }));
    expect(JSON.stringify(titleTurn?.params)).toContain(
      "same primary language as the user prompt",
    );
    expect(JSON.stringify(titleTurn?.params)).toContain(
      "Do not translate them into another language",
    );
    expect(JSON.stringify(titleTurn?.params)).not.toContain("これは後続メッセージ");
    expect(generation.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thread-target", name: "generateTitleの仕組みを調査" },
    });
    expect(generation.requests.at(-1)).toEqual({
      method: "thread/unsubscribe",
      params: { threadId: "thread-title-ephemeral" },
    });
    expect(generation.closed).toBe(1);
  });

  test("タイトル生成結果が不正なら初回入力の先頭60文字を保存する", async () => {
    const probe = new FakeConnection();
    const generation = new FakeConnection("thread-title-ephemeral");
    generation.request = async (method, params) => {
      generation.requests.push({ method, params });
      if (method === "thread/read") {
        return { thread: { id: "thread-target", name: null } };
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-title-ephemeral" } };
      }
      if (method === "turn/start") {
        emitTitleTurn(generation, "not-json");
        return { turn: { id: "turn-title" } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-title-fallback"),
      connect: async () => probe.closed === 0 ? probe : generation,
      launch: () => {
        throw new Error("must not spawn");
      },
    });
    const prompt = `${"あ".repeat(70)}\nignored`;

    await expect(manager.generateThreadTitle({
      threadId: "thread-target",
      cwd: "/tmp/project",
      prompt,
    })).resolves.toEqual({
      title: "あ".repeat(60),
      source: "promptFallback",
    });
    expect(generation.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thread-target", name: "あ".repeat(60) },
    });
  });

  test("初回turn直後の空rolloutではthread/listで既存名を保護してタイトルを保存する", async () => {
    const probe = new FakeConnection();
    const generation = new FakeConnection("thread-title-ephemeral");
    generation.request = async (method, params) => {
      generation.requests.push({ method, params });
      if (method === "thread/read") {
        throw new Error(
          "failed to read thread: thread-store internal error: failed to read session metadata " +
          "/tmp/rollout-thread-target.jsonl: rollout at /tmp/rollout-thread-target.jsonl is empty",
        );
      }
      if (method === "thread/list") {
        return {
          data: [{
            id: "thread-target",
            name: null,
            preview: null,
            updatedAt: 123,
            cwd: "/tmp/project",
            source: "vscode",
            parentThreadId: null,
          }],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-title-ephemeral" } };
      }
      if (method === "turn/start") {
        emitTitleTurn(generation, JSON.stringify({
          title: "Codex使用量表示を修正",
          description: "使用量と状態表示の不一致を直す",
        }));
        return { turn: { id: "turn-title" } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-title-empty-rollout"),
      connect: async () => probe.closed === 0 ? probe : generation,
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.generateThreadTitle({
      threadId: "thread-target",
      cwd: "/tmp/project",
      prompt: "codexのスラッシュコマンドの使用量・状態を修正したい",
    })).resolves.toEqual({
      title: "Codex使用量表示を修正",
      source: "model",
    });
    expect(generation.requests.filter((request) => request.method === "thread/list"))
      .toHaveLength(2);
    expect(generation.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thread-target", name: "Codex使用量表示を修正" },
    });
  });

  test("生成中に別 client が命名したら既存タイトルを上書きしない", async () => {
    const probe = new FakeConnection();
    const generation = new FakeConnection("thread-title-ephemeral");
    let readCount = 0;
    generation.request = async (method, params) => {
      generation.requests.push({ method, params });
      if (method === "thread/read") {
        readCount += 1;
        return {
          thread: {
            id: "thread-target",
            name: readCount === 1 ? null : "ユーザー指定タイトル",
          },
        };
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-title-ephemeral" } };
      }
      if (method === "turn/start") {
        emitTitleTurn(generation, JSON.stringify({
          title: "自動生成タイトル",
          description: "生成中に手動命名されたケース",
        }));
        return { turn: { id: "turn-title" } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-title-race"),
      connect: async () => probe.closed === 0 ? probe : generation,
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.generateThreadTitle({
      threadId: "thread-target",
      cwd: "/tmp/project",
      prompt: "タイトルを自動生成する",
    })).resolves.toEqual({ title: null, source: null });
    expect(generation.requests.some((request) => request.method === "thread/name/set")).toBe(false);
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
    await thread.steerTurn("turn-1", "追加指示", "client-steer-1");
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
        clientUserMessageId: "client-steer-1",
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

  test("旧App ServerがsteerのclientUserMessageIdを拒否したらIDなしで同じturnへ再試行する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-legacy-steer");
    let rejectedStableID = false;
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-legacy-steer", turns: [] } };
      }
      if (method === "turn/steer" &&
        typeof params === "object" && params !== null &&
        "clientUserMessageId" in params) {
        rejectedStableID = true;
        throw new Error(
          "Invalid params: unknown field `clientUserMessageId`, expected `threadId`",
        );
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-legacy-steer"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });
    const thread = await manager.openThread({ threadId: "thread-legacy-steer" });

    await thread.steerTurn("turn-1", "最初の追加", "client-steer-1");
    await thread.steerTurn("turn-1", "次の追加", "client-steer-2");

    expect(rejectedStableID).toBe(true);
    expect(connection.requests.filter((request) => request.method === "turn/steer"))
      .toEqual([
        {
          method: "turn/steer",
          params: {
            threadId: "thread-legacy-steer",
            input: [{ type: "text", text: "最初の追加" }],
            expectedTurnId: "turn-1",
            clientUserMessageId: "client-steer-1",
          },
        },
        {
          method: "turn/steer",
          params: {
            threadId: "thread-legacy-steer",
            input: [{ type: "text", text: "最初の追加" }],
            expectedTurnId: "turn-1",
          },
        },
        {
          method: "turn/steer",
          params: {
            threadId: "thread-legacy-steer",
            input: [{ type: "text", text: "次の追加" }],
            expectedTurnId: "turn-1",
          },
        },
      ]);
  });

  test("steerのtimeoutはIDなし再試行をせず到達不明のまま上位へ返す", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-steer-timeout");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-steer-timeout", turns: [] } };
      }
      if (method === "turn/steer") {
        throw new Error("Codex App Server request timed out: turn/steer");
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-steer-timeout"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });
    const thread = await manager.openThread({ threadId: "thread-steer-timeout" });

    await expect(thread.steerTurn("turn-1", "一度だけ", "client-steer"))
      .rejects.toThrow("timed out");
    expect(connection.requests.filter((request) => request.method === "turn/steer"))
      .toHaveLength(1);
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

  test("作成直後の空rolloutも未materializeとして最初のturnへ進む", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-empty");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        throw new Error(
          "failed to read thread: thread-store internal error: failed to read session metadata " +
          "/tmp/rollout-thread-empty.jsonl: rollout at /tmp/rollout-thread-empty.jsonl is empty",
        );
      }
      if (method === "turn/start") return { turn: { id: "turn-first" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-empty-rollout"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-empty" });
    expect(thread.liveSubscriptionReady).toBe(false);
    await expect(thread.startTurn("first", "client-first")).resolves.toBe("turn-first");
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
