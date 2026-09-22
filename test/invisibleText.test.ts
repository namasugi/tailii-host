// invisibleText.test.ts
// 不可視文字の比較用正規化（iOS InvisibleText.swift と同値実装）。
// ソースに生の不可視文字を置かないため、サンプルは String.fromCodePoint で組み立てる。

import { describe, expect, test } from "vitest";
import {
  INVISIBLE_RANGES,
  isInvisibleCodePoint,
  normalizeForTextMatch,
  stripInvisibleForComparison,
} from "../src/shared/invisibleText.js";

const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const BOM = String.fromCodePoint(0xfeff);

/** Claude Code 2.1.278 の「不可視候補」判定に含まれる各レンジの代表スカラー。 */
const INVISIBLE_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["C0 制御(NUL)", String.fromCodePoint(0x0)],
  ["C0 制御(CR)", String.fromCodePoint(0xd)],
  ["C0 制御(ESC)", String.fromCodePoint(0x1b)],
  ["DEL", String.fromCodePoint(0x7f)],
  ["C1(NEL)", String.fromCodePoint(0x85)],
  ["SOFT HYPHEN", String.fromCodePoint(0xad)],
  ["COMBINING GRAPHEME JOINER", String.fromCodePoint(0x34f)],
  ["ARABIC LETTER MARK", String.fromCodePoint(0x61c)],
  ["HANGUL CHOSEONG FILLER", String.fromCodePoint(0x115f)],
  ["HANGUL JUNGSEONG FILLER", String.fromCodePoint(0x1160)],
  ["KHMER VOWEL INHERENT AQ", String.fromCodePoint(0x17b4)],
  ["MONGOLIAN FVS1", String.fromCodePoint(0x180b)],
  ["MONGOLIAN VOWEL SEPARATOR", String.fromCodePoint(0x180e)],
  ["ZERO WIDTH SPACE", String.fromCodePoint(0x200b)],
  ["ZERO WIDTH NON-JOINER", String.fromCodePoint(0x200c)],
  ["ZERO WIDTH JOINER", String.fromCodePoint(0x200d)],
  ["LEFT-TO-RIGHT MARK", String.fromCodePoint(0x200e)],
  ["LINE SEPARATOR", String.fromCodePoint(0x2028)],
  ["RIGHT-TO-LEFT OVERRIDE", String.fromCodePoint(0x202e)],
  ["WORD JOINER", String.fromCodePoint(0x2060)],
  ["INVISIBLE TIMES", String.fromCodePoint(0x2062)],
  ["HANGUL FILLER", String.fromCodePoint(0x3164)],
  ["VARIATION SELECTOR-1", String.fromCodePoint(0xfe00)],
  ["VARIATION SELECTOR-16", String.fromCodePoint(0xfe0f)],
  ["BOM", String.fromCodePoint(0xfeff)],
  ["HALFWIDTH HANGUL FILLER", String.fromCodePoint(0xffa0)],
  ["INTERLINEAR ANNOTATION ANCHOR", String.fromCodePoint(0xfff9)],
  ["BRAHMI NUMBER JOINER", String.fromCodePoint(0x1107f)],
  ["EGYPTIAN HIEROGLYPH VERT JOINER", String.fromCodePoint(0x13430)],
  ["KHITAN SMALL SCRIPT FILLER", String.fromCodePoint(0x16fe4)],
  ["SHORTHAND FORMAT LETTER OVERLAP", String.fromCodePoint(0x1bca0)],
  ["MUSICAL SYMBOL BEGIN BEAM", String.fromCodePoint(0x1d173)],
  ["TAG LATIN SMALL LETTER A", String.fromCodePoint(0xe0061)],
  ["VARIATION SELECTOR-17", String.fromCodePoint(0xe0100)],
];

describe("stripInvisibleForComparison", () => {
  test("CLI の不可視候補レンジの代表スカラーをすべて落とす", () => {
    for (const [name, scalar] of INVISIBLE_SAMPLES) {
      // どのレンジで落ちなかったかが失敗メッセージに出るよう名前ごと比較する。
      expect(`${name}:${stripInvisibleForComparison(`A${scalar}B`)}`).toBe(`${name}:AB`);
    }
  });

  test("可視文字・通常の空白・絵文字の土台と肌色修飾は落とさない", () => {
    // TAB / LF は CLI も残す（除去対象は不可視候補のみ。空白の正規化は別責務）。
    expect(stripInvisibleForComparison("a\tb\nc")).toBe("a\tb\nc");
    expect(stripInvisibleForComparison("全角\u3000空白")).toBe("全角\u3000空白");
    // 肌色修飾（U+1F3FB-1F3FF）は候補外。
    const thumbsUp = String.fromCodePoint(0x1f44d) + String.fromCodePoint(0x1f3fb);
    expect(stripInvisibleForComparison(thumbsUp)).toBe(thumbsUp);
    expect(stripInvisibleForComparison("日本語 ASCII 1234 !?")).toBe("日本語 ASCII 1234 !?");
  });

  test("含まない本文はそのまま返し、連続呼び出しでも結果が変わらない", () => {
    const text = "git status を見て";
    expect(stripInvisibleForComparison(text)).toBe(text);
    expect(stripInvisibleForComparison(text)).toBe(text);
    const dirty = `a${ZWSP}b${ZWSP}c`;
    expect(stripInvisibleForComparison(dirty)).toBe("abc");
    expect(stripInvisibleForComparison(dirty)).toBe("abc");
  });

  test("ZWJ 連結絵文字は両辺から同じく落ちるので照合では一致する（表示本文の加工には使わない）", () => {
    const man = String.fromCodePoint(0x1f468);
    const woman = String.fromCodePoint(0x1f469);
    const girl = String.fromCodePoint(0x1f467);
    const family = `${man}${ZWJ}${woman}${ZWJ}${girl}`;
    // 一律除去は表示としては破壊的（3 人に割れる）。だからこそ送信本文には使わない。
    expect(stripInvisibleForComparison(family)).toBe(`${man}${woman}${girl}`);
    // CLI が ZWJ を残しても落としても、両辺へ同じ除去を掛ければ一致する。
    expect(stripInvisibleForComparison(family)).toBe(
      stripInvisibleForComparison(`${man}${woman}${girl}`),
    );
  });
});

/**
 * Claude Code 2.1.278 バイナリから採取した「不可視候補」判定をそのまま書き写したもの。
 * レンジ表は人が書き下すので、将来の編集で 1 文字ずれても抜き取りテストでは気づけない
 * （例: `0xFFF0...0xFFFB` を `...0xFFFF` にすると U+FFFD を過剰除去するが、
 * 代表スカラー 0xFFF9 のテストは緑のまま）。全コード空間で突き合わせて守る。
 */
function cliInvisibleCandidate(e: number): boolean {
  if (e < 160) return (e < 32 && e !== 9 && e !== 10) || e >= 127;
  if (e < 8192) {
    return e === 173 || e === 847 || e === 1564 || e === 4447 || e === 4448
      || e === 6068 || e === 6069 || (e >= 6155 && e <= 6159);
  }
  if (e < 65536) {
    return (e >= 8203 && e <= 8207) || (e >= 8232 && e <= 8238) || (e >= 8288 && e <= 8303)
      || e === 12644 || (e >= 65024 && e <= 65039) || e === 65279 || e === 65440
      || (e >= 65520 && e <= 65531);
  }
  return e === 69759 || (e >= 78896 && e <= 78911) || e === 94180
    || (e >= 113824 && e <= 113827) || (e >= 119155 && e <= 119162)
    || (e >= 917504 && e <= 921599);
}

describe("INVISIBLE_RANGES", () => {
  test("昇順・非重複（早期 return の前提。末尾へ追記すると到達しなくなる）", () => {
    const broken: string[] = [];
    for (const [index, [low, high]] of INVISIBLE_RANGES.entries()) {
      if (low > high) broken.push(`#${index} は low > high`);
      const previous = INVISIBLE_RANGES[index - 1];
      if (previous !== undefined && previous[1] >= low) {
        broken.push(`#${index} が #${index - 1} と重なる/逆順`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("isInvisibleCodePoint", () => {
  test("CLI の判定と全コード空間（U+0000..U+10FFFF）で一致する", () => {
    const mismatches: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (isInvisibleCodePoint(codePoint) !== cliInvisibleCandidate(codePoint)) {
        // 全件並べると読めないので先頭 20 件だけ晒す。
        if (mismatches.length < 20) {
          mismatches.push(`U+${codePoint.toString(16).toUpperCase()}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("レンジ境界の内外を正しく分ける", () => {
    expect(isInvisibleCodePoint(0x0009)).toBe(false); // TAB は残す
    expect(isInvisibleCodePoint(0x000a)).toBe(false); // LF は残す
    expect(isInvisibleCodePoint(0x0008)).toBe(true);
    expect(isInvisibleCodePoint(0x000b)).toBe(true);
    expect(isInvisibleCodePoint(0x00ac)).toBe(false);
    expect(isInvisibleCodePoint(0x00ae)).toBe(false);
    expect(isInvisibleCodePoint(0x200a)).toBe(false);
    expect(isInvisibleCodePoint(0x2010)).toBe(false);
    expect(isInvisibleCodePoint(0xe0fff)).toBe(true);
    expect(isInvisibleCodePoint(0xe1000)).toBe(false);
    expect(isInvisibleCodePoint(0x10ffff)).toBe(false);
  });
});

describe("normalizeForTextMatch", () => {
  test("不可視文字と空白類をまとめて落とす", () => {
    expect(normalizeForTextMatch(`あ${ZWSP} い\nう\t`)).toBe("あいう");
    const soft = String.fromCodePoint(0x00ad);
    expect(normalizeForTextMatch(`中周を${soft}1枚足す`)).toBe(normalizeForTextMatch("中周を 1枚足す"));
  });

  test("不可視文字だけの本文は空になる", () => {
    expect(normalizeForTextMatch(`${ZWSP}${BOM}${String.fromCodePoint(0x2060)}`)).toBe("");
  });
});
