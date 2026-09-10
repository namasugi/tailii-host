// questionInjection.test.ts
// AskUserQuestion 回答注入の検証（ダイアログ残存の検知と自己修復トリガ）。

import { expect, test } from "vitest";
import {
  injectQuestionAnswers, isPreviewQuestionFrame, isQuestionDialogFrame,
} from "../src/hub/questionInjection.js";
import type { SessionBackend } from "../src/backend/sessionBackend.js";
import type { QuestionAnswer } from "../src/protocol.js";

/** sendKeys を記録し、capturePane が frames を順に返すスタブ（最後の frame を以降も返す）。 */
function stubBackend(frames: string[]): { keys: string[][]; backend: SessionBackend } {
  const keys: string[][] = [];
  const remaining = frames.slice();
  const backend = {
    sendKeys: async (_session: string, sent: string[]) => { keys.push(sent); },
    sendTextSubmit: async () => {},
    capturePane: async () => (remaining.length > 1 ? remaining.shift()! : remaining[0] ?? ""),
  } as unknown as SessionBackend;
  return { keys, backend };
}

const SINGLE_ANSWER: QuestionAnswer[] = [
  { questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false },
];

/** 従来レイアウト（preview 無し）。Other 行を必ず描き、Notes 行は無い。 */
const QUESTION_DIALOG = [
  "←  ☐ 表示位置  ☐ 更新  ✔ Submit  →",
  "",
  "会話一覧のどこに出しますか？",
  "",
  "❯ 1. ヘッダーに常設ピル",
  "  2. 一覧最上部のカード",
  "  3. Type something.",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

/**
 * preview レイアウト（単一選択 + option.preview あり。claude 2.1.267 実測フレーム）。
 * 選択肢だけを左に描き、Other 行が無く、Notes 行を持つ。
 */
const PREVIEW_DIALOG = [
  " ☐ 報酬の形",
  "",
  "│ メダル報酬の増やし方はどの形にしますか?",
  "",
  "❯ 1. 深いほど厚くする(推奨)       ┌──────────────┐",
  "  2. 一律に増やす                 │ 到達  現行 → 新 │",
  "  3. 制覇ボーナス重視             └──────────────┘",
  "",
  "                                  Notes: press n to add notes",
  "",
  "  Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
].join("\n");

test("isQuestionDialogFrame: 設問 TUI だけを検知し、承認ダイアログ/❯メニューは対象外", () => {
  expect(isQuestionDialogFrame(QUESTION_DIALOG)).toBe(true);
  // 単一設問（タブ無し）は Type something. / Chat about this で拾う。
  expect(isQuestionDialogFrame(
    "好きな色は?\n❯ 1. 赤\n  4. Type something.\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel",
  )).toBe(true);
  // 承認ダイアログ（Enter to select を含まない）。
  expect(isQuestionDialogFrame(
    "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend · ctrl+e to explain",
  )).toBe(false);
  // /remote-control 等の ❯ メニュー（設問固有マーカーが無い）。
  expect(isQuestionDialogFrame(
    "Remote Control\n❯ Continue\nEnter to select · Esc to continue",
  )).toBe(false);
  expect(isQuestionDialogFrame("")).toBe(false);
});

/** preview レイアウトで Notes 欄を開いた状態（`press n to add notes` が入力欄に置き換わる）。 */
const PREVIEW_DIALOG_NOTES_OPEN = PREVIEW_DIALOG
  .replace("Notes: press n to add notes", "Notes: Add notes on this design…");

test("isPreviewQuestionFrame: preview レイアウトだけを検知する", () => {
  expect(isPreviewQuestionFrame(PREVIEW_DIALOG)).toBe(true);
  // 従来レイアウトは Other 行（Type something.）を持つので対象外。
  expect(isPreviewQuestionFrame(QUESTION_DIALOG)).toBe(false);
  // 設問ダイアログですらないフレーム。
  expect(isPreviewQuestionFrame("")).toBe(false);
});

test("preview レイアウトは数字キーで確定しないので、行番号 → Enter を注入する", async () => {
  // 実測（2.1.267）: preview 付き単一選択の数字キーはカーソル移動のみ。
  const { keys, backend } = stubBackend([PREVIEW_DIALOG, ""]);
  await expect(
    injectQuestionAnswers(SINGLE_ANSWER, "work", backend),
  ).resolves.toBeUndefined();
  expect(keys).toEqual([["1"], ["Enter"]]);
});

test("preview レイアウトの 10 番目以降は ↓ でカーソルを寄せてから Enter で確定する", async () => {
  const { keys, backend } = stubBackend([PREVIEW_DIALOG, ""]);
  await expect(
    injectQuestionAnswers(
      [{ questionIndex: 0, selectedOptionIndexes: [9], multiSelect: false }], "work", backend,
    ),
  ).resolves.toBeUndefined();
  expect(keys).toEqual([...Array(9).fill(["Down"]), ["Enter"]]);
});

test("preview レイアウトの otherText は Notes 欄（n）へ書いて確定する", async () => {
  // Other 行が無い代わりに、TUI は Notes 欄で自由記述を受ける（回答は "(notes only)"）。
  const { keys, backend } = stubBackend([PREVIEW_DIALOG, PREVIEW_DIALOG_NOTES_OPEN, ""]);
  await expect(
    injectQuestionAnswers(
      [{ questionIndex: 0, selectedOptionIndexes: [3], otherText: "自分で書く", multiSelect: false }],
      "work", backend,
    ),
  ).resolves.toBeUndefined();
  expect(keys).toEqual([["n"], ["自分で書く"], ["Enter"]]);
});

test("pane を読めないときも本文を打たない（fail closed）", async () => {
  // 読取失敗を「開いたかも」と扱うと、本文中の数字がカーソル移動として食われて誤確定する。
  const keys: string[][] = [];
  const backend = {
    sendKeys: async (_session: string, sent: string[]) => { keys.push(sent); },
    sendTextSubmit: async () => {},
    capturePane: (() => {
      let call = 0;
      return async () => {
        call += 1;
        // 1 回目（レイアウト判定）は preview フレーム、2 回目（Notes 確認）は読取失敗。
        if (call === 1) return PREVIEW_DIALOG;
        throw new Error("pane not found");
      };
    })(),
  } as unknown as SessionBackend;
  await expect(
    injectQuestionAnswers(
      [{ questionIndex: 0, selectedOptionIndexes: [3], otherText: "2 倍にする", multiSelect: false }],
      "work", backend,
    ),
  ).rejects.toThrow("notes field did not open");
  expect(keys).toEqual([["n"]]);
});

test("Notes 欄が開かなければ本文を打たずに失敗させる（誤確定を防ぐ）", async () => {
  // 本文中の数字がカーソル移動として食われ、Enter で別の選択肢を確定してしまうため。
  const { keys, backend } = stubBackend([PREVIEW_DIALOG]);
  await expect(
    injectQuestionAnswers(
      [{ questionIndex: 0, selectedOptionIndexes: [3], otherText: "2 倍にする", multiSelect: false }],
      "work", backend,
    ),
  ).rejects.toThrow("notes field did not open");
  expect(keys).toEqual([["n"]]);
});

test("注入後にダイアログが消えていれば正常完了する", async () => {
  const { keys, backend } = stubBackend([""]);
  await expect(
    injectQuestionAnswers(SINGLE_ANSWER, "work", backend),
  ).resolves.toBeUndefined();
  expect(keys).toEqual([["1"]]);
});

test("単一選択の Other は生キーで本文→Enter を注入する（sendTextSubmit を経由しない）", async () => {
  // sendTextSubmit は選択ダイアログ残存 → Esc の防御を持ち、設問ダイアログ自体を
  // 誤認して却下（Request interrupted）するため、Other 経路では使わない。
  const { keys, backend } = stubBackend([""]);
  let textSubmitCalls = 0;
  (backend as { sendTextSubmit: () => Promise<void> }).sendTextSubmit = async () => {
    textSubmitCalls += 1;
  };
  await expect(
    injectQuestionAnswers(
      [{ questionIndex: 0, selectedOptionIndexes: [2], otherText: "rsync で移行する", multiSelect: false }],
      "work", backend,
    ),
  ).resolves.toBeUndefined();
  expect(keys).toEqual([["3"], ["rsync で移行する"], ["Enter"]]);
  expect(textSubmitCalls).toBe(0);
});

test("注入後もダイアログが残っていれば throw する（hub が pending 復元へ進む）", async () => {
  const { backend } = stubBackend([QUESTION_DIALOG]);
  await expect(
    injectQuestionAnswers(SINGLE_ANSWER, "work", backend),
  ).rejects.toThrow("still visible");
}, 15_000);

test("1回目残存でも再検証で消えていれば正常完了する（再描画の過渡フレーム耐性）", async () => {
  const { backend } = stubBackend([QUESTION_DIALOG, ""]);
  await expect(
    injectQuestionAnswers(SINGLE_ANSWER, "work", backend),
  ).resolves.toBeUndefined();
}, 15_000);

test("pane 読取失敗は検証不能として正常完了扱いにする（誤復元しない）", async () => {
  const keys: string[][] = [];
  const backend = {
    sendKeys: async (_session: string, sent: string[]) => { keys.push(sent); },
    sendTextSubmit: async () => {},
    capturePane: async () => { throw new Error("pane not found"); },
  } as unknown as SessionBackend;
  await expect(
    injectQuestionAnswers(SINGLE_ANSWER, "work", backend),
  ).resolves.toBeUndefined();
});
