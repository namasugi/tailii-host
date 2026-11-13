import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { ImageService, type ThumbnailResult } from "../src/chat/imageService.js";
import { StartupImageWriter } from "../src/engine/startupImageWriter.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok, startEngine } from "./helpers.js";

// 画像と要求ループの単体検証。実プロセスの起動保証は hubDaemonClientProcess.test.ts で確認する。
vi.mock("../src/hub/hubDaemonClient.js", () => ({ ensureHubDaemonAsync: async () => {} }));

it("pending のサムネ生成中も hello と一覧要求を処理し、画像の順序・メモ・消費を保つ", async () => {
  const root = makeTempDir("engine-startup-images"); const pendingBase = path.join(root, "pending");
  fs.mkdirSync(pendingBase); const imagePath = path.join(root, "a.png"); fs.writeFileSync(imagePath, "image");
  for (const id of ["a", "b"]) fs.writeFileSync(path.join(pendingBase, `${id}.json`), JSON.stringify({ imageId: id, path: imagePath, relatedApprovalId: id }));
  let finish!: (value: ThumbnailResult) => void;
  const thumbnailer = vi.fn(() => new Promise<ThumbnailResult>((resolve) => { finish = resolve; }));
  const imageService = new ImageService({ pendingBase, indexBase: path.join(root, "index"), thumbnailer });
  const store = makeTempStore(); const runner = new MockTmuxRunner(() => ok(""));
  const engine = startEngine({ sessionManager: new TmuxSessionManager({ store, runner: runner.runner }), metadataStore: store, imageService });
  try {
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"type":"session_list_request","v":2,"id":"list"}');
    expect(decodeControlMessage(await engine.lines.nextOfType("session_list_response"))).toMatchObject({ id: "list" });
    expect(fs.readdirSync(pendingBase)).toHaveLength(2);
    finish({ thumbnailBase64: "AA==", width: 1, height: 1 });
    const images = [decodeControlMessage(await engine.lines.nextOfType("image_available")), decodeControlMessage(await engine.lines.nextOfType("image_available"))];
    expect(images).toMatchObject([{ id: "a", relatedApprovalId: "a" }, { id: "b", relatedApprovalId: "b" }]);
    expect(thumbnailer).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fs.readdirSync(pendingBase)).toEqual([]));
    expect(await imageService.drainPending()).toEqual([]);
  } finally {
    finish?.({ thumbnailBase64: "AA==", width: 1, height: 1 });
    await engine.teardown();
  }
});

it("後着の画像だけを保留し、通常応答を通してから pending → 後着の順に一度ずつ配る", () => {
  const output = new PassThrough(); let data = ""; output.on("data", (chunk) => { data += chunk; });
  const writer = new StartupImageWriter(output, true);
  const image = (id: string): ControlMessage => ({ type: "image_available", v: 1, id, path: "/a.png", mime: "image/png", thumbnail: "AA==", width: 1, height: 1 });
  writer.write(image("live-1")); writer.write({ type: "channel_hello", v: 1, maxVersion: 2 }); writer.write(image("live-2"));
  expect(data).not.toContain("image_available");
  writer.finishPending([image("pending-1"), image("pending-2")]); writer.write(image("live-3"));
  expect(data.trim().split("\n").map((line) => JSON.parse(line)).map((m) => m.id ?? m.type))
    .toEqual(["channel_hello", "pending-1", "pending-2", "live-1", "live-2", "live-3"]);
});

it("pending の処理失敗後も一覧要求に応答し、画像を送出しない", async () => {
  const imageService = new ImageService({ pendingBase: makeTempDir("engine-empty-pending") });
  let fail!: (error: Error) => void;
  vi.spyOn(imageService, "drainPending").mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const store = makeTempStore(); const runner = new MockTmuxRunner(() => ok(""));
  const engine = startEngine({ sessionManager: new TmuxSessionManager({ store, runner: runner.runner }), metadataStore: store, imageService });
  await engine.lines.nextOfType("channel_hello");
  let output = ""; engine.output.on("data", (chunk) => { output += chunk; });
  fail(new Error("thumbnail failed"));
  await new Promise((resolve) => setImmediate(resolve));
  engine.writeLine('{"type":"session_list_request","v":2,"id":"after-failure"}');
  expect(decodeControlMessage(await engine.lines.nextOfType("session_list_response"))).toMatchObject({ id: "after-failure" });
  expect(output).not.toContain("image_available");
  await engine.teardown();
});

it.each([false, true])("生成の完了が入力 EOF より後でも、出力切断=%s に応じて送出・次の接続で回収する", async (disconnect) => {
  const root = makeTempDir("engine-pending-eof");
  const pendingBase = path.join(root, "pending"); fs.mkdirSync(pendingBase);
  const imagePath = path.join(root, "a.png"); fs.writeFileSync(imagePath, "image");
  for (const id of ["a", "b"]) fs.writeFileSync(path.join(pendingBase, `${id}.json`), JSON.stringify({ imageId: id, path: imagePath }));
  let finish!: (value: ThumbnailResult) => void;
  const imageService = new ImageService({ pendingBase, indexBase: path.join(root, "index"),
    thumbnailer: () => new Promise<ThumbnailResult>((resolve) => { finish = resolve; }) });
  const store = makeTempStore(); const runner = new MockTmuxRunner(() => ok(""));
  const options = { sessionManager: new TmuxSessionManager({ store, runner: runner.runner }), metadataStore: store, imageService };
  const engine = startEngine(options);
  let output = ""; engine.output.on("data", (chunk) => { output += chunk; });
  try {
    await engine.lines.nextOfType("channel_hello");
    if (disconnect) engine.output.destroy();
    const done = engine.teardown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.readdirSync(pendingBase)).toHaveLength(2);
    finish({ thumbnailBase64: "AA==", width: 1, height: 1 });
    await done;
    const images = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((m) => m.type === "image_available");
    expect(images.map((m) => m.id)).toEqual(disconnect ? [] : ["a", "b"]);
    expect(fs.readdirSync(pendingBase)).toHaveLength(disconnect ? 2 : 0);
    const next = startEngine(options);
    try {
      await next.lines.nextOfType("channel_hello");
      if (disconnect) {
        const recovered = [await next.lines.nextOfType("image_available"), await next.lines.nextOfType("image_available")];
        expect(recovered.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["a", "b"]);
      }
      await next.teardown();
      expect(fs.readdirSync(pendingBase)).toEqual([]);
    } finally { await next.teardown(); }
  } finally {
    finish?.({ thumbnailBase64: "AA==", width: 1, height: 1 });
    await engine.teardown();
  }
});

it("書き込み中の切断・失敗を送出成功と扱わない", async () => {
  const { Writable } = await import("node:stream");
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } });
  const writer = new StartupImageWriter(output, true);
  expect(await writer.writePending({ type: "error", v: 1, code: "image_not_found", message: "missing" })).toBe(false);
});

it("一部の画像を送信した後の切断では、未送信分だけを次の接続で回収する", async () => {
  const root = makeTempDir("engine-pending-partial");
  const pendingBase = path.join(root, "pending"); fs.mkdirSync(pendingBase);
  for (const id of ["a", "b"]) {
    const imagePath = path.join(root, `${id}.png`); fs.writeFileSync(imagePath, id);
    fs.writeFileSync(path.join(pendingBase, `${id}.json`), JSON.stringify({ imageId: id, path: imagePath }));
  }
  const thumbnail = { thumbnailBase64: "AA==", width: 1, height: 1 };
  let finish!: (value: ThumbnailResult) => void;
  const imageService = new ImageService({ pendingBase, indexBase: path.join(root, "index"),
    thumbnailer: async (file) => file.endsWith("a.png") ? thumbnail : new Promise<ThumbnailResult>((resolve) => { finish = resolve; }) });
  const store = makeTempStore(); const runner = new MockTmuxRunner(() => ok(""));
  const options = { sessionManager: new TmuxSessionManager({ store, runner: runner.runner }), metadataStore: store, imageService };
  const first = startEngine(options);
  try {
    expect(JSON.parse(await first.lines.nextOfType("image_available"))).toMatchObject({ id: "a" });
    await vi.waitFor(() => {
      expect(fs.readdirSync(pendingBase)).toEqual(["b.json"]);
      expect(finish).toBeTypeOf("function");
    });
    first.output.destroy(); const done = first.teardown();
    finish(thumbnail); await done;
    expect(fs.readdirSync(pendingBase)).toEqual(["b.json"]);
    const next = startEngine(options);
    try {
      expect(JSON.parse(await next.lines.nextOfType("image_available"))).toMatchObject({ id: "b" });
      await next.teardown();
      expect(fs.readdirSync(pendingBase)).toEqual([]);
    } finally { await next.teardown(); }
  } finally { finish?.(thumbnail); await first.teardown(); }
});
