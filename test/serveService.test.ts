// serveService.test.ts — LISTEN 中サーバー列挙と停止（serve-list）
//
// パーサは固定サンプルで検証し、列挙/停止は実ソケット・実子プロセスで
// エンドツーエンドに検証する（lsof は macOS / Linux CI どちらにもある）。

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";

import {
  listServeProcesses,
  parseHtmlTitle,
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

describe("parseHtmlTitle", () => {
  it("<title> の中身を取り出し空白を畳む", () => {
    expect(parseHtmlTitle("<html><head><title>My App</title></head></html>")).toBe("My App");
    expect(parseHtmlTitle("<TITLE data-x='1'>\n  Vite\n  App \n</TITLE>")).toBe("Vite App");
  });

  it("文字参照を復号する", () => {
    expect(parseHtmlTitle("<title>A &amp; B &lt;C&gt; &#x2764; &#33;</title>")).toBe("A & B <C> ❤ !");
  });

  it("title なし・空 title は null", () => {
    expect(parseHtmlTitle("<html><body>hi</body></html>")).toBeNull();
    expect(parseHtmlTitle("<title>   </title>")).toBeNull();
  });

  it("長い title は切り詰める", () => {
    const long = "x".repeat(200);
    expect(parseHtmlTitle(`<title>${long}</title>`)).toBe(`${"x".repeat(80)}…`);
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

  it("withTitles で HTML サーバーの <title> を付与し、非 HTML には付けない", async () => {
    const htmlServer = http.createServer((_, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><head><title>Demo Site</title></head><body>ok</body></html>");
    });
    // IPv6 loopback のみで LISTEN するサーバーにも title が付くこと。
    const v6Server = http.createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<title>V6 Only</title>");
    });
    const rawServer = net.createServer();
    // fetch の接続プール（keep-alive）が close を無限に待たせるため、
    // 終了時は残存接続を強制破棄する。
    const rawSockets = new Set<net.Socket>();
    rawServer.on("connection", (socket) => {
      rawSockets.add(socket);
      socket.on("close", () => rawSockets.delete(socket));
    });
    const listenHttp = new Promise<number>((resolve) => {
      htmlServer.listen(0, "127.0.0.1", () => {
        resolve((htmlServer.address() as net.AddressInfo).port);
      });
    });
    const listenV6 = new Promise<number>((resolve) => {
      v6Server.listen(0, "::1", () => {
        resolve((v6Server.address() as net.AddressInfo).port);
      });
    });
    const listenRaw = new Promise<number>((resolve) => {
      rawServer.listen(0, "127.0.0.1", () => {
        resolve((rawServer.address() as net.AddressInfo).port);
      });
    });
    const [htmlPort, v6Port, rawPort] = await Promise.all([listenHttp, listenV6, listenRaw]);
    try {
      const entries = await listServeProcesses({ withTitles: true });
      const find = (port: number) =>
        entries.find((entry) => entry.pid === process.pid && entry.port === port);
      expect(find(htmlPort)?.title).toBe("Demo Site");
      expect(find(v6Port)?.title).toBe("V6 Only");
      const rawEntry = find(rawPort);
      expect(rawEntry).toBeDefined();
      expect(rawEntry!.title).toBeUndefined();
    } finally {
      htmlServer.closeAllConnections();
      v6Server.closeAllConnections();
      for (const socket of rawSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => htmlServer.close(() => resolve())),
        new Promise<void>((resolve) => v6Server.close(() => resolve())),
        new Promise<void>((resolve) => rawServer.close(() => resolve())),
      ]);
    }
  }, 20_000);

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
