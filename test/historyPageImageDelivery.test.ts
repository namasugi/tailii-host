// ページと画像は同じ応答で適用する。通常購読の open() も本物で配送順を確かめる。
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { ChatTailController } from "../src/chat/chatTailController.js";
import { TranscriptTailer } from "../src/chat/transcriptTailer.js";
import { ImageService } from "../src/chat/imageService.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { decodeHubServerLine, type HubServerMessage } from "../src/hub/hubProtocol.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { LineWriter } from "../src/shared/lineWriter.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

type Image = Extract<ControlMessage, { type: "image_available" }>;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(options: { read?: boolean; attach?: boolean; reread?: boolean; failure?: boolean } = {}) {
  const cwd = makeTempDir("inline-page-cwd");
  const root = makeTempDir("inline-page-projects");
  const dir = path.join(root, claudeProjectSlug(cwd));
  fs.mkdirSync(dir);
  const imagePath = path.join(makeTempDir("inline-page-image"), "a.png");
  fs.writeFileSync(imagePath, "image");
  const lines = [JSON.stringify({ type: "user", uuid: "u", timestamp: new Date(Date.now() - 3600000).toISOString(),
    message: { role: "user", content: options.attach === false ? "質問" : `@"${imagePath}"` } })];
  if (options.read) lines.push(JSON.stringify({ type: "assistant", uuid: "a", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: imagePath } }] } }));
  if (options.reread) lines.push(JSON.stringify({ type: "assistant", uuid: "b", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id: "s", name: "Read", input: { file_path: imagePath } }] } }));
  fs.writeFileSync(path.join(dir, "provider.jsonl"), lines.join("\n") + "\n");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const thumbnailer = vi.fn(async () => {
    const attempt = ++attempts;
    await pending;
    if (attempt === 1 && options.failure) return null;
    return { thumbnailBase64: "QQ==", width: 1, height: 1 };
  });
  const indexBase = makeTempDir("inline-page-index");
  let service = new ImageService({ indexBase, thumbnailer });
  const store = makeTempStore();
  store.put({ name: "work", cwd, createdAt: 0, providerSessionId: "provider" });
  store.put({ name: "other", cwd, createdAt: 0, providerSessionId: "other-provider" });
  fs.writeFileSync(path.join(dir, "other-provider.jsonl"), JSON.stringify({
    type: "user", uuid: "other-u", timestamp: new Date().toISOString(), message: { role: "user", content: "別の会話" },
  }) + "\n");
  const createHub = () => new SessionHub({ runner: async () => ok(""), metadataStore: store,
    heartbeatDir: makeTempDir("inline-page-heartbeat"), timeoutSeconds: 1800, imageService: service,
    tailFactory: (write) => new ChatTailController({
      writer: new LineWriter(new Writable({ write(chunk, _enc, done) {
        for (const line of chunk.toString().trim().split("\n")) write(decodeControlMessage(line));
        done();
      } })),
      tailer: new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true, pollIntervalMs: 5 }),
      projectsRoot: root, imageService: service,
      subagentTailer: { async *streamProjectDir() {} } as never,
    }),
  });
  let hub = createHub();
  const client = {};
  const received: HubServerMessage[] = [];
  const timeline: string[] = [];
  let foreground: string | null = null;
  const logs = new Map<string, { ids: string[]; seen: Set<string>; attachments: Set<string> }>();
  const visible = (session = "work") => logs.get(session)?.ids ?? [];
  const accept = (session: string, image: Image): void => {
    const log = logs.get(session) ?? { ids: [], seen: new Set<string>(), attachments: new Set<string>() };
    logs.set(session, log);
    // iOS ImageTransferModel.onAvailable と同じ既存ガードを模す。添付の後の Read を抑止し、
    // 同じ ID は冪等、別 ID の Read→Read は残す。host の通常購読は変更しない。
    if (log.seen.has(image.id)) return;
    if (image.id.startsWith("read-") && log.attachments.has(image.path)) return;
    if (!image.id.startsWith("read-")) log.attachments.add(image.path);
    log.seen.add(image.id);
    log.ids.push(image.id);
  };
  const register = () => hub.registerClient(client, (line) => {
    const message = decodeHubServerLine(line);
    if (message === null) return;
    received.push(message);
    if (message.type === "conversation_history_page_response" && !message.failed) {
      for (const event of message.lines.map(decodeControlMessage)) {
        if (event.type === "image_available") { timeline.push(`page:${event.id}`); accept(message.session, event); }
      }
    } else if (message.type === "conversation_event" && message.payload.type === "image_available") {
      timeline.push(`live:${message.payload.id}`);
      if (foreground === message.session) accept(message.session, message.payload);
    }
  });
  register();
  cleanup.push(() => { hub.unregisterClient(client); hub.close(); });
  const send = (type: string, extra: { session?: string; preview?: boolean; [key: string]: unknown } = {}) => {
    if (type === "conversation_subscribe" && extra.preview !== false) foreground = extra.session ?? "work";
    if (type === "conversation_unsubscribe" || (type === "conversation_subscribe" && extra.preview === false)) foreground = null;
    hub.handleClientMessage(client, JSON.stringify({ type, session: "work", ...extra }));
  };
  const doneCount = () => received.filter((m) => m.type === "conversation_event" && m.payload.type === "chat_output" && m.payload.streamId === "pc:history-done").length;
  const page = (id = "p") => received.find((m) => m.type === "conversation_history_page_response" && m.id === id);
  const pageImages = (id = "p") => page(id)?.lines.map(decodeControlMessage).filter((e): e is Image => e.type === "image_available") ?? [];
  const request = (id = "p", extra: object = {}) => send("conversation_history_page_request", { id, limit: 24, ...extra });
  const subscribe = () => send("conversation_subscribe", { newerThanMs: page()!.hostNowMs - 5000, preview: true });
  const restart = () => {
    hub.unregisterClient(client);
    hub.close();
    service = new ImageService({ indexBase, thumbnailer });
    hub = createHub();
    foreground = null;
    register();
  };
  return { send, request, subscribe, doneCount, release, thumbnailer, page, pageImages, restart, visible, timeline };
}

test.each(["away", "reentered"])("画像完成前の離脱はページ全体を中止し、再入場の応答に画像を同梱する: %s", async (when) => {
  const h = setup();
  h.request("first");
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  expect(h.page("first")).toBeUndefined();
  expect(h.visible()).toEqual([]);
  h.send("conversation_unsubscribe");
  await vi.waitFor(() => expect(h.page("first")).toMatchObject({ failed: true, lines: [] }));
  if (when === "away") { h.release(); await tick(); }
  h.request();
  if (when === "reentered") { await tick(); expect(h.page()).toBeUndefined(); h.release(); }
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  expect(h.visible()).toEqual(["att-u-0"]);
  expect(h.timeline).toEqual(["page:att-u-0"]);
});

test("古い添付をページで先に適用し、実際の通常購読の Read が続いても表示は1枚", async () => {
  const h = setup({ read: true });
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  expect(h.page()).toBeUndefined();
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  expect(h.timeline).toEqual(["page:att-u-0", "live:read-r"]);
  expect(h.visible()).toEqual(["att-u-0"]);
});

test("hub 再起動前の未完了ページは適用せず、取り直したページに画像がそろう", async () => {
  const h = setup();
  h.request("first");
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  expect(h.page("first")).toBeUndefined();
  h.restart();
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledTimes(2));
  expect(h.page()).toBeUndefined();
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  // 成功応答を適用済みなら、再起動後に差分だけ購読しても画像は手元にそろっている。
  h.restart();
  h.send("conversation_subscribe", { newerThanMs: Date.now() - 300000, preview: true });
  await vi.waitFor(() => expect(h.doneCount()).toBe(2));
  expect(h.visible()).toEqual(["att-u-0"]);
});

test("添付の生成に失敗した場合は Read の画像をページへ同梱する", async () => {
  const h = setup({ read: true, failure: true });
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["read-r"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  expect(h.visible()).toEqual(["read-r"]);
});

test("添付のない同一パスの再 Read は別 ID ごとに同梱し、購読後も2枚を保つ", async () => {
  const h = setup({ read: true, attach: false, reread: true });
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["read-r", "read-s"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  expect(h.visible()).toEqual(["read-r", "read-s"]);
});

test("ページで受け取った古い添付は再入場時に未配送にならず、増えない", async () => {
  const h = setup();
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  h.send("conversation_unsubscribe");
  h.send("conversation_subscribe", { newerThanMs: Date.now() - 300000, preview: true });
  await vi.waitFor(() => expect(h.doneCount()).toBe(2));
  expect(h.visible()).toEqual(["att-u-0"]);
  expect(h.timeline).toEqual(["page:att-u-0"]);
});

test("背景購読だけが先に始まっても、ページ応答で画像がそろってから前面化する", async () => {
  const h = setup();
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  h.send("conversation_subscribe", { newerThanMs: Date.now() - 5000, preview: false });
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  expect(h.page()).toBeUndefined();
  expect(h.visible()).toEqual([]);
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]));
  h.send("conversation_subscribe", { newerThanMs: Date.now() - 300000, preview: true });
  await vi.waitFor(() => expect(h.doneCount()).toBe(2));
  expect(h.visible()).toEqual(["att-u-0"]);
});

test("画像待ちで別会話へ移ったとき、元ページは失敗し後着画像も流さない", async () => {
  const h = setup();
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  h.send("conversation_unsubscribe");
  h.send("conversation_subscribe", { session: "other", newerThanMs: Date.now() - 300000, preview: true });
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  h.release();
  await tick(); await tick();
  expect(h.page()).toMatchObject({ failed: true, lines: [] });
  expect(h.visible()).toEqual([]);
  expect(h.visible("other")).toEqual([]);
  expect(h.timeline).toEqual([]);
});

test("ページキャッシュの保持期限を越えても、適用済みの本文と画像が分離しない", async () => {
  const h = setup();
  h.request();
  await vi.waitFor(() => expect(h.thumbnailer).toHaveBeenCalledOnce());
  h.release();
  await vi.waitFor(() => expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]));
  h.subscribe();
  await vi.waitFor(() => expect(h.doneCount()).toBe(1));
  h.send("conversation_unsubscribe");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60000);
  h.request("older", { beforeStreamId: "u" });
  await vi.waitFor(() => expect(h.page("older")).toBeDefined());
  h.send("conversation_subscribe", { newerThanMs: Date.now() - 300000, preview: true });
  await vi.waitFor(() => expect(h.doneCount()).toBe(2));
  expect(h.pageImages().map((i) => i.id)).toEqual(["att-u-0"]);
  expect(h.visible()).toEqual(["att-u-0"]);
});
