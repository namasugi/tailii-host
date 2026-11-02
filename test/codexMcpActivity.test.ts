import { describe, expect, test } from "vitest";
import { codexMcpItemActivity, codexRolloutMcpActivity } from "../src/codex/codexMcpActivity.js";
import { toolActivityContentKey } from "../src/codex/codexToolActivity.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";

const invocation = { server: "logic_pro", tool: "logic_transport", arguments: { command: "goto_position" } };

function live(result: unknown, extra: Record<string, unknown> = {}) {
  return codexMcpItemActivity({ type: "mcpToolCall", id: "call-1", ...invocation,
    status: "failed", error: null, result, ...extra });
}

describe("Codex MCP 操作カード", () => {
  test.each(["structured", "text", "snake"])("成功・検証未完了をエラーにせず、live / rollout を揃える（%s）", (format) => {
    // 実測: goto_position が success:true / verified:false でも上位 status は failed。
    const body = { success: true, verified: false, reason: "readback_unavailable", observed: "18.1" };
    const result = { content: [{ type: "text", text: JSON.stringify(body) }],
      ...(format === "structured" ? { structuredContent: body } : format === "snake" ? { structured_content: body } : {}) };
    const activity = live(result);
    const replay = codexRolloutMcpActivity({ type: "mcp_tool_call_end", call_id: "call-1", invocation,
      result: { Ok: { ...result, isError: true } } });
    expect(activity).toMatchObject({ name: "MCP", id: "mcp-call-1", outcome: "unverified",
      label: "logic_pro / logic_transport · goto_position", description: "readback_unavailable" });
    expect(replay).toEqual(activity);
    expect(toolActivityContentKey(activity!)).toBe(toolActivityContentKey(replay!));
  });

  test("操作の拒否は具体的な理由を表示する", () => {
    const body = { success: false, error: "index_binding_corroboration_required", hint: "supply expected_name or target_ref" };
    const activity = live({ structuredContent: body });
    expect(activity).toMatchObject({ outcome: "failed",
      description: "index_binding_corroboration_required — supply expected_name or target_ref" });
    expect(live({ content: [{ type: "text", text: JSON.stringify(body) }] })).toEqual(activity);
  });

  test("成功フラグで通信エラーや明示された操作失敗を隠さない", () => {
    const result = { structuredContent: { success: true, verified: false } };
    expect(live(result, { error: { message: "connection lost" } }))
      .toMatchObject({ outcome: "connection_failed", description: "connection lost" });
    expect(codexRolloutMcpActivity({ type: "mcp_tool_call_end", call_id: "call-1", invocation,
      result: { Err: "connection lost", Ok: result } })).toEqual(live(result, { error: { message: "connection lost" } }));
    expect(live({ structuredContent: { success: true, error: { message: "partial failure" } } }))
      .toMatchObject({ outcome: "failed", description: "partial failure" });
    expect(live({ structuredContent: { success: false, error: "bad request" } }))
      .toMatchObject({ outcome: "failed", description: "bad request" });
    expect(live(null)).toMatchObject({ outcome: "failed" });
    expect(live({ content: [{ type: "text", text: '{"previous":{"success":true},"message":"failed now"}' }] }))
      .toMatchObject({ outcome: "failed", description: "failed now" });
  });

  test("通常の成功は実行済みカード、未完了や未知の result は流さない", () => {
    expect(live({ content: [{ type: "text", text: "ok" }] }, { status: "completed" })).toMatchObject({ outcome: "completed" });
    expect(live({ structuredContent: { success: true, verified: true } }, { status: "completed" }))
      .toMatchObject({ outcome: "completed" });
    expect(live(null, { status: "inProgress" })).toBeNull();
    expect(codexRolloutMcpActivity({ type: "mcp_tool_call_end", call_id: "x", result: {} })).toBeNull();
  });

  test("成功した MCP 呼び出しの任意データを失敗フラグとして解釈しない", () => {
    for (const body of [{ error: 0, count: 12 }, { success: false, message: "検索対象の記録" }]) {
      expect(live({ structuredContent: body }, { status: "completed" })).toMatchObject({ outcome: "completed" });
      expect(codexRolloutMcpActivity({ type: "mcp_tool_call_end", call_id: "call-1", invocation,
        result: { Ok: { isError: false, structuredContent: body } } })).toMatchObject({ outcome: "completed" });
    }
  });

  test("本文の success だけでは MCP が明示した失敗を成功に変えない", () => {
    for (const body of [{ success: true }, { success: true, verified: true }]) {
      expect(live({ structuredContent: body })).toMatchObject({ outcome: "failed" });
      expect(codexRolloutMcpActivity({ type: "mcp_tool_call_end", call_id: "call-1", invocation,
        result: { Ok: { isError: true, structuredContent: body } } })).toMatchObject({ outcome: "failed" });
    }
    expect(live({ isError: true, content: [{ type: "text", text: "partial failure" }] }, { status: "completed" }))
      .toMatchObject({ outcome: "failed", description: "partial failure" });
  });

  test("状態値の配列・オブジェクト・未知値を文字列へ暗黙変換しない", () => {
    for (const outcome of [["failed"], {}, 0, false, "future-status"]) {
      const decoded = decodeControlMessage(JSON.stringify({ type: "tool_activity", v: 1,
        id: "mcp-1", name: "MCP", label: "server / tool", outcome }));
      expect(decoded).toMatchObject({ type: "tool_activity", activity: { name: "MCP" } });
      if (decoded.type !== "tool_activity") throw new Error("tool_activity expected");
      expect(decoded.activity.outcome).toBeUndefined();
    }
  });

  test("同じ呼び出しは引数のキー順で二重表示せず、別の呼び出しは区別する", () => {
    const first = live(null, { arguments: { command: "play", params: { a: 1, b: 2 } } })!;
    const reordered = live(null, { arguments: { params: { b: 2, a: 1 }, command: "play" } })!;
    expect(toolActivityContentKey(first)).toBe(toolActivityContentKey(reordered));
    expect(toolActivityContentKey(first)).not.toBe(toolActivityContentKey({ ...first, id: "mcp-other-call" }));
  });

  test("長い入力と応答を制限し、ワイヤー往復で状態を保持する", () => {
    const activity = live({ content: [{ type: "text", text: "x".repeat(9000) }] }, { arguments: { data: "y".repeat(9000) } })!;
    expect(activity.description).toHaveLength(8000);
    expect(activity.command).toHaveLength(8000);
    expect(activity.descriptionTruncated).toBe(true);
    expect(activity.commandTruncated).toBe(true);
    for (const message of [{ type: "tool_activity", v: 1, activity } as const,
      { type: "session_tool_activity", v: 1, session: "test", serverSeq: 3, activity } as const]) {
      expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
    }
  });
});
