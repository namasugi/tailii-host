import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenAIApiDelegate, imageUsage } from "../src/services/openaiApiDelegate.js";
import type { ClaudeApiDelegateRequest } from "../src/services/claudeApiDelegate.js";
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from "../src/protocol.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const request: ClaudeApiDelegateRequest = { provider: "openai", apiKey: "sk-proj-test-only-not-a-live-secret", model: "gpt-image-2.6-sunburst", prompt: "青い丸のアイコン", context: "", budgetCents: 50,
  imageOptions: { quality: "medium", size: "1024x1024", format: "png", background: "transparent", count: 1, complexity: "medium" } };
const usage = { input_tokens: 120, input_tokens_details: { text_tokens: 100, image_tokens: 20 }, output_tokens: 1000, total_tokens: 1120 };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "openai-delegate-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const imageResponse = () => Response.json({ data: [{ b64_json: png.toString("base64") }], size: "1024x1024", usage });

describe("OpenAI APIの会話と画像生成", () => {
  it("選択した画像モデルと設定を固定して1回だけ生成し、原本を保存する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(imageResponse());
    const result = await runOpenAIApiDelegate(request, signal(), fetcher, directory);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/images/generations");
    const options = fetcher.mock.calls[0]![1]; const body = JSON.parse(options.body);
    expect(body).toMatchObject({ model: request.model, quality: "medium", size: "1024x1024", background: "transparent", output_format: "png", complexity: "medium", n: 1 });
    expect(options.redirect).toBe("error");
    expect(options.headers.authorization).toBe(`Bearer ${request.apiKey}`);
    expect(options.body).not.toContain(request.apiKey);
    expect(result.model).toBe(request.model);
    expect(result.estimatedCostUsd).toBeCloseTo(0.03066, 8);
    expect(await readFile(result.images![0]!.path)).toEqual(png);
  });

  it("添付画像は同じモデルのeditsへ渡し、別モデルへ切り替えない", async () => {
    const uploads = join(homedir(), ".tailii", "uploads"); await mkdir(uploads, { recursive: true });
    const path = join(uploads, "test-image.png"); await writeFile(path, png);
    const fetcher = vi.fn().mockResolvedValueOnce(imageResponse());
    await runOpenAIApiDelegate({ ...request, attachments: [{ path, name: "test-image.png" }] }, signal(), fetcher, directory);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/images/edits");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ model: request.model, images: [{ image_url: `data:image/png;base64,${png.toString("base64")}` }] });
  });

  it.each([
    { apiKey: "sk-ant-api03-not-an-openai-key" }, { apiKey: "sk-admin-test-only-not-a-live-secret" },
    { model: "gpt-image-1" }, { model: "" }, { imageOptions: undefined },
    { imageOptions: { ...request.imageOptions!, format: "jpeg", background: "transparent" } },
    { imageOptions: { ...request.imageOptions!, count: 100 } },
  ])("キー・モデル・設定が不適切なときは生成しない: %j", async (change) => {
    const fetcher = vi.fn();
    await expect(runOpenAIApiDelegate({ ...request, ...change } as ClaudeApiDelegateRequest, signal(), fetcher, directory)).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("無料枠枯渇とrate limitを分け、エラー後にリトライやモデル変更をしない", async () => {
    for (const [status, code, expected] of [[429, "insufficient_quota", "quota_exhausted"], [429, "rate_limit_exceeded", "rate_limited"],
      [400, "moderation_blocked", "blocked"], [404, "model_not_found", "unsupported_model"]] as const) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code, message: request.apiKey } }, { status }));
      await expect(runOpenAIApiDelegate(request, signal(), fetcher, directory)).rejects.toMatchObject({ code: expected, message: expected });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("usage欠損を無料扱いせず、未確認として返す", async () => {
    expect(imageUsage(undefined, request.model)).toMatchObject({ usageUnavailable: true });
    expect(imageUsage({ ...usage, input_tokens: 99 }, request.model)).toMatchObject({ usageUnavailable: true });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ b64_json: png.toString("base64") }], size: "1024x1024" }));
    const result = await runOpenAIApiDelegate(request, signal(), fetcher, directory);
    expect(result.images).toHaveLength(1);
    expect(result.usageUnavailable).toBe(true);
  });

  it("Responses APIの会話では履歴を計数し、指定モデルと概算予算で生成する", async () => {
    const textRequest: ClaudeApiDelegateRequest = { ...request, model: "gpt-6.1-sol", imageOptions: undefined,
      history: [{ prompt: "最初の依頼", context: "", response: "前の回答" }] };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 1000 })).mockResolvedValueOnce(Response.json({
      model: textRequest.model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "続きの回答" }] }],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 100 }, output_tokens: 200 },
    }));
    const result = await runOpenAIApiDelegate(textRequest, signal(), fetcher);
    const countBody = JSON.parse(fetcher.mock.calls[0]![1].body); const generateBody = JSON.parse(fetcher.mock.calls[1]![1].body);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://api.openai.com/v1/responses/input_tokens", "https://api.openai.com/v1/responses"]);
    expect(countBody.input.map((item: { role: string }) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(generateBody.input).toEqual(countBody.input);
    expect(generateBody).toMatchObject({ model: textRequest.model, store: false, service_tier: "default" });
    expect(generateBody).not.toHaveProperty("tools");
    expect(result.text).toBe("続きの回答");
    expect(result.estimatedCostUsd).toBeCloseTo(0.00381, 8);
  });

  it("過去の応答と添付テキストを合計して上限を超えたらHTTP要求を送らない", async () => {
    const uploads = join(homedir(), ".tailii", "uploads"); await mkdir(uploads, { recursive: true });
    const path = join(uploads, "text-budget.txt"); await writeFile(path, "x".repeat(65_000));
    const fetcher = vi.fn();
    await expect(runOpenAIApiDelegate({ ...request, model: "gpt-6.1-sol", imageOptions: undefined,
      attachments: [{ path, name: "text-budget.txt" }], history: [{ prompt: "前の依頼", context: "", response: "y".repeat(60_000) }],
    }, signal(), fetcher)).rejects.toMatchObject({ code: "request_too_large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("生成画像とモデル指定を両端の封筒で往復できる", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(imageResponse());
    const result = await runOpenAIApiDelegate(request, signal(), fetcher, directory);
    const messages: ControlMessage[] = [
      { type: "api_delegate_options_response", v: 1, id: "probe", supported: true, supportsOpenAI: true },
      { type: "api_delegate_request", v: 1, id: "image", request },
      { type: "api_delegate_response", v: 1, id: "image", result },
    ];
    for (const message of messages) expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });
});
