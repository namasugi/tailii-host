// chatDeliveryLog.test.ts — hub が届けた発話の記録（追記だけで消さない, chatDeliveryLog.ts）

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  appendChatDelivery,
  normalizeUtteranceForMatch,
  parseChatDeliveryLine,
  utteranceDigest,
  type ChatDeliveryRecord,
} from "../src/hub/chatDeliveryLog.js";
import { decodeHubServerLine } from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import type { CodexTurnControllerRuntime } from "../src/codex/codexNativeTurnController.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const readRecords = (file: string): ChatDeliveryRecord[] =>
  fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).map((line) => parseChatDeliveryLine(line)!);

describe("chatDeliveryLog", () => {
  test("追記だけで足していき、置き場が無ければ作る（自分だけが読める）", () => {
    const file = path.join(makeTempDir("chat-delivery"), "hub", "chat-deliveries.ndjson");
    const first: ChatDeliveryRecord = { v: 1, atMs: 10, session: "s-a", conversationId: "conv-1", agent: "claude", clientMessageId: "A1", textHash: utteranceDigest("一つ目") };
    const second: ChatDeliveryRecord = { v: 1, atMs: 20, session: "s-b", agent: "codex", clientMessageId: "cli-0123456789abcdef01234567", textHash: utteranceDigest("二つ目") };
    appendChatDelivery(file, first);
    appendChatDelivery(file, second);
    expect(readRecords(file)).toEqual([first, second]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  test("形の違う行は読まない", () => {
    expect(parseChatDeliveryLine("{壊れ")).toBeNull();
    expect(parseChatDeliveryLine("null")).toBeNull();
    expect(parseChatDeliveryLine(JSON.stringify({ v: 2, atMs: 1, session: "s", agent: "claude", clientMessageId: "A", textHash: "h" }))).toBeNull();
    expect(parseChatDeliveryLine(JSON.stringify({ v: 1, atMs: 1, session: "s", agent: "gemini", clientMessageId: "A", textHash: "h" }))).toBeNull();
    expect(parseChatDeliveryLine(JSON.stringify({ v: 1, atMs: 1, session: "s", agent: "claude", clientMessageId: "A", textHash: "h", conversationId: "" })))
      .toEqual({ v: 1, atMs: 1, session: "s", agent: "claude", clientMessageId: "A", textHash: "h" });
  });

  test("本文のハッシュは、送った本文と会話の記録に残る本文（不可視文字・空白・貼り付けの包みの違い）で同じになる", () => {
    const sent = "設定を  直して​\nください";
    const recorded = "\n\n<pasted_content id=\"0baf\">\n設定を 直して\nください\n</pasted_content id=\"0baf\">\n";
    expect(normalizeUtteranceForMatch(sent)).toBe("設定を直してください");
    expect(utteranceDigest(sent)).toBe(utteranceDigest(recorded));
    expect(utteranceDigest(sent)).toMatch(/^[0-9a-f]{32}$/);
    expect(utteranceDigest(sent)).not.toBe(utteranceDigest("設定を直さないでください"));
  });
});

describe("SessionHub: 届けた発話の記録", () => {
  test("Claude への送信は、打ち込みが済んだ時点で 1 行追記する（会話 ID・送信 ID・本文のハッシュ。本文そのものは残さない）", async () => {
    const logPath = path.join(makeTempDir("hub-delivery"), "chat-deliveries.ndjson");
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp", createdAt: 1, claudeSessionId: "conv-1", providerSessionId: "conv-1" });
    const releases: Array<() => void> = [];
    const chatInjector = vi.fn(async () => { await new Promise<void>((resolve) => releases.push(resolve)); });
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-delivery-hb"),
      metadataStore: store, timeoutSeconds: 1800, chatInjector, chatDeliveryLogPath: logPath, now: () => 5_000 });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "one", session: "work",
      clientMessageId: "9D724E75-D0B6-4102-A53A-7BBB3CA9B19E", text: "秘密の本文" }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // 打ち込みが済むまでは書かない（届いていない送信を「届けた」と残さない）。
    expect(fs.existsSync(logPath)).toBe(false);
    releases.shift()?.();
    await vi.waitFor(() => expect(received).toContainEqual({ type: "chat_send_result", id: "one", status: "accepted" }));
    const records = readRecords(logPath);
    expect(records).toEqual([{
      v: 1, atMs: expect.any(Number), session: "work", conversationId: "conv-1", agent: "claude",
      clientMessageId: "9D724E75-D0B6-4102-A53A-7BBB3CA9B19E", textHash: utteranceDigest("秘密の本文"),
    }]);
    expect(fs.readFileSync(logPath, "utf8")).not.toContain("秘密の本文");
    // 同じ送信 ID の打ち直しは重複で返り、記録は増えない。
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "two", session: "work",
      clientMessageId: "9D724E75-D0B6-4102-A53A-7BBB3CA9B19E", text: "秘密の本文" }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "chat_send_result", id: "two", status: "duplicate" }));
    expect(readRecords(logPath)).toHaveLength(1);
  });

  test("打ち込みに失敗した送信は記録しない。会話 ID がまだ無い会話名は、会話名だけで記録する", async () => {
    const logPath = path.join(makeTempDir("hub-delivery"), "chat-deliveries.ndjson");
    let fail = true;
    const chatInjector = vi.fn(async () => { if (fail) throw new Error("打てなかった"); });
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("hub-delivery-hb"),
      metadataStore: makeTempStore(), timeoutSeconds: 1800, chatInjector, chatDeliveryLogPath: logPath });
    const client = {}, received: Array<Record<string, unknown>> = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line) as Record<string, unknown>));
    // 失敗した送信は「届いたか分からない」として会話名の送信順の先頭に残るので、次は別の会話名で確かめる。
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "one", session: "broken", clientMessageId: "cm-1", text: "一回目" }));
    await vi.waitFor(() => expect(received.some((message) => message["id"] === "one")).toBe(true));
    expect(received.find((message) => message["id"] === "one")).toMatchObject({ status: "failed" });
    expect(fs.existsSync(logPath)).toBe(false);
    fail = false;
    hub.handleClientMessage(client, JSON.stringify({ type: "chat_send", id: "two", session: "fresh", clientMessageId: "cm-2", text: "二回目" }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "chat_send_result", id: "two", status: "accepted" }));
    expect(readRecords(logPath)).toEqual([
      { v: 1, atMs: expect.any(Number), session: "fresh", agent: "claude", clientMessageId: "cm-2", textHash: utteranceDigest("二回目") },
    ]);
  });

  test("Codex の turn の開始も記録する。記録先が無ければ何も書かない", async () => {
    const logPath = path.join(makeTempDir("hub-delivery"), "chat-deliveries.ndjson");
    const controller = { startTurn: vi.fn(async () => "turn-1"), closeSession: vi.fn(), close: vi.fn() } satisfies CodexTurnControllerRuntime;
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 1, agent: "codex", providerSessionId: "thread-1" });
    const options = {
      runner: async () => ok(""), heartbeatDir: makeTempDir("hub-delivery-hb"), metadataStore: store, timeoutSeconds: 1800,
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused"); } }),
      codexTurnControllerFactory: () => controller,
    };
    const message = { type: "codex_turn_submit", id: "one", session: "work", text: "走らせて",
      clientUserMessageId: "cli-0123456789abcdef01234567", effort: null, sandbox: null, threadId: "thread-1", cwd: "/tmp/work" };
    const hub = new SessionHub({ ...options, chatDeliveryLogPath: logPath });
    const client = {}, received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify(message));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "codex_turn_result", id: "one", status: "started" }));
    expect(readRecords(logPath)).toEqual([{
      v: 1, atMs: expect.any(Number), session: "work", conversationId: "thread-1", agent: "codex",
      clientMessageId: "cli-0123456789abcdef01234567", textHash: utteranceDigest("走らせて"),
    }]);

    const silent = new SessionHub(options);
    const silentClient = {}, silentReceived: unknown[] = [];
    silent.registerClient(silentClient, (line) => silentReceived.push(decodeHubServerLine(line)));
    silent.handleClientMessage(silentClient, JSON.stringify({ ...message, id: "two", clientUserMessageId: "cm-other" }));
    await vi.waitFor(() => expect(silentReceived).toContainEqual({ type: "codex_turn_result", id: "two", status: "started" }));
    expect(readRecords(logPath)).toHaveLength(1);
  });
});
