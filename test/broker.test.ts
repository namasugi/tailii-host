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
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { runBroker } from "../src/approval/broker.js";
import {
  connectUnixClient,
  ensureRegistered,
  SocketLineReader,
  startBroker,
  tempSocketPath,
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

  it("通常の EOF では hook 側が FIN を返さなくても終了する", async () => {
    harness = startBroker("half-open");
    (await connectUnixClient(harness.socketPath)).destroy();
    const socket = net.connect({ path: harness.socketPath, allowHalfOpen: true });
    clients.push(socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await ensureRegistered(socket, harness.outputLines, "half-open");
    harness.input.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        harness.done,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("EOF shutdown blocked")), 500); }),
      ]);
    } finally { clearTimeout(timer); socket.destroy(); }
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

  it("同一 session 名で serve が重複起動しても、後発は先発の生きたソケットを奪わず失敗する（承認ハング根治）", async () => {
    // iOS 側の enterChat レース（reconnect と同時進入など）、または同一 session を複数
    // デバイスから同時に開いた場合、同一 session 名の `serve --session <name>` が 2 プロセス
    // 起動しうる。以前は後発が無条件に unlink→listen して先発のパスを奪い、しかも Node の
    // `net.Server.close()` は bind したパスを close 時に自前で unlink するため、奪われた
    // 先発が閉じた瞬間に「今生きている後発」のソケットファイルまで消えていた
    // （以後の hook connect が全て ECONNREFUSED になり、承認が「考え中」のまま永久に
    // ハングする不具合の実根因）。後発は先発が生きている間、奪わず起動失敗しなければならない。
    const socketPath = tempSocketPath("dup-race");
    const inputA = new PassThrough();
    const outputA = new PassThrough();
    const doneA = runBroker({ socketPath, input: inputA, output: outputA });
    doneA.catch(() => {});
    // 先発が listen を終えるまで待つ（接続できることで確認）。
    (await connectUnixClient(socketPath)).destroy();

    // 後発（reconnect 起点などで割り込んだ 2 本目の serve）は先発が生きているため、
    // 解放待ち猶予を使い切ったのち起動失敗する（テストは猶予を短縮注入）。
    const inputB = new PassThrough();
    const outputB = new PassThrough();
    await expect(
      runBroker({
        socketPath,
        input: inputB,
        output: outputB,
        socketWaitGraceMs: 300,
        socketWaitIntervalMs: 50,
      }),
    ).rejects.toThrow(/already in use/);

    // 先発の socket ファイルは無傷で、新規 connect も引き続き成功しなければならない。
    expect(fs.existsSync(socketPath)).toBe(true);
    const stillReachable = await connectUnixClient(socketPath, 5);
    clients.push(stillReachable);

    // 先発自身が閉じれば、正しく削除される。
    inputA.end();
    await doneA;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("同じ端末の再接続は、旧接続の stdin が残っていても listener を引き継ぎ、承認の再送と決定を中継する", async () => {
    const clientId = "11111111-1111-4111-8111-111111111111";
    const old = startBroker("same-client", { clientId });
    try {
      const hook = await connect(old);
      await ensureRegistered(hook.socket, old.outputLines, "before-handoff");
      const request = '{"id":"pending-1","type":"approval_request"}';
      writeLine(hook.socket, request);
      expect(await old.outputLines.next()).toBe(request);

      harness = startBroker("same-client", { clientId, sendHello: true });
      expect(JSON.parse(await harness.outputLines.next()).type).toBe("channel_hello");
      await old.done;
      expect(old.input.writableEnded).toBe(false); // 旧 QUIC の idle timeout を待たない。
      await hook.reader.waitForEOF();
      expect(fs.existsSync(harness.socketPath)).toBe(true);

      // hook は切断後に同じ承認 id で送り直す。新しい接続からの決定が届くことまで検証する。
      const retried = await connect(harness);
      writeLine(retried.socket, request);
      expect(await harness.outputLines.next()).toBe(request);
      const decision = '{"id":"pending-1","decision":"deny","type":"approval_decision"}';
      harness.input.write(decision + "\n");
      expect(await retried.reader.nextLine()).toBe(decision);
      // 旧 input の遅れた終了でも、新 listener の socket は消さない。
      old.input.end();
      expect(fs.existsSync(harness.socketPath)).toBe(true);
    } finally {
      await old.teardown();
    }
  });

  it("別端末の clientId では生きた listener を奪わず、引き継ぎ制御行もアプリへ転送しない", async () => {
    harness = startBroker("other-client", { clientId: "11111111-1111-4111-8111-111111111111" });
    const hook = await connect(harness);
    await ensureRegistered(hook.socket, harness.outputLines, "before-denied-handoff");
    const input = new PassThrough();
    try {
      await expect(runBroker({
        socketPath: harness.socketPath, input, output: new PassThrough(),
        clientId: "22222222-2222-4222-8222-222222222222",
        socketWaitGraceMs: 100, socketWaitIntervalMs: 10,
      })).rejects.toThrow(/already in use/);
      await ensureRegistered(hook.socket, harness.outputLines, "after-denied-handoff");
      expect(fs.existsSync(harness.socketPath)).toBe(true);
    } finally { input.destroy(); }
  });

  it("不正な clientId は listener を触る前に拒否する", async () => {
    await expect(runBroker({
      socketPath: tempSocketPath("invalid-client"), input: new PassThrough(), output: new PassThrough(),
      clientId: "not-a-uuid",
    })).rejects.toThrow("invalid serve client id");
  });

  it("接続が既に閉じていたら、空のパスにも listener を残さない", async () => {
    const socketPath = tempSocketPath("cancelled-before-start");
    const input = new PassThrough(); input.destroy();
    let finished = false;
    const done = runBroker({ socketPath, input, output: new PassThrough() }).finally(() => { finished = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(finished).toBe(true);
    } finally { input.emit("end"); await done; }
  });

  it("起動前の EOF で取り消された後発は、同じ端末の既存 listener を終了させない", async () => {
    const clientId = "11111111-1111-4111-8111-111111111111";
    harness = startBroker("cancelled-handoff", { clientId });
    const hook = await connect(harness);
    await ensureRegistered(hook.socket, harness.outputLines, "before-cancelled-handoff");
    let oldFinished = false;
    void harness.done.then(() => { oldFinished = true; });
    const input = new PassThrough(); input.end();
    const done = runBroker({ socketPath: harness.socketPath, input, output: new PassThrough(), clientId });
    try {
      await done;
      expect(oldFinished).toBe(false);
      await ensureRegistered(hook.socket, harness.outputLines, "after-cancelled-handoff");
    } finally { input.destroy(); }
  });

  it("listener 解放待ち中の取り消しは待機を打ち切り、他端末の listener を維持する", async () => {
    harness = startBroker("cancelled-during-wait", { clientId: "11111111-1111-4111-8111-111111111111" });
    const hook = await connect(harness);
    await ensureRegistered(hook.socket, harness.outputLines, "before-wait");
    const input = new PassThrough();
    const done = runBroker({
      socketPath: harness.socketPath, input, output: new PassThrough(),
      clientId: "22222222-2222-4222-8222-222222222222", socketWaitIntervalMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.destroy();
    await done;
    await ensureRegistered(hook.socket, harness.outputLines, "after-wait-cancelled");
  });

  it("起動中の stdin EOF でも改行なしの最後の決定を落とさない", async () => {
    harness = startBroker("partial-eof");
    const hook = await connect(harness);
    await ensureRegistered(hook.socket, harness.outputLines, "before-partial-eof");
    const bytes = new Promise<string>((resolve) => hook.socket.once("data", (chunk) => resolve(chunk.toString())));
    const decision = '{"type":"approval_decision","id":"last","decision":"deny"}';
    harness.input.end(decision);
    expect(await bytes).toBe(decision);
    await hook.reader.waitForEOF();
    await harness.done;
  });

  it("空の socket パスへの同時起動でも、後発が先発の新しい listener を unlink しない", async () => {
    const socketPath = tempSocketPath("simultaneous-start");
    const inputA = new PassThrough(); const inputB = new PassThrough();
    const outputA = new PassThrough(); const outputB = new PassThrough();
    const doneA = runBroker({ socketPath, input: inputA, output: outputA, sendHello: true });
    const doneB = runBroker({ socketPath, input: inputB, output: outputB, sendHello: true });
    const outcomes = [doneA, doneB].map((done) => done.then(() => "closed", () => "occupied"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([
        ...outcomes,
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("both-listening"), 1000); }),
      ])).toBe("occupied");
      const ownerOutput = outputA.readableLength > 0 ? outputA : outputB;
      expect(ownerOutput.read().toString()).toContain("channel_hello");
      const client = await connectUnixClient(socketPath);
      clients.push(client);
      const forwarded = new Promise<string>((resolve) => ownerOutput.once("data", (line) => resolve(line.toString())));
      writeLine(client, '{"type":"probe","id":"still-owned"}');
      expect(await forwarded).toContain("still-owned");
    } finally {
      clearTimeout(timer); inputA.end(); inputB.end();
      for (const client of clients) client.destroy();
      await Promise.allSettled([doneA, doneB]);
    }
  });

  it("先発が解放待ち猶予内に閉じれば、後発が同一 socket パスを引き継いで listen できる", async () => {
    // iOS の chat 離脱（旧 serve チャネル close）と同一会話の開き直し（新 serve 起動）は
    // 非同期に競走する。後発は即失敗せず、先発の解放を猶予内で待ってから引き継ぐこと。
    const socketPath = tempSocketPath("takeover-grace");
    const inputA = new PassThrough();
    const outputA = new PassThrough();
    const doneA = runBroker({ socketPath, input: inputA, output: outputA });
    doneA.catch(() => {});
    (await connectUnixClient(socketPath)).destroy();

    // 後発を起動してから少し遅れて先発を閉じる（close 完了前に後発が probe する形を再現）。
    const inputB = new PassThrough();
    const outputB = new PassThrough();
    const doneB = runBroker({
      socketPath,
      input: inputB,
      output: outputB,
      socketWaitGraceMs: 3000,
      socketWaitIntervalMs: 50,
    });
    doneB.catch(() => {});
    setTimeout(() => inputA.end(), 150);
    await doneA;

    // 後発が引き継いで listen し、新規 connect が成功する（≒承認要求が再び届く）。
    const client = await connectUnixClient(socketPath, 40);
    clients.push(client);

    inputB.end();
    await doneB;
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
