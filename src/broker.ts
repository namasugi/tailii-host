// broker.ts
// tailii (TS host) — serve サブコマンド実装（Swift 版 Broker.swift の移植）
//
// unix domain socket と SSH stdio (input/output) の間で NDJSON 行を純中継する。
// 承認判断・メッセージ解釈は一切行わない（Hook が唯一の意思決定点）。
//
// 非解釈リレー（N クライアント対応、Swift 版と同一挙動）:
//   - 複数 hook クライアントを同時受理し、hook→SSH 方向は完全行単位で output へ fan-in
//     （Node は単一スレッドなので write は行単位に自然直列化され混線しない）。
//   - SSH→hook 方向は input の完全行を登録中の全クライアントへブロードキャスト
//     （宛先選別なし＝各 hook が自 id を照合）。購読者ゼロ時は行を保持しない（非永続）。
//   - channel_hello を含むあらゆる行を非解釈で透過する。
//   - SSH 断（input EOF）→ 全クライアント socket を閉じ（各 hook EOF→deny, 5.6）、
//     listen を止めて socket ファイルを削除して終了する。
//   - EOF 時の残余バッファ（改行なしの部分行）は Swift 版同様そのまま転送する。

import * as fs from "node:fs";
import * as net from "node:net";
import type { Readable, Writable } from "node:stream";
import { resolveSocketPath } from "./socketPath.js";
import { encodeControlMessage, PROTOCOL_MAX_SUPPORTED, PROTOCOL_V1 } from "./protocol.js";
import { createStaleDistGuard, isStaleDist, readPackageVersion, type StaleDistGuard } from "./version.js";

/** 行分割器: チャンクを積み、完全行（末尾 \n 込み）ごとに onLine を呼ぶ。 */
function makeLineFeeder(onLine: (line: Buffer) => void): {
  push(chunk: Buffer): void;
  flush(): void;
} {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let idx: number;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        onLine(buf.subarray(0, idx + 1));
        buf = buf.subarray(idx + 1);
      }
    },
    flush(): void {
      if (buf.length > 0) {
        onLine(buf);
        buf = Buffer.alloc(0);
      }
    },
  };
}

export interface RunBrokerOptions {
  socketPath: string;
  /** "stdin" 側（iOS→hook 方向の決定が流れてくる）。 */
  input: Readable;
  /** "stdout" 側（hook→iOS 方向の要求を流す）。 */
  output: Writable;
  /** 診断ログ出力先（省略時は無音。CLI は stderr を渡す）。 */
  log?: (message: string) => void;
  /** 起動時 package version と現在の package version を比較する stale 判定（テスト注入用）。 */
  staleDistGuard?: StaleDistGuard | null;
  /** stale dist 検出時の通知（テスト観測用）。 */
  onStaleDist?: () => void;
  /** 起動直後に SSH 側へ channel_hello を送る（CLI の serve 経路で有効）。 */
  sendHello?: boolean;
}

/**
 * unix socket と input/output の間を双方向中継する非解釈リレーの本体。
 * input EOF（SSH 断）で全クライアントを閉じ、socket ファイルを削除して resolve する。
 */
/**
 * `socketPath` に既に生きた listener がいるかを probe する（reject せず bool で返す）。
 * 同一 session 名の serve が重複起動されうる（iOS 側の enterChat レース、または同一
 * session を複数デバイスから同時に開いた場合）。無条件に unlink→listen すると生きている
 * 側の listen 中ソケットを奪ってしまい、しかも Node の `net.Server.close()` は bind した
 * パスを close 時に自動 unlink するため、奪われた側が閉じた瞬間に「今生きている方」の
 * ソケットファイルまで消える（以後の hook connect が全て ECONNREFUSED になり、承認が
 * 「考え中」のまま永久にハングする不具合の実根因）。奪う前に生存確認する。
 */
function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function runBroker(options: RunBrokerOptions): Promise<void> {
  const { socketPath, input, output } = options;
  const log = options.log ?? (() => {});
  const staleDistGuard = options.staleDistGuard ?? createStaleDistGuard();

  // 既存 socket ファイルが生きていれば奪わず諦める（上記コメント参照）。
  // 生きていなければ（前回異常終了のスタール残骸）安全に削除して bind し直す
  // （Swift 版 unlink→bind と同一の後始末）。
  if (await isSocketAlive(socketPath)) {
    throw new Error(`socket already in use by a live listener: ${socketPath}`);
  }
  fs.rmSync(socketPath, { force: true });

  const clients = new Set<net.Socket>();
  let registryClosed = false;
  let shutdownRequested = false;
  let resolveBroker: (() => void) | null = null;
  let server: net.Server;

  const finishBroker = (): void => {
    if (registryClosed) return;
    registryClosed = true;
    for (const client of clients) client.end();
    // `net.Server.close()` は bind したパスの socket ファイルを自前で unlink するため
    // （Node 内部仕様）、ここで追加の fs.rmSync は不要（かつ、上の isSocketAlive ガードにより
    // このプロセスは常にこのパスの正当な唯一の所有者として起動しているため安全）。
    server.close(() => {});
    resolveBroker?.();
  };

  /** 1 完全行を SSH (output) へ書き込む（失敗は無視 — Swift 版 try? と同一）。 */
  const writeLineToSSH = (line: Buffer): void => {
    try {
      output.write(line);
    } catch {
      // 書込先が閉じていても中継自体は継続する。
    }
  };

  /** 1 完全行を全生存クライアントへブロードキャストする（5.4）。 */
  const broadcast = (line: Buffer): void => {
    for (const client of clients) {
      try {
        client.write(line);
      } catch {
        client.destroy();
      }
    }
  };

  server = net.createServer((client) => {
    if (registryClosed) {
      client.destroy();
      return;
    }
    clients.add(client);
    log(`[tailii-host serve] hook クライアント接続\n`);
    if (isStaleDist(staleDistGuard)) {
      shutdownRequested = true;
      log("[tailii-host serve] stale dist を検出、再起動のため終了\n");
      options.onStaleDist?.();
    }

    const feeder = makeLineFeeder(writeLineToSSH);
    client.on("data", (chunk) => feeder.push(chunk));
    // クライアント切断: 残余バッファをフラッシュして登録簿から除去する。
    client.on("end", () => feeder.flush());
    client.on("error", () => {});
    client.on("close", () => {
      clients.delete(client);
      log(`[tailii-host serve] hook クライアント切断\n`);
      if (shutdownRequested && clients.size === 0) finishBroker();
    });
  });
  server.maxConnections = 16;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  log(`[tailii-host serve] listening on ${socketPath}\n`);
  if (options.sendHello === true) {
    const helloVersion = staleDistGuard?.startupVersion ?? readPackageVersion() ?? undefined;
    writeLineToSSH(Buffer.from(encodeControlMessage({
      type: "channel_hello",
      v: PROTOCOL_V1,
      maxVersion: PROTOCOL_MAX_SUPPORTED,
      ...(helloVersion !== undefined ? { serverVersion: helloVersion } : {}),
    }) + "\n", "utf8"));
  }
  if (isStaleDist(staleDistGuard)) {
    shutdownRequested = true;
    log("[tailii-host serve] stale dist を検出、再起動のため終了\n");
    options.onStaleDist?.();
    finishBroker();
  }

  // SSH リーダ: input → 全クライアントへブロードキャスト。EOF で全体を終了させる。
  await new Promise<void>((resolve) => {
    resolveBroker = resolve;
    if (registryClosed) {
      resolve();
      return;
    }
    const feeder = makeLineFeeder(broadcast);
    const finish = (): void => {
      feeder.flush();
      finishBroker();
      log(`[tailii-host serve] stdin→broadcast: EOF\n`);
    };
    input.on("data", (chunk: Buffer) => feeder.push(chunk));
    input.once("end", finish);
    input.once("error", finish);
  });
}

/** serve サブコマンドのエントリポイント（`--session <name>` | `--socket <path>`）。 */
export async function runServeCommand(args: string[]): Promise<number> {
  let socketPath: string | null = null;
  try {
    socketPath = parseServeArgs(args);
  } catch (error) {
    process.stderr.write(`[tailii-host serve] エラー: ${String(error)}\n`);
    process.stderr.write("使い方: tailii serve --session <name> | --socket <path>\n");
    return 1;
  }

  process.stderr.write(`[tailii-host serve] socket: ${socketPath}\n`);
  try {
    await runBroker({
      socketPath,
      input: process.stdin,
      output: process.stdout,
      log: (message) => process.stderr.write(message),
      sendHello: true,
    });
  } catch (error) {
    process.stderr.write(`[tailii-host serve] 異常終了: ${String(error)}\n`);
    return 1;
  }
  return 0;
}

/** 引数から socket パスを導出する（Swift 版 parseServeArgs と同一: 最初の一致で確定）。 */
function parseServeArgs(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--session") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--session の値がありません");
      return resolveSocketPath(value);
    }
    if (args[i] === "--socket") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--socket の値がありません");
      return value;
    }
  }
  throw new Error("--session または --socket が必要");
}
