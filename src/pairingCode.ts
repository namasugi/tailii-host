// pairingCode.ts
// tailii-host (TS host) — pairing-code v1 responder protocol.

import * as crypto from "node:crypto";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PROTOCOL_VERSION = 1;
const INFO_SAS = "pocketclaude-pair-v1 sas";
const INFO_CONFIRM = "pocketclaude-pair-v1 confirm";
const INFO_DATA = "pocketclaude-pair-v1 data";
const INITIATOR_CONFIRM_MESSAGE = "pocketclaude-pair-v1 initiator-confirm";
const DEFAULT_STEP_TIMEOUT_MS = 30_000;

export interface PairingStream {
  readable: NodeJS.ReadableStream;
  writable: NodeJS.WritableStream;
}

export interface PairingResponderDeps {
  payloadJSON: string;
  displaySAS: (code: string) => void;
  randomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

export type PairingResult = { status: "paired" } | { status: "aborted"; reason: string };

export interface DerivedPairingKeys {
  salt: Buffer;
  sasCode: string;
  confirmKey: Buffer;
  dataKey: Buffer;
}

export type PairingMessage =
  | { t: "hello"; v: 1; commit: string }
  | { t: "server_key"; v: 1; epk: string }
  | { t: "reveal"; epk: string }
  | { t: "confirm"; mac: string }
  | { t: "payload"; iv: string; ct: string; tag: string };

export function rawX25519PublicKeyToKeyObject(raw32: Buffer): crypto.KeyObject {
  if (raw32.length !== 32) throw new Error("x25519 public key must be 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw32]), format: "der", type: "spki" });
}

export function x25519PublicKeyObjectToRaw(publicKey: crypto.KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" });
  const bytes = Buffer.isBuffer(der) ? der : Buffer.from(der);
  if (bytes.length !== X25519_SPKI_PREFIX.length + 32) throw new Error("unexpected x25519 SPKI length");
  if (!bytes.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)) {
    throw new Error("unexpected x25519 SPKI prefix");
  }
  return Buffer.from(bytes.subarray(X25519_SPKI_PREFIX.length));
}

export function hkdfSha256(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length));
}

export function deriveSASCode(kSas4: Buffer): string {
  if (kSas4.length !== 4) throw new Error("SAS key must be 4 bytes");
  return String(kSas4.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function pairingTranscriptSalt(commit32: Buffer, responderPubRaw32: Buffer, initiatorPubRaw32: Buffer): Buffer {
  if (commit32.length !== 32 || responderPubRaw32.length !== 32 || initiatorPubRaw32.length !== 32) {
    throw new Error("pairing transcript fields must be 32 bytes");
  }
  return crypto.createHash("sha256").update(commit32).update(responderPubRaw32).update(initiatorPubRaw32).digest();
}

export function derivePairingKeys(
  sharedSecret32: Buffer,
  commit32: Buffer,
  responderPubRaw32: Buffer,
  initiatorPubRaw32: Buffer,
): DerivedPairingKeys {
  if (sharedSecret32.length !== 32) throw new Error("x25519 shared secret must be 32 bytes");
  const salt = pairingTranscriptSalt(commit32, responderPubRaw32, initiatorPubRaw32);
  const kSas = hkdfSha256(sharedSecret32, salt, INFO_SAS, 4);
  return {
    salt,
    sasCode: deriveSASCode(kSas),
    confirmKey: hkdfSha256(sharedSecret32, salt, INFO_CONFIRM, 32),
    dataKey: hkdfSha256(sharedSecret32, salt, INFO_DATA, 32),
  };
}

export function computeInitiatorConfirmMac(confirmKey32: Buffer): Buffer {
  if (confirmKey32.length !== 32) throw new Error("confirm key must be 32 bytes");
  return crypto.createHmac("sha256", confirmKey32).update(INITIATOR_CONFIRM_MESSAGE, "utf8").digest();
}

export function encodePairingMessage(message: PairingMessage): string {
  return JSON.stringify(message);
}

export function parsePairingMessage(line: string): PairingMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.t !== "string") return null;
  switch (value.t) {
    case "hello":
      if (value.v !== PROTOCOL_VERSION || typeof value.commit !== "string") return null;
      return { t: "hello", v: PROTOCOL_VERSION, commit: value.commit };
    case "server_key":
      if (value.v !== PROTOCOL_VERSION || typeof value.epk !== "string") return null;
      return { t: "server_key", v: PROTOCOL_VERSION, epk: value.epk };
    case "reveal":
      if (typeof value.epk !== "string") return null;
      return { t: "reveal", epk: value.epk };
    case "confirm":
      if (typeof value.mac !== "string") return null;
      return { t: "confirm", mac: value.mac };
    case "payload":
      if (typeof value.iv !== "string" || typeof value.ct !== "string" || typeof value.tag !== "string") return null;
      return { t: "payload", iv: value.iv, ct: value.ct, tag: value.tag };
    default:
      return null;
  }
}

export function decodeBase64Field(value: string, expectedLength: number): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedLength) return null;
  if (decoded.toString("base64") !== value) return null;
  return decoded;
}

export function encryptPayload(dataKey32: Buffer, plaintext: Buffer, randomBytes: (size: number) => Buffer): {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
} {
  if (dataKey32.length !== 32) throw new Error("data key must be 32 bytes");
  const iv = randomBytes(12);
  if (iv.length !== 12) throw new Error("AEAD IV must be 12 bytes");
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey32, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

export function decryptPayload(dataKey32: Buffer, iv12: Buffer, ciphertext: Buffer, tag16: Buffer): Buffer {
  if (dataKey32.length !== 32 || iv12.length !== 12 || tag16.length !== 16) {
    throw new Error("invalid AES-256-GCM input length");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey32, iv12);
  decipher.setAuthTag(tag16);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function runPairingResponder(stream: PairingStream, deps: PairingResponderDeps): Promise<PairingResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  const reader = new PairingLineReader(stream.readable);
  try {
    const helloLine = await reader.readLine(timeoutMs);
    if (helloLine === null) return abort(stream, reader, "timeout");
    const hello = parsePairingMessage(helloLine);
    if (hello?.t !== "hello") return abort(stream, reader, "invalid hello");
    const commit = decodeBase64Field(hello.commit, 32);
    if (commit === null) return abort(stream, reader, "invalid commit");

    const responderKeypair = crypto.generateKeyPairSync("x25519");
    const responderPubRaw = x25519PublicKeyObjectToRaw(responderKeypair.publicKey);
    writeMessage(stream.writable, { t: "server_key", v: PROTOCOL_VERSION, epk: responderPubRaw.toString("base64") });

    const revealLine = await reader.readLine(timeoutMs);
    if (revealLine === null) return abort(stream, reader, "timeout");
    const reveal = parsePairingMessage(revealLine);
    if (reveal?.t !== "reveal") return abort(stream, reader, "invalid reveal");
    const initiatorPubRaw = decodeBase64Field(reveal.epk, 32);
    if (initiatorPubRaw === null) return abort(stream, reader, "invalid initiator key");
    const expectedCommit = crypto.createHash("sha256").update(initiatorPubRaw).digest();
    if (!safeEqual32(expectedCommit, commit)) return abort(stream, reader, "commitment mismatch");

    const initiatorPub = rawX25519PublicKeyToKeyObject(initiatorPubRaw);
    const sharedSecret = crypto.diffieHellman({ privateKey: responderKeypair.privateKey, publicKey: initiatorPub });
    const keys = derivePairingKeys(sharedSecret, commit, responderPubRaw, initiatorPubRaw);
    deps.displaySAS(keys.sasCode);

    const confirmLine = await reader.readLine(timeoutMs);
    if (confirmLine === null) return abort(stream, reader, "timeout");
    const confirm = parsePairingMessage(confirmLine);
    if (confirm?.t !== "confirm") return abort(stream, reader, "invalid confirm");
    const receivedMac = decodeBase64Field(confirm.mac, 32);
    if (receivedMac === null) return abort(stream, reader, "invalid confirm mac");
    const expectedMac = computeInitiatorConfirmMac(keys.confirmKey);
    if (!safeEqual32(receivedMac, expectedMac)) return abort(stream, reader, "confirm mac mismatch");

    const encrypted = encryptPayload(keys.dataKey, Buffer.from(deps.payloadJSON, "utf8"), randomBytes);
    writeMessage(stream.writable, {
      t: "payload",
      iv: encrypted.iv.toString("base64"),
      ct: encrypted.ciphertext.toString("base64"),
      tag: encrypted.tag.toString("base64"),
    });
    endWritable(stream.writable);
    reader.dispose();
    return { status: "paired" };
  } catch {
    return abort(stream, reader, "aborted");
  }
}

function writeMessage(writable: NodeJS.WritableStream, message: PairingMessage): void {
  writable.write(encodePairingMessage(message) + "\n");
}

function safeEqual32(a: Buffer, b: Buffer): boolean {
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
}

function abort(stream: PairingStream, reader: PairingLineReader, reason: string): PairingResult {
  reader.dispose();
  destroyWritable(stream.writable);
  destroyReadable(stream.readable);
  return { status: "aborted", reason };
}

function endWritable(writable: NodeJS.WritableStream): void {
  if ("end" in writable && typeof writable.end === "function") writable.end();
}

function destroyWritable(writable: NodeJS.WritableStream): void {
  if ("destroy" in writable && typeof writable.destroy === "function") writable.destroy();
  else endWritable(writable);
}

function destroyReadable(readable: NodeJS.ReadableStream): void {
  if ("destroy" in readable && typeof readable.destroy === "function") readable.destroy();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class PairingLineReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private lines: string[] = [];
  private ended = false;
  private waiter: ((line: string | null) => void) | null = null;

  constructor(private readonly readable: NodeJS.ReadableStream) {
    readable.on("data", this.onData);
    readable.once("end", this.onEnd);
    readable.once("close", this.onEnd);
    readable.once("error", this.onEnd);
  }

  readLine(timeoutMs: number): Promise<string | null> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(null);
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

  dispose(): void {
    this.readable.off("data", this.onData);
    this.readable.off("end", this.onEnd);
    this.readable.off("close", this.onEnd);
    this.readable.off("error", this.onEnd);
    this.waiter = null;
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let line: string | null;
    while ((line = this.shiftLine()) !== null) {
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
    this.ended = true;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(null);
    }
  };

  private shiftLine(): string | null {
    const idx = this.buffer.indexOf(0x0a);
    if (idx < 0) return null;
    const line = this.buffer.subarray(0, idx).toString("utf8");
    this.buffer = this.buffer.subarray(idx + 1);
    return line;
  }
}
