// idleReaper.ts
// tailii (TS host) — アイドル timeout kill の常駐ループ（session-list-lifecycle 4.3/4.5）
// Swift 版 IdleReaper.swift の移植。engine 起動時に開始し、チャネル断（abort）で停止する。

import type { SessionIdleTracker } from "./sessionIdleTracker.js";
import type { TmuxSessionManager } from "./tmux.js";
import { abortableSleep } from "./sleep.js";

/**
 * 期限切れセッションを一定間隔で kill する常駐ループ。`signal` の abort まで回り続ける。
 * kill 失敗（既に不在等）はログのみで継続し、成否に関わらず tracker から掃除する（二重 kill 回避）。
 */
export async function runIdleReaper(options: {
  tracker: SessionIdleTracker;
  sessionManager: TmuxSessionManager;
  checkIntervalSeconds: number;
  signal: AbortSignal;
  now?: () => number;
}): Promise<void> {
  const { tracker, sessionManager, signal } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const intervalMs = Math.max(0.01, options.checkIntervalSeconds) * 1000;

  while (!signal.aborted) {
    const expired = tracker.expired(now());
    for (const name of expired) {
      try {
        await sessionManager.kill(name);
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] idle reaper kill 失敗（掃除して継続）: ${name}: ${String(error)}\n`,
        );
      }
      // 成否に関わらず掃除して二重 kill を避ける（メタデータ = cwd 権威記録は不変, 要件 4.7）。
      tracker.remove(name);
    }
    const slept = await abortableSleep(intervalMs, signal);
    if (!slept) break; // abort
  }
}
