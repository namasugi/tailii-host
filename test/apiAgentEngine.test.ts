// apiAgentEngine.test.ts — engine 側の API 作業（session_start の executionRoute:"api"・中断キー・設定変更）。

import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { startApiAgentSession, configureApiAgent } from "../src/engine/handlers/apiAgent.js";
import { modeHandlers } from "../src/engine/handlers/mode.js";
import type { HubClientMessage, HubServerMessage } from "../src/hub/hubProtocol.js";
import type { ControlMessage, SessionInfo } from "../src/protocol.js";
import { makeTempDir, makeTempStore } from "./helpers.js";

const CONFIG = { model: "claude-haiku-5-5", permissionMode: "default" as const, budget: { turnUsd: 0.5, conversationUsd: 5, maxTurns: 20 } };
const CONV = "7b2c6a3f-ba60-45fd-89ae-cba51afaf7dc";

function makeCtx(options: { hubReply?: (request: HubClientMessage) => HubServerMessage; sessions?: SessionInfo[];
  waitUntilReady?: (timeoutMs: number) => Promise<boolean> } = {}) {
  const written: ControlMessage[] = [];
  const hubRequests: HubClientMessage[] = [];
  const hubSent: HubClientMessage[] = [];
  const metadataStore = makeTempStore();
  const ctx = {
    writer: { write: (message: ControlMessage) => { written.push(message); } },
    state: { negotiatedVersion: 2 },
    metadataStore,
    sessionManager: { list: async () => options.sessions ?? [], sendKeys: async () => { throw new Error("terminal keys"); } },
    hubRpc: async (request: HubClientMessage) => {
      hubRequests.push(request);
      return options.hubReply?.(request) ?? { type: "api_agent_result", id: (request as { id: string }).id, status: "ok" };
    },
    hubLink: { send: (message: HubClientMessage) => { hubSent.push(message); }, waitUntilReady: options.waitUntilReady },
    activeChatSession: { name: null as string | null },
    processingSessions: new Set<string>(),
    backgroundChatSessions: new Set<string>(),
    lastServerSeq: new Map<string, number>(),
    consumeBackgroundSyncHint: () => undefined,
    watchBackgroundSession: () => undefined,
    requestHubState: async () => null,
  };
  return { ctx: ctx as never, written, hubRequests, hubSent, metadataStore };
}

function startMessage(cwd: string, extra: Record<string, unknown> = {}): Extract<ControlMessage, { type: "session_start" }> {
  return { type: "session_start", v: 2, id: "req-1", cwd, name: "cs-api", executionRoute: "api", apiAgent: CONFIG, ...extra } as never;
}

describe("engine: API 作業の会話の作成", () => {
  test("メタデータ（executionRoute:api・会話 id）を書き、hub に開かせ、購読して一覧で応答する（pane は作らない）", async () => {
    const cwd = makeTempDir("api-agent-engine-cwd");
    const t = makeCtx();
    await startApiAgentSession(startMessage(cwd), t.ctx);
    const meta = t.metadataStore.get("cs-api")!;
    expect(meta).toMatchObject({ cwd: fs.realpathSync(cwd) === cwd ? cwd : meta.cwd, agent: "claude", executionRoute: "api" });
    expect(meta.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.providerSessionId).toBe(meta.claudeSessionId);
    expect(meta.backend).toBeUndefined();
    expect(t.hubRequests).toEqual([expect.objectContaining({ type: "api_agent_open", session: "cs-api", conversationId: meta.claudeSessionId, config: CONFIG, resume: false })]);
    expect(t.hubSent).toContainEqual(expect.objectContaining({ type: "conversation_subscribe", session: "cs-api" }));
    expect(t.written.at(-1)).toMatchObject({ type: "session_list_response", id: "req-1", adoptedName: "cs-api" });
  });

  test("既存の会話を再開するときは resumeSessionId を会話 id に使う", async () => {
    const cwd = makeTempDir("api-agent-engine-resume");
    const t = makeCtx();
    await startApiAgentSession(startMessage(cwd, { resumeSessionId: CONV }), t.ctx);
    expect(t.hubRequests[0]).toMatchObject({ conversationId: CONV, resume: true });
  });

  test("hub の接続ができるまで待ち、API 会話の再開要求を一度だけ送る", async () => {
    let ready!: (value: boolean) => void;
    const waitUntilReady = vi.fn(() => new Promise<boolean>((resolve) => { ready = resolve; }));
    const t = makeCtx({ waitUntilReady });
    const pending = startApiAgentSession(startMessage(makeTempDir("api-agent-engine-cold"), { resumeSessionId: CONV }), t.ctx);
    await vi.waitFor(() => expect(waitUntilReady).toHaveBeenCalledWith(10_000));
    expect(t.hubRequests).toEqual([]);
    expect(t.metadataStore.get("cs-api")).toBeNull();
    ready(true);
    expect(await pending).toBe(true);
    expect(t.hubRequests).toEqual([expect.objectContaining({ type: "api_agent_open", conversationId: CONV, resume: true })]);
    expect(t.written.at(-1)).toMatchObject({ type: "session_list_response", adoptedName: "cs-api" });
  });

  test("接続待ちが失敗したら要求を送らず、保存済みのメタデータを保つ", async () => {
    const t = makeCtx({ waitUntilReady: async () => false });
    const meta = { name: "cs-api", cwd: "/previous", createdAt: 1, agent: "claude" as const,
      providerSessionId: CONV, executionRoute: "api" as const };
    t.metadataStore.put(meta);
    expect(await startApiAgentSession(startMessage(makeTempDir("api-agent-engine-offline"), { resumeSessionId: CONV }), t.ctx)).toBe(false);
    expect(t.hubRequests).toEqual([]);
    expect(t.metadataStore.get("cs-api")).toEqual(meta);
    expect(t.written).toEqual([expect.objectContaining({ type: "error", code: "launch_failed" })]);
  });

  test("接続待ちの間に同名の端末会話が開かれたら、その記録を上書きしない", async () => {
    let ready!: (value: boolean) => void;
    const waitUntilReady = vi.fn(() => new Promise<boolean>((resolve) => { ready = resolve; }));
    const t = makeCtx({ waitUntilReady });
    const pending = startApiAgentSession(startMessage(makeTempDir("api-agent-engine-name-race"), { resumeSessionId: CONV }), t.ctx);
    await vi.waitFor(() => expect(waitUntilReady).toHaveBeenCalledOnce());
    const terminal = { name: "cs-api", cwd: "/terminal", createdAt: 2, agent: "claude" as const,
      providerSessionId: CONV, backend: "herdr" as const, herdrPaneId: "w1:p1" };
    t.metadataStore.put(terminal);
    ready(true);
    expect(await pending).toBe(false);
    expect(t.hubRequests).toEqual([]);
    expect(t.metadataStore.get("cs-api")).toEqual(terminal);
    expect(t.written).toEqual([expect.objectContaining({ type: "error", code: "launch_failed", message: expect.stringContaining("別の場所") })]);
  });

  test("接続待ちの間に同じ会話が端末側で開かれたら、最新の一覧で断る", async () => {
    let ready!: (value: boolean) => void;
    const waitUntilReady = vi.fn(() => new Promise<boolean>((resolve) => { ready = resolve; }));
    const sessions: SessionInfo[] = [];
    const t = makeCtx({ waitUntilReady, sessions });
    const cwd = makeTempDir("api-agent-engine-conversation-race");
    const pending = startApiAgentSession(startMessage(cwd, { resumeSessionId: CONV }), t.ctx);
    await vi.waitFor(() => expect(waitUntilReady).toHaveBeenCalledOnce());
    sessions.push({ name: "cs-terminal", cwd, alive: true, agent: "claude", providerSessionId: CONV, backend: "tmux" });
    ready(true);
    expect(await pending).toBe(false);
    expect(t.hubRequests).toEqual([]);
    expect(t.metadataStore.get("cs-api")).toBeNull();
    expect(t.written).toEqual([expect.objectContaining({ type: "error", code: "launch_failed", message: expect.stringContaining("別の場所") })]);
  });

  test("同名の別の API 会話の記録は、再開を断るときにも上書きしない", async () => {
    const t = makeCtx({ hubReply: (request) => ({ type: "api_agent_result", id: (request as { id: string }).id,
      status: "failed", error: "conversation_in_use" }) });
    const otherId = "98cc4122-019a-4cf5-aa55-020565ae2eca";
    const other = { name: "cs-api", cwd: "/other", createdAt: 2, agent: "claude" as const,
      providerSessionId: otherId, claudeSessionId: otherId, executionRoute: "api" as const };
    t.metadataStore.put(other);
    expect(await startApiAgentSession(startMessage(makeTempDir("api-agent-engine-api-owner"), { resumeSessionId: CONV }), t.ctx)).toBe(false);
    expect(t.metadataStore.get("cs-api")).toEqual(other);
    expect(t.hubRequests).toEqual([]);
    expect(t.written).toEqual([expect.objectContaining({ type: "error", code: "launch_failed", message: expect.stringContaining("別の場所") })]);
  });

  test("送出後に接続が切れても起動要求を自動再送しない", async () => {
    const t = makeCtx({ waitUntilReady: async () => true, hubReply: () => { throw new Error("Session Hub disconnected during RPC"); } });
    expect(await startApiAgentSession(startMessage(makeTempDir("api-agent-engine-disconnect"), { resumeSessionId: CONV }), t.ctx)).toBe(false);
    expect(t.hubRequests).toHaveLength(1);
    expect(t.written).toEqual([expect.objectContaining({ type: "error", code: "launch_failed" })]);
  });

  test("同じ会話を別の名前の API 作業で開いていればそれを使う", async () => {
    const cwd = makeTempDir("api-agent-engine-alias");
    const t = makeCtx({ sessions: [{ name: "cs-old", cwd, alive: true, agent: "claude", providerSessionId: CONV, executionRoute: "api" }] });
    await startApiAgentSession(startMessage(cwd, { resumeSessionId: CONV }), t.ctx);
    expect(t.hubRequests).toEqual([]);
    expect(t.written.at(-1)).toMatchObject({ type: "session_list_response", adoptedName: "cs-old" });
  });

  test("同じ会話が端末側で動いていれば作らない", async () => {
    const cwd = makeTempDir("api-agent-engine-busy");
    const t = makeCtx({ sessions: [{ name: "cs-term", cwd, alive: true, agent: "claude", providerSessionId: CONV, backend: "tmux" }] });
    await startApiAgentSession(startMessage(cwd, { resumeSessionId: CONV }), t.ctx);
    expect(t.hubRequests).toEqual([]);
    expect(t.written.at(-1)).toMatchObject({ type: "error", code: "launch_failed", message: expect.stringContaining("別の場所") });
    expect(t.metadataStore.get("cs-api")).toBeNull();
  });

  test("作業フォルダが無い・設定が無い・hub が断ったときはエラー（文言に端末名を出さない）", async () => {
    const t = makeCtx({ hubReply: (request) => ({ type: "api_agent_result", id: (request as { id: string }).id, status: "failed", error: "sdk_unavailable" }) });
    await startApiAgentSession(startMessage(path.join(makeTempDir("x"), "missing")), t.ctx);
    await startApiAgentSession(startMessage(makeTempDir("y"), { apiAgent: undefined }), t.ctx);
    await startApiAgentSession(startMessage(makeTempDir("z")), t.ctx);
    const errors = t.written.filter((m) => m.type === "error") as { message: string }[];
    expect(errors.map((e) => e.message)).toEqual([
      "作業フォルダが見つかりません。",
      "API 作業の設定が正しくありません。",
      "API 作業に必要な Agent SDK がホストに入っていません。アプリで「準備する」を選ぶとホストに導入します。",
    ]);
    for (const e of errors) expect(e.message).not.toMatch(/Mac|tmux|herdr/);
  });
});

describe("engine: 中断キーと設定変更", () => {
  test("API 作業の会話では Escape / C-c を中断へ写し、他のキーは断る（端末へは送らない）", async () => {
    const t = makeCtx({ hubReply: (request) => ({ type: "api_agent_result", id: (request as { id: string }).id, status: "ok", interrupted: true }) });
    t.metadataStore.put({ name: "cs-api", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, executionRoute: "api" });
    const handler = modeHandlers.pane_key_send!;
    await handler({ type: "pane_key_send", v: 2, id: "k1", session: "cs-api", key: "Escape" } as never, t.ctx);
    await handler({ type: "pane_key_send", v: 2, id: "k2", session: "cs-api", key: "Enter" } as never, t.ctx);
    expect(t.hubRequests).toEqual([expect.objectContaining({ type: "api_agent_interrupt", session: "cs-api" })]);
    expect(t.written).toEqual([
      { type: "pane_key_send_result", v: 2, id: "k1", ok: true, error: null },
      { type: "pane_key_send_result", v: 2, id: "k2", ok: false, error: "この会話（API 作業）ではこのキーを使えません。" },
    ]);
  });

  test("api_agent_configure を hub へ渡し、結果を返す", async () => {
    const t = makeCtx({ hubReply: (request) => ({ type: "api_agent_result", id: (request as { id: string }).id, status: "failed", error: "not_open" }) });
    await configureApiAgent({ type: "api_agent_configure", v: 2, id: "c1", session: "cs-api", config: CONFIG }, t.ctx);
    expect(t.written).toEqual([{ type: "api_agent_configure_result", v: 2, id: "c1", session: "cs-api", ok: false, error: "not_open" }]);
  });
});
