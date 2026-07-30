// engine/context.ts
// engine の 1 接続分の共有状態（HandlerContext）と、ハンドラ横断で使う小ヘルパー群。
// handleLine のドメイン別ハンドラ（handlers/）は全てここ経由で状態に触る。

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatAgent } from "../chat/chatTailController.js";
import type { CodexAppServerManager } from "../codex/codexAppServer.js";
import type { CodexTurnControllerRuntime } from "../codex/codexNativeTurnController.js";
import type { ClaudeSessionStore } from "../sessions/claudeSessionStore.js";
import type { CodexSessionStore } from "../codex/codexSessionStore.js";
import type { HubLink } from "../hub/hubClient.js";
import type { HubClientMessage, HubServerMessage } from "../hub/hubProtocol.js";
import { bumpHeartbeat } from "../sessions/heartbeat.js";
import type { ImageService } from "../chat/imageService.js";
import type { EngineLauncher } from "../commands/launch.js";
import type { LineWriter } from "../shared/lineWriter.js";
import type { ClaudeModelListProvider } from "../services/claudeModelCatalog.js";
import type { PlanUsageProvider } from "../services/planUsageFetcher.js";
import type { PreviewServer } from "../services/previewServer.js";
import {
  PROTOCOL_V1,
  type ControlMessage,
  type QuestionPromptQuestion,
  type SessionInfo,
} from "../protocol.js";
import type { SessionListService } from "../sessions/sessionListService.js";
import type { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import type {
  OfficialAppProvider,
  OfficialAppRuntimeContext,
  OfficialAppsService,
} from "../services/officialApps.js";
import { claudeProjectSlug } from "../shared/paths.js";
import { sleep } from "../shared/sleep.js";
import type { SessionBackend, SessionBackendKind } from "../backend/sessionBackend.js";

export function engineDiag(message: string): void {
  if (process.env["TAILII_DEBUG"] === "1") process.stderr.write(`[tailii-host engine] ${message}\n`);
}

export interface EngineState {
  negotiatedVersion: number;
  ownMaxVersion: number;
  modeSetInFlight: Set<string>;
}

export interface ModeTiming {
  getPollMs: number;
  getAttempts: number;
  setInitialPollMs: number;
  setInitialTimeoutMs: number;
  setChangePollMs: number;
  setChangeTimeoutMs: number;
}

export const DEFAULT_MODE_TIMING: ModeTiming = {
  getPollMs: 250,
  getAttempts: 4,
  setInitialPollMs: 300,
  setInitialTimeoutMs: 10_000,
  setChangePollMs: 150,
  setChangeTimeoutMs: 1_500,
};

export interface HandlerContext {
  writer: LineWriter;
  state: EngineState;
  sessionManager: SessionBackend;
  /** 新規セッションの端末バックエンド解決子（launch 毎に読む）。 */
  backendKind: () => SessionBackendKind;
  /** backend_set の永続化先。 */
  backendWriter: (kind: SessionBackendKind) => void;
  /** herdr 導入済み判定。 */
  herdrInstalledProbe: () => boolean;
  imageService: ImageService | null;
  launcher: EngineLauncher | null;
  /** codex セッション用 launcher（session_start の agentType=codex 時に使用）。 */
  codexLauncher: EngineLauncher | null;
  sessionListService: SessionListService | null;
  metadataStore: SessionMetadataStore | null;
  hubLink: HubLink;
  requestHubState: (session: string) => Promise<{ id: string; questions: QuestionPromptQuestion[] } | null>;
  hubRpc: <T extends HubServerMessage>(request: HubClientMessage, id: string, timeoutMs: number) => Promise<T>;
  codexHubRpcTimeoutMs: number;
  heartbeatDir: string;
  resumeLauncher: EngineLauncher | null;
  /** codex セッションの reattach 時 resume 用 launcher。 */
  codexResumeLauncher: EngineLauncher | null;
  claudeSessionStore: ClaudeSessionStore | null;
  /** codex 会話一覧の導出（agent-tag）。 */
  codexSessionStore: CodexSessionStore | null;
  planUsage: PlanUsageProvider;
  /** Claude モデル一覧の取得（Models API, ベストエフォート。テストは固定値/null を注入）。 */
  claudeModelList: ClaudeModelListProvider;
  homeDir: string;
  modeTiming: ModeTiming;
  /** host 側の既定エージェント（session_start が agentType を指定しないときのフォールバック）。 */
  defaultAgent: ChatAgent;
  activeChatSession: { name: string | null };
  /** 一覧 Mission Control の watch 状態（有効中は非前面会話の pane_preview もリレーする）。 */
  listPreviewWatch: { enabled: boolean };
  /** 処理中セッションの最終ハートビート（Unix 秒）。明示 kill 時に掃除する。 */
  processingSessions: Map<string, number>;
  /** 一覧・別画面でも差分同期を続けるフォーカス外会話。 */
  backgroundChatSessions: Set<string>;
  /** Hub 世代内で iOS へ連続配送済みの最後の conversation seq。 */
  lastServerSeq: Map<string, number>;
  /** Codex モデル一覧を取得する共有 App Server。 */
  codexAppServer: CodexAppServerManager | null;
  /** Codex native turn/approval 接続。 */
  codexTurnController: CodexTurnControllerRuntime | null;
  /** Claude / ChatGPT 公式アプリ連携。 */
  officialApps: OfficialAppsService | null;
  /** Web プレビュー用 loopback 静的ファイルサーバー。 */
  previewServer: PreviewServer;
}

/** ドメイン別ハンドラの契約: message type ごとに narrow された ControlMessage を受ける。 */
export type MessageHandler<K extends ControlMessage["type"]> = (
  message: Extract<ControlMessage, { type: K }>,
  ctx: HandlerContext,
) => void | Promise<void>;

export type HandlerRegistry = { [K in ControlMessage["type"]]?: MessageHandler<K> };

/**
 * chat オープン/再オープン時、そのセッションに未回答の設問があれば question_prompt を再送する。
 * 未回答の間 transcript に tool_use 行が無く履歴再生では設問が復元されないため、engine の
 * 保持分から再掲する（question-hook-relay）。
 */
export async function emitPendingQuestion(ctx: HandlerContext, session: string): Promise<void> {
  const pending = await ctx.requestHubState(session);
  if (pending === null) return;
  ctx.writer.write({
    type: "question_prompt",
    v: PROTOCOL_V1,
    id: pending.id,
    questions: pending.questions,
  });
}

export function subscribeConversation(ctx: HandlerContext, session: string, newerThanMs?: number): void {
  const previous = ctx.activeChatSession.name;
  if (previous !== null && previous !== session) {
    if (ctx.processingSessions.has(previous)) {
      ctx.backgroundChatSessions.add(previous);
      ctx.hubLink.send({ type: "conversation_subscribe", session: previous, preview: false });
    } else {
      ctx.backgroundChatSessions.delete(previous);
      ctx.hubLink.send({ type: "conversation_unsubscribe", session: previous });
    }
  }
  ctx.activeChatSession.name = session;
  ctx.backgroundChatSessions.delete(session);
  ctx.hubLink.send({ type: "conversation_subscribe", session,
    ...(newerThanMs !== undefined
      ? { newerThanMs }
      : ctx.lastServerSeq.has(session) ? { afterSeq: ctx.lastServerSeq.get(session)! } : {}),
    preview: true });
}

/** prepare 中は購読を始めず、reaper が読む権威ファイルの idle deadline だけを即時に更新する。 */
export function touchPreparedSession(ctx: HandlerContext, session: string): boolean {
  try {
    bumpHeartbeat(ctx.heartbeatDir, session, Date.now() / 1_000, "session-prepare");
    return true;
  } catch {
    // heartbeat を更新できないまま成功 ack を返すと、直後の reaper tick による kill を
    // クライアントが防げない。prepare 自体を構造化エラーとして失敗させる。
    return false;
  }
}

/** 通常オープンは購読を開始し、prepare は購読せず heartbeat だけを保護する。 */
export async function activateOrTouchSession(
  ctx: HandlerContext,
  writer: LineWriter,
  version: number,
  requestId: string,
  session: string,
  shouldSubscribe: boolean,
  newerThanMs?: number,
): Promise<boolean> {
  if (shouldSubscribe) {
    subscribeConversation(ctx, session, newerThanMs);
    await emitPendingQuestion(ctx, session);
    return true;
  }
  if (touchPreparedSession(ctx, session)) return true;
  writeError(writer, version, requestId, "session_prepare_heartbeat_failed",
    "セッションの保護時刻を更新できませんでした。");
  return false;
}

export async function claimRuntime(ctx: HandlerContext, session: string): Promise<"granted" | "held"> {
  const id = randomUUID();
  try {
    const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "runtime_claim_result" }>>(
      { type: "runtime_claim", id, session }, id, 1_500,
    );
    return result.status;
  } catch {
    // Hub 障害時は可用性を優先し、排他導入前と同じく engine 自身で起動を続行する。
    return "granted";
  }
}

export async function waitForLiveSession(
  sessionManager: SessionBackend, predicate: (info: SessionInfo) => boolean,
): Promise<SessionInfo | null> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const found = (await sessionManager.list()).find((info) => info.alive && predicate(info));
    if (found !== undefined) return found;
    await sleep(500);
  }
  return null;
}

export async function officialAppRuntimeContext(
  ctx: HandlerContext,
  session: string,
  provider: OfficialAppProvider,
): Promise<{ context: OfficialAppRuntimeContext } | { reason: string }> {
  if (ctx.activeChatSession.name !== session) return { reason: "official_app_focus_changed" };
  const meta = ctx.metadataStore?.get(session) ?? null;
  if ((meta?.agent ?? ctx.defaultAgent) !== provider) {
    return { reason: "official_app_provider_mismatch" };
  }
  try {
    if (!(await ctx.sessionManager.agentProcessAlive(session))) {
      return { reason: "official_app_session_not_live" };
    }
  } catch {
    return { reason: "official_app_session_not_live" };
  }
  let pending: { id: string; questions: QuestionPromptQuestion[] } | null;
  try {
    const id = randomUUID();
    const response = await ctx.hubRpc<Extract<HubServerMessage, { type: "hub_state_response" }>>(
      { type: "hub_state_request", id, session },
      id,
      1_500,
    );
    pending = response.pendingQuestion;
    if (response.processing) {
      ctx.processingSessions.set(session, Math.floor(Date.now() / 1_000));
    } else {
      ctx.processingSessions.delete(session);
    }
  } catch {
    return { reason: "official_hub_state_unavailable" };
  }
  if (ctx.activeChatSession.name !== session) return { reason: "official_app_focus_changed" };

  let codexTurnActive = false;
  for (const processingSession of ctx.processingSessions.keys()) {
    const processingMeta = ctx.metadataStore?.get(processingSession) ?? null;
    if ((processingMeta?.agent ?? ctx.defaultAgent) === "codex") {
      codexTurnActive = true;
      break;
    }
  }
  // Remote Control URL の権威は transcript の bridge_status 行（pane 引用に汚染されない）。
  const claudeSessionId = meta?.claudeSessionId;
  const claudeTranscriptPath =
    provider === "claude" &&
    meta !== null &&
    typeof claudeSessionId === "string" &&
    /^[A-Za-z0-9-]+$/u.test(claudeSessionId)
      ? path.join(
          os.homedir(),
          ".claude",
          "projects",
          claudeProjectSlug(meta.cwd),
          `${claudeSessionId}.jsonl`,
        )
      : null;
  return {
    context: {
      session,
      provider,
      sessionManager: ctx.sessionManager,
      canInjectClaudeCommand: !ctx.processingSessions.has(session) && pending === null,
      canMutateCodexDaemon: !codexTurnActive,
      claudeTranscriptPath,
    },
  };
}

/** session_list_response の worktree 掃除結果フィールド（session_kill 応答に同乗）。 */
export interface WorktreeResponseFields {
  worktreePath: string;
  worktreeRemoved?: boolean;
  worktreeDirty?: boolean;
}

/** session_list_response を書き出す（optional cursor / host 採用名は null なら省略）。 */
export function writeSessionListResponse(
  writer: LineWriter,
  v: number,
  id: string,
  sessions: SessionInfo[],
  nextCursor: string | null,
  adoptedName: string | null = null,
  worktree: WorktreeResponseFields | null = null,
): void {
  writer.write({
    type: "session_list_response",
    v,
    id,
    sessions,
    ...(nextCursor !== null && { nextCursor }),
    ...(adoptedName !== null && { adoptedName }),
    ...(worktree !== null && worktree),
  });
}

/** error 封筒を書き出す小ヘルパー。 */
export function writeError(
  writer: LineWriter,
  v: number,
  id: string | undefined,
  code: string,
  message: string,
): void {
  try {
    writer.write({ type: "error", v, ...(id !== undefined && { id }), code, message });
  } catch (error) {
    process.stderr.write(`[tailii-host engine] error 送出失敗: ${String(error)}\n`);
  }
}
