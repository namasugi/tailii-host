// hubRecovery.integration.test.ts — 実 Unix socket を通す Session Hub 復旧シナリオ

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { connectHubSocket, type HubLink } from "../src/hubClient.js";
import type { HubServerMessage } from "../src/hubProtocol.js";
import { startHubSocket, type HubSocketServer } from "../src/hubDaemon.js";
import { readHeartbeat, writeHeartbeat } from "../src/heartbeat.js";
import type { ControlMessage } from "../src/protocol.js";
import { SessionHub, type HubTail } from "../src/sessionHub.js";
import { makeTempDir, makeTempStore, MockTmuxRunner, ok } from "./helpers.js";
import { canListenUnixSocket, tempSocketPath } from "./socketHelpers.js";

interface TranscriptRow {
  atMs: number;
  payload: ControlMessage;
}

const output = (streamId: string, text = streamId): ControlMessage => ({
  type: "chat_output",
  v: 1,
  streamId,
  role: "assistant",
  text,
  eof: true,
});

/** open 時点の JSONL transcript を newerThanMs で絞る、復旧試験用の有限 fake tail。 */
function transcriptTailFactory(transcriptPath: string):
  (write: (payload: ControlMessage) => void) => HubTail {
  return (write) => ({
    open(_cwd, _preferredSessionId, newerThanMs) {
      const rows = fs.readFileSync(transcriptPath, "utf8").trim().split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TranscriptRow);
      for (const row of rows) {
        if (newerThanMs === null || newerThanMs === undefined || row.atMs > newerThanMs) {
          write(row.payload);
        }
      }
    },
    stop() {},
  });
}

async function closeRecoveryFixture(
  link: HubLink | null,
  server: HubSocketServer | null,
  ...hubs: SessionHub[]
): Promise<void> {
  link?.close();
  await server?.close();
  for (const hub of hubs) hub.close();
}

describe("Session Hub 復旧シナリオ (Unix socket)", () => {
  test("不正helloで沈黙した接続をtimeout破棄し、有効helloへ再接続する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-invalid-hello-${Date.now()}`);
    let connectionCount = 0;
    const server = net.createServer((socket) => {
      connectionCount += 1;
      const ordinal = connectionCount;
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write(JSON.stringify(ordinal === 1
          ? { type: "hub_hello_ack", version: "test", bootId: "" }
          : { type: "hub_hello_ack", version: "test", bootId: "valid-boot", processingSessions: [] }) + "\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {}, helloTimeoutMs: 50 });
    const reconnected = vi.fn();
    link.onReconnect = reconnected;
    try {
      await vi.waitFor(() => expect(reconnected).toHaveBeenCalledWith({
        bootId: "valid-boot", disconnectedAtMs: expect.any(Number), processingSessions: [],
      }), { timeout: 2_000 });
      expect(connectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      link.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(socketPath, { force: true });
    }
  });

  test("未接続中は状態通知だけを合流し、期限切れになる相関 RPC を遅延実行しない", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-offline-queue-${Date.now()}`);
    const chatInjector = vi.fn(async () => {});
    const startTurn = vi.fn(async () => "turn");
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-offline-queue-heartbeat"),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1_800,
      chatInjector,
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: () => ({ startTurn, closeSession: vi.fn(), close: vi.fn() }),
    });
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {} });
    link.send({ type: "chat_send", id: "chat", session: "work",
      clientMessageId: "client-chat", text: "must not run later" });
    link.send({ type: "codex_turn_submit", id: "codex", session: "work",
      clientUserMessageId: "client-codex", text: "must not run later", effort: null, sandbox: null,
      threadId: "thread", cwd: "/tmp/work" });
    link.send({ type: "session_processing", session: "work", state: "active" });
    link.send({ type: "session_processing", session: "work", state: "done" });
    for (let index = 0; index < 140; index += 1) {
      link.send({ type: "session_processing", session: `bounded-${index}`, state: "active" });
    }

    let server: HubSocketServer | null = null;
    try {
      server = await startHubSocket({ hub, socketPath, version: "test", bootId: "boot-offline" });
      expect(server).not.toBeNull();
      const reconnected = vi.fn();
      link.onReconnect = reconnected;
      await vi.waitFor(() => expect(reconnected).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(hub.processingSessionNames).toHaveLength(128));
      expect(hub.processingSessionNames).not.toContain("bounded-0");
      expect(hub.processingSessionNames).toContain("bounded-139");
      expect(chatInjector).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
    } finally {
      await closeRecoveryFixture(link, server, hub);
    }
  });

  test("offline session_retire はhello snapshotからも除外しactorを再購読させない", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-offline-retire-${Date.now()}`);
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-offline-retire-heartbeat"),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1_800,
    });
    hub.handleRelayMessage({ type: "session_processing", session: "doomed", state: "active" });
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {} });
    link.send({ type: "session_retire", session: "doomed" });

    let server: HubSocketServer | null = null;
    const reconnected = vi.fn();
    link.onReconnect = reconnected;
    try {
      server = await startHubSocket({ hub, socketPath, version: "test", bootId: "boot-retire" });
      expect(server).not.toBeNull();
      await vi.waitFor(() => expect(reconnected).toHaveBeenCalledWith({
        bootId: "boot-retire", disconnectedAtMs: null, processingSessions: [],
      }));
      await vi.waitFor(() => expect(hub.actors.has("doomed")).toBe(false));
    } finally {
      await closeRecoveryFixture(link, server, hub);
    }
  });

  test("hello 完了が先着しても onReconnect 登録時に snapshot を一度だけ配送する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-late-reconnect-handler-${Date.now()}`);
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-late-reconnect-handler-heartbeat"),
      timeoutSeconds: 1_800,
    });
    hub.handleRelayMessage({
      type: "session_processing",
      session: "already-running",
      state: "active",
    });
    const server = await startHubSocket({
      hub,
      socketPath,
      version: "test",
      bootId: "boot-before-handler",
    });
    expect(server).not.toBeNull();
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {} });
    let helloSeen = false;
    link.onMessage = (message) => {
      if (message.type === "hub_hello_ack") helloSeen = true;
    };

    try {
      // onReconnect は意図的に未設定のまま hello ack の処理完了を先行させる。
      await vi.waitFor(() => expect(helloSeen).toBe(true));

      const delayedHandler = vi.fn();
      link.onReconnect = delayedHandler;
      expect(delayedHandler).toHaveBeenCalledTimes(1);
      expect(delayedHandler).toHaveBeenCalledWith({
        bootId: "boot-before-handler",
        disconnectedAtMs: null,
        processingSessions: ["already-running"],
      });

      // 保持情報は最初の handler へ渡した時点で消費し、再代入では再配送しない。
      const replacementHandler = vi.fn();
      link.onReconnect = replacementHandler;
      expect(replacementHandler).not.toHaveBeenCalled();
    } finally {
      await closeRecoveryFixture(link, server, hub);
    }
  });

  test("hub crash 後は世代変更境界から無重複復帰し pendingQuestion も復元する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-recovery-${Date.now()}`);
    const heartbeatDir = makeTempDir("hub-recovery-heartbeat");
    const metadataStore = makeTempStore();
    const pendingQuestionsPath = path.join(makeTempDir("hub-recovery-pending"), "pending.json");
    const transcriptPath = path.join(makeTempDir("hub-recovery-transcript"), "conversation.jsonl");
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 1,
      agent: "claude", providerSessionId: "claude-conversation" });
    const initialRows: TranscriptRow[] = [
      { atMs: 1, payload: output("old-1") },
      { atMs: 2, payload: output("old-2") },
      { atMs: 3, payload: output("old-3") },
    ];
    fs.writeFileSync(transcriptPath, initialRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const makeHub = () => new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir,
      metadataStore,
      timeoutSeconds: 1800,
      now: () => 100,
      pendingQuestionsPath,
      tailFactory: transcriptTailFactory(transcriptPath),
    });
    const first = makeHub();
    let second: SessionHub | null = null;
    let server = await startHubSocket({ hub: first, socketPath, version: "test", bootId: "boot-a" });
    expect(server).not.toBeNull();
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {} });
    const received: HubServerMessage[] = [];
    let currentBootId: string | null = null;
    let lastServerSeq = 0;
    link.onMessage = (message) => {
      received.push(message);
      if (message.type === "conversation_event") lastServerSeq = message.serverSeq;
    };
    link.onReconnect = ({ bootId, disconnectedAtMs }) => {
      const restarted = currentBootId !== null && currentBootId !== bootId;
      currentBootId = bootId;
      link.send({
        type: "conversation_subscribe",
        session: "work",
        ...(restarted && disconnectedAtMs !== null
          ? { newerThanMs: disconnectedAtMs }
          : lastServerSeq > 0 ? { afterSeq: lastServerSeq } : {}),
      });
    };

    try {
      await vi.waitFor(() => expect(
        received.filter((message) => message.type === "conversation_event"),
      ).toHaveLength(3));
      first.handleRelayMessage({
        type: "question_event",
        session: "work",
        event: "prompt",
        id: "question-before-crash",
        questions: [{ header: "確認", question: "続けますか?", options: [], multiSelect: false }],
      });

      await server?.close();
      server = null;
      first.close();
      const appendedAtMs = Date.now() + 1_000;
      const appendedRows: TranscriptRow[] = [
        { atMs: appendedAtMs, payload: output("new-1") },
        { atMs: appendedAtMs + 1, payload: output("new-2") },
      ];
      fs.appendFileSync(transcriptPath,
        appendedRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      second = makeHub();
      second.restorePendingQuestions();
      server = await startHubSocket({ hub: second, socketPath, version: "test", bootId: "boot-b" });
      expect(server).not.toBeNull();

      await vi.waitFor(() => expect(currentBootId).toBe("boot-b"), { timeout: 3_000 });
      await vi.waitFor(() => expect(
        received.filter((message) => message.type === "conversation_event"),
      ).toHaveLength(5));
      const streamIds = received.flatMap((message) =>
        message.type === "conversation_event" && message.payload.type === "chat_output"
          ? [message.payload.streamId]
          : []);
      expect(streamIds).toEqual(["old-1", "old-2", "old-3", "new-1", "new-2"]);

      link.send({ type: "hub_state_request", id: "state-after-restart", session: "work" });
      await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
        type: "hub_state_response",
        id: "state-after-restart",
        session: "work",
        pendingQuestion: expect.objectContaining({ id: "question-before-crash" }),
      })));
    } finally {
      await closeRecoveryFixture(link, server, first, ...(second === null ? [] : [second]));
    }
  });

  test("遅延 client 切断後は同一 bootId の afterSeq replay で欠落なく復帰する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-slow-recovery-${Date.now()}`);
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "work", cwd: "/tmp/work", createdAt: 1,
      agent: "claude", providerSessionId: "claude-conversation" });
    let publish: ((payload: ControlMessage) => void) | null = null;
    const publishPayload = (payload: ControlMessage): void => {
      const writer = publish;
      if (writer === null) throw new Error("共有 tail が開始されていない");
      writer(payload);
    };
    const hub = new SessionHub({
      runner: new MockTmuxRunner(() => ok("")).runner,
      heartbeatDir: makeTempDir("hub-slow-recovery-heartbeat"),
      metadataStore,
      timeoutSeconds: 1800,
      now: () => 100,
      replayLimit: 20,
      tailFactory: (write) => {
        publish = write;
        return { open() {}, stop() {} };
      },
    });
    // socket client が切れても共有 tail と replay buffer を維持する購読者。
    const keeper = {};
    hub.registerClient(keeper, () => {});
    hub.handleClientMessage(keeper, JSON.stringify({ type: "conversation_subscribe", session: "work" }));
    const audit: string[] = [];
    let server = await startHubSocket({
      hub,
      socketPath,
      version: "test",
      bootId: "same-boot",
      writableLengthLimit: 1_024,
      log: (message) => audit.push(message),
    });
    expect(server).not.toBeNull();
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {} });
    const receivedSeqs: number[] = [];
    let reconnectCount = 0;
    let lastServerSeq = 0;
    link.onMessage = (message) => {
      if (message.type !== "conversation_event") return;
      receivedSeqs.push(message.serverSeq);
      lastServerSeq = message.serverSeq;
    };
    link.onReconnect = ({ bootId }) => {
      expect(bootId).toBe("same-boot");
      reconnectCount += 1;
      // afterSeq を常に付けて replay 経路に固定する。afterSeq 無しの 2 人目購読は backfill に
      // 入り、この fake tailFactory では publish が backfill tail へ奪われてしまう。
      link.send({ type: "conversation_subscribe", session: "work", afterSeq: lastServerSeq });
    };

    try {
      await vi.waitFor(() => expect(reconnectCount).toBe(1));
      publishPayload(output("before-pressure"));
      await vi.waitFor(() => expect(receivedSeqs).toEqual([1]));

      // 1 行目を kernel buffer に滞留させ、次の書込前検査で socket を切断させる。
      publishPayload(output("pressure", "x".repeat(8 * 1024 * 1024)));
      publishPayload(output("missed-3"));
      publishPayload(output("missed-4"));
      publishPayload(output("missed-5"));

      await vi.waitFor(() => expect(audit.some((line) => line.includes("slow_client_disconnect"))).toBe(true),
        { timeout: 3_000 });
      // 切断そのものを確認した後は、同じ Hub 世代を通常閾値で再 listen して replay を完走させる。
      // 巨大な先頭 replay 行が低閾値に再度掛かり続ける、テスト固有の循環を避けるため。
      await server?.close();
      server = await startHubSocket({
        hub,
        socketPath,
        version: "test",
        bootId: "same-boot",
        writableLengthLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(server).not.toBeNull();
      await vi.waitFor(() => expect(reconnectCount).toBeGreaterThan(1), { timeout: 5_000 });
      await vi.waitFor(() => expect([...new Set(receivedSeqs)].sort((a, b) => a - b))
        .toEqual([1, 2, 3, 4, 5]), { timeout: 8_000 });
      expect(receivedSeqs).toEqual([1, 2, 3, 4, 5]);
    } finally {
      hub.unregisterClient(keeper);
      await closeRecoveryFixture(link, server, hub);
    }
  }, 12_000);

  test("hub 再起動後は codex の active 会話を processing として復元せず tick でも bump しない", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`hub-codex-recovery-${Date.now()}`);
    const heartbeatDir = makeTempDir("hub-codex-recovery-heartbeat");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "s-codex", cwd: "/tmp/codex", createdAt: 1,
      agent: "codex", providerSessionId: "thread-1" });
    writeHeartbeat(heartbeatDir, "s-codex", { ts: 100, state: "active", event: "turn" });
    const hub = new SessionHub({
      runner: new MockTmuxRunner((args) => args[0] === "ls" ? ok("s-codex\n") : ok("")).runner,
      heartbeatDir,
      metadataStore,
      timeoutSeconds: 1800,
      now: () => 200,
    });
    hub.restoreFromHeartbeats();
    const server = await startHubSocket({ hub, socketPath, version: "test", bootId: "boot-after-crash" });
    expect(server).not.toBeNull();
    const link = connectHubSocket({ socketPath, ensureDaemon: () => {} });
    const received: HubServerMessage[] = [];
    link.onMessage = (message) => received.push(message);
    link.onReconnect = () => {
      link.send({ type: "hub_state_request", id: "codex-state", session: "s-codex" });
    };

    try {
      await vi.waitFor(() => expect(received).toContainEqual({
        type: "hub_state_response",
        id: "codex-state",
        session: "s-codex",
        pendingQuestion: null,
        processing: false,
      }));
      await hub.tick();
      expect(readHeartbeat(heartbeatDir, "s-codex")).toEqual({
        ts: 100,
        state: "active",
        event: "turn",
      });
    } finally {
      await closeRecoveryFixture(link, server, hub);
    }
  });
});
