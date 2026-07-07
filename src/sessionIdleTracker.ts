// sessionIdleTracker.ts
// tailii (TS host) — tmux アイドル起点の計時（session-list-lifecycle 4.x）
// Swift 版 SessionIdleTracker.swift の移植（Node は単一スレッドのため actor は不要）。

/** セッションのアイドル起点を記録し、timeout 超過集合を返すトラッカー。 */
export class SessionIdleTracker {
  /** name → アイドル起点（Unix 秒）。未設定＝アクティブ/対象外。 */
  private idleSince = new Map<string, number>();

  constructor(private readonly timeout: number) {}

  /** 設定中の timeout（秒）。 */
  get timeoutSeconds(): number {
    return this.timeout;
  }

  /** アイドル起点を設定する（chat 離脱, 要件 4.2）。 */
  markIdle(name: string, at: number): void {
    this.idleSince.set(name, at);
  }

  /** アイドル起点を解除してアクティブ化する（reattach, 要件 4.4）。 */
  markActive(name: string): void {
    this.idleSince.delete(name);
  }

  /** kill 後にエントリを掃除する（二重 kill 回避）。 */
  remove(name: string): void {
    this.idleSince.delete(name);
  }

  /** `now - idleSince >= timeout` を満たす name 集合（name 昇順、未設定は除外, 4.3/4.5）。 */
  expired(now: number): string[] {
    const result: string[] = [];
    for (const [name, since] of this.idleSince) {
      if (now - since >= this.timeout) result.push(name);
    }
    return result.sort();
  }

  /** 現在アイドル起点が設定されている name 集合（テスト/検証補助）。 */
  idleNames(): string[] {
    return [...this.idleSince.keys()].sort();
  }
}
