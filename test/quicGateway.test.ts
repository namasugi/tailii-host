// quicGateway.test.ts — QUIC ゲートウェイ運用面（解決 / 資格情報 / launchd）の単体テスト
//
// Rust バイナリ・実 launchctl には触れない（runner 注入）。実ワイヤーの検証は
// quic-gw/tests/interop.rs（Rust 統合テスト）と実機 E2E が担う。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectQuicInfo,
  computeSpkiPinFromCertPem,
  ensureQuicCredentials,
  installQuicLaunchAgent,
  isQuicGatewayLoaded,
  isQuicGatewayRunning,
  parseLaunchctlPrintState,
  quicGatewayServiceState,
  quicLaunchAgentPlist,
  readQuicCredentialsFromDisk,
  resolveQuicGatewayBinary,
  QUIC_GW_DEFAULT_PORT,
  QUIC_GW_LAUNCHD_LABEL,
} from "../src/services/quicGateway.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailii-${prefix}-`));
}

describe("resolveQuicGatewayBinary", () => {
  it("TAILII_QUIC_GW 環境変数が最優先（存在するパスのみ）", () => {
    const dir = tempDir("gw");
    const fake = path.join(dir, "tailii-quic-gw");
    fs.writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveQuicGatewayBinary({ TAILII_QUIC_GW: fake, PATH: "" })).toBe(fake);
    // 存在しないパスの明示指定は無視して次の解決先へ進む。
    const resolved = resolveQuicGatewayBinary({
      TAILII_QUIC_GW: path.join(dir, "missing"),
      PATH: "",
    });
    expect(resolved).not.toBe(path.join(dir, "missing"));
  });

  it("PATH から tailii-quic-gw を解決する（他の解決先が無い場合）", () => {
    const dir = tempDir("gwpath");
    const fake = path.join(dir, "tailii-quic-gw");
    fs.writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    const resolved = resolveQuicGatewayBinary({ PATH: dir });
    // PATH は最後の解決先なので、先に解決しうる経路（モノレポ開発機のローカル cargo ビルド /
    // 依存として導入済みの prebuilt パッケージ = CI）を許容する。どれも無い環境でのみ fake になる。
    const earlierSources = ["quic-gw/target/", "@tailii/quic-gw-darwin-"];
    expect(
      resolved === fake || earlierSources.some((marker) => (resolved ?? "").includes(marker)),
    ).toBe(true);
  });
});

describe("ensureQuicCredentials", () => {
  it("credentials --json の出力をパースして返す", async () => {
    const calls: string[][] = [];
    const creds = await ensureQuicCredentials("/fake/gw", "/tmp/quic", async (file, args) => {
      calls.push([file, ...args]);
      return `{"dir":"/tmp/quic","spkiPin":"PIN=","certPin":"CERT=","token":"TOKEN=","port":${QUIC_GW_DEFAULT_PORT}}\n`;
    });
    expect(creds.spkiPin).toBe("PIN=");
    expect(creds.token).toBe("TOKEN=");
    expect(creds.port).toBe(46853);
    expect(calls).toEqual([["/fake/gw", "credentials", "--json", "--dir", "/tmp/quic"]]);
  });

  it("不正な出力は明示エラーにする", async () => {
    await expect(
      ensureQuicCredentials("/fake/gw", "/tmp/quic", async () => `{"broken":true}`),
    ).rejects.toThrow(/出力が不正/);
  });
});

describe("quicLaunchAgentPlist", () => {
  const config = {
    gatewayPath: "/opt/gw/tailii-quic-gw",
    logPath: "/Users/alice/.tailii/quic-gw.log",
    credentialsDir: "/Users/alice/.tailii/quic",
    injectedPath: "/opt/homebrew/bin:/Users/alice/.local/bin:/usr/bin",
    home: "/Users/alice",
  };

  it("ラベル・serve 引数・KeepAlive・ログリダイレクトを含む", () => {
    const plist = quicLaunchAgentPlist(config);
    expect(plist).toContain(`<string>${QUIC_GW_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/gw/tailii-quic-gw</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/Users/alice/.tailii/quic-gw.log</string>");
  });

  it("HOME を EnvironmentVariables に明示する（GUI LaunchAgent は HOME 非継承の罠対策）", () => {
    const plist = quicLaunchAgentPlist(config);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/alice</string>");
  });

  it("--dir / --path を絶対パスで明示的に渡す（HOME 展開へ依存しない）", () => {
    const plist = quicLaunchAgentPlist(config);
    expect(plist).toContain("<string>--dir</string>");
    expect(plist).toContain("<string>/Users/alice/.tailii/quic</string>");
    expect(plist).toContain("<string>--path</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/Users/alice/.local/bin:/usr/bin</string>");
  });

  it("XML 特殊文字を含むパスをエスケープする", () => {
    const plist = quicLaunchAgentPlist({ ...config, home: "/Users/a&b" });
    expect(plist).toContain("<string>/Users/a&amp;b</string>");
    expect(plist).not.toContain("/Users/a&b<");
  });
});

/** 実機 `launchctl print gui/502/com.tailii.quic-gw` の抜粋（稼働中）。endpoint 配下に別の state 行が混ざる。 */
const PRINT_RUNNING = `gui/502/com.tailii.quic-gw = {
	active count = 3
	path = /Users/alice/Library/LaunchAgents/com.tailii.quic-gw.plist
	state = running

	program = /Users/alice/.tailii/bin/tailii-quic-gw
	runs = 1
	pid = 12796
	endpoints = {
		"com.tailii.quic-gw" = {
			state = active
		}
	}
}
`;

/** 同じく、on-demand-only モードで spawn が保留された状態（2026-09-18 実機障害の実出力）。 */
const PRINT_PENDED = `gui/502/com.tailii.quic-gw = {
	active count = 0
	path = /Users/alice/Library/LaunchAgents/com.tailii.quic-gw.plist
	state = not running

	program = /Users/alice/.tailii/bin/tailii-quic-gw
	runs = 0
	pended nondemand spawn = speculative
	last exit code = (never exited)
}
`;

describe("installQuicLaunchAgent", () => {
  it("バイナリを設置先へコピーし、plist はそのコピーを指す + bootout → bootstrap → kickstart → print", async () => {
    const dir = tempDir("launchd");
    const plistPath = path.join(dir, "com.tailii.quic-gw.plist");
    const installedBinary = path.join(dir, "installed", "tailii-quic-gw");
    const calls: string[][] = [];
    const installedFrom: string[] = [];
    const result = await installQuicLaunchAgent({
      gatewayPath: "/opt/gw/tailii-quic-gw",
      plistPath,
      logPath: "/tmp/quic-gw.log",
      uid: 501,
      // 実 ~/.tailii/bin を触らないよう注入（TCC コピーは実機検証で確認済み）。
      installBinary: (src) => {
        installedFrom.push(src);
        return installedBinary;
      },
      launchctl: async (args) => {
        calls.push(args);
        if (args[0] === "print") return PRINT_RUNNING;
      },
    });
    expect(fs.existsSync(plistPath)).toBe(true);
    const written = fs.readFileSync(plistPath, "utf8");
    expect(written).toContain("<string>serve</string>");
    // plist はソースではなく設置先バイナリを指す（TCC 保護フォルダ由来の dyld ストール回避）。
    expect(installedFrom).toEqual(["/opt/gw/tailii-quic-gw"]);
    expect(written).toContain(`<string>${installedBinary}</string>`);
    expect(written).not.toContain("<string>/opt/gw/tailii-quic-gw</string>");
    // 既定で HOME を EnvironmentVariables に入れる（GUI LaunchAgent の HOME 非継承対策）。
    expect(written).toContain("<key>HOME</key>");
    expect(written).toContain(`<string>${os.homedir()}</string>`);
    expect(calls).toEqual([
      ["bootout", "gui/501/com.tailii.quic-gw"],
      ["bootstrap", "gui/501", plistPath],
      ["kickstart", "gui/501/com.tailii.quic-gw"],
      ["print", "gui/501/com.tailii.quic-gw"],
    ]);
    expect(result).toEqual({ running: true, pid: 12796 });
  });

  it("bootout 失敗（未登録）は無視し、bootstrap 失敗時は load -w へフォールバックする（kickstart は同様に打つ）", async () => {
    const dir = tempDir("launchd2");
    const plistPath = path.join(dir, "com.tailii.quic-gw.plist");
    const calls: string[][] = [];
    const result = await installQuicLaunchAgent({
      gatewayPath: "/opt/gw/tailii-quic-gw",
      plistPath,
      logPath: "/tmp/quic-gw.log",
      uid: 501,
      installBinary: (src) => src,
      launchctl: async (args) => {
        calls.push(args);
        if (args[0] === "bootout" || args[0] === "bootstrap") {
          throw new Error("simulated failure");
        }
      },
    });
    expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap", "load", "kickstart", "print"]);
    expect(calls[2]).toEqual(["load", "-w", plistPath]);
    // stdout を返さない実行子は稼働不明 = 未起動側に倒す（呼び出し側が警告を出せる）。
    expect(result).toEqual({ running: false, pid: null });
  });

  it("on-demand-only モードで保留された自動起動を kickstart で起こす（2026-09-18 実機障害の再現）", async () => {
    // setup 再実行 = 稼働中 gw を bootout → bootstrap。ドメインが on-demand-only だと
    // RunAtLoad/KeepAlive の spawn は保留され print は `state = not running / runs = 0`。
    // kickstart（demand 起動）だけが保留を突き抜ける。
    const dir = tempDir("launchd3");
    const plistPath = path.join(dir, "com.tailii.quic-gw.plist");
    const calls: string[][] = [];
    let spawned = false;
    const result = await installQuicLaunchAgent({
      gatewayPath: "/opt/gw/tailii-quic-gw",
      plistPath,
      logPath: "/tmp/quic-gw.log",
      uid: 502,
      installBinary: (src) => src,
      launchctl: async (args) => {
        calls.push(args);
        if (args[0] === "kickstart") spawned = true;
        if (args[0] === "print") return spawned ? PRINT_RUNNING : PRINT_PENDED;
      },
    });
    expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap", "kickstart", "print"]);
    expect(calls[2]).toEqual(["kickstart", "gui/502/com.tailii.quic-gw"]);
    expect(result).toEqual({ running: true, pid: 12796 });
  });

  it("kickstart 失敗は握りつぶし、print が報告する未起動をそのまま返す（throw しない）", async () => {
    const dir = tempDir("launchd4");
    const plistPath = path.join(dir, "com.tailii.quic-gw.plist");
    const result = await installQuicLaunchAgent({
      gatewayPath: "/opt/gw/tailii-quic-gw",
      plistPath,
      logPath: "/tmp/quic-gw.log",
      uid: 501,
      installBinary: (src) => src,
      launchctl: async (args) => {
        if (args[0] === "kickstart") throw new Error("Could not find service");
        if (args[0] === "print") return PRINT_PENDED;
      },
    });
    expect(result).toEqual({ running: false, pid: null });
  });
});

/** 起動はしたが終了した状態（KeepAlive の再起動待ち・クラッシュ）。保留とは runs / last exit code で区別する。 */
const PRINT_EXITED = `gui/502/com.tailii.quic-gw = {
	active count = 0
	path = /Users/alice/Library/LaunchAgents/com.tailii.quic-gw.plist
	state = not running

	program = /Users/alice/.tailii/bin/tailii-quic-gw
	runs = 3
	last exit code = 1
}
`;

describe("parseLaunchctlPrintState / quicGatewayServiceState", () => {
  it("稼働中の print から running / pid / runs を読む（endpoint 配下の state = active に惑わされない）", () => {
    expect(parseLaunchctlPrintState(PRINT_RUNNING)).toEqual({
      running: true,
      pid: 12796,
      runs: 1,
      lastExitCode: null,
    });
  });

  it("保留中の print（state = not running / runs = 0 / never exited）は未起動・終了コード無し", () => {
    expect(parseLaunchctlPrintState(PRINT_PENDED)).toEqual({
      running: false,
      pid: null,
      runs: 0,
      lastExitCode: null,
    });
  });

  it("起動後に終了した print は runs と last exit code を読む", () => {
    expect(parseLaunchctlPrintState(PRINT_EXITED)).toEqual({
      running: false,
      pid: null,
      runs: 3,
      lastExitCode: 1,
    });
  });

  it("print 成功 + 未起動 → loaded だが running ではない（isQuicGatewayRunning は false）", async () => {
    const runner = async (): Promise<string> => PRINT_PENDED;
    expect(await quicGatewayServiceState(502, runner)).toEqual({
      loaded: true,
      running: false,
      pid: null,
      runs: 0,
      lastExitCode: null,
    });
    expect(await isQuicGatewayLoaded(502, runner)).toBe(true);
    expect(await isQuicGatewayRunning(502, runner)).toBe(false);
  });

  it("stdout を返さない実行子は「登録済み・稼働不明」= 未起動側（旧テストの互換）", async () => {
    expect(await quicGatewayServiceState(502, async () => {})).toEqual({
      loaded: true,
      running: false,
      pid: null,
      runs: null,
      lastExitCode: null,
    });
  });

  it("print 失敗 → 未登録", async () => {
    const runner = async (): Promise<string> => {
      throw new Error("Could not find service");
    };
    expect(await quicGatewayServiceState(502, runner)).toEqual({ loaded: false });
    expect(await isQuicGatewayRunning(502, runner)).toBe(false);
  });

  it("稼働中 → isQuicGatewayRunning は true", async () => {
    expect(await isQuicGatewayRunning(502, async () => PRINT_RUNNING)).toBe(true);
  });
});

describe("installQuicGatewayBinary", () => {
  it("バイナリを設置先へコピーし実行ビットを立てる・冪等", async () => {
    const { installQuicGatewayBinary, quicGatewayInstalledBinaryPath } = await import(
      "../src/services/quicGateway.js"
    );
    // 実 HOME を汚さないよう一時 HOME を差す。
    const fakeHome = tempDir("home");
    const origHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    try {
      const src = path.join(tempDir("src"), "tailii-quic-gw");
      fs.writeFileSync(src, "#!/bin/sh\necho gw\n");
      const dest = installQuicGatewayBinary(src);
      expect(dest).toBe(quicGatewayInstalledBinaryPath());
      expect(dest.startsWith(fakeHome)).toBe(true);
      expect(fs.readFileSync(dest, "utf8")).toContain("echo gw");
      expect(fs.statSync(dest).mode & 0o111).not.toBe(0);
      // 冪等: 同一内容で再実行しても壊れない。
      expect(installQuicGatewayBinary(src)).toBe(dest);
    } finally {
      if (origHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = origHome;
    }
  });
});

// MARK: - quic-info（SSH ブートストラップ）

/**
 * `tailii-quic-gw credentials` が生成した実 P-256 自己署名証明書のフィクスチャ。
 * 期待ピンは Rust 側 `credentials --json` の spkiPin 出力（= rcgen public_key_der の
 * SHA-256）。Node の X509Certificate 経由の計算が Rust と byte 一致することを固定する。
 */
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBXDCCAQGgAwIBAgIUZsKB/Hk3gJn3SOM+sqvtkG6gCYowCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWcmNnZW4gc2VsZiBzaWduZWQgY2VydDAgFw03NTAxMDEwMDAw
MDBaGA80MDk2MDEwMTAwMDAwMFowITEfMB0GA1UEAwwWcmNnZW4gc2VsZiBzaWdu
ZWQgY2VydDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMC9/O7/ByU3UDhW9+DE
xOkB2dIhqtKWS2vifSCvfrncd3eBJtZYVrlV/Viwy+cNYm5XlnPzlbSHVMA9RSmI
kcajFTATMBEGA1UdEQQKMAiCBnRhaWxpaTAKBggqhkjOPQQDAgNJADBGAiEAgPcK
IoKDNcf1gVlVz+WsWWmbh25IYvcG+GTxGHtyDKECIQC81J5bXOihPbgpXIEiIjNb
CrG1QWmek0k7NbbFhSjMoQ==
-----END CERTIFICATE-----
`;
const FIXTURE_SPKI_PIN = "HCn3dm3Rk0IHyxORdi4KK+QZLmdL+C1s/4nc6MksH9U=";

describe("computeSpkiPinFromCertPem", () => {
  it("Rust 側 credentials --json の spkiPin と一致する（パリティ固定）", () => {
    expect(computeSpkiPinFromCertPem(FIXTURE_CERT_PEM)).toBe(FIXTURE_SPKI_PIN);
  });
});

describe("readQuicCredentialsFromDisk / collectQuicInfo", () => {
  function writeFixtureCreds(dir: string, token = "VG9rZW4tZml4dHVyZQ=="): void {
    fs.writeFileSync(path.join(dir, "cert.pem"), FIXTURE_CERT_PEM);
    fs.writeFileSync(path.join(dir, "token"), token + "\n");
  }

  it("cert.pem/token からピンとトークンを読む", () => {
    const dir = tempDir("creds");
    writeFixtureCreds(dir);
    const creds = readQuicCredentialsFromDisk(dir);
    expect(creds).toEqual({ pin: FIXTURE_SPKI_PIN, token: "VG9rZW4tZml4dHVyZQ==" });
  });

  it("資格情報が無ければ null（quic-info は available:false）", async () => {
    const dir = tempDir("nocreds");
    expect(readQuicCredentialsFromDisk(dir)).toBeNull();
    const info = await collectQuicInfo({ dir, isRunning: async () => true });
    expect(info).toEqual({ available: false, reason: "credentials-missing" });
  });

  it("稼働していなければ配らない（クライアントの 1.5s 接続試行税を防ぐ。登録済みでも保留中は含む）", async () => {
    const dir = tempDir("notloaded");
    writeFixtureCreds(dir);
    const info = await collectQuicInfo({ dir, isRunning: async () => false });
    expect(info).toEqual({ available: false, reason: "gateway-not-running" });
  });

  it("資格情報あり + 稼働中なら port/pin/token を返す", async () => {
    const dir = tempDir("ok");
    writeFixtureCreds(dir);
    const info = await collectQuicInfo({ dir, isRunning: async () => true });
    expect(info).toEqual({
      available: true,
      port: QUIC_GW_DEFAULT_PORT,
      pin: FIXTURE_SPKI_PIN,
      token: "VG9rZW4tZml4dHVyZQ==",
    });
  });
});

describe("isQuicGatewayLoaded", () => {
  it("launchctl print が成功すれば true・失敗すれば false", async () => {
    expect(await isQuicGatewayLoaded(501, async () => {})).toBe(true);
    expect(
      await isQuicGatewayLoaded(501, async () => {
        throw new Error("not loaded");
      }),
    ).toBe(false);
  });
});
