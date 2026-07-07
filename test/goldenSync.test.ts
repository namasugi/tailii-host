// goldenSync.test.ts — 同梱 goldens とモノレポ正本のドリフト検知
//
// 正本はモノレポルートの protocol/(iOS テストも同じファイルを参照)。
// このリポジトリには公開用にコピーを同梱している。両方が存在する開発機では
// byte-exact 一致を検証し、単体チェックアウト(CI 等)では自動スキップする。

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(hostRoot, "protocol");
const canonical = join(hostRoot, "..", "protocol");

describe.skipIf(!existsSync(canonical))("golden sync(モノレポ開発機のみ)", () => {
  it("同梱 protocol/ がモノレポ正本と byte-exact 一致する", () => {
    const canonicalFiles = readdirSync(canonical).sort();
    const bundledFiles = readdirSync(bundled).sort();
    expect(bundledFiles).toEqual(canonicalFiles);
    for (const name of canonicalFiles) {
      expect(
        readFileSync(join(bundled, name)).equals(readFileSync(join(canonical, name))),
        `protocol/${name} が正本とずれています。cp ../protocol/${name} protocol/ で同期してください`,
      ).toBe(true);
    }
  });
});
