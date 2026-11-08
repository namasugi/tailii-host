import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { codexAsyncQuestionReplyText } from "../src/codex/codexAsyncQuestion.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { searchSessions } from "../src/sessions/sessionSearch.js";
import { makeTempDir } from "./helpers.js";

function writeLines(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

describe("ホストの会話全文検索", () => {
  test("1MB より後の日本語本文を拾い、結果を先に通知する", async () => {
    const root = makeTempDir("search-full");
    writeLines(path.join(root, "-tmp-proj", "long.jsonl"), [
      { type: "user", cwd: "/tmp/proj", message: { content: "タイトル" } },
      { type: "progress", data: "x".repeat(1024 * 1024 + 30) },
      { type: "assistant", message: { content: [{ type: "text", text: "会話の末尾で マスコット しっぽ を調整" }] } },
    ]);
    const progress: string[][] = [];
    const result = await searchSessions([new ClaudeSessionStore(root)], "マスコット　しっぽ", {
      onProgress: (hits) => progress.push(hits.map((hit) => hit.sessionId)),
    });
    expect(result.results[0]?.snippet).toBe("会話の末尾で マスコット しっぽ を調整");
    expect(progress).toEqual([["long"]]);
    expect(result.stats.truncated).toBe(false);
  });

  test("Codex の一覧上限より古い会話も検索し、正しいエージェントを返す", async () => {
    const home = makeTempDir("search-codex");
    for (const [id, timestamp, text] of [["old", 100, "古い本文だけの Needle"], ["new", 200, "最新の本文"]] as const) {
      const file = path.join(home, "sessions", `rollout-${id}.jsonl`);
      writeLines(file, [
        { type: "session_meta", payload: { id, cwd: "/tmp/proj", source: "cli" } },
        { type: "event_msg", payload: { type: "user_message", message: "タイトル" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
      ]);
      fs.utimesSync(file, timestamp, timestamp);
    }
    const store = new CodexSessionStore(home, 1);
    expect(store.list().map((info) => info.sessionId)).toEqual(["new"]);
    const result = await searchSessions([store], "needle");
    expect(result.results).toEqual([{
      sessionId: "old", title: "タイトル", cwd: "/tmp/proj", agent: "codex", updatedAt: 100,
      snippet: "古い本文だけの Needle",
    }]);
  });

  test("Codex の新旧発話を検索し、ツール・思考・注入指示は除く", async () => {
    const home = makeTempDir("search-codex-text");
    writeLines(path.join(home, "sessions", "rollout-text.jsonl"), [
      { type: "session_meta", payload: { id: "text", cwd: "/tmp/proj", source: "cli", base_instructions: "hidden-meta" } },
      { type: "event_msg", payload: { type: "user_message", message: "ユーザーの本文" } },
      { type: "event_msg", payload: { type: "agent_message", message: "旧形式の返答" } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "新形式の質問" }] } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "新形式の返答" }] } } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "analysis", content: [{ type: "output_text", text: "hidden-thinking" }] } },
      { type: "response_item", payload: { type: "function_call_output", output: "hidden-tool" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hidden-instructions" }] } },
    ]);
    const store = new CodexSessionStore(home);
    for (const query of ["ユーザーの本文", "旧形式の返答", "新形式の質問", "新形式の返答"]) {
      expect((await searchSessions([store], query)).results[0]?.snippet).toBe(query);
    }
    expect((await searchSessions([store], "hidden")).results).toEqual([]);
  });

  test("検索を中止すると全ファイルを読み切らず停止する", async () => {
    const root = makeTempDir("search-cancel");
    writeLines(path.join(root, "-tmp-proj", "cancel.jsonl"), [
      { type: "user", cwd: "/tmp/proj", message: { content: "タイトル" } },
      ...Array.from({ length: 10_000 }, () => ({ type: "progress", data: "x".repeat(1000) })),
    ]);
    const controller = new AbortController();
    const search = searchSessions([new ClaudeSessionStore(root)], "absent", { signal: controller.signal });
    controller.abort();
    await expect(search).rejects.toMatchObject({ name: "AbortError" });
  });

  test("Codex の提案プランと質問への回答は、画面に出る本文で検索する", async () => {
    const home = makeTempDir("search-codex-plan-reply");
    const reply = codexAsyncQuestionReplyText([{
      itemId: "hidden-question-identifier", index: 0, title: "どの方式にしますか", answer: "回答は日本語\n二行目です",
    }]);
    writeLines(path.join(home, "sessions", "rollout-plan.jsonl"), [
      { type: "session_meta", payload: { id: "plan", cwd: "/tmp/proj", source: "cli" } },
      { type: "event_msg", payload: { type: "user_message", message: reply } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "Plan", id: "p", text: "検索索引を追加する計画" } } },
    ]);
    const store = new CodexSessionStore(home);
    expect((await searchSessions([store], "検索索引")).results[0]?.snippet).toBe("検索索引を追加する計画");
    expect((await searchSessions([store], "日本語 二行目")).results[0]?.snippet).toBe("> どの方式にしますか 回答は日本語 二行目です");
    expect((await searchSessions([store], "hidden-question-identifier")).results).toEqual([]);
  });
});
