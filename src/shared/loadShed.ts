// loadShed.ts
// tailii (TS host) — ホストが混んでいるとき、定期作業が自分でさらに混ませないための小さな仕組み。
//
// hub は 1 本のイベントループで、画面の取得（capture-pane / herdr の読み出し）や生存確認（ps / pgrep / lsof）の
// たびに子プロセスを起こす。混雑時は 1 回が数百 ms〜数秒に伸びるのに同じ頻度で走り続けると、自分も遅くなり、
// ホストをさらに混ませる。ここでは 2 つの決まりを共通の部品にする:
//   1. 占有率: 定期作業は「前回かかった時間の 3 倍以上は休む」（占有率 1/4 以下）。混んでいないとき
//      （所要時間が基本間隔の 1/3 以下）は基本間隔のまま変わらない。
//   2. 同時実行: 子プロセスを起こす作業は、会話の数だけ同時に走らせず、全体で上限を設ける。順番待ちは
//      溜め込まない（同じ key の待ちは最新の 1 件だけ）。前面の会話を先に通す。

import { execFile, type ExecFileException } from "node:child_process";

/** 定期作業の休みの倍率（上限に達するまでは占有率 1/(1+3) = 1/4 以下）。 */
export const REST_FACTOR = 3;
/** 背景は 2 秒待ったら次の空き枠で先に通し、30 秒待ったら生存不明として見送る。 */
export const BACKGROUND_FAIR_WAIT_MS = 2_000;
export const BACKGROUND_WAIT_TIMEOUT_MS = 30_000;

/**
 * 作業の後に眠る時間（ms）。「作業 → 眠る」を繰り返すループ用。
 * `max(基本間隔, 3 × 直近の所要時間)` を上限 `maxRestMs` で止める（上限が基本間隔より短ければ基本間隔）。
 */
export function restAfterWorkMs(baseMs: number, workMs: number, maxRestMs: number): number {
  const base = Math.max(0, baseMs);
  const wanted = Math.max(base, REST_FACTOR * Math.max(0, workMs));
  return Math.min(wanted, Math.max(base, maxRestMs));
}

/**
 * 次に始めてよい時刻（ms）。tail の中で別周期のプローブだけ間引くときに使う。
 * 完了後から `max(基本間隔, 3 × 所要時間)` を休み、本文の tail 自体は遅くしない。
 */
export function nextStartAtMs(startedAtMs: number, finishedAtMs: number, baseMs: number, maxRestMs: number): number {
  const workMs = Math.max(0, finishedAtMs - startedAtMs);
  return finishedAtMs + restAfterWorkMs(baseMs, workMs, maxRestMs);
}

/** 通常は前面の会話を先に通す（長く待った背景には実行機会を譲る）。 */
export type LoadShedPriority = "foreground" | "background";
type PrioritySource = LoadShedPriority | (() => LoadShedPriority);

/**
 * 順番待ちのまま実行されなかった要求（新しい要求による置換・取消・背景の待機期限切れ）。
 * 作業そのものの失敗ではないので、呼び出し側は失敗として数えない。
 */
export class LoadShedSkippedError extends Error {
  constructor(public readonly reason: "superseded" | "aborted" | "timeout") {
    super(`load shed: request ${reason}`);
    this.name = "LoadShedSkippedError";
  }
}

interface WaitingEntry {
  priority: PrioritySource;
  queuedAtMs: number;
  start: () => Promise<void>;
  skip: (reason: "superseded" | "aborted" | "timeout") => void;
}

/**
 * 同時に走らせる数の上限つきの実行口。
 *   - 同時に走るのは `maxConcurrent` 件まで。
 *   - 同じ key の作業は重ねない（走っている間、同じ key の次の要求は待つ）。
 *   - 順番待ちは key ごとに 1 件だけ。待っている間に同じ key の新しい要求が来たら、古い方は
 *     {@link LoadShedSkippedError} で捨て、新しい方がその順番を引き継ぐ（溜め込まない）。
 *   - 通常は前面が先。背景が 2 秒待ったら次の空き枠で優先し、30 秒で待ちを見送る。
 *   - 背景は同時 1 件まで。全体上限が 2 以上なら前面用の枠を残す。
 *   - `signal` が abort されたら、待っている要求は捨てる（走り始めた作業は止めない）。
 * `task` の中から同じ実行口を呼ばないこと（枠を持ったまま待つと詰まる）。
 */
export class KeyedLimiter {
  private readonly maxConcurrent: number;
  private readonly runningKeys = new Set<string>();
  private runningBackground = 0;
  /** 挿入順 = 来た順（置き換えは順番を引き継ぐ）。 */
  private readonly waitingByKey = new Map<string, WaitingEntry>();

  constructor(options: { maxConcurrent: number }) {
    if (!Number.isFinite(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive finite number");
    }
    this.maxConcurrent = Math.floor(options.maxConcurrent);
  }

  /** いま走っている件数。 */
  get running(): number { return this.runningKeys.size; }
  /** 順番待ちの件数。 */
  get waiting(): number { return this.waitingByKey.size; }

  /** 待っている会話が前面になったら、空けていた枠へ直ちに進める。 */
  prioritiesChanged(): void { this.drain(); }

  run<T>(key: string, priority: PrioritySource, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new LoadShedSkippedError("aborted"));
        return;
      }
      const queuedAtMs = this.waitingByKey.get(key)?.queuedAtMs ?? Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (this.waitingByKey.get(key) !== entry) return;
        this.waitingByKey.delete(key);
        entry.skip("aborted");
        this.drain();
      };
      const entry: WaitingEntry = {
        priority,
        queuedAtMs,
        skip: (reason) => {
          cleanup();
          reject(new LoadShedSkippedError(reason));
        },
        start: async () => {
          cleanup();
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // 同じ key の待ちは最新の 1 件だけ（Map の set は既存 key の順番を保つ）。
      this.waitingByKey.get(key)?.skip("superseded");
      this.waitingByKey.set(key, entry);
      this.drain();
      const checkWait = (): void => {
        this.drain();
        if (this.waitingByKey.get(key) !== entry) return;
        // 期限時点で前面でも、後から背景へ変わった待ちを放置しない。
        timer = setTimeout(checkWait, Math.max(BACKGROUND_FAIR_WAIT_MS, queuedAtMs + BACKGROUND_WAIT_TIMEOUT_MS - Date.now()));
        timer.unref();
      };
      if (this.waitingByKey.get(key) === entry) {
        timer = setTimeout(checkWait, Math.max(0, queuedAtMs + BACKGROUND_WAIT_TIMEOUT_MS - Date.now()));
        timer.unref();
      }
    });
  }

  private drain(): void {
    for (const [key, entry] of this.waitingByKey) {
      const priority = typeof entry.priority === "function" ? entry.priority() : entry.priority;
      if (priority === "background" && Date.now() - entry.queuedAtMs >= BACKGROUND_WAIT_TIMEOUT_MS) {
        this.waitingByKey.delete(key);
        entry.skip("timeout");
      }
    }
    while (this.runningKeys.size < this.maxConcurrent) {
      const key = this.nextKey();
      if (key === null) return;
      const entry = this.waitingByKey.get(key)!;
      const background = (typeof entry.priority === "function" ? entry.priority() : entry.priority) === "background";
      this.waitingByKey.delete(key);
      this.runningKeys.add(key);
      if (background) this.runningBackground++;
      void entry.start().finally(() => {
        this.runningKeys.delete(key);
        if (background) this.runningBackground--;
        this.drain();
      });
    }
  }

  /** 同じ key が走っていない待ちを選ぶ。通常は前面が先、2 秒待った背景は例外。 */
  private nextKey(): string | null {
    let foreground: string | null = null;
    let background: string | null = null;
    for (const [key, entry] of this.waitingByKey) {
      if (this.runningKeys.has(key)) continue;
      const priority = typeof entry.priority === "function" ? entry.priority() : entry.priority;
      if (priority === "foreground") { foreground ??= key; continue; }
      // 背景は同時 1 件まで。共有の残りの枠は前面の取得に使えるよう空けておく。
      if (this.runningBackground === 0) background ??= key;
    }
    if (background !== null && Date.now() - this.waitingByKey.get(background)!.queuedAtMs >= BACKGROUND_FAIR_WAIT_MS) {
      return background;
    }
    return foreground ?? background;
  }
}

/**
 * 定期的な画面取得・生存確認の実行口（プロセス全体で共有）。ユーザー操作の注入・検証や
 * heartbeat をここで待たせない。task の中でこの実行口を再び使ってはならない。
 */
export const periodicWorkLimiter = new KeyedLimiter({ maxConcurrent: 2 });

/**
 * 生存確認用の `execFile`。順番を待ってから起動する（`timeout` は起動してから数える）。
 * 同じコマンドの待ちは最新だけ残す。見送った古い呼び出しはエラー（生存不明）として返す。
 * 背景の枠待ちは 30 秒まで。signal は枠待ちの取消に使い、開始済みの子は元の timeout で終える。
 * 呼び出しの形は `child_process.execFile` と同じ（stdout / stderr は文字列）。
 */
export function probeExecFile(
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; signal?: AbortSignal },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): void {
  const { signal, ...execOptions } = options;
  void periodicWorkLimiter.run(`probe:${JSON.stringify([file, args])}`, "background", () => new Promise<{
    error: ExecFileException | null; stdout: string; stderr: string;
  }>((done) => {
    try {
      execFile(file, args, execOptions, (error, stdout, stderr) => {
        done({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch (error) {
      // 起動そのものが同期で失敗した（引数の不正など）。枠を返して、失敗として伝える。
      done({ error: error as ExecFileException, stdout: "", stderr: "" });
    }
  }), signal).then(
    ({ error, stdout, stderr }) => callback(error, stdout, stderr),
    (error: ExecFileException) => callback(error, "", ""),
  );
}
