// apiAgentHandoff.test.ts — 既存の会話の API 作業への引き継ぎ・元へ戻す（api-agent-handoff）。
// 端末・hub・登録簿は偽物。実 API・実 claude は使わない。

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { estimateFirstTurnUsd, inheritPermissionMode, readHandoffContext } from "../src/apiAgent/handoff.js";
import { ApiAgentLedgerStore, emptyLedger } from "../src/apiAgent/ledger.js";
import { ApiAgentManager } from "../src/apiAgent/manager.js";
import { ApiAgentSessionStore } from "../src/apiAgent/sessionState.js";
import { estimateHandoff, handoffToApiAgent, returnToTerminal, type HandoffDeps } from "../src/engine/handlers/apiAgentHandoff.js";
import { killSessionForUser } from "../src/engine/handlers/session.js";
import type { HubClientMessage, HubServerMessage } from "../src/hub/hubProtocol.js";
import type { SessionInfo } from "../src/protocol.js";
import { makeTempDir, makeTempStore } from "./helpers.js";

const CONV = "98cc4122-019a-4cf5-aa55-020565ae2eca";
const CONFIG = { model: "claude-sonnet-5-5", permissionMode: "default" as const, budget: { turnUsd: 1, conversationUsd: 10, maxTurns: 30 } };

describe("見積もりの材料", () => {
  test("最後の応答の usage から文脈の大きさ、最後の permission-mode を読む（実測の行の形）", () => {
    const file = path.join(makeTempDir("handoff-ctx"), `${CONV}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: "permission-mode", permissionMode: "acceptEdits", sessionId: CONV }),
      JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 29066, cache_creation_input_tokens: 38451 } } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 67517, cache_creation_input_tokens: 290 } } }),
      JSON.stringify({ type: "cost-state", totalCostUSD: 0.0097 }),
    ].join("\n") + "\n");
    expect(readHandoffContext(file)).toEqual({ contextTokens: 67809, permissionMode: "acceptEdits", model: "claude-haiku-5-5" });
    expect(readHandoffContext(path.join(path.dirname(file), "none.jsonl"))).toEqual({ contextTokens: null, permissionMode: null, model: null });
  });

  test("初回の概算 = 履歴をキャッシュ書き込み（入力 1.25 倍）として数え、出力の見込みを足す。料金不明は null", () => {
    // Sonnet 5.5: 入力 $2 / 出力 $10（100 万トークン）。67,809 × 2 × 1.25 + 4,000 × 10 = 0.2095…
    expect(estimateFirstTurnUsd(67_809, "claude-sonnet-5-5")).toBe(0.2095);
    expect(estimateFirstTurnUsd(67_809, "unknown-model")).toBeNull();
  });

  test("権限モードは引き継ぐが広げない（自動・全許可・不明は確認あり）", () => {
    expect(inheritPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(inheritPermissionMode("plan")).toBe("plan");
    expect(inheritPermissionMode("auto")).toBe("default");
    expect(inheritPermissionMode("bypassPermissions")).toBe("default");
    expect(inheritPermissionMode(null)).toBe("default");
  });
});

describe("最後に使った実行経路", () => {
  test("台帳に記録し、端末へ戻したら terminal（台帳＝利用額は消さない）。台帳が無い会話には terminal を書かない", () => {
    const store = new ApiAgentLedgerStore(makeTempDir("handoff-route"));
    expect(store.routeOf(CONV)).toBeNull();
    store.setRoute(CONV, "terminal");
    expect(store.exists(CONV)).toBe(false);
    const ledger = emptyLedger(CONV);
    ledger.turns.push({ id: "t", startedAt: 1, status: "done", costUsd: 0.11 });
    store.save(ledger);
    expect(store.routeOf(CONV)).toBe("api");
    store.setRoute(CONV, "terminal");
    expect(store.routeOf(CONV)).toBe("terminal");
    expect(store.load(CONV).turns).toHaveLength(1);
    store.setRoute(CONV, "api");
    expect(store.routeOf(CONV)).toBe("api");
  });

  test("manager: 開くと経路は API、閉じると端末。実行中は閉じない", async () => {
    const dir = makeTempDir("handoff-manager");
    const ledgerStore = new ApiAgentLedgerStore(path.join(dir, "ledger"));
    const workers: { exit: () => void }[] = [];
    const manager = new ApiAgentManager({
      spawnWorker: () => {
        let onExit: (() => void) | undefined;
        const worker = { pid: 1, send: () => undefined, onMessage: () => undefined, onExit: (l: () => void) => { onExit = l; }, kill: () => undefined };
        workers.push({ exit: () => onExit?.() });
        return worker;
      },
      resolveKey: async () => ({ secretEnv: { ANTHROPIC_API_KEY: "k" } }),
      workerEnvironment: (secretEnv) => secretEnv,
      conversationHolders: () => [],
      approval: async () => "deny",
      ledgerStore, sessionStore: new ApiAgentSessionStore(path.join(dir, "sessions")),
      transcriptPath: () => path.join(dir, "none.jsonl"),
    });
    manager.open("cs-a", { conversationId: CONV, cwd: "/w", config: CONFIG, resume: true });
    expect(ledgerStore.routeOf(CONV)).toBe("api");
    await manager.submit("cs-a", "x");
    expect(manager.close("cs-a")).toBe("running");
    workers[0]!.exit();
    expect(manager.close("cs-a")).toBe("closed");
    expect(ledgerStore.routeOf(CONV)).toBe("terminal");
    expect(manager.close("cs-a")).toBe("not_open");
  });
});

interface FakeOptions {
  sessions?: SessionInfo[];
  processing?: boolean;
  question?: boolean;
  openStatus?: "ok" | "failed";
  closeStatus?: { status: "ok" | "failed"; error?: "turn_running" | "not_open" };
}

function makeCtx(options: FakeOptions = {}) {
  const metadataStore = makeTempStore();
  const hubRequests: HubClientMessage[] = [];
  const hubSent: HubClientMessage[] = [];
  const killed: string[] = [];
  let sessions = options.sessions ?? [];
  const ctx = {
    state: { negotiatedVersion: 2 },
    writer: { write: () => undefined },
    metadataStore,
    sessionManager: {
      list: async () => sessions,
      kill: async (name: string) => { killed.push(name); sessions = sessions.filter((s) => s.name !== name); },
      agentProcessIds: async () => null,
    },
    hubRpc: async (request: HubClientMessage): Promise<HubServerMessage> => {
      hubRequests.push(request);
      const id = (request as { id: string }).id;
      if (request.type === "hub_state_request") {
        return { type: "hub_state_response", id, session: request.session, processing: options.processing === true,
          pendingQuestion: options.question === true ? { id: "q", questions: [] } : null } as HubServerMessage;
      }
      if (request.type === "api_agent_close") return { type: "api_agent_result", id, ...(options.closeStatus ?? { status: "ok" }) } as HubServerMessage;
      return { type: "api_agent_result", id, status: options.openStatus ?? "ok", ...(options.openStatus === "failed" ? { error: "no_api_key" } : {}) } as HubServerMessage;
    },
    hubLink: { send: (message: HubClientMessage) => { hubSent.push(message); return true; } },
    processingSessions: new Map<string, number>(),
    backgroundChatSessions: new Set<string>(),
    codexTurnController: null,
    activeChatSession: { name: null as string | null },
  };
  return { ctx: ctx as never, metadataStore, hubRequests, hubSent, killed };
}

function registryDir(entries: { pid: number; tmux?: string; name?: string }[]): string {
  const dir = makeTempDir("handoff-registry");
  for (const entry of entries) {
    fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify({ pid: entry.pid, sessionId: CONV, name: entry.name ?? "claude",
      ...(entry.tmux !== undefined ? { tmux: entry.tmux } : {}) }));
  }
  return dir;
}

function deps(overrides: Partial<HandoffDeps> & { registry?: string; alive?: Set<number> } = {}): HandoffDeps & { routes: string[] } {
  const routes: string[] = [];
  const alive = overrides.alive ?? new Set<number>();
  return {
    transcriptPath: () => path.join(makeTempDir("handoff-none"), "none.jsonl"),
    ledger: { setRoute: (_id: string, route: "api" | "terminal") => { routes.push(route); } },
    claudeSessionsDir: overrides.registry ?? registryDir([]),
    holders: () => [],
    peerPidAlive: () => true,
    processAlive: async (pid: number) => alive.has(pid),
    exitWaitMs: 100,
    exitPollMs: 10,
    ...overrides,
    routes,
  };
}

const TERMINAL: SessionInfo = { name: "cs-98cc4122", cwd: "/repo/.claude/worktrees/pr-1", alive: true, agent: "claude", providerSessionId: CONV, backend: "tmux" };
const handoffMessage = { type: "api_agent_handoff" as const, v: 2, id: "h1", conversationId: CONV, cwd: "/repo/.claude/worktrees/pr-1", name: "cs-new", config: CONFIG };

describe("引き継ぎ", () => {
  test("成功: 端末側を終え（worktree は消さない）、claude の終了を確かめてから同じ名前・同じ会話 id で API 作業を resume で開く", async () => {
    const t = makeCtx({ sessions: [TERMINAL] });
    t.metadataStore.put({ name: TERMINAL.name, cwd: TERMINAL.cwd, createdAt: 1, agent: "claude", claudeSessionId: CONV, backend: "tmux" });
    const d = deps({ registry: registryDir([{ pid: 4242, tmux: `${TERMINAL.name}:0.0` }]) });
    const result = await handoffToApiAgent(handoffMessage, t.ctx, d);
    expect(result).toEqual({ type: "api_agent_handoff_result", v: 2, id: "h1", ok: true, session: TERMINAL.name });
    expect(t.killed).toEqual([TERMINAL.name]);
    expect(t.hubSent).toContainEqual({ type: "session_retire", session: TERMINAL.name });
    const open = t.hubRequests.find((r) => r.type === "api_agent_open");
    expect(open).toMatchObject({ session: TERMINAL.name, conversationId: CONV, cwd: TERMINAL.cwd, resume: true, config: CONFIG });
    expect(t.metadataStore.get(TERMINAL.name)?.executionRoute).toBe("api");
    // hub は retire を open より先に受ける（同じ接続で順に送る）。
    const order = [...t.hubSent.map((m) => m.type)];
    expect(order.indexOf("session_retire")).toBeGreaterThanOrEqual(0);
  });

  test("端末側が処理中・設問待ちなら何も変えずに断る", async () => {
    for (const options of [{ processing: true }, { question: true }]) {
      const t = makeCtx({ sessions: [TERMINAL], ...options });
      const result = await handoffToApiAgent(handoffMessage, t.ctx, deps());
      expect(result).toMatchObject({ ok: false, error: "terminal_busy" });
      expect(result.message).toContain("止めるか終わるのを待ってから");
      expect(t.killed).toEqual([]);
      expect(t.hubRequests.some((r) => r.type === "api_agent_open")).toBe(false);
    }
  });

  test("Tailii 外の claude が掴んでいれば何も終了せずに断る（名前を添える）", async () => {
    const t = makeCtx({ sessions: [TERMINAL] });
    const result = await handoffToApiAgent(handoffMessage, t.ctx, deps({ registry: registryDir([{ pid: 9, name: "mac-terminal" }]) }));
    expect(result).toMatchObject({ ok: false, error: "held_externally" });
    expect(result.message).toContain("mac-terminal");
    expect(result.message).not.toMatch(/Mac|tmux|herdr/);
    expect(t.killed).toEqual([]);
  });

  test("claude が終わらなければ API 作業を開かない（会話は端末で開き直せる）", async () => {
    const t = makeCtx({ sessions: [TERMINAL] });
    const result = await handoffToApiAgent(handoffMessage, t.ctx,
      deps({ registry: registryDir([{ pid: 4242, tmux: `${TERMINAL.name}:0.0` }]), alive: new Set([4242]) }));
    expect(result).toMatchObject({ ok: false, error: "terminal_stop_failed" });
    expect(result.message).toContain("今までどおり開き直せます");
    expect(t.hubRequests.some((r) => r.type === "api_agent_open")).toBe(false);
  });

  test("API 作業を開けなければ理由を返し、メタデータを元へ戻す（端末で開き直せる）", async () => {
    const t = makeCtx({ sessions: [TERMINAL], openStatus: "failed" });
    t.metadataStore.put({ name: TERMINAL.name, cwd: TERMINAL.cwd, createdAt: 1, agent: "claude", claudeSessionId: CONV, backend: "tmux" });
    const result = await handoffToApiAgent(handoffMessage, t.ctx, deps());
    expect(result).toMatchObject({ ok: false, error: "no_api_key" });
    expect(t.metadataStore.get(TERMINAL.name)?.executionRoute).toBeUndefined();
    expect(t.metadataStore.get(TERMINAL.name)?.backend).toBe("tmux");
  });

  test("止まっている会話（端末側のセッション無し）はそのまま API 作業を開く。名前は依頼の名前", async () => {
    const t = makeCtx({ sessions: [] });
    const result = await handoffToApiAgent(handoffMessage, t.ctx, deps());
    expect(result).toMatchObject({ ok: true, session: "cs-new" });
    expect(t.killed).toEqual([]);
  });

  test("見積もり: 文脈の大きさ・初回の概算・引き継ぐ権限モード（自動は確認ありへ）・今は引き継げない理由", async () => {
    const dir = makeTempDir("handoff-estimate");
    const file = path.join(dir, `${CONV}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: "permission-mode", permissionMode: "auto" }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 9, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 } } }),
    ].join("\n") + "\n");
    const t = makeCtx({ sessions: [TERMINAL], processing: true });
    const response = await estimateHandoff({ type: "api_agent_handoff_estimate_request", v: 2, id: "e", conversationId: CONV, cwd: "/w", model: "claude-haiku-5-5" },
      t.ctx, deps({ transcriptPath: () => file }));
    expect(response).toEqual({ type: "api_agent_handoff_estimate_response", v: 2, id: "e", ok: true, contextTokens: 10_009,
      estimatedUsd: estimateFirstTurnUsd(10_009, "claude-haiku-5-5"), suggestedPermissionMode: "default", blocked: "terminal_busy" });
  });
});

describe("元へ戻す", () => {
  function apiMeta(t: ReturnType<typeof makeCtx>) {
    t.metadataStore.put({ name: "cs-api", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, providerSessionId: CONV, executionRoute: "api" });
  }

  test("実行中のターンがあれば戻さない（先に止めるか終わるのを待つ）", async () => {
    const t = makeCtx({ closeStatus: { status: "failed", error: "turn_running" } });
    apiMeta(t);
    const d = deps();
    expect(await returnToTerminal({ type: "api_agent_return", v: 2, id: "r", session: "cs-api" }, t.ctx, d))
      .toEqual({ type: "api_agent_return_result", v: 2, id: "r", ok: false, error: "turn_running" });
    expect(d.routes).toEqual([]);
    expect(t.killed).toEqual([]);
  });

  test("成功: API 作業を閉じ、最後の実行経路を端末にし、SDK の claude の終了を待つ", async () => {
    const t = makeCtx();
    apiMeta(t);
    let polls = 0;
    const d = deps({ holders: () => (polls++ < 2 ? [{ pid: 7 }] : []) });
    const result = await returnToTerminal({ type: "api_agent_return", v: 2, id: "r", session: "cs-api" }, t.ctx, d);
    expect(result).toEqual({ type: "api_agent_return_result", v: 2, id: "r", ok: true });
    expect(t.hubRequests.map((r) => r.type)).toEqual(["api_agent_close"]);
    expect(t.killed).toEqual(["cs-api"]);
    expect(d.routes).toEqual(["terminal"]);
  });

  test("hub が再起動していて開いていなくても、端末へ戻せる（有料の API でしか開けない状態にしない）", async () => {
    const t = makeCtx({ closeStatus: { status: "failed", error: "not_open" } });
    apiMeta(t);
    const d = deps();
    expect((await returnToTerminal({ type: "api_agent_return", v: 2, id: "r", session: "cs-api" }, t.ctx, d)).ok).toBe(true);
    expect(d.routes).toEqual(["terminal"]);
  });

  test("API 作業でない会話は戻せない（not_open）", async () => {
    const t = makeCtx();
    expect((await returnToTerminal({ type: "api_agent_return", v: 2, id: "r", session: "cs-none" }, t.ctx, deps())).error).toBe("not_open");
  });
});

describe("終了で worktree を消さない", () => {
  test("keepWorktree なら Tailii の worktree の後始末を走らせない", async () => {
    const t = makeCtx({ sessions: [TERMINAL] });
    t.metadataStore.put({ name: TERMINAL.name, cwd: TERMINAL.cwd, createdAt: 1, agent: "claude", claudeSessionId: CONV });
    expect(await killSessionForUser(t.ctx, TERMINAL.name, { keepWorktree: true })).toBeNull();
    expect(t.killed).toEqual([TERMINAL.name]);
  });
});
