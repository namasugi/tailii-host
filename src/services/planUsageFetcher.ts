// planUsageFetcher.ts
// tailii (TS host) — プラン使用状況の取得（Claude Code OAuth 使用量 API）
// Swift 版 PlanUsageFetcher.swift の移植。
// 認証は Mac 上の Claude Code が保存した OAuth トークン
// （Keychain → Keychain ミラー → file の順、期限切れは後回し）。
// Keychain は sshd 文脈（SSH spawn の engine）から読めないため、GUI 文脈で読めたときに
// ミラー（keychainMirror.ts）へ残し、SSH 文脈は有効期限内のミラーを第2候補として使う。
// 取得不能・オフラインは null（usage 応答の plan 系フィールドは省略 = ベストエフォート）。
// 秘密の扱い: アクセストークンは本プロセス内でのみ使い、ログ・チャネルへは載せない。

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { maskEmail } from "./accountIdentity.js";
import {
  refreshClaudeCredentialFile,
  shouldRefreshClaudeCredential,
  type RefreshedClaudeCredential,
} from "./claudeCredentialRefresh.js";
import { readKeychainMirror, writeKeychainMirror } from "./keychainMirror.js";
import { parseCliVersion } from "./hostVersions.js";
import { defaultInjectedPath } from "../commands/launch.js";
import type { ClaudeExtraUsage, ClaudeLimitReset } from "../protocol/messages.js";

/**
 * プラン使用状況（5時間枠/7日枠/上位モデル週間枠の使用率とリセット時刻）。
 *
 * `subscriptionType` / `rateLimitTier` は使用量 API 応答ではなく **credentials JSON 由来**
 * （`claudeAiOauth.subscriptionType` / `.rateLimitTier`）。実際に使用量取得へ成功した
 * トークン候補のものを載せる（プランバッジ表示用の生値。整形は iOS 側の責務）。
 */
export interface PlanUsage {
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
  sevenDayFableUtilization: number | null;
  sevenDayFableResetsAt: string | null;
  extraUsage?: ClaudeExtraUsage;
  /** 付与済みの利用枠リセット権。欠落は不明、空配列は「なし」。 */
  limitResets?: ClaudeLimitReset[];
  /** 契約種別の生値（"max" / "pro" 等）。credentials に無ければ null。 */
  subscriptionType: string | null;
  /** レート制限ティアの生値（"default_claude_max_20x" 等）。credentials に無ければ null。 */
  rateLimitTier: string | null;
  /** 実際に使用量取得へ成功した同じ OAuth token のアカウント（host 側でマスク済み）。 */
  account?: string | null;
  /** この値を実際に取得した時刻（ms epoch）。`createGuardedPlanUsage` が付ける。 */
  fetchedAtMs?: number;
  /** 最新を取れず、前回値を返しているときの理由（`createGuardedPlanUsage` が付ける）。 */
  stale?: PlanUsageStale;
  /** 取得に成功した認証の指紋（ガードが前回値の持ち主を判定する。ワイヤーへは出さない）。 */
  credentialFingerprint?: string;
}

/** 前回値を返している理由。`retryAtMs` は 429 で問い合わせを控えている期限。 */
export interface PlanUsageStale {
  reason: "rate_limited" | "unavailable";
  retryAtMs?: number;
}

/** 使用量 API のエンドポイント（Claude Code 本体・statusline ツールと同じ）。 */
export const PLAN_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/**
 * 実際に叩く URL。`cedar_ember=1` を付けると、通常の使用枠に加えて
 * 利用枠リセット権（`cedar_ember`）も同じ応答で返る（Claude Code の `/limit-reset` と同じ読み口）。
 */
export const PLAN_USAGE_URL = `${PLAN_USAGE_ENDPOINT}?cedar_ember=1`;

/**
 * User-Agent の版が取れないときの既定値。サーバーは `claude-cli/` 名乗りの問い合わせにだけ
 * リセット権を返す（他の名乗りは `ineligible_reason: "surface"`）。2026-11-10 に 2.1.321 で実測。
 */
const FALLBACK_CLAUDE_CLI_VERSION = "2.1.321";
const CLAUDE_CLI_VERSION_TTL_MS = 10 * 60_000;
let cachedClaudeCliVersion: { value: string; atMs: number } | null = null;

let pendingClaudeCliVersion: Promise<void> | null = null;

/**
 * User-Agent 用に、このホストの Claude Code の版を返す（10 分キャッシュ・未取得は既定値）。
 * `claude --version` は待たない（使用量応答の待ち時間を増やさない）。裏で読み、次回から使う。
 */
function claudeCliVersionForUserAgent(): string {
  const now = Date.now();
  if (cachedClaudeCliVersion === null || now - cachedClaudeCliVersion.atMs >= CLAUDE_CLI_VERSION_TTL_MS) {
    pendingClaudeCliVersion ??= readClaudeCliVersion().finally(() => { pendingClaudeCliVersion = null; });
  }
  return cachedClaudeCliVersion?.value ?? FALLBACK_CLAUDE_CLI_VERSION;
}

async function readClaudeCliVersion(): Promise<void> {
  const now = Date.now();
  const raw = await new Promise<string | null>((resolve) => {
    execFile(
      "claude",
      ["--version"],
      {
        cwd: os.homedir(),
        timeout: 3_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          PATH: [defaultInjectedPath(), process.env["PATH"] ?? ""].filter(Boolean).join(":"),
        },
      },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
  const parsed = parseCliVersion(raw);
  const value = parsed !== undefined && /^\d+\.\d+/.test(parsed) ? parsed : FALLBACK_CLAUDE_CLI_VERSION;
  cachedClaudeCliVersion = { value, atMs: now };
}

/** 使用量 API へ名乗る User-Agent（このホストの Claude Code と同じ形）。 */
export function claudeCliUserAgent(version: string): string {
  return `claude-cli/${version} (external, cli)`;
}

/** 使用量と同じ OAuth token の表示アカウントを確定する profile endpoint。 */
export const CLAUDE_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";

/**
 * トークン候補（値と有効期限 ms epoch、および同じ credentials に載っていたプラン情報）。
 *
 * 秘密の扱い: `token` は本プロセス内でのみ使う。ログ・ワイヤーへは決して載せない
 * （ワイヤーへ出るのは `subscriptionType` / `rateLimitTier` だけ）。
 */
export interface Credential {
  token: string;
  expiresAtMs: number | null;
  /** credentials JSON の `subscriptionType`（無ければ省略）。 */
  subscriptionType?: string;
  /** credentials JSON の `rateLimitTier`（無ければ省略）。 */
  rateLimitTier?: string;
}

/**
 * 認証源。SSH/file と GUI Keychain のアカウントを混同しないため候補と一緒に運ぶ。
 * `keychain-mirror` は Keychain 不達文脈（SSH spawn の engine）が使う読取専用コピーで、
 * refresh には決して使わない（ローテーションで GUI 側のログインを壊すため）。
 */
export interface SourcedCredential extends Credential {
  source: "keychain" | "keychain-mirror" | "file";
}

/**
 * OAuth API 1回分の結果。401だけを refresh/retry 対象として区別する。
 * `rate_limited`（429）は同じアカウントの制限なので、他の候補も試さずに止める。
 */
export type ClaudeOAuthAttempt<T> =
  | { kind: "success"; value: T }
  | { kind: "unauthorized" }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "failure" };

export interface ClaudeOAuthResolution<T> {
  value: T;
  credential: Credential;
}

/**
 * 認証解決の失敗分類。
 * - `no_credentials`: 試せる候補が 1 つも無い（未ログイン / ミラー期限切れのみ）
 * - `unauthorized`: 全候補が 401（期限切れ・失効。refresh も効かなかった）
 * - `failure`: 通信断・5xx・応答不正が 1 件でもあった（ログイン状態は判定不能）
 */
export type ClaudeOAuthFailure = "no_credentials" | "unauthorized" | "rate_limited" | "failure";

/** 認証解決の結果（成功なら resolution、失敗なら failure に分類）。 */
export interface ClaudeOAuthOutcome<T> {
  resolution: ClaudeOAuthResolution<T> | null;
  failure: ClaudeOAuthFailure | null;
  /** 429 を受けたとき、サーバーが指示した待ち時間（ms）。指示なしは null。 */
  rateLimitedRetryAfterMs?: number | null;
}

/** 共通認証実行器の注入点（テストは実 Keychain/file/token endpoint に触れない）。 */
export interface ClaudeOAuthExecutionOptions {
  candidates?: readonly SourcedCredential[];
  refreshFile?: () => Promise<RefreshedClaudeCredential | null>;
  now?: () => number;
  timeoutSeconds?: number;
}

/** Keychain コマンド実行境界。テストでは秘密を含まないダミー JSON を返す。 */
export type CredentialCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<string | null>;

/**
 * 使用量取得の失敗分類（account_usage の理由文の出し分け用）。
 * - `login_required`: 候補ゼロ、または全候補 401 → 「/login し直し」を案内できる
 * - `unavailable`: 通信断・API 異常 → オフライン扱い（ログイン状態は不明）
 * - `rate_limited`: 429（問い合わせ過多）→ `retryAtMs` まで問い合わせを控える
 */
export type PlanUsageFailure = "login_required" | "unavailable" | "rate_limited";

/** `fetchPlanUsage` の失敗結果（null ではなく理由を運ぶ）。 */
export interface PlanUsageFailureResult {
  failure: PlanUsageFailure;
  /** `rate_limited` のとき、問い合わせを控える残り時間（ms）。 */
  retryAfterMs?: number;
}

/** 429 で Retry-After が無いときの待ち時間（Claude Code 本体と同じ 5 分）。 */
export const PLAN_USAGE_RATE_LIMIT_DEFAULT_MS = 5 * 60_000;
/** Retry-After を信じる上限（Claude Code 本体と同じ 1 時間）。 */
export const PLAN_USAGE_RATE_LIMIT_MAX_MS = 60 * 60_000;

/** 429 の待ち時間を決める（純ロジック, TESTABLE）。 */
export function planUsageRateLimitWaitMs(retryAfterMs: number | null | undefined): number {
  return retryAfterMs !== null && retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, PLAN_USAGE_RATE_LIMIT_MAX_MS)
    : PLAN_USAGE_RATE_LIMIT_DEFAULT_MS;
}

/** Retry-After ヘッダ（秒数 or HTTP 日付）を ms に直す（純ロジック, TESTABLE）。読めなければ null。 */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1_000);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

/** provider の戻り値が失敗分類か（PlanUsage には `failure` キーが無い）。 */
export function isPlanUsageFailure(
  value: PlanUsage | PlanUsageFailureResult | null,
): value is PlanUsageFailureResult {
  return value !== null && "failure" in value;
}

/**
 * engine へ注入するフェッチャの型（テストは () => null を注入する）。
 * null は「理由不明の失敗」（旧来互換）。理由が分かるときは PlanUsageFailureResult を返す。
 */
export type PlanUsageProvider = () => Promise<PlanUsage | PlanUsageFailureResult | null>;

/**
 * プラン使用状況を取得する（ベストエフォート・timeout 付き）。
 *
 * プラン情報（subscriptionType / rateLimitTier）は使用量 API ではなく、
 * **実際に取得へ成功した候補の credentials JSON** から採る（どのアカウントの使用量かと
 * バッジ表示が一致する）。
 */
export async function fetchPlanUsage(
  timeoutSeconds = 5,
): Promise<PlanUsage | PlanUsageFailureResult> {
  const outcome = await resolveClaudeOAuth(
    async (token): Promise<ClaudeOAuthAttempt<{ usage: PlanUsage; account: string | null; fingerprint: string }>> => {
      const usage = await fetchUsageOnce(token, timeoutSeconds);
      if (usage.kind !== "success") return usage;
      // アカウント表示は別の `claude auth status` ではなく、成功した同じ token から採る。
      const account = await fetchMaskedClaudeAccount(token, timeoutSeconds);
      return { kind: "success", value: { usage: usage.value, account, fingerprint: credentialFingerprint(token) } };
    },
    { timeoutSeconds },
  );
  const resolved = outcome.resolution;
  if (resolved === null && outcome.failure === "rate_limited") {
    return { failure: "rate_limited", retryAfterMs: planUsageRateLimitWaitMs(outcome.rateLimitedRetryAfterMs) };
  }
  if (resolved === null) {
    // 通信断が 1 件でも混じればログイン状態は断定できないので offline 扱い。
    // 候補ゼロ・全候補 401 だけを「ログインし直し」に分類する。
    return { failure: outcome.failure === "failure" ? "unavailable" : "login_required" };
  }
  return {
    ...resolved.value.usage,
    subscriptionType: resolved.credential.subscriptionType ?? null,
    rateLimitTier: resolved.credential.rateLimitTier ?? null,
    account: resolved.value.account,
    credentialFingerprint: resolved.value.fingerprint,
  };
}

/** 応答本文が Anthropic のエラー形（`{"error":{"type":...}}`）か。読めなければ false。 */
async function hasAnthropicErrorBody(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) return false;
    const error = (body as Record<string, unknown>)["error"];
    return typeof error === "object" && error !== null && typeof (error as Record<string, unknown>)["type"] === "string";
  } catch {
    return false;
  }
}

/** 前回値を代わりに返してよい古さの上限（1 時間。429 の最長待ちと同じ）。これより古い値は出さず、失敗として返す。 */
export const PLAN_USAGE_STALE_MAX_MS = 60 * 60_000;
/** この間隔以内の問い合わせは前回値で済ませ、API を叩かない（シートと会話の /usage の連打対策）。 */
export const PLAN_USAGE_MIN_INTERVAL_MS = 30_000;

/** OAuth トークンの指紋（sha256 の先頭 16 桁）。トークン自体は保存・送信しない。 */
export function credentialFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * ガードの状態（engine プロセスをまたいで共有する）。
 * engine は SSH / QUIC の接続ごとに立つため、メモリだけだと再接続で 429 の待ちも前回値も消える。
 */
export interface PlanUsageGuardState {
  /** この時刻（ms epoch）までは API を叩かない（429 の待ち）。 */
  blockedUntilMs: number;
  /** 待ちを記録した時刻。今がこれより前なら時計が巻き戻ったとみなし、待ちを解除する。 */
  blockedAtMs?: number;
  /** 最後に取れた値。`fingerprint` はその値を取った認証の指紋。 */
  lastGood: { usage: PlanUsage; atMs: number; fingerprint: string } | null;
}

export interface PlanUsageGuardStore {
  load(): PlanUsageGuardState | null;
  save(state: PlanUsageGuardState): void;
}

/** 既定の保存先（`~/.tailii/run/` は他のランタイム状態と同居）。 */
export function defaultPlanUsageGuardPath(): string {
  return path.join(os.homedir(), ".tailii", "run", "plan-usage-guard.json");
}

/** ファイル保存（0600・atomic rename・読めなければ null。失敗しても取得自体は続ける）。 */
export function filePlanUsageGuardStore(filePath: string = defaultPlanUsageGuardPath()): PlanUsageGuardStore {
  return {
    load() {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (typeof raw !== "object" || raw === null) return null;
        const obj = raw as Record<string, unknown>;
        const blockedUntilMs = typeof obj["blockedUntilMs"] === "number" ? obj["blockedUntilMs"] : 0;
        const blockedAtMs = typeof obj["blockedAtMs"] === "number" ? obj["blockedAtMs"] : undefined;
        const last = obj["lastGood"] as Record<string, unknown> | null | undefined;
        const lastGood = last && typeof last === "object" && typeof last["atMs"] === "number"
          && typeof last["fingerprint"] === "string" && typeof last["usage"] === "object" && last["usage"] !== null
          ? { usage: last["usage"] as PlanUsage, atMs: last["atMs"], fingerprint: last["fingerprint"] }
          : null;
        return { blockedUntilMs, ...(blockedAtMs !== undefined ? { blockedAtMs } : {}), lastGood };
      } catch {
        return null;
      }
    },
    save(state) {
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmpPath, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
      } catch {
        try { fs.unlinkSync(tmpPath); } catch { /* 無ければよい */ }
      }
    },
  };
}

/** メモリだけの保存（テスト・既定の注入用）。 */
export function memoryPlanUsageGuardStore(): PlanUsageGuardStore {
  let state: PlanUsageGuardState | null = null;
  return {
    load: () => (state === null ? null : { ...state }),
    save: (next) => { state = { ...next }; },
  };
}

export interface GuardedPlanUsageOptions {
  now?: () => number;
  staleMaxMs?: number;
  minIntervalMs?: number;
  store?: PlanUsageGuardStore;
  /**
   * 今ある認証候補の指紋。前回値はこの中に取得時の指紋があるときだけ使う
   * （/login で別アカウントに入り直した後に前のアカウントの値を出さない）。null は「不明 = 使わない」。
   */
  currentFingerprints?: () => Promise<ReadonlySet<string> | null>;
}

/**
 * 使用量取得の共通ガード（シート・会話の /usage の両方がこれを通る）。
 *
 * - 成功値を覚え、`minIntervalMs` 以内の再問い合わせは API を叩かずに返す
 * - 429 を受けたら Retry-After（無ければ 5 分・上限 1 時間）まで API を叩かない
 * - 429・通信断のとき、`staleMaxMs` 以内に取れた前回値があれば理由つきで返す
 * - ログイン切れ（`login_required`）は前回値で隠さず、そのまま失敗として返す
 * - 状態は `store` に置き、engine プロセス（接続）をまたいで効かせる
 */
export function createGuardedPlanUsage(
  fetchUsage: PlanUsageProvider,
  options: GuardedPlanUsageOptions = {},
): PlanUsageProvider {
  const now = options.now ?? (() => Date.now());
  const staleMaxMs = options.staleMaxMs ?? PLAN_USAGE_STALE_MAX_MS;
  const minIntervalMs = options.minIntervalMs ?? PLAN_USAGE_MIN_INTERVAL_MS;
  const store = options.store ?? memoryPlanUsageGuardStore();
  const currentFingerprints = options.currentFingerprints ?? (async () => null);
  let inFlight: Promise<PlanUsage | PlanUsageFailureResult | null> | null = null;

  /** 前回値が今の認証のものなら返す（古さの上限内に限る）。 */
  const usableLastGood = async (state: PlanUsageGuardState, at: number, maxAgeMs: number) => {
    const last = state.lastGood;
    if (last === null || at - last.atMs > maxAgeMs || at < last.atMs) return null;
    const fingerprints = await currentFingerprints().catch(() => null);
    return fingerprints !== null && fingerprints.has(last.fingerprint) ? last : null;
  };

  const staleOr = async (
    state: PlanUsageGuardState,
    reason: PlanUsageStale["reason"],
    failure: PlanUsageFailureResult | null,
    at: number,
  ): Promise<PlanUsage | PlanUsageFailureResult | null> => {
    const last = await usableLastGood(state, at, staleMaxMs);
    if (last === null) return failure;
    return {
      ...last.usage,
      fetchedAtMs: last.atMs,
      stale: { reason, ...(reason === "rate_limited" ? { retryAtMs: state.blockedUntilMs } : {}) },
    };
  };

  const run = async (): Promise<PlanUsage | PlanUsageFailureResult | null> => {
    const at = now();
    const loaded: PlanUsageGuardState = store.load() ?? { blockedUntilMs: 0, lastGood: null };
    // 記録時刻より前（時計の巻き戻り）や、上限（1 時間）より先の期限（壊れた保存値）は信じずに解除し、
    // 保存し直す（通信断が続いても壊れた期限がファイルに残らないように）。
    let state = loaded;
    if (loaded.blockedUntilMs > 0 && (loaded.blockedUntilMs - at > PLAN_USAGE_RATE_LIMIT_MAX_MS
      || (loaded.blockedAtMs !== undefined && at < loaded.blockedAtMs))) {
      const { blockedAtMs: _b, ...rest } = loaded;
      state = { ...rest, blockedUntilMs: 0 };
      store.save(state);
    }
    if (at < state.blockedUntilMs) {
      return staleOr(state, "rate_limited", { failure: "rate_limited", retryAfterMs: state.blockedUntilMs - at }, at);
    }
    const recent = await usableLastGood(state, at, minIntervalMs - 1);
    if (recent !== null) return { ...recent.usage, fetchedAtMs: recent.atMs };

    const result = await fetchUsage();
    const doneAt = now();
    if (result !== null && !isPlanUsageFailure(result)) {
      const { fetchedAtMs: _f, stale: _s, credentialFingerprint: fingerprint, ...usage } = result;
      store.save({
        blockedUntilMs: 0,
        lastGood: fingerprint === undefined ? null : { usage, atMs: doneAt, fingerprint },
      });
      return { ...usage, fetchedAtMs: doneAt };
    }
    if (result !== null && result.failure === "login_required") {
      // 別アカウントで入り直す可能性があるので、前のアカウントの値は捨てる。
      store.save({ blockedUntilMs: 0, lastGood: null });
      return result;
    }
    if (result !== null && result.failure === "rate_limited") {
      const next = {
        ...state, blockedUntilMs: doneAt + planUsageRateLimitWaitMs(result.retryAfterMs), blockedAtMs: doneAt,
      };
      store.save(next);
      return staleOr(next, "rate_limited", { failure: "rate_limited", retryAfterMs: next.blockedUntilMs - doneAt }, doneAt);
    }
    return staleOr(state, "unavailable", result, doneAt);
  };

  return () => {
    // 同時の問い合わせ（シートと会話の /usage が重なる等）は 1 回にまとめる。
    inFlight ??= run().finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** 今ある認証候補（Keychain / ミラー / file）の指紋。refresh はしない。 */
async function currentCredentialFingerprints(): Promise<ReadonlySet<string>> {
  const candidates = await loadSourcedCredentialCandidates();
  return new Set(candidates.map((candidate) => credentialFingerprint(candidate.token)));
}

/** engine が共有する使用量取得（ガード付き。状態はファイルでプロセスをまたぐ）。 */
export const sharedPlanUsage: PlanUsageProvider = createGuardedPlanUsage(() => fetchPlanUsage(), {
  store: filePlanUsageGuardStore(),
  currentFingerprints: currentCredentialFingerprints,
});

/** 単一トークンで使用量 API を1回叩く。401だけを更新可能として区別する。 */
async function fetchUsageOnce(
  token: string,
  timeoutSeconds: number,
): Promise<ClaudeOAuthAttempt<PlanUsage>> {
  try {
    const userAgent = claudeCliUserAgent(claudeCliVersionForUserAgent());
    const response = await fetch(PLAN_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        // OAuth 経由の Claude Code API に必要な beta ヘッダ（公式クライアントと同じ）。
        "anthropic-beta": "oauth-2025-04-20",
        // リセット権はこの名乗りでのみ返る。トークンも同じ Claude Code のものを使っている。
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    return await usageAttemptFromResponse(response);
  } catch {
    return { kind: "failure" };
  }
}

/** 使用量 API の応答を分類する（純ロジック寄り, TESTABLE）。本文は 1 回だけ読む。 */
export async function usageAttemptFromResponse(response: Response): Promise<ClaudeOAuthAttempt<PlanUsage>> {
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 429 || (response.status === 403 && !(await hasAnthropicErrorBody(response)))) {
    // Claude Code 本体と同じく、エラー本文の無い 403 も問い合わせ過多として待つ。
    return { kind: "rate_limited", retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) };
  }
  if (response.status !== 200) return { kind: "failure" };
  try {
    const usage = parsePlanUsage((await response.json()) as unknown);
    return usage === null ? { kind: "failure" } : { kind: "success", value: usage };
  } catch {
    return { kind: "failure" };
  }
}

/** 成功 token の profile から email を読み、ワイヤーへ出せるマスク済み文字列だけ返す。 */
async function fetchMaskedClaudeAccount(
  token: string,
  timeoutSeconds: number,
): Promise<string | null> {
  try {
    const response = await fetch(CLAUDE_PROFILE_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    if (response.status !== 200) return null;
    return parseMaskedClaudeProfile((await response.json()) as unknown);
  } catch {
    return null;
  }
}

/** profile 応答からマスク済み email だけを抽出する（秘密の生 email は返さない）。 */
export function parseMaskedClaudeProfile(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const account = (raw as Record<string, unknown>)["account"];
  if (typeof account !== "object" || account === null) return null;
  const rec = account as Record<string, unknown>;
  const email = typeof rec["email"] === "string"
    ? rec["email"]
    : typeof rec["email_address"] === "string"
      ? rec["email_address"]
      : null;
  return maskEmail(email) ?? null;
}

/**
 * 使用量 API 応答をパースする（形式は寛容に読む）。
 * トップレベルキー（seven_day_fable → seven_day_mythos → seven_day_opus）を試した後、
 * `limits[]` の `kind == "weekly_scoped"` エントリにフォールバックする（2026-07 実測の現行形式）。
 */
export function parsePlanUsage(raw: unknown, nowMs: number = Date.now()): PlanUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const window = (key: string): [number | null, string | null] => {
    const w = obj[key];
    if (typeof w !== "object" || w === null) return [null, null];
    const rec = w as Record<string, unknown>;
    const pct = roundedPercent(rec["utilization"]);
    const resetsAt = typeof rec["resets_at"] === "string" ? rec["resets_at"] : null;
    return [pct, resetsAt];
  };

  const five = window("five_hour");
  const seven = window("seven_day");
  let fable: [number | null, string | null] = [null, null];
  for (const key of ["seven_day_fable", "seven_day_mythos", "seven_day_opus"]) {
    const w = window(key);
    if (w[0] !== null) {
      fable = w;
      break;
    }
  }
  if (fable[0] === null && Array.isArray(obj["limits"])) {
    for (const limit of obj["limits"] as unknown[]) {
      if (typeof limit !== "object" || limit === null) continue;
      const rec = limit as Record<string, unknown>;
      if (rec["kind"] !== "weekly_scoped") continue;
      const pct = roundedPercent(rec["percent"]);
      if (pct !== null) {
        fable = [pct, typeof rec["resets_at"] === "string" ? rec["resets_at"] : null];
        break;
      }
    }
  }

  const extraUsage = parseClaudeExtraUsage(obj["extra_usage"]);
  if (five[0] === null && seven[0] === null && fable[0] === null && extraUsage === undefined) return null;
  const limitResets = parseClaudeLimitResets(obj["cedar_ember"], nowMs);
  return {
    fiveHourUtilization: five[0],
    fiveHourResetsAt: five[1],
    sevenDayUtilization: seven[0],
    sevenDayResetsAt: seven[1],
    sevenDayFableUtilization: fable[0],
    sevenDayFableResetsAt: fable[1],
    ...(extraUsage !== undefined ? { extraUsage } : {}),
    ...(limitResets !== undefined ? { limitResets } : {}),
    // プラン情報は使用量 API 応答には無い（credentials 由来。fetchPlanUsage が後付けする）。
    subscriptionType: null,
    rateLimitTier: null,
  };
}

/** null の上限は無制限と解釈しない。通貨なしの旧応答は公式 CLI と同じく USD。 */
export function parseClaudeExtraUsage(raw: unknown): ClaudeExtraUsage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: ClaudeExtraUsage = {};
  if (typeof obj["is_enabled"] === "boolean") result.isEnabled = obj["is_enabled"];
  const amount = (value: unknown, nonnegative = false): string | undefined =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      && (!nonnegative || value >= 0) ? String(value) : undefined;
  const used = amount(obj["used_credits"]);
  const limit = amount(obj["monthly_limit"], true);
  if (used !== undefined) result.usedCredits = used;
  if (limit !== undefined) result.monthlyLimit = limit;
  const rawCurrency = obj["currency"];
  const currency = rawCurrency == null ? "USD"
    : typeof rawCurrency === "string" ? rawCurrency.trim().toUpperCase() : undefined;
  if (currency !== undefined && Intl.supportedValuesOf("currency").includes(currency)) {
    result.currency = currency;
    // SDK の契約は通貨の最小単位。仕様外の decimal_places を換算率に使わない。
    result.decimalPlaces = new Intl.NumberFormat("en-US", { style: "currency", currency })
      .resolvedOptions().maximumFractionDigits;
  }
  // 通貨だけが分かっても「追加利用を取得できた」とは扱わない。
  return result.isEnabled !== undefined || used !== undefined || limit !== undefined ? result : undefined;
}

/**
 * 使用量 API の `cedar_ember`（利用枠リセット権）を読む（純ロジック, TESTABLE）。
 *
 * - 「付与がない」と言い切れる理由（付与なし・在籍期間・プラン・席・制度停止）だけ空配列
 * - それ以外（名乗り対象外・CLI の版・モバイル・別実験・一時不明・未知の理由・欠落）は undefined（= 不明）
 * - 残り 0・期限切れの権利は落とす。種類は Claude Code と同じ規則で決める
 *   （`gives_back_weekly` → fable、次に `type`、最後に `clears` から推定）
 */
export function parseClaudeLimitResets(raw: unknown, nowMs: number = Date.now()): ClaudeLimitReset[] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj["eligible"] !== true) {
    const reason = obj["ineligible_reason"];
    return obj["eligible"] === false && typeof reason === "string" && DEFINITE_NO_GRANT_REASONS.has(reason)
      ? [] : undefined;
  }
  if (!Array.isArray(obj["grants"])) return undefined;
  const resets: ClaudeLimitReset[] = [];
  for (const item of obj["grants"] as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const grant = item as Record<string, unknown>;
    const remaining = grant["resets_left"];
    if (typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining <= 0) continue;
    const endsAt = typeof grant["ends_at"] === "string" ? Date.parse(grant["ends_at"]) : NaN;
    if (Number.isFinite(endsAt) && endsAt <= nowMs) continue;
    const total = grant["resets_total"];
    resets.push({
      kind: limitResetKind(grant),
      remaining,
      ...(typeof total === "number" && Number.isSafeInteger(total) && total >= remaining ? { total } : {}),
      ...(Number.isFinite(endsAt) ? { expiresAt: new Date(endsAt).toISOString() } : {}),
      usableNow: grant["usable_now"] === true && grant["paused"] !== true,
    });
  }
  return resets;
}

/** 「リセット権は無い」と断言してよい対象外理由（Claude Code 2.1.321 の列挙から選んだもの）。 */
const DEFINITE_NO_GRANT_REASONS = new Set(["no_grant", "tenure", "tier", "seat", "config_off"]);

function limitResetKind(grant: Record<string, unknown>): string {
  if (grant["gives_back_weekly"] === true) return "fable";
  // Claude Code と同じく、type は既知の 3 値だけ採用し、それ以外は clears から推定する。
  if (grant["type"] === "session" || grant["type"] === "weekly" || grant["type"] === "full") return grant["type"];
  const clears = Array.isArray(grant["clears"]) ? grant["clears"].filter((c) => typeof c === "string") : [];
  const fiveHour = clears.includes("five_hour");
  const other = clears.some((c) => c !== "five_hour");
  return fiveHour && !other ? "session" : other && !fiveHour ? "weekly" : "full";
}

function roundedPercent(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(100, Math.max(0, Math.round(raw))) : null;
}

/**
 * Claude Code が保存した OAuth 認証情報の候補を試行順に返す（Keychain → file）。
 * プラン情報も一緒に運ぶので、成功した候補の subscriptionType / rateLimitTier を採れる。
 */
export async function loadCredentialCandidates(now: Date = new Date()): Promise<Credential[]> {
  const candidates = await prepareSourcedCredentials({ now: () => now.getTime() });
  return candidates.map(withoutSource);
}

/**
 * Claude Code が保存した OAuth アクセストークンの候補を試行順に返す。
 * Keychain → file の順に集め、期限内のものを先に試す（全滅時は期限切れも最後に試す）。
 */
export async function loadAccessTokenCandidates(now: Date = new Date()): Promise<string[]> {
  return (await loadCredentialCandidates(now)).map((c) => c.token);
}

/** 候補の試行順を決める（純ロジック, TESTABLE）。期限内を元の順で先に、期限切れを後に、重複除去。 */
export function orderCredentials<T extends Credential>(candidates: T[], nowMs: number): T[] {
  const valid = candidates.filter((c) => (c.expiresAtMs ?? Number.POSITIVE_INFINITY) > nowMs);
  const expired = candidates.filter((c) => (c.expiresAtMs ?? Number.POSITIVE_INFINITY) <= nowMs);
  const seen = new Set<string>();
  const result: T[] = [];
  for (const c of [...valid, ...expired]) {
    if (!seen.has(c.token)) {
      seen.add(c.token);
      result.push(c);
    }
  }
  return result;
}

/**
 * Claude OAuth を必要とする全機能の共通実行器。
 * 期限前は file を先に更新し、API が401なら同じ file をロック付きで1回だけ更新して再試行する。
 */
export async function withClaudeOAuthCredential<T>(
  attempt: (token: string) => Promise<ClaudeOAuthAttempt<T>>,
  options: ClaudeOAuthExecutionOptions = {},
): Promise<ClaudeOAuthResolution<T> | null> {
  return (await resolveClaudeOAuth(attempt, options)).resolution;
}

/**
 * `withClaudeOAuthCredential` の失敗理由つき版。失敗を「候補ゼロ / 全候補 401 / 通信断あり」に
 * 分類し、呼び出し側（使用量シート等）が「/login し直し」と「オフライン」を出し分けられるようにする。
 */
export async function resolveClaudeOAuth<T>(
  attempt: (token: string) => Promise<ClaudeOAuthAttempt<T>>,
  options: ClaudeOAuthExecutionOptions = {},
): Promise<ClaudeOAuthOutcome<T>> {
  const now = options.now ?? (() => Date.now());
  const timeoutSeconds = options.timeoutSeconds ?? 5;
  const refreshFile = options.refreshFile ?? (() => refreshClaudeCredentialFile({ timeoutSeconds }));
  let refreshAttempted = false;
  const candidates = await prepareSourcedCredentials({ ...options, now, refreshFile }, () => {
    refreshAttempted = true;
  });

  if (candidates.length === 0) return { resolution: null, failure: "no_credentials" };
  let sawFailure = false;
  for (const candidate of candidates) {
    let result = await attempt(candidate.token);
    if (result.kind === "success") {
      return {
        resolution: { value: result.value, credential: withoutSource(candidate) },
        failure: null,
      };
    }
    // 429 はアカウント単位の制限。別の候補で叩き直すと制限を長引かせるだけなので止める。
    if (result.kind === "rate_limited") {
      return { resolution: null, failure: "rate_limited", rateLimitedRetryAfterMs: result.retryAfterMs };
    }
    if (result.kind === "failure") sawFailure = true;
    if (result.kind !== "unauthorized" || candidate.source !== "file" || refreshAttempted) {
      continue;
    }

    // expiresAt 欠落・時計ずれ・期限前失効も、401を根拠に一度だけ強制更新する。
    refreshAttempted = true;
    const refreshed = await refreshFile();
    if (refreshed === null) continue;
    const retryCredential = sourcedFromRefresh(refreshed);
    result = await attempt(retryCredential.token);
    if (result.kind === "success") {
      return {
        resolution: { value: result.value, credential: withoutSource(retryCredential) },
        failure: null,
      };
    }
    if (result.kind === "rate_limited") {
      return { resolution: null, failure: "rate_limited", rateLimitedRetryAfterMs: result.retryAfterMs };
    }
    if (result.kind === "failure") sawFailure = true;
  }
  return { resolution: null, failure: sawFailure ? "failure" : "unauthorized" };
}

async function prepareSourcedCredentials(
  options: ClaudeOAuthExecutionOptions,
  onRefreshSuccess: () => void = () => {},
): Promise<SourcedCredential[]> {
  const now = options.now ?? (() => Date.now());
  const timeoutSeconds = options.timeoutSeconds ?? 5;
  const refreshFile = options.refreshFile ?? (() => refreshClaudeCredentialFile({ timeoutSeconds }));
  let candidates = options.candidates !== undefined
    ? [...options.candidates]
    : await loadSourcedCredentialCandidates(now());
  const fileIndex = candidates.findIndex((candidate) => candidate.source === "file");

  // file 側セッションの延命: 期限切れなら Keychain の有無に関わらず refresh する。
  // SSH 文脈（Keychain 不達）のフォールバック正本は file であり、Keychain が読める期間に
  // 放置すると refresh token ごと失効して SSH 側だけが死ぬ（2026-08-10 実障害）。
  // 今回の応答を Keychain/ミラーで賄えるときは、応答を待たせず裏で延命だけ行う。
  if (
    fileIndex >= 0 &&
    shouldRefreshClaudeCredential(candidates[fileIndex]!.expiresAtMs, now())
  ) {
    const servableWithoutFile = candidates.some(
      (candidate) =>
        candidate.source !== "file" &&
        (candidate.expiresAtMs ?? Number.POSITIVE_INFINITY) > now(),
    );
    if (servableWithoutFile) {
      // 裏の延命は本呼び出しへ影響させない（refreshAttempted も立てない。
      // 401 時の再 refresh とはファイルロックで排他される）。
      void refreshFile().catch(() => null);
    } else {
      const refreshed = await refreshFile();
      if (refreshed !== null) {
        onRefreshSuccess();
        candidates[fileIndex] = sourcedFromRefresh(refreshed);
      }
    }
  }
  // 同じ access token が Keychain/file の両方にある場合は、401時に refresh できる file 側を残す。
  const refreshableCandidates = candidates.filter((candidate) =>
    candidate.source === "file" ||
    !candidates.some((other) => other.source === "file" && other.token === candidate.token)
  );
  return orderCredentials(refreshableCandidates, now());
}

async function loadSourcedCredentialCandidates(
  nowMs: number = Date.now(),
): Promise<SourcedCredential[]> {
  const candidates: SourcedCredential[] = [];
  const keychainRaw = await rawCredentialJSONFromKeychain();
  const keychain = keychainRaw !== null ? extractCredential(keychainRaw) : null;
  if (keychainRaw !== null && keychain !== null) {
    candidates.push({ ...keychain, source: "keychain" });
    // GUI 文脈で読めた証をミラーへ残し、Keychain 不達の SSH 文脈が第2候補に使えるようにする。
    writeKeychainMirror(keychainRaw);
  } else {
    const mirror = credentialFromKeychainMirror(nowMs);
    if (mirror !== null) candidates.push({ ...mirror, source: "keychain-mirror" });
  }
  const file = credentialFromFile();
  if (file !== null) candidates.push({ ...file, source: "file" });
  return candidates;
}

/**
 * Keychain ミラーから有効期限内の候補だけを読む（純ロジック, TESTABLE）。
 * 期限切れ・期限不明のミラーは捨てる — refresh に使えない読取専用コピーなので、
 * 期限を過ぎた時点で無用どころか無駄な API 試行の種にしかならない。
 */
export function credentialFromKeychainMirror(
  nowMs: number,
  read: () => string | null = readKeychainMirror,
): Credential | null {
  const raw = read();
  if (raw === null) return null;
  const credential = extractCredential(raw);
  if (credential === null) return null;
  if ((credential.expiresAtMs ?? 0) <= nowMs) return null;
  return credential;
}

/**
 * Keychain を1回読んでミラーを温める（engine 起動時の fire-and-forget 用）。
 * GUI 文脈（QUIC 接続の engine 等）でだけ成功し、SSH 文脈では静かに何もしない。
 * これにより使用量シートを開かない日でも、QUIC 接続があるだけでミラーが新鮮に保たれる。
 */
export async function primeClaudeKeychainMirror(): Promise<void> {
  const raw = await rawCredentialJSONFromKeychain();
  if (raw !== null) writeKeychainMirror(raw);
}

function sourcedFromRefresh(refreshed: RefreshedClaudeCredential): SourcedCredential {
  return {
    token: refreshed.accessToken,
    expiresAtMs: refreshed.expiresAtMs,
    source: "file",
    ...(refreshed.subscriptionType !== undefined
      ? { subscriptionType: refreshed.subscriptionType }
      : {}),
    ...(refreshed.rateLimitTier !== undefined ? { rateLimitTier: refreshed.rateLimitTier } : {}),
  };
}

function withoutSource(credential: SourcedCredential): Credential {
  return {
    token: credential.token,
    expiresAtMs: credential.expiresAtMs,
    ...(credential.subscriptionType !== undefined
      ? { subscriptionType: credential.subscriptionType }
      : {}),
    ...(credential.rateLimitTier !== undefined ? { rateLimitTier: credential.rateLimitTier } : {}),
  };
}

/** `orderCredentials` のトークンだけの版（既存呼び出し互換）。 */
export function orderCandidates(candidates: Credential[], nowMs: number): string[] {
  return orderCredentials(candidates, nowMs).map((c) => c.token);
}

/** `~/.claude/.credentials.json` から候補を読む。 */
function credentialFromFile(): Credential | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
    return extractCredential(raw);
  } catch {
    return null;
  }
}

/**
 * 秘密を stdout 文字列としてだけ受け取り、ログへ出さずに返す。
 * SSH の Keychain 問い合わせが対話待ちで固まっても account_usage 全体を止めない。
 */
function runCredentialCommand(
  executable: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { timeout: 2_000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/**
 * macOS Keychain（"Claude Code-credentials"）から候補を読む。
 *
 * QUIC（LaunchAgent）と SSH（sshd）は異なる bootstrap namespace で起動する。トランスポート
 * によって認証源が変わらないよう、両方とも最初に `launchctl asuser <uid>` で同じログイン
 * ユーザーの GUI bootstrap namespace に入り、Claude Code の login Keychain を正本として
 * 読む。GUI セッション不在時だけ現在の namespace で直接再試行し、それも失敗した場合は
 * 呼び出し側が `~/.claude/.credentials.json` へフォールバックする。
 */
export async function credentialFromKeychain(
  runner: CredentialCommandRunner = runCredentialCommand,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): Promise<Credential | null> {
  const raw = await rawCredentialJSONFromKeychain(runner, uid);
  return raw === null ? null : extractCredential(raw);
}

/**
 * Keychain から読めた生 JSON を返す（`extractCredential` が成立する応答だけを有効とする）。
 * 生 JSON はミラー書込（`writeKeychainMirror`）へそのまま渡すために保持する。
 */
async function rawCredentialJSONFromKeychain(
  runner: CredentialCommandRunner = runCredentialCommand,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): Promise<string | null> {
  const securityArgs = ["find-generic-password", "-s", "Claude Code-credentials", "-w"] as const;

  if (uid !== null) {
    const shared = (await runner("/bin/launchctl", [
      "asuser",
      String(uid),
      "/usr/bin/security",
      ...securityArgs,
    ])) ?? "";
    if (extractCredential(shared) !== null) return shared;
  }

  const direct = (await runner("/usr/bin/security", securityArgs)) ?? "";
  return extractCredential(direct) !== null ? direct : null;
}

/**
 * 認証情報 JSON（`{"claudeAiOauth":{"accessToken":…,"expiresAt":<ms>,…}}`）から候補を取り出す。
 * Keychain 版・ファイル版どちらも同じ形なので、この 1 関数で両経路をまかなう。
 * `subscriptionType` / `rateLimitTier` は在れば拾い、無ければ省略する。
 */
export function extractCredential(json: string): Credential | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json.trim());
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const oauth = (raw as Record<string, unknown>)["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return null;
  const rec = oauth as Record<string, unknown>;
  const token = rec["accessToken"];
  if (typeof token !== "string" || token.length === 0) return null;
  const expiresAt = rec["expiresAt"];
  const subscriptionType = rec["subscriptionType"];
  const rateLimitTier = rec["rateLimitTier"];
  return {
    token,
    expiresAtMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
    ...(typeof subscriptionType === "string" && subscriptionType.length > 0
      ? { subscriptionType }
      : {}),
    ...(typeof rateLimitTier === "string" && rateLimitTier.length > 0 ? { rateLimitTier } : {}),
  };
}
