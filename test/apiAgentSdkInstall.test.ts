// apiAgentSdkInstall.test.ts — Agent SDK の導入（setup・自己更新の後・アプリからの準備・手動）。npm は差し替え、実取得はしない。

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentSdkPreparer,
  OFFICIAL_REGISTRY,
  SDK_INSTALL_MESSAGES,
  acquireInstallLock,
  alignInstalledSdkAfterUpdate,
  installAgentSdkAtomic,
  matchingSdkVersionCandidate,
  npmEnvironment,
  resolveSdkVersion,
  type CommandRunner,
} from "../src/apiAgent/sdkInstaller.js";
import { runApiAgentSetupStep, shouldSkipApiAgentSetup } from "../src/apiAgent/setupStep.js";
import { uninstallAgentSdk } from "../src/commands/apiAgentCommand.js";
import { prepareResponse } from "../src/engine/handlers/apiAgentHandoff.js";
import type { AgentSdkStatus } from "../src/apiAgent/sdkStatus.js";
import { makeTempDir } from "./helpers.js";

const PKG = "@anthropic-ai/claude-agent-sdk";

/** npm の偽物: view は表から答え、install は prefix に SDK らしいファイルを置く。 */
function fakeNpm(options: {
  views?: Record<string, { version?: string; claudeCodeVersion?: string } | "E404" | "ENOTFOUND">;
  install?: "ok" | "ENOTFOUND" | "ENOSPC" | "wrong-version" | "no-entry";
}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "view") {
      const spec = args[1]!.slice(PKG.length + 1);
      const answer = options.views?.[spec] ?? "E404";
      if (answer === "E404") return { code: 1, stdout: "", stderr: "npm error code E404" };
      if (answer === "ENOTFOUND") return { code: 1, stdout: "", stderr: "npm error getaddrinfo ENOTFOUND registry.npmjs.org" };
      return { code: 0, stdout: JSON.stringify(answer), stderr: "" };
    }
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const version = args.at(-1)!.slice(PKG.length + 1);
    switch (options.install ?? "ok") {
      case "ENOTFOUND": return { code: 1, stdout: "", stderr: "npm error network ENOTFOUND" };
      case "ENOSPC": return { code: 1, stdout: "", stderr: "npm error nospc ENOSPC: no space left on device" };
      default: {
        const dir = path.join(prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
          name: PKG, version: options.install === "wrong-version" ? "9.9.9" : version, main: "sdk.mjs", claudeCodeVersion: "2.1.322",
        }));
        if (options.install !== "no-entry") fs.writeFileSync(path.join(dir, "sdk.mjs"), "export function query() {}\n");
        return { code: 0, stdout: "", stderr: "" };
      }
    }
  };
  return { runner, calls };
}

function sdkDir(): string {
  return path.join(makeTempDir("sdk-install"), "api-agent", "sdk");
}

describe("版の解決（固定）", () => {
  test("claude 2.1.N に合う 0.3.N があれば、その claudeCodeVersion を確かめて使う", async () => {
    const npm = fakeNpm({ views: { "0.3.322": { version: "0.3.322", claudeCodeVersion: "2.1.322" } } });
    expect(await resolveSdkVersion({ runner: npm.runner, npm: "/n", claudeVersion: "2.1.322", env: {} })).toEqual({ ok: true, version: "0.3.322" });
    expect(npm.calls[0]).toEqual(["view", `${PKG}@0.3.322`, "version", "claudeCodeVersion", "--json", `--registry=${OFFICIAL_REGISTRY}`]);
  });

  test("合う版が無ければ最新の版（claude がそれ以上なら）。最新が新しい claude を要るなら claude_update_required", async () => {
    const ok = fakeNpm({ views: { latest: { version: "0.3.330", claudeCodeVersion: "2.1.320" } } });
    expect(await resolveSdkVersion({ runner: ok.runner, npm: "/n", claudeVersion: "2.1.325", env: {} })).toEqual({ ok: true, version: "0.3.330" });
    const old = fakeNpm({ views: { latest: { version: "0.3.330", claudeCodeVersion: "2.1.330" } } });
    expect(await resolveSdkVersion({ runner: old.runner, npm: "/n", claudeVersion: "2.1.300", env: {} }))
      .toMatchObject({ ok: false, error: "claude_update_required" });
    const offline = fakeNpm({ views: { latest: "ENOTFOUND" } });
    expect(await resolveSdkVersion({ runner: offline.runner, npm: "/n", claudeVersion: "2.1.300", env: {} }))
      .toMatchObject({ ok: false, error: "registry_failed" });
    expect(matchingSdkVersionCandidate("3.0.0")).toBeNull();
  });

  test("npm を走らせる env は host の node の場所を PATH の先頭に足す（狭い PATH でも npm が node を見つける）", () => {
    const env = npmEnvironment({ PATH: "/usr/bin" }, "/opt/node/bin/node");
    expect(env["PATH"]!.split(":")[0]).toBe("/opt/node/bin");
    expect(env["PATH"]).toContain("/usr/bin");
  });
});

describe("導入（一時フォルダ → 確かめる → 置き換え）", () => {
  const views = { "0.3.322": { version: "0.3.322", claudeCodeVersion: "2.1.322" } };

  test("成功: 公式 registry・正確な版・インストールスクリプトなし・本体同梱なしで入れ、確かめてから sdk に置く", async () => {
    const dir = sdkDir();
    const npm = fakeNpm({ views });
    const phases: string[] = [];
    const result = await installAgentSdkAtomic({ dir, runner: npm.runner, npm: "/n", claudeVersion: () => "2.1.322", onPhase: (p) => phases.push(p) });
    expect(result).toEqual({ ok: true, version: "0.3.322", claudeCodeVersion: "2.1.322", dir });
    const install = npm.calls.find((c) => c[0] === "install")!;
    expect(install).toEqual(expect.arrayContaining([`--registry=${OFFICIAL_REGISTRY}`, "--ignore-scripts", "--omit=optional", "--save-exact", `${PKG}@0.3.322`]));
    expect(fs.existsSync(path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"))).toBe(true);
    expect(phases).toEqual(["resolving", "downloading", "verifying", "switching"]);
    // 一時フォルダ・lock は残さない。
    expect(fs.readdirSync(path.dirname(dir)).sort()).toEqual(["sdk"]);
  });

  test("取得に失敗したら sdk は前の状態のまま（壊れかけを導入済みにしない）", async () => {
    for (const [install, error] of [["ENOTFOUND", "registry_failed"], ["ENOSPC", "disk_failed"], ["wrong-version", "verify_failed"], ["no-entry", "verify_failed"]] as const) {
      const dir = sdkDir();
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "marker"), "old");
      const result = await installAgentSdkAtomic({ dir, runner: fakeNpm({ views, install }).runner, npm: "/n", claudeVersion: () => "2.1.322" });
      expect(result).toMatchObject({ ok: false, error, message: SDK_INSTALL_MESSAGES[error] });
      expect(fs.readFileSync(path.join(dir, "marker"), "utf8")).toBe("old");
      expect(fs.readdirSync(path.dirname(dir)).sort()).toEqual(["sdk"]);
    }
  });

  test("入れ直し: 前の sdk を新しい中身で置き換える", async () => {
    const dir = sdkDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), "old");
    const result = await installAgentSdkAtomic({ dir, runner: fakeNpm({ views }).runner, npm: "/n", claudeVersion: () => "2.1.322" });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "marker"))).toBe(false);
  });

  test("npm が無い・claude が無い・版の指定が不正なら始めない", async () => {
    expect(await installAgentSdkAtomic({ dir: sdkDir(), npm: null })).toMatchObject({ ok: false, error: "npm_missing", message: SDK_INSTALL_MESSAGES.npm_missing });
    expect(await installAgentSdkAtomic({ dir: sdkDir(), runner: fakeNpm({ views }).runner, npm: "/n", claudeVersion: () => null }))
      .toMatchObject({ ok: false, error: "claude_missing" });
    expect(await installAgentSdkAtomic({ dir: sdkDir(), runner: fakeNpm({ views }).runner, npm: "/n", version: "latest; rm -rf /" }))
      .toMatchObject({ ok: false, error: "install_failed" });
  });

  test("別のプロセスが導入中（lock）なら導入しない。死んだプロセスの lock は取り直す", async () => {
    const dir = sdkDir();
    const release = acquireInstallLock(path.dirname(dir))!;
    expect(await installAgentSdkAtomic({ dir, runner: fakeNpm({ views }).runner, npm: "/n", claudeVersion: () => "2.1.322" })).toEqual({ ok: false, error: "busy" });
    release();
    fs.writeFileSync(path.join(path.dirname(dir), "install.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: Date.now() }));
    expect((await installAgentSdkAtomic({ dir, runner: fakeNpm({ views }).runner, npm: "/n", claudeVersion: () => "2.1.322" })).ok).toBe(true);
  });

  test("uninstall は決まった導入先だけを消す", () => {
    const dir = sdkDir();
    fs.mkdirSync(dir, { recursive: true });
    expect(uninstallAgentSdk(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(uninstallAgentSdk(makeTempDir("other"))).toBe(false);
  });
});

function status(compatibility: AgentSdkStatus["compatibility"], sdkVersion: string | null = "0.3.322"): AgentSdkStatus {
  return { installed: compatibility !== "not_installed", entry: compatibility === "not_installed" ? null : "/x/sdk.mjs", sdkVersion,
    claudeCodeVersion: "2.1.322", bundledExecutable: false, installedClaude: "/c", installedClaudeVersion: "2.1.322", compatibility };
}

describe("アプリからの準備（契機 3）", () => {
  test("導入済みなら ready。無ければ導入を始めてすぐ installing を返し、同時に 2 回走らせない", async () => {
    expect(new AgentSdkPreparer({ status: () => status("ok") }).prepare(true)).toEqual({ state: "ready", version: "0.3.322" });
    let installs = 0;
    let finish!: () => void;
    const preparer = new AgentSdkPreparer({
      status: () => status("not_installed", null),
      now: () => 1000,
      install: async (onPhase) => { installs += 1; onPhase("downloading"); await new Promise<void>((r) => { finish = r; }); return { ok: true, version: "0.3.322", claudeCodeVersion: null, dir: "/d" }; },
    });
    expect(preparer.prepare(true)).toMatchObject({ state: "installing", startedAtMs: 1000 });
    await Promise.resolve();
    expect(preparer.prepare(false)).toEqual({ state: "installing", phase: "downloading", startedAtMs: 1000 });
    expect(preparer.prepare(true).state).toBe("installing");
    expect(installs).toBe(1);
    finish();
    await preparer.settled();
  });

  test("失敗の後、聞き直し（start=false）では入れ直さずに理由を返し、「もう一度」（start=true）で始め直す", async () => {
    let installs = 0;
    const preparer = new AgentSdkPreparer({
      status: () => status("not_installed", null),
      install: async () => { installs += 1; return { ok: false, error: "registry_failed", message: SDK_INSTALL_MESSAGES.registry_failed }; },
    });
    preparer.prepare(true);
    await preparer.settled();
    expect(preparer.prepare(false)).toEqual({ state: "failed", error: "registry_failed", message: SDK_INSTALL_MESSAGES.registry_failed });
    expect(installs).toBe(1);
    expect(preparer.prepare(true).state).toBe("installing");
    await preparer.settled();
    expect(installs).toBe(2);
  });

  test("claude が SDK より古い（sdk_version_mismatch）ときも入れ直しで直す。claude が無ければ入れずに理由を返す", async () => {
    let installs = 0;
    const preparer = new AgentSdkPreparer({ status: () => status("claude_older"), install: async () => { installs += 1; return { ok: true, version: "0.3.300", claudeCodeVersion: null, dir: "/d" }; } });
    expect(preparer.prepare(true).state).toBe("installing");
    await preparer.settled();
    expect(installs).toBe(1);
    expect(new AgentSdkPreparer({ status: () => status("claude_missing") }).prepare(true))
      .toEqual({ state: "failed", error: "claude_missing", message: SDK_INSTALL_MESSAGES.claude_missing });
  });

  test("別のプロセスが導入中なら lock が消えるまで「待っている」状態にする", async () => {
    let held = true;
    const preparer = new AgentSdkPreparer({ status: () => status("not_installed", null), install: async () => ({ ok: false, error: "busy" }),
      lockHeld: () => held, waitMs: 5 });
    preparer.prepare(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(preparer.prepare(false)).toMatchObject({ state: "installing", phase: "waiting" });
    held = false;
    await preparer.settled();
  });

  test("応答の形（ready / installing / failed）", () => {
    const fake = (value: ReturnType<AgentSdkPreparer["prepare"]>) => ({ prepare: () => value });
    expect(prepareResponse({ type: "api_agent_prepare_request", v: 2, id: "p", start: true }, 2, fake({ state: "ready", version: "0.3.322" })))
      .toEqual({ type: "api_agent_prepare_response", v: 2, id: "p", state: "ready", version: "0.3.322" });
    expect(prepareResponse({ type: "api_agent_prepare_request", v: 2, id: "p", start: false }, 2, fake({ state: "installing", phase: "downloading", startedAtMs: 5 })))
      .toEqual({ type: "api_agent_prepare_response", v: 2, id: "p", state: "installing", phase: "downloading", startedAtMs: 5 });
    expect(prepareResponse({ type: "api_agent_prepare_request", v: 2, id: "p", start: false }, 2, fake({ state: "failed", error: "npm_missing", message: "m" })))
      .toEqual({ type: "api_agent_prepare_response", v: 2, id: "p", state: "failed", error: "npm_missing", message: "m" });
  });
});

describe("setup（契機 1）と自己更新の後（契機 2）", () => {
  test("setup: 省く指定・導入済み・成功・失敗をそれぞれ 1 行で知らせ、失敗しても投げない", async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    await runApiAgentSetupStep({ skip: true, write });
    await runApiAgentSetupStep({ skip: false, write, status: () => status("ok") });
    await runApiAgentSetupStep({ skip: false, write, status: () => status("not_installed", null), install: async () => ({ ok: true, version: "0.3.322", claudeCodeVersion: null, dir: "/d" }) });
    await runApiAgentSetupStep({ skip: false, write, status: () => status("not_installed", null), install: async () => ({ ok: false, error: "npm_missing", message: SDK_INSTALL_MESSAGES.npm_missing }) });
    await runApiAgentSetupStep({ skip: false, write, status: () => status("not_installed", null), install: async () => { throw new Error("boom"); } });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("省きました");
    expect(lines[1]).toContain("導入済み");
    expect(lines[2]).toContain("0.3.322 を準備しました");
    expect(lines[3]).toContain(SDK_INSTALL_MESSAGES.npm_missing);
    expect(lines[4]).toContain("準備できませんでした");
    for (const line of lines) expect(line).not.toMatch(/Mac|tmux|herdr/);
    expect(shouldSkipApiAgentSetup(false, { TAILII_SKIP_API_AGENT: "1" })).toBe(true);
    expect(shouldSkipApiAgentSetup(false, {})).toBe(false);
  });

  test("自己更新の後: 未導入には入れない・合っていれば何もしない・claude と合わなければ入れ直す・失敗しても投げない", async () => {
    let installs = 0;
    const install = async () => { installs += 1; return { ok: true as const, version: "0.3.330", claudeCodeVersion: null, dir: "/d" }; };
    const log = () => undefined;
    expect(await alignInstalledSdkAfterUpdate({ log, status: () => status("not_installed", null), install })).toBe("skipped");
    expect(await alignInstalledSdkAfterUpdate({ log, status: () => status("ok"), install })).toBe("aligned");
    expect(installs).toBe(0);
    expect(await alignInstalledSdkAfterUpdate({ log, status: () => status("claude_older"), install })).toBe("reinstalled");
    expect(await alignInstalledSdkAfterUpdate({ log, status: () => status("claude_older"), install: async () => { throw new Error("x"); } })).toBe("failed");
  });
});
