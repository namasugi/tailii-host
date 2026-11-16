import { describe, expect, test } from "vitest";
import { parseApiAgentProgress, progressFromSdkMessage } from "../src/apiAgent/progress.js";
import { decodeWorkerToHub } from "../src/apiAgent/workerProtocol.js";

describe("API 会話のライブ進捗", () => {
  test("SDK の本文・思考・引数は取り込まず、状態とツール名だけにする", () => {
    expect(progressFromSdkMessage({ type: "stream_event", event: { type: "content_block_start", content_block: {
      type: "thinking", thinking: "private-thinking",
    } } })).toEqual({ phase: "thinking" });
    expect(progressFromSdkMessage({ type: "stream_event", event: { type: "content_block_start", content_block: {
      type: "tool_use", name: "Read", input: { file_path: "private-path" },
    } } })).toEqual({ phase: "tool", toolName: "Read" });
    expect(progressFromSdkMessage({ type: "assistant", message: { content: [
      { type: "text", text: "private-body" }, { type: "tool_use", name: "Bash", input: { command: "private-command" } },
    ] } })).toEqual({ phase: "tool", toolName: "Bash" });
    expect(progressFromSdkMessage({ type: "user", message: { content: [{ type: "tool_result", content: "private-result" }] } }))
      .toEqual({ phase: "thinking" });
  });

  test("トークンごとのデルタと子エージェントのイベントは転送しない", () => {
    expect(progressFromSdkMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } })).toBeNull();
    expect(progressFromSdkMessage({ type: "tool_progress", parent_tool_use_id: "child", tool_name: "Write" })).toBeNull();
    expect(progressFromSdkMessage({ type: "tool_progress", parent_tool_use_id: null, tool_name: "Read" }))
      .toEqual({ phase: "tool", toolName: "Read" });
  });

  test("内部ワイヤーは既知の状態と短い識別子だけを受け付ける", () => {
    expect(decodeWorkerToHub(JSON.stringify({ t: "progress", progress: { phase: "tool", toolName: "Read", input: "private" } })))
      .toEqual({ t: "progress", progress: { phase: "tool", toolName: "Read" } });
    for (const progress of [{ phase: "future" }, { phase: "tool", toolName: "Read\nprivate" }, { phase: "tool", toolName: 1 }]) {
      expect(parseApiAgentProgress(progress)).toBeNull();
    }
  });
});
