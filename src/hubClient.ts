// hubClient.ts
// tailii (TS host) — engine から Session Hub へ接続する再接続可能な link。

import * as net from "node:net";
import { ensureHubDaemon } from "./hubDaemon.js";
import { decodeHubServerLine, encodeHubMessage, type HubClientMessage, type HubServerMessage } from "./hubProtocol.js";
import { resolveHubSocketPath } from "./socketPath.js";
import type { SessionHub } from "./sessionHub.js";

export interface HubLink {
  onMessage: ((message: HubServerMessage) => void) | null;
  /** hello 完了時に購読を再送する。切断時刻は Hub 世代変更時の差分 backfill 境界。 */
  onReconnect: ((info: { bootId: string; disconnectedAtMs: number | null }) => void) | null;
  send(message: HubClientMessage): void;
  close(): void;
}

export function connectHubSocket(options: {
  socketPath?: string;
  ensureDaemon?: () => void;
} = {}): HubLink {
  const socketPath = options.socketPath ?? resolveHubSocketPath();
  let socket: net.Socket | null = null;
  let closed = false;
  let retryMs = 250;
  let disconnectedAtMs: number | null = null;
  const queued: HubClientMessage[] = [];
  const link: HubLink = {
    onMessage: null,
    onReconnect: null,
    send(message) {
      if (socket?.writable === true) socket.write(encodeHubMessage(message));
      // chat_send は RPC timeout 後に engine が fail-open 注入するため、再接続 queue へ
      // 残すと hub 復旧後に遅延配送され二重注入になる。全文 pull も timeout 後の応答は
      // 使われず、表示中ポーリングで再要求されるため stale な要求を溜めない。
      else if (message.type !== "conversation_subscribe" && message.type !== "hub_hello" &&
        message.type !== "chat_send" &&
        message.type !== "conversation_subagent_transcript_request") queued.push(message);
    },
    close() {
      closed = true;
      socket?.destroy();
      socket = null;
    },
  };

  const connect = (): void => {
    if (closed) return;
    const candidate = net.connect(socketPath);
    socket = candidate;
    let connected = false;
    let helloHandled = false;
    let buffer = Buffer.alloc(0);
    candidate.once("connect", () => {
      connected = true;
      retryMs = 250;
      candidate.write(encodeHubMessage({ type: "hub_hello" }));
      for (const message of queued.splice(0)) candidate.write(encodeHubMessage(message));
    });
    candidate.on("data", (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const message = decodeHubServerLine(buffer.subarray(0, newline).toString("utf8"));
        buffer = buffer.subarray(newline + 1);
        if (message !== null) {
          link.onMessage?.(message);
          if (message.type === "hub_hello_ack" && !helloHandled) {
            helloHandled = true;
            const boundary = disconnectedAtMs;
            disconnectedAtMs = null;
            link.onReconnect?.({ bootId: message.bootId, disconnectedAtMs: boundary });
          }
        }
      }
    });
    candidate.once("error", () => {
      (options.ensureDaemon ?? ensureHubDaemon)();
    });
    candidate.once("close", () => {
      if (socket === candidate) socket = null;
      if (closed) return;
      if (connected && disconnectedAtMs === null) disconnectedAtMs = Date.now();
      const delay = retryMs;
      retryMs = Math.min(5_000, retryMs * 2);
      setTimeout(connect, delay).unref();
    });
  };
  connect();
  return link;
}

/** socket を使わず同じ SessionHub コアへ結ぶテスト用 link。 */
export function connectInProcessHub(hub: SessionHub): HubLink {
  const client = {};
  const link: HubLink = {
    onMessage: null,
    onReconnect: null,
    send(message) { hub.handleClientMessage(client, JSON.stringify(message)); },
    close() { hub.unregisterClient(client); },
  };
  hub.registerClient(client, (line) => {
    const message = decodeHubServerLine(line);
    if (message !== null) link.onMessage?.(message);
  });
  return link;
}
