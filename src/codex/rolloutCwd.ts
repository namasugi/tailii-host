// rolloutCwd.ts
// tailii (TS host) — Codex の会話の作業フォルダを rollout から読む（session-workdir-change）
//
// rollout 先頭の `session_meta.cwd` は会話を始めたフォルダのまま変わらない（App Server の `thread/list` の cwd と
// 絞り込みも同じ値）。途中で変えた作業フォルダは次の行に残る（Codex 0.167.2 実測, 2026-11-15）:
//   - `event_msg` / `thread_settings_applied`（payload.thread_settings.cwd）: 設定が変わった時点で書かれる（待機中・
//     ターン中の変更、cwd 付きの resume、設定の変わる turn/start）。cwd を付けない resume でも、会話を読み込み直すときは
//     今の値で 1 行書かれる
//   - `turn_context`（payload.cwd）: ターンの始まり（`event_msg` / `task_started` の後）。そのターンが動くフォルダ
// 今の値は「最後の thread_settings_applied → 無ければ最後のターンの turn_context → 無ければ session_meta」。ターンの
// 途中で変えた（thread_settings_applied の後に同じターンの turn_context が続く）場合も、効くのは次のターンからなので
// thread_settings_applied を採る。最後のターンの始まり（task_started）より前の thread_settings_applied は、そのターンの
// turn_context の方が新しい。
//
// 大きい rollout（数百 MB になる）を毎回頭から読まないよう、今の値は末尾から上限付きで遡って探す。上限より前にしか
// 記録が無い会話（最後のターンの出力が大きい）は session_meta の値として扱う。それでも実害は小さい: Tailii が会話を
// 開くと App Server の resume 応答の cwd が記録を正し（hub）、会話を読み込み直す resume では thread_settings_applied
// が末尾へ書かれる（実測）ので、次の一覧からは今の値が出る。

import * as fs from "node:fs";

/**
 * 末尾から遡って作業フォルダの記録を探す上限。実物の平文 rollout 409 本（計 5.2GB, 2026-11-15）を初回に全部読む時間は
 * 2MB で約 0.8 秒・8MB で約 2.6 秒（記録が見つかる会話は 130 本と 244 本）。一覧の初回（メモの無い engine）を
 * 遅くしないよう 2MB にする。
 */
export const ROLLOUT_CWD_SCAN_CAP_BYTES = 2 * 1024 * 1024;
/** 1 回に読む量。 */
const SCAN_CHUNK_BYTES = 256 * 1024;
/** これより長い行は作業フォルダの記録ではない（大きな出力の行）。JSON を解かずに飛ばす。 */
const MAX_RECORD_LINE_BYTES = 1024 * 1024;

/** 作業フォルダに関わる rollout の 1 行。 */
export type RolloutCwdRecord =
  | { kind: "settings"; cwd: string }
  | { kind: "turn"; cwd: string }
  | { kind: "turn_start" };

/** 行が作業フォルダに関わる記録なら返す（`thread_settings_applied` / `turn_context` / `task_started`）。 */
export function rolloutCwdRecord(line: Buffer | string): RolloutCwdRecord | null {
  const text = typeof line === "string" ? line : line.toString("utf8");
  // 安い前判定（大半の行はどれも含まない）。
  const settings = text.includes("thread_settings_applied");
  const turn = text.includes("turn_context");
  const turnStart = text.includes("task_started");
  if (!settings && !turn && !turnStart) return null;
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (record["type"] === "turn_context") {
    return typeof p["cwd"] === "string" && p["cwd"].length > 0 ? { kind: "turn", cwd: p["cwd"] } : null;
  }
  if (record["type"] !== "event_msg") return null;
  if (p["type"] === "task_started") return { kind: "turn_start" };
  if (p["type"] !== "thread_settings_applied") return null;
  const threadSettings = p["thread_settings"];
  const cwd = typeof threadSettings === "object" && threadSettings !== null
    ? (threadSettings as Record<string, unknown>)["cwd"] : undefined;
  return typeof cwd === "string" && cwd.length > 0 ? { kind: "settings", cwd } : null;
}

/** 末尾から遡った結果。 */
export interface RolloutCwdScan {
  /** 今の作業フォルダ（範囲内に記録が無ければ null = session_meta の値）。 */
  cwd: string | null;
  /**
   * 範囲内だけで決まったか（thread_settings_applied、または turn_context とそのターンの始まりを見た）。false で
   * cwd がある = turn_context は見たがターンの始まりまで遡れなかった（範囲の手前に thread_settings_applied があり得る）。
   */
  decisive: boolean;
}

/** 遡りの判定（行を新しい順に渡す）。決まったら結果、まだなら null。 */
class BackwardCwdJudge {
  private turnCwd: string | null = null;

  visit(record: RolloutCwdRecord): RolloutCwdScan | null {
    if (record.kind === "settings") return { cwd: record.cwd, decisive: true };
    if (record.kind === "turn") {
      this.turnCwd ??= record.cwd;
      return null;
    }
    return this.turnCwd !== null ? { cwd: this.turnCwd, decisive: true } : null;
  }

  finish(reachedStart: boolean): RolloutCwdScan {
    // 範囲の先頭が会話の先頭なら、turn_context だけでも決まる（その前に記録は無い）。
    return { cwd: this.turnCwd, decisive: reachedStart && this.turnCwd !== null };
  }
}

/**
 * rollout（平文）の `[start, end)` を末尾から遡り、今の作業フォルダを探す。`start` は行の先頭であること
 * （0 か、前に読んだときの末尾の改行の直後）。上限（既定 2MB、ROLLOUT_CWD_SCAN_CAP_BYTES）を超えて遡らない。読めなければ例外。
 */
export function scanRolloutCwdBackward(
  file: string,
  options: { start?: number; end?: number; capBytes?: number } = {},
): RolloutCwdScan {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const end = Math.min(options.end ?? size, size);
    const start = Math.max(0, Math.min(options.start ?? 0, end));
    const floor = Math.max(start, end - (options.capBytes ?? ROLLOUT_CWD_SCAN_CAP_BYTES));
    return scanBackward(
      end, floor, start,
      (position, length) => {
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, position);
        return buf.subarray(0, read);
      },
    );
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 閉じられなくても結果は使える。
    }
  }
}

/** 解凍済みの rollout 全体（圧縮ファイル）から今の作業フォルダを探す。 */
export function scanRolloutCwdInBuffer(content: Buffer, capBytes = ROLLOUT_CWD_SCAN_CAP_BYTES): RolloutCwdScan {
  const end = content.length;
  return scanBackward(end, Math.max(0, end - capBytes), 0,
    (position, length) => content.subarray(position, position + length));
}

/** 記録の種類の印（JSON の値として現れる綴り。本文中の同じ語はエスケープされた引用符になるので当たらない）。 */
const RECORD_MARKERS = ["\"turn_context\"", "\"thread_settings_applied\"", "\"task_started\""].map((text) => Buffer.from(text));
/** 印が 2 つの読み取りにまたがっても見落とさないための重なり。 */
const MARKER_OVERLAP_BYTES = 64;
/** 行の先頭を探すために印の前を読む量（種類は行の先頭近くに書かれる）。 */
const LINE_HEAD_WINDOW_BYTES = 64 * 1024;

/**
 * `[floor, end)` を末尾から遡り、作業フォルダに関わる記録を新しい順に判定する。行を 1 つずつ分けず、記録の種類の印を
 * まとめて探し（Buffer.lastIndexOf）、見つかった行だけを読み出して解く（数百 MB の会話でも大半の行は触らない）。
 * `start` は会話の先頭として扱う位置。`end` で改行が終わっていない末尾の行（書き込み途中）は読まない。
 */
function scanBackward(
  end: number,
  floor: number,
  start: number,
  read: (position: number, length: number) => Buffer,
): RolloutCwdScan {
  const judge = new BackwardCwdJudge();
  // 判定済みの行の先頭（同じ行に印が複数あっても 1 回だけ読む）。
  let visitedLineStart = Number.POSITIVE_INFINITY;
  let position = end;
  while (position > floor) {
    const length = Math.min(SCAN_CHUNK_BYTES, position - floor);
    position -= length;
    const chunk = read(position, Math.min(length + MARKER_OVERLAP_BYTES, end - position));
    const hits: number[] = [];
    for (const marker of RECORD_MARKERS) {
      for (let i = chunk.lastIndexOf(marker); i >= 0; i = i > 0 ? chunk.lastIndexOf(marker, i - 1) : -1) {
        if (i < length) hits.push(position + i);
      }
    }
    hits.sort((a, b) => b - a);
    for (const hit of hits) {
      if (hit >= visitedLineStart) continue;
      const line = readLineAround(hit, Math.max(0, Math.min(start, hit)), end, read);
      if (line === null) continue;
      visitedLineStart = line.start;
      const record = rolloutCwdRecord(line.text);
      const result = record === null ? null : judge.visit(record);
      if (result !== null) return result;
    }
  }
  return judge.finish(floor <= start);
}

/**
 * `at` を含む 1 行（`[lineStart, lineEnd)`、改行を除く）を読む。行の先頭は `lowest` より前へ探さない。改行で終わって
 * いない（`end` まで続く）行・長すぎる行は null。
 */
function readLineAround(
  at: number,
  lowest: number,
  end: number,
  read: (position: number, length: number) => Buffer,
): { start: number; text: Buffer } | null {
  const headFrom = Math.max(lowest, at - LINE_HEAD_WINDOW_BYTES);
  const head = read(headFrom, at - headFrom);
  const nl = head.lastIndexOf(0x0a);
  if (nl < 0 && headFrom > lowest) return null;
  const lineStart = nl < 0 ? headFrom : headFrom + nl + 1;
  const parts: Buffer[] = [head.subarray(nl + 1)];
  let length = parts[0]!.length;
  let cursor = at;
  while (cursor < end && length <= MAX_RECORD_LINE_BYTES) {
    const piece = read(cursor, Math.min(SCAN_CHUNK_BYTES, end - cursor));
    if (piece.length === 0) return null;
    const lineEnd = piece.indexOf(0x0a);
    if (lineEnd >= 0) {
      parts.push(piece.subarray(0, lineEnd));
      length += lineEnd;
      return length > MAX_RECORD_LINE_BYTES ? null : { start: lineStart, text: Buffer.concat(parts, length) };
    }
    parts.push(piece);
    length += piece.length;
    cursor += piece.length;
  }
  return null;
}

/** 平文 rollout の末尾の改行の直後の位置（追記の続きを読む起点）。改行が無ければ 0。 */
export function lastLineBoundary(file: string, size: number): number {
  const fd = fs.openSync(file, "r");
  try {
    let position = size;
    while (position > 0) {
      const length = Math.min(SCAN_CHUNK_BYTES, position);
      position -= length;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, position);
      const nl = buf.subarray(0, read).lastIndexOf(0x0a);
      if (nl >= 0) return position + nl + 1;
      // 1 行が長い（大きな出力）: 境界は上限まで遡れば十分（その先は追記の再読で拾い直す）。
      if (size - position >= ROLLOUT_CWD_SCAN_CAP_BYTES) return position;
    }
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 無視。
    }
  }
}

/** rollout の作業フォルダの履歴（照合用, session-workdir-change）の読み取りメモ。 */
interface CwdHistoryMemo {
  /** 読み終えた位置（行の先頭）。 */
  offset: number;
  size: number;
  mtimeMs: number;
  cwds: Set<string>;
}

const HISTORY_MEMO_LIMIT = 32;
const historyMemo = new Map<string, CwdHistoryMemo>();

/**
 * rollout（平文）にこれまで記録された作業フォルダ（thread_settings_applied / turn_context の cwd）の集合。会話の
 * 記録（metadata）の作業フォルダが、この会話のものか（別の会話のコピーではないか）を確かめるのに使う。頭から読むが、
 * 結果はファイルごとに覚え、伸びた分だけ読み足す（数百 MB の会話でも 2 回目からは追記分だけ）。読めなければ例外。
 */
export function rolloutCwdHistory(file: string): ReadonlySet<string> {
  const stat = fs.statSync(file);
  let memo = historyMemo.get(file);
  if (memo === undefined || stat.size < memo.size || (stat.size === memo.size && stat.mtimeMs !== memo.mtimeMs)) {
    memo = { offset: 0, size: 0, mtimeMs: 0, cwds: new Set() };
  }
  if (stat.size > memo.offset) {
    const fd = fs.openSync(file, "r");
    try {
      let position = memo.offset;
      let pending: Buffer[] = [];
      let pendingLength = 0;
      while (position < stat.size) {
        const length = Math.min(SCAN_CHUNK_BYTES, stat.size - position);
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, position);
        if (read === 0) break;
        const chunk = buf.subarray(0, read);
        let lineStart = 0;
        for (let nl = chunk.indexOf(0x0a); nl >= 0; nl = chunk.indexOf(0x0a, lineStart)) {
          const tail = chunk.subarray(lineStart, nl);
          const lineLength = pendingLength + tail.length;
          if (lineLength <= MAX_RECORD_LINE_BYTES) {
            const record = rolloutCwdRecord(pendingLength === 0 ? tail : Buffer.concat([...pending, tail], lineLength));
            if (record !== null && record.kind !== "turn_start") memo.cwds.add(record.cwd);
          }
          pending = [];
          pendingLength = 0;
          lineStart = nl + 1;
          memo.offset = position + nl + 1;
        }
        const rest = chunk.subarray(lineStart);
        pendingLength += rest.length;
        pending = pendingLength > MAX_RECORD_LINE_BYTES ? [] : [...pending, rest];
        position += read;
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // 無視。
      }
    }
  }
  memo.size = stat.size;
  memo.mtimeMs = stat.mtimeMs;
  historyMemo.delete(file);
  historyMemo.set(file, memo);
  while (historyMemo.size > HISTORY_MEMO_LIMIT) {
    const oldest = historyMemo.keys().next().value;
    if (oldest === undefined) break;
    historyMemo.delete(oldest);
  }
  return memo.cwds;
}

/** 解凍済みの rollout 全体（圧縮ファイル）に記録された作業フォルダの集合。 */
export function rolloutCwdHistoryInBuffer(content: Buffer): ReadonlySet<string> {
  const cwds = new Set<string>();
  let lineStart = 0;
  while (lineStart < content.length) {
    let nl = content.indexOf(0x0a, lineStart);
    if (nl < 0) nl = content.length;
    if (nl - lineStart <= MAX_RECORD_LINE_BYTES) {
      const record = rolloutCwdRecord(content.subarray(lineStart, nl));
      if (record !== null && record.kind !== "turn_start") cwds.add(record.cwd);
    }
    lineStart = nl + 1;
  }
  return cwds;
}
