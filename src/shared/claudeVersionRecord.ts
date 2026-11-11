// claudeVersionRecord.ts
// tailii (TS host) — host が起動した Claude Code の版（transcript で観測した最新の値）
//
// Claude Code は transcript の各行に書いた本体の版を `"version":"2.1.322"` として残す。hub は host が起動した
// 会話のターンの終わり（Stop / StopFailure）に transcript の末尾からそれを読み、変わったときだけ
// `~/.tailii/host/claude-version.json` に保存する（書き手は hub だけ）。launch は読むだけ（同期の読み込み 1 回）で、
// hook の登録の出し分け（StopFailure は 2.1.319 以上）に使う。`claude --version` は実行しない（shim・ラッパーで
// 別の版を拾う・起動を遅くするため）。ダウングレードも最新の観測に従う。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";

/**
 * 受け付ける版の形（数値 3 要素 + 任意の接尾辞 `-beta` / `+build` 等）。比較は `versionAtLeast` で数値 3 要素だけを
 * 見る（接尾辞は無視）。観測・保存・比較で同じ解釈を使う。
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,64})?$/u;

export function defaultClaudeVersionRecordPath(): string {
  return path.join(os.homedir(), ".tailii", "host", "claude-version.json");
}

/** 記録された版（未観測・読めないときは null）。 */
export function readObservedClaudeVersion(file: string = defaultClaudeVersionRecordPath()): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const version = parsed["version"];
    return typeof version === "string" && VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** 観測した版を保存する（hub だけが使う）。記録と同じ値なら書かない（記録が読めなければ書き直す）。 */
export class ClaudeVersionRecorder {
  constructor(private readonly file: string = defaultClaudeVersionRecordPath()) {}

  observe(version: string, observedAtMs: number = Date.now()): void {
    if (!VERSION_PATTERN.test(version)) return;
    // ターンの終わりに 1 回の小さな読み込み。メモリに覚えないので、起動後に壊された・消された記録も直る。
    if (readObservedClaudeVersion(this.file) === version) return;
    try {
      ensureDirectory0700(path.dirname(this.file));
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version, observedAt: Math.floor(observedAtMs / 1000) }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // 記録できなくても会話は続く（次の観測で書き直す）。
    }
  }
}

/** transcript の末尾（tailBytes）から、最後に書かれた行の `version` を返す。見つからなければ null。 */
export function findTrailingClaudeVersion(transcriptPath: string, tailBytes = 64 * 1024): string | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (!line.includes('"version"')) continue;
      try {
        const version = (JSON.parse(line) as Record<string, unknown>)["version"];
        if (typeof version === "string" && VERSION_PATTERN.test(version)) return version;
      } catch {
        // 途中から読んだ先頭の欠け行など。
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* 二重 close は無視。 */ }
  }
}
