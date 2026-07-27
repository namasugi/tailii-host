// engine/handlers/preview.ts
// Web プレビューと開発サーバー: loopback 静的配信の開始/終了、LISTEN 中サーバーの
// 一覧（serve-list）と停止（pid+port 照合）。

import { listServeProcesses, stopServeProcess } from "../../services/serveService.js";
import { engineDiag, type HandlerRegistry } from "../context.js";

export const previewHandlers: HandlerRegistry = {
  preview_open: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // Web プレビュー: HTML ファイルの loopback 静的配信を開始し、到達 URL を返す。
    // iOS はこの URL の port へ direct-tcpip トンネルを張って開く。
    try {
      const { url } = await ctx.previewServer.open(message.id, message.target);
      writer.write({ type: "preview_ready", v, id: message.id, url });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        writer.write({ type: "preview_error", v, id: message.id, message: detail });
      } catch (writeError) {
        process.stderr.write(
          `[tailii-host engine] preview_error 書込失敗: ${String(writeError)}\n`,
        );
      }
    }
  },

  preview_close: async (message, ctx) => {
    await ctx.previewServer.close(message.id);
  },

  serve_list_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // Mac 上で LISTEN 中の開発サーバー一覧（serve-list）。engine 自身
    // （previewServer の loopback 静的サーバー含む）は除外する。
    engineDiag(`serve_list_request id=${message.id}`);
    try {
      const servers = await listServeProcesses({ excludePids: [process.pid], withTitles: true });
      writer.write({ type: "serve_list_response", v, id: message.id, servers });
    } catch (error) {
      engineDiag(`serve_list_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "serve_list_response", v, id: message.id, servers: [] });
    }
  },

  serve_stop_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // 開発サーバーの停止。pid+port の現在照合つき（pid 再利用の誤爆防止）。
    engineDiag(`serve_stop_request id=${message.id} pid=${message.pid} port=${message.port}`);
    try {
      const result = await stopServeProcess(message.pid, message.port);
      writer.write({ type: "serve_stop_response", v, id: message.id, ...result });
    } catch (error) {
      engineDiag(`serve_stop_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "serve_stop_response", v, id: message.id, ok: false, error: String(error) });
    }
  },
};
