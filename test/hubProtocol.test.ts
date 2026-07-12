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
