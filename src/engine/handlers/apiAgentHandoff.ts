// engine/handlers/apiAgentHandoff.ts
// 既存の会話（サブスクで動かしてきた Claude の会話）を API 作業へ引き継ぐ / 元へ戻す（api-agent-handoff）。
//
// 引き継ぎ（api_agent_handoff）は 1 つの操作として行う:
//   1. 端末側でこの会話が処理中・承認待ち・設問待ちなら何もせずに断る（terminal_busy）。
//   2. Tailii 外（ターミナル・公式アプリ）の claude が掴んでいれば何もせずに断る（held_externally）。
//   3. 端末側のセッションを終える。worktree の後始末は走らせない（同じ作業フォルダで続ける）。
//   4. 会話を掴んでいた claude が pid で死んだのを確かめる（conversationDelete と同じ照合）。
//   5. 同じ会話 id・同じ作業フォルダで API 作業を開く（resume）。
// 3〜5 の途中で失敗しても、会話は端末で今までどおり開き直せる（最後の実行経路は 5 が成功したときだけ API に
// なる。5 の失敗ではメタデータを元に戻す）。
//
// 元へ戻す（api_agent_return）: hub で API 作業を閉じ（実行中のターンがあれば turn_running で断る）、SDK の
// claude の終了を待ち、最後の実行経路を端末にする。端末での再開はアプリが通常の開き直し（session_start の
// resumeSessionId）で行う。台帳（API の合計額）は消さない。

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { API_AGENT_ERROR_MESSAGES, validApiAgentConfig } from "../../apiAgent/config.js";
import { conversationHolders } from "../../apiAgent/exclusivity.js";
import { estimateFirstTurnUsd, inheritPermissionMode, readHandoffContext } from "../../apiAgent/handoff.js";
import { ApiAgentLedgerStore } from "../../apiAgent/ledger.js";
import { AgentSdkPreparer } from "../../apiAgent/sdkInstaller.js";
import { isConversationUuid } from "../../apiAgent/workerProtocol.js";
import type { HubServerMessage } from "../../hub/hubProtocol.js";
import type { ApiAgentErrorCode, ControlMessage, SessionInfo } from "../../protocol.js";
import { stopConversationHolders } from "../../sessions/conversationDelete.js";
import { defaultPeerSessionsDir } from "../../services/peerSessions.js";
import { claudeProjectSlug } from "../../shared/paths.js";
import { engineDiag, type HandlerContext, type HandlerRegistry } from "../context.js";
import { openApiAgentRuntime } from "./apiAgent.js";
import { killSessionForUser } from "./session.js";

type HandoffMessage = Extract<ControlMessage, { type: "api_agent_handoff" }>;
type ApiAgentResult = Extract<HubServerMessage, { type: "api_agent_result" }>;
type HubStateResponse = Extract<HubServerMessage, { type: "hub_state_response" }>;

/** テストで差し替える依存。 */
export interface HandoffDeps {
  transcriptPath: (cwd: string, conversationId: string) => string;
  ledger: Pick<ApiAgentLedgerStore, "setRoute">;
  claudeSessionsDir: string;
  /** 登録簿で会話を掴んでいる生存 claude（元へ戻すときの SDK の claude の終了待ち）。 */
  holders: (conversationId: string) => { pid: number }[];
  peerPidAlive?: (pid: number) => boolean;
  processAlive?: (pid: number, procStart: string | null) => Promise<boolean>;
  exitWaitMs?: number;
  exitPollMs?: number;
}

export function defaultHandoffDeps(): HandoffDeps {
  return {
    transcriptPath: (cwd, id) => path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(cwd), `${id}.jsonl`),
    ledger: new ApiAgentLedgerStore(),
    claudeSessionsDir: defaultPeerSessionsDir(),
    holders: (id) => conversationHolders(id),
  };
}

/** 会話を収容中の端末側のセッション（生存中・API 作業以外）。 */
async function terminalHolders(ctx: HandlerContext, conversationId: string): Promise<SessionInfo[]> {
  return (await ctx.sessionManager.list()).filter((info) => info.alive && info.executionRoute !== "api" &&
    (info.agent ?? "claude") === "claude" && (info.providerSessionId ?? info.claudeSessionId) === conversationId);
}

/** 端末側のセッションが処理中・承認待ち・設問待ちか（承認待ち・設問待ちもターンの途中なので処理中に含まれる）。 */
async function terminalBusy(ctx: HandlerContext, sessions: SessionInfo[]): Promise<boolean> {
  for (const session of sessions) {
    try {
      const id = randomUUID();
      const state = await ctx.hubRpc<HubStateResponse>({ type: "hub_state_request", id, session: session.name }, id, 1_500);
      if (state.processing || state.pendingQuestion !== null) return true;
    } catch {
      // hub に聞けないときは安全側（処理中かもしれない）で断る。
      return true;
    }
    if (ctx.processingSessions.has(session.name)) return true;
  }
  return false;
}

export async function estimateHandoff(
  message: Extract<ControlMessage, { type: "api_agent_handoff_estimate_request" }>,
  ctx: HandlerContext,
  deps: HandoffDeps = defaultHandoffDeps(),
): Promise<Extract<ControlMessage, { type: "api_agent_handoff_estimate_response" }>> {
  const v = ctx.state.negotiatedVersion;
  if (!isConversationUuid(message.conversationId) || !path.isAbsolute(message.cwd)) {
    return { type: "api_agent_handoff_estimate_response", v, id: message.id, ok: false, error: "invalid_config" };
  }
  const context = readHandoffContext(deps.transcriptPath(message.cwd, message.conversationId));
  let blocked: ApiAgentErrorCode | undefined;
  try {
    const holders = await terminalHolders(ctx, message.conversationId);
    if (await terminalBusy(ctx, holders)) blocked = "terminal_busy";
  } catch {
    // 一覧が取れなくても見積もりは返す（引き継ぎ本体でもう一度確かめる）。
  }
  const estimated = context.contextTokens === null ? null : estimateFirstTurnUsd(context.contextTokens, message.model);
  return {
    type: "api_agent_handoff_estimate_response", v, id: message.id, ok: true,
    ...(context.contextTokens !== null ? { contextTokens: context.contextTokens } : {}),
    ...(estimated !== null ? { estimatedUsd: estimated } : {}),
    suggestedPermissionMode: inheritPermissionMode(context.permissionMode),
    ...(blocked !== undefined ? { blocked } : {}),
  };
}

export async function handoffToApiAgent(
  message: HandoffMessage,
  ctx: HandlerContext,
  deps: HandoffDeps = defaultHandoffDeps(),
): Promise<Extract<ControlMessage, { type: "api_agent_handoff_result" }>> {
  const v = ctx.state.negotiatedVersion;
  const fail = (error: ApiAgentErrorCode, text?: string): Extract<ControlMessage, { type: "api_agent_handoff_result" }> => ({
    type: "api_agent_handoff_result", v, id: message.id, ok: false, error, message: text ?? API_AGENT_ERROR_MESSAGES[error],
  });
  if (!isConversationUuid(message.conversationId) || !path.isAbsolute(message.cwd) || !validApiAgentConfig(message.config) ||
    message.name.length === 0) return fail("invalid_config");

  // 1. 端末側が処理中・承認待ち・設問待ちなら断る（何も変えない）。
  let holders: SessionInfo[];
  try {
    holders = await terminalHolders(ctx, message.conversationId);
  } catch {
    return fail("terminal_stop_failed");
  }
  if (await terminalBusy(ctx, holders)) return fail("terminal_busy");

  // 2〜4. Tailii 外なら断り、端末側を終えて claude の終了を確かめる（worktree は消さない）。
  const stopped = await stopConversationHolders({
    sessionId: message.conversationId,
    agent: "claude",
    listSessions: () => ctx.sessionManager.list(),
    killSession: (name) => killSessionForUser(ctx, name, { keepWorktree: true }),
    paneProcessIds: (name) => ctx.sessionManager.agentProcessIds?.(name) ?? Promise.resolve(null),
    claudeSessionsDir: deps.claudeSessionsDir,
    log: engineDiag,
    ...(deps.peerPidAlive !== undefined ? { peerPidAlive: deps.peerPidAlive } : {}),
    ...(deps.processAlive !== undefined ? { processAlive: deps.processAlive } : {}),
    ...(deps.exitWaitMs !== undefined ? { exitWaitMs: deps.exitWaitMs } : {}),
    ...(deps.exitPollMs !== undefined ? { exitPollMs: deps.exitPollMs } : {}),
  });
  if (!stopped.ok) {
    engineDiag(`api-agent handoff 中止 conversation=${message.conversationId} reason=${stopped.reason}`);
    if (stopped.reason === "external") {
      const label = stopped.names.length > 0 ? `（${stopped.names.join(", ")}）` : "";
      return fail("held_externally", `Tailii 以外（ターミナルや公式アプリ）でこの会話が実行中のため、API キーで続けられません${label}。そちらを終了してからやり直してください。`);
    }
    return fail("terminal_stop_failed");
  }

  // 5. 同じ会話 id・同じ作業フォルダで API 作業を開く。名前は端末側の会話名を引き継ぐ（アプリの画面と揃える）。
  const name = holders[0]?.name ?? message.name;
  const opened = await openApiAgentRuntime(ctx, {
    name, cwd: message.cwd, conversationId: message.conversationId, resume: true, config: message.config,
  });
  if (opened !== null) {
    engineDiag(`api-agent handoff 開始失敗 conversation=${message.conversationId} error=${opened}`);
    return fail(opened);
  }
  engineDiag(`api-agent handoff 完了 conversation=${message.conversationId} name=${name}`);
  return { type: "api_agent_handoff_result", v, id: message.id, ok: true, session: name };
}

export async function returnToTerminal(
  message: Extract<ControlMessage, { type: "api_agent_return" }>,
  ctx: HandlerContext,
  deps: HandoffDeps = defaultHandoffDeps(),
): Promise<Extract<ControlMessage, { type: "api_agent_return_result" }>> {
  const v = ctx.state.negotiatedVersion;
  const fail = (error: ApiAgentErrorCode): Extract<ControlMessage, { type: "api_agent_return_result" }> =>
    ({ type: "api_agent_return_result", v, id: message.id, ok: false, error });
  const meta = ctx.metadataStore?.get(message.session) ?? null;
  const conversationId = meta?.providerSessionId ?? meta?.claudeSessionId;
  if (meta === null || meta.executionRoute !== "api" || conversationId === undefined) return fail("not_open");
  const id = randomUUID();
  let closed: ApiAgentResult;
  try {
    closed = await ctx.hubRpc<ApiAgentResult>({ type: "api_agent_close", id, session: message.session }, id, 5_000);
  } catch {
    return fail("worker_failed");
  }
  // 閉じていなかった（hub 再起動後で開いていない）だけなら、最後の実行経路を端末にして戻せる。
  if (closed.status !== "ok" && closed.error !== "not_open") return fail(closed.error ?? "worker_failed");
  // engine 側の一覧と hub の actor も片付ける（API 作業の会話の終了。作業フォルダは消さない）。
  try { await killSessionForUser(ctx, message.session, { keepWorktree: true }); } catch { /* 記録は hub が既に消した。 */ }
  deps.ledger.setRoute(conversationId, "terminal");
  // SDK の claude（作業プロセスの子）が終わるのを待つ。残っていると端末の再開が同じ会話を二重に掴む。
  const deadline = Date.now() + (deps.exitWaitMs ?? 10_000);
  while (deps.holders(conversationId).length > 0) {
    if (Date.now() >= deadline) return fail("terminal_stop_failed");
    await new Promise((resolve) => setTimeout(resolve, deps.exitPollMs ?? 200));
  }
  engineDiag(`api-agent return 完了 conversation=${conversationId} name=${message.session}`);
  return { type: "api_agent_return_result", v, id: message.id, ok: true };
}

/** アプリからの準備（Agent SDK の導入, 契機 3）。engine プロセスに 1 つ（同時に 2 回走らせない）。 */
let sharedPreparer: AgentSdkPreparer | null = null;
export function apiAgentPreparer(): AgentSdkPreparer {
  sharedPreparer ??= new AgentSdkPreparer({ log: engineDiag });
  return sharedPreparer;
}

export function prepareResponse(
  message: Extract<ControlMessage, { type: "api_agent_prepare_request" }>,
  v: number,
  preparer: Pick<AgentSdkPreparer, "prepare"> = apiAgentPreparer(),
): Extract<ControlMessage, { type: "api_agent_prepare_response" }> {
  const status = preparer.prepare(message.start);
  switch (status.state) {
    case "ready":
      return { type: "api_agent_prepare_response", v, id: message.id, state: "ready", ...(status.version !== null ? { version: status.version } : {}) };
    case "installing":
      return { type: "api_agent_prepare_response", v, id: message.id, state: "installing", phase: status.phase, startedAtMs: status.startedAtMs };
    case "failed":
      return { type: "api_agent_prepare_response", v, id: message.id, state: "failed", error: status.error, message: status.message };
  }
}

export const apiAgentHandoffHandlers: HandlerRegistry = {
  // 導入そのものは裏で走り、状態はすぐ返す（会話開始の応答待ちに入れない）。
  api_agent_prepare_request: (message, ctx) => {
    ctx.writer.write(prepareResponse(message, ctx.state.negotiatedVersion));
  },
  api_agent_handoff_estimate_request: (message, ctx) => {
    ctx.trackBackground((async () => {
      try { ctx.writer.write(await estimateHandoff(message, ctx)); }
      catch (error) { engineDiag(`api-agent handoff 見積もり失敗: ${String(error)}`); }
    })());
  },
  // セッションの終了と claude の終了待ち（数秒）を含むので read loop を塞がない（conversation_delete と同じ）。
  api_agent_handoff: (message, ctx) => {
    ctx.trackBackground((async () => {
      try { ctx.writer.write(await handoffToApiAgent(message, ctx)); }
      catch (error) {
        engineDiag(`api-agent handoff 失敗: ${String(error)}`);
        ctx.writer.write({ type: "api_agent_handoff_result", v: ctx.state.negotiatedVersion, id: message.id, ok: false,
          error: "terminal_stop_failed", message: API_AGENT_ERROR_MESSAGES.terminal_stop_failed });
      }
    })());
  },
  api_agent_return: (message, ctx) => {
    ctx.trackBackground((async () => {
      try { ctx.writer.write(await returnToTerminal(message, ctx)); }
      catch (error) {
        engineDiag(`api-agent return 失敗: ${String(error)}`);
        ctx.writer.write({ type: "api_agent_return_result", v: ctx.state.negotiatedVersion, id: message.id, ok: false, error: "worker_failed" });
      }
    })());
  },
};
