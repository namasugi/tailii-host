// pairingServer.test.ts — setup のペアリング待受ループ（v1.2）と 1 行ステータス表示のテスト。
//
// 契約: 待受は成立するまで（総待受時間内で）接続を受け続ける。SAS の期限切れ・不正 hello で
// 接続が閉じても次の接続を受理し、server_key には ttl（秒）を載せる。

import * as crypto from "node:crypto";
import * as net from "node:net";
import { describe, expect, it } from "vitest";
import { parsePairingMessage, x25519PublicKeyObjectToRaw } from "../src/commands/pairingCode.js";
import { runCodePairingServer, type CodePairingServerOutput } from "../src/commands/setup.js";
import { StatusLine, formatRemaining } from "../src/commands/statusLine.js";

// MARK: - formatRemaining / StatusLine

describe("formatRemaining", () => {
  it("m:ss に整形し、秒は切り上げ・負値は 0:00", () => {
    expect(formatRemaining(600_000)).toBe("10:00");
    expect(formatRemaining(59_001)).toBe("1:00");
    expect(formatRemaining(41_000)).toBe("0:41");
    expect(formatRemaining(500)).toBe("0:01");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-3000)).toBe("0:00");
  });
});

function fakeOut(isTTY: boolean): { out: { isTTY: boolean; write(text: string): boolean }; chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    out: {
      isTTY,
      write(text: string) {
        chunks.push(text);
        return true;
      },
    },
  };
}

describe("StatusLine", () => {
  it("TTY では同じ行を \\r で書き換え、stop(final) で置き換えて改行する", async () => {
    const { out, chunks } = fakeOut(true);
    const line = new StatusLine(out, 5);
    let tick = 0;
    line.start(() => `残り ${tick++}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    line.stop("完了");
    expect(chunks[0]).toBe("\r残り 0");
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.at(-2)).toMatch(/^\r完了 */);
    expect(chunks.at(-1)).toBe("\n");
    // 二重 stop は何も出さない。
    line.stop("again");
    expect(chunks.at(-1)).toBe("\n");
  });

  it("非 TTY では開始時と確定時の 2 行だけ出す（書き換えない）", async () => {
    const { out, chunks } = fakeOut(false);
    const line = new StatusLine(out, 5);
    line.start(() => "待受中…");
    await new Promise((resolve) => setTimeout(resolve, 20));
    line.stop("接続がありました");
    expect(chunks).toEqual(["待受中…\n", "接続がありました\n"]);
  });

  it("final なしの stop は TTY では改行だけ、非 TTY では何も出さない", () => {
    const tty = fakeOut(true);
    const ttyLine = new StatusLine(tty.out, 1000);
    ttyLine.start(() => "x");
    ttyLine.stop();
    expect(tty.chunks).toEqual(["\rx", "\n"]);

    const plain = fakeOut(false);
    const plainLine = new StatusLine(plain.out, 1000);
    plainLine.start(() => "x");
    plainLine.stop();
    expect(plain.chunks).toEqual(["x\n"]);
  });
});

// MARK: - runCodePairingServer（実 TCP・時間注入）

function makeOutput(): { out: CodePairingServerOutput; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: {
      stdout: { isTTY: false, write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) },
    },
  };
}

async function listen(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return { server, port: address.port };
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function readLine(socket: net.Socket, timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    const done = (value: string | null): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx >= 0) done(buffer.slice(0, idx));
    };
    const onClose = (): void => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

function waitClose(socket: net.Socket, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.closed) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("runCodePairingServer", () => {
  it("失敗・期限切れの後も待受を続け、server_key に ttl を載せ、総待受時間で終了する", async () => {
    const { server, port } = await listen();
    const output = makeOutput();
    const registered: string[] = [];
    const done = runCodePairingServer(server, {
      payloadJSON: () => '{"v":1}',
      payloadJSONNoKey: '{"v":4}',
      psk: Buffer.alloc(32, 1),
      registerClientKey: (line) => registered.push(line),
      lanIP: "127.0.0.1",
      port,
      out: output.out,
      timing: { waitTotalMs: 1500, sasTtlMs: 100, stepTimeoutMs: 200 },
    });

    // 1) 不正 hello → 接続は閉じるが待受は残る。
    const first = await connect(port);
    first.write("garbage\n");
    expect(await waitClose(first)).toBe(true);
    expect(output.stdout.join("")).toContain("iPhone から接続がありました（1/5 回目）。");
    expect(output.stderr.join("")).toContain("ペアリングを中止しました: invalid hello（引き続き待ち受けます）");

    // 2) 正しい hello → server_key（ttl=1 秒: 100ms 切り上げ）→ reveal を送らずステップ timeout。
    const keypair = crypto.generateKeyPairSync("x25519");
    const pubRaw = x25519PublicKeyObjectToRaw(keypair.publicKey);
    const commit = crypto.createHash("sha256").update(pubRaw).digest().toString("base64");
    const second = await connect(port);
    second.write(`{"t":"hello","v":1,"commit":"${commit}","cpk":1}\n`);
    const serverKeyLine = await readLine(second);
    expect(serverKeyLine).not.toBeNull();
    const serverKey = parsePairingMessage(serverKeyLine!);
    expect(serverKey?.t).toBe("server_key");
    if (serverKey?.t !== "server_key") throw new Error("unreachable");
    expect(serverKey.ttl).toBe(1);
    expect(serverKey.ck).toBe(1);
    expect(await waitClose(second)).toBe(true);
    expect(output.stderr.join("")).toContain("ペアリングを中止しました: timeout（引き続き待ち受けます）");

    // 3) reveal まで進めてコードを表示させ、confirm を送らず SAS 期限切れ → 再発行案内。
    const third = await connect(port);
    third.write(`{"t":"hello","v":1,"commit":"${commit}"}\n`);
    expect(await readLine(third)).toContain('"t":"server_key"');
    third.write(`{"t":"reveal","epk":"${pubRaw.toString("base64")}"}\n`);
    expect(await waitClose(third)).toBe(true);
    const stdout = output.stdout.join("");
    expect(stdout).toMatch(/ペアリングコード: \d{6}  （残り 0:01）/);
    expect(stdout).toMatch(/ペアリングコード: \d{6}  は期限切れになりました。iPhone で「コードを再発行」/);

    // 4) 総待受時間（1.5s）で終了。
    expect(await done).toBe(0);
    expect(output.stdout.join("")).toContain("ペアリングの待受を終了しました（0:02 経過）");
    expect(registered).toEqual([]);
    expect(server.listening).toBe(false);
  }, 10_000);
});

describe("runCodePairingServer 試行回数の上限", () => {
  it("接続回数が上限に達したら待受を終了して 1 を返す（MITM のホスト側 SAS 衝突探索を封じる）", async () => {
    const { server, port } = await listen();
    const output = makeOutput();
    const done = runCodePairingServer(server, {
      payloadJSON: () => '{"v":1}',
      payloadJSONNoKey: '{"v":4}',
      psk: Buffer.alloc(32, 1),
      registerClientKey: () => {},
      lanIP: "127.0.0.1",
      port,
      out: output.out,
      timing: { waitTotalMs: 5000, sasTtlMs: 100, stepTimeoutMs: 200, maxAttempts: 2 },
    });

    const first = await connect(port);
    first.write("garbage\n");
    expect(await waitClose(first)).toBe(true);
    expect(output.stderr.join("")).toContain("invalid hello（引き続き待ち受けます）");

    const second = await connect(port);
    second.write("garbage\n");
    expect(await waitClose(second)).toBe(true);
    expect(output.stderr.join("")).toContain("invalid hello（接続回数の上限に達したため終了します）");

    expect(await done).toBe(1);
    expect(output.stdout.join("")).toContain("ペアリングの待受を終了しました（接続 2 回の上限）");
    expect(server.listening).toBe(false);
  }, 10_000);

  it("相手が切断したら「期限切れ」ではなく closed として報告する", async () => {
    const { server, port } = await listen();
    const output = makeOutput();
    const done = runCodePairingServer(server, {
      payloadJSON: () => '{"v":1}',
      payloadJSONNoKey: '{"v":4}',
      psk: Buffer.alloc(32, 1),
      registerClientKey: () => {},
      lanIP: "127.0.0.1",
      port,
      out: output.out,
      timing: { waitTotalMs: 800, sasTtlMs: 5000, stepTimeoutMs: 5000, maxAttempts: 5 },
    });
    const keypair = crypto.generateKeyPairSync("x25519");
    const pubRaw = x25519PublicKeyObjectToRaw(keypair.publicKey);
    const commit = crypto.createHash("sha256").update(pubRaw).digest().toString("base64");
    const socket = await connect(port);
    socket.write(`{"t":"hello","v":1,"commit":"${commit}"}\n`);
    expect(await readLine(socket)).toContain('"t":"server_key"');
    socket.write(`{"t":"reveal","epk":"${pubRaw.toString("base64")}"}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // iPhone 側のキャンセル相当: confirm を送らずに切断。
    socket.end();
    expect(await done).toBe(0);
    const stderr = output.stderr.join("");
    expect(stderr).toContain("ペアリングを中止しました: closed（引き続き待ち受けます）");
    expect(output.stdout.join("")).not.toContain("期限切れになりました");
  }, 10_000);
});
