import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCliUserAgent,
  createGuardedPlanUsage,
  filePlanUsageGuardStore,
  memoryPlanUsageGuardStore,
  type PlanUsageGuardStore,
  parseClaudeLimitResets,
  parsePlanUsage,
  parseRetryAfterMs,
  planUsageRateLimitWaitMs,
  PLAN_USAGE_RATE_LIMIT_DEFAULT_MS,
  PLAN_USAGE_URL,
  resolveClaudeOAuth,
  usageAttemptFromResponse,
} from "../src/services/planUsageFetcher.js";
import { createAccountUsageHandlers, toClaudeAccountUsage } from "../src/engine/handlers/accountUsage.js";
import type { ControlMessage } from "../src/protocol/messages.js";
import type { HandlerContext } from "../src/engine/context.js";

const NOW = Date.parse("2026-11-10T03:00:00Z");

/** 2026-11-10 に実測した `cedar_ember` の形（Fable リセット 2 件）。 */
function fableGrant(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    label: "New model launch: one Fable reset",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-11-09T18:00:00+00:00",
    ends_at: "2027-03-09T07:59:00+00:00",
    clears: ["seven_day_overage_included"],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    blocking: [],
    type: "full",
    gives_back_weekly: true,
    ...overrides,
  };
}

describe("Claude の利用枠リセット権", () => {
  it("実測形の Fable リセットを種類・残り・期限つきで読む", () => {
    const resets = parseClaudeLimitResets({
      eligible: true,
      ineligible_reason: null,
      grants: [fableGrant("launch"), fableGrant("tenure")],
      next_grant_id: "launch",
    }, NOW);
    expect(resets).toEqual([
      { kind: "fable", remaining: 1, total: 1, expiresAt: "2027-03-09T07:59:00.000Z", usableNow: true },
      { kind: "fable", remaining: 1, total: 1, expiresAt: "2027-03-09T07:59:00.000Z", usableNow: true },
    ]);
  });

  it("名乗りが対象外・一時不明・欠落は「不明」、付与なしは空配列", () => {
    expect(parseClaudeLimitResets({ eligible: false, ineligible_reason: "surface", grants: [] }, NOW)).toBeUndefined();
    expect(parseClaudeLimitResets({ eligible: false, ineligible_reason: "unavailable" }, NOW)).toBeUndefined();
    expect(parseClaudeLimitResets(null, NOW)).toBeUndefined();
    expect(parseClaudeLimitResets(undefined, NOW)).toBeUndefined();
    expect(parseClaudeLimitResets({ eligible: false, ineligible_reason: "no_grant" }, NOW)).toEqual([]);
    expect(parseClaudeLimitResets({ eligible: false, ineligible_reason: "tenure" }, NOW)).toEqual([]);
    for (const reason of ["cli_version", "mobile", "other_experiment", "unknown", "brand_new_reason"]) {
      expect(parseClaudeLimitResets({ eligible: false, ineligible_reason: reason }, NOW), reason).toBeUndefined();
    }
    expect(parseClaudeLimitResets({ eligible: true, grants: [] }, NOW)).toEqual([]);
  });

  it("使い切った・期限切れの権利は落とし、一時停止中は今すぐ使えない扱い", () => {
    const resets = parseClaudeLimitResets({
      eligible: true,
      grants: [
        fableGrant("spent", { resets_left: 0 }),
        fableGrant("expired", { ends_at: "2026-11-01T00:00:00Z" }),
        fableGrant("paused", { paused: true }),
        fableGrant("bad", { resets_left: "1" }),
      ],
    }, NOW);
    expect(resets).toEqual([
      { kind: "fable", remaining: 1, total: 1, expiresAt: "2027-03-09T07:59:00.000Z", usableNow: false },
    ]);
  });

  it("種類は Claude Code と同じ規則（gives_back_weekly → type → clears）", () => {
    const kinds = parseClaudeLimitResets({
      eligible: true,
      grants: [
        fableGrant("a", { gives_back_weekly: false, type: null, clears: ["five_hour"], ends_at: null }),
        fableGrant("b", { gives_back_weekly: false, type: null, clears: ["seven_day"], ends_at: null }),
        fableGrant("c", { gives_back_weekly: false, type: null, clears: ["five_hour", "seven_day"], ends_at: null }),
        fableGrant("d", { gives_back_weekly: false, type: "weekly", ends_at: null }),
        fableGrant("e", { gives_back_weekly: false, type: "fable", clears: ["five_hour"], ends_at: null }),
      ],
    }, NOW)?.map((r) => r.kind);
    expect(kinds).toEqual(["session", "weekly", "full", "weekly", "session"]);
  });

  it("使用量の応答から wire まで運ばれ、欠落時は載らない", () => {
    const plan = parsePlanUsage({
      seven_day: { utilization: 91, resets_at: "2026-11-10T08:59:59Z" },
      cedar_ember: { eligible: true, grants: [fableGrant("launch")] },
    }, NOW);
    expect(toClaudeAccountUsage(plan)?.limitResets).toEqual([
      { kind: "fable", remaining: 1, total: 1, expiresAt: "2027-03-09T07:59:00.000Z", usableNow: true },
    ]);
    const without = parsePlanUsage({ seven_day: { utilization: 91 } }, NOW);
    expect(toClaudeAccountUsage(without)).not.toHaveProperty("limitResets");
  });

  it("リセット権を同じ応答で読むため URL と名乗りを Claude Code に揃える", () => {
    expect(PLAN_USAGE_URL).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1");
    expect(claudeCliUserAgent("2.1.321")).toBe("claude-cli/2.1.321 (external, cli)");
  });
});

describe("使用量取得のガード（429・前回値）", () => {
  const USAGE = {
    fiveHourUtilization: 10, fiveHourResetsAt: null, sevenDayUtilization: 91, sevenDayResetsAt: null,
    sevenDayFableUtilization: null, sevenDayFableResetsAt: null, subscriptionType: "max", rateLimitTier: null,
    credentialFingerprint: "fp-a",
  };

  function harness(results: Array<unknown>, options: {
    store?: PlanUsageGuardStore; clock?: { nowMs: number }; fingerprints?: Set<string>;
  } = {}) {
    const clock = options.clock ?? { nowMs: 1_000_000 };
    let calls = 0;
    const fingerprints = options.fingerprints ?? new Set(["fp-a"]);
    const guarded = createGuardedPlanUsage(async () => {
      calls += 1;
      return (results.shift() ?? USAGE) as never;
    }, {
      now: () => clock.nowMs,
      ...(options.store ? { store: options.store } : {}),
      currentFingerprints: async () => fingerprints,
    });
    return {
      guarded, fingerprints, advance: (ms: number) => { clock.nowMs += ms; }, calls: () => calls,
    };
  }

  it("30 秒以内の再問い合わせは API を叩かない", async () => {
    const h = harness([USAGE]);
    await h.guarded();
    h.advance(10_000);
    const again = await h.guarded();
    expect(h.calls()).toBe(1);
    expect(again).toMatchObject({ sevenDayUtilization: 91, fetchedAtMs: 1_000_000 });
    expect(again).not.toHaveProperty("stale");
    expect(again).not.toHaveProperty("credentialFingerprint");
  });

  it("429 の待ちと前回値は別の engine（同じ保存先の別インスタンス）にも効く", async () => {
    const store = memoryPlanUsageGuardStore();
    const clock = { nowMs: 1_000_000 };
    const first = harness([USAGE, { failure: "rate_limited", retryAfterMs: 600_000 }], { store, clock });
    await first.guarded();
    first.advance(60_000);
    await first.guarded();
    // 再接続で engine が作り直されても、同じ保存先なら叩かずに前回値を返す。
    const second = harness([], { store, clock });
    second.advance(60_000);
    expect(await second.guarded()).toMatchObject({ stale: { reason: "rate_limited" }, sevenDayUtilization: 91 });
    expect(second.calls()).toBe(0);
  });

  it("ログインし直して認証が変わったら、前のアカウントの値は前回値にも間引きにも使わない", async () => {
    const h = harness([USAGE, { failure: "unavailable" }]);
    await h.guarded();
    h.fingerprints.clear();
    h.fingerprints.add("fp-b");
    h.advance(5_000);
    expect(await h.guarded()).toEqual({ failure: "unavailable" });
    expect(h.calls()).toBe(2);
  });

  it("ファイル保存は 0600 で、読み戻して同じ状態になる（トークンは含まない）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    const file = path.join(dir, "run", "plan-usage-guard.json");
    const store = filePlanUsageGuardStore(file);
    expect(store.load()).toBeNull();
    const state = { blockedUntilMs: 123, lastGood: { usage: { ...USAGE, credentialFingerprint: undefined }, atMs: 100, fingerprint: "fp-a" } };
    store.save(state as never);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.load()).toMatchObject({ blockedUntilMs: 123, lastGood: { atMs: 100, fingerprint: "fp-a" } });
    fs.writeFileSync(file, "{broken");
    expect(store.load()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("429 の後は待ち時間まで叩かず、その間は前回値を理由つきで返す", async () => {
    const h = harness([USAGE, { failure: "rate_limited", retryAfterMs: 120_000 }]);
    await h.guarded();
    h.advance(60_000);
    const limited = await h.guarded();
    expect(limited).toMatchObject({
      sevenDayUtilization: 91, fetchedAtMs: 1_000_000,
      stale: { reason: "rate_limited", retryAtMs: 1_060_000 + 120_000 },
    });
    h.advance(60_000);
    await h.guarded();
    expect(h.calls()).toBe(2); // 待ち時間中は叩かない
    h.advance(61_000);
    const recovered = await h.guarded();
    expect(h.calls()).toBe(3);
    expect(recovered).not.toHaveProperty("stale");
  });

  it("前回値は 1 時間以内のものだけ。古ければ失敗を返す", async () => {
    const h = harness([USAGE, { failure: "unavailable" }, { failure: "unavailable" }]);
    await h.guarded();
    h.advance(59 * 60_000);
    expect(await h.guarded()).toMatchObject({ stale: { reason: "unavailable" } });
    h.advance(2 * 60_000);
    expect(await h.guarded()).toEqual({ failure: "unavailable" });
  });

  it("ログイン切れは前回値で隠さず、前のアカウントの値も捨てる", async () => {
    const h = harness([USAGE, { failure: "login_required" }, { failure: "unavailable" }]);
    await h.guarded();
    h.advance(60_000);
    expect(await h.guarded()).toEqual({ failure: "login_required" });
    h.advance(60_000);
    expect(await h.guarded()).toEqual({ failure: "unavailable" });
  });

  it("上限より先の待ち期限（時計の巻き戻り・壊れた保存値）は信じずに取り直す", async () => {
    const store = memoryPlanUsageGuardStore();
    store.save({ blockedUntilMs: 1_000_000 + 24 * 60 * 60_000, lastGood: null });
    const h = harness([USAGE], { store });
    expect(await h.guarded()).toMatchObject({ sevenDayUtilization: 91 });
    expect(h.calls()).toBe(1);
  });

  it("待ちを記録した時刻より前に時計が戻ったら解除し、保存も直す", async () => {
    const store = memoryPlanUsageGuardStore();
    store.save({ blockedUntilMs: 1_000_000 + 5 * 60_000, blockedAtMs: 1_000_000 + 30 * 60_000, lastGood: null });
    const h = harness([{ failure: "unavailable" }], { store });
    expect(await h.guarded()).toEqual({ failure: "unavailable" });
    expect(h.calls()).toBe(1);
    expect(store.load()?.blockedUntilMs).toBe(0);
  });

  it("前回値が無い 429 は失敗のまま、待ち時間を運ぶ", async () => {
    const h = harness([{ failure: "rate_limited" }]);
    expect(await h.guarded()).toEqual({ failure: "rate_limited", retryAfterMs: PLAN_USAGE_RATE_LIMIT_DEFAULT_MS });
  });

  it("Retry-After は秒数と日付の両方を読み、上限 1 時間で丸める", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("Tue, 10 Nov 2026 03:05:00 GMT", Date.parse("2026-11-10T03:00:00Z"))).toBe(300_000);
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(planUsageRateLimitWaitMs(null)).toBe(5 * 60_000);
    expect(planUsageRateLimitWaitMs(3 * 60 * 60_000)).toBe(60 * 60_000);
  });
});

describe("使用量 API の応答の分類", () => {
  it("429 と本文の無い 403 は待ち、Anthropic のエラー本文付き 403 は待たない", async () => {
    expect(await usageAttemptFromResponse(new Response("", { status: 429, headers: { "retry-after": "90" } })))
      .toEqual({ kind: "rate_limited", retryAfterMs: 90_000 });
    expect(await usageAttemptFromResponse(new Response("", { status: 403 })))
      .toEqual({ kind: "rate_limited", retryAfterMs: null });
    expect(await usageAttemptFromResponse(new Response(
      JSON.stringify({ error: { type: "permission_error", message: "no" } }), { status: 403 },
    ))).toEqual({ kind: "failure" });
    expect(await usageAttemptFromResponse(new Response("", { status: 401 }))).toEqual({ kind: "unauthorized" });
    expect(await usageAttemptFromResponse(new Response("", { status: 500 }))).toEqual({ kind: "failure" });
    expect(await usageAttemptFromResponse(new Response("not json", { status: 200 }))).toEqual({ kind: "failure" });
    expect(await usageAttemptFromResponse(new Response(JSON.stringify({ seven_day: { utilization: 5 } }), { status: 200 })))
      .toMatchObject({ kind: "success", value: { sevenDayUtilization: 5 } });
  });
});

describe("OAuth 共通実行器と 429", () => {
  it("429 を受けたら他の認証候補で叩き直さない", async () => {
    const tried: string[] = [];
    const outcome = await resolveClaudeOAuth(async (token) => {
      tried.push(token);
      return { kind: "rate_limited", retryAfterMs: 30_000 };
    }, {
      candidates: [
        { token: "a", expiresAtMs: null, source: "keychain" },
        { token: "b", expiresAtMs: null, source: "file" },
      ],
      refreshFile: async () => null,
    });
    expect(tried).toEqual(["a"]);
    expect(outcome).toMatchObject({ resolution: null, failure: "rate_limited", rateLimitedRetryAfterMs: 30_000 });
  });
});

describe("account_usage の前回値表示", () => {
  it("前回値は stale と本来の取得時刻つきで載り、短い TTL で見直す", async () => {
    let nowMs = Date.parse("2026-11-10T02:15:00Z");
    let calls = 0;
    const handlers = createAccountUsageHandlers({
      openaiApiUsage: async () => null, claudeApiUsage: async () => null, now: () => nowMs,
    });
    const written: ControlMessage[] = [];
    const ctx = {
      writer: { write: (m: ControlMessage) => { written.push(m); } },
      state: { negotiatedVersion: 1 },
      planUsage: async () => {
        calls += 1;
        return {
          fiveHourUtilization: null, fiveHourResetsAt: null, sevenDayUtilization: 91, sevenDayResetsAt: null,
          sevenDayFableUtilization: null, sevenDayFableResetsAt: null, subscriptionType: "max", rateLimitTier: null,
          fetchedAtMs: Date.parse("2026-11-10T02:10:00Z"),
          stale: { reason: "rate_limited" as const, retryAtMs: Date.parse("2026-11-10T02:20:00Z") },
        };
      },
      codexAccountUsage: async () => null,
      hostVersions: async () => null,
      accountIdentity: async () => ({}),
    } as unknown as HandlerContext;
    await handlers["account_usage_request"]!({ type: "account_usage_request", v: 1, id: "s1" }, ctx);
    const response = written.at(-1) as Extract<ControlMessage, { type: "account_usage_response" }>;
    expect(response.claude?.stale).toEqual({
      reason: "rate_limited", fetchedAt: "2026-11-10T02:10:00.000Z", retryAt: "2026-11-10T02:20:00.000Z",
    });
    expect(response.claude?.sevenDayPercent).toBe(91);
    expect(response.claudeError).toBeUndefined();
    expect(response.fetchedAt).toBe("2026-11-10T02:10:00.000Z");
    nowMs += 20_000;
    await handlers["account_usage_request"]!({ type: "account_usage_request", v: 1, id: "s2" }, ctx);
    expect(calls).toBe(2);
  });
});
