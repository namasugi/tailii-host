// apiAgent/approvalBridge.ts
// API 作業の承認（canUseTool）を既存の承認カードへ出す。端末（アプリ）がつながっていなくてもすぐ拒否しない。
//
// API のターンは承認を待っている間は課金されない（SDK の canUseTool には待ちの期限が無い）。そこで端末の
// hook の「つながっていないときの保留」（hook.ts publishPendingAndAwaitReconnect）と同じ形に合流する:
//   1. 会話の serve socket（resolveSocketPath(会話名)）へ approval_request を送り、同じ id の決定を待つ。
//   2. つながらない・待っている間に切れた → remote_pending（一覧の「承認待ち」）を出し、hub の dispatcher へ
//      push を依頼して（在席判定は dispatcher）、つながり直すまで待つ。つながり直したら同じ id で送り直す。
//   3. 期限（既定 60 分）・ターンの中止で拒否。決着したら remote_pending_cleared を出す。
// hook と違い hub の中で動くので、remote_pending は relay socket を通さず hub へ直接渡す。

import * as net from "node:net";
import { decodeControlMessage, encodeControlMessage, PROTOCOL_V1, type Decision, type ToolDiff } from "../protocol.js";
import type { RemotePendingMessage } from "../hub/engineRelaySocket.js";
import { resolveSocketPath } from "../shared/socketPath.js";
import { closeAfterReply, replyDecisionApplied } from "../approval/decisionResult.js";

export interface ApiAgentApprovalRequestLike {
  id: string;
  session: string;
  tool: string;
  summary: string;
  cwd: string;
  diff?: ToolDiff;
  /** ターンが終わった（中断・終了）ら中止する。 */
  signal?: AbortSignal;
}

export interface ApiAgentApprovalDeps {
  socketPathFor?: (session: string) => string;
  /** remote_pending / remote_pending_cleared を一覧へ出す（hub.handleRelayMessage）。 */
  publishPending?: (message: RemotePendingMessage) => void;
  /**
   * 背景 push の依頼（未設定なら送らない）。hub の dispatcher（push v1）へ渡すだけで、送るかどうか（在席判定・
   * 間引き・決着済みの照合）は dispatcher が端末の hook の承認と同じ規則で決める。結果は待たない。
   */
  notifier?: (request: { approvalId: string; tool: string; session: string; summary: string }) => void;
  deadlineMs?: number;
  retryIntervalMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
}

type Outcome = "allow" | "deny" | "disconnected" | "timeout" | "aborted";

function connectOnce(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: net.Socket | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("connect", () => finish(socket));
    socket.once("error", () => finish(null));
  });
}

function sendAndWait(
  socket: net.Socket, request: ApiAgentApprovalRequestLike, deadlineAt: number, now: () => number, onDelivered: () => void,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      closeAfterReply(socket);
      resolve(outcome);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), Math.max(0, deadlineAt - now()));
    if (request.signal?.aborted) { finish("aborted"); return; }
    request.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replaceAll("\r", "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = decodeControlMessage(line);
          if (message.type === "approval_decision" && message.id === request.id) {
            // 決定の反映結果をアプリへ返す（push v1.1 §6。hook と同じ。最善努力）。
            replyDecisionApplied(socket, request.id);
            finish(message.decision);
            return;
          }
        } catch { /* channel_hello 以外の壊れた行も無視する。 */ }
      }
    });
    socket.once("error", () => finish("disconnected"));
    socket.once("close", () => finish("disconnected"));
    try {
      socket.write(encodeControlMessage({
        type: "approval_request", v: PROTOCOL_V1, id: request.id, tool: request.tool, summary: request.summary, cwd: request.cwd,
        ...(request.diff !== undefined ? { diff: request.diff } : {}),
      }) + "\n");
      onDelivered();
    } catch {
      finish("disconnected");
    }
  });
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function requestApiAgentApproval(request: ApiAgentApprovalRequestLike, deps: ApiAgentApprovalDeps = {}): Promise<Decision> {
  const now = deps.now ?? Date.now;
  const deadlineAt = now() + (deps.deadlineMs ?? 60 * 60_000);
  const socketPath = (deps.socketPathFor ?? resolveSocketPath)(request.session);
  let published = false;
  /** 承認チャネルへ approval_request を書けたか（アプリへ直接届けた承認）。 */
  let delivered = false;
  // 承認の待ちが終わるすべての出口（許可・拒否・中止・期限・エラー）で、アプリへ知らせた承認（承認チャネルへ要求を
  // 書いた・一覧へ remote_pending を出した）なら必ず remote_pending_cleared を出す（下の finally の 1 か所。hook と同じ。
  // iPhone は通知から答えて反映を確認できなかった承認のカードをこれで片付ける。受け手は id で照合するので重ねても害は無い）。
  try {
    return await waitForApiAgentDecision();
  } finally {
    if (published || delivered) {
      try {
        deps.publishPending?.({ type: "remote_pending_cleared", v: PROTOCOL_V1, id: request.id, session: request.session, kind: "approval" });
      } catch { /* 片付けの失敗は承認の結果を変えない。 */ }
    }
  }

  async function waitForApiAgentDecision(): Promise<Decision> {
  while (true) {
    if (request.signal?.aborted) return "deny";
    if (now() >= deadlineAt) return "deny";
    const socket = await connectOnce(socketPath, deps.connectTimeoutMs ?? 2_000);
    if (socket !== null) {
      const outcome = await sendAndWait(socket, request, deadlineAt, now, () => { delivered = true; });
      if (outcome === "allow" || outcome === "deny") return outcome;
      if (outcome !== "disconnected") return "deny";
    }
    if (!published) {
      published = true;
      deps.publishPending?.({
        type: "remote_pending", v: PROTOCOL_V1, id: request.id, session: request.session, kind: "approval",
        tool: request.tool, summary: request.summary,
      });
      try {
        deps.notifier?.({ approvalId: request.id, tool: request.tool, session: request.session, summary: request.summary });
      } catch { /* push の失敗は承認の待機を止めない。 */ }
    }
    await abortableSleep(deps.retryIntervalMs ?? 1_000, request.signal);
  }
  }
}
