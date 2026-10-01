// sessionListMemo.test.ts — 会話一覧の読み取り結果の使い回し（session-list-memo）
//
// 対象:
//   - ClaudeSessionStore.list: 中身が変わらない transcript は読み直さず、変わったら読み直し、
//     消えたら一覧から消える（使い回しても結果は毎回読み直した場合と同じ）
//   - CodexSessionStore.list: rollout も同様

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { makeTempDir } from "./helpers.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function userLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: "user", timestamp, cwd: "/work/memo",
    message: { role: "user", content: text },
  });
}

function writeTranscript(root: string, lines: string[]): string {
  const dir = path.join(root, "-work-memo");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("ClaudeSessionStore.list の使い回し", () => {
  test("変わらないファイルは読み直さず、追記されたら読み直し、消えたら一覧から消える", () => {
    const root = makeTempDir("claude-list-memo");
    const file = writeTranscript(root, [userLine("最初の発話", "2026-10-01T00:00:00.000Z")]);
    const store = new ClaudeSessionStore(root);

    const first = store.list();
    expect(first).toHaveLength(1);
    expect(first[0]!.lastMessage).toBe("最初の発話");

    // 中身が変わらなければファイルを開かない（stat だけ）。読めない権限にしても（mtime・size は
    // 変わらない）前回の結果が返る＝読み直していない。
    fs.chmodSync(file, 0o000);
    const second = store.list();
    fs.chmodSync(file, 0o644);
    expect(second).toEqual(first);

    // 呼び出し側が行を書き換えても、次の一覧に漏れない。
    second[0]!.title = "書き換え";
    expect(store.list()[0]!.title).toBe(first[0]!.title);

    fs.appendFileSync(file, userLine("次の発話", "2026-10-01T00:05:00.000Z") + "\n");
    const third = store.list();
    expect(third[0]!.lastMessage).toBe("次の発話");
    expect(third).toEqual(new ClaudeSessionStore(root).list());

    fs.unlinkSync(file);
    expect(store.list()).toEqual([]);
  });
});

describe("CodexSessionStore.list の使い回し", () => {
  function writeRollout(home: string, message: string): string {
    const dir = path.join(home, "sessions", "2026", "10", "01");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-memo.jsonl");
    const meta = JSON.stringify({
      timestamp: "2026-10-01T00:00:00.000Z", type: "session_meta",
      payload: { id: "codex-memo", cwd: "/work/memo", cli_version: "0.155.0" },
    });
    const user = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message, images: [] } });
    fs.writeFileSync(file, `${meta}\n${user}\n`);
    return file;
  }

  test("変わらない rollout は読み直さず、変わったら読み直し、消えたら一覧から消える", () => {
    const home = makeTempDir("codex-list-memo");
    const file = writeRollout(home, "最初の依頼");
    const store = new CodexSessionStore(home);

    const first = store.list();
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toBe("最初の依頼");

    fs.chmodSync(file, 0o000);
    const unreadable = store.list();
    fs.chmodSync(file, 0o644);
    expect(unreadable).toEqual(first);

    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("最初の依頼", "書き換えた依頼です"));
    const changed = store.list();
    expect(changed[0]!.title).toBe("書き換えた依頼です");
    expect(changed).toEqual(new CodexSessionStore(home).list());

    fs.unlinkSync(file);
    expect(store.list()).toEqual([]);
  });
});
