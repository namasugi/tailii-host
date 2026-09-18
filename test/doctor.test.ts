// doctor.test.ts — ホストシム生成と環境検査
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkTcpPort,
  ensureHostShim,
  findCommand,
  formatDoctorChecks,
  herdrRemediation,
  parseNumericVersion,
  probeVersion,
  quicServiceDoctorCheck,
  shimContent,
  sshServerRemediation,
  tmuxInstallRemediation,
  versionAtLeast,
  versionCompatibility,
} from "../src/commands/doctor.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailii-${prefix}-`));
}

describe("ensureHostShim", () => {
  it("シムを新規生成する(実行可能・node/cli 絶対パス固定)", () => {
    const bin = tempDir("shim");
    const result = ensureHostShim(bin, "/opt/node/bin/node", "/srv/host/dist/cli.js");
    expect(result).toBe("created");

    const shimPath = path.join(bin, "tailii-host");
    const body = fs.readFileSync(shimPath, "utf8");
    expect(body).toBe(shimContent("/opt/node/bin/node", "/srv/host/dist/cli.js"));
    expect(body).toContain('exec "/opt/node/bin/node" "/srv/host/dist/cli.js" "$@"');
    expect(fs.statSync(shimPath).mode & 0o111).not.toBe(0);
  });

  it("同一内容なら unchanged(冪等)", () => {
    const bin = tempDir("shim");
    ensureHostShim(bin, "/opt/node/bin/node", "/srv/cli.js");
    expect(ensureHostShim(bin, "/opt/node/bin/node", "/srv/cli.js")).toBe("unchanged");
  });

  it("node/cli パスが変われば updated で上書きする", () => {
    const bin = tempDir("shim");
    ensureHostShim(bin, "/opt/node18/bin/node", "/srv/cli.js");
    expect(ensureHostShim(bin, "/opt/node20/bin/node", "/srv/cli.js")).toBe("updated");
    expect(fs.readFileSync(path.join(bin, "tailii-host"), "utf8")).toContain("node20");
  });

  it("マーカーの無い手動ファイルは上書きしない", () => {
    const bin = tempDir("shim");
    const shimPath = path.join(bin, "tailii-host");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(shimPath, "#!/bin/sh\n# my custom launcher\nexec /custom/host \"$@\"\n");
    expect(ensureHostShim(bin, "/opt/node/bin/node", "/srv/cli.js")).toBe("skipped-foreign");
    expect(fs.readFileSync(shimPath, "utf8")).toContain("my custom launcher");
  });
});

describe("findCommand", () => {
  it("PATH 内の実行可能ファイルを見つける", () => {
    const dir = tempDir("path");
    const tool = path.join(dir, "sometool");
    fs.writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
    expect(findCommand("sometool", `/nonexistent:${dir}`)).toBe(tool);
  });

  it("見つからなければ null", () => {
    expect(findCommand("no-such-tool-xyz", tempDir("empty"))).toBeNull();
  });

  it("実行ビットの無いファイルは対象外", () => {
    const dir = tempDir("noexec");
    fs.writeFileSync(path.join(dir, "plainfile"), "data", { mode: 0o644 });
    expect(findCommand("plainfile", dir)).toBeNull();
  });
});

describe("診断バージョン判定", () => {
  it("CLI の飾りを無視して数値版を比較する", () => {
    expect(parseNumericVersion("codex-cli 0.145.0")).toEqual([0, 145, 0]);
    expect(versionAtLeast("2.1.220 (Claude Code)", "2.1.215")).toBe(true);
    expect(versionAtLeast("0.144.4", "0.144.5")).toBe(false);
    expect(versionAtLeast("3.7", "3.7.0")).toBe(true);
    expect(versionAtLeast("unknown", "1.0.0")).toBeNull();
  });

  it("解析できないバージョンを互換扱いしない", () => {
    expect(versionCompatibility("/bin/tool", "development build", "1.0.0")).toBe("unknown");
    expect(versionCompatibility("/bin/tool", null, "1.0.0")).toBe("unknown");
    expect(versionCompatibility("/bin/tool", "0.9.9", "1.0.0")).toBe("outdated");
    expect(versionCompatibility("/bin/tool", "1.0.0", "1.0.0")).toBe("compatible");
    expect(versionCompatibility(null, null, "1.0.0")).toBe("missing");
  });

  it("env node シバンへ診断用 PATH を引き継ぐ", async () => {
    const dir = tempDir("probe-path");
    const runtimeName = "tailii-test-node-runtime";
    fs.symlinkSync(process.execPath, path.join(dir, runtimeName));
    const tool = path.join(dir, "version-tool");
    fs.writeFileSync(
      tool,
      `#!/usr/bin/env ${runtimeName}\nprocess.stdout.write("version-tool 1.2.3\\n");\n`,
      { mode: 0o755 },
    );
    await expect(probeVersion(tool, ["--version"], dir)).resolves.toBe("version-tool 1.2.3");
  });

  it("ホストOSと利用可能なパッケージマネージャーに合う手順を返す", () => {
    const aptPath = tempDir("apt-path");
    fs.writeFileSync(path.join(aptPath, "apt-get"), "#!/bin/sh\n", { mode: 0o755 });
    expect(tmuxInstallRemediation(aptPath)).toBe("sudo apt-get install -y tmux");
    expect(sshServerRemediation(aptPath, "linux")).toContain("openssh-server");
    expect(sshServerRemediation(aptPath, "darwin")).toContain("リモートログイン");
  });

  it("herdr の導入方式に合う更新手順を返す", () => {
    expect(herdrRemediation(null)).toContain("herdr.dev/install.sh");
    expect(herdrRemediation("/opt/homebrew/bin/herdr")).toBe("brew upgrade herdr");
    expect(herdrRemediation("/nix/store/abc-herdr/bin/herdr")).toContain("Nix");
    expect(herdrRemediation("/home/alice/.local/bin/herdr")).toBe("herdr update");
  });

  it("対処を診断本文と別行に出す", () => {
    expect(formatDoctorChecks([{
      id: "tmux",
      label: "tmux",
      ok: false,
      required: true,
      detail: "見つかりません",
      remediation: "brew install tmux",
    }])).toBe("  ✗ tmux : 見つかりません\n      対処: brew install tmux");
  });
});

describe("checkTcpPort", () => {
  it("待受中のポートに true", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await expect(checkTcpPort("127.0.0.1", port)).resolves.toBe(true);
    server.close();
  });

  it("閉じたポートに false", async () => {
    // エフェメラルポートを一瞬だけ確保して閉じ、確実に閉じているポートを得る。
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(checkTcpPort("127.0.0.1", port)).resolves.toBe(false);
  });
});

describe("quicServiceDoctorCheck", () => {
  it("未登録 → 未常駐・tailii setup", () => {
    const check = quicServiceDoctorCheck({ loaded: false });
    expect(check.ok).toBe(false);
    expect(check.required).toBe(false);
    expect(check.detail).toBe("未常駐");
    expect(check.remediation).toBe("tailii setup");
  });

  it("登録済みだが一度も起動していない（runs = 0 = launchd が保留）→ 稼働中と区別し kickstart を案内する", () => {
    const check = quicServiceDoctorCheck({ loaded: true, running: false, pid: null, runs: 0, lastExitCode: null });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("一度も起動していない");
    expect(check.remediation).toBe("launchctl kickstart gui/$(id -u)/com.tailii.quic-gw");
  });

  it("起動したが終了した（runs > 0）→ 保留と区別し、終了コードとログ確認を案内する", () => {
    const check = quicServiceDoctorCheck({ loaded: true, running: false, pid: null, runs: 3, lastExitCode: 1 });
    expect(check.ok).toBe(false);
    expect(check.detail).toBe("com.tailii.quic-gw は登録済みだが停止中（起動 3 回、直近の終了コード 1）");
    expect(check.remediation).toBe("tail -n 50 ~/.tailii/quic-gw.log");
  });

  it("runs が読めない停止中は保留と断定せずログ確認へ", () => {
    const check = quicServiceDoctorCheck({ loaded: true, running: false, pid: null, runs: null, lastExitCode: null });
    expect(check.ok).toBe(false);
    expect(check.detail).toBe("com.tailii.quic-gw は登録済みだが停止中（起動 ? 回）");
    expect(check.remediation).toBe("tail -n 50 ~/.tailii/quic-gw.log");
  });

  it("稼働中 → ok・pid を添える", () => {
    const check = quicServiceDoctorCheck({ loaded: true, running: true, pid: 12796, runs: 1, lastExitCode: null });
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("com.tailii.quic-gw 稼働中 (pid 12796)");
    expect(check.remediation).toBeUndefined();
  });
});
