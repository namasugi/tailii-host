import { describe, expect, it } from "vitest";
import { parseClaudeExtraUsage, parsePlanUsage } from "../src/services/planUsageFetcher.js";
import { toClaudeAccountUsage } from "../src/engine/handlers/accountUsage.js";

describe("Claude の請求期間の追加利用額", () => {
  it("旧形式の金額は USD の最小単位で保ち、小数を丸めない", () => {
    expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: 1234.5, monthly_limit: 5000 }))
      .toEqual({ isEnabled: true, usedCredits: "1234.5", monthlyLimit: "5000", currency: "USD", decimalPlaces: 2 });
  });

  it("金額の最小単位は ISO 通貨に従い、未知の decimal_places で変更しない", () => {
    expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: 1234, currency: "jpy" }))
      .toMatchObject({ currency: "JPY", decimalPlaces: 0, usedCredits: "1234" });
    expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: 1234, currency: "KWD" }))
      .toMatchObject({ currency: "KWD", decimalPlaces: 3 });
    expect(parseClaudeExtraUsage({ is_enabled: true, currency: "USD", decimal_places: 3 }))
      .toMatchObject({ currency: "USD", decimalPlaces: 2 });
    expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: 1234, currency: "JPY", decimal_places: 2 }))
      .toMatchObject({ currency: "JPY", decimalPlaces: 0 });
  });

  it("無効でも取得できた過去の消費額を捨てず、null を 0 にしない", () => {
    expect(parseClaudeExtraUsage({ is_enabled: false, used_credits: null, monthly_limit: null, currency: null }))
      .toEqual({ isEnabled: false, currency: "USD", decimalPlaces: 2 });
    expect(parseClaudeExtraUsage({ is_enabled: false, used_credits: 100 }))
      .toMatchObject({ isEnabled: false, usedCredits: "100" });
    expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: 0, monthly_limit: 0 }))
      .toMatchObject({ usedCredits: "0", monthlyLimit: "0" });
  });

  it("上限の null は無制限として運ばず、不正な値から金額を作らない", () => {
    for (const value of [null, "100", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const extra = parseClaudeExtraUsage({ is_enabled: true, used_credits: value, monthly_limit: value });
      expect(extra?.usedCredits).toBeUndefined();
      expect(extra?.monthlyLimit).toBeUndefined();
    }
    expect(parseClaudeExtraUsage({ is_enabled: true, monthly_limit: -1 })?.monthlyLimit).toBeUndefined();
    expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: -0.5 })?.usedCredits).toBe("-0.5");
  });

  it("未知の通貨では換算情報を捏造せず、仕様外の表示桁数は無視する", () => {
    for (const currency of ["ZZZ", "USD<script>", 123]) {
      const extra = parseClaudeExtraUsage({ is_enabled: true, used_credits: 100, currency });
      expect(extra?.currency).toBeUndefined();
      expect(extra?.decimalPlaces).toBeUndefined();
    }
    for (const decimal_places of [-1, 9, 1.5, "2"]) {
      expect(parseClaudeExtraUsage({ is_enabled: true, used_credits: 100, decimal_places })?.decimalPlaces).toBe(2);
    }
  });

  it("追加利用だけの応答もアカウント使用量へ運べる", () => {
    const plan = parsePlanUsage({ extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: null } });
    expect(plan?.fiveHourUtilization).toBeNull();
    expect(toClaudeAccountUsage(plan)?.extraUsage)
      .toEqual({ isEnabled: true, usedCredits: "1234", currency: "USD", decimalPlaces: 2 });
  });

  it("空・不正な追加利用だけでは成功にしない", () => {
    for (const raw of [null, [], {}, { currency: "USD" }, { is_enabled: "false" }]) {
      expect(parseClaudeExtraUsage(raw)).toBeUndefined();
      expect(parsePlanUsage({ extra_usage: raw })).toBeNull();
    }
  });

  it("巨大な利用率で Swift 側の数値デコードを壊さない", () => {
    expect(parsePlanUsage({ five_hour: { utilization: Number.MAX_VALUE } })?.fiveHourUtilization).toBe(100);
    expect(parsePlanUsage({ five_hour: { utilization: -Number.MAX_VALUE } })?.fiveHourUtilization).toBe(0);
  });
});
