// transcriptTailer.test.ts — 会話出力キャプチャ（TranscriptTailer）テスト
// Swift 版 TranscriptTailer の挙動（ターン抽出 / マーカー / tool_activity / 質問プロンプト /
// resolveJsonl 解決規則 / 追記 tail）の要点を移植する。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import {
  CONTEXT_STREAM_ID,
  HISTORY_DONE_STREAM_ID,
  MODEL_STREAM_ID,
  TranscriptTailer,
  questionsFromToolInput,
} from "../src/transcriptTailer.js";
import { makeTempDir } from "./helpers.js";

async function collect(
  gen: AsyncGenerator<ControlMessage, void, void>,
): Promise<ControlMessage[]> {
  const out: ControlMessage[] = [];
  for await (const message of gen) out.push(message);
  return out;
}

function writeTranscript(lines: string[]): string {
  const dir = makeTempDir("tailer");
  const p = path.join(dir, "t.jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("TranscriptTailer", () => {
  test("streamProjectDir の newerThanMs は JSONL 内の切断前本文を除外する", async () => {
    const dir = makeTempDir("tailer-newer-lines");
    const transcript = path.join(dir, "session-1.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ timestamp: "2026-07-12T00:00:00.000Z", type: "user",
        message: { role: "user", content: "既表示" }, uuid: "old" }),
      JSON.stringify({ timestamp: "2026-07-12T00:00:02.000Z", type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "停止中の追記" }] }, uuid: "new" }),
    ].join("\n") + "\n");
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const messages = await collect(tailer.streamProjectDir(
      dir, "session-1", Date.parse("2026-07-12T00:00:01.000Z"),
    ));
    expect(messages.filter((message) => message.type === "chat_output")).toEqual([
      { type: "chat_output", v: 1, streamId: "new", role: "assistant", text: "停止中の追記", eof: true },
    ]);
  });

  test("assistant/user ターンを 1 ターン = 1 chat_output（eof:true）で流す", async () => {
    const p = writeTranscript([
      '{"type":"user","message":{"role":"user","content":"やあ"},"uuid":"u1"}',
      '{"message":{"role":"assistant","content":[{"type":"text","text":"ど"},{"type":"text","text":"うも"}]},"uuid":"a1"}',
      '{"type":"summary","summary":"無視される"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const messages = await collect(tailer.streamTranscript(p));
    const chats = messages.filter((m) => m.type === "chat_output");
    expect(chats).toEqual([
      { type: "chat_output", v: 1, streamId: "u1", role: "user", text: "やあ", eof: true },
      { type: "chat_output", v: 1, streamId: "a1", role: "assistant", text: "どうも", eof: true },
    ]);
  });

  test("スキル実行時に注入される展開済み SKILL.md 本文は会話へ流さない", async () => {
    const p = writeTranscript([
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<command-message>example</command-message>\n<command-name>/example</command-name>",
        },
        uuid: "command",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "Base directory for this skill: /tmp/example\n\n# Example\n\n非表示のスキル本文",
          }],
        },
        uuid: "expanded-skill",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "通常のユーザー発話" },
        uuid: "normal-user",
      }),
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const chats = (await collect(tailer.streamTranscript(p))).filter(
      (message) => message.type === "chat_output",
    );

    expect(chats).toEqual([
      {
        type: "chat_output",
        v: 1,
        streamId: "command",
        role: "user",
        text: "<command-message>example</command-message>\n<command-name>/example</command-name>",
        eof: true,
      },
      {
        type: "chat_output",
        v: 1,
        streamId: "normal-user",
        role: "user",
        text: "通常のユーザー発話",
        eof: true,
      },
    ]);
  });

  test("ターン処理中に送信された queued_command attachment を user ターンとして流す", async () => {
    const p = writeTranscript([
      '{"type":"queue-operation","operation":"enqueue","content":"あとで"}',
      '{"type":"queue-operation","operation":"remove","content":"あとで"}',
      '{"type":"attachment","attachment":{"type":"queued_command","prompt":"あとで","commandMode":"prompt","origin":{"kind":"human"}},"uuid":"q1"}',
      '{"type":"attachment","attachment":{"type":"queued_command","prompt":""},"uuid":"q2"}',
      '{"type":"attachment","attachment":{"type":"other"},"uuid":"q3"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const chats = (await collect(tailer.streamTranscript(p))).filter((m) => m.type === "chat_output");
    expect(chats).toEqual([
      { type: "chat_output", v: 1, streamId: "q1", role: "user", text: "あとで", eof: true },
    ]);
  });

  test("uuid が無いターンは連番 streamId（turn-N）を振る", async () => {
    const p = writeTranscript(['{"type":"user","message":{"role":"user","content":"x"}}']);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const messages = await collect(tailer.streamTranscript(p));
    expect(messages[0]).toMatchObject({ streamId: "turn-1" });
  });

  test("emitReplayDoneMarker 有効時、初回 EOF で pc:history-done を 1 通流す", async () => {
    const p = writeTranscript(['{"type":"user","message":{"role":"user","content":"x"},"uuid":"u1"}']);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10, emitReplayDoneMarker: true });
    const messages = await collect(tailer.streamTranscript(p));
    const marker = messages.filter(
      (m) => m.type === "chat_output" && m.streamId === HISTORY_DONE_STREAM_ID,
    );
    expect(marker).toHaveLength(1);
    expect(marker[0]).toMatchObject({ role: "system", text: "", eof: true });
  });

  test("assistant の message.model が変わるたびにモデルマーカーを流す", async () => {
    const p = writeTranscript([
      '{"message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"text","text":"a"}]},"uuid":"a1"}',
      '{"message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"text","text":"b"}]},"uuid":"a2"}',
      '{"message":{"role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"c"}]},"uuid":"a3"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const markers = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "chat_output" && m.streamId === MODEL_STREAM_ID,
    );
    expect(markers.map((m) => (m.type === "chat_output" ? m.text : ""))).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5",
    ]);
  });

  test('プレースホルダ "<synthetic>" はモデルマーカーとして流さない', async () => {
    const p = writeTranscript([
      '{"message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"text","text":"a"}]},"uuid":"a1"}',
      '{"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]},"uuid":"a2"}',
      '{"message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"text","text":"b"}]},"uuid":"a3"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const markers = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "chat_output" && m.streamId === MODEL_STREAM_ID,
    );
    // <synthetic> を無視し、lastModel も汚さない（実モデル復帰時に重複マーカーを流さない）。
    expect(markers.map((m) => (m.type === "chat_output" ? m.text : ""))).toEqual([
      "claude-fable-5",
    ]);
  });

  test("assistant の message.usage から pc:context マーカーを 1 通流す", async () => {
    const p = writeTranscript([
      JSON.stringify({
        message: {
          role: "assistant",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
            ignored: 999,
          },
          content: [{ type: "text", text: "a" }],
        },
        uuid: "a1",
      }),
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const markers = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "chat_output" && m.streamId === CONTEXT_STREAM_ID,
    );
    expect(markers).toEqual([
      {
        type: "chat_output",
        v: 1,
        streamId: CONTEXT_STREAM_ID,
        role: "system",
        text: "123",
        eof: true,
      },
    ]);
  });

  test("pc:context は合計値が変わったときだけ流す", async () => {
    const p = writeTranscript([
      '{"message":{"role":"assistant","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":3},"content":[{"type":"text","text":"a"}]},"uuid":"a1"}',
      '{"message":{"role":"assistant","usage":{"input_tokens":123,"cache_read_input_tokens":"x","cache_creation_input_tokens":false},"content":[{"type":"text","text":"b"}]},"uuid":"a2"}',
      '{"message":{"role":"assistant","usage":{"input_tokens":124,"cache_read_input_tokens":1,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"c"}]},"uuid":"a3"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const markers = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "chat_output" && m.streamId === CONTEXT_STREAM_ID,
    );
    expect(markers.map((m) => (m.type === "chat_output" ? m.text : ""))).toEqual(["123", "125"]);
  });

  test("usage が無い行と user ターンは pc:context マーカーを流さない", async () => {
    const p = writeTranscript([
      '{"message":{"role":"assistant","content":[{"type":"text","text":"a"}]},"uuid":"a1"}',
      '{"type":"user","message":{"role":"user","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":3},"content":"b"},"uuid":"u1"}',
      '{"message":{"role":"assistant","usage":null,"content":[{"type":"text","text":"c"}]},"uuid":"a2"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const markers = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "chat_output" && m.streamId === CONTEXT_STREAM_ID,
    );
    expect(markers).toHaveLength(0);
  });

  test("Edit の tool_use は ±行数と diff 付きの tool_activity になる", async () => {
    const line = JSON.stringify({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: {
              file_path: "/tmp/app/main.swift",
              old_string: "a\nb\nc",
              new_string: "a\nX\nY\nc",
            },
          },
        ],
      },
      uuid: "a1",
    });
    const p = writeTranscript([line]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const activities = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "tool_activity",
    );
    expect(activities).toHaveLength(1);
    const activity = activities[0]!.type === "tool_activity" ? activities[0]!.activity : null;
    expect(activity).toMatchObject({
      id: "toolu_1",
      name: "Edit",
      label: "編集済み main.swift",
      file: "/tmp/app/main.swift",
      addedLines: 2,
      removedLines: 1,
    });
    expect(activity?.diff).toMatchObject({ oldString: "a\nb\nc", newString: "a\nX\nY\nc" });
  });

  test("Bash の tool_use は description 優先の要約 + command を載せる", async () => {
    const line = JSON.stringify({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Bash",
            input: { command: "swift test", description: "テスト実行" },
          },
        ],
      },
      uuid: "a1",
    });
    const p = writeTranscript([line]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const activities = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "tool_activity",
    );
    const activity = activities[0]!.type === "tool_activity" ? activities[0]!.activity : null;
    expect(activity).toMatchObject({
      name: "Bash",
      label: "実行済み テスト実行",
      command: "swift test",
      description: "テスト実行",
    });
  });

  test("TodoWrite は todos チェックリスト付き tool_activity になる", async () => {
    const line = JSON.stringify({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "設計する", status: "completed", activeForm: "設計中" },
                { content: "実装する", status: "in_progress", activeForm: "実装中" },
              ],
            },
          },
        ],
      },
      uuid: "a1",
    });
    const p = writeTranscript([line]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const activities = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "tool_activity",
    );
    const activity = activities[0]!.type === "tool_activity" ? activities[0]!.activity : null;
    expect(activity?.label).toBe("Todoを更新しました");
    expect(activity?.todos).toEqual([
      { content: "設計する", status: "completed" },
      { content: "実装する", status: "in_progress" },
    ]);
  });

  test("AskUserQuestion は question_prompt を送出し、tool_result で question_dismiss する", async () => {
    const ask = JSON.stringify({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_q1",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "どちらにしますか?",
                  header: "選択",
                  multiSelect: false,
                  options: [
                    { label: "A", description: "前者" },
                    { label: "B", description: "後者" },
                  ],
                },
              ],
            },
          },
        ],
      },
      uuid: "a1",
    });
    const result = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_q1", content: "A" }],
      },
      toolUseResult: {
        questions: [
          {
            question: "どちらにしますか?",
            header: "選択",
            multiSelect: false,
            options: [
              { label: "A", description: "前者" },
              { label: "B", description: "後者" },
            ],
          },
        ],
        answers: { "どちらにしますか?": "A" },
      },
      uuid: "u1",
    });
    const p = writeTranscript([ask, result]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const messages = await collect(tailer.streamTranscript(p));

    const prompts = messages.filter((m) => m.type === "question_prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      id: "toolu_q1",
      questions: [
        {
          header: "選択",
          question: "どちらにしますか?",
          multiSelect: false,
          options: [
            { label: "A", description: "前者" },
            { label: "B", description: "後者" },
          ],
        },
      ],
    });
    const dismisses = messages.filter((m) => m.type === "question_dismiss");
    expect(dismisses).toEqual([{ type: "question_dismiss", v: 1, id: "toolu_q1" }]);
    const answerOutputs = messages.filter(
      (m) => m.type === "chat_output" && m.role === "user",
    );
    expect(answerOutputs).toEqual([
      {
        type: "chat_output",
        v: 1,
        streamId: "u1",
        role: "user",
        text: "回答:\n・どちらにしますか? → A",
        eof: true,
      },
    ]);
  });

  test("追記 tail: 上限 tail 中に追記された行も拾う", async () => {
    const p = writeTranscript(['{"type":"user","message":{"role":"user","content":"1"},"uuid":"u1"}']);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10, tailDeadlineMs: 1500 });
    const seen: string[] = [];
    const pump = (async () => {
      for await (const message of tailer.streamTranscript(p)) {
        if (message.type === "chat_output") seen.push(message.streamId);
        if (seen.length >= 2) break;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.appendFileSync(p, '{"type":"user","message":{"role":"user","content":"2"},"uuid":"u2"}\n');
    await pump;
    expect(seen).toEqual(["u1", "u2"]);
  });

  test("resolveJsonl: preferred 優先 / 最新 mtime / newerThan フィルタ", () => {
    const dir = makeTempDir("resolve");
    const a = path.join(dir, "aaa.jsonl");
    const b = path.join(dir, "bbb.jsonl");
    fs.writeFileSync(a, "x\n");
    fs.writeFileSync(b, "y\n");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(a, past, past);

    // preferred 実在時はそれを優先。
    expect(TranscriptTailer.resolveJsonl(dir, "aaa")).toBe(a);
    // 無指定は最新 mtime。
    expect(TranscriptTailer.resolveJsonl(dir, null)).toBe(b);
    // newerThan より古いものは対象外。
    expect(TranscriptTailer.resolveJsonl(dir, null, Date.now() + 60_000)).toBeNull();
    // dir 不在は null。
    expect(TranscriptTailer.resolveJsonl(path.join(dir, "nope"), null)).toBeNull();
  });

  test("resolveJsonl: preferred が未出現なら mtime 最新へフォールバックせず null（別会話へ吸着しない）", () => {
    const dir = makeTempDir("resolve-strict");
    // 既存の稼働会話（mtime 最新）が居るディレクトリ。
    fs.writeFileSync(path.join(dir, "other.jsonl"), "y\n");

    // 新規セッションの自会話 jsonl はまだ出現していない。preferred を指定している以上、
    // mtime 最新の other.jsonl を掴まず null（＝呼び出し側で自会話の出現を待つ）。
    expect(TranscriptTailer.resolveJsonl(dir, "mine")).toBeNull();

    // 自会話 jsonl が出現したら、mtime に関わらずそれだけを返す。
    const mine = path.join(dir, "mine.jsonl");
    fs.writeFileSync(mine, "x\n");
    const older = new Date(Date.now() - 120_000);
    fs.utimesSync(mine, older, older); // other より古くても preferred を優先。
    expect(TranscriptTailer.resolveJsonl(dir, "mine")).toBe(mine);
  });
});

describe("questionsFromToolInput — hook 用の tool_input 抽出", () => {
  test("questions 配列から transcript 由来と同一形の設問を抽出する", () => {
    expect(
      questionsFromToolInput({
        questions: [
          {
            question: "Q",
            header: "H",
            multiSelect: true,
            options: [{ label: "A", description: "d" }, { label: "B" }],
          },
        ],
      }),
    ).toEqual([
      {
        header: "H",
        question: "Q",
        multiSelect: true,
        options: [
          { label: "A", description: "d" },
          { label: "B", description: "" },
        ],
      },
    ]);
  });

  test("questions 欠落・不正要素は空配列/スキップになる", () => {
    expect(questionsFromToolInput({})).toEqual([]);
    expect(questionsFromToolInput({ questions: "x" })).toEqual([]);
    expect(questionsFromToolInput({ questions: [{ header: "H" }] })).toEqual([]);
  });
});
