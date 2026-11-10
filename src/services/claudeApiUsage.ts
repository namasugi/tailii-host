// Claude API の費用だけを Console の管理キーで照会する。Claude Code の OAuth は使わない。
import { createHash } from "node:crypto";
import type { ApiUsageCredential } from "../protocol/messages.js";
import type { OpenAIApiUsageProvider, OpenAIApiUsageResult } from "./openaiApiUsage.js";
import { apiRecord as record, readApiJson, sumApiAmounts } from "./apiUsageSupport.js";
import { resolveApiKeySource } from "./apiKeySource.js";
import { hostApiKeyEnvironment } from "./hostApiKeyEnvironment.js";

interface Options {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createClaudeApiUsageProvider(options: Options = {}): OpenAIApiUsageProvider {
  let cache: { identity: string; at: number; result: OpenAIApiUsageResult } | undefined;
  let pending: { identity: string; value: Promise<OpenAIApiUsageResult> } | undefined;
  return async (credential?: ApiUsageCredential) => {
    if (credential?.mode === "disabled") { cache = undefined; return null; }
    const names = credential && credential.mode !== "automatic"
      ? credential.mode === "environment" && credential.environmentVariable ? [credential.environmentVariable] : []
      : ["ANTHROPIC_ADMIN_KEY", "ANTHROPIC_ADMIN_API_KEY", "ANTHROPIC_API_KEY"];
    const env = options.env ?? await hostApiKeyEnvironment(names);
    const custom = credential !== undefined && credential.mode !== "automatic";
    const explicit = custom ? resolveApiKeySource(credential, env) : env["ANTHROPIC_ADMIN_KEY"]?.trim() || env["ANTHROPIC_ADMIN_API_KEY"]?.trim();
    const key = custom ? explicit : explicit || env["ANTHROPIC_API_KEY"]?.trim();
    if (!key) { cache = undefined; return custom ? { error: "key_required" } : null; }
    if (key.startsWith("sk-ant-api") || (!explicit && !key.startsWith("sk-ant-admin"))) return { error: "admin_key_required" };
    if (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) return { error: "login_required" };
    const now = (options.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) return { error: "unavailable" };
    const identity = createHash("sha256").update(key).update("\0" + now.toISOString().slice(0, 7)).digest("hex");
    const ttl = cache?.result && "value" in cache.result ? 60_000 : 15_000;
    if (cache?.identity === identity && now.getTime() >= cache.at && now.getTime() - cache.at < ttl) return cache.result;
    if (pending?.identity === identity) return pending.value;
    const value = fetchUsage(key, now, options).then((result) => {
      cache = { identity, at: now.getTime(), result };
      return result;
    }).finally(() => { if (pending?.identity === identity) pending = undefined; });
    pending = { identity, value };
    return value;
  };
}

async function fetchUsage(key: string, now: Date, options: Options): Promise<OpenAIApiUsageResult> {
  try {
    const month = now.toISOString().slice(0, 7);
    const start = month + "-01T00:00:00Z";
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", start);
    // 日次バケットの終端で絞られるため、当日分も含む翌 UTC 0 時を指定する。
    url.searchParams.set("ending_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString());
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    const signal = AbortSignal.timeout(options.timeoutMs ?? 3_000);
    const budget = { remaining: 4 * 1024 * 1024 };
    const amounts: string[] = [];
    const cursors = new Set<string>();
    const buckets = new Set<number>();
    for (let page = 0; page < 32; page++) {
      const response = await (options.fetch ?? fetch)(url, {
        method: "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${key}`, "anthropic-version": "2026-10-21" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { error: response.status === 401 ? "login_required" : response.status === 403 ? "admin_key_required" : "unavailable" };
      }
      const data = record(await readApiJson(response, budget));
      if (!data || !Array.isArray(data["data"]) || typeof data["has_more"] !== "boolean") return { error: "unavailable" };
      for (const item of data["data"] as unknown[]) {
        const bucket = record(item);
        const from = typeof bucket?.["starting_at"] === "string" ? Date.parse(bucket["starting_at"]) : NaN;
        const to = typeof bucket?.["ending_at"] === "string" ? Date.parse(bucket["ending_at"]) : NaN;
        if (!bucket || !Number.isFinite(from) || !Number.isFinite(to) || from < Date.parse(start)
          || from > now.getTime() || to <= from || buckets.has(from) || !Array.isArray(bucket["results"])) return { error: "unavailable" };
        buckets.add(from);
        for (const item of bucket["results"] as unknown[]) {
          const row = record(item);
          if (typeof row?.["amount"] !== "string" || row["currency"] !== "USD") return { error: "unavailable" };
          amounts.push(row["amount"]);
        }
      }
      if (!data["has_more"]) {
        const cost = sumApiAmounts(amounts, 2);
        return cost.length <= 64 ? { value: { month, cost, currency: "USD", fetchedAt: now.toISOString() } } : { error: "unavailable" };
      }
      const cursor = data["next_page"];
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) return { error: "unavailable" };
      cursors.add(cursor);
      url.searchParams.set("page", cursor);
    }
  } catch { /* キー・API 応答本文は外へ出さない。 */ }
  return { error: "unavailable" };
}
