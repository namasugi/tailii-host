import { afterEach, describe, expect, it, vi } from "vitest";
import { apiExecutionEnvironment, apiExecutionKeysEnvironment, apiDelegateHostKeys, resolvedHostApiRequest } from "../src/services/apiDelegateHostKeys.js";
import { hostApiKeyEnvironment } from "../src/services/hostApiKeyEnvironment.js";
import { createOpenAIApiUsageProvider } from "../src/services/openaiApiUsage.js";
import { createClaudeApiUsageProvider } from "../src/services/claudeApiUsage.js";

vi.mock("../src/services/hostApiKeyEnvironment.js", () => ({ hostApiKeyEnvironment: vi.fn() }));
const openai = "sk-proj-shell-test-only-not-a-live-secret";
const claude = "sk-ant-api03-shell-test-only-not-a-live-secret";
afterEach(() => { vi.resetAllMocks(); });

describe("API認証の照会と実行で同じホスト環境を使う", () => {
  it("自動検出で補完したキーを実行にも使い、元の要求とprocess.envは変更しない", async () => {
    vi.mocked(hostApiKeyEnvironment).mockResolvedValue({ OPENAI_API_KEY: openai, ANTHROPIC_API_KEY: claude });
    const availability = apiDelegateHostKeys(await apiExecutionKeysEnvironment());
    expect(availability).toEqual({ claude: true, openai: true });
    const request = { apiKey: "", useHostApiKey: true, model: "gpt-6.1-sol", prompt: "test", context: "", budgetCents: 50 };
    expect(await resolvedHostApiRequest(request, "openai")).toMatchObject({ apiKey: openai, useHostApiKey: false });
    expect(hostApiKeyEnvironment).toHaveBeenLastCalledWith(["OPENAI_API_KEY"]);
    expect(request.apiKey).toBe(""); expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("環境変数を明示した場合はその名前だけを照会し、不足時に自動キーへ戻らない", async () => {
    vi.mocked(hostApiKeyEnvironment).mockResolvedValue({ OPENAI_API_KEY: openai });
    const source = { mode: "environment", environmentVariable: "TEAM_API_KEY" } as const;
    const request = { apiKey: "", useHostApiKey: true, keySource: source, model: "gpt-6.1-sol", prompt: "test", context: "", budgetCents: 50 };
    expect(await resolvedHostApiRequest(request, "openai")).toBeUndefined();
    expect(hostApiKeyEnvironment).toHaveBeenLastCalledWith(["TEAM_API_KEY"]);
    await apiExecutionEnvironment("openai", { mode: "disabled" });
    expect(hostApiKeyEnvironment).toHaveBeenLastCalledWith([]);
    await apiExecutionEnvironment("openai", { mode: "file", path: "/missing/test-key" });
    expect(hostApiKeyEnvironment).toHaveBeenLastCalledWith([]);
  });

  it("管理キー照会も補完するが通常キーでCosts APIを呼ばず、停止設定は補完しない", async () => {
    vi.mocked(hostApiKeyEnvironment).mockResolvedValue({ OPENAI_API_KEY: openai, ANTHROPIC_API_KEY: claude });
    const fetcher = vi.fn();
    expect(await createOpenAIApiUsageProvider({ fetch: fetcher })()).toEqual({ error: "admin_key_required" });
    expect(await createClaudeApiUsageProvider({ fetch: fetcher })()).toEqual({ error: "admin_key_required" });
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(hostApiKeyEnvironment).mockClear();
    expect(await createOpenAIApiUsageProvider({ fetch: fetcher })({ mode: "disabled" })).toBeNull();
    expect(hostApiKeyEnvironment).not.toHaveBeenCalled();
    const explicit = createOpenAIApiUsageProvider({ env: {}, fetch: fetcher });
    expect(await explicit()).toBeNull();
    expect(hostApiKeyEnvironment).not.toHaveBeenCalled();
  });
});
