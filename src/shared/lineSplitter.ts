// lineSplitter.ts
// tailii (TS host) — socket の chunk 列を NDJSON の行に区切る。

/**
 * 受信 chunk を改行で区切り、完結した行を順に渡す。未完の行は断片のまま持ち、改行が届いた
 * ときに 1 回だけ連結する。chunk ごとに未完の行全体を連結し直すと、macOS の Unix socket
 * （受信バッファ 8KB）では数MBの行で二乗のコピーになる（8MiB の 1 行の受信に約 8 秒を実測）。
 */
export class NdjsonLineSplitter {
  private parts: Buffer[] = [];
  private bytes = 0;

  /** chunk を取り込み、完結した行（改行を含まない）ごとに `onLine` を呼ぶ。 */
  push(chunk: Buffer, onLine: (line: Buffer) => void): void {
    let offset = 0;
    let nl = chunk.indexOf(0x0a);
    while (nl >= 0) {
      const suffix = chunk.subarray(offset, nl);
      let line = suffix;
      if (this.bytes > 0) {
        this.parts.push(suffix);
        line = Buffer.concat(this.parts, this.bytes + suffix.length);
        this.parts = [];
        this.bytes = 0;
      }
      offset = nl + 1;
      onLine(line);
      nl = chunk.indexOf(0x0a, offset);
    }
    if (offset < chunk.length) {
      const rest = chunk.subarray(offset);
      this.parts.push(rest);
      this.bytes += rest.length;
    }
  }

  /** 改行待ちの未完の行のバイト数。 */
  get pendingBytes(): number {
    return this.bytes;
  }
}
