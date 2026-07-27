// pairingCode.ts
// tailii-host (TS host) — pairing-code v1 responder protocol.

import * as crypto from "node:crypto";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PROTOCOL_VERSION = 1;
const INFO_SAS = "pocketclaude-pair-v1 sas";
const INFO_CONFIRM = "pocketclaude-pair-v1 confirm";
const INFO_DATA = "pocketclaude-pair-v1 data";
const INFO_CLIENT_KEY = "pocketclaude-pair-v1 client-key";
const INITIATOR_CONFIRM_MESSAGE = "pocketclaude-pair-v1 initiator-confirm";
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
/** client_key 平文（authorized_keys 1 行）の上限（spec v1.1）。 */
const CLIENT_KEY_LINE_MAX_BYTES = 1024;

export interface PairingStream {
  readable: NodeJS.ReadableStream;
  writable: NodeJS.WritableStream;
}

export interface PairingResponderDeps {
  /**
   * legacy（key あり）payload。enrollment 不成立のときだけ送る。
   * 関数を渡すと**その時にだけ**評価される（ホスト側鍵の生成・登録を遅延させ、
   * 新アプリだけを使う環境にホスト生成の秘密鍵を残さないため）。
   */
  payloadJSON: string | (() => string);
  displaySAS: (code: string) => void;
  /** v1.1: enrollment 成立時に送る key なし payload（v4）。registerClientKey と揃って指定で enrollment 有効。 */
  payloadJSONNoKey?: string;
  /** v1.1: QR ブートストラップのワンタイム PSK（32B）。hello.psk==1 の接続で鍵導出に混合する。 */
  psk?: Buffer;
  /** v1.1: 検証済みクライアント公開鍵行を authorized_keys へ登録する副作用。 */
  registerClientKey?: (publicKeyLine: string) => void;
  randomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

export type PairingResult =
  | { status: "paired"; clientKeyLine?: string }
  | { status: "aborted"; reason: string };

export interface DerivedPairingKeys {
  salt: Buffer;
  sasCode: string;
  confirmKey: Buffer;
  dataKey: Buffer;
  clientKey: Buffer;
}

export type PairingMessage =
  | { t: "hello"; v: 1; commit: string; cpk?: 1; psk?: 1 }
  | { t: "server_key"; v: 1; epk: string; ck?: 1 }
  | { t: "reveal"; epk: string }
  | { t: "confirm"; mac: string }
  | { t: "client_key"; iv: string; ct: string; tag: string }
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
  psk32?: Buffer,
): DerivedPairingKeys {
  if (sharedSecret32.length !== 32) throw new Error("x25519 shared secret must be 32 bytes");
  if (psk32 !== undefined && psk32.length !== 32) throw new Error("pairing psk must be 32 bytes");
  // v1.1 PSK モード: ikm を Z から Z || psk に置き換える（salt・info は不変）。
  const ikm = psk32 === undefined ? sharedSecret32 : Buffer.concat([sharedSecret32, psk32]);
  const salt = pairingTranscriptSalt(commit32, responderPubRaw32, initiatorPubRaw32);
  const kSas = hkdfSha256(ikm, salt, INFO_SAS, 4);
  return {
    salt,
    sasCode: deriveSASCode(kSas),
    confirmKey: hkdfSha256(ikm, salt, INFO_CONFIRM, 32),
    dataKey: hkdfSha256(ikm, salt, INFO_DATA, 32),
    clientKey: hkdfSha256(ikm, salt, INFO_CLIENT_KEY, 32),
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
      return {
        t: "hello",
        v: PROTOCOL_VERSION,
        commit: value.commit,
        ...(value.cpk === 1 ? { cpk: 1 as const } : {}),
        ...(value.psk === 1 ? { psk: 1 as const } : {}),
      };
    case "server_key":
      if (value.v !== PROTOCOL_VERSION || typeof value.epk !== "string") return null;
      return {
        t: "server_key",
        v: PROTOCOL_VERSION,
        epk: value.epk,
        ...(value.ck === 1 ? { ck: 1 as const } : {}),
      };
    case "reveal":
      if (typeof value.epk !== "string") return null;
      return { t: "reveal", epk: value.epk };
    case "confirm":
      if (typeof value.mac !== "string") return null;
      return { t: "confirm", mac: value.mac };
    case "client_key":
      if (typeof value.iv !== "string" || typeof value.ct !== "string" || typeof value.tag !== "string") return null;
      return { t: "client_key", iv: value.iv, ct: value.ct, tag: value.tag };
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

/**
 * client_key 平文（authorized_keys 1 行）を検証して公開鍵行を返す（spec v1.1）。
 * `ssh-ed25519 <base64 blob> [comment]` 形式・blob が SSH wire 形式（string "ssh-ed25519" +
 * string 32B 公開鍵・末尾余剰なし）・制御文字なし・1024B 以下のみ受理。不正は null。
 */
export function parseClientPublicKeyLine(plaintext: Buffer): string | null {
  if (plaintext.length === 0 || plaintext.length > CLIENT_KEY_LINE_MAX_BYTES) return null;
  const line = plaintext.toString("utf8");
  if (Buffer.byteLength(line, "utf8") !== plaintext.length) return null;
  // 改行・制御文字を含む行は authorized_keys を汚染し得るため拒否する。
  if (/[\u0000-\u001f\u007f]/.test(line)) return null;
  const parts = line.split(" ");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "ssh-ed25519") return null;
  const blob = decodeBase64Loose(parts[1]!);
  if (blob === null) return null;
  // SSH wire: string "ssh-ed25519" + string pubkey(32B)、末尾に余剰バイトなし。
  const typeName = Buffer.from("ssh-ed25519", "utf8");
  if (blob.length !== 4 + typeName.length + 4 + 32) return null;
  if (blob.readUInt32BE(0) !== typeName.length) return null;
  if (!blob.subarray(4, 4 + typeName.length).equals(typeName)) return null;
  if (blob.readUInt32BE(4 + typeName.length) !== 32) return null;
  return line;
}

/** 長さ不定の base64（std, padding あり）をデコードする。往復一致しないものは null。 */
function decodeBase64Loose(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return decoded;
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

    // v1.1: PSK モード（QR ブートストラップ）と enrollment の成立判定。
    const pskMode = hello.psk === 1;
    if (pskMode && deps.psk === undefined) return abort(stream, reader, "psk unavailable");
    const enroll =
      hello.cpk === 1 && deps.registerClientKey !== undefined && deps.payloadJSONNoKey !== undefined;

    const responderKeypair = crypto.generateKeyPairSync("x25519");
    const responderPubRaw = x25519PublicKeyObjectToRaw(responderKeypair.publicKey);
    writeMessage(stream.writable, {
      t: "server_key",
      v: PROTOCOL_VERSION,
      epk: responderPubRaw.toString("base64"),
      ...(enroll ? { ck: 1 as const } : {}),
    });

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
    const keys = derivePairingKeys(
      sharedSecret,
      commit,
      responderPubRaw,
      initiatorPubRaw,
      pskMode ? deps.psk : undefined,
    );
    // PSK モードでは SAS の人間照合を省略する（QR の psk 所持が相互認証を担う）。
    if (!pskMode) deps.displaySAS(keys.sasCode);

    const confirmLine = await reader.readLine(timeoutMs);
    if (confirmLine === null) return abort(stream, reader, "timeout");
    const confirm = parsePairingMessage(confirmLine);
    if (confirm?.t !== "confirm") return abort(stream, reader, "invalid confirm");
    const receivedMac = decodeBase64Field(confirm.mac, 32);
    if (receivedMac === null) return abort(stream, reader, "invalid confirm mac");
    const expectedMac = computeInitiatorConfirmMac(keys.confirmKey);
    if (!safeEqual32(receivedMac, expectedMac)) return abort(stream, reader, "confirm mac mismatch");

    // v1.1: enrollment 成立時は payload の前に client_key を受理・登録し、key なし payload を送る。
    let clientKeyLine: string | undefined;
    if (enroll) {
      const clientKeyMsgLine = await reader.readLine(timeoutMs);
      if (clientKeyMsgLine === null) return abort(stream, reader, "timeout");
      const clientKeyMsg = parsePairingMessage(clientKeyMsgLine);
      if (clientKeyMsg?.t !== "client_key") return abort(stream, reader, "invalid client_key");
      const iv = decodeBase64Field(clientKeyMsg.iv, 12);
      const tag = decodeBase64Field(clientKeyMsg.tag, 16);
      const ct = decodeBase64Loose(clientKeyMsg.ct);
      if (iv === null || tag === null || ct === null) return abort(stream, reader, "invalid client_key");
      let plaintext: Buffer;
      try {
        plaintext = decryptPayload(keys.clientKey, iv, ct, tag);
      } catch {
        return abort(stream, reader, "client_key decrypt failed");
      }
      const line = parseClientPublicKeyLine(plaintext);
      if (line === null) return abort(stream, reader, "invalid client public key");
      deps.registerClientKey!(line);
      clientKeyLine = line;
    }

    // legacy payload は enrollment 不成立のときだけ評価する（遅延 keygen の契約）。
    const payloadJSON = enroll
      ? deps.payloadJSONNoKey!
      : typeof deps.payloadJSON === "function"
        ? deps.payloadJSON()
        : deps.payloadJSON;
    const encrypted = encryptPayload(keys.dataKey, Buffer.from(payloadJSON, "utf8"), randomBytes);
    writeMessage(stream.writable, {
      t: "payload",
      iv: encrypted.iv.toString("base64"),
      ct: encrypted.ciphertext.toString("base64"),
      tag: encrypted.tag.toString("base64"),
    });
    endWritable(stream.writable);
    reader.dispose();
    return { status: "paired", ...(clientKeyLine !== undefined ? { clientKeyLine } : {}) };
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
