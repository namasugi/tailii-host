// chatTailControllerReadImage.test.ts — ChatTailController の Read 画像インライン化（claude pump）
// tool_activity(Read, 画像パス) が流れたとき、image_available を後続で発行し iOS のインライン
// サムネ経路（既存 chat-attachments と同じ）へ載せることを確認する（chat-inline-read-image）。

import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { ChatTailController } from "../src/chatTailController.js";
import { ImageService } from "../src/imageService.js";
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
        .map((l) => decodeControlMessage(l)),
  };
}

/** 指定メッセージ列を一度だけ流して終わる有限スタブ tailer。 */
function fakeTailer(messages: ControlMessage[]): {
  streamProjectDir: (...args: unknown[]) => AsyncGenerator<ControlMessage, void, void>;
} {
  return {
    async *streamProjectDir() {
      for (const message of messages) yield message;
    },
  };
}

/** sips を使わずに固定サムネを返す ImageService（実ファイル存在＋画像拡張子だけは本物を要求）。 */
function stubImageService(indexBase: string): ImageService {
  return new ImageService({
    indexBase,
    thumbnailer: async () => ({ thumbnailBase64: "QUFB", width: 8, height: 6 }),
  });
}

describe("ChatTailController — Read 画像のインライン化", () => {
  test("tool_activity(Read, .png) で read-<id> の image_available を発行する", async () => {
    const cwd = makeTempDir("cc-read-cwd");
    const imagePath = path.join(makeTempDir("cc-read-img"), "shot.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // 実ファイルが必要

    const { writer, messages } = capturingWriter();
    const controller = new ChatTailController({
      writer,
      tailer: fakeTailer([
        {
          type: "tool_activity",
          v: 1,
          activity: {
            id: "toolu_abc",
            name: "Read",
            label: `既読 ${imagePath}`,
            file: imagePath,
            commandTruncated: false,
            descriptionTruncated: false,
          },
        },
      ]) as never,
      subagentTailer: fakeTailer([]) as never,
      projectsRoot: makeTempDir("cc-read-projects"),
      imageService: stubImageService(makeTempDir("cc-read-index")),
    });

    controller.open(cwd, null);
    const c = controller as unknown as {
      currentPump: Promise<void> | null;
      currentSubagentPump: Promise<void> | null;
    };
    await c.currentPump;
    await c.currentSubagentPump;

    const available = messages().filter(
      (m): m is Extract<ControlMessage, { type: "image_available" }> =>
        m.type === "image_available",
    );
    expect(available).toHaveLength(1);
    expect(available[0]).toMatchObject({
      id: "read-toolu_abc",
      path: imagePath,
      mime: "image/png",
      thumbnail: "QUFB",
      width: 8,
      height: 6,
    });
  });

  test("tool_activity(Read, 非画像) では image_available を発行しない", async () => {
    const cwd = makeTempDir("cc-read-cwd2");
    const { writer, messages } = capturingWriter();
    const controller = new ChatTailController({
      writer,
      tailer: fakeTailer([
        {
          type: "tool_activity",
          v: 1,
          activity: {
            id: "toolu_ts",
            name: "Read",
            label: "既読 /tmp/main.ts",
            file: "/tmp/main.ts",
            commandTruncated: false,
            descriptionTruncated: false,
          },
        },
      ]) as never,
      subagentTailer: fakeTailer([]) as never,
      projectsRoot: makeTempDir("cc-read-projects2"),
      imageService: stubImageService(makeTempDir("cc-read-index2")),
    });

    controller.open(cwd, null);
    const c = controller as unknown as {
      currentPump: Promise<void> | null;
      currentSubagentPump: Promise<void> | null;
    };
    await c.currentPump;
    await c.currentSubagentPump;

    expect(messages().filter((m) => m.type === "image_available")).toHaveLength(0);
  });
});
