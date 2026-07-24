// sessionHub.ts
// tailii (TS host) — connection 非依存 Session Hub コア。

import type { ReaperTickOptions, ReaperTickResult } from "./reaper.js";
import { reaperTick } from "./reaper.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { bumpHeartbeat, listHeartbeatSessions, readHeartbeat, writeHeartbeat } from "./heartbeat.js";
import { ensureDirectory0700 } from "./paths.js";
import type { EngineRelayMessage } from "./engineRelaySocket.js";
import {
  decodeHubClientLine,
  encodeHubMessage,
  type HubClientMessage,
  type HubServerMessage,
} from "./hubProtocol.js";
import type {
  ControlMessage,
  QuestionPromptQuestion,
  SubagentTranscriptEntry,
} from "./protocol.js";
import { HISTORY_DONE_STREAM_ID } from "./transcriptTailer.js";
import type { ChatAgent } from "./chatTailController.js";
import type { PanePreviewMode } from "./panePreviewPump.js";
import type { QuestionAnswer } from "./protocol.js";
import { PROTOCOL_V1, PROTOCOL_V2 } from "./protocol.js";
import { CodexAppServerManager } from "./codexAppServer.js";
import {
  CodexNativeTurnController,
  chatContentKey,
  type CodexAppServerThreadRuntime,
  type CodexNativeTurnControllerOptions,
  type CodexTurnControllerRuntime,
} from "./codexNativeTurnController.js";
import {
  CONTEXT_STREAM_ID as CODEX_CONTEXT_STREAM_ID,
  CONTEXT_WINDOW_STREAM_ID as CODEX_CONTEXT_WINDOW_STREAM_ID,
  MODEL_STREAM_ID as CODEX_MODEL_STREAM_ID,
} from "./codexRolloutTailer.js";
import type { SessionMeta } from "./sessionMetadataStore.js";

export interface HubTail {
  open(cwd: string, preferredSessionId: string | null, newerThanMs?: number | null, agent?: ChatAgent): void;
  stop(): void;
  subagentTranscript?(nodeId: string): {
    entries: SubagentTranscriptEntry[];
    omitted: number;
  };
}

export interface HubPreviewPump {
  start(session: string, mode?: PanePreviewMode): void;
  stop(): void;
}

export type HubTailFactory = (write: (payload: ControlMessage) => void) => HubTail;
export type HubPreviewPumpFactory = (
  write: (payload: ControlMessage) => void,
  onPermissionMode?: (mode: string) => void,
) => HubPreviewPump;

export type SessionHubOptions = Omit<ReaperTickOptions, "now"> & {
  /** Unix 秒。テストでは固定時計を注入する。 */
  now?: () => number;
  tailFactory?: HubTailFactory;
  previewPumpFactory?: HubPreviewPumpFactory;
  replayLimit?: number;
  questionInjector?: (answers: QuestionAnswer[], session: string) => Promise<void>;
  chatInjector?: (text: string, session: string) => Promise<void>;
  codexAppServerFactory?: () => CodexAppServerThreadRuntime;
  codexTurnControllerFactory?: (options: CodexNativeTurnControllerOptions) => CodexTurnControllerRuntime;
  /** 未回答設問の永続化先。省略時は永続化しない（daemon は既定パスを明示する）。 */
  pendingQuestionsPath?: string;
  /** chat_send の durable queue / 配送済み receipt。daemon は既定パスを明示する。 */
  chatReceiptsPath?: string;
  /** receipt 永続化のテスト注入口。省略時は atomic rename を使う。 */
  chatReceiptsWriter?: (target: string, contents: string) => void;
};

type PendingQuestion = NonNullable<SessionActor["pendingQuestion"]>;

interface SubscriberState { preview: boolean; backfilling: boolean }
interface ReplayEvent { serverSeq: number; payload: ControlMessage }
interface PendingChatSend {
  message: Extract<HubClientMessage, { type: "chat_send" }>;
  waiters: Array<{ client: object; id: string }>;
}
interface PendingCodexTurn {
  message: Extract<HubClientMessage, { type: "codex_turn_submit" }>;
  waiters: Array<{ client: object; id: string }>;
}
const DELIVERED_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DELIVERED_RECEIPTS_PER_SESSION = 10_000;
interface CodexBufferedItem { itemId: string; payload: ControlMessage }
interface CodexLiveState {
  phase: "starting" | "backfill" | "live" | "fallback-scan" | "fallback-live";
  initialItemIds: ReadonlySet<string>;
  initialContentCounts: ReadonlyMap<string, number>;
  buffered: CodexBufferedItem[];
  seenItemIds: Set<string>;
  /** backfill と fallback の同文複数回を occurrence 単位で照合する。 */
  publishedContentCounts: Map<string, number>;
  scanContentCounts: Map<string, number>;
  fallbackBaselineCounts: Map<string, number>;
  disconnected: boolean;
}
interface SessionActor {
  pendingQuestion: {
    id: string;
    questions: QuestionPromptQuestion[];
    answerRoute: "tui" | "codex_native";
  } | null;
  processingSince: number | null;
  focusedBy: Set<object>;
  subscribers: Map<object, SubscriberState>;
  nextServerSeq: number;
  replayBuffer: ReplayEvent[];
  tail: HubTail | null;
  tailRetryTimer: ReturnType<typeof setTimeout> | null;
  previewPump: HubPreviewPump | null;
  backfillTails: Map<object, HubTail>;
  seenClientMessageIds: Set<string>;
  deliveredChatMessageIds: Map<string, number>;
  deliveredCodexMessageIds: Map<string, number>;
  pendingChatMessages: Map<string, PendingChatSend>;
  injectingChatMessageIds: Set<string>;
  uncertainChatMessages: Map<string, Extract<HubClientMessage, { type: "chat_send" }>>;
  uncertainCodexMessages: Map<string, Extract<HubClientMessage, { type: "codex_turn_submit" }>>;
  pendingCodexTurns: Map<string, PendingCodexTurn>;
  startingCodexMessageIds: Set<string>;
  runtimeClaim: { client: object; expiresAt: number } | null;
  codexLive: CodexLiveState | null;
  chatQueue: PendingChatSend[];
  chatOrder: string[];
  chatDrainRunning: boolean;
  chatDrainBlocked: boolean;
  codexQueue: PendingCodexTurn[];
  codexOrder: string[];
  codexDrainRunning: boolean;
  codexDrainBlocked: boolean;
}

export class SessionHub {
  private readonly clients = new Map<object, (line: string) => void>();
  readonly actors = new Map<string, SessionActor>();
  private readonly now: () => number;
  private readonly replayLimit: number;
  private injectionsInFlight = 0;
  private codexStartsInFlight = 0;
  private modePushSeq = 0;
  private chatReceiptsDirty = false;
  private readonly activeCodexTurns = new Set<string>();
  private codexTurnController: CodexTurnControllerRuntime | null = null;

  constructor(private readonly options: SessionHubOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.replayLimit = options.replayLimit ?? 500;
  }

  get clientCount(): number { return this.clients.size; }
  get hasPendingQuestions(): boolean {
    return [...this.actors.values()].some((actor) => actor.pendingQuestion !== null);
  }
  get hasInjectionsInFlight(): boolean { return this.injectionsInFlight > 0; }
  get hasCodexTurnsInFlight(): boolean {
    return this.codexStartsInFlight > 0 || this.activeCodexTurns.size > 0;
  }
  /** 新しく接続した engine が処理中会話を直ちに購読するための軽量スナップショット。 */
  get processingSessionNames(): string[] {
    return [...this.actors]
      .filter(([, actor]) => actor.processingSince !== null)
      .map(([session]) => session);
  }

  /** Hub 再起動前から active の heartbeat を actor の処理中状態へ戻す。 */
  restoreFromHeartbeats(): void {
    for (const session of listHeartbeatSessions(this.options.heartbeatDir)) {
      const heartbeat = readHeartbeat(this.options.heartbeatDir, session);
      if (heartbeat?.state !== "active") continue;
      // codex の turn は hub 内 controller と運命共同体で、再起動を越えた active は駆動者を
      // 失った死んだ turn。復元して bump すると「bump 停止=ターン死亡」の reaper シグナルが
      // 壊れて kill されなくなるため復元しない(reaper.ts 冒頭の設計原則)。
      if (this.options.metadataStore.get(session)?.agent === "codex") continue;
      // 鮮度切れの active はクラッシュ残骸。復元すると tick の bump で計時が止まるため捨てる
      // (稼働中の hub は毎 tick bump しているので、直前まで生きていた heartbeat は必ず新しい)。
      if (this.now() - heartbeat.ts >= this.options.timeoutSeconds) continue;
      this.actor(session).processingSince = heartbeat.ts;
    }
  }

  /** 永続化済み設問を復元する。App Server の request handle は再起動を越せないため TUI のみ対象。 */
  restorePendingQuestions(): void {
    const restored = this.readPendingQuestions();
    let changed = false;
    for (const [session, pending] of Object.entries(restored)) {
      if (pending.answerRoute === "codex_native") {
        changed = true;
        this.broadcast({ type: "question_event", session, event: "dismiss", id: pending.id });
        continue;
      }
      this.actor(session).pendingQuestion = pending;
    }
    if (changed) this.persistPendingQuestions();
  }

  /** daemon 再起動前に durable enqueue 済みだった chat_send と receipt を復元する。 */
  restoreChatReceipts(): void {
    const persisted = this.readChatReceipts();
    let discardedStaleSession = false;
    for (const [session, state] of Object.entries(persisted)) {
      const currentSessionIdentity = receiptSessionIdentity(this.options.metadataStore.get(session));
      if (state.sessionIdentity !== undefined && state.sessionIdentity !== currentSessionIdentity) {
        // session 名は再利用される。旧世代の durable queue を同名の新 pane へ注入しない。
        // metadata が消失・破損した場合も identity を証明できないため安全側で破棄する。
        discardedStaleSession = true;
        this.options.log?.(`stale chat receipt 破棄 session=${session}`);
        continue;
      }
      const actor = this.actor(session);
      const restoredAt = Date.now();
      for (const clientMessageId of state.delivered) {
        actor.deliveredChatMessageIds.set(
          clientMessageId, state.deliveredAtMs?.[clientMessageId] ?? restoredAt,
        );
      }
      for (const clientMessageId of state.deliveredCodex) {
        actor.deliveredCodexMessageIds.set(
          clientMessageId, state.deliveredCodexAtMs?.[clientMessageId] ?? restoredAt,
        );
      }
      compactDeliveredReceipts(actor.deliveredChatMessageIds, restoredAt);
      compactDeliveredReceipts(actor.deliveredCodexMessageIds, restoredAt);
      for (const message of state.queued) {
        if (hasDeliveredReceipt(actor.deliveredChatMessageIds, message.clientMessageId, restoredAt) ||
          actor.pendingChatMessages.has(message.clientMessageId)) continue;
        const entry: PendingChatSend = { message, waiters: [] };
        actor.pendingChatMessages.set(message.clientMessageId, entry);
        actor.chatQueue.push(entry);
      }
      for (const message of state.injecting) {
        if (!hasDeliveredReceipt(actor.deliveredChatMessageIds, message.clientMessageId, restoredAt)) {
          // crash 時点で tmux 注入の前後を判定できない。自動再注入は二重実行を生むため、
          // 同じ ID を uncertain として保持し、利用者起点の明示的な新規送信に委ねる。
          actor.uncertainChatMessages.set(message.clientMessageId, message);
        }
      }
      const chatIds = new Set([
        ...actor.uncertainChatMessages.keys(), ...actor.pendingChatMessages.keys(),
      ]);
      actor.chatOrder = restoreOrder(
        state.chatOrder,
        [...state.injecting.map((message) => message.clientMessageId),
          ...state.queued.map((message) => message.clientMessageId)],
        chatIds,
      );
      actor.chatQueue.sort((left, right) => actor.chatOrder.indexOf(left.message.clientMessageId) -
        actor.chatOrder.indexOf(right.message.clientMessageId));
      for (const message of state.queuedCodex ?? []) {
        if (hasDeliveredReceipt(actor.deliveredCodexMessageIds, message.clientUserMessageId, restoredAt) ||
          actor.pendingCodexTurns.has(message.clientUserMessageId)) continue;
        const entry: PendingCodexTurn = { message, waiters: [] };
        actor.pendingCodexTurns.set(message.clientUserMessageId, entry);
        actor.codexQueue.push(entry);
      }
      for (const message of state.startingCodex) {
        if (!hasDeliveredReceipt(actor.deliveredCodexMessageIds, message.clientUserMessageId, restoredAt)) {
          actor.uncertainCodexMessages.set(message.clientUserMessageId, message);
        }
      }
      const codexIds = new Set([
        ...actor.uncertainCodexMessages.keys(), ...actor.pendingCodexTurns.keys(),
      ]);
      actor.codexOrder = restoreOrder(
        state.codexOrder,
        [...state.startingCodex.map((message) => message.clientUserMessageId),
          ...(state.queuedCodex ?? []).map((message) => message.clientUserMessageId)],
        codexIds,
      );
      actor.codexQueue.sort((left, right) => actor.codexOrder.indexOf(left.message.clientUserMessageId) -
        actor.codexOrder.indexOf(right.message.clientUserMessageId));
      void this.drainChatQueue(session, actor);
      void this.drainCodexQueue(session, actor);
    }
    if (discardedStaleSession) this.persistChatReceipts();
  }

  registerClient(client: object, write: (line: string) => void): void { this.clients.set(client, write); }

  unregisterClient(client: object): void {
    this.clients.delete(client);
    for (const [session, actor] of this.actors) {
      actor.focusedBy.delete(client);
      if (actor.runtimeClaim?.client === client) actor.runtimeClaim = null;
      if (actor.subscribers.has(client)) this.unsubscribe(client, session, actor);
    }
  }

  broadcast(message: HubServerMessage): void {
    const line = encodeHubMessage(message);
    for (const write of this.clients.values()) {
      try { write(line); } catch { /* 切断検知は transport に任せる。 */ }
    }
  }

  sendTo(client: object, message: HubServerMessage): void {
    try { this.clients.get(client)?.(encodeHubMessage(message)); } catch { /* 同上。 */ }
  }

  handleRelayMessage(message: EngineRelayMessage): void {
    if (message.type === "question_event") {
      const actor = this.actor(message.session);
      this.setPendingQuestion(message.session, actor, message.event === "prompt"
        ? { id: message.id, questions: message.questions ?? [], answerRoute: "tui" } : null);
      if (message.event === "dismiss") void this.drainChatQueue(message.session, actor);
    } else if (message.type === "session_processing") this.applyProcessing(message.session, message.state);
    this.broadcast(message);
  }

  handleClientMessage(client: object, line: string): void {
    const message = decodeHubClientLine(line);
    if (message === null || message.type === "hub_hello") return;
    if (message.type === "conversation_subscribe") {
      // preview は後から加わった内部フラグ。省略する旧 engine は従来どおり前面購読として扱う。
      this.subscribe(client, message.session, message.afterSeq, message.newerThanMs, message.preview ?? true);
      return;
    }
    if (message.type === "conversation_unsubscribe") {
      const actor = this.actor(message.session);
      this.unsubscribe(client, message.session, actor);
      return;
    }
    if (message.type === "session_retire") {
      this.retireSession(message.session);
      return;
    }
    if (message.type === "conversation_subagent_transcript_request") {
      const actor = this.actors.get(message.session);
      const transcript = actor?.tail?.subagentTranscript?.(message.nodeId) ?? {
        entries: [],
        omitted: 0,
      };
      this.sendTo(client, {
        type: "conversation_subagent_transcript_response",
        id: message.id,
        session: message.session,
        payload: {
          type: "subagent_transcript_response",
          v: PROTOCOL_V2,
          id: message.id,
          nodeId: message.nodeId,
          entries: transcript.entries,
          omitted: transcript.omitted,
        },
      });
      return;
    }
    if (message.type === "hub_state_request") {
      const actor = this.actor(message.session);
      this.sendTo(client, { type: "hub_state_response", id: message.id, session: message.session,
        pendingQuestion: actor.pendingQuestion === null ? null : {
          id: actor.pendingQuestion.id, questions: actor.pendingQuestion.questions,
        }, processing: actor.processingSince !== null });
      return;
    }
    if (message.type === "presence_request") {
      const subscriberCount = this.actors.get(message.session)?.subscribers.size ?? 0;
      this.sendTo(client, {
        type: "presence_response",
        id: message.id,
        session: message.session,
        subscriberCount,
      });
      return;
    }
    if (message.type === "question_answer_submit") {
      const actor = this.actors.get(message.session);
      if (actor === undefined) {
        this.sendTo(client, { type: "question_answer_result", id: message.id, status: "unknown" });
      } else if (actor.pendingQuestion?.id !== message.questionId) {
        this.sendTo(client, { type: "question_answer_result", id: message.id, status: "already_resolved" });
      } else {
        // first-wins の判定と clear は await を挟まず同期的に行い、勝者だけが注入する。
        const answerRoute = actor.pendingQuestion.answerRoute;
        this.setPendingQuestion(message.session, actor, null);
        this.broadcast({ type: "question_event", session: message.session, event: "dismiss", id: message.questionId });
        this.sendTo(client, { type: "question_answer_result", id: message.id, status: "accepted" });
        if (answerRoute === "codex_native") {
          try {
            if (this.codexTurnController?.answerQuestion?.(message.questionId, message.answers) !== true) {
              this.options.log?.(`Codex native 設問回答失敗: pending 不在 (${message.questionId})`);
            }
          } catch (error) { this.options.log?.(`Codex native 設問回答失敗: ${String(error)}`); }
          void this.drainChatQueue(message.session, actor);
        } else {
          this.injectionsInFlight += 1;
          void (this.options.questionInjector?.(message.answers, message.session) ?? Promise.resolve())
            .catch((error) => this.options.log?.(`設問回答注入失敗: ${String(error)}`))
            .finally(() => {
              this.injectionsInFlight -= 1;
              void this.drainChatQueue(message.session, actor);
            });
        }
      }
      return;
    }
    if (message.type === "codex_turn_submit") {
      const actor = this.actor(message.session);
      if (hasDeliveredReceipt(actor.deliveredCodexMessageIds, message.clientUserMessageId)) {
        this.sendTo(client, { type: "codex_turn_result", id: message.id, status: "duplicate" });
        return;
      }
      const uncertain = actor.uncertainCodexMessages.get(message.clientUserMessageId);
      if (uncertain !== undefined) {
        if (message.explicitRetry !== true) {
          this.sendTo(client, {
            type: "codex_turn_result", id: message.id, status: "failed",
            error: "Previous Codex turn/start outcome is uncertain; explicit retry is required",
          });
          return;
        }
        if (actor.codexOrder[0] !== message.clientUserMessageId) {
          this.sendTo(client, {
            type: "codex_turn_result", id: message.id, status: "failed",
            error: "An earlier uncertain turn must be resolved first",
          });
          return;
        }
        if (!sameCodexRetry(uncertain, message)) {
          this.sendTo(client, {
            type: "codex_turn_result", id: message.id, status: "failed",
            error: "Explicit retry payload does not match the original turn",
          });
          return;
        }
        actor.uncertainCodexMessages.delete(message.clientUserMessageId);
        const retryEntry: PendingCodexTurn = { message, waiters: [{ client, id: message.id }] };
        actor.pendingCodexTurns.set(message.clientUserMessageId, retryEntry);
        actor.codexQueue.unshift(retryEntry);
        if (!this.persistChatReceipts()) {
          actor.codexQueue.shift();
          actor.pendingCodexTurns.delete(message.clientUserMessageId);
          actor.uncertainCodexMessages.set(message.clientUserMessageId, uncertain);
          this.sendTo(client, {
            type: "codex_turn_result", id: message.id, status: "failed",
            error: "Session Hub explicit Codex retry receipt write failed",
          });
          return;
        }
        actor.codexDrainBlocked = false;
        void this.drainCodexQueue(message.session, actor);
        return;
      }
      const pending = actor.pendingCodexTurns.get(message.clientUserMessageId);
      if (pending !== undefined) {
        pending.waiters.push({ client, id: message.id });
        actor.codexDrainBlocked = false;
        void this.drainCodexQueue(message.session, actor);
        return;
      }
      const entry: PendingCodexTurn = { message, waiters: [{ client, id: message.id }] };
      actor.pendingCodexTurns.set(message.clientUserMessageId, entry);
      actor.codexQueue.push(entry);
      actor.codexOrder.push(message.clientUserMessageId);
      if (!this.persistChatReceipts()) {
        actor.pendingCodexTurns.delete(message.clientUserMessageId);
        actor.codexQueue.pop();
        actor.codexOrder.pop();
        this.sendTo(client, {
          type: "codex_turn_result", id: message.id, status: "failed",
          error: "Session Hub Codex starting receipt write failed",
        });
        return;
      }
      actor.codexDrainBlocked = false;
      void this.drainCodexQueue(message.session, actor);
      return;
    }
    if (message.type === "codex_turn_interrupt") {
      void this.codexTurnController?.interruptTurn?.(message.session).catch((error) => {
        this.publishCodexMarker(
          message.session,
          `codex-interrupt-error-${message.id}`,
          `⚠️ Codex turn 中断失敗: ${String(error)}`,
        );
        this.options.log?.(`codex turn 中断失敗 session=${message.session}: ${String(error)}`);
      });
      return;
    }
    if (message.type === "chat_send") {
      const actor = this.actor(message.session);
      if (hasDeliveredReceipt(actor.deliveredChatMessageIds, message.clientMessageId)) {
        this.sendTo(client, { type: "chat_send_result", id: message.id, status: "duplicate" });
        return;
      }
      const uncertain = actor.uncertainChatMessages.get(message.clientMessageId);
      if (uncertain !== undefined) {
        if (message.explicitRetry !== true) {
          this.sendTo(client, {
            type: "chat_send_result", id: message.id, status: "failed",
            error: "Previous tmux injection outcome is uncertain; explicit retry is required",
          });
          return;
        }
        if (actor.chatOrder[0] !== message.clientMessageId) {
          this.sendTo(client, {
            type: "chat_send_result", id: message.id, status: "failed",
            error: "An earlier uncertain message must be resolved first",
          });
          return;
        }
        if (uncertain.text !== message.text) {
          this.sendTo(client, {
            type: "chat_send_result", id: message.id, status: "failed",
            error: "Explicit retry text does not match the original message",
          });
          return;
        }
        actor.uncertainChatMessages.delete(message.clientMessageId);
        const retryEntry: PendingChatSend = { message, waiters: [{ client, id: message.id }] };
        actor.pendingChatMessages.set(message.clientMessageId, retryEntry);
        actor.chatQueue.unshift(retryEntry);
        if (!this.persistChatReceipts()) {
          actor.chatQueue.shift();
          actor.pendingChatMessages.delete(message.clientMessageId);
          actor.uncertainChatMessages.set(message.clientMessageId, uncertain);
          this.sendTo(client, {
            type: "chat_send_result", id: message.id, status: "failed",
            error: "Session Hub explicit retry receipt write failed",
          });
          return;
        }
        actor.chatDrainBlocked = false;
        void this.drainChatQueue(message.session, actor);
        return;
      }
      const pending = actor.pendingChatMessages.get(message.clientMessageId);
      if (pending !== undefined) {
        if (pending.message.text !== message.text) {
          this.sendTo(client, {
            type: "chat_send_result", id: message.id, status: "failed",
            error: "Queued message payload does not match the original message",
          });
          return;
        }
        // durable queue 内の同一入力。まだ注入完了ではないため duplicate と確定せず、
        // 完了 ACK を待つ RPC waiter として合流させる。
        pending.waiters.push({ client, id: message.id });
        actor.chatDrainBlocked = false;
        void this.drainChatQueue(message.session, actor);
        return;
      }
      const entry: PendingChatSend = { message, waiters: [{ client, id: message.id }] };
      actor.pendingChatMessages.set(message.clientMessageId, entry);
      actor.chatQueue.push(entry);
      actor.chatOrder.push(message.clientMessageId);
      if (!this.persistChatReceipts()) {
        actor.pendingChatMessages.delete(message.clientMessageId);
        actor.chatQueue.pop();
        actor.chatOrder.pop();
        this.sendTo(client, {
          type: "chat_send_result", id: message.id, status: "failed",
          error: "Session Hub durable queue write failed",
          });
          return;
        }
      actor.chatDrainBlocked = false;
      void this.drainChatQueue(message.session, actor);
      return;
    }
    if (message.type === "input_claim") {
      const actor = this.actor(message.session);
      const duplicate = this.claimInput(actor, message.clientMessageId);
      this.sendTo(client, { type: "input_claim_result", id: message.id,
        status: duplicate ? "duplicate" : "granted" });
      return;
    }
    if (message.type === "runtime_claim") {
      const actor = this.actor(message.session);
      if (actor.runtimeClaim !== null && actor.runtimeClaim.expiresAt <= this.now()) actor.runtimeClaim = null;
      const granted = actor.runtimeClaim === null || actor.runtimeClaim.client === client;
      if (granted) actor.runtimeClaim = { client, expiresAt: this.now() + 15 };
      else this.options.log?.(
        `audit runtime_claim_held session=${auditValue(message.session)} holder_present=true`,
      );
      this.sendTo(client, { type: "runtime_claim_result", id: message.id, status: granted ? "granted" : "held" });
      return;
    }
    if (message.type === "runtime_claim_release") {
      const actor = this.actors.get(message.session);
      if (actor?.runtimeClaim?.client === client) actor.runtimeClaim = null;
      return;
    }
    this.applyProcessing(message.session, message.state);
    this.broadcast(message);
  }

  async tick(): Promise<ReaperTickResult> {
    for (const [session, actor] of this.actors) {
      if (actor.focusedBy.size > 0) this.bumpSafe(session, "hub-tick");
      if (actor.processingSince !== null) this.bumpSafe(session, "hub-processing", "active");
      if (actor.pendingQuestion !== null) this.bumpSafe(session, "hub-question", "active");
    }
    const result = await reaperTick({ ...this.options, now: this.now() });
    // reaper の判定と actor の処理中フラグを同期する。demote(プロセス死亡)や kill 後も
    // processingSince が残ると、tick の bump が ts を更新し続けて計時が永遠に進まない
    // (=ゾンビ tmux の不死化 / 死んだセッションの heartbeat 再生成)。
    for (const session of result.killed) this.retireSession(session, "Session was killed");
    // demote は agent process 消滅、reclaim は tmux session 消滅を表す。どちらも現在の
    // pane へ安全に配送できず、同名再作成後へ旧 queue を持ち越してはならない。
    for (const session of result.demoted) this.retireSession(session, "Agent process ended");
    for (const session of result.reclaimed) this.retireSession(session, "Session disappeared");
    if (this.chatReceiptsDirty && this.persistChatReceipts()) {
      // queued→injecting の保存だけが一時失敗した actor を、disk 回復後に自動再開する。
      for (const [session, actor] of this.actors) {
        if (actor.chatDrainBlocked) {
          actor.chatDrainBlocked = false;
          void this.drainChatQueue(session, actor);
        }
        if (actor.codexDrainBlocked) {
          actor.codexDrainBlocked = false;
          void this.drainCodexQueue(session, actor);
        }
      }
    }
    return result;
  }

  close(): void {
    for (const actor of this.actors.values()) {
      if (actor.tailRetryTimer !== null) clearTimeout(actor.tailRetryTimer);
      actor.tailRetryTimer = null;
    }
    this.codexTurnController?.close();
    this.codexTurnController = null;
    this.activeCodexTurns.clear();
  }

  /** tmux セッションの確定 kill に追従し、同名で将来作られる会話へ状態を持ち越さない。 */
  private retireSession(session: string, reason = "Session was retired"): void {
    const actor = this.actors.get(session);
    if (actor === undefined) return;

    if (actor.tailRetryTimer !== null) clearTimeout(actor.tailRetryTimer);
    actor.tailRetryTimer = null;
    actor.tail?.stop();
    actor.tail = null;
    actor.previewPump?.stop();
    actor.previewPump = null;
    for (const tail of actor.backfillTails.values()) tail.stop();
    actor.backfillTails.clear();
    this.activeCodexTurns.delete(session);
    this.codexTurnController?.closeSession(session);

    if (actor.pendingQuestion !== null) {
      this.broadcast({ type: "question_event", session, event: "dismiss", id: actor.pendingQuestion.id });
    }
    for (const entry of actor.pendingChatMessages.values()) {
      for (const waiter of entry.waiters) {
        this.sendTo(waiter.client, {
          type: "chat_send_result", id: waiter.id, status: "failed",
          error: `${reason} before delivery completed`,
        });
      }
      entry.waiters.length = 0;
    }
    for (const entry of actor.pendingCodexTurns.values()) {
      for (const waiter of entry.waiters) {
        this.sendTo(waiter.client, {
          type: "codex_turn_result", id: waiter.id, status: "failed",
          error: `${reason} before turn start completed`,
        });
      }
      entry.waiters.length = 0;
    }

    // drain が injector / App Server の await 中でも、復帰後に同じ actor 参照から次の旧入力へ
    // 進めないよう durable queue の実体も空にする。現在実行中の1件は復帰時のidentity検査で捨てる。
    actor.chatQueue.length = 0;
    actor.chatOrder.length = 0;
    actor.pendingChatMessages.clear();
    actor.injectingChatMessageIds.clear();
    actor.uncertainChatMessages.clear();
    actor.codexQueue.length = 0;
    actor.codexOrder.length = 0;
    actor.pendingCodexTurns.clear();
    actor.startingCodexMessageIds.clear();
    actor.uncertainCodexMessages.clear();
    actor.pendingQuestion = null;
    actor.focusedBy.clear();
    actor.subscribers.clear();

    this.actors.delete(session);
    this.persistPendingQuestions();
    this.persistChatReceipts();
  }

  private subscribe(client: object, session: string, afterSeq: number | undefined,
    newerThanMs: number | undefined, preview: boolean): void {
    const actor = this.actor(session);
    const existing = actor.subscribers.get(client);
    if (existing !== undefined) {
      const wasPreview = existing.preview;
      existing.preview = preview;
      if (preview) {
        actor.focusedBy.add(client);
        if (!wasPreview) this.bumpSafe(session, "chat-open");
      } else {
        actor.focusedBy.delete(client);
      }
      // 初回購読が session_start/resume の metadata 保存より先に届くと、startSharedTail は
      // metadata=null で開始できない。一覧へ戻るまで購読自体は残るため、同一 client の
      // 再購読を単なる no-op にせず、共有 tail がまだ無い場合は開始を再試行する。
      // Codex の App Server live は actor.tail が null でも codexLive を持つため重複起動しない。
      if (actor.tail === null && actor.codexLive === null) {
        this.startSharedTail(session, actor, newerThanMs ?? null);
      }
      // preview=false 中に engine が route できなかった image/subagent event を、同じ
      // subscriber の前面昇格時にも afterSeq から回収する。既存購読だからと no-op にしない。
      if (!existing.backfilling && afterSeq !== undefined) {
        if (this.canReplay(actor, afterSeq)) {
          for (const event of actor.replayBuffer) {
            if (event.serverSeq > afterSeq) {
              this.sendTo(client, { type: "conversation_event", session, ...event });
            }
          }
        } else {
          this.startBackfill(client, session, actor, newerThanMs ?? null);
        }
      }
      this.syncPreview(session, actor);
      return;
    }
    const first = actor.subscribers.size === 0;
    actor.subscribers.set(client, { preview, backfilling: false });
    if (preview) {
      actor.focusedBy.add(client);
      this.bumpSafe(session, "chat-open");
    }
    if (first) {
      this.startSharedTail(session, actor, newerThanMs ?? null);
      // processing 完了で一度 unsubscribe された後も、actor の replay buffer が残る間は
      // foreground の afterSeq から ephemeral image/subagent event を回収する。
      if (afterSeq !== undefined && this.canReplay(actor, afterSeq)) {
        for (const event of actor.replayBuffer) {
          if (event.serverSeq > afterSeq) {
            this.sendTo(client, { type: "conversation_event", session, ...event });
          }
        }
      }
    }
    else if (afterSeq !== undefined && this.canReplay(actor, afterSeq)) {
      for (const event of actor.replayBuffer) {
        if (event.serverSeq > afterSeq) this.sendTo(client, { type: "conversation_event", session, ...event });
      }
    } else {
      this.startBackfill(client, session, actor, newerThanMs ?? null);
    }
    this.syncPreview(session, actor);
  }

  private unsubscribe(client: object, session: string, actor: SessionActor): void {
    // 離脱は購読の有無に関わらず計時リセット（旧 touchHeartbeat の chat-leave 相当）。
    // session_idle_hint は同一接続で open していない会話にも届きうる。bump は既存 state を
    // 保持するため、処理中(active)を idle へ降格させない。
    // preview=false はフォーカス外ログ同期。ユーザーの open/leave ではなく、処理中状態の
    // heartbeat を上書きして reaper のアイドル時計を動かしてはならない。
    if (actor.subscribers.get(client)?.preview !== false) this.bumpSafe(session, "chat-leave");
    if (!actor.subscribers.delete(client)) return;
    actor.focusedBy.delete(client);
    actor.backfillTails.get(client)?.stop();
    actor.backfillTails.delete(client);
    this.syncPreview(session, actor);
    if (actor.subscribers.size === 0) {
      if (actor.tailRetryTimer !== null) clearTimeout(actor.tailRetryTimer);
      actor.tailRetryTimer = null;
      actor.tail?.stop();
      actor.tail = null;
      actor.codexLive = null;
      if (!this.activeCodexTurns.has(session)) this.codexTurnController?.closeSession(session);
    }
  }

  private startSharedTail(session: string, actor: SessionActor, newerThanMs: number | null): void {
    const meta = this.options.metadataStore.get(session);
    if (meta === null) {
      // VS Code 等の外部クライアント由来会話を初めて resume すると、Hub 購読が
      // launchCore の metadata 永続化よりわずかに先行し得る。購読を保持したまま
      // metadata の出現を待ち、一覧へ戻らなくても初回表示を開始できるようにする。
      if (actor.tailRetryTimer === null && actor.subscribers.size > 0) {
        actor.tailRetryTimer = setTimeout(() => {
          actor.tailRetryTimer = null;
          if (actor.subscribers.size > 0 && actor.tail === null && actor.codexLive === null) {
            this.startSharedTail(session, actor, newerThanMs);
          }
        }, 100);
        actor.tailRetryTimer.unref();
      }
      return;
    }
    if (actor.tailRetryTimer !== null) clearTimeout(actor.tailRetryTimer);
    actor.tailRetryTimer = null;
    if (meta.agent === "codex" && meta.providerSessionId) {
      this.startCodexSharedStream(session, actor, meta.cwd, meta.providerSessionId, newerThanMs);
      return;
    }
    if (this.options.tailFactory === undefined) return;
    const tail = this.options.tailFactory((payload) => {
      this.publishConversationEvent(session, actor, payload);
    });
    actor.tail = tail;
    tail.open(meta.cwd, meta.providerSessionId ?? meta.claudeSessionId ?? null, newerThanMs, meta.agent ?? "claude");
  }

  private startCodexSharedStream(
    session: string,
    actor: SessionActor,
    cwd: string,
    threadId: string,
    newerThanMs: number | null,
  ): void {
    const state: CodexLiveState = {
      phase: "starting",
      initialItemIds: new Set(),
      initialContentCounts: new Map(),
      buffered: [],
      seenItemIds: new Set(),
      publishedContentCounts: new Map(),
      scanContentCounts: new Map(),
      fallbackBaselineCounts: new Map(),
      disconnected: false,
    };
    actor.codexLive = state;
    const controller = this.ensureCodexTurnController();
    const subscribe = controller.subscribeSession;
    if (subscribe === undefined) {
      this.startCodexFallback(session, actor, cwd, threadId, newerThanMs, false);
      return;
    }
    void subscribe.call(controller, { session, threadId, cwd }).then(
      (snapshot) => {
        if (actor.codexLive !== state || actor.subscribers.size === 0) return;
        state.initialItemIds = snapshot.itemIds;
        state.initialContentCounts = snapshot.contentCounts;
        if (!snapshot.liveSubscribed) {
          this.options.log?.(
            "Codex App Server は未materialize threadをlive購読できないため、rollout fallbackへ移行",
          );
          this.startCodexFallback(session, actor, cwd, threadId, newerThanMs, false);
          return;
        }
        state.phase = "backfill";
        this.openCodexRollout(session, actor, cwd, threadId, newerThanMs, true);
      },
      (error) => {
        if (actor.codexLive !== state || actor.subscribers.size === 0) return;
        this.options.log?.(`Codex App Server 購読失敗、rollout fallback へ移行: ${String(error)}`);
        this.startCodexFallback(session, actor, cwd, threadId, newerThanMs, false);
      },
    );
  }

  private openCodexRollout(
    session: string,
    actor: SessionActor,
    cwd: string,
    threadId: string | null,
    newerThanMs: number | null,
    stopAtHistoryDone: boolean,
  ): void {
    if (this.options.tailFactory === undefined) return;
    const state = actor.codexLive;
    if (state === null) return;
    let tail: HubTail | null = null;
    tail = this.options.tailFactory((payload) => {
      if (actor.codexLive !== state) return;
      const isHistoryDone = payload.type === "chat_output" && payload.streamId === HISTORY_DONE_STREAM_ID;
      const contentKey = chatContentKey(payload);

      if (state.phase === "live") return; // 正常時の live 本文は App Server のみ。

      if (state.phase === "fallback-scan") {
        if (isHistoryDone) {
          state.phase = "fallback-live";
          return; // 通常 backfill の pc:history-done を再送しない。
        }
        if (contentKey === null) return; // fallback の model/token marker は controller 系統と混ぜない。
        const occurrence = (state.scanContentCounts.get(contentKey) ?? 0) + 1;
        state.scanContentCounts.set(contentKey, occurrence);
        if (occurrence <= (state.fallbackBaselineCounts.get(contentKey) ?? 0)) return;
        this.publishCodexContent(session, actor, state, payload);
        return;
      }

      if (state.phase === "fallback-live") {
        if (contentKey !== null) this.publishCodexContent(session, actor, state, payload);
        return;
      }

      // App Server 購読を先に確立して通知を buffer し、その後 rollout を EOF まで読む。
      // resume 応答の item ID / content occurrence を境界スナップショットとして使い、
      // EOF 後は rollout にまだ無い buffered item だけを flush する。event_msg 自体には
      // item ID が無いため、同文は Set ではなく occurrence count で照合する。
      this.publishConversationEvent(session, actor, payload);
      if (contentKey !== null) incrementCount(state.publishedContentCounts, contentKey);
      if (!isHistoryDone) return;
      if (state.disconnected) {
        // fallback 確定前に届いた App Server item は、この継続 rollout と同じ内容を
        // 別 streamId で持ち得る。rollout を唯一の一次ソースにした時点で破棄し、
        // history 完了時に flush して会話全体を二重表示しない。
        state.buffered.length = 0;
        state.phase = "fallback-live"; // この tail は既に同じ EOF 境界にいるので継続利用する。
      } else {
        this.flushCodexBuffer(session, actor, state);
        state.phase = "live";
        if (stopAtHistoryDone) {
          tail?.stop();
          if (actor.tail === tail) actor.tail = null;
        }
      }
    });
    actor.tail = tail;
    tail.open(cwd, threadId, newerThanMs, "codex");
  }

  private handleCodexChatItem(session: string, itemId: string, payload: ControlMessage): void {
    const actor = this.actors.get(session);
    const state = actor?.codexLive;
    if (actor === undefined || state == null || actor.subscribers.size === 0) return;
    if (state.seenItemIds.has(itemId)) return;
    state.seenItemIds.add(itemId);
    // subscribe 自体は接続を保持していても、未materialize thread は thread/resume が
    // 成立しておらず live 通知の完全性を保証できない。fallback 選択後は rollout だけを
    // 一次ソースにし、運良く届いた App Server item を backfill buffer へ混ぜて重複させない。
    if (state.disconnected) return;
    if (state.phase === "starting" || state.phase === "backfill") {
      // tool_activity は buffer せず捨てる。履歴は rollout（backfill）側が同じカードを
      // 供給するのが正で、live 由来と rollout 由来のカードは id が一致しないため
      // snapshot occurrence 照合に混ぜると開くたびに重複しうる。backfill 中に完了した
      // カードが落ちても、次回オープンの rollout 履歴で必ず表示される。
      if (payload.type === "tool_activity") return;
      state.buffered.push({ itemId, payload });
      return;
    }
    if (state.phase === "live") this.publishCodexContent(session, actor, state, payload);
    // fallback 中は上の disconnected guard で、遅着した旧接続通知を破棄する。
  }

  private flushCodexBuffer(session: string, actor: SessionActor, state: CodexLiveState): void {
    const remainingSnapshotCounts = new Map(state.initialContentCounts);
    const rolloutPostSnapshotCounts = new Map<string, number>();
    for (const [key, rolloutCount] of state.publishedContentCounts) {
      const snapshotCount = remainingSnapshotCounts.get(key) ?? 0;
      const remaining = Math.max(0, snapshotCount - rolloutCount);
      if (remaining === 0) remainingSnapshotCounts.delete(key);
      else remainingSnapshotCounts.set(key, remaining);
      const postSnapshotCount = Math.max(0, rolloutCount - snapshotCount);
      if (postSnapshotCount > 0) rolloutPostSnapshotCounts.set(key, postSnapshotCount);
    }
    for (const item of state.buffered) {
      const key = chatContentKey(item.payload);
      const isSnapshotItem = state.initialItemIds.has(item.itemId);
      // snapshot item は rollout がその content occurrence まで含んでいれば重複。含まなければ
      // resume と rollout flush の時間差なので App Server item で欠落を補完する。
      if (isSnapshotItem && key !== null && (remainingSnapshotCounts.get(key) ?? 0) === 0) continue;
      if (isSnapshotItem && key !== null) {
        const remaining = (remainingSnapshotCounts.get(key) ?? 0) - 1;
        if (remaining <= 0) remainingSnapshotCounts.delete(key);
        else remainingSnapshotCounts.set(key, remaining);
      }
      // resume snapshot の後に App Server から届いた item も、rollout が EOF までに
      // 同じ occurrence を取り込んでいれば既に配信済み。snapshot 以前の同文だけでは
      // 新着を消さないよう、rolloutCount - snapshotCount の超過分だけを消費する。
      if (!isSnapshotItem && key !== null) {
        const covered = rolloutPostSnapshotCounts.get(key) ?? 0;
        if (covered > 0) {
          if (covered === 1) rolloutPostSnapshotCounts.delete(key);
          else rolloutPostSnapshotCounts.set(key, covered - 1);
          continue;
        }
      }
      this.publishCodexContent(session, actor, state, item.payload);
    }
    state.buffered.length = 0;
  }

  private handleCodexDisconnect(session: string, error: Error): void {
    const actor = this.actors.get(session);
    const state = actor?.codexLive;
    if (actor === undefined || state == null || actor.subscribers.size === 0) return;
    this.options.log?.(`Codex App Server 接続断、rollout fallback へ移行: ${String(error)}`);
    state.disconnected = true;
    if (state.phase === "starting" || state.phase === "backfill") return;
    if (state.phase !== "live") return;
    const meta = this.options.metadataStore.get(session);
    if (meta === null) return;
    this.startCodexFallback(
      session, actor, meta.cwd, meta.providerSessionId ?? meta.claudeSessionId ?? null, null, true,
    );
  }

  private startCodexFallback(
    session: string,
    actor: SessionActor,
    cwd: string,
    threadId: string | null,
    newerThanMs: number | null,
    rescan: boolean,
  ): void {
    const state = actor.codexLive;
    if (state === null) return;
    actor.tail?.stop();
    state.phase = rescan ? "fallback-scan" : "backfill";
    state.disconnected = true;
    state.buffered.length = 0;
    state.scanContentCounts.clear();
    state.fallbackBaselineCounts = new Map(state.publishedContentCounts);
    this.openCodexRollout(session, actor, cwd, threadId, newerThanMs, false);
  }

  private publishCodexContent(
    session: string,
    actor: SessionActor,
    state: CodexLiveState,
    payload: ControlMessage,
  ): void {
    const key = chatContentKey(payload);
    if (key !== null) incrementCount(state.publishedContentCounts, key);
    this.publishConversationEvent(session, actor, payload);
  }

  private publishConversationEvent(session: string, actor: SessionActor, payload: ControlMessage): void {
    const event = { serverSeq: actor.nextServerSeq++, payload };
    actor.replayBuffer.push(event);
    if (actor.replayBuffer.length > this.replayLimit) {
      actor.replayBuffer.splice(0, actor.replayBuffer.length - this.replayLimit);
    }
    for (const [subscriber, subscriberState] of actor.subscribers) {
      if (!subscriberState.backfilling) {
        this.sendTo(subscriber, { type: "conversation_event", session, ...event });
      }
    }
  }

  private startBackfill(client: object, session: string, actor: SessionActor, newerThanMs: number | null): void {
    if (this.options.tailFactory === undefined) return;
    const meta = this.options.metadataStore.get(session);
    if (meta === null) return;
    actor.subscribers.get(client)!.backfilling = true;
    const boundarySeq = actor.nextServerSeq - 1;
    const liveCountsAtStart = new Map(actor.codexLive?.publishedContentCounts ?? []);
    const backfillCounts = new Map<string, number>();
    let completedSynchronously = false;
    let tail: HubTail | null = null;
    const finish = (): void => {
      const state = actor.subscribers.get(client);
      if (state === undefined) return;
      // 共有 tail の emit 時点でイベントは transcript に存在する。その後 EOF まで読む
      // 履歴 tail に必ず含まれるため、同じ同期処理で live へ切り替えても取りこぼさない。
      state.backfilling = false;
      if (actor.codexLive !== null) {
        const representedAfterBoundary = new Map<string, number>();
        for (const [key, count] of backfillCounts) {
          const excess = count - (liveCountsAtStart.get(key) ?? 0);
          if (excess > 0) representedAfterBoundary.set(key, excess);
        }
        for (const event of actor.replayBuffer) {
          if (event.serverSeq <= boundarySeq) continue;
          const key = chatContentKey(event.payload);
          const represented = key === null ? 0 : (representedAfterBoundary.get(key) ?? 0);
          if (key !== null && represented > 0) {
            representedAfterBoundary.set(key, represented - 1);
            continue;
          }
          this.sendTo(client, { type: "conversation_event", session, ...event });
        }
      }
      completedSynchronously = tail === null;
      tail?.stop();
      actor.backfillTails.delete(client);
    };
    tail = this.options.tailFactory((payload) => {
      this.sendTo(client, { type: "conversation_event", session, serverSeq: 0, payload });
      const key = chatContentKey(payload);
      if (key !== null) incrementCount(backfillCounts, key);
      if (payload.type === "chat_output" && payload.streamId === HISTORY_DONE_STREAM_ID) finish();
    });
    if (!completedSynchronously) actor.backfillTails.set(client, tail);
    tail.open(meta.cwd, meta.providerSessionId ?? meta.claudeSessionId ?? null, newerThanMs, meta.agent ?? "claude");
    if (completedSynchronously) tail.stop();
  }

  private canReplay(actor: SessionActor, afterSeq: number): boolean {
    const first = actor.replayBuffer[0]?.serverSeq ?? actor.nextServerSeq;
    const last = actor.nextServerSeq - 1;
    return afterSeq >= first - 1 && afterSeq <= last;
  }

  private syncPreview(session: string, actor: SessionActor): void {
    const wantsPreview = [...actor.subscribers.values()].some((state) => state.preview);
    if (!wantsPreview) {
      actor.previewPump?.stop();
      actor.previewPump = null;
      return;
    }
    if (actor.previewPump !== null || this.options.previewPumpFactory === undefined) return;
    const pump = this.options.previewPumpFactory(
      (payload) => {
        for (const [client, state] of actor.subscribers) {
          if (state.preview) this.sendTo(client, { type: "conversation_pane_preview", session, payload });
        }
      },
      (mode) => {
        // tmux 側 Shift+Tab の permission mode 切替をクライアント表示へ反映する
        // （iOS は mode_set_response をそのまま現況として採用する）。
        this.modePushSeq += 1;
        const payload: ControlMessage = {
          type: "mode_set_response", v: PROTOCOL_V1, id: `mode-watch-${this.modePushSeq}`, mode,
        };
        for (const [client, state] of actor.subscribers) {
          if (state.preview) this.sendTo(client, { type: "conversation_mode", session, payload });
        }
      },
    );
    actor.previewPump = pump;
    pump.start(session, this.options.metadataStore.get(session)?.agent === "codex" ? "codex_terminal" : "claude_status");
  }

  private actor(session: string): SessionActor {
    let actor = this.actors.get(session);
    if (actor === undefined) {
      actor = { pendingQuestion: null, processingSince: null, focusedBy: new Set(), subscribers: new Map(),
        nextServerSeq: 1, replayBuffer: [], tail: null, tailRetryTimer: null,
        previewPump: null, backfillTails: new Map(),
        seenClientMessageIds: new Set(), deliveredChatMessageIds: new Map(),
        deliveredCodexMessageIds: new Map(),
        pendingChatMessages: new Map(), injectingChatMessageIds: new Set(),
        uncertainChatMessages: new Map(), uncertainCodexMessages: new Map(),
        pendingCodexTurns: new Map(), startingCodexMessageIds: new Set(),
        runtimeClaim: null, codexLive: null,
        chatQueue: [], chatOrder: [], chatDrainRunning: false, chatDrainBlocked: false,
        codexQueue: [], codexOrder: [], codexDrainRunning: false, codexDrainBlocked: false };
      this.actors.set(session, actor);
    }
    return actor;
  }

  private claimInput(actor: SessionActor, clientMessageId: string): boolean {
    const duplicate = actor.seenClientMessageIds.has(clientMessageId);
    if (duplicate) return true;
    actor.seenClientMessageIds.add(clientMessageId);
    if (actor.seenClientMessageIds.size > 200) {
      const oldest = actor.seenClientMessageIds.values().next().value as string | undefined;
      if (oldest !== undefined) actor.seenClientMessageIds.delete(oldest);
    }
    return false;
  }

  private async drainChatQueue(session: string, actor: SessionActor): Promise<void> {
    if (actor.chatDrainRunning || actor.chatDrainBlocked || actor.pendingQuestion !== null) return;
    actor.chatDrainRunning = true;
    try {
      while (actor.pendingQuestion === null) {
        const entry = actor.chatQueue[0];
        if (entry === undefined) break;
        const { message } = entry;
        // journal のセッション順序を権威とし、先頭が crash 復元の uncertain なら
        // 後続 queued だけを先に実行しない。明示 retry が先頭を queued へ戻すまで停止する。
        if (actor.chatOrder[0] !== message.clientMessageId) break;
        actor.chatQueue.shift();
        this.injectionsInFlight += 1;
        try {
          actor.injectingChatMessageIds.add(message.clientMessageId);
          if (!this.persistChatReceipts()) {
            actor.injectingChatMessageIds.delete(message.clientMessageId);
            actor.chatQueue.unshift(entry);
            actor.chatDrainBlocked = true;
            for (const waiter of entry.waiters) {
              this.sendTo(waiter.client, {
                type: "chat_send_result", id: waiter.id, status: "failed",
                error: "Session Hub injecting receipt write failed",
              });
            }
            continue;
          }
          await (this.options.chatInjector?.(message.text, session) ?? Promise.resolve());
          // 明示 kill / reaper kill が注入 await 中に actor を廃棄した場合、同名の新 actorへ
          // 古い receipt を復活させない。waiter は retireSession が既に失敗で解放している。
          if (this.actors.get(session) !== actor) continue;
          actor.injectingChatMessageIds.delete(message.clientMessageId);
          actor.pendingChatMessages.delete(message.clientMessageId);
          removeOrderedID(actor.chatOrder, message.clientMessageId);
          recordDeliveredReceipt(actor.deliveredChatMessageIds, message.clientMessageId);
          const receiptPersisted = this.persistChatReceipts();
          if (!receiptPersisted) {
            // pane 注入済みというメモリ上の権威結果を返す。failed を返すと利用者の明示再送で
            // 二重実行になるため、durability は dirty retry と監査ログで回復させる。
            this.options.log?.(
              `chat delivered receipt 遅延永続化 session=${session} clientMessageId=${message.clientMessageId}`,
            );
          }
          for (const waiter of entry.waiters) {
            this.sendTo(waiter.client, { type: "chat_send_result", id: waiter.id, status: "accepted" });
          }
        } catch (error) {
          // retire が注入 await 中に actor を廃棄した場合、catch から同名 actor や
          // 古い会話のエラーマーカーを復活させない。
          if (this.actors.get(session) !== actor) continue;
          actor.injectingChatMessageIds.delete(message.clientMessageId);
          actor.pendingChatMessages.delete(message.clientMessageId);
          actor.uncertainChatMessages.set(message.clientMessageId, message);
          this.persistChatReceipts();
          for (const waiter of entry.waiters) {
            this.sendTo(waiter.client, {
              type: "chat_send_result", id: waiter.id, status: "failed", error: String(error),
            });
          }
          this.publishCodexMarker(session, `chat-send-error-${message.id}`, `⚠️ メッセージ送信失敗: ${String(error)}`);
          this.options.log?.(`chat 注入失敗 session=${session}: ${String(error)}`);
        } finally {
          this.injectionsInFlight -= 1;
        }
      }
    } finally {
      actor.chatDrainRunning = false;
      if (!actor.chatDrainBlocked && actor.pendingQuestion === null && actor.chatQueue.length > 0 &&
        actor.chatOrder[0] === actor.chatQueue[0]?.message.clientMessageId) {
        void this.drainChatQueue(session, actor);
      }
    }
  }

  private ensureCodexTurnController(): CodexTurnControllerRuntime {
    if (this.codexTurnController !== null) return this.codexTurnController;
    const appServer = (this.options.codexAppServerFactory ?? (() => new CodexAppServerManager()))();
    const create = this.options.codexTurnControllerFactory ??
      ((options: CodexNativeTurnControllerOptions) => new CodexNativeTurnController(options));
    this.codexTurnController = create({
      appServer,
      onProcessing: (session, state) => {
        if (state === "active") this.activeCodexTurns.add(session);
        else this.activeCodexTurns.delete(session);
        this.applyProcessing(session, state);
        this.broadcast({ type: "session_processing", session, state });
        if (state === "done" && (this.actors.get(session)?.subscribers.size ?? 0) === 0) {
          this.codexTurnController?.closeSession(session);
        }
      },
      onModel: (session, model) => this.publishCodexMarker(session, CODEX_MODEL_STREAM_ID, model),
      onTokenUsage: (session, totalTokens, contextWindow) => {
        this.publishCodexMarker(session, CODEX_CONTEXT_STREAM_ID, String(totalTokens));
        if (contextWindow !== null) {
          this.publishCodexMarker(session, CODEX_CONTEXT_WINDOW_STREAM_ID, String(contextWindow));
        }
      },
      onQuestion: ({ session, id, questions }) => {
        const actor = this.actor(session);
        this.setPendingQuestion(session, actor, { id, questions, answerRoute: "codex_native" });
        this.broadcast({ type: "question_event", session, event: "prompt", id, questions });
      },
      onQuestionDismiss: (session, id) => {
        const actor = this.actors.get(session);
        // answerQuestion は first-wins 側が既に clear+broadcast 済み。controller 自発 dismiss
        // （turn 完了/close）のときだけここで状態とイベントを更新する。
        if (actor?.pendingQuestion?.id !== id) return;
        this.setPendingQuestion(session, actor, null);
        this.broadcast({ type: "question_event", session, event: "dismiss", id });
        void this.drainChatQueue(session, actor);
      },
      onChatItem: ({ session, itemId, payload }) =>
        this.handleCodexChatItem(session, itemId, payload),
      onDisconnect: (session, error) => this.handleCodexDisconnect(session, error),
    });
    return this.codexTurnController;
  }

  private async drainCodexQueue(session: string, actor: SessionActor): Promise<void> {
    if (actor.codexDrainRunning || actor.codexDrainBlocked) return;
    actor.codexDrainRunning = true;
    try {
      while (true) {
        const entry = actor.codexQueue[0];
        if (entry === undefined) break;
        const id = entry.message.clientUserMessageId;
        if (actor.codexOrder[0] !== id) break;
        actor.codexQueue.shift();
        actor.startingCodexMessageIds.add(id);
        if (!this.persistChatReceipts()) {
          actor.startingCodexMessageIds.delete(id);
          actor.codexQueue.unshift(entry);
          actor.codexDrainBlocked = true;
          for (const waiter of entry.waiters) {
            this.sendTo(waiter.client, {
              type: "codex_turn_result", id: waiter.id, status: "failed",
              error: "Session Hub Codex starting receipt write failed",
            });
          }
          break;
        }
        this.codexStartsInFlight += 1;
        try {
          await this.startCodexTurn(entry, actor);
        } finally {
          this.codexStartsInFlight -= 1;
        }
      }
    } finally {
      actor.codexDrainRunning = false;
      if (!actor.codexDrainBlocked && actor.codexQueue.length > 0 &&
        actor.codexOrder[0] === actor.codexQueue[0]?.message.clientUserMessageId) {
        void this.drainCodexQueue(session, actor);
      }
    }
  }

  private async startCodexTurn(
    entry: PendingCodexTurn,
    expectedActor: SessionActor,
  ): Promise<void> {
    const { message } = entry;
    try {
      await this.ensureCodexTurnController().startTurn({
        session: message.session, threadId: message.threadId, cwd: message.cwd,
        text: message.text, clientUserMessageId: message.clientUserMessageId,
        effort: message.effort,
        approvalPolicy: message.approvalPolicy,
        sandbox: message.sandbox,
      });
      const actor = this.actors.get(message.session);
      if (actor === undefined || actor !== expectedActor) return;
      actor.startingCodexMessageIds.delete(message.clientUserMessageId);
      actor.pendingCodexTurns.delete(message.clientUserMessageId);
      removeOrderedID(actor.codexOrder, message.clientUserMessageId);
      recordDeliveredReceipt(actor.deliveredCodexMessageIds, message.clientUserMessageId);
      const receiptPersisted = this.persistChatReceipts();
      if (!receiptPersisted) {
        this.options.log?.(
          `Codex delivered receipt 遅延永続化 session=${message.session} clientUserMessageId=${message.clientUserMessageId}`,
        );
      }
      for (const waiter of entry.waiters) {
        this.sendTo(waiter.client, { type: "codex_turn_result", id: waiter.id, status: "started" });
      }
    } catch (error) {
      const actor = this.actors.get(message.session);
      if (actor === undefined || actor !== expectedActor) return;
      actor.startingCodexMessageIds.delete(message.clientUserMessageId);
      actor.pendingCodexTurns.delete(message.clientUserMessageId);
      actor.uncertainCodexMessages.set(message.clientUserMessageId, message);
      this.persistChatReceipts();
      for (const waiter of entry.waiters) {
        this.sendTo(waiter.client, {
          type: "codex_turn_result", id: waiter.id, status: "failed", error: String(error),
        });
      }
      this.publishCodexMarker(
        message.session,
        `codex-turn-error-${message.id}`,
        `⚠️ Codex turn 開始失敗: ${String(error)}`,
      );
      this.options.log?.(`codex turn 開始失敗 session=${message.session}: ${String(error)}`);
    }
  }

  private publishCodexMarker(session: string, streamId: string, text: string): void {
    const actor = this.actor(session);
    this.publishConversationEvent(session, actor, {
      type: "chat_output" as const, v: PROTOCOL_V1, streamId, role: "system" as const, text, eof: true,
    });
  }

  private applyProcessing(session: string, state: "active" | "done"): void {
    const actor = this.actor(session);
    actor.processingSince = state === "active" ? this.now() : null;
    try {
      writeHeartbeat(this.options.heartbeatDir, session, { ts: this.now(), state: state === "active" ? "active" : "idle",
        event: state === "active" ? "hub-processing" : "hub-processing-done" });
    } catch (error) { this.options.log?.(`heartbeat 書込失敗: ${String(error)}`); }
    if (state === "done" && actor.pendingQuestion !== null) {
      const id = actor.pendingQuestion.id;
      this.setPendingQuestion(session, actor, null);
      this.broadcast({ type: "question_event", session, event: "dismiss", id });
      void this.drainChatQueue(session, actor);
    }
  }

  private bumpSafe(session: string, event: string, fallbackState: "active" | "idle" = "idle"): void {
    try { bumpHeartbeat(this.options.heartbeatDir, session, this.now(), event, fallbackState); }
    catch (error) { this.options.log?.(`heartbeat 書込失敗: ${String(error)}`); }
  }

  private setPendingQuestion(session: string, actor: SessionActor, pending: PendingQuestion | null): void {
    actor.pendingQuestion = pending;
    this.persistPendingQuestions();
  }

  private persistPendingQuestions(): void {
    const target = this.options.pendingQuestionsPath;
    if (target === undefined) return;
    const persisted: Record<string, PendingQuestion> = {};
    for (const [session, actor] of this.actors) {
      if (actor.pendingQuestion !== null) persisted[session] = actor.pendingQuestion;
    }
    try {
      ensureDirectory0700(path.dirname(target));
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(persisted), { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (error) { this.options.log?.(`pending question 書込失敗: ${String(error)}`); }
  }

  private readPendingQuestions(): Record<string, PendingQuestion> {
    const target = this.options.pendingQuestionsPath;
    if (target === undefined) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const result: Record<string, PendingQuestion> = {};
      for (const [session, value] of Object.entries(parsed)) {
        if (!isPersistedPendingQuestion(value)) continue;
        result[session] = value;
      }
      return result;
    } catch { return {}; }
  }

  private persistChatReceipts(): boolean {
    const target = this.options.chatReceiptsPath;
    if (target === undefined) {
      this.chatReceiptsDirty = false;
      return true;
    }
    const sessions: PersistedChatReceipts = {};
    for (const [session, actor] of this.actors) {
      compactDeliveredReceipts(actor.deliveredChatMessageIds);
      compactDeliveredReceipts(actor.deliveredCodexMessageIds);
      const queued = actor.chatQueue.map((entry) => entry.message);
      // shift 済みで注入中の entry も pending map には残るため必ず journal に含める。
      for (const entry of actor.pendingChatMessages.values()) {
        if (!actor.injectingChatMessageIds.has(entry.message.clientMessageId) &&
          !queued.some((message) => message.clientMessageId === entry.message.clientMessageId)) {
          queued.unshift(entry.message);
        }
      }
      const injecting = [...actor.pendingChatMessages.values()]
        .filter((entry) => actor.injectingChatMessageIds.has(entry.message.clientMessageId))
        .map((entry) => entry.message)
        .concat([...actor.uncertainChatMessages.values()]);
      const queuedCodex = actor.codexQueue.map((entry) => entry.message);
      for (const entry of actor.pendingCodexTurns.values()) {
        if (!actor.startingCodexMessageIds.has(entry.message.clientUserMessageId) &&
          !queuedCodex.some((message) => message.clientUserMessageId === entry.message.clientUserMessageId)) {
          queuedCodex.unshift(entry.message);
        }
      }
      const startingCodex = [...actor.pendingCodexTurns.values()]
        .filter((entry) => actor.startingCodexMessageIds.has(entry.message.clientUserMessageId))
        .map((entry) => entry.message)
        .concat([...actor.uncertainCodexMessages.values()]);
      if (queued.length === 0 && injecting.length === 0 && actor.deliveredChatMessageIds.size === 0 &&
        queuedCodex.length === 0 && startingCodex.length === 0 && actor.deliveredCodexMessageIds.size === 0) continue;
      const sessionIdentity = receiptSessionIdentity(this.options.metadataStore.get(session));
      sessions[session] = {
        ...(sessionIdentity !== undefined ? { sessionIdentity } : {}),
        delivered: [...actor.deliveredChatMessageIds.keys()],
        deliveredAtMs: Object.fromEntries(actor.deliveredChatMessageIds),
        queued, injecting, chatOrder: [...actor.chatOrder],
        deliveredCodex: [...actor.deliveredCodexMessageIds.keys()],
        deliveredCodexAtMs: Object.fromEntries(actor.deliveredCodexMessageIds),
        queuedCodex, startingCodex, codexOrder: [...actor.codexOrder],
      };
    }
    try {
      const contents = JSON.stringify({ version: 1, sessions });
      if (this.options.chatReceiptsWriter !== undefined) {
        this.options.chatReceiptsWriter(target, contents);
      } else {
        ensureDirectory0700(path.dirname(target));
        const tmp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, contents, { mode: 0o600 });
        fs.renameSync(tmp, target);
      }
      this.chatReceiptsDirty = false;
      return true;
    } catch (error) {
      this.chatReceiptsDirty = true;
      this.options.log?.(`chat receipt 書込失敗: ${String(error)}`);
      return false;
    }
  }

  private readChatReceipts(): PersistedChatReceipts {
    const target = this.options.chatReceiptsPath;
    if (target === undefined) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const root = parsed as Record<string, unknown>;
      if (root["version"] !== 1 || typeof root["sessions"] !== "object" ||
        root["sessions"] === null || Array.isArray(root["sessions"])) return {};
      const result: PersistedChatReceipts = {};
      for (const [session, value] of Object.entries(root["sessions"] as Record<string, unknown>)) {
        if (!isPersistedChatReceipt(value)) continue;
        result[session] = value;
      }
      return result;
    } catch { return {}; }
  }
}

/** 監査行を必ず 1 行の key=value として保つ。 */
function auditValue(value: string): string {
  return value.replace(/[\s=]+/g, "_");
}

function isPersistedPendingQuestion(value: unknown): value is PendingQuestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || !Array.isArray(record["questions"]) ||
    (record["answerRoute"] !== "tui" && record["answerRoute"] !== "codex_native")) return false;
  return record["questions"].every((question) => {
    if (typeof question !== "object" || question === null || Array.isArray(question)) return false;
    const item = question as Record<string, unknown>;
    return typeof item["header"] === "string" && typeof item["question"] === "string" &&
      Array.isArray(item["options"]) && typeof item["multiSelect"] === "boolean";
  });
}

type PersistedChatReceipts = Record<string, {
  sessionIdentity?: string;
  delivered: string[];
  deliveredAtMs?: Record<string, number>;
  queued: Array<Extract<HubClientMessage, { type: "chat_send" }>>;
  injecting: Array<Extract<HubClientMessage, { type: "chat_send" }>>;
  chatOrder?: string[];
  deliveredCodex: string[];
  deliveredCodexAtMs?: Record<string, number>;
  queuedCodex?: Array<Extract<HubClientMessage, { type: "codex_turn_submit" }>>;
  startingCodex: Array<Extract<HubClientMessage, { type: "codex_turn_submit" }>>;
  codexOrder?: string[];
}>;

function isPersistedChatReceipt(value: unknown): value is PersistedChatReceipts[string] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["sessionIdentity"] !== undefined &&
    (typeof record["sessionIdentity"] !== "string" || record["sessionIdentity"].length === 0)) return false;
  if (!Array.isArray(record["delivered"]) ||
    !record["delivered"].every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(record["queued"]) || !Array.isArray(record["injecting"]) ||
    !Array.isArray(record["deliveredCodex"]) ||
    !record["deliveredCodex"].every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(record["startingCodex"])) return false;
  if (!isOptionalTimestampRecord(record["deliveredAtMs"]) ||
    !isOptionalTimestampRecord(record["deliveredCodexAtMs"]) ||
    !isOptionalStringArray(record["chatOrder"]) || !isOptionalStringArray(record["codexOrder"]) ||
    (record["queuedCodex"] !== undefined && !Array.isArray(record["queuedCodex"]))) return false;
  const validChat = [...record["queued"], ...record["injecting"]].every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const message = item as Record<string, unknown>;
    return message["type"] === "chat_send" && typeof message["id"] === "string" &&
      typeof message["session"] === "string" && typeof message["clientMessageId"] === "string" &&
      typeof message["text"] === "string" && message["text"].length > 0;
  });
  const validCodex = [...((record["queuedCodex"] as unknown[] | undefined) ?? []),
    ...record["startingCodex"]].every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const message = item as Record<string, unknown>;
    return message["type"] === "codex_turn_submit" && typeof message["id"] === "string" &&
      typeof message["session"] === "string" && typeof message["clientUserMessageId"] === "string" &&
      typeof message["text"] === "string" && typeof message["threadId"] === "string" &&
      typeof message["cwd"] === "string";
  });
  return validChat && validCodex;
}

function isOptionalTimestampRecord(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([id, timestamp]) =>
    id.length > 0 && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0,
  );
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) &&
    value.every((id) => typeof id === "string" && id.length > 0));
}

/** session 名の再利用を durable receipt 上で区別する世代 ID。 */
function receiptSessionIdentity(meta: SessionMeta | null): string | undefined {
  if (meta === null) return undefined;
  return JSON.stringify([
    meta.createdAt,
    meta.agent ?? "claude",
    meta.providerSessionId ?? null,
    meta.tmuxPaneId ?? meta.herdrPaneId ?? null,
    meta.cwd,
  ]);
}

function restoreOrder(persisted: string[] | undefined, fallback: string[], valid: Set<string>): string[] {
  const result: string[] = [];
  for (const id of [...(persisted ?? fallback), ...fallback, ...valid]) {
    if (valid.has(id) && !result.includes(id)) result.push(id);
  }
  return result;
}

function hasDeliveredReceipt(receipts: Map<string, number>, id: string, now = Date.now()): boolean {
  const deliveredAt = receipts.get(id);
  if (deliveredAt === undefined) return false;
  if (now - deliveredAt <= DELIVERED_RECEIPT_TTL_MS) return true;
  receipts.delete(id);
  return false;
}

function recordDeliveredReceipt(receipts: Map<string, number>, id: string, now = Date.now()): void {
  receipts.delete(id);
  receipts.set(id, now);
  compactDeliveredReceipts(receipts, now);
}

function compactDeliveredReceipts(receipts: Map<string, number>, now = Date.now()): void {
  for (const [id, deliveredAt] of receipts) {
    if (now - deliveredAt > DELIVERED_RECEIPT_TTL_MS) receipts.delete(id);
  }
  while (receipts.size > MAX_DELIVERED_RECEIPTS_PER_SESSION) {
    const oldest = receipts.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    receipts.delete(oldest);
  }
}

function removeOrderedID(order: string[], id: string): void {
  const index = order.indexOf(id);
  if (index >= 0) order.splice(index, 1);
}

function sameCodexRetry(
  left: Extract<HubClientMessage, { type: "codex_turn_submit" }>,
  right: Extract<HubClientMessage, { type: "codex_turn_submit" }>,
): boolean {
  return left.session === right.session && left.text === right.text &&
    left.clientUserMessageId === right.clientUserMessageId && left.effort === right.effort &&
    (left.approvalPolicy ?? null) === (right.approvalPolicy ?? null) &&
    left.sandbox === right.sandbox &&
    left.threadId === right.threadId && left.cwd === right.cwd;
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
