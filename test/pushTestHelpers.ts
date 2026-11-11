// pushTestHelpers.ts — push v1 のテスト共通部品（端末の見本・記録するだけの送信器・メモリ上の端末ストア）

import type { PushDeviceRecord } from "../src/push/pushDeviceStore.js";
import { resolvePushPrefs } from "../src/push/pushDeviceStore.js";
import type { PushSendRequest, PushSendResult, PushTransport } from "../src/push/pushTransport.js";

export const DEVICE_ID = "7B0C3A52-6E7B-4C1D-9A55-0F2E4B1C9D10";
export const SECOND_DEVICE_ID = "11111111-2222-3333-4444-555555555555";
/** golden の鍵（00..1f）。 */
export const PUSH_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

export function sampleDevice(overrides: Partial<PushDeviceRecord> = {}): PushDeviceRecord {
  return {
    deviceId: DEVICE_ID,
    deviceName: "iPhone",
    deviceToken: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
    environment: "production",
    bundleId: "com.namasugi.tailii",
    pushKey: PUSH_KEY,
    relay: { url: "https://relay.example", capability: "cap-1", expiresAt: 2_000_000_000 },
    prefs: resolvePushPrefs({}),
    updatedAt: 100,
    ...overrides,
  };
}

/** メモリ上の端末ストア（dispatcher が使う部分だけ）。 */
export class MemoryDeviceStore {
  devices: PushDeviceRecord[];
  readonly deleted: string[] = [];
  readonly invalidated: { deviceId: string; capability: string }[] = [];

  constructor(devices: PushDeviceRecord[]) {
    this.devices = devices;
  }

  list(): PushDeviceRecord[] {
    return this.devices.map((device) => ({ ...device }));
  }

  refreshState(deviceId: string): { state: "present"; record: PushDeviceRecord } | { state: "absent" } {
    const current = this.devices.find((device) => device.deviceId === deviceId);
    return current === undefined ? { state: "absent" } : { state: "present", record: { ...current, prefs: { ...current.prefs } } };
  }

  deleteIfRevision(deviceId: string, revision: string | undefined): boolean {
    const current = this.devices.find((device) => device.deviceId === deviceId);
    if (current === undefined || current.revision !== revision) return false;
    this.deleted.push(deviceId);
    this.devices = this.devices.filter((device) => device.deviceId !== deviceId);
    return true;
  }

  markCapabilityInvalid(deviceId: string, capability: string, revision?: string): boolean {
    const current = this.devices.find((device) => device.deviceId === deviceId);
    if (current?.relay?.capability !== capability || (revision !== undefined && current.revision !== revision)) return false;
    this.invalidated.push({ deviceId, capability });
    this.devices = this.devices.map((device) =>
      device.deviceId === deviceId ? { ...device, relay: { ...device.relay!, invalid: true } } : device);
    return true;
  }
}

/** 送信要求を記録し、決めた結果を返す送信器。 */
export class RecordingTransport implements PushTransport {
  readonly requests: PushSendRequest[] = [];

  constructor(
    readonly kind: "relay" | "direct",
    private readonly result: PushSendResult | ((request: PushSendRequest) => Promise<PushSendResult>) = { status: "ok", detail: "relay-200" },
  ) {}

  async send(request: PushSendRequest): Promise<PushSendResult> {
    this.requests.push(request);
    return typeof this.result === "function" ? this.result(request) : this.result;
  }
}
