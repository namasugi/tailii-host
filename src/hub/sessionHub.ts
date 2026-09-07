// sessionHub.ts
// tailii (TS host) — connection 非依存 Session Hub コア。

import type { ReaperTickOptions, ReaperTickResult } from "./reaper.js";
import { reaperTick } from "./reaper.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bumpHeartbeat, listHeartbeatSessions, readHeartbeat, writeHeartbeat } from "../sessions/heartbeat.js";
import { claudeProjectSlug, ensureDirectory0700 } from "../shared/paths.js";
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
} from "../protocol.js";
import {
  HISTORY_DONE_STREAM_ID,
  findTrailingTurnEndMarkerMs,
  type ClaudeTurnLifecycleEvent,
} from "../chat/transcriptTailer.js";
import type { ChatAgent } from "../chat/chatTailController.js";
import type { PanePreviewMode } from "./panePreviewPump.js";
import type { QuestionAnswer } from "../protocol.js";
import { PROTOCOL_V1, PROTOCOL_V2 } from "../protocol.js";
import { LoginCodeError } from "../backend/tmux.js";
import { CodexAppServerManager } from "../codex/codexAppServer.js";
import {
  CodexNativeTurnController,
  chatContentKey,
  type CodexAppServerThreadRuntime,
  type CodexNativeTurnControllerOptions,
  type CodexTurnControllerRuntime,
} from "../codex/codexNativeTurnController.js";
import {
  CONTEXT_STREAM_ID as CODEX_CONTEXT_STREAM_ID,
  CONTEXT_WINDOW_STREAM_ID as CODEX_CONTEXT_WINDOW_STREAM_ID,
  MODEL_STREAM_ID as CODEX_MODEL_STREAM_ID,
  type CodexTurnLifecycleEvent,
} from "../codex/codexRolloutTailer.js";
import type { SessionMeta } from "../sessions/sessionMetadataStore.js";

export interface HubTail {
  open(cwd: string, preferredSessionId: string | null, newerThanMs?: number | null, agent?: ChatAgent): void;
  stop(): void;
  subagentTranscript?(nodeId: string): {
    entries: SubagentTranscriptEntry[];
    omitted: number;
  };
}

export interface HubPreviewPump {
  start(session: string, mode?: PanePreviewMode, opts?: { emitInitial?: boolean }): void;
  stop(): void;
  /** 前面購読者の参加時に、直近の入力待ちフレームを再送する（任意実装）。 */
  resendLastIfInteractive?(): void;
}

export type HubTailFactory = (
  write: (payload: ControlMessage) => void,
  onCodexTurnLifecycle?: (event: CodexTurnLifecycleEvent) => void,
  onClaudeTurnLifecycle?: (event: ClaudeTurnLifecycleEvent) => void,
) => HubTail;
export type HubPreviewPumpFactory = (
  write: (payload: ControlMessage) => void,
  onPermissionMode?: (mode: string) => void,
  /** 毎周期評価するポーリング間隔（ms）。前面購読あり=高頻度 / 一覧 watch のみ=低頻度。 */
  pollIntervalMs?: () => number,
) => HubPreviewPump;

export type SessionHubOptions = Omit<ReaperTickOptions, "now"> & {
  /** Unix 秒。テストでは固定時計を注入する。 */
  now?: () => number;
  /**
   * Unix ms。処理開始時刻と transcript 行 timestamp の比較用（既定 Date.now）。`now`（秒）から
   * 派生させると境界が最大 999ms 早まり、中断直後の再送信でマーカーが新ターンを落とす。
   */
  nowMs?: () => number;
  /**
   * 復元時に照合する claude transcript の場所（テスト注入用）。既定は
   * `~/.claude/projects/<slug>/<claudeSessionId>.jsonl`。null は照合しない。
   */
  transcriptPathFor?: (meta: SessionMeta) => string | null;
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
/**
 * backfilling 中の購読者は publishConversationEvent が丸ごと飛ばす。旗が立ちっぱなしになると
 * 「接続は健全なのに会話だけ永久に更新されない」実障害になるため、履歴が一定時間 1 行も進まな
 * ければ強制的に live へ切り替える。進捗があるうちは延長するので、巨大な transcript の再生を
 * 途中で打ち切ることはない。
 */
const BACKFILL_STALL_TIMEOUT_MS = 15_000;
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
  /**
   * この会話へ最後に配信した `pc:model` の値。App Server 通知（onModel）と rollout の
   * turn_context は同じ「実際に使うモデル」を別経路で伝えるため、同値は 1 回に畳む。
   */
  lastModel: string | null;
  /** 購読時点の thread のモデル（thread/resume 応答）。初回 backfill 完了後に配信する。 */
  subscribedModel: string | null;
  /**
   * fallback-scan（切断後の rollout 再走査）で最後に見た `pc:model`。再走査は履歴を頭から
   * 読み直すため、途中の旧モデルを配信せず走査完了時に最新値だけを配る。
   */
  scanLastModel: string | null;
}
interface SessionActor {
  pendingQuestion: {
    id: string;
    questions: QuestionPromptQuestion[];
    answerRoute: "tui" | "codex_native";
    /** 注入失敗の自己修復で復元済みか。復元は毎回だが prompt 再配信は1回まで（再提示ループ防止）。 */
    restoredAfterInjectionFailure?: boolean;
  } | null;
  processingSince: number | null;
  /**
   * 現ターンの開始時刻（Unix ms）= UserPromptSubmit（または復元時刻）を hub が受けた時刻。
   * Pre/PostToolUse の継続 active では進めない（マーカーより後に遅着した継続 hook で境界が
   * マーカーを追い越すと、中断が棄却されて停止ボタンが残る）。
   */
  processingSinceMs: number | null;
  /** 中断マーカーで done にした時刻（Unix ms）。直後に遅着する継続 hook の active を残響として無視する。 */
  lastInterruptDoneMs: number | null;
  /**
   * transcript で観測した最新のターン終端行（中断確定 / API エラー）の timestamp（Unix ms）。処理中で
   * なくても更新する。発火時刻（`atMs`）付きの hook がこれより前（かつ LATE_HOOK_MAX_AGE_MS 以内）に
   * 発火していれば、既に終わったターンの遅着 hook として無視する（late-hook-before-turn-end）。
   */
  lastTurnEndMs: number | null;
  /**
   * 現ターンを開始した UserPromptSubmit hook の発火時刻（Unix ms。旧 hook は null）。これより前に
   * 発火した Stop（前ターンの遅着 done）で現ターンを落とさない（late-stop-before-turn-start）。
   */
  turnStartFiredAtMs: number | null;
  /**
   * transcript で観測した最新の発話行（type=user の本文行）の timestamp（Unix ms）。終端マーカーより
   * 後に発話が現れていれば、終端より前に発火した UserPromptSubmit でも新ターン（queued 発話の
   * dequeue）として採用する（transcript を権威にして生きたターンを idle に固定しない）。
   */
  lastTurnStartMs: number | null;
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
  deletedChatMessageIds: Map<string, number>;
  deletedCodexMessageIds: Map<string, number>;
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

/** 中断マーカーで done にした後、継続 hook（Pre/PostToolUse）の遅着 active を残響として無視する窓（ms）。 */
const LATE_HOOK_AFTER_INTERRUPT_MS = 3_000;
/**
 * 発火時刻付き hook を「既に終わったターンの遅着」とみなす古さの上限（ms）。hook は発火から
 * 100〜300ms（高負荷でも数秒）で relay に届くので、終端マーカーよりそれ以上前に発火した hook が
 * マーカーの後に届くことは無い。上限を切らないと、queued 発話の UserPromptSubmit が enqueue 時に
 * 発火する版が現れた場合に、数秒後の dequeue で始まる生きたターンを idle に固定してしまう。
 */
const LATE_HOOK_MAX_AGE_MS = 3_000;

/** ターンを始めない継続 hook か（新ターンの権威は UserPromptSubmit のみ）。 */
function isContinuationHookEvent(event: string | undefined): boolean {
  return event === "PreToolUse" || event === "PostToolUse";
}

/** 既定の claude transcript 解決（`~/.claude/projects/<slug>/<sessionId>.jsonl`）。ID 未記録は null。 */
function defaultTranscriptPathFor(meta: SessionMeta): string | null {
  // 他の tail open と同じ優先順（providerSessionId → claudeSessionId）。別会話を照合しない。
  const sessionId = meta.providerSessionId ?? meta.claudeSessionId;
  if (sessionId === undefined || sessionId.length === 0) return null;
  return path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(meta.cwd), `${sessionId}.jsonl`);
}

export class SessionHub {
  private readonly clients = new Map<object, (line: string) => void>();
  /** 一覧 Mission Control の watcher（処理中会話全体の pane_preview 配信先）。 */
  private readonly previewWatchers = new Set<object>();
  readonly actors = new Map<string, SessionActor>();
  private readonly now: () => number;
  private readonly nowMs: () => number;
  private readonly replayLimit: number;
  private injectionsInFlight = 0;
  private codexStartsInFlight = 0;
  private modePushSeq = 0;
  private chatReceiptsDirty = false;
  private readonly activeCodexTurns = new Set<string>();
  private codexTurnController: CodexTurnControllerRuntime | null = null;

  constructor(private readonly options: SessionHubOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.nowMs = options.nowMs ?? (() => Date.now());
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
      // 再起動前に利用者が中断して放置した会話は Stop hook が無く active のまま残る。engine の
      // 再接続購読は newerThanMs 付きで履歴のマーカーを流さないため、tail 経由では二度と
      // 観測できない。transcript 末尾を直接照合し、最後の発話が開始以降の中断マーカーなら
      // 処理中に戻さず idle へ確定する。
      const trailingInterruptMs = this.trailingInterruptMarkerMs(session);
      if (trailingInterruptMs !== null && (heartbeat.sinceMs === undefined || trailingInterruptMs >= heartbeat.sinceMs)) {
        // 再起動中に hook が新ターンの active を書いた直後なら上書きしない（読んだ内容と同じときだけ倒す）。
        const latest = readHeartbeat(this.options.heartbeatDir, session);
        const unchanged = latest !== null && latest.ts === heartbeat.ts && latest.state === heartbeat.state &&
          latest.event === heartbeat.event && latest.sinceMs === heartbeat.sinceMs;
        if (!unchanged) {
          // 消えていた（kill 後の掃除）場合も再生成しない。
          this.options.log?.(`restore: heartbeat が更新されたため中断判定を見送る session=${session}`);
        } else {
          try {
            writeHeartbeat(this.options.heartbeatDir, session,
              { ts: this.now(), state: "idle", event: "restore-interrupted" });
          } catch (error) { this.options.log?.(`heartbeat 書込失敗: ${String(error)}`); }
          this.options.log?.(`restore: 中断済みのため処理中を復元しない session=${session}`);
          continue;
        }
      }
      const actor = this.actor(session);
      actor.processingSince = heartbeat.ts;
      // 真の開始時刻は heartbeat の sinceMs（applyProcessing が書き、bump が保持する）。ts は
      // 毎 tick bump されるので使えない。無ければ（hook 直書きの heartbeat・旧形式）復元時刻を
      // 境界にする: 再起動前の中断は上の transcript 照合が担い、再起動後の中断は必ずこれより
      // 新しい。null（全採用）にすると、開き直しの全履歴再生で流れる過去ターンのマーカーが
      // 進行中ターンを落とす。
      actor.processingSinceMs = heartbeat.sinceMs ?? this.nowMs();
    }
  }

  /**
   * 復元時の照合用: transcript 末尾のターン終端マーカー（中断確定 / API エラー終端）の timestamp
   * （claude 会話のみ。不明は null）。
   */
  private trailingInterruptMarkerMs(session: string): number | null {
    const meta = this.options.metadataStore.get(session);
    if (meta === null || meta.agent === "codex") return null;
    const transcriptPath = (this.options.transcriptPathFor ?? defaultTranscriptPathFor)(meta);
    if (transcriptPath === null) return null;
    return findTrailingTurnEndMarkerMs(transcriptPath);
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
      for (const clientMessageId of state.deleted ?? []) {
        actor.deletedChatMessageIds.set(
          clientMessageId, state.deletedAtMs?.[clientMessageId] ?? restoredAt,
        );
      }
      for (const clientMessageId of state.deletedCodex ?? []) {
        actor.deletedCodexMessageIds.set(
          clientMessageId, state.deletedCodexAtMs?.[clientMessageId] ?? restoredAt,
        );
      }
      compactDeliveredReceipts(actor.deliveredChatMessageIds, restoredAt);
      compactDeliveredReceipts(actor.deliveredCodexMessageIds, restoredAt);
      compactDeliveredReceipts(actor.deletedChatMessageIds, restoredAt);
      compactDeliveredReceipts(actor.deletedCodexMessageIds, restoredAt);
      for (const message of state.queued) {
        if (hasDeliveredReceipt(actor.deliveredChatMessageIds, message.clientMessageId, restoredAt) ||
          hasDeliveredReceipt(actor.deletedChatMessageIds, message.clientMessageId, restoredAt) ||
          actor.pendingChatMessages.has(message.clientMessageId)) continue;
        const entry: PendingChatSend = { message, waiters: [] };
        actor.pendingChatMessages.set(message.clientMessageId, entry);
        actor.chatQueue.push(entry);
      }
      for (const message of state.injecting) {
        if (!hasDeliveredReceipt(actor.deliveredChatMessageIds, message.clientMessageId, restoredAt) &&
          !hasDeliveredReceipt(actor.deletedChatMessageIds, message.clientMessageId, restoredAt)) {
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
          hasDeliveredReceipt(actor.deletedCodexMessageIds, message.clientUserMessageId, restoredAt) ||
          actor.pendingCodexTurns.has(message.clientUserMessageId)) continue;
        const entry: PendingCodexTurn = { message, waiters: [] };
        actor.pendingCodexTurns.set(message.clientUserMessageId, entry);
        actor.codexQueue.push(entry);
      }
      for (const message of state.startingCodex) {
        if (!hasDeliveredReceipt(actor.deliveredCodexMessageIds, message.clientUserMessageId, restoredAt) &&
          !hasDeliveredReceipt(actor.deletedCodexMessageIds, message.clientUserMessageId, restoredAt)) {
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
    const wasWatcher = this.previewWatchers.delete(client);
    for (const [session, actor] of this.actors) {
      actor.focusedBy.delete(client);
      if (actor.runtimeClaim?.client === client) actor.runtimeClaim = null;
      if (actor.subscribers.has(client)) this.unsubscribe(client, session, actor);
    }
    // 最後の watcher の切断で、watch 起因の pump を止める。
    if (wasWatcher) this.syncAllPreviews();
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
    } else if (message.type === "session_processing") {
      if (!this.applyProcessing(message.session, message.state, message.event, message.atMs)) return;
    }
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
    if (message.type === "session_preview_watch") {
      // 一覧 Mission Control: watch 中は処理中会話すべての pane_preview をこの client へ流す。
      const changed = message.enabled
        ? !this.previewWatchers.has(client) && (this.previewWatchers.add(client), true)
        : this.previewWatchers.delete(client);
      if (changed) {
        this.options.log?.(
          `audit preview-watch ${message.enabled ? "start" : "stop"} watchers=${this.previewWatchers.size}`,
        );
        this.syncAllPreviews();
      }
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
        // 注入失敗時の復元用スナップショット（clear 前に取る）。
        const restoreSnapshot: PendingQuestion = actor.pendingQuestion;
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
            .catch((error) => {
              this.options.log?.(`設問回答注入失敗: ${String(error)}`);
              // 自己修復（question-answer-retry）: pendingQuestion を失ったまま TUI ダイアログが
              // 残ると、アプリから再回答する手段が無く会話が詰む。失敗の度に必ず復元し、
              // 「host が設問で止まっている」の権威を保つ（会話を開き直せば emitPendingQuestion が
              // question_prompt を再送し、設問シートが再提示される）。新しい設問が既に来ていれば触らない。
              // prompt の再配信（能動的な再提示）は設問ごとに1回まで: 構造的に注入が通らない
              // ダイアログで「再提示→失敗」を無限に繰り返さない。2回目以降は会話内に
              // system メッセージで状況を伝え、TUI/Mac 側での解消へ倒す。
              if (this.actors.get(message.session) === actor && actor.pendingQuestion === null) {
                const firstFailure = restoreSnapshot.restoredAfterInjectionFailure !== true;
                this.setPendingQuestion(message.session, actor,
                  { ...restoreSnapshot, restoredAfterInjectionFailure: true });
                if (firstFailure) {
                  this.broadcast({
                    type: "question_event", session: message.session, event: "prompt",
                    id: restoreSnapshot.id, questions: restoreSnapshot.questions,
                  });
                } else {
                  // publishCodexMarker は名前こそ codex 由来だが、実体は汎用の
                  // chat_output(system) マーカー発行なのでそのまま使う。
                  this.publishCodexMarker(
                    message.session,
                    `question-inject-error-${restoreSnapshot.id}`,
                    "⚠️ 設問回答の反映に失敗しました。会話を開き直して再回答するか、Mac 側の画面で回答してください。",
                  );
                }
              }
            })
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
      if (hasDeliveredReceipt(actor.deletedCodexMessageIds, message.clientUserMessageId)) {
        this.sendTo(client, {
          type: "codex_turn_result", id: message.id, status: "failed",
          error: "pending_message_deleted",
        });
        return;
      }
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
      if (hasDeliveredReceipt(actor.deletedChatMessageIds, message.clientMessageId)) {
        this.sendTo(client, {
          type: "chat_send_result", id: message.id, status: "failed",
          error: "pending_message_deleted",
        });
        return;
      }
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
    if (message.type === "pending_message_delete") {
      // 対象不在も成功だが、client 保存前 crash で同じ Outbox が復元されても実行しないよう
      // 削除 tombstone は durable に残す。actor 不在でもここだけは軽量 actor を作る。
      const actor = this.actor(message.session);
      if (message.kind === "chat") {
        this.deletePendingChatMessage(client, message.id, message.session, message.clientMessageId, actor);
      } else {
        this.deletePendingCodexTurn(client, message.id, message.session, message.clientMessageId, actor);
      }
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
    if (!this.applyProcessing(message.session, message.state, message.event, message.atMs)) return;
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
    // live-pill Phase 2: 一覧 watcher へ死亡を push する（iOS は「一覧を取り直せ」の合図として使う）。
    // ここは tick の killed/demoted/reclaimed と engine 発 kill が集まる全死亡経路の合流点。
    // actor 不在（購読も処理もされないまま外部で死んだ会話）でも一覧の表示は古くなるため、
    // 下の early return より前で送る。誕生イベントは出さない（一覧は起動時に自分で取り直す）。
    for (const watcher of this.previewWatchers) {
      this.sendTo(watcher, { type: "conversation_liveness", session, alive: false });
    }
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
    actor.deletedChatMessageIds.clear();
    actor.codexQueue.length = 0;
    actor.codexOrder.length = 0;
    actor.pendingCodexTurns.clear();
    actor.startingCodexMessageIds.clear();
    actor.uncertainCodexMessages.clear();
    actor.deletedCodexMessageIds.clear();
    actor.pendingQuestion = null;
    const retiredSubscribers = [...actor.subscribers.keys()];
    actor.focusedBy.clear();
    actor.subscribers.clear();

    this.actors.delete(session);
    this.persistPendingQuestions();
    this.persistChatReceipts();
    // 購読者（engine）へ購読消滅を知らせる（背景購読の台帳同期。一覧向け liveness とは別経路）。
    // actor を消した後に送る: 受け手が同期的に再購読（前面会話の張り直し）しても、消える直前の
    // 古い actor に付いて一緒に捨てられないように（新しい actor が生成される）。
    for (const subscriber of retiredSubscribers) {
      this.sendTo(subscriber, { type: "conversation_retired", session });
    }
  }

  private subscribe(client: object, session: string, afterSeq: number | undefined,
    newerThanMs: number | undefined, preview: boolean): void {
    const actor = this.actor(session);
    // ライブビュー消灯（preview 購読者不在）の事後解析用: 誰がどのフラグで購読したかを残す。
    this.options.log?.(
      `audit subscribe session=${session} preview=${preview}` +
        ` afterSeq=${afterSeq ?? "-"} newerThanMs=${newerThanMs ?? "-"}` +
        ` existing=${actor.subscribers.has(client)} subscribers=${actor.subscribers.size}`,
    );
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
        // preview pump を履歴再生より先に起動する。socket writer 側の優先配送と組み合わせ、
        // pane capture の初回フレームが大量の履歴行の後ろへ並ぶのを防ぐ。
        this.syncPreview(session, actor);
        this.startSharedTail(session, actor, newerThanMs ?? null);
      } else {
        this.syncPreview(session, actor);
      }
      // 会話を開き直したとき（pump は一覧 watch で稼働中）、静止した入力待ちダイアログの
      // フレームは変化しないので再送しないと転写カードが出ない。
      if (preview && !wasPreview) actor.previewPump?.resendLastIfInteractive?.();
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
      return;
    }
    const first = actor.subscribers.size === 0;
    actor.subscribers.set(client, { preview, backfilling: false });
    if (preview) {
      actor.focusedBy.add(client);
      this.bumpSafe(session, "chat-open");
    }
    // 初回 backfill が同期的に多数の行を生成する前に pane capture を開始する。
    this.syncPreview(session, actor);
    if (preview) actor.previewPump?.resendLastIfInteractive?.();
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
    const tail = this.options.tailFactory(
      (payload) => {
        this.publishConversationEvent(session, actor, payload);
      },
      undefined,
      (event) => this.handleClaudeTurnLifecycle(session, actor, event),
    );
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
      lastModel: null,
      subscribedModel: null,
      scanLastModel: null,
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
        // 会話を開いていない間の /model や設定変更は thread/settings/updated が誰にも届かない。
        // resume 応答の現在モデルを backfill 完了後に配信し、開き直しで表示を実体へ揃える。
        state.subscribedModel = snapshot.model ?? null;
        if (!snapshot.liveSubscribed) {
          this.options.log?.(
            `Codex App Server の履歴スナップショットが読めない（turn 前の未materialize か履歴読み取り失敗）ため、rollout fallbackへ移行 session=${session} thread=${threadId}` +
            (snapshot.liveSubscriptionError ? `（理由: ${snapshot.liveSubscriptionError}）` : ""),
          );
          this.startCodexFallback(session, actor, cwd, threadId, newerThanMs, false);
          return;
        }
        state.phase = "backfill";
        this.openCodexRollout(session, actor, cwd, threadId, newerThanMs);
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
  ): void {
    if (this.options.tailFactory === undefined) return;
    const state = actor.codexLive;
    if (state === null) return;
    let tail: HubTail | null = null;
    tail = this.options.tailFactory(
      (payload) => {
        if (actor.codexLive !== state) return;
        const isHistoryDone = payload.type === "chat_output" && payload.streamId === HISTORY_DONE_STREAM_ID;
        const contentKey = chatContentKey(payload);
        const isModelMarker = payload.type === "chat_output" && payload.streamId === CODEX_MODEL_STREAM_ID;

        // rollout の turn_context は「その turn で実際に使ったモデル」の唯一の記録。live 中も
        // fallback 中も本文とは独立に通し、App Server 通知（onModel）と同値なら畳む。
        // token 系 marker は App Server の tokenUsage と意味が異なるため従来どおり混ぜない。
        if (isModelMarker && state.phase !== "backfill") {
          if (state.phase === "fallback-scan") {
            // 再走査は履歴を頭から読み直す。旧 turn のモデルを一度配って戻すのではなく、
            // 走査完了時に最後の値だけを配る。
            state.scanLastModel = payload.text;
            return;
          }
          this.publishCodexModelMarker(session, actor, state, payload.text);
          return;
        }

        if (state.phase === "live") return; // 正常時の live 本文は App Server のみ。

        if (state.phase === "fallback-scan") {
          if (isHistoryDone) {
            state.phase = "fallback-live";
            this.publishCodexModelMarker(session, actor, state, state.scanLastModel);
            state.scanLastModel = null;
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
        if (isModelMarker) state.lastModel = payload.text;
        if (!isHistoryDone) return;
        // 履歴末尾の turn_context より新しい設定変更（turn 未実行）は rollout に無い。
        // 購読時の thread モデルで上書きする（同値なら畳む）。fallback でも resume が
        // 成立していれば同じ。
        const subscribedModel = state.subscribedModel;
        state.subscribedModel = null;
        if (state.disconnected) {
          // fallback 確定前に届いた App Server item は、この継続 rollout と同じ内容を
          // 別 streamId で持ち得る。rollout を唯一の一次ソースにした時点で破棄し、
          // history 完了時に flush して会話全体を二重表示しない。
          state.buffered.length = 0;
          state.phase = "fallback-live"; // この tail は既に同じ EOF 境界にいるので継続利用する。
        } else {
          this.flushCodexBuffer(session, actor, state);
          state.phase = "live";
          // 本文は以後 App Server のみを採用するが、rollout tail 自体は lifecycle の
          // 副監視として残す。ここで止めると、後続 turn の App Server `turn/completed`
          // 欠落時に terminal event（task_complete / turn_aborted）を観測できず、
          // 処理中状態を自己修復できない。
        }
        this.publishCodexModelMarker(session, actor, state, subscribedModel);
      },
      (event) => {
        if (actor.codexLive !== state || event.state !== "done") return;
        if (this.codexTurnController?.reconcileCompletedTurn?.(session, event.turnId) === true) {
          this.options.log?.(
            `Codex rollout terminal event で処理完了を補完 session=${session} turn=${event.turnId}`,
          );
        }
      },
    );
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
    state.scanLastModel = null;
    state.fallbackBaselineCounts = new Map(state.publishedContentCounts);
    this.openCodexRollout(session, actor, cwd, threadId, newerThanMs);
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
    // 離脱→再購読で同じ client オブジェクトが**別の** SubscriberState / tail を持つ。古い
    // backfill の後始末が新しい購読を壊さないよう、自分が始めた分だけを識別して触る。
    const ownState = actor.subscribers.get(client)!;
    ownState.backfilling = true;
    const boundarySeq = actor.nextServerSeq - 1;
    const liveCountsAtStart = new Map(actor.codexLive?.publishedContentCounts ?? []);
    const backfillCounts = new Map<string, number>();
    let completedSynchronously = false;
    let finished = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let tail: HubTail | null = null;
    const clearStallTimer = (): void => {
      if (stallTimer === null) return;
      clearTimeout(stallTimer);
      stallTimer = null;
    };
    const finish = (reason: "history-done" | "stalled" | "open-failed"): void => {
      if (finished) return;
      finished = true;
      clearStallTimer();
      // 自分の tail だけを管理表から外す。停滞タイマーが再購読後に発火した場合、無条件に
      // delete すると**新しい** tail が管理外になり、以後 unsubscribe しても停止できない。
      if (actor.backfillTails.get(client) === tail) actor.backfillTails.delete(client);
      const superseded = actor.subscribers.get(client) !== ownState;
      completedSynchronously = tail === null;
      tail?.stop();
      // 既に離脱済み、または再購読で別の backfill が走っているなら状態は触らない。
      if (superseded) return;
      // 共有 tail の emit 時点でイベントは transcript に存在する。その後 EOF まで読む
      // 履歴 tail に必ず含まれるため、同じ同期処理で live へ切り替えても取りこぼさない。
      ownState.backfilling = false;
      if (reason !== "history-done") {
        this.options.log?.(`audit backfill-force-finish session=${session} reason=${reason}`);
      }
      if (actor.codexLive !== null) {
        // codex は rollout(履歴) と app-server(live) が同じ発話を二重に表すため、履歴側が
        // 何を出したかで打ち消してから境界後を replay する。強制完了で履歴が途中まで進んで
        // いた場合も `backfillCounts` にその分が入っているので、同じ経路が正しく効く。
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
      } else if (reason !== "history-done") {
        // 履歴を最後まで読めていない。境界後のイベントは履歴側に含まれないため replay で補う
        // （止まった backfill が境界後の行まで到達している見込みは薄く、重複表示のリスクより
        // 応答が丸ごと欠ける実害のほうが大きい）。
        for (const event of actor.replayBuffer) {
          if (event.serverSeq <= boundarySeq) continue;
          this.sendTo(client, { type: "conversation_event", session, ...event });
        }
      }
      // 後から加わった client の履歴には、turn を伴わない設定変更（境界前に配信済みの
      // thread/settings/updated）が含まれない。会話の現在モデルを最後に 1 回添えて揃える。
      const currentModel = actor.codexLive?.lastModel ?? null;
      if (currentModel !== null) {
        this.sendTo(client, {
          type: "conversation_event", session, serverSeq: 0, payload: codexModelMarker(currentModel),
        });
      }
    };
    // 進捗は「最後に 1 行流れた時刻」で測る。履歴行ごとに setTimeout を張り替えると
    // 巨大な transcript でタイマー生成が支配的になるため、タイマーは 1 本のまま残時間を見る。
    let lastProgressAt = Date.now();
    const armStallTimer = (delayMs: number): void => {
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (finished) return;
        const remaining = BACKFILL_STALL_TIMEOUT_MS - (Date.now() - lastProgressAt);
        if (remaining > 0) {
          armStallTimer(remaining);
          return;
        }
        finish("stalled");
      }, delayMs);
      stallTimer.unref();
    };
    tail = this.options.tailFactory((payload) => {
      this.sendTo(client, { type: "conversation_event", session, serverSeq: 0, payload });
      lastProgressAt = Date.now();
      const key = chatContentKey(payload);
      if (key !== null) incrementCount(backfillCounts, key);
      if (payload.type === "chat_output" && payload.streamId === HISTORY_DONE_STREAM_ID) finish("history-done");
    });
    if (!completedSynchronously) actor.backfillTails.set(client, tail);
    try {
      tail.open(meta.cwd, meta.providerSessionId ?? meta.claudeSessionId ?? null, newerThanMs, meta.agent ?? "claude");
    } catch (error) {
      // transcript を開けない会話で旗を立てたまま抜けると live 配信が永久に止まる。
      this.options.log?.(`audit backfill-open-failed session=${session} error=${String(error)}`);
      finish("open-failed");
      return;
    }
    if (completedSynchronously) {
      tail.stop();
      return;
    }
    if (!finished) armStallTimer(BACKFILL_STALL_TIMEOUT_MS);
  }

  private canReplay(actor: SessionActor, afterSeq: number): boolean {
    const first = actor.replayBuffer[0]?.serverSeq ?? actor.nextServerSeq;
    const last = actor.nextServerSeq - 1;
    return afterSeq >= first - 1 && afterSeq <= last;
  }

  /** watch 状態・処理中遷移で全 actor の pump 要否を見直す（対象は疎なので全走査で足りる）。 */
  private syncAllPreviews(): void {
    for (const [session, actor] of this.actors) this.syncPreview(session, actor);
  }

  private syncPreview(session: string, actor: SessionActor): void {
    const wantsForeground = [...actor.subscribers.values()].some((state) => state.preview);
    // 一覧 Mission Control: watcher がいる間、処理中会話は前面購読が無くても pump する。
    const wantsWatch = this.previewWatchers.size > 0 && actor.processingSince !== null;
    if (!wantsForeground && !wantsWatch) {
      if (actor.previewPump !== null) this.options.log?.(`audit preview-pump stop session=${session}`);
      actor.previewPump?.stop();
      actor.previewPump = null;
      return;
    }
    if (actor.previewPump !== null || this.options.previewPumpFactory === undefined) return;
    this.options.log?.(`audit preview-pump start session=${session}`);
    const pump = this.options.previewPumpFactory(
      (payload) => {
        const outgoingPayload = reconcileCodexInterruptedPreview(
          payload,
          this.options.metadataStore.get(session)?.agent === "codex",
          actor.processingSince !== null,
        );
        const delivered = new Set<object>();
        for (const [client, state] of actor.subscribers) {
          if (state.preview) {
            this.sendTo(client, {
              type: "conversation_pane_preview",
              session,
              payload: outgoingPayload,
            });
            delivered.add(client);
          }
        }
        // watcher へは処理中の会話だけ流す（前面都合で動く pump のアイドル画面は一覧に不要）。
        // 消灯フレーム（active=false）だけは処理完了直後でも届け、一覧側の表示を確実に落とす。
        const inactiveFrame = outgoingPayload.type === "pane_preview" && !outgoingPayload.active;
        if (actor.processingSince !== null || inactiveFrame) {
          for (const watcher of this.previewWatchers) {
            if (!delivered.has(watcher)) {
              this.sendTo(watcher, {
                type: "conversation_pane_preview",
                session,
                payload: outgoingPayload,
              });
            }
          }
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
      // 前面購読が無い（一覧 watch だけの）間は低頻度で capture し、多重 pump のコストを抑える。
      () => ([...actor.subscribers.values()].some((state) => state.preview) ? 250 : 1000),
    );
    actor.previewPump = pump;
    pump.start(
      session,
      this.options.metadataStore.get(session)?.agent === "codex" ? "codex_terminal" : "claude_status",
      // 処理中の pump 起動（=一覧 watch 起因が典型）は初回フレームから送る。静止 pane
      //（承認ダイアログ等）で一覧カードが空のままになるのを防ぐ。
      { emitInitial: actor.processingSince !== null },
    );
  }

  private actor(session: string): SessionActor {
    let actor = this.actors.get(session);
    if (actor === undefined) {
      actor = { pendingQuestion: null, processingSince: null, processingSinceMs: null, lastInterruptDoneMs: null,
        lastTurnEndMs: null, turnStartFiredAtMs: null, lastTurnStartMs: null,
        focusedBy: new Set(), subscribers: new Map(),
        nextServerSeq: 1, replayBuffer: [], tail: null, tailRetryTimer: null,
        previewPump: null, backfillTails: new Map(),
        seenClientMessageIds: new Set(), deliveredChatMessageIds: new Map(),
        deliveredCodexMessageIds: new Map(),
        deletedChatMessageIds: new Map(), deletedCodexMessageIds: new Map(),
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

  private deletePendingChatMessage(
    client: object,
    requestId: string,
    session: string,
    clientMessageId: string,
    actor: SessionActor,
  ): void {
    if (actor.injectingChatMessageIds.has(clientMessageId) ||
      actor.uncertainChatMessages.has(clientMessageId) ||
      hasDeliveredReceipt(actor.deliveredChatMessageIds, clientMessageId)) {
      this.sendTo(client, {
        type: "pending_message_delete_result", id: requestId, status: "processing",
      });
      return;
    }
    const entry = actor.pendingChatMessages.get(clientMessageId);
    if (entry === undefined) {
      if (!hasDeliveredReceipt(actor.deletedChatMessageIds, clientMessageId)) {
        recordDeliveredReceipt(actor.deletedChatMessageIds, clientMessageId);
        if (!this.persistChatReceipts()) {
          actor.deletedChatMessageIds.delete(clientMessageId);
          this.sendTo(client, {
            type: "pending_message_delete_result",
            id: requestId,
            status: "failed",
            error: "Session Hub missing message delete receipt write failed",
          });
          return;
        }
      }
      this.sendTo(client, {
        type: "pending_message_delete_result", id: requestId, status: "not_found",
      });
      return;
    }
    const previousQueue = actor.chatQueue;
    const previousOrder = actor.chatOrder;
    actor.pendingChatMessages.delete(clientMessageId);
    actor.chatQueue = previousQueue.filter(
      (queued) => queued.message.clientMessageId !== clientMessageId,
    );
    actor.chatOrder = previousOrder.filter((id) => id !== clientMessageId);
    recordDeliveredReceipt(actor.deletedChatMessageIds, clientMessageId);
    if (!this.persistChatReceipts()) {
      actor.deletedChatMessageIds.delete(clientMessageId);
      actor.pendingChatMessages.set(clientMessageId, entry);
      actor.chatQueue = previousQueue;
      actor.chatOrder = previousOrder;
      this.sendTo(client, {
        type: "pending_message_delete_result",
        id: requestId,
        status: "failed",
        error: "Session Hub pending message delete receipt write failed",
      });
      return;
    }
    for (const waiter of entry.waiters) {
      this.sendTo(waiter.client, {
        type: "chat_send_result",
        id: waiter.id,
        status: "failed",
        error: "Message was deleted before processing",
      });
    }
    this.sendTo(client, {
      type: "pending_message_delete_result", id: requestId, status: "deleted",
    });
    actor.chatDrainBlocked = false;
    void this.drainChatQueue(session, actor);
  }

  private deletePendingCodexTurn(
    client: object,
    requestId: string,
    session: string,
    clientMessageId: string,
    actor: SessionActor,
  ): void {
    if (actor.startingCodexMessageIds.has(clientMessageId) ||
      actor.uncertainCodexMessages.has(clientMessageId) ||
      hasDeliveredReceipt(actor.deliveredCodexMessageIds, clientMessageId)) {
      this.sendTo(client, {
        type: "pending_message_delete_result", id: requestId, status: "processing",
      });
      return;
    }
    const entry = actor.pendingCodexTurns.get(clientMessageId);
    if (entry === undefined) {
      if (!hasDeliveredReceipt(actor.deletedCodexMessageIds, clientMessageId)) {
        recordDeliveredReceipt(actor.deletedCodexMessageIds, clientMessageId);
        if (!this.persistChatReceipts()) {
          actor.deletedCodexMessageIds.delete(clientMessageId);
          this.sendTo(client, {
            type: "pending_message_delete_result",
            id: requestId,
            status: "failed",
            error: "Session Hub missing Codex turn delete receipt write failed",
          });
          return;
        }
      }
      this.sendTo(client, {
        type: "pending_message_delete_result", id: requestId, status: "not_found",
      });
      return;
    }
    const previousQueue = actor.codexQueue;
    const previousOrder = actor.codexOrder;
    actor.pendingCodexTurns.delete(clientMessageId);
    actor.codexQueue = previousQueue.filter(
      (queued) => queued.message.clientUserMessageId !== clientMessageId,
    );
    actor.codexOrder = previousOrder.filter((id) => id !== clientMessageId);
    recordDeliveredReceipt(actor.deletedCodexMessageIds, clientMessageId);
    if (!this.persistChatReceipts()) {
      actor.deletedCodexMessageIds.delete(clientMessageId);
      actor.pendingCodexTurns.set(clientMessageId, entry);
      actor.codexQueue = previousQueue;
      actor.codexOrder = previousOrder;
      this.sendTo(client, {
        type: "pending_message_delete_result",
        id: requestId,
        status: "failed",
        error: "Session Hub pending Codex turn delete receipt write failed",
      });
      return;
    }
    for (const waiter of entry.waiters) {
      this.sendTo(waiter.client, {
        type: "codex_turn_result",
        id: waiter.id,
        status: "failed",
        error: "Codex turn was deleted before processing",
      });
    }
    this.sendTo(client, {
      type: "pending_message_delete_result", id: requestId, status: "deleted",
    });
    actor.codexDrainBlocked = false;
    void this.drainCodexQueue(session, actor);
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
          // `/login` 中の門番（LoginCodeError）は 1 キーも送る前の確定拒否 = 非配達が確定している。
          // uncertain（配送不明）に積むと削除不能・後続ブロックのゾンビになるので、失敗として
          // そのまま片付ける。それ以外の注入失敗は従来どおり配送不明として明示再送に倒す。
          const rejectedBeforeSend = error instanceof LoginCodeError;
          if (rejectedBeforeSend) {
            removeOrderedID(actor.chatOrder, message.clientMessageId);
          } else {
            actor.uncertainChatMessages.set(message.clientMessageId, message);
          }
          this.persistChatReceipts();
          // 利用者向け文言だけを出す（`String(error)` は `LoginCodeError: …` と型名が前置される）。
          const userText = rejectedBeforeSend && error instanceof Error ? error.message : String(error);
          for (const waiter of entry.waiters) {
            this.sendTo(waiter.client, {
              type: "chat_send_result", id: waiter.id, status: "failed", error: userText,
            });
          }
          this.publishCodexMarker(session, `chat-send-error-${message.id}`, `⚠️ メッセージ送信失敗: ${userText}`);
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
    const appServer = (this.options.codexAppServerFactory ??
      (() => new CodexAppServerManager({ ...(this.options.log ? { log: this.options.log } : {}) })))();
    const create = this.options.codexTurnControllerFactory ??
      ((options: CodexNativeTurnControllerOptions) => new CodexNativeTurnController(options));
    this.codexTurnController = create({
      appServer,
      log: (message) => this.options.log?.(message),
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
      onThreadTitle: ({ session, threadId, title, source, attempts, error }) => {
        if (error !== null) {
          this.options.log?.(
            `Codex title 生成失敗 session=${session} thread=${threadId} attempts=${attempts}: ${error}`,
          );
          return;
        }
        const attemptSuffix = attempts > 1 ? ` attempts=${attempts}` : "";
        this.options.log?.(
          title === null
            ? `Codex title 生成スキップ session=${session} thread=${threadId}${attemptSuffix}`
            : source === "promptFallback"
              ? `Codex title 先頭文fallback session=${session} thread=${threadId}${attemptSuffix} title=${title}`
              : `Codex title AI生成成功 session=${session} thread=${threadId}${attemptSuffix} title=${title}`,
        );
      },
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
    if (streamId === CODEX_MODEL_STREAM_ID && actor.codexLive !== null) {
      this.publishCodexModelMarker(session, actor, actor.codexLive, text);
      return;
    }
    this.publishConversationEvent(session, actor, {
      type: "chat_output" as const, v: PROTOCOL_V1, streamId, role: "system" as const, text, eof: true,
    });
  }

  /**
   * 利用中モデルの marker を、直前に配信した値と異なるときだけ配信する。App Server 通知
   * （thread/settings/updated / model/rerouted）・rollout の turn_context・購読時の
   * thread モデルは同じ値を別経路で運ぶため、ここで 1 本に畳む。
   */
  private publishCodexModelMarker(
    session: string,
    actor: SessionActor,
    state: CodexLiveState,
    model: string | null,
  ): void {
    if (model === null || model.length === 0 || state.lastModel === model) return;
    state.lastModel = model;
    this.publishConversationEvent(session, actor, codexModelMarker(model));
  }

  /**
   * transcript の中断確定マーカーで処理完了を補完する。Claude Code の Stop hook は利用者の中断
   * （Esc / Ctrl-C）では発火しないため、hook だけでは処理中状態がターン終了後も残り、iOS は
   * 会話を開き直す・再接続するたびに停止ボタン/処理中表示を張り直してしまう（実機 09-02）。
   * 共有 tail は購読の張り直しで履歴から再生されるため、マーカーの timestamp が現ターンの
   * 処理開始時刻以降のものだけを採用する（過去ターンのマーカーで進行中ターンを落とさない）。
   *
   * 時刻の比較根拠: `processingSinceMs` は UserPromptSubmit hook を hub が受信した時刻（ターン
   * 開始。継続 hook では進めない）。中断→即再送信（実測 10〜200ms 後）でも、新ターンの hook
   * 受信は必ずマーカー書込より後（同一マシンの時計・因果順）なので、マーカーは新ターンの開始
   * より古く見えて棄却される。tail がマーカーを hook より先に届けた場合は前ターンを done に
   * し、直後の UserPromptSubmit で active に戻る。中断直後に遅着する Pre/PostToolUse の active
   * は `applyProcessing` が残響として無視する。
   *
   * 副作用は hook の Stop と同じ `applyProcessing("done")` 一式（heartbeat idle。設問提示中なら
   * その dismiss と chat queue の drain）。中断はターン終了なので Stop 後と同じ振る舞い。
   */
  private handleClaudeTurnLifecycle(session: string, actor: SessionActor, event: ClaudeTurnLifecycleEvent): void {
    // API エラー終端（使用量上限 429「You've hit your session limit」等）も中断と同じ扱い: Stop hook が
    // 発火しないままターンが終わるため、hub の処理中状態がそのまま残る（実機 2026-09-07: 制限到達後の
    // 会話が停止ボタン点灯のまま固まり、開き直しても履歴再生が走らず送信が queued で止まった）。
    if (this.actors.get(session) !== actor) return;
    if (this.options.metadataStore.get(session)?.agent === "codex") return;
    if (event.kind === "turn_start") {
      // 発話の観測（履歴再生も含めて最新値を保つ）。処理中状態は動かさない（権威は hook）。
      actor.lastTurnStartMs = Math.max(actor.lastTurnStartMs ?? 0, event.atMs);
      return;
    }
    if (event.kind !== "interrupted" && event.kind !== "api_error") return;
    if (actor.processingSince === null) {
      // 処理中でなくても終端の時刻は覚える: 終端より前に発火した hook（別プロセス起動 + relay で遅着する
      // UserPromptSubmit / Pre・PostToolUse）は既に終わったターンの残響として無視する
      // （late-hook-before-turn-end）。連続 API エラー（実測 2026-09-06: エラー行の 69ms 後に queued 発話が
      // 自動 dequeue され 1.15s 後に再びエラー）で 2 本目のマーカーが新ターンの hook より先に届いても、
      // その hook の発火時刻はマーカーより古いので処理中へ戻さない。
      actor.lastTurnEndMs = Math.max(actor.lastTurnEndMs ?? 0, event.atMs);
      return;
    }
    if (actor.processingSinceMs !== null && event.atMs < actor.processingSinceMs) return;
    this.options.log?.(
      `${event.kind === "api_error" ? "api-error" : "interrupt"} marker で処理完了を補完 session=${session}`,
    );
    actor.lastTurnEndMs = Math.max(actor.lastTurnEndMs ?? 0, event.atMs);
    // 3 秒の残響窓（発火時刻を持たない旧 hook 向けのフォールバック）は利用者の中断だけに武装する。
    // API エラー後は queued 発話の自動 dequeue や task-notification の再開が数十 ms で始まり得る
    // （実測 51〜69ms）ため、窓を張ると生きた新ターンの継続 hook を握り潰して idle へ書き戻す。
    if (event.kind === "interrupted") actor.lastInterruptDoneMs = this.nowMs();
    this.applyProcessing(session, "done");
    this.broadcast({ type: "session_processing", session, state: "done" });
  }

  /** 遅着 hook が直書きした active の heartbeat を idle へ戻す（その hook の書込のままのときだけ）。 */
  private revertLateHookHeartbeat(session: string, event: string | undefined, reason: string): void {
    // 別の書込（新ターンの UserPromptSubmit 等）に置き換わっていれば触らない（生きたターンの reaper
    // 保護を剥がさない）。
    try {
      const latest = readHeartbeat(this.options.heartbeatDir, session);
      if (latest !== null && latest.state === "active" && latest.event === event) {
        writeHeartbeat(this.options.heartbeatDir, session, { ts: this.now(), state: "idle", event: reason });
      }
    } catch (error) { this.options.log?.(`heartbeat 書込失敗: ${String(error)}`); }
  }

  /**
   * 処理中状態を反映する。戻り値 false は「中断済みターンの残響として無視した」（呼び手は
   * broadcast しない）。`event` は hook 名（relay 由来。codex controller / 旧 hook は undefined）。
   */
  private applyProcessing(session: string, state: "active" | "done", event?: string, atMs?: number): boolean {
    const actor = this.actor(session);
    if (state === "active") {
      // 発火時刻付きの hook（hook プロセスの開始時刻。node 起動遅延を含まない）が transcript の最新の
      // ターン終端（中断確定 / API エラー）より前（かつ配送遅延として説明できる古さ）なら、既に終わった
      // ターンの遅着 hook。UserPromptSubmit でも同じ（連続 API エラーで自動 dequeue されたターンの hook
      // が、その終端マーカーより後に届く実測）。処理中（新ターン確定後）に届く古い hook は処理中を
      // 続けるだけなので無視しない。
      // UserPromptSubmit は、終端マーカーより後に新しい発話が transcript に現れていれば新ターン
      // （queued 発話の dequeue）として採用する。発火時刻だけでは「終わったターンの遅着」と
      // 「enqueue 時に発火して dequeue まで待った発話」を区別できないため、transcript を権威にする。
      const newerTurnObserved = actor.lastTurnStartMs !== null && actor.lastTurnEndMs !== null &&
        actor.lastTurnStartMs > actor.lastTurnEndMs;
      if (actor.processingSince === null && atMs !== undefined && actor.lastTurnEndMs !== null &&
        atMs < actor.lastTurnEndMs && actor.lastTurnEndMs - atMs <= LATE_HOOK_MAX_AGE_MS &&
        !(event === "UserPromptSubmit" && newerTurnObserved)) {
        this.options.log?.(
          `audit late-hook-before-turn-end ignored session=${session} event=${event} firedAtMs=${atMs} turnEndMs=${actor.lastTurnEndMs}`,
        );
        // hook が直書きした active の heartbeat も戻す（reaper の bump 代行で不死化させない）。
        this.revertLateHookHeartbeat(session, event, "late-hook-before-turn-end");
        return false;
      }
      // 中断直後に遅着する継続 hook（Pre/PostToolUse）は中断済みターンの残響。hook は別プロセス
      // 起動+relay で 100〜300ms 遅れるため、マーカー書込より後に届き得る。採用すると Stop hook の
      // 無いターンが永久に処理中へ戻る（停止ボタン再点灯）。新ターンの開始は UserPromptSubmit
      // だけが権威（中断→即再送信は通常どおり active）。発火時刻の有無に関わらず 3 秒窓を保つ
      // （Esc で abort されたツールの PostToolUse がマーカーの数百 ms 後に発火し得るため、発火時刻で
      // 窓を狭めない。実機 09-02 の根治を退行させない）。
      if (isContinuationHookEvent(event) && actor.processingSince === null && actor.lastInterruptDoneMs !== null &&
        this.nowMs() - actor.lastInterruptDoneMs < LATE_HOOK_AFTER_INTERRUPT_MS) {
        this.options.log?.(`audit late-hook-after-interrupt ignored session=${session} event=${event}`);
        this.revertLateHookHeartbeat(session, event, "late-hook-after-interrupt");
        return false;
      }
      actor.processingSince = this.now();
      // ターン開始は UserPromptSubmit で確定し、継続 hook では進めない（未確定なら今）。
      if (event === "UserPromptSubmit") actor.turnStartFiredAtMs = atMs ?? null;
      actor.processingSinceMs =
        event === "UserPromptSubmit" || actor.processingSinceMs === null ? this.nowMs() : actor.processingSinceMs;
    } else {
      // 前ターンの Stop が新ターンの UserPromptSubmit より後に届いた（queued 発話の自動 dequeue で
      // 両 hook がほぼ同時に発火し、到着順が入れ替わる）場合、現ターンを落とさない
      // （late-stop-before-turn-start）。発火時刻は現ターンの UserPromptSubmit の発火時刻と比べる
      // （hub 到着時刻と比べると、短いターンの正規の Stop が UserPromptSubmit の到着前に発火して
      // 誤って捨てられる）。
      if (atMs !== undefined && actor.turnStartFiredAtMs !== null && atMs < actor.turnStartFiredAtMs) {
        this.options.log?.(
          `audit late-stop-before-turn-start ignored session=${session} event=${event} firedAtMs=${atMs} turnStartMs=${actor.turnStartFiredAtMs}`,
        );
        // Stop hook は relay より先に heartbeat を idle で直書きする（sinceMs も落ちる）。無視した Stop の
        // 書込のままなら現ターンの active（開始時刻付き）へ戻す（hub 再起動時の復元と reaper 保護を
        // 失わないように）。別の書込に置き換わっていれば触らない。
        try {
          const latest = readHeartbeat(this.options.heartbeatDir, session);
          if (latest !== null && latest.state === "idle" && latest.event === event) {
            writeHeartbeat(this.options.heartbeatDir, session, { ts: this.now(), state: "active",
              event: "hub-processing",
              ...(actor.processingSinceMs !== null ? { sinceMs: actor.processingSinceMs } : {}) });
          }
        } catch (error) { this.options.log?.(`heartbeat 書込失敗: ${String(error)}`); }
        return false;
      }
      actor.processingSince = null;
      actor.processingSinceMs = null;
      actor.turnStartFiredAtMs = null;
    }
    // 一覧 watch 中は処理開始/完了で pump を起動/停止する（前面購読とは独立）。
    this.syncPreview(session, actor);
    try {
      writeHeartbeat(this.options.heartbeatDir, session, { ts: this.now(), state: state === "active" ? "active" : "idle",
        event: state === "active" ? "hub-processing" : "hub-processing-done",
        // 再起動後の中断マーカー照合用に開始時刻を残す（bump は保持する）。
        ...(actor.processingSinceMs !== null ? { sinceMs: actor.processingSinceMs } : {}) });
    } catch (error) { this.options.log?.(`heartbeat 書込失敗: ${String(error)}`); }
    if (state === "done" && actor.pendingQuestion !== null) {
      const id = actor.pendingQuestion.id;
      this.setPendingQuestion(session, actor, null);
      this.broadcast({ type: "question_event", session, event: "dismiss", id });
      void this.drainChatQueue(session, actor);
    }
    return true;
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
      compactDeliveredReceipts(actor.deletedChatMessageIds);
      compactDeliveredReceipts(actor.deletedCodexMessageIds);
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
        actor.deletedChatMessageIds.size === 0 && queuedCodex.length === 0 &&
        startingCodex.length === 0 && actor.deliveredCodexMessageIds.size === 0 &&
        actor.deletedCodexMessageIds.size === 0) continue;
      const sessionIdentity = receiptSessionIdentity(this.options.metadataStore.get(session));
      sessions[session] = {
        ...(sessionIdentity !== undefined ? { sessionIdentity } : {}),
        delivered: [...actor.deliveredChatMessageIds.keys()],
        deliveredAtMs: Object.fromEntries(actor.deliveredChatMessageIds),
        ...(actor.deletedChatMessageIds.size > 0 ? {
          deleted: [...actor.deletedChatMessageIds.keys()],
          deletedAtMs: Object.fromEntries(actor.deletedChatMessageIds),
        } : {}),
        queued, injecting, chatOrder: [...actor.chatOrder],
        deliveredCodex: [...actor.deliveredCodexMessageIds.keys()],
        deliveredCodexAtMs: Object.fromEntries(actor.deliveredCodexMessageIds),
        ...(actor.deletedCodexMessageIds.size > 0 ? {
          deletedCodex: [...actor.deletedCodexMessageIds.keys()],
          deletedCodexAtMs: Object.fromEntries(actor.deletedCodexMessageIds),
        } : {}),
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

/**
 * Codex TUI 0.145 は abort 済みでも `Conversation interrupted` の下に古い
 * `Working (... esc to interrupt)` 行を残すことがある。Hub の turn lifecycle が
 * idle を確定済みなら、その矛盾フレームを消灯へ正規化し、旧 iOS でもライブ表示を
 * 復活させない。番号付き choice prompt など通常の idle pane はそのまま通す。
 */
function reconcileCodexInterruptedPreview(
  payload: ControlMessage,
  isCodex: boolean,
  processing: boolean,
): ControlMessage {
  if (!isCodex || processing || payload.type !== "pane_preview" || !payload.active) return payload;
  const lower = payload.text.toLowerCase();
  const interruptedIndex = lower.lastIndexOf("conversation interrupted");
  const workingIndex = lower.lastIndexOf("esc to interrupt");
  if (interruptedIndex < 0 || workingIndex <= interruptedIndex) return payload;
  // 中断後に新しい user prompt が在れば、その下の Working は新 turn の正当な表示。
  // stale 事例は interrupted → Working が直結し、入力欄プレースホルダは Working の後ろに在る。
  const between = lower.slice(interruptedIndex, workingIndex);
  if (/^[ \t]*[›❯][ \t]*\S/mu.test(between)) return payload;
  return { ...payload, active: false, text: "" };
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
  deleted?: string[];
  deletedAtMs?: Record<string, number>;
  queued: Array<Extract<HubClientMessage, { type: "chat_send" }>>;
  injecting: Array<Extract<HubClientMessage, { type: "chat_send" }>>;
  chatOrder?: string[];
  deliveredCodex: string[];
  deliveredCodexAtMs?: Record<string, number>;
  deletedCodex?: string[];
  deletedCodexAtMs?: Record<string, number>;
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
    (record["deleted"] !== undefined && (!Array.isArray(record["deleted"]) ||
      !record["deleted"].every((id) => typeof id === "string" && id.length > 0))) ||
    !Array.isArray(record["queued"]) || !Array.isArray(record["injecting"]) ||
    !Array.isArray(record["deliveredCodex"]) ||
    !record["deliveredCodex"].every((id) => typeof id === "string" && id.length > 0) ||
    (record["deletedCodex"] !== undefined && (!Array.isArray(record["deletedCodex"]) ||
      !record["deletedCodex"].every((id) => typeof id === "string" && id.length > 0))) ||
    !Array.isArray(record["startingCodex"])) return false;
  if (!isOptionalTimestampRecord(record["deliveredAtMs"]) ||
    !isOptionalTimestampRecord(record["deletedAtMs"]) ||
    !isOptionalTimestampRecord(record["deliveredCodexAtMs"]) ||
    !isOptionalTimestampRecord(record["deletedCodexAtMs"]) ||
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

/** 利用中モデル通知（`pc:model`）の conversation_event payload。 */
function codexModelMarker(model: string): ControlMessage {
  return {
    type: "chat_output", v: PROTOCOL_V1, streamId: CODEX_MODEL_STREAM_ID,
    role: "system", text: model, eof: true,
  };
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
