// transcriptPath.ts
// tailii (TS host) — claude transcript（JSONL）の既定パス解決。hub の復元照合・chat 注入前の
// 残存テキスト照合・engine の中断後検出（restored-prompt-discard）が同じ規則で同じ会話を見る。

import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectSlug } from "../shared/paths.js";
import { locateClaudeTranscript } from "./claudeTranscriptLocator.js";
import type { SessionMeta } from "./sessionMetadataStore.js";

/**
 * 既定の claude transcript 解決（`~/.claude/projects/<slug>/<sessionId>.jsonl`）。ID 未記録は null。
 * 記録上の cwd の slug に無ければ全 slug から会話 id で探す（会話中の `/cd` 等で移った会話, session-workdir-change）。
 * どこにも無ければ（まだ書かれていない）記録どおりのパスを返す。
 */
export function claudeTranscriptPathFor(meta: SessionMeta, homeDir: string = os.homedir()): string | null {
  // 他の tail open と同じ優先順（providerSessionId → claudeSessionId）。別会話を照合しない。
  const sessionId = meta.providerSessionId ?? meta.claudeSessionId;
  if (sessionId === undefined || sessionId.length === 0) return null;
  const projectsDir = path.join(homeDir, ".claude", "projects");
  const located = locateClaudeTranscript(sessionId, meta.cwd, { projectsDir });
  return located?.path ?? path.join(projectsDir, claudeProjectSlug(meta.cwd), `${sessionId}.jsonl`);
}
