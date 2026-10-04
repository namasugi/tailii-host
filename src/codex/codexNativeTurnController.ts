// Codex App Server の長寿命 thread 接続、native approval、turn/start を Tailii へ結線する。

import { randomBytes } from "node:crypto";
import * as net from "node:net";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerThreadOptions,
  CodexThreadTitleGenerationResult,
  CodexThreadTitleSource,
} from "./codexAppServer.js";
import { codexGoalFromWire, codexItemTurnId } from "./codexAppServer.js";
import {
  decodeControlMessage,
  encodeControlMessage,
  PROTOCOL_V1,
  PROTOCOL_V2,
  type CodexCollaborationMode,
  type CodexGoalAction,
  type CodexGoalInfo,
  type Decision,
  type QuestionAnswer,
  type QuestionPromptQuestion,
} from "../protocol.js";
import type { ControlMessage } from "../protocol.js";
import { codexPlanChatOutput } from "./codexPlanItem.js";
import { resolveSocketPath } from "../shared/socketPath.js";
import { sleep } from "../shared/sleep.js";
import {
  codexItemToolActivities,
  codexPlanUpdateActivity,
  toolActivityContentKey,
  toolActivityMessage,
} from "./codexToolActivity.js";
import { CodexSubagentTracker } from "./codexSubagentTracker.js";
import {
  codexAppServerSystemNotice,
  codexCollaborationModeSteerNotice,
  codexDeprecationNoticeLogLine,
  codexGoalClearedNotice,
  codexGoalNotice,
  codexGoalNoticeKey,
  codexAsyncAnswerFailedNotice,
  codexMcpItemErrorNotice,
  codexSystemNoticeContentKey,
} from "./codexSystemNotice.js";
import {
  CODEX_ASYNC_QUESTION_ID_PREFIX,
  codexAsyncQuestionItem,
  codexAsyncQuestionReplyDisplayText,
  codexAsyncQuestionReplyTargets,
  codexAsyncQuestionReplyText,
  type CodexAsyncQuestion,
  type CodexAsyncQuestionReply,
} from "./codexAsyncQuestion.js";

const TITLE_GENERATION_MAX_ATTEMPTS = 3;
const TITLE_GENERATION_RETRY_BASE_MS = 250;
/** 記録済み deprecationNotice 文言の保持上限。 */
const DEPRECATION_NOTICE_LOG_CAP = 64;

export interface CodexNativeApproval {
  id: string;
  session: string;
  tool: string;
  summary: string;
  cwd: string;
}

export type CodexApprovalBroker = (approval: CodexNativeApproval) => Promise<Decision>;

export interface CodexNativeTurnControllerOptions {
  appServer: CodexAppServerThreadRuntime;
  approvalBroker?: CodexApprovalBroker;
  onProcessing?: (session: string, state: "active" | "done") => void;
  onModel?: (session: string, model: string) => void;
  onTokenUsage?: (
    session: string,
    totalTokens: number,
    contextWindow: number | null,
  ) => void;
  onQuestion?: (event: {
    session: string;
    id: string;
    questions: QuestionPromptQuestion[];
  }) => void;
  onQuestionDismiss?: (session: string, id: string) => void;
  /** 非同期質問の設問 id に入れる起動ごとの値（テストで固定する。既定は乱数）。 */
  asyncPromptNonce?: string;
  onChatItem?: (event: { session: string; itemId: string; payload: ControlMessage }) => void;
  /**
   * 目標の現在値（codex-goal）。`thread/goal/updated` / `cleared`、goal RPC の結果、会話オープン時の
   * 読み取りから配る。null は「目標なし」。Hub は会話 stream（codex_goal_state）へ流し、目標が
   * active な間は購読者ゼロでも thread 購読を保持する（継続 turn は server 起点のため）。
   */
  onGoal?: (session: string, goal: CodexGoalInfo | null) => void;
  /** thread の collaboration mode（`thread/settings/updated`）。Hub は `pc:collab` マーカーで iOS へ配る。 */
  onCollaborationMode?: (session: string, mode: CodexCollaborationMode) => void;
  onDisconnect?: (session: string, error: Error) => void;
  onThreadTitle?: (event: {
    session: string;
    threadId: string;
    title: string | null;
    source: CodexThreadTitleSource | null;
    attempts: number;
    error: string | null;
  }) => void;
  /** 診断ログ（hub.log）。App Server の deprecationNotice など利用者へ見せない通知を記録する。 */
  log?: (message: string) => void;
}

export interface CodexTurnControllerRuntime {
  subscribeSession?(options: {
    session: string;
    threadId: string;
    cwd: string;
  }): Promise<CodexSubscriptionSnapshot>;
  startTurn(options: {
    session: string;
    threadId: string;
    cwd: string;
    text: string;
    clientUserMessageId?: string | null;
    effort?: string | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
    approvalPolicy?: CodexAppServerApprovalPolicy | null;
    /** collaboration mode（プランモード, codex-plan-mode）。未指定は thread の現状のまま。 */
    collaborationMode?: CodexCollaborationMode | null;
  }): Promise<string>;
  interruptTurn?(session: string): Promise<void>;
  /** 目標の読み取り / 設定 / 解除（codex-goal）。thread を開いていなければ開いてから実行する。 */
  goal?(options: CodexGoalOperation): Promise<CodexGoalOperationResult>;
  /** 目標が active な会話か（Hub が購読者ゼロでも thread 購読を保持する判定）。 */
  hasActiveGoal?(session: string): boolean;
  /**
   * rollout の terminal event（task_complete / turn_aborted）を、現在追跡中の
   * 同一 turn に限って完了へ反映する。App Server の turn/completed 通知欠落を補う副経路。
   */
  reconcileCompletedTurn?(session: string, turnId: string): boolean;
  closeSession(session: string): void;
  close(): void;
  answerQuestion?(id: string, answers: QuestionAnswer[]): boolean;
}

export interface CodexThreadClient {
  readonly initialItems?: readonly Record<string, unknown>[];
  readonly initialActiveTurnId?: string | null;
  /** false は turn 履歴が未生成で購読時の履歴スナップショットが読めず、live 通知を保証できない接続。 */
  readonly liveSubscriptionReady?: boolean;
  /** liveSubscriptionReady=false の理由（診断ログ用）。 */
  readonly liveSubscriptionError?: string | null;
  /** 購読時点の thread のモデル（thread/resume / thread/start 応答）。不明なら null。 */
  readonly model?: string | null;
  /**
   * 保存済み thread から現在の turn ID を読み直す。
   * undefined は rollout 未生成で、App Server からまだ確認できない状態を表す。
   */
  readActiveTurnId?(): Promise<string | null | undefined>;
  /** 履歴復元時に、各 sub-agent thread 自身の現在状態と安定した開始時刻を確認する。 */
  readThreadStatus?(threadId: string): Promise<{
    status: unknown;
    timestampMs?: number;
    /** 子 thread の実行モデル（thread/read の Thread.model）。無ければ省略。 */
    model?: string;
  } | undefined>;
  startTurn(
    text: string,
    clientUserMessageId?: string | null,
    effort?: string | null,
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null,
    approvalPolicy?: CodexAppServerApprovalPolicy | null,
    collaborationMode?: CodexCollaborationMode | null,
  ): Promise<string>;
  steerTurn(
    turnId: string,
    text: string,
    clientUserMessageId?: string | null,
  ): Promise<void>;
  interruptTurn(turnId: string): Promise<void>;
  /** `thread/settings/updated` の取り込み（モデル / effort / collaboration mode の追従, codex-plan-mode）。 */
  noteThreadSettings?(settings: Record<string, unknown>): void;
  /** この接続で最後に観測 / 送信した collaboration mode（server の thread 設定に残る値）。不明は null。 */
  readonly collaborationMode?: CodexCollaborationMode | null;
  /** plan 直前の model / effort（default 復帰で戻す値）。plan 中でなければ null。未対応は undefined。 */
  readonly planRestoreSnapshot?: CodexPlanRestoreSnapshot | null;
  /** 接続を作り直したときに controller が預かっていた plan 直前の値を引き継ぐ（既にあれば上書きしない）。 */
  seedPlanRestoreSnapshot?(snapshot: CodexPlanRestoreSnapshot): void;
  /** `model/rerouted` 等のモデルだけの変更の取り込み。 */
  noteModel?(model: string): void;
  /** 目標 API（codex-goal）。旧 App Server / テスト fake では未提供。 */
  goalGet?(): Promise<CodexGoalInfo | null>;
  goalSet?(params: { objective?: string; status?: string; tokenBudget?: number }): Promise<CodexGoalInfo>;
  goalClear?(): Promise<boolean>;
  close(): void;
}

/** plan に入る直前の thread 設定（default 復帰で戻す, codex-plan-mode）。 */
export interface CodexPlanRestoreSnapshot {
  model: string | null;
  effort: string | null;
}

/** 目標操作の入力（Hub の `codex_goal_submit` と同形）。 */
export interface CodexGoalOperation {
  session: string;
  threadId: string;
  cwd: string;
  action: CodexGoalAction;
  objective?: string;
  status?: string;
  tokenBudget?: number;
}

export interface CodexGoalOperationResult {
  /** 操作後の現在値（clear 後や未設定は null）。 */
  goal: CodexGoalInfo | null;
  /** clear の結果（server が何かを消したか）。 */
  cleared?: boolean;
}

export interface CodexSubscriptionSnapshot {
  itemIds: ReadonlySet<string>;
  contentCounts: ReadonlyMap<string, number>;
  /** false の場合、Hub は初回 turn を rollout の継続 tail で表示する。 */
  liveSubscribed: boolean;
  /** liveSubscribed=false の理由（履歴読み取りの失敗文言）。 */
  liveSubscriptionError?: string | null;
  /**
   * 購読時点で thread に設定されているモデル。Hub は履歴 backfill の後に `pc:model` として
   * 配信し、会話を開いていない間の変更（thread/settings/updated が届かない）を開き直しで
   * 反映する。null は不明（未materialize で resume が成立しない・旧 App Server）。
   */
  model?: string | null;
  /**
   * 購読時点で thread に残っている collaboration mode（controller が観測 / 送信した値。codex-plan-mode）。
   * Hub は backfill 完了後に `pc:collab` として配り、iOS のトグルを実体へ揃える。null は不明。
   */
  collaborationMode?: CodexCollaborationMode | null;
}

export interface CodexAppServerThreadRuntime {
  openThread(options: CodexAppServerThreadOptions): Promise<CodexThreadClient>;
  generateThreadTitle?(options: {
    threadId: string;
    cwd: string;
    prompt: string;
  }): Promise<CodexThreadTitleGenerationResult>;
}

function isDefinitiveSteerRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return [
    "no active turn to steer",
    "expected active turn id",
    "cannot steer a review turn",
    "cannot steer a compact turn",
    "active turn not steerable",
    "turn already completed",
    "turn has already completed",
  ].some((marker) => message.includes(marker));
}

/** App Server の競合エラーから、その時点で実際に active だった turn ID を取り出す。 */
function activeTurnIdFromMismatch(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(
    /expected active turn id [A-Za-z0-9_-]+ but found ([A-Za-z0-9_-]+)/i,
  );
  return match?.[1] ?? null;
}

/** Codex thread ID はUUIDv7。先頭48bitのUnixミリ秒を履歴snapshotの安定時刻に使う。 */
function codexThreadIdTimestampMs(threadId: string): number | null {
  const compact = threadId.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(compact) || compact[12]?.toLowerCase() !== "7") return null;
  const value = Number.parseInt(compact.slice(0, 12), 16);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface OpenThread {
  threadId: string;
  cwd: string;
  thread: CodexThreadClient;
  items: Map<string, Record<string, unknown>>;
  activeTurnId: string | null;
  /** この controller の最初のユーザー入力成功後に一度だけ命名を試す。既存名はApp Server側で保護する。 */
  titleGenerationPending: boolean;
  /** turn/plan/updated へ振る連番（通知に item id が無いため dedup 用 id を合成する）。 */
  planSeq: number;
  /** App Server の collab/thread lifecycle を Tailii 共通の workflow node へ合流する。 */
  subagents: CodexSubagentTracker;
  /** subagent_node は同じ collab item から状態更新を複数回流すため専用連番で dedup する。 */
  subagentSeq: number;
  /** 目標の現在値（codex-goal）。open 時に `thread/goal/get` で読み、通知と RPC 結果で追従する。 */
  goal: CodexGoalInfo | null;
  /** 直近に注記した目標の照合キー（状態 / 内容が変わったときだけ 🎯 注記を出す）。null は未確定。 */
  goalNoticeKey: string | null;
}

interface PendingUserInput {
  session: string;
  threadId: string;
  questions: Record<string, unknown>[];
  resolve: (response: unknown) => void;
}

/**
 * 未回答の非同期質問（codex-async-question）。turn は止まらないので App Server の request ではなく、
 * 回答は通常のユーザー入力（封筒）として steer で送る。会話ごとに未回答分をまとめて 1 枚の設問として
 * iOS へ出す（hub の未回答の設問は会話に 1 つなので、後から来た質問は前の分と束ねて出し直す）。
 */
interface PendingAsyncQuestions {
  threadId: string;
  entries: { itemId: string; question: CodexAsyncQuestion }[];
  /** いま iOS へ出している設問 id。null は未提示（止まる設問の表示中など）。 */
  promptId: string | null;
  /**
   * 提示中の設問に載せた質問（提示した時点の写し）。回答の questionIndex はこの並びを指す。質問の並びが
   * 1 件でも変われば設問 id を変えるので、hub が受理する回答は必ずこの写しと同じ並びに対するもの。
   */
  presentedEntries: { itemId: string; question: CodexAsyncQuestion }[];
  /** 提示中の内容の照合キー（同じ内容の出し直しを省く）。 */
  presentedKey: string | null;
  /** 一度受け取った item（同じ item/completed の再送や、回答済みの質問を出し直さない）。 */
  seenItemIds: Set<string>;
  /** 回答の封筒で回答済みと分かった質問（`itemId#index`、旧形式は item id だけ）。 */
  answeredKeys: Set<string>;
}

/** 非同期質問 1 件の照合キー（`itemId#index`）。 */
function asyncEntryKey(entry: { itemId: string; question: CodexAsyncQuestion }): string {
  return `${entry.itemId}#${entry.question.index}`;
}

function isAnsweredAsyncEntry(
  pending: PendingAsyncQuestions,
  entry: { itemId: string; question: CodexAsyncQuestion },
): boolean {
  return pending.answeredKeys.has(entry.itemId) || pending.answeredKeys.has(asyncEntryKey(entry));
}

/**
 * Tailii から開始した Codex turn を同じ App Server 接続で保持する。
 * server-initiated approval は既存 per-session serve socket へ渡すため、Codex hook は不要。
 */
export class CodexNativeTurnController implements CodexTurnControllerRuntime {
  private readonly appServer: CodexAppServerThreadRuntime;
  private readonly approvalBroker: CodexApprovalBroker;
  private readonly onProcessing: (session: string, state: "active" | "done") => void;
  private readonly onModel: NonNullable<CodexNativeTurnControllerOptions["onModel"]>;
  private readonly onTokenUsage: NonNullable<
    CodexNativeTurnControllerOptions["onTokenUsage"]
  >;
  private readonly onQuestion: NonNullable<CodexNativeTurnControllerOptions["onQuestion"]>;
  private readonly onQuestionDismiss: NonNullable<
    CodexNativeTurnControllerOptions["onQuestionDismiss"]
  >;
  private readonly onChatItem: NonNullable<CodexNativeTurnControllerOptions["onChatItem"]>;
  private readonly onGoal: NonNullable<CodexNativeTurnControllerOptions["onGoal"]>;
  private readonly onCollaborationMode: NonNullable<
    CodexNativeTurnControllerOptions["onCollaborationMode"]
  >;
  private readonly onDisconnect: NonNullable<CodexNativeTurnControllerOptions["onDisconnect"]>;
  private readonly onThreadTitle: NonNullable<CodexNativeTurnControllerOptions["onThreadTitle"]>;
  private readonly log: (message: string) => void;
  /** 同文の deprecationNotice は process 内で 1 回だけ記録する（thread を開くたびに届く）。 */
  private readonly loggedDeprecationNotices = new Set<string>();
  private readonly open = new Map<string, OpenThread>();
  /** session ごとの開始中 Promise（threadFor の同時呼び出しを 1 回の open に畳む）。 */
  private readonly opening = new Map<string, { threadId: string; task: Promise<OpenThread> }>();
  /**
   * plan に入る直前の model / effort（codex-plan-mode）。thread 接続は購読者ゼロで畳まれるため、接続を
   * 作り直しても default 復帰で元の値へ戻せるよう controller が session 単位で預かる（hub 再起動では失う）。
   */
  private readonly planRestoreBySession = new Map<string, { threadId: string; snapshot: CodexPlanRestoreSnapshot }>();
  /** 開始中（opening）に close を要求された session。開き終わった時点で畳む。 */
  private readonly closeRequestedWhileOpening = new Set<string>();
  private readonly pendingUserInput = new Map<string, PendingUserInput>();
  /** session → 未回答の非同期質問（codex-async-question）。 */
  private readonly pendingAsyncQuestions = new Map<string, PendingAsyncQuestions>();
  /** 非同期質問の設問 id の通し番号（質問の並びが変わるたびに新しい id にする）。 */
  private asyncPromptSeq = 0;
  /**
   * 設問 id に入れる起動ごとの値。通し番号は hub の再起動で 1 に戻るので、これが無いと再起動前に iOS が
   * 出した回答の自動再送が、復元後の別の並びの設問 id と一致して受理されてしまう。
   */
  private readonly asyncPromptNonce: string;

  private rememberPlanRestoreSnapshot(session: string, threadId: string, thread: CodexThreadClient): void {
    const snapshot = thread.planRestoreSnapshot;
    if (snapshot === undefined) return;
    if (snapshot === null) this.planRestoreBySession.delete(session);
    else this.planRestoreBySession.set(session, { threadId, snapshot });
  }

  constructor(options: CodexNativeTurnControllerOptions) {
    this.appServer = options.appServer;
    this.approvalBroker = options.approvalBroker ?? requestCodexApprovalViaBroker;
    this.onProcessing = options.onProcessing ?? (() => {});
    this.onModel = options.onModel ?? (() => {});
    this.onTokenUsage = options.onTokenUsage ?? (() => {});
    this.onQuestion = options.onQuestion ?? (() => {});
    this.onQuestionDismiss = options.onQuestionDismiss ?? (() => {});
    this.asyncPromptNonce = options.asyncPromptNonce ?? randomBytes(3).toString("hex");
    this.onChatItem = options.onChatItem ?? (() => {});
    this.onGoal = options.onGoal ?? (() => {});
    this.onCollaborationMode = options.onCollaborationMode ?? (() => {});
    this.onDisconnect = options.onDisconnect ?? (() => {});
    this.onThreadTitle = options.onThreadTitle ?? (() => {});
    this.log = options.log ?? (() => {});
  }

  async subscribeSession(options: {
    session: string;
    threadId: string;
    cwd: string;
  }): Promise<CodexSubscriptionSnapshot> {
    const opened = await this.threadFor(options.session, options.threadId, options.cwd, "subscribe");
    const itemIds = new Set<string>();
    const contentCounts = new Map<string, number>();
    for (const item of opened.thread.initialItems ?? []) {
      const id = item["id"];
      if (typeof id === "string" && id.length > 0) itemIds.add(id);
      const payloads = [codexItemToChatOutput(item), codexMcpItemErrorNotice(item)?.payload];
      for (const payload of payloads) {
        const key = payload === null || payload === undefined ? null : chatContentKey(payload);
        if (key !== null) contentCounts.set(key, (contentCounts.get(key) ?? 0) + 1);
      }
    }
    // 目標の現在値は購読のたびに配る（既存 thread の再利用 = 開き直し / 再接続 / 別端末でも届く。
    // null も配って、開いていない間に解除された目標の古い表示を消す）。
    this.onGoal(options.session, opened.goal);
    return {
      itemIds,
      contentCounts,
      liveSubscribed: opened.thread.liveSubscriptionReady !== false,
      liveSubscriptionError: opened.thread.liveSubscriptionError ?? null,
      model: opened.thread.model ?? null,
      collaborationMode: opened.thread.collaborationMode ?? null,
    };
  }

  async startTurn(options: {
    session: string;
    threadId: string;
    cwd: string;
    text: string;
    clientUserMessageId?: string | null;
    effort?: string | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
    approvalPolicy?: CodexAppServerApprovalPolicy | null;
    collaborationMode?: CodexCollaborationMode | null;
  }): Promise<string> {
    const opened = await this.threadFor(options.session, options.threadId, options.cwd);
    this.onProcessing(options.session, "active");
    try {
      // 未materialize fallback 接続は、別 client の実行中 turn を初期 snapshot で
      // 復元できない。新規 turn/start の前に rollout を読み直し、既存 turn が
      // materialize 済みなら steer へ戻す。undefined（まだ未生成）だけは従来どおり開始する。
      if (opened.activeTurnId === null && opened.thread.liveSubscriptionReady === false) {
        const refreshedTurnId = await opened.thread.readActiveTurnId?.();
        if (refreshedTurnId !== undefined) opened.activeTurnId = refreshedTurnId;
      }
      const activeTurnId = opened.activeTurnId;
      if (activeTurnId !== null) {
        try {
          await opened.thread.steerTurn(
            activeTurnId,
            options.text,
            options.clientUserMessageId,
          );
          this.noteCollaborationModeNotAppliedBySteer(options.session, opened, activeTurnId, options.collaborationMode);
          this.generateThreadTitle(opened, options.session, options.text);
          return activeTurnId;
        } catch (error) {
          // 接続切替などでローカル ID だけが古い場合、App Server は未受理を明示しつつ
          // 実際の active ID を返す。同じ入力をその turn へ一度だけ steer し直せる。
          const currentTurnId = activeTurnIdFromMismatch(error);
          if (currentTurnId !== null && currentTurnId !== activeTurnId) {
            opened.activeTurnId = currentTurnId;
            await opened.thread.steerTurn(
              currentTurnId,
              options.text,
              options.clientUserMessageId,
            );
            this.noteCollaborationModeNotAppliedBySteer(options.session, opened, currentTurnId, options.collaborationMode);
            this.generateThreadTitle(opened, options.session, options.text);
            return currentTurnId;
          }
          // App Serverが明示的に「このturnへはsteerできない」と拒否した場合だけ、新規turnへ
          // 切り替える。timeout/切断はsteer受理済みか不明なので、turn/startすると二重実行に
          // なり得る。到達不明は上位へ返し、clientUserMessageId receiptで後から確定させる。
          if (!isDefinitiveSteerRejection(error)) throw error;
        }
      }
      // 実行中 turn への steer は入力を足すだけで collaboration mode は変えられない（上の steer 経路）。
      // 新規 turn だけが iOS のトグルどおりの mode で始まる。
      const turnId = await opened.thread.startTurn(
        options.text,
        options.clientUserMessageId,
        options.effort,
        options.sandbox,
        options.approvalPolicy,
        options.collaborationMode ?? null,
      );
      opened.activeTurnId = turnId;
      this.generateThreadTitle(opened, options.session, options.text);
      return turnId;
    } catch (error) {
      this.onProcessing(options.session, "done");
      throw error;
    }
  }

  /**
   * 実行中 turn への steer は collaboration mode を変えられない（turn/steer に mode 引数が無い）。iOS の
   * トグルと違う mode の turn が走っている間の送信は、そのまま steer しつつ注記で知らせる（次の新規 turn
   * から反映される）。thread の現 mode が不明な接続（テスト fake / 旧 server）では判定できないので黙る。
   */
  private noteCollaborationModeNotAppliedBySteer(
    session: string,
    opened: OpenThread,
    turnId: string,
    requested: CodexCollaborationMode | null | undefined,
  ): void {
    if (!requested) return;
    const current = opened.thread.collaborationMode;
    if (current === undefined || current === null || current === requested) return;
    const notice = codexCollaborationModeSteerNotice(requested, turnId);
    this.onChatItem({ session, itemId: notice.itemId, payload: notice.payload });
  }

  /** 目標の読み取り / 設定 / 解除（codex-goal）。結果は通知と同じ経路（onGoal / 注記）にも反映する。 */
  async goal(options: CodexGoalOperation): Promise<CodexGoalOperationResult> {
    const opened = await this.threadFor(options.session, options.threadId, options.cwd);
    const thread = opened.thread;
    if (options.action === "get") {
      if (thread.goalGet === undefined) throw new Error("この Codex App Server は目標（goal）に対応していません");
      const goal = await thread.goalGet();
      this.applyGoal(options.session, opened, goal, { publishState: true });
      return { goal };
    }
    if (options.action === "clear") {
      if (thread.goalClear === undefined) throw new Error("この Codex App Server は目標（goal）に対応していません");
      const cleared = await thread.goalClear();
      this.applyGoal(options.session, opened, null, { publishState: true });
      return { goal: null, cleared };
    }
    if (thread.goalSet === undefined) throw new Error("この Codex App Server は目標（goal）に対応していません");
    const goal = await thread.goalSet({
      ...(options.objective !== undefined ? { objective: options.objective } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    });
    this.applyGoal(options.session, opened, goal, { publishState: true });
    return { goal };
  }

  hasActiveGoal(session: string): boolean {
    return this.open.get(session)?.goal?.status === "active";
  }

  /**
   * 目標の現在値を取り込む。状態 / 内容が変わったときだけ 🎯 注記を chat へ出し（進捗だけの更新では
   * 出さない）、必要なら onGoal で Hub へ配る。open 直後の初回読み取りは注記を出さない（履歴側の
   * rollout 注記と二重になるため）。
   */
  private applyGoal(
    session: string,
    opened: OpenThread,
    goal: CodexGoalInfo | null,
    options: { publishState: boolean; initial?: boolean },
  ): void {
    const key = codexGoalNoticeKey(goal);
    const changed = opened.goalNoticeKey !== key;
    const previousCreatedAt = opened.goal?.createdAt ?? null;
    opened.goal = goal;
    // 注記は「変化」だけ。初回読み取り（履歴の rollout 注記と二重になる）と、目標を一度も見ていない
    // 状態での「解除」（意味が無い）は出さない。
    const knownBefore = opened.goalNoticeKey !== null;
    if (changed && options.initial !== true && (goal !== null || knownBefore)) {
      const notice = goal === null ? codexGoalClearedNotice(previousCreatedAt) : codexGoalNotice(goal);
      this.onChatItem({ session, itemId: notice.itemId, payload: notice.payload });
    }
    opened.goalNoticeKey = key;
    if (options.publishState) this.onGoal(session, goal);
  }

  /**
   * open 直後に現在の目標を読む（失敗は無視: 旧 server / ephemeral thread は未対応）。threadFor が
   * await するので、購読直後に購読者がいなくなっても hasActiveGoal が「未読」で false を返さない。
   */
  private async loadGoal(session: string, opened: OpenThread): Promise<void> {
    if (opened.thread.goalGet === undefined) return;
    try {
      const goal = await opened.thread.goalGet();
      if (this.open.get(session) !== opened) return;
      // 通知（thread/goal/updated）が先に届いて確定済みなら上書きしない。
      if (opened.goalNoticeKey !== null) return;
      // 配信は購読確立（subscribeSession）側で行う: 開き直しで既存 thread を再利用する場合も必ず 1 回届く。
      this.applyGoal(session, opened, goal, { publishState: false, initial: true });
    } catch (error) {
      this.log(`Codex 目標の読み取りに失敗（無視） session=${session}: ${String(error)}`);
    }
  }

  private generateThreadTitle(opened: OpenThread, session: string, prompt: string): void {
    if (!opened.titleGenerationPending || this.appServer.generateThreadTitle === undefined) return;
    opened.titleGenerationPending = false;
    void this.generateThreadTitleWithRetry({
      threadId: opened.threadId,
      cwd: opened.cwd,
      prompt,
    }).then(
      ({ result, attempts }) => this.onThreadTitle({
        session,
        threadId: opened.threadId,
        title: result.title,
        source: result.source,
        attempts,
        error: null,
      }),
      (error) => this.onThreadTitle({
        session,
        threadId: opened.threadId,
        title: null,
        source: null,
        attempts: TITLE_GENERATION_MAX_ATTEMPTS,
        error: String(error),
      }),
    );
  }

  private async generateThreadTitleWithRetry(options: {
    threadId: string;
    cwd: string;
    prompt: string;
  }): Promise<{ result: CodexThreadTitleGenerationResult; attempts: number }> {
    const generate = this.appServer.generateThreadTitle;
    if (generate === undefined) {
      return { result: { title: null, source: null }, attempts: 0 };
    }
    let lastError: unknown = new Error("Codex title generation did not run");
    for (let attempt = 1; attempt <= TITLE_GENERATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        return { result: await generate.call(this.appServer, options), attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < TITLE_GENERATION_MAX_ATTEMPTS) {
          await sleep(TITLE_GENERATION_RETRY_BASE_MS * attempt);
        }
      }
    }
    throw new Error(
      `Codex title generation failed after ${TITLE_GENERATION_MAX_ATTEMPTS} attempts: ${String(lastError)}`,
    );
  }

  async interruptTurn(session: string): Promise<void> {
    const opened = this.open.get(session);
    if (opened === undefined) return;
    if (opened.activeTurnId === null && opened.thread.liveSubscriptionReady === false) {
      const refreshedTurnId = await opened.thread.readActiveTurnId?.();
      if (refreshedTurnId !== undefined) opened.activeTurnId = refreshedTurnId;
    }
    const activeTurnId = opened.activeTurnId;
    if (activeTurnId === null) return;
    try {
      await opened.thread.interruptTurn(activeTurnId);
    } catch (error) {
      // 中断要求は「このセッションの現在の turn を止める」という利用者操作なので、
      // App Server が返した実 ID へ同期して一度だけ再試行する。二度目の失敗は伝播する。
      const currentTurnId = activeTurnIdFromMismatch(error);
      if (currentTurnId === null || currentTurnId === activeTurnId) throw error;
      opened.activeTurnId = currentTurnId;
      await opened.thread.interruptTurn(currentTurnId);
    }
  }

  reconcileCompletedTurn(session: string, turnId: string): boolean {
    const opened = this.open.get(session);
    if (opened === undefined || opened.activeTurnId !== turnId) return false;
    opened.activeTurnId = null;
    this.onProcessing(session, "done");
    this.resolvePendingQuestionsForSession(session);
    return true;
  }

  closeSession(session: string): void {
    const opened = this.open.get(session);
    if (opened === undefined) {
      // 開いている途中なら、開き終わった時点で畳む（openThread の完了を待たずに孤児接続を作らない）。
      if (this.opening.has(session)) this.closeRequestedWhileOpening.add(session);
      return;
    }
    this.rememberPlanRestoreSnapshot(session, opened.threadId, opened.thread);
    this.open.delete(session);
    opened.thread.close();
    this.resolvePendingQuestionsForSession(session);
    this.pendingAsyncQuestions.delete(session);
    this.onProcessing(session, "done");
  }

  close(): void {
    for (const session of [...this.open.keys()]) this.closeSession(session);
  }

  /** iOS の既存 QuestionPromptSheet 回答を native requestUserInput response へ戻す。 */
  answerQuestion(id: string, answers: QuestionAnswer[]): boolean {
    if (this.answerAsyncQuestions(id, answers)) return true;
    const pending = this.pendingUserInput.get(id);
    if (pending === undefined) return false;
    this.pendingUserInput.delete(id);
    const wireAnswers: Record<string, { answers: string[] }> = {};
    for (const answer of answers) {
      const question = pending.questions[answer.questionIndex];
      if (question === undefined) continue;
      const questionId = question["id"];
      if (typeof questionId !== "string") continue;
      const rawOptions = Array.isArray(question["options"])
        ? question["options"].map(asRecord).filter((value): value is Record<string, unknown> => value !== null)
        : [];
      const values = answer.selectedOptionIndexes.flatMap((index) => {
        const label = rawOptions[index]?.["label"];
        return typeof label === "string" ? [label] : [];
      });
      const other = answer.otherText?.trim();
      if (other) values.push(other);
      wireAnswers[questionId] = { answers: values };
    }
    pending.resolve({ answers: wireAnswers });
    this.onQuestionDismiss(pending.session, id);
    // 止まる設問の間は出せなかった非同期質問を、ここで出し直す。
    this.presentAsyncQuestions(pending.session);
    return true;
  }

  /**
   * 非同期質問の回答（codex-async-question）。iOS の設問シートは提示中の全問の回答を求めるので、
   * 回答した分を片付け、提示後に届いて答えていない分があれば出し直す。回答は封筒にまとめ、質問した
   * 実行中の turn へ steer する（新しい turn は始めない: hub の送信キューを迂回して turn/start が競合
   * しないように。turn が終わっていれば TUI と同じく締め切り扱い）。送信は待たない（hub の回答受付は
   * 同期の真偽で返す）。届かなかったときは会話へ注記する。
   */
  private answerAsyncQuestions(id: string, answers: QuestionAnswer[]): boolean {
    let session: string | null = null;
    for (const [candidate, pending] of this.pendingAsyncQuestions) {
      if (pending.promptId === id) {
        session = candidate;
        break;
      }
    }
    if (session === null) return false;
    const pending = this.pendingAsyncQuestions.get(session)!;
    const presented = pending.presentedEntries;
    const replies: CodexAsyncQuestionReply[] = [];
    for (const answer of answers) {
      const entry = presented[answer.questionIndex];
      if (entry === undefined) continue;
      const selected = answer.selectedOptionIndexes.flatMap((index) => {
        const label = entry.question.options[index];
        return label === undefined ? [] : [label];
      });
      const other = answer.otherText?.trim() ?? "";
      const text = [...selected, ...(other.length > 0 ? [other] : [])].join("\n").trim();
      if (text.length === 0) continue;
      replies.push({
        itemId: entry.itemId, index: entry.question.index, title: entry.question.title, answer: text,
      });
    }
    // 提示した分は（回答の有無にかかわらず）終わり。残りがあれば新しい id で出し直す。
    const presentedKeys = new Set(presented.map(asyncEntryKey));
    pending.entries = pending.entries.filter((entry) => !presentedKeys.has(asyncEntryKey(entry)));
    pending.promptId = null;
    pending.presentedEntries = [];
    pending.presentedKey = null;
    this.onQuestionDismiss(session, id);
    this.presentAsyncQuestions(session);
    if (replies.length > 0) void this.sendAsyncAnswer(session, pending.threadId, replies);
    return true;
  }

  /** 回答の封筒を、質問した実行中の turn へ steer する（turn が替わっていれば締め切り扱い）。 */
  private async sendAsyncAnswer(session: string, threadId: string, replies: CodexAsyncQuestionReply[]): Promise<void> {
    const failedItemId = replies[0]!.itemId;
    const fail = (kind: "expired" | "uncertain", error: unknown): void => {
      this.log(`Codex 非同期質問の回答送信失敗（${kind}） session=${session}: ${String(error)}`);
      const notice = codexAsyncAnswerFailedNotice(failedItemId, kind);
      this.onChatItem({ session, itemId: notice.itemId, payload: notice.payload });
    };
    const opened = this.open.get(session);
    const turnId = opened?.threadId === threadId ? opened.activeTurnId : null;
    if (opened === undefined || turnId === null) {
      fail("expired", "no active turn");
      return;
    }
    try {
      await opened.thread.steerTurn(turnId, codexAsyncQuestionReplyText(replies), null);
    } catch (error) {
      // 別の turn が active（質問した turn は終わった）/ steer 不可は締め切り。timeout・切断は届いたか不明。
      fail(activeTurnIdFromMismatch(error) !== null || isDefinitiveSteerRejection(error) ? "expired" : "uncertain", error);
    }
  }

  /** item/completed の agentMessage が非同期質問なら未回答に積む（`present` で iOS へ出す）。 */
  private ingestAsyncQuestions(
    session: string,
    opened: OpenThread,
    item: Record<string, unknown>,
    present = true,
  ): void {
    const asked = codexAsyncQuestionItem(item);
    if (asked === null) return;
    const pending = this.asyncQuestionsFor(session, opened);
    if (pending.seenItemIds.has(asked.itemId)) return;
    pending.seenItemIds.add(asked.itemId);
    for (const question of asked.questions) {
      const entry = { itemId: asked.itemId, question };
      if (!isAnsweredAsyncEntry(pending, entry)) pending.entries.push(entry);
    }
    if (present) this.presentAsyncQuestions(session);
  }

  /**
   * ユーザー入力が回答の封筒なら、指された質問を未回答から外す（他クライアント = TUI / デスクトップの
   * 回答で Tailii の設問を閉じ、二重回答を防ぐ。TUI の `resolve_answers` と同じ照合。自分の回答の
   * こだまは既に片付け済みなので何も起きない）。
   */
  private resolveAsyncAnswersFromInput(
    session: string,
    opened: OpenThread,
    item: Record<string, unknown>,
    present = true,
  ): void {
    if (item["type"] !== "userMessage") return;
    const content = item["content"];
    if (!Array.isArray(content)) return;
    const text = content.flatMap((part) => {
      const record = asRecord(part);
      return record?.["type"] === "text" && typeof record["text"] === "string" ? [record["text"] as string] : [];
    }).join("\n");
    const targets = codexAsyncQuestionReplyTargets(text);
    if (targets === null) return;
    const pending = this.asyncQuestionsFor(session, opened);
    for (const target of targets) {
      // 開き直しの再生で、後から出る質問を回答済みとして覚えておく（item id 全体の旧形式も）。
      pending.answeredKeys.add(target.index === null ? target.itemId : `${target.itemId}#${target.index}`);
    }
    const before = pending.entries.length;
    pending.entries = pending.entries.filter((entry) => !isAnsweredAsyncEntry(pending, entry));
    if (pending.entries.length === before) return;
    // 並びが変わったので新しい id で出し直す（同じ id のまま詰めると、iOS の回答の位置がずれる）。
    if (present) this.presentAsyncQuestions(session);
  }

  private asyncQuestionsFor(session: string, opened: OpenThread): PendingAsyncQuestions {
    let pending = this.pendingAsyncQuestions.get(session);
    if (pending === undefined || pending.threadId !== opened.threadId) {
      if (pending?.promptId != null) this.onQuestionDismiss(session, pending.promptId);
      pending = {
        threadId: opened.threadId, entries: [], promptId: null, presentedEntries: [], presentedKey: null,
        seenItemIds: new Set(), answeredKeys: new Set(),
      };
      this.pendingAsyncQuestions.set(session, pending);
    }
    return pending;
  }

  /**
   * 未回答の非同期質問を 1 枚の設問として iOS へ出す（出し直す）。**質問の並びが 1 件でも変われば
   * 設問 id を変える**（追記・他クライアントの回答で外れた分）: hub は設問 id が一致する回答しか
   * 受理しないので、回答は必ず提示した並びに対するものになる（同じ id で中身を差し替えると、すれ違った
   * 回答の位置がずれて別の質問へ届く・追記分が回答済み扱いで消える。iOS のシートも同じ id では
   * 作り直されず下書きの件数とずれる）。答えかけの下書きは iOS が前の id から先頭の一致分を引き継ぐ。
   * 答えないと進まない設問（requestUserInput）が出ている間は待つ: hub の未回答の設問は会話に 1 つで、
   * 上書きすると答えないと進まない設問が消える。
   */
  private presentAsyncQuestions(session: string): void {
    const pending = this.pendingAsyncQuestions.get(session);
    if (pending === undefined) return;
    if ([...this.pendingUserInput.values()].some((input) => input.session === session)) return;
    const previous = pending.promptId;
    const first = pending.entries[0];
    if (first === undefined) {
      pending.promptId = null;
      pending.presentedEntries = [];
      pending.presentedKey = null;
      if (previous !== null) this.onQuestionDismiss(session, previous);
      return;
    }
    const key = pending.entries.map(asyncEntryKey).join("\u0000");
    if (previous !== null && pending.presentedKey === key) return;
    this.asyncPromptSeq += 1;
    const id = `${CODEX_ASYNC_QUESTION_ID_PREFIX}${pending.threadId}:${asyncEntryKey(first)}:` +
      `${this.asyncPromptNonce}-${this.asyncPromptSeq}`;
    // 置き換えでは前の id の dismiss を送らない: hub は未回答の設問を新しい id で上書きし、iOS は手元の
    // 前の設問と見比べて下書きを引き継ぐ（先に dismiss が届くと比べる相手が消える）。
    pending.promptId = id;
    pending.presentedEntries = [...pending.entries];
    pending.presentedKey = key;
    const questions: QuestionPromptQuestion[] = pending.entries.map(({ question }) => ({
      header: "Codex の質問",
      question: question.title,
      multiSelect: false,
      options: question.options.map((label) => ({ label, description: "" })),
    }));
    this.onQuestion({ session, id, questions });
  }

  /** turn の終わり / 接続を畳むときに未回答の非同期質問を締め切る（TUI と同じ: 回答はターン中だけ）。 */
  private expireAsyncQuestions(session: string): void {
    const pending = this.pendingAsyncQuestions.get(session);
    if (pending === undefined) return;
    pending.entries = [];
    pending.presentedEntries = [];
    pending.presentedKey = null;
    const previous = pending.promptId;
    pending.promptId = null;
    if (previous !== null) this.onQuestionDismiss(session, previous);
  }

  /**
   * 開いた時点で実行中の turn にある未回答の非同期質問を復元する（hub 再起動・開き直しの後も答えられる
   * ように。TUI の ThreadSnapshot 再生と同じ）。turn 所属が分からない item（旧 App Server）は対象外。
   */
  private restoreAsyncQuestions(session: string, opened: OpenThread, items: readonly Record<string, unknown>[]): void {
    const turnId = opened.activeTurnId;
    if (turnId === null) return;
    for (const item of items) {
      if (codexItemTurnId(item) !== turnId) continue;
      this.ingestAsyncQuestions(session, opened, item, false);
      this.resolveAsyncAnswersFromInput(session, opened, item, false);
    }
    this.presentAsyncQuestions(session);
  }

  /**
   * `intent`: "operate"（turn 開始 / 目標操作）は、開いている途中で close 要求が入って畳まれた場合に開き直す
   * （閉じた接続へ turn/start を投げない）。"subscribe" は畳まれた OpenThread をそのまま返す（購読者が
   * 去った後の再 open は無駄で、hub 側が購読者ゼロなら結果を捨てる）。
   */
  private async threadFor(
    session: string,
    threadId: string,
    cwd: string,
    intent: "subscribe" | "operate" = "operate",
  ): Promise<OpenThread> {
    // 開始中（openThread → 目標読み取り → サブエージェント復元）の同じ session は完了を共有する。
    // 会話オープンでは hub の購読と iOS の目標 get がほぼ同時に届くため、共有しないと openThread が
    // 2 回走って片方の接続が閉じられずに残り、その切断が正しい方の OpenThread まで消す。
    // 待った後は必ず opening を見直す: 別 threadId の待ち手が先に起きて新しい open を始めていることが
    // あり、1 回だけの確認だと同じ threadId の open が 2 本走る。
    for (;;) {
      const pending = this.opening.get(session);
      if (pending === undefined) break;
      let opened: OpenThread | null = null;
      try {
        opened = await pending.task;
      } catch (error) {
        // 同じ thread の open が失敗したなら、待ち手全員が順番に開き直して待ち時間を積み上げない
        // （daemon 不調時に hub の RPC 予算を超える）。別 thread の失敗なら自分で開く。
        if (pending.threadId === threadId) throw error;
      }
      // 開き終わった直後に閉じられた / 別 thread へ切り替わった OpenThread は返さない。
      if (opened !== null && opened.threadId === threadId && this.open.get(session) === opened) return opened;
    }
    const existing = this.open.get(session);
    if (existing?.threadId === threadId) return existing;
    if (existing !== undefined) this.closeSession(session);
    this.closeRequestedWhileOpening.delete(session);
    const task = this.openThreadFor(session, threadId, cwd).finally(() => {
      if (this.opening.get(session)?.task === task) this.opening.delete(session);
    });
    this.opening.set(session, { threadId, task });
    const opened = await task;
    if (intent === "operate" && this.open.get(session) !== opened) {
      // 開いている途中に close 要求（購読者が去った等）で畳まれた。操作の相手が要るので開き直す。
      return this.threadFor(session, threadId, cwd, intent);
    }
    return opened;
  }

  private async openThreadFor(session: string, threadId: string, cwd: string): Promise<OpenThread> {
    const items = new Map<string, Record<string, unknown>>();
    const bufferedNotifications: CodexAppServerNotification[] = [];
    let notificationTargetReady = false;
    const thread = await this.appServer.openThread({
      threadId,
      cwd,
      onNotification: (notification) => {
        if (!notificationTargetReady) {
          bufferedNotifications.push(notification);
          return;
        }
        this.handleNotification(session, threadId, items, notification);
      },
      onServerRequest: (request) => this.handleServerRequest(session, cwd, items, request),
      onDisconnect: (error) => {
        const current = this.open.get(session);
        if (current?.threadId !== threadId) return;
        this.rememberPlanRestoreSnapshot(session, threadId, current.thread);
        this.open.delete(session);
        this.resolvePendingQuestionsForSession(session);
        this.onProcessing(session, "done");
        this.onDisconnect(session, error);
      },
    });
    // plan 直前の model / effort は接続をまたいで復元する（接続は購読者ゼロで畳まれるため）。
    const planRestore = this.planRestoreBySession.get(session);
    if (planRestore !== undefined && planRestore.threadId === threadId) {
      thread.seedPlanRestoreSnapshot?.(planRestore.snapshot);
    }
    const opened = {
      threadId,
      cwd,
      thread,
      items,
      activeTurnId: thread.initialActiveTurnId ?? null,
      // 名前と最初の user prompt は生成直前の thread/read を権威にする。これにより
      // TUI attach / resume の競合で initialItems が先に埋まっても、新規会話の命名を落とさない。
      titleGenerationPending: true,
      planSeq: 0,
      subagents: new CodexSubagentTracker(threadId),
      subagentSeq: 0,
      goal: null,
      goalNoticeKey: null,
    };
    this.open.set(session, opened);
    // 開いている間に close が要求されていた（購読者が去った等）なら、開き終わった接続を残さず畳む。
    if (this.closeRequestedWhileOpening.delete(session)) {
      this.closeSession(session);
      return opened;
    }
    if (opened.activeTurnId !== null) this.onProcessing(session, "active");
    // 目標は rollout に現在値が無い（SQLite 保存）ため、開くたびに App Server から読む（失敗無視）。
    // Hub の close 判定（hasActiveGoal）が open 直後から正しい値を返すよう、ここで待つ。
    // 実行中 turn の未回答の非同期質問は、待ち（目標の読み取り）の間に届く live の質問より先に並べる。
    this.restoreAsyncQuestions(session, opened, thread.initialItems ?? []);
    await this.loadGoal(session, opened);
    if (this.open.get(session) !== opened) return opened;
    const restoredSubagents = [];
    for (const item of thread.initialItems ?? []) {
      restoredSubagents.push(...opened.subagents.ingestItem(item, Date.now()));
    }
    // thread/resume の親履歴は subAgentActivity.started だけを返し、子の完了イベントを
    // 省略する版がある。現在の親 turn が active でも過去の子は既に idle になり得るため、
    // 子 thread 自身の status を権威にする。読めない子だけは親も idle の場合に終端補正する。
    const restoredNodeIds = [...new Set(restoredSubagents.map((node) => node.nodeId))];
    const unresolvedNodeIds = new Set(restoredNodeIds);
    if (thread.readThreadStatus !== undefined) {
      const statuses = await Promise.all(restoredNodeIds.map(async (nodeId) => {
        try {
          return { nodeId, status: await thread.readThreadStatus!(nodeId) };
        } catch {
          return { nodeId, status: undefined };
        }
      }));
      // status 読み取り中に切断・別threadへの切替が起きた場合、古いsnapshotを配信しない。
      if (this.open.get(session) !== opened) return opened;
      for (const { nodeId, status: snapshot } of statuses) {
        if (snapshot === undefined) continue;
        unresolvedNodeIds.delete(nodeId);
        restoredSubagents.push(...opened.subagents.ingestThreadSnapshot(
          nodeId,
          snapshot.status,
          snapshot.timestampMs ?? Date.now(),
        ));
        // 子 thread 自身の model を権威にする（spawn item に model が無い版・要求 slug と実モデルが
        // 食い違う場合でも、live の thread/started と同じ表示に揃える）。
        restoredSubagents.push(...opened.subagents.ingestThreadModel(
          nodeId,
          snapshot.model,
          snapshot.timestampMs ?? Date.now(),
        ));
      }
    }
    if (opened.activeTurnId === null) {
      for (const nodeId of unresolvedNodeIds) {
        restoredSubagents.push(...opened.subagents.ingestThreadSnapshot(
          nodeId,
          { type: "idle" },
          codexThreadIdTimestampMs(nodeId) ?? Date.now(),
        ));
      }
    }
    const latestRestoredSubagents = new Map(
      restoredSubagents.map((node) => [node.nodeId, node] as const),
    );
    this.publishSubagentNodes(session, opened, [...latestRestoredSubagents.values()]);
    // snapshot の構築中に届いたlive通知は、snapshot送出後に適用して必ず新しい状態を勝たせる。
    notificationTargetReady = true;
    for (const notification of bufferedNotifications) {
      this.handleNotification(session, threadId, items, notification);
    }
    return opened;
  }

  private handleNotification(
    session: string,
    threadId: string,
    items: Map<string, Record<string, unknown>>,
    notification: CodexAppServerNotification,
  ): void {
    const params = asRecord(notification.params);
    if (notification.method === "deprecationNotice") {
      // 開発者向け通知（API の非推奨・config の旧機能）は chat へ流さず、同文は 1 回だけログする。
      const line = codexDeprecationNoticeLogLine(params);
      if (line !== null && !this.loggedDeprecationNotices.has(line)) {
        // 通知の種類は少数の定数文言だが、可変値を含む版に備えて記憶は有界にする。
        if (this.loggedDeprecationNotices.size >= DEPRECATION_NOTICE_LOG_CAP) {
          this.loggedDeprecationNotices.clear();
        }
        this.loggedDeprecationNotices.add(line);
        this.log(line);
      }
      return;
    }
    const notificationThreadId = params?.["threadId"];
    // App Server が接続をまたいで通知する版でも、別 thread の lifecycle が
    // このセッションの activeTurnId と processing 状態を上書きしないようにする。
    // item は subagent thread 由来も表示対象になり得るため、ここでは一括破棄しない。
    const lifecycleMatchesThread =
      typeof notificationThreadId !== "string" || notificationThreadId === threadId;
    const current = this.open.get(session);
    const systemNotice = current?.threadId === threadId && lifecycleMatchesThread
      ? codexAppServerSystemNotice(notification.method, params)
      : null;
    if (systemNotice !== null) {
      this.onChatItem({ session, itemId: systemNotice.itemId, payload: systemNotice.payload });
    }
    if (current?.threadId === threadId && notification.method === "thread/started") {
      const startedThread = asRecord(params?.["thread"]);
      if (startedThread !== null) {
        this.publishSubagentNodes(
          session,
          current,
          current.subagents.ingestThreadStarted(startedThread, Date.now()),
        );
      }
    }
    if (current?.threadId === threadId && notification.method === "thread/status/changed") {
      const changedThreadId = params?.["threadId"];
      if (typeof changedThreadId === "string") {
        this.publishSubagentNodes(
          session,
          current,
          current.subagents.ingestThreadStatus(changedThreadId, params?.["status"], Date.now()),
        );
      }
    }
    if (current?.threadId === threadId &&
      (notification.method === "thread/closed" || notification.method === "thread/archived")) {
      const closedThreadId = params?.["threadId"];
      if (typeof closedThreadId === "string") {
        this.publishSubagentNodes(
          session,
          current,
          current.subagents.ingestThreadClosed(closedThreadId, Date.now()),
        );
      }
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = asRecord(params?.["item"]);
      const id = item?.["id"];
      if (item !== null && typeof id === "string") items.set(id, item);
      if (current?.threadId === threadId && item !== null) {
        this.publishSubagentNodes(
          session,
          current,
          current.subagents.ingestItem(item, Date.now()),
        );
      }
      if (notification.method === "item/completed" && item !== null && typeof id === "string") {
        const payload = codexItemToChatOutput(item);
        if (payload !== null) this.onChatItem({ session, itemId: id, payload });
        // 非同期質問（codex-async-question）は本文を最終回答と同じ吹き出しで残しつつ、回答できる設問として出す。
        // 子 thread（サブエージェント）は質問しない（ツールが root thread だけに登録される）。
        if (current?.threadId === threadId && current.activeTurnId !== null) {
          this.ingestAsyncQuestions(session, current, item);
          this.resolveAsyncAnswersFromInput(session, current, item);
        }
        const mcpNotice = current?.threadId === threadId ? codexMcpItemErrorNotice(item) : null;
        if (mcpNotice !== null) {
          this.onChatItem({ session, itemId: mcpNotice.itemId, payload: mcpNotice.payload });
        }
        // コマンド実行 / ファイル変更は tool_activity カードとして別 itemId で流す
        // （同一 item から chat 本文と tool カードの両方が出ることは無いが、dedup 集合を分ける）。
        codexItemToolActivities(item).forEach((activity, index) => {
          this.onChatItem({
            session,
            itemId: `${id}#tool-${index}`,
            payload: toolActivityMessage(activity),
          });
        });
      }
    }
    if (notification.method === "turn/plan/updated" && params !== null) {
      const current = this.open.get(session);
      if (current?.threadId === threadId) {
        const turnId = typeof params["turnId"] === "string" ? params["turnId"] : "turn";
        const itemId = `plan:${turnId}:${current.planSeq}`;
        const activity = codexPlanUpdateActivity(itemId, params);
        if (activity !== null) {
          current.planSeq += 1;
          this.onChatItem({ session, itemId, payload: toolActivityMessage(activity) });
        }
      }
    }
    if (notification.method === "turn/started" && lifecycleMatchesThread) {
      const current = this.open.get(session);
      const startedTurn = asRecord(params?.["turn"])?.["id"];
      if (current?.threadId === threadId && typeof startedTurn === "string" && startedTurn.length > 0) {
        current.activeTurnId = startedTurn;
        this.onProcessing(session, "active");
      }
    }
    if (notification.method === "turn/completed" && lifecycleMatchesThread) {
      const current = this.open.get(session);
      const completedTurn = asRecord(params?.["turn"])?.["id"];
      if (current?.threadId === threadId &&
        (typeof completedTurn !== "string" ||
          current.activeTurnId === null || current.activeTurnId === completedTurn)) {
        const turnStatus = asRecord(params?.["turn"])?.["status"];
        this.publishSubagentNodes(
          session,
          current,
          current.subagents.settleRunning(turnStatus === "failed" ? "error" : "completed", Date.now()),
        );
        current.activeTurnId = null;
        this.onProcessing(session, "done");
        this.resolvePendingQuestionsForSession(session);
      }
    }
    if (notification.method === "thread/settings/updated") {
      // 子 thread（サブエージェント）の設定更新は親会話のモデル表示に混ぜず、該当ノードへ反映する。
      // threadId 無し（旧版）は従来どおり自 thread として扱う。
      const settingsThreadId = params?.["threadId"];
      const settings = asRecord(params?.["threadSettings"]);
      const model = settings?.["model"];
      const ownThread = typeof settingsThreadId !== "string" || settingsThreadId === threadId;
      if (typeof model === "string" && model.length > 0) {
        if (ownThread) {
          this.onModel(session, model);
        } else {
          this.applySubagentModel(session, threadId, settingsThreadId, model);
        }
      }
      if (ownThread && settings !== null && current?.threadId === threadId) {
        // collaboration mode / effort / モデルの実体を turn 開始側へ追従させる（codex-plan-mode）。
        current.thread.noteThreadSettings?.(settings);
        const mode = asRecord(settings["collaborationMode"])?.["mode"];
        if (mode === "plan" || mode === "default") this.onCollaborationMode(session, mode);
      }
    }
    if (notification.method === "model/rerouted") {
      const reroutedThreadId = params?.["threadId"];
      const model = params?.["toModel"];
      if (typeof reroutedThreadId === "string" && typeof model === "string" && model.length > 0) {
        if (reroutedThreadId === threadId) {
          // 表示だけ更新する。振り替え先を settings.model に採らない（default 毎回明示で恒久化しないため）。
          this.onModel(session, model);
        } else {
          this.applySubagentModel(session, threadId, reroutedThreadId, model);
        }
      }
    }
    if (notification.method === "thread/goal/updated" && lifecycleMatchesThread) {
      const goal = codexGoalFromWire(params?.["goal"]);
      if (goal !== null && current?.threadId === threadId) {
        this.applyGoal(session, current, goal, { publishState: true });
      }
    }
    if (notification.method === "thread/goal/cleared" && lifecycleMatchesThread) {
      if (current?.threadId === threadId) this.applyGoal(session, current, null, { publishState: true });
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params?.["tokenUsage"]);
      const last = asRecord(tokenUsage?.["last"]);
      const contextTokens = nonNegativeInteger(last?.["totalTokens"]);
      if (contextTokens !== null) {
        this.onTokenUsage(
          session,
          contextTokens,
          positiveInteger(tokenUsage?.["modelContextWindow"]),
        );
      }
    }
  }

  /** 子 thread（サブエージェント）のモデル変更を workflow ノードへ反映する。未知の thread は無視。 */
  private applySubagentModel(
    session: string,
    threadId: string,
    childThreadId: string,
    model: string,
  ): void {
    const current = this.open.get(session);
    if (current?.threadId !== threadId) return;
    this.publishSubagentNodes(
      session,
      current,
      current.subagents.ingestThreadModel(childThreadId, model, Date.now()),
    );
  }

  private publishSubagentNodes(
    session: string,
    opened: OpenThread,
    nodes: ReturnType<CodexSubagentTracker["ingestItem"]>,
  ): void {
    for (const node of nodes) {
      const itemId = `subagent:${node.nodeId}:${opened.subagentSeq}`;
      opened.subagentSeq += 1;
      this.onChatItem({
        session,
        itemId,
        payload: { type: "subagent_node", v: PROTOCOL_V2, node },
      });
    }
  }

  private async handleServerRequest(
    session: string,
    fallbackCwd: string,
    items: Map<string, Record<string, unknown>>,
    request: CodexAppServerRequest,
  ): Promise<unknown> {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      const params = asRecord(request.params) ?? {};
      const itemId = typeof params["itemId"] === "string" ? params["itemId"] : "unknown";
      const item = items.get(itemId);
      const command = typeof params["command"] === "string" ? params["command"] : null;
      const reason = typeof params["reason"] === "string" ? params["reason"] : null;
      const cwd = typeof params["cwd"] === "string" ? params["cwd"] : fallbackCwd;
      const isCommand = request.method === "item/commandExecution/requestApproval";
      // 0.158+ は実行中の端末への入力（stdin）も同じ request で承認を求める（`kind: "writeStdin"`）。
      // 新しいコマンドの実行と見分けられるよう、ツール名と要約を分ける。
      const writesStdin = isCommand && params["kind"] === "writeStdin";
      const summary = writesStdin
        ? codexWriteStdinApprovalSummary(command, reason)
        : isCommand
          ? (command ?? reason ?? "コマンドの実行を許可しますか？")
          : fileChangeSummary(item, reason);
      const decision = await this.approvalBroker({
        id: `codex:${String(params["threadId"] ?? "thread")}:${String(request.id)}`,
        session,
        tool: writesStdin ? CODEX_WRITE_STDIN_TOOL_LABEL : isCommand ? "Bash" : "Edit",
        summary,
        cwd,
      });
      return { decision: decision === "allow" ? "accept" : "decline" };
    }

    if (request.method === "item/tool/requestUserInput") {
      const params = asRecord(request.params) ?? {};
      const threadId = typeof params["threadId"] === "string" ? params["threadId"] : "thread";
      const rawQuestions = Array.isArray(params["questions"])
        ? params["questions"].map(asRecord).filter((value): value is Record<string, unknown> => value !== null)
        : [];
      const id = `codex-question:${threadId}:${String(request.id)}`;
      const questions: QuestionPromptQuestion[] = rawQuestions.map((question) => ({
        header: typeof question["header"] === "string" ? question["header"] : "質問",
        question: typeof question["question"] === "string" ? question["question"] : "入力してください",
        multiSelect: false,
        options: Array.isArray(question["options"])
          ? question["options"].flatMap((option) => {
              const record = asRecord(option);
              const label = record?.["label"];
              if (typeof label !== "string") return [];
              return [{
                label,
                description:
                  typeof record?.["description"] === "string" ? record["description"] : "",
              }];
            })
          : [],
      }));
      // 提示中の非同期質問は hub で上書きされる。止まる設問が終わったら出し直す（未提示に戻す）。
      const asyncPending = this.pendingAsyncQuestions.get(session);
      if (asyncPending !== undefined) {
        asyncPending.promptId = null;
        asyncPending.presentedEntries = [];
        asyncPending.presentedKey = null;
      }
      this.onQuestion({ session, id, questions });
      return new Promise((resolve) => {
        this.pendingUserInput.set(id, {
          session,
          threadId,
          questions: rawQuestions,
          resolve,
        });
      });
    }
    if (request.method === "currentTime/read") {
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    }
    throw new Error(`unsupported Codex App Server request: ${request.method}`);
  }

  private resolvePendingQuestionsForSession(session: string): void {
    for (const [id, pending] of this.pendingUserInput) {
      if (pending.session !== session) continue;
      this.pendingUserInput.delete(id);
      pending.resolve({ answers: {} });
      this.onQuestionDismiss(session, id);
    }
    this.expireAsyncQuestions(session);
  }
}

/** 実行中の端末への入力（stdin）承認のツール名（iOS の承認カードはツール名をそのまま見出しに出す）。 */
export const CODEX_WRITE_STDIN_TOOL_LABEL = "端末への入力";

/** stdin 承認の要約に載せる入力の上限（文字）。超えた分は省略を明記する（承認カード・通知に巨大な本文を流さない）。 */
const WRITE_STDIN_INPUT_DISPLAY_LIMIT = 2000;

/**
 * stdin 承認（`kind: "writeStdin"`）の要約。App Server は `command` に
 * `shlex_join(["write_stdin", "--session-id", <端末 id>, <入力>])` を入れる（codex-rs core の
 * tools/approvals.rs → app-server bespoke_event_handling.rs）。読めれば端末 id と入力を、読めなければ
 * 生の command を出す。見た目を偽装できる文字（制御文字・C1・書式文字＝bidi 制御 / ゼロ幅・行区切り）は
 * `\u{…}` で見せる（TUI の `Input: {input:?}` = Rust Debug 相当。承認カードで中身を取り違えさせない）。
 */
export function codexWriteStdinApprovalSummary(command: string | null, reason: string | null): string {
  const words = command === null ? null : splitShellWords(command);
  const lines: string[] = [];
  if (words !== null && words[0] === "write_stdin" && words[1] === "--session-id" && words.length >= 4) {
    lines.push(`実行中の端末 ${escapeInvisible(words[2]!)} へ入力を送ります`);
    const input = words.slice(3).join(" ");
    const shown = [...input];
    const clipped = shown.length > WRITE_STDIN_INPUT_DISPLAY_LIMIT;
    const body = clipped ? shown.slice(0, WRITE_STDIN_INPUT_DISPLAY_LIMIT).join("") : input;
    lines.push(`入力: "${escapeInvisible(body, true)}"${clipped ? `…（残り ${shown.length - WRITE_STDIN_INPUT_DISPLAY_LIMIT} 文字を省略）` : ""}`);
  } else {
    lines.push("実行中の端末へ入力を送ります");
    if (command !== null) lines.push(escapeInvisible(command));
  }
  if (reason !== null && reason.trim().length > 0) lines.push(`理由: ${escapeInvisible(reason.trim())}`);
  return lines.join("\n");
}

/**
 * 見た目を偽装できる文字を `\u{…}` / `\n` 等で見せる。`quoted` は `"` と `\\` もエスケープする（引用符で
 * 囲んで見せる入力用）。対象: C0 / DEL / C1 制御文字、書式文字（\p{Cf}: bidi 制御・ゼロ幅・BOM 等）、
 * 行区切り U+2028 / U+2029。
 */
function escapeInvisible(text: string, quoted = false): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "\n") result += "\\n";
    else if (char === "\r") result += "\\r";
    else if (char === "\t") result += "\\t";
    else if (quoted && (char === "\"" || char === "\\")) result += `\\${char}`;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || /\p{Cf}/u.test(char)) {
      result += `\\u{${code.toString(16)}}`;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * POSIX shell の単語分割（クォートと `\` だけ。展開はしない）。閉じていないクォートは null。
 * `shlex_join` の出力（単語をシングル / ダブルクォートで包む）を元の単語列へ戻すのに使う。
 */
export function splitShellWords(text: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === " " || char === "\t" || char === "\n") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      index += 1;
      continue;
    }
    inWord = true;
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      current += text.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === "\"") {
      index += 1;
      let closed = false;
      while (index < text.length) {
        const inner = text[index]!;
        if (inner === "\"") {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "\\" && index + 1 < text.length && "$`\"\\\n".includes(text[index + 1]!)) {
          if (text[index + 1] !== "\n") current += text[index + 1];
          index += 2;
          continue;
        }
        current += inner;
        index += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= text.length) return null;
      if (text[index + 1] !== "\n") current += text[index + 1];
      index += 2;
      continue;
    }
    current += char;
    index += 1;
  }
  if (inWord) words.push(current);
  return words;
}

/** rollout の event_msg(user_message / agent_message) と同じ表示範囲へ写像する。 */
export function codexItemToChatOutput(item: Record<string, unknown>): ControlMessage | null {
  const id = item["id"];
  const type = item["type"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (type === "userMessage") {
    const content = item["content"];
    if (!Array.isArray(content)) return null;
    const text = content.flatMap((part) => {
      const record = asRecord(part);
      return record?.["type"] === "text" && typeof record["text"] === "string"
        ? [record["text"] as string]
        : [];
    }).join("\n");
    if (text.length === 0) return null;
    // 非同期質問への回答（封筒）は `> 質問\n\n回答` で見せる（rollout 経路と同じ写像）。
    const displayText = codexAsyncQuestionReplyDisplayText(text) ?? text;
    // iOS の楽観バブルと rollout の client_id に合わせ、添付サムネのアンカーも一致させる。
    const clientId = item["clientId"];
    const streamId = typeof clientId === "string" && clientId.length > 0
      ? `codex-user-${clientId}` : `codex-item-${id}`;
    return { type: "chat_output", v: PROTOCOL_V1, streamId,
      role: "user", text: displayText, eof: true };
  }
  if (type === "agentMessage") {
    const phase = item["phase"];
    if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") return null;
    const text = item["text"];
    if (typeof text !== "string" || text.length === 0) return null;
    return { type: "chat_output", v: PROTOCOL_V1, streamId: `codex-item-${id}`,
      role: "assistant", text, eof: true };
  }
  if (type === "plan") {
    // プランモードの提案プラン（codex-plan-mode）。rollout の item_completed/Plan と同じ streamId / 本文。
    const text = item["text"];
    return typeof text === "string" ? codexPlanChatOutput(id, text) : null;
  }
  return null;
}

export function chatContentKey(payload: ControlMessage): string | null {
  // tool_activity は live（App Server item）と rollout（response_item / patch_apply_end）の
  // 両系統から同じ内容で生成される。id は系統間で一致しないため内容キーで照合する。
  if (payload.type === "tool_activity") {
    return toolActivityContentKey(payload.activity);
  }
  const noticeKey = codexSystemNoticeContentKey(payload);
  if (noticeKey !== null) return noticeKey;
  if (payload.type !== "chat_output" || (payload.role !== "user" && payload.role !== "assistant")) {
    return null;
  }
  return `${payload.role}\u0000${payload.text}`;
}

/** App Server approval を既存 iPhone serve channel へ流し、同じ id の決定だけを待つ。 */
export async function requestCodexApprovalViaBroker(
  approval: CodexNativeApproval,
  options: { connectTimeoutMs?: number; decisionTimeoutMs?: number } = {},
): Promise<Decision> {
  const socketPath = resolveSocketPath(approval.session);
  const connectDeadline = Date.now() + (options.connectTimeoutMs ?? 10_000);
  let socket: net.Socket | null = null;
  do {
    socket = await connectSocket(socketPath);
    if (socket !== null) break;
    await sleep(200);
  } while (Date.now() <= connectDeadline);
  if (socket === null) return "deny";

  const request = encodeControlMessage({
    type: "approval_request",
    v: PROTOCOL_V1,
    id: approval.id,
    tool: approval.tool,
    summary: approval.summary,
    cwd: approval.cwd,
  });
  return new Promise<Decision>((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (decision: Decision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => finish("deny"), options.decisionTimeoutMs ?? 540_000);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).replaceAll("\r", "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = decodeControlMessage(line);
          if (message.type === "approval_decision" && message.id === approval.id) {
            finish(message.decision);
            return;
          }
        } catch {
          // channel_hello 以外の壊れた行も無視し、正しい決定を待つ。
        }
      }
    });
    socket.once("error", () => finish("deny"));
    socket.once("close", () => finish("deny"));
    socket.write(request + "\n");
  });
}

function connectSocket(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      resolve(socket);
    });
    socket.once("error", () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(null);
    });
  });
}

function fileChangeSummary(item: Record<string, unknown> | undefined, reason: string | null): string {
  const changes = item?.["changes"];
  if (Array.isArray(changes)) {
    const paths = changes
      .map((change) => asRecord(change)?.["path"])
      .filter((value): value is string => typeof value === "string")
      .slice(0, 4);
    if (paths.length > 0) return `ファイル変更: ${paths.join(", ")}`;
  }
  return reason ?? "ファイルの変更を許可しますか？";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const integer = nonNegativeInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}
