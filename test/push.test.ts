// push.test.ts — APNs push スタックの単体テスト
// Swift 版 ApnsConfigStoreTests / DeviceTokenStoreTests / PushPayloadTests / APNsJWTProviderTests /
// APNsSenderTests / ApprovalPushNotifierTests / PushTokenCommandTests / KickTests の要点を移植する。
//
// 実 ~/.tailii/apns には触れず一時 dir を注入。ネットワーク・時刻は全て注入式（実物を叩かない）。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApnsConfigStore } from "../src/apnsConfigStore.js";
import { APNsJWTProvider } from "../src/apnsJwtProvider.js";
import {
  APNsSender,
  type ApnsRequest,
  type ApnsSendResult,
  type HttpPostResult,
  type HTTPPosting,
} from "../src/apnsSender.js";
import {
  ApprovalPushNotifier,
  type ApprovalPushRequest,
  makeProductionPushNotifier,
  type PushObserving,
} from "../src/approvalPushNotifier.js";
import { DeviceTokenStore, type DeviceTokenRecord, type DeviceTokenStoring } from "../src/deviceTokenStore.js";
import { kickCore } from "../src/kick.js";
import { pushTokenCore } from "../src/pushTokenCommand.js";
import type { APNsJWTProviding } from "../src/apnsJwtProvider.js";
import type { PushError } from "../src/pushTypes.js";
import { SendLog } from "../src/sendLog.js";

// MARK: - 共通ユーティリティ

function tempBase(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailii-${prefix}-`));
}

function writeConfig(base: string, topic = "com.example.Tailii"): void {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(
    path.join(base, "config.json"),
    JSON.stringify({ teamId: "TEAM1", keyId: "KEY1", keyPath: "/tmp/ignored.p8", topic }),
  );
}

function base64urlDecode(s: string): Buffer {
  let str = s.replaceAll("-", "+").replaceAll("_", "/");
  while (str.length % 4 !== 0) str += "=";
  return Buffer.from(str, "base64");
}

// MARK: - ApnsConfigStore

describe("ApnsConfigStore", () => {
  it("有効な config.json を読み込む", () => {
    const base = tempBase("config");
    writeConfig(base);
    const config = new ApnsConfigStore(base).load();
    expect(config).not.toBeNull();
    expect(config?.teamId).toBe("TEAM1");
    expect(config?.topic).toBe("com.example.Tailii");
  });

  it("ファイル欠落は null（未設定, 6.4）", () => {
    expect(new ApnsConfigStore(tempBase("config")).load()).toBeNull();
  });

  it("不正 JSON / フィールド欠落は null（6.4）", () => {
    const base = tempBase("config");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "config.json"), '{"teamId":"only"}');
    expect(new ApnsConfigStore(base).load()).toBeNull();
  });
});

// MARK: - DeviceTokenStore

describe("DeviceTokenStore", () => {
  const record: DeviceTokenRecord = {
    token: "abcdef0123456789",
    environment: "sandbox",
    bundleId: "com.example.Tailii",
    updatedAt: 1000,
  };

  it("save → load で往復する", () => {
    const store = new DeviceTokenStore(tempBase("token"));
    store.save(record);
    expect(store.load()).toEqual(record);
  });

  it("未保存は load が null（3.5）", () => {
    expect(new DeviceTokenStore(tempBase("token")).load()).toBeNull();
  });

  it("同一パスへ上書きできる（token 置換, 3.4）", () => {
    const store = new DeviceTokenStore(tempBase("token"));
    store.save({ ...record, token: "aa11" });
    store.save({ ...record, token: "bb22", environment: "production" });
    const loaded = store.load();
    expect(loaded?.token).toBe("bb22");
    expect(loaded?.environment).toBe("production");
  });

  it("delete で宛先を除外する（6.3、未保存でも冪等）", () => {
    const store = new DeviceTokenStore(tempBase("token"));
    store.save(record);
    store.delete();
    expect(store.load()).toBeNull();
    expect(() => store.delete()).not.toThrow();
  });

  it("保存ファイルは 0600 パーミッション", () => {
    const base = tempBase("token");
    const store = new DeviceTokenStore(base);
    store.save(record);
    const mode = fs.statSync(path.join(base, "device-token.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// MARK: - SendLog

describe("SendLog", () => {
  it("record → lastSent で往復し、跨インスタンスで共有される", () => {
    const base = tempBase("sendlog");
    new SendLog(base).record("sess-a", 5000);
    expect(new SendLog(base).lastSent("sess-a")).toBe(5000);
  });

  it("未記録セッションは null（抑制しない側）", () => {
    expect(new SendLog(tempBase("sendlog")).lastSent("nope")).toBeNull();
  });

  it("別セッションは独立して記録される", () => {
    const base = tempBase("sendlog");
    const log = new SendLog(base);
    log.record("a", 100);
    log.record("b", 200);
    expect(log.lastSent("a")).toBe(100);
    expect(log.lastSent("b")).toBe(200);
  });
});

// MARK: - APNsJWTProvider（ES256）

describe("APNsJWTProvider", () => {
  /** エフェメラル P256 鍵を PKCS#8 PEM (.p8) として temp に書き出し、公開鍵とパスを返す。 */
  function writeEphemeralP8(base: string): { keyPath: string; publicKey: crypto.KeyObject } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    fs.mkdirSync(base, { recursive: true });
    const keyPath = path.join(base, "AuthKey_TESTKEYID.p8");
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    return { keyPath, publicKey };
  }

  function makeConfigStore(base: string, keyPath: string): ApnsConfigStore {
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, "config.json"),
      JSON.stringify({
        teamId: "TEAM123456",
        keyId: "KEYID98765",
        keyPath,
        topic: "com.example.Tailii",
      }),
    );
    return new ApnsConfigStore(base);
  }

  it("header{alg,kid}/claims{iss,iat} を持ち、raw64 署名が公開鍵で検証できる", () => {
    const base = tempBase("jwt");
    const { keyPath, publicKey } = writeEphemeralP8(base);
    const config = makeConfigStore(base, keyPath);
    const provider = new APNsJWTProvider(config, { base, now: () => 1_700_000_000 });
    const jwt = provider.currentToken();

    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    const header = JSON.parse(base64urlDecode(parts[0]!).toString("utf8"));
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("KEYID98765");

    const claims = JSON.parse(base64urlDecode(parts[1]!).toString("utf8"));
    expect(claims.iss).toBe("TEAM123456");
    expect(claims.iat).toBe(1_700_000_000);

    expect(jwt.includes("=")).toBe(false);

    // 署名: raw 64 バイト r||s で header.payload を検証できる。
    const sig = base64urlDecode(parts[2]!);
    expect(sig.length).toBe(64);
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const valid = crypto.verify(
      "sha256",
      signingInput,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );
    expect(valid).toBe(true);
  });

  it("再利用窓内は同一 JWT を返す（6.1）", () => {
    const base = tempBase("jwt");
    const { keyPath } = writeEphemeralP8(base);
    const config = makeConfigStore(base, keyPath);
    let clock = 1_700_000_000;
    const provider = new APNsJWTProvider(config, { base, reuseWindow: 3000, now: () => clock });
    const first = provider.currentToken();
    clock += 2999;
    expect(provider.currentToken()).toBe(first);
  });

  it("再利用窓を超えると再署名する（iat 更新でトークン変化）", () => {
    const base = tempBase("jwt");
    const { keyPath } = writeEphemeralP8(base);
    const config = makeConfigStore(base, keyPath);
    let clock = 1_700_000_000;
    const provider = new APNsJWTProvider(config, { base, reuseWindow: 3000, now: () => clock });
    const first = provider.currentToken();
    clock += 3001;
    const second = provider.currentToken();
    expect(second).not.toBe(first);
    const claims = JSON.parse(base64urlDecode(second.split(".")[1]!).toString("utf8"));
    expect(claims.iat).toBe(1_700_003_001);
  });

  it("invalidate() でキャッシュ破棄 → 次回は再署名（6.2）", () => {
    const base = tempBase("jwt");
    const { keyPath } = writeEphemeralP8(base);
    const config = makeConfigStore(base, keyPath);
    const provider = new APNsJWTProvider(config, { base, reuseWindow: 3000, now: () => 1_700_000_000 });
    const first = provider.currentToken();
    expect(provider.currentToken()).toBe(first); // 対照: 窓内は同一
    provider.invalidate();
    expect(fs.existsSync(path.join(base, "jwt-cache.json"))).toBe(false);
    expect(provider.currentToken()).not.toBe(first);
  });

  it("jwt-cache.json に {jwt, issuedAt} が永続し、別インスタンスで再利用される", () => {
    const base = tempBase("jwt");
    const { keyPath } = writeEphemeralP8(base);
    const config = makeConfigStore(base, keyPath);
    const first = new APNsJWTProvider(config, { base, reuseWindow: 3000, now: () => 1_700_000_000 }).currentToken();
    const cache = JSON.parse(fs.readFileSync(path.join(base, "jwt-cache.json"), "utf8"));
    expect(cache.jwt).toBe(first);
    expect(cache.issuedAt).toBe(1_700_000_000);
    const reused = new APNsJWTProvider(config, { base, reuseWindow: 3000, now: () => 1_700_001_000 }).currentToken();
    expect(reused).toBe(first);
  });

  it("config が未設定なら currentToken は throw する（6.4）", () => {
    const base = tempBase("jwt");
    const provider = new APNsJWTProvider(new ApnsConfigStore(base), { base, now: () => 1_700_000_000 });
    expect(() => provider.currentToken()).toThrow();
  });
});

// MARK: - APNsSender（応答写像・ヘッダ・URL）

describe("APNsSender", () => {
  class MockPoster implements HTTPPosting {
    captured: { url: string; headers: Record<string, string>; body: Buffer } | null = null;
    constructor(private readonly result: HttpPostResult) {}
    async post(url: string, headers: Record<string, string>, body: Buffer): Promise<HttpPostResult> {
      this.captured = { url, headers, body };
      return this.result;
    }
  }

  function sampleRequest(overrides: Partial<ApnsRequest> = {}): ApnsRequest {
    return {
      host: "sandbox",
      deviceToken: "abcdef0123456789",
      bearerJWT: "header.payload.sig",
      topic: "com.example.Tailii",
      collapseId: "approval-uuid-123",
      expiration: 300,
      body: Buffer.from('{"aps":{}}', "utf8"),
      ...overrides,
    };
  }

  function reasonBody(reason: string): Buffer {
    return Buffer.from(JSON.stringify({ reason }), "utf8");
  }

  async function sendWith(result: HttpPostResult, req = sampleRequest()): Promise<ApnsSendResult> {
    return new APNsSender(new MockPoster(result)).send(req);
  }

  it("200 → ok", async () => {
    const r = await sendWith({ ok: true, status: 200, body: Buffer.alloc(0) });
    expect(r.ok).toBe(true);
  });

  it("403 ExpiredProviderToken → expiredProviderToken", async () => {
    const r = await sendWith({ ok: true, status: 403, body: reasonBody("ExpiredProviderToken") });
    expect(r).toEqual({ ok: false, error: { kind: "expiredProviderToken" } });
  });

  it("410 → unregistered", async () => {
    const r = await sendWith({ ok: true, status: 410, body: reasonBody("Unregistered") });
    expect(r).toEqual({ ok: false, error: { kind: "unregistered" } });
  });

  it("400 BadDeviceToken → unregistered", async () => {
    const r = await sendWith({ ok: true, status: 400, body: reasonBody("BadDeviceToken") });
    expect(r).toEqual({ ok: false, error: { kind: "unregistered" } });
  });

  it("429 → tooManyProviderTokenUpdates", async () => {
    const r = await sendWith({ ok: true, status: 429, body: reasonBody("TooManyProviderTokenUpdates") });
    expect(r).toEqual({ ok: false, error: { kind: "tooManyProviderTokenUpdates" } });
  });

  it("その他非200 → http(status, reason)", async () => {
    const r = await sendWith({ ok: true, status: 503, body: reasonBody("InternalServerError") });
    expect(r).toEqual({ ok: false, error: { kind: "http", status: 503, reason: "InternalServerError" } });
  });

  it("400 でも BadDeviceToken 以外の reason は http へ", async () => {
    const r = await sendWith({ ok: true, status: 400, body: reasonBody("BadTopic") });
    expect(r).toEqual({ ok: false, error: { kind: "http", status: 400, reason: "BadTopic" } });
  });

  it("転送失敗 → transport", async () => {
    const r = await sendWith({ ok: false, error: new Error("network down") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("transport");
  });

  it("必須ヘッダ / URL / body が正しい", async () => {
    const poster = new MockPoster({ ok: true, status: 200, body: Buffer.alloc(0) });
    await new APNsSender(poster).send(sampleRequest());
    const cap = poster.captured!;
    expect(cap.url).toBe("https://api.sandbox.push.apple.com/3/device/abcdef0123456789");
    expect(cap.headers["authorization"]).toBe("bearer header.payload.sig");
    expect(cap.headers["apns-topic"]).toBe("com.example.Tailii");
    expect(cap.headers["apns-collapse-id"]).toBe("approval-uuid-123");
    expect(cap.headers["apns-push-type"]).toBe("alert");
    expect(cap.headers["apns-priority"]).toBe("10");
    expect(cap.headers["apns-expiration"]).toBe("300");
  });

  it("production host は api.push.apple.com", async () => {
    const poster = new MockPoster({ ok: true, status: 200, body: Buffer.alloc(0) });
    await new APNsSender(poster).send(sampleRequest({ host: "production", deviceToken: "deadbeef" }));
    expect(poster.captured!.url).toBe("https://api.push.apple.com/3/device/deadbeef");
  });

  it("body は注入した Buffer がそのまま渡る", async () => {
    const poster = new MockPoster({ ok: true, status: 200, body: Buffer.alloc(0) });
    const body = Buffer.from('{"aps":{"alert":"x"}}', "utf8");
    await new APNsSender(poster).send(sampleRequest({ body }));
    expect(poster.captured!.body).toEqual(body);
  });
});

// MARK: - ApprovalPushNotifier（統括）

describe("ApprovalPushNotifier", () => {
  class MockTokenStore implements DeviceTokenStoring {
    deleteCount = 0;
    constructor(private record: DeviceTokenRecord | null) {}
    load(): DeviceTokenRecord | null {
      return this.record;
    }
    save(record: DeviceTokenRecord): void {
      this.record = record;
    }
    delete(): void {
      this.deleteCount += 1;
      this.record = null;
    }
  }

  class MockJWTProvider implements APNsJWTProviding {
    currentCount = 0;
    invalidateCount = 0;
    throwOnCurrent = false;
    constructor(private readonly tokens: string[] = ["jwt-1", "jwt-2"]) {}
    currentToken(): string {
      if (this.throwOnCurrent) throw new Error("config-missing");
      const idx = Math.min(this.currentCount, this.tokens.length - 1);
      this.currentCount += 1;
      return this.tokens[idx]!;
    }
    invalidate(): void {
      this.invalidateCount += 1;
    }
  }

  class MockSender {
    requests: ApnsRequest[] = [];
    constructor(private readonly results: ApnsSendResult[] = [{ ok: true }]) {}
    async send(req: ApnsRequest): Promise<ApnsSendResult> {
      this.requests.push(req);
      return this.results.shift() ?? { ok: true };
    }
    get sendCount(): number {
      return this.requests.length;
    }
  }

  interface SpyRecord {
    kind: "sent" | "skipped" | "failed";
    id: string;
    detail: string;
    session: string;
  }
  class SpyObserver implements PushObserving {
    records: SpyRecord[] = [];
    recordSent(id: string, tool: string, session: string): void {
      this.records.push({ kind: "sent", id, detail: tool, session });
    }
    recordSkipped(id: string, reason: string, session: string): void {
      this.records.push({ kind: "skipped", id, detail: reason, session });
    }
    recordFailed(id: string, reason: string, session: string): void {
      this.records.push({ kind: "failed", id, detail: reason, session });
    }
    get last(): SpyRecord | undefined {
      return this.records[this.records.length - 1];
    }
  }

  const SESSION = "proj-abc";
  const APPROVAL_ID = "approval-uuid-xyz";
  const TOOL = "Bash";

  function request(): ApprovalPushRequest {
    return { approvalId: APPROVAL_ID, tool: TOOL, session: SESSION };
  }

  function tokenRecord(): DeviceTokenRecord {
    return {
      token: "abcdef0123456789",
      environment: "sandbox",
      bundleId: "com.example.Tailii",
      updatedAt: 1000,
    };
  }

  interface Fixture {
    notifier: ApprovalPushNotifier;
    tokenStore: MockTokenStore;
    jwt: MockJWTProvider;
    sender: MockSender;
    observer: SpyObserver;
  }

  function makeNotifier(opts: {
    base: string;
    token?: DeviceTokenRecord | null;
    sendResults?: ApnsSendResult[];
    jwtTokens?: string[];
    writeConfigFile?: boolean;
    minInterval?: number;
    now?: number;
  }): Fixture {
    if (opts.writeConfigFile ?? true) writeConfig(opts.base);
    const tokenStore = new MockTokenStore(opts.token === undefined ? tokenRecord() : opts.token);
    const jwt = new MockJWTProvider(opts.jwtTokens ?? ["jwt-1", "jwt-2"]);
    const sender = new MockSender(opts.sendResults ?? [{ ok: true }]);
    const observer = new SpyObserver();
    const notifier = new ApprovalPushNotifier({
      configStore: new ApnsConfigStore(opts.base),
      tokenStore,
      jwtProvider: jwt,
      sender,
      observer,
      sendLogBase: opts.base,
      minInterval: opts.minInterval ?? 30,
      expiration: 300,
      now: () => opts.now ?? 5000,
    });
    return { notifier, tokenStore, jwt, sender, observer };
  }

  it("config 未設定 → skipped(no-config) ＋ pushSkipped 観測", async () => {
    const f = makeNotifier({ base: tempBase("notifier"), writeConfigFile: false });
    const outcome = await f.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "skipped", reason: "no-config" });
    expect(f.sender.sendCount).toBe(0);
    expect(f.jwt.currentCount).toBe(0);
    expect(f.observer.records).toHaveLength(1);
    expect(f.observer.last).toMatchObject({ kind: "skipped", id: APPROVAL_ID, detail: "no-config" });
  });

  it("device token 未保存 → skipped(no-token) ＋ pushSkipped 観測", async () => {
    const f = makeNotifier({ base: tempBase("notifier"), token: null });
    const outcome = await f.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "skipped", reason: "no-token" });
    expect(f.sender.sendCount).toBe(0);
    expect(f.jwt.currentCount).toBe(0);
    expect(f.observer.last).toMatchObject({ kind: "skipped", detail: "no-token" });
  });

  it("happy path → sent ＋ pushSent 観測", async () => {
    const f = makeNotifier({ base: tempBase("notifier") });
    const outcome = await f.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "sent" });
    expect(f.sender.sendCount).toBe(1);
    expect(f.jwt.currentCount).toBe(1);
    expect(f.observer.last).toMatchObject({ kind: "sent", detail: TOOL, session: SESSION });
  });

  it("payload は最小情報のみ（diff/cwd/secret を含まない）で collapse-id=approvalId", async () => {
    const f = makeNotifier({ base: tempBase("notifier") });
    await f.notifier.notify(request(), 5000);
    const sent = f.sender.requests[0]!;
    expect(sent.collapseId).toBe(APPROVAL_ID);
    expect(sent.topic).toBe("com.example.Tailii");
    expect(sent.host).toBe("sandbox");
    const body = sent.body.toString("utf8");
    expect(body).not.toContain("diff");
    expect(body).not.toContain("cwd");
    expect(body).not.toContain("/tmp/ignored.p8");
    expect(body).not.toContain("jwt");
    expect(body).toContain(APPROVAL_ID);
    expect(body).toContain(TOOL);
  });

  it("ExpiredProviderToken → invalidate ＋ 再署名 ＋ 1回だけ再試行 → sent", async () => {
    const f = makeNotifier({
      base: tempBase("notifier"),
      sendResults: [{ ok: false, error: { kind: "expiredProviderToken" } }, { ok: true }],
      jwtTokens: ["jwt-old", "jwt-new"],
    });
    const outcome = await f.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "sent" });
    expect(f.sender.sendCount).toBe(2);
    expect(f.jwt.invalidateCount).toBe(1);
    expect(f.jwt.currentCount).toBe(2);
    expect(f.sender.requests[0]!.bearerJWT).toBe("jwt-old");
    expect(f.sender.requests[1]!.bearerJWT).toBe("jwt-new");
    expect(f.observer.last?.kind).toBe("sent");
  });

  it("ExpiredProviderToken が再試行でも解消しない → failed（再試行は1回のみ）", async () => {
    const f = makeNotifier({
      base: tempBase("notifier"),
      sendResults: [
        { ok: false, error: { kind: "expiredProviderToken" } },
        { ok: false, error: { kind: "expiredProviderToken" } },
      ],
    });
    const outcome = await f.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "failed", reason: { kind: "expiredProviderToken" } });
    expect(f.sender.sendCount).toBe(2);
    expect(f.jwt.invalidateCount).toBe(1);
  });

  it("Unregistered → token 削除 ＋ failed ＋ pushFailed 観測", async () => {
    const f = makeNotifier({
      base: tempBase("notifier"),
      sendResults: [{ ok: false, error: { kind: "unregistered" } }],
    });
    const outcome = await f.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "failed", reason: { kind: "unregistered" } });
    expect(f.sender.sendCount).toBe(1);
    expect(f.tokenStore.deleteCount).toBe(1);
    expect(f.observer.last).toMatchObject({ kind: "failed", detail: "Unregistered" });
  });

  it("最小間隔内の同一セッション連続 → skipped(rate-limited) ＋ pushSkipped 観測", async () => {
    const base = tempBase("notifier");
    const first = makeNotifier({ base, minInterval: 30, now: 5000 });
    expect(await first.notifier.notify(request(), 5000)).toEqual({ kind: "sent" });

    const second = makeNotifier({ base, minInterval: 30, now: 5010 });
    const outcome = await second.notifier.notify(request(), 5000);
    expect(outcome).toEqual({ kind: "skipped", reason: "rate-limited" });
    expect(second.sender.sendCount).toBe(0);
    expect(second.jwt.currentCount).toBe(0);
    expect(second.observer.last).toMatchObject({ kind: "skipped", detail: "rate-limited" });
  });

  it("最小間隔を超えた同一セッションは再送できる（抑制解除）", async () => {
    const base = tempBase("notifier");
    expect(await makeNotifier({ base, minInterval: 30, now: 5000 }).notifier.notify(request(), 5000)).toEqual({
      kind: "sent",
    });
    const later = makeNotifier({ base, minInterval: 30, now: 5040 });
    expect(await later.notifier.notify(request(), 5000)).toEqual({ kind: "sent" });
    expect(later.sender.sendCount).toBe(1);
  });

  it("別セッションは同一時刻でも抑制されない", async () => {
    const base = tempBase("notifier");
    await makeNotifier({ base, minInterval: 30, now: 5000 }).notifier.notify(request(), 5000);
    const other = makeNotifier({ base, minInterval: 30, now: 5000 });
    const outcome = await other.notifier.notify(
      { approvalId: "other-id", tool: "Edit", session: "other-session" },
      5000,
    );
    expect(outcome).toEqual({ kind: "sent" });
    expect(other.sender.sendCount).toBe(1);
  });

  it("送信失敗では send-log を更新しない（次回は抑制されない）", async () => {
    const base = tempBase("notifier");
    const failed = makeNotifier({
      base,
      sendResults: [{ ok: false, error: { kind: "http", status: 500, reason: "x" } }],
      now: 5000,
    });
    expect(await failed.notifier.notify(request(), 5000)).toEqual({
      kind: "failed",
      reason: { kind: "http", status: 500, reason: "x" },
    });
    const next = makeNotifier({ base, sendResults: [{ ok: true }], now: 5005 });
    expect(await next.notifier.notify(request(), 5000)).toEqual({ kind: "sent" });
    expect(next.sender.sendCount).toBe(1);
  });

  it("timeLimit 超過でも PushOutcome を返す（gate 非阻害）", async () => {
    const base = tempBase("notifier");
    writeConfig(base);
    const slowSender = {
      async send(): Promise<ApnsSendResult> {
        // timeLimit(50ms) より十分長くブロックする。タイマは unref してテスト終了を妨げない。
        await new Promise((resolve) => setTimeout(resolve, 60_000).unref());
        return { ok: true };
      },
    };
    const notifier = new ApprovalPushNotifier({
      configStore: new ApnsConfigStore(base),
      tokenStore: new MockTokenStore(tokenRecord()),
      jwtProvider: new MockJWTProvider(),
      sender: slowSender,
      observer: new SpyObserver(),
      sendLogBase: base,
      now: () => 5000,
    });
    const outcome = await notifier.notify(request(), 50);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect((outcome.reason as PushError).kind).toBe("transport");
  });
});

// MARK: - makeProductionPushNotifier（本番配線ファクトリ）

describe("makeProductionPushNotifier", () => {
  it("config 未設定でも throw せず解決する（connect 不能ブランチの gate 非阻害）", async () => {
    // 既定パス（~/.tailii/apns）は本テスト環境で通常 config 欠落 → skipped で即解決。
    const notify = makeProductionPushNotifier();
    await expect(notify({ approvalId: randomUUID(), tool: "Bash", session: "smoke" }, 200)).resolves.toBeUndefined();
  });
});

// MARK: - pushTokenCore（push-token サブコマンド）

describe("pushTokenCore", () => {
  function validJSON(overrides: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        token: "abcdef0123456789",
        environment: "sandbox",
        bundleId: "com.example.Tailii",
        updatedAt: 1_700_000_000,
        ...overrides,
      }),
      "utf8",
    );
  }

  it("妥当な JSON を渡すと保存され exit 0（3.2/3.3）", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    expect(pushTokenCore(validJSON(), store, () => {})).toBe(0);
    const loaded = store.load();
    expect(loaded?.token).toBe("abcdef0123456789");
    expect(loaded?.environment).toBe("sandbox");
    expect(loaded?.updatedAt).toBe(1_700_000_000);
  });

  it("environment production/sandbox が正しく保存される", () => {
    for (const env of ["production", "sandbox"] as const) {
      const store = new DeviceTokenStore(tempBase("pushtoken"));
      expect(pushTokenCore(validJSON({ environment: env }), store, () => {})).toBe(0);
      expect(store.load()?.environment).toBe(env);
    }
  });

  it("壊れた JSON は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    expect(pushTokenCore(Buffer.from("{ broken", "utf8"), store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("空 stdin は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    expect(pushTokenCore(Buffer.alloc(0), store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("token 欠落は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    const json = Buffer.from(
      JSON.stringify({ environment: "sandbox", bundleId: "com.x", updatedAt: 1 }),
      "utf8",
    );
    expect(pushTokenCore(json, store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("bundleId 欠落は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    const json = Buffer.from(
      JSON.stringify({ token: "abcdef01", environment: "sandbox", updatedAt: 1 }),
      "utf8",
    );
    expect(pushTokenCore(json, store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("token が非 hex は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    expect(pushTokenCore(validJSON({ token: "zzzz not hex!!" }), store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("空 token は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    expect(pushTokenCore(validJSON({ token: "" }), store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("environment が enum 外は非0 で書き込まれない", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    expect(pushTokenCore(validJSON({ environment: "staging" }), store, () => {})).not.toBe(0);
    expect(store.load()).toBeNull();
  });

  it("既存 token を上書きできる（3.4）", () => {
    const store = new DeviceTokenStore(tempBase("pushtoken"));
    pushTokenCore(validJSON({ token: "aa11" }), store, () => {});
    expect(pushTokenCore(validJSON({ token: "bb22", environment: "production" }), store, () => {})).toBe(0);
    const loaded = store.load();
    expect(loaded?.token).toBe("bb22");
    expect(loaded?.environment).toBe("production");
  });
});

// MARK: - kickCore（test-only affordance）

describe("kickCore", () => {
  const TMUX = "/opt/homebrew/bin/tmux";
  const hasTmux = fs.existsSync(TMUX);

  it.runIf(hasTmux)("稼働セッションへ kick でプロンプトが注入される（send-keys 到達）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-kick-"));
    const file = path.join(dir, `${randomUUID()}.txt`);
    const session = `tailii-kick-${randomUUID().slice(0, 8)}`;
    const { spawnSync } = await import("node:child_process");
    spawnSync(TMUX, ["new", "-d", "-s", session, "sh", "-c", `cat >> '${file}'`], { stdio: "ignore" });
    try {
      const prompt = "create a file test.txt";
      let captured = "";
      const code = kickCore(session, prompt, TMUX, (m) => (captured += m));
      expect(code, `stderr=${captured}`).toBe(0);
      let landed = false;
      for (let i = 0; i < 50; i += 1) {
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(prompt)) {
          landed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(landed).toBe(true);
    } finally {
      spawnSync(TMUX, ["kill-session", "-t", session], { stdio: "ignore" });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasTmux)("非存在セッションへの kick は非0 + stderr", () => {
    const missing = `tailii-kick-missing-${randomUUID().slice(0, 8)}`;
    let captured = "";
    const code = kickCore(missing, "anything", TMUX, (m) => (captured += m));
    expect(code).not.toBe(0);
    expect(captured.length).toBeGreaterThan(0);
  });
});
