// systemNotice.test.ts — transcript の system 行を利用者向け注記へ転写する純ロジック（system-notice）。
// 実測レコード（2026-09-03/04, claude 2.1.259）をフィクスチャにする。

import { describe, expect, test } from "vitest";
import { claudeModelDisplayName, systemNoticeText } from "../src/shared/systemNotice.js";

describe("claudeModelDisplayName", () => {
  test("family と版を人間向け表記へ", () => {
    expect(claudeModelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(claudeModelDisplayName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(claudeModelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(claudeModelDisplayName("claude-fable-5")).toBe("Fable 5");
  });

  test("[1m] 等のブラケット接尾辞と日付接尾辞を扱う", () => {
    expect(claudeModelDisplayName("claude-opus-5[1m]")).toBe("Opus 5 (1M)");
    expect(claudeModelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  test("未知の形はそのまま返す", () => {
    expect(claudeModelDisplayName("gpt-5.4")).toBe("gpt-5.4");
    expect(claudeModelDisplayName("")).toBe("");
  });
});

describe("systemNoticeText", () => {
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

  test("model_refusal_fallback: 判定カテゴリが無ければ括弧を付けない", () => {
    const rec = {
      type: "system", subtype: "model_refusal_fallback", level: "warning",
      originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-4-8", apiRefusalCategory: null,
    };
    expect(systemNoticeText(rec)).toBe(
      "⚠️ セーフガードにより Fable 5.1 が応答を退けたため、Opus 4.8 へ切り替えました。" +
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

  test("model fallback: fallbackModel が無ければ content を汎用警告として出す / 本文も無ければ null", () => {
    expect(systemNoticeText({ type: "system", subtype: "model_refusal_fallback", level: "warning", content: "x" }))
      .toBe("⚠️ x");
    expect(systemNoticeText({ type: "system", subtype: "model_refusal_fallback", level: "warning" })).toBeNull();
  });

  test("api_error: 初回試行だけ formatted と再試行上限付きで転写し、再試行分は出さない（実測）", () => {
    const first = {
      type: "system", subtype: "api_error", level: "error",
      error: { message: "502 <html>…", status: 502, formatted: "502 Bad Gateway" },
      retryInMs: 523.5, retryAttempt: 1, maxRetries: 10,
    };
    expect(systemNoticeText(first)).toBe("❌ API エラー: 502 Bad Gateway（自動再試行中・最大 10 回）");
    const second = { ...first, retryAttempt: 2, error: { formatted: "401 Invalid authentication credentials" } };
    expect(systemNoticeText(second)).toBeNull();
  });

  test("api_error: formatted が無ければ message の 1 行目、それも無ければ汎用文", () => {
    expect(systemNoticeText({
      type: "system", subtype: "api_error", level: "error",
      error: { message: "boom\nsecond line" }, retryAttempt: 1,
    })).toBe("❌ API エラー: boom（自動再試行中）");
    expect(systemNoticeText({ type: "system", subtype: "api_error", level: "error", retryAttempt: 1 }))
      .toBe("❌ API エラーが発生しました（自動再試行中）");
  });

  test("compact_boundary: 圧縮の契機と token 数を転写する（実測）", () => {
    const rec = {
      type: "system", subtype: "compact_boundary", level: "info", content: "Conversation compacted",
      compactMetadata: { trigger: "auto", preTokens: 999849, postTokens: 8622, cumulativeDroppedTokens: 991227 },
    };
    expect(systemNoticeText(rec)).toBe(
      "🧹 会話を自動で圧縮しました（999,849 → 8,622 tokens）。これより前の詳細は要約に置き換わっています。",
    );
    expect(systemNoticeText({ type: "system", subtype: "compact_boundary", level: "info", content: "Conversation compacted" }))
      .toBe("🧹 会話を圧縮しました。これより前の詳細は要約に置き換わっています。");
  });

  test("汎用: warning/error 級で本文がある未知 subtype は絵文字付きで出す（Remote Control 切断など）", () => {
    expect(systemNoticeText({
      type: "system", subtype: "informational", level: "warning",
      content: "Remote Control disconnected — /login",
    })).toBe("⚠️ Remote Control disconnected — /login");
    expect(systemNoticeText({ type: "system", subtype: "something_new", level: "error", content: "boom" }))
      .toBe("❌ boom");
  });

  test("派生・内部情報は流さない（turn_duration / stop_hook_summary / away_summary / notice 級 / info 級未知）", () => {
    expect(systemNoticeText({ type: "system", subtype: "turn_duration", content: "5s" })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "stop_hook_summary", level: "suggestion", content: "" })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "away_summary", content: "要約…" })).toBeNull();
    expect(systemNoticeText({
      type: "system", subtype: "informational", level: "notice",
      content: "Automatic replies for https://claude.ai/code/artifact/x are still off",
    })).toBeNull();
    expect(systemNoticeText({ type: "system", subtype: "scheduled_task_fire", content: "Claude resuming /loop" })).toBeNull();
    // warning 級でも本文が空なら出さない。
    expect(systemNoticeText({ type: "system", subtype: "informational", level: "warning", content: "   " })).toBeNull();
  });
});
