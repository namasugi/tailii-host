import { describe, expect, test } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listLocalServerProcesses, parseProcessTable, processBelongsToPane } from "../src/hub/localServerProcesses.js";

describe("サーバーの会話所有判定", () => {
  test("pane の子孫だけを照合し、兄弟 pane・切り離されたプロセスは除外、途中欠落・循環は判定不能", () => {
    const { parents } = parseProcessTable(" 100 1 ??\n 110 100 ??\n 120 110 ??\n 200 1 ??\n 210 200 ??\n 300 1 ??\n 400 401 ??\n 401 400 ??\n")!;
    expect(processBelongsToPane(120, [100], parents)).toBe(true);
    expect(processBelongsToPane(100, [100], parents)).toBe(true);
    expect(processBelongsToPane(120, [200], parents)).toBe(false);
    expect(processBelongsToPane(300, [100], parents)).toBe(false);
    expect(processBelongsToPane(400, [100], parents)).toBeNull();
    expect(processBelongsToPane(500, [100], parents)).toBeNull();
    expect(parseProcessTable("broken")).toBeNull();
    expect(parseProcessTable("")).toBeNull();
  });

  test("制御端末なしの ? / ?? は同じ pane と誤認しない", () => {
    for (const tty of ["?", "??", "-"]) {
      const table = parseProcessTable(`100 1 ${tty}\n200 1 ${tty}\n`)!;
      expect(processBelongsToPane(200, [100], table.parents, table.terminals)).toBe(false);
    }
  });

  test("実プロセスの親 pid を取得できる", async () => {
    const snapshot = await listLocalServerProcesses([process.pid]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.parents?.get(process.pid)).toBe(process.ppid);
    expect(snapshot?.servers.some((server) => server.pid === process.pid)).toBe(false);
  });

  test("LISTEN と ps の失敗・不正出力をサーバーなしと解釈しない", async () => {
    expect(await listLocalServerProcesses([], async () => ({ ok: false, stdout: "p100\ncnode\nf4\n" }))).toBeNull();
    expect(await listLocalServerProcesses([], async () => ({ ok: true, stdout: "not lsof fields" }))).toBeNull();
    const result = await listLocalServerProcesses([], async (command) => command === "lsof"
      ? { ok: true, stdout: "p100\ncnode\nf4\nf5\n" } : { ok: false, stdout: "100 1\n" });
    expect(result?.servers).toEqual([{ pid: 100, command: "node" }]);
    expect(result?.parents).toBeNull();
  });

  test("cwd が / の実サーバーも一覧の表示フィルターで落とさず親子関係を取得する", async () => {
    const child = spawn(process.execPath, ["-e", `
      require('node:net').createServer().listen(0, '127.0.0.1', () => process.stdout.write('ready'));
    `], { cwd: "/", stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      const snapshot = await listLocalServerProcesses([process.pid]);
      expect(snapshot?.servers.some((server) => server.pid === child.pid)).toBe(true);
      expect(processBelongsToPane(child.pid!, [process.pid], snapshot!.parents!)).toBe(true);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });

  test.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("隔離 tmux で親を失った実サーバーも、同じ制御端末の pane に照合できる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlo-"));
    const socket = path.join(dir, "t.sock");
    const state = path.join(dir, "server.json");
    const server = path.join(dir, "server.cjs");
    const spawner = path.join(dir, "spawn.cjs");
    const tmux = (...args: string[]): string => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    let serverPid: number | undefined;
    try {
      fs.writeFileSync(server, `
        const net = require('node:net'), fs = require('node:fs');
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ pid: process.pid })));
      `);
      fs.writeFileSync(spawner, `
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(server)}], { stdio: 'inherit' }).unref();
      `);
      tmux("new-session", "-d", "-s", "s-review", `${quote(process.execPath)} ${quote(spawner)}; exec sleep 60`);
      const panePid = Number(tmux("display-message", "-p", "-t", "s-review", "#{pane_pid}").trim());
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(state) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      serverPid = (JSON.parse(fs.readFileSync(state, "utf8")) as { pid: number }).pid;
      const snapshot = (await listLocalServerProcesses([]))!;
      expect(snapshot.servers.some((entry) => entry.pid === serverPid)).toBe(true);
      expect(processBelongsToPane(serverPid, [panePid], snapshot.parents!)).toBe(false);
      expect(processBelongsToPane(serverPid, [panePid], snapshot.parents!, snapshot.terminals)).toBe(true);
    } finally {
      spawnSync("tmux", ["-S", socket, "kill-server"]);
      if (serverPid !== undefined) {
        try { process.kill(serverPid, "SIGTERM"); } catch { /* pane 終了の SIGHUP で既に終了 */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
