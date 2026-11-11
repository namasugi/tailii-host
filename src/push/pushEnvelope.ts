// pushEnvelope.ts
// tailii (TS host) — プッシュ通知の中身の暗号化（push v1 の `tp`）
//
// 契約の正本は protocol/push-v1.md §2。名前・符号化・値はここで変えない。
//   - 鍵: 32 バイト。鍵 id `k` = b64u(SHA-256(鍵) の先頭 8 バイト)
//   - 方式: ChaCha20-Poly1305。nonce は 12 バイト乱数。AAD は UTF-8 の `tailii-push-v1:` + `k`
//   - `tp` = {v:1, k, n: b64u(nonce), c: b64u(暗号文 ‖ 16 バイトのタグ)}
//   - `tp.c` は b64u で 3072 バイト以下。収まらなければ `body` を切り詰める
//
// 鍵そのもの・平文をログやエラーメッセージに出さない。

import * as crypto from "node:crypto";

/** AAD の接頭辞（契約 §2。凍結）。 */
export const PUSH_AAD_PREFIX = "tailii-push-v1:";
/** `tp.c`（b64u）の上限バイト数（契約 §2）。 */
export const PUSH_CIPHERTEXT_MAX_BYTES = 3072;
/** 鍵の長さ（バイト）。 */
export const PUSH_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** 切り詰めたことを示す末尾。 */
const ELLIPSIS = "…";

/** 通知の種類（契約 §2 の `kind`）。 */
export type PushKind = "turn_done" | "question" | "approval" | "usage_limit" | "turn_error";

export const PUSH_KINDS: readonly PushKind[] = ["turn_done", "question", "approval", "usage_limit", "turn_error"];

/** 暗号化した中身（APNs payload の `tp`）。 */
export interface PushTp {
  v: 1;
  k: string;
  n: string;
  c: string;
}

/** 平文（契約 §2 の表）。`id` は無い種別では省略する。 */
export interface PushPlaintext {
  kind: PushKind;
  session: string;
  title: string;
  body: string;
  id?: string;
  /** epoch 秒。 */
  ts: number;
}

/** base64url（パディング無し）。 */
export function b64u(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * b64u 文字列を厳密に復号する（パディング・標準 base64 の記号・余分な末尾ビットを拒む）。
 * 不正なら null。
 */
export function decodeB64uStrict(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  const decoded = Buffer.from(text, "base64url");
  // 余分な末尾ビットや長さ 4n+1 の入力は再符号化で一致しない。
  return b64u(decoded) === text ? decoded : null;
}

/** `pushKey`（b64u・32 バイト）を復号する。不正なら null。 */
export function decodePushKey(text: string): Buffer | null {
  const key = decodeB64uStrict(text);
  return key !== null && key.length === PUSH_KEY_BYTES ? key : null;
}

/** 鍵 id = b64u(SHA-256(鍵) の先頭 8 バイト)。 */
export function pushKeyId(key: Buffer): string {
  return b64u(crypto.createHash("sha256").update(key).digest().subarray(0, 8));
}

/** 平文を契約どおりのキー順（v, kind, session, title, body, id, ts）の JSON にする。 */
export function encodePushPlaintext(plaintext: PushPlaintext): string {
  return JSON.stringify({
    v: 1,
    kind: plaintext.kind,
    session: plaintext.session,
    title: plaintext.title,
    body: plaintext.body,
    ...(plaintext.id !== undefined ? { id: plaintext.id } : {}),
    ts: plaintext.ts,
  });
}

/** 平文（UTF-8 文字列）を暗号化して `tp` を作る。nonce はテストでだけ固定する。 */
export function sealPushPlaintext(key: Buffer, plaintext: string, nonce: Buffer = crypto.randomBytes(NONCE_BYTES)): PushTp {
  if (key.length !== PUSH_KEY_BYTES) throw new Error("push key must be 32 bytes");
  if (nonce.length !== NONCE_BYTES) throw new Error("push nonce must be 12 bytes");
  const k = pushKeyId(key);
  const data = Buffer.from(plaintext, "utf8");
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(PUSH_AAD_PREFIX + k, "utf8"), { plaintextLength: data.length });
  const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, k, n: b64u(nonce), c: b64u(sealed) };
}

/** `tp` を復号して平文（UTF-8 文字列）を返す。鍵 id 不一致・改ざん・形式不正は null（テスト・検証用）。 */
export function openPushTp(key: Buffer, tp: PushTp): string | null {
  if (tp.v !== 1 || tp.k !== pushKeyId(key)) return null;
  const nonce = decodeB64uStrict(tp.n);
  const sealed = decodeB64uStrict(tp.c);
  if (nonce === null || nonce.length !== NONCE_BYTES || sealed === null || sealed.length < TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
    const body = sealed.subarray(0, sealed.length - TAG_BYTES);
    decipher.setAAD(Buffer.from(PUSH_AAD_PREFIX + tp.k, "utf8"), { plaintextLength: body.length });
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** 平文 n バイトを暗号化したときの `c`（b64u・パディング無し）の長さ。 */
export function sealedB64uLength(plaintextBytes: number): number {
  return Math.ceil(((plaintextBytes + TAG_BYTES) * 4) / 3);
}

/**
 * `tp.c` が上限に収まるように `body` を切り詰めた平文を返す。題名などの固定部分だけで溢れる場合は
 * 題名も切り詰める（それでも溢れる異常なセッション名は呼び出し側の責任で弾く）。
 */
export function fitPushPlaintext(plaintext: PushPlaintext, maxCipherBytes = PUSH_CIPHERTEXT_MAX_BYTES): PushPlaintext {
  const fits = (candidate: PushPlaintext): boolean =>
    sealedB64uLength(Buffer.byteLength(encodePushPlaintext(candidate), "utf8")) <= maxCipherBytes;
  if (fits(plaintext)) return plaintext;
  const bodyCut = truncateFieldToFit(plaintext, "body", fits);
  if (bodyCut !== null) return bodyCut;
  // 本文を空にしても溢れる = 題名が長すぎる。本文は定型の省略記号だけ残し、題名を切る。
  const withoutBody = { ...plaintext, body: ELLIPSIS };
  const titleCut = truncateFieldToFit(withoutBody, "title", fits);
  if (titleCut !== null) return titleCut;
  throw new Error("push plaintext does not fit even after truncation");
}

/** 指定フィールドを code point 単位で二分探索して最長で収まる形を返す。収まらなければ null。 */
function truncateFieldToFit(
  plaintext: PushPlaintext,
  field: "body" | "title",
  fits: (candidate: PushPlaintext) => boolean,
): PushPlaintext | null {
  const chars = [...plaintext[field]];
  const make = (count: number): PushPlaintext => ({
    ...plaintext,
    [field]: count >= chars.length ? plaintext[field] : chars.slice(0, count).join("") + ELLIPSIS,
  });
  if (!fits(make(0))) return null;
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(make(mid))) low = mid;
    else high = mid - 1;
  }
  return make(low);
}

/** 平文を上限に収めてから暗号化する（host の送信経路が使う入口）。 */
export function sealPushContent(
  key: Buffer,
  plaintext: PushPlaintext,
  options: { nonce?: Buffer; maxCipherBytes?: number } = {},
): PushTp {
  const fitted = fitPushPlaintext(plaintext, options.maxCipherBytes);
  return sealPushPlaintext(key, encodePushPlaintext(fitted), options.nonce);
}

/** 文字列を code point 単位で最大 n 文字に切る（超えたら末尾に省略記号）。 */
export function clipChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("") + ELLIPSIS;
}
