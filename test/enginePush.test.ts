// enginePush.test.ts — engine の push v1 の配線（hello の能力・端末登録・在席の中継・生存確認の往復）
//
// 端末の保存先は実行ごとの空 HOME（vitest.config.ts）配下の `~/.tailii/push`。後片付けで消す。

import { afterEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeControlMessage } from "../src/protocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { PushDispatcher } from "../src/push/pushDispatcher.js";
import { PushDeviceStore } from "../src/push/pushDeviceStore.js";
import { ApnsConfigStore } from "../src/push/apnsConfigStore.js";
import type { HubLink } from "../src/hub/hubClient.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok, startEngine } from "./helpers.js";
import { DEVICE_ID, MemoryDeviceStore, RecordingTransport, sampleDevice } from "./pushTestHelpers.js";

const golden = readFileSync(path.join(fileURLToPath(import.meta.url), "..", "..", "protocol", "push-v1.ndjson"), "utf8")
  .split("\n").filter((line) => line.length > 0);

/** 直前の行まで engine が処理し終えたことを、応答のある要求を 1 往復させて確かめる。 */
async function drain(engine: ReturnType<typeof startEngine>, id: string): Promise<void> {
  engine.writeLine(JSON.stringify({ type: "backend_get_request", v: 1, id }));
  await engine.lines.nextOfType("backend_get_response");
}

function makeManager(): TmuxSessionManager {
  return new TmuxSessionManager({ runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner });
}

afterEach(() => {
  fs.rmSync(path.join(os.homedir(), ".tailii", "push"), { recursive: true, force: true });
});

describe("EngineControl — push v1", () => {
  test("channel_hello に push: 1・push_register は hub が保存して結果を返す・push_unregister で消す", async () => {
    const pushBase = makeTempDir("engine-push-store");
    const devices = new PushDeviceStore({ base: pushBase, legacyApnsBase: makeTempDir("engine-push-legacy") });
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("engine-push-reg-hub"), metadataStore: makeTempStore(),
      timeoutSeconds: 1800, pushDevices: devices, pushApnsConfigStore: new ApnsConfigStore(makeTempDir("engine-push-apns")),
    });
    const engine = startEngine({ sessionManager: makeManager(), hub });
    try {
      const hello = decodeControlMessage(await engine.lines.nextOfType("channel_hello"));
      expect(hello).toMatchObject({ type: "channel_hello", push: 1 });

      engine.writeLine(golden[0]!);
      const result = decodeControlMessage(await engine.lines.nextOfType("push_register_result"));
      expect(result).toMatchObject({ id: "pr-1", status: "ok", transport: "relay" });
      expect(devices.get(DEVICE_ID)?.deviceName).toBe("iPhone");
      // hub のメモリだけでなくファイルにも保存されている（hook の自前送信・doctor が読む）。
      expect(new PushDeviceStore({ base: pushBase }).get(DEVICE_ID)?.deviceName).toBe("iPhone");

      engine.writeLine(golden[5]!);
      expect(decodeControlMessage(await engine.lines.nextOfType("push_unregister_result")))
        .toMatchObject({ id: "pu-1", status: "ok" });
      expect(devices.list()).toEqual([]);
    } finally {
      await engine.teardown();
    }
  });

  test("hub に届かない・hub が端末記録を持たないときは failed（engine は自分で書かない）", async () => {
    const unreachable: HubLink = { onMessage: null, onReconnect: null, send: () => false, close: () => {} };
    for (const options of [{ hubLink: unreachable }, {}]) {
      const engine = startEngine({ sessionManager: makeManager(), ...options });
      try {
        await engine.lines.nextOfType("channel_hello");
        engine.writeLine(golden[0]!);
        expect(decodeControlMessage(await engine.lines.nextOfType("push_register_result")))
          .toMatchObject({ id: "pr-1", status: "failed", transport: "none" });
        engine.writeLine(golden[5]!);
        expect(decodeControlMessage(await engine.lines.nextOfType("push_unregister_result")))
          .toMatchObject({ id: "pu-1", status: "failed" });
        expect(fs.existsSync(path.join(os.homedir(), ".tailii", "push", "devices"))).toBe(false);
      } finally {
        await engine.teardown();
      }
    }
  });

  test("client_presence を hub へ中継し、hub の presence_ping を iOS へ渡して pong を返す", async () => {
    const store = new MemoryDeviceStore([sampleDevice()]);
    const transport = new RecordingTransport("relay");
    const dispatcher = new PushDispatcher({
      store, loadApnsConfig: () => null, createTransport: () => transport, pingTimeoutMs: 2_000,
    });
    const hub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("engine-push-hub"), metadataStore: makeTempStore(),
      timeoutSeconds: 1800, pushDispatcher: dispatcher,
    });
    const engine = startEngine({ sessionManager: makeManager(), hub });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine(golden[7]!); // client_presence foreground
      await drain(engine, "d1");
      // 別の会話の通知 → 前面の接続へ生存確認が届く。iOS 役として pong を返す。
      const outcome = dispatcher.notify({ kind: "question", session: "cs-other" });
      const ping = decodeControlMessage(await engine.lines.nextOfType("presence_ping"));
      if (ping.type !== "presence_ping") throw new Error("unreachable");
      engine.writeLine(JSON.stringify({ type: "presence_pong", v: 1, id: ping.id }));
      expect(await outcome).toMatchObject({ status: "skipped", reason: "client-foreground" });

      engine.writeLine(golden[8]!); // client_presence background
      await drain(engine, "d2");
      expect((await dispatcher.notify({ kind: "turn_error", session: "cs-other" })).status).toBe("sent");
      expect(transport.requests).toHaveLength(1);
    } finally {
      await engine.teardown();
    }
  });
});
