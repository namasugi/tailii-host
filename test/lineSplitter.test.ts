// lineSplitter.test.ts — NDJSON 行の区切り

import { describe, expect, test } from "vitest";
import { NdjsonLineSplitter } from "../src/shared/lineSplitter.js";

function collect(chunks: string[]): { lines: string[]; pending: number } {
  const splitter = new NdjsonLineSplitter();
  const lines: string[] = [];
  for (const chunk of chunks) splitter.push(Buffer.from(chunk, "utf8"), (line) => lines.push(line.toString("utf8")));
  return { lines, pending: splitter.pendingBytes };
}

describe("NdjsonLineSplitter", () => {
  test("1 chunk 内の複数行と、chunk をまたぐ行を順に区切る", () => {
    expect(collect(['{"a":1}\n{"b"', ':2}\n{"c":3}\n'])).toEqual({
      lines: ['{"a":1}', '{"b":2}', '{"c":3}'], pending: 0,
    });
  });

  test("改行の無い末尾は改行が届くまで保持する", () => {
    expect(collect(['{"a":1}\n{"b":'])).toEqual({ lines: ['{"a":1}'], pending: 5 });
  });

  test("多数の小さな chunk に分かれた長い行（マルチバイト含む）を 1 行に戻す", () => {
    const line = JSON.stringify({ text: "長".repeat(50_000) });
    const bytes = Buffer.from(line + "\n", "utf8");
    const splitter = new NdjsonLineSplitter();
    const lines: string[] = [];
    // macOS の Unix socket 相当の 8KB 単位（マルチバイト文字の途中でも切る）。
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
      splitter.push(bytes.subarray(offset, offset + 8_192), (out) => lines.push(out.toString("utf8")));
    }
    expect(lines).toEqual([line]);
    expect(splitter.pendingBytes).toBe(0);
  });

  test("空行もそのまま渡す（呼び出し側の不正行破棄に任せる）", () => {
    expect(collect(["\n\n{}\n"]).lines).toEqual(["", "", "{}"]);
  });
});
