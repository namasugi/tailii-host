// hubProtocol.ts
// tailii (TS host) — Hub と engine の間だけで使う内部 NDJSON プロトコル。

import type { EngineRelayMessage, SessionProcessingMessage } from "./engineRelaySocket.js";
import { decodeControlMessage, type ControlMessage, type QuestionAnswer, type QuestionPromptQuestion } from "./protocol.js";

export type HubClientMessage =
  | { type: "hub_hello" }
  | { type: "conversation_subscribe"; session: string; afterSeq?: number; newerThanMs?: number; preview?: boolean }
  | { type: "conversation_unsubscribe"; session: string }
  | { type: "hub_state_request"; id: string; session: string }
  | { type: "presence_request"; id: string; session: string }
  | { type: "question_answer_submit"; id: string; session: string; questionId: string; answers: QuestionAnswer[] }
  | { type: "input_claim"; id: string; session: string; clientMessageId: string }
  | {
      type: "codex_turn_submit";
      id: string;
      session: string;
      text: string;
      clientUserMessageId: string;
      effort: string | null;
      sandbox: "read-only" | "workspace-write" | "danger-full-access" | null;
      threadId: string;
      cwd: string;
    }
  | { type: "codex_turn_interrupt"; id: string; session: string }
  | { type: "chat_send"; id: string; session: string; clientMessageId: string; text: string }
  | { type: "runtime_claim"; id: string; session: string }
  | { type: "runtime_claim_release"; session: string }
  | SessionProcessingMessage;

export type HubServerMessage =
  | { type: "hub_hello_ack"; version: string | null; bootId: string }
  | {
      type: "hub_state_response";
      id: string;
      session: string;
      pendingQuestion: { id: string; questions: QuestionPromptQuestion[] } | null;
      processing: boolean;
    }
  | { type: "presence_response"; id: string; session: string; subscriberCount: number }
  | { type: "conversation_event"; session: string; serverSeq: number; payload: ControlMessage }
  | { type: "conversation_pane_preview"; session: string; payload: ControlMessage }
  | { type: "conversation_mode"; session: string; payload: ControlMessage }
  | { type: "question_answer_result"; id: string; status: "accepted" | "already_resolved" | "unknown" }
  | { type: "input_claim_result"; id: string; status: "granted" | "duplicate" }
  | { type: "codex_turn_result"; id: string; status: "started" | "duplicate" | "failed"; error?: string }
  | { type: "chat_send_result"; id: string; status: "accepted" | "duplicate" | "failed"; error?: string }
  | { type: "runtime_claim_result"; id: string; status: "granted" | "held" }
  | EngineRelayMessage;

export function encodeHubMessage(message: HubClientMessage | HubServerMessage): string {
  return JSON.stringify(message) + "\n";
}

/** 不正・未知の行を接続エラーにせず捨てる。 */
export function decodeHubClientLine(line: string): HubClientMessage | null {
  const record = parseRecord(line);
  if (record === null) return null;
  if (record["type"] === "hub_hello") return { type: "hub_hello" };
  if (record["type"] === "conversation_subscribe") {
    const session = record["session"];
    if (typeof session !== "string" || session.length === 0) return null;
    const afterSeq = optionalNonnegativeNumber(record["afterSeq"]);
    const newerThanMs = optionalNonnegativeNumber(record["newerThanMs"]);
    if (afterSeq === null || newerThanMs === null ||
      (record["preview"] !== undefined && typeof record["preview"] !== "boolean")) return null;
    return { type: "conversation_subscribe", session,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(newerThanMs !== undefined ? { newerThanMs } : {}),
      ...(typeof record["preview"] === "boolean" ? { preview: record["preview"] } : {}) };
  }
  if (record["type"] === "conversation_unsubscribe") {
    const session = record["session"];
    return typeof session === "string" && session.length > 0 ? { type: "conversation_unsubscribe", session } : null;
  }
  if (record["type"] === "hub_state_request") {
    const id = record["id"];
    const session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "hub_state_request", id, session }
      : null;
  }
  if (record["type"] === "presence_request") {
    const id = record["id"];
    const session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "presence_request", id, session }
      : null;
  }
  if (record["type"] === "question_answer_submit") {
    const id = record["id"], session = record["session"], questionId = record["questionId"], answers = record["answers"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof questionId === "string" && questionId.length > 0 && Array.isArray(answers)
      ? { type: "question_answer_submit", id, session, questionId, answers: answers as QuestionAnswer[] } : null;
  }
  if (record["type"] === "input_claim") {
    const id = record["id"], session = record["session"], clientMessageId = record["clientMessageId"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof clientMessageId === "string" && clientMessageId.length > 0
      ? { type: "input_claim", id, session, clientMessageId } : null;
  }
  if (record["type"] === "codex_turn_submit") {
    const id = record["id"], session = record["session"], text = record["text"];
    const clientUserMessageId = record["clientUserMessageId"], effort = record["effort"];
    const sandbox = record["sandbox"], threadId = record["threadId"], cwd = record["cwd"];
    const validSandbox = sandbox === null || sandbox === "read-only" ||
      sandbox === "workspace-write" || sandbox === "danger-full-access";
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof text === "string" && typeof clientUserMessageId === "string" && clientUserMessageId.length > 0 &&
      (effort === null || typeof effort === "string") && validSandbox &&
      typeof threadId === "string" && threadId.length > 0 && typeof cwd === "string" && cwd.length > 0
      ? { type: "codex_turn_submit", id, session, text, clientUserMessageId,
          effort: effort as string | null,
          sandbox: sandbox as "read-only" | "workspace-write" | "danger-full-access" | null,
          threadId, cwd }
      : null;
  }
  if (record["type"] === "codex_turn_interrupt") {
    const id = record["id"], session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "codex_turn_interrupt", id, session }
      : null;
  }
  if (record["type"] === "chat_send") {
    const id = record["id"], session = record["session"], clientMessageId = record["clientMessageId"];
    const text = record["text"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof clientMessageId === "string" && clientMessageId.length > 0 && typeof text === "string" && text.length > 0
      ? { type: "chat_send", id, session, clientMessageId, text }
      : null;
  }
  if (record["type"] === "runtime_claim") {
    const id = record["id"], session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "runtime_claim", id, session } : null;
  }
  if (record["type"] === "runtime_claim_release") {
    const session = record["session"];
    return typeof session === "string" && session.length > 0 ? { type: "runtime_claim_release", session } : null;
  }
  return decodeProcessing(record);
}

export function decodeHubServerLine(line: string): HubServerMessage | null {
  const record = parseRecord(line);
  if (record === null) return null;
  if (record["type"] === "hub_hello_ack") {
    const version = record["version"];
    const bootId = record["bootId"];
    return (version === null || typeof version === "string") && typeof bootId === "string" && bootId.length > 0
      ? { type: "hub_hello_ack", version, bootId } : null;
  }
  if (record["type"] === "hub_state_response") {
    const id = record["id"];
    const session = record["session"];
    const pending = record["pendingQuestion"];
    if (typeof id !== "string" || typeof session !== "string" || typeof record["processing"] !== "boolean") return null;
    if (pending !== null && !isPendingQuestion(pending)) return null;
    return { type: "hub_state_response", id, session, pendingQuestion: pending, processing: record["processing"] };
  }
  if (record["type"] === "presence_response") {
    const id = record["id"];
    const session = record["session"];
    const subscriberCount = record["subscriberCount"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof subscriberCount === "number" && Number.isInteger(subscriberCount) && subscriberCount >= 0
      ? { type: "presence_response", id, session, subscriberCount }
      : null;
  }
  if (record["type"] === "question_answer_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "accepted" || status === "already_resolved" || status === "unknown")
      ? { type: "question_answer_result", id, status } : null;
  }
  if (record["type"] === "input_claim_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "granted" || status === "duplicate")
      ? { type: "input_claim_result", id, status } : null;
  }
  if (record["type"] === "codex_turn_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" || (status !== "started" && status !== "duplicate" && status !== "failed") ||
      (error !== undefined && typeof error !== "string")) return null;
    return { type: "codex_turn_result", id, status, ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "chat_send_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" || (status !== "accepted" && status !== "duplicate" && status !== "failed") ||
      (error !== undefined && typeof error !== "string")) return null;
    return { type: "chat_send_result", id, status, ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "runtime_claim_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "granted" || status === "held")
      ? { type: "runtime_claim_result", id, status } : null;
  }
  if (record["type"] === "conversation_event" || record["type"] === "conversation_pane_preview" ||
    record["type"] === "conversation_mode") {
    const session = record["session"];
    if (typeof session !== "string" || session.length === 0) return null;
    let payload: ControlMessage;
    try { payload = decodeControlMessage(JSON.stringify(record["payload"])); } catch { return null; }
    if (record["type"] === "conversation_pane_preview") {
      return payload.type === "pane_preview" ? { type: record["type"], session, payload } : null;
    }
    if (record["type"] === "conversation_mode") {
      return payload.type === "mode_set_response" ? { type: record["type"], session, payload } : null;
    }
    const serverSeq = record["serverSeq"];
    return typeof serverSeq === "number" && Number.isInteger(serverSeq) && serverSeq >= 0
      ? { type: record["type"], session, serverSeq, payload } : null;
  }
  return decodeRelay(record);
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function decodeProcessing(record: Record<string, unknown>): SessionProcessingMessage | null {
  const session = record["session"];
  const state = record["state"];
  return record["type"] === "session_processing" && typeof session === "string" && session.length > 0 &&
    (state === "active" || state === "done")
    ? { type: "session_processing", session, state }
    : null;
}

function decodeRelay(record: Record<string, unknown>): EngineRelayMessage | null {
  const processing = decodeProcessing(record);
  if (processing !== null) return processing;
  const type = record["type"];
  const session = record["session"];
  const id = record["id"];
  if (typeof session !== "string" || !session || typeof id !== "string" || !id) return null;
  if (type === "question_event") {
    const event = record["event"];
    if (event === "dismiss") return { type, session, id, event };
    if (event === "prompt" && Array.isArray(record["questions"]) && record["questions"].length > 0) {
      return { type, session, id, event, questions: record["questions"] as QuestionPromptQuestion[] };
    }
    return null;
  }
  const kind = record["kind"];
  if (kind !== "question" && kind !== "approval") return null;
  if (type === "remote_pending_cleared") return { type, v: numberOrOne(record["v"]), id, session, kind };
  if (type === "remote_pending" && typeof record["summary"] === "string") {
    return { type, v: numberOrOne(record["v"]), id, session, kind,
      ...(typeof record["tool"] === "string" ? { tool: record["tool"] } : {}), summary: record["summary"] };
  }
  return null;
}

function isPendingQuestion(value: unknown): value is { id: string; questions: QuestionPromptQuestion[] } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["id"] === "string" && Array.isArray(record["questions"]);
}

function numberOrOne(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function optionalNonnegativeNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
