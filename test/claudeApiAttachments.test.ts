import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadDelegateAttachments } from "../src/services/claudeApiAttachments.js";
import { runClaudeApiDelegate, type ClaudeApiDelegateRequest } from "../src/services/claudeApiDelegate.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";

const base: ClaudeApiDelegateRequest = { apiKey: "sk-ant-api03-test-only-secret", model: "claude-sonnet-5-5", prompt: "資料について説明して", context: "", budgetCents: 50 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
let root: string;
let outside: string;
const paths: string[] = [];
beforeEach(async () => {
  root = join(homedir(), ".tailii", "uploads");
  outside = await mkdtemp(join(tmpdir(), "delegate-attachment-"));
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
  await rm(outside, { recursive: true, force: true });
});
async function attachment(name: string, data: Uint8Array | string) {
  const path = join(root, randomUUID() + "-" + name);
  paths.push(path);
  await writeFile(path, data);
  return { path, name };
}
const signal = () => new AbortController().signal;

describe("API依頼の入力欄添付", () => {
  it("画像・PDF・コードを、それぞれ読める content block に変換する", async () => {
    const image = await attachment("screen.png", png);
    const pdf = await attachment("design.pdf", "%PDF-1.7\nfixture");
    const text = await attachment("main.swift", "let title = \"Tailii\"\n");
    const content = await loadDelegateAttachments({ ...base, attachments: [image, pdf, text] }, signal());
    expect(content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
    expect(content).toContainEqual({ type: "document", title: "design.pdf", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.7\nfixture").toString("base64") } });
    expect(JSON.stringify(content)).toContain("let title =");
    expect(JSON.stringify(content)).not.toContain(root);
  });

  it("計数と生成へ同じ画像を送り、途中でファイルが変わっても読み直さない", async () => {
    const image = await attachment("screen.png", png);
    const fetcher = vi.fn().mockImplementationOnce(async () => {
      await writeFile(image.path, "changed after counting");
      return Response.json({ input_tokens: 1500 });
    }).mockResolvedValueOnce(Response.json({ model: base.model, content: [{ type: "text", text: "画像の説明" }],
      usage: { input_tokens: 1500, output_tokens: 100 }, stop_reason: "end_turn" }));
    await runClaudeApiDelegate({ ...base, attachments: [image] }, signal(), fetcher);
    const counted = JSON.parse(fetcher.mock.calls[0]![1].body).messages;
    const generated = JSON.parse(fetcher.mock.calls[1]![1].body).messages;
    expect(counted).toEqual(generated);
    expect(generated[0].content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
  });

  it("アップロード先以外・外への symlink・消えた添付ではAPIを送らない", async () => {
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "do not send");
    const link = join(root, randomUUID() + "-link.txt"); paths.push(link);
    await symlink(secret, link);
    for (const path of [secret, link, join(root, "missing.png"), "relative.png"]) {
      const fetcher = vi.fn();
      await expect(runClaudeApiDelegate({ ...base, attachments: [{ path, name: "file" }] }, signal(), fetcher))
        .rejects.toMatchObject({ code: "attachment_unavailable" });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("バイナリ・文字化け・画像やテキストのサイズ超過を黙って省略しない", async () => {
    const binary = await attachment("video.mov", Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    const invalidUTF8 = await attachment("invalid.txt", Buffer.from([0xff, 0xfe]));
    const hugeText = await attachment("huge.txt", "a".repeat(120_001));
    const hugeImage = await attachment("large.png", png);
    await truncate(hugeImage.path, 5_000_001);
    const hugePDF = await attachment("large.pdf", "%PDF-1.7");
    await truncate(hugePDF.path, 20_000_001);
    for (const [file, code] of [[binary, "unsupported_attachment"], [invalidUTF8, "unsupported_attachment"],
      [hugeText, "request_too_large"], [hugeImage, "attachments_too_large"], [hugePDF, "attachments_too_large"]] as const) {
      const fetcher = vi.fn();
      await expect(runClaudeApiDelegate({ ...base, attachments: [file] }, signal(), fetcher)).rejects.toMatchObject({ code });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("添付枚数を検査し、添付メタデータがプロトコルで往復する", async () => {
    const file = await attachment("screen.png", png);
    const request = { ...base, attachments: [file] };
    const message = { type: "api_delegate_request", v: 1, id: "with-image", request } as const;
    expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
    const fetcher = vi.fn();
    await expect(runClaudeApiDelegate({ ...request, attachments: Array(6).fill(file) }, signal(), fetcher))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("前の画像と回答を引き継ぎ、履歴込みの同じmessagesを計数と生成へ渡す", async () => {
    const image = await attachment("screen.png", png);
    const request = { ...base, prompt: "もっと短く説明して", history: [{ prompt: "画像を説明して", context: "", attachments: [image], response: "赤い丸の画像です。" }] };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 2000 })).mockResolvedValueOnce(Response.json({
      model: base.model, content: [{ type: "text", text: "赤い丸です。" }], usage: { input_tokens: 2000, output_tokens: 10 }, stop_reason: "end_turn" }));
    await runClaudeApiDelegate(request, signal(), fetcher);
    const counted = JSON.parse(fetcher.mock.calls[0]![1].body).messages;
    expect(counted.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(counted[0].content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
    expect(counted[1].content).toEqual([{ type: "text", text: "赤い丸の画像です。" }]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).messages).toEqual(counted);
    const message = { type: "api_delegate_request", v: 1, id: "history", request } as const;
    expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });

  it("履歴のテキストや添付も合計サイズに含め、超過時はHTTPを送らない", async () => {
    const image = await attachment("large.pdf", "%PDF-1.7");
    await truncate(image.path, 11_000_000);
    const fetcher = vi.fn();
    await expect(runClaudeApiDelegate({ ...base, attachments: [image], history: [{ prompt: "前の依頼", context: "", response: "回答", attachments: [image] }] }, signal(), fetcher))
      .rejects.toMatchObject({ code: "attachments_too_large" });
    await expect(runClaudeApiDelegate({ ...base, history: [{ prompt: "前の依頼", context: "", response: "a".repeat(120_000) }] }, signal(), fetcher))
      .rejects.toMatchObject({ code: "request_too_large" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
