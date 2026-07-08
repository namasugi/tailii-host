// socketHelpers.ts — broker/hook テスト共通の unix socket ハーネス
// Swift 版 BrokerTests/HookTests のヘルパ（connectUnixClient / readLine / waitForEOF /
// startListener）の TS 対応。全 read/wait はタイムアウト付きで決してブロックしない。

import * as net from "node:net";
import * as os from "node:os";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { runBroker } from "../src/broker.js";
import { LineQueue } from "./helpers.js";

/** テスト用の一時 socket パスを生成する（sun_path 長制限内・テスト毎に一意）。 */
export function tempSocketPath(suffix: string): string {
  return `${os.tmpdir()}/pc-${suffix}-${process.pid}.sock`;
}

/** unix domain socket に接続するクライアントを開く（listen 開始前でもリトライで待つ）。 */
export async function connectUnixClient(socketPath: string, retries = 50): Promise<net.Socket> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const socket = await new Promise<net.Socket | null>((resolve) => {
      const s = net.connect(socketPath);
      s.once("connect", () => {
        s.removeAllListeners("error");
        s.on("error", () => {});
        resolve(s);
      });
      s.once("error", () => {
        s.destroy();
        resolve(null);
      });
    });
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`connect 失敗: ${socketPath}`);
}

/** socket の行読み + EOF 監視（行は末尾 \n を除いた文字列で返す）。 */
export class SocketLineReader {
  readonly lines = new LineQueue();
  private buf: Buffer = Buffer.alloc(0);
  private eof = false;
  private eofWaiters: (() => void)[] = [];

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      let idx: number;
      while ((idx = this.buf.indexOf(0x0a)) >= 0) {
        this.lines.push(this.buf.subarray(0, idx).toString("utf8"));
        this.buf = this.buf.subarray(idx + 1);
      }
    });
    const onEOF = (): void => {
      if (this.eof) return;
      this.eof = true;
      for (const waiter of this.eofWaiters) waiter();
      this.eofWaiters = [];
    };
    socket.once("end", onEOF);
    socket.once("close", onEOF);
    socket.on("error", () => {});
  }

  async nextLine(timeoutMs = 5000): Promise<string> {
    return this.lines.next(timeoutMs);
  }

  /** EOF（サーバ側 close）を有界に待つ。 */
  async waitForEOF(timeoutMs = 5000): Promise<void> {
    if (this.eof) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("EOF 待機タイムアウト")), timeoutMs);
      this.eofWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** socket に1行（NDJSON + \n）を書き込む。 */
export function writeLine(socket: net.Socket, line: string): void {
  socket.write(line + "\n");
}

/** broker を in-memory ストリームで駆動するハーネス（Swift 版 pipe 構成と対）。 */
export interface BrokerHarness {
  socketPath: string;
  /** SSH stdin 役（iOS→hook 方向の決定を書く）。 */
  input: PassThrough;
  /** SSH stdout 役（hook→iOS 方向の要求行が届く）。 */
  outputLines: LineQueue;
  done: Promise<void>;
  /** input を EOF にして broker の終了を待つ（未終了なら）。 */
  teardown(): Promise<void>;
}

export function startBroker(
  suffix: string,
  options: Pick<Parameters<typeof runBroker>[0], "sendHello" | "staleDistGuard" | "onStaleDist"> = {},
): BrokerHarness {
  const socketPath = tempSocketPath(suffix);
  const input = new PassThrough();
  const output = new PassThrough();
  const outputLines = new LineQueue();
  const rl = readline.createInterface({ input: output, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => outputLines.push(line));

  const done = runBroker({ socketPath, input, output, ...options });
  done.catch(() => {});

  return {
    socketPath,
    input,
    outputLines,
    done,
    teardown: async () => {
      if (!input.writableEnded) input.end();
      await done.catch(() => {});
      rl.close();
    },
  };
}

/**
 * クライアントが broker の登録簿へ登録済みであることを保証する（Swift 版 ensureRegistered）。
 * register 前に SSH 側から行を流すとブロードキャストが「登録 0 件」に落ちて行が失われる
 * （broker は非解釈・非永続の純中継）。probe 行の往復で登録完了を確定させる。
 */
export async function ensureRegistered(
  client: net.Socket,
  outputLines: LineQueue,
  tag: string,
): Promise<void> {
  const probe = `{"tag":"${tag}","type":"probe"}`;
  writeLine(client, probe);
  const echoed = await outputLines.next(5000);
  if (echoed !== probe) {
    throw new Error(`probe 行の往復が一致しない: expected=${probe} got=${echoed}`);
  }
}

/** 「偽 broker / iPhone」リスナ（hook テストは hook がクライアントなのでサーバを立てる）。 */
export interface FakeListener {
  server: net.Server;
  nextConnection(timeoutMs?: number): Promise<net.Socket>;
  close(): Promise<void>;
}

export async function startListener(socketPath: string): Promise<FakeListener> {
  const pending: net.Socket[] = [];
  const waiters: ((socket: net.Socket) => void)[] = [];
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    accepted.push(socket);
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else pending.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    server,
    nextConnection: (timeoutMs = 5000) => {
      const queued = pending.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("accept タイムアウト")), timeoutMs);
        waiters.push((socket) => {
          clearTimeout(timer);
          resolve(socket);
        });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        // 未読データが残る paused socket は FIN 受信でも閉じないため明示 destroy する
        // （server.close は全接続クローズまで待つ）。
        for (const socket of accepted) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** ファイル出現をポーリングで待つ（broker listen 完了の観測に使う）。 */
export async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const { existsSync } = await import("node:fs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`ファイルが出現しない: ${path}`);
}
