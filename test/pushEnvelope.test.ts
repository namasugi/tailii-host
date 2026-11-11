// pushEnvelope.test.ts — push v1 の暗号化（契約 protocol/push-v1.md §2）

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeB64uStrict,
  decodePushKey,
  encodePushPlaintext,
  fitPushPlaintext,
  openPushTp,
  PUSH_CIPHERTEXT_MAX_BYTES,
  pushKeyId,
  sealPushContent,
  sealPushPlaintext,
  sealedB64uLength,
} from "../src/push/pushEnvelope.js";

const vector = JSON.parse(readFileSync(
  join(fileURLToPath(import.meta.url), "..", "..", "protocol", "push-envelope-v1.json"), "utf8",
)) as { key: string; nonce: string; aad: string; plaintext: string; tp: { v: number; k: string; n: string; c: string } };

describe("push envelope v1", () => {
  it("golden ベクタと byte-exact に一致する（鍵 id・AAD・nonce・暗号文 ‖ タグ）", () => {
    const key = decodePushKey(vector.key)!;
    expect(key).not.toBeNull();
    expect(pushKeyId(key)).toBe(vector.tp.k);
    expect(vector.aad).toBe(`tailii-push-v1:${vector.tp.k}`);
    const tp = sealPushPlaintext(key, vector.plaintext, Buffer.from(vector.nonce, "base64url"));
    expect(JSON.stringify(tp)).toBe(JSON.stringify(vector.tp));
    expect(openPushTp(key, tp)).toBe(vector.plaintext);
  });

  it("平文のキー順は golden と同じ（v, kind, session, title, body, id, ts）", () => {
    const encoded = encodePushPlaintext({
      kind: "turn_done", session: "s-29702ec1", title: "通知の設計",
      body: "作業が完了しました。テストは全て通っています。", id: "turn-1", ts: 1794300000,
    });
    expect(encoded).toBe(vector.plaintext);
    expect(encodePushPlaintext({ kind: "usage_limit", session: "s", title: "t", body: "b", ts: 1 }))
      .toBe('{"v":1,"kind":"usage_limit","session":"s","title":"t","body":"b","ts":1}');
  });

  it("改ざん・鍵違いは復号できない", () => {
    const key = decodePushKey(vector.key)!;
    const tp = sealPushPlaintext(key, "hello");
    const flipped = Buffer.from(tp.c, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(openPushTp(key, { ...tp, c: flipped.toString("base64url") })).toBeNull();
    const other = Buffer.alloc(32, 7);
    expect(openPushTp(other, tp)).toBeNull();
  });

  it("pushKey は厳密な b64u・32 バイトだけ受け付ける", () => {
    expect(decodePushKey(vector.key)).not.toBeNull();
    expect(decodePushKey(`${vector.key}=`)).toBeNull();
    expect(decodePushKey(Buffer.alloc(31).toString("base64url"))).toBeNull();
    expect(decodePushKey(Buffer.alloc(33).toString("base64url"))).toBeNull();
    expect(decodePushKey(Buffer.alloc(32, 0xfb).toString("base64"))).toBeNull(); // 標準 base64 の記号
    expect(decodeB64uStrict("AB")).toBeNull(); // 余分な末尾ビット
  });

  it("長い本文は切り詰めて tp.c を 3072 バイト以下に収める（題名・id・会話は保つ）", () => {
    const key = decodePushKey(vector.key)!;
    const longBody = "あ".repeat(5000);
    const plaintext = { kind: "approval" as const, session: "cs-abc", title: "題名", body: longBody, id: "ap-1", ts: 1 };
    const tp = sealPushContent(key, plaintext);
    expect(Buffer.byteLength(tp.c, "utf8")).toBeLessThanOrEqual(PUSH_CIPHERTEXT_MAX_BYTES);
    const opened = JSON.parse(openPushTp(key, tp)!) as Record<string, unknown>;
    expect(opened["title"]).toBe("題名");
    expect(opened["id"]).toBe("ap-1");
    expect(String(opened["body"]).endsWith("…")).toBe(true);
    // 収まる限り長く残す（1 文字足すと溢れる）。
    const fitted = fitPushPlaintext(plaintext);
    const chars = [...fitted.body].length - 1;
    const longer = { ...plaintext, body: "あ".repeat(chars + 1) + "…" };
    expect(sealedB64uLength(Buffer.byteLength(encodePushPlaintext(longer), "utf8"))).toBeGreaterThan(PUSH_CIPHERTEXT_MAX_BYTES);
  });

  it("短い本文はそのまま", () => {
    const plaintext = { kind: "question" as const, session: "s", title: "t", body: "本文", ts: 1 };
    expect(fitPushPlaintext(plaintext)).toEqual(plaintext);
  });

  it("題名だけで溢れる場合は題名も切る", () => {
    const fitted = fitPushPlaintext({ kind: "question", session: "s", title: "x".repeat(4000), body: "b", ts: 1 });
    expect(fitted.title.length).toBeLessThan(4000);
    expect(sealedB64uLength(Buffer.byteLength(encodePushPlaintext(fitted), "utf8"))).toBeLessThanOrEqual(PUSH_CIPHERTEXT_MAX_BYTES);
  });
});
