// engine/handlers/apiAgent.ts
// API 作業（api-agent）の engine 側: 会話の作成（session_start の executionRoute:"api"）・設定変更・中断。
//
// 端末（pane）は作らない。メタデータ（executionRoute:"api"）を書き、hub に会話を開かせ、会話の表示は
// 通常の Claude 会話と同じく JSONL の tail（conversation_subscribe）で配る。発話は通常の chat_send で
// hub へ届き、hub の chatInjector が API 作業のターンへ渡す。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { API_AGENT_ERROR_MESSAGES } from "../../apiAgent/config.js";
import { conversationHolders } from "../../apiAgent/exclusivity.js";
import { isConversationUuid } from "../../apiAgent/workerProtocol.js";
import type { HubServerMessage } from "../../hub/hubProtocol.js";
import type { ApiAgentErrorCode, ControlMessage } from "../../protocol.js";
import { expandTilde, standardize } from "../../shared/paths.js";
import {
  activateOrTouchSession,
  engineDiag,
  writeError,
  writeSessionListResponse,
  sessionInfoFromMeta,
  type HandlerContext,
  type HandlerRegistry,
} from "../context.js";

type SessionStartMessage = Extract<ControlMessage, { type: "session_start" }>;
type ApiAgentResult = Extract<HubServerMessage, { type: "api_agent_result" }>;

const HUB_TIMEOUT_MS = 5_000;

function errorText(code: ApiAgentErrorCode | undefined): string {
  return API_AGENT_ERROR_MESSAGES[code ?? "worker_failed"];
}

/** 作業フォルダ（baseDir 相対・`~` を解決し、実在するディレクトリだけ）。 */
function resolveCwd(cwd: string, baseDir: string | undefined): string | null {
  const expanded = expandTilde(cwd);
  const absolute = path.isAbsolute(expanded) ? expanded : baseDir !== undefined ? path.join(expandTilde(baseDir), expanded) : null;
  if (absolute === null) return null;
  const normalized = standardize(absolute);
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : null;
  } catch {
    return null;
  }
}

/** session_start（executionRoute:"api"）。成功時は通常の起動と同じ様式（一覧）で応答する。 */
export async function startApiAgentSession(message: SessionStartMessage, ctx: HandlerContext): Promise<void> {
  const { writer, state, metadataStore, sessionManager } = ctx;
  const v = state.negotiatedVersion;
  const config = message.apiAgent;
  if (config === undefined || metadataStore === null || (message.agentType !== undefined && message.agentType !== "claude")) {
    writeError(writer, v, message.id, "launch_failed", errorText("invalid_config"));
    return;
  }
  const cwd = resolveCwd(message.cwd, message.baseDir);
  if (cwd === null) {
    writeError(writer, v, message.id, "launch_failed", "作業フォルダが見つかりません。");
    return;
  }
  const resume = message.resumeSessionId !== undefined;
  const conversationId = message.resumeSessionId ?? randomUUID();
  if (!isConversationUuid(conversationId)) {
    writeError(writer, v, message.id, "launch_failed", errorText("invalid_config"));
    return;
  }
  // 同じ会話を端末側（Tailii の pane・Tailii 外の claude）で動かしていれば作らない（hub もターンの直前に確かめる）。
  const existing = metadataStore.get(message.name);
  if (existing !== null && existing.executionRoute !== "api") {
    writeError(writer, v, message.id, "launch_failed", errorText("conversation_in_use"));
    return;
  }
  const shouldSubscribe = message.deferSubscribe !== true;
  try {
    const live = (await sessionManager.list()).find((info) => info.alive && info.name !== message.name &&
      (info.agent ?? "claude") === "claude" && (info.providerSessionId ?? info.claudeSessionId) === conversationId);
    if (live !== undefined && live.executionRoute === "api") {
      // 同じ会話を別の名前の API 作業で開いている → それを使う（端末の会話の別名再利用と同じ）。
      engineDiag(`api-agent resume alias reuse existing=${live.name} requested=${message.name}`);
      if (!await activateOrTouchSession(ctx, writer, v, message.id, live.name, shouldSubscribe)) return;
      writeSessionListResponse(writer, v, message.id, [live], null, live.name);
      return;
    }
    // 既に自分（この名前の API 作業）が開いている会話なら、実行中のターンの claude が登録簿に載っていても断らない。
    const ownsAlready = existing?.executionRoute === "api" &&
      (existing.providerSessionId ?? existing.claudeSessionId) === conversationId;
    if (live !== undefined || (!ownsAlready && conversationHolders(conversationId).length > 0)) {
      writeError(writer, v, message.id, "launch_failed", errorText("conversation_in_use"));
      return;
    }
  } catch {
    // 一覧が取れなくても、hub がターンの直前に登録簿で確かめる。
  }
  const opened = await openApiAgentRuntime(ctx, { name: message.name, cwd, conversationId, resume, config });
  if (opened !== null) {
    writeError(writer, v, message.id, "launch_failed", errorText(opened));
    return;
  }
  engineDiag(`api-agent open name=${message.name} id=${conversationId} resume=${resume}`);
  if (!await activateOrTouchSession(ctx, writer, v, message.id, message.name, shouldSubscribe)) return;
  try {
    writeSessionListResponse(writer, v, message.id,
      shouldSubscribe ? await sessionManager.list() : [sessionInfoFromMeta(metadataStore, message.name, cwd)], null, message.name);
  } catch {
    writeSessionListResponse(writer, v, message.id, [sessionInfoFromMeta(metadataStore, message.name, cwd)], null, message.name);
  }
}

/**
 * API 作業のメタデータを書いて hub に会話を開かせる（新規・開き直し・引き継ぎで共有）。失敗は理由を返し、
 * 書き換えたメタデータは元へ戻す（端末で今までどおり開き直せる状態を保つ）。
 */
export async function openApiAgentRuntime(
  ctx: HandlerContext,
  request: { name: string; cwd: string; conversationId: string; resume: boolean; config: import("../../protocol.js").ApiAgentConfig },
): Promise<ApiAgentErrorCode | null> {
  const { metadataStore } = ctx;
  if (metadataStore === null) return "invalid_config";
  const previous = metadataStore.get(request.name);
  metadataStore.put({
    name: request.name, cwd: request.cwd, createdAt: Math.floor(Date.now() / 1_000), agent: "claude",
    claudeSessionId: request.conversationId, providerSessionId: request.conversationId, executionRoute: "api",
  });
  const id = randomUUID();
  let result: ApiAgentResult;
  try {
    result = await ctx.hubRpc<ApiAgentResult>(
      { type: "api_agent_open", id, session: request.name, conversationId: request.conversationId, cwd: request.cwd,
        config: request.config, resume: request.resume }, id, HUB_TIMEOUT_MS,
    );
  } catch (error) {
    engineDiag(`api-agent open 失敗 name=${request.name}: ${String(error)}`);
    result = { type: "api_agent_result", id, status: "failed", error: "worker_failed" };
  }
  if (result.status !== "ok") {
    if (previous !== null && previous.executionRoute !== "api") metadataStore.put(previous);
    return result.error ?? "worker_failed";
  }
  return null;
}

/** api_agent_configure（予算・モデル・権限モード・キーの取得元の変更）。 */
export async function configureApiAgent(
  message: Extract<ControlMessage, { type: "api_agent_configure" }>,
  ctx: HandlerContext,
): Promise<void> {
  const { writer, state } = ctx;
  const v = state.negotiatedVersion;
  const id = randomUUID();
  let ok = false;
  let error: ApiAgentErrorCode | undefined;
  try {
    const result = await ctx.hubRpc<ApiAgentResult>(
      { type: "api_agent_configure", id, session: message.session, config: message.config }, id, HUB_TIMEOUT_MS,
    );
    ok = result.status === "ok";
    error = result.error;
  } catch {
    error = "worker_failed";
  }
  writer.write({
    type: "api_agent_configure_result", v, id: message.id, session: message.session, ok,
    ...(!ok ? { error: error ?? "worker_failed" } : {}),
  });
}

/** 中断（端末の Esc / C-c に相当）。処理中のターンが無ければ false。 */
export async function interruptApiAgent(ctx: HandlerContext, session: string): Promise<boolean> {
  const id = randomUUID();
  const result = await ctx.hubRpc<ApiAgentResult>({ type: "api_agent_interrupt", id, session }, id, HUB_TIMEOUT_MS);
  return result.status === "ok" && result.interrupted === true;
}

export const apiAgentHandlers: HandlerRegistry = {
  api_agent_configure: (message, ctx) => configureApiAgent(message, ctx),
};
