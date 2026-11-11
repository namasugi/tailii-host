// apiAgentIntegration.test.ts — API 作業のワイヤー（golden）・メタデータ・SessionBackend・hub への合流のテスト。

import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeControlMessage, encodeControlMessage, ProtocolDecodeError, type SessionInfo } from "../src/protocol.js";
import { decodeHubClientLine, decodeHubServerLine, encodeHubMessage } from "../src/hub/hubProtocol.js";
import { CompositeSessionBackend, type SessionBackend } from "../src/backend/sessionBackend.js";
import { ApiAgentSessionBackend, ApiAgentUnsupportedError } from "../src/backend/apiAgentBackend.js";
import { ApiAgentSessionStore } from "../src/apiAgent/sessionState.js";
import { ApiAgentRejectedError } from "../src/apiAgent/config.js";
import { SessionHub, type ApiAgentHubCallbacks, type ApiAgentHubRuntime } from "../src/hub/sessionHub.js";
import { reaperTick } from "../src/hub/reaper.js";
import { writeHeartbeat, listHeartbeatSessions } from "../src/sessions/heartbeat.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const CONV = "7b2c6a3f-ba60-45fd-89ae-cba51afaf7dc";
const CONFIG = { model: "claude-haiku-5-5", permissionMode: "default" as const, budget: { turnUsd: 0.5, conversationUsd: 5, maxTurns: 20 } };
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("ワイヤー（api-agent）", () => {
  test("golden 全行が byte-exact でラウンドトリップする", () => {
    const lines = readFileSync(join(repoRoot, "protocol", "api-agent-v1.ndjson"), "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
  });

  test("session_start: executionRoute が api 以外は端末（従来）。api なら apiAgent 必須・キー本体は受け付けない", () => {
    const base = { type: "session_start", v: 2, id: "r", cwd: "/w", name: "cs-a" };
    expect(decodeControlMessage(JSON.stringify({ ...base, executionRoute: "future" }))).toEqual(base);
    expect(() => decodeControlMessage(JSON.stringify({ ...base, executionRoute: "api" }))).toThrow(ProtocolDecodeError);
    expect(() => decodeControlMessage(JSON.stringify({ ...base, executionRoute: "api",
      apiAgent: { ...CONFIG, keySource: { mode: "custom", apiKey: "sk-ant-api03-xxxxxxxxxxxxxxxx" } } }))).toThrow(ProtocolDecodeError);
    expect(() => decodeControlMessage(JSON.stringify({ ...base, executionRoute: "api",
      apiAgent: { ...CONFIG, permissionMode: "bypassPermissions" } }))).toThrow(ProtocolDecodeError);
  });

  test("api_agent_status の未知の outcome / error は欄なしにする（新しい host の値で落ちない）", () => {
    const decoded = decodeControlMessage(JSON.stringify({ type: "api_agent_status", v: 2, session: "s", state: "idle", model: "m",
      budget: CONFIG.budget, usage: { totalUsd: 0, turns: 0, unconfirmedTurns: 0 }, queued: 0, outcome: "future", error: "future" }));
    expect(decoded).not.toHaveProperty("outcome");
    expect(decoded).not.toHaveProperty("error");
  });

  test("hub 内部プロトコル: api_agent_open / configure / interrupt / result", () => {
    const open = { type: "api_agent_open", id: "1", session: "cs-a", conversationId: CONV, cwd: "/w", config: CONFIG, resume: false } as const;
    expect(decodeHubClientLine(encodeHubMessage(open))).toEqual(open);
    expect(decodeHubClientLine(JSON.stringify({ ...open, config: { ...CONFIG, keySource: { mode: "custom", apiKey: "k" } } }))).toBeNull();
    expect(decodeHubClientLine(JSON.stringify({ type: "api_agent_interrupt", id: "2", session: "cs-a" }))).toEqual({ type: "api_agent_interrupt", id: "2", session: "cs-a" });
    const result = { type: "api_agent_result", id: "1", status: "failed", error: "no_api_key" } as const;
    expect(decodeHubServerLine(encodeHubMessage(result))).toEqual(result);
    expect(decodeHubServerLine(JSON.stringify({ ...result, error: "unknown_code" }))).toBeNull();
  });
});

describe("メタデータと SessionBackend", () => {
  test("executionRoute を保存・読み直す（未知値は捨てる）", () => {
    const store = makeTempStore();
    store.put({ name: "cs-a", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, providerSessionId: CONV, executionRoute: "api" });
    expect(store.get("cs-a")?.executionRoute).toBe("api");
  });

  test("Composite は executionRoute:api の会話を API 作業のバックエンドへ送り、一覧に含める", async () => {
    const store = makeTempStore();
    const sessions = new ApiAgentSessionStore(makeTempDir("api-agent-backend-sessions"));
    store.put({ name: "cs-api", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, providerSessionId: CONV, executionRoute: "api" });
    store.put({ name: "cs-term", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: "other" });
    sessions.put({ name: "cs-api", conversationId: CONV, cwd: "/w", config: CONFIG, openedAt: 1 });
    const submitted: string[] = [];
    const disposed: string[] = [];
    const api = new ApiAgentSessionBackend({ store, sessions, submit: async (name, text) => { submitted.push(`${name}:${text}`); }, dispose: (name) => disposed.push(name) });
    const terminalCalls: string[] = [];
    const fakeTerminal = (kind: string, infos: SessionInfo[]): SessionBackend => ({
      store, list: async () => infos, reattach: async () => { throw new Error("x"); },
      kill: async (name) => { terminalCalls.push(`${kind}:kill:${name}`); },
      sendKeys: async (name) => { terminalCalls.push(`${kind}:keys:${name}`); },
      sendTextSubmit: async (name) => { terminalCalls.push(`${kind}:submit:${name}`); },
      sendQueuedNow: async () => ({ status: "nothing_queued" }), clearInputBox: async () => false,
      sendLoginCode: async () => undefined, capturePane: async () => "", captureVisibleAnsi: async () => "",
      agentProcessAlive: async () => true, setDisplayTitle: async () => undefined,
    });
    const composite = new CompositeSessionBackend({
      store, api,
      tmux: fakeTerminal("tmux", [{ name: "cs-term", cwd: "/w", alive: true, backend: "tmux" }]),
      herdr: fakeTerminal("herdr", []),
    });
    const listed = await composite.list();
    expect(listed.map((info) => info.name)).toEqual(["cs-api", "cs-term"]);
    expect(listed[0]).toEqual({ name: "cs-api", cwd: "/w", alive: true, agent: "claude", executionRoute: "api", claudeSessionId: CONV, providerSessionId: CONV });
    await composite.sendTextSubmit("cs-api", "hello");
    await composite.sendTextSubmit("cs-term", "hi");
    await composite.kill("cs-api");
    expect(submitted).toEqual(["cs-api:hello"]);
    expect(disposed).toEqual(["cs-api"]);
    expect(terminalCalls).toEqual(["tmux:submit:cs-term"]);
    await expect(composite.sendKeys("cs-api", ["Escape"])).rejects.toBeInstanceOf(ApiAgentUnsupportedError);
    expect(await composite.capturePane("cs-api")).toBe("");
    expect((await composite.reattach("cs-api")).kind).toBe("attached");
    sessions.remove("cs-api");
    expect((await composite.reattach("cs-api")).kind).toBe("notFound");
    expect(await composite.agentProcessAlive("cs-api")).toBe(false);
  });

  test("reaper は pane の無い API 作業の会話の heartbeat を「消滅」として回収しない", async () => {
    const store = makeTempStore();
    const heartbeatDir = makeTempDir("api-agent-reaper");
    store.put({ name: "cs-api", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, executionRoute: "api" });
    store.put({ name: "cs-gone", cwd: "/w", createdAt: 1, agent: "claude" });
    writeHeartbeat(heartbeatDir, "cs-api", { ts: 100 } as never);
    writeHeartbeat(heartbeatDir, "cs-gone", { ts: 100 } as never);
    const tick = (open: boolean) => reaperTick({
      runner: async (args) => args[0] === "list-sessions" ? ok("") : ok(""),
      heartbeatDir, metadataStore: store, timeoutSeconds: 1800, now: 200, herdrOps: null, log: () => undefined,
      apiAgentSessionOpen: () => open,
    } as never);
    expect((await tick(true)).reclaimed).toEqual(["cs-gone"]);
    expect(listHeartbeatSessions(heartbeatDir)).toEqual(["cs-api"]);
    // 閉じた後に残った heartbeat は回収する。
    expect((await tick(false)).reclaimed).toEqual(["cs-api"]);
    expect(listHeartbeatSessions(heartbeatDir)).toEqual([]);
  });
});

class FakeRuntime implements ApiAgentHubRuntime {
  calls: string[] = [];
  answers: unknown[] = [];
  running = false;
  constructor(readonly callbacks: ApiAgentHubCallbacks) {}
  restore(): string[] { this.calls.push("restore"); return []; }
  open(session: string, request: { conversationId: string; resume: boolean }): void {
    if (request.conversationId === "bad") throw new ApiAgentRejectedError("conversation_in_use");
    this.calls.push(`open:${session}:${request.resume}`);
  }
  configure(session: string): void { this.calls.push(`configure:${session}`); }
  async submit(session: string, text: string): Promise<"started" | "queued"> {
    if (text === "no-key") throw new ApiAgentRejectedError("no_api_key");
    this.calls.push(`submit:${session}:${text}`);
    return "started";
  }
  interrupt(session: string): boolean { this.calls.push(`interrupt:${session}`); return this.running; }
  dispose(session: string): void { this.calls.push(`dispose:${session}`); }
  answerQuestion(id: string, answers: unknown[]): boolean { this.answers.push({ id, answers }); return true; }
  has(): boolean { return true; }
  status(): null { return null; }
  get hasTurnsInFlight(): boolean { return this.running; }
}

describe("SessionHub への合流", () => {
  function makeHub() {
    let runtime: FakeRuntime | null = null;
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("api-agent-hub"), metadataStore: makeTempStore(), timeoutSeconds: 1800,
      apiAgentFactory: (callbacks) => { runtime = new FakeRuntime(callbacks); return runtime; },
    });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    const send = (message: Record<string, unknown>) => hub.handleClientMessage(client, JSON.stringify(message));
    return { hub, send, received, runtime: () => runtime! };
  }

  test("open / configure / interrupt を runtime へ渡し、結果を返す。失敗は固定の理由コード", () => {
    const { hub, send, received, runtime } = makeHub();
    expect(hub.restoreApiAgents()).toEqual([]);
    send({ type: "api_agent_open", id: "o1", session: "cs-a", conversationId: CONV, cwd: "/w", config: CONFIG, resume: true });
    send({ type: "api_agent_open", id: "o2", session: "cs-b", conversationId: "bad", cwd: "/w", config: CONFIG, resume: false });
    send({ type: "api_agent_configure", id: "c1", session: "cs-a", config: CONFIG });
    runtime().running = true;
    send({ type: "api_agent_interrupt", id: "i1", session: "cs-a" });
    expect(received).toEqual([
      { type: "api_agent_result", id: "o1", status: "ok" },
      { type: "api_agent_result", id: "o2", status: "failed", error: "conversation_in_use" },
      { type: "api_agent_result", id: "c1", status: "ok" },
      { type: "api_agent_result", id: "i1", status: "ok", interrupted: true },
    ]);
    expect(runtime().calls).toEqual(["restore", "open:cs-a:true", "configure:cs-a", "interrupt:cs-a"]);
    expect(hub.hasApiAgentTurnsInFlight).toBe(true);
  });

  test("factory が無い hub は not_open で断る", () => {
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("api-agent-hub-none"), metadataStore: makeTempStore(), timeoutSeconds: 1800 });
    const received: unknown[] = [];
    const client = {};
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "api_agent_interrupt", id: "i", session: "s" }));
    expect(received).toEqual([{ type: "api_agent_result", id: "i", status: "failed", error: "not_open" }]);
  });

  test("session_retire で作業プロセスを止める（actor が無くても）", async () => {
    const { hub, send, runtime } = makeHub();
    hub.restoreApiAgents();
    send({ type: "session_retire", session: "cs-a" });
    expect(runtime().calls).toContain("dispose:cs-a");
  });

  test("処理中・状態・設問を会話へ配り、設問の回答は API 作業へ返す（first-wins）", async () => {
    const { hub, send, received, runtime } = makeHub();
    hub.restoreApiAgents();
    const watcher = {};
    const events: unknown[] = [];
    hub.registerClient(watcher, (line) => events.push(decodeHubServerLine(line)));
    hub.handleClientMessage(watcher, JSON.stringify({ type: "conversation_subscribe", session: "cs-a" }));
    runtime().callbacks.onProcessing("cs-a", "active");
    runtime().callbacks.onStatus("cs-a", { type: "api_agent_status", v: 2, session: "cs-a", state: "running", model: "m", budget: CONFIG.budget, usage: { totalUsd: 0, turns: 0, unconfirmedTurns: 0 }, queued: 0 });
    const questions = [{ header: "H", question: "Q?", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];
    runtime().callbacks.onQuestion({ session: "cs-a", id: "api-agent-question-1", questions });
    expect(events).toContainEqual({ type: "session_processing", session: "cs-a", state: "active" });
    expect(events).toContainEqual(expect.objectContaining({ type: "conversation_event", session: "cs-a", payload: expect.objectContaining({ type: "api_agent_status", state: "running" }) }));
    expect(events).toContainEqual({ type: "question_event", session: "cs-a", event: "prompt", id: "api-agent-question-1", questions });
    send({ type: "question_answer_submit", id: "a1", session: "cs-a", questionId: "api-agent-question-1", answers: [{ questionIndex: 0, selectedOptionIndexes: [1], multiSelect: false }] });
    send({ type: "question_answer_submit", id: "a2", session: "cs-a", questionId: "api-agent-question-1", answers: [] });
    expect(received).toContainEqual({ type: "question_answer_result", id: "a1", status: "accepted" });
    expect(received).toContainEqual({ type: "question_answer_result", id: "a2", status: "already_resolved" });
    expect(runtime().answers).toEqual([{ id: "api-agent-question-1", answers: [{ questionIndex: 0, selectedOptionIndexes: [1], multiSelect: false }] }]);
  });

  test("apiAgentSubmit は runtime の submit へ。拒否は ApiAgentRejectedError のまま返す", async () => {
    const { hub, runtime } = makeHub();
    hub.restoreApiAgents();
    expect(await hub.apiAgentSubmit("cs-a", "hello")).toBe("started");
    await expect(hub.apiAgentSubmit("cs-a", "no-key")).rejects.toMatchObject({ code: "no_api_key" });
    expect(runtime().calls).toContain("submit:cs-a:hello");
  });

  test("chat_send → chatInjector で API 作業へ渡し、始められなければ配送されていない失敗として返す", async () => {
    // hubDaemon の chatInjector と同じ振り分けを再現する（executionRoute:api → apiAgentSubmit）。
    const { ChatInjectionRejectedError } = await import("../src/backend/tmux.js");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "cs-a", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, executionRoute: "api" });
    let runtime: FakeRuntime | null = null;
    const hub: SessionHub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("api-agent-hub-chat"), metadataStore, timeoutSeconds: 1800,
      apiAgentFactory: (callbacks) => { runtime = new FakeRuntime(callbacks); return runtime; },
      chatInjector: async (text, session) => {
        try { await hub.apiAgentSubmit(session, text); }
        catch (error) {
          if (error instanceof ApiAgentRejectedError) throw new ChatInjectionRejectedError(error.message);
          throw error;
        }
      },
    });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "s1", session: "cs-a", clientMessageId: "m1", text: "hello" }));
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "s2", session: "cs-a", clientMessageId: "m2", text: "no-key" }));
    await vi.waitFor(() => expect(received.filter((m) => (m as { type: string }).type === "chat_send_result")).toHaveLength(2));
    expect(received).toContainEqual({ type: "chat_send_result", id: "s1", status: "accepted" });
    expect(received).toContainEqual(expect.objectContaining({ type: "chat_send_result", id: "s2", status: "failed",
      error: expect.stringContaining("API キーが見つかりません") }));
    expect(runtime!.calls).toContain("submit:cs-a:hello");
  });
});
