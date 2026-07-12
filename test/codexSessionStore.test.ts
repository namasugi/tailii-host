// codexSessionStore.test.ts — codex 会話一覧導出（rollout × session_index 結合）のテスト（agent-tag）

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { CodexSessionStore } from "../src/codexSessionStore.js";
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
  if (userMessage !== undefined) {
    // codex アプリと同じく、注入込みの環境コンテキスト行を先に置いてから素の user_message を続ける
    // （タイトル導出が注入行ではなく user_message を拾うことを検証する）。
    const envUser = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }],
      },
    });
    const um = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: userMessage, images: [] },
    });
    content += envUser + "\n" + um + "\n";
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
    writeRollout(home, "2026/07/06", "rollout-a.jsonl", "id-aaaaaaaa", "/work/a");
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
    // updated_at(ISO) → Unix 秒。
    expect(list[0]?.updatedAt).toBe(Math.floor(Date.parse("2026-07-06T12:00:00.000Z") / 1000));
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

  test("updatedAt 降順で整列する", () => {
    const home = makeTempDir("codex-store-sort");
    writeRollout(home, "2026/07/01", "rollout-old.jsonl", "id-old", "/w/old");
    writeRollout(home, "2026/07/02", "rollout-new.jsonl", "id-new", "/w/new");
    writeIndex(home, [
      { id: "id-old", thread_name: "旧", updated_at: "2026-07-01T00:00:00.000Z" },
      { id: "id-new", thread_name: "新", updated_at: "2026-07-09T00:00:00.000Z" },
    ]);

    const list = new CodexSessionStore(home).list();
    expect(list.map((s) => s.sessionId)).toEqual(["id-new", "id-old"]);
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

  test("App Server thread を写像し、cwd 補完・title 整形・非対話除外を行う", async () => {
    const home = makeTempDir("codex-store-app-server");
    const complemented = writeRollout(
      home, "2026/07/12", "rollout-complemented.jsonl", "thread-complemented", "/rollout/cwd",
      undefined, "rollout のタイトル候補",
    );
    fs.appendFileSync(complemented, JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "最後の応答" },
    }) + "\n");
    writeRollout(
      home, "2026/07/12", "rollout-exec.jsonl", "thread-rollout-exec", "/work/exec",
      undefined, "除外", "exec",
    );
    const longTitle = `  1行目\n${"x".repeat(70)}  `;
    const store = new CodexSessionStore(home);

    const sessions = await store.listWithAppServer({
      listThreads: async () => [
        {
          id: "thread-named", name: longTitle, preview: "preview", updatedAt: 300,
          cwd: "/app/cwd", source: "vscode", parentThreadId: null,
        },
        {
          id: "thread-complemented", name: null, preview: "preview title", updatedAt: 200,
          cwd: null, source: "cli", parentThreadId: null,
        },
        {
          id: "thread-no-cwd", name: null, preview: "hidden", updatedAt: 190,
          cwd: null, source: "cli", parentThreadId: null,
        },
        {
          id: "thread-exec", name: "exec", preview: "exec", updatedAt: 180,
          cwd: "/work/exec", source: "exec", parentThreadId: null,
        },
        {
          id: "thread-subagent", name: "child", preview: "child", updatedAt: 170,
          cwd: "/work/child", source: { subAgent: { threadSpawn: {} } }, parentThreadId: "parent",
        },
        {
          id: "thread-rollout-exec", name: "looks interactive", preview: "preview", updatedAt: 160,
          cwd: "/work/exec", source: "unknown", parentThreadId: null,
        },
      ],
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionId: "thread-named",
      cwd: "/app/cwd",
      title: `1行目 ${"x".repeat(56)}`,
      updatedAt: 300,
      agent: "codex",
    });
    expect(sessions[0]?.title).toHaveLength(60);
    expect(sessions[1]).toMatchObject({
      sessionId: "thread-complemented",
      cwd: "/rollout/cwd",
      title: "preview title",
      updatedAt: 200,
      lastMessage: "最後の応答",
      agent: "codex",
    });
  });

  test("App Server 接続失敗時は既存 rollout 一覧へフォールバックする", async () => {
    const home = makeTempDir("codex-store-app-server-fallback");
    writeRollout(
      home, "2026/07/12", "rollout-fallback.jsonl", "fallback-id", "/work/fallback",
      undefined, "rollout fallback",
    );
    const store = new CodexSessionStore(home);

    const sessions = await store.listWithAppServer({
      listThreads: async () => {
        throw new Error("connection failed");
      },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "fallback-id",
      cwd: "/work/fallback",
      title: "rollout fallback",
      agent: "codex",
    });
  });
});
