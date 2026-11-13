// fd 3 の実ストリームと ps 表示を確認する。sandbox 外で実行する。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { expect, it } from "vitest";

it.each(["engine", "serve"])("有効化後は通常の %s の argv と ps 表示になる", async (sub) => {
  const home = mkdtempSync(join(tmpdir(), "tsp-"));
  const runner = join(home, "runner.mjs");
  const module = pathToFileURL(fileURLToPath(new URL("../dist/commands/standby.js", import.meta.url))).href;
  writeFileSync(runner, `import { runStandbyCommand } from ${JSON.stringify(module)};
    process.exitCode = await runStandbyCommand(async () => { process.stdout.write(JSON.stringify(process.argv) + '\\n'); await new Promise(r => process.stdin.on('end', r).resume()); return 0; });`);
  const loader = join(home, "loader.mjs");
  const modules = join(home, "modules.log");
  writeFileSync(loader, String.raw`import fs from 'node:fs';
    export async function load(url, context, next) {
      const result = await next(url, context);
      fs.appendFileSync(${JSON.stringify(modules)}, url + '\n');
      return result;
    }`);
  const child = spawn(process.execPath, ["--experimental-loader", loader, runner, "standby", "_".repeat(512)], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const control = child.stdio[3] as Duplex;
  let output = ""; child.stdout!.on("data", (chunk) => { output += chunk; });
  try {
    const warmed = (): string => existsSync(modules) ? readFileSync(modules, "utf8") : "";
    const warmDeadline = Date.now() + 5_000;
    while ((!warmed().includes("/engine/engine.js") || !warmed().includes("/approval/broker.js")) && Date.now() < warmDeadline) await new Promise(r => setTimeout(r, 10));
    expect(warmed()).toContain("/engine/engine.js");
    expect(warmed()).toContain("/approval/broker.js");
    expect(output).toBe("");
    const argv = sub === "engine" ? ["engine"] : ["serve", "--session", "s-" + "x".repeat(126), "--client-id", "01234567-89ab-cdef-0123-456789abcdef"];
    const ack = new Promise<string>((resolve, reject) => { let line = ""; control.on("data", (part) => { line += part; if (line.includes("\n")) resolve(line.trim()); }); control.on("error", reject); });
    control.write(JSON.stringify({ activate: { argv } }) + "\n");
    expect(await ack).toBe('{"ok":true}');
    const deadline = Date.now() + 5_000;
    while (!output.includes("\n") && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect(JSON.parse(output).slice(2)).toEqual(argv);
    const command = execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
    expect(command).toContain(`dist/cli.js ${argv.join(" ")}`);
    expect(command).not.toContain("standby");
  } finally {
    child.stdin!.end();
    child.kill();
    await closed;
    rmSync(home, { recursive: true, force: true });
  }
});

it.each(["eof", "bad_request"])("実 fd 3 の %s は正常終了・失敗終了を区別する", async (kind) => {
  const home = mkdtempSync(join(tmpdir(), "tse-")), runner = join(home, "runner.mjs");
  const module = pathToFileURL(fileURLToPath(new URL("../dist/commands/standby.js", import.meta.url))).href;
  writeFileSync(runner, `import { runStandbyCommand } from ${JSON.stringify(module)};
    process.exitCode = await runStandbyCommand(async () => { throw new Error('unexpected activation'); });`);
  const child = spawn(process.execPath, [runner], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const control = child.stdio[3] as Duplex;
  let output = "", stderr = "";
  control.on("data", (chunk) => { output += chunk; });
  control.on("error", () => {});
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    if (kind === "eof") control.end();
    else control.write('{"activate":{"argv":["hub"]}}\n');
    expect(await closed).toBe(kind === "eof" ? 0 : 1);
    expect(output).toBe(kind === "eof" ? "" : '{"ok":false,"reason":"bad_request"}\n');
    expect(stderr).toBe("");
  } finally { child.kill(); await closed; rmSync(home, { recursive: true, force: true }); }
});
