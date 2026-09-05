// codexSystemNotice.test.ts — Codex の error / warning を system 注記へ正規化する純ロジック。

import { describe, expect, test } from "vitest";
import {
  codexAppServerSystemNotice,
  codexMcpItemErrorNotice,
  codexRolloutSystemNotice,
  codexSystemNoticeContentKey,
} from "../src/codex/codexSystemNotice.js";

describe("codexSystemNotice", () => {
  test("live / rollout の同じ MCP 失敗を同じ streamId と本文へ正規化する", () => {
    const live = codexMcpItemErrorNotice({
      type: "mcpToolCall",
      id: "call-1",
      server: "drive",
      tool: "search",
      status: "failed",
      error: { message: "permission denied" },
    });
    const rollout = codexRolloutSystemNotice({
      type: "mcp_tool_call_end",
      call_id: "call-1",
      invocation: { server: "drive", tool: "search", arguments: {} },
      result: { Err: "permission denied" },
    });

    expect(live).not.toBeNull();
    expect(rollout).not.toBeNull();
    expect(live?.itemId).toBe("call-1");
    expect(rollout?.itemId).toBe("call-1");
    expect(live?.payload).toEqual(rollout?.payload);
    expect(live?.payload).toMatchObject({
      role: "system",
      text: "❌ MCP「drive / search」エラー: permission denied",
      eof: true,
    });
    expect(codexSystemNoticeContentKey(live!.payload)).toBe(
      "system\u0000❌ MCP「drive / search」エラー: permission denied",
    );
  });

  test("MCP の isError content を表示し、成功は表示しない", () => {
    const failed = codexRolloutSystemNotice({
      type: "mcp_tool_call_end",
      call_id: "call-2",
      invocation: { server: "calendar", tool: "create" },
      result: { Ok: { isError: true, content: [{ type: "text", text: "invalid date" }] } },
    });
    const succeeded = codexRolloutSystemNotice({
      type: "mcp_tool_call_end",
      call_id: "call-3",
      invocation: { server: "calendar", tool: "list" },
      result: { Ok: { isError: false, content: [{ type: "text", text: "ok" }] } },
    });

    expect(failed?.payload.text).toBe("❌ MCP「calendar / create」エラー: invalid date");
    expect(succeeded).toBeNull();
    expect(codexMcpItemErrorNotice({
      type: "mcpToolCall", id: "call-4", server: "x", tool: "y", status: "completed",
      error: null,
    })).toBeNull();
  });

  test("App Server のターンエラー、警告、MCP 起動失敗を注記にする", () => {
    expect(codexAppServerSystemNotice("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: { message: "connection lost", additionalDetails: null },
    })?.payload.text).toBe("⚠️ Codex エラー（自動再試行中）: connection lost");

    expect(codexAppServerSystemNotice("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", error: { message: "retry exhausted" } },
    })?.payload.text).toBe("❌ Codex エラー: retry exhausted");

    expect(codexAppServerSystemNotice("warning", {
      threadId: "thread-1", message: "context is nearly full",
    })?.payload.text).toBe("⚠️ Codex 警告: context is nearly full");

    expect(codexAppServerSystemNotice("mcpServer/startupStatus/updated", {
      threadId: "thread-1", name: "notion", status: "failed", error: "handshake failed",
      failureReason: null,
    })?.payload.text).toBe("❌ MCP サーバー「notion」の起動に失敗しました: handshake failed");
  });

  test("同じ stream error の自動再試行は同じ streamId へ畳み、上限到達は別注記にする", () => {
    const retry1 = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "gateway timeout",
      retry_attempt: 1, max_retries: 3,
    });
    const retry2 = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "gateway timeout",
      retry_attempt: 2, max_retries: 3,
    });
    const terminal = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "gateway timeout",
      retry_attempt: 3, max_retries: 3,
    });

    expect(retry1?.payload.streamId).toBe(retry2?.payload.streamId);
    expect(retry1?.payload.streamId).not.toBe(terminal?.payload.streamId);
    expect(terminal?.payload.text).toBe("❌ Codex エラー: gateway timeout");
  });

  test("長い詳細は改行を畳んで上限で切る", () => {
    const notice = codexAppServerSystemNotice("warning", {
      message: "first\n" + "x".repeat(500),
    });
    expect(notice?.payload.text).not.toContain("\n");
    expect(notice?.payload.text).toContain("…");
    expect([...(notice?.payload.text ?? "")].length).toBeLessThan(280);
  });
});
