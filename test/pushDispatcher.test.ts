// pushDispatcher.test.ts — 送るかどうかの判断（設定・間引き・在席・3 秒待ち）と送信結果の扱い（push v1）

import { describe, expect, it } from "vitest";
import {
  type PushDispatchObserver,
  PushDispatcher,
  type PushDispatcherOptions,
  type PushPresenceConnection,
  pushCollapseId,
} from "../src/push/pushDispatcher.js";
import { decodePushKey, openPushTp, type PushKind } from "../src/push/pushEnvelope.js";
import { resolvePushPrefs, type PushDeviceRecord } from "../src/push/pushDeviceStore.js";
import type { PushSendResult } from "../src/push/pushTransport.js";
import { DEVICE_ID, MemoryDeviceStore, PUSH_KEY, RecordingTransport, SECOND_DEVICE_ID, sampleDevice } from "./pushTestHelpers.js";

const key = decodePushKey(PUSH_KEY)!;

/** 手動で進める時計とタイマー。 */
class ManualClock {
  nowMs = 1_800_000_000_000;
  private timers: { at: number; callback: () => void; handle: number }[] = [];
  private nextHandle = 1;
  setTimer = (callback: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.timers.push({ at: this.nowMs + ms, callback, handle });
    return handle;
  };
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.handle !== handle);
  };
  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((timer) => timer.at <= this.nowMs);
    this.timers = this.timers.filter((timer) => timer.at > this.nowMs);
    for (const timer of due) timer.callback();
  }
  get pending(): number { return this.timers.length; }
}

class SpyObserver implements PushDispatchObserver {
  readonly events: { type: string; kind: PushKind; id: string; detail: string }[] = [];
  recordSent(kind: PushKind, id: string, tool: string): void { this.events.push({ type: "sent", kind, id, detail: tool }); }
  recordSkipped(kind: PushKind, id: string, reason: string): void { this.events.push({ type: "skipped", kind, id, detail: reason }); }
  recordFailed(kind: PushKind, id: string, reason: string): void { this.events.push({ type: "failed", kind, id, detail: reason }); }
}

function memorySendLog() {
  const map = new Map<string, number>();
  return {
    map,
    lastSent: (kind: PushKind, session: string) => map.get(`${kind}:${session}`) ?? null,
    record: (kind: PushKind, session: string, at: number) => { map.set(`${kind}:${session}`, Math.max(map.get(`${kind}:${session}`) ?? 0, at)); },
  };
}

function setup(devices: PushDeviceRecord[], options: {
  result?: PushSendResult | ((...args: never[]) => Promise<PushSendResult>);
  connections?: PushPresenceConnection[];
  title?: string | null;
  config?: PushDispatcherOptions["loadApnsConfig"];
} = {}) {
  const clock = new ManualClock();
  const store = new MemoryDeviceStore(devices);
  const transports: RecordingTransport[] = [];
  const observer = new SpyObserver();
  const sendLog = memorySendLog();
  const lastResults: unknown[] = [];
  const dispatcher = new PushDispatcher({
    store,
    loadApnsConfig: options.config ?? (() => null),
    createTransport: (choice) => {
      const transport = new RecordingTransport(choice, options.result as PushSendResult | undefined);
      transports.push(transport);
      return transport;
    },
    sendLog,
    lastResult: { save: (result) => { lastResults.push(result); } },
    observer,
    titleFor: () => (options.title === undefined ? "通知の設計" : options.title),
    presence: { connections: () => options.connections ?? [] },
    nowMs: () => clock.nowMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const opened = () => transports.flatMap((transport) =>
    transport.requests.map((request) => JSON.parse(openPushTp(key, request.tp)!) as Record<string, unknown>));
  return { clock, store, transports, observer, sendLog, lastResults, dispatcher, opened };
}

function connection(overrides: Partial<PushPresenceConnection> & { alive?: boolean }): PushPresenceConnection & { pings: number } {
  const conn = {
    key: Symbol("connection"),
    deviceId: DEVICE_ID,
    state: "foreground" as const,
    viewing: false,
    pings: 0,
    ...overrides,
    ping: async () => { conn.pings += 1; return overrides.alive ?? true; },
  };
  return conn;
}

describe("PushDispatcher: 設定と間引き", () => {
  it("端末が無ければ no-device、種別を切った端末だけなら prefs-off", async () => {
    expect((await setup([]).dispatcher.notify({ kind: "question", session: "s" })).reason).toBe("no-device");
    const off = setup([sampleDevice({ prefs: resolvePushPrefs({ question: false }) })]);
    expect((await off.dispatcher.notify({ kind: "question", session: "s" })).reason).toBe("prefs-off");
    expect(off.transports).toHaveLength(0);
    // 端末なし・設定オフは doctor の「最後の送信結果」を上書きしない。
    expect(off.lastResults).toEqual([]);
  });

  it("同じ種別・同じ会話は 30 秒間引く（別の種別・別の会話は送る）", async () => {
    const h = setup([sampleDevice()]);
    expect((await h.dispatcher.notify({ kind: "question", session: "s", id: "q1" })).status).toBe("sent");
    expect((await h.dispatcher.notify({ kind: "question", session: "s", id: "q2" })).reason).toBe("rate-limited");
    expect((await h.dispatcher.notify({ kind: "turn_error", session: "s" })).status).toBe("sent");
    expect((await h.dispatcher.notify({ kind: "question", session: "other" })).status).toBe("sent");
    h.clock.advance(30_000);
    expect((await h.dispatcher.notify({ kind: "question", session: "s", id: "q3" })).status).toBe("sent");
  });

  it("並走した同じ通知は二重に送らない", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = setup([sampleDevice()], { result: (async () => { await gate; return { status: "ok", detail: "relay-200" }; }) as never });
    const first = h.dispatcher.notify({ kind: "approval", session: "s", id: "a1" });
    // 先行の処理中に来た同じ種別・会話は保留し、先行が終わってから評価し直す（ここでは送れた直後なので間引き）。
    const second = h.dispatcher.notify({ kind: "approval", session: "s", id: "a2" });
    release!();
    expect((await first).status).toBe("sent");
    expect((await second).reason).toBe("rate-limited");
    expect(h.transports).toHaveLength(1);
  });
});

describe("PushDispatcher: 在席判定（設計 §6）", () => {
  it("前面の接続が無ければ push（背景と申告済み・別端末の前面は無関係）", async () => {
    const background = connection({ state: "background" });
    const otherDevice = connection({ deviceId: SECOND_DEVICE_ID, viewing: true });
    const h = setup([sampleDevice()], { connections: [background, otherDevice] });
    expect((await h.dispatcher.notify({ kind: "question", session: "s" })).status).toBe("sent");
    expect(background.pings + otherDevice.pings).toBe(0);
  });

  it("前面で会話を表示中 → client-viewing、別の画面 → client-foreground（どちらも送らない）", async () => {
    const viewing = setup([sampleDevice()], { connections: [connection({ viewing: true })] });
    expect(await viewing.dispatcher.notify({ kind: "turn_error", session: "s" })).toMatchObject({ status: "skipped", reason: "client-viewing" });
    const elsewhere = setup([sampleDevice()], { connections: [connection({ viewing: false })] });
    expect(await elsewhere.dispatcher.notify({ kind: "turn_error", session: "s" })).toMatchObject({ status: "skipped", reason: "client-foreground" });
    expect(viewing.transports.length + elsewhere.transports.length).toBe(0);
  });

  it("前面と申告した接続が ping に応えなければ不在とみなして push", async () => {
    const stale = connection({ viewing: true, alive: false });
    const h = setup([sampleDevice()], { connections: [stale] });
    expect((await h.dispatcher.notify({ kind: "question", session: "s" })).status).toBe("sent");
    expect(stale.pings).toBe(1);
  });

  it("端末ごとに判断する（表示中の端末には送らず、別の端末には送る）", async () => {
    const h = setup([sampleDevice(), sampleDevice({ deviceId: SECOND_DEVICE_ID })], {
      connections: [connection({ viewing: true })],
    });
    const outcome = await h.dispatcher.notify({ kind: "question", session: "s" });
    expect(outcome.status).toBe("sent");
    expect(outcome.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: DEVICE_ID, status: "skipped", reason: "client-viewing" }),
      expect.objectContaining({ deviceId: SECOND_DEVICE_ID, status: "sent" }),
    ]));
  });
});

describe("PushDispatcher: 中身と送信要求", () => {
  it("題名 = 会話タイトル・本文 = 要約・id・ts を暗号化し、種別ごとの割り込み・期限・collapse-id で送る", async () => {
    const h = setup([sampleDevice()]);
    await h.dispatcher.notify({ kind: "approval", session: "cs-1", id: "ap-1", body: "Bash · ls -la", tool: "Bash" });
    const sent = h.transports[0]!.requests[0]!;
    expect(sent.interruptionLevel).toBe("time-sensitive");
    expect(sent.expiration).toBe(1_800_000_000 + 600);
    expect(sent.collapseId).toBe(pushCollapseId("approval", "cs-1", "ap-1"));
    expect(sent.collapseId).toMatch(/^[0-9a-f]{32}$/u);
    expect(h.opened()[0]).toEqual({
      v: 1, kind: "approval", session: "cs-1", title: "通知の設計", body: "Bash · ls -la", id: "ap-1", ts: 1_800_000_000,
    });
    expect(h.observer.events).toEqual([{ type: "sent", kind: "approval", id: "ap-1", detail: "Bash" }]);

    const done = setup([sampleDevice()]);
    await done.dispatcher.notify({ kind: "turn_done", session: "cs-1", body: "終わりました" });
    expect(done.transports[0]!.requests[0]!.interruptionLevel).toBe("active");
    expect(done.transports[0]!.requests[0]!.expiration).toBe(1_800_000_000 + 3600);
    expect(done.transports[0]!.requests[0]!.collapseId).toBe(pushCollapseId("turn_done", "cs-1"));
    expect(done.opened()[0]).not.toHaveProperty("id");
  });

  it("collapse-id は会話 + 種別の SHA-256 先頭（承認だけは approvalId 単位）", () => {
    expect(pushCollapseId("question", "s-1")).not.toBe(pushCollapseId("question", "s-2"));
    expect(pushCollapseId("question", "s-1")).not.toBe(pushCollapseId("turn_done", "s-1"));
    expect(pushCollapseId("approval", "s-1", "a")).not.toBe(pushCollapseId("approval", "s-1", "b"));
  });

  it("showBody: false の端末には定型文だけ・タイトルが取れなければ種別の定型文", async () => {
    const h = setup([sampleDevice({ prefs: resolvePushPrefs({ showBody: false }) })], { title: null });
    let evaluated = false;
    await h.dispatcher.notify({ kind: "turn_done", session: "s", body: () => { evaluated = true; return "秘密の本文"; } });
    expect(h.opened()[0]).toMatchObject({ title: "作業が終わりました", body: "作業が完了しました" });
    // 本文を出す端末が無ければ要約を作らない（transcript を読まない）。
    expect(evaluated).toBe(false);
  });

  it("経路が無い端末は送らない（capability 無効・期限切れ・未設定）", async () => {
    const invalid = sampleDevice({ relay: { url: "https://r", capability: "c", expiresAt: 2_000_000_000, invalid: true } });
    expect((await setup([invalid]).dispatcher.notify({ kind: "question", session: "s" })).reason).toBe("capability-invalid");
    const expired = sampleDevice({ relay: { url: "https://r", capability: "c", expiresAt: 1 } });
    expect((await setup([expired]).dispatcher.notify({ kind: "question", session: "s" })).reason).toBe("capability-expired");
    expect((await setup([sampleDevice({ relay: undefined })]).dispatcher.notify({ kind: "question", session: "s" })).reason).toBe("no-transport");
  });

  it("direct の設定があり topic が一致すれば direct で送る", async () => {
    const h = setup([sampleDevice()], { config: () => ({ teamId: "T", keyId: "K", keyPath: "/k", topic: "com.namasugi.tailii" }) });
    await h.dispatcher.notify({ kind: "question", session: "s" });
    expect(h.transports[0]!.kind).toBe("direct");
  });
});

describe("PushDispatcher: 送信結果の扱い", () => {
  it("410 → 端末の記録を消す", async () => {
    const h = setup([sampleDevice()], { result: { status: "unregistered", detail: "relay-410" } });
    const outcome = await h.dispatcher.notify({ kind: "question", session: "s" });
    expect(outcome).toMatchObject({ status: "failed", reason: "relay-410" });
    expect(h.store.deleted).toEqual([DEVICE_ID]);
    expect(h.sendLog.map.size).toBe(0);
  });

  it("401 → capability に無効の印", async () => {
    const h = setup([sampleDevice()], { result: { status: "invalid_capability", detail: "relay-401" } });
    await h.dispatcher.notify({ kind: "question", session: "s" });
    expect(h.store.invalidated).toEqual([{ deviceId: DEVICE_ID, capability: "cap-1" }]);
    expect(h.observer.events[0]).toMatchObject({ type: "failed", kind: "question", detail: "relay-401" });
    expect(h.lastResults[0]).toMatchObject({ kind: "question", status: "failed", reason: "relay-401", transport: "relay" });
  });

  it("送信器が投げても結果に畳む（呼び手を阻害しない）", async () => {
    const h = setup([sampleDevice()], { result: (async () => { throw new Error("boom"); }) as never });
    expect(await h.dispatcher.notify({ kind: "question", session: "s" })).toMatchObject({ status: "failed", reason: "transport-exception" });
  });
});

describe("PushDispatcher: turn_done の 3 秒待ち", () => {
  it("3 秒後に送る・その間の取り消しで送らない・isStillDone が false なら送らない", async () => {
    const h = setup([sampleDevice()]);
    let done = true;
    h.dispatcher.scheduleTurnDone("s", { isStillDone: () => done, body: () => "最後の応答" });
    h.clock.advance(2_999);
    expect(h.transports).toHaveLength(0);
    h.clock.advance(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.opened()[0]).toMatchObject({ kind: "turn_done", body: "最後の応答" });

    h.clock.advance(60_000);
    h.dispatcher.scheduleTurnDone("s", { isStillDone: () => done });
    h.dispatcher.cancelTurnDone("s");
    expect(h.dispatcher.hasPendingTurnDone("s")).toBe(false);
    h.clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transports).toHaveLength(1);

    done = false;
    h.dispatcher.scheduleTurnDone("s", { isStillDone: () => done });
    h.clock.advance(3_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.transports).toHaveLength(1);
  });

  it("同じ会話の予約は置き換える・完了通知を受ける端末が無ければ予約しない", () => {
    const h = setup([sampleDevice()]);
    h.dispatcher.scheduleTurnDone("s", { isStillDone: () => true });
    h.dispatcher.scheduleTurnDone("s", { isStillDone: () => true });
    expect(h.clock.pending).toBe(1);
    const off = setup([sampleDevice({ prefs: resolvePushPrefs({ turnDone: false }) })]);
    off.dispatcher.scheduleTurnDone("s", { isStillDone: () => true });
    expect(off.clock.pending).toBe(0);
  });
});
