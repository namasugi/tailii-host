// sessionActivityProvider.ts
// tailii (TS host) — セッション更新時刻の権威解決（session-list-lifecycle 1.3/1.4）
// Swift 版 SessionActivityProvider.swift の移植。
// updatedAt は Claude Code トランスクリプト（`~/.claude/projects/<slug>/*.jsonl`）の最大 mtime。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInfo } from "./protocol.js";
import { standardize } from "./paths.js";

/** セッションの更新時刻（Unix 秒）を解決する注入可能な抽象。解決不能は null。 */
export type SessionActivityProvider = (session: SessionInfo) => number | null;

/** cwd を Claude Code projects の slug へ写す（`/` と `.` を `-` に置換）。 */
export function activitySlugForCwd(cwd: string): string {
  return standardize(cwd).replaceAll("/", "-").replaceAll(".", "-");
}

/** Claude Code トランスクリプトの最新 mtime を updatedAt として返す既定実装。 */
export function claudeTranscriptActivityProvider(projectsBase?: string): SessionActivityProvider {
  const base = projectsBase ?? path.join(os.homedir(), ".claude", "projects");
  return (session) => {
    const cwd = session.cwd;
    if (!cwd) return null;
    const dir = path.join(base, activitySlugForCwd(cwd));
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    let latest: number | null = null;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl") || entry.startsWith(".")) continue;
      try {
        const secs = Math.floor(fs.statSync(path.join(dir, entry)).mtimeMs / 1000);
        if (latest === null || secs > latest) latest = secs;
      } catch {
        // 個別ファイルの stat 失敗はスキップ。
      }
    }
    return latest;
  };
}
