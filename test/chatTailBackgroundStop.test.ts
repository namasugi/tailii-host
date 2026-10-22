import { describe, expect, test, vi } from "vitest";
import { ChatTailController, isBackgroundOutputPathFor } from "../src/chat/chatTailController.js";
import type { BackgroundCommandStopHooks, BackgroundCommandStopResult } from "../src/chat/backgroundCommandStop.js";
import type { SubagentTailer } from "../src/chat/subagentTailer.js";

const OUTPUT = "/private/tmp/claude-502/-proj/sess/tasks/b1sf98mak.output";

function makeController(options: {
  outputPath: string | null;
  agent?: "claude" | "codex";
  stop: (outputPath: string, hooks: BackgroundCommandStopHooks) => Promise<BackgroundCommandStopResult>;
}) {
  const marks: [string, number][] = [];
  const unmarks: string[] = [];
  const subagentTailer = {
    outputPath: () => options.outputPath,
    markUserStopped: (taskId: string, atMs: number) => { marks.push([taskId, atMs]); return true; },
    unmarkUserStopped: (taskId: string) => { unmarks.push(taskId); },
  } as unknown as SubagentTailer;
  const controller = new ChatTailController({
    writer: undefined as never, tailer: undefined as never, projectsRoot: "/tmp/projects",
    agent: options.agent ?? "claude", subagentTailer, stopBackgroundCommandProcess: options.stop,
  });
  return { controller, marks, unmarks };
}

describe("ChatTailController.stopBackgroundCommand", () => {
  test("止めたら SIGTERM の直前に記録し（onSignal）、結果を返す", async () => {
    const stop = vi.fn(async (_path: string, hooks: BackgroundCommandStopHooks) => {
      hooks.onSignal?.(1234);
      return { status: "stopped" as const };
    });
    const { controller, marks, unmarks } = makeController({ outputPath: OUTPUT, stop });
    expect(await controller.stopBackgroundCommand("b1sf98mak")).toEqual({ status: "stopped" });
    expect(stop).toHaveBeenCalledWith(OUTPUT, expect.anything());
    expect(marks).toEqual([["b1sf98mak", 1234]]);
    expect(unmarks).toEqual([]);
  });

  test("送ったのに止まらなかったら記録を外す（一覧は実行中のまま）", async () => {
    const { controller, marks, unmarks } = makeController({
      outputPath: OUTPUT,
      stop: async (_path, hooks) => { hooks.onSignal?.(1); return { status: "failed", error: "プロセスが終了しませんでした。" }; },
    });
    expect((await controller.stopBackgroundCommand("b1sf98mak")).status).toBe("failed");
    expect(marks).toHaveLength(1);
    expect(unmarks).toEqual(["b1sf98mak"]);
  });

  test("もう動いていなかったものは止めた時点で片付ける。調べられない・見つからないものは記録しない", async () => {
    const notRunning = makeController({ outputPath: OUTPUT, stop: async () => ({ status: "not_running" }) });
    expect((await notRunning.controller.stopBackgroundCommand("b1sf98mak")).status).toBe("not_running");
    expect(notRunning.marks.map(([id]) => id)).toEqual(["b1sf98mak"]);

    for (const status of ["not_found", "failed"] as const) {
      const other = makeController({ outputPath: OUTPUT, stop: async () => ({ status }) });
      await other.controller.stopBackgroundCommand("b1sf98mak");
      expect(other.marks).toEqual([]);
    }
  });

  test("出力パスが無い・その taskId の出力ファイルでない・Codex 会話なら止めずに not_found", async () => {
    const stop = vi.fn(async () => ({ status: "stopped" as const }));
    for (const outputPath of [null, "/dev/ttys003", "/private/tmp/x/tasks/other.output", "/private/tmp/x/b1sf98mak.output"]) {
      const { controller } = makeController({ outputPath, stop });
      expect(await controller.stopBackgroundCommand("b1sf98mak")).toEqual({ status: "not_found" });
    }
    const codex = makeController({ outputPath: OUTPUT, agent: "codex", stop });
    expect(await codex.controller.stopBackgroundCommand("b1sf98mak")).toEqual({ status: "not_found" });
    expect(stop).not.toHaveBeenCalled();
  });

  test("isBackgroundOutputPathFor は絶対パスの …/tasks/<taskId>.output だけを認める", () => {
    expect(isBackgroundOutputPathFor("b1", "/tmp/a/tasks/b1.output")).toBe(true);
    expect(isBackgroundOutputPathFor("b1", "tasks/b1.output")).toBe(false);
    expect(isBackgroundOutputPathFor("b1", "/tmp/a/tasks/b1.output.bak")).toBe(false);
    expect(isBackgroundOutputPathFor("b1", "/tmp/a/b1.output")).toBe(false);
  });
});
