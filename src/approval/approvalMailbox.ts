// approval/approvalMailbox.ts
// 承認の受け渡し口（tailii-chat-cli 第 2 段）。承認フックは待っている承認を `~/.tailii/approvals/<会話名>/<承認 id>.json` に
// 書き出し、`tailii-host chat approve` が置いた決定ファイル（`<承認 id>.decision`）をアプリの返事と並べて待つ（早い方で決める）。
// アプリがつながっているかに関わらず効く。同じ利用者のファイルなので、誤操作の防止であって防御ではない（SSH 鍵は共用）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** 待っている承認の記録。 */
export interface PendingApprovalRecord {
  id: string;
  /** Tailii の会話名。 */
  session: string;
  tool: string;
  summary: string;
  cwd: string;
  /** 書き出した時刻（epoch ms）。 */
  atMs: number;
  /** 待っている承認フックのプロセス（居なければ残骸）。 */
  pid: number;
  /** この時刻まで PermissionRequest が画面と並行して承認を待つ。旧方式と Codex では省略。 */
  permissionRequestUntilMs?: number;
  agentId?: string;
  agentType?: string;
}

export interface ApprovalDecisionRecord {
  decision: "allow" | "deny";
  reason?: string;
  /** 決めた側（"cli" など。記録用）。 */
  by?: string;
  atMs: number;
}

/** 承認 id（Claude はフックの UUID、Codex は `codex:<thread>:<要求 id>`）。先頭は英数字（`.` 始まりの名前を作らない）。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export function defaultApprovalsBase(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "approvals");
}

/** 会話名・承認 id がファイル名に使えるか（`/` や `..` で外へ出さない）。 */
function safeName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.includes("/") && !value.includes("\0") && value !== "." && value !== "..";
}

function dirOf(session: string, base: string): string | null {
  return safeName(session) ? path.join(base, session) : null;
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 待っている承認を書き出す（失敗は握り潰す: 承認の流れそのものは止めない）。 */
export function writePendingApproval(record: PendingApprovalRecord, base: string = defaultApprovalsBase()): void {
  const dir = dirOf(record.session, base);
  if (dir === null || !ID_PATTERN.test(record.id)) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(dir, `${record.id}.json`), JSON.stringify(record));
  } catch {
    // 書けなくても承認はアプリで続けられる。
  }
}

/**
 * 承認の記録と決定ファイルを片付ける。CLI が決定を置いていた（`.decision` があった）ときは、決めた側と決定を
 * `<id>.result` に残す（CLI が読んで消す。アプリが先に答えた場合に「CLI で決まった」と取り違えない）。フォルダは消さない
 * （同じ会話で並んだ別の承認が、消した直後に書けずに捨てられるため）。
 */
export function removePendingApproval(
  session: string,
  id: string,
  base: string = defaultApprovalsBase(),
  outcome?: { decision: "allow" | "deny"; by: "cli" | "app" | "timeout" },
): void {
  const dir = dirOf(session, base);
  if (dir === null || !ID_PATTERN.test(id)) return;
  if (outcome !== undefined && fs.existsSync(path.join(dir, `${id}.decision`))) {
    try { writeAtomic(path.join(dir, `${id}.result`), JSON.stringify({ ...outcome, atMs: Date.now() })); } catch { /* 最善努力 */ }
  }
  for (const name of [`${id}.json`, `${id}.decision`]) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* 無い */ }
  }
  removeStaleResults(dir);
}

/** CLI が読まなかった古い結果（1 時間超）を消す。 */
function removeStaleResults(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith(".result")) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* 他が消した */ }
  }
}

/** 承認フックが残した結果（決めた側と決定）を読んで消す。まだ無ければ null。 */
export function takeApprovalResult(
  session: string,
  id: string,
  base: string = defaultApprovalsBase(),
): { decision: "allow" | "deny"; by: string } | null {
  const dir = dirOf(session, base);
  if (dir === null || !ID_PATTERN.test(id)) return null;
  const file = path.join(dir, `${id}.result`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    try { fs.unlinkSync(file); } catch { /* 他が消した */ }
    if ((raw["decision"] !== "allow" && raw["decision"] !== "deny") || typeof raw["by"] !== "string") return null;
    return { decision: raw["decision"], by: raw["by"] };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parsePending(raw: unknown): PendingApprovalRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["session"] !== "string" || typeof r["tool"] !== "string" ||
    typeof r["summary"] !== "string" || typeof r["cwd"] !== "string" || typeof r["atMs"] !== "number" ||
    typeof r["pid"] !== "number") return null;
  return {
    id: r["id"], session: r["session"], tool: r["tool"], summary: r["summary"], cwd: r["cwd"], atMs: r["atMs"], pid: r["pid"],
    ...(typeof r["permissionRequestUntilMs"] === "number" ? { permissionRequestUntilMs: r["permissionRequestUntilMs"] } : {}),
    ...(typeof r["agentId"] === "string" ? { agentId: r["agentId"] } : {}),
    ...(typeof r["agentType"] === "string" ? { agentType: r["agentType"] } : {}),
  };
}

/** 会話名の待っている承認（待っているフックが生きているものだけ。古い順）。 */
export function listPendingApprovals(session: string, base: string = defaultApprovalsBase()): PendingApprovalRecord[] {
  const dir = dirOf(session, base);
  if (dir === null) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PendingApprovalRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: PendingApprovalRecord | null;
    try {
      record = parsePending(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {
      continue;
    }
    if (record === null || record.session !== session || `${record.id}.json` !== name || !pidAlive(record.pid)) continue;
    out.push(record);
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** 承認 id から待っている承認を探す（全会話から）。 */
export function findPendingApproval(id: string, base: string = defaultApprovalsBase()): PendingApprovalRecord | null {
  if (!ID_PATTERN.test(id)) return null;
  let sessions: string[];
  try {
    sessions = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const session of sessions) {
    const found = listPendingApprovals(session, base).find((record) => record.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * 決定を置く（排他作成。既に決定があれば置かずにその決定を返す）。
 * 戻り値: `written` = 置いた / `exists` = 先に決定があった（その中身）/ `invalid` = 名前が不正。
 */
export function writeApprovalDecision(
  session: string,
  id: string,
  decision: ApprovalDecisionRecord,
  base: string = defaultApprovalsBase(),
): { status: "written" } | { status: "exists"; existing: ApprovalDecisionRecord | null } | { status: "invalid" } {
  const dir = dirOf(session, base);
  if (dir === null || !ID_PATTERN.test(id)) return { status: "invalid" };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(dir, `${id}.decision`), JSON.stringify(decision), { flag: "wx", mode: 0o600 });
    // 書いている間に承認が終わっていたら（記録が消えた）、置いた決定を残さない（誰も読まない）。
    if (!fs.existsSync(path.join(dir, `${id}.json`))) {
      try { fs.unlinkSync(path.join(dir, `${id}.decision`)); } catch { /* 消えている */ }
      return { status: "exists", existing: null };
    }
    return { status: "written" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { status: "exists", existing: readApprovalDecision(session, id, base) };
  }
}

export function readApprovalDecision(session: string, id: string, base: string = defaultApprovalsBase()): ApprovalDecisionRecord | null {
  const dir = dirOf(session, base);
  if (dir === null || !ID_PATTERN.test(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.decision`), "utf8")) as Record<string, unknown>;
    if (raw["decision"] !== "allow" && raw["decision"] !== "deny") return null;
    return {
      decision: raw["decision"],
      atMs: typeof raw["atMs"] === "number" ? raw["atMs"] : 0,
      ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
      ...(typeof raw["by"] === "string" ? { by: raw["by"] } : {}),
    };
  } catch {
    return null;
  }
}

/** 決定ファイルが置かれるまで待つ（期限・中止で null）。 */
export async function waitForMailboxDecision(
  session: string,
  id: string,
  deadlineAtMs: number,
  signal: AbortSignal,
  options: { base?: string; intervalMs?: number } = {},
): Promise<ApprovalDecisionRecord | null> {
  const base = options.base ?? defaultApprovalsBase();
  const interval = options.intervalMs ?? 500;
  while (!signal.aborted) {
    const decision = readApprovalDecision(session, id, base);
    if (decision !== null) return decision;
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(interval, remaining));
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
  return null;
}

/** Bot（`tailii-host chat`）に承認の許可を許しているか（`~/.tailii/bot.json` の `allowApprove`）。 */
export function botMayApprove(file: string = path.join(os.homedir(), ".tailii", "bot.json")): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return raw["allowApprove"] === true;
  } catch {
    return false;
  }
}

/** `tailii-host chat` が起動した会話か（会話名 `s-cli…`）。 */
export function isCliSession(session: string): boolean {
  return /^s-cli[0-9a-f]{16}$/.test(session);
}
