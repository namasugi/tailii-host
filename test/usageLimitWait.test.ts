// usageLimitWait.test.ts — 使用量制限の自動再開待ちフッターの転写（usage-limit-wait）
import { describe, expect, it } from "vitest";
import {
  describeUsageLimitWait,
  parseUsageLimitNextLine,
  parseUsageLimitWait,
  parseUsageLimitWaitLine,
  sameUsageLimitWait,
  usageLimitAutoContinueCancelled,
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

  // 2.1.284+: 入力欄の下が「状態行 + 次の手」の 2 行組（2.1.289 のバイナリから組み立てを写した形）。
  const twoLineFooter = (status: string, next: string) => [
    "⏺ 調査を続けます。",
    "",
    "────────────────────────────────",
    "❯ ",
    "────────────────────────────────",
    status,
    next,
  ].join("\n");

  it("2 行組: 待機中（時刻あり / 時刻なし / クレジット案内付き）", () => {
    expect(parseUsageLimitWait(twoLineFooter(
      "Usage limit reached · limit resets 3:45pm",
      "Continuing automatically at 3:45pm · esc to cancel",
    ))).toEqual({ kind: "waiting", resumeAt: "3:45pm" });
    expect(parseUsageLimitWait(twoLineFooter(
      "Usage limit reached",
      "Continuing automatically when it resets · esc to cancel",
    ))).toEqual({ kind: "waiting", resumeAt: null });
    expect(parseUsageLimitWait(twoLineFooter(
      "Usage limit reached · limit resets 3:45pm",
      "Continuing automatically at 3:45pm · esc to cancel · /usage-credits to continue now",
    ))).toEqual({ kind: "waiting", resumeAt: "3:45pm" });
  });

  it("2 行組: 再開中 / Enter 待ち", () => {
    expect(parseUsageLimitWait(twoLineFooter(
      "Usage limit reached · limit resets 3:45pm",
      "Continuing shortly · esc to cancel",
    ))).toEqual({ kind: "resuming" });
    expect(parseUsageLimitWait(twoLineFooter("Your usage limit has reset", "Press enter to continue")))
      .toEqual({ kind: "needs_enter" });
  });

  it("2 行目だけ（直上に limit が無い）は本文の引用として拾わない", () => {
    expect(parseUsageLimitNextLine("Continuing automatically at 3pm · esc to cancel", "⏺ 了解です")).toBeNull();
    expect(parseUsageLimitNextLine("Continuing automatically at 3pm · esc to cancel", null)).toBeNull();
    // /login 成功画面の `Press Enter to continue…` は制限待ちにしない。
    expect(parseUsageLimitWait("Login\n\nLogin successful. Press Enter to continue…")).toBeNull();
    expect(parseUsageLimitNextLine("Press enter to continue", "Rate limit options")).toBeNull();
  });

  it("2.1.289 の通知行: 再開 / 停止", () => {
    expect(parseUsageLimitWaitLine("Usage limit available again · continuing now")).toEqual({ kind: "resuming" });
    expect(parseUsageLimitWaitLine("Usage limit reached again · continuing automatically at 5pm · esc to cancel"))
      .toEqual({ kind: "waiting", resumeAt: "5pm" });
    expect(parseUsageLimitWaitLine("Usage limit has reset · press enter to continue")).toEqual({ kind: "needs_enter" });
    expect(parseUsageLimitWaitLine(
      "Automatic continue was turned off · this task will not resume on its own (/rate-limit-options to wait anyway)",
    )).toEqual({ kind: "stopped" });
    expect(parseUsageLimitWaitLine(
      "Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own",
    )).toEqual({ kind: "stopped" });
  });

  it("取り消しの通知より上に残る古い待機通知は拾わない", () => {
    const pane = [
      "⎿ Usage limit reached · continuing automatically at 3:45pm · esc to cancel",
      "⎿ Automatic continue cancelled · /rate-limit-options to re-arm",
      "────────────────────────────────",
      "❯ ",
      "────────────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    expect(parseUsageLimitWait(pane)).toBeNull();
  });

  // 2.1.289 の実画面に近い形（状態行の先頭に `⚠ `、入力欄は上下の罫線、フッター `? for shortcuts`）。
  const RULE = "─".repeat(40);
  const screen = (above: string[], footer: string[]) =>
    [...above, RULE, "❯ ", RULE, ...footer, "  ? for shortcuts"].join("\n");

  it("会話面に残った古い通知では待機・再開・Enter 待ちを出さない（フッターだけを読む）", () => {
    expect(parseUsageLimitWait(screen([
      "⎿ Usage limit reached · continuing automatically at 3:45pm · esc to cancel",
      "⎿ Usage limit available again · continuing now",
      "> continue",
      "⏺ Done.",
    ], []))).toBeNull();
    expect(parseUsageLimitWait(screen(["⎿ Usage limit has reset · press enter to continue", "> 次", "⏺ OK"], [])))
      .toBeNull();
  });

  it("本文が 2 行組を引用していても、入力欄より上なら待機にしない", () => {
    expect(parseUsageLimitWait(screen([
      "⏺ 画面にはこう出ます:",
      "Usage limit reached · limit resets 3:45pm",
      "Continuing automatically at 3:45pm · esc to cancel",
    ], []))).toBeNull();
  });

  it("状態行が狭い pane で折り返しても、フッター内の上の行に limit があれば待機中", () => {
    expect(parseUsageLimitWait(screen(["⏺ 作業中"], [
      "⚠ Usage limit reached · limit",
      "resets 3:45pm · clau.de/wrap-up",
      "Continuing automatically at 3:45pm",
      "· esc to cancel",
    ]))).toEqual({ kind: "waiting", resumeAt: "3:45pm" });
  });

  it("2 行目の文言がサーバー設定で変わっても、状態行の下の `esc to cancel` で待機中とみなす", () => {
    expect(parseUsageLimitWait(screen(["⏺ 作業中"], [
      "⚠ Usage limit reached · limit resets 3:45pm",
      "Will resume by itself at 3:45pm · esc to cancel",
    ]))).toEqual({ kind: "waiting", resumeAt: null });
  });

  it("停止は入力欄の直上の通知だけ。その後に会話が進めば出さない。不発の通知より上の古い通知も読まない", () => {
    expect(parseUsageLimitWait(screen([
      "⏺ 途中まで",
      "⎿ Automatic continue was turned off · this task will not resume on its own",
    ], []))).toEqual({ kind: "stopped" });
    expect(parseUsageLimitWait(screen([
      "⎿ Automatic continue stopped after repeated usage-limit hits · this task will not resume on its own",
      "> 別の依頼",
      "⏺ 了解",
      "⏺ 進めます",
      "⏺ 完了しました",
    ], []))).toBeNull();
    expect(parseUsageLimitWait(screen([
      "⎿ Automatic continue stopped after repeated usage-limit hits",
      "⎿ Automatic continue did not run · the continuation was blocked before it reached the model; send a prompt to continue",
    ], []))).toBeNull();
  });

  it("取り消しの直後（フッターの待機表示は消えた）を見分けられる", () => {
    const cancelled = screen(["⎿ Automatic continue cancelled · /rate-limit-options to re-arm"], []);
    expect(parseUsageLimitWait(cancelled)).toBeNull();
    expect(usageLimitAutoContinueCancelled(cancelled)).toBe(true);
    expect(usageLimitAutoContinueCancelled(screen(["⏺ OK"], []))).toBe(false);
  });

  it("再到達の通知でリセット時刻を過ぎた `continuing automatically shortly` は再開中", () => {
    expect(parseUsageLimitWaitLine("Usage limit reached again · continuing automatically shortly · esc to cancel"))
      .toEqual({ kind: "resuming" });
  });

  it("名前付きの会話（タイトル入りの上罫線）と 16 行を超える下書きでも、入力欄の直上の通知を読む", () => {
    const named = ["⏺ 途中まで", "⎿ Automatic continue was turned off · this task will not resume on its own",
      "─ 長い会話タイトルのテストああああああああ ───", "❯ ", RULE, "  ? for shortcuts"].join("\n");
    expect(parseUsageLimitWait(named)).toEqual({ kind: "stopped" });
    const draft = Array.from({ length: 20 }, (_, i) => `  下書き ${i}`);
    const longDraft = ["⎿ Automatic continue cancelled · /rate-limit-options to re-arm", RULE, "❯ 1 行目", ...draft, RULE,
      "  ? for shortcuts"].join("\n");
    // 下書きの続き行（字下げ）をたどって上罫線を見つけるので、16 行を超える下書きでも読める。
    expect(usageLimitAutoContinueCancelled(longDraft)).toBe(true);
    const shortDraft = ["⎿ Automatic continue cancelled · /rate-limit-options to re-arm", RULE, "❯ 1 行目",
      ...draft.slice(0, 8), RULE, "  ? for shortcuts"].join("\n");
    expect(usageLimitAutoContinueCancelled(shortDraft)).toBe(true);
  });

  it("罫線を持つダイアログ（承認など）の本文はフッターとして読まない", () => {
    const approval = ["⏺ 実行します", RULE, " Bash command", "", "   echo 'usage limit reached'", "",
      " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");
    expect(parseUsageLimitWait(approval)).toBeNull();
  });

  it("本文の長いダイアログで罫線が末尾 16 行から外れても、差分本文の 1 行文言を待機と読まない", () => {
    const diff = Array.from({ length: 18 }, (_, i) => `   ${i} +Usage limit reached · continuing automatically at 3:45pm · esc to cancel`);
    const longApproval = ["⏺ 編集します", RULE, " Edit file", ...diff, " Do you want to make this edit?", " ❯ 1. Yes",
      "   2. No", " Esc to cancel"].join("\n");
    expect(parseUsageLimitWait(longApproval)).toBeNull();
  });

  it("取り消しの後に会話が進んで中断した画面は「取り消しの直後」にしない", () => {
    const later = screen(["⎿ Automatic continue cancelled · /rate-limit-options to re-arm", "> テストを直して",
      "⎿ Interrupted · What should Claude do instead?"], []);
    expect(usageLimitAutoContinueCancelled(later)).toBe(false);
  });

  it("時刻だけが次の行へ折り返したときだけ繋ぎ、下のフッター行は飲み込まない", () => {
    expect(parseUsageLimitWait(screen(["⏺ 作業中"], [
      "⚠ Usage limit reached · limit resets 3:45pm", "Continuing automatically at", "3:45pm · esc to cancel",
    ]))).toEqual({ kind: "waiting", resumeAt: "3:45pm" });
    expect(parseUsageLimitWait(screen(["⏺ 作業中"], [
      "⚠ Usage limit reached · limit resets 3:45pm", "Continuing automatically at 3:45pm", "⏵⏵ accept edits on (shift+tab to cycle)",
    ]))).toEqual({ kind: "waiting", resumeAt: "3:45pm" });
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
