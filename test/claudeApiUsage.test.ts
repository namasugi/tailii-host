import { describe, it, expect, vi } from "vitest";
import { createClaudeApiUsageProvider } from "../src/services/claudeApiUsage.js";

const NOW = new Date("2026-11-09T13:00:00Z");
const env = { ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test-only" };
const bucket = (amount: string) => ({ starting_at: "2026-11-09T00:00:00Z", ending_at: "2026-11-10T00:00:00Z",
  results: [{ amount, currency: "USD" }] });
const response = (data = [bucket("1234.56789")], has_more = false, next_page: string | null = null) => Response.json({ data, has_more, next_page });

describe("Claude API の月間利用額", () => {
  it("未設定・無効では通信せず、通常キーでは照会しない", async () => {
    const fetcher = vi.fn(async () => response());
    expect(await createClaudeApiUsageProvider({ env: {}, fetch: fetcher })()).toBeNull();
    const provider = createClaudeApiUsageProvider({ env, fetch: fetcher });
    expect(await provider({ mode: "disabled" })).toBeNull();
    expect(await provider({ mode: "custom" })).toEqual({ error: "key_required" });
    expect(await provider({ mode: "custom", apiKey: "sk-ant-api03-test-only" })).toEqual({ error: "admin_key_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("セントを正確に USD へ換算し、当日分のバケットを含む", async () => {
    const fetcher = vi.fn(async () => response());
    const provider = createClaudeApiUsageProvider({ env, now: () => NOW, fetch: fetcher });
    expect(await provider()).toEqual({ value: { month: "2026-11", cost: "12.3456789", currency: "USD", fetchedAt: NOW.toISOString() } });
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://api.anthropic.com/v1/organizations/cost_report");
    expect(url.searchParams.get("ending_at")).toBe("2026-11-10T00:00:00.000Z");
    expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { "anthropic-version": "2026-10-21" } });
    await provider();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("指定したキーで失敗しても環境変数へ戻さず、キー変更で再取得する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("private-error", { status: 401 })).mockResolvedValueOnce(response([]));
    const provider = createClaudeApiUsageProvider({ env, now: () => NOW, fetch: fetcher });
    expect(await provider({ mode: "custom", apiKey: "sk-ant-admin01-custom" })).toEqual({ error: "login_required" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await provider()).toMatchObject({ value: { cost: "0" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("全ページを合計し、不完全なページや不正額を実績にしない", async () => {
    const first = { ...bucket("10.5"), starting_at: "2026-11-08T00:00:00Z", ending_at: "2026-11-09T00:00:00Z" };
    const fetcher = vi.fn().mockResolvedValueOnce(response([first], true, "next")).mockResolvedValueOnce(response([bucket("-0.2")]));
    expect(await createClaudeApiUsageProvider({ env, now: () => NOW, fetch: fetcher })()).toMatchObject({ value: { cost: "0.103" } });
    for (const value of [response([], true, null), response([bucket("bad")]), response([bucket("1"), bucket("2")])]) {
      expect(await createClaudeApiUsageProvider({ env, now: () => NOW, fetch: async () => value })()).toEqual({ error: "unavailable" });
    }
  });
});
