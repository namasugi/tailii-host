// commands/chat/chatCommand.ts
// `tailii-host chat <list|new|send|status>`（tailii-chat-cli）。AI エージェント（Bot）が SSH で叩く前提の、対話なしで
// 完結するコマンド。`--json` で JSON 1 個と終了コードを返す。人が端末で打つときは `new` が会話の画面を開く。
// 会話の起動・送信は engine を子プロセスで起動してアプリと同じ要求を送る（engineClient.ts）。状態は直接読む（chatState.ts）。

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ControlMessage } from "../../protocol.js";
import { SessionMetadataStore } from "../../sessions/sessionMetadataStore.js";
import {
  defaultHerdrPath,
  herdrSessionOfMeta,
  parseHerdrPaneList,
} from "../../backend/herdr.js";
import { defaultChatEventLogPath, isChatEventType, readChatEvents } from "../../hub/chatEventLog.js";
import { AGENT_GUIDE } from "./agentGuide.js";
import { ChatError, EXIT } from "./chatErrors.js";
import { approvalViews, questionView, sessionNamesForConversation, type PendingQuestion } from "./chatWaiting.js";
import {
  captureWatchBaseline, changeWatch, isWatchMode, isWatchRemoveReason, listWatches, pollWatches, recordWatchBotAnswer, registerWatch,
  validateWatchId, watchNote, type WatchMode, type WatchObservationDeps, type WatchOptions,
} from "./chatWatch.js";
import {
  defaultModelContext,
  resolveClaudeDefaultModel,
  resolveCodexDefaultModel,
  type DefaultModelContext,
} from "./defaultModel.js";
import {
  defaultApprovalsBase,
  findPendingApproval,
  listPendingApprovals,
  takeApprovalResult,
  writeApprovalDecision,
  type PendingApprovalRecord,
} from "../../approval/approvalMailbox.js";
import type { QuestionAnswer, QuestionPromptQuestion } from "../../protocol.js";
import { connectEngine, EngineTimeoutError, type EngineConnection } from "./engineClient.js";
import {
  ChatReadError,
  READ_LIMITS,
  findConversationRequests,
  parseCursor,
  formatCursor,
  readChatDeliveries,
  readClaudeElements,
  readCodexElements,
  readHubDeliveredIds,
  readHubSendLog,
  resolveSources,
  searchElements,
  sliceElements,
  type ChatElement,
  type OutputMessage,
  type SearchHit,
} from "./chatRead.js";
import {
  acquireRequestLock,
  clientMessageIdFor,
  conversationState,
  findCodexRollout,
  findLatestCodexTurnRecord,
  findModelCommandResult,
  findTranscript,
  folderAllowed,
  isBotStartedConversation,
  isPermissionMode,
  lastClaudeModel,
  lastCodexModel,
  loadBotConfig,
  readCodexRollout,
  readCodexRolloutLines,
  readModelCache,
  readReply,
  readRequest,
  readTranscriptLines,
  requestDigest,
  writeModelCache,
  writeRequest,
  type BotConfig,
  type CodexTurnOptions,
  type ConversationState,
  type PermissionMode,
  type RequestRecord,
  type TranscriptLine,
} from "./chatState.js";

export { EXIT };

/** 差し替え可能な外部（テスト用）。 */
export interface ChatDeps extends WatchObservationDeps {
  connect: () => Promise<EngineConnection>;
  readStdin: () => string | null | Promise<string | null>;
  isTty: boolean;
  config: () => BotConfig;
  store: () => SessionMetadataStore;
  write: (text: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 会話の画面を開く（人向け。戻ったら終わり）。 */
  attach: (session: string) => number;
  readRequest?: typeof readRequest;
  writeRequest?: typeof writeRequest;
  state?: (conversationId: string) => ConversationState;
  transcript?: (conversationId: string, cwdHint?: string) => { file: string; cwd: string | null } | null;
  /** 長い指示文を書き出す置き場（既定 `~/.tailii/uploads/cli`）。 */
  longTextDir?: string;
  /** 送信の配送状態を hub に照会する（テスト用。既定は engine 経由の chat_receipt_query）。 */
  receipt?: (session: string, clientMessageId: string) => Promise<string>;
  /** 依頼 ID ごとの排他（テスト用。既定は `~/.tailii/bot/requests/<digest>.lock`）。取れなければ null。 */
  lockRequest?: (requestId: string) => (() => void) | null;
  /** 承認の受け渡し口のベース（テスト用。既定 `~/.tailii/approvals`）。第 2 段。 */
  approvalsBase?: string;
  /** `tailii-host chat new` で始めた会話か（テスト用。既定は依頼の記録から）。 */
  botStarted?: (conversationId: string) => boolean;
  /** 人に確かめる（端末で y/N。テスト用）。 */
  confirm?: (question: string) => boolean;
  /** Codex の会話の rollout を探す（テスト用。既定は `~/.codex/sessions`）。 */
  codexRollout?: (threadId: string) => string | null;
  /** 依頼の記録の置き場（テスト用。既定 `~/.tailii/bot/requests`）。 */
  requestsDir?: string;
  /** モデル一覧の控えの置き場（テスト用。既定 `~/.tailii/bot`）。 */
  modelCacheDir?: string;
  /** 既定のモデルを読む設定の置き場（テスト用）。 */
  defaultModelContext?: DefaultModelContext;
  /** engine の送信ログ（テスト用。既定 `~/.tailii/chat-send.log`）。read / search の出所の判定に使う。 */
  sendLog?: string;
  /** hub の配送済みの台帳（テスト用。既定 `~/.tailii/hub/chat-receipts.json`）。read / search の出所の判定に使う。 */
  chatReceipts?: string;
  /** hub が届けた発話の記録（テスト用。既定 `~/.tailii/hub/chat-deliveries.ndjson`）。read / search の出所の判定に使う。 */
  chatDeliveries?: string;
  chatEvents?: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const WATCH_VALUE_FLAGS = new Set(["--mode", "--ttl", "--read-cursor", "--token", "--watch", "--watch-ttl"]);
const EVENT_VALUE_FLAGS = new Set(["--conversation", "--type"]);
const VALUE_FLAGS = new Set([
  "--cwd", "--request-id", "--title", "--permission-mode", "--after", "--wait",
  "--choice", "--other", "--reason", "--backend", "--herdr-session", "--agent", "--model", "--effort",
  "--last", "--before", "--limit", "--max-text", "--query", "--context",
  ...WATCH_VALUE_FLAGS, ...EVENT_VALUE_FLAGS,
]);
const BOOL_FLAGS = new Set(["--json", "--live", "--no-attach", "--interrupt", "--yes", "--refresh", "--all", "--note"]);

function parseArgs(args: string[], verb: string): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const sendWatch = (verb === "new" || verb === "send") && (arg === "--watch" || arg === "--watch-ttl");
    if (VALUE_FLAGS.has(arg) && (!WATCH_VALUE_FLAGS.has(arg) || verb === "watch" || sendWatch) &&
      (!EVENT_VALUE_FLAGS.has(arg) || verb === "events")) {
      const value = args[i + 1];
      if (value === undefined || ((verb === "watch" || verb === "events" || sendWatch) && value.startsWith("--"))) {
        throw new ChatError(EXIT.usage, "missing_value", `${arg} に値がありません`);
      }
      flags.set(arg, value);
      i++;
    } else if (BOOL_FLAGS.has(arg) && ((arg !== "--all" && arg !== "--note") || verb === "watch")) {
      flags.set(arg, true);
    } else if (arg.startsWith("--")) {
      throw new ChatError(EXIT.usage, "unknown_option", `知らないオプションです: ${arg}`, "tailii-host agent-guide を読んでください");
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const flagString = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,128}$/;

function requireConversationId(args: ParsedArgs): string {
  const id = args.positional[0];
  if (id === undefined || !CONVERSATION_ID.test(id)) {
    throw new ChatError(EXIT.usage, "missing_conversation", "会話 ID を指定してください", "tailii-host chat list --json で確かめる");
  }
  if (args.positional.length > 1) throw new ChatError(EXIT.usage, "extra_argument", `余分な引数があります: ${args.positional[1]}`);
  return id;
}

function requestIdOf(args: ParsedArgs, bot: boolean): string {
  const id = flagString(args, "--request-id");
  if (id !== undefined) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new ChatError(EXIT.usage, "bad_request_id", "依頼 ID は英数字と _ . : - で 128 文字まで");
    return id;
  }
  if (bot) throw new ChatError(EXIT.usage, "missing_request_id", "--request-id が要ります（同じ ID の打ち直しで二重にならない）");
  return randomUUID();
}

/**
 * 依頼 ID から会話名・送信 ID を決める（打ち直しても同じ）。会話名はアプリの `s-<8 桁>` と重ならない `s-cli<16 桁>`
 * （`s-` で始めるのは reaper などが Tailii の会話として扱う条件。レビュー指摘 A9）。
 */
const sessionNameFor = (requestId: string): string => `s-cli${requestDigest(requestId).slice(0, 16)}`;

function newId(): string {
  return `cli-${randomUUID()}`;
}

function isType<T extends ControlMessage["type"]>(type: T, id: string) {
  return (message: ControlMessage): message is Extract<ControlMessage, { type: T }> =>
    message.type === type && "id" in message && message.id === id;
}

function engineFailure(reply: ControlMessage, what: string): ChatError {
  if (reply.type === "error" && reply.code === "chat_send_failed") {
    return unknownDelivery(reply.message);
  }
  if (reply.type === "error") {
    const retry = /launch_failed|tmux_error|claim|起動中/.test(`${reply.code} ${reply.message}`);
    return new ChatError(retry ? EXIT.retryLater : EXIT.internal, reply.code, reply.message,
      retry ? "少し待って同じ依頼 ID で打ち直す" : undefined);
  }
  return new ChatError(EXIT.internal, "unexpected_reply", `${what}: 想定外の応答（${reply.type}）`);
}

/**
 * 届いたかどうか分からない送信（hub への問い合わせの時間切れ・結果不明）。新しい依頼 ID で送り直すと、保留中の送信
 * （設問の表示中など）と二重になるので、同じ依頼 ID で打ち直させる（保留中の送信に合流するか、届いていれば duplicate。
 * 2 周目レビュー 1）。
 */
function unknownDelivery(detail?: string): ChatError {
  return new ChatError(EXIT.timeout, "delivery_unknown",
    `送信が届いたか確かめられませんでした${detail ? `（${detail}）` : ""}`,
    "同じ依頼 ID で打ち直す（保留中の送信に合流する）。chat status <会話ID> --after <依頼ID> の delivery で配送状態を確かめられる。設問の表示中は利用者が答えるまで保留される");
}

/**
 * hub が「打ち込みの結果が不明。明示の再送が要る」とした送信（2 周目レビュー 5）。Bot は進められないので人に回す。
 * hub はこの送信を送信順の先頭に残し、解けるまで後ろの送信（アプリの発話も）を流さない。解けるのは会話の終了だけ
 * （CLI の送信はアプリの送信待ちの一覧に出ないので、アプリからは再送も取り消しもできない。3 周目レビュー 2）。
 */
const NEEDS_HUMAN_HINT =
  "人に伝える: 利用者がアプリでこの会話を終了してから開き直す（止まっていた送信は消える）。届いていたかは会話の画面で確かめ、" +
  "届いていなければ新しい依頼 ID で送り直す。それまでこの会話には送らない";

function needsHuman(detail?: string): ChatError {
  return new ChatError(EXIT.policy, "needs_human",
    `この会話は送信が届いたか分からない状態で止まっています${detail ? `（${detail}）` : ""}`, NEEDS_HUMAN_HINT);
}

async function withEngine<T>(deps: ChatDeps, body: (engine: EngineConnection) => Promise<T>): Promise<T> {
  let engine: EngineConnection;
  try {
    engine = await deps.connect();
  } catch (error) {
    throw new ChatError(EXIT.retryLater, "engine_unavailable", `Tailii の host を起動できませんでした: ${String(error)}`,
      "少し待って打ち直す。続くなら tailii-host doctor");
  }
  try {
    return await body(engine);
  } catch (error) {
    if (error instanceof EngineTimeoutError) {
      throw new ChatError(EXIT.timeout, "timeout", error.message, "同じ依頼 ID で打ち直すか、chat status で確かめる");
    }
    throw error;
  } finally {
    await engine.close();
  }
}

/** 起動（session_start）。採用された会話名と会話 id を返す。 */
async function startSession(
  engine: EngineConnection,
  request: Record<string, unknown>,
): Promise<{ session: string; conversationId: string | null }> {
  const id = newId();
  const reply = await engine.request({ type: "session_start", v: 2, id, deferSubscribe: true, ...request },
    (message) => (message.type === "session_list_response" || message.type === "session_peer_conflict") &&
      "id" in message && message.id === id, 90_000);
  if (reply.type === "session_peer_conflict") {
    throw new ChatError(EXIT.elsewhere, "running_elsewhere",
      `この会話は Tailii の外（${reply.holder}${reply.holderName ? `「${reply.holderName}」` : ""}）で動いています。送っていません`,
      reply.canTakeOver ? "人に伝える（利用者がアプリで開き直せる。bot.json で許されていれば chat take-over）" : "人に伝える",
      { where: reply.holder, busy: reply.busy, canTakeOver: reply.canTakeOver });
  }
  if (reply.type !== "session_list_response") throw engineFailure(reply, "起動");
  const adopted = reply.adoptedName ?? (typeof request["name"] === "string" ? request["name"] : undefined);
  // 採用した名前の行が無ければ、別の会話の ID を返さずにエラーにする（レビュー指摘 A11）。
  const info = reply.sessions.find((entry) => entry.name === adopted);
  if (adopted === undefined || info === undefined) throw new ChatError(EXIT.internal, "no_session", "起動した会話を確かめられませんでした");
  return { session: adopted, conversationId: info.providerSessionId ?? info.claudeSessionId ?? null };
}

/**
 * hub に送信の配送状態を照会する（delivered / pending / blocked / uncertain / deleted / unknown）。`blocked` は保留中のうち、
 * 送信順の先頭に残った「届いたか分からない」別の送信の後ろで止まっているもの（放っておいても流れない。4 周目レビュー 中2）。
 */
async function receiptOn(engine: EngineConnection, session: string, clientMessageId: string): Promise<string> {
  const id = newId();
  const reply = await engine.request({ type: "chat_receipt_query", v: 2, id, session, clientMessageId },
    isType("chat_receipt_query_result", id), 15_000);
  // engine の error 応答（hub への照会の失敗）は「記録に無い（unknown）」ではなく照会できなかったこと（6 周目 低2）。
  if (reply.type !== "chat_receipt_query_result") throw engineFailure(reply, "配送状態の照会");
  return reply.status === "pending" && reply.blocked === true ? "blocked" : reply.status;
}

/** 送信（chat_send）。hub が送信の確定まで行い、同じ clientMessageId の二重送信は弾く。 */
async function sendText(engine: EngineConnection, session: string, clientMessageId: string, text: string): Promise<"accepted" | "duplicate"> {
  const id = newId();
  let reply: ControlMessage;
  try {
    reply = await engine.request({ type: "chat_send", v: 2, id, session, clientMessageId, text },
      isType("chat_send_result", id), 100_000);
  } catch (error) {
    // 時間切れ: 前の「届いたか分からない」送信の後ろで止まっているなら、打ち直しても流れないので人に回す（4 周目 中2）。
    if (error instanceof EngineTimeoutError && await receiptOn(engine, session, clientMessageId).catch(() => "unknown") === "blocked") {
      throw needsHuman("この会話の前の送信");
    }
    throw error;
  }
  if (reply.type !== "chat_send_result") throw engineFailure(reply, "送信");
  if (reply.status !== "failed") return reply.status;
  return classifySendFailure(engine, session, clientMessageId, reply.error);
}

/**
 * Codex への送信（codex_turn_start。hub が turn/start の確定まで行い、同じ clientUserMessageId の二重送信は弾く）。
 * 送った id は rollout の UserMessage の client_id に残る（返答の照合に使う）。失敗の分け方は Claude と同じ。
 */
async function sendCodexTurn(
  engine: EngineConnection,
  session: string,
  clientUserMessageId: string,
  text: string,
  turn: CodexTurnOptions | undefined,
  effort: string | undefined,
): Promise<"accepted" | "duplicate"> {
  const id = newId();
  let reply: ControlMessage;
  try {
    reply = await engine.request({ type: "codex_turn_start", v: 2, id, session, text, clientUserMessageId, ...(turn ?? {}),
      ...(effort !== undefined ? { effort } : {}) },
      isType("codex_turn_start_result", id), 100_000);
  } catch (error) {
    if (error instanceof EngineTimeoutError && await receiptOn(engine, session, clientUserMessageId).catch(() => "unknown") === "blocked") {
      throw needsHuman("この会話の前の送信");
    }
    throw error;
  }
  if (reply.type !== "codex_turn_start_result") throw engineFailure(reply, "送信");
  if (reply.status === "started") return "accepted";
  if (reply.status === "duplicate") return "duplicate";
  return classifySendFailure(engine, session, clientUserMessageId, reply.error);
}

/** hub の送信の失敗を、受領の照会で分ける（届いていた → duplicate。それ以外は投げる）。 */
async function classifySendFailure(
  engine: EngineConnection,
  session: string,
  clientMessageId: string,
  error: string | undefined,
): Promise<"duplicate"> {
  const reply = { error };
  if (reply.error !== undefined && /explicit retry is required/i.test(reply.error)) throw needsHuman();
  if (reply.error === "pending_message_deleted") throw deletedByUser();
  // 失敗の中身は hub の受領の照会で分ける（打つ前に断った失敗は記録から外れ unknown になる。そこへ「同じ ID で
  // 打ち直す（7）」と案内すると、同じ理由で断られ続ける。3 周目レビュー 5）。
  let receipt: string;
  try {
    receipt = await receiptOn(engine, session, clientMessageId);
  } catch {
    receipt = "unknown_query";
  }
  switch (receipt) {
    case "delivered": return "duplicate";
    case "uncertain":
    case "blocked":
      throw needsHuman(reply.error);
    case "deleted": throw deletedByUser();
    case "unknown":
      if (reply.error !== undefined && /before (?:delivery|turn start) completed/.test(reply.error)) {
        // 届ける前に会話が終わった（利用者の終了・片付け）。打ち直しは会話を続きから起動して送る（4 周目 中1）。
        // 打ち込みの途中で終わった場合は Claude が受け付けていることもある。打ち直しは会話の記録を見てから送る。
        throw new ChatError(EXIT.retryLater, "conversation_ended", `届ける途中で会話が終わりました（届いていない可能性が高い）: ${reply.error}`,
          "同じ依頼 ID で打ち直す（届いていれば送り直さず、届いていなければ会話を続きから起動して送る）");
      }
      if (reply.error !== undefined && /no rollout found for thread id/.test(reply.error)) {
        // Codex の新しい thread は最初の発話まで App Server のメモリにしか無く、作った接続（`new` の engine）が終わると消える。
        // 最初の送信が失敗した後の打ち直しでは、もう始められない（同じ ID で打ち直しても同じ）。会話はまだ空なので作り直す。
        throw new ChatError(EXIT.notFound, "conversation_ended_before_start", "最初の指示が届く前に Codex の会話が失われました",
          "新しい依頼 ID で chat new をやり直す");
      }
      // 記録に無い = 1 キーも打たずに断った（/login 中・ダイアログの表示中・入力欄の残りを消せない など）。届いていない。
      throw new ChatError(EXIT.retryLater, "not_delivered",
        `送信できませんでした（届いていません）${reply.error ? `: ${reply.error}` : ""}`,
        "少し待って同じ依頼 ID で打ち直す。何度も同じ理由で断られるなら人に伝える（会話の画面で入力を止めているものを片付けてもらう）");
    default:
      // 保留中（pending）・照会できない: 届いたか分からない。
      throw unknownDelivery(reply.error);
  }
}

/** 利用者が取り消した送信。打ち直しても同じ結果になる。 */
function deletedByUser(): ChatError {
  return new ChatError(EXIT.policy, "message_deleted", "この依頼の送信は利用者が取り消しました",
    "同じ依頼 ID では送れない。送り直すなら人に確かめてから新しい依頼 ID で");
}

interface ConversationRow {
  conversationId: string;
  agent: string;
  title: string;
  cwd: string;
  updatedAtMs?: number;
  liveSession?: string;
  elsewhere: boolean;
  /** API 作業の会話（端末が無く、`/model` が発話として API へ渡ってしまう）。 */
  apiRoute: boolean;
}

async function listConversations(engine: EngineConnection): Promise<ConversationRow[]> {
  return (await listConversationsResolved(engine)).rows;
}

/** 一覧と、各行の `liveSession` の不在が「止まっている」と確定しているか（`liveSessionsResolved`）。 */
async function listConversationsResolved(engine: EngineConnection): Promise<{ rows: ConversationRow[]; resolved: boolean }> {
  const id = newId();
  const reply = await engine.request({ type: "claude_session_list_request", v: 2, id },
    isType("claude_session_list_response", id), 60_000);
  if (reply.type !== "claude_session_list_response") throw engineFailure(reply, "一覧");
  return { resolved: reply.liveSessionsResolved === true, rows: reply.claudeSessions.map((row) => ({
    conversationId: row.sessionId,
    agent: row.agent ?? "claude",
    title: row.title,
    cwd: row.cwd,
    ...(row.updatedAt !== undefined ? { updatedAtMs: row.updatedAt * 1000 } : {}),
    ...(row.liveSessionName !== undefined ? { liveSession: row.liveSessionName } : {}),
    elsewhere: row.liveSessionName === undefined && row.peerSessionName !== undefined,
    apiRoute: row.executionRoute === "api",
  })) };
}

/**
 * Tailii の会話名がいま動いているか（`session_alive_query`）。分からないとき（答えられない端末の置き場がある）は
 * 動いている扱い（止まったと決めつけて新しい依頼 ID を案内しない）。`session_list_request` は止まった会話の記録まで
 * 全部たどる（千件を超える）ので使わない。
 */
async function sessionAlive(engine: EngineConnection, session: string): Promise<boolean> {
  const id = newId();
  const reply = await engine.request({ type: "session_alive_query", v: 2, id, name: session },
    isType("session_alive_query_result", id), 30_000);
  if (reply.type !== "session_alive_query_result") throw engineFailure(reply, "会話の確認");
  return reply.alive !== false;
}

/** 依頼の発話が会話の記録に残っているか（届いていたか）。 */
function utteranceRecorded(deps: ChatDeps, record: RequestRecord): boolean {
  if (record.agent === "codex") {
    const rollout = record.conversationId === "" ? null : codexRolloutOf(deps, record.conversationId);
    if (rollout === null) return false;
    return readReply(readCodexRolloutLines(rollout), {
      sentAtMs: record.sentAtMs, text: record.text, clientId: clientMessageIdFor(record.requestId),
    }).found;
  }
  const transcriptOf = deps.transcript ?? ((id: string, cwdHint?: string) =>
    findTranscript(id, { store: deps.store(), ...(cwdHint !== undefined ? { cwdHint } : {}) }));
  const transcript = record.conversationId === "" ? null : transcriptOf(record.conversationId, record.cwd);
  if (transcript === null) return false;
  // `/model` は発話ではなくコマンドの行として残る（発話の読み取りでは除かれる）。
  if (record.kind === "set-model") {
    return record.model !== undefined && findModelCommandResult(transcript.file, record.sentAtMs, record.model) !== null;
  }
  return readReply(readTranscriptLines(transcript.file), { sentAtMs: record.sentAtMs, text: record.text }).found;
}

async function readPrompt(deps: ChatDeps, required: boolean): Promise<string | null> {
  const text = await deps.readStdin();
  const trimmed = text?.replace(/\s+$/, "") ?? "";
  if (trimmed.length === 0) {
    if (required) throw new ChatError(EXIT.usage, "empty_prompt", "指示文が空です（標準入力で渡す）");
    return null;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------------------------------------------

async function cmdList(args: ParsedArgs, deps: ChatDeps): Promise<Record<string, unknown>> {
  const rows = await withEngine(deps, listConversations);
  const filtered = args.flags.has("--live") ? rows.filter((row) => row.liveSession !== undefined || row.elsewhere) : rows;
  return {
    conversations: filtered.map((row) => ({
      conversationId: row.conversationId,
      agent: row.agent,
      title: row.title,
      cwd: row.cwd,
      ...(row.updatedAtMs !== undefined ? { updatedAtMs: row.updatedAtMs } : {}),
      where: row.liveSession !== undefined ? "tailii" : row.elsewhere ? "elsewhere" : "none",
    })),
  };
}

/** 長い指示文の閾値（アプリの長文の貼り付けと同じ: 8 KiB 超か 40 行超, large-text-paste）。 */
const LONG_TEXT_BYTES = 8 * 1024;
const LONG_TEXT_LINES = 40;

/**
 * 端末へ打ち込む本文にする。長い指示文は端末の入力バッファあふれで途中が欠けるので、ファイルに書き出して参照を送る
 * （アプリは長文の貼り付けを添付にしている。レビュー指摘 A8）。依頼 ID ごとに同じファイル名（打ち直しても同じ本文）。
 */
function deliverableText(prompt: string, requestId: string, deps: ChatDeps): string {
  const lines = prompt.split(/\r\n|\r|\n/).length;
  if (Buffer.byteLength(prompt, "utf8") <= LONG_TEXT_BYTES && lines <= LONG_TEXT_LINES) return prompt;
  const dir = deps.longTextDir ?? path.join(os.homedir(), ".tailii", "uploads", "cli");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `prompt-${requestDigest(requestId).slice(0, 16)}.txt`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  return `指示文が長いのでファイルに保存しました。まずこのファイルを読み、書かれている指示に従ってください: ${file}`;
}

const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** 同じ依頼 ID の使い回し（種類・フォルダ・会話・本文が違う）を見分ける（レビュー指摘 A5）。 */
function assertSameRequest(record: RequestRecord, expect: { kind: RequestRecord["kind"]; cwd?: string; conversationId?: string;
  textHash: string | null; model?: string | null; effort?: string | null; mode?: string }): void {
  const differs = record.kind !== expect.kind ||
    (expect.mode !== undefined && record.mode !== expect.mode) ||
    (expect.model !== undefined && (record.model ?? null) !== expect.model) ||
    (expect.effort !== undefined && (record.effort ?? null) !== expect.effort) ||
    (expect.cwd !== undefined && record.cwd !== expect.cwd) ||
    (expect.conversationId !== undefined && record.conversationId !== "" && record.conversationId !== expect.conversationId) ||
    (expect.textHash !== null && record.textHash !== undefined && record.textHash !== expect.textHash);
  if (differs) {
    throw new ChatError(EXIT.usage, "request_id_reused", "この依頼 ID は別の依頼で使われています（依頼ごとに新しい ID を使う）");
  }
}

function withConversation(error: unknown, record: RequestRecord): unknown {
  const extra = { requestId: record.requestId, conversationId: record.conversationId, session: record.session };
  // モデルの変更の依頼には返答が無いので、`status --after` を案内しない。
  const hintFor = (failure: ChatError): string | undefined =>
    record.kind === "set-model" && failure.code === "delivery_unknown" ? "同じ依頼 ID で打ち直す" : failure.hint;
  if (error instanceof ChatError) return new ChatError(error.exitCode, error.code, error.message, hintFor(error), { ...error.extra, ...extra });
  if (error instanceof EngineTimeoutError) {
    const unknown = unknownDelivery(error.message);
    return new ChatError(unknown.exitCode, unknown.code, unknown.message, hintFor(unknown), extra);
  }
  return error;
}

/** 同じ依頼 ID のコマンドを同時に 1 本だけにする（3 周目レビュー 3）。 */
async function withRequestLock<T>(deps: ChatDeps, requestId: string, body: () => Promise<T>): Promise<T> {
  const release = (deps.lockRequest ?? ((id: string) => acquireRequestLock(id)))(requestId);
  if (release === null) {
    throw new ChatError(EXIT.retryLater, "request_in_progress", "同じ依頼 ID のコマンドが実行中です",
      "終わるのを待ってから同じ依頼 ID で打ち直す", { requestId });
  }
  try {
    return await body();
  } finally {
    release();
  }
}

/**
 * 送信が未確定（started）の依頼を打ち直す前に、記録の会話名がまだ動いているかを確かめる（4 周目レビュー 中1）。
 * 1 回目の送信を待つ間に会話が終わる（利用者の終了・片付け）と、hub は記録の会話名で actor を作り直して死んだ pane へ
 * 打とうとし、届いたか分からない送信として残る。終わっていれば、届いていたかを hub の受領の照会と会話の記録の両方で
 * 確かめる（会話の片付けは「届いたか分からない」送信も打ち込み中の送信も消すので、照会だけでは届いた送信を unknown と
 * 読み、二重に送る。5 周目レビュー 1）。届いていないと確かめられたときだけ、会話を続きから起動してその会話名へ送る。
 */
async function reviveIfEnded(
  engine: EngineConnection,
  deps: ChatDeps,
  record: RequestRecord,
): Promise<{ record: RequestRecord; delivered: boolean }> {
  // 先に受領の照会を引く: hub は actor の記録の次に片付けた会話の配送済みの台帳も見るので、同じ会話名で起動し直された後の
  // 打ち直しも届いた扱いにできる。打ち直しの大半（pending・delivered）は一覧を引かずに済む（6 周目レビュー 低1・低4）。
  let receipt: string;
  try {
    receipt = await receiptOn(engine, record.session, clientMessageIdFor(record.requestId));
  } catch {
    // 照会できない: 届いたか分からない（届いていないと決めつけて送り直さない。5 周目レビュー 2a）。
    throw unknownDelivery("配送状態を照会できませんでした");
  }
  switch (receipt) {
    case "delivered": return { record, delivered: true };
    // hub がまだ送信を持っている: 同じ会話名へ送って保留中の送信に合流する（5 周目 2b）。
    case "pending": return { record, delivered: false };
    case "uncertain":
    case "blocked":
      // 人に回した印を残す（6 周目 低3）。
      (deps.writeRequest ?? writeRequest)({ ...record, state: "started", needsHuman: true });
      throw needsHuman();
    case "deleted": throw deletedByUser();
    default: break;
  }
  // hub の記録に無い。会話の片付けは届いたか分からない送信も打ち込み中の送信も消すので、会話の記録に発話があれば届いた扱い。
  if (utteranceRecorded(deps, record)) return { record, delivered: true };
  const { rows, resolved } = await listConversationsResolved(engine);
  const row = rows.find((entry) => entry.conversationId === record.conversationId);
  if (row !== undefined && row.liveSession === record.session) return { record, delivered: false };
  // 一覧で確定できないとき（行が無い = 最初の発話の前で記録が無い・生存の突き合わせが無い）は会話名の生存を直接見る。
  if ((row === undefined || !resolved) && await sessionAlive(engine, record.session)) return { record, delivered: false };
  if (row === undefined) {
    // 最初の指示が届く前に会話が終わった（記録がまだ無い）。同じ依頼 ID では続けられない（5 周目レビュー 3）。
    throw new ChatError(EXIT.notFound, "conversation_ended_before_start", "最初の指示が届く前に会話が終わりました",
      "新しい依頼 ID で chat new をやり直す");
  }
  let session = row.liveSession;
  if (session === undefined) {
    if (!folderAllowed(row.cwd, deps.config().allowedRoots)) {
      throw new ChatError(EXIT.policy, "folder_not_allowed", `この会話の作業フォルダは許可されていません: ${row.cwd}`);
    }
    const agent = record.agent ?? "claude";
    session = (await startSession(engine, {
      cwd: row.cwd, name: sessionNameFor(`${record.requestId}:${record.conversationId}`), resumeSessionId: record.conversationId,
      agentType: agent, ...(agent === "claude" ? { peerCheck: true } : {}),
    })).session;
  }
  const next: RequestRecord = { ...record, session, state: "started" };
  (deps.writeRequest ?? writeRequest)(next);
  return { record: next, delivered: false };
}

/**
 * 送信が未確定の依頼の打ち直し。人に回した依頼は、会話の記録に発話があれば届いた扱い、無ければ人に回したまま
 * （利用者が会話を終了すると hub の照会は unknown になるが、届いていた送信を送り直さない。5 周目レビュー 1）。
 * それ以外は記録の会話がまだ動いているかを確かめてから送る。
 */
async function retryStarted(
  engine: EngineConnection,
  deps: ChatDeps,
  record: RequestRecord,
): Promise<{ record: RequestRecord; delivered: boolean }> {
  if (record.needsHuman === true) {
    if (utteranceRecorded(deps, record)) return { record, delivered: true };
    throw withConversation(new ChatError(EXIT.policy, "needs_human", "この依頼は届いたか分からないまま人に回しています",
      "会話の画面で届いたかを確かめてもらう。届いていなければ新しい依頼 ID で送り直す（この依頼 ID では送らない）"), record);
  }
  try {
    return await reviveIfEnded(engine, deps, record);
  } catch (error) {
    throw withConversation(error, record);
  }
}

/** 記録を `started` で書いてから送り、受け付けられたら `sent` にする。打ち直しでは時刻を変えない。 */
async function sendRecorded(
  engine: EngineConnection,
  deps: ChatDeps,
  record: RequestRecord,
): Promise<"accepted" | "duplicate"> {
  const write = deps.writeRequest ?? writeRequest;
  write({ ...record, state: "started" });
  let status: "accepted" | "duplicate";
  try {
    status = record.agent === "codex"
      ? await sendCodexTurn(engine, record.session, clientMessageIdFor(record.requestId), record.text, record.codexTurn, record.effort)
      : await sendText(engine, record.session, clientMessageIdFor(record.requestId), record.text);
  } catch (error) {
    // 人に回した依頼は記録に印を残す（打ち直しで届いたか分からない送信を送り直さない。5 周目レビュー 1）。
    if (error instanceof ChatError && error.code === "needs_human") write({ ...record, state: "started", needsHuman: true });
    // 送信の段階の失敗にも会話 ID と会話名を載せる（status --after で確かめられるように。2 周目レビュー 2）。
    throw withConversation(error, record);
  }
  write({ ...record, state: "sent" });
  return status;
}

function watchModeOf(value: string | undefined, flag: string): WatchMode {
  if (!isWatchMode(value)) throw new ChatError(EXIT.usage, "bad_watch_mode", `${flag} は continue か notify を指定してください`);
  return value;
}

function sendWatchOptions(args: ParsedArgs): WatchOptions | undefined {
  const raw = flagString(args, "--watch");
  if (raw === undefined) {
    if (args.flags.has("--watch-ttl")) throw new ChatError(EXIT.usage, "watch_required", "--watch-ttl には --watch が要ります");
    return undefined;
  }
  return { mode: watchModeOf(raw, "--watch"), ttlMinutes: intFlag(args, "--watch-ttl", 1440, 1, 10080) };
}

function recordWatchBaseline(deps: ChatDeps, record: RequestRecord, watch?: WatchOptions): RequestRecord {
  if (watch === undefined || record.watchBaseline !== undefined) return record;
  return {
    ...record,
    watchBaseline: captureWatchBaseline(deps, record.conversationId, record.agent ?? "claude", record.kind === "new", record.cwd),
  };
}

async function watchAfterSend(deps: ChatDeps, record: RequestRecord, prompt: string | null, duplicate: boolean, watch?: WatchOptions) {
  if (watch === undefined) return {};
  try {
    const { mode, expiresAtMs } = await registerWatch(deps, record.conversationId, {
      ...watch, lastRequestId: record.requestId,
      ...(prompt !== null ? { note: `依頼の冒頭: ${watchNote(prompt, 200)}` } : {}),
    }, {
      agent: record.agent ?? "claude", baseline: record.watchBaseline, duplicate, cwd: record.cwd, empty: record.kind === "new",
    });
    return { watch: { mode, expiresAtMs } };
  } catch (error) {
    const failure = error instanceof ChatError ? error
      : new ChatError(EXIT.internal, "watch_registration_failed", error instanceof Error ? error.message : String(error));
    throw new ChatError(failure.exitCode, failure.code, `依頼は受け付けられましたが見張りを登録できませんでした。 ${failure.message}`,
      "同じ依頼 ID と --watch を付けて打ち直す", {
        conversationId: record.conversationId, requestId: record.requestId, session: record.session,
      });
  }
}

async function cmdNew(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown> & { attach?: string }> {
  if (args.positional.length > 0) {
    throw new ChatError(EXIT.usage, "unexpected_argument", "new は会話 ID を受け取りません（続きを送るなら chat send）");
  }
  const watch = sendWatchOptions(args);
  const cwd = flagString(args, "--cwd");
  if (cwd === undefined) throw new ChatError(EXIT.usage, "missing_cwd", "--cwd が要ります");
  const config = deps.config();
  if (!folderAllowed(cwd, config.allowedRoots)) {
    throw new ChatError(EXIT.usage, "folder_not_allowed", `作業フォルダが無いか、許可されていません: ${cwd}`,
      `許可されているのは ${config.allowedRoots.join(", ")} の中（~/.tailii/bot.json の allowedRoots）。フォルダは自動で作らない`);
  }
  const requestedMode = flagString(args, "--permission-mode");
  if (requestedMode !== undefined && !isPermissionMode(requestedMode)) {
    throw new ChatError(EXIT.usage, "bad_permission_mode", `許可モードは default / acceptEdits / plan / auto: ${requestedMode}`);
  }
  if (bot && requestedMode === "auto" && !config.allowAuto) {
    throw new ChatError(EXIT.policy, "auto_not_allowed", "auto（何でも許可）は Bot に許されていません",
      "利用者が ~/.tailii/bot.json の allowAuto を true にしたときだけ使える");
  }
  const permissionMode = requestedMode ?? (bot ? config.permissionMode : undefined);
  const agentRaw = flagString(args, "--agent") ?? "claude";
  if (agentRaw !== "claude" && agentRaw !== "codex") {
    throw new ChatError(EXIT.usage, "bad_agent", `--agent は claude か codex: ${agentRaw}`);
  }
  const agent: "claude" | "codex" = agentRaw;
  const placement = placementOf(args);
  const attach = !bot && !args.flags.has("--no-attach");
  const prompt = await readPrompt(deps, !attach);
  const model = flagString(args, "--model");
  const effort = flagString(args, "--effort");
  // Codex の工数は最初の turn に載せる。指示文が無いと載せる turn が無い。
  if (agent === "codex" && effort !== undefined && prompt === null) {
    throw new ChatError(EXIT.usage, "effort_needs_prompt", "Codex の --effort は最初の指示文と一緒に指定します");
  }
  const requestId = requestIdOf(args, bot);
  const resolvedCwd = fs.realpathSync(cwd);
  const validated = await validateModelChoice(deps, bot, agent, model, effort, resolvedCwd);
  const textHash = prompt === null ? null : hashText(prompt);
  return withRequestLock(deps, requestId, () =>
    newLocked({ deps, requestId, resolvedCwd, textHash, prompt, attach, permissionMode, title: flagString(args, "--title"),
      placement, agent, model, effort, modelValidated: validated, watch }));
}

/**
 * 起動先の明示（`--backend herdr|tmux` / `--herdr-session <名前>`）。省略はアプリの設定。`--herdr-session` だけなら herdr。
 */
function placementOf(args: ParsedArgs): { backend?: "tmux" | "herdr"; herdrSession?: string } {
  const backend = flagString(args, "--backend");
  const herdrSession = flagString(args, "--herdr-session");
  if (backend !== undefined && backend !== "tmux" && backend !== "herdr") {
    throw new ChatError(EXIT.usage, "bad_backend", `--backend は herdr か tmux: ${backend}`);
  }
  if (herdrSession !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(herdrSession)) {
    throw new ChatError(EXIT.usage, "bad_herdr_session", `herdr セッション名は英数字と _ . - で 64 文字まで: ${herdrSession}`);
  }
  if (herdrSession !== undefined && backend === "tmux") {
    throw new ChatError(EXIT.usage, "conflicting_placement", "--herdr-session は --backend tmux と一緒に使えません");
  }
  return {
    ...(backend !== undefined ? { backend } : herdrSession !== undefined ? { backend: "herdr" as const } : {}),
    ...(herdrSession !== undefined ? { herdrSession } : {}),
  };
}

async function newLocked(input: {
  deps: ChatDeps; requestId: string; resolvedCwd: string; textHash: string | null; prompt: string | null; attach: boolean;
  permissionMode: string | undefined; title: string | undefined;
  placement: { backend?: "tmux" | "herdr"; herdrSession?: string };
  agent: "claude" | "codex";
  model: string | undefined; effort: string | undefined; modelValidated: boolean;
  watch?: WatchOptions;
}): Promise<Record<string, unknown> & { attach?: string }> {
  const { deps, requestId, resolvedCwd, textHash, prompt, attach, permissionMode, title, placement, agent, model, effort, modelValidated, watch } = input;
  const choice = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
  const codexTurn = agent === "codex" ? codexTurnOptions(permissionMode as PermissionMode | undefined) : undefined;
  const previous = (deps.readRequest ?? readRequest)(requestId);
  if (previous !== null) assertSameRequest(previous, { kind: "new", cwd: resolvedCwd, textHash, model: model ?? null, effort: effort ?? null });
  if (previous !== null && (previous.agent ?? "claude") !== agent) {
    throw new ChatError(EXIT.usage, "request_id_reused", "この依頼 ID は別の依頼で使われています（依頼ごとに新しい ID を使う）");
  }
  // state の無い記録は 31f97bc の旧形式で、送信済み（3 周目レビュー 6）。
  if (previous !== null && (previous.state === undefined || previous.state === "sent")) {
    return { duplicate: true, requestId, conversationId: previous.conversationId, session: previous.session, cwd: previous.cwd,
      ...await watchAfterSend(deps, previous, prompt, true, watch),
      ...(attach ? { attach: previous.session } : {}) };
  }
  const name = sessionNameFor(requestId);
  const writeReq = deps.writeRequest ?? writeRequest;
  const result = await withEngine(deps, async (engine) => {
    // 起動済みの記録があれば起動をやり直さない（同じ会話名で起動し直すと engine が新しい会話 id を採番してメタを
    // 書き換える。レビュー指摘 A1）。起動を頼んだだけ（starting。起動の時間切れの後など）なら、メタに起動済みの会話 id が
    // あればそれを使い、無いときだけ起動し直す（2 周目レビュー 4）。
    const launchedId = (): string | null => {
      const meta = deps.store().get(name);
      return meta?.providerSessionId ?? meta?.claudeSessionId ?? null;
    };
    let started: { session: string; conversationId: string | null };
    if (previous !== null && previous.state === "started") {
      started = { session: previous.session, conversationId: previous.conversationId };
    } else if (previous !== null && previous.state === "starting" && launchedId() !== null) {
      started = { session: name, conversationId: launchedId() };
    } else {
      writeReq({
        requestId, kind: "new", conversationId: "", session: name, cwd: resolvedCwd, sentAtMs: deps.now(), text: "",
        ...(textHash !== null ? { textHash } : {}), state: "starting", ...(agent === "codex" ? { agent } : {}), ...choice,
      });
      try {
        started = await startSession(engine, {
          cwd: resolvedCwd, name, agentType: agent,
          // Codex は許可モードではなく sandbox（起動時）と承認の方針（turn ごと）で決める。
          ...(agent === "claude" && permissionMode !== undefined ? { permissionMode } : {}),
          ...(codexTurn?.sandbox !== undefined ? { codexSandbox: codexTurn.sandbox } : {}),
          // モデル: Claude は起動フラグ、Codex は thread の開始時。工数: Claude は起動フラグ、Codex は最初の turn。
          ...(agent === "claude" && model !== undefined ? { model } : {}),
          ...(agent === "claude" && effort !== undefined ? { effort } : {}),
          ...(agent === "codex" && model !== undefined ? { codexModel: model } : {}),
          ...(title !== undefined ? { title } : {}),
          ...placement,
        });
      } catch (error) {
        if (!(error instanceof EngineTimeoutError)) throw error;
        // 起動の時間切れ: 会話 ID はまだ分からない。同じ依頼 ID の打ち直しは、起動済みなら起動し直さずに続ける。
        throw new ChatError(EXIT.timeout, "start_timeout", error.message,
          "同じ依頼 ID で打ち直す（起動済みなら起動し直さずに続ける。新しい依頼 ID にすると会話がもう 1 つ始まる）",
          { requestId, session: name });
      }
    }
    if (started.conversationId === null) throw new ChatError(EXIT.internal, "no_conversation_id", "会話 ID を確かめられませんでした");
    const record: RequestRecord = previous !== null && previous.state === "started" ? previous : {
      requestId, kind: "new", conversationId: started.conversationId, session: started.session, cwd: resolvedCwd,
      sentAtMs: deps.now(), text: prompt === null ? "" : deliverableText(prompt, requestId, deps),
      ...(textHash !== null ? { textHash } : {}),
      ...(agent === "codex" ? { agent, ...(codexTurn !== undefined ? { codexTurn } : {}) } : {}),
      ...choice,
    };
    // 送信が未確定の記録は、指示文なしで打ち直されても送信済みにしない（記録の本文で打ち直す。6 周目 補足）。
    if (prompt === null && !(previous !== null && previous.state === "started")) {
      const watched = recordWatchBaseline(deps, record, watch);
      writeReq({ ...watched, state: "sent" });
      return { record: watched, duplicate: false };
    }
    let toSend = record;
    if (previous !== null && previous.state === "started") {
      const revived = await retryStarted(engine, deps, record);
      if (revived.delivered) {
        writeReq({ ...record, state: "sent" });
        return { record, duplicate: true };
      }
      toSend = revived.record;
    }
    toSend = recordWatchBaseline(deps, toSend, watch);
    const status = await sendRecorded(engine, deps, toSend);
    return { record: toSend, duplicate: status === "duplicate" };
  });
  return {
    requestId, conversationId: result.record.conversationId, session: result.record.session, cwd: resolvedCwd, agent, ...choice,
    ...await watchAfterSend(deps, result.record, prompt, result.duplicate, watch),
    ...(!modelValidated ? { modelValidated: false } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(attach ? { attach: result.record.session } : {}),
  };
}

async function cmdSend(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  const watch = sendWatchOptions(args);
  if (watch !== undefined) validateWatchId(conversationId);
  if (args.flags.has("--cwd")) throw new ChatError(EXIT.usage, "unexpected_cwd", "send は --cwd を受け取りません（会話のフォルダで続ける）");
  if (args.flags.has("--model") || args.flags.has("--effort")) {
    throw new ChatError(EXIT.usage, "use_set_model", "send は --model / --effort を受け取りません（1 通だけに効かせる仕組みがありません）",
      "会話のモデルを変えるなら chat set-model（以後ずっと効く）");
  }
  const prompt = (await readPrompt(deps, true))!;
  const requestId = requestIdOf(args, bot);
  const textHash = hashText(prompt);
  // Codex の会話だけ、送るたびに許可モードを変えられる（プランから戻すなど）。Claude は起動時のモードのまま。
  const requestedMode = flagString(args, "--permission-mode");
  if (requestedMode !== undefined && !isPermissionMode(requestedMode)) {
    throw new ChatError(EXIT.usage, "bad_permission_mode", `許可モードは default / acceptEdits / plan / auto: ${requestedMode}`);
  }
  if (bot && requestedMode === "auto" && !deps.config().allowAuto) {
    throw new ChatError(EXIT.policy, "auto_not_allowed", "auto（何でも許可）は Bot に許されていません",
      "利用者が ~/.tailii/bot.json の allowAuto を true にしたときだけ使える");
  }
  return withRequestLock(deps, requestId, () => sendLocked({
    deps, requestId, conversationId, textHash, prompt, bot, watch,
    ...(requestedMode !== undefined ? { permissionMode: requestedMode as PermissionMode } : {}),
  }));
}

async function sendLocked(input: {
  deps: ChatDeps; requestId: string; conversationId: string; textHash: string; prompt: string; bot: boolean;
  permissionMode?: PermissionMode;
  watch?: WatchOptions;
}): Promise<Record<string, unknown>> {
  const { deps, requestId, conversationId, textHash, prompt, bot, permissionMode, watch } = input;
  const previous = (deps.readRequest ?? readRequest)(requestId);
  if (previous !== null) assertSameRequest(previous, { kind: "send", conversationId, textHash });
  if (previous !== null && previous.state !== "started" && previous.state !== "starting") {
    return { duplicate: true, requestId, conversationId, session: previous.session,
      ...await watchAfterSend(deps, previous, prompt, true, watch) };
  }
  const config = deps.config();
  const result = await withEngine(deps, async (engine) => {
    let record = previous !== null && previous.state === "started" ? previous : null;
    if (record === null) {
      const rows = await listConversations(engine);
      const row = rows.find((entry) => entry.conversationId === conversationId);
      if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
      if (row.agent !== "claude" && row.agent !== "codex") {
        throw new ChatError(EXIT.policy, "unsupported_agent", `この種類の会話への送信は未対応です: ${row.agent}`);
      }
      const agent: "claude" | "codex" = row.agent;
      // 送る先の会話も、許可された作業フォルダの中だけ（止まっていればそのフォルダで起動するため。レビュー指摘 A7）。
      if (!folderAllowed(row.cwd, config.allowedRoots)) {
        throw new ChatError(EXIT.policy, "folder_not_allowed", `この会話の作業フォルダは許可されていません: ${row.cwd}`,
          "~/.tailii/bot.json の allowedRoots に入っている会話だけ送れる");
      }
      if (agent === "claude" && permissionMode !== undefined) {
        throw new ChatError(EXIT.usage, "unexpected_permission_mode", "Claude の会話の send は --permission-mode を受け取りません（起動時のモードのまま）");
      }
      // Codex の turn の承認の方針と sandbox: 明示の --permission-mode → この会話を始めた new の設定 → Bot なら bot.json
      // の許可モード（人は会話の設定のまま）。new で厳しくした方針が 2 通目から緩まないように（Fable レビュー 中2）。
      const inherited = agent === "codex" && permissionMode === undefined
        ? findLatestCodexTurnRecord(conversationId, deps.requestsDir)?.codexTurn : undefined;
      // 引き継いだ方針が auto（never）でも、Bot に auto が許されていなければ使わない（Fable 確かめ 低4）。
      const inheritedAllowed = inherited !== undefined && !(bot && inherited.approvalPolicy === "never" && !config.allowAuto)
        ? inherited : undefined;
      const codexTurn = agent !== "codex" ? undefined
        : permissionMode !== undefined ? codexTurnOptions(permissionMode)
          : inheritedAllowed ?? (bot ? codexTurnOptions(config.permissionMode) : undefined);
      const live = row.liveSession ?? (await startSession(engine, {
        cwd: row.cwd, name: sessionNameFor(`${requestId}:${conversationId}`), resumeSessionId: conversationId,
        agentType: agent, ...(agent === "claude" ? { peerCheck: true } : {}),
      })).session;
      record = {
        requestId, kind: "send", conversationId, session: live, cwd: row.cwd, sentAtMs: deps.now(),
        text: deliverableText(prompt, requestId, deps), textHash,
        ...(agent === "codex" ? { agent, ...(codexTurn !== undefined ? { codexTurn } : {}) } : {}),
      };
    } else {
      const revived = await retryStarted(engine, deps, record);
      if (revived.delivered) {
        (deps.writeRequest ?? writeRequest)({ ...record, state: "sent" });
        return { record, duplicate: true };
      }
      record = revived.record;
    }
    record = recordWatchBaseline(deps, record, watch);
    const status = await sendRecorded(engine, deps, record);
    return { record, duplicate: status === "duplicate" };
  });
  return { requestId, conversationId, session: result.record.session,
    ...await watchAfterSend(deps, result.record, prompt, result.duplicate, watch) };
}

/** 送信の配送状態（delivered / pending / blocked / uncertain / deleted / unknown）。照会できなければ unknown。 */
async function queryDelivery(deps: ChatDeps, record: RequestRecord): Promise<string> {
  const clientMessageId = clientMessageIdFor(record.requestId);
  if (deps.receipt !== undefined) return deps.receipt(record.session, clientMessageId);
  try {
    return await withEngine(deps, (engine) => receiptOn(engine, record.session, clientMessageId));
  } catch {
    return "unknown";
  }
}

async function cmdStatus(args: ParsedArgs, deps: ChatDeps): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  const afterId = flagString(args, "--after");
  const waitRaw = flagString(args, "--wait");
  const waitSec = waitRaw === undefined ? 0 : Number(waitRaw);
  if (!Number.isFinite(waitSec) || waitSec < 0) throw new ChatError(EXIT.usage, "bad_wait", "--wait は 0 以上の秒数");
  // 送信が未確定（started）の記録も受け付ける（時間切れの後に「届いたか」を確かめる用途。レビュー指摘 A3）。
  const after = afterId !== undefined ? (deps.readRequest ?? readRequest)(afterId) : null;
  if (after !== null && (after.kind === "set-model" || after.kind === "set-mode")) {
    throw new ChatError(EXIT.usage, "request_has_no_reply", "モデルや許可モードの変更の依頼には返答がありません（--after に使えません）");
  }
  if (after !== null && after.state === "starting") {
    throw new ChatError(EXIT.notFound, "request_not_started", "この依頼は会話の起動の途中で終わっています",
      "同じ依頼 ID で chat new を打ち直す（起動済みなら起動し直さずに続ける）");
  }
  if (afterId !== undefined && (after === null || after.conversationId !== conversationId)) {
    throw new ChatError(EXIT.notFound, "request_not_found", "この会話への依頼 ID の記録がありません（送る前に失敗した依頼は記録されない）");
  }
  const agent = after?.agent ?? conversationAgent(deps, conversationId);
  const claudeStateOf = deps.state ?? ((id: string) => conversationState(id));
  const transcriptOf = deps.transcript ?? ((id: string, cwdHint?: string) =>
    findTranscript(id, { store: deps.store(), ...(cwdHint !== undefined ? { cwdHint } : {}) }));
  // Codex は rollout（返答と処理中の判定）。engine は 1 本だけ遅延で開いて使い回す（会話名の生存と設問の問い合わせ。
  // Fable レビュー 低1・低2）。rollout がまだ無ければ（new の直後）ループの中で探し直す（低5）。
  let codexRollout = agent === "codex" ? codexRolloutOf(deps, conversationId) : null;
  let codexEngine: EngineConnection | null | undefined;
  const codexEngineConn = async (): Promise<EngineConnection | null> => {
    if (codexEngine === undefined) {
      try { codexEngine = await deps.connect(); } catch { codexEngine = null; }
    }
    return codexEngine;
  };
  let codexAlive: boolean | undefined;
  const codexIsAlive = async (): Promise<boolean> => {
    if (codexAlive !== undefined) return codexAlive;
    const sessions = conversationSessionNames(deps, conversationId);
    if (sessions.length === 0) return (codexAlive = false);
    const engine = await codexEngineConn();
    if (engine === null) return (codexAlive = true); // 確かめられないときは止まったと決めつけない。
    for (const session of sessions) {
      try {
        if (await sessionAlive(engine, session)) return (codexAlive = true);
      } catch {
        return (codexAlive = true);
      }
    }
    return (codexAlive = false);
  };
  const readNow = async (): Promise<{ state: ConversationState; lines: TranscriptLine[] | null }> => {
    if (agent !== "codex") {
      const transcript = transcriptOf(conversationId, after?.cwd);
      return { state: claudeStateOf(conversationId), lines: transcript === null ? null : readTranscriptLines(transcript.file) };
    }
    if (codexRollout === null) codexRollout = codexRolloutOf(deps, conversationId);
    const snapshot = codexRollout === null ? null : readCodexRollout(codexRollout);
    const state: ConversationState = snapshot?.busy === true ? "busy" : (await codexIsAlive()) ? "idle" : "not_running";
    return { state, lines: snapshot?.lines ?? null };
  };
  // 直近の返答を作ったモデル（設定値ではない。set-model の直後は次の返答まで前のモデルのまま）。
  let currentModel: string | null | undefined;
  const currentModelOf = (): string | null => {
    if (currentModel !== undefined) return currentModel;
    if (agent === "codex") return (currentModel = codexRollout === null ? null : lastCodexModel(codexRollout));
    const transcript = transcriptOf(conversationId, after?.cwd);
    return (currentModel = transcript === null ? null : lastClaudeModel(transcript.file));
  };
  // Codex の設問は登録簿に出ないので、処理中のあいだ hub に聞く（数秒おき）。
  let codexQuestionCheckedAtMs = Number.NEGATIVE_INFINITY;
  const deadline = deps.now() + Math.min(waitSec, 100) * 1000;
  // 送信が未確定（started）の依頼は、届いたかを hub の受領の照会で確かめる（会話の記録だけでは、設問の表示中に保留された
  // 送信を「届いていない」と取り違える。2 周目レビュー 1）。sent は hub が注入の完了を返したもの。
  let delivery: string | undefined;
  if (after !== null) {
    delivery = after.state === "started" ? await queryDelivery(deps, after) : "delivered";
  }
  try {
  for (;;) {
    const now = await readNow();
    let state = now.state;
    const transcriptLines = now.lines;
    if (transcriptLines === null && after === null) {
      throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
    }
    const lines = transcriptLines ?? [];
    const read = readReply(lines, after !== null ? {
      sentAtMs: after.sentAtMs, text: after.text,
      ...(after.agent === "codex" ? { clientId: clientMessageIdFor(after.requestId) } : {}),
    } : undefined);
    if (agent === "codex" && state === "busy" && deps.now() - codexQuestionCheckedAtMs >= 3_000) {
      codexQuestionCheckedAtMs = deps.now();
      const engine = await codexEngineConn();
      if (engine !== null && await hasPendingQuestionOn(engine, deps, conversationId)) state = "waiting";
    }
    // 完了は待機（idle）か止まっている（not_running）で返答があるとき。承認・設問の入力待ち（waiting）と処理中は終わって
    // いない（レビュー指摘 A6・2 周目レビュー 3）。
    const complete = (state === "idle" || state === "not_running") && read.found && read.reply !== null;
    // 承認・設問の答え待ちは待っても進まない（人か Bot が答えるまで）ので、すぐ返して中身を見せる（第 2 段）。
    const approvals = state === "not_running" ? [] : pendingApprovalsOf(deps, conversationId);
    if (complete || deps.now() >= deadline || state === "waiting" || approvals.length > 0) {
      // engine は設問を聞くとき（waiting）だけ開く（Fable 確かめ 低5）。
      const waiting = await waitingDetails(deps, conversationId, state, approvals,
        agent === "codex" && state === "waiting" ? (await codexEngineConn()) ?? undefined : undefined);
      return {
        conversationId, state: waiting.state, complete,
        ...(waiting.detail !== undefined ? { waiting: waiting.detail } : {}),
        ...(agent === "codex" ? { agent } : {}),
        ...(currentModelOf() !== null ? { model: currentModelOf() } : {}),
        ...(afterId !== undefined ? { after: afterId, received: read.found || delivery === "delivered", delivery } : {}),
        // 届いたか分からない送信で、この会話の後ろの送信が止まっている（記録に発話があっても hub は解かない）。
        // Bot には解けない（3 周目レビュー 2）。
        ...(delivery === "uncertain" || delivery === "blocked" || (after?.needsHuman === true && !read.found) ? { needsHuman: true, hint: NEEDS_HUMAN_HINT } : {}),
        reply: read.reply,
      };
    }
    await deps.sleep(1_000);
  }
  } finally {
    if (codexEngine) await codexEngine.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 記録の部分取得: read / search（読み取り専用。会話を起動せず、engine も通さない）

/** 0 以上の整数の指定を読む（範囲の外は、黙って丸めずに使い方の誤りにする）。 */
function intFlag(args: ParsedArgs, name: string, fallback: number, min: number, max: number): number {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ChatError(EXIT.usage, "out_of_range", `${name} は ${min}〜${max} の整数`);
  }
  return value;
}

function chatWaitMs(args: ParsedArgs): number {
  const raw = flagString(args, "--wait");
  if (raw === undefined) return 0;
  const seconds = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds > 100) {
    throw new ChatError(EXIT.usage, "out_of_range", "--wait は 0〜100 の秒数");
  }
  return seconds * 1_000;
}

async function waitForChat<T>(deps: ChatDeps, waitMs: number, read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = deps.now() + waitMs;
  for (;;) {
    const result = await read();
    const remaining = deadline - deps.now();
    if (ready(result) || remaining <= 0) return result;
    await deps.sleep(Math.min(1_000, remaining));
  }
}

async function cmdEvents(args: ParsedArgs, deps: ChatDeps) {
  if (args.positional.length > 0) throw new ChatError(EXIT.usage, "extra_argument", `余分な引数があります: ${args.positional[0]}`);
  for (const flag of args.flags.keys()) {
    if (flag !== "--json" && flag !== "--after" && flag !== "--limit" && flag !== "--wait" && !EVENT_VALUE_FLAGS.has(flag)) {
      throw new ChatError(EXIT.usage, "unsupported_option", `${flag} は chat events では使えません`);
    }
  }
  const rawCursor = flagString(args, "--after");
  const after = rawCursor === undefined ? undefined : withCursorErrors("", () => parseCursor(rawCursor));
  if (after === undefined && args.flags.has("--wait")) {
    throw new ChatError(EXIT.usage, "missing_after", "--wait には --after が要ります");
  }
  const conversationId = flagString(args, "--conversation");
  if (conversationId !== undefined && !CONVERSATION_ID.test(conversationId)) {
    throw new ChatError(EXIT.usage, "bad_conversation_id", "会話 ID の形が違います");
  }
  const types = flagString(args, "--type")?.split(",");
  const unknownType = types?.find((type) => !isChatEventType(type));
  if (unknownType !== undefined) throw new ChatError(EXIT.usage, "unknown_event_type", `知らない種別です: ${unknownType}`);
  const limit = intFlag(args, "--limit", 50, 1, 200);
  const file = deps.chatEvents ?? defaultChatEventLogPath();
  const result = await waitForChat(deps, chatWaitMs(args), () => {
    const sessions = conversationId === undefined ? [] : conversationSessionNames(deps, conversationId);
    return readChatEvents(file, { after, limit, matches: (event) => (
      (types === undefined || types.includes(event.type)) && (conversationId === undefined ||
        (event.type !== "hub_started" && (event.conversationId === conversationId || sessions.includes(event.session))))
    ) });
  }, (result) => result.events.length > 0 || result.stale);
  if (result.stale) {
    throw new ChatError(EXIT.usage, "stale_cursor", "カーソルが今の出来事の記録と合いません", "--after を付けずに取り直す");
  }
  const last = result.events.at(-1);
  const cursor = last === undefined ? rawCursor : formatCursor(last.seq, last.atMs);
  return {
    events: result.events.map(({ v: _v, boot: _boot, ...event }) => event),
    cursors: cursor === undefined ? {} : { after: cursor },
    hasMore: result.hasMore, gap: result.gap || (after !== undefined && result.lastHubStartSeq !== undefined),
  };
}

async function cmdWatch(args: ParsedArgs, deps: ChatDeps): Promise<{ payload: Record<string, unknown>; human: string }> {
  const [verb, ...positional] = args.positional;
  let allowed: string[];
  switch (verb) {
    case "add": allowed = ["--mode", "--ttl", "--request-id", "--read-cursor", "--note"]; break;
    case "list": allowed = ["--all"]; break;
    case "update": allowed = ["--mode", "--ttl", "--note"]; break;
    case "remove": allowed = ["--reason"]; break;
    case "poll": allowed = ["--wait"]; break;
    case "ack": allowed = ["--token", "--read-cursor"]; break;
    default: throw new ChatError(EXIT.usage, "unknown_watch_verb", "watch の動詞は add / list / update / remove / poll / ack です");
  }
  for (const flag of args.flags.keys()) {
    if (flag !== "--json" && !allowed.includes(flag)) {
      throw new ChatError(EXIT.usage, "unsupported_option", `${flag} は watch ${verb} では使えません`);
    }
  }
  if (verb === "list" || verb === "poll") {
    if (positional.length > 0) throw new ChatError(EXIT.usage, "extra_argument", `余分な引数があります: ${positional[0]}`);
    if (verb === "list") {
      const watches = listWatches(deps, args.flags.has("--all"));
      const human = watches.map((watch) =>
        `${watch.conversationId}  ${watch.agent}  ${watch.mode}  未受領 ${watch.pending}` +
        (watch.closed === undefined ? "" : `  終了: ${watch.closed.reason}`) +
        (watch.note === null ? "" : `  ${watch.note.replace(/[\r\n]+/g, " ")}`)).join("\n");
      return { payload: { watches }, human: human || "（見張りがありません）" };
    }
    const payload = await waitForChat(deps, chatWaitMs(args), () => pollWatches(deps), (poll) => poll.wake);
    const lines = payload.items.flatMap((item) => item.reasons.map((reason) => `- ${item.conversationId}  ${reason.kind}`));
    for (const error of payload.errors ?? []) lines.push(`- ${error.conversationId}  エラー: ${error.message}`);
    return { payload, human: lines.join("\n") || "（変化がありません）" };
  }
  const id = requireConversationId({ positional, flags: args.flags });
  validateWatchId(id);
  const cursor = flagString(args, "--read-cursor");
  if (cursor !== undefined) withCursorErrors(id, () => parseCursor(cursor));
  if (verb === "ack") {
    const raw = flagString(args, "--token");
    const token = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(token)) throw new ChatError(EXIT.usage, "bad_token", "--token は poll が返した番号を指定してください");
    const payload = await changeWatch(deps, id, { kind: "ack", token, readCursor: cursor });
    return { payload, human: `受け取りました: ${id}` };
  }
  if (verb === "remove") {
    const reason = flagString(args, "--reason");
    if (!isWatchRemoveReason(reason)) {
      throw new ChatError(EXIT.usage, "bad_watch_reason", "--reason は done / handed_over / boss_stop / other から指定してください");
    }
    const payload = await changeWatch(deps, id, { kind: "remove", reason });
    return { payload, human: `見張りを閉じました: ${id}（${reason}）` };
  }
  const rawMode = flagString(args, "--mode");
  const mode = verb === "add" || rawMode !== undefined ? watchModeOf(rawMode, "--mode") : undefined;
  const ttlMinutes = intFlag(args, "--ttl", 1440, 1, 10080);
  // メモは --note を付けたときだけ標準入力から読む（付けていないのに読むと、標準入力が閉じない呼び方で止まる）。
  let note: string | undefined;
  if (args.flags.has("--note")) {
    const stdin = await deps.readStdin();
    if (stdin === null || stdin.trim().length === 0) {
      throw new ChatError(EXIT.usage, "empty_note", "--note を付けたときは、メモを標準入力で渡してください");
    }
    note = watchNote(stdin.trim(), 2000);
  }
  if (verb === "update") {
    const ttl = args.flags.has("--ttl") ? ttlMinutes : undefined;
    if (mode === undefined && ttl === undefined && note === undefined) {
      throw new ChatError(EXIT.usage, "missing_watch_update", "--mode、--ttl、--note（メモは標準入力）のいずれかを指定してください");
    }
    const payload = await changeWatch(deps, id, { kind: "update", mode, ttlMinutes: ttl, note });
    return { payload, human: `見張りを更新しました: ${id}` };
  }
  const lastRequestId = args.flags.has("--request-id") ? requestIdOf(args, false) : undefined;
  if (lastRequestId !== undefined) {
    const record = deps.readRequest !== undefined
      ? deps.readRequest(lastRequestId) : readRequest(lastRequestId, deps.requestsDir);
    if (record?.conversationId !== id) {
      throw new ChatError(EXIT.notFound, "request_not_found", "この会話への依頼 ID の記録がありません");
    }
  }
  const payload = await registerWatch(deps, id, { mode: mode!, ttlMinutes, note, lastRequestId, readCursor: cursor });
  return { payload, human: `見張りを登録しました: ${id}` };
}

/**
 * 会話の記録を要素の列にして、出所を付ける。`inProgress` はターンの途中（処理中・承認や設問の答え待ち）で、末尾の返答が
 * まだ続くかもしれないこと。Codex の待機中と停止中の区別には engine が要るので、ここでは見ない（詳しい状態は status）。
 */
function loadConversation(deps: ChatDeps, conversationId: string): {
  agent: "claude" | "codex";
  elements: ChatElement[];
  inProgress: boolean;
} {
  const notFound = (): ChatError =>
    new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
  const unreadable = (): ChatError =>
    new ChatError(EXIT.internal, "record_unreadable", "会話の記録を読めませんでした（大きすぎる・壊れている）");
  const agent = conversationAgent(deps, conversationId);
  let elements: ChatElement[];
  let inProgress: boolean;
  if (agent === "codex") {
    const rollout = codexRolloutOf(deps, conversationId);
    if (rollout === null) throw notFound();
    const read = readCodexElements(rollout);
    if (read === null) throw unreadable();
    elements = read.elements;
    inProgress = read.busy;
  } else {
    const transcript = (deps.transcript ?? ((id: string) => findTranscript(id, { store: deps.store() })))(conversationId);
    if (transcript === null) throw notFound();
    const read = readClaudeElements(transcript.file);
    if (read === null) throw unreadable();
    elements = read;
    const state = (deps.state ?? ((id: string) => conversationState(id)))(conversationId);
    inProgress = state === "busy" || state === "waiting";
  }
  resolveSources(elements, {
    agent,
    conversationId,
    deliveries: readChatDeliveries(deps.chatDeliveries),
    requests: findConversationRequests(conversationId, deps.requestsDir),
    sessions: conversationSessionNames(deps, conversationId),
    hub: agent === "claude" ? readHubSendLog(deps.sendLog) : null,
    deliveredIds: agent === "codex" ? readHubDeliveredIds(deps.chatReceipts) : new Set<string>(),
  });
  return { agent, elements, inProgress };
}

/**
 * その動詞では効かない指定を、黙って無視せずに断る（`read --query` を「探した」と取り違えさせない）。
 * ほかの動詞は知らない指定を無視するが、read / search は指定で返る範囲が変わるので厳しくする。
 */
function rejectFlags(args: ParsedArgs, names: readonly string[], hint: string): void {
  const given = names.find((name) => args.flags.has(name));
  if (given !== undefined) throw new ChatError(EXIT.usage, "unsupported_option", `${given} はこの動詞では使えません`, hint);
}

/** カーソルの誤りを、使い方の誤り（終了コード 2）として返す。 */
function withCursorErrors<T>(conversationId: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (!(error instanceof ChatReadError)) throw error;
    throw new ChatError(EXIT.usage, error.code, error.message, error.code === "stale_cursor"
      ? `tailii-host chat read ${conversationId} --last <件数> --json で取り直す` : undefined);
  }
}

async function cmdRead(args: ParsedArgs, deps: ChatDeps): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  rejectFlags(args, ["--query", "--context"], "語で探すのは tailii-host chat search <会話ID> --query <語>");
  const afterRaw = flagString(args, "--after");
  const beforeRaw = flagString(args, "--before");
  const conflict = (message: string): ChatError => new ChatError(EXIT.usage, "conflicting_options", message);
  if (afterRaw !== undefined && beforeRaw !== undefined) throw conflict("--after と --before は同時に指定できません");
  if (args.flags.has("--last") && (afterRaw ?? beforeRaw) !== undefined) {
    throw conflict("--last と --after / --before は同時に指定できません");
  }
  const mode = afterRaw !== undefined ? "after" as const : beforeRaw !== undefined ? "before" as const : "last" as const;
  if (mode === "last" && args.flags.has("--limit")) throw conflict("--limit は --after / --before と使います（末尾からは --last <件数>）");
  const count = intFlag(args, mode === "last" ? "--last" : "--limit", READ_LIMITS.defaultCount, 1, READ_LIMITS.maxCount);
  const maxTextBytes = intFlag(args, "--max-text", READ_LIMITS.defaultTextBytes, READ_LIMITS.minTextBytes, READ_LIMITS.maxTextBytes);
  const cursorRaw = afterRaw ?? beforeRaw;
  const loaded = loadConversation(deps, conversationId);
  const result = withCursorErrors(conversationId, () => sliceElements(loaded.elements, {
    mode, count, maxTextBytes, ...(cursorRaw !== undefined ? { cursor: parseCursor(cursorRaw) } : {}),
  }));
  const { messages, ...summary } = result;
  return { conversationId, agent: loaded.agent, inProgress: loaded.inProgress, ...summary, messages };
}

async function cmdSearch(args: ParsedArgs, deps: ChatDeps): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  rejectFlags(args, ["--last", "--after", "--max-text"],
    "search は新しい一致から返す（古い一致は --before <カーソル>）。全文や広い前後は chat read で読む");
  // 検索語は --query か、標準入力の 1 行目（SSH 越しに空白や記号を含む語を渡すときは、シェルを通らない標準入力で）。
  const query = (flagString(args, "--query") ?? (await deps.readStdin())?.split(/\r\n|\r|\n/)[0] ?? "").trim();
  if (query.length === 0) {
    throw new ChatError(EXIT.usage, "empty_query", "検索語が空です（--query <語> か、標準入力の 1 行目で渡す）");
  }
  if (query.length > READ_LIMITS.maxQueryChars) {
    throw new ChatError(EXIT.usage, "query_too_long", `検索語は ${READ_LIMITS.maxQueryChars} 文字まで`);
  }
  const context = intFlag(args, "--context", READ_LIMITS.defaultContext, 0, READ_LIMITS.maxContext);
  const limit = intFlag(args, "--limit", READ_LIMITS.defaultHits, 1, READ_LIMITS.maxHits);
  const beforeRaw = flagString(args, "--before");
  const loaded = loadConversation(deps, conversationId);
  const result = withCursorErrors(conversationId, () => searchElements(loaded.elements, {
    query, context, limit, ...(beforeRaw !== undefined ? { before: parseCursor(beforeRaw) } : {}),
  }));
  const { hits, ...summary } = result;
  return { conversationId, agent: loaded.agent, query, inProgress: loaded.inProgress, ...summary, hits };
}

/** 人向けの 1 要素の見出し（`#位置 役割(出所) 時刻`）。 */
function elementHeading(message: Pick<OutputMessage, "seq" | "role" | "atMs" | "source">): string {
  const who = message.role === "assistant" ? "assistant" : `user(${message.source?.kind ?? "unknown"})`;
  return `#${message.seq} ${who} ${message.atMs > 0 ? new Date(message.atMs).toISOString() : "-"}`;
}

// ---------------------------------------------------------------------------------------------------------------
// 第 2 段: 承認・設問・開き直し・画面

/**
 * Bot の許可モードを Codex の承認の方針と sandbox にする（sandbox は常に作業フォルダの中だけ書ける workspace-write。
 * 何でもできる danger-full-access は使わない）。人が指定しなければ会話の設定のまま（undefined）。
 */
export function codexTurnOptions(mode: PermissionMode | undefined): CodexTurnOptions | undefined {
  switch (mode) {
    case undefined: return undefined;
    // プラン以外は通常のモードを明示する（App Server は thread にモードを残すので、プランで始めた会話を戻せるように。
    // アプリも毎 turn 明示している。Fable レビュー 中2）。
    case "default": return { approvalPolicy: "untrusted", sandbox: "workspace-write", collaborationMode: "default" };
    case "acceptEdits": return { approvalPolicy: "on-request", sandbox: "workspace-write", collaborationMode: "default" };
    case "plan": return { approvalPolicy: "on-request", sandbox: "workspace-write", collaborationMode: "plan" };
    case "auto": return { approvalPolicy: "never", sandbox: "workspace-write", collaborationMode: "default" };
  }
}

function codexRolloutOf(deps: ChatDeps, threadId: string): string | null {
  return (deps.codexRollout ?? ((id: string) => findCodexRollout(id)))(threadId);
}

/** 会話のエージェント（メタ → Claude の記録 → Codex の rollout の順に見る）。 */
function conversationAgent(deps: ChatDeps, conversationId: string): "claude" | "codex" {
  const meta = deps.store().all().find((entry) =>
    entry.providerSessionId === conversationId || entry.claudeSessionId === conversationId);
  if (meta !== undefined) return meta.agent === "codex" ? "codex" : "claude";
  if (deps.transcript !== undefined || findTranscript(conversationId, { store: deps.store() }) !== null) return "claude";
  return codexRolloutOf(deps, conversationId) !== null ? "codex" : "claude";
}

/** hub に、会話がいま設問で待っているかを聞く（聞けなければ false）。 */
async function hasPendingQuestionOn(engine: EngineConnection, deps: ChatDeps, conversationId: string): Promise<boolean> {
  try {
    for (const session of conversationSessionNames(deps, conversationId)) {
      if (await pendingQuestionOn(engine, session) !== null) return true;
    }
  } catch {
    // 聞けなければ設問なし扱い（状態は busy のまま）。
  }
  return false;
}

/** 会話 id を収容している Tailii の会話名（メタから）。 */
function conversationSessionNames(deps: ChatDeps, conversationId: string): string[] {
  return sessionNamesForConversation(deps.store(), conversationId);
}

function pendingApprovalsOf(deps: ChatDeps, conversationId: string): PendingApprovalRecord[] {
  const base = deps.approvalsBase ?? defaultApprovalsBase();
  return conversationSessionNames(deps, conversationId).flatMap((session) => listPendingApprovals(session, base));
}

/** hub に、会話名がいま待っている設問を聞く。 */
async function pendingQuestionOn(engine: EngineConnection, session: string): Promise<PendingQuestion | null> {
  const id = newId();
  const reply = await engine.request({ type: "chat_pending_query", v: 2, id, session },
    isType("chat_pending_query_result", id), 10_000);
  if (reply.type !== "chat_pending_query_result") throw engineFailure(reply, "設問の確認");
  return reply.question !== undefined ? { session, ...reply.question } : null;
}

/**
 * 待っているものの中身。承認があれば `waiting_approval`（承認 ID・ツール・要約）、設問の答え待ちなら `waiting_answer`
 * （設問 ID と選択肢）。設問は hub に聞く（engine を起こすので、答え待ち＝waiting のときだけ）。
 */
async function waitingDetails(
  deps: ChatDeps,
  conversationId: string,
  state: ConversationState,
  approvals: PendingApprovalRecord[],
  openEngine?: EngineConnection,
): Promise<{ state: string; detail?: Record<string, unknown> }> {
  if (approvals.length > 0) {
    return {
      state: "waiting_approval",
      detail: {
        approvals: approvalViews(approvals),
      },
    };
  }
  if (state !== "waiting") return { state };
  const sessions = conversationSessionNames(deps, conversationId);
  if (sessions.length === 0) return { state };
  try {
    const find = async (engine: EngineConnection): Promise<PendingQuestion | null> => {
      for (const session of sessions) {
        const found = await pendingQuestionOn(engine, session);
        if (found !== null) return found;
      }
      return null;
    };
    const question = openEngine !== undefined ? await find(openEngine) : await withEngine(deps, find);
    return question !== null ? { state: "waiting_answer", detail: { question: questionView(question) } } : { state };
  } catch {
    return { state }; // 聞けなくても状態は返す。
  }
}

/**
 * `--choice` を回答にする。設問ごとに `;` で区切り、複数選択は `,`（例 `2` / `1;3,4`）。番号は 1 から。`--other` は
 * 設問が 1 つのときの自由記述（「その他」の行）。アプリと同じ形で送る: その他の行の番号（選択肢の数）を
 * `selectedOptionIndexes` に足す（hub は otherText があると最大の番号をその他の行とみなして、その番号キーを押してから
 * 本文を打つ。足さないと普通の選択肢をその他の行と取り違え、本文が入力欄へ落ちて発言になる）。1 つだけ選ぶ設問では
 * その他と選択肢は両立しない（アプリも、その他を選ぶと選択はその他だけになる）。
 */
function buildAnswers(questions: QuestionPromptQuestion[], choiceRaw: string | undefined, other: string | undefined): QuestionAnswer[] {
  const parts = choiceRaw === undefined ? [] : choiceRaw.split(";");
  if (other !== undefined && questions.length !== 1) {
    throw new ChatError(EXIT.usage, "other_needs_single_question", "--other は設問が 1 つのときだけ使えます");
  }
  if (choiceRaw !== undefined && parts.length !== questions.length) {
    throw new ChatError(EXIT.usage, "choice_count", `設問は ${questions.length} つです。--choice は設問ごとに ; で区切る（例 1;2）`);
  }
  return questions.map((question, index) => {
    const raw = parts[index]?.trim() ?? "";
    const numbers = raw.length === 0 ? [] : raw.split(",").map((part) => Number(part.trim()));
    for (const number of numbers) {
      if (!Number.isInteger(number) || number < 1 || number > question.options.length) {
        throw new ChatError(EXIT.usage, "bad_choice", `設問 ${index + 1} の選択肢は 1〜${question.options.length}: ${raw}`);
      }
    }
    if (!question.multiSelect && numbers.length > 1) {
      throw new ChatError(EXIT.usage, "single_choice", `設問 ${index + 1} は 1 つだけ選べます`);
    }
    const otherText = index === 0 && other !== undefined && other.trim().length > 0 ? other.trim() : undefined;
    if (numbers.length === 0 && otherText === undefined) {
      throw new ChatError(EXIT.usage, "missing_choice", `設問 ${index + 1} の答えがありません（--choice か --other）`);
    }
    if (!question.multiSelect && numbers.length > 0 && otherText !== undefined) {
      throw new ChatError(EXIT.usage, "choice_with_other",
        `設問 ${index + 1} は 1 つだけ選べます（--choice か --other のどちらか）`);
    }
    const selected = [...new Set(numbers)].map((number) => number - 1);
    // その他の行（選択肢の数 = 0 始まりで最後の次）。
    if (otherText !== undefined) selected.push(question.options.length);
    return {
      questionIndex: index,
      selectedOptionIndexes: selected.sort((a, b) => a - b),
      multiSelect: question.multiSelect,
      ...(otherText !== undefined ? { otherText } : {}),
    };
  });
}

const QUESTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

async function cmdAnswer(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const conversationId = args.positional[0];
  const questionId = args.positional[1];
  if (conversationId === undefined || !CONVERSATION_ID.test(conversationId) || questionId === undefined ||
    !QUESTION_ID.test(questionId) || args.positional.length > 2) {
    throw new ChatError(EXIT.usage, "usage", "chat answer <会話ID> <設問ID> --choice <番号>",
      "設問 ID と選択肢は chat status の waiting.question で分かる");
  }
  // Bot が答えてよいのは Bot が始めた会話だけ（利用者の会話の設問は利用者が答える。第 2 段）。
  if (bot && !(deps.botStarted ?? ((id: string) => isBotStartedConversation(id)))(conversationId)) {
    throw new ChatError(EXIT.policy, "answer_not_allowed", "この会話は Bot が始めた会話ではないので、設問に答えられません", "人に伝える");
  }
  const choiceRaw = flagString(args, "--choice");
  const other = flagString(args, "--other");
  if (choiceRaw === undefined && other === undefined) {
    throw new ChatError(EXIT.usage, "missing_choice", "--choice（選択肢の番号）か --other（自由記述）が要ります");
  }
  const sessions = conversationSessionNames(deps, conversationId);
  if (sessions.length === 0) throw new ChatError(EXIT.notFound, "not_found", "Tailii で動いている会話が見つかりません");
  return withEngine(deps, async (engine) => {
    let target: PendingQuestion | null = null;
    for (const session of sessions) {
      const found = await pendingQuestionOn(engine, session);
      if (found !== null && found.id === questionId) { target = found; break; }
    }
    if (target === null) {
      throw new ChatError(EXIT.notFound, "question_not_found", "この設問は待っていません（答え済みか、取り下げられた）",
        "chat status で今待っているものを確かめる");
    }
    const answers = buildAnswers(target.questions, choiceRaw, other);
    // 送る前に「Bot が答える設問」として見張りに控える。受理の後に控えると、その間に走った poll が、hub の書いた
    // 「答えられた」を人の回答と読む。送信が失敗したら控えは残るが、その設問を人が答えたときに起こさないだけで済む。
    if (bot) await recordWatchBotAnswer(deps, conversationId, questionId);
    const reply = await engine.request({ type: "question_answer", v: 2, id: questionId, session: target.session, answers },
      (message) => message.type === "remote_pending_cleared" && message.id === questionId, 20_000);
    if (reply.type === "error") {
      if (reply.code === "question_already_answered") {
        throw new ChatError(EXIT.notFound, "question_already_answered", "この設問は既に答えられています");
      }
      if (reply.code === "question_stale") {
        throw new ChatError(EXIT.retryLater, "question_not_shown", "設問が画面に出ていないので、答えを送っていません",
          "少し待って chat status で確かめてから打ち直す");
      }
      throw new ChatError(EXIT.retryLater, reply.code, reply.message, "少し待って打ち直す");
    }
    return { conversationId, questionId, answered: true };
  });
}

async function cmdApprove(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const [conversationId, approvalId, decision] = args.positional;
  if (conversationId === undefined || !CONVERSATION_ID.test(conversationId) || approvalId === undefined ||
    (decision !== "allow" && decision !== "deny") || args.positional.length > 3) {
    throw new ChatError(EXIT.usage, "usage", "chat approve <会話ID> <承認ID> allow|deny [--reason <理由>]",
      "承認 ID は chat status の waiting.approvals で分かる");
  }
  // 拒否はいつでもできる。許可は、Bot には利用者が許したときだけ（第 2 段）。
  if (decision === "allow" && bot && !deps.config().allowApprove) {
    throw new ChatError(EXIT.policy, "approve_not_allowed", "Bot は承認を許可できません（拒否はできます）",
      "人に伝える（利用者が iPhone で答える）。許可させるなら利用者が ~/.tailii/bot.json の allowApprove を true にする");
  }
  const base = deps.approvalsBase ?? defaultApprovalsBase();
  const record = findPendingApproval(approvalId, base);
  if (record === null || !conversationSessionNames(deps, conversationId).includes(record.session)) {
    throw new ChatError(EXIT.notFound, "approval_not_found", "この承認は待っていません（決まったか、取り下げられた）",
      "chat status で今待っているものを確かめる");
  }
  // Bot の許可は、許可された作業フォルダの中の承認だけ（ほかの Bot の制限と同じ。拒否はどこでもできる）。
  if (decision === "allow" && bot && !folderAllowed(record.cwd, deps.config().allowedRoots)) {
    throw new ChatError(EXIT.policy, "folder_not_allowed", `この承認の作業フォルダは許可されていません: ${record.cwd}`,
      "人に伝える（利用者が iPhone で答える）");
  }
  const reason = flagString(args, "--reason");
  const written = writeApprovalDecision(record.session, approvalId, {
    decision, by: "cli", atMs: deps.now(), ...(reason !== undefined ? { reason } : {}),
  }, base);
  if (written.status === "invalid") throw new ChatError(EXIT.usage, "bad_approval_id", "承認 ID が正しくありません");
  if (written.status === "exists") {
    return { conversationId, approvalId, decision: written.existing?.decision ?? null, alreadyDecided: true };
  }
  // 承認フックが決めて記録を片付けるまで少し待つ（最大約 5 秒 = 200 ms × 25 回）。フックは決めた側と決定を
  // `<id>.result` に残すので、アプリが先に逆の答えを返した場合もそれを返す（applied は CLI の決定で決まったか）。
  for (let attempt = 0; attempt <= 25; attempt++) {
    const result = takeApprovalResult(record.session, approvalId, base);
    if (result !== null) {
      return { conversationId, approvalId, decision: result.decision, applied: result.by === "cli",
        ...(result.by !== "cli" ? { decidedBy: result.by } : {}) };
    }
    if (!listPendingApprovals(record.session, base).some((entry) => entry.id === approvalId)) {
      return { conversationId, approvalId, decision: null, applied: false, decidedBy: "unknown" };
    }
    if (attempt < 25) await deps.sleep(200);
  }
  return { conversationId, approvalId, decision, applied: false };
}

/** 一意の会話名（`tailii-host chat` の会話。承認できる人が居ないときの即拒否の対象になる）。 */
function freshSessionName(): string {
  return `s-cli${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function cmdTakeOver(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown> & { attach?: string }> {
  const conversationId = requireConversationId(args);
  const interrupt = args.flags.has("--interrupt");
  const config = deps.config();
  if (bot && !config.allowTakeOver) {
    throw new ChatError(EXIT.policy, "take_over_not_allowed", "Bot は他所で動いている会話を開き直せません",
      "人に伝える（利用者がアプリで開き直せる）。許すなら利用者が ~/.tailii/bot.json の allowTakeOver を true にする");
  }
  // Bot は処理中の相手を中断させない（相手が待機中のときだけ。第 2 段）。
  if (bot && interrupt) throw new ChatError(EXIT.policy, "interrupt_not_allowed", "Bot は処理中の会話を中断させられません");
  const attach = !bot && !args.flags.has("--no-attach");
  const result = await withEngine(deps, async (engine) => {
    const rows = await listConversations(engine);
    const row = rows.find((entry) => entry.conversationId === conversationId);
    if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
    if (row.agent !== "claude") throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話の開き直しは未対応です");
    if (row.liveSession !== undefined) return { tookOver: false, alreadyInTailii: true, session: row.liveSession };
    if (bot && !folderAllowed(row.cwd, config.allowedRoots)) {
      throw new ChatError(EXIT.policy, "folder_not_allowed", `この会話の作業フォルダは許可されていません: ${row.cwd}`);
    }
    const id = newId();
    const check = await engine.request({ type: "session_peer_check", v: 2, id, conversationId },
      isType("session_peer_check_response", id), 30_000);
    if (check.type !== "session_peer_check_response") throw engineFailure(check, "確認");
    if (check.clear) return { tookOver: false, notRunningElsewhere: true };
    if (check.canTakeOver !== true || check.token === undefined) {
      throw new ChatError(EXIT.elsewhere, "cannot_take_over",
        `この会話は開き直せない場所で動いています（${check.holder ?? "不明"}${check.reason ? `: ${check.reason}` : ""}）`, "人に伝える",
        { where: check.holder });
    }
    if (check.busy === true && !interrupt) {
      throw new ChatError(EXIT.elsewhere, "busy_elsewhere", "相手は処理中です。終わってから開き直す",
        bot ? "少し待って打ち直す" : "処理を中断してよいなら --interrupt", { where: check.holder });
    }
    if (!bot && !args.flags.has("--yes")) {
      const ok = deps.confirm?.(`${check.holderName ?? check.holder ?? "他所"}で動いているこの会話を終了させて、Tailii で開き直しますか？`) ?? false;
      if (!ok) return { tookOver: false, cancelled: true };
    }
    const started = await startSession(engine, {
      cwd: row.cwd, name: freshSessionName(), resumeSessionId: conversationId, agentType: "claude", peerCheck: true,
      takeOver: { token: check.token, ...(interrupt ? { interrupt: true } : {}) },
    });
    return { tookOver: true, session: started.session };
  });
  const session = typeof result["session"] === "string" ? result["session"] : undefined;
  return { conversationId, ...result, ...(attach && session !== undefined && result["cancelled"] !== true ? { attach: session } : {}) };
}

// ---- モデルの選択 ----

/** 一覧の 1 件（Claude は工数の欄が無い）。 */
interface ModelEntry {
  id: string;
  displayName: string;
  isDefault?: boolean;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
}

/** 控えを使う長さ（アプリの一覧の控えと同じ 6 時間）。一覧の取得は外部 API を叩くので、呼び出しごとに引かない。 */
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** モデル ID（起動フラグへ渡すので、engine の検証と同じ文字だけ。先頭の `-` はオプションと紛れるので断る）。 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUDE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

async function fetchModelList(deps: ChatDeps, agent: "claude" | "codex"): Promise<ModelEntry[] | null> {
  try {
    return await withEngine(deps, async (engine) => {
      const id = newId();
      if (agent === "claude") {
        const reply = await engine.request({ type: "claude_model_list_request", v: 2, id }, isType("claude_model_list_response", id), 20_000);
        if (reply.type !== "claude_model_list_response") return null;
        return reply.models.map((model) => ({ id: model.id, displayName: model.displayName }));
      }
      const reply = await engine.request({ type: "codex_model_list_request", v: 2, id }, isType("codex_model_list_response", id), 20_000);
      if (reply.type !== "codex_model_list_response") return null;
      return reply.models.map((model) => ({
        id: model.id, displayName: model.displayName, description: model.description,
        ...(model.supportedReasoningEfforts !== undefined ? { efforts: model.supportedReasoningEfforts } : {}),
        ...(model.defaultReasoningEffort !== undefined ? { defaultEffort: model.defaultReasoningEffort } : {}),
      }));
    });
  } catch {
    return null;
  }
}

/** モデル一覧（控え → 取得 → 取れなければ古い控え）。どれも無ければ null。 */
async function loadModelList(deps: ChatDeps, agent: "claude" | "codex", refresh: boolean): Promise<{
  models: ModelEntry[]; source: "live" | "cache"; fetchedAtMs: number; stale: boolean;
} | null> {
  // 既定の印は控えに持たない（設定はいつでも変わるので毎回読む）。前の版の控えに残っている印も捨てる。
  const stored = readModelCache<ModelEntry>(agent, deps.modelCacheDir);
  const cache = stored === null ? null : { ...stored, models: stored.models.map(({ isDefault: _stale, ...model }) => model) };
  const cacheAgeMs = cache === null ? Number.POSITIVE_INFINITY : deps.now() - cache.fetchedAtMs;
  if (!refresh && cache !== null && cacheAgeMs >= 0 && cacheAgeMs < MODEL_CACHE_TTL_MS) {
    return { models: cache.models, source: "cache", fetchedAtMs: cache.fetchedAtMs, stale: false };
  }
  const models = await fetchModelList(deps, agent);
  if (models !== null && models.length > 0) {
    const fetchedAtMs = deps.now();
    writeModelCache(agent, { fetchedAtMs, models }, deps.modelCacheDir);
    return { models, source: "live", fetchedAtMs, stale: false };
  }
  return cache !== null ? { models: cache.models, source: "cache", fetchedAtMs: cache.fetchedAtMs, stale: true } : null;
}

/**
 * 指定されたモデル・工数を送る前に確かめる（engine は不正な値を黙って捨てて既定のモデルで起動するので、Bot が指定が効いたと
 * 誤解する）。戻り値は一覧と照らせたか（Claude は一覧が取れなければ文字の検査だけで通す）。
 */
async function validateModelChoice(
  deps: ChatDeps, bot: boolean, agent: "claude" | "codex", model: string | undefined, effort: string | undefined, cwd: string | null,
): Promise<boolean> {
  if (model === undefined && effort === undefined) return true;
  if (model !== undefined && !MODEL_ID.test(model)) {
    throw new ChatError(EXIT.usage, "bad_model", `モデル ID が正しくありません: ${model}`, "tailii-host chat models --json で確かめる");
  }
  const allowed = bot ? deps.config().allowedModels : undefined;
  if (model !== undefined && allowed !== undefined && !allowed.includes(model)) {
    throw new ChatError(EXIT.policy, "model_not_allowed", `このモデルは Bot に許されていません: ${model}`,
      `使えるのは ${allowed.join(", ") || "（なし）"}（~/.tailii/bot.json の allowedModels）`);
  }
  if (agent === "claude" && effort !== undefined && !CLAUDE_EFFORTS.includes(effort)) {
    throw new ChatError(EXIT.usage, "bad_effort", `工数は ${CLAUDE_EFFORTS.join(" / ")}: ${effort}`);
  }
  // Claude で allowedModels に書かれたモデルは一覧を見ない（利用者が明示した。外部 API も叩かない）。Codex は必ず一覧と照らす
  // （不正な値で turn が始まった後に失敗すると、届いたか分からない送信として残る。一覧は App Server から取る）。
  const needsList = (model !== undefined && (allowed === undefined || agent === "codex")) || (agent === "codex" && effort !== undefined);
  if (!needsList) return true;
  let list = await loadModelList(deps, agent, false);
  // 控えに無いモデルは、控えの後に増えたのかもしれないので 1 回だけ取り直す。
  if (model !== undefined && list?.source === "cache" && !list.stale && !list.models.some((item) => item.id === model)) {
    list = await loadModelList(deps, agent, true);
  }
  if (list === null) {
    if (agent === "codex") {
      throw new ChatError(EXIT.retryLater, "model_list_unavailable", "Codex のモデル一覧を取得できませんでした", "少し待って打ち直す");
    }
    return false;
  }
  // `--effort` だけのときは、そのフォルダで実際に使われる既定のモデルで確かめる。
  const defaultId = model === undefined ? defaultModelIdOf(deps, agent, list.models, cwd) : null;
  if (agent === "codex" && model === undefined && defaultId === null) {
    throw new ChatError(EXIT.usage, "effort_needs_model", "既定のモデルを決められないので、工数を確かめられません", "--model も指定する（chat models --agent codex --json で確かめる）");
  }
  const entry = list.models.find((item) => item.id === (model ?? defaultId));
  if (model !== undefined && entry === undefined) {
    // 取得に失敗して古い控えしか無い Claude は、新しいモデルかもしれないので断らない（確かめられなかったと返す）。
    if (agent === "claude" && list.stale) return false;
    throw new ChatError(EXIT.usage, "unknown_model", `一覧にないモデルです: ${model}`, "tailii-host chat models --json で確かめる（別名は使えない）");
  }
  if (agent === "codex" && effort !== undefined && entry?.efforts?.includes(effort) !== true) {
    throw new ChatError(EXIT.usage, "bad_effort", `このモデルで使えない工数です: ${effort}`,
      entry?.efforts !== undefined ? `使えるのは ${entry.efforts.join(" / ")}` : "tailii-host chat models --agent codex --json で確かめる");
  }
  return !list.stale;
}

/** そのフォルダで実際に使われる既定のモデルの行の id（決められなければ null）。 */
function defaultModelIdOf(deps: ChatDeps, agent: "claude" | "codex", rows: readonly ModelEntry[], cwd: string | null): string | null {
  const context = deps.defaultModelContext ?? defaultModelContext();
  return (agent === "claude" ? resolveClaudeDefaultModel(rows, cwd, context) : resolveCodexDefaultModel(rows, cwd, context)).id;
}

async function cmdModels(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const agent = flagString(args, "--agent") ?? "claude";
  if (agent !== "claude" && agent !== "codex") throw new ChatError(EXIT.usage, "bad_agent", `--agent は claude か codex: ${agent}`);
  const cwdFlag = flagString(args, "--cwd");
  if (cwdFlag !== undefined && !folderAllowed(cwdFlag, deps.config().allowedRoots)) {
    throw new ChatError(EXIT.usage, "folder_not_allowed", `作業フォルダが無いか、許可されていません: ${cwdFlag}`,
      "許可されているのは ~/.tailii/bot.json の allowedRoots の中");
  }
  const list = await loadModelList(deps, agent, args.flags.has("--refresh"));
  if (list === null) {
    throw new ChatError(EXIT.retryLater, "model_list_unavailable", "モデル一覧を取得できませんでした", "少し待って打ち直す");
  }
  const defaultId = defaultModelIdOf(deps, agent, list.models, cwdFlag === undefined ? null : fs.realpathSync(cwdFlag));
  const marked = list.models.map((model) => model.id === defaultId ? { ...model, isDefault: true } : model);
  const allowed = bot ? deps.config().allowedModels : undefined;
  return {
    agent,
    models: allowed === undefined ? marked : marked.filter((model) => allowed.includes(model.id)),
    source: list.source, fetchedAtMs: list.fetchedAtMs,
    ...(list.stale ? { stale: true } : {}),
    ...(allowed !== undefined ? { restricted: true } : {}),
  };
}

/** `/model` の結果が会話の記録に出るまで待つ上限（秒）。 */
const SET_MODEL_CONFIRM_SECONDS = 15;

/** 会話の記録で `/model` の結果を確かめる。確かめられなければ 7（送信は済んでいるので、同じ依頼 ID の打ち直しは確かめだけをやり直す）。 */
async function confirmModelChange(deps: ChatDeps, record: RequestRecord, model: string): Promise<Record<string, unknown>> {
  const transcriptOf = deps.transcript ?? ((id: string, cwdHint?: string) =>
    findTranscript(id, { store: deps.store(), ...(cwdHint !== undefined ? { cwdHint } : {}) }));
  const where = { requestId: record.requestId, conversationId: record.conversationId, session: record.session, model };
  let result: ReturnType<typeof findModelCommandResult> = null;
  for (let attempt = 0; attempt <= SET_MODEL_CONFIRM_SECONDS; attempt++) {
    const transcript = transcriptOf(record.conversationId, record.cwd);
    result = transcript === null ? null : findModelCommandResult(transcript.file, record.sentAtMs, model);
    if (result?.detail != null) break;
    if (attempt < SET_MODEL_CONFIRM_SECONDS) await deps.sleep(1_000);
  }
  const detail = result?.detail ?? null;
  if (detail === null) {
    throw new ChatError(EXIT.timeout, "model_change_unconfirmed", "モデルが変わったことを確かめられませんでした",
      "同じ依頼 ID で打ち直すと確かめだけをやり直す（処理中だった会話は、ターンが終わるまで記録に出ない）。次の返答の後に chat status の model でも確かめられる",
      where);
  }
  // 結果が出て成功の文言でなければ確定した失敗（打ち直しても同じ行を読むだけ）。
  if (!detail.startsWith("Set model to")) {
    throw new ChatError(EXIT.policy, "model_change_failed", `モデルを変えられませんでした: ${detail}`,
      "chat models --json で確かめて新しい依頼 ID でやり直すか、人に伝える", { ...where, detail });
  }
  return {
    ...where, applied: true, detail, savedAsDefault: /saved as your default/i.test(detail),
    // この後に別のモデルへ変えられている（今のモデルは頼んだものではない）。
    ...(result?.superseded === true ? { superseded: true } : {}),
  };
}

/** 処理中・答え待ちの間に `/model` を打つと、確認の画面が承認されないまま残りうる。待機中だけ受け付ける。 */
function assertIdleForModelChange(deps: ChatDeps, conversationId: string): void {
  const state = (deps.state ?? ((id: string) => conversationState(id)))(conversationId);
  if (state === "busy" || state === "waiting" || pendingApprovalsOf(deps, conversationId).length > 0) {
    throw new ChatError(EXIT.retryLater, "conversation_busy", "会話が処理中か答え待ちなので今は変えられません",
      "chat status --wait で待機中になってから同じ依頼 ID で打ち直す", { state });
  }
}

async function cmdSetModel(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  const model = flagString(args, "--model");
  if (model === undefined) throw new ChatError(EXIT.usage, "missing_model", "--model が要ります", "tailii-host chat models --json で確かめる");
  if (args.flags.has("--effort")) throw new ChatError(EXIT.usage, "unexpected_effort", "set-model は --effort を受け取りません");
  // Claude の `/model` は利用者の「新しい会話の既定モデル」も書き換えるので、Bot には既定で許さない。
  if (bot && !deps.config().allowSetModel) {
    throw new ChatError(EXIT.policy, "set_model_not_allowed", "Bot は会話の途中でモデルを変えられません（利用者の既定モデルも変わるため）",
      "人に伝える。許すなら利用者が ~/.tailii/bot.json の allowSetModel を true にする。新しい会話なら chat new --model で選べる");
  }
  if (conversationAgent(deps, conversationId) === "codex") {
    throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話の途中のモデル変更は未対応です", "新しい会話なら chat new --agent codex --model で選べる");
  }
  const requestId = requestIdOf(args, bot);
  const validated = await validateModelChoice(deps, bot, "claude", model, undefined, null);
  const result = await withRequestLock(deps, requestId, async () => {
    const previous = (deps.readRequest ?? readRequest)(requestId);
    if (previous !== null) assertSameRequest(previous, { kind: "set-model", conversationId, textHash: null, model });
    if (previous !== null && previous.state === "sent") return confirmModelChange(deps, previous, model);
    const sent = await withEngine(deps, async (engine) => {
      let record = previous !== null && previous.state === "started" ? previous : null;
      if (record !== null) {
        const revived = await retryStarted(engine, deps, record);
        if (revived.delivered) {
          (deps.writeRequest ?? writeRequest)({ ...record, state: "sent" });
          return record;
        }
        record = revived.record;
        // 打ち直しの間に会話が動き出していることがある（初回と同じ確かめ。記録は started のまま残る）。
        assertIdleForModelChange(deps, conversationId);
      } else {
        const rows = await listConversations(engine);
        const row = rows.find((entry) => entry.conversationId === conversationId);
        if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
        if (row.agent !== "claude") {
          throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話の途中のモデル変更は未対応です", "新しい会話なら chat new --agent codex --model で選べる");
        }
        if (row.apiRoute) throw new ChatError(EXIT.policy, "unsupported_route", "API 作業の会話のモデルはこのコマンドでは変えられません");
        if (!folderAllowed(row.cwd, deps.config().allowedRoots)) {
          throw new ChatError(EXIT.policy, "folder_not_allowed", `この会話の作業フォルダは許可されていません: ${row.cwd}`,
            "~/.tailii/bot.json の allowedRoots に入っている会話だけ変えられる");
        }
        if (row.liveSession !== undefined) assertIdleForModelChange(deps, conversationId);
        const session = row.liveSession ?? (await startSession(engine, {
          cwd: row.cwd, name: sessionNameFor(`${requestId}:${conversationId}`), resumeSessionId: conversationId,
          agentType: "claude", peerCheck: true,
        })).session;
        record = {
          requestId, kind: "set-model", conversationId, session, cwd: row.cwd, sentAtMs: deps.now(), text: `/model ${model}`, model,
        };
      }
      await sendRecorded(engine, deps, record);
      return record;
    });
    return confirmModelChange(deps, sent, model);
  });
  return { ...result, ...(!validated ? { modelValidated: false } : {}) };
}

/** engine の `mode_get` / `mode_set`（どちらも応答は `mode_set_response`）。 */
async function requestMode(engine: EngineConnection, session: string, mode: string | null, timeoutMs: number): Promise<ControlMessage> {
  const id = newId();
  return engine.request({ type: mode === null ? "mode_get" : "mode_set", v: 2, id, session, ...(mode !== null ? { mode } : {}) },
    isType("mode_set_response", id), timeoutMs);
}

/** 起動した直後の会話で、今の許可モードを読めるまで待つ回数と間隔（engine の 1 回の読み取りと合わせて 30 秒ほど）。 */
const MODE_READY_ATTEMPTS = 12;
const MODE_READY_INTERVAL_MS = 2_000;

/** 今の許可モードを読む。`attempts` 回読めなければ null。 */
async function readPermissionMode(engine: EngineConnection, deps: ChatDeps, session: string, attempts: number): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const reply = await requestMode(engine, session, null, 15_000).catch((error: unknown) => {
      if (error instanceof EngineTimeoutError) return null;
      throw error;
    });
    if (reply?.type === "mode_set_response") return reply.mode;
    if (attempt >= attempts) return null;
    await deps.sleep(MODE_READY_INTERVAL_MS);
  }
}

/** 変更が失敗した後の今のモードを返す。元でも目的でもなければ元へ戻す。読めなければ null。 */
async function settlePermissionMode(engine: EngineConnection, session: string, before: string, target: string): Promise<string | null> {
  const current = await requestMode(engine, session, null, 15_000).catch(() => null);
  if (current?.type !== "mode_set_response") return null;
  if (current.mode === before || current.mode === target) return current.mode;
  const restored = await requestMode(engine, session, before, 30_000).catch(() => null);
  return restored?.type === "mode_set_response" ? restored.mode : current.mode;
}

/**
 * 動いている Claude の会話の許可モードを変える。engine の `mode_set` は Shift+Tab でモードを巡回するので、目的のモードが巡回に
 * 無いときや状態行を読み損ねたときは別のモードで止まる。そのときは元のモードへ戻してから失敗を返す。
 */
async function cmdSetMode(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  const mode = flagString(args, "--permission-mode");
  if (mode === undefined) throw new ChatError(EXIT.usage, "missing_permission_mode", "--permission-mode が要ります（default / acceptEdits / plan / auto）");
  if (!isPermissionMode(mode)) throw new ChatError(EXIT.usage, "bad_permission_mode", `許可モードは default / acceptEdits / plan / auto: ${mode}`);
  if (bot && mode === "auto" && !deps.config().allowAuto) {
    throw new ChatError(EXIT.policy, "auto_not_allowed", "auto（何でも許可）は Bot に許されていません",
      "利用者が ~/.tailii/bot.json の allowAuto を true にしたときだけ使える");
  }
  if (bot && !(deps.botStarted ?? ((id: string) => isBotStartedConversation(id)))(conversationId)) {
    throw new ChatError(EXIT.policy, "set_mode_not_allowed", "この会話は Bot が始めた会話ではないので、許可モードを変えられません", "人に伝える");
  }
  const codexHint = "Codex は chat send --permission-mode で送信ごとの方針を変える";
  if (conversationAgent(deps, conversationId) === "codex") {
    throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話には set-mode を使えません", codexHint);
  }
  const requestId = requestIdOf(args, bot);
  return withRequestLock(deps, requestId, async () => {
    const previous = (deps.readRequest ?? readRequest)(requestId);
    if (previous !== null) assertSameRequest(previous, { kind: "set-mode", conversationId, textHash: null, mode });
    // 済んだ依頼の打ち直しで、その後の変更を巻き戻さない。
    if (previous !== null && previous.state === "sent") {
      return { duplicate: true, requestId, conversationId, session: previous.session, permissionMode: mode };
    }
    return withEngine(deps, async (engine) => {
      const rows = await listConversations(engine);
      const row = rows.find((entry) => entry.conversationId === conversationId);
      if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
      if (row.agent !== "claude") throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話には set-mode を使えません", codexHint);
      if (row.apiRoute) throw new ChatError(EXIT.policy, "unsupported_route", "API 作業の会話の許可モードはこのコマンドでは変えられません");
      if (!folderAllowed(row.cwd, deps.config().allowedRoots)) {
        throw new ChatError(EXIT.policy, "folder_not_allowed", `この会話の作業フォルダは許可されていません: ${row.cwd}`,
          "~/.tailii/bot.json の allowedRoots に入っている会話だけ変えられる");
      }
      const session = row.liveSession ?? (await startSession(engine, {
        cwd: row.cwd, name: sessionNameFor(`${requestId}:${conversationId}`), resumeSessionId: conversationId,
        agentType: "claude", peerCheck: true,
      })).session;
      // 処理中・答え待ちの間に Shift+Tab を打つと、設問や確認の画面へ入る。待機中だけ受け付ける（打ち直しでも確かめ直す）。
      // 一覧に出ていなくても session_start が動いている会話を採用することがあるので、起動の後に確かめる。
      assertIdleForModelChange(deps, conversationId);
      const record: RequestRecord = {
        requestId, kind: "set-mode", conversationId, session, cwd: row.cwd, sentAtMs: previous?.sentAtMs ?? deps.now(), text: "", mode, state: "started",
      };
      const write = deps.writeRequest ?? writeRequest;
      write(record);
      const where = { requestId, conversationId, session };
      // このコマンドが起動した会話は、画面が出そろうまで読めない。
      const before = await readPermissionMode(engine, deps, session, row.liveSession === undefined ? MODE_READY_ATTEMPTS : 1);
      if (before === null) {
        throw new ChatError(EXIT.retryLater, "mode_unavailable", "今の許可モードを読めませんでした（確認の画面が出ているかもしれません）",
          "少し待って同じ依頼 ID で打ち直す", where);
      }
      if (before === mode) {
        write({ ...record, state: "sent" });
        return { ...where, permissionMode: mode, previousMode: before, changed: false };
      }
      const changed = (): Record<string, unknown> => {
        write({ ...record, state: "sent" });
        return { ...where, permissionMode: mode, previousMode: before, changed: true };
      };
      const incomplete = (): ChatError => new ChatError(EXIT.retryLater, "mode_change_incomplete", "許可モードを変えきれませんでした（元のモードのままです）",
        "少し待って同じ依頼 ID で打ち直す", { ...where, mode: before });
      const blocked = (current: string): ChatError => new ChatError(EXIT.policy, "mode_change_blocked",
        "許可モードを元に戻せませんでした（画面に確認が出ているかもしれません）", "人に伝える", { ...where, mode: current });

      let reply: ControlMessage | null;
      try {
        reply = await requestMode(engine, session, mode, 30_000);
      } catch (error) {
        if (!(error instanceof EngineTimeoutError)) throw error;
        reply = null;
      }
      if (reply?.type === "error" && (reply.code === "mode_set_busy" || reply.code === "mode_unavailable")) {
        // どちらもキーを打つ前に断られている。
        throw new ChatError(EXIT.retryLater, reply.code, reply.message, "少し待って同じ依頼 ID で打ち直す", where);
      }
      if (reply === null || reply.type === "error") {
        // 巡回の途中で止まると、許していない auto に残ることがある（default へ向かう巡回は auto を通る）。今のモードを確かめて片付ける。
        const settled = await settlePermissionMode(engine, session, before, mode);
        if (settled === mode) return changed();
        if (settled === before) throw incomplete();
        if (settled !== null) throw blocked(settled);
        throw new ChatError(EXIT.timeout, reply === null ? "timeout" : reply.code,
          reply === null ? "許可モードの変更の応答がありませんでした" : reply.message, "同じ依頼 ID で打ち直す", where);
      }
      if (reply.type !== "mode_set_response") throw engineFailure(reply, "許可モードの変更");
      if (reply.mode === mode) return changed();
      // 状態行の変化を読み損ねると、engine は途中のモードを正常応答で返す。一度も動いていなければ戻す必要はない。
      if (reply.mode === before) throw incomplete();
      const restored = await requestMode(engine, session, before, 30_000).catch(() => null);
      if (restored?.type !== "mode_set_response" || restored.mode !== before) {
        throw blocked(restored?.type === "mode_set_response" ? restored.mode : reply.mode);
      }
      // 巡回に無いことがあるのは auto だけ。ほかのモードは必ず巡回にあるので、読み損ねとして打ち直せる。
      if (mode !== "auto") throw incomplete();
      throw new ChatError(EXIT.policy, "mode_change_failed", `このモードへは切り替えられません: ${mode}`,
        "今のモードのまま。人に伝える", { ...where, mode: before });
    });
  });
}

async function cmdAttach(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<{ attach: string }> {
  if (bot) throw new ChatError(EXIT.usage, "attach_needs_terminal", "attach は人が端末で使うコマンドです（--json・端末なしでは使えない）");
  const conversationId = requireConversationId(args);
  const session = await withEngine(deps, async (engine) => {
    const rows = await listConversations(engine);
    const row = rows.find((entry) => entry.conversationId === conversationId);
    if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list で確かめる");
    if (row.liveSession !== undefined) return row.liveSession;
    if (row.agent !== "claude" && row.agent !== "codex") {
      throw new ChatError(EXIT.policy, "unsupported_agent", `この種類の会話は未対応です: ${row.agent}`);
    }
    // 止まっていれば Tailii で続きから起動して開く（Claude は他所で動いていれば起動しない）。
    return (await startSession(engine, {
      cwd: row.cwd, name: freshSessionName(), resumeSessionId: conversationId, agentType: row.agent,
      ...(row.agent === "claude" ? { peerCheck: true } : {}),
    })).session;
  });
  return { attach: session };
}

// ---------------------------------------------------------------------------------------------------------------

const USAGE = `usage: tailii-host chat <list|models|new|send|set-model|set-mode|status|read|search|events|watch|answer|approve|take-over|attach> [options]
  AI エージェント（Bot）は tailii-host agent-guide を読んで、必ず --json を付ける。
  端末が無い（パイプで指示を渡すなど）ときは Bot として扱い、--request-id が要る。
  list [--live] [--json]
  new --cwd <フォルダ> [--request-id <ID>] [--title <名前>] [--permission-mode <mode>] [--no-attach] [--json]  < 指示文
  send <conversationId> [--request-id <ID>] [--json]  < 指示文
  status <conversationId> [--after <依頼ID>] [--wait <秒>] [--json]
  read <conversationId> [--last <件数> | --after <カーソル> | --before <カーソル>] [--limit <件数>] [--max-text <バイト>] [--json]
  search <conversationId> --query <語> [--context <件数>] [--limit <件数>] [--before <カーソル>] [--json]
  events [--after <カーソル>] [--conversation <会話ID>] [--type <種別,種別>] [--limit <件数>] [--wait <秒>] [--json]
  watch add <conversationId> --mode continue|notify [--ttl <分>] [--request-id <ID>] [--read-cursor <カーソル>] [--note] [--json]   --note はメモを標準入力から読む
  watch list [--all] [--json]
  watch update <conversationId> [--mode continue|notify] [--ttl <分>] [--note] [--json]
  watch remove <conversationId> --reason done|handed_over|boss_stop|other [--json]
  watch poll [--wait <秒>] [--json]
  watch ack <conversationId> --token <番号> [--read-cursor <カーソル>] [--json]
  new … / send … [--watch continue|notify [--watch-ttl <分>]]
  answer <conversationId> <設問ID> --choice <番号> [--other <文>] [--json]
  approve <conversationId> <承認ID> allow|deny [--reason <理由>] [--json]
  take-over <conversationId> [--interrupt] [--yes] [--no-attach] [--json]
  attach <conversationId>
  new … [--agent claude|codex] [--model <id>] [--effort <工数>] [--backend herdr|tmux] [--herdr-session <名前>]
  models [--agent claude|codex] [--cwd <フォルダ>] [--refresh] [--json]
  set-model <conversationId> --model <id> [--request-id <ID>] [--json]
  set-mode <conversationId> --permission-mode <mode> [--request-id <ID>] [--json]
`;

function render(deps: ChatDeps, json: boolean, payload: Record<string, unknown>, human: string): void {
  if (json) deps.write(`${JSON.stringify({ v: 1, ok: true, ...payload })}\n`);
  else deps.write(`${human}\n`);
}

/** `tailii-host chat …` の本体。終了コードを返す。 */
export async function runChat(argv: string[], deps: ChatDeps): Promise<number> {
  const [verb, ...rest] = argv;
  const json = rest.includes("--json");
  // Bot として扱う（安全の制限・依頼 ID 必須）のは、--json か、端末が無いとき（Bot の --json の付け忘れ。レビュー指摘 A7）。
  const bot = json || !deps.isTty;
  try {
    if (verb === undefined || verb === "--help" || verb === "-h") {
      deps.write(USAGE);
      return verb === undefined ? EXIT.usage : EXIT.ok;
    }
    const args = parseArgs(rest, verb);
    switch (verb) {
      case "list": {
        const payload = await cmdList(args, deps);
        const rows = payload["conversations"] as Array<Record<string, unknown>>;
        render(deps, json, payload, rows.map((row) =>
          `${row["conversationId"]}  ${row["where"] === "tailii" ? "●" : row["where"] === "elsewhere" ? "◐" : " "}  ${row["title"]}  (${row["cwd"]})`,
        ).join("\n") || "（会話がありません）");
        return EXIT.ok;
      }
      case "new": {
        const payload = await cmdNew(args, deps, bot);
        const { attach, ...rest2 } = payload;
        if (attach !== undefined) {
          deps.write(`会話を始めました: ${rest2["conversationId"]}（画面を閉じても会話は続きます）\n`);
          return deps.attach(attach);
        }
        render(deps, json, rest2, `会話を始めました: ${rest2["conversationId"]}`);
        return EXIT.ok;
      }
      case "send": {
        const payload = await cmdSend(args, deps, bot);
        render(deps, json, payload, `送りました: ${payload["conversationId"]}`);
        return EXIT.ok;
      }
      case "status": {
        const payload = await cmdStatus(args, deps);
        render(deps, json, payload, `${payload["state"]}${payload["complete"] ? "（完了）" : ""}\n${payload["reply"] ?? ""}`);
        return EXIT.ok;
      }
      case "read": {
        const payload = await cmdRead(args, deps);
        const messages = payload["messages"] as OutputMessage[];
        render(deps, json, payload, messages.map((message) =>
          `${elementHeading(message)}\n${message.text}${message.truncated === true ? "\n…（続きは --max-text を上げて読む）" : ""}`,
        ).join("\n\n") || "（発話がありません）");
        return EXIT.ok;
      }
      case "search": {
        const payload = await cmdSearch(args, deps);
        const hits = payload["hits"] as SearchHit[];
        render(deps, json, payload, hits.map((hit) => `${elementHeading(hit)}\n${hit.excerpt}`).join("\n\n") ||
          "（見つかりません）");
        return EXIT.ok;
      }
      case "events": {
        const payload = await cmdEvents(args, deps);
        const lines = payload.events.map((event) =>
          `${new Date(event.atMs).toISOString()}  ${event.type}${"session" in event ? `  ${event.session}` : ""}`);
        render(deps, json, payload, lines.join("\n") || "（出来事がありません）");
        return EXIT.ok;
      }
      case "watch": {
        const { payload, human } = await cmdWatch(args, deps);
        render(deps, json, payload, human);
        return EXIT.ok;
      }
      case "answer": {
        const payload = await cmdAnswer(args, deps, bot);
        render(deps, json, payload, `答えました: ${payload["questionId"]}`);
        return EXIT.ok;
      }
      case "approve": {
        const payload = await cmdApprove(args, deps, bot);
        render(deps, json, payload, payload["alreadyDecided"] === true
          ? `既に決まっています: ${payload["decision"]}` : `${payload["decision"] === "allow" ? "許可" : "拒否"}しました`);
        return EXIT.ok;
      }
      case "take-over": {
        const payload = await cmdTakeOver(args, deps, bot);
        const { attach, ...rest2 } = payload;
        if (attach !== undefined) {
          deps.write(`Tailii で開き直しました（画面を閉じても会話は続きます）\n`);
          return deps.attach(attach);
        }
        render(deps, json, rest2, rest2["tookOver"] === true ? "Tailii で開き直しました"
          : rest2["alreadyInTailii"] === true ? "既に Tailii で動いています"
            : rest2["cancelled"] === true ? "開き直しませんでした" : "他所では動いていません");
        return EXIT.ok;
      }
      case "models": {
        const payload = await cmdModels(args, deps, bot);
        const rows = payload["models"] as ModelEntry[];
        render(deps, json, payload, rows.map((row) => `${row.id}${row.isDefault === true ? "  （既定）" : ""}  ${row.displayName}`).join("\n") ||
          "（使えるモデルがありません）");
        return EXIT.ok;
      }
      case "set-model": {
        const payload = await cmdSetModel(args, deps, bot);
        render(deps, json, payload, `モデルを変えました: ${payload["model"]}${payload["savedAsDefault"] === true ? "（新しい会話の既定にもなりました）" : ""}`);
        return EXIT.ok;
      }
      case "set-mode": {
        const payload = await cmdSetMode(args, deps, bot);
        render(deps, json, payload, payload["duplicate"] === true ? `この依頼は済んでいます: ${payload["permissionMode"]}`
          : payload["changed"] === false ? `許可モードは既に ${payload["permissionMode"]} です` : `許可モードを変えました: ${payload["permissionMode"]}`);
        return EXIT.ok;
      }
      case "attach": {
        const payload = await cmdAttach(args, deps, bot);
        return deps.attach(payload.attach);
      }
      default:
        throw new ChatError(EXIT.usage, "unknown_verb", `知らない動詞です: ${verb}`, "tailii-host agent-guide を読んでください");
    }
  } catch (error) {
    const failure = error instanceof ChatError
      ? error
      : new ChatError(EXIT.internal, "internal", String(error instanceof Error ? error.message : error));
    if (json) {
      deps.write(`${JSON.stringify({ v: 1, ok: false, error: {
        code: failure.code, message: failure.message, ...(failure.hint !== undefined ? { hint: failure.hint } : {}),
      }, ...failure.extra })}\n`);
    } else {
      const detail = typeof failure.extra["detail"] === "string" && !failure.message.includes(failure.extra["detail"])
        ? `（${failure.extra["detail"]}）` : "";
      deps.write(`エラー: ${failure.message}${detail}${failure.hint !== undefined ? `\n→ ${failure.hint}` : ""}\n`);
    }
    return failure.exitCode;
  }
}

/** 会話の画面を開く（herdr はそのタブへ切り替えてセッションを開く / tmux は attach）。 */
function attachSession(session: string, store: SessionMetadataStore): number {
  const meta = store.get(session);
  if (meta?.backend === "herdr") {
    const herdrSession = herdrSessionOfMeta(meta);
    const herdr = defaultHerdrPath();
    const list = spawnSync(herdr, ["--session", herdrSession, "pane", "list"], { encoding: "utf8" });
    const tab = parseHerdrPaneList(list.stdout ?? "").find((pane) => pane.label === session)?.tabId;
    if (tab != null) spawnSync(herdr, ["--session", herdrSession, "tab", "focus", tab], { stdio: "ignore" });
    return spawnSync(herdr, ["--session", herdrSession], { stdio: "inherit" }).status ?? 0;
  }
  return spawnSync("tmux", ["attach", "-t", session], { stdio: "inherit" }).status ?? 0;
}

/** 実際の依存で `runChat` を動かす（cli.ts から）。 */
export async function runChatCommand(argv: string[]): Promise<number> {
  let store: SessionMetadataStore | null = null;
  const getStore = (): SessionMetadataStore => (store ??= new SessionMetadataStore());
  // 出力はまとめて書き、書き切ってから返す: 直後の process.exit で、パイプへの 64 KiB を超えた分が捨てられる
  // （macOS 実測。長い一覧や返答の JSON が切れて Bot が読めない。レビュー指摘 A2）。
  let buffered = "";
  const flush = (): Promise<void> => {
    if (buffered.length === 0) return Promise.resolve();
    const text = buffered;
    buffered = "";
    return new Promise((resolve) => process.stdout.write(text, () => resolve()));
  };
  const code = await runChat(argv, {
    connect: () => connectEngine(),
    readStdin: async () => {
      const stdin = process.stdin;
      if (stdin.isTTY) return null;
      // パイプの fd は非ブロッキングになる。SSH で一時的に入力が途切れても EOF まで待つ。
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    },
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    config: () => loadBotConfig(),
    store: getStore,
    write: (text) => { buffered += text; },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    confirm: (question) => confirmOnTty(question),
    attach: (session) => {
      // 画面を開く前に案内を出し切る。
      const pending = buffered;
      buffered = "";
      if (pending.length > 0) fs.writeSync(1, pending);
      return attachSession(session, getStore());
    },
  });
  await flush();
  return code;
}

/** 端末で y/N を聞く（端末が無ければ「いいえ」）。 */
function confirmOnTty(question: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    fs.writeSync(fd, `${question} [y/N] `);
    const buffer = Buffer.alloc(64);
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    return /^\s*y(es)?\s*$/i.test(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

export async function runAgentGuideCommand(): Promise<number> {
  await new Promise<void>((resolve) => process.stdout.write(AGENT_GUIDE, () => resolve()));
  return 0;
}
