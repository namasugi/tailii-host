// claudeSessionStore.ts
// tailii (TS host) — Claude Code のマシン内会話一覧の導出（claude-sessions）
// Swift 版 ClaudeSessionStore.swift の移植。
// `~/.claude/projects/<slug>/<uuid>.jsonl` を列挙し、各 jsonl の先頭チャンクから
// ClaudeSessionInfo（sessionId / cwd / title / updatedAt）を導出して updatedAt 降順で返す。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeSessionInfo } from "../protocol.js";
import { isInsideBase } from "../shared/paths.js";
import { isInjectedSkillContent } from "../shared/skillInjection.js";

/** タイトル抽出の最大長（先頭 ~60 字）。 */
const TITLE_MAX_LENGTH = 60;
/** 明示タイトル（custom-title / ai-title）の受け入れ上限（コードポイント数）。 */
const EXPLICIT_TITLE_MAX_LENGTH = 100;
/** 最終メッセージプレビューの最大長（一覧行の 1 行スニペット, list-preview）。 */
const LAST_MESSAGE_MAX_LENGTH = 80;
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

  /**
   * 指定会話 ID の jsonl パスを projects root から探す。見つからない場合は null。
   *
   * 同一 id が複数 slug に在り得る（duplicate-transcript: worktree 削除後の resume で
   * transcript を repo ルートへ移設すると、worktree 側 slug に状態行だけの残骸が残る）。
   * その場合は**会話本体（timestamp 行）を持つ方**を返す。readdir 順の先勝ちだと、
   * 残骸を掴んで検索・タブ名同期・再移設が空振りする。
   */
  transcriptPath(sessionId: string): string | null {
    let slugs: string[];
    try {
      slugs = fs.readdirSync(this.root);
    } catch {
      return null;
    }
    const candidates: string[] = [];
    for (const slug of slugs) {
      const candidate = path.join(this.root, slug, `${sessionId}.jsonl`);
      try {
        if (fs.statSync(candidate).isFile()) candidates.push(candidate);
      } catch {
        // 読めない slug は無視する。
      }
    }
    if (candidates.length <= 1) return candidates[0] ?? null;
    let best: string | null = null;
    let bestUpdatedAt = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      const updatedAt = lastConversationTimestamp(candidate);
      if (updatedAt !== null && updatedAt > bestUpdatedAt) {
        best = candidate;
        bestUpdatedAt = updatedAt;
      }
    }
    return best ?? candidates[0] ?? null;
  }

  /**
   * 会話一覧を updatedAt 降順で返す（nil は末尾、同値は sessionId 昇順で安定化）。
   * `baseDir` 指定時は cwd が baseDir 自身/配下の会話のみに絞る（engine は無指定で呼ぶ）。
   * 同一 sessionId が複数 slug に在る場合は 1 行へ畳む（duplicate-transcript,
   * `transcriptPath` と同じ「会話本体を持つ方が正」の判定）。
   */
  list(baseDir?: string): ClaudeSessionInfo[] {
    let slugs: string[];
    try {
      slugs = fs.readdirSync(this.root);
    } catch {
      return [];
    }

    // 同一 sessionId は 1 行へ畳む。cwd/updatedAt の権威は「会話本体を持つ方」なので、
    // baseDir 絞り込みより **先に** 畳む（残骸の lossy cwd で絞り込ませない）。
    const bySessionId = new Map<string, ClaudeSessionInfo>();
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
        const info = deriveInfo(path.join(slugDir, file), sessionId, slug);
        const existing = bySessionId.get(sessionId);
        bySessionId.set(sessionId, existing === undefined ? info : richerInfo(existing, info));
      }
    }

    let result: ClaudeSessionInfo[] = [...bySessionId.values()];
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
  return scanTranscriptTail(filePath).updatedAt;
}

/**
 * transcript 内の明示タイトルエントリの観測結果。
 * `custom-title` は CLI の `/rename` / hook の sessionTitle 出力、`ai-title` は
 * CLI 内蔵の AI タイトル生成（公式アプリ/IDE 接続時に発火）が書く。
 * undefined = 未出現 / null = 解除（空文字エントリ）/ string = 設定値。
 */
export interface TranscriptTitleEntries {
  customTitle?: string | null;
  aiTitle?: string | null;
}

/** 末尾後方スキャンの結果（最終会話時刻 + 最終メッセージのスニペット + 明示タイトル）。 */
export interface TranscriptTailSummary extends TranscriptTitleEntries {
  updatedAt: number | null;
  lastMessage: string | null;
}

/**
 * transcript 末尾の後方スキャンを 1 パスで行い、最終会話時刻と
 * 最終 user/assistant メッセージ本文（先頭 ~80 字, list-preview）をまとめて返す。
 * updatedAt の解決規則は `lastConversationTimestamp` の docstring の通り。
 * lastMessage はテキストを持つ最後の user/assistant 行から取る（tool_result/thinking
 * のみの行はテキスト抽出に失敗して自然に skip される）。見つからなければ null。
 */
export function scanTranscriptTail(filePath: string): TranscriptTailSummary {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return { updatedAt: null, lastMessage: null };
  }
  let updatedAt: number | null = null;
  let lastMessage: string | null = null;
  const titles: TranscriptTitleEntries = {};
  const summary = (): TranscriptTailSummary => ({ updatedAt, lastMessage, ...titles });
  try {
    const size = fs.fstatSync(fd).size;
    const maxSpan = Math.min(size, TAIL_BYTES_CAP);
    let span = 0;
    let scannedAll = false;
    let done = false;
    while (!done && span < maxSpan) {
      span = Math.min(span + TAIL_CHUNK_BYTES, maxSpan);
      const buf = Buffer.alloc(span);
      const bytesRead = fs.readSync(fd, buf, 0, span, size - span);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
      // 途中から読んだ場合、先頭要素は行の途中で切れている可能性があるため捨てる。
      const first = span < size ? 1 : 0;
      for (let i = lines.length - 1; i >= first; i--) {
        const rec = parseEntry(lines[i] ?? "");
        if (rec === null) continue;
        // 後方スキャンなので最初に出会ったタイトルエントリ = ファイル内で最新。
        if (titles.customTitle === undefined && rec["type"] === "custom-title") {
          titles.customTitle = normalizeExplicitTitle(rec["customTitle"]);
        }
        if (titles.aiTitle === undefined && rec["type"] === "ai-title") {
          titles.aiTitle = normalizeExplicitTitle(rec["aiTitle"]);
        }
        if (updatedAt === null) updatedAt = entryTimestamp(rec);
        if (lastMessage === null && (rec["type"] === "user" || rec["type"] === "assistant")) {
          lastMessage = extractMessageText(rec, LAST_MESSAGE_MAX_LENGTH);
        }
        if (updatedAt !== null && lastMessage !== null) {
          done = true;
          break;
        }
      }
      // 全読みして timestamp 無し = 会話エントリなし（状態行のみ）。
      if (span >= size) {
        scannedAll = true;
        break;
      }
    }
    // 上限到達（未 done）: timestamp 不明だが中身はある。mtime で近似する。
    if (!done && !scannedAll && updatedAt === null) {
      updatedAt = Math.floor(fs.fstatSync(fd).mtimeMs / 1000);
    }
    // タイトル専用の深掘り: updatedAt/lastMessage は末尾数行で即確定して打ち切るため、
    // CLI が定期再フラッシュするタイトルエントリ（custom-title/ai-title）がその少し上に
    // あると取りこぼす。窓内（TAIL_BYTES_CAP）全体を substring 前置フィルタで走査して補完する。
    if (!scannedAll && (titles.customTitle === undefined || titles.aiTitle === undefined)) {
      scanTailTitleCheckpoints(fd, size, titles);
    }
    return summary();
  } catch {
    return summary();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 末尾窓（TAIL_BYTES_CAP）全体からタイトルエントリだけを後方走査で補完する。
 * JSON.parse は候補行（substring 一致）に限定し、走査コストを読み取り + split に抑える。
 * 既に確定している種別（undefined でない）は上書きしない = 最新優先を保つ。
 */
function scanTailTitleCheckpoints(fd: number, size: number, titles: TranscriptTitleEntries): void {
  const span = Math.min(size, TAIL_BYTES_CAP);
  if (span <= 0) return;
  let bytesRead: number;
  const buf = Buffer.alloc(span);
  try {
    bytesRead = fs.readSync(fd, buf, 0, span, size - span);
  } catch {
    return;
  }
  const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
  const first = span < size ? 1 : 0;
  for (let i = lines.length - 1; i >= first; i--) {
    if (titles.customTitle !== undefined && titles.aiTitle !== undefined) return;
    const line = lines[i] ?? "";
    const wantsCustom = titles.customTitle === undefined && line.includes('"type":"custom-title"');
    const wantsAi = titles.aiTitle === undefined && line.includes('"type":"ai-title"');
    if (!wantsCustom && !wantsAi) continue;
    const rec = parseEntry(line);
    if (rec === null) continue;
    if (titles.customTitle === undefined && rec["type"] === "custom-title") {
      titles.customTitle = normalizeExplicitTitle(rec["customTitle"]);
    }
    if (titles.aiTitle === undefined && rec["type"] === "ai-title") {
      titles.aiTitle = normalizeExplicitTitle(rec["aiTitle"]);
    }
  }
}

/** jsonl 1 行をオブジェクトへパースする。空行/非 JSON/非オブジェクトは null。 */
function parseEntry(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  return obj as Record<string, unknown>;
}

/** エントリのトップレベル `timestamp`（ISO 文字列）を Unix 秒に読む。無ければ null。 */
function entryTimestamp(rec: Record<string, unknown>): number | null {
  const raw = rec["timestamp"];
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 先頭チャンクスキャンの結果（cwd と会話タイトル + 明示タイトル）。 */
export interface TranscriptHeadSummary extends TranscriptTitleEntries {
  cwd: string | null;
  title: string | null;
}

/**
 * transcript 先頭チャンクから cwd と会話タイトル（最初のユーザー発話 先頭 ~60 字）を読む。
 * 一覧の title 導出と herdr タブ名の自動タイトル同期（session-title）が共用する。
 */
export function scanTranscriptHead(filePath: string): TranscriptHeadSummary {
  let cwd: string | null = null;
  let title: string | null = null;
  const titles: TranscriptTitleEntries = {};
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
        // 前方スキャンなので後勝ち = チャンク内で最新のタイトルエントリを採る。
        // resume 時は CLI が復元メタデータとして新ファイル先頭へ書き直すためここで拾える。
        if (rec["type"] === "custom-title") {
          titles.customTitle = normalizeExplicitTitle(rec["customTitle"]);
        }
        if (rec["type"] === "ai-title") {
          titles.aiTitle = normalizeExplicitTitle(rec["aiTitle"]);
        }
        if (title === null && rec["type"] === "user") {
          const t = extractUserText(rec);
          if (t !== null) title = t;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 読めないファイルは null/null を返す（呼び出し側がフォールバック）。
  }
  return { cwd, title, ...titles };
}

/**
 * 同一 sessionId の 2 行から一覧に残す方を選ぶ（duplicate-transcript）。
 *
 * 会話本体（timestamp を持つ行）がある方が正。両方あれば新しい方、どちらも無ければ
 * 最終メッセージを持つ方 → 先に見つけた方（readdir 順で安定）。
 */
function richerInfo(lhs: ClaudeSessionInfo, rhs: ClaudeSessionInfo): ClaudeSessionInfo {
  const l = lhs.updatedAt;
  const r = rhs.updatedAt;
  if (l !== undefined && r !== undefined) return r > l ? rhs : lhs;
  if (l !== undefined || r !== undefined) return l !== undefined ? lhs : rhs;
  if ((lhs.lastMessage !== undefined) !== (rhs.lastMessage !== undefined)) {
    return lhs.lastMessage !== undefined ? lhs : rhs;
  }
  return lhs;
}

/** 1 つの jsonl から ClaudeSessionInfo を導出する（先頭 + 末尾チャンクのみ読む）。 */
function deriveInfo(filePath: string, sessionId: string, slug: string): ClaudeSessionInfo {
  const tail = scanTranscriptTail(filePath);
  const updatedAt = tail.updatedAt ?? undefined;
  const head = scanTranscriptHead(filePath);

  // 明示タイトル（custom-title / ai-title）が既に書かれたかを iOS へ伝える（title-refresh）。
  // 新規会話の実体化直後は transcript がまだ無い / 最初のユーザー発話しか無いため、iOS は
  // このフラグが立つまでタイトルを取り直す（立たないまま打ち切ると発話そのままの仮タイトルで
  // 固定され、一覧へ戻って開き直すまで AI タイトルへ更新されない）。
  const explicitTitle = resolveExplicitTitle(head, tail);
  const info: ClaudeSessionInfo = {
    sessionId,
    cwd: head.cwd ?? cwdFromSlug(slug),
    title: explicitTitle ?? head.title ?? sessionId.slice(0, 8),
    hasProviderTitle: explicitTitle !== null,
  };
  if (updatedAt !== undefined) info.updatedAt = updatedAt;
  if (tail.lastMessage !== null) info.lastMessage = tail.lastMessage;
  return info;
}

/**
 * 明示タイトル（custom-title / ai-title エントリ）を解決する。
 * 末尾チャンクの観測はファイル内でより新しいため先頭チャンクより優先し、
 * custom-title（/rename・hook 由来）を ai-title より優先する。
 * custom-title が解除（null）の場合は ai-title へフォールバックする。
 * どちらの窓にも無ければ null（呼び出し側が従来の導出へフォールバック）。
 */
export function resolveExplicitTitle(
  head: TranscriptTitleEntries,
  tail: TranscriptTitleEntries,
): string | null {
  const custom = tail.customTitle !== undefined ? tail.customTitle : head.customTitle;
  if (typeof custom === "string") return custom;
  const ai = tail.aiTitle !== undefined ? tail.aiTitle : head.aiTitle;
  return typeof ai === "string" ? ai : null;
}

/**
 * 会話タイトルを 1 発で解決する（明示タイトル優先 → 最初のユーザー発話 → null）。
 * herdr タブ名の自動タイトル同期など、一覧以外の呼び出し側が使う。
 */
export function transcriptTitle(filePath: string): string | null {
  const head = scanTranscriptHead(filePath);
  const tail = scanTranscriptTail(filePath);
  return resolveExplicitTitle(head, tail) ?? head.title;
}

/**
 * タイトルエントリの値を正規化する: 制御文字除去 + trim + 上限。
 * 空になったら null（= タイトル解除エントリ）。文字列以外も null。
 */
function normalizeExplicitTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!text) return null;
  return [...text].slice(0, EXPLICIT_TITLE_MAX_LENGTH).join("");
}

/** `type=="user"` 行のメッセージ本文を取り出し、先頭 ~60 字へ整形する（タイトル用）。 */
function extractUserText(obj: Record<string, unknown>): string | null {
  return extractMessageText(obj, TITLE_MAX_LENGTH);
}

/** user/assistant 行のメッセージ本文テキストを取り出し、先頭 maxLength 字へ整形する。 */
function extractMessageText(obj: Record<string, unknown>, maxLength: number): string | null {
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
  // slash コマンドのメタ包み（`<command-…>` で始まる）は提示に向かないので除外。
  if (text.startsWith("<command-") || text.startsWith("<local-command")) return null;
  // シェルモード（`!cmd`）の記録。実行行はタイトル/プレビューに使えるので `!cmd` へ
  // 戻し、出力側（stdout/stderr）は提示に向かないので除外する。
  if (text.startsWith("<bash-stdout>") || text.startsWith("<bash-stderr>")) return null;
  if (text.startsWith("<bash-input>")) {
    const command = text.slice("<bash-input>".length).replace(/<\/bash-input>[\s\S]*$/u, "").trim();
    if (!command) return null;
    text = `!${command}`;
  }
  // スキル実行時に注入される展開済み SKILL.md 本文も提示しない（前の実発話へ遡る）。
  if (isInjectedSkillContent(obj, raw)) return null;
  if (text.length > maxLength) text = text.slice(0, maxLength);
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
