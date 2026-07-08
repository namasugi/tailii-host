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

/** 1 つの jsonl から ClaudeSessionInfo を導出する（先頭チャンクのみ読む）。 */
function deriveInfo(filePath: string, sessionId: string, slug: string): ClaudeSessionInfo {
  let updatedAt: number | undefined;
  try {
    updatedAt = Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  } catch {
    updatedAt = undefined;
  }

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
