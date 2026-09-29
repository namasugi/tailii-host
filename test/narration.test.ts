// narration.test.ts
// thinking ブロックとして記録された途中経過の発話（narration）の判定と、各読み手への反映。
// 署名は実物を置かず、実測した layout（top{1:varint, 2:bytes, 3:varint} → 2 の中{1:bytes(header), …}
// → header{1,3,7:varint, 8:string 種別}）どおりに protobuf を組み立てる。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import { parseSubagentTranscript } from "../src/chat/subagentTranscript.js";
import { TranscriptTailer, extractTurn } from "../src/chat/transcriptTailer.js";
import { ClaudeSessionStore, scanTranscriptTail } from "../src/sessions/claudeSessionStore.js";
import { searchClaudeSessions } from "../src/sessions/sessionSearch.js";
import { narrationText, signatureKind } from "../src/shared/narration.js";
import { makeTempDir } from "./helpers.js";

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function varintField(field: number, value: number): number[] {
  return [...varint(field * 8), ...varint(value)];
}

function bytesField(field: number, payload: number[]): number[] {
  return [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
}

function filler(length: number): number[] {
  return Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
}

/** 実測 layout どおりの署名を、種別だけ差し替えて作る。 */
function signatureOf(kind: string | null): string {
  const header = [
    ...varintField(1, 18),
    ...varintField(3, 2),
    ...varintField(7, 1),
    ...(kind === null ? [] : bytesField(8, [...Buffer.from(kind, "utf8")])),
  ];
  const envelope = [
    ...bytesField(1, header),
    ...bytesField(2, filler(12)),
    ...bytesField(3, filler(12)),
    ...bytesField(4, filler(48)),
    ...bytesField(5, filler(300)),
  ];
  const top = [...varintField(1, 4), ...bytesField(2, envelope), ...varintField(3, 1)];
  return Buffer.from(top).toString("base64");
}

function thinkingBlock(kind: string | null, thinking: string): Record<string, unknown> {
  return { type: "thinking", thinking, signature: signatureOf(kind) };
}

function assistantLine(uuid: string, content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant", uuid, timestamp: "2026-09-28T06:06:48.125Z",
    message: { role: "assistant", model: "claude-fable-5-1", content, stop_reason: "tool_use" },
    ...extra,
  });
}

async function collect(gen: AsyncGenerator<ControlMessage, void, void>): Promise<ControlMessage[]> {
  const out: ControlMessage[] = [];
  for await (const message of gen) out.push(message);
  return out;
}

describe("signatureKind / narrationText", () => {
  test("署名の種別を読む", () => {
    expect(signatureKind(signatureOf("narration"))).toBe("narration");
    expect(signatureKind(signatureOf("thinking"))).toBe("thinking");
    expect(signatureKind(signatureOf("summary"))).toBe("summary");
  });

  test("種別の無い署名・壊れた署名・base64 でない署名は null", () => {
    expect(signatureKind(signatureOf(null))).toBeNull();
    expect(signatureKind("")).toBeNull();
    expect(signatureKind("これは署名ではない")).toBeNull();
    // 途中で切れた protobuf（length が残りを超える）。
    const whole = Buffer.from(signatureOf("narration"), "base64");
    expect(signatureKind(whole.subarray(0, whole.length - 20).toString("base64"))).toBeNull();
    // 未知の wire type（3 = group）が混じる。
    expect(signatureKind(Buffer.from([...varint(1 * 8 + 3)]).toString("base64"))).toBeNull();
  });

  test("不正な base64 padding は読まず、padding 省略は読める", () => {
    const signature = signatureOf("narration");
    expect(signature.endsWith("=")).toBe(true);
    expect(signatureKind(signature + "=")).toBeNull();
    expect(signatureKind(signature.replace(/=+$/u, ""))).toBe("narration");
  });

  test("narration は本文（前後の空白を除く）を返す", () => {
    expect(narrationText(thinkingBlock("narration", "原因を調べます。\n\n"))).toBe("原因を調べます。");
  });

  test("不正な protobuf tag・uint64 overflow を含む署名は narration と判定しない", () => {
    const signature = [...Buffer.from(signatureOf("narration"), "base64")];
    for (const suffix of [
      [0, 0], // field number 0 は protobuf に存在しない。
      [...varint(2 ** 32), 0], // field number の上限を超える tag。
      [...varint(9 * 8), ...Array<number>(9).fill(0xff), 0x02],
    ]) {
      expect(signatureKind(Buffer.from([...signature, ...suffix]).toString("base64"))).toBeNull();
    }
  });

  test("種別と無関係な有効な uint64・固定長フィールドは読み飛ばす", () => {
    const signature = [...Buffer.from(signatureOf("narration"), "base64")];
    const extra = [
      ...varint(9 * 8), ...Array<number>(9).fill(0xff), 0x01,
      ...varint(10 * 8 + 1), ...filler(8),
      ...varint(11 * 8 + 5), ...filler(4),
    ];
    expect(signatureKind(Buffer.from([...signature, ...extra]).toString("base64"))).toBe("narration");
  });

  test("通常の thinking・要約・本文が空の narration は発話にしない", () => {
    expect(narrationText(thinkingBlock("thinking", "内部の推論"))).toBeNull();
    expect(narrationText(thinkingBlock("summary", "推論の要約"))).toBeNull();
    expect(narrationText(thinkingBlock("narration", ""))).toBeNull();
    expect(narrationText(thinkingBlock("narration", " \n\n"))).toBeNull();
  });

  test("thinking 以外のブロック・署名の無いブロックは対象外", () => {
    expect(narrationText({ type: "text", text: "本文", signature: signatureOf("narration") })).toBeNull();
    expect(narrationText({ type: "thinking", thinking: "本文" })).toBeNull();
    expect(narrationText({ type: "thinking", thinking: "本文", signature: "" })).toBeNull();
    expect(narrationText({ type: "redacted_thinking", data: "x" })).toBeNull();
    expect(narrationText(null)).toBeNull();
    expect(narrationText("narration")).toBeNull();
  });
});

describe("TranscriptTailer — narration", () => {
  test("narration の行は assistant の発話として流す", () => {
    const turn = extractTurn(assistantLine("n1", [thinkingBlock("narration", "transcript を確認します。\n\n")]));
    expect(turn?.role).toBe("assistant");
    expect(turn?.text).toBe("transcript を確認します。");
    expect(turn?.id).toBe("n1");
  });

  test("通常の thinking の行は本文を持たない（発話として流さない）", () => {
    expect(extractTurn(assistantLine("t1", [thinkingBlock("thinking", "")]))?.text).toBe("");
    expect(extractTurn(assistantLine("t2", [thinkingBlock("thinking", "内部の推論")]))?.text).toBe("");
    expect(extractTurn(assistantLine("t3", [thinkingBlock("summary", "推論の要約")]))?.text).toBe("");
  });

  test("user 行の thinking 形は読まない", () => {
    const line = JSON.stringify({
      type: "user", uuid: "u1",
      message: { role: "user", content: [thinkingBlock("narration", "発話ではない")] },
    });
    expect(extractTurn(line)?.text).toBe("");
  });

  test("text と narration の混在でも発話の順序を保ち、通常の thinking は含めない", () => {
    const turn = extractTurn(assistantLine("mixed", [
      { type: "text", text: "前文。\n\n" },
      thinkingBlock("thinking", "内部の推論"),
      thinkingBlock("narration", "途中経過。"),
      { type: "text", text: "\n\n後文。" },
    ]));
    expect(turn?.text).toBe("前文。\n\n途中経過。\n\n後文。");
  });

  test("narration 側の末尾改行を text との段落境界として保つ", () => {
    const turn = extractTurn(assistantLine("paragraphs", [
      thinkingBlock("narration", "確認します。\n\n"),
      { type: "text", text: "確認できました。" },
    ]));
    expect(turn?.text).toBe("確認します。\n\n確認できました。");
  });

  test("初回履歴の後に分割追記された narration も、完成後に一度だけ配信する", async () => {
    const dir = makeTempDir("narration-live");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, "");
    const controller = new AbortController();
    const stream = new TranscriptTailer({
      pollIntervalMs: 1, tailIndefinitely: true, emitReplayDoneMarker: true,
    }).streamTranscript(transcript, controller.signal);
    const messages: ControlMessage[] = [];
    const line = assistantLine("live", [thinkingBlock("narration", "調査を進めています。")]);
    let completed = false;
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      for await (const message of stream) {
        messages.push(message);
        if (message.type === "chat_output" && message.streamId === "pc:history-done") {
          fs.appendFileSync(transcript, line.slice(0, -10));
          setTimeout(() => {
            if (!controller.signal.aborted) {
              fs.appendFileSync(transcript, line.slice(-10) + "\n" +
                assistantLine("done", [{ type: "text", text: "完了。" }]) + "\n");
            }
          }, 10);
        }
        if (message.type === "chat_output" && message.streamId === "done") {
          completed = true;
          controller.abort();
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    expect(completed).toBe(true);
    expect(messages.filter((message) => message.type === "chat_output" && message.streamId === "live")).toEqual([
      { type: "chat_output", v: 1, streamId: "live", role: "assistant", text: "調査を進めています。", eof: true },
    ]);
  });

  test("初回 EOF が narration の書き込み途中でも、後続バイトをつないで配信する", async () => {
    const dir = makeTempDir("narration-initial-partial");
    const transcript = path.join(dir, "t.jsonl");
    const line = assistantLine("partial", [thinkingBlock("narration", "途中から購読しました。")]);
    fs.writeFileSync(transcript, line.slice(0, -10));
    const controller = new AbortController();
    const messages: ControlMessage[] = [];
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      for await (const message of new TranscriptTailer({
        pollIntervalMs: 1, tailIndefinitely: true, emitReplayDoneMarker: true,
      }).streamTranscript(transcript, controller.signal)) {
        messages.push(message);
        if (message.type === "chat_output" && message.streamId === "pc:history-done") {
          fs.appendFileSync(transcript, line.slice(-10) + "\n" +
            assistantLine("done", [{ type: "text", text: "完了。" }]) + "\n");
        }
        if (message.type === "chat_output" && message.streamId === "done") controller.abort();
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    expect(messages.filter((message) => message.type === "chat_output" && message.streamId === "partial")).toEqual([
      { type: "chat_output", v: 1, streamId: "partial", role: "assistant", text: "途中から購読しました。", eof: true },
    ]);
  });

  test("実際の並び（空の thinking → narration → tool_use）を発話・ツールの順で流す", async () => {
    const dir = makeTempDir("tailer-narration");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-28T06:06:40.000Z",
        message: { role: "user", content: "調べて" } }),
      assistantLine("a0", [thinkingBlock("thinking", "")]),
      assistantLine("a1", [thinkingBlock("narration", "該当の会話を特定できました。\n\n")]),
      assistantLine("a2", [{ type: "tool_use", id: "toolu_1", name: "Bash",
        input: { command: "ls", description: "List files" } }]),
      assistantLine("a3", [{ type: "text", text: "結果です。" }]),
    ].join("\n") + "\n");
    const messages = await collect(new TranscriptTailer({ pollIntervalMs: 10, emitReplayDoneMarker: true })
      .streamTranscript(transcript));
    // 旧キャッシュに無い narration を末尾へ足さず、iOS の履歴照合で元の位置へ戻す。
    expect(messages[0]).toMatchObject({ type: "chat_output", streamId: "pc:history-begin" });
    expect(messages.at(-1)).toMatchObject({ type: "chat_output", streamId: "pc:history-done" });
    const visible = messages.flatMap((message) => {
      if (message.type === "tool_activity") return [`tool:${message.activity.id}`];
      if (message.type !== "chat_output" || message.streamId.startsWith("pc:")) return [];
      return [`${message.role}:${message.streamId}:${message.text}`];
    });
    expect(visible).toEqual([
      "user:u1:調べて",
      "assistant:a1:該当の会話を特定できました。",
      "tool:toolu_1",
      "assistant:a3:結果です。",
    ]);
  });

  test("再接続の差分では全履歴開始を流さず、新しい narration だけを配信する", async () => {
    const dir = makeTempDir("narration-diff");
    fs.writeFileSync(path.join(dir, "session.jsonl"), [
      assistantLine("old", [thinkingBlock("narration", "以前の途中経過。")]),
      assistantLine("new", [thinkingBlock("narration", "再接続中の途中経過。")],
        { timestamp: "2026-09-28T06:07:00.000Z" }),
    ].join("\n") + "\n");
    const messages = await collect(new TranscriptTailer({ emitReplayDoneMarker: true })
      .streamProjectDir(dir, "session", Date.parse("2026-09-28T06:06:50.000Z")));
    expect(messages.filter((message) => message.type === "chat_output")
      .map((message) => message.streamId)).toEqual(["pc:model", "new", "pc:history-done"]);
  });

  test("改行の無い完成済み narration も履歴完了前に一度だけ配信する", async () => {
    const dir = makeTempDir("narration-no-newline");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, assistantLine("no-newline", [thinkingBlock("narration", "確認中です。") ]));
    const messages = await collect(new TranscriptTailer({ emitReplayDoneMarker: true }).streamTranscript(transcript));
    expect(messages.filter((message) => message.type === "chat_output" && message.streamId === "no-newline")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: "chat_output", streamId: "pc:history-done" });
  });
});

describe("narration — 一覧プレビュー / 検索 / サブエージェント transcript", () => {
  const lines = [
    JSON.stringify({ type: "user", cwd: "/tmp/proj", timestamp: "2026-09-28T06:06:40.000Z",
      message: { role: "user", content: "調べて" } }),
    assistantLine("a0", [thinkingBlock("thinking", "needle-hidden の推論")]),
    assistantLine("a1", [thinkingBlock("narration", "needle-narration を確認します。\n\n")]),
    assistantLine("a2", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
  ];

  test("一覧の最終メッセージは narration を応答として拾う", () => {
    const dir = makeTempDir("narration-tail");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, lines.join("\n") + "\n");
    expect(scanTranscriptTail(transcript).lastMessage).toBe("needle-narration を確認します。");
  });

  test("検索は narration に当たり、通常の thinking には当たらない", () => {
    const root = makeTempDir("narration-search");
    const slug = path.join(root, "-tmp-proj");
    fs.mkdirSync(slug, { recursive: true });
    fs.writeFileSync(path.join(slug, "nnnnnnnn-search.jsonl"), lines.join("\n") + "\n");
    const store = new ClaudeSessionStore(root);
    expect(searchClaudeSessions(store, "needle-hidden").results).toEqual([]);
    const hit = searchClaudeSessions(store, "needle-narration").results;
    expect(hit).toHaveLength(1);
    expect(hit[0]?.snippet).toBe("needle-narration を確認します。");
  });

  test("サブエージェントの transcript は narration を assistant の発話として並べる", () => {
    const entries = parseSubagentTranscript(lines.join("\n") + "\n").entries;
    const texts = entries.map((item) => `${item.role}:${item.text}`);
    expect(texts).toContain("assistant:needle-narration を確認します。");
    expect(texts.some((text) => text.includes("needle-hidden"))).toBe(false);
  });

  test("narration に追記された通知は、プレビュー・検索・サブエージェントでも通常本文と同じく除く", () => {
    const line = assistantLine("notice", [thinkingBlock("narration",
      "確認を続けます。\n\n<system-reminder>\nneedle-injected\n</system-reminder>\n")]);
    const root = makeTempDir("narration-reminder");
    const slug = path.join(root, "-tmp-proj");
    fs.mkdirSync(slug, { recursive: true });
    const transcript = path.join(slug, "nnnnnnnn-reminder.jsonl");
    fs.writeFileSync(transcript, lines[0] + "\n" + line + "\n");
    expect(scanTranscriptTail(transcript).lastMessage).toBe("確認を続けます。");
    const store = new ClaudeSessionStore(root);
    expect(searchClaudeSessions(store, "needle-injected").results).toEqual([]);
    expect(searchClaudeSessions(store, "確認を続けます").results[0]?.snippet).toBe("確認を続けます。");
    expect(parseSubagentTranscript(line + "\n").entries.map((item) => item.text)).toEqual(["確認を続けます。"]);
    const noticeOnly = assistantLine("notice-only", [thinkingBlock("narration",
      "<system-reminder>\nneedle-injected\n</system-reminder>")]);
    expect(parseSubagentTranscript(noticeOnly + "\n").entries).toEqual([]);
  });
});
