import { Duplex } from "node:stream";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standbyFingerprint, waitForActivation } from "../src/commands/standby.js";

// fd 3 のプロトコル専用の入出力。Unix ソケット結合テストの代用ではない。
function control() {
  let output = "";
  const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { output += String(chunk); done(); } });
  return { stream, output: () => output };
}
afterEach(() => vi.useRealTimers());
describe("standby", () => {
  it("ACK を返して制御 fd を閉じてから 1 回だけ有効化する", async () => {
    const c = control();
    const activate = vi.fn(async (argv: string[]) => {
      expect(c.stream.destroyed).toBe(true);
      expect(c.output()).toBe('{"ok":true}\n');
      expect(argv).toEqual(["serve", "--session", "session-1"]);
      return 17;
    });
    const result = waitForActivation(c.stream, { fresh: () => true, activate });
    expect(activate).not.toHaveBeenCalled();
    c.stream.push('{"activate":{"argv":["serve",');
    c.stream.push('"--session","session-1"]}}\n{"activate":{"argv":["engine"]}}\n');
    expect(await result).toBe(17);
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it.each(['{"activate":{"argv":["hub"]}}', '{}', 'oops', '{"activate":{"argv":["engine",42]}}', '{"activate":{"argv":["engine","\\u0000"]}}'])("不正要求を断る: %s", async (line) => {
    const c = control(); const activate = vi.fn();
    const result = waitForActivation(c.stream, { fresh: () => true, activate });
    c.stream.push(line + "\n");
    expect(await result).toBe(1);
    expect(JSON.parse(c.output())).toEqual({ ok: false, reason: "bad_request" });
    expect(activate).not.toHaveBeenCalled();
  });
  it("更新された dist は stale で断る", async () => {
    const c = control(); const activate = vi.fn();
    const result = waitForActivation(c.stream, { fresh: () => false, activate });
    c.stream.push('{"activate":{"argv":["engine"]}}\n');
    expect(await result).toBe(0);
    expect(JSON.parse(c.output())).toEqual({ ok: false, reason: "stale" });
    expect(activate).not.toHaveBeenCalled();
  });
  it("EOF なら何も起動しない", async () => {
    const c = control(); const activate = vi.fn();
    const result = waitForActivation(c.stream, { fresh: () => true, activate });
    c.stream.push(null);
    expect(await result).toBe(0);
    expect(c.output()).toBe("");
    expect(activate).not.toHaveBeenCalled();
  });
  it("長時間待機後の定期検査で終了する", async () => {
    vi.useFakeTimers();
    const c = control(); let fresh = true;
    const result = waitForActivation(c.stream, { fresh: () => fresh, activate: vi.fn() });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(c.stream.destroyed).toBe(false);
    fresh = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBe(0);
    expect(c.output()).toBe("");
  });
  it("過大な要求を断る", async () => {
    const c = control();
    const result = waitForActivation(c.stream, { fresh: () => true, activate: vi.fn() });
    c.stream.push("x".repeat(8193));
    expect(await result).toBe(1);
    expect(JSON.parse(c.output()).reason).toBe("bad_request");
  });
  it("ACK の書き込み失敗では有効化しない", async () => {
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(new Error("EPIPE")); } });
    const activate = vi.fn();
    const result = waitForActivation(stream, { fresh: () => true, activate });
    stream.push('{"activate":{"argv":["engine"]}}\n');
    expect(await result).toBe(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(["error", "close"])("EOF を伴わない制御 fd の %s は失敗終了する", async (event) => {
    const c = control(); const activate = vi.fn();
    const result = waitForActivation(c.stream, { fresh: () => true, activate });
    if (event === "error") c.stream.destroy(new Error("ECONNRESET"));
    else c.stream.destroy();
    expect(await result).toBe(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it("指紋は mtime・サイズの変更と消失を検出する", () => {
    const directory = mkdtempSync(join(tmpdir(), "tsf-"));
    const file = join(directory, "cli.js");
    try {
      writeFileSync(file, "old");
      const old = standbyFingerprint(file);
      expect(old).not.toBeNull();
      utimesSync(file, 1, 1);
      const retimed = standbyFingerprint(file);
      expect(retimed).not.toBe(old);
      writeFileSync(file, "larger");
      utimesSync(file, 1, 1);
      expect(standbyFingerprint(file)).not.toBe(retimed);
      expect(standbyFingerprint(join(directory, "missing"))).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("有効化後の例外は通常 CLI のエラー処理へ返す", async () => {
    const c = control();
    const error = new Error("command failed");
    const result = waitForActivation(c.stream, { fresh: () => true, activate: async () => { throw error; } });
    const assertion = expect(result).rejects.toBe(error);
    c.stream.push('{"activate":{"argv":["engine"]}}\n');
    await assertion;
  });

});
