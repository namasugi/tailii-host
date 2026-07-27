// observationLog.ts
// tailii (TS host) — Mac 側観測/監査ログ（append-only NDJSON）
// Swift 版 ObservationLog.swift の移植。1 イベント = 1 行を
// `<base>/<session>.ndjson` へ純追記する。イベント種別は `mac.*` 名前空間。
// 秘密（接続鍵・device token 値）を運ぶフィールドは型として存在しない。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";

/** 観測ログに追記するイベント種別（Swift 版 ObsEvent と対）。 */
export type ObsEvent =
  | { kind: "sessionStarted"; cwd: string }
  | { kind: "reattached" }
  | { kind: "sessionKilled" }
  | { kind: "approvalRequested"; id: string; tool: string }
  | { kind: "approvalDecided"; id: string; decision: string }
  | { kind: "toolExecuted"; id: string; tool: string; decision: string }
  | { kind: "pushSent"; id: string; tool: string }
  | { kind: "pushSkipped"; id: string; reason: string }
  | { kind: "pushFailed"; id: string; reason: string }
  | { kind: "deviceTokenRegistered"; environment: string };

/** 直列化時の名前空間付きイベント種別名（iOS ミラーと区別可能）。 */
const OBS_TYPE: Record<ObsEvent["kind"], string> = {
  sessionStarted: "mac.session.started",
  reattached: "mac.session.reattached",
  sessionKilled: "mac.session.killed",
  approvalRequested: "mac.approval.requested",
  approvalDecided: "mac.approval.decided",
  toolExecuted: "mac.tool.executed",
  pushSent: "mac.push.sent",
  pushSkipped: "mac.push.skipped",
  pushFailed: "mac.push.failed",
  deviceTokenRegistered: "mac.device.tokenRegistered",
};

/** デフォルトのベースディレクトリ（`~/.tailii/audit`）。 */
export function defaultObservationBase(): string {
  return path.join(os.homedir(), ".tailii", "audit");
}

/** `ObservationLog` が投げる型付きエラー。 */
export class ObservationLogError extends Error {
  constructor(
    public readonly reason: "invalid-session-name" | "directory-creation-failed" | "append-failed",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "ObservationLogError";
  }
}

/** Mac 側の観測/監査ログ（append-only NDJSON）。 */
export class ObservationLog {
  private readonly base: string;

  constructor(base?: string) {
    this.base = base ?? defaultObservationBase();
  }

  /**
   * イベントを 1 行の NDJSON として追記する（append-only）。
   * 時刻は決定性のため呼び出し側から Unix 秒（`at`）で渡す。
   */
  append(event: ObsEvent, session: string, at: number): void {
    validateSessionName(session);
    try {
      ensureDirectory0700(this.base);
    } catch (error) {
      throw new ObservationLogError("directory-creation-failed", `${this.base}: ${String(error)}`);
    }
    const line = encodeLine(event, at);
    const file = path.join(this.base, `${session}.ndjson`);
    try {
      fs.appendFileSync(file, line);
    } catch (error) {
      throw new ObservationLogError("append-failed", `${file}: ${String(error)}`);
    }
  }
}

/** イベント 1 件を NDJSON 1 行（末尾 `\n` 付き）へ符号化する（キーは辞書順）。 */
function encodeLine(event: ObsEvent, at: number): string {
  const record: Record<string, unknown> = { type: OBS_TYPE[event.kind], at };
  switch (event.kind) {
    case "sessionStarted":
      record["cwd"] = event.cwd;
      break;
    case "reattached":
    case "sessionKilled":
      break;
    case "approvalRequested":
    case "pushSent":
      record["id"] = event.id;
      record["tool"] = event.tool;
      break;
    case "approvalDecided":
      record["id"] = event.id;
      record["decision"] = event.decision;
      break;
    case "toolExecuted":
      record["id"] = event.id;
      record["tool"] = event.tool;
      record["decision"] = event.decision;
      break;
    case "pushSkipped":
    case "pushFailed":
      record["id"] = event.id;
      record["reason"] = event.reason;
      break;
    case "deviceTokenRegistered":
      record["environment"] = event.environment;
      break;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return JSON.stringify(sorted) + "\n";
}

/** session 名が安全かどうかを検証する（SocketPath の規約に合わせる）。 */
function validateSessionName(name: string): void {
  if (name.length === 0 || name.includes("\0") || name.includes("/") || name === "." || name === "..") {
    throw new ObservationLogError("invalid-session-name", name);
  }
}
