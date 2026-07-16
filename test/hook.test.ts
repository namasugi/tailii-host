// hook.test.ts — Hook (PreToolUse 承認ゲート) テスト
// Swift 版 HookTests / HookTimeoutOrderingTests / HookRetryConnectTests の移植。
//
// hook は「クライアント」なので、テストは「偽 broker / iPhone」リスナ（サーバ）を立て、
// 細工した PreToolUse JSON を stdinData として runHookCore に渡し、
// allow / deny / 無応答 / 切断 / connect 失敗 / 不正行 / retry-connect を網羅する。

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type * as net from "node:net";
import {
  HOOK_INTERNAL_DEADLINE_SECONDS,
  autoAllowReasonForMode,
  runHookCore,
  type ApprovalPushRequest,
} from "../src/hook.js";
import {
  HOOK_EXTERNAL_TIMEOUT_SECONDS,
  claudeHookLaunchSettings,
  removeCodexHookSettings,
} from "../src/hookSettings.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { startEngineRelaySocket, type EngineRelayMessage } from "../src/engineRelaySocket.js";
import {
  SocketLineReader,
  canListenUnixSocket,
  startListener,
  tempSocketPath,
  writeLine,
  type FakeListener,
} from "./socketHelpers.js";

// MARK: - フック入力生成

function bashPreToolUse(command: string, cwd: string, permissionMode?: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-abc",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
      ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
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

function editPreToolUse(
  filePath: string,
  oldString: string,
  newString: string,
  cwd: string,
  permissionMode?: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-edit",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
      cwd,
      ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
    }),
  );
}

function askUserQuestionPreToolUse(toolUseId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: "sess-q",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: {
        questions: [
          {
            question: "どっち?",
            header: "選択",
            multiSelect: false,
            options: [{ label: "A", description: "前者" }],
          },
        ],
      },
      cwd: "/w",
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

  it("決定待ち中の切断（EOF）→ 即 deny せず、再接続後に同一 id で送り直して決定を受理（Req 8.2）", async () => {
    socketPath = tempSocketPath("disconnect-resend");
    listener = await startListener(socketPath);

    const served = (async () => {
      // 1 回目: request を受けてから即切断（iOS の chat 離脱＝serve チャネル close 相当）。
      const first = await listener!.nextConnection();
      const firstReader = new SocketLineReader(first);
      const firstMessage = decodeControlMessage(await firstReader.nextLine());
      if (firstMessage.type !== "approval_request") throw new Error("approval_request ではない");
      first.destroy();
      // 2 回目: 再接続（chat 開き直し相当）→ 送り直された request に allow を返す。
      const second = await listener!.nextConnection();
      const secondReader = new SocketLineReader(second);
      const secondMessage = decodeControlMessage(await secondReader.nextLine());
      if (secondMessage.type !== "approval_request") throw new Error("approval_request ではない");
      writeLine(second, encodeDecision(secondMessage.id, "allow", "approved-after-reopen"));
      return { firstId: firstMessage.id, secondId: secondMessage.id };
    })();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 5,
      retryConnectIntervalSeconds: 0.05,
      engineRelaySocketPath: null,
    });
    const { firstId, secondId } = await served;

    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("allow");
    expect(parsed.reason).toBe("approved-after-reopen");
    // iOS 側が一覧の pending と突合できるよう、送り直しは同一 id で行う。
    expect(secondId).toBe(firstId);
  });

  it("決定待ち中の切断後、再接続できないままデッドライン → 安全側 deny（Req 8.3）", async () => {
    socketPath = tempSocketPath("disconnect-gone");
    listener = await startListener(socketPath);

    const served = (async () => {
      const socket = await listener!.nextConnection();
      const reader = new SocketLineReader(socket);
      await reader.nextLine(); // request を読み捨てる
      await listener!.close(); // 接続ごと listener を落とす（再接続先なし）
      listener = null;
      fs.rmSync(socketPath, { force: true });
    })();
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 0.5,
      retryConnectIntervalSeconds: 0.05,
      engineRelaySocketPath: null,
    });
    await served;

    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("iPhone unavailable");
  });

  it("接続失敗（broker 不在）→ deny（fail-safe）", async () => {
    socketPath = tempSocketPath("noexist");
    fs.rmSync(socketPath, { force: true });

    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/work"),
      socketPath,
      deadlineSeconds: 0.4,
      retryConnectIntervalSeconds: 0.05,
      engineRelaySocketPath: null,
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

describe("Hook — permission mode 自動許可（mode-picker 連動）", () => {
  it("hook 入力 permission_mode=auto を pane 判定より優先して即 allow", async () => {
    let providerCalled = false;
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w", "auto"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => {
        providerCalled = true;
        return null;
      },
    });
    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("allow");
    expect(providerCalled).toBe(false);
  });

  it("hook 入力 permission_mode=acceptEdits + Edit → 即 allow", async () => {
    const { stdout } = await runHookCore({
      stdinData: editPreToolUse("/w/a.swift", "old", "new", "/w", "acceptEdits"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => null,
    });
    expect(parseDecision(stdout).decision).toBe("allow");
  });

  it("hook 入力の default は provider の古い auto より優先してゲートする", async () => {
    let providerCalled = false;
    const { stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w", "default"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => {
        providerCalled = true;
        return "auto";
      },
    });
    expect(parseDecision(stdout).decision).toBe("deny");
    expect(providerCalled).toBe(false);
  });

  it("hook 入力の未知 mode は provider で上書きせず安全側へ倒す", async () => {
    let providerCalled = false;
    const { stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w", "futureMode"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => {
        providerCalled = true;
        return "auto";
      },
    });
    expect(parseDecision(stdout).decision).toBe("deny");
    expect(providerCalled).toBe(false);
  });

  it("auto モード → iPhone 接続なしで即 allow", async () => {
    const { exitCode, stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => "auto",
    });
    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("allow");
    expect(parsed.reason).toContain("auto mode on");
  });

  it("acceptEdits モード + Edit → 即 allow", async () => {
    const { exitCode, stdout } = await runHookCore({
      stdinData: editPreToolUse("/w/a.swift", "old", "new", "/w"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => "acceptEdits",
    });
    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("allow");
    expect(parsed.reason).toContain("accept edits on");
  });

  it("acceptEdits モード + Bash → 従来どおりゲート（socket 不能なら deny）", async () => {
    const { stdout } = await runHookCore({
      stdinData: bashPreToolUse("rm -rf /", "/w"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => "acceptEdits",
    });
    expect(parseDecision(stdout).decision).toBe("deny");
  });

  it("default / plan / null（判定不能）→ 従来どおりゲート", async () => {
    for (const mode of ["default", "plan", null]) {
      const { stdout } = await runHookCore({
        stdinData: bashPreToolUse("echo x", "/w"),
        socketPath: null,
        deadlineSeconds: 5,
        permissionModeProvider: async () => mode,
      });
      expect(parseDecision(stdout).decision).toBe("deny");
    }
  });

  it("provider が throw → 判定不能として従来どおりゲート", async () => {
    const { stdout } = await runHookCore({
      stdinData: bashPreToolUse("echo x", "/w"),
      socketPath: null,
      deadlineSeconds: 5,
      permissionModeProvider: async () => {
        throw new Error("capture failed");
      },
    });
    expect(parseDecision(stdout).decision).toBe("deny");
  });

  it("接続可能でも auto モードなら approval_request を送らない", async () => {
    const socketPath = tempSocketPath("auto");
    const listener = await startListener(socketPath);
    let connected = false;
    // 接続が来ないことを期待するテストのため、accept タイムアウト（5s 後）は握り潰す
    // （握り潰さないと後続テストファイル実行中に unhandled rejection として漏れる）。
    void listener
      .nextConnection()
      .then(() => {
        connected = true;
      })
      .catch(() => {});
    try {
      const { stdout } = await runHookCore({
        stdinData: bashPreToolUse("echo x", "/w"),
        socketPath,
        deadlineSeconds: 5,
        permissionModeProvider: async () => "auto",
      });
      expect(parseDecision(stdout).decision).toBe("allow");
      expect(connected).toBe(false);
    } finally {
      await listener.close();
    }
  });

  it("AskUserQuestion → 接続なし・mode 判定なしで即 allow（設問は承認ゲートしない）", async () => {
    let providerCalled = false;
    const { exitCode, stdout } = await runHookCore({
      stdinData: askUserQuestionPreToolUse("toolu_q1"),
      socketPath: null,
      deadlineSeconds: 5,
      engineRelaySocketPath: null,
      permissionModeProvider: async () => {
        providerCalled = true;
        return "default";
      },
    });
    expect(exitCode).toBe(0);
    const parsed = parseDecision(stdout);
    expect(parsed.decision).toBe("allow");
    expect(parsed.reason).toContain("AskUserQuestion");
    expect(providerCalled).toBe(false);
  });

  it("AskUserQuestion PreToolUse → engine relay へ question_event(prompt) を送ってから allow", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("q-relay-prompt");
    fs.rmSync(relayPath, { force: true });
    const received: EngineRelayMessage[] = [];
    const relay = await startEngineRelaySocket({
      socketPath: relayPath,
      onMessage: (m) => received.push(m),
    });
    expect(relay).not.toBeNull();
    try {
      const { stdout } = await runHookCore({
        stdinData: askUserQuestionPreToolUse("toolu_q2"),
        socketPath: null,
        deadlineSeconds: 5,
        session: "sess-q",
        engineRelaySocketPath: relayPath,
      });
      expect(parseDecision(stdout).decision).toBe("allow");
      // onMessage は data イベント経由（非同期）なので短く待つ。
      await new Promise((resolve) => setTimeout(resolve, 100));
      const events = received.filter((m) => m.type === "question_event");
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe("question_event");
      if (event.type === "question_event") {
        expect(event.event).toBe("prompt");
        expect(event.session).toBe("sess-q");
        expect(event.id).toBe("toolu_q2");
        expect(event.questions).toHaveLength(1);
        expect(event.questions?.[0]?.question).toBe("どっち?");
        expect(event.questions?.[0]?.options).toEqual([{ label: "A", description: "前者" }]);
      }
    } finally {
      await relay?.close();
    }
  });

  it("AskUserQuestion PostToolUse → engine relay へ question_event(dismiss) を送る", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("q-relay-dismiss");
    fs.rmSync(relayPath, { force: true });
    const received: EngineRelayMessage[] = [];
    const relay = await startEngineRelaySocket({
      socketPath: relayPath,
      onMessage: (m) => received.push(m),
    });
    expect(relay).not.toBeNull();
    try {
      const { exitCode } = await runHookCore({
        stdinData: Buffer.from(
          JSON.stringify({
            session_id: "sess-q",
            hook_event_name: "PostToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_q3",
            tool_input: {},
            tool_response: {},
          }),
        ),
        socketPath: null,
        deadlineSeconds: 5,
        session: "sess-q",
        engineRelaySocketPath: relayPath,
      });
      expect(exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const events = received.filter((m) => m.type === "question_event");
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event.type === "question_event") {
        expect(event.event).toBe("dismiss");
        expect(event.session).toBe("sess-q");
        expect(event.id).toBe("toolu_q3");
      }
    } finally {
      await relay?.close();
    }
  });

  it("AskUserQuestion で relay 不達でも allow は阻害されない", async () => {
    const { stdout } = await runHookCore({
      stdinData: askUserQuestionPreToolUse("toolu_q4"),
      socketPath: null,
      deadlineSeconds: 5,
      engineRelaySocketPath: tempSocketPath("q-relay-absent"),
    });
    expect(parseDecision(stdout).decision).toBe("allow");
  });

  it("autoAllowReasonForMode 純ロジック", () => {
    expect(autoAllowReasonForMode("auto", "Bash")).toContain("auto mode on");
    expect(autoAllowReasonForMode("auto", "Read")).toContain("auto mode on");
    expect(autoAllowReasonForMode("acceptEdits", "Write")).toContain("accept edits on");
    expect(autoAllowReasonForMode("acceptEdits", "Edit")).toContain("accept edits on");
    expect(autoAllowReasonForMode("acceptEdits", "MultiEdit")).toContain("accept edits on");
    expect(autoAllowReasonForMode("acceptEdits", "NotebookEdit")).toContain("accept edits on");
    expect(autoAllowReasonForMode("acceptEdits", "Bash")).toBeNull();
    expect(autoAllowReasonForMode("plan", "Bash")).toBeNull();
    expect(autoAllowReasonForMode("default", "Edit")).toBeNull();
    expect(autoAllowReasonForMode(null, "Bash")).toBeNull();
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
      engineRelaySocketPath: null,
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
      engineRelaySocketPath: null,
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
      engineRelaySocketPath: null,
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

  it("connect 不能 → engine relay socket へ remote_pending を best-effort 送出する", async () => {
    if (!(await canListenUnixSocket())) return;
    socketPath = tempSocketPath(`relay-target-${randomUUID().slice(0, 8)}`);
    const relayPath = tempSocketPath(`engine-relay-${randomUUID().slice(0, 8)}`);
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(relayPath, { force: true });
    const relay = await startListener(relayPath);
    try {
      const run = runHookCore({
        stdinData: bashPreToolUse("echo relay", "/work"),
        socketPath,
        deadlineSeconds: 0.4,
        session: "sess-relay",
        engineRelaySocketPath: relayPath,
        retryConnectIntervalSeconds: 0.05,
      });
      // PreToolUse はまず処理中ハートビート（session_processing）を relay へ送る（別接続）。
      const beatSocket = await relay.nextConnection();
      const beatLine = await new SocketLineReader(beatSocket).nextLine();
      expect(JSON.parse(beatLine)).toEqual({
        type: "session_processing",
        session: "sess-relay",
        state: "active",
      });
      const socket = await relay.nextConnection();
      const reader = new SocketLineReader(socket);
      const pending = decodeControlMessage(await reader.nextLine());
      const { stdout } = await run;

      expect(pending).toMatchObject({
        type: "remote_pending",
        session: "sess-relay",
        kind: "approval",
        tool: "Bash",
        summary: "echo relay",
      });
      expect(parseDecision(stdout).decision).toBe("deny");
    } finally {
      await relay.close();
      fs.rmSync(relayPath, { force: true });
    }
  });

  it("UserPromptSubmit は session_processing(active) を relay へ送り無出力で終了する", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath(`relay-life-a-${randomUUID().slice(0, 8)}`);
    fs.rmSync(relayPath, { force: true });
    const relay = await startListener(relayPath);
    try {
      const run = runHookCore({
        stdinData: Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1" })),
        socketPath: null,
        deadlineSeconds: 1,
        session: "sess-life",
        engineRelaySocketPath: relayPath,
      });
      const socket = await relay.nextConnection();
      const line = await new SocketLineReader(socket).nextLine();
      const { exitCode, stdout } = await run;

      expect(JSON.parse(line)).toEqual({
        type: "session_processing",
        session: "sess-life",
        state: "active",
      });
      expect(exitCode).toBe(0);
      // UserPromptSubmit の stdout はコンテキスト注入されるため必ず無出力。
      expect(stdout).toBe("");
    } finally {
      await relay.close();
      fs.rmSync(relayPath, { force: true });
    }
  });

  it("Stop は session_processing(done) を relay へ送り無出力で終了する", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath(`relay-life-b-${randomUUID().slice(0, 8)}`);
    fs.rmSync(relayPath, { force: true });
    const relay = await startListener(relayPath);
    try {
      const run = runHookCore({
        stdinData: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "s1" })),
        socketPath: null,
        deadlineSeconds: 1,
        session: "sess-life",
        engineRelaySocketPath: relayPath,
      });
      const socket = await relay.nextConnection();
      const line = await new SocketLineReader(socket).nextLine();
      const { exitCode, stdout } = await run;

      expect(JSON.parse(line)).toEqual({
        type: "session_processing",
        session: "sess-life",
        state: "done",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    } finally {
      await relay.close();
      fs.rmSync(relayPath, { force: true });
    }
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
      engineRelaySocketPath: null,
      retryConnectIntervalSeconds: 0.05,
    });
    const elapsed = (Date.now() - start) / 1000;

    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("deny");
    expect(elapsed).toBeGreaterThanOrEqual(0.4);
  });
});

describe("Hook — presence による背景 push 抑制", () => {
  async function runWithPresence(
    presenceProbe: (session: string) => Promise<"mac-attached" | "client-live" | null>,
  ) {
    const absentSocket = tempSocketPath(`presence-${randomUUID().slice(0, 8)}`);
    fs.rmSync(absentSocket, { force: true });
    const notifier = vi.fn(async () => {});
    const recordSkipped = vi.fn();
    const result = await runHookCore({
      stdinData: bashPreToolUse("rm -rf /tmp/example", "/work"),
      socketPath: absentSocket,
      deadlineSeconds: 0.05,
      session: "sess-presence",
      notifier,
      presenceProbe,
      pushObserver: { recordSkipped },
      engineRelaySocketPath: null,
      retryConnectIntervalSeconds: 0.01,
    });
    return { ...result, notifier, recordSkipped };
  }

  for (const reason of ["mac-attached", "client-live"] as const) {
    it(`${reason} なら push を抑制し pushSkipped を記録する`, async () => {
      const result = await runWithPresence(async () => reason);
      expect(result.notifier).not.toHaveBeenCalled();
      expect(result.recordSkipped).toHaveBeenCalledOnce();
      expect(result.recordSkipped).toHaveBeenCalledWith(expect.any(String), reason, "sess-presence");
      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout).decision).toBe("deny");
    });
  }

  it("不在なら従来どおり push を送る", async () => {
    const result = await runWithPresence(async () => null);
    expect(result.notifier).toHaveBeenCalledOnce();
    expect(result.recordSkipped).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(parseDecision(result.stdout).decision).toBe("deny");
  });

  it("presence 判定の例外は fail-open で push を送る", async () => {
    const result = await runWithPresence(async () => { throw new Error("probe failed"); });
    expect(result.notifier).toHaveBeenCalledOnce();
    expect(result.recordSkipped).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(parseDecision(result.stdout).decision).toBe("deny");
  });

  it("presence 判定の超過は500msで fail-open し push を送る", async () => {
    const startedAt = Date.now();
    const result = await runWithPresence(() => new Promise(() => {}));
    const elapsedMs = Date.now() - startedAt;
    expect(result.notifier).toHaveBeenCalledOnce();
    expect(result.recordSkipped).not.toHaveBeenCalled();
    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(elapsedMs).toBeLessThan(1500);
    expect(result.exitCode).toBe(0);
    expect(parseDecision(result.stdout).decision).toBe("deny");
  });
});

describe("removeCodexHookSettings", () => {
  it("Tailii の旧 Codex hook だけを全 event から除去し、無関係な hook を保持する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-remove-"));
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    const hooksPath = path.join(dir, ".codex", "hooks.json");
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        custom: { keep: true },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "/bin/pc hook --session old --agent codex" },
                { type: "command", command: "other.sh" },
              ],
            },
          ],
          Stop: [
            { hooks: [{ type: "command", command: "/bin/pc hook --agent codex" }] },
          ],
        },
      }),
    );

    removeCodexHookSettings({ dir, binaryPath: "/bin/pc" });

    const root = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    expect(root.custom).toEqual({ keep: true });
    expect(root.hooks.PreToolUse[0].hooks).toEqual([
      { type: "command", command: "other.sh" },
    ]);
    expect(root.hooks.Stop).toBeUndefined();
  });

  it("Tailii hook 以外に内容が無ければ hooks.json を削除する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-remove-empty-"));
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    const hooksPath = path.join(dir, ".codex", "hooks.json");
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "/bin/pc hook --agent codex" }] },
          ],
        },
      }),
    );

    removeCodexHookSettings({ dir, binaryPath: "/bin/pc" });

    expect(fs.existsSync(hooksPath)).toBe(false);
  });
});
