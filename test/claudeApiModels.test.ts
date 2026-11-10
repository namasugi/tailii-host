import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClaudeApiModels, CLAUDE_API_MODELS_TIMEOUT_MS } from "../src/services/claudeApiModels.js";
import { claudeApiModelPrice, runClaudeApiDelegate } from "../src/services/claudeApiDelegate.js";
import { createApiDelegateHandlers } from "../src/engine/handlers/apiDelegate.js";
import { claudeApiFederation, FederationError } from "../src/services/claudeApiFederation.js";
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from "../src/protocol.js";
import type { HandlerContext } from "../src/engine/context.js";

const key = "sk-ant-api03-test-only-model-list-key";
const selection = { useHostApiKey: true, keySource: { mode: "environment", environmentVariable: "MODEL_API_KEY", workspaceId: "wrkspc_test" } } as const;
const profile = { profile: "test", configurationHash: "a".repeat(64) };
const model = (id: string, name = id) => ({ id, display_name: name });
const page = (data: unknown[], more = false, cursor?: string) => Response.json({ data, has_more: more, ...(cursor ? { last_id: cursor } : {}) });
const dependencies = () => ({ executionEnvironment: vi.fn().mockResolvedValue({ MODEL_API_KEY: key }), keyProvider: vi.fn().mockReturnValue(key), fetcher: vi.fn<typeof fetch>() });
afterEach(() => { vi.restoreAllMocks(); });

describe("API会話のClaudeモデル一覧", () => {
  it("選んだAPI認証・workspaceで全ページをGETし、未知単価もIDを変えずに返す", async () => {
    const deps = dependencies();
    deps.fetcher.mockResolvedValueOnce(page([model("claude-fable-5-2", "Claude Fable 5.2"), model("claude-new-6", "Claude New 6")], true, "claude-new-6"))
      .mockResolvedValueOnce(page([model("claude-sonnet-5-5-20260928"), model("claude-fable-5-2", "duplicate")]));
    const result = await fetchClaudeApiModels(selection, new AbortController().signal, deps);
    expect(result).toEqual({ models: [
      { id: "claude-fable-5-2", name: "Claude Fable 5.2", priceKnown: true },
      { id: "claude-new-6", name: "Claude New 6", priceKnown: false },
      { id: "claude-sonnet-5-5-20260928", name: "claude-sonnet-5-5-20260928", priceKnown: true },
    ] });
    expect(deps.executionEnvironment).toHaveBeenCalledWith("claude", selection.keySource);
    expect(deps.keyProvider).toHaveBeenCalledWith("claude", { MODEL_API_KEY: key }, selection.keySource);
    expect(deps.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.anthropic.com/v1/models?limit=100", "https://api.anthropic.com/v1/models?limit=100&after_id=claude-new-6",
    ]);
    for (const [, options] of deps.fetcher.mock.calls) {
      expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { "x-api-key": key, "anthropic-workspace-id": "wrkspc_test", "anthropic-version": "2023-06-01" } });
      expect(options).not.toHaveProperty("body");
      expect(options!.headers).not.toHaveProperty("anthropic-beta");
    }
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("federationを選んだらそのトークンだけを使いAPIキーを探さない", async () => {
    const deps = { ...dependencies(), federation: { token: vi.fn().mockResolvedValue({ token: "test-federation-token" }) } };
    deps.fetcher.mockResolvedValueOnce(page([model("claude-opus-5-5")]));
    expect((await fetchClaudeApiModels({ federation: profile }, new AbortController().signal, deps)).error).toBeUndefined();
    expect(deps.federation.token).toHaveBeenCalledWith(profile, expect.any(AbortSignal));
    expect(deps.executionEnvironment).not.toHaveBeenCalled(); expect(deps.keyProvider).not.toHaveBeenCalled();
    expect(deps.fetcher.mock.calls[0]![1]!.headers).toEqual({ "anthropic-version": "2023-06-01", authorization: "Bearer test-federation-token" });
  });

  it("指定キーが無ければOAuthや別のキーへ切り替えず、HTTPも送らない", async () => {
    const deps = dependencies(); deps.keyProvider.mockReturnValueOnce(undefined);
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "host_key_unavailable" });
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, "auth_failed"], [403, "auth_failed"], [429, "rate_limited"], [500, "unavailable"]] as const)("HTTP %iで本文を返さず再試行しない", async (status, error) => {
    const deps = dependencies(); deps.fetcher.mockResolvedValueOnce(new Response(key, { status }));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error });
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("federationエラーも固定コードだけを返す", async () => {
    const deps = { ...dependencies(), federation: { token: vi.fn().mockRejectedValue(new FederationError("federation_profile_changed")) } };
    expect(await fetchClaudeApiModels({ federation: profile }, new AbortController().signal, deps)).toEqual({ models: [], error: "federation_profile_changed" });
    deps.federation.token.mockResolvedValueOnce({ token: "test-federation-token" });
    deps.fetcher.mockResolvedValueOnce(new Response(key, { status: 403 }));
    expect(await fetchClaudeApiModels({ federation: profile }, new AbortController().signal, deps)).toEqual({ models: [], error: "federation_auth_failed" });
  });

  it.each([
    {}, { useHostApiKey: false }, { ...selection, federation: profile },
    { federation: { ...profile, configurationHash: "changed" } },
    { useHostApiKey: true, keySource: { mode: "automatic", workspaceId: "workspace\ninvalid" } },
  ] as const)("曖昧・不正な認証指定をHTTPより先に拒否する: %j", async (value) => {
    const deps = dependencies();
    expect(await fetchClaudeApiModels(value, new AbortController().signal, deps)).toEqual({ models: [], error: "invalid_request" });
    expect(deps.executionEnvironment).not.toHaveBeenCalled(); expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("空の成功と取得失敗を区別する", async () => {
    const deps = dependencies(); deps.fetcher.mockResolvedValueOnce(page([]));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [] });
  });

  it("ページングの循環と10ページ超過を途中一覧ではなく失敗にする", async () => {
    const deps = dependencies();
    deps.fetcher.mockImplementation(async () => page([model("claude-fable-5-2")], true, "claude-fable-5-2"));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "invalid_response" });
    expect(deps.fetcher).toHaveBeenCalledTimes(2);
    deps.fetcher.mockReset();
    for (let i = 0; i < 10; i++) deps.fetcher.mockResolvedValueOnce(page([model(`claude-new-${i}`)], true, `claude-new-${i}`));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "invalid_response" });
    expect(deps.fetcher).toHaveBeenCalledTimes(10);
  });

  it("壊れたJSON・必須項目・2MiB超・1000件超を拒否する", async () => {
    for (const response of [
      new Response("not json"), Response.json({ data: [], has_more: "false" }),
      page([model("claude-new-6", "\ncontrol")]), page([model("claude-new-6 with space")]),
      new Response(new Uint8Array(2 * 1024 * 1024 + 1)), page(Array.from({ length: 1001 }, (_, i) => model(`claude-new-${i}`))),
    ]) {
      const deps = dependencies(); deps.fetcher.mockResolvedValueOnce(response);
      expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "invalid_response" });
    }
  });

  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("IDと次ページcursorの末尾改行を拒否する: %j", async (suffix) => {
    const deps = dependencies();
    deps.fetcher.mockResolvedValueOnce(page([model("claude-fable-5-2" + suffix)]));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "invalid_response" });
    deps.fetcher.mockClear();
    deps.fetcher.mockResolvedValueOnce(page([model("claude-fable-5-2")], true, "claude-fable-5-2" + suffix));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "invalid_response" });
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("認証解決も含め12秒で返し、解決が後から終わってもHTTPを始めない", async () => {
    const timeout = new AbortController();
    const timeoutFactory = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    const deps = dependencies();
    let resolveEnvironment!: (value: NodeJS.ProcessEnv) => void;
    deps.executionEnvironment.mockImplementationOnce(() => new Promise<NodeJS.ProcessEnv>((resolve) => { resolveEnvironment = resolve; }));
    const pending = fetchClaudeApiModels(selection, new AbortController().signal, deps);
    timeout.abort();
    expect(await pending).toEqual({ models: [], error: "timeout" });
    expect(timeoutFactory).toHaveBeenCalledWith(CLAUDE_API_MODELS_TIMEOUT_MS);
    resolveEnvironment({ MODEL_API_KEY: key }); await Promise.resolve(); await Promise.resolve();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("任意の例外やキャンセルから秘密の例外本文を返さない", async () => {
    const deps = dependencies(); deps.fetcher.mockRejectedValueOnce(new Error(key));
    expect(await fetchClaudeApiModels(selection, new AbortController().signal, deps)).toEqual({ models: [], error: "unavailable" });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await fetchClaudeApiModels(selection, cancelled.signal, deps)).toEqual({ models: [], error: "cancelled" });
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("optionsは要求時だけ動的取得し、認証選択と結果をそのままwireへ運ぶ", async () => {
    vi.spyOn(claudeApiFederation, "list").mockResolvedValue({ profiles: [] });
    const list = vi.fn<typeof fetchClaudeApiModels>().mockResolvedValue({ models: [{ id: "claude-new-6", name: "Claude New 6", priceKnown: false }] });
    const handlers = createApiDelegateHandlers(vi.fn(), list), replies: ControlMessage[] = [];
    const ctx = { state: { negotiatedVersion: 1 }, writer: { write: (reply: ControlMessage) => replies.push(reply) } } as unknown as HandlerContext;
    await handlers.api_delegate_options_request!({ type: "api_delegate_options_request", v: 1, id: "old" }, ctx);
    expect(list).not.toHaveBeenCalled();
    expect(replies[0]).not.toHaveProperty("claudeModels", expect.anything());
    await handlers.api_delegate_options_request!({ type: "api_delegate_options_request", v: 1, id: "new", claudeModels: selection }, ctx);
    expect(list).toHaveBeenCalledWith(selection);
    expect(replies[1]).toMatchObject({ claudeModels: { models: [{ id: "claude-new-6", name: "Claude New 6", priceKnown: false }] } });
  });

  it("旧options・APIキー選択・federation・空成功・失敗がwireで往復する", () => {
    const values: ControlMessage[] = [
      { type: "api_delegate_options_request", v: 1, id: "old" },
      { type: "api_delegate_options_request", v: 1, id: "key", claudeModels: selection },
      { type: "api_delegate_options_request", v: 1, id: "federation", claudeModels: { federation: profile } },
      { type: "api_delegate_options_response", v: 1, id: "empty", supported: true, claudeModels: { models: [] } },
      { type: "api_delegate_options_response", v: 1, id: "error", supported: true, claudeModels: { models: [], error: "auth_failed" } },
      { type: "api_delegate_options_response", v: 1, id: "new", supported: true, claudeModels: { models: [{ id: "claude-new-6", name: "Claude New 6", priceKnown: false }] } },
    ];
    for (const value of values) expect(decodeControlMessage(encodeControlMessage(value))).toEqual(value);
  });
});

describe("動的IDの実行料金", () => {
  it("既知canonicalと8桁日付だけを同じ料金にし、未知モデルを実行可能にしない", () => {
    expect(claudeApiModelPrice("claude-fable-5-2")).toEqual({ input: 8, output: 40, cacheRead: 0.2 });
    expect(claudeApiModelPrice("claude-fable-5-2-20261109")).toEqual(claudeApiModelPrice("claude-fable-5-2"));
    for (const id of ["claude-fable-5-20", "claude-fable-5-2-20261109-fast", "claude-fable-5-2-123", "claude-new-6",
      "claude-fable-5-2-20261109\n", "claude-fable-5-2-20261109\r"]) expect(claudeApiModelPrice(id)).toBeUndefined();
  });

  it("Fableのdated IDを計数・生成にそのまま渡しcache readを$0.20/MTokで数える", async () => {
    const id = "claude-fable-5-2-20261109";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ input_tokens: 6000 }))
      .mockResolvedValueOnce(Response.json({ model: id, content: [{ type: "thinking", thinking: "test" }, { type: "text", text: "回答" }],
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 }, stop_reason: "end_turn" }));
    const result = await runClaudeApiDelegate({ apiKey: key, model: id, prompt: "調べて", context: "資料", budgetCents: 50 }, new AbortController().signal, fetcher);
    expect(result).toMatchObject({ text: "回答", model: id, inputTokens: 6000, outputTokens: 100 });
    expect(result.estimatedCostUsd).toBeCloseTo(0.0424, 10);
    for (const [, options] of fetcher.mock.calls) expect(JSON.parse(String(options!.body)).model).toBe(id);
    const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(body).not.toHaveProperty("thinking"); expect(body).not.toHaveProperty("temperature");
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
  });

  it.each(["claude-new-6", "claude-fable-5-2\n", "claude-fable-5-2\r", "claude-fable-5-2-20261109\n", "claude-fable-5-2-20261109\r"])("未知または末尾改行付きモデルは有料生成に到達させない: %j", async (model) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(runClaudeApiDelegate({ apiKey: key, model, prompt: "調べて", context: "資料", budgetCents: 50 }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: "unsupported_model" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
