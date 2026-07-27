// pairingCode.test.ts — pairing-code v1 responder tests.

import * as crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  computeInitiatorConfirmMac,
  decodeBase64Field,
  decryptPayload,
  derivePairingKeys,
  deriveSASCode,
  encodePairingMessage,
  encryptPayload,
  hkdfSha256,
  pairingTranscriptSalt,
  parseClientPublicKeyLine,
  parsePairingMessage,
  rawX25519PublicKeyToKeyObject,
  runPairingResponder,
  x25519PublicKeyObjectToRaw,
  type PairingMessage,
  type PairingResponderDeps,
  type PairingResult,
  type PairingStream,
} from "../src/commands/pairingCode.js";

const PAYLOAD_JSON = '{\n  "host" : "192.168.1.2",\n  "key" : "PRIVATE",\n  "port" : 22,\n  "user" : "alice",\n  "v" : 1\n}';
const NOKEY_PAYLOAD_JSON = '{\n  "host" : "192.168.1.2",\n  "port" : 22,\n  "user" : "alice",\n  "v" : 4\n}';

/** SSH wire 形式の妥当な ed25519 公開鍵行を組み立てる（テスト用）。 */
function makeClientKeyLine(comment?: string, pubByte = 0x2a): string {
  const type = Buffer.from("ssh-ed25519", "utf8");
  const blob = Buffer.concat([u32(type.length), type, u32(32), Buffer.alloc(32, pubByte)]);
  return `ssh-ed25519 ${blob.toString("base64")}${comment !== undefined ? ` ${comment}` : ""}`;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

interface MemoryPeer {
  stream: PairingStream;
  inbound: PassThrough;
  outbound: PassThrough;
}

interface InitiatorResult {
  payloadJSON?: string;
  sasCode?: string;
  /** responder が server_key で ck:1 を返したか（enrollment 受理）。 */
  ckAcked?: boolean;
}

function createMemoryPair(): { responder: MemoryPeer; initiator: MemoryPeer; responderWire: Buffer[] } {
  const initiatorToResponder = new PassThrough();
  const responderToInitiator = new PassThrough();
  const responderWire: Buffer[] = [];
  responderToInitiator.on("data", (chunk: Buffer) => responderWire.push(Buffer.from(chunk)));
  return {
    responder: {
      stream: { readable: initiatorToResponder, writable: responderToInitiator },
      inbound: initiatorToResponder,
      outbound: responderToInitiator,
    },
    initiator: {
      stream: { readable: responderToInitiator, writable: initiatorToResponder },
      inbound: responderToInitiator,
      outbound: initiatorToResponder,
    },
    responderWire,
  };
}

function generateX25519(): crypto.KeyPairKeyObjectResult {
  return crypto.generateKeyPairSync("x25519");
}

function pubRaw(keypair: crypto.KeyPairKeyObjectResult): Buffer {
  return x25519PublicKeyObjectToRaw(keypair.publicKey);
}

function sha256(bytes: Buffer): Buffer {
  return crypto.createHash("sha256").update(bytes).digest();
}

function writeMessage(writable: NodeJS.WritableStream, message: PairingMessage): void {
  writable.write(encodePairingMessage(message) + "\n");
}

async function runInitiator(
  peer: MemoryPeer,
  options: {
    wireKeypair?: crypto.KeyPairKeyObjectResult;
    deriveKeypair?: crypto.KeyPairKeyObjectResult;
    badConfirmMac?: boolean;
    skipConfirm?: boolean;
    commitFrom?: Buffer;
    timeoutMs?: number;
    /** v1.1: hello に cpk:1 を付ける（enrollment 希望）。 */
    cpk?: boolean;
    /** v1.1: hello に psk:1 を付け、鍵導出に混合する PSK。 */
    psk?: Buffer;
    /** v1.1: ck 受理時に client_key で送る公開鍵行。 */
    clientKeyLine?: string;
    /** v1.1: client_key の平文を差し替える（不正入力テスト用。clientKeyLine より優先）。 */
    rawClientKeyPlaintext?: Buffer;
  } = {},
): Promise<InitiatorResult> {
  const reader = new TestLineReader(peer.stream.readable);
  const wireKeypair = options.wireKeypair ?? generateX25519();
  const deriveKeypair = options.deriveKeypair ?? wireKeypair;
  const wirePub = pubRaw(wireKeypair);
  const derivePub = pubRaw(deriveKeypair);
  const commit = options.commitFrom ?? sha256(wirePub);

  writeMessage(peer.stream.writable, {
    t: "hello",
    v: 1,
    commit: commit.toString("base64"),
    ...(options.cpk === true ? { cpk: 1 as const } : {}),
    ...(options.psk !== undefined ? { psk: 1 as const } : {}),
  });

  const serverKeyLine = await reader.readLine(options.timeoutMs);
  if (serverKeyLine === null) return {};
  const serverKey = parsePairingMessage(serverKeyLine);
  if (serverKey?.t !== "server_key") throw new Error("expected server_key");
  const responderPub = decodeBase64Field(serverKey.epk, 32);
  if (responderPub === null) throw new Error("invalid server key");
  const ckAcked = serverKey.ck === 1;

  writeMessage(peer.stream.writable, { t: "reveal", epk: wirePub.toString("base64") });

  const sharedSecret = crypto.diffieHellman({
    privateKey: deriveKeypair.privateKey,
    publicKey: rawX25519PublicKeyToKeyObject(responderPub),
  });
  const keys = derivePairingKeys(sharedSecret, sha256(derivePub), responderPub, derivePub, options.psk);
  if (options.skipConfirm) return { sasCode: keys.sasCode, ckAcked };

  const mac = options.badConfirmMac ? Buffer.alloc(32, 0xa5) : computeInitiatorConfirmMac(keys.confirmKey);
  writeMessage(peer.stream.writable, { t: "confirm", mac: mac.toString("base64") });

  const clientKeyPlaintext =
    options.rawClientKeyPlaintext ??
    (options.clientKeyLine !== undefined ? Buffer.from(options.clientKeyLine, "utf8") : undefined);
  if (ckAcked && clientKeyPlaintext !== undefined) {
    const sealed = encryptPayload(keys.clientKey, clientKeyPlaintext, (size) => Buffer.alloc(size, 3));
    writeMessage(peer.stream.writable, {
      t: "client_key",
      iv: sealed.iv.toString("base64"),
      ct: sealed.ciphertext.toString("base64"),
      tag: sealed.tag.toString("base64"),
    });
  }

  const payloadLine = await reader.readLine(options.timeoutMs);
  if (payloadLine === null) return { sasCode: keys.sasCode, ckAcked };
  const payload = parsePairingMessage(payloadLine);
  if (payload?.t !== "payload") return { sasCode: keys.sasCode, ckAcked };
  const iv = decodeBase64Field(payload.iv, 12);
  const tag = decodeBase64Field(payload.tag, 16);
  if (iv === null || tag === null) throw new Error("invalid payload fields");
  const plaintext = decryptPayload(keys.dataKey, iv, Buffer.from(payload.ct, "base64"), tag);
  return { sasCode: keys.sasCode, ckAcked, payloadJSON: plaintext.toString("utf8") };
}

class TestLineReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private lines: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;

  constructor(private readonly readable: NodeJS.ReadableStream) {
    readable.on("data", this.onData);
    readable.once("end", this.onEnd);
    readable.once("close", this.onEnd);
    readable.once("error", this.onEnd);
  }

  readLine(timeoutMs = 1000): Promise<string | null> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === onLine) this.waiter = null;
        resolve(null);
      }, timeoutMs);
      const onLine = (line: string | null): void => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiter = onLine;
    });
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    let idx: number;
    while ((idx = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, idx).toString("utf8");
      this.buffer = this.buffer.subarray(idx + 1);
      if (this.waiter !== null) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(line);
      } else {
        this.lines.push(line);
      }
    }
  };

  private readonly onEnd = (): void => {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(null);
    }
  };
}

async function runResponderHarness(options: {
  initiator: (peer: MemoryPeer) => Promise<InitiatorResult>;
  timeoutMs?: number;
  /** v1.1: responder deps の上書き（enrollment/psk の注入）。 */
  deps?: Partial<PairingResponderDeps>;
}): Promise<{ responderResult: PairingResult; initiatorResult: InitiatorResult; displayedSAS: string[]; wire: string }> {
  const pair = createMemoryPair();
  const displayedSAS: string[] = [];
  const responderDone = runPairingResponder(pair.responder.stream, {
    payloadJSON: PAYLOAD_JSON,
    displaySAS: (code) => displayedSAS.push(code),
    timeoutMs: options.timeoutMs ?? 1000,
    randomBytes: (size) => Buffer.alloc(size, 7),
    ...options.deps,
  });
  const initiatorResult = await options.initiator(pair.initiator);
  const responderResult = await responderDone;
  return {
    responderResult,
    initiatorResult,
    displayedSAS,
    wire: Buffer.concat(pair.responderWire).toString("utf8"),
  };
}

function expectNoPayloadOnWire(wire: string): void {
  expect(wire).not.toContain('"t":"payload"');
  expect(wire).not.toContain(PAYLOAD_JSON);
}

describe("pairing crypto helpers", () => {
  it("round-trips raw 32-byte X25519 public keys through SPKI KeyObject", () => {
    const keypair = generateX25519();
    const raw = pubRaw(keypair);
    expect(raw).toHaveLength(32);
    const roundTrip = x25519PublicKeyObjectToRaw(rawX25519PublicKeyToKeyObject(raw));
    expect(roundTrip.equals(raw)).toBe(true);
  });

  it("derives the 6-digit SAS from the HKDF output", () => {
    expect(deriveSASCode(Buffer.from([0x00, 0x0f, 0x42, 0x3f]))).toBe("999999");
    expect(deriveSASCode(Buffer.from([0x00, 0x0f, 0x42, 0x40]))).toBe("000000");
    expect(deriveSASCode(Buffer.from([0x00, 0x00, 0x00, 0x07]))).toBe("000007");
  });

  it("binds HKDF keys to the transcript salt and labels", () => {
    const z = Buffer.alloc(32, 1);
    const commit = Buffer.alloc(32, 2);
    const responderPub = Buffer.alloc(32, 3);
    const initiatorPub = Buffer.alloc(32, 4);
    const salt = pairingTranscriptSalt(commit, responderPub, initiatorPub);
    const keys = derivePairingKeys(z, commit, responderPub, initiatorPub);
    expect(keys.salt.equals(salt)).toBe(true);
    expect(keys.confirmKey.equals(hkdfSha256(z, salt, "pocketclaude-pair-v1 confirm", 32))).toBe(true);
    expect(keys.dataKey.equals(hkdfSha256(z, salt, "pocketclaude-pair-v1 data", 32))).toBe(true);
    expect(keys.confirmKey.equals(keys.dataKey)).toBe(false);
    expect(keys.sasCode).toMatch(/^\d{6}$/);
  });

  it("parses encoded messages and rejects invalid base64 lengths", () => {
    const encoded = encodePairingMessage({ t: "hello", v: 1, commit: Buffer.alloc(32, 1).toString("base64") });
    expect(parsePairingMessage(encoded)).toEqual({ t: "hello", v: 1, commit: Buffer.alloc(32, 1).toString("base64") });
    expect(parsePairingMessage('{"t":"hello","v":2,"commit":"x"}')).toBeNull();
    expect(decodeBase64Field(Buffer.alloc(31).toString("base64"), 32)).toBeNull();
    expect(decodeBase64Field("not base64", 32)).toBeNull();
  });
});

describe("runPairingResponder", () => {
  it("pairs and sends an AES-GCM payload when the SAS-derived confirm MAC is correct", async () => {
    const result = await runResponderHarness({ initiator: (peer) => runInitiator(peer) });
    expect(result.responderResult).toEqual({ status: "paired" });
    expect(result.initiatorResult.payloadJSON).toBe(PAYLOAD_JSON);
    expect(result.displayedSAS).toEqual([result.initiatorResult.sasCode]);
    expect(result.wire).toContain('"t":"payload"');
    expect(result.wire).not.toContain(PAYLOAD_JSON);
  });

  it("aborts on wrong code / bad confirm MAC and never sends payload", async () => {
    const result = await runResponderHarness({
      initiator: (peer) => runInitiator(peer, { badConfirmMac: true }),
    });
    expect(result.responderResult.status).toBe("aborted");
    expect(result.initiatorResult.payloadJSON).toBeUndefined();
    expectNoPayloadOnWire(result.wire);
  });

  it("aborts a MITM transcript where the revealed key is swapped and Z does not match", async () => {
    const initiatorKey = generateX25519();
    const mitmKey = generateX25519();
    const result = await runResponderHarness({
      initiator: (peer) => runInitiator(peer, { wireKeypair: mitmKey, deriveKeypair: initiatorKey }),
    });
    expect(result.responderResult.status).toBe("aborted");
    expect(result.initiatorResult.payloadJSON).toBeUndefined();
    expectNoPayloadOnWire(result.wire);
  });

  it("aborts on commitment mismatch", async () => {
    const result = await runResponderHarness({
      initiator: (peer) => runInitiator(peer, { commitFrom: Buffer.alloc(32, 9) }),
    });
    expect(result.responderResult).toEqual({ status: "aborted", reason: "commitment mismatch" });
    expectNoPayloadOnWire(result.wire);
  });

  it("aborts on step timeout without sending payload", async () => {
    const pair = createMemoryPair();
    const displayedSAS: string[] = [];
    const responderResult = await runPairingResponder(pair.responder.stream, {
      payloadJSON: PAYLOAD_JSON,
      displaySAS: (code) => displayedSAS.push(code),
      timeoutMs: 10,
    });
    expect(responderResult).toEqual({ status: "aborted", reason: "timeout" });
    expect(displayedSAS).toEqual([]);
    expectNoPayloadOnWire(Buffer.concat(pair.responderWire).toString("utf8"));
  });
});

// MARK: - v1.1 導出テストベクトル（spec pairing-code-v1.md と両実装で一致させる）

describe("v1.1 spec derivation vectors", () => {
  const Z = Buffer.alloc(32, 0x11);
  const PSK = Buffer.alloc(32, 0x22);
  const COMMIT = Buffer.alloc(32, 0x33);
  const EPK_R = Buffer.alloc(32, 0x44);
  const EPK_I = Buffer.alloc(32, 0x55);

  it("legacy（ikm=Z）が spec の値と一致する", () => {
    const keys = derivePairingKeys(Z, COMMIT, EPK_R, EPK_I);
    expect(keys.salt.toString("hex")).toBe("9b406c08deb9f44c7453882855aeb01b437e659c9a64943472f8f0de510c9230");
    expect(keys.sasCode).toBe("411019");
    expect(keys.confirmKey.toString("hex")).toBe("297e4dcd5fbd588bb08ca702814a7fa19c1133c46d280c50dbd27745c5f7faeb");
    expect(keys.dataKey.toString("hex")).toBe("d6e714003cf18591fcad92750c2f7455a3c57270417cc41b3a5401b48c450dd8");
    expect(keys.clientKey.toString("hex")).toBe("a3e9b7e0364f777b4a8b3edeb4b7ab3d80bad2883bcea3b6b369b6f3f4b6596a");
    expect(computeInitiatorConfirmMac(keys.confirmKey).toString("hex")).toBe(
      "fec134edfaf8fdf8ef980660a940444b8ebbc24c5fe1f458c58f6012fb4aebde",
    );
  });

  it("PSK モード（ikm=Z||psk）が spec の値と一致する", () => {
    const keys = derivePairingKeys(Z, COMMIT, EPK_R, EPK_I, PSK);
    expect(keys.sasCode).toBe("191386");
    expect(keys.confirmKey.toString("hex")).toBe("f5c8068a44a00c9724003efde0f0088b379018f25f76c2172408fd625722ae41");
    expect(keys.dataKey.toString("hex")).toBe("812f726503c54289604e04d1f8594fc266d60c6ad3a2e9493e760d6e83802428");
    expect(keys.clientKey.toString("hex")).toBe("44b4d6342363a2f3ed2b05c968bfda3699cb4e9e50bfc24c1867fd3485afd186");
    expect(computeInitiatorConfirmMac(keys.confirmKey).toString("hex")).toBe(
      "147a8792e5cdea6206d35827d2d586956fa2930067f242fb3fe8a14587590dc2",
    );
  });
});

// MARK: - v1.1 client-key enrollment / PSK モード

describe("runPairingResponder v1.1 (client-key enrollment + PSK)", () => {
  const CLIENT_LINE = makeClientKeyLine("tailii-ios");
  const PSK = Buffer.alloc(32, 0x22);

  function enrollmentDeps(registered: string[]): Partial<PairingResponderDeps> {
    return {
      payloadJSONNoKey: NOKEY_PAYLOAD_JSON,
      psk: PSK,
      registerClientKey: (line) => registered.push(line),
    };
  }

  it("cpk+ck 成立時は client_key を登録して key なし payload を送る（秘密鍵はワイヤに載らない）", async () => {
    const registered: string[] = [];
    const result = await runResponderHarness({
      deps: enrollmentDeps(registered),
      initiator: (peer) => runInitiator(peer, { cpk: true, clientKeyLine: CLIENT_LINE }),
    });
    expect(result.responderResult).toEqual({ status: "paired", clientKeyLine: CLIENT_LINE });
    expect(registered).toEqual([CLIENT_LINE]);
    expect(result.initiatorResult.ckAcked).toBe(true);
    expect(result.initiatorResult.payloadJSON).toBe(NOKEY_PAYLOAD_JSON);
    // 秘密鍵入り legacy payload はワイヤに現れない（AEAD 平文比較）。
    expect(result.wire).not.toContain("PRIVATE");
  });

  it("enrollment 成立時は legacy payload ビルダを一度も評価しない（ホスト側 keygen を起こさない）", async () => {
    const registered: string[] = [];
    let legacyBuilds = 0;
    const result = await runResponderHarness({
      deps: {
        ...enrollmentDeps(registered),
        payloadJSON: () => {
          legacyBuilds += 1;
          return PAYLOAD_JSON;
        },
      },
      initiator: (peer) => runInitiator(peer, { cpk: true, clientKeyLine: CLIENT_LINE }),
    });
    expect(result.responderResult.status).toBe("paired");
    expect(legacyBuilds).toBe(0);
    expect(result.initiatorResult.payloadJSON).toBe(NOKEY_PAYLOAD_JSON);
  });

  it("legacy フォールバック時のみビルダを 1 回評価して key あり payload を送る", async () => {
    const registered: string[] = [];
    let legacyBuilds = 0;
    const result = await runResponderHarness({
      deps: {
        ...enrollmentDeps(registered),
        payloadJSON: () => {
          legacyBuilds += 1;
          return PAYLOAD_JSON;
        },
      },
      initiator: (peer) => runInitiator(peer),
    });
    expect(result.responderResult.status).toBe("paired");
    expect(legacyBuilds).toBe(1);
    expect(result.initiatorResult.payloadJSON).toBe(PAYLOAD_JSON);
  });

  it("旧アプリ（cpk なし）には ck を付けず legacy payload を送る", async () => {
    const registered: string[] = [];
    const result = await runResponderHarness({
      deps: enrollmentDeps(registered),
      initiator: (peer) => runInitiator(peer),
    });
    expect(result.responderResult).toEqual({ status: "paired" });
    expect(registered).toEqual([]);
    expect(result.initiatorResult.ckAcked).toBe(false);
    expect(result.initiatorResult.payloadJSON).toBe(PAYLOAD_JSON);
    expect(result.wire).not.toContain('"ck":1');
  });

  it("responder が enrollment 非対応（deps 欠落）なら cpk が来ても legacy にフォールバックする", async () => {
    const result = await runResponderHarness({
      initiator: (peer) => runInitiator(peer, { cpk: true, clientKeyLine: CLIENT_LINE }),
    });
    expect(result.responderResult).toEqual({ status: "paired" });
    expect(result.initiatorResult.ckAcked).toBe(false);
    expect(result.initiatorResult.payloadJSON).toBe(PAYLOAD_JSON);
  });

  it("PSK モードでは SAS を表示せず自動確認で成立する（QR ブートストラップ）", async () => {
    const registered: string[] = [];
    const result = await runResponderHarness({
      deps: enrollmentDeps(registered),
      initiator: (peer) => runInitiator(peer, { cpk: true, psk: PSK, clientKeyLine: CLIENT_LINE }),
    });
    expect(result.responderResult).toEqual({ status: "paired", clientKeyLine: CLIENT_LINE });
    expect(result.displayedSAS).toEqual([]);
    expect(result.initiatorResult.payloadJSON).toBe(NOKEY_PAYLOAD_JSON);
  });

  it("hello.psk=1 なのに responder が psk を持たなければ即 abort する", async () => {
    const result = await runResponderHarness({
      initiator: (peer) => runInitiator(peer, { psk: PSK, timeoutMs: 200 }),
    });
    expect(result.responderResult).toEqual({ status: "aborted", reason: "psk unavailable" });
    expectNoPayloadOnWire(result.wire);
  });

  it("PSK 不一致（能動 MITM 相当）は confirm mac mismatch で abort・payload 非送出", async () => {
    const registered: string[] = [];
    const result = await runResponderHarness({
      deps: enrollmentDeps(registered),
      initiator: (peer) => runInitiator(peer, { cpk: true, psk: Buffer.alloc(32, 0x99), clientKeyLine: CLIENT_LINE }),
    });
    expect(result.responderResult).toEqual({ status: "aborted", reason: "confirm mac mismatch" });
    expect(registered).toEqual([]);
    expectNoPayloadOnWire(result.wire);
  });

  it("不正な client_key 平文は abort し、登録も payload 送出もしない", async () => {
    const registered: string[] = [];
    const result = await runResponderHarness({
      deps: enrollmentDeps(registered),
      initiator: (peer) =>
        runInitiator(peer, { cpk: true, rawClientKeyPlaintext: Buffer.from("ssh-rsa AAAA evil", "utf8") }),
    });
    expect(result.responderResult).toEqual({ status: "aborted", reason: "invalid client public key" });
    expect(registered).toEqual([]);
    expectNoPayloadOnWire(result.wire);
  });
});

// MARK: - parseClientPublicKeyLine

describe("parseClientPublicKeyLine", () => {
  it("妥当な ed25519 公開鍵行（comment あり/なし）を受理する", () => {
    const withComment = makeClientKeyLine("tailii-ios");
    const withoutComment = makeClientKeyLine();
    expect(parseClientPublicKeyLine(Buffer.from(withComment, "utf8"))).toBe(withComment);
    expect(parseClientPublicKeyLine(Buffer.from(withoutComment, "utf8"))).toBe(withoutComment);
  });

  it("型不一致・blob 破損・制御文字・過大入力を拒否する", () => {
    const valid = makeClientKeyLine();
    expect(parseClientPublicKeyLine(Buffer.from("ssh-rsa AAAA x", "utf8"))).toBeNull();
    expect(parseClientPublicKeyLine(Buffer.from("", "utf8"))).toBeNull();
    // blob 内の型名が一致しない（ssh-ed25519 ラベルの blob 差し替え）。
    const type = Buffer.from("ssh-rsa0000", "utf8");
    const bogusBlob = Buffer.concat([u32(type.length), type, u32(32), Buffer.alloc(32, 1)]);
    expect(parseClientPublicKeyLine(Buffer.from(`ssh-ed25519 ${bogusBlob.toString("base64")}`, "utf8"))).toBeNull();
    // 末尾に余剰バイトのある blob。
    const goodType = Buffer.from("ssh-ed25519", "utf8");
    const oversized = Buffer.concat([u32(goodType.length), goodType, u32(32), Buffer.alloc(33, 1)]);
    expect(parseClientPublicKeyLine(Buffer.from(`ssh-ed25519 ${oversized.toString("base64")}`, "utf8"))).toBeNull();
    // 改行注入（authorized_keys 汚染）を拒否。
    expect(parseClientPublicKeyLine(Buffer.from(`${valid}\nssh-ed25519 evil`, "utf8"))).toBeNull();
    // 1024B 超。
    expect(parseClientPublicKeyLine(Buffer.from(`${valid} ${"x".repeat(1100)}`, "utf8"))).toBeNull();
    // 空白 3 分割超（余計なフィールド）。
    expect(parseClientPublicKeyLine(Buffer.from(`${valid} a b`, "utf8"))).toBeNull();
  });
});
