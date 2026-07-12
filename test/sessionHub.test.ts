// sessionHub.test.ts — SessionActor 状態・fan-out・heartbeat のテスト

import { describe, expect, test, vi } from "vitest";
import { decodeHubServerLine } from "../src/hubProtocol.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { readHeartbeat, writeHeartbeat } from "../src/heartbeat.js";
import { SessionHub, type HubTail } from "../src/sessionHub.js";
import { HISTORY_DONE_STREAM_ID } from "../src/transcriptTailer.js";
import type { ControlMessage } from "../src/protocol.js";
import type {
  CodexNativeTurnControllerOptions,
  CodexTurnControllerRuntime,
} from "../src/codexNativeTurnController.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

function makeHub(now = 100) {
  const heartbeatDir = makeTempDir("session-hub-heartbeat");
  const hub = new SessionHub({
    runner: async () => ok(""), heartbeatDir, metadataStore: makeTempStore(),
    timeoutSeconds: 1800, now: () => now,
  });
  return { hub, heartbeatDir };
}

describe("SessionHub actor", () => {
  test("presence は購読者数を返し、actor 不在時にも新規作成しない", () => {
    const { hub } = makeHub();
    const requester = {}, subscriberA = {}, subscriberB = {};
    const received: unknown[] = [];
    hub.registerClient(requester, (line) => received.push(decodeHubServerLine(line)));
    hub.registerClient(subscriberA, () => {});
    hub.registerClient(subscriberB, () => {});

    hub.handleClientMessage(requester, JSON.stringify({
      type: "presence_request", id: "missing", session: "missing",
    }));
    expect(received.pop()).toEqual({
      type: "presence_response", id: "missing", session: "missing", subscriberCount: 0,
    });
    expect(hub.actors.has("missing")).toBe(false);

    hub.handleClientMessage(subscriberA, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    hub.handleClientMessage(subscriberB, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    hub.handleClientMessage(requester, JSON.stringify({
      type: "presence_request", id: "present", session: "work",
    }));
    expect(received.pop()).toEqual({
      type: "presence_response", id: "present", session: "work", subscriberCount: 2,
    });

    hub.handleClientMessage(subscriberA, JSON.stringify({ type: "conversation_unsubscribe", session: "work" }));
    hub.handleClientMessage(subscriberB, JSON.stringify({ type: "conversation_unsubscribe", session: "work" }));
    hub.handleClientMessage(requester, JSON.stringify({
      type: "presence_request", id: "empty", session: "work",
    }));
    expect(received.pop()).toEqual({
      type: "presence_response", id: "empty", session: "work", subscriberCount: 0,
    });
  });

  test("chat_send は即時 accepted、同じ clientMessageId は duplicate", async () => {
    let release: (() => void) | undefined;
    const injection = new Promise<void>((resolve) => { release = resolve; });
    const chatInjector = vi.fn(async () => injection);
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-chat-ack"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, chatInjector });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    const send = (id: string) => hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id,
      session: "work", clientMessageId: "client-1", text: "hello" }));
    send("one");
    expect(received).toContainEqual({ type: "chat_send_result", id: "one", status: "accepted" });
    expect(hub.hasInjectionsInFlight).toBe(true);
    send("two");
    expect(received).toContainEqual({ type: "chat_send_result", id: "two", status: "duplicate" });
    release?.();
    await vi.waitFor(() => expect(hub.hasInjectionsInFlight).toBe(false));
    expect(chatInjector).toHaveBeenCalledOnce();
  });

  test("chat_send 注入は actor ごとに FIFO 直列化する", async () => {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const chatInjector = vi.fn(async (text: string) => {
      order.push(`start:${text}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`done:${text}`);
    });
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-chat-fifo"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, chatInjector });
    const client = {};
    hub.registerClient(client, () => {});
    for (const [id, text] of [["one", "first"], ["two", "second"]]) {
      hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id, session: "work",
        clientMessageId: `client-${id}`, text }));
    }
    await vi.waitFor(() => expect(order).toEqual(["start:first"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(order).toEqual(["start:first", "done:first", "start:second"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(order).toEqual([
      "start:first", "done:first", "start:second", "done:second",
    ]));
  });

  test("pendingQuestion 中の chat_send は dismiss 後まで保留する", async () => {
    const chatInjector = vi.fn(async () => {});
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-chat-question"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, chatInjector });
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1",
      questions: [{ header: "h", question: "q", options: [], multiSelect: false }] });
    const client = {};
    hub.registerClient(client, () => {});
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "one", session: "work",
      clientMessageId: "client-1", text: "after answer" }));
    await Promise.resolve();
    expect(chatInjector).not.toHaveBeenCalled();
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "dismiss", id: "q1" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalledWith("after answer", "work"));
  });

  test("chat_send 注入失敗は marker を配信し claim を解放する", async () => {
    const chatInjector = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-chat-fail"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, chatInjector });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    const send = (id: string) => hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id,
      session: "work", clientMessageId: "client-1", text: "retry me" }));
    send("one");
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
      type: "conversation_event", session: "work",
      payload: expect.objectContaining({ streamId: "chat-send-error-one", role: "system" }),
    })));
    send("two");
    expect(received).toContainEqual({ type: "chat_send_result", id: "two", status: "accepted" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalledTimes(2));
  });

  test("codex turn は遅延生成した Hub controller へ渡し clientUserMessageId で重複排除する", async () => {
    const startTurn = vi.fn(async () => "turn-1");
    let controllerOptions: CodexNativeTurnControllerOptions | null = null;
    const controller: CodexTurnControllerRuntime = {
      startTurn, closeSession: vi.fn(), close: vi.fn(), answerQuestion: vi.fn(() => true),
    };
    const appServerFactory = vi.fn(() => ({
      openThread: async () => { throw new Error("unused"); },
    }));
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-codex-turn"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, codexAppServerFactory: appServerFactory,
      codexTurnControllerFactory: (options) => { controllerOptions = options; return controller; } });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    expect(appServerFactory).not.toHaveBeenCalled();
    const submit = (id: string) => hub.handleClientMessage(client, JSON.stringify({
      type: "codex_turn_submit", id, session: "work", text: "run",
      clientUserMessageId: "client-1", effort: null, sandbox: null,
      threadId: "thread-1", cwd: "/tmp/work",
    }));
    submit("one");
    expect(hub.hasCodexTurnsInFlight).toBe(true);
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "codex_turn_result", id: "one", status: "started",
    }));
    submit("two");
    expect(received).toContainEqual({ type: "codex_turn_result", id: "two", status: "duplicate" });
    expect(appServerFactory).toHaveBeenCalledOnce();
    expect(controllerOptions).not.toBeNull();
    expect(startTurn).toHaveBeenCalledOnce();
    expect(startTurn).toHaveBeenCalledWith({ session: "work", threadId: "thread-1", cwd: "/tmp/work",
      text: "run", clientUserMessageId: "client-1", effort: null, sandbox: null });
  });

  test("codex turn は即時 started を返し、startTurn 失敗で claim 解放+エラーマーカー配信する", async () => {
    let failNext = true;
    const startTurn = vi.fn(async () => {
      if (failNext) { failNext = false; throw new Error("boom"); }
      return "turn-2";
    });
    const controller: CodexTurnControllerRuntime = {
      startTurn, closeSession: vi.fn(), close: vi.fn(), answerQuestion: vi.fn(() => true),
    };
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-codex-fail"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800,
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: () => controller });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    const submit = (id: string) => hub.handleClientMessage(client, JSON.stringify({
      type: "codex_turn_submit", id, session: "work", text: "run",
      clientUserMessageId: "client-1", effort: null, sandbox: null,
      threadId: "thread-1", cwd: "/tmp/work",
    }));
    submit("one");
    // 実行完了を待たず即時 ack（engine timeout の fail-open 誤発動防止）。
    expect(received).toContainEqual({ type: "codex_turn_result", id: "one", status: "started" });
    // 失敗 → 全 client が見えるエラーマーカーを conversation_event で配信。
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
      type: "conversation_event", session: "work",
      payload: expect.objectContaining({ streamId: "codex-turn-error-one" }),
    })));
    // claim は解放済み: 同じ clientUserMessageId の再送は duplicate にならない。
    submit("two");
    expect(received).toContainEqual({ type: "codex_turn_result", id: "two", status: "started" });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
  });

  test("codex_turn_interrupt は controller へ渡し、失敗を全 client へマーカー配信する", async () => {
    const interruptTurn = vi.fn<(session: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("interrupt boom"));
    const controller: CodexTurnControllerRuntime = {
      startTurn: vi.fn(async () => "turn-1"), interruptTurn,
      closeSession: vi.fn(), close: vi.fn(),
    };
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-codex-interrupt"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800,
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: () => controller });
    const clients = [{}, {}], received: unknown[][] = [[], []];
    clients.forEach((client, index) => {
      hub.registerClient(client, (line) => received[index]!.push(decodeHubServerLine(line)));
      hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    });
    // controller は turn submit と同じ遅延生成経路で用意する。
    hub.handleClientMessage(clients[0]!, JSON.stringify({ type: "codex_turn_submit", id: "turn",
      session: "work", text: "run", clientUserMessageId: "client-1", effort: null, sandbox: null,
      threadId: "thread-1", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(controller.startTurn).toHaveBeenCalledOnce());

    hub.handleClientMessage(clients[0]!, JSON.stringify({
      type: "codex_turn_interrupt", id: "interrupt-1", session: "work",
    }));
    await vi.waitFor(() => expect(interruptTurn).toHaveBeenCalledWith("work"));
    hub.handleClientMessage(clients[0]!, JSON.stringify({
      type: "codex_turn_interrupt", id: "interrupt-2", session: "work",
    }));
    for (const lines of received) {
      await vi.waitFor(() => expect(lines).toContainEqual(expect.objectContaining({
        type: "conversation_event", session: "work",
        payload: expect.objectContaining({
          streamId: "codex-interrupt-error-interrupt-2",
          text: expect.stringContaining("⚠️"),
        }),
      })));
    }
  });

  test("Hub controller callback は processing・marker を購読 client 全てへ fan-out する", async () => {
    let callbacks!: CodexNativeTurnControllerOptions;
    const controller: CodexTurnControllerRuntime = {
      startTurn: vi.fn(async () => "turn-1"), closeSession: vi.fn(), close: vi.fn(),
    };
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-codex-fanout"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800,
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: (options) => { callbacks = options; return controller; } });
    const clients = [{}, {}], received: unknown[][] = [[], []];
    clients.forEach((client, index) => {
      hub.registerClient(client, (line) => received[index]!.push(decodeHubServerLine(line)));
      hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    });
    hub.handleClientMessage(clients[0]!, JSON.stringify({ type: "codex_turn_submit", id: "turn",
      session: "work", text: "run", clientUserMessageId: "client-1", effort: null, sandbox: null,
      threadId: "thread-1", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(controller.startTurn).toHaveBeenCalledOnce());
    callbacks.onProcessing?.("work", "active");
    callbacks.onModel?.("work", "gpt-test");
    callbacks.onTokenUsage?.("work", 123, 456);
    for (const lines of received) {
      expect(lines).toContainEqual({ type: "session_processing", session: "work", state: "active" });
      expect(lines).toContainEqual(expect.objectContaining({ type: "conversation_event", session: "work",
        payload: expect.objectContaining({ type: "chat_output", streamId: "pc:model", text: "gpt-test" }) }));
      expect(lines).toContainEqual(expect.objectContaining({ type: "conversation_event", session: "work",
        payload: expect.objectContaining({ streamId: "pc:context", text: "123" }) }));
      expect(lines).toContainEqual(expect.objectContaining({ type: "conversation_event", session: "work",
        payload: expect.objectContaining({ streamId: "pc:context-window", text: "456" }) }));
    }
    expect(hub.hasCodexTurnsInFlight).toBe(true);
    callbacks.onProcessing?.("work", "done");
    expect(hub.hasCodexTurnsInFlight).toBe(false);
  });

  test("codex native 設問は first-wins で controller.answerQuestion へ1回だけ振り分ける", async () => {
    let callbacks!: CodexNativeTurnControllerOptions;
    const answerQuestion = vi.fn(() => true);
    const controller: CodexTurnControllerRuntime = {
      startTurn: vi.fn(async () => "turn-1"), closeSession: vi.fn(), close: vi.fn(), answerQuestion,
    };
    const injector = vi.fn(async () => {});
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-native-question"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, questionInjector: injector,
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: (options) => { callbacks = options; return controller; } });
    const clients = [{}, {}], received: unknown[][] = [[], []];
    clients.forEach((client, i) => hub.registerClient(client,
      (line) => received[i]!.push(decodeHubServerLine(line))));
    hub.handleClientMessage(clients[0]!, JSON.stringify({ type: "codex_turn_submit", id: "turn",
      session: "work", text: "run", clientUserMessageId: "client-1", effort: null, sandbox: null,
      threadId: "thread-1", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(controller.startTurn).toHaveBeenCalledOnce());
    callbacks.onQuestion?.({ session: "work", id: "native-q", questions: [
      { header: "h", question: "q", options: [], multiSelect: false },
    ] });
    const answers = [{ questionIndex: 0, selectedOptionIndexes: [], multiSelect: false }];
    clients.forEach((client, index) => hub.handleClientMessage(client, JSON.stringify({
      type: "question_answer_submit", id: `answer-${index}`, session: "work",
      questionId: "native-q", answers,
    })));
    expect(answerQuestion).toHaveBeenCalledTimes(1);
    expect(answerQuestion).toHaveBeenCalledWith("native-q", answers);
    expect(injector).not.toHaveBeenCalled();
    expect(received[0]).toContainEqual({ type: "question_answer_result", id: "answer-0", status: "accepted" });
    expect(received[1]).toContainEqual({ type: "question_answer_result", id: "answer-1", status: "already_resolved" });
  });

  test("設問回答は first-wins で注入を1回だけ実行し全 client へ dismiss する", async () => {
    let injections = 0;
    let release!: () => void;
    const injectionGate = new Promise<void>((resolve) => { release = resolve; });
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-question"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800,
      questionInjector: async () => { injections += 1; await injectionGate; } });
    const clients = [{}, {}], received: unknown[][] = [[], []];
    clients.forEach((client, i) => hub.registerClient(client, (line) => received[i]!.push(decodeHubServerLine(line))));
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1",
      questions: [{ header: "h", question: "q", options: [], multiSelect: false }] });
    const answer = [{ questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false }];
    hub.handleClientMessage(clients[0]!, JSON.stringify({ type: "question_answer_submit", id: "a", session: "work", questionId: "q1", answers: answer }));
    hub.handleClientMessage(clients[1]!, JSON.stringify({ type: "question_answer_submit", id: "b", session: "work", questionId: "q1", answers: answer }));
    expect(received[0]).toContainEqual({ type: "question_answer_result", id: "a", status: "accepted" });
    expect(received[1]).toContainEqual({ type: "question_answer_result", id: "b", status: "already_resolved" });
    expect(received[0]).toContainEqual({ type: "question_event", session: "work", event: "dismiss", id: "q1" });
    expect(received[1]).toContainEqual({ type: "question_event", session: "work", event: "dismiss", id: "q1" });
    expect(injections).toBe(1);
    expect(hub.hasInjectionsInFlight).toBe(true);
    release();
    await vi.waitFor(() => expect(hub.hasInjectionsInFlight).toBe(false));
  });

  test("input_claim は重複を拒否し200件を超えると古いIDを捨てる", () => {
    const { hub } = makeHub();
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    const claim = (id: string) => hub.handleClientMessage(client, JSON.stringify({ type: "input_claim", id, session: "work", clientMessageId: id }));
    claim("m0"); claim("m0");
    expect(received.slice(-2)).toMatchObject([{ status: "granted" }, { status: "duplicate" }]);
    for (let i = 1; i <= 200; i += 1) claim(`m${i}`);
    claim("m0");
    expect(received.at(-1)).toMatchObject({ status: "granted" });
    expect(hub.actors.get("work")?.seenClientMessageIds.size).toBe(200);
  });

  test("runtime_claim は保持・TTL失効・切断解放を扱う", () => {
    let now = 100;
    const log = vi.fn();
    const heartbeatDir = makeTempDir("hub-runtime");
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir, metadataStore: makeTempStore(),
      timeoutSeconds: 1800, now: () => now, log });
    const a = {}, b = {}, ar: unknown[] = [], br: unknown[] = [];
    hub.registerClient(a, (line) => ar.push(decodeHubServerLine(line)));
    hub.registerClient(b, (line) => br.push(decodeHubServerLine(line)));
    const request = (client: object, id: string) => hub.handleClientMessage(client,
      JSON.stringify({ type: "runtime_claim", id, session: "work" }));
    request(a, "a1"); request(b, "b1");
    expect(ar.at(-1)).toMatchObject({ status: "granted" });
    expect(br.at(-1)).toMatchObject({ status: "held" });
    expect(log).toHaveBeenCalledWith("audit runtime_claim_held session=work holder_present=true");
    now = 115; request(b, "b2");
    expect(br.at(-1)).toMatchObject({ status: "granted" });
    hub.unregisterClient(b); request(a, "a2");
    expect(ar.at(-1)).toMatchObject({ status: "granted" });
  });
  test("prompt/dismiss と processing active/done を actor に反映する", () => {
    const { hub } = makeHub();
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1",
      questions: [{ header: "確認", question: "続ける?", options: [], multiSelect: false }] });
    expect(hub.actors.get("work")?.pendingQuestion?.id).toBe("q1");
    hub.handleRelayMessage({ type: "session_processing", session: "work", state: "active" });
    expect(hub.actors.get("work")?.processingSince).toBe(100);
    hub.handleRelayMessage({ type: "session_processing", session: "work", state: "done" });
    expect(hub.actors.get("work")?.processingSince).toBeNull();
    expect(hub.actors.get("work")?.pendingQuestion).toBeNull();
    expect(received).toContainEqual({ type: "question_event", session: "work", event: "dismiss", id: "q1" });
  });

  test("active heartbeat から processingSince を復元する（codex と鮮度切れは除外）", () => {
    const heartbeatDir = makeTempDir("hub-restore-heartbeat");
    writeHeartbeat(heartbeatDir, "active-session", { ts: 90, state: "active", event: "hook" });
    writeHeartbeat(heartbeatDir, "idle-session", { ts: 89, state: "idle", event: "stop" });
    // 鮮度切れ active(クラッシュ残骸): 復元すると tick bump で計時が止まるため捨てる。
    writeHeartbeat(heartbeatDir, "stale-session", { ts: 100 - 1800, state: "active", event: "hook" });
    // codex active: hub 再起動を越えた turn は駆動者不在。bump 停止=死亡シグナルを保つ。
    writeHeartbeat(heartbeatDir, "codex-session", { ts: 95, state: "active", event: "turn" });
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "codex-session", cwd: "/tmp", createdAt: 1, agent: "codex" });
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir,
      metadataStore, timeoutSeconds: 1800, now: () => 100 });
    hub.restoreFromHeartbeats();
    expect(hub.actors.get("active-session")?.processingSince).toBe(90);
    expect(hub.actors.has("idle-session")).toBe(false);
    expect(hub.actors.has("stale-session")).toBe(false);
    expect(hub.actors.has("codex-session")).toBe(false);
  });

  test("reaper の demote/掃除で processingSince を解除し bump を止める", async () => {
    const heartbeatDir = makeTempDir("hub-demote-sync");
    // tmux には cs-work だけが生存し、pane_current_command はシェル(=agent 死亡)を返す。
    const runner = async (args: string[]) => {
      if (args[0] === "ls") return ok("cs-work\n");
      if (args[0] === "list-clients") return ok("");
      if (args[0] === "display-message") return ok("zsh\n");
      return ok("");
    };
    const hub = new SessionHub({ runner, heartbeatDir, metadataStore: makeTempStore(),
      timeoutSeconds: 1800, now: () => 100 });
    writeHeartbeat(heartbeatDir, "cs-work", { ts: 90, state: "active", event: "hook" });
    writeHeartbeat(heartbeatDir, "cs-gone", { ts: 90, state: "active", event: "hook" });
    hub.restoreFromHeartbeats();
    expect(hub.actors.get("cs-work")?.processingSince).toBe(90);
    expect(hub.actors.get("cs-gone")?.processingSince).toBe(90);
    const result = await hub.tick();
    // demote(agent 死亡)と残骸掃除の両方で actor の処理中フラグが同期解除される。
    expect(result.demoted).toEqual(["cs-work"]);
    expect(result.reclaimed).toEqual(["cs-gone"]);
    expect(hub.actors.get("cs-work")?.processingSince).toBeNull();
    expect(hub.actors.get("cs-gone")?.processingSince).toBeNull();
    // 以後の tick は bump しない → heartbeat の ts が進まず通常計時で kill 対象になる。
    await hub.tick();
    expect(readHeartbeat(heartbeatDir, "cs-work")?.ts).toBe(100);
    expect(readHeartbeat(heartbeatDir, "cs-work")?.state).toBe("idle");
  });

  test("TUI pendingQuestion を永続化・復元し、回答 clear も保存する", () => {
    const dir = makeTempDir("hub-pending-store");
    const pendingQuestionsPath = path.join(dir, "hub", "pending-questions.json");
    const options = { runner: async () => ok(""), heartbeatDir: path.join(dir, "heartbeat"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, pendingQuestionsPath };
    const first = new SessionHub(options);
    first.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1",
      questions: [{ header: "h", question: "q", options: [], multiSelect: false }] });
    expect(JSON.parse(fs.readFileSync(pendingQuestionsPath, "utf8"))).toMatchObject({
      work: { id: "q1", answerRoute: "tui" },
    });

    const second = new SessionHub(options);
    second.restorePendingQuestions();
    expect(second.actors.get("work")?.pendingQuestion?.id).toBe("q1");
    const client = {}, received: unknown[] = [];
    second.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    second.handleClientMessage(client, JSON.stringify({ type: "question_answer_submit", id: "answer",
      session: "work", questionId: "q1", answers: [] }));
    expect(received).toContainEqual({ type: "question_answer_result", id: "answer", status: "accepted" });
    expect(JSON.parse(fs.readFileSync(pendingQuestionsPath, "utf8"))).toEqual({});
  });

  test("codex_native pendingQuestion は復元せず dismiss して永続ファイルから除く", () => {
    const dir = makeTempDir("hub-pending-native");
    const pendingQuestionsPath = path.join(dir, "pending-questions.json");
    fs.writeFileSync(pendingQuestionsPath, JSON.stringify({ work: { id: "native-q",
      questions: [{ header: "h", question: "q", options: [], multiSelect: false }],
      answerRoute: "codex_native" } }));
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: path.join(dir, "heartbeat"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, pendingQuestionsPath });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.restorePendingQuestions();
    expect(hub.actors.has("work")).toBe(false);
    expect(received).toContainEqual({
      type: "question_event", session: "work", event: "dismiss", id: "native-q",
    });
    expect(JSON.parse(fs.readFileSync(pendingQuestionsPath, "utf8"))).toEqual({});
  });

  test("focus の移動と切断で focusedBy を掃除し pending は保持する", () => {
    const { hub } = makeHub();
    const client = {};
    hub.registerClient(client, () => {});
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "one" }));
    expect(hub.actors.get("one")?.focusedBy.has(client)).toBe(true);
    hub.handleRelayMessage({ type: "question_event", session: "one", event: "prompt", id: "q1",
      questions: [{ header: "h", question: "q", options: [], multiSelect: false }] });
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_unsubscribe", session: "one" }));
    expect(hub.actors.get("one")?.focusedBy.size).toBe(0);
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "one" }));
    hub.unregisterClient(client);
    expect(hub.actors.get("one")?.focusedBy.size).toBe(0);
    expect(hub.actors.get("one")?.pendingQuestion?.id).toBe("q1");
  });

  test("relay event を全 client へ同一 fan-out する", () => {
    const { hub } = makeHub();
    const received: unknown[][] = [[], []];
    [{}, {}].forEach((client, index) => hub.registerClient(client, (line) => received[index]!.push(decodeHubServerLine(line))));
    hub.handleRelayMessage({ type: "session_processing", session: "work", state: "active" });
    expect(received[0]).toEqual(received[1]);
    expect(received[0]?.[0]).toMatchObject({ type: "session_processing", session: "work", state: "active" });
  });

  test("tick は focused・processing・pending question の heartbeat を bump する", async () => {
    const heartbeatDir = makeTempDir("session-hub-heartbeat");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "s-busy", cwd: "/tmp/s-busy", createdAt: 0, agent: "codex" });
    const hub = new SessionHub({
      runner: async (args) => args[0] === "ls" ? ok("s-focused\ns-busy\ns-question\n") : ok(""),
      heartbeatDir, metadataStore, timeoutSeconds: 1800, now: () => 321,
    });
    const client = {};
    hub.registerClient(client, () => {});
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "s-focused" }));
    hub.handleClientMessage(client, JSON.stringify({ type: "session_processing", session: "s-busy", state: "active" }));
    hub.handleRelayMessage({ type: "question_event", session: "s-question", event: "prompt", id: "q1",
      questions: [{ header: "h", question: "q", options: [], multiSelect: false }] });
    const ticking = hub.tick();
    // reaper 自身の active 生存 bump より前に、Hub の設問保護 bump が実行される。
    expect(readHeartbeat(heartbeatDir, "s-question")).toMatchObject({
      ts: 321, state: "active", event: "hub-question",
    });
    await ticking;
    expect(readHeartbeat(heartbeatDir, "s-focused")).toMatchObject({ ts: 321, event: "hub-tick" });
    expect(readHeartbeat(heartbeatDir, "s-busy")).toMatchObject({ ts: 321, state: "active", event: "hub-processing" });
    expect(readHeartbeat(heartbeatDir, "s-question")).toMatchObject({ ts: 321, state: "active" });
  });
});

function makeStreamingHub(replayLimit = 500) {
  const metadataStore = makeTempStore();
  metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0, providerSessionId: "provider-1" });
  const writes: Array<(payload: ControlMessage) => void> = [];
  const tails: Array<HubTail & { stopped: boolean }> = [];
  const hub = new SessionHub({
    runner: async () => ok(""), heartbeatDir: makeTempDir("session-hub-stream"), metadataStore,
    timeoutSeconds: 1800, replayLimit,
    tailFactory: (write) => {
      writes.push(write);
      const tail = { stopped: false, open() {}, stop() { tail.stopped = true; } };
      tails.push(tail);
      return tail;
    },
  });
  return { hub, writes, tails };
}

function subscribe(hub: SessionHub, client: object, received: unknown[], extra: object = {}): void {
  hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
  hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work", ...extra }));
}

describe("SessionHub conversation stream", () => {
  const output = (streamId: string): ControlMessage =>
    ({ type: "chat_output", v: 1, streamId, role: "assistant", text: streamId, eof: true });

  test("2 subscriber に同じ serverSeq で fan-out し共有 tail は1つ、最後の離脱で stop", () => {
    const { hub, writes, tails } = makeStreamingHub();
    const a = {}, b = {}, ar: unknown[] = [], br: unknown[] = [];
    subscribe(hub, a, ar);
    subscribe(hub, b, br, { afterSeq: 0 });
    expect(tails).toHaveLength(1);
    writes[0]!(output("one")); writes[0]!(output("two"));
    expect(ar).toEqual(br);
    expect(ar).toMatchObject([{ serverSeq: 1 }, { serverSeq: 2 }]);
    hub.handleClientMessage(a, JSON.stringify({ type: "conversation_unsubscribe", session: "work" }));
    expect(tails[0]!.stopped).toBe(false);
    hub.handleClientMessage(b, JSON.stringify({ type: "conversation_unsubscribe", session: "work" }));
    expect(tails[0]!.stopped).toBe(true);
  });

  test("初回購読時にmetadata未作成でも出現後に自動でtailを開始する", async () => {
    vi.useFakeTimers();
    try {
    const metadataStore = makeTempStore();
    const tails: Array<{ opened: unknown[]; stopped: boolean }> = [];
    const hub = new SessionHub({
      runner: async () => ok(""),
      heartbeatDir: makeTempDir("session-hub-late-meta"),
      metadataStore,
      timeoutSeconds: 1800,
      tailFactory: () => {
        const tail = {
          opened: [] as unknown[],
          stopped: false,
          open(...args: unknown[]) { tail.opened.push(args); },
          stop() { tail.stopped = true; },
        };
        tails.push(tail);
        return tail;
      },
    });
    const client = {};
    hub.registerClient(client, () => {});

    hub.handleClientMessage(client, JSON.stringify({
      type: "conversation_subscribe", session: "vscode-session",
    }));
    expect(tails).toHaveLength(0);

    metadataStore.put({
      name: "vscode-session",
      cwd: "/tmp/vscode",
      createdAt: 1,
      providerSessionId: "vscode-conversation-id",
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(tails).toHaveLength(1);
    expect(tails[0]!.opened).toEqual([[
      "/tmp/vscode", "vscode-conversation-id", null, "claude",
    ]]);
    hub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("afterSeq が buffer 内なら欠落なく replay して live へ戻る", () => {
    const { hub, writes, tails } = makeStreamingHub();
    const a = {}, b = {}, ar: unknown[] = [], br: unknown[] = [];
    subscribe(hub, a, ar); writes[0]!(output("one")); writes[0]!(output("two"));
    subscribe(hub, b, br, { afterSeq: 1 });
    writes[0]!(output("three"));
    expect(tails).toHaveLength(1);
    expect(br).toMatchObject([{ serverSeq: 2 }, { serverSeq: 3 }]);
  });

  test("切断した同じ engine は再接続後の afterSeq 再購読で replay と live を受け取る", () => {
    const { hub, writes } = makeStreamingHub();
    const engine = {}, keeper = {}, before: unknown[] = [], after: unknown[] = [];
    subscribe(hub, engine, before);
    subscribe(hub, keeper, [], { afterSeq: 0 });
    writes[0]!(output("one")); writes[0]!(output("two"));

    hub.unregisterClient(engine);
    subscribe(hub, engine, after, { afterSeq: 1 });
    expect(after).toMatchObject([{ serverSeq: 2 }]);
    writes[0]!(output("three"));
    expect(after).toMatchObject([{ serverSeq: 2 }, { serverSeq: 3 }]);
  });

  test("特性化: Hub 再起動後に旧 afterSeq を渡すと新 actor は全履歴を backfill する", () => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0, providerSessionId: "provider-1" });
    const make = () => new SessionHub({ runner: async () => ok(""),
      heartbeatDir: makeTempDir("hub-restart-characterization"), metadataStore, timeoutSeconds: 1800,
      tailFactory: (write) => ({
        open() { write(output("already-visible")); write(output(HISTORY_DONE_STREAM_ID)); }, stop() {},
      }),
    });
    const first = make(), firstReceived: unknown[] = [];
    subscribe(first, {}, firstReceived);
    expect(firstReceived).toContainEqual(expect.objectContaining({
      serverSeq: 1, payload: expect.objectContaining({ streamId: "already-visible" }),
    }));
    first.close();

    const second = make(), secondReceived: unknown[] = [];
    subscribe(second, {}, secondReceived, { afterSeq: 1 });
    expect(secondReceived).toContainEqual(expect.objectContaining({
      serverSeq: 1, payload: expect.objectContaining({ streamId: "already-visible" }),
    }));
  });

  test("buffer 範囲外は backfill、完了まで live を止め完了同期処理で接続する", () => {
    const { hub, writes, tails } = makeStreamingHub(1);
    const a = {}, b = {}, ar: unknown[] = [], br: unknown[] = [];
    subscribe(hub, a, ar); writes[0]!(output("one")); writes[0]!(output("two"));
    subscribe(hub, b, br, { afterSeq: 0, newerThanMs: 123 });
    expect(tails).toHaveLength(2);
    writes[0]!(output("during"));
    expect(br).toEqual([]);
    writes[1]!(output("history"));
    writes[1]!(output(HISTORY_DONE_STREAM_ID));
    expect(br).toMatchObject([{ serverSeq: 0 }, { serverSeq: 0 }]);
    expect(tails[1]!.stopped).toBe(true);
    writes[0]!(output("live"));
    expect(br.at(-1)).toMatchObject({ serverSeq: 4 });
  });

  test("pump の permission mode 通知を preview subscriber だけへ conversation_mode で配る", () => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0 });
    let onMode: ((mode: string) => void) | undefined;
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-mode-push"),
      metadataStore, timeoutSeconds: 1800,
      previewPumpFactory: (_write, onPermissionMode) => {
        onMode = onPermissionMode;
        return { start() {}, stop() {} };
      } });
    const a = {}, b = {}, ar: unknown[] = [], br: unknown[] = [];
    subscribe(hub, a, ar, { preview: false });
    subscribe(hub, b, br, { afterSeq: 0, preview: true });
    onMode?.("auto");
    onMode?.("default");
    const modesOf = (received: unknown[]) =>
      received.filter((m) => (m as { type?: string }).type === "conversation_mode");
    expect(modesOf(ar)).toEqual([]);
    expect(modesOf(br)).toEqual([
      { type: "conversation_mode", session: "work",
        payload: { type: "mode_set_response", v: 1, id: "mode-watch-1", mode: "auto" } },
      { type: "conversation_mode", session: "work",
        payload: { type: "mode_set_response", v: 1, id: "mode-watch-2", mode: "default" } },
    ]);
  });

  test("preview subscriber の有無で pump を開始・停止する", () => {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0 });
    let starts = 0, stops = 0;
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-preview"),
      metadataStore, timeoutSeconds: 1800,
      previewPumpFactory: () => ({ start() { starts += 1; }, stop() { stops += 1; } }) });
    const a = {}, b = {};
    subscribe(hub, a, [], { preview: false });
    subscribe(hub, b, [], { afterSeq: 0, preview: true });
    expect(starts).toBe(1);
    hub.handleClientMessage(b, JSON.stringify({ type: "conversation_unsubscribe", session: "work" }));
    expect(stops).toBe(1);
  });
});

function makeCodexStreamingHub(options: { subscribeFails?: boolean } = {}) {
  const metadataStore = makeTempStore();
  metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 0,
    agent: "codex", providerSessionId: "thread-1" });
  const writes: Array<(payload: ControlMessage) => void> = [];
  const tails: Array<HubTail & { stopped: boolean }> = [];
  let callbacks!: CodexNativeTurnControllerOptions;
  const controller: CodexTurnControllerRuntime = {
    subscribeSession: options.subscribeFails
      ? async () => { throw new Error("app server unavailable"); }
      : async () => ({ itemIds: new Set(["history-item"]),
          contentCounts: new Map([["assistant\u0000履歴", 1]]) }),
    startTurn: async () => "turn-1",
    closeSession: vi.fn(),
    close: vi.fn(),
  };
  const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-codex-live"),
    metadataStore, timeoutSeconds: 1800,
    tailFactory: (write) => {
      writes.push(write);
      const tail = { stopped: false, open() {}, stop() { tail.stopped = true; } };
      tails.push(tail);
      return tail;
    },
    codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
    codexTurnControllerFactory: (value) => { callbacks = value; return controller; },
  });
  return { hub, writes, tails, getCallbacks: () => callbacks };
}

describe("SessionHub Codex App Server live stream", () => {
  const chat = (role: "user" | "assistant" | "system", text: string, streamId: string): ControlMessage =>
    ({ type: "chat_output", v: 1, streamId, role, text, eof: true });

  test("購読を先に開き、backfill 境界の item を欠落・重複なく live へ切り替える", async () => {
    const { hub, writes, tails, getCallbacks } = makeCodexStreamingHub();
    const client = {}, received: any[] = [];
    subscribe(hub, client, received);
    await vi.waitFor(() => expect(writes).toHaveLength(1));

    getCallbacks().onChatItem?.({ session: "work", itemId: "history-item",
      payload: chat("assistant", "履歴", "codex-item-history-item") });
    getCallbacks().onChatItem?.({ session: "work", itemId: "live-item",
      payload: chat("assistant", "境界の新着", "codex-item-live-item") });
    writes[0]!(chat("assistant", "履歴", "codex-turn-1"));
    writes[0]!(chat("system", "", HISTORY_DONE_STREAM_ID));

    const texts = received.flatMap((message) => message?.payload?.role === "assistant"
      ? [message.payload.text] : []);
    expect(texts).toEqual(["履歴", "境界の新着"]);
    expect(tails[0]!.stopped).toBe(true);

    getCallbacks().onChatItem?.({ session: "work", itemId: "live-2",
      payload: chat("assistant", "TUI からの turn", "codex-item-live-2") });
    getCallbacks().onModel?.("work", "gpt-one-source");
    writes[0]!(chat("system", "gpt-one-source", "pc:model")); // stop と競合しても rollout marker は無視。
    expect(received.filter((message) => message?.payload?.text === "TUI からの turn")).toHaveLength(1);
    expect(received.filter((message) => message?.payload?.text === "gpt-one-source")).toHaveLength(1);
  });

  test("App Server 不達時は rollout を history 後も tail し、live marker は抑止する", async () => {
    const { hub, writes, tails } = makeCodexStreamingHub({ subscribeFails: true });
    const client = {}, received: any[] = [];
    subscribe(hub, client, received);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0]!(chat("assistant", "履歴", "codex-turn-1"));
    writes[0]!(chat("system", "", HISTORY_DONE_STREAM_ID));
    writes[0]!(chat("assistant", "fallback live", "codex-turn-2"));
    writes[0]!(chat("system", "gpt-duplicate", "pc:model"));

    expect(tails[0]!.stopped).toBe(false);
    expect(received.filter((message) => message?.payload?.text === "fallback live")).toHaveLength(1);
    expect(received.filter((message) => message?.payload?.text === "gpt-duplicate")).toHaveLength(0);
  });

  test("接続断 fallback の再走査は既配信本文を occurrence 単位で除外する", async () => {
    const { hub, writes, getCallbacks } = makeCodexStreamingHub();
    const client = {}, received: any[] = [];
    subscribe(hub, client, received);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0]!(chat("assistant", "履歴", "codex-turn-1"));
    writes[0]!(chat("system", "", HISTORY_DONE_STREAM_ID));
    getCallbacks().onChatItem?.({ session: "work", itemId: "live-1",
      payload: chat("assistant", "同じ本文", "codex-item-live-1") });
    getCallbacks().onDisconnect?.("work", new Error("closed"));
    expect(writes).toHaveLength(2);

    writes[1]!(chat("assistant", "履歴", "codex-turn-1"));
    writes[1]!(chat("assistant", "同じ本文", "codex-turn-2"));
    writes[1]!(chat("assistant", "切断中の新着", "codex-turn-3"));
    writes[1]!(chat("system", "", HISTORY_DONE_STREAM_ID));
    expect(received.filter((message) => message?.payload?.text === "同じ本文")).toHaveLength(1);
    expect(received.filter((message) => message?.payload?.text === "切断中の新着")).toHaveLength(1);
  });
});
