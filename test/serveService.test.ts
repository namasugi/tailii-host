// serveService.test.ts — LISTEN 中サーバー列挙と停止（serve-list）
//
// パーサは固定サンプルで検証し、列挙/停止は実ソケット・実子プロセスで
// エンドツーエンドに検証する（lsof は macOS / Linux CI どちらにもある）。

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import {
  listServeProcesses,
  parseListenPort,
  parseLsofCwdOutput,
  parseLsofListenOutput,
  stopServeProcess,
} from "../src/serveService.js";

describe("parseListenPort", () => {
  it("loopback / wildcard の bind を受け付ける", () => {
    expect(parseListenPort("*:5173")).toBe(5173);
    expect(parseListenPort("127.0.0.1:8000")).toBe(8000);
    expect(parseListenPort("[::1]:3000")).toBe(3000);
    expect(parseListenPort("[::]:4321")).toBe(4321);
  });

  it("LAN 固定 bind と不正値は弾く", () => {
    expect(parseListenPort("192.168.1.2:8080")).toBeNull();
    expect(parseListenPort("*:notaport")).toBeNull();
    expect(parseListenPort("noport")).toBeNull();
  });
});

describe("parseLsofListenOutput", () => {
  it("p/c/n ブロックを (pid, port) へ展開し IPv4/IPv6 重複を畳む", () => {
    const output = [
      "p4321", "cnode", "n*:5173", "n[::]:5173",
      "p4400", "cpython3", "n127.0.0.1:8000",
      "p4500", "cSpotify", "n192.168.1.2:57621",
    ].join("\n");
    expect(parseLsofListenOutput(output)).toEqual([
      { pid: 4321, command: "node", port: 5173 },
      { pid: 4400, command: "python3", port: 8000 },
    ]);
  });
});

describe("parseLsofCwdOutput", () => {
  it("pid → cwd を対応付ける", () => {
    const output = ["p4321", "fcwd", "n/Users/alice/project", "p4400", "fcwd", "n/"].join("\n");
    const cwds = parseLsofCwdOutput(output);
    expect(cwds.get(4321)).toBe("/Users/alice/project");
    expect(cwds.get(4400)).toBe("/");
  });
});

describe("listServeProcesses（実ソケット）", () => {
  it("自プロセスの LISTEN ソケットを cwd 付きで列挙する", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    try {
      const entries = await listServeProcesses();
      const mine = entries.find(
        (entry) => entry.pid === process.pid && entry.port === port,
      );
      expect(mine).toBeDefined();
      expect(mine!.cwd).toBe(process.cwd());
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("excludePids の pid は一覧に出ない", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    try {
      const entries = await listServeProcesses({ excludePids: [process.pid] });
      expect(entries.some((entry) => entry.pid === process.pid && entry.port === port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe("stopServeProcess（実子プロセス）", () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    child = null;
  });

  async function spawnListener(): Promise<{ pid: number; port: number }> {
    child = spawn(process.execPath, [
      "-e",
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    const spawned = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("子プロセスの listen 待ちタイムアウト")), 10_000);
      spawned.stdout!.on("data", (chunk: Buffer) => {
        const value = Number(String(chunk).trim());
        if (Number.isInteger(value) && value > 0) {
          clearTimeout(timer);
          resolve(value);
        }
      });
      spawned.on("error", reject);
    });
    return { pid: spawned.pid!, port };
  }

  it("pid+port が一致するサーバーを停止できる", async () => {
    const { pid, port } = await spawnListener();
    const result = await stopServeProcess(pid, port);
    expect(result).toEqual({ ok: true, error: null });
    // 実際にプロセスが消えている（kill 0 が投げる）。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("port が現状と一致しなければ停止しない（pid 再利用ガード）", async () => {
    const { pid, port } = await spawnListener();
    const result = await stopServeProcess(pid, port === 1 ? 2 : port - 1);
    expect(result.ok).toBe(false);
    // 対象プロセスは生きたまま。
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 20_000);

  it("pid<=1 と自プロセスは拒否する", async () => {
    expect((await stopServeProcess(0, 80)).ok).toBe(false);
    expect((await stopServeProcess(process.pid, 80)).ok).toBe(false);
  });
});
