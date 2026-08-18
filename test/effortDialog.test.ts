// effortDialog.test.ts — `/effort` 確認ダイアログの自動承認
import { describe, expect, test } from "vitest";
import { EFFORT_COMMAND_PATTERN, confirmEffortChangeDialog } from "../src/hub/effortDialog.js";

function fakeBackend(screens: string[]) {
  const sent: string[][] = [];
  let i = 0;
  return {
    sent,
    backend: {
      capturePane: async () => screens[Math.min(i++, screens.length - 1)] ?? "",
      sendKeys: async (_name: string, keys: string[]) => { sent.push(keys); },
    },
  };
}

describe("EFFORT_COMMAND_PATTERN", () => {
  test("既知 5 値の /effort だけに一致する", () => {
    for (const lv of ["low", "medium", "high", "xhigh", "max"]) {
      expect(EFFORT_COMMAND_PATTERN.test(`/effort ${lv}`)).toBe(true);
    }
    expect(EFFORT_COMMAND_PATTERN.test("/effort ultra")).toBe(false);
    expect(EFFORT_COMMAND_PATTERN.test("/effort")).toBe(false);
    expect(EFFORT_COMMAND_PATTERN.test("please run /effort max")).toBe(false);
  });
});

describe("confirmEffortChangeDialog", () => {
  test("ダイアログが見えたら Enter を 1 回送る（出現まで待つ）", async () => {
    const { backend, sent } = fakeBackend([
      "❯ /effort max",
      "Change effort level?\nYour next response will be slower and use more tokens\n❯ 1. Yes, switch to max\n  2. No, go back",
    ]);
    const confirmed = await confirmEffortChangeDialog(backend, "s", { timeoutMs: 1000, pollIntervalMs: 1 });
    expect(confirmed).toBe(true);
    expect(sent).toEqual([["Enter"]]);
  });

  test("ダイアログが出なければ timeout で何も送らない", async () => {
    const { backend, sent } = fakeBackend(["⎿ Set effort level to max"]);
    const confirmed = await confirmEffortChangeDialog(backend, "s", { timeoutMs: 20, pollIntervalMs: 1 });
    expect(confirmed).toBe(false);
    expect(sent).toEqual([]);
  });

  test("capture 失敗は無視して待ち続け、timeout で false", async () => {
    const backend = {
      capturePane: async () => { throw new Error("gone"); },
      sendKeys: async () => { throw new Error("should not send"); },
    };
    await expect(confirmEffortChangeDialog(backend, "s", { timeoutMs: 20, pollIntervalMs: 1 })).resolves.toBe(false);
  });
});
