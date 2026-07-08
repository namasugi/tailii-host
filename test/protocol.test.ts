// protocol.test.ts — golden フィクスチャの byte-exact ラウンドトリップ（移植の受け入れ網）
//
// 同梱の protocol/approval-protocol-{v0,v1}.ndjson を読み込み、
// TS codec が Swift 版と同一バイト列で encode/decode できることを検証する。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  decodeControlMessage,
  encodeControlMessage,
  ProtocolDecodeError,
  PROTOCOL_LEGACY,
} from "../src/protocol.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function goldenLines(name: string): string[] {
  return readFileSync(join(repoRoot, "protocol", name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("golden roundtrip", () => {
  it("v1 golden 全行が byte-exact でラウンドトリップする", () => {
    for (const line of goldenLines("approval-protocol-v1.ndjson")) {
      const decoded = decodeControlMessage(line);
      expect(encodeControlMessage(decoded)).toBe(line);
    }
  });

  it("v2 golden 全行が byte-exact でラウンドトリップする", () => {
    for (const line of goldenLines("approval-protocol-v2.ndjson")) {
      const decoded = decodeControlMessage(line);
      expect(encodeControlMessage(decoded)).toBe(line);
    }
  });

  it("v0 golden 全行が byte-exact でラウンドトリップする（v 欠落 = v0 互換）", () => {
    for (const line of goldenLines("approval-protocol-v0.ndjson")) {
      const decoded = decodeControlMessage(line);
      expect(decoded.v).toBe(PROTOCOL_LEGACY);
      expect(encodeControlMessage(decoded)).toBe(line);
    }
  });
});

describe("decode 詳細", () => {
  it("v 欠落のセッション制御型は破棄される（v0 は承認 2 型のみ）", () => {
    expect(() => decodeControlMessage('{"id":"x","type":"session_list_request"}')).toThrow(
      ProtocolDecodeError,
    );
  });

  it("未知 type は破棄される", () => {
    expect(() => decodeControlMessage('{"type":"nope","v":1}')).toThrow(ProtocolDecodeError);
  });

  it("不正 JSON は破棄される", () => {
    expect(() => decodeControlMessage("not json")).toThrow(ProtocolDecodeError);
  });

  it("session_start の agentType は codex/claude のみ採用、未知/未指定は undefined", () => {
    const codex = decodeControlMessage(
      '{"type":"session_start","v":1,"id":"x","cwd":"/t","name":"n","agentType":"codex"}',
    );
    expect(codex).toMatchObject({ type: "session_start", agentType: "codex" });
    const bad = decodeControlMessage(
      '{"type":"session_start","v":1,"id":"x","cwd":"/t","name":"n","agentType":"gpt"}',
    );
    expect((bad as { agentType?: string }).agentType).toBeUndefined();
    const none = decodeControlMessage('{"type":"session_start","v":1,"id":"x","cwd":"/t","name":"n"}');
    expect((none as { agentType?: string }).agentType).toBeUndefined();
    // 採用時はラウンドトリップで agentType が保持される。
    expect(encodeControlMessage(codex)).toContain('"agentType":"codex"');
  });

  it("v1 tool_activity(TodoWrite) の todos を復元する", () => {
    const lines = goldenLines("approval-protocol-v1.ndjson");
    const todoLine = lines.find((line) => line.includes('"name":"TodoWrite"'));
    expect(todoLine).toBeDefined();
    const decoded = decodeControlMessage(todoLine!);
    if (decoded.type !== "tool_activity") throw new Error("tool_activity を期待");
    expect(decoded.activity.label).toBe("Todoを更新しました");
    expect(decoded.activity.todos).toEqual([
      { content: "実装する", status: "completed" },
      { content: "テストする", status: "in_progress" },
      { content: "デプロイする", status: "pending" },
    ]);
  });

  it("v1 question_answer の multiSelect 欠落は false として復元する（additive 互換）", () => {
    const legacyAnswer =
      '{"answers":[{"questionIndex":0,"selectedOptionIndexes":[1]}],"id":"q1","session":"s","type":"question_answer","v":1}';
    const decoded = decodeControlMessage(legacyAnswer);
    if (decoded.type !== "question_answer") throw new Error("question_answer を期待");
    expect(decoded.answers[0]?.multiSelect).toBe(false);
  });

  it("v1 slash_list_request/response を復元する", () => {
    const request = decodeControlMessage(
      '{"cwd":"/tmp/proj","id":"sl1","type":"slash_list_request","v":1}',
    );
    expect(request).toEqual({ type: "slash_list_request", v: 1, id: "sl1", cwd: "/tmp/proj" });

    const response = decodeControlMessage(
      '{"commands":[{"name":"/code-review","summary":"レビュー"}],"id":"sl1","type":"slash_list_response","v":1}',
    );
    expect(response).toEqual({
      type: "slash_list_response",
      v: 1,
      id: "sl1",
      commands: [{ name: "/code-review", summary: "レビュー" }],
    });
  });

  it("v2 session_search_request/response を復元する", () => {
    const lines = goldenLines("approval-protocol-v2.ndjson");
    const requestLine = lines.find((line) => line.includes('"type":"session_search_request"'));
    const responseLine = lines.find((line) => line.includes('"type":"session_search_response"'));
    expect(requestLine).toBeDefined();
    expect(responseLine).toBeDefined();

    const request = decodeControlMessage(requestLine!);
    expect(request).toEqual({
      type: "session_search_request",
      v: 2,
      id: "ss11aa22-0000-0000-0000-000000000401",
      query: "approval",
      limit: 2,
    });

    const response = decodeControlMessage(responseLine!);
    if (response.type !== "session_search_response") throw new Error("session_search_response を期待");
    expect(response.results[0]).toMatchObject({
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/Users/alice/project",
      title: "Search implementation",
      updatedAt: 1720100000,
    });
  });

  it("v2 subagent_node を復元する", () => {
    const line = goldenLines("approval-protocol-v2.ndjson").find((entry) =>
      entry.includes('"type":"subagent_node"') && entry.includes('"status":"running"')
    );
    expect(line).toBeDefined();
    const decoded = decodeControlMessage(line!);
    if (decoded.type !== "subagent_node") throw new Error("subagent_node を期待");
    expect(decoded.node).toMatchObject({
      nodeId: "a64248450ea4d7cec",
      toolUseId: "toolu_011oYuCoC9Uunee5rACf28de",
      parentNodeId: "root",
      agentType: "general-purpose",
      label: "Search food mechanics specs",
      depth: 1,
      status: "running",
      ts: 1783016361453,
    });
  });
});

describe("encode 詳細", () => {
  it("v=0 のメッセージは v フィールドを出力しない（v0 バイト互換）", () => {
    const encoded = encodeControlMessage({
      type: "approval_decision",
      v: PROTOCOL_LEGACY,
      id: "x",
      decision: "allow",
    });
    expect(encoded).not.toContain('"v"');
  });

  it("スラッシュと Unicode をエスケープしない（Swift .withoutEscapingSlashes 相当）", () => {
    const encoded = encodeControlMessage({
      type: "chat_output",
      v: 1,
      streamId: "s",
      role: "assistant",
      text: "パス /tmp/a を編集",
      eof: true,
    });
    expect(encoded).toContain("/tmp/a");
    expect(encoded).toContain("パス");
  });

  it("slash_list_request/response を canonical key order でエンコードする", () => {
    expect(
      encodeControlMessage({ type: "slash_list_request", v: 1, id: "sl1", cwd: "/tmp/proj" }),
    ).toBe('{"cwd":"/tmp/proj","id":"sl1","type":"slash_list_request","v":1}');
    expect(
      encodeControlMessage({
        type: "slash_list_response",
        v: 1,
        id: "sl1",
        commands: [{ name: "/code-review", summary: "レビュー" }],
      }),
    ).toBe(
      '{"commands":[{"name":"/code-review","summary":"レビュー"}],"id":"sl1","type":"slash_list_response","v":1}',
    );
  });

  it("subagent_node は v2 と canonical key order でエンコードする", () => {
    expect(
      encodeControlMessage({
        type: "subagent_node",
        v: 2,
        node: {
          nodeId: "agent-a",
          toolUseId: "toolu-a",
          parentNodeId: null,
          agentType: "general-purpose",
          label: "調査",
          depth: 1,
          status: "running",
          ts: 1000,
        },
      }),
    ).toBe(
      '{"agentType":"general-purpose","depth":1,"label":"調査","nodeId":"agent-a","parentNodeId":null,"status":"running","toolUseId":"toolu-a","ts":1000,"type":"subagent_node","v":2}',
    );
  });

  it("session_search_request/response は v2 と canonical key order でエンコードする", () => {
    expect(
      encodeControlMessage({
        type: "session_search_request",
        v: 2,
        id: "ss1",
        query: "approval",
        limit: 2,
      }),
    ).toBe('{"id":"ss1","limit":2,"query":"approval","type":"session_search_request","v":2}');
    expect(
      encodeControlMessage({
        type: "session_search_response",
        v: 2,
        id: "ss1",
        results: [
          {
            sessionId: "s1",
            title: "Title",
            cwd: "/tmp/proj",
            snippet: "...approval...",
            updatedAt: 10,
          },
        ],
      }),
    ).toBe(
      '{"id":"ss1","results":[{"cwd":"/tmp/proj","sessionId":"s1","snippet":"...approval...","title":"Title","updatedAt":10}],"type":"session_search_response","v":2}',
    );
  });

  it("channel_hello の serverVersion は optional で canonical key order に従う", () => {
    expect(
      encodeControlMessage({
        type: "channel_hello",
        v: 2,
        maxVersion: 2,
        serverVersion: "0.1.0",
      }),
    ).toBe('{"maxVersion":2,"serverVersion":"0.1.0","type":"channel_hello","v":2}');
    expect(
      decodeControlMessage('{"maxVersion":2,"serverVersion":"0.1.0","type":"channel_hello","v":2}'),
    ).toEqual({ type: "channel_hello", v: 2, maxVersion: 2, serverVersion: "0.1.0" });
    expect(
      encodeControlMessage({ type: "channel_hello", v: 2, maxVersion: 2 }),
    ).toBe('{"maxVersion":2,"type":"channel_hello","v":2}');
  });
});
