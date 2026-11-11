// pushRaceFixes.test.ts — プロセスをまたぐ二重送信・送信中の再登録・リレーの受付範囲・一覧キャッシュ・Codex 題名（push v1）

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PUSH_KINDS } from "../src/push/pushEnvelope.js";
import { PushDispatcher } from "../src/push/pushDispatcher.js";
import { PushDeviceStore } from "../src/push/pushDeviceStore.js";
import { PushSendLog } from "../src/push/pushStateFiles.js";
import type { PushSendResult } from "../src/push/pushTransport.js";
import { findCodexThreadTitle } from "../src/push/pushContent.js";
import { makeTempDir } from "./helpers.js";
import { DEVICE_ID, RecordingTransport, sampleDevice } from "./pushTestHelpers.js";

/** 同じ保存先を使う dispatcher（別プロセスの hub と hook の代わり）。 */
function dispatcherOn(pushBase: string, store: PushDeviceStore, result: (transport: RecordingTransport) => Promise<PushSendResult>) {
  const transports: RecordingTransport[] = [];
  const dispatcher = new PushDispatcher({
    store,
    loadApnsConfig: () => null,
    createTransport: (choice) => {
      const transport: RecordingTransport = new RecordingTransport(choice, () => result(transport));
      transports.push(transport);
      return transport;
    },
    sendLog: new PushSendLog(pushBase),
  });
  return { dispatcher, transports };
}

describe("間引き: 送れなかったときは記録を付けない", () => {
  it("送れなかったら記録を付けず、次の機会に送れる", async () => {
    const pushBase = makeTempDir("push-race-release");
    const legacy = makeTempDir("push-race-legacy");
    const store = new PushDeviceStore({ base: pushBase, legacyApnsBase: legacy });
    store.save(sampleDevice());
    let fail = true;
    const h = dispatcherOn(pushBase, store, async () => (fail ? { status: "failed", detail: "relay-502" } : { status: "ok", detail: "relay-200" }));
    expect((await h.dispatcher.notify({ kind: "question", session: "s" })).status).toBe("failed");
    fail = false;
    expect((await h.dispatcher.notify({ kind: "question", session: "s" })).status).toBe("sent");
    // 送れた記録は残る（間引き）。
    expect((await h.dispatcher.notify({ kind: "question", session: "s" })).reason).toBe("rate-limited");
  });
});

describe("修正 5: 送信中に再登録された端末を古い 401 / 410 で上書き・削除しない", () => {
  for (const [status, detail] of [["invalid_capability", "relay-401"], ["unregistered", "relay-410"]] as const) {
    it(`${detail}: 送信中に再登録されたら印も削除もしない`, async () => {
      const pushBase = makeTempDir("push-race-rereg");
      const store = new PushDeviceStore({ base: pushBase, legacyApnsBase: makeTempDir("push-race-legacy") });
      store.save(sampleDevice());
      const h = dispatcherOn(pushBase, store, async () => {
        // 送信中に hub が同じ capability のまま再登録を受けた（版が変わる）。
        store.save(sampleDevice({ deviceName: "再登録" }));
        return { status, detail };
      });
      await h.dispatcher.notify({ kind: "question", session: "s" });
      const current = store.get(DEVICE_ID);
      expect(current?.deviceName).toBe("再登録");
      expect(current?.relay?.invalid).toBeUndefined();
    });
  }

  it("再登録が無ければ従来どおり印を付ける・消す", async () => {
    const pushBase = makeTempDir("push-race-same");
    const store = new PushDeviceStore({ base: pushBase, legacyApnsBase: makeTempDir("push-race-legacy") });
    store.save(sampleDevice());
    await dispatcherOn(pushBase, store, async () => ({ status: "invalid_capability", detail: "relay-401" })).dispatcher.notify({ kind: "question", session: "s" });
    expect(store.get(DEVICE_ID)?.relay?.invalid).toBe(true);
    store.save(sampleDevice({ relay: { url: "https://relay.example", capability: "cap-2", expiresAt: 2_000_000_000 } }));
    await dispatcherOn(pushBase, store, async () => ({ status: "unregistered", detail: "relay-410" })).dispatcher.notify({ kind: "turn_error", session: "s" });
    expect(store.get(DEVICE_ID)).toBeNull();
  });

  it("upsert は直前の記録を見て版を振り直す", () => {
    const store = new PushDeviceStore({ base: makeTempDir("push-upsert"), legacyApnsBase: makeTempDir("push-race-legacy") });
    const first = store.upsert(DEVICE_ID, (previous) => { expect(previous).toBeNull(); return sampleDevice(); })!;
    const second = store.upsert(DEVICE_ID, (previous) => { expect(previous?.revision).toBe(first.revision); return sampleDevice(); })!;
    expect(second.revision).not.toBe(first.revision);
    expect(store.deleteIfRevision(DEVICE_ID, first.revision)).toBe(false);
    expect(store.deleteIfRevision(DEVICE_ID, second.revision)).toBe(true);
  });
});

describe("修正 8: リレーの受付範囲に必ず収まる", () => {
  it("全種別で expiration は現在より後・30 日以内、collapseId は印字可能 ASCII 64 バイト以内、interruptionLevel は 3 値", async () => {
    const nowMs = 1_800_000_000_123;
    const transport = new RecordingTransport("relay");
    const dispatcher = new PushDispatcher({
      store: { list: () => [sampleDevice()], deleteIfRevision: () => false, markCapabilityInvalid: () => false },
      loadApnsConfig: () => null,
      createTransport: () => transport,
      nowMs: () => nowMs,
    });
    const longSession = `cs-${"会話".repeat(200)}`;
    for (const kind of PUSH_KINDS) {
      await dispatcher.notify({ kind, session: longSession, id: `${kind}-${"x".repeat(300)}` });
    }
    expect(transport.requests).toHaveLength(PUSH_KINDS.length);
    const nowSeconds = Math.floor(nowMs / 1000);
    for (const request of transport.requests) {
      expect(request.expiration).toBeGreaterThan(nowSeconds);
      expect(request.expiration).toBeLessThanOrEqual(nowSeconds + 30 * 24 * 60 * 60);
      expect(Number.isInteger(request.expiration)).toBe(true);
      expect(request.collapseId).toMatch(/^[\x21-\x7e]{1,64}$/u);
      expect(["active", "time-sensitive", "passive"]).toContain(request.interruptionLevel);
    }
  });
});

describe("Codex 題名の読み方", () => {
  it("session_index.jsonl を末尾から読み、その thread の最新の行の名前を返す", () => {
    const dir = makeTempDir("push-codex-index");
    const index = path.join(dir, "session_index.jsonl");
    const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ id: `t-${i}`, thread_name: `会話 ${i}`, updated_at: "2026-11-01T00:00:00Z" }));
    fs.writeFileSync(index, [
      JSON.stringify({ id: "target", thread_name: "古い名前" }),
      ...filler,
      JSON.stringify({ id: "target", thread_name: "新しい名前" }),
      ...filler.slice(0, 500),
      JSON.stringify({ id: "unnamed", thread_name: "名前あり" }),
      JSON.stringify({ id: "unnamed" }),
    ].join("\n") + "\n");
    expect(findCodexThreadTitle(index, "target")).toBe("新しい名前");
    expect(findCodexThreadTitle(index, "unnamed")).toBeNull();
    expect(findCodexThreadTitle(index, "t-10")).toBe("会話 10");
    expect(findCodexThreadTitle(index, "missing")).toBeNull();
    // 読む上限より前にしか無い thread は探さない（定型の題名に落ちる）。
    expect(findCodexThreadTitle(index, "t-10", 1024)).toBeNull();
    expect(findCodexThreadTitle(path.join(dir, "none.jsonl"), "target")).toBeNull();
  });
});
