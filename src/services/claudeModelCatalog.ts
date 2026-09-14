// claudeModelCatalog.ts
// tailii (TS host) — Claude モデル一覧の取得（Anthropic Models API `/v1/models`）。
// 認証は「API キーが設定されていればそれを優先」（2026-07-28 ユーザー決定）:
//   1. API キー（x-api-key）: ANTHROPIC_API_KEY 環境変数 → ~/.claude/settings.json の
//      env.ANTHROPIC_API_KEY → apiKeyHelper（claude CLI と同じ源泉・同じ優先順）
//   2. OAuth トークン（Bearer + oauth beta）: planUsageFetcher と同じ Keychain → file, 期限内優先
// 取得不能・オフラインは null（iOS 側がキャッシュへフォールバックする）。
// 秘密の扱い: キー/トークンは本プロセス内でのみ使い、ログ・チャネルへは載せない。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeModelInfo } from "../protocol/messages.js";
import {
  withClaudeOAuthCredential,
  type ClaudeOAuthAttempt,
} from "./planUsageFetcher.js";

/** Models API のエンドポイント（1ページ完結を実測済み。念のため上限いっぱいで要求する）。 */
export const CLAUDE_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models?limit=100";

/** engine へ注入するフェッチャの型（テストは固定値/null を注入する）。 */
export type ClaudeModelListProvider = () => Promise<ClaudeModelInfo[] | null>;

/** モデル一覧を取得しキュレーションして返す（ベストエフォート・timeout 付き）。 */
export async function fetchClaudeModelList(timeoutSeconds = 5): Promise<ClaudeModelInfo[] | null> {
  // API キーが設定されている環境ではそちらの claude が動いているため優先する。
  const apiKey = await loadApiKey(timeoutSeconds);
  if (apiKey !== null) {
    const result = await fetchOnce(apiKeyHeaders(apiKey), timeoutSeconds);
    if (result.kind === "success") return result.value;
  }
  const resolved = await withClaudeOAuthCredential(
    (token) => fetchOnce(oauthHeaders(token), timeoutSeconds),
    { timeoutSeconds },
  );
  return resolved?.value ?? null;
}

/** API キー認証のヘッダ（Models API の標準認証）。 */
function apiKeyHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

/** OAuth 認証のヘッダ（Claude Code トークン + oauth beta, planUsageFetcher と同じ）。 */
function oauthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  };
}

/** 単一認証で Models API を1回叩く。非 200・タイムアウト・パース不能は null。 */
async function fetchOnce(
  headers: Record<string, string>,
  timeoutSeconds: number,
): Promise<ClaudeOAuthAttempt<ClaudeModelInfo[]>> {
  try {
    const response = await fetch(CLAUDE_MODELS_ENDPOINT, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status !== 200) return { kind: "failure" };
    const models = curateClaudeModels((await response.json()) as unknown);
    return models === null ? { kind: "failure" } : { kind: "success", value: models };
  } catch {
    return { kind: "failure" };
  }
}

/**
 * 設定済み API キーを探す（claude CLI と同じ源泉）。無ければ null（→ OAuth へ）。
 * 順序: ANTHROPIC_API_KEY 環境変数 → settings.json の env → apiKeyHelper 実行。
 */
async function loadApiKey(timeoutSeconds: number): Promise<string | null> {
  const envKey = normalizeApiKey(process.env["ANTHROPIC_API_KEY"]);
  if (envKey !== null) return envKey;
  const settings = readClaudeSettings();
  const settingsKey = normalizeApiKey(extractSettingsEnvApiKey(settings));
  if (settingsKey !== null) return settingsKey;
  const helper = extractApiKeyHelper(settings);
  if (helper !== null) return runApiKeyHelper(helper, timeoutSeconds);
  return null;
}

/** `~/.claude/settings.json` を寛容に読む（無い/壊れている場合は null）。 */
function readClaudeSettings(): unknown {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"),
    ) as unknown;
  } catch {
    return null;
  }
}

/** settings.json の `env.ANTHROPIC_API_KEY` を取り出す（純ロジック, TESTABLE）。 */
export function extractSettingsEnvApiKey(settings: unknown): string | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const env = (settings as Record<string, unknown>)["env"];
  if (typeof env !== "object" || env === null) return undefined;
  const key = (env as Record<string, unknown>)["ANTHROPIC_API_KEY"];
  return typeof key === "string" ? key : undefined;
}

/** settings.json の `apiKeyHelper`（キー出力スクリプト）を取り出す（純ロジック, TESTABLE）。 */
export function extractApiKeyHelper(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const helper = (settings as Record<string, unknown>)["apiKeyHelper"];
  return typeof helper === "string" && helper.trim().length > 0 ? helper : null;
}

/** 空白だけ・空文字のキーを弾いて整える（純ロジック, TESTABLE）。 */
export function normalizeApiKey(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/** apiKeyHelper を実行して stdout をキーとして使う（claude CLI と同じ契約。失敗は null）。 */
function runApiKeyHelper(helper: string, timeoutSeconds: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", helper],
      { timeout: timeoutSeconds * 1000 },
      (error, stdout) => {
        resolve(error ? null : normalizeApiKey(String(stdout)));
      },
    );
  });
}

/** ピッカー表示順のファミリー（表示もこの順）。 */
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"] as const;

interface RawModel {
  id: string;
  displayName: string;
  createdAtMs: number;
}

/**
 * `/v1/models` 応答をピッカー向けに絞り込む（純ロジック, TESTABLE）。
 * - ファミリー判定は display_name の語彙照合（id パースは命名規則の変転で脆いため使わない）
 * - ファミリーごとに created_at 最新の1件のみ（UX 優先, 2026-07-28 ユーザー決定）
 * - どのファミリーにも一致しない新モデルは末尾へ生表示（無言で消さない）
 * - 全滅（形式不明・空）は null を返し、呼び出し側でトークン再試行/失敗扱いにする
 */
export function curateClaudeModels(raw: unknown): ClaudeModelInfo[] | null {
  const parsed = parseModels(raw);
  if (parsed === null || parsed.length === 0) return null;
  // API のソート順に依存せず自前で created_at 降順に整える。
  const sorted = [...parsed].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const byFamily = new Map<string, RawModel>();
  const unknown: RawModel[] = [];
  for (const model of sorted) {
    const family = FAMILY_ORDER.find((f) => model.displayName.toLowerCase().includes(f));
    if (family === undefined) {
      unknown.push(model);
    } else if (!byFamily.has(family)) {
      byFamily.set(family, model);
    }
  }
  const result: ClaudeModelInfo[] = [];
  for (const family of FAMILY_ORDER) {
    const model = byFamily.get(family);
    if (model !== undefined) result.push({ id: model.id, displayName: model.displayName });
  }
  for (const model of unknown) result.push({ id: model.id, displayName: model.displayName });
  return result;
}

/** 応答 JSON（`{"data":[{"id","display_name","created_at"},…]}`）を寛容に読む。 */
function parseModels(raw: unknown): RawModel[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = (raw as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return null;
  const models: RawModel[] = [];
  for (const element of data) {
    if (typeof element !== "object" || element === null) continue;
    const rec = element as Record<string, unknown>;
    const id = rec["id"];
    const displayName = rec["display_name"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof displayName !== "string" || displayName.length === 0) continue;
    const createdAt = typeof rec["created_at"] === "string" ? Date.parse(rec["created_at"]) : Number.NaN;
    models.push({
      id,
      displayName,
      createdAtMs: Number.isFinite(createdAt) ? createdAt : 0,
    });
  }
  return models;
}

// MARK: - 既定モデル（ANTHROPIC_DEFAULT_MODEL, default-model）

/** `ANTHROPIC_DEFAULT_MODEL` の安全な値（alias / モデル id。`[1m]` 接尾辞可）。 */
const DEFAULT_MODEL_SAFE = /^[A-Za-z0-9._-]+(\[[A-Za-z0-9]+\])?$/;

/**
 * 新規セッションの既定モデル設定を読む（Claude Code 2.1.236 の `ANTHROPIC_DEFAULT_MODEL`）。
 * 環境変数 → `~/.claude/settings.json` の `env` の順（CLI と同じ源泉）。無ければ null。
 * Tailii は tmux / herdr 内の非ログインシェルで claude を起動するため、シェル rc の export は
 * 届かない（engine の環境変数と settings.json の env だけが効く）。
 */
export function readClaudeDefaultModelSetting(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = path.join(os.homedir(), ".claude", "settings.json"),
): string | null {
  const fromEnv = env["ANTHROPIC_DEFAULT_MODEL"]?.trim() ?? "";
  if (fromEnv.length > 0) return DEFAULT_MODEL_SAFE.test(fromEnv) ? fromEnv : null;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const envBlock = parsed["env"];
    if (typeof envBlock !== "object" || envBlock === null) return null;
    const value = (envBlock as Record<string, unknown>)["ANTHROPIC_DEFAULT_MODEL"];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && DEFAULT_MODEL_SAFE.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 既定モデル設定を一覧へ写す（純ロジック, TESTABLE）。完全一致の id、または alias（`FAMILY_ORDER` の
 * `fable` / `opus` / `sonnet` / `haiku`。`[1m]` 接尾辞は無視）に該当するファミリーの先頭 1 件へ
 * `isDefault: true` を立てる。設定なし・該当なしは一覧をそのまま返す（iOS は従来の「既定」表示）。
 * `default` / `opusplan` 等の意味付き alias は解決できないので素通し。
 */
export function markClaudeDefaultModel(
  models: ClaudeModelInfo[],
  setting: string | null,
): ClaudeModelInfo[] {
  if (setting === null) return models;
  const bare = setting.replace(/\[[^\]]*\]$/, "").toLowerCase();
  const exact = models.findIndex((model) => model.id.toLowerCase() === bare);
  let index = exact;
  if (index < 0 && (FAMILY_ORDER as readonly string[]).includes(bare)) {
    index = models.findIndex((model) => model.displayName.toLowerCase().includes(bare));
  }
  if (index < 0) return models;
  return models.map((model, i) => (i === index ? { ...model, isDefault: true } : model));
}
