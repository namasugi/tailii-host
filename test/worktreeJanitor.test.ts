// worktreeJanitor.test.ts — worktree の片付け（孤児掃除・起動失敗の巻き戻し・完全削除の後片付け・一覧）

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HandlerContext } from "../src/engine/context.js";
import {
  beginWorktreeLaunch,
  isTailiiCreatedWorktree,
  listWorktreesForApp,
  rollbackFailedLaunchWorktree,
  settleWorktreeAfterConversationDelete,
  settleWorktreeAfterKill,
  sweepOrphanWorktrees,
} from "../src/engine/worktreeJanitor.js";
import type { SessionInfo } from "../src/protocol.js";
import {
  gitWorktreeCreate,
  gitWorktreeRemove,
  parseWorktreeList,
  releaseClaimedDirectory,
  rollbackCreatedWorktree,
} from "../src/services/gitService.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { makeTempDir } from "./helpers.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function makeRepository(): string {
  const root = makeTempDir("worktree-janitor");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Tailii Test"]);
  git(root, ["config", "user.email", "tailii@example.invalid"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return fs.realpathSync(root);
}

async function createWorktree(root: string): Promise<{ path: string; branch: string }> {
  const created = await gitWorktreeCreate(root, "main");
  expect(created.ok).toBe(true);
  return { path: fs.realpathSync(created.worktreePath), branch: created.branch };
}

interface FakeWorld {
  sessions: SessionInfo[];
  projects: string;
  registry: string;
  ctx: HandlerContext;
}

function makeWorld(): FakeWorld {
  const projects = makeTempDir("worktree-janitor-projects");
  const world: FakeWorld = {
    sessions: [],
    projects,
    registry: makeTempDir("worktree-janitor-registry"),
    ctx: null as unknown as HandlerContext,
  };
  world.ctx = {
    sessionManager: { list: async () => world.sessions },
    metadataStore: null,
    claudeSessionStore: new ClaudeSessionStore(projects),
    codexSessionStore: null,
  } as unknown as HandlerContext;
  vi.stubEnv("TAILII_CLAUDE_SESSIONS_DIR", world.registry);
  return world;
}

/** cwd の会話ログを 1 件置く（会話一覧に載る）。 */
function writeConversation(world: FakeWorld, cwd: string, id = "12121212-3434-5656-7878-909090909090"): void {
  const dir = path.join(world.projects, claudeProjectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T00:00:00.000Z", message: { content: "hi" } })}\n`);
}

const LATER = { now: Date.now() + 31 * 60 * 1_000 };

function registered(root: string, worktreePath: string): boolean {
  return git(root, ["worktree", "list", "--porcelain"]).includes(`worktree ${worktreePath}\n`);
}

describe("worktreeJanitor", () => {
  let world: FakeWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("孤児掃除: 条件をすべて満たすものだけ消し、変更あり・手動ロック・使用中・作成直後は残す（項目1）", async () => {
    const root = makeRepository();
    const orphan = await createWorktree(root);
    const dirty = await createWorktree(root);
    fs.appendFileSync(path.join(dirty.path, "tracked.txt"), "unsaved\n");
    const committed = await createWorktree(root);
    fs.writeFileSync(path.join(committed.path, "c.txt"), "c\n");
    git(committed.path, ["add", "c.txt"]);
    git(committed.path, ["commit", "-m", "unmerged"]);
    const manual = await createWorktree(root);
    git(root, ["worktree", "unlock", manual.path]);
    git(root, ["worktree", "lock", "--reason", "claude-desktop", manual.path]);
    const unlocked = await createWorktree(root);
    git(root, ["worktree", "unlock", unlocked.path]);
    const withConversation = await createWorktree(root);
    writeConversation(world, withConversation.path);
    const withLiveSession = await createWorktree(root);
    world.sessions = [{ name: "cs-live", cwd: path.join(withLiveSession.path), alive: true }];
    const withPeer = await createWorktree(root);
    fs.writeFileSync(path.join(world.registry, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: "abababab-cdcd-efef-0101-232323232323", cwd: withPeer.path, name: "terminal",
    }));

    // 作成直後は猶予内なので何も消さない。
    expect((await sweepOrphanWorktrees(world.ctx, root)).removed).toEqual([]);
    expect(fs.existsSync(orphan.path)).toBe(true);

    const result = await sweepOrphanWorktrees(world.ctx, root, LATER);
    expect(result.removed).toEqual([orphan.path]);
    expect(fs.existsSync(orphan.path)).toBe(false);
    expect(git(root, ["branch", "--list", orphan.branch]).trim()).toBe("");
    for (const kept of [dirty, committed, manual, unlocked, withConversation, withLiveSession, withPeer]) {
      expect(fs.existsSync(kept.path)).toBe(true);
      expect(registered(root, kept.path)).toBe(true);
    }
  });

  test("孤児掃除: 本体側から呼んでも worktree の中から呼んでも同じリポジトリを掃除する", async () => {
    const root = makeRepository();
    const orphan = await createWorktree(root);
    const other = await createWorktree(root);
    expect((await sweepOrphanWorktrees(world.ctx, other.path, LATER)).removed).toEqual([orphan.path, other.path]);
  });

  test("孤児掃除: 一覧が取れないときは何も消さない", async () => {
    const root = makeRepository();
    const orphan = await createWorktree(root);
    (world.ctx as unknown as { sessionManager: { list: () => Promise<SessionInfo[]> } }).sessionManager.list =
      async () => { throw new Error("tmux unavailable"); };
    expect((await sweepOrphanWorktrees(world.ctx, root, LATER)).removed).toEqual([]);
    expect(fs.existsSync(orphan.path)).toBe(true);
  });

  test("起動失敗の巻き戻し: 今作った変更なしの Tailii worktree だけ消す（項目3）", async () => {
    const root = makeRepository();
    const fresh = await createWorktree(root);
    expect(await rollbackFailedLaunchWorktree(world.ctx, fresh.path)).toBe(true);
    expect(fs.existsSync(fresh.path)).toBe(false);
    expect(git(root, ["branch", "--list", fresh.branch]).trim()).toBe("");

    const dirty = await createWorktree(root);
    fs.writeFileSync(path.join(dirty.path, "new.txt"), "x\n");
    expect(await rollbackFailedLaunchWorktree(world.ctx, dirty.path)).toBe(false);
    expect(fs.existsSync(dirty.path)).toBe(true);

    // 同じ worktree へ別の起動が進行中なら残す。
    const shared = await createWorktree(root);
    const release = beginWorktreeLaunch(shared.path);
    expect(await rollbackFailedLaunchWorktree(world.ctx, shared.path)).toBe(false);
    release();
    expect(fs.existsSync(shared.path)).toBe(true);

    // 手動ロック（Tailii 以外が作ったもの）と、ただのリポジトリは対象外。
    const manual = await createWorktree(root);
    git(root, ["worktree", "unlock", manual.path]);
    expect(await rollbackFailedLaunchWorktree(world.ctx, manual.path)).toBe(false);
    expect(fs.existsSync(manual.path)).toBe(true);
    expect(await rollbackFailedLaunchWorktree(world.ctx, root)).toBe(false);
  });

  test("kill の後片付け: 他の稼働中セッションが使っていれば消さない・変更ありは件数を返す（項目7）", async () => {
    const root = makeRepository();
    const shared = await createWorktree(root);
    world.sessions = [{ name: "cs-other", cwd: shared.path, alive: true }];
    expect(await settleWorktreeAfterKill(world.ctx, { name: "cs-killed", cwd: shared.path, conversationId: null }))
      .toBeNull();
    expect(fs.existsSync(shared.path)).toBe(true);

    world.sessions = [];
    // 終了直後の当の会話の claude が登録簿に残っていても、その会話 id は使用中に数えない。
    const conversationId = "cdcdcdcd-1111-2222-3333-444444444444";
    fs.writeFileSync(path.join(world.registry, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: conversationId, cwd: shared.path, name: "exiting",
    }));
    fs.mkdirSync(path.join(shared.path, "sub"));
    expect(await settleWorktreeAfterKill(world.ctx, {
      name: "cs-killed", cwd: path.join(shared.path, "sub"), conversationId,
    })).toEqual({ worktreePath: shared.path, worktreeRemoved: true });
    expect(fs.existsSync(shared.path)).toBe(false);
    fs.rmSync(path.join(world.registry, `${process.pid}.json`));

    const dirty = await createWorktree(root);
    fs.appendFileSync(path.join(dirty.path, "tracked.txt"), "unsaved\n");
    fs.writeFileSync(path.join(dirty.path, "c.txt"), "c\n");
    git(dirty.path, ["add", "c.txt"]);
    git(dirty.path, ["commit", "-m", "unmerged"]);
    expect(await settleWorktreeAfterKill(world.ctx, { name: "cs-dirty", cwd: dirty.path, conversationId: null }))
      .toEqual({
        worktreePath: dirty.path, worktreeDirty: true,
        worktreeUncommittedCount: 1, worktreeUnmergedCommitCount: 1,
      });
    expect(fs.existsSync(dirty.path)).toBe(true);
  });

  test("完全削除の後片付け: 変更なしは消し、変更ありは件数を返し、他の会話が残れば触れない（項目2）", async () => {
    const root = makeRepository();
    const clean = await createWorktree(root);
    expect(await settleWorktreeAfterConversationDelete(world.ctx, clean.path))
      .toEqual({ worktreePath: clean.path, worktreeRemoved: true });
    expect(fs.existsSync(clean.path)).toBe(false);

    const dirty = await createWorktree(root);
    fs.writeFileSync(path.join(dirty.path, "a.txt"), "a\n");
    fs.writeFileSync(path.join(dirty.path, "b.txt"), "b\n");
    expect(await settleWorktreeAfterConversationDelete(world.ctx, dirty.path)).toEqual({
      worktreePath: dirty.path, worktreeDirty: true, worktreeUncommittedCount: 2, worktreeUnmergedCommitCount: 0,
    });
    expect(fs.existsSync(dirty.path)).toBe(true);

    const stillUsed = await createWorktree(root);
    writeConversation(world, stillUsed.path);
    expect(await settleWorktreeAfterConversationDelete(world.ctx, stillUsed.path)).toBeNull();
    expect(fs.existsSync(stillUsed.path)).toBe(true);

    expect(await settleWorktreeAfterConversationDelete(world.ctx, root)).toBeNull();
  });

  test("完全削除の後片付けは Tailii 以外の worktree を消さず、ロックも外さない（レビュー指摘1）", async () => {
    const root = makeRepository();
    // Desktop のロック・変更なし
    const desktop = path.join(root, ".claude", "worktrees", "desktop-x");
    git(root, ["worktree", "add", desktop, "-b", "desktop-x", "main"]);
    git(root, ["worktree", "lock", "--reason", "claude-desktop", desktop]);
    expect(await settleWorktreeAfterConversationDelete(world.ctx, desktop)).toBeNull();
    expect(fs.existsSync(desktop)).toBe(true);
    // ロック無しの手動 worktree・変更なし
    const manual = path.join(root, ".claude", "worktrees", "api-agent-ios");
    git(root, ["worktree", "add", manual, "-b", "api-agent", "main"]);
    expect(await settleWorktreeAfterConversationDelete(world.ctx, manual)).toBeNull();
    expect(fs.existsSync(manual)).toBe(true);
    // Desktop のロック・変更あり: ロックは外さない
    fs.appendFileSync(path.join(desktop, "tracked.txt"), "unsaved\n");
    expect(await settleWorktreeAfterConversationDelete(world.ctx, desktop)).toBeNull();
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain("locked claude-desktop");

    // 変更ありの終了でロックを外された Tailii worktree は、命名とブランチで Tailii 製と分かれば片付ける。
    const unlocked = await createWorktree(root);
    git(root, ["worktree", "unlock", unlocked.path]);
    expect(await settleWorktreeAfterConversationDelete(world.ctx, unlocked.path))
      .toEqual({ worktreePath: unlocked.path, worktreeRemoved: true });
  });

  test("kill の後片付けは他のツールのロックを外さない（レビュー指摘1）", async () => {
    const root = makeRepository();
    const desktop = path.join(root, ".claude", "worktrees", "desktop-y");
    git(root, ["worktree", "add", desktop, "-b", "desktop-y", "main"]);
    git(root, ["worktree", "lock", "--reason", "claude-desktop", desktop]);
    fs.appendFileSync(path.join(desktop, "tracked.txt"), "unsaved\n");
    const fields = await settleWorktreeAfterKill(world.ctx, { name: "cs-d", cwd: desktop, conversationId: null });
    expect(fields).toMatchObject({ worktreePath: fs.realpathSync(desktop), worktreeDirty: true });
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain("locked claude-desktop");
  });

  test("Tailii 製の判定は tailii-session のロックか、ロック無しで命名とブランチがそろうものだけ", () => {
    const [main, locked, renamed, foreign, manual] = parseWorktreeList([
      "worktree /r", "HEAD a", "branch refs/heads/main", "",
      "worktree /r/.claude/worktrees/20260713-122202", "HEAD b", "branch refs/heads/tailii/20260713-122202", "locked tailii-session", "",
      "worktree /r/.claude/worktrees/20260728-161129-2", "HEAD c", "branch refs/heads/worktree-20260728-161129-2", "",
      "worktree /r/.claude/worktrees/20260728-161129", "HEAD d", "branch refs/heads/worktree-20260728-161129", "locked claude-desktop", "",
      "worktree /r/.claude/worktrees/20260728-161130", "HEAD e", "branch refs/heads/feature/x", "",
    ].join("\n"));
    expect(isTailiiCreatedWorktree(main!)).toBe(false);
    expect(isTailiiCreatedWorktree(locked!)).toBe(true);
    expect(isTailiiCreatedWorktree(renamed!)).toBe(true);
    expect(isTailiiCreatedWorktree(foreign!)).toBe(false);
    expect(isTailiiCreatedWorktree(manual!)).toBe(false);
  });

  test("起動失敗の巻き戻しは作成から猶予内の worktree だけ（レビュー指摘3）", async () => {
    const root = makeRepository();
    const old = await createWorktree(root);
    expect(await rollbackFailedLaunchWorktree(world.ctx, old.path, LATER)).toBe(false);
    expect(fs.existsSync(old.path)).toBe(true);
  });

  test("フォルダが消えた登録は自動では消さず、一覧で知らせ、手動で外せる（レビュー指摘8・2周目2）", async () => {
    const root = makeRepository();
    const vanished = await createWorktree(root);
    fs.rmSync(vanished.path, { recursive: true, force: true });
    expect((await sweepOrphanWorktrees(world.ctx, root, LATER)).removed).toEqual([]);
    const listed = await listWorktreesForApp(world.ctx, root);
    expect(listed).toEqual({
      removedPaths: [],
      worktrees: [{
        path: vanished.path, branch: vanished.branch, hasChanges: true, inUse: false, missing: true,
        unmergedCommitCount: 0,
      }],
    });
    // アプリからの削除要求で、その 1 件だけ外れる（ロック付きのまま消えたもの）。
    await expect(gitWorktreeRemove(vanished.path, true)).resolves.toEqual({ ok: true, error: null });
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(vanished.path);
  });

  test("削除は対象の 1 件だけを外し、関係ない消えた worktree の登録を巻き込まない（2周目1）", async () => {
    const root = makeRepository();
    const outside = fs.realpathSync(makeTempDir("worktree-janitor-external"));
    const external = path.join(outside, "ext");
    git(root, ["worktree", "add", external, "-b", "external", "main"]);
    fs.renameSync(external, path.join(outside, "ext-moved"));  // 外付けドライブを外した状態の代わり
    const orphan = await createWorktree(root);
    expect((await sweepOrphanWorktrees(world.ctx, root, LATER)).removed).toEqual([orphan.path]);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain(`worktree ${external}\n`);
  });

  test("削除に失敗したら元のロックを掛け直す（2周目3）", async () => {
    const root = makeRepository();
    const created = await createWorktree(root);
    fs.writeFileSync(path.join(created.path, "untracked.txt"), "x\n");
    const result = await gitWorktreeRemove(created.path, false);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(created.path)).toBe(true);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain("locked tailii-session");
  });

  test("完全削除から呼ぶ kill の後片付けは Tailii 製だけ（2周目5）", async () => {
    const root = makeRepository();
    const desktop = path.join(root, ".claude", "worktrees", "bright-fox");
    git(root, ["worktree", "add", desktop, "-b", "bright-fox", "main"]);
    git(root, ["worktree", "lock", "--reason", "claude-desktop", desktop]);
    expect(await settleWorktreeAfterKill(
      world.ctx, { name: "cs-x", cwd: desktop, conversationId: null }, { tailiiOnly: true },
    )).toBeNull();
    expect(fs.existsSync(desktop)).toBe(true);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain("locked claude-desktop");
  });

  test("フォルダが消えた登録で、どこにも無いコミットがあるもの: 自動では消さず、件数を出し、手動削除でもブランチは残す（3周目1）", async () => {
    const root = makeRepository();
    const vanished = await createWorktree(root);
    fs.writeFileSync(path.join(vanished.path, "c.txt"), "c\n");
    git(vanished.path, ["add", "c.txt"]);
    git(vanished.path, ["commit", "-m", "only here"]);
    const moved = path.join(fs.realpathSync(makeTempDir("worktree-janitor-moved")), "moved");
    fs.renameSync(vanished.path, moved);
    expect((await sweepOrphanWorktrees(world.ctx, root, LATER)).removed).toEqual([]);
    const listed = await listWorktreesForApp(world.ctx, root);
    expect(listed?.worktrees).toEqual([{
      path: vanished.path, branch: vanished.branch, hasChanges: true, inUse: false, missing: true,
      unmergedCommitCount: 1,
    }]);
    // 二段階確認を経た force の削除でも、登録だけ外してコミットを持つブランチは残す。
    await expect(gitWorktreeRemove(vanished.path, true)).resolves.toEqual({ ok: true, error: null });
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(vanished.path);
    expect(git(root, ["log", "-1", "--format=%s", vanished.branch]).trim()).toBe("only here");
  });

  test("フォルダが消えた detached の登録は、どこにも無いコミットがあれば外さない（4周目A）", async () => {
    const root = makeRepository();
    const detached = await createWorktree(root);
    git(detached.path, ["checkout", "-q", "--detach"]);
    fs.writeFileSync(path.join(detached.path, "d.txt"), "d\n");
    git(detached.path, ["add", "d.txt"]);
    git(detached.path, ["commit", "-m", "detached only"]);
    const sha = git(detached.path, ["rev-parse", "HEAD"]).trim();
    fs.renameSync(detached.path, path.join(fs.realpathSync(makeTempDir("worktree-janitor-moved-d")), "moved"));
    const listed = await listWorktreesForApp(world.ctx, root);
    expect(listed?.worktrees.find((item) => item.path === detached.path)).toMatchObject({
      branch: null, missing: true, unmergedCommitCount: 1,
    });
    const result = await gitWorktreeRemove(detached.path, true);
    expect(result.ok).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain(detached.path);
    expect(git(root, ["cat-file", "-t", sha]).trim()).toBe("commit");

    // どこかのブランチに含まれる detached なら外せる。
    const merged = await createWorktree(root);
    git(merged.path, ["checkout", "-q", "--detach"]);
    fs.rmSync(merged.path, { recursive: true, force: true });
    await expect(gitWorktreeRemove(merged.path, true)).resolves.toEqual({ ok: true, error: null });
  });

  test("衝突時の片付けは空のフォルダだけ消し、中身のあるフォルダ（相手の worktree）は残す（2周目4）", () => {
    const base = fs.realpathSync(makeTempDir("worktree-janitor-claim"));
    const empty = path.join(base, "empty");
    fs.mkdirSync(empty);
    releaseClaimedDirectory(empty);
    expect(fs.existsSync(empty)).toBe(false);
    const occupied = path.join(base, "occupied");
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, "theirs.txt"), "x\n");
    releaseClaimedDirectory(occupied);
    expect(fs.readFileSync(path.join(occupied, "theirs.txt"), "utf8")).toBe("x\n");
  });

  test("巻き戻しは、そのパスの登録が別のブランチなら触れない（2周目4）", async () => {
    const root = makeRepository();
    const theirs = path.join(root, ".claude", "worktrees", "20260101-000000");
    git(root, ["worktree", "add", theirs, "-b", "someone-else", "main"]);
    git(root, ["branch", "worktree-20260101-000000", "main"]);
    await rollbackCreatedWorktree(root, theirs, "worktree-20260101-000000");
    expect(fs.existsSync(path.join(theirs, "tracked.txt"))).toBe(true);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain("branch refs/heads/someone-else");
    expect(git(root, ["branch", "--list", "someone-else"])).toContain("someone-else");
  });

  test("孤児掃除は消す直前に使用状況を取り直す（2周目6）", async () => {
    const root = makeRepository();
    const orphan = await createWorktree(root);
    let calls = 0;
    (world.ctx as unknown as { sessionManager: { list: () => Promise<SessionInfo[]> } }).sessionManager.list =
      async () => {
        calls += 1;
        // 1 回目（まとめて集める写し）は空、2 回目（削除直前）は別の engine がこの worktree で起動した状態。
        return calls === 1 ? [] : [{ name: "cs-late", cwd: orphan.path, alive: true }];
      };
    expect((await sweepOrphanWorktrees(world.ctx, root, LATER)).removed).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(orphan.path)).toBe(true);
  });

  test("一覧: パス・ブランチ・変更の有無・使用中・件数を返す（項目5）", async () => {
    const root = makeRepository();
    const free = await createWorktree(root);
    const used = await createWorktree(root);
    writeConversation(world, used.path);
    fs.appendFileSync(path.join(used.path, "tracked.txt"), "unsaved\n");
    const listed = await listWorktreesForApp(world.ctx, root);
    expect(listed).toEqual({
      removedPaths: [],
      worktrees: [
        { path: free.path, branch: free.branch, hasChanges: false, inUse: false, uncommittedCount: 0, unmergedCommitCount: 0 },
        { path: used.path, branch: used.branch, hasChanges: true, inUse: true, uncommittedCount: 1, unmergedCommitCount: 0 },
      ],
    });
    expect(await listWorktreesForApp(world.ctx, makeTempDir("worktree-janitor-non-repo"))).toBeNull();
  });
});
