import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writePendingApproval } from "../src/approval/approvalMailbox.js";
import { runChat, type ChatDeps } from "../src/commands/chat/chatCommand.js";
import { codexRolloutBusy, conversationStateSnapshot, type RequestRecord } from "../src/commands/chat/chatState.js";
import { EngineTimeoutError } from "../src/commands/chat/engineClient.js";
import type { ControlMessage } from "../src/protocol.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { makeTempDir } from "./helpers.js";

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION = "s-watch";
const T0 = 1_795_087_300_000;
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function harness(agent: "claude" | "codex" = "claude", withLog = true) {
  const home = makeTempDir("chat-watch");
  homes.push(home);
  const store = new SessionMetadataStore(path.join(home, "meta"));
  const registry = path.join(home, "registry");
  fs.mkdirSync(registry);
  const watchesDir = path.join(home, "watches");
  const transcript = path.join(home, "session.jsonl");
  const chatDeliveries = path.join(home, "chat-deliveries.ndjson");
  const pendingQuestionsPath = path.join(home, "pending-questions.json");
  const approvalsBase = path.join(home, "approvals");
  const records = new Map<string, RequestRecord>();
  let now = T0;
  let stdin: string | null = null;
  let output = "";
  const connect = vi.fn(async () => { throw new Error("watch が engine を開きました"); });
  const deps: ChatDeps = {
    connect, isTty: false,
    readStdin: () => stdin,
    config: () => { throw new Error("watch が Bot 設定を読みました"); },
    store: () => store,
    write: (text) => { output += text; },
    now: () => now,
    sleep: async () => {},
    attach: () => { throw new Error("watch が画面を開きました"); },
    readRequest: (requestId) => records.get(requestId) ?? null,
    writeRequest: (record) => { records.set(record.requestId, record); },
    lockRequest: () => () => {},
    watchState: (id) => conversationStateSnapshot(id, registry),
    transcript: (id) => agent === "claude" && id === ID && fs.existsSync(transcript) ? { file: transcript, cwd: home } : null,
    codexRollout: (id) => agent === "codex" && id === ID && fs.existsSync(transcript) ? transcript : null,
    requestsDir: path.join(home, "requests"),
    watchesDir, chatDeliveries, pendingQuestionsPath, approvalsBase,
  };
  const setState = (status: string, times: { statusUpdatedAt?: number; updatedAt?: number } = {}) => {
    fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: ID, cwd: home, name: SESSION, status, ...times,
    }));
  };
  function append(...lines: object[]) {
    fs.appendFileSync(transcript, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    fs.utimesSync(transcript, now / 1000, now / 1000);
  }
  if (withLog) append();
  if (agent === "claude") setState("idle");
  store.put({ name: SESSION, cwd: home, createdAt: T0, providerSessionId: ID, agent });
  const call = async (...args: string[]) => {
    output = "";
    const code = await runChat([...args, "--json"], deps);
    return { code, json: JSON.parse(output) as Record<string, any> };
  };
  const watch = (...args: string[]) => call("watch", ...args);
  const list = async (...args: string[]) => {
    const result = await watch("list", ...args);
    expect(result.code).toBe(0);
    return result.json.watches;
  };
  const poll = async () => {
    const result = await watch("poll");
    expect(result.code).toBe(0);
    return result.json;
  };
  return {
    deps, home, store, transcript, chatDeliveries, pendingQuestionsPath, approvalsBase, watchesDir, records, connect, call,
    append, setState, list, poll, watch,
    add: (mode = "continue", ...flags: string[]) => watch("add", ID, "--mode", mode, ...flags),
    ack: (token: string, ...flags: string[]) => watch("ack", ID, "--token", token, ...flags),
    advance: (ms: number) => { now += ms; },
    stdin: (text: string | null) => { stdin = text; },
  };
}

const assistant = (text = "返答") => ({ type: "assistant", message: { content: text } });
const interruption = { type: "user", message: { content: "[Request interrupted by user]" } };
const codexEvent = (type: string, message?: string) => ({
  type: "event_msg", timestamp: new Date(T0).toISOString(), payload: { type, message },
});

function question(h: ReturnType<typeof harness>, id = "q1") {
  fs.writeFileSync(h.pendingQuestionsPath, JSON.stringify({
    [SESSION]: { id, questions: [{ header: "色", question: "どの色？", multiSelect: false,
      options: [{ label: "青", description: "青色" }] }], answerRoute: "relay" },
  }));
}

function delivery(clientMessageId: string, atMs: number, conversationId?: string, session = SESSION): string {
  return JSON.stringify({ v: 1, atMs, session, conversationId, agent: "claude", clientMessageId, textHash: "hash" }) + "\n";
}

describe("chat watch の登録と台帳", () => {
  test("既定の期限、標準入力のメモと権限。Tailii の外の会話にも登録できる", async () => {
    const h = harness();
    fs.unlinkSync(path.join(h.home, "meta", `${SESSION}.json`));
    h.stdin("狸".repeat(1999) + "🐾末尾");
    expect(await h.add("continue", "--note")).toMatchObject({ code: 0, json: {
      v: 1, ok: true, conversationId: ID, agent: "claude", mode: "continue", pending: 0,
      note: "狸".repeat(1999) + "🐾", createdAtMs: T0, expiresAtMs: T0 + DAY,
    } });
    expect(fs.statSync(h.watchesDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(h.watchesDir, `${ID}.json`)).mode & 0o777).toBe(0o600);
    expect(h.connect).not.toHaveBeenCalled();
  });

  test("使い方の誤り・範囲外・会話や依頼の不在を返す", async () => {
    const h = harness();
    for (const value of ["0", "10081", "1.5"]) {
      expect(await h.add("continue", "--ttl", value)).toMatchObject({ code: 2, json: { error: { code: "out_of_range" } } });
    }
    for (const id of ["../" + ID, ID + "\x00", "conv-not-uuid"]) {
      expect((await h.watch("add", id, "--mode", "continue")).code).toBe(2);
    }
    for (const args of [["add", ID], ["add", ID, "--mode", "other"], ["update", ID], ["remove", ID],
      ["ack", ID, "--token", "1e2"], ["add", ID, "--mode", "continue", "--read-cursor", "a:b"]]) {
      expect((await h.watch(...args)).code).toBe(2);
    }
    expect(await h.watch("add", OTHER, "--mode", "continue")).toMatchObject({ code: 3, json: { error: { code: "not_found" } } });
    expect(await h.add("continue", "--request-id", "missing")).toMatchObject({ code: 3, json: { error: { code: "request_not_found" } } });
    expect(await h.watch("remove", ID, "--reason", "done")).toMatchObject({ code: 3, json: { error: { code: "watch_not_found" } } });
    for (const wait of [[], ["25"]]) {
      expect(await h.watch("poll", "--wait", ...wait)).toMatchObject({ code: 2, json: { error: { code: "unsupported_option" } } });
    }
    expect(await h.list()).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
  });

  test("上書きでは未受領・控え・指定の無いメモとカーソルを継ぐ。更新は受領を兼ねる", async () => {
    const h = harness();
    h.records.set("r1", { requestId: "r1", kind: "send", conversationId: ID, session: SESSION, cwd: h.home, text: "指示", sentAtMs: T0 });
    h.stdin("元のメモ");
    expect((await h.add("continue", "--request-id", "r1", "--read-cursor", "1:100", "--note")).code).toBe(0);
    question(h);
    const first = (await h.poll()).items[0];
    h.stdin(null);
    h.advance(1);
    expect((await h.add("notify", "--ttl", "2")).json).toMatchObject({
      pending: 1, mode: "notify", note: "元のメモ", createdAtMs: T0, expiresAtMs: T0 + 1 + 2 * MINUTE,
      lastRequestId: "r1", readCursor: "1:100",
    });
    expect((await h.poll()).wake).toBe(false);
    h.stdin("更新したメモ");
    expect((await h.watch("update", ID, "--mode", "continue")).json).toMatchObject({ pending: 0, note: "元のメモ" });
    expect((await h.watch("update", ID, "--note")).json).toMatchObject({ pending: 0, note: "更新したメモ" });
    h.stdin("");
    expect(await h.watch("update", ID, "--note")).toMatchObject({ code: 2, json: { error: { code: "empty_note" } } });
    expect((await h.poll()).wake).toBe(false);
    question(h, "q2");
    expect(Number((await h.poll()).items[0].token)).toBe(Number(first.token) + 1);
  });

  test("閉じた記録を一覧に出し、30 日を過ぎたら poll で片付ける", async () => {
    const h = harness();
    await h.add();
    expect((await h.watch("remove", ID, "--reason", "handed_over")).code).toBe(0);
    expect(await h.list()).toEqual([]);
    expect(await h.list("--all")).toMatchObject([{ closed: { atMs: T0, reason: "handed_over" } }]);
    const dir = path.join(h.watchesDir, "closed");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual([`${ID}-${T0}.json`]);
    h.advance(30 * DAY);
    expect((await h.poll()).nextPollSec).toBe(300);
    expect(await h.list("--all")).toHaveLength(1);
    h.advance(1);
    await h.poll();
    expect(await h.list("--all")).toEqual([]);
  });

  test("古い錠を取り直し、待てる錠なら解放後に処理する", async () => {
    const h = harness();
    fs.mkdirSync(h.watchesDir);
    const lock = path.join(h.watchesDir, ".lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, atMs: T0 - MINUTE - 1 }));
    expect((await h.add()).code).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, atMs: T0 }));
    const sleep = vi.fn(async () => fs.unlinkSync(lock));
    h.deps.sleep = sleep;
    expect((await h.poll()).open).toBe(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  test("持ち主の居る新しい錠を 3 秒まで待ち、取れなければ watch_busy を返す", async () => {
    const h = harness();
    fs.mkdirSync(h.watchesDir);
    const lock = path.join(h.watchesDir, ".lock");
    const held = JSON.stringify({ pid: process.pid, atMs: T0 });
    fs.writeFileSync(lock, held);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    h.deps.sleep = async (ms) => { elapsed += ms; };
    try {
      expect(await h.watch("poll")).toMatchObject({ code: 6, json: { error: { code: "watch_busy" } } });
      expect(elapsed).toBe(3_000);
      expect(fs.readFileSync(lock, "utf8")).toBe(held);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("chat watch poll", () => {
  test("変化無しは起こさない。見張り無し・待機中・処理中で確認間隔を変える", async () => {
    const h = harness();
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 300, open: 0, source: "state", items: [] });
    h.append(assistant("既にある返答"));
    await h.add();
    const ledger = path.join(h.watchesDir, `${ID}.json`);
    const inode = fs.statSync(ledger).ino;
    h.advance(10_000);
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 120, open: 1, items: [] });
    expect(fs.statSync(ledger).ino).toBe(inode);
    h.setState("busy");
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 30, open: 1, items: [] });
  });

  test("処理中から待機に戻っても書き込みから 10 秒待ち、返答が増えたら起こす", async () => {
    const h = harness();
    h.setState("busy");
    await h.add();
    h.append(assistant());
    expect((await h.poll()).wake).toBe(false);
    h.setState("idle");
    h.advance(9_999);
    expect((await h.poll()).wake).toBe(false);
    h.advance(1);
    expect(await h.poll()).toMatchObject({ wake: true, nextPollSec: 30, items: [
      { state: "idle", complete: true, redelivery: false, reasons: [{ kind: "turn_ended", outcome: "completed", atMs: T0 + 10_000 }] },
    ] });
  });

  test("返答の後の中断を拾い、返答の無いターンでも新しい中断だけを拾う", async () => {
    const h = harness();
    h.setState("busy");
    await h.add();
    h.append(assistant(), interruption);
    h.setState("idle");
    h.advance(10_000);
    const first = (await h.poll()).items[0];
    expect(first.reasons).toMatchObject([{ kind: "turn_ended", outcome: "interrupted" }]);
    await h.ack(first.token);
    h.setState("busy");
    await h.poll();
    h.append(interruption);
    h.advance(10_000);
    h.setState("idle");
    expect((await h.poll()).items[0].reasons).toMatchObject([{ kind: "turn_ended", outcome: "interrupted" }]);
  });

  test.each([["not_running", "stopped_mid_turn"], ["idle", "turn_ended"]])(
    "記録が伸びなくても busy から %s への遷移を拾う", async (state, reason) => {
      const h = harness();
      h.setState("busy");
      await h.add();
      if (state === "not_running") h.deps.watchState = () => ({ state: "not_running" });
      else h.setState(state);
      expect((await h.poll()).wake).toBe(false);
      h.advance(10_000);
      const item = (await h.poll()).items[0];
      expect(item).toMatchObject({ state, complete: true, reasons: [{ kind: reason }] });
      if (state === "idle") expect(item.reasons[0].outcome).toBe("unknown");
      expect((await h.list())[0]).toMatchObject({ pending: 1 });
    },
  );

  test("登録時からある設問と承認で起こし、status と同じ形で中身を返す", async () => {
    const h = harness();
    question(h);
    for (const id of ["a1", "a2"]) {
      writePendingApproval({ id, session: SESSION, tool: "Bash", summary: "実行内容", cwd: h.home, atMs: T0, pid: process.pid }, h.approvalsBase);
    }
    await h.add();
    const first = (await h.poll()).items[0];
    expect(first).toMatchObject({
      state: "waiting_approval", complete: false,
      reasons: [{ kind: "question", questionId: "q1" }, { kind: "approval", approvalIds: ["a1", "a2"] }],
      waiting: {
        question: { questionId: "q1", questions: [{ number: 1, question: "どの色？", options: [{ choice: 1, label: "青", description: "青色" }] }] },
        approvals: [{ approvalId: "a1", tool: "Bash", summary: "実行内容" }, { approvalId: "a2" }],
      },
    });
    await h.ack(first.token);
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 30 });
  });

  test("waiting_other は同じ開始時刻につき 15 秒後に一度だけ追加する", async () => {
    const h = harness();
    h.setState("waiting", { statusUpdatedAt: T0, updatedAt: T0 + 100 });
    await h.add();
    h.advance(14_999);
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 30 });
    h.advance(1);
    const first = (await h.poll()).items[0];
    expect(first.reasons).toEqual([{ kind: "waiting_other", atMs: T0 + 15_000 }]);
    await h.ack(first.token);
    expect((await h.poll()).wake).toBe(false);
    h.setState("waiting", { updatedAt: T0 + 15_000 });
    h.advance(15_000);
    expect((await h.poll()).items[0].reasons).toMatchObject([{ kind: "waiting_other" }]);
  });

  test("アプリから届いた発話だけをまとめ、途中の行を次回に回し、短くなった記録は読み返さない", async () => {
    const h = harness();
    fs.writeFileSync(h.chatDeliveries, delivery("app-old", T0 - 1));
    await h.add();
    fs.appendFileSync(h.chatDeliveries, delivery("cli-1", T0 + 1, ID) + delivery("app-other", T0 + 2, OTHER, "s-other"));
    expect((await h.poll()).wake).toBe(false);
    const line = delivery("app-2", T0 + 4);
    fs.appendFileSync(h.chatDeliveries, delivery("app-1", T0 + 3, ID, "s-old") + line.slice(0, -3));
    const first = (await h.poll()).items[0];
    expect(first.reasons).toMatchObject([{ kind: "human_activity", detail: "message", count: 1, lastAtMs: T0 + 3 }]);
    await h.ack(first.token);
    expect((await h.poll()).wake).toBe(false);
    fs.appendFileSync(h.chatDeliveries, line.slice(-3) + delivery("app-3", T0 + 5));
    const second = (await h.poll()).items[0];
    expect(second.reasons).toMatchObject([{ kind: "human_activity", count: 2, lastAtMs: T0 + 5 }]);
    await h.ack(second.token);
    fs.writeFileSync(h.chatDeliveries, delivery("app-old", T0 - 1));
    expect((await h.poll()).wake).toBe(false);
    fs.appendFileSync(h.chatDeliveries, delivery("app-new", T0 + 6));
    expect((await h.poll()).items[0].reasons).toMatchObject([{ kind: "human_activity", count: 1, lastAtMs: T0 + 6 }]);
  });

  test("notify は設問で起こさず、continue に戻したあとも同じ設問を知らせない", async () => {
    const h = harness();
    await h.add("notify");
    question(h);
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 30 });
    await h.watch("update", ID, "--mode", "continue");
    expect((await h.poll()).wake).toBe(false);
    question(h, "q2");
    expect((await h.poll()).items[0]).toMatchObject({ state: "waiting_answer", reasons: [{ questionId: "q2" }] });
  });

  test("期限切れで未受領を添えて一度だけ起こす。その poll では新しい設問や削除を足さない", async () => {
    const h = harness();
    await h.add("continue", "--ttl", "1");
    question(h);
    expect((await h.poll()).wake).toBe(true);
    question(h, "q2");
    fs.unlinkSync(h.transcript);
    h.advance(MINUTE);
    expect(await h.poll()).toMatchObject({ wake: true, open: 0, nextPollSec: 300, items: [{
      closed: { reason: "expired" }, redelivery: false, waiting: { question: { questionId: "q2" } },
      reasons: [{ kind: "question", questionId: "q1" }, { kind: "expired", unacked: true }],
    }] });
    expect((await h.poll()).wake).toBe(false);
    expect(await h.list("--all")).toMatchObject([{ closed: { atMs: T0 + MINUTE, reason: "expired" } }]);
  });

  test("一度見た記録が消えたら一度だけ起こす。未作成なら 120 秒を超えるまで待つ", async () => {
    const h = harness();
    await h.add();
    fs.unlinkSync(h.transcript);
    expect(await h.poll()).toMatchObject({ open: 0, items: [{ closed: { reason: "deleted" }, reasons: [{ kind: "deleted" }] }] });
    expect((await h.poll()).wake).toBe(false);
    expect((await h.add()).code).toBe(0);
    h.advance(120_000);
    expect(await h.poll()).toMatchObject({ wake: false, open: 1 });
    h.advance(1);
    expect(await h.poll()).toMatchObject({ open: 0, items: [{ closed: { reason: "deleted" } }] });
  });

  test("壊れた記録を飛ばし、照合の例外があっても他の見張りを続ける", async () => {
    const h = harness();
    await h.add();
    h.store.put({ name: "s-other", cwd: h.home, createdAt: T0, providerSessionId: OTHER, agent: "claude" });
    await h.watch("add", OTHER, "--mode", "notify");
    const corrupt = path.join(h.watchesDir, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.json");
    fs.writeFileSync(corrupt, "{");
    const transcriptOf = h.deps.transcript!;
    h.deps.transcript = (id) => {
      if (id === OTHER) throw new Error("照合に失敗");
      return transcriptOf(id);
    };
    question(h);
    expect(await h.poll()).toMatchObject({
      wake: true, open: 2, items: [{ conversationId: ID }], errors: [{ conversationId: OTHER, message: "照合に失敗" }],
    });
  });

  test("Codex の処理中判定はサイズか更新時刻が変わったときだけ読む", async () => {
    const h = harness("codex");
    h.append(codexEvent("task_started"));
    const busy = vi.fn(codexRolloutBusy);
    h.deps.watchCodexBusy = busy;
    await h.add();
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 30 });
    expect(busy).not.toHaveBeenCalled();
    h.advance(10_000);
    h.append(codexEvent("agent_message", "返答"), codexEvent("task_complete"));
    expect((await h.poll()).wake).toBe(false);
    expect(busy).toHaveBeenCalledTimes(1);
    h.advance(10_000);
    expect(await h.poll()).toMatchObject({ items: [
      { agent: "codex", state: "idle", reasons: [{ kind: "turn_ended", outcome: "completed" }] },
    ] });
    expect(busy).toHaveBeenCalledTimes(1);
    fs.utimesSync(h.transcript, (T0 + 20_000) / 1000, (T0 + 20_000) / 1000);
    expect((await h.poll()).wake).toBe(false);
    expect(busy).toHaveBeenCalledTimes(2);
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe("chat watch の受領確認", () => {
  test("10 分おきに 3 回だけ起こし直し、新しい理由で回数を戻す", async () => {
    const h = harness();
    await h.add();
    question(h);
    const first = (await h.poll()).items[0];
    expect(first.redelivery).toBe(false);
    h.advance(10 * MINUTE - 1);
    expect((await h.poll()).wake).toBe(false);
    h.advance(1);
    for (let i = 0; i < 3; i++) {
      expect((await h.poll()).items[0]).toMatchObject({ token: first.token, redelivery: true, reasons: first.reasons });
      h.advance(10 * MINUTE);
    }
    expect(await h.poll()).toMatchObject({ wake: false, nextPollSec: 30 });
    question(h, "q2");
    const second = (await h.poll()).items[0];
    expect(second).toMatchObject({ redelivery: false, reasons: [{ questionId: "q1" }, { questionId: "q2" }] });
    expect((await h.ack(first.token, "--read-cursor", "7:123")).json).toMatchObject({ pending: 1, readCursor: "7:123" });
    h.advance(10 * MINUTE);
    expect((await h.poll()).items[0]).toMatchObject({ token: second.token, redelivery: true, reasons: [{ questionId: "q2" }] });
    expect((await h.ack(second.token)).json.pending).toBe(0);
  });

  test("同じ種別の変化も毎回足す", async () => {
    const h = harness();
    await h.add();
    h.append(assistant("一つ目のターン"));
    h.advance(10_000);
    const first = (await h.poll()).items[0];
    h.append(assistant("二つ目のターン"));
    h.advance(10_000);
    expect((await h.poll()).items[0]).toMatchObject({
      token: String(Number(first.token) + 1), redelivery: false,
      reasons: [{ kind: "turn_ended", atMs: T0 + 10_000 }, { kind: "turn_ended", atMs: T0 + 20_000 }],
    });
  });

  test("未受領の変化は新しい方から 50 件を残す", async () => {
    const h = harness();
    await h.add();
    for (let i = 1; i <= 51; i++) {
      question(h, `q${i}`);
      if (i < 51) await h.poll();
    }
    const item = (await h.poll()).items[0];
    expect(item.token).toBe("51");
    expect(item.reasons.map((reason: { questionId: string }) => reason.questionId))
      .toEqual(Array.from({ length: 50 }, (_, i) => `q${i + 2}`));
  });
});

function mockSendEngine(
  h: ReturnType<typeof harness>,
  send: () => "accepted" | "duplicate" | "failed",
  receipt: () => "unknown" | "delivered" = () => "unknown",
) {
  h.deps.config = () => ({ allowedRoots: [h.home], permissionMode: "acceptEdits",
    allowAuto: false, allowApprove: false, allowTakeOver: false, allowSetModel: false });
  const request = vi.fn(async (message: Record<string, unknown>): Promise<ControlMessage> => {
    const id = String(message.id);
    switch (message.type) {
      case "claude_session_list_request":
        return { type: "claude_session_list_response", v: 2, id, claudeSessions: [
          { sessionId: ID, cwd: h.home, title: "会話", liveSessionName: SESSION },
        ] };
      case "session_start": {
        const name = String(message.name);
        return { type: "session_list_response", v: 2, id, adoptedName: name, sessions: [
          { name, cwd: h.home, alive: true, providerSessionId: ID },
        ] };
      }
      case "chat_send":
        return { type: "chat_send_result", v: 2, id, status: send() };
      case "chat_receipt_query":
        return { type: "chat_receipt_query_result", v: 2, id, status: receipt() };
      default:
        throw new Error(`想定外の要求 ${String(message.type)}`);
    }
  });
  h.deps.connect = vi.fn(async () => ({ request, close: async () => {} }));
  return request;
}

describe("chat new / send --watch", () => {
  test.each(["send", "new"])("%s が受け付けられたときだけ登録し、送信の最中に書かれた返答も拾う", async (verb) => {
    const h = harness("claude", verb === "send");
    if (verb === "send") h.append(assistant("既存の返答"));
    const request = mockSendEngine(h, () => {
      expect(fs.existsSync(path.join(h.watchesDir, `${ID}.json`))).toBe(false);
      expect(h.records.get("r1")?.watchBaseline?.assistantElements).toBe(verb === "send" ? 1 : 0);
      h.append(assistant("送信中に届いた返答"));
      return "accepted";
    });
    h.stdin("指示" + "🐾".repeat(198) + "末尾");
    expect(await h.call(verb, ...(verb === "new" ? ["--cwd", h.home] : [ID]),
      "--request-id", "r1", "--watch", "continue", "--watch-ttl", "12")).toMatchObject({
      code: 0, json: { watch: { mode: "continue", expiresAtMs: T0 + 12 * MINUTE } },
    });
    expect(request.mock.calls.filter(([message]) => message.type === "chat_send")).toHaveLength(1);
    expect(await h.list()).toMatchObject([{ lastRequestId: "r1", note: "依頼の冒頭: 指示" + "🐾".repeat(198) }]);
    h.advance(10_000);
    expect((await h.poll()).items[0]).toMatchObject({
      lastRequestId: "r1", reasons: [{ kind: "turn_ended", outcome: "completed" }],
    });
  });

  test.each(["send", "new"])("%s の送信が失敗したら登録しない。--watch-ttl 単独は送る前に断る", async (verb) => {
    const h = harness();
    const request = mockSendEngine(h, () => "failed");
    const args = [verb, ...(verb === "new" ? ["--cwd", h.home] : [ID]), "--request-id", "r1"];
    h.stdin("指示");
    expect((await h.call(...args, "--watch-ttl", "1")).code).toBe(2);
    expect(request).not.toHaveBeenCalled();
    expect(await h.call(...args, "--watch", "continue")).toMatchObject({ code: 6, json: { error: { code: "not_delivered" } } });
    expect(await h.list()).toEqual([]);
  });

  test("受領が不明な間は登録せず、打ち直しで確認できたら最初の控えを使う", async () => {
    const h = harness();
    let delivered = false;
    const request = mockSendEngine(h, () => {
      h.append(assistant("応答の時間切れの間に書かれた返答"));
      throw new EngineTimeoutError("送信");
    }, () => delivered ? "delivered" : "unknown");
    h.stdin("指示");
    const send = () => h.call("send", ID, "--request-id", "r1", "--watch", "continue");
    expect((await send()).code).toBe(7);
    expect(await h.list()).toEqual([]);
    delivered = true;
    h.advance(10_000);
    expect((await send()).json.watch).toMatchObject({ mode: "continue" });
    expect(request.mock.calls.filter(([message]) => message.type === "chat_send")).toHaveLength(1);
    expect((await h.poll()).items[0].reasons).toMatchObject([{ kind: "turn_ended", outcome: "completed" }]);
  });

  test("通常の送信は既存のメモを残し、未受領を受領済みにする。duplicate は開いていればその設定を変えない", async () => {
    const h = harness();
    h.stdin("残すメモ\n");
    await h.add("continue", "--note");
    question(h);
    await h.poll();
    let duplicate = false;
    const request = mockSendEngine(h, () => duplicate ? "duplicate" : "accepted");
    h.stdin("指示");
    const send = (id: string, mode: string, ttl: string) =>
      h.call("send", ID, "--request-id", id, "--watch", mode, "--watch-ttl", ttl);
    expect((await send("r1", "notify", "2")).json.watch).toEqual({ mode: "notify", expiresAtMs: T0 + 2 * MINUTE });
    expect(await h.list()).toMatchObject([{ lastRequestId: "r1", pending: 0, note: "残すメモ" }]);
    h.advance(100);
    expect((await send("r1", "continue", "3")).json).toMatchObject({
      duplicate: true, watch: { mode: "notify", expiresAtMs: T0 + 2 * MINUTE },
    });
    expect(request.mock.calls.filter(([message]) => message.type === "chat_send")).toHaveLength(1);
    duplicate = true;
    expect((await send("r2", "continue", "3")).json.watch.mode).toBe("notify");
    expect(await h.list()).toMatchObject([{ lastRequestId: "r1", pending: 0 }]);
    await h.watch("remove", ID, "--reason", "other");
    expect((await send("r1", "continue", "3")).json.watch).toEqual({ mode: "continue", expiresAtMs: T0 + 100 + 3 * MINUTE });
    expect(await h.list()).toMatchObject([{ lastRequestId: "r1", note: "依頼の冒頭: 指示" }]);
  });
});
