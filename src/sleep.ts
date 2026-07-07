// sleep.ts
// tailii (TS host) — abort 対応スリープの小ヘルパ

/** `ms` ミリ秒眠る。`signal` が abort されたら即座に false で解決する（正常満了は true）。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 単純スリープ（abort 不要な短い待ちに使う）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
