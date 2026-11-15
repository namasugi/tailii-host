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
import { AGENT_GUIDE } from "./agentGuide.js";
import { connectEngine, EngineTimeoutError, type EngineConnection } from "./engineClient.js";
import {
  acquireRequestLock,
  conversationState,
  findTranscript,
  folderAllowed,
  isPermissionMode,
  loadBotConfig,
  readReply,
  readRequest,
  readTranscriptLines,
  requestDigest,
  writeRequest,
  type BotConfig,
  type ConversationState,
  type RequestRecord,
} from "./chatState.js";

/** 終了コード（agent-guide に書いた表と同じ）。 */
export const EXIT = {
  ok: 0, internal: 1, usage: 2, notFound: 3, elsewhere: 4, policy: 5, retryLater: 6, timeout: 7,
} as const;

class ChatError extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string, readonly hint?: string,
    readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChatError";
  }
}

/** 差し替え可能な外部（テスト用）。 */
export interface ChatDeps {
  connect: () => Promise<EngineConnection>;
  readStdin: () => string | null;
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
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["--cwd", "--request-id", "--title", "--permission-mode", "--after", "--wait"]);
const BOOL_FLAGS = new Set(["--json", "--live", "--no-attach"]);

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) throw new ChatError(EXIT.usage, "missing_value", `${arg} に値がありません`);
      flags.set(arg, value);
      i++;
    } else if (BOOL_FLAGS.has(arg)) {
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
const clientMessageIdFor = (requestId: string): string => `cli-${requestDigest(requestId).slice(0, 24)}`;

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
      reply.canTakeOver ? "人に伝える（利用者がアプリで開き直せる）" : "人に伝える",
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
      if (reply.error !== undefined && /before delivery completed/.test(reply.error)) {
        // 届ける前に会話が終わった（利用者の終了・片付け）。打ち直しは会話を続きから起動して送る（4 周目 中1）。
        // 打ち込みの途中で終わった場合は Claude が受け付けていることもある。打ち直しは会話の記録を見てから送る。
        throw new ChatError(EXIT.retryLater, "conversation_ended", `届ける途中で会話が終わりました（届いていない可能性が高い）: ${reply.error}`,
          "同じ依頼 ID で打ち直す（届いていれば送り直さず、届いていなければ会話を続きから起動して送る）");
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
  })) };
}

/** Tailii の会話名がいま動いているか（`session_list_request` の alive。ページをたどる）。 */
async function sessionAlive(engine: EngineConnection, session: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const id = newId();
    const reply = await engine.request({ type: "session_list_request", v: 2, id, ...(cursor !== undefined ? { cursor } : {}) },
      isType("session_list_response", id), 30_000);
    if (reply.type !== "session_list_response") throw engineFailure(reply, "会話の確認");
    const found = reply.sessions.find((entry) => entry.name === session);
    if (found !== undefined) return found.alive;
    if (reply.nextCursor === undefined) return false;
    cursor = reply.nextCursor;
  }
  return false;
}

/** 依頼の発話が会話の記録に残っているか（届いていたか）。 */
function utteranceRecorded(deps: ChatDeps, record: RequestRecord): boolean {
  const transcriptOf = deps.transcript ?? ((id: string, cwdHint?: string) =>
    findTranscript(id, { store: deps.store(), ...(cwdHint !== undefined ? { cwdHint } : {}) }));
  const transcript = record.conversationId === "" ? null : transcriptOf(record.conversationId, record.cwd);
  if (transcript === null) return false;
  return readReply(readTranscriptLines(transcript.file), { sentAtMs: record.sentAtMs, text: record.text }).found;
}

function readPrompt(deps: ChatDeps, required: boolean): string | null {
  const text = deps.readStdin();
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
  textHash: string | null }): void {
  const differs = record.kind !== expect.kind ||
    (expect.cwd !== undefined && record.cwd !== expect.cwd) ||
    (expect.conversationId !== undefined && record.conversationId !== "" && record.conversationId !== expect.conversationId) ||
    (expect.textHash !== null && record.textHash !== undefined && record.textHash !== expect.textHash);
  if (differs) {
    throw new ChatError(EXIT.usage, "request_id_reused", "この依頼 ID は別の依頼で使われています（依頼ごとに新しい ID を使う）");
  }
}

function withConversation(error: unknown, record: RequestRecord): unknown {
  const extra = { requestId: record.requestId, conversationId: record.conversationId, session: record.session };
  if (error instanceof ChatError) return new ChatError(error.exitCode, error.code, error.message, error.hint, { ...error.extra, ...extra });
  if (error instanceof EngineTimeoutError) {
    const unknown = unknownDelivery(error.message);
    return new ChatError(unknown.exitCode, unknown.code, unknown.message, unknown.hint, extra);
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
    session = (await startSession(engine, {
      cwd: row.cwd, name: sessionNameFor(`${record.requestId}:${record.conversationId}`), resumeSessionId: record.conversationId,
      agentType: "claude", peerCheck: true,
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
    status = await sendText(engine, record.session, clientMessageIdFor(record.requestId), record.text);
  } catch (error) {
    // 人に回した依頼は記録に印を残す（打ち直しで届いたか分からない送信を送り直さない。5 周目レビュー 1）。
    if (error instanceof ChatError && error.code === "needs_human") write({ ...record, state: "started", needsHuman: true });
    // 送信の段階の失敗にも会話 ID と会話名を載せる（status --after で確かめられるように。2 周目レビュー 2）。
    throw withConversation(error, record);
  }
  write({ ...record, state: "sent" });
  return status;
}

async function cmdNew(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown> & { attach?: string }> {
  if (args.positional.length > 0) {
    throw new ChatError(EXIT.usage, "unexpected_argument", "new は会話 ID を受け取りません（続きを送るなら chat send）");
  }
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
  const attach = !bot && !args.flags.has("--no-attach");
  const prompt = readPrompt(deps, !attach);
  const requestId = requestIdOf(args, bot);
  const resolvedCwd = fs.realpathSync(cwd);
  const textHash = prompt === null ? null : hashText(prompt);
  return withRequestLock(deps, requestId, () =>
    newLocked({ deps, requestId, resolvedCwd, textHash, prompt, attach, permissionMode, title: flagString(args, "--title") }));
}

async function newLocked(input: {
  deps: ChatDeps; requestId: string; resolvedCwd: string; textHash: string | null; prompt: string | null; attach: boolean;
  permissionMode: string | undefined; title: string | undefined;
}): Promise<Record<string, unknown> & { attach?: string }> {
  const { deps, requestId, resolvedCwd, textHash, prompt, attach, permissionMode, title } = input;
  const previous = (deps.readRequest ?? readRequest)(requestId);
  if (previous !== null) assertSameRequest(previous, { kind: "new", cwd: resolvedCwd, textHash });
  // state の無い記録は 31f97bc の旧形式で、送信済み（3 周目レビュー 6）。
  if (previous !== null && (previous.state === undefined || previous.state === "sent")) {
    return { duplicate: true, requestId, conversationId: previous.conversationId, session: previous.session, cwd: previous.cwd,
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
        ...(textHash !== null ? { textHash } : {}), state: "starting",
      });
      try {
        started = await startSession(engine, {
          cwd: resolvedCwd, name, agentType: "claude",
          ...(permissionMode !== undefined ? { permissionMode } : {}),
          ...(title !== undefined ? { title } : {}),
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
    };
    // 送信が未確定の記録は、指示文なしで打ち直されても送信済みにしない（記録の本文で打ち直す。6 周目 補足）。
    if (prompt === null && !(previous !== null && previous.state === "started")) {
      writeReq({ ...record, state: "sent" });
      return started;
    }
    let toSend = record;
    if (previous !== null && previous.state === "started") {
      const revived = await retryStarted(engine, deps, record);
      if (revived.delivered) {
        writeReq({ ...record, state: "sent" });
        return started;
      }
      toSend = revived.record;
    }
    await sendRecorded(engine, deps, toSend);
    return { session: toSend.session, conversationId: started.conversationId };
  });
  return {
    requestId, conversationId: result.conversationId, session: result.session, cwd: resolvedCwd,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(attach ? { attach: result.session } : {}),
  };
}

async function cmdSend(args: ParsedArgs, deps: ChatDeps, bot: boolean): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  if (args.flags.has("--cwd")) throw new ChatError(EXIT.usage, "unexpected_cwd", "send は --cwd を受け取りません（会話のフォルダで続ける）");
  const prompt = readPrompt(deps, true)!;
  const requestId = requestIdOf(args, bot);
  const textHash = hashText(prompt);
  return withRequestLock(deps, requestId, () => sendLocked({ deps, requestId, conversationId, textHash, prompt }));
}

async function sendLocked(input: {
  deps: ChatDeps; requestId: string; conversationId: string; textHash: string; prompt: string;
}): Promise<Record<string, unknown>> {
  const { deps, requestId, conversationId, textHash, prompt } = input;
  const previous = (deps.readRequest ?? readRequest)(requestId);
  if (previous !== null) assertSameRequest(previous, { kind: "send", conversationId, textHash });
  if (previous !== null && previous.state !== "started" && previous.state !== "starting") {
    return { duplicate: true, requestId, conversationId, session: previous.session };
  }
  const config = deps.config();
  const session = await withEngine(deps, async (engine) => {
    let record = previous !== null && previous.state === "started" ? previous : null;
    if (record === null) {
      const rows = await listConversations(engine);
      const row = rows.find((entry) => entry.conversationId === conversationId);
      if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
      if (row.agent !== "claude") throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話への送信は未対応です");
      // 送る先の会話も、許可された作業フォルダの中だけ（止まっていればそのフォルダで起動するため。レビュー指摘 A7）。
      if (!folderAllowed(row.cwd, config.allowedRoots)) {
        throw new ChatError(EXIT.policy, "folder_not_allowed", `この会話の作業フォルダは許可されていません: ${row.cwd}`,
          "~/.tailii/bot.json の allowedRoots に入っている会話だけ送れる");
      }
      const live = row.liveSession ?? (await startSession(engine, {
        cwd: row.cwd, name: sessionNameFor(`${requestId}:${conversationId}`), resumeSessionId: conversationId,
        agentType: "claude", peerCheck: true,
      })).session;
      record = {
        requestId, kind: "send", conversationId, session: live, cwd: row.cwd, sentAtMs: deps.now(),
        text: deliverableText(prompt, requestId, deps), textHash,
      };
    } else {
      const revived = await retryStarted(engine, deps, record);
      if (revived.delivered) {
        (deps.writeRequest ?? writeRequest)({ ...record, state: "sent" });
        return record.session;
      }
      record = revived.record;
    }
    await sendRecorded(engine, deps, record);
    return record.session;
  });
  return { requestId, conversationId, session };
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
  if (after !== null && after.state === "starting") {
    throw new ChatError(EXIT.notFound, "request_not_started", "この依頼は会話の起動の途中で終わっています",
      "同じ依頼 ID で chat new を打ち直す（起動済みなら起動し直さずに続ける）");
  }
  if (afterId !== undefined && (after === null || after.conversationId !== conversationId)) {
    throw new ChatError(EXIT.notFound, "request_not_found", "この会話への依頼 ID の記録がありません（送る前に失敗した依頼は記録されない）");
  }
  const stateOf = deps.state ?? ((id: string) => conversationState(id));
  const transcriptOf = deps.transcript ?? ((id: string, cwdHint?: string) =>
    findTranscript(id, { store: deps.store(), ...(cwdHint !== undefined ? { cwdHint } : {}) }));
  const deadline = deps.now() + Math.min(waitSec, 100) * 1000;
  // 送信が未確定（started）の依頼は、届いたかを hub の受領の照会で確かめる（会話の記録だけでは、設問の表示中に保留された
  // 送信を「届いていない」と取り違える。2 周目レビュー 1）。sent は hub が注入の完了を返したもの。
  let delivery: string | undefined;
  if (after !== null) {
    delivery = after.state === "started" ? await queryDelivery(deps, after) : "delivered";
  }
  for (;;) {
    const state = stateOf(conversationId);
    const transcript = transcriptOf(conversationId, after?.cwd);
    if (transcript === null && after === null) {
      throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
    }
    const lines = transcript === null ? [] : readTranscriptLines(transcript.file);
    const read = readReply(lines, after !== null ? { sentAtMs: after.sentAtMs, text: after.text } : undefined);
    // 完了は待機（idle）か止まっている（not_running）で返答があるとき。承認・設問の入力待ち（waiting）と処理中は終わって
    // いない（レビュー指摘 A6・2 周目レビュー 3）。
    const complete = (state === "idle" || state === "not_running") && read.found && read.reply !== null;
    if (complete || deps.now() >= deadline) {
      return {
        conversationId, state, complete,
        ...(afterId !== undefined ? { after: afterId, received: read.found || delivery === "delivered", delivery } : {}),
        // 届いたか分からない送信で、この会話の後ろの送信が止まっている（記録に発話があっても hub は解かない）。
        // Bot には解けない（3 周目レビュー 2）。
        ...(delivery === "uncertain" || delivery === "blocked" || (after?.needsHuman === true && !read.found) ? { needsHuman: true, hint: NEEDS_HUMAN_HINT } : {}),
        reply: read.reply,
      };
    }
    await deps.sleep(1_000);
  }
}

// ---------------------------------------------------------------------------------------------------------------

const USAGE = `usage: tailii-host chat <list|new|send|status> [options]
  AI エージェント（Bot）は tailii-host agent-guide を読んで、必ず --json を付ける。
  端末が無い（パイプで指示を渡すなど）ときは Bot として扱い、--request-id が要る。
  list [--live] [--json]
  new --cwd <フォルダ> [--request-id <ID>] [--title <名前>] [--permission-mode <mode>] [--no-attach] [--json]  < 指示文
  send <conversationId> [--request-id <ID>] [--json]  < 指示文
  status <conversationId> [--after <依頼ID>] [--wait <秒>] [--json]
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
    const args = parseArgs(rest);
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
      deps.write(`エラー: ${failure.message}${failure.hint !== undefined ? `\n→ ${failure.hint}` : ""}\n`);
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
    readStdin: () => {
      if (process.stdin.isTTY) return null;
      try {
        return fs.readFileSync(0, "utf8");
      } catch {
        return null;
      }
    },
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    config: () => loadBotConfig(),
    store: getStore,
    write: (text) => { buffered += text; },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

export async function runAgentGuideCommand(): Promise<number> {
  await new Promise<void>((resolve) => process.stdout.write(AGENT_GUIDE, () => resolve()));
  return 0;
}
