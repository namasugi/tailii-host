// codexRolloutTailer.test.ts — codex rollout の解決/tail/イベント変換のテスト

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { CodexRolloutTailer } from "../src/codexRolloutTailer.js";
import type { ControlMessage } from "../src/protocol.js";
import { makeTempDir } from "./helpers.js";

/** session_meta + 任意イベント行から rollout JSONL を作る。 */
function writeRollout(
  root: string,
  relDir: string,
  fileName: string,
  cwd: string,
  eventLines: string[],
): string {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, fileName);
  const meta = JSON.stringify({
    timestamp: "2026-07-06T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "abc", cwd, cli_version: "0.139.0" },
  });
  fs.writeFileSync(p, [meta, ...eventLines].join("\n") + "\n");
  return p;
}

function userMsg(text: string): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } });
}
function agentMsg(text: string, phase = "final_answer"): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: text, phase } });
}
function tokenCount(total: number): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: total } } },
  });
}

describe("CodexRolloutTailer.resolveRollout", () => {
  test("cwd 一致の rollout を解決し、非一致は無視する", () => {
    const root = makeTempDir("codex-resolve");
    const cwd = makeTempDir("codex-cwd");
    const other = makeTempDir("codex-other");
    writeRollout(root, "2026/07/06", "rollout-a.jsonl", other, [userMsg("x")]);
    const want = writeRollout(root, "2026/07/06", "rollout-b.jsonl", cwd, [userMsg("hello")]);
    expect(CodexRolloutTailer.resolveRollout(cwd, root)).toBe(want);
    expect(CodexRolloutTailer.resolveRollout(makeTempDir("codex-nomatch"), root)).toBeNull();
  });

  test("同一 cwd が複数あれば mtime 最新を選ぶ", () => {
    const root = makeTempDir("codex-newest");
    const cwd = makeTempDir("codex-cwd2");
    const older = writeRollout(root, "2026/07/05", "rollout-old.jsonl", cwd, [userMsg("old")]);
    const newer = writeRollout(root, "2026/07/06", "rollout-new.jsonl", cwd, [userMsg("new")]);
    // mtime を明示的にずらす。
    fs.utimesSync(older, new Date("2026-07-05"), new Date("2026-07-05"));
    fs.utimesSync(newer, new Date("2026-07-06"), new Date("2026-07-06"));
    expect(CodexRolloutTailer.resolveRollout(cwd, root)).toBe(newer);
  });

  test("newerThanMs より古い rollout は候補から除外する", () => {
    const root = makeTempDir("codex-newer-than");
    const cwd = makeTempDir("codex-cwd3");
    const f = writeRollout(root, "2026/07/06", "rollout.jsonl", cwd, [userMsg("x")]);
    const mtime = fs.statSync(f).mtimeMs;
    expect(CodexRolloutTailer.resolveRollout(cwd, root, mtime + 1000)).toBeNull();
    expect(CodexRolloutTailer.resolveRollout(cwd, root, mtime - 1000)).toBe(f);
  });
});

describe("CodexRolloutTailer.streamForCwd（有限 tail）", () => {
  async function collect(tailer: CodexRolloutTailer, cwd: string): Promise<ControlMessage[]> {
    const out: ControlMessage[] = [];
    for await (const m of tailer.streamForCwd(cwd, null)) out.push(m);
    return out;
  }

  test("user_message / agent_message(final_answer) を chat_output に変換する", async () => {
    const root = makeTempDir("codex-stream");
    const cwd = makeTempDir("codex-stream-cwd");
    writeRollout(root, "2026/07/06", "r.jsonl", cwd, [
      userMsg("質問です"),
      agentMsg("中間", "answer"), // 中間 phase はスキップ
      agentMsg("最終回答"),
    ]);
    const tailer = new CodexRolloutTailer({ sessionsRoot: root, tailDeadlineMs: 0 });
    const msgs = await collect(tailer, cwd);
    const chats = msgs.filter((m) => m.type === "chat_output") as Extract<
      ControlMessage,
      { type: "chat_output" }
    >[];
    expect(chats.map((c) => [c.role, c.text])).toEqual([
      ["user", "質問です"],
      ["assistant", "最終回答"],
    ]);
    expect(chats.every((c) => c.eof)).toBe(true);
    // streamId はターンごとに一意。
    expect(new Set(chats.map((c) => c.streamId)).size).toBe(2);
  });

  test("token_count はコンテキストマーカーを 1 回だけ流す（変化時のみ）", async () => {
    const root = makeTempDir("codex-ctx");
    const cwd = makeTempDir("codex-ctx-cwd");
    writeRollout(root, "2026/07/06", "r.jsonl", cwd, [
      tokenCount(100),
      tokenCount(100), // 変化なし → 出さない
      tokenCount(250),
    ]);
    const tailer = new CodexRolloutTailer({ sessionsRoot: root, tailDeadlineMs: 0 });
    const msgs = await collect(tailer, cwd);
    const ctx = (msgs.filter((m) => m.type === "chat_output") as Extract<
      ControlMessage,
      { type: "chat_output" }
    >[]).filter((c) => c.streamId === "pc:context");
    expect(ctx.map((c) => c.text)).toEqual(["100", "250"]);
  });

  test("履歴再生完了マーカーを有効化すると EOF で 1 通流す", async () => {
    const root = makeTempDir("codex-replay");
    const cwd = makeTempDir("codex-replay-cwd");
    writeRollout(root, "2026/07/06", "r.jsonl", cwd, [userMsg("hi")]);
    const tailer = new CodexRolloutTailer({
      sessionsRoot: root,
      tailDeadlineMs: 0,
      emitReplayDoneMarker: true,
    });
    const msgs = await collect(tailer, cwd);
    const done = msgs.filter(
      (m) => m.type === "chat_output" && m.streamId === "pc:history-done",
    );
    expect(done.length).toBe(1);
  });
});
