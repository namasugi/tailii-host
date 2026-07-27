// engine/handlers/officialApps.ts
// Claude / ChatGPT 公式アプリ連携: 状態問い合わせと action 実行。
// action 実行の前後でフォーカス・provider・生存を再検証し、別セッションへ
// URL / pairing material を返さない。

import { officialAppRuntimeContext, type HandlerRegistry } from "../context.js";

export const officialAppHandlers: HandlerRegistry = {
  official_app_status_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    if (ctx.officialApps === null) {
      writer.write({
        type: "official_app_status_response",
        v,
        id: message.id,
        provider: message.provider,
        state: "unavailable",
        canOpen: false,
        canStart: false,
        unavailableReason: "official_feature_unavailable",
      });
      return;
    }
    const resolved = await officialAppRuntimeContext(
      ctx,
      message.session,
      message.provider,
    );
    const status =
      "reason" in resolved
        ? {
            provider: message.provider,
            state: "unavailable" as const,
            canOpen: false,
            canStart: false,
            unavailableReason: resolved.reason,
          }
        : await ctx.officialApps.status(resolved.context);
    writer.write({ type: "official_app_status_response", v, id: message.id, ...status });
  },

  official_app_action_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    if (ctx.officialApps === null) {
      writer.write({
        type: "official_app_action_response",
        v,
        id: message.id,
        provider: message.provider,
        outcome: "unavailable",
        unavailableReason: "official_feature_unavailable",
      });
      return;
    }
    const before = await officialAppRuntimeContext(ctx, message.session, message.provider);
    if ("reason" in before) {
      writer.write({
        type: "official_app_action_response",
        v,
        id: message.id,
        provider: message.provider,
        outcome: "unavailable",
        unavailableReason: before.reason,
      });
      return;
    }
    const result = await ctx.officialApps.perform(
      before.context,
      message.action,
      message.automaticEnable,
      message.paired,
    );
    // 外部 CLI / pane 操作の間に対象が失われた場合、別セッションへ URL や
    // pairing material を返さない。再フォーカス後の再試行だけを許す。
    const after = await officialAppRuntimeContext(ctx, message.session, message.provider);
    if ("reason" in after) {
      writer.write({
        type: "official_app_action_response",
        v,
        id: message.id,
        provider: message.provider,
        outcome: "unavailable",
        unavailableReason: after.reason,
      });
      return;
    }
    writer.write({ type: "official_app_action_response", v, id: message.id, ...result });
  },
};
