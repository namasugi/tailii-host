// codexAccountUsage.ts
// tailii (TS host) — Codex アカウント全体のレート制限（account-usage）
//
// 会話（rollout）由来の codexUsage.ts と違い、**ログイン中アカウント全体**の使用率を
// App Server の `account/rateLimits/read` から直接読む。会話を1件も開いていなくても
// 取得できるため、会話一覧の「使用量」シートはこちらを使う。
//
// マップ（v2 camelCase 応答）:
//   - 各枠は **windowDurationMins で分類**する（24時間以下 → 5時間枠 / 超 → 週次枠）。
//     primary=5時間・secondary=週次の固定位置ではない — 実測（0.145, planType=prolite）で
//     primary が週次（10080分）・secondary=null のアカウントが存在する。duration が
//     読めないときだけ位置（primary→5時間 / secondary→週次）へフォールバックする。
//   - rateLimits.planType  → planType（"plus" / "prolite" 等の生値）
// `resetsAt` は Unix 秒で来るので ISO 8601 文字列へ変換する（codexUsage.ts の applyWindow と同じ規約）。
//
// 取得不能（App Server 起動不可・未ログイン・timeout）は throw せず null を返す
// （呼び出し側が codexError 文字列へ落とす）。

import type { CodexAppServerManager } from "./codexAppServer.js";
import type { CodexAccountUsage } from "../protocol/messages.js";

/** engine へ注入するフェッチャの型（テストは固定値/null を注入する）。 */
export type CodexAccountUsageProvider = () => Promise<CodexAccountUsage | null>;

/** App Server の 1 リクエストに与える既定 timeout（ms）。 */
export const CODEX_ACCOUNT_USAGE_TIMEOUT_MS = 5_000;

/**
 * 共有 App Server から現在のアカウントのレート制限を読む（ベストエフォート）。
 *
 * params は**送らない**: 0.145 の `account/rateLimits/read` は unit（引数なし）を要求し、
 * `{forceRefetch:false}` を渡すと "invalid type: map, expected unit" で拒否される
 * （forceRefetch は後発バージョンの追加）。App Server が停止中なら起動を試み、
 * それでも駄目なら null。
 */
export async function fetchCodexAccountUsage(
  manager: CodexAppServerManager | null,
  timeoutMs: number = CODEX_ACCOUNT_USAGE_TIMEOUT_MS,
): Promise<CodexAccountUsage | null> {
  if (manager === null) return null;
  try {
    await manager.ensureRunning();
    const connection = await manager.connectIfRunning(timeoutMs);
    if (connection === null) return null;
    try {
      return parseCodexAccountUsage(await connection.request("account/rateLimits/read", undefined));
    } finally {
      connection.close();
    }
  } catch {
    return null;
  }
}

/**
 * `account/rateLimits/read` 応答を `CodexAccountUsage` へ落とす（純ロジック, TESTABLE）。
 *
 * 形式は寛容に読む: `rateLimits` 包みでも素の `{primary,secondary}` でも、キーが
 * camelCase（v2）でも snake_case（旧 rollout 互換）でも拾う。1 枠も読めなければ null。
 */
export function parseCodexAccountUsage(raw: unknown): CodexAccountUsage | null {
  const root = objectRecord(raw);
  if (root === null) return null;
  const limits = objectRecord(root["rateLimits"]) ?? objectRecord(root["rate_limits"]) ?? root;

  const result: CodexAccountUsage = {};
  const planType = firstString(limits["planType"], limits["plan_type"], root["planType"], root["plan_type"]);
  if (planType !== undefined) result.planType = planType;

  // 枠は duration で分類する（位置は保証されない — ファイル冒頭コメント参照）。
  // 同じ枠へ 2 つ写ろうとしたら先勝ち（primary が主バケット）。
  for (const [raw, positional] of [
    [limits["primary"], "fiveHour"],
    [limits["secondary"], "weekly"],
  ] as const) {
    const window = parseWindow(raw);
    if (window.percent === undefined) continue;
    const bucket =
      window.durationMins !== undefined
        ? window.durationMins <= FIVE_HOUR_MAX_DURATION_MINS
          ? "fiveHour"
          : "weekly"
        : positional;
    if (bucket === "fiveHour" && result.fiveHourPercent === undefined) {
      result.fiveHourPercent = window.percent;
      if (window.resetsAt !== undefined) result.fiveHourResetsAt = window.resetsAt;
    } else if (bucket === "weekly" && result.weeklyPercent === undefined) {
      result.weeklyPercent = window.percent;
      if (window.resetsAt !== undefined) result.weeklyResetsAt = window.resetsAt;
    }
  }

  // planType だけでは「使用量」を語れない。1 枠も読めなければ未取得として扱う。
  if (result.fiveHourPercent === undefined && result.weeklyPercent === undefined) return null;
  return result;
}

/** 「5時間枠」とみなす window 長の上限（分）。それ超（週次=10080 等）は週次枠。 */
const FIVE_HOUR_MAX_DURATION_MINS = 1_440;

/** 1 枠から使用率（丸め）・リセット時刻（ISO）・window 長（分）を取り出す。 */
function parseWindow(raw: unknown): { percent?: number; resetsAt?: string; durationMins?: number } {
  const window = objectRecord(raw);
  if (window === null) return {};
  const used = firstNumber(window["usedPercent"], window["used_percent"]);
  const resets = firstNumber(window["resetsAt"], window["resets_at"]);
  const duration = firstNumber(
    window["windowDurationMins"],
    window["windowMinutes"],
    window["window_duration_mins"],
    window["window_minutes"],
  );
  return {
    ...(used !== undefined ? { percent: Math.round(used) } : {}),
    // resets_at は Unix 秒。ワイヤーは ISO 文字列で運ぶ。
    ...(resets !== undefined ? { resetsAt: new Date(Math.floor(resets) * 1_000).toISOString() } : {}),
    ...(duration !== undefined ? { durationMins: duration } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
