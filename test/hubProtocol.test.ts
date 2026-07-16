import { describe, expect, test } from "vitest";
import {
  decodeHubClientLine,
  decodeHubServerLine,
  encodeHubMessage,
  type HubClientMessage,
  type HubServerMessage,
} from "../src/hubProtocol.js";

describe("hubProtocol hello compatibility", () => {
  test("旧 Hub の hello ack は snapshot 非対応として空 snapshot と区別する", () => {
    expect(decodeHubServerLine(JSON.stringify({
      type: "hub_hello_ack", version: "1.0.0", bootId: "old-hub",
    }))).toEqual({
      type: "hub_hello_ack", version: "1.0.0", bootId: "old-hub",
    });
    expect(decodeHubServerLine(JSON.stringify({
      type: "hub_hello_ack", version: "1.1.0", bootId: "new-hub", processingSessions: [],
    }))).toEqual({
      type: "hub_hello_ack", version: "1.1.0", bootId: "new-hub", processingSessions: [],
    });
  });

  test("hello ack の processingSessions は不正要素だけを除外してhandshakeを維持する", () => {
    expect(decodeHubServerLine(JSON.stringify({
      type: "hub_hello_ack", version: "1.2.0", bootId: "mixed-hub",
      processingSessions: ["work", "", 42, "other"],
    }))).toEqual({
      type: "hub_hello_ack", version: "1.2.0", bootId: "mixed-hub",
      processingSessions: ["work", "other"],
    });
  });
});

describe("hubProtocol session lifecycle", () => {
  test("session_retire を往復し空セッション名を拒否する", () => {
    const message: HubClientMessage = { type: "session_retire", session: "work" };
    expect(decodeHubClientLine(encodeHubMessage(message))).toEqual(message);
    expect(decodeHubClientLine('{"type":"session_retire","session":""}')).toBeNull();
  });
});

describe("hubProtocol presence RPC", () => {
  test("presence_request を encode/decode 往復する", () => {
    const message: HubClientMessage = { type: "presence_request", id: "req-1", session: "work" };
    expect(decodeHubClientLine(encodeHubMessage(message))).toEqual(message);
  });

  test("presence_response を encode/decode 往復する", () => {
    const message: HubServerMessage = {
      type: "presence_response", id: "req-1", session: "work", subscriberCount: 2,
    };
    expect(decodeHubServerLine(encodeHubMessage(message))).toEqual(message);
  });

  test("presence RPC の空文字・負数・小数を拒否する", () => {
    expect(decodeHubClientLine('{"type":"presence_request","id":"","session":"work"}')).toBeNull();
    expect(decodeHubServerLine(
      '{"type":"presence_response","id":"x","session":"work","subscriberCount":-1}',
    )).toBeNull();
    expect(decodeHubServerLine(
      '{"type":"presence_response","id":"x","session":"work","subscriberCount":1.5}',
    )).toBeNull();
  });
});

describe("hubProtocol durable send retry", () => {
  test("chat / Codex の explicitRetry を往復し、boolean 以外は拒否する", () => {
    const chat: HubClientMessage = {
      type: "chat_send", id: "chat", session: "work", clientMessageId: "client-chat",
      text: "retry", explicitRetry: true,
    };
    const codex: HubClientMessage = {
      type: "codex_turn_submit", id: "codex", session: "work", clientUserMessageId: "client-codex",
      text: "retry", effort: null, approvalPolicy: null, sandbox: null,
      threadId: "thread", cwd: "/tmp/work",
      explicitRetry: true,
    };
    expect(decodeHubClientLine(encodeHubMessage(chat))).toEqual(chat);
    expect(decodeHubClientLine(encodeHubMessage(codex))).toEqual(codex);
    expect(decodeHubClientLine(JSON.stringify({ ...chat, explicitRetry: "yes" }))).toBeNull();
    expect(decodeHubClientLine(JSON.stringify({ ...codex, explicitRetry: 1 }))).toBeNull();
  });
});

describe("hubProtocol subagent transcript RPC", () => {
  test("request/response を encode/decode 往復する", () => {
    const request: HubClientMessage = {
      type: "conversation_subagent_transcript_request",
      id: "transcript-1",
      session: "work",
      nodeId: "agent-a",
    };
    expect(decodeHubClientLine(encodeHubMessage(request))).toEqual(request);

    const response: HubServerMessage = {
      type: "conversation_subagent_transcript_response",
      id: "transcript-1",
      session: "work",
      payload: {
        type: "subagent_transcript_response",
        v: 2,
        id: "transcript-1",
        nodeId: "agent-a",
        entries: [{ role: "assistant", text: "調査結果", ts: 1_000 }],
        omitted: 0,
      },
    };
    expect(decodeHubServerLine(encodeHubMessage(response))).toEqual(response);
  });

  test("空の識別子と不正な transcript payload を拒否する", () => {
    expect(decodeHubClientLine(JSON.stringify({
      type: "conversation_subagent_transcript_request",
      id: "",
      session: "work",
      nodeId: "agent-a",
    }))).toBeNull();
    expect(decodeHubServerLine(JSON.stringify({
      type: "conversation_subagent_transcript_response",
      session: "work",
      payload: { type: "chat_output", v: 1 },
    }))).toBeNull();
  });
});

describe("hubProtocol conversation event", () => {
  test("tool_activity payload を flat wire で encode し activity として復元する", () => {
    const message: HubServerMessage = {
      type: "conversation_event",
      session: "background-work",
      serverSeq: 7,
      payload: {
        type: "tool_activity",
        v: 2,
        activity: {
          id: "tool-1",
          name: "Bash",
          label: "テストを実行",
          command: "npm test",
          commandTruncated: false,
          description: "回帰テスト",
          descriptionTruncated: false,
        },
      },
    };
    const encoded = encodeHubMessage(message);
    expect(JSON.parse(encoded)).toMatchObject({
      payload: { type: "tool_activity", id: "tool-1", name: "Bash", label: "テストを実行" },
    });
    expect(JSON.parse(encoded).payload).not.toHaveProperty("activity");
    expect(decodeHubServerLine(encoded)).toEqual(message);
  });

  test("旧 Hub の nested tool_activity payload も復元する", () => {
    expect(decodeHubServerLine(JSON.stringify({
      type: "conversation_event",
      session: "background-work",
      serverSeq: 8,
      payload: {
        type: "tool_activity",
        v: 2,
        activity: {
          id: "legacy-tool",
          name: "Edit",
          label: "旧 Hub からの編集",
          file: "/tmp/Legacy.swift",
        },
      },
    }))).toEqual({
      type: "conversation_event",
      session: "background-work",
      serverSeq: 8,
      payload: {
        type: "tool_activity",
        v: 2,
        activity: {
          id: "legacy-tool",
          name: "Edit",
          label: "旧 Hub からの編集",
          file: "/tmp/Legacy.swift",
          commandTruncated: false,
          descriptionTruncated: false,
        },
      },
    });
  });

  test("旧 Hub の nested subagent_node payload も復元する", () => {
    expect(decodeHubServerLine(JSON.stringify({
      type: "conversation_event",
      session: "work",
      serverSeq: 9,
      payload: {
        type: "subagent_node",
        v: 2,
        node: {
          nodeId: "agent-1",
          toolUseId: "tool-use-1",
          parentNodeId: null,
          agentType: "Explore",
          label: "調査中",
          depth: 1,
          status: "running",
          currentActivity: "コードを検索",
          ts: 1_000,
        },
      },
    }))).toEqual({
      type: "conversation_event",
      session: "work",
      serverSeq: 9,
      payload: {
        type: "subagent_node",
        v: 2,
        node: {
          nodeId: "agent-1",
          toolUseId: "tool-use-1",
          parentNodeId: null,
          agentType: "Explore",
          label: "調査中",
          depth: 1,
          status: "running",
          currentActivity: "コードを検索",
          ts: 1_000,
        },
      },
    });
  });
});
