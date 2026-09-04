// transcriptTailer.ts
// tailii (TS host) — 会話出力キャプチャ（claude セッショントランスクリプト tail）
// Swift 版 TranscriptTailer.swift の移植。
// claude のセッショントランスクリプト（JSONL）を tail し、assistant/user ターンのテキストを
// `chat_output` デルタ（1 ターン = 1 streamId、確定で eof:true）として生成する。
// あわせて tool_use → tool_activity / AskUserQuestion → question_prompt / tool_result →
// question_dismiss / model 変化 → モデルマーカーを送出する。
// 抽出対象を text ブロックに限定し、秘密（接続鍵）を運ぶ経路を作らない（9.3）。

import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROTOCOL_V1,
  type ChatRole,
  type ControlMessage,
  type QuestionOption,
  type QuestionPromptQuestion,
  type ToolActivity,
  type ToolActivityDiff,
  type ToolActivityTodo,
} from "../protocol.js";
import { isInjectedSkillContent } from "../shared/skillInjection.js";
import { abortableSleep } from "../shared/sleep.js";
import {
  createSystemNoticeContext,
  fallbackBlockNotice,
  systemNoticeText,
  type SystemNoticeContext,
} from "../shared/systemNotice.js";

/** 履歴再生完了マーカーの streamId（iOS 側 `ChatLogModel` と対で解釈する）。 */
export const HISTORY_DONE_STREAM_ID = "pc:history-done";
/** 利用中モデル通知マーカーの streamId（iOS 側 `ChatLogModel` と対で解釈する）。 */
export const MODEL_STREAM_ID = "pc:model";
/** 現在コンテキストトークン数通知マーカーの streamId（iOS 側 `ChatLogModel` と対で解釈する）。 */
export const CONTEXT_STREAM_ID = "pc:context";
/**
 * 実効 reasoning effort 通知マーカーの streamId（iOS 側 `ChatLogModel` と対で解釈する）。
 * claude は assistant 行のトップレベル `effort` に、その応答で実際に使った effort を記録する
 * （`--effort` 起動値 / `/effort` 変更後の値。2.1.234 で確認）。iOS の工数バッジは楽観表示
 * しか持たなかったので、これを権威として同期する。
 */
export const EFFORT_STREAM_ID = "pc:effort";
/** claude の effort 既知値（未知値は通知しない）。 */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * 利用者の中断確定マーカー（claude が transcript に user 行として記録する
 * "[Request interrupted by user]" / "[Request interrupted by user for tool use]"）。
 * iOS 側 `ChatLogModel` は同じ文字列を `contains` で「停止中」解除に使うが、host は処理中状態
 * （権威）を落とす側なので行頭一致に絞り、ピア封筒などの本文引用では反応しない。
 */
const INTERRUPT_MARKER_PREFIX = "[Request interrupted by user";

/** user ターン本文が中断確定マーカーか（行頭一致。本文中の引用は除外する）。 */
function isClaudeInterruptMarker(text: string): boolean {
  return text.trimStart().startsWith(INTERRUPT_MARKER_PREFIX);
}

/**
 * transcript 末尾を読み、最後の user 発話（本文のある user ターン）が中断確定マーカーなら
 * その行の timestamp(ms) を返す。マーカーの後に新しい発話があれば null（=ターン進行中の
 * 可能性）。Hub 再起動時の復元で「再起動前に中断済みで放置された会話」を処理中に戻さない
 * ために使う（engine の再接続購読は newerThanMs 付きで履歴マーカーを流さないため、tail
 * 経由では観測できない）。本文の無い user 行（tool_result / 画像のみ / スキル注入）と
 * ローカルコマンド記録（type=system の `/effort` `/rename` 等。ターンを始めない）は発話と
 * みなさない。画像のみの発話で始まった進行中ターンは稀に idle 判定になり得るが、次の hook
 * （PreToolUse 等）の active で数秒後に自己修復する。末尾 tailBytes だけを読むので、それより
 * 長い最終行は解釈できず null（=処理中のまま）に倒れる。
 */
export function findTrailingInterruptMarkerMs(transcriptPath: string, tailBytes = 256 * 1024): number | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    // 1 バイト手前から読み、窓の先頭が行境界なら先頭要素は空文字になる（完全な行を捨てない）。
    const readStart = start > 0 ? start - 1 : 0;
    const buffer = Buffer.alloc(size - readStart);
    const read = fs.readSync(fd, buffer, 0, buffer.length, readStart);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 途中から読んだ先頭の欠け行（または境界の空要素）を捨てる。
    let last: { interrupt: boolean; atMs: number } | null = null;
    for (const raw of lines) {
      const line = raw.replaceAll("\r", "");
      if (!line) continue;
      if (isSystemRecordLine(line)) continue;
      const turn = extractTurn(line);
      if (turn === null || turn.role !== "user" || turn.text.length === 0) continue;
      last = { interrupt: isClaudeInterruptMarker(turn.text), atMs: lineTimestampMs(Buffer.from(line, "utf8")) };
    }
    if (last === null || !last.interrupt || !Number.isFinite(last.atMs)) return null;
    return last.atMs;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 二重 close 等は無視。
    }
  }
}

/**
 * transcript 由来の claude ターン権威ライフサイクル。Claude Code の Stop hook は利用者の中断では
 * 発火しないため、hook だけを見ている hub の処理中状態がターン終了後も残る。中断マーカーを
 * timestamp 付きで観測し、hub が「処理開始より後のマーカー」だけを処理完了へ写像する
 * （codex の `CodexTurnLifecycleEvent` と同型の副チャネル）。
 */
export interface ClaudeTurnLifecycleEvent {
  kind: "interrupted";
  /** transcript 行の timestamp（Unix ms）。履歴再生で流れる過去ターンのマーカーを除外する根拠。 */
  atMs: number;
}

const MAX_COMMAND_CHARACTERS = 8_000;
const MAX_DESCRIPTION_CHARACTERS = 2_000;
const MAX_DIFF_FIELD_CHARACTERS = 24_000;
/** TodoWrite チェックリストの最大項目数。 */
const MAX_TODO_ITEMS = 50;
/** TodoWrite 項目本文の最大文字数。 */
const MAX_TODO_CONTENT_CHARACTERS = 300;
/** スキル本文の後付けを待つ Skill カードの最大保持数。 */
const MAX_PENDING_SKILL_ACTIVITIES = 16;

export interface TranscriptTailerOptions {
  /** 追記ポーリング間隔（ms）。既定 50ms。 */
  pollIntervalMs?: number;
  /** tail 継続の最大 ms。null/未指定なら EOF で即終了（tail しない）。 */
  tailDeadlineMs?: number | null;
  /** EOF 後も abort まで無期限に tail するか。既定 false（本番 engine は true）。 */
  tailIndefinitely?: boolean;
  /** 初回 EOF で履歴再生完了マーカーを流すか。既定 false（セッション連動 tail のみ true）。 */
  emitReplayDoneMarker?: boolean;
}

/** 抽出された 1 ターン。 */
interface Turn {
  id: string | null;
  role: ChatRole;
  text: string;
  toolActivities: ToolActivity[];
  questionPrompts: { id: string; questions: QuestionPromptQuestion[] }[];
  toolResultIds: string[];
  model: string | null;
  contextTokens: number | null;
  /** assistant 行の実効 reasoning effort（トップレベル `effort`。既知値以外は null）。 */
  effort: string | null;
  /** Skill ツール起動で注入されたスキル本文（該当ツールカードへ後付けする）。 */
  skillInjection?: { toolUseId: string; text: string };
}

/** tail 中の可変状態（1 ストリームぶん）。 */
interface TailState {
  seq: number;
  lastModel: string | null;
  lastContextTokens: number | null;
  lastEffort: string | null;
  /** system 注記の連投・重複抑止（api_error の再試行 / 同一警告 / fallback 二重告知, system-notice）。 */
  noticeCtx: SystemNoticeContext;
  activeQuestionIds: Set<string>;
  /** 本文待ちの Skill ツールカード（tool_use id → 発行済み activity）。 */
  pendingSkillActivities: Map<string, ToolActivity>;
  /** ターン権威ライフサイクルの観測者（hub が処理中状態の補完に使う）。 */
  onLifecycle: ((event: ClaudeTurnLifecycleEvent) => void) | null;
}

/** claude セッショントランスクリプト（JSONL）の tail 実装。 */
export class TranscriptTailer {
  private readonly pollIntervalMs: number;
  private readonly tailDeadlineMs: number | null;
  private readonly tailIndefinitely: boolean;
  private readonly emitReplayDoneMarker: boolean;
  private lifecycleObserver: ((event: ClaudeTurnLifecycleEvent) => void) | null = null;

  constructor(options: TranscriptTailerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.tailDeadlineMs = options.tailDeadlineMs ?? null;
    this.tailIndefinitely = options.tailIndefinitely ?? false;
    this.emitReplayDoneMarker = options.emitReplayDoneMarker ?? false;
  }

  /** ターン権威ライフサイクル（中断マーカー等）の観測者を登録する。以後に開始した tail から有効。 */
  setTurnLifecycleObserver(observer: ((event: ClaudeTurnLifecycleEvent) => void) | null): void {
    this.lifecycleObserver = observer;
  }

  /** `path` の JSONL を頭から読み、assistant/user ターンを chat_output として流す。 */
  async *streamTranscript(
    transcriptPath: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    yield* this.runTail(transcriptPath, null, signal);
  }

  /**
   * `projectDir`（`~/.claude/projects/<slug>/`）配下の対象 JSONL を解決して tail する。
   * preferredSessionId 指定時は `<id>.jsonl` 優先、無指定は最新 mtime の *.jsonl。
   * まだ無ければ出現をポーリングで待つ（無期限 tail は abort まで、上限 tail は deadline まで）。
   */
  async *streamProjectDir(
    dir: string,
    preferredSessionId: string | null,
    newerThanMs: number | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    const start = Date.now();
    let resolved: string | null = null;
    while (!signal?.aborted) {
      resolved = TranscriptTailer.resolveJsonl(dir, preferredSessionId, newerThanMs);
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
   * `dir` 配下の対象 JSONL を解決する。
   * preferredSessionId 指定時は「その会話 `<id>.jsonl` だけ」を対象にする（実在しなければ null で
   * 出現待ちへフォールスルーし、mtime 最新の別会話へは決して吸着させない）。無指定時のみ最新 mtime の
   * *.jsonl（newerThanMs 指定時は、それより後に更新されたものだけを候補にする）。無ければ null。
   */
  static resolveJsonl(
    dir: string,
    preferredSessionId: string | null,
    newerThanMs: number | null = null,
  ): string | null {
    // preferred はその会話に厳密束縛する。新規セッションは engine が生成した session-id を
    // preferred として渡すため、同一 cwd に別の稼働会話があっても（その jsonl が mtime 最新でも）
    // 取り違えない。未出現なら null を返し、呼び出し側のポーリングで自会話の出現を待つ。
    if (preferredSessionId) {
      const candidate = path.join(dir, `${preferredSessionId}.jsonl`);
      return fs.existsSync(candidate) ? candidate : null;
    }
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return null;
    }
    let best: { path: string; mtimeMs: number } | null = null;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const p = path.join(dir, file);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (newerThanMs !== null && mtimeMs <= newerThanMs) continue;
      if (best === null || mtimeMs > best.mtimeMs) best = { path: p, mtimeMs };
    }
    return best?.path ?? null;
  }

  /** 単一 JSONL ファイルを頭から読み、tail する共有ループ。 */
  private async *runTail(
    transcriptPath: string,
    newerThanMs: number | null,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    let fd: number;
    try {
      fd = fs.openSync(transcriptPath, "r");
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
        lastEffort: null,
        noticeCtx: createSystemNoticeContext(),
        activeQuestionIds: new Set(),
        pendingSkillActivities: new Map(),
        onLifecycle: this.lifecycleObserver,
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
        // 改行区切りで完結行を切り出して処理する。
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

/** 世代変更後の backfill は切断後に記録された行だけを通す。timestamp 不明行は重複回避を優先して除外。 */
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

/** type=system の記録行か（ローカルコマンド記録など。extractTurn は表示用に user 扱いへ写す）。 */
function isSystemRecordLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed.type === "system";
  } catch {
    return false;
  }
}

/** 1 行（JSONL）をパースし、生成メッセージを列挙する。解釈できない行はスキップ。 */
function* emitLine(line: Buffer, state: TailState): Generator<ControlMessage, void, void> {
  const text = line.toString("utf8").replaceAll("\r", "");
  if (!text) return;
  const turn = extractTurn(text, state.noticeCtx);
  if (turn === null) return;

  // 中断確定マーカー: ターン終了の権威（Stop hook は中断で発火しない）。表示用の chat_output
  // とは別に、行の timestamp 付きで観測者へ通知する。timestamp 不明行は履歴/ライブを区別
  // できないため通知しない（誤って進行中ターンを終了扱いにしない側へ倒す）。
  if (state.onLifecycle !== null && turn.role === "user" && isClaudeInterruptMarker(turn.text)) {
    const atMs = lineTimestampMs(line);
    if (Number.isFinite(atMs)) state.onLifecycle({ kind: "interrupted", atMs });
  }

  for (const prompt of turn.questionPrompts) {
    if (state.activeQuestionIds.has(prompt.id)) continue;
    state.activeQuestionIds.add(prompt.id);
    yield { type: "question_prompt", v: PROTOCOL_V1, id: prompt.id, questions: prompt.questions };
  }

  for (const activity of turn.toolActivities) {
    // Skill ツールカードは注入されるスキル本文（後続の isMeta 行）を詳細へ後付けする
    // ため保持する。本文が届かないまま溜まらないよう上限で最古から破棄。
    if (activity.name === "Skill") {
      state.pendingSkillActivities.set(activity.id, activity);
      if (state.pendingSkillActivities.size > MAX_PENDING_SKILL_ACTIVITIES) {
        const oldest = state.pendingSkillActivities.keys().next().value;
        if (oldest !== undefined) state.pendingSkillActivities.delete(oldest);
      }
    }
    yield { type: "tool_activity", v: PROTOCOL_V1, activity };
  }

  // 注入されたスキル本文が届いたら、該当 Skill カードを本文付きで再送する
  // （iOS は同一 id の tool_activity を既存カードの更新として扱う）。
  if (turn.skillInjection !== undefined) {
    const pending = state.pendingSkillActivities.get(turn.skillInjection.toolUseId);
    if (pending !== undefined) {
      state.pendingSkillActivities.delete(turn.skillInjection.toolUseId);
      const bodyCap = cap(turn.skillInjection.text, MAX_COMMAND_CHARACTERS);
      const enriched: ToolActivity = { ...pending, commandTruncated: bodyCap.truncated };
      if (bodyCap.value !== null) enriched.command = bodyCap.value;
      yield { type: "tool_activity", v: PROTOCOL_V1, activity: enriched };
    }
  }

  for (const id of turn.toolResultIds) {
    if (!state.activeQuestionIds.has(id)) continue;
    state.activeQuestionIds.delete(id);
    yield { type: "question_dismiss", v: PROTOCOL_V1, id };
  }

  // 利用中モデルの通知: assistant ターンの `message.model` が変わったらマーカーを 1 通流す。
  // Claude Code が合成メッセージ（/remote-control 等の "No response requested."）へ記録する
  // プレースホルダ "<synthetic>" は実利用モデルではないため通知しない。
  if (turn.model !== null && !turn.model.startsWith("<") && turn.model !== state.lastModel) {
    state.lastModel = turn.model;
    yield {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId: MODEL_STREAM_ID,
      role: "system",
      text: turn.model,
      eof: true,
    };
  }

  // 実効 effort の通知: assistant 行の `effort` が変わったらマーカーを 1 通流す（工数バッジ同期）。
  if (turn.effort !== null && turn.effort !== state.lastEffort) {
    state.lastEffort = turn.effort;
    yield {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId: EFFORT_STREAM_ID,
      role: "system",
      text: turn.effort,
      eof: true,
    };
  }

  // 現在コンテキストトークン数の通知: assistant ターンの `message.usage` 合計が変わったらマーカーを 1 通流す。
  if (turn.contextTokens !== null && turn.contextTokens !== state.lastContextTokens) {
    state.lastContextTokens = turn.contextTokens;
    yield {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId: CONTEXT_STREAM_ID,
      role: "system",
      text: String(turn.contextTokens),
      eof: true,
    };
  }

  // テキストターン: 1 ターン = 1 chat_output（確定, eof:true）。
  if (turn.text.length > 0) {
    state.seq += 1;
    const streamId = turn.id ?? `turn-${state.seq}`;
    yield {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId,
      role: turn.role,
      text: turn.text,
      eof: true,
    };
  }
}

/** JSONL の 1 行から assistant/user ターンを寛容に抽出する（形式依存を 1 関数に集約）。 */
export function extractTurn(line: string, ctx?: SystemNoticeContext): Turn | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;

  // claude 2.x: ターン処理中に送信されたメッセージは通常の user 行ではなく、配信時点の
  // attachment(queued_command) 行としてだけ transcript に残る（queue-operation の
  // enqueue/remove はキュー操作のログで、取り消しがあり得るため写像しない）。
  if (rec["type"] === "attachment") {
    const attachment =
      typeof rec["attachment"] === "object" && rec["attachment"] !== null
        ? (rec["attachment"] as Record<string, unknown>)
        : null;
    if (attachment?.["type"] !== "queued_command") return null;
    const prompt = typeof attachment["prompt"] === "string" ? attachment["prompt"] : "";
    if (prompt.length === 0) return null;
    return {
      id: typeof rec["uuid"] === "string" ? rec["uuid"] : null,
      role: "user",
      text: prompt,
      toolActivities: [],
      questionPrompts: [],
      toolResultIds: [],
      model: null,
      contextTokens: null,
      effort: null,
    };
  }

  if (rec["type"] === "system") {
    const content = typeof rec["content"] === "string" ? rec["content"] : "";
    const emptyTurn = {
      id: typeof rec["uuid"] === "string" ? rec["uuid"] : null,
      toolActivities: [],
      questionPrompts: [],
      toolResultIds: [],
      model: null,
      contextTokens: null,
      effort: null,
    };
    // Remote Control の activation 通知（bridge_status）。未接続から /remote-control で
    // 有効化したとき、可視信号はこの行だけ（TUI バナーは通常ターンに残らない）。
    if (rec["subtype"] === "bridge_status" && content.includes("/remote-control is active")) {
      return { ...emptyTurn, role: "system", text: `📱 ${content}` };
    }
    // ローカルコマンドの実行/出力記録（<command-name> / <local-command-stdout> タグ）。
    // claude 2.1.220 は type=system で書く。iOS 側 present() がタグを
    // 「▶ /cmd」「出力の system 行」へ整形する（空出力は iOS 側で破棄）。
    if (rec["subtype"] === "local_command" && content.includes("<")) {
      return { ...emptyTurn, role: "user", text: content };
    }
    // 利用者に意味のある通知（モデル自動切替 / API エラー / 会話圧縮 / warning・error 級）を
    // 日本語の system 注記へ（system-notice）。握り潰すと「理由なくモデルが変わった」ように
    // 見える（2026-09-04 実障害: model_refusal_fallback）。転写規則は shared/systemNotice.ts。
    const notice = systemNoticeText(rec, ctx);
    if (notice !== null) return { ...emptyTurn, role: "system", text: notice };
    return null;
  }

  const message =
    typeof rec["message"] === "object" && rec["message"] !== null
      ? (rec["message"] as Record<string, unknown>)
      : null;
  const roleStr = (message?.["role"] as string | undefined) ?? (rec["type"] as string | undefined);
  let role: ChatRole;
  if (roleStr === "assistant") role = "assistant";
  else if (roleStr === "user") role = "user";
  else return null; // system / summary / 未知は対象外（text ターンに限定）

  const id =
    (typeof rec["uuid"] === "string" ? rec["uuid"] : null) ??
    (typeof rec["id"] === "string" ? rec["id"] : null);

  const rawContent = message?.["content"] ?? rec["content"];
  const plainText = extractText(rawContent);
  // AskUserQuestion の回答行は text ブロックではなく tool_result +
  // top-level toolUseResult.answers に記録される。通常の tool_result は会話ログへ
  // 流さず、設問と回答の構造を持つ行だけ user バブル用の要約へ変換する。
  // Claude Code はスキル実行時、展開済み SKILL.md 全文を user の text ブロックとして
  // transcript へ注入する。これはユーザー発話ではなくエージェント内部コンテキスト
  // なので会話画面へは転送せず、Skill ツール起動（sourceToolUseID あり）の場合だけ
  // 該当ツールカードの詳細本文として紐づける。
  const injectedSkill = role === "user" && isInjectedSkillContent(rec, plainText);
  const visiblePlainText = injectedSkill ? "" : plainText;
  const text = visiblePlainText || extractQuestionAnswerText(rec["toolUseResult"]);
  const toolActivities = extractToolActivities(rawContent);
  const questionPrompts = extractQuestionPrompts(rawContent, id);
  const toolResultIds = extractToolResultIds(rawContent);
  const model = typeof message?.["model"] === "string" ? (message["model"] as string) : null;
  const contextTokens = role === "assistant" ? extractContextTokens(message?.["usage"]) : null;
  const rawEffort = rec["effort"];
  const effort =
    role === "assistant" && typeof rawEffort === "string" && EFFORT_LEVELS.has(rawEffort) ? rawEffort : null;
  // モデル自動切替の実時刻告知: assistant 行の `fallback` ブロック（from/to）は切替の瞬間に
  // 書かれ、フォールバック先の最初のツール実行より前に位置する。本文もツールも無いこの行を
  // system 注記へ転写する（model は残して pc:model マーカーも同じ行で切り替える）。後から
  // 来る system/model_refusal_fallback は ctx で重複告知を抑える（system-notice）。
  if (role === "assistant" && text.length === 0 && toolActivities.length === 0) {
    const fallbackNotice = fallbackBlockNotice(rawContent, ctx);
    if (fallbackNotice !== null) {
      return {
        id, role: "system", text: fallbackNotice,
        toolActivities: [], questionPrompts: [], toolResultIds: [], model, contextTokens, effort,
      };
    }
  }
  const turn: Turn = { id, role, text, toolActivities, questionPrompts, toolResultIds, model, contextTokens, effort };
  if (injectedSkill && typeof rec["sourceToolUseID"] === "string" && plainText.length > 0) {
    turn.skillInjection = { toolUseId: rec["sourceToolUseID"], text: plainText };
  }
  return turn;
}

/** usage から現在コンテキスト相当のトークン数を合算する（未知フィールドは 0 扱い）。 */
function extractContextTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const rec = usage as Record<string, unknown>;
  return (
    numberOrZero(rec["input_tokens"]) +
    numberOrZero(rec["cache_read_input_tokens"]) +
    numberOrZero(rec["cache_creation_input_tokens"])
  );
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** content から text ブロックのみを連結する（tool_use/tool_result/image 等は無視）。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "text") continue;
    if (typeof rec["text"] === "string") parts.push(rec["text"]);
  }
  return parts.join("");
}

/** AskUserQuestion の toolUseResult を、会話ログへ表示するユーザー回答文へ整形する。 */
function extractQuestionAnswerText(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const result = value as Record<string, unknown>;
  const rawQuestions = result["questions"];
  const rawAnswers = result["answers"];
  if (!Array.isArray(rawQuestions)) return "";
  if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) return "";
  const answers = rawAnswers as Record<string, unknown>;
  const rows: string[] = [];
  for (const rawQuestion of rawQuestions) {
    if (typeof rawQuestion !== "object" || rawQuestion === null || Array.isArray(rawQuestion)) continue;
    const question = (rawQuestion as Record<string, unknown>)["question"];
    if (typeof question !== "string" || question.trim().length === 0) continue;
    const rawAnswer = answers[question];
    const answer =
      typeof rawAnswer === "string"
        ? rawAnswer.trim()
        : Array.isArray(rawAnswer)
          ? rawAnswer.filter((item): item is string => typeof item === "string").join("、").trim()
          : "";
    if (answer.length === 0) continue;
    rows.push(`・${question.trim()} → ${answer}`);
  }
  return rows.length > 0 ? `回答:\n${rows.join("\n")}` : "";
}

/** content から tool_use ブロックを構造化表示データへ変換する。 */
export function extractToolActivities(content: unknown): ToolActivity[] {
  if (!Array.isArray(content)) return [];
  const activities: ToolActivity[] = [];
  content.forEach((block, index) => {
    if (typeof block !== "object" || block === null) return;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_use") return;
    const name = rec["name"];
    if (typeof name !== "string" || !name) return;
    const id = typeof rec["id"] === "string" ? rec["id"] : `tool-${index + 1}`;
    const input =
      typeof rec["input"] === "object" && rec["input"] !== null && !Array.isArray(rec["input"])
        ? (rec["input"] as Record<string, unknown>)
        : {};
    activities.push(makeToolActivity(id, name, input));
  });
  return activities;
}

function makeToolActivity(id: string, name: string, input: Record<string, unknown>): ToolActivity {
  switch (name) {
    case "Bash": {
      const commandCap = cap(str(input["command"]), MAX_COMMAND_CHARACTERS);
      const descriptionCap = cap(str(input["description"]), MAX_DESCRIPTION_CHARACTERS);
      const summary = nonEmpty(descriptionCap.value) ?? commandPrefix(commandCap.value) ?? "Bash";
      const activity: ToolActivity = {
        id,
        name,
        label: `実行済み ${summary}`,
        commandTruncated: commandCap.truncated,
        descriptionTruncated: descriptionCap.truncated,
      };
      if (commandCap.value !== null) activity.command = commandCap.value;
      if (descriptionCap.value !== null) activity.description = descriptionCap.value;
      return activity;
    }
    case "Edit":
    case "MultiEdit": {
      const file = filePath(input);
      const oldCap = cap(str(input["old_string"]), MAX_DIFF_FIELD_CHARACTERS);
      const newCap = cap(str(input["new_string"]), MAX_DIFF_FIELD_CHARACTERS);
      const counts = lineDelta(str(input["old_string"]), str(input["new_string"]));
      const diff: ToolActivityDiff = {
        oldStringTruncated: oldCap.truncated,
        newStringTruncated: newCap.truncated,
      };
      if (oldCap.value !== null) diff.oldString = oldCap.value;
      if (newCap.value !== null) diff.newString = newCap.value;
      const activity: ToolActivity = {
        id,
        name,
        label: `編集済み ${displayPath(file, name)}`,
        addedLines: counts.added,
        removedLines: counts.removed,
        diff,
        commandTruncated: false,
        descriptionTruncated: false,
      };
      if (file !== null) activity.file = file;
      return activity;
    }
    case "Write":
    case "NotebookEdit": {
      const file = filePath(input);
      const newText = str(input["content"]) ?? str(input["new_string"]);
      const newCap = cap(newText, MAX_DIFF_FIELD_CHARACTERS);
      const counts = lineDelta(null, newText);
      const diff: ToolActivityDiff = { oldStringTruncated: false, newStringTruncated: newCap.truncated };
      if (newCap.value !== null) diff.newString = newCap.value;
      const activity: ToolActivity = {
        id,
        name,
        label: `作成済み ${displayPath(file, name)}`,
        addedLines: counts.added,
        removedLines: counts.removed,
        diff,
        commandTruncated: false,
        descriptionTruncated: false,
      };
      if (file !== null) activity.file = file;
      return activity;
    }
    case "Read": {
      const file = filePath(input);
      const activity: ToolActivity = {
        id,
        name,
        label: `既読 ${displayPath(file, name)}`,
        commandTruncated: false,
        descriptionTruncated: false,
      };
      if (file !== null) activity.file = file;
      return activity;
    }
    case "Grep":
    case "Glob":
    case "LS": {
      const file = filePath(input);
      const pattern = str(input["pattern"]) ?? str(input["path"]);
      const summary = nonEmpty(pattern) ?? displayPath(file, name);
      const activity: ToolActivity = {
        id,
        name,
        label: `検索済み ${summary}`,
        commandTruncated: false,
        descriptionTruncated: false,
      };
      if (file !== null) activity.file = file;
      return activity;
    }
    case "Skill": {
      // input = { skill: "name", args?: "..." }（claude 2.1.220 実測）。
      // 展開済みスキル本文は後続の isMeta 行から command として後付けされる。
      const skill = nonEmpty(str(input["skill"]));
      const argsCap = cap(str(input["args"]), MAX_DESCRIPTION_CHARACTERS);
      const activity: ToolActivity = {
        id,
        name,
        label: skill === null ? "実行済み Skill" : `実行済み スキル ${skill}`,
        commandTruncated: false,
        descriptionTruncated: argsCap.truncated,
      };
      if (argsCap.value !== null) activity.description = argsCap.value;
      return activity;
    }
    case "SendUserFile": {
      // Claude Code が成果物（PDF 等）を利用者へ渡すツール。input = { files: [abs], caption?, display? }。
      // iOS はこのカードをダウンロード導線にする（file-download）。
      const files = Array.isArray(input["files"])
        ? (input["files"] as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 0)
        : [];
      const captionCap = cap(str(input["caption"]), MAX_DESCRIPTION_CHARACTERS);
      const first = files[0] ?? null;
      const summary = first === null
        ? null
        : files.length > 1
          ? `${displayPath(first, name)} ほか${files.length - 1}件`
          : displayPath(first, name);
      const activity: ToolActivity = {
        id,
        name,
        label: summary === null ? "ファイルを送信" : `ファイルを送信 ${summary}`,
        commandTruncated: false,
        descriptionTruncated: captionCap.truncated,
      };
      if (first !== null) activity.file = first;
      if (files.length > 0) activity.files = files;
      if (captionCap.value !== null) activity.description = captionCap.value;
      return activity;
    }
    case "TodoWrite": {
      const todos = extractTodos(input["todos"]);
      const activity: ToolActivity = {
        id,
        name,
        label: "Todoを更新しました",
        commandTruncated: false,
        descriptionTruncated: false,
      };
      if (todos !== null) activity.todos = todos;
      return activity;
    }
    default: {
      const file = filePath(input);
      const activity: ToolActivity = {
        id,
        name,
        label: `実行済み ${displayPath(file, name)}`,
        commandTruncated: false,
        descriptionTruncated: false,
      };
      if (file !== null) activity.file = file;
      return activity;
    }
  }
}

function filePath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** TodoWrite の todos 入力（`[{content, status, activeForm}]`）をチェックリストへ落とす。 */
function extractTodos(value: unknown): ToolActivityTodo[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const capped: ToolActivityTodo[] = [];
  for (const item of value.slice(0, MAX_TODO_ITEMS)) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const content = rec["content"];
    if (typeof content !== "string" || !content) continue;
    const status = typeof rec["status"] === "string" ? rec["status"] : "pending";
    capped.push({ content: cap(content, MAX_TODO_CONTENT_CHARACTERS).value ?? content, status });
  }
  return capped.length === 0 ? null : capped;
}

function displayPath(p: string | null, fallback: string): string {
  if (!p) return fallback;
  const base = path.basename(p);
  return base.length === 0 ? p : base;
}

function nonEmpty(text: string | null): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

function commandPrefix(command: string | null): string | null {
  const trimmed = nonEmpty(command);
  if (trimmed === null) return null;
  return trimmed.length > 80 ? trimmed.slice(0, 80) + "..." : trimmed;
}

function cap(text: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (text === null) return { value: null, truncated: false };
  if (text.length <= limit) return { value: text, truncated: false };
  return { value: text.slice(0, limit), truncated: true };
}

function lineDelta(oldText: string | null, newText: string | null): { added: number; removed: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let unchanged = 0;
  for (const line of newLines) {
    const count = oldCounts.get(line);
    if (count !== undefined && count > 0) {
      oldCounts.set(line, count - 1);
      unchanged += 1;
    }
  }
  return {
    added: Math.max(0, newLines.length - unchanged),
    removed: Math.max(0, oldLines.length - unchanged),
  };
}

function splitLines(text: string | null): string[] {
  if (!text) return [];
  return text.split("\n");
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** AskUserQuestion の tool_use 入力から、質問本文と選択肢だけを抽出する（他 tool の input は読まない）。 */
function extractQuestionPrompts(
  content: unknown,
  fallbackId: string | null,
): { id: string; questions: QuestionPromptQuestion[] }[] {
  if (!Array.isArray(content)) return [];
  const prompts: { id: string; questions: QuestionPromptQuestion[] }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_use" || rec["name"] !== "AskUserQuestion") continue;
    const input = rec["input"];
    if (typeof input !== "object" || input === null) continue;
    const rawQuestions = (input as Record<string, unknown>)["questions"];
    if (!Array.isArray(rawQuestions)) continue;
    const questions: QuestionPromptQuestion[] = [];
    for (const raw of rawQuestions) {
      if (typeof raw !== "object" || raw === null) continue;
      const q = decodeQuestionPromptQuestion(raw as Record<string, unknown>);
      if (q !== null) questions.push(q);
    }
    if (questions.length === 0) continue;
    const id =
      (typeof rec["id"] === "string" ? rec["id"] : null) ??
      fallbackId ??
      `ask-user-question-${prompts.length + 1}`;
    prompts.push({ id, questions });
  }
  return prompts;
}

/**
 * AskUserQuestion の tool_input（`{questions:[...]}`）から設問を抽出する（PreToolUse hook 用）。
 * transcript の tool_use ブロックと同じデコーダを共有する（表示仕様の単一情報源）。
 * 解釈できる設問が 1 件も無ければ空配列。
 */
export function questionsFromToolInput(toolInput: Record<string, unknown>): QuestionPromptQuestion[] {
  const rawQuestions = toolInput["questions"];
  if (!Array.isArray(rawQuestions)) return [];
  const questions: QuestionPromptQuestion[] = [];
  for (const raw of rawQuestions) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = decodeQuestionPromptQuestion(raw as Record<string, unknown>);
    if (q !== null) questions.push(q);
  }
  return questions;
}

function decodeQuestionPromptQuestion(raw: Record<string, unknown>): QuestionPromptQuestion | null {
  const question = raw["question"];
  if (typeof question !== "string") return null;
  const header = typeof raw["header"] === "string" ? raw["header"] : "";
  const multiSelect = raw["multiSelect"] === true;
  const options: QuestionOption[] = [];
  if (Array.isArray(raw["options"])) {
    for (const rawOption of raw["options"] as unknown[]) {
      if (typeof rawOption !== "object" || rawOption === null) continue;
      const rec = rawOption as Record<string, unknown>;
      const label = rec["label"];
      if (typeof label !== "string") continue;
      options.push({
        label,
        description: typeof rec["description"] === "string" ? rec["description"] : "",
      });
    }
  }
  return { header, question, multiSelect, options };
}

function extractToolResultIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_result") continue;
    if (typeof rec["tool_use_id"] === "string") ids.push(rec["tool_use_id"]);
  }
  return ids;
}
