// deviceTokenStore.ts
// tailii (TS host) — device token の安全保存
// Swift 版 DeviceTokenStore.swift の移植。
//
// `~/.tailii/apns/device-token.json` に device token を保存 / 読込 / 削除する。
// token が変化したら上書き（3.4）、`Unregistered` 受領時は delete() で宛先を除外（6.3）。
// 未保存なら load() は null（送信スキップ判別, 3.5）。ファイルは 0600、ディレクトリは 0700。

import * as fs from "node:fs";
import * as path from "node:path";
import { type ApnsHost, defaultApnsBase, ensureApnsDirectory, isApnsHost } from "./pushTypes.js";

/** 保存する device token レコード（device-token.json の中身）。 */
export interface DeviceTokenRecord {
  /** 宛先 device token（hex）。 */
  token: string;
  /** 登録環境（production / sandbox）。送信ホスト選択に使う。 */
  environment: ApnsHost;
  /** bundle id（`apns-topic`）。 */
  bundleId: string;
  /** 更新時刻（epoch 秒）。 */
  updatedAt: number;
}

/**
 * device token の永続化契約（load / save / delete）。
 * APNs 送信側は load() で宛先を得て、`Unregistered` 受領時に delete() で宛先を除外する
 * （3.3/3.4/3.5/6.3）。テストは実体を差し替え可能にするため interface 化。
 */
export interface DeviceTokenStoring {
  load(): DeviceTokenRecord | null;
  save(record: DeviceTokenRecord): void;
  delete(): void;
}

/**
 * `~/.tailii/apns/device-token.json` へ device token を保存するストア。
 * ディレクトリは 0700、ファイルは 0600 で保存する（Requirement 6.5）。
 * テスト容易性のため base を注入できる。
 */
export class DeviceTokenStore implements DeviceTokenStoring {
  private readonly base: string;

  constructor(base?: string) {
    this.base = base ?? defaultApnsBase();
  }

  private get fileURL(): string {
    return path.join(this.base, "device-token.json");
  }

  /** 保存済み device token を読み込む。未保存・不正 JSON なら `null`（3.5）。 */
  load(): DeviceTokenRecord | null {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.fileURL, "utf8"));
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj["token"] !== "string" ||
      !isApnsHost(obj["environment"]) ||
      typeof obj["bundleId"] !== "string" ||
      typeof obj["updatedAt"] !== "number"
    ) {
      return null;
    }
    return {
      token: obj["token"],
      environment: obj["environment"],
      bundleId: obj["bundleId"],
      updatedAt: obj["updatedAt"],
    };
  }

  /** device token を 0600 で保存する（同一パス上書き＝token 置換, 3.4）。 */
  save(record: DeviceTokenRecord): void {
    ensureApnsDirectory(this.base);
    // キー順の非決定性を避けるため辞書順で符号化（Swift 版 .sortedKeys と同一）。
    const payload = JSON.stringify({
      bundleId: record.bundleId,
      environment: record.environment,
      token: record.token,
      updatedAt: record.updatedAt,
    });
    fs.writeFileSync(this.fileURL, payload, { mode: 0o600 });
    // 既存ファイルは writeFileSync の mode が効かないため明示的に 0600 を保証する。
    fs.chmodSync(this.fileURL, 0o600);
  }

  /** 保存済み device token を削除する（宛先除外, 6.3）。未保存でも成功（冪等）。 */
  delete(): void {
    try {
      fs.rmSync(this.fileURL);
    } catch {
      // 未保存 = 何もしない（冪等）。他の削除失敗も送信停止判断を阻害しない。
    }
  }
}
