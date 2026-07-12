// hubDaemon.ts
// tailii (TS host) — Session Hub の unix socket / lock / daemon lifecycle。
//
// reaper の heartbeat 判定は SessionHub.tick() に吸収する。heartbeat.ts が唯一の判定権威で、
// Hub は engine / hook と並ぶ書き手・周期実行者にすぎない。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHeartbeatDir } from "./heartbeat.js";
import { startEngineRelaySocket, type EngineRelayServer } from "./engineRelaySocket.js";
import { encodeHubMessage } from "./hubProtocol.js";
import { ensureDirectory0700 } from "./paths.js";
import {
  REAPER_CHECK_INTERVAL_SECONDS,
  REAPER_IDLE_TIMEOUT_SECONDS,
  type ReaperTickResult,
} from "./reaper.js";
import { SessionHub } from "./sessionHub.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import { abortableSleep } from "./sleep.js";
import { resolveHubSocketPath } from "./socketPath.js";
import { processTmuxCommandRunner } from "./tmux.js";
import { readPackageVersion } from "./version.js";
import { ChatTailController } from "./chatTailController.js";
import { TranscriptTailer } from "./transcriptTailer.js";
import { LineWriter } from "./lineWriter.js";
import { PanePreviewPump } from "./panePreviewPump.js";
import { TmuxSessionManager } from "./tmux.js";
import { Writable } from "node:stream";
import { PROTOCOL_MAX_SUPPORTED, type ControlMessage } from "./protocol.js";
import { injectQuestionAnswers } from "./questionInjection.js";

export interface HubLock {
  pid: number;
  version: string | null;
}

export function defaultHubLockPath(): string {
  return path.join(os.homedir(), ".tailii", "hub.lock");
}

export function defaultPendingQuestionsPath(): string {
  return path.join(os.homedir(), ".tailii", "hub", "pending-questions.json");
}

/** lockfile を読む。不在・壊れは null。 */
export function readHubLock(lockPath: string): HubLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      version?: unknown;
    };
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, version: typeof parsed.version === "string" ? parsed.version : null };
  } catch {
    return null;
  }
}

/** 生存中の別 pid が所有していなければ lock を取得する。 */
export function acquireHubLock(
  lockPath: string,
  version: string | null,
  ownerPid: number = process.pid,
): boolean {
  ensureDirectory0700(path.dirname(lockPath));
  const payload = JSON.stringify({ pid: ownerPid, version });
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readHubLock(lockPath);
    if (existing !== null && existing.pid !== ownerPid && pidAlive(existing.pid)) return false;
    if (existing !== null && existing.pid === ownerPid) {
      fs.writeFileSync(lockPath, payload);
      return true;
    }
    // 死んだ所有者・壊れた lock は退けてから O_EXCL で作成する。
    // 同時起動の 2 プロセスが両方 lock を書けてしまうと、socket bind に
    // 負けた側の後始末が勝者の lock を巻き添えにする(実観測済み)。
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // 不在ならそのまま作成へ。
    }
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
    } catch {
      continue; // 競合相手が先に作成 → 相手の生存判定からやり直す。
    }
    // unlink 競合で相手に上書きされていないことを確認して確定する。
    if (readHubLock(lockPath)?.pid === ownerPid) return true;
  }
  return false;
}

/** pid が生きているか。権限不足(EPERM)は生存扱い。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export interface HubSocketServer {
  socketPath: string;
  close(): Promise<void>;
}

export const HUB_SOCKET_WRITABLE_LENGTH_LIMIT = 4 * 1024 * 1024;

interface HubWritableSocket {
  readonly writableLength: number;
  readonly destroyed: boolean;
  write(line: string): unknown;
  destroy(): unknown;
}

/** Hub から client へ書く直前に滞留量を検査し、遅延 client を切断する。 */
export function writeHubSocketLine(
  socket: HubWritableSocket,
  line: string,
  writableLengthLimit: number,
  log: (message: string) => void,
): void {
  if (socket.destroyed) return;
  const writableLength = socket.writableLength;
  if (writableLength > writableLengthLimit) {
    log(`audit slow_client_disconnect writableLength=${writableLength} threshold=${writableLengthLimit}`);
    socket.destroy();
    return;
  }
  socket.write(line);
}

/** engine 接続の各行を SessionHub コアへ渡す NDJSON socket。 */
export async function startHubSocket(options: {
  hub: SessionHub;
  socketPath?: string;
  version: string | null;
  bootId?: string;
  log?: (message: string) => void;
  writableLengthLimit?: number;
}): Promise<HubSocketServer | null> {
  const socketPath = options.socketPath ?? resolveHubSocketPath();
  const log = options.log ?? (() => {});
  const bootId = options.bootId ?? randomUUID();
  const writableLengthLimit = options.writableLengthLimit ?? HUB_SOCKET_WRITABLE_LENGTH_LIMIT;
  if (await isSocketAlive(socketPath)) return null;
  fs.rmSync(socketPath, { force: true });

  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    log(`audit client_connect clients=${clients.size}`);
    const write = (line: string): void =>
      writeHubSocketLine(socket, line, writableLengthLimit, log);
    options.hub.registerClient(socket, write);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          const message = JSON.parse(line) as { type?: unknown };
          if (message.type === "hub_hello") {
            write(encodeHubMessage({ type: "hub_hello_ack", version: options.version, bootId }));
          }
        } catch { /* Hub コア側でも不正行を破棄する。 */ }
        options.hub.handleClientMessage(socket, line);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clients.delete(socket);
      options.hub.unregisterClient(socket);
      log(`audit client_disconnect clients=${clients.size}`);
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
  log(`socket listen ${socketPath}`);

  return {
    socketPath,
    close: () => new Promise<void>((resolve) => {
      // socket の close イベント（非同期）を待たず、close 完了時点で clientCount を確定させる。
      // clients の削除は close イベントへ任せ、監査行の接続数を接続ごとに正しく減らす。
      // イベント側の unregister は冪等なので二重解除は無害。
      for (const client of clients) {
        options.hub.unregisterClient(client);
        client.destroy();
      }
      server.close(() => {
        fs.rmSync(socketPath, { force: true });
        resolve();
      });
    }),
  };
}

export interface EnsureHubDaemonOptions {
  lockPath?: string;
  cliPath?: string;
  logPath?: string;
  spawnImpl?: typeof spawn;
}

/** engine / hook から Hub の常駐を冪等・best-effort で保証する。 */
export function ensureHubDaemon(options: EnsureHubDaemonOptions = {}): void {
  let logFd: number | null = null;
  try {
    const lockPath = options.lockPath ?? defaultHubLockPath();
    const currentVersion = readPackageVersion();
    const lock = readHubLock(lockPath);
    if (lock !== null && pidAlive(lock.pid)) {
      if (lock.version === currentVersion) return;
      // stale dist は退かせ、現行 cli から立て直す。
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch {
        // 消えていればそのまま起動へ進む。
      }
    }
    const cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
    const logPath = options.logPath ?? path.join(os.homedir(), ".tailii", "hub.log");
    ensureDirectory0700(path.dirname(logPath));
    logFd = fs.openSync(logPath, "a");
    const child = (options.spawnImpl ?? spawn)(process.execPath, [cliPath, "hub"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } catch {
    // 次の engine 接続 / hook 発火で再試行する。
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
}

/** `tailii hub` エントリ。 */
export async function runHubCommand(args: string[]): Promise<number> {
  let timeoutSeconds = REAPER_IDLE_TIMEOUT_SECONDS;
  let intervalSeconds = REAPER_CHECK_INTERVAL_SECONDS;
  let once = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--timeout-seconds") timeoutSeconds = Number(args[++i]);
    else if (arg === "--interval-seconds") intervalSeconds = Number(args[++i]);
    else if (arg === "--once") once = true;
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return 64;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return 64;

  const lockPath = defaultHubLockPath();
  const existing = readHubLock(lockPath);
  if (existing !== null && existing.pid !== process.pid && pidAlive(existing.pid)) {
    log(`既存 daemon 生存(pid=${existing.pid})のため終了`);
    return 0;
  }
  const socketPath = resolveHubSocketPath();
  if (await isSocketAlive(socketPath)) {
    log(`既存 Hub socket 生存(${socketPath})のため終了`);
    return 0;
  }

  const startupVersion = readPackageVersion();
  const bootId = randomUUID();
  if (!acquireHubLock(lockPath, startupVersion)) {
    log("lock 取得競合のため終了");
    return 0;
  }
  const abort = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!abort.signal.aborted) log(`audit hub_exit reason=signal signal=${signal}`);
    abort.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const runner = processTmuxCommandRunner();
  const metadataStore = new SessionMetadataStore();
  const tmuxManager = new TmuxSessionManager({ runner, store: metadataStore });
  const callbackWriter = (write: (message: ControlMessage) => void): LineWriter =>
    new LineWriter(new Writable({ write(chunk, _encoding, callback) {
      try { write(JSON.parse(String(chunk)) as ControlMessage); callback(); } catch (error) { callback(error as Error); }
    } }));
  const hub = new SessionHub({
    runner,
    heartbeatDir: defaultHeartbeatDir(),
    metadataStore,
    timeoutSeconds,
    pendingQuestionsPath: defaultPendingQuestionsPath(),
    log,
    tailFactory: (write) => new ChatTailController({
      writer: callbackWriter(write),
      tailer: new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true }),
      projectsRoot: path.join(os.homedir(), ".claude", "projects"),
      protocolVersion: () => PROTOCOL_MAX_SUPPORTED,
    }),
    previewPumpFactory: (write, onPermissionMode) => new PanePreviewPump({
      writer: callbackWriter(write),
      capture: (session) => tmuxManager.capturePane(session, { lines: 60, joinWrappedLines: true }),
      onPermissionMode,
    }),
    questionInjector: (answers, session) => injectQuestionAnswers(answers, session, tmuxManager),
    chatInjector: async (text, session) => {
      await tmuxManager.sendKeys(session, [text], true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tmuxManager.sendKeys(session, ["Enter"]);
    },
  });
  hub.restoreFromHeartbeats();
  hub.restorePendingQuestions();
  let socketServer: HubSocketServer | null = null;
  let relayServer: EngineRelayServer | null = null;

  log(
    `起動 pid=${process.pid} version=${startupVersion ?? "?"} ` +
      `timeout=${timeoutSeconds}s interval=${intervalSeconds}s`,
  );
  try {
    try {
      socketServer = await startHubSocket({ hub, socketPath, version: startupVersion, bootId, log });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log("socket listen 競合のため終了");
        return 0;
      }
      throw error;
    }
    if (socketServer === null) return 0;
    // socket を勝ち取った時点で lock の権威は自分。起動競合の名残(敗者の lock や
    // own-pid ガード付き削除)があっても、ここで上書きすれば最終状態は必ず整合する。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: startupVersion }));
    relayServer = await startEngineRelaySocket({ onMessage: (message) => hub.handleRelayMessage(message), log });
    while (!abort.signal.aborted) {
      let result: ReaperTickResult;
      try {
        result = await hub.tick();
      } catch (error) {
        // tmux 一時失敗等は daemon を落とさず次周期へ送る。
        log(`tick 失敗(継続): ${String(error)}`);
        result = { liveCount: 1, killed: [], demoted: [], reclaimed: [] };
      }
      if (once) break;
      if (result.liveCount === 0 && hub.clientCount === 0 && !hub.hasPendingQuestions &&
        !hub.hasInjectionsInFlight && !hub.hasCodexTurnsInFlight) {
        log("対象セッション 0 / client 0 → 自然終了");
        break;
      }
      const currentVersion = readPackageVersion();
      if (startupVersion !== null && currentVersion !== null && currentVersion !== startupVersion) {
        log(`stale dist 検知(${startupVersion} → ${currentVersion}) → 終了`);
        break;
      }
      await abortableSleep(intervalSeconds * 1000, abort.signal);
    }
  } finally {
    hub.close();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await relayServer?.close();
    await socketServer?.close();
    // 後継 daemon の lock を壊さず、自分の lock だけを消す。
    if (readHubLock(lockPath)?.pid === process.pid) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // pid 生存判定があるため残っても無害。
      }
    }
  }
  return 0;

  function log(message: string): void {
    process.stderr.write(`[tailii-hub ${new Date().toISOString()}] ${message}\n`);
  }
}
