// commands/chat/chatRead.ts
// `tailii-host chat read / search`（tailii-chat-cli）: 会話の記録を、必要な範囲だけ読む・語で探す。読み取り専用で、
// 会話を起動せず engine も通さない（記録のファイルと、hub・このコマンドが残した記録だけを読む）。
// 純粋な部品（記録 → 要素の列 → 出所の判定 → 範囲の切り出し・検索）を置き、コマンドの組み立ては chatCommand.ts。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isVisibleCodexMessagePhase } from "../../codex/codexMessagePhase.js";
import { isInvisibleCodePoint } from "../../shared/invisibleText.js";
import { unwrapPastedContent } from "../../shared/pastedContent.js";
import {
  clientMessageIdFor,
  forEachFileLine,
  forEachRolloutLine,
  itemText,
  normalizeForReplyMatch,
  requestsDir,
  textOf,
  utteranceOrigin,
  type RequestRecord,
} from "./chatState.js";
import {
  defaultChatDeliveryLogPath,
  parseChatDeliveryLine,
  utteranceDigest,
  type ChatDeliveryRecord,
} from "../../hub/chatDeliveryLog.js";

// ---- 要素 ----

/**
 * 発話の出所。`confidence` は根拠の強さ: `exact` = その発話自身に結び付く記録がある（依頼の記録の本文・発話に付いた
 * 送信 ID・記録の印）/ `inferred` = 時刻の突き合わせによる推定。`unknown` は決め手が無い（推測で埋めない）。
 */
export interface MessageSource {
  /**
   * cli = `tailii-host chat` から / app = Tailii のアプリから（hub の送信）/ terminal = hub を通らず端末の画面へ直接 /
   * peer = 別のセッションから届いた / system = 人の発話ではない記録（中断の印・圧縮の要約・予約した再開）/ unknown = 判定できない。
   */
  kind: "cli" | "app" | "terminal" | "peer" | "system" | "unknown";
  confidence?: "exact" | "inferred";
  /** cli: その送信の依頼 ID（依頼の記録が残っているとき）。 */
  requestId?: string;
  /** peer: 送り主のセッションの名前。 */
  name?: string;
  /** system: `interrupted`（利用者が処理を中断した印）/ `compact_summary`（圧縮で作られた要約）/ `scheduled`（予約した再開のプロンプト）。 */
  detail?: string;
  /** unknown: 端末の画面ではない入口の印（`sdk-ts`・`claude-desktop` など）。 */
  entrypoint?: string;
}

/** 会話の 1 要素（人の発話か、エージェントの文章の 1 かたまり）。古い順の列の中の位置が `seq`。 */
export interface ChatElement {
  role: "user" | "assistant";
  text: string;
  atMs: number;
  /** 送った側の発話 ID（Codex の `client_id`）。 */
  clientId?: string;
  /** その文章を作ったモデル（assistant。分かるときだけ）。 */
  model?: string;
  /** 出所（user だけ。`resolveSources` が埋める）。 */
  source?: MessageSource;
  /** 記録の印だけで決まった出所（peer / system）。 */
  fixed?: MessageSource;
  /** Claude の記録の `entrypoint`（`cli` = 端末の画面。SDK やデスクトップアプリは別の値）。 */
  entrypoint?: string;
  /** 処理中に打たれて待たされ、ターンの切れ目で流れた発話（`promptSource: "queued"`。記録の時刻は流れた時刻）。 */
  deferred?: boolean;
  /** 処理中に送られて、そのターンの途中で取り込まれた発話（attachment(queued_command) にだけ残る。記録の時刻は打たれた時刻）。 */
  midTurn?: boolean;
  /** 端末の画面への打ち込みではないと記録の印で分かる（`promptSource` が typed / queued / suggestion_accepted 以外）。 */
  untyped?: boolean;
}

/** 端末の画面で人が入れた発話の `promptSource`（打った・待たされた・提案を受け入れた）。印が無い旧い記録も人の入力として扱う。 */
const TYPED_PROMPT_SOURCES: ReadonlySet<unknown> = new Set([undefined, "typed", "queued", "suggestion_accepted"]);

const INTERRUPTED = /^\[Request interrupted by user/;

function timestampMs(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

const peerSource = (name: string | undefined): MessageSource =>
  ({ kind: "peer", confidence: "exact", ...(name !== undefined ? { name } : {}) });

/**
 * Claude の会話の記録を、read / search の要素の列（古い順）にする。読めなければ null。
 * 入れるもの: 人の発話（処理中に送って attachment(queued_command) だけに残るものも）・エージェントの文章・別のセッションから
 * 届いた発話（peer）・中断の印・圧縮の要約・予約した再開のプロンプト。入れないもの: ほかのメタ行・サイドチェーン・ツールの結果・コマンドの記録と注入・
 * 背景タスクの通知・サブエージェントの報告（どちらも、処理中に届くと queued_command に残る）。
 */
export function readClaudeElements(file: string): ChatElement[] | null {
  const out: ChatElement[] = [];
  const readable = forEachFileLine(file, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (obj["isSidechain"] === true) return;
    const type = obj["type"];
    const atMs = timestampMs(obj["timestamp"]);
    const entrypoint = typeof obj["entrypoint"] === "string" ? obj["entrypoint"] : undefined;
    const withEntrypoint = entrypoint !== undefined ? { entrypoint } : {};
    if (type === "attachment") {
      if (obj["isMeta"] === true) return;
      const attachment = obj["attachment"] as { type?: unknown; prompt?: unknown; origin?: unknown; commandMode?: unknown } | undefined;
      if (attachment?.type !== "queued_command" || typeof attachment.prompt !== "string") return;
      const text = unwrapPastedContent(attachment.prompt).trim();
      if (text.length === 0) return;
      const origin = utteranceOrigin(attachment.origin, text);
      if (origin.kind === "injected" || attachment.commandMode === "task-notification") return;
      if (origin.kind === "peer") {
        out.push({ role: "user", text, atMs, fixed: peerSource(origin.name) });
        return;
      }
      out.push({ role: "user", text, atMs, ...withEntrypoint, midTurn: true });
      return;
    }
    if (type === "assistant") {
      const message = obj["message"] as { content?: unknown; model?: unknown } | undefined;
      const text = textOf(message?.content).trim();
      if (text.length === 0) return;
      const model = typeof message?.model === "string" && message.model.length > 0 && message.model !== "<synthetic>"
        ? message.model : undefined;
      out.push({ role: "assistant", text, atMs, ...(model !== undefined ? { model } : {}) });
      return;
    }
    if (type !== "user") return;
    const message = obj["message"] as { content?: unknown } | undefined;
    const text = unwrapPastedContent(textOf(message?.content).trim()).trim();
    if (text.length === 0) return;
    const origin = utteranceOrigin(obj["origin"], text);
    if (origin.kind === "injected") return;
    // 別のセッションから届いた発話は、待機中に届くとメタ行（isMeta）として残る。
    if (origin.kind === "peer") {
      out.push({ role: "user", text, atMs, fixed: peerSource(origin.name) });
      return;
    }
    // 予約した再開（ScheduleWakeup・/loop・CronCreate の発火）のプロンプトはメタ行として残る。人の発話ではないが、
    // そこからターンが始まったことが分かるように入れる（アプリも注記として出す）。
    if (obj["turnOrigin"] === "scheduled" || (obj["isMeta"] === true && typeof obj["scheduledTaskId"] === "string")) {
      out.push({ role: "user", text, atMs, fixed: { kind: "system", confidence: "exact", detail: "scheduled" } });
      return;
    }
    if (obj["isMeta"] === true) return;
    if (obj["isCompactSummary"] === true) {
      out.push({ role: "user", text, atMs, fixed: { kind: "system", confidence: "exact", detail: "compact_summary" } });
      return;
    }
    if (INTERRUPTED.test(text)) {
      out.push({ role: "user", text, atMs, fixed: { kind: "system", confidence: "exact", detail: "interrupted" } });
      return;
    }
    out.push({
      role: "user", text, atMs, ...withEntrypoint,
      ...(obj["promptSource"] === "queued" ? { deferred: true } : {}),
      ...(TYPED_PROMPT_SOURCES.has(obj["promptSource"]) ? {} : { untyped: true }),
    });
  });
  // 途中までしか読めなかった記録は、欠けた列を返さない。
  return readable ? out : null;
}

const ROLLOUT_ELEMENT_TYPES: ReadonlySet<string> = new Set(["event_msg", "turn_context"]);

/**
 * Codex の rollout を、read / search の要素の列（古い順）と処理中か（最後の turn が終わっていない）にする。読めなければ null。
 * 取り込む範囲は chatState.ts の `readCodexRollout` と同じ（思考・ツール・内部の区分は除く）。
 */
export function readCodexElements(file: string): { elements: ChatElement[]; busy: boolean } | null {
  const out: ChatElement[] = [];
  let busy = false;
  let model: string | undefined;
  const readable = forEachRolloutLine(file, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const payload = obj["payload"] as Record<string, unknown> | undefined;
    if (payload === undefined) return;
    if (obj["type"] === "turn_context") {
      if (typeof payload["model"] === "string" && payload["model"].length > 0) model = payload["model"];
      return;
    }
    if (obj["type"] !== "event_msg") return;
    if (payload["type"] === "task_started") { busy = true; return; }
    if (payload["type"] === "task_complete" || payload["type"] === "turn_aborted") { busy = false; return; }
    const atMs = timestampMs(obj["timestamp"]);
    const withModel = model !== undefined ? { model } : {};
    if (payload["type"] === "item_completed") {
      const item = payload["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "UserMessage") {
        const text = itemText(item["content"], "text").trim();
        const clientId = typeof item["client_id"] === "string" && item["client_id"].length > 0 ? item["client_id"] : undefined;
        if (text.length > 0) out.push({ role: "user", text, atMs, ...(clientId !== undefined ? { clientId } : {}) });
      } else if (item?.["type"] === "AgentMessage" && isVisibleCodexMessagePhase(item["phase"])) {
        const text = itemText(item["content"], "Text").trim();
        if (text.length > 0) out.push({ role: "assistant", text, atMs, ...withModel });
      }
    } else if (payload["type"] === "user_message" && typeof payload["message"] === "string") {
      const text = payload["message"].trim();
      if (text.length > 0) out.push({ role: "user", text, atMs });
    } else if (payload["type"] === "agent_message" && typeof payload["message"] === "string" &&
      isVisibleCodexMessagePhase(payload["phase"])) {
      const text = payload["message"].trim();
      if (text.length > 0) out.push({ role: "assistant", text, atMs, ...withModel });
    }
  }, { types: ROLLOUT_ELEMENT_TYPES });
  return readable ? { elements: out, busy } : null;
}

// ---- 出所の判定の材料 ----

/** hub へ届いた送信 1 件（engine の送信ログ `~/.tailii/chat-send.log` の `recv` 行と、その結果の行）。 */
export interface HubSend {
  session: string;
  clientMessageId: string;
  recvAtMs: number;
  /** 結果が返った時刻。結果の行が無ければ null（接続が切れた・まだ途中）。 */
  endAtMs: number | null;
  /** accepted / duplicate = 打ち込みが済んだ / failed = hub が失敗を返した / error = 問い合わせの失敗・時間切れ。 */
  status: "accepted" | "duplicate" | "failed" | "error" | null;
}

export interface HubSendLog {
  /** 古い順。 */
  sends: HubSend[];
  /** この記録が覆う最初の時刻（これより前の発話は、送信が無かったとは言えない）。 */
  coverageStartMs: number;
}

export function defaultSendLogPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "chat-send.log");
}

/** 送信ログから読む上限（末尾からこの大きさまで。これを超える古い分は読まない）。 */
const SEND_LOG_MAX_BYTES = 32 * 1024 * 1024;

const SEND_LOG_LINE = /^\[(\S+) pid=(\d+)\] (recv|result|failed) id=(\S+)(?: session=(\S+) cmid=(\S+)| status=(\S+))?/;

/**
 * engine の送信ログ（`engine/handlers/conversation.ts` の `chatSendDiag`）を読む。無い・読めないなら null。
 * 行の形: `[<ISO 時刻> pid=<pid>] recv id=<要求 ID> session=<会話名> cmid=<送信 ID>` と、その結果の
 * `… result id=<要求 ID> status=<accepted|duplicate|failed>` / `… failed id=<要求 ID> error=…`。
 * 要求 ID は接続ごとに振り直される（`send-1` など）ので、同じ pid の同じ要求 ID の「直前の recv」に結果を付ける。
 */
export function readHubSendLog(file: string = defaultSendLogPath()): HubSendLog | null {
  let raw: string;
  try {
    const size = fs.statSync(file).size;
    if (size <= SEND_LOG_MAX_BYTES) {
      raw = fs.readFileSync(file, "utf8");
    } else {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(SEND_LOG_MAX_BYTES);
        const read = fs.readSync(fd, buffer, 0, SEND_LOG_MAX_BYTES, size - SEND_LOG_MAX_BYTES);
        raw = buffer.subarray(0, read).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      // 途中から読んだ最初の行は欠けている。
      raw = raw.slice(raw.indexOf("\n") + 1);
    }
  } catch {
    return null;
  }
  const sends: HubSend[] = [];
  const open = new Map<string, HubSend>();
  let coverageStartMs = Number.POSITIVE_INFINITY;
  for (const line of raw.split("\n")) {
    const match = SEND_LOG_LINE.exec(line);
    if (match === null) continue;
    const atMs = Date.parse(match[1]!);
    if (!Number.isFinite(atMs)) continue;
    if (atMs < coverageStartMs) coverageStartMs = atMs;
    const key = `${match[2]}:${match[4]}`;
    if (match[3] === "recv") {
      if (match[5] === undefined || match[6] === undefined) continue;
      const send: HubSend = { session: match[5], clientMessageId: match[6], recvAtMs: atMs, endAtMs: null, status: null };
      sends.push(send);
      open.set(key, send);
      continue;
    }
    const send = open.get(key);
    if (send === undefined) continue;
    open.delete(key);
    send.endAtMs = atMs;
    send.status = match[3] === "failed" ? "error"
      : match[7] === "accepted" || match[7] === "duplicate" || match[7] === "failed" ? match[7] : "error";
  }
  if (!Number.isFinite(coverageStartMs)) return null;
  sends.sort((left, right) => left.recvAtMs - right.recvAtMs);
  return { sends, coverageStartMs };
}

export function defaultChatReceiptsPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "hub", "chat-receipts.json");
}

/**
 * hub の配送済みの台帳（`~/.tailii/hub/chat-receipts.json`）にある送信 ID（Claude・Codex・片付けた会話の分）。
 * 台帳は 30 日で消える。無い・読めないなら空。
 */
export function readHubDeliveredIds(file: string = defaultChatReceiptsPath()): Set<string> {
  const ids = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return ids;
  }
  if (typeof parsed !== "object" || parsed === null) return ids;
  const root = parsed as { sessions?: unknown; retiredChatDeliveredAtMs?: unknown };
  if (typeof root.sessions === "object" && root.sessions !== null) {
    for (const state of Object.values(root.sessions as Record<string, unknown>)) {
      if (typeof state !== "object" || state === null) continue;
      for (const key of ["delivered", "deliveredCodex"] as const) {
        const list = (state as Record<string, unknown>)[key];
        if (!Array.isArray(list)) continue;
        for (const id of list) if (typeof id === "string") ids.add(id);
      }
    }
  }
  if (typeof root.retiredChatDeliveredAtMs === "object" && root.retiredChatDeliveredAtMs !== null) {
    for (const id of Object.keys(root.retiredChatDeliveredAtMs)) ids.add(id);
  }
  return ids;
}

/**
 * hub が届けた発話の記録（`~/.tailii/hub/chat-deliveries.ndjson`。追記だけで消えない）を古い順に読む。無ければ空。
 * この記録を書く版の hub が動き始めてからの分だけがある。
 */
export function readChatDeliveries(file: string = defaultChatDeliveryLogPath()): ChatDeliveryRecord[] {
  const out: ChatDeliveryRecord[] = [];
  const readable = forEachFileLine(file, (line) => {
    const record = parseChatDeliveryLine(line);
    if (record !== null) out.push(record);
  });
  return readable ? out.sort((left, right) => left.atMs - right.atMs) : [];
}

/** その会話への発話の依頼の記録（new / send。古い順）。 */
export function findConversationRequests(conversationId: string, dir: string = requestsDir()): RequestRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RequestRecord[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<RequestRecord>;
      if (raw.conversationId !== conversationId || (raw.kind !== "new" && raw.kind !== "send")) continue;
      if (typeof raw.requestId !== "string" || typeof raw.text !== "string" || typeof raw.sentAtMs !== "number") continue;
      out.push(raw as RequestRecord);
    } catch {
      // 壊れた記録は飛ばす。
    }
  }
  return out.sort((left, right) => left.sentAtMs - right.sentAtMs);
}

// ---- 出所の判定 ----

export interface SourceContext {
  agent: "claude" | "codex";
  conversationId: string;
  /** その会話への依頼の記録（`findConversationRequests`）。 */
  requests: readonly RequestRecord[];
  /** その会話を収容した Tailii の会話名（メタから）。 */
  sessions: readonly string[];
  /** hub の送信の記録。無ければ null（アプリ・端末の判定はしない）。 */
  hub: HubSendLog | null;
  /** hub の配送済みの台帳の送信 ID（Codex の発話の ID の裏付け）。 */
  deliveredIds: ReadonlySet<string>;
  /** hub が届けた発話の記録（`readChatDeliveries`）。本文のハッシュで、発話と送信を結び付ける。 */
  deliveries: readonly ChatDeliveryRecord[];
}

/** 届けた発話の記録の時刻より、会話の記録の発話がどこまで前にありうるか（打ち込みから、届いたのを確かめるまでの長さ）。 */
const DELIVERY_LEAD_MS = 120_000;

/**
 * 記録の時刻が、hub が送信を受けてから結果を返すまでの間（と前後のゆとり）に入れば、その送信の発話とみなす。
 * 実測（2026-11-18・直近 12 日・約 1,600 発話）: 記録の時刻は recv の 0.06〜数秒後、結果の 0.2〜0.5 秒前（結果より後でも 3 秒以内）。
 * recv より前になった例は無い（hub が受けてから打ち込むので、記録が先になることはない）。前のゆとりは時計の刻みの分だけ。
 */
const BEFORE_RECV_MS = 250;
const AFTER_RESULT_MS = 3_000;
/** 結果の行が無い送信を、ここまでは続いていたとみなす（engine の問い合わせの上限 90 秒 + ゆとり）。 */
const OPEN_SEND_MS = 100_000;

const CLI_MESSAGE_ID = /^cli-[0-9a-f]{24}$/;
/** アプリ（iOS）の送信 ID は大文字の UUID。host が自分で振る ID は小文字（`randomUUID()`）。 */
const APP_MESSAGE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

function inSendWindow(send: HubSend, atMs: number): boolean {
  return atMs >= send.recvAtMs - BEFORE_RECV_MS &&
    atMs <= (send.endAtMs ?? send.recvAtMs + OPEN_SEND_MS) + AFTER_RESULT_MS;
}

/** `recvAtMs` が `fromMs` 以上の最初の位置（`sends` は古い順）。 */
function lowerBound(sends: readonly HubSend[], fromMs: number): number {
  let low = 0;
  let high = sends.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sends[mid]!.recvAtMs < fromMs) low = mid + 1; else high = mid;
  }
  return low;
}

/**
 * 各 user 要素に出所を付ける（要素を書き換える）。判定の順:
 *  1. 記録の印で決まるもの（peer / system）。
 *  2. Codex: 発話に付いた送信 ID（`client_id`）。`cli-…` は cli、アプリの形の ID は app（hub の台帳にあれば exact）。
 *  3. Claude: hub が届けた発話の記録と本文のハッシュが一致する発話は、送信 ID の形で app か cli（exact）。
 *  3b. Claude: 依頼の記録の本文と一致する発話は cli（送信が受け付けられた記録なら exact）。
 *  4. Claude: 残りの端末の画面で受けた発話は、hub の送信の記録と時刻で突き合わせる。その会話の会話名への送信に当たれば
 *     app（送信 ID が `cli-…` なら cli）、どの会話名への送信もその時刻に無ければ terminal。どちらとも言えなければ unknown。
 */
export function resolveSources(elements: ChatElement[], context: SourceContext): void {
  const cliRequestByMessageId = new Map(context.requests.map((record) => [clientMessageIdFor(record.requestId), record.requestId]));
  const humans: ChatElement[] = [];
  // Codex は発話に送信 ID が残るので、届けた発話の記録（消えない）にその ID があれば、台帳（30 日）と同じく裏付けになる。
  const deliveredIds = context.agent === "codex" && context.deliveries.length > 0
    ? new Set([...context.deliveredIds, ...context.deliveries.map((record) => record.clientMessageId)])
    : context.deliveredIds;
  for (const element of elements) {
    if (element.role !== "user") continue;
    if (element.fixed !== undefined) { element.source = element.fixed; continue; }
    if (context.agent === "codex") {
      element.source = codexSource(element, cliRequestByMessageId, deliveredIds);
      continue;
    }
    humans.push(element);
  }
  if (context.agent === "codex" || humans.length === 0) return;

  const own = new Set(context.sessions);
  const ownSends = context.hub?.sends.filter((send) => own.has(send.session)) ?? [];
  const foreignSends = context.hub?.sends.filter((send) => !own.has(send.session)) ?? [];
  // 当て済みの送信 ID。同じ送信 ID の打ち直し（失敗の後の再送・届いた後の重複）は 1 つの送信なので、まとめて当て済みにする。
  const consumed = new Set<string>();

  // 3. hub が届けた発話の記録（本文のハッシュの一致）。この会話へ届けた記録（会話 ID が合う）か、この会話を収容した会話名へ
  // 届けた記録を使う。会話 ID だけに絞らないのは、`/clear` や開き直しの直後は hub の知っている会話 ID が古いことがあるため
  // （本文と時刻も合う発話がこの会話の記録にあることが条件なので、別の会話の発話を取り違えることはない）。
  const delivered = context.deliveries.filter((record) => record.agent === "claude" &&
    (record.conversationId === context.conversationId || own.has(record.session)));
  if (delivered.length > 0) {
    const digests = new Map<ChatElement, string>();
    const digestOf = (element: ChatElement): string => {
      let value = digests.get(element);
      if (value === undefined) { value = utteranceDigest(element.text); digests.set(element, value); }
      return value;
    };
    // 待たされた発話は、直近の「待機中に打たれてターンを始めた発話」より後に送られている。その時刻を先に求めておく。
    const turnStartOf = new Map<ChatElement, number>();
    let turnStartAtMs = Number.NEGATIVE_INFINITY;
    for (const element of humans) {
      turnStartOf.set(element, turnStartAtMs);
      if (element.deferred !== true && element.midTurn !== true && element.atMs > 0) turnStartAtMs = element.atMs;
    }
    for (const record of delivered) {
      if (consumed.has(record.clientMessageId)) continue;
      // 発話の記録は打ち込んだ時刻、届けた記録はそれを確かめた時刻（少し後）。待たされた発話だけは流れた時刻なので後に
      // なるが、届けたのはそのターンの間（ターンを始めた発話より後）。古い記録を、後の同じ本文の発話に当てない。
      const hit = humans.find((element) => element.source === undefined && element.untyped !== true &&
        (element.entrypoint === undefined || element.entrypoint === "cli") &&
        element.atMs >= record.atMs - DELIVERY_LEAD_MS &&
        (element.deferred === true ? record.atMs > turnStartOf.get(element)! : element.atMs <= record.atMs + AFTER_RESULT_MS) &&
        digestOf(element) === record.textHash);
      if (hit === undefined) continue;
      consumed.add(record.clientMessageId);
      if (CLI_MESSAGE_ID.test(record.clientMessageId)) {
        const requestId = cliRequestByMessageId.get(record.clientMessageId);
        hit.source = { kind: "cli", confidence: "exact", ...(requestId !== undefined ? { requestId } : {}) };
      } else {
        hit.source = { kind: "app", confidence: "exact" };
      }
    }
  }

  // 3b. 依頼の記録（本文の一致。`status --after` が依頼の発話を探すのと同じ照合）。hub の記録で決まった依頼は飛ばす
  // （hub の記録が無い頃の依頼と、届いたか確かめられていない依頼のため）。
  if (context.requests.length > 0) {
    const normalized = new Map<ChatElement, string>();
    const normalizedOf = (element: ChatElement): string => {
      let value = normalized.get(element);
      if (value === undefined) { value = normalizeForReplyMatch(element.text); normalized.set(element, value); }
      return value;
    };
    for (const record of context.requests) {
      if (consumed.has(clientMessageIdFor(record.requestId))) continue;
      const want = normalizeForReplyMatch(record.text);
      if (want.length === 0) continue;
      const hit = humans.find((element) => element.source === undefined && element.atMs >= record.sentAtMs && normalizedOf(element) === want);
      if (hit === undefined) continue;
      // 送信が受け付けられた記録（sent。旧記録は state が無い）は exact。届いたか確かめられていない記録（started・
      // needs_human）は、同じ本文を後から人が打っただけかもしれないので inferred。
      const confirmed = record.state === undefined || record.state === "sent";
      hit.source = { kind: "cli", confidence: confirmed ? "exact" : "inferred", requestId: record.requestId };
      consumed.add(clientMessageIdFor(record.requestId));
    }
  }

  // 4. hub の送信の記録との突き合わせ（古い順に、送信 1 件を発話 1 件にだけ当てる）。
  /** 直近の、待機中に打たれてターンを始めた人の発話の時刻（待たされた発話は、これより後に打たれている）。 */
  let lastTypedAtMs = Number.NEGATIVE_INFINITY;
  for (const element of humans) {
    if (element.source === undefined) element.source = hubSource(element, {
      hub: context.hub, ownSends, foreignSends, consumed, cliRequestByMessageId, lastTypedAtMs,
    });
    if (element.deferred !== true && element.midTurn !== true && element.atMs > 0) lastTypedAtMs = element.atMs;
  }
}

function codexSource(
  element: ChatElement,
  cliRequestByMessageId: ReadonlyMap<string, string>,
  deliveredIds: ReadonlySet<string>,
): MessageSource {
  const id = element.clientId;
  if (id === undefined) return { kind: "unknown" };
  if (CLI_MESSAGE_ID.test(id)) {
    const requestId = cliRequestByMessageId.get(id);
    return { kind: "cli", confidence: "exact", ...(requestId !== undefined ? { requestId } : {}) };
  }
  if (APP_MESSAGE_ID.test(id)) return { kind: "app", confidence: deliveredIds.has(id) ? "exact" : "inferred" };
  return { kind: "unknown" };
}

function hubSource(element: ChatElement, state: {
  hub: HubSendLog | null;
  ownSends: readonly HubSend[];
  foreignSends: readonly HubSend[];
  consumed: Set<string>;
  cliRequestByMessageId: ReadonlyMap<string, string>;
  lastTypedAtMs: number;
}): MessageSource {
  // 端末の画面ではない入口（SDK・デスクトップアプリ）は hub の送信を通らない。印だけ添えて、送り手は決めない。
  if (element.entrypoint !== undefined && element.entrypoint !== "cli") return { kind: "unknown", entrypoint: element.entrypoint };
  // 端末の画面でも、人の打ち込みではない入り方（記録の印が system など）は、時刻の突き合わせで送り手を決めない。
  if (element.untyped === true) return { kind: "unknown" };
  const atMs = element.atMs;
  if (state.hub === null || atMs <= 0) return { kind: "unknown" };
  // hub が失敗を返した送信は届いていない。重複（duplicate）は前の打ち込みの再送で、発話は前の送信の時刻に残っている。
  const usable = (send: HubSend): boolean =>
    !state.consumed.has(send.clientMessageId) && send.status !== "failed" && send.status !== "duplicate";
  // 待たされた発話の記録の時刻は、打ち込みの時刻ではなく流れた時刻。直近のターンを始めた発話より後で、まだ当てて
  // いない打ち込み済みの送信のうち、いちばん古いものを先に当てる（待ちは先入れ先出し。流れた時刻にたまたま重なった
  // 別の送信を先に取らない）。
  const deferredFromMs = state.lastTypedAtMs - BEFORE_RECV_MS;
  let hit = element.deferred === true
    ? state.ownSends.find((send) => usable(send) && send.status === "accepted" &&
      send.recvAtMs > deferredFromMs && send.recvAtMs <= atMs + BEFORE_RECV_MS)
    : undefined;
  hit ??= state.ownSends.find((send) => usable(send) && inSendWindow(send, atMs));
  if (hit !== undefined) {
    state.consumed.add(hit.clientMessageId);
    if (!CLI_MESSAGE_ID.test(hit.clientMessageId)) return { kind: "app", confidence: "inferred" };
    const requestId = state.cliRequestByMessageId.get(hit.clientMessageId);
    return { kind: "cli", confidence: "inferred", ...(requestId !== undefined ? { requestId } : {}) };
  }
  // この会話の会話名への送信には当たらない。同じ時刻に別の会話名への送信があれば、会話名の対応が失われているだけかも
  // しれない（会話名のメタが消えた・`/clear` で会話が分かれた）ので決めない。
  if (atMs < state.hub.coverageStartMs) return { kind: "unknown" };
  const fromMs = element.deferred === true ? deferredFromMs : atMs - OPEN_SEND_MS - AFTER_RESULT_MS;
  let foreign = false;
  for (let i = lowerBound(state.foreignSends, fromMs); i < state.foreignSends.length; i++) {
    const send = state.foreignSends[i]!;
    if (send.recvAtMs > atMs + BEFORE_RECV_MS) break;
    if (element.deferred === true || inSendWindow(send, atMs)) { foreign = true; break; }
  }
  return foreign ? { kind: "unknown" } : { kind: "terminal", confidence: "inferred" };
}

// ---- 出力の形 ----

/** 既定と上限（tailii-read-design-final.md 6 節）。 */
export const READ_LIMITS = {
  defaultCount: 10, maxCount: 50,
  /** 応答全体（JSON 1 行）の上限。 */
  responseBytes: 32 * 1024,
  /** 1 要素の本文の上限の既定・最小・最大（`--max-text`）。 */
  defaultTextBytes: 8 * 1024, minTextBytes: 256, maxTextBytes: 32 * 1024,
  defaultHits: 10, maxHits: 50,
  defaultContext: 2, maxContext: 5,
  /** search の前後に添える要素の本文の上限。 */
  contextTextBytes: 1024,
  maxQueryChars: 500,
} as const;

/** 応答の枠（会話 ID・件数・カーソルなど、要素以外）に残しておくバイト数。 */
const ENVELOPE_BYTES = 1024;

/** 本文を UTF-8 で `maxBytes` 以内に切る（文字の途中で切らない）。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true, bytes };
}

export interface OutputMessage {
  seq: number;
  role: "user" | "assistant";
  atMs: number;
  text: string;
  truncated?: true;
  /** 切る前の本文のバイト数（`truncated` のとき）。 */
  textBytes?: number;
  source?: MessageSource;
  model?: string;
  clientId?: string;
}

function outputMessage(element: ChatElement, seq: number, maxTextBytes: number): OutputMessage {
  const cut = truncateUtf8(element.text, maxTextBytes);
  return {
    seq, role: element.role, atMs: element.atMs, text: cut.text,
    ...(cut.truncated ? { truncated: true as const, textBytes: cut.bytes } : {}),
    ...(element.role === "user" && element.source !== undefined ? { source: element.source } : {}),
    ...(element.model !== undefined ? { model: element.model } : {}),
    ...(element.clientId !== undefined ? { clientId: element.clientId } : {}),
  };
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** 1 件だけで上限を超える要素を、収まるまで本文を切り詰める。 */
function fitMessage(element: ChatElement, seq: number, maxTextBytes: number, budget: number): OutputMessage {
  let limit = maxTextBytes;
  let message = outputMessage(element, seq, limit);
  while (jsonBytes(message) > budget && limit > 16) {
    limit = Math.max(16, Math.min(limit, Buffer.byteLength(message.text, "utf8")) - (jsonBytes(message) - budget) - 16);
    message = outputMessage(element, seq, limit);
  }
  return message;
}

/** カーソル（`<seq>` か `<seq>:<atMs>`）。 */
export interface Cursor { seq: number; atMs?: number }

export class ChatReadError extends Error {
  constructor(readonly code: "bad_cursor" | "stale_cursor", message: string) {
    super(message);
    this.name = "ChatReadError";
  }
}

export function parseCursor(raw: string): Cursor {
  const match = /^(\d{1,9})(?::(\d{1,16}))?$/.exec(raw);
  if (match === null) throw new ChatReadError("bad_cursor", `カーソルの形が違います: ${raw}（<seq> か <seq>:<atMs>）`);
  return { seq: Number(match[1]), ...(match[2] !== undefined ? { atMs: Number(match[2]) } : {}) };
}

export const formatCursor = (seq: number, atMs: number): string => `${seq}:${atMs}`;

/** カーソルが今の記録の同じ要素を指しているか（位置が記録の外・時刻が違えば、記録が組み替わっている）。 */
function checkCursor(elements: readonly ChatElement[], cursor: Cursor): void {
  const element = elements[cursor.seq];
  if (element === undefined || (cursor.atMs !== undefined && element.atMs !== cursor.atMs)) {
    throw new ChatReadError("stale_cursor", "カーソルが今の記録と合いません（記録が組み替わった・別の会話のカーソル）");
  }
}

export interface ReadRange {
  total: number;
  range: { from: number; to: number } | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** 続きを取るカーソル（`after` = 返した最後の要素・`before` = 返した最初の要素）。要素を返さなかったときは無い。 */
  cursors?: { before: string; after: string };
  messages: OutputMessage[];
}

/**
 * 範囲を切り出す。`last` = 末尾から / `after` = カーソルの次から古い順に / `before` = カーソルの手前で終わる範囲。
 * 応答全体の上限に収まる分だけ返し、切った側は `hasMoreBefore` / `hasMoreAfter` で分かる。
 */
export function sliceElements(elements: readonly ChatElement[], options: {
  mode: "last" | "after" | "before";
  cursor?: Cursor;
  count: number;
  maxTextBytes: number;
}): ReadRange {
  const total = elements.length;
  let start: number;
  let end: number; // 含まない
  if (options.mode === "last") {
    end = total;
    start = Math.max(0, total - options.count);
  } else {
    const cursor = options.cursor!;
    checkCursor(elements, cursor);
    if (options.mode === "after") {
      start = cursor.seq + 1;
      end = Math.min(total, start + options.count);
    } else {
      end = cursor.seq;
      start = Math.max(0, end - options.count);
    }
  }
  const budget = READ_LIMITS.responseBytes - ENVELOPE_BYTES;
  const messages: OutputMessage[] = [];
  let used = 0;
  // after は古い側から、last / before は新しい側から詰める（切れるのは、起点から遠い側）。
  const fromOldest = options.mode === "after";
  for (let step = 0; step < end - start; step++) {
    const seq = fromOldest ? start + step : end - 1 - step;
    let message = outputMessage(elements[seq]!, seq, options.maxTextBytes);
    let size = jsonBytes(message) + 1;
    if (used + size > budget) {
      if (messages.length > 0) break;
      message = fitMessage(elements[seq]!, seq, options.maxTextBytes, budget - 1);
      size = jsonBytes(message) + 1;
    }
    messages.push(message);
    used += size;
  }
  if (!fromOldest) messages.reverse();
  if (messages.length === 0) {
    // 何も返さないとき（after が末尾・before が先頭・空の会話）。前後に残りがあるかは、起点から分かる。
    return { total, range: null, hasMoreBefore: start > 0 && total > 0, hasMoreAfter: end < total, messages };
  }
  const from = messages[0]!.seq;
  const to = messages[messages.length - 1]!.seq;
  return {
    total, range: { from, to }, hasMoreBefore: from > 0, hasMoreAfter: to < total - 1,
    cursors: { before: formatCursor(from, elements[from]!.atMs), after: formatCursor(to, elements[to]!.atMs) },
    messages,
  };
}

// ---- 検索 ----

/**
 * 検索用にそろえた文字列と、その各文字が元の文字列のどこから来たか。不可視文字と空白を除き、全角・半角と大文字・小文字の
 * 違いをならす（返答の照合の正規化（NFC・不可視文字と空白を除く）に、幅と大文字・小文字のならしを足したもの）。
 */
export function foldForSearch(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let offset = 0;
  for (const character of text) {
    const at = offset;
    offset += character.length;
    if (isInvisibleCodePoint(character.codePointAt(0) ?? 0) || /^\s$/u.test(character)) continue;
    const piece = character.normalize("NFKC").toLowerCase();
    for (let i = 0; i < piece.length; i++) {
      const unit = piece[i]!;
      // NFKC で空白になる文字（全角の空白など）も除く。
      if (/^\s$/u.test(unit)) continue;
      folded += unit;
      map.push(at);
    }
  }
  return { folded, map };
}

/** 抜粋の、一致した箇所の前後に残す文字数。 */
const EXCERPT_BEFORE = 60;
const EXCERPT_AFTER = 140;

/** サロゲートの片割れで始まる・終わる切り口を整える。 */
function wellFormedSlice(text: string, start: number, end: number): string {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && from < text.length && (text.charCodeAt(from) & 0xfc00) === 0xdc00) from++;
  if (to > 0 && to < text.length && (text.charCodeAt(to - 1) & 0xfc00) === 0xd800) to--;
  return text.slice(from, to);
}

/** 1 要素の中の一致。無ければ null。 */
export function matchElement(text: string, foldedQuery: string): { excerpt: string; matchCount: number } | null {
  const base = text.normalize("NFC");
  const { folded, map } = foldForSearch(base);
  const first = folded.indexOf(foldedQuery);
  if (first < 0) return null;
  let matchCount = 0;
  for (let at = first; at >= 0; at = folded.indexOf(foldedQuery, at + foldedQuery.length)) matchCount++;
  const start = map[first]!;
  const lastUnit = map[first + foldedQuery.length - 1]!;
  const end = lastUnit + String.fromCodePoint(base.codePointAt(lastUnit) ?? 0).length;
  const head = wellFormedSlice(base, start - EXCERPT_BEFORE, start);
  const tail = wellFormedSlice(base, end, end + EXCERPT_AFTER);
  const excerpt = `${start - EXCERPT_BEFORE > 0 ? "…" : ""}${head}${base.slice(start, end)}${tail}${end + EXCERPT_AFTER < base.length ? "…" : ""}`;
  return { excerpt: excerpt.replace(/\s+/gu, " ").trim(), matchCount };
}

export interface SearchHit {
  seq: number;
  role: "user" | "assistant";
  atMs: number;
  /** 一致した箇所の前後の抜粋（要素の全文ではない）。 */
  excerpt: string;
  /** その要素の中の一致の数。 */
  matchCount: number;
  source?: MessageSource;
  model?: string;
  before: OutputMessage[];
  after: OutputMessage[];
}

export interface SearchResult {
  total: number;
  /** 一致した要素の数（`before` を指定したら、その手前だけ）。 */
  totalHits: number;
  /** 返したより古い一致が残っているか。 */
  hasMoreBefore: boolean;
  /** さらに古い一致を取るカーソル（返した最初の一致）。 */
  cursors?: { before: string };
  hits: SearchHit[];
}

/**
 * 語で要素を探す。一致した要素のうち新しい方から `limit` 件を、古い順に並べて返す（前後 `context` 件を添える）。
 * 応答全体の上限に収まる分だけ返す。
 */
export function searchElements(elements: readonly ChatElement[], options: {
  query: string;
  context: number;
  limit: number;
  before?: Cursor;
}): SearchResult {
  const total = elements.length;
  const foldedQuery = foldForSearch(options.query.normalize("NFC")).folded;
  let end = total;
  if (options.before !== undefined) {
    checkCursor(elements, options.before);
    end = options.before.seq;
  }
  const matches: Array<{ seq: number; excerpt: string; matchCount: number }> = [];
  if (foldedQuery.length > 0) {
    for (let seq = 0; seq < end; seq++) {
      const match = matchElement(elements[seq]!.text, foldedQuery);
      if (match !== null) matches.push({ seq, ...match });
    }
  }
  // 応答には検索語もそのまま載る。
  const budget = READ_LIMITS.responseBytes - ENVELOPE_BYTES - jsonBytes(options.query);
  const hits: SearchHit[] = [];
  let used = 0;
  for (let i = matches.length - 1; i >= 0 && hits.length < options.limit; i--) {
    const match = matches[i]!;
    const element = elements[match.seq]!;
    const around = (from: number, to: number): OutputMessage[] => {
      const out: OutputMessage[] = [];
      for (let seq = Math.max(0, from); seq < Math.min(total, to); seq++) {
        out.push(outputMessage(elements[seq]!, seq, READ_LIMITS.contextTextBytes));
      }
      return out;
    };
    const hit: SearchHit = {
      seq: match.seq, role: element.role, atMs: element.atMs, excerpt: match.excerpt, matchCount: match.matchCount,
      ...(element.role === "user" && element.source !== undefined ? { source: element.source } : {}),
      ...(element.model !== undefined ? { model: element.model } : {}),
      before: around(match.seq - options.context, match.seq),
      after: around(match.seq + 1, match.seq + 1 + options.context),
    };
    let size = jsonBytes(hit) + 1;
    if (used + size > budget) {
      if (hits.length > 0) break;
      // 1 件目だけで超えるなら、前後を落として返す。
      hit.before = [];
      hit.after = [];
      size = jsonBytes(hit) + 1;
    }
    hits.push(hit);
    used += size;
  }
  hits.reverse();
  const first = hits[0];
  return {
    total, totalHits: matches.length, hasMoreBefore: hits.length < matches.length,
    ...(first !== undefined ? { cursors: { before: formatCursor(first.seq, first.atMs) } } : {}),
    hits,
  };
}
