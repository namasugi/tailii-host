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

  it("git/file browser v1 golden 全行が byte-exact でラウンドトリップする", () => {
    for (const line of goldenLines("git-file-browser-v1.ndjson")) {
      const decoded = decodeControlMessage(line);
      expect(encodeControlMessage(decoded)).toBe(line);
    }
  });

  it("serve-list v1 golden 全行が byte-exact でラウンドトリップする", () => {
    for (const line of goldenLines("serve-list-v1.ndjson")) {
      const decoded = decodeControlMessage(line);
      expect(encodeControlMessage(decoded)).toBe(line);
    }
  });

  it("backend v1 golden 全行が byte-exact でラウンドトリップする", () => {
    for (const line of goldenLines("backend-v1.ndjson")) {
      const decoded = decodeControlMessage(line);
      expect(encodeControlMessage(decoded)).toBe(line);
    }
  });

  it("pane-choice v1 golden 全行が byte-exact でラウンドトリップする", () => {
    for (const line of goldenLines("pane-choice-v1.ndjson")) {
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

  it("preview_open は target 必須、preview_ready は url 必須", () => {
    expect(() => decodeControlMessage('{"id":"x","type":"preview_open","v":2}')).toThrow(
      ProtocolDecodeError,
    );
    expect(() => decodeControlMessage('{"id":"x","type":"preview_ready","v":2}')).toThrow(
      ProtocolDecodeError,
    );
    const open = decodeControlMessage(
      '{"id":"x","target":"/tmp/a.html","type":"preview_open","v":2}',
    );
    expect(open).toMatchObject({ type: "preview_open", target: "/tmp/a.html" });
  });

  it("v 欠落の preview 型は破棄される（v0 は承認 2 型のみ）", () => {
    expect(() => decodeControlMessage('{"id":"x","type":"preview_close"}')).toThrow(
      ProtocolDecodeError,
    );
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

  it("session_list_response は providerSessionId と agent を additive に復元する", () => {
    const decoded = decodeControlMessage(
      '{"id":"x","sessions":[{"agent":"codex","alive":true,"cwd":"/t","name":"n","providerSessionId":"thread-1"}],"type":"session_list_response","v":2}',
    );
    if (decoded.type !== "session_list_response") throw new Error("session_list_response を期待");
    expect(decoded.sessions[0]).toEqual({
      name: "n",
      cwd: "/t",
      alive: true,
      agent: "codex",
      providerSessionId: "thread-1",
    });
    expect(encodeControlMessage(decoded)).toContain('"providerSessionId":"thread-1"');
  });

  it("prepare 用の deferSubscribe と adoptedName を additive に復元する", () => {
    expect(decodeControlMessage(
      '{"type":"session_start","v":2,"id":"p","cwd":"/t","name":"n","resumeSessionId":"sid","deferSubscribe":true}',
    )).toMatchObject({ type: "session_start", deferSubscribe: true });
    expect(decodeControlMessage(
      '{"type":"session_list_response","v":2,"id":"p","sessions":[],"adoptedName":"s-live"}',
    )).toMatchObject({ type: "session_list_response", adoptedName: "s-live" });
  });

  it("session_start の model/permissionMode を復元する（permissionMode は既知4値のみ採用）", () => {
    const full = decodeControlMessage(
      '{"type":"session_start","v":2,"id":"x","cwd":"/t","name":"n","model":"opus","permissionMode":"acceptEdits"}',
    );
    expect(full).toMatchObject({
      type: "session_start",
      model: "opus",
      permissionMode: "acceptEdits",
    });
    // ラウンドトリップで保持される。
    expect(encodeControlMessage(full)).toContain('"model":"opus"');
    expect(encodeControlMessage(full)).toContain('"permissionMode":"acceptEdits"');
    // 未知モードは undefined（host 既定に委ねる）。
    const bad = decodeControlMessage(
      '{"type":"session_start","v":2,"id":"x","cwd":"/t","name":"n","permissionMode":"yolo"}',
    );
    expect((bad as { permissionMode?: string }).permissionMode).toBeUndefined();
    // 未指定はどちらも undefined。
    const none = decodeControlMessage('{"type":"session_start","v":2,"id":"x","cwd":"/t","name":"n"}');
    expect((none as { model?: string }).model).toBeUndefined();
    expect((none as { permissionMode?: string }).permissionMode).toBeUndefined();
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

  it("v1 session_chat_output のセッション情報と本文を復元する", () => {
    const line = goldenLines("approval-protocol-v1.ndjson").find((entry) =>
      entry.includes('"type":"session_chat_output"'),
    );
    expect(line).toBeDefined();
    const decoded = decodeControlMessage(line!);
    expect(decoded).toEqual({
      type: "session_chat_output",
      v: 1,
      session: "proj-bg",
      serverSeq: 42,
      streamId: "chat-bg-0001-0000-0000-000000000001",
      role: "assistant",
      text: "バックグラウンドで処理中",
      eof: false,
    });
  });

  it("v1 session_tool_activity の activity を flat wire から復元する", () => {
    const line = goldenLines("approval-protocol-v1.ndjson").find((entry) =>
      entry.includes('"type":"session_tool_activity"'),
    );
    expect(line).toBeDefined();
    const decoded = decodeControlMessage(line!);
    if (decoded.type !== "session_tool_activity") {
      throw new Error("session_tool_activity を期待");
    }
    expect(decoded.session).toBe("proj-bg");
    expect(decoded.serverSeq).toBe(43);
    expect(decoded.activity).toEqual({
      id: "tool-bg-0001-0000-0000-000000000001",
      name: "Edit",
      label: "編集済み Background.swift",
      file: "/Users/alice/project/Background.swift",
      addedLines: 2,
      removedLines: 1,
      commandTruncated: false,
      descriptionTruncated: false,
      diff: {
        oldString: "let value = 1",
        newString: "let value = 2",
        oldStringTruncated: false,
        newStringTruncated: false,
      },
    });
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

  it("subagent transcript entry の optional ts/kind を検証して復元する", () => {
    const decoded = decodeControlMessage(
      '{"entries":[{"kind":"tool_use","role":"tool","text":"Read: x","ts":1000},{"kind":"tool_use","role":"assistant","text":"ok","ts":"bad"}],"id":"tr","nodeId":"n","omitted":0,"type":"subagent_transcript_response","v":2}',
    );
    if (decoded.type !== "subagent_transcript_response") {
      throw new Error("subagent_transcript_response を期待");
    }
    expect(decoded.entries).toEqual([
      { role: "tool", text: "Read: x", ts: 1000, kind: "tool_use" },
      { role: "assistant", text: "ok" },
    ]);
  });

  it("v2 golden の codex_turn_interrupt を復元する", () => {
    const line = goldenLines("approval-protocol-v2.ndjson").find((entry) =>
      entry.includes('"type":"codex_turn_interrupt"')
    );
    expect(line).toBeDefined();
    expect(decodeControlMessage(line!)).toEqual({
      type: "codex_turn_interrupt",
      v: 2,
      id: "ci11aa22-0000-0000-0000-000000000901",
      session: "tailii-abc123",
    });
  });

  it("chat_send / chat_send_result を復元し、空本文を拒否する", () => {
    const lines = goldenLines("approval-protocol-v2.ndjson");
    const request = lines.find((entry) => entry.includes('"type":"chat_send"'));
    const result = lines.find((entry) => entry.includes('"type":"chat_send_result"'));
    expect(request).toBeDefined();
    expect(result).toBeDefined();
    expect(decodeControlMessage(request!)).toEqual({
      type: "chat_send", v: 2,
      id: "cs11aa22-0000-0000-0000-000000001002",
      session: "tailii-abc123",
      clientMessageId: "cs11aa22-0000-0000-0000-000000001001",
      text: "次の実装を進めてください。",
    });
    expect(decodeControlMessage(result!)).toEqual({
      type: "chat_send_result", v: 2,
      id: "cs11aa22-0000-0000-0000-000000001002", status: "accepted",
    });
    expect(() => decodeControlMessage(
      '{"clientMessageId":"c","id":"r","session":"s","text":"","type":"chat_send","v":2}',
    )).toThrow(ProtocolDecodeError);

    const explicitRetry = {
      type: "chat_send" as const, v: 2 as const, id: "retry", session: "s",
      clientMessageId: "c", text: "retry", explicitRetry: true,
    };
    expect(decodeControlMessage(encodeControlMessage(explicitRetry))).toEqual(explicitRetry);
    expect(decodeControlMessage(
      '{"clientMessageId":"c","explicitRetry":"yes","id":"r","session":"s","text":"x","type":"chat_send","v":2}',
    )).not.toHaveProperty("explicitRetry");
  });

  it("remote_pending / remote_pending_cleared を復元する", () => {
    expect(decodeControlMessage(
      '{"id":"a1","kind":"approval","session":"work","summary":"Run Bash","tool":"Bash","type":"remote_pending","v":1}',
    )).toEqual({
      type: "remote_pending",
      v: 1,
      id: "a1",
      session: "work",
      kind: "approval",
      tool: "Bash",
      summary: "Run Bash",
    });
    expect(decodeControlMessage(
      '{"id":"q1","kind":"question","session":"work","type":"remote_pending_cleared","v":1}',
    )).toEqual({
      type: "remote_pending_cleared",
      v: 1,
      id: "q1",
      session: "work",
      kind: "question",
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

  it("remote_pending / remote_pending_cleared を canonical key order でエンコードする", () => {
    expect(encodeControlMessage({
      type: "remote_pending",
      v: 1,
      id: "a1",
      session: "work",
      kind: "approval",
      tool: "Bash",
      summary: "Run Bash",
    })).toBe(
      '{"id":"a1","kind":"approval","session":"work","summary":"Run Bash","tool":"Bash","type":"remote_pending","v":1}',
    );
    expect(encodeControlMessage({
      type: "remote_pending_cleared",
      v: 1,
      id: "q1",
      session: "work",
      kind: "question",
    })).toBe(
      '{"id":"q1","kind":"question","session":"work","type":"remote_pending_cleared","v":1}',
    );
  });

  it("codex_turn_start は App Server thread への user input を往復する", () => {
    const wire = encodeControlMessage({
      type: "codex_turn_start",
      v: 2,
      id: "req-1",
      session: "codex-work",
      text: "テストを実行して",
      clientUserMessageId: "client-1",
      effort: "xhigh",
      approvalPolicy: "never",
    });
    expect(wire).toBe(
      '{"approvalPolicy":"never","clientUserMessageId":"client-1","effort":"xhigh","id":"req-1","session":"codex-work","text":"テストを実行して","type":"codex_turn_start","v":2}',
    );
    expect(decodeControlMessage(wire)).toEqual({
      type: "codex_turn_start",
      v: 2,
      id: "req-1",
      session: "codex-work",
      text: "テストを実行して",
      clientUserMessageId: "client-1",
      effort: "xhigh",
      approvalPolicy: "never",
    });

    const retryWire = encodeControlMessage({
      type: "codex_turn_start", v: 2, id: "retry", session: "codex-work", text: "retry",
      clientUserMessageId: "client-1", explicitRetry: true,
    });
    expect(decodeControlMessage(retryWire)).toMatchObject({
      type: "codex_turn_start", id: "retry", explicitRetry: true,
    });
  });

  it("codex_turn_interrupt は session を指定して往復する", () => {
    const wire = encodeControlMessage({
      type: "codex_turn_interrupt",
      v: 2,
      id: "interrupt-1",
      session: "codex-work",
    });
    expect(wire).toBe(
      '{"id":"interrupt-1","session":"codex-work","type":"codex_turn_interrupt","v":2}',
    );
    expect(decodeControlMessage(wire)).toEqual({
      type: "codex_turn_interrupt",
      v: 2,
      id: "interrupt-1",
      session: "codex-work",
    });
  });

  it("codex_turn_start_result は相関 id と送達結果を往復する", () => {
    const wire = encodeControlMessage({
      type: "codex_turn_start_result", v: 2, id: "turn-ack-1",
      status: "failed", error: "hub timeout",
    });
    expect(wire).toBe(
      '{"error":"hub timeout","id":"turn-ack-1","status":"failed","type":"codex_turn_start_result","v":2}',
    );
    expect(decodeControlMessage(wire)).toEqual({
      type: "codex_turn_start_result", v: 2, id: "turn-ack-1",
      status: "failed", error: "hub timeout",
    });
  });

  it("codex_model_list は App Server 由来のモデル別 context を往復する", () => {
    const request = encodeControlMessage({
      type: "codex_model_list_request",
      v: 2,
      id: "models-1",
    });
    expect(request).toBe('{"id":"models-1","type":"codex_model_list_request","v":2}');
    expect(decodeControlMessage(request)).toEqual({
      type: "codex_model_list_request",
      v: 2,
      id: "models-1",
    });

    const response = encodeControlMessage({
      type: "codex_model_list_response",
      v: 2,
      id: "models-1",
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Latest frontier agentic coding model.",
          contextWindow: 353_400,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
          isDefault: true,
        },
        {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Frontier coding model.",
          isDefault: false,
        },
      ],
    });
    expect(response).toBe(
      '{"id":"models-1","models":[{"contextWindow":353400,"defaultReasoningEffort":"medium","description":"Latest frontier agentic coding model.","displayName":"GPT-5.6-Sol","id":"gpt-5.6-sol","isDefault":true,"supportedReasoningEfforts":["low","medium","high","xhigh","ultra"]},{"description":"Frontier coding model.","displayName":"GPT-5.6-Terra","id":"gpt-5.6-terra","isDefault":false}],"type":"codex_model_list_response","v":2}',
    );
    expect(decodeControlMessage(response)).toEqual({
      type: "codex_model_list_response",
      v: 2,
      id: "models-1",
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Latest frontier agentic coding model.",
          contextWindow: 353_400,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
          isDefault: true,
        },
        {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Frontier coding model.",
          isDefault: false,
        },
      ],
    });
  });
});
