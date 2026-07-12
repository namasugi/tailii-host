// codexSessionStore.ts
// tailii (TS host) — codex（OpenAI Codex CLI）のマシン内会話一覧の導出（agent-tag / codex-sessions）
//
// claude の ClaudeSessionStore に対応する codex 版。`ClaudeSessionStore` が
// `~/.claude/projects/**.jsonl` を列挙するのに対し、codex は 2 ソースを突合する:
//   1. `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` の先頭 `session_meta` 行 → { id, cwd, timestamp, source }
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
import type { CodexAppServerManager, CodexAppServerThreadInfo } from "./codexAppServer.js";

/** session_meta 先頭行を読む最大バイト数（先頭 1 行のみ使用。base_instructions を含み得るため広め）。 */
const META_READ_LIMIT_BYTES = 512 * 1024;
/** タイトルの最大長（claude と揃える）。 */
const TITLE_MAX_LENGTH = 60;
/** 最終メッセージプレビューの最大長（一覧行の 1 行スニペット。claude の list-preview と揃える）。 */
const LAST_MESSAGE_MAX_LENGTH = 80;
/** 最終メッセージの後方スキャンの 1 回分の読み幅。 */
const TAIL_CHUNK_BYTES = 16 * 1024;
/** 最終メッセージの後方スキャンの上限バイト数（token_count 等が延々続くファイルへの保険）。 */
const TAIL_BYTES_CAP = 256 * 1024;
/** 返す対話セッションの上限（mtime 新しい順）。 */
const DEFAULT_MAX_SESSIONS = 200;

/** 既定の codex ホーム（`~/.codex`）。 */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

interface IndexEntry {
  title: string | null;
  updatedAt: number | null;
}

interface RolloutEntry {
  path: string;
  cwd: string | null;
  isBackgroundSession: boolean;
}

/** codex のマシン内会話一覧を導出する値型サービス（agent-tag）。 */
export class CodexSessionStore {
  private readonly sessionsRoot: string;
  private readonly indexPath: string;
  private readonly maxSessions: number;

  /**
   * @param home codex ホーム（既定 `~/.codex`）。テストは一時 dir を注入する。
   * @param maxSessions 返却上限（既定 200、mtime 新しい順）。
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
    const files = this.listRollouts().sort((a, b) => b.mtimeMs - a.mtimeMs);

    let result: ClaudeSessionInfo[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (result.length >= this.maxSessions) break;
      const meta = readSessionMeta(file.path);
      if (meta === null || meta.cwd === null || meta.isBackgroundSession) continue;
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
      if (baseDir && !isInsideBase(info.cwd, baseDir)) continue;
      const lastMessage = readLastRolloutMessage(file.path);
      if (lastMessage !== null) info.lastMessage = lastMessage;
      result.push(info);
    }

    return result.sort((lhs, rhs) => {
      const l = lhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      const r = rhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      if (l !== r) return r - l;
      return lhs.sessionId < rhs.sessionId ? -1 : lhs.sessionId > rhs.sessionId ? 1 : 0;
    });
  }

  /**
   * 稼働中の App Server を権威に一覧を返す。不達・停止中・不正応答は rollout 一覧へ完全に戻す。
   * この経路は App Server を起動しない。
   */
  async listWithAppServer(
    appServer: Pick<CodexAppServerManager, "listThreads">,
    baseDir?: string,
  ): Promise<ClaudeSessionInfo[]> {
    try {
      const threads = await appServer.listThreads(this.maxSessions);
      if (threads === null) return this.list(baseDir);
      return this.mapAppServerThreads(threads, baseDir);
    } catch {
      return this.list(baseDir);
    }
  }

  private mapAppServerThreads(
    threads: readonly CodexAppServerThreadInfo[],
    baseDir?: string,
  ): ClaudeSessionInfo[] {
    const rollouts = this.rolloutsById();
    const result: ClaudeSessionInfo[] = [];
    const seen = new Set<string>();
    for (const thread of threads) {
      if (result.length >= this.maxSessions) break;
      if (seen.has(thread.id) || isBackgroundThread(thread)) continue;
      seen.add(thread.id);

      const rollout = rollouts.get(thread.id);
      if (rollout?.isBackgroundSession === true) continue;
      const cwd = thread.cwd ?? rollout?.cwd ?? null;
      if (cwd === null || (baseDir !== undefined && !isInsideBase(cwd, baseDir))) continue;
      const fallbackTitle = rollout === undefined ? null : readFirstUserMessage(rollout.path);
      const rawTitle = nonEmptyString(thread.name) ?? nonEmptyString(thread.preview);
      const info: ClaudeSessionInfo = {
        sessionId: thread.id,
        cwd,
        title: rawTitle === null ? (fallbackTitle ?? thread.id.slice(0, 8)) : normalizeTitle(rawTitle),
        updatedAt: Math.floor(thread.updatedAt),
        agent: "codex",
      };
      if (rollout !== undefined) {
        const lastMessage = readLastRolloutMessage(rollout.path);
        if (lastMessage !== null) info.lastMessage = lastMessage;
      }
      result.push(info);
    }
    return result.sort(compareSessions);
  }

  private rolloutsById(): Map<string, RolloutEntry> {
    const result = new Map<string, RolloutEntry>();
    const files = this.listRollouts().sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files) {
      const meta = readSessionMeta(file.path);
      if (meta?.id === null || meta === null || result.has(meta.id)) continue;
      result.set(meta.id, {
        path: file.path,
        cwd: meta.cwd,
        isBackgroundSession: meta.isBackgroundSession,
      });
    }
    return result;
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

/** rollout の先頭 `session_meta` 行から会話メタデータを読む。読めなければ null。 */
function readSessionMeta(
  rolloutPath: string,
): {
  id: string | null;
  cwd: string | null;
  timestamp: string | null;
  isBackgroundSession: boolean;
} | null {
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
    const source = p["source"];
    // `exec` は一回限りの非対話ジョブ、object.subagent は親会話から派生した内部スレッド。
    // どちらも Codex の再開可能なユーザー会話一覧には出さない。
    const isBackgroundSession =
      source === "exec" ||
      source === "subagent" ||
      (typeof source === "object" && source !== null && "subagent" in source);
    return { id, cwd, timestamp, isBackgroundSession };
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
  return normalizeSnippet(raw, TITLE_MAX_LENGTH);
}

function nonEmptyString(value: string | null): string | null {
  return value !== null && value.trim().length > 0 ? value : null;
}

function isBackgroundThread(thread: CodexAppServerThreadInfo): boolean {
  if (thread.parentThreadId !== null || thread.source === "exec" || thread.source === "subagent") return true;
  return typeof thread.source === "object" && thread.source !== null && "subAgent" in thread.source;
}

function compareSessions(lhs: ClaudeSessionInfo, rhs: ClaudeSessionInfo): number {
  const l = lhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
  const r = rhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
  if (l !== r) return r - l;
  return lhs.sessionId < rhs.sessionId ? -1 : lhs.sessionId > rhs.sessionId ? 1 : 0;
}

/** 1 行・先頭 maxLength 字へ整形する。 */
function normalizeSnippet(raw: string, maxLength: number): string {
  let text = raw.replaceAll("\n", " ").replaceAll("\r", " ").trim();
  if (text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

/**
 * rollout 末尾から最後の user/agent メッセージ本文を後方スキャンで読む（list-preview）。
 *
 * 対象は `event_msg` の payload.type `user_message` / `agent_message`（どちらも素のテキストを
 * `message` に持つ）。token_count 等のイベント行は自然に skip される。チャンク境界で行が
 * 切れた場合はその行を捨てて次のチャンクで読み直す。上限まで遡って無ければ null。
 */
function readLastRolloutMessage(rolloutPath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
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
        const line = lines[i] ?? "";
        // 早期スキップ（大半の行は対象 payload を含まない）。
        if (!line.includes("user_message") && !line.includes("agent_message")) continue;
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
        if (pl["type"] !== "user_message" && pl["type"] !== "agent_message") continue;
        const message = pl["message"];
        if (typeof message === "string" && message.trim().length > 0) {
          return normalizeSnippet(message, LAST_MESSAGE_MAX_LENGTH);
        }
      }
      if (span >= size) return null;
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
