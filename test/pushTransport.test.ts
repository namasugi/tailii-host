// pushTransport.test.ts — relay / direct 経路と経路の選び方（push v1。実通信しない）

import { describe, expect, it } from "vitest";
import type { ApnsRequest, ApnsSendResult, ApnsSending } from "../src/push/apnsSender.js";
import type { APNsJWTProviding } from "../src/push/apnsJwtProvider.js";
import {
  apnsPayloadBody,
  choosePushTransport,
  DirectTransport,
  type JsonPostResult,
  type JsonPoster,
  mapRelayResponse,
  RelayTransport,
  relayPushUrl,
  type PushSendRequest,
} from "../src/push/pushTransport.js";
import { sampleDevice } from "./pushTestHelpers.js";

const request: PushSendRequest = {
  tp: { v: 1, k: "Yw3NKWbEM2Y", n: "QEFCQ0RFRkdISUpL", c: "abc" },
  interruptionLevel: "time-sensitive",
  collapseId: "c".repeat(32),
  expiration: 1_800_000_000,
};

class ScriptedPoster implements JsonPoster {
  readonly calls: { url: string; body: string; timeoutMs: number }[] = [];
  constructor(private readonly results: JsonPostResult[]) {}
  async post(url: string, body: string, timeoutMs: number): Promise<JsonPostResult> {
    this.calls.push({ url, body, timeoutMs });
    return this.results.shift() ?? { ok: false, error: "network" };
  }
}

function relay(poster: JsonPoster, sleeps: number[]): RelayTransport {
  return new RelayTransport("https://relay.example/base", "secret-cap", poster, {
    timeoutMs: 1234,
    sleep: async (ms) => { sleeps.push(ms); },
  });
}

describe("RelayTransport", () => {
  it("POST /v1/push に契約 §4 の形で送る（200 → ok）", async () => {
    const poster = new ScriptedPoster([{ ok: true, status: 200, body: '{"ok":true}' }]);
    const sleeps: number[] = [];
    const result = await relay(poster, sleeps).send(request);
    expect(result).toEqual({ status: "ok", detail: "relay-200" });
    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]!.url).toBe("https://relay.example/base/v1/push");
    expect(poster.calls[0]!.timeoutMs).toBe(1234);
    expect(JSON.parse(poster.calls[0]!.body)).toEqual({
      capability: "secret-cap",
      tp: request.tp,
      interruptionLevel: "time-sensitive",
      collapseId: request.collapseId,
      expiration: 1_800_000_000,
    });
    expect(sleeps).toEqual([]);
  });

  it("5xx とタイムアウトは 1 秒後に 1 回だけ再試行する", async () => {
    const sleeps: number[] = [];
    const five = new ScriptedPoster([{ ok: true, status: 503, body: "" }, { ok: true, status: 200, body: "" }]);
    expect((await relay(five, sleeps).send(request)).status).toBe("ok");
    expect(five.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    // 契約 §4: リレー内部の障害は 503 unavailable（5xx として 1 回だけ再試行し、それでも駄目なら失敗）。
    const unavailable = new ScriptedPoster([
      { ok: true, status: 503, body: '{"error":"unavailable"}' },
      { ok: true, status: 503, body: '{"error":"unavailable"}' },
      { ok: true, status: 200, body: "" },
    ]);
    expect(await relay(unavailable, []).send(request)).toEqual({ status: "failed", detail: "relay-503" });
    expect(unavailable.calls).toHaveLength(2);

    const timeouts = new ScriptedPoster([{ ok: false, error: "timeout" }, { ok: false, error: "timeout" }, { ok: true, status: 200, body: "" }]);
    expect(await relay(timeouts, []).send(request)).toEqual({ status: "failed", detail: "relay-timeout" });
    expect(timeouts.calls).toHaveLength(2);

    const apns = new ScriptedPoster([
      { ok: true, status: 502, body: "" },
      { ok: true, status: 502, body: '{"error":"apns_error","status":500,"reason":"InternalServerError"}' },
    ]);
    expect(await relay(apns, []).send(request)).toEqual({ status: "failed", detail: "relay-502-apns-500" });
  });

  it("4xx と接続失敗は再試行しない", async () => {
    for (const [result, expected] of [
      [{ ok: true, status: 401, body: '{"error":"invalid_capability"}' }, "invalid_capability"],
      [{ ok: true, status: 410, body: "" }, "unregistered"],
      [{ ok: true, status: 429, body: "" }, "rate_limited"],
      [{ ok: true, status: 413, body: "" }, "payload_too_large"],
      [{ ok: true, status: 400, body: "" }, "bad_request"],
      [{ ok: false, error: "network" }, "failed"],
    ] as const) {
      const poster = new ScriptedPoster([result, { ok: true, status: 200, body: "" }]);
      expect((await relay(poster, []).send(request)).status).toBe(expected);
      expect(poster.calls).toHaveLength(1);
    }
  });

  it("結果の detail に capability を含めない", async () => {
    for (const status of [200, 400, 401, 410, 413, 429, 500, 502]) {
      const detail = mapRelayResponse({ ok: true, status, body: "secret-cap" }).detail;
      expect(detail).not.toContain("secret-cap");
    }
  });

  it("https 以外のリレー URL には送らない", async () => {
    expect(relayPushUrl("http://relay.example")).toBeNull();
    expect(relayPushUrl("ftp://x")).toBeNull();
    expect(relayPushUrl("https://relay.example")).toBe("https://relay.example/v1/push");
    expect(relayPushUrl("https://relay.example/")).toBe("https://relay.example/v1/push");
    const poster = new ScriptedPoster([]);
    const result = await new RelayTransport("http://relay.example", "cap", poster).send(request);
    expect(result.status).toBe("bad_request");
    expect(poster.calls).toHaveLength(0);
  });
});

class FakeSender implements ApnsSending {
  readonly requests: ApnsRequest[] = [];
  constructor(private readonly results: ApnsSendResult[]) {}
  async send(req: ApnsRequest): Promise<ApnsSendResult> {
    this.requests.push(req);
    return this.results.shift() ?? { ok: true };
  }
}

class FakeJwt implements APNsJWTProviding {
  tokens = ["jwt-1", "jwt-2"];
  invalidations = 0;
  currentToken(): string { return this.tokens[0]!; }
  invalidate(): void { this.invalidations += 1; this.tokens.shift(); }
}

describe("DirectTransport", () => {
  it("契約 §3 の payload（固定の表示文言 + tp）と絶対時刻の apns-expiration で送る", async () => {
    const sender = new FakeSender([{ ok: true }]);
    const device = sampleDevice({ environment: "sandbox" });
    const result = await new DirectTransport(sender, new FakeJwt(), "com.namasugi.tailii", device).send(request);
    expect(result.status).toBe("ok");
    const sent = sender.requests[0]!;
    expect(sent.host).toBe("sandbox");
    expect(sent.deviceToken).toBe(device.deviceToken);
    expect(sent.topic).toBe("com.namasugi.tailii");
    expect(sent.expiration).toBe(1_800_000_000);
    expect(sent.collapseId).toBe(request.collapseId);
    expect(JSON.parse(sent.body.toString("utf8"))).toEqual({
      aps: {
        alert: { title: "Tailii", body: "新しい通知があります" },
        "mutable-content": 1,
        sound: "default",
        "interruption-level": "time-sensitive",
      },
      tp: request.tp,
    });
    expect(apnsPayloadBody(request.tp, "active").toString()).toContain('"interruption-level":"active"');
  });

  it("JWT 失効は作り直して 1 回だけ再試行・宛先未登録は unregistered", async () => {
    const jwt = new FakeJwt();
    const sender = new FakeSender([{ ok: false, error: { kind: "expiredProviderToken" } }, { ok: true }]);
    expect((await new DirectTransport(sender, jwt, "t", sampleDevice()).send(request)).status).toBe("ok");
    expect(jwt.invalidations).toBe(1);
    expect(sender.requests.map((req) => req.bearerJWT)).toEqual(["jwt-1", "jwt-2"]);

    const gone = new FakeSender([{ ok: false, error: { kind: "unregistered" } }]);
    expect((await new DirectTransport(gone, new FakeJwt(), "t", sampleDevice()).send(request)).status).toBe("unregistered");
  });

  it("JWT が作れなければ送らずに failed", async () => {
    const sender = new FakeSender([]);
    const jwt: APNsJWTProviding = { currentToken: () => { throw new Error("config-missing"); }, invalidate: () => {} };
    expect(await new DirectTransport(sender, jwt, "t", sampleDevice()).send(request)).toEqual({ status: "failed", detail: "jwt-unavailable" });
    expect(sender.requests).toHaveLength(0);
  });
});

describe("choosePushTransport", () => {
  const config = { teamId: "T", keyId: "K", keyPath: "/k.p8", topic: "com.namasugi.tailii" };
  it("config があり topic が bundle id と一致 → direct、それ以外で有効な capability → relay、どちらも無ければ none", () => {
    expect(choosePushTransport(sampleDevice(), config)).toBe("direct");
    expect(choosePushTransport(sampleDevice({ bundleId: "other" }), config)).toBe("relay");
    expect(choosePushTransport(sampleDevice(), null)).toBe("relay");
    expect(choosePushTransport(sampleDevice({ relay: undefined }), null)).toBe("none");
    const invalid = sampleDevice({ relay: { url: "https://r", capability: "c", expiresAt: 10, invalid: true } });
    expect(choosePushTransport(invalid, null)).toBe("none");
    const expired = sampleDevice({ relay: { url: "https://r", capability: "c", expiresAt: 10 } });
    expect(choosePushTransport(expired, null, 11)).toBe("none");
    expect(choosePushTransport(expired, null, 9)).toBe("relay");
  });
});
