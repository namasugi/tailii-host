// history-page の有限再生・画像の後着・読取の共有と取消。
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatTailController } from "../src/chat/chatTailController.js";
import { TranscriptTailer } from "../src/chat/transcriptTailer.js";
import { SubagentTailer } from "../src/chat/subagentTailer.js";
import { CodexRolloutTailer } from "../src/codex/codexRolloutTailer.js";
import { ImageService } from "../src/chat/imageService.js";
import { HistoryPageImages } from "../src/hub/historyPageImages.js";
import { sliceHistoryPage } from "../src/hub/historyPage.js";
import { SessionHub, type HubTail } from "../src/hub/sessionHub.js";
import { decodeHubServerLine, type HubServerMessage } from "../src/hub/hubProtocol.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { LineWriter } from "../src/shared/lineWriter.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

// 実 I/O のまま fd の解放を観測する（ソケット・実 CLI は使わない）。
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync),
    readSync: vi.fn(actual.readSync), createReadStream: vi.fn(actual.createReadStream) };
});

const hubs: SessionHub[] = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
const collect = async (stream: AsyncIterable<ControlMessage>): Promise<ControlMessage[]> => {
  const out: ControlMessage[] = [];
  for await (const event of stream) out.push(event);
  return out;
};
function writer(write: (event: ControlMessage) => void): LineWriter {
  return new LineWriter(new Writable({ write(chunk, _enc, done) {
    for (const line of chunk.toString().trim().split("\n")) write(decodeControlMessage(line));
    done();
  } }));
}
const text = (id: string, value = id, role: "user" | "assistant" = "assistant"): ControlMessage =>
  ({ type: "chat_output", v: 1, streamId: id, text: value, role, eof: true });
const read = (id: string, file: string): ControlMessage => ({ type: "tool_activity", v: 1,
  activity: { id, name: "Read", label: "画像", file, commandTruncated: false, descriptionTruncated: false } });
const record = (id: string, role: "user" | "assistant", content: unknown, extra: object = {}): string =>
  JSON.stringify({ type: role, uuid: id, timestamp: new Date().toISOString(), message: { role, content }, ...extra });
function fixture() {
  const cwd = makeTempDir("page-cwd");
  const root = makeTempDir("page-projects");
  const dir = path.join(root, claudeProjectSlug(cwd));
  fs.mkdirSync(dir);
  return { cwd, root, dir, file: path.join(dir, "provider.jsonl") };
}
function makeHub(tailFactory: (write: (event: ControlMessage) => void) => HubTail,
  imageService?: ImageService, cwd = "/tmp/work") {
  const store = makeTempStore();
  store.put({ name: "work", cwd, createdAt: 0, providerSessionId: "provider" });
  const hub = new SessionHub({ runner: async () => ok(""), metadataStore: store,
    heartbeatDir: makeTempDir("page-heartbeats"), timeoutSeconds: 1800, tailFactory, imageService });
  hubs.push(hub);
  const client = {};
  const received: HubServerMessage[] = [];
  hub.registerClient(client, (line) => { const message = decodeHubServerLine(line); if (message) received.push(message); });
  const send = (type: string, rest: object = {}) => hub.handleClientMessage(client, JSON.stringify({ type, session: "work", ...rest }));
  const pages = () => received.filter((m) => m.type === "conversation_history_page_response");
  const images = () => received.flatMap((m) => m.type === "conversation_event" && m.payload.type === "image_available" ? [m.payload] : []);
  return { hub, client, received, send, pages, images };
}

// 通番・更新元が窓の前にあっても、先頭から同じ変換状態で再生する。
describe("ページの本文は全再生と同じ", () => {
  test("Claude: 本文、ツール集約、子エージェント、narration、compact、画像、巨大な一行", async () => {
    const f = fixture();
    const signature = Buffer.from([0x12, 13, 0x0a, 11, 0x42, 9, ...Buffer.from("narration")]).toString("base64");
    const lines = [
      record("u", "user", '図 @"/tmp/example.png"'),
      record("skill", "assistant", [{ type: "tool_use", id: "s", name: "Skill", input: { skill: "demo" } }]),
      ...Array.from({ length: 30 }, (_, i) => record(`a${i}`, "assistant", `本文${i}`)),
      record("injected", "user", "Base directory for this skill: /tmp/demo\n本文", { isMeta: true, sourceToolUseID: "s" }),
      record("tool", "assistant", [
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "/tmp/example.png" } },
        { type: "tool_use", id: "agent", name: "Agent", input: { prompt: "調査", description: "子の調査" } },
      ]),
      record("n", "assistant", [{ type: "thinking", thinking: "経過の説明", signature }]),
      JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "compact", compactMetadata: { trigger: "auto" } }),
      record("summary", "user", "内部要約", { isCompactSummary: true }),
      record("long", "assistant", "あ".repeat(800_000)),
    ];
    fs.writeFileSync(f.file, lines.join("\n") + "\n");
    const tailer = new TranscriptTailer({ emitReplayDoneMarker: true });
    const full = await collect(tailer.streamTranscript(f.file));
    const controllerEvents: ControlMessage[] = [];
    const subagent = vi.spyOn(SubagentTailer.prototype, "streamProjectDir");
    const service = { makeAvailable: vi.fn(() => new Promise(() => {})), makeAttachmentsAvailable: vi.fn(() => new Promise(() => {})) } as unknown as ImageService;
    const controller = new ChatTailController({ writer: writer((e) => controllerEvents.push(e)), tailer,
      projectsRoot: f.root, imageService: service });
    await controller.readHistory(f.cwd, "provider", "claude", new AbortController().signal);
    expect(subagent).not.toHaveBeenCalled();
    expect(service.makeAvailable).not.toHaveBeenCalled();
    expect(service.makeAttachmentsAvailable).not.toHaveBeenCalled();
    for (const limit of [1, 4, 24, 100]) {
      expect(sliceHistoryPage(controllerEvents, null, limit)).toEqual(sliceHistoryPage(full, null, limit));
    }
    for (const anchor of [{ streamId: "a15" }, { toolId: "r" }, { streamId: "long" }]) {
      expect(sliceHistoryPage(controllerEvents, anchor, 24)).toEqual(sliceHistoryPage(full, anchor, 24));
    }
    expect(controllerEvents).toContainEqual(expect.objectContaining({ streamId: "n", text: "経過の説明" }));
    expect(controllerEvents.some((e) => e.type === "chat_output" && e.streamId === "summary")).toBe(false);
    expect(controllerEvents.filter((e) => e.type === "tool_activity" && e.activity.id === "s")).toHaveLength(2);
  });

  test.each([false, true])("Codex: 平文/圧縮=%s は全再生と同じ通番・user alias・ツール・長い行", async (compressed) => {
    const root = makeTempDir("page-rollout");
    const cwd = makeTempDir("page-codex-cwd");
    const file = path.join(root, "rollout-example.jsonl");
    const event = (payload: object) => JSON.stringify({ type: "event_msg", payload });
    const lines = [JSON.stringify({ type: "session_meta", payload: { id: "provider", cwd } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
      ...Array.from({ length: 35 }, (_, i) => event({ type: "agent_message", message: `過去${i}` })),
      event({ type: "item_completed", item: { type: "UserMessage", id: "item-user", client_id: "client", content: [{ type: "text", text: "質問" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call", arguments: '{"cmd":"ls"}' } }),
      event({ type: "item_completed", item: { type: "ImageView", id: "image", path: "/tmp/result.png" } }),
      event({ type: "agent_message", message: "長".repeat(700_000), phase: "final_answer" }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "assistant-item", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "長".repeat(700_000) }] } }),
      event({ type: "token_count", info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 200000 } }),
    ];
    const data = lines.join("\n") + "\n";
    fs.writeFileSync(file, data);
    const tailer = new CodexRolloutTailer({ sessionsRoot: root, emitReplayDoneMarker: true });
    const full = await collect(tailer.streamForCwd(cwd, null, undefined, "provider"));
    if (compressed) { fs.writeFileSync(file + ".zst", zlib.zstdCompressSync(Buffer.from(data))); fs.unlinkSync(file); }
    const page = await collect(tailer.streamHistory(cwd, "provider", new AbortController().signal));
    for (const limit of [1, 3, 24, 100]) expect(sliceHistoryPage(page, null, limit)).toEqual(sliceHistoryPage(full, null, limit));
    for (const anchor of [{ streamId: "codex-item-assistant-item" }, { streamId: "codex-item-item-user" }, { toolId: "call" }]) {
      expect(sliceHistoryPage(page, anchor, 24)).toEqual(sliceHistoryPage(full, anchor, 24));
    }
    expect(page).toContainEqual(expect.objectContaining({ type: "chat_stream_alias", streamId: "codex-user-client", aliasStreamIds: ["codex-item-item-user"] }));
    expect(page).toContainEqual(expect.objectContaining({ type: "chat_stream_alias", streamId: "codex-turn-37", aliasStreamIds: ["codex-item-assistant-item"] }));
  });
});

describe("ページの画像は応答へ同梱する", () => {
  test("ページの外の古い画像が終わらなくても最新ページを返し、過去ページだけは対象画像を待つ", async () => {
    const f = fixture();
    const imagePath = path.join(makeTempDir("page-old-image"), "a.png");
    fs.writeFileSync(imagePath, "image");
    fs.writeFileSync(f.file, [record("u", "user", `@"${imagePath}"`), record("a", "assistant", "答え"), record("b", "assistant", "最新")].join("\n") + "\n");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const thumbnailer = vi.fn(async () => { await pending; return { thumbnailBase64: "QQ==", width: 1, height: 1 }; });
    const service = new ImageService({ indexBase: makeTempDir("page-old-index"), thumbnailer });
    const h = makeHub((write) => new ChatTailController({ writer: writer(write), tailer: new TranscriptTailer(),
      projectsRoot: f.root, imageService: service }), service, f.cwd);
    h.send("conversation_history_page_request", { id: "latest", limit: 1 });
    await vi.waitFor(() => expect(h.pages()).toHaveLength(1));
    expect(h.pages()[0]!.lines.map(decodeControlMessage)).toEqual([text("b", "最新")]);
    expect(thumbnailer).not.toHaveBeenCalled();
    h.send("conversation_history_page_request", { id: "older", limit: 24, beforeStreamId: "b" });
    await vi.waitFor(() => expect(thumbnailer).toHaveBeenCalledOnce());
    expect(h.pages()).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(h.pages()).toHaveLength(2));
    expect(h.pages()[1]!.lines.map(decodeControlMessage)).toMatchObject([
      text("u", `@"${imagePath}"`, "user"), { type: "image_available", id: "att-u-0" }, text("a", "答え"),
    ]);
    expect(h.images()).toHaveLength(0);
  });

  test.each(["timeout", "cancel"])("対象サムネが終わらない場合の %s はページ全体を失敗にし、後着成功を返さない", async (reason) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = fixture();
    const imagePath = path.join(makeTempDir("page-never-image"), "a.png");
    fs.writeFileSync(imagePath, "image");
    fs.writeFileSync(f.file, record("u", "user", `@"${imagePath}"`) + "\n");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const thumbnailer = vi.fn(async () => { await pending; return { thumbnailBase64: "QQ==", width: 1, height: 1 }; });
    const service = new ImageService({ indexBase: makeTempDir("page-never-index"), thumbnailer });
    const opened: Array<number | null | undefined> = [];
    const h = makeHub((write) => {
      const controller = new ChatTailController({ writer: writer(write), projectsRoot: f.root, imageService: service,
        tailer: new TranscriptTailer({ emitReplayDoneMarker: true }), subagentTailer: { async *streamProjectDir() {} } as never });
      const open = controller.open.bind(controller);
      // 引数を観測するだけで、通常購読の open 自体は本物を使う。
      controller.open = (...args) => { opened.push(args[2]); open(...args); };
      return controller;
    }, service, f.cwd);
    h.send("conversation_history_page_request", { id: "p", limit: 24 });
    await vi.waitFor(() => expect(thumbnailer).toHaveBeenCalledOnce());
    expect(h.pages()).toHaveLength(0);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(9000);
    else h.send("conversation_unsubscribe");
    await vi.waitFor(() => expect(h.pages()).toHaveLength(1));
    expect(h.pages()[0]).toMatchObject({ failed: true, lines: [] });
    expect((h.hub as any).historyPageReads.size).toBe(0);
    expect((h.hub as any).historyPageRequests.size).toBe(0);
    // iOS が nil と扱った後の全履歴購読を再現する。ページの本文を部分適用していない。
    h.send("conversation_subscribe", { preview: true });
    expect(opened).toEqual([null]);
    release();
    await vi.waitFor(() => expect(h.received).toContainEqual(expect.objectContaining({
      type: "conversation_event", payload: expect.objectContaining({ streamId: "pc:history-done" }),
    })));
    expect(thumbnailer).toHaveBeenCalledOnce();
    expect(h.pages()).toHaveLength(1);
    expect(h.images()).toMatchObject([{ id: "att-u-0" }]);
    h.send("conversation_unsubscribe");
  });

  test("旧 factory が生成済みの画像を含む場合は、従来の切り出しへそのまま落とす", async () => {
    const image: ControlMessage = { type: "image_available", v: 1, id: "custom-image", path: "/tmp/image.png",
      mime: "image/png", thumbnail: "QQ==", width: 1, height: 1 };
    const all = [text("u", '@"/tmp/image.png"', "user"), image, text("a")];
    const service = new ImageService({ indexBase: makeTempDir("legacy-image-index"), thumbnailer: async () => { throw new Error("再生成しない"); } });
    expect(await new HistoryPageImages(all, service).slice(null, 24, new AbortController().signal))
      .toEqual(sliceHistoryPage(all, null, 24));
  });
});

describe("ページと購読の境界・取消", () => {
  test("再生中の追記と EOF 後の追記は、ページと差分購読の合流で欠落・重複しない", async () => {
    const f = fixture();
    fs.writeFileSync(f.file, Array.from({ length: 45 }, (_, i) => record(`a${i}`, "assistant", `行${i}`, { timestamp: new Date(Date.now() - 10000).toISOString() })).join("\n") + "\n");
    let appended = false;
    let liveWrite!: (event: ControlMessage) => void;
    const h = makeHub((write) => {
      liveWrite = write;
      const controller = new ChatTailController({ writer: writer((event) => {
        write(event);
        if (!appended && event.type === "chat_output" && event.streamId === "a5") {
          appended = true;
          fs.appendFileSync(f.file, record("during", "assistant", "読取中") + "\n");
        }
      }), tailer: new TranscriptTailer({ emitReplayDoneMarker: true }), projectsRoot: f.root,
      subagentTailer: { async *streamProjectDir() {} } as never });
      return controller;
    }, undefined, f.cwd);
    h.send("conversation_history_page_request", { id: "page", limit: 24 });
    await vi.waitFor(() => expect(h.pages()).toHaveLength(1));
    const page = h.pages()[0]!;
    const initial = page.lines.map(decodeControlMessage);
    expect(initial).toContainEqual(text("during", "読取中"));
    fs.appendFileSync(f.file, record("after", "assistant", "読取後") + "\n");
    h.send("conversation_subscribe", { newerThanMs: page.hostNowMs - 5000, preview: true });
    await vi.waitFor(() => expect(h.received).toContainEqual(expect.objectContaining({
      type: "conversation_event", payload: expect.objectContaining({ streamId: "pc:history-done" }),
    })));
    const merged = new Map<string, string>();
    for (const event of [...initial, ...h.received.flatMap((m) => m.type === "conversation_event" ? [m.payload] : [])]) {
      if (event.type === "chat_output" && !event.streamId.startsWith("pc:")) merged.set(event.streamId, event.text);
    }
    const expected = sliceHistoryPage(await collect(new TranscriptTailer().streamTranscript(f.file)), null, 25).events;
    expect([...merged.entries()]).toEqual(expected.flatMap((e) => e.type === "chat_output" ? [[e.streamId, e.text]] : []));
    expect([...merged.keys()].filter((id) => id === "during")).toHaveLength(1);
    // 共有 tail の通知を使い続ける（ページが live の serverSeq を消費しない）。
    liveWrite(text("live"));
    expect(h.received.at(-1)).toMatchObject({ type: "conversation_event", payload: { streamId: "live" } });
    h.send("conversation_unsubscribe");
  });

  test.each(["claude", "codex", "compressed"])("実ファイル %s の取消は fd / 展開ストリームを閉じ、続きの本文を出さない", async (kind) => {
    const f = fixture();
    const codexRoot = makeTempDir("page-abort-rollout");
    const rollout = path.join(codexRoot, "rollout-abort.jsonl");
    const records = kind === "claude"
      ? Array.from({ length: 100 }, (_, i) => record(`a${i}`, "assistant", `本文${i}`))
      : [JSON.stringify({ type: "session_meta", payload: { cwd: f.cwd, id: "provider" } }),
        ...Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `本文${i}` } }))];
    const data = records.join("\n") + "\n";
    const target = kind === "claude" ? f.file : kind === "codex" ? rollout : rollout + ".zst";
    fs.writeFileSync(target, kind === "compressed" ? zlib.zstdCompressSync(Buffer.from(data)) : data);
    const controller = new AbortController();
    const emitted: ControlMessage[] = [];
    const tail = new ChatTailController({ writer: writer((event) => {
      emitted.push(event);
      if (event.type === "chat_output") controller.abort(new Error("stop-page"));
    }), tailer: new TranscriptTailer(), codexTailer: new CodexRolloutTailer({ sessionsRoot: codexRoot }), projectsRoot: f.root });
    await expect(tail.readHistory(f.cwd, "provider", kind === "claude" ? "claude" : "codex", controller.signal)).rejects.toThrow("stop-page");
    expect(emitted).toHaveLength(1);
    if (kind === "compressed") {
      const calls = vi.mocked(fs.createReadStream).mock.calls;
      const index = calls.findLastIndex(([p]) => p === target);
      const stream = vi.mocked(fs.createReadStream).mock.results[index]!.value;
      await vi.waitFor(() => expect(stream.closed).toBe(true));
    } else {
      const calls = vi.mocked(fs.openSync).mock.calls;
      const index = calls.findLastIndex(([p]) => p === target);
      const fd = vi.mocked(fs.openSync).mock.results[index]!.value;
      expect(fs.closeSync).toHaveBeenCalledWith(fd);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(emitted).toHaveLength(1);
  });

  test.each(["timeout", "subscribe", "switch", "retire", "unsubscribe", "disconnect", "close"])("%s で最後の読み手を止め、読み取りを管理表へ残さない", async (kind) => {
    vi.useFakeTimers();
    let aborted = false;
    let openedWhileReading = false;
    const h = makeHub(() => ({
      readHistory: async (_cwd, _id, _agent, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      }),
      open() { openedWhileReading = !aborted; }, stop() {},
    }));
    h.send("conversation_history_page_request", { id: "p", limit: 24 });
    await Promise.resolve();
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(9000);
    if (kind === "subscribe") h.send("conversation_subscribe");
    if (kind === "switch") h.send("conversation_subscribe", { session: "other", preview: true });
    if (kind === "retire") h.send("session_retire");
    if (kind === "unsubscribe") h.send("conversation_unsubscribe");
    if (kind === "disconnect") h.hub.unregisterClient(h.client);
    if (kind === "close") h.hub.close();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(aborted).toBe(true);
    expect(openedWhileReading).toBe(false);
    expect((h.hub as any).historyPageReads.size).toBe(0);
    if (kind === "timeout") expect(h.pages()[0]).toMatchObject({ failed: true });
  });

  test("前面化ではない背景購読の追加は、ページを待つ読み手を取り消さない", async () => {
    let finish!: () => void;
    let aborted = false;
    const h = makeHub((write) => ({ async readHistory(_cwd, _id, _agent, signal) {
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      });
      write(text("a"));
    }, open() {}, stop() {} }));
    h.send("conversation_history_page_request", { id: "p", limit: 24 });
    await Promise.resolve();
    h.send("conversation_subscribe", { preview: false });
    expect(aborted).toBe(false);
    finish();
    await vi.waitFor(() => expect(h.pages()).toHaveLength(1));
    expect(h.pages()[0]).not.toHaveProperty("failed");
    h.send("conversation_unsubscribe");
  });

  test("同じ会話の要求は共有し、一方の切断は他方の読取を止めない", async () => {
    let finish!: () => void;
    let cancelled = false;
    const readHistory = vi.fn(async (_cwd, _id, _agent, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    }));
    const h = makeHub(() => ({ readHistory, open() {}, stop() {} }));
    const other = {}, otherReceived: HubServerMessage[] = [];
    h.hub.registerClient(other, (line) => { const message = decodeHubServerLine(line); if (message) otherReceived.push(message); });
    h.send("conversation_history_page_request", { id: "a", limit: 24 });
    h.hub.handleClientMessage(other, JSON.stringify({ type: "conversation_history_page_request", id: "b", session: "work", limit: 24 }));
    await Promise.resolve();
    h.hub.unregisterClient(h.client);
    expect(cancelled).toBe(false);
    finish();
    await vi.waitFor(() => expect(otherReceived).toContainEqual(expect.objectContaining({ type: "conversation_history_page_response", id: "b" })));
    expect(readHistory).toHaveBeenCalledOnce();
    expect((h.hub as any).historyPageReads.size).toBe(0);
  });
});
