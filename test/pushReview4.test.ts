// pushReview4.test.ts — 4 周目のレビュー指摘（二重の書き手でも登録を失わない・送る直前の最新の記録との照合・
// hook の書き込みの期限・接尾辞付きの版・版の記録の修復）

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type * as net from "node:net";
import * as path from "node:path";
import { PushDeviceStore, resolvePushPrefs } from "../src/push/pushDeviceStore.js";
import { PushDispatcher, type PushPresenceConnection } from "../src/push/pushDispatcher.js";
import { decodePushKey, openPushTp } from "../src/push/pushEnvelope.js";
import { RelayTransport, type JsonPostResult } from "../src/push/pushTransport.js";
import { requestHubPush } from "../src/approval/hook.js";
import { claudeHookLaunchSettings } from "../src/commands/hookSettings.js";
import { ClaudeVersionRecorder, findTrailingClaudeVersion, readObservedClaudeVersion } from "../src/shared/claudeVersionRecord.js";
import { makeTempDir } from "./helpers.js";
import { DEVICE_ID, MemoryDeviceStore, PUSH_KEY, RecordingTransport, sampleDevice } from "./pushTestHelpers.js";

const key = decodePushKey(PUSH_KEY)!;

describe("R1: 書き手が 2 つ居ても（hub の二重起動）登録を失わない", () => {
  it("片方で再登録した後、もう片方が古い版で削除・印付けを試みても登録が残る", () => {
    const base = makeTempDir("push-two-writers");
    const legacy = makeTempDir("push-legacy");
    const oldHub = new PushDeviceStore({ base, legacyApnsBase: legacy });
    const newHub = new PushDeviceStore({ base, legacyApnsBase: legacy });
    const first = oldHub.save(sampleDevice());
    expect(newHub.list()).toHaveLength(1);
    const renewed = newHub.save(sampleDevice({ deviceName: "再登録" }));
    // 古い hub のメモリは first のまま。古い版での 410 / 401 はディスクを読み直して見送る。
    expect(oldHub.deleteIfRevision(DEVICE_ID, first.revision)).toBe(false);
    expect(oldHub.markCapabilityInvalid(DEVICE_ID, "cap-1", first.revision)).toBe(false);
    const onDisk = new PushDeviceStore({ base, legacyApnsBase: legacy }).get(DEVICE_ID);
    expect(onDisk?.revision).toBe(renewed.revision);
    expect(onDisk?.relay?.invalid).toBeUndefined();
    // 古い hub のメモリもディスクの内容に更新される。
    expect(oldHub.get(DEVICE_ID)?.deviceName).toBe("再登録");
    // 最新の版なら従来どおり消せる。
    expect(oldHub.deleteIfRevision(DEVICE_ID, renewed.revision)).toBe(true);
    expect(new PushDeviceStore({ base, legacyApnsBase: legacy }).list()).toEqual([]);
  });

  it("起動後に手で消されたファイルは、送る直前の読み直しでメモリからも消える", () => {
    const base = makeTempDir("push-manual-delete");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    store.save(sampleDevice());
    fs.rmSync(path.join(base, "devices", `${DEVICE_ID}.json`));
    expect(store.refresh(DEVICE_ID)).toBeNull();
    expect(store.list()).toEqual([]);
  });
});

/** 在席確認の ping を手で解決できる接続（端末の前面申告）。 */
function heldConnection(): PushPresenceConnection & { release: (alive: boolean) => void; pinged: Promise<void> } {
  let release!: (alive: boolean) => void;
  let markPinged!: () => void;
  const pinged = new Promise<void>((resolve) => { markPinged = resolve; });
  const key = Symbol("conn");
  return {
    key, deviceId: DEVICE_ID, state: "foreground", viewing: false,
    ping: () => new Promise<boolean>((resolve) => { release = resolve; markPinged(); }),
    release: (alive) => release(alive),
    pinged,
  };
}

describe("R2: 登録解除・設定変更の後に古い宛先・古い本文で送らない", () => {
  const changes = {
    unregister: (store: MemoryDeviceStore) => { store.devices = []; },
    kindOff: (store: MemoryDeviceStore) => { store.devices = [sampleDevice({ prefs: resolvePushPrefs({ question: false }) })]; },
    bodyOff: (store: MemoryDeviceStore) => { store.devices = [sampleDevice({ prefs: resolvePushPrefs({ showBody: false }) })]; },
  } as const;

  for (const [name, change] of Object.entries(changes)) {
    it(`在席確認の待ちの間に ${name} → 送らない（本文 OFF は定型文で組み立て直す）`, async () => {
      const store = new MemoryDeviceStore([sampleDevice()]);
      const transport = new RecordingTransport("relay");
      const connection = heldConnection();
      const dispatcher = new PushDispatcher({
        store, loadApnsConfig: () => null, createTransport: () => transport,
        presence: { connections: () => [connection] },
      });
      const pending = dispatcher.notify({ kind: "question", session: "s", body: "秘密の質問文" });
      await connection.pinged;
      change(store);
      connection.release(false);
      const outcome = await pending;
      if (name === "bodyOff") {
        expect(outcome.status).toBe("sent");
        const plaintext = JSON.parse(openPushTp(key, transport.requests[0]!.tp)!) as Record<string, unknown>;
        expect(plaintext["body"]).toBe("回答を待っています");
      } else {
        expect(outcome.status).toBe("skipped");
        expect(transport.requests).toHaveLength(0);
      }
    });

    it(`503 の後の再試行の前に ${name} → 再試行で送らない`, async () => {
      const store = new MemoryDeviceStore([sampleDevice()]);
      const bodies: string[] = [];
      const dispatcher = new PushDispatcher({
        store, loadApnsConfig: () => null,
        createTransport: (_choice, device) => new RelayTransport(device.relay!.url, device.relay!.capability, {
          post: async (_url, body): Promise<JsonPostResult> => { bodies.push(body); return { ok: true, status: 503, body: "" }; },
        }, { sleep: async () => { change(store); } }),
      });
      const outcome = await dispatcher.notify({ kind: "question", session: "s", body: "秘密の質問文" });
      expect(bodies).toHaveLength(1);
      expect(outcome.devices[0]).toMatchObject({ status: "skipped", reason: "stale" });
    });
  }
});

describe("R3: hook の push_request の書き込みにも期限を付ける", () => {
  it("接続後に書き込みの完了通知が返らなくても期限で打ち切り、delivered として後始末する（自前送信へは切り替えない）", async () => {
    const socket = new EventEmitter() as EventEmitter & { write: () => boolean; destroy: () => void; end: () => void; destroyed: boolean };
    socket.destroyed = false;
    socket.write = () => true; // 完了通知を返さない
    socket.destroy = () => { socket.destroyed = true; };
    socket.end = () => {};
    const started = Date.now();
    const result = requestHubPush({ kind: "approval", session: "s" }, "/unused", 50, () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    });
    expect(await result).toBe("delivered");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(socket.destroyed).toBe(true);
  });
});

describe("R4 / 版の記録の修復", () => {
  it("接尾辞付きの版（2.1.319-beta）も観測・保存し、数値 3 要素で比べて StopFailure を登録する", () => {
    const dir = makeTempDir("claude-version-suffix");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", version: "2.1.319-beta" }) + "\n");
    expect(findTrailingClaudeVersion(transcript)).toBe("2.1.319-beta");
    const file = path.join(dir, "record.json");
    new ClaudeVersionRecorder(file).observe("2.1.319-beta");
    expect(readObservedClaudeVersion(file)).toBe("2.1.319-beta");
    const hooks = (version: string) => Object.keys((JSON.parse(claudeHookLaunchSettings({
      dir, binaryPath: "/bin/tailii", session: "s", globalMarkerPath: path.join(dir, "none"), claudeVersion: version,
    })!) as { hooks: Record<string, unknown> }).hooks);
    expect(hooks("2.1.319-beta")).toContain("StopFailure");
    expect(hooks("2.1.318-beta")).not.toContain("StopFailure");
  });

  it("起動後に記録が壊れても、同じ版を観測したときに書き直す", () => {
    const file = path.join(makeTempDir("claude-version-repair"), "record.json");
    const recorder = new ClaudeVersionRecorder(file);
    recorder.observe("2.1.322");
    fs.writeFileSync(file, "{broken");
    expect(readObservedClaudeVersion(file)).toBeNull();
    recorder.observe("2.1.322");
    expect(readObservedClaudeVersion(file)).toBe("2.1.322");
  });
});

describe("5 周目: 端末記録の照合・hook の接続後の結果不明", () => {
  it("F3: 503 の後の待ちの間に同じ内容の再登録（revision だけ変わる）があっても、再試行で送る", async () => {
    const base = makeTempDir("push-same-reregister");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    store.save(sampleDevice());
    const statuses = [503, 200];
    let attempts = 0;
    const dispatcher = new PushDispatcher({
      store, loadApnsConfig: () => null,
      createTransport: (_choice, device) => new RelayTransport(device.relay!.url, device.relay!.capability, {
        post: async (): Promise<JsonPostResult> => { attempts += 1; return { ok: true, status: statuses.shift()!, body: "" }; },
      }, { sleep: async () => { store.save(sampleDevice()); } }),
    });
    const outcome = await dispatcher.notify({ kind: "question", session: "s" });
    expect(attempts).toBe(2);
    expect(outcome.status).toBe("sent");
  });

  it("F4: 一時的に読めない（EACCES）端末は、その試行だけ見送り、記録を残して次の機会に送る", async () => {
    const base = makeTempDir("push-unreadable");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    store.save(sampleDevice());
    const file = path.join(base, "devices", `${DEVICE_ID}.json`);
    const transport = new RecordingTransport("relay");
    const dispatcher = new PushDispatcher({ store, loadApnsConfig: () => null, createTransport: () => transport });
    fs.chmodSync(file, 0o000);
    try {
      const outcome = await dispatcher.notify({ kind: "question", session: "s" });
      expect(outcome.devices[0]).toMatchObject({ status: "skipped", reason: "device-unreadable" });
      expect(store.list()).toHaveLength(1);
      expect(store.refreshState(DEVICE_ID)).toEqual({ state: "unreadable" });
    } finally {
      fs.chmodSync(file, 0o600);
    }
    expect((await dispatcher.notify({ kind: "turn_error", session: "s" })).status).toBe("sent");
    // ファイルが無い（absent）はメモリからも消す。
    fs.rmSync(file);
    expect(store.refreshState(DEVICE_ID)).toEqual({ state: "absent" });
    expect(store.list()).toEqual([]);
  });

  it("F5: 接続した後の書き込みのエラー・socket の error でも delivered（自前送信へ切り替えない）", async () => {
    for (const failure of ["write-error", "socket-error"] as const) {
      const socket = new EventEmitter() as EventEmitter & { write: (line: string, cb: (error?: Error) => void) => boolean; destroy: () => void; end: () => void };
      socket.write = (_line, cb) => {
        if (failure === "write-error") queueMicrotask(() => cb(new Error("EPIPE")));
        else queueMicrotask(() => socket.emit("error", new Error("ECONNRESET")));
        return true;
      };
      socket.destroy = () => {};
      socket.end = () => {};
      const result = await requestHubPush({ kind: "approval", session: "s" }, "/unused", 1_000, () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as net.Socket;
      });
      expect(result).toBe("delivered");
    }
  });
});

describe("6 周目: 初回の読み込み失敗・再試行の前の経路の有効性", () => {
  it("R3: 初回の一覧で読めなかった端末は、読めるようになった後の一覧に出る（空のまま固まらない）", async () => {
    const base = makeTempDir("push-initial-unreadable");
    new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") }).save(sampleDevice());
    const file = path.join(base, "devices", `${DEVICE_ID}.json`);
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    fs.chmodSync(file, 0o000);
    try {
      expect(store.list()).toEqual([]);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    expect(store.list().map((device) => device.deviceId)).toEqual([DEVICE_ID]);
  });

  it("R3: 初回にディレクトリが読めなくても、読めるようになったら一覧に出る", () => {
    const base = makeTempDir("push-initial-dir-unreadable");
    new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") }).save(sampleDevice());
    const dir = path.join(base, "devices");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    fs.chmodSync(dir, 0o000);
    try {
      expect(store.list()).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(store.list()).toHaveLength(1);
  });

  it("R5: 503 の後の待ちの間に capability の期限が過ぎた（経路が無くなった）ら再試行しない", async () => {
    const store = new MemoryDeviceStore([sampleDevice()]);
    let attempts = 0;
    const dispatcher = new PushDispatcher({
      store, loadApnsConfig: () => null, nowMs: () => 1_800_000_000_000,
      createTransport: (_choice, device) => new RelayTransport(device.relay!.url, device.relay!.capability, {
        post: async (): Promise<JsonPostResult> => { attempts += 1; return { ok: true, status: 503, body: "" }; },
      }, { sleep: async () => {
        store.devices = [sampleDevice({ relay: { url: "https://relay.example", capability: "cap-1", expiresAt: 1 } })];
      } }),
    });
    const outcome = await dispatcher.notify({ kind: "question", session: "s" });
    expect(attempts).toBe(1);
    expect(outcome.devices[0]).toMatchObject({ status: "skipped", reason: "stale" });
  });
});
