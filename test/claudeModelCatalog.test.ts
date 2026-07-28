// claudeModelCatalog.test.ts — Models API 応答のキュレーション純ロジック

import { describe, expect, it } from "vitest";
import {
  curateClaudeModels,
  extractApiKeyHelper,
  extractSettingsEnvApiKey,
  normalizeApiKey,
} from "../src/services/claudeModelCatalog.js";

/** 2026-07-28 実測の `/v1/models` 応答形の縮約。 */
const REAL_SHAPE = {
  data: [
    { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" },
    { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-29T00:00:00Z" },
    { type: "model", id: "claude-fable-5", display_name: "Claude Fable 5", created_at: "2026-06-07T00:00:00Z" },
    { type: "model", id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-05-28T00:00:00Z" },
    { type: "model", id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: "2026-04-14T00:00:00Z" },
    { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-02-17T00:00:00Z" },
    { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-15T00:00:00Z" },
    { type: "model", id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", created_at: "2025-09-29T00:00:00Z" },
  ],
  has_more: false,
};

describe("curateClaudeModels", () => {
  it("ファミリー最新1件を fable→opus→sonnet→haiku 順で返す", () => {
    expect(curateClaudeModels(REAL_SHAPE)).toEqual([
      { id: "claude-fable-5", displayName: "Claude Fable 5" },
      { id: "claude-opus-5", displayName: "Claude Opus 5" },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
    ]);
  });

  it("API のソート順に依存しない（昇順で渡しても created_at 最新を選ぶ）", () => {
    const shuffled = { data: [...REAL_SHAPE.data].reverse() };
    expect(curateClaudeModels(shuffled)).toEqual(curateClaudeModels(REAL_SHAPE));
  });

  it("未知ファミリーのモデルは末尾へ生表示する（無言で消さない）", () => {
    const withUnknown = {
      data: [
        ...REAL_SHAPE.data,
        { id: "claude-nova-1", display_name: "Claude Nova 1", created_at: "2026-08-01T00:00:00Z" },
      ],
    };
    const result = curateClaudeModels(withUnknown);
    expect(result?.at(-1)).toEqual({ id: "claude-nova-1", displayName: "Claude Nova 1" });
    expect(result).toHaveLength(5);
  });

  it("id/display_name 欠落エントリはスキップし、他は生かす", () => {
    const dirty = {
      data: [
        { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" },
        { id: "", display_name: "Broken" },
        { display_name: "No Id" },
        { id: "no-display-name" },
        null,
        42,
      ],
    };
    expect(curateClaudeModels(dirty)).toEqual([{ id: "claude-opus-5", displayName: "Claude Opus 5" }]);
  });

  it("created_at 欠落は最古扱い（同ファミリーの日付ありが勝つ）", () => {
    const noDate = {
      data: [
        { id: "claude-opus-undated", display_name: "Claude Opus Undated" },
        { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: "2026-04-14T00:00:00Z" },
      ],
    };
    expect(curateClaudeModels(noDate)).toEqual([{ id: "claude-opus-4-7", displayName: "Claude Opus 4.7" }]);
  });

  it("形式不明・空は null（呼び出し側で失敗扱い）", () => {
    expect(curateClaudeModels(null)).toBeNull();
    expect(curateClaudeModels("nope")).toBeNull();
    expect(curateClaudeModels({})).toBeNull();
    expect(curateClaudeModels({ data: [] })).toBeNull();
    expect(curateClaudeModels({ data: [{ id: "", display_name: "" }] })).toBeNull();
  });
});

describe("API キーの探索（claude CLI と同じ源泉の純ロジック）", () => {
  it("settings.json の env.ANTHROPIC_API_KEY を取り出す", () => {
    expect(
      extractSettingsEnvApiKey({ env: { ANTHROPIC_API_KEY: "sk-ant-test" } }),
    ).toBe("sk-ant-test");
    expect(extractSettingsEnvApiKey({ env: {} })).toBeUndefined();
    expect(extractSettingsEnvApiKey({})).toBeUndefined();
    expect(extractSettingsEnvApiKey(null)).toBeUndefined();
    expect(extractSettingsEnvApiKey({ env: { ANTHROPIC_API_KEY: 42 } })).toBeUndefined();
  });

  it("settings.json の apiKeyHelper を取り出す（空文字は無効）", () => {
    expect(extractApiKeyHelper({ apiKeyHelper: "/bin/echo sk" })).toBe("/bin/echo sk");
    expect(extractApiKeyHelper({ apiKeyHelper: "  " })).toBeNull();
    expect(extractApiKeyHelper({})).toBeNull();
    expect(extractApiKeyHelper(null)).toBeNull();
  });

  it("normalizeApiKey は空白を整え、空は null にする", () => {
    expect(normalizeApiKey(" sk-ant-x \n")).toBe("sk-ant-x");
    expect(normalizeApiKey("")).toBeNull();
    expect(normalizeApiKey("   ")).toBeNull();
    expect(normalizeApiKey(undefined)).toBeNull();
    expect(normalizeApiKey(null)).toBeNull();
  });
});
