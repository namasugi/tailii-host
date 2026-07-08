// sessionActivityProvider.ts
// tailii (TS host) — セッション更新時刻の権威解決（session-list-lifecycle 1.3/1.4）
// updatedAt = そのセッション自身の最終会話時刻。
// claude: メタデータの claudeSessionId が指す transcript の最終 timestamp エントリ
//         （lastConversationTimestamp; mtime は resume が状態行追記で進めるため使わない）。
// codex:  同一 cwd の codex 会話の最新 updatedAt（新規起動は会話 id を永続しないため cwd 近似）。
// 会話が無い（transcript 不在/状態行のみ）セッションは null = 一覧最下位に沈む。
// tmux `#{session_activity}` は使わない: セッション作成自体が「活動」として刻まれるため、
// 会話ゼロの新規セッションがどの実会話よりも上に浮いてしまう（2026-07-08 ユーザー報告の根治）。
// cwd 単位の共有 mtime（旧実装）も使わない: 同一 cwd の別セッションの会話を継承してしまう。

import { lastConversationTimestamp, type ClaudeSessionStore } from "./claudeSessionStore.js";
import type { CodexSessionStore } from "./codexSessionStore.js";
import type { SessionInfo } from "./protocol.js";
import type { SessionMeta, SessionMetadataStore } from "./sessionMetadataStore.js";
import { standardize } from "./paths.js";

/** セッションの更新時刻（Unix 秒）を解決する注入可能な抽象。解決不能は null。 */
export type SessionActivityProvider = (session: SessionInfo) => number | null;

/** cwd を Claude Code projects の slug へ写す（`/` と `.` を `-` に置換）。 */
export function activitySlugForCwd(cwd: string): string {
  return standardize(cwd).replaceAll("/", "-").replaceAll(".", "-");
}

/** セッション自身の会話 transcript の mtime を updatedAt として返す既定実装。 */
export function ownTranscriptActivityProvider(options: {
  metadataStore: SessionMetadataStore;
  claudeStore: ClaudeSessionStore;
  codexStore: CodexSessionStore;
}): SessionActivityProvider {
  const { metadataStore, claudeStore, codexStore } = options;
  return (session) => {
    let meta: SessionMeta | null;
    try {
      meta = metadataStore.get(session.name);
    } catch {
      return null;
    }
    if (!meta) return null;

    if (meta.agent === "codex") {
      // codex は新規起動時に会話 id を永続していないため、同一 cwd の会話の最新で近似する。
      const cwd = standardize(meta.cwd);
      let latest: number | null = null;
      try {
        for (const info of codexStore.list(cwd)) {
          if (standardize(info.cwd) !== cwd) continue;
          if (info.updatedAt !== undefined && (latest === null || info.updatedAt > latest)) {
            latest = info.updatedAt;
          }
        }
      } catch {
        return null;
      }
      return latest;
    }

    const sessionId = meta.claudeSessionId;
    if (!sessionId) return null;
    const transcript = claudeStore.transcriptPath(sessionId);
    if (transcript === null) return null;
    return lastConversationTimestamp(transcript);
  };
}
