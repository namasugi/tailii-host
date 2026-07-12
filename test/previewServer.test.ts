// previewServer.test.ts — Web プレビュー用 loopback 静的サーバーの受け入れ網
//
// 実ポート（127.0.0.1 のエフェメラル）で listen し、http で叩いて検証する。
// トークン必須・traversal 拒否・参照カウント teardown が守られることを確認する。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PreviewError, PreviewServer } from "../src/previewServer.js";

let dir: string;
let server: PreviewServer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tailii-preview-"));
  writeFileSync(join(dir, "index.html"), "<html><body>hello</body></html>");
  writeFileSync(join(dir, "style.css"), "body { color: red; }");
  writeFileSync(join(dir, "secret.txt"), "top secret");
  server = new PreviewServer();
});

afterEach(async () => {
  await server.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

async function get(url: string): Promise<{ status: number; body: string; contentType: string | null }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

describe("PreviewServer", () => {
  it("HTML を配信し、URL は 127.0.0.1 + トークンパスになる", async () => {
    const { url } = await server.open("id-1", join(dir, "index.html"));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{32}\/index\.html$/);
    const result = await get(url);
    expect(result.status).toBe(200);
    expect(result.body).toContain("hello");
    expect(result.contentType).toBe("text/html; charset=utf-8");
  });

  it("同ディレクトリの相対アセット（css）を配信する", async () => {
    const { url } = await server.open("id-1", join(dir, "index.html"));
    const cssURL = url.replace("index.html", "style.css");
    const result = await get(cssURL);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/css; charset=utf-8");
  });

  it("トークン不一致は 404", async () => {
    const { url } = await server.open("id-1", join(dir, "index.html"));
    const wrongToken = url.replace(/\/t\/[0-9a-f]{32}\//, "/t/deadbeefdeadbeefdeadbeefdeadbeef/");
    expect((await get(wrongToken)).status).toBe(404);
  });

  it("path traversal（..%2f）は root 外へ出られない", async () => {
    const { url } = await server.open("id-1", join(dir, "index.html"));
    const traversal = url.replace("index.html", "..%2f..%2fetc%2fpasswd");
    const result = await get(traversal);
    expect([403, 404]).toContain(result.status);
    expect(result.body).not.toContain("root");
  });

  it("ディレクトリ要求は index.html を返す", async () => {
    const sub = join(dir, "docs");
    mkdirSync(sub);
    writeFileSync(join(sub, "index.html"), "<p>docs</p>");
    const { url } = await server.open("id-1", join(dir, "index.html"));
    const result = await get(url.replace("index.html", "docs/"));
    expect(result.status).toBe(200);
    expect(result.body).toContain("docs");
  });

  it(".html/.htm 以外・相対パスは invalid-target", async () => {
    await expect(server.open("id-1", join(dir, "secret.txt"))).rejects.toThrowError(PreviewError);
    await expect(server.open("id-2", "relative/index.html")).rejects.toThrowError(PreviewError);
  });

  it("存在しないファイルは not-found", async () => {
    await expect(server.open("id-1", join(dir, "missing.html"))).rejects.toThrowError(/not-found/);
  });

  it("同一ファイルの再 open はリスナーを再利用し、参照が尽きるまで生きる", async () => {
    const first = await server.open("id-1", join(dir, "index.html"));
    const second = await server.open("id-2", join(dir, "index.html"));
    expect(second.url).toBe(first.url);

    await server.close("id-1");
    expect((await get(first.url)).status).toBe(200);

    await server.close("id-2");
    await expect(fetch(first.url)).rejects.toThrow();
  });

  it("トークン付き応答は cookie を配り、cookie 持ちは絶対パス参照を解決できる", async () => {
    // エージェント生成 HTML の <img src="/Users/.../uploads/x.jpg">（絶対パス参照）対応。
    const outside = mkdtempSync(join(tmpdir(), "tailii-preview-abs-"));
    writeFileSync(join(outside, "photo.jpg"), "jpegdata");
    try {
      const { url } = await server.open("id-1", join(dir, "index.html"));
      const token = /\/t\/([0-9a-f]{32})\//.exec(url)?.[1] ?? "";

      // HTML 応答に set-cookie が付く。
      const htmlResponse = await fetch(url);
      expect(htmlResponse.headers.get("set-cookie")).toContain(`tailii_t_${token}=1`);

      const origin = new URL(url).origin;
      const absURL = `${origin}${join(outside, "photo.jpg")}`;

      // cookie 無しの絶対パスは 404（トークン保護は維持）。
      expect((await fetch(absURL)).status).toBe(404);
      // 不一致トークンの cookie も 404。
      expect((await fetch(absURL, {
        headers: { cookie: "tailii_t_deadbeefdeadbeefdeadbeefdeadbeef=1" },
      })).status).toBe(404);

      // 正しい cookie 持ちは配信される。
      const authorized = await fetch(absURL, { headers: { cookie: `tailii_t_${token}=1` } });
      expect(authorized.status).toBe(200);
      expect(authorized.headers.get("content-type")).toBe("image/jpeg");
      expect(await authorized.text()).toBe("jpegdata");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("未知 id の close は no-op、closeAll は冪等", async () => {
    await server.close("unknown");
    const { url } = await server.open("id-1", join(dir, "index.html"));
    await server.closeAll();
    await server.closeAll();
    await expect(fetch(url)).rejects.toThrow();
  });
});
