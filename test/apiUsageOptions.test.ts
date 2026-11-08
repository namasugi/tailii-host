import { describe, it, expect, vi } from "vitest";
import { decodeControlMessage } from "../src/protocol.js";
import type { ControlMessage } from "../src/protocol.js";
import type { HandlerContext } from "../src/engine/context.js";
import { createAccountUsageHandlers } from "../src/engine/handlers/accountUsage.js";

describe("API 利用額の設定と互換性", () => {
  it("対応確認はキーも外部 API 照会も不要", async () => {
    const api = vi.fn();
    const handlers = createAccountUsageHandlers({ openaiApiUsage: api, claudeApiUsage: api });
    const write = vi.fn();
    const handler = handlers.api_usage_options_request!;
    await handler({ type: "api_usage_options_request", v: 1, id: "probe" }, { writer: { write }, state: { negotiatedVersion: 1 } } as unknown as HandlerContext);
    expect(write).toHaveBeenCalledWith({ type: "api_usage_options_response", v: 1, id: "probe", supported: true });
    expect(api).not.toHaveBeenCalled();
  });

  it("指定した設定を各取得元へ渡し、Claude API の金額だけでも応答できる", async () => {
    const openai = vi.fn(async () => null);
    const value = { month: "2026-11", cost: "12.345", currency: "USD", fetchedAt: "2026-11-09T00:00:00Z" };
    const claude = vi.fn(async () => ({ value }));
    const handlers = createAccountUsageHandlers({ openaiApiUsage: openai, claudeApiUsage: claude });
    const written: ControlMessage[] = [];
    const credentials = { openai: { mode: "disabled" as const }, claude: { mode: "custom" as const, apiKey: "test-only-key" } };
    await handlers.account_usage_request!({ type: "account_usage_request", v: 1, id: "usage", apiCredentials: credentials }, {
      writer: { write: (value: ControlMessage) => written.push(value) }, state: { negotiatedVersion: 1 },
      planUsage: async () => null, codexAccountUsage: async () => null, hostVersions: async () => null, accountIdentity: async () => ({}),
    } as unknown as HandlerContext);
    expect(openai).toHaveBeenCalledWith(credentials.openai);
    expect(claude).toHaveBeenCalledWith(credentials.claude);
    expect(written[0]).toMatchObject({ claudeApi: value });
    expect(JSON.stringify(written)).not.toContain("test-only-key");
  });

  it("自動・停止にはキーを渡さず、不正な設定のエラーにもキーを含めない", () => {
    const message = decodeControlMessage(JSON.stringify({ type: "account_usage_request", v: 1, id: "a",
      apiCredentials: { openai: { mode: "disabled", apiKey: "secret" } } }));
    expect(message).toMatchObject({ apiCredentials: { openai: { mode: "disabled" } } });
    expect(JSON.stringify(message)).not.toContain("secret");
    for (const line of ['{"secret":"private-key",', '{"apiKey":"private-key"}',
      JSON.stringify({ type: "account_usage_request", v: 1, id: "a", apiCredentials: { openai: { mode: "custom", apiKey: "private-key\n" } } })]) {
      try { decodeControlMessage(line); throw new Error("must reject"); }
      catch (error) { expect(String(error)).not.toContain("private-key"); }
    }
  });
});
