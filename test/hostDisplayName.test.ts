import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCachedHostDisplayName, resolveHostDisplayName } from "../src/shared/hostDisplayName.js";
import { makeTempDir } from "./helpers.js";

const deps = () => ({ platform: "darwin" as NodeJS.Platform, hostname: vi.fn(() => "fallback.local"), scutilComputerName: vi.fn(() => "作業 Mac") });
const file = () => path.join(makeTempDir("display-name"), "cache", "host-display-name.json");
function put(cachePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(value));
}

describe("表示名の永続キャッシュ", () => {
  it("初回だけ同期で解決し、次の engine は保存名を即使う", async () => {
    const cachePath = file(); const first = deps();
    expect(resolveCachedHostDisplayName({ cachePath, deps: first })).toBe("作業 Mac");
    expect(first.scutilComputerName).toHaveBeenCalledOnce();
    expect(fs.statSync(cachePath).mode & 0o777).toBe(0o600);
    const next = deps();
    let finish!: (name: string) => void;
    const refresh = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    expect(resolveCachedHostDisplayName({ cachePath, deps: next, refresh })).toBe("作業 Mac");
    expect(next.scutilComputerName).not.toHaveBeenCalled();
    await Promise.resolve();
    finish("新しい Mac");
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).name).toBe("新しい Mac"));
    expect(fs.readdirSync(path.dirname(cachePath))).toEqual(["host-display-name.json"]);
  });

  it("同じ表示名なら保存し直さず、裏の取得失敗でも保存名を残す", async () => {
    const cachePath = file(); put(cachePath, { format: 1, name: "同じ Mac" });
    fs.utimesSync(cachePath, 1, 1);
    for (const refresh of [async () => "同じ Mac", async () => { throw new Error("timeout"); }]) {
      expect(resolveCachedHostDisplayName({ cachePath, deps: deps(), refresh })).toBe("同じ Mac");
      await new Promise((resolve) => setImmediate(resolve));
      expect(fs.statSync(cachePath).mtimeMs).toBe(1_000);
    }
  });

  it.each(["broken", JSON.stringify({ format: 2, name: "old" }), JSON.stringify({ format: 1, name: " " }), "x".repeat(4097)])("壊れたキャッシュは同期解決で修復する", (data) => {
    const cachePath = file(); fs.mkdirSync(path.dirname(cachePath)); fs.writeFileSync(cachePath, data);
    const d = deps(); d.scutilComputerName.mockImplementation(() => { throw new Error("missing"); });
    expect(resolveCachedHostDisplayName({ cachePath, deps: d })).toBe("fallback");
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toEqual({ format: 1, name: "fallback" });
  });

  it("保存できなくても取得結果を hello に使える", () => {
    const parent = path.join(makeTempDir("display-fail"), "file"); fs.writeFileSync(parent, "file");
    expect(resolveCachedHostDisplayName({ cachePath: path.join(parent, "name"), deps: deps() })).toBe("作業 Mac");
  });

  it("既存の明示的な依存注入は同期解決・フォールバックのまま", () => {
    expect(resolveHostDisplayName(deps())).toBe("作業 Mac");
    const d = deps(); d.platform = "linux";
    expect(resolveHostDisplayName(d)).toBe("fallback");
    expect(d.scutilComputerName).not.toHaveBeenCalled();
  });
});
