import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "../shared/paths.js";

const TURN_OUTCOMES = ["completed", "failed", "interrupted"] as const;
const QUESTION_REASONS = ["answered", "dismissed", "turn_ended", "session_ended"] as const;
const QUESTION_SOURCES = ["cli", "app", "terminal"] as const;
const APPROVAL_DECISIONS = ["allow", "deny"] as const;
const APPROVAL_SOURCES = ["app", "cli", "timeout", "terminal"] as const;
const MESSAGE_ORIGINS = ["cli", "app"] as const;
const USAGE_LIMIT_STATES = ["waiting", "resuming", "resumed"] as const;
const SESSION_END_REASONS = ["killed", "agent_exited", "disappeared", "retired"] as const;

export type ChatTurnOutcome = typeof TURN_OUTCOMES[number];
export type QuestionResolution = {
  reason: typeof QUESTION_REASONS[number];
  by?: typeof QUESTION_SOURCES[number];
};
export type ApprovalResolution = {
  decision?: typeof APPROVAL_DECISIONS[number];
  by?: typeof APPROVAL_SOURCES[number];
};
export type SessionEndReason = typeof SESSION_END_REASONS[number];

export type SessionChatEvent =
  | { type: "turn_started" }
  | { type: "turn_ended"; outcome: ChatTurnOutcome; error?: string }
  | { type: "question_asked"; questionId: string; blocking: boolean }
  | ({ type: "question_resolved"; questionId: string } & QuestionResolution)
  | { type: "approval_requested"; approvalId: string; tool?: string }
  | ({ type: "approval_resolved"; approvalId: string } & ApprovalResolution)
  | { type: "message_delivered"; clientMessageId: string; origin: typeof MESSAGE_ORIGINS[number] }
  | { type: "usage_limit"; state: typeof USAGE_LIMIT_STATES[number]; resumeAt?: string }
  | { type: "session_ended"; reason: SessionEndReason };

export type ChatEventInput =
  | { type: "hub_started"; version?: string }
  | (SessionChatEvent & { session: string; conversationId?: string; agent: "claude" | "codex" });
export type ChatEvent = ChatEventInput & { v: 1; seq: number; atMs: number; boot: string };
export type ChatEventCursor = { seq: number; atMs?: number };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function oneOf(options: readonly string[], value: unknown): boolean {
  return typeof value === "string" && options.includes(value);
}

function optionalChoice(options: readonly string[], value: unknown): boolean {
  return value === undefined || oneOf(options, value);
}

export function isChatEventErrorKind(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

export function isChatTurnOutcome(value: unknown): value is ChatTurnOutcome {
  return oneOf(TURN_OUTCOMES, value);
}

const eventFields = {
  hub_started: { version: optionalString },
  turn_started: {},
  turn_ended: { outcome: isChatTurnOutcome, error: (value) => value === undefined || isChatEventErrorKind(value) },
  question_asked: { questionId: isString, blocking: (value) => typeof value === "boolean" },
  question_resolved: {
    questionId: isString, reason: (value) => oneOf(QUESTION_REASONS, value),
    by: (value) => optionalChoice(QUESTION_SOURCES, value),
  },
  approval_requested: { approvalId: isString, tool: optionalString },
  approval_resolved: {
    approvalId: isString, decision: (value) => optionalChoice(APPROVAL_DECISIONS, value),
    by: (value) => optionalChoice(APPROVAL_SOURCES, value),
  },
  message_delivered: { clientMessageId: isString, origin: (value) => oneOf(MESSAGE_ORIGINS, value) },
  usage_limit: { state: (value) => oneOf(USAGE_LIMIT_STATES, value), resumeAt: optionalString },
  session_ended: { reason: (value) => oneOf(SESSION_END_REASONS, value) },
} satisfies Record<ChatEventInput["type"], Record<string, (value: unknown) => boolean>>;

export function isChatEventType(value: string): value is ChatEventInput["type"] {
  return Object.hasOwn(eventFields, value);
}

export function parseChatEventLine(line: string): ChatEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.v !== 1 || typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 1 ||
    typeof e.atMs !== "number" || !Number.isSafeInteger(e.atMs) || e.atMs < 0 || e.atMs > 8_640_000_000_000_000 ||
    typeof e.boot !== "string" || e.boot.length === 0 || e.boot.length > 8 ||
    typeof e.type !== "string" || !isChatEventType(e.type)) return null;
  if (e.type === "usage_limit" && e.state !== "waiting" && e.resumeAt !== undefined) return null;
  const row: Record<string, unknown> = { v: 1, seq: e.seq, atMs: e.atMs, boot: e.boot, type: e.type };
  if (e.type !== "hub_started") {
    if (typeof e.session !== "string" || e.session.length === 0 || !optionalString(e.conversationId) ||
      (e.agent !== "claude" && e.agent !== "codex")) return null;
    row.session = e.session;
    row.agent = e.agent;
    if (e.conversationId !== undefined) row.conversationId = e.conversationId;
  }
  for (const [key, validate] of Object.entries(eventFields[e.type])) {
    if (!validate(e[key])) return null;
    if (e[key] !== undefined) row[key] = e[key];
  }
  return row as ChatEvent;
}

export function defaultChatEventLogPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "hub", "events.ndjson");
}

function previousPath(file: string): string {
  return file.endsWith(".ndjson") ? file.slice(0, -7) + ".1.ndjson" : file + ".1";
}

function openLog(file: string): number | null {
  try { return fs.openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 末尾の改行より後は書きかけとして飛ばし、改行で終わった行だけを逆順に返す。 */
function* reverseLines(fd: number, size: number): Generator<{ line: string; end: number }> {
  const buffer = Buffer.allocUnsafe(16 * 1024);
  let end: number | undefined;
  let carry: Buffer = Buffer.alloc(0);
  for (let pos = size; pos > 0;) {
    const length = Math.min(buffer.length, pos);
    pos -= length;
    const read = fs.readSync(fd, buffer, 0, length, pos);
    if (read !== length) throw new Error("イベントファイルの長さが読み取り中に変わりました");
    let right = length;
    for (let left = buffer.lastIndexOf(10, right - 1); left >= 0; left = buffer.lastIndexOf(10, right - 1)) {
      if (end !== undefined) {
        yield { line: Buffer.concat([buffer.subarray(left + 1, right), carry]).toString("utf8"), end };
      }
      end = pos + left + 1;
      carry = Buffer.alloc(0);
      right = left;
      if (right === 0) break;
    }
    if (end !== undefined) carry = Buffer.concat([buffer.subarray(0, right), carry]);
  }
  if (end !== undefined) yield { line: carry.toString("utf8"), end };
}

function inspectTail(file: string): { size: number; completeSize: number; seq: number } {
  const fd = openLog(file);
  if (fd === null) return { size: 0, completeSize: 0, seq: 0 };
  try {
    const size = fs.fstatSync(fd).size;
    let completeSize: number | undefined;
    for (const { line, end } of reverseLines(fd, size)) {
      completeSize ??= end;
      const event = parseChatEventLine(line);
      if (event !== null) return { size, completeSize, seq: event.seq };
    }
    return { size, completeSize: completeSize ?? 0, seq: 0 };
  } finally {
    fs.closeSync(fd);
  }
}

export class ChatEventLog {
  private size = 0;
  private seq = 0;
  private initialized = false;
  private repairTail = false;
  private failing = false;

  constructor(private readonly file: string, private readonly options: {
    bootId: string;
    now?: () => number;
    maxBytes?: number;
    log?: (message: string) => void;
  }) {
    // ここではファイルに触らない。hub は排他を取る前にこの書き手を作るので、排他に負けて終わるプロセスが、動いている hub の
    // ファイルを読んだり切り詰めたりしないようにする。番号は最初の追記のときに読む。
  }

  private initialize(): void {
    ensureDirectory0700(path.dirname(this.file));
    const tail = inspectTail(this.file);
    if (tail.size !== tail.completeSize) fs.truncateSync(this.file, tail.completeSize);
    this.seq = tail.seq || inspectTail(previousPath(this.file)).seq;
    this.size = tail.completeSize;
    this.initialized = true;
  }

  append(event: ChatEventInput): void {
    try {
      if (!this.initialized) this.initialize();
      else {
        if (this.failing) ensureDirectory0700(path.dirname(this.file));
        // 自分の書いた大きさと違えば、別の書き手（入れ替わりの途中の前の hub）が書いた・消された・回された。番号を読み直す
        // （同じ番号を 2 回振らない）。1 日に数百件の追記なので、毎回の stat は負担にならない。
        if (!this.repairTail && this.currentSize() !== this.size) this.initialize();
      }
      const line = JSON.stringify({
        v: 1, seq: this.seq + 1, atMs: (this.options.now ?? Date.now)(), boot: this.options.bootId.slice(0, 8), ...event,
      }) + "\n";
      if (this.repairTail) {
        try { fs.truncateSync(this.file, this.size); } catch (error) {
          if (this.size !== 0 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.repairTail = false;
      }
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > (this.options.maxBytes ?? 4 * 1024 * 1024)) {
        fs.renameSync(this.file, previousPath(this.file));
        this.size = 0;
      }
      this.repairTail = true;
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.repairTail = false;
      this.size += bytes;
      this.seq++;
      this.failing = false;
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private currentSize(): number {
    try { return fs.statSync(this.file).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private reportFailure(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    try { this.options.log?.(`chat events 記録失敗: ${String(error)}`); } catch { /* 記録は最善努力。 */ }
  }
}

export function staleChatEventCursor(
  cursor: ChatEventCursor, latest: ChatEvent | undefined, anchor: ChatEvent | undefined,
): boolean {
  return cursor.seq > (latest?.seq ?? 0) ||
    (cursor.atMs !== undefined && anchor !== undefined && cursor.atMs !== anchor.atMs);
}

/** after 付きでは古い方から、カーソル未指定では新しい方から limit 件を選ぶ。返す順序は常に古い順。 */
export function readChatEvents(file: string, options: {
  after?: ChatEventCursor;
  limit: number;
  matches?: (event: ChatEvent) => boolean;
}) {
  const { after, limit, matches } = options;
  const events: ChatEvent[] = [];
  let count = 0;
  let available = false;
  let latest: ChatEvent | undefined;
  let oldest: ChatEvent | undefined;
  let anchor: ChatEvent | undefined;
  let lastHubStartSeq: number | undefined;
  scan: for (const candidate of [file, previousPath(file)]) {
    const fd = openLog(candidate);
    if (fd === null) continue;
    try {
      available = true;
      for (const { line } of reverseLines(fd, fs.fstatSync(fd).size)) {
        const event = parseChatEventLine(line);
        if (event === null || (oldest !== undefined && event.seq >= oldest.seq)) continue;
        latest ??= event;
        oldest = event;
        if (after !== undefined && event.seq <= after.seq) {
          if (event.seq === after.seq) anchor = event;
          break scan;
        }
        if (event.type === "hub_started") lastHubStartSeq ??= event.seq;
        if (matches !== undefined && !matches(event)) continue;
        if (after === undefined && count === limit) {
          count++;
          break scan;
        }
        events[count++ % limit] = event;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  // 逆順に読んだ最後の limit 件が、カーソルから見て最も古いページになる。
  const start = count > limit && after !== undefined ? count % limit : 0;
  const stale = after !== undefined && staleChatEventCursor(after, latest, anchor);
  return {
    events: events.slice(start).concat(events.slice(0, start)).reverse(),
    hasMore: count > limit, available, latest, oldest, anchor, lastHubStartSeq, stale,
    gap: stale || (after !== undefined && oldest !== undefined && after.seq < oldest.seq - 1),
  };
}
