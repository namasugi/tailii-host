import { afterEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { ClaudeUpdater } from "../src/updates/claudeUpdater.js";
import { createClaudeUpdateHandlers } from "../src/engine/handlers/claudeUpdate.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import type { HandlerContext } from "../src/engine/context.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-update-")); directories.push(dir);
  const dataHome = path.join(dir, ".local", "share");
  const configHome = path.join(dir, ".claude"); fs.mkdirSync(configHome);
  const command = path.join(dataHome, "claude", "versions", "2.1.300");
  fs.mkdirSync(path.dirname(command), { recursive: true }); fs.writeFileSync(command, "fake CLI");
  let current = "2.1.300";
  let token = "";
  const spawnWorker = vi.fn((value: string) => { token = value; return 123456; });
  const latest = vi.fn(async () => "2.1.325");
  const options = { root: path.join(dir, "updater"), dataHome, configHome,
    managedSettingsPath: path.join(dir, "managed.json"), resolveCommand: () => command,
    version: async () => current, latest, spawnWorker };
  return { dir, dataHome, configHome, command, options, spawnWorker, latest, token: () => token,
    settings: (value: unknown) => fs.writeFileSync(path.join(configHome, "settings.json"), JSON.stringify(value)),
    installed: (version: string) => { current = version; }, updater: new ClaudeUpdater(options) };
}

test("自動更新が無効でも通知と手動更新ができ、同時操作で二重起動しない", async () => {
  const f = fixture(); f.settings({ env: { DISABLE_AUTOUPDATER: "1" } });
  const [a, b] = await Promise.all([f.updater.check(), f.updater.check()]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ status: "available", canUpdate: true, currentVersion: "2.1.300", latestVersion: "2.1.325" });
  expect(f.latest).toHaveBeenCalledOnce();
  expect(f.spawnWorker).not.toHaveBeenCalled();
  expect((await Promise.all([f.updater.install(), new ClaudeUpdater(f.options).install()])).map((v) => v.status))
    .toEqual(["updating", "updating"]);
  expect(f.spawnWorker).toHaveBeenCalledOnce();
  await f.updater.runWorker(f.token(), async (command) => {
    expect(command).toBe(f.command);
    expect((await new ClaudeUpdater(f.options).check()).status).toBe("updating");
    f.installed("2.1.325");
  });
  expect(await f.updater.check()).toMatchObject({ status: "updated", currentVersion: "2.1.325" });
  expect(JSON.parse(fs.readFileSync(path.join(f.configHome, "settings.json"), "utf8")))
    .toEqual({ env: { DISABLE_AUTOUPDATER: "1" } });
});

test("native以外の導入と管理者による手動更新禁止は上書きしない", async () => {
  const f = fixture();
  const outside = path.join(f.dir, "brew-claude"); fs.writeFileSync(outside, "fake CLI");
  expect((await new ClaudeUpdater({ ...f.options, resolveCommand: () => outside }).install()).canUpdate).toBe(false);
  f.settings({ env: { DISABLE_UPDATES: "1" } });
  expect((await f.updater.install()).status).toBe("unsupported");
  f.settings({ env: { DISABLE_UPDATES: "0" } });
  fs.writeFileSync(f.options.managedSettingsPath, JSON.stringify({ env: { DISABLE_UPDATES: "1" } }));
  expect((await f.updater.install()).canUpdate).toBe(false);
  expect(f.spawnWorker).not.toHaveBeenCalled();
});

test("stableとlatestのリリース取得とキャッシュを混同しない", async () => {
  const f = fixture();
  const lookup = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    new Response(String(input).endsWith("/stable") ? "2.1.310\n" : "2.1.325\n"));
  const updater = new ClaudeUpdater({ ...f.options, latest: undefined });
  f.settings({ autoUpdatesChannel: "stable" });
  expect((await updater.check()).latestVersion).toBe("2.1.310");
  expect(lookup.mock.calls[0]?.[0]).toBe("https://downloads.claude.ai/claude-code-releases/stable");
  f.settings({ autoUpdatesChannel: "latest" });
  expect((await updater.check()).latestVersion).toBe("2.1.325");
  expect(lookup).toHaveBeenCalledTimes(2);
  f.settings({ autoUpdatesChannel: "stable" });
  expect((await updater.check()).latestVersion).toBe("2.1.310");
  expect(lookup).toHaveBeenCalledTimes(2);
});

test("更新コマンドの成功だけでは成功表示せず、設置版を検証する", async () => {
  const f = fixture(); await f.updater.install();
  await f.updater.runWorker(f.token(), async () => {});
  expect((await f.updater.check()).status).toBe("failed");
  expect((await f.updater.install()).status).toBe("updating");
  expect(f.spawnWorker).toHaveBeenCalledTimes(2);
});

test("ワイヤーとhandlerはClaude専用で、会話操作を持たない", async () => {
  for (const line of fs.readFileSync(new URL("../protocol/claude-update-v1.ndjson", import.meta.url), "utf8").trim().split("\n")) {
    expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
  }
  expect(() => decodeControlMessage('{"type":"claude_update_request","v":1,"id":"bad","action":"restart"}')).toThrow();
  const f = fixture(); const writes: unknown[] = [];
  const ctx = { writer: { write: (value: unknown) => writes.push(value) }, state: { negotiatedVersion: 2 } } as unknown as HandlerContext;
  const handler = createClaudeUpdateHandlers(f.updater).claude_update_request!;
  await handler({ type: "claude_update_request", v: 1, id: "check", action: "check" }, ctx);
  await handler({ type: "claude_update_request", v: 1, id: "install", action: "install" }, ctx);
  expect(writes).toMatchObject([
    { type: "claude_update_response", id: "check", update: { status: "available" } },
    { type: "claude_update_response", id: "install", update: { status: "updating" } },
  ]);
});

test("実workerは要求元の終了後も非対話で更新し、既存の会話を操作しない", async () => {
  const f = fixture(); const state = path.join(f.dir, "version"); const calls = path.join(f.dir, "calls");
  fs.writeFileSync(state, "2.1.300");
  fs.writeFileSync(f.command, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_CALLS"
case "$1" in
  --version) printf '%s (Claude Code)\\n' "$(cat "$FAKE_CLAUDE_VERSION")" ;;
  update) test "$DISABLE_AUTOUPDATER" = 1 || exit 3; sleep 0.2; printf 2.1.325 > "$FAKE_CLAUDE_VERSION" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 }); fs.chmodSync(f.command, 0o700);
  const bin = path.join(f.dir, "bin"); fs.mkdirSync(bin); fs.symlinkSync(f.command, path.join(bin, "claude"));
  const module = new URL("../dist/updates/claudeUpdater.js", import.meta.url).href;
  const source = `import {ClaudeUpdater} from ${JSON.stringify(module)};
console.log(JSON.stringify(await new ClaudeUpdater({latest:async()=>"2.1.325"}).install()));`;
  const result = await new Promise<string>((resolve, reject) => execFile(process.execPath,
    ["--input-type=module", "-e", source], { timeout: 10_000,
      env: { ...process.env, HOME: f.dir, XDG_DATA_HOME: f.dataHome, CLAUDE_CONFIG_DIR: f.configHome,
        PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE_CALLS: calls, FAKE_CLAUDE_VERSION: state } },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  expect(JSON.parse(result)).toMatchObject({ status: "updating", canUpdate: true });
  await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(f.dir, ".tailii", "claude-update", "job.json"), "utf8")).status)
    .toBe("updated"), { timeout: 10_000 });
  const argv = fs.readFileSync(calls, "utf8").trim().split("\n");
  expect(argv.filter((call) => call === "update")).toHaveLength(1);
  expect(argv.every((call) => call === "--version" || call === "update")).toBe(true);
  expect(fs.readFileSync(state, "utf8")).toBe("2.1.325");
});
