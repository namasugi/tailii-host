// codexSessionStore.ts
// tailii (TS host) — codex（OpenAI Codex CLI）のマシン内会話一覧の導出（agent-tag / codex-sessions）
//
// claude の ClaudeSessionStore に対応する codex 版。`ClaudeSessionStore` が
// `~/.claude/projects/**.jsonl` を列挙するのに対し、codex は 2 ソースを突合する:
//   1. `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（古い会話は Codex が圧縮した `rollout-*.jsonl.zst`）の
//      先頭 `session_meta` 行 → { id, cwd, timestamp, source }
//   2. `~/.codex/session_index.jsonl` の各行 → { id, thread_name(=タイトル), updated_at }
// session UUID(id) をキーに結合し、`ClaudeSessionInfo`（agent:"codex"）へ落として updatedAt 降順で返す。
//
// タイトルは session_index の thread_name を優先。無ければ rollout 先頭付近の最初の実ユーザー
// メッセージ（event_msg/user_message の message）から導出する（codex アプリのスレッドタイトルと
// 同じ源。session_index は生成が遅延/欠落することがあり、id 先頭 8 字だとアプリと食い違うため）。
// どちらも取れなければ id 先頭 8 字へフォールバックする。cwd は rollout 側にのみ在る。
// 更新時刻は rollout ファイルの mtime（Codex App Server の updatedAt と同じ値。取れなければ session_index の
// updated_at）を Unix 秒で用いる。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ClaudeSessionInfo } from "../protocol.js";
import { isInsideBase, standardize } from "../shared/paths.js";
import { mapConcurrent } from "../sessions/mapConcurrent.js";
import { noteReadFailure, readFailureCount } from "../shared/readFailures.js";
import type { ListMemoFile } from "../sessions/listMemoFile.js";
import { isVisibleCodexMessagePhase } from "./codexMessagePhase.js";
import { isCompressedRollout, isRolloutFileName, readCompressedRollout, readRolloutHead } from "./rolloutFile.js";

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
/**
 * 返す対話セッションの上限（mtime 新しい順）。既定は上限なし（Claude の会話一覧と同じ）。
 * 以前は 200 件で切っていたため、取得元を Codex に絞ると古い会話が出なかった。
 */
const DEFAULT_MAX_SESSIONS = Number.POSITIVE_INFINITY;
/**
 * 圧縮 rollout の末尾を読むために解凍する上限（解凍後のバイト数）。超える巨大な会話は
 * 最終メッセージのプレビューを出さない（題名・更新時刻は先頭とファイル情報から出る）。
 */
const COMPRESSED_TAIL_DECOMPRESS_LIMIT_BYTES = 32 * 1024 * 1024;

/** 既定の codex ホーム（`~/.codex`）。 */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

interface IndexEntry {
  /** 索引の正式名（一覧表示用の短縮は読み出し側で行う）。 */
  title: string | null;
  updatedAt: number | null;
}

/** 列挙した rollout 1 本（size は stat 失敗で -1）。 */
interface RolloutFile {
  path: string;
  mtimeMs: number;
  size: number;
}

interface RolloutDirectory {
  mtimeMs: number;
  ctimeMs: number;
  entries: fs.Dirent[];
}

interface ActivityRow {
  cwd: string;
  updatedAt: number | undefined;
}

/** rollout 1 本分の読み取り結果のメモ（undefined = まだ読んでいない, session-list-memo）。 */
interface RolloutMemo {
  mtimeMs: number;
  size: number;
  meta?: ReturnType<typeof readSessionMeta>;
  firstUserMessage?: string | null;
  lastMessage?: string | null;
  /** ユーザーの発話行が 1 行でもあるか（無い会話は App Server の一覧にも出ない）。 */
  hasUserTurn?: boolean;
}

/** 保存ファイルから読んだ値がメモとして使えるか（壊れた・古い形の値は読み直させる）。 */
function isRolloutMemo(value: unknown): value is RolloutMemo {
  if (typeof value !== "object" || value === null) return false;
  const memo = value as Record<string, unknown>;
  if (typeof memo["mtimeMs"] !== "number" || typeof memo["size"] !== "number") return false;
  const isOptionalText = (field: unknown): boolean =>
    field === undefined || field === null || typeof field === "string";
  if (!isOptionalText(memo["firstUserMessage"]) || !isOptionalText(memo["lastMessage"])) return false;
  if (memo["hasUserTurn"] !== undefined && typeof memo["hasUserTurn"] !== "boolean") return false;
  const meta = memo["meta"];
  if (meta === undefined || meta === null) return true;
  if (typeof meta !== "object") return false;
  const fields = meta as Record<string, unknown>;
  return (fields["id"] === null || typeof fields["id"] === "string")
    && (fields["cwd"] === null || typeof fields["cwd"] === "string")
    && (fields["timestamp"] === null || typeof fields["timestamp"] === "string")
    && typeof fields["isBackgroundSession"] === "boolean";
}

/** codex のマシン内会話一覧を導出する値型サービス（agent-tag）。 */
export class CodexSessionStore {
  private readonly sessionsRoot: string;
  private readonly indexPath: string;
  private readonly maxSessions: number;
  private readonly transcriptPaths = new Map<string, string>();
  /**
   * rollout 1 本分の読み取り結果（key = パス, 照合 = mtimeMs + size, session-list-memo）。
   * 一覧のたびに数百本の先頭・最初の発話・末尾を同期で読み直すと engine のイベントループを
   * 数秒止めていた。中身が変わらないファイルは前回の結果を使う。列挙に無かったパスは捨てる。
   */
  private readonly rolloutMemo = new Map<string, RolloutMemo>();
  /** `rolloutMemo` の保存先（engine だけが渡す。次の engine の最初の一覧へ引き継ぐ, session-list-memo-persist）。 */
  private readonly memoFile: ListMemoFile | null;
  private memoFileLoaded = false;
  /** 前回の書き出しから `rolloutMemo` が変わったか。 */
  private memoDirty = false;
  /** ディレクトリの内容だけ再利用する。対象ファイルの mtime は要求ごとに必ず読み直す。 */
  private readonly rolloutDirectories = new Map<string, RolloutDirectory>();
  private readingActivity: { cwds: Set<string>; started: boolean; promise: Promise<ActivityRow[]> } | null = null;

  /**
   * @param home codex ホーム（既定 `~/.codex`）。テストは一時 dir を注入する。
   * @param maxSessions 返却上限（既定は上限なし、mtime 新しい順）。
   * @param options.memoFile 読み取りメモの保存先（engine だけが渡す）。
   */
  constructor(
    home?: string,
    maxSessions: number = DEFAULT_MAX_SESSIONS,
    options: { memoFile?: ListMemoFile } = {},
  ) {
    const base = home ?? defaultCodexHome();
    this.sessionsRoot = path.join(base, "sessions");
    this.indexPath = path.join(base, "session_index.jsonl");
    this.maxSessions = maxSessions;
    this.memoFile = options.memoFile ?? null;
  }

  /** 本文検索では一覧の上限（テストで指定したとき）より古い対話も列挙する。 */
  listForSearch(): ClaudeSessionInfo[] {
    return this.list(undefined, Number.POSITIVE_INFINITY);
  }

  /** 直前の列挙で解決したパス（検索側は非同期読取の前にパスを取得する）。 */
  transcriptPath(sessionId: string): string | null {
    return this.transcriptPaths.get(sessionId) ?? null;
  }

  /**
   * 稼働一覧用の cwd 近似。並行した cwd の問い合わせを 1 回の列挙へまとめ、タイトル・
   * プレビューを作らない。列挙内容は list() と共有するが、stat の結果を次の要求へ持ち越さない。
   */
  async latestActivity(cwd: string): Promise<number | null> {
    const normalized = standardize(cwd);
    if (this.readingActivity?.started && !this.readingActivity.cwds.has(normalized)) {
      await this.readingActivity.promise;
      return this.latestActivity(cwd);
    }
    if (this.readingActivity === null) {
      const cwds = new Set<string>();
      const pending = { cwds, started: false, promise: Promise.resolve([] as ActivityRow[]) };
      pending.promise = Promise.resolve().then(() => {
        pending.started = true;
        return this.readActivityRows(cwds);
      });
      this.readingActivity = pending;
    }
    const pending = this.readingActivity;
    pending.cwds.add(normalized);
    let rows: ActivityRow[];
    try {
      rows = await pending.promise;
    } finally {
      if (this.readingActivity === pending) this.readingActivity = null;
    }
    let count = 0;
    let latest: number | null = null;
    for (const row of rows) {
      // list(cwd) の上限は配下の cwd も含めて数える（テスト用 maxSessions も同じ意味）。
      if (count >= this.maxSessions) break;
      if (!isInsideBase(row.cwd, normalized)) continue;
      count++;
      if (standardize(row.cwd) === normalized && row.updatedAt !== undefined
        && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
    }
    return latest;
  }

  private async readActivityRows(cwds: ReadonlySet<string>): Promise<ActivityRow[]> {
    this.loadMemoFileOnce();
    // session_meta は rollout の不変な先頭行。既知の別 cwd の本文の追記はこの一覧に影響しない。
    // 未知のファイルは必ず読み、同じ id のコピーは cwd をまたいで mtime の新しい方を選ぶ。
    const relevantIds = new Set<string>();
    const pathsById = new Map<string, string[]>();
    for (const [file, memo] of this.rolloutMemo) {
      const meta = memo.meta;
      if (meta?.isBackgroundSession) continue;
      if (meta?.id != null) {
        const paths = pathsById.get(meta.id) ?? [];
        paths.push(file);
        pathsById.set(meta.id, paths);
        if (meta.cwd !== null && [...cwds].some((cwd) => isInsideBase(meta.cwd!, cwd))) relevantIds.add(meta.id);
      }
    }
    const selected = (file: string): boolean => {
      const meta = this.rolloutMemo.get(file)?.meta;
      if (meta?.isBackgroundSession) return false;
      return meta == null || meta.cwd === null
        || (meta.id !== null && relevantIds.has(meta.id))
        || [...cwds].some((cwd) => isInsideBase(meta.cwd!, cwd));
    };
    const { files, paths } = await this.listRolloutsAsync(selected);
    const order = new Map(paths.map((file, index) => [file, index]));
    // 新しい（メモの無い）コピーの id が既知の別 cwd と重なる場合も、両方を比較する。
    const included = new Set(files.map((file) => file.path));
    for (let i = 0; i < files.length; i++) {
      if (i > 0 && i % 32 === 0) await setImmediate();
      const meta = this.sessionMeta(files[i]!);
      if (meta?.id == null) continue;
      for (const sibling of pathsById.get(meta.id) ?? []) {
        if (included.has(sibling) || !this.rolloutMemo.has(sibling)) continue;
        included.add(sibling);
        files.push(await this.statRollout(sibling));
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || order.get(a.path)! - order.get(b.path)!);
    const rows: ActivityRow[] = [];
    const seen = new Set<string>();
    let index: Map<string, IndexEntry> | undefined;
    for (let i = 0; i < files.length; i++) {
      // メモが無い engine でも全 rollout の同期読取で read loop を占有し続けない。
      if (i > 0 && i % 32 === 0) await setImmediate();
      const file = files[i]!;
      const meta = this.sessionMeta(file);
      if (meta === null || meta.cwd === null || meta.isBackgroundSession || !this.hasUserTurn(file)) continue;
      const id = meta.id ?? path.basename(file.path);
      if (seen.has(id)) continue;
      seen.add(id);
      if (file.mtimeMs <= 0) index ??= this.readIndex();
      rows.push({
        cwd: meta.cwd,
        updatedAt: file.mtimeMs > 0 ? Math.floor(file.mtimeMs / 1000) : index?.get(id)?.updatedAt ?? undefined,
      });
    }
    // 保存用メモの書出しは会話一覧 list() に任せる（稼働一覧で巨大 JSON を同期保存しない）。
    return rows;
  }

  /**
   * codex 会話一覧を updatedAt 降順で返す（同値は sessionId 昇順で安定化）。
   * `baseDir` 指定時は cwd が baseDir 自身/配下の会話のみに絞る（engine は無指定で呼ぶ）。
   */
  list(baseDir?: string, limit: number = this.maxSessions): ClaudeSessionInfo[] {
    this.transcriptPaths.clear();
    const index = this.readIndex();
    const files = this.listRollouts().sort((a, b) => b.mtimeMs - a.mtimeMs);

    let result: ClaudeSessionInfo[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (result.length >= limit) break;
      const meta = this.sessionMeta(file);
      if (meta === null || meta.cwd === null || meta.isBackgroundSession) continue;
      // ユーザーの発話が 1 つも無い会話（開いてすぐ閉じた・起動に失敗した等）は出さない。App Server の
      // thread/list もこれらを返さない（2026-10-23 実測: 337 件すべてでこの判定と一致）。
      if (!this.hasUserTurn(file)) continue;
      const sessionId = meta.id ?? path.basename(file.path);
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      this.transcriptPaths.set(sessionId, file.path);

      const idx = meta.id !== null ? index.get(meta.id) : undefined;
      // thread_name が無ければ最初の実ユーザー発話からタイトルを作る（codex アプリ準拠）。
      // それも取れなければ id 先頭 8 字。index にある会話は毎回のファイル走査を避けて thread_name を使う。
      const indexedTitle = idx?.title;
      const title = indexedTitle !== undefined && indexedTitle !== null
        ? normalizeTitle(indexedTitle)
        : this.firstUserMessage(file) ?? sessionId.slice(0, 8);
      // 更新時刻は rollout の mtime（Codex App Server の thread/list が返す updatedAt と同じ値。
      // 2026-10-23 実測で上位 200 件すべて一致）。session_index の updated_at は名前を付けた時点の
      // 値で古く、App Server 経由の一覧と並びが食い違っていた（取得のたびに入れ替わって見えた）。
      const updatedAt =
        file.mtimeMs > 0 ? Math.floor(file.mtimeMs / 1000) : idx?.updatedAt ?? undefined;

      const info: ClaudeSessionInfo = {
        sessionId,
        cwd: meta.cwd,
        title,
        agent: "codex",
        hasProviderTitle: idx?.title !== null && idx?.title !== undefined,
      };
      if (updatedAt !== undefined) info.updatedAt = updatedAt;
      if (baseDir && !isInsideBase(info.cwd, baseDir)) continue;
      const lastMessage = this.lastMessage(file);
      if (lastMessage !== null) info.lastMessage = lastMessage;
      result.push(info);
    }
    this.flushMemoFile();

    return result.sort((lhs, rhs) => {
      const l = lhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      const r = rhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      if (l !== r) return r - l;
      return lhs.sessionId < rhs.sessionId ? -1 : lhs.sessionId > rhs.sessionId ? 1 : 0;
    });
  }

  /**
   * 保存済みの正式タイトルだけを返す（herdr タブ名同期用）。rollout の列挙・App Server の
   * 問い合わせ・一覧件数の制限を使わず、未命名の会話には発話や ID の代替タイトルを付けない。
   * 一覧用の 60 文字への短縮はせず、herdr と同じ前後空白除去だけを行う。
   */
  providerTitles(): ReadonlyMap<string, string> {
    const titles = new Map<string, string>();
    for (const [id, entry] of this.readIndex()) {
      const title = entry.title?.trim();
      if (title !== undefined && title.length > 0) titles.set(id, title);
    }
    return titles;
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
        title = rec["thread_name"];
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

  /** rollout ファイル（`rollout-*.jsonl` / 圧縮された `rollout-*.jsonl.zst`）を再帰列挙する（path + mtimeMs）。 */
  private listRollouts(): RolloutFile[] {
    this.loadMemoFileOnce();
    const out: RolloutFile[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        const stat = fs.statSync(dir);
        const hit = this.rolloutDirectories.get(dir);
        if (hit?.mtimeMs === stat.mtimeMs && hit.ctimeMs === stat.ctimeMs) {
          entries = hit.entries;
        } else {
          entries = fs.readdirSync(dir, { withFileTypes: true });
          this.rolloutDirectories.set(dir, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, entries });
        }
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.isFile() && isRolloutFileName(entry.name)) {
          let mtimeMs = 0;
          let size = -1;
          try {
            const stat = fs.statSync(p);
            mtimeMs = stat.mtimeMs;
            size = stat.size;
          } catch {
            mtimeMs = 0;
          }
          out.push({ path: p, mtimeMs, size });
        }
      }
    };
    walk(this.sessionsRoot);
    this.pruneRolloutMemo(out);
    return out;
  }

  /** ディレクトリを再検証し、必要な cwd・未知の rollout の stat を上限付きで並行して行う。 */
  private async listRolloutsAsync(selected: (file: string) => boolean): Promise<{ files: RolloutFile[]; paths: string[] }> {
    this.loadMemoFileOnce();
    const paths: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        const stat = await fs.promises.stat(dir);
        const hit = this.rolloutDirectories.get(dir);
        if (hit?.mtimeMs === stat.mtimeMs && hit.ctimeMs === stat.ctimeMs) {
          entries = hit.entries;
        } else {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
          this.rolloutDirectories.set(dir, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, entries });
        }
      } catch {
        this.rolloutDirectories.delete(dir);
        return;
      }
      // readdir 順を保つ（同じ mtime の duplicate id の先勝ちを変えない）。
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && isRolloutFileName(entry.name)) paths.push(file);
      }
    };
    await walk(this.sessionsRoot);
    this.pruneRolloutMemo(paths.map((file) => ({ path: file })));
    const files = await mapConcurrent(paths.filter(selected), (file) => this.statRollout(file));
    return { files, paths };
  }

  private async statRollout(file: string): Promise<RolloutFile> {
    try {
      const stat = await fs.promises.stat(file);
      return { path: file, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return { path: file, mtimeMs: 0, size: -1 };
    }
  }

  private pruneRolloutMemo(out: readonly { path: string }[]): void {
    const seen = new Set(out.map((file) => file.path));
    for (const memoPath of this.rolloutMemo.keys()) {
      if (!seen.has(memoPath)) {
        this.rolloutMemo.delete(memoPath);
        this.memoDirty = true;
      }
    }
  }

  /** 最初の列挙の前に、前の engine が書き出したメモを読み戻す。 */
  private loadMemoFileOnce(): void {
    if (this.memoFile === null || this.memoFileLoaded) return;
    this.memoFileLoaded = true;
    for (const [filePath, memo] of this.memoFile.load(isRolloutMemo)) {
      if (!this.rolloutMemo.has(filePath)) this.rolloutMemo.set(filePath, memo);
    }
  }

  /** 変わったメモだけ書き出す（中身が同じ一覧のたびに書かない）。 */
  private flushMemoFile(): void {
    if (this.memoFile === null || !this.memoDirty) return;
    this.memoDirty = false;
    this.memoFile.save(this.rolloutMemo);
  }

  /** rollout 1 本分のメモ（中身が変わっていれば作り直す）。読めない（size < 0）ものは覚えない。 */
  private memoFor(file: RolloutFile): RolloutMemo {
    const hit = this.rolloutMemo.get(file.path);
    if (hit !== undefined && hit.mtimeMs === file.mtimeMs && hit.size === file.size) return hit;
    const memo: RolloutMemo = { mtimeMs: file.mtimeMs, size: file.size };
    // rollout は追記だけなので、伸びただけのファイルで一度見つけた発話は消えない（処理中の会話を
    // 一覧のたびに頭から読み直さない）。
    if (hit?.hasUserTurn === true && file.size >= hit.size) memo.hasUserTurn = true;
    if (file.size >= 0) {
      this.rolloutMemo.set(file.path, memo);
      this.memoDirty = true;
    }
    return memo;
  }

  private sessionMeta(file: RolloutFile): ReturnType<typeof readSessionMeta> {
    const memo = this.memoFor(file);
    if (memo.meta !== undefined) return memo.meta;
    return this.remember(memo, "meta", () => readSessionMeta(file.path));
  }

  private firstUserMessage(file: RolloutFile): string | null {
    const memo = this.memoFor(file);
    if (memo.firstUserMessage !== undefined) return memo.firstUserMessage;
    return this.remember(memo, "firstUserMessage", () => readFirstUserMessage(file.path));
  }

  private hasUserTurn(file: RolloutFile): boolean {
    const memo = this.memoFor(file);
    if (memo.hasUserTurn !== undefined) return memo.hasUserTurn;
    // 読めなかったときは隠さない（remember は失敗結果を覚えない）。
    return this.remember(memo, "hasUserTurn", () => readHasUserTurn(file.path)) ?? true;
  }

  private lastMessage(file: RolloutFile): string | null {
    const memo = this.memoFor(file);
    if (memo.lastMessage !== undefined) return memo.lastMessage;
    return this.remember(memo, "lastMessage", () => readLastRolloutMessage(file.path));
  }

  /** 読み取り結果をメモへ入れる。I/O エラーで失敗した劣化結果は覚えない（直ったら次の一覧で読み直す）。 */
  private remember<K extends "meta" | "firstUserMessage" | "lastMessage" | "hasUserTurn">(
    memo: RolloutMemo,
    key: K,
    read: () => NonNullable<RolloutMemo[K]> | null,
  ): NonNullable<RolloutMemo[K]> | null {
    const failuresBefore = readFailureCount();
    const value = read();
    if (readFailureCount() === failuresBefore) {
      memo[key] = value as RolloutMemo[K];
      this.memoDirty = true;
    }
    return value;
  }
}

/** ユーザーの発話行を探す範囲の上限（先頭の session_meta は数百 KB になり得る）。 */
const USER_TURN_SCAN_LIMIT_BYTES = 4 * 1024 * 1024;
const USER_TURN_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * rollout にユーザーの発話行（旧形式 `event_msg/user_message`・`response_item` の user メッセージ・
 * 新形式 `item_completed` の `UserMessage`）が 1 行でもあるか。題名用の最初の発話（注入行を読み飛ばす）
 * とは別で、形式を問わず発話の有無だけを見る。上限まで見つからなければ false。読めなければ null。
 */
function readHasUserTurn(rolloutPath: string): boolean | null {
  if (isCompressedRollout(rolloutPath)) {
    // 圧縮ファイルは、改行で終わった行の中に発話が見つかった所で解凍を止める。
    let scanned = 0;
    let found = false;
    const scan = (head: Buffer, includeLastLine: boolean): boolean => {
      while (!found && scanned < head.length) {
        const nl = head.indexOf(0x0a, scanned);
        if (nl < 0 && !includeLastLine) break;
        const end = nl >= 0 ? nl : head.length;
        found = isUserTurnLine(head.subarray(scanned, end));
        scanned = end + 1;
      }
      return found;
    };
    try {
      const head = readRolloutHead(rolloutPath, USER_TURN_SCAN_LIMIT_BYTES, (partial) => scan(partial, false));
      return found || scan(head, true);
    } catch (error) {
      noteReadFailure(error);
      return null;
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
  try {
    const chunk = Buffer.alloc(USER_TURN_SCAN_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let offset = 0;
    while (offset < USER_TURN_SCAN_LIMIT_BYTES) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let nl: number;
      while ((nl = pending.indexOf(0x0a)) >= 0) {
        if (isUserTurnLine(pending.subarray(0, nl))) return true;
        pending = pending.subarray(nl + 1);
      }
    }
    return pending.length > 0 && isUserTurnLine(pending);
  } catch (error) {
    noteReadFailure(error);
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 閉じられなくても判定結果は使える（一覧全体を例外にしない）。
    }
  }
}

function isUserTurnLine(line: Buffer): boolean {
  // 安い前判定（"user" を含まない行は JSON を解かない）。
  if (line.indexOf("user") < 0 && line.indexOf("User") < 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch {
    return false;
  }
  const record = asRecord(parsed);
  const payload = asRecord(record?.["payload"]);
  if (record === null || payload === null) return false;
  if (record["type"] === "event_msg") {
    if (payload["type"] === "user_message") return true;
    return payload["type"] === "item_completed" && asRecord(payload["item"])?.["type"] === "UserMessage";
  }
  return record["type"] === "response_item" && payload["type"] === "message" && payload["role"] === "user";
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
  try {
    const slice = readRolloutHead(rolloutPath, META_READ_LIMIT_BYTES, (partial) => partial.includes(0x0a));
    if (slice.length === 0) return null;
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
  } catch (error) {
    noteReadFailure(error);
    return null;
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
  try {
    // 圧縮ファイルは、改行で終わった行の中に発話が見つかった所で解凍を止める。
    const head = readRolloutHead(rolloutPath, META_READ_LIMIT_BYTES, (partial) => {
      const lastNewline = partial.lastIndexOf(0x0a);
      return lastNewline >= 0 && firstUserMessageIn(partial.subarray(0, lastNewline).toString("utf8")) !== null;
    });
    if (head.length === 0) return null;
    return firstUserMessageIn(head.toString("utf8"));
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
}

/** rollout 先頭の文字列から最初の素のユーザー発話を題名の形で返す（無ければ null）。 */
function firstUserMessageIn(text: string): string | null {
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
}

/** タイトルを 1 行・先頭 ~60 字へ整形する。 */
function normalizeTitle(raw: string): string {
  return normalizeSnippet(raw, TITLE_MAX_LENGTH);
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
 * 旧 `event_msg/user_message・agent_message` と、現行 `item_completed` のユーザー/応答本文、
 * `response_item/message/assistant` を読む。注入を含む response_item の user 行は対象外。
 * token_count 等は skip し、チャンク境界で切れた行は次のチャンクで読み直す。
 * 上限まで遡って無ければ null。
 */
function readLastRolloutMessage(rolloutPath: string): string | null {
  if (isCompressedRollout(rolloutPath)) {
    let content: Buffer | null;
    try {
      content = readCompressedRollout(rolloutPath, COMPRESSED_TAIL_DECOMPRESS_LIMIT_BYTES);
    } catch (error) {
      noteReadFailure(error);
      return null;
    }
    if (content === null) return null;
    const whole = content;
    return lastRolloutMessageFromTail(whole.length, (span) => whole.subarray(whole.length - span));
  }
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    return lastRolloutMessageFromTail(size, (span) => {
      const buf = Buffer.alloc(span);
      const bytesRead = fs.readSync(fd, buf, 0, span, size - span);
      return buf.subarray(0, bytesRead);
    });
  } catch (error) {
    noteReadFailure(error);
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // close 失敗は無視。
    }
  }
}

/** 末尾 `span` バイトを返す `readTail` で、最後の表示用メッセージを後方スキャンする。 */
function lastRolloutMessageFromTail(size: number, readTail: (span: number) => Buffer): string | null {
  const maxSpan = Math.min(size, TAIL_BYTES_CAP);
  let span = 0;
  while (span < maxSpan) {
    span = Math.min(span + TAIL_CHUNK_BYTES, maxSpan);
    const lines = readTail(span).toString("utf8").split("\n");
    // 途中から読んだ場合、先頭要素は行の途中で切れている可能性があるため捨てる。
    const first = span < size ? 1 : 0;
    for (let i = lines.length - 1; i >= first; i--) {
      const line = lines[i] ?? "";
      // 早期スキップ（大半の行は対象 payload を含まない）。
      if (!line.includes("message") && !line.includes("item_completed")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const message = rolloutMessageText(obj);
      if (message !== null && message.trim().length > 0) {
        return normalizeSnippet(message, LAST_MESSAGE_MAX_LENGTH);
      }
    }
    if (span >= size) return null;
  }
  return null;
}

/** 新旧 rollout の表示用本文だけを取り出す。思考・ツール・注入された指示は採用しない。 */
export function rolloutMessageText(value: unknown): string | null {
  const record = asRecord(value);
  const payload = asRecord(record?.["payload"]);
  if (payload === null) return null;

  if (record?.["type"] === "response_item") {
    if (payload["type"] !== "message" || payload["role"] !== "assistant" || !isVisiblePhase(payload)) {
      return null;
    }
    // 一覧は本文だけが必要なので、旧 rollout で欠落し得る item ID は要求しない。
    return contentText(payload["content"], "output_text");
  }
  if (record?.["type"] !== "event_msg") return null;
  if (payload["type"] === "user_message" || payload["type"] === "agent_message") {
    if (payload["type"] === "agent_message" && !isVisiblePhase(payload)) return null;
    return typeof payload["message"] === "string" ? payload["message"] : null;
  }
  if (payload["type"] !== "item_completed") return null;
  const item = asRecord(payload["item"]);
  if (item?.["type"] === "UserMessage") return contentText(item["content"], "text");
  if (item?.["type"] === "AgentMessage" && isVisiblePhase(item)) {
    return contentText(item["content"], "Text");
  }
  return null;
}

function isVisiblePhase(message: Record<string, unknown>): boolean {
  // 一覧の要約は従来から明示の null も本文として読む（会話面の判定より緩い）。
  const phase = message["phase"];
  return phase === null || isVisibleCodexMessagePhase(phase);
}

function contentText(content: unknown, textType: string): string | null {
  if (!Array.isArray(content)) return null;
  return content.flatMap((part) => {
    const item = asRecord(part);
    return item?.["type"] === textType && typeof item["text"] === "string" ? [item["text"]] : [];
  }).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
