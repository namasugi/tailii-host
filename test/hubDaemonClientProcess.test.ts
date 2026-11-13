// 実 ps と実プロセスで argv の実体確認を行う。sandbox 外で実行する。
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectHubSocket } from "../src/hub/hubClient.js";
import { defaultHubLockPath, ensureHubDaemonAsync } from "../src/hub/hubDaemonClient.js";
import { readPackageVersion } from "../src/shared/version.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { classifyHubProcess, classifyHubProcessAsync, ownCliPath } from "../src/hub/hubStartup.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok, startEngine } from "./helpers.js";

it.each(["tailii-host", "unrelated-package"])("非同期の実体確認も %s を同期版と同じく分類する", async (pkg) => {
  const home = makeTempDir("hub-identity-process");
  const cli = path.join(home, "node_modules", pkg, "dist", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
  const child = spawn(process.execPath, [cli, "hub"], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await Promise.race([once(child.stdout!, "data"), closed.then(() => { throw new Error("確認用プロセスが準備前に終了しました"); })]);
    const expected = pkg === "tailii-host" ? "hub" : "other";
    expect(classifyHubProcess(child.pid!)).toBe(expected);
    expect(await classifyHubProcessAsync(child.pid!)).toBe(expected);
  } finally {
    child.kill(); await closed; fs.rmSync(home, { recursive: true, force: true });
  }
});

it("hubClient だけを読み込むと hub 本体と SessionHub は読み込まれない", () => {
  const dir = makeTempDir("hub-client-import");
  const log = path.join(dir, "modules.log"), loader = path.join(dir, "loader.mjs");
  const module = pathToFileURL(fileURLToPath(new URL("../dist/hub/hubClient.js", import.meta.url))).href;
  fs.writeFileSync(loader, `import fs from 'node:fs'; export async function load(url, ctx, next) {
    const result = await next(url, ctx); fs.appendFileSync(${JSON.stringify(log)}, url + '\\n'); return result;
  }`);
  try {
    const result = spawnSync(process.execPath, ["--experimental-loader", loader, "--input-type=module", "-e", `await import(${JSON.stringify(module)})`],
      { env: { ...process.env, HOME: dir }, encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    const loaded = fs.readFileSync(log, "utf8");
    expect(loaded).toContain("/hub/hubDaemonClient.js");
    expect(loaded).not.toContain("/hub/hubDaemon.js");
    expect(loaded).not.toContain("/hub/sessionHub.js");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "darwin")("接続失敗後の実 ps プロセスが遅くても engine の一覧応答が進み、起動保証を重ねない", async () => {
  const dir = makeTempDir("hub-client-slow-ps"), bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const started = path.join(dir, "started"), finished = path.join(dir, "finished");
  const release = path.join(dir, "release");
  // テストが読み込む src 側の実体判定と揃える。dist 側のパスでは別プロセスと判定されうる。
  const cli = ownCliPath();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // 固定時間の sleep でなく、検証終了まで実プロセスを待たせて重複抑止の観測区間を確定する。
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\necho started >> ${quote(started)}\nwhile [ ! -f ${quote(release)} ]; do /bin/sleep 0.02; done\necho finished >> ${quote(finished)}\nprintf '%s\\n' ${quote(`${process.execPath} ${cli} hub`)}\n`, { mode: 0o700 });
  // 隔離 HOME の lock だけを使う。現行版の hub として返すため起動・終了要求は発生しない。
  expect(path.basename(os.homedir())).toMatch(/^tlh-/);
  const lockPath = defaultHubLockPath(); fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: readPackageVersion() }));
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  const work: Promise<void>[] = [];
  const ensureDaemon = vi.fn(() => {
    const task = ensureHubDaemonAsync(); work.push(task); return task;
  });
  // 接続処理は差し替えず、実ソケットの error → close 完了通知を数える。
  const onConnectionFailure = vi.fn();
  const link = connectHubSocket({ socketPath: path.join(dir, "missing.sock"), ensureDaemon, onConnectionFailure });
  const store = makeTempStore(), runner = new MockTmuxRunner(() => ok(""));
  // startEngine は runEngine を直接呼ぶため、runEngineCommand 冒頭の起動保証は走らない。
  // このテストの起動保証は接続エラー起点の 1 回で、後続の接続エラーだけが重複抑止の対象。
  const engine = startEngine({ sessionManager: new TmuxSessionManager({ store, runner: runner.runner }), metadataStore: store, hubLink: link });
  try {
    await engine.lines.nextOfType("channel_hello");
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 1000 });
    const at = Date.now();
    engine.writeLine('{"type":"session_list_request","v":2,"id":"while-ps"}');
    expect(JSON.parse(await engine.lines.nextOfType("session_list_response", 500))).toMatchObject({ id: "while-ps" });
    expect(Date.now() - at).toBeLessThan(500);
    await vi.waitFor(() => {
      expect(onConnectionFailure.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 1000 });
    expect(onConnectionFailure.mock.calls.slice(0, 2).map(([error]) => (error as NodeJS.ErrnoException).code))
      .toEqual(["ENOENT", "ENOENT"]);
    expect(fs.existsSync(finished)).toBe(false);
    expect(fs.readFileSync(started, "utf8").trim().split("\n")).toEqual(["started"]);
    expect(ensureDaemon).toHaveBeenCalledOnce();
    expect(work).toHaveLength(1);
  } finally {
    await engine.teardown();
    fs.writeFileSync(release, "");
    await Promise.all(work);
    vi.unstubAllEnvs(); fs.rmSync(lockPath, { force: true }); fs.rmSync(dir, { recursive: true, force: true });
  }
});
