// questionInjection.ts
// tailii (TS host) — AskUserQuestion の回答を Claude TUI へ注入する。

import type { QuestionAnswer } from "./protocol.js";
import { sleep } from "./sleep.js";
import type { SessionBackend } from "./sessionBackend.js";

const KEY_STEP_MS = 150;

/**
 * question_answer → Claude AskUserQuestion TUI のキー操作。
 * 各キー間の待機は、Ink の再描画中に連続入力が欠落するのを避けるために設ける。
 * - 単一選択 = 数字キーで即確定。Other は行番号 → literal 入力 → Enter。
 * - multiSelect = 数字キーは無反応。カーソル（先頭 index 0 から開始）を ↓ で対象行へ移動し
 *   Space でトグル → Right でレビュー → 最終問後に「1」Submit answers。
 *   Other 行は Space でチェック＆入力欄化 → literal 入力 → ↑ でテキスト欄を抜けてから Right。
 * - Other の synthetic index（= options.count）は選択肢中で最大の index になるため、
 *   otherText があるときは最大 index を Other 行とみなす。
 */
export async function injectQuestionAnswers(
  answers: QuestionAnswer[], session: string, sessionManager: SessionBackend,
): Promise<void> {
  const sorted = answers.slice().sort((a, b) => a.questionIndex - b.questionIndex);
  // 2 問以上では、最後の設問が単一選択でも回答レビュー画面を経由する。
  // 単一選択の数字キーは「その設問を確定」するだけで、AskUserQuestion 全体の
  // Submit answers までは行わない。1 問だけの単一選択のみ即時完了する。
  const needsReviewSubmit = sorted.length > 1 || sorted.some((answer) => answer.multiSelect);
  for (const answer of sorted) {
    const other = (answer.otherText ?? "").trim();
    let indexes = answer.selectedOptionIndexes.filter((i) => i >= 0).sort((a, b) => a - b);
    // otherText があるとき、最大 index は Other（Type something.）行。
    let otherIndex: number | null = null;
    if (other.length > 0 && indexes.length > 0) {
      otherIndex = indexes[indexes.length - 1]!;
      indexes = indexes.slice(0, -1);
    }
    if (answer.multiSelect) {
      // multiSelect は数字キーではトグルできない（実 TUI）。カーソルを ↓ で移動し Space でトグルする。
      // カーソルは先頭（index 0）から開始。indexes / otherIndex は昇順なので下方向のみで足りる。
      let cursor = 0;
      const moveTo = async (target: number): Promise<void> => {
        for (let n = cursor; n < target; n += 1) {
          await sessionManager.sendKeys(session, ["Down"]);
          await sleep(KEY_STEP_MS);
        }
        cursor = target;
      };
      for (const idx of indexes) {
        await moveTo(idx);
        await sessionManager.sendKeys(session, ["Space"]);
        await sleep(KEY_STEP_MS);
      }
      if (otherIndex !== null) {
        await moveTo(otherIndex);
        // Other 行を Space でチェックすると同時に入力欄がフォーカスされる。
        await sessionManager.sendKeys(session, ["Space"]);
        await sleep(KEY_STEP_MS);
        await sessionManager.sendKeys(session, [other], true);
        await sleep(KEY_STEP_MS);
        // テキスト欄にいると Right がタブ移動に効かないため、↑ で通常行へ退避してから進む。
        await sessionManager.sendKeys(session, ["Up"]);
        await sleep(KEY_STEP_MS);
        cursor = otherIndex - 1;
      }
      // レビュー（最終問）または次の質問タブへ進む。
      await sessionManager.sendKeys(session, ["Right"]);
    } else if (otherIndex !== null) {
      await sessionManager.sendKeys(session, [String(otherIndex + 1)]);
      // 本文+確定は 1 操作（herdr は分割すると CR が飲まれる。sendTextSubmit に集約）。
      await sessionManager.sendTextSubmit(session, other);
    } else if (indexes.length > 0) {
      // 数字キーで即確定（Enter は送らない）。
      await sessionManager.sendKeys(session, [String(indexes[0]! + 1)]);
    }
    // TUI の再描画/タブ送りを待つ（連続注入の取りこぼし防止）。
    await sleep(200);
  }
  if (needsReviewSubmit) {
    // 複数設問または複数選択では、最後に必ず回答レビュー画面を経由する。
    // 「Ready to submit your answers?」で 1. Submit answers を確定する。
    await sessionManager.sendKeys(session, ["1"]);
  }
}
