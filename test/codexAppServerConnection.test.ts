import { createServer } from "node:http";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { CodexAppServerManager, type CodexAppServerThread } from "../src/codex/codexAppServer.js";
import { makeTempDir } from "./helpers.js";

test("閉じ始めた接続と切断済み接続への RPC は timeout を待たず切断として返す", async () => {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  const socketPath = path.join(makeTempDir("codex-closed-connection"), "control.sock");
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id?: number; method: string };
      if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const manager = new CodexAppServerManager({ socketPath, cliVersion: async () => null });
  const connection = await manager.connectIfRunning(1_000);
  try {
    expect(connection).not.toBeNull();
    const disconnected = new Promise<void>((resolve) => connection!.onDisconnect!(() => resolve()));
    connection!.close();
    await expect(connection!.request("thread/turns/list", {}, 1_000)).rejects.toThrow("connection closed");
    await disconnected;
    await expect(connection!.request("turn/start", {}, 1_000)).rejects.toThrow("connection closed");
  } finally {
    connection?.close();
    for (const socket of webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("制御接続の復旧後も本文送信は通常の5秒待ち、2秒を超える応答を受け取れる", async () => {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  const socketPath = path.join(makeTempDir("codex-recovered-request-budget"), "control.sock");
  let responseTimer: NodeJS.Timeout | undefined;
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id?: number; method: string };
      const reply = (result: unknown): void => { socket.send(JSON.stringify({ id: request.id, result })); };
      if (request.method === "initialize") reply({});
      if (request.method === "thread/resume") reply({ thread: { id: "thread-recovered", historyMode: "paginated" } });
      if (request.method === "thread/turns/list") reply({ data: [], nextCursor: null });
      if (request.method === "turn/start") {
        responseTimer = setTimeout(() => reply({ turn: { id: "turn-accepted" } }), 2_100);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  let thread: CodexAppServerThread | undefined;
  try {
    const manager = new CodexAppServerManager({ socketPath });
    thread = await manager.openThread({ threadId: "thread-recovered", controlOnly: true });
    await expect(thread.startTurn("一度だけ", "client-once")).resolves.toBe("turn-accepted");
  } finally {
    clearTimeout(responseTimer);
    thread?.close();
    for (const socket of webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
