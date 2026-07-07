// pushTypes.ts
// tailii (TS host) — Push レイヤ共通型・保存レイアウト
// Swift 版 PushPayload.swift（ApnsHost / PushError / PushPayload / ApnsStorage）の移植。
//
// 秘密（.p8/token）・diff・cwd 本文を payload/ログに載せない（Requirement 6.5, 2.3）。

import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";

// MARK: - ApnsHost

/**
 * APNs 送信先の環境。device token の登録環境（DEBUG=sandbox / RELEASE=production）に
 * 由来し、送信ホストの選択に用いる。JSON 上は `"production"` / `"sandbox"` の文字列。
 */
export type ApnsHost = "production" | "sandbox";

/** 当該環境の APNs ホスト名（token の environment から送信ホストを写像）。 */
export function apnsSendHost(environment: ApnsHost): string {
  return environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
}

/** 文字列が有効な `ApnsHost` か判定する。 */
export function isApnsHost(value: unknown): value is ApnsHost {
  return value === "production" || value === "sandbox";
}

// MARK: - PushError

/**
 * APNs 送信のエラー種別（APNs レスポンスの reason を分類して写像する）。
 * 呼び出し側はこれをもとに再試行・宛先除外を判断する（Requirement 6.2, 6.3）。
 */
export type PushError =
  | { kind: "expiredProviderToken" }
  | { kind: "unregistered" }
  | { kind: "tooManyProviderTokenUpdates" }
  | { kind: "transport"; detail: string }
  | { kind: "http"; status: number; reason: string };

/** 2 つの `PushError` が同値か判定する（テスト・比較用）。 */
export function pushErrorEquals(a: PushError, b: PushError): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "transport" && b.kind === "transport") return a.detail === b.detail;
  if (a.kind === "http" && b.kind === "http") return a.status === b.status && a.reason === b.reason;
  return true;
}

// MARK: - ApnsStorage（保存ディレクトリ規約）

/** デフォルトの APNs ディレクトリ（`~/.tailii/apns`）。 */
export function defaultApnsBase(): string {
  return path.join(os.homedir(), ".tailii", "apns");
}

/** APNs ディレクトリを `0700` で用意する（冪等、非ディレクトリ衝突は例外）。 */
export function ensureApnsDirectory(base: string): void {
  ensureDirectory0700(base);
}

// MARK: - PushPayload

/**
 * APNs リクエスト本文（最小 aps + カスタムキー）を JSON エンコードして返す。
 *
 * payload には承認判断へ導く最小情報（tool 名・セッション・approvalId）のみを含め、
 * 承認内容の詳細本文・diff・cwd 全文・秘密は載せない（Requirement 2.3 / 6.5）。
 * キー順の非決定性を避けるため辞書順で符号化する（Swift 版 .sortedKeys と同一）。
 */
export function pushPayloadBody(approvalId: string, tool: string, session: string): Buffer {
  const alert = { body: `${tool} · ${session}`, title: "承認待ち" };
  const aps = {
    alert,
    "interruption-level": "time-sensitive",
    sound: "default",
    "thread-id": session,
  };
  const root = { approvalId, aps, session, tool };
  return Buffer.from(JSON.stringify(sortDeep(root)), "utf8");
}

/** ネストした plain object のキーを辞書順に並べ替える（.sortedKeys 相当）。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = sortDeep(obj[key]);
    return sorted;
  }
  return value;
}
