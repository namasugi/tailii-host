// protocol/common.ts
// decode/encode 共有の内部ヘルパ: 型付きデコードエラーと Raw フィールド取り出し。
// 公開 API へは facade（../protocol.ts）が ProtocolDecodeError のみを再輸出する。

/** decode が投げる型付きエラー。呼び出し元は「決定未取得」として安全側（deny）に倒す。 */
export class ProtocolDecodeError extends Error {
  constructor(
    public readonly reason:
      | "invalid-json"
      | "missing-type"
      | "unknown-type"
      | "unsupported-version"
      | "legacy-unsupported-type"
      | "missing-field",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "ProtocolDecodeError";
  }
}

// MARK: - フィールド取り出しヘルパ

export type Raw = Record<string, unknown>;

export function requireString(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw new ProtocolDecodeError("missing-field", key);
  return value;
}

export function optionalString(raw: Raw, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalNullableString(raw: Raw, key: string): string | null | undefined {
  const value = raw[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function requireNumber(raw: Raw, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolDecodeError("missing-field", key);
  }
  return value;
}

export function optionalNumber(raw: Raw, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function requireBoolean(raw: Raw, key: string): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") throw new ProtocolDecodeError("missing-field", key);
  return value;
}

export function optionalBoolean(raw: Raw, key: string): boolean | undefined {
  const value = raw[key];
  return typeof value === "boolean" ? value : undefined;
}

export function requireObject(value: unknown, key: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolDecodeError("missing-field", key);
  }
  return value as Raw;
}

export function requireArray(raw: Raw, key: string): unknown[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw new ProtocolDecodeError("missing-field", key);
  return value;
}

export function requireStringArray(raw: Raw, key: string): string[] {
  return requireArray(raw, key).map((element) => {
    if (typeof element !== "string") throw new ProtocolDecodeError("missing-field", key);
    return element;
  });
}

/** undefined 値のキーを持たないオブジェクトを組み立てる（exactOptionalPropertyTypes 対応）。 */
export function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
