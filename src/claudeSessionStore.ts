// claudeSessionStore.ts
// tailii (TS host) — Claude Code のマシン内会話一覧の導出（claude-sessions）
// Swift 版 ClaudeSessionStore.swift の移植。
// `~/.claude/projects/<slug>/<uuid>.jsonl` を列挙し、各 jsonl の先頭チャンクから
// ClaudeSessionInfo（sessionId / cwd / title / updatedAt）を導出して updatedAt 降順で返す。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeSessionInfo } from "./protocol.js";
import { isInsideBase } from "./paths.js";

/** タイトル抽出の最大長（先頭 ~60 字）。 */
const TITLE_MAX_LENGTH = 60;
/** cwd/title を探すためにスキャンする最大行数。 */
const SCAN_LINE_CAP = 400;
/** jsonl から先頭を読む最大バイト数（1 ファイル数十MBになり得るため全読みを避ける）。 */
const HEAD_BYTES_CAP = 256 * 1024;
/** 最終会話時刻の後方スキャンの1回分の読み幅。 */
const TAIL_CHUNK_BYTES = 16 * 1024;
/** 最終会話時刻の後方スキャンの上限バイト数（超巨大な無タイムスタンプ行への保険）。 */
const TAIL_BYTES_CAP = 256 * 1024;

/** slug（`/`→`-` 置換済み）から cwd を復元する（lossy フォールバック）。 */
export function cwdFromSlug(slug: string): string {
  const replaced = slug.replaceAll("-", "/");
  return replaced.length === 0 ? "/" : replaced;
}

/** Claude Code のマシン内会話一覧を導出する値型サービス。 */
export class ClaudeSessionStore {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(os.homedir(), ".claude", "projects");
  }

  /** 指定会話 ID の jsonl パスを projects root から探す。見つからない場合は null。 */
  transcriptPath(sessionId: string): string | null {
    let slugs: string[];
    try {
      slugs = fs.readdirSync(this.root);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const candidate = path.join(this.root, slug, `${sessionId}.jsonl`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 読めない slug は無視する。
      }
    }
    return null;
  }

  /**
   * 会話一覧を updatedAt 降順で返す（nil は末尾、同値は sessionId 昇順で安定化）。
   * `baseDir` 指定時は cwd が baseDir 自身/配下の会話のみに絞る（engine は無指定で呼ぶ）。
   */
  list(baseDir?: string): ClaudeSessionInfo[] {
    let slugs: string[];
    try {
      slugs = fs.readdirSync(this.root);
    } catch {
      return [];
    }

    let result: ClaudeSessionInfo[] = [];
    for (const slug of slugs) {
      const slugDir = path.join(this.root, slug);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(slugDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let files: string[];
      try {
        files = fs.readdirSync(slugDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -".jsonl".length);
        if (!sessionId) continue;
        result.push(deriveInfo(path.join(slugDir, file), sessionId, slug));
      }
    }

    if (baseDir) {
      result = result.filter((info) => isInsideBase(info.cwd, baseDir));
    }

    return result.sort((lhs, rhs) => {
      const l = lhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      const r = rhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      if (l !== r) return r - l;
      return lhs.sessionId < rhs.sessionId ? -1 : lhs.sessionId > rhs.sessionId ? 1 : 0;
    });
  }
}

/**
 * transcript の「最終会話時刻」（Unix 秒）を末尾から後方スキャンで解決する。
 * 権威はエントリ自身の `timestamp` フィールド（user/assistant/system 行が持つ）。
 * ファイル mtime は使わない: `claude --resume` は開くだけで `mode`/`last-prompt` 等の
 * タイムスタンプ無し状態行を追記して mtime を進めるため、mtime を順位に使うと
 * 「開いただけの会話」が実会話より上に浮く（2026-07-08 ユーザー報告の根治）。
 * - 全体を読み切って timestamp 行が無い = 状態行のみ（会話なし）→ null（最下位へ）
 * - 上限まで読んでも見つからない（巨大な無 timestamp 行）→ mtime へ保守的にフォールバック
 */
export function lastConversationTimestamp(filePath: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const maxSpan = Math.min(size, TAIL_BYTES_CAP);
    let span = 0;
    while (span < maxSpan) {
      span = Math.min(span + TAIL_CHUNK_BYTES, maxSpan);
      const buf = Buffer.alloc(span);
      const bytesRead = fs.readSync(fd, buf, 0, span, size - span);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
      // 途中から読んだ場合、先頭要素は行の途中で切れている可能性があるため捨てる。
      const first = span < size ? 1 : 0;
      for (let i = lines.length - 1; i >= first; i--) {
        const ts = parseEntryTimestamp(lines[i] ?? "");
        if (ts !== null) return ts;
      }
      if (span >= size) return null; // 全読みして無し = 会話エントリなし
    }
    // 上限到達: timestamp 不明だが中身はある。mtime で近似する。
    return Math.floor(fs.fstatSync(fd).mtimeMs / 1000);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** jsonl 1 行の トップレベル `timestamp`（ISO 文字列）を Unix 秒に読む。無ければ null。 */
function parseEntryTimestamp(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const raw = (obj as Record<string, unknown>)["timestamp"];
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 1 つの jsonl から ClaudeSessionInfo を導出する（先頭 + 末尾チャンクのみ読む）。 */
function deriveInfo(filePath: string, sessionId: string, slug: string): ClaudeSessionInfo {
  const updatedAt = lastConversationTimestamp(filePath) ?? undefined;

  let cwd: string | null = null;
  let title: string | null = null;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES_CAP);
      const bytesRead = fs.readSync(fd, buf, 0, HEAD_BYTES_CAP, 0);
      // 末尾は行の途中で切れ得るが、その行は JSON パースに失敗して skip されるだけで安全。
      const content = buf.subarray(0, bytesRead).toString("utf8");
      let scanned = 0;
      for (const line of content.split("\n")) {
        if (!line) continue;
        if (scanned >= SCAN_LINE_CAP) break;
        scanned += 1;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof obj !== "object" || obj === null) continue;
        const rec = obj as Record<string, unknown>;
        if (cwd === null && typeof rec["cwd"] === "string" && rec["cwd"].length > 0) {
          cwd = rec["cwd"];
        }
        if (title === null && rec["type"] === "user") {
          const t = extractUserText(rec);
          if (t !== null) title = t;
        }
        if (cwd !== null && title !== null) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 読めないファイルはフォールバックのみで返す。
  }

  const info: ClaudeSessionInfo = {
    sessionId,
    cwd: cwd ?? cwdFromSlug(slug),
    title: title ?? sessionId.slice(0, 8),
  };
  if (updatedAt !== undefined) info.updatedAt = updatedAt;
  return info;
}

/** `type=="user"` 行のメッセージ本文を取り出し、先頭 ~60 字へ整形する。 */
function extractUserText(obj: Record<string, unknown>): string | null {
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  let raw: string | null = null;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = firstText(content);
  }
  if (raw === null) return null;
  let text = raw.replaceAll("\n", " ").replaceAll("\r", " ").trim();
  if (!text) return null;
  // slash コマンドのメタ包み（`<command-…>` で始まる）はタイトルに向かないので除外。
  if (text.startsWith("<command-") || text.startsWith("<local-command")) return null;
  if (text.length > TITLE_MAX_LENGTH) text = text.slice(0, TITLE_MAX_LENGTH);
  return text;
}

/** content 配列から最初のテキストを取り出す。 */
function firstText(arr: unknown[]): string | null {
  for (const element of arr) {
    if (typeof element === "string" && element.length > 0) return element;
    if (typeof element === "object" && element !== null) {
      const t = (element as Record<string, unknown>)["text"];
      if (typeof t === "string" && t.length > 0) return t;
    }
  }
  return null;
}
