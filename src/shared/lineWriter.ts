// lineWriter.ts
// tailii (TS host) — ControlMessage を NDJSON 行で直列に書き出す writer
// Swift 版 Engine.swift の LineWriter に対応（Node の Writable は書込順序を保証するためロック不要）。

import type { Writable } from "node:stream";
import { encodeControlMessage, type ControlMessage } from "../protocol.js";

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

  /**
   * message を書き込み、出力バッファが高水位を超えていたら drain まで待つ。
   * ファイル原本の分割配信（file-download）のように多量の行を続けて書く送出元が、
   * 回線より速く書いてメモリに全チャンクを積み上げないための背圧付き write。
   * 待機中にストリームが閉じたら（close/error）解放され、次の書込で例外になる。
   */
  async writeWithBackpressure(message: ControlMessage): Promise<void> {
    if (this.out.destroyed || !this.out.writable) {
      throw new Error("LineWriter: output stream is closed");
    }
    const ok = this.out.write(encodeControlMessage(message) + "\n");
    if (ok) return;
    const out = this.out;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        out.off("drain", done);
        out.off("close", done);
        out.off("error", done);
        resolve();
      };
      out.once("drain", done);
      out.once("close", done);
      out.once("error", done);
    });
  }
}
