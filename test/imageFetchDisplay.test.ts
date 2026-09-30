// imageFetchDisplay.test.ts — 全画面表示用に縮めた画像を返す原本取得（image-fetch-display）
//
// 対象:
//   - ワイヤー: image_fetch_request.maxPixelSize の golden 往復・範囲外は指定なし扱い
//   - ImageService.fetch: 指定時だけ縮め、縮めても軽くならなければ原本・同じ画像はメモで sips を再実行しない
//   - 既定 resizer（sips）: 実画像で長辺が上限以下の HEIC になる（macOS のみ）

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ImageService, sipsResizer, type ImageResizer } from "../src/chat/imageService.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { makeTempDir } from "./helpers.js";

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "protocol", "image-fetch-display-v1.ndjson",
);

describe("image_fetch_request.maxPixelSize のワイヤー", () => {
  test("golden 全行が byte-exact でラウンドトリップする", () => {
    const lines = fs.readFileSync(GOLDEN, "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect(decodeControlMessage(lines[0]!)).toEqual({
      type: "image_fetch_request", v: 1, id: "att-s1-0", maxPixelSize: 2048,
    });
    // 省略時（旧クライアント）はキー自体を持たない。
    expect(decodeControlMessage(lines[1]!)).toEqual({ type: "image_fetch_request", v: 1, id: "att-s1-0" });
  });

  test("範囲外・非整数・型違いの maxPixelSize は指定なし扱い（要求は拒否しない）", () => {
    for (const value of ["0", "100", "99999", "2048.5", "\"2048\"", "null"]) {
      expect(decodeControlMessage(
        `{"id":"a","maxPixelSize":${value},"type":"image_fetch_request","v":1}`,
      )).toEqual({ type: "image_fetch_request", v: 1, id: "a" });
    }
  });
});

describe("ImageService.fetch の表示サイズ", () => {
  function setup(resizer: ImageResizer, bytes = 10_000) {
    const root = makeTempDir("image-fetch-display");
    const index = path.join(root, "index");
    const blob = path.join(root, "shot.png");
    fs.writeFileSync(blob, Buffer.alloc(bytes, 7));
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, "att-s1-0.json"), JSON.stringify({ id: "att-s1-0", path: blob }));
    return new ImageService({ indexBase: index, pendingBase: path.join(root, "pending"), resizer });
  }

  test("指定があれば縮めた HEIC を返し、同じ画像はメモ命中で縮め直さない", async () => {
    const calls: Array<[string, number]> = [];
    const service = setup(async (imagePath, max) => {
      calls.push([imagePath, max]);
      return { data: Buffer.from([0, 1, 2]), mime: "image/heic" };
    });

    const first = await service.fetch("att-s1-0", 2048);
    const second = await service.fetch("att-s1-0", 2048);

    expect(first).toEqual([{
      type: "image_fetch_response", v: 1, id: "att-s1-0", seq: 0, data: "AAEC", eof: true, mime: "image/heic",
    }]);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe(2048);
  });

  test("同じ画像への同時要求は sips を 1 回だけ走らせる", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = setup(async () => {
      calls += 1;
      await gate;
      return { data: Buffer.from([0, 1, 2]), mime: "image/heic" };
    });

    const both = Promise.all([service.fetch("att-s1-0", 2048), service.fetch("att-s1-0", 2048)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [a, b] = await both;

    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ mime: "image/heic" });
  });

  test("縮小が例外を投げても原本を返す", async () => {
    const service = setup(async () => { throw new Error("boom"); }, 100);
    expect((await service.fetch("att-s1-0", 2048))[0]).toMatchObject({ mime: "image/png" });
  });

  test("指定が無ければ縮めずに原本を返す（旧クライアント互換）", async () => {
    let called = false;
    const service = setup(async () => {
      called = true;
      return { data: Buffer.from([0]), mime: "image/heic" };
    }, 100);

    const responses = await service.fetch("att-s1-0");

    expect(called).toBe(false);
    expect(responses).toEqual([{
      type: "image_fetch_response", v: 1, id: "att-s1-0", seq: 0,
      data: Buffer.alloc(100, 7).toString("base64"), eof: true, mime: "image/png",
    }]);
  });

  test("縮めても軽くならない・縮められないときは原本を返す", async () => {
    const bigger = setup(async () => ({ data: Buffer.alloc(200, 1), mime: "image/heic" }), 100);
    expect((await bigger.fetch("att-s1-0", 2048))[0]).toMatchObject({ mime: "image/png" });

    const failed = setup(async () => null, 100);
    expect((await failed.fetch("att-s1-0", 2048))[0]).toMatchObject({ mime: "image/png" });
  });

  test("縮小の失敗は覚えず、次の要求で縮め直す（一時的な失敗で原本に固定しない）", async () => {
    let attempts = 0;
    const service = setup(async () => {
      attempts += 1;
      return attempts === 1 ? null : { data: Buffer.from([0, 1, 2]), mime: "image/heic" };
    });

    expect((await service.fetch("att-s1-0", 2048))[0]).toMatchObject({ mime: "image/png" });
    expect((await service.fetch("att-s1-0", 2048))[0]).toMatchObject({ mime: "image/heic" });
    expect(attempts).toBe(2);
  });

  test("index に無い id は image_not_found", async () => {
    const service = setup(async () => null);
    expect(await service.fetch("missing", 2048)).toEqual([
      expect.objectContaining({ type: "error", code: "image_not_found", id: "missing" }),
    ]);
  });
});

describe.runIf(process.platform === "darwin" && fs.existsSync("/usr/bin/sips"))("sipsResizer", () => {
  const ONE_PIXEL_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  function makePng(width: number, height: number): string {
    const dir = makeTempDir("sips-resizer");
    const png = path.join(dir, "src.png");
    fs.writeFileSync(png, Buffer.from(ONE_PIXEL_PNG, "base64"));
    execFileSync("/usr/bin/sips", ["-z", String(height), String(width), png], { stdio: "ignore" });
    return png;
  }

  function pixelSize(data: Buffer): { width: number; height: number } {
    const file = path.join(makeTempDir("sips-probe"), "out.heic");
    fs.writeFileSync(file, data);
    const out = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]).toString();
    return {
      width: Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]),
      height: Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]),
    };
  }

  test("長辺が上限を超える PNG は長辺を上限まで縮めた HEIC になる", async () => {
    const resized = await sipsResizer()(makePng(3000, 1500), 2048);
    expect(resized?.mime).toBe("image/heic");
    expect(pixelSize(resized!.data)).toEqual({ width: 2048, height: 1024 });
  });

  test("上限に収まる PNG は引き伸ばさず形式だけ HEIC にする", async () => {
    const resized = await sipsResizer()(makePng(800, 600), 2048);
    expect(resized?.mime).toBe("image/heic");
    expect(pixelSize(resized!.data)).toEqual({ width: 800, height: 600 });
  });

  test("GIF は触らない（アニメーションを止めない）", async () => {
    const dir = makeTempDir("sips-gif");
    const gif = path.join(dir, "anim.gif");
    fs.writeFileSync(gif, Buffer.from("GIF89a"));
    expect(await sipsResizer()(gif, 2048)).toBeNull();
  });
});
