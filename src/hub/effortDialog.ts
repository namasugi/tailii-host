// hub/effortDialog.ts — `/effort <level>` / `/model <slug>` 送出後の確認ダイアログ自動承認
//
// claude TUI は会話途中の `/effort <level>` に対して確認ダイアログを出す
// （`Change effort level?` / `❯ 1. Yes, switch to <level>` / `2. No, go back`。2.1.234 で実測）。
// Enter で 1 番（切替）が確定する。アプリの工数バッジから送った変更はユーザーの明示操作なので、
// ダイアログが見えたら Enter で承認して切替を完了させる（承認しないと effort は変わらず、
// バッジだけ楽観表示のまま実体と食い違う）。ダイアログが出なければ（初回=キャッシュ無し等）
// 何もしない。
//
// `/model <slug>` も同型のダイアログが挟まる（`Switch model?` / `❯ 1. Yes, switch to <model>` /
// `2. No, go back`。2.1.263 同梱文言で確認。キャッシュ済み会話・PreModelSwitch hook・
// 低速モデルへの切替で出る）。iOS は tmux backend では pane_preview 検知で入力 PTY へ `1` を
// 書いて自動 Yes するが、herdr backend では入力 PTY が claude へ届かない（attach 失敗後の
// 生シェルに吸われる）。hub 注入（chat_send → sendTextSubmit）の直後にここで承認し、
// 「モデルを変更したのに反映されない」を塞ぐ（model-switch-dialog, 2026-09-06 実障害）。
// 番号キー `1` は Enter 不要で即確定し、カーソル既定位置にも依存しない。万一 `1` が
// カーソル移動だけに留まった場合に備え、静定後もダイアログが残っていれば Enter を 1 回だけ送る
// （ダイアログが閉じていれば送らない: 空入力欄への Enter はプロンプト提案を送信し得るため）。

import { sleep } from "../shared/sleep.js";

/** アプリの工数バッジが送る `/effort <level>`（既知 5 値）。 */
export const EFFORT_COMMAND_PATTERN = /^\/effort\s+(low|medium|high|xhigh|max)\s*$/;

/**
 * アプリのモデル選択 / 入力欄が送る `/model <slug>`（引数付きのみ）。
 * 引数なしの `/model` は TUI のモデルピッカーを開く通常操作で、確認ダイアログの対象ではない。
 */
export const MODEL_COMMAND_PATTERN = /^\/model\s+\S+\s*$/;

/** 確認ダイアログの見出し（TUI 文言。effort=2.1.234 / model=2.1.263）。 */
const EFFORT_DIALOG_TITLE = "Change effort level?";
const MODEL_DIALOG_TITLE = "Switch model?";

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

export interface ConfirmModelDialogOptions extends ConfirmEffortDialogOptions {
  /** `1` 送出後、ダイアログが閉じたかを再確認するまでの静定待ち ms（既定 400）。 */
  settleMs?: number;
}

interface ConfirmDialogSpec {
  title: string;
  /** ダイアログ検知時に送るキー。 */
  keys: string[];
  literal: boolean;
  label: string;
  /** 送出後にダイアログ残存を再確認し、残っていれば Enter で確定する（`1` の保険）。 */
  settleMs: number | null;
}

async function captureScreen(backend: EffortDialogBackend, session: string): Promise<string> {
  try {
    return await backend.capturePane(session, { lines: 30 });
  } catch {
    return "";
  }
}

async function confirmDialog(
  backend: EffortDialogBackend,
  session: string,
  spec: ConfirmDialogSpec,
  options: ConfirmEffortDialogOptions,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const screen = await captureScreen(backend, session);
    if (screen.includes(spec.title)) {
      await backend.sendKeys(session, spec.keys, spec.literal);
      options.log?.(`${spec.label} dialog 承認 session=${session}`);
      if (spec.settleMs !== null) {
        await sleep(spec.settleMs);
        // ダイアログが残っていれば（番号キーがカーソル移動だけだった等）Enter で確定する。
        // 閉じていれば何も送らない（入力欄への Enter は提案送信・空 submit の副作用があるため）。
        if ((await captureScreen(backend, session)).includes(spec.title)) {
          await backend.sendKeys(session, ["Enter"]);
          options.log?.(`${spec.label} dialog Enter で再確定 session=${session}`);
        }
      }
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
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
  return confirmDialog(
    backend,
    session,
    { title: EFFORT_DIALOG_TITLE, keys: ["Enter"], literal: false, label: "effort", settleMs: null },
    options,
  );
}

/**
 * `/model <slug>` の確認ダイアログ（`Switch model?`）が表示されたら `1`（Yes, switch to …）で
 * 承認する。静定後も残っていれば Enter で確定する。
 * @returns 承認を送ったら true（ダイアログ未出現・capture 失敗は false）。
 */
export async function confirmModelSwitchDialog(
  backend: EffortDialogBackend,
  session: string,
  options: ConfirmModelDialogOptions = {},
): Promise<boolean> {
  return confirmDialog(
    backend,
    session,
    {
      title: MODEL_DIALOG_TITLE,
      keys: ["1"],
      literal: true,
      label: "model",
      settleMs: options.settleMs ?? 400,
    },
    options,
  );
}
