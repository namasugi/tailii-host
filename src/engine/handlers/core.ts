// engine/handlers/core.ts
// チャネル制御と host 設定: バージョン交渉（channel_hello）と
// 端末バックエンド設定の読み書き（backend_get/backend_set, session-backend）。

import { engineDiag, type HandlerRegistry } from "../context.js";
import { recordClientBuild } from "../../shared/clientBuild.js";
import { isValidHerdrSessionName } from "../../backend/herdr.js";

export const coreHandlers: HandlerRegistry = {
  channel_hello: (message, ctx) => {
    const { state } = ctx;
    // 採用版 = min(自分の maxVersion, 相手の maxVersion)（4.3）。
    state.negotiatedVersion = Math.min(state.ownMaxVersion, message.maxVersion);
    if (message.clientKind === "cli") state.clientKind = "cli";
    // アプリが名乗ったバージョン/ビルド番号を記録する（host-auto-update）。旧アプリは省略する。
    const client =
      message.clientBuild !== undefined
        ? ` client=${message.clientVersion ?? "?"} (${message.clientBuild})`
        : "";
    process.stderr.write(
      `[tailii-host engine] channel_hello negotiated v=${state.negotiatedVersion}${client}\n`,
    );
    if (message.clientBuild !== undefined) {
      const advanced = recordClientBuild(
        {
          clientBuild: message.clientBuild,
          ...(message.clientVersion !== undefined ? { clientVersion: message.clientVersion } : {}),
        },
        ctx.clientBuildRecordPath,
      );
      if (advanced) engineDiag(`latestClientBuild advanced to ${message.clientBuild}`);
    }
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
      herdrSession: ctx.herdrSessionName(),
    });
  },

  backend_set_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // 端末バックエンド設定の書き込み。稼働系は常時 Composite なので再起動不要、
    // 「次に起動するセッション」から反映される。herdr 未導入時は書かずに失敗を返す。
    // `herdrSession`（herdr-session-setting）は載っているときだけ書く。どちらかが書けなければ何も書かない。
    engineDiag(
      `backend_set_request id=${message.id} backend=${message.backend}` +
        (message.herdrSession !== undefined ? ` herdrSession=${JSON.stringify(message.herdrSession)}` : ""),
    );
    const fail = (error: string) =>
      writer.write({
        type: "backend_set_response",
        v,
        id: message.id,
        ok: false,
        backend: ctx.backendKind(),
        error,
        herdrSession: ctx.herdrSessionName(),
      });
    if (message.herdrSession !== undefined && !isValidHerdrSessionName(message.herdrSession)) {
      fail("herdr のセッション名は英数字と . _ - で付けてください（先頭は英数字か _、64 文字まで）。");
      return;
    }
    if (message.backend === "herdr" && !ctx.herdrInstalledProbe()) {
      fail("herdr が見つかりません（~/.local/bin/herdr）。導入後に切り替えてください。");
      return;
    }
    try {
      if (message.herdrSession !== undefined) ctx.herdrSessionWriter(message.herdrSession);
      ctx.backendWriter(message.backend);
      writer.write({
        type: "backend_set_response",
        v,
        id: message.id,
        ok: true,
        backend: message.backend,
        error: null,
        herdrSession: ctx.herdrSessionName(),
      });
    } catch (error) {
      engineDiag(`backend_set_response 失敗 id=${message.id}: ${String(error)}`);
      fail(String(error));
    }
  },
};
