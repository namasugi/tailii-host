// Claude Code が transcript へ `thinking` ブロックとして書く「途中経過の発話」（narration）の検出。
//
// Claude Code（2.1.268〜2.1.283 で実測）は、ツール実行の合間にモデルが利用者へ向けて書いた
// 途中経過を、`text` ブロックではなく `thinking` ブロック（本文入り）として記録することがある。
// CLI はこれを通常の応答と同じ「⏺ 本文」で画面に出すので、text ブロックだけを読むと会話画面から
// 途中経過が丸ごと消える（実機 2026-09-28: 一覧のライブ表示には出るのに会話画面はツールカードだけ）。
//
// 本文の有無では決めない。通常の思考（thinking）や要約（summary）を発話として出さないよう、CLI と
// 同じく署名に入っている種別で判定する（CLI 2.1.283 の判定を移植）:
//   signature（base64）→ protobuf → field 2（bytes）→ field 1（bytes）→ field 8（string）が "narration"
// かつ本文が空白以外を含むこと。署名を読めない・形が違う場合は narration としない（出さない側へ倒す）。

const NARRATION_KIND = "narration";
const ENVELOPE_FIELD = 2;
const HEADER_FIELD = 1;
const KIND_FIELD = 8;

/**
 * assistant の content ブロックが narration なら、その本文（前後の空白を除く）を返す。
 * narration でない（text / tool_use / 通常の thinking など）なら null。
 */
export function narrationText(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const rec = block as Record<string, unknown>;
  if (rec["type"] !== "thinking") return null;
  const thinking = rec["thinking"];
  const signature = rec["signature"];
  if (typeof thinking !== "string" || typeof signature !== "string" || signature.length === 0) return null;
  const text = thinking.trim();
  if (text.length === 0) return null;
  return signatureKind(signature) === NARRATION_KIND ? text : null;
}

/** thinking ブロックの署名に入っている種別（"thinking" / "narration" / "summary" …）。読めなければ null。 */
export function signatureKind(signature: string): string | null {
  // base64 以外の文字が混じる署名は CLI（atob）でも読めない。Buffer は黙って読み飛ばすので先に弾く。
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(signature)) return null;
  // atob が拒否する余分な padding も Buffer は受理する。padding 省略（末尾 2 / 3 文字）は許す。
  if (signature.length % 4 === 1 || (signature.includes("=") && signature.length % 4 !== 0)) return null;
  const bytes = Buffer.from(signature, "base64");
  const envelope = lastBytesField(bytes, ENVELOPE_FIELD);
  if (envelope === null) return null;
  const header = lastBytesField(envelope, HEADER_FIELD);
  if (header === null) return null;
  const kind = lastBytesField(header, KIND_FIELD);
  return kind === null ? null : new TextDecoder("utf-8", { ignoreBOM: true }).decode(kind);
}

/**
 * protobuf メッセージを頭から最後まで走査し、`fieldNumber` の length-delimited フィールド（最後に
 * 現れたもの）を返す。途中で形が崩れていたら、それまでに見つけていても null（CLI と同じ）。
 */
function lastBytesField(bytes: Uint8Array, fieldNumber: number): Uint8Array | null {
  let found: Uint8Array | null = null;
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    // tag は uint32、field number は 1..2^29-1。予約値 0 や桁あふれは読めない署名として扱う。
    if (tag === null || tag.value < 8 || tag.value > 0xffff_ffff) return null;
    offset = tag.next;
    const wireType = tag.value & 7;
    const field = Math.floor(tag.value / 8);
    switch (wireType) {
      case 0: {
        const value = readVarint(bytes, offset);
        if (value === null) return null;
        offset = value.next;
        break;
      }
      case 1:
        if (offset + 8 > bytes.length) return null;
        offset += 8;
        break;
      case 2: {
        const length = readVarint(bytes, offset);
        if (length === null || length.value > bytes.length - length.next) return null;
        offset = length.next + length.value;
        if (field === fieldNumber) found = bytes.subarray(length.next, offset);
        break;
      }
      case 5:
        if (offset + 4 > bytes.length) return null;
        offset += 4;
        break;
      default:
        return null;
    }
  }
  return found;
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    const index = start + i;
    if (index >= bytes.length) return null;
    const byte = bytes[index]!;
    // uint64 の10バイト目に残せるのは最上位1ビットだけ（継続ビットも不可）。
    if (i === 9 && byte > 1) return null;
    value += (byte & 127) * scale;
    if ((byte & 128) === 0) return { value, next: index + 1 };
    scale *= 128;
  }
  return null;
}
