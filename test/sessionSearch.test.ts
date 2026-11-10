import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import type { ClaudeSessionInfo } from "../src/protocol.js";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { codexAsyncQuestionReplyText } from "../src/codex/codexAsyncQuestion.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { searchSessions } from "../src/sessions/sessionSearch.js";
import { makeTempDir } from "./helpers.js";

function writeLines(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function searchSource(infos: ClaudeSessionInfo[]) {
  const root = makeTempDir("search-filter");
  const files = new Map<string, string>();
  for (const info of infos) {
    const file = path.join(root, info.sessionId + ".jsonl");
    writeLines(file, info.agent?.toLowerCase() === "codex"
      ? [{ type: "event_msg", payload: { type: "agent_message", message: "共通のneedle本文" } }]
      : [{ type: "assistant", message: { content: "共通のneedle本文" } }]);
    files.set(info.sessionId, file);
  }
  return { list: () => infos, transcriptPath: vi.fn((id: string) => files.get(id) ?? null) };
}

describe("ホストの会話全文検索", () => {
  test("Codex が圧縮した古い rollout（.jsonl.zst）の本文も解凍して検索し、読取上限は解凍後で数える", async () => {
    const root = makeTempDir("search-zst");
    const plain = path.join(root, "old.jsonl");
    writeLines(plain, [
      { type: "event_msg", payload: { type: "user_message", message: "前置き" } },
      { type: "event_msg", payload: { type: "agent_message", message: "圧縮された会話のneedle本文" } },
    ]);
    const compressed = `${plain}.zst`;
    fs.writeFileSync(compressed, zlib.zstdCompressSync(fs.readFileSync(plain)));
    fs.rmSync(plain);
    const source = {
      list: () => [{ sessionId: "old", title: "Old", cwd: "/repo", agent: "codex", updatedAt: 1 }],
      transcriptPath: () => compressed,
    };
    const found = await searchSessions([source], "needle");
    expect(found.results.map((hit) => [hit.sessionId, hit.snippet.includes("needle")])).toEqual([["old", true]]);
    // 1 行目だけ読む上限なら 2 行目の一致は拾わない。
    expect((await searchSessions([source], "needle", { perFileBytes: 10 })).results).toEqual([]);
  });

  test("先頭20件がClaudeでも、Codex指定は検索件数の打切りより前に適用する", async () => {
    const source = searchSource([
      ...Array.from({ length: 20 }, (_, index) => ({ sessionId: `claude-${index}`, title: "Claude", cwd: "/repo", agent: "claude", updatedAt: 100 - index })),
      { sessionId: "older-codex", title: "Codex", cwd: "/repo", agent: "codex", updatedAt: 1 },
    ]);
    expect((await searchSessions([source], "needle")).results).toHaveLength(20);
    source.transcriptPath.mockClear();
    const progress: string[][] = [];
    const filtered = await searchSessions([source], "needle", { agents: ["codex"], onProgress: (hits) => progress.push(hits.map((hit) => hit.sessionId)) });
    expect(filtered.results.map((hit) => hit.sessionId)).toEqual(["older-codex"]);
    expect(filtered.stats.scannedFiles).toBe(1);
    expect(progress).toEqual([["older-codex"]]);
    expect(source.transcriptPath.mock.calls).toEqual([["older-codex"]]);
  });

  test("先頭20件が別cwdでも、選択cwdの会話を検索件数の打切りより前に拾う", async () => {
    const source = searchSource([
      ...Array.from({ length: 20 }, (_, index) => ({ sessionId: `other-${index}`, title: "Other", cwd: "/other", updatedAt: 100 - index })),
      { sessionId: "selected", title: "Selected", cwd: "/repo", updatedAt: 1 },
    ]);
    expect((await searchSessions([source], "needle")).results).toHaveLength(20);
    source.transcriptPath.mockClear();
    const filtered = await searchSessions([source], "needle", { cwd: "/repo/" });
    expect(filtered.results.map((hit) => hit.sessionId)).toEqual(["selected"]);
    expect(filtered.stats.scannedFiles).toBe(1);
    expect(source.transcriptPath.mock.calls).toEqual([["selected"]]);
  });

  test("cwdは完全一致とworktreeのrepo正規化だけを採用し、agentsとのANDで絞る", async () => {
    const source = searchSource([
      { sessionId: "root", title: "Root", cwd: "/repo/", agent: "codex" },
      { sessionId: "tree", title: "Tree", cwd: "/repo/.claude/worktrees/task", agent: "codex" },
      { sessionId: "other-agent", title: "Claude", cwd: "/repo", agent: "claude" },
      { sessionId: "child", title: "Child", cwd: "/repo/subdir", agent: "codex" },
      { sessionId: "sibling", title: "Sibling", cwd: "/repo-other", agent: "codex" },
      { sessionId: "prefix", title: "Prefix", cwd: "/repo/.claude/worktrees-not/task", agent: "codex" },
    ]);
    const result = await searchSessions([source], "needle", { agents: ["codex"], cwd: "/repo", limit: 1 });
    expect(result.results.map((hit) => hit.sessionId)).toEqual(["root"]);
    const all = await searchSessions([source], "needle", { agents: ["codex"], cwd: "/repo" });
    expect(all.results.map((hit) => hit.sessionId)).toEqual(["root", "tree"]);
    expect((await searchSessions([source], "needle", { cwd: "/repo/.claude/worktrees/task/" })).results.map((hit) => hit.sessionId)).toEqual(["tree"]);
  });

  test("旧形式のagent省略はClaude、未知agentは明示した種別へ混ぜず、空配列は走査しない", async () => {
    const source = searchSource([
      { sessionId: "legacy", title: "Legacy", cwd: "/repo" },
      { sessionId: "upper", title: "Upper", cwd: "/repo", agent: "CLAUDE" },
      { sessionId: "unknown", title: "Unknown", cwd: "/repo", agent: "future-agent" },
    ]);
    expect((await searchSessions([source], "needle")).results).toHaveLength(3);
    expect((await searchSessions([source], "needle", { agents: ["claude"] })).results.map((hit) => hit.sessionId)).toEqual(["legacy", "upper"]);
    source.transcriptPath.mockClear();
    expect(await searchSessions([source], "needle", { agents: [] })).toEqual({ results: [], stats: { scannedFiles: 0, truncated: false } });
    expect(source.transcriptPath).not.toHaveBeenCalled();
  });

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
