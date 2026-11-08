// Codex の追加クレジット履歴を、公式 CLI と同じ読取専用の経路で月次集計する。
// App Server の使用枠と同じアカウントだけを使う。API キー・認証方式の変更は行わない。
// 契約枠のトークンから請求額を推定せず、符号付きの消費・調整イベントをそのまま合計する。

import * as fs from "node:fs";
import * as path from "node:path";
import type { CodexMonthlyCredits } from "../protocol/messages.js";
import { emailFromCodexAuthJson, maskEmail } from "../services/accountIdentity.js";

export const CODEX_CREDIT_HISTORY_ENDPOINT =
  "https://chatgpt.com/backend-api/wham/usage/credit-usage-events";
const MAX_AUTH_BYTES = 1_048_576;
const MAX_HISTORY_BYTES = 4_194_304;

export type MonthlyCreditsFailure = "login_required" | "account_mismatch" | "unavailable";
export type MonthlyCreditsResult =
  | { value: CodexMonthlyCredits; account?: string }
  | { error: MonthlyCreditsFailure };

export interface MonthlyCreditsOptions {
  codexHome: string;
  /** App Server が返した現在の accountId。省略・不一致なら履歴を混ぜない。 */
  accountId?: string;
  /** 同一ワークスペース内の別ユーザーを区別する、App Server のアカウント表示。 */
  accountEmail?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetch?: typeof fetch;
  readAuth?: () => string | null;
}

/** 認証情報はメモリ内だけで使用し、応答・例外・ログには載せない。 */
export async function fetchCodexMonthlyCredits(options: MonthlyCreditsOptions): Promise<MonthlyCreditsResult> {
  try {
    const raw = (options.readAuth ?? (() => readAuthFile(options.codexHome)))();
    const auth = raw === null ? null : record(JSON.parse(raw));
    const tokens = record(auth?.["tokens"]);
    const token = tokens?.["access_token"];
    const accountId = tokens?.["account_id"];
    if (auth?.["auth_mode"] === "apikey" || typeof token !== "string" || token.length === 0
      || typeof accountId !== "string" || accountId.length === 0) return { error: "login_required" };
    const email = emailFromCodexAuthJson(raw);
    if (!options.accountId || accountId !== options.accountId || !email || !options.accountEmail
      || email.trim().toLowerCase() !== options.accountEmail.trim().toLowerCase()) {
      return { error: "account_mismatch" };
    }

    const now = (options.now ?? (() => new Date()))();
    const response = await (options.fetch ?? fetch)(CODEX_CREDIT_HISTORY_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { error: response.status === 401 ? "login_required" : "unavailable" };
    }
    const parsed = parseMonthlyCreditEvents(JSON.parse(await readBoundedBody(response)), now);
    if (parsed === null) return { error: "unavailable" };
    const account = maskEmail(email);
    return { value: parsed, ...(account !== undefined ? { account } : {}) };
  } catch {
    return { error: "unavailable" };
  }
}

function readAuthFile(codexHome: string): string | null {
  const authPath = path.join(codexHome, "auth.json");
  try {
    const stat = fs.statSync(authPath);
    return stat.isFile() && stat.size <= MAX_AUTH_BYTES ? fs.readFileSync(authPath, "utf8") : null;
  } catch {
    return null;
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("missing-body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HISTORY_BYTES) {
        await reader.cancel();
        throw new Error("history-too-large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** 公式 Analytics と同じ UTC 日付を採用。未知・不正な応答はゼロにせず失敗させる。 */
export function parseMonthlyCreditEvents(raw: unknown, now: Date): CodexMonthlyCredits | null {
  const root = record(raw);
  if (!Array.isArray(root?.["data"]) || !Number.isFinite(now.getTime())) return null;
  if (root["has_more"] === true || root["next_page"] || root["next_cursor"]) return null;
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  let total = 0n;
  let scale = 0;
  for (const item of root["data"] as unknown[]) {
    const row = record(item);
    const date = typeof row?.["date"] === "string" ? row["date"].slice(0, 10) : "";
    if (!validDate(date)) return null;
    if (!date.startsWith(month) || date > today) continue;
    const surface = row?.["product_surface"];
    const amount = row?.["credit_amount"];
    if (typeof surface !== "string" || !surface || typeof amount !== "number" || !Number.isFinite(amount)
      || Math.abs(amount) > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    // work_* は公式の別製品区分。Codex 側の新しい surface はそのまま対象にする。
    if (surface.startsWith("work_")) continue;
    // usage_id は一意性が保証されない。後日調整も公式クライアントと同じく全行を合計する。
    const decimal = decimalParts(amount);
    const nextScale = Math.max(scale, decimal.scale);
    total = total * 10n ** BigInt(nextScale - scale)
      + decimal.value * 10n ** BigInt(nextScale - decimal.scale);
    scale = nextScale;
  }
  const credits = decimalText(total, scale);
  return credits.length > 64 ? null : { month, credits, fetchedAt: now.toISOString() };
}

function decimalParts(amount: number): { value: bigint; scale: number } {
  const [mantissa = "0", exponent = "0"] = String(amount).toLowerCase().split("e");
  const fractionLength = mantissa.split(".")[1]?.length ?? 0;
  let value = BigInt(mantissa.replace(".", ""));
  const scale = fractionLength - Number(exponent);
  if (scale < 0) value *= 10n ** BigInt(-scale);
  return { value, scale: Math.max(0, scale) };
}

function decimalText(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return sign + digits.slice(0, -scale) + (fraction ? `.${fraction}` : "");
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
