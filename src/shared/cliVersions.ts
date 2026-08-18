/**
 * 外部 CLI（Claude Code / Codex）との互換性境界。
 *
 * Tailii が依存している／相互運用を確認済みの最低版。最新版追従ではなく下限のみを
 * 定め、上限は設けない（CLI は自動更新されるため、完全一致の許可リストは更新の度に
 * 機能停止した実績がある）。新版の妥当性は各機能の実行時検証に委ねる。
 * doctor（診断）と officialApps（公式アプリ連携）の双方がこの値を参照する。
 */
export const MINIMUM_CLAUDE_CLI_VERSION = "2.1.215";
export const MINIMUM_CODEX_CLI_VERSION = "0.144.5";

/** `--version` の先頭に現れる数値版を比較用の整数列へ変換する。 */
export function parseNumericVersion(raw: string | null): number[] | null {
  if (raw === null) return null;
  const match = /\d+(?:\.\d+)+/.exec(raw);
  if (match === null) return null;
  const parts = match[0].split(".").map(Number);
  return parts.every(Number.isFinite) ? parts : null;
}

/** prerelease の飾りは無視し、数値成分だけで `actual >= minimum` を判定する。 */
export function versionAtLeast(actual: string | null, minimum: string): boolean | null {
  const left = parseNumericVersion(actual);
  const right = parseNumericVersion(minimum);
  if (left === null || right === null) return null;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l > r) return true;
    if (l < r) return false;
  }
  return true;
}
