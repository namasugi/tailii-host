// socketPath.test.ts — SocketPath 単体テスト（Swift 版 SocketPathTests の移植）
//
// 検証項目:
//   1. 同一 session 名 → 同一パス（決定性）
//   2. デフォルトベースは ~/.tailii/run/<session>.sock
//   3. 親ディレクトリが 0700 で作成される
//   4. 安全でない session 名（スラッシュ・ドット系・空文字・null バイト）は拒否される

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { SocketPathError, resolveSocketPath } from "../src/socketPath.js";

function makeTempBase(): string {
  return path.join(os.tmpdir(), "tailii-socketpath-tests", randomUUID());
}

describe("SocketPath", () => {
  it("同一 session 名から同一パスが導出される", () => {
    const base = makeTempBase();
    expect(resolveSocketPath("mysession", base)).toBe(resolveSocketPath("mysession", base));
  });

  it("異なる session 名は異なるパスを返す", () => {
    const base = makeTempBase();
    expect(resolveSocketPath("session-a", base)).not.toBe(resolveSocketPath("session-b", base));
  });

  it("パスが <base>/<session>.sock の形式になる", () => {
    const base = makeTempBase();
    expect(resolveSocketPath("mysession", base)).toBe(path.join(base, "mysession.sock"));
  });

  it("デフォルトベースが ~/.tailii/run になる", () => {
    const resolved = resolveSocketPath("mysession");
    expect(resolved.startsWith(path.join(os.homedir(), ".tailii", "run") + "/")).toBe(true);
    expect(resolved.endsWith("mysession.sock")).toBe(true);
  });

  it("親ディレクトリが 0700 で作成される", () => {
    const base = makeTempBase();
    resolveSocketPath("dirsession", base);
    const stat = fs.statSync(base);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("既存ディレクトリがあっても成功する（冪等）", () => {
    const base = makeTempBase();
    resolveSocketPath("s", base);
    expect(resolveSocketPath("s", base).length).toBeGreaterThan(0);
  });

  it.each([
    ["スラッシュ", "a/b"],
    ["ドットドット + スラッシュ", "../evil"],
    ["空文字", ""],
    ["ドット単体", "."],
    ["ドットドット単体", ".."],
    ["null バイト", "ses\0sion"],
  ])("安全でない session 名（%s）はエラーになる", (_label, session) => {
    expect(() => resolveSocketPath(session, makeTempBase())).toThrow(SocketPathError);
  });

  it("英数字とハイフン・アンダースコアの session 名は受け入れられる", () => {
    const base = makeTempBase();
    for (const name of ["mysession", "session-1", "my_session", "abc123", "Session"]) {
      expect(resolveSocketPath(name, base).endsWith(`${name}.sock`)).toBe(true);
    }
  });
});
