// peerTakeover.ts
// tailii (TS host) — 他所で動いている同じ会話の Claude を調べ、確認のうえで終了させて Tailii で開き直す（peer-takeover）。
//
// 会話を開く（session_start の resume）前に、その会話 id を掴んでいる Claude を `~/.claude/sessions/<pid>.json`
// （Claude Code の登録簿）から列挙し、次のどれかに分類する:
// - none:      他所では動いていない → そのまま起動する
// - takeover:  利用者が端末で自分で起動した Claude（herdr のタブ・普通のターミナル）→ 確認のうえ終了させて開き直せる
// - parallel:  公式アプリ・Remote Control・Tailii の別の会話の中など、終了させてはいけない相手 → 従来どおり並走の確認
// - unknown:   判別できない（プロセスが読めない・複数・途中で変わった）→ 終了させない
//
// 安全の要（Fable レビュー A-1 / 1-1 / 1-2 / 1-3）:
// - 本人確認: 登録簿の `procStart` と `TZ=UTC ps -o lstart` の一致・プロセス名が claude・登録簿の会話 id。pid の再利用で
//   別のプロセスを殺さない。確認時と終了の直前の 2 回評価する（`verifyTakeover`）。
// - Tailii 自身の Claude は引数のフック設定（`… hook … --session <名前>`）で見分け、終了させない。
// - 対象は正の条件を全部満たすものだけ: 制御端末がある・端末の前面で止まっていない・親が対話シェル・祖先に claude が
//   居ない・同じユーザー・登録簿が interactive / cli / Remote Control 非接続 / 同じ pid の名前空間。
// - シグナルは pid だけに SIGTERM。プロセスグループへは送らない。終わらなければ SIGKILL に上げず失敗にする。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultPeerSessionsDir,
  parsePeerSessionRecord,
  type PeerSessionRecord,
} from "./peerSessions.js";

/** 調べたプロセス 1 つ分（`ps` の値）。 */
export interface PeerProcess {
  pid: number;
  ppid: number;
  uid: number;
  /** 制御端末（`ttys015` など）。無ければ null。 */
  tty: string | null;
  /** `ps` の STAT（`S+` など）。`+` が端末の前面、先頭 `T` が停止中。 */
  stat: string;
  /** 起動時刻（`TZ=UTC ps -o lstart` の形。空白は 1 つに詰める）。 */
  startedUtc: string;
  /** 実行ファイル名（basename。ログインシェルの先頭 `-` は外す）。 */
  comm: string;
}

/** 調べる手段（テストで差し替える）。 */
export interface PeerProbe {
  /** 全プロセスの表（pid → プロセス）。読めなければ null。 */
  processTable(): Promise<Map<number, PeerProcess> | null>;
  /** プロセスの引数の全文。読めなければ null。 */
  args(pid: number): Promise<string | null>;
  /** プロセスの環境変数のうち `HERDR_` で始まるもの。読めなければ null。 */
  herdrEnv(pid: number): Promise<Record<string, string> | null>;
  /** 登録簿（生存判定はしない。分類側が processTable で見る）。 */
  registry(): PeerSessionRecord[];
  /** このプロセスの uid。 */
  uid(): number;
  /** このホストの pid の名前空間（登録簿の `pidDomain` と比べる。macOS は "darwin"）。 */
  pidDomain(): string;
  /** 対象を終了させて終わったのを確かめる（テストで差し替える。既定は `terminateTakeoverTarget`）。 */
  terminate?(target: TakeoverTarget): Promise<boolean>;
}

/** 開き直しの対象（Tailii の外で、利用者が端末で起動した Claude）。 */
export interface TakeoverTarget {
  pid: number;
  /** 登録簿の `procStart`（本人確認の鍵）。 */
  procStart: string;
  conversationId: string;
  /** 登録簿の名前（Claude Code のセッション名。確認文の表示用）。 */
  name: string;
  busy: boolean;
  /** herdr のタブで動いていれば、その herdr セッションと pane（環境変数の手がかり。配置にだけ使う）。 */
  herdr: { session: string; paneId: string } | null;
}

export type PeerHolderKind = "herdr" | "terminal" | "remote" | "tailii" | "other";

export type PeerClassification =
  | { kind: "none" }
  | { kind: "takeover"; target: TakeoverTarget }
  | {
      kind: "parallel";
      /** 相手の種類（表示用）。 */
      holder: PeerHolderKind;
      name: string;
      busy: boolean;
      /** Tailii の別の会話の中なら、その Tailii の会話名。 */
      tailiiSession?: string;
      reason: string;
    }
  | { kind: "unknown"; reason: string };

/** シェルとみなす実行ファイル名（親が対話シェルかの判定）。 */
const INTERACTIVE_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "elvish"]);
const VERSION_NAME = /^\d+\.\d+\.\d+$/;

function normalizeStart(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function basename(comm: string): string {
  return path.basename(comm.trim()).replace(/^-/, "");
}

/** Claude Code の本体か（`claude`、ネイティブ版は版番号の名前で見えることがある）。 */
function isClaudeComm(comm: string, record?: PeerSessionRecord): boolean {
  const name = basename(comm);
  if (name === "claude") return true;
  return VERSION_NAME.test(name) && record?.version === name;
}

/** 引数のフック設定から Tailii のセッション名を取り出す（Tailii が起動した Claude だけが持つ）。 */
export function tailiiSessionFromArgs(args: string): string | null {
  if (!/\bhook\b/.test(args)) return null;
  const match = /--session[\s="\\]+([A-Za-z0-9_][A-Za-z0-9._-]{0,127})/.exec(args.replace(/--session-id\S*\s+\S+/g, ""));
  return match?.[1] ?? null;
}

/** 親のコマンド行が対話シェルか（`-c` で何かを実行しているシェルは対話ではない）。 */
function isInteractiveShell(proc: PeerProcess, args: string | null): boolean {
  if (!INTERACTIVE_SHELLS.has(proc.comm)) return false;
  if (args === null) return false;
  const tokens = args.trim().split(/\s+/).slice(1);
  return !tokens.some((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
}

/**
 * 会話 id を掴んでいる Claude を分類する。
 * @param isTailiiSession 名前が Tailii のセッション（メタあり）か。
 * @param verifyHerdrPane herdr の pane の前面にその pid が居るかを確かめる（配置の手がかりの検証。省略時は確かめない）。
 */
export async function classifyPeers(
  conversationId: string,
  probe: PeerProbe,
  isTailiiSession: (name: string) => boolean,
  verifyHerdrPane?: (session: string, paneId: string, pid: number) => Promise<boolean>,
): Promise<PeerClassification> {
  const records = probe.registry().filter((record) => record.sessionId === conversationId);
  if (records.length === 0) return { kind: "none" };
  const table = await probe.processTable();
  if (table === null) return { kind: "unknown", reason: "プロセスの一覧を読めませんでした" };
  // 登録簿の残骸（pid が無い・別のプロセスに再利用されている）は数えない。
  const live = records.filter((record) => {
    const proc = table.get(record.pid);
    return proc !== undefined && record.procStart !== null && normalizeStart(record.procStart) === proc.startedUtc;
  });
  if (live.length === 0) return { kind: "none" };
  if (live.length > 1) {
    return { kind: "unknown", reason: "同じ会話が 2 か所以上で動いています" };
  }
  const record = live[0]!;
  const proc = table.get(record.pid)!;
  const busy = record.status === "busy";
  if (!isClaudeComm(proc.comm, record)) {
    return { kind: "unknown", reason: "動いているプロセスを Claude と確かめられませんでした" };
  }
  const args = await probe.args(record.pid);
  if (args === null) return { kind: "unknown", reason: "動いているプロセスを読めませんでした" };
  const tailiiSession = tailiiSessionFromArgs(args);
  if (tailiiSession !== null && isTailiiSession(tailiiSession)) {
    return {
      kind: "parallel", holder: "tailii", name: record.name, busy, tailiiSession,
      reason: "Tailii の別の会話の中で開かれています",
    };
  }
  if (record.bridged) {
    return { kind: "parallel", holder: "remote", name: record.name, busy, reason: "公式アプリ（Remote Control）につながっています" };
  }
  const domain = record.pidDomain;
  if (record.kind !== "interactive" || record.entrypoint !== "cli" || (domain !== null && domain !== probe.pidDomain())) {
    return { kind: "parallel", holder: "other", name: record.name, busy, reason: "端末以外のアプリで動いています" };
  }
  const notTarget = (reason: string): PeerClassification =>
    ({ kind: "parallel", holder: "other", name: record.name, busy, reason });
  if (proc.uid !== probe.uid()) return notTarget("別のユーザーのプロセスです");
  if (proc.tty === null) return notTarget("端末につながっていません（背景で実行中）");
  if (!proc.stat.includes("+") || proc.stat.startsWith("T")) return notTarget("端末の前面で動いていません（背景・停止中）");
  const parent = table.get(proc.ppid);
  if (parent === undefined || !isInteractiveShell(parent, await probe.args(parent.pid))) {
    return notTarget("対話シェルから起動されていません");
  }
  for (let ancestor = table.get(parent.ppid), hops = 0; ancestor !== undefined && ancestor.pid > 1 && hops < 64;
    ancestor = table.get(ancestor.ppid), hops++) {
    if (isClaudeComm(ancestor.comm)) return notTarget("別の Claude の中で動いています");
  }
  let herdr: TakeoverTarget["herdr"] = null;
  const env = await probe.herdrEnv(record.pid);
  const session = env?.["HERDR_SESSION"];
  const paneId = env?.["HERDR_PANE_ID"];
  if (session !== undefined && paneId !== undefined && verifyHerdrPane !== undefined &&
    await verifyHerdrPane(session, paneId, record.pid)) {
    herdr = { session, paneId };
  }
  return {
    kind: "takeover",
    target: {
      pid: record.pid,
      procStart: normalizeStart(record.procStart!),
      conversationId,
      name: record.name,
      busy,
      herdr,
    },
  };
}

/** 確認用トークンの有効期間。確認ダイアログを出して答えるまでの時間を見込む。 */
export const TAKEOVER_TOKEN_TTL_MS = 5 * 60 * 1000;

interface TokenBody {
  pid: number;
  start: string;
  conversation: string;
  busy: boolean;
  exp: number;
}

/** 確認の対象を表すトークン（送り直しで返してもらい、その時点の対象と完全一致するときだけ実行する, A-2）。 */
export function takeoverToken(target: TakeoverTarget, nowMs: number = Date.now()): string {
  const body: TokenBody = {
    pid: target.pid,
    start: target.procStart,
    conversation: target.conversationId,
    busy: target.busy,
    exp: nowMs + TAKEOVER_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const digest = createHash("sha256").update(encoded).digest("base64url").slice(0, 12);
  return `${encoded}.${digest}`;
}

export type TakeoverVerdict =
  | { ok: true }
  | { ok: false; reason: "expired" | "changed" | "busy" | "malformed" };

/** トークンが今の対象を指しているか。処理中に変わったのに中断の同意が無ければ busy。 */
export function verifyTakeover(
  token: string,
  current: TakeoverTarget,
  interrupt: boolean,
  nowMs: number = Date.now(),
): TakeoverVerdict {
  const [encoded, digest] = token.split(".");
  if (encoded === undefined || digest === undefined ||
    createHash("sha256").update(encoded).digest("base64url").slice(0, 12) !== digest) {
    return { ok: false, reason: "malformed" };
  }
  let body: TokenBody;
  try {
    body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenBody;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof body.exp !== "number" || body.exp < nowMs) return { ok: false, reason: "expired" };
  if (body.pid !== current.pid || body.start !== current.procStart || body.conversation !== current.conversationId) {
    return { ok: false, reason: "changed" };
  }
  if (current.busy && !interrupt) return { ok: false, reason: "busy" };
  return { ok: true };
}

/**
 * 対象に SIGTERM を送り、プロセスが終わって登録簿から消えるのを待つ（最大 `timeoutMs`）。
 * 終わらなければ SIGKILL に上げず false（Fable レビュー A-4）。
 */
export async function terminateTakeoverTarget(
  target: TakeoverTarget,
  options: {
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    isAlive?: (pid: number) => boolean;
    registryFile?: (pid: number) => string;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<boolean> {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? processAlive;
  const registryFile = options.registryFile ?? ((pid) => path.join(defaultPeerSessionsDir(), `${pid}.json`));
  const timeoutMs = options.timeoutMs ?? 6_000;
  const pollMs = options.pollMs ?? 100;
  try {
    kill(target.pid, "SIGTERM");
  } catch {
    return !isAlive(target.pid);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(target.pid)) {
      // 登録簿の削除は終了の後始末なので、少しだけ待つ（残っても生存判定で残骸として扱われる）。
      for (let i = 0; i < 10 && fs.existsSync(registryFile(target.pid)); i++) await sleep(pollMs);
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(executable: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executable, args, { maxBuffer: 16 * 1024 * 1024, timeout: 5_000, ...(env ? { env } : {}) },
      (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/** `ps -A -o pid=,ppid=,uid=,tty=,stat=,lstart=,comm=` を表にする（lstart は 5 語）。 */
export function parseProcessTable(stdout: string): Map<number, PeerProcess> {
  const table = new Map<number, PeerProcess>();
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 11) continue;
    const [pid, ppid, uid, tty, stat, ...rest] = tokens;
    const startedUtc = rest.slice(0, 5).join(" ");
    const comm = rest.slice(5).join(" ");
    const pidNum = Number(pid);
    if (!Number.isInteger(pidNum) || pidNum <= 0) continue;
    table.set(pidNum, {
      pid: pidNum,
      ppid: Number(ppid),
      uid: Number(uid),
      tty: tty === "??" || tty === "?" || tty === "-" ? null : tty!,
      stat: stat!,
      startedUtc,
      comm: basename(comm),
    });
  }
  return table;
}

/** `ps -E` の出力（コマンド行 + 環境変数）から `HERDR_` の値を取り出す。 */
export function parseHerdrEnv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of stdout.matchAll(/(?:^|\s)(HERDR_[A-Z_]+)=([^\s]+)/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

/** 実プロセスを調べる既定の手段（macOS / Linux）。 */
export function defaultPeerProbe(options: { registryDir?: string } = {}): PeerProbe {
  const registryDir = options.registryDir ?? defaultPeerSessionsDir();
  const utcEnv = { ...process.env, TZ: "UTC", LC_ALL: "C" };
  return {
    async processTable() {
      const out = await run("/bin/ps", ["-A", "-o", "pid=,ppid=,uid=,tty=,stat=,lstart=,comm="], utcEnv);
      return out === null ? null : parseProcessTable(out);
    },
    async args(pid) {
      const out = await run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)]);
      return out === null ? null : out.trim();
    },
    async herdrEnv(pid) {
      if (process.platform === "linux") {
        try {
          const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
          return parseHerdrEnv(raw.split("\0").join(" "));
        } catch {
          return null;
        }
      }
      const out = await run("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)]);
      return out === null ? null : parseHerdrEnv(out);
    },
    registry() {
      let entries: string[];
      try {
        entries = fs.readdirSync(registryDir);
      } catch {
        return [];
      }
      const out: PeerSessionRecord[] = [];
      for (const entry of entries) {
        if (!/^\d+\.json$/.test(entry)) continue;
        try {
          const record = parsePeerSessionRecord(JSON.parse(fs.readFileSync(path.join(registryDir, entry), "utf8")));
          if (record !== null) out.push(record);
        } catch {
          // 書きかけ・壊れた記録は飛ばす。
        }
      }
      return out;
    },
    uid: () => process.getuid?.() ?? -1,
    pidDomain: () => process.platform,
  };
}
