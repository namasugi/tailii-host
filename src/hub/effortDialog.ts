// hub/effortDialog.ts — `/effort <level>` 送出後の確認ダイアログ自動承認
//
// claude TUI は会話途中の `/effort <level>` に対して確認ダイアログを出す
// （`Change effort level?` / `❯ 1. Yes, switch to <level>` / `2. No, go back`。2.1.234 で実測）。
// Enter で 1 番（切替）が確定する。アプリの工数バッジから送った変更はユーザーの明示操作なので、
// ダイアログが見えたら Enter で承認して切替を完了させる（承認しないと effort は変わらず、
// バッジだけ楽観表示のまま実体と食い違う）。ダイアログが出なければ（初回=キャッシュ無し等）
// 何もしない。

import { sleep } from "../shared/sleep.js";

/** アプリの工数バッジが送る `/effort <level>`（既知 5 値）。 */
export const EFFORT_COMMAND_PATTERN = /^\/effort\s+(low|medium|high|xhigh|max)\s*$/;

/** 確認ダイアログの見出し（TUI 文言。2.1.234）。 */
const DIALOG_TITLE = "Change effort level?";

export interface EffortDialogBackend {
  capturePane(name: string, options?: { lines?: number }): Promise<string>;
  sendKeys(name: string, keys: string[], literal?: boolean): Promise<void>;
}

export interface ConfirmEffortDialogOptions {
  /** ダイアログ出現を待つ上限 ms（既定 4000）。 */
  timeoutMs?: number;
  /** ポーリング間隔 ms（既定 250）。 */
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

/**
 * `/effort` の確認ダイアログが表示されたら Enter で承認する。
 * @returns 承認を送ったら true（ダイアログ未出現・capture 失敗は false）。
 */
export async function confirmEffortChangeDialog(
  backend: EffortDialogBackend,
  session: string,
  options: ConfirmEffortDialogOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let screen = "";
    try {
      screen = await backend.capturePane(session, { lines: 30 });
    } catch {
      screen = "";
    }
    if (screen.includes(DIALOG_TITLE)) {
      await backend.sendKeys(session, ["Enter"]);
      options.log?.(`effort dialog 承認 session=${session}`);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}
