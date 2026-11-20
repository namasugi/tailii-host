// commands/chat/chatState.ts
// `tailii-host chat` の設定・依頼の記録・会話の状態の読み取り（tailii-chat-cli）。
// 状態はホスト上のファイル（Claude Code の登録簿と会話の記録）を直接読む（engine を通さず軽い）。

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectSlug } from "../../shared/paths.js";
import { locateClaudeTranscript } from "../../sessions/claudeTranscriptLocator.js";
import { ClaudeSessionStore } from "../../sessions/claudeSessionStore.js";
import type { WatchBaseline } from "./chatWatch.js";
import { defaultPeerSessionsDir, parsePeerSessionRecord } from "../../services/peerSessions.js";
import { SessionMetadataStore } from "../../sessions/sessionMetadataStore.js";
import { normalizeUtteranceForMatch } from "../../hub/chatDeliveryLog.js";
import { unwrapPastedContent } from "../../shared/pastedContent.js";
import { defaultCodexHome } from "../../codex/codexSessionStore.js";
import { isCompressedRollout, isRolloutFileName, readCompressedRollout } from "../../codex/rolloutFile.js";
import { isVisibleCodexMessagePhase } from "../../codex/codexMessagePhase.js";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";
const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

/** Bot（`--json` で叩く相手）向けの設定（`~/.tailii/bot.json`）。誤操作の防止で、防御ではない（SSH 鍵は共用）。 */
export interface BotConfig {
  /** 会話を始めてよい作業フォルダの親（実パス）。既定はホーム。 */
  allowedRoots: string[];
  /** Bot が始めた会話の許可モードの既定。既定は acceptEdits（編集と読み取りは進み、それ以外は承認が要る）。 */
  permissionMode: PermissionMode;
  /** `auto`（何でも許可）を Bot に許すか。既定は不可。 */
  allowAuto: boolean;
  /** Bot に承認の「許可」を許すか（`chat approve … allow`）。既定は不可（拒否はいつでもできる）。第 2 段。 */
  allowApprove: boolean;
  /** Bot に他所で動いている会話の開き直し（`chat take-over`）を許すか。既定は不可。第 2 段。 */
  allowTakeOver: boolean;
  /**
   * Bot が `--model` で指定してよいモデル（完全一致）。未設定は制限なし（一覧にあるモデル）。使用量の使いすぎの防止。
   */
  allowedModels?: string[];
  /**
   * Bot に会話の途中のモデル変更（`chat set-model`）を許すか。既定は不可: Claude の `/model` は利用者の「新しい会話の
   * 既定モデル」も書き換える（2.1.322 実測 `Set model to … and saved as your default for new sessions`）。
   */
  allowSetModel: boolean;
}

export function botConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "bot.json");
}

export function loadBotConfig(file: string = botConfigPath()): BotConfig {
  const config: BotConfig = {
    allowedRoots: [os.homedir()], permissionMode: "acceptEdits", allowAuto: false, allowApprove: false, allowTakeOver: false,
    allowSetModel: false,
  };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return config;
  }
  if (typeof raw !== "object" || raw === null) return config;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj["allowedRoots"])) {
    const roots = obj["allowedRoots"].filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
    config.allowedRoots = roots;
  }
  if (typeof obj["allowAuto"] === "boolean") config.allowAuto = obj["allowAuto"];
  if (typeof obj["allowApprove"] === "boolean") config.allowApprove = obj["allowApprove"];
  if (typeof obj["allowTakeOver"] === "boolean") config.allowTakeOver = obj["allowTakeOver"];
  if (typeof obj["allowSetModel"] === "boolean") config.allowSetModel = obj["allowSetModel"];
  // 配列でない書き間違いは、黙って無制限にせず「何も許さない」に倒す。
  if (obj["allowedModels"] !== undefined) {
    config.allowedModels = Array.isArray(obj["allowedModels"])
      ? obj["allowedModels"].filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  }
  const mode = obj["permissionMode"];
  if (typeof mode === "string" && (PERMISSION_MODES as readonly string[]).includes(mode)) {
    config.permissionMode = mode as PermissionMode;
  }
  if (config.permissionMode === "auto" && !config.allowAuto) config.permissionMode = "acceptEdits";
  return config;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/** 作業フォルダが許可された親の中か（実パスで比べる。存在しないフォルダは不可）。 */
export function folderAllowed(dir: string, roots: readonly string[]): boolean {
  let real: string;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return false;
  } catch {
    return false;
  }
  return roots.some((root) => {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return false;
    }
    const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    return real === realRoot || real.startsWith(prefix);
  });
}

/** 依頼 ID から決まる値（再試行しても同じ会話名・同じ送信 ID になる）。 */
export function requestDigest(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
}

/**
 * 依頼 ID から決まる送信 ID（`chat_send.clientMessageId` / `codex_turn_start.clientUserMessageId`）。打ち直しても同じ。
 * `cli-` で始まるので、hub の送信の記録や Codex の rollout の `client_id` から、このコマンドの送信だと見分けられる。
 */
export const clientMessageIdFor = (requestId: string): string => `cli-${requestDigest(requestId).slice(0, 24)}`;

/**
 * 依頼の記録（`~/.tailii/bot/requests/<digest>.json`）。同じ依頼 ID の打ち直しを二重にしない。
 * 起動が済んだ時点（送る前）に `started` で書き、送信が受け付けられたら `sent` にする。打ち直しは `started` なら起動を
 * やり直さずに同じ会話名・同じ送信 ID で送り直し、`sent` なら何もしない（レビュー指摘 A1・A3）。
 */
export interface RequestRecord {
  requestId: string;
  kind: "new" | "send" | "set-model" | "set-mode";
  conversationId: string;
  session: string;
  cwd: string;
  /** 最初に送ろうとした時刻（epoch ms）。打ち直しでも変えない。`status --after` でこの依頼への返答を探す起点。 */
  sentAtMs: number;
  /** 実際に送る本文（長い指示文はファイルの参照に置き換えた後）。返答の起点の照合用。 */
  text: string;
  /** 依頼の指示文（置き換え前）のハッシュ。同じ依頼 ID の使い回しを見分ける（レビュー指摘 A5）。 */
  textHash?: string;
  /**
   * `starting` = 起動を頼んだ（会話 id は未確定）/ `started` = 起動済み・送信は未確定 / `sent` = 送信が受け付けられた（hub の
   * 応答は注入の完了を意味する）。旧記録は `sent`。
   */
  state?: "starting" | "started" | "sent";
  /** 届いたか分からないまま人に回した（needs_human）。打ち直しでは送り直さない（5 周目レビュー 1）。 */
  needsHuman?: boolean;
  /** 会話のエージェント（省略は claude。Codex は codex_turn_start で送り、記録は rollout）。 */
  agent?: "claude" | "codex";
  /** Codex の turn の承認の方針と sandbox（打ち直しでも同じ値で送る: hub は明示の再送で中身の一致を見る）。 */
  codexTurn?: CodexTurnOptions;
  /** 指定したモデル（`new --model` / `set-model`）。同じ依頼 ID の使い回しの照合にも使う。 */
  model?: string;
  /** 指定した工数（`new --effort`。Codex は最初の turn にだけ載せ、以後の send には引き継がない）。 */
  effort?: string;
  /** 指定した許可モード（`set-mode`）。同じ依頼 ID の使い回しの照合にも使う。 */
  mode?: string;
  /** `--watch` 付きの送信前の控え。配送確認の打ち直しでも最初の控えを使う。 */
  watchBaseline?: WatchBaseline;
}

/** Codex の turn の設定（`codex_turn_start` の approvalPolicy / sandbox / collaborationMode）。 */
export interface CodexTurnOptions {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  collaborationMode?: "plan" | "default";
}

export function requestsDir(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "bot", "requests");
}

export function readRequest(requestId: string, dir: string = requestsDir()): RequestRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${requestDigest(requestId).slice(0, 32)}.json`), "utf8"));
    return raw?.requestId === requestId ? raw as RequestRecord : null;
  } catch {
    return null;
  }
}

export function writeRequest(record: RequestRecord, dir: string = requestsDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${requestDigest(record.requestId).slice(0, 32)}.json`);
  // 一時ファイル名は書き手ごとに変える（同じ名前だと、同時に書いたとき壊れた JSON になりうる。3 周目レビュー 3）。
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 依頼の排他の残骸とみなす時間（コマンドの最長は起動 90 秒 + 送信 100 秒 + 余裕）。 */
const REQUEST_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * 同じ依頼 ID のコマンドを同時に 1 本だけにする（`<digest>.lock` を排他作成）。取れなければ null。
 * 同じ依頼 ID の `new` を並べて流すと、後から来た方が起動済みの記録を読めずに同じ会話名で起動し直し、会話 id が
 * 書き換わる（3 周目レビュー 3）。持ち主のプロセスが居ない・古すぎる錠は残骸として取り直す。
 */
export function acquireRequestLock(requestId: string, dir: string = requestsDir(), nowMs: number = Date.now()): (() => void) | null {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${requestDigest(requestId).slice(0, 32)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, atMs: nowMs }), { flag: "wx", mode: 0o600 });
      return () => { try { fs.unlinkSync(file); } catch { /* 既に無い */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let stale = true;
    let seen: string | null = null;
    try {
      seen = fs.readFileSync(file, "utf8");
      const held = JSON.parse(seen) as { pid?: unknown; atMs?: unknown };
      const pid = typeof held.pid === "number" ? held.pid : -1;
      const atMs = typeof held.atMs === "number" ? held.atMs : 0;
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
      stale = !alive || nowMs - atMs > REQUEST_LOCK_STALE_MS;
    } catch {
      // 書きかけ（中身が空）: 作った直後の別のプロセスかもしれないので、古さだけで判断する。
      try { stale = nowMs - fs.statSync(file).mtimeMs > REQUEST_LOCK_STALE_MS; } catch { stale = true; }
    }
    if (!stale) return null;
    // 読めなかった（他が消した直後）: 消さずに作り直しを試す（取り直したばかりの別の錠を消さない。5 周目レビュー 4）。
    if (seen === null) continue;
    // 消す直前に、残骸と判定した中身のままかを確かめる（同時に取り直した別のプロセスの新しい錠を消さない。4 周目 低2）。
    try {
      const now = fs.readFileSync(file, "utf8");
      if (seen !== null && now !== seen) return null;
      fs.unlinkSync(file);
    } catch { /* 他が先に消した */ }
  }
  return null;
}

/** `tailii-host chat new` で始めた会話か（依頼の記録に、この会話 id の new がある）。設問に答えてよい条件（第 2 段）。 */
export function isBotStartedConversation(conversationId: string, dir: string = requestsDir()): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<RequestRecord>;
      if (raw.kind === "new" && raw.conversationId === conversationId) return true;
    } catch {
      // 壊れた記録は飛ばす。
    }
  }
  return false;
}

/** busy = 処理中 / waiting = 利用者の入力待ち（承認・設問など） / idle = 待機 / not_running = 止まっている。 */
export type ConversationState = "busy" | "waiting" | "idle" | "not_running";

/** 会話の状態（Claude Code の登録簿の生存と status）。 */
export function conversationState(conversationId: string, registryDir: string = defaultPeerSessionsDir()): ConversationState {
  return conversationStateSnapshot(conversationId, registryDir).state;
}

/** 状態と、登録簿で分かる入力待ちの開始時刻。 */
export function conversationStateSnapshot(conversationId: string, registryDir: string = defaultPeerSessionsDir()): {
  state: ConversationState; waitingSinceMs?: number;
} {
  let entries: string[];
  try {
    entries = fs.readdirSync(registryDir);
  } catch {
    return { state: "not_running" };
  }
  let state: ConversationState = "not_running";
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    let raw: Record<string, unknown>;
    let record;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(registryDir, entry), "utf8")) as Record<string, unknown>;
      record = parsePeerSessionRecord(raw);
    } catch {
      continue;
    }
    if (record === null || record.sessionId !== conversationId) continue;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") continue;
    }
    // 登録簿の status は busy / shell（シェルのコマンドを実行中）/ waiting / idle（claudeLiveStatus.ts と同じ）。
    // shell は「ターンは終わり、背景のシェルが動いている」（claudeLiveStatus.ts）。返答は出そろっているので待機と同じに扱う。
    if (record.status === "busy") return { state: "busy" };
    if (record.status === "waiting") {
      const waitingSinceMs = [raw["statusUpdatedAt"], raw["updatedAt"]]
        .find((at): at is number => typeof at === "number" && Number.isFinite(at));
      return { state: "waiting", waitingSinceMs };
    }
    state = "idle";
  }
  return { state };
}

/** 会話の記録ファイルを探す（Tailii のメタの作業フォルダ → 全プロジェクトの中から会話 id で）。 */
export function findTranscript(
  conversationId: string,
  options: { store?: SessionMetadataStore; projectsDir?: string; cwdHint?: string; resolveCwd?: boolean } = {},
): { file: string; cwd: string | null } | null {
  const projectsDir = options.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const candidates: Array<string> = [];
  if (options.cwdHint !== undefined) candidates.push(options.cwdHint);
  const store = options.store ?? new SessionMetadataStore();
  for (const meta of store.all()) {
    if (meta.providerSessionId === conversationId || meta.claudeSessionId === conversationId) candidates.push(meta.cwd);
  }
  for (const cwd of candidates) {
    const file = path.join(projectsDir, claudeProjectSlug(cwd), `${conversationId}.jsonl`);
    if (fs.existsSync(file)) return { file, cwd };
  }
  if (options.resolveCwd === false) {
    const file = new ClaudeSessionStore(projectsDir).transcriptPath(conversationId);
    return file === null ? null : { file, cwd: null };
  }
  // 会話中の `/cd` 等で移った会話（session-workdir-change）: 全 slug から会話 id で探し、会話ログが指す今のフォルダを添える。
  const located = locateClaudeTranscript(conversationId, null, { projectsDir });
  return located === null ? null : { file: located.path, cwd: located.cwd };
}

/** 記録を少しずつ読むときの 1 回の大きさ。 */
const LINE_READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** これを超える 1 行は読まずに飛ばす（1 行を 1 つの文字列にするので、長さとメモリを抑える）。 */
const MAX_LINE_BYTES = 256 * 1024 * 1024;

export interface LineReadOptions {
  /** 1 回に読む大きさ（テスト用）。 */
  chunkBytes?: number;
  /** これを超える 1 行は飛ばす（テスト用）。 */
  maxLineBytes?: number;
}

/** メモリに載っているデータを、改行で切って 1 行ずつ渡す（空の行と長すぎる行は渡さない）。 */
function emitBufferLines(data: Buffer, emit: (line: Buffer) => void, maxLineBytes: number): void {
  let start = 0;
  for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a, start)) {
    if (end > start && end - start <= maxLineBytes) emit(data.subarray(start, end));
    start = end + 1;
  }
  if (start < data.length && data.length - start <= maxLineBytes) emit(data.subarray(start));
}

/**
 * ファイルを少しずつ読んで、改行で切った 1 行ずつを渡す（空の行と長すぎる行は渡さない）。読めなければ false（途中まで
 * 渡していることがある）。渡す `line` は次の読み込みで上書きされるので、その場で使い切る。
 * ファイル全体を 1 つの文字列にしない: Node の文字列は約 512 MiB までで、それを超える記録は `readFileSync(file, "utf8")`
 * では読めない（実例: ツールの出力が積もった Codex の rollout 654 MB。Claude の会話ログも最大 438 MB まで育っている）。
 */
function emitFileLines(file: string, emit: (line: Buffer) => void, options: LineReadOptions): boolean {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.allocUnsafe(Math.max(1, options.chunkBytes ?? LINE_READ_CHUNK_BYTES));
    /** 読んだ分をまたいで続いている行の、ここまでの分。 */
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    /** 長すぎる行の残りを、次の改行まで捨てている途中。 */
    let skipping = false;
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        return false;
      }
      if (read === 0) break;
      const data = chunk.subarray(0, read);
      let start = 0;
      for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a, start)) {
        if (skipping) {
          skipping = false;
        } else if (pending.length === 0) {
          if (end > start && end - start <= maxLineBytes) emit(data.subarray(start, end));
        } else {
          if (pendingBytes + end - start <= maxLineBytes) emit(Buffer.concat([...pending, data.subarray(start, end)]));
          pending = [];
          pendingBytes = 0;
        }
        start = end + 1;
      }
      if (start < read && !skipping) {
        pendingBytes += read - start;
        if (pendingBytes > maxLineBytes) {
          pending = [];
          pendingBytes = 0;
          skipping = true;
        } else {
          // `chunk` は次の読み込みで上書きされるので、写しを取っておく。
          pending.push(Buffer.from(data.subarray(start)));
        }
      }
    }
    if (pending.length > 0) emit(Buffer.concat(pending));
    return true;
  } finally {
    try { fs.closeSync(fd); } catch { /* 閉じられなくても読んだ結果は変わらない */ }
  }
}

/**
 * 記録のファイル（1 行 1 件の JSON）を 1 行ずつ `onLine` に渡す。読めなければ false（途中まで渡していることがある。
 * 呼び出し側は、それまでに集めた分を捨てる）。
 */
export function forEachFileLine(file: string, onLine: (line: string) => void, options: LineReadOptions = {}): boolean {
  return emitFileLines(file, (line) => { onLine(line.toString("utf8")); }, options);
}

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
  atMs: number;
  /** 送った側の発話 id（Codex の `client_id` = `codex_turn_start.clientUserMessageId`）。照合は本文より先にこれで。 */
  clientId?: string;
}

/** Claude の記録の `message.content` から文章の部分だけをつなぐ（ツールの結果・思考は除く）。 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** 人の発話として読まない行（コマンドの記録・注入・背景タスクの通知）の本文の形。 */
const INJECTED_TEXT = /^<(?:command-|local-command-|system-reminder|bash-|task-notification)/;
/** サブエージェントから親へ戻る報告（ツールの結果にあたる）。 */
const SUBAGENT_MESSAGE = /^<agent-message /;
const CROSS_SESSION_MESSAGE = /^<cross-session-message /;

/**
 * 記録の発話が誰のものか（記録の `origin` の印。2.1.3xx）。human = 人の発話 / peer = 別の Claude のセッションから届いた /
 * injected = 人の発話ではない（背景タスクの通知・サブエージェントから親への報告・コマンドの記録と注入）。
 * 待機中に届いた通知・報告は user 行（多くはメタ行）、処理中に届いたものは attachment(queued_command) 行に残る。
 * 本文の形だけでの見分け（`<agent-message …>` で始まるなど）は、`origin` が無い旧い記録に限る（人の発話の印が付いた行は、
 * 貼り付けた本文がその形で始まっていても人の発話）。
 */
export function utteranceOrigin(origin: unknown, text: string): { kind: "human" } | { kind: "peer"; name?: string } | { kind: "injected" } {
  const mark = typeof origin === "object" && origin !== null
    ? origin as { kind?: unknown; senderTaskId?: unknown; name?: unknown } : null;
  const kind = typeof mark?.kind === "string" ? mark.kind : null;
  const unmarked = kind === null;
  if (kind === "task-notification" || INJECTED_TEXT.test(text)) return { kind: "injected" };
  if (typeof mark?.senderTaskId === "string" || (unmarked && SUBAGENT_MESSAGE.test(text))) return { kind: "injected" };
  if (kind === "peer" || (unmarked && CROSS_SESSION_MESSAGE.test(text))) {
    return { kind: "peer", ...(typeof mark?.name === "string" && mark.name.length > 0 ? { name: mark.name } : {}) };
  }
  return { kind: "human" };
}

/**
 * 会話の記録から、人の発話と Claude の文章だけを古い順に読む（ツールの結果・注入・メタ行は除く）。
 * 処理中に届いた背景タスクの通知・サブエージェントの報告・別のセッションからの発話は、人の発話に数えない（数えると、
 * `status` の返答がそこで切れる: 依頼の処理中に通知が届くと、返答は通知より前の文章だけになっていた）。
 */
export function readTranscriptLines(file: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const readable = forEachFileLine(file, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = obj["type"];
    const ts = typeof obj["timestamp"] === "string" ? Date.parse(obj["timestamp"]) : Number.NaN;
    const atMs = Number.isFinite(ts) ? ts : 0;
    if (obj["isMeta"] === true || obj["isSidechain"] === true) return;
    // 処理中の会話へ送った発話は user 行ではなく attachment(queued_command) 行としてだけ残る（transcriptTailer と同じ扱い。
    // 3 周目レビュー 1b）。
    if (type === "attachment") {
      const attachment = obj["attachment"] as { type?: unknown; prompt?: unknown; origin?: unknown; commandMode?: unknown } | undefined;
      if (attachment?.type !== "queued_command" || typeof attachment.prompt !== "string") return;
      const prompt = unwrapPastedContent(attachment.prompt).trim();
      if (prompt.length === 0) return;
      if (attachment.commandMode === "task-notification" || utteranceOrigin(attachment.origin, prompt).kind !== "human") return;
      out.push({ role: "user", text: prompt, atMs });
      return;
    }
    if (type !== "user" && type !== "assistant") return;
    const message = obj["message"] as { role?: unknown; content?: unknown } | undefined;
    const raw = textOf(message?.content).trim();
    const text = type === "user" ? unwrapPastedContent(raw).trim() : raw;
    if (text.length === 0) return;
    // 人の発話のうち、コマンドの記録・注入（`<command-…>` `<local-command-…>` `<system-reminder>` など）は除く。
    if (type === "user" && INJECTED_TEXT.test(text)) return;
    out.push({ role: type, text, atMs });
  });
  // 途中までしか読めなかった記録は、欠けた列を返さずに「読めない」とする。
  return readable ? out : [];
}

/**
 * 照合用の正規化。記録に残る本文は、送った本文から hub と Claude Code が変えたもの（制御文字を落とす・貼り付けの包み・
 * 不可視文字を除く）なので、両辺を同じ形にそろえてから空白を除いて比べる（3 周目レビュー 1）。
 */
export function normalizeForReplyMatch(text: string): string {
  // hub が届けた発話の記録に残すハッシュ（chatDeliveryLog.ts）と同じ正規化。
  return normalizeUtteranceForMatch(text);
}

/** 会話の記録から、直近の返答を作ったモデルを読む（`<synthetic>` は実際のモデルではないので除く）。分からなければ null。 */
export function lastClaudeModel(file: string): string | null {
  // 先頭から読み、当てはまる最後の行のモデルを残す（末尾から探すには、全体をメモリに載せることになる）。
  let last: string | null = null;
  const readable = forEachFileLine(file, (line) => {
    if (!line.includes("\"assistant\"") || !line.includes("\"model\"")) return;
    try {
      const obj = JSON.parse(line) as { type?: unknown; isSidechain?: unknown; message?: { model?: unknown } };
      const model = obj.message?.model;
      if (obj.type === "assistant" && obj.isSidechain !== true && typeof model === "string" && model.length > 0 &&
        model !== "<synthetic>") last = model;
    } catch {
      // 壊れた行は飛ばす。
    }
  });
  return readable ? last : null;
}

/** ローカルコマンドの行の本文。待機中は `user` の行、ターンの途中に実行すると `system` / `local_command` の行になる（2.1.322 実測）。 */
function localCommandText(obj: { type?: unknown; subtype?: unknown; content?: unknown; message?: { content?: unknown } }): string | null {
  if (obj.type === "user") return textOf(obj.message?.content);
  if (obj.type === "system" && obj.subtype === "local_command" && typeof obj.content === "string") return obj.content;
  return null;
}

/**
 * 送った `/model <id>` の結果を会話の記録から探す。コマンドの行（`<command-name>/model</command-name>` と
 * `<command-args><id></command-args>`）が無ければ null。結果の行（`<local-command-stdout>`）がまだ無ければ detail は null。
 * 結果は、そのコマンドの行の次のコマンドの行より手前だけを見る（別のコマンドの出力を自分の結果と取り違えない）。
 * `superseded` は、この後に別のモデルへの `/model` が実行されたこと（今のモデルは頼んだものではない）。
 * ターンの途中に実行した `/model` の行はターンの終わりに書かれる（時刻は実行した時刻のまま）。
 */
export function findModelCommandResult(
  file: string,
  sinceMs: number,
  model: string,
): { detail: string | null; superseded: boolean } | null {
  const ownArgs = `<command-args>${model}</command-args>`;
  let found = false;
  /** 自分のコマンドの結果を待っている間だけ true（次のコマンドの行が来たら、その後の出力は自分の結果ではない）。 */
  let awaitingResult = false;
  let detail: string | null = null;
  let superseded = false;
  const readable = forEachFileLine(file, (line) => {
    if (!line.includes("command-name") && !line.includes("local-command-stdout")) return;
    let obj: Parameters<typeof localCommandText>[0] & { timestamp?: unknown };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      return;
    }
    const text = localCommandText(obj);
    if (text === null) return;
    const isCommand = text.includes("<command-name>");
    const isModelCommand = text.includes("<command-name>/model</command-name>");
    if (!found) {
      const atMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
      found = Number.isFinite(atMs) && atMs >= sinceMs && isModelCommand && text.includes(ownArgs);
      awaitingResult = found;
      return;
    }
    if (isCommand) {
      // 同じモデルへの打ち直しなら、そちらの結果を読む。別のモデルへの変更なら、頼んだモデルはもう今のモデルではない。
      awaitingResult = isModelCommand && text.includes(ownArgs);
      if (awaitingResult) {
        detail = null;
        superseded = false;
      } else if (isModelCommand && /<command-args>[^<]+<\/command-args>/.test(text)) {
        superseded = true;
      }
      return;
    }
    if (awaitingResult) {
      const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
      // 色の制御文字を除いて返す。
      if (stdout !== null) {
        detail = stdout[1]!.replace(/\u001b\[[0-9;]*m/g, "").trim();
        awaitingResult = false;
      }
    }
  });
  return readable && found ? { detail, superseded } : null;
}

/** モデル一覧の控え（`~/.tailii/bot/models-<agent>.json`）。外部 API を連打しないために持つ。 */
export interface ModelListCache<T> {
  fetchedAtMs: number;
  models: T[];
}

export function modelCacheDir(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "bot");
}

export function readModelCache<T>(agent: "claude" | "codex", dir: string = modelCacheDir()): ModelListCache<T> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `models-${agent}.json`), "utf8")) as Partial<ModelListCache<T>>;
    if (typeof raw.fetchedAtMs !== "number" || !Array.isArray(raw.models)) return null;
    // 要素の形が崩れた控えは無かったことにする（取り直す）。
    const wellFormed = raw.models.every((item) => typeof (item as { id?: unknown } | null)?.id === "string");
    return wellFormed ? { fetchedAtMs: raw.fetchedAtMs, models: raw.models } : null;
  } catch {
    return null;
  }
}

export function writeModelCache<T>(agent: "claude" | "codex", cache: ModelListCache<T>, dir: string = modelCacheDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `models-${agent}.json`);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 控えが書けなくても一覧は返せる。
  }
}

// ---- Codex（rollout） ----

/** Codex の会話（thread id）の rollout を探す（`~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl[.zst]`）。新しい日付から。 */
export function findCodexRollout(threadId: string, codexHome: string = defaultCodexHome()): string | null {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(threadId)) return null;
  const root = path.join(codexHome, "sessions");
  const sorted = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of sorted(root)) {
    for (const month of sorted(path.join(root, year))) {
      for (const day of sorted(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        const hit = names.find((name) => isRolloutFileName(name) && name.includes(threadId));
        if (hit !== undefined) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** 圧縮 rollout を解凍して持つ上限。 */
const ROLLOUT_COMPRESSED_LIMIT_BYTES = 256 * 1024 * 1024;
/** 行の先頭にある、行の種類（`{"timestamp":"…","ordinal":N,"type":"…"`。`ordinal` は無い版もある）。 */
const ROLLOUT_LINE_TYPE = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"([A-Za-z_]+)"/;

/**
 * Codex の rollout（圧縮も）を 1 行ずつ `onLine` に渡す。読めなければ false（途中まで渡していることがある）。
 * `types` を渡すと、行の先頭から種類が読み取れて、それが `types` に無い行は文字列にせずに飛ばす（rollout の大半は
 * ツールの出力の `response_item`。先頭から種類を読み取れない行は飛ばさずに渡す）。
 */
export function forEachRolloutLine(
  file: string,
  onLine: (line: string) => void,
  options: LineReadOptions & { types?: ReadonlySet<string> } = {},
): boolean {
  const emit = (line: Buffer): void => {
    if (options.types !== undefined) {
      const head = ROLLOUT_LINE_TYPE.exec(line.subarray(0, 128).toString("latin1"));
      if (head !== null && !options.types.has(head[1]!)) return;
    }
    onLine(line.toString("utf8"));
  };
  if (!isCompressedRollout(file)) return emitFileLines(file, emit, options);
  let data: Buffer | null;
  try {
    data = readCompressedRollout(file, ROLLOUT_COMPRESSED_LIMIT_BYTES);
  } catch {
    return false;
  }
  if (data === null) return false;
  emitBufferLines(data, emit, options.maxLineBytes ?? MAX_LINE_BYTES);
  return true;
}

const ROLLOUT_EVENT_TYPES: ReadonlySet<string> = new Set(["event_msg"]);
const ROLLOUT_TURN_CONTEXT_TYPES: ReadonlySet<string> = new Set(["turn_context"]);

/** Codex の item の `content` から、指定した種類の文章だけをつなぐ。 */
export function itemText(content: unknown, textType: string): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === textType &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Codex の rollout から、人の発話と Codex の文章を古い順に読む（思考・ツール・内部の区分は除く）。 */
export function readCodexRolloutLines(file: string): TranscriptLine[] {
  return readCodexRollout(file).lines;
}

/**
 * Codex の rollout を 1 回読んで、発話と処理中か（最後の turn が始まったまま終わっていない）を返す
 * （status の待ちで毎秒 2 回全体を読まない。Fable レビュー 低2）。
 */
export function readCodexRollout(file: string): { lines: TranscriptLine[]; busy: boolean } {
  const out: TranscriptLine[] = [];
  let busy = false;
  const readable = forEachRolloutLine(file, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (obj["type"] !== "event_msg") return;
    const payload = obj["payload"] as Record<string, unknown> | undefined;
    if (payload === undefined) return;
    if (payload["type"] === "task_started") { busy = true; return; }
    if (payload["type"] === "task_complete" || payload["type"] === "turn_aborted") { busy = false; return; }
    const ts = typeof obj["timestamp"] === "string" ? Date.parse(obj["timestamp"]) : Number.NaN;
    const atMs = Number.isFinite(ts) ? ts : 0;
    // 0.16x: item_completed（UserMessage / AgentMessage）。旧版: user_message / agent_message。
    if (payload["type"] === "item_completed") {
      const item = payload["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "UserMessage") {
        const text = itemText(item["content"], "text").trim();
        const clientId = typeof item["client_id"] === "string" ? item["client_id"] : undefined;
        if (text.length > 0) out.push({ role: "user", text, atMs, ...(clientId !== undefined ? { clientId } : {}) });
      } else if (item?.["type"] === "AgentMessage" && isVisibleCodexMessagePhase(item["phase"])) {
        const text = itemText(item["content"], "Text").trim();
        if (text.length > 0) out.push({ role: "assistant", text, atMs });
      }
    } else if (payload["type"] === "user_message" && typeof payload["message"] === "string") {
      const text = payload["message"].trim();
      if (text.length > 0) out.push({ role: "user", text, atMs });
    } else if (payload["type"] === "agent_message" && typeof payload["message"] === "string" &&
      isVisibleCodexMessagePhase(payload["phase"])) {
      const text = payload["message"].trim();
      if (text.length > 0) out.push({ role: "assistant", text, atMs });
    }
  }, { types: ROLLOUT_EVENT_TYPES });
  // 途中までしか読めなかった記録は、欠けた列を返さずに「読めない」とする。
  return readable ? { lines: out, busy } : { lines: [], busy: false };
}

/** Codex の rollout から、直近の turn のモデルを読む（最後の `turn_context`）。分からなければ null。 */
export function lastCodexModel(file: string): string | null {
  let model: string | null = null;
  const readable = forEachRolloutLine(file, (line) => {
    if (!line.includes("\"turn_context\"")) return;
    try {
      const obj = JSON.parse(line) as { type?: unknown; payload?: { model?: unknown } };
      if (obj.type === "turn_context" && typeof obj.payload?.model === "string" && obj.payload.model.length > 0) model = obj.payload.model;
    } catch {
      // 壊れた行は飛ばす。
    }
  }, { types: ROLLOUT_TURN_CONTEXT_TYPES });
  return readable ? model : null;
}

/** Codex の会話が処理中か（rollout の最後の turn が始まったまま終わっていない）。 */
export function codexRolloutBusy(file: string): boolean {
  return readCodexRollout(file).busy;
}

/**
 * その会話へ Codex の turn の設定（`codexTurn`）を付けて送った最新の依頼の記録（new でも send でも）。Codex の send が
 * 前の方針を引き継ぐ（new で厳しくした方針が緩まない・プランから戻した後にまたプランへ戻らない。Fable レビュー 中2・確かめ 低3）。
 */
export function findLatestCodexTurnRecord(conversationId: string, dir: string = requestsDir()): RequestRecord | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let latest: RequestRecord | null = null;
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RequestRecord;
      if (raw.conversationId !== conversationId || raw.codexTurn === undefined) continue;
      if (latest === null || raw.sentAtMs > latest.sentAtMs) latest = raw;
    } catch {
      // 壊れた記録は飛ばす。
    }
  }
  return latest;
}

/**
 * 返答を読む。`after` があれば、その依頼の発話（送った時刻以降で本文が一致する最初の人の発話）の後の Claude の文章を、
 * 次の人の発話の手前まで。無ければ最後の人の発話の後の文章。依頼の発話がまだ記録に無ければ `found: false`。
 */
export function readReply(lines: readonly TranscriptLine[], after?: { sentAtMs: number; text: string; clientId?: string }): {
  found: boolean;
  reply: string | null;
} {
  let start = -1;
  if (after !== undefined) {
    const want = normalizeForReplyMatch(after.text);
    // 末尾だけの照合は、定型の締め文で終わる別の発話を取り違える（2 周目レビュー 9）。正規化した本文の完全一致で探す。
    // 起点は送る前の時刻（同じホストの時計なので、記録の時刻がそれより前になることはない。遡ると直前の同じ短文を
    // 取り違える。3 周目レビュー 7）。
    // 送った発話の id が記録に残る（Codex の client_id）なら、それで照合する（本文の書き換えに左右されない）。
    start = after.clientId !== undefined
      ? lines.findIndex((line) => line.role === "user" && line.clientId === after.clientId)
      : -1;
    if (start < 0) {
      // 本文で探すときも、別の送信 id が付いた発話（同じ本文の別の依頼）は拾わない（Fable レビュー 低3）。
      start = lines.findIndex((line) => line.role === "user" && line.atMs >= after.sentAtMs &&
        (after.clientId === undefined || line.clientId === undefined || line.clientId === after.clientId) &&
        normalizeForReplyMatch(line.text) === want);
    }
    if (start < 0) return { found: false, reply: null };
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.role === "user") { start = i; break; }
    }
  }
  const parts: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.role === "user") break;
    parts.push(line.text);
  }
  return { found: true, reply: parts.length > 0 ? parts.join("\n\n") : null };
}
