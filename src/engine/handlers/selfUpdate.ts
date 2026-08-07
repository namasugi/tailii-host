// engine/handlers/selfUpdate.ts — host_update_request（アプリ起点の host 自己更新）
//
// アプリは channel_hello の serverVersion と自分のピン値を照合し、host が古く
// かつ managed=true のときだけこの RPC を送る（旧 host は type を知らないため、
// managed フラグ自体が「この RPC を受けられる」ことの能力広告を兼ねる）。
// 応答は起動可否のみ。完了は updater がシムを切り替えた後の再接続で、
// channel_hello.serverVersion が目標に達したことをもって確認する。

import { engineDiag, type HandlerRegistry } from "../context.js";
import { readPackageVersion } from "../../shared/version.js";
import {
  compareTriple,
  parseTriple,
  resolveInstallState,
  spawnDetachedSelfUpdate,
  updateInProgress,
} from "../../commands/selfUpdate.js";

export const selfUpdateHandlers: HandlerRegistry = {
  host_update_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    engineDiag(`host_update_request id=${message.id} version=${message.version}`);
    const respond = (status: "started" | "already" | "in_progress" | "unsupported" | "error", error?: string): void => {
      writer.write({ type: "host_update_response", v, id: message.id, status, error: error ?? null });
    };

    const target = parseTriple(message.version);
    if (target === null) {
      respond("error", `version が不正です: ${message.version}`);
      return;
    }
    const current = readPackageVersion();
    if (current === message.version) {
      respond("already");
      return;
    }
    const currentTriple = current !== null ? parseTriple(current) : null;
    if (currentTriple !== null && compareTriple(target, currentTriple) < 0) {
      respond("error", `ダウングレード要求(${current} → ${message.version})は受け付けません`);
      return;
    }
    const installState = resolveInstallState();
    if (!installState.managed) {
      respond("unsupported", `自動更新の対象外です(${installState.reason})`);
      return;
    }
    if (updateInProgress()) {
      respond("in_progress");
      return;
    }
    try {
      spawnDetachedSelfUpdate(message.version, message.integrity);
      respond("started");
    } catch (error) {
      respond("error", `updater の起動に失敗: ${String(error)}`);
    }
  },
};
