// hook.ts
// tailii (TS host) — hook サブコマンド実装（Swift 版 Hook.swift の移植）
//
// Claude Code の PreToolUse / PostToolUse フック。stdin JSON の `hook_event_name` で分岐する。
//
// PreToolUse（ツール実行の唯一のゲート意思決定点）:
//   まず hook 入力の `permission_mode`（Claude Code が渡す現在値）を判定し、
//   旧版互換で欠落時だけ tmux pane の mode-picker 表示へフォールバックする。
//   auto（全自動）なら即 allow、acceptEdits なら編集系ツールのみ即 allow して
//   iPhone 承認をスキップする（mode_set での途中切替が確認モーダルに反映される）。
//   それ以外は summary と構造化 diff（Write=create+全文 / Edit=edit+old/new）を生成し、
//   unix domain socket クライアントとして broker（=iPhone）へ approval_request（一意 id）を
//   送り、内部デッドライン内に approval_decision を受信して permissionDecision を stdout 出力。
//   決定はブロードキャストされるため自 id のみ受理する（5.4）。tool_input のパスが
//   画像拡張子なら pending キューへレコードを書く（リサイズせず＝デッドライン非影響）。
//
// connect 不能（アプリ背景/未起動）ブランチ:
//   即 deny せず背景 push（notifier 注入時のみ・このブランチのみ, 相互排他 7.1）→
//   内部デッドライン内で同一 SocketPath へ retry-connect（8.1）。接続できたら残り予算で
//   送出＋決定待ち（8.2）。デッドライン到達で安全側 deny（8.3）。
//   決定待ち中の切断（iOS の chat 離脱＝serve チャネル close / SSH 断）も同じフォールバック
//   に合流する: remote_pending（一覧バッジ/バナー）と push で気づかせ、再接続後に同一 id で
//   approval_request を送り直す（chat を開き直せば承認を続行できる）。
//
// PostToolUse（別呼び出し、ゲートしない）: ObservationLog に監査追記して exit 0（5.8）。
//
// 既定は常に deny（安全側）。connect 失敗・stdin 解析不能・id 不一致・非対応 v・
// undecodable 行・EOF・デッドラインのいずれでも deny を出力する。

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  makeProductionPushNotifier,
  ObservationLogPushObserver,
  type PushObserving,
} from "./approvalPushNotifier.js";
import {
  sendQuestionEventToEngine,
  sendRemotePendingToEngine,
  sendSessionProcessingToEngine,
} from "./engineRelaySocket.js";
import type { QuestionEventMessage } from "./engineRelaySocket.js";
import { questionsFromToolInput } from "./transcriptTailer.js";
import { defaultHeartbeatDir, writeHeartbeat } from "./heartbeat.js";
import { ensureHubDaemon } from "./hubDaemon.js";
import { decodeHubServerLine, encodeHubMessage } from "./hubProtocol.js";
import { ObservationLog, defaultObservationBase } from "./observationLog.js";
import { parsePermissionMode } from "./permissionMode.js";
import { resolveHubSocketPath, resolveSocketPath } from "./socketPath.js";
import { attachedSessions } from "./reaper.js";
import { sleep } from "./sleep.js";
import { processTmuxCommandRunner, TmuxSessionManager, type TmuxCommandRunner } from "./tmux.js";
import {
  PROTOCOL_V1,
  decodeControlMessage,
  encodeControlMessage,
  type ToolDiff,
} from "./protocol.js";

// MARK: - 定数

/**
 * hook 内部デッドラインの既定値（秒）。settings の外部タイムアウト
 * （hookSettings.HOOK_EXTERNAL_TIMEOUT_SECONDS = 600）より**厳密に小さく**保つこと。
 * この順序により hook は外部打切り前に必ず permissionDecision（無応答時は deny）を
 * 出力でき、fall-through を回避する（Req 5.7、HookTimeoutOrderingTests が検証）。
 * connect 不能時は背景 push で気づかせたうえで、人間が通知タップ→cold launch→
 * SSH 再接続→承認判断を完了できる猶予を与える（90→540 に延長, Req 8.4）。
 */
export const HOOK_INTERNAL_DEADLINE_SECONDS = 540;

/** connect 不能時の retry-connect ポーリング間隔の既定値（秒）。 */
export const HOOK_RETRY_CONNECT_INTERVAL_SECONDS = 1.0;

/** pending 投入対象とする画像拡張子（小文字, 8.5）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"]);

/** hook の画像 pending キュー既定ベース（`~/.tailii/images/pending`）。 */
export function defaultImagesPendingBase(): string {
  return path.join(os.homedir(), ".tailii", "images", "pending");
}

// MARK: - 背景 push 注入点

/** connect 不能時に送る最小 push リクエスト（diff/秘密なし, 2.3）。 */
export interface ApprovalPushRequest {
  approvalId: string;
  tool: string;
  session: string;
}

/**
 * 背景 push 統括の注入点（Swift 版 ApprovalPushNotifying 相当）。
 * 送信可否は deny 判断に影響しない（結果は捨てる）。本番実装は push-token 移植時に配線する。
 */
export type ApprovalPushNotifier = (
  request: ApprovalPushRequest,
  timeLimitMs: number,
) => Promise<void>;

export type PresenceReason = "mac-attached" | "client-live";
export type PresenceProbe = (session: string) => Promise<PresenceReason | null>;

/** presence 判定全体の上限。失敗・超過は push 送信へ倒す。 */
export const PRESENCE_PROBE_TIME_LIMIT_MS = 500;

/** Hub への使い捨て presence RPC の上限。 */
export const HUB_PRESENCE_RPC_TIMEOUT_MS = 300;

// MARK: - テスタブルコア

export interface RunHookOptions {
  stdinData: Buffer;
  /** 接続する unix socket パス。null は接続不能と同義（PreToolUse は即 deny）。 */
  socketPath: string | null;
  /** 内部デッドライン（秒）。 */
  deadlineSeconds: number;
  /** セッション名（ObservationLog / push のキー）。既定 "default"。 */
  session?: string;
  /** ObservationLog のベース（注入）。省略時は監査追記をスキップ。 */
  observationBase?: string;
  /** 画像 pending キューのベース（注入）。省略時は pending 投入をスキップ。 */
  imagesPendingBase?: string;
  /** connect 不能時に背景 push を送る notifier。省略時は push を試みない。 */
  notifier?: ApprovalPushNotifier;
  /** push 送信部の時間上限（ms）。gate 非阻害のためこの時間で打ち切る。既定 5000。 */
  notifierTimeLimitMs?: number;
  /** 背景 push 前の presence 判定。例外・超過は不在扱いにせず fail-open で push する。 */
  presenceProbe?: PresenceProbe;
  /** presence により push を抑制した場合の観測先。 */
  pushObserver?: Pick<PushObserving, "recordSkipped">;
  /** connect 不能時に engine relay へ通知する socket path。省略時は既定パス。null なら送らない。 */
  engineRelaySocketPath?: string | null;
  /** connect 不能ブランチでの retry-connect ポーリング間隔（秒）。既定 1.0。 */
  retryConnectIntervalSeconds?: number;
  /**
   * 現在の permission mode（"default" | "acceptEdits" | "plan" | "auto" | null）を返す
   * provider（注入）。auto/acceptEdits の自動許可判定に使う。省略・null・例外は
   * 「判定不能」として従来どおり iPhone ゲートへフォールバックする（安全側）。
   */
  permissionModeProvider?: () => Promise<string | null>;
  /**
   * reaper daemon の判定権威となる heartbeat ファイルの置き場（注入）。
   * 省略時は書かない（テスト密閉）。runHookCommand が既定パスを渡す。
   */
  heartbeatDir?: string;
  /** Session Hub daemon の常駐保証（注入）。省略時は何もしない。UserPromptSubmit でのみ呼ぶ。 */
  ensureHub?: () => void;
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
}

/** hook の本体（テスタブル・完全版）。stdin JSON の `hook_event_name` で分岐する。 */
export async function runHookCore(options: RunHookOptions): Promise<HookRunResult> {
  const session = options.session ?? "default";
  const deadlineSeconds = options.deadlineSeconds;
  const parsed = parsePreToolUse(options.stdinData);

  // --- 0. hook_event_name で分岐 ---
  // 処理中/処理完了のライフサイクル通知（idle reaper の「処理中は殺さない」判定用）。
  // UserPromptSubmit=処理開始 / Stop=処理完了。engine relay へ一方向送信して即終了する。
  // UserPromptSubmit の stdout は Claude のコンテキストへ注入されるため、必ず無出力にする。
  if (parsed.eventName === "UserPromptSubmit" || parsed.eventName === "Stop") {
    if (parsed.eventName === "UserPromptSubmit") {
      // ターン開始＝Session Hub の常駐を保証する好機（engine 不在でも hook は発火する）。
      try {
        options.ensureHub?.();
      } catch {
        // ensure は best-effort。
      }
    }
    await notifySessionProcessing(options, session, parsed.eventName === "Stop" ? "done" : "active", parsed.eventName);
    return { exitCode: 0, stdout: "" };
  }

  if (parsed.eventName === "PostToolUse") {
    // ツールイベント＝処理中ハートビート（長時間ターンでも処理中判定が失効しないよう更新）。
    await notifySessionProcessing(options, session, "active", parsed.eventName);
    // 設問の解決通知（iOS/TUI どちらで回答されても sheet/バッジを閉じる, question-hook-relay）。
    if (parsed.toolName === "AskUserQuestion") {
      await notifyQuestionEvent(options, {
        type: "question_event",
        session,
        event: "dismiss",
        id: parsed.toolUseId,
      });
    }
    return runPostToolUse(parsed, session, options.observationBase);
  }

  // === 以降 PreToolUse（既定） ===
  // ツールイベント＝処理中ハートビート（承認ゲート待ちの間も処理中扱いを維持する）。
  await notifySessionProcessing(options, session, "active", parsed.eventName);

  // --- 0.4 設問ツール（承認ゲートせず、設問を engine relay 経由で iOS へ届ける） ---
  // AskUserQuestion は「ユーザーへの設問」そのもので実行許可を問う意味がなく、ゲートすると
  // iPhone に設問シートではなく承認モーダルが出てしまう。さらに Claude Code は設問が未回答の
  // 間 transcript に tool_use 行を書かない（v2.1.206 実測）ため、transcript tail では設問を
  // リアルタイム検知できない。よってここが唯一の即時ソース: tool_input から設問を抽出して
  // engine relay へ question_event(prompt) を送り（engine が question_prompt / remote_pending に
  // 変換）、即 allow で TUI ダイアログを出す。回答は従来どおり question_answer のキー注入。
  if (parsed.toolName === "AskUserQuestion") {
    const questions = questionsFromToolInput(parsed.toolInput);
    if (questions.length > 0) {
      await notifyQuestionEvent(options, {
        type: "question_event",
        session,
        event: "prompt",
        id: parsed.toolUseId,
        questions,
      });
    }
    return allow("AskUserQuestion is presented natively (Tailii auto-approved)");
  }

  // --- 0.5 permission mode による自動許可（mode-picker 連動） ---
  // TUI が auto（全自動）のとき、および acceptEdits の編集系ツールは iPhone 承認を
  // 出さずに即 allow する。これが無いと mode_set で Auto に切り替えても hook が
  // 常にゲートし、確認モーダルが出続ける（= モード変更が反映されない）。
  // hook 入力の permission_mode は処理中にも消えない権威値として優先する。旧版で
  // 欠落する場合だけ provider を使い、provider 無し・capture 失敗・ダイアログ表示中
  // = null なら従来どおり iPhone ゲートへフォールバックする（安全側）。
  const autoAllowReason = autoAllowReasonForMode(
    await currentPermissionMode(options, parsed.permissionMode),
    parsed.toolName,
  );
  if (autoAllowReason !== null) return allow(autoAllowReason);

  const summary = buildSummary(parsed.toolName, parsed.toolInput);
  const diff = buildDiff(parsed.toolName, parsed.toolInput);

  // 単一の内部デッドライン。push→retry-connect→send→waitForDecision の全フェーズが
  // この 1 本の予算を共有する（Req 8.1）。
  const deadlineAtMs = Date.now() + deadlineSeconds * 1000;

  if (options.socketPath === null) {
    // socket パス未決定は接続不能と同義。retry-connect の余地もないため即 deny。
    return deny("iPhone unavailable (no socket path)");
  }

  const socket = await connectUnixSocket(options.socketPath);
  if (socket) {
    // 接続済み（アプリ前面）。従来経路をそのまま実行する（push しない, 7.1）。
    return sendRequestAndReflect(socket, parsed, summary, diff, options, deadlineAtMs);
  }

  // === connect 不能ブランチ（Req 2.1 / 8.1〜8.3） ===
  return publishPendingAndAwaitReconnect(
    options.socketPath,
    parsed,
    summary,
    diff,
    options,
    deadlineAtMs,
    randomUUID(),
    false,
  );
}

// MARK: - 処理中/処理完了ライフサイクル通知

/**
 * engine relay へ session_processing を送り、reaper daemon の判定権威である heartbeat
 * ファイルも更新する（失敗は握り潰し＝ゲート/監査へ影響させない）。
 * `engineRelaySocketPath: null` は「送らない」明示指定（テスト密閉用）。
 */
async function notifySessionProcessing(
  options: RunHookOptions,
  session: string,
  state: "active" | "done",
  event: string,
): Promise<void> {
  // heartbeat は engine の生死と無関係に書ける唯一の経路（reaper daemon が読む）。
  // session 未解決（"default"）は書かない — 実在しない tmux 名の残骸ファイルを作らない。
  if (options.heartbeatDir !== undefined && session !== "default") {
    try {
      writeHeartbeat(options.heartbeatDir, session, {
        ts: Math.floor(Date.now() / 1000),
        state: state === "done" ? "idle" : "active",
        event,
      });
    } catch {
      // heartbeat 書込失敗は無視（reaper 保護が弱まるだけで安全性は変わらない）。
    }
  }
  if (options.engineRelaySocketPath === null) return;
  try {
    const message = { type: "session_processing", session, state } as const;
    // best-effort・短予算（60ms）: engine 不在時にゲート/監査を遅らせない。
    if (options.engineRelaySocketPath !== undefined) {
      await sendSessionProcessingToEngine(message, options.engineRelaySocketPath, 60);
    } else {
      await sendSessionProcessingToEngine(message, undefined, 60);
    }
  } catch {
    // relay 不達（engine 不在等）は無視する。reaper 保護が弱まるだけで安全性は変わらない。
  }
}

/**
 * engine relay へ question_event を送る（失敗は握り潰し＝設問表示は best-effort、allow は阻害しない）。
 * `engineRelaySocketPath: null` は「送らない」明示指定（テスト密閉用）。
 */
async function notifyQuestionEvent(
  options: RunHookOptions,
  message: QuestionEventMessage,
): Promise<void> {
  if (options.engineRelaySocketPath === null) return;
  try {
    if (options.engineRelaySocketPath !== undefined) {
      await sendQuestionEventToEngine(message, options.engineRelaySocketPath);
    } else {
      await sendQuestionEventToEngine(message);
    }
  } catch {
    // relay 不達（engine 不在等）は無視する。TUI 側のダイアログは出るため回答手段は残る。
  }
}

// MARK: - permission mode 自動許可（mode-picker 連動）

/** acceptEdits で自動許可するファイル編集系ツール名（Claude Code の accept-edits 対象に合わせる）。 */
const ACCEPT_EDITS_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * permission mode によって iPhone 承認をスキップできる場合、その理由文字列を返す（純ロジック）。
 * - auto: 全ツールを自動許可。
 * - acceptEdits: 編集系ツール（Write/Edit/MultiEdit/NotebookEdit）のみ自動許可。
 * - それ以外（default / plan / null = 判定不能）: null（従来どおり iPhone ゲート）。
 */
export function autoAllowReasonForMode(mode: string | null, toolName: string): string | null {
  if (mode === "auto") return "auto mode on (Tailii auto-approved)";
  if (mode === "acceptEdits" && ACCEPT_EDITS_TOOLS.has(toolName)) {
    return "accept edits on (Tailii auto-approved)";
  }
  return null;
}

/**
 * 現在の permission mode を取得する。
 * Claude Code の hook 入力値を権威として優先し、フィールド自体が無い旧版だけ provider へ
 * フォールバックする。未知の入力値も provider で上書きせず、そのまま安全側判定へ渡す。
 */
async function currentPermissionMode(
  options: RunHookOptions,
  hookPermissionMode: string | undefined,
): Promise<string | null> {
  if (hookPermissionMode !== undefined) return hookPermissionMode;
  if (options.permissionModeProvider === undefined) return null;
  try {
    return await options.permissionModeProvider();
  } catch {
    return null;
  }
}

/**
 * tmux pane 表示から permission mode を判定する本番 provider を作る（claude 専用）。
 * capture-pane が timeLimitMs 内に返らない・失敗する場合は null（判定不能 → 従来ゲート）。
 * 本番の hook CLI は Claude 専用なので、この provider も Claude にだけ配線する。
 */
export function makeTmuxPermissionModeProvider(
  session: string,
  timeLimitMs = 1500,
): () => Promise<string | null> {
  return async () => {
    try {
      const manager = new TmuxSessionManager();
      const pane = await Promise.race([
        manager.capturePane(session),
        sleep(timeLimitMs).then(() => null),
      ]);
      return pane === null ? null : parsePermissionMode(pane);
    } catch {
      return null;
    }
  };
}

// MARK: - 接続不能/切断フォールバック（Req 8.1〜8.3）

/**
 * 承認を iPhone に届けられない間の共有フォールバック（connect 不能と決定待ち中の切断の両方）。
 * remote_pending を engine relay へ流して会話一覧のバッジ/バナーに出し、背景 push
 * （notifier 注入時のみ, 相互排他 7.1 — 前面 connect 済み経路では送らない）で気づかせた
 * うえで、内部デッドラインの残りで同一 socket パスへ retry-connect する（8.1）。
 * 再接続できたら同一 id で approval_request を送り直す（8.2 — iOS 側は id で pending と
 * 突合できる）。デッドラインまで回復しなければ安全側 deny（8.3）。
 */
async function publishPendingAndAwaitReconnect(
  socketPath: string,
  parsed: ParsedPreToolUse,
  summary: string,
  diff: ToolDiff | undefined,
  options: RunHookOptions,
  deadlineAtMs: number,
  requestId: string,
  imagesAlreadyEnqueued: boolean,
): Promise<HookRunResult> {
  const session = options.session ?? "default";
  if (options.engineRelaySocketPath !== null) {
    await sendRemotePendingToEngine({
      type: "remote_pending",
      v: PROTOCOL_V1,
      id: requestId,
      session,
      kind: "approval",
      tool: parsed.toolName,
      summary,
    }, options.engineRelaySocketPath).catch(() => {});
  }
  if (options.notifier) {
    const presence = await probePresence(options.presenceProbe, session);
    if (presence !== null) {
      try { options.pushObserver?.recordSkipped(requestId, presence, session); } catch { /* 観測失敗は無視。 */ }
    } else {
      await sendBackgroundPush(
        options.notifier,
        { approvalId: requestId, tool: parsed.toolName, session },
        options.notifierTimeLimitMs ?? 5000,
      );
    }
  }

  const retryIntervalSeconds =
    options.retryConnectIntervalSeconds ?? HOOK_RETRY_CONNECT_INTERVAL_SECONDS;
  const reconnected = await retryConnect(socketPath, deadlineAtMs, retryIntervalSeconds);
  if (reconnected) {
    return sendRequestAndReflect(
      reconnected,
      parsed,
      summary,
      diff,
      options,
      deadlineAtMs,
      requestId,
      imagesAlreadyEnqueued,
    );
  }

  // 内部デッドライン内に一度も再接続できなかった → 安全側 deny（8.3）。
  return deny(`iPhone unavailable (no reconnect within ${Math.round(options.deadlineSeconds)}s)`);
}

// MARK: - approval_request 送出＋決定反映（connect 成功／再接続で共有）

async function sendRequestAndReflect(
  socket: net.Socket,
  parsed: ParsedPreToolUse,
  summary: string,
  diff: ToolDiff | undefined,
  options: RunHookOptions,
  deadlineAtMs: number,
  requestIdOverride?: string,
  imagesAlreadyEnqueued = false,
): Promise<HookRunResult> {
  try {
    const requestId = requestIdOverride ?? randomUUID();

    // 画像パス検出 → pending キュー投入（非ブロッキング・リサイズなし, 8.1/8.2/8.5）。
    // 切断→再接続の送り直しでは投入済み（同一承認 id での二重投入を防ぐ）。
    if (options.imagesPendingBase !== undefined && !imagesAlreadyEnqueued) {
      enqueuePendingImages(parsed.toolInput, requestId, options.imagesPendingBase);
    }

    const encoded = encodeControlMessage({
      type: "approval_request",
      v: PROTOCOL_V1,
      id: requestId,
      tool: parsed.toolName,
      summary,
      cwd: parsed.cwd,
      ...(diff !== undefined ? { diff } : {}),
    });
    try {
      socket.write(encoded + "\n");
    } catch {
      // 送出直前に serve チャネルが落ちた（chat 離脱/開き直しレース）。切断と同じ扱い。
      if (options.socketPath === null) return deny("iPhone disconnected (write failed)");
      return publishPendingAndAwaitReconnect(
        options.socketPath, parsed, summary, diff, options, deadlineAtMs, requestId, true,
      );
    }

    // 残りデッドライン内で approval_decision を待つ（自 id のみ受理, 5.4）。
    const outcome = await waitForDecision(socket, requestId, deadlineAtMs);
    switch (outcome.kind) {
      case "allow":
        await clearRemotePendingIfNeeded(requestId, options);
        return allow(outcome.reason ?? "Approved on iPhone");
      case "deny":
        await clearRemotePendingIfNeeded(requestId, options);
        return deny(outcome.reason ?? "Denied on iPhone");
      case "timeout":
        await clearRemotePendingIfNeeded(requestId, options);
        return deny(`No response within ${Math.round(options.deadlineSeconds)}s`);
      case "disconnected":
        // 決定待ち中の切断 = iOS の chat 離脱（serve チャネル close）や SSH 断。
        // 承認自体はまだ生きているので即 deny せず、connect 不能ブランチと同じ
        // フォールバックに合流して再接続（chat 開き直し）後に同一 id で送り直す。
        if (options.socketPath === null) return deny("iPhone disconnected");
        return publishPendingAndAwaitReconnect(
          options.socketPath, parsed, summary, diff, options, deadlineAtMs, requestId, true,
        );
    }
  } finally {
    socket.destroy();
  }
}

async function clearRemotePendingIfNeeded(
  id: string,
  options: RunHookOptions,
): Promise<void> {
  if (options.engineRelaySocketPath === null) return;
  await sendRemotePendingToEngine({
    type: "remote_pending_cleared",
    v: PROTOCOL_V1,
    id,
    session: options.session ?? "default",
    kind: "approval",
  }, options.engineRelaySocketPath).catch(() => {});
}

// MARK: - 決定待機

type DecisionOutcome =
  | { kind: "allow" | "deny"; reason?: string }
  | { kind: "timeout" }
  | { kind: "disconnected" };

/**
 * デッドライン内で approval_decision を1行ずつ受信し、id が一致する有効決定を待つ。
 * id 不一致・undecodable・非対応 v の行はスキップして読み続ける（残り時間内）。
 * EOF/エラー → disconnected。デッドライン超過 → timeout。
 */
function waitForDecision(
  socket: net.Socket,
  expectedId: string,
  deadlineAtMs: number,
): Promise<DecisionOutcome> {
  return new Promise((resolve) => {
    const remaining = deadlineAtMs - Date.now();
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;

    const settle = (outcome: DecisionOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onDisconnect);
      socket.removeListener("error", onDisconnect);
      socket.removeListener("close", onDisconnect);
      resolve(outcome);
    };

    const onData = (chunk: Buffer): void => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let idx: number;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        const outcome = evaluateLine(line, expectedId);
        if (outcome !== null) {
          settle(outcome);
          return;
        }
      }
    };
    const onDisconnect = (): void => settle({ kind: "disconnected" });

    const timer = setTimeout(() => settle({ kind: "timeout" }), Math.max(0, remaining));
    if (remaining <= 0) {
      // デッドライン超過 → 即 timeout（安全側 deny）。
      settle({ kind: "timeout" });
      return;
    }
    socket.on("data", onData);
    socket.once("end", onDisconnect);
    socket.once("error", onDisconnect);
    socket.once("close", onDisconnect);
  });
}

/**
 * 受信した1行を評価する。id 一致の approval_decision → DecisionOutcome。
 * それ以外（id 不一致・型不一致・デコード失敗・空行）→ null（無視して読み続ける）。
 */
function evaluateLine(line: Buffer, expectedId: string): DecisionOutcome | null {
  // 末尾 CR 除去（NDJSON は \n 区切りだが CRLF 耐性のため）。
  const trimmed =
    line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
  if (trimmed.length === 0) return null;

  let message;
  try {
    message = decodeControlMessage(trimmed);
  } catch {
    return null;
  }
  if (message.type !== "approval_decision") return null;
  if (message.id !== expectedId) return null;
  return message.reason !== undefined
    ? { kind: message.decision, reason: message.reason }
    : { kind: message.decision };
}

// MARK: - unix socket クライアント / retry-connect

/** unix domain socket に接続し、接続済み socket を返す。失敗時は null（→ 安全側 deny）。 */
function connectUnixSocket(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      // 決定待機中の error は waitForDecision が disconnected として扱う。
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * 内部デッドライン内で同一 unix socket パスへ再接続を試行する（8.1）。
 * 接続できた socket を返す。デッドライン到達まで一度も接続できなければ null（8.3）。
 */
async function retryConnect(
  socketPath: string,
  deadlineAtMs: number,
  intervalSeconds: number,
): Promise<net.Socket | null> {
  const intervalMs = Math.max(0, Math.min(intervalSeconds, 3600) * 1000);
  for (;;) {
    const socket = await connectUnixSocket(socketPath);
    if (socket) return socket;
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(intervalMs, remaining));
  }
}

// MARK: - 背景 push 送出（connect 不能ブランチのみ）

/** 注入された presence 判定を全体上限内で実行する。失敗・超過は null（push 継続）。 */
async function probePresence(probe: PresenceProbe | undefined, session: string): Promise<PresenceReason | null> {
  if (probe === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PRESENCE_PROBE_TIME_LIMIT_MS);
    });
    return await Promise.race([probe(session).catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Hub socket へ短命接続し、1回だけ presence RPC を行う。
 * false は正常応答で購読者なし、null は接続・応答失敗を表す。
 */
export function requestHubPresence(
  session: string,
  socketPath: string,
  timeoutMs = HUB_PRESENCE_RPC_TIMEOUT_MS,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    socket.once("connect", () => {
      socket.write(encodeHubMessage({ type: "presence_request", id, session }));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = decodeHubServerLine(line);
        if (message?.type === "presence_response" && message.id === id && message.session === session) {
          finish(message.subscriberCount > 0);
          return;
        }
      }
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });
}

/** tmux attach と Hub subscriber を順に調べる本番 presence probe。 */
export function makePresenceProbe(
  runner: TmuxCommandRunner = processTmuxCommandRunner(),
  hubSocketPath?: string,
): PresenceProbe {
  return async (session) => {
    if ((await attachedSessions(runner)).has(session)) return "mac-attached";
    const effectiveHubSocketPath = hubSocketPath ?? resolveHubSocketPath();
    return await requestHubPresence(session, effectiveHubSocketPath) === true ? "client-live" : null;
  };
}

/** 背景 push を送出する。timeLimit で打ち切り、成否は deny 判断に影響しない。 */
async function sendBackgroundPush(
  notifier: ApprovalPushNotifier,
  request: ApprovalPushRequest,
  timeLimitMs: number,
): Promise<void> {
  await Promise.race([notifier(request, timeLimitMs).catch(() => {}), sleep(timeLimitMs)]);
}

// MARK: - PostToolUse 監査（5.8）

function runPostToolUse(
  parsed: ParsedPreToolUse,
  session: string,
  observationBase: string | undefined,
): HookRunResult {
  if (observationBase === undefined) {
    // 監査ベース未注入時は追記できないが、PostToolUse は失敗させない（exit 0）。
    return { exitCode: 0, stdout: "{}" };
  }
  const log = new ObservationLog(observationBase);
  // 決定は tool_response の permissionDecision（無ければ実行済み=allow とみなす）。
  const decision = parsed.postDecision ?? "allow";
  try {
    log.append(
      { kind: "toolExecuted", id: parsed.toolUseId, tool: parsed.toolName, decision },
      session,
      Math.floor(Date.now() / 1000),
    );
  } catch {
    // 監査追記失敗でも PostToolUse は失敗させない。
  }
  return { exitCode: 0, stdout: "{}" };
}

// MARK: - 画像 pending 投入（8.1/8.2/8.5）

/** tool_input のパスが画像拡張子なら pending へ `{imageId, path, relatedApprovalId}` を書く。 */
function enqueuePendingImages(
  toolInput: Record<string, unknown>,
  relatedApprovalId: string,
  base: string,
): void {
  const paths = imagePaths(toolInput);
  if (paths.length === 0) return;
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch {
    // ディレクトリ作成失敗は握り潰す（承認を阻害しない）。
  }
  for (const imagePath of paths) {
    const imageId = randomUUID();
    // キーは辞書順（imageId < path < relatedApprovalId）— Swift 版 .sortedKeys と同一。
    const record = { imageId, path: imagePath, relatedApprovalId };
    try {
      fs.writeFileSync(path.join(base, `${imageId}.json`), JSON.stringify(record));
    } catch {
      // 書き込み失敗は握り潰す（承認を阻害しない）。
    }
  }
}

/** tool_input から画像拡張子を持つパス文字列を抽出する（8.5）。 */
function imagePaths(toolInput: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = toolInput[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const ext = path.extname(value).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) result.push(value);
  }
  return result;
}

// MARK: - summary / diff 生成（6.2/6.3）

/** tool_input から1行の summary を生成する。 */
function buildSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": {
      const command = toolInput["command"];
      if (typeof command === "string" && command.length > 0) return oneLine(command);
      return "Run a Bash command";
    }
    case "Write": {
      const filePath = toolInput["file_path"];
      if (typeof filePath === "string" && filePath.length > 0) return `Write file: ${filePath}`;
      return "Write a file";
    }
    case "Edit": {
      const filePath = toolInput["file_path"];
      if (typeof filePath === "string" && filePath.length > 0) return `Edit file: ${filePath}`;
      return "Edit a file";
    }
    default:
      return `Run tool: ${toolName}`;
  }
}

/** 文字列を1行に正規化する（改行を空白へ畳み込み、前後空白を除去）。 */
function oneLine(s: string): string {
  return s.replaceAll("\n", " ").replaceAll("\r", " ").trim();
}

/** tool_input から構造化 diff を生成する（Write=create+全文 / Edit=edit+old/new / 他は undefined）。 */
function buildDiff(toolName: string, toolInput: Record<string, unknown>): ToolDiff | undefined {
  const filePath = toolInput["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) return undefined;
  switch (toolName) {
    case "Write": {
      const content = toolInput["content"];
      return { kind: "create", path: filePath, newText: typeof content === "string" ? content : "" };
    }
    case "Edit": {
      const oldString = toolInput["old_string"];
      const newString = toolInput["new_string"];
      return {
        kind: "edit",
        path: filePath,
        oldString: typeof oldString === "string" ? oldString : "",
        newString: typeof newString === "string" ? newString : "",
      };
    }
    default:
      return undefined;
  }
}

// MARK: - stdin パース

interface ParsedPreToolUse {
  eventName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  /** Claude Code が hook 発火時点で渡す現在の permission mode。旧版では欠落し得る。 */
  permissionMode?: string;
  /** 監査 id（`tool_use_id` があれば優先、無ければ `session_id`）。秘密ではない。 */
  toolUseId: string;
  /** PostToolUse の tool_response 内 permissionDecision（あれば）。 */
  postDecision?: string;
}

/** フック JSON を寛容にパースする。欠落フィールドは安全な既定値で補う。 */
function parsePreToolUse(data: Buffer): ParsedPreToolUse {
  const parsed: ParsedPreToolUse = {
    eventName: "PreToolUse",
    toolName: "Unknown",
    toolInput: {},
    cwd: "",
    toolUseId: "",
  };
  if (data.length === 0) return parsed;
  let obj: unknown;
  try {
    obj = JSON.parse(data.toString("utf8"));
  } catch {
    return parsed;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return parsed;
  const raw = obj as Record<string, unknown>;
  if (typeof raw["hook_event_name"] === "string") parsed.eventName = raw["hook_event_name"];
  if (typeof raw["tool_name"] === "string") parsed.toolName = raw["tool_name"];
  const toolInput = raw["tool_input"];
  if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
    parsed.toolInput = toolInput as Record<string, unknown>;
  }
  if (typeof raw["cwd"] === "string") parsed.cwd = raw["cwd"];
  if (typeof raw["permission_mode"] === "string") {
    parsed.permissionMode = raw["permission_mode"];
  }
  if (typeof raw["tool_use_id"] === "string" && raw["tool_use_id"].length > 0) {
    parsed.toolUseId = raw["tool_use_id"];
  } else if (typeof raw["session_id"] === "string") {
    parsed.toolUseId = raw["session_id"];
  }
  const response = raw["tool_response"];
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const decision = (response as Record<string, unknown>)["permissionDecision"];
    if (typeof decision === "string") parsed.postDecision = decision;
  }
  return parsed;
}

// MARK: - permissionDecision 出力契約

/**
 * 出力契約（stdout, exit 0）:
 * `{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *    "permissionDecision": "allow"|"deny", "permissionDecisionReason": "<reason>" } }`
 * キーは辞書順（Swift 版 .sortedKeys と同一の並び）。
 */
function decisionJson(permission: "allow" | "deny", reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: permission,
      permissionDecisionReason: reason,
    },
  });
}

function allow(reason: string): HookRunResult {
  return { exitCode: 0, stdout: decisionJson("allow", reason) };
}

function deny(reason: string): HookRunResult {
  return { exitCode: 0, stdout: decisionJson("deny", reason) };
}

// MARK: - CLI エントリポイント

/**
 * hook サブコマンドのエントリポイント。
 * 引数: `--socket <path>` | `--session <name>` | `--deadline <seconds>` |
 * `--retry-interval <seconds>` | `--images-dir <path>`。
 * 常に exit 0（Claude Code は stdout の JSON を読む）。
 *
 * connect 不能ブランチでは本番 ApprovalPushNotifier を注入し、背景 push で気づかせる
 * （相互排他 7.1 は runHookCore が担保）。実際に送るかは notifier が config/token の有無で
 * 判断する（未設定なら送らず観測記録, 3.5/6.4）。送信可否は deny 判断に影響しない。
 */
export async function runHookCommand(args: string[]): Promise<number> {
  let socketArg: string | null = null;
  let sessionArg: string | null = null;
  let imagesDirArg: string | null = null;
  let deadlineSeconds = HOOK_INTERNAL_DEADLINE_SECONDS;
  let retryIntervalSeconds = HOOK_RETRY_CONNECT_INTERVAL_SECONDS;
  // Codex の承認は App Server native 経路（codexNativeTurnController）に統一済み。
  // この hook CLI は Claude のフックだけを扱う。

  for (let i = 0; i < args.length; i += 1) {
    const next = (): string | null => (i + 1 < args.length ? args[++i]! : null);
    switch (args[i]) {
      case "--socket":
        socketArg = next();
        break;
      case "--session":
        sessionArg = next();
        break;
      case "--deadline": {
        const raw = next();
        const value = raw === null ? Number.NaN : Number.parseFloat(raw);
        if (Number.isFinite(value)) deadlineSeconds = value;
        break;
      }
      case "--retry-interval": {
        const raw = next();
        const value = raw === null ? Number.NaN : Number.parseFloat(raw);
        if (Number.isFinite(value)) retryIntervalSeconds = value;
        break;
      }
      case "--images-dir":
        imagesDirArg = next();
        break;
      default:
        break;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const stdinData = Buffer.concat(chunks);
  const effectiveSession =
    sessionArg !== null && sessionArg.trim().length > 0 ? sessionArg : null;

  let socketPath: string | null = null;
  if (socketArg !== null) {
    socketPath = socketArg;
  } else if (effectiveSession !== null) {
    try {
      socketPath = resolveSocketPath(effectiveSession);
    } catch {
      socketPath = null;
    }
  }

  const pushObserver = new ObservationLogPushObserver();
  const { exitCode, stdout } = await runHookCore({
    stdinData,
    socketPath,
    deadlineSeconds,
    session: effectiveSession ?? "default",
    observationBase: defaultObservationBase(),
    imagesPendingBase:
      imagesDirArg !== null ? path.join(imagesDirArg, "pending") : defaultImagesPendingBase(),
    notifier: makeProductionPushNotifier(),
    pushObserver,
    retryConnectIntervalSeconds: retryIntervalSeconds,
    heartbeatDir: defaultHeartbeatDir(),
    ensureHub: ensureHubDaemon,
    // 現行 Claude は hook 入力の permission_mode を使う。tmux provider は旧版互換の
    // 欠落時フォールバックとしてだけ呼ばれる。
    ...(effectiveSession !== null
      ? {
          permissionModeProvider: makeTmuxPermissionModeProvider(effectiveSession),
          presenceProbe: makePresenceProbe(),
        }
      : {}),
  });
  process.stdout.write(stdout + "\n");
  return exitCode;
}
