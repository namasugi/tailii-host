import { describe, expect, test } from "vitest";
import {
  decodeHubClientLine,
  decodeHubServerLine,
  encodeHubMessage,
  type HubClientMessage,
  type HubServerMessage,
} from "../src/hubProtocol.js";

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
