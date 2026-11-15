// codexWorkdirChange.test.ts — Codex の会話の作業フォルダを途中で変える（session-workdir-change）
// App Server への適用（thread/settings/update → thread/settings/updated で確定）・controller の追従（resume 応答・
// ほかのクライアントの変更・子 thread の除外）・hub の codex_cwd_submit と記録合わせ・engine の差し込み口・
// rollout からの今の作業フォルダ（一覧・tail の照合）。

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import {
  CodexAppServerManager,
  CodexCwdChangeError,
  type CodexAppServerConnection,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerThreadOptions,
} from "../src/codex/codexAppServer.js";
import {
  CodexNativeTurnController,
  type CodexNativeTurnControllerOptions,
  type CodexThreadClient,
} from "../src/codex/codexNativeTurnController.js";
import { CodexRolloutTailer } from "../src/codex/codexRolloutTailer.js";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import {
  rolloutCwdHistory,
  rolloutCwdRecord,
  scanRolloutCwdBackward,
  scanRolloutCwdInBuffer,
} from "../src/codex/rolloutCwd.js";
import type { HandlerContext } from "../src/engine/context.js";
import {
  decodeHubClientLine,
  decodeHubServerLine,
  encodeHubMessage,
  type HubClientMessage,
  type HubServerMessage,
} from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { changeCodexWorkdir } from "../src/workdir/codex.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const THREAD = "01a1de9e-f96e-7a81-9855-201c67d82ade";

function realDir(prefix: string): string {
  return fs.realpathSync(makeTempDir(prefix));
}

// ---- App Server の thread（CodexAppServerThread） ----

/** 複数の通知ハンドラを持てる（実物の WebSocket 接続と同じ）接続の fake。 */
class CwdConnection implements CodexAppServerConnection {
  readonly requests: { method: string; params: unknown }[] = [];
  private readonly handlers = new Set<(notification: CodexAppServerNotification) => void>();
  /** thread の今の作業フォルダ（server 側の値）。 */
  serverCwd: string;
  /** settings/update を受けたときの振る舞い。 */
  onUpdate: "notify" | "silent" | "silent-apply" | { error: string } = "notify";
  /** 子 thread の通知を先に混ぜる。 */
  childNoticeFirst = false;

  constructor(cwd: string) {
    this.serverCwd = cwd;
  }

  async initialize(): Promise<void> {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const p = params as Record<string, unknown>;
    if (method === "thread/resume") return { thread: { id: THREAD, cwd: this.serverCwd }, cwd: this.serverCwd };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "thread/items/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return { thread: { id: THREAD, cwd: this.serverCwd, turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "thread/settings/update" && typeof p["cwd"] === "string") {
      const cwd = p["cwd"];
      if (typeof this.onUpdate === "object") throw new Error(this.onUpdate.error);
      if (this.onUpdate === "silent") return {};
      this.serverCwd = cwd;
      if (this.onUpdate === "silent-apply") return {};
      // 応答の後に通知（0.167.2 実測: 適用は応答より後）。
      setTimeout(() => {
        if (this.childNoticeFirst) this.emit("thread/settings/updated", { threadId: "child-thread", threadSettings: { cwd } });
        this.emit("thread/settings/updated", { threadId: THREAD, threadSettings: { cwd, model: "gpt-6.1-sol" } });
      }, 5);
      return {};
    }
    return {};
  }

  emit(method: string, params: unknown): void {
    for (const handler of [...this.handlers]) handler({ method, params });
  }

  close(): void {}

  onNotification(handler: (notification: CodexAppServerNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onServerRequest(_handler: (request: CodexAppServerRequest) => void): () => void {
    return () => {};
  }

  respond(): void {}
  respondError(): void {}
}

async function openWith(connection: CwdConnection, cwd: string) {
  const manager = new CodexAppServerManager({
    codexHome: makeTempDir("codex-cwd-home"), connect: async () => connection, launch: () => {},
  });
  return manager.openThread({ threadId: THREAD, cwd });
}

describe("App Server の thread の作業フォルダ", () => {
  test("resume 応答の cwd を今の作業フォルダにし、resume には cwd を付けない", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const connection = new CwdConnection(b);
    const thread = await openWith(connection, a);
    expect(thread.cwd).toBe(b);
    const resume = connection.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).not.toHaveProperty("cwd");
  });

  test("settings/update を送り、この thread の settings/updated（子 thread の分は除く）が届いたら確定", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const connection = new CwdConnection(a);
    connection.childNoticeFirst = true;
    const thread = await openWith(connection, a);
    await expect(thread.setCwd(b)).resolves.toBe(b);
    expect(thread.cwd).toBe(b);
    expect(connection.requests).toContainEqual({ method: "thread/settings/update", params: { threadId: THREAD, cwd: b } });
    // 今と同じ値なら送らない（Codex は同じ値では通知しない）。
    const before = connection.requests.length;
    await expect(thread.setCwd(b)).resolves.toBe(b);
    expect(connection.requests.length).toBe(before);
    // 承認・サンドボックスの既定（config/read）は今の作業フォルダで読む。
    await thread.startTurn("hi", "c1", null, null, null);
    const configRead = connection.requests.filter((request) => request.method === "config/read").at(-1);
    expect(configRead?.params).toMatchObject({ cwd: b });
  });

  test("通知が来なくても thread/read で適用を確かめられれば成功、変わっていなければ unsupported", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const applied = new CwdConnection(a);
    applied.onUpdate = "silent-apply";
    await expect((await openWith(applied, a)).setCwd(b, 20)).resolves.toBe(b);

    const ignored = new CwdConnection(a);
    ignored.onUpdate = "silent";
    const thread = await openWith(ignored, a);
    const failure = await thread.setCwd(b, 20).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CodexCwdChangeError);
    expect((failure as CodexCwdChangeError).kind).toBe("unsupported");
    expect(thread.cwd).toBe(a);
  });

  test("hub の経路（controller）: 通知が届けばすぐ確定し、届かない接続（最初の発話より前に開いた）でも読み直しですぐ確定する", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b"), c = realDir("cwd-c");
    // 期限（8 秒）まで待たずに確定すること。0.167.2 の実測では、通知の届かない接続で毎回ちょうど 8 秒かかっていた。
    for (const onUpdate of ["notify", "silent-apply"] as const) {
      const connection = new CwdConnection(a);
      connection.onUpdate = onUpdate;
      const manager = new CodexAppServerManager({
        codexHome: makeTempDir("codex-cwd-hub"), connect: async () => connection, launch: () => {},
      });
      const cwds: string[] = [];
      const controller = new CodexNativeTurnController({ appServer: manager, onCwd: (_s, cwd) => cwds.push(cwd) });
      await controller.subscribeSession({ session: "work", threadId: THREAD, cwd: a });
      for (const target of [b, c]) {
        const startedAt = Date.now();
        await expect(controller.setCwd({ session: "work", threadId: THREAD, cwd: a, targetCwd: target })).resolves.toBe(target);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
      }
      expect(cwds).toEqual([b, c]);
      const updateAt = connection.requests.findIndex((request) => request.method === "thread/settings/update");
      const readsAfterUpdate = connection.requests.slice(updateAt).filter((request) => request.method === "thread/read").length;
      // 通知が届く接続では読み直しをほぼしない（最初の読み直しの前に通知が来る）。
      if (onUpdate === "notify") expect(readsAfterUpdate).toBeLessThanOrEqual(2);
      else expect(readsAfterUpdate).toBeGreaterThan(0);
      controller.close();
    }
  });

  test("要求の形を拒否された（その版に無い引数）なら unsupported、それ以外の失敗はそのまま", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const rejected = new CwdConnection(a);
    rejected.onUpdate = { error: "Invalid request: unknown field `cwd`" };
    await expect((await openWith(rejected, a)).setCwd(b)).rejects.toMatchObject({ kind: "unsupported" });
    const broken = new CwdConnection(a);
    broken.onUpdate = { error: "Codex App Server connection closed" };
    const error = await (await openWith(broken, a)).setCwd(b).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(CodexCwdChangeError);
  });
});

// ---- controller ----

class FakeThread implements CodexThreadClient {
  cwd: string | null;
  initialActiveTurnId: string | null = null;
  readonly setCwdCalls: string[] = [];
  constructor(cwd: string | null) {
    this.cwd = cwd;
  }
  async startTurn(): Promise<string> { return "turn-1"; }
  async steerTurn(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async setCwd(cwd: string): Promise<string> {
    this.setCwdCalls.push(cwd);
    this.cwd = cwd;
    return cwd;
  }
  close(): void {}
}

function controllerWith(thread: FakeThread, extra: Partial<CodexNativeTurnControllerOptions> = {}) {
  let openOptions: CodexAppServerThreadOptions | null = null;
  const cwds: { session: string; cwd: string }[] = [];
  const controller = new CodexNativeTurnController({
    appServer: { openThread: async (options) => { openOptions = options; return thread; } },
    onCwd: (session, cwd) => cwds.push({ session, cwd }),
    ...extra,
  });
  return { controller, cwds, notify: (method: string, params: unknown) => openOptions?.onNotification?.({ method, params }) };
}

describe("controller の作業フォルダの追従", () => {
  test("開いたときの thread の cwd が記録と違えば知らせる（同じなら黙る）", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const moved = controllerWith(new FakeThread(b));
    await moved.controller.subscribeSession({ session: "work", threadId: THREAD, cwd: a });
    expect(moved.cwds).toEqual([{ session: "work", cwd: b }]);
    const same = controllerWith(new FakeThread(a));
    await same.controller.subscribeSession({ session: "work", threadId: THREAD, cwd: a });
    expect(same.cwds).toEqual([]);
  });

  test("自分の thread の settings/updated の cwd を取り込み、子 thread の分は親に混ぜない", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b"), c = realDir("cwd-c");
    const { controller, cwds, notify } = controllerWith(new FakeThread(a));
    await controller.subscribeSession({ session: "work", threadId: THREAD, cwd: a });
    notify("thread/settings/updated", { threadId: "child-thread", threadSettings: { cwd: c, model: "m" } });
    notify("thread/settings/updated", { threadId: THREAD, threadSettings: { cwd: b, model: "m" } });
    notify("thread/settings/updated", { threadId: THREAD, threadSettings: { cwd: b, model: "m" } });
    expect(cwds).toEqual([{ session: "work", cwd: b }]);
  });

  test("setCwd: 開いた thread で変えて知らせる。ターンの実行中は busy で何もしない", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const thread = new FakeThread(a);
    const { controller, cwds } = controllerWith(thread);
    await expect(controller.setCwd({ session: "work", threadId: THREAD, cwd: a, targetCwd: b })).resolves.toBe(b);
    expect(thread.setCwdCalls).toEqual([b]);
    expect(cwds).toEqual([{ session: "work", cwd: b }]);

    const running = new FakeThread(a);
    running.initialActiveTurnId = "turn-9";
    const busy = controllerWith(running);
    await expect(busy.controller.setCwd({ session: "work", threadId: THREAD, cwd: a, targetCwd: b }))
      .rejects.toMatchObject({ kind: "busy" });
    expect(running.setCwdCalls).toEqual([]);
  });

  test("setCwd: thread が変更に対応していなければ unsupported", async () => {
    const a = realDir("cwd-a"), b = realDir("cwd-b");
    const thread = Object.assign(new FakeThread(a), { setCwd: undefined });
    const { controller } = controllerWith(thread);
    await expect(controller.setCwd({ session: "work", threadId: THREAD, cwd: a, targetCwd: b }))
      .rejects.toMatchObject({ kind: "unsupported" });
  });
});

// ---- hub ----

describe("hub の codex_cwd_submit と記録合わせ", () => {
  test("codex_cwd_submit / codex_cwd_result を往復し、相対パスや未知の status を拒否する", () => {
    const request: HubClientMessage = { type: "codex_cwd_submit", id: "w", session: "work", threadId: THREAD,
      cwd: "/tmp/a", targetCwd: "/tmp/b" };
    expect(decodeHubClientLine(encodeHubMessage(request))).toEqual(request);
    expect(decodeHubClientLine(JSON.stringify({ ...request, targetCwd: "b" }))).toBeNull();
    for (const result of [
      { type: "codex_cwd_result", id: "w", status: "ok", cwd: "/tmp/b" },
      { type: "codex_cwd_result", id: "w", status: "unsupported", error: "old" },
    ] as HubServerMessage[]) expect(decodeHubServerLine(encodeHubMessage(result))).toEqual(result);
    expect(decodeHubServerLine(JSON.stringify({ type: "codex_cwd_result", id: "w", status: "moved" }))).toBeNull();
  });

  function hubWith(cwd: string, setCwd?: (options: { targetCwd: string }) => Promise<string>) {
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd, createdAt: 0, agent: "codex", providerSessionId: THREAD });
    let options: CodexNativeTurnControllerOptions | undefined;
    const closeSession = vi.fn();
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("cwd-hub-hb"), metadataStore, timeoutSeconds: 1800,
      tailFactory: () => ({ open() {}, stop() {} }),
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: (created) => {
        options = created;
        return { startTurn: vi.fn(async () => "turn-1"), closeSession, close: vi.fn(),
          ...(setCwd !== undefined ? { setCwd } : {}) };
      },
    });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    return { hub, client, received, metadataStore, options: () => options!, closeSession };
  }
  const submit = (targetCwd: string, cwd: string) => JSON.stringify({
    type: "codex_cwd_submit", id: "w1", session: "work", threadId: THREAD, cwd, targetCwd,
  });

  test("controller.setCwd の結果を返し、この操作のためだけに開いた接続は畳む", async () => {
    const a = realDir("cwd-hub-a"), b = realDir("cwd-hub-b");
    const setCwd = vi.fn(async ({ targetCwd }: { targetCwd: string }) => targetCwd);
    const h = hubWith(a, setCwd);
    h.hub.handleClientMessage(h.client, submit(b, a));
    await vi.waitFor(() => expect(h.received).toContainEqual({ type: "codex_cwd_result", id: "w1", status: "ok", cwd: b }));
    expect(setCwd).toHaveBeenCalledWith({ session: "work", threadId: THREAD, cwd: a, targetCwd: b });
    expect(h.closeSession).toHaveBeenCalledWith("work");
  });

  test("失敗の種類（busy / unsupported）をそのまま返し、対応しない controller は unsupported", async () => {
    const a = realDir("cwd-hub-a"), b = realDir("cwd-hub-b");
    const busy = hubWith(a, async () => { throw new CodexCwdChangeError("busy", "running"); });
    busy.hub.handleClientMessage(busy.client, submit(b, a));
    await vi.waitFor(() => expect(busy.received).toContainEqual(expect.objectContaining({ type: "codex_cwd_result", status: "busy" })));
    const old = hubWith(a);
    old.hub.handleClientMessage(old.client, submit(b, a));
    expect(old.received).toContainEqual({ type: "codex_cwd_result", id: "w1", status: "unsupported" });
  });

  test("controller が知らせた作業フォルダで記録を合わせて `pc:cwd` を配る（消えたフォルダは採らない）", async () => {
    const a = realDir("cwd-hub-a"), b = realDir("cwd-hub-b");
    const h = hubWith(a, async ({ targetCwd }) => targetCwd);
    h.hub.handleClientMessage(h.client, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    h.hub.handleClientMessage(h.client, submit(b, a));
    await vi.waitFor(() => expect(h.received).toContainEqual(expect.objectContaining({ type: "codex_cwd_result" })));
    h.options().onCwd?.("work", path.join(a, "gone"));
    expect(h.metadataStore.get("work")?.cwd).toBe(a);
    h.options().onCwd?.("work", b);
    expect(h.metadataStore.get("work")?.cwd).toBe(b);
    const cwdEvents = h.received.filter((m) => (m as { payload?: { streamId?: string } }).payload?.streamId === "pc:cwd")
      .map((m) => (m as { payload: { text: string } }).payload.text);
    expect(cwdEvents).toEqual([b]);
  });
});

// ---- engine の差し込み口 ----

describe("engine の差し込み口（workdir/codex.ts）", () => {
  function ctxWith(reply: (request: Record<string, unknown>) => unknown) {
    const calls: Record<string, unknown>[] = [];
    const ctx = {
      codexHubRpcTimeoutMs: 15_000,
      hubRpc: async (request: Record<string, unknown>) => { calls.push(request); return reply(request); },
    } as unknown as HandlerContext;
    return { ctx, calls };
  }
  const meta = (cwd: string) => ({ name: "work", cwd, createdAt: 0, agent: "codex" as const, providerSessionId: THREAD });

  test("hub へ codex_cwd_submit を頼み、結果の種類を枠の結果へ写す", async () => {
    const a = realDir("cwd-ad-a"), b = realDir("cwd-ad-b");
    for (const [status, expected] of [
      ["ok", { ok: true, cwd: b }],
      ["busy", { ok: false, error: "busy" }],
      ["unsupported", { ok: false, error: "unsupported" }],
      ["failed", { ok: false, error: "failed" }],
    ] as const) {
      const { ctx, calls } = ctxWith((request) => ({ type: "codex_cwd_result", id: request["id"], status,
        ...(status === "ok" ? { cwd: b } : {}) }));
      expect(await changeCodexWorkdir({ session: "work", meta: meta(a), cwd: b, requestedCwd: b, ctx }))
        .toMatchObject(expected);
      expect(calls[0]).toMatchObject({ type: "codex_cwd_submit", session: "work", threadId: THREAD, cwd: a, targetCwd: b });
    }
    const { ctx } = ctxWith(() => { throw new Error("hub down"); });
    expect(await changeCodexWorkdir({ session: "work", meta: meta(a), cwd: b, requestedCwd: b, ctx }))
      .toMatchObject({ ok: false, error: "failed" });
  });

  test("precheck: thread id の無い記録は failed、あれば続ける", () => {
    expect(changeCodexWorkdir.precheck?.({ name: "x", cwd: "/", createdAt: 0, agent: "codex" })).toMatchObject({ ok: false, error: "failed" });
    expect(changeCodexWorkdir.precheck?.(meta("/"))).toBeNull();
  });
});

// ---- rollout ----

const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const sessionMeta = (cwd: string, id = THREAD) => line({ timestamp: "t", type: "session_meta", payload: { id, cwd } });
const taskStarted = () => line({ type: "event_msg", payload: { type: "task_started", turn_id: "x" } });
const turnContext = (cwd: string) => line({ type: "turn_context", payload: { turn_id: "x", cwd, model: "m" } });
const settingsApplied = (cwd: string) => line({ type: "event_msg",
  payload: { type: "thread_settings_applied", thread_id: THREAD, thread_settings: { cwd, model: "m" } } });
const userTurn = (text: string) => line({ type: "event_msg", payload: { type: "user_message", message: text } });
const bulk = (bytes: number) => line({ type: "response_item", payload: { type: "message", role: "assistant",
  content: [{ type: "output_text", text: "x".repeat(bytes) }] } });

function writeFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("rollout の今の作業フォルダ（rolloutCwd）", () => {
  test("記録の見分け: thread_settings_applied / turn_context / task_started だけ（本文に語が出ても読まない）", () => {
    expect(rolloutCwdRecord(settingsApplied("/b"))).toEqual({ kind: "settings", cwd: "/b" });
    expect(rolloutCwdRecord(turnContext("/c"))).toEqual({ kind: "turn", cwd: "/c" });
    expect(rolloutCwdRecord(taskStarted())).toEqual({ kind: "turn_start" });
    expect(rolloutCwdRecord(userTurn("turn_context と thread_settings_applied の話"))).toBeNull();
    expect(rolloutCwdRecord("{broken turn_context")).toBeNull();
  });

  test("最後の thread_settings_applied。ターン中の変更の後に同じターンの turn_context が続いても変更を採る", () => {
    const dir = makeTempDir("cwd-scan");
    // 実測の並び（T1）: task_started → turn_context → thread_settings_applied。
    expect(scanRolloutCwdBackward(writeFile(dir, "t1.jsonl",
      sessionMeta("/a") + taskStarted() + turnContext("/b") + settingsApplied("/b") + userTurn("x"))).cwd).toBe("/b");
    // ターン中の変更（D）の後に、同じターンの turn_context（自動圧縮）が元のフォルダ（C）で続く。
    expect(scanRolloutCwdBackward(writeFile(dir, "mid.jsonl", sessionMeta("/a") + settingsApplied("/c") + taskStarted() +
      turnContext("/c") + settingsApplied("/d") + turnContext("/c") + userTurn("x"))).cwd).toBe("/d");
    // 最後のターンの始まりより前の thread_settings_applied より、そのターンの turn_context が新しい。
    expect(scanRolloutCwdBackward(writeFile(dir, "turn.jsonl", sessionMeta("/a") + settingsApplied("/c") + taskStarted() +
      turnContext("/e"))).cwd).toBe("/e");
    // 記録が無ければ null（session_meta の値）。
    expect(scanRolloutCwdBackward(writeFile(dir, "none.jsonl", sessionMeta("/a") + userTurn("x"))).cwd).toBeNull();
  });

  test("上限より前は読まない・書き込み途中の末尾の行は読まない・解凍済みの中身も同じ規則", () => {
    const dir = makeTempDir("cwd-scan-cap");
    const file = writeFile(dir, "cap.jsonl", sessionMeta("/a") + settingsApplied("/b") + bulk(4096));
    expect(scanRolloutCwdBackward(file, { capBytes: 1024 }).cwd).toBeNull();
    expect(scanRolloutCwdBackward(file).cwd).toBe("/b");
    const partial = writeFile(dir, "partial.jsonl", sessionMeta("/a") + settingsApplied("/b") + settingsApplied("/c").slice(0, 40));
    expect(scanRolloutCwdBackward(partial).cwd).toBe("/b");
    expect(scanRolloutCwdInBuffer(Buffer.from(sessionMeta("/a") + taskStarted() + turnContext("/f")))).toEqual({ cwd: "/f", decisive: true });
  });

  test("履歴: これまでの作業フォルダの集合。伸びた分だけ読み足す", () => {
    const file = writeFile(makeTempDir("cwd-history"), "h.jsonl", sessionMeta("/a") + taskStarted() + turnContext("/a"));
    expect([...rolloutCwdHistory(file)]).toEqual(["/a"]);
    fs.appendFileSync(file, settingsApplied("/b") + taskStarted() + turnContext("/b"));
    expect([...rolloutCwdHistory(file)].sort()).toEqual(["/a", "/b"]);
  });
});

describe("tail の rollout 照合（resolveRollout）", () => {
  test("会話 id で指名すれば、移った先の作業フォルダでも見つける。記録に無い cwd の同じ id のコピーは採らない", () => {
    const root = makeTempDir("cwd-resolve");
    const a = realDir("cwd-res-a"), b = realDir("cwd-res-b"), other = realDir("cwd-res-o");
    const file = writeFile(path.join(root, "2026/11/15"), `rollout-2026-11-15T18-52-02-${THREAD}.jsonl`,
      sessionMeta(a) + taskStarted() + turnContext(a) + settingsApplied(b));
    expect(CodexRolloutTailer.resolveRollout(b, root, null, THREAD)).toBe(file);
    expect(CodexRolloutTailer.resolveRollout(a, root, null, THREAD)).toBe(file);
    expect(CodexRolloutTailer.resolveRollout(other, root, null, THREAD)).toBeNull();
    // id で指名しない（古い記録の）照合は、従来どおり始めたフォルダだけ。
    expect(CodexRolloutTailer.resolveRollout(b, root)).toBeNull();
  });
});

describe("会話一覧の作業フォルダ（CodexSessionStore）", () => {
  function home() {
    const codexHome = makeTempDir("cwd-store");
    const dir = path.join(codexHome, "sessions", "2026", "11", "15");
    return { codexHome, dir };
  }

  test("一覧の cwd は今の作業フォルダ。始めたフォルダは startedCwd、伸びた会話は追記分で更新する", async () => {
    const { codexHome, dir } = home();
    const a = realDir("cwd-store-a"), b = realDir("cwd-store-b"), c = realDir("cwd-store-c");
    const file = writeFile(dir, `rollout-2026-11-15T18-52-02-${THREAD}.jsonl`,
      sessionMeta(a) + userTurn("hi") + taskStarted() + turnContext(a) + settingsApplied(b));
    const store = new CodexSessionStore(codexHome);
    expect(store.list().map((info) => info.cwd)).toEqual([b]);
    expect(store.startedCwd(THREAD)).toBe(a);
    expect(store.list(b)).toHaveLength(1);
    expect(store.list(a)).toHaveLength(0);
    expect(await store.latestActivity(b)).not.toBeNull();
    expect(await store.latestActivity(a)).toBeNull();
    fs.appendFileSync(file, bulk(100) + settingsApplied(c));
    fs.utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(store.list().map((info) => info.cwd)).toEqual([c]);
    // 始めたフォルダへ戻したら、変えていない会話と同じ扱い。
    fs.appendFileSync(file, settingsApplied(a));
    fs.utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(store.list().map((info) => info.cwd)).toEqual([a]);
    expect(store.startedCwd(THREAD)).toBeNull();
  });

  test.runIf(typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function")(
    "圧縮された rollout は最終メッセージと同じ解凍でだけ今の作業フォルダを読む（範囲外の判定のためには解凍しない）", async () => {
      const { codexHome, dir } = home();
      const a = realDir("cwd-store-za"), b = realDir("cwd-store-zb");
      const plain = sessionMeta(a) + userTurn("hi") + taskStarted() + turnContext(a) + settingsApplied(b);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `rollout-2026-11-15T18-52-02-${THREAD}.jsonl.zst`),
        (zlib as unknown as { zstdCompressSync: (input: Buffer) => Buffer }).zstdCompressSync(Buffer.from(plain)));
      const store = new CodexSessionStore(codexHome);
      // まだ解凍していない古い会話は、始めたフォルダで絞る（範囲外の会話を解凍しない）。
      expect(await store.latestActivity(b)).toBeNull();
      expect(store.list(b)).toEqual([]);
      // 始めたフォルダでは範囲内なので最終メッセージのために解凍し、移った先（範囲外）と分かって外す。
      expect(store.list(a)).toEqual([]);
      // 解凍した後は、今の作業フォルダで出る。
      expect(store.list().map((info) => info.cwd)).toEqual([b]);
      expect(store.list(b).map((info) => info.cwd)).toEqual([b]);
      expect(await store.latestActivity(b)).not.toBeNull();
    });
});
