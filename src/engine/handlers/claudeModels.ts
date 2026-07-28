// engine/handlers/claudeModels.ts
// Claude モデル一覧: Anthropic Models API 由来のピッカー候補を返す。session 非依存
// （ドラフトの起動前選択でも使うため）。取得失敗はエラー応答のみ返し、フォールバック
// （キャッシュ表示）は iOS 側の責務とする。

import { writeError, type HandlerRegistry } from "../context.js";

export const claudeModelHandlers: HandlerRegistry = {
  claude_model_list_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const models = await ctx.claudeModelList();
      if (models === null || models.length === 0) {
        writeError(
          writer,
          v,
          message.id,
          "claude_model_list_unavailable",
          "モデル一覧を取得できませんでした（OAuth トークン無効またはオフライン）。",
        );
        return;
      }
      writer.write({ type: "claude_model_list_response", v, id: message.id, models });
    } catch (error) {
      writeError(writer, v, message.id, "claude_model_list_failed", String(error));
    }
  },
};
