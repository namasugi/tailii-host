// pushStateFiles.ts
// tailii (TS host) — push の間引き記録と「最後の送信結果」
//
// - `~/.tailii/push/send-log.json`: `{ "<kind>:<session>": 最終送信 epoch 秒 }`。**読み書きするのは hub だけ**
//   （hook の自前送信は間引きを使わない）。hub の再起動をまたいで間引きを保つためにファイルにも置く。
//   旧形式（`{sent: {...}, sending: {...}}`）の `sent` も読む。
// - `~/.tailii/push/last-result.json`: `tailii doctor` に出す最後の送信結果（種別・結果・経路・時刻）。
//
// 読み書きの失敗は握り潰し、送信を止める側には倒さない（best-effort）。秘密は書かない。

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPushBase, ensurePrivateDirectory, writePrivateFileAtomic } from "./pushDeviceStore.js";
import { PUSH_KINDS, type PushKind } from "./pushEnvelope.js";

/** 間引きの記録が溜まり続けないよう、これより古い記録は保存時に捨てる（秒）。 */
const SEND_LOG_RETENTION_SECONDS = 24 * 60 * 60;

/** 種別 × 会話の最終送信時刻（hub がメモリに持ち、書き込みのたびにファイルへも保存する）。 */
export class PushSendLog {
  private readonly file: string;
  private readonly base: string;
  private map: Record<string, number> | null = null;

  constructor(base: string = defaultPushBase()) {
    this.base = base;
    this.file = path.join(base, "send-log.json");
  }

  lastSent(kind: PushKind, session: string): number | null {
    const value = this.loaded()[`${kind}:${session}`];
    return typeof value === "number" ? value : null;
  }

  /** 送信済みとして記録する。時刻は後退させない（遅れて終わった送信が新しい記録を巻き戻さない）。 */
  record(kind: PushKind, session: string, at: number): void {
    const map = this.loaded();
    const key = `${kind}:${session}`;
    map[key] = Math.max(map[key] ?? 0, at);
    const kept: Record<string, number> = {};
    for (const entry of Object.keys(map).sort()) {
      const value = map[entry]!;
      if (at - value <= SEND_LOG_RETENTION_SECONDS) kept[entry] = value;
    }
    this.map = kept;
    try {
      ensurePrivateDirectory(this.base);
      writePrivateFileAtomic(this.file, JSON.stringify(kept));
    } catch {
      // 保存できなくてもメモリの間引きは効く。
    }
  }

  private loaded(): Record<string, number> {
    if (this.map !== null) return this.map;
    const map: Record<string, number> = {};
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      raw = null;
    }
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const source = typeof obj["sent"] === "object" && obj["sent"] !== null && !Array.isArray(obj["sent"])
        ? obj["sent"] as Record<string, unknown>
        : obj;
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === "number") map[key] = value;
      }
    }
    this.map = map;
    return map;
  }
}

/** 最後の送信結果（doctor 用）。理由は短いコードだけ（秘密・本文を含めない）。 */
export interface PushLastResult {
  /** epoch 秒。 */
  at: number;
  kind: PushKind;
  status: "sent" | "skipped" | "failed";
  reason?: string;
  transport?: "relay" | "direct";
}

export class PushLastResultStore {
  private readonly file: string;
  private readonly base: string;

  constructor(base: string = defaultPushBase()) {
    this.base = base;
    this.file = path.join(base, "last-result.json");
  }

  load(): PushLastResult | null {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const status = obj["status"];
    if (typeof obj["at"] !== "number" || !PUSH_KINDS.includes(obj["kind"] as PushKind) ||
      (status !== "sent" && status !== "skipped" && status !== "failed")) return null;
    const transport = obj["transport"];
    return {
      at: obj["at"],
      kind: obj["kind"] as PushKind,
      status,
      ...(typeof obj["reason"] === "string" ? { reason: obj["reason"] } : {}),
      ...(transport === "relay" || transport === "direct" ? { transport } : {}),
    };
  }

  save(result: PushLastResult): void {
    try {
      ensurePrivateDirectory(this.base);
      writePrivateFileAtomic(this.file, JSON.stringify(result));
    } catch {
      // doctor の表示用。失敗しても送信には影響させない。
    }
  }
}
