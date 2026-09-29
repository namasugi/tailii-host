// pastedContent.ts
// tailii (TS host) — Claude Code が貼り付けた本文に付ける包み（`<pasted_content>`）の扱い。
//
// Claude Code（実測 2.1.284）は、貼り付けとして取り込んだ本文を transcript へ次の形で記録する:
//
//   \n\n<pasted_content id="0baf">\n本文\n</pasted_content id="0baf">\n
//
// id は会話ごとに決まる短い 16 進で、閉じタグにも同じ id が付く。先頭の空行は付かないこともある
// （キューから取り込まれた発話）。包みは Claude に「貼り付けられた内容」と伝えるためのもので、
// 利用者に見せる本文ではない。host は表示・照合の直前に外す（transcript そのものは書き換えない）。

const OPEN_PREFIX = '<pasted_content id="';
const ID_PATTERN = /^[0-9A-Za-z_-]{1,32}$/;
const ID_TERMINATOR = '">\n';

const CLOSE_PREFIX = '\n</pasted_content id="';
const CLOSE_SUFFIX = '">';

/** 閉じタグの位置を id ごとに集める（本文を 1 回だけ走査する）。位置は昇順。 */
function indexClosings(text: string): Map<string, number[]> {
  const closings = new Map<string, number[]>();
  for (let at = text.indexOf(CLOSE_PREFIX); at !== -1; at = text.indexOf(CLOSE_PREFIX, at + 1)) {
    const idStart = at + CLOSE_PREFIX.length;
    // id は 32 字まで。その範囲に終わりが無ければ閉じタグではない（本文の末尾まで探さない）。
    const idEnd = text.slice(idStart, idStart + 32 + CLOSE_SUFFIX.length).indexOf(CLOSE_SUFFIX);
    if (idEnd === -1) continue;
    const id = text.slice(idStart, idStart + idEnd);
    if (!ID_PATTERN.test(id)) continue;
    const list = closings.get(id);
    if (list === undefined) closings.set(id, [at]);
    else list.push(at);
  }
  return closings;
}

/** 昇順の `positions` のうち、`from` 以上で最初のもの（無ければ -1）。 */
function firstAtOrAfter(positions: number[], from: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((positions[middle] ?? 0) < from) low = middle + 1;
    else high = middle;
  }
  return positions[low] ?? -1;
}

/** `from` 以降で最初の、開きと閉じが同じ id でそろった包みを探す。 */
function findBlock(
  text: string,
  from: number,
  closings: Map<string, number[]>,
): { start: number; end: number; body: string } | null {
  for (let open = text.indexOf(OPEN_PREFIX, from); open !== -1; open = text.indexOf(OPEN_PREFIX, open + 1)) {
    const idStart = open + OPEN_PREFIX.length;
    const idEnd = text.slice(idStart, idStart + 32 + ID_TERMINATOR.length).indexOf(ID_TERMINATOR);
    if (idEnd === -1) continue;
    const id = text.slice(idStart, idStart + idEnd);
    if (!ID_PATTERN.test(id)) continue;
    const bodyStart = idStart + idEnd + ID_TERMINATOR.length;
    const close = firstAtOrAfter(closings.get(id) ?? [], bodyStart);
    if (close === -1) continue;
    return {
      start: open,
      end: close + CLOSE_PREFIX.length + id.length + CLOSE_SUFFIX.length,
      body: text.slice(bodyStart, close),
    };
  }
  return null;
}

/** `index` から前後へ続く改行を読み飛ばした位置。 */
function skipNewlines(text: string, index: number, step: 1 | -1): number {
  let cursor = index;
  if (step === 1) while (text[cursor] === "\n") cursor += 1;
  else while (cursor > 0 && text[cursor - 1] === "\n") cursor -= 1;
  return cursor;
}

/**
 * 包みを外した本文を返す（包みが無ければそのまま）。
 * 包みの前後に利用者が打った本文があれば、改行 1 つで区切って残す。
 * 本文の長さに比例する時間で終わる（正規表現や、開きタグごとに末尾まで閉じを探す方法は、
 * 開きタグや改行が大量に続く本文で入力の 2 乗の時間になる）。
 */
export function unwrapPastedContent(text: string): string {
  // 利用者の本文にあった `<pasted_content` は、CLI が `<\pasted_content`（閉じは `<\/pasted_content`）に
  // 書き換えて記録する（実測 2.1.284）。元の形に戻す。
  if (!text.includes(OPEN_PREFIX)) return text.includes("<\\") ? restoreEscapedTags(text) : text;
  return restoreEscapedTags(unwrapBlocks(text));
}

function restoreEscapedTags(text: string): string {
  return text.replace(/<\\(\/?)pasted_content/g, "<$1pasted_content");
}

function unwrapBlocks(text: string): string {
  let result = "";
  let cursor = 0;
  const closings = indexClosings(text);
  for (let block = findBlock(text, cursor, closings); block !== null; block = findBlock(text, cursor, closings)) {
    const before = text.slice(cursor, Math.max(cursor, skipNewlines(text, block.start, -1)));
    if (before.length > 0) result += `${before}\n`;
    result += block.body;
    cursor = skipNewlines(text, block.end, 1);
    if (cursor < text.length) result += "\n";
  }
  return result + text.slice(cursor);
}
