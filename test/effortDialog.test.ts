// effortDialog.test.ts — `/effort` `/model` 確認ダイアログの自動承認
import { describe, expect, test } from "vitest";
import {
  EFFORT_COMMAND_PATTERN,
  MODEL_COMMAND_PATTERN,
  confirmEffortChangeDialog,
  confirmModelSwitchDialog,
} from "../src/hub/effortDialog.js";

function fakeBackend(screens: string[]) {
  const sent: string[][] = [];
  const literals: boolean[] = [];
  let i = 0;
  return {
    sent,
    literals,
    backend: {
      capturePane: async () => screens[Math.min(i++, screens.length - 1)] ?? "",
      sendKeys: async (_name: string, keys: string[], literal?: boolean) => {
        sent.push(keys);
        literals.push(literal === true);
      },
    },
  };
}

/** claude 2.1.263 の `/model <slug>` 確認ダイアログ（同梱文言）。 */
const SWITCH_MODEL_DIALOG =
  "Switch model?\n\nThis conversation is cached for the current model. Switching to Sonnet 5 means " +
  "the full history gets re-read on your next message.\n\n❯ 1. Yes, switch to Sonnet 5\n  2. No, go back";

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

describe("MODEL_COMMAND_PATTERN", () => {
  test("引数付きの /model だけに一致する（引数なしは TUI ピッカーを開く通常操作）", () => {
    expect(MODEL_COMMAND_PATTERN.test("/model claude-sonnet-5")).toBe(true);
    expect(MODEL_COMMAND_PATTERN.test("/model default")).toBe(true);
    expect(MODEL_COMMAND_PATTERN.test("/model opus ")).toBe(true);
    expect(MODEL_COMMAND_PATTERN.test("/model")).toBe(false);
    expect(MODEL_COMMAND_PATTERN.test("/model ")).toBe(false);
    expect(MODEL_COMMAND_PATTERN.test("/models list")).toBe(false);
    expect(MODEL_COMMAND_PATTERN.test("please run /model opus")).toBe(false);
  });
});

describe("confirmModelSwitchDialog", () => {
  test("ダイアログが見えたら 1（Yes, switch to）を literal で送り、閉じていれば Enter は送らない", async () => {
    const { backend, sent, literals } = fakeBackend([
      "❯ /model claude-sonnet-5",
      SWITCH_MODEL_DIALOG,
      "⎿ Set model to Sonnet 5",
    ]);
    const confirmed = await confirmModelSwitchDialog(backend, "s", {
      timeoutMs: 1000, pollIntervalMs: 1, settleMs: 1,
    });
    expect(confirmed).toBe(true);
    expect(sent).toEqual([["1"]]);
    expect(literals).toEqual([true]);
  });

  test("1 の後もダイアログが残っていれば Enter を 1 回だけ追送する", async () => {
    const { backend, sent } = fakeBackend([SWITCH_MODEL_DIALOG, SWITCH_MODEL_DIALOG]);
    const confirmed = await confirmModelSwitchDialog(backend, "s", {
      timeoutMs: 1000, pollIntervalMs: 1, settleMs: 1,
    });
    expect(confirmed).toBe(true);
    expect(sent).toEqual([["1"], ["Enter"]]);
  });

  test("ダイアログが出なければ timeout で何も送らない（初回=キャッシュ無し）", async () => {
    const { backend, sent } = fakeBackend(["⎿ Set model to Sonnet 5"]);
    const confirmed = await confirmModelSwitchDialog(backend, "s", { timeoutMs: 20, pollIntervalMs: 1 });
    expect(confirmed).toBe(false);
    expect(sent).toEqual([]);
  });

  test("effort のダイアログには反応しない（見出しが別）", async () => {
    const { backend, sent } = fakeBackend([
      "Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back",
    ]);
    const confirmed = await confirmModelSwitchDialog(backend, "s", { timeoutMs: 20, pollIntervalMs: 1 });
    expect(confirmed).toBe(false);
    expect(sent).toEqual([]);
  });
});
