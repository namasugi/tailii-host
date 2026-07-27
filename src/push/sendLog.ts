// sendLog.ts
// tailii (TS host) — バースト抑制のセッション別レート制限
// Swift 版 SendLog.swift の移植。
//
// `~/.tailii/apns/send-log.json`（`{ "<session>": lastSentEpoch }`）を読み書きする。
// hook プロセスは短命かつ複数起動しうるため、直近送信時刻はファイルで横断共有する（7.2）。
// 読み書き失敗は握り潰し、判定は「送信を許可する側（＝抑制しない）」に倒す（best-effort）。

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultApnsBase, ensureApnsDirectory } from "./pushTypes.js";

/** セッション別の最終送信時刻を永続する（バースト抑制の最小間隔判定, 7.2）。 */
export class SendLog {
  private readonly base: string;

  constructor(base?: string) {
    this.base = base ?? defaultApnsBase();
  }

  private get fileURL(): string {
    return path.join(this.base, "send-log.json");
  }

  /** 当該セッションの最終送信時刻（Unix 秒）を返す。記録が無ければ `null`。 */
  lastSent(session: string): number | null {
    const value = this.load()[session];
    return typeof value === "number" ? value : null;
  }

  /** 当該セッションの最終送信時刻を更新する（送信成功時に呼ぶ）。 */
  record(session: string, at: number): void {
    const map = this.load();
    map[session] = at;
    this.save(map);
  }

  /** send-log.json を読み込む。欠落・不正 JSON なら空辞書。 */
  private load(): Record<string, number> {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.fileURL, "utf8"));
    } catch {
      return {};
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number") result[key] = value;
    }
    return result;
  }

  /** send-log.json を 0600 で保存する（ディレクトリは 0700）。保存失敗は握り潰す。 */
  private save(map: Record<string, number>): void {
    try {
      ensureApnsDirectory(this.base);
      const sorted: Record<string, number> = {};
      for (const key of Object.keys(map).sort()) sorted[key] = map[key]!;
      fs.writeFileSync(this.fileURL, JSON.stringify(sorted), { mode: 0o600 });
      fs.chmodSync(this.fileURL, 0o600);
    } catch {
      // 保存失敗は致命ではない（次回も送信できる）。
    }
  }
}
