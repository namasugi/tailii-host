// engine/handlers/core.ts
// チャネル制御と host 設定: バージョン交渉（channel_hello）と
// 端末バックエンド設定の読み書き（backend_get/backend_set, session-backend）。

import { engineDiag, type HandlerRegistry } from "../context.js";

export const coreHandlers: HandlerRegistry = {
  channel_hello: (message, ctx) => {
    const { state } = ctx;
    // 採用版 = min(自分の maxVersion, 相手の maxVersion)（4.3）。
    state.negotiatedVersion = Math.min(state.ownMaxVersion, message.maxVersion);
    process.stderr.write(
      `[tailii-host engine] channel_hello negotiated v=${state.negotiatedVersion}\n`,
    );
  },

  backend_get_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // 端末バックエンド設定の読み取り（アプリ設定画面, session-backend）。
    engineDiag(`backend_get_request id=${message.id}`);
    writer.write({
      type: "backend_get_response",
      v,
      id: message.id,
      backend: ctx.backendKind(),
      herdrInstalled: ctx.herdrInstalledProbe(),
    });
  },

  backend_set_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // 端末バックエンド設定の書き込み。稼働系は常時 Composite なので再起動不要、
    // 「次に起動するセッション」から反映される。herdr 未導入時は書かずに失敗を返す。
    engineDiag(`backend_set_request id=${message.id} backend=${message.backend}`);
    if (message.backend === "herdr" && !ctx.herdrInstalledProbe()) {
      writer.write({
        type: "backend_set_response",
        v,
        id: message.id,
        ok: false,
        backend: ctx.backendKind(),
        error: "herdr が見つかりません（~/.local/bin/herdr）。導入後に切り替えてください。",
      });
      return;
    }
    try {
      ctx.backendWriter(message.backend);
      writer.write({
        type: "backend_set_response",
        v,
        id: message.id,
        ok: true,
        backend: message.backend,
        error: null,
      });
    } catch (error) {
      engineDiag(`backend_set_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({
        type: "backend_set_response",
        v,
        id: message.id,
        ok: false,
        backend: ctx.backendKind(),
        error: String(error),
      });
    }
  },
};
