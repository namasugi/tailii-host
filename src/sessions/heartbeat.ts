// heartbeat.ts
// tailii (TS host) — セッション活動ハートビートの読み書き。
//
// reaper daemon(tmux セッション自動掃除)の判定権威。`~/.tailii/heartbeat/<session>` に
// JSON を書き、daemon が `now - ts >= timeout` の一律ルールで kill を判定する。
// mtime は判定に使わない(コピー/復元で蘇生するため)。時刻の正は常にファイル内容の ts。
//
// 書き手:
//   - hook(claude): UserPromptSubmit/PreToolUse/PostToolUse → active、Stop → idle（+ 残った予約 scheduled）
//   - Hub: chat open/leave、codex/relay の processing active/done、周期 tick の bump
//   - Hub の reaper tick: claude active のプロセス生存 bump 代行、初見セッションの採番
// 読み手: Hub の reaper tick のみ。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "../shared/paths.js";
import { validateSessionName } from "./sessionMetadataStore.js";

/** ハートビートの状態。active=ターン処理中 / idle=待機(計時対象)。 */
export type HeartbeatState = "active" | "idle";

export interface Heartbeat {
  /** 最終活動時刻(Unix 秒)。判定の唯一の時刻ソース。 */
  ts: number;
  state: HeartbeatState;
  /** 書き込み契機(デバッグ用)。判定には使わない。 */
  event?: string;
  /**
   * 処理開始（最後の active 信号）の時刻(Unix ms)。Hub の `processingSinceMs` の永続化で、
   * bump は保持する。Hub 再起動後に transcript の中断マーカーが現ターンのものかを判定する
   * 根拠（ts は毎 tick bump されるため開始時刻には使えない）。旧形式・hook 書込では無い。
   */
  sinceMs?: number;
  /**
   * 直近の Stop hook 時点で残っていたセッション予約（CronCreate / ScheduleWakeup / /loop）。
   * reaper は次回発火まで延命する（予約はプロセス内にしか無く、kill すると消える）。
   * Stop hook だけが書き換え、他の書き手は保持する（{@link writeHeartbeat}）。
   */
  scheduled?: HeartbeatScheduled;
}

/** Stop 時点の予約。発火時刻は Stop 時に絶対時刻へ確定させる（毎 tick 計算すると `* * *` の日付が翌日へずれ続ける）。 */
export interface HeartbeatScheduled {
  /** 記録した時刻（Unix 秒）。1 回きり・解釈不能の保護上限の起点。 */
  atTs: number;
  /**
   * 予約を持っていた Claude プロセスの pid（hook の親）。予約はそのプロセス内にしか無いので、
   * reaper は生きている記録の pid と照合する（別プロセスが起動し直されていたら無効）。
   * `/clear` では session id が変わるが予約は残る（2.1.283 実測）ため、持ち主は pid で表す。
   */
  pid?: number;
  /** Stop 入力の session_id（pid が取れなかったときの持ち主の代わり）。 */
  sessionId?: string;
  /** 1 回きりの予約の発火時刻（Unix 秒）。 */
  oneShotTs: number[];
  /** 繰り返し予約。Claude Code は作成から 7 日で自動失効させるので、最初に見た時刻を引き継ぐ。 */
  recurring: HeartbeatRecurring[];
  /** 解釈できない schedule があった（保護は atTs から上限時間で閉じる）。 */
  unparsed: boolean;
}

export interface HeartbeatRecurring {
  id: string;
  /** この予約を Stop で最初に見た時刻（Unix 秒）。作成時刻の近似。 */
  firstSeenTs: number;
}

/**
 * {@link writeHeartbeat} の入力。`scheduled` は undefined なら既存値を保持し、null で明示的に消す。
 */
export type HeartbeatWrite = Omit<Heartbeat, "scheduled"> & { scheduled?: HeartbeatScheduled | null };

function finiteTs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseScheduled(value: unknown): HeartbeatScheduled | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!finiteTs(raw["atTs"])) return undefined;
  const oneShotTs = Array.isArray(raw["oneShotTs"]) ? raw["oneShotTs"].filter(finiteTs) : [];
  const recurring = Array.isArray(raw["recurring"])
    ? raw["recurring"].flatMap((item: unknown): HeartbeatRecurring[] => {
      if (typeof item !== "object" || item === null) return [];
      const entry = item as Record<string, unknown>;
      return typeof entry["id"] === "string" && finiteTs(entry["firstSeenTs"])
        ? [{ id: entry["id"], firstSeenTs: entry["firstSeenTs"] }]
        : [];
    })
    : [];
  return {
    atTs: raw["atTs"],
    ...(finiteTs(raw["pid"]) ? { pid: raw["pid"] } : {}),
    ...(typeof raw["sessionId"] === "string" ? { sessionId: raw["sessionId"] } : {}),
    oneShotTs,
    recurring,
    unparsed: raw["unparsed"] === true,
  };
}

/** 既定のハートビート置き場(`~/.tailii/heartbeat`)。 */
export function defaultHeartbeatDir(): string {
  return path.join(os.homedir(), ".tailii", "heartbeat");
}

function heartbeatPath(dir: string, session: string): string {
  validateSessionName(session);
  return path.join(dir, session);
}

/** ハートビートを読む。不在・壊れは null(呼び手が採番する)。 */
export function readHeartbeat(dir: string, session: string): Heartbeat | null {
  try {
    const raw = fs.readFileSync(heartbeatPath(dir, session), "utf8");
    const parsed = JSON.parse(raw) as {
      ts?: unknown; state?: unknown; event?: unknown; sinceMs?: unknown; scheduled?: unknown;
    };
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return null;
    if (parsed.state !== "active" && parsed.state !== "idle") return null;
    const scheduled = parseScheduled(parsed.scheduled);
    return {
      ts: parsed.ts,
      state: parsed.state,
      ...(typeof parsed.event === "string" ? { event: parsed.event } : {}),
      ...(typeof parsed.sinceMs === "number" && Number.isFinite(parsed.sinceMs) ? { sinceMs: parsed.sinceMs } : {}),
      ...(scheduled !== undefined ? { scheduled } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * ハートビートを書く(tmp 書き込み → rename のアトミック置換)。失敗は投げる。
 * `scheduled` は未指定なら既存値を引き継ぐ（Hub の処理完了書込等で Stop hook の記録を消さない）。
 * 読んでから rename するまでの間（1ms 未満）に別プロセス（hook）が書くと、その書込は負ける。
 * ts/state でも従来からある競合で、負けても予約保護が効かず通常の回収に戻るだけなので許容する。
 */
export function writeHeartbeat(
  dir: string,
  session: string,
  heartbeat: HeartbeatWrite,
): void {
  ensureDirectory0700(dir);
  const target = heartbeatPath(dir, session);
  const { scheduled: scheduledInput, ...rest } = heartbeat;
  const scheduled = scheduledInput === undefined ? readHeartbeat(dir, session)?.scheduled : scheduledInput;
  const record: Heartbeat = { ...rest, ...(scheduled !== undefined && scheduled !== null ? { scheduled } : {}) };
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * ts だけ更新する(state・sinceMs・scheduled は既存値を保持、不在時は fallbackState)。
 * チャット表示中 ticker / daemon の bump 代行用。
 */
export function bumpHeartbeat(
  dir: string,
  session: string,
  now: number,
  event: string,
  fallbackState: HeartbeatState = "idle",
): void {
  const existing = readHeartbeat(dir, session);
  writeHeartbeat(dir, session, {
    ts: now,
    state: existing?.state ?? fallbackState,
    event,
    ...(existing?.sinceMs !== undefined ? { sinceMs: existing.sinceMs } : {}),
    scheduled: existing?.scheduled ?? null,
  });
}

/** ハートビートファイルを消す(kill 後の掃除)。不在は無視。 */
export function removeHeartbeat(dir: string, session: string): void {
  try {
    fs.unlinkSync(heartbeatPath(dir, session));
  } catch {
    // 不在等は無視。
  }
}

/** dir 配下の全ハートビートのセッション名(tmp 残骸は除外)。 */
export function listHeartbeatSessions(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.includes(".tmp-"))
      .sort();
  } catch {
    return [];
  }
}
