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
  inputBoxResidueText,
  screenBusyButScrolledAway,
  screenScrolledAwayHidingBottom,
  revealHiddenBottom,
  jumpToLatestAllowed,
  screenShouldJumpToLatest,
  screenShowsApprovalDialog,
  screenShowsCancellableChoice,
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
/** 2.1.283 の複数設問（タブ付き。フッターが `Tab/Arrow keys to navigate` に変わる）。 */
const QUESTION_DIALOG_MULTI = frame("question-dialog-multi");
/** 設問を Esc で閉じた直後（`User declined to answer questions` + 空の入力欄）。 */
const QUESTION_DECLINED = frame("question-declined");

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

describe("screenShowsApprovalDialog（hook で通らなかった承認の転写）", () => {
  const SAFETY_APPROVAL = frame("approval-safety-artifact");

  test("ツール承認と、hook の allow を上書きした安全確認を拾う", () => {
    expect(screenShowsApprovalDialog(APPROVAL_DIALOG)).toBe(true);
    expect(screenShowsApprovalDialog(SAFETY_APPROVAL)).toBe(true);
  });

  test("カーソルを 2 番目へ動かしたフッター（`Esc to cancel` 単独）も拾う", () => {
    const moved = frame("approval-cursor-moved");
    expect(moved).not.toContain("Tab to amend");
    expect(screenShowsApprovalDialog(moved)).toBe(true);
    expect(screenShowsDialogFooter(moved)).toBe(true);
  });

  test("設問・入力欄のフレームでは出ない", () => {
    for (const other of [QUESTION_DIALOG, QUESTION_DIALOG_MULTI, IDLE, TYPED, PROCESSING, ACCEPT_EDITS]) {
      expect(screenShowsApprovalDialog(other)).toBe(false);
    }
  });

  test("本文がフッター文言を引用していても、バーが見えていれば出ない", () => {
    const quoted = PROCESSING.replace(/\n[^\n]*esc to interrupt/, (bar) => `\nEsc to cancel · Tab to amend${bar}`);
    expect(quoted).not.toBe(PROCESSING);
    expect(screenShowsApprovalDialog(quoted)).toBe(false);
  });

  test("承認表示中は本文を打たない門番（screenShowsDialogFooter）も効いている", () => {
    expect(screenShowsDialogFooter(SAFETY_APPROVAL)).toBe(true);
    expect(classifySubmitFrame(SAFETY_APPROVAL)).toBe("dialog");
  });
});

describe("screenShowsCancellableChoice（Esc で閉じてよい選択ダイアログ）", () => {
  test("設問ダイアログ（1 問 / 複数問）だけを拾う", () => {
    expect(screenShowsCancellableChoice(QUESTION_DIALOG)).toBe(true);
    expect(screenShowsCancellableChoice(QUESTION_DIALOG_MULTI)).toBe(true);
  });

  test("承認ダイアログは対象外（Esc はツールの拒否になる）", () => {
    expect(screenShowsCancellableChoice(APPROVAL_DIALOG)).toBe(false);
  });

  test("入力欄を見ているフレームでは決して true にしない（Esc は処理中の中断キー）", () => {
    for (const composer of [IDLE, TYPED, INVISIBLE_HOLD, PROCESSING, SHELL_MODE, ACCEPT_EDITS, QUESTION_DECLINED]) {
      expect(screenShowsCancellableChoice(composer)).toBe(false);
    }
    // 本文の末尾がフッター文言を引用していても、バーが見えていれば撃たない。
    const quoted = PROCESSING.replace(/\n[^\n]*esc to interrupt/, (bar) => `\nEnter to select · Esc to cancel${bar}`);
    expect(quoted).not.toBe(PROCESSING);
    expect(screenShowsCancellableChoice(quoted)).toBe(false);
  });

  test("80 桁で折り返したフッター（自由記述欄フォーカス中）も拾う", () => {
    const wrapped = QUESTION_DIALOG_MULTI.replace(
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
      "Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in VS Code · Esc to\ncancel",
    );
    expect(wrapped).not.toBe(QUESTION_DIALOG_MULTI);
    expect(screenShowsCancellableChoice(wrapped)).toBe(true);
  });

  test("設問を閉じた直後は空の入力欄へ戻る（続けて本文を打てる）", () => {
    expect(classifySubmitFrame(QUESTION_DIALOG_MULTI)).toBe("dialog");
    expect(classifySubmitFrame(QUESTION_DECLINED)).toBe("submitted");
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

describe("screenBusyButScrolledAway（端末側で上へスクロールされた処理中の Claude, scroll-pill）", () => {
  const FULLSCREEN_BUSY = frame("fullscreen-busy");
  const SCROLLED_BUSY = frame("fullscreen-scrolled-busy");
  const SCROLLED_IDLE = frame("fullscreen-scrolled-idle");
  const PILL = "Jump to bottom: fn+↓ to scroll";
  /** pill が重なっている行（実機採取）。 */
  const pillLine = (screen: string): string => {
    const line = screen.split("\n").find((candidate) => candidate.includes(PILL));
    if (line === undefined) throw new Error("pill の行が無い");
    return line;
  };

  test("処理中にスクロールされた画面（案内が過去の行に重なる形）を拾う", () => {
    expect(screenBusyButScrolledAway(SCROLLED_BUSY)).toBe(true);
  });

  test("案内は行の中央に重なり、右側に下の本文が残る形でも拾う", () => {
    const line = pillLine(SCROLLED_BUSY);
    const centered = SCROLLED_BUSY.replace(
      line,
      "⏺ The Bash tool blocks standalone sleep comm Jump to bottom: fn+↓ to scroll n explicitly requested. The tool enforces",
    );
    expect(centered).not.toBe(SCROLLED_BUSY);
    expect(screenBusyButScrolledAway(centered)).toBe(true);
  });

  test("herdr の案内（`N new messages (click) ↓`）ほかの書式も拾う", () => {
    for (const pill of ["2 new messages (click) ↓", "1 new message (ctrl+end) ↓", "3 new messages ↓"]) {
      const variant = SCROLLED_BUSY.replace(PILL, pill);
      expect(variant).not.toBe(SCROLLED_BUSY);
      expect(screenBusyButScrolledAway(variant)).toBe(true);
    }
    // 案内の本体だけの形は、案内だけの行のときに限って拾う（本文の中と区別がつかない）。
    const bare = SCROLLED_BUSY.replace(pillLine(SCROLLED_BUSY), "                                    Jump to bottom");
    expect(bare).not.toBe(SCROLLED_BUSY);
    expect(screenBusyButScrolledAway(bare)).toBe(true);
  });

  test("バーの下に agents パネル・⧉ 行が続いても処理中と読む（iOS の末尾スキップと同じ）", () => {
    const panel = "\n\n  ⏺ main\n  ◯ design-team:designer  …  11m 0s · ↓ 32.9k tokens\n  ⧉  tailii-ux-redesign";
    expect(screenBusyButScrolledAway(SCROLLED_BUSY + panel)).toBe(true);
    expect(screenBusyButScrolledAway(SCROLLED_IDLE + panel)).toBe(false);
  });

  test("案内と入力欄の間にキュー済みの発話が挟まっても拾う", () => {
    const lines = SCROLLED_BUSY.split("\n");
    const pillIndex = lines.findIndex((line) => line.includes(PILL));
    lines.splice(pillIndex + 1, 0, "❯ あとで送る発話", "  ctrl+x ctrl+s to send now");
    expect(screenBusyButScrolledAway(lines.join("\n"))).toBe(true);
  });

  test("最新位置を見ている処理中・スクロールしたままの待機中・普段の画面では出ない", () => {
    for (const other of [FULLSCREEN_BUSY, SCROLLED_IDLE, IDLE, TYPED, PROCESSING, QUESTION_DIALOG, APPROVAL_DIALOG]) {
      expect(screenBusyButScrolledAway(other)).toBe(false);
    }
  });

  test("案内の文言が入力欄から離れた本文にあるだけ・単語の一部なだけでは出ない", () => {
    const quoted = FULLSCREEN_BUSY.replace(/\n([^\n]*Frolicking)/, "\n  3 new messages ↓\n\n$1");
    expect(quoted).not.toBe(FULLSCREEN_BUSY);
    expect(screenBusyButScrolledAway(quoted)).toBe(false);
    const glued = SCROLLED_BUSY.replace(PILL, "Jump to bottom: fn+↓ to scrolling");
    expect(screenBusyButScrolledAway(glued)).toBe(false);
  });
});

describe("screenShouldJumpToLatest（上へスクロールされた画面を最新位置へ戻すか, jump-to-latest）", () => {
  const FULLSCREEN_BUSY = frame("fullscreen-busy");
  const SCROLLED_BUSY = frame("fullscreen-scrolled-busy");
  const SCROLLED_IDLE = frame("fullscreen-scrolled-idle");

  test("処理中でも待機中でも、入力欄の直上に案内があれば戻す", () => {
    expect(screenShouldJumpToLatest(SCROLLED_BUSY)).toBe(true);
    expect(screenShouldJumpToLatest(SCROLLED_IDLE)).toBe(true);
    // 本文の行の途中に重なり、空行を挟まない形（実測 2.1.285）。
    const glued = SCROLLED_IDLE.replace(/\n[^\n]*1 new message: fn\+↓ to scroll[^\n]*\n\s*\n/,
      "\n  28. Single responsibility, multiple benefi Jump to bottom: fn+↓ to scroll\n");
    expect(glued).not.toBe(SCROLLED_IDLE);
    expect(screenShouldJumpToLatest(glued)).toBe(true);
  });

  test("最新位置を見ている画面・ダイアログ（End キーが選択肢を動かしうる）では戻さない", () => {
    for (const other of [FULLSCREEN_BUSY, IDLE, TYPED, PROCESSING, QUESTION_DIALOG, APPROVAL_DIALOG]) {
      expect(screenShouldJumpToLatest(other)).toBe(false);
    }
    // ダイアログの本文に案内の文言があっても戻さない。
    const quotedInDialog = APPROVAL_DIALOG.replace(/\n/, "\n  3 new messages ↓\n");
    expect(screenShouldJumpToLatest(quotedInDialog)).toBe(false);
  });
});

describe("screenScrolledAwayHidingBottom（上へスクロールされて設問・入力欄が画面外, scrolled-hiding-bottom）", () => {
  /** 2.1.306・fullscreen・差分パネルあり・240×30。設問ダイアログ（3 問）が見えている。 */
  const DIALOG_FULLSCREEN = frame("question-dialog-fullscreen-diff");
  /** 同じ画面を PgUp で上へスクロールした形。ダイアログも入力欄も無く、最下行に案内が重なる。 */
  const DIALOG_SCROLLED = frame("question-dialog-fullscreen-scrolled");

  test("設問を出したまま上へスクロールされた画面だけ真（実機 2026-10-21 の形）", () => {
    expect(screenScrolledAwayHidingBottom(DIALOG_SCROLLED)).toBe(true);
    // この画面では設問のフッターも入力欄も読めない（だから回答前の確認が「設問なし」と誤認した）。
    expect(screenShowsDialogFooter(DIALOG_SCROLLED)).toBe(false);
    expect(claudeComposerBarVisible(DIALOG_SCROLLED)).toBe(false);
  });

  test("herdr の案内（`N new messages (click) ↓`）でも真", () => {
    const herdrPill = DIALOG_SCROLLED.replace("Jump to bottom: fn+↓ to scroll", "2 new messages (click) ↓");
    expect(herdrPill).not.toBe(DIALOG_SCROLLED);
    expect(screenScrolledAwayHidingBottom(herdrPill)).toBe(true);
  });

  test("ダイアログ・入力欄が見えている画面、入力欄の上に案内がある画面（既存の jump-to-latest の担当）では偽", () => {
    for (const other of [
      DIALOG_FULLSCREEN, IDLE, TYPED, PROCESSING, QUESTION_DIALOG, APPROVAL_DIALOG,
      frame("fullscreen-busy"), frame("fullscreen-scrolled-busy"), frame("fullscreen-scrolled-idle"),
    ]) {
      expect(screenScrolledAwayHidingBottom(other)).toBe(false);
    }
  });

  test("差分パネルの縦線だけの行が案内の下に続いても真（空行と同じく読み飛ばす）", () => {
    const panelRows = Array.from({ length: 4 }, () => `${" ".repeat(150)}│`);
    const withPanelRows = [DIALOG_SCROLLED, ...panelRows].join("\n");
    expect(screenScrolledAwayHidingBottom(withPanelRows)).toBe(true);
  });

  test("案内が末尾にあってもボトムバーが見えている画面は偽（入力欄が見えているので戻さなくてよい）", () => {
    // 入力欄の下に案内が来た形（現実には出ないが、バーが見えたら戻さない規則を固定する）。
    const withBar = [IDLE, "⏺ 続き      Jump to bottom: fn+↓ to scroll      "].join("\n");
    expect(claudeComposerBarVisible(withBar)).toBe(true);
    expect(screenScrolledAwayHidingBottom(withBar)).toBe(false);
  });

  test("案内が末尾にあってもダイアログのフッターが見えている画面は偽（ダイアログは見えているので戻さなくてよい）", () => {
    const withFooter = [DIALOG_FULLSCREEN, "⏺ 続き      Jump to bottom: fn+↓ to scroll      "].join("\n");
    expect(screenShowsDialogFooter(withFooter)).toBe(true);
    expect(claudeComposerBarVisible(withFooter)).toBe(false);
    expect(screenScrolledAwayHidingBottom(withFooter)).toBe(false);
  });

  test("案内の文言が末尾から離れた本文にあるだけ・単語の一部なだけでは偽", () => {
    const lines = DIALOG_SCROLLED.split("\n");
    const moved = [...lines.slice(0, 3), "  3 new messages ↓", ...lines.slice(3, -1), "⏺ plain line"].join("\n");
    expect(screenScrolledAwayHidingBottom(moved)).toBe(false);
    const glued = DIALOG_SCROLLED.replace("Jump to bottom: fn+↓ to scroll", "Jump to bottom: fn+↓ to scrolling");
    expect(screenScrolledAwayHidingBottom(glued)).toBe(false);
  });
});

describe("revealHiddenBottom（隠れた下側を戻す・閉じる, scrolled-hiding-bottom）", () => {
  const SCROLLED = frame("question-dialog-fullscreen-scrolled");
  const VISIBLE = frame("question-dialog-fullscreen-diff");
  const run = async (frames: (string | null)[], options: { jumpAllowed: boolean; cancelHiddenDialog: boolean }) => {
    const keys: string[] = [];
    const queue = frames.slice();
    const result = await revealHiddenBottom({
      capture: async () => (queue.length > 1 ? queue.shift()! : queue[0] ?? null),
      sendJump: async () => { keys.push("jump"); },
      sendEscape: async () => { keys.push("esc"); },
      settleMs: 0, maxReads: 3, ...options,
    });
    return { ...result, keys };
  };

  test("戻せれば revealed（Esc は送らない）", async () => {
    const r = await run([VISIBLE], { jumpAllowed: true, cancelHiddenDialog: true });
    expect(r.outcome).toBe("revealed");
    expect(r.keys).toEqual(["jump"]);
  });

  test("戻せず、答えずに送る送信なら Esc 1 回で閉じ、入力欄（ボトムバー）が見えたら dialog-cancelled", async () => {
    const r = await run([SCROLLED, SCROLLED, SCROLLED, IDLE], { jumpAllowed: true, cancelHiddenDialog: true });
    expect(r.outcome).toBe("dialog-cancelled");
    expect(r.keys).toEqual(["jump", "esc"]);
  });

  test("Esc の後に隠れていなくても、ボトムバーが見えなければ escaped-unconfirmed（Esc は重ねない）", async () => {
    const r = await run([VISIBLE], { jumpAllowed: false, cancelHiddenDialog: true });
    expect(r.outcome).toBe("escaped-unconfirmed");
    expect(r.keys).toEqual(["esc"]);
  });

  test("答えずに送る送信でなければ Esc は送らず stuck。戻すキーの後に読めなくても stuck", async () => {
    expect((await run([SCROLLED], { jumpAllowed: true, cancelHiddenDialog: false })).outcome).toBe("stuck");
    const unreadable = await run([null], { jumpAllowed: true, cancelHiddenDialog: true });
    expect(unreadable.outcome).toBe("stuck");
    expect(unreadable.keys).toEqual(["jump"]);
  });
});

describe("jumpToLatestAllowed（会話を開いたときに戻すか）", () => {
  test("割り当てが既定のときだけ戻す", () => {
    const scrolledIdle = frame("fullscreen-scrolled-idle");
    expect(jumpToLatestAllowed(scrolledIdle, () => true)).toBe(true);
    expect(jumpToLatestAllowed(scrolledIdle, () => false)).toBe(false);
    expect(jumpToLatestAllowed(IDLE, () => true)).toBe(false);
  });
});

describe("inputBoxResidueText（入力欄に残った文字, input-residue）", () => {
  test("打ちかけの文字・端末側の下書きは拾う", () => {
    expect(inputBoxResidueText(TYPED)).toBe("pending text frame");
    // 2.1.289 実機: 設問の回答キーが入力欄へ落ちて残った形（2026-10-05 の障害）。
    expect(inputBoxResidueText(frame("typed-digit-idle"))).toBe("1");
    expect(inputBoxResidueText(frame("queued-with-draft"))).toBe("a draft typed on the Mac side");
  });

  test("シェルモードの入力は拾わない（本文だけ見せて送らせるとシェルコマンドを実行させる）", () => {
    expect(inputBoxRealText(SHELL_MODE)).toBe("echo hi");
    expect(inputBoxResidueText(SHELL_MODE)).toBe("");
  });

  test("ボトムバーの無い画面（Enter to confirm の確認・ピッカー）は入力欄と信じない", () => {
    const rule = "─".repeat(60);
    const trust = [
      " Do you trust the files in this folder?", "", rule,
      " ❯ 1. Yes, I trust this folder", "   2. No, exit", rule,
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(inputBoxResidueText(trust)).toBe("");
    // 同じ入力欄の形でも、下にボトムバーがあれば入力欄として読む。
    const typed = [rule, "❯ 1", rule, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    expect(inputBoxResidueText(typed)).toBe("1");
  });

  test("空の入力欄・処理中は拾わない", () => {
    expect(inputBoxResidueText(IDLE)).toBe("");
    expect(inputBoxResidueText(PROCESSING)).toBe("");
    expect(inputBoxResidueText(frame("named-idle-herdr"))).toBe("");
  });

  test("入力欄の位置に描かれる選択ダイアログ（設問・承認）の本文は拾わない", () => {
    // inputBoxRealText はダイアログ本体を入力欄の文字と読む（だから専用の判定を設けた）。
    expect(inputBoxRealText(QUESTION_DIALOG)).not.toBe("");
    for (const name of ["question-dialog", "question-dialog-multi", "question-dialog-multiselect-single",
      "question-dialog-preview", "approval-dialog",
      "approval-cursor-moved", "approval-safety-artifact"]) {
      expect(inputBoxResidueText(frame(name)), name).toBe("");
    }
  });
});
