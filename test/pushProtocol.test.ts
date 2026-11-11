// pushProtocol.test.ts — push v1 の制御メッセージ（golden）・端末登録・hub 内部メッセージ・doctor

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { decodeHubClientLine, decodeHubServerLine, encodeHubMessage } from "../src/hub/hubProtocol.js";
import { handlePushRegister } from "../src/push/pushRegistration.js";
import { PushDeviceStore } from "../src/push/pushDeviceStore.js";
import { ApnsConfigStore } from "../src/push/apnsConfigStore.js";
import { PushLastResultStore } from "../src/push/pushStateFiles.js";
import { pushDoctorCheck } from "../src/commands/doctor.js";
import { makeTempDir } from "./helpers.js";
import { DEVICE_ID, sampleDevice } from "./pushTestHelpers.js";

const goldenPath = path.join(fileURLToPath(import.meta.url), "..", "..", "protocol", "push-v1.ndjson");
const golden = readFileSync(goldenPath, "utf8").split("\n").filter((line) => line.length > 0);

function register(index: number): Extract<ControlMessage, { type: "push_register" }> {
  const message = decodeControlMessage(golden[index]!);
  if (message.type !== "push_register") throw new Error("not push_register");
  return message;
}

function stores() {
  const pushBase = makeTempDir("push-register");
  const apnsBase = makeTempDir("push-register-apns");
  return {
    pushBase,
    apnsBase,
    store: new PushDeviceStore({ base: pushBase, legacyApnsBase: apnsBase }),
    apnsConfigStore: new ApnsConfigStore(apnsBase),
  };
}

describe("push v1 golden", () => {
  it("push-v1.ndjson の全行が byte-exact でラウンドトリップする", () => {
    expect(golden.length).toBeGreaterThan(0);
    for (const line of golden) {
      expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    }
  });

  it("prefs に無いキーは decode 後も省略のまま（host 側で true として解決する）", () => {
    const line = golden[1]!.replace('"prefs":{"approval":true,', '"prefs":{');
    const message = decodeControlMessage(line);
    if (message.type !== "push_register") throw new Error("unreachable");
    expect(message.prefs).not.toHaveProperty("approval");
  });
});

describe("handlePushRegister", () => {
  it("relay 付きの登録を保存し transport: relay を返す（golden pr-1）", () => {
    const s = stores();
    const result = handlePushRegister(register(0), { ...s, nowSeconds: 1_800_000_000 });
    expect(encodeControlMessage(result)).toBe(golden[2]);
    const saved = s.store.get(DEVICE_ID)!;
    expect(saved.relay).toEqual({
      url: "https://example.lambda-url.ap-northeast-1.on.aws",
      capability: "v1.c2VhbGVkLWNhcGFiaWxpdHk",
      expiresAt: 1802076000,
    });
    expect(saved.updatedAt).toBe(1_800_000_000);
    expect(fs.statSync(path.join(s.pushBase, "devices", `${DEVICE_ID}.json`)).mode & 0o777).toBe(0o600);
  });

  it("relay 無し・direct 不可なら transport: none（正当な登録）。prefs を保存する", () => {
    const s = stores();
    const result = handlePushRegister(register(1), { ...s, nowSeconds: 1 });
    expect(result).toMatchObject({ status: "ok", transport: "none" });
    expect(s.store.get(DEVICE_ID)?.prefs).toEqual({
      approval: true, question: true, showBody: false, turnDone: false, turnError: true, usageLimit: true,
    });
  });

  it("~/.tailii/apns/config.json の topic が bundle id と一致すれば direct", () => {
    const s = stores();
    fs.writeFileSync(path.join(s.apnsBase, "config.json"), JSON.stringify({
      teamId: "T", keyId: "K", keyPath: "/k.p8", topic: "com.namasugi.tailii",
    }));
    expect(handlePushRegister(register(1), s).transport).toBe("direct");
  });

  it("pushKey が 32 バイトでなければ failed（golden pr-4 の文言）", () => {
    const s = stores();
    const message = { ...register(0), id: "pr-4", pushKey: "AAEC" };
    expect(encodeControlMessage(handlePushRegister(message, s))).toBe(golden[4]);
    expect(s.store.list()).toEqual([]);
  });

  it("不正な deviceId・device token・https 以外の relay.url は failed（保存しない）", () => {
    const s = stores();
    for (const message of [
      { ...register(0), deviceId: "../../etc/passwd" },
      { ...register(0), deviceToken: "ZZ" },
      { ...register(0), relay: { url: "http://relay.example", capability: "c", expiresAt: 1 } },
    ]) {
      const result = handlePushRegister(message, s);
      expect(result.status).toBe("failed");
      expect(result.transport).toBe("none");
      expect(result.error).toBeDefined();
      expect(result.error).not.toContain(message.pushKey);
    }
    expect(s.store.list()).toEqual([]);
  });

  it("401 の印が付いた capability のまま再登録 → capabilityInvalid: true（golden pr-3）。取り直せば消える", () => {
    const s = stores();
    handlePushRegister(register(0), s);
    s.store.markCapabilityInvalid(DEVICE_ID, "v1.c2VhbGVkLWNhcGFiaWxpdHk");
    const again = handlePushRegister({ ...register(0), id: "pr-3" }, s);
    expect(encodeControlMessage(again)).toBe(golden[3]);
    // 同じ capability の再登録では印を消さない（アプリが取り直すまで出し続ける）。
    expect(s.store.get(DEVICE_ID)?.relay?.invalid).toBe(true);
    const renewed = handlePushRegister({ ...register(0), relay: { url: "https://relay.example", capability: "new-cap", expiresAt: 2_000_000_000 } }, s);
    expect(renewed).toMatchObject({ status: "ok", transport: "relay" });
    expect(renewed.capabilityInvalid).toBeUndefined();
    expect(s.store.get(DEVICE_ID)?.relay?.invalid).toBeUndefined();
  });
});

describe("hub 内部メッセージ（push）", () => {
  it("client_presence / presence_pong / push_request を decode する（不正は捨てる）", () => {
    expect(decodeHubClientLine(encodeHubMessage({ type: "client_presence", deviceId: DEVICE_ID, state: "background" })))
      .toEqual({ type: "client_presence", deviceId: DEVICE_ID, state: "background" });
    expect(decodeHubClientLine(JSON.stringify({ type: "client_presence", deviceId: DEVICE_ID, state: "away" }))).toBeNull();
    expect(decodeHubClientLine(encodeHubMessage({ type: "presence_pong", id: "p1" }))).toEqual({ type: "presence_pong", id: "p1" });
    const event = { kind: "approval" as const, session: "cs-1", id: "a1", body: "Bash · ls", tool: "Bash" };
    expect(decodeHubClientLine(encodeHubMessage({ type: "push_request", id: "r1", event }))).toEqual({ type: "push_request", id: "r1", event });
    expect(decodeHubClientLine(JSON.stringify({ type: "push_request", id: "r1", event: { kind: "spam", session: "s" } }))).toBeNull();
    expect(decodeHubClientLine(JSON.stringify({ type: "push_request", id: "r1", event: { kind: "question", session: "" } }))).toBeNull();
    const long = decodeHubClientLine(JSON.stringify({ type: "push_request", id: "r", event: { kind: "question", session: "s", body: "x".repeat(10_000) } }));
    expect(long?.type === "push_request" && long.event.body?.length).toBe(2_000);
  });

  it("presence_ping / push_request_result を decode する", () => {
    expect(decodeHubServerLine(encodeHubMessage({ type: "presence_ping", id: "p1" }))).toEqual({ type: "presence_ping", id: "p1" });
    expect(decodeHubServerLine(encodeHubMessage({ type: "push_request_result", id: "r1", status: "accepted" })))
      .toEqual({ type: "push_request_result", id: "r1", status: "accepted" });
    expect(decodeHubServerLine(JSON.stringify({ type: "push_request_result", id: "r1", status: "maybe" }))).toBeNull();
  });
});

describe("pushDoctorCheck", () => {
  it("端末なし・経路ごとの台数・最後の送信結果を出し、秘密を出さない", () => {
    const empty = pushDoctorCheck({ store: { list: () => [] }, apnsConfigStore: { load: () => null }, lastResult: { load: () => null } });
    expect(empty).toMatchObject({ id: "push", ok: false, required: false });
    expect(empty.detail).toContain("登録端末なし");

    const base = makeTempDir("push-doctor");
    const last = new PushLastResultStore(base);
    last.save({ at: 1_800_000_000, kind: "turn_done", status: "failed", reason: "relay-502", transport: "relay" });
    const check = pushDoctorCheck({
      store: { list: () => [sampleDevice(), sampleDevice({ deviceId: "11111111-2222-3333-4444-555555555555", relay: undefined })] },
      apnsConfigStore: { load: () => null },
      lastResult: last,
      nowSeconds: 1_800_000_000,
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("端末 2 台");
    expect(check.detail).toContain("relay 1");
    expect(check.detail).toContain("経路なし 1");
    expect(check.detail).toContain("turn_done failed(relay-502)");
    expect(check.detail).not.toContain("cap-1");
    expect(check.detail).not.toContain(sampleDevice().deviceToken);
  });
});
