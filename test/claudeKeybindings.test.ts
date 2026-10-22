// claudeKeybindings.test.ts
// 「一番下へ戻る」が既定の ctrl+End のままかの判定（scrolled-hiding-bottom）。

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import { claudeConfigDir, keybindingsTouchScrollBottom, scrollBottomKeyIsDefault } from "../src/shared/claudeKeybindings.js";
import { makeTempDir } from "./helpers.js";

test("keybindings.json が無ければ既定のまま（ctrl+End を送ってよい）", () => {
  expect(scrollBottomKeyIsDefault(makeTempDir("kb-none"))).toBe(true);
});

test("scroll:bottom か ctrl+End に触れていれば送らない（表記ゆれ・順序違い・解除も含む）", () => {
  const touching = [
    { bindings: [{ context: "Scroll", bindings: { "meta+g": "scroll:bottom" } }] },
    { bindings: [{ context: "Scroll", bindings: { "ctrl+end": null } }] },
    { bindings: [{ context: "Global", bindings: { "Ctrl+End": "app:toggleTodos" } }] },
    { bindings: [{ context: "Scroll", bindings: { "control+end": "scroll:top" } }] },
    { bindings: [{ context: "Scroll", bindings: { "end+ctrl": "scroll:top" } }] },
  ];
  for (const config of touching) {
    const dir = makeTempDir("kb-touch");
    fs.writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify(config, null, 2));
    expect(scrollBottomKeyIsDefault(dir)).toBe(false);
  }
});

test("無関係な割り当てだけなら既定のまま（ctrl+endless のような別のキー名に反応しない）", () => {
  const dir = makeTempDir("kb-other");
  fs.writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({
    bindings: [{ context: "Chat", bindings: { "ctrl+x ctrl+s": "chat:sendNow", end: "chat:cursorEnd" } }],
  }));
  expect(scrollBottomKeyIsDefault(dir)).toBe(true);
  expect(keybindingsTouchScrollBottom('{"ctrl+endless":"x"}')).toBe(false);
  expect(keybindingsTouchScrollBottom('{"backend+ctrl":"x"}')).toBe(false);
});

test("読めないファイルは確かめられないので送らない", () => {
  const dir = makeTempDir("kb-unreadable");
  fs.mkdirSync(path.join(dir, "keybindings.json"));
  expect(scrollBottomKeyIsDefault(dir)).toBe(false);
});

test("設定ディレクトリは CLAUDE_CONFIG_DIR があればその下（CLI 本体と同じ）", () => {
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/cc" })).toBe("/tmp/cc");
  expect(claudeConfigDir({})).toMatch(/\.claude$/);
});
