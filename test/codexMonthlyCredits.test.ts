import { describe, expect, it, vi } from "vitest";
import { fetchCodexMonthlyCredits, parseMonthlyCreditEvents, CODEX_CREDIT_HISTORY_ENDPOINT } from "../src/codex/codexMonthlyCredits.js";
import { fetchCodexAccountUsage } from "../src/codex/codexAccountUsage.js";
import type { CodexAppServerManager } from "../src/codex/codexAppServer.js";

const NOW = new Date("2026-11-08T00:30:00.000Z");
const ID_TOKEN = `header.${Buffer.from(JSON.stringify({ email: "test@example.test" })).toString("base64url")}.signature`;
const AUTH = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token", account_id: "test-account", id_token: ID_TOKEN } });
const event = (date: string, credit_amount: number, product_surface = "cli") => ({ date, credit_amount, product_surface });
const options = () => ({ codexHome: "/unused-test-home", accountId: "test-account", accountEmail: "test@example.test", readAuth: () => AUTH, now: () => NOW });

describe("月間の追加クレジット集計", () => {
  it("UTC の月初から今日までの全 Codex surface を集計する", () => {
    expect(parseMonthlyCreditEvents({ data: [
      event("2026-10-31", 100), event("2026-11-01", 0.1), event("2026-11-08T00:00:00Z", 0.2, "web"),
      event("2026-11-08", 5, "work_web"), event("2026-11-09", 100), event("2026-12-01", 100),
    ] }, NOW)).toEqual({ month: "2026-11", credits: "0.3", fetchedAt: NOW.toISOString() });
  });

  it("符号付き調整と小数を丸めずに合計する", () => {
    expect(parseMonthlyCreditEvents({ data: [event("2026-11-01", 0.1), event("2026-11-02", -0.004)] }, NOW)?.credits)
      .toBe("0.096");
    expect(parseMonthlyCreditEvents({ data: [event("2026-11-01", -0.004), event("2026-11-02", 1e-7)] }, NOW)?.credits)
      .toBe("-0.0039999");
  });

  it("同じ usage_id の後日調整も独立したイベントとして集計する", () => {
    expect(parseMonthlyCreditEvents({ data: [
      { ...event("2026-11-01", 1), usage_id: "same-usage" },
      { ...event("2026-11-02", -0.25), usage_id: "same-usage" },
    ] }, NOW)?.credits).toBe("0.75");
  });

  it("途中ページと表示精度を超える応答から合計を作らない", () => {
    expect(parseMonthlyCreditEvents({ data: [], has_more: true }, NOW)).toBeNull();
    expect(parseMonthlyCreditEvents({ data: [], next_page: "remaining" }, NOW)).toBeNull();
    expect(parseMonthlyCreditEvents({ data: [event("2026-11-01", 1e100)] }, NOW)).toBeNull();
  });

  it("成功した空履歴だけを 0 とする", () => {
    expect(parseMonthlyCreditEvents({ data: [] }, NOW)?.credits).toBe("0");
    for (const raw of [null, {}, { data: null }, { data: {} }, { data: [null] }]) {
      expect(parseMonthlyCreditEvents(raw, NOW)).toBeNull();
    }
  });

  it("不正な日付・金額・surface を黙って除外しない", () => {
    for (const row of [event("2026-11-31", 1), event("not-a-date", 1), event("2026-11-01", NaN),
      event("2026-11-01", Infinity), { ...event("2026-11-01", 1), credit_amount: "1" },
      { date: "2026-11-01", credit_amount: 1 }]) {
      expect(parseMonthlyCreditEvents({ data: [row] }, NOW)).toBeNull();
    }
    expect(parseMonthlyCreditEvents({ data: [] }, new Date(NaN))).toBeNull();
  });

  it("月替わりは UTC で判定する", () => {
    const lastMoment = new Date("2026-10-31T23:59:59Z");
    expect(parseMonthlyCreditEvents({ data: [event("2026-10-31", 1), event("2026-11-01", 2)] }, lastMoment)?.credits)
      .toBe("1");
  });
});

describe("月間消費の取得と認証境界", () => {
  it("同じアカウントの既存 OAuth を固定の公式 URL にだけ送る", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [event("2026-11-01", 12.345)] }));
    expect(await fetchCodexMonthlyCredits({ ...options(), fetch: fetcher })).toEqual({
      value: { month: "2026-11", credits: "12.345", fetchedAt: NOW.toISOString() },
      account: "t***@example.test",
    });
    expect(fetcher).toHaveBeenCalledWith(CODEX_CREDIT_HISTORY_ENDPOINT, expect.objectContaining({
      method: "GET", redirect: "error", headers: { Authorization: "Bearer test-token", "ChatGPT-Account-Id": "test-account" },
    }));
  });

  it("アカウント不明・切替・API キー認証では OAuth を送らない", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const accountId of [undefined, "other-account"]) {
      expect(await fetchCodexMonthlyCredits({ ...options(), accountId, fetch: fetcher })).toEqual({ error: "account_mismatch" });
    }
    expect(await fetchCodexMonthlyCredits({ ...options(), fetch: fetcher, readAuth: () => null })).toEqual({ error: "login_required" });
    expect(await fetchCodexMonthlyCredits({ ...options(), fetch: fetcher, readAuth: () => AUTH.replace('"chatgpt"', '"apikey"') }))
      .toEqual({ error: "login_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ユーザーを照合できない場合も OAuth を送らず、正常な表記差は許す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
    expect(await fetchCodexMonthlyCredits({ ...options(), accountEmail: undefined, fetch: fetcher }))
      .toEqual({ error: "account_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fetchCodexMonthlyCredits({ ...options(), accountEmail: " TEST@EXAMPLE.TEST ", fetch: fetcher }))
      .toHaveProperty("value");
  });

  it("同じワークスペース ID でも別ユーザーの認証情報を送らない", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
    expect(await fetchCodexMonthlyCredits({ ...options(), accountEmail: "other@example.test", fetch: fetcher }))
      .toEqual({ error: "account_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("401・通信断・壊れた履歴はゼロにせず、本文や認証情報を返さない", async () => {
    for (const status of [401, 403, 429, 500]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-response", { status }));
      expect(await fetchCodexMonthlyCredits({ ...options(), fetch: fetcher }))
        .toEqual({ error: status === 401 ? "login_required" : "unavailable" });
    }
    const broken = vi.fn<typeof fetch>().mockRejectedValue(new Error("test-token"));
    expect(await fetchCodexMonthlyCredits({ ...options(), fetch: broken })).toEqual({ error: "unavailable" });
    const wrong = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ other: [] }));
    expect(await fetchCodexMonthlyCredits({ ...options(), fetch: wrong })).toEqual({ error: "unavailable" });
  });

  it("大きすぎる応答を途中で打ち切る", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(4_194_305)));
    expect(await fetchCodexMonthlyCredits({ ...options(), fetch: fetcher })).toEqual({ error: "unavailable" });
  });

  it("App Server のアカウントと認証元を引き継ぎ、月間失敗でも使用枠を残す", async () => {
    const close = vi.fn();
    const manager = {
      codexHome: "/isolated-test-home", ensureRunning: vi.fn(),
      connectIfRunning: async () => ({ request: async (method: string) => method === "account/read"
        ? { account: { type: "chatgpt", email: "server@example.test" } }
        : { accountId: "server-account", rateLimits: { primary: { usedPercent: 25 } } }, close }),
    } as unknown as CodexAppServerManager;
    const monthly = vi.fn().mockResolvedValue({ error: "unavailable" });
    expect(await fetchCodexAccountUsage(manager, 1000, monthly)).toEqual({ fiveHourPercent: 25, monthlyCreditsError: "unavailable", account: "s***@example.test" });
    expect(monthly).toHaveBeenCalledWith({ codexHome: "/isolated-test-home", accountId: "server-account", accountEmail: "server@example.test", timeoutMs: 1000 });
    expect(close).toHaveBeenCalledOnce();
  });
});
