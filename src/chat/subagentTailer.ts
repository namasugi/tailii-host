// subagentTailer.ts
// tailii (TS host) — サブエージェント進捗ツリー tail
// Swift 版 SubagentTailer.swift の移植。
// claude の `<sessionId>/subagents/agent-*.meta.json` と main/subagent transcript を監視し、
// subagent_node（spawn/running → completed/error）を engine チャネルへ流す。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_V2, type ControlMessage, type SubagentNode, type SubagentNodeStatus, type ToolActivity } from "../protocol.js";
import { abortableSleep } from "../shared/sleep.js";
import { extractToolActivities, TranscriptTailer } from "./transcriptTailer.js";

export interface SubagentTailerOptions {
  /** 追記ポーリング間隔（ms）。既定 50ms。 */
  pollIntervalMs?: number;
  /** EOF 後も abort まで無期限に tail するか。既定 true。 */
  tailIndefinitely?: boolean;
  /** 孤児判定を始めるまでの起動猶予（ms）。既定 60s。 */
  orphanGraceMs?: number;
  /** 孤児判定プローブの間隔（ms）。既定 30s。 */
  orphanProbeIntervalMs?: number;
  /**
   * エージェント孤児の settle に必要な「transcript 静止時間」（ms）。既定 120s。
   * 大きな tool_use 入力のストリーミング中は transcript が無音になるため、
   * コマンド側の猶予より長めに取る。
   */
  agentOrphanGraceMs?: number;
  /** output ファイルを開いているプロセスの有無（null=判定不能）。テスト差し替え用。 */
  probeOutputOpen?: (filePath: string) => Promise<boolean | null>;
  /**
   * セッション（claude プロセス）の生存判定。テスト・上位配線の差し替え用。
   * true=生存確定 / false=死亡確定 / null=不明（生存扱い・安全側）。
   * lastActivityMs はセッションの transcript 群が最後に更新された時刻（不明なら null）。
   * 既定実装は defaultProbeSessionAlive を参照。
   */
  probeSessionAlive?: (sessionId: string, lastActivityMs: number | null) => Promise<boolean | null>;
  /**
   * 既定プローブが「argv 不一致 + transcript 静止」を死亡確定とみなす静止時間（ms）。
   * 既定 6h。SendMessage 待機など「生きているが transcript が静かな」セッションを
   * 誤って死亡扱いしないための余裕（実測の最長待機 ~3.8h より広い）。
   * 誤判定しても transcript が伸びれば自動で running へ回復する。
   */
  sessionStaleMs?: number;
}

interface Meta {
  agentType: string;
  description: string;
  /**
   * spawn 元 transcript の tool_use id。forked-skill エージェント（バックグラウンドの
   * スラッシュコマンド実行。meta は toolUseId の代わりに name を持つ）には存在しない。
   * null でも tail 対象にする — 親を tail しないと、その transcript に投函される
   * 子の task-notification・親子関係が丸ごと見えなくなる。
   */
  toolUseId: string | null;
  spawnDepth: number;
  /** meta に記録された起動元エージェント id（transcript 相関より優先する直接リンク）。 */
  parentAgentId: string | null;
  /** ユーザーが TaskStop 等で停止済み。通知は残らないため、これ自体が終了信号。 */
  stoppedByUser: boolean;
}

interface TrackedNode {
  nodeId: string;
  meta: Meta;
  metaPath: string;
  /** meta 再読込の契機（stoppedByUser は後から書かれる）。 */
  metaMtimeMs: number;
  jsonlPath: string | null;
  firstJsonlTimestampMs: number | null;
  lastJsonlTimestampMs: number | null;
  /** 自 transcript の最後の message 行が「text のみの assistant」= 最終レポートの形か。 */
  finalReportMarker: boolean | null;
  currentActivity: string | null;
  lastKey: string | null;
}

interface ToolResultHit {
  isError: boolean;
  ts: number | null;
  /** バックグラウンド起動の即時 ack（"Async agent launched…"）。終了扱いにしない。 */
  asyncLaunch: boolean;
}

/** 親 transcript の `<task-notification>` 行（バックグラウンド作業の真の完了信号）。 */
interface TaskNotification {
  status: string;
  exitCode: number | null;
  ts: number | null;
}

/** バックグラウンドコマンド（Bash run_in_background）の spawn 観測。 */
interface BackgroundSpawn {
  label: string;
  ts: number | null;
}

interface BackgroundCommand {
  taskId: string;
  toolUseId: string;
  owner: string;
  label: string;
  startTs: number | null;
  outputPath: string | null;
}

interface FileTailState {
  position: number;
  lineBuf: Buffer;
  ownerByToolUseId: Map<string, string>;
  resultByToolUseId: Map<string, ToolResultHit>;
  notificationByTaskId: Map<string, TaskNotification>;
  bgSpawnByToolUseId: Map<string, BackgroundSpawn>;
  bgCommandByTaskId: Map<string, BackgroundCommand>;
  firstTimestampMs: number | null;
}

/** サブエージェント meta/jsonl と親 transcript の tool_result を監視する。 */
export class SubagentTailer {
  private readonly pollIntervalMs: number;
  private readonly tailIndefinitely: boolean;
  private readonly orphanGraceMs: number;
  private readonly orphanProbeIntervalMs: number;
  private readonly agentOrphanGraceMs: number;
  private readonly probeOutputOpen: (filePath: string) => Promise<boolean | null>;
  private readonly probeSessionAlive: (
    sessionId: string,
    lastActivityMs: number | null,
  ) => Promise<boolean | null>;
  private readonly sessionStaleMs: number;
  private readonly jsonlPaths = new Map<string, string>();
  private readonly outputPaths = new Map<string, string>();

  constructor(options: SubagentTailerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.tailIndefinitely = options.tailIndefinitely ?? true;
    this.orphanGraceMs = options.orphanGraceMs ?? 60_000;
    this.orphanProbeIntervalMs = options.orphanProbeIntervalMs ?? 30_000;
    this.agentOrphanGraceMs = options.agentOrphanGraceMs ?? 120_000;
    this.probeOutputOpen = options.probeOutputOpen ?? defaultProbeOutputOpen;
    this.sessionStaleMs = options.sessionStaleMs ?? 6 * 60 * 60 * 1000;
    this.probeSessionAlive = options.probeSessionAlive
      ?? ((sessionId, lastActivityMs) => defaultProbeSessionAlive(sessionId, lastActivityMs, this.sessionStaleMs));
  }

  /** 現在 tail 中の nodeId から transcript 実体を引く。 */
  jsonlPath(nodeId: string): string | null {
    return this.jsonlPaths.get(nodeId) ?? null;
  }

  /** バックグラウンドコマンドの nodeId(taskId) から出力ファイルを引く。 */
  outputPath(nodeId: string): string | null {
    return this.outputPaths.get(nodeId) ?? null;
  }

  async *streamProjectDir(
    projectDir: string,
    preferredSessionId: string | null,
    newerThanMs: number | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    this.jsonlPaths.clear();
    this.outputPaths.clear();
    const start = Date.now();
    let mainTranscript: string | null = null;
    while (!signal?.aborted) {
      mainTranscript = TranscriptTailer.resolveJsonl(projectDir, preferredSessionId, newerThanMs);
      if (mainTranscript !== null) break;
      if (!this.tailIndefinitely) return;
      await abortableSleep(this.pollIntervalMs, signal);
      if (!this.tailIndefinitely && Date.now() - start > this.pollIntervalMs) return;
    }
    if (mainTranscript === null || signal?.aborted) return;
    yield* this.streamSession(mainTranscript, signal);
  }

  async *streamSession(
    mainTranscript: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ControlMessage, void, void> {
    const sessionId = path.basename(mainTranscript, ".jsonl");
    const subagentsDir = path.join(path.dirname(mainTranscript), sessionId, "subagents");
    const tracked = new Map<string, TrackedNode>();
    const fileStates = new Map<string, FileTailState>();
    const ownerByToolUseId = new Map<string, string>();
    const resultByToolUseId = new Map<string, ToolResultHit>();
    const notificationByTaskId = new Map<string, TaskNotification>();
    const bgCommandByTaskId = new Map<string, BackgroundCommand>();
    const bgLastKeyByTaskId = new Map<string, string>();
    // 通知が握り潰された背景コマンドの孤児判定（taskId → 終了扱いにした ts）。
    const bgOrphanTsByTaskId = new Map<string, number>();
    const bgFirstSeenMsByTaskId = new Map<string, number>();
    // 通知が配達されえない背景エージェントの孤児判定（nodeId → settle 扱いにした ts）。
    const agentOrphanTsByNodeId = new Map<string, number>();
    // 死亡セッションの一括 sweep マーク。生存へ転じたら全破棄して回復できるよう、
    // 通常の孤児 settle とは別に持つ。
    const deadSweepByNodeId = new Map<string, { ts: number; status: SubagentNodeStatus }>();
    // セッション transcript 群の最終更新（生存プローブの補助情報）。
    let lastActivityTsMs: number | null = null;
    // セッション（claude プロセス）の生存。false のみが「死亡確定」。null は生存扱い（安全側）。
    let sessionAlive: boolean | null = null;
    let lastSessionProbeMs = 0;
    let lastOrphanProbeMs = 0;
    let aggregateDirty = true;

    let lastMetaRefreshMs = 0;
    while (!signal?.aborted) {
      // meta の stat/再読込は毎 tick やると重い（ノード数×50ms）。1秒ごとに間引く。
      const refreshMetas = Date.now() - lastMetaRefreshMs >= 1_000;
      if (refreshMetas) lastMetaRefreshMs = Date.now();
      if (discoverMetaFiles(subagentsDir, tracked, refreshMetas)) aggregateDirty = true;
      for (const node of tracked.values()) {
        if (node.jsonlPath !== null) this.jsonlPaths.set(node.nodeId, node.jsonlPath);
      }

      const transcriptOwners = transcriptFiles(mainTranscript, tracked);
      for (const transcript of transcriptOwners) {
        const read = readNewLines(transcript.path, fileStates);
        const node = transcript.nodeId === null ? null : (tracked.get(transcript.nodeId) ?? null);
        if (read.reset) {
          aggregateDirty = true;
          if (node !== null) {
            node.currentActivity = null;
            node.lastJsonlTimestampMs = null;
            node.finalReportMarker = null;
          }
        }
        if (node !== null) node.firstJsonlTimestampMs = read.state.firstTimestampMs;
        if (read.lines.length > 0) aggregateDirty = true;
        for (const line of read.lines) {
          const lineTs = timestampMs(line);
          if (lineTs !== null && (lastActivityTsMs === null || lineTs > lastActivityTsMs)) {
            lastActivityTsMs = lineTs;
          }
          if (read.state.firstTimestampMs === null && lineTs !== null) {
            read.state.firstTimestampMs = lineTs;
          }
          if (node !== null) {
            node.firstJsonlTimestampMs = read.state.firstTimestampMs;
            if (lineTs !== null) node.lastJsonlTimestampMs = lineTs;
          }
          for (const id of extractSpawnToolUseIds(line)) read.state.ownerByToolUseId.set(id, transcript.owner);
          for (const spawn of extractBackgroundSpawns(line)) {
            read.state.bgSpawnByToolUseId.set(spawn.id, { label: spawn.label, ts: lineTs });
          }
          for (const hit of extractToolResults(line)) {
            read.state.resultByToolUseId.set(hit.id, {
              isError: hit.isError,
              ts: hit.ts,
              asyncLaunch: hit.asyncLaunch,
            });
            const launch = hit.backgroundLaunch;
            const spawn = read.state.bgSpawnByToolUseId.get(hit.id);
            if (launch !== null && spawn !== undefined) {
              read.state.bgCommandByTaskId.set(launch.taskId, {
                taskId: launch.taskId,
                toolUseId: hit.id,
                owner: transcript.owner,
                label: spawn.label,
                startTs: spawn.ts ?? hit.ts,
                outputPath: launch.outputPath,
              });
            }
            // TaskStop で停止されたタスクは task-notification を残さない。
            // 停止 ack を「静かな完了」として通知と同列に扱う。
            if (hit.stoppedTaskId !== null) {
              read.state.notificationByTaskId.set(hit.stoppedTaskId, {
                status: "completed",
                exitCode: null,
                ts: hit.ts ?? lineTs,
              });
            }
          }
          const notification = extractTaskNotification(line);
          if (notification !== null) {
            read.state.notificationByTaskId.set(notification.taskId, {
              status: notification.status,
              exitCode: notification.exitCode,
              ts: notification.ts ?? lineTs,
            });
          }
          if (node !== null) {
            const marker = finalReportMarker(line);
            if (marker !== null) node.finalReportMarker = marker;
            const activity = latestActivitySummary(line);
            if (activity !== null) node.currentActivity = activity;
          }
        }
      }
      if (aggregateDirty) {
        ownerByToolUseId.clear();
        resultByToolUseId.clear();
        notificationByTaskId.clear();
        bgCommandByTaskId.clear();
        for (const transcript of transcriptOwners) {
          const state = fileStates.get(transcript.path);
          if (state === undefined) continue;
          for (const [id, owner] of state.ownerByToolUseId) ownerByToolUseId.set(id, owner);
          for (const [id, result] of state.resultByToolUseId) resultByToolUseId.set(id, result);
          for (const [id, notification] of state.notificationByTaskId) {
            const existing = notificationByTaskId.get(id);
            if (existing === undefined || (notification.ts ?? 0) >= (existing.ts ?? 0)) {
              notificationByTaskId.set(id, notification);
            }
          }
          for (const [id, command] of state.bgCommandByTaskId) bgCommandByTaskId.set(id, command);
        }
        aggregateDirty = false;
      }

      const ownerOf = (node: TrackedNode): string | undefined => {
        // meta の直接リンクを優先（forked-skill の子は transcript 相関では解決できない）。
        const pid = node.meta.parentAgentId;
        if (pid !== null && tracked.has(pid)) return pid;
        const correlated = node.meta.toolUseId === null
          ? undefined
          : ownerByToolUseId.get(node.meta.toolUseId);
        // 深さ1は起動元が main（root）と確定できる（forked-skill 親もここに落ちる）。
        return correlated ?? (node.meta.spawnDepth <= 1 ? "root" : undefined);
      };
      const resolveAgentStatus = (node: TrackedNode): { status: SubagentNodeStatus; ts: number } => {
        const result = node.meta.toolUseId === null
          ? null
          : resultByToolUseId.get(node.meta.toolUseId) ?? null;
        if (result !== null && !result.asyncLaunch) {
          // 同期実行: 親 transcript の tool_result が終了信号。
          return {
            status: result.isError ? "error" : "completed",
            ts: result.ts ?? node.firstJsonlTimestampMs ?? mtimeMs(node.metaPath),
          };
        }
        // バックグラウンド実行（または結果未着）: task-notification が終了信号。
        // 通知後に自分の transcript が伸びたら resume とみなし running へ戻す。
        const notification = notificationByTaskId.get(node.nodeId) ?? null;
        const resumedAfter = notification !== null && notification.ts !== null
          && (node.lastJsonlTimestampMs ?? 0) > notification.ts;
        if (notification !== null && !resumedAfter) {
          return {
            status: notification.status === "completed" ? "completed" : "error",
            ts: notification.ts ?? node.lastJsonlTimestampMs ?? mtimeMs(node.metaPath),
          };
        }
        // ユーザー停止済み（TaskStop 等）。通知は残らないため meta の刻印が終了信号。
        if (node.meta.stoppedByUser) {
          return { status: "completed", ts: node.lastJsonlTimestampMs ?? mtimeMs(node.metaPath) };
        }
        // 通知が配達されえず孤児 settle 済みなら completed。settle 後に transcript が
        // 伸びたら resume とみなしマークを破棄して running へ戻す（孤児検知で再評価される）。
        const orphanTs = agentOrphanTsByNodeId.get(node.nodeId);
        if (orphanTs !== undefined) {
          if ((node.lastJsonlTimestampMs ?? 0) > orphanTs) {
            agentOrphanTsByNodeId.delete(node.nodeId);
          } else {
            return { status: "completed", ts: orphanTs };
          }
        }
        // 死亡セッションの sweep マーク。transcript が伸びたら破棄（誤判定からの回復）。
        const sweep = deadSweepByNodeId.get(node.nodeId);
        if (sweep !== undefined) {
          if ((node.lastJsonlTimestampMs ?? 0) > sweep.ts) {
            deadSweepByNodeId.delete(node.nodeId);
          } else {
            return { status: sweep.status, ts: sweep.ts };
          }
        }
        return { status: "running", ts: node.firstJsonlTimestampMs ?? mtimeMs(node.metaPath) };
      };

      const nowMs = Date.now();
      if (nowMs - lastSessionProbeMs >= this.orphanProbeIntervalMs) {
        lastSessionProbeMs = nowMs;
        sessionAlive = await this.probeSessionAlive(sessionId, lastActivityTsMs);
      }

      // 孤児判定（エージェント）: 背景エージェントの task-notification は「起動元の transcript に、
      // 起動元が次に動くとき」に投函されるため、起動元が子より先に終端した・セッションが死んだ等で
      // 配達が途絶えると二度と届かない。判定はセッション生存で二分する:
      //
      // [死亡確定 (sessionAlive === false)] このセッションの作業は何も動いていない。
      //   静止時間が猶予を超えた running ノードを最終レポートの有無を問わず一括 settle する
      //   （中断で tool_use のまま止まった木・同期起動の孤児もここで解消する）。
      //
      // [生存または不明] root（main）起動のノードは settle しない — 生きている main への
      //   通知配達は途絶えないし、SendMessage 待機中の生存エージェントを「完了」に
      //   してはならない。settle するのは「実信号（通知/同期結果/停止刻印/過去の settle）で
      //   終端した起動元」に根ざした木だけ。条件:
      //   - 背景起動（forked-skill、または async 起動 ack 済み）だが有効な完了信号がない
      //   - 最後の message 行が「text のみの assistant」（最終レポート済み。再開注入の
      //     user 行でマーカーが倒れるため、再開直後の長考中は候補にならない）
      //   - transcript が agentOrphanGraceMs 以上静止（transcript 時刻起点なので
      //     tail 張り直し直後でも古い孤児は即 settle できる）
      //   - 直下に running かつ非候補の子（エージェント/背景コマンド）がいない（fixpoint。
      //     子の通知で再開されうるため）
      //   - 起動元が終端済み、または「終端済みに根ざして承認された候補」（承認は終端
      //     アンカーからの伝播のみ。候補同士の相互承認では settle しないので、壊れた
      //     meta の循環参照でも誤 settle しない）
      const agentStatusById = new Map<string, SubagentNodeStatus>();
      for (const node of tracked.values()) agentStatusById.set(node.nodeId, resolveAgentStatus(node).status);
      const lastActivityMs = (node: TrackedNode): number =>
        node.lastJsonlTimestampMs ?? mtimeMs(node.jsonlPath ?? node.metaPath);
      if (sessionAlive === false) {
        for (const node of tracked.values()) {
          if (agentStatusById.get(node.nodeId) !== "running") continue;
          if (deadSweepByNodeId.has(node.nodeId)) continue;
          const lastTs = lastActivityMs(node);
          if (lastTs <= 0 || nowMs - lastTs < this.agentOrphanGraceMs) continue;
          deadSweepByNodeId.set(node.nodeId, {
            ts: lastTs,
            // 最終レポートの形で止まっていれば完了、tool_use のまま止まっていれば中断(error)。
            status: node.finalReportMarker === true ? "completed" : "error",
          });
        }
      } else {
        // 生存（または不明）へ転じたら sweep 由来のマークは全破棄する。
        // 死亡判定が誤りだった場合の回復経路（通常の孤児 settle は保持する）。
        if (deadSweepByNodeId.size > 0) deadSweepByNodeId.clear();
        const settleCandidates = new Set<string>();
        for (const node of tracked.values()) {
          if (agentStatusById.get(node.nodeId) !== "running") continue;
          const result = node.meta.toolUseId === null
            ? null
            : resultByToolUseId.get(node.meta.toolUseId) ?? null;
          const backgroundLaunch = node.meta.toolUseId === null || (result !== null && result.asyncLaunch);
          if (!backgroundLaunch) continue;
          if (node.finalReportMarker !== true) continue;
          if (node.lastJsonlTimestampMs === null) continue;
          if (nowMs - node.lastJsonlTimestampMs < this.agentOrphanGraceMs) continue;
          settleCandidates.add(node.nodeId);
        }
        for (;;) {
          const blockedOwners = new Set<string>();
          for (const node of tracked.values()) {
            if (agentStatusById.get(node.nodeId) !== "running") continue;
            if (settleCandidates.has(node.nodeId)) continue;
            const owner = ownerOf(node);
            if (owner !== undefined) blockedOwners.add(owner);
          }
          for (const command of bgCommandByTaskId.values()) {
            if (notificationByTaskId.has(command.taskId) || bgOrphanTsByTaskId.has(command.taskId)) continue;
            blockedOwners.add(command.owner);
          }
          let changed = false;
          for (const id of settleCandidates) {
            if (!blockedOwners.has(id)) continue;
            settleCandidates.delete(id);
            changed = true;
          }
          if (!changed) break;
        }
        const approved = new Set<string>();
        for (;;) {
          let changed = false;
          for (const id of settleCandidates) {
            if (approved.has(id)) continue;
            const node = tracked.get(id);
            if (node === undefined) continue;
            const ownerId = ownerOf(node);
            if (ownerId === undefined || ownerId === "root") continue;
            const ownerStatus = agentStatusById.get(ownerId);
            if (ownerStatus !== "completed" && ownerStatus !== "error" && !approved.has(ownerId)) continue;
            approved.add(id);
            changed = true;
          }
          if (!changed) break;
        }
        for (const id of approved) {
          const node = tracked.get(id);
          if (node === undefined) continue;
          agentOrphanTsByNodeId.set(id, lastActivityMs(node));
        }
      }

      for (const node of tracked.values()) {
        const { status, ts } = resolveAgentStatus(node);
        const parentNodeId = ownerOf(node) ?? fallbackParent(node.meta.spawnDepth);
        const messageNode: SubagentNode = {
          nodeId: node.nodeId,
          // forked-skill エージェントに tool_use はない。ワイヤ上は必須 string のため空で送る。
          toolUseId: node.meta.toolUseId ?? "",
          parentNodeId,
          agentType: node.meta.agentType,
          label: node.meta.description,
          depth: node.meta.spawnDepth,
          status,
          currentActivity: status === "running" ? node.currentActivity : null,
          ts,
        };
        const key = stableNodeKey(messageNode);
        if (key === node.lastKey) continue;
        node.lastKey = key;
        yield { type: "subagent_node", v: PROTOCOL_V2, node: messageNode };
      }

      // 孤児判定（背景コマンド）: task-notification は起動元エージェントが先に終了すると
      // 届かないまま消えることがある（完了信号の消失）。output ファイルを開いているプロセスが
      // いなければ「終了済みなのに通知が来ない孤児」として完了へ落とす。
      // 実行中のコマンドはシェルが output の fd を保持し続けるため誤爆しない。
      if (nowMs - lastOrphanProbeMs >= this.orphanProbeIntervalMs) {
        lastOrphanProbeMs = nowMs;
        for (const command of bgCommandByTaskId.values()) {
          if (notificationByTaskId.has(command.taskId)) continue;
          if (bgOrphanTsByTaskId.has(command.taskId)) continue;
          if (command.outputPath === null) continue;
          let bornMs = bgFirstSeenMsByTaskId.get(command.taskId);
          if (bornMs === undefined) {
            bornMs = command.startTs ?? nowMs;
            bgFirstSeenMsByTaskId.set(command.taskId, bornMs);
          }
          if (nowMs - bornMs < this.orphanGraceMs) continue;
          const open = await this.probeOutputOpen(command.outputPath);
          if (open === false) {
            const endTs = mtimeMs(command.outputPath);
            bgOrphanTsByTaskId.set(command.taskId, endTs > 0 ? endTs : nowMs);
          }
        }
      }

      for (const command of bgCommandByTaskId.values()) {
        if (command.outputPath !== null) this.outputPaths.set(command.taskId, command.outputPath);
        const notification = notificationByTaskId.get(command.taskId) ?? null;
        // 遅配された本物の通知が届いたら exit code 込みでそちらを優先する。
        const orphanTs = notification === null ? (bgOrphanTsByTaskId.get(command.taskId) ?? null) : null;
        const failed = notification !== null
          && (notification.status !== "completed" || (notification.exitCode ?? 0) !== 0);
        const status: SubagentNodeStatus = notification !== null
          ? (failed ? "error" : "completed")
          : (orphanTs !== null ? "completed" : "running");
        const ownerNode = tracked.get(command.owner) ?? null;
        const messageNode: SubagentNode = {
          nodeId: command.taskId,
          toolUseId: command.toolUseId,
          parentNodeId: command.owner,
          agentType: "Bash",
          label: command.label,
          depth: ownerNode === null ? 1 : ownerNode.meta.spawnDepth + 1,
          status,
          currentActivity: null,
          ts: notification?.ts ?? orphanTs ?? command.startTs ?? 0,
          kind: "command",
        };
        const key = stableNodeKey(messageNode);
        if (key === bgLastKeyByTaskId.get(command.taskId)) continue;
        bgLastKeyByTaskId.set(command.taskId, key);
        yield { type: "subagent_node", v: PROTOCOL_V2, node: messageNode };
      }

      if (!this.tailIndefinitely) return;
      await abortableSleep(this.pollIntervalMs, signal);
    }
  }
}

function discoverMetaFiles(
  dir: string,
  tracked: Map<string, TrackedNode>,
  refreshMetas: boolean,
): boolean {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let changed = false;
  for (const file of files.sort()) {
    const match = /^agent-(.+)\.meta\.json$/.exec(file);
    if (match === null) continue;
    const nodeId = match[1]!;
    const existing = tracked.get(nodeId);
    if (existing !== undefined) {
      const jsonlPath = siblingJsonl(existing.metaPath);
      if (existing.jsonlPath !== jsonlPath) {
        existing.jsonlPath = jsonlPath;
        changed = true;
      }
      // stoppedByUser は停止時に後から書き込まれるため、mtime 変化で meta を読み直す。
      if (refreshMetas) {
        const metaMtime = mtimeMs(existing.metaPath);
        if (metaMtime !== existing.metaMtimeMs) {
          existing.metaMtimeMs = metaMtime;
          const meta = readMeta(existing.metaPath);
          if (meta !== null) {
            existing.meta = meta;
            changed = true;
          }
        }
      }
      continue;
    }
    const metaPath = path.join(dir, file);
    const meta = readMeta(metaPath);
    if (meta === null) continue;
    tracked.set(nodeId, {
      nodeId,
      meta,
      metaPath,
      metaMtimeMs: mtimeMs(metaPath),
      jsonlPath: siblingJsonl(metaPath),
      firstJsonlTimestampMs: null,
      lastJsonlTimestampMs: null,
      finalReportMarker: null,
      currentActivity: null,
      lastKey: null,
    });
    changed = true;
  }
  return changed;
}

function readMeta(metaPath: string): Meta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed["agentType"] !== "string" ||
      typeof parsed["description"] !== "string" ||
      typeof parsed["spawnDepth"] !== "number"
    ) {
      return null;
    }
    return {
      agentType: parsed["agentType"],
      description: parsed["description"],
      toolUseId: typeof parsed["toolUseId"] === "string" ? parsed["toolUseId"] : null,
      spawnDepth: parsed["spawnDepth"],
      parentAgentId: typeof parsed["parentAgentId"] === "string" ? parsed["parentAgentId"] : null,
      stoppedByUser: parsed["stoppedByUser"] === true,
    };
  } catch {
    return null;
  }
}

function siblingJsonl(metaPath: string): string | null {
  const jsonl = metaPath.replace(/\.meta\.json$/, ".jsonl");
  return fs.existsSync(jsonl) ? jsonl : null;
}

function transcriptFiles(
  mainTranscript: string,
  tracked: Map<string, TrackedNode>,
): { path: string; owner: string; nodeId: string | null }[] {
  const out: { path: string; owner: string; nodeId: string | null }[] = [
    { path: mainTranscript, owner: "root", nodeId: null },
  ];
  for (const node of tracked.values()) {
    if (node.jsonlPath !== null) out.push({ path: node.jsonlPath, owner: node.nodeId, nodeId: node.nodeId });
  }
  return out;
}

function readNewLines(
  file: string,
  states: Map<string, FileTailState>,
): { lines: string[]; reset: boolean; state: FileTailState } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    const state = ensureFileState(file, states);
    return { lines: [], reset: false, state };
  }

  const state = ensureFileState(file, states);
  let reset = false;
  if (stat.size < state.position) {
    state.position = 0;
    state.lineBuf = Buffer.alloc(0);
    state.ownerByToolUseId.clear();
    state.resultByToolUseId.clear();
    state.notificationByTaskId.clear();
    state.bgSpawnByToolUseId.clear();
    state.bgCommandByTaskId.clear();
    state.firstTimestampMs = null;
    reset = true;
  }

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { lines: [], reset, state };
  }

  const out: string[] = [];
  const chunk = Buffer.alloc(4096);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, state.position);
      if (bytesRead === 0) break;
      state.position += bytesRead;
      state.lineBuf = Buffer.concat([state.lineBuf, chunk.subarray(0, bytesRead)]);
      let nl = state.lineBuf.indexOf(0x0a);
      while (nl >= 0) {
        const line = state.lineBuf.subarray(0, nl).toString("utf8").replaceAll("\r", "");
        state.lineBuf = state.lineBuf.subarray(nl + 1);
        if (line.length > 0) out.push(line);
        nl = state.lineBuf.indexOf(0x0a);
      }
    }
  } catch {
    return { lines: out, reset, state };
  } finally {
    // Subagent tailing watches a changing set of files, so each tick opens only for
    // the incremental read and closes immediately. Offsets and partial lines stay cached.
    try {
      fs.closeSync(fd);
    } catch {
      // 二重 close 等は無視。
    }
  }
  return { lines: out, reset, state };
}

function ensureFileState(file: string, states: Map<string, FileTailState>): FileTailState {
  let state = states.get(file);
  if (state === undefined) {
    state = {
      position: 0,
      lineBuf: Buffer.alloc(0),
      ownerByToolUseId: new Map(),
      resultByToolUseId: new Map(),
      notificationByTaskId: new Map(),
      bgSpawnByToolUseId: new Map(),
      bgCommandByTaskId: new Map(),
      firstTimestampMs: null,
    };
    states.set(file, state);
  }
  return state;
}

function extractSpawnToolUseIds(line: string): string[] {
  const content = messageContent(line);
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_use") continue;
    // 実データでは Agent、brief のサンプル/旧名では Task。どちらも同じ spawn path として扱う。
    if (rec["name"] !== "Task" && rec["name"] !== "Agent") continue;
    if (typeof rec["id"] === "string") ids.push(rec["id"]);
  }
  return ids;
}

interface ToolResultExtract {
  id: string;
  isError: boolean;
  ts: number | null;
  asyncLaunch: boolean;
  backgroundLaunch: { taskId: string; outputPath: string | null } | null;
  /** TaskStop の停止 ack。停止されたタスクは task-notification を残さないため、これが終了信号。 */
  stoppedTaskId: string | null;
}

function extractToolResults(line: string): ToolResultExtract[] {
  const content = messageContent(line);
  const ts = timestampMs(line);
  if (!Array.isArray(content)) return [];
  const out: ToolResultExtract[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_result") continue;
    if (typeof rec["tool_use_id"] !== "string") continue;
    const text = toolResultPlainText(rec["content"]);
    const bgMatch = /Command running in background with ID: (\S+?)\.?(?:\s|$)/.exec(text);
    const outputMatch = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text);
    const stopMatch = /Successfully stopped task: ([A-Za-z0-9_-]+)/.exec(text);
    out.push({
      id: rec["tool_use_id"],
      isError: rec["is_error"] === true,
      ts,
      asyncLaunch: text.startsWith("Async agent launched successfully"),
      backgroundLaunch: bgMatch === null
        ? null
        : { taskId: bgMatch[1]!, outputPath: outputMatch?.[1] ?? null },
      stoppedTaskId: stopMatch?.[1] ?? null,
    });
  }
  return out;
}

function toolResultPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] === "text" && typeof rec["text"] === "string") parts.push(rec["text"]);
  }
  return parts.join("\n");
}

/** Bash の run_in_background 起動（バックグラウンドコマンド）の tool_use を抽出する。 */
function extractBackgroundSpawns(line: string): { id: string; label: string }[] {
  const content = messageContent(line);
  if (!Array.isArray(content)) return [];
  const out: { id: string; label: string }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "tool_use" || rec["name"] !== "Bash") continue;
    if (typeof rec["id"] !== "string") continue;
    const input = typeof rec["input"] === "object" && rec["input"] !== null
      ? rec["input"] as Record<string, unknown>
      : null;
    if (input?.["run_in_background"] !== true) continue;
    const description = typeof input["description"] === "string" ? input["description"] : "";
    const command = typeof input["command"] === "string" ? input["command"] : "";
    const label = description.length > 0 ? description : truncateActivityLabel(command);
    out.push({ id: rec["id"], label: label.length > 0 ? label : "background command" });
  }
  return out;
}

/**
 * 親 transcript の `<task-notification>` 行（user メッセージの文字列 content）を解析する。
 * バックグラウンドのエージェント/コマンド共通の完了信号で、task-id はエージェントの
 * nodeId またはコマンドの taskId に一致する。
 */
function extractTaskNotification(
  line: string,
): { taskId: string; status: string; exitCode: number | null; ts: number | null } | null {
  const content = messageContent(line);
  if (typeof content !== "string" || !content.includes("<task-notification>")) return null;
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1];
  if (taskId === undefined) return null;
  const status = /<status>([^<]+)<\/status>/.exec(content)?.[1] ?? "completed";
  const summary = /<summary>([^<]*)<\/summary>/.exec(content)?.[1] ?? "";
  const exitCode = /exit code (\d+)/.exec(summary)?.[1];
  return {
    taskId,
    status,
    exitCode: exitCode === undefined ? null : Number(exitCode),
    ts: timestampMs(line),
  };
}

/**
 * message 行の「最終レポートらしさ」を返す:
 *   true  = text のみの assistant 行（サブエージェントはこの形で停止する）
 *   false = それ以外の message 行（user 行・tool_use を含む assistant 行）
 *   null  = message を持たない行（summary 等。判定を変えない）
 * true のまま transcript が静止していればエージェントは停止済み。再開注入
 * （task-notification / SendMessage）は user 行として届き false へ倒れるため、
 * 再開直後の長考中を「最終レポート済み」と誤認しない。
 */
function finalReportMarker(line: string): boolean | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const message = obj["message"];
    if (typeof message !== "object" || message === null) return null;
    const rec = message as Record<string, unknown>;
    const content = rec["content"];
    if (content === undefined || content === null) return null;
    if (rec["role"] !== "assistant") return false;
    if (typeof content === "string") return true;
    if (!Array.isArray(content)) return null;
    return !content.some((block) =>
      typeof block === "object" && block !== null
      && (block as Record<string, unknown>)["type"] === "tool_use");
  } catch {
    return null;
  }
}

function latestActivitySummary(line: string): string | null {
  const activities = extractToolActivities(messageContent(line));
  const latest = activities.at(-1);
  return latest === undefined ? null : truncateActivityLabel(formatActivityLabel(latest));
}

function formatActivityLabel(activity: ToolActivity): string {
  switch (activity.name) {
    case "Bash":
      return `Bash: ${activity.command ?? activity.description ?? stripActivityPrefix(activity.label, activity.name)}`;
    case "Edit":
    case "MultiEdit":
      return `${activity.name} ${displayActivityTarget(activity)}`;
    case "Write":
    case "NotebookEdit":
      return `${activity.name} ${displayActivityTarget(activity)}`;
    case "Read":
      return `Read ${displayActivityTarget(activity)}`;
    case "TodoWrite":
      return "Todo更新";
    default: {
      const detail = displayActivityTarget(activity);
      return detail === activity.name ? activity.name : `${activity.name}: ${detail}`;
    }
  }
}

function displayActivityTarget(activity: ToolActivity): string {
  if (activity.file !== undefined && activity.file.length > 0) {
    const base = path.basename(activity.file);
    return base.length > 0 ? base : activity.file;
  }
  return stripActivityPrefix(activity.label, activity.name);
}

function stripActivityPrefix(label: string, fallback: string): string {
  const stripped = label
    .replace(/^(実行済み|編集済み|作成済み|既読|検索済み)\s*/, "")
    .replace(/^Todoを更新しました$/, "Todo更新")
    .trim();
  return stripped.length > 0 ? stripped : fallback;
}

function truncateActivityLabel(label: string): string {
  const limit = 60;
  return label.length <= limit ? label : `${label.slice(0, limit - 1)}…`;
}

function messageContent(line: string): unknown {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const message = obj["message"];
    if (typeof message === "object" && message !== null) {
      return (message as Record<string, unknown>)["content"];
    }
    return obj["content"];
  } catch {
    return null;
  }
}

function timestampMs(line: string): number | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj["timestamp"] !== "string") return null;
    const ms = Date.parse(obj["timestamp"]);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function mtimeMs(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

function fallbackParent(depth: number): string | null {
  return depth <= 1 ? "root" : null;
}

/**
 * 背景コマンドの output ファイルを開いているプロセスの有無を調べる。
 * ハーネスは背景シェルの stdout/stderr を output へ向けるため、コマンド（と子孫）が
 * 生きている限り fd 保持者が存在する。true=生存 / false=誰も開いていない / null=判定不能。
 */
async function defaultProbeOutputOpen(filePath: string): Promise<boolean | null> {
  const viaLsof = await probeViaLsof(filePath);
  if (viaLsof !== null) return viaLsof;
  return probeViaProcFd(filePath);
}

function probeViaLsof(filePath: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-t", "--", filePath], { timeout: 10_000 }, (error, stdout) => {
      if (error === null) {
        resolve(stdout.trim().length > 0);
        return;
      }
      // exit 1 = 開いているプロセスなし（ファイル消失も同じ扱いで孤児側に倒す）。
      // lsof 不在・タイムアウト等は判定不能として running 維持（安全側）。
      const code: unknown = (error as { code?: unknown }).code;
      resolve(code === 1 ? false : null);
    });
  });
}

/** プロセスプローブ用の execFile 差し替え口（テスト用）。 */
export type ProcessProbeExec = (
  cmd: string,
  args: string[],
  callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void,
) => void;

const defaultProbeExec: ProcessProbeExec = (cmd, args, callback) => {
  execFile(cmd, args, { timeout: 10_000 }, (error, stdout) => {
    callback(error as (Error & { code?: unknown }) | null, stdout ?? "");
  });
};

/**
 * セッションの claude プロセス生存を判定する。
 *   1) argv にセッション id を持つプロセスがいれば生存確定（Tailii が張る engine は
 *      `--session-id`/`--resume` で id を運ぶ）。
 *   2) argv 不一致でも bare CLI（argv に id なし）の可能性が残るため、transcript が
 *      staleMs 以内に更新されていれば「不明」（生存扱い）。
 *   3) argv 不一致 かつ transcript が staleMs 以上静止しているときだけ「死亡確定」。
 *      生きているのに静かなだけのセッションを誤判定しても、transcript が伸びれば
 *      sweep マークは破棄され running へ回復する。
 * プロセス名の照合（`lsof -c claude` 等）は使わない — macOS では CLI の comm が
 * バージョン文字列（例 "2.1.226"）になるなど環境・バージョンで壊れるため。
 * プローブ不能（pgrep 不在・タイムアウト等）は常に「不明」= 生存扱いへ倒す。
 */
export async function defaultProbeSessionAlive(
  sessionId: string,
  lastActivityMs: number | null,
  staleMs: number,
  exec: ProcessProbeExec = defaultProbeExec,
): Promise<boolean | null> {
  const byArgv = await probeArgvAlive(sessionId, exec);
  if (byArgv === true) return true;
  if (byArgv === null) return null;
  if (lastActivityMs === null) return null;
  return Date.now() - lastActivityMs >= staleMs ? false : null;
}

/** argv にセッション id を持つプロセスの有無。true / false / null(判定不能)。 */
function probeArgvAlive(sessionId: string, exec: ProcessProbeExec): Promise<boolean | null> {
  return new Promise((resolve) => {
    exec("pgrep", ["-f", sessionId], (error, stdout) => {
      if (error === null) {
        resolve(stdout.trim().length > 0);
        return;
      }
      // exit 1 = 一致なし。それ以外（pgrep 不在・タイムアウト等）は判定不能。
      const code: unknown = error.code;
      resolve(code === 1 ? false : null);
    });
  });
}

/** lsof が無い Linux 向けフォールバック。/proc/<pid>/fd を走査する。 */
function probeViaProcFd(filePath: string): boolean | null {
  let target: string;
  try {
    target = fs.realpathSync(filePath);
  } catch {
    return false;
  }
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === target) return true;
      } catch {
        // 走査中に消えた fd は無視。
      }
    }
  }
  return false;
}

function stableNodeKey(node: SubagentNode): string {
  return JSON.stringify([
    node.nodeId,
    node.toolUseId,
    node.parentNodeId ?? null,
    node.agentType,
    node.label,
    node.depth,
    node.status,
    node.currentActivity ?? null,
    node.ts,
    node.kind ?? null,
  ]);
}
