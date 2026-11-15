// sessionWorkdirChange.test.ts — 開いている会話の作業フォルダを途中で変える（session-workdir-change）
// 会話ログを見失わない共通関数・一覧の作業フォルダ・tail の relocated 観測・resume の振り替え・枠（engine ハンドラ）・
// Claude 端末の差し込み口・hub の `pc:cwd` 配信。

import { describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { relocatedResumeCwd, rescueMissingWorktreeCwd } from "../src/commands/launch.js";
import { TranscriptTailer, type ClaudeTurnLifecycleEvent } from "../src/chat/transcriptTailer.js";
import { SubagentTailer } from "../src/chat/subagentTailer.js";
import type { HandlerContext } from "../src/engine/context.js";
import { codexHandlers } from "../src/engine/handlers/codex.js";
import { conversationHandlers } from "../src/engine/handlers/conversation.js";
import { sweepOrphanWorktrees } from "../src/engine/worktreeJanitor.js";
import { gitWorktreeCreate } from "../src/services/gitService.js";
import { changeSessionWorkdir, workdirChangeKind, type WorkdirChangeAdapters } from "../src/engine/handlers/sessionWorkdir.js";
import { decodeHubServerLine } from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import type { SessionInfo } from "../src/protocol.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import {
  claudeTranscriptCwd,
  ensureClaudeMetaCwd,
  locateClaudeTranscript,
  moveClaudeTranscript,
} from "../src/sessions/claudeTranscriptLocator.js";
import { claudeProjectSlug, canonicalPath } from "../src/shared/paths.js";
import { classifyCdDialog, createClaudeTerminalWorkdirAdapter, readCdVerdict } from "../src/workdir/claudeTerminal.js";
import { changeApiAgentWorkdir } from "../src/workdir/apiAgent.js";
import { changeCodexWorkdir } from "../src/workdir/codex.js";
import { validateWorkdirTarget } from "../src/workdir/validate.js";
import { MockTmuxRunner, makeTempDir, makeTempStore, ok, startEngine } from "./helpers.js";
import { classifySubmitFrame, confirmDialogAppeared, screenShowsConfirmDialogFooter, screenShowsDialogFooter, TmuxSessionManager } from "../src/backend/tmux.js";
import { HerdrSessionManager } from "../src/backend/herdr.js";
import type { HubLink } from "../src/hub/hubClient.js";
import { decodeControlMessage } from "../src/protocol.js";

const ID = "201d3dd7-52b6-4e20-b4fc-54a0758b813e";

/** 実在するフォルダ（slug は実体パスで作るので realpath にそろえる）。 */
function realDir(prefix: string): string {
  return fs.realpathSync(makeTempDir(prefix));
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

/** 会話ログを `cwd` の slug に作る（先頭の cwd は `headCwd`）。 */
function writeTranscript(projects: string, cwd: string, body: string, id = ID): string {
  const dir = path.join(projects, claudeProjectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

function userLine(cwd: string, text: string, timestamp = "2026-11-15T09:48:31.000Z"): string {
  return line({ type: "user", cwd, sessionId: ID, timestamp, message: { role: "user", content: text } });
}

describe("会話ログの場所（claudeTranscriptLocator）", () => {
  test("記録どおりの slug にあればそれ、無ければ全 slug から会話 id で探して今のフォルダを添える", () => {
    const projects = makeTempDir("wd-projects");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const file = writeTranscript(projects, b,
      userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: b }) + userLine(b, "next"));
    expect(locateClaudeTranscript(ID, b, { projectsDir: projects })).toEqual({
      path: file, dir: path.dirname(file), cwd: b, moved: false,
    });
    expect(locateClaudeTranscript(ID, a, { projectsDir: projects })).toEqual({
      path: file, dir: path.dirname(file), cwd: b, moved: true,
    });
    expect(locateClaudeTranscript("00000000-0000-0000-0000-000000000000", a, { projectsDir: projects })).toBeNull();
    expect(locateClaudeTranscript("../x", a, { projectsDir: projects })).toBeNull();
  });

  test("今のフォルダは最新の relocated 行、無ければ先頭の cwd。置き場所の slug と合わない値は採らない", () => {
    const projects = makeTempDir("wd-projects-cwd");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const c = realDir("wd-c");
    // a → c → b と移って b の slug にある。
    const moved = writeTranscript(projects, b, userLine(a, "hi") +
      line({ type: "relocated", sessionId: ID, relocatedCwd: c }) +
      line({ type: "relocated", sessionId: ID, relocatedCwd: b }) + userLine(b, "x"));
    expect(claudeTranscriptCwd(moved)).toBe(b);
    // relocated の無いログは先頭の cwd。
    const plain = writeTranscript(projects, a, userLine(a, "hi"), "11111111-1111-1111-1111-111111111111");
    expect(claudeTranscriptCwd(plain)).toBe(a);
    // relocated が置き場所と食い違う（壊れた・読み違い）なら先頭の cwd も合わないので null。
    const odd = writeTranscript(projects, c, userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: b }),
      "22222222-2222-2222-2222-222222222222");
    expect(claudeTranscriptCwd(odd)).toBeNull();
  });

  test("ensureClaudeMetaCwd は会話ログの移動に合わせて記録を直す（Codex・見つからない会話は触らない）", () => {
    const projects = makeTempDir("wd-projects-ensure");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    writeTranscript(projects, b, userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: b }));
    const store = makeTempStore();
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    store.put(meta);
    const fixed = ensureClaudeMetaCwd(store, meta, { projectsDir: projects });
    expect(fixed.cwd).toBe(b);
    expect(store.get("work")?.cwd).toBe(b);
    const codex = { name: "cx", cwd: a, createdAt: 1, agent: "codex" as const, providerSessionId: ID };
    expect(ensureClaudeMetaCwd(store, codex, { projectsDir: projects })).toBe(codex);
  });

  test("moveClaudeTranscript は会話ログと付帯フォルダを移して relocated 行を書き足す", () => {
    const projects = makeTempDir("wd-projects-move");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi").trimEnd()); // 最後の改行なし（書きかけ）
    fs.mkdirSync(path.join(path.dirname(src), ID, "subagents"), { recursive: true });
    const result = moveClaudeTranscript({ conversationId: ID, toCwd: b, fromCwd: a, projectsDir: projects });
    const dest = path.join(projects, claudeProjectSlug(b), `${ID}.jsonl`);
    expect(result).toEqual({ status: "moved", path: dest });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(path.join(projects, claudeProjectSlug(b), ID, "subagents"))).toBe(true);
    const lines = fs.readFileSync(dest, "utf8").split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: "relocated", sessionId: ID, relocatedCwd: b });
    expect(claudeTranscriptCwd(dest)).toBe(b);
    // 2 回目は同じ場所で、既に b を指しているので何も書かない。
    const size = fs.statSync(dest).size;
    expect(moveClaudeTranscript({ conversationId: ID, toCwd: b, fromCwd: b, projectsDir: projects }).status).toBe("in_place");
    expect(fs.statSync(dest).size).toBe(size);
    // まだ会話ログが無い会話は移すものが無い。
    expect(moveClaudeTranscript({ conversationId: "33333333-3333-3333-3333-333333333333", toCwd: b, projectsDir: projects }))
      .toEqual({ status: "absent" });
  });

  test("移動先に同じ会話のログが既にあれば動かさない", () => {
    const projects = makeTempDir("wd-projects-conflict");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    writeTranscript(projects, a, userLine(a, "hi"));
    writeTranscript(projects, b, userLine(b, "other"));
    expect(moveClaudeTranscript({ conversationId: ID, toCwd: b, fromCwd: a, projectsDir: projects }).status).toBe("conflict");
  });
});

describe("一覧と開き直し", () => {
  test("会話一覧の作業フォルダは移った先（最新の relocated 行）", () => {
    const projects = makeTempDir("wd-projects-list");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    writeTranscript(projects, b, userLine(a, "hello") + line({ type: "relocated", sessionId: ID, relocatedCwd: b }) +
      userLine(b, "after move"));
    const rows = new ClaudeSessionStore(projects).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cwd).toBe(b);
  });

  test("会話一覧: 末尾の窓に relocated が無くても、先頭の cwd が置き場所と合わなければ読み直す", () => {
    const projects = makeTempDir("wd-projects-list-deep");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const filler = Array.from({ length: 400 }, (_, i) => userLine(b, `${"x".repeat(900)} ${i}`)).join("");
    writeTranscript(projects, b, userLine(a, "hello") + line({ type: "relocated", sessionId: ID, relocatedCwd: b }) + filler);
    expect(new ClaudeSessionStore(projects).list()[0]?.cwd).toBe(b);
  });

  test("resume: 会話ログが別の slug へ移っていれば、そのフォルダで起動する", () => {
    const projects = makeTempDir("wd-projects-resume");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    writeTranscript(projects, b, userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: b }));
    expect(relocatedResumeCwd({ cwd: a, claudeSessionId: ID, projectsDir: projects })).toBe(b);
    expect(relocatedResumeCwd({ cwd: b, claudeSessionId: ID, projectsDir: projects })).toBeNull();
  });

  test("resume: 移った先のフォルダが消えていたら、会話ログを開いたフォルダへ戻してそこで続ける", () => {
    const projects = makeTempDir("wd-projects-resume-gone");
    const a = realDir("wd-a");
    const gone = path.join(realDir("wd-gone-parent"), "removed");
    writeTranscript(projects, gone, userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: gone }));
    expect(relocatedResumeCwd({ cwd: a, claudeSessionId: ID, projectsDir: projects })).toBeNull();
    const back = path.join(projects, claudeProjectSlug(a), `${ID}.jsonl`);
    expect(fs.existsSync(back)).toBe(true);
    expect(claudeTranscriptCwd(back)).toBe(a);
  });

  test("削除済みワークツリーの救済も共通の移し替えを使う（relocated 行を書き足す）", () => {
    const projects = makeTempDir("wd-projects-rescue");
    const repo = realDir("wd-repo");
    const worktree = path.join(repo, ".claude", "worktrees", "20261115-100000");
    writeTranscript(projects, worktree, userLine(worktree, "hi"));
    const rescued = rescueMissingWorktreeCwd({ cwd: worktree, claudeSessionId: ID, projectsDir: projects });
    expect(rescued).toBe(repo);
    const dest = path.join(projects, claudeProjectSlug(repo), `${ID}.jsonl`);
    expect(claudeTranscriptCwd(dest)).toBe(repo);
  });
});

describe("tail の relocated 観測", () => {
  test("履歴の relocated は live=false、追尾中に書かれたものは live=true で観測者へ知らせ、本文には流さない", async () => {
    const projects = makeTempDir("wd-projects-tail");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const file = writeTranscript(projects, a, userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: a }));
    const events: ClaudeTurnLifecycleEvent[] = [];
    const tailer = new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true, pollIntervalMs: 10 });
    tailer.setTurnLifecycleObserver((event) => events.push(event));
    const ac = new AbortController();
    const outputs: string[] = [];
    const pump = (async () => {
      for await (const message of tailer.streamTranscript(file, ac.signal)) {
        if (message.type === "chat_output") outputs.push(message.streamId);
        if (message.type === "chat_output" && message.streamId === "pc:history-done") {
          fs.appendFileSync(file, line({ type: "relocated", sessionId: ID, relocatedCwd: b }));
        }
      }
    })();
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "relocated")).toHaveLength(2), { timeout: 3_000 });
    ac.abort();
    await pump.catch(() => {});
    const relocated = events.filter((e) => e.kind === "relocated");
    expect(relocated.map((e) => [e.cwd, e.live])).toEqual([[a, false], [b, true]]);
    expect(outputs.some((id) => id === "pc:cwd")).toBe(false);
  });
});

describe("変更先の検証", () => {
  test("絶対パス・実在・フォルダ・制御文字なし。実体パスへ解決する", () => {
    const dir = makeTempDir("wd-validate");
    expect(validateWorkdirTarget(dir)).toEqual({ ok: true, cwd: canonicalPath(dir) });
    expect(validateWorkdirTarget("relative/path").ok).toBe(false);
    expect(validateWorkdirTarget("~/x").ok).toBe(false);
    expect(validateWorkdirTarget(path.join(dir, "missing")).ok).toBe(false);
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    expect(validateWorkdirTarget(file).ok).toBe(false);
    expect(validateWorkdirTarget(`${dir}\nrm`).ok).toBe(false);
  });
});

interface FakeCtxOptions {
  /** hub の押さえ（workdir_change_begin）の答え。既定は granted。 */
  begin?: "granted" | "busy" | "in_flight";
  /** 押さえの依頼だけ時間切れにする。 */
  beginTimeout?: boolean;
  hubDown?: boolean;
  sessions?: SessionInfo[];
  sendTextSubmit?: (name: string, text: string) => Promise<void>;
  /** 端末の画面（captureVisibleAnsi）。 */
  screen?: () => string;
  sendKeys?: (keys: string[]) => void;
}

function fakeCtx(store: ReturnType<typeof makeTempStore>, options: FakeCtxOptions = {}) {
  const hubCalls: unknown[] = [];
  const sent: string[] = [];
  const ctx = {
    state: { negotiatedVersion: 1 },
    metadataStore: store,
    processingSessions: new Map<string, number>(),
    hubRpc: async (request: { type: string; id: string; session: string }) => {
      hubCalls.push(request);
      if (options.hubDown === true) throw new Error("hub down");
      if (request.type === "workdir_change_begin") {
        const status = options.begin ?? "granted";
        if (options.beginTimeout === true) throw new Error("hub rpc timeout");
        return { type: "workdir_change_begin_result", id: request.id, status,
          ...(status === "granted" ? { token: (request as unknown as { token: string }).token } : {}) };
      }
      return { type: "session_cwd_set_result", id: request.id, status: "ok" };
    },
    hubLink: { send: (message: unknown) => { hubCalls.push(message); } },
    sessionManager: {
      list: async () => options.sessions ?? [],
      sendTextSubmit: options.sendTextSubmit ?? (async (_name: string, text: string) => { sent.push(text); }),
      sendKeys: async (_name: string, keys: string[]) => { keys.forEach((key) => sent.push(`key:${key}`)); options.sendKeys?.(keys); },
      captureVisibleAnsi: async () => options.screen?.() ?? "❯ \n",
      agentProcessIds: async () => null,
    },
  } as unknown as HandlerContext;
  return { ctx, hubCalls, sent };
}

describe("枠（session_workdir_change）", () => {
  const request = (cwd: string, session = "work") => ({ type: "session_workdir_change" as const, v: 1, id: "req-1", session, cwd });
  const okAdapter = vi.fn(async ({ cwd }: { cwd: string }) => ({ ok: true as const, cwd }));
  const adapters = (): WorkdirChangeAdapters => ({ claude_terminal: okAdapter, codex: changeCodexWorkdir, api_agent: changeApiAgentWorkdir });

  test("会話の記録が無ければ not_found", async () => {
    const { ctx } = fakeCtx(makeTempStore());
    expect(await changeSessionWorkdir(request(makeTempDir("wd-x")), ctx, adapters())).toMatchObject({ ok: false, error: "not_found" });
  });

  test("不正な作業フォルダは invalid_cwd（差し込み口を呼ばない）", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: realDir("wd-a"), createdAt: 1, claudeSessionId: ID });
    const { ctx } = fakeCtx(store);
    okAdapter.mockClear();
    const result = await changeSessionWorkdir(request("relative"), ctx, adapters());
    expect(result).toMatchObject({ type: "session_workdir_change_result", ok: false, error: "invalid_cwd" });
    expect(typeof result.message).toBe("string");
    expect(okAdapter).not.toHaveBeenCalled();
  });

  test("今と同じフォルダなら何もせず成功", async () => {
    const a = realDir("wd-a");
    const store = makeTempStore();
    store.put({ name: "work", cwd: a, createdAt: 1, claudeSessionId: ID });
    const { ctx, hubCalls } = fakeCtx(store);
    okAdapter.mockClear();
    expect(await changeSessionWorkdir(request(a), ctx, adapters())).toEqual({
      type: "session_workdir_change_result", v: 1, id: "req-1", ok: true, cwd: a,
    });
    expect(okAdapter).not.toHaveBeenCalled();
    expect(hubCalls).toEqual([]);
  });

  test.each([
    ["hub が処理中・送信待ち・打ち込み中で押さえを断った", { begin: "busy" }],
    ["別の engine の変更が進行中", { begin: "in_flight" }],
    ["hub に聞けない", { hubDown: true }],
  ] as const)("%s は busy", async (_label, options) => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: realDir("wd-a"), createdAt: 1, claudeSessionId: ID });
    const { ctx } = fakeCtx(store, options);
    okAdapter.mockClear();
    expect(await changeSessionWorkdir(request(realDir("wd-b")), ctx, adapters())).toMatchObject({ ok: false, error: "busy" });
    expect(okAdapter).not.toHaveBeenCalled();
  });

  test("成功したら記録を書き換えて hub へ知らせる（`pc:cwd` は hub が配る）", async () => {
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const store = makeTempStore();
    store.put({ name: "work", cwd: a, createdAt: 1, claudeSessionId: ID });
    const { ctx, hubCalls } = fakeCtx(store);
    expect(await changeSessionWorkdir(request(b), ctx, adapters())).toEqual({
      type: "session_workdir_change_result", v: 1, id: "req-1", ok: true, cwd: b,
    });
    expect(store.get("work")?.cwd).toBe(b);
    // hub で押さえ → 記録と通知 → 放す、の順（放した直後に流れる送信が新しいフォルダの会話へ入る）。
    expect(hubCalls.map((call) => (call as { type: string }).type))
      .toEqual(["workdir_change_begin", "session_cwd_set", "workdir_change_end"]);
    // end は begin に載せた engine の token で送る。
    const token = (hubCalls[0] as { token: string }).token;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(hubCalls.at(-1)).toEqual({ type: "workdir_change_end", session: "work", token });
  });

  test("差し込み口が失敗・例外でも押さえは放す", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: realDir("wd-a"), createdAt: 1, claudeSessionId: ID });
    const { ctx, hubCalls } = fakeCtx(store);
    const throwing = { ...adapters(), claude_terminal: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await changeSessionWorkdir(request(realDir("wd-b")), ctx, throwing)).toMatchObject({ ok: false, error: "failed" });
    expect(hubCalls.at(-1)).toMatchObject({ type: "workdir_change_end", token: (hubCalls[0] as { token: string }).token });
  });

  test("押さえの依頼が時間切れになっても、その token で end を送る（hub が後から与えた押さえを宙に浮かせない）", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: realDir("wd-a"), createdAt: 1, claudeSessionId: ID });
    const { ctx, hubCalls } = fakeCtx(store, { beginTimeout: true });
    okAdapter.mockClear();
    expect(await changeSessionWorkdir(request(realDir("wd-b")), ctx, adapters())).toMatchObject({ ok: false, error: "busy" });
    expect(okAdapter).not.toHaveBeenCalled();
    const begin = hubCalls[0] as { type: string; token: string };
    expect(begin.type).toBe("workdir_change_begin");
    expect(hubCalls.at(-1)).toEqual({ type: "workdir_change_end", session: "work", token: begin.token });
  });

  test("種類の振り分け: Codex は hub の codex_cwd_submit で移す（thread id の無い古い記録は busy より先に断る）", async () => {
    expect(workdirChangeKind({ name: "x", cwd: "/", createdAt: 1, agent: "codex" })).toBe("codex");
    expect(workdirChangeKind({ name: "x", cwd: "/", createdAt: 1, executionRoute: "api" })).toBe("api_agent");
    expect(workdirChangeKind({ name: "x", cwd: "/", createdAt: 1 })).toBe("claude_terminal");
    const a = realDir("wd-a");
    const store = makeTempStore();
    store.put({ name: "cx", cwd: a, createdAt: 1, agent: "codex", providerSessionId: "thread-1" });
    store.put({ name: "old", cwd: a, createdAt: 1, agent: "codex" });
    const { ctx, hubCalls } = fakeCtx(store);
    const b = realDir("wd-b");
    // API 作業は差し込み口（workdir/apiAgent.ts）が hub の api_agent_relocate で移す（sessionWorkdirApiAgent.test.ts）。
    // Codex の差し込み口の詳しい振る舞いは codexWorkdirChange.test.ts。
    expect(await changeSessionWorkdir(request(b, "cx"), ctx, adapters())).toMatchObject({ ok: true, cwd: b });
    expect(hubCalls).toContainEqual(expect.objectContaining({
      type: "codex_cwd_submit", session: "cx", threadId: "thread-1", cwd: a, targetCwd: b,
    }));
    const busyCtx = fakeCtx(store, { begin: "busy" }).ctx;
    expect(await changeSessionWorkdir(request(b, "old"), busyCtx, adapters())).toMatchObject({ ok: false, error: "failed" });
    expect(store.get("old")?.cwd).toBe(a);
  });

  test("同じ会話の変更が進行中なら busy", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: realDir("wd-a"), createdAt: 1, claudeSessionId: ID });
    const { ctx } = fakeCtx(store);
    let release!: () => void;
    const slow = vi.fn(() => new Promise<{ ok: true; cwd: string }>((resolve) => { release = () => resolve({ ok: true, cwd: "/x" }); }));
    const slowAdapters = { ...adapters(), claude_terminal: slow };
    const first = changeSessionWorkdir(request(realDir("wd-b")), ctx, slowAdapters);
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    expect(await changeSessionWorkdir(request(realDir("wd-c")), ctx, slowAdapters)).toMatchObject({ ok: false, error: "busy" });
    release();
    expect(await first).toMatchObject({ ok: true });
  });
});

describe("Claude 端末の差し込み口", () => {
  const aliveInfo = (name: string): SessionInfo =>
    ({ name, alive: true, claudeSessionId: ID, providerSessionId: ID, agent: "claude" }) as unknown as SessionInfo;

  test("端末の Claude が動いていなければ会話ログを移す", async () => {
    const projects = makeTempDir("wd-adapter-offline");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    writeTranscript(projects, a, userLine(a, "hi"));
    const store = makeTempStore();
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    store.put(meta);
    const { ctx, sent } = fakeCtx(store);
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: makeTempDir("wd-registry"), log: () => {},
    });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(sent).toEqual([]);
    expect(claudeTranscriptCwd(path.join(projects, claudeProjectSlug(b), `${ID}.jsonl`))).toBe(b);
  });

  test("Tailii 外の Claude が会話を掴んでいれば busy（何もしない）", async () => {
    const projects = makeTempDir("wd-adapter-external");
    const registry = makeTempDir("wd-registry-ext");
    fs.writeFileSync(path.join(registry, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, name: "mac-terminal" }));
    const a = realDir("wd-a");
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    const { ctx, sent } = fakeCtx(store);
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: registry, peerPidAlive: () => true, log: () => {},
    });
    const result = await adapter({ session: "work", meta, cwd: realDir("wd-b"), requestedCwd: "", ctx });
    expect(result).toMatchObject({ ok: false, error: "busy" });
    expect(sent).toEqual([]);
  });

  test("端末の Claude が動いていれば `/cd <絶対パス>` を送り、relocated 行を確かめて成功する", async () => {
    const projects = makeTempDir("wd-adapter-cd");
    const a = realDir("wd-a");
    const b = realDir("wd-b c"); // 空白入り
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    const trusted: string[] = [];
    // `/cd` を受けた Claude の振る舞い（2.1.325 実測）: 会話ログを移動先の slug へ rename して relocated 行を書く。
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async (_name, text) => {
        sent.push(text);
        const destDir = path.join(projects, claudeProjectSlug(b));
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, `${ID}.jsonl`);
        fs.renameSync(src, dest);
        fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: b }));
      },
    });
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: makeTempDir("wd-registry-cd"), preTrust: (dir) => trusted.push(dir),
      pollMs: 5, timeoutMs: 2_000, log: () => {}, observedClaudeVersion: () => "2.1.325",
    });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(sent).toEqual([`/cd ${b}`]);
    expect(trusted).toEqual([b]);
  });

  test("`/cd` の失敗出力は invalid_cwd、何も起きなければ時間切れで failed", async () => {
    const projects = makeTempDir("wd-adapter-cd-fail");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    const failing = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async () => {
        fs.appendFileSync(src, line({ type: "user", timestamp: new Date().toISOString(),
          message: { role: "user", content: `<local-command-stdout>Couldn't find a directory at \u001b[1m${b}\u001b[22m.</local-command-stdout>` } }));
      },
    });
    const deps = { projectsDir: projects, claudeSessionsDir: makeTempDir("wd-registry-f"), preTrust: () => {}, pollMs: 5,
      timeoutMs: 300, log: () => {}, observedClaudeVersion: () => "2.1.325" };
    expect(await createClaudeTerminalWorkdirAdapter(deps)({ session: "work", meta, cwd: b, requestedCwd: b, ctx: failing.ctx }))
      .toMatchObject({ ok: false, error: "invalid_cwd" });
    const silent = fakeCtx(store, { sessions: [aliveInfo("work")], sendTextSubmit: async () => {} });
    expect(await createClaudeTerminalWorkdirAdapter(deps)({ session: "work", meta, cwd: b, requestedCwd: b, ctx: silent.ctx }))
      .toMatchObject({ ok: false, error: "failed" });
  });

  test("会話ログが 2.1.325 より古い Claude のものなら `/cd` を打たずに unsupported", async () => {
    const projects = makeTempDir("wd-adapter-old");
    const a = realDir("wd-a");
    writeTranscript(projects, a, line({ type: "user", cwd: a, version: "2.1.300", timestamp: "2026-11-01T00:00:00.000Z",
      message: { role: "user", content: "hi" } }));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    const { ctx, sent } = fakeCtx(store, { sessions: [aliveInfo("work")] });
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: makeTempDir("wd-registry-old"), preTrust: () => {}, log: () => {},
      observedClaudeVersion: () => null,
    });
    expect(await adapter({ session: "work", meta, cwd: realDir("wd-b"), requestedCwd: "", ctx }))
      .toMatchObject({ ok: false, error: "unsupported" });
    expect(sent).toEqual([]);
  });

  /** `/cd` を受けた Claude の振る舞い（2.1.325 実測）: 会話ログを移動先の slug へ rename して relocated 行を書く。 */
  function relocate(projects: string, src: string, to: string): string {
    const destDir = path.join(projects, claudeProjectSlug(to));
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${ID}.jsonl`);
    fs.renameSync(src, dest);
    fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: to }));
    return dest;
  }
  const movedTo = (to: string) => line({ type: "system", subtype: "local_command", timestamp: new Date().toISOString(),
    content: `<local-command-stdout>Moved to \u001b[1m${to}\u001b[22m</local-command-stdout>` });
  // 画面は 2.1.325 の実物（tmux capture-pane -J, 120 桁）を写したもの。
  const IDLE = (body: string[] = []) => [
    " ▐▛███▛█   Claude Code v2.1.325", ...body,
    "─".repeat(120), "❯ ", "─".repeat(120), "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
  ].join("\n");
  const TRUST_SCREEN = (to: string, focusYes: boolean) => [
    "▔".repeat(40), "", `  ${"─".repeat(116)}`, "   Moving to a new directory:", "", `   ${to}`, "",
    "   This session hasn't worked here before. Is this a directory you created or one you trust?", "",
    "   Claude Code'll be able to read, edit, and execute files here.", "", "   Security guide", " ".repeat(118),
    `   ${focusYes ? " " : "❯"} No, stay put${" ".repeat(60)}`, `   ${focusYes ? "❯" : " "} Yes, move here${" ".repeat(40)}`, "",
    "   Enter to confirm · Esc to cancel                  ", "",
  ].join("\n");
  const MCP_SCREEN = [
    `${"▔".repeat(80)} ● high · /effort ▔`, "   New MCP server found in this project: tailiiprobe",
    "   MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP",
    "   documentation.", "     Use this MCP server", "     Use this and all future MCP servers in this project",
    "   ❯ Continue without using this MCP server", "   Enter to confirm · Esc to cancel",
  ].join("\n");
  const GRANTS_SCREEN = (to: string) => [
    `  ${"─".repeat(116)}`, "   Now in a new directory:", `   ${to}`,
    "   Its settings declare project permission rules and/or additional directories. They apply only if you trust this",
    "   directory explicitly (it is trusted through a parent directory so far).",
    "   ⚠ This directory pre-approves 1 tool permission in .claude/settings.json: Bash(echo tailii-probe:*)",
    "   These apply to this session only if you trust it. Only proceed if you trust this configuration.",
    "   Security guide", "   ❯ No, keep them off", "     Yes, trust it and apply them", "   Enter to confirm · Esc to cancel",
  ].join("\n");
  /** 背景作業の完了などで勝手に始まったターンのツール承認（実物のフッター）。 */
  const APPROVAL_SCREEN = [
    " Bash command", "   rm -rf build", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  /** `/cd` の確認の画面の文字列を全部含む本文（Tailii の開発中の会話でよく出る）を表示した、待機中の画面。 */
  const IDLE_WITH_QUOTES = (to: string) => IDLE([
    "⏺ 確認の画面は次の形です:", "   Moving to a new directory:", `   ${to}`, "   ❯ No, stay put", "     Yes, move here",
    "   Now in a new directory:", "   ❯ No, keep them off", "     Yes, trust it and apply them",
    "   New MCP server found in this project: x", "     Use this MCP server",
    "     Use this and all future MCP servers in this project", "   ❯ Continue without using this MCP server",
    "   Enter to confirm · Esc to cancel",
  ]);
  const deps = (name: string, extra: Partial<Parameters<typeof createClaudeTerminalWorkdirAdapter>[0]> = {}) => ({
    claudeSessionsDir: makeTempDir(name), preTrust: () => {}, pollMs: 5, timeoutMs: 2_000, log: () => {},
    observedClaudeVersion: () => "2.1.325", ...extra,
  });
  const keysOf = (sent: string[]) => sent.filter((entry) => entry.startsWith("key:"));
  function setup(prefix: string) {
    const projects = makeTempDir(prefix);
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    return { projects, a, b, src, meta, store };
  }

  test("画面の構造での見分け: 実物の 3 つの画面を見分け、本文の引用・ほかの承認・待機中では当たらない", () => {
    const to = "/private/var/folders/x/T/tailii-cdexp8-31337/u";
    expect(classifyCdDialog(TRUST_SCREEN(to, false), to)).toEqual({ kind: "trust", cursor: "no" });
    expect(classifyCdDialog(TRUST_SCREEN(to, true), to)).toEqual({ kind: "trust", cursor: "yes" });
    // 移動先が違うパスの「移る前の確認」には当たらない。
    expect(classifyCdDialog(TRUST_SCREEN("/elsewhere", false), to)).toBeNull();
    expect(classifyCdDialog(MCP_SCREEN, to)).toEqual({ kind: "mcp" });
    expect(classifyCdDialog(GRANTS_SCREEN(to), to)).toEqual({ kind: "grants" });
    expect(classifyCdDialog(GRANTS_SCREEN("/elsewhere"), to)).toBeNull();
    expect(classifyCdDialog(IDLE_WITH_QUOTES(to), to)).toBeNull();
    expect(classifyCdDialog(APPROVAL_SCREEN, to)).toBeNull();
    expect(classifyCdDialog(IDLE(), to)).toBeNull();
    // 狭い画面（60 桁）では Ink がパスを行に分ける（実測）。つないで照らす。
    const narrow = "/private/var/folders/fk/vqqy06sx73dgfhcq0c25lckw0000gp/T/tailii-cdexp8-31337/a-rather-long-folder-name-for-wrapping-check/with space";
    const narrowScreen = [
      "  ────────────────────────────────────────────────────────", "   Moving to a new directory:",
      "   /private/var/folders/fk/vqqy06sx73dgfhcq0c25lckw0000gp", "   /T/tailii-cdexp8-31337/a-rather-long-folder-name-for-w",
      "   rapping-check/with space", "   This session hasn't worked here before. Is this a",
      "   directory you created or one you trust?", "   Security guide", "   ❯ No, stay put", "     Yes, move here",
      "   Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(classifyCdDialog(narrowScreen, narrow)).toEqual({ kind: "trust", cursor: "no" });
  });

  test("移る前の信頼の確認は、構造で確かめてカーソルが No なら Down、Yes にあると確かめた直後だけ Enter", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-trust");
    let screen = IDLE();
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async () => { screen = TRUST_SCREEN(b, false); },
      screen: () => screen,
      sendKeys: (keys) => {
        if (keys[0] === "Down" && screen === TRUST_SCREEN(b, false)) screen = TRUST_SCREEN(b, true);
        if (keys[0] === "Enter" && screen === TRUST_SCREEN(b, true)) {
          const dest = relocate(projects, src, b);
          fs.appendFileSync(dest, movedTo(b));
          screen = IDLE();
        }
      },
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-t", { sleep: async () => {} }) });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(keysOf(sent)).toEqual(["key:Down", "key:Enter"]);
  });

  test("移った後の MCP の承認は、relocated 行の後に遅れて描かれても成功を急がず、Esc で閉じて「Moved to」を待つ", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-mcp");
    let screen = IDLE();
    let dest = "";
    let captures = 0;
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      // relocated 行は移動の時点で書かれ、MCP の承認はその後に描かれる（最初の取り込みには間に合わない）。
      sendTextSubmit: async () => { dest = relocate(projects, src, b); },
      screen: () => {
        captures += 1;
        if (captures === 3 && dest !== "") screen = MCP_SCREEN;
        return screen;
      },
      sendKeys: (keys) => {
        if (keys[0] === "Escape" && screen === MCP_SCREEN) { screen = IDLE(); fs.appendFileSync(dest, movedTo(b)); }
      },
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-m") });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(keysOf(sent)).toEqual(["key:Escape"]);
  });

  test("移った後の権限規則の確認も Esc で閉じる", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-grants");
    let screen = IDLE();
    let dest = "";
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async () => { dest = relocate(projects, src, b); screen = GRANTS_SCREEN(b); },
      screen: () => screen,
      sendKeys: (keys) => {
        if (keys[0] === "Escape" && screen === GRANTS_SCREEN(b)) { screen = IDLE(); fs.appendFileSync(dest, movedTo(b)); }
      },
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-g") });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(keysOf(sent)).toEqual(["key:Escape"]);
  });

  test("本文に確認の画面の文字列が全部ある待機中の画面では、キーを 1 つも送らず「Moved to」で成功する", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-quotes");
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async (_name, text) => { sent.push(text); fs.appendFileSync(relocate(projects, src, b), movedTo(b)); },
      screen: () => IDLE_WITH_QUOTES(b),
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-q") });
    const started = Date.now();
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(keysOf(sent)).toEqual([]);
  });

  test("待っている間に背景で始まったターンの承認が出ても、キーを 1 つも送らない", async () => {
    const { projects, b, meta, store } = setup("wd-adapter-approval");
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      // `/cd` は送信待ちに入り（ターンの後に実行される）、画面には本物の承認が出ている。
      sendTextSubmit: async () => {},
      screen: () => APPROVAL_SCREEN,
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-ap", { timeoutMs: 200 }) });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toMatchObject({ ok: false, error: "failed" });
    expect(keysOf(sent)).toEqual([]);
  });

  test("見分けられない確認の画面（MCP が複数など）が残るときは、キーを送らずに failed と補足を返す", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-unknown-dialog");
    const unknownDialog = ["   New MCP servers found in this project: a, b", "   ❯ Use these", "     Skip",
      "   Enter to confirm · Esc to cancel"].join("\n");
    let screen = IDLE();
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async () => { relocate(projects, src, b); screen = unknownDialog; },
      screen: () => screen,
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-ud", { timeoutMs: 200 }) });
    const result = await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx });
    expect(result).toMatchObject({ ok: false, error: "failed" });
    expect((result as { message?: string }).message).toContain("確認の画面");
    expect((result as { message?: string }).message).not.toMatch(/Mac|tmux|herdr/u);
    expect(keysOf(sent)).toEqual([]);
  });

  test("relocated 行だけ（完了行が無い）でも、確認の画面が出ない状態が続けば成功を返す", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-calm");
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")], sendTextSubmit: async () => { relocate(projects, src, b); }, screen: () => IDLE(),
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-c", { timeoutMs: 5_000 }) });
    const started = Date.now();
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(keysOf(sent)).toEqual([]);
  });

  test("打つ前から出ていた画面には Down / Enter で応えない（返す前に、見分けた画面として Esc で閉じるだけ）", async () => {
    const { projects, b, meta, store } = setup("wd-adapter-pre");
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")], sendTextSubmit: async () => {}, screen: () => TRUST_SCREEN(b, false),
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-p", { timeoutMs: 100 }) });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toMatchObject({ ok: false });
    expect(keysOf(sent).every((key) => key === "key:Escape")).toBe(true);
  });

  test("見分けられた画面が回数を使い切って残るときは、同じ画面と確かめて Esc で閉じてから返す", async () => {
    const { projects, b, src, meta, store } = setup("wd-adapter-leftover");
    let screen = IDLE();
    let dest = "";
    let escapesSeen = 0;
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")],
      sendTextSubmit: async () => { dest = relocate(projects, src, b); screen = MCP_SCREEN; },
      screen: () => screen,
      // 3 回目の Esc で閉じる画面（ループで送れる 2 回では閉じない）。
      sendKeys: (keys) => {
        if (keys[0] !== "Escape") return;
        escapesSeen += 1;
        if (escapesSeen === 3) { screen = IDLE(); fs.appendFileSync(dest, movedTo(b)); }
      },
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-lo", { timeoutMs: 200 }) });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toEqual({ ok: true, cwd: b });
    expect(keysOf(sent)).toEqual(["key:Escape", "key:Escape", "key:Escape"]);
  });

  test("Down も送る直前に取り込み直し、カーソルが No でなくなっていれば送らない", async () => {
    const { projects, b, meta, store } = setup("wd-adapter-down");
    let captures = 0;
    const { ctx, sent } = fakeCtx(store, {
      sessions: [aliveInfo("work")], sendTextSubmit: async () => {},
      // 1 回目（打つ前）は待機中、2 回目は「No」にカーソル、Down の直前の取り込み直しでは画面が消えている。
      screen: () => { captures += 1; return captures === 2 ? TRUST_SCREEN(b, false) : IDLE(); },
    });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: projects, ...deps("wd-registry-d", { timeoutMs: 100 }) });
    await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx });
    expect(keysOf(sent)).toEqual([]);
  });

  test("版が分からなければ `/cd` を打たない（古い Claude は知らないコマンドをモデルへ回し得る）。登録簿の版は使う", async () => {
    const projects = makeTempDir("wd-adapter-unknown");
    const a = realDir("wd-a");
    writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    const unknown = fakeCtx(store, { sessions: [aliveInfo("work")] });
    const deps = { projectsDir: projects, preTrust: () => {}, pollMs: 5, timeoutMs: 100, log: () => {},
      observedClaudeVersion: () => null };
    expect(await createClaudeTerminalWorkdirAdapter({ ...deps, claudeSessionsDir: makeTempDir("wd-registry-u") })(
      { session: "work", meta, cwd: realDir("wd-b"), requestedCwd: "", ctx: unknown.ctx },
    )).toMatchObject({ ok: false, error: "unsupported" });
    expect(unknown.sent).toEqual([]);
    // 会話を掴んでいる Tailii の Claude の登録簿に版があれば、それで判断して打つ。
    const registry = makeTempDir("wd-registry-v");
    fs.writeFileSync(path.join(registry, "7777.json"),
      JSON.stringify({ pid: 7777, sessionId: ID, name: "work", tmux: "work:0.0", version: "2.1.325" }));
    const b = realDir("wd-b");
    const src = path.join(projects, claudeProjectSlug(a), `${ID}.jsonl`);
    const known = fakeCtx(store, { sessions: [aliveInfo("work")], sendTextSubmit: async () => { relocate(projects, src, b); } });
    expect(await createClaudeTerminalWorkdirAdapter({ ...deps, claudeSessionsDir: registry, peerPidAlive: () => true })(
      { session: "work", meta, cwd: b, requestedCwd: b, ctx: known.ctx },
    )).toEqual({ ok: true, cwd: b });
    // 「Unknown command: /cd」が返ったら unsupported。
    expect(readCdVerdict(writeTranscript(projects, realDir("wd-c"), line({ type: "user", timestamp: new Date().toISOString(),
      message: { role: "user", content: "<local-command-stdout>Unknown command: /cd</local-command-stdout>" } }),
    "55555555-5555-5555-5555-555555555555"), 0, "/x", Date.now())).toMatchObject({ ok: false, error: "unsupported" });
  });

  test("送信が拒否されたら（ダイアログ等）busy", async () => {
    const projects = makeTempDir("wd-adapter-reject");
    const a = realDir("wd-a");
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    const rejected = Object.assign(new Error("選択肢が表示されています"), { name: "ChatInjectionRejectedError" });
    const { ctx } = fakeCtx(store, { sessions: [aliveInfo("work")], sendTextSubmit: async () => { throw rejected; } });
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: makeTempDir("wd-registry-r"), preTrust: () => {}, log: () => {},
      observedClaudeVersion: () => "2.1.325",
    });
    expect(await adapter({ session: "work", meta, cwd: realDir("wd-b"), requestedCwd: "", ctx }))
      .toEqual({ ok: false, error: "busy", message: "選択肢が表示されています" });
  });

  test("readCdVerdict: 1 回も発話していない会話は「Moved to」の行で成功（ホーム配下は ~ 表記も受ける）", () => {
    const dir = makeTempDir("wd-verdict");
    const file = path.join(dir, "t.jsonl");
    const b = "/Users/someone/proj";
    fs.writeFileSync(file, line({ type: "system", subtype: "local_command", timestamp: new Date().toISOString(),
      content: `<local-command-stdout>Moved to \u001b[1m${b}\u001b[22m</local-command-stdout>` }));
    expect(readCdVerdict(file, 0, b, Date.now())).toEqual({ ok: true, cwd: b });
    expect(readCdVerdict(file, fs.statSync(file).size, b, Date.now())).toBeNull();
  });
});

describe("hub の `pc:cwd`", () => {
  function hubWith(cwd: string, conversationId = ID) {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd, createdAt: 0, claudeSessionId: conversationId });
    let lifecycle: ((event: ClaudeTurnLifecycleEvent) => void) | undefined;
    let write: ((payload: never) => void) | undefined;
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("wd-hub-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: (w, _codex, onClaudeTurnLifecycle) => ({
        open() { lifecycle = onClaudeTurnLifecycle; write = w as never; }, stop() {},
      }),
    });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l)));
    return { hub, client, received, metadataStore, lifecycle: () => lifecycle!, write: () => write! };
  }
  const cwdEvents = (received: unknown[]) => received.filter((m) =>
    (m as { type?: string; payload?: { streamId?: string } }).type === "conversation_event" &&
    (m as { payload: { streamId?: string } }).payload.streamId === "pc:cwd")
    .map((m) => (m as { payload: { text: string } }).payload.text);

  test("履歴の読み込みの後に今の作業フォルダを 1 回配る", () => {
    const a = realDir("wd-hub-a");
    const h = hubWith(a);
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    expect(cwdEvents(h.received)).toEqual([]);
    h.write()({ type: "chat_output", v: 1, streamId: "pc:history-done", role: "system", text: "1", eof: true } as never);
    expect(cwdEvents(h.received)).toEqual([a]);
  });

  test("追尾中の relocated で記録を直して配る（履歴の relocated と同じ値の繰り返しは配らない）", () => {
    const a = realDir("wd-hub-a");
    const b = realDir("wd-hub-b");
    const h = hubWith(a);
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    h.lifecycle()({ kind: "relocated", atMs: 1, cwd: b, live: false });
    expect(h.metadataStore.get("work")?.cwd).toBe(a);
    h.lifecycle()({ kind: "relocated", atMs: 2, cwd: b, live: true });
    h.lifecycle()({ kind: "relocated", atMs: 3, cwd: b, live: true });
    expect(h.metadataStore.get("work")?.cwd).toBe(b);
    expect(cwdEvents(h.received)).toEqual([b]);
  });

  test("tick: tail していない会話の会話ログが別の slug へ移っていたら記録を直す（端末で打った /cd）", async () => {
    const a = realDir("wd-hub-a");
    const b = realDir("wd-hub-b");
    // 実物の HOME ではなくテスト用の HOME（vitest.config.ts）。ほかのテストと会話 id を分ける。
    const tickId = "44444444-4444-4444-4444-444444444444";
    writeTranscript(path.join(os.homedir(), ".claude", "projects"), b,
      userLine(a, "hi") + line({ type: "relocated", sessionId: tickId, relocatedCwd: b }), tickId);
    const h = hubWith(a, tickId);
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "hub_state_request", id: "s", session: "work" }));
    await h.hub.tick();
    expect(h.metadataStore.get("work")?.cwd).toBe(b);
  });

  test("session_cwd_set で記録を合わせ、購読者へ配って結果を返す", () => {
    const a = realDir("wd-hub-a");
    const b = realDir("wd-hub-b");
    const h = hubWith(a);
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "session_cwd_set", id: "s1", session: "work", cwd: b }));
    expect(h.metadataStore.get("work")?.cwd).toBe(b);
    expect(cwdEvents(h.received)).toEqual([b]);
    expect(h.received).toContainEqual({ type: "session_cwd_set_result", id: "s1", status: "ok" });
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "session_cwd_set", id: "s2", session: "none", cwd: b }));
    expect(h.received).toContainEqual({ type: "session_cwd_set_result", id: "s2", status: "not_found" });
  });
});

describe("hub の押さえ（workdir_change_begin / end）", () => {
  function lockHub(chatInjector = vi.fn(async () => {})) {
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("wd-lock-hb"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, chatInjector });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l)));
    const begin = (id: string, who: object = client) =>
      hub.handleClientMessage(who, JSON.stringify({ type: "workdir_change_begin", id, session: "work", token: `tok-${id}` }));
    const result = (id: string) => received.find((m) =>
      (m as { type?: string; id?: string }).type === "workdir_change_begin_result" && (m as { id: string }).id === id) as
      { status: string; token?: string } | undefined;
    const send = (id: string, clientMessageId: string) => hub.handleClientMessage(client, JSON.stringify({
      type: "chat_send", id, session: "work", clientMessageId, text: "hello" }));
    return { hub, client, received, begin, result, send, chatInjector };
  }

  test("押さえている間は送信を打ち込まず、放したら流す。2 本目の変更は in_flight", async () => {
    const h = lockHub();
    h.begin("b1");
    const token = h.result("b1")?.token;
    expect(h.result("b1")?.status).toBe("granted");
    h.send("s1", "m1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.chatInjector).not.toHaveBeenCalled();
    h.begin("b2");
    expect(h.result("b2")).toMatchObject({ status: "in_flight" });
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "workdir_change_end", session: "work", token }));
    await vi.waitFor(() => expect(h.chatInjector).toHaveBeenCalledOnce());
    expect(h.received).toContainEqual({ type: "chat_send_result", id: "s1", status: "accepted" });
  });

  test("end が begin より先に届いた token には押さえを与えない（順番が入れ替わっても押さえが残らない）", async () => {
    const h = lockHub();
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "workdir_change_end", session: "work", token: "tok-late" }));
    h.begin("late");
    expect(h.result("late")).toMatchObject({ status: "busy" });
    // 押さえは残っていない: 送信はすぐ流れ、次の変更は押さえられる。
    h.send("s1", "m1");
    await vi.waitFor(() => expect(h.chatInjector).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.received).toContainEqual({ type: "chat_send_result", id: "s1", status: "accepted" }));
    h.begin("next");
    expect(h.result("next")).toMatchObject({ status: "granted" });
  });

  test("送信待ち・打ち込み中は押さえない（busy）", async () => {
    let release!: () => void;
    const h = lockHub(vi.fn(() => new Promise<void>((resolve) => { release = resolve; })));
    h.send("s1", "m1");
    await vi.waitFor(() => expect(h.chatInjector).toHaveBeenCalledOnce());
    h.begin("b1");
    expect(h.result("b1")).toMatchObject({ status: "busy" });
    release();
    await vi.waitFor(() => expect(h.received).toContainEqual({ type: "chat_send_result", id: "s1", status: "accepted" }));
    h.begin("b2");
    expect(h.result("b2")).toMatchObject({ status: "granted" });
  });

  test("ターンの実行中・設問の待ちは busy、押さえた engine が切れたら放す", async () => {
    const h = lockHub();
    h.hub.handleRelayMessage({ type: "session_processing", session: "work", state: "active", event: "UserPromptSubmit" });
    h.begin("b1");
    expect(h.result("b1")).toMatchObject({ status: "busy" });
    h.hub.handleRelayMessage({ type: "session_processing", session: "work", state: "done", event: "Stop" });
    const other = {};
    h.hub.registerClient(other, () => {});
    h.begin("b2", other);
    h.hub.unregisterClient(other);
    h.begin("b3");
    expect(h.result("b3")).toMatchObject({ status: "granted" });
  });
});

describe("hub の codex_cwd_submit は始まりかけの Codex のターンを見る", () => {
  test("開始中のターンがあれば busy（controller.setCwd を呼ばない）", async () => {
    const a = realDir("wd-codex-a"), b = realDir("wd-codex-b");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: a, createdAt: 0, agent: "codex", providerSessionId: "thread-1" });
    const setCwd = vi.fn(async ({ targetCwd }: { targetCwd: string }) => targetCwd);
    const startTurn = vi.fn(() => new Promise<string>(() => {}));
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("wd-codex-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: () => ({ open() {}, stop() {} }),
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: () => ({ startTurn, closeSession: vi.fn(), close: vi.fn(), setCwd }) as never,
    } as never);
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l)));
    hub.handleClientMessage(client, JSON.stringify({ type: "codex_turn_submit", id: "t1", session: "work", text: "hi",
      clientUserMessageId: "u1", effort: null, approvalPolicy: null, sandbox: null, threadId: "thread-1", cwd: a }));
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled());
    hub.handleClientMessage(client, JSON.stringify({ type: "codex_cwd_submit", id: "w1", session: "work",
      threadId: "thread-1", cwd: a, targetCwd: b }));
    expect(received).toContainEqual({ type: "codex_cwd_result", id: "w1", status: "busy" });
    expect(setCwd).not.toHaveBeenCalled();
    // 押さえも断る。
    hub.handleClientMessage(client, JSON.stringify({ type: "workdir_change_begin", id: "b1", session: "work", token: "t1" }));
    expect(received).toContainEqual({ type: "workdir_change_begin_result", id: "b1", status: "busy" });
  });
});

describe("追尾が移った会話ログを見失わない", () => {
  function assistantLine(text: string, timestamp: string): string {
    return line({ type: "assistant", sessionId: ID, timestamp, uuid: `u-${text}`,
      message: { role: "assistant", model: "claude-test", content: [{ type: "text", text }] } });
  }
  const texts = (messages: unknown[]) => messages.flatMap((m) => {
    const message = m as { type?: string; role?: string; text?: string };
    return message.type === "chat_output" && message.role === "assistant" ? [message.text] : [];
  });

  test("1 回も発話していない会話: 記録どおりの slug に現れなくても、移動先の slug に作られた会話ログを追う", async () => {
    const projects = makeTempDir("wd-follow-new");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const waitingDir = path.join(projects, claudeProjectSlug(a));
    fs.mkdirSync(waitingDir, { recursive: true });
    const tailer = new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true, pollIntervalMs: 10 });
    const ac = new AbortController();
    const received: unknown[] = [];
    const pump = (async () => {
      for await (const message of tailer.streamProjectDir(waitingDir, ID, null, ac.signal)) received.push(message);
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // `/cd` の後、最初の発話で会話ログが移動先の slug に作られる。
    writeTranscript(projects, b, userLine(b, "hi") + assistantLine("返事", "2026-11-15T10:00:01.000Z"));
    await vi.waitFor(() => expect(texts(received)).toEqual(["返事"]), { timeout: 3_000 });
    ac.abort();
    await pump.catch(() => {});
  });

  test("本文の追尾は移動の後に書き足された行も落とさない（開いたままのファイルを読み続ける）", async () => {
    const projects = makeTempDir("wd-follow-main");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const file = writeTranscript(projects, a, userLine(a, "hi") + assistantLine("一", "2026-11-15T10:00:01.000Z"));
    const tailer = new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true, pollIntervalMs: 10 });
    const ac = new AbortController();
    const received: unknown[] = [];
    const pump = (async () => {
      for await (const message of tailer.streamTranscript(file, ac.signal)) received.push(message);
    })();
    await vi.waitFor(() => expect(texts(received)).toEqual(["一"]));
    const dest = path.join(projects, claudeProjectSlug(b), `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: b }) +
      assistantLine("二", "2026-11-15T10:00:02.000Z"));
    await vi.waitFor(() => expect(texts(received)).toEqual(["一", "二"]));
    ac.abort();
    await pump.catch(() => {});
  });

  test("サブエージェント: 会話ログと付帯フォルダが別の slug へ移っても、読み進めた位置ごと付け替えて表示を続ける", async () => {
    const projects = makeTempDir("wd-follow-sub");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const main = writeTranscript(projects, a, line({ type: "assistant", sessionId: ID, timestamp: "2026-11-15T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_sub", name: "Agent", input: { description: "Sub" } }] } }));
    const subagents = path.join(path.dirname(main), ID, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, "agent-sub.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "Sub", toolUseId: "toolu_sub", spawnDepth: 1 }));
    const child = (text: string, timestamp: string, tool?: string) => line({ agentId: "sub", isSidechain: true, timestamp,
      message: tool === undefined ? { role: "user", content: text }
        : { role: "assistant", content: [{ type: "tool_use", id: `toolu_${text}`, name: "Bash", input: { command: tool } }] } });
    fs.writeFileSync(path.join(subagents, "agent-sub.jsonl"), child("start", "2026-11-15T10:00:01.000Z"));
    const tailer = new SubagentTailer({ pollIntervalMs: 10, probeSessionAlive: () => Promise.resolve(true), codexExecLinker: null });
    const ac = new AbortController();
    const nodes: Array<{ currentActivity?: string | null; status: string }> = [];
    const pump = (async () => {
      for await (const message of tailer.streamSession(main, ac.signal)) {
        if (message.type === "subagent_node") nodes.push(message.node);
      }
    })();
    await vi.waitFor(() => expect(nodes.length).toBeGreaterThan(0));
    // `/cd` で本体と付帯フォルダが移動先の slug へ移る。移った後の行が表示に届く。
    const destDir = path.join(projects, claudeProjectSlug(b));
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(main, path.join(destDir, `${ID}.jsonl`));
    fs.renameSync(path.join(path.dirname(main), ID), path.join(destDir, ID));
    fs.appendFileSync(path.join(destDir, ID, "subagents", "agent-sub.jsonl"),
      child("moved", "2026-11-15T10:00:05.000Z", "npm test"));
    await vi.waitFor(() => expect(nodes.at(-1)?.currentActivity).toBe("Bash: npm test"), { timeout: 3_000 });
    expect(tailer.jsonlPath("sub")).toBe(path.join(destDir, ID, "subagents", "agent-sub.jsonl"));
    ac.abort();
    await pump.catch(() => {});
  });
});

describe("ワークツリーの片付けは会話を始めたフォルダも数える（Claude）", () => {
  const LATER = { now: Date.now() + 31 * 60 * 1_000 };
  function git(root: string, args: string[]): string {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  }
  function makeRepository(): string {
    const root = makeTempDir("wd-janitor-repo");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Tailii Test"]);
    git(root, ["config", "user.email", "tailii@example.invalid"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);
    return fs.realpathSync(root);
  }
  function world() {
    const projects = makeTempDir("wd-janitor-projects");
    vi.stubEnv("TAILII_CLAUDE_SESSIONS_DIR", makeTempDir("wd-janitor-registry"));
    const writes: unknown[] = [];
    const tasks: Promise<unknown>[] = [];
    const ctx = {
      state: { negotiatedVersion: 1 },
      writer: { write: (message: unknown) => writes.push(message) },
      trackBackground: (task: Promise<unknown>) => { tasks.push(task); },
      sessionManager: { list: async () => [], agentProcessIds: async () => null },
      metadataStore: null,
      claudeSessionStore: new ClaudeSessionStore(projects),
      codexSessionStore: null,
      codexAppServer: null,
    } as unknown as HandlerContext;
    return { projects, ctx, writes, tasks };
  }
  /** ワークツリー W で始めて、`/cd` で本体 R へ出た会話（会話ログは R の slug、先頭の cwd は W）。 */
  function movedOutConversation(projects: string, worktree: string, root: string): void {
    writeTranscript(projects, root, userLine(worktree, "hi") +
      line({ type: "relocated", sessionId: ID, relocatedCwd: root }) + userLine(root, "after"));
  }

  test("孤児掃除: 始めたワークツリーを使用中に数えて消さない", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktree = fs.realpathSync(created.worktreePath);
    const w = world();
    movedOutConversation(w.projects, worktree, root);
    expect(w.ctx.claudeSessionStore!.list()[0]?.cwd).toBe(root);
    expect((await sweepOrphanWorktrees(w.ctx, root, LATER)).removed).toEqual([]);
    expect(fs.existsSync(worktree)).toBe(true);
    vi.unstubAllEnvs();
  });

  test("会話の完全削除: 始めたワークツリーも片付けの対象にする（変更なしなら消す）", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    const worktree = fs.realpathSync(created.worktreePath);
    const w = world();
    movedOutConversation(w.projects, worktree, root);
    await conversationHandlers.conversation_delete!(
      { type: "conversation_delete", v: 1, id: "d1", agent: "claude", sessionId: ID } as never, w.ctx);
    await Promise.all(w.tasks);
    expect(w.writes.at(-1)).toMatchObject({ type: "conversation_delete_result", ok: true, worktreePath: worktree, worktreeRemoved: true });
    expect(fs.existsSync(worktree)).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("Codex: 押さえの間に届いた送信", () => {
  test("hub: 押さえの間に積まれた送信は見逃して変更を進め、放した後に新しいフォルダで始める", async () => {
    const a = realDir("wd-codex-held-a"), b = realDir("wd-codex-held-b");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: a, createdAt: 0, agent: "codex", providerSessionId: "thread-1" });
    const setCwd = vi.fn(async ({ targetCwd }: { targetCwd: string }) => targetCwd);
    const startTurn = vi.fn(async (_options: { cwd: string }) => "turn-1");
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("wd-codex-held-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: () => ({ open() {}, stop() {} }),
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: () => ({ startTurn, closeSession: vi.fn(), close: vi.fn(), setCwd }) as never,
    } as never);
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l)));
    hub.handleClientMessage(client, JSON.stringify({ type: "workdir_change_begin", id: "b1", session: "work", token: "t1" }));
    expect(received).toContainEqual({ type: "workdir_change_begin_result", id: "b1", status: "granted", token: "t1" });
    hub.handleClientMessage(client, JSON.stringify({ type: "codex_turn_submit", id: "s1", session: "work", text: "hi",
      clientUserMessageId: "u1", effort: null, approvalPolicy: null, sandbox: null, threadId: "thread-1", cwd: a }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startTurn).not.toHaveBeenCalled();
    hub.handleClientMessage(client, JSON.stringify({ type: "codex_cwd_submit", id: "w1", session: "work",
      threadId: "thread-1", cwd: a, targetCwd: b }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "codex_cwd_result", id: "w1", status: "ok", cwd: b }));
    hub.handleClientMessage(client, JSON.stringify({ type: "session_cwd_set", id: "c1", session: "work", cwd: b }));
    hub.handleClientMessage(client, JSON.stringify({ type: "workdir_change_end", session: "work", token: "t1" }));
    // 待たせた送信は、送った時点の作業フォルダ（a）ではなく今の記録（b）で始める。
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    expect(startTurn.mock.calls[0]![0].cwd).toBe(b);
  });

  test("engine: 送信が時間切れでも、hub が作業フォルダの変更で押さえていれば同じ送信で待ち直す", async () => {
    const store = makeTempStore();
    store.put({ name: "cx", cwd: "/tmp/cx", createdAt: 1, agent: "codex", providerSessionId: "thread-1" });
    const calls: string[] = [];
    let submits = 0;
    const written: unknown[] = [];
    const ctx = {
      state: { negotiatedVersion: 1 }, metadataStore: store, codexHubRpcTimeoutMs: 15_000,
      writer: { write: (message: unknown) => written.push(message) },
      hubRpc: async (request: { type: string; id: string }) => {
        calls.push(request.type);
        if (request.type === "hub_state_request") {
          return { type: "hub_state_response", id: request.id, session: "cx", pendingQuestion: null, processing: false,
            workdirChangeHeld: true };
        }
        submits += 1;
        if (submits === 1) throw new Error("hub rpc timeout");
        return { type: "codex_turn_result", id: request.id, status: "started" };
      },
    } as unknown as HandlerContext;
    await codexHandlers.codex_turn_start!({ type: "codex_turn_start", v: 1, id: "s1", session: "cx", text: "hi" } as never, ctx);
    expect(calls).toEqual(["codex_turn_submit", "hub_state_request", "codex_turn_submit"]);
    expect(written).toEqual([{ type: "codex_turn_start_result", v: 1, id: "s1", status: "started" }]);
  });
});

describe("`pc:cwd` は理解すると名乗ったアプリにだけ送る", () => {
  async function run(hello: string) {
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 1, agent: "claude", providerSessionId: "provider-1" });
    const hubLink: HubLink = {
      onMessage: null, onReconnect: null,
      send(message) {
        if (message.type === "hub_state_request") queueMicrotask(() => hubLink.onMessage?.({
          type: "hub_state_response", id: message.id, session: message.session, pendingQuestion: null, processing: false,
        }));
        return true;
      },
      close: vi.fn(),
    };
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("work\n") : ok(""));
    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }), metadataStore: store, hubLink,
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(hello);
    hubLink.onReconnect?.({ bootId: "boot-a", disconnectedAtMs: null });
    engine.writeLine('{"id":"open","name":"work","type":"session_reattach","v":2}');
    await engine.lines.nextOfType("session_list_response");
    const emit = (serverSeq: number, streamId: string, text: string) => hubLink.onMessage?.({
      type: "conversation_event", session: "work", serverSeq,
      payload: { type: "chat_output", v: 1, streamId, role: "system", text, eof: true } });
    // 購読開始時の 1 回（serverSeq 0）と、変わったときの配信（serverSeq > 0）。最後に目印の行。
    emit(0, "pc:cwd", "/tmp/a");
    emit(8, "pc:cwd", "/tmp/b");
    emit(9, "visible", "after");
    const outputs: string[] = [];
    for (;;) {
      const message = decodeControlMessage(await engine.lines.nextOfType("chat_output")) as { streamId: string };
      outputs.push(message.streamId);
      if (message.streamId === "visible") break;
    }
    await engine.teardown();
    return outputs;
  }

  test("名乗らない（古い）アプリには送らない", async () => {
    expect(await run('{"maxVersion":2,"type":"channel_hello","v":2}')).toEqual(["visible"]);
  });

  test("workdirChange: 1 を名乗ったアプリには送る", async () => {
    expect(await run('{"maxVersion":2,"type":"channel_hello","v":2,"workdirChange":1}')).toEqual(["pc:cwd", "pc:cwd", "visible"]);
  });
});

describe("軽い手当て", () => {
  test("記録の書き込みは書き手ごとの一時ファイルを使い、残さない", () => {
    const dir = makeTempDir("wd-meta-tmp");
    const store = new SessionMetadataStore(dir);
    const other = new SessionMetadataStore(dir);
    for (let i = 0; i < 20; i++) {
      store.put({ name: "work", cwd: `/tmp/a${i}`, createdAt: 1 });
      other.put({ name: "work", cwd: `/tmp/b${i}`, createdAt: 1 });
    }
    expect(fs.readdirSync(dir)).toEqual(["work.json"]);
    expect(store.get("work")?.cwd).toBe("/tmp/b19");
  });

  test("直せなかった会話は、会話ログが変わるまで照合し直さない", () => {
    const projects = makeTempDir("wd-unfixable");
    const a = realDir("wd-a");
    const parent = realDir("wd-gone");
    const gone = path.join(parent, "later");
    const file = writeTranscript(projects, gone, userLine(a, "hi") + line({ type: "relocated", sessionId: ID, relocatedCwd: gone }));
    const store = makeTempStore();
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    store.put(meta);
    // 移った先のフォルダが無いので直せない。
    expect(ensureClaudeMetaCwd(store, meta, { projectsDir: projects }).cwd).toBe(a);
    // フォルダができても、会話ログが変わらない間は照合し直さない（hub が毎分呼ぶ）。
    fs.mkdirSync(gone);
    expect(ensureClaudeMetaCwd(store, meta, { projectsDir: projects }).cwd).toBe(a);
    // 会話ログが変われば照合し直して直す。
    fs.appendFileSync(file, userLine(gone, "next"));
    expect(ensureClaudeMetaCwd(store, meta, { projectsDir: projects }).cwd).toBe(gone);
  });
});

describe("送信の門番: 最下部の `Enter to confirm` のフッターは確認の画面", () => {
  const RULE = "─".repeat(80);
  const IDLE_BAR = ["⏺ 前の応答", "", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
  const TRUST = [
    "  ────────────────────────────", "   Moving to a new directory:", "   /x/y",
    "   This session hasn't worked here before. Is this a directory you created or one you trust?", "   Security guide",
    "   ❯ No, stay put", "     Yes, move here", "   Enter to confirm · Esc to cancel",
  ].join("\n");
  /** MCP が複数のときの選択式の画面（形の例。フッターは同じ）。 */
  const MULTI_SELECT = [
    "   New MCP servers found in this project", "   ❯ ◻ alpha", "     ◻ beta", "   Space to select · Enter to confirm · Esc to cancel",
    "   Enter to confirm · Esc to cancel",
  ].join("\n");
  const IDLE_QUOTING = ["⏺ フッターは次の形です:", "   Enter to confirm · Esc to cancel", "", RULE, "❯ ", RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");

  test("判定: 1 つの形・選択式の形は確認の画面、本文に同じ文字列がある待機中の画面・入力欄の下書きは当たらない", () => {
    expect(screenShowsConfirmDialogFooter(TRUST)).toBe(true);
    expect(screenShowsConfirmDialogFooter(MULTI_SELECT)).toBe(true);
    expect(screenShowsConfirmDialogFooter(IDLE_QUOTING)).toBe(false);
    expect(classifySubmitFrame(IDLE_QUOTING)).toBe("submitted");
    // 入力欄の下書きの 2 行目がたまたま同じ文字で始まっても、バーが見えていれば数えない。
    const draft = ["⏺ 前の応答", "", RULE, "❯ メモ", "  Enter to confirm を押す", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    expect(screenShowsConfirmDialogFooter(draft)).toBe(false);
    // 本文の途中（最下部の 4 行より上）にあるだけでも当たらない。
    expect(screenShowsConfirmDialogFooter(["   Enter to confirm · Esc to cancel", "a", "b", "c", "d", "e"].join("\n"))).toBe(false);
    // Enter の後の判定（送信確定ループ・入力欄の残り物の送信）は従来どおり「判別できない画面」。
    expect(classifySubmitFrame(TRUST)).toBe("unknown");
    expect(screenShowsDialogFooter(TRUST)).toBe(false);
  });

  test("tmux: 確認の画面の表示中は本文を 1 キーも打たずに断る", async () => {
    for (const screen of [TRUST, MULTI_SELECT]) {
      const runner = new MockTmuxRunner((args) => args[0] === "capture-pane" ? ok(screen) : ok(""));
      const manager = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore(),
        submitDelayMs: 0, submitVerifyDelayMs: 0, clearKeyDelayMs: 0 });
      await expect(manager.sendTextSubmit("s", "こんにちは")).rejects.toMatchObject({ name: "ChatInjectionRejectedError" });
      expect(runner.recorded.filter((args) => args[0] === "send-keys")).toEqual([]);
    }
  });

  test("herdr: 確認の画面の表示中は本文を 1 キーも打たずに断る", async () => {
    for (const screen of [TRUST, MULTI_SELECT]) {
      const store = new SessionMetadataStore(makeTempDir("wd-gate-herdr"));
      store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
      const herdrOk = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      const recorded: string[][] = [];
      const runner = async (args: string[]) => {
        recorded.push(args);
        if (args[0] === "pane" && args[1] === "list") {
          return herdrOk(JSON.stringify({ id: "cli:pane:list", result: { type: "pane_list", panes: [{ pane_id: "w4:p2", label: "s-a" }] } }));
        }
        if (args[0] === "pane" && args[1] === "get") {
          return herdrOk(JSON.stringify({ id: "cli:pane:get", result: { pane: { agent_status: "idle" } } }));
        }
        if (args[0] === "pane" && args[1] === "read") return herdrOk(screen);
        return herdrOk("");
      };
      const manager = new HerdrSessionManager({ runner, store, submitDelayMs: 0, submitVerifyDelayMs: 0,
        inputRetryDelayMs: 0, clearKeyDelayMs: 0, readyTimeoutMs: 1000, readyPollMs: 0 } as never);
      await expect(manager.sendTextSubmit("s-a", "こんにちは")).rejects.toMatchObject({ name: "ChatInjectionRejectedError" });
      expect(recorded.filter((args) => args[1] === "send-text" || args[1] === "send-keys")).toEqual([]);
    }
  });
});

describe("送信の門番: 行頭が `Enter to confirm` でないフッターと、崩れた画面の本文", () => {
  const RULE = "─".repeat(80);
  const BAR = "  ⏵⏵ auto mode on (shift+tab to cycle)";
  /** 選択式の形の例（`Space to select · Enter to confirm · Esc to cancel`。実物の文言は未確認）。 */
  const SELECT_ONLY = ["   New MCP servers found in this project", "   ❯ ◻ alpha", "     ◻ beta", "",
    "   Space to select · Enter to confirm · Esc to cancel"].join("\n");

  test("判定: `Enter to confirm` と `Esc to` を両方含む最下部の行も確認の画面", () => {
    expect(screenShowsConfirmDialogFooter(SELECT_ONLY)).toBe(true);
    // バーが見えている待機中の画面で、本文にこの行があっても当たらない。
    expect(screenShowsConfirmDialogFooter(["⏺ Space to select · Enter to confirm · Esc to cancel", RULE, "❯ ", RULE, BAR].join("\n")))
      .toBe(false);
  });

  test("tmux / herdr: 選択式の形の表示中も本文を打たずに断る", async () => {
    const runner = new MockTmuxRunner((args) => args[0] === "capture-pane" ? ok(SELECT_ONLY) : ok(""));
    const tmux = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore(), submitDelayMs: 0, submitVerifyDelayMs: 0 });
    await expect(tmux.sendTextSubmit("s", "こんにちは")).rejects.toMatchObject({ name: "ChatInjectionRejectedError" });
    expect(runner.recorded.filter((args) => args[0] === "send-keys")).toEqual([]);

    const store = new SessionMetadataStore(makeTempDir("wd-gate-herdr-select"));
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const recorded: string[][] = [];
    const herdrOk = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
    const herdr = new HerdrSessionManager({
      runner: async (args: string[]) => {
        recorded.push(args);
        if (args[0] === "pane" && args[1] === "list") {
          return herdrOk(JSON.stringify({ id: "l", result: { type: "pane_list", panes: [{ pane_id: "w4:p2", label: "s-a" }] } }));
        }
        if (args[0] === "pane" && args[1] === "get") return herdrOk(JSON.stringify({ id: "g", result: { pane: { agent_status: "idle" } } }));
        if (args[0] === "pane" && args[1] === "read") return herdrOk(SELECT_ONLY);
        return herdrOk("");
      },
      store, submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0, clearKeyDelayMs: 0, readyTimeoutMs: 1000, readyPollMs: 0,
    } as never);
    await expect(herdr.sendTextSubmit("s-a", "こんにちは")).rejects.toMatchObject({ name: "ChatInjectionRejectedError" });
    expect(recorded.filter((args) => args[1] === "send-text" || args[1] === "send-keys")).toEqual([]);
  });

  test("枠: relocated 行の後に選択式の形が残っても成功にせず failed を返す（キーは送らない）", async () => {
    const projects = makeTempDir("wd-select-left");
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    let screen = ["⏺ 前の応答", RULE, "❯ ", RULE, BAR].join("\n");
    const sent: string[] = [];
    const ctx = {
      sessionManager: {
        list: async () => [{ name: "work", alive: true, claudeSessionId: ID, providerSessionId: ID, agent: "claude" }],
        sendTextSubmit: async () => {
          const dest = path.join(projects, claudeProjectSlug(b), `${ID}.jsonl`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(src, dest);
          fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: b }));
          screen = SELECT_ONLY;
        },
        sendKeys: async (_name: string, keys: string[]) => { sent.push(...keys); },
        captureVisibleAnsi: async () => screen,
        agentProcessIds: async () => null,
      },
    } as unknown as HandlerContext;
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: makeTempDir("wd-select-reg"), preTrust: () => {}, pollMs: 5, timeoutMs: 2_500,
      log: () => {}, observedClaudeVersion: () => "2.1.325",
    });
    expect(await adapter({ session: "work", meta, cwd: b, requestedCwd: b, ctx })).toMatchObject({ ok: false, error: "failed" });
    expect(sent).toEqual([]);
  });

  test("送信確定ループ: 崩れた画面で本文の最終行が `Enter to confirm` で始まるだけなら Enter を撃つ。本文以外のフッターが出たら撃たない", () => {
    const typed = "計画を見直して\nEnter to confirm を押す前に確かめる";
    const broken = ["⏺ 前の応答", "❯ 計画を見直して", "  Enter to confirm を押す前に確かめる", "❯ "].join("\n");
    expect(screenShowsConfirmDialogFooter(broken)).toBe(true);
    expect(confirmDialogAppeared(broken, typed)).toBe(false);
    // 打った後に本物の確認の画面が出た（本文に無いフッター）。
    const dialog = ["   Moving to a new directory:", "   /x", "   ❯ No, stay put", "     Yes, move here",
      "   Enter to confirm · Esc to cancel"].join("\n");
    expect(confirmDialogAppeared(dialog, typed)).toBe(true);
    expect(confirmDialogAppeared(dialog, null)).toBe(true);
  });

  test("送信確定ループ（tmux）: 崩れた画面の本文の行では Enter を撃ち、打った後に出た確認の画面には撃たない", async () => {
    const typed = "Enter to confirm を押す前に確かめる";
    for (const appear of ["typed-line", "dialog"] as const) {
      let typedOnce = false;
      let entered = false;
      const idle = ["⏺ 前の応答", RULE, "❯ ", RULE, BAR].join("\n");
      const afterTyping = appear === "typed-line"
        ? ["⏺ 前の応答", `❯ ${typed}`].join("\n") // バーが崩れた画面（pasted-inline-shifted の形）
        : ["   Now in a new directory:", "   /x", "   ❯ No, keep them off", "     Yes, trust it and apply them",
          "   Enter to confirm · Esc to cancel"].join("\n");
      const runner = new MockTmuxRunner((args) => {
        if (args[0] === "capture-pane") return ok(entered ? idle : typedOnce ? afterTyping : idle);
        if (args[0] === "send-keys" && args.includes("-l")) typedOnce = true;
        if (args[0] === "send-keys" && args.includes("Enter")) entered = true;
        return ok("");
      });
      const tmux = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore(), submitDelayMs: 0, submitVerifyDelayMs: 0,
        clearKeyDelayMs: 0 });
      await tmux.sendTextSubmit("s", typed).catch(() => {});
      expect(entered).toBe(appear === "typed-line");
    }
  });
});

describe("実物の生キャプチャで、確認の画面の判定が誤って当たらない（退行の見張り）", () => {
  // test/fixtures/pane（実機の ANSI 付きキャプチャ）と test/fixtures/pane-derived。どれも `/cd` 等の確認系ダイアログ
  // （`Enter to confirm`）を写したものではないので、1 枚も当たってはいけない（当たると普通の画面で送信が断られる）。
  // 確認の画面を写した fixture を足すときは、ここから外して true を期待する側に分けること。
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  const files = ["pane", "pane-derived"].flatMap((dir) => fs.readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith(".ansi") || name.endsWith(".txt")).map((name) => path.join(root, dir, name)));

  test("fixture が揃っている（見張りが空回りしない）", () => {
    expect(files.length).toBeGreaterThanOrEqual(57);
  });

  test.each(files.map((file) => [path.relative(root, file), file]))("%s", (_name, file) => {
    const screen = fs.readFileSync(file, "utf8");
    expect(screenShowsConfirmDialogFooter(screen)).toBe(false);
    expect(confirmDialogAppeared(screen, null)).toBe(false);
  });

  // 確認の画面を写した fixture（test/fixtures/pane-dialog）は、当たる側。
  const dialogFiles = fs.readdirSync(path.join(root, "pane-dialog")).map((name) => path.join(root, "pane-dialog", name));
  test.each(dialogFiles.map((file) => [path.relative(root, file), file]))("確認の画面: %s", (_name, file) => {
    expect(screenShowsConfirmDialogFooter(fs.readFileSync(file, "utf8"))).toBe(true);
  });
});

describe("MCP が 2 つ以上のときの承認の画面（実物 2.1.325）", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  /** 実物の取り込み（MCP を 2 つ書いた `.mcp.json` のあるフォルダへ `/cd` で移った後）。 */
  const MULTI = fs.readFileSync(path.join(root, "pane-dialog", "cd-mcp-multi.txt"), "utf8");
  const RULE = "─".repeat(80);
  const BAR = "  ⏵⏵ auto mode on (shift+tab to cycle)";
  const IDLE = ["⏺ 前の応答", RULE, "❯ ", RULE, BAR].join("\n");

  test("見分け: 実物の画面・カーソルが Enable selected・3 つのとき。崩れた並び・本文の引用には当たらない", () => {
    expect(classifyCdDialog(MULTI, "/any")).toEqual({ kind: "mcp" });
    const onEnable = MULTI.replace("   ❯ [✔] e2e-noop-one", "     [✔] e2e-noop-one").replace("        Enable selected", "      ❯ Enable selected");
    expect(classifyCdDialog(onEnable, "/any")).toEqual({ kind: "mcp" });
    const three = MULTI.replace("2 new MCP servers", "3 new MCP servers").replace("     [✔] e2e-noop-two", "     [✔] e2e-noop-two\n     [ ] e2e-noop-three");
    expect(classifyCdDialog(three, "/any")).toEqual({ kind: "mcp" });
    // カーソルが 2 つ・選択肢が無い・題が無い・待機中の本文の引用。
    expect(classifyCdDialog(MULTI.replace("     [✔] e2e-noop-two", "   ❯ [✔] e2e-noop-two"), "/any")).toBeNull();
    expect(classifyCdDialog(MULTI.replace(/ {3}❯ \[✔\] e2e-noop-one\n {5}\[✔\] e2e-noop-two\n/u, ""), "/any")).toBeNull();
    expect(classifyCdDialog(MULTI.replace("2 new MCP servers found in this project", "Something else"), "/any")).toBeNull();
    expect(classifyCdDialog(`${MULTI}\n${RULE}\n❯ \n${RULE}\n${BAR}`, "/any")).toBeNull();
  });

  test("門番: 実物の画面は確認の画面（tmux / herdr とも打たずに断る）", async () => {
    expect(screenShowsConfirmDialogFooter(MULTI)).toBe(true);
    const runner = new MockTmuxRunner((args) => args[0] === "capture-pane" ? ok(MULTI) : ok(""));
    const tmux = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore(), submitDelayMs: 0, submitVerifyDelayMs: 0 });
    await expect(tmux.sendTextSubmit("s", "こんにちは")).rejects.toMatchObject({ name: "ChatInjectionRejectedError" });
    expect(runner.recorded.filter((args) => args[0] === "send-keys")).toEqual([]);
    const store = new SessionMetadataStore(makeTempDir("wd-multi-herdr"));
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const recorded: string[][] = [];
    const herdrOk = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
    const herdr = new HerdrSessionManager({
      runner: async (args: string[]) => {
        recorded.push(args);
        if (args[0] === "pane" && args[1] === "list") {
          return herdrOk(JSON.stringify({ id: "l", result: { type: "pane_list", panes: [{ pane_id: "w4:p2", label: "s-a" }] } }));
        }
        if (args[0] === "pane" && args[1] === "get") return herdrOk(JSON.stringify({ id: "g", result: { pane: { agent_status: "idle" } } }));
        if (args[0] === "pane" && args[1] === "read") return herdrOk(MULTI);
        return herdrOk("");
      },
      store, submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0, clearKeyDelayMs: 0, readyTimeoutMs: 1000, readyPollMs: 0,
    } as never);
    const started = Date.now();
    await expect(herdr.sendTextSubmit("s-a", "こんにちは")).rejects.toMatchObject({ name: "ChatInjectionRejectedError" });
    expect(Date.now() - started).toBeLessThan(2_000); // 入力欄を 20 秒待たない
    expect(recorded.filter((args) => args[1] === "send-text" || args[1] === "send-keys")).toEqual([]);
  });

  function adapterWorld(prefix: string) {
    const projects = makeTempDir(prefix);
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    const store = makeTempStore();
    store.put(meta);
    return { projects, a, b, src, meta, store };
  }
  const relocateTo = (projects: string, src: string, to: string): string => {
    const dest = path.join(projects, claudeProjectSlug(to), `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: to }));
    return dest;
  };
  const movedLine = (to: string) => line({ type: "system", subtype: "local_command", timestamp: new Date().toISOString(),
    content: `<local-command-stdout>Moved to ${to}</local-command-stdout>` });
  function ctxWith(world: ReturnType<typeof adapterWorld>, onSend: () => void, screenOf: () => string, onKeys: (keys: string[]) => void) {
    const sent: string[] = [];
    const ctx = {
      sessionManager: {
        list: async () => [{ name: "work", alive: true, claudeSessionId: ID, providerSessionId: ID, agent: "claude" }],
        sendTextSubmit: async () => { onSend(); },
        sendKeys: async (_name: string, keys: string[]) => { sent.push(...keys); onKeys(keys); },
        captureVisibleAnsi: async () => screenOf(),
        agentProcessIds: async () => null,
      },
    } as unknown as HandlerContext;
    void world;
    return { ctx, sent };
  }
  const adapterDeps = (name: string, timeoutMs = 3_000) => ({
    claudeSessionsDir: makeTempDir(name), preTrust: () => {}, pollMs: 5, timeoutMs, log: () => {},
    observedClaudeVersion: () => "2.1.325",
  });

  test("枠: 移動の記録の後に出た実物の画面を Esc（全部拒否）で閉じ、「Moved to」を待って成功", async () => {
    const w = adapterWorld("wd-multi-close");
    let screen = IDLE;
    let dest = "";
    const { ctx, sent } = ctxWith(w, () => { dest = relocateTo(w.projects, w.src, w.b); screen = MULTI; }, () => screen,
      (keys) => { if (keys[0] === "Escape" && screen === MULTI) { screen = IDLE; fs.appendFileSync(dest, movedLine(w.b)); } });
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: w.projects, ...adapterDeps("wd-multi-r1") });
    expect(await adapter({ session: "work", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx })).toEqual({ ok: true, cwd: w.b });
    expect(sent).toEqual(["Escape"]);
  });

  test("枠: 知らない文言の画面が残る（入力欄へ戻らない）なら、1.5 秒たっても成功にせず failed と補足（キーは送らない）", async () => {
    const w = adapterWorld("wd-multi-unknown");
    const unknown = ["   Something new from Claude", "   ❯ Option A", "     Option B", "   Press the magic key"].join("\n");
    let screen = IDLE;
    const { ctx, sent } = ctxWith(w, () => { relocateTo(w.projects, w.src, w.b); screen = unknown; }, () => screen, () => {});
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: w.projects, ...adapterDeps("wd-multi-r2", 2_500) });
    const result = await adapter({ session: "work", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx });
    expect(result).toMatchObject({ ok: false, error: "failed" });
    expect((result as { message?: string }).message).toContain("確認の画面");
    expect(sent).toEqual([]);
  });

  test("枠: 入力欄へ戻っていれば relocated 行だけでも 1.5 秒で成功（文言に頼らない）", async () => {
    const w = adapterWorld("wd-multi-calm");
    const { ctx, sent } = ctxWith(w, () => { relocateTo(w.projects, w.src, w.b); }, () => IDLE, () => {});
    const adapter = createClaudeTerminalWorkdirAdapter({ projectsDir: w.projects, ...adapterDeps("wd-multi-r3") });
    expect(await adapter({ session: "work", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx })).toEqual({ ok: true, cwd: w.b });
    expect(sent).toEqual([]);
  });
});

describe("購読開始時の `pc:cwd` に古い値を配らない", () => {
  test("1 回も発話していない会話を移した後、履歴の読み込みが記録の書き換えより先に終わっても新しい値だけを配る", () => {
    const a = realDir("wd-first-a");
    const b = realDir("wd-first-b");
    const conversation = "66666666-6666-6666-6666-666666666666";
    // `/cd` の後、会話ログは移動先の slug に初めて作られる（行の cwd は移動先）。記録はまだ古いまま。
    writeTranscript(path.join(os.homedir(), ".claude", "projects"), b, line({ type: "system", subtype: "local_command",
      cwd: b, sessionId: conversation, content: "<local-command-stdout>Moved to x</local-command-stdout>" }), conversation);
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: a, createdAt: 0, claudeSessionId: conversation });
    let write: ((payload: never) => void) | undefined;
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("wd-first-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: (w) => ({ open() { write = w as never; }, stop() {} }),
    });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    received.length = 0;
    write!({ type: "chat_output", v: 1, streamId: "pc:history-done", role: "system", text: "1", eof: true } as never);
    const cwds = received.filter((m) => (m as { payload?: { streamId?: string } }).payload?.streamId === "pc:cwd")
      .map((m) => (m as { payload: { text: string } }).payload.text);
    expect(cwds).toEqual([b]);
    expect(metadataStore.get("work")?.cwd).toBe(b);
  });
});

describe("成功までの時間（「Moved to」が出たらすぐ返す）", () => {
  const RULE = "─".repeat(80);
  const IDLE = ["⏺ 前の応答", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
  const MULTI = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pane-dialog", "cd-mcp-multi.txt"), "utf8");

  function world(prefix: string) {
    const projects = makeTempDir(prefix);
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const meta = { name: "work", cwd: a, createdAt: 1, claudeSessionId: ID };
    return { projects, a, b, src, meta };
  }
  const moveWithLine = (projects: string, src: string, to: string, withMoved: boolean): string => {
    const dest = path.join(projects, claudeProjectSlug(to), `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: to }));
    if (withMoved) {
      fs.appendFileSync(dest, line({ type: "system", subtype: "local_command", timestamp: new Date().toISOString(),
        content: `<local-command-stdout>Moved to ${to}</local-command-stdout>` }));
    }
    return dest;
  };

  test("今の画面（viewport）を読み、「Moved to」が出て確認の画面が無ければ待たずに返す（herdr の出力の記録の古い画面に引きずられない）", async () => {
    const w = world("wd-fast");
    let moved = false;
    let viewportReads = 0;
    const ctx = {
      sessionManager: {
        list: async () => [{ name: "work", alive: true, claudeSessionId: ID, providerSessionId: ID, agent: "claude" }],
        sendTextSubmit: async () => { moveWithLine(w.projects, w.src, w.b, true); moved = true; },
        sendKeys: async () => { throw new Error("キーは送らない"); },
        // herdr の capturePane（recent-unwrapped）は、閉じた後も古い確認の画面を返し続ける（使われてはいけない）。
        capturePane: async () => MULTI,
        // 今の画面（herdr の `--source visible`）。1 回の取り込みに 150ms かかる（負荷のある herdr を模す）。
        captureVisibleAnsi: async () => {
          if (moved) viewportReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 150));
          return IDLE;
        },
        agentProcessIds: async () => null,
      },
    } as unknown as HandlerContext;
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: w.projects, claudeSessionsDir: makeTempDir("wd-fast-reg"), preTrust: () => {}, pollMs: 200,
      timeoutMs: 15_000, log: () => {}, observedClaudeVersion: () => "2.1.325",
    });
    const started = Date.now();
    expect(await adapter({ session: "work", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx })).toEqual({ ok: true, cwd: w.b });
    // 打つ前 1 回 + 「Moved to」を見た周 1 回 + 後始末 1 回 ≒ 0.45 秒。1.5 秒の落ち着き待ち・読み直しは入らない。
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(viewportReads).toBeLessThanOrEqual(2);
  });

  test("MCP が複数の画面は、1 回の Esc で閉じたら 2 回目を送らない", async () => {
    const w = world("wd-one-esc");
    let screen = IDLE;
    let dest = "";
    const keys: string[] = [];
    const ctx = {
      sessionManager: {
        list: async () => [{ name: "work", alive: true, claudeSessionId: ID, providerSessionId: ID, agent: "claude" }],
        sendTextSubmit: async () => { dest = moveWithLine(w.projects, w.src, w.b, false); screen = MULTI; },
        sendKeys: async (_name: string, sent: string[]) => {
          keys.push(...sent);
          if (sent[0] === "Escape" && screen === MULTI) {
            screen = IDLE;
            fs.appendFileSync(dest, line({ type: "system", subtype: "local_command", timestamp: new Date().toISOString(),
              content: `<local-command-stdout>Moved to ${w.b}</local-command-stdout>` }));
          }
        },
        captureVisibleAnsi: async () => screen,
        agentProcessIds: async () => null,
      },
    } as unknown as HandlerContext;
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: w.projects, claudeSessionsDir: makeTempDir("wd-one-esc-reg"), preTrust: () => {}, pollMs: 50,
      timeoutMs: 5_000, log: () => {}, observedClaudeVersion: () => "2.1.325",
    });
    const started = Date.now();
    expect(await adapter({ session: "work", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx })).toEqual({ ok: true, cwd: w.b });
    expect(keys).toEqual(["Escape"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("移った直後で今のフォルダを決められないときは、購読開始時の `pc:cwd` に古い値を配らない", () => {
  test("会話ログが先頭の数行（cwd を持つ行が無い）だけのとき、履歴の後の pc:cwd を見送る", () => {
    const a = realDir("wd-early-a");
    const b = realDir("wd-early-b");
    const conversation = "77777777-7777-7777-7777-777777777777";
    writeTranscript(path.join(os.homedir(), ".claude", "projects"), b,
      line({ type: "mode", sessionId: conversation, mode: "normal" }) + line({ type: "permission-mode", sessionId: conversation }),
      conversation);
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: a, createdAt: 0, claudeSessionId: conversation });
    let write: ((payload: never) => void) | undefined;
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("wd-early-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: (w) => ({ open() { write = w as never; }, stop() {} }),
    });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (l) => received.push(decodeHubServerLine(l)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    write!({ type: "chat_output", v: 1, streamId: "pc:history-done", role: "system", text: "1", eof: true } as never);
    const cwds = received.filter((m) => (m as { payload?: { streamId?: string } }).payload?.streamId === "pc:cwd");
    expect(cwds).toEqual([]);
    // 変更の確定で新しい値が配られる。
    hub.handleClientMessage(client, JSON.stringify({ type: "session_cwd_set", id: "s1", session: "work", cwd: b }));
    expect(received.filter((m) => (m as { payload?: { streamId?: string } }).payload?.streamId === "pc:cwd")
      .map((m) => (m as { payload: { text: string } }).payload.text)).toEqual([b]);
  });
});

describe("herdr の経路: 確認の画面が出ない `/cd` は「Moved to」の後すぐ返る", () => {
  const RULE = "─".repeat(80);
  const BAR = "  ⏵⏵ auto mode on (shift+tab to cycle)";
  const screenWith = (input: string) => ["⏺ 前の応答", RULE, `❯ ${input}`, RULE, BAR].join("\n");

  /**
   * herdr の模型。`/cd` の後も入力欄の見え方が「打ちかけ」のまま（画面の判定が pending のまま。実物では撃ち直しを
   * 最後まで繰り返していた）。`enterWorksOn` 回目の CR で Claude が `/cd` を実行し、会話ログへ移動と完了の行を書く。
   */
  function herdrWorld(prefix: string, enterWorksOn: number | null) {
    const projects = makeTempDir(prefix);
    const a = realDir("wd-a");
    const b = realDir("wd-b");
    const src = writeTranscript(projects, a, userLine(a, "hi"));
    const store = new SessionMetadataStore(makeTempDir(`${prefix}-store`));
    store.put({ name: "s-a", cwd: a, createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2", claudeSessionId: ID });
    let input = "";
    let enters = 0;
    const sends: string[] = [];
    const herdrOk = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
    const manager = new HerdrSessionManager({
      runner: async (args: string[]) => {
        if (args[0] === "pane" && args[1] === "list") {
          return herdrOk(JSON.stringify({ id: "l", result: { type: "pane_list", panes: [{ pane_id: "w4:p2", label: "s-a" }] } }));
        }
        if (args[0] === "pane" && args[1] === "get") return herdrOk(JSON.stringify({ id: "g", result: { pane: { agent_status: "idle" } } }));
        if (args[0] === "pane" && args[1] === "read") return herdrOk(screenWith(input));
        if (args[0] === "pane" && (args[1] === "send-text" || args[1] === "send-keys")) {
          const payload = args[3] ?? "";
          sends.push(payload);
          if (payload === "\r") {
            enters += 1;
            if (enterWorksOn !== null && enters === enterWorksOn) {
              const dest = path.join(projects, claudeProjectSlug(b), `${ID}.jsonl`);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.renameSync(src, dest);
              fs.appendFileSync(dest, line({ type: "relocated", sessionId: ID, relocatedCwd: b }) +
                line({ type: "system", subtype: "local_command", timestamp: new Date().toISOString(),
                  content: `<local-command-stdout>Moved to ${b}</local-command-stdout>` }));
              // 入力欄は描き直されないまま（模型: 画面の判定は pending のまま）。
            }
          } else if (/^\u0015+$/u.test(payload)) {
            input = "";
          } else if (args[1] === "send-text") {
            input += payload;
          }
        }
        return herdrOk("");
      },
      store, submitDelayMs: 600, submitVerifyDelayMs: 700, inputRetryDelayMs: 0, clearKeyDelayMs: 0,
      readyTimeoutMs: 1000, readyPollMs: 0, clearSettleMs: 10,
    } as never);
    const ctx = {
      sessionManager: {
        list: async () => [{ name: "s-a", alive: true, claudeSessionId: ID, providerSessionId: ID, agent: "claude", backend: "herdr" }],
        sendTextSubmit: (name: string, text: string, options: never) => manager.sendTextSubmit(name, text, options),
        sendKeys: (name: string, keys: string[], literal?: boolean) => manager.sendKeys(name, keys, literal),
        captureVisibleAnsi: (name: string) => manager.captureVisibleAnsi(name),
        clearInputBox: (name: string) => manager.clearInputBox(name),
        agentProcessIds: async () => null,
      },
    } as unknown as HandlerContext;
    const meta = { name: "s-a", cwd: a, createdAt: 1, claudeSessionId: ID };
    const adapter = createClaudeTerminalWorkdirAdapter({
      projectsDir: projects, claudeSessionsDir: makeTempDir(`${prefix}-reg`), preTrust: () => {}, pollMs: 200,
      timeoutMs: 3_000, log: () => {}, observedClaudeVersion: () => "2.1.325",
    });
    return { b, ctx, meta, adapter, sends, enters: () => enters, input: () => input };
  }

  test("「Moved to」が書かれたら送信確定ループを抜け、1 秒未満で成功する。返した後にキーは送られない", async () => {
    const w = herdrWorld("wd-herdr-fast", 1);
    const started = Date.now();
    expect(await w.adapter({ session: "s-a", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx: w.ctx })).toEqual({ ok: true, cwd: w.b });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(w.enters()).toBe(1);
    const sentAtReturn = w.sends.length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(w.sends.length).toBe(sentAtReturn);
  });

  test("最初の Enter を取りこぼしたら従来どおり撃ち直し、移動を確かめてから成功する", async () => {
    const w = herdrWorld("wd-herdr-retry", 2);
    expect(await w.adapter({ session: "s-a", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx: w.ctx })).toEqual({ ok: true, cwd: w.b });
    expect(w.enters()).toBe(2);
  });

  test("Enter が最後まで効かなければ成功にせず、入力欄に残った `/cd` を消す", async () => {
    const w = herdrWorld("wd-herdr-stuck", null);
    expect(await w.adapter({ session: "s-a", meta: w.meta, cwd: w.b, requestedCwd: w.b, ctx: w.ctx }))
      .toMatchObject({ ok: false, error: "failed" });
    expect(w.input()).toBe("");
  }, 15_000);
});
