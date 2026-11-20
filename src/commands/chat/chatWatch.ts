import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { listPendingApprovals, type PendingApprovalRecord } from "../../approval/approvalMailbox.js";
import { defaultChatDeliveryLogPath, parseChatDeliveryLine } from "../../hub/chatDeliveryLog.js";
import {
  defaultChatEventLogPath, isChatEventErrorKind, isChatTurnOutcome, readChatEvents, staleChatEventCursor,
  type ChatEvent, type ChatEventCursor, type ChatTurnOutcome,
} from "../../hub/chatEventLog.js";
import type { QuestionPromptQuestion } from "../../protocol.js";
import type { ChatDeps } from "./chatCommand.js";
import { ChatError, EXIT } from "./chatErrors.js";
import { readClaudeElements, readCodexElements, type ChatElement } from "./chatRead.js";
import {
  codexRolloutBusy, conversationStateSnapshot, findCodexRollout, findTranscript, type ConversationState,
} from "./chatState.js";
import { approvalViews, questionView, sessionNamesForConversation, type PendingQuestion } from "./chatWaiting.js";

const MINUTE_MS = 60_000;
const CLOSED_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
const HISTORY_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMOVE_REASONS = ["done", "handed_over", "boss_stop", "other"] as const;

export type WatchMode = "continue" | "notify";
export type WatchRemoveReason = typeof REMOVE_REASONS[number];
type Agent = "claude" | "codex";
type CloseReason = WatchRemoveReason | "expired" | "deleted";
type WatchState = ConversationState | "waiting_answer" | "waiting_approval";
type EventPosition = Required<ChatEventCursor>;
type TurnEndHint = { outcome: ChatTurnOutcome; error?: string; atMs: number };
type Mark = { size: number; mtimeMs: number };

export interface WatchOptions { mode: WatchMode; ttlMinutes: number }
export interface WatchObservationDeps {
  watchesDir?: string;
  watchState?: (conversationId: string) => ReturnType<typeof conversationStateSnapshot>;
  pendingQuestionsPath?: string;
  watchStat?: (file: string) => Mark | null;
  watchCodexBusy?: typeof codexRolloutBusy;
}

export interface WatchBaseline {
  state: WatchState;
  log: Mark | null;
  assistantElements: number;
  totalElements: number;
  seenLog: boolean;
  codex?: Mark & { busy: boolean };
}

type Reason = { atMs: number } & (
  | { kind: "question"; questionId: string }
  | { kind: "approval"; approvalIds: string[] }
  | { kind: "waiting_other" | "stopped_mid_turn" | "deleted" }
  | { kind: "human_activity"; detail: "message"; count: number; lastAtMs: number }
  | { kind: "human_activity"; detail: "approval" | "answer" }
  | { kind: "usage_limit"; resumeAt?: string }
  | { kind: "turn_ended"; outcome: ChatTurnOutcome | "unknown"; error?: string }
  | { kind: "expired"; unacked?: true }
);

interface WatchRecord {
  v: 1;
  conversationId: string;
  agent: Agent;
  mode: WatchMode;
  note: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  lastRequestId?: string;
  readCursor?: string;
  baseline: WatchBaseline;
  /** 静まるのを待っている間も、処理中・入力待ちからの遷移を覚えておく。 */
  turnCheckPending: boolean;
  questionIds: string[];
  approvalIds: string[];
  deliveryOffset: number;
  eventPosition?: EventPosition;
  turnEndHint?: TurnEndHint;
  usageLimitResumeAt?: string | null;
  botQuestionIds?: string[];
  waitingNotifiedSinceMs?: number;
  pending: Array<Reason & { n: number }>;
  nextNumber: number;
  returned?: { atMs: number; count: number; maxNumber: number };
  closed?: { atMs: number; reason: CloseReason };
}

export function isWatchMode(value: unknown): value is WatchMode {
  return value === "continue" || value === "notify";
}

export function isWatchRemoveReason(value: unknown): value is WatchRemoveReason {
  return REMOVE_REASONS.some((reason) => reason === value);
}

export function validateWatchId(id: string): void {
  if (id.length !== 36 || !UUID.test(id)) {
    throw new ChatError(EXIT.usage, "bad_conversation_id", "会話 ID は UUID で指定してください");
  }
}

export function watchNote(text: string, maxChars: number): string {
  let end = 0;
  for (const char of text) {
    if (maxChars-- === 0) break;
    end += char.length;
  }
  return text.slice(0, end);
}

// 台帳の読み書きと排他。

function ledgerDir(deps: ChatDeps): string {
  return deps.watchesDir ?? path.join(os.homedir(), ".tailii", "bot", "watches");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function fileStat(file: string): Mark | null {
  try {
    const { size, mtimeMs } = fs.statSync(file);
    return { size, mtimeMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function unlinkIfExists(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function tryWatchLock(file: string, now: number): (() => void) | null {
  const owner = JSON.stringify({ pid: process.pid, atMs: now, id: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, owner, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (readIfExists(file) === owner) unlinkIfExists(file);
        } catch {
          // 錠の片付けに失敗しても、確定済みの台帳の操作は成功として返す。
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const seen = readIfExists(file);
    if (seen === null) continue;
    const held = parseJson(seen);
    // 空の錠は作成直後かもしれないので、古さだけで判断する。
    const stale = object(held) && counter(held.pid) && held.pid > 0 && finite(held.atMs)
      ? now - held.atMs > 60_000 || !pidAlive(held.pid)
      : now - (fileStat(file)?.mtimeMs ?? now) > 60_000;
    if (!stale || readIfExists(file) !== seen) return null;
    unlinkIfExists(file);
  }
  return null;
}

async function withWatchLock<T>(deps: ChatDeps, body: (dir: string) => T): Promise<T> {
  const dir = ledgerDir(deps);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, ".lock");
  const deadline = performance.now() + 3_000;
  do {
    const release = tryWatchLock(file, deps.now());
    if (release !== null) {
      try {
        return body(dir);
      } finally {
        release();
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(50, remaining));
  } while (performance.now() < deadline);
  throw new ChatError(EXIT.retryLater, "watch_busy", "見張り台帳を使用中です", "少し待って打ち直してください");
}

function writeWatch(file: string, record: WatchRecord): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { unlinkIfExists(tmp); } catch { /* 元の失敗を返す。 */ }
    throw error;
  }
}

function parseJson(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function counter(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validState(value: unknown): value is WatchState {
  return value === "busy" || value === "idle" || value === "not_running" ||
    value === "waiting" || value === "waiting_answer" || value === "waiting_approval";
}

function validMark(value: unknown): value is Mark {
  return object(value) && counter(value.size) && finite(value.mtimeMs);
}

function validBaseline(value: unknown): value is WatchBaseline {
  return object(value) && validState(value.state) && (value.log === null || validMark(value.log)) &&
    counter(value.assistantElements) && counter(value.totalElements) && value.assistantElements <= value.totalElements &&
    typeof value.seenLog === "boolean" &&
    (value.codex === undefined || (object(value.codex) && typeof value.codex.busy === "boolean" && validMark(value.codex)));
}

function validReason(value: unknown, nextNumber: number): value is Reason & { n: number } {
  if (!object(value) || !finite(value.atMs) || !counter(value.n) || value.n === 0 || value.n >= nextNumber) return false;
  switch (value.kind) {
    case "question": return typeof value.questionId === "string";
    case "approval": return strings(value.approvalIds);
    case "human_activity": return value.detail === "approval" || value.detail === "answer" ||
      (value.detail === "message" && counter(value.count) && finite(value.lastAtMs));
    case "usage_limit": return value.resumeAt === undefined || typeof value.resumeAt === "string";
    case "turn_ended": return (value.outcome === "unknown" || isChatTurnOutcome(value.outcome)) &&
      (value.error === undefined || isChatEventErrorKind(value.error));
    case "expired": return value.unacked === undefined || value.unacked === true;
    case "waiting_other": case "stopped_mid_turn": case "deleted": return true;
    default: return false;
  }
}

function readWatch(file: string, id: string): WatchRecord | null {
  const raw = parseJson(readIfExists(file));
  if (!object(raw) || raw.v !== 1 || raw.conversationId !== id || (raw.agent !== "claude" && raw.agent !== "codex") ||
    !isWatchMode(raw.mode) || (raw.note !== null && typeof raw.note !== "string") ||
    !finite(raw.createdAtMs) || !finite(raw.updatedAtMs) || !finite(raw.expiresAtMs) ||
    (raw.lastRequestId !== undefined && typeof raw.lastRequestId !== "string") ||
    (raw.readCursor !== undefined && typeof raw.readCursor !== "string") ||
    !validBaseline(raw.baseline) || typeof raw.turnCheckPending !== "boolean" ||
    !strings(raw.questionIds) || !strings(raw.approvalIds) || !counter(raw.deliveryOffset) ||
    (raw.eventPosition !== undefined && (!object(raw.eventPosition) || !counter(raw.eventPosition.seq) || !finite(raw.eventPosition.atMs))) ||
    (raw.turnEndHint !== undefined && (!object(raw.turnEndHint) || !isChatTurnOutcome(raw.turnEndHint.outcome) ||
      !finite(raw.turnEndHint.atMs) || (raw.turnEndHint.error !== undefined && !isChatEventErrorKind(raw.turnEndHint.error)))) ||
    (raw.usageLimitResumeAt !== undefined && raw.usageLimitResumeAt !== null && typeof raw.usageLimitResumeAt !== "string") ||
    (raw.botQuestionIds !== undefined && !strings(raw.botQuestionIds)) ||
    (raw.waitingNotifiedSinceMs !== undefined && !finite(raw.waitingNotifiedSinceMs)) ||
    !counter(raw.nextNumber) || raw.nextNumber === 0 || !Array.isArray(raw.pending)) return null;
  const nextNumber = raw.nextNumber;
  let lastNumber = 0;
  for (const entry of raw.pending) {
    if (!validReason(entry, nextNumber) || entry.n <= lastNumber) return null;
    lastNumber = entry.n;
  }
  if (raw.returned !== undefined && (!object(raw.returned) || !finite(raw.returned.atMs) ||
    !counter(raw.returned.count) || !counter(raw.returned.maxNumber))) return null;
  if (raw.closed !== undefined && (!object(raw.closed) || !finite(raw.closed.atMs) ||
    !(isWatchRemoveReason(raw.closed.reason) || raw.closed.reason === "expired" || raw.closed.reason === "deleted"))) return null;
  return raw as unknown as WatchRecord;
}

function ledgerFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function closedFile(dir: string, conversationId: string, atMs: number): string {
  return path.join(dir, "closed", `${conversationId}-${atMs}.json`);
}

function archiveWatch(dir: string, file: string, id: string, atMs: number): void {
  fs.mkdirSync(path.join(dir, "closed"), { recursive: true, mode: 0o700 });
  fs.renameSync(file, closedFile(dir, id, atMs));
}

function closeWatch(dir: string, file: string, record: WatchRecord, reason: CloseReason, now: number): void {
  // 先に閉じた印を保存し、移動前に中断しても次の poll で片付けられるようにする。
  fs.mkdirSync(path.join(dir, "closed"), { recursive: true, mode: 0o700 });
  let atMs = now;
  while (fs.existsSync(closedFile(dir, record.conversationId, atMs))) atMs++;
  record.closed = { atMs, reason };
  record.updatedAtMs = now;
  writeWatch(file, record);
  archiveWatch(dir, file, record.conversationId, atMs);
}

function watchView(record: WatchRecord) {
  const { conversationId, agent, mode, note, createdAtMs, expiresAtMs, lastRequestId, readCursor, closed } = record;
  return { conversationId, agent, mode, note, createdAtMs, expiresAtMs, lastRequestId, readCursor, pending: record.pending.length, closed };
}

export function listWatches(deps: ChatDeps, all: boolean): Array<ReturnType<typeof watchView>> {
  const dir = ledgerDir(deps);
  const records: WatchRecord[] = [];
  for (const name of ledgerFiles(dir)) {
    const id = name.slice(0, -5);
    if (!name.endsWith(".json") || !UUID.test(id)) continue;
    const record = readWatch(path.join(dir, name), id);
    if (record !== null && (record.closed === undefined || all)) records.push(record);
  }
  if (all) {
    const closed = path.join(dir, "closed");
    for (const name of ledgerFiles(closed)) {
      const id = name.slice(0, 36);
      if (!UUID.test(id) || !/^-\d+\.json$/.test(name.slice(36))) continue;
      const record = readWatch(path.join(closed, name), id);
      if (record?.closed !== undefined) records.push(record);
    }
  }
  return records.map(watchView);
}

function claudeState(deps: ChatDeps, id: string): ReturnType<typeof conversationStateSnapshot> {
  if (deps.watchState !== undefined) return deps.watchState(id);
  if (deps.state !== undefined) return { state: deps.state(id) };
  return conversationStateSnapshot(id);
}

function findLog(deps: ChatDeps, agent: Agent, id: string, cwdHint?: string): string | null {
  if (agent === "codex") return (deps.codexRollout ?? findCodexRollout)(id);
  const result = deps.transcript !== undefined
    ? deps.transcript(id, cwdHint)
    : findTranscript(id, { store: deps.store(), cwdHint, resolveCwd: false });
  return result?.file ?? null;
}

function countAssistant(elements: readonly ChatElement[]): number {
  let count = 0;
  for (const element of elements) if (element.role === "assistant") count++;
  return count;
}

/** new / send はこの控えを送信前に取り、受付後に台帳へ登録する。 */
export function captureWatchBaseline(
  deps: ChatDeps, id: string, agent: Agent, empty = false, cwdHint?: string, knownFile?: string | null,
): WatchBaseline {
  validateWatchId(id);
  const file = knownFile === undefined ? findLog(deps, agent, id, cwdHint) : knownFile;
  const mark = file === null ? null : (deps.watchStat ?? fileStat)(file);
  const state = agent === "claude" ? claudeState(deps, id).state : "idle";
  const baseline: WatchBaseline = { state, log: null, assistantElements: 0, totalElements: 0, seenLog: mark !== null };
  if (empty || file === null || mark === null) return baseline;
  const codex = agent === "codex" ? readCodexElements(file) : null;
  const elements = agent === "codex" ? codex?.elements ?? null : readClaudeElements(file);
  if (elements !== null) {
    baseline.log = mark;
    baseline.assistantElements = countAssistant(elements);
    baseline.totalElements = elements.length;
  }
  if (codex !== null) {
    baseline.codex = { ...mark, busy: codex.busy };
    baseline.state = codex.busy ? "busy" : "idle";
  }
  return baseline;
}

function findConversationBaseline(deps: ChatDeps, id: string): { agent: Agent; baseline: WatchBaseline } | null {
  const meta = deps.store().all().find((entry) => entry.providerSessionId === id || entry.claudeSessionId === id);
  const claude = meta?.agent === "codex" ? null : findLog(deps, "claude", id);
  const codex = claude !== null || (meta !== undefined && meta.agent !== "codex") ? null : findLog(deps, "codex", id);
  const agent = meta?.agent === "codex" || codex !== null ? "codex" : "claude";
  const file = agent === "claude" ? claude : codex;
  const baseline = captureWatchBaseline(deps, id, agent, false, undefined, file);
  if (meta !== undefined || baseline.seenLog || (agent === "claude" && baseline.state !== "not_running")) {
    return { agent, baseline };
  }
  return null;
}

function readWatchEvents(deps: ChatDeps, after?: EventPosition) {
  try {
    return readChatEvents(deps.chatEvents ?? defaultChatEventLogPath(), { after, limit: after === undefined ? 1 : Infinity });
  } catch {
    return undefined;
  }
}

function eventPosition(event: ChatEvent | undefined): EventPosition {
  return event === undefined ? { seq: 0, atMs: 0 } : { seq: event.seq, atMs: event.atMs };
}

type RegisterOptions = WatchOptions & { note?: string; lastRequestId?: string; readCursor?: string };

export async function registerWatch(
  deps: ChatDeps, id: string, options: RegisterOptions,
  sent?: { agent: Agent; baseline?: WatchBaseline; duplicate: boolean; cwd?: string; empty?: boolean },
): Promise<ReturnType<typeof watchView>> {
  validateWatchId(id);
  return withWatchLock(deps, (dir) => {
    const file = path.join(dir, `${id}.json`);
    const previous = readWatch(file, id);
    const existing = previous?.closed === undefined ? previous : null;
    if (sent?.duplicate === true && existing !== null) return watchView(existing);
    const now = deps.now();
    let record: WatchRecord;
    if (existing !== null) {
      record = existing;
      // 続きを送った = それまでに起こされた変化は処理済み（受け取りの確認を兼ねる）。`watch add` の登録し直しでは残す。
      if (sent !== undefined) record.pending = [];
    } else {
      const snapshot = sent === undefined ? findConversationBaseline(deps, id) : {
        agent: sent.agent, baseline: sent.baseline ?? captureWatchBaseline(deps, id, sent.agent, sent.empty, sent.cwd),
      };
      if (snapshot === null) throw new ChatError(EXIT.notFound, "not_found", "会話が見つかりません");
      if (previous?.closed !== undefined) archiveWatch(dir, file, id, previous.closed.atMs);
      record = {
        v: 1, conversationId: id, ...snapshot, mode: options.mode, note: null, createdAtMs: now, updatedAtMs: now,
        expiresAtMs: now, turnCheckPending: false, questionIds: [], approvalIds: [], pending: [], nextNumber: 1,
        deliveryOffset: (deps.watchStat ?? fileStat)(deps.chatDeliveries ?? defaultChatDeliveryLogPath())?.size ?? 0,
      };
      const feed = readWatchEvents(deps);
      if (feed !== undefined) record.eventPosition = eventPosition(feed.latest);
    }
    record.mode = options.mode;
    record.updatedAtMs = now;
    record.expiresAtMs = now + options.ttlMinutes * MINUTE_MS;
    if (options.note !== undefined && (sent === undefined || record.note === null)) record.note = options.note;
    if (options.lastRequestId !== undefined) record.lastRequestId = options.lastRequestId;
    if (options.readCursor !== undefined) record.readCursor = options.readCursor;
    writeWatch(file, record);
    return watchView(record);
  });
}

type WatchChange =
  | { kind: "update"; mode?: WatchMode; ttlMinutes?: number; note?: string }
  | { kind: "remove"; reason: WatchRemoveReason }
  | { kind: "ack"; token: number; readCursor?: string };

export async function changeWatch(deps: ChatDeps, id: string, change: WatchChange): Promise<ReturnType<typeof watchView>> {
  validateWatchId(id);
  return withWatchLock(deps, (dir) => {
    const file = path.join(dir, `${id}.json`);
    const record = readWatch(file, id);
    if (record === null || record.closed !== undefined) {
      throw new ChatError(EXIT.notFound, "watch_not_found", "開いている見張りが見つかりません");
    }
    const now = deps.now();
    if (change.kind === "remove") {
      record.pending = [];
      closeWatch(dir, file, record, change.reason, now);
    } else {
      if (change.kind === "update") {
        if (change.mode !== undefined) record.mode = change.mode;
        if (change.ttlMinutes !== undefined) record.expiresAtMs = now + change.ttlMinutes * MINUTE_MS;
        if (change.note !== undefined) record.note = change.note;
        record.pending = [];
      } else {
        record.pending = record.pending.filter((entry) => entry.n > change.token);
        if (change.readCursor !== undefined) record.readCursor = change.readCursor;
      }
      record.updatedAtMs = now;
      writeWatch(file, record);
    }
    return watchView(record);
  });
}

// poll の状態の照合。

export async function recordWatchBotAnswer(deps: ChatDeps, id: string, questionId: string): Promise<void> {
  try {
    if (!UUID.test(id) || !fs.existsSync(path.join(ledgerDir(deps), `${id}.json`))) return;
    await withWatchLock(deps, (dir) => {
      const file = path.join(dir, `${id}.json`);
      const record = readWatch(file, id);
      if (record === null || record.closed !== undefined || record.expiresAtMs <= deps.now()) return;
      record.botQuestionIds = [questionId, ...(record.botQuestionIds ?? []).filter((id) => id !== questionId)].slice(0, HISTORY_LIMIT);
      writeWatch(file, record);
    });
  } catch { /* 見張りの控えの失敗で回答結果は変えない。 */ }
}

function isQuestion(value: unknown): value is QuestionPromptQuestion {
  return object(value) && typeof value.header === "string" && typeof value.question === "string" &&
    typeof value.multiSelect === "boolean" && Array.isArray(value.options) &&
    value.options.every((option: unknown) => object(option) &&
      typeof option.label === "string" && typeof option.description === "string");
}

function readQuestions(deps: ChatDeps): Map<string, PendingQuestion> {
  const file = deps.pendingQuestionsPath ?? path.join(os.homedir(), ".tailii", "hub", "pending-questions.json");
  const questions = new Map<string, PendingQuestion>();
  let raw: unknown;
  try {
    raw = parseJson(readIfExists(file));
  } catch {
    return questions;
  }
  if (!object(raw)) return questions;
  for (const [session, value] of Object.entries(raw)) {
    if (object(value) && typeof value.id === "string" && Array.isArray(value.questions) && value.questions.every(isQuestion)) {
      questions.set(session, { session, id: value.id, questions: value.questions });
    }
  }
  return questions;
}

interface Observation {
  state: WatchState;
  waitingSinceMs?: number;
  waiting?: Record<string, unknown>;
  questions: PendingQuestion[];
  approvals: PendingApprovalRecord[];
  sessions: string[];
}

function observe(
  deps: ChatDeps, record: WatchRecord, file: string | null, mark: Mark | null, questionsBySession: Map<string, PendingQuestion>,
): Observation {
  const id = record.conversationId;
  const live = record.agent === "claude" ? claudeState(deps, id) : { state: "idle" as const };
  let state: WatchState = live.state;
  if (record.agent === "codex" && file !== null && mark !== null) {
    const cached = record.baseline.codex;
    if (cached?.size !== mark.size || cached.mtimeMs !== mark.mtimeMs) {
      record.baseline.codex = { ...mark, busy: (deps.watchCodexBusy ?? codexRolloutBusy)(file) };
    }
    state = record.baseline.codex?.busy === true ? "busy" : "idle";
  }
  const sessions = sessionNamesForConversation(deps.store(), id);
  const questions = sessions.flatMap((session) => questionsBySession.get(session) ?? []);
  const approvals = sessions.flatMap((session) => listPendingApprovals(session, deps.approvalsBase));
  const waiting: Record<string, unknown> = {};
  if (questions[0] !== undefined) {
    state = "waiting_answer";
    waiting.question = questionView(questions[0]);
  }
  if (approvals.length > 0) {
    state = "waiting_approval";
    waiting.approvals = approvalViews(approvals);
  }
  return {
    state, waitingSinceMs: live.waitingSinceMs,
    waiting: questions.length > 0 || approvals.length > 0 ? waiting : undefined,
    questions, approvals, sessions,
  };
}

function isActive(state: WatchState): boolean {
  return state !== "idle" && state !== "not_running";
}

function scanDeliveries(file: string, record: WatchRecord, sessions: string[], now: number): Reason | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    record.deliveryOffset = 0;
    return null;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size < record.deliveryOffset) {
      record.deliveryOffset = size;
      return null;
    }
    let count = 0;
    let lastAtMs = 0;
    if (size === record.deliveryOffset) return null;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = record.deliveryOffset;
    let partial = Buffer.alloc(0);
    let skipping = false;
    while (position < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (read === 0) break;
      const data = chunk.subarray(0, read);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        if (!skipping && partial.length + end - start <= chunk.length) {
          const line = data.subarray(start, end);
          const delivery = parseChatDeliveryLine((partial.length === 0 ? line : Buffer.concat([partial, line])).toString("utf8"));
          if (delivery !== null && !delivery.clientMessageId.startsWith("cli-") &&
            (delivery.conversationId === record.conversationId || sessions.includes(delivery.session))) {
            count++;
            lastAtMs = delivery.atMs;
          }
        }
        partial = Buffer.alloc(0);
        skipping = false;
        start = end + 1;
        record.deliveryOffset = position + start;
      }
      // 改行の無い末尾の位置は保存せず、次の poll まで待つ。
      if (start < read && !skipping) {
        const tail = data.subarray(start);
        skipping = partial.length + tail.length > chunk.length;
        if (!skipping) partial = Buffer.concat([partial, tail]);
      }
      position += read;
    }
    return count === 0 ? null : { kind: "human_activity", detail: "message", count, lastAtMs, atMs: now };
  } finally {
    fs.closeSync(fd);
  }
}

function interrupted(element: ChatElement): boolean {
  const source = element.source ?? element.fixed;
  return source?.kind === "system" && source.detail === "interrupted";
}

function checkTurn(record: WatchRecord, state: WatchState, file: string, mark: Mark, now: number): Reason | null {
  const baseline = record.baseline;
  const wasActive = isActive(baseline.state) || record.turnCheckPending;
  const active = isActive(state);
  const hint = record.turnEndHint;
  if (active || (hint === undefined && (now - mark.mtimeMs < 10_000 || (baseline.log?.size === mark.size && !wasActive)))) {
    baseline.state = state;
    record.turnCheckPending = !active && wasActive;
    return null;
  }

  const elements = record.agent === "claude" ? readClaudeElements(file) : readCodexElements(file)?.elements ?? null;
  if (elements === null) return null;
  const assistants = countAssistant(elements);
  let reason: Reason | null = null;
  if (hint?.outcome === "failed" || hint?.outcome === "interrupted") {
    reason = { kind: "turn_ended", ...hint };
  } else if (assistants > baseline.assistantElements) {
    let cut = elements.length;
    while (cut > 0 && elements[cut - 1]?.role !== "assistant") cut--;
    const outcome = elements.slice(cut).some(interrupted) ? "interrupted" : "completed";
    reason = { kind: "turn_ended", outcome, atMs: now };
  } else if (wasActive && state === "not_running") {
    reason = { kind: "stopped_mid_turn", atMs: now };
  } else if (wasActive) {
    const outcome = elements.slice(baseline.totalElements).some(interrupted) ? "interrupted" : "unknown";
    reason = { kind: "turn_ended", outcome, atMs: now };
  }
  baseline.state = state;
  baseline.log = mark;
  baseline.assistantElements = assistants;
  baseline.totalElements = elements.length;
  record.turnCheckPending = false;
  delete record.turnEndHint;
  return reason;
}

function addReason(record: WatchRecord, reason: Reason): void {
  if (record.mode === "notify" && reason.kind !== "turn_ended" && reason.kind !== "stopped_mid_turn" &&
    reason.kind !== "deleted" && reason.kind !== "expired") return;
  record.pending.push({ ...reason, n: record.nextNumber++ });
  if (record.pending.length > HISTORY_LIMIT) record.pending.shift();
}

function checkReasons(
  deps: ChatDeps, record: WatchRecord, current: Observation, file: string, mark: Mark, now: number,
): void {
  for (const question of current.questions) {
    if (record.questionIds.includes(question.id)) continue;
    record.questionIds = [question.id, ...record.questionIds].slice(0, HISTORY_LIMIT);
    addReason(record, { kind: "question", questionId: question.id, atMs: now });
  }
  const approvalIds = [...new Set(current.approvals
    .slice().sort((a, b) => a.atMs - b.atMs)
    .map((approval) => approval.id))].filter((id) => !record.approvalIds.includes(id));
  if (approvalIds.length > 0) {
    record.approvalIds = [...approvalIds].reverse().concat(record.approvalIds).slice(0, HISTORY_LIMIT);
    addReason(record, { kind: "approval", approvalIds, atMs: now });
  }
  const since = current.waitingSinceMs;
  if (current.state === "waiting" && since !== undefined && now - since >= 15_000 && record.waitingNotifiedSinceMs !== since) {
    record.waitingNotifiedSinceMs = since;
    addReason(record, { kind: "waiting_other", atMs: now });
  }
  const activity = scanDeliveries(deps.chatDeliveries ?? defaultChatDeliveryLogPath(), record, current.sessions, now);
  if (activity !== null) addReason(record, activity);
  const turn = checkTurn(record, current.state, file, mark, now);
  if (turn !== null) addReason(record, turn);
}

function applyWatchEvents(record: WatchRecord, events: readonly ChatEvent[], sessions: string[]): void {
  for (const event of events) {
    if (event.seq <= (record.eventPosition?.seq ?? 0) || event.type === "hub_started" ||
      (event.conversationId !== record.conversationId && !sessions.includes(event.session))) continue;
    switch (event.type) {
      case "turn_started":
        delete record.turnEndHint;
        break;
      case "turn_ended":
        record.turnEndHint = { outcome: event.outcome, error: event.error, atMs: event.atMs };
        break;
      case "usage_limit":
        if (event.state === "waiting") {
          if (record.usageLimitResumeAt !== (event.resumeAt ?? null)) {
            record.usageLimitResumeAt = event.resumeAt ?? null;
            addReason(record, { kind: "usage_limit", resumeAt: event.resumeAt, atMs: event.atMs });
          }
        } else if (event.state === "resumed") {
          delete record.usageLimitResumeAt;
        }
        break;
      case "approval_resolved":
        if (event.by === "app") addReason(record, { kind: "human_activity", detail: "approval", atMs: event.atMs });
        break;
      case "question_resolved":
        if (event.by === "terminal" || (event.reason === "answered" && !record.botQuestionIds?.includes(event.questionId))) {
          addReason(record, { kind: "human_activity", detail: "answer", atMs: event.atMs });
        }
        break;
    }
  }
}

function deliveryItem(record: WatchRecord, current: Pick<Observation, "state" | "waiting">, now: number, closed?: CloseReason) {
  const maxNumber = record.pending.at(-1)?.n;
  if (maxNumber === undefined) return null;
  const returned = record.returned;
  const fresh = returned === undefined || maxNumber > returned.maxNumber;
  if (closed === undefined && !fresh && (returned.count >= 4 || now - returned.atMs < 10 * MINUTE_MS)) return null;
  const redelivery = closed === undefined && !fresh;
  record.returned = { atMs: now, count: redelivery && returned !== undefined ? returned.count + 1 : 1, maxNumber };
  return {
    conversationId: record.conversationId, agent: record.agent, mode: record.mode, note: record.note,
    token: String(maxNumber), redelivery, reasons: record.pending.map(({ n, ...reason }) => reason),
    state: current.state, complete: !isActive(current.state), waiting: current.waiting,
    lastRequestId: record.lastRequestId, readCursor: record.readCursor, expiresAtMs: record.expiresAtMs,
    ...(closed !== undefined ? { closed: { reason: closed } } : {}),
  };
}

function pruneClosed(dir: string, now: number): void {
  const closed = path.join(dir, "closed");
  for (const name of ledgerFiles(closed)) {
    if (!UUID.test(name.slice(0, 36))) continue;
    const timestamp = /^-(\d+)\.json$/.exec(name.slice(36));
    if (timestamp !== null && Number(timestamp[1]) < now - CLOSED_RETENTION_MS) {
      unlinkIfExists(path.join(closed, name));
    }
  }
}

export async function pollWatches(deps: ChatDeps) {
  return withWatchLock(deps, (dir) => {
    const now = deps.now();
    pruneClosed(dir, now);
    const items: NonNullable<ReturnType<typeof deliveryItem>>[] = [];
    const errors: Array<{ conversationId: string; message: string }> = [];
    const questions = readQuestions(deps);
    const records: Array<{ ledger: string; record: WatchRecord }> = [];
    let open = 0;
    let fast = false;
    for (const name of ledgerFiles(dir)) {
      const conversationId = name.slice(0, -5);
      if (!name.endsWith(".json") || !UUID.test(conversationId)) continue;
      const ledger = path.join(dir, name);
      let record: WatchRecord | null = null;
      try {
        record = readWatch(ledger, conversationId);
        if (record === null) continue;
        if (record.closed !== undefined) {
          archiveWatch(dir, ledger, conversationId, record.closed.atMs);
          continue;
        }
        records.push({ ledger, record });
      } catch (error) {
        if (record?.closed === undefined) {
          open++;
          fast ||= record !== null && (isActive(record.baseline.state) || record.pending.length > 0);
        }
        errors.push({ conversationId, message: error instanceof Error ? error.message : String(error) });
      }
    }

    let earliest: EventPosition | undefined;
    for (const { record } of records) {
      const position = record.eventPosition;
      if (position !== undefined && (earliest === undefined || position.seq < earliest.seq)) earliest = position;
    }
    const feed = readWatchEvents(deps, earliest);
    const anchors = new Map(feed?.events.map((event) => [event.seq, event]));
    if (feed?.anchor !== undefined) anchors.set(feed.anchor.seq, feed.anchor);
    const lastBoot = feed?.lastHubStartSeq;
    let source: "state" | "events+state" = feed?.available === true ? "events+state" : "state";

    for (const { ledger, record } of records) {
      const { conversationId, eventPosition: position } = record;
      const trusted = feed?.available === true && (position === undefined || (
        !staleChatEventCursor(position, feed.latest, anchors.get(position.seq)) &&
        (feed.oldest === undefined || position.seq >= feed.oldest.seq - 1) &&
        (lastBoot === undefined || position.seq >= lastBoot)
      ));
      if (!trusted) source = "state";
      try {
        const before = JSON.stringify(record);
        if (!trusted) delete record.turnEndHint;
        const expired = now >= record.expiresAtMs;
        const file = findLog(deps, record.agent, conversationId);
        const mark = file === null ? null : (deps.watchStat ?? fileStat)(file);
        const missing = file === null || mark === null;
        const deleted = missing && (record.baseline.seenLog || now - record.createdAtMs > 120_000);
        const closed = expired ? "expired" : deleted ? "deleted" : undefined;
        if (closed === undefined) {
          if (trusted && position !== undefined && feed.events.length > 0) {
            applyWatchEvents(record, feed.events, sessionNamesForConversation(deps.store(), conversationId));
          }
          if (feed?.available === true) record.eventPosition = eventPosition(feed.latest);
          else if (feed === undefined || position?.seq !== 0) delete record.eventPosition;
        }
        if (missing && closed === undefined) {
          if (before !== JSON.stringify(record)) {
            record.updatedAtMs = now;
            writeWatch(ledger, record);
          }
          open++;
          fast ||= isActive(record.baseline.state) || record.pending.length > 0;
          continue;
        }
        const current = observe(deps, record, file, mark, questions);
        if (closed === "expired") {
          addReason(record, { kind: "expired", atMs: now, ...(record.pending.length > 0 ? { unacked: true } : {}) });
        } else if (closed === "deleted") {
          addReason(record, { kind: "deleted", atMs: now });
        } else if (file !== null && mark !== null) {
          record.baseline.seenLog = true;
          checkReasons(deps, record, current, file, mark, now);
        }
        const item = deliveryItem(record, current, now, closed);
        if (closed !== undefined) {
          record.baseline.state = current.state;
          closeWatch(dir, ledger, record, closed, now);
        } else {
          if (before !== JSON.stringify(record)) {
            record.updatedAtMs = now;
            writeWatch(ledger, record);
          }
          open++;
          fast ||= isActive(current.state) || record.pending.length > 0;
        }
        if (item !== null) items.push(item);
      } catch (error) {
        open++;
        fast ||= isActive(record.baseline.state) || record.pending.length > 0;
        errors.push({ conversationId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      wake: items.length > 0, nextPollSec: open === 0 ? 300 : fast ? 30 : 120, open, source, items,
      ...(errors.length > 0 ? { errors } : {}),
    };
  });
}
