// hook.ts
// tailii (TS host) — hook サブコマンド実装（Swift 版 Hook.swift の移植）
//
// Claude Code のフック。stdin JSON の `hook_event_name` で分岐する。
// `--permission-request` を付けて起動した会話では、許可モード・ルール・auto の判定を Claude Code が行い、
// 確認が必要なツールだけ PermissionRequest から iPhone に届ける。PreToolUse は処理中の通知・画像の検出と
// 照合用の tool_use_id の記録を担う。AskUserQuestion の設問の中継と allow は従来どおり PreToolUse が行う。
// 引数の無い稼働中の会話・旧版は互換のため PreToolUse でモードを判定し、必要に応じて iPhone に聞く。
// 承認は同じチャネルと `chat approve` の受け渡し口で待つ。PermissionRequest の返答は decision.behavior、
// 旧方式の返答は permissionDecision。端末で決着したら会話ログで検知し、無出力で待機とアプリの承認を片付ける。
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
// CLI 内部の複製（返答案など。`agent_id` だけ付き `agent_type` が無い）のツールフックは、
// 処理中の通知・設問・承認のどれにも使わない（`isInternalForkHook`）。
//
// 承認を待つ経路では、接続や返答が間に合わなければ deny を返す。

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ObservationLogPushObserver,
  type PushObserving,
} from "../push/approvalPushNotifier.js";
import { createProductionPushDispatcher, type PushDispatcher } from "../push/pushDispatcher.js";
import { makeSessionTitleResolver, summarizeForNotification } from "../push/pushContent.js";
import { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import {
  sendQuestionEventToEngine,
  sendRemotePendingToEngine,
  sendSessionProcessingToEngine,
  sendSubagentLifecycleToEngine,
} from "../hub/engineRelaySocket.js";
import type { QuestionEventMessage } from "../hub/engineRelaySocket.js";
import { questionsFromToolInput } from "../chat/transcriptTailer.js";
import {
  defaultHeartbeatDir,
  readHeartbeat,
  writeHeartbeat,
  type HeartbeatScheduled,
} from "../sessions/heartbeat.js";
import { scheduledFromSessionCrons } from "../sessions/cronSchedule.js";
import { claudePidOfHook } from "../sessions/claudeLiveStatus.js";
import { ensureHubDaemon } from "../hub/hubDaemonClient.js";
import { decodeHubServerLine, encodeHubMessage, type HubPushEvent } from "../hub/hubProtocol.js";
import { closeAfterReply, replyDecisionApplied } from "./decisionResult.js";
import { forgetPreToolUse, rememberPreToolUse, takePreToolUse, watchExternalApproval } from "./permissionRequest.js";
import {
  botMayApprove,
  defaultApprovalsBase,
  isCliSession,
  removePendingApproval,
  waitForMailboxDecision,
  writePendingApproval,
} from "./approvalMailbox.js";
import { PushDeviceStore } from "../push/pushDeviceStore.js";
import { ObservationLog, defaultObservationBase } from "../shared/observationLog.js";
import { parsePermissionMode } from "../shared/permissionMode.js";
import { resolveHubSocketPath, resolveSocketPath } from "../shared/socketPath.js";
import { attachedSessions } from "../hub/reaper.js";
import { abortableSleep, sleep } from "../shared/sleep.js";
import { makeBackendForSession } from "../backend/sessionBackend.js";
import { processTmuxCommandRunner, type TmuxCommandRunner } from "../backend/tmux.js";
import {
  PROTOCOL_V1,
  decodeControlMessage,
  encodeControlMessage,
  type ToolDiff,
} from "../protocol.js";

// MARK: - 定数

/**
 * hook 内部デッドラインの既定値（秒）。settings の外部タイムアウト
 * （hookSettings.HOOK_EXTERNAL_TIMEOUT_SECONDS = 600）より**厳密に小さく**保つこと。
 * この順序により hook は外部打切り前に承認の判定（無応答時は deny）を
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
  /** 承認内容の要約（通知本文 `ツール名 · 要約` に使う。暗号化して送るのでリレーには見えない）。 */
  summary?: string;
  /**
   * 通知の上で「許可」してよい形の本文の要約（`<作業ディレクトリ> $ <コマンド>`。`describeToolForApproval` が入力を
   * 見たその場で、条件をすべて満たすときだけ作る。文字列から後で推測しない）。省略は「許可させない」。
   * 通知ではこれを本文にし、平文に `allow: true` を付ける（push v1.1 §6）。
   */
  allowSummary?: string;
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

/** Hub への push_request の接続・書き込みの上限（ここまでに接続できなければ hub が居ないとみなして自分で送る）。 */
export const HUB_PUSH_RPC_TIMEOUT_MS = 500;

/** 打ち切り（SIGTERM）を受けてから、承認の後始末を待つ上限。超えたらそのまま終了する。 */
export const HOOK_CANCEL_CLEANUP_LIMIT_MS = 2000;

// MARK: - テスタブルコア

export interface RunHookOptions {
  stdinData: Buffer;
  /** 起動時に PermissionRequest を登録した会話。未指定なら旧方式。 */
  usePermissionRequest?: boolean;
  /** フックが発火した時刻。tool_use_id が引けないとき、会話ログの古いターン終了を除く。 */
  startedAtMs?: number;
  /**
   * Claude Code がこのフックを打ち切った（SIGTERM）。承認の待ちをやめ、アプリへ出した承認と受け渡し口を片付けて
   * 無出力で終わる。画面の確認で「No」を選ぶ・Esc で中断すると、待っているフックに SIGTERM が届く（2.1.327 実測。
   * 「Yes」では届かない）。後始末をせずに落ちると、承認の記録とアプリの承認待ちが残る。
   */
  cancelSignal?: AbortSignal;
  /**
   * 会話の画面（pane）の取得。PermissionRequest の待ち中に、画面の確認ダイアログが消えたこと（端末で「Yes」）を拾う。
   * 省略時は会話ログ（tool_result・ターン終了）と打ち切りだけで決着を拾う。
   */
  paneCapture?: () => Promise<string | null>;
  /** 画面を見る間隔（会話ログを見る回数で数える。省略時は 2 秒ごと。テスト用）。 */
  panePollEveryTicks?: number;
  /** 接続する unix socket パス。null は接続不能と同義（承認待ちの経路では即 deny）。 */
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
  /** 予約を持つ Claude の pid の解決（注入）。省略時は hook の親 → 祖父で状態ファイルがある pid。 */
  resolveClaudePid?: () => number | undefined;
  /** Session Hub daemon の常駐保証（注入）。省略時は何もしない。UserPromptSubmit でのみ呼ぶ。 */
  ensureHub?: () => void;
  /**
   * 承認の受け渡し口（`approvalMailbox.ts`）のベース。待っている承認を書き出し、`tailii-host chat approve` の決定を
   * アプリの返事と並べて待つ。省略時は使わない（テスト密閉）。runHookCommand が既定パスを渡す。
   */
  approvalsBase?: string;
  /** 受け渡し口の決定ファイルを見る間隔（ms。既定 500）。 */
  approvalsPollMs?: number;
  /**
   * 承認できる人が居るか（`tailii-host chat` が起動した会話でだけ聞く）: 通知を受ける端末が登録されている、または
   * Bot に承認が許されている。false なら、アプリがつながっていないとき 540 秒待たずに拒否する（tailii-chat-cli 第 2 段）。
   * 省略時は「居る」とみなす（従来どおり待つ）。
   */
  approverAvailable?: () => boolean;
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
}

/** hook の本体（テスタブル・完全版）。stdin JSON の `hook_event_name` で分岐する。 */
export async function runHookCore(options: RunHookOptions): Promise<HookRunResult> {
  const session = options.session ?? "default";
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
    // Stop 時点で残っているセッション予約（/loop・ScheduleWakeup・CronCreate）を記録する。
    // 予約はプロセス内にしか無いので、reaper は次回発火まで延命する（欄の無い旧 CLI は消す）。
    const scheduled = parsed.eventName === "Stop"
      ? scheduledFromSessionCrons(parsed.sessionCrons, Date.now(), {
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
        ...scheduledOwnerPid(parsed.sessionCrons, options),
        ...previousScheduled(options, session),
      })
      : undefined;
    await notifySessionProcessing(
      options, session, parsed.eventName === "Stop" ? "done" : "active", parsed.eventName, scheduled);
    return { exitCode: 0, stdout: "" };
  }

  // --- 0.01 API エラーでのターン終了（StopFailure。Stop の代わりに発火し、出力と終了コードは無視される）---
  // 処理完了として heartbeat / hub へ知らせ、エラー種別を添える（hub が turn_error の push と、rate_limit なら
  // 使用量制限の見張りを始める。transcript を誰も購読していなくても届く, push v1）。サブエージェント・CLI 内部の
  // 複製（agent_id 付き）の失敗は会話のターン終了ではないので扱わない。
  if (parsed.eventName === "StopFailure") {
    if (parsed.agentId === undefined) {
      await notifySessionProcessing(options, session, "done", "StopFailure", undefined, undefined, parsed.stopFailureError);
    }
    return { exitCode: 0, stdout: "" };
  }

  // --- 0.05 サブエージェントの開始 / 終了（session-agent-count） ---
  // 会話一覧の「エージェント N」用に hub へ一方向で知らせて即終了する（無出力 = 何も止めない）。
  // CLI 内部の複製（agent_type が無い）は数えない。
  if (parsed.eventName === "SubagentStart" || parsed.eventName === "SubagentStop") {
    // 開始は種類つき（agent_type の無い CLI 内部の複製は数えない）。終了は種類が空のことがある
    // （CLI 実装: `agent_type ?? ""`）ので id だけで送る（数えていない id の終了は hub で何も起きない）。
    const countable = parsed.agentId !== undefined &&
      (parsed.eventName === "SubagentStop" || parsed.agentType !== undefined);
    if (countable && parsed.agentId !== undefined && session !== "default" && options.engineRelaySocketPath !== null) {
      try {
        await sendSubagentLifecycleToEngine(
          { type: "subagent_lifecycle", session, event: parsed.eventName === "SubagentStart" ? "start" : "stop",
            agentId: parsed.agentId },
          options.engineRelaySocketPath,
          60,
        );
      } catch {
        // relay 不達は無視する（一覧の数が出ないだけ）。
      }
    }
    return { exitCode: 0, stdout: "" };
  }

  // --- 0.1 CLI 内部の複製（返答案など）のツール呼び出し（internal-fork-hook） ---
  // 処理中の通知・設問・承認のどれにも使わない。PreToolUse は判定を返さず（CLI 自身の判定に任せる。
  // 返答案の複製はツールを必ず拒否される）、PostToolUse は実行された記録として監査だけ残す。
  if (isInternalForkHook(parsed)) {
    if (parsed.eventName === "PostToolUse") return runPostToolUse(parsed, session, options.observationBase);
    return { exitCode: 0, stdout: "" };
  }

  if (parsed.eventName === "PostToolUse") {
    // 実行されたツールの照合用の記録（新方式の PreToolUse が残す）は、ここで消す。
    if (options.approvalsBase !== undefined && parsed.explicitToolUseId !== undefined) {
      forgetPreToolUse(options.approvalsBase, parsed.explicitToolUseId);
    }
    // ツールイベント＝処理中ハートビート（長時間ターンでも処理中判定が失効しないよう更新）。
    await notifySessionProcessing(options, session, "active", parsed.eventName, undefined, subagentIdOf(parsed));
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

  if (parsed.eventName === "PermissionRequest") {
    if (!options.usePermissionRequest || parsed.toolName === "AskUserQuestion" || parsed.toolName === "ExitPlanMode") {
      return { exitCode: 0, stdout: "" };
    }
    const record = options.approvalsBase === undefined ? null : takePreToolUse(options.approvalsBase, session, parsed);
    const external = watchExternalApproval(
      parsed, record, options.startedAtMs ?? Date.now(), options.paneCapture, options.panePollEveryTicks);
    const decision = await runApproval(options, parsed, external, record?.approvalId);
    // 決着は runApproval の中の 1 か所で決まる（打ち切り・画面側の決着を見たうえで、結果の記録とアプリへの反映を出す）。
    // ここまで来た答えは記録済みなので、そのまま出力する。
    if (decision === null) return { exitCode: 0, stdout: "" };
    return { exitCode: 0, stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: decision.kind === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.reason },
      },
    }) };
  }

  // === 以降 PreToolUse（既定） ===
  // ツールイベント＝処理中ハートビート（承認ゲート待ちの間も処理中扱いを維持する）。
  await notifySessionProcessing(options, session, "active", parsed.eventName, undefined, subagentIdOf(parsed));

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

  if (options.usePermissionRequest) {
    // 承認が出たときに PermissionRequest が tool_use_id を引けるよう、照合用の記録だけ残す。
    // 画像の検出は承認を実際に出すとき（PermissionRequest 側）に行う。ここで行うと、確認の出ないツール呼び出し
    // （auto の Read など）でも毎回投入され、今までの「承認に添える画像」より広がる。
    if (options.approvalsBase !== undefined && parsed.explicitToolUseId !== undefined && parsed.toolName !== "ExitPlanMode") {
      rememberPreToolUse(options.approvalsBase, session, parsed, parsed.explicitToolUseId, randomUUID());
    }
    return { exitCode: 0, stdout: "" };
  }

  // --- 0.5 permission mode による自動許可（mode-picker 連動） ---
  // TUI が auto（全自動）のとき、および acceptEdits の編集系ツールは iPhone 承認を
  // 出さずに即 allow する。これが無いと mode_set で Auto に切り替えても hook が
  // 常にゲートし、確認モーダルが出続ける（= モード変更が反映されない）。
  // hook 入力の permission_mode は処理中にも消えない権威値として優先する。旧版で
  // 欠落する場合だけ provider を使い、provider 無し・capture 失敗・ダイアログ表示中
  // = null なら従来どおり iPhone ゲートへフォールバックする（安全側）。
  const permissionMode = await currentPermissionMode(options, parsed.permissionMode);
  const autoAllowReason = autoAllowReasonForMode(permissionMode, parsed.toolName);
  if (autoAllowReason !== null) return allow(autoAllowReason);

  // --- 0.6 確認を出さないモード（dontAsk）は判定を返さず、Claude Code 自身の判定に任せる ---
  // dontAsk は「許可ルールに合うものだけ実行し、確認が要るものは聞かずに拒否する」モード。Claude Code は
  // 組み込みのサブエージェント（web-fetch など）をこのモードで起動することがあり（meta の spawnMode、
  // 2026-11-19 実測）、会話本体が auto でもフック入力の permission_mode は dontAsk で届く。ここで
  // iPhone に聞くと「確認を出さない」モードなのに承認が開き、allow を返すとモードが許す範囲を広げてしまう。
  if (defersToClaudeForMode(permissionMode)) return { exitCode: 0, stdout: "" };

  const decision = await runApproval(options, parsed);
  return decision === null ? { exitCode: 0, stdout: "" }
    : decision.kind === "allow" ? allow(decision.reason) : deny(decision.reason);
}

type ApprovalDecision = { kind: "allow" | "deny"; reason: string; by?: "cli" | "timeout" };
type ApprovalFlowOptions = RunHookOptions & {
  signal: AbortSignal;
  tracker: { announced: boolean };
  checkExternal?: () => boolean;
};

/** 共通の iPhone / CLI 承認待ち。null は端末側で決着して承認の返答を取り下げた場合。 */
async function runApproval(
  options: RunHookOptions,
  parsed: ParsedPreToolUse,
  external?: ReturnType<typeof watchExternalApproval>,
  requestId: string = randomUUID(),
): Promise<ApprovalDecision | null> {
  if (external?.check() === true || options.cancelSignal?.aborted === true) return null;
  if (options.socketPath === null) return { kind: "deny", reason: "iPhone unavailable (no socket path)" };

  const summary = buildSummary(parsed.toolName, parsed.toolInput);
  const diff = buildDiff(parsed.toolName, parsed.toolInput);
  const session = options.session ?? "default";

  // 単一の内部デッドライン。push→retry-connect→send→waitForDecision の全フェーズが
  // この 1 本の予算を共有する（Req 8.1）。
  const deadlineAtMs = Date.now() + options.deadlineSeconds * 1000;

  // 承認の待ちが終わるすべての出口（許可・拒否・時間切れ・つなぎ直しの期限切れ・エラー）で、アプリへ知らせた承認
  // （承認チャネルへ要求を書いた・一覧へ remote_pending を出した）なら必ず remote_pending_cleared を出す（ここ 1 か所）。
  // 送信は最善努力で、hook の結果は変えない。受け手は id で照合するので、重ねて出しても害は無い。
  const tracker = { announced: false };
  const stop = new AbortController();
  const flowOptions: ApprovalFlowOptions = {
    ...options, signal: stop.signal, tracker,
    ...(external !== undefined ? { checkExternal: external.check } : {}),
  };
  const socketPath = options.socketPath;
  // アプリへの要求・受け渡し口・つなぎ直しの送り直しでは同じ id を使う。
  const mailbox = options.approvalsBase;
  let finalResult: ApprovalDecision | null = null;
  if (mailbox !== undefined) {
    writePendingApproval({
      id: requestId, session, tool: parsed.toolName, summary, cwd: parsed.cwd, atMs: Date.now(), pid: process.pid,
      ...(external !== undefined ? { permissionRequestUntilMs: deadlineAtMs } : {}),
      ...(parsed.agentId !== undefined && parsed.agentType !== undefined
        ? { agentId: parsed.agentId, agentType: parsed.agentType } : {}),
    }, mailbox);
  }
  const flow = (async (): Promise<ApprovalDecision | null> => {
    const socket = await connectUnixSocket(socketPath, stop.signal);
    if (stop.signal.aborted || external?.check() === true) {
      socket?.destroy();
      return null;
    }
    // `tailii-host chat` が起動した会話で、アプリがつながっておらず承認できる人も居なければ、540 秒待たずに拒否する
    // （Bot は待つだけで、誰にも知らされない。tailii-chat-cli 第 2 段）。
    if (socket === null && isCliSession(session) && options.approverAvailable !== undefined && !options.approverAvailable()) {
      return { kind: "deny", reason: NO_APPROVER_REASON };
    }
    return socket
      // 接続済み（アプリ前面）。従来経路をそのまま実行する（push しない, 7.1）。
      ? sendRequestAndReflect(socket, parsed, summary, diff, flowOptions, deadlineAtMs, requestId, false)
      // === connect 不能ブランチ（Req 2.1 / 8.1〜8.3） ===
      : publishPendingAndAwaitReconnect(socketPath, parsed, summary, diff, flowOptions, deadlineAtMs, requestId, false);
  })();
  try {
    const contenders = [flow];
    // アプリの返事と、受け渡し口の決定（`tailii-host chat approve`）の早い方で決める。受け渡し口が先なら、アプリへの
    // 要求は待たずに終える（hook はこの後すぐ終了する）。
    if (mailbox !== undefined) {
      contenders.push(waitForMailboxDecision(session, requestId, deadlineAtMs, stop.signal, {
        base: mailbox, ...(options.approvalsPollMs !== undefined ? { intervalMs: options.approvalsPollMs } : {}),
      }).then((decision): ApprovalDecision | null | Promise<ApprovalDecision | null> => {
        if (decision === null) return flow;
        return {
          kind: decision.decision, by: "cli",
          reason: decision.reason ?? (decision.decision === "allow" ? "Approved via tailii-host chat" : "Denied via tailii-host chat"),
        };
      }));
    }
    if (external !== undefined) contenders.push(external.wait(stop.signal).then((settled) => settled ? null : flow));
    const cancelSignal = options.cancelSignal;
    if (cancelSignal !== undefined) {
      // 打ち切られたら返事を待たずに終える（finally が待ちを止め、アプリの承認と受け渡し口を片付ける）。
      contenders.push(new Promise<null>((resolve) => {
        const onCancel = (): void => resolve(null);
        if (cancelSignal.aborted) onCancel();
        else {
          cancelSignal.addEventListener("abort", onCancel, { once: true });
          stop.signal.addEventListener("abort", () => cancelSignal.removeEventListener("abort", onCancel), { once: true });
        }
      }));
    }
    finalResult = await Promise.race(contenders);
    if (cancelSignal?.aborted === true) finalResult = null;
    if (external?.check() === true) finalResult = null;
    return finalResult;
  } finally {
    stop.abort();
    // 決着後の再接続・再送を止め、最後の remote_pending が clear を追い越さないよう待つ。
    await flow.catch(() => {});
    if (mailbox !== undefined) {
      // CLI が決定を置いていれば、決めた側と決定を残す（CLI の applied の判断に使う）。
      removePendingApproval(session, requestId, mailbox,
        finalResult !== null ? { decision: finalResult.kind, by: finalResult.by ?? "app" } : undefined);
    }
    if (tracker.announced) {
      // 片付けの失敗（例外を含む）で hook の結果を変えない。送信は engine relay の短い上限（250ms）で打ち切られる。
      try { await clearRemotePendingIfNeeded(requestId, options); } catch { /* 最善努力。 */ }
    }
  }
}

/** 承認できる人が居ないときの拒否の理由（Claude に読ませる）。 */
export const NO_APPROVER_REASON =
  "No one can approve this right now (the Tailii app is not connected, no device is registered for notifications, " +
  "and approvals by the bot are not enabled). Continue in a way that does not need this tool, or stop and report " +
  "what you need to the user.";

// MARK: - 処理中/処理完了ライフサイクル通知

/**
 * engine relay へ session_processing を送り、reaper daemon の判定権威である heartbeat
 * ファイルも更新する（失敗は握り潰し＝ゲート/監査へ影響させない）。
 * `engineRelaySocketPath: null` は「送らない」明示指定（テスト密閉用）。
 */
/**
 * hook の発火時刻（Unix ms）。Claude Code は hook を event 発生時に spawn するため、node の起動遅延
 * （実測 100〜300ms）を含む `Date.now()` ではなく、process.uptime() を差し引いた「プロセス開始時刻」が
 * event 発生時刻に最も近い。Hub はこれを transcript のターン終端行（中断確定 / API エラー）の
 * timestamp と比べ、「終端より前に発火した hook = 既に終わったターンの遅着」を判定する
 * （late-hook-before-turn-end）。同一マシンの時計なので transcript 側と直接比較できる。
 */
function hookSpawnedAtMs(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/** 予約を持つ Claude の pid（予約がある Stop だけ解決する）。解決できなければ空。 */
function scheduledOwnerPid(sessionCrons: unknown, options: RunHookOptions): { pid?: number } {
  if (!Array.isArray(sessionCrons) || sessionCrons.length === 0) return {};
  const pid = (options.resolveClaudePid ?? claudePidOfHook)();
  return pid !== undefined ? { pid } : {};
}

/** 直前の予約記録（繰り返し予約の最初に見た時刻を引き継ぐ）。読めなければ空。 */
function previousScheduled(options: RunHookOptions, session: string): { previous?: HeartbeatScheduled } {
  if (options.heartbeatDir === undefined || session === "default") return {};
  try {
    const previous = readHeartbeat(options.heartbeatDir, session)?.scheduled;
    return previous !== undefined ? { previous } : {};
  } catch {
    return {};
  }
}

/** サブエージェントのツール呼び出しなら、その id（CLI 内部の複製は種類が無いので除く, session-agent-count）。 */
function subagentIdOf(parsed: { agentId?: string; agentType?: string }): string | undefined {
  return parsed.agentId !== undefined && parsed.agentType !== undefined ? parsed.agentId : undefined;
}

async function notifySessionProcessing(
  options: RunHookOptions,
  session: string,
  state: "active" | "done",
  event: string,
  scheduled?: HeartbeatScheduled | null,
  agentId?: string,
  error?: string,
): Promise<void> {
  // heartbeat は engine の生死と無関係に書ける唯一の経路（reaper daemon が読む）。
  // session 未解決（"default"）は書かない — 実在しない tmux 名の残骸ファイルを作らない。
  if (options.heartbeatDir !== undefined && session !== "default") {
    try {
      writeHeartbeat(options.heartbeatDir, session, {
        ts: Math.floor(Date.now() / 1000),
        state: state === "done" ? "idle" : "active",
        event,
        ...(scheduled !== undefined ? { scheduled } : {}),
      });
    } catch {
      // heartbeat 書込失敗は無視（reaper 保護が弱まるだけで安全性は変わらない）。
    }
  }
  if (options.engineRelaySocketPath === null) return;
  try {
    // agentId: サブエージェントのツール呼び出し。hub はそのエージェントの「最後に見た時刻」を更新する
    // （長く走る背景エージェントを、まだ動いているのに数から外さない, session-agent-count）。
    const message = {
      type: "session_processing", session, state, event, atMs: hookSpawnedAtMs(),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(error !== undefined ? { error } : {}),
    } as const;
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
 * 旧方式でフックが判定を返さず、Claude Code 自身の判定に任せるモードか（純ロジック）。
 *
 * Claude Code がフックへ渡す permission_mode は default / plan / acceptEdits / auto / dontAsk /
 * bypassPermissions の 6 つ。Tailii の扱いは次のとおり（`autoAllowReasonForMode` と合わせて全部）:
 * - auto: 全ツールを即 allow。
 * - acceptEdits: 編集系ツールだけ即 allow、ほかは iPhone で確認。
 * - dontAsk: 判定を返さない（ここ）。Claude Code が許可ルールで決め、確認が要るものは聞かずに拒否する。
 * - default / plan: iPhone で確認。
 * - bypassPermissions: iPhone で確認（広げない）。Tailii からは選べないモードで、届くのはサブエージェントの
 *   定義などが指定したときだけ。任せると確認なしで何でも動くので、会話のモードより広い許可を素通ししない
 *   （API 作業の引き継ぎが auto・bypassPermissions を default へ落とすのと同じ考え）。
 * - 未知の値 / null（判定不能）: iPhone で確認（安全側）。
 */
export function defersToClaudeForMode(mode: string | null): boolean {
  return mode === "dontAsk";
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
 * pane 表示から permission mode を判定する本番 provider を作る（claude 専用）。
 * capture が timeLimitMs 内に返らない・失敗する場合は null（判定不能 → 従来ゲート）。
 * 本番の hook CLI は Claude 専用なので、この provider も Claude にだけ配線する。
 * セッションの属するバックエンド（tmux / herdr）はメタデータで解決する。
 */
export function makeTmuxPermissionModeProvider(
  session: string,
  timeLimitMs = 1500,
): () => Promise<string | null> {
  return async () => {
    try {
      const manager = makeBackendForSession(session);
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
  options: ApprovalFlowOptions,
  deadlineAtMs: number,
  requestId: string,
  imagesAlreadyEnqueued: boolean,
): Promise<ApprovalDecision | null> {
  if (options.signal.aborted || options.checkExternal?.() === true) return null;
  const session = options.session ?? "default";
  if (options.engineRelaySocketPath !== null) {
    // 送信の成否に関わらず「知らせた」とみなす（届いていれば終わりに必ず片付ける。重ねても害は無い）。
    options.tracker.announced = true;
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
  if (options.signal.aborted) return null;
  if (options.notifier) {
    const presence = await probePresence(options.presenceProbe, session, options.signal);
    if (options.signal.aborted || options.checkExternal?.() === true) return null;
    if (presence !== null) {
      try { options.pushObserver?.recordSkipped(requestId, presence, session); } catch { /* 観測失敗は無視。 */ }
    } else {
      await sendBackgroundPush(
        options.notifier,
        {
          approvalId: requestId, tool: parsed.toolName, session, summary,
          ...(() => {
            const allowSummary = describeToolForApproval(parsed.toolName, parsed.toolInput, parsed.cwd).allowSummary;
            return allowSummary !== null ? { allowSummary } : {};
          })(),
        },
        options.notifierTimeLimitMs ?? 5000,
        options.signal,
      );
    }
  }

  const retryIntervalSeconds =
    options.retryConnectIntervalSeconds ?? HOOK_RETRY_CONNECT_INTERVAL_SECONDS;
  const reconnected = await retryConnect(socketPath, deadlineAtMs, retryIntervalSeconds, options.signal);
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
  return options.signal.aborted ? null : {
    kind: "deny", reason: `iPhone unavailable (no reconnect within ${Math.round(options.deadlineSeconds)}s)`,
  };
}

// MARK: - approval_request 送出＋決定反映（connect 成功／再接続で共有）

async function sendRequestAndReflect(
  socket: net.Socket,
  parsed: ParsedPreToolUse,
  summary: string,
  diff: ToolDiff | undefined,
  options: ApprovalFlowOptions,
  deadlineAtMs: number,
  requestId: string,
  imagesAlreadyEnqueued: boolean,
): Promise<ApprovalDecision | null> {
  try {
    if (options.signal.aborted || options.checkExternal?.() === true) return null;

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
      // サブエージェントが求めた承認なら、どのエージェントか（subagent-control）。CLI 内部の複製はここまで来ない。
      ...(parsed.agentId !== undefined && parsed.agentType !== undefined
        ? { agentId: parsed.agentId, agentType: parsed.agentType } : {}),
    });
    try {
      socket.write(encoded + "\n");
      options.tracker.announced = true;
    } catch {
      // 送出直前に serve チャネルが落ちた（chat 離脱/開き直しレース）。切断と同じ扱い。
      if (options.socketPath === null) return { kind: "deny", reason: "iPhone disconnected (write failed)" };
      return publishPendingAndAwaitReconnect(
        options.socketPath, parsed, summary, diff, options, deadlineAtMs, requestId, true,
      );
    }

    // 残りデッドライン内で approval_decision を待つ（自 id のみ受理, 5.4）。
    const outcome = await waitForDecision(socket, requestId, deadlineAtMs, options);
    // remote_pending_cleared は runApproval の終わりで 1 回だけ出す。
    switch (outcome.kind) {
      case "allow":
        return { kind: "allow", reason: outcome.reason ?? "Approved on iPhone" };
      case "deny":
        return { kind: "deny", reason: outcome.reason ?? "Denied on iPhone" };
      case "timeout":
        return { kind: "deny", reason: `No response within ${Math.round(options.deadlineSeconds)}s`, by: "timeout" };
      case "cancelled":
        return null;
      case "disconnected":
        // 決定待ち中の切断 = iOS の chat 離脱（serve チャネル close）や SSH 断。
        // 承認自体はまだ生きているので即 deny せず、connect 不能ブランチと同じ
        // フォールバックに合流して再接続（chat 開き直し）後に同一 id で送り直す。
        if (options.socketPath === null) return { kind: "deny", reason: "iPhone disconnected" };
        return publishPendingAndAwaitReconnect(
          options.socketPath, parsed, summary, diff, options, deadlineAtMs, requestId, true,
        );
    }
  } finally {
    closeAfterReply(socket);
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
  | { kind: "disconnected" }
  | { kind: "cancelled" };

/**
 * デッドライン内で approval_decision を1行ずつ受信し、id が一致する有効決定を待つ。
 * id 不一致・undecodable・非対応 v の行はスキップして読み続ける（残り時間内）。
 * EOF/エラー → disconnected。デッドライン超過 → timeout。
 */
function waitForDecision(
  socket: net.Socket,
  expectedId: string,
  deadlineAtMs: number,
  { signal, checkExternal, cancelSignal }: ApprovalFlowOptions,
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
      signal.removeEventListener("abort", onAbort);
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
          if (checkExternal?.() === true || cancelSignal?.aborted === true) {
            settle({ kind: "cancelled" });
            return;
          }
          // 決定の反映結果をアプリへ返す（push v1.1 §6。最善努力・確定を遅らせない）。
          replyDecisionApplied(socket, expectedId);
          settle(outcome);
          return;
        }
      }
    };
    const onDisconnect = (): void => settle({ kind: "disconnected" });
    const onAbort = (): void => settle({ kind: "cancelled" });

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
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
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
function connectUnixSocket(socketPath: string, signal: AbortSignal): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const socket = net.connect(socketPath);
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(null);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", abort);
      socket.removeAllListeners("error");
      // 決定待機中の error は waitForDecision が disconnected として扱う。
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", abort);
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
  signal: AbortSignal,
): Promise<net.Socket | null> {
  const intervalMs = Math.max(0, Math.min(intervalSeconds, 3600) * 1000);
  for (;;) {
    const socket = await connectUnixSocket(socketPath, signal);
    if (socket) return socket;
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) return null;
    if (!await abortableSleep(Math.min(intervalMs, remaining), signal)) return null;
  }
}

// MARK: - 背景 push 送出（connect 不能ブランチのみ）

/** 注入された presence 判定を全体上限内で実行する。失敗・超過は null（push 継続）。 */
async function probePresence(probe: PresenceProbe | undefined, session: string, signal: AbortSignal): Promise<PresenceReason | null> {
  if (probe === undefined) return null;
  const stop = new AbortController();
  try {
    const timeout = abortableSleep(PRESENCE_PROBE_TIME_LIMIT_MS, AbortSignal.any([stop.signal, signal])).then(() => null);
    return await Promise.race([probe(session).catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    stop.abort();
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

/**
 * 本番の presence probe（push v1）: Mac の端末に attach 中なら承認の push を抑える。端末ごとの在席
 * （前面 / 背景・生存確認）は hub の dispatcher が判断するので、ここでは hub の購読者数を見ない
 * （背景へ移った直後の猶予中も購読が残り、従来の `client-live` は不在を在席と誤認していた）。
 */
export function makeMacAttachedProbe(runner: TmuxCommandRunner = processTmuxCommandRunner()): PresenceProbe {
  return async (session) => ((await attachedSessions(runner)).has(session) ? "mac-attached" : null);
}

/**
 * Hub socket へ短命接続して push_request を書き込む（`requestHubPresence` と同じ流儀）。
 * 接続でき、要求を書き込めたら `delivered`（以後 hook は自分では送らない。hub の応答は待たない = 承認の
 * 判断も hook の終了も遅らせない）。接続できない（hub が居ない）・書き込めないときだけ `unreachable`。
 */
export function requestHubPush(
  event: HubPushEvent,
  socketPath: string,
  timeoutMs = HUB_PUSH_RPC_TIMEOUT_MS,
  /** 接続の作成（テスト注入用）。 */
  connect: (path: string) => net.Socket = (path) => net.createConnection(path),
): Promise<"delivered" | "unreachable"> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const socket = connect(socketPath);
    let settled = false;
    // 接続できた後は、結果が分からなくても（書き込みのエラー・socket の error・期限切れ）一貫して delivered に倒す
    // （hub が受け取った可能性がある = 自前送信へ切り替えると二重送信・在席抑止の迂回になる）。
    let connected = false;
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: "delivered" | "unreachable"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (writeTimer !== null) clearTimeout(writeTimer);
      const result = connected ? "delivered" : value;
      if (result === "delivered" && value === "delivered") socket.end();
      else socket.destroy();
      resolve(result);
    };
    // 接続できないまま時間切れ = hub が居ない。
    const connectTimer = setTimeout(() => finish("unreachable"), Math.max(0, timeoutMs));
    socket.once("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      // 書き込みの完了通知が来なくても短い期限で打ち切って後始末する。
      writeTimer = setTimeout(() => finish("unreachable"), Math.max(0, timeoutMs));
      socket.write(encodeHubMessage({ type: "push_request", id, event }), (error) => {
        finish(error === undefined || error === null ? "delivered" : "unreachable");
      });
    });
    socket.on("error", () => finish("unreachable"));
  });
}

/** 承認の通知本文の要約の上限（字）。これを超える要約は省略するので、通知の上では許可させない。 */
const APPROVAL_SUMMARY_MAX_CHARS = 280;

/**
 * 承認の通知本文と、本文が操作の全体を省略なく含むか（`complete`。平文の `allow` の元, push v1.1 §6）。
 * - 許可してよい形の要約（`allowSummary` = `<作業ディレクトリ> $ <コマンド>`）があり、280 字以内で、通知用の整形
 *   （空白の畳み込み）で 1 文字も変わらないとき: 本文は `Bash · <作業ディレクトリ> $ <コマンド>`、complete。
 * - それ以外: 従来の `ツール名 · 要約`（280 字で省略）、complete ではない。
 * 利用者に見える本文と、判定に使った本文は同じ文字列。
 */
export function approvalNotification(request: ApprovalPushRequest): { body: string; complete: boolean } {
  const allow = request.allowSummary;
  if (request.tool === "Bash" && allow !== undefined &&
    summarizeForNotification(allow, APPROVAL_SUMMARY_MAX_CHARS) === allow) {
    // 長さは完成した本文（`Bash · ` を含む）で確かめる。
    const body = `${request.tool} · ${allow}`;
    if ([...body].length <= APPROVAL_SUMMARY_MAX_CHARS) return { body, complete: true };
  }
  const summary = summarizeForNotification(request.summary, APPROVAL_SUMMARY_MAX_CHARS);
  return { body: summary === null ? request.tool : `${request.tool} · ${summary}`, complete: false };
}

/** 承認の通知本文（`ツール名 · 要約`）。 */
export function approvalNotificationBody(request: ApprovalPushRequest): string {
  return approvalNotification(request).body;
}

/**
 * 本番の承認 push 送出子（push v1）。送るかどうかの判断は hub の dispatcher へ依頼し（在席判定・間引きを
 * 一元化）、hub に届かないときだけ同じ dispatcher を自プロセスで動かす（在席情報なし = 登録端末すべてへ）。
 * 成否は承認の可否判断に影響しない（呼び手が時間上限で打ち切る）。
 */
export function makeHookPushNotifier(options: {
  hubSocketPath?: string;
  hubRequestTimeoutMs?: number;
  localDispatcher?: () => PushDispatcher;
} = {}): ApprovalPushNotifier {
  return async (request) => {
    const notification = approvalNotification(request);
    const event: HubPushEvent = {
      kind: "approval",
      session: request.session,
      id: request.approvalId,
      tool: request.tool,
      body: notification.body,
      // 本文が操作の全体を省略なく含むときだけ（通知の上で許可できる。端末ごとの段は dispatcher が判定する）。
      ...(notification.complete ? { bodyComplete: true } : {}),
    };
    const socketPath = options.hubSocketPath ?? resolveHubSocketPath();
    // hub へ渡せたら、その後は決して自分では送らない（hub の応答が遅くても二重に送らない）。
    if (await requestHubPush(event, socketPath, options.hubRequestTimeoutMs ?? HUB_PUSH_RPC_TIMEOUT_MS) === "delivered") return;
    // hub が居ないときだけ自分で送る。端末記録は読むだけで、間引きの記録・端末記録・最後の送信結果は書かない
    // （書き手は hub だけ。同じ承認の重複は apns-collapse-id = 承認 id で表示上 1 件になる）。
    const dispatcher = options.localDispatcher?.() ?? createProductionPushDispatcher({
      titleFor: makeSessionTitleResolver(new SessionMetadataStore()),
      // hook の送信予算（既定 5 秒）に 1 回分が収まる長さ。打ち切られても送信自体は続く（hook は再接続待ちで残る）。
      relayTimeoutMs: 3_500,
      readOnly: true,
    });
    await dispatcher.notify(event);
  };
}

/** 背景 push を送出する。timeLimit で打ち切り、成否は deny 判断に影響しない。 */
async function sendBackgroundPush(
  notifier: ApprovalPushNotifier,
  request: ApprovalPushRequest,
  timeLimitMs: number,
  signal: AbortSignal,
): Promise<void> {
  const stop = new AbortController();
  try {
    await Promise.race([
      notifier(request, timeLimitMs).catch(() => {}),
      abortableSleep(timeLimitMs, AbortSignal.any([stop.signal, signal])),
    ]);
  } finally {
    stop.abort();
  }
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
export function buildSummary(toolName: string, toolInput: Record<string, unknown>): string {
  return describeToolForApproval(toolName, toolInput).summary;
}

/** 許可してよい Bash の入力で知っている欄（`description` / `timeout` は表示しないが操作の内容を変えないので許す）。 */
const ALLOWABLE_BASH_INPUT_KEYS = new Set(["command", "description", "timeout", "run_in_background", "dangerouslyDisableSandbox"]);
/** 表示できる ASCII（0x20〜0x7E）だけ・前後の空白なし・連続空白なし（通知用の整形で 1 文字も変わらない）。 */
const PRINTABLE_ASCII_LINE = /^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/u;

/** 作業ディレクトリの表示（ホームは `~`）。絶対パスでない・ASCII 以外・`$` を含む（本文の区切りと紛れる）なら null。 */
export function displayWorkingDirectory(cwd: string | undefined, home: string = os.homedir()): string | null {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const display = cwd === home ? "~" : home.length > 1 && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  return PRINTABLE_ASCII_LINE.test(display) && !display.includes("$") ? display : null;
}

/**
 * 承認の要約（承認カードに出す従来の文）と、通知の上で「許可」してよい形の要約（`allowSummary`）。入力を見たその場で
 * 決める（push v1.1 §6）。allowSummary は次のすべてを満たす Bash だけ（それ以外は null = 拒否だけ）:
 * - 入力の欄が知っているものだけで、`run_in_background` / `dangerouslyDisableSandbox` は無いか false。
 * - コマンドが 1 行・表示できる ASCII だけ・前後や連続の空白なし。
 * - 作業ディレクトリ（hook の入力のトップレベルの `cwd` / API 作業の作業ディレクトリ）が分かり、表示が同じ条件を満たす。
 * 形は `<作業ディレクトリ> $ <コマンド>`。280 字の上限は通知本文を作るとき（approvalNotification）に確かめる。
 * Write / Edit（パスだけ）・SendUserFile（名前だけ）・その他のツール・既定の文は allowSummary を作らない。
 */
export function describeToolForApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string,
  home: string = os.homedir(),
): { summary: string; allowSummary: string | null } {
  if (toolName === "Bash") {
    const command = toolInput["command"];
    if (typeof command === "string" && command.length > 0) {
      return { summary: oneLine(command), allowSummary: bashAllowSummary(toolInput, command, cwd, home) };
    }
    return { summary: "Run a Bash command", allowSummary: null };
  }
  return { summary: buildSummaryText(toolName, toolInput), allowSummary: null };
}

function bashAllowSummary(toolInput: Record<string, unknown>, command: string, cwd: string | undefined, home: string): string | null {
  for (const key of Object.keys(toolInput)) {
    if (!ALLOWABLE_BASH_INPUT_KEYS.has(key)) return null;
  }
  for (const flag of ["run_in_background", "dangerouslyDisableSandbox"]) {
    if (flag in toolInput && toolInput[flag] !== false) return null;
  }
  if ("timeout" in toolInput && typeof toolInput["timeout"] !== "number") return null;
  if ("description" in toolInput && typeof toolInput["description"] !== "string") return null;
  if (!PRINTABLE_ASCII_LINE.test(command)) return null;
  const directory = displayWorkingDirectory(cwd, home);
  return directory === null ? null : `${directory} $ ${command}`;
}

function buildSummaryText(toolName: string, toolInput: Record<string, unknown>): string {
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
    case "SendUserFile": {
      // 成果物の受け渡し（file-download）。承認カードでどのファイルかが分かるようにする。
      const files = Array.isArray(toolInput["files"])
        ? (toolInput["files"] as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 0)
        : [];
      if (files.length === 0) return "Send file to user";
      const names = files.map((f) => f.split("/").pop() ?? f);
      return `Send file: ${names.join(", ")}`;
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
export function buildDiff(toolName: string, toolInput: Record<string, unknown>): ToolDiff | undefined {
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
  /** `session_id` で補わない照合用の id。PermissionRequest の入力には無い。 */
  explicitToolUseId?: string;
  transcriptPath?: string;
  /** PostToolUse の tool_response 内 permissionDecision（あれば）。 */
  postDecision?: string;
  /** Stop の `session_crons`（未検証の生値。解釈は scheduledFromSessionCrons）。 */
  sessionCrons?: unknown;
  /** Claude の session id（`session_id`）。 */
  sessionId?: string;
  /** サブエージェント / CLI 内部の複製の id（`agent_id`）。メインスレッドでは無い。 */
  agentId?: string;
  /** サブエージェントの種類（`agent_type`）。CLI 内部の複製には付かない。 */
  agentType?: string;
  /** StopFailure の `error`（`rate_limit` / `server_error` / `authentication_failed` 等。実測 2.1.322）。 */
  stopFailureError?: string;
}

/**
 * CLI 内部の複製（返答案・記憶の抽出・要約・圧縮・/btw など）が出した hook か（internal-fork-hook）。
 *
 * Claude Code はこれらを会話の複製（runForkedAgent）で動かし、ツール一覧も親から引き継ぐ。複製が
 * ツールを呼ぶと PreToolUse hook が先に発火するが、CLI 自身の判定（返答案なら必ず拒否）で実行は
 * されず、transcript にも画面にも何も残らない。これを本物として扱うと、iPhone に存在しない設問が
 * 出て一覧が「回答待ち」になり、ターン終了後に処理中表示が再点灯する（実機 2026-10-23 / 10-27）。
 *
 * 見分け方（2.1.311 で実測・コードで確認）: メインスレッドは `agent_id` も `agent_type` も無い。
 * 本物のサブエージェント（Agent ツール・背景実行・fork 型を含む）は両方付く。内部の複製は
 * `agent_id`（毎回新しい id）だけが付き `agent_type` が無い。`--agent` で起動した会話の複製は
 * メインの種類が `agent_type` に入るため見分けられず、従来どおりサブエージェントとして扱う。
 */
export function isInternalForkHook(input: { agentId?: string; agentType?: string }): boolean {
  return input.agentId !== undefined && input.agentType === undefined;
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
    parsed.explicitToolUseId = raw["tool_use_id"];
  } else if (typeof raw["session_id"] === "string") {
    parsed.toolUseId = raw["session_id"];
  }
  if ("session_crons" in raw) parsed.sessionCrons = raw["session_crons"];
  if (typeof raw["session_id"] === "string" && raw["session_id"].length > 0) parsed.sessionId = raw["session_id"];
  if (typeof raw["transcript_path"] === "string") parsed.transcriptPath = raw["transcript_path"];
  if (typeof raw["agent_id"] === "string" && raw["agent_id"].length > 0) parsed.agentId = raw["agent_id"];
  if (typeof raw["agent_type"] === "string" && raw["agent_type"].length > 0) parsed.agentType = raw["agent_type"];
  if (parsed.eventName === "StopFailure" && typeof raw["error"] === "string" && /^[a-z_]{1,64}$/u.test(raw["error"])) {
    parsed.stopFailureError = raw["error"];
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
 * `--retry-interval <seconds>` | `--images-dir <path>` | `--permission-request`。
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
  let usePermissionRequest = false;
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
      case "--permission-request":
        usePermissionRequest = true;
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
  // Claude Code がフックを打ち切るとき（画面の確認で「No」・Esc での中断）は SIGTERM が届く。既定の動きのまま落ちると
  // 承認の後始末（remote_pending_cleared・受け渡し口の記録の削除）が走らないので、受けて待ちをやめさせる。
  // 後始末が終わらないときに居残らないよう、少し待って必ず終了する。
  const cancel = new AbortController();
  const onTerminate = (): void => {
    if (cancel.signal.aborted) return;
    cancel.abort();
    setTimeout(() => process.exit(0), HOOK_CANCEL_CLEANUP_LIMIT_MS).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, onTerminate);
  const { exitCode, stdout } = await runHookCore({
    stdinData,
    cancelSignal: cancel.signal,
    usePermissionRequest,
    startedAtMs: hookSpawnedAtMs(),
    socketPath,
    deadlineSeconds,
    session: effectiveSession ?? "default",
    observationBase: defaultObservationBase(),
    imagesPendingBase:
      imagesDirArg !== null ? path.join(imagesDirArg, "pending") : defaultImagesPendingBase(),
    notifier: makeHookPushNotifier(),
    pushObserver,
    retryConnectIntervalSeconds: retryIntervalSeconds,
    heartbeatDir: defaultHeartbeatDir(),
    ensureHub: ensureHubDaemon,
    approvalsBase: defaultApprovalsBase(),
    // 承認できる人: 通知を受ける端末（承認の通知を切っていない）か、Bot の承認の許可（tailii-chat-cli 第 2 段）。
    approverAvailable: () => {
      if (botMayApprove()) return true;
      try {
        return new PushDeviceStore().list().some((device) => device.prefs.approval);
      } catch {
        // 例外になったときだけ従来どおり待つ。list() は読めないファイルを黙って飛ばすので、読めない端末は「居ない」扱い
        // （拒否側）になる。
        return true;
      }
    },
    // 現行 Claude は hook 入力の permission_mode を使う。tmux provider は旧版互換の
    // 欠落時フォールバックとしてだけ呼ばれる。
    ...(effectiveSession !== null
      ? {
          permissionModeProvider: makeTmuxPermissionModeProvider(effectiveSession),
          // プレビュー配信（hubDaemon）と同じ取り方（下から 60 行・折り返しを繋ぐ）で、同じ判定を使う。
          paneCapture: () => makeBackendForSession(effectiveSession).capturePane(effectiveSession, { lines: 60, joinWrappedLines: true }),
          presenceProbe: makeMacAttachedProbe(),
        }
      : {}),
  });
  if (stdout !== "" || !usePermissionRequest) process.stdout.write(stdout + "\n");
  return exitCode;
}
