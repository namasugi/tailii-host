// peerSessions.ts
// tailii (TS host) — 同じマシンで生きている Claude Code セッションの登録簿（`~/.claude/sessions/<pid>.json`）
// を読む（peer-sessions）。cross-session messaging（`@名前` 指名 / SendMessage）の宛先候補と、
// 「Tailii 管理外の CLI / Remote Control が同じ会話を掴んでいる」検知（dual-instance の予防）に使う。
//
// 登録簿 1 件（Claude Code 2.1.270 実測）:
//   {"pid":23402,"sessionId":"40ef…","cwd":"/Users/…","startedAt":…,"version":"2.1.270",
//    "kind":"interactive","entrypoint":"cli","messagingSocketPath":"/tmp/cc-socks/23402.sock",
//    "name":"code0630-d2","nameSource":"derived","status":"busy","bridgeSessionId":"session_…"}
// 生存判定は pid の存在（kill 0）で行い、登録簿の残骸（異常終了）は除く。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 登録簿 1 件の正規化形。 */
export interface PeerSessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  /** `busy` | `idle`（不明は null）。 */
  status: string | null;
  kind: string | null;
  entrypoint: string | null;
  /** Remote Control（公式アプリ / claude.ai）にも繋がっているか（`bridgeSessionId` あり）。 */
  bridged: boolean;
  messagingSocketPath: string | null;
  startedAt: number | null;
}

/** 既定の登録簿ディレクトリ。 */
export function defaultPeerSessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

/** 登録簿 JSON 1 件を寛容に読む（必須: pid / sessionId / cwd / name）。 */
export function parsePeerSessionRecord(raw: unknown): PeerSessionRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const pid = rec["pid"];
  const sessionId = rec["sessionId"];
  const cwd = rec["cwd"];
  const name = rec["name"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  const str = (key: string): string | null =>
    typeof rec[key] === "string" && (rec[key] as string).length > 0 ? (rec[key] as string) : null;
  return {
    pid,
    sessionId,
    cwd,
    name,
    status: str("status"),
    kind: str("kind"),
    entrypoint: str("entrypoint"),
    bridged: str("bridgeSessionId") !== null,
    messagingSocketPath: str("messagingSocketPath"),
    startedAt: typeof rec["startedAt"] === "number" ? (rec["startedAt"] as number) : null,
  };
}

export interface PeerSessionListOptions {
  dir?: string;
  /** pid 生存判定（テスト注入用）。既定は `process.kill(pid, 0)`。 */
  isPidAlive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 存在するが権限なし（別ユーザー）。存在はしているので生存扱い。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 生きているセッションの登録簿を列挙する（名前昇順）。読めない/壊れた件は黙って飛ばす。 */
export function listPeerSessions(options: PeerSessionListOptions = {}): PeerSessionRecord[] {
  const dir = options.dir ?? defaultPeerSessionsDir();
  const isAlive = options.isPidAlive ?? processAlive;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PeerSessionRecord[] = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    } catch {
      continue;
    }
    const record = parsePeerSessionRecord(parsed);
    if (record === null) continue;
    if (!isAlive(record.pid)) continue;
    out.push(record);
  }
  return out.sort((lhs, rhs) => (lhs.name < rhs.name ? -1 : lhs.name > rhs.name ? 1 : 0));
}

/**
 * 会話一覧の行へ「Tailii 管理外の生存インスタンス」を注記する（純関数, peer-live）。
 * Tailii 自身が起動した claude も登録簿に載るため、`liveSessionName`（Tailii の pane）を持つ行には
 * 付けない。同じ会話 id を複数の CLI が掴んでいる場合は Remote Control 接続を優先し、次に名前順。
 */
export function annotatePeerSessions<
  T extends { sessionId: string; agent?: "claude" | "codex"; liveSessionName?: string },
>(sessions: readonly T[], peers: readonly PeerSessionRecord[]): T[] {
  const byConversation = new Map<string, PeerSessionRecord>();
  for (const peer of [...peers].sort((lhs, rhs) => {
    if (lhs.bridged !== rhs.bridged) return lhs.bridged ? -1 : 1;
    return lhs.name < rhs.name ? -1 : lhs.name > rhs.name ? 1 : 0;
  })) {
    if (!byConversation.has(peer.sessionId)) byConversation.set(peer.sessionId, peer);
  }
  return sessions.map((session) => {
    if ((session.agent ?? "claude") !== "claude" || session.liveSessionName !== undefined) return session;
    const peer = byConversation.get(session.sessionId);
    if (peer === undefined) return session;
    return { ...session, peerSessionName: peer.name, ...(peer.bridged ? { peerBridged: true } : {}) };
  });
}
