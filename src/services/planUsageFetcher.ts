// planUsageFetcher.ts
// tailii (TS host) — プラン使用状況の取得（Claude Code OAuth 使用量 API）
// Swift 版 PlanUsageFetcher.swift の移植。
// 認証は Mac 上の Claude Code が保存した OAuth トークン（Keychain → file の順、期限切れは後回し）。
// 取得不能・オフラインは null（usage 応答の plan 系フィールドは省略 = ベストエフォート）。
// 秘密の扱い: アクセストークンは本プロセス内でのみ使い、ログ・チャネルへは載せない。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { maskEmail } from "./accountIdentity.js";
import {
  refreshClaudeCredentialFile,
  shouldRefreshClaudeCredential,
  type RefreshedClaudeCredential,
} from "./claudeCredentialRefresh.js";

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
  /** 契約種別の生値（"max" / "pro" 等）。credentials に無ければ null。 */
  subscriptionType: string | null;
  /** レート制限ティアの生値（"default_claude_max_20x" 等）。credentials に無ければ null。 */
  rateLimitTier: string | null;
  /** 実際に使用量取得へ成功した同じ OAuth token のアカウント（host 側でマスク済み）。 */
  account?: string | null;
}

/** 使用量 API のエンドポイント（Claude Code 本体・statusline ツールと同じ）。 */
export const PLAN_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

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

/** 認証源。SSH/file と GUI Keychain のアカウントを混同しないため候補と一緒に運ぶ。 */
export interface SourcedCredential extends Credential {
  source: "keychain" | "file";
}

/** OAuth API 1回分の結果。401だけを refresh/retry 対象として区別する。 */
export type ClaudeOAuthAttempt<T> =
  | { kind: "success"; value: T }
  | { kind: "unauthorized" }
  | { kind: "failure" };

export interface ClaudeOAuthResolution<T> {
  value: T;
  credential: Credential;
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

/** engine へ注入するフェッチャの型（テストは () => null を注入する）。 */
export type PlanUsageProvider = () => Promise<PlanUsage | null>;

/**
 * プラン使用状況を取得する（ベストエフォート・timeout 付き）。
 *
 * プラン情報（subscriptionType / rateLimitTier）は使用量 API ではなく、
 * **実際に取得へ成功した候補の credentials JSON** から採る（どのアカウントの使用量かと
 * バッジ表示が一致する）。
 */
export async function fetchPlanUsage(timeoutSeconds = 5): Promise<PlanUsage | null> {
  const resolved = await withClaudeOAuthCredential(
    async (token): Promise<ClaudeOAuthAttempt<{ usage: PlanUsage; account: string | null }>> => {
      const usage = await fetchUsageOnce(token, timeoutSeconds);
      if (usage.kind !== "success") return usage;
      // アカウント表示は別の `claude auth status` ではなく、成功した同じ token から採る。
      const account = await fetchMaskedClaudeAccount(token, timeoutSeconds);
      return { kind: "success", value: { usage: usage.value, account } };
    },
    { timeoutSeconds },
  );
  if (resolved === null) return null;
  return {
    ...resolved.value.usage,
    subscriptionType: resolved.credential.subscriptionType ?? null,
    rateLimitTier: resolved.credential.rateLimitTier ?? null,
    account: resolved.value.account,
  };
}

/** 単一トークンで使用量 API を1回叩く。401だけを更新可能として区別する。 */
async function fetchUsageOnce(
  token: string,
  timeoutSeconds: number,
): Promise<ClaudeOAuthAttempt<PlanUsage>> {
  try {
    const response = await fetch(PLAN_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        // OAuth 経由の Claude Code API に必要な beta ヘッダ（公式クライアントと同じ）。
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status !== 200) return { kind: "failure" };
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
export function parsePlanUsage(raw: unknown): PlanUsage | null {
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

  if (five[0] === null && seven[0] === null && fable[0] === null) return null;
  return {
    fiveHourUtilization: five[0],
    fiveHourResetsAt: five[1],
    sevenDayUtilization: seven[0],
    sevenDayResetsAt: seven[1],
    sevenDayFableUtilization: fable[0],
    sevenDayFableResetsAt: fable[1],
    // プラン情報は使用量 API 応答には無い（credentials 由来。fetchPlanUsage が後付けする）。
    subscriptionType: null,
    rateLimitTier: null,
  };
}

function roundedPercent(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
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
  const now = options.now ?? (() => Date.now());
  const timeoutSeconds = options.timeoutSeconds ?? 5;
  const refreshFile = options.refreshFile ?? (() => refreshClaudeCredentialFile({ timeoutSeconds }));
  let refreshAttempted = false;
  const candidates = await prepareSourcedCredentials({ ...options, now, refreshFile }, () => {
    refreshAttempted = true;
  });

  for (const candidate of candidates) {
    let result = await attempt(candidate.token);
    if (result.kind === "success") {
      return { value: result.value, credential: withoutSource(candidate) };
    }
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
      return { value: result.value, credential: withoutSource(retryCredential) };
    }
  }
  return null;
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
    : await loadSourcedCredentialCandidates();
  const hasKeychain = candidates.some((candidate) => candidate.source === "keychain");
  const fileIndex = candidates.findIndex((candidate) => candidate.source === "file");

  if (
    !hasKeychain &&
    fileIndex >= 0 &&
    shouldRefreshClaudeCredential(candidates[fileIndex]!.expiresAtMs, now())
  ) {
    const refreshed = await refreshFile();
    if (refreshed !== null) {
      onRefreshSuccess();
      candidates[fileIndex] = sourcedFromRefresh(refreshed);
    }
  }
  // 同じ access token が Keychain/file の両方にある場合は、401時に refresh できる file 側を残す。
  const refreshableCandidates = candidates.filter((candidate) =>
    candidate.source === "file" ||
    !candidates.some((other) => other.source === "file" && other.token === candidate.token)
  );
  return orderCredentials(refreshableCandidates, now());
}

async function loadSourcedCredentialCandidates(): Promise<SourcedCredential[]> {
  const candidates: SourcedCredential[] = [];
  const keychain = await credentialFromKeychain();
  if (keychain !== null) candidates.push({ ...keychain, source: "keychain" });
  const file = credentialFromFile();
  if (file !== null) candidates.push({ ...file, source: "file" });
  return candidates;
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
  const securityArgs = ["find-generic-password", "-s", "Claude Code-credentials", "-w"] as const;

  if (uid !== null) {
    const shared = extractCredential(
      (await runner("/bin/launchctl", [
        "asuser",
        String(uid),
        "/usr/bin/security",
        ...securityArgs,
      ])) ?? "",
    );
    if (shared !== null) return shared;
  }

  return extractCredential((await runner("/usr/bin/security", securityArgs)) ?? "");
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
