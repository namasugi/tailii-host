// HEAD の全画像確定と、同じ履歴キャッシュからの連続ページ取得を比較する。
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatTailController, type ChatAgent } from "../src/chat/chatTailController.js";
import { TranscriptTailer } from "../src/chat/transcriptTailer.js";
import { CodexRolloutTailer } from "../src/codex/codexRolloutTailer.js";
import { ImageService, readImagePath, type Thumbnailer } from "../src/chat/imageService.js";
import { HistoryPageImages } from "../src/hub/historyPageImages.js";
import { sliceHistoryPage, type HistoryPageAnchor } from "../src/hub/historyPage.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { decodeHubServerLine, type HubServerMessage } from "../src/hub/hubProtocol.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { LineWriter } from "../src/shared/lineWriter.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const hubs: SessionHub[] = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.close(); });

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const record = (id: string, role: "user" | "assistant", content: unknown, extra: object = {}) =>
  JSON.stringify({ type: role, uuid: id, timestamp: new Date().toISOString(), message: { role, content }, ...extra });
const tool = (id: string, file: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: file } });
function files() {
  const root = makeTempDir("page-image-compare");
  const a = path.join(root, "a.png"), b = path.join(root, "b.jpg"), c = path.join(root, "c.png");
  for (const file of [a, b, c]) fs.writeFileSync(file, path.basename(file));
  return { a, b, c, missing: path.join(root, "missing.png") };
}
function thumbnail(imagePath: string) {
  return { thumbnailBase64: Buffer.from(path.basename(imagePath)).toString("base64"), width: 8, height: 6 };
}

// git show HEAD:src/chat/chatTailController.ts で確認した画像生成部分の参照実装。
// open() / openCodex() と同じく、全画像を発話順に確定してから Hub の切り出しへ渡す。
// ページ選択器も作業ツリーの通常 open() も使わず、失敗した画像はイベント列に残さない。
async function headImageReplay(body: readonly ControlMessage[], service: ImageService): Promise<ControlMessage[]> {
  const events: ControlMessage[] = [];
  const attached = new Set<string>();
  for (const event of body) {
    events.push(event);
    if (event.type === "chat_output" && event.role === "user") {
      for (const image of await service.makeAttachmentsAvailable(event.text, event.streamId)) {
        attached.add(image.path);
        events.push(image);
      }
    } else if (event.type === "tool_activity") {
      const imagePath = readImagePath(event.activity);
      if (imagePath !== null && !attached.has(imagePath)) {
        const image = await service.makeAvailable(imagePath, `read-${event.activity.id}`);
        if (image !== null) events.push(image);
      }
    }
  }
  return events;
}
function fixture(agent: ChatAgent, records: string[]) {
  const cwd = makeTempDir("page-compare-cwd");
  const root = makeTempDir("page-compare-projects");
  const codexRoot = makeTempDir("page-compare-rollouts");
  const dir = path.join(root, claudeProjectSlug(cwd));
  fs.mkdirSync(dir);
  const file = agent === "claude" ? path.join(dir, "provider.jsonl") : path.join(codexRoot, "rollout-compare.jsonl");
  const lines = agent === "claude" ? records : [JSON.stringify({ type: "session_meta", payload: { id: "provider", cwd } }), ...records];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const service = (thumbnailer: Thumbnailer = async (p) => thumbnail(p)) => new ImageService({
    indexBase: makeTempDir("page-compare-index"), thumbnailer,
  });
  const controller = (write: (event: ControlMessage) => void, imageService: ImageService) => new ChatTailController({
    writer: new LineWriter(new Writable({ write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split("\n")) write(decodeControlMessage(line));
      callback();
    } })),
    tailer: new TranscriptTailer({ emitReplayDoneMarker: true }),
    codexTailer: new CodexRolloutTailer({ sessionsRoot: codexRoot, emitReplayDoneMarker: true }),
    subagentTailer: { async *streamProjectDir() {} } as never,
    projectsRoot: root, imageService,
  });
  const run = async (legacy: boolean, imageService: ImageService): Promise<ControlMessage[]> => {
    const events: ControlMessage[] = [];
    let done!: () => void;
    const completed = new Promise<void>((resolve) => { done = resolve; });
    const tail = controller((event) => {
      events.push(event);
      if (event.type === "chat_output" && event.streamId === "pc:history-done") done();
    }, imageService);
    try {
      if (legacy) { tail.open(cwd, "provider", null, agent); await completed; }
      else await tail.readHistory(cwd, "provider", agent, new AbortController().signal);
    } finally {
      tail.stop();
      await tick();
    }
    return events;
  };
  return { cwd, controller, service, full: async (s = service()) => headImageReplay(await run(false, s), s),
    legacy: () => run(true, service()), body: () => run(false, service()),
    withoutFinalNewline: () => { const data = fs.readFileSync(file); fs.writeFileSync(file, data.subarray(0, data.length - 1)); },
    compress: () => { fs.writeFileSync(file + ".zst", zlib.zstdCompressSync(fs.readFileSync(file))); fs.unlinkSync(file); } };
}
async function comparePages(full: ControlMessage[], body: ControlMessage[], service: () => ImageService, anchors: Array<HistoryPageAnchor | null>) {
  const images = new HistoryPageImages(body, service());
  for (const anchor of anchors) {
    for (const limit of [1, 2, 3, 24]) {
      const actual = await images.slice(anchor, limit, new AbortController().signal);
      expect(actual, JSON.stringify({ anchor, limit })).toEqual(sliceHistoryPage(full, anchor, limit));
    }
  }
}

const sequences = ["attachment-fails", "attachment-succeeds", "reread", "read-before-attachment",
  "failed-read-before-attachment", "three-pages", "reused-id"] as const;
type Sequence = typeof sequences[number];
function pageRecords(sequence: Sequence, p: ReturnType<typeof files>): string[] {
  let gap = 0;
  const between = () => Array.from({ length: 30 }, () => record(`gap${gap++}`, "assistant", "間の本文"));
  const attachment = (id = "u") => record(id, "user", `@"${p.a}"`);
  const read = (id: string, imagePath = p.a) => record(`tool-${id}-${gap}`, "assistant", [tool(id, imagePath)]);
  const end = record("end", "assistant", "終わり");
  switch (sequence) {
    case "attachment-fails": case "attachment-succeeds":
      return [attachment(), ...between(), read("r"), end];
    case "reread":
      return [read("r1"), ...between(), read("r2"), end];
    case "read-before-attachment": case "failed-read-before-attachment":
      return [read("r1"), ...between(), attachment(), end];
    case "three-pages":
      return [attachment(), ...between(), read("r1"), ...between(), read("r2"), ...between(), attachment("u2"), end];
    case "reused-id":
      return [attachment(), ...between(), read("same"), ...between(), read("same", p.b), end];
  }
}
function codexRecords(records: string[]): string[] {
  return records.map((line) => {
    const entry = JSON.parse(line);
    const content = entry.message.content;
    if (entry.type === "user") return JSON.stringify({ type: "event_msg", payload: {
      type: "user_message", client_id: entry.uuid, message: content,
    } });
    if (Array.isArray(content)) return JSON.stringify({ type: "event_msg", payload: {
      type: "item_completed", item: { type: "ImageView", id: content[0].id, path: content[0].input.file_path },
    } });
    return JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", id: entry.uuid,
      content: [{ type: "output_text", text: content }] } });
  });
}

describe("同じ Hub の最新24行から過去ページへ遡っても HEAD の確定結果を保つ", () => {
  test.each((["claude", "codex", "codex-zst"] as const).flatMap((kind) => sequences.map((sequence) => ({ kind, sequence }))))(
    "$kind / $sequence", async ({ kind, sequence }) => {
      const p = files();
      const records = pageRecords(sequence, p);
      const f = fixture(kind === "claude" ? "claude" : "codex", kind === "claude" ? records : codexRecords(records));
      if (kind === "codex-zst") f.compress();
      const makeService = () => {
        const attempts = new Map<string, number>();
        const service = f.service(async (imagePath) => {
          const attempt = (attempts.get(imagePath) ?? 0) + 1;
          attempts.set(imagePath, attempt);
          const failFirst = ["attachment-fails", "failed-read-before-attachment", "three-pages", "reused-id"].includes(sequence);
          return failFirst && imagePath === p.a && attempt === 1 ? null : thumbnail(imagePath);
        });
        return { service, generate: vi.spyOn(service, "makeAvailable") };
      };
      // 参照側は一度だけ全画像を発話順に生成し、その固定イベント列から全ページを返す。
      const reference = makeService();
      const full = await f.full(reference.service);
      const actual = makeService();
      const store = makeTempStore();
      store.put({ name: "work", cwd: f.cwd, createdAt: 0, providerSessionId: "provider",
        agent: kind === "claude" ? "claude" : "codex" });
      const readHistory = vi.fn();
      const hub = new SessionHub({ runner: async () => ok(""), metadataStore: store,
        heartbeatDir: makeTempDir("page-series-heartbeat"), timeoutSeconds: 1800, imageService: actual.service,
        tailFactory: (write) => {
          const tail = f.controller(write, actual.service);
          const read = tail.readHistory.bind(tail);
          tail.readHistory = (...args) => { readHistory(); return read(...args); };
          return tail;
        },
      });
      hubs.push(hub);
      const client = {};
      const responses: Extract<HubServerMessage, { type: "conversation_history_page_response" }>[] = [];
      hub.registerClient(client, (line) => {
        const message = decodeHubServerLine(line);
        if (message?.type === "conversation_history_page_response") responses.push(message);
      });
      const request = async (anchor: HistoryPageAnchor | null) => {
        const id = `page-${responses.length}`;
        hub.handleClientMessage(client, JSON.stringify({ type: "conversation_history_page_request", id, session: "work", limit: 24,
          ...(anchor?.streamId !== undefined ? { beforeStreamId: anchor.streamId } : {}),
          ...(anchor?.toolId !== undefined ? { beforeToolId: anchor.toolId } : {}),
        }));
        await vi.waitFor(() => expect(responses.some((response) => response.id === id)).toBe(true));
        const response = responses.find((response) => response.id === id)!;
        const expected = sliceHistoryPage(full, anchor, 24);
        expect(response.failed).toBeUndefined();
        expect(response.lines.map(decodeControlMessage)).toEqual(expected.events);
        expect(response.hasMore).toBe(expected.hasMore);
        return expected;
      };
      let page = await request(null);
      if (sequence === "attachment-fails") {
        expect(page.events.filter((e) => e.type === "image_available")).toMatchObject([{ id: expect.stringContaining("read-") }]);
      }
      let count = 1;
      while (page.hasMore) {
        expect(++count).toBeLessThan(10);
        const first = page.events.find((e) => e.type === "tool_activity" || (e.type === "chat_output" && !e.streamId.startsWith("pc:")));
        expect(first).toBeDefined();
        const anchor = first!.type === "tool_activity" ? { toolId: first!.activity.id }
          : { streamId: (first as Extract<ControlMessage, { type: "chat_output" }>).streamId };
        page = await request(anchor);
        // 同じページの再取得も同じキャッシュ・同じサービスのまま行う。
        expect(await request(anchor)).toEqual(page);
      }
      expect(count).toBeGreaterThan(1);
      expect(readHistory).toHaveBeenCalledOnce();
      expect(actual.generate.mock.calls).toEqual(reference.generate.mock.calls);
      hub.unregisterClient(client);
    },
  );
});

test.each([false, true])("同時取得の片方を取消しても画像の確定は一度だけ（全画像生成=%s）", async (fullReplay) => {
  const p = files();
  const f = fixture("claude", [record("u", "user", `@"${p.a}"`), record("separator", "assistant", "境界"),
    record("a", "assistant", [tool("r", p.a)]), record("end", "assistant", "最新"),
    ...(fullReplay ? [record("b", "assistant", [tool("r", p.b)]), record("last", "assistant", "最後")] : [])]);
  const body = await f.body();
  let first = true;
  const reference = f.service(async (imagePath) => {
    if (first) { first = false; return null; }
    return thumbnail(imagePath);
  });
  const referenceGenerate = vi.spyOn(reference, "makeAvailable");
  const full = await headImageReplay(body, reference);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  first = true;
  const service = f.service(async (imagePath) => {
    if (first) { first = false; await pending; return null; }
    return thumbnail(imagePath);
  });
  const generate = vi.spyOn(service, "makeAvailable");
  const images = new HistoryPageImages(body, service);
  const cancelled = new AbortController();
  const latest = images.slice(null, 2, cancelled.signal);
  // 取消された Promise の拒否を直ちに受け取る。
  const rejected = expect(latest).rejects.toThrow("離脱");
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
  const anchor = { streamId: "separator" };
  const older = images.slice(anchor, 24, new AbortController().signal);
  await tick();
  expect(generate).toHaveBeenCalledOnce();
  cancelled.abort(new Error("離脱"));
  await rejected;
  release();
  expect(await older).toEqual(sliceHistoryPage(full, anchor, 24));
  if (!fullReplay) expect(generate).toHaveBeenCalledOnce();
  expect(await images.slice(null, 2, new AbortController().signal)).toEqual(sliceHistoryPage(full, null, 2));
  expect(await images.slice(anchor, 24, new AbortController().signal)).toEqual(sliceHistoryPage(full, anchor, 24));
  expect(generate.mock.calls).toEqual(referenceGenerate.mock.calls);
  if (fullReplay) expect(await service.fetch("read-r")).toEqual(await reference.fetch("read-r"));
});

describe("従来の全画像再生と同じページ", () => {
  test("Claude: 添付の連番欠け、Read 抑止と再 Read、集約・後着更新・narration・compact・長い行", async () => {
    const p = files();
    const signature = Buffer.from([0x12, 13, 0x0a, 11, 0x42, 9, ...Buffer.from("narration")]).toString("base64");
    const f = fixture("claude", [
      record("u", "user", `@"${p.a}" @"${p.missing}" @"${p.b}"`),
      record("tools", "assistant", [tool("attached", p.a), tool("r1", p.c),
        { type: "tool_use", id: "skill", name: "Skill", input: { skill: "demo" } },
        { type: "tool_use", id: "agent", name: "Agent", input: { prompt: "調査", description: "調査" } }]),
      record("n", "assistant", [{ type: "thinking", thinking: "経過", signature }], { effort: "high",
        message: { role: "assistant", model: "claude-test", usage: { input_tokens: 100 }, content: [{ type: "thinking", thinking: "経過", signature }] } }),
      record("skill-body", "user", "Base directory for this skill: /tmp/demo\n内容", { isMeta: true, sourceToolUseID: "skill" }),
      record("reread", "assistant", [tool("r2", p.c)]),
      record("long", "assistant", "あ".repeat(100000)),
      // 元のカードがページの外にあっても、従来の画像イベントの位置を保つ。
      record("update", "assistant", [tool("r1", p.c)]),
      JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "compact", compactMetadata: { trigger: "auto" } }),
      record("summary", "user", "内部要約", { isCompactSummary: true }),
      record("end", "assistant", "完了"),
    ]);
    const full = await f.full();
    const body = await f.body();
    await comparePages(full, body, f.service, [null, { streamId: "u" }, { streamId: "n" }, { streamId: "long" },
      { streamId: "compact" }, { streamId: "end" }, { toolId: "r1" }, { toolId: "skill" }, { streamId: "missing" }]);
    const images = full.filter((e) => e.type === "image_available");
    expect(images.map((e) => e.id)).toEqual(["att-u-0", "att-u-2", "read-r1", "read-r2", "read-r1"]);
  });

  test("同じパスの先行 Read の失敗・添付の成功・添付失敗後の Read も従来と一致する", async () => {
    const p = files();
    const f = fixture("claude", [record("early", "assistant", [tool("early-read", p.a)]),
      record("separator", "assistant", "前置き"), record("ua", "user", `@"${p.a}"`), record("after-a", "assistant", "後"),
      record("read-a", "assistant", [tool("attached-read", p.a)]), record("ub", "user", `@"${p.b}"`),
      record("read-b", "assistant", [tool("retry-read", p.b)]), record("end", "assistant", "完了")]);
    const makeService = () => {
      const attempts = new Map<string, number>();
      return f.service(async (imagePath) => {
        const attempt = (attempts.get(imagePath) ?? 0) + 1;
        attempts.set(imagePath, attempt);
        return attempt === 1 ? null : thumbnail(imagePath);
      });
    };
    const full = await f.full(makeService());
    const body = await f.body();
    await comparePages(full, body, makeService, [null, { streamId: "after-a" }, { streamId: "ub" }, { streamId: "end" }]);
    expect(full.filter((e) => e.type === "image_available").map((e) => e.id)).toEqual(["att-ua-0", "read-retry-read"]);
  });

  test("ページ外の別パスの画像は未完了でも生成を呼ばず、従来のページ内容を返す", async () => {
    const p = files();
    const f = fixture("claude", [record("old", "user", `@"${p.a}"`), record("middle", "assistant", "過去"),
      record("new", "user", `@"${p.b}"`), record("end", "assistant", "最新")]);
    const full = await f.full();
    const body = await f.body();
    const thumbnailer = vi.fn(async (imagePath: string) => imagePath === p.a
      ? new Promise<never>(() => {}) : thumbnail(imagePath));
    const actual = await new HistoryPageImages(body, f.service(thumbnailer)).slice(null, 2, new AbortController().signal);
    expect(actual).toEqual(sliceHistoryPage(full, null, 2));
    expect(thumbnailer.mock.calls.map(([p]) => p)).toEqual([p.b]);
  });

  test("画像 ID が別パスに再利用された記録は、全画像を従来順に生成し fetch の逆引きも保つ", async () => {
    const p = files();
    const f = fixture("claude", [record("first", "assistant", [tool("same-id", p.a)]),
      record("middle", "assistant", "中間"), record("second", "assistant", [tool("same-id", p.b)]),
      record("end", "assistant", "最新")]);
    const legacyService = f.service();
    const full = await f.full(legacyService);
    const body = await f.body();
    const thumbnailer = vi.fn(async (imagePath: string) => thumbnail(imagePath));
    const service = f.service(thumbnailer);
    const actual = await new HistoryPageImages(body, service).slice(null, 1, new AbortController().signal);
    expect(actual).toEqual(sliceHistoryPage(full, null, 1));
    expect(thumbnailer.mock.calls.map(([p]) => p)).toEqual([p.a, p.b]);
    expect(await service.fetch("read-same-id")).toEqual(await legacyService.fetch("read-same-id"));
  });

  test.each([false, true])("Codex の改行の無い最終行（mirror=%s）も従来の EOF と同じに扱う", async (mirror) => {
    const p = files();
    const records = [JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: "user", message: `@"${p.a}"` } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "末尾の応答", phase: "final_answer" } })];
    if (mirror) records.push(JSON.stringify({ type: "response_item", payload: { type: "message", id: "assistant", role: "assistant",
      phase: "final_answer", content: [{ type: "output_text", text: "末尾の応答" }] } }));
    const f = fixture("codex", records);
    f.withoutFinalNewline();
    const full = await f.full();
    // EOF の本文変換についても、通常 tail との従来の比較を残す。
    expect(sliceHistoryPage(full, null, 24)).toEqual(sliceHistoryPage(await f.legacy(), null, 24));
    await comparePages(full, await f.body(), f.service, [null]);
    f.compress();
    await comparePages(full, await f.body(), f.service, [null]);
  });

  test.each([false, true])("Codex 平文／圧縮=%s: user alias・assistant mirror・画像閲覧と再閲覧のページが一致する", async (compressed) => {
    const p = files();
    const event = (payload: object) => JSON.stringify({ type: "event_msg", payload });
    const f = fixture("codex", [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
      ...Array.from({ length: 28 }, (_, i) => event({ type: "agent_message", message: `過去${i}` })),
      event({ type: "item_completed", item: { type: "UserMessage", id: "user-item", client_id: "client", content: [{ type: "text", text: `@"${p.a}"` }] } }),
      event({ type: "agent_message", message: "応答", phase: "final_answer" }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "assistant-item", role: "assistant",
        phase: "final_answer", content: [{ type: "output_text", text: "応答" }] } }),
      event({ type: "item_completed", item: { type: "ImageView", id: "view-attached", path: p.a } }),
      event({ type: "item_completed", item: { type: "ImageView", id: "view", path: p.b } }),
      event({ type: "item_completed", item: { type: "ImageView", id: "reread", path: p.b } }),
      event({ type: "token_count", info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 200000 } }),
    ]);
    const full = await f.full();
    if (compressed) f.compress();
    const body = await f.body();
    const tools = body.flatMap((e) => e.type === "tool_activity" ? [e.activity.id] : []);
    expect(tools.length).toBeGreaterThan(0);
    await comparePages(full, body, f.service, [null, { streamId: "codex-item-user-item" },
      { streamId: "codex-item-assistant-item" }, ...tools.map((toolId) => ({ toolId }))]);
    expect(full.filter((e) => e.type === "image_available")).toHaveLength(3);
  });
});
