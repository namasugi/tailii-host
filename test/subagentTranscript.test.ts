import { describe, expect, it } from "vitest";
import { parseSubagentTranscript } from "../src/subagentTranscript.js";

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
