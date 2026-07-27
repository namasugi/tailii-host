// engine/handlers/codex.ts
// Codex App Server 連携: モデル一覧・turn 開始（Hub 所有 turn への submit）・turn 中断。

import type { HubServerMessage } from "../../hub/hubProtocol.js";
import { writeError, type HandlerRegistry } from "../context.js";

export const codexHandlers: HandlerRegistry = {
  codex_model_list_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    if (ctx.codexAppServer === null) {
      writeError(
        writer,
        v,
        message.id,
        "codex_app_server_unavailable",
        "Codex App Server が未構成です。",
      );
      return;
    }
    try {
      const models = await ctx.codexAppServer.listModels();
      writer.write({ type: "codex_model_list_response", v, id: message.id, models });
    } catch (error) {
      writeError(writer, v, message.id, "codex_model_list_failed", String(error));
    }
  },

  codex_turn_start: async (message, ctx) => {
    const { writer, state, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    const meta = metadataStore?.get(message.session) ?? null;
    const providerSessionId = meta?.providerSessionId ?? null;
    if (meta?.agent !== "codex" || providerSessionId === null) {
      writeError(
        writer,
        v,
        message.id,
        "codex_thread_not_found",
        `Codex App Server thread がセッション '${message.session}' に束縛されていません。`,
      );
      return;
    }
    try {
      try {
        const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "codex_turn_result" }>>(
          { type: "codex_turn_submit", id: message.id, session: message.session,
            text: message.text, clientUserMessageId: message.clientUserMessageId ?? message.id,
            effort: message.effort ?? null,
            approvalPolicy: message.approvalPolicy ?? null,
            sandbox: message.sandbox ?? null,
            threadId: providerSessionId, cwd: meta.cwd,
            ...(message.explicitRetry === true ? { explicitRetry: true } : {}) },
          message.id, ctx.codexHubRpcTimeoutMs,
        );
        writer.write({
          type: "codex_turn_start_result",
          v,
          id: result.id,
          status: result.status,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        return;
      } catch (error) {
        // timeout は「未開始」と「開始済みだが ACK 消失」を区別できない。local controller
        // へ fail-open すると後者で二重 turn になるため、相関可能な failed を返して
        // durable outbox の同一 clientUserMessageId 再送へ委ねる。
        writer.write({
          type: "codex_turn_start_result",
          v,
          id: message.id,
          status: "failed",
          error: String(error),
        });
        return;
      }
    } catch (error) {
      writer.write({
        type: "codex_turn_start_result",
        v,
        id: message.id,
        status: "failed",
        error: String(error),
      });
    }
  },

  codex_turn_interrupt: async (message, ctx) => {
    const { writer, state, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    const meta = metadataStore?.get(message.session) ?? null;
    const providerSessionId = meta?.providerSessionId ?? null;
    if (meta?.agent !== "codex" || providerSessionId === null) {
      writeError(
        writer,
        v,
        message.id,
        "codex_thread_not_found",
        `Codex App Server thread がセッション '${message.session}' に束縛されていません。`,
      );
      return;
    }
    // hub 所有 turn への fire-and-forget 中断。切断中は hubClient が破棄する。
    // 中断を再接続後まで queue すると、その時点の別 turn を誤って止めるため遅延配送しない。
    ctx.hubLink.send({
      type: "codex_turn_interrupt",
      id: message.id,
      session: message.session,
    });
    // 埋め込み Hub / 旧構成との互換用に、注入されたローカル controller にも試みる。
    // 現行の hub 所有構成では turn 未所有なので no-op。
    try {
      await ctx.codexTurnController?.interruptTurn?.(message.session);
    } catch (error) {
      writeError(writer, v, message.id, "codex_turn_interrupt_failed", String(error));
    }
  },
};
