// hubDaemon.test.ts — Session Hub daemon の lock / ensure / socket 骨格テスト

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireHubLock,
  controlMessageCallbackWriter,
  ensureHubDaemon,
  HUB_SOCKET_WRITABLE_LENGTH_LIMIT,
  pidAlive,
  readHubLock,
  startHubSocket,
  writeHubSocketLine,
} from "../src/hubDaemon.js";
import { encodeHubMessage } from "../src/hubProtocol.js";
import type { ControlMessage } from "../src/protocol.js";
import { SessionHub } from "../src/sessionHub.js";
import { sendQuestionEventToEngine, startEngineRelaySocket } from "../src/engineRelaySocket.js";
import { readPackageVersion } from "../src/version.js";
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

describe("hub lock / ensure", () => {
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
    expect(HUB_SOCKET_WRITABLE_LENGTH_LIMIT).toBe(4 * 1024 * 1024);
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
      type: "hub_hello_ack", version: "1.2.3", bootId: "boot-test", processingSessions: [],
    });

    client.destroy();
    await server?.close();
    expect(hub.clientCount).toBe(0);
    // client_disconnect 監査行は socket の close イベント（非同期）で出る。
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("audit client_disconnect clients=0"));
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
