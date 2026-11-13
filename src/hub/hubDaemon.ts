// hubDaemon.ts
// tailii (TS host) — Session Hub の unix socket / lock / daemon lifecycle。
//
// reaper の heartbeat 判定は SessionHub.tick() に吸収する。heartbeat.ts が唯一の判定権威で、
// Hub は engine / hook と並ぶ書き手・周期実行者にすぎない。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
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
import { claimHubStartup, type HubExclusiveLock, isSocketAlive } from "./hubStartup.js";
import { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import { abortableSleep } from "../shared/sleep.js";
import { resolveHubSocketPath } from "../shared/socketPath.js";
import { ApiAgentRejectedError } from "../apiAgent/config.js";
import { createDefaultApiAgentManager } from "../apiAgent/defaults.js";
import {
  ChatInjectionRejectedError,
  processTmuxCommandRunner,
  JUMP_TO_LATEST_SEQUENCE,
  jumpToLatestAllowed,
  screenBusyButScrolledAway,
  screenInLoginFlow,
  screenShowsApprovalDialog,
} from "../backend/tmux.js";
import { screenHasConfirmFooter, screenHasSelectionFooter } from "../backend/herdr.js";
import { readPackageVersion } from "../shared/version.js";
import { killAgentsKeyIsDefault } from "../shared/claudeKeybindings.js";
import { ChatTailController } from "../chat/chatTailController.js";
import { fileBackgroundStopRecords } from "../chat/backgroundStopRecords.js";
import { TranscriptTailer } from "../chat/transcriptTailer.js";
import { LineWriter } from "../shared/lineWriter.js";
import { NdjsonLineSplitter } from "../shared/lineSplitter.js";
import { PanePreviewPump } from "./panePreviewPump.js";
import { PreviewLoadMonitor } from "./previewLoad.js";
import { createProductionPushDispatcher } from "../push/pushDispatcher.js";
import { makeSessionTitleResolver } from "../push/pushContent.js";
import { PushDeviceStore } from "../push/pushDeviceStore.js";
import { ClaudeVersionRecorder } from "../shared/claudeVersionRecord.js";
import { requestApiAgentApproval } from "../apiAgent/approvalBridge.js";
import { approvalNotificationBody } from "../approval/hook.js";
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
import { listLocalServerProcesses } from "./localServerProcesses.js";
import { delegateHubToGateway } from "./gatewaySpawn.js";
import { defaultHubLockPath, readHubLock, pidAlive } from "./hubDaemonClient.js";
// 既存の import 元は互換のままにする。
export { defaultHubLockPath, readHubLock, pidAlive, ensureHubDaemon } from "./hubDaemonClient.js";
export type { HubLock, EnsureHubDaemonOptions } from "./hubDaemonClient.js";

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

/** 自分（ownerPid）の lock だけを消す。後継 daemon の lock は壊さない。残っても pid の生存判定があるので無害。 */
export function releaseOwnHubLock(lockPath: string, ownerPid: number = process.pid): void {
  if (readHubLock(lockPath)?.pid !== ownerPid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // 消せなくても次の daemon が死んだ所有者の lock として奪取できる。
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
              pendingQuestions: options.hub.pendingQuestionSnapshot,
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

/**
 * 終了の合図の後、実行中の注入の完了を待つ上限（ms）。ふだんの注入は 2 秒前後、遅いものでも 6 秒ほど
 * （hub.log の `chat-inject` / `chat-inject-slow`）。打ち始める前の待ち（claude の起動待ち・入力欄の描画待ち。
 * herdr では合わせて最大 30 秒）は見送らせる（`mayStartTyping`）ので、待つのは打ち始めた注入だけ。その上限
 * （貼り付けの確認は注入の開始から `INJECT_VERIFY_BUDGET_MS`、送信の確認は最大 4 回）を少し超えるところに取る。
 * 待っている間は新しい hub が起動を見送る（lock を持ったまま待つ）ので、これより長くは取らない。
 */
export const HUB_SHUTDOWN_DRAIN_MS = 20_000;

/**
 * hub を閉じる（graceful shutdown, 2026-10-26）。SIGTERM（デプロイ・自動更新・版違いの engine による入れ替え）・
 * stale dist・自然終了・起動競合の早期終了の全部がここを通る。
 *
 * 1. 新しい注入を止め、実行中の注入（打鍵 → Enter → 送信の確認 → 配送済みの保存）が終わるのを待つ。途中で切ると、
 *    送れた発話が配送不明のまま残り、アプリの明示再送で同じ発話が 2 回届く（Enter の後に切れた場合）。打っただけ
 *    なら入力欄に本文が残る（実機 2026-10-26）。打ち始める前の注入は見送らせて queued へ戻す
 * 2. 注入に続けて走らせている後処理（`/model`・`/effort` の確認ダイアログの承認）も、残りの時間で待つ
 * 3. hook の中継と engine の接続を閉じる。待っている間は開いたままにする: 終わった発話の ACK がそのまま届き、
 *    設問の通知も受け取れる。先に閉じると engine の再接続の間隔が伸び（250ms → 最大 5 秒）、hub の居ない時間が
 *    待ちの長さ以上に延びる（独立検証 2026-10-26: 2 秒の待ちで約 8 秒）
 * 4. hub の内部（タイマー・Codex App Server の接続）を閉じる
 * 5. `finalize`（signal の解除・自分の lock の削除）。最後に呼ぶ: 待っている間に次の hub が起動して受理記録を
 *    読むと、まだ注入中の発話を配送不明として扱う
 */
export async function shutdownHub(options: {
  hub: Pick<SessionHub, "drainForShutdown" | "close">;
  relayServer: Pick<EngineRelayServer, "close"> | null;
  socketServer: Pick<HubSocketServer, "close"> | null;
  log: (message: string) => void;
  /** 注入に続けて hub の外で走らせている後処理（確認ダイアログの承認）。待つ対象に含める。 */
  pendingWork?: () => Promise<unknown>[];
  /** 最後に呼ぶ（signal の解除・自分の lock の削除）。 */
  finalize?: () => void;
  drainTimeoutMs?: number;
}): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = options.drainTimeoutMs ?? HUB_SHUTDOWN_DRAIN_MS;
  const { inFlight, drained, waitedMs } = await options.hub.drainForShutdown(timeoutMs);
  const work = options.pendingWork?.() ?? [];
  let workSettled = true;
  if (work.length > 0) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
    workSettled = await Promise.race([
      Promise.allSettled(work).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
    ]);
    if (timer !== null) clearTimeout(timer);
  }
  if (inFlight > 0 || work.length > 0) {
    options.log(
      `audit hub_shutdown_drain inflight=${inFlight} drained=${drained} waitedMs=${waitedMs}` +
        (work.length > 0 ? ` followups=${work.length} followupsSettled=${workSettled}` : ""),
    );
  }
  // 閉じるのに失敗しても先へ進む（投げ直すと、lock を外す前に抜ける）。
  for (const [name, server] of [["relay", options.relayServer], ["socket", options.socketServer]] as const) {
    try {
      await server?.close();
    } catch (error) {
      options.log(`終了処理: ${name} を閉じられなかった（続行）: ${String(error)}`);
    }
  }
  try {
    options.hub.close();
  } finally {
    options.finalize?.();
  }
}

/** `tailii hub` エントリ。 */
export async function runHubCommand(args: string[]): Promise<number> {
  const viaGateway = process.env["TAILII_HUB_VIA_GATEWAY"] === "1";
  // この起動だけの印。端末サーバ・worker・その先の hook には引き継がない。
  delete process.env["TAILII_HUB_VIA_GATEWAY"];
  if (!viaGateway && args.length === 0 && await delegateHubToGateway({ log })) {
    log("ゲートウェイの系統で hub を起動するため、このプロセスは終了");
    return 0;
  }
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
  const socketPath = resolveHubSocketPath();
  const startupVersion = readPackageVersion();
  const bootId = randomUUID();
  // 単一起動: OS が解放する排他（hubStartup.ts）を取れたプロセスだけが hub として動く。取れなかった側は何も消さずに退く。
  // 排他を持ったまま graceful shutdown の待ちに入るので、次の hub は前の hub が終わるまで起動を見送る（従来どおり）。
  let claim: Awaited<ReturnType<typeof claimHubStartup>>;
  try {
    claim = await claimHubStartup({ lockPath, socketPath, version: startupVersion });
  } catch (error) {
    // 排他の保存先の障害（DB の破損・権限・I/O）。既存の hub が居ると誤診して正常終了せず、理由を残して失敗終了する
    // （DB ファイルは自動で消さない。稼働中の hub と別 inode になって排他の根拠が分かれるため）。
    log(`hub の排他ロックを取れないため終了(失敗): ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let exclusive: HubExclusiveLock | null = null;
  if (claim.kind === "failed") {
    log(claim.reason === "owner-unverifiable"
      ? `hub.lock の pid=${claim.pid} が生きているが hub かどうか確認できないため起動を見送る(失敗)`
      : `hub.lock の hub(pid=${claim.pid})が応答せず終了の要求にも応じないため起動を諦める(失敗)`);
    return 1;
  }
  if (claim.kind === "busy") {
    log(claim.reason === "exclusive-held" ? "既存 daemon が排他を保持しているため終了" : `既存 Hub socket 生存(${socketPath})のため終了`);
    return 0;
  }
  if (claim.kind === "claimed") {
    exclusive = claim.exclusive;
  } else {
    // node:sqlite の無い Node（20・22.12 以前 = 対応外）: 従来の pid の lock と socket の生存確認で判定する最善努力。
    // 同時起動の競合が残る（単一起動の保証は Node 22.13 以降だけ）。退避した事実を起動ログに残す。
    log(`node:sqlite が使えない Node(${process.versions.node})のため従来の判定に退避(hub の単一起動は保証されません。Node 22.13 以上を推奨)`);
    const existing = readHubLock(lockPath);
    if (existing !== null && existing.pid !== process.pid && pidAlive(existing.pid)) {
      log(`既存 daemon 生存(pid=${existing.pid})のため終了`);
      return 0;
    }
    if (await isSocketAlive(socketPath)) {
      log(`既存 Hub socket 生存(${socketPath})のため終了`);
      return 0;
    }
    if (!acquireHubLock(lockPath, startupVersion)) {
      log("lock 取得競合のため終了");
      return 0;
    }
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
  // 注入に続けて待たずに走らせる後処理（`/model`・`/effort` の確認ダイアログの承認）。終了の前に待つ
  // （graceful shutdown。途中で終わると確認ダイアログが未承認のまま残り、次の発話が送れない）。
  const followupWork = new Set<Promise<unknown>>();
  const trackFollowup = (work: Promise<unknown>): void => {
    followupWork.add(work);
    void work.finally(() => followupWork.delete(work));
  };
  const pushDevices = new PushDeviceStore();
  const previewLoad = new PreviewLoadMonitor({ log });
  const hub = new SessionHub({
    runner,
    imageService,
    heartbeatDir: defaultHeartbeatDir(),
    metadataStore,
    timeoutSeconds,
    // サーバーを持つ pane だけ保護する。同じ cwd の無関係な会話や CLI 自身の待受では延命しない。
    listLocalServers: () => listLocalServerProcesses([process.pid]),
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
    previewPumpFactory: (write, onPermissionMode, pollIntervalMs, onUsageLimitWait, isIdle, isForeground) => new PanePreviewPump({
      writer: controlMessageCallbackWriter(write),
      capture: (session) => sessionBackend.capturePane(session, { lines: 60, joinWrappedLines: true }),
      // プロンプト提案（薄字ゴースト）抽出用の viewport ANSI キャプチャ（prompt-suggestion-chip）。
      captureSuggestion: (session) => sessionBackend.captureVisibleAnsi(session),
      // 待機中に入力欄へ残った文字をアプリへ知らせる（input-residue）。
      ...(isIdle !== undefined ? { isIdle } : {}),
      onPermissionMode,
      ...(onUsageLimitWait !== undefined ? { onUsageLimitWait } : {}),
      pollIntervalMs: () => {
        const baseMs = pollIntervalMs?.() ?? 250;
        return isForeground?.() === false ? previewLoad.intervalMs(baseMs) : baseMs;
      },
      priority: () => isForeground?.() === false ? "background" : "foreground",
      log,
      // 静止した入力待ちダイアログ（選択 / 確認系 / /login / hook で通らなかった承認）は初回フレームから送る
      // （開き直しで転写カードを出す）。使用量制限の待機フッター（usage-limit-wait）も静止画面なので
      // 初回フレームから送る。端末側で上へスクロールされた処理中の Claude も静止画面なので同じ
      // （scroll-pill）。
      emitInitialIf: (text) =>
        screenHasSelectionFooter(text) || screenHasConfirmFooter(text) || screenInLoginFlow(text)
        || screenShowsApprovalDialog(text)
        || parseUsageLimitWait(text) !== null || screenBusyButScrolledAway(text),
      // 上へスクロールされた処理中の Claude は画面が動かない。静止を処理の終わりと読まない。
      holdActiveIf: screenBusyButScrolledAway,
      // iPhone が会話を開いたとき端末側で上へスクロールされていたら、1 回だけ最新位置へ戻す
      // （jump-to-latest。hub が前面購読の開始で armJumpToLatest を呼ぶ）。戻らない環境（キー割り当ての
      // 変更等）では上の保持が残る。
      jumpToLatest: (session) => sessionBackend.sendKeys(session, [JUMP_TO_LATEST_SEQUENCE], true),
      // 「一番下へ戻る」の割り当てを利用者が変えていたら送らない（変えた後の ctrl+End が何をするか分からない）。
      jumpToLatestIf: (text) => jumpToLatestAllowed(text),
    }),
    questionInjector: (answers, session) => injectQuestionAnswers(answers, session, sessionBackend),
    // 回答キーは設問ダイアログが TUI に出ているときだけ打つ（question-stale）。
    questionDialogVisible: (session) => questionDialogVisible(session, sessionBackend),
    // プッシュ通知（push v1）: 完了・設問・エラー・使用量制限・hook からの承認の送信判断と在席判定。
    // 登録端末が無ければ内部で見送る（観測ログだけ残る）。
    pushDispatcher: createProductionPushDispatcher({ titleFor: makeSessionTitleResolver(metadataStore), log, store: pushDevices }),
    // 端末記録の書き手は hub だけ（engine の登録・解除はここへ中継される）。dispatcher と同じ一覧を共有する。
    pushDevices,
    // host が起動した Claude の版（transcript で観測）。launch が StopFailure hook の出し分けに読む。
    claudeVersionRecorder: new ClaudeVersionRecorder(),
    // CLI のキューに溜まっている発話を今すぐ届ける（chat-send-now）。
    sendNowInjector: (session) => sessionBackend.sendQueuedNow(session),
    // 背景エージェントの全停止（subagent-control）: Claude Code の `chat:killAgents`（既定 ctrl+x ctrl+k）は
    // 2 回押しで確定する（1 回目は確認の案内）。割り当てが変えられていたら送らない。
    killAllAgents: async (session) => {
      if (!killAgentsKeyIsDefault()) return false;
      await sessionBackend.sendKeys(session, ["C-x", "C-k"]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await sessionBackend.sendKeys(session, ["C-x", "C-k"]);
      return true;
    },
    // 本文+送信確定は backend 側の 1 操作に委ねる（herdr は本文+CR 単一コール必須。
    // 分割すると Ink のペースト取り込み窓に CR が飲まれ送信されない）。
    // API 作業（api-agent）: 端末なしの会話。ターンは hub の ApiAgentManager が作業プロセスで動かす。
    apiAgentFactory: (callbacks) => createDefaultApiAgentManager({
      ...callbacks, log,
      // 承認は端末の hook と同じ保留に合流する（一覧の「承認待ち」・push・つながり直したら再提示）。push は hook の
      // push_request と同じく hub の dispatcher が在席判定・決着済みの照合をして送る（push v1）。
      approval: (request) => requestApiAgentApproval(request, {
        publishPending: (message) => hub.handleRelayMessage(message),
        notifier: (pushRequest) => {
          hub.requestPush({
            kind: "approval", session: pushRequest.session, id: pushRequest.approvalId, tool: pushRequest.tool,
            body: approvalNotificationBody(pushRequest),
          });
        },
      }),
    }),
    chatInjector: async (text, session, context) => {
      // 端末なしの会話（API 作業）は pane へ打たず、ターンとして渡す。始められなかったら 1 文字も
      // 送っていないので「非配達が確定」として返す（キー無し・予算到達・別の場所で使用中）。
      if (metadataStore.get(session)?.executionRoute === "api") {
        try {
          const outcome = await hub.apiAgentSubmit(session, text);
          log(`audit api-agent-submit session=${session} outcome=${outcome}`);
        } catch (error) {
          if (error instanceof ApiAgentRejectedError) {
            log(`audit api-agent-submit-rejected session=${session} code=${error.code}`);
            throw new ChatInjectionRejectedError(error.message);
          }
          throw error;
        }
        return;
      }
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
          // 入力欄に残っていた文字を送らずに消した（residue-clear）。hub が会話内に出す。知らせる先が無い
          // 呼び出しでは渡さない（backend は黙って消さず、従来どおり送り出す。今回の本文そのものの残りだけは、
          // 送り出すと 2 回届くので消して打ち直す）。
          onResidueDiscarded: context.onResidueDiscarded,
          // 残っていたのが今回の本文そのもの（同じ発話の前の試行が途切れた分）で、知らせずに消して打ち直した。
          // 会話内には出さないので、ここで 1 行残す（事後解析用）。
          onSameTextResidueCleared: (residue) =>
            log(`audit chat-residue-same-text session=${session} chars=${[...residue].length}`),
          // 送信確定を確認できないまま配送済みレシートを返す唯一の経路。無言だと
          // 「送ったのに届かない」の再発に誰も気づけないので 1 行残す（事後解析用）。
          onUnconfirmedSubmit: () => log(`audit chat-submit-unconfirmed session=${session}`),
          // 終了の準備に入ったら、打ち始める前の発話は見送る（graceful shutdown）。
          mayStartTyping: context.mayStartTyping,
        });
      } finally {
        const elapsedMs = Date.now() - startedAt;
        log(`audit ${elapsedMs >= 4_000 ? "chat-inject-slow" : "chat-inject"} session=${session} elapsedMs=${elapsedMs}`);
      }
      // `/effort <level>` は会話途中だと確認ダイアログが挟まる（effort-dialog）。ユーザーの
      // 明示操作なので出現したら Enter で承認し、切替を完了させる。
      // ack（chat_send_result）を遅らせないよう待たずに流す（ダイアログ未出現時は 4s で諦める）。
      if (EFFORT_COMMAND_PATTERN.test(text)) {
        trackFollowup(confirmEffortChangeDialog(sessionBackend, session, { log }).catch((error: unknown) => {
          log(`effort dialog 承認失敗 session=${session} error=${String(error)}`);
        }));
      }
      // `/model <slug>` も同型の確認ダイアログ（`Switch model?`）が挟まる。herdr backend では
      // iOS の pane_preview 自動 Yes（入力 PTY）が claude へ届かないため host が承認する
      // （model-switch-dialog, 2026-09-06 実障害: 開き直した会話でモデル変更が未反映）。
      if (MODEL_COMMAND_PATTERN.test(text)) {
        trackFollowup(confirmModelSwitchDialog(sessionBackend, session, { log }).catch((error: unknown) => {
          log(`model dialog 承認失敗 session=${session} error=${String(error)}`);
        }));
      }
    },
  });
  hub.restoreFromHeartbeats();
  hub.restorePendingQuestions();
  // 開いていた API 作業の会話を待機状態で戻す（前回の hub が残した実行中のターンは利用額未確認へ）。
  hub.restoreApiAgents();
  // 受理記録は socket を開く前に戻す（つないできた engine の明示再送を、配送済みとして見分けるため）。queue の
  // 注入は socket を勝ち取ってから始める（起動競合で負けた hub が、勝った hub と同じ発話を注入しないように）。
  hub.restoreChatReceipts({ startDrains: false });
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
    // socket を勝ち取った時点で lock（pid と版の情報）の権威は自分。従来の判定で起動した場合の名残があっても、
    // ここで上書きすれば最終状態は必ず整合する。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: startupVersion }));
    hub.startRestoredDrains();
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
        !hub.hasInjectionsInFlight && !hub.hasCodexTurnsInFlight && !hub.hasApiAgentTurnsInFlight) {
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
    previewLoad.close();
    // 実行中の注入を終わらせてから接続を閉じ、最後に lock を外す（graceful shutdown）。待っている間に重ねて届く
    // SIGTERM（版違いの engine が ensure のたびに送る）は abort を繰り返すだけで、待ちを打ち切らない。
    await shutdownHub({
      hub, relayServer, socketServer, log,
      pendingWork: () => [...followupWork],
      finalize: () => {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        releaseOwnHubLock(lockPath);
        // 排他は最後に外す（ここまで次の hub は起動を見送る）。
        exclusive?.release();
      },
    });
  }
  return 0;

  function log(message: string): void {
    process.stderr.write(`[tailii-hub ${new Date().toISOString()}] ${message}\n`);
  }
}
