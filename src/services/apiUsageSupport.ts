/** 金額の十進数文字列を合算する。minorPlaces=2 はセントから USD への換算。 */
export function sumApiAmounts(values: readonly (number | string)[], minorPlaces = 0): string {
  let total = 0n;
  let scale = 0;
  for (const amount of values) {
    const raw = String(amount).toLowerCase();
    if (raw.length > 64 || !/^-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/.test(raw)) throw new Error("invalid-amount");
    const [mantissa = "0", exponent = "0"] = raw.split("e");
    const digits = mantissa.split(".")[1]?.length ?? 0;
    const signedScale = digits - Number(exponent) + minorPlaces;
    if (!Number.isSafeInteger(signedScale) || Math.abs(signedScale) > 400) throw new Error("amount-too-large");
    const decimalScale = Math.max(0, signedScale);
    const value = BigInt(mantissa.replace(".", "")) * 10n ** BigInt(Math.max(0, -signedScale));
    const nextScale = Math.max(scale, decimalScale);
    total = total * 10n ** BigInt(nextScale - scale) + value * 10n ** BigInt(nextScale - decimalScale);
    scale = nextScale;
  }
  const sign = total < 0n ? "-" : "";
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  if (!scale) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return sign + digits.slice(0, -scale) + (fraction ? "." + fraction : "");
}

export async function readApiJson(response: Response, budget: { remaining: number }): Promise<unknown> {
  if (!response.body) throw new Error("missing-body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) { await reader.cancel(); throw new Error("body-too-large"); }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { reader.releaseLock(); }
}

export function apiRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
