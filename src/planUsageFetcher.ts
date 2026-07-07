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

/** プラン使用状況（5時間枠/7日枠/上位モデル週間枠の使用率とリセット時刻）。 */
export interface PlanUsage {
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
  sevenDayFableUtilization: number | null;
  sevenDayFableResetsAt: string | null;
}

/** 使用量 API のエンドポイント（Claude Code 本体・statusline ツールと同じ）。 */
export const PLAN_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/** トークン候補（値と有効期限 ms epoch）。 */
export interface Credential {
  token: string;
  expiresAtMs: number | null;
}

/** engine へ注入するフェッチャの型（テストは () => null を注入する）。 */
export type PlanUsageProvider = () => Promise<PlanUsage | null>;

/** プラン使用状況を取得する（ベストエフォート・timeout 付き）。 */
export async function fetchPlanUsage(timeoutSeconds = 5): Promise<PlanUsage | null> {
  for (const token of await loadAccessTokenCandidates()) {
    const usage = await fetchOnce(token, timeoutSeconds);
    if (usage !== null) return usage;
  }
  return null;
}

/** 単一トークンで使用量 API を1回叩く。非 200・タイムアウトは null。 */
async function fetchOnce(token: string, timeoutSeconds: number): Promise<PlanUsage | null> {
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
    if (response.status !== 200) return null;
    return parsePlanUsage((await response.json()) as unknown);
  } catch {
    return null;
  }
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
  };
}

function roundedPercent(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
}

/**
 * Claude Code が保存した OAuth アクセストークンの候補を試行順に返す。
 * Keychain → file の順に集め、期限内のものを先に試す（全滅時は期限切れも最後に試す）。
 */
export async function loadAccessTokenCandidates(now: Date = new Date()): Promise<string[]> {
  const candidates: Credential[] = [];
  const keychain = await credentialFromKeychain();
  if (keychain) candidates.push(keychain);
  const file = credentialFromFile();
  if (file) candidates.push(file);
  return orderCandidates(candidates, now.getTime());
}

/** 候補の試行順を決める（純ロジック, TESTABLE）。期限内を元の順で先に、期限切れを後に、重複除去。 */
export function orderCandidates(candidates: Credential[], nowMs: number): string[] {
  const valid = candidates.filter((c) => (c.expiresAtMs ?? Number.POSITIVE_INFINITY) > nowMs);
  const expired = candidates.filter((c) => (c.expiresAtMs ?? Number.POSITIVE_INFINITY) <= nowMs);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of [...valid, ...expired]) {
    if (!seen.has(c.token)) {
      seen.add(c.token);
      result.push(c.token);
    }
  }
  return result;
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

/** macOS Keychain（"Claude Code-credentials"）から候補を読む。 */
function credentialFromKeychain(): Promise<Credential | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(extractCredential(String(stdout)));
      },
    );
  });
}

/** 認証情報 JSON（`{"claudeAiOauth":{"accessToken":…,"expiresAt":<ms>}}`）から候補を取り出す。 */
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
  return {
    token,
    expiresAtMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}
