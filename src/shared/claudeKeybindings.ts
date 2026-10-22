// claudeKeybindings.ts
// tailii (TS host) — Claude Code のキー割り当て（keybindings.json）の読み取り。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Claude Code の設定ディレクトリ（`CLAUDE_CONFIG_DIR` があればその下。CLI 本体と同じ解決）。 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["CLAUDE_CONFIG_DIR"];
  return configured !== undefined && configured !== "" ? configured : path.join(os.homedir(), ".claude");
}

/**
 * 「一番下へ戻る」（`scroll:bottom`）が既定の ctrl+End のまま確実に効くか（scrolled-hiding-bottom）。
 *
 * fullscreen 表示で上へスクロールされた画面を戻すキーとして ctrl+End（`JUMP_TO_LATEST_SEQUENCE`）を
 * 送る前に確かめる。利用者は `keybindings.json` で割り当てを変えられ、変えた後の ctrl+End が何を
 * するかは分からない。推測で別のキーへ置き換えることはせず、**少しでも触れていれば送らない**:
 * - ファイルが無い → 既定のまま（true）。
 * - `scroll:bottom` か `ctrl+end`（`control+end` / 順序違いも含む）に触れている → false。
 * - 読めない（権限・形式不明）→ false（CLI が既定へ戻していても、こちらは確かめられない）。
 * 戻せないときは、呼び出し側が「設問を Esc で閉じて文字で回答する」等の別経路へ倒す。
 */
export function scrollBottomKeyIsDefault(configDir: string = claudeConfigDir()): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(configDir, "keybindings.json"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return !keybindingsTouchScrollBottom(raw);
}

/** keybindings.json の本文が `scroll:bottom` か ctrl+End の割り当てに触れているか（TESTABLE）。 */
export function keybindingsTouchScrollBottom(raw: string): boolean {
  const text = raw.toLowerCase().replace(/\s+/g, "");
  if (text.includes("scroll:bottom")) return true;
  return /(?:ctrl|control)\+end(?![a-z])|(?<![a-z])end\+(?:ctrl|control)/.test(text);
}
