// claudeLiveStatus.ts
// tailii (TS host) — 稼働中 Claude Code プロセス自身が申告する「いま仕事中か」の読取。
//
// Claude Code（2.1.283 実測）はプロセスごとに `~/.claude/sessions/<pid>.json` を書き、`status` を
// 手元のタスク台帳から直接導出する:
//   - busy    … ターン処理中、または背景のサブエージェント / workflow / teammate が未完了
//   - shell   … ターンは終わったが背景シェル（run_in_background の Bash / Monitor）が実行中
//   - waiting … 承認・入力待ち
//   - idle    … 上記いずれでもない
// Stop hook はサブエージェント実行中（TUI「Waiting for 1 background agent to finish」）でも発火し
// heartbeat を idle にするため、reaper はこの生の申告を見て背景作業中のセッションを殺さない。
// 完了通知（task-notification）に依存しないので、通知が消えても台帳が空になれば idle に落ちる。
//
// 非公開ファイルのため、読めない・形式が違う場合は null（=保護しない、従来どおり）に倒す。
// 異常終了で残った古いファイルがあるので、pid の生存と起動時刻（procStart）の一致を必ず確認する。

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ClaudeLiveStatus = "busy" | "shell" | "waiting" | "idle";

export interface ClaudeLiveRecord {
  pid: number;
  sessionId: string | null;
  status: ClaudeLiveStatus;
  /** status が最後に変わった時刻（Unix ms）。無い版は updatedAt。 */
  statusSinceMs: number | null;
  /** `<tmux session>:@<window>.%<pane>`（tmux 内で起動したときだけ）。 */
  tmux: string | null;
  /** `ps -o lstart=` を UTC で取った書式（pid 再利用の判別用）。 */
  procStart: string | null;
}

/**
 * 既定の置き場（Claude の設定ディレクトリ直下の `sessions`。`CLAUDE_CONFIG_DIR` があればその下）。
 * `TAILII_CLAUDE_SESSIONS_DIR` で差し替え可（テストの隔離用）。
 */
export function defaultClaudeSessionsDir(): string {
  const override = process.env["TAILII_CLAUDE_SESSIONS_DIR"];
  if (override !== undefined) return override;
  const configDir = process.env["CLAUDE_CONFIG_DIR"];
  return path.join(configDir !== undefined && configDir !== "" ? configDir : path.join(os.homedir(), ".claude"), "sessions");
}

function parseStatus(value: unknown): ClaudeLiveStatus | null {
  return value === "busy" || value === "shell" || value === "waiting" || value === "idle" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 1 ファイル分の寛容パース。必須項目（pid / status）が欠けたら null。 */
export function parseClaudeLiveRecord(raw: string): ClaudeLiveRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const pid = finiteNumber(record["pid"]);
  const status = parseStatus(record["status"]);
  if (pid === null || !Number.isInteger(pid) || pid <= 0 || status === null) return null;
  return {
    pid,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : null,
    status,
    statusSinceMs: finiteNumber(record["statusUpdatedAt"]) ?? finiteNumber(record["updatedAt"]),
    tmux: typeof record["tmux"] === "string" ? record["tmux"] : null,
    procStart: typeof record["procStart"] === "string" ? record["procStart"] : null,
  };
}

/** dir 配下の全レコード。dir 不在・個別の壊れは読み飛ばす。 */
export function readClaudeLiveRecords(dir: string): ClaudeLiveRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const records: ClaudeLiveRecord[] = [];
  for (const name of names) {
    try {
      const record = parseClaudeLiveRecord(fs.readFileSync(path.join(dir, name), "utf8"));
      if (record !== null) records.push(record);
    } catch {
      // 読取中に消えた（正常終了の後片付け）等は無視。
    }
  }
  return records;
}

function normalizeSpaces(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * pid が生きていて、かつ記録の起動時刻と一致するか（pid 再利用の取り違えを防ぐ）。
 * 起動時刻が記録に無い・ps が使えないときは生存だけで判定する（保護は 24h 上限で閉じる）。
 */
export async function claudeProcessAlive(pid: number, procStart: string | null): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM は「存在するが権限なし」= 生存。
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (procStart === null) return true;
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 5_000 },
      (error, stdout) => {
        // ps が pid を見つけられない（exit 1・空出力）= 直前に終了した。
        if (stdout.trim() === "") {
          resolve(error === null || (error as { code?: unknown }).code === 1 ? false : true);
          return;
        }
        resolve(normalizeSpaces(stdout) === normalizeSpaces(procStart));
      },
    );
  });
}

/** 背景作業中とみなす status（reaper はこの間 kill しない）。 */
export function isClaudeWorking(status: ClaudeLiveStatus): boolean {
  return status !== "idle";
}

export interface FindClaudeLiveOptions {
  dir: string;
  /** tmux / herdr のセッション名（`cs-*` / `s-*`）。tmux 起動なら `tmux` 欄の先頭と一致する。 */
  sessionName: string;
  /**
   * herdr pane の前面プロセスの pid 群（`pane process-info`）。tmux 欄で当たらず、記録が 1 件でも
   * あるときだけ呼ぶ。null は取得できなかった。
   */
  paneProcessIds?: () => Promise<readonly number[] | null>;
  /**
   * メタに記録された Claude の session id。pid も取れない herdr の最後の手段で、tmux 欄を持たない
   * 生きた記録がちょうど 1 件のときだけ採用する（2 件以上は同じ会話の複製インスタンスがいて曖昧）。
   */
  claudeSessionId?: string;
  processAlive?: (pid: number, procStart: string | null) => boolean | Promise<boolean>;
}

/**
 * 当該セッションの生きている Claude プロセスの申告（全件）。見つからなければ空。
 * 照合は強い順に 1 段だけ使う: tmux 欄のセッション名 → herdr pane の前面 pid → session id。
 * 同じ会話を Mac のターミナル等でも開いている（複製インスタンス）と session id は一致してしまい、
 * 他人の仕事中で放置された複製を守り続けるため、上位の照合が使えたらそれ以外は見ない。
 * 同じ pane / セッションに Claude が複数いる（teammate の分割 pane 等）ことがあるので全件返し、
 * 「どれかが仕事中」「予約の持ち主が含まれるか」は呼び手が判定する。
 */
export async function findClaudeLiveRecords(options: FindClaudeLiveOptions): Promise<ClaudeLiveRecord[]> {
  const alive = options.processAlive ?? claudeProcessAlive;
  const records = readClaudeLiveRecords(options.dir);
  const aliveOf = async (candidates: ClaudeLiveRecord[]): Promise<ClaudeLiveRecord[]> => {
    const result: ClaudeLiveRecord[] = [];
    for (const record of candidates) {
      if (await alive(record.pid, record.procStart)) result.push(record);
    }
    return result;
  };
  const byTmux = records.filter((record) =>
    record.tmux !== null && record.tmux.startsWith(`${options.sessionName}:`));
  if (byTmux.length > 0) return aliveOf(byTmux);
  if (records.length === 0) return [];
  const pids = (await options.paneProcessIds?.()) ?? null;
  // pid が取れたら一致の有無にかかわらずそれで確定する（一致しない = この pane の Claude ではない）。
  // tmux 欄を誤記した記録（TMUX を持つ herdr server 配下等）も拾えるよう全記録から引く。
  if (pids !== null) return aliveOf(records.filter((record) => pids.includes(record.pid)));
  if (options.claudeSessionId === undefined) return [];
  const bySessionId = await aliveOf(records.filter((record) =>
    record.tmux === null && record.sessionId === options.claudeSessionId));
  return bySessionId.length === 1 ? bySessionId : [];
}

/** {@link findClaudeLiveRecords} の代表 1 件（仕事中を優先）。 */
export async function findClaudeLiveRecord(options: FindClaudeLiveOptions): Promise<ClaudeLiveRecord | null> {
  const records = await findClaudeLiveRecords(options);
  return records.find((record) => isClaudeWorking(record.status)) ?? records[0] ?? null;
}

/** 状態ファイル 1 件を読む（無い・壊れは null）。 */
export function readClaudeLiveRecordOf(dir: string, pid: number): ClaudeLiveRecord | null {
  try {
    return parseClaudeLiveRecord(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * hook プロセスを起動した Claude の pid（状態ファイルがある祖先。親 → 祖父の順）。
 * Claude は hook を直接子として起動する（2.1.283 実測: hook の親 pid = 状態ファイルの pid）。
 */
export function claudePidOfHook(dir: string = defaultClaudeSessionsDir()): number | undefined {
  // 異常終了した旧 Claude の残骸ファイルと pid が偶然重なる取り違えを、起動時刻の照合で防ぐ。
  const isClaude = (pid: number): boolean => {
    const record = readClaudeLiveRecordOf(dir, pid);
    if (record === null || record.pid !== pid) return false;
    if (record.procStart === null) return true;
    try {
      const actual = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 2_000,
      });
      return normalizeSpaces(actual) === normalizeSpaces(record.procStart);
    } catch {
      return false;
    }
  };
  const parent = process.ppid;
  if (parent > 1 && isClaude(parent)) return parent;
  try {
    const grand = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(parent)], {
      encoding: "utf8", timeout: 2_000,
    }).trim());
    if (Number.isInteger(grand) && grand > 1 && isClaude(grand)) return grand;
  } catch {
    // ps 不可は不明扱い（予約記録は session id だけで持ち主を表す）。
  }
  return undefined;
}
