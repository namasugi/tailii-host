// heartbeat.ts
// tailii (TS host) — セッション活動ハートビートの読み書き。
//
// reaper daemon(tmux セッション自動掃除)の判定権威。`~/.tailii/heartbeat/<session>` に
// JSON を書き、daemon が `now - ts >= timeout` の一律ルールで kill を判定する。
// mtime は判定に使わない(コピー/復元で蘇生するため)。時刻の正は常にファイル内容の ts。
//
// 書き手:
//   - hook(claude): UserPromptSubmit/PreToolUse/PostToolUse → active、Stop → idle
//   - Hub: chat open/leave、codex/relay の processing active/done、周期 tick の bump
//   - Hub の reaper tick: claude active のプロセス生存 bump 代行、初見セッションの採番
// 読み手: Hub の reaper tick のみ。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";
import { validateSessionName } from "./sessionMetadataStore.js";

/** ハートビートの状態。active=ターン処理中 / idle=待機(計時対象)。 */
export type HeartbeatState = "active" | "idle";

export interface Heartbeat {
  /** 最終活動時刻(Unix 秒)。判定の唯一の時刻ソース。 */
  ts: number;
  state: HeartbeatState;
  /** 書き込み契機(デバッグ用)。判定には使わない。 */
  event?: string;
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
    const parsed = JSON.parse(raw) as { ts?: unknown; state?: unknown; event?: unknown };
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return null;
    if (parsed.state !== "active" && parsed.state !== "idle") return null;
    return {
      ts: parsed.ts,
      state: parsed.state,
      ...(typeof parsed.event === "string" ? { event: parsed.event } : {}),
    };
  } catch {
    return null;
  }
}

/** ハートビートを書く(tmp 書き込み → rename のアトミック置換)。失敗は投げる。 */
export function writeHeartbeat(
  dir: string,
  session: string,
  heartbeat: Heartbeat,
): void {
  ensureDirectory0700(dir);
  const target = heartbeatPath(dir, session);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(heartbeat), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * ts だけ更新する(state は既存値を保持、不在時は fallbackState)。
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
