// pushRegistration.ts
// tailii (TS host) — 端末登録・解除の処理（push v1, protocol/push-v1.md §1）。**hub だけが呼ぶ**。
//
// engine は iOS の push_register / push_unregister を hub へ中継し、hub がここで検証・保存して結果を返す
// （端末記録の書き手を hub に一本化する）。リレーが 401 を返した capability のまま再登録されたら
// `capabilityInvalid: true` で取り直しを促す。pushKey / capability / device token はログに出さない。

import { ApnsConfigStore } from "./apnsConfigStore.js";
import { decodePushKey } from "./pushEnvelope.js";
import {
  isValidDeviceId,
  isValidDeviceToken,
  normalizeDeviceId,
  type PushDeviceRecord,
  PushDeviceStore,
  resolvePushPrefs,
} from "./pushDeviceStore.js";
import { choosePushTransport, relayPushUrl } from "./pushTransport.js";
import { defaultApnsBase } from "./pushTypes.js";
import type { ControlMessage } from "../protocol.js";

const DEVICE_NAME_MAX_CHARS = 100;
const BUNDLE_ID_MAX_CHARS = 200;
/** リレーの capability 受付上限（relay/src/handler.ts と同じ 2048 バイト）。 */
const CAPABILITY_MAX_BYTES = 2_048;

type PushRegister = Extract<ControlMessage, { type: "push_register" }>;

/** 検証エラーの文言（アプリにそのまま返す。秘密の値は含めない）。 */
export function validatePushRegister(message: PushRegister): string | null {
  if (!isValidDeviceId(message.deviceId)) return "deviceId が UUID ではありません";
  if (!isValidDeviceToken(message.deviceToken)) return "deviceToken が 16 進文字列ではありません";
  if (decodePushKey(message.pushKey) === null) return "pushKey が 32 バイトではありません";
  if (message.bundleId.length === 0 || message.bundleId.length > BUNDLE_ID_MAX_CHARS) return "bundleId が不正です";
  if (message.relay !== undefined) {
    if (relayPushUrl(message.relay.url) === null) return "relay.url が https:// ではありません";
    // リレーの受付（2048 バイト以内）と揃える。中身は不透明なので印字可能な ASCII（空白なし）だけを確かめる。
    if (Buffer.byteLength(message.relay.capability, "utf8") > CAPABILITY_MAX_BYTES ||
      !/^[\x21-\x7e]+$/u.test(message.relay.capability)) {
      return "relay.capability が不正です";
    }
    if (!Number.isFinite(message.relay.expiresAt)) return "relay.expiresAt が不正です";
  }
  return null;
}

/**
 * push_register を処理して結果を返す（engine のハンドラとテストが共有する）。
 * 保存先・APNs 設定・時刻は注入できる（既定は `~/.tailii/push` / `~/.tailii/apns`）。
 */
export function handlePushRegister(
  message: PushRegister,
  deps: { store?: PushDeviceStore; apnsConfigStore?: ApnsConfigStore; nowSeconds?: number } = {},
): Extract<ControlMessage, { type: "push_register_result" }> {
  const base = { type: "push_register_result" as const, v: message.v, id: message.id };
  const invalid = validatePushRegister(message);
  if (invalid !== null) return { ...base, status: "failed", transport: "none", error: invalid };
  const store = deps.store ?? new PushDeviceStore();
  const apnsConfig = (deps.apnsConfigStore ?? new ApnsConfigStore(defaultApnsBase())).load();
  const nowSeconds = deps.nowSeconds ?? Math.floor(Date.now() / 1000);
  // 401 を受けた capability のまま来た = アプリがまだ取り直していない。印を残して取り直しを促す。
  // 直前の記録の読み込みと保存はロックの中で行う（hub の印付け・削除と競合して更新を失わない）。
  let stillInvalid = false;
  let record: PushDeviceRecord | null;
  try {
    record = store.upsert(message.deviceId, (previous) => {
      stillInvalid = message.relay !== undefined && previous?.relay?.invalid === true &&
        previous.relay.capability === message.relay.capability;
      return {
        deviceId: normalizeDeviceId(message.deviceId),
        deviceName: [...message.deviceName].slice(0, DEVICE_NAME_MAX_CHARS).join(""),
        deviceToken: message.deviceToken,
        environment: message.environment,
        bundleId: message.bundleId,
        pushKey: message.pushKey,
        ...(message.relay !== undefined
          ? {
              relay: {
                url: message.relay.url,
                capability: message.relay.capability,
                expiresAt: message.relay.expiresAt,
                ...(stillInvalid ? { invalid: true } : {}),
              },
            }
          : {}),
        prefs: resolvePushPrefs(message.prefs),
        updatedAt: nowSeconds,
      };
    });
  } catch {
    record = null;
  }
  if (record === null) return { ...base, status: "failed", transport: "none", error: "端末の登録を保存できませんでした" };
  const transport = choosePushTransport(record, apnsConfig, nowSeconds);
  return { ...base, status: "ok", transport, ...(stillInvalid ? { capabilityInvalid: true } : {}) };
}

/** push_unregister の結果。もともと無い（absent）は成功扱い、削除に失敗したら failed（アプリは解除できていないと分かる）。 */
export function handlePushUnregister(deviceId: string, store: PushDeviceStore = new PushDeviceStore()): "ok" | "failed" {
  return isValidDeviceId(deviceId) && store.delete(deviceId) !== "failed" ? "ok" : "failed";
}

