// startupImageWriter.ts — pending 画像だけを先に配り、要求の応答はその完了を待たせない。
import type { Writable } from "node:stream";
import { encodeControlMessage, type ControlMessage } from "../protocol.js";
import { LineWriter } from "../shared/lineWriter.js";

export class StartupImageWriter extends LineWriter {
  private queued: ControlMessage[] | null;

  constructor(private readonly output: Writable, pending: boolean) {
    super(output);
    this.queued = pending ? [] : null;
  }

  /** 入力 EOF と出力切断を区別する。書き込み完了を確認できた画像だけ pending から消す。 */
  writePending(message: ControlMessage): Promise<boolean> {
    const out = this.output;
    if (out.destroyed || !out.writable) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (ok: boolean): void => {
        out.off("close", closed);
        out.off("error", closed);
        resolve(ok);
      };
      const closed = (): void => finish(false);
      out.once("close", closed);
      out.once("error", closed);
      try {
        out.write(encodeControlMessage(message) + "\n", (error) => {
          // 失敗時は直後の error / close で確定する（error の未処理も防ぐ）。
          if (!error) finish(true);
        });
      } catch { finish(false); }
    });
  }

  override write(message: ControlMessage): void {
    if (this.queued !== null && message.type === "image_available") {
      this.queued.push(message);
    } else {
      super.write(message);
    }
  }

  /** pending 内の順序と、その後に届いた画像同士の順序を保つ。ID の扱いは変えない。 */
  finishPending(messages: ControlMessage[]): void {
    const queued = this.queued ?? [];
    this.queued = null;
    for (const message of messages) super.write(message);
    for (const message of queued) super.write(message);
  }
}
