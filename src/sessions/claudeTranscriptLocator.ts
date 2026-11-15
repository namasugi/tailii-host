// claudeTranscriptLocator.ts
// tailii (TS host) — Claude の会話ログ（`~/.claude/projects/<slug>/<会話 id>.jsonl`）を見失わない（session-workdir-change）。
//
// Claude Code は会話中に作業フォルダが移ると（利用者の `/cd`・Claude 自身の `EnterWorktree` / `ExitWorktree`）、
// 会話ログと付帯フォルダ（`<slug>/<id>/`）を移動先の slug へ丸ごと移し（rename）、`{"type":"relocated",
// "sessionId":…,"relocatedCwd":…}` を書く（2.1.325 実測 2026-11-15。会話 id は変わらない。relocated 行は
// タイトルと同じくセッションの区切りで末尾へ書き直される）。Tailii の記録（sessionMetadataStore）の cwd から
// slug を組み立て直すだけだと、移動の後は古い slug を見て空になる。
//
// ここは次の 3 つを共通にする:
//   - `locateClaudeTranscript`: 記録上の cwd の slug に無ければ、全 slug から会話 id で探す。
//   - `claudeTranscriptCwd`: 会話ログが今どのフォルダの会話か（Claude Code 本体と同じ規則: 末尾の最新の
//     `relocated.relocatedCwd`、無ければ先頭の `cwd`）。
//   - `ensureClaudeMetaCwd`: 見つけたら記録を直す。
//   - `moveClaudeTranscript`: Claude が動いていないときに Tailii が会話ログを移す（削除済みワークツリーの救済・
//     止まっている会話の作業フォルダ変更）。Claude の `/cd` と同じく `relocated` 行を書き足す。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalPath, claudeProjectSlug } from "../shared/paths.js";
import { ClaudeSessionStore } from "./claudeSessionStore.js";
import type { SessionMeta, SessionMetadataStore } from "./sessionMetadataStore.js";

/** 末尾から relocated 行を探す範囲（一覧の末尾走査と同じ 256KiB）。 */
const RELOCATED_TAIL_BYTES = 256 * 1024;
/**
 * 末尾に無いときに頭から探す上限（巨大な会話ログを毎回読み切らない）。relocated 行はセッションの区切りで末尾へ
 * 書き直されるので、ここまで読むのは稀。
 */
const RELOCATED_FULL_SCAN_MAX_BYTES = 8 * 1024 * 1024;
/** 記録を直せなかった会話（移った先のフォルダが分からない・消えた）を照合し直さない時間。 */
const UNFIXABLE_RECHECK_MS = 10 * 60 * 1000;
/** 記録を直せなかった会話（会話 id + 記録上の cwd → 会話ログのパス・大きさ・時刻・照合した時刻）。 */
const unfixable = new Map<string, { path: string; size: number; mtimeMs: number; checkedAtMs: number }>();
/** 先頭から cwd を探す範囲。 */
const HEAD_BYTES = 256 * 1024;

export function defaultClaudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** 会話 id をパスへ埋めてよいか（区切りや `..` を含む値で projects の外を見ない）。 */
function safeConversationId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && !id.includes("/") && !id.includes("\\") && !id.includes("\0") &&
    id !== "." && id !== "..";
}

export interface ClaudeTranscriptLocation {
  /** 会話ログのパス。 */
  path: string;
  /** その会話ログが置かれた slug のフォルダ（cwd が分からないときの読み取り先）。 */
  dir: string;
  /**
   * 会話ログが今どのフォルダの会話か。記録どおりの slug にあれば記録の cwd。別の slug で見つけたときは会話ログから
   * 読む（読めない・置き場所と食い違うときは null）。
   */
  cwd: string | null;
  /** 記録上の cwd の slug ではない所で見つけた。 */
  moved: boolean;
}

/**
 * 会話ログを探す。記録上の cwd の slug にあればそれ、無ければ全 slug から会話 id で探す（同じ id が複数あれば
 * 会話本体を持つ新しい方。`ClaudeSessionStore.transcriptPath` と同じ判定）。どこにも無ければ null。
 */
export function locateClaudeTranscript(
  conversationId: string,
  recordedCwd: string | null,
  options: { projectsDir?: string } = {},
): ClaudeTranscriptLocation | null {
  if (!safeConversationId(conversationId)) return null;
  const projectsDir = options.projectsDir ?? defaultClaudeProjectsDir();
  if (recordedCwd !== null && recordedCwd.length > 0) {
    const dir = path.join(projectsDir, claudeProjectSlug(recordedCwd));
    const primary = path.join(dir, `${conversationId}.jsonl`);
    if (isFile(primary)) return { path: primary, dir, cwd: recordedCwd, moved: false };
  }
  const found = new ClaudeSessionStore(projectsDir).transcriptPath(conversationId);
  if (found === null) return null;
  return { path: found, dir: path.dirname(found), cwd: claudeTranscriptCwd(found), moved: true };
}

/**
 * 追尾している会話ログ（`<projects>/<slug>/<id>.jsonl`）がその場所から消えていたら、同じ projects の中を会話 id で
 * 探し直して新しいパスを返す（追尾中に `/cd`・EnterWorktree / ExitWorktree で別の slug へ移った）。そのままあれば
 * 同じパス、どこにも無ければ null。
 */
export function followMovedTranscript(transcriptPath: string): string | null {
  if (isFile(transcriptPath)) return transcriptPath;
  const id = path.basename(transcriptPath, ".jsonl");
  const projectsDir = path.dirname(path.dirname(transcriptPath));
  return locateClaudeTranscript(id, null, { projectsDir })?.path ?? null;
}

/**
 * まだ現れていない会話ログを待つ間に、記録どおりの slug（`dir`）以外へ現れていないかを探す（1 回も発話していない
 * 会話で作業フォルダを変えると、会話ログは移動先の slug に初めて作られる）。見つからなければ null。
 */
export function findTranscriptElsewhere(dir: string, conversationId: string): string | null {
  const located = locateClaudeTranscript(conversationId, null, { projectsDir: path.dirname(dir) });
  return located === null || located.dir === dir ? null : located.path;
}

/** 記録上の cwd から、会話ログのある slug のフォルダを返す（見つからなければ記録どおりの slug）。 */
export function claudeTranscriptDir(
  conversationId: string | null,
  recordedCwd: string,
  options: { projectsDir?: string } = {},
): string {
  const projectsDir = options.projectsDir ?? defaultClaudeProjectsDir();
  if (conversationId !== null) {
    const located = locateClaudeTranscript(conversationId, recordedCwd, { projectsDir });
    if (located !== null) return located.dir;
  }
  return path.join(projectsDir, claudeProjectSlug(recordedCwd));
}

/**
 * 会話ログが今どのフォルダの会話か。Claude Code 本体（2.1.325）の一覧と同じく、末尾の最新の `relocated` 行の
 * `relocatedCwd`、無ければ先頭の記録の `cwd`。置き場所（slug）と合わない値は採らない（別の会話の残骸や読み違い
 * で見当違いのフォルダを返さない）。合う値が無ければ null。
 */
export function claudeTranscriptCwd(filePath: string): string | null {
  const slug = path.basename(path.dirname(filePath));
  const candidates: string[] = [];
  const relocated = latestRelocatedCwd(filePath);
  if (relocated !== null) candidates.push(relocated);
  const head = headCwd(filePath);
  if (head !== null) candidates.push(head);
  for (const candidate of candidates) {
    if (claudeProjectSlug(candidate) === slug) return candidate;
  }
  return null;
}

/** 会話ログの最新の `relocated.relocatedCwd`（末尾 256KiB → 無ければ頭から上限まで）。無ければ null。 */
export function latestRelocatedCwd(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const tailSpan = Math.min(size, RELOCATED_TAIL_BYTES);
    const fromTail = lastRelocatedIn(readRange(fd, size - tailSpan, tailSpan), tailSpan < size);
    if (fromTail !== null || tailSpan >= size) return fromTail;
    const span = Math.min(size, RELOCATED_FULL_SCAN_MAX_BYTES);
    return lastRelocatedIn(readRange(fd, 0, span), false);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readRange(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString("utf8");
}

/** 文字列の中の最後の relocated 行の relocatedCwd。`dropFirst` は先頭が行の途中で切れている。 */
function lastRelocatedIn(content: string, dropFirst: boolean): string | null {
  const lines = content.split("\n");
  const first = dropFirst ? 1 : 0;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i] ?? "";
    if (!line.includes('"relocated"') || !line.includes('"relocatedCwd"')) continue;
    const cwd = relocatedCwdOf(line);
    if (cwd !== null) return cwd;
  }
  return null;
}

/** 1 行が relocated 記録なら relocatedCwd（絶対パス）。それ以外は null。 */
export function relocatedCwdOf(line: string): string | null {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (typeof record !== "object" || record === null || record["type"] !== "relocated") return null;
    const cwd = record["relocatedCwd"];
    return typeof cwd === "string" && cwd.startsWith("/") ? cwd : null;
  } catch {
    return null;
  }
}

function headCwd(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    for (const line of readRange(fd, 0, HEAD_BYTES).split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const cwd = record["cwd"];
        if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
      } catch {
        // 途中で切れた行・壊れた行は飛ばす。
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Claude の会話の記録（metadata）の cwd を、会話ログの実際の置き場所に合わせる。記録どおりの slug に会話ログが
 * 無く、別の slug で見つかり、その会話のフォルダが分かって実在するときだけ直す（直した記録を返す）。直さない・
 * 直せないときは渡した記録をそのまま返す。Codex・会話 id の無い記録は触らない。
 */
export function ensureClaudeMetaCwd(
  store: Pick<SessionMetadataStore, "put">,
  meta: SessionMeta,
  options: { projectsDir?: string; log?: (message: string) => void } = {},
): SessionMeta {
  if ((meta.agent ?? "claude") !== "claude") return meta;
  const conversationId = meta.providerSessionId ?? meta.claudeSessionId;
  if (conversationId === undefined || conversationId.length === 0) return meta;
  // 前に直せなかった会話は、会話ログが変わらない間（と一定時間）は照合し直さない（hub は毎分と開くたびに呼ぶ。
  // 照合は全プロジェクトの走査と会話ログの読み直しを伴う）。
  const memoKey = `${options.projectsDir ?? ""}\0${conversationId}\0${meta.cwd}`;
  const remembered = unfixable.get(memoKey);
  if (remembered !== undefined) {
    const stat = statOrNull(remembered.path);
    if (stat !== null && stat.size === remembered.size && stat.mtimeMs === remembered.mtimeMs &&
      Date.now() - remembered.checkedAtMs < UNFIXABLE_RECHECK_MS) return meta;
    unfixable.delete(memoKey);
  }
  const located = locateClaudeTranscript(conversationId, meta.cwd, options.projectsDir !== undefined
    ? { projectsDir: options.projectsDir } : {});
  if (located === null || !located.moved || located.cwd === meta.cwd) return meta;
  if (located.cwd === null || !isDirectory(located.cwd)) {
    const stat = statOrNull(located.path);
    if (stat !== null) {
      if (unfixable.size >= 1_000) unfixable.clear();
      unfixable.set(memoKey, { path: located.path, size: stat.size, mtimeMs: stat.mtimeMs, checkedAtMs: Date.now() });
    }
    return meta;
  }
  const updated: SessionMeta = { ...meta, cwd: located.cwd };
  try {
    store.put(updated);
    options.log?.(`会話ログの移動に合わせて作業フォルダの記録を直しました session=${meta.name} ${meta.cwd} → ${located.cwd}`);
  } catch (error) {
    options.log?.(`作業フォルダの記録を直せませんでした session=${meta.name}: ${String(error)}`);
    return meta;
  }
  return updated;
}

export type MoveClaudeTranscriptResult =
  | { status: "moved"; path: string }
  /** 会話ログがまだ無い（1 回も発話していない）。移すものが無い。 */
  | { status: "absent" }
  /** 既に移動先の slug にある（移動先と同じ slug のフォルダを含む）。relocated 行だけ書き足した。 */
  | { status: "in_place"; path: string }
  | { status: "conflict"; path: string }
  | { status: "failed"; error: string };

/**
 * Claude が動いていない会話の会話ログ（と付帯フォルダ `<slug>/<id>/`）を `toCwd` の slug へ移し、Claude の `/cd`
 * と同じ `relocated` 行を書き足す（Claude Code 本体と Tailii の一覧が、ログだけを見て今のフォルダを判定できるように）。
 * 呼び出し側は会話を掴んでいる Claude が無いことを確かめてから呼ぶ（動いている Claude は元の場所へ書き続ける）。
 */
export function moveClaudeTranscript(options: {
  conversationId: string;
  toCwd: string;
  /** 記録上の cwd（探す手がかり）。 */
  fromCwd?: string | null;
  projectsDir?: string;
  /** relocated 行を書き足さない（テスト・旧来の救済と同じ動き）。 */
  skipRelocatedRecord?: boolean;
}): MoveClaudeTranscriptResult {
  const { conversationId, toCwd } = options;
  if (!safeConversationId(conversationId)) return { status: "failed", error: "会話 id が不正です" };
  const projectsDir = options.projectsDir ?? defaultClaudeProjectsDir();
  const located = locateClaudeTranscript(conversationId, options.fromCwd ?? null, { projectsDir });
  if (located === null) return { status: "absent" };
  const destDir = path.join(projectsDir, claudeProjectSlug(toCwd));
  const dest = path.join(destDir, `${conversationId}.jsonl`);
  const appendRelocated = (file: string): void => {
    if (options.skipRelocatedRecord === true) return;
    const record = JSON.stringify({ type: "relocated", sessionId: conversationId, relocatedCwd: canonicalPath(toCwd) });
    fs.appendFileSync(file, `${needsLeadingNewline(file) ? "\n" : ""}${record}\n`);
  };
  if (located.path === dest) {
    // 既に会話ログ自身がこのフォルダを指していれば何も書かない（救済のたびに行を増やさない）。
    const current = claudeTranscriptCwd(dest);
    if (current !== null && canonicalPath(current) === canonicalPath(toCwd)) return { status: "in_place", path: dest };
    try {
      appendRelocated(dest);
    } catch (error) {
      return { status: "failed", error: String(error) };
    }
    return { status: "in_place", path: dest };
  }
  if (fs.existsSync(dest)) return { status: "conflict", path: dest };
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(located.path, dest);
  } catch (error) {
    return { status: "failed", error: String(error) };
  }
  // 付帯フォルダ（サブエージェントの記録・大きなツール結果・/rewind のスナップショット等）も同居させる。
  const srcAssets = located.path.slice(0, -".jsonl".length);
  const destAssets = path.join(destDir, conversationId);
  try {
    if (fs.existsSync(srcAssets) && !fs.existsSync(destAssets)) fs.renameSync(srcAssets, destAssets);
  } catch {
    // 付帯フォルダの移設失敗は無視する（会話ログ本体が正）。
  }
  try {
    appendRelocated(dest);
  } catch {
    // 書き足せなくても移動はできている（Tailii の記録が今のフォルダを持つ）。
  }
  return { status: "moved", path: dest };
}

/** 最後の行が改行で終わっていない（書きかけ）なら、新しい行の前に改行を足す。 */
function needsLeadingNewline(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}
