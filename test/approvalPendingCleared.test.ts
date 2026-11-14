// approvalPendingCleared.test.ts — 承認の待ちが終わるすべての出口で remote_pending_cleared を出す（push v1.1 §6 の片付け）
//
// iPhone は「通知から答えたが反映を確認できなかった」承認のカードを、この知らせ（kind=approval・同じ id）で片付ける。
// 許可・拒否・時間切れ・つなぎ直しの期限切れのどの出口でも、一覧へ知らせた承認なら必ず出す。知らせていなければ出さない。
// 送信は最善努力で、失敗しても hook の結果を変えない。

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { runHookCore } from "../src/approval/hook.js";
import { requestApiAgentApproval } from "../src/apiAgent/approvalBridge.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import type { RemotePendingMessage } from "../src/hub/engineRelaySocket.js";
import {
  SocketLineReader, canListenUnixSocket, startListener, tempSocketPath, writeLine, type FakeListener,
} from "./socketHelpers.js";

function bashPreToolUse(command: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/work", session_id: "s1", ...extra,
  }));
}

function decision(id: string, value: "allow" | "deny"): string {
  return JSON.stringify({ type: "approval_decision", v: 1, id, decision: value });
}

function parseDecision(stdout: string): { decision: string; reason: string } {
  const output = (JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  }).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: output.permissionDecisionReason };
}

/** engine relay の代わり: 届いた remote_pending / remote_pending_cleared をすべて記録する（接続ごとに 1 行）。 */
interface RelayRecorder {
  messages: ControlMessage[];
  close(): Promise<void>;
}

async function startRelayRecorder(socketPath: string): Promise<RelayRecorder> {
  const messages: ControlMessage[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const message = decodeControlMessage(line);
          if (message.type === "remote_pending" || message.type === "remote_pending_cleared") messages.push(message);
        } catch { /* session_processing など、ここで見ない行。 */ }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    messages,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function clearedIds(messages: ControlMessage[]): string[] {
  return messages.flatMap((m) => (m.type === "remote_pending_cleared" ? [m.id] : []));
}

function pendingIds(messages: ControlMessage[]): string[] {
  return messages.flatMap((m) => (m.type === "remote_pending" ? [m.id] : []));
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(): Promise<{ socketPath: string; relayPath: string; relay: RelayRecorder }> {
  const socketPath = tempSocketPath(`rpc-${randomUUID().slice(0, 6)}`);
  const relayPath = tempSocketPath(`rpr-${randomUUID().slice(0, 6)}`);
  fs.rmSync(socketPath, { force: true });
  fs.rmSync(relayPath, { force: true });
  const relay = await startRelayRecorder(relayPath);
  closers.push(() => relay.close());
  return { socketPath, relayPath, relay };
}

async function listen(socketPath: string): Promise<FakeListener> {
  const listener = await startListener(socketPath);
  closers.push(() => listener.close());
  return listener;
}

describe("hook: 一覧へ知らせた承認は、待ちが終わるどの出口でも remote_pending_cleared を出す", () => {
  it("つなぎ直しの期限切れ（一度も再接続できない）でも、出した remote_pending と同じ id で片付ける", async () => {
    if (!(await canListenUnixSocket())) return;
    const { socketPath, relayPath, relay } = await setup();
    const result = await runHookCore({
      stdinData: bashPreToolUse("echo never"), socketPath, deadlineSeconds: 0.4, session: "sess-x",
      engineRelaySocketPath: relayPath, retryConnectIntervalSeconds: 0.05,
    });
    const parsed = parseDecision(result.stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("no reconnect within");
    const pending = pendingIds(relay.messages);
    expect(pending).toHaveLength(1);
    await vi.waitFor(() => expect(clearedIds(relay.messages)).toEqual(pending));
    expect(relay.messages.at(-1)).toEqual({
      type: "remote_pending_cleared", v: 1, id: pending[0], session: "sess-x", kind: "approval",
    });
  });

  for (const value of ["allow", "deny"] as const) {
    it(`再接続して送り直した承認の ${value} で片付ける（1 回だけ）`, async () => {
      if (!(await canListenUnixSocket())) return;
      const { socketPath, relayPath, relay } = await setup();
      const hook = runHookCore({
        stdinData: bashPreToolUse(`echo ${value}`), socketPath, deadlineSeconds: 5, session: "sess-x",
        engineRelaySocketPath: relayPath, retryConnectIntervalSeconds: 0.05,
      });
      await vi.waitFor(() => expect(pendingIds(relay.messages)).toHaveLength(1));
      const listener = await listen(socketPath);
      const socket = await listener.nextConnection();
      const request = decodeControlMessage(await new SocketLineReader(socket).nextLine());
      if (request.type !== "approval_request") throw new Error("unreachable");
      expect(request.id).toBe(pendingIds(relay.messages)[0]);
      writeLine(socket, decision(request.id, value));
      const result = await hook;
      expect(parseDecision(result.stdout).decision).toBe(value);
      await vi.waitFor(() => expect(clearedIds(relay.messages)).toEqual([request.id]));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(clearedIds(relay.messages)).toEqual([request.id]);
    });
  }

  it("再接続して送り直した承認が時間切れになっても片付ける", async () => {
    if (!(await canListenUnixSocket())) return;
    const { socketPath, relayPath, relay } = await setup();
    const hook = runHookCore({
      stdinData: bashPreToolUse("echo slow"), socketPath, deadlineSeconds: 0.8, session: "sess-x",
      engineRelaySocketPath: relayPath, retryConnectIntervalSeconds: 0.05,
    });
    await vi.waitFor(() => expect(pendingIds(relay.messages)).toHaveLength(1));
    const listener = await listen(socketPath);
    const socket = await listener.nextConnection();
    const request = decodeControlMessage(await new SocketLineReader(socket).nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    const result = await hook;
    const parsed = parseDecision(result.stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("No response within");
    await vi.waitFor(() => expect(clearedIds(relay.messages)).toEqual([request.id]));
  });

  it("決定待ち中に切れて保留へ回り、つなぎ直せないまま期限が来ても片付ける", async () => {
    if (!(await canListenUnixSocket())) return;
    const { socketPath, relayPath, relay } = await setup();
    const listener = await listen(socketPath);
    const hook = runHookCore({
      stdinData: bashPreToolUse("echo drop"), socketPath, deadlineSeconds: 0.8, session: "sess-x",
      engineRelaySocketPath: relayPath, retryConnectIntervalSeconds: 0.05,
    });
    const socket = await listener.nextConnection();
    const request = decodeControlMessage(await new SocketLineReader(socket).nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    // アプリが会話を離れた（承認チャネルが閉じた）。以後は誰も listen しない。
    await listener.close();
    fs.rmSync(socketPath, { force: true });
    const result = await hook;
    expect(parseDecision(result.stdout).reason).toContain("no reconnect within");
    expect(pendingIds(relay.messages)).toEqual([request.id]);
    await vi.waitFor(() => expect(clearedIds(relay.messages)).toEqual([request.id]));
  });

  it("アプリに直接届けた承認は従来どおり決着時に片付けの知らせを出す（remote_pending は出さない）", async () => {
    if (!(await canListenUnixSocket())) return;
    const { socketPath, relayPath, relay } = await setup();
    const listener = await listen(socketPath);
    const hook = runHookCore({
      stdinData: bashPreToolUse("echo direct"), socketPath, deadlineSeconds: 5, session: "sess-x",
      engineRelaySocketPath: relayPath,
    });
    const socket = await listener.nextConnection();
    const request = decodeControlMessage(await new SocketLineReader(socket).nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    writeLine(socket, decision(request.id, "allow"));
    expect(parseDecision((await hook).stdout).decision).toBe("allow");
    expect(pendingIds(relay.messages)).toEqual([]);
    await vi.waitFor(() => expect(clearedIds(relay.messages)).toEqual([request.id]));
  });

  it("アプリへ知らせる前に終わった承認（socket パス無し・auto の自動許可）は何も出さない", async () => {
    if (!(await canListenUnixSocket())) return;
    const { relayPath, relay } = await setup();
    const noSocket = await runHookCore({
      stdinData: bashPreToolUse("echo nosock"), socketPath: null, deadlineSeconds: 1, session: "sess-x",
      engineRelaySocketPath: relayPath,
    });
    expect(parseDecision(noSocket.stdout).decision).toBe("deny");
    const auto = await runHookCore({
      stdinData: bashPreToolUse("echo auto", { permission_mode: "auto" }), socketPath: tempSocketPath("rpc-unused"),
      deadlineSeconds: 1, session: "sess-x", engineRelaySocketPath: relayPath,
    });
    expect(parseDecision(auto.stdout).decision).toBe("allow");
    // 届いていれば届いている頃まで待ってから、何も無いことを確かめる。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.messages).toEqual([]);
  });

  it("片付けの送信に失敗しても（engine relay が居ない）hook の結果は変わらず、遅れもしない", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`rpc-${randomUUID().slice(0, 6)}`);
    fs.rmSync(socketPath, { force: true });
    const missingRelay = tempSocketPath(`rpr-missing-${randomUUID().slice(0, 6)}`);
    fs.rmSync(missingRelay, { force: true });
    const hook = runHookCore({
      stdinData: bashPreToolUse("echo norelay"), socketPath, deadlineSeconds: 5, session: "sess-x",
      engineRelaySocketPath: missingRelay, retryConnectIntervalSeconds: 0.05,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const listener = await listen(socketPath);
    const socket = await listener.nextConnection();
    const request = decodeControlMessage(await new SocketLineReader(socket).nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    const decidedAt = Date.now();
    writeLine(socket, decision(request.id, "allow"));
    const result = await hook;
    expect(parseDecision(result.stdout).decision).toBe("allow");
    // 片付けの送信は engine relay の短い上限（250ms）で打ち切られる。
    expect(Date.now() - decidedAt).toBeLessThan(2_000);
  });
});

/** serve の代わり: approval_request を受けたら決定を返す（API 作業の承認チャネル）。 */
async function directServe(socketPath: string, value: "allow" | "deny"): Promise<void> {
  const listener = await listen(socketPath);
  void (async () => {
    const socket = await listener.nextConnection();
    const request = decodeControlMessage(await new SocketLineReader(socket).nextLine());
    if (request.type === "approval_request") writeLine(socket, decision(request.id, value));
  })().catch(() => {});
}

describe("API 作業: アプリへ知らせた承認は、待ちが終わるどの出口でも片付ける", () => {
  for (const value of ["allow", "deny"] as const) {
    it(`直接届けた承認（remote_pending は出さない）でも、${value} で決着したら片付けの知らせを出す`, async () => {
      if (!(await canListenUnixSocket())) return;
      const socketPath = tempSocketPath(`aad-${randomUUID().slice(0, 6)}`);
      fs.rmSync(socketPath, { force: true });
      await directServe(socketPath, value);
      const published: RemotePendingMessage[] = [];
      const decided = await requestApiAgentApproval(
        { id: `d-${value}`, session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
        { socketPathFor: () => socketPath, publishPending: (m) => published.push(m) },
      );
      expect(decided).toBe(value);
      expect(published).toEqual([{ type: "remote_pending_cleared", v: 1, id: `d-${value}`, session: "cs-a", kind: "approval" }]);
    });
  }

  it("直接届けた承認で片付けの送信が例外を投げても、決定はそのまま・すぐに返す", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`aad-${randomUUID().slice(0, 6)}`);
    fs.rmSync(socketPath, { force: true });
    await directServe(socketPath, "allow");
    const published: RemotePendingMessage[] = [];
    const startedAt = Date.now();
    const decided = await requestApiAgentApproval(
      { id: "d-throw", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
      { socketPathFor: () => socketPath, publishPending: (m) => { published.push(m); throw new Error("hub down"); } },
    );
    expect(decided).toBe("allow");
    expect(published.map((m) => m.type)).toEqual(["remote_pending_cleared"]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("接続できず、要求を書く前に期限が来た承認は remote_pending と片付けだけ（直接は届けていない）", async () => {
    let clock = 0;
    const published: RemotePendingMessage[] = [];
    const decided = await requestApiAgentApproval(
      { id: "d-none", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
      {
        socketPathFor: () => tempSocketPath("aa-none"), retryIntervalMs: 5, connectTimeoutMs: 5, deadlineMs: 100,
        now: () => (clock += 30), publishPending: (m) => published.push(m),
      },
    );
    expect(decided).toBe("deny");
    expect(published.map((m) => m.type)).toEqual(["remote_pending", "remote_pending_cleared"]);
  });

  it("中止済みのターンの承認（接続も書き込みもしない）は何も出さない", async () => {
    const controller = new AbortController();
    controller.abort();
    const published: RemotePendingMessage[] = [];
    const decided = await requestApiAgentApproval(
      { id: "d-abort", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w", signal: controller.signal },
      { socketPathFor: () => tempSocketPath("aa-none"), publishPending: (m) => published.push(m) },
    );
    expect(decided).toBe("deny");
    expect(published).toEqual([]);
  });

  it("片付けの送信が例外を投げても、決定はそのまま返す", async () => {
    let clock = 0;
    const published: RemotePendingMessage[] = [];
    const decided = await requestApiAgentApproval(
      { id: "b1", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
      {
        socketPathFor: () => tempSocketPath("aa-none"), retryIntervalMs: 5, connectTimeoutMs: 5, deadlineMs: 100,
        now: () => (clock += 30),
        publishPending: (m) => {
          published.push(m);
          if (m.type === "remote_pending_cleared") throw new Error("relay down");
        },
      },
    );
    expect(decided).toBe("deny");
    expect(published.map((m) => m.type)).toEqual(["remote_pending", "remote_pending_cleared"]);
  });

  it("待ちの途中で例外が起きても、出していた一覧の待ちを片付けてから例外を伝える", async () => {
    let calls = 0;
    const published: RemotePendingMessage[] = [];
    const run = requestApiAgentApproval(
      { id: "b2", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
      {
        socketPathFor: () => tempSocketPath("aa-none"), retryIntervalMs: 5, connectTimeoutMs: 5,
        now: () => {
          calls += 1;
          // 1 周目（deadline の計算・最初の確認）は通し、保留へ入った後の確認で壊れる。
          if (calls > 3) throw new Error("clock broken");
          return 0;
        },
        publishPending: (m) => published.push(m),
      },
    );
    await expect(run).rejects.toThrow("clock broken");
    expect(published.map((m) => m.type)).toEqual(["remote_pending", "remote_pending_cleared"]);
    expect(published.at(-1)).toEqual({ type: "remote_pending_cleared", v: 1, id: "b2", session: "cs-a", kind: "approval" });
  });
});
