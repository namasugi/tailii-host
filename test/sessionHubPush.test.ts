// sessionHubPush.test.ts — hub の push の契機（完了・設問・エラー・使用量制限・hook の承認）と在席判定（push v1）

import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeHubServerLine, type HubServerMessage } from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import type { ControlMessage } from "../src/protocol.js";
import { HISTORY_DONE_STREAM_ID } from "../src/chat/transcriptTailer.js";
import { PushDispatcher } from "../src/push/pushDispatcher.js";
import { decodePushKey, openPushTp } from "../src/push/pushEnvelope.js";
import type {
  CodexNativeTurnControllerOptions,
  CodexTurnControllerRuntime,
} from "../src/codex/codexNativeTurnController.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";
import { DEVICE_ID, MemoryDeviceStore, PUSH_KEY, RecordingTransport, sampleDevice } from "./pushTestHelpers.js";

const key = decodePushKey(PUSH_KEY)!;

type Lifecycle = (event: { kind: "interrupted" | "api_error" | "turn_start"; atMs: number; errorKind?: string | null }) => void;

function makePushHub(options: {
  pingTimeoutMs?: number;
  transcript?: string;
  codexController?: { capture: (options: CodexNativeTurnControllerOptions) => void; runtime: CodexTurnControllerRuntime };
  agent?: "claude" | "codex";
  claudeVersionRecorder?: { observe(version: string): void };
} = {}) {
  const now = 100;
  const timers: { callback: () => void; ms: number; handle: number; cleared: boolean }[] = [];
  let nextHandle = 1;
  const store = new MemoryDeviceStore([sampleDevice()]);
  const transport = new RecordingTransport("relay");
  const dispatcher = new PushDispatcher({
    store,
    loadApnsConfig: () => null,
    createTransport: () => transport,
    titleFor: () => "会話タイトル",
    nowMs: () => now * 1000,
    setTimer: (callback, ms) => {
      const handle = nextHandle++;
      timers.push({ callback, ms, handle, cleared: false });
      return handle;
    },
    clearTimer: (handle) => {
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer !== undefined) timer.cleared = true;
    },
    pingTimeoutMs: options.pingTimeoutMs ?? 50,
  });
  const metadataStore = makeTempStore();
  metadataStore.put({
    name: "cs-work", cwd: "/tmp/work", createdAt: 0, claudeSessionId: "claude-1",
    ...(options.agent === "codex" ? { agent: "codex" as const, providerSessionId: "thread-1" } : {}),
  });
  const transcriptDir = makeTempDir("hub-push-transcript");
  const transcriptPath = path.join(transcriptDir, "t.jsonl");
  if (options.transcript !== undefined) fs.writeFileSync(transcriptPath, options.transcript);
  const lifecycles: Lifecycle[] = [];
  const tailWrites: ((payload: ControlMessage) => void)[] = [];
  const codexLifecycles: ((event: { state: "active" | "done"; turnId: string; outcome?: "completed" | "failed" | "interrupted"; errorMessage?: string }) => void)[] = [];
  let usageLimitWait: ((state: { kind: string; resumeAt?: string | null } | null) => void) | undefined;
  // presence_ping の応答待ちのタイマー（実時間に依存しない）。firePingTimeouts で満了させる。
  const pingTimers: { callback: () => void; handle: number; cleared: boolean }[] = [];
  const hub = new SessionHub({
    pushPingTimers: {
      set: (callback) => {
        const handle = nextHandle++;
        pingTimers.push({ callback, handle, cleared: false });
        return handle;
      },
      clear: (handle) => {
        const timer = pingTimers.find((candidate) => candidate.handle === handle);
        if (timer !== undefined) timer.cleared = true;
      },
    },
    runner: async () => ok(""), heartbeatDir: makeTempDir("hub-push"), metadataStore, timeoutSeconds: 1800,
    now: () => now, nowMs: () => now * 1000 + 250,
    pushDispatcher: dispatcher,
    transcriptPathFor: () => transcriptPath,
    tailFactory: (write, onCodexTurnLifecycle, onClaudeTurnLifecycle) => {
      tailWrites.push(write);
      if (onCodexTurnLifecycle !== undefined) codexLifecycles.push(onCodexTurnLifecycle);
      if (onClaudeTurnLifecycle !== undefined) lifecycles.push(onClaudeTurnLifecycle as Lifecycle);
      return { open() {}, stop() {} };
    },
    previewPumpFactory: (_write, _onMode, _poll, onUsageLimitWait) => {
      usageLimitWait = onUsageLimitWait as typeof usageLimitWait;
      return { start() {}, stop() {} };
    },
    ...(options.claudeVersionRecorder !== undefined ? { claudeVersionRecorder: options.claudeVersionRecorder } : {}),
    ...(options.codexController !== undefined
      ? {
          codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
          codexTurnControllerFactory: (controllerOptions: CodexNativeTurnControllerOptions) => {
            options.codexController!.capture(controllerOptions);
            return options.codexController!.runtime;
          },
        }
      : {}),
  });
  const fireTimers = async (): Promise<void> => {
    const due = timers.filter((timer) => !timer.cleared);
    for (const timer of due) {
      timer.cleared = true;
      timer.callback();
    }
    await vi.waitFor(() => Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));
  };
  const firePingTimeouts = (): void => {
    for (const timer of pingTimers.filter((candidate) => !candidate.cleared)) {
      timer.cleared = true;
      timer.callback();
    }
  };
  const opened = () => transport.requests.map((request) => JSON.parse(openPushTp(key, request.tp)!) as Record<string, unknown>);
  return {
    hub, dispatcher, store, transport, timers, fireTimers, firePingTimeouts, opened, lifecycles, tailWrites, codexLifecycles,
    usageLimitWait: () => usageLimitWait,
  };
}

function processing(hub: SessionHub, state: "active" | "done", event: string): void {
  hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state, event });
}

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant", uuid: "a1", timestamp: "2026-11-11T00:00:00.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "作業が終わりました。\nテストは全て通っています。" }] },
}) + "\n";

describe("SessionHub push: turn_done", () => {
  test("Stop で 3 秒待ちを予約し、満了で最後の応答の先頭を本文に送る", async () => {
    const h = makePushHub({ transcript: ASSISTANT_LINE });
    processing(h.hub, "active", "UserPromptSubmit");
    processing(h.hub, "done", "Stop");
    expect(h.timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)).toEqual([3000]);
    await h.fireTimers();
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({
      kind: "turn_done", session: "cs-work", title: "会話タイトル", body: "作業が終わりました。 テストは全て通っています。",
    });
  });

  test("3 秒以内に処理中へ戻ったら送らない", async () => {
    const h = makePushHub({ transcript: ASSISTANT_LINE });
    processing(h.hub, "active", "UserPromptSubmit");
    processing(h.hub, "done", "Stop");
    processing(h.hub, "active", "UserPromptSubmit");
    await h.fireTimers();
    expect(h.transport.requests).toHaveLength(0);
  });

  test("処理中でない Stop・engine の取り消し（prompt-cancelled）では予約しない", async () => {
    const h = makePushHub();
    processing(h.hub, "done", "Stop");
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.handleClientMessage({}, JSON.stringify({ type: "session_processing", session: "cs-work", state: "done", event: "prompt-cancelled" }));
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });

  test("利用者の中断（現在のターンの中断マーカー）では完了通知を送らない", async () => {
    const h = makePushHub();
    const client = {};
    h.hub.registerClient(client, () => {});
    h.hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    processing(h.hub, "active", "UserPromptSubmit");
    h.lifecycles[0]!({ kind: "interrupted", atMs: 100_300 });
    expect(h.hub.actors.get("cs-work")?.processingSince).toBeNull();
    await h.fireTimers();
    expect(h.transport.requests).toHaveLength(0);
  });

  test("レビュー⑦: Stop の後に届いた過去の終端マーカー（履歴再生）は今回の完了通知を取り消さない", async () => {
    for (const kind of ["interrupted", "api_error"] as const) {
      const h = makePushHub({ transcript: ASSISTANT_LINE });
      const client = {};
      h.hub.registerClient(client, () => {});
      h.hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
      processing(h.hub, "active", "UserPromptSubmit");
      processing(h.hub, "done", "Stop");
      h.lifecycles[0]!({ kind, atMs: 1_000, errorKind: "server_error" });
      await h.fireTimers();
      await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
      expect(h.opened()[0]).toMatchObject({ kind: "turn_done" });
    }
  });
});

describe("SessionHub push: turn_error / usage_limit", () => {
  test("進行中のターンの API エラー（rate_limit 以外）→ turn_error。rate_limit は送らない", async () => {
    const h = makePushHub();
    h.hub.registerClient({}, () => {});
    h.hub.handleClientMessage({}, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    processing(h.hub, "active", "UserPromptSubmit");
    h.lifecycles[0]!({ kind: "api_error", atMs: 100_300, errorKind: "server_error" });
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "turn_error", body: "API が混み合っているため作業が止まりました" });

    const limited = makePushHub();
    limited.hub.registerClient({}, () => {});
    limited.hub.handleClientMessage({}, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    processing(limited.hub, "active", "UserPromptSubmit");
    limited.lifecycles[0]!({ kind: "api_error", atMs: 100_300, errorKind: "rate_limit" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(limited.transport.requests).toHaveLength(0);
  });

  test("履歴再生の古い API エラー（処理中でない）では送らない", async () => {
    const h = makePushHub();
    h.hub.registerClient({}, () => {});
    h.hub.handleClientMessage({}, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    h.lifecycles[0]!({ kind: "api_error", atMs: 1_000, errorKind: "server_error" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.requests).toHaveLength(0);
  });
});

describe("SessionHub push: question", () => {
  test("新しい設問で 1 回だけ送る（同じ id の再提示・Codex の非同期質問は送らない）", async () => {
    const h = makePushHub();
    const questions = [{ header: "h", question: "どちらの案にしますか？", multiSelect: false, options: [] }];
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1", questions });
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "question", id: "q-1", body: "どちらの案にしますか？" });
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "dismiss", id: "q-1" });
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1", questions });
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "codex-async:x", questions });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("SessionHub push: hook の push_request", () => {
  test("受理を即答して dispatcher で送る・dispatcher が無ければ unavailable", async () => {
    const h = makePushHub();
    const hook = {}, received: HubServerMessage[] = [];
    h.hub.registerClient(hook, (line) => received.push(decodeHubServerLine(line)!));
    h.hub.handleClientMessage(hook, JSON.stringify({
      type: "push_request", id: "r1", event: { kind: "approval", session: "cs-work", id: "ap-1", body: "Bash · ls", tool: "Bash" },
    }));
    expect(received).toEqual([{ type: "push_request_result", id: "r1", status: "accepted" }]);
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "approval", id: "ap-1", body: "Bash · ls" });

    const bare = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-push-bare"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800 });
    const replies: HubServerMessage[] = [];
    bare.registerClient(hook, (line) => replies.push(decodeHubServerLine(line)!));
    bare.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r2", event: { kind: "approval", session: "s" } }));
    expect(replies).toEqual([{ type: "push_request_result", id: "r2", status: "unavailable" }]);
  });
});

describe("SessionHub push: 在席判定（client_presence + presence_ping）", () => {
  function engineClient(hub: SessionHub, options: { pong: boolean }) {
    const client = {};
    const pings: string[] = [];
    hub.registerClient(client, (line) => {
      const message = decodeHubServerLine(line);
      if (message?.type !== "presence_ping") return;
      pings.push(message.id);
      if (options.pong) queueMicrotask(() => hub.handleClientMessage(client, JSON.stringify({ type: "presence_pong", id: message.id })));
    });
    return { client, pings };
  }

  test("前面申告 + その会話を前面購読 + pong → 表示中として送らない", async () => {
    const h = makePushHub();
    const engine = engineClient(h.hub, { pong: true });
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID.toLowerCase(), state: "foreground" }));
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    const outcome = await h.dispatcher.notify({ kind: "question", session: "cs-work" });
    expect(outcome).toMatchObject({ status: "skipped", reason: "client-viewing" });
    expect(engine.pings).toHaveLength(1);
  });

  test("前面申告でも別の会話（背景購読）なら client-foreground、背景申告なら ping せず送る", async () => {
    const h = makePushHub();
    const engine = engineClient(h.hub, { pong: true });
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "foreground" }));
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: false }));
    expect(await h.dispatcher.notify({ kind: "question", session: "cs-work" })).toMatchObject({ reason: "client-foreground" });
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "background" }));
    expect((await h.dispatcher.notify({ kind: "turn_error", session: "cs-work" })).status).toBe("sent");
    expect(engine.pings).toHaveLength(1);
  });

  test("pong が来なければ不在として送る・切断した接続は数えない", async () => {
    const h = makePushHub();
    const silent = engineClient(h.hub, { pong: false });
    h.hub.handleClientMessage(silent.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "foreground" }));
    h.hub.handleClientMessage(silent.client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    const silentOutcome = h.dispatcher.notify({ kind: "question", session: "cs-work" });
    await vi.waitFor(() => expect(silent.pings).toHaveLength(1));
    h.firePingTimeouts();
    expect((await silentOutcome).status).toBe("sent");

    const gone = makePushHub();
    const engine = engineClient(gone.hub, { pong: false });
    gone.hub.handleClientMessage(engine.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "foreground" }));
    const pending = gone.dispatcher.notify({ kind: "question", session: "cs-work" });
    await vi.waitFor(() => expect(engine.pings).toHaveLength(1));
    // ping の応答待ち中に切断 → 待ちは false で解け、不在として送る。
    gone.hub.unregisterClient(engine.client);
    expect((await pending).status).toBe("sent");
    expect((await gone.dispatcher.notify({ kind: "turn_error", session: "cs-work" })).status).toBe("sent");
    expect(engine.pings).toHaveLength(1);
  });

  test("別の接続から来た pong では解けない", async () => {
    const h = makePushHub();
    const engine = engineClient(h.hub, { pong: false });
    const other = {};
    h.hub.registerClient(other, () => {});
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "foreground" }));
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    const pending = h.dispatcher.notify({ kind: "question", session: "cs-work" });
    await vi.waitFor(() => expect(engine.pings).toHaveLength(1));
    h.hub.handleClientMessage(other, JSON.stringify({ type: "presence_pong", id: engine.pings[0] }));
    h.firePingTimeouts();
    expect((await pending).status).toBe("sent");
  });
});

describe("SessionHub push: Codex の turn 終了", () => {
  async function codexHub() {
    let callbacks!: CodexNativeTurnControllerOptions;
    const runtime: CodexTurnControllerRuntime = { startTurn: vi.fn(async () => "turn-1"), closeSession: vi.fn(), close: vi.fn() };
    const h = makePushHub({ agent: "codex", codexController: { capture: (options) => { callbacks = options; }, runtime } });
    const client = {};
    h.hub.registerClient(client, () => {});
    h.hub.handleClientMessage(client, JSON.stringify({ type: "codex_turn_submit", id: "turn", session: "cs-work", text: "run",
      clientUserMessageId: "client-1", effort: null, sandbox: null, threadId: "thread-1", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledOnce());
    return { h, callbacks: () => callbacks };
  }

  test("completed → 3 秒後に turn_done、failed → turn_error（エラー本文）、interrupted → 送らない", async () => {
    const done = await codexHub();
    done.callbacks().onProcessing?.("cs-work", "active");
    done.callbacks().onProcessing?.("cs-work", "done", { status: "completed", turnId: "turn-1" });
    await done.h.fireTimers();
    await vi.waitFor(() => expect(done.h.transport.requests).toHaveLength(1));
    expect(done.h.opened()[0]).toMatchObject({ kind: "turn_done" });

    const failed = await codexHub();
    failed.callbacks().onProcessing?.("cs-work", "active");
    failed.callbacks().onProcessing?.("cs-work", "done", { status: "failed", turnId: "turn-2", errorMessage: "context window exceeded" });
    await vi.waitFor(() => expect(failed.h.transport.requests).toHaveLength(1));
    expect(failed.h.opened()[0]).toMatchObject({ kind: "turn_error", id: "turn-2", body: "context window exceeded" });

    const interrupted = await codexHub();
    interrupted.callbacks().onProcessing?.("cs-work", "active");
    interrupted.callbacks().onProcessing?.("cs-work", "done", { status: "interrupted", turnId: "turn-3" });
    await interrupted.h.fireTimers();
    expect(interrupted.h.transport.requests).toHaveLength(0);
  });

  test("turn の終わり方が無い done（切断・close）では送らない", async () => {
    const c = await codexHub();
    c.callbacks().onProcessing?.("cs-work", "active");
    c.callbacks().onProcessing?.("cs-work", "done");
    await c.h.fireTimers();
    expect(c.h.transport.requests).toHaveLength(0);
  });
});

describe("SessionHub push: レビュー修正（在席確認の後の再確認・背景申告後の pong・StopFailure）", () => {
  function foregroundEngine(hub: SessionHub, options: { pong: boolean; session?: string }) {
    const client = {};
    const pings: string[] = [];
    hub.registerClient(client, (line) => {
      const message = decodeHubServerLine(line);
      if (message?.type === "presence_ping") pings.push(message.id);
    });
    hub.handleClientMessage(client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "foreground" }));
    if (options.session !== undefined) {
      hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: options.session, preview: true }));
    }
    return { client, pings };
  }

  test("修正 2: 完了通知の在席確認（ping 待ち）の間に処理中へ戻ったら送らない", async () => {
    const h = makePushHub({ transcript: ASSISTANT_LINE });
    const engine = foregroundEngine(h.hub, { pong: false });
    processing(h.hub, "active", "UserPromptSubmit");
    processing(h.hub, "done", "Stop");
    await h.fireTimers();
    await vi.waitFor(() => expect(engine.pings).toHaveLength(1));
    // ping の応答待ち中に次のターンが始まり、その後 ping は応答なしで終わる（=不在扱い）。
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.unregisterClient(engine.client);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.requests).toHaveLength(0);
  });

  test("修正 2: 設問の在席確認の間に答えられた設問は送らない", async () => {
    const h = makePushHub();
    const engine = foregroundEngine(h.hub, { pong: false });
    const questions = [{ header: "h", question: "q?", multiSelect: false, options: [] }];
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1", questions });
    await vi.waitFor(() => expect(engine.pings).toHaveLength(1));
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "dismiss", id: "q-1" });
    h.hub.unregisterClient(engine.client);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.requests).toHaveLength(0);
  });

  test("修正 3: ping の後に background を申告した接続は、pong が来ても不在として送る", async () => {
    const h = makePushHub();
    const engine = foregroundEngine(h.hub, { pong: false, session: "cs-work" });
    const pending = h.dispatcher.notify({ kind: "question", session: "cs-work" });
    await vi.waitFor(() => expect(engine.pings).toHaveLength(1));
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "background" }));
    h.hub.handleClientMessage(engine.client, JSON.stringify({ type: "presence_pong", id: engine.pings[0] }));
    expect((await pending).status).toBe("sent");
  });

  test("修正 4: 購読者ゼロでも StopFailure（server_error）で turn_error を 1 回だけ送る", async () => {
    const h = makePushHub();
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error" });
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "turn_error", body: "API が混み合っているため作業が止まりました" });
    expect(h.hub.actors.get("cs-work")?.processingSince).toBeNull();
    // 重ねて届いた StopFailure（処理中でない）では送らない。
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.requests).toHaveLength(1);
  });

  test("修正 4: transcript の API エラーと StopFailure はどちらの順でも 1 回だけ", async () => {
    for (const order of ["hook-first", "transcript-first"] as const) {
      const h = makePushHub();
      h.hub.registerClient({}, () => {});
      h.hub.handleClientMessage({}, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
      processing(h.hub, "active", "UserPromptSubmit");
      const hook = () => h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error" });
      const transcript = () => h.lifecycles[0]!({ kind: "api_error", atMs: 100_300, errorKind: "server_error" });
      if (order === "hook-first") { hook(); transcript(); } else { transcript(); hook(); }
      await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.transport.requests).toHaveLength(1);
    }
  });

  test("修正 4: StopFailure の rate_limit は送らずに使用量制限の見張りを始める", async () => {
    const h = makePushHub();
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "rate_limit" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transport.requests).toHaveLength(0);
    expect(h.hub.actors.get("cs-work")?.usageLimitWatch).not.toBeNull();
  });
});

describe("SessionHub push: 2 周目のレビュー指摘", () => {
  function engine(hub: SessionHub, options: { pong: boolean; session?: string }) {
    const client = {};
    const pings: string[] = [];
    hub.registerClient(client, (line) => {
      const message = decodeHubServerLine(line);
      if (message?.type !== "presence_ping") return;
      pings.push(message.id);
      if (options.pong) hub.handleClientMessage(client, JSON.stringify({ type: "presence_pong", id: message.id }));
    });
    hub.handleClientMessage(client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "foreground" }));
    if (options.session !== undefined) {
      hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: options.session, preview: true }));
    }
    return { client, pings };
  }
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  test("①: StopFailure の終端は hook の発火時刻で記録し、受信より前に発火した次の発話を捨てない", () => {
    const h = makePushHub();
    // hub の時計は 100_250ms。失敗の発火 100_000 → 次の発話の発火 100_100 → 失敗の受信 → 次の発話の受信。
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "active", event: "UserPromptSubmit", atMs: 99_000 });
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error", atMs: 100_000 });
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "active", event: "UserPromptSubmit", atMs: 100_100 });
    expect(h.hub.actors.get("cs-work")?.processingSince).not.toBeNull();
  });

  test("①: 既存の late-hook 判定は保つ（失敗の発火より前に発火した継続 hook は捨てる）", () => {
    const h = makePushHub();
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "active", event: "UserPromptSubmit", atMs: 99_000 });
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error", atMs: 100_000 });
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "active", event: "PostToolUse", atMs: 99_900 });
    expect(h.hub.actors.get("cs-work")?.processingSince).toBeNull();
  });

  async function codexHub() {
    let callbacks!: CodexNativeTurnControllerOptions;
    const runtime: CodexTurnControllerRuntime = { startTurn: vi.fn(async () => "turn-1"), closeSession: vi.fn(), close: vi.fn() };
    const h = makePushHub({ agent: "codex", codexController: { capture: (options) => { callbacks = options; }, runtime } });
    const client = {};
    h.hub.registerClient(client, () => {});
    h.hub.handleClientMessage(client, JSON.stringify({ type: "codex_turn_submit", id: "turn", session: "cs-work", text: "run",
      clientUserMessageId: "client-1", effort: null, sandbox: null, threadId: "thread-1", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledOnce());
    h.hub.unregisterClient(client);
    return { h, cb: () => callbacks };
  }

  test("②: rollout の補完（outcome 無しの done）が先でも、後から来た turn/completed の結果を 1 回だけ知らせる", async () => {
    const done = await codexHub();
    done.cb().onProcessing?.("cs-work", "active");
    done.cb().onProcessing?.("cs-work", "done");
    done.cb().onProcessing?.("cs-work", "done", { status: "completed", turnId: "turn-1" });
    done.cb().onProcessing?.("cs-work", "done", { status: "completed", turnId: "turn-1" });
    await done.h.fireTimers();
    await vi.waitFor(() => expect(done.h.transport.requests).toHaveLength(1));
    await settle();
    expect(done.h.transport.requests).toHaveLength(1);

    const failed = await codexHub();
    failed.cb().onProcessing?.("cs-work", "active");
    failed.cb().onProcessing?.("cs-work", "done");
    failed.cb().onProcessing?.("cs-work", "done", { status: "failed", turnId: "turn-9", errorMessage: "boom" });
    await vi.waitFor(() => expect(failed.h.transport.requests).toHaveLength(1));
    expect(failed.h.opened()[0]).toMatchObject({ kind: "turn_error", body: "boom" });
  });

  test("⑩: Codex の完了本文は今のターンの回答（購読者ゼロでも）。前のターンの回答は使わず定型文にする", async () => {
    const c = await codexHub();
    const answer = (text: string) => c.cb().onChatItem?.({ session: "cs-work", itemId: text,
      payload: { type: "chat_output", v: 2, streamId: `s-${text}`, role: "assistant", text, eof: true } });
    c.cb().onProcessing?.("cs-work", "active");
    answer("一回目の回答");
    c.cb().onProcessing?.("cs-work", "done", { status: "completed", turnId: "turn-1" });
    await c.h.fireTimers();
    await vi.waitFor(() => expect(c.h.transport.requests).toHaveLength(1));
    expect(c.h.opened()[0]).toMatchObject({ body: "一回目の回答" });
    c.cb().onProcessing?.("cs-work", "active");
    c.cb().onProcessing?.("cs-work", "done", { status: "completed", turnId: "turn-2" });
    await c.h.fireTimers();
    await vi.waitFor(() => expect(c.h.transport.requests).toHaveLength(2));
    expect(c.h.opened()[1]).toMatchObject({ body: "作業が完了しました" });
  });

  test("④: q1 の在席確認中に q1 が片付いて q2 が出たら、q2 を送る（q2 を通知済みにして落とさない）", async () => {
    const h = makePushHub();
    const e = engine(h.hub, { pong: false });
    const questions = (text: string) => [{ header: "h", question: text, multiSelect: false, options: [] }];
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1", questions: questions("一問目") });
    await vi.waitFor(() => expect(e.pings).toHaveLength(1));
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "dismiss", id: "q-1" });
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-2", questions: questions("二問目") });
    h.firePingTimeouts();
    await vi.waitFor(() => expect(e.pings).toHaveLength(2));
    h.firePingTimeouts();
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "question", id: "q-2", body: "二問目" });
  });

  test("④: 見送った設問（表示中）は通知済みにせず、再提示で改めて判断する", async () => {
    const h = makePushHub();
    const e = engine(h.hub, { pong: true, session: "cs-work" });
    const questions = [{ header: "h", question: "q", multiSelect: false, options: [] }];
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1", questions });
    await vi.waitFor(() => expect(e.pings).toHaveLength(1));
    await settle();
    expect(h.transport.requests).toHaveLength(0);
    // アプリが背景へ → 同じ設問の再提示（stale の再確認など）では送る。
    h.hub.handleClientMessage(e.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "background" }));
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "dismiss", id: "q-1" });
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1", questions });
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
  });

  test("⑤: 同じ端末の接続 A が pong した後で A・B とも背景を申告したら、在席にせず送る", async () => {
    const h = makePushHub();
    const a = engine(h.hub, { pong: true });
    const b = engine(h.hub, { pong: false });
    const pending = h.dispatcher.notify({ kind: "question", session: "cs-work" });
    await vi.waitFor(() => expect(a.pings.length + b.pings.length).toBe(2));
    h.hub.handleClientMessage(a.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "background" }));
    h.hub.handleClientMessage(b.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "background" }));
    expect((await pending).status).toBe("sent");
  });

  test("⑧: 在席確認の間に解決された承認（remote_pending_cleared）・会話の retire では送らない", async () => {
    for (const resolveBy of ["cleared", "retire"] as const) {
      const h = makePushHub();
      const e = engine(h.hub, { pong: false });
      const hook = {};
      h.hub.registerClient(hook, () => {});
      h.hub.handleRelayMessage({ type: "remote_pending", v: 1, id: "ap-1", session: "cs-work", kind: "approval", tool: "Bash", summary: "ls" });
      h.hub.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r1", event: { kind: "approval", session: "cs-work", id: "ap-1", tool: "Bash" } }));
      await vi.waitFor(() => expect(e.pings).toHaveLength(1));
      if (resolveBy === "cleared") {
        h.hub.handleRelayMessage({ type: "remote_pending_cleared", v: 1, id: "ap-1", session: "cs-work", kind: "approval" });
      } else {
        h.hub.handleClientMessage(hook, JSON.stringify({ type: "session_retire", session: "cs-work" }));
      }
      h.firePingTimeouts();
      await settle();
      expect(h.transport.requests).toHaveLength(0);
    }
  });

  test("⑧: 解決されていない承認は送る", async () => {
    const h = makePushHub();
    const hook = {};
    h.hub.registerClient(hook, () => {});
    h.hub.handleRelayMessage({ type: "remote_pending", v: 1, id: "ap-2", session: "cs-work", kind: "approval", tool: "Bash", summary: "ls" });
    h.hub.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r2", event: { kind: "approval", session: "cs-work", id: "ap-2" } }));
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
  });
});

describe("SessionHub push: 3 周目のレビュー指摘", () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  function foreground(hub: SessionHub, deviceId: string, options: { pong: boolean }) {
    const client = {};
    const pings: string[] = [];
    hub.registerClient(client, (line) => {
      const message = decodeHubServerLine(line);
      if (message?.type !== "presence_ping") return;
      pings.push(message.id);
      if (options.pong) hub.handleClientMessage(client, JSON.stringify({ type: "presence_pong", id: message.id }));
    });
    hub.handleClientMessage(client, JSON.stringify({ type: "client_presence", deviceId, state: "foreground" }));
    return { client, pings };
  }

  test("F3: 開始の hook より先に届いた StopFailure でも終端時刻を記録し、遅着した古い開始で処理中に戻さない", () => {
    const h = makePushHub();
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error", atMs: 100_000 });
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "active", event: "UserPromptSubmit", atMs: 99_500 });
    expect(h.hub.actors.get("cs-work")?.processingSince).toBeNull();
    // 失敗より後に発火した新しい発話は採用する。
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "active", event: "UserPromptSubmit", atMs: 100_100 });
    expect(h.hub.actors.get("cs-work")?.processingSince).not.toBeNull();
  });

  test("F4: rollout の補完 → 最後の購読者が離れて thread を close → turn/completed が来ない、でも完了を 1 回知らせる", async () => {
    let callbacks!: CodexNativeTurnControllerOptions;
    let closed = false;
    const runtime: CodexTurnControllerRuntime = {
      subscribeSession: async () => ({ itemIds: new Set(), contentCounts: new Map(), liveSubscribed: true, model: null }),
      startTurn: vi.fn(async () => "turn-1"),
      reconcileCompletedTurn: (session) => { callbacks.onProcessing?.(session, "done"); return true; },
      // 実際の close と同じく、閉じた後は turn/completed が届かない（outcome 無しの done だけ）。
      closeSession: vi.fn((session: string) => {
        if (closed) return;
        closed = true;
        callbacks.onProcessing?.(session, "done");
      }),
      close: vi.fn(),
    };
    const h = makePushHub({ agent: "codex", codexController: { capture: (options) => { callbacks = options; }, runtime } });
    const client = {};
    h.hub.registerClient(client, () => {});
    h.hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "cs-work", preview: true }));
    await vi.waitFor(() => expect(h.codexLifecycles).toHaveLength(1));
    h.tailWrites[0]!({ type: "chat_output", v: 2, streamId: HISTORY_DONE_STREAM_ID, role: "system", text: "", eof: true });
    await settle();
    callbacks.onProcessing?.("cs-work", "active");
    h.codexLifecycles[0]!({ state: "done", turnId: "turn-1", outcome: "completed" });
    h.hub.handleClientMessage(client, JSON.stringify({ type: "conversation_unsubscribe", session: "cs-work" }));
    expect(closed).toBe(true);
    await h.fireTimers();
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "turn_done" });
    // 遅れて turn/completed が届いても 2 通目は出ない。
    callbacks.onProcessing?.("cs-work", "done", { status: "completed", turnId: "turn-1" });
    await h.fireTimers();
    await settle();
    expect(h.transport.requests).toHaveLength(1);
  });

  test("F9: turn ごとに 1 回（A → B → A でも A を再通知しない）", async () => {
    let callbacks!: CodexNativeTurnControllerOptions;
    const runtime: CodexTurnControllerRuntime = { startTurn: vi.fn(async () => "t"), closeSession: vi.fn(), close: vi.fn() };
    const h = makePushHub({ agent: "codex", codexController: { capture: (options) => { callbacks = options; }, runtime } });
    const client = {};
    h.hub.registerClient(client, () => {});
    h.hub.handleClientMessage(client, JSON.stringify({ type: "codex_turn_submit", id: "x", session: "cs-work", text: "run",
      clientUserMessageId: "c-1", effort: null, sandbox: null, threadId: "thread-1", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledOnce());
    for (const turnId of ["A", "B", "A"]) {
      callbacks.onProcessing?.("cs-work", "active");
      callbacks.onProcessing?.("cs-work", "done", { status: "failed", turnId, errorMessage: turnId });
      await settle();
    }
    expect(h.opened().map((plaintext) => plaintext["id"])).toEqual(["A", "B"]);
  });

  test("F5: 使用量制限は待機の開始・状態の変化・再開で実際に送られる", async () => {
    const h = makePushHub();
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "rate_limit", atMs: 100_000 });
    const wait = h.usageLimitWait()!;
    wait({ kind: "waiting", resumeAt: "3pm" });
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(1));
    expect(h.opened()[0]).toMatchObject({ kind: "usage_limit" });
    wait({ kind: "needs_enter" });
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(2));
    processing(h.hub, "active", "UserPromptSubmit");
    await vi.waitFor(() => expect(h.transport.requests).toHaveLength(3));
    expect(h.opened()[2]).toMatchObject({ kind: "usage_limit", body: "使用量制限の待機が終わり、作業を再開しました" });
  });

  test("正のテスト: 全種別が実際の dispatcher を通して送られる", async () => {
    const h = makePushHub({ transcript: ASSISTANT_LINE });
    const hook = {};
    h.hub.registerClient(hook, () => {});
    // turn_done（Claude の Stop）
    processing(h.hub, "active", "UserPromptSubmit");
    processing(h.hub, "done", "Stop");
    await h.fireTimers();
    // question
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "prompt", id: "q-1",
      questions: [{ header: "h", question: "q?", multiSelect: false, options: [] }] });
    // approval
    h.hub.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r", event: { kind: "approval", session: "cs-work", id: "ap-1" } }));
    // turn_error（StopFailure）
    await vi.waitFor(() => expect(h.opened().map((p) => p["kind"])).toContain("question"));
    h.hub.handleRelayMessage({ type: "question_event", session: "cs-work", event: "dismiss", id: "q-1" });
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error", atMs: 100_000 });
    // usage_limit
    processing(h.hub, "active", "UserPromptSubmit");
    h.hub.handleRelayMessage({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "rate_limit", atMs: 100_001 });
    h.usageLimitWait()!({ kind: "waiting", resumeAt: null });
    await vi.waitFor(() => expect(h.opened().map((p) => p["kind"]).sort()).toEqual(
      ["approval", "question", "turn_done", "turn_error", "usage_limit"]));
  });

  test("F6: remote_pending が届いていない承認も、送信待ちの間に retire されたら送らない", async () => {
    const h = makePushHub();
    const e = foreground(h.hub, DEVICE_ID, { pong: false });
    const hook = {};
    h.hub.registerClient(hook, () => {});
    h.hub.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r", event: { kind: "approval", session: "cs-work", id: "ap-x" } }));
    await vi.waitFor(() => expect(e.pings).toHaveLength(1));
    h.hub.handleClientMessage(hook, JSON.stringify({ type: "session_retire", session: "cs-work" }));
    h.firePingTimeouts();
    await settle();
    expect(h.transport.requests).toHaveLength(0);
  });

  test("F6: 送信待ちの間に解決され、他の承認が 1000 件を超えても、解決済みの承認は送らない", async () => {
    const h = makePushHub();
    const e = foreground(h.hub, DEVICE_ID, { pong: false });
    const hook = {};
    h.hub.registerClient(hook, () => {});
    h.hub.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r", event: { kind: "approval", session: "cs-work", id: "ap-keep" } }));
    await vi.waitFor(() => expect(e.pings).toHaveLength(1));
    h.hub.handleRelayMessage({ type: "remote_pending_cleared", v: 1, id: "ap-keep", session: "cs-work", kind: "approval" });
    for (let i = 0; i < 1_100; i += 1) {
      h.hub.handleRelayMessage({ type: "remote_pending", v: 1, id: `other-${i}`, session: "cs-other", kind: "approval", tool: "Bash", summary: "x" });
    }
    h.firePingTimeouts();
    await settle();
    expect(h.transport.requests).toHaveLength(0);
  });

  test("F7: 端末 A が pong した後、端末 B の応答待ちの間に A が背景へ移ったら、A にも送る", async () => {
    const h = makePushHub();
    h.store.devices = [sampleDevice(), sampleDevice({ deviceId: "11111111-2222-3333-4444-555555555555" })];
    const a = foreground(h.hub, DEVICE_ID, { pong: true });
    const b = foreground(h.hub, "11111111-2222-3333-4444-555555555555", { pong: false });
    const pending = h.dispatcher.notify({ kind: "question", session: "cs-work" });
    await vi.waitFor(() => expect(b.pings).toHaveLength(1));
    expect(a.pings).toHaveLength(1);
    h.hub.handleClientMessage(a.client, JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "background" }));
    h.firePingTimeouts();
    const outcome = await pending;
    expect(outcome.status).toBe("sent");
    expect(outcome.devices.filter((device) => device.status === "sent")).toHaveLength(2);
  });

  test("F10: hub の close 後はタイマーが発火しても送らず、新しい依頼も受け付けない", async () => {
    const h = makePushHub({ transcript: ASSISTANT_LINE });
    processing(h.hub, "active", "UserPromptSubmit");
    processing(h.hub, "done", "Stop");
    const scheduled = h.timers.filter((timer) => !timer.cleared);
    h.hub.close();
    for (const timer of scheduled) timer.callback();
    await settle();
    expect(h.transport.requests).toHaveLength(0);
    expect((await h.dispatcher.notify({ kind: "question", session: "cs-work" })).reason).toBe("closed");
    const replies: unknown[] = [];
    const hook = {};
    h.hub.registerClient(hook, (line) => replies.push(decodeHubServerLine(line)));
    h.hub.handleClientMessage(hook, JSON.stringify({ type: "push_request", id: "r", event: { kind: "approval", session: "cs-work", id: "a" } }));
    expect(replies).toEqual([{ type: "push_request_result", id: "r", status: "unavailable" }]);
  });

  test("設計変更 B: ターンの終わりに transcript の version を観測して記録へ渡す", () => {
    const observed: string[] = [];
    const line = JSON.stringify({ type: "assistant", version: "2.1.322", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }) + "\n";
    const h = makePushHub({ transcript: line, claudeVersionRecorder: { observe: (version) => observed.push(version) } });
    processing(h.hub, "active", "UserPromptSubmit");
    processing(h.hub, "done", "Stop");
    expect(observed).toEqual(["2.1.322"]);
  });
});
