// codexSessionStore.ts
// tailii (TS host) — codex（OpenAI Codex CLI）のマシン内会話一覧の導出（agent-tag / codex-sessions）
//
// claude の ClaudeSessionStore に対応する codex 版。`ClaudeSessionStore` が
// `~/.claude/projects/**.jsonl` を列挙するのに対し、codex は 2 ソースを突合する:
//   1. `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` の先頭 `session_meta` 行 → { id, cwd, timestamp }
//   2. `~/.codex/session_index.jsonl` の各行 → { id, thread_name(=タイトル), updated_at }
// session UUID(id) をキーに結合し、`ClaudeSessionInfo`（agent:"codex"）へ落として updatedAt 降順で返す。
//
// タイトルは session_index の thread_name を優先。無ければ rollout 先頭付近の最初の実ユーザー
// メッセージ（event_msg/user_message の message）から導出する（codex アプリのスレッドタイトルと
// 同じ源。session_index は生成が遅延/欠落することがあり、id 先頭 8 字だとアプリと食い違うため）。
// どちらも取れなければ id 先頭 8 字へフォールバックする。cwd は rollout 側にのみ在る。
// 更新時刻は session_index の updated_at（無ければ rollout ファイル mtime）を Unix 秒で用いる。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeSessionInfo } from "./protocol.js";
import { isInsideBase } from "./paths.js";

/** session_meta 先頭行を読む最大バイト数（先頭 1 行のみ使用。base_instructions を含み得るため広め）。 */
const META_READ_LIMIT_BYTES = 512 * 1024;
/** タイトルの最大長（claude と揃える）。 */
const TITLE_MAX_LENGTH = 60;
/** 走査する rollout の上限（mtime 新しい順）。大量セッション時の I/O 保護。 */
const DEFAULT_MAX_SESSIONS = 200;

/** 既定の codex ホーム（`~/.codex`）。 */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

interface IndexEntry {
  title: string | null;
  updatedAt: number | null;
}

/** codex のマシン内会話一覧を導出する値型サービス（agent-tag）。 */
export class CodexSessionStore {
  private readonly sessionsRoot: string;
  private readonly indexPath: string;
  private readonly maxSessions: number;

  /**
   * @param home codex ホーム（既定 `~/.codex`）。テストは一時 dir を注入する。
   * @param maxSessions 走査上限（既定 200、mtime 新しい順）。
   */
  constructor(home?: string, maxSessions: number = DEFAULT_MAX_SESSIONS) {
    const base = home ?? defaultCodexHome();
    this.sessionsRoot = path.join(base, "sessions");
    this.indexPath = path.join(base, "session_index.jsonl");
    this.maxSessions = maxSessions;
  }

  /**
   * codex 会話一覧を updatedAt 降順で返す（同値は sessionId 昇順で安定化）。
   * `baseDir` 指定時は cwd が baseDir 自身/配下の会話のみに絞る（engine は無指定で呼ぶ）。
   */
  list(baseDir?: string): ClaudeSessionInfo[] {
    const index = this.readIndex();
    const files = this.listRollouts()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, this.maxSessions);

    let result: ClaudeSessionInfo[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const meta = readSessionMeta(file.path);
      if (meta === null || meta.cwd === null) continue;
      const sessionId = meta.id ?? path.basename(file.path);
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);

      const idx = meta.id !== null ? index.get(meta.id) : undefined;
      // thread_name が無ければ最初の実ユーザー発話からタイトルを作る（codex アプリ準拠）。
      // それも取れなければ id 先頭 8 字。index にある会話は毎回のファイル走査を避けて thread_name を使う。
      const title = idx?.title ?? readFirstUserMessage(file.path) ?? sessionId.slice(0, 8);
      const updatedAt =
        idx?.updatedAt ?? (file.mtimeMs > 0 ? Math.floor(file.mtimeMs / 1000) : undefined);

      const info: ClaudeSessionInfo = {
        sessionId,
        cwd: meta.cwd,
        title,
        agent: "codex",
      };
      if (updatedAt !== undefined) info.updatedAt = updatedAt;
      result.push(info);
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

  /** `session_index.jsonl` を id → { title, updatedAt(秒) } に読む（無ければ空マップ）。 */
  private readIndex(): Map<string, IndexEntry> {
    const map = new Map<string, IndexEntry>();
    let content: string;
    try {
      content = fs.readFileSync(this.indexPath, "utf8");
    } catch {
      return map;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj !== "object" || obj === null) continue;
      const rec = obj as Record<string, unknown>;
      const id = rec["id"];
      if (typeof id !== "string" || id.length === 0) continue;
      let title: string | null = null;
      if (typeof rec["thread_name"] === "string" && rec["thread_name"].length > 0) {
        title = normalizeTitle(rec["thread_name"]);
      }
      let updatedAt: number | null = null;
      if (typeof rec["updated_at"] === "string") {
        const ms = Date.parse(rec["updated_at"]);
        if (!Number.isNaN(ms)) updatedAt = Math.floor(ms / 1000);
      }
      map.set(id, { title, updatedAt });
    }
    return map;
  }

  /** rollout ファイル（`rollout-*.jsonl`）を再帰列挙する（path + mtimeMs）。 */
  private listRollouts(): { path: string; mtimeMs: number }[] {
    const out: { path: string; mtimeMs: number }[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-")) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(p).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          out.push({ path: p, mtimeMs });
        }
      }
    };
    walk(this.sessionsRoot);
    return out;
  }
}

/** rollout の先頭 `session_meta` 行から { id, cwd, timestamp } を読む。読めなければ null。 */
function readSessionMeta(
  rolloutPath: string,
): { id: string | null; cwd: string | null; timestamp: string | null } | null {
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(META_READ_LIMIT_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    const slice = buf.subarray(0, bytesRead);
    const nl = slice.indexOf(0x0a);
    const firstLine = (nl >= 0 ? slice.subarray(0, nl) : slice).toString("utf8");
    const parsed = JSON.parse(firstLine) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== "session_meta"
    ) {
      return null;
    }
    const payload = (parsed as { payload?: unknown }).payload;
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const id = typeof p["id"] === "string" && p["id"].length > 0 ? (p["id"] as string) : null;
    const cwd = typeof p["cwd"] === "string" && p["cwd"].length > 0 ? (p["cwd"] as string) : null;
    const timestamp = typeof p["timestamp"] === "string" ? (p["timestamp"] as string) : null;
    return { id, cwd, timestamp };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // close 失敗は無視。
    }
  }
}

/**
 * rollout 先頭付近から最初の `event_msg` / `user_message` の message を読み、タイトル整形して返す。
 *
 * codex アプリはスレッドタイトルを最初のユーザー発話から作る。`user_message` イベントは
 * 環境コンテキスト/AGENTS.md 等の注入を含まない「素のユーザー入力」なので、これをそのまま使える
 * （`response_item/message/user` は注入込みなので使わない）。先頭 512KB のみ走査し、見つからなければ null。
 */
function readFirstUserMessage(rolloutPath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(META_READ_LIMIT_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    const text = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      // 早期スキップ（大半の行は user_message を含まない）。末尾行は途中で切れ得るが
      // その場合 JSON.parse が失敗して安全にスキップされる。
      if (!line || !line.includes("user_message")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj !== "object" || obj === null) continue;
      if ((obj as { type?: unknown }).type !== "event_msg") continue;
      const payload = (obj as { payload?: unknown }).payload;
      if (typeof payload !== "object" || payload === null) continue;
      const pl = payload as Record<string, unknown>;
      if (pl["type"] !== "user_message") continue;
      const message = pl["message"];
      if (typeof message === "string" && message.trim().length > 0) {
        return normalizeTitle(message);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // close 失敗は無視。
    }
  }
}

/** タイトルを 1 行・先頭 ~60 字へ整形する。 */
function normalizeTitle(raw: string): string {
  let text = raw.replaceAll("\n", " ").replaceAll("\r", " ").trim();
  if (text.length > TITLE_MAX_LENGTH) text = text.slice(0, TITLE_MAX_LENGTH);
  return text;
}
