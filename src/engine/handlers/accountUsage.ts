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
  ClaudeExtraUsage,
  ClaudeLimitReset,
  CodexAccountUsage,
  HostVersions,
} from "../../protocol/messages.js";
import type { AccountIdentities } from "../../services/accountIdentity.js";
import { isPlanUsageFailure, type PlanUsageFailure } from "../../services/planUsageFetcher.js";
import type { HandlerContext, HandlerRegistry } from "../context.js";
import { createOpenAIApiUsageProvider, type OpenAIApiUsageProvider } from "../../services/openaiApiUsage.js";
import { createClaudeApiUsageProvider } from "../../services/claudeApiUsage.js";

/** Claude 側 TTL（ms）。使用量 API は分解能が粗く、2 分で十分新しい。 */
export const CLAUDE_ACCOUNT_USAGE_TTL_MS = 120_000;

/** Codex 側 TTL（ms）。App Server 経由なので Claude より短くできる。 */
export const CODEX_ACCOUNT_USAGE_TTL_MS = 60_000;

/**
 * Claude が `login_required`（候補ゼロ / 全候補 401）で失敗したときだけ使う短い TTL（ms）。
 * `/login` し直しの直後にシートを更新して復旧を見せるため。通信断（unavailable）や Codex の
 * 失敗は従来 TTL のまま（オフライン中に 15s ごとに候補×5s timeout や App Server 起動試行を
 * 繰り返すと、アプリの RPC timeout 12s に対して応答が遅れる）。
 */
export const ACCOUNT_USAGE_FAILURE_TTL_MS = 15_000;

/** Claude 側の取得失敗時に返す理由文（iOS はこれをそのままカードへ出す）。 */
export const CLAUDE_ACCOUNT_USAGE_ERROR =
  "Claude の使用量を取得できませんでした（OAuth トークン無効またはオフライン）。";

/**
 * Claude のログインが切れている（候補ゼロ・全候補 401）ときの理由文。
 * 「トークン無効またはオフライン」の二択を利用者に押し付けず、復旧手順（会話で /login）まで示す。
 */
export const CLAUDE_ACCOUNT_USAGE_LOGIN_REQUIRED =
  "Claude のログインが切れています。会話で /login を実行してログインし直してください。";

/** 使用量 API が 429（問い合わせ過多）を返したときの理由文。 */
export const CLAUDE_ACCOUNT_USAGE_RATE_LIMITED =
  "Claude の使用量の問い合わせが多すぎるため、一時的に取得できません。しばらくしてから更新してください。";

/** Codex 側の取得失敗時に返す理由文。 */
export const CODEX_ACCOUNT_USAGE_ERROR =
  "Codex の使用量を取得できませんでした（Codex App Server に接続できません）。";

export interface AccountUsageHandlerOptions {
  openaiApiUsage?: OpenAIApiUsageProvider;
  claudeApiUsage?: OpenAIApiUsageProvider;
  /** 現在時刻（ms）。テストは固定値/進行を注入して TTL を決定化する。 */
  now?: () => number;
  claudeTtlMs?: number;
  codexTtlMs?: number;
  /** 失敗エントリの TTL（既定 ACCOUNT_USAGE_FAILURE_TTL_MS）。 */
  failureTtlMs?: number;
}

/** 1 agent 分の TTL メモ（成功なら value、失敗なら value=null と分類 failure）。 */
interface CacheEntry<T> {
  atMs: number;
  value: T | null;
  /** 失敗の分類（分かるときだけ。null は理由不明 / 成功）。 */
  failure: PlanUsageFailure | null;
  /** 値の実際の取得時刻（前回値を返したときは atMs より古い）。fetchedAt はこちらを使う。 */
  dataAtMs?: number;
  /** 前回値・429 は取得ガードが API を叩かないので、短い TTL で見直して復旧を早く見せる。 */
  shortTtl?: boolean;
}

/** キャッシュが TTL 内か（`login_required` の失敗エントリだけ短い failureTtlMs で判定する）。 */
function cacheFresh<T>(
  entry: CacheEntry<T> | null,
  nowMs: number,
  successTtlMs: number,
  failureTtlMs: number,
): entry is CacheEntry<T> {
  if (entry === null) return false;
  const ttl = entry.shortTtl === true || (entry.value === null && entry.failure === "login_required")
    ? failureTtlMs : successTtlMs;
  return nowMs - entry.atMs < ttl;
}

/** Claude 側の失敗理由文（分類に応じて出し分け）。 */
export function claudeAccountUsageErrorText(failure: PlanUsageFailure | null): string {
  if (failure === "rate_limited") return CLAUDE_ACCOUNT_USAGE_RATE_LIMITED;
  return failure === "login_required"
    ? CLAUDE_ACCOUNT_USAGE_LOGIN_REQUIRED
    : CLAUDE_ACCOUNT_USAGE_ERROR;
}

/**
 * Claude usage が同じ OAuth token で account 解決を試みた印。
 * non-enumerable Symbol は JSON に出ず、dropExpiredWindows が加工後のコピーへ明示継承する。
 */
const CLAUDE_ACCOUNT_FROM_USAGE_TOKEN = Symbol("claudeAccountFromUsageToken");

/**
 * account_usage ハンドラを作る。TTL メモを閉包に持つため、テストは独自インスタンスを
 * 生成して互いに干渉させない（ENGINE_HANDLERS 側は engine プロセス全体で 1 つを共有する）。
 */
export function createAccountUsageHandlers(
  options: AccountUsageHandlerOptions = {},
): HandlerRegistry {
  const now = options.now ?? (() => Date.now());
  const openaiApiUsage = options.openaiApiUsage ?? createOpenAIApiUsageProvider({ now: () => new Date(now()) });
  const claudeApiUsage = options.claudeApiUsage ?? createClaudeApiUsageProvider({ now: () => new Date(now()) });
  const claudeTtlMs = options.claudeTtlMs ?? CLAUDE_ACCOUNT_USAGE_TTL_MS;
  const codexTtlMs = options.codexTtlMs ?? CODEX_ACCOUNT_USAGE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? ACCOUNT_USAGE_FAILURE_TTL_MS;

  let claudeCache: CacheEntry<ClaudeAccountUsage> | null = null;
  let codexCache: CacheEntry<CodexAccountUsage> | null = null;

  async function loadClaude(ctx: HandlerContext): Promise<CacheEntry<ClaudeAccountUsage>> {
    const at = now();
    if (cacheFresh(claudeCache, at, claudeTtlMs, failureTtlMs)) return claudeCache;
    let value: ClaudeAccountUsage | null = null;
    let failure: PlanUsageFailure | null = null;
    let dataAtMs: number | undefined;
    let shortTtl = false;
    try {
      const result = await ctx.planUsage();
      if (isPlanUsageFailure(result)) {
        failure = result.failure;
        shortTtl = result.failure === "rate_limited";
      } else {
        value = toClaudeAccountUsage(result);
        // ガードが前回値を返したとき（間引き・429・通信断）も、fetchedAt は実際の取得時刻にする。
        if (result !== null && result.fetchedAtMs !== undefined) dataAtMs = result.fetchedAtMs;
        if (result !== null && value !== null && result.stale !== undefined && result.fetchedAtMs !== undefined) {
          value = {
            ...value,
            stale: {
              reason: result.stale.reason,
              fetchedAt: new Date(result.fetchedAtMs).toISOString(),
              ...(result.stale.retryAtMs !== undefined
                ? { retryAt: new Date(result.stale.retryAtMs).toISOString() } : {}),
            },
          };
          // 429 中はガードが API を叩かないので、短い TTL で見直して解除後すぐ戻す。
          // 通信断は従来どおりの TTL（オフライン中に候補×timeout を繰り返さない）。
          shortTtl = result.stale.reason === "rate_limited";
        }
      }
    } catch {
      value = null;
    }
    claudeCache = {
      atMs: at, value, failure,
      ...(dataAtMs !== undefined ? { dataAtMs } : {}),
      ...(shortTtl ? { shortTtl } : {}),
    };
    return claudeCache;
  }

  async function loadCodex(ctx: HandlerContext): Promise<CacheEntry<CodexAccountUsage>> {
    const at = now();
    const ttl = codexCache?.value?.monthlyCreditsError === undefined
      ? codexTtlMs : Math.min(codexTtlMs, failureTtlMs);
    if (cacheFresh(codexCache, at, ttl, failureTtlMs)
      && new Date(codexCache.atMs).toISOString().slice(0, 7) === new Date(at).toISOString().slice(0, 7)) {
      return codexCache;
    }
    let value: CodexAccountUsage | null = null;
    try {
      value = await ctx.codexAccountUsage();
    } catch {
      value = null;
    }
    codexCache = { atMs: at, value, failure: null };
    return codexCache;
  }

  /**
   * ホストのバージョン・診断情報。CLI 更新や環境変更を refresh へ反映するため
   * TTL メモには載せない。provider 側の診断 timeout 後は、取れた情報だけを返す。
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
    api_usage_options_request: (message, ctx) => {
      ctx.writer.write({ type: "api_usage_options_response", v: ctx.state.negotiatedVersion, id: message.id, supported: true });
    },
    account_usage_request: async (message, ctx) => {
      const { writer, state } = ctx;
      const v = state.negotiatedVersion;
      // 各系統は独立。登録済み管理キーの API 利用額はサブスクと混ぜない。
      const [claude, codex, host, accounts, api, claudeApi] = await Promise.all([
        loadClaude(ctx),
        loadCodex(ctx),
        loadHost(ctx),
        loadAccounts(ctx),
        openaiApiUsage(message.apiCredentials?.openai).catch(() => ({ error: "unavailable" as const })),
        claudeApiUsage(message.apiCredentials?.claude).catch(() => ({ error: "unavailable" as const })),
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
            : { claudeError: claudeAccountUsageErrorText(claude.failure) }),
          ...(codexValue !== null
            ? { codex: codexValue }
            : { codexError: CODEX_ACCOUNT_USAGE_ERROR }),
          ...(host !== null ? { host } : {}),
          ...(api !== null ? ("value" in api ? { openaiApi: api.value } : { openaiApiError: api.error }) : {}),
          ...(claudeApi !== null ? ("value" in claudeApi ? { claudeApi: claudeApi.value } : { claudeApiError: claudeApi.error }) : {}),
          fetchedAt: new Date(Math.min(claude.dataAtMs ?? claude.atMs, codex.atMs,
            ...(api && "value" in api && Number.isFinite(Date.parse(api.value.fetchedAt))
              ? [Date.parse(api.value.fetchedAt)] : []),
            ...(claudeApi && "value" in claudeApi && Number.isFinite(Date.parse(claudeApi.value.fetchedAt))
              ? [Date.parse(claudeApi.value.fetchedAt)] : []))).toISOString(),
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
  // Claude usage が「実際に成功した同じ token」の profile から account を持つ場合は、
  // 別認証源になり得る `claude auth status` のフォールバック値で上書きしない。
  const sameTokenResolved = (
    usage as ClaudeAccountUsage & { [CLAUDE_ACCOUNT_FROM_USAGE_TOKEN]?: true }
  )[CLAUDE_ACCOUNT_FROM_USAGE_TOKEN] === true;
  // Codex は月間取得の失敗時も同じ App Server の account/read に表示元を固定する。
  const codexAccountResolved = ("monthlyCredits" in usage && usage.monthlyCredits !== undefined)
    || ("monthlyCreditsError" in usage && usage.monthlyCreditsError !== undefined);
  return account === undefined || usage.account !== undefined || sameTokenResolved || codexAccountResolved
    ? usage
    : { ...usage, account };
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
  const sameTokenResolved = (
    usage as ClaudeAccountUsage & { [CLAUDE_ACCOUNT_FROM_USAGE_TOKEN]?: true }
  )[CLAUDE_ACCOUNT_FROM_USAGE_TOKEN] === true;
  const result: Record<string, unknown> = { ...usage };
  for (const [percentKey, resetsKey] of windows) {
    const iso = result[resetsKey];
    if (typeof iso !== "string") continue;
    const resetsAtMs = Date.parse(iso);
    if (!Number.isFinite(resetsAtMs) || resetsAtMs > nowMs) continue;
    delete result[percentKey];
    delete result[resetsKey];
  }
  if (sameTokenResolved) {
    Object.defineProperty(result, CLAUDE_ACCOUNT_FROM_USAGE_TOKEN, { value: true });
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
    /** 使用量取得に成功した同じ OAuth token のマスク済みアカウント。 */
    account?: string | null;
    extraUsage?: ClaudeExtraUsage;
    limitResets?: ClaudeLimitReset[];
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
    ...(plan.extraUsage !== undefined ? { extraUsage: plan.extraUsage } : {}),
    // プランバッジ用の生値（credentials 由来。アクセストークンは決して載せない）。
    ...(plan.subscriptionType ? { plan: plan.subscriptionType } : {}),
    ...(plan.rateLimitTier ? { rateLimitTier: plan.rateLimitTier } : {}),
    ...(plan.account ? { account: plan.account } : {}),
    ...(plan.limitResets !== undefined ? { limitResets: plan.limitResets } : {}),
  };
  // undefined は旧provider/fixture（auth status fallback可）、null は同tokenで解決不能
  // （別認証源のアカウントを誤表示しないため fallback 不可）。
  if (plan.account !== undefined) {
    Object.defineProperty(usage, CLAUDE_ACCOUNT_FROM_USAGE_TOKEN, { value: true });
  }
  if (
    usage.fiveHourPercent === undefined &&
    usage.sevenDayPercent === undefined &&
    usage.premiumPercent === undefined && usage.extraUsage === undefined
  ) {
    return null;
  }
  return usage;
}
