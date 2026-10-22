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
import { defaultHeartbeatDir } from "../sessions/heartbeat.js";
import { startEngineRelaySocket, type EngineRelayServer } from "./engineRelaySocket.js";
import { encodeHubMessage } from "./hubProtocol.js";
import { ensureDirectory0700 } from "../shared/paths.js";
import {
  REAPER_CHECK_INTERVAL_SECONDS,
  REAPER_IDLE_TIMEOUT_SECONDS,
  type ReaperTickResult,
} from "./reaper.js";
import { SessionHub } from "./sessionHub.js";
import { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import { abortableSleep } from "../shared/sleep.js";
import { resolveHubSocketPath } from "../shared/socketPath.js";
import {
  processTmuxCommandRunner,
  JUMP_TO_LATEST_SEQUENCE,
  screenBusyButScrolledAway,
  screenInLoginFlow,
  screenShouldJumpToLatest,
  screenShowsApprovalDialog,
} from "../backend/tmux.js";
import { envWithoutTmux, screenHasSelectionFooter } from "../backend/herdr.js";
import { readPackageVersion } from "../shared/version.js";
import { ChatTailController } from "../chat/chatTailController.js";
import { fileBackgroundStopRecords } from "../chat/backgroundStopRecords.js";
import { TranscriptTailer } from "../chat/transcriptTailer.js";
import { LineWriter } from "../shared/lineWriter.js";
import { NdjsonLineSplitter } from "../shared/lineSplitter.js";
import { PanePreviewPump } from "./panePreviewPump.js";
import { makeUsageLimitPushNotifier } from "../push/approvalPushNotifier.js";
import { parseUsageLimitWait } from "../shared/usageLimitWait.js";
import { makeSessionBackend } from "../backend/sessionBackend.js";
import { Writable } from "node:stream";
import {
  decodeControlMessage,
  PROTOCOL_MAX_SUPPORTED,
  type ControlMessage,
} from "../protocol.js";
import { injectQuestionAnswers, questionDialogVisible } from "./questionInjection.js";
import {
  EFFORT_COMMAND_PATTERN,
  MODEL_COMMAND_PATTERN,
  confirmEffortChangeDialog,
  confirmModelSwitchDialog,
} from "./effortDialog.js";
import { ImageService } from "../chat/imageService.js";
import { listServeProcessesWithStatus } from "../services/serveService.js";

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

export function defaultChatReceiptsPath(): string {
  return path.join(os.homedir(), ".tailii", "hub", "chat-receipts.json");
}

/**
 * LineWriter の canonical flat wire を Hub 内部の ControlMessage へ戻す adapter。
 *
 * tool_activity / subagent_node は内部表現だけ nested で、wire は flat になる。
 * JSON.parse の型 assertion だけでは activity/node が欠けた偽 ControlMessage を作るため、
 * 必ず protocol decoder を通して境界を検証・復元する。
 */
export function controlMessageCallbackWriter(
  write: (message: ControlMessage) => void,
): LineWriter {
  return new LineWriter(new Writable({
    write(chunk, _encoding, callback) {
      try {
        write(decodeControlMessage(String(chunk).trimEnd()));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  }));
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

/**
 * client 側の滞留（socket.writableLength）がこれを超えたら即座に切る上限。読まない client の判定は
 * 高水位の停滞（HUB_SOCKET_STALL_TIMEOUT_MS）で行い、これは数MBの RPC 応答（サブエージェント全文等）を
 * 直送した直後に速い client まで切らないためのメモリ上限として大きめに取る。
 */
export const HUB_SOCKET_WRITABLE_LENGTH_LIMIT = 32 * 1024 * 1024;
export const HUB_SOCKET_CONVERSATION_EVENT_BATCH_SIZE = 16;
export const HUB_SOCKET_CONVERSATION_EVENT_FLUSH_INTERVAL_MS = 8;
/** 履歴キューの書き出しを待つ socket 側滞留量（client が読むまで次の束を積まない）。 */
export const HUB_SOCKET_FLUSH_HIGH_WATER = 1024 * 1024;
/**
 * Hub 内の履歴キューの安全上限。キューは Hub 自身の再生速度で膨らむもので client の遅さでは
 * ないため、切断判定（writableLength 上限）には数えない。メモリを無制限に使わないための上限だけ置く。
 */
export const HUB_SOCKET_CONVERSATION_QUEUE_LIMIT = 32 * 1024 * 1024;
/** socket 側の滞留が高水位のまま一度も下がらなかったら、読まない client として切る時間。 */
export const HUB_SOCKET_STALL_TIMEOUT_MS = 30_000;

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

/**
 * 大量の履歴 conversation_event を同期的に socket へ積むと、後着した pane_preview が
 * history-done の後ろまで待たされる。履歴だけを小分けにし、ライブ状態・RPC応答は
 * 直送して追い越せるようにする。conversation_event 同士の順序は FIFO で維持する。
 *
 * 遅延 client の判定は socket 側の滞留（client が読んでいない量）だけで行う。Hub 内の履歴
 * キューは Hub 自身が巨大な会話を一気に再生したときに膨らむもので、これを数えると client が
 * 速くても切ってしまい、再接続→全履歴の再購読→また切断…の繰り返しになる（10-20 実障害:
 * 13 分で 41 回、新規セッションの最初の送信が「Session Hub disconnected during RPC」で失敗）。
 */
export function createPrioritizedHubSocketWriter(
  socket: HubWritableSocket,
  writableLengthLimit: number,
  log: (message: string) => void,
  options: {
    batchSize?: number;
    flushIntervalMs?: number;
    flushHighWater?: number;
    queueLimit?: number;
    stallTimeoutMs?: number;
    now?: () => number;
  } = {},
): (line: string) => void {
  const batchSize = options.batchSize ?? HUB_SOCKET_CONVERSATION_EVENT_BATCH_SIZE;
  const flushIntervalMs = options.flushIntervalMs ??
    HUB_SOCKET_CONVERSATION_EVENT_FLUSH_INTERVAL_MS;
  const flushHighWater = Math.min(
    options.flushHighWater ?? HUB_SOCKET_FLUSH_HIGH_WATER,
    writableLengthLimit,
  );
  const queueLimit = options.queueLimit ?? HUB_SOCKET_CONVERSATION_QUEUE_LIMIT;
  const stallTimeoutMs = options.stallTimeoutMs ?? HUB_SOCKET_STALL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const conversationEvents: string[] = [];
  let queuedBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** socket 側の滞留が高水位以上になり続けている起点（下がったら null）。 */
  let stalledSinceMs: number | null = null;

  const clearQueue = (): void => {
    conversationEvents.length = 0;
    queuedBytes = 0;
  };
  const disconnect = (reason: string, backlog: number, threshold: number): void => {
    log(`audit slow_client_disconnect writableLength=${backlog} threshold=${threshold} reason=${reason}`);
    clearQueue();
    socket.destroy();
  };
  /**
   * client 側の滞留が高水位以上か（以上なら停滞の起点を記録し、下回れば解く）。停滞が
   * stallTimeoutMs 続いたら読まない client として切る。履歴の書き出しと直送の両方で見る。
   */
  const backlogged = (): boolean => {
    if (socket.writableLength < flushHighWater) {
      stalledSinceMs = null;
      return false;
    }
    const current = now();
    stalledSinceMs ??= current;
    if (current - stalledSinceMs >= stallTimeoutMs) {
      disconnect("stalled", socket.writableLength, flushHighWater);
    }
    return true;
  };
  const scheduleFlush = (): void => {
    if (flushTimer !== null || conversationEvents.length === 0 || socket.destroyed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (socket.destroyed) {
        clearQueue();
        return;
      }
      // client がまだ読んでいない分が高水位以上なら、次の束は積まずに待つ（滞留を client 側の
      // 遅さとして上限で測れるよう、Hub のキューから socket へは読まれた分だけ流す）。
      if (socket.writableLength > writableLengthLimit) {
        disconnect("socket", socket.writableLength, writableLengthLimit);
        return;
      }
      if (backlogged()) {
        if (!socket.destroyed) scheduleFlush();
        return;
      }
      for (let index = 0; index < batchSize; index += 1) {
        // 束の途中でも client 側の滞留が高水位に達したら残りは次の tick へ回す。
        if (index > 0 && socket.writableLength >= flushHighWater) break;
        const line = conversationEvents.shift();
        if (line === undefined) break;
        queuedBytes -= Buffer.byteLength(line, "utf8");
        writeHubSocketLine(socket, line, writableLengthLimit, log);
        if (socket.destroyed) {
          clearQueue();
          return;
        }
      }
      scheduleFlush();
    }, flushIntervalMs);
  };

  return (line: string): void => {
    // 外側 envelope の type だけを照合する。payload 内の同名 type では誤判定しない。
    if (line.startsWith('{"type":"conversation_event"')) {
      if (socket.destroyed) return;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (socket.writableLength > writableLengthLimit) {
        disconnect("socket", socket.writableLength, writableLengthLimit);
        return;
      }
      if (queuedBytes + lineBytes > queueLimit) {
        disconnect("queue", queuedBytes, queueLimit);
        return;
      }
      conversationEvents.push(line);
      queuedBytes += lineBytes;
      scheduleFlush();
      return;
    }
    // pane_preview / processing state / RPC応答は履歴キューを待たせず即時配送する。
    if (socket.destroyed) return;
    backlogged();
    if (socket.destroyed) return;
    writeHubSocketLine(socket, line, writableLengthLimit, log);
  };
}

/** engine 接続の各行を SessionHub コアへ渡す NDJSON socket。 */
export async function startHubSocket(options: {
  hub: SessionHub;
  socketPath?: string;
  version: string | null;
  bootId?: string;
  log?: (message: string) => void;
  writableLengthLimit?: number;
  /** client ごとの履歴キューの安全上限（既定 HUB_SOCKET_CONVERSATION_QUEUE_LIMIT）。 */
  conversationQueueLimit?: number;
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
    const write = createPrioritizedHubSocketWriter(socket, writableLengthLimit, log,
      options.conversationQueueLimit !== undefined ? { queueLimit: options.conversationQueueLimit } : {});
    options.hub.registerClient(socket, write);
    const splitter = new NdjsonLineSplitter();
    socket.on("data", (chunk: Buffer) => {
      splitter.push(chunk, (lineBuffer) => {
        const line = lineBuffer.toString("utf8");
        try {
          const message = JSON.parse(line) as { type?: unknown };
          if (message.type === "hub_hello") {
            write(encodeHubMessage({
              type: "hub_hello_ack",
              version: options.version,
              bootId,
              processingSessions: options.hub.processingSessionNames,
              resumeHint: true,
            }));
          }
        } catch { /* Hub コア側でも不正行を破棄する。 */ }
        options.hub.handleClientMessage(socket, line);
      });
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
    const cliPath = options.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
    const logPath = options.logPath ?? path.join(os.homedir(), ".tailii", "hub.log");
    ensureDirectory0700(path.dirname(logPath));
    logFd = fs.openSync(logPath, "a");
    // tmux 内の hook から ensure されると TMUX / TMUX_PANE を引き継ぐ。hub が起こす herdr server 経由で
    // herdr 内の Claude がこの tmux pane 名を状態ファイルの `tmux` 欄に書き、reaper が取り違えるので外す。
    const child = (options.spawnImpl ?? spawn)(process.execPath, [cliPath, "hub"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: envWithoutTmux(),
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
  // 端末バックエンド（tmux / herdr）。常時 Composite（メタの backend 欄で per-session ルーティング）
  // なので、アプリの backend_set による切替後も hub 再起動なしで両方のセッションへ届く。
  const sessionBackend = makeSessionBackend({ store: metadataStore });
  // Session Hub 導入後は Hub 所有の ChatTailController が会話を配信する。
  // ここで ImageService を渡さないと engine 側のサービスは tail を通らず、
  // user 添付の image_available が消失する。index は engine と共通の既定パスへ書く。
  const imageService = new ImageService();
  // iPhone から止めた背景コマンドの記録。tail（会話を閉じると捨てる）と hub の再起動より長く残す。
  const backgroundStopRecords = fileBackgroundStopRecords();
  const hub = new SessionHub({
    runner,
    imageService,
    heartbeatDir: defaultHeartbeatDir(),
    metadataStore,
    timeoutSeconds,
    // ローカル開発サーバー稼働中の cwd は activity とみなし、pane close / kill-session に
    // よる巻き添え終了を防ぐ。reaper は timeout 候補がある tick でのみこの検出を呼ぶ。
    listLocalServerCwds: async () => {
      const result = await listServeProcessesWithStatus({ excludePids: [process.pid] });
      if (!result.ok) return null;
      return new Set(
        result.servers.flatMap((server) => server.cwd === undefined ? [] : [server.cwd]),
      );
    },
    pendingQuestionsPath: defaultPendingQuestionsPath(),
    chatReceiptsPath: defaultChatReceiptsPath(),
    log,
    tailFactory: (write, onCodexTurnLifecycle, onClaudeTurnLifecycle) => new ChatTailController({
      backgroundStopRecords,
      writer: controlMessageCallbackWriter(write),
      tailer: new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true }),
      projectsRoot: path.join(os.homedir(), ".claude", "projects"),
      imageService,
      protocolVersion: () => PROTOCOL_MAX_SUPPORTED,
      onCodexTurnLifecycle,
      onClaudeTurnLifecycle,
    }),
    previewPumpFactory: (write, onPermissionMode, pollIntervalMs, onUsageLimitWait, isIdle) => new PanePreviewPump({
      writer: controlMessageCallbackWriter(write),
      capture: (session) => sessionBackend.capturePane(session, { lines: 60, joinWrappedLines: true }),
      // プロンプト提案（薄字ゴースト）抽出用の viewport ANSI キャプチャ（prompt-suggestion-chip）。
      captureSuggestion: (session) => sessionBackend.captureVisibleAnsi(session),
      // 待機中に入力欄へ残った文字をアプリへ知らせる（input-residue）。
      ...(isIdle !== undefined ? { isIdle } : {}),
      onPermissionMode,
      ...(onUsageLimitWait !== undefined ? { onUsageLimitWait } : {}),
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      log,
      // 静止した入力待ちダイアログ（選択 / /login / hook で通らなかった承認）は初回フレームから送る
      // （開き直しで転写カードを出す）。使用量制限の待機フッター（usage-limit-wait）も静止画面なので
      // 初回フレームから送る。端末側で上へスクロールされた処理中の Claude も静止画面なので同じ
      // （scroll-pill）。
      emitInitialIf: (text) =>
        screenHasSelectionFooter(text) || screenInLoginFlow(text) || screenShowsApprovalDialog(text)
        || parseUsageLimitWait(text) !== null || screenBusyButScrolledAway(text),
      // 上へスクロールされた処理中の Claude は画面が動かない。静止を処理の終わりと読まない。
      holdActiveIf: screenBusyButScrolledAway,
      // iPhone が会話を開いたとき端末側で上へスクロールされていたら、1 回だけ最新位置へ戻す
      // （jump-to-latest。hub が前面購読の開始で armJumpToLatest を呼ぶ）。戻らない環境（キー割り当ての
      // 変更等）では上の保持が残る。
      jumpToLatest: (session) => sessionBackend.sendKeys(session, [JUMP_TO_LATEST_SEQUENCE], true),
      jumpToLatestIf: screenShouldJumpToLatest,
    }),
    questionInjector: (answers, session) => injectQuestionAnswers(answers, session, sessionBackend),
    // 回答キーは設問ダイアログが TUI に出ているときだけ打つ（question-stale）。
    questionDialogVisible: (session) => questionDialogVisible(session, sessionBackend),
    // 使用量制限の自動再開待ちを push で知らせる（usage-limit-wait。APNs 未設定なら内部で skip）。
    usageLimitNotify: makeUsageLimitPushNotifier(log),
    // CLI のキューに溜まっている発話を今すぐ届ける（chat-send-now）。
    sendNowInjector: (session) => sessionBackend.sendQueuedNow(session),
    // 本文+送信確定は backend 側の 1 操作に委ねる（herdr は本文+CR 単一コール必須。
    // 分割すると Ink のペースト取り込み窓に CR が飲まれ送信されない）。
    chatInjector: async (text, session, context) => {
      // 注入の所要時間を残す（実機 2026-09-07: 処理中の会話への送信が 14.5s かかり、アプリ側では
      // その間 pending 表示のまま → 利用者が開き直す事案）。所要時間は毎回 1 行で記録し、iOS の
      // ACK 予算 18s に迫る 4 秒以上は `chat-inject-slow` として目立たせる（事後解析用）。
      const startedAt = Date.now();
      try {
        await sessionBackend.sendTextSubmit(session, text, {
          recordedPromptText: context.recordedPromptText,
          // 利用者が未回答の設問に答えずに送った（chat-cancel-choice）。設問を Esc で閉じてから送る。
          cancelChoiceDialog: context.cancelChoice,
          onChoiceDialogCancelled: () => {
            log(`audit chat-choice-dialog-cancelled session=${session}`);
            context.onChoiceCancelled();
          },
          // 送信確定を確認できないまま配送済みレシートを返す唯一の経路。無言だと
          // 「送ったのに届かない」の再発に誰も気づけないので 1 行残す（事後解析用）。
          onUnconfirmedSubmit: () => log(`audit chat-submit-unconfirmed session=${session}`),
        });
      } finally {
        const elapsedMs = Date.now() - startedAt;
        log(`audit ${elapsedMs >= 4_000 ? "chat-inject-slow" : "chat-inject"} session=${session} elapsedMs=${elapsedMs}`);
      }
      // `/effort <level>` は会話途中だと確認ダイアログが挟まる（effort-dialog）。ユーザーの
      // 明示操作なので出現したら Enter で承認し、切替を完了させる。
      // ack（chat_send_result）を遅らせないよう待たずに流す（ダイアログ未出現時は 4s で諦める）。
      if (EFFORT_COMMAND_PATTERN.test(text)) {
        void confirmEffortChangeDialog(sessionBackend, session, { log }).catch((error: unknown) => {
          log(`effort dialog 承認失敗 session=${session} error=${String(error)}`);
        });
      }
      // `/model <slug>` も同型の確認ダイアログ（`Switch model?`）が挟まる。herdr backend では
      // iOS の pane_preview 自動 Yes（入力 PTY）が claude へ届かないため host が承認する
      // （model-switch-dialog, 2026-09-06 実障害: 開き直した会話でモデル変更が未反映）。
      if (MODEL_COMMAND_PATTERN.test(text)) {
        void confirmModelSwitchDialog(sessionBackend, session, { log }).catch((error: unknown) => {
          log(`model dialog 承認失敗 session=${session} error=${String(error)}`);
        });
      }
    },
  });
  hub.restoreFromHeartbeats();
  hub.restorePendingQuestions();
  hub.restoreChatReceipts();
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
