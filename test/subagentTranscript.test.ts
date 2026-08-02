import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCodexSubagentTranscript,
  parseSubagentTranscript,
  readBackgroundOutput,
} from "../src/chat/subagentTranscript.js";
import { makeTempDir } from "./helpers.js";

describe("parseSubagentTranscript", () => {
  it("user/assistant/tool_use/tool_result を表示行へ変換する", () => {
    const fixture = [
      JSON.stringify({
        timestamp: "2026-07-12T01:02:03.456Z",
        type: "user", message: { role: "user", content: "調べて" },
      }),
      JSON.stringify({ timestamp: "2026-07-12T01:02:04.000Z", type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "確認します。" },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/a.txt" } },
      ] } }),
      JSON.stringify({ timestamp: "invalid", type: "user", message: { role: "user", content: [
        { type: "tool_result", content: "result text" },
      ] } }),
    ].join("\n");

    expect(parseSubagentTranscript(fixture)).toEqual({
      entries: [
        { role: "user", text: "調べて", ts: 1_783_818_123_456 },
        { role: "assistant", text: "確認します。", ts: 1_783_818_124_000 },
        {
          role: "tool", text: 'Read: {"file_path":"/tmp/a.txt"}',
          ts: 1_783_818_124_000, kind: "tool_use",
        },
        { role: "tool", text: "result text", kind: "tool_result" },
      ],
      omitted: 0,
    });
  });

  it("timestamp 欠落時は ts を省略する", () => {
    const fixture = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "時刻なし" }] },
    });

    expect(parseSubagentTranscript(fixture).entries).toEqual([
      { role: "assistant", text: "時刻なし" },
    ]);
  });

  it("timestamp と kind を保ったまま直近 200 件へクランプする", () => {
    const fixture = Array.from({ length: 205 }, (_, index) => JSON.stringify({
      timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      type: "assistant",
      message: { role: "assistant", content: [
        { type: "tool_use", name: "Read", input: { index } },
      ] },
    })).join("\n");

    const result = parseSubagentTranscript(fixture);
    expect(result.omitted).toBe(5);
    expect(result.entries).toHaveLength(200);
    expect(result.entries[0]).toEqual({
      role: "tool", text: "Read: {\"index\":5}", ts: 1_700_000_005_000, kind: "tool_use",
    });
    expect(result.entries.at(-1)?.kind).toBe("tool_use");
  });
});

describe("readBackgroundOutput", () => {
  it("プレーンテキスト出力を tool_result 1 entry で返す", () => {
    const dir = makeTempDir("bg-output");
    const file = path.join(dir, "btask.output");
    fs.writeFileSync(file, "line1\nline2\n");

    const result = readBackgroundOutput(file);
    expect(result.omitted).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ role: "tool", text: "line1\nline2\n", kind: "tool_result" });
    expect(typeof result.entries[0]!.ts).toBe("number");
  });

  it("長大出力は末尾へクランプし omitted で省略を明示する", () => {
    const dir = makeTempDir("bg-output-clamp");
    const file = path.join(dir, "btask.output");
    fs.writeFileSync(file, "x".repeat(9_000) + "TAIL");

    const result = readBackgroundOutput(file);
    expect(result.omitted).toBe(1);
    expect(result.entries[0]!.text.length).toBe(8_000);
    expect(result.entries[0]!.text.endsWith("TAIL")).toBe(true);
  });

  it("不在ファイル・null は空応答", () => {
    expect(readBackgroundOutput(null)).toEqual({ entries: [], omitted: 0 });
    expect(readBackgroundOutput("/nonexistent/bg.output")).toEqual({ entries: [], omitted: 0 });
  });
});

describe("parseCodexSubagentTranscript", () => {
  it("fork 前の親履歴を除外し、子の発話とツール実行だけを返す", () => {
    const fixture = [
      JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: {
        agent_path: "/root/background_view_test",
      } } } } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:26.000Z", type: "event_msg",
        payload: { type: "agent_message", message: "親の履歴" } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:28.000Z", type: "response_item", payload: {
        type: "agent_message", author: "/root", recipient: "/root/background_view_test",
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nテストを実行" }],
      } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:31.000Z", type: "event_msg",
        payload: { type: "agent_message", message: "確認します" } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:32.000Z", type: "response_item", payload: {
        type: "custom_tool_call", call_id: "call-1", name: "exec",
        input: 'await tools.exec_command({"cmd":"npm test"})',
      } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:33.000Z", type: "response_item", payload: {
        type: "custom_tool_call_output", call_id: "call-1",
        output: [{ type: "input_text", text: "90 passed" }],
      } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:34.000Z", type: "event_msg",
        payload: { type: "agent_message", message: "完了しました" } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:35.000Z", type: "response_item", payload: {
        type: "function_call", call_id: "call-2", name: "view_image",
        arguments: JSON.stringify({ path: "/tmp/result.png" }),
      } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:36.000Z", type: "response_item", payload: {
        type: "function_call_output", call_id: "call-2", output: "画像を確認",
      } }),
      JSON.stringify({ timestamp: "2026-08-02T03:13:37.000Z", type: "response_item", payload: {
        type: "function_call", call_id: "call-3", name: "send_message",
        arguments: JSON.stringify({ target: "/root", message: "encrypted-secret" }),
      } }),
    ].join("\n");

    expect(parseCodexSubagentTranscript(fixture)).toEqual({
      entries: [
        { role: "user", text: "テストを実行", ts: Date.parse("2026-08-02T03:13:28.000Z") },
        { role: "assistant", text: "確認します", ts: Date.parse("2026-08-02T03:13:31.000Z") },
        {
          role: "tool", text: "Bash: npm test",
          ts: Date.parse("2026-08-02T03:13:32.000Z"), kind: "tool_use",
        },
        {
          role: "tool", text: "90 passed",
          ts: Date.parse("2026-08-02T03:13:33.000Z"), kind: "tool_result",
        },
        { role: "assistant", text: "完了しました", ts: Date.parse("2026-08-02T03:13:34.000Z") },
        {
          role: "tool", text: 'view_image: {"path":"/tmp/result.png"}',
          ts: Date.parse("2026-08-02T03:13:35.000Z"), kind: "tool_use",
        },
        {
          role: "tool", text: "画像を確認",
          ts: Date.parse("2026-08-02T03:13:36.000Z"), kind: "tool_result",
        },
        {
          role: "tool", text: "send_message",
          ts: Date.parse("2026-08-02T03:13:37.000Z"), kind: "tool_use",
        },
      ],
      omitted: 0,
    });
  });
});
