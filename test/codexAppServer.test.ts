// codexAppServer.test.ts — Codex App Server singleton 起動と thread/start のテスト

import * as path from "node:path";
import * as fs from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { CodexNativeTurnController } from "../src/codex/codexNativeTurnController.js";
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

  async request(method: string, params: unknown, _timeoutMs?: number): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    // thread/read の turns は protocol 上必ず配列（履歴無しは空配列）。
    if (method === "thread/read") return { thread: { id: this.threadId, turns: [] } };
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
        const includeTurns = (params as { includeTurns?: boolean }).includeTurns;
        // 名前はメタデータだけの read で読み、legacy thread（historyMode 欠落）の最初の user prompt は
        // 全履歴 read で取る（legacy では非推奨でない。paginated は thread/items/list）。
        if (includeTurns !== true) return { thread: { id: "thread-target", name: null, turns: [] } };
        return {
          thread: {
            id: "thread-target",
            name: null,
            turns: [{
              id: "turn-first",
              status: "completed",
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
    expect(generation.requests.map((request) => request.params)).toContainEqual(
      { threadId: "thread-target", includeTurns: true },
    );
    expect(generation.requests.some((request) =>
      request.method === "thread/turns/list" || request.method === "thread/items/list",
    )).toBe(false);
    expect(generation.closed).toBe(1);
  });

  test("paginated のタイトル生成は user prompt が見つかったページで止まり、無ければ 4 ページで打ち切る", async () => {
    const run = async (
      name: string,
      onItems: (cursor: string | undefined, calls: number) => unknown,
    ) => {
      const probe = new FakeConnection();
      const generation = new FakeConnection("thread-title-ephemeral");
      let itemsCalls = 0;
      generation.request = async (method, params) => {
        generation.requests.push({ method, params });
        if (method === "thread/read") {
          return { thread: { id: "thread-target", name: null, historyMode: "paginated", turns: [] } };
        }
        if (method === "thread/items/list") {
          itemsCalls += 1;
          return onItems((params as { cursor?: string }).cursor, itemsCalls);
        }
        if (method === "thread/start") return { thread: { id: "thread-title-ephemeral" } };
        if (method === "turn/start") {
          emitTitleTurn(generation, JSON.stringify({ title: "生成タイトル", description: "d" }));
          return { turn: { id: "turn-title" } };
        }
        return {};
      };
      const manager = new CodexAppServerManager({
        codexHome: makeTempDir(`codex-thread-title-${name}`),
        connect: async () => probe.closed === 0 ? probe : generation,
        launch: () => {
          throw new Error("must not spawn");
        },
      });
      await expect(manager.generateThreadTitle({
        threadId: "thread-target", cwd: "/tmp/project", prompt: "controller の入力",
      })).resolves.toEqual({ title: "生成タイトル", source: "model" });
      const titleTurn = generation.requests.find((request) => request.method === "turn/start");
      return { itemsCalls, titleInput: JSON.stringify(titleTurn?.params) };
    };

    // 1 ページ目に userMessage があれば、続きの cursor があっても読まない。
    const found = await run("found-first", () => ({
      data: [
        { turnId: "t1", item: { id: "r-1", type: "reasoning", summary: [] } },
        { turnId: "t1", item: { id: "u-1", type: "userMessage", content: [{ type: "text", text: "最初の質問" }] } },
      ],
      nextCursor: "more",
    }));
    expect(found.itemsCalls).toBe(1);
    expect(found.titleInput).toContain("最初の質問");

    // userMessage が無ければ 4 ページで打ち切り、controller の入力へ落とす。
    const missing = await run("missing", (_cursor, calls) => ({
      data: [{ turnId: "t1", item: { id: `r-${calls}`, type: "reasoning", summary: [] } }],
      nextCursor: `page-${calls + 1}`,
    }));
    expect(missing.itemsCalls).toBe(4);
    expect(missing.titleInput).toContain("controller の入力");
  });

  test("命名済み thread は履歴を読まずにタイトル生成をスキップする", async () => {
    const probe = new FakeConnection();
    const generation = new FakeConnection("thread-title-ephemeral");
    generation.request = async (method, params) => {
      generation.requests.push({ method, params });
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: "thread-target", includeTurns: false });
        return { thread: { id: "thread-target", name: "手動タイトル", historyMode: "paginated", turns: [] } };
      }
      throw new Error(`unexpected request ${method}`);
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-title-named"),
      connect: async () => probe.closed === 0 ? probe : generation,
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.generateThreadTitle({
      threadId: "thread-target",
      cwd: "/tmp/project",
      prompt: "新しい入力",
    })).resolves.toEqual({ title: null, source: null });
    expect(generation.requests.map((request) => request.method)).toEqual(["thread/read"]);
  });

  test("paginated thread のタイトル生成は最初の user prompt を thread/items/list から読む", async () => {
    const probe = new FakeConnection();
    const generation = new FakeConnection("thread-title-ephemeral");
    generation.request = async (method, params) => {
      generation.requests.push({ method, params });
      if (method === "thread/read") {
        return { thread: { id: "thread-target", name: null, historyMode: "paginated", turns: [] } };
      }
      if (method === "thread/items/list") {
        expect(params).toEqual({ threadId: "thread-target", limit: 100, sortDirection: "asc" });
        return {
          data: [{
            turnId: "turn-first",
            item: {
              id: "first-user",
              type: "userMessage",
              content: [{ type: "text", text: "paginated の最初の質問" }],
            },
          }],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-title-ephemeral" } };
      }
      if (method === "turn/start") {
        emitTitleTurn(generation, JSON.stringify({
          title: "最初の質問を要約",
          description: "paginated thread の命名",
        }));
        return { turn: { id: "turn-title" } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-thread-title-paginated"),
      connect: async () => probe.closed === 0 ? probe : generation,
      launch: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(manager.generateThreadTitle({
      threadId: "thread-target",
      cwd: "/tmp/project",
      prompt: "これは後続メッセージなのでタイトルには使わない",
    })).resolves.toEqual({ title: "最初の質問を要約", source: "model" });
    const titleTurn = generation.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(titleTurn?.params)).toContain("paginated の最初の質問");
    expect(JSON.stringify(titleTurn?.params)).not.toContain("これは後続メッセージ");
    expect(generation.requests.some((request) => request.method === "thread/turns/list")).toBe(false);
    expect(generation.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thread-target", name: "最初の質問を要約" },
    });
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
        excludeTurns: true,
      },
    });
    expect(connection.requests).toContainEqual({
      method: "thread/read", // historyMode 欠落＝legacy: 全履歴 read（legacy では非推奨でない）
      params: { threadId: "thread-live", includeTurns: true },
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
      if (method === "thread/resume" || method === "thread/read") {
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
      if (method === "thread/resume" || method === "thread/read") {
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
      if (method === "thread/resume" || method === "thread/read") {
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
      if (method === "thread/resume" || method === "thread/read") {
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
      if (method === "thread/turns/list") {
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
    await expect(thread.readActiveTurnId()).resolves.toBeUndefined();
    await expect(thread.startTurn("first", "client-first")).resolves.toBe("turn-first");
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/turns/list", // readActiveTurnId（既知文言なので thread/read の確認は不要）
      "turn/start",
    ]);
    expect(connection.closed).toBe(0);
  });

  test("paginated thread(codex 0.153.4+)の turn 前 `list_turns is not supported yet` も未materializeとして最初のturnを開始する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-paginated");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      // historyMode=paginated の live thread は turn が無い間、メタデータだけの thread/resume
      // （excludeTurns:true）には応答する一方、thread/turns/list（と全履歴 hydration）を
      // JSON-RPC -32601 でこの文言のまま拒否する（thread id を含まない）。
      if (method === "thread/resume") {
        expect(params).toEqual({ threadId: "thread-paginated", excludeTurns: true });
        return { thread: {
          id: "thread-paginated", historyMode: "paginated", status: { type: "idle" }, turns: [],
        } };
      }
      if (method === "thread/turns/list") {
        throw new Error("list_turns is not supported yet");
      }
      if (method === "turn/start") return { turn: { id: "turn-first" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-paginated"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-paginated" });
    expect(thread.initialItems).toEqual([]);
    expect(thread.initialActiveTurnId).toBeNull();
    // resume 自体が成立しても turn 履歴が読めない間は live 権威にせず rollout fallback へ回す。
    expect(thread.liveSubscriptionReady).toBe(false);
    expect(thread.liveSubscriptionError).toContain("list_turns is not supported yet");
    await expect(thread.readActiveTurnId()).resolves.toBeUndefined();
    await expect(thread.startTurn("first", "client-first")).resolves.toBe("turn-first");
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/turns/list", // openThread の履歴読み取り（既知文言なので thread/read の確認は不要）
      "thread/turns/list", // readActiveTurnId
      "turn/start",
    ]);
    expect(connection.closed).toBe(0);
  });

  test("未materialize文言の method 部分（thread/turns/list 等）が違っても同じ thread id なら未materializeとして扱う", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-variant");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        throw new Error("no rollout found for thread id thread-variant");
      }
      if (method === "thread/turns/list") {
        throw new Error(
          "thread thread-variant is not materialized yet; " +
          "thread/turns/list is unavailable before first user message",
        );
      }
      if (method === "turn/start") return { turn: { id: "turn-first" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-variant"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-variant" });
    await expect(thread.readActiveTurnId()).resolves.toBeUndefined();
    await expect(thread.startTurn("first", "client-first")).resolves.toBe("turn-first");
  });

  test("別 thread id の未materialize文言や無関係な not supported エラーは伝播する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-other");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        throw new Error("thread thread-someone-else is not materialized yet; includeTurns is unavailable before first user message");
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-other"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });
    await expect(manager.openThread({ threadId: "thread-other" })).rejects.toThrow(
      "thread thread-someone-else is not materialized yet",
    );
    expect(connection.closed).toBe(1);

    const connection2 = new FakeConnection("thread-unsupported");
    connection2.request = async (method, params) => {
      connection2.requests.push({ method, params });
      if (method === "thread/resume") throw new Error("thread/timeline/list is not supported yet");
      return {};
    };
    const probe2 = new FakeConnection();
    const manager2 = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-unsupported"),
      connect: async () => probe2.closed === 0 ? probe2 : connection2,
      launch: () => {},
    });
    await expect(manager2.openThread({ threadId: "thread-unsupported" })).rejects.toThrow(
      "thread/timeline/list is not supported yet",
    );
  });

  test("未知の文言でも thread メタデータが読めれば未materializeとして扱い、理由を保持して最初のturnを開始する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-unknown-wording");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      // 将来の版で文言が変わった想定。メタデータだけの read は応答する。
      if (method === "thread/resume") throw new Error("turn history hydration failed (future wording)");
      if (method === "thread/read") return { thread: { id: "thread-unknown-wording", status: { type: "idle" }, turns: [] } };
      if (method === "thread/turns/list") throw new Error("some brand new error text");
      if (method === "turn/start") return { turn: { id: "turn-first" } };
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-unknown-wording"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-unknown-wording" });
    expect(thread.liveSubscriptionReady).toBe(false);
    expect(thread.liveSubscriptionError).toContain("future wording");
    await expect(thread.readActiveTurnId()).resolves.toBeUndefined();
    await expect(thread.startTurn("first", "client-first")).resolves.toBe("turn-first");
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/read", // 文言非依存の確認（includeTurns:false）
      "thread/turns/list", // readActiveTurnId
      "thread/read", // 文言非依存の確認（includeTurns:false）
      "turn/start",
    ]);
    expect(connection.closed).toBe(0);
  });

  test("thread メタデータも読めない失敗は未materializeとみなさず伝播する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-gone");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") throw new Error("some brand new error text");
      if (method === "thread/read") throw new Error("thread not loaded: thread-gone");
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-gone"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });
    await expect(manager.openThread({ threadId: "thread-gone" })).rejects.toThrow(
      "some brand new error text",
    );
    expect(connection.closed).toBe(1);
  });

  test("thread/turns/list timeout は文言非依存の確認をせず、有界リトライ後に伝播する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-timeout-probe");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") throw new Error("no rollout found for thread id thread-timeout-probe");
      if (method === "thread/turns/list") {
        throw new Error("Codex App Server request timed out: thread/turns/list");
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-timeout-probe"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });
    const thread = await manager.openThread({ threadId: "thread-timeout-probe" });
    await expect(thread.readActiveTurnId()).rejects.toThrow("timed out: thread/turns/list");
    expect(connection.requests.filter((request) => request.method === "thread/turns/list"))
      .toHaveLength(2);
    expect(connection.requests.filter((request) => request.method === "thread/read")).toEqual([]);
  });

  test("fallback 接続の実行中 turn 読み直しは thread/turns/list の最新 1 件だけを読む", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-paged");
    let latestStatus = "inProgress";
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") throw new Error("list_turns is not supported yet");
      if (method === "thread/turns/list") {
        expect(params).toEqual({ threadId: "thread-paged", limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        return { data: [{ id: "turn-live", status: latestStatus, items: [], itemsView: "notLoaded" }] };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-paged"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });
    const thread = await manager.openThread({ threadId: "thread-paged" });
    await expect(thread.readActiveTurnId()).resolves.toBe("turn-live");
    latestStatus = "completed";
    await expect(thread.readActiveTurnId()).resolves.toBeNull();
  });

  test("App Server daemon と codex CLI の版ずれを 1 回だけログする", async () => {
    const logs: string[] = [];
    const connection = new FakeConnection("thread-version");
    connection.initialize = async () => ({ userAgent: "tailii_host/0.150.0 (Mac OS 26.5; arm64) unknown" });
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-version"),
      connect: async () => connection,
      launch: () => {},
      log: (message) => logs.push(message),
      cliVersion: async () => "0.153.4",
    });
    expect(await manager.connectIfRunning()).toBe(connection);
    expect(await manager.connectIfRunning()).toBe(connection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("0.150.0");
    expect(logs[0]).toContain("0.153.4");

    const same = new FakeConnection("thread-version-same");
    same.initialize = async () => ({ userAgent: "tailii_host/0.153.4 (Mac OS 26.5; arm64) unknown" });
    const sameLogs: string[] = [];
    const sameManager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-version-same"),
      connect: async () => same,
      launch: () => {},
      log: (message) => sameLogs.push(message),
      cliVersion: async () => "0.153.4",
    });
    await sameManager.connectIfRunning();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sameLogs).toEqual([]);
  });

  test("未materialize threadのthread/turns/list timeoutは有界リトライして回復する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-read-retry");
    let readAttempts = 0;
    const readTimeouts: Array<number | undefined> = [];
    connection.request = async (method, params, timeoutMs) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        throw new Error("no rollout found for thread id thread-read-retry");
      }
      if (method === "thread/turns/list") {
        readAttempts += 1;
        readTimeouts.push(timeoutMs);
        if (readAttempts < 2) {
          throw new Error("Codex App Server request timed out: thread/turns/list");
        }
        return { data: [
          { id: "turn-live", status: "inProgress", items: [], itemsView: "notLoaded" },
        ], nextCursor: null };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-read-retry"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-read-retry" });

    await expect(thread.readActiveTurnId()).resolves.toBe("turn-live");
    expect(readAttempts).toBe(2);
    expect(readTimeouts).toEqual([undefined, 2_000]);
  });

  test("子 thread の status を履歴復元用に読み取る", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-parent");
    let childReadAttempts = 0;
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-parent", turns: [] } };
      }
      if (method === "thread/read") {
        const { threadId } = params as { threadId: string };
        // 親（legacy）の履歴 read は成功し、子 thread の status read だけ 1 回 timeout する。
        if (threadId === "thread-parent") return { thread: { id: "thread-parent", turns: [] } };
        childReadAttempts += 1;
        if (childReadAttempts === 1) {
          throw new Error("Codex App Server request timed out: thread/read");
        }
        return { thread: {
          id: "thread-child", status: { type: "idle" }, createdAt: 1_785_640_406,
        } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-child-status"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-parent" });

    await expect(thread.readThreadStatus("thread-child")).resolves.toEqual({
      status: { type: "idle" }, timestampMs: 1_785_640_406_000,
    });
    expect(childReadAttempts).toBe(2);
    expect(connection.requests.at(-1)).toEqual({
      method: "thread/read",
      params: { threadId: "thread-child", includeTurns: false },
    });
  });

  test("未materialize threadのthread/turns/list timeoutは2回で打ち切る", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-read-timeout");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        throw new Error("no rollout found for thread id thread-read-timeout");
      }
      if (method === "thread/turns/list") {
        throw new Error("Codex App Server request timed out: thread/turns/list");
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-read-timeout"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-read-timeout" });

    await expect(thread.readActiveTurnId()).rejects.toThrow("timed out: thread/turns/list");
    expect(connection.requests.filter((request) => request.method === "thread/turns/list"))
      .toHaveLength(2);
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

  test("legacy thread の履歴は thread/read includeTurns:true を 1 回で読み、実行中 turn と item を復元する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-running");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        // メタデータだけの resume。legacy thread は items/list 未対応で、全履歴 read は非推奨でない。
        return { thread: {
          id: "thread-running", historyMode: "legacy", status: { type: "active", activeFlags: [] }, turns: [],
        } };
      }
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: "thread-running", includeTurns: true });
        return { thread: { id: "thread-running", historyMode: "legacy", turns: [
          { id: "turn-done", status: "completed", items: [
            { id: "user-1", type: "userMessage", content: [{ type: "text", text: "hi" }] },
            { id: "msg-1", type: "agentMessage", text: "hello" },
          ] },
          { id: "turn-live", status: "inProgress", items: [
            { id: "user-2", type: "userMessage", content: [{ type: "text", text: "more" }] },
          ] },
        ] } };
      }
      if (method === "thread/turns/list") {
        expect(params).toEqual({
          threadId: "thread-running", limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        });
        return { data: [
          { id: "turn-refreshed", status: "inProgress", items: [], itemsView: "notLoaded" },
        ], nextCursor: null };
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
    expect(thread.initialItems.map((item) => item["id"])).toEqual(["user-1", "msg-1", "user-2"]);
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/read", // legacy: rollout を 1 回で再生（turns/list itemsView:full はページ毎に再生するため不採用）
    ]);
    expect(connection.requests).toContainEqual({
      method: "thread/resume",
      params: { threadId: "thread-running", excludeTurns: true },
    });
    // paginated 限定で非推奨の excludeTurns:false と、互換経路 itemsView:full は使わない。
    const compatCalls = connection.requests.filter((request) => {
      const requestParams = request.params as { excludeTurns?: boolean; itemsView?: string } | null;
      return requestParams?.excludeTurns === false || requestParams?.itemsView === "full";
    });
    expect(compatCalls).toEqual([]);

    await expect(thread.readActiveTurnId()).resolves.toBe("turn-refreshed");
    expect(connection.requests.at(-1)).toEqual({
      method: "thread/turns/list",
      params: { threadId: "thread-running", limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
    });
  });

  test("paginated thread の履歴は thread/items/list でページ読みし、実行中 turn は turns/list の最新 1 件から復元する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-paginated-running");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: {
          id: "thread-paginated-running", historyMode: "paginated",
          status: { type: "active", activeFlags: [] }, turns: [],
        } };
      }
      if (method === "thread/turns/list") {
        expect(params).toEqual({
          threadId: "thread-paginated-running", limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        });
        return { data: [
          { id: "turn-live", status: "inProgress", items: [], itemsView: "notLoaded" },
        ], nextCursor: null };
      }
      if (method === "thread/items/list") {
        const { cursor } = params as { cursor?: string };
        return cursor === undefined
          ? { data: [
              { turnId: "turn-done", item: {
                id: "user-1", type: "userMessage", content: [{ type: "text", text: "hi" }],
              } },
              { turnId: "turn-done", item: { id: "msg-1", type: "agentMessage", text: "hello" } },
            ], nextCursor: "items-page-2" }
          : { data: [
              { turnId: "turn-live", item: {
                id: "user-2", type: "userMessage", content: [{ type: "text", text: "more" }],
              } },
            ], nextCursor: null };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-paginated-running"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-paginated-running" });

    expect(thread.liveSubscriptionReady).toBe(true);
    expect(thread.initialActiveTurnId).toBe("turn-live");
    expect(thread.initialItems.map((item) => item["id"])).toEqual(["user-1", "msg-1", "user-2"]);
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/turns/list", // 実行中 turn（turn 前ならここで list_turns 文言になり fallback へ）
      "thread/items/list",
      "thread/items/list", // cursor の続き
    ]);
    expect(connection.requests
      .filter((request) => request.method === "thread/items/list")
      .map((request) => request.params)).toEqual([
      { threadId: "thread-paginated-running", limit: 100, sortDirection: "asc" },
      { threadId: "thread-paginated-running", limit: 100, sortDirection: "asc", cursor: "items-page-2" },
    ]);
    // 互換経路 itemsView:"full" と全履歴 hydration は paginated thread では使わない。
    expect(connection.requests.some((request) => {
      const requestParams = request.params as
        { itemsView?: string; excludeTurns?: boolean; includeTurns?: boolean } | null;
      return requestParams?.itemsView === "full" ||
        requestParams?.excludeTurns === false || requestParams?.includeTurns === true;
    })).toBe(false);
  });

  test("履歴ページングは cursor が進まない応答で打ち切り、重複 item は id で排除する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-stuck-cursor");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-stuck-cursor", historyMode: "paginated", turns: [] } };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" }], nextCursor: null };
      }
      if (method === "thread/items/list") {
        // 同じ cursor を返し続ける壊れた server。
        return { data: [{ turnId: "turn-1", item: { id: "user-1", type: "userMessage", content: [] } }], nextCursor: "same" };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-stuck-cursor"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-stuck-cursor" });

    expect(thread.liveSubscriptionReady).toBe(true);
    // 同じページの再取得は id で重複排除し、境界スナップショットの occurrence を水増ししない
    // （水増しすると hub の flushCodexBuffer が同じ本文を 2 回出す）。
    expect(thread.initialItems.map((item) => item["id"])).toEqual(["user-1"]);
    expect(connection.requests.filter((request) => request.method === "thread/items/list"))
      .toHaveLength(2);
  });

  test("履歴ページング中の一時失敗（compaction による invalid cursor）は 1 回だけ読み直して live 購読を保つ", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-retry-snapshot");
    let itemsCalls = 0;
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-retry-snapshot", historyMode: "paginated", turns: [] } };
      }
      if (method === "thread/turns/list") {
        return { data: [
          { id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" },
        ], nextCursor: null };
      }
      if (method === "thread/items/list") {
        itemsCalls += 1;
        if (itemsCalls === 1) throw new Error("invalid cursor: anchor turn is no longer present");
        return { data: [
          { turnId: "turn-1", item: { id: "user-1", type: "userMessage", content: [] } },
        ], nextCursor: null };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-retry-snapshot"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-retry-snapshot" });

    expect(thread.liveSubscriptionReady).toBe(true);
    expect(thread.initialItems.map((item) => item["id"])).toEqual(["user-1"]);
    expect(connection.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/turns/list",
      "thread/items/list", // 一時失敗
      "thread/turns/list", // 読み直し
      "thread/items/list",
    ]);
    // 文言非依存の確認（thread/read includeTurns:false）へ落ちていない。
    expect(connection.requests.some((request) => request.method === "thread/read")).toBe(false);
  });

  test("materialize 済み thread の履歴読み取りが読み直しでも失敗したら、理由を保持して rollout fallback へ回す", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-broken-history");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-broken-history", historyMode: "paginated", turns: [] } };
      }
      if (method === "thread/turns/list") {
        return { data: [
          { id: "turn-1", status: "inProgress", items: [], itemsView: "notLoaded" },
        ], nextCursor: null };
      }
      if (method === "thread/items/list") {
        throw new Error("failed to list thread items: failed to deserialize stored thread item");
      }
      if (method === "thread/read") {
        return { thread: {
          id: "thread-broken-history", historyMode: "paginated",
          status: { type: "active", activeFlags: [] }, turns: [],
        } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-broken-history"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-broken-history" });

    // 履歴ゼロで live 権威にはせず、接続は保持したまま fallback（初回 turn/start は同じ接続から送れる）。
    expect(thread.liveSubscriptionReady).toBe(false);
    expect(thread.liveSubscriptionError).toContain("failed to deserialize stored thread item");
    expect(thread.initialItems).toEqual([]);
    expect(connection.closed).toBe(0);
    expect(connection.requests.filter((request) => request.method === "thread/items/list"))
      .toHaveLength(2);
    // fallback 接続でも turn/start 前の再確認は turns/list から実行中 turn を拾える。
    await expect(thread.readActiveTurnId()).resolves.toBe("turn-1");
  });

  test("thread/items/list の応答形が違えば読み直さずに rollout fallback へ回す（無言の空履歴にしない）", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-shape");
    let itemsShape: "no-data" | "unknown-item" = "no-data";
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-shape", historyMode: "paginated", turns: [] } };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" }], nextCursor: null };
      }
      if (method === "thread/items/list") {
        return itemsShape === "no-data"
          ? { items: [] } // data 欠落
          : { data: [{ foo: "bar" }, { baz: 1 }], nextCursor: null }; // 封筒でも ThreadItem でもない
      }
      if (method === "thread/read") {
        return { thread: { id: "thread-shape", historyMode: "paginated", turns: [] } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-items-shape"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const noData = await manager.openThread({ threadId: "thread-shape" });
    expect(noData.liveSubscriptionReady).toBe(false);
    expect(noData.liveSubscriptionError).toContain("omitted data");
    // 恒久的な形違いは読み直さない（items/list は 1 回）。
    expect(connection.requests.filter((request) => request.method === "thread/items/list")).toHaveLength(1);
    noData.close();

    itemsShape = "unknown-item";
    connection.requests.length = 0;
    const probe2 = new FakeConnection();
    const manager2 = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-items-shape-2"),
      connect: async () => probe2.closed === 0 ? probe2 : connection,
      launch: () => {},
    });
    const unknownItem = await manager2.openThread({ threadId: "thread-shape" });
    expect(unknownItem.liveSubscriptionReady).toBe(false);
    expect(unknownItem.liveSubscriptionError).toContain("unknown shape");
    expect(connection.requests.filter((request) => request.method === "thread/items/list")).toHaveLength(1);
  });

  test("thread/items/list は 0.144.5 形（素の ThreadItem 配列）も受ける", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-bare-items");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-bare-items", historyMode: "paginated", turns: [] } };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" }], nextCursor: null };
      }
      if (method === "thread/items/list") {
        return { data: [
          { id: "user-1", type: "userMessage", content: [{ type: "text", text: "hi" }] },
          { id: "msg-1", type: "agentMessage", text: "hello" },
        ], nextCursor: null };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-bare-items"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-bare-items" });

    expect(thread.liveSubscriptionReady).toBe(true);
    expect(thread.initialItems.map((item) => item["id"])).toEqual(["user-1", "msg-1"]);
  });

  test("legacy の thread/read が thread.turns を返さなければ rollout fallback へ回す", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-no-turns");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-no-turns", historyMode: "legacy", turns: [] } };
      }
      if (method === "thread/read") {
        const { includeTurns } = params as { includeTurns: boolean };
        return includeTurns
          ? { thread: { id: "thread-no-turns" } } // turns 欠落（応答形の違い）
          : { thread: { id: "thread-no-turns", historyMode: "legacy", turns: [] } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-no-turns"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-no-turns" });

    expect(thread.liveSubscriptionReady).toBe(false);
    expect(thread.liveSubscriptionError).toContain("omitted thread.turns");
    expect(thread.initialItems).toEqual([]);
  });

  test("履歴ページングは空ページ・循環 cursor・上限ページ数で止まる", async () => {
    const makeManager = (
      name: string,
      onItems: (cursor: string | undefined, calls: number) => unknown,
    ) => {
      const probe = new FakeConnection();
      const connection = new FakeConnection(name);
      let calls = 0;
      connection.request = async (method, params) => {
        connection.requests.push({ method, params });
        if (method === "thread/resume") return { thread: { id: name, historyMode: "paginated", turns: [] } };
        if (method === "thread/turns/list") {
          return { data: [{ id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" }], nextCursor: null };
        }
        if (method === "thread/items/list") {
          calls += 1;
          return onItems((params as { cursor?: string }).cursor, calls);
        }
        if (method === "thread/read") return { thread: { id: name, historyMode: "paginated", turns: [] } };
        return {};
      };
      const manager = new CodexAppServerManager({
        codexHome: makeTempDir(`codex-app-server-${name}`),
        connect: async () => probe.closed === 0 ? probe : connection,
        launch: () => {},
      });
      return { manager, connection, itemsCalls: () => calls };
    };
    const item = (id: string) => ({ turnId: "turn-1", item: { id, type: "userMessage", content: [] } });

    // 空ページ + 非 null cursor: 1 回で止まる。
    const empty = makeManager("thread-empty-page", () => ({ data: [], nextCursor: "more" }));
    const emptyThread = await empty.manager.openThread({ threadId: "thread-empty-page" });
    expect(emptyThread.liveSubscriptionReady).toBe(true);
    expect(emptyThread.initialItems).toEqual([]);
    expect(empty.itemsCalls()).toBe(1);

    // 循環 cursor（A → B → A）: 既出 cursor で止まり、item は id で重複排除。
    const cycle = makeManager("thread-cycle", (cursor) =>
      cursor === undefined
        ? { data: [item("i-1")], nextCursor: "A" }
        : cursor === "A"
          ? { data: [item("i-2")], nextCursor: "B" }
          : { data: [item("i-1")], nextCursor: "A" });
    const cycleThread = await cycle.manager.openThread({ threadId: "thread-cycle" });
    expect(cycleThread.liveSubscriptionReady).toBe(true);
    expect(cycleThread.initialItems.map((entry) => entry["id"])).toEqual(["i-1", "i-2"]);
    expect(cycle.itemsCalls()).toBe(3);

    // 上限ページ数: 毎回新しい cursor を返す壊れた server でも 2000 ページで打ち切り、読み直さず fallback。
    const runaway = makeManager("thread-runaway", (_cursor, calls) =>
      ({ data: [item(`i-${calls}`)], nextCursor: `page-${calls + 1}` }));
    const runawayThread = await runaway.manager.openThread({ threadId: "thread-runaway" });
    expect(runawayThread.liveSubscriptionReady).toBe(false);
    expect(runawayThread.liveSubscriptionError).toContain("exceeded 2000 pages");
    expect(runaway.itemsCalls()).toBe(2000);

  });

  test.each(["completed", "inProgress"])(
    "画像を含む履歴の途中で timeout しても、別接続で送信を復旧する（直近 turn: %s）",
    async (status) => {
      const probe = new FakeConnection();
      const slow = new FakeConnection("thread-large");
      const recovered = new FakeConnection("thread-large");
      const remaining = [probe, slow, recovered];
      const logs: string[] = [];
      for (const connection of [slow, recovered]) {
        connection.request = async (method, params) => {
          connection.requests.push({ method, params });
          if (method === "thread/resume") {
            return { thread: { id: "thread-large", historyMode: "paginated", model: "gpt-6-astra" } };
          }
          if (method === "thread/turns/list") {
            return { data: [{ id: "turn-current", status, items: [] }], nextCursor: null };
          }
          if (method === "thread/items/list") {
            expect(connection).toBe(slow);
            if (!(params as { cursor?: string }).cursor) {
              return { data: [{ item: { id: "partial", type: "agentMessage", text: "部分履歴" } }], nextCursor: "large-page" };
            }
            throw new Error("Codex App Server request timed out: thread/items/list");
          }
          if (method === "turn/start") return { turn: { id: "turn-new" } };
          if (method === "turn/steer") return { turnId: "turn-current" };
          throw new Error(`unexpected request: ${method}`);
        };
      }
      const manager = new CodexAppServerManager({
        codexHome: makeTempDir("codex-app-server-large-history"),
        connect: async () => {
          const connection = remaining.shift();
          if (!connection) throw new Error("unexpected reconnect");
          return connection;
        },
        launch: () => {},
        log: (message) => logs.push(message),
      });
      const controller = new CodexNativeTurnController({
        appServer: { openThread: (options) => manager.openThread(options) },
      });
      const session = { session: "work", threadId: "thread-large", cwd: "/tmp/work" };

      const snapshot = await controller.subscribeSession(session);
      expect(snapshot.liveSubscribed).toBe(false);
      expect(snapshot.liveSubscriptionError).toContain("timed out: thread/items/list");
      expect(snapshot.itemIds.size).toBe(0); // 途中までの履歴を権威にしない。
      expect(snapshot.model).toBe("gpt-6-astra");
      expect(slow.closed).toBe(1);
      expect(slow.notificationHandler).toBeNull();
      expect(slow.serverRequestHandler).toBeNull();
      expect(recovered.initialized).toBe(1);
      expect(recovered.notificationHandler).not.toBeNull();
      expect(recovered.serverRequestHandler).not.toBeNull();
      expect(recovered.closed).toBe(0);
      expect(logs.some((line) => line.includes("新しい接続で turn 操作を復旧"))).toBe(true);

      await expect(controller.startTurn({ ...session, text: "続けて", clientUserMessageId: "client-once" }))
        .resolves.toBe(status === "inProgress" ? "turn-current" : "turn-new");
      expect(recovered.requests.filter((r) => r.method === "thread/items/list")).toEqual([]);
      const sends = recovered.requests.filter((r) => r.method.startsWith("turn/"));
      expect(sends).toHaveLength(1);
      expect(sends[0]?.method).toBe(status === "inProgress" ? "turn/steer" : "turn/start");
      expect(sends[0]?.params).toMatchObject({ clientUserMessageId: "client-once" });
      controller.closeSession("work");
    },
  );

  test.each(["thread/resume", "thread/turns/list"])(
    "履歴 timeout 後の制御接続も %s で失敗したら再接続を繰り返さず送信しない",
    async (failedMethod) => {
      const probe = new FakeConnection();
      const slow = new FakeConnection("thread-unresponsive");
      const recovery = new FakeConnection("thread-unresponsive");
      const remaining = [probe, slow, recovery];
      for (const connection of [slow, recovery]) {
        connection.request = async (method, params) => {
          connection.requests.push({ method, params });
          if ((connection === recovery && method === failedMethod) || method === "thread/items/list") {
            throw new Error(`Codex App Server request timed out: ${method}`);
          }
          if (method === "thread/resume") return { thread: { id: "thread-unresponsive", historyMode: "paginated" } };
          if (method === "thread/turns/list") return { data: [], nextCursor: null };
          throw new Error(`unexpected request: ${method}`);
        };
      }
      const manager = new CodexAppServerManager({
        codexHome: makeTempDir("codex-app-server-recovery-failed"),
        connect: async () => {
          const connection = remaining.shift();
          if (!connection) throw new Error("unexpected reconnect");
          return connection;
        },
        launch: () => {},
      });
      await expect(manager.openThread({ threadId: "thread-unresponsive" }))
        .rejects.toThrow(`timed out: ${failedMethod}`);
      expect(remaining).toEqual([]);
      expect(slow.closed).toBe(1);
      expect(recovery.closed).toBe(1);
      expect(recovery.requests.some((r) => r.method.startsWith("turn/"))).toBe(false);
    },
  );

  test("履歴全ページで3秒の期限を共有し、期限を超える次ページを送らず制御を復旧する", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const probe = new FakeConnection();
      const slow = new FakeConnection("thread-budget");
      const recovered = new FakeConnection("thread-budget");
      const remaining = [probe, slow, recovered];
      const timeouts: Array<number | undefined> = [];
      slow.request = async (method, params, timeoutMs) => {
        slow.requests.push({ method, params });
        if (method === "thread/resume") return { thread: { id: "thread-budget", historyMode: "paginated" } };
        timeouts.push(timeoutMs);
        if (method === "thread/turns/list") {
          now = 1_000;
          return { data: [], nextCursor: null };
        }
        if (method === "thread/items/list") {
          now = now === 1_000 ? 2_500 : 3_001;
          return { data: [{ type: "agentMessage", id: `item-${now}`, text: "item" }], nextCursor: `page-${now}` };
        }
        throw new Error(`unexpected request: ${method}`);
      };
      const manager = new CodexAppServerManager({
        codexHome: makeTempDir("codex-app-server-history-budget"),
        connect: async () => {
          const connection = remaining.shift();
          if (!connection) throw new Error("unexpected reconnect");
          return connection;
        },
        launch: () => {},
      });
      const thread = await manager.openThread({ threadId: "thread-budget" });
      expect(timeouts).toEqual([3_000, 2_000, 500]);
      expect(thread.liveSubscriptionReady).toBe(false);
      expect(thread.initialItems).toEqual([]);
      expect(thread.liveSubscriptionError).toContain("timed out: thread/items/list");
      expect(slow.closed).toBe(1);
      thread.close();
    } finally {
      clock.mockRestore();
    }
  });

  test("実行中 turn の復元は末尾から最初の inProgress を採用する", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-two-active");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-two-active", historyMode: "legacy", turns: [] } };
      }
      if (method === "thread/read") {
        // 旧版の rollout は中断された turn が inProgress のまま残ることがある。最新を優先する。
        return { thread: { id: "thread-two-active", turns: [
          { id: "turn-stale", status: "inProgress", items: [] },
          { id: "turn-done", status: "completed", items: [] },
          { id: "turn-latest", status: "inProgress", items: [] },
        ] } };
      }
      return {};
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-two-active"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-two-active" });

    expect(thread.initialActiveTurnId).toBe("turn-latest");
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
          // 利用者設定の既定（config.toml の model）は preset の isDefault より優先する。
          if (method === "config/read") return { config: { model: "gpt-5.3-codex-spark" } };
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
        isDefault: false,
      },
      {
        id: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3-Codex-Spark",
        description: "Ultra-fast coding model.",
        contextWindow: 121_600,
        isDefault: true,
      },
    ]);
    expect(connections.at(-1)?.requests).toEqual([
      { method: "model/list", params: { limit: 100, includeHidden: false } },
      { method: "model/list", params: { limit: 100, includeHidden: false, cursor: "next" } },
      { method: "config/read", params: { includeLayers: false } },
    ]);
    expect(connections.at(-1)?.closed).toBe(1);
  });

  test("config/read の model が一覧に無い・読めないときは preset の isDefault を使う", async () => {
    const page = {
      data: [
        { id: "gpt-a", model: "gpt-a", displayName: "A", description: "", hidden: false, isDefault: true },
        { id: "gpt-b", model: "gpt-b", displayName: "B", description: "", hidden: false, isDefault: false },
        // hidden の model は表示されないので、config がそれを指していても既定にはしない。
        { id: "gpt-hidden", model: "gpt-hidden", displayName: "H", description: "", hidden: true, isDefault: false },
      ],
      nextCursor: null,
    };
    const makeManager = (configRead: () => Promise<unknown>) =>
      new CodexAppServerManager({
        codexHome: makeTempDir("codex-model-default-fallback"),
        connect: async () => {
          const connection = new FakeConnection();
          connection.request = async (method) => {
            if (method === "config/read") return configRead();
            if (method === "model/list") return page;
            return { thread: { id: "thread" } };
          };
          return connection;
        },
        launch: () => {},
      });
    const flags = async (configRead: () => Promise<unknown>) =>
      (await makeManager(configRead).listModels()).map((model) => `${model.id}:${model.isDefault}`);

    await expect(flags(async () => ({ config: { model: "gpt-unknown" } })))
      .resolves.toEqual(["gpt-a:true", "gpt-b:false"]);
    await expect(flags(async () => ({ config: { model: "gpt-hidden" } })))
      .resolves.toEqual(["gpt-a:true", "gpt-b:false"]);
    await expect(flags(async () => ({ config: {} })))
      .resolves.toEqual(["gpt-a:true", "gpt-b:false"]);
    await expect(flags(async () => { throw new Error("config/read unsupported"); }))
      .resolves.toEqual(["gpt-a:true", "gpt-b:false"]);
    await expect(flags(async () => ({ config: { model: "gpt-b" } })))
      .resolves.toEqual(["gpt-a:false", "gpt-b:true"]);
  });

  test("openThread は thread/resume 応答の model を購読時モデルとして返す", async () => {
    const probe = new FakeConnection();
    const connection = new FakeConnection("thread-model");
    connection.request = async (method, params) => {
      connection.requests.push({ method, params });
      if (method === "thread/resume") return { thread: { id: "thread-model", model: "gpt-resumed" } };
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      return { thread: { id: "thread-model" } };
    };
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-thread-model"),
      connect: async () => probe.closed === 0 ? probe : connection,
      launch: () => {},
    });

    const thread = await manager.openThread({ threadId: "thread-model" });
    expect(thread.model).toBe("gpt-resumed");
    thread.close();
  });

  test("openThread の bootstrap 引き継ぎは thread/start 応答の model を購読時モデルとして返す", async () => {
    const connections: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-bootstrap-model"),
      connect: async () => {
        const connection = new FakeConnection("thread-boot");
        connection.request = async (method, params) => {
          connection.requests.push({ method, params });
          if (method === "thread/start") return { thread: { id: "thread-boot", model: "gpt-started" } };
          return { thread: { id: "thread-boot" } };
        };
        connections.push(connection);
        return connection;
      },
      launch: () => {},
    });

    expect(await manager.startThread({ cwd: "/tmp/boot", model: "gpt-started" })).toBe("thread-boot");
    const thread = await manager.openThread({ threadId: "thread-boot" });
    expect(thread.model).toBe("gpt-started");
    // bootstrap 接続は resume しない（作成元購読をそのまま live 接続にする）。readiness probe の
    // 接続は要求を持たないので、要求を発行した接続だけを見る。
    expect(connections.flatMap((connection) => connection.requests.map((request) => request.method)))
      .toEqual(["thread/start"]);
    thread.close();
  });

  test("thread/settings/update で後続turnのモデルを変更する", async () => {
    const connection = new FakeConnection("thread-1");
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-model-set"),
      connect: async () => connection,
      launch: () => {},
    });

    await manager.setThreadModel("thread-1", "gpt-6-astra");

    expect(connection.initialized).toBe(2);
    expect(connection.requests).toContainEqual({
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-6-astra" },
    });
    expect(connection.closed).toBe(2);
  });
});
