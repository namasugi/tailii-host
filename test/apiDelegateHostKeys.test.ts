import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiDelegateHostKeys, hostApiKey } from "../src/services/apiDelegateHostKeys.js";
import { runClaudeApiDelegate } from "../src/services/claudeApiDelegate.js";
import { runOpenAIApiDelegate } from "../src/services/openaiApiDelegate.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";

const claudeKey = "sk-ant-api03-host-test-only-key";
const openAIKey = "sk-proj-host-test-only-not-a-live-secret";
afterEach(() => { vi.unstubAllEnvs(); });
describe("API実行用のホストの既存キー", () => {
  it.each(["sk-ant-usr-test-only-not-a-real-secret", "sk-ant-usr01-test-only-not-a-real-secret"])("個人用APIキーもホストの既存キーとして検出する: %s", (key) => {
    expect(hostApiKey("claude", { ANTHROPIC_API_KEY: key })).toBe(key);
    expect(apiDelegateHostKeys({ ANTHROPIC_API_KEY: key })).toMatchObject({ claude: true });
  });

  it("利用可能かどうかだけを返し、管理キー・Subscription認証を使わない", () => {
    expect(apiDelegateHostKeys({ ANTHROPIC_API_KEY: claudeKey, OPENAI_API_KEY: openAIKey })).toEqual({ claude: true, openai: true });
    expect(apiDelegateHostKeys({ ANTHROPIC_API_KEY: "sk-ant-admin01-test-key", OPENAI_API_KEY: "sk-admin-test-only-key-value" })).toEqual({ claude: false, openai: false });
    const value = encodeControlMessage({ type: "api_delegate_options_response", v: 1, id: "probe", supported: true, hostApiKeys: apiDelegateHostKeys({ ANTHROPIC_API_KEY: claudeKey }) });
    expect(value).not.toContain(claudeKey);
    expect(decodeControlMessage(value)).toMatchObject({ hostApiKeys: { claude: true, openai: false } });
  });

  it("Claudeの設定ファイルとAPIキーモードのCodex登録を読み、ChatGPTログインは採用しない", async () => {
    const directory = join(homedir(), ".claude"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: claudeKey } }));
    expect(hostApiKey("claude", {})).toBe(claudeKey);
    const codex = join(homedir(), ".codex"); await mkdir(codex, { recursive: true });
    await writeFile(join(codex, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: openAIKey }));
    expect(hostApiKey("openai", {})).toBe(openAIKey);
    await writeFile(join(codex, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: openAIKey, tokens: { access_token: "test-only-login-token" } }));
    expect(hostApiKey("openai", {})).toBeUndefined();
  });

  it("明示したホストキー経路でだけ既存キーを使い、iPhoneからの要求を書き換えない", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", claudeKey);
    const request = { apiKey: "", useHostApiKey: true, model: "claude-sonnet-5-5", prompt: "依頼", context: "", budgetCents: 50 };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 50 })).mockResolvedValueOnce(Response.json({ model: request.model,
      content: [{ type: "text", text: "回答" }], usage: { input_tokens: 50, output_tokens: 10 }, stop_reason: "end_turn" }));
    await runClaudeApiDelegate(request, new AbortController().signal, fetcher);
    expect(request.apiKey).toBe("");
    expect(fetcher.mock.calls[0]![1].headers["x-api-key"]).toBe(claudeKey);
    const missing = vi.fn();
    await expect(runClaudeApiDelegate({ ...request, useHostApiKey: undefined }, new AbortController().signal, missing)).rejects.toMatchObject({ code: "invalid_key" });
    expect(missing).not.toHaveBeenCalled();
  });

  it("OpenAIのホストキーでも同じ経路を使う", async () => {
    vi.stubEnv("OPENAI_API_KEY", openAIKey);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 20 })).mockResolvedValueOnce(Response.json({ model: "gpt-6.1-sol", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "回答" }] }], usage: { input_tokens: 20, output_tokens: 10 } }));
    await runOpenAIApiDelegate({ provider: "openai", apiKey: "", useHostApiKey: true, model: "gpt-6.1-sol", prompt: "依頼", context: "", budgetCents: 50 }, new AbortController().signal, fetcher);
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe("Bearer " + openAIKey);
  });

  it("キーとIDフェデレーションの両方が指定された曖昧な要求は送信しない", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", claudeKey);
    const fetcher = vi.fn();
    const request = { apiKey: "", useHostApiKey: true, model: "claude-sonnet-5-5", prompt: "依頼", context: "", budgetCents: 50 };
    await expect(runClaudeApiDelegate({ ...request, federation: { profile: "test", configurationHash: "a".repeat(64) } }, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "host_key_unavailable" });
    await expect(runClaudeApiDelegate({ ...request, apiKey: claudeKey }, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "host_key_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
