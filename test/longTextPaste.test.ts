// longTextPaste.test.ts
// 1 回で打つと壊れる本文を、小分けの括弧付き貼り付けで渡す（long-text-paste）。
// CLI（実測 2.1.284）は 1 回の読み取りで 800 字を超える入力を貼り付けとして扱う。意図しない
// 貼り付けは読み取りの境界で分かれて届き、先頭が欠けたり、herdr の反映検証を失敗させたりする。
// 1 つが 800 字以下・改行 2 個以下の貼り付けは、畳まれずに本文のまま入力欄へ入る。
// フレーム判定は実機の無加工キャプチャ（`test/fixtures/pane/*.ansi`）で検証する。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { HerdrSessionManager, type HerdrCommandResult, type HerdrCommandRunner } from "../src/backend/herdr.js";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  ChatInjectionRejectedError,
  CHAT_BLOCKED_BY_UNTYPED_TEXT,
  classifySubmitFrame,
  extractClaudeInputBox,
  clearTypedInput,
  INLINE_PASTE_MAX_BYTES,
  INLINE_PASTE_MAX_CHARS,
  INLINE_PASTE_MAX_NEWLINES,
  inputBoxRealText,
  loginCodeScreenState,
  inputBoxTextIncludesProbe,
  inputBoxTextMatchesRecordedPrompt,
  matchInputBoxAgainstText,
  normalizeTextForPaste,
  pastedTextArrived,
  pastedTextPartlyArrived,
  pasteTextInline,
  screenShowsPasteHint,
  splitForInlinePaste,
  textIsPasteSafe,
  TmuxFailedError,
  TmuxSessionManager,
  tmuxTypedTextWouldBreak,
  typedTextWouldBreak,
  type PastedTextIo,
} from "../src/backend/tmux.js";
import { extractTurn } from "../src/chat/transcriptTailer.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { unwrapPastedContent } from "../src/shared/pastedContent.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok } from "./helpers.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pane");

function frame(name: string): string {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.ansi`), "utf8").split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

/** 1 行 1000 字を貼り付けた直後。入力欄は `[Pasted text #16]`、バーの位置は案内。 */
const PASTED_SINGLE = frame("typed-paste-placeholder");
/** 30 行 1665 字を括弧付きで貼り付けた直後。入力欄は `[Pasted text #20 +29 lines]`。 */
const PASTED_MULTILINE = frame("pasted-multiline");
/** 貼り付けた発話を送り、出力の前に中断した直後。`[Pasted text #22]` として書き戻される。 */
const PASTED_RESTORED = frame("pasted-restored");
/**
 * 1200 字を 1 回で打った直後（括弧なし。直前の貼り付けの案内が出ていた）。先頭の 1022 字は
 * 入力欄に入らず、残りの 178 字だけが本文として入っている。
 */
const TYPED_DROPPED_HEAD = frame("typed-as-paste");

/**
 * 小分けの括弧付き貼り付けで渡した直後（2.1.284）。入力欄には本文がそのまま入り、末尾側が
 * 映っている。バーは通常のまま（案内は出ない）。
 */
const INLINE_MULTILINE = frame("pasted-inline-multiline");
const INLINE_TABS = frame("pasted-inline-tabs");
const INLINE_ASCII = frame("pasted-inline-ascii");
/** 30 行のうち 11 行まで入った時点。各行の終わりは最終行と同じ文言。 */
const INLINE_PARTIAL = frame("pasted-inline-partial");

/**
 * 約 10000 字を超える本文を渡した直後（2.1.284）。入力欄は「先頭 500 字 + 置き換えの表示 + 末尾」。
 * `-lines` は 200 行の本文（置き換えの表示は映っている範囲の上にあり、末尾の行だけが映る）。
 */
const INLINE_TRUNCATED = frame("pasted-inline-truncated");
const INLINE_TRUNCATED_LINES = frame("pasted-inline-truncated-lines");
const TRUNCATED_TEXT = `Reply only with OK. ${Array.from({ length: 9000 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ").slice(0, 10500)}`;
const TRUNCATED_LINES_TEXT = `Reply only with OK.\n${Array.from({ length: 200 }, (_, i) => `L${String(i + 1).padStart(3, "0")} ${"abcdefghij".repeat(4)} end${i}`).join("\n")}`;

/**
 * tmux の画面が崩れた後に、30 行を小分けの貼り付けで渡した直後（2.1.284）。肌色付きの ✌🏽 を含む
 * 発話を表示した後、入力欄が 1 行ずれ、下の罫線の位置に空の `❯` が出る。本文は入力欄に入って
 * いるが、画面からは入力欄として読めない。
 */
const INLINE_SHIFTED = frame("pasted-inline-shifted");

/**
 * 罫線だけの行を含む本文を渡した直後（2.1.284）。入力欄の中の `  ──────────` は字下げされていて、
 * 枠の罫線（行頭から始まる）とは違う。
 */
const INLINE_RULE_LINE = frame("pasted-inline-rule-line");
const RULE_LINE_TEXT = "Reply only with OK.\tX\n──────────\n以上";

/**
 * 名前付きの会話（`/rename` 済み。2.1.284）。上の罫線にタイトルが右寄せで埋まり、行末の罫線は
 * 1 個だけ（`────…──── chk12-title ─`）。`-history` は履歴に `❯` の行や応答がある画面。
 */
const NAMED_IDLE = frame("named-idle");
const NAMED_IDLE_HERDR = frame("named-idle-herdr");
const NAMED_HISTORY = frame("named-history");
const NAMED_RULE_LINE = frame("named-pasted-rule-line");
const NAMED_MULTILINE = frame("named-pasted-multiline");

/**
 * タイトルの長い名前付きの会話（2.1.284）。タイトルの表示幅が「pane の幅 − 5」以上になると、上の
 * 罫線は行頭の罫線が 3 個に届かない（`─ <タイトル> ─`。さらに長いと ` <タイトル>… ─`）。
 * `-draft-statusline` は、入力欄に下書きがあり、下に statusLine の行（`  ───── haiku │ main ─`）が
 * 出ている画面。
 */
const NAMED_LONG_IDLE = frame("named-long-idle");
const NAMED_LONG_TRUNCATED = frame("named-long-truncated");
const NAMED_LONG_HISTORY = frame("named-long-history");
const NAMED_LONG_DRAFT_STATUSLINE = frame("named-long-draft-statusline");
/**
 * タイトルの長い会話で、履歴に行頭（0 桁目）から罫線で始まる行が見えている画面（2.1.285）。
 * スラッシュコマンドの控えは、折り返した続きの行が字下げされない（`/rename <長い名前> ───────
 * tail` の控えの 2 行目が `─────── tail`）。`-draft` は入力欄に 3 行の下書き（空行と、罫線で
 * 始まる行を含む）がある画面。
 */
const NAMED_LONG_HISTORY_RULE = frame("named-long-history-rule");
const NAMED_LONG_HISTORY_RULE_DRAFT = frame("named-long-history-rule-draft");
/**
 * 肌色付きの絵文字（✌🏽）を含む発話の後で、tmux の画面が崩れた形（2.1.285）。下の枠が消え、その
 * 位置に空の `❯` が出る。履歴には行頭からの罫線（スラッシュコマンドの控えの折り返し）が見えている。
 * `named-long-` はタイトルの長い会話。
 */
const NAMED_SHIFTED_HISTORY_RULE = frame("named-shifted-history-rule");
const NAMED_LONG_SHIFTED_HISTORY_RULE = frame("named-long-shifted-history-rule");
/** 名前付きの会話で、シェルモード（プロンプトが `!`）のまま入力欄が空の画面（2.1.285）。 */
const NAMED_SHELL = frame("named-shell");

const words = (count: number): string =>
  Array.from({ length: count }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ");
const LONG_ASCII = words(250).slice(0, 1200);
const LONG_MULTILINE = ["Reply only with OK. Lines follow.",
  ...Array.from({ length: 29 }, (_, i) => `L${String(i + 1).padStart(3, "0")} ${"abcdefghij".repeat(5)}`)].join("\n");
const LONG_JAPANESE = "これは長い日本語の本文です。".repeat(180);

const TAB_CODE = Array.from({ length: 24 }, (_, i) => `func f${i}() {\n\tif x > ${i} {\n\t\treturn ${i}\n\t}\n}`).join("\n");
/** 貼り付けたタブは、空白 4 個になって入力欄に入る。 */
const spaced = (text: string): string => text.replaceAll("\t", "    ");

describe("typedTextWouldBreak", () => {
  test("1 回の読み取りが貼り付けの境界に近づく本文（英数字中心の長文）は真", () => {
    expect(typedTextWouldBreak("x".repeat(699))).toBe(false);
    expect(typedTextWouldBreak("x".repeat(700))).toBe(true);
    expect(typedTextWouldBreak(LONG_ASCII)).toBe(true);
    expect(typedTextWouldBreak(LONG_MULTILINE)).toBe(true);
  });

  test("日本語中心の長文は、1 回の読み取りが 1022 バイトなら何千字でも偽（約 340 字で頭打ち）", () => {
    expect(LONG_JAPANESE.length).toBeGreaterThan(2500);
    expect(typedTextWouldBreak(LONG_JAPANESE, 1022)).toBe(false);
    expect(typedTextWouldBreak("😀".repeat(2000), 1022)).toBe(false);
  });

  test("1 回の読み取りが大きい環境（Linux の pty）では、日本語の長文も真", () => {
    expect(typedTextWouldBreak(LONG_JAPANESE, 4095)).toBe(true);
    expect(typedTextWouldBreak("これは短い本文です。".repeat(60), 4095)).toBe(false);
  });

  test("日本語の長文の途中に英数字の塊があれば真（どの位置の読み取りでも数える）", () => {
    expect(typedTextWouldBreak(`${"前置き。".repeat(300)}${"y".repeat(750)}${"後書き。".repeat(300)}`, 1022)).toBe(true);
    // 英数字と日本語が細かく混ざっていて、1022 バイトの中に 700 字が入らない本文は偽。
    expect(typedTextWouldBreak("abc あいう ".repeat(400), 1022)).toBe(false);
  });

  test("タブを含む本文は、短くても真（打ったタブは入力欄に入らない）", () => {
    expect(typedTextWouldBreak("\tif x > 0 {\n\t\treturn x\n\t}")).toBe(true);
    expect(typedTextWouldBreak("a\tb")).toBe(true);
    expect(typedTextWouldBreak(TAB_CODE)).toBe(true);
    expect(typedTextWouldBreak(spaced("\tif x > 0 {\n\t\treturn x\n\t}"))).toBe(false);
  });

  test("打つとキー操作として効く文字（CR・DEL など）を含む本文は、短くても真", () => {
    expect(typedTextWouldBreak("1 行目\r\n2 行目")).toBe(true);
    expect(typedTextWouldBreak("1 行目\r2 行目")).toBe(true);
    expect(typedTextWouldBreak("second line\u007f")).toBe(true);
    expect(typedTextWouldBreak("a\u2028b")).toBe(true);
    expect(typedTextWouldBreak("a\u009bb")).toBe(true);
    // LF だけの多行と、不可視文字（ゼロ幅）は従来どおり打つ。ESC は貼り付けない（`textIsPasteSafe`）。
    expect(typedTextWouldBreak("1 行目\n2 行目")).toBe(false);
    expect(typedTextWouldBreak("a\u200bb")).toBe(false);
    expect(typedTextWouldBreak("色 \u001b[31m赤")).toBe(false);
  });

  test("短い本文は偽", () => {
    expect(typedTextWouldBreak("")).toBe(false);
    expect(typedTextWouldBreak("短い本文")).toBe(false);
    expect(typedTextWouldBreak("return a;")).toBe(false);
  });

  test("tmux は、引数の上限（約 16KB）に近づく本文も貼り付けで渡す", () => {
    const japanese = "あ".repeat(4001);
    expect(typedTextWouldBreak(japanese, 1022)).toBe(false);
    expect(Buffer.byteLength(japanese)).toBeGreaterThan(12_000);
    expect(tmuxTypedTextWouldBreak(japanese)).toBe(true);
    expect(tmuxTypedTextWouldBreak("あ".repeat(4000))).toBe(typedTextWouldBreak("あ".repeat(4000)));
  });
});

describe("textIsPasteSafe", () => {
  test("ESC を含む本文は貼り付けない（途中の終了記号で貼り付けが終わる）", () => {
    expect(textIsPasteSafe(LONG_ASCII)).toBe(true);
    expect(textIsPasteSafe(`${LONG_ASCII}${BRACKETED_PASTE_END}rm -rf /`)).toBe(false);
    expect(textIsPasteSafe(`色付き \u001b[31m赤\u001b[0m`)).toBe(false);
  });
});

describe("splitForInlinePaste", () => {
  const newlines = (piece: string): number => piece.split("\n").length - 1;
  const samples = [
    LONG_ASCII, LONG_MULTILINE, LONG_JAPANESE, TAB_CODE,
    "a\n\n\nb\n", "\n\n先頭が空行", "末尾が空白   ", "x".repeat(INLINE_PASTE_MAX_CHARS * 3 + 1),
    "cafe\u0301 か\u3099 ".repeat(200), "👨‍👩‍👧 　全角空白 語 ".repeat(120), "😀".repeat(900),
  ];

  test("つなげると元の本文に戻る", () => {
    for (const text of samples) expect(splitForInlinePaste(text).join("")).toBe(text);
    expect(splitForInlinePaste("")).toEqual([]);
  });

  test("1 つは、畳まれない大きさ（字数・改行の数）に収まる", () => {
    // CLI が畳む境界（801 字・改行 3 個）より手前。
    expect(INLINE_PASTE_MAX_CHARS).toBeLessThan(800);
    expect(INLINE_PASTE_MAX_NEWLINES).toBeLessThan(3);
    for (const text of samples) {
      for (const piece of splitForInlinePaste(text)) {
        expect(piece.length).toBeGreaterThan(0);
        expect(piece.length).toBeLessThanOrEqual(INLINE_PASTE_MAX_CHARS);
        // 括弧（12 バイト）を足しても、CLI の 1 回の読み取り（1022 バイト）に収まる。
        expect(Buffer.byteLength(piece) + 12).toBeLessThanOrEqual(1022);
        expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(INLINE_PASTE_MAX_BYTES);
        expect(newlines(piece)).toBeLessThanOrEqual(INLINE_PASTE_MAX_NEWLINES);
      }
    }
  });

  test("短い 1 行はそのまま 1 つ。行ごとに分かれる", () => {
    expect(splitForInlinePaste("短い本文")).toEqual(["短い本文"]);
    expect(splitForInlinePaste("1 行目\n2 行目\n3 行目")).toEqual(["1 行目\n", "2 行目\n", "3 行目"]);
    expect(splitForInlinePaste("a\n\nb")).toEqual(["a\n", "\n", "b"]);
  });

  test("書記素の途中では分けない（結合文字・ZWJ でつないだ絵文字・サロゲートの対）", () => {
    const graphemes = (text: string): string[] =>
      Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
    for (const text of ["cafe\u0301".repeat(300), "👨‍👩‍👧".repeat(300), "😀".repeat(900), "か\u3099".repeat(700)]) {
      const pieces = splitForInlinePaste(text);
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.flatMap(graphemes)).toEqual(graphemes(text));
    }
  });

  test("拡張子の付いた語を、1 つの貼り付けの中に丸ごと入れない（画像のパスは添付に置き換わる）", () => {
    const image = "/Users/me/.tailii/uploads/shot-1.png";
    const other = "/Users/me/.tailii/uploads/IMG_0002.JPEG";
    const holdsExtension = (piece: string): boolean => /\.[0-9A-Za-z]{2,5}(?:["'\s]|$)/.test(piece);
    for (const text of [
      image, `${image}\n`, `${image} `, `"${image}"`, `${image}\n${LONG_ASCII}`, `${image} ${image}\n説明`,
      `${LONG_ASCII}\n${image}`, "shot.jpeg", "a.tar.gz\n", `${"x".repeat(INLINE_PASTE_MAX_CHARS - 4)}.png`,
      // アプリが合成する形: 添付のパスを空白区切りで本文の前に並べる。
      `${image} ${other} これを見て ${LONG_ASCII}`,
      `${image} ${other} ${image} ${other} ${image} 短い本文\tタブ入り`,
      `先に本文 ${image} ${other} 後ろにも本文`,
      `${image} /tmp/notes.txt 説明`,
    ]) {
      const pieces = splitForInlinePaste(text);
      expect(pieces.join("")).toBe(text);
      for (const piece of pieces) expect(holdsExtension(piece)).toBe(false);
    }
    expect(splitForInlinePaste(`${image}\n`)).toEqual(["/Users/me/.tailii/uploads/shot-1.", "png\n"]);
    expect(splitForInlinePaste(`${image} ${other} 本文`)).toEqual([
      "/Users/me/.tailii/uploads/shot-1.", "png /Users/me/.tailii/uploads/IMG_0002.", "JPEG 本文",
    ]);
    // 文の終わりの句点・数字は拡張子ではない。
    expect(splitForInlinePaste("This is fine.")).toEqual(["This is fine."]);
    expect(splitForInlinePaste("version 2.1")).toEqual(["version 2.1"]);
    expect(splitForInlinePaste("e.g. this")).toEqual(["e.g. this"]);
  });

  test("改行は LF にそろえ、制御文字は落としてから分ける（CLI が記録する形）", () => {
    expect(normalizeTextForPaste("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeTextForPaste("a\u2028b\u2029c")).toBe("a\nb\nc");
    expect(normalizeTextForPaste("a\u007fb\u009bc\u0000d\u0008e")).toBe("abcde");
    // タブと LF、不可視文字（ゼロ幅など）は残す。
    expect(normalizeTextForPaste("\tタブ\n改行\u200bゼロ幅")).toBe("\tタブ\n改行\u200bゼロ幅");
    expect(normalizeTextForPaste("改行なし")).toBe("改行なし");
  });
});

describe("貼り付けの表示（実機キャプチャ）", () => {
  const box = (screen: string): string => inputBoxRealText(screen) ?? "";

  test("貼り付けの案内が出ているフレームは、未送信の入力欄として読める", () => {
    for (const screen of [PASTED_SINGLE, PASTED_MULTILINE, PASTED_RESTORED]) {
      expect(screenShowsPasteHint(screen)).toBe(true);
      expect(classifySubmitFrame(screen)).toBe("pending");
    }
  });

  test("小分けの貼り付けで入った実機のフレームは、入ったと確かめられる（畳まれず、案内も出ない）", () => {
    for (const [screen, text] of [[INLINE_MULTILINE, LONG_MULTILINE], [INLINE_TABS, TAB_CODE], [INLINE_ASCII, LONG_ASCII]] as const) {
      expect(classifySubmitFrame(screen)).toBe("pending");
      expect(screenShowsPasteHint(screen)).toBe(false);
      expect(box(screen)).not.toContain("[Pasted text");
      expect(pastedTextArrived(box(screen), text)).toBe(true);
      expect(inputBoxTextMatchesRecordedPrompt(box(screen), spaced(text))).toBe(true);
    }
    // 別の本文とは一致しない。
    expect(pastedTextArrived(box(INLINE_MULTILINE), LONG_ASCII)).toBe(false);
    expect(pastedTextArrived(box(INLINE_ASCII), LONG_MULTILINE)).toBe(false);
  });

  test("途中まで入った実機のフレームは、入ったと数えない", () => {
    expect(classifySubmitFrame(INLINE_PARTIAL)).toBe("pending");
    expect(pastedTextArrived(box(INLINE_PARTIAL), LONG_MULTILINE)).toBe(false);
    expect(pastedTextPartlyArrived(box(INLINE_PARTIAL), LONG_MULTILINE)).toBe(true);
    expect(pastedTextPartlyArrived(box(INLINE_PARTIAL), LONG_ASCII)).toBe(false);
  });

  test("入力欄の中の罫線だけの行を、枠と取り違えない", () => {
    expect(classifySubmitFrame(INLINE_RULE_LINE)).toBe("pending");
    expect(box(INLINE_RULE_LINE)).toBe(spaced(RULE_LINE_TEXT));
    expect(pastedTextArrived(box(INLINE_RULE_LINE), RULE_LINE_TEXT)).toBe(true);
    expect(inputBoxTextMatchesRecordedPrompt(box(INLINE_RULE_LINE), spaced(RULE_LINE_TEXT))).toBe(true);
    // 太い罫線・枠と同じ長さの行・入力欄の最後が罫線の行でも同じ。
    const rule = "─".repeat(60);
    for (const body of [["❯ 前", `  ${"━".repeat(12)}`, "  後"], ["❯ 前", `  ${rule}`], ["❯ 前", `  ${rule}`, `  ${rule}`, "  後"]]) {
      const screen = ["⏺ 前の応答", "", rule, ...body, rule, "  ⏸ manual mode on"].join("\n");
      expect(extractClaudeInputBox(screen)?.text).toBe(body.map((line) => line.slice(2)).join("\n"));
      expect(inputBoxRealText(screen)).toBe(body.map((line) => line.slice(2)).join("\n"));
      expect(classifySubmitFrame(screen)).toBe("pending");
    }
  });

  test("名前付きの会話でも、入力欄の枠を読める（上の罫線の行末は罫線 1 個）", () => {
    for (const screen of [NAMED_IDLE, NAMED_IDLE_HERDR, NAMED_HISTORY]) {
      // 旧: 上の枠を見失い、履歴の本文を「入力欄の残存」と読んでいた。
      expect(box(screen)).toBe("");
      expect(classifySubmitFrame(screen)).toBe("submitted");
    }
    expect(classifySubmitFrame(NAMED_RULE_LINE)).toBe("pending");
    expect(box(NAMED_RULE_LINE)).toBe(spaced(RULE_LINE_TEXT));
    expect(pastedTextArrived(box(NAMED_RULE_LINE), RULE_LINE_TEXT)).toBe(true);
    expect(classifySubmitFrame(NAMED_MULTILINE)).toBe("pending");
    expect(pastedTextArrived(box(NAMED_MULTILINE), LONG_MULTILINE)).toBe(true);
    // 以前の版の形（中央寄せ。行末にも罫線が続く）も読める。
    const rule = "─".repeat(60);
    const centered = ["⏺ 前の応答", "", `${"─".repeat(20)} 会話の名前 ${"─".repeat(20)}`, "❯ 下書き", "  2 行目", rule, "  ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(centered)?.text).toBe("下書き\n2 行目");
  });

  test("タイトルの長い名前付きの会話でも、入力欄の枠を読める", () => {
    for (const screen of [NAMED_LONG_IDLE, NAMED_LONG_TRUNCATED, NAMED_LONG_HISTORY]) {
      expect(box(screen)).toBe("");
      expect(classifySubmitFrame(screen)).toBe("submitted");
    }
    // 下書きを「空」と読まない（読むと、アプリの本文が下書きの後ろへつながって送信される）。
    // 下の statusLine の行（字下げ・行末の罫線 1 個）を、枠と取り違えない。
    expect(box(NAMED_LONG_DRAFT_STATUSLINE)).toBe("mac draft line");
    expect(classifySubmitFrame(NAMED_LONG_DRAFT_STATUSLINE)).toBe("pending");
  });

  test("タイトルの長い会話で、履歴の行頭からの罫線を上の枠と取り違えない", () => {
    // 旧: 行頭から罫線が続く行 2 本を枠にする段があり、履歴の `─────── tail` を上の枠にしていた。空の
    // 入力欄を「履歴からタイトルの行までが残っている」と読み、送信がすべて拒否された。
    expect(box(NAMED_LONG_HISTORY_RULE)).toBe("");
    expect(classifySubmitFrame(NAMED_LONG_HISTORY_RULE)).toBe("submitted");
    const plain = NAMED_LONG_HISTORY_RULE.replace(/\u001b\[[0-9;]*m/g, "");
    expect(extractClaudeInputBox(plain)).toEqual({ prompt: "❯", text: "" });
    expect(box(NAMED_LONG_HISTORY_RULE_DRAFT)).toBe("mac draft line\n\n─────── second");
    expect(classifySubmitFrame(NAMED_LONG_HISTORY_RULE_DRAFT)).toBe("pending");
    // 合成した画面でも同じ: 履歴の行頭の罫線の次が発話（`❯`）でも、下の枠から辿った枠を採る。
    const rule = "─".repeat(60);
    const screen = ["❯ /cmd", "─────── tail", "❯ 前の発話", "⏺ 応答", ` ${"あ".repeat(28)}… ─`, "❯ 下書き", "  2 行目", rule, "  ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(screen)).toEqual({ prompt: "❯", text: "下書き\n2 行目" });
    expect(inputBoxRealText(screen)).toBe("下書き\n2 行目");
  });

  test("画面が崩れて下の枠が消えた pane は、変更前と同じ読み方をする（履歴の罫線を枠にしない）", () => {
    // 旧: 行頭から罫線が続く行 2 本を枠にする段があり、上の枠（`──── fox ─`）を下の枠に、履歴の
    // `─────── tail` を上の枠にして、その間の履歴を「入力欄の残り」と読んだ。送信がすべて拒否された。
    for (const screen of [NAMED_SHIFTED_HISTORY_RULE, NAMED_LONG_SHIFTED_HISTORY_RULE]) {
      expect(box(screen)).toBe("");
      expect(classifySubmitFrame(screen)).toBe("submitted");
    }
  });

  test("名前付きの会話のシェルモードの入力欄を読める", () => {
    const plain = NAMED_SHELL.replace(/\u001b\[[0-9;]*m/g, "");
    expect(extractClaudeInputBox(plain)).toEqual({ prompt: "!", text: "" });
    expect(classifySubmitFrame(NAMED_SHELL)).toBe("submitted");
  });

  test("下の枠のすぐ下がプロンプトの行なら、その罫線を下の枠にしない（崩れた画面で上の枠を拾わない）", () => {
    const rule = "─".repeat(60);
    // 画面が崩れて下の枠が消えた、名前なしの会話。上の枠から上へ辿ると、スラッシュコマンドの
    // 控えの折り返し（`!x`）に当たり、その上の行が罫線で終わっている。
    const screen = ["", `❯ /add-dir /nonexistent/${"p".repeat(40)}──`, "!x", "  ⎿  Path not found", "", "  ⎿  Tip: foo", rule, "❯ ✌ OK", "❯ ", "  ⏸ manual mode on · ? for shortcuts"].join("\n");
    expect(extractClaudeInputBox(screen)).toEqual({ prompt: "❯", text: "" });
    expect(inputBoxRealText(screen)).toBe("");
    expect(classifySubmitFrame(screen)).toBe("submitted");
  });

  test("下の枠から辿るとき、入力欄の形を外れた画面では枠を返さない", () => {
    const rule = "─".repeat(60);
    const footer = "  ⏸ manual mode on";
    const read = (lines: string[]): string | undefined => extractClaudeInputBox(lines.join("\n"))?.text;
    // 上の枠（切り詰めたタイトル。行頭は空白 1 個）を越えて、履歴まで辿らない。
    expect(read([`  ${rule}`, "❯ 前の発話", "⏺ 応答", ` ${"あ".repeat(28)}… ─`, "❯ 下書き", rule, footer])).toBe("下書き");
    // 下の枠は行末まで罫線だけの行。タイトルの埋まった罫線（上の枠）を下の枠にしない。
    expect(read(["⏺ 応答", `  ${rule}`, "❯ 前の発話", `${"─".repeat(40)} fox ─`, "❯ ", footer])).toBe("");
    // プロンプト記号で始まらない行で止まったら、その上の罫線を上の枠にしない。
    expect(read(["❯ 前の発話", `${"─".repeat(10)} x ─`, "⏺ 応答の 1 行目", "  応答の続き", rule, footer])).toBe("前の発話");
  });

  test("プロンプトの行のすぐ上が罫線で終わっていなければ、入力欄と見なさない", () => {
    const rule = "─".repeat(60);
    // 履歴の発話（`❯` で始まる）の下に、応答と罫線 1 本が見えているだけの画面。
    const history = ["❯ 前の発話", "  続き", rule, "  ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(history)?.text).toBe("前の発話");
    const noFrame = ["⏺ 応答の本文", "❯ 下書き", "  2 行目", rule, "  ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(noFrame)?.text).toBe("下書き");
  });

  test("下の枠から辿れない画面は、変更前と同じ規則で読む（行末の罫線 1 個の行は罫線にしない）", () => {
    const rule = "─".repeat(40);
    const screen = [`  ${rule}`, "  ❯ 下書き", `  ${rule}`, "  ───── haiku │ main ─", "    ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(screen)?.text).toBe("下書き");
  });

  test("名前付きの会話でも、`/login` の完了（入力欄が見えている）を読める", () => {
    expect(loginCodeScreenState(NAMED_IDLE)).toBe("accepted");
    expect(loginCodeScreenState(NAMED_LONG_IDLE)).toBe("accepted");
    // 入力欄の形が無い画面は、履歴に行頭からの罫線があっても完了にしない。
    const exchanging = ["❯ /cmd", "─────── tail", "  ⎿  done", "", "  Logging in…", "─".repeat(60)].join("\n");
    expect(loginCodeScreenState(exchanging)).toBe("pending");
  });

  test("字下げされた画面（下の枠から辿れない）は、従来どおり読める", () => {
    const rule = "─".repeat(40);
    const screen = ["  ⏺ 前の応答", `  ${rule}`, "  ❯ 下書き", "    2 行目", `  ${rule}`, "    ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(screen)?.text).toBe("下書き\n2 行目");
  });

  test("画面が崩れたフレームは、入力欄として読めない（入ったとも、ダイアログとも数えない）", () => {
    expect(classifySubmitFrame(INLINE_SHIFTED)).toBe("unknown");
    expect(pastedTextArrived(box(INLINE_SHIFTED), LONG_MULTILINE)).toBe(false);
    expect(pastedTextPartlyArrived(box(INLINE_SHIFTED), LONG_MULTILINE)).toBe(false);
  });

  test("約 10000 字を超える本文は、中ほどが置き換えの表示になる。それでも入ったと確かめられる", () => {
    expect(box(INLINE_TRUNCATED)).toMatch(/\[\.\.\.Truncated text #\d+ \+0 lines\.\.\.\]/);
    for (const [screen, text] of [[INLINE_TRUNCATED, TRUNCATED_TEXT], [INLINE_TRUNCATED_LINES, TRUNCATED_LINES_TEXT]] as const) {
      expect(classifySubmitFrame(screen)).toBe("pending");
      expect(pastedTextArrived(box(screen), text)).toBe(true);
      expect(pastedTextPartlyArrived(box(screen), text)).toBe(true);
      expect(inputBoxTextMatchesRecordedPrompt(box(screen), text)).toBe(true);
    }
    // 末尾の違う本文・先頭の違う本文とは一致しない。
    expect(pastedTextArrived(box(INLINE_TRUNCATED), `${TRUNCATED_TEXT} さらに続き`)).toBe(false);
    expect(pastedTextArrived(box(INLINE_TRUNCATED), TRUNCATED_TEXT.replace("Reply only", "Answer only"))).toBe(false);
    expect(inputBoxTextMatchesRecordedPrompt(box(INLINE_TRUNCATED), LONG_ASCII)).toBe(false);
  });

  test("置き換えの表示で区切られた部分は、本文の中にこの順で現れなければならない", () => {
    const text = `${"a".repeat(600)}${"b".repeat(9000)}${"c".repeat(600)}`;
    const shown = (head: string, tail: string): string => `${head} [...Truncated text #7 +0 lines...]${tail}`;
    expect(matchInputBoxAgainstText(shown("a".repeat(500), "c".repeat(100)), text, true)).toBe(600);
    expect(pastedTextArrived(shown("a".repeat(500), "c".repeat(100)), text)).toBe(true);
    // 順序が逆・末尾でない・置き換えの表示で終わる。
    expect(pastedTextArrived(shown("c".repeat(100), "a".repeat(100)), text)).toBe(false);
    expect(pastedTextArrived(shown("a".repeat(500), "b".repeat(100)), text)).toBe(false);
    expect(pastedTextArrived(shown("a".repeat(500), ""), text)).toBe(false);
    expect(pastedTextPartlyArrived(shown("a".repeat(500), "b".repeat(100)), text)).toBe(true);
    expect(pastedTextPartlyArrived(shown("a".repeat(500), ""), text)).toBe(true);
    expect(pastedTextPartlyArrived(shown("z".repeat(50), "c".repeat(100)), text)).toBe(false);
    // 行数付きの表示。
    expect(pastedTextArrived(`${"a".repeat(500)}[...Truncated text #8 +41 lines...]${"c".repeat(100)}`, text)).toBe(true);
  });

  test("置き換えの表示の前後は、本文の中で重ならず、この順に並んでいなければならない", () => {
    // 先頭部分が本文の後ろ側にしか無い・末尾部分が先頭部分と重なる形は、入ったと数えない。
    const text = `HEAD-${"m".repeat(9000)}-UNIQUE-TAIL-${"t".repeat(40)}`;
    const shown = (head: string, tail: string): string => `${head}[...Truncated text #7 +0 lines...]${tail}`;
    expect(pastedTextArrived(shown("HEAD-mmmm", `-UNIQUE-TAIL-${"t".repeat(40)}`), text)).toBe(true);
    expect(pastedTextArrived(shown(`UNIQUE-TAIL-${"t".repeat(10)}`, "t".repeat(40)), text)).toBe(false);
    expect(pastedTextArrived(shown(`-UNIQUE-TAIL-${"t".repeat(40)}`, "t".repeat(30)), text)).toBe(false);
    expect(pastedTextPartlyArrived(shown(`-UNIQUE-TAIL-${"t".repeat(30)}`, "HEAD-mmmm"), text)).toBe(false);
    expect(pastedTextPartlyArrived(shown("HEAD-mmmm", "-UNIQUE-TAIL-"), text)).toBe(true);
    // 3 つに分かれた形も、順に並んでいること。
    const three = (a: string, b: string, c: string): string =>
      `${a}[...Truncated text #7 +0 lines...]${b}[...Truncated text #8 +0 lines...]${c}`;
    expect(pastedTextArrived(three("HEAD-", "-UNIQUE-TAIL-", "t".repeat(30)), text)).toBe(true);
    expect(pastedTextArrived(three("-UNIQUE-TAIL-", "HEAD-", "t".repeat(30)), text)).toBe(false);
  });

  test("本文そのものが置き換えの表示と同じ文言を含んでいても、確かめられる", () => {
    const literal = "[...Truncated text #3 +0 lines...]";
    const ending = `${LONG_ASCII} the box showed ${literal}`;
    expect(pastedTextArrived(ending.slice(-300), ending)).toBe(true);
    expect(pastedTextArrived(ending, ending)).toBe(true);
    const short = `a\tb ${literal}`;
    expect(pastedTextArrived(spaced(short), short)).toBe(true);
    const middle = `${literal} in the middle ${LONG_ASCII}`;
    expect(pastedTextArrived(middle, middle)).toBe(true);
  });

  test("入力欄に映っている全体が本文の末尾と同文なら、入ったと確かめられる", () => {
    expect(pastedTextArrived(LONG_ASCII.slice(-200), LONG_ASCII)).toBe(true);
    expect(pastedTextArrived(LONG_ASCII, LONG_ASCII)).toBe(true);
    expect(pastedTextArrived(LONG_MULTILINE.split("\n").slice(-13).join("\n"), LONG_MULTILINE)).toBe(true);
    expect(pastedTextArrived(LONG_ASCII.slice(0, 500), LONG_ASCII)).toBe(false);
    expect(pastedTextArrived("", LONG_ASCII)).toBe(false);
    // 貼り付けたタブは空白 4 個になって映る。結合文字は合成済みで映る。
    expect(pastedTextArrived(spaced(TAB_CODE).split("\n").slice(-6).join("\n"), TAB_CODE)).toBe(true);
    expect(pastedTextArrived(`${LONG_ASCII.slice(-100)} café が end`, `${LONG_ASCII} cafe\u0301 か\u3099 end`)).toBe(true);
    // 短すぎる一致は根拠にしない（本文の全体が映っているときを除く）。
    expect(pastedTextArrived(LONG_ASCII.slice(-10), LONG_ASCII)).toBe(false);
    expect(pastedTextArrived("a    b", "a\tb")).toBe(true);
    expect(pastedTextArrived("ls -la", "!ls -la")).toBe(true);
  });

  test("各行の終わりが同じ本文が途中まで入った形は、入ったと数えない", () => {
    // 30 行のうち 11 行まで入った時点（実測: CLI の処理が止まった）。末尾 24 字は最終行と同じ。
    const partial = LONG_MULTILINE.split("\n").slice(0, 11).join("\n");
    expect(partial.slice(-24)).toBe(LONG_MULTILINE.slice(-24));
    expect(pastedTextArrived(partial, LONG_MULTILINE)).toBe(false);
    expect(pastedTextArrived(LONG_MULTILINE.split("\n").slice(3, 11).join("\n"), LONG_MULTILINE)).toBe(false);
    expect(pastedTextPartlyArrived(partial, LONG_MULTILINE)).toBe(true);
    expect(pastedTextPartlyArrived("Mac 側の下書き", LONG_MULTILINE)).toBe(false);
    expect(pastedTextPartlyArrived("", LONG_MULTILINE)).toBe(false);
  });

  test("畳まれた表示（`[Pasted text #N]`）は、入ったと数えない", () => {
    expect(pastedTextArrived(box(PASTED_SINGLE), LONG_ASCII)).toBe(false);
    expect(pastedTextArrived(box(PASTED_MULTILINE), LONG_MULTILINE)).toBe(false);
  });

  test("先頭が入らなかった形（括弧なしで打った場合）は、入ったと数えない", () => {
    // 末尾の 178 字は入力欄にあるが、本文の末尾とは違う（この試験の本文とは別の文）。
    expect(pastedTextArrived(box(TYPED_DROPPED_HEAD), LONG_ASCII)).toBe(false);
  });

  test("本文そのものが貼り付けの表示と同じ文言を含んでいても、末尾で確かめられる", () => {
    const quoting = `the TUI showed [Pasted text #3 +12 lines] here\n${LONG_ASCII}`;
    expect(pastedTextArrived(quoting.slice(-300), quoting)).toBe(true);
    expect(pastedTextArrived(quoting, quoting)).toBe(true);
  });
});

describe("inputBoxTextIncludesProbe（結合文字）", () => {
  test("分解形の本文でも、合成済みで映った入力欄と一致する", () => {
    const decomposed = "café が end";
    const composed = decomposed.normalize("NFC");
    expect(decomposed).not.toBe(composed);
    expect(inputBoxTextIncludesProbe(composed, decomposed)).toBe(true);
    expect(inputBoxTextIncludesProbe(decomposed, composed)).toBe(true);
  });
});

describe("unwrapPastedContent", () => {
  const wrap = (id: string, body: string): string => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`;

  test("全体が 1 つの貼り付けなら、本文だけを返す（実測の 2 つの形）", () => {
    expect(unwrapPastedContent(`\n\n${wrap("0baf", LONG_MULTILINE)}\n`)).toBe(LONG_MULTILINE);
    expect(unwrapPastedContent(wrap("0baf", LONG_MULTILINE))).toBe(LONG_MULTILINE);
    expect(unwrapPastedContent(wrap("12e3", ""))).toBe("");
  });

  test("包みが無ければそのまま返す", () => {
    expect(unwrapPastedContent("ふつうの発話")).toBe("ふつうの発話");
    expect(unwrapPastedContent("")).toBe("");
    expect(unwrapPastedContent('<pasted_content id="0baf">\n閉じが無い')).toBe('<pasted_content id="0baf">\n閉じが無い');
    // 開きの直後の改行と、閉じの直前の改行は別のもの。
    expect(unwrapPastedContent('<pasted_content id="0baf">\n</pasted_content id="0baf">'))
      .toBe('<pasted_content id="0baf">\n</pasted_content id="0baf">');
  });

  test("前後に打った本文があれば、改行で区切って残す", () => {
    const mixed = `これを見て\n\n${wrap("0baf", "貼った本文")}\nどう思う？`;
    expect(unwrapPastedContent(mixed)).toBe("これを見て\n貼った本文\nどう思う？");
  });

  test("括弧なしで打って読み取りの境界で分かれた形も、つなげて返す", () => {
    const split = `${wrap("12e3", "1 つ目")}\n${wrap("12e3", "2 つ目")}\n残り`;
    expect(unwrapPastedContent(split)).toBe("1 つ目\n2 つ目\n残り");
  });

  test("開きと閉じの id が違うものは包みと見なさない", () => {
    const forged = `<pasted_content id="aaaa">\n本文\n</pasted_content id="bbbb">`;
    expect(unwrapPastedContent(forged)).toBe(forged);
    const odd = `<pasted_content id="a b">\n本文\n</pasted_content id="a b">`;
    expect(unwrapPastedContent(odd)).toBe(odd);
    // 閉じの無い開きの後ろに、そろった包みがあれば、そちらだけを外す。
    expect(unwrapPastedContent(`<pasted_content id="aaaa">\n前\n${wrap("bbbb", "本文")}`))
      .toBe(`<pasted_content id="aaaa">\n前\n本文`);
  });

  test("改行や開きタグが大量に続く本文でも、すぐに終わる", () => {
    const started = Date.now();
    const newlines = `<pasted_content id="a">\n${"\n".repeat(200_000)}`;
    expect(unwrapPastedContent(newlines)).toBe(newlines);
    const opens = '<pasted_content id="a">\n'.repeat(20_000);
    expect(unwrapPastedContent(opens)).toBe(opens);
    // id の終わりが無い開き / id の違う閉じなしの包み。
    const unterminated = '<pasted_content id="'.repeat(40_000);
    expect(unwrapPastedContent(unterminated)).toBe(unterminated);
    const distinct = Array.from({ length: 40_000 }, (_, i) => `<pasted_content id="i${i}">\n本文`).join("\n");
    expect(unwrapPastedContent(distinct)).toBe(distinct);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("CLI が書き換えた `<\\pasted_content` を、元の形に戻す", () => {
    const recorded = String.raw`画面に <\pasted_content id="0baf"> と <\/pasted_content id="0baf"> が出た`;
    expect(unwrapPastedContent(recorded)).toBe('画面に <pasted_content id="0baf"> と </pasted_content id="0baf"> が出た');
    expect(unwrapPastedContent(String.raw`C:\dir と <\div> はそのまま`)).toBe(String.raw`C:\dir と <\div> はそのまま`);
    // 包みの中にあっても戻す。
    expect(unwrapPastedContent(wrap("0baf", String.raw`see <\pasted_content id="x">`))).toBe('see <pasted_content id="x">');
  });

  test("同じ id の包みが幾つ並んでも、開きごとに直後の閉じと組む", () => {
    const many = Array.from({ length: 5 }, (_, i) => wrap("0baf", `本文 ${i}`)).join("\n");
    expect(unwrapPastedContent(many)).toBe(Array.from({ length: 5 }, (_, i) => `本文 ${i}`).join("\n"));
    // 開きより前にある閉じとは組まない。
    const reversed = `</pasted_content id="0baf">\n前\n<pasted_content id="0baf">\n後`;
    expect(unwrapPastedContent(reversed)).toBe(reversed);
  });

  test("transcript の user 行と、キューから取り込まれた発話の包みを外して配る", () => {
    const user = { type: "user", uuid: "u-1", origin: { kind: "human" },
      message: { role: "user", content: `\n\n${wrap("0baf", LONG_MULTILINE)}\n` } };
    expect(extractTurn(JSON.stringify(user))).toMatchObject({ role: "user", text: LONG_MULTILINE });
    const queued = { type: "attachment", uuid: "a-1",
      attachment: { type: "queued_command", prompt: wrap("0baf", LONG_ASCII) } };
    expect(extractTurn(JSON.stringify(queued))).toMatchObject({ role: "user", text: LONG_ASCII });
    // assistant の本文は触らない。
    const assistant = { type: "assistant", uuid: "s-1",
      message: { role: "assistant", content: [{ type: "text", text: wrap("0baf", "引用") }] } };
    expect(extractTurn(JSON.stringify(assistant))).toMatchObject({ text: wrap("0baf", "引用") });
  });
});

describe("inputBoxTextMatchesRecordedPrompt（貼り付けた発話の書き戻し）", () => {
  const wrap = (body: string): string => `\n\n<pasted_content id="0baf">\n${body}\n</pasted_content id="0baf">\n`;
  const restored = inputBoxRealText(PASTED_RESTORED) ?? "";

  test("畳まれた表示は、どの記録本文とも同文にしない（本文が分からない）", () => {
    // Mac 側で貼り付けた別の下書きと、書き戻された発話を見分けられない。消さずに残す。
    expect(restored).toMatch(/^\[Pasted text #\d+\]$/);
    expect(inputBoxTextMatchesRecordedPrompt(restored, wrap(LONG_ASCII))).toBe(false);
    expect(inputBoxTextMatchesRecordedPrompt("[Pasted text #9 +29 lines]", wrap(LONG_MULTILINE))).toBe(false);
    expect(inputBoxTextMatchesRecordedPrompt(restored, LONG_ASCII)).toBe(false);
  });

  test("畳まれずに書き戻された本文は、包みを外した記録本文と照合する", () => {
    expect(inputBoxTextMatchesRecordedPrompt("短い貼り付け", wrap("短い貼り付け"))).toBe(true);
    expect(inputBoxTextMatchesRecordedPrompt(LONG_MULTILINE.split("\n").slice(-8).join("\n"), LONG_MULTILINE)).toBe(true);
  });
});

const BAR = "⏸ manual mode on · ? for shortcuts · ← for agents";
const PASTE_HINT = "paste again to expand";
const RULE = "─".repeat(100);

/**
 * 打鍵を受ける TUI の模型（実測 2.1.284 に合わせる）。
 * - 入力は 1 本のバイト列として届き、括弧付き貼り付けは 1 つずつ取り込む（1 回の書き込みに
 *   幾つ並んでいてもよい）。800 字を超えるか改行が 3 個以上なら `[Pasted text #N +M lines]` に
 *   畳む（バーの位置は案内に替わる）。それ以下なら本文をそのまま入れる。
 * - 貼り付けの中の CR / CRLF は改行、タブは空白 4 個になる。貼り付けの中の実在する画像の
 *   パスは `[Image #N]` に置き換える。
 * - 括弧なしの打鍵は 1022 字ごとの読み取りに分かれ、800 字を超える読み取りは貼り付けになる。
 *   打ったタブは入力欄に入らない。
 * - `stalled` の間の入力（貼り付け・打鍵・C-u・Backspace）は読まれずに溜まり、`resume()` で順に入る。
 *   溜まった C-u が 80 個以上だと、CLI は無視する。
 * - C-u は 1 回で 1 行ぶん: 末尾行の本文 → その改行の順に消える（N 行で 2N-1 回）。
 * - 入力欄の本文が 10000 字を超えると、中ほどを `[...Truncated text #N +M lines...]` に置き換えて
 *   映す（表示だけ）。
 */
function makeTui(options: {
  mangle?: (text: string) => string; images?: string[]; title?: string; statusLine?: string;
} = {}) {
  const state = {
    input: "", pastes: 0, images: 0, hint: false, stalled: false, pending: [] as string[], dialog: false,
    submitted: [] as string[], pasted: [] as string[], typed: [] as string[], kills: 0, backspaces: 0, captures: 0,
    bodies: new Map<string, string>(),
  };
  const fold = (body: string): string => {
    state.pastes += 1;
    state.hint = true;
    const lines = body.split("\n").length - 1;
    const label = `[Pasted text #${state.pastes}${lines > 0 ? ` +${lines} lines` : ""}]`;
    state.bodies.set(label, body);
    return label;
  };
  const paste = (raw: string): void => {
    const body = (options.mangle ?? ((text) => text))(raw).replace(/\r\n?/g, "\n").replaceAll("\t", "    ");
    state.pasted.push(body);
    // 実機は、貼り付けの全体がパスのとき・パスが 2 つ以上並ぶときに置き換える。模型は厳しい側に
    // 倒し、実在する画像のパスが語として入っていれば必ず置き換える。
    const images = options.images ?? [];
    const replaced = body.split(/(\s+)/).map((token) => {
      if (!images.includes(token.replace(/^["']|["']$/g, ""))) return token;
      state.images += 1;
      return `[Image #${state.images}]`;
    }).join("");
    state.input += replaced.length > 800 || replaced.split("\n").length - 1 > 2 ? fold(replaced) : replaced;
  };
  const type = (chunk: string): void => {
    state.typed.push(chunk);
    for (let index = 0; index < chunk.length; index += 1022) {
      const piece = chunk.slice(index, index + 1022).replaceAll("\t", "");
      state.input += piece.length > 800 ? fold(piece) : piece;
    }
  };
  const read = (chunk: string): void => {
    let rest = chunk;
    while (rest.length > 0) {
      if (rest.startsWith(BRACKETED_PASTE_START)) {
        const end = rest.indexOf(BRACKETED_PASTE_END);
        if (end === -1) { paste(rest.slice(BRACKETED_PASTE_START.length)); return; }
        paste(rest.slice(BRACKETED_PASTE_START.length, end));
        rest = rest.slice(end + BRACKETED_PASTE_END.length);
      } else {
        const next = rest.indexOf(BRACKETED_PASTE_START);
        type(next === -1 ? rest : rest.slice(0, next));
        rest = next === -1 ? "" : rest.slice(next);
      }
    }
  };
  const KILLS = "\u0000kills:";
  const BACKSPACES = "\u0000backspaces:";
  const applyKills = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      if (state.input.endsWith("\n")) state.input = state.input.slice(0, -1);
      else state.input = state.input.slice(0, state.input.lastIndexOf("\n") + 1);
    }
  };
  const applyBackspaces = (count: number): void => {
    state.input = Array.from(state.input).slice(0, Math.max(0, Array.from(state.input).length - count)).join("");
  };
  const write = (chunk: string): void => { if (state.stalled) state.pending.push(chunk); else read(chunk); };
  const resume = (): void => {
    state.stalled = false;
    const queued = state.pending.splice(0);
    for (let index = 0; index < queued.length; index += 1) {
      const chunk = queued[index] ?? "";
      if (chunk.startsWith(KILLS)) {
        // 止まっている間に溜まった C-u は、まとめて読まれる。80 個以上だと CLI は無視する（実測）。
        let total = Number(chunk.slice(KILLS.length));
        while ((queued[index + 1] ?? "").startsWith(KILLS)) {
          index += 1;
          total += Number((queued[index] ?? "").slice(KILLS.length));
        }
        if (total < 80) applyKills(total);
      } else if (chunk.startsWith(BACKSPACES)) {
        applyBackspaces(Number(chunk.slice(BACKSPACES.length)));
      } else {
        read(chunk);
      }
    }
  };
  const kill = (count: number): void => {
    state.kills += count;
    if (state.stalled) state.pending.push(`${KILLS}${count}`);
    else applyKills(count);
  };
  const backspace = (count: number): void => {
    state.backspaces += count;
    if (state.stalled) state.pending.push(`${BACKSPACES}${count}`);
    else applyBackspaces(count);
  };
  /** 送信された本文（貼り付けの表示は、貼った本文へ戻す）。 */
  const enter = (): void => {
    if (state.input.length === 0) return;
    let body = state.input;
    for (const [label, pasted] of state.bodies) body = body.replace(label, pasted);
    state.submitted.push(body);
    state.input = "";
  };
  const screen = (): string => {
    state.captures += 1;
    if (state.dialog) {
      return ["⏺ 前の応答", "", RULE, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", RULE, " Esc to cancel · Tab to amend"]
        .join("\n");
    }
    // 約 10000 字を超える本文は、先頭 500 字と 10000 字目以降だけを映す（表示だけ）。
    const shown = state.input.length > 10_000
      ? `${state.input.slice(0, 500)}[...Truncated text #${state.pastes + 1} +${state.input.slice(500, 10_000).split("\n").length - 1} lines...]${state.input.slice(10_000)}`
      : state.input;
    const wrapped = shown.split("\n").flatMap((line) => line.match(/.{1,96}/gu) ?? [""]);
    const box = wrapped.slice(-8).map((line, index) => (index === 0 ? `❯ ${line}` : `  ${line}`));
    // 名前付きの会話は、上の罫線にタイトルが右寄せで埋まる（行末の罫線は 1 個）。
    // タイトルが長いと、行頭の罫線が 3 個に届かない（`─ <タイトル> ─`）。
    const top = options.title === undefined ? RULE
      : options.title.length > 80 ? `─ ${options.title} ─`
      : `${"─".repeat(80)} ${options.title} ─`;
    const statusLine = options.statusLine === undefined ? [] : [`  ${options.statusLine}`];
    return ["⏺ 前の応答", "", top, ...box, RULE, ...statusLine, `  ${state.hint ? PASTE_HINT : BAR}`].join("\n");
  };
  return { state, write, resume, kill, backspace, enter, screen };
}

type Tui = ReturnType<typeof makeTui>;

function ioFor(tui: Tui, overrides: Partial<PastedTextIo> = {}): PastedTextIo {
  return {
    paste: async (pieces) => { for (const piece of pieces) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`); },
    capture: async () => tui.screen(),
    sendKills: async (count) => tui.kill(count),
    pollMs: 1,
    timeoutMs: 40,
    clearDelayMs: 0,
    clearSettleMs: 10,
    ...overrides,
  };
}

describe("TUI の模型", () => {
  test("1 つの貼り付けは、800 字・改行 2 個までなら本文のまま入る（実測の境界）", () => {
    for (const [body, folded] of [
      ["x".repeat(800), false], ["x".repeat(801), true], ["あ".repeat(800), false], ["あ".repeat(801), true],
      ["a\nb\nc", false], ["a\nb\n", false], ["a\nb\nc\nd", true], ["a\nb\nc\n", true],
    ] as const) {
      const tui = makeTui();
      tui.write(`${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`);
      expect(tui.state.input.startsWith("[Pasted text #")).toBe(folded);
    }
  });

  test("括弧なしで打った長文は読み取りの境界で分かれ、打ったタブは入らない", () => {
    const tui = makeTui();
    tui.write(LONG_ASCII);
    expect(tui.state.input).toMatch(/^\[Pasted text #1\]/);
    const tabs = makeTui();
    tabs.write("X1\tA\tB");
    expect(tabs.state.input).toBe("X1AB");
  });
});

describe("clearTypedInput", () => {
  test("多行の本文を、空になるまで消す（C-u は 1 回で 1 行ぶん）", async () => {
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    expect(await clearTypedInput(LONG_MULTILINE, ioFor(tui))).toBe(true);
    expect(tui.state.input).toBe("");
    // 30 行は 59 回かかる。15 回で打ち切る `clearInputBox` では 21 行ぶん残る。
    expect(tui.state.kills).toBeGreaterThanOrEqual(59);
  });

  test("入力欄が空なら 1 キーも打たない", async () => {
    const tui = makeTui();
    expect(await clearTypedInput(LONG_ASCII, ioFor(tui))).toBe(true);
    expect(tui.state.kills).toBe(0);
  });

  test("ダイアログ・判別できないフレームでは 1 キーも打たない", async () => {
    const dialog = makeTui();
    dialog.state.input = LONG_MULTILINE;
    dialog.state.dialog = true;
    expect(await clearTypedInput(LONG_MULTILINE, ioFor(dialog))).toBe(false);
    expect(dialog.state.kills).toBe(0);

    const unreadable = makeTui();
    unreadable.state.input = LONG_MULTILINE;
    expect(await clearTypedInput(LONG_MULTILINE, ioFor(unreadable, { capture: async () => null }))).toBe(false);
    expect(unreadable.state.kills).toBe(0);
  });

  test("打っても入力欄が変わらなければ諦める（打ち続けない）", async () => {
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    const io = ioFor(tui, { sendKills: async (count) => { tui.state.kills += count; } });
    expect(await clearTypedInput(LONG_MULTILINE, io)).toBe(false);
    expect(tui.state.kills).toBeLessThanOrEqual(160);
    expect(tui.state.input).toBe(LONG_MULTILINE);
  });

  test("消えるのが遅くても、反映を待ってから続ける（途中で諦めない）", async () => {
    // 長い本文は 1 回消すたびに描き直しがかかる。打った C-u は、少しずつ遅れて効く。
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    let owed = 0;
    const io = ioFor(tui, {
      sendKills: async (count) => { owed += count; },
      capture: async () => { const step = Math.min(owed, 3); tui.kill(step); owed -= step; return tui.screen(); },
      clearDelayMs: 1, clearSettleMs: 200,
    });
    expect(await clearTypedInput(LONG_MULTILINE, io)).toBe(true);
    expect(tui.state.input).toBe("");
  });

  test("同じ行が並ぶ本文も消し切る（映っている範囲が同じに見えても、1 回では諦めない）", async () => {
    const tui = makeTui();
    tui.state.input = Array.from({ length: 31 }, () => "まったく同じ行").join("\n");
    expect(await clearTypedInput(tui.state.input, ioFor(tui))).toBe(true);
    expect(tui.state.input).toBe("");
  });

  test("消している途中でダイアログが出たら、そこでやめる", async () => {
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    const io = ioFor(tui, { sendKills: async (count) => { tui.kill(count); tui.state.dialog = true; } });
    expect(await clearTypedInput(LONG_MULTILINE, io)).toBe(false);
    expect(tui.state.kills).toBe(40);
  });
});

describe("pasteTextInline", () => {
  test("小分けの貼り付けで渡し、本文がそのまま入力欄に入る（畳まれない）", async () => {
    for (const text of [LONG_ASCII, LONG_MULTILINE, LONG_JAPANESE, TAB_CODE, "return a;", `a\n\n\nb\n${LONG_ASCII}`]) {
      const tui = makeTui();
      await pasteTextInline(text, ioFor(tui));
      expect(tui.state.input).toBe(spaced(text));
      expect(tui.state.pastes).toBe(0);
      expect(tui.state.hint).toBe(false);
      expect(tui.state.typed).toEqual([]);
      expect(tui.state.kills).toBe(0);
      tui.enter();
      expect(tui.state.submitted).toEqual([spaced(text)]);
    }
  });

  test("CR / CRLF の改行は LF にそろえて渡す（改行が 2 倍にならない）", async () => {
    const crlf = LONG_MULTILINE.replaceAll("\n", "\r\n");
    const tui = makeTui();
    await pasteTextInline(crlf, ioFor(tui));
    expect(tui.state.input).toBe(LONG_MULTILINE);
    expect(tui.state.pasted.join("")).toBe(LONG_MULTILINE);
    const cr = makeTui();
    await pasteTextInline(`${LONG_ASCII}\r末尾`, ioFor(cr));
    expect(cr.state.input).toBe(`${LONG_ASCII}\n末尾`);
  });

  test("貼り付けの表示と同じ文言を含む本文も届く", async () => {
    const quoting = `the TUI showed [Pasted text #3 +12 lines] here\n${LONG_ASCII}`;
    const tui = makeTui();
    await pasteTextInline(quoting, ioFor(tui));
    expect(tui.state.input).toBe(quoting);
  });

  test("添付のパスを含む本文が、画像の添付に置き換わらない", async () => {
    const image = "/Users/me/.tailii/uploads/shot-1.png";
    const other = "/Users/me/.tailii/uploads/IMG_0002.JPEG";
    for (const text of [
      `${image}\n${LONG_ASCII}`, `${LONG_ASCII}\n${image}`, `${image} ${image}\n${LONG_ASCII}`,
      // アプリが合成する形（添付 2 つ以上 + 長文 / タブ入りの短文）。
      `${image} ${other} これを見て ${LONG_ASCII}`,
      `${image} ${other} 短い本文\tタブ入り`,
      `${image} ${other} ${image} ${other} ${image} ${LONG_MULTILINE}`,
      `"${image}" ${LONG_ASCII}`,
    ]) {
      const tui = makeTui({ images: [image, other] });
      await pasteTextInline(text, ioFor(tui));
      expect(tui.state.images).toBe(0);
      expect(tui.state.input).toBe(spaced(text));
    }
    // 模型の確認: パスを丸ごと含む貼り付けは置き換わる。
    const naive = makeTui({ images: [image, other] });
    naive.write(`${BRACKETED_PASTE_START}${image} ${other} 本文${BRACKETED_PASTE_END}`);
    expect(naive.state.input).toBe("[Image #1] [Image #2] 本文");
  });

  test("約 10000 字の本文も届く（入力欄に置き換えの表示が映る大きさ）", async () => {
    for (const length of [9_990, 10_050, 10_300, 10_700, 12_000, 20_000]) {
      const text = Array.from({ length: 5000 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ").slice(0, length);
      const tui = makeTui();
      await pasteTextInline(text, ioFor(tui));
      expect(tui.state.input).toBe(text);
      expect(tui.state.kills).toBe(0);
    }
    const lines = Array.from({ length: 200 }, (_, i) => `L${i} ${"abcdefghij".repeat(4)} end${i}`).join("\n");
    const tui = makeTui();
    await pasteTextInline(lines, ioFor(tui));
    expect(tui.state.input).toBe(lines);
  });

  test("罫線だけの行を含む本文も、入ったと確かめられる", async () => {
    for (const text of [RULE_LINE_TEXT, `a\tb\n${"━".repeat(20)}\n以上`, `${LONG_ASCII}\n${"─".repeat(100)}`]) {
      const tui = makeTui();
      expect(await pasteTextInline(text, ioFor(tui))).toBe("arrived");
      expect(tui.state.input).toBe(spaced(text));
    }
  });

  test("U+2028・制御文字を含む本文も届く（CLI が記録する形にそろえて渡す）", async () => {
    const text = `${LONG_ASCII}\u2028次の行\u007f\u009b 末尾`;
    const tui = makeTui();
    await pasteTextInline(text, ioFor(tui));
    expect(tui.state.input).toBe(`${LONG_ASCII}\n次の行 末尾`);
  });

  test("本文の末尾が入らなかったら、確かめられなかったと返す（1 キーも打たない）", async () => {
    const text = `${LONG_MULTILINE}\n最後の行だけは別の文言で終わる`;
    const tui = makeTui({ mangle: (piece) => (piece.startsWith("最後の行") ? "" : piece) });
    expect(await pasteTextInline(text, ioFor(tui))).toBe("unverified");
    expect(tui.state.kills).toBe(0);
    expect(tui.state.submitted).toEqual([]);
  });

  test("入ったのを確かめられたら、そう返す", async () => {
    const tui = makeTui();
    expect(await pasteTextInline(LONG_MULTILINE, ioFor(tui))).toBe("arrived");
  });

  test("各行の終わりが同じ本文が途中で止まっても、入ったと数えない", async () => {
    const tui = makeTui();
    const pieces = splitForInlinePaste(LONG_MULTILINE);
    const io = ioFor(tui, {
      paste: async () => {
        // 11 行まで読んだところで CLI の処理が止まった。残りは pty に並んでいる。
        for (const piece of pieces.slice(0, 11)) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`);
        tui.state.stalled = true;
        for (const piece of pieces.slice(11)) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`);
      },
    });
    expect(await pasteTextInline(LONG_MULTILINE, io)).toBe("unverified");
    expect(tui.state.kills).toBe(0);
    tui.resume();
    expect(tui.state.input).toBe(LONG_MULTILINE);
  });

  test("入っている途中で、進んでいる間は待つ（時間がかかっても届ける）", async () => {
    const tui = makeTui();
    const pieces = splitForInlinePaste(LONG_MULTILINE);
    let fed = 0;
    const io = ioFor(tui, {
      paste: async () => {},
      // CLI が 1 つずつ時間をかけて取り込む: 画面を撮るたびに 1 つ進む。
      capture: async () => {
        const piece = pieces[fed];
        if (piece !== undefined) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`);
        fed += 1;
        return tui.screen();
      },
      // 1 回の待ち（100ms）では入り切らない。進んでいる間は延びる。
      pollMs: 5, timeoutMs: 20 * 5,
    });
    const started = Date.now();
    expect(await pasteTextInline(LONG_MULTILINE, io)).toBe("arrived");
    expect(Date.now() - started).toBeGreaterThan(20 * 5);
    expect(tui.state.input).toBe(LONG_MULTILINE);
  });

  test("注入の全体に使ってよい時間を超えて待たない", async () => {
    const tui = makeTui();
    const pieces = splitForInlinePaste(LONG_MULTILINE);
    let fed = 0;
    const started = Date.now();
    const io = ioFor(tui, {
      paste: async () => {},
      capture: async () => {
        const piece = pieces[fed];
        if (piece !== undefined) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`);
        fed += 1;
        return tui.screen();
      },
      pollMs: 10, timeoutMs: 200, verifyDeadlineMs: started + 60,
    });
    expect(await pasteTextInline(LONG_MULTILINE, io)).toBe("unverified");
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("進み続けていても、上限を超えたら諦める", async () => {
    const text = Array.from({ length: 400 }, (_, i) => `行 ${i} ${"abcdefghij".repeat(3)}`).join("\n");
    const tui = makeTui();
    const pieces = splitForInlinePaste(text);
    let fed = 0;
    const started = Date.now();
    const io = ioFor(tui, {
      paste: async () => {},
      capture: async () => {
        const piece = pieces[fed];
        if (piece !== undefined) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`);
        fed += 1;
        return tui.screen();
      },
      pollMs: 5, timeoutMs: 40,
    });
    expect(await pasteTextInline(text, io)).toBe("unverified");
    expect(Date.now() - started).toBeLessThan(40 * 4 + 200);
    expect(tui.state.kills).toBe(0);
  });

  test("確かめられないときは、入力欄に触らない（別の中身・畳まれた表示・空・画面を撮れない）", async () => {
    for (const [options, overrides] of [
      [{ mangle: () => "まったく別の中身\n" }, {}],
      // CLI が貼り付けを畳んだ（境界が変わった）。
      [{ mangle: (text: string) => `${text}${"\n".repeat(3)}` }, {}],
      [{}, { capture: async () => null }],
    ] as const) {
      const tui = makeTui(options);
      expect(await pasteTextInline(LONG_ASCII, ioFor(tui, overrides))).toBe("unverified");
      expect(tui.state.kills).toBe(0);
    }
    const stalled = makeTui();
    stalled.state.stalled = true;
    expect(await pasteTextInline(LONG_MULTILINE, ioFor(stalled))).toBe("unverified");
    expect(stalled.state.kills).toBe(0);
    stalled.resume();
    expect(stalled.state.input).toBe(LONG_MULTILINE);
  });

  test("貼り付けの送出が 1 つ目で失敗したら、そのエラーを返す（入力欄には何も無い）", async () => {
    const failure = new Error("paste-buffer failed");
    const tui = makeTui();
    await expect(pasteTextInline(LONG_ASCII, ioFor(tui, { paste: async () => { throw failure; } })))
      .rejects.toBe(failure);
    expect(tui.state.kills).toBe(0);
  });

  test("貼り付けの送出が途中で失敗したら、入った分を消して送信を拒む（断片を残さない）", async () => {
    // 同じ行の繰り返しでも、途中までの断片を「入った」と数えない。
    const repeated = Array.from({ length: 30 }, () => "same line ".repeat(6).trim()).join("\n");
    for (const text of [LONG_MULTILINE, repeated]) {
      const tui = makeTui();
      const io = ioFor(tui, {
        paste: async (pieces) => {
          for (const piece of pieces.slice(0, 10)) tui.write(`${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`);
          throw new Error("paste-buffer failed");
        },
      });
      const attempt = pasteTextInline(text, io);
      await expect(attempt).rejects.toBeInstanceOf(ChatInjectionRejectedError);
      await expect(attempt).rejects.toThrow(CHAT_BLOCKED_BY_UNTYPED_TEXT);
      expect(tui.state.input).toBe("");
    }
  });

  test("途中で失敗したとき、入力欄が自分の本文でなければ消さない", async () => {
    const failure = new Error("paste-buffer failed");
    const tui = makeTui();
    tui.state.input = "Mac 側の下書き";
    await expect(pasteTextInline(LONG_ASCII, ioFor(tui, { paste: async () => { throw failure; } }))).rejects.toBe(failure);
    expect(tui.state.kills).toBe(0);
    expect(tui.state.input).toBe("Mac 側の下書き");
  });
});

describe("tmux: 長い本文の注入", () => {
  /** tmux の模型。引数の末尾の `;` は区切りとして落ち、`-r` の無い貼り付けは LF を CR に替える。 */
  function makeManager(tui: Tui, options: { failPasteAt?: number } = {}) {
    const buffers = new Map<string, string>();
    let pastes = 0;
    const runner = new MockTmuxRunner((args, input) => {
      if (args[0] === "capture-pane") return ok(tui.screen());
      if (args[0] === "delete-buffer") buffers.delete(args[args.indexOf("-b") + 1] ?? "");
      if (args[0] === "load-buffer") {
        const name = args[args.indexOf("-b") + 1] ?? "";
        buffers.set(name, input ?? "");
        const chained = args.indexOf(";");
        const paste = chained === -1 ? [] : args.slice(chained + 1);
        if (paste[0] === "paste-buffer") {
          pastes += 1;
          if (options.failPasteAt === pastes) return { exitCode: 1, stdout: "", stderr: "can't find pane" };
          const body = paste.includes("-r") ? (buffers.get(name) ?? "") : (buffers.get(name) ?? "").replaceAll("\n", "\r");
          if (paste.includes("-d")) buffers.delete(name);
          tui.write(paste.includes("-p") ? `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}` : body);
        }
      }
      if (args[0] === "send-keys") {
        if (args.includes("-l")) tui.write((args[args.length - 1] ?? "").replace(/;$/, ""));
        else if (args.includes("-H")) tui.write(args.slice(args.indexOf("-H") + 1).map((hex) => String.fromCharCode(Number.parseInt(hex, 16))).join(""));
        else if (args.includes("Enter")) tui.enter();
        else if (args.includes("BSpace")) tui.backspace(args.filter((arg) => arg === "BSpace").length);
        else tui.kill(args.filter((arg) => arg === "C-u").length);
      }
      return ok("");
    });
    const manager = new TmuxSessionManager({
      runner: runner.runner, store: makeTempStore(),
      submitDelayMs: 0, submitVerifyDelayMs: 0, clearKeyDelayMs: 0,
      pastedTextPollMs: 1, pastedTextTimeoutMs: 40, clearSettleMs: 10,
    });
    return { manager, runner, buffers };
  }

  test("1 回で打っても壊れない本文は、従来どおり 1 回で打つ（画面の読み取りも増やさない）", async () => {
    const short = makeTui();
    await makeManager(short).manager.sendTextSubmit("s", "短い本文");
    expect(short.state.typed).toEqual(["短い本文"]);
    expect(short.state.pasted).toEqual([]);
    expect(short.state.submitted).toEqual(["短い本文"]);

    const japanese = makeTui();
    const text = "これは長い日本語の本文です。".repeat(40);
    expect(tmuxTypedTextWouldBreak(text)).toBe(false);
    await makeManager(japanese).manager.sendTextSubmit("s", text);
    expect(japanese.state.typed).toEqual([text]);
    expect(japanese.state.pasted).toEqual([]);
    expect(japanese.state.captures).toBe(short.state.captures);
  });

  test("末尾が `;` の本文は、`;` を落とさずに打つ", async () => {
    for (const text of ["return a;", "a;;", ";", "const a = 1;\nreturn a;"]) {
      const tui = makeTui();
      const { manager, runner } = makeManager(tui);
      await manager.sendTextSubmit("s", text);
      expect(tui.state.submitted).toEqual([text]);
      // 引数の末尾に `;` を渡していない。
      for (const args of runner.recorded.filter((recorded) => recorded.includes("-l"))) {
        expect(args[args.length - 1]?.endsWith(";")).toBe(false);
      }
    }
    // 末尾が `;` でない本文は、従来どおり 1 回の send-keys。
    const plain = makeTui();
    const { manager, runner } = makeManager(plain);
    await manager.sendTextSubmit("s", "a; b");
    expect(runner.recorded.filter((args) => args[0] === "send-keys" && args.includes("-l"))).toEqual([
      ["send-keys", "-t", "s", "-l", "--", "a; b"],
    ]);
  });

  test("1 回で打つと壊れる本文は、小分けの括弧付き貼り付けで渡し、1 通でそのまま届く", async () => {
    for (const text of [LONG_ASCII, LONG_MULTILINE, TAB_CODE, "a\tb", `${LONG_ASCII};`]) {
      const tui = makeTui();
      const { manager, runner, buffers } = makeManager(tui);
      await manager.sendTextSubmit("s", text);
      expect(tui.state.typed).toEqual([]);
      expect(tui.state.pastes).toBe(0);
      expect(tui.state.submitted).toEqual([spaced(text)]);
      const pastes = runner.recorded.filter((args) => args[0] === "load-buffer");
      expect(pastes).toHaveLength(splitForInlinePaste(text).length);
      for (const args of pastes) {
        // 本文は引数に載せない（標準入力で渡す）。括弧付き・改行は LF のまま・貼った後に消す。
        expect(args).toEqual(["load-buffer", "-b", args[2], "-", ";", "paste-buffer", "-p", "-r", "-d", "-b", args[2], "-t", "s"]);
      }
      expect(new Set(pastes.map((args) => args[2])).size).toBe(pastes.length);
      // 貼った後にバッファを残さない。
      expect(buffers.size).toBe(0);
    }
  });

  test("CR / CRLF・DEL を含む短い本文が、2 通に分かれず、1 字も欠けずに届く", async () => {
    // 打つと CR は Enter になり、本文がそこで送信されていた。DEL は直前の 1 字を消していた。
    for (const [text, expected] of [["1 行目\r\n2 行目", "1 行目\n2 行目"], ["a\rb", "a\nb"], ["second line\u007f", "second line"]] as const) {
      const tui = makeTui();
      await makeManager(tui).manager.sendTextSubmit("s", text);
      expect(tui.state.typed).toEqual([]);
      expect(tui.state.submitted).toEqual([expected]);
    }
  });

  test("CRLF を含む長い本文も届く（改行が 2 倍にならない）", async () => {
    const tui = makeTui();
    await makeManager(tui).manager.sendTextSubmit("s", LONG_MULTILINE.replaceAll("\n", "\r\n"));
    expect(tui.state.submitted).toEqual([LONG_MULTILINE]);
  });

  test("引数の上限を超える日本語の長文は、貼り付けで渡す", async () => {
    const text = "あ".repeat(6000);
    const tui = makeTui();
    await makeManager(tui).manager.sendTextSubmit("s", text);
    expect(tui.state.typed).toEqual([]);
    expect(tui.state.submitted).toEqual([text]);
  });

  test("ESC を含む長い本文は貼り付けず、従来どおり打つ", async () => {
    const text = `${LONG_ASCII}\u001b[0m`;
    const tui = makeTui();
    await makeManager(tui).manager.sendTextSubmit("s", text);
    expect(tui.state.pasted).toEqual([]);
    expect(tui.state.typed).toEqual([text]);
  });

  test("貼り付けが途中で失敗したら、入った分を消し、バッファも残さず、1 通も送らない", async () => {
    const tui = makeTui();
    const { manager, buffers } = makeManager(tui, { failPasteAt: 12 });
    await expect(manager.sendTextSubmit("s", LONG_MULTILINE)).rejects.toBeInstanceOf(ChatInjectionRejectedError);
    expect(tui.state.input).toBe("");
    expect(tui.state.submitted).toEqual([]);
    expect(buffers.size).toBe(0);
  });

  test("貼り付けが 1 つ目で失敗したら、tmux のエラーを返す", async () => {
    const tui = makeTui();
    const { manager, buffers } = makeManager(tui, { failPasteAt: 1 });
    await expect(manager.sendTextSubmit("s", LONG_MULTILINE)).rejects.toBeInstanceOf(TmuxFailedError);
    expect(tui.state.submitted).toEqual([]);
    expect(buffers.size).toBe(0);
  });

  test("入ったのを確かめられなくても、打つ場合と同じく送信確定へ進む（画面が崩れて読めない場合）", async () => {
    // 実測: 肌色付きの絵文字を含む発話の後、tmux の画面が崩れて入力欄を読めなくなる。
    // CLI は生きていて、本文は入力欄に入っている。
    const tui = makeTui();
    // 入力欄の中身が画面から読めない（いつも空に見える）。
    const unreadable = ["⏺ 前の応答", "", RULE, "❯ ", RULE, `  ${BAR}`].join("\n");
    const { manager } = makeManager(tui);
    const original = tui.screen;
    tui.screen = () => { original(); return unreadable; };
    let unconfirmed = 0;
    await manager.sendTextSubmit("s", LONG_MULTILINE, { onUnconfirmedSubmit: () => { unconfirmed += 1; } });
    expect(tui.state.submitted).toEqual([LONG_MULTILINE]);
    expect(tui.state.kills).toBe(0);
    expect(unconfirmed).toBe(1);
    // 続く本文も届く（以後の送信が止まらない）。
    await manager.sendTextSubmit("s", "短い本文");
    await manager.sendTextSubmit("s", TAB_CODE);
    expect(tui.state.submitted).toEqual([LONG_MULTILINE, "短い本文", spaced(TAB_CODE)]);
  });

  test("画面が崩れた実機のフレームでも、貼り付けた本文を送信確定まで進める", async () => {
    const tui = makeTui();
    const { manager, runner } = makeManager(tui);
    const original = tui.screen;
    tui.screen = () => { original(); return INLINE_SHIFTED; };
    let unconfirmed = 0;
    await manager.sendTextSubmit("s", LONG_MULTILINE, { onUnconfirmedSubmit: () => { unconfirmed += 1; } });
    expect(tui.state.submitted).toEqual([LONG_MULTILINE]);
    expect(unconfirmed).toBe(1);
    // 入力欄を消そうとしない。印も貼らない。
    expect(tui.state.kills).toBe(0);
    expect(runner.recorded.filter((args) => args[0] === "load-buffer")).toHaveLength(splitForInlinePaste(LONG_MULTILINE).length);
  });

  test("CLI が止まっている間に送った本文は、成立を確認できずに返り、1 通だけ後から届く", async () => {
    // 変更前から、打つ経路と同じ扱い（次の送信の冒頭で、残っていた本文を独立に送る）。
    const tui = makeTui();
    const { manager } = makeManager(tui);
    tui.state.stalled = true;
    let unconfirmed = 0;
    await manager.sendTextSubmit("s", LONG_MULTILINE, { onUnconfirmedSubmit: () => { unconfirmed += 1; } });
    expect(unconfirmed).toBe(1);
    expect(tui.state.submitted).toEqual([]);
    expect(tui.state.kills).toBe(0);
    tui.resume();
    expect(tui.state.input).toBe(LONG_MULTILINE);
    await manager.sendTextSubmit("s", "次の指示");
    expect(tui.state.submitted).toEqual([LONG_MULTILINE, "次の指示"]);
  });

  test("約 10000 字の本文が 1 通でそのまま届く", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ").slice(0, 10_300);
    const tui = makeTui();
    await makeManager(tui).manager.sendTextSubmit("s", text);
    expect(tui.state.submitted).toEqual([text]);
  });

  test("添付 2 つ以上 + 長文 / タブ入りの短文（アプリが合成する形）が、そのまま届く", async () => {
    const image = "/Users/me/.tailii/uploads/shot-1.png";
    const other = "/Users/me/.tailii/uploads/IMG_0002.JPEG";
    for (const text of [`${image} ${other} これを見て ${LONG_ASCII}`, `${image} ${other} 短い本文\tタブ入り`]) {
      const tui = makeTui({ images: [image, other] });
      await makeManager(tui).manager.sendTextSubmit("s", text);
      expect(tui.state.submitted).toEqual([spaced(text)]);
      expect(tui.state.images).toBe(0);
    }
  });

  test("罫線だけの行を含む本文が届き、次の送信とつながらない", async () => {
    const tui = makeTui();
    const { manager } = makeManager(tui);
    let unconfirmed = 0;
    await manager.sendTextSubmit("s", RULE_LINE_TEXT, { onUnconfirmedSubmit: () => { unconfirmed += 1; } });
    await manager.sendTextSubmit("s", "普通の短文");
    expect(tui.state.submitted).toEqual([spaced(RULE_LINE_TEXT), "普通の短文"]);
    expect(unconfirmed).toBe(0);
    tui.state.input = "下書き\n──────────";
    await manager.sendTextSubmit("s", "次の短文");
    expect(tui.state.submitted.slice(2)).toEqual(["下書き\n──────────", "次の短文"]);
  });

  test("名前付きの会話でも、複数行の本文・罫線だけの行を含む本文が届く", async () => {
    for (const text of ["1 行目の本文です\n2 行目の本文です", RULE_LINE_TEXT, LONG_MULTILINE, TAB_CODE]) {
      const tui = makeTui({ title: "会話の名前" });
      const { manager } = makeManager(tui);
      let unconfirmed = 0;
      await manager.sendTextSubmit("s", text, { onUnconfirmedSubmit: () => { unconfirmed += 1; } });
      await manager.sendTextSubmit("s", "普通の短文", { onUnconfirmedSubmit: () => { unconfirmed += 1; } });
      expect(tui.state.submitted).toEqual([spaced(text), "普通の短文"]);
      expect(unconfirmed).toBe(0);
    }
  });

  test("タイトルの長い会話で下書きがあっても、下書きと本文がつながらない（statusLine の行があっても）", async () => {
    const title = "長い会話タイトルのテスト".repeat(8);
    for (const text of ["[SL] Reply only OK.", RULE_LINE_TEXT, LONG_MULTILINE]) {
      const tui = makeTui({ title, statusLine: "───── haiku │ main ─" });
      tui.state.input = "mac draft line";
      const { manager } = makeManager(tui);
      await manager.sendTextSubmit("s", text);
      expect(tui.state.submitted).toEqual(["mac draft line", spaced(text)]);
    }
  });

  test("印に似た語や、貼り付けの表示と同じ文言を含む下書き・本文を、特別扱いしない", async () => {
    const tui = makeTui();
    tui.state.input = "the prefix is tailii-sync-0123abcd ok";
    const { manager } = makeManager(tui);
    await manager.sendTextSubmit("s", `a\tb [Pasted text #3] [...Truncated text #3 +0 lines...]`);
    expect(tui.state.submitted).toEqual([
      "the prefix is tailii-sync-0123abcd ok",
      "a    b [Pasted text #3] [...Truncated text #3 +0 lines...]",
    ]);
  });

  test("Mac 側で貼り付けた下書き（畳まれた表示）は、従来どおり独立に送ってから注入する", async () => {
    const tui = makeTui();
    tui.write(`${BRACKETED_PASTE_START}${LONG_ASCII}${BRACKETED_PASTE_END}`);
    expect(tui.state.input).toBe("[Pasted text #1]");
    const recorded = `\n\n<pasted_content id="0baf">\n${LONG_ASCII}\n</pasted_content id="0baf">\n`;
    await makeManager(tui).manager.sendTextSubmit("s", "短い本文", { recordedPromptText: () => recorded });
    expect(tui.state.submitted).toEqual([LONG_ASCII, "短い本文"]);
  });

  test("中断で書き戻された長い発話は、送り直さずに消す（30 行でも消し切る）", async () => {
    for (const text of [LONG_ASCII, LONG_MULTILINE, TAB_CODE]) {
      const tui = makeTui();
      tui.state.input = spaced(text);
      const { manager } = makeManager(tui);
      await manager.sendTextSubmit("s", "別の指示", { recordedPromptText: () => spaced(text) });
      expect(tui.state.submitted).toEqual(["別の指示"]);
      // 単体でも空にできる（中断の直後に engine が呼ぶ）。
      tui.state.input = spaced(text);
      expect(await manager.clearInputBox("s")).toBe(true);
      expect(tui.state.input).toBe("");
    }
  });

  test("C-u の効かない残存には、打ち続けない", async () => {
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    tui.kill = () => { tui.state.kills += 1; };
    const { manager, runner } = makeManager(tui);
    expect(await manager.clearInputBox("s")).toBe(false);
    expect(runner.recorded.filter((args) => args.includes("C-u")).every((args) => args.filter((arg) => arg === "C-u").length === 1)).toBe(true);
    expect(tui.state.input).toBe(LONG_MULTILINE);
  });
});

describe("herdr: 長い本文の注入", () => {
  function makeManager(tui: Tui) {
    const store = new SessionMetadataStore(makeTempDir("long-text-paste-herdr"));
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const herdrOk = (stdout: string): HerdrCommandResult => ({ exitCode: 0, stdout, stderr: "" });
    const recorded: string[][] = [];
    const runner: HerdrCommandRunner = async (args) => {
      recorded.push(args);
      if (args[0] === "pane" && args[1] === "list") {
        return herdrOk(JSON.stringify({
          id: "cli:pane:list",
          result: { type: "pane_list", panes: [{ pane_id: "w4:p2", label: "s-a" }] },
        }));
      }
      if (args[0] === "pane" && args[1] === "get") {
        return herdrOk(JSON.stringify({ id: "cli:pane:get", result: { pane: { agent_status: "idle" } } }));
      }
      if (args[0] === "pane" && args[1] === "read") return herdrOk(tui.screen());
      if (args[0] === "pane" && args[1] === "send-text") {
        const text = args[3] ?? "";
        if (text === "\r") tui.enter();
        else if (/^\u0015+$/.test(text)) tui.kill(text.length);
        else if (/^\u007f+$/.test(text)) tui.backspace(text.length);
        else tui.write(text);
      }
      return herdrOk("");
    };
    const manager = new HerdrSessionManager({
      runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0, clearKeyDelayMs: 0,
      readyTimeoutMs: 1000, readyPollMs: 0,
      pastedTextPollMs: 1, pastedTextTimeoutMs: 40, clearSettleMs: 10,
    });
    return { manager, recorded };
  }

  test("1 回で打つと貼り付けになって失敗していた本文が、小分けの貼り付けなら届く", async () => {
    // 旧実装は 983 字を 1 回で打ち、入力欄の `[Pasted text #N]` を「打鍵が届いていない」と
    // 判定して 3 回打ち直した末に送信を失敗させていた（実測 2.1.283）。
    const text = LONG_ASCII.slice(0, 983);
    const tui = makeTui();
    const { manager, recorded } = makeManager(tui);
    await manager.sendTextSubmit("s-a", text);
    expect(tui.state.submitted).toEqual([text]);
    expect(tui.state.pastes).toBe(0);
    const sends = recorded.filter((args) => args[1] === "send-text").map((args) => args[3]);
    // 括弧付き貼り付けを、1 つずつ書き込む。
    expect(sends).toEqual([
      ...splitForInlinePaste(text).map((piece) => `${BRACKETED_PASTE_START}${piece}${BRACKETED_PASTE_END}`),
      "\r",
    ]);
    expect(splitForInlinePaste(text).length).toBeGreaterThan(1);
  });

  test("複数行・タブ入り・CRLF の長い本文も 1 通でそのまま届く", async () => {
    for (const text of [LONG_MULTILINE, TAB_CODE, "a\tb", LONG_MULTILINE.replaceAll("\n", "\r\n")]) {
      const tui = makeTui();
      await makeManager(tui).manager.sendTextSubmit("s-a", text);
      expect(tui.state.submitted).toEqual([spaced(text).replaceAll("\r\n", "\n")]);
      expect(tui.state.typed).toEqual([]);
    }
  });

  test("1 回で打っても壊れない本文は、従来どおり打って反映を確かめる", async () => {
    const short = makeTui();
    const first = makeManager(short);
    await first.manager.sendTextSubmit("s-a", "短い本文");
    expect(short.state.typed).toEqual(["短い本文"]);
    expect(short.state.submitted).toEqual(["短い本文"]);

    const japanese = makeTui();
    const second = makeManager(japanese);
    const text = "これは長い日本語の本文です。".repeat(40);
    expect(typedTextWouldBreak(text)).toBe(false);
    await second.manager.sendTextSubmit("s-a", text);
    expect(japanese.state.pasted).toEqual([]);
    expect(japanese.state.submitted).toEqual([text]);
    const reads = (calls: string[][]): number => calls.filter((args) => args[1] === "read").length;
    expect(reads(second.recorded)).toBe(reads(first.recorded));
  });

  test("入力欄に入ったのを確かめられなければ、1 通も送らずに失敗する（貼り直さない）", async () => {
    const tui = makeTui();
    const { manager, recorded } = makeManager(tui);
    tui.state.stalled = true;
    await expect(manager.sendTextSubmit("s-a", LONG_MULTILINE)).rejects.toThrow(/pasted text did not reach/);
    expect(tui.state.submitted).toEqual([]);
    // 貼り付けは 1 回ぶんだけ（打つ経路のように 3 回打ち直さない）。Enter も打たない。
    const sends = recorded.filter((args) => args[1] === "send-text").map((args) => args[3] ?? "");
    expect(sends.filter((payload) => payload.startsWith(BRACKETED_PASTE_START))).toHaveLength(splitForInlinePaste(LONG_MULTILINE).length);
    expect(sends).not.toContain("\r");
    tui.resume();
    // 後から入った本文は 1 回ぶん。次の送信の冒頭で、従来どおり独立に送られる。
    expect(tui.state.input).toBe(LONG_MULTILINE);
    await manager.sendTextSubmit("s-a", "次の指示");
    expect(tui.state.submitted).toEqual([LONG_MULTILINE, "次の指示"]);
  });

  test("約 10000 字の本文が 1 通でそのまま届く", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ").slice(0, 10_300);
    const tui = makeTui();
    await makeManager(tui).manager.sendTextSubmit("s-a", text);
    expect(tui.state.submitted).toEqual([text]);
  });

  test("添付 2 つ以上 + 長文 / タブ入りの短文（アプリが合成する形）が、そのまま届く", async () => {
    const image = "/Users/me/.tailii/uploads/shot-1.png";
    const other = "/Users/me/.tailii/uploads/IMG_0002.JPEG";
    for (const text of [`${image} ${other} これを見て ${LONG_ASCII}`, `${image} ${other} 短い本文\tタブ入り`]) {
      const tui = makeTui({ images: [image, other] });
      await makeManager(tui).manager.sendTextSubmit("s-a", text);
      expect(tui.state.submitted).toEqual([spaced(text)]);
      expect(tui.state.images).toBe(0);
    }
  });

  test("罫線だけの行を含む本文が届き、次の送信とつながらない", async () => {
    // 旧: 入力欄の中の罫線の行を枠と取り違え、貼り付けた本文を確かめられずに失敗した。残った
    // 前半は「入力欄は空」と判定され、次の本文がその後ろにつながって 1 通で送信された。
    const tui = makeTui();
    const { manager } = makeManager(tui);
    await manager.sendTextSubmit("s-a", RULE_LINE_TEXT);
    await manager.sendTextSubmit("s-a", "普通の短文");
    expect(tui.state.submitted).toEqual([spaced(RULE_LINE_TEXT), "普通の短文"]);
    // 罫線だけの行を含む下書きが残っていても、独立に送ってから注入する。
    tui.state.input = "下書き\n──────────";
    await manager.sendTextSubmit("s-a", "次の短文");
    expect(tui.state.submitted.slice(2)).toEqual(["下書き\n──────────", "次の短文"]);
    // 消すときも、罫線の行より前まで消し切る。
    tui.state.input = spaced(RULE_LINE_TEXT);
    expect(await manager.clearInputBox("s-a")).toBe(true);
    expect(tui.state.input).toBe("");
  });

  test("確かめられなかったら、入った分を消してから失敗として返す（残りを次の送信へ持ち越さない）", async () => {
    // CLI が貼り付けを畳んだ（境界が変わった）。入力欄には畳まれた表示が入っている。
    const tui = makeTui({ mangle: (text) => `${text}${"\n".repeat(3)}` });
    const { manager } = makeManager(tui);
    await expect(manager.sendTextSubmit("s-a", "a\tb")).rejects.toThrow(/pasted text did not reach/);
    expect(tui.state.input).toBe("");
    expect(tui.state.submitted).toEqual([]);
  });

  test("名前付きの会話でも、複数行の本文・罫線だけの行を含む本文が届く", async () => {
    // 旧: 上の枠を見失い、入力欄を「最後の ❯ 行 1 行だけ」と読んでいた。2 行以上の本文は、
    // 打っても貼り付けても「入力欄に入らなかった」と判定されて失敗した。
    const typed = "1 行目の本文です\n2 行目の本文です";
    for (const text of [typed, RULE_LINE_TEXT, LONG_MULTILINE, TAB_CODE]) {
      const tui = makeTui({ title: "会話の名前" });
      const { manager } = makeManager(tui);
      await manager.sendTextSubmit("s-a", text);
      await manager.sendTextSubmit("s-a", "普通の短文");
      expect(tui.state.submitted).toEqual([spaced(text), "普通の短文"]);
    }
  });

  test("タイトルの長い会話でも、複数行の本文が届き、下書きとつながらない", async () => {
    const title = "長い会話タイトルのテスト".repeat(8);
    for (const text of ["1 行目の本文です\n2 行目の本文です", RULE_LINE_TEXT, LONG_MULTILINE]) {
      const tui = makeTui({ title, statusLine: "───── haiku │ main ─" });
      tui.state.input = "mac draft line";
      const { manager } = makeManager(tui);
      await manager.sendTextSubmit("s-a", text);
      expect(tui.state.submitted).toEqual(["mac draft line", spaced(text)]);
    }
  });

  test("打つ経路の本文は、従来どおり 3 回まで打ち直す（変更していない）", async () => {
    const tui = makeTui();
    const { manager, recorded } = makeManager(tui);
    tui.state.stalled = true;
    await expect(manager.sendTextSubmit("s-a", "短い本文です。届きますか")).rejects.toThrow(/typed text did not reach/);
    expect(recorded.filter((args) => args[1] === "send-text" && args[3] === "短い本文です。届きますか")).toHaveLength(3);
  });

  test("中断で書き戻された長い発話は、送り直さずに消す（30 行でも消し切る）", async () => {
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    const { manager } = makeManager(tui);
    await manager.sendTextSubmit("s-a", "別の指示", { recordedPromptText: () => LONG_MULTILINE });
    expect(tui.state.submitted).toEqual(["別の指示"]);
    tui.state.input = LONG_MULTILINE;
    expect(await manager.clearInputBox("s-a")).toBe(true);
    expect(tui.state.input).toBe("");
  });

  test("C-u の効かない残存には、打ち続けない", async () => {
    const tui = makeTui();
    tui.state.input = LONG_MULTILINE;
    tui.kill = () => { tui.state.kills += 1; };
    const { manager, recorded } = makeManager(tui);
    expect(await manager.clearInputBox("s-a")).toBe(false);
    // 1 回ずつ 15 回まで。まとめて打つ続きへは進まない。
    const kills = recorded.filter((args) => args[1] === "send-text" && /^\u0015+$/.test(args[3] ?? ""));
    expect(kills.every((args) => args[3] === "\u0015")).toBe(true);
    expect(kills.length).toBeLessThanOrEqual(15);
    expect(tui.state.input).toBe(LONG_MULTILINE);
  });

  test("結合文字を含む短い本文の反映検証が通る", async () => {
    const text = "café を が と書く";
    const tui = makeTui({});
    // 端末には合成済みで映る。
    const original = tui.screen;
    tui.screen = () => original().normalize("NFC");
    const { manager } = makeManager(tui);
    await manager.sendTextSubmit("s-a", text);
    expect(tui.state.submitted).toEqual([text]);
  });
});
