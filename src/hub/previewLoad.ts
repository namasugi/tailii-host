// previewLoad.ts — イベントループが遅れている間だけ一覧向けの画面取得を間引く。

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

interface DelayHistogram {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  percentile(percentile: number): number;
}

export class PreviewLoadMonitor {
  private histogram: DelayHistogram | null = null;
  private sampledAt = 0;
  private congested = false;
  private closed = false;
  private readonly now: () => number;
  private readonly createHistogram: () => DelayHistogram;

  constructor(private readonly options: {
    log?: (message: string) => void;
    now?: () => number;
    createHistogram?: () => DelayHistogram;
  } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.createHistogram = options.createHistogram ?? (() => monitorEventLoopDelay({ resolution: 20 }));
  }

  /** 一覧向けからだけ呼ぶ。採取は遅延開始し、追加の JS 巡回タイマーは持たない。 */
  intervalMs(baseMs: number): number {
    if (this.closed) return baseMs;
    const now = this.now();
    if (this.histogram === null) {
      this.histogram = this.createHistogram();
      this.histogram.enable();
      this.sampledAt = now;
    } else if (now - this.sampledAt >= 5_000) {
      const p95Ms = this.histogram.percentile(95) / 1_000_000;
      this.histogram.reset();
      this.sampledAt = now;
      // 100ms で混雑へ、50ms 未満で通常へ戻す。境界付近でログと頻度が往復しない。
      const congested = Number.isFinite(p95Ms) && (this.congested ? p95Ms >= 50 : p95Ms >= 100);
      if (congested !== this.congested) {
        this.congested = congested;
        this.options.log?.(`audit preview-load-shed state=${congested ? "congested" : "normal"} p95Ms=${Math.round(p95Ms)}`);
      }
    }
    return this.congested ? Math.max(baseMs, 3_000) : baseMs;
  }

  close(): void {
    this.closed = true;
    this.histogram?.disable();
    this.histogram = null;
  }
}
