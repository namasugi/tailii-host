// sessionListMemo.test.ts — 会話一覧の読み取り結果の使い回し（session-list-memo）
//
// 対象:
//   - ClaudeSessionStore.list: 中身が変わらない transcript は読み直さず、変わったら読み直し、
//     消えたら一覧から消える（使い回しても結果は毎回読み直した場合と同じ）
//   - CodexSessionStore.list: rollout も同様
//   - ListMemoFile（session-list-memo-persist）: メモを次の engine（別インスタンス）へ引き継ぎ、
//     導出規則の指紋・ルートが違う保存分や壊れた保存分は使わない

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { ListMemoFile } from "../src/sessions/listMemoFile.js";
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

describe("読み取りメモの引き継ぎ（session-list-memo-persist）", () => {
  test("Claude: 次のインスタンスは保存分を使い、変わったファイルだけ読み直す", () => {
    const root = makeTempDir("claude-list-memo-persist");
    const memoPath = path.join(makeTempDir("claude-list-memo-file"), "claude.json");
    const file = writeTranscript(root, [userLine("最初の発話", "2026-10-01T00:00:00.000Z")]);
    const first = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "fp") }).list();
    expect(fs.existsSync(memoPath)).toBe(true);

    // 次の engine 相当: 読めない権限でも保存分から同じ行が返る＝読み直していない。
    fs.chmodSync(file, 0o000);
    const next = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "fp") }).list();
    fs.chmodSync(file, 0o644);
    expect(next).toEqual(first);

    // 追記されたファイルは読み直す（保存分の古い行を出さない）。
    fs.appendFileSync(file, userLine("次の発話", "2026-10-01T00:05:00.000Z") + "\n");
    const changed = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "fp") }).list();
    expect(changed[0]!.lastMessage).toBe("次の発話");
  });

  test("Claude: 指紋（host の版）・ルートが違う保存分や壊れた保存分は使わない", () => {
    const root = makeTempDir("claude-list-memo-stale");
    const memoPath = path.join(makeTempDir("claude-list-memo-stale-file"), "claude.json");
    const file = writeTranscript(root, [userLine("最初の発話", "2026-10-01T00:00:00.000Z")]);
    new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "old") }).list();

    // 読めない権限にして、保存分を使えば行が返り、使わなければ読めず行の中身が変わることで判別する。
    fs.chmodSync(file, 0o000);
    try {
      const reused = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "old") }).list();
      expect(reused[0]!.lastMessage).toBe("最初の発話");
      const otherVersion = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "new") }).list();
      expect(otherVersion[0]!.lastMessage).toBeUndefined();
      const otherRoot = new ClaudeSessionStore(root, {
        memoFile: new ListMemoFile(memoPath, "/elsewhere", "new"),
      }).list();
      expect(otherRoot[0]!.lastMessage).toBeUndefined();
      fs.writeFileSync(memoPath, "{壊れた");
      const broken = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "new") }).list();
      expect(broken[0]!.lastMessage).toBeUndefined();
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  test("読み取りに失敗した劣化結果は保存せず、直ったら次のインスタンスで正しく読む", () => {
    const root = makeTempDir("claude-list-memo-failure");
    const memoPath = path.join(makeTempDir("claude-list-memo-failure-file"), "claude.json");
    const file = writeTranscript(root, [userLine("最初の発話", "2026-10-01T00:00:00.000Z")]);
    fs.chmodSync(file, 0o000);
    let degraded;
    try {
      degraded = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "fp") }).list();
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(degraded[0]!.lastMessage).toBeUndefined();

    // mtime・size は変わらないが、劣化結果を覚えていないので読み直す。
    const recovered = new ClaudeSessionStore(root, { memoFile: new ListMemoFile(memoPath, root, "fp") }).list();
    expect(recovered[0]!.lastMessage).toBe("最初の発話");
  });

  test("Codex: 読み取りに失敗した劣化結果は保存しない（会話が一覧から消えたままにならない）", () => {
    const home = makeTempDir("codex-list-memo-failure");
    const memoPath = path.join(makeTempDir("codex-list-memo-failure-file"), "codex.json");
    const dir = path.join(home, "sessions", "2026", "10", "01");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-failure.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({
        timestamp: "2026-10-01T00:00:00.000Z", type: "session_meta",
        payload: { id: "codex-failure", cwd: "/work/memo", cli_version: "0.155.0" },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "読めるようになった依頼", images: [] } }),
    ].join("\n") + "\n");
    fs.chmodSync(file, 0o000);
    let degraded;
    try {
      degraded = new CodexSessionStore(home, undefined, { memoFile: new ListMemoFile(memoPath, home, "fp") }).list();
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(degraded).toEqual([]);

    const recovered = new CodexSessionStore(home, undefined, { memoFile: new ListMemoFile(memoPath, home, "fp") }).list();
    expect(recovered[0]!.title).toBe("読めるようになった依頼");
  });

  test("保存ファイルは本人だけが読める権限で置き、止まった engine の古い一時ファイルを掃除する", () => {
    const dir = path.join(makeTempDir("list-memo-perm"), "cache");
    const memoPath = path.join(dir, "claude.json");
    const memo = new ListMemoFile(memoPath, "/root", "fp");
    memo.save([["/a.jsonl", { mtimeMs: 1, size: 1 }]]);
    expect(fs.statSync(memoPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    const staleTmp = `${memoPath}.123.abcd.tmp`;
    const freshTmp = `${memoPath}.456.ef01.tmp`;
    fs.writeFileSync(staleTmp, "{}");
    fs.writeFileSync(freshTmp, "{}");
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(staleTmp, old, old);
    memo.load((value): value is unknown => true);
    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
  });

  test("Codex: 次のインスタンスは保存分を使う", () => {
    const home = makeTempDir("codex-list-memo-persist");
    const memoPath = path.join(makeTempDir("codex-list-memo-file"), "codex.json");
    const dir = path.join(home, "sessions", "2026", "10", "01");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-persist.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({
        timestamp: "2026-10-01T00:00:00.000Z", type: "session_meta",
        payload: { id: "codex-persist", cwd: "/work/memo", cli_version: "0.155.0" },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "引き継ぐ依頼", images: [] } }),
    ].join("\n") + "\n");
    const first = new CodexSessionStore(home, undefined, { memoFile: new ListMemoFile(memoPath, home, "fp") }).list();
    expect(first[0]!.title).toBe("引き継ぐ依頼");

    fs.chmodSync(file, 0o000);
    const next = new CodexSessionStore(home, undefined, { memoFile: new ListMemoFile(memoPath, home, "fp") }).list();
    fs.chmodSync(file, 0o644);
    expect(next).toEqual(first);
  });
});
