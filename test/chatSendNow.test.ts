// chatSendNow.test.ts
// 「今すぐ送信」（chat-send-now）: CLI のキューに溜まっている発話を `chat:sendNow` で届ける。
// フレーム判定は **実機 claude 2.1.283 の無加工キャプチャ**（`test/fixtures/pane/queued-*.ansi`）で
// 検証する。切り詰めないこと（`paneSubmitFrames.test.ts` と同じ理由）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { HerdrSessionManager, type HerdrCommandResult, type HerdrCommandRunner } from "../src/backend/herdr.js";
import {
  claudeComposerBarVisible,
  classifySubmitFrame,
  inputBoxRealText,
  screenSendNowHint,
  SEND_NOW_BLOCKED_BY_DIALOG,
  SEND_NOW_BLOCKED_BY_DRAFT,
  SEND_NOW_EXPIRED_IN_QUEUE,
  SEND_NOW_BLOCKED_BY_REBOUND,
  SEND_NOW_BLOCKED_BY_UNREADABLE,
  SEND_NOW_UNCONFIRMED,
  sendQueuedNow,
  TmuxSessionManager,
} from "../src/backend/tmux.js";
import { decodeHubClientLine, decodeHubServerLine, encodeHubMessage } from "../src/hub/hubProtocol.js";
import { SEND_NOW_QUEUE_WAIT_LIMIT_MS, SessionHub } from "../src/hub/sessionHub.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok } from "./helpers.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pane");

/** 生キャプチャを読む（末尾の空行だけは backend の capture と同じく落とす）。 */
function frame(name: string): string {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.ansi`), "utf8").split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

/** ツールの実行中にキュー済み 1 件（tmux。ヒントは `ctrl+x ctrl+s to send now`）。 */
const QUEUED_TOOL = frame("queued-tool");
/** 応答の生成中にキュー済み 2 件（スピナー行が無く、ヒントの直下が入力欄）。 */
const QUEUED_STREAMING_MULTI = frame("queued-streaming-multi");
/** 添付のパスで始まる長い発話（2 桁字下げで折り返す）。 */
const QUEUED_WRAPPED = frame("queued-wrapped");
/** herdr（拡張キーを解する端末。ヒントは `ctrl+enter to send now`）。 */
const QUEUED_HERDR = frame("queued-herdr");
/** chord を送った直後（ヒントが消え、バーに `1 shell` が出る）。 */
const QUEUED_SENT = frame("queued-sent");
/** キュー済み 1 件 + 入力欄に Mac 側で打った下書き（未送信）。 */
const QUEUED_WITH_DRAFT = frame("queued-with-draft");
/**
 * 貼り付け扱いの長文（924 字）を送った直後。ボトムバーの位置が `paste again to expand` に
 * 置き換わる（十数秒続く）。
 */
const QUEUED_PASTE_HINT = frame("queued-paste-hint");
/** 同じ状態で、入力欄に Mac 側の下書きがある。 */
const QUEUED_PASTE_HINT_DRAFT = frame("queued-paste-hint-draft");

const NOT_QUEUED = [
  "idle", "typed", "invisible-hold", "processing", "shell-mode", "accept-edits",
  "question-dialog", "approval-dialog", "question-dialog-multi", "question-declined",
];

describe("screenSendNowHint（実機キャプチャ）", () => {
  test("キュー済みの発話があるフレームでだけ ready", () => {
    expect(screenSendNowHint(QUEUED_TOOL)).toBe("ready");
    expect(screenSendNowHint(QUEUED_STREAMING_MULTI)).toBe("ready");
    expect(screenSendNowHint(QUEUED_WRAPPED)).toBe("ready");
    expect(screenSendNowHint(QUEUED_HERDR)).toBe("ready");
    expect(screenSendNowHint(QUEUED_PASTE_HINT)).toBe("ready");
  });

  test("キューが無いフレームは absent（chord を送った直後を含む）", () => {
    expect(screenSendNowHint(QUEUED_SENT)).toBe("absent");
    for (const name of NOT_QUEUED) expect(screenSendNowHint(frame(name)), name).toBe("absent");
  });

  test("キュー済みのフレームは入力欄が空と判定される（プレースホルダーを下書きと数えない）", () => {
    // `Press up to edit queued messages` を実テキストと数えると、下書きありで常に断ってしまう。
    for (const screen of [QUEUED_TOOL, QUEUED_STREAMING_MULTI, QUEUED_WRAPPED, QUEUED_HERDR]) {
      expect(classifySubmitFrame(screen)).toBe("submitted");
    }
  });

  test("キー割り当てが既定と違うヒントは rebound", () => {
    expect(screenSendNowHint(QUEUED_TOOL.replace("ctrl+x ctrl+s to send now", "ctrl+j to send now")))
      .toBe("rebound");
  });

  test("応答本文がヒントの文言を引用しただけでは拾わない", () => {
    const quoted = [
      "❯ ヒントの文言を教えて",
      "",
      "⏺ キュー済みの発話の下には次の行が出ます。",
      "",
      "  ctrl+x ctrl+s to send now",
      "",
      "✻ Cooked for 1s",
      "",
      "────────────────────────────────",
      "❯ ",
      "────────────────────────────────",
      "  ⏸ manual mode on · ? for shortcuts · ← for agents",
    ].join("\n");
    expect(screenSendNowHint(quoted)).toBe("absent");
  });

  test("過去の発話の折り返しが偶然この文言で終わっても、割り当て変更と取り違えない", () => {
    // chord の表記（修飾キー + キー）でない行はヒントではない。
    const wrapped = [
      "❯ 長い発話の 1 行目",
      "  and then tell me when to send now",
      "",
      "────────────────────────────────",
      "❯ ",
      "────────────────────────────────",
      "  ⏸ manual mode on · esc to interrupt · ← for agents",
    ].join("\n");
    expect(screenSendNowHint(wrapped)).toBe("absent");
    // 本物のヒントがその上にあれば、そちらを拾う。
    expect(screenSendNowHint(QUEUED_TOOL.replace(
      "ctrl+x ctrl+s to send now", "ctrl+x ctrl+s to send now\n  note: nothing to send now",
    ))).toBe("ready");
    for (const chord of ["alt+enter", "ctrl+x ctrl+k", "cmd+shift+s", "ctrl+x s"]) {
      expect(screenSendNowHint(QUEUED_TOOL.replace("ctrl+x ctrl+s to send now", `${chord} to send now`)), chord)
        .toBe("rebound");
    }
  });

  test("字下げの無い行・文言が途中にあるだけの行は拾わない", () => {
    expect(screenSendNowHint("❯ 発話\nctrl+x ctrl+s to send now")).toBe("absent");
    expect(screenSendNowHint("❯ 発話\n  press ctrl+x ctrl+s to send now, or wait")).toBe("absent");
  });
});

describe("貼り付けの案内が出ているフレーム（実機キャプチャ）", () => {
  test("長文を貼り付けとして取り込んだ直後の案内は、入力欄のフレームとして扱う", () => {
    expect(claudeComposerBarVisible(QUEUED_PASTE_HINT)).toBe(true);
    expect(classifySubmitFrame(QUEUED_PASTE_HINT)).toBe("submitted");
  });

  test("案内が出ていても、入力欄の下書きは見逃さない", () => {
    expect(classifySubmitFrame(QUEUED_PASTE_HINT_DRAFT)).toBe("pending");
  });

  test("入力欄が見えていても、最下行が案内そのものでなければ判別できないまま", () => {
    // バーが欠けただけのフレーム（描画の途中）。入力欄の罫線ペアはダイアログ本体にもあるので、
    // 「入力欄が見つかった」だけでは入力欄のフレームと決めない。
    const withoutBar = QUEUED_TOOL.split("\n").slice(0, -1).join("\n");
    expect(inputBoxFound(withoutBar)).toBe(true);
    expect(classifySubmitFrame(withoutBar)).toBe("unknown");
    for (const footer of ["  paste again to expand?", "  press ctrl+v to paste again to expand", "  ⏺ paste again to expand"]) {
      const replaced = QUEUED_PASTE_HINT.replace(/\n[^\n]*paste again to expand[^\n]*$/, `\n${footer}`);
      expect(replaced).not.toBe(QUEUED_PASTE_HINT);
      expect(inputBoxFound(replaced), footer).toBe(true);
      expect(classifySubmitFrame(replaced), footer).toBe("unknown");
    }
  });

  test("案内の下に常駐する TUI 行（agents パネル / artifact タブ）は読み飛ばす", () => {
    expect(classifySubmitFrame(`${QUEUED_PASTE_HINT}\n⏺ main\n◯ explore-agent  調査中`)).toBe("submitted");
    expect(classifySubmitFrame(`${QUEUED_PASTE_HINT}\n⧉ design-review`)).toBe("submitted");
    expect(classifySubmitFrame(`${QUEUED_PASTE_HINT_DRAFT}\n⏺ main`)).toBe("pending");
  });

  test("入力欄の罫線が無いフレームでは、案内だけではバーの代わりと認めない", () => {
    expect(claudeComposerBarVisible("⏺ 次は paste again to expand と出ます\n起動中…")).toBe(false);
    expect(classifySubmitFrame("起動中…\n  paste again to expand")).toBe("unknown");
  });

  test("ダイアログはフッターが先に判定される（案内が下に残っていても）", () => {
    for (const name of ["question-dialog", "approval-dialog", "question-dialog-multi"]) {
      expect(classifySubmitFrame(`${frame(name)}\n  paste again to expand`), name).toBe("dialog");
    }
  });
});

/** 入力欄（罫線ペア）が見つかるフレームか。 */
function inputBoxFound(screen: string): boolean {
  return inputBoxRealText(screen) !== null;
}

/** フレーム列を順に返す capture と、chord の記録。尽きたら最後のフレームを返し続ける。 */
function makeIo(frames: Array<string | null>) {
  let index = 0;
  const sendChord = vi.fn(async () => {});
  return {
    sendChord,
    io: {
      capture: async () => frames[Math.min(index++, frames.length - 1)] ?? null,
      sendChord,
      pollMs: 0,
      maxPolls: 3,
    },
  };
}

describe("sendQueuedNow", () => {
  test("ヒントが見えていれば chord を 1 回送り、消えたら sent", async () => {
    const { io, sendChord } = makeIo([QUEUED_TOOL, QUEUED_TOOL, QUEUED_SENT]);
    expect(await sendQueuedNow(io)).toEqual({ status: "sent" });
    expect(sendChord).toHaveBeenCalledTimes(1);
  });

  test("キューが無ければ 1 キーも送らず nothing_queued", async () => {
    const { io, sendChord } = makeIo([frame("processing")]);
    expect(await sendQueuedNow(io)).toEqual({ status: "nothing_queued" });
    expect(sendChord).not.toHaveBeenCalled();
  });

  test("入力欄に文字があれば送らない（Mac 側の下書きごと送信されるのを防ぐ）", async () => {
    // ヒントが出ていても、入力欄に実テキストがあるフレームでは撃たない
    // （実測 2.1.283: 入力欄に文字がある状態の chord は、その文字をその場で送信する）。
    expect(screenSendNowHint(QUEUED_WITH_DRAFT)).toBe("ready");
    expect(classifySubmitFrame(QUEUED_WITH_DRAFT)).toBe("pending");
    const { io, sendChord } = makeIo([QUEUED_WITH_DRAFT]);
    expect(await sendQueuedNow(io)).toEqual({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_DRAFT });
    expect(sendChord).not.toHaveBeenCalled();
  });

  test("ダイアログの表示中は送らない", async () => {
    for (const name of ["question-dialog", "approval-dialog", "question-dialog-multi"]) {
      const { io, sendChord } = makeIo([frame(name)]);
      expect(await sendQueuedNow(io), name)
        .toEqual({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_DIALOG });
      expect(sendChord).not.toHaveBeenCalled();
    }
  });

  test("長文を送った直後（バーの位置が案内に替わっている）でも、待たずに送る", async () => {
    const { io, sendChord } = makeIo([QUEUED_PASTE_HINT, QUEUED_SENT]);
    expect(await sendQueuedNow(io)).toEqual({ status: "sent" });
    expect(sendChord).toHaveBeenCalledTimes(1);
  });

  test("長文を送った直後でも、入力欄に下書きがあれば送らない", async () => {
    const { io, sendChord } = makeIo([QUEUED_PASTE_HINT_DRAFT]);
    expect(await sendQueuedNow(io)).toEqual({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_DRAFT });
    expect(sendChord).not.toHaveBeenCalled();
  });

  test("描画の途中で判別できないフレームは、読めるまで撮り直してから送る", async () => {
    const { io, sendChord } = makeIo([null, "起動中…", QUEUED_TOOL, QUEUED_SENT]);
    expect(await sendQueuedNow({ ...io, settlePolls: 3 })).toEqual({ status: "sent" });
    expect(sendChord).toHaveBeenCalledTimes(1);
  });

  test("撮り直している間にダイアログが出たら送らない", async () => {
    const { io, sendChord } = makeIo(["起動中…", frame("approval-dialog")]);
    expect(await sendQueuedNow({ ...io, settlePolls: 3 }))
      .toEqual({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_DIALOG });
    expect(sendChord).not.toHaveBeenCalled();
  });

  test("画面を読めない / 判別できないフレームでは送らない", async () => {
    for (const screen of [null, "起動中…\n$ claude"]) {
      const { io, sendChord } = makeIo([screen]);
      expect(await sendQueuedNow(io))
        .toEqual({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_UNREADABLE });
      expect(sendChord).not.toHaveBeenCalled();
    }
  });

  test("キー割り当てが変わっていれば送らない", async () => {
    const { io, sendChord } = makeIo([
      QUEUED_TOOL.replace("ctrl+x ctrl+s to send now", "ctrl+j to send now"),
    ]);
    expect(await sendQueuedNow(io)).toEqual({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_REBOUND });
    expect(sendChord).not.toHaveBeenCalled();
  });

  test("chord を送ってもヒントが消えなければ failed（chord は撃ち直さない）", async () => {
    const { io, sendChord } = makeIo([QUEUED_TOOL]);
    expect(await sendQueuedNow(io)).toEqual({ status: "failed", reason: SEND_NOW_UNCONFIRMED });
    expect(sendChord).toHaveBeenCalledTimes(1);
  });

  test("chord の後に画面を読めない間は待ち、読めたフレームだけで判断する", async () => {
    const { io, sendChord } = makeIo([QUEUED_TOOL, null, QUEUED_SENT]);
    expect(await sendQueuedNow(io)).toEqual({ status: "sent" });
    expect(sendChord).toHaveBeenCalledTimes(1);
  });
});

describe("backend の sendQueuedNow", () => {
  test("tmux: C-x C-s を 1 回の send-keys で続けて送る", async () => {
    let sent = false;
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "send-keys") { sent = true; return ok(""); }
      if (args[0] === "capture-pane") return ok(sent ? QUEUED_SENT : QUEUED_TOOL);
      return ok("");
    });
    const manager = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore(), sendNowPollMs: 0 });
    expect(await manager.sendQueuedNow("s")).toEqual({ status: "sent" });
    const sends = runner.recorded.filter((args) => args[0] === "send-keys");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.slice(-2)).toEqual(["C-x", "C-s"]);
    expect(sends[0]).not.toContain("-l");
  });

  test("herdr: 生の制御文字を 1 回の send-text で続けて送る", async () => {
    const store = new SessionMetadataStore(makeTempDir("send-now-herdr"));
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const recorded: string[][] = [];
    let sent = false;
    const herdrOk = (stdout: string): HerdrCommandResult => ({ exitCode: 0, stdout, stderr: "" });
    const runner: HerdrCommandRunner = async (args) => {
      recorded.push(args);
      if (args[0] === "pane" && args[1] === "list") {
        return herdrOk(JSON.stringify({
          id: "cli:pane:list",
          result: { type: "pane_list", panes: [{ pane_id: "w4:p2", label: "s-a" }] },
        }));
      }
      if (args[0] === "pane" && args[1] === "send-text") { sent = true; return herdrOk(""); }
      if (args[0] === "pane" && args[1] === "read") return herdrOk(sent ? QUEUED_SENT : QUEUED_HERDR);
      return herdrOk("");
    };
    const manager = new HerdrSessionManager({ runner, store, sendNowPollMs: 0 });
    expect(await manager.sendQueuedNow("s-a")).toEqual({ status: "sent" });
    expect(recorded.filter((args) => args[1]?.startsWith("send-")))
      .toEqual([["pane", "send-text", "w4:p2", "\u0018\u0013"]]);
  });
});

describe("chat_send_now のワイヤー", () => {
  const GOLDEN = path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "protocol", "chat-send-now-v1.ndjson",
  );

  test("golden 全行が byte-exact でラウンドトリップする", () => {
    const lines = fs.readFileSync(GOLDEN, "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect(decodeControlMessage(lines[0]!).type).toBe("chat_send_now");
  });

  test("未知の status は拒否する", () => {
    expect(() => decodeControlMessage(
      '{"id":"i1","status":"accepted","type":"chat_send_now_result","v":2}',
    )).toThrow();
  });

  test("hub IPC を往復し、不正値は捨てる", () => {
    const request = { type: "chat_send_now" as const, id: "n1", session: "work" };
    expect(decodeHubClientLine(encodeHubMessage(request))).toEqual(request);
    expect(decodeHubClientLine('{"type":"chat_send_now","id":"","session":"work"}')).toBeNull();
    const result = { type: "chat_send_now_result" as const, id: "n1", status: "blocked" as const, error: "理由" };
    expect(decodeHubServerLine(encodeHubMessage(result))).toEqual(result);
    expect(decodeHubServerLine('{"type":"chat_send_now_result","id":"n1","status":"ok"}')).toBeNull();
  });
});

describe("SessionHub の chat_send_now", () => {
  const QUESTIONS = [{ header: "h", question: "q", options: [], multiSelect: false }];

  function makeHub(options: {
    sendNowInjector?: (session: string) => Promise<Awaited<ReturnType<typeof sendQueuedNow>>>;
    chatInjector?: (text: string, session: string, context: { onChoiceCancelled: () => void }) => Promise<void>;
    questionInjector?: () => Promise<void>;
    log?: (message: string) => void;
    nowMs?: () => number;
  }) {
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("hub-chat-send-now"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, ...options,
    });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    const send = (message: Record<string, unknown>): void =>
      hub.handleClientMessage(client, JSON.stringify(message));
    return { hub, received, send };
  }

  test("backend の結果をそのまま返し、監査ログへ残す", async () => {
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const log = vi.fn();
    const { received, send } = makeHub({ sendNowInjector, log });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "sent",
    }));
    expect(sendNowInjector).toHaveBeenCalledWith("work");
    expect(log).toHaveBeenCalledWith("audit chat-send-now session=work status=sent");
  });

  test("断った理由は error に載せる", async () => {
    const { received, send } = makeHub({
      sendNowInjector: async () => ({ status: "blocked", reason: SEND_NOW_BLOCKED_BY_DRAFT }),
    });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "blocked", error: SEND_NOW_BLOCKED_BY_DRAFT,
    }));
  });

  test("backend が throw したら failed で返す（応答を失わない）", async () => {
    const { received, send } = makeHub({
      sendNowInjector: async () => { throw new Error("pane not found"); },
    });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "failed", error: "pane not found",
    }));
  });

  test("未回答の設問がある間は 1 キーも送らずに断る", async () => {
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { hub, received, send } = makeHub({ sendNowInjector });
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1", questions: QUESTIONS });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "blocked", error: SEND_NOW_BLOCKED_BY_DIALOG,
    }));
    expect(sendNowInjector).not.toHaveBeenCalled();
  });

  test("chat の注入中に届いたら、注入が終わってから送る", async () => {
    const order: string[] = [];
    let releaseInjection: () => void = () => {};
    const chatInjector = vi.fn(() => new Promise<void>((resolve) => {
      order.push("inject-start");
      releaseInjection = () => { order.push("inject-end"); resolve(); };
    }));
    const sendNowInjector = vi.fn(async () => { order.push("send-now"); return { status: "sent" as const }; });
    const { received, send } = makeHub({ chatInjector, sendNowInjector });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "追加の指示" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalled());
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await Promise.resolve();
    // 本文を打っている最中に chord が届くと、打ちかけの本文がその場で送信される。
    expect(sendNowInjector).not.toHaveBeenCalled();
    releaseInjection();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "sent",
    }));
    expect(order).toEqual(["inject-start", "inject-end", "send-now"]);
  });

  test("chord を送っている間に届いた chat は、終わってから注入する", async () => {
    const order: string[] = [];
    let releaseSendNow: () => void = () => {};
    const sendNowInjector = vi.fn(() => new Promise<{ status: "sent" }>((resolve) => {
      order.push("send-now-start");
      releaseSendNow = () => { order.push("send-now-end"); resolve({ status: "sent" }); };
    }));
    const chatInjector = vi.fn(async () => { order.push("inject"); });
    const { received, send } = makeHub({ chatInjector, sendNowInjector });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(sendNowInjector).toHaveBeenCalled());
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "追加の指示" });
    await Promise.resolve();
    expect(chatInjector).not.toHaveBeenCalled();
    releaseSendNow();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_result", id: "c1", status: "accepted",
    }));
    expect(order).toEqual(["send-now-start", "send-now-end", "inject"]);
  });

  test("回答キーを注入している間は 1 キーも送らずに断る", async () => {
    // 回答の受理で `pendingQuestion` は clear 済みでも、pane にはまだ設問が出ている。
    let releaseAnswer: () => void = () => {};
    const questionInjector = vi.fn(() => new Promise<void>((resolve) => { releaseAnswer = resolve; }));
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { hub, received, send } = makeHub({ sendNowInjector, questionInjector });
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1", questions: QUESTIONS });
    send({ type: "question_answer_submit", id: "a1", session: "work", questionId: "q1",
      answers: [{ questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false }] });
    await vi.waitFor(() => expect(questionInjector).toHaveBeenCalled());
    expect(hub.actors.get("work")?.pendingQuestion).toBeNull();
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "blocked", error: SEND_NOW_BLOCKED_BY_DIALOG,
    }));
    expect(sendNowInjector).not.toHaveBeenCalled();
    // 回答の注入が終われば送れる。
    releaseAnswer();
    await vi.waitFor(() => expect(hub.actors.get("work")?.questionAnswerInjections).toBe(0));
    send({ type: "chat_send_now", id: "n2", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n2", status: "sent",
    }));
  });

  test("設問を Esc で閉じている最中は、注入が終わってから判断する", async () => {
    // 「設問に答えずに送る」の注入中（chat-cancel-choice）。注入の間は待ち、閉じ終えた後に送る。
    let releaseInjection: () => void = () => {};
    const chatInjector = vi.fn((_text: string, _session: string, context: { onChoiceCancelled: () => void }) =>
      new Promise<void>((resolve) => {
        releaseInjection = () => { context.onChoiceCancelled(); resolve(); };
      }));
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { hub, received, send } = makeHub({ chatInjector, sendNowInjector });
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1", questions: QUESTIONS });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "その前に相談です",
      cancelQuestionId: "q1" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalled());
    expect(hub.actors.get("work")?.cancellingQuestionId).toBe("q1");
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await Promise.resolve();
    expect(sendNowInjector).not.toHaveBeenCalled();
    expect(received).not.toContainEqual(expect.objectContaining({ type: "chat_send_now_result" }));
    releaseInjection();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "sent",
    }));
    expect(hub.actors.get("work")?.pendingQuestion).toBeNull();
  });

  test("設問で断った後も、保留していた chat は設問の解決で届く", async () => {
    // 注入の終わりで「今すぐ送信」を優先するので、断って戻った後も queue が止まらないこと。
    let releaseFirst: () => void = () => {};
    const injected: string[] = [];
    const chatInjector = vi.fn((text: string) => {
      injected.push(text);
      if (text !== "1 通目") return Promise.resolve();
      return new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { hub, received, send } = makeHub({ chatInjector, sendNowInjector });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "1 通目" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalledTimes(1));
    // 1 通目の注入中に設問が出て、2 通目（設問まで保留）と「今すぐ送信」が届く。
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id: "q1", questions: QUESTIONS });
    send({ type: "chat_send", id: "c2", session: "work", clientMessageId: "m2", text: "2 通目" });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    releaseFirst();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "blocked", error: SEND_NOW_BLOCKED_BY_DIALOG,
    }));
    expect(sendNowInjector).not.toHaveBeenCalled();
    expect(injected).toEqual(["1 通目"]);
    hub.handleRelayMessage({ type: "question_event", session: "work", event: "dismiss", id: "q1" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_result", id: "c2", status: "accepted",
    }));
    expect(injected).toEqual(["1 通目", "2 通目"]);
  });

  test("注入の終わりを待っている要求は、会話の終了で failed を返して手放す", async () => {
    const chatInjector = vi.fn(() => new Promise<void>(() => {}));
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { hub, received, send } = makeHub({ chatInjector, sendNowInjector });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "追加の指示" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalled());
    send({ type: "chat_send_now", id: "n1", session: "work" });
    send({ type: "session_retire", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
      type: "chat_send_now_result", id: "n1", status: "failed",
    })));
    expect(sendNowInjector).not.toHaveBeenCalled();
  });

  test("chord を送っている間に会話が終了したら、結果は返すが古い queue は動かさない", async () => {
    let releaseSendNow: () => void = () => {};
    const sendNowInjector = vi.fn(() => new Promise<{ status: "sent" }>((resolve) => {
      releaseSendNow = () => resolve({ status: "sent" });
    }));
    const chatInjector = vi.fn(async () => {});
    const { hub, received, send } = makeHub({ chatInjector, sendNowInjector });
    send({ type: "chat_send_now", id: "n1", session: "work" });
    await vi.waitFor(() => expect(sendNowInjector).toHaveBeenCalled());
    const retired = hub.actors.get("work")!;
    send({ type: "session_retire", session: "work" });
    // 同名で作り直された会話の queue。古い actor の後始末がこれを動かしてはいけない。
    retired.chatQueue.push({
      message: { type: "chat_send", id: "stale", session: "work", clientMessageId: "stale", text: "古い発話" },
      waiters: [],
    });
    retired.chatOrder.push("stale");
    releaseSendNow();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n1", status: "sent",
    }));
    await Promise.resolve();
    expect(chatInjector).not.toHaveBeenCalled();
  });

  test("順番を待ちすぎた要求には chord を送らず、failed で返す", async () => {
    // engine は 30 秒で諦める。その後で chord を送ると、失敗と出した後にターンが打ち切られる。
    let now = 1_000_000;
    let release: () => void = () => {};
    const chatInjector = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { received, send } = makeHub({ chatInjector, sendNowInjector, nowMs: () => now });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "追加の指示" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalled());
    send({ type: "chat_send_now", id: "old", session: "work" });
    now += SEND_NOW_QUEUE_WAIT_LIMIT_MS + 1;
    release();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "old", status: "failed", error: SEND_NOW_EXPIRED_IN_QUEUE,
    }));
    expect(sendNowInjector).not.toHaveBeenCalled();
    // 注入は成立している。後から来た要求は普通に送れる。
    expect(received).toContainEqual({ type: "chat_send_result", id: "c1", status: "accepted" });
    send({ type: "chat_send_now", id: "fresh", session: "work" });
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "fresh", status: "sent",
    }));
    expect(sendNowInjector).toHaveBeenCalledTimes(1);
  });

  test("上限ちょうどまで待った要求と、待ちすぎた要求が混ざっていたら、前者だけ送る", async () => {
    let now = 1_000_000;
    let release: () => void = () => {};
    const chatInjector = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { received, send } = makeHub({ chatInjector, sendNowInjector, nowMs: () => now });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "追加の指示" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalled());
    send({ type: "chat_send_now", id: "old", session: "work" });
    now += 1;
    send({ type: "chat_send_now", id: "edge", session: "work" });
    now += SEND_NOW_QUEUE_WAIT_LIMIT_MS;
    release();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "edge", status: "sent",
    }));
    expect(received).toContainEqual({
      type: "chat_send_now_result", id: "old", status: "failed", error: SEND_NOW_EXPIRED_IN_QUEUE,
    });
    expect(sendNowInjector).toHaveBeenCalledTimes(1);
  });

  test("同時に届いた要求は 1 回の chord にまとめ、全員へ同じ結果を返す", async () => {
    let release: () => void = () => {};
    const chatInjector = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sendNowInjector = vi.fn(async () => ({ status: "sent" as const }));
    const { received, send } = makeHub({ chatInjector, sendNowInjector });
    send({ type: "chat_send", id: "c1", session: "work", clientMessageId: "m1", text: "追加の指示" });
    await vi.waitFor(() => expect(chatInjector).toHaveBeenCalled());
    send({ type: "chat_send_now", id: "n1", session: "work" });
    send({ type: "chat_send_now", id: "n2", session: "work" });
    release();
    await vi.waitFor(() => expect(received).toContainEqual({
      type: "chat_send_now_result", id: "n2", status: "sent",
    }));
    expect(received).toContainEqual({ type: "chat_send_now_result", id: "n1", status: "sent" });
    expect(sendNowInjector).toHaveBeenCalledTimes(1);
  });
});
