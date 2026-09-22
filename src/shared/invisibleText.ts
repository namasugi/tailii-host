// invisibleText.ts
// tailii (TS host) - 不可視文字の比較用正規化（iOS `InvisibleText.swift` と同値実装）。
//
// Claude Code 2.1.277 から、composer へ入れた本文に不可視文字（ゼロ幅・双方向制御・
// 異体字セレクタ・タグ文字ほか）が含まれていると、最初の Enter では**送信されず**、
// 除去後の本文を入力欄に残したまま「Removed N invisible characters . review and press
// Enter to send」を出して確認待ちになる（2 回目の Enter で送信。2.1.278 実測）。
// transcript に残るのは**除去後**の本文なので、
//   - 送信した本文（iOS の楽観バブル・host の記録本文）
//   - transcript / 入力欄に現れる本文
// の 2 つが不可視文字の分だけ食い違い、同文照合がすべて外れる。
//
// **この正規化は「照合」専用**。送信する本文の加工には決して使わない:
// CLI は文脈しだいで ZWJ / 異体字セレクタを**残す**（絵文字の連結・VS16 など）ため、
// ここと同じ一律除去を送信本文へ適用すると家族絵文字が 3 人へ割れるといった破壊になる。
// 照合では両辺へ同じ除去を掛けるので、CLI が残したか消したかに関わらず一致する
// （= CLI の保持規則を再実装しなくてよい）。
//
// レンジは CLI の「不可視候補」判定（2.1.278 バイナリ実測）と同一。CLI が実際に除去するのは
// この候補の**部分集合**（文脈しだいで残す）なので、候補の全除去は常に安全な上界になる。
// 文字クラス正規表現ではなくコードポイント表で持つのは、CLI 側の判定が数値レンジであり
// 一対一で突き合わせられるため（Swift 版も同じ表を持つ）。

/**
 * 不可視・書式制御のコードポイントレンジ（両端含む）。
 *
 * **昇順・非重複であることが `isInvisibleCodePoint` の早期 return の前提**（末尾へ追記すると
 * 到達しない）。不変条件はテストで守る（`invisibleText.test.ts`）。
 * TAB(0x09) / LF(0x0A) は CLI も残すので含めない（空白の正規化は呼び出し側の責務）。
 */
export const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008], // C0 制御（TAB 未満）
  [0x000b, 0x001f], // C0 制御（LF 超。CR を含む）
  [0x007f, 0x009f], // DEL + C1 制御（NEL 0x85 を含む）
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x034f, 0x034f], // COMBINING GRAPHEME JOINER
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x115f, 0x1160], // HANGUL CHOSEONG/JUNGSEONG FILLER
  [0x17b4, 0x17b5], // KHMER VOWEL INHERENT AQ/AA
  [0x180b, 0x180f], // MONGOLIAN FVS / VOWEL SEPARATOR
  [0x200b, 0x200f], // ZWSP / ZWNJ / ZWJ / LRM / RLM
  [0x2028, 0x202e], // LINE|PARAGRAPH SEPARATOR / 双方向埋め込み・上書き
  [0x2060, 0x206f], // WORD JOINER / 不可視演算子 / 非推奨書式文字
  [0x3164, 0x3164], // HANGUL FILLER
  [0xfe00, 0xfe0f], // VARIATION SELECTOR-1..16
  [0xfeff, 0xfeff], // BOM (ZERO WIDTH NO-BREAK SPACE)
  [0xffa0, 0xffa0], // HALFWIDTH HANGUL FILLER
  [0xfff0, 0xfffb], // 未割当 + 行間注釈（INTERLINEAR ANNOTATION）
  [0x1107f, 0x1107f], // BRAHMI NUMBER JOINER
  [0x13430, 0x1343f], // EGYPTIAN HIEROGLYPH FORMAT CONTROLS
  [0x16fe4, 0x16fe4], // KHITAN SMALL SCRIPT FILLER
  [0x1bca0, 0x1bca3], // SHORTHAND FORMAT CONTROLS
  [0x1d173, 0x1d17a], // MUSICAL SYMBOL BEAM/SLUR/PHRASE
  [0xe0000, 0xe0fff], // タグ文字 + VARIATION SELECTOR SUPPLEMENT
];

/** 不可視・書式制御のコードポイントか（純ロジック, TESTABLE）。 */
export function isInvisibleCodePoint(codePoint: number): boolean {
  for (const [low, high] of INVISIBLE_RANGES) {
    if (codePoint < low) return false; // 表は昇順。以降は必ず範囲外。
    if (codePoint <= high) return true;
  }
  return false;
}

/**
 * 照合用に不可視文字を落とす（純ロジック, TESTABLE）。
 * **送信本文の加工には使わない**（モジュール冒頭の注意を参照）。
 */
export function stripInvisibleForComparison(text: string): string {
  let result = "";
  // for...of は文字列をコードポイント単位で回す（サロゲートペアを割らない）。
  for (const character of text) {
    if (isInvisibleCodePoint(character.codePointAt(0) ?? 0)) continue;
    result += character;
  }
  return result;
}

/** 照合用の正規化（不可視文字 + 空白類をすべて落とす）。 */
export function normalizeForTextMatch(text: string): string {
  return stripInvisibleForComparison(text).replace(/\s+/gu, "");
}
