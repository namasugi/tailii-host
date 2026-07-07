// codexUsage.ts
// tailii (TS host) — codex rollout の使用量集計（agent-tag / codex-input）
//
// codex は claude の transcript usage パーサと非互換。rollout の `event_msg/token_count` に
// 完全な使用量が載る（`info.total_token_usage`, `info.model_context_window`, `rate_limits`）。
// 直近（末尾）の token_count を 1 件読み、usage_response 相当の集計へ落とす。
//
// マップ:
//   - inputTokens        = total_token_usage.input_tokens
//   - outputTokens       = total_token_usage.output_tokens
//   - cacheReadTokens    = total_token_usage.cached_input_tokens
//   - cacheCreationTokens= 0（codex は区別を持たない）
//   - turns              = 0（codex は assistant ターン数を token_count に持たない）
//   - fiveHour*(5h窓=primary) / sevenDay*(週窓=secondary) の used_percent(0–100)・resets_at(Unix秒)

import * as fs from "node:fs";
import { emptyUsageTotals, type UsageTotals } from "./usageAggregator.js";

/** token_count から読める使用量 + レート制限（plan 相当）。 */
export interface CodexUsage extends UsageTotals {
  /** モデルのコンテキスト窓（token）。未取得は undefined。 */
  contextWindow?: number;
  fiveHourUtilization?: number;
  /** リセット時刻（ISO8601 文字列。usage_response は string で運ぶ）。 */
  fiveHourResetsAt?: string;
  sevenDayUtilization?: number;
  sevenDayResetsAt?: string;
}

/** 末尾から読むバイト数上限（直近の token_count は末尾付近にある）。 */
const TAIL_READ_BYTES = 512 * 1024;

/**
 * rollout の末尾から直近の `token_count` を 1 件読み、使用量へ落とす。
 * 読めない/未出現なら空集計（全 0）を返す。
 */
export function aggregateCodexUsage(rolloutPath: string): CodexUsage {
  const line = readLastTokenCountLine(rolloutPath);
  if (line === null) return { ...emptyUsageTotals() };

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ...emptyUsageTotals() };
  }
  if (typeof obj !== "object" || obj === null) return { ...emptyUsageTotals() };
  const payload = (obj as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return { ...emptyUsageTotals() };
  const p = payload as Record<string, unknown>;

  const result: CodexUsage = { ...emptyUsageTotals() };

  const info = p["info"];
  if (typeof info === "object" && info !== null) {
    const i = info as Record<string, unknown>;
    const total = i["total_token_usage"];
    if (typeof total === "object" && total !== null) {
      const t = total as Record<string, unknown>;
      result.inputTokens = numberOrZero(t["input_tokens"]);
      result.outputTokens = numberOrZero(t["output_tokens"]);
      result.cacheReadTokens = numberOrZero(t["cached_input_tokens"]);
    }
    const window = i["model_context_window"];
    if (typeof window === "number" && window > 0) result.contextWindow = window;
  }

  const rate = p["rate_limits"];
  if (typeof rate === "object" && rate !== null) {
    const r = rate as Record<string, unknown>;
    applyWindow(r["primary"], (util, resets) => {
      if (util !== undefined) result.fiveHourUtilization = util;
      if (resets !== undefined) result.fiveHourResetsAt = resets;
    });
    applyWindow(r["secondary"], (util, resets) => {
      if (util !== undefined) result.sevenDayUtilization = util;
      if (resets !== undefined) result.sevenDayResetsAt = resets;
    });
  }

  return result;
}

/** rate_limits の 1 窓（primary/secondary）から used_percent(丸め) と resets_at(ISO) を取り出す。 */
function applyWindow(
  raw: unknown,
  set: (util: number | undefined, resets: string | undefined) => void,
): void {
  if (typeof raw !== "object" || raw === null) return;
  const w = raw as Record<string, unknown>;
  const used = w["used_percent"];
  const resets = w["resets_at"];
  set(
    typeof used === "number" ? Math.round(used) : undefined,
    // resets_at は Unix 秒。usage_response は ISO 文字列で運ぶため変換する。
    typeof resets === "number" ? new Date(Math.floor(resets) * 1000).toISOString() : undefined,
  );
}

/** ファイル末尾チャンクを読み、最後の `type=="event_msg"` かつ `payload.type=="token_count"` 行を返す。 */
function readLastTokenCountLine(rolloutPath: string): string | null {
  let fd: number;
  let size: number;
  try {
    size = fs.statSync(rolloutPath).size;
    fd = fs.openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const readLen = Math.min(size, TAIL_READ_BYTES);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const line = lines[idx];
      if (line === undefined || line.length === 0) continue;
      // 末尾チャンクの先頭行は途中で切れ得るが、その行が token_count でパース可能なら採用、
      // 不可なら次（より内側）へ進むため安全。
      if (!line.includes("token_count")) continue;
      try {
        const obj = JSON.parse(line) as unknown;
        if (
          typeof obj === "object" &&
          obj !== null &&
          (obj as { type?: unknown }).type === "event_msg"
        ) {
          const payload = (obj as { payload?: unknown }).payload;
          if (
            typeof payload === "object" &&
            payload !== null &&
            (payload as { type?: unknown }).type === "token_count"
          ) {
            return line;
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // close 失敗は無視。
    }
  }
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
