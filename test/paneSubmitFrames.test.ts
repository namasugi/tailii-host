// paneSubmitFrames.test.ts
// 送信確定ループのフレーム判定を、**実機 claude 2.1.278 の無加工キャプチャ**で検証する。
// フィクスチャは `test/fixtures/pane/*.ansi`（tmux `capture-pane -p -e` をそのまま保存）。
// 切り詰めず全文で読むこと: 末尾数行に縮めると入力欄の罫線ペアが落ち、
// `extractClaudeInputBox` の挙動が実機と変わって偽の緑になる（実測で踏んだ）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  claudeComposerBarVisible,
  classifySubmitFrame,
  inputBoxHasRealPendingText,
  inputBoxRealText,
  screenShowsDialogFooter,
} from "../src/backend/tmux.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pane");

/** 生キャプチャを読む（末尾の空行だけは backend の capture と同じく落とす）。 */
function frame(name: string): string {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.ansi`), "utf8").split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

const IDLE = frame("idle");
const TYPED = frame("typed");
const INVISIBLE_HOLD = frame("invisible-hold");
const PROCESSING = frame("processing");
const SHELL_MODE = frame("shell-mode");
const ACCEPT_EDITS = frame("accept-edits");
const QUESTION_DIALOG = frame("question-dialog");
const APPROVAL_DIALOG = frame("approval-dialog");

/**
 * バーの**下**に常駐する agents パネル（subagent 実行中に出る）。
 * 末尾数行しか見ない判定はこれでバーを見失う（2026-07-29 のライブビュー全滅と同型）。
 */
const AGENTS_PANEL = "\n⏺ main\n◯ explore-agent  調査中\n◯ plan-agent  設計中";
/** artifact タブ行（同じくバーの下に常駐する）。 */
const ARTIFACT_TAB = "\n⧉ design-review";

describe("claudeComposerBarVisible（実機キャプチャ）", () => {
  test("入力欄を見ているフレームでだけ true", () => {
    expect(claudeComposerBarVisible(IDLE)).toBe(true);
    // 本文入力中はバーがモード記号だけに縮む。
    expect(claudeComposerBarVisible(TYPED)).toBe(true);
    expect(claudeComposerBarVisible(INVISIBLE_HOLD)).toBe(true);
    // 応答生成中は `esc to interrupt` を含む形に変わる。
    expect(claudeComposerBarVisible(PROCESSING)).toBe(true);
    // シェルモードのバーは**モード記号を持たない**（`! for shell mode`）。
    expect(claudeComposerBarVisible(SHELL_MODE)).toBe(true);
    expect(claudeComposerBarVisible(ACCEPT_EDITS)).toBe(true);
  });

  test("ダイアログ表示中は false（バーがヒント行に置き換わる）", () => {
    expect(claudeComposerBarVisible(QUESTION_DIALOG)).toBe(false);
    expect(claudeComposerBarVisible(APPROVAL_DIALOG)).toBe(false);
  });

  test("バーの下に常駐する TUI 行（agents パネル / artifact タブ）を読み飛ばす", () => {
    expect(claudeComposerBarVisible(INVISIBLE_HOLD + AGENTS_PANEL)).toBe(true);
    expect(claudeComposerBarVisible(INVISIBLE_HOLD + ARTIFACT_TAB)).toBe(true);
    expect(claudeComposerBarVisible(IDLE + AGENTS_PANEL + ARTIFACT_TAB)).toBe(true);
  });

  test("SGR を剥がすので text キャプチャでも同じ判定になる", () => {
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");
    expect(claudeComposerBarVisible(stripAnsi(IDLE))).toBe(true);
    expect(claudeComposerBarVisible(stripAnsi(APPROVAL_DIALOG))).toBe(false);
  });
});

describe("screenShowsDialogFooter（積極的なダイアログ判定）", () => {
  test("実機の 2 形（設問 / ツール承認）を拾い、composer フレームでは出ない", () => {
    expect(screenShowsDialogFooter(QUESTION_DIALOG)).toBe(true);
    // 承認ダイアログのフッターは `Enter to select` ではない（`Esc to cancel · Tab to amend`）。
    expect(screenShowsDialogFooter(APPROVAL_DIALOG)).toBe(true);
    for (const composer of [IDLE, TYPED, INVISIBLE_HOLD, PROCESSING, SHELL_MODE, ACCEPT_EDITS]) {
      expect(screenShowsDialogFooter(composer)).toBe(false);
    }
  });
});

describe("classifySubmitFrame（実機キャプチャ）", () => {
  test("ダイアログは入力欄と誤認される。だから撃たない側へ倒す", () => {
    // 前提の再確認: 残存テキスト判定だけでは両ダイアログとも「未送信テキストあり」に見える。
    expect(inputBoxHasRealPendingText(QUESTION_DIALOG)).toBe(true);
    expect(inputBoxHasRealPendingText(APPROVAL_DIALOG)).toBe(true);
    expect(inputBoxRealText(APPROVAL_DIALOG)).toBe("1. Yes");
    // それでも Enter は撃たない。撃つと選択肢を誤操作し、承認ダイアログでは
    // ファイル書き込みを勝手に承認してしまう。
    expect(classifySubmitFrame(QUESTION_DIALOG)).toBe("dialog");
    expect(classifySubmitFrame(APPROVAL_DIALOG)).toBe("dialog");
  });

  test("送信成立は打ち切り、未送信・確認待ちは撃ち直す", () => {
    expect(classifySubmitFrame(IDLE)).toBe("submitted");
    expect(classifySubmitFrame(ACCEPT_EDITS)).toBe("submitted");
    // 応答生成中 = 送信は成立済み（入力欄は空）。
    expect(classifySubmitFrame(PROCESSING)).toBe("submitted");
    expect(classifySubmitFrame(TYPED)).toBe("pending");
    // 2.1.277+ の不可視文字の確認待ち: 1 回目の Enter では送信されず本文が残る。
    expect(classifySubmitFrame(INVISIBLE_HOLD)).toBe("pending");
    expect(classifySubmitFrame(SHELL_MODE)).toBe("pending");
  });

  test("agents パネルでバーが押し下げられても「送信成立」と誤らない", () => {
    // ここを取りこぼすと、subagent 稼働中の会話だけ確認待ちのまま打ち切られ、
    // 本文が入力欄に滞留したまま配送済みレシートが返る（無言の再発）。
    expect(classifySubmitFrame(INVISIBLE_HOLD + AGENTS_PANEL)).toBe("pending");
    expect(classifySubmitFrame(IDLE + AGENTS_PANEL)).toBe("submitted");
  });

  test("ダイアログの選択肢がバーの定型句を含んでも composer と誤らない", () => {
    // 選択肢は Claude が書く自由文。部分一致でバーを拾うと設問へ Enter を撃ち込む。
    const crafted = QUESTION_DIALOG.replace("Chat about this", "Split the work for agents");
    expect(classifySubmitFrame(crafted)).toBe("dialog");
  });

  test("capture 不能は unknown（撃ち続けないし、配送も主張しない）", () => {
    expect(classifySubmitFrame(null)).toBe("unknown");
  });
});
