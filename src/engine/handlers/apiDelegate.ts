import type { HandlerRegistry } from "../context.js";
import { DelegateError, runClaudeApiDelegate } from "../../services/claudeApiDelegate.js";
import { runOpenAIApiDelegate } from "../../services/openaiApiDelegate.js";
import { claudeApiFederation, FederationError } from "../../services/claudeApiFederation.js";
import { apiDelegateHostKeys } from "../../services/apiDelegateHostKeys.js";

export function createApiDelegateHandlers(run: typeof runClaudeApiDelegate = (request, signal) =>
  request.provider === "openai" ? runOpenAIApiDelegate(request, signal) : runClaudeApiDelegate(request, signal)): HandlerRegistry { return {
  api_delegate_options_request: async (message, ctx) => {
    ctx.writer.write({ type: "api_delegate_options_response", v: ctx.state.negotiatedVersion, id: message.id, supported: true, supportsAttachments: true, supportsHistory: true, supportsOpenAI: true,
      federation: await claudeApiFederation.list(), hostApiKeys: apiDelegateHostKeys() });
  },
  api_federation_check_request: async (message, ctx) => {
    const status = await claudeApiFederation.check(message.selection, AbortSignal.timeout(18_000));
    ctx.writer.write({ type: "api_federation_check_response", v: ctx.state.negotiatedVersion, id: message.id, status });
  },
  api_federation_create_request: async (message, ctx) => {
    try {
      const profile = await claudeApiFederation.create(message.configuration);
      ctx.writer.write({ type: "api_federation_create_response", v: ctx.state.negotiatedVersion, id: message.id, profile });
    } catch (error) {
      ctx.writer.write({ type: "api_federation_create_response", v: ctx.state.negotiatedVersion, id: message.id,
        error: error instanceof FederationError ? error.code : "federation_invalid_config" });
    }
  },
  api_delegate_request: async (message, ctx) => {
    const { state, writer } = ctx;
    const running = state.apiDelegates ??= new Map();
    const completed = state.apiDelegateResponses ??= new Map();
    const cached = completed.get(message.id);
    if (cached) { writer.write(cached); return; }
    if (state.apiDelegateCancelled?.has(message.id)) {
      writer.write({ type: "api_delegate_response", v: state.negotiatedVersion, id: message.id, error: "cancelled" });
      return;
    }
    // 同一 id の再送は進行中の要求を待たせるだけで再実行しない。
    if (running.has(message.id)) return;
    const attempted = state.apiDelegateAttempted ??= new Set();
    // 回答のキャッシュを捨てた後も実行済み id は忘れない。古い要求を再課金しない。
    if (attempted.has(message.id)) {
      writer.write({ type: "api_delegate_response", v: state.negotiatedVersion, id: message.id, error: "outcome_unknown" });
      return;
    }
    if (attempted.size >= 4096) {
      writer.write({ type: "api_delegate_response", v: state.negotiatedVersion, id: message.id, error: "request_limit" });
      return;
    }
    if (running.size >= 1) {
      writer.write({ type: "api_delegate_response", v: state.negotiatedVersion, id: message.id, error: "busy" });
      return;
    }
    const abort = new AbortController();
    running.set(message.id, abort);
    attempted.add(message.id);
    let response: Extract<import("../../protocol.js").ControlMessage, { type: "api_delegate_response" }>;
    try {
      const result = await run(message.request, abort.signal);
      // 生成画像はAPI会話の応答にだけ載せる。通常の会話へimage_availableを流し込まない。
      for (const image of result.images ?? []) {
        try {
          const preview = await ctx.imageService?.makeAvailable(image.path, image.id);
          if (preview) {
            image.thumbnail = preview.thumbnail;
            image.width = preview.width; image.height = preview.height;
          }
        } catch { /* 画像の原本は保存済み。サムネ失敗で再生成・再課金しない。 */ }
      }
      response = { type: "api_delegate_response", v: state.negotiatedVersion, id: message.id, result };
    } catch (error) {
      response = { type: "api_delegate_response", v: state.negotiatedVersion, id: message.id,
        error: error instanceof DelegateError ? error.code : "unavailable" };
    } finally { running.delete(message.id); }
    completed.set(message.id, response);
    if (completed.size > 16) completed.delete(completed.keys().next().value!);
    writer.write(response);
  },
  api_delegate_cancel: (message, ctx) => {
    const cancelled = ctx.state.apiDelegateCancelled ??= new Set();
    cancelled.add(message.id);
    if (cancelled.size > 32) cancelled.delete(cancelled.values().next().value!);
    ctx.state.apiDelegates?.get(message.id)?.abort();
  },
}; }

export const apiDelegateHandlers = createApiDelegateHandlers();
