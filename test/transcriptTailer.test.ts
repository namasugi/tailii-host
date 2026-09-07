// transcriptTailer.test.ts — 会話出力キャプチャ（TranscriptTailer）テスト
// Swift 版 TranscriptTailer の挙動（ターン抽出 / マーカー / tool_activity / 質問プロンプト /
// resolveJsonl 解決規則 / 追記 tail）の要点を移植する。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import {
  CONTEXT_STREAM_ID,
  EFFORT_STREAM_ID,
  HISTORY_DONE_STREAM_ID,
  MODEL_STREAM_ID,
  TranscriptTailer,
  findTrailingInterruptMarkerMs,
  findTrailingTurnEndMarkerMs,
  questionsFromToolInput,
} from "../src/chat/transcriptTailer.js";
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

  test("中断確定マーカーは timestamp 付きの lifecycle として観測者へ通知する（不明行は通知しない）", async () => {
    const p = writeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-09-02T03:45:40.331Z", uuid: "u1",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
        interruptedMessageId: "msg_1" }),
      JSON.stringify({ type: "user", timestamp: "2026-09-02T03:46:00.000Z", uuid: "u2",
        message: { role: "user", content: "[Request interrupted by user for tool use]" } }),
      // timestamp 不明の中断行は履歴/ライブを区別できないため通知しない。
      JSON.stringify({ type: "user", uuid: "u3",
        message: { role: "user", content: "[Request interrupted by user]" } }),
      // 本文中の引用（ピア封筒など）は行頭一致に外れるので通知しない。
      JSON.stringify({ type: "user", timestamp: "2026-09-02T03:47:00.000Z", uuid: "u4",
        message: { role: "user", content: "さっき [Request interrupted by user] と出た" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-09-02T03:48:00.000Z", uuid: "a1",
        message: { role: "assistant", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const events: unknown[] = [];
    tailer.setTurnLifecycleObserver((event) => events.push(event));
    const messages = await collect(tailer.streamTranscript(p));
    expect(events).toEqual([
      { kind: "interrupted", atMs: Date.parse("2026-09-02T03:45:40.331Z") },
      { kind: "interrupted", atMs: Date.parse("2026-09-02T03:46:00.000Z") },
      // 本文のある通常の user 発話は「発話の観測」として流れる（引用文は中断マーカーではない）。
      { kind: "turn_start", atMs: Date.parse("2026-09-02T03:47:00.000Z") },
    ]);
    // 表示用の chat_output は従来どおり流れる（iOS 側の「停止中」解除権威）。
    expect(messages.filter((m) => m.type === "chat_output" && m.role === "user")).toHaveLength(4);
  });

  test("API エラー終端行（isApiErrorMessage の合成 assistant 行）も timestamp 付き lifecycle として通知する", async () => {
    // 実測 2026-09-06/07: 使用量上限（rate_limit 429）/ 過負荷（server_error 529）は model "<synthetic>"
    // の assistant 行として記録され、その時点でターンは終わる（Stop hook は発火しない）。
    const apiError = (ts: string | null, text: string, error: string) => JSON.stringify({
      type: "assistant", ...(ts === null ? {} : { timestamp: ts }), uuid: `e-${error}-${ts ?? "none"}`,
      message: { model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence",
        content: [{ type: "text", text }] },
      error, isApiErrorMessage: true, apiErrorStatus: error === "rate_limit" ? 429 : 529,
    });
    const p = writeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-09-06T15:35:35.000Z", uuid: "u1",
        message: { role: "user", content: "続けて" } }),
      // ターン途中で吸収された queued 発話（attachment）とローカルコマンド記録（system）は発話の
      // 観測（turn_start）にしない。tool_result だけの user 行も本文が無いので対象外。
      JSON.stringify({ type: "attachment", timestamp: "2026-09-06T15:40:00.000Z", uuid: "q1",
        attachment: { type: "queued_command", prompt: "吸収された発話" } }),
      JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-09-06T15:41:00.000Z", uuid: "lc",
        content: "<command-name>/effort</command-name>" }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T15:42:00.000Z", uuid: "tr",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } }),
      // 実 transcript（2.1.26x）で type=user として現れる「発話でない行」も turn_start にしない:
      // isMeta の画像注記、ローカルコマンド記録 3 形（command-name / stdout / caveat）、AskUserQuestion の
      // 回答（tool_result + toolUseResult）。これらは claude 停止中にも書かれる（/model 等）ため、発話と
      // 数えると終端後の遅着 UserPromptSubmit を誤って採用する。
      JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-09-06T15:43:00.000Z", uuid: "img",
        message: { role: "user", content: "[Image: original 944x2048, displayed at 922x2000.]" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T15:44:00.000Z", uuid: "cmd",
        message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T15:44:01.000Z", uuid: "out",
        message: { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }),
      JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-09-06T15:44:02.000Z", uuid: "cav",
        message: { role: "user", content: "<local-command-caveat>Caveat: …</local-command-caveat>" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T15:45:00.000Z", uuid: "ans",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q", content: "answered" }] },
        toolUseResult: { questions: [{ question: "続ける?" }], answers: { "続ける?": "はい" } } }),
      // isMeta でも本物の発話は turn_start にする: cross-session の起こし・監視系の自動再開プロンプト。
      JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-09-06T15:46:00.000Z", uuid: "wake",
        message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from=\"peer\">進めて</cross-session-message>" } }),
      JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-09-06T15:47:00.000Z", uuid: "cont",
        message: { role: "user", content: "Check whether the briefing agent finished; if so, continue." } }),
      apiError("2026-09-06T15:55:37.951Z", "You've hit your session limit · resets 2am (Asia/Tokyo)", "rate_limit"),
      // timestamp 不明行は履歴/ライブを区別できないため通知しない。
      apiError(null, "API Error: 529 Overloaded", "server_error"),
      // 通常の assistant 行（同じ文言でも isApiErrorMessage 無し）は終端ではない。
      JSON.stringify({ type: "assistant", timestamp: "2026-09-06T15:56:00.000Z", uuid: "a1",
        message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit" }] } }),
      apiError("2026-09-06T15:57:00.000Z", "API Error: 529 Overloaded", "server_error"),
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const events: unknown[] = [];
    tailer.setTurnLifecycleObserver((event) => events.push(event));
    const messages = await collect(tailer.streamTranscript(p));
    expect(events).toEqual([
      { kind: "turn_start", atMs: Date.parse("2026-09-06T15:35:35.000Z") },
      { kind: "turn_start", atMs: Date.parse("2026-09-06T15:46:00.000Z") },
      { kind: "turn_start", atMs: Date.parse("2026-09-06T15:47:00.000Z") },
      { kind: "api_error", atMs: Date.parse("2026-09-06T15:55:37.951Z") },
      { kind: "api_error", atMs: Date.parse("2026-09-06T15:57:00.000Z") },
    ]);
    // 表示用の chat_output は従来どおり流れる（エラー文言はチャットに出す）。
    expect(messages).toContainEqual({
      type: "chat_output", v: 1, streamId: "e-rate_limit-2026-09-06T15:55:37.951Z", role: "assistant",
      text: "You've hit your session limit · resets 2am (Asia/Tokyo)", eof: true,
    });
  });

  test("findTrailingTurnEndMarkerMs は末尾が API エラー終端でも timestamp を返し、後続の発話があれば null", () => {
    const prompt = (ts: string) => JSON.stringify({ type: "user", timestamp: ts, uuid: `p-${ts}`,
      message: { role: "user", content: "続けて" } });
    const apiError = (ts: string) => JSON.stringify({ type: "assistant", timestamp: ts, uuid: `e-${ts}`,
      message: { model: "<synthetic>", role: "assistant",
        content: [{ type: "text", text: "You've hit your session limit · resets 2am (Asia/Tokyo)" }] },
      error: "rate_limit", isApiErrorMessage: true, apiErrorStatus: 429 });
    // 実機 2026-09-06 の並び: 終端行の前後に attachment / turn_duration(system) / file-history-snapshot。
    const reminder = JSON.stringify({ type: "attachment", timestamp: "2026-09-06T16:02:01.755Z", uuid: "r",
      attachment: { type: "total_tokens_reminder", text: "<total_tokens>1</total_tokens>" } });
    const turnDuration = JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 503792,
      timestamp: "2026-09-06T16:02:02.762Z", uuid: "td" });
    const snapshot = JSON.stringify({ type: "file-history-snapshot", messageId: "x", snapshot: {}, isSnapshotUpdate: false });
    const at = Date.parse("2026-09-06T16:02:02.760Z");
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      prompt("2026-09-06T15:53:39.000Z"), reminder, apiError("2026-09-06T16:02:02.760Z"), turnDuration, snapshot,
    ]))).toBe(at);
    // 制限解除後の再送信（新しい発話）があれば進行中の可能性 → null。
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      apiError("2026-09-06T16:02:02.760Z"), prompt("2026-09-06T17:07:29.004Z"),
    ]))).toBeNull();
    // 中断マーカーと同じく timestamp 無しは null。
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      JSON.stringify({ type: "assistant", uuid: "n", isApiErrorMessage: true, error: "rate_limit",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] } }),
    ]))).toBeNull();
    // 終端の後に「発話でない user 形の記録」（ローカルコマンド記録・isMeta 注記・設問回答）が続いても
    // 終端は隠れない（claude 停止中に /model を叩いた会話を hub 再起動で処理中に戻さない）。
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      apiError("2026-09-06T16:02:02.760Z"),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T16:03:00.000Z", uuid: "cmd",
        message: { role: "user", content: "<command-name>/model</command-name>" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T16:03:00.100Z", uuid: "out",
        message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" } }),
      JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-09-06T16:03:01.000Z", uuid: "img",
        message: { role: "user", content: "[Image: original 10x10]" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T16:03:02.000Z", uuid: "ans",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q", content: "ok" }] },
        toolUseResult: { questions: [{ question: "q" }], answers: { q: "はい" } } }),
    ]))).toBe(at);
    // isMeta でも cross-session の起こしは発話（ターン進行中の可能性）→ 終端を隠す。
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      apiError("2026-09-06T16:02:02.760Z"),
      JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-09-06T16:05:00.000Z", uuid: "wake",
        message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from=\"peer\">進めて</cross-session-message>" } }),
    ]))).toBeNull();
    // timestamp 無しの api-error 行は判定材料にせず、直前の有効な中断マーカーを潰さない。
    const marker = JSON.stringify({ type: "user", timestamp: "2026-09-06T16:00:00.000Z", uuid: "m",
      message: { role: "user", content: "[Request interrupted by user]" } });
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      marker,
      JSON.stringify({ type: "assistant", uuid: "n2", isApiErrorMessage: true, error: "rate_limit",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] } }),
    ]))).toBe(Date.parse("2026-09-06T16:00:00.000Z"));
    // 書式（空白）に依存しない前置フィルタ: `"isApiErrorMessage": true` でも終端として拾う。
    expect(findTrailingTurnEndMarkerMs(writeTranscript([
      '{"type":"assistant","timestamp":"2026-09-06T16:02:02.760Z","uuid":"sp","isApiErrorMessage": true,"error":"rate_limit","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}',
    ]))).toBe(at);
    // 旧名エイリアスも同じ判定（中断 + API エラー）。
    expect(findTrailingInterruptMarkerMs(writeTranscript([apiError("2026-09-06T16:02:02.760Z")]))).toBe(at);
  });

  test("newerThanMs より古い中断マーカーは lifecycle にも流れない（再接続 backfill の限界）", async () => {
    const dir = makeTempDir("tailer-interrupt-newer");
    fs.writeFileSync(path.join(dir, "s.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-09-02T03:45:40.000Z", uuid: "old",
        message: { role: "user", content: "[Request interrupted by user]" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-02T03:50:00.000Z", uuid: "new",
        message: { role: "user", content: "[Request interrupted by user]" } }),
    ].join("\n") + "\n");
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const events: unknown[] = [];
    tailer.setTurnLifecycleObserver((event) => events.push(event));
    await collect(tailer.streamProjectDir(dir, "s", Date.parse("2026-09-02T03:46:00.000Z")));
    expect(events).toEqual([{ kind: "interrupted", atMs: Date.parse("2026-09-02T03:50:00.000Z") }]);
  });

  test("findTrailingInterruptMarkerMs は最後の発話が中断マーカーのときだけ timestamp を返す", () => {
    const marker = (ts: string) => JSON.stringify({ type: "user", timestamp: ts, uuid: `m-${ts}`,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
    const prompt = (ts: string, text = "次") => JSON.stringify({ type: "user", timestamp: ts, uuid: `p-${ts}`,
      message: { role: "user", content: text } });
    const assistant = JSON.stringify({ type: "assistant", timestamp: "2026-09-02T04:00:00.000Z", uuid: "a",
      message: { role: "assistant", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    const toolResult = JSON.stringify({ type: "user", timestamp: "2026-09-02T04:00:01.000Z", uuid: "tr",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } });
    const cost = JSON.stringify({ type: "cost-state", totalCostUSD: 1 });
    const at = Date.parse("2026-09-02T03:45:40.331Z");
    expect(findTrailingInterruptMarkerMs(writeTranscript([
      prompt("2026-09-02T03:40:00.000Z"), marker("2026-09-02T03:45:40.331Z"), assistant, toolResult, cost,
    ]))).toBe(at);
    // マーカー後に発話（queued_command 形も含む）があれば null。
    expect(findTrailingInterruptMarkerMs(writeTranscript([
      marker("2026-09-02T03:45:40.331Z"), prompt("2026-09-02T03:46:00.000Z"),
    ]))).toBeNull();
    expect(findTrailingInterruptMarkerMs(writeTranscript([
      marker("2026-09-02T03:45:40.331Z"),
      JSON.stringify({ type: "attachment", timestamp: "2026-09-02T03:46:00.000Z", uuid: "q",
        attachment: { type: "queued_command", prompt: "キュー済み" } }),
    ]))).toBeNull();
    // ローカルコマンド記録（type=system）はターンを始めないので、マーカーを隠さない。
    expect(findTrailingInterruptMarkerMs(writeTranscript([
      marker("2026-09-02T03:45:40.331Z"),
      JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-09-02T03:46:00.000Z", uuid: "lc",
        content: "<command-name>/effort</command-name>" }),
    ]))).toBe(at);
    // 本文中の引用・timestamp 無し・不在ファイルは null。
    expect(findTrailingInterruptMarkerMs(writeTranscript([prompt("2026-09-02T03:46:00.000Z", "さっき [Request interrupted by user]")]))).toBeNull();
    expect(findTrailingInterruptMarkerMs(writeTranscript([
      JSON.stringify({ type: "user", uuid: "n", message: { role: "user", content: "[Request interrupted by user]" } }),
    ]))).toBeNull();
    expect(findTrailingInterruptMarkerMs(path.join(makeTempDir("tailer-missing"), "none.jsonl"))).toBeNull();
    // 末尾だけ読む: 上限より前の部分に何があっても最後の発話で判定する。
    const big = writeTranscript([prompt("2026-09-02T03:00:00.000Z", "x".repeat(4000)), marker("2026-09-02T03:45:40.331Z")]);
    expect(findTrailingInterruptMarkerMs(big, 1024)).toBe(at);
    // 窓の先頭がちょうど行境界でも、その完全な行（最終行）を捨てない。
    const markerLine = marker("2026-09-02T03:45:40.331Z");
    const exact = writeTranscript([prompt("2026-09-02T03:00:00.000Z"), markerLine]);
    expect(findTrailingInterruptMarkerMs(exact, markerLine.length + 1)).toBe(at);
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
      // Skill ツール起動（Claude 自身の呼び出し）は "Base directory…" 前置なしの本文が
      // isMeta + sourceToolUseID 付き user 行として注入される（claude 2.1.220 実測）。
      JSON.stringify({
        type: "user",
        isMeta: true,
        sourceToolUseID: "toolu_01",
        message: {
          role: "user",
          content: [{ type: "text", text: "Approach this as the design lead…（前置なしスキル本文）" }],
        },
        uuid: "tool-launched-skill",
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

  test("Skill ツールカードはスキル名ラベル+注入本文の後付け再送（同 id 更新）", async () => {
    const p = writeTranscript([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_skill1",
            name: "Skill",
            input: { skill: "artifact-design", args: "デザイン調整" },
          }],
        },
        uuid: "a-skill",
      }),
      // 展開済みスキル本文の注入行（isMeta + sourceToolUseID, "Base directory…" 前置なし）。
      JSON.stringify({
        type: "user",
        isMeta: true,
        sourceToolUseID: "toolu_skill1",
        message: { role: "user", content: [{ type: "text", text: "# デザインの手引き\n\nスキル本文全文" }] },
        uuid: "skill-body",
      }),
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const messages = await collect(tailer.streamTranscript(p));

    // 本文はチャットへ流れない。
    expect(messages.filter((message) => message.type === "chat_output")).toEqual([]);
    // カードは 2 回届く: 起動時（名前+args）→ 本文後付け（同 id, command 付き）。
    const activities = messages.flatMap((message) =>
      message.type === "tool_activity" ? [message.activity] : [],
    );
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      id: "toolu_skill1",
      name: "Skill",
      label: "実行済み スキル artifact-design",
      description: "デザイン調整",
    });
    expect(activities[0]?.command).toBeUndefined();
    expect(activities[1]).toMatchObject({
      id: "toolu_skill1",
      label: "実行済み スキル artifact-design",
      command: "# デザインの手引き\n\nスキル本文全文",
      commandTruncated: false,
    });
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

  test("system/local_command の実行・出力記録を user 行として流す（iOS 側でタグ整形）", async () => {
    const p = writeTranscript([
      '{"type":"system","subtype":"local_command","content":"<command-name>/remote-control</command-name>","uuid":"lc1"}',
      '{"type":"system","subtype":"local_command","content":"<local-command-stdout>Remote Control disconnected.</local-command-stdout>","uuid":"lc2"}',
      // タグを含まない system 行は流さない。
      '{"type":"system","subtype":"local_command","content":"plain","uuid":"lc3"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const chats = (await collect(tailer.streamTranscript(p))).filter((m) => m.type === "chat_output");
    expect(chats).toEqual([
      {
        type: "chat_output",
        v: 1,
        streamId: "lc1",
        role: "user",
        text: "<command-name>/remote-control</command-name>",
        eof: true,
      },
      {
        type: "chat_output",
        v: 1,
        streamId: "lc2",
        role: "user",
        text: "<local-command-stdout>Remote Control disconnected.</local-command-stdout>",
        eof: true,
      },
    ]);
  });

  test("bridge_status の Remote Control activation を system 通知行として流す", async () => {
    const p = writeTranscript([
      '{"type":"system","subtype":"bridge_status","content":"/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_x","uuid":"rc1"}',
      // activation 以外の bridge_status / 他の system 行は流さない。
      '{"type":"system","subtype":"bridge_status","content":"何か別の通知","uuid":"rc2"}',
      '{"type":"system","subtype":"turn_duration","content":"5s","uuid":"rc3"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const chats = (await collect(tailer.streamTranscript(p))).filter((m) => m.type === "chat_output");
    expect(chats).toEqual([
      {
        type: "chat_output",
        v: 1,
        streamId: "rc1",
        role: "system",
        text: "📱 /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_x",
        eof: true,
      },
    ]);
  });

  test("system 通知（モデル自動切替 / 圧縮 / warning 級）を日本語の system 注記として流し、派生行は落とす（system-notice）", async () => {
    const p = writeTranscript([
      // 実測 2026-09-03: Fable 5.1 のセーフガード退け → Opus 4.8 へ自動フォールバック。
      '{"type":"system","subtype":"model_refusal_fallback","level":"warning","content":"Fable 5.1\'s safeguards flagged this message. Switched to Opus 4.8.","originalModel":"claude-fable-5-1","fallbackModel":"claude-opus-4-8","apiRefusalCategory":"cyber","uuid":"mf1"}',
      '{"type":"system","subtype":"compact_boundary","level":"info","content":"Conversation compacted","compactMetadata":{"trigger":"auto","preTokens":1000,"postTokens":100},"uuid":"cb1"}',
      '{"type":"system","subtype":"informational","level":"warning","content":"Remote Control disconnected — /login","uuid":"rc1"}',
      // 派生・内部情報は流さない。
      '{"type":"system","subtype":"turn_duration","content":"5s","uuid":"td1"}',
      '{"type":"system","subtype":"away_summary","content":"要約","uuid":"as1"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const chats = (await collect(tailer.streamTranscript(p))).filter((m) => m.type === "chat_output");
    expect(chats.map((m) => (m.type === "chat_output" ? [m.streamId, m.role, m.text] : null))).toEqual([
      ["mf1", "system",
        "⚠️ セーフガードにより Fable 5.1 が応答を退けたため、Opus 4.8 へ切り替えました（判定: cyber）。以降この会話は Opus 4.8 で応答します。/model で変更できます。"],
      ["cb1", "system", "🧹 会話を自動で圧縮しました（1,000 → 100 tokens）。Claude 側の文脈は要約に置き換わりました（アプリの表示はそのまま）。"],
      ["rc1", "system", "⚠️ Remote Control disconnected — /login"],
    ]);
  });

  test("assistant 行の fallback ブロックで切替を実時刻に告知し、pc:model も同じ行で切り替え、遅れて来る system 行は重複させない（system-notice）", async () => {
    const p = writeTranscript([
      '{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"text","text":"最初の応答"}]},"uuid":"a1"}',
      // 実測 2026-09-03 09:17:54: 切替の瞬間。本文もツールも無い fallback ブロックだけの行。
      '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"fallback","from":{"model":"claude-fable-5-1"},"to":{"model":"claude-opus-4-8"}}]},"uuid":"fb1"}',
      '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"Opus の応答"}]},"uuid":"a2"}',
      // 09:18:32: 38 秒遅れて書かれる system 行。同じ from→to なので二重告知しない。
      '{"type":"system","subtype":"model_refusal_fallback","level":"warning","content":"…","originalModel":"claude-fable-5-1","fallbackModel":"claude-opus-4-8","apiRefusalCategory":"cyber","uuid":"mf1"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const chats = (await collect(tailer.streamTranscript(p))).filter((m) => m.type === "chat_output");
    const rows = chats.map((m) => (m.type === "chat_output" ? [m.streamId, m.role, m.text] : null));
    expect(rows).toEqual([
      ["pc:model", "system", "claude-fable-5-1"],
      ["a1", "assistant", "最初の応答"],
      // 切替告知は Opus の最初の応答より前、pc:model の切替と同じ行で出る。
      ["pc:model", "system", "claude-opus-4-8"],
      ["fb1", "system", "⚠️ Fable 5.1 が応答を退けたため、Opus 4.8 へ切り替えました。以降この会話は Opus 4.8 で応答します。/model で変更できます。"],
      ["a2", "assistant", "Opus の応答"],
    ]);
    expect(rows.some((r) => r?.[0] === "mf1")).toBe(false);
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

  test("assistant 行のトップレベル effort が変わるたびに pc:effort マーカーを流す", async () => {
    const p = writeTranscript([
      '{"message":{"role":"assistant","content":[{"type":"text","text":"a"}]},"uuid":"a1","effort":"max"}',
      '{"message":{"role":"assistant","content":[{"type":"text","text":"b"}]},"uuid":"a2","effort":"max"}',
      // user 行の effort・未知値・非文字列は無視（lastEffort も汚さない）。
      '{"type":"user","message":{"role":"user","content":"u"},"uuid":"u1","effort":"low"}',
      '{"message":{"role":"assistant","content":[{"type":"text","text":"c"}]},"uuid":"a3","effort":"ultra"}',
      '{"message":{"role":"assistant","content":[{"type":"text","text":"d"}]},"uuid":"a4","effort":7}',
      '{"message":{"role":"assistant","content":[{"type":"text","text":"e"}]},"uuid":"a5","effort":"low"}',
    ]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const markers = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "chat_output" && m.streamId === EFFORT_STREAM_ID,
    );
    expect(markers).toEqual([
      { type: "chat_output", v: 1, streamId: EFFORT_STREAM_ID, role: "system", text: "max", eof: true },
      { type: "chat_output", v: 1, streamId: EFFORT_STREAM_ID, role: "system", text: "low", eof: true },
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

  test("SendUserFile は files/caption 付きの tool_activity になる（file-download）", async () => {
    const line = JSON.stringify({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_send",
            name: "SendUserFile",
            input: {
              files: ["/Users/alice/tmp/報告書.pdf", "/Users/alice/tmp/data.csv"],
              caption: "A4 の報告書と元データ",
              status: "normal",
              display: "attach",
            },
          },
        ],
      },
      uuid: "s1",
    });
    const p = writeTranscript([line]);
    const tailer = new TranscriptTailer({ pollIntervalMs: 10 });
    const activities = (await collect(tailer.streamTranscript(p))).filter(
      (m) => m.type === "tool_activity",
    );
    const activity = activities[0]!.type === "tool_activity" ? activities[0]!.activity : null;
    expect(activity?.label).toBe("ファイルを送信 報告書.pdf ほか1件");
    expect(activity?.file).toBe("/Users/alice/tmp/報告書.pdf");
    expect(activity?.files).toEqual(["/Users/alice/tmp/報告書.pdf", "/Users/alice/tmp/data.csv"]);
    expect(activity?.description).toBe("A4 の報告書と元データ");
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
