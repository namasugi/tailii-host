// fileService.test.ts — cwd ファイル一覧・プレビューの境界検証

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { fileList, fileRead } from "../src/fileService.js";
import { makeTempDir } from "./helpers.js";

describe("fileService", () => {
  test("dir 優先・名前昇順で symlink と隠しファイルを含める", () => {
    const root = makeTempDir("file-list");
    fs.writeFileSync(path.join(root, "b.txt"), "b");
    fs.writeFileSync(path.join(root, ".hidden"), "h");
    fs.mkdirSync(path.join(root, "z-dir"));
    fs.mkdirSync(path.join(root, "a-dir"));
    fs.symlinkSync(path.join(root, "b.txt"), path.join(root, "link"));

    const result = fileList(root);
    expect(result.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["a-dir", "dir"], ["z-dir", "dir"], [".hidden", "file"],
      ["b.txt", "file"], ["link", "symlink"],
    ]);
    expect(result.truncated).toBe(false);
    expect(fileList("relative")).toEqual({ path: "relative", entries: [], truncated: false });
  });

  test("一覧を1000件で切り詰める", () => {
    const root = makeTempDir("file-list-limit");
    for (let index = 0; index < 1_001; index += 1) {
      fs.writeFileSync(path.join(root, `f-${String(index).padStart(4, "0")}`), "");
    }
    const result = fileList(root);
    expect(result.entries).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
  });

  test("一覧と読み取りのmtimeMsを整数に丸める", async () => {
    const root = makeTempDir("file-mtime");
    const filePath = path.join(root, "fractional.txt");
    const fractionalMtimeSeconds = 1_783_751_220.225_307_4;
    fs.writeFileSync(filePath, "mtime");
    fs.utimesSync(filePath, fractionalMtimeSeconds, fractionalMtimeSeconds);

    const underlyingMtimeMs = fs.statSync(filePath).mtimeMs;
    expect(Number.isInteger(underlyingMtimeMs)).toBe(false);

    const listResult = fileList(root);
    expect(listResult.entries.every((entry) => Number.isInteger(entry.mtimeMs))).toBe(true);

    const readResult = await fileRead(filePath);
    expect(Number.isInteger(readResult.mtimeMs)).toBe(true);
  });

  test("UTF-8、切り詰め、バイナリ、巨大ファイルを判定する", async () => {
    const root = makeTempDir("file-read");
    const textPath = path.join(root, "text.txt");
    const truncatedPath = path.join(root, "long.txt");
    const binaryPath = path.join(root, "data.bin");
    const hugePath = path.join(root, "huge.dat");
    fs.writeFileSync(textPath, "こんにちは\n");
    fs.writeFileSync(truncatedPath, "a".repeat(256 * 1024 + 10));
    fs.writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]));
    fs.writeFileSync(hugePath, Buffer.alloc(5 * 1024 * 1024 + 1));

    await expect(fileRead(textPath)).resolves.toMatchObject({ kind: "text", content: "こんにちは\n", truncated: false });
    await expect(fileRead(truncatedPath)).resolves.toMatchObject({ kind: "text", truncated: true });
    await expect(fileRead(binaryPath)).resolves.toMatchObject({ kind: "binary" });
    await expect(fileRead(hugePath)).resolves.toMatchObject({ kind: "tooLarge" });
    await expect(fileRead("relative.txt")).resolves.toMatchObject({ kind: "error" });
  });

  test("画像は注入 thumbnailer を最大辺1024pxで再利用する", async () => {
    const root = makeTempDir("file-image");
    const imagePath = path.join(root, "photo.png");
    fs.writeFileSync(imagePath, "fake");
    const thumbnailer = vi.fn(async () => ({
      thumbnailBase64: "aW1hZ2U=", imageFormat: "png" as const, width: 20, height: 10,
    }));

    await expect(fileRead(imagePath, thumbnailer)).resolves.toMatchObject({
      kind: "image", imageBase64: "aW1hZ2U=", imageFormat: "png",
    });
    expect(thumbnailer).toHaveBeenCalledWith(imagePath, 1_024);
  });
});
