// socketPath.ts
// tailii (TS host) — unix domain socket パス規約
// Swift 版 SocketPath.swift の移植。broker / hook / launch が同一関数でパスを導出する
// （ハードコード分散禁止）。デフォルト: ~/.tailii/run/<session>.sock、親 0700。

import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";

/** `resolveSocketPath` が投げる型付きエラー。 */
export class SocketPathError extends Error {
  constructor(
    public readonly reason:
      | "empty-session-name"
      | "slash-in-session-name"
      | "dot-traversal-in-session-name"
      | "null-byte-in-session-name"
      | "directory-creation-failed",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "SocketPathError";
  }
}

/** デフォルトのベースディレクトリ（`~/.tailii/run`）。 */
export function defaultSocketBase(): string {
  return path.join(os.homedir(), ".tailii", "run");
}

/**
 * session 名から unix domain socket パスを決定的に導出し、親ディレクトリを 0700 で準備する。
 * session 名に `/`・`..`・`.`・空文字・null バイトを含む場合は `SocketPathError` を投げる。
 */
export function resolveSocketPath(session: string, base?: string): string {
  validateSessionName(session);
  const baseDir = base ?? defaultSocketBase();
  try {
    ensureDirectory0700(baseDir);
  } catch (error) {
    throw new SocketPathError("directory-creation-failed", `${baseDir}: ${String(error)}`);
  }
  return path.join(baseDir, `${session}.sock`);
}

/** session 名が安全かどうかを検証する（Swift 版 validateSessionName と同一規約）。 */
function validateSessionName(session: string): void {
  if (session.length === 0) {
    throw new SocketPathError("empty-session-name", "(empty)");
  }
  if (session.includes("\0")) {
    throw new SocketPathError("null-byte-in-session-name", session);
  }
  if (session.includes("/")) {
    throw new SocketPathError("slash-in-session-name", session);
  }
  if (session === "." || session === "..") {
    throw new SocketPathError("dot-traversal-in-session-name", session);
  }
}
