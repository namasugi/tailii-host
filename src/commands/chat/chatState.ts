// commands/chat/chatState.ts
// `tailii-host chat` の設定・依頼の記録・会話の状態の読み取り（tailii-chat-cli）。
// 状態はホスト上のファイル（Claude Code の登録簿と会話の記録）を直接読む（engine を通さず軽い）。

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectSlug } from "../../shared/paths.js";
import { defaultPeerSessionsDir, parsePeerSessionRecord } from "../../services/peerSessions.js";
import { SessionMetadataStore } from "../../sessions/sessionMetadataStore.js";

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
}

export function botConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "bot.json");
}

export function loadBotConfig(file: string = botConfigPath()): BotConfig {
  const config: BotConfig = { allowedRoots: [os.homedir()], permissionMode: "acceptEdits", allowAuto: false };
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
    return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
  });
}

/** 依頼 ID から決まる値（再試行しても同じ会話名・同じ送信 ID になる）。 */
export function requestDigest(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
}

/** 依頼の記録（`~/.tailii/bot/requests/<digest>.json`）。同じ依頼 ID の打ち直しを二重にしない。 */
export interface RequestRecord {
  requestId: string;
  kind: "new" | "send";
  conversationId: string;
  session: string;
  cwd: string;
  /** 送った時刻（epoch ms）。`status --after` でこの依頼への返答を探す起点。 */
  sentAtMs: number;
  /** 送った本文（返答の起点の照合用）。 */
  text: string;
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
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export type ConversationState = "busy" | "idle" | "not_running";

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
    if (record.status === "busy") return "busy";
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
    if ((type !== "user" && type !== "assistant") || obj["isMeta"] === true || obj["isSidechain"] === true) continue;
    const message = obj["message"] as { role?: unknown; content?: unknown } | undefined;
    const text = textOf(message?.content).trim();
    if (text.length === 0) continue;
    // 人の発話のうち、コマンドの記録・注入（`<command-…>` `<local-command-…>` `<system-reminder>` など）は除く。
    if (type === "user" && /^<(?:command-|local-command-|system-reminder|bash-|task-notification)/.test(text)) continue;
    const ts = typeof obj["timestamp"] === "string" ? Date.parse(obj["timestamp"]) : Number.NaN;
    out.push({ role: type, text, atMs: Number.isFinite(ts) ? ts : 0 });
  }
  return out;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, "");
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
    const want = normalize(after.text);
    start = lines.findIndex((line) => line.role === "user" && line.atMs >= after.sentAtMs - 5_000 &&
      (normalize(line.text) === want || normalize(line.text).includes(want.slice(-48))));
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
