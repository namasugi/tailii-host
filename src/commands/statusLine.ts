// statusLine.ts
// tailii-host — ターミナル 1 行ステータス（カウントダウン表示用）。
//
// setup のペアリング待受は「待受中…（残り m:ss）」「ペアリングコード: 123456（残り 0:41）」のように
// 同じ行を毎秒書き換えて残り時間を見せる。stdout が TTY のときだけ `\r` で上書きし、
// 非 TTY（ログ・`| tee`）では開始時と確定時の 2 行だけ出して流れを汚さない。

export interface StatusLineOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

/** ミリ秒を `m:ss` に整形する（負値は 0:00）。 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 表示幅の概算（CJK・全角記号は 2 桁）。上書き時の末尾消去に使うだけなので厳密でなくてよい。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && !(code >= 0xff61 && code <= 0xff9f) ? 2 : 1;
  }
  return width;
}

export class StatusLine {
  private timer: NodeJS.Timeout | null = null;
  private openWidth = 0;
  private started = false;

  constructor(
    private readonly out: StatusLineOutput = process.stdout,
    private readonly intervalMs = 1000,
  ) {}

  /** `render()` の文字列を表示し、TTY では intervalMs ごとに書き換え続ける。 */
  start(render: () => string): void {
    this.stop();
    this.started = true;
    if (this.out.isTTY === true) {
      this.paint(render());
      this.timer = setInterval(() => this.paint(render()), this.intervalMs);
      this.timer.unref?.();
    } else {
      this.out.write(render() + "\n");
    }
  }

  /**
   * 書き換えを止めて行を確定する。`final` を渡すとその文で置き換えて改行する
   * （TTY では同じ行を上書き、非 TTY では新しい行）。start 前・二重呼び出しは何もしない。
   */
  stop(final?: string): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.out.isTTY === true) {
      if (final !== undefined) this.paint(final);
      if (this.openWidth > 0) this.out.write("\n");
      this.openWidth = 0;
    } else if (final !== undefined) {
      this.out.write(final + "\n");
    }
  }

  private paint(text: string): void {
    const width = displayWidth(text);
    const pad = " ".repeat(Math.max(0, this.openWidth - width));
    this.out.write("\r" + text + pad);
    this.openWidth = Math.max(width, this.openWidth);
  }
}
