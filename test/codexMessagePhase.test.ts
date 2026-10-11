import { describe, expect, test } from "vitest";
import { isVisibleCodexMessagePhase } from "../src/codex/codexMessagePhase.js";
import { codexItemToChatOutput } from "../src/codex/codexNativeTurnController.js";

describe("isVisibleCodexMessagePhase", () => {
  test("本文として出す区分と、区分なし（欠落）を通す", () => {
    for (const phase of ["commentary", "partial_answer", "final_answer", undefined]) {
      expect(isVisibleCodexMessagePhase(phase)).toBe(true);
    }
  });

  test("内部区分・未知の値・明示の null・文字列以外は通さない", () => {
    for (const phase of ["analysis", "answer", "", "PARTIAL_ANSWER", null, 1, {}, []]) {
      expect(isVisibleCodexMessagePhase(phase)).toBe(false);
    }
  });
});

describe("codexItemToChatOutput: agentMessage の phase", () => {
  const item = (phase: unknown): Record<string, unknown> =>
    ({ id: "m1", type: "agentMessage", text: "本文", ...(phase === undefined ? {} : { phase }) });

  test("partial_answer（Codex 0.162+）と区分なしの本文を live でも出す", () => {
    for (const phase of ["commentary", "partial_answer", "final_answer", undefined]) {
      expect(codexItemToChatOutput(item(phase))).toEqual({
        type: "chat_output", v: 1, streamId: "codex-item-m1", role: "assistant", text: "本文", eof: true,
      });
    }
  });

  test("内部区分と明示の null は従来どおり出さない", () => {
    expect(codexItemToChatOutput(item("analysis"))).toBeNull();
    expect(codexItemToChatOutput(item(null))).toBeNull();
  });
});
