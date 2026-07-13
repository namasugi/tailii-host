// paths.ts
// tailii (TS host) — パス関連の共有ヘルパ（Swift 版 Launch.swift の isInsideBase ほか）

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** `~/…` を展開しつつ字句正準化した絶対パスを返す（Swift standardizedFileURL 相当）。 */
export function standardize(p: string): string {
  return path.normalize(path.resolve(expandTilde(p)));
}

/** 先頭 `~` をホームディレクトリへ展開する。 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * あるパスが baseDir 自身または baseDir 配下かを lexical（`..` 畳み込み後）に判定する。
 * symlink 実体は追わず字句正準化のみで containment を判定する（Swift 版 isInsideBase と同一）。
 */
export function isInsideBase(p: string, base: string): boolean {
  const pp = standardize(p);
  const bb = standardize(base);
  return pp === bb || pp.startsWith(bb + "/");
}

/** ディレクトリを `0700` で作成する（既存ならそのまま）。存在するがファイルなら例外。 */
export function ensureDirectory0700(dir: string): void {
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`パスが存在するがディレクトリではない: ${dir}`);
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** シンボリックリンクを解決した canonical パス（解決不能時は字句正準化のみ）。 */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(standardize(p));
  } catch {
    return standardize(p);
  }
}

/**
 * cwd → Claude Code の project ディレクトリ名（`~/.claude/projects/<slug>`）。
 * Claude は `/` に加えて `.` も `-` へ置換する（例: `.claude/worktrees/x` →
 * `--claude-worktrees-x`）。`/` だけ置換すると worktree など dot を含む cwd で
 * transcript を見失う（実機で会話が表示されない事故の根因）。
 */
export function claudeProjectSlug(cwd: string): string {
  return canonicalPath(cwd).replaceAll("/", "-").replaceAll(".", "-");
}
