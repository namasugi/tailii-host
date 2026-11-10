import { describe, expect, it, vi } from "vitest";
import { runClaudeApiDelegate, delegateOutputLimit, DelegateError } from "../src/services/claudeApiDelegate.js";
import { createApiDelegateHandlers } from "../src/engine/handlers/apiDelegate.js";
import type { HandlerContext } from "../src/engine/context.js";
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from "../src/protocol.js";

const request = { apiKey: "sk-ant-api03-test-only-secret", model: "claude-sonnet-5-5", prompt: "差分の問題を調べて", context: "diff --git a/a.ts b/a.ts", budgetCents: 50 };
const result = { text: "入力検証を追加してください。", model: request.model, inputTokens: 1000, outputTokens: 100, estimatedCostUsd: 0.003, stopReason: "end_turn" };
const answer = () => Response.json({ content: [{ type: "text", text: result.text }], model: request.model,
  usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: "end_turn" });
const abort = () => new AbortController();

describe("Claude API への単発委譲", () => {
  it.each(["sk-ant-usr-test-only-not-a-real-secret", "sk-ant-usr01-test-only-not-a-real-secret"])("個人用APIキーでも固定の推論APIへ送信できる: %s", async (apiKey) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 1000 })).mockResolvedValueOnce(answer());
    expect(await runClaudeApiDelegate({ ...request, apiKey }, abort().signal, fetcher)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1].headers["x-api-key"]).toBe(apiKey);
    expect(fetcher.mock.calls[1]![1].body).not.toContain(apiKey);
  });

  it("組織の個人用キーに指定したワークスペースを計数と生成の両方へ渡す", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 1000 })).mockResolvedValueOnce(answer());
    await runClaudeApiDelegate({ ...request, apiKey: "sk-ant-usr-test-only-not-a-real-secret", keySource: { mode: "automatic", workspaceId: "wrkspc_test" } }, abort().signal, fetcher);
    for (const call of fetcher.mock.calls) expect(call[1].headers["anthropic-workspace-id"]).toBe("wrkspc_test");
  });

  it("固定の公式 API だけへキーを送って事前計数し、指定モデルの料金を返す", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 1000 })).mockResolvedValueOnce(answer());
    expect(await runClaudeApiDelegate(request, abort().signal, fetcher)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [countURL, countOptions] = fetcher.mock.calls[0]!;
    const [url, options] = fetcher.mock.calls[1]!;
    expect(countURL).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.redirect).toBe("error");
    expect(options.headers["x-api-key"]).toBe(request.apiKey);
    const body = JSON.parse(options.body);
    expect(body.model).toBe(request.model);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("thinking");
    expect(JSON.parse(countOptions.body).messages).toEqual(body.messages);
    expect(options.body).not.toContain(request.apiKey);
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
  });

  it.each([
    { apiKey: "sk-ant-admin01-test-only" }, { apiKey: "sk-ant-api03-line\nbreak" },
    { apiKey: "sk-ant-oat01-test-only-secret" }, { apiKey: "sk-ant-ort01-test-only-secret" },
    { apiKey: "sk-ant-usr-line\nbreak" }, { apiKey: "sk-ant-usr-too short" }, { apiKey: "sk-ant-usr-short" },
    { apiKey: "sk-ant-usr-test-only-secret\n" },
    { model: "unknown" }, { budgetCents: 0 }, { budgetCents: 501 }, { budgetCents: 10.5 }, { prompt: "  " },
    { context: "a".repeat(120_001) },
  ])("不正な設定では HTTP を送らない: %j", async (change) => {
    const fetcher = vi.fn();
    await expect(runClaudeApiDelegate({ ...request, ...change }, abort().signal, fetcher)).rejects.toBeInstanceOf(DelegateError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("予算不足なら有料の生成を送らない", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 90_000 }));
    await expect(runClaudeApiDelegate({ ...request, budgetCents: 1 }, abort().signal, fetcher)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(() => delegateOutputLimit("claude-haiku-5-5", 100_001, 50)).toThrow("request_too_large");
    expect(delegateOutputLimit("claude-opus-5-5", 5000, 10)).toBeLessThan(4000);
  });

  it("エラー本文を返さず、認証・上限エラーをリトライしない", async () => {
    for (const [status, code] of [[401, "auth_failed"], [402, "quota_exhausted"], [429, "rate_limited"], [500, "unavailable"]] as const) {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(request.apiKey, { status }));
      await expect(runClaudeApiDelegate(request, abort().signal, fetcher)).rejects.toMatchObject({ message: code, code });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("生成の応答を失っても再送せず、中止と通常の通信失敗を区別する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 1000 })).mockRejectedValueOnce(new Error(request.apiKey));
    await expect(runClaudeApiDelegate(request, abort().signal, fetcher)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = abort(); controller.abort();
    await expect(runClaudeApiDelegate(request, controller.signal, async () => { throw new Error("aborted"); })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("会計値・モデル・本文が壊れた応答を実績としない", async () => {
    for (const value of [
      { model: "different", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1, output_tokens: 1 } },
      { model: request.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      { model: request.model, content: [{ type: "text", text: "answer" }], usage: { input_tokens: -1, output_tokens: 1 } },
    ]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 10 })).mockResolvedValueOnce(Response.json(value));
      await expect(runClaudeApiDelegate(request, abort().signal, fetcher)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("同じ要求 id の重複は課金を増やさず、別 id の同時実行を拒否する", async () => {
    let resolve!: (value: typeof result) => void;
    const runner = vi.fn(() => new Promise<typeof result>((done) => { resolve = done; }));
    const handlers = createApiDelegateHandlers(runner);
    const replies: ControlMessage[] = [];
    const ctx = { state: { negotiatedVersion: 1 }, writer: { write: (message: ControlMessage) => replies.push(message) } } as unknown as HandlerContext;
    const message = { type: "api_delegate_request", v: 1, id: "job", request } as const;
    const first = handlers.api_delegate_request!(message, ctx);
    await handlers.api_delegate_request!(message, ctx);
    await handlers.api_delegate_request!({ ...message, id: "other" }, ctx);
    expect(replies[0]).toMatchObject({ error: "busy" });
    expect(runner).toHaveBeenCalledOnce();
    await handlers.api_delegate_cancel!({ type: "api_delegate_cancel", v: 1, id: "job" }, ctx);
    expect(runner.mock.calls[0]![1].aborted).toBe(true);
    resolve(result); await first;
    await handlers.api_delegate_request!(message, ctx);
    expect(replies[1]).toEqual(replies[2]);
    expect(runner).toHaveBeenCalledOnce();
    expect(JSON.stringify(replies)).not.toContain(request.apiKey);
  });

  it("両端の新しい封筒をラウンドトリップする", () => {
    const values: ControlMessage[] = [
      { type: "api_delegate_options_request", v: 1, id: "probe" },
      { type: "api_delegate_options_response", v: 1, id: "probe", supported: true },
      { type: "api_delegate_request", v: 1, id: "job", request },
      { type: "api_delegate_response", v: 1, id: "job", result },
      { type: "api_delegate_response", v: 1, id: "job", error: "cancelled" },
      { type: "api_delegate_cancel", v: 1, id: "job" },
    ];
    for (const message of values) expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });

  it("要求より先にキャンセルが届いても、後から生成を始めない", async () => {
    const runner = vi.fn(async () => result);
    const handlers = createApiDelegateHandlers(runner);
    const replies: ControlMessage[] = [];
    const ctx = { state: { negotiatedVersion: 1 }, writer: { write: (message: ControlMessage) => replies.push(message) } } as unknown as HandlerContext;
    await handlers.api_delegate_cancel!({ type: "api_delegate_cancel", v: 1, id: "job" }, ctx);
    await handlers.api_delegate_request!({ type: "api_delegate_request", v: 1, id: "job", request }, ctx);
    expect(runner).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ error: "cancelled" });
  });

  it("回答キャッシュの保持数を超えても、古い要求を再課金しない", async () => {
    const runner = vi.fn(async () => result);
    const handlers = createApiDelegateHandlers(runner);
    const replies: ControlMessage[] = [];
    const ctx = { state: { negotiatedVersion: 1 }, writer: { write: (message: ControlMessage) => replies.push(message) } } as unknown as HandlerContext;
    for (let i = 0; i < 18; i++) {
      await handlers.api_delegate_request!({ type: "api_delegate_request", v: 1, id: `job-${i}`, request }, ctx);
    }
    await handlers.api_delegate_request!({ type: "api_delegate_request", v: 1, id: "job-0", request }, ctx);
    expect(runner).toHaveBeenCalledTimes(18);
    expect(replies.at(-1)).toMatchObject({ id: "job-0", error: "outcome_unknown" });
  });
});
