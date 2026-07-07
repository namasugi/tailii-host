// lineWriter.ts
// tailii (TS host) — ControlMessage を NDJSON 行で直列に書き出す writer
// Swift 版 Engine.swift の LineWriter に対応（Node の Writable は書込順序を保証するためロック不要）。

import type { Writable } from "node:stream";
import { encodeControlMessage, type ControlMessage } from "./protocol.js";

/** 出力ストリームへ `ControlMessage` を NDJSON 行（末尾改行付き）で書き出す。 */
export class LineWriter {
  constructor(private readonly out: Writable) {}

  /** message をエンコードし、末尾改行を付けて書き込む。ストリーム破棄済みは例外。 */
  write(message: ControlMessage): void {
    if (this.out.destroyed || !this.out.writable) {
      throw new Error("LineWriter: output stream is closed");
    }
    this.out.write(encodeControlMessage(message) + "\n");
  }
}
