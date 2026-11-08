import { describe, expect, it, vi } from "vitest";
import { createOpenAIApiUsageProvider } from "../src/services/openaiApiUsage.js";

const NOW = new Date("2026-11-09T03:00:00Z");
const start = Date.parse("2026-11-01T00:00:00Z") / 1000;
const bucket = (...amounts: number[]) => ({
  start_time: start, end_time: start + 86400,
  results: amounts.map((value) => ({ amount: { value, currency: "usd" } })),
});
const response = (data = [bucket(0.1, 0.2)], has_more = false, next_page: string | null = null) =>
  Response.json({ data, has_more, next_page });
const defaults = () => ({ env: { OPENAI_ADMIN_KEY: "sk-admin-test-only" }, now: () => NOW, readCodexAuth: () => null });

describe("OpenAI API 利用額", () => {
  it("指定キー・取得停止は自動検出を上書きし、失敗時も自動へ戻さない", async () => {
    const fetcher = vi.fn(async () => new Response("private-error", { status: 401 }));
    const provider = createOpenAIApiUsageProvider({ ...defaults(), env: { OPENAI_ADMIN_KEY: "sk-admin-env", OPENAI_ORG_ID: "org-env" }, fetch: fetcher });
    expect(await provider({ mode: "disabled" })).toBeNull();
    expect(await provider({ mode: "custom" })).toEqual({ error: "key_required" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await provider({ mode: "custom", apiKey: "sk-admin-custom" })).toEqual({ error: "login_required" });
    expect(fetcher).toHaveBeenCalledOnce();
    const options = (fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(options.headers).toEqual({ Authorization: "Bearer sk-admin-custom" });
  });
  it("キー未登録・OAuth だけの場合は通信しない", async () => {
    const fetcher = vi.fn();
    const provider = createOpenAIApiUsageProvider({ ...defaults(), env: {}, fetch: fetcher,
      readCodexAuth: () => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "not-an-api-key" } }) });
    expect(await provider()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("通常の API キーでは照会しない。登録済み管理キーを優先する", async () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-proj-test-only" };
    const fetcher = vi.fn(async () => response());
    const provider = createOpenAIApiUsageProvider({ ...defaults(), env, fetch: fetcher });
    expect(await provider()).toEqual({ error: "admin_key_required" });
    expect(fetcher).not.toHaveBeenCalled();
    env.OPENAI_ADMIN_KEY = "sk-proj-wrong-scope";
    expect(await provider()).toEqual({ error: "admin_key_required" });
    expect(fetcher).not.toHaveBeenCalled();
    env.OPENAI_ADMIN_KEY = "sk-admin-test-only";
    expect(await provider()).toMatchObject({ value: { cost: "0.3", currency: "USD" } });
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://api.openai.com/v1/organization/costs");
    expect(url.searchParams.get("start_time")).toBe(String(start));
    expect(url.searchParams.get("end_time")).toBe(String(NOW.getTime() / 1000 + 1));
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(await provider())).not.toContain("sk-admin");
  });

  it("Codex に登録済みの管理 API キーも読み、認証情報は書き換えない", async () => {
    const fetcher = vi.fn(async () => response([]));
    const provider = createOpenAIApiUsageProvider({ ...defaults(), env: {}, fetch: fetcher,
      readCodexAuth: () => JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-admin-test-only" }) });
    expect(await provider()).toMatchObject({ value: { cost: "0" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("全ページの調整額を十進数で合算する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([bucket(0.1, 0.2)], true, "next"))
      .mockResolvedValueOnce(response([{ ...bucket(-0.05), start_time: start + 86400, end_time: start + 172800 }]));
    const provider = createOpenAIApiUsageProvider({ ...defaults(), fetch: fetcher });
    expect(await provider()).toEqual({ value: { month: "2026-11", cost: "0.25", currency: "USD", fetchedAt: NOW.toISOString() } });
    expect((fetcher.mock.calls[1]?.[0] as URL).searchParams.get("page")).toBe("next");
  });

  it("キー変更・削除・UTC 月替わりで古い利用額を返さない", async () => {
    let now = NOW;
    const env: NodeJS.ProcessEnv = { OPENAI_ADMIN_KEY: "sk-admin-test-one" };
    const fetcher = vi.fn(async () => response([]));
    const provider = createOpenAIApiUsageProvider({ ...defaults(), env, now: () => now, fetch: fetcher });
    await Promise.all([provider(), provider()]);
    expect(fetcher).toHaveBeenCalledOnce();
    await provider();
    expect(fetcher).toHaveBeenCalledOnce();
    env.OPENAI_ADMIN_KEY = "sk-admin-test-two";
    await provider();
    expect(fetcher).toHaveBeenCalledTimes(2);
    delete env.OPENAI_ADMIN_KEY;
    expect(await provider()).toBeNull();
    env.OPENAI_ADMIN_KEY = "sk-admin-test-two";
    now = new Date("2026-11-30T23:59:59Z");
    await provider();
    now = new Date("2026-12-01T00:00:00Z");
    expect(await provider()).toMatchObject({ value: { month: "2026-12" } });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[401, "login_required"], [403, "admin_key_required"], [429, "unavailable"]] as const)(
    "%i の本文・認証情報を返さず、短い TTL 後に再試行する", async (status, error) => {
      let now = NOW;
      const fetcher = vi.fn(async () => new Response("sensitive-error", { status }));
      const provider = createOpenAIApiUsageProvider({ ...defaults(), now: () => now, fetch: fetcher });
      expect(await provider()).toEqual({ error });
      await provider();
      expect(fetcher).toHaveBeenCalledOnce();
      now = new Date(NOW.getTime() + 15000);
      await provider();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it.each([
    { data: [], has_more: true, next_page: null },
    { data: [bucket(1), { ...bucket(2), results: [{ amount: { value: 2, currency: "eur" } }] }], has_more: false },
    { data: [bucket(1), { ...bucket(2), start_time: 0 }], has_more: false },
    { data: [{ ...bucket(1), results: [{ amount: { value: null, currency: "usd" } }] }], has_more: false },
    { data: [], has_more: null },
    { data: [bucket(1), bucket(2)], has_more: false },
  ])("不正・不完全な応答を 0 や一部の金額にしない", async (data) => {
    const provider = createOpenAIApiUsageProvider({ ...defaults(), fetch: async () => Response.json(data) });
    expect(await provider()).toEqual({ error: "unavailable" });
  });

  it("巨大な応答・循環ページ・通信例外を安全に打ち切る", async () => {
    for (const fetcher of [
      async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
      async () => response([], true, "same-cursor"),
      async () => { throw new Error("sk-admin-sensitive"); },
    ]) {
      expect(await createOpenAIApiUsageProvider({ ...defaults(), fetch: fetcher })()).toEqual({ error: "unavailable" });
    }
  });
});
