// engine/handlers/accountUsage.ts
// アカウント使用量（account-usage）: Claude（OAuth 使用量 API）と Codex（App Server の
// account/rateLimits/read）の使用率を 1 応答へまとめて返す。session 非依存（会話を 1 件も
// 開いていない一覧画面から呼ばれるため）。
//
// 設計:
//   - agent ごとに独立。片方が失敗しても、もう片方は必ず表示できるようにする
//     （失敗側は object を省略し `claudeError` / `codexError` に理由文を載せる）。
//   - error 封筒は使わない。「両方失敗」も正常な応答形として返す（シートが空にならない）。
//   - agent 別 TTL メモを持ち、シートの連打で外部 API を叩かない。TTL 内は前回値を返し、
//     `fetchedAt` は実際に取得した時刻のまま（最も古い方）を載せる — 表示が「いつの値か」で嘘をつかない。
//   - 成功だけでなく失敗もキャッシュする（TTL の目的が外部 API の保護なので、失敗連打も止める）。

import type {
  ClaudeAccountUsage,
  CodexAccountUsage,
  HostVersions,
} from "../../protocol/messages.js";
import type { AccountIdentities } from "../../services/accountIdentity.js";
import type { HandlerContext, HandlerRegistry } from "../context.js";

/** Claude 側 TTL（ms）。使用量 API は分解能が粗く、2 分で十分新しい。 */
export const CLAUDE_ACCOUNT_USAGE_TTL_MS = 120_000;

/** Codex 側 TTL（ms）。App Server 経由なので Claude より短くできる。 */
export const CODEX_ACCOUNT_USAGE_TTL_MS = 60_000;

/** Claude 側の取得失敗時に返す理由文（iOS はこれをそのままカードへ出す）。 */
export const CLAUDE_ACCOUNT_USAGE_ERROR =
  "Claude の使用量を取得できませんでした（OAuth トークン無効またはオフライン）。";

/** Codex 側の取得失敗時に返す理由文。 */
export const CODEX_ACCOUNT_USAGE_ERROR =
  "Codex の使用量を取得できませんでした（Codex App Server に接続できません）。";

export interface AccountUsageHandlerOptions {
  /** 現在時刻（ms）。テストは固定値/進行を注入して TTL を決定化する。 */
  now?: () => number;
  claudeTtlMs?: number;
  codexTtlMs?: number;
}

/** 1 agent 分の TTL メモ（成功なら value、失敗なら value=null）。 */
interface CacheEntry<T> {
  atMs: number;
  value: T | null;
}

/**
 * account_usage ハンドラを作る。TTL メモを閉包に持つため、テストは独自インスタンスを
 * 生成して互いに干渉させない（ENGINE_HANDLERS 側は engine プロセス全体で 1 つを共有する）。
 */
export function createAccountUsageHandlers(
  options: AccountUsageHandlerOptions = {},
): HandlerRegistry {
  const now = options.now ?? (() => Date.now());
  const claudeTtlMs = options.claudeTtlMs ?? CLAUDE_ACCOUNT_USAGE_TTL_MS;
  const codexTtlMs = options.codexTtlMs ?? CODEX_ACCOUNT_USAGE_TTL_MS;

  let claudeCache: CacheEntry<ClaudeAccountUsage> | null = null;
  let codexCache: CacheEntry<CodexAccountUsage> | null = null;

  async function loadClaude(ctx: HandlerContext): Promise<CacheEntry<ClaudeAccountUsage>> {
    const at = now();
    if (claudeCache !== null && at - claudeCache.atMs < claudeTtlMs) return claudeCache;
    let value: ClaudeAccountUsage | null = null;
    try {
      value = toClaudeAccountUsage(await ctx.planUsage());
    } catch {
      value = null;
    }
    claudeCache = { atMs: at, value };
    return claudeCache;
  }

  async function loadCodex(ctx: HandlerContext): Promise<CacheEntry<CodexAccountUsage>> {
    const at = now();
    if (codexCache !== null && at - codexCache.atMs < codexTtlMs) return codexCache;
    let value: CodexAccountUsage | null = null;
    try {
      value = await ctx.codexAccountUsage();
    } catch {
      value = null;
    }
    codexCache = { atMs: at, value };
    return codexCache;
  }

  /**
   * ホストのバージョン情報（プロセス内キャッシュは provider 側が持つ）。
   * 使用量とは独立なので TTL メモには載せず、失敗は「載せない」だけで済ませる。
   */
  async function loadHost(ctx: HandlerContext): Promise<HostVersions | null> {
    try {
      return await ctx.hostVersions();
    } catch {
      return null;
    }
  }

  /** ログイン中アカウント（マスク済み）。取れなくても使用量表示は続ける。 */
  async function loadAccounts(ctx: HandlerContext): Promise<AccountIdentities> {
    try {
      return await ctx.accountIdentity();
    } catch {
      return {};
    }
  }

  return {
    account_usage_request: async (message, ctx) => {
      const { writer, state } = ctx;
      const v = state.negotiatedVersion;
      // 4 系統は独立。片方の失敗・遅延がもう片方を巻き込まないよう並行に取る。
      const [claude, codex, host, accounts] = await Promise.all([
        loadClaude(ctx),
        loadCodex(ctx),
        loadHost(ctx),
        loadAccounts(ctx),
      ]);
      // TTL メモの値は共有物。加工は必ずコピーの上で行う（キャッシュを汚さない）。
      const nowMs = now();
      const claudeValue =
        claude.value === null
          ? null
          : dropExpiredWindows(
              withAccount(claude.value, accounts.claude),
              nowMs,
              CLAUDE_WINDOW_KEYS,
            );
      const codexValue =
        codex.value === null
          ? null
          : dropExpiredWindows(withAccount(codex.value, accounts.codex), nowMs, CODEX_WINDOW_KEYS);
      try {
        writer.write({
          type: "account_usage_response",
          v,
          id: message.id,
          ...(claudeValue !== null
            ? { claude: claudeValue }
            : { claudeError: CLAUDE_ACCOUNT_USAGE_ERROR }),
          ...(codexValue !== null
            ? { codex: codexValue }
            : { codexError: CODEX_ACCOUNT_USAGE_ERROR }),
          ...(host !== null ? { host } : {}),
          fetchedAt: new Date(Math.min(claude.atMs, codex.atMs)).toISOString(),
        });
      } catch {
        // 書込失敗（チャネル断）は握り潰す。
      }
    },
  };
}

/** Claude 側の「使用率 / リセット時刻」の対応表（枠ごとにペアで落とすため）。 */
export const CLAUDE_WINDOW_KEYS = [
  ["fiveHourPercent", "fiveHourResetsAt"],
  ["sevenDayPercent", "sevenDayResetsAt"],
  ["premiumPercent", "premiumResetsAt"],
] as const;

/** Codex 側の「使用率 / リセット時刻」の対応表。 */
export const CODEX_WINDOW_KEYS = [
  ["fiveHourPercent", "fiveHourResetsAt"],
  ["weeklyPercent", "weeklyResetsAt"],
] as const;

/** マスク済みアカウントを載せたコピーを返す（undefined なら素通し, 純ロジック）。 */
export function withAccount<T extends ClaudeAccountUsage | CodexAccountUsage>(
  usage: T,
  account: string | undefined,
): T {
  return account === undefined ? usage : { ...usage, account };
}

/**
 * リセット済み（`resetsAt <= now`）の枠を落とす（純ロジック, TESTABLE）。
 *
 * リセット後の % は「次の枠の実績」ではなく**前の枠の残骸**で、そのまま出すと嘘になる。
 * 使用率とリセット時刻はペアで落とす（片方だけ残すと表示が壊れる）。
 * `resetsAt` が無い/読めない枠は落とさない — 判定不能なだけで、古いとは限らない。
 * 枠が全部落ちても `plan` / `account` は残す（カードは出て、枠行が無いだけになる）。
 */
export function dropExpiredWindows<T extends ClaudeAccountUsage | CodexAccountUsage>(
  usage: T,
  nowMs: number,
  windows: readonly (readonly [string, string])[],
): T {
  const result: Record<string, unknown> = { ...usage };
  for (const [percentKey, resetsKey] of windows) {
    const iso = result[resetsKey];
    if (typeof iso !== "string") continue;
    const resetsAtMs = Date.parse(iso);
    if (!Number.isFinite(resetsAtMs) || resetsAtMs > nowMs) continue;
    delete result[percentKey];
    delete result[resetsKey];
  }
  return result as T;
}

/**
 * `PlanUsage`（OAuth 使用量 API）を wire の `ClaudeAccountUsage` へ写す（純ロジック, TESTABLE）。
 * 全枠が null（= 何も読めなかった）なら null を返し、呼び出し側で claudeError へ落とす。
 */
export function toClaudeAccountUsage(
  plan: {
    fiveHourUtilization: number | null;
    fiveHourResetsAt: string | null;
    sevenDayUtilization: number | null;
    sevenDayResetsAt: string | null;
    sevenDayFableUtilization: number | null;
    sevenDayFableResetsAt: string | null;
    /** credentials 由来の契約種別（無くても使用量は表示できるので optional）。 */
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
  } | null,
): ClaudeAccountUsage | null {
  if (plan === null) return null;
  const usage: ClaudeAccountUsage = {
    ...(plan.fiveHourUtilization !== null && { fiveHourPercent: plan.fiveHourUtilization }),
    ...(plan.fiveHourResetsAt !== null && { fiveHourResetsAt: plan.fiveHourResetsAt }),
    ...(plan.sevenDayUtilization !== null && { sevenDayPercent: plan.sevenDayUtilization }),
    ...(plan.sevenDayResetsAt !== null && { sevenDayResetsAt: plan.sevenDayResetsAt }),
    // premium = 上位モデルの週次枠（PlanUsage の sevenDayFable*）。
    ...(plan.sevenDayFableUtilization !== null && { premiumPercent: plan.sevenDayFableUtilization }),
    ...(plan.sevenDayFableResetsAt !== null && { premiumResetsAt: plan.sevenDayFableResetsAt }),
    // プランバッジ用の生値（credentials 由来。アクセストークンは決して載せない）。
    ...(plan.subscriptionType ? { plan: plan.subscriptionType } : {}),
    ...(plan.rateLimitTier ? { rateLimitTier: plan.rateLimitTier } : {}),
  };
  if (
    usage.fiveHourPercent === undefined &&
    usage.sevenDayPercent === undefined &&
    usage.premiumPercent === undefined
  ) {
    return null;
  }
  return usage;
}
