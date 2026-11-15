// approvalMailbox.test.ts — 承認の受け渡し口（tailii-chat-cli 第 2 段）: 承認フックと `tailii-host chat approve` の間

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_APPROVER_REASON,
  runHookCore,
} from "../src/approval/hook.js";
import {
  findPendingApproval,
  isCliSession,
  takeApprovalResult,
  listPendingApprovals,
  readApprovalDecision,
  removePendingApproval,
  waitForMailboxDecision,
  writeApprovalDecision,
  writePendingApproval,
} from "../src/approval/approvalMailbox.js";
import { decodeControlMessage } from "../src/protocol.js";
import { SocketLineReader, startListener, tempSocketPath, type FakeListener } from "./socketHelpers.js";

const tempBase = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "approvals-"));
const CLI_SESSION = "s-cli0123456789abcdef";

function bash(command: string): Buffer {
  return Buffer.from(JSON.stringify({ session_id: "sess", tool_name: "Bash", tool_input: { command }, cwd: "/w" }));
}

function decisionOf(stdout: string): { decision: string; reason?: string } {
  const out = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } })
    .hookSpecificOutput;
  return { decision: out.permissionDecision, ...(out.permissionDecisionReason !== undefined ? { reason: out.permissionDecisionReason } : {}) };
}

describe("承認の受け渡し口", () => {
  it("書き出した承認は一覧・id で見つかり、決定は 1 回だけ置ける。片付けで消える", () => {
    const base = tempBase();
    writePendingApproval({ id: "a1", session: CLI_SESSION, tool: "Bash", summary: "ls", cwd: "/w", atMs: 1, pid: process.pid }, base);
    expect(listPendingApprovals(CLI_SESSION, base).map((r) => r.id)).toEqual(["a1"]);
    expect(findPendingApproval("a1", base)?.session).toBe(CLI_SESSION);
    expect(writeApprovalDecision(CLI_SESSION, "a1", { decision: "deny", atMs: 2 }, base)).toEqual({ status: "written" });
    expect(writeApprovalDecision(CLI_SESSION, "a1", { decision: "allow", atMs: 3 }, base))
      .toMatchObject({ status: "exists", existing: { decision: "deny" } });
    expect(readApprovalDecision(CLI_SESSION, "a1", base)?.decision).toBe("deny");
    removePendingApproval(CLI_SESSION, "a1", base);
    expect(listPendingApprovals(CLI_SESSION, base)).toEqual([]);
    // 記録が消えた後に置いた決定は残さない（誰も読まない）。
    expect(writeApprovalDecision(CLI_SESSION, "a1", { decision: "allow", atMs: 4 }, base)).toEqual({ status: "exists", existing: null });
    expect(readApprovalDecision(CLI_SESSION, "a1", base)).toBeNull();
    expect(readApprovalDecision(CLI_SESSION, "a1", base)).toBeNull();
  });

  it("待っているフックが居ない記録（残骸）は一覧に出さない。会話名・id で外へ出られない", () => {
    const base = tempBase();
    writePendingApproval({ id: "dead", session: CLI_SESSION, tool: "Bash", summary: "x", cwd: "/w", atMs: 1, pid: 2_147_483_000 }, base);
    expect(listPendingApprovals(CLI_SESSION, base)).toEqual([]);
    writePendingApproval({ id: "x", session: "..", tool: "Bash", summary: "x", cwd: "/w", atMs: 1, pid: process.pid }, base);
    expect(fs.readdirSync(base)).toEqual([CLI_SESSION]);
    expect(writeApprovalDecision(CLI_SESSION, "../evil", { decision: "allow", atMs: 1 }, base)).toEqual({ status: "invalid" });
  });

  it("決定ファイルを待つ（置かれたら返り、中止・期限で null）", async () => {
    const base = tempBase();
    const stop = new AbortController();
    writePendingApproval({ id: "w1", session: CLI_SESSION, tool: "Bash", summary: "x", cwd: "/w", atMs: 1, pid: process.pid }, base);
    const waiting = waitForMailboxDecision(CLI_SESSION, "w1", Date.now() + 5_000, stop.signal, { base, intervalMs: 20 });
    setTimeout(() => writeApprovalDecision(CLI_SESSION, "w1", { decision: "allow", atMs: 1 }, base), 50);
    expect((await waiting)?.decision).toBe("allow");
    const aborted = new AbortController();
    const never = waitForMailboxDecision(CLI_SESSION, "w2", Date.now() + 5_000, aborted.signal, { base, intervalMs: 20 });
    aborted.abort();
    expect(await never).toBeNull();
  });

  it("CLI の会話名を見分ける", () => {
    expect(isCliSession(CLI_SESSION)).toBe(true);
    expect(isCliSession("s-1234abcd")).toBe(false);
  });
});

describe("承認フックと受け渡し口", () => {
  let listener: FakeListener | null = null;
  afterEach(async () => {
    await listener?.close();
    listener = null;
  });

  it("アプリがつながって待っていても、受け渡し口の決定が先ならそれで決める（記録は片付ける）", async () => {
    const base = tempBase();
    const socketPath = tempSocketPath("mailbox-first");
    listener = await startListener(socketPath);
    const requested = (async () => {
      const socket = await listener!.nextConnection();
      const message = decodeControlMessage(await new SocketLineReader(socket).nextLine());
      if (message.type !== "approval_request") throw new Error("not approval_request");
      return message.id;
    })();
    const run = runHookCore({
      stdinData: bash("rm -rf build"), socketPath, deadlineSeconds: 5, session: CLI_SESSION,
      approvalsBase: base, approvalsPollMs: 20, engineRelaySocketPath: null,
    });
    const id = await requested;
    // アプリへ送った承認と同じ id で受け渡し口に出ている。
    expect(listPendingApprovals(CLI_SESSION, base).map((r) => r.id)).toEqual([id]);
    writeApprovalDecision(CLI_SESSION, id, { decision: "deny", reason: "Bot が拒否", atMs: 1 }, base);
    const result = await run;
    expect(decisionOf(result.stdout)).toEqual({ decision: "deny", reason: "Bot が拒否" });
    expect(listPendingApprovals(CLI_SESSION, base)).toEqual([]);
    // CLI の決定で決まったことを結果に残す（CLI が読んで消す）。
    expect(takeApprovalResult(CLI_SESSION, id, base)).toEqual({ decision: "deny", by: "cli" });
    expect(takeApprovalResult(CLI_SESSION, id, base)).toBeNull();
  });

  it("CLI が決定を置いた直後にアプリが先に答えたら、結果はアプリの決定（CLI の applied と取り違えない）", async () => {
    const base = tempBase();
    const socketPath = tempSocketPath("app-first");
    listener = await startListener(socketPath);
    const run = runHookCore({
      stdinData: bash("make"), socketPath, deadlineSeconds: 5, session: CLI_SESSION,
      approvalsBase: base, approvalsPollMs: 5_000, engineRelaySocketPath: null,
    });
    const socket = await listener.nextConnection();
    const message = decodeControlMessage(await new SocketLineReader(socket).nextLine());
    if (message.type !== "approval_request") throw new Error("not approval_request");
    writeApprovalDecision(CLI_SESSION, message.id, { decision: "deny", atMs: 1 }, base);
    socket.write(JSON.stringify({ type: "approval_decision", v: 1, id: message.id, decision: "allow" }) + "\n");
    expect(decisionOf((await run).stdout).decision).toBe("allow");
    expect(takeApprovalResult(CLI_SESSION, message.id, base)).toEqual({ decision: "allow", by: "app" });
  });

  it("CLI の会話で、アプリがつながっておらず承認できる人も居なければ、待たずに拒否する", async () => {
    const started = Date.now();
    const result = await runHookCore({
      stdinData: bash("curl example.com"), socketPath: tempSocketPath("no-approver"), deadlineSeconds: 30,
      session: CLI_SESSION, approvalsBase: tempBase(), engineRelaySocketPath: null, approverAvailable: () => false,
    });
    expect(decisionOf(result.stdout)).toEqual({ decision: "deny", reason: NO_APPROVER_REASON });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("承認できる人が居る、または CLI の会話でなければ、従来どおり待つ（受け渡し口の許可で決まる）", async () => {
    for (const [session, available] of [[CLI_SESSION, true], ["s-1234abcd", false]] as const) {
      const base = tempBase();
      const run = runHookCore({
        stdinData: bash("make"), socketPath: tempSocketPath("wait"), deadlineSeconds: 10, session,
        approvalsBase: base, approvalsPollMs: 20, engineRelaySocketPath: null, retryConnectIntervalSeconds: 0.05,
        approverAvailable: () => available,
      });
      let pending = listPendingApprovals(session, base);
      for (let i = 0; i < 50 && pending.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        pending = listPendingApprovals(session, base);
      }
      expect(pending).toHaveLength(1);
      writeApprovalDecision(session, pending[0]!.id, { decision: "allow", atMs: 1 }, base);
      expect(decisionOf((await run).stdout).decision).toBe("allow");
    }
  });
});
