// legacyHomeMigration.ts — one-time rename of the home data dir
// ~/.pocketclaude → ~/.tailii (旧プロジェクト名 PocketClaude からのリネーム移行).
//
// Best-effort and non-fatal: a migration failure must never crash the CLI,
// so everything is wrapped in try/catch and errors are swallowed. On the
// happy path there is no output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function migrateLegacyHome(): void {
  try {
    const home = os.homedir();
    const oldDir = path.join(home, ".pocketclaude");
    const newDir = path.join(home, ".tailii");
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
    }
  } catch {
    // Ignore: migration is best-effort and must never throw.
  }
}
