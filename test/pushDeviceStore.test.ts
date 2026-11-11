// pushDeviceStore.test.ts — 宛先端末の保存・間引き記録・最後の送信結果（push v1）

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidDeviceId, PushDeviceStore, resolvePushPrefs } from "../src/push/pushDeviceStore.js";
import { PushLastResultStore, PushSendLog } from "../src/push/pushStateFiles.js";
import { makeTempDir } from "./helpers.js";
import { DEVICE_ID, sampleDevice } from "./pushTestHelpers.js";

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("PushDeviceStore", () => {
  it("1 端末 1 ファイルで保存し、ディレクトリ 0700・ファイル 0600。同じ deviceId は上書き", () => {
    const base = makeTempDir("push-store");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    store.save(sampleDevice());
    store.save(sampleDevice({ deviceId: DEVICE_ID.toLowerCase(), deviceName: "iPhone 2" }));
    const file = path.join(base, "devices", `${DEVICE_ID}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(mode(base)).toBe(0o700);
    expect(mode(path.join(base, "devices"))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.deviceName).toBe("iPhone 2");
    expect(store.get(DEVICE_ID.toLowerCase())?.deviceName).toBe("iPhone 2");
    // 一時ファイルを残さない。
    expect(fs.readdirSync(path.join(base, "devices"))).toEqual([`${DEVICE_ID}.json`]);
  });

  it("複数端末を持てる・delete で消える（無くても成功）", () => {
    const store = new PushDeviceStore({ base: makeTempDir("push-store-multi"), legacyApnsBase: makeTempDir("push-legacy") });
    const second = "11111111-2222-3333-4444-555555555555";
    store.save(sampleDevice());
    store.save(sampleDevice({ deviceId: second }));
    expect(store.list().map((device) => device.deviceId).sort()).toEqual([second, DEVICE_ID].sort());
    store.delete(DEVICE_ID);
    store.delete(DEVICE_ID);
    expect(store.list().map((device) => device.deviceId)).toEqual([second]);
  });

  it("deviceId は UUID の形だけ（パス走査を許さない）", () => {
    const base = makeTempDir("push-store-traversal");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    for (const bad of ["../evil", "..", "a/b", "7B0C3A52-6E7B-4C1D-9A55-0F2E4B1C9D10/../../x", "", "7B0C3A52"]) {
      expect(isValidDeviceId(bad)).toBe(false);
      expect(() => store.save(sampleDevice({ deviceId: bad }))).toThrow();
      expect(store.get(bad)).toBeNull();
      store.delete(bad);
    }
    expect(fs.existsSync(path.join(base, "evil.json"))).toBe(false);
  });

  it("壊れたファイル・名前と中身の deviceId が食い違うファイルは使わない", () => {
    const base = makeTempDir("push-store-broken");
    new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") }).save(sampleDevice());
    const other = "11111111-2222-3333-4444-555555555555";
    fs.writeFileSync(path.join(base, "devices", `${other}.json`), JSON.stringify(sampleDevice()));
    fs.writeFileSync(path.join(base, "devices", "22222222-2222-3333-4444-555555555555.json"), "{not json");
    fs.writeFileSync(path.join(base, "devices", "33333333-2222-3333-4444-555555555555.json"),
      JSON.stringify(sampleDevice({ deviceId: "33333333-2222-3333-4444-555555555555", pushKey: "short" })));
    // 壊れたファイルを置いた後に作ったストアの初回の読み込みで、正しい 1 件だけを採用する。
    const fresh = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    expect(fresh.list().map((device) => device.deviceId)).toEqual([DEVICE_ID]);
    expect(fresh.get(other)).toBeNull();
    expect(fresh.refresh(other)).toBeNull();
  });

  it("markCapabilityInvalid は同じ capability のときだけ印を付ける", () => {
    const store = new PushDeviceStore({ base: makeTempDir("push-store-invalid"), legacyApnsBase: makeTempDir("push-legacy") });
    store.save(sampleDevice());
    store.markCapabilityInvalid(DEVICE_ID, "other-cap");
    expect(store.get(DEVICE_ID)?.relay?.invalid).toBeUndefined();
    store.markCapabilityInvalid(DEVICE_ID, "cap-1");
    expect(store.get(DEVICE_ID)?.relay?.invalid).toBe(true);
  });

  it("新しい登録の初回に旧 apns/device-token.json を読み捨てる", () => {
    const legacy = makeTempDir("push-legacy-discard");
    fs.writeFileSync(path.join(legacy, "device-token.json"), "{}");
    new PushDeviceStore({ base: makeTempDir("push-store-legacy"), legacyApnsBase: legacy }).save(sampleDevice());
    expect(fs.existsSync(path.join(legacy, "device-token.json"))).toBe(false);
  });

  it("prefs の無いキーは true 扱い", () => {
    expect(resolvePushPrefs({ turnDone: false })).toEqual({
      turnDone: false, question: true, approval: true, usageLimit: true, turnError: true, showBody: true,
    });
  });
});

describe("PushSendLog / PushLastResultStore", () => {
  it("種別 × 会話ごとに最終送信時刻を持ち、古い記録は保存時に捨てる", () => {
    const base = makeTempDir("push-send-log");
    const log = new PushSendLog(base);
    log.record("turn_done", "s-1", 1_000);
    log.record("question", "s-1", 1_005);
    expect(log.lastSent("turn_done", "s-1")).toBe(1_000);
    expect(log.lastSent("question", "s-1")).toBe(1_005);
    expect(log.lastSent("turn_done", "s-2")).toBeNull();
    log.record("approval", "s-3", 1_000 + 2 * 24 * 60 * 60);
    expect(log.lastSent("turn_done", "s-1")).toBeNull();
    expect(mode(path.join(base, "send-log.json"))).toBe(0o600);
  });

  it("最後の送信結果を保存・読込する（壊れていれば null）", () => {
    const base = makeTempDir("push-last");
    const store = new PushLastResultStore(base);
    expect(store.load()).toBeNull();
    store.save({ at: 10, kind: "turn_done", status: "failed", reason: "relay-502", transport: "relay" });
    expect(store.load()).toEqual({ at: 10, kind: "turn_done", status: "failed", reason: "relay-502", transport: "relay" });
    fs.writeFileSync(path.join(base, "last-result.json"), "{}");
    expect(store.load()).toBeNull();
  });
});
