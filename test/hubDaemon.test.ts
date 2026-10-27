// hubDaemon.test.ts — Session Hub daemon の lock / ensure / socket 骨格テスト

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireHubLock,
  controlMessageCallbackWriter,
  createPrioritizedHubSocketWriter,
  ensureHubDaemon,
  HUB_SOCKET_CONVERSATION_EVENT_BATCH_SIZE,
  HUB_SOCKET_CONVERSATION_EVENT_FLUSH_INTERVAL_MS,
  HUB_SOCKET_WRITABLE_LENGTH_LIMIT,
  pidAlive,
  readHubLock,
  releaseOwnHubLock,
  shutdownHub,
  startHubSocket,
  writeHubSocketLine,
} from "../src/hub/hubDaemon.js";
import { encodeHubMessage } from "../src/hub/hubProtocol.js";
import type { ControlMessage } from "../src/protocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { sendQuestionEventToEngine, startEngineRelaySocket } from "../src/hub/engineRelaySocket.js";
import { readPackageVersion } from "../src/shared/version.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok } from "./helpers.js";
import {
  canListenUnixSocket,
  connectUnixClient,
  SocketLineReader,
  tempSocketPath,
  writeLine,
} from "./socketHelpers.js";

afterEach(() => vi.restoreAllMocks());

function spawnRecorder(): { args: string[][]; spawnImpl: typeof import("node:child_process").spawn } {
  const args: string[][] = [];
  const spawnImpl = ((command: string, commandArgs: string[]) => {
    args.push([command, ...commandArgs]);
    return { unref: () => {} };
  }) as unknown as typeof import("node:child_process").spawn;
  return { args, spawnImpl };
}

describe("hub shutdown", () => {
  test("shutdownHub は接続を開いたまま注入と後処理の完了を待ち、その後で接続を閉じ、最後に lock を外す", async () => {
    // 2026-10-26: 注入の途中で切ると、送れた発話が配送不明のまま残り、アプリの明示再送で 2 回届きうる。
    // 接続を先に閉じると engine の再接続の間隔が伸び、hub の居ない時間が待ちの長さ以上に延びる（独立検証）。
    const order: string[] = [];
    const logs: string[] = [];
    let releaseFollowup: (() => void) | undefined;
    const followup = new Promise<void>((resolve) => { releaseFollowup = resolve; });
    setTimeout(() => { order.push("followup done"); releaseFollowup?.(); }, 15);
    await shutdownHub({
      relayServer: { close: async () => { order.push("relay.close"); } },
      socketServer: { close: async () => { order.push("socket.close"); } },
      hub: {
        drainForShutdown: async (timeoutMs) => {
          order.push(`drain:${timeoutMs}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          order.push("drained");
          return { inFlight: 1, drained: true, waitedMs: 5 };
        },
        close: () => { order.push("hub.close"); },
      },
      pendingWork: () => [followup],
      finalize: () => { order.push("finalize"); },
      log: (message) => logs.push(message),
      drainTimeoutMs: 1234,
    });
    expect(order).toEqual([
      "drain:1234", "drained", "followup done", "relay.close", "socket.close", "hub.close", "finalize",
    ]);
    expect(logs).toEqual([
      "audit hub_shutdown_drain inflight=1 drained=true waitedMs=5 followups=1 followupsSettled=true",
    ]);
  });

  test("shutdownHub は後処理を上限までしか待たず、閉じる・内部を閉じるのに失敗しても lock は外す", async () => {
    const order: string[] = [];
    const logs: string[] = [];
    await expect(shutdownHub({
      relayServer: { close: async () => { order.push("relay.close"); throw new Error("relay close failed"); } },
      socketServer: { close: async () => { order.push("socket.close"); } },
      hub: {
        drainForShutdown: async () => { order.push("drain"); return { inFlight: 0, drained: true, waitedMs: 0 }; },
        close: () => { order.push("hub.close"); throw new Error("hub close failed"); },
      },
      pendingWork: () => [new Promise<void>(() => {})],
      finalize: () => { order.push("finalize"); },
      log: (message) => logs.push(message),
      drainTimeoutMs: 20,
    })).rejects.toThrow("hub close failed");
    expect(order).toEqual(["drain", "relay.close", "socket.close", "hub.close", "finalize"]);
    expect(logs).toEqual([
      "audit hub_shutdown_drain inflight=0 drained=true waitedMs=0 followups=1 followupsSettled=false",
      "終了処理: relay を閉じられなかった（続行）: Error: relay close failed",
    ]);
    // 注入も後処理も無ければ監査行を出さない。
    const quiet: string[] = [];
    await shutdownHub({
      relayServer: null, socketServer: null,
      hub: { drainForShutdown: async () => ({ inFlight: 0, drained: true, waitedMs: 0 }), close: () => {} },
      log: (message) => quiet.push(message),
    });
    expect(quiet).toEqual([]);
  });

  test("releaseOwnHubLock は自分の lock だけを消す（後継 daemon の lock は残す）", () => {
    const dir = makeTempDir("hub-release-lock");
    const lockPath = path.join(dir, "hub.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, version: "1.0.0" }));
    releaseOwnHubLock(lockPath, 1111);
    expect(readHubLock(lockPath)).toEqual({ pid: 4242, version: "1.0.0" });
    releaseOwnHubLock(lockPath, 4242);
    expect(fs.existsSync(lockPath)).toBe(false);
    // 無い lock でも投げない。
    releaseOwnHubLock(lockPath, 4242);
  });
});

describe("hub lock / ensure", () => {
  test("hub は TMUX / TMUX_PANE を外した環境で起動する（herdr 配下の Claude の tmux 欄誤記を防ぐ）", () => {
    const dir = makeTempDir("hub-lock");
    const saved = { tmux: process.env["TMUX"], pane: process.env["TMUX_PANE"], marker: process.env["TAILII_TEST_MARKER"] };
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl = ((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedEnv = options.env;
      return { unref: () => {} };
    }) as unknown as typeof import("node:child_process").spawn;
    try {
      process.env["TMUX"] = "/tmp/tmux-501/default,1,0";
      process.env["TMUX_PANE"] = "%4";
      process.env["TAILII_TEST_MARKER"] = "kept";
      ensureHubDaemon({
        lockPath: path.join(dir, "hub.lock"), cliPath: "/x/cli.js", logPath: path.join(dir, "hub.log"), spawnImpl,
      });
    } finally {
      for (const [key, value] of [["TMUX", saved.tmux], ["TMUX_PANE", saved.pane], ["TAILII_TEST_MARKER", saved.marker]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(spawnedEnv?.["TMUX"]).toBeUndefined();
    expect(spawnedEnv?.["TMUX_PANE"]).toBeUndefined();
    expect(spawnedEnv?.["TAILII_TEST_MARKER"]).toBe("kept");
  });

  test("readHubLock は pid 必須・壊れは null、pidAlive は自プロセスで true", () => {
    const lockPath = path.join(makeTempDir("hub-lock"), "hub.lock");
    expect(readHubLock(lockPath)).toBeNull();
    fs.writeFileSync(lockPath, "not json");
    expect(readHubLock(lockPath)).toBeNull();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: "1.2.3" }));
    expect(readHubLock(lockPath)).toEqual({ pid: process.pid, version: "1.2.3" });
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("lock を書き、生存中の別 pid による二重起動を拒否する", () => {
    const lockPath = path.join(makeTempDir("hub-lock"), "hub.lock");
    expect(acquireHubLock(lockPath, "1.2.3")).toBe(true);
    expect(readHubLock(lockPath)).toEqual({ pid: process.pid, version: "1.2.3" });
    expect(acquireHubLock(lockPath, "1.2.3", process.pid + 1)).toBe(false);
    expect(readHubLock(lockPath)?.pid).toBe(process.pid);
  });

  test("死んだ所有者の lock は奪取できる", () => {
    const lockPath = path.join(makeTempDir("hub-lock"), "hub.lock");
    const deadPid = process.pid + 12345;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && pid === deadPid) {
        const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, version: "1.2.3" }));
    expect(acquireHubLock(lockPath, "1.2.4")).toBe(true);
    expect(readHubLock(lockPath)).toEqual({ pid: process.pid, version: "1.2.4" });
  });

  test("自 pid の lock は再表明できて version が更新される", () => {
    const lockPath = path.join(makeTempDir("hub-lock"), "hub.lock");
    expect(acquireHubLock(lockPath, "1.2.3")).toBe(true);
    expect(acquireHubLock(lockPath, "1.2.4")).toBe(true);
    expect(readHubLock(lockPath)).toEqual({ pid: process.pid, version: "1.2.4" });
  });

  test("生存 + 同一 version は noop", () => {
    const dir = makeTempDir("hub-lock");
    const lockPath = path.join(dir, "hub.lock");
    const recorder = spawnRecorder();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: readPackageVersion() }));

    ensureHubDaemon({
      lockPath,
      cliPath: "/x/cli.js",
      logPath: path.join(dir, "hub.log"),
      spawnImpl: recorder.spawnImpl,
    });

    expect(recorder.args).toEqual([]);
  });

  test("生存 + 旧 version は SIGTERM 後に respawn", () => {
    const dir = makeTempDir("hub-lock");
    const lockPath = path.join(dir, "hub.lock");
    const recorder = spawnRecorder();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: "old-version" }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    ensureHubDaemon({
      lockPath,
      cliPath: "/x/cli.js",
      logPath: path.join(dir, "hub.log"),
      spawnImpl: recorder.spawnImpl,
    });

    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(recorder.args).toEqual([[process.execPath, "/x/cli.js", "hub"]]);
  });

  test("不在なら detached spawn", () => {
    const dir = makeTempDir("hub-lock");
    const recorder = spawnRecorder();

    ensureHubDaemon({
      lockPath: path.join(dir, "hub.lock"),
      cliPath: "/x/cli.js",
      logPath: path.join(dir, "hub.log"),
      spawnImpl: recorder.spawnImpl,
    });

    expect(recorder.args).toEqual([[process.execPath, "/x/cli.js", "hub"]]);
  });
});

describe("hub socket", () => {
  test("LineWriter→daemon adapter→Hub encode で flat tool/subagent wire を内部表現へ復元する", async () => {
    const payloads: ControlMessage[] = [];
    const writer = controlMessageCallbackWriter((message) => payloads.push(message));
    writer.write({
      type: "tool_activity", v: 1,
      activity: {
        id: "tool-1", name: "Edit", label: "編集", file: "/tmp/A.swift",
        commandTruncated: false, descriptionTruncated: false,
      },
    });
    writer.write({
      type: "subagent_node", v: 2,
      node: {
        nodeId: "agent-1", toolUseId: "tool-use-1", parentNodeId: null,
        agentType: "Explore", label: "調査", depth: 1, status: "running", ts: 123,
      },
    });
    await vi.waitFor(() => expect(payloads).toHaveLength(2));

    const toolEnvelope = JSON.parse(encodeHubMessage({
      type: "conversation_event", session: "work", serverSeq: 1, payload: payloads[0]!,
    })) as { payload: Record<string, unknown> };
    expect(toolEnvelope.payload).toMatchObject({
      type: "tool_activity", id: "tool-1", name: "Edit", label: "編集",
    });
    expect(toolEnvelope.payload).not.toHaveProperty("activity");

    const subagentEnvelope = JSON.parse(encodeHubMessage({
      type: "conversation_event", session: "work", serverSeq: 2, payload: payloads[1]!,
    })) as { payload: Record<string, unknown> };
    expect(subagentEnvelope.payload).toMatchObject({
      type: "subagent_node", nodeId: "agent-1", toolUseId: "tool-use-1", status: "running",
    });
    expect(subagentEnvelope.payload).not.toHaveProperty("node");
  });

  test("書込前の writableLength が閾値超なら遅延 client を切断して監査記録する", () => {
    const write = vi.fn();
    const destroy = vi.fn();
    const log = vi.fn();
    writeHubSocketLine({ writableLength: 11, destroyed: false, write, destroy }, "payload\n", 10, log);

    expect(write).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "audit slow_client_disconnect writableLength=11 threshold=10",
    );
    expect(HUB_SOCKET_WRITABLE_LENGTH_LIMIT).toBe(32 * 1024 * 1024);
  });

  test("pane preview は未送信の履歴 conversation_event を追い越す", async () => {
    const written: string[] = [];
    const socket = {
      writableLength: 0,
      destroyed: false,
      write: (line: string) => { written.push(line); },
      destroy: vi.fn(),
    };
    const write = createPrioritizedHubSocketWriter(socket, 1_000_000, vi.fn(), {
      batchSize: 1,
      flushIntervalMs: 5,
    });
    const history1 = '{"type":"conversation_event","serverSeq":1}\n';
    const history2 = '{"type":"conversation_event","serverSeq":2}\n';
    const preview = '{"type":"conversation_pane_preview","payload":{}}\n';

    write(history1);
    write(history2);
    write(preview);

    expect(written).toEqual([preview]);
    await vi.waitFor(() => expect(written).toEqual([preview, history1, history2]));
    expect(HUB_SOCKET_CONVERSATION_EVENT_BATCH_SIZE).toBe(16);
    expect(HUB_SOCKET_CONVERSATION_EVENT_FLUSH_INTERVAL_MS).toBe(8);
  });

  test("Hub 自身の履歴キューが上限を超えても、client が読めている限り切断しない（10-20 実障害）", async () => {
    const written: string[] = [];
    const destroy = vi.fn();
    const socket = {
      writableLength: 0,
      destroyed: false,
      write: (line: string) => { written.push(line); },
      destroy,
    };
    const log = vi.fn();
    // 上限 1KB に対し、巨大な会話の再生で 1 度に 5KB 分の履歴を積む（client は即座に読む）。
    const write = createPrioritizedHubSocketWriter(socket, 1_024, log, { batchSize: 8, flushIntervalMs: 1 });
    const lines = Array.from({ length: 50 }, (_, index) =>
      `{"type":"conversation_event","serverSeq":${index + 1},"pad":"${"x".repeat(60)}"}\n`);
    for (const line of lines) write(line);

    await vi.waitFor(() => expect(written).toEqual(lines));
    expect(destroy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test("client 側の滞留が高水位以上なら履歴の書き出しを待ち、下がれば再開する", async () => {
    const written: string[] = [];
    const socket = {
      writableLength: 100,
      destroyed: false,
      write: (line: string) => { written.push(line); },
      destroy: vi.fn(),
    };
    const write = createPrioritizedHubSocketWriter(socket, 1_000, vi.fn(), {
      batchSize: 4, flushIntervalMs: 1, flushHighWater: 50,
    });
    const history = '{"type":"conversation_event","serverSeq":1}\n';
    const preview = '{"type":"conversation_pane_preview","payload":{}}\n';
    write(history);
    write(preview);
    // ライブ状態は待たずに直送し、履歴は client が読むまで積まない。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toEqual([preview]);

    socket.writableLength = 0;
    await vi.waitFor(() => expect(written).toEqual([preview, history]));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  test("client 側の滞留が高水位のまま下がらなければ、停滞として切断する", async () => {
    let nowMs = 1_000;
    const socket = {
      writableLength: 100,
      destroyed: false,
      write: vi.fn(),
      destroy: vi.fn(() => { socket.destroyed = true; }),
    };
    const log = vi.fn();
    const write = createPrioritizedHubSocketWriter(socket, 1_000, log, {
      batchSize: 4, flushIntervalMs: 1, flushHighWater: 50, stallTimeoutMs: 30_000, now: () => nowMs,
    });
    write('{"type":"conversation_event","serverSeq":1}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.destroy).not.toHaveBeenCalled();

    nowMs += 30_000;
    await vi.waitFor(() => expect(socket.destroy).toHaveBeenCalledOnce());
    expect(socket.write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "audit slow_client_disconnect writableLength=100 threshold=50 reason=stalled",
    );
  });

  test("束の途中でも client 側の滞留が高水位に達したら、残りは次の tick へ回す", async () => {
    const written: string[] = [];
    const socket = {
      writableLength: 0,
      destroyed: false,
      // client が読まない間は書いた分だけ滞留が増える。
      write: (line: string) => { written.push(line); socket.writableLength += 30; },
      destroy: vi.fn(),
    };
    const write = createPrioritizedHubSocketWriter(socket, 1_000_000, vi.fn(), {
      batchSize: 16, flushIntervalMs: 1, flushHighWater: 50,
    });
    for (let index = 0; index < 5; index += 1) write(`{"type":"conversation_event","serverSeq":${index}}\n`);
    await vi.waitFor(() => expect(written).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toHaveLength(2);
    socket.writableLength = 0; // client が読んだ
    await vi.waitFor(() => expect(written).toHaveLength(4));
    socket.writableLength = 0;
    await vi.waitFor(() => expect(written).toHaveLength(5));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  test("直送でも client 側の滞留が高水位のまま下がらなければ停滞として切断し、下がれば数え直す", () => {
    let nowMs = 0;
    const socket = {
      writableLength: 100,
      destroyed: false,
      write: vi.fn(),
      destroy: vi.fn(() => { socket.destroyed = true; }),
    };
    const write = createPrioritizedHubSocketWriter(socket, 1_000_000, vi.fn(), {
      flushHighWater: 50, stallTimeoutMs: 1_000, now: () => nowMs,
    });
    const preview = '{"type":"conversation_pane_preview","payload":{}}\n';
    write(preview);
    nowMs = 900;
    write(preview);
    socket.writableLength = 0; // 一度読まれた → 停滞の起点を解く
    nowMs = 950;
    write(preview);
    socket.writableLength = 100;
    nowMs = 1_500;
    write(preview);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledTimes(4);
    nowMs = 2_500;
    write(preview);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.write).toHaveBeenCalledTimes(4);
  });

  test("履歴キューの安全上限を超えたら切断する", () => {
    const socket = {
      writableLength: 0,
      destroyed: false,
      write: vi.fn(),
      destroy: vi.fn(() => { socket.destroyed = true; }),
    };
    const log = vi.fn();
    const write = createPrioritizedHubSocketWriter(socket, 1_000_000, log, { queueLimit: 200 });
    const line = `{"type":"conversation_event","pad":"${"x".repeat(40)}"}\n`; // 79 バイト
    write(line);
    write(line);
    expect(socket.destroy).not.toHaveBeenCalled();
    write(line);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      `audit slow_client_disconnect writableLength=${line.length * 2} threshold=200 reason=queue`,
    );
  });

  test("hub_hello に ack を返して clientCount を反映する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-${Date.now()}`);
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-heartbeat"),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1800,
    });
    const log = vi.fn();
    const server = await startHubSocket({ hub, socketPath, version: "1.2.3", bootId: "boot-test", log });
    expect(server).not.toBeNull();

    const client = await connectUnixClient(socketPath);
    const reader = new SocketLineReader(client);
    expect(hub.clientCount).toBe(1);
    expect(log).toHaveBeenCalledWith("audit client_connect clients=1");
    writeLine(client, JSON.stringify({ type: "hub_hello" }));
    expect(JSON.parse(await reader.nextLine())).toEqual({
      type: "hub_hello_ack", version: "1.2.3", bootId: "boot-test", processingSessions: [], pendingQuestions: [],
      resumeHint: true,
    });

    client.destroy();
    await server?.close();
    expect(hub.clientCount).toBe(0);
    // client_disconnect 監査行は socket の close イベント（非同期）で出る。
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("audit client_disconnect clients=0"));
  });

  test("hub_hello の ack に未回答の設問の snapshot を載せる（pending-question-snapshot）", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-q-${Date.now()}`);
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-q-heartbeat"),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1800,
    });
    const questions = [{ header: "選択", question: "どっち?", multiSelect: false, options: [{ label: "A", description: "" }] }];
    hub.handleRelayMessage({ type: "question_event", session: "waiting", event: "prompt", id: "toolu_wait", questions });
    hub.handleRelayMessage({ type: "question_event", session: "answered", event: "prompt", id: "toolu_done", questions });
    hub.handleRelayMessage({ type: "question_event", session: "answered", event: "dismiss", id: "toolu_done" });
    const server = await startHubSocket({ hub, socketPath, version: "1.2.3", bootId: "boot-q" });
    expect(server).not.toBeNull();
    const client = await connectUnixClient(socketPath);
    const reader = new SocketLineReader(client);
    writeLine(client, JSON.stringify({ type: "hub_hello" }));
    expect(JSON.parse(await reader.nextLine())).toMatchObject({
      type: "hub_hello_ack",
      pendingQuestions: [{ session: "waiting", id: "toolu_wait", questions }],
    });
    client.destroy();
    await server?.close();
  });

  test("生存中の Hub socket への二重 listen を拒否する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-double-${Date.now()}`);
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-heartbeat"),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1800,
    });
    const server = await startHubSocket({ hub, socketPath, version: null });
    expect(await startHubSocket({ hub, socketPath, version: null })).toBeNull();
    await server?.close();
  });

  test("relay socket のイベントを Hub 経由で複数 engine 接続へ fan-out する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-fanout-${Date.now()}`);
    const relayPath = tempSocketPath(`hub-relay-${Date.now()}`);
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-heartbeat"), metadataStore: makeTempStore(), timeoutSeconds: 1800,
    });
    const server = await startHubSocket({ hub, socketPath, version: "1.2.3" });
    const relay = await startEngineRelaySocket({
      socketPath: relayPath,
      onMessage: (message) => hub.handleRelayMessage(message),
    });
    expect(server).not.toBeNull();
    expect(relay).not.toBeNull();
    const clients = await Promise.all([connectUnixClient(socketPath), connectUnixClient(socketPath)]);
    const readers = clients.map((client) => new SocketLineReader(client));
    await sendQuestionEventToEngine({
      type: "question_event", session: "work", event: "prompt", id: "q1",
      questions: [{ header: "確認", question: "続ける?", options: [], multiSelect: false }],
    }, relayPath, 1_000);
    const messages = await Promise.all(readers.map(async (reader) => JSON.parse(await reader.nextLine())));
    expect(messages[0]).toEqual(messages[1]);
    expect(messages[0]).toMatchObject({ type: "question_event", session: "work", id: "q1" });
    for (const client of clients) client.destroy();
    await relay?.close();
    await server?.close();
  });
});
