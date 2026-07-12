// engineRelaySocket.ts
// tailii (TS host) — hook 等の短命プロセスから engine 長寿命プロセスへ pending を渡す local IPC。

import * as fs from "node:fs";
import * as net from "node:net";
import type { ControlMessage, QuestionPromptQuestion, RemotePendingKind } from "./protocol.js";
import { decodeControlMessage, encodeControlMessage, PROTOCOL_V1 } from "./protocol.js";
import { resolveEngineRelaySocketPath } from "./socketPath.js";

export type RemotePendingMessage =
  | { type: "remote_pending"; v: number; id: string; session: string; kind: RemotePendingKind; tool?: string; summary: string }
  | { type: "remote_pending_cleared"; v: number; id: string; session: string; kind: RemotePendingKind };

/**
 * hook → engine の「処理中/処理完了」通知（host 内部 IPC 専用。ワイヤープロトコル外なので
 * protocol.ts には載せない。iOS へは転送しない）。
 * - active: UserPromptSubmit / PreToolUse / PostToolUse（ハートビート）
 * - done:   Stop（応答完了）
 */
export type SessionProcessingMessage = {
  type: "session_processing";
  session: string;
  state: "active" | "done";
};

/**
 * hook → engine の AskUserQuestion ライフサイクル通知（host 内部 IPC 専用。ワイヤープロトコル外）。
 * Claude Code は設問が未回答の間 transcript に tool_use 行を書かないため（v2.1.206 実測）、
 * transcript tail では設問をリアルタイム検知できない。PreToolUse hook が唯一の即時ソース。
 * - prompt : PreToolUse(AskUserQuestion) — engine が前面会話なら question_prompt、別会話なら
 *            remote_pending(kind=question) へ変換して iOS に届ける。
 * - dismiss: PostToolUse(AskUserQuestion) — 回答済み（iOS/TUI どちら経由でも）。sheet/バッジを閉じる。
 */
export type QuestionEventMessage = {
  type: "question_event";
  session: string;
  event: "prompt" | "dismiss";
  id: string;
  /** prompt のときのみ。表示仕様は transcript 由来 question_prompt と同一。 */
  questions?: QuestionPromptQuestion[];
};

export type EngineRelayMessage = RemotePendingMessage | SessionProcessingMessage | QuestionEventMessage;

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
  onMessage: (message: EngineRelayMessage) => void;
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
        const message = decodeEngineRelayLine(line);
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

function decodeEngineRelayLine(line: string): EngineRelayMessage | null {
  if (!line.trim()) return null;
  // session_processing / question_event は host 内部 IPC 専用型（共有プロトコル外）なので
  // 先にローカル判定する。
  try {
    const raw = JSON.parse(line) as unknown;
    if (typeof raw === "object" && raw !== null) {
      const record = raw as Record<string, unknown>;
      if (record["type"] === "session_processing") {
        const session = record["session"];
        const state = record["state"];
        if (typeof session === "string" && session.length > 0 && (state === "active" || state === "done")) {
          return { type: "session_processing", session, state };
        }
        return null;
      }
      if (record["type"] === "question_event") {
        return decodeQuestionEvent(record);
      }
    }
  } catch {
    return null;
  }
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

/** question_event を寛容にデコードする（prompt は questions 1 件以上を要求、dismiss は id のみ）。 */
function decodeQuestionEvent(record: Record<string, unknown>): QuestionEventMessage | null {
  const session = record["session"];
  const event = record["event"];
  const id = record["id"];
  if (typeof session !== "string" || session.length === 0) return null;
  if (typeof id !== "string" || id.length === 0) return null;
  if (event !== "prompt" && event !== "dismiss") return null;
  if (event === "dismiss") return { type: "question_event", session, event, id };
  const questions = record["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  return {
    type: "question_event",
    session,
    event,
    id,
    questions: questions as QuestionPromptQuestion[],
  };
}

/** hook から engine relay へ question_event を送る（接続不能は timeLimit 内リトライ後に諦める）。 */
export async function sendQuestionEventToEngine(
  message: QuestionEventMessage,
  socketPath: string = resolveEngineRelaySocketPath(),
  timeLimitMs = 250,
): Promise<void> {
  await sendLineToEngine(JSON.stringify(message), socketPath, timeLimitMs);
}

/** hook から engine relay へ session_processing を送る（接続不能は timeLimit 内リトライ後に諦める）。 */
export async function sendSessionProcessingToEngine(
  message: SessionProcessingMessage,
  socketPath: string = resolveEngineRelaySocketPath(),
  timeLimitMs = 250,
): Promise<void> {
  await sendLineToEngine(JSON.stringify(message), socketPath, timeLimitMs);
}

export async function sendRemotePendingToEngine(
  message: RemotePendingMessage,
  socketPath: string = resolveEngineRelaySocketPath(),
  timeLimitMs = 250,
): Promise<void> {
  await sendLineToEngine(
    encodeControlMessage({ ...message, v: message.v ?? PROTOCOL_V1 }),
    socketPath,
    timeLimitMs,
  );
}

/** 1 行を engine relay socket へ書き込む共通部（timeLimit 内で connect リトライ）。 */
async function sendLineToEngine(line: string, socketPath: string, timeLimitMs: number): Promise<void> {
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
        socket.end(line + "\n", () => finish(true));
      });
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
    });
    if (sent) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
