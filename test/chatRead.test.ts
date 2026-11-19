// chatRead.test.ts — `tailii-host chat read / search`（tailii-chat-cli）: 記録の部分取得・検索・発話の出所

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, test } from "vitest";
import { EXIT, runChat, type ChatDeps } from "../src/commands/chat/chatCommand.js";
import {
  ChatReadError,
  READ_LIMITS,
  findConversationRequests,
  foldForSearch,
  matchElement,
  parseCursor,
  readChatDeliveries,
  readClaudeElements,
  readCodexElements,
  readHubDeliveredIds,
  readHubSendLog,
  resolveSources,
  searchElements,
  sliceElements,
  truncateUtf8,
  type ChatElement,
  type HubSendLog,
  type SourceContext,
} from "../src/commands/chat/chatRead.js";
import {
  clientMessageIdFor,
  findModelCommandResult,
  forEachFileLine,
  forEachRolloutLine,
  lastClaudeModel,
  lastCodexModel,
  readCodexRollout,
  readTranscriptLines,
  requestDigest,
  type RequestRecord,
} from "../src/commands/chat/chatState.js";
import { appendChatDelivery, utteranceDigest, type ChatDeliveryRecord } from "../src/hub/chatDeliveryLog.js";
import { makeTempDir, makeTempStore } from "./helpers.js";

const iso = (ms: number): string => new Date(ms).toISOString();
const APP_ID = (n: number): string => `AAAAAAAA-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-11-18T10:00:00.000Z");

function writeLines(name: string, lines: object[]): string {
  const file = path.join(makeTempDir("chat-read"), name);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

/** Claude の記録の行（2.1.3xx の形）。 */
const human = (atMs: number, text: string, extra: object = {}): object => ({
  type: "user", timestamp: iso(atMs), entrypoint: "cli", promptSource: "typed", turnOrigin: "human", origin: { kind: "human" },
  message: { role: "user", content: text }, ...extra,
});
const assistant = (atMs: number, text: string, model = "claude-fable-5-2"): object => ({
  type: "assistant", timestamp: iso(atMs), message: { role: "assistant", model, content: [{ type: "text", text }] },
});
const queued = (atMs: number, prompt: string, origin: object = { kind: "human" }, extra: object = {}): object => ({
  type: "attachment", timestamp: iso(atMs), entrypoint: "cli",
  attachment: { type: "queued_command", prompt, commandMode: "prompt", origin, ...extra },
});

describe("readClaudeElements", () => {
  test("人の発話・エージェントの文章・別のセッションからの発話・中断の印・圧縮の要約だけを古い順に読む", () => {
    const file = writeLines("c.jsonl", [
      human(T0, "最初の指示"),
      { type: "assistant", timestamp: iso(T0 + 1), message: { model: "claude-fable-5-2", content: [{ type: "thinking", thinking: "考え中" }] } },
      assistant(T0 + 2, "返答 1"),
      { type: "user", timestamp: iso(T0 + 3), message: { content: [{ type: "tool_result", content: "結果" }] } },
      queued(T0 + 4, "処理中に送った発話"),
      queued(T0 + 5, "<task-notification> <task-id>x</task-id>", { kind: "task-notification", producer: "session-task" }, { commandMode: "task-notification" }),
      queued(T0 + 6, "<agent-message from=\"a1\">報告</agent-message>", { kind: "peer", from: "a1", senderTaskId: "a1", name: "general-purpose" }),
      queued(T0 + 7, "<cross-session-message from=\"uds:/tmp/x.sock\">やあ</cross-session-message>", { kind: "peer", from: "uds:/tmp/x.sock", name: "rizm-38" }),
      { ...(human(T0 + 8, "Another Claude session sent a message") as object), isMeta: true, promptSource: "system", origin: { kind: "peer", from: "uds:/tmp/y.sock", name: "rizm-7e" } },
      { ...(human(T0 + 9, "[Subagent hand-back] 終わり") as object), isMeta: true, origin: { kind: "peer", from: "a2", senderTaskId: "a2" } },
      { ...(human(T0 + 10, "<system-reminder>注入</system-reminder>") as object), isMeta: true },
      human(T0 + 11, "<command-name>/model</command-name>"),
      { ...(human(T0 + 12, "<task-notification> 待機中の通知") as object), origin: { kind: "task-notification" }, promptSource: "system" },
      { type: "user", timestamp: iso(T0 + 13), entrypoint: "cli", message: { content: "[Request interrupted by user for tool use]" } },
      { type: "user", timestamp: iso(T0 + 14), entrypoint: "cli", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: "This session is being continued…" } },
      { ...(human(T0 + 15, "サイドチェーン") as object), isSidechain: true },
      human(T0 + 16, "待たされた発話", { promptSource: "queued" }),
      { type: "assistant", timestamp: iso(T0 + 17), message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
      human(T0 + 18, "SDK から", { entrypoint: "sdk-ts", promptSource: "sdk", turnOrigin: "sdk", origin: undefined }),
      { ...(human(T0 + 19, "30 分後に進み具合を確かめる") as object), isMeta: true, promptSource: "system", turnOrigin: "scheduled", scheduledTaskId: "t1", origin: undefined },
      human(T0 + 20, "提案を受け入れた", { promptSource: "suggestion_accepted" }),
      human(T0 + 21, "人の打ち込みではない入り方", { promptSource: "system", origin: undefined }),
      human(T0 + 22, "<agent-message from=\"a1\"> を貼って質問"),
      "壊れた行ではないが JSON の文字列",
    ]);
    const elements = readClaudeElements(file)!;
    expect(elements.map((element) => [element.role, element.text])).toEqual([
      ["user", "最初の指示"],
      ["assistant", "返答 1"],
      ["user", "処理中に送った発話"],
      ["user", "<cross-session-message from=\"uds:/tmp/x.sock\">やあ</cross-session-message>"],
      ["user", "Another Claude session sent a message"],
      ["user", "[Request interrupted by user for tool use]"],
      ["user", "This session is being continued…"],
      ["user", "待たされた発話"],
      ["assistant", "No response requested."],
      ["user", "SDK から"],
      ["user", "30 分後に進み具合を確かめる"],
      ["user", "提案を受け入れた"],
      ["user", "人の打ち込みではない入り方"],
      ["user", "<agent-message from=\"a1\"> を貼って質問"],
    ]);
    expect(elements[0]).toMatchObject({ atMs: T0, entrypoint: "cli" });
    expect(elements[0]!.deferred).toBeUndefined();
    expect(elements[0]!.midTurn).toBeUndefined();
    expect(elements[2]).toMatchObject({ midTurn: true, entrypoint: "cli" });
    expect(elements[1]).toMatchObject({ model: "claude-fable-5-2" });
    expect(elements[3]!.fixed).toEqual({ kind: "peer", confidence: "exact", name: "rizm-38" });
    expect(elements[4]!.fixed).toEqual({ kind: "peer", confidence: "exact", name: "rizm-7e" });
    expect(elements[5]!.fixed).toEqual({ kind: "system", confidence: "exact", detail: "interrupted" });
    expect(elements[6]!.fixed).toEqual({ kind: "system", confidence: "exact", detail: "compact_summary" });
    expect(elements[7]).toMatchObject({ deferred: true });
    expect(elements[8]!.model).toBeUndefined();
    expect(elements[9]).toMatchObject({ entrypoint: "sdk-ts", untyped: true });
    expect(elements[10]!.fixed).toEqual({ kind: "system", confidence: "exact", detail: "scheduled" });
    expect(elements[11]!.untyped).toBeUndefined();
    expect(elements[12]).toMatchObject({ untyped: true, entrypoint: "cli" });
    // 人の発話の印が付いた行は、本文がサブエージェントの報告の形で始まっていても落とさない。
    expect(elements[13]!.fixed).toBeUndefined();
  });

  test("貼り付けの包みは外す。読めないファイルは null", () => {
    const file = writeLines("p.jsonl", [human(T0, "\n\n<pasted_content id=\"0baf\">\n貼った本文\n</pasted_content id=\"0baf\">\n")]);
    expect(readClaudeElements(file)![0]!.text).toBe("貼った本文");
    expect(readClaudeElements(path.join(makeTempDir("chat-read"), "none.jsonl"))).toBeNull();
  });
});

const codexUser = (atMs: number, text: string, clientId?: string): object => ({
  type: "event_msg", timestamp: iso(atMs),
  payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text }], ...(clientId !== undefined ? { client_id: clientId } : {}) } },
});
const codexAgent = (atMs: number, text: string, phase = "final_answer"): object => ({
  type: "event_msg", timestamp: iso(atMs),
  payload: { type: "item_completed", item: { type: "AgentMessage", phase, content: [{ type: "Text", text }] } },
});

describe("readCodexElements", () => {
  test("発話と文章・発話の送信 ID・その turn のモデル・処理中かを読む", () => {
    const file = writeLines("rollout-x.jsonl", [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      { type: "event_msg", timestamp: iso(T0), payload: { type: "task_started" } },
      codexUser(T0 + 1, "頼む", "9D724E75-D0B6-4102-A53A-7BBB3CA9B19E"),
      codexAgent(T0 + 2, "内部の分析", "analysis"),
      codexAgent(T0 + 3, "返答"),
      { type: "event_msg", timestamp: iso(T0 + 4), payload: { type: "task_complete" } },
      { type: "turn_context", payload: { model: "gpt-5.5-codex" } },
      { type: "event_msg", timestamp: iso(T0 + 5), payload: { type: "task_started" } },
      { type: "event_msg", timestamp: iso(T0 + 6), payload: { type: "user_message", message: "旧形式の発話" } },
      { type: "event_msg", timestamp: iso(T0 + 7), payload: { type: "agent_message", message: "旧形式の返答" } },
    ]);
    const read = readCodexElements(file)!;
    expect(read.busy).toBe(true);
    expect(read.elements).toEqual([
      { role: "user", text: "頼む", atMs: T0 + 1, clientId: "9D724E75-D0B6-4102-A53A-7BBB3CA9B19E" },
      { role: "assistant", text: "返答", atMs: T0 + 3, model: "gpt-5.5" },
      { role: "user", text: "旧形式の発話", atMs: T0 + 6 },
      { role: "assistant", text: "旧形式の返答", atMs: T0 + 7, model: "gpt-5.5-codex" },
    ]);
    expect(readCodexElements(path.join(makeTempDir("chat-read"), "rollout-none.jsonl"))).toBeNull();
  });
});

describe("forEachFileLine（Claude の会話ログの読み取り）", () => {
  test("少しずつ読んでも 1 行ずつ渡す。長すぎる行は飛ばす。無いファイルは false", () => {
    const lines = ["{\"a\":1}", "日本語の行😀が切れ目をまたぐ", "L".repeat(60), "", "末尾に改行が無い行"];
    const file = path.join(makeTempDir("chat-read-lines"), "c.jsonl");
    fs.writeFileSync(file, lines.join("\n"));
    const collect = (options?: Parameters<typeof forEachFileLine>[2]): string[] | null => {
      const out: string[] = [];
      return forEachFileLine(file, (line) => { out.push(line); }, options) ? out : null;
    };
    for (const chunkBytes of [1, 2, 3, 5, 7, 16, 64, 4096]) {
      expect(collect({ chunkBytes }), `chunkBytes=${chunkBytes}`).toEqual(lines.filter((line) => line.length > 0));
      expect(collect({ chunkBytes, maxLineBytes: 59 }), `chunkBytes=${chunkBytes}`).toEqual([lines[0], lines[1], lines[4]]);
    }
    expect(forEachFileLine(path.join(makeTempDir("chat-read-lines"), "none.jsonl"), () => {})).toBe(false);
  });

  test("status が使う読み取り（発話・直近のモデル・/model の結果）は、ツールの結果の行が大量に挟まっても同じ結果", () => {
    const toolResult = (i: number): object => ({
      type: "user", timestamp: iso(T0 + i), message: { content: [{ type: "tool_result", content: "出力".repeat(4_000) }] },
    });
    const file = writeLines("big.jsonl", [
      human(T0, "最初の指示"),
      ...Array.from({ length: 40 }, (_, i) => toolResult(i)),
      assistant(T0 + 1, "返答 1", "claude-opus-5-5"),
      human(T0 + 2, "<command-name>/model</command-name>\n<command-args>claude-fable-5-2</command-args>"),
      human(T0 + 3, "<local-command-stdout>Set model to claude-fable-5-2</local-command-stdout>"),
      queued(T0 + 4, "処理中に送った発話"),
      ...Array.from({ length: 40 }, (_, i) => toolResult(100 + i)),
      assistant(T0 + 5, "返答 2", "claude-fable-5-2"),
      { type: "assistant", timestamp: iso(T0 + 6), message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
    ]);
    expect(readTranscriptLines(file)).toEqual([
      { role: "user", text: "最初の指示", atMs: T0 },
      { role: "assistant", text: "返答 1", atMs: T0 + 1 },
      { role: "user", text: "処理中に送った発話", atMs: T0 + 4 },
      { role: "assistant", text: "返答 2", atMs: T0 + 5 },
      { role: "assistant", text: "No response requested.", atMs: T0 + 6 },
    ]);
    // 直近の「実際のモデル」（<synthetic> は数えない）。
    expect(lastClaudeModel(file)).toBe("claude-fable-5-2");
    expect(findModelCommandResult(file, T0, "claude-fable-5-2")).toEqual({ detail: "Set model to claude-fable-5-2", superseded: false });
    expect(readClaudeElements(file)!.map((element) => element.text)).toEqual(["最初の指示", "返答 1", "処理中に送った発話", "返答 2", "No response requested."]);
    const missing = path.join(makeTempDir("chat-read-lines"), "none.jsonl");
    expect(readTranscriptLines(missing)).toEqual([]);
    expect(lastClaudeModel(missing)).toBeNull();
    expect(findModelCommandResult(missing, 0, "claude-fable-5-2")).toBeNull();
    expect(readClaudeElements(missing)).toBeNull();
  });
});

describe("forEachRolloutLine", () => {
  const collect = (file: string, options?: Parameters<typeof forEachRolloutLine>[2]): string[] | null => {
    const lines: string[] = [];
    return forEachRolloutLine(file, (line) => { lines.push(line); }, options) ? lines : null;
  };
  const rolloutFile = (name: string, body: string | Buffer): string => {
    const file = path.join(makeTempDir("chat-read-rollout"), name);
    fs.writeFileSync(file, body);
    return file;
  };

  test("少しずつ読んでも、読んだ分の切れ目をまたぐ行・多バイト文字を壊さずに 1 行ずつ渡す", () => {
    const lines = ["{\"a\":1}", "日本語の行😀が切れ目をまたぐ", "x".repeat(50), "", "末尾に改行が無い行"];
    const file = rolloutFile("rollout-a.jsonl", lines.join("\n"));
    const expected = lines.filter((line) => line.length > 0);
    // 切れ目がどこに来ても同じ（1 バイトずつ読んでも、文字の途中で切れない）。
    for (const chunkBytes of [1, 2, 3, 5, 7, 16, 64, 4096]) {
      expect(collect(file, { chunkBytes }), `chunkBytes=${chunkBytes}`).toEqual(expected);
    }
    expect(collect(rolloutFile("rollout-b.jsonl", "一行だけ\n"))).toEqual(["一行だけ"]);
    expect(collect(rolloutFile("rollout-c.jsonl", ""))).toEqual([]);
  });

  test("types を渡すと、先頭から種類が読み取れて要らない行は飛ばす。読み取れない行は飛ばさない", () => {
    const lines = [
      "{\"timestamp\":\"2026-11-18T10:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{}}",
      "{\"timestamp\":\"2026-11-18T10:00:00.000Z\",\"ordinal\":12,\"type\":\"response_item\",\"payload\":{\"big\":\"" + "x".repeat(300) + "\"}}",
      "{\"timestamp\":\"2026-11-18T10:00:00.000Z\",\"ordinal\":13,\"type\":\"turn_context\",\"payload\":{}}",
      "{\"type\":\"response_item\",\"timestamp\":\"並びが違う行は飛ばさない\"}",
    ];
    const file = rolloutFile("rollout-t.jsonl", lines.join("\n") + "\n");
    for (const chunkBytes of [7, 4096]) {
      expect(collect(file, { types: new Set(["event_msg", "turn_context"]), chunkBytes })).toEqual([lines[0], lines[2], lines[3]]);
    }
    expect(collect(file)).toEqual(lines);
  });

  test("長すぎる 1 行は飛ばし、その前後の行は欠けない（読んだ分の切れ目をまたいでも、末尾の行でも）", () => {
    const long = "L".repeat(40);
    const lines = ["前の行", long, "間の行", long + long, "後ろの行", long];
    const expected = ["前の行", "間の行", "後ろの行"];
    const body = lines.join("\n");
    for (const file of [rolloutFile("rollout-l.jsonl", body), rolloutFile("rollout-l.jsonl.zst", zlib.zstdCompressSync(Buffer.from(body, "utf8")))]) {
      for (const chunkBytes of [1, 3, 8, 16, 33, 4096]) {
        expect(collect(file, { chunkBytes, maxLineBytes: 20 }), `${path.basename(file)} chunkBytes=${chunkBytes}`).toEqual(expected);
      }
      // 上限ちょうどの行は読む。
      expect(collect(file, { chunkBytes: 7, maxLineBytes: 40 })).toEqual(["前の行", long, "間の行", "後ろの行", long]);
    }
  });

  test("圧縮 rollout も同じに読む。無いファイルは false", () => {
    const body = "一行目\n二行目😀\n最後は改行なし";
    const file = rolloutFile("rollout-z.jsonl.zst", zlib.zstdCompressSync(Buffer.from(body, "utf8")));
    expect(collect(file)).toEqual(["一行目", "二行目😀", "最後は改行なし"]);
    expect(collect(path.join(makeTempDir("chat-read-rollout"), "rollout-none.jsonl"))).toBeNull();
    expect(collect(rolloutFile("rollout-bad.jsonl.zst", "圧縮ではない"))).toBeNull();
  });

  test("status が使う読み取り（発話・処理中・直近のモデル）は、ツールの出力の行が大量に挟まっても同じ結果", () => {
    const tool = (i: number): object => ({ timestamp: iso(T0 + i), ordinal: i, type: "response_item", payload: { type: "custom_tool_call_output", output: "出力".repeat(4_000) } });
    const file = writeLines("rollout-big.jsonl", [
      { timestamp: iso(T0), type: "turn_context", payload: { model: "gpt-5.5" } },
      { type: "event_msg", timestamp: iso(T0), payload: { type: "task_started" } },
      codexUser(T0 + 1, "頼む", APP_ID(1)),
      ...Array.from({ length: 40 }, (_, i) => tool(i)),
      codexAgent(T0 + 2, "返答"),
      { type: "event_msg", timestamp: iso(T0 + 3), payload: { type: "task_complete" } },
      { timestamp: iso(T0 + 4), type: "turn_context", payload: { model: "gpt-5.5-codex" } },
      { type: "event_msg", timestamp: iso(T0 + 5), payload: { type: "task_started" } },
      ...Array.from({ length: 40 }, (_, i) => tool(100 + i)),
    ]);
    expect(readCodexRollout(file)).toEqual({
      lines: [
        { role: "user", text: "頼む", atMs: T0 + 1, clientId: APP_ID(1) },
        { role: "assistant", text: "返答", atMs: T0 + 2 },
      ],
      busy: true,
    });
    expect(lastCodexModel(file)).toBe("gpt-5.5-codex");
    expect(readCodexElements(file)).toMatchObject({ busy: true, elements: [{ text: "頼む" }, { text: "返答", model: "gpt-5.5" }] });
    const missing = path.join(makeTempDir("chat-read-rollout"), "rollout-none.jsonl");
    expect(readCodexRollout(missing)).toEqual({ lines: [], busy: false });
    expect(lastCodexModel(missing)).toBeNull();
  });
});

/** engine の送信ログの行（`chatSendDiag` の形）。 */
const logLine = (atMs: number, pid: number, body: string): string => `[${iso(atMs)} pid=${pid}] ${body}`;

function writeSendLog(lines: string[]): string {
  const file = path.join(makeTempDir("chat-read-log"), "chat-send.log");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("readHubSendLog", () => {
  test("recv と結果を、同じ pid の同じ要求 ID の直前の recv で対にする（要求 ID は使い回される）", () => {
    const file = writeSendLog([
      logLine(T0, 10, "heal subscribe session=s-a previousActive=nil"),
      logLine(T0 + 100, 10, "recv id=send-1 session=s-a cmid=AAAAAAAA-0000-4000-8000-000000000001"),
      logLine(T0 + 400, 10, "result id=send-1 status=accepted"),
      logLine(T0 + 1_000, 10, "recv id=send-1 session=s-a cmid=AAAAAAAA-0000-4000-8000-000000000002"),
      logLine(T0 + 1_100, 11, "recv id=send-1 session=s-b cmid=cli-0123456789abcdef01234567"),
      logLine(T0 + 1_200, 10, "failed id=send-1 error=Error: timeout"),
      logLine(T0 + 1_300, 11, "result id=send-1 status=failed"),
      logLine(T0 + 2_000, 10, "send-now recv id=now-1 session=s-a"),
      logLine(T0 + 2_100, 10, "send-now result id=now-1 status=accepted"),
      logLine(T0 + 3_000, 12, "recv id=send-9 session=s-c cmid=AAAAAAAA-0000-4000-8000-000000000003"),
      logLine(T0 + 3_100, 12, "result id=send-9 status=duplicate"),
      logLine(T0 + 4_000, 12, "recv id=send-10 session=s-c cmid=AAAAAAAA-0000-4000-8000-000000000004"),
      "壊れた行",
    ]);
    const log = readHubSendLog(file)!;
    expect(log.coverageStartMs).toBe(T0 + 100);
    expect(log.sends).toEqual([
      { session: "s-a", clientMessageId: "AAAAAAAA-0000-4000-8000-000000000001", recvAtMs: T0 + 100, endAtMs: T0 + 400, status: "accepted" },
      { session: "s-a", clientMessageId: "AAAAAAAA-0000-4000-8000-000000000002", recvAtMs: T0 + 1_000, endAtMs: T0 + 1_200, status: "error" },
      { session: "s-b", clientMessageId: "cli-0123456789abcdef01234567", recvAtMs: T0 + 1_100, endAtMs: T0 + 1_300, status: "failed" },
      { session: "s-c", clientMessageId: "AAAAAAAA-0000-4000-8000-000000000003", recvAtMs: T0 + 3_000, endAtMs: T0 + 3_100, status: "duplicate" },
      { session: "s-c", clientMessageId: "AAAAAAAA-0000-4000-8000-000000000004", recvAtMs: T0 + 4_000, endAtMs: null, status: null },
    ]);
  });

  test("無い・送信の行が 1 つも無いログは null（判定の材料にしない）", () => {
    expect(readHubSendLog(path.join(makeTempDir("chat-read-log"), "none.log"))).toBeNull();
    expect(readHubSendLog(writeSendLog(["関係ない行"]))).toBeNull();
  });
});

describe("readHubDeliveredIds", () => {
  test("会話ごとの配送済み（Claude・Codex）と片付けた会話の台帳の送信 ID を集める", () => {
    const file = path.join(makeTempDir("chat-read-receipts"), "chat-receipts.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: { "s-a": { delivered: ["A1"], deliveredCodex: ["C1"], queued: [] }, "s-b": { delivered: "壊れ" } },
      retiredChatDeliveredAtMs: { R1: 1 },
    }));
    expect([...readHubDeliveredIds(file)].sort()).toEqual(["A1", "C1", "R1"]);
    expect(readHubDeliveredIds(path.join(makeTempDir("chat-read-receipts"), "none.json")).size).toBe(0);
  });
});

function hubLog(sends: Array<{ session: string; id: string; recv: number; end?: number | null; status?: HubSendLog["sends"][number]["status"] }>,
  coverageStartMs = T0 - 60_000): HubSendLog {
  return {
    coverageStartMs,
    sends: sends.map((send) => ({
      session: send.session, clientMessageId: send.id, recvAtMs: send.recv,
      endAtMs: send.end === undefined ? send.recv + 800 : send.end, status: send.status === undefined ? "accepted" : send.status,
    })).sort((left, right) => left.recvAtMs - right.recvAtMs),
  };
}

const userAt = (atMs: number, text = "発話", extra: Partial<ChatElement> = {}): ChatElement =>
  ({ role: "user", text, atMs, entrypoint: "cli", ...extra });

function resolve(elements: ChatElement[], context: Partial<SourceContext>): Array<ChatElement["source"]> {
  resolveSources(elements, {
    agent: "claude", conversationId: "conv-1", requests: [], sessions: ["s-own"], hub: null, deliveredIds: new Set(), deliveries: [], ...context,
  });
  return elements.map((element) => element.source);
}

const request = (requestId: string, text: string, sentAtMs: number, extra: Partial<RequestRecord> = {}): RequestRecord =>
  ({ requestId, kind: "send", conversationId: "conv-1", session: "s-own", cwd: "/tmp", sentAtMs, text, state: "sent", ...extra });

describe("resolveSources（Claude）", () => {
  test("依頼の記録の本文と一致する発話は cli（exact・依頼 ID つき）。同じ本文でも送る前の発話は拾わない", () => {
    const elements = [userAt(T0 - 5_000, "続けて"), userAt(T0 + 500, "続けて"), { role: "assistant" as const, text: "はい", atMs: T0 + 900 }];
    const sources = resolve(elements, {
      requests: [request("r-1", "続けて\n", T0)],
      hub: hubLog([{ session: "s-own", id: clientMessageIdFor("r-1"), recv: T0 + 100 }]),
    });
    expect(sources[0]).toEqual({ kind: "terminal", confidence: "inferred" });
    expect(sources[1]).toEqual({ kind: "cli", confidence: "exact", requestId: "r-1" });
    expect(sources[2]).toBeUndefined();
  });

  test("その会話の会話名への hub の送信の時刻に入る発話は app（inferred）。送信 1 件は発話 1 件にだけ当てる", () => {
    const elements = [userAt(T0 + 500), userAt(T0 + 1_500), userAt(T0 + 60_000)];
    const sources = resolve(elements, {
      hub: hubLog([
        { session: "s-own", id: APP_ID(1), recv: T0, end: T0 + 800 },
        { session: "s-own", id: APP_ID(2), recv: T0 + 59_000, end: T0 + 64_000 },
      ]),
    });
    expect(sources).toEqual([
      { kind: "app", confidence: "inferred" },
      // 2 件目は 1 件目の送信の時刻（結果の 3 秒後まで）に入るが、その送信はもう当ててある。
      { kind: "terminal", confidence: "inferred" },
      { kind: "app", confidence: "inferred" },
    ]);
  });

  test("送信 ID が cli-… の送信に当たれば、依頼の記録が無くても cli（inferred）", () => {
    const sources = resolve([userAt(T0 + 300)], {
      hub: hubLog([{ session: "s-own", id: clientMessageIdFor("gone"), recv: T0 }]),
    });
    expect(sources).toEqual([{ kind: "cli", confidence: "inferred" }]);
  });

  test("その時刻にどの会話名への送信も無ければ terminal。別の会話名への送信があれば unknown（対応が失われたかもしれない）", () => {
    const hub = hubLog([{ session: "s-other", id: APP_ID(1), recv: T0 }]);
    expect(resolve([userAt(T0 + 300)], { hub })).toEqual([{ kind: "unknown" }]);
    expect(resolve([userAt(T0 + 30_000)], { hub })).toEqual([{ kind: "terminal", confidence: "inferred" }]);
    // 会話名が分からない会話（Tailii で開いたことが無い）でも、送信が無い時刻の発話は terminal。
    expect(resolve([userAt(T0 + 30_000)], { hub, sessions: [] })).toEqual([{ kind: "terminal", confidence: "inferred" }]);
  });

  test("送信の記録が無い・記録が始まる前の発話・時刻の無い発話は unknown（推測で埋めない）", () => {
    expect(resolve([userAt(T0)], { hub: null })).toEqual([{ kind: "unknown" }]);
    expect(resolve([userAt(T0 - 120_000), userAt(0)], { hub: hubLog([], T0 - 60_000) })).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
  });

  test("hub が失敗を返した送信には当てない。結果の行が無い送信は 100 秒まで続いていたとみなす", () => {
    expect(resolve([userAt(T0 + 300)], {
      hub: hubLog([{ session: "s-own", id: APP_ID(1), recv: T0, status: "failed" }]),
    })).toEqual([{ kind: "terminal", confidence: "inferred" }]);
    expect(resolve([userAt(T0 + 90_000), userAt(T0 + 200_000)], {
      hub: hubLog([{ session: "s-own", id: APP_ID(1), recv: T0, end: null, status: null }]),
    })).toEqual([{ kind: "app", confidence: "inferred" }, { kind: "terminal", confidence: "inferred" }]);
  });

  test("待たされた発話は、直近の待たされていない発話より後の、まだ当てていない送信を古い順に当てる", () => {
    const elements = [
      userAt(T0 + 500, "最初"),
      userAt(T0 + 300_000, "待ち 1", { deferred: true }),
      userAt(T0 + 300_010, "待ち 2", { deferred: true }),
      userAt(T0 + 300_020, "端末で打って待たされた", { deferred: true }),
    ];
    const sources = resolve(elements, {
      hub: hubLog([
        { session: "s-own", id: APP_ID(1), recv: T0 },
        { session: "s-own", id: APP_ID(2), recv: T0 + 20_000 },
        { session: "s-own", id: APP_ID(3), recv: T0 + 40_000 },
      ]),
    });
    expect(sources).toEqual([
      { kind: "app", confidence: "inferred" },
      { kind: "app", confidence: "inferred" },
      { kind: "app", confidence: "inferred" },
      { kind: "terminal", confidence: "inferred" },
    ]);
    // 待っている間に別の会話名への送信があれば、決めない。
    expect(resolve([userAt(T0 + 500), userAt(T0 + 300_000, "待ち", { deferred: true })], {
      hub: hubLog([{ session: "s-own", id: APP_ID(1), recv: T0 }, { session: "s-other", id: APP_ID(2), recv: T0 + 50_000 }]),
    })[1]).toEqual({ kind: "unknown" });
  });

  test("届いたか確かめられていない依頼（started・needs_human）の本文の一致は inferred", () => {
    const sources = resolve([userAt(T0 + 500, "続けて"), userAt(T0 + 9_000, "次へ")], {
      requests: [request("r-1", "続けて", T0, { state: "started", needsHuman: true }), request("r-2", "次へ", T0 + 8_000, { state: undefined })],
    });
    expect(sources).toEqual([
      { kind: "cli", confidence: "inferred", requestId: "r-1" },
      { kind: "cli", confidence: "exact", requestId: "r-2" },
    ]);
  });

  test("同じ送信 ID の打ち直しは 1 つの送信として当てる。重複（duplicate）で返った再送には当てない", () => {
    // 1 回目は結果が返らず、2 回目で受け付けられた。発話は 1 つだけ。
    const retried = resolve([userAt(T0 + 30_500), userAt(T0 + 31_500)], {
      hub: hubLog([
        { session: "s-own", id: APP_ID(1), recv: T0, end: null, status: null },
        { session: "s-own", id: APP_ID(1), recv: T0 + 30_000, end: T0 + 30_800 },
      ]),
    });
    expect(retried).toEqual([{ kind: "app", confidence: "inferred" }, { kind: "terminal", confidence: "inferred" }]);
    // 重複の再送の時刻に打たれた発話は、その送信の発話ではない（発話は前の打ち込みの時刻に残っている）。
    expect(resolve([userAt(T0 + 60_300)], {
      hub: hubLog([{ session: "s-own", id: APP_ID(1), recv: T0 + 60_000, status: "duplicate" }]),
    })).toEqual([{ kind: "terminal", confidence: "inferred" }]);
  });

  test("待たされた発話は、流れた時刻に重なった別の送信ではなく、待っていた送信を先に当てる", () => {
    const elements = [
      userAt(T0 + 500, "最初"),
      userAt(T0 + 20_300, "処理中の割り込み", { midTurn: true }),
      userAt(T0 + 60_000, "待っていた発話", { deferred: true }),
      userAt(T0 + 60_400, "流れた直後に送った発話"),
    ];
    const sources = resolve(elements, {
      hub: hubLog([
        { session: "s-own", id: APP_ID(1), recv: T0 },
        // 割り込みより前に送られて、ターンの終わりまで待たされた（割り込みの時刻は、待ちの起点を進めない）。
        { session: "s-own", id: APP_ID(2), recv: T0 + 10_000 },
        { session: "s-own", id: APP_ID(3), recv: T0 + 20_000 },
        { session: "s-own", id: APP_ID(4), recv: T0 + 59_700 },
      ]),
    });
    expect(sources).toEqual(Array.from({ length: 4 }, () => ({ kind: "app", confidence: "inferred" })));
  });

  test("端末の画面ではない入口（SDK・デスクトップアプリ）は unknown に入口の印を添える。記録の印で決まった出所はそのまま", () => {
    const elements: ChatElement[] = [
      userAt(T0 + 300, "SDK", { entrypoint: "sdk-ts" }),
      { role: "user", text: "peer", atMs: T0 + 400, fixed: { kind: "peer", confidence: "exact", name: "rizm-38" } },
      // 端末の画面でも、人の打ち込みではない入り方は、送信の時刻に入っていても決めない。
      userAt(T0 + 500, "印が system", { untyped: true }),
    ];
    expect(resolve(elements, { hub: hubLog([{ session: "s-own", id: APP_ID(1), recv: T0 }]) })).toEqual([
      { kind: "unknown", entrypoint: "sdk-ts" },
      { kind: "peer", confidence: "exact", name: "rizm-38" },
      { kind: "unknown" },
    ]);
  });
});

const delivery = (id: string, text: string, atMs: number, extra: Partial<ChatDeliveryRecord> = {}): ChatDeliveryRecord =>
  ({ v: 1, atMs, session: "s-own", conversationId: "conv-1", agent: "claude", clientMessageId: id, textHash: utteranceDigest(text), ...extra });

describe("resolveSources（hub が届けた発話の記録）", () => {
  test("本文のハッシュが一致する発話は、送信 ID の形で app か cli（exact）。記録の無い発話は推定のまま", () => {
    const elements = [userAt(T0 + 500, "設定を 直して"), userAt(T0 + 5_500, "続けて"), userAt(T0 + 60_000, "端末から"), userAt(T0 + 90_300, "記録より前の版の送信")];
    const sources = resolve(elements, {
      requests: [request("r-9", "関係ない依頼", T0 - 1_000)],
      deliveries: [
        delivery(APP_ID(1), "設定を直して\u200b", T0 + 800),
        delivery(clientMessageIdFor("r-9"), "続けて", T0 + 5_800),
      ],
      hub: hubLog([
        { session: "s-own", id: APP_ID(1), recv: T0 },
        { session: "s-own", id: clientMessageIdFor("r-9"), recv: T0 + 5_000 },
        { session: "s-own", id: APP_ID(2), recv: T0 + 90_000 },
      ]),
    });
    expect(sources).toEqual([
      { kind: "app", confidence: "exact" },
      { kind: "cli", confidence: "exact", requestId: "r-9" },
      { kind: "terminal", confidence: "inferred" },
      // 届けた記録が無い送信（記録を書く前の版の hub）は、時刻の突き合わせ。
      { kind: "app", confidence: "inferred" },
    ]);
  });

  test("この会話の記録だけを使う（会話 ID があればそれで、無ければ会話名で選ぶ）", () => {
    const one = (record: ChatDeliveryRecord): unknown => resolve([userAt(T0 + 500, "同じ本文")], { deliveries: [record] })[0];
    expect(one(delivery(APP_ID(1), "同じ本文", T0 + 800))).toEqual({ kind: "app", confidence: "exact" });
    // 会話 ID が食い違っていても（/clear や開き直しの直後は hub の知っている会話 ID が古い）、会話名が合えば使う。
    expect(one(delivery(APP_ID(1), "同じ本文", T0 + 800, { conversationId: "conv-old" }))).toEqual({ kind: "app", confidence: "exact" });
    // 会話 ID も会話名も合わない記録（別の会話へ届けた同じ本文）は使わない。
    expect(one(delivery(APP_ID(1), "同じ本文", T0 + 800, { conversationId: "conv-2", session: "s-other" }))).toEqual({ kind: "unknown" });
    // 会話名のメタが無くなっていても、会話 ID が合えば使う。
    expect(one(delivery(APP_ID(1), "同じ本文", T0 + 800, { session: "s-gone" }))).toEqual({ kind: "app", confidence: "exact" });
    // 会話 ID の無い記録（始めたばかりの会話）は、会話名で選ぶ。
    const noId = delivery(APP_ID(1), "同じ本文", T0 + 800);
    delete noId.conversationId;
    expect(one(noId)).toEqual({ kind: "app", confidence: "exact" });
    expect(one({ ...noId, session: "s-other" })).toEqual({ kind: "unknown" });
    // Codex へ届けた記録は Claude の会話には使わない。
    expect(one(delivery(APP_ID(1), "同じ本文", T0 + 800, { agent: "codex" }))).toEqual({ kind: "unknown" });
  });

  test("届いたか確かめられていない依頼も、hub が届けた記録があれば exact。記録が無ければ inferred のまま", () => {
    const pending = request("r-1", "続けて", T0, { state: "started", needsHuman: true });
    expect(resolve([userAt(T0 + 500, "続けて")], {
      requests: [pending], deliveries: [delivery(clientMessageIdFor("r-1"), "続けて", T0 + 800)],
    })).toEqual([{ kind: "cli", confidence: "exact", requestId: "r-1" }]);
    expect(resolve([userAt(T0 + 500, "続けて")], { requests: [pending] }))
      .toEqual([{ kind: "cli", confidence: "inferred", requestId: "r-1" }]);
    // hub の記録で決まった依頼を、依頼の記録の照合がもう一度別の発話に当てない（同じ本文を後から人が打った場合）。
    expect(resolve([userAt(T0 + 500, "続けて"), userAt(T0 + 900_000, "続けて")], {
      requests: [request("r-1", "続けて", T0)], deliveries: [delivery(clientMessageIdFor("r-1"), "続けて", T0 + 800)],
    })).toEqual([{ kind: "cli", confidence: "exact", requestId: "r-1" }, { kind: "unknown" }]);
  });

  test("同じ本文の発話は、届けた時刻に合うものにだけ当てる。待たされた発話は、流れた時刻が後でも当てる", () => {
    const elements = [
      userAt(T0 - 300_000, "はい"),            // 記録よりずっと前に端末で打った
      userAt(T0 + 500, "はい"),                // 届けた発話
      userAt(T0 + 30_000, "はい"),             // 後から端末で打った
      userAt(T0 + 400_000, "待たされた", { deferred: true }),
    ];
    const sources = resolve(elements, {
      deliveries: [delivery(APP_ID(1), "はい", T0 + 800), delivery(APP_ID(2), "待たされた", T0 + 100_000)],
    });
    expect(sources).toEqual([
      { kind: "unknown" },
      { kind: "app", confidence: "exact" },
      { kind: "unknown" },
      { kind: "app", confidence: "exact" },
    ]);
  });

  test("古い記録を、後のターンで待たされた同じ本文の発話に当てない（届けたのは、そのターンの間）", () => {
    // 会話名が前に収容していた別の会話へ届けた「続けて」の記録が残っている。
    const stale = delivery(APP_ID(1), "続けて", T0 - 600_000, { conversationId: "conv-before" });
    const elements = [userAt(T0 + 500, "最初"), userAt(T0 + 60_000, "続けて", { deferred: true })];
    expect(resolve(elements, { deliveries: [stale] })[1]).toEqual({ kind: "unknown" });
    // そのターンの間に届けた記録なら当てる。
    const fresh = delivery(APP_ID(2), "続けて", T0 + 20_000);
    expect(resolve([userAt(T0 + 500, "最初"), userAt(T0 + 60_000, "続けて", { deferred: true })], { deliveries: [stale, fresh] })[1])
      .toEqual({ kind: "app", confidence: "exact" });
  });

  test("端末の画面ではない入口・人の打ち込みではない行には当てない。Codex は記録の送信 ID が裏付けになる", () => {
    expect(resolve([userAt(T0 + 500, "本文", { entrypoint: "sdk-ts" }), userAt(T0 + 600, "本文", { untyped: true })], {
      deliveries: [delivery(APP_ID(1), "本文", T0 + 800)],
    })).toEqual([{ kind: "unknown", entrypoint: "sdk-ts" }, { kind: "unknown" }]);
    const codex: ChatElement[] = [{ role: "user", text: "c", atMs: T0, clientId: APP_ID(3) }, { role: "user", text: "d", atMs: T0 + 1, clientId: APP_ID(4) }];
    expect(resolve(codex, { agent: "codex", deliveries: [delivery(APP_ID(3), "c", T0 + 100, { agent: "codex" })] })).toEqual([
      { kind: "app", confidence: "exact" },
      { kind: "app", confidence: "inferred" },
    ]);
  });
});

describe("readChatDeliveries", () => {
  test("追記された記録を古い順に読む。形の違う行は飛ばす。無ければ空", () => {
    const file = path.join(makeTempDir("chat-read-deliveries"), "chat-deliveries.ndjson");
    appendChatDelivery(file, delivery(APP_ID(2), "二つ目", T0 + 20));
    fs.appendFileSync(file, "{壊れた行\n");
    appendChatDelivery(file, delivery(APP_ID(1), "一つ目", T0 + 10));
    expect(readChatDeliveries(file).map((record) => record.clientMessageId)).toEqual([APP_ID(1), APP_ID(2)]);
    expect(readChatDeliveries(path.join(makeTempDir("chat-read-deliveries"), "none.ndjson"))).toEqual([]);
  });
});

describe("resolveSources（Codex）", () => {
  test("発話の送信 ID で決める: cli-… は cli、アプリの形の ID は app（台帳にあれば exact）、ほかは unknown", () => {
    const elements: ChatElement[] = [
      { role: "user", text: "a", atMs: T0, clientId: clientMessageIdFor("r-1") },
      { role: "user", text: "b", atMs: T0 + 1, clientId: clientMessageIdFor("no-record") },
      { role: "user", text: "c", atMs: T0 + 2, clientId: APP_ID(1) },
      { role: "user", text: "d", atMs: T0 + 3, clientId: APP_ID(2) },
      { role: "user", text: "e", atMs: T0 + 4, clientId: "0b0e5a0c-3d1f-4a7e-9a52-6f7b6c1d2e3f" },
      { role: "user", text: "f", atMs: T0 + 5 },
      { role: "assistant", text: "g", atMs: T0 + 6 },
    ];
    expect(resolve(elements, { agent: "codex", requests: [request("r-1", "a", T0)], deliveredIds: new Set([APP_ID(1)]) })).toEqual([
      { kind: "cli", confidence: "exact", requestId: "r-1" },
      { kind: "cli", confidence: "exact" },
      { kind: "app", confidence: "exact" },
      { kind: "app", confidence: "inferred" },
      { kind: "unknown" },
      { kind: "unknown" },
      undefined,
    ]);
  });
});

describe("findConversationRequests", () => {
  test("その会話への new / send の記録だけを古い順に返す", () => {
    const dir = makeTempDir("chat-read-requests");
    const write = (record: Partial<RequestRecord>): void =>
      fs.writeFileSync(path.join(dir, `${requestDigest(record.requestId!).slice(0, 32)}.json`), JSON.stringify(record));
    write(request("r-2", "二つ目", 20));
    write(request("r-1", "一つ目", 10, { kind: "new" }));
    write(request("r-3", "別の会話", 5, { conversationId: "conv-2" }));
    write({ ...request("r-4", "", 30), kind: "set-model" });
    fs.writeFileSync(path.join(dir, `${"0".repeat(32)}.json`), "{壊れ");
    expect(findConversationRequests("conv-1", dir).map((record) => record.requestId)).toEqual(["r-1", "r-2"]);
    expect(findConversationRequests("conv-1", path.join(dir, "none"))).toEqual([]);
  });
});

const elementsOf = (count: number, text = (i: number): string => `本文 ${i}`): ChatElement[] =>
  Array.from({ length: count }, (_, i) => i % 2 === 0
    ? { role: "user" as const, text: text(i), atMs: T0 + i, source: { kind: "unknown" as const } }
    : { role: "assistant" as const, text: text(i), atMs: T0 + i, model: "m" });

describe("sliceElements", () => {
  test("last は末尾から。古い順に返し、前後に残りがあるかとカーソルを添える", () => {
    const result = sliceElements(elementsOf(25), { mode: "last", count: 10, maxTextBytes: 8192 });
    expect(result).toMatchObject({
      total: 25, range: { from: 15, to: 24 }, hasMoreBefore: true, hasMoreAfter: false,
      cursors: { before: `15:${T0 + 15}`, after: `24:${T0 + 24}` },
    });
    expect(result.messages.map((message) => message.seq)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(result.messages[1]).toEqual({ seq: 16, role: "user", atMs: T0 + 16, text: "本文 16", source: { kind: "unknown" } });
    expect(result.messages[0]).toEqual({ seq: 15, role: "assistant", atMs: T0 + 15, text: "本文 15", model: "m" });
  });

  test("after はカーソルの次から、before はカーソルの手前まで", () => {
    const elements = elementsOf(25);
    const after = sliceElements(elements, { mode: "after", cursor: parseCursor(`19:${T0 + 19}`), count: 3, maxTextBytes: 8192 });
    expect(after).toMatchObject({ range: { from: 20, to: 22 }, hasMoreBefore: true, hasMoreAfter: true });
    const before = sliceElements(elements, { mode: "before", cursor: parseCursor("3"), count: 10, maxTextBytes: 8192 });
    expect(before).toMatchObject({ range: { from: 0, to: 2 }, hasMoreBefore: false, hasMoreAfter: true });
  });

  test("続きが無いときは要素なしの正常な応答（差分の追跡で、新しい発話がまだ無い）。空の会話も同じ", () => {
    const elements = elementsOf(5);
    expect(sliceElements(elements, { mode: "after", cursor: parseCursor("4"), count: 10, maxTextBytes: 8192 }))
      .toEqual({ total: 5, range: null, hasMoreBefore: true, hasMoreAfter: false, messages: [] });
    expect(sliceElements(elements, { mode: "before", cursor: parseCursor("0"), count: 10, maxTextBytes: 8192 }))
      .toEqual({ total: 5, range: null, hasMoreBefore: false, hasMoreAfter: true, messages: [] });
    expect(sliceElements([], { mode: "last", count: 10, maxTextBytes: 8192 }))
      .toEqual({ total: 0, range: null, hasMoreBefore: false, hasMoreAfter: false, messages: [] });
  });

  test("記録の外を指すカーソル・時刻が合わないカーソルは stale_cursor。形が違えば bad_cursor", () => {
    const elements = elementsOf(5);
    const stale = (raw: string): unknown => {
      try {
        sliceElements(elements, { mode: "after", cursor: parseCursor(raw), count: 10, maxTextBytes: 8192 });
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(stale("5")).toMatchObject({ code: "stale_cursor" });
    expect(stale(`2:${T0 + 99}`)).toMatchObject({ code: "stale_cursor" });
    expect(stale(`2:${T0 + 2}`)).toBeNull();
    expect(() => parseCursor("abc")).toThrow(ChatReadError);
    expect(() => parseCursor("-1")).toThrow(ChatReadError);
    expect(parseCursor("12")).toEqual({ seq: 12 });
  });

  test("長い本文は文字の途中で切らずに切り、切ったことと本来のバイト数を添える", () => {
    const text = "あ".repeat(100);
    expect(truncateUtf8(text, 301)).toEqual({ text: "あ".repeat(100), truncated: false, bytes: 300 });
    expect(truncateUtf8(text, 10)).toEqual({ text: "あああ", truncated: true, bytes: 300 });
    expect(truncateUtf8("a😀b", 4)).toEqual({ text: "a", truncated: true, bytes: 6 });
    const result = sliceElements([{ role: "assistant", text, atMs: T0 }], { mode: "last", count: 10, maxTextBytes: 256 });
    expect(result.messages[0]).toMatchObject({ text: "あ".repeat(85), truncated: true, textBytes: 300 });
  });

  test("応答全体の上限に収まる分だけ返す（last は古い側・after は新しい側を切り、残りがあると分かる）", () => {
    const elements = elementsOf(20, () => "x".repeat(6_000));
    const last = sliceElements(elements, { mode: "last", count: 20, maxTextBytes: 8192 });
    expect(last.messages.length).toBeGreaterThan(1);
    expect(last.messages.length).toBeLessThan(20);
    expect(last.range!.to).toBe(19);
    expect(last.hasMoreBefore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(last), "utf8")).toBeLessThanOrEqual(READ_LIMITS.responseBytes);
    const after = sliceElements(elements, { mode: "after", cursor: parseCursor("0"), count: 19, maxTextBytes: 8192 });
    expect(after.range!.from).toBe(1);
    expect(after.hasMoreAfter).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(after), "utf8")).toBeLessThanOrEqual(READ_LIMITS.responseBytes);
  });

  test("1 件だけで上限を超える要素は、収まるまで切って必ず 1 件は返す", () => {
    const text = "\"\n".repeat(20_000); // JSON にすると 2 倍になる文字
    const result = sliceElements([{ role: "assistant", text, atMs: T0 }], { mode: "last", count: 1, maxTextBytes: READ_LIMITS.maxTextBytes });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ truncated: true, textBytes: 40_000 });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(READ_LIMITS.responseBytes);
  });
});

describe("searchElements", () => {
  test("空白・不可視文字・全角と半角・大文字と小文字の違いをならして探す", () => {
    expect(foldForSearch("Ａｐｉ　Key​ の\n値").folded).toBe("apikeyの値");
    expect(matchElement("設定は API  Key の値で決まる", foldForSearch("ａｐｉkey").folded)).toEqual({
      excerpt: "設定は API Key の値で決まる", matchCount: 1,
    });
    expect(matchElement("関係ない本文", foldForSearch("api").folded)).toBeNull();
  });

  test("抜粋は一致した箇所の前後だけ（全文ではない）。一致の数も返す", () => {
    const text = `${"前".repeat(200)}上限は 32 KiB${"後".repeat(300)}上限`;
    const match = matchElement(text, foldForSearch("上限").folded)!;
    expect(match.matchCount).toBe(2);
    expect(match.excerpt.startsWith("…")).toBe(true);
    expect(match.excerpt.endsWith("…")).toBe(true);
    expect(match.excerpt).toContain("上限は 32 KiB");
    expect(match.excerpt.length).toBeLessThan(260);
  });

  test("新しい一致から limit 件を古い順に返し、前後の要素を添える。古い一致は before で取れる", () => {
    const elements = elementsOf(30, (i) => (i % 5 === 0 ? `決定: 上限は ${i}` : `雑談 ${i}`));
    const result = searchElements(elements, { query: "上限", context: 1, limit: 2 });
    expect(result).toMatchObject({ total: 30, totalHits: 6, hasMoreBefore: true, cursors: { before: `20:${T0 + 20}` } });
    expect(result.hits.map((hit) => hit.seq)).toEqual([20, 25]);
    expect(result.hits[0]).toMatchObject({ role: "user", excerpt: "決定: 上限は 20", matchCount: 1, source: { kind: "unknown" } });
    expect(result.hits[0]!.before.map((message) => message.seq)).toEqual([19]);
    expect(result.hits[0]!.after.map((message) => message.seq)).toEqual([21]);
    expect(result.hits[1]).toMatchObject({ role: "assistant", model: "m" });
    const older = searchElements(elements, { query: "上限", context: 0, limit: 10, before: parseCursor(result.cursors!.before) });
    expect(older.hits.map((hit) => hit.seq)).toEqual([0, 5, 10, 15]);
    expect(older).toMatchObject({ totalHits: 4, hasMoreBefore: false });
    expect(older.hits[0]).toMatchObject({ before: [], after: [] });
  });

  test("一致が無ければ空。前後の要素の本文は短く切り、応答全体の上限に収める", () => {
    expect(searchElements(elementsOf(4), { query: "無い語", context: 2, limit: 10 }))
      .toEqual({ total: 4, totalHits: 0, hasMoreBefore: false, hits: [] });
    const elements = elementsOf(60, (i) => `鍵 ${"長".repeat(2_000)} ${i}`);
    const result = searchElements(elements, { query: "鍵", context: 5, limit: 50 });
    expect(result.totalHits).toBe(60);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThan(50);
    expect(result.hasMoreBefore).toBe(true);
    expect(result.hits.at(-1)!.seq).toBe(59);
    expect(result.hits[0]!.before[0]).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(READ_LIMITS.responseBytes);
  });

  test("長い検索語も応答に載るので、その分も上限に数える", () => {
    const query = "語".repeat(READ_LIMITS.maxQueryChars);
    const elements = elementsOf(60, (i) => `${query} ${"長".repeat(2_000)} ${i}`);
    const result = searchElements(elements, { query, context: 5, limit: 50 });
    expect(result.hits.length).toBeGreaterThan(0);
    const response = { v: 1, ok: true, conversationId: "c".repeat(128), agent: "claude", query, inProgress: false, ...result };
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(READ_LIMITS.responseBytes);
  });
});

// ---- コマンド（runChat） ----

function harness(options: { stdin?: string | null } = {}) {
  let output = "";
  const store = makeTempStore();
  const home = makeTempDir("chat-read-home");
  const deps: ChatDeps = {
    // read / search は engine を通さない。
    connect: async () => { throw new Error("engine を開いてはいけない"); },
    readStdin: () => options.stdin ?? null,
    isTty: false,
    config: () => ({ allowedRoots: ["/"], permissionMode: "acceptEdits", allowAuto: false, allowApprove: false, allowTakeOver: false, allowSetModel: false }),
    store: () => store,
    write: (text) => { output += text; },
    now: () => T0,
    sleep: async () => {},
    attach: () => 0,
    state: () => "idle",
    transcript: () => null,
    codexRollout: () => null,
    requestsDir: path.join(home, "requests"),
    sendLog: path.join(home, "chat-send.log"),
    chatReceipts: path.join(home, "chat-receipts.json"),
    chatDeliveries: path.join(home, "chat-deliveries.ndjson"),
  };
  return { deps, store, home, output: () => output, json: () => JSON.parse(output.trim()) as Record<string, any> };
}

const CONV = "conv-read-0001";

function claudeConversation(h: ReturnType<typeof harness>): void {
  const file = writeLines(`${CONV}.jsonl`, [
    human(T0 + 500, "テストを直して"),
    assistant(T0 + 2_000, "直しました。上限は 32 KiB です。"),
    human(T0 + 60_300, "ありがとう"),
    assistant(T0 + 62_000, "どういたしまして。"),
    human(T0 + 120_000, "端末から"),
  ]);
  h.deps.transcript = () => ({ file, cwd: "/tmp" });
  h.store.put({ name: "s-own", cwd: "/tmp", createdAt: 1, claudeSessionId: CONV, providerSessionId: CONV });
  fs.mkdirSync(h.deps.requestsDir!, { recursive: true });
  const record = request("r-1", "テストを直して", T0, { conversationId: CONV, kind: "new" });
  fs.writeFileSync(path.join(h.deps.requestsDir!, `${requestDigest("r-1").slice(0, 32)}.json`), JSON.stringify(record));
  fs.writeFileSync(h.deps.sendLog!, [
    logLine(T0 + 100, 10, `recv id=send-1 session=s-own cmid=${clientMessageIdFor("r-1")}`),
    logLine(T0 + 800, 10, "result id=send-1 status=accepted"),
    logLine(T0 + 60_000, 10, `recv id=send-2 session=s-own cmid=${APP_ID(1)}`),
    logLine(T0 + 60_600, 10, "result id=send-2 status=accepted"),
  ].join("\n") + "\n");
}

describe("chat read", () => {
  test("指定が無ければ末尾 10 件。各発話に出所、返答にモデルを添え、engine は開かない", async () => {
    const h = harness();
    claudeConversation(h);
    expect(await runChat(["read", CONV, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toEqual({
      v: 1, ok: true, conversationId: CONV, agent: "claude", inProgress: false,
      total: 5, range: { from: 0, to: 4 }, hasMoreBefore: false, hasMoreAfter: false,
      cursors: { before: `0:${T0 + 500}`, after: `4:${T0 + 120_000}` },
      messages: [
        { seq: 0, role: "user", atMs: T0 + 500, text: "テストを直して", source: { kind: "cli", confidence: "exact", requestId: "r-1" } },
        { seq: 1, role: "assistant", atMs: T0 + 2_000, text: "直しました。上限は 32 KiB です。", model: "claude-fable-5-2" },
        { seq: 2, role: "user", atMs: T0 + 60_300, text: "ありがとう", source: { kind: "app", confidence: "inferred" } },
        { seq: 3, role: "assistant", atMs: T0 + 62_000, text: "どういたしまして。", model: "claude-fable-5-2" },
        { seq: 4, role: "user", atMs: T0 + 120_000, text: "端末から", source: { kind: "terminal", confidence: "inferred" } },
      ],
    });
  });

  test("hub が届けた発話の記録があれば、アプリの発話は exact になる", async () => {
    const h = harness();
    claudeConversation(h);
    appendChatDelivery(h.deps.chatDeliveries!, {
      v: 1, atMs: T0 + 60_600, session: "s-own", conversationId: CONV, agent: "claude", clientMessageId: APP_ID(1), textHash: utteranceDigest("ありがとう"),
    });
    expect(await runChat(["read", CONV, "--json"], h.deps)).toBe(EXIT.ok);
    expect((h.json()["messages"] as Array<{ source?: unknown }>).map((message) => message.source)).toEqual([
      { kind: "cli", confidence: "exact", requestId: "r-1" },
      undefined,
      { kind: "app", confidence: "exact" },
      undefined,
      { kind: "terminal", confidence: "inferred" },
    ]);
  });

  test("--after で続きだけ、--before で手前だけ。処理中・答え待ちは inProgress", async () => {
    const h = harness();
    claudeConversation(h);
    h.deps.state = () => "busy";
    expect(await runChat(["read", CONV, "--after", `2:${T0 + 60_300}`, "--limit", "1", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ inProgress: true, range: { from: 3, to: 3 }, hasMoreAfter: true });
    const before = harness();
    claudeConversation(before);
    before.deps.state = () => "waiting";
    expect(await runChat(["read", CONV, "--before", "2", "--json"], before.deps)).toBe(EXIT.ok);
    expect(before.json()).toMatchObject({ inProgress: true, range: { from: 0, to: 1 }, hasMoreBefore: false, hasMoreAfter: true });
  });

  test("指定の誤り・古いカーソルは 2、会話が無ければ 3", async () => {
    const cases: Array<[string[], string]> = [
      [["--last", "5", "--after", "1"], "conflicting_options"],
      [["--after", "1", "--before", "3"], "conflicting_options"],
      [["--limit", "5"], "conflicting_options"],
      [["--last", "51"], "out_of_range"],
      [["--last", "0"], "out_of_range"],
      [["--max-text", "100"], "out_of_range"],
      [["--query", "上限"], "unsupported_option"],
      [["--context", "2"], "unsupported_option"],
      [["--after", "x"], "bad_cursor"],
      [["--after", "9"], "stale_cursor"],
      [["--after", `1:${T0}`], "stale_cursor"],
    ];
    for (const [extra, code] of cases) {
      const h = harness();
      claudeConversation(h);
      expect(await runChat(["read", CONV, ...extra, "--json"], h.deps), extra.join(" ")).toBe(EXIT.usage);
      expect(h.json()).toMatchObject({ ok: false, error: { code } });
    }
    const missing = harness();
    expect(await runChat(["read", "conv-none-0001", "--json"], missing.deps)).toBe(EXIT.notFound);
    expect(missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("Codex の会話は rollout から読み、発話の送信 ID で出所を付ける", async () => {
    const h = harness();
    const THREAD = "019f4c48-aaaa-7bbb-8ccc-000000000001";
    const rollout = writeLines(`rollout-2026-11-18T10-00-00-${THREAD}.jsonl`, [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      { type: "event_msg", timestamp: iso(T0), payload: { type: "task_started" } },
      codexUser(T0 + 1, "頼む", APP_ID(7)),
      codexAgent(T0 + 2, "やります"),
    ]);
    h.store.put({ name: "s-codex", cwd: "/tmp", createdAt: 1, agent: "codex", providerSessionId: THREAD });
    h.deps.codexRollout = () => rollout;
    fs.writeFileSync(h.deps.chatReceipts!, JSON.stringify({ version: 1, sessions: { "s-codex": { deliveredCodex: [APP_ID(7)] } } }));
    expect(await runChat(["read", THREAD, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({
      agent: "codex", inProgress: true, total: 2,
      messages: [
        { seq: 0, role: "user", text: "頼む", clientId: APP_ID(7), source: { kind: "app", confidence: "exact" } },
        { seq: 1, role: "assistant", text: "やります", model: "gpt-5.5" },
      ],
    });
  });

  test("人向けの表示は、位置・役割と出所・時刻の見出しと本文", async () => {
    const h = harness();
    claudeConversation(h);
    expect(await runChat(["read", CONV, "--last", "2"], h.deps)).toBe(EXIT.ok);
    expect(h.output()).toBe(`#3 assistant ${iso(T0 + 62_000)}\nどういたしまして。\n\n#4 user(terminal) ${iso(T0 + 120_000)}\n端末から\n`);
  });
});

describe("chat status（処理中に届いた通知・報告で返答を切らない）", () => {
  const lines = [
    human(T0 + 500, "調べて"),
    assistant(T0 + 1_000, "サブエージェントに調べさせます。"),
    queued(T0 + 2_000, "<task-notification> <task-id>t1</task-id> 終わった", { kind: "task-notification", producer: "session-task" }, { commandMode: "task-notification" }),
    assistant(T0 + 3_000, "途中の結果です。"),
    queued(T0 + 4_000, "<agent-message from=\"a1\">報告</agent-message>", { kind: "peer", from: "a1", senderTaskId: "a1", name: "general-purpose" }),
    queued(T0 + 5_000, "<cross-session-message from=\"uds:/tmp/x.sock\">別のセッションから</cross-session-message>", { kind: "peer", from: "uds:/tmp/x.sock", name: "rizm-38" }),
    assistant(T0 + 6_000, "最終の答えです。"),
  ];

  test("readTranscriptLines は、通知・サブエージェントの報告・別のセッションからの発話を人の発話に数えない", () => {
    const file = writeLines("status.jsonl", [
      ...lines,
      queued(T0 + 7_000, "処理中に人が送った発話"),
      // `origin` が無い旧い記録: 本文の形で見分ける。人の発話の印があれば、同じ形で始まっていても人の発話。
      { type: "attachment", timestamp: iso(T0 + 8_000), attachment: { type: "queued_command", prompt: "<task-notification> 旧い通知" } },
      { type: "attachment", timestamp: iso(T0 + 9_000), attachment: { type: "queued_command", prompt: "印の無い旧い発話" } },
      queued(T0 + 10_000, "<agent-message from=\"a1\"> を貼って質問"),
    ]);
    expect(readTranscriptLines(file).map((line) => [line.role, line.text])).toEqual([
      ["user", "調べて"],
      ["assistant", "サブエージェントに調べさせます。"],
      ["assistant", "途中の結果です。"],
      ["assistant", "最終の答えです。"],
      ["user", "処理中に人が送った発話"],
      ["user", "印の無い旧い発話"],
      ["user", "<agent-message from=\"a1\"> を貼って質問"],
    ]);
  });

  test("status --after は、依頼の後の文章を通知・報告をまたいで最後まで返す（--after なしも同じ）", async () => {
    const file = writeLines(`${CONV}.jsonl`, lines);
    const run = async (args: string[]): Promise<Record<string, any>> => {
      const h = harness();
      h.deps.transcript = () => ({ file, cwd: "/tmp" });
      h.deps.readRequest = (id) => id === "r-1" ? request("r-1", "調べて", T0, { conversationId: CONV }) : null;
      expect(await runChat(["status", CONV, ...args, "--json"], h.deps)).toBe(EXIT.ok);
      return h.json();
    };
    const reply = "サブエージェントに調べさせます。\n\n途中の結果です。\n\n最終の答えです。";
    expect(await run(["--after", "r-1"])).toMatchObject({ state: "idle", complete: true, received: true, reply });
    expect(await run([])).toMatchObject({ state: "idle", complete: true, reply });
  });
});

describe("chat search", () => {
  test("--query の語で探し、抜粋と前後の要素を返す", async () => {
    const h = harness();
    claudeConversation(h);
    expect(await runChat(["search", CONV, "--query", "32kib", "--context", "1", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toEqual({
      v: 1, ok: true, conversationId: CONV, agent: "claude", query: "32kib", inProgress: false,
      total: 5, totalHits: 1, hasMoreBefore: false, cursors: { before: `1:${T0 + 2_000}` },
      hits: [{
        seq: 1, role: "assistant", atMs: T0 + 2_000, excerpt: "直しました。上限は 32 KiB です。", matchCount: 1, model: "claude-fable-5-2",
        before: [{ seq: 0, role: "user", atMs: T0 + 500, text: "テストを直して", source: { kind: "cli", confidence: "exact", requestId: "r-1" } }],
        after: [{ seq: 2, role: "user", atMs: T0 + 60_300, text: "ありがとう", source: { kind: "app", confidence: "inferred" } }],
      }],
    });
  });

  test("--query が無ければ標準入力の 1 行目を検索語にする。空・長すぎる語・範囲の外は 2", async () => {
    const h = harness({ stdin: "ありがとう\n2 行目は使わない\n" });
    claudeConversation(h);
    expect(await runChat(["search", CONV, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ query: "ありがとう", totalHits: 1, hits: [{ seq: 2 }] });
    const cases: Array<[string[], string]> = [
      [[], "empty_query"],
      [["--query", "   "], "empty_query"],
      [["--query", "x".repeat(501)], "query_too_long"],
      [["--query", "a", "--context", "6"], "out_of_range"],
      [["--query", "a", "--limit", "51"], "out_of_range"],
      [["--query", "a", "--before", "99"], "stale_cursor"],
      [["--query", "a", "--after", "1"], "unsupported_option"],
      [["--query", "a", "--last", "5"], "unsupported_option"],
      [["--query", "a", "--max-text", "500"], "unsupported_option"],
    ];
    for (const [extra, code] of cases) {
      const bad = harness();
      claudeConversation(bad);
      expect(await runChat(["search", CONV, ...extra, "--json"], bad.deps), extra.join(" ")).toBe(EXIT.usage);
      expect(bad.json()).toMatchObject({ error: { code } });
    }
  });
});
