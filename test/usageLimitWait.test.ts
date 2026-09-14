// usageLimitWait.test.ts — 使用量制限の自動再開待ちフッターの転写（usage-limit-wait）
import { describe, expect, it } from "vitest";
import {
  describeUsageLimitWait,
  parseUsageLimitWait,
  parseUsageLimitWaitLine,
  sameUsageLimitWait,
} from "../src/shared/usageLimitWait.js";

const FOOTER_WAITING = [
  "⏺ 調査を続けます。",
  "",
  "────────────────────────────────",
  "❯ ",
  "────────────────────────────────",
  "Usage limit reached · continuing automatically at 3:45pm · esc to cancel",
  "  ? for shortcuts",
].join("\n");

describe("parseUsageLimitWait", () => {
  it("待機中: 再開時刻を拾う", () => {
    expect(parseUsageLimitWait(FOOTER_WAITING)).toEqual({ kind: "waiting", resumeAt: "3:45pm" });
  });

  it("再開中 2 形（continuing shortly / Usage limit reset）", () => {
    expect(parseUsageLimitWaitLine("Usage limit reached · continuing shortly")).toEqual({ kind: "resuming" });
    expect(parseUsageLimitWaitLine("Usage limit reset · continuing automatically")).toEqual({ kind: "resuming" });
  });

  it("スリープ後の Enter 待ち / 連続到達での停止", () => {
    expect(parseUsageLimitWaitLine("Your usage limit has reset · press enter to continue")).toEqual({ kind: "needs_enter" });
    expect(parseUsageLimitWaitLine(
      "Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again",
    )).toEqual({ kind: "stopped" });
  });

  it("時刻の区切りが無い / 時刻なしでも waiting になる", () => {
    expect(parseUsageLimitWaitLine("Usage limit reached · continuing automatically at 2am")).toEqual({
      kind: "waiting", resumeAt: "2am",
    });
    expect(parseUsageLimitWaitLine("Usage limit reached · continuing automatically")).toEqual({
      kind: "waiting", resumeAt: null,
    });
  });

  it("本文中の引用（末尾 16 行の外）は拾わない・通常フッターは null", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const quoted = `Usage limit reached · continuing automatically at 1pm\n${body}\n❯ \n? for shortcuts`;
    expect(parseUsageLimitWait(quoted)).toBeNull();
    expect(parseUsageLimitWait("⏺ done\n❯ \n? for shortcuts")).toBeNull();
  });

  it("ANSI を剥がして判定する", () => {
    const ansi = "\u001b[2mUsage limit reached · continuing automatically at 10:00am · esc to cancel\u001b[0m";
    expect(parseUsageLimitWait(`❯ \n${ansi}`)).toEqual({ kind: "waiting", resumeAt: "10:00am" });
  });

  it("同値判定と日本語文言", () => {
    expect(sameUsageLimitWait({ kind: "waiting", resumeAt: "3pm" }, { kind: "waiting", resumeAt: "3pm" })).toBe(true);
    expect(sameUsageLimitWait({ kind: "waiting", resumeAt: "3pm" }, { kind: "waiting", resumeAt: "4pm" })).toBe(false);
    expect(sameUsageLimitWait(null, { kind: "resuming" })).toBe(false);
    expect(sameUsageLimitWait(null, null)).toBe(true);
    expect(describeUsageLimitWait({ kind: "waiting", resumeAt: "3:45pm" })).toContain("3:45pm");
    expect(describeUsageLimitWait({ kind: "needs_enter" })).toContain("続行");
  });
});
