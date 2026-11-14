// commands/chat/chatCommand.ts
// `tailii-host chat <list|new|send|status>`（tailii-chat-cli）。AI エージェント（Bot）が SSH で叩く前提の、対話なしで
// 完結するコマンド。`--json` で JSON 1 個と終了コードを返す。人が端末で打つときは `new` が会話の画面を開く。
// 会話の起動・送信は engine を子プロセスで起動してアプリと同じ要求を送る（engineClient.ts）。状態は直接読む（chatState.ts）。

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
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

function requestIdOf(args: ParsedArgs, json: boolean): string {
  const id = flagString(args, "--request-id");
  if (id !== undefined) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new ChatError(EXIT.usage, "bad_request_id", "依頼 ID は英数字と _ . : - で 128 文字まで");
    return id;
  }
  if (json) throw new ChatError(EXIT.usage, "missing_request_id", "--request-id が要ります（同じ ID の打ち直しで二重にならない）");
  return randomUUID();
}

/** 依頼 ID から会話名・送信 ID を決める（打ち直しても同じ）。 */
const sessionNameFor = (requestId: string): string => `s-${requestDigest(requestId).slice(0, 8)}`;
const clientMessageIdFor = (requestId: string): string => `cli-${requestDigest(requestId).slice(0, 24)}`;

function newId(): string {
  return `cli-${randomUUID()}`;
}

function isType<T extends ControlMessage["type"]>(type: T, id: string) {
  return (message: ControlMessage): message is Extract<ControlMessage, { type: T }> =>
    message.type === type && "id" in message && message.id === id;
}

function engineFailure(reply: ControlMessage, what: string): ChatError {
  if (reply.type === "error") {
    const retry = /launch_failed|tmux_error|claim|起動中/.test(`${reply.code} ${reply.message}`);
    return new ChatError(retry ? EXIT.retryLater : EXIT.internal, reply.code, reply.message,
      retry ? "少し待って同じ依頼 ID で打ち直す" : undefined);
  }
  return new ChatError(EXIT.internal, "unexpected_reply", `${what}: 想定外の応答（${reply.type}）`);
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
    engine.close();
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
  const info = reply.sessions.find((entry) => entry.name === adopted) ?? reply.sessions[0];
  if (adopted === undefined || info === undefined) throw new ChatError(EXIT.internal, "no_session", "起動した会話を確かめられませんでした");
  return { session: adopted, conversationId: info.providerSessionId ?? info.claudeSessionId ?? null };
}

/** 送信（chat_send）。hub が送信の確定まで行い、同じ clientMessageId の二重送信は弾く。 */
async function sendText(engine: EngineConnection, session: string, clientMessageId: string, text: string): Promise<"accepted" | "duplicate"> {
  const id = newId();
  const reply = await engine.request({ type: "chat_send", v: 2, id, session, clientMessageId, text },
    isType("chat_send_result", id), 100_000);
  if (reply.type !== "chat_send_result") throw engineFailure(reply, "送信");
  if (reply.status === "failed") {
    throw new ChatError(EXIT.retryLater, "send_failed", `送信を確定できませんでした${reply.error ? `: ${reply.error}` : ""}`,
      "少し待って同じ依頼 ID で打ち直す");
  }
  return reply.status;
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
  const id = newId();
  const reply = await engine.request({ type: "claude_session_list_request", v: 2, id },
    isType("claude_session_list_response", id), 60_000);
  if (reply.type !== "claude_session_list_response") throw engineFailure(reply, "一覧");
  return reply.claudeSessions.map((row) => ({
    conversationId: row.sessionId,
    agent: row.agent ?? "claude",
    title: row.title,
    cwd: row.cwd,
    ...(row.updatedAt !== undefined ? { updatedAtMs: row.updatedAt * 1000 } : {}),
    ...(row.liveSessionName !== undefined ? { liveSession: row.liveSessionName } : {}),
    elsewhere: row.liveSessionName === undefined && row.peerSessionName !== undefined,
  }));
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

async function cmdNew(args: ParsedArgs, deps: ChatDeps, json: boolean): Promise<Record<string, unknown> & { attach?: string }> {
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
  if (json && requestedMode === "auto" && !config.allowAuto) {
    throw new ChatError(EXIT.policy, "auto_not_allowed", "auto（何でも許可）は Bot に許されていません",
      "利用者が ~/.tailii/bot.json の allowAuto を true にしたときだけ使える");
  }
  const permissionMode = requestedMode ?? (json ? config.permissionMode : undefined);
  const attach = !json && deps.isTty && !args.flags.has("--no-attach");
  const prompt = readPrompt(deps, !attach);
  const requestId = requestIdOf(args, json);
  const readReq = deps.readRequest ?? readRequest;
  const done = readReq(requestId);
  if (done !== null) {
    return { duplicate: true, requestId, conversationId: done.conversationId, session: done.session, cwd: done.cwd,
      ...(attach ? { attach: done.session } : {}) };
  }
  const resolvedCwd = fs.realpathSync(cwd);
  const name = sessionNameFor(requestId);
  const title = flagString(args, "--title");
  const result = await withEngine(deps, async (engine) => {
    const started = await startSession(engine, {
      cwd: resolvedCwd, name, agentType: "claude",
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(title !== undefined ? { title } : {}),
    });
    const sentAtMs = deps.now();
    if (prompt !== null) await sendText(engine, started.session, clientMessageIdFor(requestId), prompt);
    return { ...started, sentAtMs };
  });
  if (result.conversationId === null) throw new ChatError(EXIT.internal, "no_conversation_id", "会話 ID を確かめられませんでした");
  if (prompt !== null) {
    const record: RequestRecord = {
      requestId, kind: "new", conversationId: result.conversationId, session: result.session, cwd: resolvedCwd,
      sentAtMs: result.sentAtMs, text: prompt,
    };
    (deps.writeRequest ?? writeRequest)(record);
  }
  return {
    requestId, conversationId: result.conversationId, session: result.session, cwd: resolvedCwd,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(attach ? { attach: result.session } : {}),
  };
}

async function cmdSend(args: ParsedArgs, deps: ChatDeps, json: boolean): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  if (args.flags.has("--cwd")) throw new ChatError(EXIT.usage, "unexpected_cwd", "send は --cwd を受け取りません（会話のフォルダで続ける）");
  const prompt = readPrompt(deps, true)!;
  const requestId = requestIdOf(args, json);
  const done = (deps.readRequest ?? readRequest)(requestId);
  if (done !== null) {
    if (done.conversationId !== conversationId) {
      throw new ChatError(EXIT.usage, "request_id_reused", "この依頼 ID は別の会話で使われています（依頼ごとに新しい ID を使う）");
    }
    return { duplicate: true, requestId, conversationId, session: done.session };
  }
  const result = await withEngine(deps, async (engine) => {
    const rows = await listConversations(engine);
    const row = rows.find((entry) => entry.conversationId === conversationId);
    if (row === undefined) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
    if (row.agent !== "claude") throw new ChatError(EXIT.policy, "unsupported_agent", "Codex の会話への送信は未対応です");
    const session = row.liveSession ?? (await startSession(engine, {
      cwd: row.cwd, name: sessionNameFor(`${requestId}:${conversationId}`), resumeSessionId: conversationId,
      agentType: "claude", peerCheck: true,
    })).session;
    const sentAtMs = deps.now();
    await sendText(engine, session, clientMessageIdFor(requestId), prompt);
    return { session, cwd: row.cwd, sentAtMs };
  });
  (deps.writeRequest ?? writeRequest)({
    requestId, kind: "send", conversationId, session: result.session, cwd: result.cwd, sentAtMs: result.sentAtMs, text: prompt,
  });
  return { requestId, conversationId, session: result.session };
}

async function cmdStatus(args: ParsedArgs, deps: ChatDeps): Promise<Record<string, unknown>> {
  const conversationId = requireConversationId(args);
  const afterId = flagString(args, "--after");
  const waitRaw = flagString(args, "--wait");
  const waitSec = waitRaw === undefined ? 0 : Number(waitRaw);
  if (!Number.isFinite(waitSec) || waitSec < 0) throw new ChatError(EXIT.usage, "bad_wait", "--wait は 0 以上の秒数");
  const after = afterId !== undefined ? (deps.readRequest ?? readRequest)(afterId) : null;
  if (afterId !== undefined && (after === null || after.conversationId !== conversationId)) {
    throw new ChatError(EXIT.notFound, "request_not_found", "この会話への依頼 ID が見つかりません");
  }
  const stateOf = deps.state ?? ((id: string) => conversationState(id));
  const transcriptOf = deps.transcript ?? ((id: string, cwdHint?: string) =>
    findTranscript(id, { store: deps.store(), ...(cwdHint !== undefined ? { cwdHint } : {}) }));
  const deadline = deps.now() + Math.min(waitSec, 100) * 1000;
  for (;;) {
    const state = stateOf(conversationId);
    const transcript = transcriptOf(conversationId, after?.cwd);
    if (transcript === null && after === null) {
      throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません", "tailii-host chat list --json で確かめる");
    }
    const lines = transcript === null ? [] : readTranscriptLines(transcript.file);
    const read = readReply(lines, after !== null ? { sentAtMs: after.sentAtMs, text: after.text } : undefined);
    const complete = state !== "busy" && read.found && read.reply !== null;
    if (complete || deps.now() >= deadline) {
      return {
        conversationId, state, complete,
        ...(afterId !== undefined ? { after: afterId, received: read.found } : {}),
        reply: read.reply,
      };
    }
    await deps.sleep(1_000);
  }
}

// ---------------------------------------------------------------------------------------------------------------

const USAGE = `usage: tailii-host chat <list|new|send|status> [options]
  AI エージェント（Bot）は tailii-host agent-guide を読んで、必ず --json を付ける。
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
        const payload = await cmdNew(args, deps, json);
        const { attach, ...rest2 } = payload;
        if (attach !== undefined) {
          deps.write(`会話を始めました: ${rest2["conversationId"]}（画面を閉じても会話は続きます）\n`);
          return deps.attach(attach);
        }
        render(deps, json, rest2, `会話を始めました: ${rest2["conversationId"]}`);
        return EXIT.ok;
      }
      case "send": {
        const payload = await cmdSend(args, deps, json);
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
  return runChat(argv, {
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
    write: (text) => process.stdout.write(text),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attach: (session) => attachSession(session, getStore()),
  });
}

export function runAgentGuideCommand(): number {
  process.stdout.write(AGENT_GUIDE);
  return 0;
}
