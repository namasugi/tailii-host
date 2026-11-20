import { afterEach, expect, test, vi } from "vitest";
import type { ClaudeTurnLifecycleEvent } from "../src/chat/transcriptTailer.js";
import type { CodexNativeTurnControllerOptions } from "../src/codex/codexNativeTurnController.js";
import type { ChatEventInput } from "../src/hub/chatEventLog.js";
import { decodeHubServerLine } from "../src/hub/hubProtocol.js";
import { SessionHub, type ApiAgentHubCallbacks, type SessionHubOptions } from "../src/hub/sessionHub.js";
import type { UsageLimitWaitState } from "../src/shared/usageLimitWait.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const SESSION = "work";
const hubs: SessionHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

function harness(options: Partial<SessionHubOptions> = {}) {
  const events: ChatEventInput[] = [];
  const received: unknown[] = [];
  const metadataStore = makeTempStore();
  metadataStore.put({ name: SESSION, cwd: "/tmp/work", createdAt: 0, providerSessionId: "conv-id", claudeSessionId: "old-id" });
  let lifecycle: ((event: ClaudeTurnLifecycleEvent) => void) | undefined;
  let usage: ((state: UsageLimitWaitState | null) => void) | undefined;
  const hub = new SessionHub({
    runner: async () => ok(""), metadataStore, heartbeatDir: makeTempDir("events-hb"), timeoutSeconds: 1800,
    now: () => 100, nowMs: () => 100_000, transcriptPathFor: () => null,
    questionInjector: async () => {}, chatInjector: async () => {},
    chatEvents: { append: (event) => events.push(event) },
    tailFactory: (_write, _codex, callback) => {
      lifecycle = callback;
      return { open() {}, stop() {} };
    },
    previewPumpFactory: (_write, _mode, _interval, callback) => {
      usage = callback;
      return { start() {}, stop() {} };
    },
    ...options,
  });
  hubs.push(hub);
  const client = {};
  hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
  const send = (body: object, session = SESSION) => hub.handleClientMessage(client, JSON.stringify({ session, ...body }));
  const processing = (state: "active" | "done", event?: string, error?: string) =>
    hub.handleRelayMessage({ type: "session_processing", session: SESSION, state, event, error });
  const turnEnds = () => events.filter((event) => event.type === "turn_ended");
  const prompt = (id: string) => hub.handleRelayMessage({ type: "question_event", session: SESSION,
    event: "prompt", id, questions: [{ header: "色", question: "どの色？", multiSelect: false, options: [{ label: "青" }] }] });
  return { hub, events, received, send, processing, turnEnds, prompt, metadataStore,
    lifecycle: (event: ClaudeTurnLifecycleEvent) => lifecycle!(event),
    usage: (state: UsageLimitWaitState | null) => usage!(state) };
}

test("完了は 3 秒待つ。処理再開・廃棄・close で予約を消す", () => {
  vi.useFakeTimers();
  const h = harness();
  h.processing("active", "UserPromptSubmit");
  h.processing("active", "PreToolUse");
  h.processing("done", "Stop");
  vi.advanceTimersByTime(2_999);
  expect(h.events).toEqual([{ type: "turn_started", session: SESSION, conversationId: "conv-id", agent: "claude" }]);
  h.processing("active", "UserPromptSubmit");
  vi.advanceTimersByTime(1);
  expect(h.turnEnds()).toEqual([]);
  h.processing("done", "Stop");
  vi.advanceTimersByTime(3_000);
  expect(h.turnEnds()).toMatchObject([{ outcome: "completed" }]);
  h.processing("active");
  h.processing("done", "Stop");
  h.send({ type: "session_retire" });
  h.processing("active");
  h.processing("done", "Stop");
  h.hub.close();
  vi.advanceTimersByTime(3_000);
  expect(h.turnEnds()).toHaveLength(1);
});

test("Claude の失敗・制限・中断は処理中を終わらせた経路でだけ記録する", () => {
  vi.useFakeTimers();
  const h = harness();
  h.send({ type: "conversation_subscribe" });
  h.processing("active");
  h.processing("done", "StopFailure", "server_error");
  h.lifecycle({ kind: "api_error", atMs: 100_001, errorKind: "server_error" });
  h.processing("active");
  h.processing("done", "StopFailure", "rate_limit");
  h.usage({ kind: "waiting", resumeAt: "3pm" });
  h.usage({ kind: "resuming" });
  h.processing("active");
  h.lifecycle({ kind: "api_error", atMs: 100_002, errorKind: "rate_limit" });
  h.processing("done", "StopFailure", "rate_limit");
  h.processing("active");
  h.lifecycle({ kind: "interrupted", atMs: 100_003 });
  h.processing("active", "PostToolUse");
  h.processing("active", "UserPromptSubmit");
  h.lifecycle({ kind: "api_error", atMs: 100_004, errorKind: "内部のエラー本文" });
  expect(h.turnEnds()).toMatchObject([
    { outcome: "failed", error: "server_error" }, { outcome: "failed", error: "rate_limit" },
    { outcome: "failed", error: "rate_limit" }, { outcome: "interrupted" }, { outcome: "failed", error: "unknown" },
  ]);
  expect(h.events.filter((event) => event.type === "usage_limit")).toMatchObject([
    { state: "waiting", resumeAt: "3pm" }, { state: "resuming" }, { state: "resumed" },
  ]);
  expect(h.events.filter((event) => event.type === "turn_started")).toHaveLength(5);
});

test("設問の ID ごとに提示と解決を記録する", async () => {
  const h = harness();
  h.prompt("q1");
  h.prompt("q1");
  h.send({ type: "question_answer_submit", id: "answer", questionId: "q1",
    answers: [{ questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false }] });
  await vi.waitFor(() => expect(h.received).toContainEqual({
    type: "question_answer_result", id: "answer", status: "accepted",
  }));
  h.prompt("q2");
  for (let i = 0; i < 2; i++) h.hub.handleRelayMessage({ type: "question_event", session: SESSION, event: "dismiss", id: "q2" });
  h.processing("active");
  h.prompt("q3");
  h.processing("done");
  h.prompt("q4");
  h.send({ type: "session_retire" });
  expect(h.events.filter((event) => event.type === "question_asked")).toMatchObject(
    ["q1", "q2", "q3", "q4"].map((questionId) => ({ questionId, blocking: true })),
  );
  expect(h.events.filter((event) => event.type === "question_resolved")).toMatchObject([
    { questionId: "q1", reason: "answered" },
    { questionId: "q2", reason: "dismissed", by: "terminal" },
    { questionId: "q3", reason: "turn_ended" },
    { questionId: "q4", reason: "session_ended" },
  ]);
});

test("承認の知らせを合流し、古い relay と重なっても ID ごとに 1 回ずつ記録する", () => {
  const h = harness();
  const request = { type: "approval_event", event: "request", session: SESSION, id: "a1", tool: "Bash" } as const;
  h.hub.handleRelayMessage(request);
  expect(h.received).toEqual([]);
  h.hub.handleRelayMessage({ type: "remote_pending", kind: "approval", v: 1, session: SESSION,
    id: "a1", tool: "Bash", summary: "承認本文" });
  h.hub.handleRelayMessage({ type: "approval_event", event: "resolved", session: SESSION,
    id: "a1", decision: "allow", by: "app" });
  h.hub.handleRelayMessage({ type: "remote_pending_cleared", kind: "approval", v: 1, session: SESSION, id: "a1" });
  h.hub.handleRelayMessage(request);
  expect(h.hub.requestPush({ kind: "approval", id: "a2", session: SESSION })).toBe(false);
  h.hub.handleRelayMessage({ type: "remote_pending", kind: "approval", v: 1, session: SESSION,
    id: "a3", summary: "承認本文" });
  h.hub.handleRelayMessage({ type: "remote_pending_cleared", kind: "approval", v: 1, session: SESSION, id: "a3" });
  h.send({ type: "session_retire" });
  expect(h.events.filter((event) => event.type.startsWith("approval_"))).toMatchObject([
    { type: "approval_requested", approvalId: "a1", tool: "Bash" },
    { type: "approval_resolved", approvalId: "a1", decision: "allow", by: "app" },
    { type: "approval_requested", approvalId: "a2" },
    { type: "approval_requested", approvalId: "a3" },
    { type: "approval_resolved", approvalId: "a3" },
    { type: "approval_resolved", approvalId: "a2" },
  ]);
  expect(JSON.stringify(h.events)).not.toContain("承認本文");
});

test("配送台帳の設定が無くても CLI とアプリの配送を記録する", async () => {
  const h = harness();
  for (const id of ["cli-one", "app-one"]) {
    h.send({ type: "chat_send", id, clientMessageId: id, text: "送信本文" });
  }
  await vi.waitFor(() => expect(h.events).toMatchObject([
    { type: "message_delivered", origin: "cli", clientMessageId: "cli-one" },
    { type: "message_delivered", origin: "app", clientMessageId: "app-one" },
  ]));
  expect(JSON.stringify(h.events)).not.toContain("送信本文");
});

test("会話の終了理由を変換する。actor が無い場合も記録する", () => {
  const h = harness();
  h.hub["retireSession"](SESSION, "Session was killed");
  h.hub["retireSession"](SESSION, "Agent process ended");
  h.hub["retireSession"](SESSION, "Session disappeared");
  h.send({ type: "session_retire" });
  expect(h.events).toMatchObject(["killed", "agent_exited", "disappeared", "retired"].map((reason) => ({
    type: "session_ended", reason,
  })));
});

test("書き手の例外は会話の処理を変えず、書き手の省略もできる", () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const failing = harness({ log, chatEvents: { append() { throw new Error("書けない"); } } });
  const absent = harness({ chatEvents: undefined });
  for (const h of [failing, absent]) {
    h.processing("active");
    expect(h.hub.actors.get(SESSION)?.processingSince).toBe(100);
    h.processing("done", "Stop");
    vi.advanceTimersByTime(3_000);
    expect(h.hub.actors.get(SESSION)?.processingSince).toBeNull();
  }
  expect(log.mock.calls.filter(([message]) => message.includes("chat events 記録失敗"))).toHaveLength(1);
  expect(absent.events).toEqual([]);
});

test("Codex はターン ID、API 作業は処理中からの遷移で 1 回ずつ終端を記録する", () => {
  vi.useFakeTimers();
  let codex: CodexNativeTurnControllerOptions | undefined;
  let api: ApiAgentHubCallbacks | undefined;
  const h = harness({
    codexTurnControllerFactory: (options) => {
      codex = options;
      return { startTurn: async () => "t1", closeSession() {}, close() {} };
    },
    apiAgentFactory: (callbacks) => {
      api = callbacks;
      return { restore: () => [], open() {}, configure() {}, submit: async () => "started", interrupt: () => true,
        dispose() {}, close: () => "closed", answerQuestion: () => true, has: () => false, status: () => null,
        hasTurnsInFlight: false };
    },
  });
  h.metadataStore.put({ name: "codex", agent: "codex", cwd: "/tmp/work", createdAt: 0, providerSessionId: "thread-id" });
  h.hub["ensureCodexTurnController"]();
  h.hub.restoreApiAgents();
  for (const status of ["completed", "failed", "interrupted"] as const) {
    codex!.onProcessing!("codex", "active");
    const outcome = { status, turnId: status, errorMessage: "エラー本文" };
    codex!.onProcessing!("codex", "done", outcome);
    codex!.onProcessing!("codex", "done", outcome);
    vi.advanceTimersByTime(3_000);
  }
  codex!.onApprovalEvent!({ session: "codex", id: "approval", event: "request", tool: "Bash" });
  codex!.onApprovalEvent!({ session: "codex", id: "approval", event: "resolved", decision: "deny", by: "cli" });
  for (const outcome of ["success", "failed", "interrupted"] as const) {
    api!.onProcessing("api", "active");
    api!.onProcessing("api", "done");
    const status = { type: "api_agent_status", v: 2, session: "api", state: "idle", outcome } as Parameters<ApiAgentHubCallbacks["onStatus"]>[1];
    api!.onStatus("api", status);
    api!.onStatus("api", status);
    vi.advanceTimersByTime(3_000);
  }
  expect(h.turnEnds()).toMatchObject([
    { session: "codex", agent: "codex", outcome: "completed" },
    { session: "codex", outcome: "failed", error: "codex_turn_failed" },
    { session: "codex", outcome: "interrupted" },
    { session: "api", outcome: "completed" },
    { session: "api", outcome: "failed", error: "api_agent_failed" },
    { session: "api", outcome: "interrupted" },
  ]);
  expect(h.events.filter((event) => event.type.startsWith("approval_"))).toMatchObject([
    { type: "approval_requested", agent: "codex", approvalId: "approval" },
    { type: "approval_resolved", agent: "codex", approvalId: "approval", decision: "deny", by: "cli" },
  ]);
});
