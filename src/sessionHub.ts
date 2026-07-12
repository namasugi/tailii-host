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
};

type PendingQuestion = NonNullable<SessionActor["pendingQuestion"]>;

interface SubscriberState { preview: boolean; backfilling: boolean }
interface ReplayEvent { serverSeq: number; payload: ControlMessage }
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
  runtimeClaim: { client: object; expiresAt: number } | null;
  codexLive: CodexLiveState | null;
  chatQueue: Array<Extract<HubClientMessage, { type: "chat_send" }>>;
  chatDrainRunning: boolean;
}

export class SessionHub {
  private readonly clients = new Map<object, (line: string) => void>();
  readonly actors = new Map<string, SessionActor>();
  private readonly now: () => number;
  private readonly replayLimit: number;
  private injectionsInFlight = 0;
  private codexStartsInFlight = 0;
  private modePushSeq = 0;
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
      this.subscribe(client, message.session, message.afterSeq, message.newerThanMs, message.preview ?? false);
      return;
    }
    if (message.type === "conversation_unsubscribe") {
      const actor = this.actor(message.session);
      this.unsubscribe(client, message.session, actor);
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
      const duplicate = this.claimInput(actor, message.clientUserMessageId);
      if (duplicate) {
        this.sendTo(client, { type: "codex_turn_result", id: message.id, status: "duplicate" });
        return;
      }
      this.codexStartsInFlight += 1;
      // 即時 ack: startTurn は App Server 起動を含み数秒かかりうる。応答を実行完了まで
      // 遅らせると engine 側 RPC timeout が fail-open を誤発動し二重 turn になるため、
      // 重複排除の確定だけで started を返し、実行は非同期に行う（失敗は会話へマーカー配信）。
      this.sendTo(client, { type: "codex_turn_result", id: message.id, status: "started" });
      void this.startCodexTurn(message);
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
      if (this.claimInput(actor, message.clientMessageId)) {
        this.sendTo(client, { type: "chat_send_result", id: message.id, status: "duplicate" });
        return;
      }
      actor.chatQueue.push(message);
      this.sendTo(client, { type: "chat_send_result", id: message.id, status: "accepted" });
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
    for (const session of [...result.killed, ...result.demoted, ...result.reclaimed]) {
      const actor = this.actors.get(session);
      if (actor !== undefined) actor.processingSince = null;
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

  private subscribe(client: object, session: string, afterSeq: number | undefined,
    newerThanMs: number | undefined, preview: boolean): void {
    const actor = this.actor(session);
    const existing = actor.subscribers.get(client);
    if (existing !== undefined) {
      existing.preview = preview;
      // 初回購読が session_start/resume の metadata 保存より先に届くと、startSharedTail は
      // metadata=null で開始できない。一覧へ戻るまで購読自体は残るため、同一 client の
      // 再購読を単なる no-op にせず、共有 tail がまだ無い場合は開始を再試行する。
      // Codex の App Server live は actor.tail が null でも codexLive を持つため重複起動しない。
      if (actor.tail === null && actor.codexLive === null) {
        this.startSharedTail(session, actor, newerThanMs ?? null);
      }
      this.syncPreview(session, actor);
      return;
    }
    const first = actor.subscribers.size === 0;
    actor.subscribers.set(client, { preview, backfilling: false });
    actor.focusedBy.add(client);
    this.bumpSafe(session, "chat-open");
    if (first) this.startSharedTail(session, actor, newerThanMs ?? null);
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
    this.bumpSafe(session, "chat-leave");
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
      this.flushCodexBuffer(session, actor, state);
      if (state.disconnected) {
        state.phase = "fallback-live"; // この tail は既に同じ EOF 境界にいるので継続利用する。
      } else {
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
    if (state.phase === "starting" || state.phase === "backfill") {
      state.buffered.push({ itemId, payload });
      return;
    }
    if (state.phase === "live") this.publishCodexContent(session, actor, state, payload);
    // fallback 中は rollout が唯一の一次ソース。遅着した旧接続通知は破棄する。
  }

  private flushCodexBuffer(session: string, actor: SessionActor, state: CodexLiveState): void {
    const remainingSnapshotCounts = new Map(state.initialContentCounts);
    for (const [key, rolloutCount] of state.publishedContentCounts) {
      const remaining = Math.max(0, (remainingSnapshotCounts.get(key) ?? 0) - rolloutCount);
      if (remaining === 0) remainingSnapshotCounts.delete(key);
      else remainingSnapshotCounts.set(key, remaining);
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
        seenClientMessageIds: new Set(), runtimeClaim: null, codexLive: null,
        chatQueue: [], chatDrainRunning: false };
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
    if (actor.chatDrainRunning || actor.pendingQuestion !== null) return;
    actor.chatDrainRunning = true;
    try {
      while (actor.pendingQuestion === null) {
        const message = actor.chatQueue.shift();
        if (message === undefined) break;
        this.injectionsInFlight += 1;
        try {
          await (this.options.chatInjector?.(message.text, session) ?? Promise.resolve());
        } catch (error) {
          actor.seenClientMessageIds.delete(message.clientMessageId);
          this.publishCodexMarker(session, `chat-send-error-${message.id}`, `⚠️ メッセージ送信失敗: ${String(error)}`);
          this.options.log?.(`chat 注入失敗 session=${session}: ${String(error)}`);
        } finally {
          this.injectionsInFlight -= 1;
        }
      }
    } finally {
      actor.chatDrainRunning = false;
      if (actor.pendingQuestion === null && actor.chatQueue.length > 0) void this.drainChatQueue(session, actor);
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

  private async startCodexTurn(
    message: Extract<HubClientMessage, { type: "codex_turn_submit" }>,
  ): Promise<void> {
    try {
      await this.ensureCodexTurnController().startTurn({
        session: message.session, threadId: message.threadId, cwd: message.cwd,
        text: message.text, clientUserMessageId: message.clientUserMessageId,
        effort: message.effort, sandbox: message.sandbox,
      });
    } catch (error) {
      // started は ack 済み（即時応答）。失敗は claim を解放して再送を duplicate 扱いに
      // しないようにし、全 client が見える system マーカーとして会話へ配信する。
      this.actors.get(message.session)?.seenClientMessageIds.delete(message.clientUserMessageId);
      this.publishCodexMarker(
        message.session,
        `codex-turn-error-${message.id}`,
        `⚠️ Codex turn 開始失敗: ${String(error)}`,
      );
      this.options.log?.(`codex turn 開始失敗 session=${message.session}: ${String(error)}`);
    } finally {
      this.codexStartsInFlight -= 1;
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

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
