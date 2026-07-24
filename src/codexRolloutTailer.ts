// codexRolloutTailer.ts
// tailii (TS host) — codex（OpenAI Codex CLI）会話出力キャプチャ（rollout tail）
// claude 用 TranscriptTailer の codex 版。`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を
// tail し、`event_msg`（user_message / agent_message / token_count）を
// `chat_output` デルタ（1 ターン = 1 streamId、確定で eof:true）へ変換する。
//
// claude との差:
//   - 解決キーが「claude projects slug」ではなく「session_meta.payload.cwd == 実 cwd」。
//     rollout は日付ディレクトリに散らばるため、cwd 一致の最新 rollout を走査で選ぶ。
//   - 本文は event_msg から、tool 実行（コマンド/ファイル変更/プラン）は response_item と
//     patch_apply_end から tool_activity カードへ写像する（codex-tool-cards）。
//   - reasoning / 承認は扱わない。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROTOCOL_V1, type ChatRole, type ControlMessage } from "./protocol.js";
import { canonicalPath } from "./paths.js";
import { abortableSleep } from "./sleep.js";
import {
  rolloutPatchApplyActivities,
  rolloutResponseItemToolActivities,
  toolActivityMessage,
} from "./codexToolActivity.js";

/** 履歴再生完了マーカーの streamId（claude 側と共通。iOS `ChatLogModel` と対で解釈）。 */
export const HISTORY_DONE_STREAM_ID = "pc:history-done";
/** 利用中モデル通知マーカーの streamId（claude 側と共通）。 */
export const MODEL_STREAM_ID = "pc:model";
/** 現在コンテキストトークン数通知マーカーの streamId（claude 側と共通）。 */
export const CONTEXT_STREAM_ID = "pc:context";
/** モデルに割り当てられたコンテキスト窓通知マーカーの streamId。 */
export const CONTEXT_WINDOW_STREAM_ID = "pc:context-window";

/** 既定の codex セッションルート（`~/.codex/sessions`）。 */
export function defaultCodexSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

/** session_meta 行の解決で読み取る先頭バイト上限（base_instructions が大きいため広めに取る）。 */
const META_READ_LIMIT_BYTES = 512 * 1024;

export interface CodexRolloutTailerOptions {
  /** 追記ポーリング間隔（ms）。既定 50ms。 */
  pollIntervalMs?: number;
  /** tail 継続の最大 ms。null/未指定なら EOF で即終了（tail しない）。 */
  tailDeadlineMs?: number | null;
  /** EOF 後も abort まで無期限に tail するか。既定 false（本番 engine は true）。 */
  tailIndefinitely?: boolean;
  /** 初回 EOF で履歴再生完了マーカーを流すか。既定 false。 */
  emitReplayDoneMarker?: boolean;
  /** rollout 走査ルート。テスト注入用。省略時は `~/.codex/sessions`。 */
  sessionsRoot?: string;
}

interface TailState {
  seq: number;
  lastModel: string | null;
  lastContextTokens: number | null;
  lastContextWindow: number | null;
}

export class CodexRolloutTailer {
  private readonly pollIntervalMs: number;
  private readonly tailDeadlineMs: number | null;
  private readonly tailIndefinitely: boolean;
  private readonly emitReplayDoneMarker: boolean;
  private readonly sessionsRoot: string;

  constructor(options: CodexRolloutTailerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.tailDeadlineMs = options.tailDeadlineMs ?? null;
    this.tailIndefinitely = options.tailIndefinitely ?? false;
    this.emitReplayDoneMarker = options.emitReplayDoneMarker ?? false;
    this.sessionsRoot = options.sessionsRoot ?? defaultCodexSessionsRoot();
  }

  /** この tailer の走査ルートで `cwd` 対応の rollout を解決する（未出現は null）。 */
  resolve(
    cwd: string,
    newerThanMs: number | null = null,
    preferredSessionId: string | null = null,
  ): string | null {
    return CodexRolloutTailer.resolveRollout(cwd, this.sessionsRoot, newerThanMs, preferredSessionId);
  }

  /**
   * `cwd` に対応する rollout JSONL を解決して tail する。
   * まだ無ければ出現をポーリングで待つ（無期限 tail は abort まで、上限 tail は deadline まで）。
   */
  async *streamForCwd(
    cwd: string,
    newerThanMs: number | null = null,
    signal?: AbortSignal,
    preferredSessionId: string | null = null,
  ): AsyncGenerator<ControlMessage, void, void> {
    const start = Date.now();
    let resolved: string | null = null;
    while (!signal?.aborted) {
      resolved = CodexRolloutTailer.resolveRollout(
        cwd,
        this.sessionsRoot,
        newerThanMs,
        preferredSessionId,
      );
      if (resolved !== null) break;
      if (!this.tailIndefinitely) {
        if (this.tailDeadlineMs === null || Date.now() - start >= this.tailDeadlineMs) return;
      }
      await abortableSleep(this.pollIntervalMs, signal);
    }
    if (resolved !== null && !signal?.aborted) {
      yield* this.runTail(resolved, newerThanMs, signal);
    }
  }

  /**
   * `sessionsRoot` 配下（日付階層）から `cwd` 一致の rollout を解決する。
   * 各 *.jsonl の先頭行 `session_meta.payload.cwd` を canonical 比較し、mtime 最新を選ぶ。
   * newerThanMs 指定時はそれより後に更新された rollout のみを候補にする。無ければ null。
   */
  static resolveRollout(
    cwd: string,
    sessionsRoot: string,
    newerThanMs: number | null = null,
    preferredSessionId: string | null = null,
  ): string | null {
    const target = canonicalPath(cwd);
    const files = listRolloutFiles(sessionsRoot);
    // 最新から順に見て、cwd 一致の最初の 1 本を返す（新しい会話を優先）。
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files) {
      if (newerThanMs !== null && file.mtimeMs <= newerThanMs) continue;
      const meta = readRolloutMeta(file.path);
      if (meta === null) continue;
      if (preferredSessionId !== null && meta.id !== preferredSessionId) continue;
      if (canonicalPath(meta.cwd) === target) return file.path;
    }
    return null;
  }

  /** 単一 rollout JSONL を頭から読み、tail する共有ループ（TranscriptTailer と同構造）。 */
  private async *runTail(
    rolloutPath: string,
    newerThanMs: number | null,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    let fd: number;
    try {
      fd = fs.openSync(rolloutPath, "r");
    } catch {
      return;
    }
    try {
      let position = 0;
      let lineBuf = Buffer.alloc(0);
      const state: TailState = {
        seq: 0,
        lastModel: null,
        lastContextTokens: null,
        lastContextWindow: null,
      };
      const start = Date.now();
      let announcedReplayDone = false;
      const chunk = Buffer.alloc(4096);

      while (!signal?.aborted) {
        let bytesRead = 0;
        try {
          bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
        } catch {
          bytesRead = 0;
        }

        if (bytesRead === 0) {
          // 初回 EOF = 既存内容の再生完了。マーカー有効時は完了シグナルを 1 通流す。
          if (this.emitReplayDoneMarker && !announcedReplayDone) {
            announcedReplayDone = true;
            if (lineBuf.length > 0) {
              yield* emitLineAfter(lineBuf, state, newerThanMs);
              lineBuf = Buffer.alloc(0);
            }
            yield {
              type: "chat_output",
              v: PROTOCOL_V1,
              streamId: HISTORY_DONE_STREAM_ID,
              role: "system",
              text: "",
              eof: true,
            };
          }
          if (!this.tailIndefinitely) {
            if (this.tailDeadlineMs === null || Date.now() - start >= this.tailDeadlineMs) {
              if (lineBuf.length > 0) yield* emitLineAfter(lineBuf, state, newerThanMs);
              return;
            }
          }
          await abortableSleep(this.pollIntervalMs, signal);
          continue;
        }

        position += bytesRead;
        lineBuf = Buffer.concat([lineBuf, chunk.subarray(0, bytesRead)]);
        let nl = lineBuf.indexOf(0x0a);
        while (nl >= 0) {
          const line = lineBuf.subarray(0, nl);
          lineBuf = lineBuf.subarray(nl + 1);
          yield* emitLineAfter(line, state, newerThanMs);
          nl = lineBuf.indexOf(0x0a);
        }
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // 二重 close 等は無視。
      }
    }
  }
}

/** Hub 世代変更時は切断後の rollout 行だけを再送し、既表示本文を backfill しない。 */
function* emitLineAfter(
  line: Buffer,
  state: TailState,
  newerThanMs: number | null,
): Generator<ControlMessage, void, void> {
  if (newerThanMs !== null && lineTimestampMs(line) <= newerThanMs) return;
  yield* emitLine(line, state);
}

function lineTimestampMs(line: Buffer): number {
  try {
    const parsed = JSON.parse(line.toString("utf8")) as { timestamp?: unknown };
    if (typeof parsed.timestamp === "string") {
      const timestamp = Date.parse(parsed.timestamp);
      return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    }
    if (typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)) {
      return parsed.timestamp < 10_000_000_000 ? parsed.timestamp * 1_000 : parsed.timestamp;
    }
  } catch { /* emitLine と同様に不正行は破棄する。 */ }
  return Number.NEGATIVE_INFINITY;
}

/** rollout ファイル（mtime 付き）を日付階層から列挙する。 */
function listRolloutFiles(sessionsRoot: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(p).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        out.push({ path: p, mtimeMs });
      }
    }
  };
  walk(sessionsRoot);
  return out;
}

/** rollout の先頭 `session_meta` 行から `payload.cwd` を読む。読めなければ null。 */
function readRolloutMeta(rolloutPath: string): { id: string | null; cwd: string } | null {
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(META_READ_LIMIT_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    const slice = buf.subarray(0, bytesRead);
    const nl = slice.indexOf(0x0a);
    const firstLine = (nl >= 0 ? slice.subarray(0, nl) : slice).toString("utf8");
    const parsed = JSON.parse(firstLine) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "session_meta"
    ) {
      const payload = (parsed as { payload?: unknown }).payload;
      if (typeof payload === "object" && payload !== null) {
        const cwd = (payload as { cwd?: unknown }).cwd;
        const id = (payload as { id?: unknown }).id;
        if (typeof cwd === "string" && cwd.length > 0) {
          return { id: typeof id === "string" && id.length > 0 ? id : null, cwd };
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 無視。
    }
  }
}

/**
 * codex rollout の 1 行（JSONL）をパースし、生成メッセージを列挙する。
 * 対象:
 *   - turn_context → 利用中モデルマーカー
 *   - `event_msg`:
 *     - user_message  → user ロールの chat_output
 *     - agent_message（commentary / final_answer）→ assistant ロールの chat_output
 *     - token_count   → コンテキストトークン数／窓マーカー
 *     - patch_apply_end → ファイル変更カード（tool_activity, codex-tool-cards）
 *   - `response_item`:
 *     - custom_tool_call "exec" / function_call "exec_command" → コマンド実行カード
 *     - function_call "update_plan" → プラン更新カード
 * 解釈できない行・対象外イベントはスキップ。
 */
export function* emitLine(line: Buffer, state: TailState): Generator<ControlMessage, void, void> {
  const text = line.toString("utf8").replaceAll("\r", "");
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as { type?: unknown; payload?: unknown };
  if (record.type === "turn_context") {
    const context = asRecord(record.payload);
    const model = context?.["model"];
    if (typeof model === "string" && model.length > 0 && model !== state.lastModel) {
      state.lastModel = model;
      yield marker(MODEL_STREAM_ID, model);
    }
    return;
  }
  if (record.type === "response_item") {
    const payload = asRecord(record.payload);
    if (payload === null) return;
    for (const activity of rolloutResponseItemToolActivities(payload)) {
      yield toolActivityMessage(activity);
    }
    return;
  }
  if (record.type !== "event_msg") return;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return;
  const kind = (payload as { type?: unknown }).type;

  if (kind === "patch_apply_end") {
    for (const activity of rolloutPatchApplyActivities(payload as Record<string, unknown>)) {
      yield toolActivityMessage(activity);
    }
    return;
  }

  if (kind === "user_message" || kind === "agent_message") {
    // commentary は長時間ターンの途中経過、final_answer は最終回答としてどちらも表示する。
    // 未知 phase は将来形式を誤表示しないよう破棄する。phase 欠落は旧版互換で採用する。
    if (kind === "agent_message") {
      const phase = (payload as { phase?: unknown }).phase;
      if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") return;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message !== "string" || message.length === 0) return;
    const role: ChatRole = kind === "user_message" ? "user" : "assistant";
    state.seq += 1;
    const clientId = kind === "user_message"
      ? (payload as { client_id?: unknown }).client_id
      : undefined;
    // Tailii が turn/start に渡した clientUserMessageId は rollout の client_id として
    // 保存される。ユーザー発話だけはこの安定IDを streamId に使い、アプリ再起動や
    // 上書きインストール後の履歴再生でもローカル楽観バブルと厳密に同一視できるようにする。
    const streamId = typeof clientId === "string" && clientId.length > 0
      ? `codex-user-${clientId}`
      : `codex-turn-${state.seq}`;
    yield {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId,
      role,
      text: message,
      eof: true,
    };
    return;
  }

  if (kind === "token_count") {
    const info = (payload as { info?: unknown }).info;
    if (typeof info === "object" && info !== null) {
      // total_token_usage は全ターン累積で context window と比較できない。
      // 現在の会話コンテキスト量を表す last_token_usage を使用する。
      const usage = (info as { last_token_usage?: unknown }).last_token_usage;
      if (typeof usage === "object" && usage !== null) {
        const total = (usage as { total_tokens?: unknown }).total_tokens;
        if (isNonNegativeInteger(total) && total !== state.lastContextTokens) {
          state.lastContextTokens = total;
          yield marker(CONTEXT_STREAM_ID, String(total));
        }
      }
      const contextWindow = (info as { model_context_window?: unknown }).model_context_window;
      if (isPositiveInteger(contextWindow) && contextWindow !== state.lastContextWindow) {
        state.lastContextWindow = contextWindow;
        yield marker(CONTEXT_WINDOW_STREAM_ID, String(contextWindow));
      }
    }
    return;
  }
}

function marker(streamId: string, text: string): ControlMessage {
  return {
    type: "chat_output",
    v: PROTOCOL_V1,
    streamId,
    role: "system",
    text,
    eof: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}
