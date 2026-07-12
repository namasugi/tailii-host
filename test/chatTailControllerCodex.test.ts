// chatTailControllerCodex.test.ts — ChatTailController の codex 分岐（openCodex）統合テスト
// open() が codex rollout を解決し chat_output を writer へ流すことを確認する。

import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { ChatTailController } from "../src/chatTailController.js";
import { CodexRolloutTailer } from "../src/codexRolloutTailer.js";
import { LineWriter } from "../src/lineWriter.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { makeTempDir } from "./helpers.js";

/** 書き込まれた NDJSON 行を ControlMessage として集める Writable。 */
function capturingWriter(): { writer: LineWriter; messages: () => ControlMessage[] } {
  const lines: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return {
    writer: new LineWriter(out),
    messages: () =>
      lines
        .join("")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => decodeControlMessage(l))
        .filter((m): m is ControlMessage => m !== null),
  };
}

function writeRollout(root: string, cwd: string, sessionId = "x", suffix = ""): void {
  const dir = path.join(root, "2026", "07", "06");
  fs.mkdirSync(dir, { recursive: true });
  const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } });
  const user = JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "コンパイルして" },
  });
  const agent = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "完了しました", phase: "final_answer" },
  });
  fs.writeFileSync(path.join(dir, `rollout${suffix}.jsonl`), [meta, user, agent].join("\n") + "\n");
}

describe("ChatTailController — codex モード", () => {
  test("open() が rollout を解決し user/assistant を chat_output として流す", async () => {
    const sessionsRoot = makeTempDir("cc-codex-sessions");
    const cwd = makeTempDir("cc-codex-cwd");
    writeRollout(sessionsRoot, cwd);

    const { writer, messages } = capturingWriter();
    const codexTailer = new CodexRolloutTailer({
      sessionsRoot,
      tailDeadlineMs: 0, // 有限 tail（EOF で終了）
      emitReplayDoneMarker: true,
    });
    const controller = new ChatTailController({
      writer,
      // claude 用 tailer は codex モードでは使われないため既定でよい。
      tailer: undefined as never,
      projectsRoot: makeTempDir("cc-codex-projects"),
      agent: "codex",
      codexTailer,
    });

    controller.open(cwd, null);
    // openCodex の pump 完了を待つ（private フィールドを参照）。
    await (controller as unknown as { currentPump: Promise<void> | null }).currentPump;

    const chats = messages().filter(
      (m): m is Extract<ControlMessage, { type: "chat_output" }> => m.type === "chat_output",
    );
    expect(chats.map((c) => [c.role, c.text])).toEqual([
      ["user", "コンパイルして"],
      ["assistant", "完了しました"],
      ["system", ""], // pc:history-done
    ]);
    // codex モードでは usage 集計対象パスは返さない。
    expect(controller.currentTranscriptPath()).toBeNull();
  });

  test("open() は Codex provider session ID に一致する rollout だけを追う", async () => {
    const sessionsRoot = makeTempDir("cc-codex-preferred-sessions");
    const cwd = makeTempDir("cc-codex-preferred-cwd");
    writeRollout(sessionsRoot, cwd, "wanted", "-wanted");
    writeRollout(sessionsRoot, cwd, "other", "-other");

    const { writer, messages } = capturingWriter();
    const controller = new ChatTailController({
      writer,
      tailer: undefined as never,
      projectsRoot: makeTempDir("cc-codex-preferred-projects"),
      agent: "codex",
      codexTailer: new CodexRolloutTailer({
        sessionsRoot,
        tailDeadlineMs: 0,
        emitReplayDoneMarker: true,
      }),
    });

    controller.open(cwd, "wanted");
    await (controller as unknown as { currentPump: Promise<void> | null }).currentPump;

    const chats = messages().filter(
      (m): m is Extract<ControlMessage, { type: "chat_output" }> => m.type === "chat_output",
    );
    expect(chats.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
