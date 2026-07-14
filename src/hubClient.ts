// hubClient.ts
// tailii (TS host) — engine から Session Hub へ接続する再接続可能な link。

import * as net from "node:net";
import { ensureHubDaemon } from "./hubDaemon.js";
import { decodeHubServerLine, encodeHubMessage, type HubClientMessage, type HubServerMessage } from "./hubProtocol.js";
import { resolveHubSocketPath } from "./socketPath.js";
import type { SessionHub } from "./sessionHub.js";

export interface HubReconnectInfo {
  bootId: string;
  disconnectedAtMs: number | null;
  processingSessions?: string[];
}

export interface HubLink {
  onMessage: ((message: HubServerMessage) => void) | null;
  /** hello 完了時に購読を再送する。切断時刻は Hub 世代変更時の差分 backfill 境界。 */
  onReconnect: ((info: HubReconnectInfo) => void) | null;
  send(message: HubClientMessage): void;
  close(): void;
}

export function connectHubSocket(options: {
  socketPath?: string;
  ensureDaemon?: () => void;
  /** TCP 接続後に有効な hello ack が来ない候補を破棄して再接続する猶予。 */
  helloTimeoutMs?: number;
} = {}): HubLink {
  const socketPath = options.socketPath ?? resolveHubSocketPath();
  let socket: net.Socket | null = null;
  let closed = false;
  let retryMs = 250;
  let disconnectedAtMs: number | null = null;
  let reconnectHandler: HubLink["onReconnect"] = null;
  let pendingReconnect: HubReconnectInfo | null = null;
  const helloCompletedSockets = new WeakSet<net.Socket>();
  const queued: HubClientMessage[] = [];
  const isReplayableState = (message: HubClientMessage): boolean =>
    message.type === "session_processing" || message.type === "runtime_claim_release" ||
    message.type === "session_retire";
  const enqueueOfflineState = (message: HubClientMessage): void => {
    // id 相関 RPC は呼び出し側 timeout / durable Outbox が再試行を所有する。切断queueへ
    // 残すと遅延実行されるため、再接続後にも意味がある状態通知と確定killだけを合流する。
    if (!isReplayableState(message)) return;
    const existing = queued.findIndex((candidate) =>
      candidate.type === message.type && "session" in candidate && "session" in message &&
      candidate.session === message.session,
    );
    if (existing >= 0) queued.splice(existing, 1);
    queued.push(message);
    // hook嵐や長期停止でも常駐engineのメモリを無制限に増やさない。
    while (queued.length > 128) {
      // 同名セッションへの旧queue混入を防ぐ確定killを、通常のprocessing更新より優先する。
      const removable = queued.findIndex((candidate) => candidate.type !== "session_retire");
      queued.splice(removable >= 0 ? removable : 0, 1);
    }
  };
  const link: HubLink = {
    onMessage: null,
    get onReconnect() { return reconnectHandler; },
    set onReconnect(handler) {
      reconnectHandler = handler;
      if (handler === null || pendingReconnect === null) return;
      // connectHubSocket は生成直後から接続するため、engine の初期化 await 中に hello が
      // 先着しうる。最新の hello 完了情報を handler 登録まで保持し、一度だけ引き渡す。
      const info = pendingReconnect;
      pendingReconnect = null;
      handler(info);
    },
    send(message) {
      // net.Socket は connect 中でも writable=true になり、接続失敗した候補へ write すると
      // 再接続 queue を経ずに消える。確立済み socket だけを直接配送対象にする。
      if (socket?.writable === true && socket.connecting === false && socket.destroyed === false) {
        if (isReplayableState(message) && !helloCompletedSockets.has(socket)) enqueueOfflineState(message);
        else socket.write(encodeHubMessage(message));
      }
      else enqueueOfflineState(message);
    },
    close() {
      closed = true;
      pendingReconnect = null;
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
    let helloTimer: ReturnType<typeof setTimeout> | null = null;
    let buffer = Buffer.alloc(0);
    candidate.once("connect", () => {
      connected = true;
      retryMs = 250;
      candidate.write(encodeHubMessage({ type: "hub_hello" }));
      helloTimer = setTimeout(() => {
        if (!helloHandled) candidate.destroy(new Error("Session Hub hello timeout"));
      }, options.helloTimeoutMs ?? 5_000);
      helloTimer.unref();
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
            helloCompletedSockets.add(candidate);
            if (helloTimer !== null) clearTimeout(helloTimer);
            helloTimer = null;
            // handshake が成立した候補へだけオフライン状態を流す。不正 hello で破棄する
            // socket に session_retire 等を消費させない。
            const replay = queued.splice(0);
            // hello snapshot は replay より前の状態。直後に送る processing/retire を反映した
            // effective snapshot を engine へ渡さないと、retire 済み会話を active として
            // 再購読して actor を作り直す。
            let effectiveProcessingSessions = message.processingSessions === undefined
              ? undefined
              : new Set(message.processingSessions);
            if (effectiveProcessingSessions !== undefined) {
              for (const queuedMessage of replay) {
                if (queuedMessage.type === "session_retire") {
                  effectiveProcessingSessions.delete(queuedMessage.session);
                } else if (queuedMessage.type === "session_processing") {
                  if (queuedMessage.state === "active") effectiveProcessingSessions.add(queuedMessage.session);
                  else effectiveProcessingSessions.delete(queuedMessage.session);
                }
              }
            }
            for (const queuedMessage of replay) {
              candidate.write(encodeHubMessage(queuedMessage));
            }
            const boundary = disconnectedAtMs;
            disconnectedAtMs = null;
            const info: HubReconnectInfo = {
              bootId: message.bootId,
              disconnectedAtMs: boundary,
              processingSessions: effectiveProcessingSessions === undefined
                ? undefined
                : [...effectiveProcessingSessions],
            };
            if (reconnectHandler === null) pendingReconnect = info;
            else reconnectHandler(info);
          }
        }
      }
    });
    candidate.once("error", () => {
      (options.ensureDaemon ?? ensureHubDaemon)();
    });
    candidate.once("close", () => {
      if (helloTimer !== null) clearTimeout(helloTimer);
      helloTimer = null;
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
