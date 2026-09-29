// tmux.ts
// tailii (TS host) — tmux セッションの list / reattach / kill / send-keys / capture-pane
// Swift 版 TmuxSessionManager.swift の移植。
// 生存集合は `tmux ls -F '#{session_name}'`、cwd は SessionMetadataStore を権威とする。

import { execFile } from "node:child_process";
import { PROTOCOL_V1, type ControlMessage, type SessionInfo } from "../protocol.js";
import { SessionMetadataStore, validateSessionName } from "../sessions/sessionMetadataStore.js";
import { normalizeForTextMatch, stripInvisibleForComparison } from "../shared/invisibleText.js";
import { unwrapPastedContent } from "../shared/pastedContent.js";

/** tmux コマンド 1 回分の実行結果。 */
export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** tmux コマンド実行の注入可能な抽象（テストはモックを注入する）。 */
export type TmuxCommandRunner = (args: string[], input?: string) => Promise<TmuxCommandResult>;

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

/**
 * 行（trim 済み）が水平罫線（`────…`）か。タイトルの埋まった罫線は、行末にも罫線が 2 個以上
 * 続くものだけを認める（以前の版の形 `──── <タイトル> ──`）。**変更前から同じ規則。広げない**:
 * 行末の罫線 1 個を認めると、入力欄の下に出る statusLine の行（`  ───── haiku │ main ─`）を
 * 枠と読む。
 */
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

/** 行が、行頭（0 桁目）から行末まで罫線だけか（入力欄の下の枠）。 */
function isPureFrameLine(rawLine: string): boolean {
  return /^[─━]{3,}\s*$/u.test(rawLine);
}

/**
 * 入力欄の枠（上下 2 本の水平罫線）の位置。`lines` は trim していない行（SGR は除去済み）。
 *
 * 探す順:
 * 1. 下の枠からプロンプトの行まで辿り、そのすぐ上の行を上の枠にする（`findFrameAbovePrompt`）。
 *    入力欄の形そのものを辿るので、入力欄の中の罫線だけの行・履歴の罫線・上の枠に埋まった
 *    タイトルに左右されない
 * 2. 1 で辿れない画面（tmux の画面が崩れて下の枠が消えた・字下げされた写しなど）は、
 *    **変更前と同じ規則**: trim した行を `isInputBoxRuleLine` で探し、末尾側の 2 本を枠にする
 *
 * 1 と 2 の間に「行頭から罫線が 3 個以上続く行 2 本」を探す段を置いていたが、取り除いた。
 * 履歴に見えている行頭からの罫線を枠と取り違える（スラッシュコマンドの控えは、折り返した
 * 続きの行が字下げされない。実測 2.1.285: `/rename <長い名前> ─────── tail` の控えの 2 行目が
 * `─────── tail`）。タイトルの長い会話と、画面が崩れて下の枠が消えた tmux の pane で、空の
 * 入力欄を「履歴が残っている」と読み、その行が画面の外へ流れるまで送信がすべて拒否された
 * （どちらも変更前は届いていた）。1 で辿れない画面の読み方は、変更前から変えない。
 */
function findInputBoxFrame(lines: string[]): { top: number; bottom: number } | null {
  const framed = findFrameAbovePrompt(lines);
  if (framed !== null) return framed;
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine((lines[index] ?? "").trim())) {
      bottom = index;
      break;
    }
  }
  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine((lines[index] ?? "").trim())) return { top: index, bottom };
  }
  return null;
}

/** 行（trim していない）が、入力欄の 1 行目の形（行頭がプロンプト記号）か。 */
function startsWithInputPrompt(rawLine: string): boolean {
  return INPUT_PROMPT_SIGILS.some((sigil) => rawLine.startsWith(sigil));
}

/**
 * 下の枠から辿って見つける入力欄の枠。下の枠（行頭から行末まで罫線だけの、最後の行）から上へ、
 * 入力欄の本文の続きの行（字下げ・空行）を辿り、プロンプト記号で始まる行（入力欄の 1 行目）の
 * **すぐ上の行**を上の枠とする。その行が罫線で終わっていなければ、入力欄とは見なさない。
 *
 * 入力欄の形を最後まで確かめられたときだけ枠を返す。確かめられない画面は null を返し、呼び出し
 * 側が変更前と同じ規則で読む。
 *
 * 上の枠の行頭の形を問わないので、タイトルが長い名前付きの会話でも読める。タイトルの表示幅が
 * 「pane の幅 − 5」以上になると、上の罫線は行頭の罫線が 3 個に届かない（`── <タイトル> ─` /
 * `─ <タイトル> ─` / ` <タイトル>… ─`。実測 2.1.284）。
 */
function findFrameAbovePrompt(lines: string[]): { top: number; bottom: number } | null {
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isPureFrameLine(lines[index] ?? "")) {
      bottom = index;
      break;
    }
  }
  // 下の枠のすぐ下は、ボトムバーか statusLine（字下げ）か空行。プロンプト記号で始まる行が
  // 続くなら、見つけた罫線は下の枠ではない（tmux の画面が崩れて下の枠が消え、上の枠を拾った）。
  if (startsWithInputPrompt(lines[bottom + 1] ?? "")) return null;
  let index = bottom - 1;
  while (index >= 0 && /^(?: {2}|\s*$)/u.test(lines[index] ?? "")) index -= 1;
  if (index < 1) return null;
  const first = lines[index] ?? "";
  if (!startsWithInputPrompt(first)) return null;
  return /[─━]\s*$/u.test(lines[index - 1] ?? "") ? { top: index - 1, bottom } : null;
}

/**
 * 画面から claude TUI の入力欄を取り出す（TESTABLE）。
 *
 * 入力欄は上下 2 本の水平罫線に挟まれた領域（枠の探し方は `findInputBoxFrame`）。`❯` 行だけを探す旧実装は
 * シェルモード（プロンプトが `!` になる）で入力欄を見失い、注入検証が必ず失敗
 * → 本文を 3 回重ね打ちして入力欄を壊し、送信失敗として throw していた
 * （実障害 2026-08-03: `!` 始まりの送信が HerdrFailedError）。
 * 罫線が見つからない画面は最後の `❯` 行 **1 行だけ**へフォールバックする
 * （旧 `inputBoxHasPendingText` と同じ判定なので退行しない）。
 * 判定不能は null（呼び出し側は fail-open 材料として扱う）。
 *
 * **前提**: ダイアログ表示中は本文側の罫線ペア（`──── Planning: … ────` 等）を入力欄と
 * 誤認しうる（実測 2.1.278: 承認ダイアログで `"1. Yes"`、設問ダイアログで選択肢全文を返す）。
 * ダイアログかどうかの判定はこの関数の責務ではない。書き込む側が
 * `claudeComposerBarVisible`（バーが見えている時だけ入力欄として信じる）で門番すること。
 * herdr は加えて注入前に `selectionDialogVisible` → Esc でダイアログを閉じる。
 */
export function extractClaudeInputBox(screen: string): ClaudeInputBox | null {
  const raw = screen.split("\n").map((line) => line.replace(/\r$/, ""));
  const lines = raw.map((line) => line.trim());
  const frame = findInputBoxFrame(raw);
  if (frame !== null) return splitInputPrompt(lines.slice(frame.top + 1, frame.bottom));
  // 罫線が無い画面は最後の `❯` 行 1 行だけを入力欄とみなす（下の行まで含めると
  // フッターを未送信テキストと誤認して送信確定ループが終わらない）。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").startsWith("❯")) return splitInputPrompt([lines[index] ?? ""]);
  }
  return null;
}

/**
 * claude TUI の入力欄（composer）が描画済みか（起動中の pane との区別, boot-gate）。
 *
 * claude プロセスは起動していても、TUI が入力欄を描くまでには（host 負荷次第で）数秒〜
 * 10 秒超の窓がある。その間の画面は初期シェルのプロンプト／`exec zsh -lc …` のエコー／
 * 起動バナー（`╭…╮` の角付き枠）だけで、入力欄の罫線（`─` の連続行）は 1 本も無い。
 * 罫線が 1 本でも見えれば TUI は描画済み（composer は本文の罫線と同じフレームで描かれ、
 * スクロールで上側の罫線が窓外に出ても下側は残る）。`❯` だけの画面はシェルプロンプトの
 * 可能性があるため描画済みとみなさない（`extractClaudeInputBox` の ❯ フォールバックは
 * 描画済み前提の判定にだけ使う）。
 */
export function claudeInputBoxRendered(screen: string): boolean {
  return screen.split("\n").some((line) => isInputBoxRuleLine(stripSgr(line).trim()));
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

/**
 * CSI エスケープ（`ESC[…`）を除いた素のテキスト。
 * **SGR（`ESC[…m`）だけを落とすと不十分**: カーソル可視制御（`ESC[?25l`）や消去、コロン区切りの
 * 真カラー（`ESC[38:2:255:0:0m`）が 1 つ混ざるだけで行頭一致が全滅し、門番が黙って外れる
 * （2026-09-24 のセルフレビュー 2 周目で実測）。iOS `stripANSI` と同じ範囲に揃える（同値実装）。
 * 実測 2.8µs/call（60 行フレーム）で、250ms 周期の pane preview でも無視できる。
 */
function stripSgr(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "");
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
  const analysis = analyzeInputBox(ansiScreen);
  return analysis !== null && analysis.text.length > 0 && !analysis.faintOnly;
}

/**
 * 入力欄の「実テキスト」（薄字プロンプト提案・プレースホルダーを除いた未送信本文）を返す。
 * `null` = 入力欄が見つからない（罫線が窓外・描画崩れ）、`""` = 空 or 提案/プレースホルダー、
 * それ以外 = 実テキスト。text capture の box.text を使う判定（clearInputBox の空判定・
 * inputBoxContainsText の probe 照合）が提案を実テキストと誤認するのを塞ぐため、ANSI から
 * faint を見て実テキストだけを取り出す（prompt-suggestion-chip）。
 */
export function inputBoxRealText(ansiScreen: string): string | null {
  const analysis = analyzeInputBox(ansiScreen);
  if (analysis === null) return null;
  return analysis.faintOnly ? "" : analysis.text;
}

/**
 * chat 注入（sendTextSubmit）の呼び出し側が渡す補助情報。
 */
export interface SendTextSubmitOptions {
  /**
   * transcript に記録済みの直近の発話本文（遅延評価。入力欄に残存テキストが無ければ呼ばれない）。
   * 残存テキストがこれと同文なら「出力前に中断されて書き戻された発話」= 既に配送・表示済みなので、
   * Enter で送り直さず破棄する（restored-prompt-discard）。null = 不明（従来どおり Enter で flush）。
   */
  recordedPromptText?: () => string | null;
  /**
   * 送信確定ループが上限まで撃っても成立を確認できなかったときに 1 回だけ呼ばれる。
   * 呼び出し側（hub）は監査ログへ残す。throw にしないのは、実際には送信済みかもしれない
   * 本文を明示再送へ倒すと二重送信になり得るため（「配送済み扱い + 可観測化」を選ぶ）。
   */
  onUnconfirmedSubmit?: () => void;
  /**
   * 選択ダイアログ（AskUserQuestion の設問 / ❯ メニュー）が開いていたら、Esc で閉じてから本文を送る
   * （chat-cancel-choice）。利用者が「選択肢に答えずにメッセージを送る」と決めた送信にだけ付く。
   * 付いていない送信は従来どおり 1 キーも打たずに拒否する（tmux）。
   * 承認ダイアログと `/login` フローは対象外（どちらも専用の操作経路があり、Esc の意味が重い）。
   */
  cancelChoiceDialog?: boolean;
  /** 選択ダイアログを実際に Esc で閉じたときに 1 回だけ呼ばれる（hub が監査ログへ残す）。 */
  onChoiceDialogCancelled?: () => void;
}

/**
 * CLI が 1 回に読み取る入力の上限（バイト）。macOS の pty は 1022（実測 2.1.284: tmux / herdr とも）。
 * Linux の pty は 1 回で約 4095 バイトまで返しうる（未実測。広い側に倒す）。
 */
export const PASTE_READ_BYTES = process.platform === "darwin" ? 1022 : 4095;
/**
 * 1 回の読み取りがこの字数に達する本文は、貼り付けとして渡す。CLI が貼り付けと判定する境界
 * （実測: 800 字はそのまま、801 字で貼り付け）より手前に取る。
 */
const PASTE_RISK_CHARS = 700;

/**
 * 1 回で打つと壊れる本文か（long-text-paste, TESTABLE）。真なら小分けの貼り付けで渡す。
 *
 * CLI（実測 2.1.284）は **1 回の読み取りで 800 字を超える入力**を、打鍵ではなく貼り付けとして
 * 扱う。数えるのは文字数で、1 回の読み取りは 1022 バイトで頭打ちになる（macOS）。だから日本語
 * （1 字 3 バイト = 約 340 字）は何千字でも貼り付けにならず、英数字中心の本文だけがなる。意図しない
 * 貼り付けは、本文が読み取りの境界で分かれて届く:
 * - 入力欄が `[Pasted text #2][Pasted text #3]残り` になり、包み（`<pasted_content>`）が本文の
 *   途中に入る
 * - 直前の貼り付けの案内が出ている間は、先頭の読み取り分（1022 字）が入力欄に入らない
 *   （1500 字を送って記録されたのは末尾 478 字）
 * - herdr の反映検証は `[Pasted text #N]` を「打鍵が届いていない」と判定して送信を失敗させる
 *
 * もう 1 つ、**タブを含む本文**。打ったタブは入力欄に入らない（実測: `"X1\tA\tB"` → `X1AB`。
 * 字下げが消える）。複数回の読み取りに分かれると、次の読み取り分が前の分の途中へ挿入される。
 * 貼り付けたタブは空白 4 個になって残る。
 *
 * 同じく、**打つとキー操作として効く文字**: CR は Enter になり、本文がそこで送信されて 2 通に
 * 分かれる。DEL は Backspace になり、直前の 1 字が消える（実測 2.1.284。変更前からの挙動）。
 * 貼り付けなら、CR / U+2028 は改行になり、制御文字は落ちる（`normalizeTextForPaste`）。
 *
 * どれでもない本文（短い本文 / 日本語中心でタブの無い長文）は、従来どおり打つ。
 */
/** 打つとキー操作として効く文字（タブ・CR・DEL・その他の制御文字。LF と ESC は除く）と U+2028 / U+2029。 */
const TYPED_AS_KEYS = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f\u2028\u2029]/;
export function typedTextWouldBreak(text: string, readBytes: number = PASTE_READ_BYTES): boolean {
  if (TYPED_AS_KEYS.test(text)) return true;
  let start = 0;
  let windowBytes = 0;
  let windowChars = 0;
  const bytes: number[] = [];
  const chars: number[] = [];
  for (const point of text) {
    const size = Buffer.byteLength(point);
    bytes.push(size);
    chars.push(point.length);
    windowBytes += size;
    windowChars += point.length;
    while (windowBytes > readBytes) {
      windowBytes -= bytes[start] ?? 0;
      windowChars -= chars[start] ?? 0;
      start += 1;
    }
    if (windowChars >= PASTE_RISK_CHARS) return true;
  }
  return false;
}

/** tmux の引数で渡せる本文の上限（バイト）。約 16KB で `command too long` になる手前に取る。 */
const TMUX_TYPED_MAX_BYTES = 12_000;

/** tmux で 1 回で打つと壊れる本文か（TESTABLE）。引数の上限を超える本文も貼り付けで渡す。 */
export function tmuxTypedTextWouldBreak(text: string): boolean {
  return typedTextWouldBreak(text) || Buffer.byteLength(text) > TMUX_TYPED_MAX_BYTES;
}

/** 括弧付き貼り付けの開始・終了（端末の bracketed paste）。 */
export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * 貼り付けとして渡せる本文か。ESC を含む本文は、途中の `ESC[201~` で貼り付けが終わり、残りが
 * 打鍵として解釈されうるので渡さない（従来どおり打つ）。
 */
export function textIsPasteSafe(text: string): boolean {
  return !text.includes("\u001b");
}

/**
 * 入力反映検証に使う probe（本文の**末尾側**）。検証不能な本文（空など）は null。
 *
 * 末尾側なのは composer の表示特性のため: 入力が表示高を超えると composer は下へ
 * スクロールし**先頭行が窓外へ消える**（実測 2.1.220: 10行ペーストで先頭4行が
 * capture から消失）。カーソルは常に末尾にあるので、末尾側の probe だけが
 * 「見えている範囲」との照合を保証できる（先頭24字の旧 probe は多行/長文で
 * 構造的に偽陰性 → 再投入 → 本文二重化の温床だった）。
 *
 * 先頭 `!`（シェルモード）は claude TUI がモード記号として吸い上げ、入力欄本文には
 * 残らない（`!ls -la` は `! ls -la` と描画される）。単一行本文では照合キーからも
 * 落とさないと末尾24字に `!` が含まれるとき反映検証が失敗する。
 */
export function typedTextProbe(text: string): string | null {
  // 不可視文字は端末のセルに載らない（capture に出ない）ため、probe に混ざると反映検証が
  // 構造的に偽陰性になる。probe は不可視文字を除いた可視本文から取る
  // （照合側 `inputBoxTextIncludesProbe` も両辺から落とすので規則は一致する）。
  const lines = stripInvisibleForComparison(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) return null;
  const body =
    lines.length === 1 && lastLine.startsWith("!") ? lastLine.slice(1).trim() : lastLine;
  if (body.length === 0) return null;
  return body.slice(-24);
}

/**
 * 入力欄テキストに probe が反映されているか（折り返し非依存）。
 * extractClaudeInputBox は表示行を trim + "\n" 連結で返すため、probe が入力欄の
 * 行折り返しをまたぐと生の includes は絶対に一致しない（全角24字=48桁 > 内幅で必発）。
 * この偽陰性が「反映済み本文の再投入 = 初回送信の本文二重化」の根因だった（実機5件）。
 * 空白類（折り返しの改行・trim 痕・全角空白含む）と不可視文字を両辺から除去して照合する。
 *
 * 結合文字は両辺を NFC にそろえる。端末には合成済みの形で映るので（`e` + U+0301 → `é`、
 * `か` + U+3099 → `が`）、分解形（macOS 由来の文字列に多い）のままの probe は一致しない
 * （独立検証が実測: 結合文字を含む本文の反映検証が必ず失敗した）。
 */
export function inputBoxTextIncludesProbe(boxText: string, probe: string): boolean {
  const needle = normalizeForTextMatch(probe.normalize("NFC"));
  if (needle.length === 0) return false;
  return normalizeForTextMatch(boxText.normalize("NFC")).includes(needle);
}

/**
 * 1 つの貼り付けに入れる本文の上限（TESTABLE）。CLI（実測 2.1.284）は、1 つの貼り付けが
 * **800 字以下で改行 2 個以下**なら、畳まずに本文のまま入力欄へ入れる（801 字・改行 3 個から
 * `[Pasted text #N +M lines]` に畳む。字数は UTF-16 の単位で数える）。境界より手前に取る。
 */
export const INLINE_PASTE_MAX_CHARS = 500;
export const INLINE_PASTE_MAX_NEWLINES = 1;
/**
 * 1 つの貼り付けのバイト数の上限。括弧（12 バイト）を足しても、CLI の 1 回の読み取り（1022 バイト）と
 * pty の入力の待ち行列に収まる大きさにする。まとめて書き込むと、CLI が読み進めるのを待たされる
 * （実測 herdr: 8KB を 1 回で書くと、入り切るまで 4〜7 秒。1 つずつなら 0.3 秒）。
 */
export const INLINE_PASTE_MAX_BYTES = 900;

/**
 * 貼り付ける前に、CLI が記録するときの形へそろえる（TESTABLE）。CLI（実測 2.1.284）は貼り付けの
 * CR / CRLF / U+2028 を LF にし、制御文字（DEL・U+009B など）を落とす。先にそろえておくと、
 * 入力欄に映る本文と照合できる（そろえないと、これらを含む本文は毎回「入らなかった」と判定される）。
 * タブと LF は残す。ESC を含む本文は貼り付けない（`textIsPasteSafe`）。
 */
export function normalizeTextForPaste(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/**
 * 拡張子の「.」の直後（`shot-1.` | `png`）。後ろが拡張子らしい語（英数字 2〜5 字で、語の終わり）の
 * 「.」だけを拾う。
 */
const EXTENSION_DOT = /\.(?=[0-9A-Za-z]{2,5}(?:["'\s]|$))/g;

/**
 * 本文を、畳まれずに入力欄へ入る大きさの貼り付けに分ける（long-text-paste, TESTABLE）。
 * つなげると元の本文に戻る。
 *
 * - 1 つは `INLINE_PASTE_MAX_CHARS` 字・`INLINE_PASTE_MAX_BYTES` バイト・改行
 *   `INLINE_PASTE_MAX_NEWLINES` 個まで
 * - 書記素の途中では分けない（結合文字・ZWJ でつないだ絵文字・サロゲートの対）
 * - **拡張子の付いた語を、1 つの貼り付けの中に丸ごと入れない**。CLI は、貼り付けの中の実在する
 *   画像のパスを `[Image #N]` の添付に置き換える（実測 2.1.284: 貼り付けの全体がパスのとき。
 *   パスが 2 つ以上並ぶときは、後ろに本文が続いていても置き換わり、語の順序まで変わる）。
 *   アプリは添付のパスを本文の前に空白区切りで並べる（`p1 p2 本文`）。拡張子の「.」の直後で
 *   分けると、前半は拡張子が無く、後半はパスの形をしていない
 */
export function splitForInlinePaste(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let bytes = 0;
  let newlines = 0;
  const flush = (): void => {
    if (current === "") return;
    let start = 0;
    for (const match of current.matchAll(EXTENSION_DOT)) {
      pieces.push(current.slice(start, match.index + 1));
      start = match.index + 1;
    }
    if (start < current.length) pieces.push(current.slice(start));
    current = "";
    bytes = 0;
    newlines = 0;
  };
  for (const { segment } of GRAPHEMES.segment(text)) {
    const breaks = segment === "\n" ? 1 : 0;
    const size = Buffer.byteLength(segment);
    if (
      current.length + segment.length > INLINE_PASTE_MAX_CHARS ||
      bytes + size > INLINE_PASTE_MAX_BYTES ||
      newlines + breaks > INLINE_PASTE_MAX_NEWLINES
    ) {
      flush();
    }
    current += segment;
    bytes += size;
    newlines += breaks;
    // 改行で終わる形にそろえる（行の途中から始まる貼り付けを作らない）。
    if (newlines >= INLINE_PASTE_MAX_NEWLINES) flush();
  }
  flush();
  return pieces;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** ボトムバーの位置に `paste again to expand` が出ているか（常駐 TUI 行は読み飛ばす, TESTABLE）。 */
export function screenShowsPasteHint(screen: string): boolean {
  const lines = screen
    .split("\n")
    .map((line) => stripSgr(line).trim())
    .filter((line) => line !== "");
  let index = lines.length - 1;
  while (index >= 0 && isTrailingTuiLine(lines[index] ?? "")) index -= 1;
  return lines[index] === PASTE_EXPAND_HINT;
}

/** 照合用にそろえる: 結合文字は合成済み、空白類・不可視文字・制御文字は落とす。 */
function normalizePastedForMatch(value: string): string {
  return normalizeForTextMatch(value.normalize("NFC")).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/**
 * 入力欄が長い本文の中ほどを置き換えて映す表示（実測 2.1.284）。入力欄の本文が約 10000 字を
 * 超えると、CLI は「先頭約 500 字 + `[...Truncated text #N +M lines...]` + 末尾」の形で映す
 * （表示だけ。送信される本文は全文）。語の途中でも置き換わる。
 */
const TRUNCATED_DISPLAY = /\[\.\.\.Truncated text #\d+(?: \+\d+ lines)?\.\.\.\]/g;

/**
 * 入力欄に映っている本文が、`text` の一部として順に現れるか（TESTABLE）。
 * 置き換えの表示（`TRUNCATED_DISPLAY`）で区切られた各部分が、`text` の中にこの順で現れることを
 * 確かめる。`anchoredAtEnd` なら、最後の部分は `text` の末尾と同文でなければならない。
 * 一致した字数を返す（一致しなければ -1）。照合は空白類・不可視文字を落とした形で行う。
 */
export function matchInputBoxAgainstText(boxText: string, text: string, anchoredAtEnd: boolean): number {
  const body = normalizePastedForMatch(text);
  // 本文そのものが置き換えの表示と同じ文言を含むことがある。先に、そのままの形で照合する。
  const whole = normalizePastedForMatch(boxText);
  if (whole.length > 0 && (anchoredAtEnd ? body.endsWith(whole) : body.includes(whole))) return whole.length;
  const parts = boxText.split(TRUNCATED_DISPLAY).map(normalizePastedForMatch);
  let cursor = 0;
  let matched = 0;
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (part.length === 0) {
      // 置き換えの表示で終わる入力欄は、末尾を確かめられない。
      if (last && anchoredAtEnd && parts.length > 1) return -1;
      continue;
    }
    if (last && anchoredAtEnd) {
      if (!body.endsWith(part) || body.length - part.length < cursor) return -1;
    } else {
      const at = body.indexOf(part, cursor);
      if (at === -1) return -1;
      cursor = at + part.length;
    }
    matched += part.length;
  }
  return matched === 0 ? -1 : matched;
}

/**
 * 貼り付けた本文が入力欄に入ったか（TESTABLE）。**入力欄に映っている全体が、本文の末尾と同文**
 * であることで確かめる（入力欄は長い本文の末尾側だけを映す）。pty は先入れ先出しなので、最後の
 * 貼り付けが入っていれば、その前の貼り付けも CLI が読み終えている。
 * 約 10000 字を超える本文は、中ほどが置き換えの表示になる（`matchInputBoxAgainstText`）。
 *
 * 末尾の数十字だけを探す照合にはしない。各行の終わりが同じ文言の本文（表・ログ）だと、途中まで
 * 入った時点で一致してしまう。CLI の処理が止まっている最中にそうなると、続けて打つ Enter が
 * 貼り付けの残りと一緒に読まれて改行として本文に入り、送信されないまま入力欄に残る（実測
 * 2.1.284: 30 行の本文を 11 行まで入った時点で止めた）。
 */
export function pastedTextArrived(boxText: string, text: string): boolean {
  const matched = matchInputBoxAgainstText(boxText, text, true);
  // 先頭の `!`（シェルモード）は CLI がモード記号として吸い上げ、入力欄の本文には残らない。
  return matched >= Math.min(24, normalizePastedForMatch(text).replace(/^!/, "").length) && matched > 0;
}

/**
 * 入力欄に映っているのが、貼り付けた本文の一部か（TESTABLE）。貼り付けが途中まで入った形
 * （CLI がまだ読んでいる / 処理が止まっている）を、別の中身と見分ける。
 */
export function pastedTextPartlyArrived(boxText: string, text: string): boolean {
  return matchInputBoxAgainstText(boxText, text, false) > 0;
}

/** 本文を小分けの貼り付けで渡すための入出力（tmux / herdr が与える）。 */
export interface PastedTextIo {
  /** 小分けにした本文を、1 つずつ括弧付き貼り付けとして、順に渡す。 */
  paste: (pieces: string[]) => Promise<void>;
  /** viewport を ANSI 付きで撮る（撮れなければ null）。 */
  capture: () => Promise<string | null>;
  /** C-u（kill-line）を `count` 回、続けて打つ。 */
  sendKills: (count: number) => Promise<void>;
  /** 入力欄に入ったのを確かめる間隔と上限（ms）。 */
  pollMs: number;
  timeoutMs: number;
  /** C-u をまとめて打った後、画面を撮り直すまでの間隔（ms）。 */
  clearDelayMs: number;
  /** C-u をまとめて打った後、入力欄が変わるのを待つ上限（ms。既定 `TYPED_TEXT_CLEAR_SETTLE_MS`）。 */
  clearSettleMs?: number;
  /** 貼り付けが入るのを待つのを、遅くともこの時刻（epoch ms）で打ち切る。 */
  verifyDeadlineMs?: number;
}

/** 貼り付けが入力欄に入るのを待つ上限と、確かめる間隔の既定（ms）。実測は 0.3 秒以内に入る。 */
export const PASTED_TEXT_TIMEOUT_MS = 3_000;
/**
 * tmux で待つ上限の既定（ms）。tmux は確かめられなくても送信確定へ進むので、長く待つ意味が薄い
 * （画面が崩れて読めない間は、貼り付けで渡す送信のたびにこの時間がかかる）。入っている途中なら延ばす。
 */
export const PASTED_TEXT_TIMEOUT_TMUX_MS = 1_500;
/**
 * 入っている途中なら待つ時間を延ばす。その上限（`timeoutMs` の何倍まで。既定で 9 秒）。
 * 注入の全体（前後の確認 約 1 秒・貼り付けの送出 約 1 秒・送信確定 最大 3.4 秒を含む）を、
 * アプリが応答を待つ 18 秒の内側に収める。herdr は、まれに入り切るまで数秒かかる（実測:
 * 10000 字が 7.5 秒で入り切らなかった回が 40 回に 1 回）。
 */
const PASTED_TEXT_MAX_EXTENSIONS = 3;
export const PASTED_TEXT_POLL_MS = 100;

/** C-u を 1 回にまとめて打つ数（貼り付けと判定される大きさには遠く届かない）。 */
const TYPED_TEXT_KILL_BATCH = 40;
/**
 * C-u をまとめて打った後、入力欄が変わるのを待つ上限（ms）。長い本文は、1 回消すたびに入力欄の
 * 描き直しがかかり、40 回ぶんの反映に 1 秒以上かかる（実測 herdr: 10000 字の本文。150ms おきに
 * 3 回見て変わらなければ諦める作りでは、消している途中で諦め、先頭の 468 字が残った）。
 */
export const TYPED_TEXT_CLEAR_SETTLE_MS = 1_500;
/** まとめて打った後、入力欄を撮り直す間隔の上限（ms）。 */
const CLEAR_POLL_MS = 50;
/** まとめて打っても入力欄が変わらない回が続いたら諦める回数。 */
const TYPED_TEXT_CLEAR_IDLE_LIMIT = 2;

/**
 * 入れかけの長い本文を入力欄から消す（TESTABLE）。空にできたら true。
 *
 * C-u（kill-line）は 1 回で 1 行ぶんしか消えない: 多行の本文は末尾行 → その改行の順に消え、
 * N 行なら 2N-1 回かかる（実測 2.1.220）。回数を固定（`clearInputBox` は 15 回）にすると
 * 9 行以上の本文は途中までしか消えない。40 回ずつまとめて打ち、**入力欄が空になるまで、
 * 進んでいる限り続ける**（上限は本文の大きさから決める）。まとめて打った後は、入力欄が変わるのを
 * `clearSettleMs` まで待つ。2 回続けて変わらなければ諦める（同じ行が並ぶ本文は、消えていても
 * 映っている範囲が同じに見えるので、1 回では諦めない）。空の入力欄への C-u は何もしない。
 * 入力欄のフレームと確かめられないとき（ダイアログ・判別不能）は 1 キーも打たない。
 */
export async function clearTypedInput(
  text: string,
  io: Pick<PastedTextIo, "capture" | "sendKills" | "clearDelayMs" | "clearSettleMs">,
): Promise<boolean> {
  const maxKills = 2 * text.split("\n").length + Math.ceil(Array.from(text).length / 20) + TYPED_TEXT_KILL_BATCH;
  const settleMs = io.clearSettleMs ?? TYPED_TEXT_CLEAR_SETTLE_MS;
  let screen = await io.capture();
  let idle = 0;
  for (let sent = 0; ; sent += TYPED_TEXT_KILL_BATCH) {
    const frame = classifySubmitFrame(screen);
    if (frame === "submitted") return true;
    if (screen === null || frame !== "pending" || sent >= maxKills) return false;
    const before = inputBoxRealText(screen);
    await io.sendKills(TYPED_TEXT_KILL_BATCH);
    // 打った分が効き終わるのを待つ: 入力欄が変わり始め、その後 3 回続けて同じになるまで。
    // 効いている途中で次を打つと、上限の回数を先に使い切る（消し切る前に諦める）。
    const deadline = Date.now() + settleMs;
    let changed = false;
    let previous = before;
    let quiet = 0;
    for (let polls = 0; quiet < 3 && (changed || polls < 3 || Date.now() < deadline); polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(io.clearDelayMs, CLEAR_POLL_MS)));
      screen = await io.capture();
      if (classifySubmitFrame(screen) !== "pending") {
        changed = true;
        break;
      }
      const now = inputBoxRealText(screen ?? "");
      if (now !== before) changed = true;
      quiet = changed && now === previous ? quiet + 1 : 0;
      previous = now;
    }
    idle = changed ? 0 : idle + 1;
    if (idle >= TYPED_TEXT_CLEAR_IDLE_LIMIT) return false;
  }
}

/**
 * 行数の分からない残存を消すときの上限（`clearTypedInput` の本文の代わりに渡す）。
 * 400 行ぶん（C-u 約 800 回）まで。
 */
export const CLEAR_UNKNOWN_INPUT_BOUND = "\n".repeat(400);

/** 貼り付けの送出が途中で失敗し、入った分を入力欄から消した（= 非配達が確定）ときの拒否文言。 */
export const CHAT_BLOCKED_BY_UNTYPED_TEXT =
  "長いメッセージを入力欄へ正しく入力できなかったため、送信しませんでした（もう一度送ってください）";

/**
 * 注入を始めてから、貼り付けが入ったのを確かめ終えるまでに使ってよい時間（ms）。アプリは応答を
 * 18 秒待つ。この後の送信確定（最大で tmux 3.4 秒 / herdr 5.2 秒）を引いた残りに収める。
 */
export const INJECT_VERIFY_BUDGET_MS = 12_000;

/** 貼り付けた本文が入力欄に入ったのを、確かめられたか。 */
export type PasteOutcome = "arrived" | "unverified";

/**
 * 本文を、小分けの括弧付き貼り付けで入力欄へ入れる（tmux / herdr 共通, long-text-paste）。
 *
 * ```
 * 小分けにして順に貼り付ける（splitForInlinePaste）
 * 100ms ごとに最大 3 秒、入力欄に入ったのを確かめる（pastedTextArrived）→ `arrived`
 *   （入っている途中で、進んでいる間は延ばす。最大 9 秒。注入を始めてから 12 秒まで）
 * 確かめられなかった → `unverified`（1 キーも打たない。どう扱うかは backend が決める）
 * 貼り付けの送出が途中で失敗した:
 *   入った分が入力欄に映っている → 消す（clearTypedInput）。空にできたら
 *                                    ChatInjectionRejectedError（非配達が確定）
 *   それ以外                     → 送出のエラーをそのまま返す
 * ```
 *
 * 貼り付けは打鍵と違い、読み取りの境界・タブ・結合文字で壊れない。1 つが 800 字以下・改行 2 個
 * 以下なら CLI は畳まずに本文のまま入力欄へ入れるので、**打った場合と同じ本文が記録される**
 * （`<pasted_content>` の包みが付かない）。
 *
 * **確かめられなかったときの扱いは、本文を打つ場合（変更前からの経路）と同じにする**:
 * - tmux: そのまま送信確定へ進む（Enter を押し、成立を確認できなければ `onUnconfirmedSubmit`）。
 *   画面を読めないだけのことがある（実測: 肌色付きの ✌🏽 などを含む発話の後、tmux の画面が
 *   崩れて入力欄が 1 行ずれる）。Enter は貼り付けの後ろに並ぶので、途中までの本文が送信される
 *   ことは無い
 * - herdr: 失敗として返す（打つ場合の反映検証と同じ。Remote Control 切断直後は入力が捨てられ、
 *   確かめずに進むと「送信成立」と誤判定する）
 *
 * 採らなかった方式:
 * - **小分けにして打つ**: タブのカーソルずれ・処理の停止・結合文字で、順序の崩れた本文や先頭が
 *   重複した本文が黙って届いた（独立検証が実 claude で再現）。
 * - **全文を 1 つの貼り付けで渡す**: 入力欄は `[Pasted text #N +M lines]` になり、本文は包まれて
 *   記録される。確かめる根拠が改行の数しか無く、同じ行数の別の貼り付け（Mac 側の下書き）と
 *   見分けられない。包みは Claude に「利用者が書いたとは限らない内容」と伝えるためのもので、
 *   利用者の指示の全体をその扱いにしてしまう。会話の一覧・タイトル・検索にも包みが出る。
 * - **確かめられなかった本文を控えて、後から入った分を消す**（控え・確認用の印）: CLI が止まった
 *   ときの「ちょうど 1 通」は守れるが、画面の読み取りに頼る判定が増え、それ自体が誤配送と
 *   送信不能の源になった（独立検証 5 周: 印が発話として届く・下書きを削る・画面が崩れると
 *   以後の送信がすべて拒否される）。
 */
export async function pasteTextInline(text: string, io: PastedTextIo): Promise<PasteOutcome> {
  const body = normalizeTextForPaste(text);
  try {
    await io.paste(splitForInlinePaste(body));
  } catch (error) {
    // 途中まで入った本文を残すと、次の送信の冒頭で断片が独立した発話として送られる。
    const screen = await io.capture();
    const box = screen === null ? null : inputBoxRealText(screen);
    if (classifySubmitFrame(screen) === "pending" && box !== null && pastedTextPartlyArrived(box, body) &&
      (await clearTypedInput(body, io))) {
      throw new ChatInjectionRejectedError(CHAT_BLOCKED_BY_UNTYPED_TEXT);
    }
    throw error;
  }
  const started = Date.now();
  const hardDeadline = Math.min(
    started + io.timeoutMs * PASTED_TEXT_MAX_EXTENSIONS,
    io.verifyDeadlineMs ?? Number.POSITIVE_INFINITY,
  );
  let deadline = Math.min(started + io.timeoutMs, hardDeadline);
  let previous: string | null = null;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
    const screen = await io.capture();
    const box = screen === null ? null : inputBoxRealText(screen);
    if (box !== null && pastedTextArrived(box, body)) return "arrived";
    // 入っている途中（入力欄が本文の一部で、前回から進んだ）なら、待つ時間を延ばす。CLI は
    // 続けて届いた貼り付けを、1 つずつ時間をかけて取り込むことがある。
    if (box !== null && box !== previous && previous !== null && pastedTextPartlyArrived(box, body)) {
      deadline = Math.min(Date.now() + io.timeoutMs, hardDeadline);
    }
    previous = box;
    if (Date.now() >= deadline) return "unverified";
  }
}

/**
 * 入力欄の残存テキストが、transcript に記録済みの発話本文と同文か（restored-prompt-discard）。
 *
 * 入力欄の描画は折り返し（trim + 改行連結）・composer スクロールで先頭行が窓外に出る・シェルモード
 * 記号 `!` の吸い上げがあるため、生の等値比較は使えない。空白類を両辺から除去し、先頭の `!` を
 * 落としたうえで「同一」または「残存が記録本文の末尾（可視領域は常に末尾側）」なら同文とみなす。
 * 末尾一致は短い断片の偶然一致（Mac 側で打ちかけた下書きが記録本文の語尾と重なる等）を避けるため
 * 24 字以上に限る（typedTextProbe と同じ長さ）。
 *
 * 不可視文字は両辺から落とす（`normalizeForTextMatch`）。2.1.277+ の claude は送信時に
 * 不可視文字を除去するため、記録本文（除去後）と入力欄（除去前後どちらもありうる）を
 * 生で比べると、貼り付け由来のゼロ幅文字 1 つで照合が外れる。
 */
export function inputBoxTextMatchesRecordedPrompt(boxText: string, recordedPrompt: string): boolean {
  // Mac 側で貼り付けて送った発話は、中断で `[Pasted text #N]` として書き戻される。表示からは
  // 本文が分からない（同じ行数の別の貼り付けと見分けられない）ので、同文とは判定しない。
  const normalize = (value: string): string =>
    normalizeForTextMatch(value.normalize("NFC")).replace(/^!/, "");
  // 約 10000 字を超える発話は、中ほどが置き換えの表示になって書き戻される。
  if (boxText.search(TRUNCATED_DISPLAY) !== -1) {
    return matchInputBoxAgainstText(boxText, unwrapPastedContent(recordedPrompt), true) >= 24;
  }
  const pending = normalize(boxText);
  const recorded = normalize(unwrapPastedContent(recordedPrompt));
  if (pending.length === 0 || recorded.length === 0) return false;
  if (pending === recorded) return true;
  return pending.length >= 24 && recorded.endsWith(pending);
}

/**
 * claude TUI のプロンプト提案文を取り出す（提案チップ表示用）。
 * 入力欄本文が薄字(faint)のみ かつ 既知プレースホルダーでない非空テキストのときだけ、その
 * 本文を返す（＝提案）。空・実テキスト（利用者入力/中断書き戻し）・プレースホルダーは null。
 * inputBoxHasRealPendingText と同じ解析(analyzeInputBox)を共有し、判定を一貫させる。
 */
export function extractInputBoxSuggestion(ansiScreen: string): string | null {
  const analysis = analyzeInputBox(ansiScreen);
  if (analysis === null || analysis.text.length === 0) return null;
  return analysis.faintOnly ? analysis.text : null;
}

/**
 * ANSI 画面から入力欄本文の可視テキスト（既知プレースホルダーは "" へ、extractClaudeInputBox
 * 準拠）と「本文がすべて薄字(faint)か」を返す。罫線ペア or 末尾 `❯` 行で領域を特定する
 * （extractClaudeInputBox と同型）。入力欄が見つからなければ null。
 */
function analyzeInputBox(ansiScreen: string): { text: string; faintOnly: boolean } | null {
  const rawLines = ansiScreen.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = rawLines.map((line) => stripSgr(line));
  const stripped = plain.map((line) => line.trim());

  // 罫線ペアで入力欄領域を特定する（extractClaudeInputBox と同じ規則を SGR 除去後の行へ）。
  const frame = findInputBoxFrame(plain);
  let bodyRaw: string[];
  if (frame !== null) {
    bodyRaw = rawLines.slice(frame.top + 1, frame.bottom);
  } else {
    // 罫線が無い画面は最後の `❯` 行 1 行だけを入力欄とみなす（extractClaudeInputBox と同型）。
    let sigilIndex = -1;
    for (let index = stripped.length - 1; index >= 0; index -= 1) {
      if ((stripped[index] ?? "").startsWith("❯")) {
        sigilIndex = index;
        break;
      }
    }
    if (sigilIndex < 0) return null;
    bodyRaw = [rawLines[sigilIndex] ?? ""];
  }

  // プレースホルダー（文言一致）は "" 扱い（extractClaudeInputBox が担保・後方互換）。
  // 字下げを残した行を渡す（trim した行を渡すと、入力欄の中の罫線だけの行を枠と取り違える）。
  const box = extractClaudeInputBox(plain.join("\n"));
  if (box === null) return null;
  return { text: box.text, faintOnly: bodyIsFaintOnly(bodyRaw) };
}

/**
 * 入力欄本文（ANSI 付き raw 行）の可視文字がすべて faint（SGR 2）か。
 * SGR 状態を文字送りで追い（0 = 全リセット / 2 = faint on / 22 = faint off）、
 * 空白・モード記号（`❯ › !`）以外の可視文字だけを評価する。可視文字が 1 つも無ければ false。
 */
function bodyIsFaintOnly(bodyRaw: string[]): boolean {
  const ESC = "\u001b";
  const NBSP = " ";
  let faint = false;
  let sawPrintable = false;
  let allFaint = true;
  for (const line of bodyRaw) {
    let index = 0;
    while (index < line.length) {
      if (line[index] === ESC && line[index + 1] === "[") {
        // eslint-disable-next-line no-control-regex
        const match = /^\u001b\[([0-9;]*)m/.exec(line.slice(index));
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
 * ダイアログ行の直下、`Esc to cancel` フッターを探す行数。
 * 実測は 2.1.241 / 2.1.281 とも **2 行**（間に空行 1 本）だが、**CLI が案内行を 1 本挿すだけで
 * `/login` 検出が丸ごと落ちる**（= chat 注入の門番が外れてコード欄へ本文を打つ / login_code_send が
 * 「入力待ちではありません」で拒否して詰む）ので余裕を持たせる。狭さで刺されたのが
 * 2026-09-24 の実障害（iOS 側の URL 抽出。窓は 1 行しか余裕が無かった）。
 * 広げた分の誤判定は `hasLoginDialogAnchor`（/login 固有の陽性根拠）で抑える。
 */
const LOGIN_FOOTER_REACH = 6;

/** `/login` ダイアログのタイトル行（実測 2.1.241 / 2.1.281 とも単独行の `Login`）。 */
const LOGIN_TITLE_LINE = "login";

/**
 * タイトル行を marker から上へ探す窓。狭い pane では URL 断片が増えてタイトルが遠のくため広めに取る。
 */
const LOGIN_TITLE_REACH = 24;

/** `/login` のコード入力画面にある URL 案内行（陽性根拠の 1 つ）。 */
const LOGIN_URL_HINT_MARKER = "Use the url below to sign in";

/**
 * `/login` の画面だという**独立した 3 つの陽性根拠**のどれか（iOS `hasLoginAnchor` と同値実装）。
 * marker の上 LOGIN_TITLE_REACH 行以内に、
 * ① 単独行の `Login` タイトル ② `Use the url below to sign in` を含む行
 * ③ `https://` と `/oauth/` を両方含む行（サインイン URL）、のいずれかがあること。
 *
 * OR にするのは、CLI が 1 つを変えても検出が落ちないようにするため（AND だと片方の変更で全滅
 * = 2026-09-24 に直した破損の再来）。逆にフッター（`Esc to cancel`）は根拠に使わない:
 * **Ink の汎用キャンセルフッター**なので `/login` の証拠にならない。根拠が無いと、Ink の折り返しで
 * 行頭に来た本文（`Paste code here if prompted` / `Select login method` / `Press Enter to retry`）と
 * 別ダイアログのフッターが噛み合って `/login` フロー中と誤判定し、chat 注入が
 * 「Claude が /login の途中です」と理由を偽って止まる（`· Tab to amend` 付きの承認ダイアログ、
 * 素の `Esc to cancel` を持つ `Select model` 等、どちらも実測で再現した）。
 *
 * 誤判定の向きについて: ここが厳しすぎて偽陰性になっても、`sendTextSubmit` は続けて
 * `classifySubmitFrame` を見る。**`dialog` は `screenShowsDialogFooter` だけから来る**ので、
 * フッターを持つ 3 面（方式選択 / コード入力待ち / retry）は注入前に必ず止まる。
 * フッターを持たない継続待ち画面だけは `unknown` になって注入が通ってしまうため、
 * `screenShowsDialogFooter` 側に継続待ちの文言を足して穴を塞いでいる（2 周目の実測指摘）。
 * 「バーが無ければ dialog」ではない点に注意 — バー非検出は `unknown` で、注入は通る。
 */
function hasLoginDialogAnchor(lines: string[], markerIndex: number): boolean {
  const start = Math.max(0, markerIndex - LOGIN_TITLE_REACH);
  for (let index = markerIndex - 1; index >= start; index -= 1) {
    const text = (lines[index] ?? "").trim();
    if (text.toLowerCase() === LOGIN_TITLE_LINE) return true;
    if (text.includes(LOGIN_URL_HINT_MARKER)) return true;
    if (text.includes("https://") && text.includes("/oauth/")) return true;
  }
  return false;
}

/**
 * `marker` で始まる行が、生きたダイアログとして画面にあるか（TESTABLE 内部）。
 * 会話本文が同じ文言を行頭に含むだけ（Ink の折り返し・/login の説明文）で発火しないよう、
 * (a) 末尾 LOGIN_TAIL_WINDOW 行以内 (b) 直下 `footerReach` 行以内に `Esc to cancel` フッター
 * (c) `/login` の陽性根拠（`hasLoginDialogAnchor`）、の 3 条件を課す
 * （iOS 側 ClaudeLoginPromptParser.isLiveDialogLine と同じ規則）。
 */
function liveDialogLineIndex(rawLines: string[], marker: string, footerReach: number): number | null {
  // **必ず SGR を落としてから**行頭一致を見る。ANSI 付きキャプチャ（`capture-pane -e` /
  // herdr `--format ansi`）を渡されると行頭がエスケープ列になり、全条件が黙って false になる
  // （= 門番が外れてコード欄へ本文を打つ。呼び出し側の capture 種別に依存しない）。
  const lines = rawLines.map((line) => stripSgr(line));
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
      if (!(lines[below] ?? "").trim().toLowerCase().startsWith("esc to cancel")) continue;
      return hasLoginDialogAnchor(lines, index) ? index : null;
    }
    return null;
  }
  return null;
}

/** 画面が `/login` のコード入力待ちか（TESTABLE）。chat 注入の門番と login_code_send の前提確認に使う。 */
export function screenHasLoginCodePrompt(screen: string): boolean {
  return liveDialogLineIndex(screen.split("\n"), LOGIN_CODE_PROMPT_MARKER, LOGIN_FOOTER_REACH) !== null;
}

function screenHasLoginRetry(screen: string): boolean {
  return liveDialogLineIndex(screen.split("\n"), LOGIN_RETRY_MARKER, LOGIN_FOOTER_REACH) !== null;
}

function screenHasLoginMethodSelect(screen: string): boolean {
  // タイトル行と Esc フッターの間に選択肢（最大 3 行 + 空行）が入る。実測 2.1.281 は 6 行なので
  // 8 のままで足りる（根拠なく広げると誤判定の当たり面だけが広がる）。
  return liveDialogLineIndex(screen.split("\n"), LOGIN_METHOD_MARKER, 8) !== null;
}

/** 成功後の継続待ち（`Login successful. Press Enter to continue…`）が pane 末尾付近にあるか。 */
export function screenHasLoginContinue(screen: string): boolean {
  const lines = screen.split("\n").map((line) => stripSgr(line));
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
    // `Press Enter to continue` 単独は他の CLI / 本文でも出るので、`Login` タイトルを陽性根拠に要求する
    // （これが無いと本文の 1 行で chat 注入が「/login の途中」として恒久ブロックされる。実測で再現）。
    if (text.startsWith("press enter to continue") && hasLoginDialogAnchor(lines, index)) return true;
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
  const lines = screen.split("\n").map((line) => stripSgr(line));
  const tail = lines.slice(-LOGIN_TAIL_WINDOW - 8);
  const rules = tail.filter((line) => isInputBoxRuleLine(line.trim())).length;
  if (rules >= 2) return "accepted";
  // 名前付きの会話は、上の罫線にタイトルが埋まって罫線に数えられない。入力欄の形で読む。
  if (findFrameAbovePrompt(tail) !== null) return "accepted";
  return "pending";
}

/**
 * retry 画面の理由行。`OAuth error` で始まる行（末尾窓内の最後のもの）だけを採用する。
 * 直上行フォールバックは持たない（コードをエコーしたコード欄の行が理由として result / ログへ
 * 漏れる）。念のためコード欄マーカーを含む行は採用しない。
 */
export function loginCodeErrorLine(screen: string): string | null {
  const lines = screen.split("\n").map((line) => stripSgr(line).trim());
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
/**
 * 本文を 1 キーも打つ前に注入を諦めたときのエラー（**非配達が確定**）。
 * hub はこれを `uncertain`（配送不明）に積まず失敗として片付ける: uncertain は
 * 「二重送信が怖くて消せない」分類なので、非配達が確定しているものを積むと
 * 削除不能・後続ブロックのゾンビになる（`sessionHub` の同名コメント参照）。
 */
export class ChatInjectionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatInjectionRejectedError";
  }
}

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
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(tmuxPath, args, {
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
      // 標準入力で渡す本文（`load-buffer -`）。tmux が読まずに終わっても落ちないよう、書き込みの
      // 失敗は握る（結果は exit code で返る）。
      if (input !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(input);
      }
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

/**
 * ボトムバーの**下**に常駐しうる TUI 行か（artifact タブ `\u29c9 <名前>` / agents パネルの
 * `\u23fa main` `\u25ef <agent名>`）。これらを読み飛ばさずに「最下行 = バー」と決め打つと、
 * subagent を走らせている会話でバーを見失う（iOS 側 `shouldSkipTailLine` と同じ規則。
 * 2026-07-29 にライブビュー全滅を起こした実障害と同型）。
 */
function isTrailingTuiLine(line: string): boolean {
  const first = line.trim().codePointAt(0);
  return first === 0x29c9 || first === 0x23fa || first === 0x25ef || first === 0x25cf;
}

/**
 * claude TUI のモード行（ボトムバー）か。`\u23f5\u23f5`=auto/acceptEdits, `\u23f8`=manual/plan の
 * 行頭グリフを必須にする（`shared/permissionMode.ts` と同じ規則）。定型句の部分一致で
 * 拾うと、会話本文やダイアログの選択肢が同じ語（`for agents` 等）を含むだけで誤検出する。
 * 旧版互換で単独の `? for shortcuts` 行も認める。
 */
function isComposerBarLine(line: string): boolean {
  const trimmed = line.trim();
  // シェルモード（入力欄の先頭 `!`）ではバーがモード記号を持たない（実測 2.1.278:
  // `! for shell mode`）。これを外すとシェルモード送信だけ再送判定が効かなくなる。
  if (trimmed.startsWith("!") && trimmed.includes("for shell mode")) return true;
  if (trimmed === "? for shortcuts") return true;
  const first = trimmed.codePointAt(0);
  return first === 0x23f5 || first === 0x23f8;
}

/**
 * ダイアログのフッター行が**画面下部に**出ているか（＝積極的なダイアログ判定）。
 * 実測 2.1.278 の 2 形: 設問/選択は `Enter to select · ↑/↓ to navigate · Esc to cancel`、
 * ツール承認は `Esc to cancel · Tab to amend`。どちらも行頭から始まる。
 *
 * バー非検出（`claudeComposerBarVisible === false`）を「ダイアログ」と見なして送信を拒む
 * 設計は、未知のフレーム（起動直後・制限待ち等）で送信が丸ごと不能になるため採らない。
 * **本文を打つかどうかの門番はこちら（積極判定・見逃しは従来動作）**、
 * **Enter を撃ち直すかどうかはバー検出（fail-closed・見逃しは再送しないだけ）** と役割を分ける。
 * 会話本文の引用で誤検出しないよう、末尾の数行に限り trim 後の行頭一致で見る
 * （`screenHasSelectionFooter` と同じ硬化）。
 */
export function screenShowsDialogFooter(screen: string): boolean {
  return screen
    .split("\n")
    .map((line) => stripSgr(line).trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-DIALOG_FOOTER_WINDOW_LINES)
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("Enter to select") || trimmed.startsWith("Esc to cancel")) return true;
      // `/login` 成功後の継続待ち（`Login successful. Press Enter to continue…`）は**フッターを持たない**。
      // これを落とすと `classifySubmitFrame` が `unknown` になり、注入が通ってしまう:
      // 本文を打って Enter → Enter が継続待ちを閉じて本文は消え、次のフレームでは空の入力欄が
      // 見えるので送信確定ループが `submitted` を返す = **無言の配送済みレシート**
      // （2026-09-24 セルフレビュー 2 周目で実測。ここが `/login` フロー唯一の非フッター面）。
      const lower = trimmed.toLowerCase();
      return lower.startsWith("press enter to continue")
        || (lower.includes("login successful") && lower.includes("to continue"));
    });
}

/** ダイアログのフッターを探す viewport 末尾の行数（フッターは最下段に出る）。 */
const DIALOG_FOOTER_WINDOW_LINES = 4;

/**
 * **Esc で閉じてよい**選択ダイアログ（AskUserQuestion の設問 / ❯ メニュー）が画面下部に出ているか
 * （chat-cancel-choice, TESTABLE）。実測 2.1.283 のフッター:
 * - 設問（1 問）: `Enter to select · ↑/↓ to navigate · Esc to cancel`
 * - 設問（複数問）: `Enter to select · Tab/Arrow keys to navigate · Esc to cancel`
 * - 自由記述欄にフォーカス中: 上に `· ctrl+g to edit in VS Code` が挟まる（80 桁では折り返す）
 *
 * `screenShowsDialogFooter` より狭い: ツール承認（`Esc to cancel · Tab to amend`）と `/login` の
 * 継続待ちは含めない。承認の Esc は「ツールを拒否してターンを止める」で、選択肢を閉じるのとは
 * 重さが違う（承認はアプリの承認モーダルが正規の経路）。
 * 折り返しで `Esc to cancel` が次の行へ落ちるので、同じ行に両方あることは要求しない。
 * Esc は処理中の Claude を中断するキーでもあるため、**ボトムバーが見えているフレームでは
 * 決して true にしない**（本文の引用を末尾窓で拾っても、composer を見ているなら撃たない）。
 */
export function screenShowsCancellableChoice(screen: string): boolean {
  if (claudeComposerBarVisible(screen)) return false;
  return screen
    .split("\n")
    .map((line) => stripSgr(line).trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-DIALOG_FOOTER_WINDOW_LINES)
    .some((line) => line.trim().startsWith("Enter to select"));
}

/**
 * ツール承認ダイアログ（フッター `Esc to cancel · Tab to amend`）が画面下部に出ているか（TESTABLE）。
 * 通常の承認は PreToolUse hook がアプリの承認モーダルで捌き TUI には出ないが、hook の allow を
 * 上書きする Claude Code 自身の安全確認（作業フォルダ外への Artifact 保存・`.claude/` への書き込み等）
 * は TUI に残り、利用者が答えるまで会話が止まる。pane_preview の「静止した入力待ち」として初回
 * フレームから送り、iPhone の転写カードで答えられるようにする（開き直しでもカードが出る）。
 * フッターはカーソルが 1 番目のとき `Esc to cancel · Tab to amend`、2 番目以降へ動かすと
 * `Esc to cancel` 単独になる（実測 2.1.283）ので、行頭の `Esc to cancel` で拾う（`/login` の各画面も
 * 同じフッターだが、そちらも静止した入力待ちとして初回から送る対象なので区別しない）。
 * 判定は `screenShowsCancellableChoice` と同じ硬化（末尾数行・行頭一致・ボトムバーが見えたら偽）。
 */
export function screenShowsApprovalDialog(screen: string): boolean {
  if (claudeComposerBarVisible(screen)) return false;
  return screen
    .split("\n")
    .map((line) => stripSgr(line).trim())
    .filter((line) => line !== "")
    .slice(-DIALOG_FOOTER_WINDOW_LINES)
    .some((line) => line.startsWith("Esc to cancel"));
}

/**
 * 選択ダイアログを Esc で閉じる試行の結果。
 * - `absent`: 閉じるべき選択ダイアログが見えない（1 キーも打っていない）。
 * - `cancelled`: Esc を 1 回打ち、ダイアログが消えたことを確認した。
 * - `stuck`: Esc を打ったが、待ってもダイアログが消えない（または画面を読めない）。
 */
export type ChoiceDialogCancelOutcome = "absent" | "cancelled" | "stuck";

/**
 * 選択ダイアログを Esc で閉じ、消えたことを確認する（tmux / herdr 共通, chat-cancel-choice）。
 *
 * **Esc は 1 回しか打たない**。実測 2.1.283 では設問が複数でも、自由記述欄にフォーカスが
 * あっても 1 回で閉じて 0.3 秒以内に空の入力欄へ戻る。閉じた後の入力欄へもう 1 回届くと
 * 「Esc 2 回」= 巻き戻し（rewind）の画面が開き、続けて打つ本文がそこへ落ちる。
 * 消えたかどうかは読めたフレームだけで判断する（capture 不能を「閉じた」と見なさない）。
 */
export async function cancelChoiceDialog(io: {
  /** 呼び出し側が直前に撮ったフレーム（事前確認の capture 回数を増やさない）。null = 撮れなかった。 */
  screen: string | null;
  capture: () => Promise<string | null>;
  sendEscape: () => Promise<void>;
  /** 既定は `screenShowsCancellableChoice`。herdr は従来の判定窓を渡す。 */
  detect?: (screen: string) => boolean;
  pollMs: number;
  maxPolls: number;
}): Promise<ChoiceDialogCancelOutcome> {
  const detect = io.detect ?? screenShowsCancellableChoice;
  if (io.screen === null || !detect(io.screen)) return "absent";
  await io.sendEscape();
  for (let poll = 0; poll < io.maxPolls; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
    const after = await io.capture();
    if (after !== null && !detect(after)) return "cancelled";
  }
  return "stuck";
}

/** Esc 後にダイアログの消滅を確かめる間隔と回数の既定（合計 約 2.4s）。 */
export const CHOICE_CANCEL_POLL_MS = 300;
export const CHOICE_CANCEL_MAX_POLLS = 8;

/**
 * 設問を閉じて送る指定なのに、入力欄へ戻ったことを画面で確かめられなかったときの拒否文言。
 * hub は「未回答の設問がある」と知っている。判別できない画面へ本文を打つと選択肢へ落ちる。
 */
export const CHAT_BLOCKED_BY_UNREADABLE_CHOICE =
  "設問の画面を確認できなかったため、メッセージを送信しませんでした（少し待って送り直すか、アプリで設問に答えてください）";

/** 設問は閉じたが、その後の入力欄を画面で確かめられなかったときの拒否文言。 */
export const CHAT_BLOCKED_AFTER_CHOICE_CANCELLED =
  "設問は閉じましたが、入力欄を確認できなかったためメッセージを送信しませんでした（送り直してください）";

/**
 * 選択ダイアログを閉じた直後のフレームを、入力欄が描画されるまで撮り直す（tmux / herdr 共通）。
 * 閉じた直後は描画途中でボトムバーが欠け、`unknown` に見えることがある。ここで諦めると
 * 「設問は閉じたのに本文は未送信」になるので、`unknown` の間だけ短く待つ。
 */
export async function settleFrameAfterChoiceCancel(io: {
  capture: () => Promise<string | null>;
  pollMs: number;
  maxPolls: number;
}): Promise<{ screen: string | null; frame: SubmitFrameVerdict }> {
  let screen = await io.capture();
  let frame = classifySubmitFrame(screen);
  for (let poll = 0; poll < io.maxPolls && frame === "unknown"; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
    screen = await io.capture();
    frame = classifySubmitFrame(screen);
  }
  return { screen, frame };
}

/** 選択ダイアログを閉じられなかったときの拒否文言（hub が会話本文へそのまま出す）。 */
export const CHAT_BLOCKED_BY_STUCK_CHOICE =
  "選択肢を閉じられなかったため、メッセージを送信しませんでした（アプリで選択肢に答えるか、Mac 側の画面で閉じてください）";

/**
 * キュー済みの発話の直下に出る「今すぐ送信」ヒント行の状態（chat-send-now, TESTABLE）。
 * - `absent`: ヒント行が無い = CLI のキューに利用者の発話は無い。
 * - `ready`: 既定のキー割り当てのヒントが出ている。
 * - `rebound`: ヒントは出ているが、キー割り当てが既定と違う（利用者が keybindings を変えた）。
 */
export type SendNowHintState = "absent" | "ready" | "rebound";

/** ヒント行の末尾（実測 2.1.283。chord の表記だけが端末で変わる）。 */
const SEND_NOW_HINT_SUFFIX = " to send now";

/**
 * 既定の `chat:sendNow` の表記。tmux は `ctrl+x ctrl+s`、拡張キーを解する端末（herdr）は
 * `ctrl+enter` を出す（どちらの端末でも既定の割り当ては両方生きている）。
 */
const SEND_NOW_DEFAULT_CHORDS = new Set(["ctrl+x ctrl+s", "ctrl+enter"]);

/**
 * chord の表記か（`ctrl+j` / `alt+enter` / `ctrl+x ctrl+k` など。修飾キー + キーが 1〜2 打）。
 * 過去の発話の折り返しが偶然 ` to send now` で終わっただけの行を、割り当て変更と取り違えない。
 */
const CHORD_NOTATION = /^(?:ctrl|alt|shift|meta|cmd|super)\+\S+(?: (?:(?:ctrl|alt|shift|meta|cmd|super)\+)?\S+)?$/;

/** ヒント行を探す viewport 末尾の非空行数（スピナー・Tip・タスク一覧・agents パネルを挟む）。 */
const SEND_NOW_HINT_WINDOW_LINES = 40;

/** ヒント行から上へ、キュー済み発話の `❯` 行を探す行数（折り返した長い発話・複数件のキュー）。 */
const SEND_NOW_QUEUE_WALK_LINES = 40;

/**
 * 画面に「今すぐ送信」のヒントが出ているか。実測 2.1.283 の形:
 *
 * ```
 * ❯ キュー済みの発話（長ければ 2 桁字下げで折り返す）
 *   ctrl+x ctrl+s to send now
 * ✽ Proofing… (9s · ↓ 183 tokens)
 * ────────
 * ❯ Press up to edit queued messages
 * ```
 *
 * 会話本文がこの文言を引用しただけで拾わないよう、**ヒント行のすぐ上がキュー済みの発話**
 * （`❯` で始まる行と、その折り返し）であることを要求する。応答本文は `⏺` で始まるので、
 * 本文中の引用は上へ辿ると先に `⏺` に当たって外れる。
 * 誤検出しても実害は無い（キューが空のときの chord は何もしない。実測）。
 */
export function screenSendNowHint(screen: string): SendNowHintState {
  const lines = screen.split("\n").map((line) => stripSgr(line).trimEnd());
  let scanned = 0;
  for (let index = lines.length - 1; index >= 0 && scanned < SEND_NOW_HINT_WINDOW_LINES; index -= 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    scanned += 1;
    if (!line.startsWith("  ") || !trimmed.endsWith(SEND_NOW_HINT_SUFFIX)) continue;
    if (!lineFollowsQueuedPrompt(lines, index)) continue;
    const chord = trimmed.slice(0, -SEND_NOW_HINT_SUFFIX.length).trim().toLowerCase();
    if (SEND_NOW_DEFAULT_CHORDS.has(chord)) return "ready";
    if (CHORD_NOTATION.test(chord)) return "rebound";
  }
  return "absent";
}

/** `index` の行から上へ折り返し（字下げ行）と空行だけを辿って、`❯` で始まる行に着くか。 */
function lineFollowsQueuedPrompt(lines: string[], index: number): boolean {
  for (let walked = 0, cursor = index - 1; cursor >= 0 && walked < SEND_NOW_QUEUE_WALK_LINES; cursor -= 1) {
    const line = lines[cursor] ?? "";
    if (line.trim() === "") continue;
    walked += 1;
    if (line.codePointAt(0) === 0x276f) return true;
    if (!line.startsWith("  ")) return false;
  }
  return false;
}

/** `sendQueuedNow` の結果（ワイヤーの `chat_send_now_result.status` と同じ 4 値）。 */
export type SendQueuedNowOutcome =
  | { status: "sent" }
  | { status: "nothing_queued" }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export const SEND_NOW_BLOCKED_BY_DIALOG =
  "ダイアログの表示中は「今すぐ送信」できません（アプリで選択肢に答えてからもう一度試してください）";
export const SEND_NOW_BLOCKED_BY_DRAFT =
  "Mac 側の入力欄に入力中の文字があるため「今すぐ送信」しませんでした（その文字ごと送信されるのを防ぐため）";
export const SEND_NOW_BLOCKED_BY_UNREADABLE =
  "画面を確認できなかったため「今すぐ送信」しませんでした（少し待ってもう一度試してください）";
export const SEND_NOW_BLOCKED_BY_REBOUND =
  "Claude Code のキー割り当てが変更されているため「今すぐ送信」できません（chat:sendNow を既定に戻してください）";
export const SEND_NOW_UNCONFIRMED =
  "「今すぐ送信」を送りましたが、届いたことを確認できませんでした";
export const SEND_NOW_EXPIRED_IN_QUEUE =
  "先に送ったメッセージの処理に時間がかかったため「今すぐ送信」しませんでした（もう一度試してください）";

/**
 * chord 後にヒント行の消滅を確かめる間隔と回数の既定（合計 約 6s）。短い発話は 0.7s 以内に消えるが、
 * 貼り付け扱いの長文（約 800 字超）は 4.5s かかった（実測 2.1.283）。届いているのに `failed` を
 * 返すと、利用者は届いた発話をもう一度流そうとする。
 */
export const SEND_NOW_POLL_MS = 300;
export const SEND_NOW_MAX_POLLS = 20;
/** 判別できないフレーム（描画の途中）を撮り直す回数。chord を送る前だけ（合計 約 1.5s）。 */
export const SEND_NOW_SETTLE_POLLS = 5;


/**
 * CLI のキューに溜まっている発話を今すぐ届ける（tmux / herdr 共通, chat-send-now）。
 * CLI の `chat:sendNow` を 1 回送り、ヒント行が消えたことを確かめる。
 *
 * 実測 2.1.283:
 * - ツールの実行中: ツールが背景へ回り、発話は同じターンへ届く（`queued_command`）。
 * - 応答の生成中 / `/` で始まる発話（添付のパス）: そのターンを打ち切り、発話は新しいターンで届く。
 * - キューが空 / アイドル: 何も起きない。
 * - **入力欄に文字がある: その文字ごと送信される**。Mac 側の下書きを勝手に送らないよう、
 *   入力欄が空と確かめられたフレームでだけ送る（fail-closed）。
 */
export async function sendQueuedNow(io: {
  capture: () => Promise<string | null>;
  sendChord: () => Promise<void>;
  pollMs: number;
  maxPolls: number;
  /** 判別できないフレームを撮り直す回数（既定 `SEND_NOW_SETTLE_POLLS`）。 */
  settlePolls?: number;
}): Promise<SendQueuedNowOutcome> {
  let screen = await io.capture();
  let frame = classifySubmitFrame(screen);
  // 描画の途中でバーが欠けたフレームは、少し待つと読める。読めるまで chord は送らない。
  for (let poll = 0; poll < (io.settlePolls ?? SEND_NOW_SETTLE_POLLS) && frame === "unknown"; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
    screen = await io.capture();
    frame = classifySubmitFrame(screen);
  }
  if (frame === "dialog") return { status: "blocked", reason: SEND_NOW_BLOCKED_BY_DIALOG };
  if (screen === null || frame === "unknown") {
    return { status: "blocked", reason: SEND_NOW_BLOCKED_BY_UNREADABLE };
  }
  if (frame === "pending") return { status: "blocked", reason: SEND_NOW_BLOCKED_BY_DRAFT };
  const hint = screenSendNowHint(screen);
  if (hint === "absent") return { status: "nothing_queued" };
  if (hint === "rebound") return { status: "blocked", reason: SEND_NOW_BLOCKED_BY_REBOUND };
  await io.sendChord();
  for (let poll = 0; poll < io.maxPolls; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
    const after = await io.capture();
    if (after !== null && screenSendNowHint(after) === "absent") return { status: "sent" };
  }
  return { status: "failed", reason: SEND_NOW_UNCONFIRMED };
}

/**
 * 画面最下部に composer のボトムバーが出ているか＝「いま見ているのは入力欄であって
 * ダイアログではない」か（TESTABLE。text / ANSI どちらのキャプチャでも使える）。
 *
 * `extractClaudeInputBox` はダイアログ本体の罫線ペアを入力欄と誤認する（実測 2.1.278:
 * 承認ダイアログで `inputBoxRealText` が `"1. Yes"`、設問ダイアログで選択肢全文を返す）。
 * 残存テキスト判定だけで Enter を撃つと選択肢を誤選択する＝ファイル書き込みを勝手に
 * 承認する実害になる。ダイアログのフッター文言を列挙する方式は取りこぼす
 * （承認ダイアログは `Esc to cancel \u00b7 Tab to amend` で `Enter to select` ではない）ため、
 * **バーが見えている時だけ入力欄として信じる** fail-closed 側で判定する。
 * 実測ではダイアログ表示中の viewport にモード行は 1 行も無い（設問・承認とも確認済み）。
 *
 * 判定は「末尾から常駐 TUI 行を読み飛ばした最初の行がバーか」。バーの直下しか見ないので、
 * 会話本文が偶然モード記号で始まっても拾わない。
 */
export function claudeComposerBarVisible(screen: string): boolean {
  const lines = screen
    .split("\n")
    .map((line) => stripSgr(line).trimEnd())
    .filter((line) => line.trim() !== "");
  let index = lines.length - 1;
  while (index >= 0 && isTrailingTuiLine(lines[index] ?? "")) index -= 1;
  const candidate = lines[index];
  if (candidate === undefined) return false;
  if (isComposerBarLine(candidate)) return true;
  // 貼り付けを取り込んだ後の十数秒は、バーの位置が `paste again to expand` に替わる（実測
  // 2.1.283。Mac 側で貼り付けた直後も同じ）。入力欄の罫線が見えているときだけバーの代わりと
  // 認める。認めないと、その間の送信はすべて成立を確認できない（`unknown`）。
  // ダイアログはフッターが先に判定される（実測: 貼り付けの直後に承認・設問が出ると、
  // 案内は残らずダイアログのフッターへ置き換わる）。
  return candidate.trim() === PASTE_EXPAND_HINT && claudeInputBoxRendered(screen);
}

/** 貼り付けを取り込んだ直後、ボトムバーの位置に出る案内（実測 2.1.283）。 */
const PASTE_EXPAND_HINT = "paste again to expand";

/**
 * 送信確定ループ 1 フレーム分の判定（純ロジック, TESTABLE）。
 * - `submitted`: バーが見えていて入力欄に実テキストが無い＝送信が成立した唯一の証拠。
 * - `pending`: バーが見えていて実テキストが残っている＝もう一度 Enter を撃つ。
 * - `dialog`: フッターでダイアログと確認できた。Enter を撃つと選択肢を誤操作する。
 * - `unknown`: capture 不能、またはバーもダイアログも判別できない未知のフレーム。
 *
 * 「撃つな」と「送信できた」を同一視しないため 4 値に分ける（同一視すると capture が
 * 一度失敗しただけで無言の配送済みレシートになる）。薄字のプロンプト提案・プレースホルダーは
 * 実テキストに数えない（提案を残存と誤認して勝手に送信した実障害 2026-09-03 と同じ判定）。
 */
export type SubmitFrameVerdict = "submitted" | "pending" | "dialog" | "unknown";

export function classifySubmitFrame(ansiScreen: string | null): SubmitFrameVerdict {
  if (ansiScreen === null) return "unknown";
  // ダイアログは積極判定を優先する（バーが見えていても選択肢へ Enter を撃たない）。
  if (screenShowsDialogFooter(ansiScreen)) return "dialog";
  if (!claudeComposerBarVisible(ansiScreen)) return "unknown";
  return inputBoxHasRealPendingText(ansiScreen) ? "pending" : "submitted";
}

/** 送信確定ループの結果。`blocked` は本文を 1 キーも打てずに諦めた（非配達が確定）。 */
export type SubmitOutcome = "submitted" | "blocked" | "unconfirmed";

/** 送信確定ループの Enter 再送上限（tmux / herdr 共通）。 */
export const SUBMIT_ATTEMPT_LIMIT = 4;

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
  /** clearInputBox の C-u 1回ごとの反映待ち ms（herdr 側と同じ既定 150ms。テスト注入用）。 */
  private readonly clearKeyDelayMs: number;
  /** 本文送出 → Enter の間隔 ms（Ink の再描画待ち。テスト注入用）。 */
  private readonly submitDelayMs: number;
  /** Enter → 送信成立確認 の間隔 ms（テスト注入用）。 */
  private readonly submitVerifyDelayMs: number;
  /** 選択ダイアログを Esc で閉じた後の消滅確認の間隔 ms（テスト注入用）。 */
  private readonly choiceCancelPollMs: number;
  /** 「今すぐ送信」の chord 後、ヒント行の消滅確認の間隔 ms（テスト注入用）。 */
  private readonly sendNowPollMs: number;
  /** 貼り付けた本文が入力欄に入るのを確かめる間隔と上限 ms（テスト注入用）。 */
  private readonly pastedTextPollMs: number;
  private readonly pastedTextTimeoutMs: number;
  private readonly clearSettleMs: number;
  /** 貼り付けバッファ名の通番。 */
  private pasteSequence = 0;

  constructor(options: {
    runner?: TmuxCommandRunner;
    store?: SessionMetadataStore;
    captureLines?: number;
    protocolVersion?: number;
    loginTiming?: { delayMs?: number; pollMs?: number; settleMs?: number };
    clearKeyDelayMs?: number;
    submitDelayMs?: number;
    submitVerifyDelayMs?: number;
    choiceCancelPollMs?: number;
    sendNowPollMs?: number;
    pastedTextPollMs?: number;
    pastedTextTimeoutMs?: number;
    /** C-u をまとめて打った後、入力欄が変わるのを待つ上限（テスト用に短くできる）。 */
    clearSettleMs?: number;
  } = {}) {
    this.runner = options.runner ?? processTmuxCommandRunner();
    this.store = options.store ?? new SessionMetadataStore();
    this.captureLines = options.captureLines ?? 50;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_V1;
    this.clearKeyDelayMs = options.clearKeyDelayMs ?? 150;
    this.submitDelayMs = options.submitDelayMs ?? 150;
    this.submitVerifyDelayMs = options.submitVerifyDelayMs ?? 700;
    this.choiceCancelPollMs = options.choiceCancelPollMs ?? CHOICE_CANCEL_POLL_MS;
    this.sendNowPollMs = options.sendNowPollMs ?? SEND_NOW_POLL_MS;
    this.pastedTextPollMs = options.pastedTextPollMs ?? PASTED_TEXT_POLL_MS;
    this.pastedTextTimeoutMs = options.pastedTextTimeoutMs ?? PASTED_TEXT_TIMEOUT_TMUX_MS;
    this.clearSettleMs = options.clearSettleMs ?? TYPED_TEXT_CLEAR_SETTLE_MS;
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
    const allMetas = this.store.all();
    // herdr backend のメタは HerdrSessionManager が列挙する（Composite で和を取る）。
    const metas = allMetas.filter((meta) => meta.backend !== "herdr");
    // herdr 担当の名前は tmux の生存集合からも外す。backend 切替前の同名 tmux セッションが
    // 生き残っている間（reaper の idle 回収まで）、ここが backend:"tmux" を確定申告すると
    // Composite の tmux 優先マージで正しい herdr 行（メタ = ルーティング権威）が消え、
    // iOS の観測が tmux に固定される（cwd/会話 id も欠けて稼働中ピルの join からも落ちる）。
    const herdrNames = new Set(
      allMetas.filter((meta) => meta.backend === "herdr").map((meta) => meta.name),
    );

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

    const names = new Set<string>([...alive].filter((name) => !herdrNames.has(name)));
    for (const meta of metas) names.add(meta.name);

    // backend は tmux も常に明示する。iOS は欄なしを「host 未申告」として既知の観測値を
    // 保持するため、欄の省略を tmux の意味に使わない（session-backend）。
    const infos: SessionInfo[] = [...names].map((name) => ({
      name,
      cwd: cwdByName.get(name) ?? "",
      alive: alive.has(name),
      backend: "tmux" as const,
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
    return { kind: "attached", info: { name, cwd, alive: true, backend: "tmux" }, recentOutput: recent };
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
  async sendTextSubmit(name: string, text: string, options: SendTextSubmitOptions = {}): Promise<void> {
    const startedAtMs = Date.now();
    // 1 回の capture で「/login フロー中か」と「残存テキスト」を判定する（chat 毎の capture を増やさない）。
    const screen = await this.captureVisibleScreenOrNull(name);
    // `/login` フロー中（方式選択 / コード入力待ち / retry）は通常の入力欄が無く、注入した本文が
    // 選択リストやコード欄へ入る。明示エラーで chat_send を失敗させる（コードは login_code_send、
    // 再試行/中断は pane_key_send の専用経路）。
    if (screen !== null && screenInLoginFlow(screen)) {
      throw new LoginCodeError(CHAT_BLOCKED_BY_LOGIN_PROMPT);
    }
    // 中断（停止）直後の入力欄に残存テキストがあるまま注入すると、今回の本文がその後ろへ連結され
    // 1 メッセージになる（実機FB 2026-07-29）。残存の身元で扱いを分ける（herdr 側と同じ規則）:
    // - transcript の直近の発話と同文 = 出力前の中断で claude が書き戻した「配送済みの発話」
    //   → 破棄（C-u）。Enter で送り直すと同じ発話が二重に届く（実機 2026-09-08）。
    // - それ以外（旧版の queued 書き戻し / Mac 側の下書き）→ 従来どおり Enter で独立送信し切る。
    // 判定は ANSI で行い、薄字（faint）のプロンプト提案/プレースホルダーを実テキストと
    // 数えない（実障害 2026-09-03: 提案を残留と誤認し Enter で勝手に送信していた）。
    // 残存の有無は **composer フレームでだけ** 意味を持つ。ダイアログ表示中の
    // `inputBoxRealText` はカーソル行（`1. Yes` 等）を返すので、これを残存と信じて
    // Enter を撃つと選択肢を誤確定する（実測 2.1.278）。
    let ansiScreen = await this.captureVisibleScreenAnsiOrNull(name);
    let frame = classifySubmitFrame(ansiScreen);
    if (frame === "dialog" && options.cancelChoiceDialog === true) {
      // 利用者が「選択肢に答えずにメッセージを送る」と決めた送信（chat-cancel-choice）。
      // 選択ダイアログなら Esc で閉じ、消えたのを確かめてから入力欄へ流す（Mac 側で手動 Esc
      // するのと同じ操作）。承認ダイアログ / `/login` の継続待ちは `absent` になり、下の拒否へ落ちる。
      const outcome = await cancelChoiceDialog({
        screen: ansiScreen,
        capture: () => this.captureVisibleScreenAnsiOrNull(name),
        sendEscape: () => this.sendKeys(name, ["Escape"]),
        pollMs: this.choiceCancelPollMs,
        maxPolls: CHOICE_CANCEL_MAX_POLLS,
      });
      if (outcome !== "absent") {
        const settled = await settleFrameAfterChoiceCancel({
          capture: () => this.captureVisibleScreenAnsiOrNull(name),
          pollMs: this.choiceCancelPollMs,
          maxPolls: outcome === "cancelled" ? CHOICE_CANCEL_MAX_POLLS : 0,
        });
        ansiScreen = settled.screen;
        frame = settled.frame;
      }
      if (outcome === "cancelled") options.onChoiceDialogCancelled?.();
      // Esc は打ったが閉じない。ここで本文を打つとダイアログへ落ちるので、何も打たずに諦める
      // （Esc 自体は選択肢を確定しない。非配達は確定している）。
      if (outcome === "stuck" && frame === "dialog") {
        throw new ChatInjectionRejectedError(CHAT_BLOCKED_BY_STUCK_CHOICE);
      }
      if (outcome === "cancelled" && frame === "unknown") {
        throw new ChatInjectionRejectedError(CHAT_BLOCKED_AFTER_CHOICE_CANCELLED);
      }
    }
    if (options.cancelChoiceDialog === true && frame === "unknown") {
      // 設問がある前提の送信は fail-closed: 入力欄（ボトムバー）が見えたときだけ打つ。
      // 指定の無い送信は従来どおり（未知フレームで送信が丸ごと不能にならないよう fail-open）。
      throw new ChatInjectionRejectedError(CHAT_BLOCKED_BY_UNREADABLE_CHOICE);
    }
    if (frame === "dialog") {
      // 本文を 1 キーも打たずに諦める（ダイアログへ打ち込むより確実に安全）。
      // 非配達が確定しているので、hub は uncertain に積まず失敗として片付ける。
      // 見逃し側（未知フレーム）は従来どおり注入へ進む＝送信が丸ごと不能にはならない。
      throw new ChatInjectionRejectedError(
        "ダイアログの表示中はメッセージを送信できません（アプリで選択肢に答えてから送り直してください）",
      );
    }
    const pending = frame === "pending" ? (inputBoxRealText(ansiScreen ?? "") ?? "") : "";
    if (pending.length > 0) {
      const recorded = options.recordedPromptText?.() ?? null;
      if (recorded !== null && inputBoxTextMatchesRecordedPrompt(pending, recorded)) {
        if (!(await this.clearInputBox(name))) {
          throw new TmuxFailedError(
            ["send-keys", "-t", this.paneTarget(name), "C-u"],
            1,
            "restored prompt could not be cleared from the input box (中断で書き戻された発話が残存)",
          );
        }
      } else if ((await this.submitTypedText(name)) !== "submitted") {
        // 残存を送信し切れないまま本文を打つと、今回の本文が残存の後ろへ連結されて
        // 1 メッセージになる（実機FB 2026-07-29）。2.1.277+ は残存に不可視文字があると
        // 1 回目の Enter で送信せず確認待ちにするため、裸の Enter 1 発では流し切れない。
        // 流せなかったら何も打たずに失敗させ、明示再送へ倒す（「重複より欠落」）。
        throw new ChatInjectionRejectedError(
          "入力欄に残っていた文字を送り切れなかったため、メッセージを送信しませんでした（連結送信の防止）",
        );
      }
    }
    // 入力欄がシェルモード（プロンプト `!`）のまま残っていると、注入した通常メッセージが
    // そのままシェルコマンドとして実行される。空入力の Backspace（tmux キー名は BSpace）で
    // 記号を消して通常入力へ戻す。`!` 始まりの本文は注入時に自分でシェルモードへ入るので、
    // 常に通常モードから始めるのが決定的で安全（herdr 側 exitShellMode と同じ防御）。
    await this.exitShellMode(name);
    let pasted: PasteOutcome = "arrived";
    if (tmuxTypedTextWouldBreak(text) && textIsPasteSafe(text) && typedTextProbe(text) !== null) {
      // 1 回で打つと壊れる本文は、小分けの括弧付き貼り付けで渡す（long-text-paste）。
      // 入ったのを確かめられなくても、打つ場合と同じく送信確定へ進む（画面を読めないだけの
      // ことがある。Enter は貼り付けの後ろに並ぶので、途中までの本文が送信されることは無い）。
      pasted = await pasteTextInline(text, {
        paste: (pieces) => this.pasteBracketed(name, pieces),
        capture: () => this.captureVisibleScreenAnsiOrNull(name),
        sendKills: (count) => this.sendKeys(name, Array.from({ length: count }, () => "C-u")),
        pollMs: this.pastedTextPollMs,
        timeoutMs: this.pastedTextTimeoutMs,
        clearDelayMs: this.clearKeyDelayMs,
        clearSettleMs: this.clearSettleMs,
        verifyDeadlineMs: startedAtMs + INJECT_VERIFY_BUDGET_MS,
      });
    } else {
      await this.sendKeys(name, [text], true);
    }
    const outcome = await this.submitTypedText(name);
    // 入ったのを確かめられなかった貼り付けは、送信確定が成立に見えても未確認として残す
    // （止まっている CLI の画面は、空の入力欄のまま変わらない）。
    if (outcome !== "submitted" || pasted === "unverified") options.onUnconfirmedSubmit?.();
  }

  /**
   * 小分けにした本文を、1 つずつ括弧付き貼り付けとして pane へ渡す（long-text-paste）。
   * 本文は標準入力から tmux の貼り付けバッファへ載せる（`load-buffer -`）。引数で渡すと、tmux は
   * 末尾の `;` をコマンドの区切りとして落とし、約 16KB を超えると `command too long` で失敗する
   * （実測 tmux 3.7）。`paste-buffer -p` で括弧を付け、`-r` で改行を LF のまま渡す（`-r` が無いと
   * LF を CR に置き換える）。`-d` で貼った後にバッファを消す。バッファ名は呼び出しごとに変える
   * （並行する注入と取り違えない）。
   */
  private async pasteBracketed(name: string, pieces: string[]): Promise<void> {
    const target = this.paneTarget(name);
    for (const piece of pieces) {
      this.pasteSequence += 1;
      const buffer = `tailii-${process.pid}-${this.pasteSequence}`;
      const args = ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-r", "-d", "-b", buffer, "-t", target];
      const result = await this.runner(args, piece);
      if (result.exitCode !== 0) {
        // 載せたまま貼れなかったバッファを残さない（本文が tmux に残る）。
        await this.runner(["delete-buffer", "-b", buffer]).catch(() => undefined);
        throw new TmuxFailedError(args, result.exitCode, result.stderr);
      }
    }
  }

  /**
   * CLI のキューに溜まっている発話を今すぐ届ける（chat-send-now, SessionBackend 共通面）。
   * `C-x C-s` は 1 回の send-keys で続けて送る（chord を分断しない）。
   */
  async sendQueuedNow(name: string): Promise<SendQueuedNowOutcome> {
    return sendQueuedNow({
      capture: () => this.captureVisibleScreenAnsiOrNull(name),
      sendChord: () => this.sendKeys(name, ["C-x", "C-s"]),
      pollMs: this.sendNowPollMs,
      maxPolls: SEND_NOW_MAX_POLLS,
    });
  }

  /**
   * 入力済みの本文を Enter で送信し、成立を確認するまで上限つきで Enter を撃ち直す
   * （herdr 側 `sendTextSubmit` の送信確定ループと同型）。
   *
   * 1 回の Enter では送信が成立しない既知の経路:
   * - **不可視文字の確認待ち（2.1.277+）**: 本文にゼロ幅文字などが含まれていると、最初の
   *   Enter は送信せず除去だけ行い、「Removed N invisible characters · review and press
   *   Enter to send」を出して入力欄に本文を残す（2.1.278 実測）。旧実装はここで戻っていたため、
   *   本文が入力欄に滞留したまま iOS へ配送済みレシートを返し、次の送信の冒頭 flush で
   *   ようやく 1 通遅れて届いていた。
   * - Ink の再描画中に CR が飲まれる場合（herdr で実測済みの同型事象）。
   *
   * 送信済みの空入力への Enter は no-op なので、余分な Enter で二重送信にはならない。
   * 打ち切り判定は `submitSettledFromScreen`（同一フレームから「ダイアログでない」＋
   * 「実テキストが無い」を導く fail-closed 判定）に委ね、herdr 側と同じ規則を共有する。
   *
   * 待ち時間は固定 700ms（`submitVerifyDelayMs`）で、短周期ポーリングにはしない:
   * 描画途中のフレームを捕まえるとボトムバーが欠けて「ダイアログ」と誤判定し、
   * 撃ち直すべき場面で黙って打ち切ってしまう（＝この修正が潰した不具合の再発）。
   * 1 通あたり約 +850ms のコストは iOS の ACK 予算 18s の内側に収まる。
   *
   * 割り切り: ループ中（約 0.85〜3.4s）に Mac 側で打ち始めた下書きは「未送信テキスト」に
   * 見えるため Enter で送られ得る（herdr では既存の挙動）。冒頭の残存判定が先に効くので窓は狭い。
   *
   * @returns 送信成立を確認できたら true。上限まで撃っても確認できなければ false
   *   （呼び出し側が `onUnconfirmedSubmit` で監査ログへ残す。throw はしない — 実際には
   *   送信済みかもしれない本文を明示再送へ倒すと二重送信になるため）。
   */
  private async submitTypedText(name: string): Promise<SubmitOutcome> {
    for (let attempt = 0; attempt < SUBMIT_ATTEMPT_LIMIT; attempt += 1) {
      // **撃つ前に必ずフレームを見る**。ダイアログ表示中・判定不能のまま Enter を撃つと
      // 選択肢を誤操作する（承認ダイアログならファイル書き込みを勝手に承認する）。
      const before = classifySubmitFrame(await this.captureVisibleScreenAnsiOrNull(name));
      if (before === "dialog") return "blocked";
      // 「撃つ前に入力欄が空」は送信成立の証拠にならない（本文を打った直後にこれなら、
      // 打鍵が入力欄へ届いていない＝ RC limbo 等）。打ち切らずに Enter は必ず 1 回撃つ
      // （空 composer への Enter は no-op。薄字の提案は実テキストに数えないので送らない）。
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
      await this.sendKeys(name, ["Enter"]);
      await new Promise((resolve) => setTimeout(resolve, this.submitVerifyDelayMs));
      const after = classifySubmitFrame(await this.captureVisibleScreenAnsiOrNull(name));
      if (after === "submitted") return "submitted";
      // 撃った**後**にダイアログが出たのは、本文が送られてそれが開いた場合
      // （`/remote-control` など）。送信は成立しているので打ち切る。
      if (after === "dialog") return "submitted";
      // 未知のフレームでは撃ち続けない（従来どおり Enter 1 発で止め、未確定として報告する）。
      if (before === "unknown" || after === "unknown") return "unconfirmed";
    }
    return "unconfirmed";
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
   * 入力欄を空にする（中断で書き戻された配送済み発話の破棄用, restored-prompt-discard）。
   * C-u(kill-line) を繰り返す（herdr 側 clearInputBox と同じ規則: 多行本文は末尾行→改行の順に
   * 消え 2N-1 回で必ず空になる。Backspace は本文の実文字を削るため使わない）。空にできたら true。
   * 入力欄が見えない / 上限回数で空にならない / capture 失敗は false（呼び出し側は注入を諦めて
   * 明示再送へ倒す。残存の上へ重ね打ちして連結送信するよりよい）。
   */
  async clearInputBox(name: string): Promise<boolean> {
    try {
      let first: string | null = null;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const ansiScreen = await this.captureVisibleScreenAnsiOrNull(name);
        const realText = ansiScreen === null ? null : inputBoxRealText(ansiScreen);
        if (realText === null) return false;
        if (realText.replace(/\s+/g, "").length === 0) return true;
        first ??= realText;
        await this.sendKeys(name, ["C-u"]);
        await new Promise((resolve) => setTimeout(resolve, this.clearKeyDelayMs));
      }
      const ansiScreen = await this.captureVisibleScreenAnsiOrNull(name);
      const realText = ansiScreen === null ? null : inputBoxRealText(ansiScreen);
      if (realText === null) return false;
      if (realText.replace(/\s+/g, "").length === 0) return true;
      // 消えてはいるが行が多い（9 行以上の本文は 15 回では消し切れない）。進んでいる限り続ける。
      // 1 字も消えていない残存（C-u の効かない中身）には、これ以上打たない。
      if (realText === first) return false;
      return await clearTypedInput(CLEAR_UNKNOWN_INPUT_BOUND, {
        capture: () => this.captureVisibleScreenAnsiOrNull(name),
        sendKills: (count) => this.sendKeys(name, Array.from({ length: count }, () => "C-u")),
        clearDelayMs: this.clearKeyDelayMs,
        clearSettleMs: this.clearSettleMs,
      });
    } catch {
      return false;
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
    // 判定不能は fail-open で null（残留 flush 判定を止めない）。exitCode≠0 だけでなく
    // runner の reject（spawn 失敗など）も握る（text 側 captureVisibleScreenOrNull と同じ約束）。
    try {
      const args = ["capture-pane", "-p", "-e", "-t", this.paneTarget(name)];
      const result = await this.runner(args);
      if (result.exitCode !== 0) return null;
      const lines = result.stdout.split("\n");
      while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
        lines.pop();
      }
      return lines.join("\n");
    } catch {
      return null;
    }
  }

  /** SessionBackend: プロンプト提案抽出用の viewport ANSI キャプチャ（失敗は throw）。 */
  async captureVisibleAnsi(name: string): Promise<string> {
    validateSessionName(name);
    const args = ["capture-pane", "-p", "-e", "-t", this.paneTarget(name)];
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

  /** 指定セッションの pane へ tmux send-keys を発行する（literal は -l）。 */
  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    validateSessionName(name);
    if (keys.length === 0) return;
    const target = this.paneTarget(name);
    const run = async (args: string[]): Promise<void> => {
      const result = await this.runner(args);
      if (result.exitCode !== 0) throw new TmuxFailedError(args, result.exitCode, result.stderr);
    };
    if (!literal) {
      await run(["send-keys", "-t", target, ...keys]);
      return;
    }
    // literal は `--` で引数終端を明示する（先頭が `-` の本文 — base64url の OAuth コード等 —
    // を tmux がフラグと誤認して `unknown flag` で失敗する）。
    // 末尾が `;` の引数は、tmux がコマンドの区切りとして `;` を落とす（実測 tmux 3.7:
    // `abc;` → `abc`）。末尾の `;` は切り離し、文字コード（`-H 3b`）で打つ。
    if (!keys.some((key) => key.endsWith(";"))) {
      await run(["send-keys", "-t", target, "-l", "--", ...keys]);
      return;
    }
    for (const key of keys) {
      const body = key.replace(/;+$/, "");
      if (body !== "") await run(["send-keys", "-t", target, "-l", "--", body]);
      const semicolons = key.length - body.length;
      if (semicolons > 0) await run(["send-keys", "-t", target, "-H", ...Array.from({ length: semicolons }, () => "3b")]);
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
