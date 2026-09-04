// systemNotice.test.ts — transcript の system 行を利用者向け注記へ転写する純ロジック（system-notice）。
// 実測レコード（2026-09-03/04, claude 2.1.259）をフィクスチャにする。

import { describe, expect, test } from "vitest";
import {
  claudeModelDisplayName,
  createSystemNoticeContext,
  fallbackBlockNotice,
  systemNoticeText,
} from "../src/shared/systemNotice.js";

describe("claudeModelDisplayName", () => {
  test("family と版を人間向け表記へ", () => {
    expect(claudeModelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(claudeModelDisplayName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(claudeModelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(claudeModelDisplayName("claude-fable-5")).toBe("Fable 5");
  });

  test("[1m] 等のブラケット接尾辞と 8 桁日付接尾辞を扱う（日付を版番号に誤読しない）", () => {
    expect(claudeModelDisplayName("claude-opus-5[1m]")).toBe("Opus 5 (1M)");
    expect(claudeModelDisplayName("claude-fable-5-1[1m]")).toBe("Fable 5.1 (1M)");
    expect(claudeModelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    // 実在 id: 旧実装は `-(\d+)` の貪欲一致で "Sonnet 4.20250514" になっていた。
    expect(claudeModelDisplayName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(claudeModelDisplayName("claude-opus-4-20250514")).toBe("Opus 4");
    expect(claudeModelDisplayName("claude-opus-4-1-20250805")).toBe("Opus 4.1");
  });

  test("未知の形はそのまま返す", () => {
    expect(claudeModelDisplayName("gpt-5.4")).toBe("gpt-5.4");
    expect(claudeModelDisplayName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
    expect(claudeModelDisplayName("opus")).toBe("opus");
    expect(claudeModelDisplayName("")).toBe("");
  });
});

describe("systemNoticeText: モデル自動切替", () => {
  test("model_refusal_fallback: セーフガードによる切替を from→to と判定付きで転写する（実測）", () => {
    const rec = {
      type: "system", subtype: "model_refusal_fallback", level: "warning",
      content: "Fable 5.1's safeguards flagged this message. … Switched to Opus 4.8. …\n\nDetails: `[cyber]`",
      originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-4-8",
      apiRefusalCategory: "cyber", trigger: "refusal", direction: "retry", scope: "session",
    };
    expect(systemNoticeText(rec)).toBe(
      "⚠️ セーフガードにより Fable 5.1 が応答を退けたため、Opus 4.8 へ切り替えました（判定: cyber）。" +
      "以降この会話は Opus 4.8 で応答します。/model で変更できます。",
    );
  });

  test("model_refusal_fallback: 判定カテゴリが無い/想定外の値なら括弧を付けない・originalModel 欠落は「元のモデル」", () => {
    const base = { type: "system", subtype: "model_refusal_fallback", level: "warning", fallbackModel: "claude-opus-4-8" };
    expect(systemNoticeText({ ...base, originalModel: "claude-fable-5-1", apiRefusalCategory: null })).toBe(
      "⚠️ セーフガードにより Fable 5.1 が応答を退けたため、Opus 4.8 へ切り替えました。" +
      "以降この会話は Opus 4.8 で応答します。/model で変更できます。",
    );
    // 長文・記号のカテゴリはそのまま埋め込まない。
    expect(systemNoticeText({ ...base, originalModel: "claude-fable-5-1", apiRefusalCategory: "x".repeat(40) }))
      .not.toContain("判定");
    expect(systemNoticeText({ ...base, apiRefusalCategory: "cyber" })).toBe(
      "⚠️ セーフガードにより 元のモデル が応答を退けたため、Opus 4.8 へ切り替えました（判定: cyber）。" +
      "以降この会話は Opus 4.8 で応答します。/model で変更できます。",
    );
  });

  test("model_consent_fallback: 利用枠による切替を転写する（実測・[1m] 接尾辞）", () => {
    const rec = {
      type: "system", subtype: "model_consent_fallback", level: "warning",
      content: "Switched to Opus 5 (1M context) for this session · Fable 5 requires usage credits · /model to change",
      choice: "switch_default", originalModel: "claude-fable-5", fallbackModel: "claude-opus-5[1m]",
    };
    expect(systemNoticeText(rec)).toBe(
      "⚠️ Fable 5 は利用クレジットが必要なため、この会話は Opus 5 (1M) へ切り替わりました。/model で変更できます。",
    );
  });

  test("fallbackModel が無ければ content を汎用警告として出す / 本文も無ければ null", () => {
    expect(systemNoticeText({ type: "system", subtype: "model_refusal_fallback", level: "warning", content: "x" }))
      .toBe("⚠️ x");
    expect(systemNoticeText({ type: "system", subtype: "model_refusal_fallback", level: "warning" })).toBeNull();
  });

  test("fallback ブロック（assistant 行）で実時刻に告知し、後続の system 行は同じ切替なら重複させない", () => {
    const ctx = createSystemNoticeContext();
    const content = [{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-4-8" } }];
    expect(fallbackBlockNotice(content, ctx)).toBe(
      "⚠️ Fable 5.1 が応答を退けたため、Opus 4.8 へ切り替えました。以降この会話は Opus 4.8 で応答します。/model で変更できます。",
    );
    // 38 秒後に来る system 行（同じ from→to）は出さない。
    expect(systemNoticeText({
      type: "system", subtype: "model_refusal_fallback", level: "warning",
      originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-4-8", apiRefusalCategory: "cyber",
    }, ctx)).toBeNull();
    // 別の切替（to が違う）は出す。
    expect(systemNoticeText({
      type: "system", subtype: "model_refusal_fallback", level: "warning",
      originalModel: "claude-fable-5-1", fallbackModel: "claude-sonnet-5",
    }, ctx)).toContain("Sonnet 5 へ切り替えました");
    // ブロック無し / to 欠落 / 非配列は null。
    expect(fallbackBlockNotice([{ type: "text", text: "hi" }])).toBeNull();
    expect(fallbackBlockNotice([{ type: "fallback", from: { model: "a" } }])).toBeNull();
    expect(fallbackBlockNotice("string")).toBeNull();
  });
});

describe("systemNoticeText: API エラー", () => {
  const first = {
    type: "system", subtype: "api_error", level: "error",
    error: { message: "502 <html>…", status: 502, formatted: "502 Bad Gateway" },
    retryInMs: 523.5, retryAttempt: 1, maxRetries: 10,
  };

  test("初回試行は formatted と試行回数付きで転写する（実測）", () => {
    expect(systemNoticeText(first)).toBe("❌ API エラー: 502 Bad Gateway（自動再試行 1/10 回目）");
  });

  test("context あり: 同じエラーの再試行は出さず、種別が変わったら出す（実測: 502 → 401）", () => {
    const ctx = createSystemNoticeContext();
    expect(systemNoticeText(first, ctx)).not.toBeNull();
    expect(systemNoticeText({ ...first, retryAttempt: 2 }, ctx)).toBeNull();
    expect(systemNoticeText({ ...first, retryAttempt: 3 }, ctx)).toBeNull();
    const auth = {
      ...first, retryAttempt: 4,
      error: { message: "401 {…}", status: 401, formatted: "401 Invalid authentication credentials" },
    };
    expect(systemNoticeText(auth, ctx)).toBe(
      "❌ API エラー: 401 Invalid authentication credentials（認証が切れています。/login でログインし直してください）",
    );
    // 同じ 401 の連投は出さない。
    expect(systemNoticeText({ ...auth, retryAttempt: 5 }, ctx)).toBeNull();
  });

  test("context なし: 初回 / 認証・権限・レート系 / 上限到達だけ出す", () => {
    expect(systemNoticeText({ ...first, retryAttempt: 2 })).toBeNull();
    expect(systemNoticeText({ ...first, retryAttempt: 2, error: { status: 429, formatted: "429 Too Many Requests" } }))
      .toBe("❌ API エラー: 429 Too Many Requests（自動再試行 2/10 回目）");
    expect(systemNoticeText({ ...first, retryAttempt: 10 }))
      .toBe("❌ API エラー: 502 Bad Gateway（再試行 10 回で上限に達しました）");
  });

  test("retryAttempt 欠落・文字列・error 非オブジェクトでも落ちない", () => {
    expect(systemNoticeText({ type: "system", subtype: "api_error", level: "error", error: { formatted: "x" } }))
      .toBe("❌ API エラー: x（自動再試行中）");
    expect(systemNoticeText({ ...first, retryAttempt: "1" })).toBe("❌ API エラー: 502 Bad Gateway（自動再試行 1/10 回目）");
    expect(systemNoticeText({ type: "system", subtype: "api_error", level: "error", error: "boom", retryAttempt: 1 }))
      .toBe("❌ API エラーが発生しました（自動再試行中）");
  });

  test("formatted が無ければ HTTP status、それも無ければ message 1 行目（JSON/HTML を丸出しにしない・上限あり）", () => {
    expect(systemNoticeText({
      type: "system", subtype: "api_error", level: "error", retryAttempt: 1,
      error: { message: "502 <html>\r\n<head>…", status: 502 },
    })).toBe("❌ API エラー: HTTP 502（自動再試行中）");
    expect(systemNoticeText({
      type: "system", subtype: "api_error", level: "error", retryAttempt: 1,
      error: { message: "boom\nsecond line" },
    })).toBe("❌ API エラー: boom（自動再試行中）");
    const long = systemNoticeText({
      type: "system", subtype: "api_error", level: "error", retryAttempt: 1,
      error: { formatted: "z".repeat(3000) },
    });
    expect(long).not.toBeNull();
    expect([...(long as string)].length).toBeLessThan(200);
    expect(long).toContain("…");
  });
});

describe("systemNoticeText: 会話圧縮・汎用・落とす行", () => {
  test("compact_boundary: 契機と token 数を転写し、Claude 側の文脈が置き換わったことを伝える（実測）", () => {
    const rec = {
      type: "system", subtype: "compact_boundary", level: "info", content: "Conversation compacted",
      compactMetadata: { trigger: "auto", preTokens: 999849, postTokens: 8622, cumulativeDroppedTokens: 991227 },
    };
    expect(systemNoticeText(rec)).toBe(
      "🧹 会話を自動で圧縮しました（999,849 → 8,622 tokens）。Claude 側の文脈は要約に置き換わりました（アプリの表示はそのまま）。",
    );
    // trigger 未知値 / metadata 欠落でも落ちない。
    expect(systemNoticeText({ ...rec, compactMetadata: { trigger: "weird", preTokens: 1, postTokens: 2 } }))
      .toBe("🧹 会話を圧縮しました（1 → 2 tokens）。Claude 側の文脈は要約に置き換わりました（アプリの表示はそのまま）。");
    expect(systemNoticeText({ type: "system", subtype: "compact_boundary", level: "info", content: "Conversation compacted" }))
      .toBe("🧹 会話を圧縮しました。Claude 側の文脈は要約に置き換わりました（アプリの表示はそのまま）。");
  });

  test("汎用: warning/error 級で本文がある未知 subtype は絵文字付きで出す（Remote Control 切断など）", () => {
    expect(systemNoticeText({
      type: "system", subtype: "informational", level: "warning",
      content: "Remote Control disconnected — /login",
    })).toBe("⚠️ Remote Control disconnected — /login");
    expect(systemNoticeText({ type: "system", subtype: "something_new", level: "error", content: "boom" }))
      .toBe("❌ boom");
  });

  test("汎用: 端末向けの RC 案内（複製インスタンス並走時）は iPhone では出さない", () => {
    expect(systemNoticeText({
      type: "system", subtype: "informational", level: "warning",
      content: "Remote Control not started here · another Claude Code on this machine (started 11m ago) already has Remote Control for this conversation · run /remote-control to move it to this terminal",
    })).toBeNull();
  });

  test("汎用: 同一文言の連投は context で抑え、長文は上限で切り改行を畳む", () => {
    const ctx = createSystemNoticeContext();
    const rec = { type: "system", subtype: "informational", level: "warning", content: "Remote Control disconnected — /login" };
    expect(systemNoticeText(rec, ctx)).not.toBeNull();
    expect(systemNoticeText(rec, ctx)).toBeNull();
    expect(systemNoticeText({ ...rec, content: "別の警告" }, ctx)).toBe("⚠️ 別の警告");
    const long = systemNoticeText({ ...rec, content: "a\nb " + "x".repeat(500) });
    expect(long).not.toBeNull();
    expect(long).not.toContain("\n");
    expect([...(long as string)].length).toBeLessThan(230);
  });

  test("派生・内部情報は流さない（turn_duration / stop_hook_summary / away_summary / notice 級 / info 級未知 / 空本文）", () => {
    expect(systemNoticeText({ type: "system", subtype: "turn_duration", content: "5s" })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "stop_hook_summary", level: "suggestion", content: "" })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "away_summary", content: "要約…" })).toBeNull();
    expect(systemNoticeText({
      type: "system", subtype: "informational", level: "notice",
      content: "Automatic replies for https://claude.ai/code/artifact/x are still off",
    })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "scheduled_task_fire", content: "Claude resuming /loop" })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "informational", level: "warning", content: "   " })).toBeNull();
  });
});
