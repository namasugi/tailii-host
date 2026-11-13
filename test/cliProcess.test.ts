// 実 Node を起動する CLI 契約・読み込みの回帰テスト。sandbox 外で実行する。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { makeTempDir } from "./helpers.js";
import { readPackageVersion } from "../src/shared/version.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const dist = new URL("../dist/", import.meta.url).href;
const usage = "usage: tailii <engine|serve|standby|hook|launch|kick|push-token|setup|doctor|hub|self-update|api-agent> [options]\n";
function invoke(args: string[], input = "") {
  const home = makeTempDir("cli-process");
  const legacy = path.join(home, ".pocketclaude"); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, "marker"), "legacy");
  const loader = path.join(home, "loader.mjs"); const log = path.join(home, "modules.log");
  fs.writeFileSync(loader, String.raw`import fs from 'node:fs';
    export async function load(url, context, next) {
      const result = await next(url, context);
      if (url.startsWith(${JSON.stringify(dist)})) fs.appendFileSync(${JSON.stringify(log)}, url + '\n');
      return result;
    }`);
  const result = spawnSync(process.execPath, ["--experimental-loader", loader, cli, ...args], {
    input, encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home, NODE_NO_WARNINGS: "1" },
  });
  const modules = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((url) => url.slice(dist.length)) : [];
  const migrated = fs.existsSync(path.join(home, ".tailii", "marker"));
  fs.rmSync(home, { recursive: true, force: true });
  expect(result.error).toBeUndefined(); return { ...result, modules, migrated };
}
it.each(["--version", "-v"])("%s の出力と終了コード・移行を保つ", (flag) => {
  const result = invoke([flag]); expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${readPackageVersion()}\n`); expect(result.stderr).toBe(""); expect(result.migrated).toBe(true);
  expect(result.modules.some((m) => m.startsWith("engine/") || m.startsWith("approval/") || m.startsWith("hub/"))).toBe(false);
});
it.each([[], ["--help"], ["-h"]])("help の出力・終了コード・移行を保つ: %j", (...args) => {
  const result = invoke(args); expect(result.status).toBe(64); expect(result.stdout).toBe(""); expect(result.stderr).toBe(usage); expect(result.migrated).toBe(true);
});
it("未知のサブコマンドは従来の文面と終了コードで返す", () => {
  const result = invoke(["unknown-command"]); expect(result.status).toBe(69); expect(result.stdout).toBe("");
  expect(result.stderr).toBe("tailii: subcommand 'unknown-command' は TypeScript 版に未移植です。当面は Swift 版 (tailii-host) を使用してください。\n");
  expect(result.migrated).toBe(true);
});
it("standby の無効な fd では移行しない", () => {
  const result = invoke(["standby"]); expect(result.status).toBe(1); expect(result.migrated).toBe(false);
});
it.each(["hook", "serve"])("%s は使うコマンドだけを読み込み、hub 本体を読み込まない", (command) => {
  const result = invoke([command], JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }));
  expect(result.status).toBe(command === "hook" ? 0 : 1);
  expect(result.modules).toContain(command === "hook" ? "approval/hook.js" : "approval/broker.js");
  expect(result.modules).not.toContain("engine/engine.js"); expect(result.modules).not.toContain("hub/hubDaemon.js"); expect(result.modules).not.toContain("hub/sessionHub.js");
  expect(result.modules).not.toContain("commands/setup.js"); expect(result.modules).not.toContain("commands/doctor.js");
});
