// subagentTranscriptPage.test.ts — エージェントの会話全文のページ読み（agent-conversation-paging）。
// 正本は protocol/subagent-transcript-page-v1.ndjson（root の protocol/ と byte 一致）。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyToolResultLabel, parseSubagentTranscript, transcriptPage } from "../src/chat/subagentTranscript.js";
import { decodeHubClientLine } from "../src/hub/hubProtocol.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import type { SubagentTranscriptEntry } from "../src/protocol.js";

const hostRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = (count: number): SubagentTranscriptEntry[] =>
  Array.from({ length: count }, (_, i) => ({ role: "assistant", text: `e${i}` }));

describe("transcriptPage", () => {
  it("before 省略は最新 200 件、omitted は先頭の通し番号", () => {
    const page = transcriptPage(entries(450));
    expect(page.omitted).toBe(250);
    expect(page.entries).toHaveLength(200);
    expect(page.entries[0]!.text).toBe("e250");
    expect(page.entries.at(-1)!.text).toBe("e449");
  });

  it("before は通し番号より前の最大 200 件を返す（さかのぼりで継ぎ目が欠けない）", () => {
    const older = transcriptPage(entries(450), 250);
    expect(older.omitted).toBe(50);
    expect(older.entries[0]!.text).toBe("e50");
    expect(older.entries.at(-1)!.text).toBe("e249");
    const oldest = transcriptPage(entries(450), 50);
    expect(oldest.omitted).toBe(0);
    expect(oldest.entries.map((e) => e.text)).toEqual(entries(50).map((e) => e.text));
  });

  it("before が範囲外でも壊れない", () => {
    expect(transcriptPage(entries(10), 0)).toEqual({ entries: [], omitted: 0 });
    expect(transcriptPage(entries(10), 999).entries).toHaveLength(10);
  });
});

describe("golden: subagent-transcript-page-v1.ndjson", () => {
  const lines = fs.readFileSync(path.join(hostRoot, "protocol", "subagent-transcript-page-v1.ndjson"), "utf8")
    .split("\n").filter((line) => line.length > 0);

  it("全行が byte-exact でラウンドトリップし、before を復号する", () => {
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect((decodeControlMessage(lines[0]!) as { before?: number }).before).toBe(200);
    expect((decodeControlMessage(lines[1]!) as { before?: number }).before).toBeUndefined();
    const response = decodeControlMessage(lines[2]!);
    if (response.type !== "subagent_transcript_response") throw new Error("transcript を期待");
    expect(response.entries[0]?.toolUseId).toBe("tool-read-a");
    expect(response.entries[1]).not.toHaveProperty("toolUseId");
  });

  it("負・小数の before は不正", () => {
    expect(() => decodeControlMessage('{"before":-1,"id":"x","nodeId":"a","type":"subagent_transcript_request","v":2}')).toThrow();
    expect(() => decodeControlMessage('{"before":1.5,"id":"x","nodeId":"a","type":"subagent_transcript_request","v":2}')).toThrow();
  });
});

describe("hub: conversation_subagent_transcript_request の before", () => {
  it("before を通し、不正値は落とす（旧形式と同じ最新ページ）", () => {
    const base = { type: "conversation_subagent_transcript_request", id: "r", session: "s", nodeId: "a" };
    expect(decodeHubClientLine(JSON.stringify({ ...base, before: 120 }))).toEqual({ ...base, before: 120 });
    expect(decodeHubClientLine(JSON.stringify({ ...base, before: -3 }))).toEqual(base);
    expect(decodeHubClientLine(JSON.stringify(base))).toEqual(base);
  });
});

describe("テキストの無いツール結果も 1 行にする（呼び出しと結果の対応をずらさない）", () => {
  it("画像・ツール定義・空の結果に代わりの 1 行を出す", () => {
    const line = (content: unknown[]) => JSON.stringify({ type: "user", timestamp: "2026-11-10T00:00:00.000Z",
      message: { role: "user", content } });
    const jsonl = [
      JSON.stringify({ type: "assistant", timestamp: "2026-11-10T00:00:00.000Z", message: { role: "assistant", content: [
        { type: "tool_use", id: "a", name: "ToolSearch", input: { query: "x" } },
        { type: "tool_use", id: "b", name: "Read", input: { file_path: "/a.png" } },
        { type: "tool_use", id: "c", name: "Bash", input: { command: "true" } },
      ] } }),
      line([{ type: "tool_result", tool_use_id: "a", content: [{ type: "tool_reference", tool_name: "WebSearch" }, { type: "tool_reference", tool_name: "Monitor" }] }]),
      line([{ type: "tool_result", tool_use_id: "b", content: [{ type: "image", source: { type: "base64", data: "AA" } }] }]),
      line([{ type: "tool_result", tool_use_id: "c", content: "" }]),
    ].join("\n");
    const results = parseSubagentTranscript(jsonl).entries.filter((entry) => entry.kind === "tool_result").map((entry) => entry.text);
    expect(results).toEqual(["（ツールの定義 2 件を読み込み）", "（画像）", "（結果なし）"]);
    expect(emptyToolResultLabel([{ type: "image" }, { type: "image" }])).toBe("（画像 2 枚）");
  });
});
