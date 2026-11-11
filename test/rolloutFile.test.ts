import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, test } from "vitest";
import { readRolloutHead } from "../src/codex/rolloutFile.js";
import { makeTempDir } from "./helpers.js";

const require = createRequire(import.meta.url);
const zlib = require("node:zlib") as typeof import("node:zlib");

/** zstd は Node 22.15 / 23.8 以降。対応下限の Node 20 では製品も圧縮ファイルを扱わないので飛ばす。 */
const ZSTD_AVAILABLE = typeof zlib.zstdCompressSync === "function";

describe.skipIf(!ZSTD_AVAILABLE)("readRolloutHead（圧縮 rollout の先頭読み）", () => {
  const original = zlib.zstdDecompressSync;

  afterEach(() => {
    zlib.zstdDecompressSync = original;
    syncBuiltinESMExports();
  });

  /** 先頭に session_meta、続けて同じ文字が数 MB 続く（圧縮が極端に効く）rollout を圧縮して書く。 */
  function writeCompressed(): { file: string; size: number } {
    const dir = makeTempDir("rollout-head");
    const file = path.join(dir, "rollout-2026-11-11T00-00-00-x.jsonl.zst");
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/work" } });
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${meta}\n${"y".repeat(3_000_000)}\n`)));
    return { file, size: fs.statSync(file).size };
  }

  /**
   * 切れた入力の扱いを差し替える。読み取り処理は同期で回るので、往復し続けるとテストの
   * タイムアウトでも止められない。呼び出し回数の上限で失敗させる。
   */
  function stubDecompress(size: number, partialOk: (opts: unknown) => boolean): { calls: () => number } {
    let calls = 0;
    zlib.zstdDecompressSync = ((buf: Buffer, opts?: Parameters<typeof original>[1]) => {
      calls += 1;
      if (calls > 1000) throw new Error("解凍を 1000 回呼んでも終わらない");
      if (buf.length < size && !partialOk(opts)) {
        throw Object.assign(new Error("unexpected end of file"), { code: "Z_BUF_ERROR" });
      }
      return original(buf, opts);
    }) as typeof original;
    syncBuiltinESMExports();
    return { calls: () => calls };
  }

  test("切れた入力を既定で一律エラーにする Node（24.22 以降）でも、先頭を返す", () => {
    const { file, size } = writeCompressed();
    // 24.22 の既定を再現: finishFlush に ZSTD_e_flush を渡したときだけ、解けた分を返す。
    stubDecompress(size, (opts) => (opts as { finishFlush?: number } | undefined)?.finishFlush === zlib.constants.ZSTD_e_flush);
    const head = readRolloutHead(file, 64 * 1024).toString("utf8");
    expect(head.startsWith('{"type":"session_meta"')).toBe(true);
  });

  test("途中まででは一切解けない解凍でも、往復し続けずに返す", () => {
    const { file, size } = writeCompressed();
    const stub = stubDecompress(size, () => false);
    const head = readRolloutHead(file, 64 * 1024);
    // 全体は出力上限を超え、途中までは解けない → 先頭は取れないが、止まらずに返る。
    expect(head.length).toBe(0);
    expect(stub.calls()).toBeLessThan(300);
  });
});
