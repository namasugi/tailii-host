// sessionWorkdirApiAgent.test.ts — API 作業の会話の作業フォルダの変更（session-workdir-change）。
// ApiAgentManager の relocate / followCwd・ターンの前の会話ログの追従（ワークツリー）・hub の api_agent_relocate・
// engine の差し込み口と枠の結線。作業プロセスは偽物（実 API・実 SDK は使わない）。

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiAgentManager, type ApiAgentWorkerHandle } from "../src/apiAgent/manager.js";
import { ApiAgentLedgerStore } from "../src/apiAgent/ledger.js";
import { ApiAgentSessionStore } from "../src/apiAgent/sessionState.js";
import {
  activeWorktreeBinding,
  resetWorktreeBindingCache,
  resolveConversationPlacement,
  WORKTREE_STATE_SCAN_CAP_BYTES,
} from "../src/apiAgent/transcriptPlacement.js";
import type { HubToWorker, WorkerToHub } from "../src/apiAgent/workerProtocol.js";
import type { HandlerContext } from "../src/engine/context.js";
import { changeSessionWorkdir } from "../src/engine/handlers/sessionWorkdir.js";
import { decodeHubClientLine, decodeHubServerLine } from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import type { ApiAgentConfig } from "../src/protocol.js";
import { claudeTranscriptCwd, locateClaudeTranscript } from "../src/sessions/claudeTranscriptLocator.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { changeApiAgentWorkdir } from "../src/workdir/apiAgent.js";
import { changeClaudeTerminalWorkdir } from "../src/workdir/claudeTerminal.js";
import { changeCodexWorkdir } from "../src/workdir/codex.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const CONV = "5c0f8a52-63a4-4f5e-9a51-0b7d2e6f3c11";
const KEY = "sk-ant-api03-" + "x".repeat(40);
const CONFIG: ApiAgentConfig = { model: "claude-haiku-5-5", permissionMode: "default", budget: { turnUsd: 0.5, conversationUsd: 5, maxTurns: 10 } };

class FakeWorker implements ApiAgentWorkerHandle {
  pid = 4242;
  sent: HubToWorker[] = [];
  private messageListeners: ((m: WorkerToHub) => void)[] = [];
  private exitListeners: ((c: number | null) => void)[] = [];
  send(message: HubToWorker): void { this.sent.push(message); }
  onMessage(listener: (m: WorkerToHub) => void): void { this.messageListeners.push(listener); }
  onExit(listener: (c: number | null) => void): void { this.exitListeners.push(listener); }
  kill(): void { /* 偽物。 */ }
  emit(message: WorkerToHub): void { for (const l of this.messageListeners) l(message); }
  get start() { return this.sent.find((m) => m.t === "start") as Extract<HubToWorker, { t: "start" }>; }
  succeed(): void {
    this.emit({ t: "auth", ok: true, apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty", cliVersion: "2.1.325" });
    this.emit({ t: "result", subtype: "success", isError: false, totalCostUsd: 0.01, numTurns: 1, sessionId: CONV, terminalReason: "completed" });
    for (const l of this.exitListeners) l(0);
  }
}

function realDir(prefix: string): string {
  return fs.realpathSync(makeTempDir(prefix));
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

/** 会話ログを `slugCwd` の slug に作る。 */
function writeTranscript(projects: string, slugCwd: string, body: string): string {
  const dir = path.join(projects, claudeProjectSlug(slugCwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${CONV}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

const userLine = (cwd: string) => line({ type: "user", cwd, sessionId: CONV, message: { role: "user", content: "hi" } });

function setup(options: { projects?: string; sessionsDir?: string } = {}) {
  const dir = makeTempDir("wd-api");
  const projects = options.projects ?? path.join(dir, "projects");
  fs.mkdirSync(projects, { recursive: true });
  const workers: FakeWorker[] = [];
  const cwdChanges: string[] = [];
  let holders: { pid: number; name: string }[] = [];
  const sessionStore = new ApiAgentSessionStore(options.sessionsDir ?? path.join(dir, "sessions"));
  const manager = new ApiAgentManager({
    spawnWorker: () => { const w = new FakeWorker(); workers.push(w); return w; },
    resolveKey: async () => ({ secretEnv: { ANTHROPIC_API_KEY: KEY } }),
    workerEnvironment: (secretEnv) => ({ HOME: "/h", ...secretEnv }),
    conversationHolders: () => holders,
    approval: async () => "allow",
    onQuestion: () => undefined,
    onCwdChange: (_session, cwd) => cwdChanges.push(cwd),
    ledgerStore: new ApiAgentLedgerStore(path.join(dir, "ledger")),
    sessionStore,
    claudeProjectsDir: projects,
  });
  return { manager, workers, cwdChanges, sessionStore, projects, setHolders: (h: typeof holders) => { holders = h; } };
}

describe("ApiAgentManager.relocate（利用者の変更）", () => {
  test("会話ログを新しいフォルダの slug へ移し、次のターンは新しいフォルダで resume する", async () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const t = setup();
    const before = writeTranscript(t.projects, a, userLine(a));
    fs.mkdirSync(before.slice(0, -".jsonl".length));
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: true });

    expect(t.manager.relocate("cs", { conversationId: CONV, fromCwd: a, toCwd: b })).toEqual({ status: "ok", cwd: b });
    const after = path.join(t.projects, claudeProjectSlug(b), `${CONV}.jsonl`);
    expect(fs.existsSync(before)).toBe(false);
    expect(fs.existsSync(after)).toBe(true);
    // 付帯フォルダも同居させ、Claude の `/cd` と同じ relocated 行を書き足す。
    expect(fs.existsSync(path.join(t.projects, claudeProjectSlug(b), CONV))).toBe(true);
    expect(claudeTranscriptCwd(after)).toBe(b);
    // hub の再起動後も新しいフォルダで続く（開いている記録）。
    expect(t.sessionStore.get("cs")?.cwd).toBe(b);

    await t.manager.submit("cs", "next");
    expect(t.workers[0]!.start).toMatchObject({ cwd: b, resume: true, conversationId: CONV });
    // 利用者の変更は呼び手（枠）が記録と `pc:cwd` を持つので、追従の通知は出さない。
    expect(t.cwdChanges).toEqual([]);
  });

  test("まだ 1 回も発話していない会話は値を変えるだけ。最初のターンは新しいフォルダで新規に始める", async () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const t = setup();
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: false });
    expect(t.manager.relocate("cs", { conversationId: CONV, fromCwd: a, toCwd: b })).toEqual({ status: "ok", cwd: b });
    expect(fs.readdirSync(t.projects)).toEqual([]);
    await t.manager.submit("cs", "hello");
    expect(t.workers[0]!.start).toMatchObject({ cwd: b, resume: false });
  });

  test("ターンの実行中・送信待ち・設問の保留・会話を掴んでいる claude があれば busy（何も動かさない）", async () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const t = setup();
    const file = writeTranscript(t.projects, a, userLine(a));
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: true });
    const relocate = () => t.manager.relocate("cs", { conversationId: CONV, fromCwd: a, toCwd: b });

    // 始める途中（キーの取得待ち）。
    const starting = t.manager.submit("cs", "one");
    expect(relocate()).toEqual({ status: "busy" });
    await starting;
    // 実行中・承認待ち（ターンの途中）。
    expect(relocate()).toEqual({ status: "busy" });
    // 送信待ち（次のターンへ持ち越した発話）。
    await t.manager.submit("cs", "two");
    expect(relocate()).toEqual({ status: "busy" });
    t.workers[0]!.succeed();
    await new Promise((resolve) => setImmediate(resolve));
    // 持ち越しが次のターンになって実行中。設問の保留もターンの途中。
    t.workers[1]!.emit({ t: "permission_request", requestId: "r1", toolName: "AskUserQuestion",
      input: { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [{ label: "A", description: "" }] }] } });
    expect(relocate()).toEqual({ status: "busy" });
    t.workers[1]!.succeed();
    expect(t.manager.isRunning("cs")).toBe(false);
    // Tailii 外の claude が会話を掴んでいる。
    t.setHolders([{ pid: 99, name: "terminal" }]);
    expect(relocate()).toEqual({ status: "busy" });
    expect(fs.existsSync(file)).toBe(true);
    t.setHolders([]);
    expect(relocate()).toEqual({ status: "ok", cwd: b });
  });

  test("Claude 自身がワークツリーに入っている会話は worktree で断る。出た後（worktreeSession: null）は移せる", () => {
    const repo = realDir("wd-api-repo");
    const worktree = realDir("wd-api-wt");
    const b = realDir("wd-api-b");
    const t = setup();
    const binding = { originalCwd: repo, worktreePath: worktree, worktreeName: "x", sessionId: CONV };
    const file = writeTranscript(t.projects, worktree, userLine(repo) +
      line({ type: "worktree-state", worktreeSession: binding, sessionId: CONV }) +
      line({ type: "relocated", sessionId: CONV, relocatedCwd: worktree }));
    t.manager.open("cs", { conversationId: CONV, cwd: worktree, config: CONFIG, resume: true });
    expect(t.manager.relocate("cs", { conversationId: CONV, fromCwd: worktree, toCwd: b })).toEqual({ status: "worktree" });
    expect(fs.existsSync(file)).toBe(true);
    fs.appendFileSync(file, line({ type: "worktree-state", worktreeSession: null, sessionId: CONV }));
    expect(t.manager.relocate("cs", { conversationId: CONV, fromCwd: worktree, toCwd: b })).toEqual({ status: "ok", cwd: b });
  });

  test("移動先に同じ会話の記録が既にあれば conflict", () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const t = setup();
    writeTranscript(t.projects, a, userLine(a));
    writeTranscript(t.projects, b, userLine(b));
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: true });
    expect(t.manager.relocate("cs", { conversationId: CONV, fromCwd: a, toCwd: b })).toEqual({ status: "conflict" });
    expect(t.sessionStore.get("cs")?.cwd).toBe(a);
  });

  test("開いていない会話（hub の再起動前）も会話ログと開いている記録を移し、再起動後は新しいフォルダで続く", async () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const first = setup();
    writeTranscript(first.projects, a, userLine(a));
    first.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: true });
    // 別の manager（同じ記録の置き場）で、まだ restore していない状態から移す。
    const second = setup({ projects: first.projects, sessionsDir: first.sessionStore.directory });
    expect(second.manager.relocate("cs", { conversationId: CONV, fromCwd: a, toCwd: b })).toEqual({ status: "ok", cwd: b });
    expect(first.sessionStore.get("cs")?.cwd).toBe(b);
    const third = setup({ projects: first.projects, sessionsDir: first.sessionStore.directory });
    expect(third.manager.restore()).toEqual(["cs"]);
    await third.manager.submit("cs", "next");
    expect(third.workers[0]!.start).toMatchObject({ cwd: b, resume: true });
  });
});

describe("ターンの前に会話ログの今の場所へ合わせる（ターンの中の移動）", () => {
  test("前のターンで会話ログが別の slug へ移っていれば（relocated）、そのフォルダで起動し、記録と hub へ知らせる", async () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const t = setup();
    writeTranscript(t.projects, b, userLine(a) + line({ type: "relocated", sessionId: CONV, relocatedCwd: b }));
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: true });
    await t.manager.submit("cs", "next");
    expect(t.workers[0]!.start).toMatchObject({ cwd: b, resume: true });
    expect(t.cwdChanges).toEqual([b]);
    expect(t.sessionStore.get("cs")?.cwd).toBe(b);
  });

  test("Claude がワークツリーに入った会話は、ワークツリーのフォルダで resume する（2.1.325 の実測と端末の再開に合わせる）", async () => {
    const repo = realDir("wd-api-repo");
    const worktree = realDir("wd-api-wt");
    const t = setup();
    writeTranscript(t.projects, worktree, userLine(repo) +
      line({ type: "relocated", sessionId: CONV, relocatedCwd: worktree }) +
      line({ type: "worktree-state", worktreeSession: { originalCwd: repo, worktreePath: worktree }, sessionId: CONV }));
    t.manager.open("cs", { conversationId: CONV, cwd: repo, config: CONFIG, resume: true });
    await t.manager.submit("cs", "next");
    expect(t.workers[0]!.start).toMatchObject({ cwd: worktree, resume: true });
    expect(t.cwdChanges).toEqual([worktree]);
    expect(t.sessionStore.get("cs")?.cwd).toBe(worktree);
  });

  test("ワークツリーのフォルダが消えていれば、会話ログを入る前のフォルダへ戻してそこで resume する", async () => {
    const repo = realDir("wd-api-repo");
    const worktree = path.join(realDir("wd-api-wt-parent"), "wt-removed");
    const t = setup();
    writeTranscript(t.projects, worktree, userLine(repo) +
      line({ type: "relocated", sessionId: CONV, relocatedCwd: worktree }) +
      line({ type: "worktree-state", worktreeSession: { originalCwd: repo, worktreePath: worktree }, sessionId: CONV }));
    t.manager.open("cs", { conversationId: CONV, cwd: worktree, config: CONFIG, resume: true });
    await t.manager.submit("cs", "next");
    expect(t.workers[0]!.start).toMatchObject({ cwd: repo, resume: true });
    expect(t.cwdChanges).toEqual([repo]);
    expect(locateClaudeTranscript(CONV, repo, { projectsDir: t.projects })).toMatchObject({ moved: false, cwd: repo });
  });

  test("会話ログの場所が記録と同じ・会話ログがまだ無い・移った先のフォルダが消えていれば記録どおり", async () => {
    const a = realDir("wd-api-a");
    const t = setup();
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: false });
    await t.manager.submit("cs", "hello");
    expect(t.workers[0]!.start).toMatchObject({ cwd: a });
    const gone = path.join(makeTempDir("wd-api-gone"), "removed");
    writeTranscript(t.projects, gone, userLine(a) + line({ type: "relocated", sessionId: CONV, relocatedCwd: gone }));
    expect(resolveConversationPlacement(CONV, a, { projectsDir: t.projects })).toMatchObject({ cwd: a, launchCwd: a });
    expect(t.cwdChanges).toEqual([]);
  });

  test("大きい会話ログ: 初回は上限まで、2 回目からは伸びた分だけ読む（「無い」も覚える）", () => {
    resetWorktreeBindingCache();
    const projects = makeTempDir("wd-api-big");
    const filler = line({ type: "assistant", message: { content: "x".repeat(1000) } });
    const file = writeTranscript(projects, "/big", filler.repeat(Math.ceil((20 * 1024 * 1024) / filler.length)));
    let bytes = 0;
    const count = (n: number) => { bytes += n; };
    expect(activeWorktreeBinding(file, count)).toBeNull();
    expect(bytes).toBeLessThan(WORKTREE_STATE_SCAN_CAP_BYTES + 512 * 1024);
    bytes = 0;
    expect(activeWorktreeBinding(file, count)).toBeNull();
    expect(bytes).toBe(0);
    // 伸びた分（とその前後の行の区切りを探す窓）だけ。
    fs.appendFileSync(file, filler.repeat(10));
    bytes = 0;
    expect(activeWorktreeBinding(file, count)).toBeNull();
    expect(bytes).toBeLessThan(256 * 1024);
    fs.appendFileSync(file, line({ type: "worktree-state", worktreeSession: { originalCwd: "/r", worktreePath: "/w" }, sessionId: CONV }));
    bytes = 0;
    expect(activeWorktreeBinding(file, count)).toEqual({ originalCwd: "/r", worktreePath: "/w" });
    expect(bytes).toBeLessThan(256 * 1024);
    // 見つけた結果も覚える（その後に別の行が増えても、新しい worktree-state が無ければそのまま）。
    fs.appendFileSync(file, filler.repeat(3));
    bytes = 0;
    expect(activeWorktreeBinding(file, count)).toEqual({ originalCwd: "/r", worktreePath: "/w" });
    expect(bytes).toBeLessThan(256 * 1024);
    // 書き込み途中（改行で終わっていない）の行は読まない。
    fs.appendFileSync(file, '{"type":"worktree-state","worktreeSession":null');
    expect(activeWorktreeBinding(file)).toEqual({ originalCwd: "/r", worktreePath: "/w" });
    fs.appendFileSync(file, ',"sessionId":"x"}\n');
    expect(activeWorktreeBinding(file)).toBeNull();
  });

  test("worktree-state は最後の行が正（出た後は null）", () => {
    const projects = makeTempDir("wd-api-wt-projects");
    const file = writeTranscript(projects, "/x", line({ type: "worktree-state", worktreeSession: { originalCwd: "/r", worktreePath: "/w" }, sessionId: CONV }));
    expect(activeWorktreeBinding(file)).toEqual({ originalCwd: "/r", worktreePath: "/w" });
    fs.appendFileSync(file, line({ type: "worktree-state", worktreeSession: null, sessionId: CONV }));
    expect(activeWorktreeBinding(file)).toBeNull();
    expect(activeWorktreeBinding(path.join(projects, "missing.jsonl"))).toBeNull();
  });

  test("followCwd: hub の記録の照合に合わせて持つ cwd と開いている記録を揃える（会話ログは動かさない）", async () => {
    const a = realDir("wd-api-a");
    const b = realDir("wd-api-b");
    const t = setup();
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: false });
    expect(t.manager.followCwd("cs", b)).toBe(true);
    expect(t.manager.followCwd("cs", b)).toBe(false);
    expect(t.manager.followCwd("missing", b)).toBe(false);
    expect(t.sessionStore.get("cs")?.cwd).toBe(b);
    await t.manager.submit("cs", "hello");
    expect(t.workers[0]!.start).toMatchObject({ cwd: b });
    expect(t.cwdChanges).toEqual([]);
  });
});

describe("hub の api_agent_relocate", () => {
  function makeHub() {
    const a = realDir("wd-api-hub-a");
    const b = realDir("wd-api-hub-b");
    const t = { workers: [] as FakeWorker[] };
    const dir = makeTempDir("wd-api-hub");
    const projects = path.join(dir, "projects");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "cs", cwd: a, createdAt: 0, agent: "claude", claudeSessionId: CONV, providerSessionId: CONV, executionRoute: "api" });
    let manager: ApiAgentManager | null = null;
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("wd-api-hub-hb"), metadataStore, timeoutSeconds: 1800,
      apiAgentFactory: (callbacks) => {
        manager = new ApiAgentManager({
          ...callbacks,
          spawnWorker: () => { const w = new FakeWorker(); t.workers.push(w); return w; },
          resolveKey: async () => ({ secretEnv: { ANTHROPIC_API_KEY: KEY } }),
          workerEnvironment: (secretEnv) => ({ ...secretEnv }),
          conversationHolders: () => [],
          approval: async () => "allow",
          ledgerStore: new ApiAgentLedgerStore(path.join(dir, "ledger")),
          sessionStore: new ApiAgentSessionStore(path.join(dir, "sessions")),
          claudeProjectsDir: projects,
        });
        return manager;
      },
    });
    const client = {};
    const received: Record<string, unknown>[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l) as unknown as Record<string, unknown>));
    const send = (message: Record<string, unknown>) => hub.handleClientMessage(client, JSON.stringify(message));
    send({ type: "api_agent_open", id: "o", session: "cs", conversationId: CONV, cwd: a, config: CONFIG, resume: true });
    writeTranscript(projects, a, userLine(a));
    return { hub, send, received, a, b, projects, metadataStore, workers: t.workers, manager: () => manager! };
  }

  test("処理中は busy、終わったら移して cwd を返す。session_cwd_set（枠の確定）の後も次のターンは新しいフォルダ", async () => {
    const h = makeHub();
    await h.hub.apiAgentSubmit("cs", "one");
    h.send({ type: "api_agent_relocate", id: "r1", session: "cs", conversationId: CONV, fromCwd: h.a, cwd: h.b });
    expect(h.received.at(-1)).toEqual({ type: "api_agent_relocate_result", id: "r1", status: "busy" });
    h.workers[0]!.succeed();
    h.send({ type: "api_agent_relocate", id: "r2", session: "cs", conversationId: CONV, fromCwd: h.a, cwd: h.b });
    expect(h.received.at(-1)).toEqual({ type: "api_agent_relocate_result", id: "r2", status: "ok", cwd: h.b });
    // 記録は枠が確定させる（hub の relocate では書かない）。
    expect(h.metadataStore.get("cs")?.cwd).toBe(h.a);
    h.send({ type: "session_cwd_set", id: "s1", session: "cs", cwd: h.b });
    expect(h.metadataStore.get("cs")?.cwd).toBe(h.b);
    await h.hub.apiAgentSubmit("cs", "two");
    expect(h.workers[1]!.start).toMatchObject({ cwd: h.b, resume: true });
  });

  test("枠の押さえの間に届いた送信は待たせるだけで、作業フォルダの変更は断らない", () => {
    const h = makeHub();
    h.send({ type: "workdir_change_begin", id: "b1", session: "cs", token: "t1" });
    expect(h.received.at(-1)).toMatchObject({ type: "workdir_change_begin_result", id: "b1", status: "granted" });
    h.send({ type: "chat_send", id: "c1", session: "cs", clientMessageId: "m1", text: "after" });
    h.send({ type: "chat_receipt_query", id: "q1", session: "cs", clientMessageId: "m1" });
    expect(h.received.find((m) => m["id"] === "q1")).toMatchObject({ status: "pending" });
    h.send({ type: "api_agent_relocate", id: "r1", session: "cs", conversationId: CONV, fromCwd: h.a, cwd: h.b });
    expect(h.received.find((m) => m["id"] === "r1")).toEqual({ type: "api_agent_relocate_result", id: "r1", status: "ok", cwd: h.b });
    // 押さえの前に始めたターンは送らない（送信は押さえを放した後に流れる）。
    expect(h.workers).toHaveLength(0);
  });

  test("hub の記録の照合（会話ログの移動）で API 作業が持つ cwd も揃う", async () => {
    const h = makeHub();
    // hub が見ていない間に記録が別の値へ直った（tick の照合・relocated 行と同じ applyConversationCwd を通る）。
    h.send({ type: "session_cwd_set", id: "s1", session: "cs", cwd: h.b });
    expect(h.manager().followCwd("cs", h.b)).toBe(false);
  });

  test("ターンの前に会話ログの移動へ合わせたら、記録を直して購読者へ `pc:cwd` を配る", async () => {
    const h = makeHub();
    fs.rmSync(path.join(h.projects, claudeProjectSlug(h.a)), { recursive: true });
    writeTranscript(h.projects, h.b, userLine(h.a) + line({ type: "relocated", sessionId: CONV, relocatedCwd: h.b }));
    await h.hub.apiAgentSubmit("cs", "one");
    expect(h.workers[0]!.start).toMatchObject({ cwd: h.b });
    expect(h.metadataStore.get("cs")?.cwd).toBe(h.b);
  });

  test("ワイヤー: api_agent_relocate と結果の形", () => {
    expect(decodeHubClientLine(JSON.stringify({ type: "api_agent_relocate", id: "r", session: "s", conversationId: CONV, fromCwd: "/a", cwd: "/b" })))
      .toEqual({ type: "api_agent_relocate", id: "r", session: "s", conversationId: CONV, fromCwd: "/a", cwd: "/b" });
    expect(decodeHubClientLine(JSON.stringify({ type: "api_agent_relocate", id: "r", session: "s", conversationId: CONV, fromCwd: "/a", cwd: "b" }))).toBeNull();
    expect(decodeHubServerLine(JSON.stringify({ type: "api_agent_relocate_result", id: "r", status: "worktree" })))
      .toEqual({ type: "api_agent_relocate_result", id: "r", status: "worktree" });
    expect(decodeHubServerLine(JSON.stringify({ type: "api_agent_relocate_result", id: "r", status: "nope" }))).toBeNull();
  });
});

describe("engine の差し込み口（workdir/apiAgent.ts）と枠", () => {
  function ctxWith(store: ReturnType<typeof makeTempStore>, relocate: (request: Record<string, unknown>) => Record<string, unknown> | Error) {
    const calls: Record<string, unknown>[] = [];
    const ctx = {
      state: { negotiatedVersion: 1 },
      metadataStore: store,
      processingSessions: new Map<string, number>(),
      hubRpc: async (request: Record<string, unknown>) => {
        calls.push(request);
        if (request["type"] === "hub_state_request") {
          return { type: "hub_state_response", id: request["id"], session: request["session"], processing: false, pendingQuestion: null };
        }
        if (request["type"] === "workdir_change_begin") {
          return { type: "workdir_change_begin_result", id: request["id"], status: "granted", token: "t" };
        }
        if (request["type"] === "api_agent_relocate") {
          const result = relocate(request);
          if (result instanceof Error) throw result;
          return { type: "api_agent_relocate_result", id: request["id"], ...result };
        }
        return { type: "session_cwd_set_result", id: request["id"], status: "ok" };
      },
      sessionManager: { list: async () => [] },
      hubLink: { send: (message: Record<string, unknown>) => { calls.push(message); } },
    } as unknown as HandlerContext;
    return { ctx, calls };
  }
  const adapters = { claude_terminal: changeClaudeTerminalWorkdir, codex: changeCodexWorkdir, api_agent: changeApiAgentWorkdir };
  const request = (cwd: string) => ({ type: "session_workdir_change" as const, v: 1, id: "req", session: "cs", cwd });

  test("hub が移せたら成功し、枠が記録を書き換えて hub へ知らせる", async () => {
    const a = realDir("wd-api-eng-a");
    const b = realDir("wd-api-eng-b");
    const store = makeTempStore();
    store.put({ name: "cs", cwd: a, createdAt: 1, claudeSessionId: CONV, providerSessionId: CONV, executionRoute: "api" });
    const { ctx, calls } = ctxWith(store, () => ({ status: "ok", cwd: b }));
    expect(await changeSessionWorkdir(request(b), ctx, adapters)).toEqual({
      type: "session_workdir_change_result", v: 1, id: "req", ok: true, cwd: b,
    });
    expect(calls.find((c) => c["type"] === "api_agent_relocate")).toMatchObject({ session: "cs", conversationId: CONV, fromCwd: a, cwd: b });
    expect(store.get("cs")?.cwd).toBe(b);
    expect(calls.find((c) => c["type"] === "session_cwd_set")).toMatchObject({ session: "cs", cwd: b });
    // 押さえは記録と通知の後に放す（枠）。
    expect(calls.at(-1)).toMatchObject({ type: "workdir_change_end", session: "cs" });
  });

  test.each([
    ["busy", { status: "busy" }, "busy", "処理が終わってから変更できます"],
    ["worktree", { status: "worktree" }, "failed", /ワークツリー/],
    ["conflict", { status: "conflict" }, "failed", /同じ会話の記録/],
    ["failed", { status: "failed" }, "failed", /移せませんでした/],
    ["hub に聞けない", new Error("down"), "failed", /変更できませんでした/],
  ] as const)("hub の %s は失敗（記録は変えない）", async (_label, hubResult, error, message) => {
    const a = realDir("wd-api-eng-a");
    const b = realDir("wd-api-eng-b");
    const store = makeTempStore();
    store.put({ name: "cs", cwd: a, createdAt: 1, claudeSessionId: CONV, providerSessionId: CONV, executionRoute: "api" });
    const { ctx, calls } = ctxWith(store, () => hubResult as Record<string, unknown> | Error);
    const result = await changeSessionWorkdir(request(b), ctx, adapters);
    expect(result).toMatchObject({ ok: false, error });
    expect(result.message).toMatch(message);
    expect(store.get("cs")?.cwd).toBe(a);
    expect(calls.some((c) => c["type"] === "session_cwd_set")).toBe(false);
  });

  test("会話 id の無い古い記録は hub へ頼まずに失敗", async () => {
    const store = makeTempStore();
    store.put({ name: "cs", cwd: realDir("wd-api-eng-a"), createdAt: 1, executionRoute: "api" });
    const { ctx, calls } = ctxWith(store, () => ({ status: "ok" }));
    expect(await changeSessionWorkdir(request(realDir("wd-api-eng-b")), ctx, adapters)).toMatchObject({ ok: false, error: "failed" });
    expect(calls.some((c) => c["type"] === "api_agent_relocate")).toBe(false);
  });

  test("locateClaudeTranscript は移した後の会話ログを新しいフォルダで見つける（引き継ぎ・概算額の読み取りと同じ経路）", () => {
    const a = realDir("wd-api-loc-a");
    const b = realDir("wd-api-loc-b");
    const t = setup();
    writeTranscript(t.projects, a, userLine(a));
    t.manager.open("cs", { conversationId: CONV, cwd: a, config: CONFIG, resume: true });
    t.manager.relocate("cs", { conversationId: CONV, fromCwd: a, toCwd: b });
    // 新しいフォルダの記録からは移動なしで、古いフォルダの記録（古いアプリが送ってくる値）からも探して見つかる。
    expect(locateClaudeTranscript(CONV, b, { projectsDir: t.projects })).toMatchObject({ moved: false, cwd: b });
    expect(locateClaudeTranscript(CONV, a, { projectsDir: t.projects })).toMatchObject({ moved: true, cwd: b });
  });
});
