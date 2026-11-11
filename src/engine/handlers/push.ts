// engine/handlers/push.ts
// プッシュ通知（push v1, protocol/push-v1.md §1）: 端末登録・解除と在席の申告・生存確認の応答。
//
// 端末記録の書き手は hub だけ。engine は push_register / push_unregister を hub へ中継し、hub の応答を
// iOS へ返す（hub に届かなければ failed。アプリは接続のたびに登録し直すので次の接続で回復する）。
// client_presence / presence_pong も hub へ中継する（判断は hub の dispatcher が行う）。
//
// pushKey / capability / device token はログに出さない。

import { randomUUID } from "node:crypto";
import { isValidDeviceId, normalizeDeviceId } from "../../push/pushDeviceStore.js";
import type { HubServerMessage } from "../../hub/hubProtocol.js";
import { engineDiag, type HandlerRegistry } from "../context.js";

/** hub の登録処理を待つ上限（ms）。 */
const HUB_PUSH_DEVICE_RPC_TIMEOUT_MS = 5_000;
const HUB_UNREACHABLE = "ホスト側の通知の受付に届きませんでした";

export const pushHandlers: HandlerRegistry = {
  push_register: async (message, ctx) => {
    const v = ctx.state.negotiatedVersion;
    const rpcId = randomUUID();
    try {
      const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "push_device_register_result" }>>(
        { type: "push_device_register", id: rpcId, payload: message }, rpcId, HUB_PUSH_DEVICE_RPC_TIMEOUT_MS,
      );
      engineDiag(`push_register id=${message.id} status=${result.status} transport=${result.transport}` +
        (result.capabilityInvalid === true ? " capabilityInvalid" : ""));
      ctx.writer.write({
        type: "push_register_result", v, id: message.id, status: result.status, transport: result.transport,
        ...(result.capabilityInvalid === true ? { capabilityInvalid: true } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    } catch {
      engineDiag(`push_register id=${message.id} hub unreachable`);
      ctx.writer.write({ type: "push_register_result", v, id: message.id, status: "failed", transport: "none", error: HUB_UNREACHABLE });
    }
  },

  push_unregister: async (message, ctx) => {
    const v = ctx.state.negotiatedVersion;
    const rpcId = randomUUID();
    let status: "ok" | "failed" = "failed";
    try {
      const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "push_device_unregister_result" }>>(
        { type: "push_device_unregister", id: rpcId, deviceId: message.deviceId }, rpcId, HUB_PUSH_DEVICE_RPC_TIMEOUT_MS,
      );
      status = result.status;
    } catch {
      status = "failed";
    }
    engineDiag(`push_unregister id=${message.id} status=${status}`);
    ctx.writer.write({ type: "push_unregister_result", v, id: message.id, status });
  },

  client_presence: (message, ctx) => {
    if (!isValidDeviceId(message.deviceId)) return;
    const presence = { deviceId: normalizeDeviceId(message.deviceId), state: message.state };
    ctx.state.pushPresence = presence;
    engineDiag(`client_presence state=${message.state}`);
    ctx.hubLink.send({ type: "client_presence", ...presence });
  },

  presence_pong: (message, ctx) => {
    ctx.hubLink.send({ type: "presence_pong", id: message.id });
  },
};
