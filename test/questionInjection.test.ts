// questionInjection.test.ts
// AskUserQuestion 回答注入の検証（ダイアログ残存の検知と自己修復トリガ）。

import { expect, test } from "vitest";
import { injectQuestionAnswers, isQuestionDialogFrame } from "../src/hub/questionInjection.js";
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

const QUESTION_DIALOG = [
  "←  ☐ 表示位置  ☐ 更新  ✔ Submit  →",
  "",
  "会話一覧のどこに出しますか？",
  "",
  "❯ 1. ヘッダーに常設ピル",
  "  2. 一覧最上部のカード",
  "",
  "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
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
