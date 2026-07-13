// sessionListActivity.test.ts
// 一覧の updatedAt 権威が「セッション自身の会話 transcript の mtime」であることの回帰テスト。
// 旧実装の2つの誤整列を封じる:
//   1. tmux `#{session_activity}` 起因 — セッション作成自体が「活動」になり、会話ゼロの
//      新規セッションが実会話より上に浮く（2026-07-08 ユーザー報告）。
//   2. cwd 共有 mtime 起因 — 同一 cwd の別セッションの会話時刻を継承して浮く。
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { ClaudeSessionStore } from "../src/claudeSessionStore.js";
import { CodexSessionStore } from "../src/codexSessionStore.js";
import { activitySlugForCwd, ownTranscriptActivityProvider } from "../src/sessionActivityProvider.js";
import { SessionListService } from "../src/sessionListService.js";
import { claudeProjectSlug } from "../src/paths.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { MockTmuxRunner, makeTempDir, makeTempStore, ok } from "./helpers.js";

/**
 * projects ルート配下に <slug>/<uuid>.jsonl を作り、最終会話時刻 = tsSecs のエントリを書く。
 * mtime は故意に未来へずらす（resume の状態行追記で mtime が進む実挙動の再現 = mtime 非依存の検証）。
 */
function writeTranscript(root: string, cwd: string, sessionId: string, tsSecs: number): void {
  const dir = path.join(root, activitySlugForCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const iso = new Date(tsSecs * 1000).toISOString();
  fs.writeFileSync(
    file,
    `{"type":"user","timestamp":"${iso}","message":{"content":"x"}}\n` +
      '{"type":"last-prompt"}\n{"type":"mode","mode":"normal"}\n',
  );
  fs.utimesSync(file, tsSecs + 999_999, tsSecs + 999_999);
}

describe("session list activity ordering (own-transcript authority)", () => {
  const CWD = "/same/project";

  function makeFixture() {
    const store = makeTempStore();
    const projectsRoot = makeTempDir("tailii-claude-projects");
    const provider = ownTranscriptActivityProvider({
      metadataStore: store,
      claudeStore: new ClaudeSessionStore(projectsRoot),
      codexStore: new CodexSessionStore(makeTempDir("tailii-codex-home")),
    });
    const runner = new MockTmuxRunner((args) =>
      args[0] === "ls" ? ok("cs-a\ncs-b\ncs-c\n") : ok(""),
    );
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    return { store, projectsRoot, provider, mgr };
  }

  test("同一 cwd でもセッション個別の transcript mtime で整列する", async () => {
    const { store, projectsRoot, provider, mgr } = makeFixture();
    for (const [name, sid, mtime] of [
      ["cs-a", "aaaaaaaa-0000-0000-0000-000000000000", 100],
      ["cs-b", "bbbbbbbb-0000-0000-0000-000000000000", 300],
      ["cs-c", "cccccccc-0000-0000-0000-000000000000", 200],
    ] as const) {
      store.put({ name, cwd: CWD, createdAt: 0, claudeSessionId: sid });
      writeTranscript(projectsRoot, CWD, sid, mtime);
    }
    const service = new SessionListService(mgr, provider);
    const page = await service.page(10, undefined);
    expect(page.sessions.map((s) => s.name)).toEqual(["cs-b", "cs-c", "cs-a"]); // 300,200,100 desc
    expect(page.sessions.map((s) => s.updatedAt)).toEqual([300, 200, 100]);
  });

  test("会話ゼロ（transcript 不在）のセッションは最下位に沈む", async () => {
    const { store, projectsRoot, provider, mgr } = makeFixture();
    // cs-a: 実会話あり(古い)。cs-b: 作っただけ(id はあるが transcript 無し)。cs-c: メタに id すら無し。
    store.put({
      name: "cs-a",
      cwd: CWD,
      createdAt: 0,
      claudeSessionId: "aaaaaaaa-0000-0000-0000-000000000000",
    });
    writeTranscript(projectsRoot, CWD, "aaaaaaaa-0000-0000-0000-000000000000", 100);
    store.put({
      name: "cs-b",
      cwd: CWD,
      createdAt: 9999,
      claudeSessionId: "bbbbbbbb-0000-0000-0000-000000000000",
    });
    store.put({ name: "cs-c", cwd: CWD, createdAt: 9999 });
    const service = new SessionListService(mgr, provider);
    const page = await service.page(10, undefined);
    // 会話ありが先頭。会話ゼロ2つは updatedAt なし(=0) で末尾、name 昇順で安定。
    expect(page.sessions.map((s) => s.name)).toEqual(["cs-a", "cs-b", "cs-c"]);
    expect(page.sessions[0]?.updatedAt).toBe(100);
    expect(page.sessions[1]?.updatedAt).toBeUndefined();
    expect(page.sessions[2]?.updatedAt).toBeUndefined();
  });

  test("同一 cwd の別セッションの会話 mtime を継承しない（cwd 共有 mtime の禁止）", async () => {
    const { store, projectsRoot, provider, mgr } = makeFixture();
    // cs-a は活発に会話中(9000)。cs-b は同じ cwd に作っただけ。cs-c は古い実会話(50)。
    store.put({
      name: "cs-a",
      cwd: CWD,
      createdAt: 0,
      claudeSessionId: "aaaaaaaa-0000-0000-0000-000000000000",
    });
    writeTranscript(projectsRoot, CWD, "aaaaaaaa-0000-0000-0000-000000000000", 9000);
    store.put({
      name: "cs-b",
      cwd: CWD,
      createdAt: 9500,
      claudeSessionId: "bbbbbbbb-0000-0000-0000-000000000000",
    });
    store.put({
      name: "cs-c",
      cwd: CWD,
      createdAt: 0,
      claudeSessionId: "cccccccc-0000-0000-0000-000000000000",
    });
    writeTranscript(projectsRoot, CWD, "cccccccc-0000-0000-0000-000000000000", 50);
    const service = new SessionListService(mgr, provider);
    const page = await service.page(10, undefined);
    // cs-b が cs-a の新しい mtime を継承して cs-c より上に来てはいけない。
    expect(page.sessions.map((s) => s.name)).toEqual(["cs-a", "cs-c", "cs-b"]);
  });

  test("tmux list() は updatedAt を付与しない（session_activity 非依存）", async () => {
    const { store, mgr } = makeFixture();
    for (const name of ["cs-a", "cs-b", "cs-c"]) {
      store.put({ name, cwd: CWD, createdAt: 0 });
    }
    const infos = await mgr.list();
    expect(infos).toHaveLength(3);
    for (const info of infos) {
      expect(info.updatedAt).toBeUndefined();
      expect(info.alive).toBe(true);
    }
  });

  test("Codex activity は同一 cwd ごとに1回だけ解決する", async () => {
    const store = makeTempStore();
    for (const [name, cwd] of [
      ["cs-codex-a", "/same"],
      ["cs-codex-b", "/same"],
      ["cs-codex-c", "/other"],
    ] as const) {
      store.put({ name, cwd, createdAt: 0, agent: "codex" });
    }
    const runner = new MockTmuxRunner((args) =>
      args[0] === "ls" ? ok("cs-codex-a\ncs-codex-b\ncs-codex-c\n") : ok(""),
    );
    const calls: string[] = [];
    const service = new SessionListService(
      new TmuxSessionManager({ runner: runner.runner, store }),
      (info) => { calls.push(info.cwd); return info.cwd === "/same" ? 20 : 10; },
    );

    const page = await service.page(10, undefined);

    expect(calls).toEqual(["/same", "/other"]);
    expect(page.sessions.map((info) => info.updatedAt)).toEqual([20, 20, 10]);
  });
});

describe("claudeProjectSlug", () => {
  test("Claude と同じ規則で / と . を - に置換する（worktree cwd）", () => {
    // 実在しないパスは canonicalPath が字句正準化のみ行う（決定的）。
    expect(claudeProjectSlug("/Users/alice/proj/.claude/worktrees/20260713-1200")).toBe(
      "-Users-alice-proj--claude-worktrees-20260713-1200",
    );
    expect(claudeProjectSlug("/Users/alice/app.v2")).toBe("-Users-alice-app-v2");
  });
});
