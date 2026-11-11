// hubProtocol.ts
// tailii (TS host) — Hub と engine の間だけで使う内部 NDJSON プロトコル。

import type { EngineRelayMessage, SessionProcessingMessage } from "./engineRelaySocket.js";
import { PUSH_KINDS, type PushKind } from "../push/pushEnvelope.js";
import {
  isBackgroundCommandStopStatus,
  isSubagentControlAction,
  isSubagentControlStatus,
  type BackgroundCommandStopStatus,
  type SubagentControlAction,
  type SubagentControlStatus,
  decodeControlMessage,
  encodeControlMessage,
  type CodexCollaborationMode,
  type CodexGoalAction,
  type CodexGoalInfo,
  type ControlMessage,
  type QuestionAnswer,
  type QuestionPromptQuestion,
  type ApiAgentConfig,
  type ApiAgentErrorCode,
} from "../protocol.js";
import { API_AGENT_ERROR_MESSAGES, parseApiAgentConfig } from "../apiAgent/config.js";

export type HubClientMessage =
  | { type: "hub_hello" }
  | { type: "conversation_subscribe"; session: string; afterSeq?: number; newerThanMs?: number; preview?: boolean }
  | { type: "conversation_unsubscribe"; session: string }
  | { type: "session_retire"; session: string }
  | { type: "conversation_subagent_transcript_request"; id: string; session: string; nodeId: string; before?: number }
  /** バックグラウンドタスク一覧からの背景コマンドの停止（nodeId = taskId）。 */
  | { type: "background_command_stop"; id: string; session: string; nodeId: string }
  | { type: "subagent_control"; id: string; session: string; action: SubagentControlAction; nodeId?: string; text?: string }
  /** 会話履歴のページ取得（history-page）。before* の行より前の最後の limit 行ぶん。 */
  | {
      type: "conversation_history_page_request";
      id: string;
      session: string;
      beforeStreamId?: string;
      beforeToolId?: string;
      limit: number;
    }
  | { type: "hub_state_request"; id: string; session: string }
  | { type: "presence_request"; id: string; session: string }
  /**
   * 在席の申告（engine→hub, push v1）。iOS の `client_presence` を中継する。hub は接続ごとに
   * `{deviceId, state}` を持ち、push の在席判定に使う。hub 再接続時は engine が最新値を送り直す。
   */
  | { type: "client_presence"; deviceId: string; state: "foreground" | "background" }
  /** hub の `presence_ping` に iOS が応えた（engine→hub）。 */
  | { type: "presence_pong"; id: string }
  /**
   * 通知の送信依頼（hook→hub, push v1）。`presence_request` と同じ短命接続。hub は受理を即答し、
   * 在席判定・送信は自分の dispatcher で行う。
   */
  | { type: "push_request"; id: string; event: HubPushEvent }
  /** 端末登録・解除の中継（engine→hub, push v1）。端末記録を書くのは hub だけ。payload は iOS の push_register そのまま。 */
  | { type: "push_device_register"; id: string; payload: Extract<ControlMessage, { type: "push_register" }> }
  | { type: "push_device_unregister"; id: string; deviceId: string }
  | { type: "question_answer_submit"; id: string; session: string; questionId: string; answers: QuestionAnswer[] }
  | { type: "input_claim"; id: string; session: string; clientMessageId: string }
  | {
      type: "codex_turn_submit";
      id: string;
      session: string;
      text: string;
      clientUserMessageId: string;
      effort: string | null;
      approvalPolicy: "untrusted" | "on-request" | "never" | null;
      sandbox: "read-only" | "workspace-write" | "danger-full-access" | null;
      threadId: string;
      cwd: string;
      explicitRetry?: boolean;
      /** collaboration mode（codex-plan-mode）。省略 / null は旧 engine からの turn（従来どおり指定なし）。 */
      collaborationMode?: CodexCollaborationMode | null;
    }
  | { type: "codex_turn_interrupt"; id: string; session: string }
  /**
   * API 作業（api-agent）。engine が会話の作成・設定変更・中断を hub へ頼む。ターンの所有者は hub の
   * ApiAgentManager（発話は通常の chat_send → chatInjector から入る）。キーの値は載せない。
   */
  | { type: "api_agent_open"; id: string; session: string; conversationId: string; cwd: string; config: ApiAgentConfig; resume: boolean }
  | { type: "api_agent_configure"; id: string; session: string; config: ApiAgentConfig }
  | { type: "api_agent_interrupt"; id: string; session: string }
  /** 元へ戻すために閉じる（実行中なら閉じない）。結果は api_agent_result（error: turn_running / not_open）。 */
  | { type: "api_agent_close"; id: string; session: string }
  /** Codex thread の目標操作（engine→hub, codex-goal）。hub 所有の App Server 接続で `thread/goal/*` を実行する。 */
  | {
      type: "codex_goal_submit";
      id: string;
      session: string;
      threadId: string;
      cwd: string;
      action: CodexGoalAction;
      objective?: string;
      status?: string;
      tokenBudget?: number;
    }
  | {
      type: "chat_send"; id: string; session: string; clientMessageId: string; text: string;
      explicitRetry?: boolean;
      /**
       * 利用者が「この設問に答えずに送る」と決めた送信（chat-cancel-choice）。未回答の設問がこの id の
       * ときだけ保留を解き、設問を Esc で閉じてから注入する。旧 engine は付けない（従来どおり保留）。
       */
      cancelQuestionId?: string;
    }
  | { type: "pending_message_delete"; id: string; session: string; clientMessageId: string; kind: "chat" | "codex" }
  /** Claude 発話の配送状態の照会（engine→hub, restored-receipt-probe）。何も登録しない。 */
  | { type: "chat_receipt_query"; id: string; session: string; clientMessageId: string }
  /** CLI のキューに溜まっている発話を今すぐ届ける（engine→hub, chat-send-now）。 */
  | { type: "chat_send_now"; id: string; session: string }
  | { type: "runtime_claim"; id: string; session: string }
  | { type: "runtime_claim_release"; session: string }
  | { type: "session_preview_watch"; enabled: boolean }
  | SessionProcessingMessage;

/**
 * hub_hello_ack に載せる未回答の設問 1 件（pending-question-snapshot）。hub が今どの会話で設問を
 * 保持しているかの snapshot で、engine はこれで iOS の一覧の「回答待ち」ピルを揃え直す
 * （切断中に片付いた設問の解除通知は誰にも届かないため）。
 */
export interface PendingQuestionSnapshotEntry {
  session: string;
  id: string;
  questions: QuestionPromptQuestion[];
}

/** hook から hub へ渡す通知 1 件（秘密は載せない。本文は要約済み）。 */
export interface HubPushEvent {
  kind: PushKind;
  session: string;
  id?: string;
  body?: string;
  tool?: string;
}

/** hub へ渡す要約の上限（字）。dispatcher がさらに切り詰める。 */
const HUB_PUSH_BODY_MAX_CHARS = 2_000;

export type HubServerMessage =
  | {
    type: "hub_hello_ack"; version: string | null; bootId: string; processingSessions?: string[];
    /** 未回答の設問の snapshot。旧 Hub は送らない（「設問なし」とは区別する）。 */
    pendingQuestions?: PendingQuestionSnapshotEntry[];
    /**
     * 再開のヒント（conversation_subscribe の afterSeq + newerThanMs）を、Hub が境界を使ってよいか確かめた上で
     * 解釈できる。旧 Hub は両方付きを無条件に時刻境界として使い未配送行を落とすので、engine はこれが
     * true の Hub にだけヒントを送る。
     */
    resumeHint?: true;
  }
  | {
      type: "hub_state_response";
      id: string;
      session: string;
      pendingQuestion: { id: string; questions: QuestionPromptQuestion[] } | null;
      processing: boolean;
    }
  | { type: "presence_response"; id: string; session: string; subscriberCount: number }
  /** 送る直前の生存確認（hub→engine）。engine は iOS へ `presence_ping` として渡す。 */
  | { type: "presence_ping"; id: string }
  /** `push_request` の受理（`unavailable` = この hub は送信器を持たない。hook は自分で送る）。 */
  | { type: "push_request_result"; id: string; status: "accepted" | "unavailable" }
  | {
      type: "push_device_register_result"; id: string; status: "ok" | "failed"; transport: "relay" | "direct" | "none";
      capabilityInvalid?: boolean; error?: string;
    }
  | { type: "push_device_unregister_result"; id: string; status: "ok" | "failed" }
  | { type: "conversation_event"; session: string; serverSeq: number; payload: ControlMessage }
  | {
      type: "conversation_subagent_transcript_response";
      id: string;
      session: string;
      payload: Extract<ControlMessage, { type: "subagent_transcript_response" }>;
    }
  /** 履歴ページ（history-page）。`lines` は ControlMessage の wire 行（古い順）。読めなければ `failed`。 */
  | {
      type: "conversation_history_page_response";
      id: string;
      session: string;
      lines: string[];
      hasMore: boolean;
      hostNowMs: number;
      failed?: boolean;
      /** 終端の行が host の履歴に見つからない（iOS は次の行を終端にして取り直す）。 */
      anchorMissing?: boolean;
    }
  | { type: "conversation_pane_preview"; session: string; payload: ControlMessage }
  | { type: "conversation_mode"; session: string; payload: ControlMessage }
  /**
   * セッションの死亡通知（hub→engine, live-pill Phase 2）。retireSession（tick の
   * killed/demoted/reclaimed と engine 発 kill の集約点）から一覧 watcher へだけ送る。
   * 誕生イベントは出さない割り切りのため `alive` は常に false。
   */
  | { type: "conversation_liveness"; session: string; alive: false }
  /**
   * 購読消滅の通知（hub→engine）。retireSession（kill / demote / reclaim）で actor と購読が消えた
   * ことを、その会話の購読者だけへ送る。engine は背景購読の台帳（backgroundChatSessions）から外し、
   * 次の処理中通知で再購読できるようにする（背景購読は冪等化されており再送しないため）。
   * 一覧向けの `conversation_liveness`（watcher 限定）とは別経路。
   */
  | { type: "conversation_retired"; session: string }
  /**
   * `stale` = hub は設問を持っていたが、TUI に設問ダイアログが出ていなかった（回答キーを打てば入力欄へ
   * 落ちる）。キーは 1 つも打たずに設問を閉じた（question-stale）。
   */
  | { type: "question_answer_result"; id: string; status: "accepted" | "already_resolved" | "unknown" | "stale" }
  | { type: "input_claim_result"; id: string; status: "granted" | "duplicate" }
  | { type: "codex_turn_result"; id: string; status: "started" | "duplicate" | "failed"; error?: string }
  /** api_agent_open / configure / interrupt の結果。interrupt の `interrupted=false` は処理中のターンが無かった。 */
  | { type: "api_agent_result"; id: string; status: "ok" | "failed"; error?: ApiAgentErrorCode; interrupted?: boolean }
  | { type: "codex_goal_result"; id: string; status: "ok" | "failed"; goal?: CodexGoalInfo; cleared?: boolean; error?: string }
  | { type: "chat_send_result"; id: string; status: "accepted" | "duplicate" | "failed"; error?: string }
  | { type: "pending_message_delete_result"; id: string; status: "deleted" | "not_found" | "processing" | "failed"; error?: string }
  | { type: "chat_receipt_query_result"; id: string; status: "delivered" | "deleted" | "uncertain" | "pending" | "unknown" }
  | { type: "chat_send_now_result"; id: string; status: "sent" | "nothing_queued" | "blocked" | "failed"; error?: string }
  | { type: "background_command_stop_result"; id: string; status: BackgroundCommandStopStatus; error?: string }
  | { type: "subagent_control_result"; id: string; status: SubagentControlStatus; error?: string }
  | { type: "runtime_claim_result"; id: string; status: "granted" | "held" }
  /** 会話で動いているエージェントの数（session-agent-count）。`replace` は接続直後の全件（載っていない会話は 0）。 */
  | { type: "session_agents"; items: { session: string; running: number }[]; replace?: boolean }
  | EngineRelayMessage;

export function encodeHubMessage(message: HubClientMessage | HubServerMessage): string {
  if (message.type === "conversation_event" || message.type === "conversation_pane_preview" ||
    message.type === "conversation_mode" || message.type === "conversation_subagent_transcript_response") {
    // Hub 封筒内でも ControlMessage は外向け wire 表現を使う。特に tool_activity は
    // activity を flat 化するため、単純な JSON.stringify では受信側 decoder と非対称になる。
    return JSON.stringify({
      ...message,
      payload: JSON.parse(encodeControlMessage(message.payload)) as unknown,
    }) + "\n";
  }
  return JSON.stringify(message) + "\n";
}

/** 不正・未知の行を接続エラーにせず捨てる。 */
export function decodeHubClientLine(line: string): HubClientMessage | null {
  const record = parseRecord(line);
  if (record === null) return null;
  if (record["type"] === "hub_hello") return { type: "hub_hello" };
  if (record["type"] === "conversation_subscribe") {
    const session = record["session"];
    if (typeof session !== "string" || session.length === 0) return null;
    const afterSeq = optionalNonnegativeNumber(record["afterSeq"]);
    const newerThanMs = optionalNonnegativeNumber(record["newerThanMs"]);
    if (afterSeq === null || newerThanMs === null ||
      (record["preview"] !== undefined && typeof record["preview"] !== "boolean")) return null;
    return { type: "conversation_subscribe", session,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(newerThanMs !== undefined ? { newerThanMs } : {}),
      ...(typeof record["preview"] === "boolean" ? { preview: record["preview"] } : {}) };
  }
  if (record["type"] === "conversation_unsubscribe") {
    const session = record["session"];
    return typeof session === "string" && session.length > 0 ? { type: "conversation_unsubscribe", session } : null;
  }
  if (record["type"] === "session_retire") {
    const session = record["session"];
    return typeof session === "string" && session.length > 0 ? { type: "session_retire", session } : null;
  }
  if (record["type"] === "conversation_subagent_transcript_request") {
    const id = record["id"];
    const session = record["session"];
    const nodeId = record["nodeId"];
    const before = record["before"];
    // before は任意（agent-conversation-paging）。整数でない・負は無いものとして扱う（旧形式と同じ最新ページ）。
    const validBefore = typeof before === "number" && Number.isInteger(before) && before >= 0 ? before : undefined;
    return typeof id === "string" && id.length > 0 &&
      typeof session === "string" && session.length > 0 &&
      typeof nodeId === "string" && nodeId.length > 0
      ? {
        type: "conversation_subagent_transcript_request", id, session, nodeId,
        ...(validBefore !== undefined ? { before: validBefore } : {}),
      }
      : null;
  }
  if (record["type"] === "conversation_history_page_request") {
    const id = record["id"], session = record["session"], limit = record["limit"];
    const beforeStreamId = record["beforeStreamId"], beforeToolId = record["beforeToolId"];
    if (typeof id !== "string" || id.length === 0 || typeof session !== "string" || session.length === 0 ||
      typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 ||
      (beforeStreamId !== undefined && typeof beforeStreamId !== "string") ||
      (beforeToolId !== undefined && typeof beforeToolId !== "string")) return null;
    return { type: "conversation_history_page_request", id, session, limit,
      ...(typeof beforeStreamId === "string" ? { beforeStreamId } : {}),
      ...(typeof beforeToolId === "string" ? { beforeToolId } : {}) };
  }
  if (record["type"] === "hub_state_request") {
    const id = record["id"];
    const session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "hub_state_request", id, session }
      : null;
  }
  if (record["type"] === "presence_request") {
    const id = record["id"];
    const session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "presence_request", id, session }
      : null;
  }
  if (record["type"] === "client_presence") {
    const deviceId = record["deviceId"], state = record["state"];
    return typeof deviceId === "string" && deviceId.length > 0 && (state === "foreground" || state === "background")
      ? { type: "client_presence", deviceId, state } : null;
  }
  if (record["type"] === "presence_pong") {
    const id = record["id"];
    return typeof id === "string" && id.length > 0 ? { type: "presence_pong", id } : null;
  }
  if (record["type"] === "push_device_register") {
    const id = record["id"];
    let payload: ControlMessage | null = null;
    try {
      payload = decodeControlMessage(JSON.stringify(record["payload"]));
    } catch {
      payload = null;
    }
    return typeof id === "string" && id.length > 0 && payload?.type === "push_register"
      ? { type: "push_device_register", id, payload } : null;
  }
  if (record["type"] === "push_device_unregister") {
    const id = record["id"], deviceId = record["deviceId"];
    return typeof id === "string" && id.length > 0 && typeof deviceId === "string"
      ? { type: "push_device_unregister", id, deviceId } : null;
  }
  if (record["type"] === "push_request") {
    const id = record["id"];
    const event = parseHubPushEvent(record["event"]);
    return typeof id === "string" && id.length > 0 && event !== null ? { type: "push_request", id, event } : null;
  }
  if (record["type"] === "question_answer_submit") {
    const id = record["id"], session = record["session"], questionId = record["questionId"], answers = record["answers"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof questionId === "string" && questionId.length > 0 && Array.isArray(answers)
      ? { type: "question_answer_submit", id, session, questionId, answers: answers as QuestionAnswer[] } : null;
  }
  if (record["type"] === "input_claim") {
    const id = record["id"], session = record["session"], clientMessageId = record["clientMessageId"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof clientMessageId === "string" && clientMessageId.length > 0
      ? { type: "input_claim", id, session, clientMessageId } : null;
  }
  if (record["type"] === "codex_turn_submit") {
    const id = record["id"], session = record["session"], text = record["text"];
    const clientUserMessageId = record["clientUserMessageId"], effort = record["effort"];
    const approvalPolicy = record["approvalPolicy"] ?? null;
    const sandbox = record["sandbox"], threadId = record["threadId"], cwd = record["cwd"];
    const explicitRetry = record["explicitRetry"];
    const collaborationMode = record["collaborationMode"] ?? null;
    const validSandbox = sandbox === null || sandbox === "read-only" ||
      sandbox === "workspace-write" || sandbox === "danger-full-access";
    const validApprovalPolicy = approvalPolicy === null || approvalPolicy === "untrusted" ||
      approvalPolicy === "on-request" || approvalPolicy === "never";
    const validCollaborationMode = collaborationMode === null || collaborationMode === "plan" ||
      collaborationMode === "default";
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof text === "string" && typeof clientUserMessageId === "string" && clientUserMessageId.length > 0 &&
      (effort === null || typeof effort === "string") && validApprovalPolicy && validSandbox &&
      validCollaborationMode &&
      typeof threadId === "string" && threadId.length > 0 && typeof cwd === "string" && cwd.length > 0 &&
      (explicitRetry === undefined || typeof explicitRetry === "boolean")
      ? { type: "codex_turn_submit", id, session, text, clientUserMessageId,
          effort: effort as string | null,
          approvalPolicy: approvalPolicy as "untrusted" | "on-request" | "never" | null,
          sandbox: sandbox as "read-only" | "workspace-write" | "danger-full-access" | null,
          threadId, cwd, ...(explicitRetry === true ? { explicitRetry: true } : {}),
          ...(collaborationMode !== null ? { collaborationMode: collaborationMode as CodexCollaborationMode } : {}) }
      : null;
  }
  if (record["type"] === "codex_goal_submit") {
    const id = record["id"], session = record["session"], threadId = record["threadId"], cwd = record["cwd"];
    const action = record["action"], objective = record["objective"], status = record["status"];
    const tokenBudget = record["tokenBudget"];
    const validAction = action === "get" || action === "set" || action === "clear";
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof threadId === "string" && threadId.length > 0 && typeof cwd === "string" && cwd.length > 0 &&
      validAction &&
      (objective === undefined || typeof objective === "string") &&
      (status === undefined || typeof status === "string") &&
      (tokenBudget === undefined || (typeof tokenBudget === "number" && Number.isFinite(tokenBudget)))
      ? { type: "codex_goal_submit", id, session, threadId, cwd, action: action as CodexGoalAction,
          ...(typeof objective === "string" ? { objective } : {}),
          ...(typeof status === "string" ? { status } : {}),
          ...(typeof tokenBudget === "number" ? { tokenBudget } : {}) }
      : null;
  }
  if (record["type"] === "api_agent_open") {
    const id = record["id"], session = record["session"], conversationId = record["conversationId"], cwd = record["cwd"];
    const config = parseApiAgentConfig(record["config"]);
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof conversationId === "string" && conversationId.length > 0 && typeof cwd === "string" && cwd.length > 0 &&
      typeof record["resume"] === "boolean" && config !== null
      ? { type: "api_agent_open", id, session, conversationId, cwd, config, resume: record["resume"] }
      : null;
  }
  if (record["type"] === "api_agent_configure") {
    const id = record["id"], session = record["session"];
    const config = parseApiAgentConfig(record["config"]);
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 && config !== null
      ? { type: "api_agent_configure", id, session, config }
      : null;
  }
  if (record["type"] === "api_agent_interrupt" || record["type"] === "api_agent_close") {
    const id = record["id"], session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: record["type"], id, session }
      : null;
  }
  if (record["type"] === "codex_turn_interrupt") {
    const id = record["id"], session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "codex_turn_interrupt", id, session }
      : null;
  }
  if (record["type"] === "chat_send") {
    const id = record["id"], session = record["session"], clientMessageId = record["clientMessageId"];
    const text = record["text"], explicitRetry = record["explicitRetry"];
    const cancelQuestionId = record["cancelQuestionId"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof clientMessageId === "string" && clientMessageId.length > 0 && typeof text === "string" && text.length > 0 &&
      (explicitRetry === undefined || typeof explicitRetry === "boolean") &&
      (cancelQuestionId === undefined ||
        (typeof cancelQuestionId === "string" && cancelQuestionId.length > 0))
      ? { type: "chat_send", id, session, clientMessageId, text,
          ...(explicitRetry === true ? { explicitRetry: true } : {}),
          ...(cancelQuestionId !== undefined ? { cancelQuestionId } : {}) }
      : null;
  }
  if (record["type"] === "pending_message_delete") {
    const id = record["id"], session = record["session"];
    const clientMessageId = record["clientMessageId"], kind = record["kind"];
    return typeof id === "string" && id.length > 0 &&
      typeof session === "string" && session.length > 0 &&
      typeof clientMessageId === "string" && clientMessageId.length > 0 &&
      (kind === "chat" || kind === "codex")
      ? { type: "pending_message_delete", id, session, clientMessageId, kind }
      : null;
  }
  if (record["type"] === "chat_receipt_query") {
    const id = record["id"], session = record["session"], clientMessageId = record["clientMessageId"];
    return typeof id === "string" && id.length > 0 &&
      typeof session === "string" && session.length > 0 &&
      typeof clientMessageId === "string" && clientMessageId.length > 0
      ? { type: "chat_receipt_query", id, session, clientMessageId }
      : null;
  }
  if (record["type"] === "subagent_control") {
    const id = record["id"], session = record["session"], action = record["action"];
    const nodeId = record["nodeId"], text = record["text"];
    if (typeof id !== "string" || id.length === 0 || typeof session !== "string" || session.length === 0 ||
      !isSubagentControlAction(action)) return null;
    return {
      type: "subagent_control", id, session, action,
      ...(typeof nodeId === "string" && nodeId.length > 0 ? { nodeId } : {}),
      ...(typeof text === "string" ? { text } : {}),
    };
  }
  if (record["type"] === "background_command_stop") {
    const id = record["id"], session = record["session"], nodeId = record["nodeId"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof nodeId === "string" && nodeId.length > 0
      ? { type: "background_command_stop", id, session, nodeId }
      : null;
  }
  if (record["type"] === "chat_send_now") {
    const id = record["id"], session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "chat_send_now", id, session }
      : null;
  }
  if (record["type"] === "runtime_claim") {
    const id = record["id"], session = record["session"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0
      ? { type: "runtime_claim", id, session } : null;
  }
  if (record["type"] === "runtime_claim_release") {
    const session = record["session"];
    return typeof session === "string" && session.length > 0 ? { type: "runtime_claim_release", session } : null;
  }
  if (record["type"] === "session_preview_watch") {
    const enabled = record["enabled"];
    return typeof enabled === "boolean" ? { type: "session_preview_watch", enabled } : null;
  }
  return decodeProcessing(record);
}

/** `push_request.event` の検証（種別・会話名は必須。本文は上限で切る）。 */
function parseHubPushEvent(value: unknown): HubPushEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw["kind"], session = raw["session"], id = raw["id"], body = raw["body"], tool = raw["tool"];
  if (!PUSH_KINDS.includes(kind as PushKind) || typeof session !== "string" || session.length === 0) return null;
  if ((id !== undefined && typeof id !== "string") || (body !== undefined && typeof body !== "string") ||
    (tool !== undefined && typeof tool !== "string")) return null;
  return {
    kind: kind as PushKind,
    session,
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof body === "string" ? { body: [...body].slice(0, HUB_PUSH_BODY_MAX_CHARS).join("") } : {}),
    ...(typeof tool === "string" ? { tool } : {}),
  };
}

/** `codex_goal_result.goal` の検証。形が違えば null（行ごと捨てる）。 */
function parseCodexGoal(value: unknown): CodexGoalInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const isNumber = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isFinite(candidate);
  const threadId = raw["threadId"], objective = raw["objective"], status = raw["status"];
  const tokenBudget = raw["tokenBudget"], tokensUsed = raw["tokensUsed"];
  const timeUsedSeconds = raw["timeUsedSeconds"], createdAt = raw["createdAt"], updatedAt = raw["updatedAt"];
  if (typeof threadId !== "string" || typeof objective !== "string" || typeof status !== "string" ||
    !isNumber(tokensUsed) || !isNumber(timeUsedSeconds) || !isNumber(createdAt) || !isNumber(updatedAt) ||
    (tokenBudget !== undefined && !isNumber(tokenBudget))) return null;
  return { threadId, objective, status, ...(isNumber(tokenBudget) ? { tokenBudget } : {}),
    tokensUsed, timeUsedSeconds, createdAt, updatedAt };
}

export function decodeHubServerLine(line: string): HubServerMessage | null {
  const record = parseRecord(line);
  if (record === null) return null;
  if (record["type"] === "hub_hello_ack") {
    const version = record["version"];
    const bootId = record["bootId"];
    const rawProcessingSessions = record["processingSessions"];
    if (!((version === null || typeof version === "string") &&
      typeof bootId === "string" && bootId.length > 0)) return null;
    // 旧 Hub の hello ack には processingSessions が無い。「処理中なし」とは区別して
    // engine 側の既知状態を維持し、ローリング更新中の背景購読を誤解除しない。
    // 将来版や一時的な破損で不正要素が混ざっても hello 全体を捨てない。有効な会話だけを
    // 採用し、型自体が配列でない場合は旧 Hub 相当（snapshot 未提供）として扱う。
    const processingSessions = rawProcessingSessions === undefined || !Array.isArray(rawProcessingSessions)
      ? undefined
      : rawProcessingSessions.filter(
        (session): session is string => typeof session === "string" && session.length > 0,
      );
    // 設問の snapshot も同じ方針: 旧 Hub（欄なし）は「snapshot 未提供」、不正な要素だけ捨てる。
    const rawPendingQuestions = record["pendingQuestions"];
    const pendingQuestions = rawPendingQuestions === undefined || !Array.isArray(rawPendingQuestions)
      ? undefined
      : rawPendingQuestions.filter(isPendingQuestionSnapshotEntry);
    return {
      type: "hub_hello_ack",
      version,
      bootId,
      ...(processingSessions !== undefined ? { processingSessions } : {}),
      ...(pendingQuestions !== undefined ? { pendingQuestions } : {}),
      ...(record["resumeHint"] === true ? { resumeHint: true as const } : {}),
    };
  }
  if (record["type"] === "session_agents") {
    const rawItems = record["items"];
    if (!Array.isArray(rawItems)) return null;
    const items = rawItems.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const entry = item as Record<string, unknown>;
      const session = entry["session"], running = entry["running"];
      return typeof session === "string" && session.length > 0 && typeof running === "number" &&
        Number.isInteger(running) && running >= 0 ? [{ session, running }] : [];
    });
    return { type: "session_agents", items, ...(record["replace"] === true ? { replace: true } : {}) };
  }
  if (record["type"] === "hub_state_response") {
    const id = record["id"];
    const session = record["session"];
    const pending = record["pendingQuestion"];
    if (typeof id !== "string" || typeof session !== "string" || typeof record["processing"] !== "boolean") return null;
    if (pending !== null && !isPendingQuestion(pending)) return null;
    return { type: "hub_state_response", id, session, pendingQuestion: pending, processing: record["processing"] };
  }
  if (record["type"] === "presence_ping") {
    const id = record["id"];
    return typeof id === "string" && id.length > 0 ? { type: "presence_ping", id } : null;
  }
  if (record["type"] === "push_device_register_result") {
    const id = record["id"], status = record["status"], transport = record["transport"];
    const capabilityInvalid = record["capabilityInvalid"], error = record["error"];
    if (typeof id !== "string" || (status !== "ok" && status !== "failed") ||
      (transport !== "relay" && transport !== "direct" && transport !== "none")) return null;
    return {
      type: "push_device_register_result", id, status, transport,
      ...(capabilityInvalid === true ? { capabilityInvalid: true } : {}),
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  if (record["type"] === "push_device_unregister_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "ok" || status === "failed")
      ? { type: "push_device_unregister_result", id, status } : null;
  }
  if (record["type"] === "push_request_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "accepted" || status === "unavailable")
      ? { type: "push_request_result", id, status } : null;
  }
  if (record["type"] === "presence_response") {
    const id = record["id"];
    const session = record["session"];
    const subscriberCount = record["subscriberCount"];
    return typeof id === "string" && id.length > 0 && typeof session === "string" && session.length > 0 &&
      typeof subscriberCount === "number" && Number.isInteger(subscriberCount) && subscriberCount >= 0
      ? { type: "presence_response", id, session, subscriberCount }
      : null;
  }
  if (record["type"] === "question_answer_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" &&
      (status === "accepted" || status === "already_resolved" || status === "unknown" || status === "stale")
      ? { type: "question_answer_result", id, status } : null;
  }
  if (record["type"] === "input_claim_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "granted" || status === "duplicate")
      ? { type: "input_claim_result", id, status } : null;
  }
  if (record["type"] === "api_agent_result") {
    const id = record["id"], status = record["status"], error = record["error"], interrupted = record["interrupted"];
    if (typeof id !== "string" || (status !== "ok" && status !== "failed") ||
      (error !== undefined && (typeof error !== "string" || !Object.hasOwn(API_AGENT_ERROR_MESSAGES, error))) ||
      (interrupted !== undefined && typeof interrupted !== "boolean")) return null;
    return { type: "api_agent_result", id, status,
      ...(typeof error === "string" ? { error: error as ApiAgentErrorCode } : {}),
      ...(typeof interrupted === "boolean" ? { interrupted } : {}) };
  }
  if (record["type"] === "codex_turn_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" || (status !== "started" && status !== "duplicate" && status !== "failed") ||
      (error !== undefined && typeof error !== "string")) return null;
    return { type: "codex_turn_result", id, status, ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "codex_goal_result") {
    const id = record["id"], status = record["status"], error = record["error"], cleared = record["cleared"];
    if (typeof id !== "string" || (status !== "ok" && status !== "failed") ||
      (error !== undefined && typeof error !== "string") ||
      (cleared !== undefined && typeof cleared !== "boolean")) return null;
    const goal = record["goal"] === undefined ? undefined : parseCodexGoal(record["goal"]);
    if (goal === null) return null;
    return { type: "codex_goal_result", id, status,
      ...(goal !== undefined ? { goal } : {}),
      ...(typeof cleared === "boolean" ? { cleared } : {}),
      ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "chat_send_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" || (status !== "accepted" && status !== "duplicate" && status !== "failed") ||
      (error !== undefined && typeof error !== "string")) return null;
    return { type: "chat_send_result", id, status, ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "pending_message_delete_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" ||
      (status !== "deleted" && status !== "not_found" &&
        status !== "processing" && status !== "failed") ||
      (error !== undefined && typeof error !== "string")) return null;
    return {
      type: "pending_message_delete_result",
      id,
      status,
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  if (record["type"] === "chat_receipt_query_result") {
    const id = record["id"], status = record["status"];
    if (typeof id !== "string" ||
      (status !== "delivered" && status !== "deleted" && status !== "uncertain" &&
        status !== "pending" && status !== "unknown")) return null;
    return { type: "chat_receipt_query_result", id, status };
  }
  if (record["type"] === "subagent_control_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" || !isSubagentControlStatus(status) ||
      (error !== undefined && typeof error !== "string")) return null;
    return { type: "subagent_control_result", id, status, ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "background_command_stop_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" || !isBackgroundCommandStopStatus(status) ||
      (error !== undefined && typeof error !== "string")) return null;
    return { type: "background_command_stop_result", id, status, ...(typeof error === "string" ? { error } : {}) };
  }
  if (record["type"] === "chat_send_now_result") {
    const id = record["id"], status = record["status"], error = record["error"];
    if (typeof id !== "string" ||
      (status !== "sent" && status !== "nothing_queued" &&
        status !== "blocked" && status !== "failed") ||
      (error !== undefined && typeof error !== "string")) return null;
    return {
      type: "chat_send_now_result",
      id,
      status,
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  if (record["type"] === "runtime_claim_result") {
    const id = record["id"], status = record["status"];
    return typeof id === "string" && (status === "granted" || status === "held")
      ? { type: "runtime_claim_result", id, status } : null;
  }
  if (record["type"] === "conversation_subagent_transcript_response") {
    const id = record["id"];
    const session = record["session"];
    if (typeof id !== "string" || id.length === 0 ||
      typeof session !== "string" || session.length === 0) return null;
    const payload = decodeHubControlPayload(record["payload"]);
    if (payload === null) return null;
    return payload.type === "subagent_transcript_response" && payload.id === id
      ? { type: record["type"], id, session, payload }
      : null;
  }
  if (record["type"] === "conversation_history_page_response") {
    const id = record["id"], session = record["session"], lines = record["lines"];
    const hasMore = record["hasMore"], hostNowMs = record["hostNowMs"], failed = record["failed"];
    const anchorMissing = record["anchorMissing"];
    if (typeof id !== "string" || id.length === 0 || typeof session !== "string" || session.length === 0 ||
      !Array.isArray(lines) || !lines.every((line) => typeof line === "string") ||
      typeof hasMore !== "boolean" || typeof hostNowMs !== "number" ||
      (failed !== undefined && typeof failed !== "boolean") ||
      (anchorMissing !== undefined && typeof anchorMissing !== "boolean")) return null;
    return { type: "conversation_history_page_response", id, session, lines: lines as string[], hasMore, hostNowMs,
      ...(failed === true ? { failed: true } : {}),
      ...(anchorMissing === true ? { anchorMissing: true } : {}) };
  }
  if (record["type"] === "conversation_liveness") {
    // live-pill Phase 2: 死亡だけを配る（alive:true は送らない設計上の割り切り）。
    const session = record["session"];
    return typeof session === "string" && session.length > 0 && record["alive"] === false
      ? { type: "conversation_liveness", session, alive: false }
      : null;
  }
  if (record["type"] === "conversation_retired") {
    const session = record["session"];
    return typeof session === "string" && session.length > 0
      ? { type: "conversation_retired", session }
      : null;
  }
  if (record["type"] === "conversation_event" || record["type"] === "conversation_pane_preview" ||
    record["type"] === "conversation_mode") {
    const session = record["session"];
    if (typeof session !== "string" || session.length === 0) return null;
    const payload = decodeHubControlPayload(record["payload"]);
    if (payload === null) return null;
    if (record["type"] === "conversation_pane_preview") {
      // pane_preview 封筒は pane_preview 本体に加え、pump が同じ writer で流す input_suggestion
      // （プロンプト提案チップ）も運ぶ。ここを pane_preview 限定にすると提案が hub→engine 境界で
      // 落ち、iOS に届かない（prompt-suggestion-chip 配信の実体）。
      // 入力欄に残った文字の通知（input_residue）も同じ pump が流す。
      return payload.type === "pane_preview" || payload.type === "input_suggestion" ||
        payload.type === "input_residue"
        ? { type: record["type"], session, payload }
        : null;
    }
    if (record["type"] === "conversation_mode") {
      return payload.type === "mode_set_response" ? { type: record["type"], session, payload } : null;
    }
    const serverSeq = record["serverSeq"];
    return typeof serverSeq === "number" && Number.isInteger(serverSeq) && serverSeq >= 0
      ? { type: record["type"], session, serverSeq, payload } : null;
  }
  return decodeRelay(record);
}

/**
 * Hub envelope 内の ControlMessage を復元する。
 *
 * 現行 Hub は canonical flat wire を送る。一世代前の Hub は TypeScript の内部表現を
 * JSON.stringify していたため、tool_activity.activity / subagent_node.node だけ nested だった。
 * engine と daemon のローリング更新中にそれらを捨てないよう、Hub 内部境界に限って旧形を
 * flat へ正規化する。外向け ControlMessage decoder の厳格な wire 契約は緩めない。
 */
function decodeHubControlPayload(value: unknown): ControlMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  try {
    return decodeControlMessage(encoded);
  } catch {
    // legacy nested payload は下で限定的に正規化する。
  }
  const record = value as Record<string, unknown>;
  const nestedKey = record["type"] === "tool_activity" || record["type"] === "session_tool_activity"
    ? "activity"
    : record["type"] === "subagent_node" ? "node" : null;
  if (nestedKey === null) return null;
  const nested = record[nestedKey];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return null;
  const flattened: Record<string, unknown> = {
    ...record,
    ...nested as Record<string, unknown>,
    type: record["type"],
  };
  delete flattened[nestedKey];
  if (record["v"] !== undefined) flattened["v"] = record["v"];
  else delete flattened["v"];
  try {
    return decodeControlMessage(JSON.stringify(flattened));
  } catch {
    return null;
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function decodeProcessing(record: Record<string, unknown>): SessionProcessingMessage | null {
  const session = record["session"];
  const state = record["state"];
  const event = record["event"];
  const atMs = record["atMs"];
  return record["type"] === "session_processing" && typeof session === "string" && session.length > 0 &&
    (state === "active" || state === "done")
    ? {
      type: "session_processing", session, state,
      ...(typeof event === "string" ? { event } : {}),
      ...(typeof atMs === "number" && Number.isFinite(atMs) ? { atMs } : {}),
    }
    : null;
}

function decodeRelay(record: Record<string, unknown>): EngineRelayMessage | null {
  const processing = decodeProcessing(record);
  if (processing !== null) return processing;
  const type = record["type"];
  const session = record["session"];
  const id = record["id"];
  if (typeof session !== "string" || !session || typeof id !== "string" || !id) return null;
  if (type === "question_event") {
    const event = record["event"];
    if (event === "dismiss") return { type, session, id, event };
    if (event === "prompt" && Array.isArray(record["questions"]) && record["questions"].length > 0) {
      return { type, session, id, event, questions: record["questions"] as QuestionPromptQuestion[] };
    }
    return null;
  }
  const kind = record["kind"];
  if (kind !== "question" && kind !== "approval") return null;
  if (type === "remote_pending_cleared") return { type, v: numberOrOne(record["v"]), id, session, kind };
  if (type === "remote_pending" && typeof record["summary"] === "string") {
    return { type, v: numberOrOne(record["v"]), id, session, kind,
      ...(typeof record["tool"] === "string" ? { tool: record["tool"] } : {}), summary: record["summary"] };
  }
  return null;
}

function isPendingQuestion(value: unknown): value is { id: string; questions: QuestionPromptQuestion[] } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["id"] === "string" && Array.isArray(record["questions"]);
}

function isPendingQuestionSnapshotEntry(value: unknown): value is PendingQuestionSnapshotEntry {
  if (!isPendingQuestion(value) || value.id.length === 0) return false;
  const session = (value as unknown as Record<string, unknown>)["session"];
  return typeof session === "string" && session.length > 0;
}

function numberOrOne(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function optionalNonnegativeNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
