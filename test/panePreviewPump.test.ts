// panePreviewPump.test.ts — tmux pane 一時進捗 pump テスト

import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LineWriter } from "../src/shared/lineWriter.js";
import { PanePreviewPump } from "../src/hub/panePreviewPump.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { KeyedLimiter } from "../src/shared/loadShed.js";

function memoryWriter(): { writer: LineWriter; messages: () => ControlMessage[] } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    writer: new LineWriter(out),
    messages: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeControlMessage(line)),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PanePreviewPump 負荷制御", () => {
  const pumps: PanePreviewPump[] = [];
  beforeEach(() => {
    // node:perf_hooks の時計も偽タイマーへ揃え、実際の所要時間を検証する。
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  });
  afterEach(async () => {
    for (const pump of pumps.splice(0)) pump.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("一覧の遅い取得後の 10 秒休止は、前面購読が付いた直後に打ち切る", async () => {
    vi.useFakeTimers();
    let foreground = false;
    const capture = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return "busy";
    });
    const pump = new PanePreviewPump({ writer: memoryWriter().writer, capture,
      pollIntervalMs: () => foreground ? 250 : 1000,
      priority: () => foreground ? "foreground" : "background" });
    pumps.push(pump); pump.start("promotion", "codex_terminal");
    await vi.advanceTimersByTimeAsync(6100);
    expect(capture).toHaveBeenCalledTimes(1);
    foreground = true; pump.requestRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(2);
    pump.stop(); await vi.advanceTimersByTimeAsync(6000);
  });

  test("取得中の前面昇格でも同じ会話の取得を重ねず、完了後は休まず取得する", async () => {
    vi.useFakeTimers();
    let foreground = false, active = 0, maximum = 0;
    const capture = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      active--; return "busy";
    });
    const pump = new PanePreviewPump({ writer: memoryWriter().writer, capture,
      priority: () => foreground ? "foreground" : "background" });
    pumps.push(pump); pump.start("promotion-inflight", "codex_terminal");
    await vi.advanceTimersByTimeAsync(100);
    foreground = true; pump.requestRefresh(); pump.requestRefresh();
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5900);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
    pump.stop(); await vi.advanceTimersByTimeAsync(6000);
  });

  test.each([250, 1000])("取得が 20ms なら基本間隔 %ims は変わらない・初回は待たせない", async (base) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const starts: number[] = [];
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer, pollIntervalMs: base,
      priority: () => base === 250 ? "foreground" : "background",
      capture: async () => {
        starts.push(Date.now() - startedAt);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "busy";
      },
    });
    pumps.push(pump);
    pump.start("normal", "codex_terminal");
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(20);
    expect(messages()).toMatchObject([{ type: "pane_preview", active: true, text: "busy" }]);
    await vi.advanceTimersByTimeAsync(base - 1);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, base + 20]);
  });

  test.each([
    { priority: "foreground" as const, duration: 200, rest: 600 },
    { priority: "foreground" as const, duration: 6000, rest: 5000 },
    { priority: "background" as const, duration: 6000, rest: 10000 },
  ])("$priority: 所要 $duration ms の後は $rest ms 休む", async ({ priority, duration, rest }) => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, duration));
      return "busy";
    });
    const pump = new PanePreviewPump({
      writer: memoryWriter().writer, capture,
      pollIntervalMs: priority === "foreground" ? 250 : 1000, priority: () => priority,
    });
    pumps.push(pump);
    pump.start("slow", "codex_terminal");
    await vi.advanceTimersByTimeAsync(duration + rest - 1);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(2);
    pump.stop();
    await vi.advanceTimersByTimeAsync(duration);
  });

  test("ANSI 取得も作業時間に含め、失敗した取得の後も休む", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "busy";
    });
    const captureSuggestion = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("ANSI failed");
    });
    const pump = new PanePreviewPump({ writer: memoryWriter().writer, capture, captureSuggestion });
    pumps.push(pump);
    pump.start("ansi");
    await vi.advanceTimersByTimeAsync(799);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(captureSuggestion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(2);
    pump.stop();
    await vi.advanceTimersByTimeAsync(100);
  });

  test("共有枠の順番待ちを取得時間へ加算しない", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 1 });
    const busy = limiter.run("busy", "background", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const capture = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "busy";
    });
    const pump = new PanePreviewPump({ writer: memoryWriter().writer, capture, limiter });
    pumps.push(pump);
    pump.start("waiting", "codex_terminal");
    await vi.advanceTimersByTimeAsync(1269);
    await busy;
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  test("通常 capture が失敗しても所要時間の 3 倍休み、次回は回復できる", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const capture = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (capture.mock.calls.length === 1) throw new Error("capture failed");
      return "recovered";
    });
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({ writer, capture });
    pumps.push(pump);
    pump.start("failure", "codex_terminal");
    await vi.advanceTimersByTimeAsync(3999);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(messages()).toMatchObject([{ type: "pane_preview", active: true, text: "recovered" }]);
  });

  test("遷移通知から停止した場合も、その後に active フレームを流さない", async () => {
    vi.useFakeTimers();
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer, capture: async () => "⏸ plan mode on (shift+tab to cycle)",
      onPermissionMode: () => pump.stop(),
    });
    pumps.push(pump);
    pump.start("callback-stop", "claude_status", { emitInitial: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages()).toEqual([]);
  });

  test("停止後に同じ会話を別 pump で再開しても重ならず、古い結果を送らない", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 2 });
    let active = 0;
    let maximum = 0;
    const capture = async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
      return "busy";
    };
    const old = memoryWriter();
    const current = memoryWriter();
    const first = new PanePreviewPump({ writer: old.writer, capture, limiter });
    const second = new PanePreviewPump({ writer: current.writer, capture, limiter });
    pumps.push(first, second);
    first.start("same", "codex_terminal");
    first.stop();
    second.start("same", "codex_terminal");
    await vi.advanceTimersByTimeAsync(200);
    expect(maximum).toBe(1);
    expect(old.messages()).toEqual([]);
    expect(current.messages()).toMatchObject([{ type: "pane_preview", active: true }]);
    second.stop();
    expect(current.messages().at(-1)).toMatchObject({ type: "pane_preview", active: false });
  });

  test("会話が増えても取得は同時 2 件、待機中の前面昇格を優先し、停止した待ちは捨てる", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 2 });
    const starts: string[] = [];
    let promoted = false;
    let active = 0;
    let maximum = 0;
    for (const session of ["a", "b", "back", "front", "cancelled"]) {
      const pump = new PanePreviewPump({
        writer: memoryWriter().writer, limiter,
        priority: () => session === "front" && promoted ? "foreground" : "background",
        capture: async () => {
          starts.push(session);
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          active--;
          return "busy";
        },
      });
      pumps.push(pump);
      pump.start(session, "codex_terminal");
      if (session === "cancelled") pump.stop();
    }
    promoted = true;
    pumps[3]!.requestRefresh();
    expect(starts).toEqual(["a", "front"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual(["a", "front", "b", "front"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual(["a", "front", "b", "front", "back"]);
    expect(maximum).toBe(2);
    for (const pump of pumps) pump.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(limiter.waiting).toBe(0);
    expect(limiter.running).toBe(0);
  });
});

describe("PanePreviewPump", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("初回 capture では emit されない", async () => {
    vi.useFakeTimers();
    let paneText = "first";
    const captured: string[] = [];
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async (session) => {
        captured.push(session);
        return paneText;
      },
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
    });

    pump.start("work");
    await flushMicrotasks();
    expect(captured).toEqual(["work"]);
    expect(messages()).toEqual([]);

    paneText = "second";
    await vi.advanceTimersByTimeAsync(10);
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "second" },
    ]);

    pump.stop();
  });

  test("emitInitial 指定時は初回 capture から emit する（処理中会話の一覧 watch 開始）", async () => {
    vi.useFakeTimers();
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "✻ Baking… (12s)",
      pollIntervalMs: 10,
      quietThresholdMs: 1000,
      protocolVersion: () => 2,
    });

    pump.start("work", "claude_status", { emitInitial: true });
    await flushMicrotasks();
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "✻ Baking… (12s)" },
    ]);

    pump.stop();
  });

  test("holdActiveIf が真の静止フレームでは消灯せず、1 秒おきに送り直す（上へスクロールされた処理中, scroll-pill）", async () => {
    vi.useFakeTimers();
    let paneText = "first";
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => paneText,
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
      holdActiveIf: (text) => text.startsWith("scrolled"),
    });

    pump.start("work");
    await flushMicrotasks();
    paneText = "scrolled busy";
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(900);
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "scrolled busy" },
    ]);
    // 確定応答で（旧版の）iOS が表示を消しても、画面が動かないまま点き直す。
    await vi.advanceTimersByTimeAsync(200);
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "scrolled busy" },
      { type: "pane_preview", v: 2, session: "work", seq: 2, active: true, text: "scrolled busy" },
    ]);

    // 処理が終わって画面が変われば、いつもどおり静止で消灯する。
    paneText = "idle";
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);
    const last = messages().at(-1);
    expect(last?.type === "pane_preview" && last.active).toBe(false);

    pump.stop();
  });

  test("iPhone が開いたときだけ 1 回、上へスクロールされた画面を最新位置へ戻す（jump-to-latest）", async () => {
    vi.useFakeTimers();
    let paneText = "scrolled";
    const jumps: string[] = [];
    const { writer } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => paneText,
      pollIntervalMs: 100,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
      jumpToLatest: async (session) => {
        jumps.push(session);
        paneText = "latest"; // 戻った
      },
      jumpToLatestIf: (text) => text.startsWith("scrolled"),
    });

    pump.start("work");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(jumps).toEqual([]); // 開かれていない（一覧 watch など）なら送らない

    pump.armJumpToLatest();
    await vi.advanceTimersByTimeAsync(100);
    expect(jumps).toEqual(["work"]);

    // 戻った後に Mac 側でまた上へスクロールしても、次に開くまでは送らない（読み返しを奪わない）。
    await vi.advanceTimersByTimeAsync(200);
    paneText = "scrolled again";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jumps).toHaveLength(1);

    // 開き直せばまた 1 回。
    pump.armJumpToLatest();
    await vi.advanceTimersByTimeAsync(100);
    expect(jumps).toHaveLength(2);

    pump.stop();
  });

  test("開いた時点で最新位置なら何もしない・戻らない環境では 3 回で諦める（jump-to-latest）", async () => {
    vi.useFakeTimers();
    let paneText = "latest";
    const jumps: number[] = [];
    const { writer } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => paneText,
      pollIntervalMs: 100,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
      jumpToLatest: async () => { jumps.push(Date.now()); }, // 戻らない
      jumpToLatestIf: (text) => text.startsWith("scrolled"),
    });

    pump.start("work");
    await flushMicrotasks();
    pump.armJumpToLatest();
    await vi.advanceTimersByTimeAsync(200);
    paneText = "scrolled"; // 開いた後で Mac 側がスクロールした
    await vi.advanceTimersByTimeAsync(20_000);
    expect(jumps).toEqual([]);

    pump.armJumpToLatest();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jumps).toHaveLength(3);
    expect((jumps[1] ?? 0) - (jumps[0] ?? 0)).toBeGreaterThanOrEqual(5000);

    pump.stop();
  });

  test("pollIntervalMs 関数は毎周期評価される（前面 250ms / 一覧 watch 1s の動的切替）", async () => {
    vi.useFakeTimers();
    let interval = 10;
    let paneText = "first";
    const captured: number[] = [];
    const { writer } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => {
        captured.push(Date.now());
        return paneText;
      },
      pollIntervalMs: () => interval,
      quietThresholdMs: 10_000,
      protocolVersion: () => 2,
    });

    pump.start("work");
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(captured).toHaveLength(2);
    interval = 40;
    paneText = "second";
    await vi.advanceTimersByTimeAsync(10); // 旧間隔の残り: この周期で新間隔を読み直す
    expect(captured).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(captured).toHaveLength(3); // 40ms へ切替済みなので 10ms では発火しない
    await vi.advanceTimersByTimeAsync(30);
    expect(captured).toHaveLength(4);

    pump.stop();
  });

  test("permission mode を初回と変化時だけ onPermissionMode で通知し、判定不能中は保持する", async () => {
    vi.useFakeTimers();
    const { writer } = memoryWriter();
    let paneText = "body\n⏵⏵ auto mode on (shift+tab to cycle)";
    const modes: string[] = [];
    const pump = new PanePreviewPump({
      writer,
      capture: async () => paneText,
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
      onPermissionMode: (mode) => modes.push(mode),
    });

    pump.start("work");
    await flushMicrotasks();
    expect(modes).toEqual(["auto"]);

    await vi.advanceTimersByTimeAsync(30);
    expect(modes).toEqual(["auto"]); // 無変化は再通知しない

    paneText = "body\n⏵⏵ accept edits on (shift+tab to cycle)";
    await vi.advanceTimersByTimeAsync(10);
    expect(modes).toEqual(["auto", "acceptEdits"]);

    // subagent 一覧がモード行の下に展開されても明示行を追跡する。
    paneText = [
      "body",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage",
      "⏺ main",
      "◯ Explore agent-1",
      "◯ Explore agent-2",
      "◯ Explore agent-3",
      "◯ Explore agent-4",
    ].join("\n");
    await vi.advanceTimersByTimeAsync(10);
    expect(modes).toEqual(["auto", "acceptEdits", "auto"]);

    // ダイアログ表示中（mode 行が消え null 判定）は直前の値を保持し通知しない。
    paneText = "body\n↑↓ to navigate · enter to confirm";
    await vi.advanceTimersByTimeAsync(10);
    expect(modes).toEqual(["auto", "acceptEdits", "auto"]);

    // 処理中・再描画中も mode 行が消えるが、default へ戻したとは通知しない。
    paneText = "Puttering…\n… · esc to interrupt · ← for agents";
    await vi.advanceTimersByTimeAsync(10);
    expect(modes).toEqual(["auto", "acceptEdits", "auto"]);

    paneText = "body\n⏸ manual mode on · ? for shortcuts";
    await vi.advanceTimersByTimeAsync(10);
    expect(modes).toEqual(["auto", "acceptEdits", "auto", "default"]);

    pump.stop();
  });

  test("codex_terminal では permission mode を通知しない", async () => {
    vi.useFakeTimers();
    const { writer } = memoryWriter();
    const modes: string[] = [];
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "body\n⏵⏵ auto mode on (shift+tab to cycle)",
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
      onPermissionMode: (mode) => modes.push(mode),
    });

    pump.start("work", "codex_terminal");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30);
    expect(modes).toEqual([]);

    pump.stop();
  });

  test("Codex terminal は初回 capture を即送信し、入力待ちを quiet で消灯しない", async () => {
    vi.useFakeTimers();
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "• Working\n\n› prompt",
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
    });

    pump.start("codex-work", "codex_terminal");
    await flushMicrotasks();
    expect(messages()).toEqual([{
      type: "pane_preview",
      v: 2,
      session: "codex-work",
      seq: 1,
      active: true,
      text: "• Working\n\n› prompt",
      mode: "codex_terminal",
    }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(messages()).toHaveLength(1);

    pump.stop();
    expect(messages()[1]).toEqual({
      type: "pane_preview",
      v: 2,
      session: "codex-work",
      seq: 2,
      active: false,
      text: "",
      mode: "codex_terminal",
    });
    expect(messages()).toHaveLength(2);
  });

  test("500ms 未満の連続変化は最新内容だけを次回 emit する", async () => {
    vi.useFakeTimers();
    let paneText = "baseline";
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => paneText,
      pollIntervalMs: 10,
      quietThresholdMs: 2500,
      protocolVersion: () => 2,
    });

    pump.start("work");
    await flushMicrotasks();

    paneText = "first";
    await vi.advanceTimersByTimeAsync(10);
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "first" },
    ]);

    paneText = "second";
    await vi.advanceTimersByTimeAsync(10);
    paneText = "third";
    await vi.advanceTimersByTimeAsync(10);
    expect(messages()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(470);
    expect(messages()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "first" },
      { type: "pane_preview", v: 2, session: "work", seq: 2, active: true, text: "third" },
    ]);

    pump.stop();
  });

  test("未 emit のまま quiet になっても active:false は出ない", async () => {
    vi.useFakeTimers();
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "idle",
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
    });

    pump.start("work");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(100);
    expect(messages()).toEqual([]);

    pump.stop();
    expect(messages()).toEqual([]);
  });

  test("変化検知・無変化沈黙・quiet inactive・再変化再開・seq 単調増加", async () => {
    vi.useFakeTimers();
    let paneText = "first";
    const captured: string[] = [];
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async (session) => {
        captured.push(session);
        return paneText;
      },
      pollIntervalMs: 10,
      quietThresholdMs: 25,
      protocolVersion: () => 2,
    });

    pump.start("work");
    await flushMicrotasks();
    expect(captured).toEqual(["work"]);
    expect(messages()).toEqual([]);

    paneText = "second";
    await vi.advanceTimersByTimeAsync(10);
    expect(messages()).toEqual([
      { type: "pane_preview", v: 2, session: "work", seq: 1, active: true, text: "second" },
    ]);

    await vi.advanceTimersByTimeAsync(10);
    expect(messages()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(messages()[1]).toEqual({
      type: "pane_preview",
      v: 2,
      session: "work",
      seq: 2,
      active: false,
      text: "",
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(messages()).toHaveLength(2);

    paneText = "third";
    await vi.advanceTimersByTimeAsync(10);
    const emitted = messages();
    expect(emitted[2]).toEqual({
      type: "pane_preview",
      v: 2,
      session: "work",
      seq: 3,
      active: true,
      text: "third",
    });
    expect(emitted.map((message) => (message.type === "pane_preview" ? message.seq : 0))).toEqual([
      1, 2, 3,
    ]);

    pump.stop();
  });

  test("captureSuggestion: 薄字の提案を input_suggestion として変化時だけ流す（prompt-suggestion-chip）", async () => {
    vi.useFakeTimers();
    const ESC = "\u001b";
    const RULE = "─".repeat(40);
    const suggestionScreen = (body: string) =>
      [RULE, `❯ ${ESC}[0m${ESC}[2m${body}${ESC}[0m`, RULE, "  auto mode on"].join("\n");
    const emptyScreen = [RULE, "❯ ", RULE, "  auto mode on"].join("\n");

    let ansi = emptyScreen;
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "static",
      captureSuggestion: async () => ansi,
      pollIntervalMs: 10,
      suggestionIntervalMs: 10,
      protocolVersion: () => 2,
    });

    const suggestions = () =>
      messages().filter((m): m is Extract<ControlMessage, { type: "input_suggestion" }> =>
        m.type === "input_suggestion");

    pump.start("work");
    await flushMicrotasks();
    // 空入力の初回（未配信 null → 提案なし ""）は流さない（購読開始のたびの無駄打ち回避）。
    await vi.advanceTimersByTimeAsync(10);
    expect(suggestions().map((m) => m.text)).toEqual([]);

    // 提案が現れたら本文を配信する。
    ansi = suggestionScreen("READMEを要約して");
    await vi.advanceTimersByTimeAsync(10);
    expect(suggestions().map((m) => m.text)).toEqual(["READMEを要約して"]);

    // 変化がなければ再配信しない。
    await vi.advanceTimersByTimeAsync(10);
    expect(suggestions().map((m) => m.text)).toEqual(["READMEを要約して"]);

    // 提案が消えたらクリア("")を配信する。
    ansi = emptyScreen;
    await vi.advanceTimersByTimeAsync(10);
    expect(suggestions().map((m) => m.text)).toEqual(["READMEを要約して", ""]);

    pump.stop();
  });

  test("captureSuggestion 未指定なら input_suggestion を流さない", async () => {
    vi.useFakeTimers();
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "static",
      pollIntervalMs: 10,
      protocolVersion: () => 2,
    });
    pump.start("work");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);
    expect(messages().some((m) => m.type === "input_suggestion")).toBe(false);
    pump.stop();
  });
  test("isIdle: 待機中に入力欄へ残った実テキストを静止後に input_residue で流し、消えたら解消する（input-residue）", async () => {
    vi.useFakeTimers();
    const ESC = "\u001b";
    const RULE = "─".repeat(40);
    const BAR = "  ⏵⏵ auto mode on (shift+tab to cycle)";
    const screen = (body: string) => [RULE, `❯ ${body}`, RULE, BAR].join("\n");
    const ghost = (body: string) => [RULE, `❯ ${ESC}[0m${ESC}[2m${body}${ESC}[0m`, RULE, BAR].join("\n");

    let ansi = screen("");
    let idle = true;
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "static",
      captureSuggestion: async () => ansi,
      isIdle: () => idle,
      residueStableMs: 30,
      pollIntervalMs: 10,
      suggestionIntervalMs: 10,
      protocolVersion: () => 2,
    });
    const residues = () =>
      messages().filter((m): m is Extract<ControlMessage, { type: "input_residue" }> =>
        m.type === "input_residue").map((m) => m.text);

    pump.start("work");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    // 空入力の初回も 1 回だけ流す（作り直された pump の前に出ていたバナーを消す）。
    expect(residues()).toEqual([""]);

    // 薄字の提案は残留ではない。
    ansi = ghost("1");
    await vi.advanceTimersByTimeAsync(60);
    expect(residues()).toEqual([""]);

    // 実テキストは静止時間に満たないうちは流さない（打鍵中を拾わない）。
    ansi = screen("1");
    await vi.advanceTimersByTimeAsync(10);
    expect(residues()).toEqual([""]);
    await vi.advanceTimersByTimeAsync(40);
    expect(residues()).toEqual(["", "1"]);

    // 変わらなければ再送しない。
    await vi.advanceTimersByTimeAsync(40);
    expect(residues()).toEqual(["", "1"]);

    // 処理が始まったら（待機中でない）すぐ解消を流す。
    idle = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(residues()).toEqual(["", "1", ""]);

    // 待機に戻って再び静止したら知らせ直す。
    idle = true;
    await vi.advanceTimersByTimeAsync(60);
    expect(residues()).toEqual(["", "1", "", "1"]);
    // 後から加わった前面購読者へは、変化が無くても知らせ直す。
    pump.resendLastIfInteractive();
    expect(residues()).toEqual(["", "1", "", "1", "1"]);
    // 離脱時は解消を流す。
    pump.stop();
    expect(residues()).toEqual(["", "1", "", "1", "1", ""]);
  });

  test("isIdle 未指定なら input_residue を流さない", async () => {
    vi.useFakeTimers();
    const RULE = "─".repeat(40);
    const { writer, messages } = memoryWriter();
    const pump = new PanePreviewPump({
      writer,
      capture: async () => "static",
      captureSuggestion: async () => [RULE, "❯ 1", RULE, "  ⏵⏵ auto mode on"].join("\n"),
      pollIntervalMs: 10,
      suggestionIntervalMs: 10,
      residueStableMs: 10,
      protocolVersion: () => 2,
    });
    pump.start("work");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(80);
    expect(messages().some((m) => m.type === "input_residue")).toBe(false);
    pump.stop();
  });
});
