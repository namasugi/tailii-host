import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { CodexUpdater } from "../src/codex/codexUpdater.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { createCodexUpdateHandlers } from "../src/engine/handlers/codexUpdate.js";
import type { HandlerContext } from "../src/engine/context.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-")); directories.push(dir);
  const home = path.join(dir, "codex");
  const command = path.join(home, "packages", "standalone", "releases", "0.167.2-test", "bin", "codex");
  fs.mkdirSync(path.dirname(command), { recursive: true }); fs.writeFileSync(command, "fake CLI");
  let current = "0.167.2";
  let now = Date.now();
  let token = "";
  const latest = vi.fn(async () => "0.169.0");
  const spawnWorker = vi.fn((value: string) => { token = value; return 123456; });
  const options = {
    root: path.join(dir, "updater"), codexHome: home, resolveCodex: () => command,
    version: async () => current, latest, spawnWorker, now: () => now,
  };
  return { dir, command, options, latest, spawnWorker, token: () => token,
    installed: (value: string) => { current = value; }, advance: (ms: number) => { now += ms; },
    updater: new CodexUpdater(options) };
}

describe("会話を止めない Codex 更新", () => {
  test("確認はインストールせず、並行要求と接続をまたいでリリース取得をまとめる", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.updater.check(), f.updater.check()]);
    expect(a).toEqual(b);
    expect(a).toEqual({ status: "available", canUpdate: true, currentVersion: "0.167.2", latestVersion: "0.169.0" });
    expect(f.latest).toHaveBeenCalledOnce();
    expect(await new CodexUpdater(f.options).check()).toEqual(a);
    expect(f.latest).toHaveBeenCalledOnce();
    expect(f.spawnWorker).not.toHaveBeenCalled();
  });

  test("同時に更新を押しても worker は1本、切断後の接続でも更新中を復元する", async () => {
    const f = fixture();
    const results = await Promise.all([f.updater.install(), new CodexUpdater(f.options).install()]);
    expect(results.map((r) => r.status)).toEqual(["updating", "updating"]);
    expect(f.spawnWorker).toHaveBeenCalledOnce();
    expect((await new CodexUpdater(f.options).check()).status).toBe("updating");
    expect((await new CodexUpdater(f.options).install()).status).toBe("updating");
    expect(f.spawnWorker).toHaveBeenCalledOnce();
  });

  test("worker は更新と設置版の確認だけを行い、途中の接続も更新中を読める", async () => {
    const f = fixture(); await f.updater.install();
    let finish!: () => void;
    const run = vi.fn(async (command: string) => {
      expect(command).toBe(f.command);
      await new Promise<void>((resolve) => { finish = resolve; });
      f.installed("0.169.0");
    });
    const worker = new CodexUpdater(f.options).runWorker(f.token(), run);
    f.advance(6 * 60_000);
    expect((await new CodexUpdater(f.options).check()).status).toBe("updating");
    expect((await new CodexUpdater(f.options).install()).status).toBe("updating");
    finish(); await worker;
    expect(run).toHaveBeenCalledOnce();
    expect(await new CodexUpdater(f.options).check()).toMatchObject({ status: "updated", currentVersion: "0.169.0" });
    await f.updater.install();
    expect(f.spawnWorker).toHaveBeenCalledOnce();
  });

  test("コマンドが成功しても版が変わっていなければ成功表示せず、再試行できる", async () => {
    const f = fixture(); await f.updater.install();
    await f.updater.runWorker(f.token(), async () => {});
    expect((await f.updater.check()).status).toBe("failed");
    expect((await f.updater.install()).status).toBe("updating");
    expect(f.spawnWorker).toHaveBeenCalledTimes(2);
  });

  test("worker 消失後は OS が排他を解放し、更新中のまま張り付かない", async () => {
    const f = fixture(); await f.updater.install();
    f.advance(16_000);
    expect((await f.updater.check()).status).toBe("failed");
    expect((await f.updater.install()).status).toBe("updating");
  });

  test("CLIの差し替え中にバージョンを読めなくても、進行中のジョブを見失わない", async () => {
    const f = fixture(); await f.updater.install();
    const unreadable = new CodexUpdater({ ...f.options, version: async () => null });
    expect(await unreadable.check()).toMatchObject({ status: "updating", latestVersion: "0.169.0", canUpdate: false });
    expect((await unreadable.install()).status).toBe("updating");
    expect(f.spawnWorker).toHaveBeenCalledOnce();
  });

  test("古い worker の起動は新しいジョブを実行しない", async () => {
    const f = fixture(); await f.updater.install();
    const run = vi.fn(async () => {});
    await f.updater.runWorker("old-job", run);
    expect(run).not.toHaveBeenCalled();
    expect((await f.updater.check()).status).toBe("updating");
  });

  test("過去の成功記録があっても、実際の設置版が古くなっていれば再更新する", async () => {
    const f = fixture(); await f.updater.install();
    await f.updater.runWorker(f.token(), async () => { f.installed("0.169.0"); });
    f.installed("0.167.2");
    expect((await f.updater.check()).status).toBe("available");
    expect((await f.updater.install()).status).toBe("updating");
    expect(f.spawnWorker).toHaveBeenCalledTimes(2);
  });

  test("壊れた成功記録を現在のバージョンの根拠にしない", async () => {
    const f = fixture(); await f.updater.install();
    const file = path.join(f.options.root, "job.json");
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...job, status: "updated", installedVersion: {} }));
    expect((await f.updater.install()).status).toBe("updating");
    expect(f.spawnWorker).toHaveBeenCalledTimes(2);
  });

  test("不明な導入先は書き換えず、未知・不正な版を更新先にしない", async () => {
    const f = fixture();
    const outside = path.join(f.dir, "codex-custom"); fs.writeFileSync(outside, "custom");
    const external = new CodexUpdater({ ...f.options, resolveCodex: () => outside });
    expect((await external.install()).status).toBe("unsupported");
    expect(f.spawnWorker).not.toHaveBeenCalled();
    const g = fixture();
    const invalid = new CodexUpdater({ ...g.options, latest: async () => "0.170.0; touch /tmp/untrusted" });
    expect((await invalid.install()).status).toBe("unavailable");
    expect(g.spawnWorker).not.toHaveBeenCalled();
  });

  test("オフライン時は既知の更新を保持し、設置版が新しければダウングレードを提案しない", async () => {
    const f = fixture(); await f.updater.check(); f.advance(3_600_001);
    f.latest.mockRejectedValue(new Error("offline"));
    expect((await f.updater.check()).status).toBe("available");
    f.installed("0.170.0");
    expect(await f.updater.check()).toMatchObject({ status: "current", currentVersion: "0.170.0", latestVersion: "0.170.0" });
    expect((await f.updater.install()).status).toBe("current");
    expect(f.spawnWorker).not.toHaveBeenCalled();
  });

  test("過去の成功を別の版の更新完了として再通知しない", async () => {
    const f = fixture(); await f.updater.install();
    await f.updater.runWorker(f.token(), async () => f.installed("0.169.0"));
    expect((await f.updater.check()).status).toBe("updated");
    f.installed("0.170.0");
    expect(await f.updater.check()).toMatchObject({ status: "current", currentVersion: "0.170.0" });
  });

  test("過去の失敗を別の更新先の失敗として再通知しない", async () => {
    const f = fixture(); await f.updater.install();
    await f.updater.runWorker(f.token(), async () => {});
    expect((await f.updater.check()).status).toBe("failed");
    f.advance(3_600_001); f.latest.mockResolvedValue("0.170.0");
    expect(await f.updater.check()).toMatchObject({ status: "available", latestVersion: "0.170.0" });
  });

  test("手動更新の対象外になった導入には、過去の失敗より更新方法を案内する", async () => {
    const f = fixture(); await f.updater.install();
    await f.updater.runWorker(f.token(), async () => {});
    const external = path.join(f.dir, "external-codex"); fs.writeFileSync(external, "external");
    expect(await new CodexUpdater({ ...f.options, resolveCodex: () => external }).check())
      .toMatchObject({ status: "unsupported", canUpdate: false });
  });

  test("ホストの時計が戻っても、終了済みの予約を更新中のまま保持しない", async () => {
    const f = fixture(); await f.updater.install();
    f.advance(-3_600_000);
    const unreadable = new CodexUpdater({ ...f.options, version: async () => null });
    expect((await unreadable.check()).status).toBe("unavailable");
    expect((await f.updater.check()).status).toBe("failed");
  });

  test("時刻だけ新しい破損リリースキャッシュは読み直して回復する", async () => {
    const f = fixture();
    fs.mkdirSync(f.options.root, { recursive: true });
    fs.writeFileSync(path.join(f.options.root, "release.json"), JSON.stringify({ at: Date.now(), version: {} }));
    expect((await f.updater.check()).status).toBe("available");
    expect(f.latest).toHaveBeenCalledOnce();
  });

  test("handler は会話から独立した id 相関の応答を返す", async () => {
    const f = fixture(); const writes: unknown[] = [];
    const ctx = { writer: { write: (m: unknown) => writes.push(m) }, state: { negotiatedVersion: 2 } } as unknown as HandlerContext;
    const handler = createCodexUpdateHandlers(f.updater).codex_update_request!;
    await handler({ type: "codex_update_request", v: 1, id: "probe", action: "check" }, ctx);
    await handler({ type: "codex_update_request", v: 1, id: "update", action: "install" }, ctx);
    expect(writes).toMatchObject([
      { type: "codex_update_response", id: "probe", v: 2, update: { status: "available" } },
      { type: "codex_update_response", id: "update", v: 2, update: { status: "updating" } },
    ]);
  });
});

test("iOS と共通の更新ワイヤーを byte-exact で往復し、未知の操作を拒否する", () => {
  const lines = fs.readFileSync(new URL("../protocol/codex-update-v1.ndjson", import.meta.url), "utf8").trim().split("\n");
  for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
  for (const action of ["restart", "exec", "update; rm"]) {
    expect(() => decodeControlMessage(JSON.stringify({ type: "codex_update_request", v: 1, id: "bad", action }))).toThrow();
  }
});

test.each(["0.167.2", "0.169.0-alpha.1"])("実プロセスの worker は要求元の終了後も動き、非対話で更新して版を確認する (%s)", async (initialVersion) => {
  const f = fixture();
  const state = path.join(f.dir, "installed-version");
  const calls = path.join(f.dir, "calls");
  fs.writeFileSync(state, initialVersion);
  fs.writeFileSync(f.command, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_CALLS"
case "$1" in
  --version) printf 'codex-cli '; cat "$FAKE_CODEX_VERSION" ;;
  update) test "$CODEX_NON_INTERACTIVE" = 1 || exit 3; sleep 0.2; printf 0.169.0 > "$FAKE_CODEX_VERSION" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  fs.chmodSync(f.command, 0o700);
  const bin = path.join(f.dir, "bin"); fs.mkdirSync(bin);
  fs.symlinkSync(f.command, path.join(bin, "codex"));
  const module = new URL("../dist/codex/codexUpdater.js", import.meta.url).href;
  const source = `import { CodexUpdater } from ${JSON.stringify(module)};
const updater = new CodexUpdater({latest: async () => '0.169.0'});
console.log(JSON.stringify(await updater.install()));`;
  const result = await new Promise<string>((resolve, reject) => execFile(process.execPath,
    ["--input-type=module", "-e", source], {
      timeout: 10_000,
      env: { ...process.env, HOME: f.dir, CODEX_HOME: f.options.codexHome, PATH: `${bin}:/usr/bin:/bin`,
        FAKE_CODEX_CALLS: calls, FAKE_CODEX_VERSION: state },
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  if (initialVersion.includes("-")) {
    expect(JSON.parse(result)).toMatchObject({ status: "unavailable", canUpdate: false });
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual(["--version"]);
    return;
  }
  expect(JSON.parse(result)).toMatchObject({ status: "updating", canUpdate: true });
  const job = path.join(f.dir, ".tailii", "codex-update", "job.json");
  await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(job, "utf8")).status).toBe("updated"), { timeout: 10_000 });
  expect(fs.readFileSync(state, "utf8")).toBe("0.169.0");
  const argv = fs.readFileSync(calls, "utf8").trim().split("\n");
  expect(argv.filter((call) => call === "update")).toHaveLength(1);
  expect(argv.every((call) => call === "update" || call === "--version")).toBe(true);
});

test.each(["updating", "failed"])("worker が強制終了されても子の更新中は再実行せず、完了後に設置版から復元する (%s)", async (jobStatus) => {
  const f = fixture();
  const state = path.join(f.dir, "version"); const finish = path.join(f.dir, "finish");
  const started = path.join(f.dir, "started"); fs.writeFileSync(state, "0.167.2");
  fs.writeFileSync(f.command, `#!/bin/sh
case "$1" in
  --version) printf 'codex-cli '; cat "$FAKE_CODEX_VERSION" ;;
  update) touch "$FAKE_CODEX_STARTED"; while [ ! -f "$FAKE_CODEX_FINISH" ]; do sleep 0.05; done
          printf 0.169.0 > "$FAKE_CODEX_VERSION" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  fs.chmodSync(f.command, 0o700);
  const bin = path.join(f.dir, "bin"); fs.mkdirSync(bin); fs.symlinkSync(f.command, path.join(bin, "codex"));
  const module = new URL("../dist/codex/codexUpdater.js", import.meta.url).href;
  const source = `import {CodexUpdater} from ${JSON.stringify(module)};
console.log(JSON.stringify(await new CodexUpdater({latest: async()=> '0.169.0'}).install()));`;
  await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", source], {
    timeout: 10_000, env: { ...process.env, HOME: f.dir, CODEX_HOME: f.options.codexHome,
      PATH: `${bin}:/usr/bin:/bin`, FAKE_CODEX_VERSION: state, FAKE_CODEX_FINISH: finish, FAKE_CODEX_STARTED: started },
  }, (error) => error ? reject(error) : resolve()));
  const root = path.join(f.dir, ".tailii", "codex-update");
  let worker = 0;
  try {
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 5000 });
    worker = JSON.parse(fs.readFileSync(path.join(root, "job.json"), "utf8")).pid;
    expect(worker).toBeGreaterThan(0);
    process.kill(worker, "SIGKILL");
    if (jobStatus === "failed") {
      const file = path.join(root, "job.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), status: "failed" }));
    }
    const retry = vi.fn(() => 123456);
    const updater = new CodexUpdater({ ...f.options, root, now: () => Date.now() + 30_000,
      version: async () => fs.readFileSync(state, "utf8"), spawnWorker: retry });
    expect((await updater.check()).status).toBe("updating");
    expect((await updater.install()).status).toBe("updating");
    expect(retry).not.toHaveBeenCalled();
    fs.writeFileSync(finish, "finish");
    await vi.waitFor(async () => expect((await updater.check()).status).toBe("updated"), { timeout: 5000 });
    expect((await updater.check()).currentVersion).toBe("0.169.0");
  } finally {
    fs.writeFileSync(finish, "finish");
    if (worker > 0) { try { process.kill(-worker, "SIGTERM"); } catch { /* 終了済み。 */ } }
  }
});
