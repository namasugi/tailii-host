// claudeTranscriptExists.ts
// tailii (TS host) — Claude の会話 transcript（`~/.claude/projects/<slug>/<id>.jsonl`）があるか。
// 先行起動（session-prewarm）が「まだ使われていない」ことの裏付けに使う: Claude は最初の発話まで
// transcript を書かない（2.1.317 実測: 起動して入力欄が出ただけでは作られない）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectSlug } from "../shared/paths.js";

/** 会話 id の安全な形（uuid）。それ以外はパスに使わない。 */
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

export function claudeTranscriptExists(
  cwd: string,
  sessionId: string,
  projectsRoot: string = path.join(os.homedir(), ".claude", "projects"),
): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  try {
    return fs.existsSync(path.join(projectsRoot, claudeProjectSlug(cwd), `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}
