import { describe, expect, it } from "vitest";
import { pollUntilTrue, settleSubmitVerdict } from "../src/backend/tmux.js";

// 送信確定の早抜け（submit-fast-verify）。画面は claude TUI の最小形（入力欄の罫線＋ボトムバー）。
const RULE = "─".repeat(40);
const BAR = "  ⏵⏵ accept edits on (shift+tab to cycle)";
const frame = (input: string): string => `${RULE}\n❯ ${input}\n${RULE}\n${BAR}\n`;
const SUBMITTED = frame("");
const PENDING = frame("こんにちは");
const PARTIAL = `${RULE}\n❯ \n`; // 描画途中（ボトムバーが欠けている）

function scripted(frames: Array<string | null>): { capture: () => Promise<string | null>; reads: () => number } {
  let index = 0;
  return {
    capture: async () => frames[Math.min(index++, frames.length - 1)] ?? null,
    reads: () => index,
  };
}

describe("settleSubmitVerdict", () => {
  it("待ち全体が 0 なら 1 回だけ読む（従来と同じ回数）", async () => {
    const screen = scripted([PENDING, SUBMITTED]);
    expect(await settleSubmitVerdict({ capture: screen.capture, windowMs: 0 })).toBe("pending");
    expect(screen.reads()).toBe(1);
  });

  it("submitted が 2 回続けば期限前に抜ける", async () => {
    const screen = scripted([PENDING, SUBMITTED, SUBMITTED, PENDING]);
    const started = Date.now();
    const verdict = await settleSubmitVerdict({ capture: screen.capture, windowMs: 2_000, firstDelayMs: 0, pollMs: 10 });
    expect(verdict).toBe("submitted");
    expect(screen.reads()).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("一瞬だけ submitted に見えたフレームでは抜けず、期限の時点のフレームで決める", async () => {
    // 描画途中で入力欄が一瞬空に見えても、続く読みが pending なら成立とみなさない。
    const screen = scripted([SUBMITTED, PENDING]);
    const verdict = await settleSubmitVerdict({ capture: screen.capture, windowMs: 80, firstDelayMs: 0, pollMs: 10 });
    expect(verdict).toBe("pending");
  });

  it("途中のダイアログ風フレームでは抜けない（期限の時点で submitted なら submitted）", async () => {
    const screen = scripted([PARTIAL, PENDING, SUBMITTED]);
    const verdict = await settleSubmitVerdict({ capture: screen.capture, windowMs: 60, firstDelayMs: 0, pollMs: 10 });
    expect(verdict).toBe("submitted");
  });

  it("期限の時点で読めなければ unknown", async () => {
    const screen = scripted([PENDING, null]);
    const verdict = await settleSubmitVerdict({ capture: screen.capture, windowMs: 40, firstDelayMs: 0, pollMs: 10 });
    expect(verdict).toBe("unknown");
  });
});

describe("pollUntilTrue", () => {
  it("待ち全体が 0 なら 2 回確かめる（従来の「確かめる → もう一度確かめる」と同じ回数）", async () => {
    let calls = 0;
    expect(await pollUntilTrue(async () => { calls += 1; return false; }, { windowMs: 0 })).toBe(false);
    expect(calls).toBe(2);
  });

  it("見えた時点で抜ける", async () => {
    let calls = 0;
    const started = Date.now();
    const result = await pollUntilTrue(async () => { calls += 1; return calls === 3; }, {
      windowMs: 2_000, firstDelayMs: 0, pollMs: 10,
    });
    expect(result).toBe(true);
    expect(calls).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("見えないまま期限を過ぎたら false（期限まで待つ）", async () => {
    const started = Date.now();
    expect(await pollUntilTrue(async () => false, { windowMs: 60, firstDelayMs: 0, pollMs: 10 })).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});
