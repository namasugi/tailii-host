import { EventEmitter } from "node:events";
import * as net from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { runHookCore } from "../src/approval/hook.js";
import { requestCodexApprovalViaBroker } from "../src/codex/codexNativeTurnController.js";
import { decodeEngineRelayLine, type ApprovalEventMessage } from "../src/hub/engineRelaySocket.js";

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof net>();
  return { ...actual, connect: vi.fn(), createConnection: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function channel(write: (line: string) => void = () => {}, end: (line: string) => void = () => {}) {
  const socket = Object.assign(new EventEmitter(), {
    destroy() {},
    write(line: string) { write(line); return true; },
    end(line?: string, done?: () => void) { if (line !== undefined) end(line); done?.(); },
  });
  queueMicrotask(() => socket.emit("connect"));
  return socket;
}

const APPROVAL = "/fake/approval.sock";
const RELAY = "/fake/relay.sock";

function runHook() {
  const session = "cs-work";
  return {
    session,
    options: {
      stdinData: Buffer.from(JSON.stringify({
        session_id: "conv-id", tool_name: "Bash", tool_input: { command: "echo x" }, cwd: "/tmp",
      })),
      socketPath: APPROVAL, engineRelaySocketPath: RELAY, deadlineSeconds: 0.1, session,
    },
  };
}

test.each([
  { reply: "allow", decision: "allow", by: "app" },
  { reply: "deny", decision: "deny", by: "app" },
  { reply: "timeout", decision: "deny", by: "timeout" },
  { reply: "terminal", decision: undefined, by: "terminal" },
] as const)("フックは承認の開始と $reply の決着を relay へ送る", async ({ reply, decision, by }) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const h = runHook();
  const cancel = new AbortController();
  const sent: ApprovalEventMessage[] = [];
  vi.mocked(net.connect).mockImplementation((target) => {
    if (target === RELAY) return channel(undefined, (line) => {
      const event = decodeEngineRelayLine(line);
      if (event?.type === "approval_event") sent.push(event);
    }) as unknown as net.Socket;
    expect(target).toBe(APPROVAL);
    const socket = channel((line) => {
      const { type, id, v } = JSON.parse(line);
      if (type !== "approval_request") return;
      queueMicrotask(() => {
        if (reply === "allow" || reply === "deny") {
          socket.emit("data", Buffer.from(JSON.stringify({ type: "approval_decision", id, v, decision: reply }) + "\n"));
        } else if (reply === "terminal") {
          cancel.abort();
        }
      });
    });
    return socket as unknown as net.Socket;
  });
  const pending = runHookCore({ ...h.options, cancelSignal: cancel.signal });
  await vi.advanceTimersByTimeAsync(150);
  const result = await pending;
  expect(result.exitCode).toBe(0);
  if (decision === undefined) expect(result.stdout).toBe("");
  else expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe(decision);
  const id = sent[0]?.id;
  expect(id).toBeTruthy();
  expect(sent).toEqual([
    { type: "approval_event", session: h.session, id, event: "request", tool: "Bash" },
    { type: "approval_event", session: h.session, id, event: "resolved", by, ...(decision !== undefined ? { decision } : {}) },
  ]);
});

test("relay が居ない場合や無効な設定でもアプリの承認結果は変わらない", async () => {
  const h = runHook();
  const failed = vi.fn();
  vi.mocked(net.connect).mockImplementation((target) => {
    if (target === RELAY) {
      failed();
      throw new Error("relay に接続できない");
    }
    const socket = channel((line) => {
      const { type, id, v } = JSON.parse(line);
      if (type !== "approval_request") return;
      queueMicrotask(() => socket.emit("data", Buffer.from(
        JSON.stringify({ type: "approval_decision", id, v, decision: "allow" }) + "\n",
      )));
    });
    return socket as unknown as net.Socket;
  });
  const result = await runHookCore(h.options);
  const attempts = failed.mock.calls.length;
  expect(attempts).toBeGreaterThan(0);
  expect(result).toEqual(await runHookCore({ ...h.options, engineRelaySocketPath: null }));
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  expect(failed).toHaveBeenCalledTimes(attempts);
});

test("Codex の受け渡し口を無効にしても通知し、通知先の例外を承認に伝えない", async () => {
  vi.mocked(net.createConnection).mockImplementation(() => {
    const socket = channel((line) => {
      const { id, v } = JSON.parse(line);
      queueMicrotask(() => socket.emit("data", Buffer.from(
        JSON.stringify({ type: "approval_decision", id, v, decision: "allow" }) + "\n",
      )));
    });
    return socket as unknown as net.Socket;
  });
  const onApprovalEvent = vi.fn(() => { throw new Error("書けない"); });
  expect(await requestCodexApprovalViaBroker({
    id: "approval", session: "cs-work", tool: "Bash", summary: "承認本文", cwd: "/tmp",
  }, { approvalsBase: null, onApprovalEvent, decisionTimeoutMs: 100 })).toBe("allow");
  expect(onApprovalEvent.mock.calls).toEqual([
    [{ session: "cs-work", id: "approval", event: "request", tool: "Bash" }],
    [{ session: "cs-work", id: "approval", event: "resolved", decision: "allow", by: "app" }],
  ]);
});

test("アプリに届かないまま期限で拒否した承認は、アプリで決めたと記録しない", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const h = runHook();
  const sent: ApprovalEventMessage[] = [];
  vi.mocked(net.connect).mockImplementation((target) => {
    if (target === RELAY) return channel(undefined, (line) => {
      const event = decodeEngineRelayLine(line);
      if (event?.type === "approval_event") sent.push(event);
    }) as unknown as net.Socket;
    // 承認チャネルにはつながらない（アプリが居ない）。
    const socket = Object.assign(new EventEmitter(), { destroy() {}, write() { return true; }, end() {} });
    queueMicrotask(() => socket.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
    return socket as unknown as net.Socket;
  });
  const pending = runHookCore({ ...h.options, retryConnectIntervalSeconds: 0.02 });
  await vi.advanceTimersByTimeAsync(400);
  const result = await pending;
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(sent.map((event) => [event.event, event.decision, event.by])).toEqual([
    ["request", undefined, undefined], ["resolved", "deny", "timeout"],
  ]);
});
