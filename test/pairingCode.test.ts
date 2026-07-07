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
  hkdfSha256,
  pairingTranscriptSalt,
  parsePairingMessage,
  rawX25519PublicKeyToKeyObject,
  runPairingResponder,
  x25519PublicKeyObjectToRaw,
  type PairingMessage,
  type PairingResult,
  type PairingStream,
} from "../src/pairingCode.js";

const PAYLOAD_JSON = '{\n  "host" : "192.168.1.2",\n  "key" : "PRIVATE",\n  "port" : 22,\n  "user" : "alice",\n  "v" : 1\n}';

interface MemoryPeer {
  stream: PairingStream;
  inbound: PassThrough;
  outbound: PassThrough;
}

interface InitiatorResult {
  payloadJSON?: string;
  sasCode?: string;
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
  } = {},
): Promise<InitiatorResult> {
  const reader = new TestLineReader(peer.stream.readable);
  const wireKeypair = options.wireKeypair ?? generateX25519();
  const deriveKeypair = options.deriveKeypair ?? wireKeypair;
  const wirePub = pubRaw(wireKeypair);
  const derivePub = pubRaw(deriveKeypair);
  const commit = options.commitFrom ?? sha256(wirePub);

  writeMessage(peer.stream.writable, { t: "hello", v: 1, commit: commit.toString("base64") });

  const serverKeyLine = await reader.readLine(options.timeoutMs);
  if (serverKeyLine === null) return {};
  const serverKey = parsePairingMessage(serverKeyLine);
  if (serverKey?.t !== "server_key") throw new Error("expected server_key");
  const responderPub = decodeBase64Field(serverKey.epk, 32);
  if (responderPub === null) throw new Error("invalid server key");

  writeMessage(peer.stream.writable, { t: "reveal", epk: wirePub.toString("base64") });

  const sharedSecret = crypto.diffieHellman({
    privateKey: deriveKeypair.privateKey,
    publicKey: rawX25519PublicKeyToKeyObject(responderPub),
  });
  const keys = derivePairingKeys(sharedSecret, sha256(derivePub), responderPub, derivePub);
  if (options.skipConfirm) return { sasCode: keys.sasCode };

  const mac = options.badConfirmMac ? Buffer.alloc(32, 0xa5) : computeInitiatorConfirmMac(keys.confirmKey);
  writeMessage(peer.stream.writable, { t: "confirm", mac: mac.toString("base64") });

  const payloadLine = await reader.readLine(options.timeoutMs);
  if (payloadLine === null) return { sasCode: keys.sasCode };
  const payload = parsePairingMessage(payloadLine);
  if (payload?.t !== "payload") return { sasCode: keys.sasCode };
  const iv = decodeBase64Field(payload.iv, 12);
  const tag = decodeBase64Field(payload.tag, 16);
  if (iv === null || tag === null) throw new Error("invalid payload fields");
  const plaintext = decryptPayload(keys.dataKey, iv, Buffer.from(payload.ct, "base64"), tag);
  return { sasCode: keys.sasCode, payloadJSON: plaintext.toString("utf8") };
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
}): Promise<{ responderResult: PairingResult; initiatorResult: InitiatorResult; displayedSAS: string[]; wire: string }> {
  const pair = createMemoryPair();
  const displayedSAS: string[] = [];
  const responderDone = runPairingResponder(pair.responder.stream, {
    payloadJSON: PAYLOAD_JSON,
    displaySAS: (code) => displayedSAS.push(code),
    timeoutMs: options.timeoutMs ?? 1000,
    randomBytes: (size) => Buffer.alloc(size, 7),
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
