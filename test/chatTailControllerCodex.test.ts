// chatTailControllerCodex.test.ts — ChatTailController の codex 分岐（openCodex）統合テスト
// open() が codex rollout を解決し chat_output を writer へ流すことを確認する。

import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { ChatTailController } from "../src/chat/chatTailController.js";
import { ImageService } from "../src/chat/imageService.js";
import { CodexRolloutTailer } from "../src/codex/codexRolloutTailer.js";
import { LineWriter } from "../src/shared/lineWriter.js";
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

function writeRollout(root: string, cwd: string, sessionId = "x", suffix = "", text = "コンパイルして"): void {
  const dir = path.join(root, "2026", "07", "06");
  fs.mkdirSync(dir, { recursive: true });
  const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } });
  const user = JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: text },
  });
  const agent = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "完了しました", phase: "final_answer" },
  });
  const started = JSON.stringify({
    type: "event_msg", payload: { type: "task_started", turn_id: `turn-${sessionId}` },
  });
  const completed = JSON.stringify({
    type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${sessionId}` },
  });
  fs.writeFileSync(
    path.join(dir, `rollout${suffix}.jsonl`),
    [meta, started, user, agent, completed].join("\n") + "\n",
  );
}

describe("ChatTailController — codex モード", () => {
  test.each(["client-attachment", null])("現行 UserMessage の添付を live/楽観バブルと同じ ID へ紐づける（%s）", async (clientId) => {
    const root = makeTempDir("cc-codex-current-attachment");
    const imagePath = path.join(root, ".tailii", "uploads", "img-A7BCDDF4.jpg");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff]));
    const sessionsRoot = path.join(root, "sessions");
    const dir = path.join(sessionsRoot, "2026", "09", "08");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout.jsonl"), [
      { type: "session_meta", payload: { id: "thread-1", cwd: root } },
      { type: "response_item", payload: { type: "message", id: "context", role: "user",
        content: [{ type: "input_text", text: "AGENTS.md instructions" }] } },
      { type: "response_item", payload: { type: "message", id: "raw-user", role: "user",
        content: [{ type: "input_text", text: `${imagePath} この画像を見て` }] } },
      { type: "event_msg", payload: { type: "item_completed", item: {
        type: "UserMessage", id: "user-item", client_id: clientId,
        content: [{ type: "text", text: `${imagePath} この画像を見て`, text_elements: [] }],
      } } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const { writer, messages } = capturingWriter();
    const controller = new ChatTailController({
      writer, tailer: undefined as never, projectsRoot: root, agent: "codex",
      imageService: new ImageService({ indexBase: path.join(root, "index"),
        thumbnailer: async () => ({ thumbnailBase64: "QUFB", width: 8, height: 6 }) }),
      codexTailer: new CodexRolloutTailer({ sessionsRoot, tailDeadlineMs: 0, emitReplayDoneMarker: true }),
    });
    controller.open(root, "thread-1");
    await (controller as unknown as { currentPump: Promise<void> | null }).currentPump;
    const streamId = clientId === null ? "codex-item-user-item" : `codex-user-${clientId}`;
    expect(messages()).toMatchObject([
      { type: "chat_output", role: "system", streamId: "pc:history-begin" },
      ...(clientId === null ? [] : [{ type: "chat_stream_alias", streamId, aliasStreamIds: ["codex-item-user-item"] }]),
      { type: "chat_output", role: "user", streamId, text: `${imagePath} この画像を見て` },
      { type: "image_available", id: `att-${streamId}-0`, path: imagePath },
      { type: "chat_output", role: "system", streamId: "pc:history-done" },
    ]);
    controller.stop();
  });

  test("添付サムネを元発話の直後へ送り、再オープンでも同じ ID と原本取得先を使う", async () => {
    const root = makeTempDir("cc-codex-attachments");
    const uploadDir = path.join(root, ".tailii", "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const missingPath = path.join(uploadDir, "missing.jpg");
    const imagePath = path.join(uploadDir, "img-A7BCDDF4.jpg");
    const original = Buffer.from([0xff, 0xd8, 0xff]);
    fs.writeFileSync(imagePath, original);
    const sessionsRoot = path.join(root, "sessions");
    writeRollout(sessionsRoot, root, "x", "",
      `${missingPath} ${imagePath} ${imagePath} ${uploadDir}/notes.pdf codexが繋がらない`);
    const imageService = new ImageService({
      indexBase: path.join(root, "index"),
      thumbnailer: async () => ({ thumbnailBase64: "QUFB", width: 8, height: 6 }),
    });

    for (let replay = 0; replay < 2; replay += 1) {
      const { writer, messages } = capturingWriter();
      const controller = new ChatTailController({
        writer, tailer: undefined as never, projectsRoot: root, agent: "codex", imageService,
        codexTailer: new CodexRolloutTailer({ sessionsRoot, tailDeadlineMs: 0, emitReplayDoneMarker: true }),
      });
      controller.open(root, "x");
      await (controller as unknown as { currentPump: Promise<void> | null }).currentPump;
      const output = messages();
      expect(output.map((m) => m.type)).toEqual([
        "chat_output", "chat_output", "image_available", "chat_output", "chat_output",
      ]);
      expect(output[2]).toMatchObject({
        id: "att-codex-turn-1-1", path: imagePath, mime: "image/jpeg", thumbnail: "QUFB",
      });
      controller.stop();
    }
    expect(imageService.fetch("att-codex-turn-1-1")).toEqual([{
      type: "image_fetch_response", v: 1, id: "att-codex-turn-1-1",
      seq: 0, data: original.toString("base64"), eof: true, mime: "image/jpeg",
    }]);
  });

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
    const lifecycle: Array<{ state: "active" | "done"; turnId: string }> = [];
    const controller = new ChatTailController({
      writer,
      // claude 用 tailer は codex モードでは使われないため既定でよい。
      tailer: undefined as never,
      projectsRoot: makeTempDir("cc-codex-projects"),
      agent: "codex",
      codexTailer,
      onCodexTurnLifecycle: (event) => lifecycle.push(event),
    });

    controller.open(cwd, null);
    // openCodex の pump 完了を待つ（private フィールドを参照）。
    await (controller as unknown as { currentPump: Promise<void> | null }).currentPump;

    const chats = messages().filter(
      (m): m is Extract<ControlMessage, { type: "chat_output" }> => m.type === "chat_output",
    );
    expect(chats.map((c) => [c.role, c.text])).toEqual([
      ["system", ""], // pc:history-begin
      ["user", "コンパイルして"],
      ["assistant", "完了しました"],
      ["system", ""], // pc:history-done
    ]);
    expect(lifecycle).toEqual([{ state: "done", turnId: "turn-x" }]);
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

  test("subagentTranscript() は Codex 子 rollout の実行履歴を返す", async () => {
    const sessionsRoot = makeTempDir("cc-codex-subagent-sessions");
    const cwd = makeTempDir("cc-codex-subagent-cwd");
    writeRollout(sessionsRoot, cwd, "parent", "-parent");
    const dir = path.join(sessionsRoot, "2026", "07", "07");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-child.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: {
        id: "child", cwd, source: { subagent: { thread_spawn: {
          agent_path: "/root/tester",
        } } },
      } }),
      JSON.stringify({ type: "response_item", payload: {
        type: "agent_message", author: "/root", recipient: "/root/tester",
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n検証して" }],
      } }),
      JSON.stringify({ type: "event_msg", payload: {
        type: "agent_message", message: "検証完了", phase: "final_answer",
      } }),
    ].join("\n") + "\n");

    const { writer } = capturingWriter();
    const controller = new ChatTailController({
      writer,
      tailer: undefined as never,
      projectsRoot: makeTempDir("cc-codex-subagent-projects"),
      agent: "codex",
      codexTailer: new CodexRolloutTailer({ sessionsRoot, tailDeadlineMs: 0 }),
    });

    controller.open(cwd, "parent");
    await (controller as unknown as { currentPump: Promise<void> | null }).currentPump;

    expect(controller.subagentTranscript("child").entries).toEqual([
      { role: "user", text: "検証して" },
      { role: "assistant", text: "検証完了" },
    ]);
  });
});
