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

/** Claude Code が project ディレクトリ名をそのまま使う上限（超えた分は切ってハッシュを付ける）。 */
const CLAUDE_SLUG_MAX_LENGTH = 200;

/** Claude Code と同じ文字列ハッシュ（UTF-16 単位の `h*31 + c` を 32bit で回す）の絶対値を 36 進で。 */
function claudeSlugHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * cwd → Claude Code の project ディレクトリ名（`~/.claude/projects/<slug>`）。
 * Claude 本体と同じ規則: 英数字以外は UTF-16 の 1 単位ごとに `-`（`/` `.` `_` 空白・日本語も）。
 * 200 文字を超えたら先頭 200 文字 + `-` + 元パスのハッシュ（36 進）。
 * `/` と `.` だけ置換していた頃は、日本語や `_` を含むフォルダで transcript を見失い
 * 会話ログが空になっていた（一覧は jsonl を直接走査するので出る）。
 */
export function claudeProjectSlug(cwd: string): string {
  const canonical = canonicalPath(cwd);
  const slug = canonical.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= CLAUDE_SLUG_MAX_LENGTH) return slug;
  return `${slug.slice(0, CLAUDE_SLUG_MAX_LENGTH)}-${claudeSlugHash(canonical)}`;
}
