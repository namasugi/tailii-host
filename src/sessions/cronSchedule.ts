// cronSchedule.ts
// tailii (TS host) — Claude Code のセッション予約（CronCreate / ScheduleWakeup / /loop）の次回発火時刻。
//
// Stop hook の `session_crons[].schedule` は「ユーザーのローカルタイムゾーンの標準 5 フィールド cron」
// （CronCreate のツール説明: "0 9 * * *" means 9am local — no timezone conversion needed）。
// host は同じマシンで動くので、Date のローカル時刻でそのまま評価する。
// 対応構文: `*` / `n` / `a-b` / `*/s` / `a-b/s` / `n/s` / カンマ列挙 / 月・曜日の 3 文字名。
// 日と曜日が両方とも `*` 以外なら標準 cron どおり OR で一致とみなす。

import type { HeartbeatRecurring, HeartbeatScheduled } from "./heartbeat.js";

const MINUTE_MS = 60_000;
/** 探索の上限（うるう日 `0 0 29 2 *` まで届く 4 年 + 余裕）。これより先に一致が無ければ null。 */
const SEARCH_LIMIT_DAYS = 1_500;

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface CronField {
  /** 値 → 一致するか。 */
  allowed: boolean[];
  /** `*`（無制限）だったか。日/曜日の OR 判定に使う。 */
  wildcard: boolean;
}

function parseValue(token: string, min: number, max: number, names?: readonly string[], nameBase = 0): number | null {
  const lower = token.toLowerCase();
  if (names !== undefined) {
    const index = names.indexOf(lower);
    if (index >= 0) return index + nameBase;
  }
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  return value >= min && value <= max ? value : null;
}

function parseField(
  text: string,
  min: number,
  max: number,
  names?: readonly string[],
  nameBase = 0,
): CronField | null {
  const allowed = new Array<boolean>(max + 1).fill(false);
  let wildcard = false;
  for (const part of text.split(",")) {
    const [rangeText, stepText, extra] = part.split("/");
    if (rangeText === undefined || rangeText === "" || extra !== undefined) return null;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) return null;
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = min;
      to = max;
      // Vixie cron は `*` で始まる欄（`*/2` を含む）を「無制限」とみなし、日と曜日を AND にする。
      wildcard = true;
    } else if (rangeText.includes("-")) {
      const [a, b, rest] = rangeText.split("-");
      if (a === undefined || b === undefined || rest !== undefined) return null;
      const start = parseValue(a, min, max, names, nameBase);
      const end = parseValue(b, min, max, names, nameBase);
      if (start === null || end === null || start > end) return null;
      from = start;
      to = end;
    } else {
      const value = parseValue(rangeText, min, max, names, nameBase);
      if (value === null) return null;
      from = value;
      // `n/s` は n から上限まで s 刻み（Vixie cron と同じ）。
      to = stepText === undefined ? value : max;
    }
    for (let v = from; v <= to; v += step) allowed[v] = true;
  }
  return { allowed, wildcard };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minute = parseField(m, 0, 59);
  const hour = parseField(h, 0, 23);
  const dayOfMonth = parseField(dom, 1, 31);
  const month = parseField(mon, 1, 12, MONTH_NAMES, 1);
  // 曜日は 0-7（0 と 7 はどちらも日曜）。
  const dayOfWeek = parseField(dow, 0, 7, DOW_NAMES, 0);
  if (minute === null || hour === null || dayOfMonth === null || month === null || dayOfWeek === null) return null;
  if (dayOfWeek.allowed[7] === true) dayOfWeek.allowed[0] = true;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  if (cron.month.allowed[date.getMonth() + 1] !== true) return false;
  const domOk = cron.dayOfMonth.allowed[date.getDate()] === true;
  const dowOk = cron.dayOfWeek.allowed[date.getDay()] === true;
  if (cron.dayOfMonth.wildcard || cron.dayOfWeek.wildcard) return domOk && dowOk;
  return domOk || dowOk;
}

/**
 * `fromMs` より後（同じ分は含めない）で最初に一致するローカル時刻（Unix ms）。
 * 構文を解釈できない・探索上限まで一致が無いときは null。DST の切替日は 1 時間ずれ得る
 * （保護時間の長さにしか効かないので厳密には追わない）。
 */
export function nextCronFireMs(expression: string, fromMs: number): number | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  const start = new Date(Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let dayOffset = 0; dayOffset < SEARCH_LIMIT_DAYS; dayOffset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!dayMatches(cron, day)) continue;
    for (let hour = 0; hour < 24; hour += 1) {
      if (cron.hour.allowed[hour] !== true) continue;
      for (let minute = 0; minute < 60; minute += 1) {
        if (cron.minute.allowed[minute] !== true) continue;
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
        if (candidate >= start.getTime()) return candidate;
      }
    }
  }
  return null;
}

export interface ScheduledFromCronsOptions {
  /** 予約を持つ Claude プロセスの pid（hook の親）。 */
  pid?: number;
  /** Stop 入力の session_id。 */
  sessionId?: string;
  /** 直前の記録。同じ会話の繰り返し予約は最初に見た時刻を引き継ぐ（7 日失効の起点）。 */
  previous?: HeartbeatScheduled;
}

/**
 * Stop hook の `session_crons` をハートビート記録へ変換する。欄が無い（古い CLI）・配列でないときは
 * null（=記録を消す）。予約が 0 件のときも null。
 */
export function scheduledFromSessionCrons(
  value: unknown,
  nowMs: number,
  options: ScheduledFromCronsOptions = {},
): HeartbeatScheduled | null {
  if (!Array.isArray(value)) return null;
  const nowTs = Math.floor(nowMs / 1_000);
  // 同じプロセスの記録だけ引き継ぐ（pid が両方あれば pid、無ければ session id で比べる。
  // `/clear` は session id を変えるが予約は残るので pid を優先する）。
  const previous = options.previous !== undefined && sameOwner(options.previous, options) ? options.previous : undefined;
  const oneShotTs: number[] = [];
  const recurring: HeartbeatRecurring[] = [];
  let unparsed = false;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const cron = item as Record<string, unknown>;
    // recurring は既定 true（CronCreate の既定）。明示 false だけを 1 回きりとして扱う。
    if (cron["recurring"] !== false) {
      const id = typeof cron["id"] === "string" ? cron["id"] : "";
      const known = id === "" ? undefined : previous?.recurring.find((entry) => entry.id === id);
      recurring.push({ id, firstSeenTs: known?.firstSeenTs ?? nowTs });
      continue;
    }
    const fireMs = typeof cron["schedule"] === "string" ? nextCronFireMs(cron["schedule"], nowMs) : null;
    if (fireMs === null) unparsed = true;
    else oneShotTs.push(Math.floor(fireMs / 1_000));
  }
  if (recurring.length === 0 && !unparsed && oneShotTs.length === 0) return null;
  return {
    atTs: nowTs,
    ...(options.pid !== undefined ? { pid: options.pid } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    oneShotTs,
    recurring,
    unparsed,
  };
}

function sameOwner(previous: HeartbeatScheduled, current: ScheduledFromCronsOptions): boolean {
  if (previous.pid !== undefined && current.pid !== undefined) return previous.pid === current.pid;
  return previous.sessionId === current.sessionId;
}
