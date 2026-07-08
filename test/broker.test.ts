// broker.test.ts — Broker (serve) 双方向中継テスト（Swift 版 BrokerTests の移植）
//
// Broker は unix socket と input/output を純中継する。テストは「仮想 stdin/stdout
// (PassThrough)」と「unix socket クライアント (hook 側模擬)」でヘルメティックに検証する。
//
// 注: Swift 版テスト 10（ClientRegistry.unregister の close 単一所有者）は Swift 実装の
// 二重 close 防止規律に固有のもので、Node（GC + イベント駆動）には該当構造が無いため
// 移植しない。挙動面（SSH 断で全クライアント EOF・broker 正常終了）はテスト 8/11 が担保する。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import type * as net from "node:net";
import {
  connectUnixClient,
  ensureRegistered,
  SocketLineReader,
  startBroker,
  writeLine,
  type BrokerHarness,
} from "./socketHelpers.js";

describe("Broker — 双方向中継", () => {
  let harness: BrokerHarness | null = null;
  let clients: net.Socket[] = [];

  afterEach(async () => {
    for (const client of clients) client.destroy();
    clients = [];
    if (harness) {
      await harness.teardown();
      fs.rmSync(harness.socketPath, { force: true });
      harness = null;
    }
  });

  async function connect(h: BrokerHarness): Promise<{ socket: net.Socket; reader: SocketLineReader }> {
    const socket = await connectUnixClient(h.socketPath);
    clients.push(socket);
    return { socket, reader: new SocketLineReader(socket) };
  }

  it("stdin の行が socket クライアントへ中継される", async () => {
    harness = startBroker("stdin-to-sock");
    const { socket, reader } = await connect(harness);
    await ensureRegistered(socket, harness.outputLines, "stdin-to-sock");

    const testLine = '{"cwd":"/tmp","decision":"allow","id":"test-1","type":"approval_decision"}';
    harness.input.write(testLine + "\n");
    expect(await reader.nextLine()).toBe(testLine);
  });

  it("socket クライアントの行が stdout へ中継される", async () => {
    harness = startBroker("sock-to-stdout");
    const { socket } = await connect(harness);

    const testLine =
      '{"cwd":"/tmp","id":"test-2","summary":"echo hello","tool":"Bash","type":"approval_request"}';
    writeLine(socket, testLine);
    expect(await harness.outputLines.next()).toBe(testLine);
  });

  it("双方向中継が同時に機能する", async () => {
    harness = startBroker("bidir");
    const { socket, reader } = await connect(harness);
    await ensureRegistered(socket, harness.outputLines, "bidir");

    // 方向A: stdin → socket
    const decisionLine = '{"cwd":"/tmp","decision":"deny","id":"bd-1","type":"approval_decision"}';
    harness.input.write(decisionLine + "\n");
    expect(await reader.nextLine()).toBe(decisionLine);

    // 方向B: socket → stdout
    const requestLine =
      '{"cwd":"/tmp","id":"bd-1","summary":"rm -rf /","tool":"Bash","type":"approval_request"}';
    writeLine(socket, requestLine);
    expect(await harness.outputLines.next()).toBe(requestLine);
  });

  it("stdin EOF でソケットクライアントが閉じられる (Req 5.2)", async () => {
    harness = startBroker("eof-test");
    const { socket, reader } = await connect(harness);
    await ensureRegistered(socket, harness.outputLines, "eof-test");

    // stdin を閉じて EOF を送る (SSH チャネルが閉じた状況を模擬)
    harness.input.end();
    await reader.waitForEOF();
  });

  it("SSH 側決定行が接続中の全クライアントへブロードキャストされる (Req 5.4)", async () => {
    harness = startBroker("broadcast");
    const a = await connect(harness);
    const b = await connect(harness);
    await ensureRegistered(a.socket, harness.outputLines, "bc-A");
    await ensureRegistered(b.socket, harness.outputLines, "bc-B");

    const decisionLine = '{"cwd":"/tmp","decision":"deny","id":"bc-1","type":"approval_decision"}';
    harness.input.write(decisionLine + "\n");
    expect(await a.reader.nextLine()).toBe(decisionLine);
    expect(await b.reader.nextLine()).toBe(decisionLine);
  });

  it("複数クライアントの行が SSH 側で混線せず完全行で届く (4.2)", async () => {
    harness = startBroker("fanin");
    const a = await connect(harness);
    const b = await connect(harness);

    const linesA = Array.from({ length: 20 }, (_, i) =>
      `{"id":"A","seq":${i},"tool":"Bash","type":"approval_request","pad":"${"A".repeat(30)}"}`,
    );
    const linesB = Array.from({ length: 20 }, (_, i) =>
      `{"id":"B","seq":${i},"tool":"Bash","type":"approval_request","pad":"${"B".repeat(30)}"}`,
    );
    for (const line of linesA) writeLine(a.socket, line);
    for (const line of linesB) writeLine(b.socket, line);

    const expected = new Set([...linesA, ...linesB]);
    for (let i = 0; i < 40; i += 1) {
      const line = await harness.outputLines.next();
      expect(expected.has(line), `混線または破損した行を受信: ${line}`).toBe(true);
      expected.delete(line);
    }
    expect(expected.size).toBe(0);
  });

  it("SSH 断 (stdin EOF) で全クライアント socket が閉じられる (Req 5.6)", async () => {
    harness = startBroker("eof-all");
    const a = await connect(harness);
    const b = await connect(harness);
    await ensureRegistered(a.socket, harness.outputLines, "eof-all-A");
    await ensureRegistered(b.socket, harness.outputLines, "eof-all-B");

    harness.input.end();
    await a.reader.waitForEOF();
    await b.reader.waitForEOF();
  });

  it("channel_hello が確立直後に双方向で透過される（非解釈）", async () => {
    harness = startBroker("hello");
    const { socket, reader } = await connect(harness);
    await ensureRegistered(socket, harness.outputLines, "hello");

    // hook → SSH 方向
    const helloUp = '{"maxVersion":1,"type":"channel_hello","v":1}';
    writeLine(socket, helloUp);
    expect(await harness.outputLines.next()).toBe(helloUp);

    // SSH → hook 方向
    const helloDown = '{"maxVersion":1,"type":"channel_hello","v":1}';
    harness.input.write(helloDown + "\n");
    expect(await reader.nextLine()).toBe(helloDown);
  });

  it("serve broker は起動直後の hello に serverVersion を載せられる", async () => {
    harness = startBroker("serve-hello", {
      sendHello: true,
      staleDistGuard: { startupVersion: "0.1.0", currentVersion: () => "0.1.0" },
    });

    expect(await harness.outputLines.next()).toBe(
      '{"maxVersion":2,"serverVersion":"0.1.0","type":"channel_hello","v":1}',
    );
  });

  it("serve broker は hook 接続時の stale dist を承認中継完了後に終了する", async () => {
    let currentVersion = "0.1.0";
    let staleNotified = false;
    harness = startBroker("serve-stale", {
      sendHello: true,
      staleDistGuard: { startupVersion: "0.1.0", currentVersion: () => currentVersion },
      onStaleDist: () => {
        staleNotified = true;
      },
    });
    await harness.outputLines.next();
    currentVersion = "0.2.0";

    const { socket } = await connect(harness);
    const requestLine =
      '{"cwd":"/tmp","id":"stale-1","summary":"echo stale","tool":"Bash","type":"approval_request","v":1}';
    writeLine(socket, requestLine);
    expect(await harness.outputLines.next()).toBe(requestLine);
    expect(staleNotified).toBe(true);

    socket.end();
    await harness.done;
    expect(fs.existsSync(harness.socketPath)).toBe(false);
  });

  it("SSH 断で N クライアント全てが EOF になり broker が正常終了する (Req 5.6)", async () => {
    harness = startBroker("n-clients");
    const connected = [];
    for (let i = 0; i < 5; i += 1) connected.push(await connect(harness));
    for (let i = 0; i < 5; i += 1) {
      await ensureRegistered(connected[i]!.socket, harness.outputLines, `ndc-${i}`);
    }

    harness.input.end();
    for (const { reader } of connected) await reader.waitForEOF();

    // broker 本体も正常終了し socket ファイルが削除されるはず。
    await harness.done;
    expect(fs.existsSync(harness.socketPath)).toBe(false);
  });

  it("ブローカ終了後に socket ファイルが削除される", async () => {
    harness = startBroker("cleanup");
    const { socket } = await connect(harness);
    expect(fs.existsSync(harness.socketPath)).toBe(true);

    harness.input.end();
    socket.destroy();
    await harness.done;
    expect(fs.existsSync(harness.socketPath)).toBe(false);
  });
});
