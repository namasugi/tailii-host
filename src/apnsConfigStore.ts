// apnsConfigStore.ts
// tailii (TS host) — APNs 認証設定の読込・未設定判別
// Swift 版 ApnsConfigStore.swift の移植。
//
// `~/.tailii/apns/config.json` を読み、APNs 送信に必要な認証設定
// （teamId / keyId / keyPath / topic）を提供する。欠落・不整合は null で表現し、
// 呼び出し側が「未設定＝送信スキップ」を判別できる（Requirement 6.4）。
// 秘密（.p8）そのものは保持せず keyPath 参照のみを扱う（Requirement 6.5）。

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultApnsBase } from "./pushTypes.js";

/** APNs 送信に必要な認証設定（config.json のデコード結果）。 */
export interface ApnsConfig {
  /** Apple Developer Team ID（JWT の `iss` クレーム）。 */
  teamId: string;
  /** APNs 認証キーの Key ID（JWT ヘッダの `kid`）。 */
  keyId: string;
  /** `.p8` 認証キーファイルへのパス（0600 で保存された秘密鍵）。 */
  keyPath: string;
  /** `apns-topic`（= bundle id）。 */
  topic: string;
}

/**
 * `~/.tailii/apns/config.json` から APNs 認証設定を読み込むストア。
 * 未設定（ファイル欠落）・不整合（不正 JSON／フィールド欠落）はいずれも `load()` が
 * `null` を返す（Requirement 6.4）。テスト容易性のため base を注入できる。
 */
export class ApnsConfigStore {
  private readonly base: string;

  constructor(base?: string) {
    this.base = base ?? defaultApnsBase();
  }

  /** `config.json` を読み込む。未設定・不整合なら `null`（Requirement 6.4）。 */
  load(): ApnsConfig | null {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(this.base, "config.json"), "utf8"));
    } catch {
      // ファイル欠落 / 不正 JSON = 未設定（6.4）
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj["teamId"] !== "string" ||
      typeof obj["keyId"] !== "string" ||
      typeof obj["keyPath"] !== "string" ||
      typeof obj["topic"] !== "string"
    ) {
      // フィールド欠落 = 未設定扱い（6.4）
      return null;
    }
    return {
      teamId: obj["teamId"],
      keyId: obj["keyId"],
      keyPath: obj["keyPath"],
      topic: obj["topic"],
    };
  }
}
