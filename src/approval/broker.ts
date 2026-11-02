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
//   - SSH 断（input EOF）→ 全クライアント socket を閉じ（各 hook は EOF を切断と検知して
//     retry-connect フォールバックへ, hook.ts 参照）、
//     listen を止めて socket ファイルを削除して終了する。
//   - EOF 時の残余バッファ（改行なしの部分行）は Swift 版同様そのまま転送する。

import * as fs from "node:fs";
import * as net from "node:net";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { resolveSocketPath } from "../shared/socketPath.js";
import { sleep } from "../shared/sleep.js";
import { encodeControlMessage, PROTOCOL_MAX_SUPPORTED, PROTOCOL_V1 } from "../protocol.js";
import { createStaleDistGuard, isStaleDist, readPackageVersion, type StaleDistGuard } from "../shared/version.js";

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
  /**
   * 先発 listener の解放待ち猶予（ms）。iOS が chat 離脱で旧 serve チャネルを閉じた直後に
   * 同一会話を開き直すと、旧 serve の終了（socket 解放）と新 serve の起動が競走する。
   * 即失敗にせず短時間だけ解放を待って引き継ぐ（猶予内に解放されなければ従来どおり失敗）。
   */
  socketWaitGraceMs?: number;
  /** 解放待ちの再確認間隔（ms）。 */
  socketWaitIntervalMs?: number;
  /** 同じアプリの再接続だけが旧 listener を解放できる、インストール単位の UUID。 */
  clientId?: string;
}

const HANDOFF_TYPE = "tailii_serve_handoff_v1";
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 同じ端末の旧 serve に正常終了を頼む。PID kill や生きた socket の unlink はしない。 */
async function requestHandoff(socketPath: string, clientId: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(finish, 250);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      socket.destroy();
      resolve();
    }
    socket.once("connect", () => {
      if (signal.aborted) { finish(); return; }
      socket.write(JSON.stringify({ type: HANDOFF_TYPE, clientId }) + "\n");
    });
    socket.once("error", finish);
    socket.once("end", finish);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
    socket.resume();
  });
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
function isSocketAlive(socketPath: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(socketPath);
    const timer = setTimeout(() => finish(false, new Error("serve socket probe timed out")), 500);
    const abort = (): void => finish(false);
    function finish(alive: boolean, error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      probe.destroy();
      if (error) reject(error); else resolve(alive);
    }
    probe.once("connect", () => finish(true));
    probe.once("error", (error: NodeJS.ErrnoException) => {
      // 権限・資源不足・応答遅延を「死んだ socket」と誤認して unlink しない。
      finish(false, error.code === "ENOENT" || error.code === "ECONNREFUSED" ? undefined : error);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function socketStat(socketPath: string): fs.Stats | undefined {
  try { return fs.lstatSync(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runBroker(options: RunBrokerOptions): Promise<void> {
  if (options.input.destroyed || options.input.readableEnded) return;
  // 起動待ちの間も元 stdin を読み、EOF/キャンセルを観測する。決定行は中間 stream に保持し、
  // listen 後に従来どおり中継する（end を観測するためにデータを捨てない）。
  const buffered = new PassThrough();
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); buffered.destroy(); };
  options.input.once("end", abort);
  options.input.once("close", abort);
  options.input.once("error", abort);
  options.input.pipe(buffered);
  try {
    await runActiveBroker({ ...options, input: buffered }, controller.signal);
  } finally {
    options.input.unpipe(buffered);
    options.input.removeListener("end", abort);
    options.input.removeListener("close", abort);
    options.input.removeListener("error", abort);
    buffered.destroy();
  }
}

async function runActiveBroker(options: RunBrokerOptions, signal: AbortSignal): Promise<void> {
  const { socketPath, input, output } = options;
  const log = options.log ?? (() => {});
  const staleDistGuard = options.staleDistGuard ?? createStaleDistGuard();
  const clientId = options.clientId;
  if (clientId !== undefined && !CLIENT_ID.test(clientId)) throw new Error("invalid serve client id");

  // 既存 socket ファイルが生きていれば奪わず、まず解放を短時間待つ（chat 離脱→開き直しで
  // 旧 serve の終了と競走するケースの吸収）。猶予内に解放されなければ従来どおり諦める
  // （生きている正当な所有者からは決して奪わない, 上記コメント参照）。
  // 生きていなければ（前回異常終了のスタール残骸）安全に削除して bind し直す
  // （Swift 版 unlink→bind と同一の後始末）。
  const graceMs = options.socketWaitGraceMs ?? 4000;
  const intervalMs = options.socketWaitIntervalMs ?? 200;
  const waitDeadline = Date.now() + graceMs;
  let handoffRequested = false;
  while (true) {
    if (signal.aborted) return;
    // probe 中に別の後発が listen し始めても、その新しい socket を unlink しない。
    const observed = socketStat(socketPath);
    const alive = await isSocketAlive(socketPath, signal);
    if (signal.aborted) return;
    if (!alive) {
      const current = socketStat(socketPath);
      if (observed?.isSocket() && current?.ino === observed.ino && current.dev === observed.dev) {
        fs.rmSync(socketPath, { force: true });
      }
      break;
    }
    if (input.destroyed || input.readableEnded) return;
    if (clientId !== undefined && !handoffRequested) {
      handoffRequested = true;
      await requestHandoff(socketPath, clientId, signal);
      continue;
    }
    if (Date.now() >= waitDeadline) {
      throw new Error(`socket already in use by a live listener: ${socketPath}`);
    }
    await sleep(intervalMs);
  }

  const clients = new Set<net.Socket>();
  let registryClosed = false;
  let shutdownRequested = false;
  let resolveBroker: (() => void) | null = null;
  let server: net.Server;

  const finishBroker = (handoff = false): void => {
    if (registryClosed) return;
    registryClosed = true;
    for (const client of clients) {
      if (handoff) client.destroy();
      else client.end();
    }
    // `net.Server.close()` は bind したパスの socket ファイルを自前で unlink するため
    // （Node 内部仕様）、ここで追加の fs.rmSync は不要（かつ、上の isSocketAlive ガードにより
    // このプロセスは常にこのパスの正当な唯一の所有者として起動しているため安全）。
    // handoff は全 client を destroy 済みなので、解放完了後に終了する。
    // 通常の EOF では従来どおり hook 側の FIN を待たず終了し、半開き client で固着させない。
    server.close(() => { if (handoff) resolveBroker?.(); });
    if (!handoff) resolveBroker?.();
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

    let firstLine = true;
    const feeder = makeLineFeeder((line) => {
      if (firstLine) {
        firstLine = false;
        // handoff はローカル socket 内だけの制御行。承認やアプリ側へは中継しない。
        let request: { type?: unknown; clientId?: unknown } | null = null;
        try { request = JSON.parse(line.toString("utf8")); } catch { /* 通常の中継へ。 */ }
        if (request?.type === HANDOFF_TYPE) {
          if (clientId !== undefined && request.clientId === clientId) {
            log("[tailii-host serve] 同じクライアントの再接続へ listener を引き継ぐ\n");
            finishBroker(true);
          } else {
            client.end();
          }
          return;
        }
      }
      writeLineToSSH(line);
    });
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
  if (signal.aborted) { finishBroker(); return; }
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
    input.once("close", finish);
  });
}

/** serve サブコマンドのエントリポイント（`--session <name>` | `--socket <path>`）。 */
export async function runServeCommand(args: string[]): Promise<number> {
  let socketPath: string | null = null;
  let clientId: string | undefined;
  try {
    socketPath = parseServeArgs(args);
    const clientIndex = args.indexOf("--client-id");
    if (clientIndex !== -1) {
      clientId = args[clientIndex + 1];
      if (clientId === undefined || !CLIENT_ID.test(clientId)) throw new Error("invalid serve client id");
    }
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
      ...(clientId === undefined ? {} : { clientId }),
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
