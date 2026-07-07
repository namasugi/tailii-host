// hook.test.ts — Hook (PreToolUse 承認ゲート) テスト
// Swift 版 HookTests / HookTimeoutOrderingTests / HookRetryConnectTests の移植。
//
// hook は「クライアント」なので、テストは「偽 broker / iPhone」リスナ（サーバ）を立て、
// 細工した PreToolUse JSON を stdinData として runHookCore に渡し、
// allow / deny / 無応答 / 切断 / connect 失敗 / 不正行 / retry-connect を網羅する。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type * as net from "node:net";
import {
  HOOK_INTERNAL_DEADLINE_SECONDS,
  hookStdoutForAgent,
  runHookCore,
  type ApprovalPushRequest,
} from "../src/hook.js";
import {
  HOOK_EXTERNAL_TIMEOUT_SECONDS,
  claudeHookLaunchSettings,
  installCodexHookSettings,
} from "../src/hookSettings.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import {
  SocketLineReader,
  startListener,
  tempSocketPath,
  writeLine,
  type FakeListener,
} from "./socketHelpers.js";

// MARK: - フック入力生成

function bashPreToolUse(command: string, cwd: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-abc",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
    }),
  );
}

function writePreToolUse(filePath: string, content: string, cwd: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-def",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath, content },
      cwd,
    }),
  );
}

function editPreToolUse(filePath: string, oldString: string, newString: string, cwd: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-edit",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
      cwd,
    }),
  );
}

function postToolUse(toolName: string, toolUseId: string, decision: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-post",
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: { command: "echo x" },
      tool_response: { permissionDecision: decision },
    }),
  );
}

// MARK: - 出力パース

function parseDecision(stdout: string): { decision: string; reason?: string } {
  const obj = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason?: string;
    };
  };
  expect(obj.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  const out: { decision: string; reason?: string } = {
    decision: obj.hookSpecificOutput.permissionDecision,
  };
  if (obj.hookSpecificOutput.permissionDecisionReason !== undefined) {
    out.reason = obj.hookSpecificOutput.permissionDecisionReason;
  }
  return out;
}

function tempDir(suffix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hook-${suffix}-`));
}

/** 偽 broker: accept → approval_request を受信して decision を返す。受信 message を返す。 */
async function serveOnce(
  listener: FakeListener,
  respond: (id: string, socket: net.Socket) => void,
): Promise<ControlMessage> {
  const socket = await listener.nextConnection();
  const reader = new SocketLineReader(socket);
  const line = await reader.nextLine();
  const message = decodeControlMessage(line);
  if (message.type !== "approval_request") throw new Error(`approval_request ではない: ${line}`);
  respond(message.id, socket);
  return message;
}

function encodeDecision(id: string, decision: "allow" | "deny", reason?: string): string {
  const payload: Record<string, unknown> = { type: "approval_decision", v: 1, id, decision };
  if (reason !== undefined) payload["reason"] = reason;
  return JSON.stringify(payload);
}

// MARK: - SPY notifier

class SpyNotifier {
  readonly calls: ApprovalPushRequest[] = [];
  readonly notifier = async (request: ApprovalPushRequest): Promise<void> => {
    this.calls.push(request);
  };
}

describe("Hook — PreToolUse 承認ゲート", () => {
  let listener: FakeListener | null = null;
  let socketPath = "";

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = null;
    }
    if (socketPath) {
      fs.rmSync(socketPath, { force: true });
      socketPath = "";
    }
  });

  it("allow 決定 → permissionDecision allow（approval_request の形状も検証・connect 成功では push しない 7.1）", async () => {
    socketPath = tempSocketPath("allow");
    listener = await startListener(socketPath);
    const spy = new SpyNotifier();

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "allow"));
    });
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo hello", "/work/dir"),
      socketPath,
      deadlineSeconds: 5,
      notifier: spy.notifier,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("allow");
    if (message.type !== "approval_request") throw new Error("unreachable");
    expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(message.tool).toBe("Bash");
    expect(message.summary).toBe("echo hello");
    expect(message.cwd).toBe("/work/dir");
    // 相互排他 7.1: connect 成功経路では push しない。
    expect(spy.calls.length).toBe(0);
  });

  it("deny 決定（理由あり）→ permissionDecision deny + 理由", async () => {
    socketPath = tempSocketPath("deny");
    listener = await startListener(socketPath);

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "deny", "Denied on iPhone"));
    });
    const { exitCode, stdout } = await runHookCore({
      stdinData: writePreToolUse("/work/secret.txt", "hello", "/work"),
      socketPath,
      deadlineSeconds: 5,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("Denied on iPhone");
    if (message.type !== "approval_request") throw new Error("unreachable");
    expect(message.tool).toBe("Write");
    expect(message.summary).toContain("/work/secret.txt");
  });

  it("無応答でデッドラインに達したら deny（Req 5.1）", async () => {
    socketPath = tempSocketPath("deadline");
    listener = await startListener(socketPath);
    void listener.nextConnection().catch(() => {}); // accept はするが決定を返さない

    const start = Date.now();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("sleep 1", "/work"),
      socketPath,
      deadlineSeconds: 0.2,
    });
    const elapsed = (Date.now() - start) / 1000;

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
    expect(elapsed).toBeLessThan(0.9);
  });

  it("接続後すぐ切断（EOF）→ deny（Req 5.2）", async () => {
    socketPath = tempSocketPath("disconnect");
    listener = await startListener(socketPath);

    const served = (async () => {
      const socket = await listener!.nextConnection();
      const reader = new SocketLineReader(socket);
      await reader.nextLine(); // request を読み捨ててから即切断
      socket.destroy();
    })();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 5,
    });
    await served;

    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("iPhone disconnected");
  });

  it("接続失敗（broker 不在）→ deny（fail-safe）", async () => {
    socketPath = tempSocketPath("noexist");
    fs.rmSync(socketPath, { force: true });

    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 0.4,
      retryConnectIntervalSeconds: 0.05,
    });

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
  });

  it("不正な決定行（解析不能 JSON）→ deny（Req 3.3）", async () => {
    socketPath = tempSocketPath("malformed");
    listener = await startListener(socketPath);

    void (async () => {
      const socket = await listener!.nextConnection();
      const reader = new SocketLineReader(socket);
      await reader.nextLine();
      writeLine(socket, "{not valid json");
    })();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 1,
    });

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
  });

  it("id 不一致の決定 → 有効決定なしでデッドライン deny", async () => {
    socketPath = tempSocketPath("idmismatch");
    listener = await startListener(socketPath);

    void (async () => {
      const socket = await listener!.nextConnection();
      const reader = new SocketLineReader(socket);
      await reader.nextLine();
      writeLine(socket, encodeDecision("totally-different-id", "allow"));
    })();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 0.3,
    });

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
  });

  it("Write → approval_request.diff は create + newText 全文（Req 6.2）", async () => {
    socketPath = tempSocketPath("wdiff");
    listener = await startListener(socketPath);

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "allow"));
    });
    const { exitCode } = await runHookCore({
      stdinData: writePreToolUse("/w/new.txt", "line1\nline2", "/w"),
      socketPath,
      deadlineSeconds: 5,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    if (message.type !== "approval_request") throw new Error("unreachable");
    expect(message.diff?.kind).toBe("create");
    expect(message.diff?.path).toBe("/w/new.txt");
    expect(message.diff?.newText).toBe("line1\nline2");
    expect(message.diff?.oldString).toBeUndefined();
  });

  it("Edit → approval_request.diff は edit + oldString/newString（Req 6.2）", async () => {
    socketPath = tempSocketPath("ediff");
    listener = await startListener(socketPath);

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "allow"));
    });
    const { exitCode } = await runHookCore({
      stdinData: editPreToolUse("/w/edit.txt", "foo", "bar", "/w"),
      socketPath,
      deadlineSeconds: 5,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    if (message.type !== "approval_request") throw new Error("unreachable");
    expect(message.diff?.kind).toBe("edit");
    expect(message.diff?.path).toBe("/w/edit.txt");
    expect(message.diff?.oldString).toBe("foo");
    expect(message.diff?.newString).toBe("bar");
    expect(message.diff?.newText).toBeUndefined();
  });

  it("Bash → approval_request.diff は無し（summary のみ）", async () => {
    socketPath = tempSocketPath("bdiff");
    listener = await startListener(socketPath);

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "allow"));
    });
    const { exitCode } = await runHookCore({
      stdinData: bashPreToolUse("ls", "/w"),
      socketPath,
      deadlineSeconds: 5,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    if (message.type !== "approval_request") throw new Error("unreachable");
    expect(message.diff).toBeUndefined();
  });

  it("broadcast された他 id / 非対応 v の決定を無視し、自 id の allow で確定（Req 5.4）", async () => {
    socketPath = tempSocketPath("bcast");
    listener = await startListener(socketPath);

    void (async () => {
      const socket = await listener!.nextConnection();
      const reader = new SocketLineReader(socket);
      const line = await reader.nextLine();
      const message = decodeControlMessage(line);
      if (message.type !== "approval_request") return;
      // 1) 他 id の deny（無視されるべき）
      writeLine(socket, encodeDecision("other-hook-id", "deny", "not me"));
      // 2) 非対応 v の決定行（無視されるべき）
      writeLine(socket, `{"type":"approval_decision","v":99,"id":"${message.id}","decision":"deny"}`);
      // 3) 自 id の allow（受理されるべき）
      writeLine(socket, encodeDecision(message.id, "allow"));
    })();

    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w"),
      socketPath,
      deadlineSeconds: 5,
    });

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("allow");
  });

  it("非対応 v の決定のみ → 有効決定なしでデッドライン deny（Req 4.4/5.4）", async () => {
    socketPath = tempSocketPath("badv");
    listener = await startListener(socketPath);

    void (async () => {
      const socket = await listener!.nextConnection();
      const reader = new SocketLineReader(socket);
      const line = await reader.nextLine();
      const message = decodeControlMessage(line);
      if (message.type !== "approval_request") return;
      writeLine(socket, `{"type":"approval_decision","v":99,"id":"${message.id}","decision":"allow"}`);
    })();

    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w"),
      socketPath,
      deadlineSeconds: 0.3,
    });

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
  });

  it("PostToolUse → ObservationLog に監査行が1件追記される（Req 5.8）", async () => {
    const obsBase = tempDir("obs");

    const { exitCode, stdout } = await runHookCore({
      stdinData: postToolUse("Bash", "tuid-123", "allow"),
      socketPath: null,
      deadlineSeconds: 5,
      session: "sess1",
      observationBase: obsBase,
    });

    expect(exitCode).toBe(0);
    expect(stdout.includes("permissionDecision")).toBe(false);

    const content = fs.readFileSync(path.join(obsBase, "sess1.ndjson"), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(content).toContain("mac.tool.executed");
    expect(content).toContain("tuid-123");
  });

  it("画像パスの Write → pending レコードが1件作られる（Req 8.1/8.5）", async () => {
    socketPath = tempSocketPath("img");
    listener = await startListener(socketPath);
    const pendingBase = path.join(tempDir("pending"), "pending");

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "allow"));
    });
    const { exitCode } = await runHookCore({
      stdinData: writePreToolUse("/w/shot.PNG", "binary", "/w"),
      socketPath,
      deadlineSeconds: 5,
      session: "sess-img",
      imagesPendingBase: pendingBase,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    if (message.type !== "approval_request") throw new Error("unreachable");
    const files = fs.readdirSync(pendingBase).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    const record = JSON.parse(fs.readFileSync(path.join(pendingBase, files[0]!), "utf8")) as {
      imageId: string;
      path: string;
      relatedApprovalId: string;
    };
    expect(record.path).toBe("/w/shot.PNG");
    expect(record.imageId.length).toBeGreaterThan(0);
    expect(record.relatedApprovalId).toBe(message.id);
  });

  it("非画像パスの Write → pending レコードは作られない（Req 8.5）", async () => {
    socketPath = tempSocketPath("noimg");
    listener = await startListener(socketPath);
    const pendingBase = path.join(tempDir("pending-none"), "pending");

    const served = serveOnce(listener, (id, socket) => {
      writeLine(socket, encodeDecision(id, "allow"));
    });
    const { exitCode } = await runHookCore({
      stdinData: writePreToolUse("/w/code.swift", "code", "/w"),
      socketPath,
      deadlineSeconds: 5,
      session: "sess-noimg",
      imagesPendingBase: pendingBase,
    });
    await served;

    expect(exitCode).toBe(0);
    const files = fs.existsSync(pendingBase)
      ? fs.readdirSync(pendingBase).filter((name) => name.endsWith(".json"))
      : [];
    expect(files.length).toBe(0);
  });

  it("socket パス未決定（null）→ 即 deny", async () => {
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w"),
      socketPath: null,
      deadlineSeconds: 5,
    });
    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("iPhone unavailable (no socket path)");
  });
});

describe("Hook — タイムアウト順序不変条件（Req 5.7）", () => {
  it("内部デッドライン(540s) が外部タイムアウト(600s) より厳密に小さく、十分な余裕がある", () => {
    expect(HOOK_INTERNAL_DEADLINE_SECONDS).toBeLessThan(HOOK_EXTERNAL_TIMEOUT_SECONDS);
    // 決定出力・プロセス終了の余裕として最低 10s を要求（回帰ガード）。
    expect(HOOK_EXTERNAL_TIMEOUT_SECONDS - HOOK_INTERNAL_DEADLINE_SECONDS).toBeGreaterThanOrEqual(10);
  });

  it("--settings で渡す hook timeout は externalTimeoutSeconds と一致する（非空虚性）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-timeout-ordering-"));
    const json = claudeHookLaunchSettings({
      dir,
      binaryPath: "/abs/tailii-host",
      session: "ordersess",
      globalMarkerPath: "/nonexistent-nohook-marker",
    });
    const settings = JSON.parse(json!) as {
      hooks: Record<string, { hooks: { timeout: number }[] }[]>;
    };
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const timeout = settings.hooks[event]?.[0]?.hooks[0]?.timeout;
      expect(timeout).toBe(HOOK_EXTERNAL_TIMEOUT_SECONDS);
      expect(timeout!).toBeGreaterThan(HOOK_INTERNAL_DEADLINE_SECONDS);
    }
  });
});

describe("Hook — 待機延長・retry-connect（Req 8.1/8.2/8.3）", () => {
  let socketPath = "";
  let listener: FakeListener | null = null;

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = null;
    }
    if (socketPath) {
      fs.rmSync(socketPath, { force: true });
      socketPath = "";
    }
  });

  /** 遅れて listener を bind し、request に decision を返す（iPhone 復帰役）。 */
  function bindLateAndRespond(
    delayMs: number,
    decision: "allow" | "deny",
    reason?: string,
  ): Promise<ControlMessage | null> {
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      listener = await startListener(socketPath);
      const socket = await listener.nextConnection();
      const reader = new SocketLineReader(socket);
      const line = await reader.nextLine();
      const message = decodeControlMessage(line);
      if (message.type !== "approval_request") return null;
      writeLine(socket, encodeDecision(message.id, decision, reason));
      return message;
    })();
  }

  it("connect 不能 → push → 遅れて bind → 再接続し approval_request 送出・allow 反映（8.1/8.2）", async () => {
    socketPath = tempSocketPath(`reconnect-allow-${randomUUID().slice(0, 8)}`);
    fs.rmSync(socketPath, { force: true });
    const spy = new SpyNotifier();

    const served = bindLateAndRespond(300, "allow");
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 2,
      session: "sess-reconnect-1",
      notifier: spy.notifier,
      notifierTimeLimitMs: 1000,
      retryConnectIntervalSeconds: 0.05,
    });
    const message = await served;

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("allow");
    expect(message?.type).toBe("approval_request");
    if (message?.type === "approval_request") expect(message.tool).toBe("Bash");
    // push は connect 不能でちょうど1回。
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.session).toBe("sess-reconnect-1");
  });

  it("connect 不能 → push → 遅れて bind → 再接続し deny を反映（8.2）", async () => {
    socketPath = tempSocketPath(`reconnect-deny-${randomUUID().slice(0, 8)}`);
    fs.rmSync(socketPath, { force: true });
    const spy = new SpyNotifier();

    const served = bindLateAndRespond(300, "deny", "Denied late");
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("rm -rf /x", "/work"),
      socketPath,
      deadlineSeconds: 2,
      session: "sess-reconnect-2",
      notifier: spy.notifier,
      notifierTimeLimitMs: 1000,
      retryConnectIntervalSeconds: 0.05,
    });
    await served;

    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("Denied late");
  });

  it("connect 不能のまま socket が現れず → deadline で deny（8.3）", async () => {
    socketPath = tempSocketPath(`reconnect-never-${randomUUID().slice(0, 8)}`);
    fs.rmSync(socketPath, { force: true });
    const spy = new SpyNotifier();

    const start = Date.now();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 0.6,
      session: "sess-reconnect-3",
      notifier: spy.notifier,
      notifierTimeLimitMs: 1000,
      retryConnectIntervalSeconds: 0.05,
    });
    const elapsed = (Date.now() - start) / 1000;

    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("no reconnect within");
    // deadline（0.6s）まで retry-connect し続ける（即 deny ではない）。
    expect(elapsed).toBeGreaterThanOrEqual(0.5);
    expect(elapsed).toBeLessThan(10);
    expect(spy.calls.length).toBe(1);
  });

  it("notifier 無しでも connect 不能→retry-connect→deadline deny（後方互換・8.3）", async () => {
    socketPath = tempSocketPath(`reconnect-nilnotif-${randomUUID().slice(0, 8)}`);
    fs.rmSync(socketPath, { force: true });

    const start = Date.now();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 0.5,
      session: "sess-reconnect-4",
      retryConnectIntervalSeconds: 0.05,
    });
    const elapsed = (Date.now() - start) / 1000;

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
    expect(elapsed).toBeGreaterThanOrEqual(0.4);
  });
});

describe("Hook — codex 出力適応", () => {
  const allowJson =
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok"}}';
  const denyJson =
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}';

  it("claude はそのまま出力する（allow/deny とも）", () => {
    expect(hookStdoutForAgent("claude", allowJson)).toBe(allowJson);
    expect(hookStdoutForAgent("claude", denyJson)).toBe(denyJson);
  });

  it("codex は allow を無出力（null=exit0 続行）にし、deny はそのまま出す", () => {
    // codex は permissionDecision:allow を unsupported として拒否するため無出力にする。
    expect(hookStdoutForAgent("codex", allowJson)).toBeNull();
    // deny は codex も解釈するのでそのまま。
    expect(hookStdoutForAgent("codex", denyJson)).toBe(denyJson);
  });
});

describe("installCodexHookSettings", () => {
  it(".codex/hooks.json に PreToolUse(Bash/Write|Edit, --agent codex) を書く", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-"));
    const marker = path.join(dir, "no-such-marker");
    installCodexHookSettings({ dir, binaryPath: "/bin/pc", session: "work", globalMarkerPath: marker });
    const root = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
    const pre = root.hooks.PreToolUse;
    expect(pre.map((e: { matcher: string }) => e.matcher)).toEqual(["Bash", "Write|Edit"]);
    expect(pre[0].hooks[0].command).toBe("/bin/pc hook --session work --agent codex");
    expect(pre[0].hooks[0].timeout).toBe(HOOK_EXTERNAL_TIMEOUT_SECONDS);
    // claude 用 settings.json は書かない。
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  it("再実行しても同一 command を重複追加しない（マージ保全）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks2-"));
    const marker = path.join(dir, "no-such-marker");
    installCodexHookSettings({ dir, binaryPath: "/bin/pc", session: "work", globalMarkerPath: marker });
    installCodexHookSettings({ dir, binaryPath: "/bin/pc", session: "work", globalMarkerPath: marker });
    const root = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
    // Bash + Write|Edit の 2 件のみ（重複なし）。
    expect(root.hooks.PreToolUse.length).toBe(2);
  });

  it("既存の無関係フックは保持する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks3-"));
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other.sh" }] }],
        },
      }),
    );
    const marker = path.join(dir, "no-such-marker");
    installCodexHookSettings({ dir, binaryPath: "/bin/pc", session: "work", globalMarkerPath: marker });
    const root = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
    expect(root.hooks.PostToolUse[0].hooks[0].command).toBe("other.sh");
    expect(root.hooks.PreToolUse.length).toBe(2);
  });
});
