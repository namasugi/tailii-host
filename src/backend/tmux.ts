// tmux.ts
// tailii (TS host) — tmux セッションの list / reattach / kill / send-keys / capture-pane
// Swift 版 TmuxSessionManager.swift の移植。
// 生存集合は `tmux ls -F '#{session_name}'`、cwd は SessionMetadataStore を権威とする。

import { execFile } from "node:child_process";
import { PROTOCOL_V1, type ControlMessage, type SessionInfo } from "../protocol.js";
import { SessionMetadataStore, validateSessionName } from "../sessions/sessionMetadataStore.js";

/** tmux コマンド 1 回分の実行結果。 */
export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** tmux コマンド実行の注入可能な抽象（テストはモックを注入する）。 */
export type TmuxCommandRunner = (args: string[]) => Promise<TmuxCommandResult>;

/** tmux 実行ファイルの既定絶対パス（PATH 外のため絶対指定）。 */
export const DEFAULT_TMUX_PATH = "/opt/homebrew/bin/tmux";

/** pane_current_command がこの集合なら、Claude 本体は終了してシェルだけが残っている。 */
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "dash", "fish", "tcsh", "csh", "ksh", "login"]);

/** tmux の pane_current_command がエージェント実行中に見えるか。空文字は判定不能なので安全側。 */
export function paneCommandLooksLikeAgent(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized.length === 0 || !SHELL_COMMANDS.has(normalized);
}

export interface CapturePaneOptions {
  /** 取得する末尾行数。未指定なら manager 既定値。 */
  lines?: number;
  /** 折り返し行を結合する（tmux capture-pane -J）。 */
  joinWrappedLines?: boolean;
}

/**
 * claude TUI 入力欄の先頭に付くモード記号。
 * - `❯`(276F) / `›`(203A): 通常入力
 * - `!`: シェルモード（空入力の先頭 `!` が記号として吸われ、本文には残らない）
 *
 * 実測 2.1.220: `#` はモード記号ではなく本文の一部（`❯ #メモ` と描画される）。
 */
const INPUT_PROMPT_SIGILS = ["❯", "›", "!"] as const;

/** claude TUI 入力欄の状態（プロンプト記号と未送信本文）。 */
export interface ClaudeInputBox {
  /** 先頭のモード記号。記号なしで本文だけの行なら空文字。 */
  prompt: string;
  /** 未送信本文（記号と前後空白を除いたもの）。空なら入力欄は空。 */
  text: string;
}

/** 入力欄がシェルモード（プロンプトが `!`）か。 */
export function inputBoxIsShellMode(box: ClaudeInputBox | null): boolean {
  return box?.prompt === "!";
}

/** 行が入力欄の水平罫線（`────…`）か。名前付き会話は上罫線中央にタイトルが埋まる。 */
function isInputBoxRuleLine(line: string): boolean {
  const scalars = [...line];
  if (scalars.length < 3) return false;
  let leading = 0;
  for (const ch of scalars) {
    if (ch === "─" || ch === "━") leading += 1;
    else break;
  }
  if (leading === scalars.length) return true;
  if (leading < 3) return false;
  let trailing = 0;
  for (const ch of [...scalars].reverse()) {
    if (ch === "─" || ch === "━") trailing += 1;
    else break;
  }
  return trailing >= 2;
}

/**
 * 画面から claude TUI の入力欄を取り出す（TESTABLE）。
 *
 * 入力欄は末尾側の 2 本の水平罫線に挟まれた領域。`❯` 行だけを探す旧実装は
 * シェルモード（プロンプトが `!` になる）で入力欄を見失い、注入検証が必ず失敗
 * → 本文を 3 回重ね打ちして入力欄を壊し、送信失敗として throw していた
 * （実障害 2026-08-03: `!` 始まりの送信が HerdrFailedError）。
 * 罫線が見つからない画面は最後の `❯` 行 **1 行だけ**へフォールバックする
 * （旧 `inputBoxHasPendingText` と同じ判定なので退行しない）。
 * 判定不能は null（呼び出し側は fail-open 材料として扱う）。
 *
 * **前提**: 選択ダイアログ表示中は本文側の罫線ペア（`──── Planning: … ────` 等）を
 * 入力欄と誤認しうる。注入前にダイアログを閉じるのは呼び出し側の責務
 * （`sendTextSubmit` が `selectionDialogVisible` → Esc で担保）。
 */
export function extractClaudeInputBox(screen: string): ClaudeInputBox | null {
  const lines = screen.split("\n").map((line) => line.trim());
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine(lines[index] ?? "")) {
      bottom = index;
      break;
    }
  }
  let top = -1;
  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine(lines[index] ?? "")) {
      top = index;
      break;
    }
  }
  if (top >= 0 && bottom > top) return splitInputPrompt(lines.slice(top + 1, bottom));
  // 罫線が無い画面は最後の `❯` 行 1 行だけを入力欄とみなす（下の行まで含めると
  // フッターを未送信テキストと誤認して送信確定ループが終わらない）。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").startsWith("❯")) return splitInputPrompt([lines[index] ?? ""]);
  }
  return null;
}

/**
 * 入力が空のとき claude TUI が入力欄へ薄字で出すプレースホルダ（実測 2.1.220）。
 * 未送信テキストと誤認すると、シェルモード離脱（空入力の Backspace）に入れず
 * 通常メッセージがシェルコマンドとして実行される（実機フレーム 2026-08-03）。
 *
 * 割り切り: 薄字かどうかは capture では判別できないため文言一致で判定する。
 * ユーザーが偶然この文言だけを打つと「空」と誤判定するが、その場合の実害は
 * 残留 flush の Enter が飛ばないこと（次の注入で本文が連結される）に留まる。
 */
function isInputPlaceholder(text: string): boolean {
  if (text === "Press up to edit queued messages") return true;
  if (text.startsWith('Try "') && text.endsWith('"')) return true;
  return text.startsWith("Message @") && text.endsWith("…");
}

/** SGR カラー/属性エスケープ（`ESC[…m`）を除いた素のテキスト。 */
function stripSgr(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, "");
}

/**
 * claude TUI の「プロンプト提案」（2.1.25x 頃〜。空の入力欄に薄字で次の一手を提示し、
 * → / Tab で採用、Enter で即送信される）と空入力プレースホルダーは、いずれも通常の
 * 未送信テキストと**同じ入力欄位置**に描画される。`--format text`（SGR 除去済み）では
 * 本文と区別できないため、注入の残留 flush 判定・送信確定ループがこれらを実テキストと
 * 誤認し、Enter で提案をそのまま送信してしまう（実障害 2026-09-03: iPhone 送信のたびに
 * AI の提案文が勝手に送られ、送信が壊れる）。
 *
 * 決定的シグナル: 提案もプレースホルダーも本文が SGR 2（faint/薄字）で描画される。
 * 利用者入力・中断時の queued 書き戻しは faint ではない（実測 herdr `pane read --format
 * ansi` 2026-09-03: 提案は 本文が ESC[2m 包み、実テキストは faint 無し）。
 *
 * ANSI 画面から入力欄本文を切り出し、本文の可視文字がすべて faint なら「実テキスト無し」
 * とみなす（＝提案/プレースホルダー）。faint でない可視文字が 1 つでもあれば実テキスト有り。
 * 判定不能（罫線が見つからない・本文空）は false。
 */
export function inputBoxHasRealPendingText(ansiScreen: string): boolean {
  const rawLines = ansiScreen.split("\n").map((line) => line.replace(/\r$/, ""));
  const stripped = rawLines.map((line) => stripSgr(line).trim());

  // 罫線ペアで入力欄領域を特定する（extractClaudeInputBox と同じ規則を SGR 除去後の行へ）。
  let bottom = -1;
  for (let index = stripped.length - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine(stripped[index] ?? "")) {
      bottom = index;
      break;
    }
  }
  let top = -1;
  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine(stripped[index] ?? "")) {
      top = index;
      break;
    }
  }
  let bodyRaw: string[];
  if (top >= 0 && bottom > top) {
    bodyRaw = rawLines.slice(top + 1, bottom);
  } else {
    // 罫線が無い画面は最後の `❯` 行 1 行だけを入力欄とみなす（extractClaudeInputBox と同型）。
    let sigilIndex = -1;
    for (let index = stripped.length - 1; index >= 0; index -= 1) {
      if ((stripped[index] ?? "").startsWith("❯")) {
        sigilIndex = index;
        break;
      }
    }
    if (sigilIndex < 0) return false;
    bodyRaw = [rawLines[sigilIndex] ?? ""];
  }

  // プレースホルダー（文言一致）は faint 検出の前に空扱いする（後方互換・二重の安全網）。
  const box = extractClaudeInputBox(stripped.join("\n"));
  if (box === null || box.text.length === 0) return false;

  return !bodyIsFaintOnly(bodyRaw);
}

/**
 * 入力欄本文（ANSI 付き raw 行）の可視文字がすべて faint（SGR 2）か。
 * SGR 状態を文字送りで追い（0 = 全リセット / 2 = faint on / 22 = faint off）、
 * 空白・モード記号（`❯ › !`）以外の可視文字だけを評価する。可視文字が 1 つも無ければ false。
 */
function bodyIsFaintOnly(bodyRaw: string[]): boolean {
  const ESC = "";
  const NBSP = " ";
  let faint = false;
  let sawPrintable = false;
  let allFaint = true;
  for (const line of bodyRaw) {
    let index = 0;
    while (index < line.length) {
      if (line[index] === ESC && line[index + 1] === "[") {
        // eslint-disable-next-line no-control-regex
        const match = /^\[([0-9;]*)m/.exec(line.slice(index));
        if (match) {
          const params = match[1] ?? "";
          const codes = params === "" ? [0] : params.split(";").map((code) => Number(code));
          // SGR を左から評価する。38/48（前景/背景色）は 2;r;g;b または 5;n の
          // サブパラメータを従えるため、その分を読み飛ばす（`38;2;255;255;255` の `2` を
          // faint(SGR 2) と誤認しない — この取り違えが色付き実テキストの誤判定原因だった）。
          for (let cursor = 0; cursor < codes.length; cursor += 1) {
            const code = codes[cursor];
            if (code === 38 || code === 48) {
              const mode = codes[cursor + 1];
              cursor += mode === 2 ? 4 : mode === 5 ? 2 : 1;
              continue;
            }
            if (code === 0 || code === 22) faint = false;
            else if (code === 2) faint = true;
          }
          index += match[0].length;
          continue;
        }
      }
      const ch = line[index] ?? "";
      // 空白・NBSP・モード記号は本文の可視性判定から除外する（記号の色は faint とは限らない）。
      if (
        ch !== " " &&
        ch !== NBSP &&
        ch !== "\t" &&
        ch !== "❯" &&
        ch !== "›" &&
        ch !== "!"
      ) {
        sawPrintable = true;
        if (!faint) allFaint = false;
      }
      index += 1;
    }
  }
  return sawPrintable && allFaint;
}

/**
 * `/login` の OAuth コード入力待ち行（実測 claude 2.1.241: `Paste code here if prompted >`）。
 * ブラウザで取得したコードを貼る唯一の入力面で、通常の入力欄（罫線ペア）は描画されない。
 */
export const LOGIN_CODE_PROMPT_MARKER = "Paste code here if prompted";

/**
 * `/login` でコード送信が失敗した後の再試行待ち行（実測 2.1.241:
 * `OAuth error: Request failed with status code 400` の下に `Press Enter to retry.`）。
 */
export const LOGIN_RETRY_MARKER = "Press Enter to retry";

/** `/login` 方式選択（`Select login method:`）のタイトル行（実測 2.1.241。フッターは `Esc to cancel` のみ）。 */
export const LOGIN_METHOD_MARKER = "Select login method";

/**
 * 成功後の継続待ち画面（CLI 2.1.241 の文字列 `Login successful. Press Enter to continue…`。
 * 入力欄は無く、Enter / Esc で閉じて通常の入力欄へ戻る）。
 * 2026-08-25 実障害: この画面を知らず「交換中」として 10s 待って失敗を返し、利用者がキャンセル
 * （Esc）すると閉じてログイン済みになる、という逆転が起きた。
 */
export const LOGIN_CONTINUE_MARKER = "to continue";

/** ダイアログ行が pane 末尾（最後の非空行）からこの行数以内にあるときだけ「生きている」とみなす。 */
const LOGIN_TAIL_WINDOW = 12;

/**
 * `marker` で始まる行が、生きたダイアログとして画面にあるか（TESTABLE 内部）。
 * 会話本文が同じ文言を行頭に含むだけ（Ink の折り返し・/login の説明文）で発火しないよう、
 * (a) 末尾 LOGIN_TAIL_WINDOW 行以内 (b) 直下 `footerReach` 行以内に `Esc to cancel` フッター、
 * の 2 条件を課す（iOS 側 ClaudeLoginPromptParser.isLiveDialogLine と同じ規則）。
 */
function liveDialogLineIndex(lines: string[], marker: string, footerReach: number): number | null {
  let lastContent = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim().length > 0) {
      lastContent = index;
      break;
    }
  }
  if (lastContent < 0) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!(lines[index] ?? "").trim().startsWith(marker)) continue;
    if (lastContent - index > LOGIN_TAIL_WINDOW) return null;
    const end = Math.min(lines.length, index + 1 + footerReach);
    for (let below = index + 1; below < end; below += 1) {
      if ((lines[below] ?? "").trim().toLowerCase().startsWith("esc to cancel")) return index;
    }
    return null;
  }
  return null;
}

/** 画面が `/login` のコード入力待ちか（TESTABLE）。chat 注入の門番と login_code_send の前提確認に使う。 */
export function screenHasLoginCodePrompt(screen: string): boolean {
  return liveDialogLineIndex(screen.split("\n"), LOGIN_CODE_PROMPT_MARKER, 3) !== null;
}

function screenHasLoginRetry(screen: string): boolean {
  return liveDialogLineIndex(screen.split("\n"), LOGIN_RETRY_MARKER, 3) !== null;
}

function screenHasLoginMethodSelect(screen: string): boolean {
  // タイトル行と Esc フッターの間に選択肢（最大 3 行 + 空行）が入る。
  return liveDialogLineIndex(screen.split("\n"), LOGIN_METHOD_MARKER, 8) !== null;
}

/** 成功後の継続待ち（`Login successful. Press Enter to continue…`）が pane 末尾付近にあるか。 */
export function screenHasLoginContinue(screen: string): boolean {
  const lines = screen.split("\n");
  let lastContent = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim().length > 0) {
      lastContent = index;
      break;
    }
  }
  if (lastContent < 0) return false;
  for (let index = lastContent; index >= Math.max(0, lastContent - LOGIN_TAIL_WINDOW); index -= 1) {
    const text = (lines[index] ?? "").trim().toLowerCase();
    if (text.includes("login successful") && text.includes(LOGIN_CONTINUE_MARKER)) return true;
    if (text.startsWith("press enter to continue")) return true;
  }
  return false;
}

/**
 * 画面が `/login` フローのどこか（方式選択 / コード入力待ち / 失敗後の再試行待ち）にいるか（TESTABLE）。
 * chat 注入の門番用。コード欄以外の 2 画面も、通常本文 + Enter が選択リストや retry を
 * 押してしまうため同じく拒否する。
 */
export function screenInLoginFlow(screen: string): boolean {
  return screenHasLoginCodePrompt(screen) || screenHasLoginRetry(screen)
    || screenHasLoginMethodSelect(screen) || screenHasLoginContinue(screen);
}

/**
 * コード送出後の画面の判定:
 * - `prompt`: コード欄がまだある（CR 取りこぼし or 交換前）
 * - `retry`: OAuth 拒否（`Press Enter to retry`）
 * - `method`: 方式選択へ戻った（Esc / retry を押した等。受理ではない）
 * - `continue`: 成功後の継続待ち（`Login successful. Press Enter to continue…`）— ログインは完了
 * - `accepted`: **陽性証拠**あり — 通常入力欄（罫線ペア）の復帰
 * - `pending`: どれでもない（交換中）。「コード欄が無い」だけでは受理にしない。
 */
export type LoginCodeScreenState = "prompt" | "retry" | "method" | "continue" | "accepted" | "pending";

export function loginCodeScreenState(screen: string): LoginCodeScreenState {
  if (screenHasLoginCodePrompt(screen)) return "prompt";
  if (screenHasLoginRetry(screen)) return "retry";
  if (screenHasLoginMethodSelect(screen)) return "method";
  if (screenHasLoginContinue(screen)) return "continue";
  const lines = screen.split("\n");
  const tail = lines.slice(-LOGIN_TAIL_WINDOW - 8);
  const rules = tail.filter((line) => isInputBoxRuleLine(line.trim())).length;
  if (rules >= 2) return "accepted";
  return "pending";
}

/**
 * retry 画面の理由行。`OAuth error` で始まる行（末尾窓内の最後のもの）だけを採用する。
 * 直上行フォールバックは持たない（コードをエコーしたコード欄の行が理由として result / ログへ
 * 漏れる）。念のためコード欄マーカーを含む行は採用しない。
 */
export function loginCodeErrorLine(screen: string): string | null {
  const lines = screen.split("\n").map((line) => line.trim());
  const tail = lines.slice(-LOGIN_TAIL_WINDOW - 8);
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const text = tail[index] ?? "";
    if (text.startsWith("OAuth error") && !text.includes(LOGIN_CODE_PROMPT_MARKER)) {
      return text.slice(0, 200);
    }
  }
  return null;
}

/**
 * login-code 経路の失敗（利用者へそのまま出せる文言だけを message に持つ）。
 * コード本文を含む生の backend エラー（tmux の args 等）を result / diag に流さないための型。
 * chat 注入の門番（1 キーも送る前の確定拒否）にも使う — hub はこの型を「未送出の失敗」として
 * uncertain（配送不明）に積まない。
 */
export class LoginCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginCodeError";
  }
}

/** login_code_send が拒否するメッセージ（コード入力待ちでない）。 */
export const LOGIN_CODE_PROMPT_NOT_VISIBLE =
  "Claude はログインコードの入力待ちではありません（/login を実行してから送ってください）";

/** retry 画面で login_code_send されたときの案内。 */
export const LOGIN_CODE_RETRY_PENDING =
  "Claude は再試行待ちです。「もう一度」を押してから、新しいコードを送ってください";

/** chat 注入が `/login` フロー中の画面を検出したときの拒否文言（hub が会話本文へそのまま出す）。 */
export const CHAT_BLOCKED_BY_LOGIN_PROMPT =
  "Claude が /login の途中です。転写カードから操作するか、キャンセルしてから送ってください";

/** コード送出は届いたが、待ってもコード欄が消えない（CR 取りこぼし・TUI 停止）。 */
export const LOGIN_CODE_NOT_ACCEPTED =
  "コードが Claude に受理されませんでした（もう一度送るか、Mac 側の画面を確認してください）";

/** コード本文がコード欄に反映されなかった（send-text 取りこぼし）。CR は撃たない。 */
export const LOGIN_CODE_NOT_ECHOED =
  "コードが入力欄に反映されませんでした（もう一度送ってください）";

/** 交換が長引き、受理も拒否も確定しなかった。 */
export const LOGIN_CODE_UNSETTLED =
  "ログインの結果を確認できませんでした（Mac 側の画面を確認してください）";

/** login_code_send の失敗を利用者向け文言へ写す（コード本文・内部 args を漏らさない）。 */
export function loginCodeErrorMessage(error: unknown): string {
  if (error instanceof LoginCodeError) return error.message;
  const name = error instanceof Error ? error.name : "Error";
  return `コードの送出に失敗しました（${name}）`;
}

/** backend 非依存の login-code 送出手順の注入点。 */
export interface LoginCodeSubmitOps {
  /** 画面（判定不能は null）。 */
  capture: () => Promise<string | null>;
  sendLiteral: (text: string) => Promise<void>;
  sendEnter: () => Promise<void>;
  /** 本文→CR の間隔（Ink の取り込み窓。実測 300ms 未満で CR が飲まれる）。 */
  delayMs: number;
  /** 画面ポーリング間隔。 */
  pollMs: number;
  /** CR 1 回あたり、コード欄が消えるのを待つ上限。交換中（pending）はこの 2 倍まで待つ。 */
  settleMs: number;
  now?: () => number;
}

/** コード欄に本文が反映されたか（入力は末尾 6 文字以外マスク表示される実測に合わせ、末尾で照合）。 */
export function loginCodeEchoed(screen: string, code: string): boolean {
  const lines = screen.split("\n");
  const index = liveDialogLineIndex(lines, LOGIN_CODE_PROMPT_MARKER, 3);
  if (index === null) return false;
  const probe = code.slice(-Math.min(6, code.length));
  return (lines[index] ?? "").includes(probe);
}

/**
 * `/login` のコードを送出し、結果を画面で確定させる（tmux / herdr 共通, TESTABLE）。
 * - 送出前にコード欄が無ければ何も送らず throw（retry 画面は専用の案内）
 * - 本文送出後、コード欄へのエコーを確認してから CR（反映していなければ CR を撃たず throw —
 *   切り詰めたコードを送ってワンタイムコードを焼かない）
 * - CR 後は `loginCodeScreenState` で待つ。retry / method は即 throw（余分な CR で retry を
 *   押さない）。accepted（陽性証拠）で受理。prompt が settleMs 残れば **再キャプチャして prompt
 *   のときだけ** CR を 1 回再送。pending は settleMs×2 まで待ち、確定しなければ throw。
 *   暗黙の ok は返さない。
 */
export async function submitLoginCode(code: string, ops: LoginCodeSubmitOps): Promise<void> {
  const now = ops.now ?? (() => Date.now());
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const initial = await ops.capture();
  const initialState = initial === null ? "pending" : loginCodeScreenState(initial);
  if (initialState === "retry") throw new LoginCodeError(LOGIN_CODE_RETRY_PENDING);
  if (initialState !== "prompt") throw new LoginCodeError(LOGIN_CODE_PROMPT_NOT_VISIBLE);

  await ops.sendLiteral(code);
  await sleep(ops.delayMs);
  let echoed = false;
  for (let attempt = 0; attempt < 2 && !echoed; attempt += 1) {
    if (attempt > 0) await sleep(ops.pollMs);
    const screen = await ops.capture();
    echoed = screen !== null && loginCodeEchoed(screen, code);
  }
  if (!echoed) throw new LoginCodeError(LOGIN_CODE_NOT_ECHOED);

  const start = now();
  const pendingDeadline = start + ops.settleMs * 2;
  let entersSent = 0;
  let continueEnters = 0;
  let state: LoginCodeScreenState = "prompt";
  while (true) {
    if (state === "prompt") {
      if (entersSent >= 2) throw new LoginCodeError(LOGIN_CODE_NOT_ACCEPTED);
      await ops.sendEnter();
      entersSent += 1;
    } else if (state === "continue") {
      // ログインは完了している。継続待ちを Enter で閉じて入力欄へ戻す（最大 2 回）。閉じられなくても
      // 失敗にはしない（iOS 側は成功画面を「続ける」カードとして転写できる）。
      if (continueEnters >= 2) return;
      await ops.sendEnter();
      continueEnters += 1;
    }
    const attemptDeadline = now() + ops.settleMs;
    for (;;) {
      await sleep(ops.pollMs);
      const screen = await ops.capture();
      state = screen === null ? "pending" : loginCodeScreenState(screen);
      if (state === "retry") {
        const reason = screen === null ? null : loginCodeErrorLine(screen);
        throw new LoginCodeError(
          `コードが拒否されました${reason !== null ? `（${reason}）` : ""}。もう一度サインインしてください`,
        );
      }
      if (state === "method") {
        throw new LoginCodeError("ログインが中断され、方式選択に戻りました。/login をやり直してください");
      }
      if (state === "accepted") return;
      if (state === "continue") break;
      if (state === "prompt" && now() >= attemptDeadline) break;
      if (state === "pending" && now() >= pendingDeadline) {
        // 継続待ちを閉じた後の描画遅延なら成功として扱う（継続画面を一度でも見ている）。
        if (continueEnters > 0) return;
        throw new LoginCodeError(LOGIN_CODE_UNSETTLED);
      }
    }
  }
}

/** 入力欄の行群を「モード記号 + 本文」へ分解する。 */
function splitInputPrompt(bodyLines: string[]): ClaudeInputBox {
  const body = [...bodyLines];
  const first = body[0] ?? "";
  const sigil = INPUT_PROMPT_SIGILS.find((s) => first.startsWith(s));
  if (sigil !== undefined) body[0] = first.slice(sigil.length);
  const text = body.join("\n").trim();
  return { prompt: sigil ?? "", text: isInputPlaceholder(text) ? "" : text };
}

/**
 * 発行するのは ls / capture-pane / send-keys / kill-session など即応するコマンドだけで、
 * 正当に長引くものは無い。無期限に待つと、これを直列 await する engine の read loop
 * （以後の全メッセージを読まなくなる）と hub の tick ループが同時に止まるため、
 * 上限を切って「失敗」として返す（`gitService` の execFile と同じ規約）。
 */
const TMUX_TIMEOUT_MS = 15_000;

/** 実 tmux を絶対パスで起動する既定ランナー。tmux 非0 exit は throw せず結果で表現する。 */
export function processTmuxCommandRunner(
  tmuxPath: string = DEFAULT_TMUX_PATH,
  timeoutMs: number = TMUX_TIMEOUT_MS,
): TmuxCommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(tmuxPath, args, {
        maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs,
      }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // 実行ファイル起動自体の失敗（ENOENT 等）のみ throw（Swift 版と同じ境界）。
          reject(error);
          return;
        }
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

/** TmuxSessionManager が投げる型付きエラー。 */
export class TmuxFailedError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr}`);
    this.name = "TmuxFailedError";
  }
}

/** reattach の型付き結果。 */
export type ReattachResult =
  | { kind: "attached"; info: SessionInfo; recentOutput: string }
  | { kind: "notFound"; error: ControlMessage };

/** tmux セッションの list / reattach / kill とメタデータ統合。 */
export class TmuxSessionManager {
  private readonly runner: TmuxCommandRunner;
  readonly store: SessionMetadataStore;
  private readonly captureLines: number;
  /** login-code 送出の待ち時間（テスト注入用）。 */
  private readonly loginTiming: { delayMs: number; pollMs: number; settleMs: number };
  private readonly protocolVersion: number;

  constructor(options: {
    runner?: TmuxCommandRunner;
    store?: SessionMetadataStore;
    captureLines?: number;
    protocolVersion?: number;
    loginTiming?: { delayMs?: number; pollMs?: number; settleMs?: number };
  } = {}) {
    this.runner = options.runner ?? processTmuxCommandRunner();
    this.store = options.store ?? new SessionMetadataStore();
    this.captureLines = options.captureLines ?? 50;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_V1;
    this.loginTiming = {
      delayMs: options.loginTiming?.delayMs ?? 150,
      pollMs: options.loginTiming?.pollMs ?? 250,
      settleMs: options.loginTiming?.settleMs ?? 5_000,
    };
  }

  /**
   * 現存する各セッションを name/cwd/alive で列挙する（name 昇順、メタのみは alive:false）。
   * updatedAt はここでは付与しない。tmux `#{session_activity}` はセッション作成自体を「活動」
   * として刻むため、会話ゼロの新規セッションが実会話より上に浮く。整列時刻の権威は
   * SessionActivityProvider（セッション自身の transcript mtime）に一本化する。
   */
  async list(): Promise<SessionInfo[]> {
    const alive = await this.liveSessionNames();
    // herdr backend のメタは HerdrSessionManager が列挙する（Composite で和を取る）。
    const metas = this.store.all().filter((meta) => meta.backend !== "herdr");

    const cwdByName = new Map<string, string>();
    const claudeSessionIdByName = new Map<string, string>();
    const providerSessionIdByName = new Map<string, string>();
    const agentByName = new Map<string, "claude" | "codex">();
    for (const meta of metas) {
      cwdByName.set(meta.name, meta.cwd);
      if (meta.claudeSessionId !== undefined) claudeSessionIdByName.set(meta.name, meta.claudeSessionId);
      const agent = meta.agent ?? "claude";
      if (meta.agent !== undefined) agentByName.set(meta.name, meta.agent);
      const providerSessionId = meta.providerSessionId ?? (agent === "claude" ? meta.claudeSessionId : undefined);
      if (providerSessionId !== undefined) providerSessionIdByName.set(meta.name, providerSessionId);
    }

    const names = new Set<string>(alive);
    for (const meta of metas) names.add(meta.name);

    const infos: SessionInfo[] = [...names].map((name) => ({
      name,
      cwd: cwdByName.get(name) ?? "",
      alive: alive.has(name),
      ...(claudeSessionIdByName.has(name) ? { claudeSessionId: claudeSessionIdByName.get(name)! } : {}),
      ...(agentByName.has(name) ? { agent: agentByName.get(name)! } : {}),
      ...(providerSessionIdByName.has(name)
        ? { providerSessionId: providerSessionIdByName.get(name)! }
        : {}),
    }));
    return infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 既存セッションへ reattach（生存: attached / 不在: session_not_found エラー封筒）。 */
  async reattach(name: string): Promise<ReattachResult> {
    validateSessionName(name);
    const aliveNames = await this.liveSessionNames();
    if (!aliveNames.has(name)) {
      return {
        kind: "notFound",
        error: {
          type: "error",
          v: this.protocolVersion,
          code: "session_not_found",
          message: `セッション '${name}' は存在しません。新規に起動できます。`,
        },
      };
    }
    // Claude が終了してシェルだけ残った tmux は、存在していても入力先としては無効。
    // stale session を消して notFound と同じ再開経路へ流し、engine に --resume 起動させる。
    // Codex のターンは App Server が駆動し、TUI が shell command に見える待機期間もあるため除外する。
    if ((this.store.get(name)?.agent ?? "claude") === "claude" && !(await this.agentProcessAlive(name))) {
      await this.kill(name);
      return {
        kind: "notFound",
        error: {
          type: "error",
          v: this.protocolVersion,
          code: "session_not_found",
          message: `セッション '${name}' のエージェントを再起動します。`,
        },
      };
    }
    const cwd = this.store.get(name)?.cwd ?? "";
    const recent = await this.capturePane(name);
    return { kind: "attached", info: { name, cwd, alive: true }, recentOutput: recent };
  }

  /** pane 内のエージェント生存判定。tmux エラーや空出力は二重起動を避けて true に倒す。 */
  async agentProcessAlive(name: string): Promise<boolean> {
    validateSessionName(name);
    try {
      const result = await this.runner([
        "display-message", "-p", "-t", this.paneTarget(name), "#{pane_current_command}",
      ]);
      if (result.exitCode !== 0) return true;
      return paneCommandLooksLikeAgent(result.stdout);
    } catch {
      return true;
    }
  }

  /**
   * 会話カスタムタイトルの端末表示追随（session-title）。tmux はセッション名自体が
   * 識別子（rename は全経路の解決を壊す）のため no-op。
   */
  async setDisplayTitle(name: string, _title: string | null): Promise<void> {
    validateSessionName(name);
  }

  /** 指定セッションのみを終了する（tmux kill-session -t <name>）。 */
  async kill(name: string): Promise<void> {
    validateSessionName(name);
    const args = ["kill-session", "-t", name];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
  }

  /**
   * 本文入力と送信確定を 1 操作で行う（chat 注入・kick 用, SessionBackend 共通面）。
   * literal 送出 → 150ms（Ink 再描画待ち）→ Enter。
   */
  async sendTextSubmit(name: string, text: string): Promise<void> {
    // 1 回の capture で「/login フロー中か」と「残存テキスト」を判定する（chat 毎の capture を増やさない）。
    const screen = await this.captureVisibleScreenOrNull(name);
    // `/login` フロー中（方式選択 / コード入力待ち / retry）は通常の入力欄が無く、注入した本文が
    // 選択リストやコード欄へ入る。明示エラーで chat_send を失敗させる（コードは login_code_send、
    // 再試行/中断は pane_key_send の専用経路）。
    if (screen !== null && screenInLoginFlow(screen)) {
      throw new LoginCodeError(CHAT_BLOCKED_BY_LOGIN_PROMPT);
    }
    // 中断（停止）直後は claude が queued メッセージを入力欄へ書き戻す。残存したまま
    // 注入すると今回の本文がその後ろへ連結され 1 メッセージになる（実機FB 2026-07-29）。
    // 残存は先に Enter で独立メッセージとして送信し切ってから注入する。空入力への
    // Enter は no-op なので誤検出は無害（herdr 側 sendTextSubmit と同じ防御）。
    // 判定は ANSI で行い、薄字（faint）のプロンプト提案/プレースホルダーを実テキストと
    // 数えない（実障害 2026-09-03: 提案を残留と誤認し Enter で勝手に送信していた）。
    const ansiScreen = await this.captureVisibleScreenAnsiOrNull(name);
    if (ansiScreen !== null && inputBoxHasRealPendingText(ansiScreen)) {
      await this.sendKeys(name, ["Enter"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // 入力欄がシェルモード（プロンプト `!`）のまま残っていると、注入した通常メッセージが
    // そのままシェルコマンドとして実行される。空入力の Backspace（tmux キー名は BSpace）で
    // 記号を消して通常入力へ戻す。`!` 始まりの本文は注入時に自分でシェルモードへ入るので、
    // 常に通常モードから始めるのが決定的で安全（herdr 側 exitShellMode と同じ防御）。
    await this.exitShellMode(name);
    await this.sendKeys(name, [text], true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.sendKeys(name, ["Enter"]);
  }

  /**
   * `/login` の OAuth コードを入力欄へ渡して確定する（login_code_send）。
   * コード入力待ちの画面でなければ何も送らず throw する（誤って通常入力欄へ
   * コードが本文として送信されるのを防ぐ）。literal 送出 → 150ms → Enter は
   * sendTextSubmit と同じ Ink の取り込み間隔。
   */
  async sendLoginCode(name: string, code: string): Promise<void> {
    await submitLoginCode(code, {
      capture: () => this.captureVisibleScreenOrNull(name),
      sendLiteral: (text) => this.sendKeys(name, [text], true),
      sendEnter: () => this.sendKeys(name, ["Enter"]),
      delayMs: this.loginTiming.delayMs,
      pollMs: this.loginTiming.pollMs,
      settleMs: this.loginTiming.settleMs,
    });
  }

  /** 画面キャプチャ（判定不能=capture 失敗は null）。 */
  private async captureVisibleScreenOrNull(name: string): Promise<string | null> {
    try {
      return await this.captureVisibleScreen(name);
    } catch {
      return null;
    }
  }

  /**
   * 入力欄がシェルモードなら BSpace で通常入力へ戻す。判定不能・tmux エラーは no-op
   * （fail-open。この補助操作のエラーを表に出すと「送信できない」原因が BSpace 送出の
   * 失敗に見えてしまうので、実エラーは続く本文注入の send-keys 失敗として顕在化させる）。
   */
  private async exitShellMode(name: string): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
        if (!inputBoxIsShellMode(box) || (box?.text.length ?? 0) > 0) return;
        await this.sendKeys(name, ["BSpace"]);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } catch {
      // no-op（fail-open）
    }
  }


  /**
   * 入力欄判定用に **viewport 全体**を取る（末尾 N 行で切らない）。
   *
   * claude TUI の入力欄の最大高さは端末サイズにほぼ比例する（実測 2.1.220:
   * 63 行端末で 26 行 / 120 行端末で 55 行）。固定行数の窓では大きな端末で上罫線が
   * 窓外に出て入力欄を見失い、本文を重ね打ちして送信失敗する。窓を広く取っても
   * `extractClaudeInputBox` は罫線で入力欄を切り出すので過検出にはならない。
   * tmux は `-S` を付けなければ viewport のみ（履歴を引かない）。
   */
  private async captureVisibleScreen(name: string): Promise<string> {
    const args = ["capture-pane", "-p", "-t", this.paneTarget(name)];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
    const lines = result.stdout.split("\n");
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /**
   * viewport 全体を ANSI エスケープ付き（`capture-pane -e`）で取る。faint（SGR 2）属性で
   * プロンプト提案/プレースホルダーを実テキストと見分けるのに使う（inputBoxHasRealPendingText）。
   * 判定不能=capture 失敗は null（fail-open）。
   */
  private async captureVisibleScreenAnsiOrNull(name: string): Promise<string | null> {
    const args = ["capture-pane", "-p", "-e", "-t", this.paneTarget(name)];
    const result = await this.runner(args);
    if (result.exitCode !== 0) return null;
    const lines = result.stdout.split("\n");
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /** 指定セッションの pane へ tmux send-keys を発行する（literal は -l）。 */
  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    validateSessionName(name);
    if (keys.length === 0) return;
    const args = ["send-keys", "-t", this.paneTarget(name)];
    // literal は `--` で引数終端を明示する（先頭が `-` の本文 — base64url の OAuth コード等 —
    // を tmux がフラグと誤認して `unknown flag` で失敗する）。
    if (literal) args.push("-l", "--");
    args.push(...keys);
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
  }

  /** `capture-pane -p -t <name> -S -<N>` で末尾 N 行のペイン内容を返す（末尾空行は削る）。 */
  async capturePane(name: string, options: CapturePaneOptions = {}): Promise<string> {
    const args = ["capture-pane", "-p"];
    if (options.joinWrappedLines ?? false) args.push("-J");
    args.push("-t", this.paneTarget(name), "-S", `-${options.lines ?? this.captureLines}`);
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
    const lines = result.stdout.split("\n");
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /** pane ID が記録済みなら `%N` を使い、旧メタデータでは session 名へ戻す。 */
  private paneTarget(name: string): string {
    validateSessionName(name);
    return this.store.get(name)?.tmuxPaneId ?? name;
  }

  /** `tmux ls` の生存セッション名集合。サーバ未起動 = 空集合として扱う。 */
  private async liveSessionNames(): Promise<Set<string>> {
    const args = ["ls", "-F", "#{session_name}"];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      const combined = (result.stdout + result.stderr).toLowerCase();
      if (combined.includes("no server running") || combined.includes("no sessions")) {
        return new Set();
      }
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
    const out = new Set<string>();
    for (const raw of result.stdout.split("\n")) {
      const line = raw.trim();
      if (line.length > 0) out.add(line);
    }
    return out;
  }
}
