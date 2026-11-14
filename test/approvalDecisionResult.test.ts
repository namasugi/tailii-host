// approvalDecisionResult.test.ts — 決定の反映結果（approval_decision_result, push v1.1 §6）を承認チャネルへ返す

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { runHookCore } from "../src/approval/hook.js";
import { requestApiAgentApproval } from "../src/apiAgent/approvalBridge.js";
import { decodeControlMessage } from "../src/protocol.js";
import {
  SocketLineReader, canListenUnixSocket, startBroker, startListener, tempSocketPath, writeLine, type FakeListener,
} from "./socketHelpers.js";

function bashPreToolUse(command: string): Buffer {
  return Buffer.from(JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/work", session_id: "s1",
  }));
}

function decision(id: string, value: "allow" | "deny"): string {
  return JSON.stringify({ type: "approval_decision", v: 1, id, decision: value });
}

function parseDecision(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

const listeners: FakeListener[] = [];
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close();
});

describe("hook: approval_decision_result", () => {
  it("自分の id の決定で applied を返して確定する。別の id の決定には返さず待ち続ける", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`adr-${randomUUID().slice(0, 6)}`);
    const listener = await startListener(socketPath);
    listeners.push(listener);
    const hook = runHookCore({ stdinData: bashPreToolUse("ls"), socketPath, deadlineSeconds: 5, engineRelaySocketPath: null });
    const socket = await listener.nextConnection();
    const reader = new SocketLineReader(socket);
    const request = decodeControlMessage(await reader.nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    // 同じ会話で別の承認を待つ hook 宛ての決定（serve は全 hook へ配る）。返信せず、自分の決定を待ち続ける。
    writeLine(socket, decision("someone-else", "deny"));
    await expect(reader.nextLine(200)).rejects.toThrow();
    writeLine(socket, decision(request.id, "allow"));
    expect(JSON.parse(await reader.nextLine())).toEqual({ type: "approval_decision_result", v: 1, id: request.id, status: "applied" });
    const result = await hook;
    expect(parseDecision(result.stdout)).toBe("allow");
  });

  it("返信を書く前に相手が閉じても（書き込みの失敗）、決定はそのまま反映する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`adr-${randomUUID().slice(0, 6)}`);
    const listener = await startListener(socketPath);
    listeners.push(listener);
    const hook = runHookCore({ stdinData: bashPreToolUse("rm x"), socketPath, deadlineSeconds: 5, engineRelaySocketPath: null });
    const socket = await listener.nextConnection();
    const reader = new SocketLineReader(socket);
    const request = decodeControlMessage(await reader.nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    socket.end(decision(request.id, "deny") + "\n");
    socket.destroy();
    const result = await hook;
    expect(parseDecision(result.stdout)).toBe("deny");
  });

  it("つなぎ直しの経路（接続できなかった後に再接続して送り直した承認）でも applied を返す", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`adr-${randomUUID().slice(0, 6)}`);
    fs.rmSync(socketPath, { force: true });
    const hook = runHookCore({
      stdinData: bashPreToolUse("echo late"), socketPath, deadlineSeconds: 5, engineRelaySocketPath: null,
      retryConnectIntervalSeconds: 0.05,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const listener = await startListener(socketPath);
    listeners.push(listener);
    const socket = await listener.nextConnection();
    const reader = new SocketLineReader(socket);
    const request = decodeControlMessage(await reader.nextLine());
    if (request.type !== "approval_request") throw new Error("unreachable");
    writeLine(socket, decision(request.id, "allow"));
    expect(JSON.parse(await reader.nextLine())).toMatchObject({ type: "approval_decision_result", id: request.id, status: "applied" });
    expect(parseDecision((await hook).stdout)).toBe("allow");
  });

  it("承認チャネルの中継（serve）を通って iPhone 側へ届く", async () => {
    if (!(await canListenUnixSocket())) return;
    const broker = startBroker(`adr-broker-${randomUUID().slice(0, 6)}`);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const hook = runHookCore({ stdinData: bashPreToolUse("ls"), socketPath: broker.socketPath, deadlineSeconds: 5, engineRelaySocketPath: null });
      let request = decodeControlMessage(await broker.outputLines.next(5000));
      while (request.type !== "approval_request") request = decodeControlMessage(await broker.outputLines.next(5000));
      broker.input.write(decision(request.id, "allow") + "\n");
      expect(JSON.parse(await broker.outputLines.next(5000))).toEqual({
        type: "approval_decision_result", v: 1, id: request.id, status: "applied",
      });
      expect(parseDecision((await hook).stdout)).toBe("allow");
    } finally {
      await broker.teardown();
    }
  });
});

describe("API エージェントの承認（approvalBridge）: approval_decision_result", () => {
  it("自分の id の決定で applied を返して確定する", async () => {
    if (!(await canListenUnixSocket())) return;
    const socketPath = tempSocketPath(`adr-api-${randomUUID().slice(0, 6)}`);
    const listener = await startListener(socketPath);
    listeners.push(listener);
    const pending = requestApiAgentApproval(
      { id: "api-1", session: "s", tool: "Bash", summary: "ls", cwd: "/work" },
      { socketPathFor: () => socketPath, deadlineMs: 5_000 },
    );
    const socket: net.Socket = await listener.nextConnection();
    const reader = new SocketLineReader(socket);
    expect(decodeControlMessage(await reader.nextLine())).toMatchObject({ type: "approval_request", id: "api-1" });
    writeLine(socket, decision("other", "allow"));
    writeLine(socket, decision("api-1", "deny"));
    expect(JSON.parse(await reader.nextLine())).toEqual({ type: "approval_decision_result", v: 1, id: "api-1", status: "applied" });
    expect(await pending).toBe("deny");
  });
});
