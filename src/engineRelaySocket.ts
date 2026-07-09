// engineRelaySocket.ts
// tailii (TS host) — hook 等の短命プロセスから engine 長寿命プロセスへ pending を渡す local IPC。

import * as fs from "node:fs";
import * as net from "node:net";
import type { ControlMessage, RemotePendingKind } from "./protocol.js";
import { decodeControlMessage, encodeControlMessage, PROTOCOL_V1 } from "./protocol.js";
import { resolveEngineRelaySocketPath } from "./socketPath.js";

export type RemotePendingMessage =
  | { type: "remote_pending"; v: number; id: string; session: string; kind: RemotePendingKind; tool?: string; summary: string }
  | { type: "remote_pending_cleared"; v: number; id: string; session: string; kind: RemotePendingKind };

export interface EngineRelayServer {
  socketPath: string;
  close(): Promise<void>;
}

async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function startEngineRelaySocket(options: {
  socketPath?: string;
  onMessage: (message: RemotePendingMessage) => void;
  log?: (message: string) => void;
}): Promise<EngineRelayServer | null> {
  const socketPath = options.socketPath ?? resolveEngineRelaySocketPath();
  const log = options.log ?? (() => {});

  if (await isSocketAlive(socketPath)) {
    log(`[tailii-host engine] remote relay socket already in use: ${socketPath}\n`);
    return null;
  }
  fs.rmSync(socketPath, { force: true });

  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let idx: number;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, idx).toString("utf8");
        buf = buf.subarray(idx + 1);
        const message = decodeRemotePendingLine(line);
        if (message !== null) options.onMessage(message);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
  });
  server.maxConnections = 16;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  log(`[tailii-host engine] remote relay listening on ${socketPath}\n`);

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.destroy();
        server.close(() => {
          fs.rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

function decodeRemotePendingLine(line: string): RemotePendingMessage | null {
  if (!line.trim()) return null;
  let message: ControlMessage;
  try {
    message = decodeControlMessage(line);
  } catch {
    return null;
  }
  if (message.type === "remote_pending" || message.type === "remote_pending_cleared") {
    return message;
  }
  return null;
}

export async function sendRemotePendingToEngine(
  message: RemotePendingMessage,
  socketPath: string = resolveEngineRelaySocketPath(),
  timeLimitMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeLimitMs;
  while (Date.now() <= deadline) {
    const sent = await new Promise<boolean>((resolve) => {
      const socket = net.connect(socketPath);
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => {
        socket.end(encodeControlMessage({ ...message, v: message.v ?? PROTOCOL_V1 }) + "\n", () => finish(true));
      });
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
    });
    if (sent) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
