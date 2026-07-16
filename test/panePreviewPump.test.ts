// panePreviewPump.test.ts — tmux pane 一時進捗 pump テスト

import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LineWriter } from "../src/lineWriter.js";
import { PanePreviewPump } from "../src/panePreviewPump.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";

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
});
