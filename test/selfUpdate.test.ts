// selfUpdate.test.ts — host 自己更新の純関数と判定ロジック
//
// ネットワーク・シム swap の実 I/O は結合試験(実機)に委ね、ここでは
// semver 解決・整合性検証・インストール状態判定・失敗記録の閾値を固定する。

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cliPathFromShim,
  compareTriple,
  maxSatisfying,
  parseEnginesNodeMinimum,
  parseTriple,
  readRecentUpdateError,
  resolveInstallState,
  sriSha512,
  verifyTarball,
  writeLastUpdate,
} from "../src/commands/selfUpdate.js";
import { shimContent } from "../src/commands/doctor.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("semver 最小実装", () => {
  it("素の x.y.z のみ受理する（プレリリース・range は null）", () => {
    expect(parseTriple("1.2.3")).toEqual([1, 2, 3]);
    expect(parseTriple(" 0.4.0 ")).toEqual([0, 4, 0]);
    expect(parseTriple("1.2")).toBeNull();
    expect(parseTriple("1.2.3-beta.1")).toBeNull();
    expect(parseTriple("^1.2.3")).toBeNull();
  });

  it("トリプル比較が数値順（辞書順ではない）", () => {
    expect(compareTriple([0, 10, 0], [0, 9, 9])).toBe(1);
    expect(compareTriple([1, 0, 0], [0, 99, 99])).toBe(1);
    expect(compareTriple([0, 4, 0], [0, 4, 0])).toBe(0);
  });

  it("caret range: major 一致(major=0 は minor 一致)かつ base 以上の最大を選ぶ", () => {
    const versions = ["8.20.0", "8.21.1", "8.21.3", "9.0.0", "0.12.0", "0.12.1", "0.13.0"];
    expect(maxSatisfying(versions, "^8.21.1")).toBe("8.21.3");
    expect(maxSatisfying(versions, "^0.12.0")).toBe("0.12.1");
    expect(maxSatisfying(versions, "8.21.1")).toBe("8.21.1");
    expect(maxSatisfying(versions, "^7.0.0")).toBeNull();
    // 非対応 range は黙って別解釈せず null。
    expect(maxSatisfying(versions, ">=8.0.0")).toBeNull();
    expect(maxSatisfying(versions, "~8.21.0")).toBeNull();
  });

  it("engines.node は >= 形式だけ fast-fail 判定に使う", () => {
    expect(parseEnginesNodeMinimum(">=20")).toEqual([20, 0, 0]);
    expect(parseEnginesNodeMinimum(">=20.11")).toEqual([20, 11, 0]);
    expect(parseEnginesNodeMinimum(">= 22.0.0")).toEqual([22, 0, 0]);
    expect(parseEnginesNodeMinimum("^20.0.0")).toBeNull();
    expect(parseEnginesNodeMinimum(undefined)).toBeNull();
  });
});

describe("tarball 検証", () => {
  it("SRI sha512 が npm 形式で一致検証できる", () => {
    const data = Buffer.from("tailii");
    const sri = sriSha512(data);
    expect(sri.startsWith("sha512-")).toBe(true);
    expect(verifyTarball(data, { integrity: sri })).toMatchObject({ ok: true, detail: "sha512" });
    expect(verifyTarball(Buffer.from("tampered"), { integrity: sri }).ok).toBe(false);
  });

  it("integrity が無い旧パッケージは shasum(sha1) へフォールバックする", () => {
    const data = Buffer.from("legacy");
    const sha1 = "9b33046ed39d182e3adafa9045ad6787d4bbc321";
    expect(verifyTarball(data, { shasum: sha1 }).ok).toBe(true);
    expect(verifyTarball(data, {}).ok).toBe(false);
  });
});

describe("インストール状態の判定", () => {
  it("パッケージルートに src/ か .git があれば dev-install（published tarball は dist のみ）", () => {
    const root = tempDir("tailii-dev-");
    fs.mkdirSync(path.join(root, "dist"));
    fs.mkdirSync(path.join(root, "src"));
    const state = resolveInstallState(path.join(root, "dist", "cli.js"), tempDir("tailii-bin-"));
    expect(state).toEqual({ managed: false, reason: "dev-install" });
  });

  it("シム不在 → no-shim / マーカー無しシム → foreign-shim / マーカー有り → managed", () => {
    const root = tempDir("tailii-pkg-");
    fs.mkdirSync(path.join(root, "dist"));
    const cliPath = path.join(root, "dist", "cli.js");

    const emptyBin = tempDir("tailii-bin-");
    expect(resolveInstallState(cliPath, emptyBin)).toEqual({ managed: false, reason: "no-shim" });

    const foreignBin = tempDir("tailii-bin-");
    fs.writeFileSync(path.join(foreignBin, "tailii-host"), "#!/bin/sh\nexec node cli.js\n");
    expect(resolveInstallState(cliPath, foreignBin)).toEqual({ managed: false, reason: "foreign-shim" });

    const managedBin = tempDir("tailii-bin-");
    fs.writeFileSync(path.join(managedBin, "tailii-host"), shimContent("/usr/local/bin/node", cliPath));
    expect(resolveInstallState(cliPath, managedBin)).toEqual({ managed: true, reason: "ok" });
  });
});

describe("シム内容の解析", () => {
  it("シムから exec 先 cli パスを取り出せる（GC の保護対象決定）", () => {
    const content = shimContent("/opt/homebrew/bin/node", "/Users/alice/.tailii/host/versions/0.4.0/package/dist/cli.js");
    expect(cliPathFromShim(content)).toBe("/Users/alice/.tailii/host/versions/0.4.0/package/dist/cli.js");
    expect(cliPathFromShim("not a shim")).toBeNull();
  });
});

describe("失敗記録（channel_hello.updateError の供給源）", () => {
  it("直近 24h の失敗だけを返し、目標到達済み・成功記録・破損は無視する", () => {
    const file = path.join(tempDir("tailii-last-"), "last-update.json");

    writeLastUpdate({ target: "0.4.0", ok: false, error: "Node.js が不足しています", tsMs: Date.now() }, file);
    expect(readRecentUpdateError("0.3.0", file)).toBe("Node.js が不足しています");
    // 目標版に達していれば過去の失敗は出さない。
    expect(readRecentUpdateError("0.4.0", file)).toBeUndefined();

    writeLastUpdate({ target: "0.4.0", ok: false, error: "古い失敗", tsMs: Date.now() - 25 * 3600_000 }, file);
    expect(readRecentUpdateError("0.3.0", file)).toBeUndefined();

    writeLastUpdate({ target: "0.4.0", ok: true, tsMs: Date.now() }, file);
    expect(readRecentUpdateError("0.3.0", file)).toBeUndefined();

    fs.writeFileSync(file, "{broken json");
    expect(readRecentUpdateError("0.3.0", file)).toBeUndefined();
    expect(readRecentUpdateError("0.3.0", file + ".missing")).toBeUndefined();
  });
});
