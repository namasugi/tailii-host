// commands/chat/chatState.ts
// `tailii-host chat` の設定・依頼の記録・会話の状態の読み取り（tailii-chat-cli）。
// 状態はホスト上のファイル（Claude Code の登録簿と会話の記録）を直接読む（engine を通さず軽い）。

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectSlug } from "../../shared/paths.js";
import { defaultPeerSessionsDir, parsePeerSessionRecord } from "../../services/peerSessions.js";
import { SessionMetadataStore } from "../../sessions/sessionMetadataStore.js";
import { normalizeForTextMatch } from "../../shared/invisibleText.js";
import { unwrapPastedContent } from "../../shared/pastedContent.js";
import { normalizeTextForPaste } from "../../backend/tmux.js";

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
}

export function botConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "bot.json");
}

export function loadBotConfig(file: string = botConfigPath()): BotConfig {
  const config: BotConfig = {
    allowedRoots: [os.homedir()], permissionMode: "acceptEdits", allowAuto: false, allowApprove: false, allowTakeOver: false,
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
 * 依頼の記録（`~/.tailii/bot/requests/<digest>.json`）。同じ依頼 ID の打ち直しを二重にしない。
 * 起動が済んだ時点（送る前）に `started` で書き、送信が受け付けられたら `sent` にする。打ち直しは `started` なら起動を
 * やり直さずに同じ会話名・同じ送信 ID で送り直し、`sent` なら何もしない（レビュー指摘 A1・A3）。
 */
export interface RequestRecord {
  requestId: string;
  kind: "new" | "send";
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
  let entries: string[];
  try {
    entries = fs.readdirSync(registryDir);
  } catch {
    return "not_running";
  }
  let state: ConversationState = "not_running";
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    let record;
    try {
      record = parsePeerSessionRecord(JSON.parse(fs.readFileSync(path.join(registryDir, entry), "utf8")));
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
    if (record.status === "busy") return "busy";
    if (record.status === "waiting") return "waiting";
    state = "idle";
  }
  return state;
}

/** 会話の記録ファイルを探す（Tailii のメタの作業フォルダ → 全プロジェクトの中から会話 id で）。 */
export function findTranscript(
  conversationId: string,
  options: { store?: SessionMetadataStore; projectsDir?: string; cwdHint?: string } = {},
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
  try {
    for (const slug of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, slug, `${conversationId}.jsonl`);
      if (fs.existsSync(file)) return { file, cwd: null };
    }
  } catch {
    // projects が無い。
  }
  return null;
}

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
  atMs: number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** 会話の記録から、人の発話と Claude の文章だけを古い順に読む（ツールの結果・注入・メタ行は除く）。 */
export function readTranscriptLines(file: string): TranscriptLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: TranscriptLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj["type"];
    const ts = typeof obj["timestamp"] === "string" ? Date.parse(obj["timestamp"]) : Number.NaN;
    const atMs = Number.isFinite(ts) ? ts : 0;
    if (obj["isMeta"] === true || obj["isSidechain"] === true) continue;
    // 処理中の会話へ送った発話は user 行ではなく attachment(queued_command) 行としてだけ残る（transcriptTailer と同じ扱い。
    // 3 周目レビュー 1b）。
    if (type === "attachment") {
      const attachment = obj["attachment"] as { type?: unknown; prompt?: unknown } | undefined;
      if (attachment?.type !== "queued_command" || typeof attachment.prompt !== "string") continue;
      const prompt = unwrapPastedContent(attachment.prompt).trim();
      if (prompt.length > 0) out.push({ role: "user", text: prompt, atMs });
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const message = obj["message"] as { role?: unknown; content?: unknown } | undefined;
    const raw = textOf(message?.content).trim();
    const text = type === "user" ? unwrapPastedContent(raw).trim() : raw;
    if (text.length === 0) continue;
    // 人の発話のうち、コマンドの記録・注入（`<command-…>` `<local-command-…>` `<system-reminder>` など）は除く。
    if (type === "user" && /^<(?:command-|local-command-|system-reminder|bash-|task-notification)/.test(text)) continue;
    out.push({ role: type, text, atMs });
  }
  return out;
}

/**
 * 照合用の正規化。記録に残る本文は、送った本文から hub と Claude Code が変えたもの（制御文字を落とす・貼り付けの包み・
 * 不可視文字を除く）なので、両辺を同じ形にそろえてから空白を除いて比べる（3 周目レビュー 1）。
 */
export function normalizeForReplyMatch(text: string): string {
  return normalizeForTextMatch(unwrapPastedContent(normalizeTextForPaste(text)).normalize("NFC"));
}

/**
 * 返答を読む。`after` があれば、その依頼の発話（送った時刻以降で本文が一致する最初の人の発話）の後の Claude の文章を、
 * 次の人の発話の手前まで。無ければ最後の人の発話の後の文章。依頼の発話がまだ記録に無ければ `found: false`。
 */
export function readReply(lines: readonly TranscriptLine[], after?: { sentAtMs: number; text: string }): {
  found: boolean;
  reply: string | null;
} {
  let start = -1;
  if (after !== undefined) {
    const want = normalizeForReplyMatch(after.text);
    // 末尾だけの照合は、定型の締め文で終わる別の発話を取り違える（2 周目レビュー 9）。正規化した本文の完全一致で探す。
    // 起点は送る前の時刻（同じホストの時計なので、記録の時刻がそれより前になることはない。遡ると直前の同じ短文を
    // 取り違える。3 周目レビュー 7）。
    start = lines.findIndex((line) => line.role === "user" && line.atMs >= after.sentAtMs &&
      normalizeForReplyMatch(line.text) === want);
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
