// hubStartup.ts
// tailii (TS host) — Session Hub の単一起動（OS が解放する排他）
//
// hub として動いてよいのは同時に 1 プロセスだけ。以前は `hub.lock`（pid と版の JSON）を「生きている pid か」で
// 判定して奪い合い、同時起動で両方が取得に成功する競合があった（ロックの不在を見た B が、A の作った lock を消す）。
// socket も「生存確認で応答が無ければ消して listen」だったので、両方の確認が先に走ると後発が先発の socket 名を消せた。
//
// ここでは排他の根拠を SQLite の排他ロックに移す（`node:sqlite`）。ロック用の小さな DB ファイル（`hub.lock.db`）を開き、
// 排他のトランザクション（`BEGIN EXCLUSIVE`）を hub の生存期間中ずっと持つ。SQLite は OS のファイルロック（fcntl）を
// 使うので、プロセスが落ちれば（kill -9 でも）OS が解放する。古いロックを時刻や pid で判定して回収する処理は無い
// （= 回収の競合も無い）。取れなかった側は何も消さずに退く。
//
// `hub.lock`（pid と版）は従来どおり書く。ensureHubDaemon が「動いている hub の版」を知り、版違いを SIGTERM で
// 入れ替えるための情報で、排他の根拠には使わない。socket のパスを消してよいのは排他を持つプロセスだけ。
//
// **単一起動の保証は Node 22.13 以降（`node:sqlite` がフラグ無しで使える版）に限る。** それより古い Node では
// "unsupported" を返し、呼び手は従来の判定（pid の lock と socket の生存確認）に戻る。これは対応外の Node での最善努力で、
// 同時起動の競合が残る（doctor が警告し、hub の起動ログにも退避した事実を残す）。
// このファイルは node: の組み込みだけに依存する（別プロセスの起動競合テストが型を外して直接読み込む）。

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

/** 保持中の排他。release は 1 回だけ効く（2 回目以降は何もしない）。 */
export interface HubExclusiveLock {
  release(): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
}
type SqliteDatabaseConstructor = new (file: string, options?: Record<string, unknown>) => SqliteDatabase;

let sqliteConstructor: SqliteDatabaseConstructor | null | undefined;

/** `node:sqlite` を読み込む（無ければ null）。22.13〜 の実験的機能の警告は、この読み込みでだけ握り潰す。 */
function loadSqlite(): SqliteDatabaseConstructor | null {
  if (sqliteConstructor !== undefined) return sqliteConstructor;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /sqlite/iu.test(text)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    sqliteConstructor = (require("node:sqlite") as { DatabaseSync: SqliteDatabaseConstructor }).DatabaseSync;
  } catch {
    sqliteConstructor = null;
  } finally {
    process.emitWarning = original;
  }
  return sqliteConstructor;
}

/** この Node で `node:sqlite` が実際に使えるか（版だけでなく、起動設定で無効にされていないか。doctor が使う）。 */
export function isNodeSqliteAvailable(): boolean {
  return loadSqlite() !== null;
}

/** プロセスの引数。Linux は /proc の argv（NUL 区切り = 引数の境界つき）、それ以外は ps の 1 行（境界なし）。 */
export type ProcessArgs =
  | { kind: "argv"; argv: string[] }
  | { kind: "command"; command: string }
  /** そのプロセスは居ない。 */
  | { kind: "gone" }
  /** 取得に失敗した（ps の失敗・時間切れ等）。 */
  | { kind: "unknown" };

export function readProcessArgs(pid: number): ProcessArgs {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((part) => part.length > 0);
    if (argv.length > 0) return { kind: "argv", argv };
  } catch (error) {
    // Linux で /proc はあるのにその pid が無い = 居ない。/proc の無い macOS は ps へ。
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fs.existsSync("/proc/self/cmdline")) return { kind: "gone" };
  }
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return command.length > 0 ? { kind: "command", command } : { kind: "unknown" };
  } catch (error) {
    // ps は該当 pid が無いと何も出さずに終了コード 1 で終わる。それ以外（時間切れ・起動失敗）は確認できない。
    const failure = error as { status?: unknown; stdout?: unknown };
    return failure.status === 1 && String(failure.stdout ?? "").trim().length === 0 ? { kind: "gone" } : { kind: "unknown" };
  }
}

/** 自分自身の `cli.js`（dist/hub/hubStartup.js から見た dist/cli.js）。 */
export function ownCliPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function realpathOr(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * Tailii の `cli.js` か。自分の `cli.js` の実パスと一致するか、別の場所に入った版（版違いの入れ替えの相手）として
 * パッケージ名が分かる形（実パスが `/tailii-host/` の下の `dist/cli.js`）。symlink（npm の bin 等）は解決して比べる。
 */
export function isTailiiCliPath(script: string, ownCli: string = ownCliPath()): boolean {
  const resolved = realpathOr(script);
  return resolved === realpathOr(ownCli) || resolved === ownCli || /\/tailii-host\/(?:[^/]+\/)*dist\/cli\.js$/u.test(resolved);
}

const NODE_EXECUTABLE = /(?:^|\/)node(?:js)?$/u;

/**
 * プロセスが tailii の hub か（"hub" / "other" / "gone" / "unknown"）。
 * hub とみなす形: 実行プログラムが node で、node のオプション（`-` で始まる引数）の後のスクリプトが Tailii の `cli.js`
 * （`isTailiiCliPath`）で、その直後のサブコマンドが `hub`。
 * - Linux: argv の境界をそのまま使う。
 * - macOS（ps の 1 行・境界なし）: 自分の `cli.js` のパス（と実パス）を既知の文字列として探し、その前が node の実行パス
 *   （空白を含んでもよい）+ オプション、直後が ` hub` の並びなら hub。別の場所の版は空白を含まないパスでだけ見つける。
 * 取得できなければ "unknown"（呼び手は hub かどうかを断定しない）。
 */
export function classifyHubProcess(
  pid: number,
  readArgs: (pid: number) => ProcessArgs = readProcessArgs,
  ownCli: string = ownCliPath(),
): "hub" | "other" | "gone" | "unknown" {
  const args = readArgs(pid);
  if (args.kind === "gone" || args.kind === "unknown") return args.kind;
  if (args.kind === "argv") {
    const [exe, ...rest] = args.argv;
    if (exe === undefined || !NODE_EXECUTABLE.test(exe)) return "other";
    const scriptIndex = rest.findIndex((arg) => !arg.startsWith("-"));
    if (scriptIndex < 0) return "other";
    return isTailiiCliPath(rest[scriptIndex]!, ownCli) && rest[scriptIndex + 1] === "hub" ? "hub" : "other";
  }
  const command = args.command;
  for (const cli of new Set([ownCli, realpathOr(ownCli)])) {
    let from = 0;
    for (;;) {
      const index = command.indexOf(` ${cli} hub`, from);
      if (index < 0) break;
      from = index + 1;
      const after = command.charAt(index + cli.length + 5);
      const prefix = command.slice(0, index);
      if ((after === "" || after === " ") && /(?:^|\/)node(?:js)?(?:\s+-\S+)*$/u.test(prefix)) return "hub";
    }
  }
  const other = /^(?:\S*\/)?node(?:js)?(?:\s+-\S+)*\s+(\S+)\s+hub(?:\s|$)/u.exec(command);
  return other !== null && isTailiiCliPath(other[1]!, ownCli) ? "hub" : "other";
}

/** `hub.lock` に対応する排他用のファイル。 */
export function hubExclusiveLockPath(lockPath: string): string {
  return `${lockPath}.db`;
}

/** 排他を取れなかった理由のうち、保存先の障害（破損・権限・I/O）。BUSY（他が保持中）とは分ける。 */
export class HubExclusiveLockError extends Error {
  constructor(detail: string) {
    super(`hub の排他ロックの保存先を使えません: ${detail}`);
    this.name = "HubExclusiveLockError";
  }
}

/** SQLite の BUSY / LOCKED（他の接続が保持中）か。 */
function isBusyError(error: unknown): boolean {
  const record = error as { errcode?: unknown; message?: unknown };
  const code = typeof record?.errcode === "number" ? record.errcode & 0xff : null;
  if (code === 5 || code === 6) return true;
  return typeof record?.message === "string" && /database is locked|database table is locked/iu.test(record.message);
}

/**
 * 排他を取る。取れたら保持中の排他、他のプロセスが持っていれば null（BUSY）、`node:sqlite` が無ければ "unsupported"。
 * 保存先の障害（DB の破損・権限・I/O）は HubExclusiveLockError を投げる（既存の hub が居ると誤診して正常終了しない）。
 * 待たない（busy timeout 0）。持ち主が落ちていれば OS が解放済みなので、そのまま取れる。DB ファイルは消さない。
 */
export function acquireHubExclusiveLock(exclusivePath: string): HubExclusiveLock | null | "unsupported" {
  const DatabaseSync = loadSqlite();
  if (DatabaseSync === null) return "unsupported";
  let db: SqliteDatabase;
  try {
    fs.mkdirSync(path.dirname(exclusivePath), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(exclusivePath, { timeout: 0 });
  } catch (error) {
    if (isBusyError(error)) return null;
    throw new HubExclusiveLockError(error instanceof Error ? error.message : String(error));
  }
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    try { db.close(); } catch { /* 開けただけの接続を閉じる。 */ }
    if (isBusyError(error)) return null;
    throw new HubExclusiveLockError(error instanceof Error ? error.message : String(error));
  }
  try { fs.chmodSync(exclusivePath, 0o600); } catch { /* 権限を揃えられなくても排他は効く。 */ }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try { db.exec("ROLLBACK"); } catch { /* 閉じれば解放される。 */ }
      try { db.close(); } catch { /* プロセスの終了でも OS が解放する。 */ }
    },
  };
}

/** socket に接続できるか（応答する hub が居るか）。 */
export function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export type HubStartupClaim =
  | { kind: "claimed"; exclusive: HubExclusiveLock }
  /** 他の hub が排他を持っている・従来版の hub が socket で応答している（応答し始めた）。何も消さずに退く。 */
  | { kind: "busy"; reason: "exclusive-held" | "socket-alive" }
  /**
   * 生きている従来版の hub が応答もせず終了の要求にも応じない、または生きている旧所有者の実体を確認できない。
   * 起動を見送る（呼び手が理由を残す）。
   */
  | { kind: "failed"; reason: "legacy-owner-unresponsive" | "owner-unverifiable"; pid: number }
  /** `node:sqlite` が無い。呼び手は従来の判定（pid の lock）に戻る。 */
  | { kind: "unsupported" };

/** BUSY のときの取り直しの回数と間隔（ms）。SQLite の段階的なロック取得で、同時に取りに行った全員が退くのを防ぐ。 */
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BASE_MS = 20;
/** `hub.lock` に生きている別の pid（listen 前の従来版 hub）が居るとき、socket が応答し始めるのを待つ上限（ms）。 */
const LEGACY_OWNER_WAIT_MS = 3_000;
const LEGACY_OWNER_POLL_MS = 100;
/** 応答しない従来版の hub へ終了を要求した後、終了を待つ上限（ms）。従来版の graceful shutdown（最大 20 秒）より長く。 */
const LEGACY_OWNER_TERMINATE_WAIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ClaimHubStartupOptions {
  lockPath: string;
  socketPath: string;
  version: string | null;
  pid?: number;
  /** テスト注入用。 */
  isPidAlive?: (pid: number) => boolean;
  classifyProcess?: (pid: number) => "hub" | "other" | "gone" | "unknown";
  sendTerminate?: (pid: number) => void;
  legacyOwnerTerminateWaitMs?: number;
  legacyOwnerWaitMs?: number;
  legacyOwnerPollMs?: number;
  busyRetryAttempts?: number;
}

/**
 * hub として起動してよいかを決める。排他を取れたプロセスだけが `hub.lock` を書き、残っている socket の名前を消す。
 * （`hub.lock` の生きている別の pid が応答しないまま待ちを過ぎたら、実体が hub なら SIGTERM して終了を確かめてから
 * 引き継ぐ。終了しなければ "failed"。hub でない pid（再利用）なら何も送らずに引き継ぐ。）
 * - BUSY は短い間隔で数回だけ取り直す（同時に取りに行った全員が退いて勝者が 0 になるのを防ぐ）。持ち主が居れば退く。
 * - 排他を取っても、従来版（この排他を使わない）の hub が socket で応答していれば退く（版の入れ替えの間に 2 つ動かない。
 *   従来どおり、その hub が終われば次の起動で引き継ぐ）。
 * - `hub.lock` に自分以外の生きている pid がある（従来版が lock を取って listen する直前かもしれない）なら、socket が
 *   応答し始めるのを数秒だけ待ち、応答したら退く。応答しないまま過ぎたら引き継ぐ（固まった従来版に永久に譲らない）。
 * 保存先の障害は HubExclusiveLockError を投げる（呼び手は理由を記録して失敗終了する）。
 */
export async function claimHubStartup(options: ClaimHubStartupOptions): Promise<HubStartupClaim> {
  const attempts = options.busyRetryAttempts ?? BUSY_RETRY_ATTEMPTS;
  let exclusive: HubExclusiveLock | null | "unsupported" = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    exclusive = acquireHubExclusiveLock(hubExclusiveLockPath(options.lockPath));
    if (exclusive !== null) break;
    if (attempt + 1 < attempts) await sleep(BUSY_RETRY_BASE_MS + Math.floor(Math.random() * BUSY_RETRY_BASE_MS * 2));
  }
  if (exclusive === "unsupported") return { kind: "unsupported" };
  if (exclusive === null) return { kind: "busy", reason: "exclusive-held" };
  const held = exclusive;
  try {
    if (await isSocketAlive(options.socketPath)) {
      held.release();
      return { kind: "busy", reason: "socket-alive" };
    }
    const self = options.pid ?? process.pid;
    const alive = options.isPidAlive ?? processAlive;
    const lockPid = readLockPid(options.lockPath);
    if (lockPid !== null && lockPid !== self && alive(lockPid)) {
      const pollMs = options.legacyOwnerPollMs ?? LEGACY_OWNER_POLL_MS;
      // 生きている所有者が居る間は socket が応答するか・所有者が消えるかを待つ。応答したら退く。
      // 引き継いでよいのは、最初に捕まえた旧 pid が実際に終了したときだけ（lock の読み込みの失敗や書き換えでは判断しない）。
      const waitWhileOwnerAlive = async (limitMs: number): Promise<"socket-alive" | "owner-gone" | "timeout"> => {
        const deadline = Date.now() + limitMs;
        while (Date.now() < deadline) {
          await sleep(pollMs);
          if (await isSocketAlive(options.socketPath)) return "socket-alive";
          if (!alive(lockPid)) return "owner-gone";
        }
        return "timeout";
      };
      let waited = await waitWhileOwnerAlive(options.legacyOwnerWaitMs ?? LEGACY_OWNER_WAIT_MS);
      // 時間切れだけで生きている旧所有者を追い越さない（止まっていた旧版が後で再開して socket 名を消すと 2 つ動く）。
      // 実体が tailii の hub なら終了を要求し、終了を確かめてから引き継ぐ。hub でない（pid の再利用）なら何も送らない。
      const identity = waited === "timeout" ? (options.classifyProcess ?? classifyHubProcess)(lockPid) : null;
      if (identity === "unknown") {
        // 生きている旧所有者が hub かどうか確認できない。断定して追い越さず、起動を見送る。
        held.release();
        return { kind: "failed", reason: "owner-unverifiable", pid: lockPid };
      }
      if (identity === "hub") {
        try {
          (options.sendTerminate ?? ((pid: number) => process.kill(pid, "SIGTERM")))(lockPid);
        } catch {
          // 既に消えていれば次の確認で分かる。
        }
        waited = await waitWhileOwnerAlive(options.legacyOwnerTerminateWaitMs ?? LEGACY_OWNER_TERMINATE_WAIT_MS);
        if (waited === "timeout") {
          held.release();
          return { kind: "failed", reason: "legacy-owner-unresponsive", pid: lockPid };
        }
      }
      // 待つ間に旧所有者が終わった直後に、別の従来版が応答し始めていないかも確かめ直す。
      if (waited === "socket-alive" || await isSocketAlive(options.socketPath)) {
        held.release();
        return { kind: "busy", reason: "socket-alive" };
      }
    }
    // 排他を持つのは自分だけ。前の持ち主（落ちた hub・応答しない従来版）の残した socket の名前を消してよい。
    fs.rmSync(options.socketPath, { force: true });
    fs.mkdirSync(path.dirname(options.lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(options.lockPath, JSON.stringify({ pid: self, version: options.version }));
    return { kind: "claimed", exclusive: held };
  } catch (error) {
    held.release();
    throw error;
  }
}
