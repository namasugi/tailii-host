// Claude Code の Codex プラグインが保存するジョブから、親会話と Codex の記録 ID を読む。
// 状態は更新が途絶える場合があるため使わず、Codex の記録で判定する。
import * as fs from "node:fs";
import * as path from "node:path";

interface CompanionJob {
  id: string;
  sessionId: string;
  threadId: string;
}

export class CodexCompanionJobs {
  private readonly paths = new Map<string, string>();
  private readonly cache = new Map<string, { size: number; mtimeMs: number; job: CompanionJob }>();

  constructor(private readonly stateDir: string) {}

  read(id: string, sessionId: string): CompanionJob | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const known = this.paths.get(id);
    const files = known === undefined ? this.candidates(id) : [known];
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > 4 * 1024 * 1024) continue;
        const cached = this.cache.get(file);
        let job = cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.job : null;
        if (job === null) {
          const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
          if (value === null || typeof value !== "object" || value["id"] !== id
            || typeof value["sessionId"] !== "string" || typeof value["threadId"] !== "string"
            || !/^[A-Za-z0-9_-]+$/.test(value["threadId"])) continue;
          job = { id, sessionId: value["sessionId"], threadId: value["threadId"] };
          this.cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, job });
        }
        if (job.sessionId !== sessionId) continue;
        this.paths.set(id, file);
        return job;
      } catch {
        // 書き始め・更新中・削除されたファイルは次の評価で読み直す。
        if (known === file) this.paths.delete(id);
      }
    }
    return null;
  }

  private candidates(id: string): string[] {
    try {
      return fs.readdirSync(this.stateDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.stateDir, entry.name, "jobs", `${id}.json`));
    } catch { return []; }
  }
}
