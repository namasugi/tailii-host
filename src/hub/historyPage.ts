// historyPage.ts
// tailii (TS host) — 会話履歴のページ取得（history-page）。
//
// 会話を初めて開く（iOS にキャッシュが無い）ときは全履歴を頭から流さず、最新の数行を先に返し、
// 残りは新しい順にページで返す。キャッシュより古い過去を遡るときも同じページを使う。
// ページの中身は全履歴の再送と同じ ChatTailController の出力（本文・ツール・画像・stream 別名）を、
// 表示 1 行ぶんの単位で切り出したもの。順序はページ内では古い順（iOS はそのまま先頭へ足す）。

import type { ControlMessage } from "../protocol.js";

/** ページの終端（この行より前を返す）。どちらも無ければ最新のページ。 */
export interface HistoryPageAnchor {
  streamId?: string;
  toolId?: string;
}

export interface HistoryPageSlice {
  events: ControlMessage[];
  /** これより古い行がまだある。 */
  hasMore: boolean;
  /** 終端の行が見つかった（最新のページは常に true）。 */
  anchorFound: boolean;
}

/** ページに載せる型（表示の行と、その位置合わせに要るものだけ）。 */
function isPageEvent(event: ControlMessage): boolean {
  switch (event.type) {
    case "chat_output":
      // pc:* は履歴境界・現在モデル等のマーカー。過去のページで現在値を上書きさせない。
      return !event.streamId.startsWith("pc:");
    case "chat_stream_alias":
    case "tool_activity":
    case "image_available":
      return true;
    default:
      return false;
  }
}

/**
 * 全履歴の出力列から、`anchor` より前の最後の `limit` 行ぶんを切り出す。
 *
 * 行の数え方は iOS の表示に合わせる: 本文（chat_output）は streamId ごとに 1 行、連続する
 * ツール実行（tool_activity）はまとめて 1 行。stream 別名と画像は直後 / 直前の行に付ける。
 * 既出 id の tool_activity（後着の内容更新）は新しい行にしない。
 * `anchor` が見つからなければ空（それより古い行は返せない）。
 */
export function sliceHistoryPage(
  all: readonly ControlMessage[],
  anchor: HistoryPageAnchor | null,
  limit: number,
): HistoryPageSlice {
  const events = all.filter(isPageEvent);
  let end = events.length;
  if (anchor !== null && (anchor.streamId !== undefined || anchor.toolId !== undefined)) {
    const anchorStreams = anchor.streamId === undefined ? null : streamGroup(events, anchor.streamId);
    end = events.findIndex((event) =>
      (anchorStreams !== null && event.type === "chat_output" && anchorStreams.has(event.streamId)) ||
      (anchor.toolId !== undefined && event.type === "tool_activity" && event.activity.id === anchor.toolId));
    if (end < 0) return { events: [], hasMore: false, anchorFound: false };
    // 終端の行の直前に連なる stream 別名はその行のもの（前のページへ入れない）。
    while (end > 0 && events[end - 1]!.type === "chat_stream_alias") end -= 1;
  }

  // 行の開始位置（直前に連なる stream 別名を含める）を古い順に集める。
  const rowStarts: number[] = [];
  const seenTools = new Set<string>();
  let previousRowKind: "text" | "tool" | null = null;
  let previousStreamId: string | null = null;
  let aliasRunStart: number | null = null;
  for (let index = 0; index < end; index += 1) {
    const event = events[index]!;
    if (event.type === "chat_stream_alias") {
      aliasRunStart ??= index;
      continue;
    }
    let startsRow = false;
    if (event.type === "chat_output") {
      startsRow = previousRowKind !== "text" || event.streamId !== previousStreamId;
      previousRowKind = "text";
      previousStreamId = event.streamId;
    } else if (event.type === "tool_activity") {
      const isNewTool = !seenTools.has(event.activity.id);
      seenTools.add(event.activity.id);
      if (isNewTool) {
        startsRow = previousRowKind !== "tool";
        previousRowKind = "tool";
        previousStreamId = null;
      }
    }
    if (startsRow) rowStarts.push(aliasRunStart ?? index);
    aliasRunStart = null;
  }

  const take = Math.max(1, Math.floor(limit));
  const firstRow = Math.max(0, rowStarts.length - take);
  const start = rowStarts.length === 0 ? end : rowStarts[firstRow]!;
  // ツールの内容更新（同じ id の後着）は元のカードと同じページで渡す: 元がこれより前のページにある更新は
  // 載せず（iOS が更新の位置に新しいカードを作る）、元がこのページにあるツールは終端より後の最終内容を添える。
  const firstToolIndex = new Map<string, number>();
  const lastToolIndex = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.type !== "tool_activity") return;
    if (!firstToolIndex.has(event.activity.id)) firstToolIndex.set(event.activity.id, index);
    lastToolIndex.set(event.activity.id, index);
  });
  const page = events.slice(start, end).filter((event) =>
    event.type !== "tool_activity" || firstToolIndex.get(event.activity.id)! >= start);
  for (const [id, first] of firstToolIndex) {
    const last = lastToolIndex.get(id)!;
    if (first >= start && first < end && last >= end) page.push(events[last]!);
  }
  // 最新のページには現在値のマーカー（モデル・コンテキスト量・effort 等）の最後の値を添える。続きの購読は
  // 差分なので、その範囲に assistant 行が無ければマーカーが届かず、ヘッダが空のままになる。
  if (anchor === null) page.push(...latestStateMarkers(all));
  return { events: page, hasMore: firstRow > 0, anchorFound: true };
}

/** 履歴境界以外の `pc:*` マーカーごとの最後の値（現在の状態）。 */
function latestStateMarkers(all: readonly ControlMessage[]): ControlMessage[] {
  const latest = new Map<string, ControlMessage>();
  for (const event of all) {
    if (event.type !== "chat_output" || !event.streamId.startsWith("pc:") ||
      event.streamId.startsWith("pc:history-")) continue;
    latest.delete(event.streamId);
    latest.set(event.streamId, event);
  }
  return [...latest.values()];
}

/** `streamId` と stream 別名（chat_stream_alias）で同一視される streamId の集合。 */
function streamGroup(events: readonly ControlMessage[], streamId: string): Set<string> {
  const group = new Set([streamId]);
  for (const event of events) {
    if (event.type !== "chat_stream_alias") continue;
    const ids = [event.streamId, ...event.aliasStreamIds];
    if (ids.some((id) => group.has(id))) for (const id of ids) group.add(id);
  }
  return group;
}
