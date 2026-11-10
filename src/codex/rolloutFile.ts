// rolloutFile.ts
// tailii (TS host) — Codex の rollout ファイル（平文 `.jsonl` / zstd 圧縮 `.jsonl.zst`）の読み取り
//
// Codex 0.167 以降は、しばらく触られていない会話の rollout を `rollout-*.jsonl.zst` に圧縮して
// 元の `.jsonl` を消す（更新時刻は元のまま）。会話を再開すると App Server が平文の `.jsonl` に
// 戻す（2026-11-11 実測）。一覧・本文検索は圧縮されたままの会話も読む必要がある。

import * as fs from "node:fs";
import * as zlib from "node:zlib";

const PLAIN_SUFFIX = ".jsonl";
const COMPRESSED_SUFFIX = ".jsonl.zst";
/** 先頭読みで最初に読む圧縮データの量（足りなければ倍々に広げる）。 */
const HEAD_FIRST_COMPRESSED_BYTES = 64 * 1024;

/**
 * この Node で zstd を解凍できるか（Node 22.15 / 23.8 以降）。対応版の下限は Node 20 なので、
 * 使えない環境では圧縮ファイルを列挙しない（読めずに「発話なし」等の結果をメモへ残さない）。
 */
const ZSTD_AVAILABLE = typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";

/** 読める rollout ファイル名か（平文、および zstd を解凍できる環境なら圧縮も）。 */
export function isRolloutFileName(name: string): boolean {
  if (!name.startsWith("rollout-")) return false;
  return name.endsWith(PLAIN_SUFFIX) || (ZSTD_AVAILABLE && name.endsWith(COMPRESSED_SUFFIX));
}

/** zstd 圧縮された rollout か。 */
export function isCompressedRollout(filePath: string): boolean {
  return filePath.endsWith(COMPRESSED_SUFFIX);
}

/**
 * rollout の先頭 `limit` バイト（解凍後）を読む。ファイルが短ければその全体。
 * 圧縮ファイルは先頭の圧縮データだけを少しずつ広げて解凍し、`enough` が真を返した時点で止める
 * （巨大な会話でも全体は解凍しない）。平文は `enough` を見ずに `limit` まで読む。I/O の失敗は投げる。
 */
export function readRolloutHead(
  filePath: string,
  limit: number,
  enough: (head: Buffer) => boolean = () => false,
): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    if (!isCompressedRollout(filePath)) {
      const buf = Buffer.alloc(limit);
      const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, bytesRead);
    }
    const size = fs.fstatSync(fd).size;
    // 1 回の解凍で作る量の上限（圧縮が極端に効くデータで先頭の少量から巨大な出力が出ても止める）。
    const outputCap = Math.max(limit * 8, 1024 * 1024);
    let decodedSpan = 0;
    let decoded: Buffer = Buffer.alloc(0);
    let span = Math.min(size, HEAD_FIRST_COMPRESSED_BYTES);
    for (;;) {
      const compressed = Buffer.alloc(span);
      const bytesRead = fs.readSync(fd, compressed, 0, span, 0);
      const complete = bytesRead >= size;
      let out: Buffer;
      try {
        out = zlib.zstdDecompressSync(compressed.subarray(0, bytesRead), { maxOutputLength: outputCap });
      } catch (error) {
        if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
          // 広げ過ぎた: 前回解けた量との中間まで戻す。同じ文字の連続は数バイトで 128KB に解けるので、
          // 1 バイト単位まで詰める（数バイトでは出力上限 1MB 以上に届かないので、必ずどこかで解ける）。
          if (span - decodedSpan <= 1) return decoded.subarray(0, limit);
          span = decodedSpan + Math.floor((span - decodedSpan) / 2);
          continue;
        }
        // 途中までの圧縮データで解けない形なら、もっと読んでやり直す。全体でも解けなければ壊れている。
        if (complete) throw error;
        span = Math.min(size, span * 2);
        continue;
      }
      if (out.length >= limit || complete || enough(out)) return out.subarray(0, limit);
      decodedSpan = span;
      decoded = out;
      span = Math.min(size, span * 2);
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // close の失敗は読み取り結果に影響しない。
    }
  }
}

/**
 * 圧縮 rollout の全体を解凍して返す。解凍後が `maxBytes` を超えるなら null（巨大な会話で
 * engine のメモリを食い潰さない）。I/O・解凍の失敗は投げる。
 */
export function readCompressedRollout(filePath: string, maxBytes: number): Buffer | null {
  // 解凍後は圧縮データより小さくならないので、圧縮の時点で上限を超えるなら読まずに諦める
  // （数百 MB の圧縮ファイルを丸ごとメモリに載せない）。
  if (fs.statSync(filePath).size > maxBytes) return null;
  const compressed = fs.readFileSync(filePath);
  try {
    return zlib.zstdDecompressSync(compressed, { maxOutputLength: maxBytes });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") return null;
    throw error;
  }
}

/** 圧縮 rollout を解凍しながら先頭から読むストリーム。読み終わり・破棄で元のファイルも閉じる。 */
export function createCompressedRolloutReadStream(filePath: string, signal?: AbortSignal): zlib.ZstdDecompress {
  const input = fs.createReadStream(filePath, signal !== undefined ? { signal } : {});
  const output = zlib.createZstdDecompress();
  input.on("error", (error) => output.destroy(error));
  output.on("close", () => input.destroy());
  input.pipe(output);
  return output;
}
