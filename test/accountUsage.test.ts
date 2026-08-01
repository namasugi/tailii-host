// accountUsage.test.ts — アカウント使用量（account-usage）のハンドラ・パーサ

import { describe, expect, it } from "vitest";
import {
  CLAUDE_ACCOUNT_USAGE_ERROR,
  CLAUDE_WINDOW_KEYS,
  CODEX_ACCOUNT_USAGE_ERROR,
  CODEX_WINDOW_KEYS,
  createAccountUsageHandlers,
  dropExpiredWindows,
  toClaudeAccountUsage,
} from "../src/engine/handlers/accountUsage.js";
import { parseCodexAccountUsage } from "../src/codex/codexAccountUsage.js";
import {
  collectAccountIdentities,
  emailFromClaudeAuthStatus,
  emailFromCodexAuthJson,
  emailFromIdToken,
  maskEmail,
  type AccountIdentities,
} from "../src/services/accountIdentity.js";
import { collectHostVersions, parseCliVersion } from "../src/services/hostVersions.js";
import type { HandlerContext } from "../src/engine/context.js";
import type {
  ClaudeAccountUsage,
  CodexAccountUsage,
  ControlMessage,
  HostVersions,
} from "../src/protocol.js";
import type { PlanUsage } from "../src/services/planUsageFetcher.js";

/**
 * テスト基準時刻。フィクスチャの resetsAt は**すべてこれより未来**にしてある
 * （リセット済み窓の破棄がテストの主題でない限り、窓が消えないようにする）。
 */
const NOW_MS = Date.parse("2026-07-31T12:00:00.000Z");

const PLAN: PlanUsage = {
  fiveHourUtilization: 42,
  fiveHourResetsAt: "2026-07-31T15:00:00.000Z",
  sevenDayUtilization: 61,
  sevenDayResetsAt: "2026-08-03T00:00:00.000Z",
  sevenDayFableUtilization: 12,
  sevenDayFableResetsAt: "2026-08-03T00:00:00.000Z",
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x",
};

const HOST: HostVersions = {
  hostVersion: "0.2.0",
  claudeCliVersion: "2.1.220",
  codexCliVersion: "0.145.0",
};

/** host が既にマスク済みのアカウント（ワイヤーへ載るのはこの形だけ）。 */
const ACCOUNTS: AccountIdentities = { claude: "a***@example.com", codex: "b***@example.com" };

const CODEX: CodexAccountUsage = {
  planType: "plus",
  fiveHourPercent: 30,
  fiveHourResetsAt: "2026-07-31T16:00:00.000Z",
  weeklyPercent: 55,
  weeklyResetsAt: "2026-08-04T09:00:00.000Z",
};

/** account_usage_request を 1 回処理し、書き出された応答と各 provider の呼び出し回数を返す。 */
function makeHarness(options: {
  now: () => number;
  plan: () => Promise<PlanUsage | null>;
  codex: () => Promise<CodexAccountUsage | null>;
  host?: () => Promise<HostVersions | null>;
  accounts?: () => Promise<AccountIdentities>;
  claudeTtlMs?: number;
  codexTtlMs?: number;
}): {
  request: (id: string) => Promise<Extract<ControlMessage, { type: "account_usage_response" }>>;
  written: ControlMessage[];
  calls: { plan: number; codex: number; host: number };
} {
  const written: ControlMessage[] = [];
  const calls = { plan: 0, codex: 0, host: 0 };
  const host = options.host ?? (async (): Promise<HostVersions | null> => HOST);
  const accounts = options.accounts ?? (async (): Promise<AccountIdentities> => ACCOUNTS);
  const handlers = createAccountUsageHandlers({
    now: options.now,
    ...(options.claudeTtlMs !== undefined && { claudeTtlMs: options.claudeTtlMs }),
    ...(options.codexTtlMs !== undefined && { codexTtlMs: options.codexTtlMs }),
  });
  const ctx = {
    writer: { write: (message: ControlMessage) => { written.push(message); } },
    state: { negotiatedVersion: 1 },
    planUsage: async () => { calls.plan += 1; return options.plan(); },
    codexAccountUsage: async () => { calls.codex += 1; return options.codex(); },
    hostVersions: async () => { calls.host += 1; return host(); },
    accountIdentity: async () => accounts(),
  } as unknown as HandlerContext;

  return {
    written,
    calls,
    request: async (id: string) => {
      const handler = handlers["account_usage_request"];
      if (handler === undefined) throw new Error("account_usage_request ハンドラが未登録");
      await handler({ type: "account_usage_request", v: 1, id }, ctx);
      const last = written[written.length - 1];
      if (last === undefined || last.type !== "account_usage_response") {
        throw new Error("account_usage_response が書かれていない");
      }
      return last;
    },
  };
}

describe("account_usage_request ハンドラ", () => {
  it("両方取得できたら claude/codex を載せ error を出さない", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => PLAN,
      codex: async () => CODEX,
    });
    const response = await harness.request("au-1");
    expect(response.id).toBe("au-1");
    expect(response.claude).toEqual<ClaudeAccountUsage>({
      fiveHourPercent: 42,
      fiveHourResetsAt: "2026-07-31T15:00:00.000Z",
      sevenDayPercent: 61,
      sevenDayResetsAt: "2026-08-03T00:00:00.000Z",
      premiumPercent: 12,
      premiumResetsAt: "2026-08-03T00:00:00.000Z",
      plan: "max",
      rateLimitTier: "default_claude_max_20x",
      account: "a***@example.com",
    });
    expect(response.codex).toEqual({ ...CODEX, account: "b***@example.com" });
    expect(response.claudeError).toBeUndefined();
    expect(response.codexError).toBeUndefined();
    expect(response.host).toEqual(HOST);
    expect(response.fetchedAt).toBe(new Date(NOW_MS).toISOString());
  });

  it("host を取得できなければ host を省略する（使用量表示は巻き込まない）", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => PLAN,
      codex: async () => CODEX,
      host: async () => null,
    });
    const response = await harness.request("au-5");
    expect(response.host).toBeUndefined();
    expect(response.claude?.fiveHourPercent).toBe(42);
  });

  it("host provider の例外も応答を壊さない", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => PLAN,
      codex: async () => CODEX,
      host: async () => { throw new Error("boom"); },
    });
    const response = await harness.request("au-6");
    expect(response.host).toBeUndefined();
    expect(response.codex).toEqual({ ...CODEX, account: "b***@example.com" });
  });

  it("アカウントが取れなければ account を省略する（使用量は出す）", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => PLAN,
      codex: async () => CODEX,
      accounts: async () => ({}),
    });
    const response = await harness.request("au-7");
    expect(response.claude?.account).toBeUndefined();
    expect(response.codex?.account).toBeUndefined();
    expect(response.claude?.fiveHourPercent).toBe(42);
  });

  it("使用量と同じ token 由来の account を auth status の値で上書きしない", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => ({ ...PLAN, account: "s***@same-token.example" }),
      codex: async () => CODEX,
      accounts: async () => ({ claude: "o***@other-source.example" }),
    });
    const response = await harness.request("au-same-token");
    expect(response.claude?.account).toBe("s***@same-token.example");
  });

  it("同じ token の profile が読めない時は別認証源の account を誤表示しない", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => ({ ...PLAN, account: null }),
      codex: async () => CODEX,
      accounts: async () => ({ claude: "o***@other-source.example" }),
    });
    const response = await harness.request("au-profile-unavailable");
    expect(response.claude?.account).toBeUndefined();
    expect(response.claude?.fiveHourPercent).toBe(42);
  });

  it("アカウント provider の例外も応答を壊さない", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => PLAN,
      codex: async () => CODEX,
      accounts: async () => { throw new Error("boom"); },
    });
    const response = await harness.request("au-8");
    expect(response.claude?.account).toBeUndefined();
    expect(response.claude?.fiveHourPercent).toBe(42);
  });

  it("リセット済みの窓だけを落とし、生きている窓と plan / account は残す", async () => {
    // 5時間枠だけが過ぎた時刻（7日枠・上位モデル枠はまだ先）。
    const afterFiveHour = Date.parse("2026-07-31T15:00:00.001Z");
    const harness = makeHarness({
      now: () => afterFiveHour,
      plan: async () => PLAN,
      codex: async () => CODEX,
    });
    const response = await harness.request("au-9");
    // 使用率とリセット時刻はペアで消える。
    expect(response.claude?.fiveHourPercent).toBeUndefined();
    expect(response.claude?.fiveHourResetsAt).toBeUndefined();
    expect(response.claude?.sevenDayPercent).toBe(61);
    expect(response.claude?.premiumPercent).toBe(12);
    expect(response.claude?.plan).toBe("max");
    expect(response.claude?.account).toBe("a***@example.com");
    // Codex 側の 5時間枠は 16:00 リセットなのでまだ生きている。
    expect(response.codex?.fiveHourPercent).toBe(30);
  });

  it("全窓がリセット済みでも plan / account は残す（カードは出て枠行が無いだけ）", async () => {
    const farFuture = Date.parse("2027-01-01T00:00:00.000Z");
    const harness = makeHarness({
      now: () => farFuture,
      plan: async () => PLAN,
      codex: async () => CODEX,
    });
    const response = await harness.request("au-10");
    expect(response.claude).toEqual({
      plan: "max",
      rateLimitTier: "default_claude_max_20x",
      account: "a***@example.com",
    });
    expect(response.codex).toEqual({ planType: "plus", account: "b***@example.com" });
    expect(response.claudeError).toBeUndefined();
    expect(response.codexError).toBeUndefined();
  });

  it("窓の破棄は TTL キャッシュ本体を汚さない（次回も同じ判定ができる）", async () => {
    // TTL（10分）の内側で 5時間枠のリセットを跨げるよう、期限を 1 分後に置いた plan を使う。
    const soon: PlanUsage = {
      ...PLAN,
      fiveHourResetsAt: new Date(NOW_MS + 60_000).toISOString(),
    };
    let nowMs = NOW_MS;
    const harness = makeHarness({
      now: () => nowMs,
      plan: async () => soon,
      codex: async () => CODEX,
      claudeTtlMs: 600_000,
      codexTtlMs: 600_000,
    });
    // 1 回目はまだ未来なので窓が残る。
    expect((await harness.request("au-1")).claude?.fiveHourPercent).toBe(42);
    // TTL 内のまま期限だけ跨ぐ → 再取得は起きず、窓だけ落ちる。
    nowMs = NOW_MS + 61_000;
    expect((await harness.request("au-2")).claude?.fiveHourPercent).toBeUndefined();
    expect(harness.calls.plan).toBe(1);
    // 巻き戻せばまた出る = キャッシュ本体は削られていない。
    nowMs = NOW_MS;
    expect((await harness.request("au-3")).claude?.fiveHourPercent).toBe(42);
    expect(harness.calls.plan).toBe(1);
  });

  it("片側だけ失敗しても、もう片側は載る（error 封筒にしない）", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => PLAN,
      codex: async () => null,
    });
    const response = await harness.request("au-2");
    expect(response.claude?.fiveHourPercent).toBe(42);
    expect(response.codex).toBeUndefined();
    expect(response.codexError).toBe(CODEX_ACCOUNT_USAGE_ERROR);
    expect(response.claudeError).toBeUndefined();
  });

  it("両側失敗でも応答は返し、両方の error 文字列を載せる", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => null,
      codex: async () => null,
    });
    const response = await harness.request("au-3");
    expect(response.claude).toBeUndefined();
    expect(response.codex).toBeUndefined();
    expect(response.claudeError).toBe(CLAUDE_ACCOUNT_USAGE_ERROR);
    expect(response.codexError).toBe(CODEX_ACCOUNT_USAGE_ERROR);
  });

  it("provider の例外は error 応答へ落とし、throw しない", async () => {
    const harness = makeHarness({
      now: () => NOW_MS,
      plan: async () => { throw new Error("boom"); },
      codex: async () => { throw new Error("boom"); },
    });
    const response = await harness.request("au-4");
    expect(response.claudeError).toBe(CLAUDE_ACCOUNT_USAGE_ERROR);
    expect(response.codexError).toBe(CODEX_ACCOUNT_USAGE_ERROR);
  });

  it("TTL 内は再取得せず前回値を返し、fetchedAt は取得時刻のまま", async () => {
    let nowMs = NOW_MS;
    const harness = makeHarness({
      now: () => nowMs,
      plan: async () => PLAN,
      codex: async () => CODEX,
      claudeTtlMs: 120_000,
      codexTtlMs: 60_000,
    });
    const first = await harness.request("au-1");
    expect(harness.calls).toEqual({ plan: 1, codex: 1, host: 1 });

    // 30 秒後: どちらも TTL 内 → 再取得なし・fetchedAt も初回のまま。
    nowMs += 30_000;
    const second = await harness.request("au-2");
    expect(harness.calls).toEqual({ plan: 1, codex: 1, host: 2 });
    expect(second.fetchedAt).toBe(first.fetchedAt);

    // 通算 90 秒後: codex だけ TTL 超過 → codex のみ再取得。
    nowMs += 60_000;
    const third = await harness.request("au-3");
    expect(harness.calls).toEqual({ plan: 1, codex: 2, host: 3 });
    // fetchedAt は載せた値のうち最も古い取得時刻（= claude の初回取得）。
    expect(third.fetchedAt).toBe(first.fetchedAt);

    // 通算 150 秒後: claude も TTL 超過 → 両方再取得し fetchedAt が進む。
    nowMs += 60_000;
    const fourth = await harness.request("au-4");
    expect(harness.calls).toEqual({ plan: 2, codex: 3, host: 4 });
    expect(fourth.fetchedAt).toBe(new Date(nowMs).toISOString());
  });

  it("失敗も TTL でキャッシュする（連打で外部 API を叩かない）", async () => {
    let nowMs = NOW_MS;
    const harness = makeHarness({
      now: () => nowMs,
      plan: async () => null,
      codex: async () => null,
      claudeTtlMs: 120_000,
      codexTtlMs: 60_000,
    });
    await harness.request("au-1");
    nowMs += 1_000;
    await harness.request("au-2");
    expect(harness.calls).toEqual({ plan: 1, codex: 1, host: 2 });
  });
});

describe("toClaudeAccountUsage", () => {
  it("PlanUsage の null 枠は省略する", () => {
    expect(
      toClaudeAccountUsage({
        fiveHourUtilization: 7,
        fiveHourResetsAt: null,
        sevenDayUtilization: null,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
      }),
    ).toEqual({ fiveHourPercent: 7 });
  });

  it("credentials 由来のプラン情報を plan / rateLimitTier へ写す（欠落は省略）", () => {
    expect(
      toClaudeAccountUsage({
        fiveHourUtilization: 7,
        fiveHourResetsAt: null,
        sevenDayUtilization: null,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toEqual({
      fiveHourPercent: 7,
      plan: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    expect(
      toClaudeAccountUsage({
        fiveHourUtilization: 7,
        fiveHourResetsAt: null,
        sevenDayUtilization: null,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
        subscriptionType: null,
        rateLimitTier: null,
      }),
    ).toEqual({ fiveHourPercent: 7 });
  });

  it("同じ OAuth token 由来のマスク済み account を wire へ写す", () => {
    expect(
      toClaudeAccountUsage({
        fiveHourUtilization: 7,
        fiveHourResetsAt: null,
        sevenDayUtilization: null,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
        account: "a***@example.com",
      }),
    ).toEqual({ fiveHourPercent: 7, account: "a***@example.com" });
  });

  it("null / 全枠 null は null（= claudeError へ落ちる）", () => {
    expect(toClaudeAccountUsage(null)).toBeNull();
    expect(
      toClaudeAccountUsage({
        fiveHourUtilization: null,
        fiveHourResetsAt: "2026-07-31T15:00:00.000Z",
        sevenDayUtilization: null,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
      }),
    ).toBeNull();
  });
});

describe("parseCodexAccountUsage", () => {
  it("v2 camelCase 応答を 5時間枠 / 週次枠へ写す（resetsAt は Unix 秒 → ISO）", () => {
    expect(
      parseCodexAccountUsage({
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 29.6, windowMinutes: 300, resetsAt: 1_785_000_000 },
          secondary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: 1_785_400_000 },
        },
      }),
    ).toEqual({
      planType: "plus",
      fiveHourPercent: 30,
      fiveHourResetsAt: new Date(1_785_000_000_000).toISOString(),
      weeklyPercent: 55,
      weeklyResetsAt: new Date(1_785_400_000_000).toISOString(),
    });
  });

  it("snake_case / rateLimits 包み無しも読む", () => {
    expect(
      parseCodexAccountUsage({
        primary: { used_percent: 10, resets_at: 1_785_000_000 },
      }),
    ).toEqual({
      fiveHourPercent: 10,
      fiveHourResetsAt: new Date(1_785_000_000_000).toISOString(),
    });
  });

  it("枠は位置ではなく windowDurationMins で分類する（prolite 実測: primary が週次のみ）", () => {
    // 0.145 実機応答: primary=10080分（週次）・secondary=null のアカウントが存在する。
    expect(
      parseCodexAccountUsage({
        rateLimits: {
          planType: "prolite",
          primary: { usedPercent: 1, windowDurationMins: 10_080, resetsAt: 1_785_905_955 },
          secondary: null,
        },
      }),
    ).toEqual({
      planType: "prolite",
      weeklyPercent: 1,
      weeklyResetsAt: new Date(1_785_905_955_000).toISOString(),
    });
  });

  it("枠が 1 つも読めなければ null（planType だけでは使用量を語れない）", () => {
    expect(parseCodexAccountUsage(null)).toBeNull();
    expect(parseCodexAccountUsage({ rateLimits: { planType: "pro" } })).toBeNull();
  });
});

describe("dropExpiredWindows", () => {
  const nowMs = Date.parse("2026-07-31T12:00:00.000Z");

  it("resetsAt が過去の窓は percent とペアで落とす", () => {
    expect(
      dropExpiredWindows(
        {
          fiveHourPercent: 42,
          fiveHourResetsAt: "2026-07-31T11:59:59.000Z",
          sevenDayPercent: 61,
          sevenDayResetsAt: "2026-08-03T00:00:00.000Z",
        },
        nowMs,
        CLAUDE_WINDOW_KEYS,
      ),
    ).toEqual({ sevenDayPercent: 61, sevenDayResetsAt: "2026-08-03T00:00:00.000Z" });
  });

  it("resetsAt がちょうど now なら落とす（境界は「もうリセット済み」側）", () => {
    expect(
      dropExpiredWindows(
        { weeklyPercent: 55, weeklyResetsAt: "2026-07-31T12:00:00.000Z" },
        nowMs,
        CODEX_WINDOW_KEYS,
      ),
    ).toEqual({});
  });

  it("resetsAt が無い/読めない窓は落とさない（判定不能は表示継続）", () => {
    expect(
      dropExpiredWindows({ fiveHourPercent: 42 }, nowMs, CLAUDE_WINDOW_KEYS),
    ).toEqual({ fiveHourPercent: 42 });
    expect(
      dropExpiredWindows(
        { fiveHourPercent: 42, fiveHourResetsAt: "そのうち" },
        nowMs,
        CLAUDE_WINDOW_KEYS,
      ),
    ).toEqual({ fiveHourPercent: 42, fiveHourResetsAt: "そのうち" });
  });

  it("元のオブジェクトは書き換えない（TTL キャッシュ共有物を守る）", () => {
    const original: ClaudeAccountUsage = {
      fiveHourPercent: 42,
      fiveHourResetsAt: "2026-07-31T11:00:00.000Z",
    };
    dropExpiredWindows(original, nowMs, CLAUDE_WINDOW_KEYS);
    expect(original.fiveHourPercent).toBe(42);
  });
});

describe("maskEmail", () => {
  it("local part の先頭1文字だけを残す", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("  bob@sub.example.co.jp  ")).toBe("b***@sub.example.co.jp");
    // 1 文字 local でも情報が増えない形にする。
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("不正形は undefined（マスクできない値をそのまま出さない）", () => {
    expect(maskEmail("invalid")).toBeUndefined();
    expect(maskEmail("@example.com")).toBeUndefined();
    expect(maskEmail("alice@")).toBeUndefined();
    expect(maskEmail("a@b@c.com")).toBeUndefined();
    expect(maskEmail("alice@exa mple.com")).toBeUndefined();
    expect(maskEmail("")).toBeUndefined();
    expect(maskEmail(null)).toBeUndefined();
    expect(maskEmail(undefined)).toBeUndefined();
  });
});

describe("アカウント ID の取得（生 email はワイヤーへ出さない）", () => {
  /** 署名しない偽 id_token（payload だけが意味を持つ）。 */
  function fakeIdToken(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return `eyJhbGciOiJSUzI1NiJ9.${payload}.not-a-real-signature`;
  }

  it("emailFromIdToken は claims の email を読む（署名は検証しない）", () => {
    expect(emailFromIdToken(fakeIdToken({ email: "alice@example.com", sub: "u1" })))
      .toBe("alice@example.com");
    expect(emailFromIdToken(fakeIdToken({ sub: "u1" }))).toBeUndefined();
    expect(emailFromIdToken("not.a.jwt.at.all")).toBeUndefined();
    expect(emailFromIdToken("onlyonepart")).toBeUndefined();
    expect(emailFromIdToken(42)).toBeUndefined();
  });

  it("emailFromCodexAuthJson は tokens.id_token を辿る", () => {
    const auth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: fakeIdToken({ email: "alice@example.com" }), access_token: "secret" },
    });
    expect(emailFromCodexAuthJson(auth)).toBe("alice@example.com");
    expect(emailFromCodexAuthJson('{"tokens":{}}')).toBeUndefined();
    expect(emailFromCodexAuthJson("{}")).toBeUndefined();
    expect(emailFromCodexAuthJson("not json")).toBeUndefined();
    expect(emailFromCodexAuthJson(null)).toBeUndefined();
  });

  it("emailFromClaudeAuthStatus は camelCase 応答を読み、未ログインは undefined", () => {
    // 2.1.220 実測の出力形。
    const status = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "alice@example.com",
      subscriptionType: "max",
    });
    expect(emailFromClaudeAuthStatus(status)).toBe("alice@example.com");
    expect(emailFromClaudeAuthStatus('{"loggedIn":false}')).toBeUndefined();
    expect(emailFromClaudeAuthStatus("not json")).toBeUndefined();
    expect(emailFromClaudeAuthStatus(null)).toBeUndefined();
  });

  it("collectAccountIdentities はマスク済みだけを返す（生 email を返さない）", async () => {
    const identities = await collectAccountIdentities({
      exec: async () => JSON.stringify({ loggedIn: true, email: "alice@example.com" }),
      readCodexAuth: () =>
        JSON.stringify({ tokens: { id_token: fakeIdToken({ email: "bob@example.org" }) } }),
    });
    expect(identities).toEqual({ claude: "a***@example.com", codex: "b***@example.org" });
    expect(JSON.stringify(identities)).not.toContain("alice@");
    expect(JSON.stringify(identities)).not.toContain("bob@");
  });

  it("取れなかった側は省略し、両方駄目なら空オブジェクト", async () => {
    expect(
      await collectAccountIdentities({
        exec: async () => null,
        readCodexAuth: () => JSON.stringify({ tokens: { id_token: fakeIdToken({ email: "b@e.org" }) } }),
      }),
    ).toEqual({ codex: "b***@e.org" });
    expect(
      await collectAccountIdentities({ exec: async () => null, readCodexAuth: () => null }),
    ).toEqual({});
  });

  it("exec / ファイル読みの例外を握り潰す", async () => {
    expect(
      await collectAccountIdentities({
        exec: async () => { throw new Error("boom"); },
        readCodexAuth: () => { throw new Error("boom"); },
      }),
    ).toEqual({});
  });

  it("claude auth status は --json で 1 回だけ呼ぶ", async () => {
    const calls: string[][] = [];
    await collectAccountIdentities({
      exec: async (command, args) => {
        calls.push([command, ...args]);
        return null;
      },
      readCodexAuth: () => null,
    });
    expect(calls).toEqual([["claude", "auth", "status", "--json"]]);
  });
});

describe("parseCliVersion", () => {
  it("各 CLI の飾りを落としてバージョンだけを返す（2026-07 実測フォーマット）", () => {
    expect(parseCliVersion("2.1.220 (Claude Code)\n")).toBe("2.1.220");
    expect(parseCliVersion("codex-cli 0.145.0\n")).toBe("0.145.0");
    expect(parseCliVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  it("数字列が見つからなければ 1 行目をそのまま返し、空/null は undefined", () => {
    expect(parseCliVersion("unversioned build")).toBe("unversioned build");
    expect(parseCliVersion("")).toBeUndefined();
    expect(parseCliVersion("   \n")).toBeUndefined();
    expect(parseCliVersion(null)).toBeUndefined();
  });
});

describe("collectHostVersions", () => {
  /** `--version` 呼び出しを決定化する偽 exec。 */
  function fakeExec(map: Record<string, string | null>) {
    const seen: string[] = [];
    return {
      seen,
      exec: async (command: string): Promise<string | null> => {
        seen.push(command);
        return map[command] ?? null;
      },
    };
  }

  it("3 種すべて取れたら 3 フィールドを載せる", async () => {
    const { exec, seen } = fakeExec({
      claude: "2.1.220 (Claude Code)\n",
      codex: "codex-cli 0.145.0\n",
    });
    expect(await collectHostVersions({ exec, packageVersion: () => "0.2.0" })).toEqual({
      hostVersion: "0.2.0",
      claudeCliVersion: "2.1.220",
      codexCliVersion: "0.145.0",
    });
    expect(seen.sort()).toEqual(["claude", "codex"]);
  });

  it("取れなかった行は省略する（『取得失敗』を表示しない）", async () => {
    const { exec } = fakeExec({ codex: "codex-cli 0.145.0" });
    expect(await collectHostVersions({ exec, packageVersion: () => null })).toEqual({
      codexCliVersion: "0.145.0",
    });
  });

  it("1 つも取れなければ null（host オブジェクト自体を載せない）", async () => {
    const { exec } = fakeExec({});
    expect(await collectHostVersions({ exec, packageVersion: () => null })).toBeNull();
  });

  it("packageVersion の例外・exec の例外は握り潰す", async () => {
    expect(
      await collectHostVersions({
        exec: async () => { throw new Error("boom"); },
        packageVersion: () => { throw new Error("boom"); },
      }),
    ).toBeNull();
  });
});
