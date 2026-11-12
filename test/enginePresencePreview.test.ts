// enginePresencePreview.test.ts — アプリの背景中は画面プレビューだけを止める。
import { afterEach, describe, expect, test, vi } from "vitest";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import type { HubLink } from "../src/hub/hubClient.js";
import type { HubClientMessage } from "../src/hub/hubProtocol.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { makeTempStore, MockTmuxRunner, ok, startEngine } from "./helpers.js";

const DEVICE_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const engines: ReturnType<typeof startEngine>[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.teardown();
});

function preview(session: string, seq: number): Extract<ControlMessage, { type: "pane_preview" }> {
  return { type: "pane_preview", v: 2, session, seq, active: true, text: `${session}:${seq}` };
}

async function setup() {
  const store = makeTempStore();
  for (const name of ["work", "other"]) {
    store.put({ name, cwd: `/tmp/${name}`, createdAt: 1, agent: "claude" });
  }
  const send = vi.fn((message: HubClientMessage): boolean => {
    if (message.type === "hub_state_request") queueMicrotask(() => hubLink.onMessage?.({
      type: "hub_state_response", id: message.id, session: message.session,
      pendingQuestion: null, processing: false,
    }));
    return true;
  });
  const hubLink: HubLink = { onMessage: null, onReconnect: null, send, close: vi.fn() };
  const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("work\nother\n") : ok(""));
  const engine = startEngine({
    sessionManager: new TmuxSessionManager({ runner: runner.runner, store }), metadataStore: store, hubLink,
  });
  engines.push(engine);
  await engine.lines.nextOfType("channel_hello");
  engine.writeLine(JSON.stringify({ type: "session_reattach", v: 2, id: "open", name: "work" }));
  await engine.lines.nextOfType("session_list_response");

  let probe = 0;
  // 応答のある要求までの出力をすべて回収し、「出なかった」こともタイムアウト無しで検証する。
  const drain = async (): Promise<ControlMessage[]> => {
    const id = `probe-${++probe}`;
    engine.writeLine(JSON.stringify({ type: "image_fetch_request", v: 2, id }));
    const output: ControlMessage[] = [];
    for (;;) {
      const message = decodeControlMessage(await engine.lines.next());
      if (message.type === "error" && message.id === id) return output;
      output.push(message);
    }
  };
  const presence = (state: "foreground" | "background") => engine.writeLine(JSON.stringify({
    type: "client_presence", v: 2, deviceId: DEVICE_ID, state,
  }));
  const watch = (enabled: boolean) => engine.writeLine(JSON.stringify({ type: "session_preview_watch", v: 2, enabled }));
  const emitPreview = (payload: ReturnType<typeof preview>) => hubLink.onMessage?.({
    type: "conversation_pane_preview", session: payload.session, payload,
  });
  const watchMessages = () => send.mock.calls.map(([message]) => message)
    .filter((message) => message.type === "session_preview_watch");
  await drain();
  send.mockClear();
  return { engine, hubLink, send, drain, presence, watch, emitPreview, watchMessages };
}

describe("EngineControl — 在席による画面プレビューの抑止", () => {
  test("背景申告は一覧 watch を 1 回止め、プレビュー以外と在席の中継を維持する", async () => {
    const h = await setup();
    h.watch(true);
    h.presence("foreground");
    await h.drain();
    h.send.mockClear();
    h.presence("background");
    h.presence("background");
    await h.drain();
    expect(h.watchMessages()).toEqual([{ type: "session_preview_watch", enabled: false }]);
    expect(h.send.mock.calls.filter(([message]) => message.type === "client_presence")).toEqual([
      [{ type: "client_presence", deviceId: DEVICE_ID.toUpperCase(), state: "background" }],
      [{ type: "client_presence", deviceId: DEVICE_ID.toUpperCase(), state: "background" }],
    ]);

    h.emitPreview(preview("work", 1));
    h.emitPreview(preview("other", 1)); // watch 停止直前に hub が送っていたフレームも漏らさない。
    const chat: ControlMessage = {
      type: "chat_output", v: 2, streamId: "reply", role: "assistant", text: "応答", eof: true,
    };
    h.hubLink.onMessage?.({ type: "conversation_event", session: "work", serverSeq: 1, payload: chat });
    const tool: ControlMessage = {
      type: "tool_activity", v: 2, activity: {
        id: "tool-1", name: "Bash", label: "テストを実行", commandTruncated: false, descriptionTruncated: false,
      },
    };
    h.hubLink.onMessage?.({ type: "conversation_event", session: "work", serverSeq: 2, payload: tool });
    for (const type of ["input_suggestion", "input_residue"] as const) {
      h.hubLink.onMessage?.({ type: "conversation_pane_preview", session: "work",
        payload: { type, v: 2, session: "work", text: type } });
    }
    h.hubLink.onMessage?.({ type: "question_event", session: "work", event: "prompt", id: "q1",
      questions: [{ header: "選択", question: "続けますか", options: [], multiSelect: false }] });
    h.hubLink.onMessage?.({ type: "session_processing", session: "work", state: "active" });
    h.hubLink.onMessage?.({ type: "conversation_liveness", session: "other", alive: false });
    h.hubLink.onMessage?.({ type: "presence_ping", id: "ping" });
    const output = await h.drain();
    expect(output.map((message) => message.type)).toEqual([
      "chat_output", "tool_activity", "input_suggestion", "input_residue", "question_prompt",
      "session_processing_state", "session_liveness_event", "presence_ping",
    ]);
    expect(output[0]).toEqual(chat);
    expect(output[1]).toEqual(tool);
    expect(output.at(-1)).toEqual({ type: "presence_ping", v: 2, id: "ping" });
    h.engine.writeLine(JSON.stringify({ type: "presence_pong", v: 2, id: "ping" }));
    await h.drain();
    expect(h.send).toHaveBeenCalledWith({ type: "presence_pong", id: "ping" });
  });

  test("前面復帰で各会話の最新 1 枚を送り、一覧 watch と通常転送を再開する", async () => {
    const h = await setup();
    h.watch(true);
    h.presence("background");
    await h.drain();
    h.send.mockClear();
    h.emitPreview(preview("work", 1));
    h.emitPreview(preview("other", 1));
    h.emitPreview(preview("work", 2));
    const latest = { ...preview("other", 3), mode: "codex_terminal" as const };
    h.emitPreview(latest);
    expect(await h.drain()).toEqual([]);

    h.presence("foreground");
    expect(await h.drain()).toEqual([preview("work", 2), latest]);
    expect(h.watchMessages()).toEqual([{ type: "session_preview_watch", enabled: true }]);
    h.presence("foreground");
    expect(await h.drain()).toEqual([]);
    expect(h.watchMessages()).toHaveLength(1);
    h.emitPreview(preview("work", 4));
    h.emitPreview(preview("other", 4));
    expect(await h.drain()).toEqual([preview("work", 4), preview("other", 4)]);

    // 次の背景期間に更新が無ければ前回の保存分は再送しない。
    h.presence("background");
    h.presence("foreground");
    expect(await h.drain()).toEqual([]);
  });

  test("一覧 watch を望まない接続でも開いている会話の最新画面を復帰時に送る", async () => {
    const h = await setup();
    h.presence("background");
    await h.drain();
    h.emitPreview(preview("work", 1));
    h.emitPreview(preview("work", 2));
    h.emitPreview(preview("other", 1)); // 一覧 watch がない他会話は従来どおり対象外。
    expect(await h.drain()).toEqual([]);
    h.presence("foreground");
    expect(await h.drain()).toEqual([preview("work", 2)]);
    expect(h.watchMessages()).toEqual([]);
    h.emitPreview(preview("work", 3));
    expect(await h.drain()).toEqual([preview("work", 3)]);
  });

  test.each([false, true])("背景中は有効化を保留し、無効化は即時転送する（復帰時の希望値=%s）", async (desired) => {
    const h = await setup();
    h.presence("background");
    h.watch(true);
    await h.drain();
    expect(h.watchMessages()).toEqual([]);
    h.watch(false);
    await h.drain();
    expect(h.watchMessages()).toEqual([{ type: "session_preview_watch", enabled: false }]);
    if (desired) h.watch(true);
    await h.drain();
    expect(h.watchMessages()).toHaveLength(1);
    h.send.mockClear();
    h.presence("foreground");
    await h.drain();
    expect(h.watchMessages()).toEqual(desired ? [{ type: "session_preview_watch", enabled: true }] : []);
  });

  test("在席未申告なら前面会話と一覧 watch の転送・再接続を従来どおり維持する", async () => {
    const h = await setup();
    h.emitPreview(preview("work", 1));
    h.emitPreview(preview("other", 1));
    expect(await h.drain()).toEqual([preview("work", 1)]);
    h.watch(true);
    await h.drain();
    expect(h.watchMessages()).toEqual([{ type: "session_preview_watch", enabled: true }]);
    h.emitPreview(preview("other", 2));
    expect(await h.drain()).toEqual([preview("other", 2)]);
    h.send.mockClear();
    h.hubLink.onReconnect?.({ bootId: "old-app-hub", disconnectedAtMs: 1_000 });
    expect(h.watchMessages()).toEqual([{ type: "session_preview_watch", enabled: true }]);
    expect(h.send.mock.calls.some(([message]) => message.type === "client_presence")).toBe(false);
    h.watch(false);
    await h.drain();
    h.emitPreview(preview("other", 3));
    h.emitPreview(preview("work", 3));
    expect(await h.drain()).toEqual([preview("work", 3)]);
  });

  test.each([
    ["foreground", true], ["foreground", false], ["background", true], ["background", false],
  ] as const)("hub 再接続でも在席を中継し、背景中は一覧 watch を再開しない（%s / %s）", async (state, desired) => {
    const h = await setup();
    h.watch(desired);
    h.presence(state);
    await h.drain();
    for (const bootId of ["hub-a", "hub-a", "hub-b"]) {
      h.send.mockClear();
      h.hubLink.onReconnect?.({ bootId, disconnectedAtMs: 1_000 });
      expect(h.send).toHaveBeenCalledWith({ type: "client_presence", deviceId: DEVICE_ID.toUpperCase(), state });
      expect(h.watchMessages()).toEqual(state === "foreground" && desired
        ? [{ type: "session_preview_watch", enabled: true }] : []);
      expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "conversation_subscribe", session: "work", preview: true,
      }));
      h.emitPreview(preview("work", 1));
      expect(await h.drain()).toEqual(state === "background" ? [] : [preview("work", 1)]);
    }
    if (state === "background") {
      h.send.mockClear();
      h.presence("foreground");
      expect(await h.drain()).toEqual([preview("work", 1)]);
      expect(h.watchMessages()).toEqual(desired ? [{ type: "session_preview_watch", enabled: true }] : []);
    }
  });

  test("watch 再開が直ちに新しいプレビューを返しても保存フレームを先に送る", async () => {
    const h = await setup();
    h.watch(true);
    h.presence("background");
    await h.drain();
    h.emitPreview(preview("work", 1));
    h.send.mockImplementation((message) => {
      if (message.type === "session_preview_watch" && message.enabled) h.emitPreview(preview("work", 2));
      return true;
    });
    h.presence("foreground");
    expect(await h.drain()).toEqual([preview("work", 1), preview("work", 2)]);
  });
});
