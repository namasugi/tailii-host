// codexSessionStore.test.ts — codex 会話一覧導出（rollout × session_index 結合）のテスト（agent-tag）

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { makeTempDir } from "./helpers.js";

/** `<home>/sessions/<relDir>/<file>` に session_meta 先頭行 + 任意行の rollout を書く。 */
function writeRollout(
  home: string,
  relDir: string,
  fileName: string,
  id: string,
  cwd: string,
  mtime?: Date,
  userMessage?: string,
  source?: unknown,
): string {
  const dir = path.join(home, "sessions", relDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, fileName);
  const meta = JSON.stringify({
    timestamp: "2026-07-06T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, cli_version: "0.142.5", ...(source === undefined ? {} : { source }) },
  });
  let content = meta + "\n";
  // codex アプリと同じく、注入込みの環境コンテキスト行（user ロール）を先に置く。発話の無い会話は
  // 一覧に出ないので、どの会話もこの行は持つ（素の user_message は userMessage 指定時だけ。タイトル
  // 導出が注入行ではなく user_message を拾うことを検証する）。
  const envUser = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }],
    },
  });
  content += envUser + "\n";
  if (userMessage !== undefined) {
    const um = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: userMessage, images: [] },
    });
    content += um + "\n";
  }
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

/** `<home>/session_index.jsonl` に索引行群を書く。 */
function writeIndex(home: string, entries: { id: string; thread_name?: string; updated_at?: string }[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(path.join(home, "session_index.jsonl"), lines + "\n");
}

describe("CodexSessionStore.list", () => {
  test("rollout と session_index を id で結合し agent=codex で返す", () => {
    const home = makeTempDir("codex-store");
    const mtime = new Date("2026-07-06T15:00:00.000Z");
    writeRollout(home, "2026/07/06", "rollout-a.jsonl", "id-aaaaaaaa", "/work/a", mtime);
    writeIndex(home, [
      { id: "id-aaaaaaaa", thread_name: "会話タイトルA", updated_at: "2026-07-06T12:00:00.000Z" },
    ]);

    const list = new CodexSessionStore(home).list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: "id-aaaaaaaa",
      cwd: "/work/a",
      title: "会話タイトルA",
      agent: "codex",
    });
    // 更新時刻は rollout の mtime（App Server の updatedAt と同じ）。索引の updated_at（名前を付けた時点）は使わない。
    expect(list[0]?.updatedAt).toBe(Math.floor(mtime.getTime() / 1000));
  });

  test("索引に無い会話はタイトルを id 先頭 8 字・更新時刻をファイル mtime にフォールバックする", () => {
    const home = makeTempDir("codex-store-fallback");
    const mtime = new Date("2026-07-05T00:00:00.000Z");
    writeRollout(home, "2026/07/05", "rollout-b.jsonl", "beefcafe-1111", "/work/b", mtime);
    // session_index.jsonl は無し。

    const list = new CodexSessionStore(home).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("beefcafe");
    expect(list[0]?.updatedAt).toBe(Math.floor(mtime.getTime() / 1000));
  });

  test("索引に thread_name が無い会話は最初の実ユーザー発話からタイトルを導出する（codex アプリ準拠）", () => {
    const home = makeTempDir("codex-store-firstmsg");
    writeRollout(
      home,
      "2026/07/07",
      "rollout-c.jsonl",
      "cafed00d-2222",
      "/work/c",
      undefined,
      "iPhone での確認方法を調査",
    );
    // session_index.jsonl は無し（未索引の新しい会話を模す）。

    const list = new CodexSessionStore(home).list();
    expect(list).toHaveLength(1);
    // id 先頭 8 字ではなく、素の user_message（環境コンテキスト注入行ではない）を採用する。
    expect(list[0]?.title).toBe("iPhone での確認方法を調査");
  });

  test("索引に thread_name があれば user_message より thread_name を優先する", () => {
    const home = makeTempDir("codex-store-prefer-index");
    writeRollout(
      home,
      "2026/07/07",
      "rollout-d.jsonl",
      "id-dddddddd",
      "/work/d",
      undefined,
      "最初の発話テキスト",
    );
    writeIndex(home, [
      { id: "id-dddddddd", thread_name: "索引タイトル", updated_at: "2026-07-07T00:00:00.000Z" },
    ]);

    const list = new CodexSessionStore(home).list();
    expect(list[0]?.title).toBe("索引タイトル");
  });

  test("ユーザーの発話行が 1 行も無い会話は出さない（App Server の一覧と同じ）", () => {
    const home = makeTempDir("codex-store-no-user-turn");
    writeRollout(home, "2026/07/08", "rollout-real.jsonl", "id-real", "/work/real", undefined, "依頼");
    // 開いてすぐ閉じた会話: session_meta と developer の指示・中断だけ（索引に名前があっても出さない）。
    const dir = path.join(home, "sessions", "2026/07/08");
    fs.writeFileSync(path.join(dir, "rollout-empty.jsonl"), [
      { timestamp: "2026-07-08T00:00:00.000Z", type: "session_meta", payload: { id: "id-empty", cwd: "/work/empty", source: "vscode" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "指示" }] } },
      { type: "event_msg", payload: { type: "turn_aborted" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    // 新形式（item_completed の UserMessage）だけの会話は出す。
    fs.writeFileSync(path.join(dir, "rollout-modern.jsonl"), [
      { timestamp: "2026-07-08T00:00:00.000Z", type: "session_meta", payload: { id: "id-modern", cwd: "/work/modern", source: "vscode" } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "新形式" }] } } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeIndex(home, [{ id: "id-empty", thread_name: "差分レビュー", updated_at: "2026-07-08T00:00:00.000Z" }]);

    const ids = new CodexSessionStore(home).list().map((session) => session.sessionId).sort();
    expect(ids).toEqual(["id-modern", "id-real"]);
  });

  test("発話行の判定は読み取りの区切りをまたぐ行・巨大な先頭行・末尾の改行なしでも見つける", () => {
    const home = makeTempDir("codex-store-user-turn-chunks");
    const dir = path.join(home, "sessions", "2026/07/09");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-big.jsonl");
    // 300KB の session_meta（base_instructions）の後に発話行。64KB 区切りを何度もまたぐ。
    fs.writeFileSync(file, [
      { timestamp: "2026-07-09T00:00:00.000Z", type: "session_meta",
        payload: { id: "id-big", cwd: "/work/big", source: "vscode", base_instructions: "x".repeat(300 * 1024) } },
      { type: "event_msg", payload: { type: "user_message", message: "依頼", images: [] } },
    ].map((line) => JSON.stringify(line)).join("\n"));   // 末尾に改行が無い行も判定する
    const store = new CodexSessionStore(home);
    expect(store.list().map((session) => session.sessionId)).toEqual(["id-big"]);

    // 追記で伸びても一覧に残る（一度見つけた発話はメモから引き継ぐ）。
    fs.appendFileSync(file, "\n" + JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "返答" } }) + "\n");
    expect(store.list().map((session) => session.sessionId)).toEqual(["id-big"]);
  });

  test("updatedAt（rollout の mtime）降順で整列し、索引の古い updated_at では並べない", () => {
    const home = makeTempDir("codex-store-sort");
    // 先に名前が付いた会話ほど索引の updated_at は古いが、その後に更新されていれば上に来る
    // （App Server の thread/list と同じ並び。索引で並べると取得経路ごとに入れ替わっていた）。
    writeRollout(home, "2026/07/01", "rollout-old.jsonl", "id-old", "/w/old", new Date("2026-07-10T00:00:00.000Z"));
    writeRollout(home, "2026/07/02", "rollout-new.jsonl", "id-new", "/w/new", new Date("2026-07-05T00:00:00.000Z"));
    writeIndex(home, [
      { id: "id-old", thread_name: "旧", updated_at: "2026-07-01T00:00:00.000Z" },
      { id: "id-new", thread_name: "新", updated_at: "2026-07-09T00:00:00.000Z" },
    ]);

    const list = new CodexSessionStore(home).list();
    expect(list.map((s) => s.sessionId)).toEqual(["id-old", "id-new"]);
  });

  test("baseDir 指定時は cwd が baseDir 配下の会話のみに絞る", () => {
    const home = makeTempDir("codex-store-scope");
    writeRollout(home, "2026/07/06", "rollout-in.jsonl", "id-in", "/base/proj");
    writeRollout(home, "2026/07/06", "rollout-out.jsonl", "id-out", "/other/proj");
    writeIndex(home, [
      { id: "id-in", thread_name: "in", updated_at: "2026-07-06T00:00:00.000Z" },
      { id: "id-out", thread_name: "out", updated_at: "2026-07-06T00:00:00.000Z" },
    ]);

    const list = new CodexSessionStore(home).list("/base");
    expect(list.map((s) => s.sessionId)).toEqual(["id-in"]);
  });

  test("sessions ディレクトリが無ければ空一覧", () => {
    const home = makeTempDir("codex-store-empty");
    expect(new CodexSessionStore(home).list()).toEqual([]);
  });

  test("非対話の exec と subagent rollout は会話一覧から除外する", () => {
    const home = makeTempDir("codex-store-subagent");
    writeRollout(
      home,
      "2026/07/11",
      "rollout-parent.jsonl",
      "parent-id",
      "/work/project",
      undefined,
      "同じ会話",
      "vscode",
    );
    writeRollout(
      home,
      "2026/07/11",
      "rollout-exec.jsonl",
      "exec-id",
      "/work/project",
      undefined,
      "同じ会話",
      "exec",
    );
    writeRollout(
      home,
      "2026/07/11",
      "rollout-child.jsonl",
      "child-id",
      "/work/project",
      undefined,
      "同じ会話",
      {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-id",
            depth: 1,
            agent_path: "/root/audit",
          },
        },
      },
    );

    const list = new CodexSessionStore(home).list();
    expect(list.map((session) => session.sessionId)).toEqual(["parent-id"]);
  });

  test("最後の agent_message を lastMessage プレビューとして返す（token_count 等は skip）", () => {
    const home = makeTempDir("codex-store-preview");
    const p = writeRollout(
      home, "2026/07/11", "rollout-preview.jsonl", "id-preview", "/work/p",
      undefined, "最初の発話",
    );
    const agentMsg = JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "修正しました。\n詳細は次の通り。" },
    });
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total: 123 } },
    });
    fs.appendFileSync(p, agentMsg + "\n" + tokenCount + "\n" + tokenCount + "\n");

    const list = new CodexSessionStore(home).list();
    // 改行は空白へ畳んで 1 行スニペットにする（claude の list-preview と同様式）。
    expect(list[0]?.lastMessage).toBe("修正しました。 詳細は次の通り。");
  });

  test("user/agent メッセージが無い rollout は lastMessage を持たない", () => {
    const home = makeTempDir("codex-store-no-preview");
    writeRollout(home, "2026/07/11", "rollout-bare.jsonl", "id-bare", "/work/b");

    const list = new CodexSessionStore(home).list();
    expect(list[0]?.lastMessage).toBeUndefined();
  });

  test.each([
    {
      label: "response_item の assistant 本文（ID なし）",
      type: "response_item",
      payload: {
        type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "新形式の本文。\n続きです。" }],
      },
    },
    {
      label: "item_completed の AgentMessage",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "AgentMessage", phase: "commentary",
          content: [{ type: "Text", text: "新形式の本文。" }, { type: "Text", text: "続きです。" }],
        },
      },
    },
    {
      label: "item_completed の UserMessage",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [
            { type: "text", text: "新形式の本文。\n続きです。", text_elements: [] },
            { type: "image", image_url: "data:image/png;base64,ignored" },
          ],
        },
      },
    },
  ])("$label を一覧のプレビューへ反映する", ({ type, payload }) => {
    const home = makeTempDir("codex-store-modern-preview");
    const p = writeRollout(
      home, "2026/09/08", "rollout-modern.jsonl", "modern-id", "/work/modern",
      undefined, "古い発話",
    );
    fs.appendFileSync(p, JSON.stringify({ type, payload }) + "\n");
    const store = new CodexSessionStore(home);
    expect(store.list()[0]?.lastMessage).toBe("新形式の本文。 続きです。");
  });

  test("新旧形式の混在時も末尾の実発話を選び、注入・思考・ツール・不正行を表示しない", () => {
    const home = makeTempDir("codex-store-preview-filter");
    const p = writeRollout(
      home, "2026/09/08", "rollout-filter.jsonl", "filter-id", "/work/filter",
      undefined, "最初の発話",
    );
    const records = [
      { type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "新形式の応答" }],
      } },
      { type: "event_msg", payload: { type: "agent_message", message: "最後の実発話" } },
      ...["user", "developer", "system"].map((role) => ({ type: "response_item", payload: {
        type: "message", role, content: [{ type: "input_text", text: "注入された指示" }],
      } })),
      { type: "response_item", payload: {
        type: "message", role: "assistant", phase: "analysis",
        content: [{ type: "output_text", text: "内部の思考" }],
      } },
      { type: "event_msg", payload: { type: "item_completed", item: {
        type: "AgentMessage", phase: "analysis", content: [{ type: "Text", text: "内部の思考" }],
      } } },
      { type: "event_msg", payload: { type: "item_completed", item: {
        type: "Reasoning", content: [{ type: "Text", text: "内部の思考" }],
      } } },
      { type: "event_msg", payload: { type: "item_completed", item: {
        type: "McpToolCall", content: [{ type: "text", text: "ツールの出力" }],
      } } },
      { type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: " \n " }],
      } },
      { type: "event_msg", payload: { type: "item_completed", item: {
        type: "UserMessage", content: [null, { type: "text", text: 123 }],
      } } },
      { type: "event_msg", payload: { type: "token_count", info: { total: 123 } } },
      { type: "event_msg", payload: { type: "item_completed", item: null } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: {} } },
      { type: "response_item", payload: null },
      null,
    ];
    fs.appendFileSync(p, records.map((record) => JSON.stringify(record)).join("\n") + '\n{"type":"response_item"');
    expect(new CodexSessionStore(home).list()[0]?.lastMessage).toBe("最後の実発話");
  });

  test("partial_answer の本文も一覧の要約に使う（Codex 0.162+）", () => {
    const home = makeTempDir("codex-store-preview-partial");
    const p = writeRollout(home, "2026/10/11", "rollout-partial.jsonl", "partial-id", "/work/partial");
    fs.appendFileSync(p, [
      { type: "event_msg", payload: { type: "agent_message", message: "古い最終回答", phase: "final_answer" } },
      { type: "response_item", payload: {
        type: "message", role: "assistant", phase: "partial_answer",
        content: [{ type: "output_text", text: "回答の前半" }],
      } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    expect(new CodexSessionStore(home).list()[0]?.lastMessage).toBe("回答の前半");
  });

  test("新形式の本文が読み取りチャンクをまたいでも 80 字のプレビューを返す", () => {
    const home = makeTempDir("codex-store-preview-chunk");
    const p = writeRollout(home, "2026/09/08", "rollout-chunk.jsonl", "chunk-id", "/work/chunk");
    fs.appendFileSync(p, JSON.stringify({
      type: "response_item",
      payload: {
        type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "修正しました。".repeat(3000) }],
      },
    }) + "\n");
    expect(new CodexSessionStore(home).list()[0]?.lastMessage).toBe("修正しました。".repeat(3000).slice(0, 80));
  });

  test("新しい非対話 rollout が上限を占有しても古い対話セッションを返す", () => {
    const home = makeTempDir("codex-store-visible-limit");
    writeRollout(
      home, "2026/07/10", "rollout-parent.jsonl", "parent-id", "/work/project",
      new Date("2026-07-10T00:00:00Z"), "親会話", "vscode",
    );
    writeRollout(
      home, "2026/07/11", "rollout-exec.jsonl", "exec-id", "/work/project",
      new Date("2026-07-11T00:00:00Z"), "自動処理", "exec",
    );

    const list = new CodexSessionStore(home, 1).list();
    expect(list.map((session) => session.sessionId)).toEqual(["parent-id"]);
  });
});
