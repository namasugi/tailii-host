// 登録済み管理キーで組織の Costs API を読む。生成 API・キー作成・残高購入は呼ばない。
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenAIApiUsage, ApiUsageCredential } from "../protocol/messages.js";
import { resolveApiKeySource } from "./apiKeySource.js";

const ENDPOINT = "https://api.openai.com/v1/organization/costs";
const MAX_BYTES = 4 * 1024 * 1024;
export type OpenAIApiUsageResult = { value: OpenAIApiUsage } | {
  error: "admin_key_required" | "login_required" | "unavailable" | "key_required";
} | null;
export type OpenAIApiUsageProvider = (credential?: ApiUsageCredential) => Promise<OpenAIApiUsageResult>;

interface Options {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof fetch;
  readCodexAuth?: () => string | null;
  timeoutMs?: number;
}

/** キーなしなら通信しない。キー変更・削除・UTC 月替わりはキャッシュを即座に無効化する。 */
export function createOpenAIApiUsageProvider(options: Options = {}): OpenAIApiUsageProvider {
  let cache: { identity: string; at: number; result: OpenAIApiUsageResult } | undefined;
  let pending: { identity: string; value: Promise<OpenAIApiUsageResult> } | undefined;
  return async (credential) => {
    if (credential?.mode === "disabled") { cache = undefined; return null; }
    const env = options.env ?? process.env;
    const custom = credential !== undefined && credential.mode !== "automatic";
    const explicit = custom ? resolveApiKeySource(credential, env) : env["OPENAI_ADMIN_KEY"]?.trim() || env["OPENAI_ADMIN_API_KEY"]?.trim();
    const key = custom ? explicit : explicit || env["OPENAI_API_KEY"]?.trim() || registeredCodexKey(options, env);
    if (custom && !key) return { error: "key_required" };
    if (!key) { cache = undefined; return null; }
    // 通常のプロジェクトキーは Costs API に使えない。認証を変えず、照会自体を省く。
    if (key.startsWith("sk-proj-") || key.startsWith("sk-svcacct-")
      || (!explicit && !key.startsWith("sk-admin-"))) return { error: "admin_key_required" };
    if (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) return { error: "login_required" };
    const org = custom ? undefined : env["OPENAI_ORG_ID"]?.trim();
    if (org && !/^org-[a-zA-Z0-9_-]+$/.test(org)) return { error: "unavailable" };
    const now = (options.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) return { error: "unavailable" };
    const month = now.toISOString().slice(0, 7);
    const identity = createHash("sha256").update(key).update("\0" + (org ?? "") + "\0" + month).digest("hex");
    const ttl = cache?.result && "value" in cache.result ? 60_000 : 15_000;
    if (cache?.identity === identity && now.getTime() >= cache.at && now.getTime() - cache.at < ttl) return cache.result;
    if (pending?.identity === identity) return pending.value;
    const value = fetchUsage(key, org, now, options).then((result) => {
      cache = { identity, at: now.getTime(), result };
      return result;
    }).finally(() => { if (pending?.identity === identity) pending = undefined; });
    pending = { identity, value };
    return value;
  };
}

function registeredCodexKey(options: Options, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const read = options.readCodexAuth ?? (() => {
      const file = path.join(env["TAILII_CODEX_APP_SERVER_HOME"] || path.join(os.homedir(), ".codex"), "auth.json");
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size <= 1_048_576 ? fs.readFileSync(file, "utf8") : null;
    });
    const raw = read();
    const auth = raw === null ? null : record(JSON.parse(raw));
    return auth?.["auth_mode"] === "apikey" && typeof auth["OPENAI_API_KEY"] === "string"
      ? auth["OPENAI_API_KEY"].trim() : undefined;
  } catch { return undefined; }
}

async function fetchUsage(key: string, org: string | undefined, now: Date, options: Options): Promise<OpenAIApiUsageResult> {
  try {
    const month = now.toISOString().slice(0, 7);
    const start = Date.parse(month + "-01T00:00:00Z") / 1000;
    const end = Math.floor(now.getTime() / 1000) + 1;
    const url = new URL(ENDPOINT);
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("end_time", String(end));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    const signal = AbortSignal.timeout(options.timeoutMs ?? 3_000);
    const amounts: number[] = [];
    const cursors = new Set<string>();
    const buckets = new Set<number>();
    let bytes = 0;
    for (let page = 0; page < 32; page++) {
      const response = await (options.fetch ?? fetch)(url, {
        method: "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${key}`, ...(org ? { "OpenAI-Organization": org } : {}) },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { error: response.status === 401 ? "login_required" : response.status === 403 ? "admin_key_required" : "unavailable" };
      }
      if (!response.body) return { error: "unavailable" };
      const reader = response.body.getReader();
      let body = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); return { error: "unavailable" }; }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
      const data = record(JSON.parse(body));
      if (!data || !Array.isArray(data["data"]) || typeof data["has_more"] !== "boolean") return { error: "unavailable" };
      for (const item of data["data"] as unknown[]) {
        const bucket = record(item);
        if (!bucket || typeof bucket["start_time"] !== "number" || typeof bucket["end_time"] !== "number"
          || !Number.isSafeInteger(bucket["start_time"]) || !Number.isSafeInteger(bucket["end_time"])
          || bucket["start_time"] < start || bucket["start_time"] >= end || bucket["end_time"] <= bucket["start_time"]
          || !Array.isArray(bucket["results"])) return { error: "unavailable" };
        if (buckets.has(bucket["start_time"])) return { error: "unavailable" };
        buckets.add(bucket["start_time"]);
        for (const row of bucket["results"] as unknown[]) {
          const amount = record(record(row)?.["amount"]);
          const value = amount?.["value"];
          if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
            || typeof amount?.["currency"] !== "string" || amount["currency"].toUpperCase() !== "USD") return { error: "unavailable" };
          amounts.push(value);
        }
      }
      if (!data["has_more"]) {
        const cost = sumDecimalNumbers(amounts);
        return cost.length <= 64 ? { value: { month, cost, currency: "USD", fetchedAt: now.toISOString() } } : { error: "unavailable" };
      }
      const cursor = data["next_page"];
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) return { error: "unavailable" };
      cursors.add(cursor);
      url.searchParams.set("page", cursor);
    }
  } catch { /* 認証ヘッダ・API のエラー本文・例外はログやワイヤーへ出さない。 */ }
  return { error: "unavailable" };
}

function sumDecimalNumbers(values: number[]): string {
  let total = 0n;
  let scale = 0;
  for (const amount of values) {
    const [mantissa = "0", exponent = "0"] = String(amount).toLowerCase().split("e");
    const digits = mantissa.split(".")[1]?.length ?? 0;
    const decimalScale = Math.max(0, digits - Number(exponent));
    const value = BigInt(mantissa.replace(".", "")) * 10n ** BigInt(Math.max(0, Number(exponent) - digits));
    const nextScale = Math.max(scale, decimalScale);
    total = total * 10n ** BigInt(nextScale - scale) + value * 10n ** BigInt(nextScale - decimalScale);
    scale = nextScale;
  }
  const sign = total < 0n ? "-" : "";
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  if (!scale) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return sign + digits.slice(0, -scale) + (fraction ? "." + fraction : "");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
