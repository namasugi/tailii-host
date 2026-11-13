// codexExecLinker.ts
// tailii (TS host) — Claude の Bash が `codex exec` で起動した Codex の実行を、その Bash に対応づける
// （codex-exec-delegation。設計の正本は docs/codex-exec-delegation.md）。
//
// 2 段構え:
//   1. 記録だけの規則（状態を持たない。過去の会話を開き直しても同じ結果）: Bash のコマンド・時刻・作業フォルダと
//      `~/.codex/sessions/YYYY/MM/DD/` の `exec` 由来の記録（先頭の session_meta）を突き合わせる。
//   2. 実行中の観測: Claude のプロセスの子孫（ps）から `codex exec` を見つけ、起動元の Bash と、そのプロセスが
//      開いている記録（lsof）を結ぶ。決まった対応は `~/.tailii/codex-exec-links.jsonl` に控え、規則より優先する。
//
// ps / lsof / 時計 / ホームはすべて差し替えられる（テストは偽物を渡す）。

import { nextStartAtMs, periodicWorkLimiter, probeExecFile } from "../shared/loadShed.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolActivity } from "../protocol.js";
import { rolloutResponseItemToolActivities } from "../codex/codexToolActivity.js";
import { isCompressedRollout, isRolloutFileName, readCompressedRollout, readRolloutHead } from "../codex/rolloutFile.js";
import { claudeProcessAlive, defaultClaudeSessionsDir, readClaudeLiveRecords } from "../sessions/claudeLiveStatus.js";
import type { ProcessProbeExec } from "./subagentTailer.js";

/** 差し替えたプローブが signal を扱わなくても、取消後は巡回を先へ進めない。 */
function withProbeAbort<T>(start: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => { cleanup(); reject(signal!.reason); };
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      Promise.resolve(start()).then((value) => {
        cleanup();
        if (signal?.aborted) reject(signal.reason);
        else resolve(value);
      }, (error) => { cleanup(); reject(error); });
    } catch (error) { cleanup(); reject(error); }
  });
}

/** 起動した Bash の終わりから、記録の開始を待つ猶予（ms）。 */
export const EXEC_LINK_TAIL_MS = 10_000;
/** 観測の間隔の下限（ms）。 */
const OBSERVE_INTERVAL_MS = 2_000;
/** 控えの保持期間（ms）。これより古い行は書き込み時に落とす。 */
const LINK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** lsof で記録が見つからないとき、作業フォルダと開始時刻の照合に切り替えるまでの時間（ms）。 */
const LSOF_FALLBACK_AFTER_MS = 5_000;
/** 起動直後の Bash のシェルを、文面が一致する Bash が記録に現れるまで待つ時間（ms）。 */
const SHELL_TEXT_MATCH_WAIT_MS = 6_000;
/** プロセスの開始から、その実行の記録が始まるまでの許容（ms）。 */
const PROCESS_TO_ROLLOUT_MS = 30_000;
/** 状態プローブ（lsof -t）の結果を使い回す時間（ms）。 */
const STATUS_PROBE_TTL_MS = 5_000;
/** session_meta を読む上限（base_instructions を含むので広め）。 */
const META_READ_LIMIT_BYTES = 512 * 1024;
/** 圧縮済みの記録を解凍する上限。 */
const COMPRESSED_LIMIT_BYTES = 64 * 1024 * 1024;
/** 依頼文（label）の上限文字数。 */
const LABEL_MAX_CHARS = 300;
/** 規則で見る日付フォルダの上限（壊れた時刻で何年分も走査しない）。 */
const MAX_DAY_DIRS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

// MARK: - Bash の観測

/** Claude の記録から読んだ Bash の呼び出し 1 件。 */
export interface BashCall {
  toolUseId: string;
  /** その Bash を実行した持ち主（"root" = 本体 / それ以外はサブエージェントの nodeId）。 */
  owner: string;
  command: string;
  /** その行の top-level `cwd`（無ければ null）。 */
  cwd: string | null;
  /** tool_use の行の時刻。 */
  startMs: number;
  /** 呼び出しの終わり（前面 = tool_result / 背景 = 完了通知・孤児判定）。まだ終わっていなければ null。 */
  endMs: number | null;
  /** invokesCodex(command) を先に求めてあれば、その値（毎回の字句解析を省く）。 */
  codex?: boolean;
}

// MARK: - シェルの字句解析（最小限）

type ShellToken =
  | { type: "word"; value: string; quoted: boolean }
  | { type: "op"; value: string };

/**
 * コマンド文字列を語と区切りに分ける。引用符を外した値と、引用符を含む語か（quoted）を返す。
 * ヒアドキュメントの本文・コメントは捨てる（本文の `cd …` や `codex` をコマンドと取り違えない）。
 * `$(` と バッククォートは区切りとして扱い、中のコマンドも語の並びとして見る。
 */
export function lexShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let expectHeredocDelimiter: { stripTabs: boolean } | null = null;
  const flush = (): void => {
    if (!inWord) return;
    if (expectHeredocDelimiter !== null) {
      heredocs.push({ delimiter: word, stripTabs: expectHeredocDelimiter.stripTabs });
      expectHeredocDelimiter = null;
    } else {
      tokens.push({ type: "word", value: word, quoted });
    }
    word = "";
    inWord = false;
    quoted = false;
  };
  const op = (value: string): void => {
    flush();
    tokens.push({ type: "op", value });
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i]!;
    if (c === "\n") {
      flush();
      tokens.push({ type: "op", value: ";" });
      i += 1;
      // ヒアドキュメントの本文を読み飛ばす。
      while (heredocs.length > 0) {
        const doc = heredocs.shift()!;
        for (;;) {
          if (i >= n) break;
          const nl = command.indexOf("\n", i);
          const rawLine = command.slice(i, nl < 0 ? n : nl);
          i = nl < 0 ? n : nl + 1;
          const line = doc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
          if (line === doc.delimiter) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n && command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < n) word += command[i + 1];
      inWord = true;
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'" || (c === "$" && command[i + 1] === "'")) {
      const open = c === "'" ? i : i + 1;
      const close = command.indexOf("'", open + 1);
      word += command.slice(open + 1, close < 0 ? n : close);
      inWord = true;
      quoted = true;
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      while (j < n && command[j] !== "\"") {
        if (command[j] === "\\" && j + 1 < n) {
          word += command[j + 1];
          j += 2;
          continue;
        }
        word += command[j];
        j += 1;
      }
      inWord = true;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      op("(");
      i += 2;
      continue;
    }
    if (c === "`") {
      op("`");
      i += 1;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const stripTabs = command[i + 2] === "-";
      op("<<");
      i += stripTabs ? 3 : 2;
      expectHeredocDelimiter = { stripTabs };
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">") {
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ";;" || two === "|&" || two === ">>" || two === "&>" || two === ">&" || two === "<<") {
        op(two);
        i += 2;
      } else {
        op(c);
        i += 1;
      }
      continue;
    }
    word += c;
    inWord = true;
    i += 1;
  }
  flush();
  return tokens;
}

const COMMAND_SEPARATORS = new Set([";", "&", "|", "&&", "||", "|&", "(", ")", "`", ";;"]);
const REDIRECTIONS = new Set(["<", ">", ">>", "&>", ">&", "<<"]);
/** `codex` を引数に取るだけで起動はしないコマンド（監視・検索・表示）。 */
const NON_LAUNCHING_COMMANDS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "pgrep", "pkill", "killall", "kill", "ps", "which", "type", "whereis",
  "man", "echo", "printf", "lsof", "ls", "find", "cat", "head", "tail", "less", "wc", "brew", "npm", "pip",
  "open", "tmux", "herdr",
]);

/** 単純コマンド（区切りまでの語の並び）に分ける。リダイレクト先の語は除く。 */
function simpleCommands(tokens: ShellToken[]): { value: string; quoted: boolean }[][] {
  const out: { value: string; quoted: boolean }[][] = [];
  let current: { value: string; quoted: boolean }[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (token.type === "op") {
      if (REDIRECTIONS.has(token.value)) {
        skipNext = true;
        continue;
      }
      if (COMMAND_SEPARATORS.has(token.value)) {
        if (current.length > 0) out.push(current);
        current = [];
      }
      skipNext = false;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    current.push({ value: token.value, quoted: token.quoted });
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 語が引用符の外の `codex`（またはパス `…/codex`）か。 */
function isCodexWord(word: { value: string; quoted: boolean }): boolean {
  if (word.quoted) return false;
  return word.value === "codex" || word.value.endsWith("/codex");
}

/** 代入（`X=y`）を飛ばした最初の語の位置。 */
function commandWordIndex(words: { value: string; quoted: boolean }[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.value)) index += 1;
  return index;
}

/**
 * 対象の Bash か: 単語 `codex` が引用符の外に現れる。`grep "codex exec"` / `pgrep -f "codex exec"` のように
 * 引用符の中にしか無いものは対象外。`pgrep -f codex` のような監視・検索のコマンドの引数も対象外。
 */
export function invokesCodex(command: string): boolean {
  for (const words of simpleCommands(lexShell(command))) {
    const head = words[commandWordIndex(words)];
    if (head !== undefined && NON_LAUNCHING_COMMANDS.has(path.basename(head.value))) continue;
    if (words.some(isCodexWord)) return true;
  }
  return false;
}

/**
 * 作業フォルダの候補: 行の `cwd`、コマンド中の `cd <パス>`（相対はその時点のフォルダから解決。変数を含むものは
 * 以後不明）、`codex` の `-C` / `--cd`。返す値は normalizeDir 済み。
 */
export function candidateWorkDirs(command: string, cwd: string | null, home: string): string[] {
  const out = new Set<string>();
  const base = cwd === null ? null : normalizeDir(cwd, home);
  if (base !== null) out.add(base);
  let current = base;
  const resolve = (target: string): string | null => {
    if (target.length === 0 || /[$`*?]/.test(target)) return null;
    if (target === "~" || target.startsWith("~/")) return normalizeDir(target, home);
    if (path.isAbsolute(target)) return normalizeDir(target, home);
    return current === null ? null : normalizeDir(path.join(current, target), home);
  };
  for (const words of simpleCommands(lexShell(command))) {
    const index = commandWordIndex(words);
    const head = words[index];
    if (head === undefined) continue;
    if (head.value === "cd" || head.value === "pushd") {
      let argIndex = index + 1;
      while (argIndex < words.length && /^-[LPe@]*$|^--$/.test(words[argIndex]!.value)) argIndex += 1;
      const arg = words[argIndex];
      if (arg === undefined) {
        current = normalizeDir(home, home);
      } else if (arg.value === "-") {
        current = null;
      } else {
        current = resolve(arg.value);
      }
      if (current !== null) out.add(current);
      continue;
    }
    for (let k = 0; k < words.length; k++) {
      if (!isCodexWord(words[k]!)) continue;
      for (let j = k + 1; j < words.length; j++) {
        const value = words[j]!.value;
        let target: string | null = null;
        if ((value === "-C" || value === "--cd") && j + 1 < words.length) target = words[j + 1]!.value;
        else if (value.startsWith("--cd=")) target = value.slice("--cd=".length);
        if (target === null) continue;
        const dir = resolve(target);
        if (dir !== null) out.add(dir);
      }
    }
  }
  return [...out];
}

const realpathCache = new Map<string, string>();

/** `~` を展開し、絶対化・末尾の `/` を除き、symlink を解決する（解決できなければ絶対化までの値）。 */
export function normalizeDir(dir: string, home: string = os.homedir()): string {
  let expanded = dir;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/")) expanded = path.join(home, expanded.slice(2));
  if (expanded.startsWith("file://")) expanded = expanded.slice("file://".length);
  const absolute = path.resolve(expanded);
  const cached = realpathCache.get(absolute);
  if (cached !== undefined) return cached;
  let real = absolute;
  try {
    real = fs.realpathSync.native(absolute);
  } catch {
    // 消えたフォルダは絶対化までで比べる（結果は覚えない: 後で作られれば解決できる）。
    return absolute;
  }
  if (realpathCache.size > 4_096) realpathCache.clear();
  realpathCache.set(absolute, real);
  return real;
}

// MARK: - 記録（rollout）の探索

/** `exec` 由来の記録の先頭（session_meta）。 */
export interface ExecRolloutMeta {
  id: string;
  path: string;
  /** normalizeDir 済みの作業フォルダ。 */
  cwd: string;
  /** session_meta.payload.timestamp（epoch ms）。 */
  startMs: number;
}

const ROLLOUT_NAME_TIME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/;

/** ファイル名の時刻（Codex はローカル時刻で書く。秒精度）。読めなければ null。 */
export function rolloutNameTimeMs(name: string): number | null {
  const m = ROLLOUT_NAME_TIME.exec(name);
  if (m === null) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** `~/.codex/sessions` の日付フォルダを走査し、`exec` 由来の記録を探す（先頭行は変わらないのでパスごとに覚える）。 */
export class ExecRolloutIndex {
  readonly sessionsRoot: string;
  private readonly home: string;
  private readonly metaByPath = new Map<string, ExecRolloutMeta | null>();
  private readonly dirListing = new Map<string, { mtimeMs: number; names: string[] }>();

  constructor(codexHome: string, home: string) {
    this.sessionsRoot = path.join(codexHome, "sessions");
    this.home = home;
  }

  /** 開始時刻が [fromMs, toMs] の `exec` の記録。範囲の前後 1 日ぶんの日付フォルダだけを見る。 */
  candidates(fromMs: number, toMs: number): ExecRolloutMeta[] {
    const out: ExecRolloutMeta[] = [];
    const first = new Date(fromMs - DAY_MS);
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    for (let count = 0; count < MAX_DAY_DIRS && day.getTime() <= toMs + DAY_MS; count++) {
      const dir = path.join(
        this.sessionsRoot,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, "0"),
        String(day.getDate()).padStart(2, "0"),
      );
      for (const name of this.list(dir)) {
        // ファイル名の時刻で先に絞る（秒精度なので前後に余裕を持たせる）。読めない名前は更新時刻で絞る。
        const nameMs = rolloutNameTimeMs(name);
        const file = path.join(dir, name);
        if (nameMs !== null) {
          if (nameMs < fromMs - 2_000 || nameMs > toMs + 1_000) continue;
        } else {
          try {
            if (fs.statSync(file).mtimeMs < fromMs) continue;
          } catch {
            continue;
          }
        }
        const meta = this.meta(file);
        if (meta === null || meta.startMs < fromMs || meta.startMs > toMs) continue;
        out.push(meta);
      }
      day.setDate(day.getDate() + 1);
    }
    return out;
  }

  /** 先頭行の読み取り（`exec` 以外・読めないものは null。結果はパスごとに覚える）。 */
  meta(file: string): ExecRolloutMeta | null {
    const hit = this.metaByPath.get(file);
    if (hit !== undefined) return hit;
    const meta = readExecMeta(file, this.home);
    // 書き始めの空ファイル（先頭行がまだ無い）は覚えない。
    if (meta !== null || fileSize(file) > 0) {
      if (this.metaByPath.size > 20_000) this.metaByPath.clear();
      this.metaByPath.set(file, meta);
    }
    return meta;
  }

  private list(dir: string): string[] {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      return [];
    }
    const hit = this.dirListing.get(dir);
    if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.names;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(isRolloutFileName);
    } catch {
      names = [];
    }
    this.dirListing.set(dir, { mtimeMs, names });
    return names;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** 記録の先頭行から `exec` 由来のメタを読む（それ以外は null）。 */
export function readExecMeta(file: string, home: string = os.homedir()): ExecRolloutMeta | null {
  try {
    const head = readRolloutHead(file, META_READ_LIMIT_BYTES, (partial) => partial.includes(0x0a));
    const nl = head.indexOf(0x0a);
    if (nl < 0) return null;
    const record = JSON.parse(head.subarray(0, nl).toString("utf8")) as Record<string, unknown>;
    if (record["type"] !== "session_meta") return null;
    const payload = asRecord(record["payload"]);
    if (payload === null || payload["source"] !== "exec") return null;
    const id = payload["id"];
    const cwd = payload["cwd"];
    const timestamp = typeof payload["timestamp"] === "string" ? Date.parse(payload["timestamp"]) : Number.NaN;
    if (typeof id !== "string" || id.length === 0 || typeof cwd !== "string" || cwd.length === 0) return null;
    if (!Number.isFinite(timestamp)) return null;
    return { id, path: file, cwd: normalizeDir(cwd, home), startMs: timestamp };
  } catch {
    return null;
  }
}

// MARK: - 記録だけの規則

/** 規則の結果: 記録のパス → Bash の tool_use の ID。 */
export interface RuleMatch {
  meta: ExecRolloutMeta;
  toolUseId: string;
}

/**
 * 記録だけの規則で対応づける。
 *   1. 対象の Bash: 引用符の外に単語 `codex`。
 *   2. 時間の範囲: tool_use の時刻 〜 終わり + 10 秒（終わっていなければ `nowMs`）。
 *   3. 作業フォルダの候補: 行の cwd / `cd` / `-C`。
 *   4. `source: exec`・開始が範囲内・cwd が候補のどれか。
 *   5. 複数の Bash が同じ記録を満たしたら、開始が最も遅い Bash。
 * `excludedIds` の記録（控えで別の会話のものと分かっている・控えで決まっている）は付けない。
 */
export function matchByRules(
  calls: readonly BashCall[],
  index: ExecRolloutIndex,
  options: { nowMs: number; home: string; excludedIds?: ReadonlySet<string> },
): RuleMatch[] {
  const best = new Map<string, { meta: ExecRolloutMeta; call: BashCall }>();
  for (const call of calls) {
    if (!(call.codex ?? invokesCodex(call.command))) continue;
    const end = (call.endMs ?? options.nowMs) + EXEC_LINK_TAIL_MS;
    if (end < call.startMs) continue;
    const dirs = new Set(candidateWorkDirs(call.command, call.cwd, options.home));
    if (dirs.size === 0) continue;
    for (const meta of index.candidates(call.startMs, end)) {
      if (options.excludedIds?.has(meta.id) === true) continue;
      if (!dirs.has(meta.cwd)) continue;
      const current = best.get(meta.id);
      if (current === undefined || call.startMs > current.call.startMs) best.set(meta.id, { meta, call });
    }
  }
  return [...best.values()].map(({ meta, call }) => ({ meta, toolUseId: call.toolUseId }));
}

// MARK: - 記録の要約（依頼文・モデル・状態・直近のツール）

/** 記録 1 本の要約。 */
export interface RolloutSummary {
  firstUserText: string | null;
  model: string | null;
  effort: string | null;
  /** 最後の行の時刻。 */
  lastTs: number | null;
  /** 最後のターンの終わり方（"completed" = task_complete / "aborted" = turn_aborted / null = 終わりの行なし）。 */
  terminal: "completed" | "aborted" | null;
  /** 最後のターンで直近に動いたツール。 */
  lastActivity: ToolActivity | null;
}

interface RolloutSummarySnapshot extends RolloutSummary {
  size: number;
  mtimeMs: number;
}

interface SummaryState extends RolloutSummarySnapshot {
  position: number;
  partial: Buffer;
}

const HEAD_TIMESTAMP = /"timestamp"\s*:\s*"([^"]+)"/;
/** 行の先頭だけを見て、解析が要る行かを決める（画像を含む数 MB の行を毎回 JSON.parse しない）。 */
const INTERESTING_HEAD = new RegExp(
  "\"type\"\\s*:\\s*\"turn_context\""
  + "|\"type\"\\s*:\\s*\"event_msg\"\\s*,\\s*\"payload\"\\s*:\\s*\\{\\s*\"type\"\\s*:\\s*\"(?:task_started|task_complete|turn_aborted|user_message)\""
  + "|\"item\"\\s*:\\s*\\{\\s*\"type\"\\s*:\\s*\"UserMessage\""
  + "|\"type\"\\s*:\\s*\"response_item\"\\s*,\\s*\"payload\"\\s*:\\s*\\{\\s*\"type\"\\s*:\\s*\"(?:custom_tool_call|function_call)\"",
);

/** 記録の要約を、追記された分だけ読み進めて保つ（圧縮済みは一度だけ全体を読む）。 */
export class RolloutSummaryCache {
  private readonly states = new Map<string, SummaryState>();

  summary(file: string): RolloutSummarySnapshot | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    let state = this.states.get(file);
    if (state !== undefined && state.size === stat.size && state.mtimeMs === stat.mtimeMs) return state;
    if (state === undefined || stat.size < state.position ||
        (state.size === stat.size && state.mtimeMs !== stat.mtimeMs) || isCompressedRollout(file)) {
      state = {
        size: 0, mtimeMs: 0, position: 0, partial: Buffer.alloc(0),
        firstUserText: null, model: null, effort: null, lastTs: null, terminal: null, lastActivity: null,
      };
    }
    try {
      if (isCompressedRollout(file)) {
        const data = readCompressedRollout(file, COMPRESSED_LIMIT_BYTES);
        if (data !== null) consumeChunk(state, data, true);
      } else {
        const fd = fs.openSync(file, "r");
        try {
          const chunk = Buffer.alloc(256 * 1024);
          for (;;) {
            const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, state.position);
            if (bytesRead === 0) break;
            state.position += bytesRead;
            consumeChunk(state, chunk.subarray(0, bytesRead), false);
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      return null;
    }
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    if (this.states.size > 512) this.states.clear();
    this.states.set(file, state);
    return state;
  }
}

function consumeChunk(state: SummaryState, data: Buffer, complete: boolean): void {
  let buffer = state.partial.length > 0 ? Buffer.concat([state.partial, data]) : data;
  let offset = 0;
  for (;;) {
    const nl = buffer.indexOf(0x0a, offset);
    if (nl < 0) break;
    consumeLine(state, buffer.subarray(offset, nl));
    offset = nl + 1;
  }
  buffer = buffer.subarray(offset);
  if (complete) {
    if (buffer.length > 0) consumeLine(state, buffer);
    state.partial = Buffer.alloc(0);
  } else {
    state.partial = Buffer.from(buffer);
  }
}

function consumeLine(state: SummaryState, line: Buffer): void {
  if (line.length === 0) return;
  const head = line.subarray(0, 600).toString("utf8");
  const tsMatch = HEAD_TIMESTAMP.exec(head);
  if (tsMatch !== null) {
    const ts = Date.parse(tsMatch[1]!);
    if (Number.isFinite(ts) && (state.lastTs === null || ts > state.lastTs)) state.lastTs = ts;
  }
  if (!INTERESTING_HEAD.test(head)) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const payload = asRecord(record["payload"]);
  if (payload === null) return;
  if (record["type"] === "turn_context") {
    if (typeof payload["model"] === "string" && payload["model"].length > 0) state.model = payload["model"];
    const effort = payload["effort"] ?? asRecord(asRecord(payload["collaboration_mode"])?.["settings"])?.["reasoning_effort"];
    if (typeof effort === "string" && /^[a-z][a-z0-9_-]{0,23}$/.test(effort)) state.effort = effort;
    return;
  }
  if (record["type"] === "event_msg") {
    switch (payload["type"]) {
      case "task_started":
        state.terminal = null;
        state.lastActivity = null;
        return;
      case "task_complete":
        state.terminal = "completed";
        return;
      case "turn_aborted":
        state.terminal = "aborted";
        return;
      case "user_message":
        if (state.firstUserText === null && typeof payload["message"] === "string" && payload["message"].trim().length > 0) {
          state.firstUserText = payload["message"];
        }
        return;
      case "item_completed": {
        const text = userMessageItemText(payload["item"]);
        if (state.firstUserText === null && text !== null) state.firstUserText = text;
        return;
      }
      default:
        return;
    }
  }
  if (record["type"] === "response_item") {
    const activities = rolloutResponseItemToolActivities(payload);
    const latest = activities.at(-1);
    if (latest !== undefined) state.lastActivity = latest;
  }
}

/** `event_msg/item_completed` の `item`（type UserMessage）の本文。 */
export function userMessageItemText(value: unknown): string | null {
  const item = asRecord(value);
  if (item === null || item["type"] !== "UserMessage" || !Array.isArray(item["content"])) return null;
  const text = item["content"].flatMap((raw): string[] => {
    const block = asRecord(raw);
    return block !== null && typeof block["text"] === "string" ? [block["text"]] : [];
  }).join("\n");
  return text.trim().length > 0 ? text : null;
}

/** 依頼文の先頭（label）。前後の空白と連続する空行を詰め、LABEL_MAX_CHARS で切る。 */
export function requestLabel(text: string | null): string {
  if (text === null) return "Codex への依頼";
  const compact = text.replaceAll("\r", "").replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length === 0) return "Codex への依頼";
  if (compact.length <= LABEL_MAX_CHARS) return compact;
  let end = LABEL_MAX_CHARS - 1;
  const last = compact.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${compact.slice(0, end)}…`;
}

// MARK: - 控え（~/.tailii/codex-exec-links.jsonl）

/** 実行中の観測で決まった対応 1 件。 */
export interface CodexExecLink {
  rolloutId: string;
  rolloutPath: string;
  claudeSessionId: string;
  toolUseId: string;
  owner: string;
  /** 控えた時刻（epoch ms）。 */
  ts: number;
}

/** 全会話で 1 つの追記専用ファイル。30 日より古い行は書き込み時に落とす。 */
export class CodexExecLinkStore {
  readonly filePath: string;
  private readonly now: () => number;
  private cache: { size: number; mtimeMs: number; links: CodexExecLink[] } | null = null;

  constructor(filePath: string, now: () => number = Date.now) {
    this.filePath = filePath;
    this.now = now;
  }

  /** 全行（同じ記録が複数あれば後の行が勝つ）。 */
  load(): CodexExecLink[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      this.cache = null;
      return [];
    }
    if (this.cache !== null && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) return this.cache.links;
    let text = "";
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    const links = parseLinks(text);
    this.cache = { size: stat.size, mtimeMs: stat.mtimeMs, links };
    return links;
  }

  append(link: CodexExecLink): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const line = `${JSON.stringify(link)}\n`;
      const existing = this.load();
      const cutoff = this.now() - LINK_RETENTION_MS;
      if (existing.some((entry) => entry.ts < cutoff)) {
        // 古い行を落として書き直す（一時ファイル → rename）。
        const kept = existing.filter((entry) => entry.ts >= cutoff).map((entry) => JSON.stringify(entry)).join("\n");
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, kept.length > 0 ? `${kept}\n${line}` : line);
        fs.renameSync(tmp, this.filePath);
      } else {
        fs.appendFileSync(this.filePath, line);
      }
      this.cache = null;
    } catch {
      // 控えが書けなくても対応づけは記録だけの規則で続く。
    }
  }
}

function parseLinks(text: string): CodexExecLink[] {
  const out: CodexExecLink[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = asRecord(value);
    if (rec === null) continue;
    const { rolloutId, rolloutPath, claudeSessionId, toolUseId, owner, ts } = rec;
    if (typeof rolloutId !== "string" || typeof rolloutPath !== "string" || typeof claudeSessionId !== "string"
      || typeof toolUseId !== "string" || typeof owner !== "string" || typeof ts !== "number") continue;
    out.push({ rolloutId, rolloutPath, claudeSessionId, toolUseId, owner, ts });
  }
  return out;
}

// MARK: - 実行中の観測（ps / lsof）

/** ps の 1 行。 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** lstart（秒精度, epoch ms）。 */
  startMs: number;
  command: string;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** `ps -axww -o pid=,ppid=,pgid=,lstart=,command=` の出力を読む。 */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const raw of stdout.split("\n")) {
    // pid ppid pgid 曜日 月 日 時:分:秒 年 command…
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/.exec(raw);
    if (m === null) continue;
    const month = MONTHS[m[4]!];
    if (month === undefined) continue;
    const startMs = new Date(Number(m[9]), month, Number(m[5]), Number(m[6]), Number(m[7]), Number(m[8])).getTime();
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), startMs, command: m[10]! });
  }
  return rows;
}

const VALUE_OPTIONS = new Set([
  "-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval",
  "-i", "--image", "--enable", "--disable", "--add-dir", "--color", "-o", "--output-last-message", "--output-schema",
  "--local-provider",
]);

/**
 * `codex` の `exec` サブコマンドで動いているプロセスか。`exec-server` / `app-server` は除く。
 * argv[0] が `codex`（パス付き可）、または node / bun で起動した `…/codex`（npm 版）。
 */
export function isCodexExecCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  let index = 0;
  const base0 = path.basename(tokens[0] ?? "");
  if (base0 === "node" || base0 === "bun") index = 1;
  const exe = tokens[index];
  if (exe === undefined) return false;
  const base = path.basename(exe);
  if (base !== "codex" && base !== "codex.js") return false;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (VALUE_OPTIONS.has(token)) i += 1;
      continue;
    }
    return token === "exec" || token === "e";
  }
  return false;
}

/** 起動元の決め方のための、ps の command の正規化（`\012` と `'"'"'` を戻し、空白を詰める）。 */
function normalizeForMatch(text: string): string {
  return text.replaceAll("\\012", " ").replaceAll("'\"'\"'", "'").replace(/\s+/g, " ").trim();
}

interface TrackedProcess {
  startMs: number;
  pgid: number;
  /** 起動元の Bash（決められなければ null）。 */
  origin: string | null;
  firstSeenMs: number;
  /** この codex exec について対応を決め終えたか。 */
  resolved: boolean;
  isCodexExec: boolean;
}

/** 観測の結果: 新しく決まった対応と、記録を開いている（= 実行中の）記録のパス。 */
export interface ObservationResult {
  links: CodexExecLink[];
  liveRolloutPaths: Set<string>;
}

/**
 * 会話の Claude プロセスの子孫を追い、`codex exec` を見つけて起動元の Bash と記録を結ぶ。
 * 追跡は tailer 1 本（会話 1 つ）ごと。
 */
export class CodexExecObserver {
  private readonly exec: ProcessProbeExec;
  private readonly now: () => number;
  private readonly index: ExecRolloutIndex;
  private readonly home: string;
  private readonly tracked = new Map<number, TrackedProcess>();
  /** 一度見た Bash のシェル（プロセスグループの先頭）→ 起動元。シェルが先に終わった後の子もこれで辿る。 */
  private readonly shellOrigins = new Map<number, string | null>();
  private readonly liveRollouts = new Map<number, string>();

  private readonly claudeSessionsDir: string;
  private readonly processAlive: (pid: number, procStart: string | null, signal?: AbortSignal) => boolean | Promise<boolean>;

  constructor(options: {
    exec: ProcessProbeExec; now: () => number; index: ExecRolloutIndex; home: string;
    claudeSessionsDir: string; processAlive: (pid: number, procStart: string | null, signal?: AbortSignal) => boolean | Promise<boolean>;
  }) {
    this.exec = options.exec;
    this.now = options.now;
    this.index = options.index;
    this.home = options.home;
    this.claudeSessionsDir = options.claudeSessionsDir;
    this.processAlive = options.processAlive;
  }

  /** 追跡中のプロセスがあるか（Bash が全部終わっていても、切り離したスクリプトのために見続ける）。 */
  hasTracked(): boolean {
    return this.tracked.size > 0;
  }

  async observe(
    sessionId: string,
    calls: readonly BashCall[],
    knownRolloutIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<ObservationResult | null> {
    signal?.throwIfAborted();
    const roots = await this.findClaudeRoots(sessionId, signal);
    signal?.throwIfAborted();
    if (roots === null) return null;
    // Claude のプロセスが見つからず、追跡中のものも無ければ ps は回さない（端末なし・別マシンの会話など）。
    if (roots.pids.size === 0 && this.tracked.size === 0) return { links: [], liveRolloutPaths: new Set() };
    const psOut = await this.run("ps", ["-axww", "-o", "pid=,ppid=,pgid=,lstart=,command="], false, signal);
    signal?.throwIfAborted();
    if (psOut === null) return null;
    const rows = parsePsOutput(psOut);
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    // 登録簿で確かめた pid はそのまま採る。pgrep の結果は argv の形（Claude 本体でシェルではない）も確かめる。
    const rootPids = new Set(rows.filter((row) => roots.pids.has(row.pid)
      && (roots.fromRegistry || isClaudeProcessFor(row.command, sessionId))).map((row) => row.pid));
    const nowMs = this.now();

    // 終わった（または pid が使い回された）プロセスを外す。
    for (const [pid, tracked] of this.tracked) {
      const row = byPid.get(pid);
      if (row === undefined || row.startMs !== tracked.startMs) {
        this.tracked.delete(pid);
        this.liveRollouts.delete(pid);
      }
    }
    const livePgids = new Set(rows.map((row) => row.pgid));
    for (const pgid of this.shellOrigins.keys()) {
      if (!livePgids.has(pgid)) this.shellOrigins.delete(pgid);
    }
    if (rootPids.size === 0 && this.tracked.size === 0) return { links: [], liveRolloutPaths: new Set() };

    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const list = children.get(row.ppid);
      if (list === undefined) children.set(row.ppid, [row]);
      else list.push(row);
    }
    const track = (row: ProcessRow, origin: string | null): void => {
      this.tracked.set(row.pid, {
        startMs: row.startMs, pgid: row.pgid, origin, firstSeenMs: nowMs, resolved: false,
        isCodexExec: isCodexExecCommand(row.command),
      });
    };
    // 1) Claude の直接の子 = Bash のシェル。追跡に入った時点で起動元を 1 回だけ決める。
    //    Claude は Bash の tool_use 行をシェルの起動と前後して書くので、起動直後のシェルはコマンドの文面が一致する
    //    Bash が記録に現れるまで待つ（先に見えた別の動いている Bash に取り違えて固定しない。実地で確認）。
    for (const root of rootPids) {
      for (const child of children.get(root) ?? []) {
        if (this.tracked.has(child.pid)) continue;
        const young = nowMs - child.startMs < SHELL_TEXT_MATCH_WAIT_MS;
        const origin = pickOriginBash(child, calls, { requireTextMatch: young });
        if (origin === null && young) continue;
        track(child, origin);
        if (child.pgid === child.pid) this.shellOrigins.set(child.pid, origin);
      }
    }
    // 2) 追跡済みの子孫（親が先に終わって付け替えられた後も）と、追跡済みシェルのプロセスグループ。
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) {
        if (this.tracked.has(row.pid) || rootPids.has(row.pid)) continue;
        const parent = this.tracked.get(row.ppid);
        if (parent !== undefined) {
          track(row, parent.origin);
          changed = true;
          continue;
        }
        if (this.shellOrigins.has(row.pgid)) {
          track(row, this.shellOrigins.get(row.pgid) ?? null);
          changed = true;
        }
      }
    }

    // 3) codex exec の記録を特定する。
    const links: CodexExecLink[] = [];
    for (const [pid, tracked] of this.tracked) {
      if (!tracked.isCodexExec) continue;
      if (!this.liveRollouts.has(pid)) {
        const open = await this.openRollout(pid, signal);
        signal?.throwIfAborted();
        if (open !== null) this.liveRollouts.set(pid, open);
      }
      if (tracked.resolved || tracked.origin === null) continue;
      const call = calls.find((candidate) => candidate.toolUseId === tracked.origin);
      if (call === undefined) continue;
      let meta: ExecRolloutMeta | null = null;
      const openPath = this.liveRollouts.get(pid);
      if (openPath !== undefined) {
        meta = this.index.meta(openPath);
      } else if (nowMs - tracked.firstSeenMs >= LSOF_FALLBACK_AFTER_MS) {
        meta = await this.byCwdAndStart(pid, tracked.startMs, knownRolloutIds, signal);
        signal?.throwIfAborted();
      }
      if (meta === null) continue;
      tracked.resolved = true;
      links.push({
        rolloutId: meta.id,
        rolloutPath: meta.path,
        claudeSessionId: sessionId,
        toolUseId: call.toolUseId,
        owner: call.owner,
        ts: nowMs,
      });
    }
    return { links, liveRolloutPaths: new Set(this.liveRollouts.values()) };
  }

  /**
   * 会話の Claude のプロセス。主は Claude 自身が書く登録簿（`~/.claude/sessions/<pid>.json` の `sessionId`）で、
   * pid の生存と起動時刻（`procStart`）の一致を確かめた記録だけを採る（`/clear` 後の会話や、argv に id を持たない
   * 素の `claude` も引ける）。登録簿に生きた記録が無いときだけ `pgrep -f <セッション id>` に落ちる。そのときも、
   * 登録簿で別の会話のものと分かっている pid（`/clear` 前の id を argv に残したプロセス）は採らない。
   * 判定不能なら null。
   */
  private async findClaudeRoots(sessionId: string, signal?: AbortSignal): Promise<{ pids: Set<number>; fromRegistry: boolean } | null> {
    const records = readClaudeLiveRecords(this.claudeSessionsDir);
    const alive = (pid: number, procStart: string | null): Promise<boolean> =>
      withProbeAbort(() => this.processAlive(pid, procStart, signal), signal).catch((error) => {
        if (signal?.aborted) throw error;
        return false;
      });
    const mine: number[] = [];
    for (const record of records) {
      if (record.sessionId === sessionId && await alive(record.pid, record.procStart)) mine.push(record.pid);
    }
    if (mine.length > 0) return { pids: new Set(mine), fromRegistry: true };
    const out = await this.run("pgrep", ["-f", sessionId], true, signal);
    if (out === null) return null;
    const pids: number[] = [];
    for (const pid of out.split(/\s+/).filter((text) => /^\d+$/.test(text)).map(Number)) {
      const record = records.find((candidate) => candidate.pid === pid);
      const otherConversation = record !== undefined && record.sessionId !== null && record.sessionId !== sessionId
        && await alive(record.pid, record.procStart);
      if (!otherConversation) pids.push(pid);
    }
    return { pids: new Set(pids), fromRegistry: false };
  }

  /** `lsof -p <pid> -Fn` でそのプロセスが開いている `rollout-*.jsonl`。 */
  private async openRollout(pid: number, signal?: AbortSignal): Promise<string | null> {
    const out = await this.run("lsof", ["-p", String(pid), "-Fn"], true, signal);
    signal?.throwIfAborted();
    if (out === null) return null;
    for (const line of out.split("\n")) {
      if (!line.startsWith("n")) continue;
      const file = line.slice(1);
      if (/\/rollout-[^/]*\.jsonl$/.test(file) && file.startsWith(this.index.sessionsRoot)) return file;
    }
    return null;
  }

  /** プロセスの作業フォルダと開始時刻（開始から 30 秒以内に始まった exec の記録）で 1 件に絞れたときだけ採る。 */
  private async byCwdAndStart(pid: number, startMs: number, known: ReadonlySet<string>, signal?: AbortSignal): Promise<ExecRolloutMeta | null> {
    const out = await this.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], true, signal);
    signal?.throwIfAborted();
    if (out === null) return null;
    const cwdLine = out.split("\n").find((line) => line.startsWith("n"));
    if (cwdLine === undefined) return null;
    const cwd = normalizeDir(cwdLine.slice(1), this.home);
    // lstart は秒精度なので、開始の前 1 秒も許す。
    const matches = this.index.candidates(startMs - 1_000, startMs + PROCESS_TO_ROLLOUT_MS + 1_000)
      .filter((meta) => meta.cwd === cwd && !known.has(meta.id));
    return matches.length === 1 ? matches[0]! : null;
  }

  /** exit 1 を「該当なし」（空文字）として返すか。その他の失敗は null（判定不能）。 */
  private run(cmd: string, args: string[], exitOneIsEmpty = false, signal?: AbortSignal): Promise<string | null> {
    return withProbeAbort(() => new Promise<string | null>((resolve) => {
      this.exec(cmd, args, (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        resolve(exitOneIsEmpty && error.code === 1 ? "" : null);
      }, signal);
    }), signal);
  }
}

/** その会話の Claude 本体か（argv にセッション id が独立した語としてあり、シェルの `-c` ではない）。 */
function isClaudeProcessFor(command: string, sessionId: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const exe = path.basename(tokens[0] ?? "");
  if (exe === "sh" || exe === "bash" || exe === "zsh" || exe === "dash" || exe === "fish") return false;
  return tokens.includes(sessionId);
}

/**
 * 起動元の Bash: プロセスの開始時刻以前に始まった Bash のうち最も新しいもの（まだ終わっていないものを優先）。
 * シェルの command に Bash のコマンドの先頭がそのまま入っていれば、それを最優先する（同じ秒に並列で起動した Bash の区別）。
 */
export function pickOriginBash(
  row: ProcessRow,
  calls: readonly BashCall[],
  options: { requireTextMatch?: boolean } = {},
): string | null {
  // lstart は秒精度なので 1 秒の余裕を持たせる。
  const eligible = calls.filter((call) => call.startMs <= row.startMs + 1_000
    && (call.endMs === null || call.endMs >= row.startMs - 1_000));
  if (eligible.length === 0) return null;
  const haystack = normalizeForMatch(row.command);
  const byText = eligible.filter((call) => {
    const needle = normalizeForMatch(call.command).slice(0, 80);
    return needle.length >= 4 && haystack.includes(needle);
  });
  if (byText.length === 0 && options.requireTextMatch === true) return null;
  const pool = byText.length > 0
    ? byText
    : eligible.some((call) => call.endMs === null) ? eligible.filter((call) => call.endMs === null) : eligible;
  return pool.reduce((a, b) => (b.startMs > a.startMs ? b : a)).toolUseId;
}

// MARK: - まとめ役

/** ノードとして流す Codex の 1 回の実行。 */
export interface CodexExecRun {
  nodeId: string;
  rolloutId: string;
  rolloutPath: string;
  toolUseId: string;
  owner: string;
  startMs: number;
  lastTs: number | null;
  label: string;
  model: string | null;
  effort: string | null;
  status: "running" | "completed" | "error";
  activity: ToolActivity | null;
}

export const CODEX_EXEC_NODE_PREFIX = "codex-exec:";

export interface CodexExecLinkerOptions {
  /** codex ホーム（既定 `~/.codex`）。 */
  codexHome?: string;
  /** 控えのファイル（既定 `~/.tailii/codex-exec-links.jsonl`）。 */
  linksPath?: string;
  /** `~` の展開に使うホーム（既定 os.homedir()）。 */
  home?: string;
  exec?: ProcessProbeExec;
  now?: () => number;
  /** 評価の間隔の下限（ms, 既定 2 秒）。 */
  intervalMs?: number;
  /** Claude の登録簿（既定 `~/.claude/sessions`。`CLAUDE_CONFIG_DIR` / `TAILII_CLAUDE_SESSIONS_DIR` に従う）。 */
  claudeSessionsDir?: string;
  /** 登録簿の pid の生存と起動時刻の一致（既定 claudeProcessAlive）。 */
  processAlive?: (pid: number, procStart: string | null, signal?: AbortSignal) => boolean | Promise<boolean>;
}

const defaultExec: ProcessProbeExec = (cmd, args, callback, signal) => {
  probeExecFile(cmd, args, { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, signal }, (error, stdout) => {
    callback(error as (Error & { code?: unknown }) | null, stdout ?? "");
  });
};

/** 対応づけ・記録の探索・状態の判定をまとめる（tailer 1 本ごとに 1 つ）。 */
export class CodexExecLinker {
  readonly index: ExecRolloutIndex;
  readonly links: CodexExecLinkStore;
  private readonly home: string;
  private readonly exec: ProcessProbeExec;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private summaries = new RolloutSummaryCache();
  private observer: CodexExecObserver;
  private readonly observerFactory: () => CodexExecObserver;
  private generation = 0;
  private evaluationAbort: AbortController | null = null;
  private readonly statusProbes = new Map<string, { nextAtMs: number; open: boolean | null; size: number; mtimeMs: number }>();
  private readonly pathsByNodeId = new Map<string, string>();
  private nextEvalMs = Number.NEGATIVE_INFINITY;
  private evaluating = false;
  private lastObserveMs = Number.NEGATIVE_INFINITY;
  private liveRolloutPaths = new Set<string>();

  constructor(options: CodexExecLinkerOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.now = options.now ?? Date.now;
    this.exec = options.exec ?? defaultExec;
    this.intervalMs = options.intervalMs ?? OBSERVE_INTERVAL_MS;
    this.index = new ExecRolloutIndex(options.codexHome ?? path.join(this.home, ".codex"), this.home);
    this.links = new CodexExecLinkStore(options.linksPath ?? path.join(this.home, ".tailii", "codex-exec-links.jsonl"), this.now);
    this.observerFactory = () => new CodexExecObserver({
      exec: this.exec, now: this.now, index: this.index, home: this.home,
      claudeSessionsDir: options.claudeSessionsDir ?? defaultClaudeSessionsDir(),
      // reaper の生存確認は従来のまま。定期的な対応づけから呼ぶ ps だけ共有枠を使う。
      // 待ちの置換も ps の失敗と同じく生存扱い。見送っただけの pid を死亡確定にしない。
      processAlive: options.processAlive ?? ((pid, procStart, signal) => periodicWorkLimiter.run(
        `claude-pid:${pid}`, "background", () => claudeProcessAlive(pid, procStart),
        signal,
      ).catch(() => true)),
    });
    this.observer = this.observerFactory();
  }

  /** `codex-exec:<id>` のノードの記録のパス（評価で見たもののみ）。 */
  rolloutPath(nodeId: string): string | null {
    const known = this.pathsByNodeId.get(nodeId);
    if (known !== undefined) return existingRolloutPath(known);
    if (!nodeId.startsWith(CODEX_EXEC_NODE_PREFIX)) return null;
    const id = nodeId.slice(CODEX_EXEC_NODE_PREFIX.length);
    const links = this.links.load();
    for (let i = links.length - 1; i >= 0; i--) {
      if (links[i]!.rolloutId === id) return existingRolloutPath(links[i]!.rolloutPath);
    }
    return null;
  }

  /** 次の evaluate が間隔の下限を過ぎているか（呼び出し側が Bash の並びを組む前に見る）。 */
  due(): boolean {
    return !this.evaluating && this.now() >= this.nextEvalMs;
  }

  /** tail の世代を切り替え、旧評価を取消す。旧世代の完了でキャッシュや時刻を戻さない。 */
  reset(): void {
    const previous = this.evaluationAbort;
    this.evaluationAbort = null;
    this.generation++;
    this.evaluating = false;
    this.pathsByNodeId.clear();
    this.statusProbes.clear();
    this.summaries = new RolloutSummaryCache();
    this.observer = this.observerFactory();
    this.liveRolloutPaths = new Set();
    this.lastObserveMs = Number.NEGATIVE_INFINITY;
    this.nextEvalMs = Number.NEGATIVE_INFINITY;
    previous?.abort();
  }

  /**
   * 今の Bash の並びに対して実行を求める。間隔の下限より早い呼び出しは null（前回のまま）。
   * `sessionAlive` が false（死亡確定）のときは観測しない。
   */
  async evaluate(input: {
    sessionId: string;
    calls: readonly BashCall[];
    sessionAlive: boolean | null;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<CodexExecRun[] | null> {
    const nowMs = this.now();
    if (input.signal?.aborted || this.evaluating || (input.force !== true && !this.due())) return null;
    const generation = this.generation;
    const abort = new AbortController();
    const signal = input.signal === undefined ? abort.signal : AbortSignal.any([input.signal, abort.signal]);
    const onAbort = (): void => { if (this.evaluationAbort === abort) this.reset(); };
    this.evaluationAbort = abort;
    signal.addEventListener("abort", onAbort, { once: true });
    this.evaluating = true;
    try {
      const runs = await this.evaluateNow(input, nowMs, signal, generation);
      this.checkGeneration(signal, generation);
      return runs;
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return null;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (generation === this.generation && this.evaluationAbort === abort) {
        this.nextEvalMs = nextStartAtMs(nowMs, this.now(), this.intervalMs, 30_000);
        this.evaluating = false;
        this.evaluationAbort = null;
      }
    }
  }

  private checkGeneration(signal: AbortSignal, generation: number): void {
    signal.throwIfAborted();
    if (generation !== this.generation) throw new DOMException("古い購読の評価", "AbortError");
  }

  private async evaluateNow(input: {
    sessionId: string;
    calls: readonly BashCall[];
    sessionAlive: boolean | null;
  }, nowMs: number, signal: AbortSignal, generation: number): Promise<CodexExecRun[]> {
    this.checkGeneration(signal, generation);
    const callsById = new Map(input.calls.map((call) => [call.toolUseId, call]));

    // 実行中の観測（Bash が動いている間か、追跡中のプロセスがある間だけ）。
    if (input.sessionAlive !== false && nowMs - this.lastObserveMs >= OBSERVE_INTERVAL_MS
      && (input.calls.some((call) => call.endMs === null) || this.observer.hasTracked())) {
      this.lastObserveMs = nowMs;
      const known = new Set(this.links.load().map((link) => link.rolloutId));
      const observed = await this.observer.observe(input.sessionId, input.calls, known, signal).catch(() => null);
      this.checkGeneration(signal, generation);
      if (observed !== null) {
        this.liveRolloutPaths = observed.liveRolloutPaths;
        for (const link of observed.links) {
          if (!known.has(link.rolloutId)) this.links.append(link);
        }
      }
    }

    // 控え: この会話の分は規則より優先、別の会話の分は規則でも付けない。
    const assigned = new Map<string, { path: string; toolUseId: string; owner: string }>();
    const excluded = new Set<string>();
    for (const link of this.links.load()) {
      if (link.claudeSessionId !== input.sessionId) {
        excluded.add(link.rolloutId);
        continue;
      }
      const call = callsById.get(link.toolUseId);
      if (call === undefined) continue;
      assigned.set(link.rolloutId, { path: link.rolloutPath, toolUseId: call.toolUseId, owner: call.owner });
    }
    for (const id of assigned.keys()) excluded.add(id);
    for (const match of matchByRules(input.calls, this.index, { nowMs, home: this.home, excludedIds: excluded })) {
      const call = callsById.get(match.toolUseId);
      if (call === undefined) continue;
      assigned.set(match.meta.id, { path: match.meta.path, toolUseId: call.toolUseId, owner: call.owner });
    }

    const runs: CodexExecRun[] = [];
    for (const [id, entry] of assigned) {
      this.checkGeneration(signal, generation);
      const file = existingRolloutPath(entry.path);
      if (file === null) continue;
      const meta = this.index.meta(file);
      const initialSummary = this.summaries.summary(file);
      if (meta === null || initialSummary === null) continue;
      const { status, summary } = await this.status(file, initialSummary, nowMs, signal, generation);
      this.checkGeneration(signal, generation);
      const nodeId = `${CODEX_EXEC_NODE_PREFIX}${id}`;
      this.pathsByNodeId.set(nodeId, file);
      runs.push({
        nodeId,
        rolloutId: id,
        rolloutPath: file,
        toolUseId: entry.toolUseId,
        owner: entry.owner,
        startMs: meta.startMs,
        lastTs: summary.lastTs,
        label: requestLabel(summary.firstUserText),
        model: summary.model,
        effort: summary.effort,
        status,
        activity: status === "running" ? summary.lastActivity : null,
      });
    }
    runs.sort((a, b) => a.startMs - b.startMs || (a.rolloutId < b.rolloutId ? -1 : 1));
    return runs;
  }

  /**
   * 完了 = task_complete / 失敗 = turn_aborted、または終わりの行が無いのに記録を開いているプロセスがいない /
   * 実行中 = 終わりの行が無く、記録を開いているプロセスがいる（確認できないときは実行中に倒す）。
   */
  private async status(file: string, summary: RolloutSummarySnapshot, nowMs: number, signal: AbortSignal, generation: number): Promise<{ status: CodexExecRun["status"]; summary: RolloutSummary }> {
    if (summary.terminal === "completed") return { status: "completed", summary };
    if (summary.terminal === "aborted") return { status: "error", summary };
    if (this.liveRolloutPaths.has(file)) return { status: "running", summary };
    if (isCompressedRollout(file)) return { status: "error", summary };
    const cached = this.statusProbes.get(file);
    // 要約を作ったときの版を使う。要約後・プローブ開始前に変わった記録も検出する。
    const size = summary.size, mtimeMs = summary.mtimeMs;
    // 誰も開いていなかった記録は、伸びない限り失敗のまま（中断された実行を lsof で見続けない）。
    const unchanged = cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs;
    let open: boolean | null;
    if (cached !== undefined && unchanged && (cached.open === false || nowMs < cached.nextAtMs)) {
      open = cached.open;
    } else {
      open = await withProbeAbort(() => new Promise<boolean | null>((resolve) => {
        this.exec("lsof", ["-t", "--", file], (error, stdout) => {
          if (error === null) resolve(stdout.trim().length > 0);
          else resolve(error.code === 1 ? false : null);
        }, signal);
      }), signal);
      this.checkGeneration(signal, generation);
      let currentSize = -1, currentMtimeMs = -1;
      try {
        const stat = fs.statSync(file);
        currentSize = stat.size; currentMtimeMs = stat.mtimeMs;
      } catch { /* 消失・差し替えも更新として扱う。 */ }
      // 枠待ち中に記録が変わったら読み直す。終端行が無ければ古い負の結果は採用しない。
      if (currentSize !== size || currentMtimeMs !== mtimeMs) {
        summary = this.summaries.summary(file) ?? summary;
        open = null;
      }
      this.statusProbes.set(file, {
        nextAtMs: nextStartAtMs(nowMs, this.now(), STATUS_PROBE_TTL_MS, 30_000), open,
        size: currentSize, mtimeMs: currentMtimeMs,
      });
    }
    // 表示する時刻・モデル等も、この判定に用いた要約と揃えて返す。
    const status = summary.terminal === "completed" ? "completed" : summary.terminal === "aborted" ? "error"
      : open === false ? "error" : "running";
    return { status, summary };
  }
}

/** 記録が圧縮されて `.jsonl.zst` に変わっていたらそちらを返す。どちらも無ければ null。 */
export function existingRolloutPath(file: string): string | null {
  if (fs.existsSync(file)) return file;
  if (file.endsWith(".jsonl") && fs.existsSync(`${file}.zst`)) return `${file}.zst`;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
