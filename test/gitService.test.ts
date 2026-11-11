// gitService.test.ts — 実 git リポジトリを使う Git サービス検証

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  gitBranchList,
  gitCheckout,
  gitDiff,
  gitDiscard,
  gitEntryStatuses,
  gitInit,
  gitLog,
  gitStatus,
  classifyWorktreeAddFailure,
  gitManagedWorktrees,
  gitWorktreeChangeSummary,
  gitWorktreeCreate,
  gitWorktreeIsClean,
  gitWorktreeRemove,
  isTailiiWorktreePath,
  parsePorcelainV2,
  parseWorktreeList,
  resolveManagedWorktree,
  resolveManagedWorktreeForCwd,
  tailiiWorktreeRepoRoot,
} from "../src/services/gitService.js";
import { makeTempDir } from "./helpers.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function makeRepository(): string {
  const root = makeTempDir("git-service");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Tailii Test"]);
  git(root, ["config", "user.email", "tailii@example.invalid"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  // macOS の /tmp は /private への symlink で、git rev-parse --show-toplevel は実パスを返す。
  return fs.realpathSync(root);
}

function makeWorktreeRepository(): string {
  const root = makeRepository();
  fs.writeFileSync(path.join(root, ".gitignore"), "*.env\nignored-dir/\nignored-only.bin\n");
  fs.writeFileSync(path.join(root, ".worktreeinclude"), [
    "# worktree local files",
    "",
    "*.env",
    "ignored-dir/",
    "tracked.txt",
    "unignored.txt",
  ].join("\n"));
  git(root, ["add", ".gitignore", ".worktreeinclude"]);
  git(root, ["commit", "-m", "worktree config"]);
  fs.writeFileSync(path.join(root, "app.env"), "TOKEN=test\n");
  fs.mkdirSync(path.join(root, "ignored-dir", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "ignored-dir", "nested", "local.txt"), "local\n");
  fs.writeFileSync(path.join(root, "ignored-only.bin"), "ignored but not included\n");
  fs.writeFileSync(path.join(root, "unignored.txt"), "untracked but not ignored\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "dirty source version\n");
  return root;
}

describe("parsePorcelainV2", () => {
  test("branch、ahead/behind、通常・rename・untracked を解析する", () => {
    const parsed = parsePorcelainV2([
      "# branch.oid abcdef0123456789",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 M. N... 100644 100644 100644 a a src/a.ts",
      "1 .M N... 100644 100644 100644 a a path with spaces.txt",
      "2 R. N... 100644 100644 100644 a a R100 new.ts\told.ts",
      "? new.txt",
      '? "caf\\303\\251.txt"',
    ].join("\n"));
    expect(parsed).toEqual({
      branch: "main", upstream: "origin/main", ahead: 2, behind: 3,
      files: [
        { path: "src/a.ts", indexStatus: "M", worktreeStatus: ".", renamedFrom: null },
        { path: "path with spaces.txt", indexStatus: ".", worktreeStatus: "M", renamedFrom: null },
        { path: "new.ts", indexStatus: "R", worktreeStatus: ".", renamedFrom: "old.ts" },
        { path: "new.txt", indexStatus: "?", worktreeStatus: "?", renamedFrom: null },
        { path: "café.txt", indexStatus: "?", worktreeStatus: "?", renamedFrom: null },
      ],
    });
  });
});

describe("gitService", () => {
  test("status は repoRoot と HEAD 基準の diffstat を返す", async () => {
    const root = makeRepository();
    await expect(gitStatus(root)).resolves.toMatchObject({
      isRepo: true, repoRoot: root, diffAdditions: 0, diffDeletions: 0,
    });
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\nadded\n");

    const status = await gitStatus(root);
    expect(status).toMatchObject({
      isRepo: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      repoRoot: root,
      diffAdditions: 2,
      diffDeletions: 1,
    });
    expect(status.files).toContainEqual(expect.objectContaining({
      path: "tracked.txt", indexStatus: ".", worktreeStatus: "M",
    }));
  });

  test("status は unborn HEAD で unstaged diffstat へフォールバックする", async () => {
    const root = fs.realpathSync(makeTempDir("git-service-unborn"));
    git(root, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(root, "new.txt"), "one\n");
    git(root, ["add", "new.txt"]);
    fs.appendFileSync(path.join(root, "new.txt"), "two\n");

    await expect(gitStatus(root)).resolves.toMatchObject({
      isRepo: true,
      repoRoot: root,
      diffAdditions: 1,
      diffDeletions: 0,
    });
  });

  test("diff と log を処理する", async () => {
    const root = makeRepository();
    fs.appendFileSync(path.join(root, "tracked.txt"), "two\n");

    await expect(gitDiff(root, { file: "tracked.txt" })).resolves.toMatchObject({
      isRepo: true, diff: expect.stringContaining("+two"), truncated: false,
    });
    const log = await gitLog(root, 1);
    expect(log).toMatchObject({
      isRepo: true,
      commits: [expect.objectContaining({ subject: "initial", authorName: "Tailii Test" })],
    });
  });

  test("diff は untracked ファイルを新規追加として返す", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "new file.txt"), "first\nsecond\n");

    await expect(gitDiff(root, {
      file: "new file.txt", staged: false, commit: null,
    })).resolves.toMatchObject({
      isRepo: true,
      diff: expect.stringMatching(/new file mode[\s\S]*\+first[\s\S]*\+second/),
      truncated: false,
    });
  });

  test("diff は status がまとめた untracked ディレクトリ配下も返す", async () => {
    const root = makeRepository();
    fs.mkdirSync(path.join(root, "new-dir"));
    fs.writeFileSync(path.join(root, "new-dir", "inside.txt"), "inside\n");

    await expect(gitDiff(root, {
      file: "new-dir/", staged: false, commit: null,
    })).resolves.toMatchObject({
      isRepo: true,
      diff: expect.stringMatching(/new file mode[\s\S]*\+inside/),
      truncated: false,
    });
  });

  test("branch list は upstream 有無と checkout -b 直後の current branch を返す", async () => {
    const root = makeRepository();
    git(root, ["branch", "without-upstream"]);
    git(root, ["checkout", "-b", "tracking"]);
    fs.writeFileSync(path.join(root, "branch.txt"), "tracking\n");
    git(root, ["add", "branch.txt"]);
    git(root, ["commit", "-m", "tracking commit"]);
    git(root, ["branch", "--set-upstream-to=main", "tracking"]);

    const listed = await gitBranchList(root);
    expect(listed.isRepo).toBe(true);
    expect(listed.branches.find((branch) => branch.name === "tracking")).toMatchObject({
      subject: "tracking commit", isCurrent: true, ahead: 1, behind: 0,
    });
    expect(listed.branches.find((branch) => branch.name === "without-upstream")).toMatchObject({
      isCurrent: false, ahead: 0, behind: 0,
    });

    await expect(gitCheckout(root, "fresh", true)).resolves.toEqual({
      ok: true, branch: "fresh", error: null,
    });
    const fresh = (await gitBranchList(root)).branches.find((branch) => branch.name === "fresh");
    expect(fresh).toMatchObject({ isCurrent: true, ahead: 0, behind: 0 });
    expect(Number.isFinite(fresh?.dateMs)).toBe(true);
  });

  test("checkout は clean 切替に成功し、dirty 衝突を報告する", async () => {
    const root = makeRepository();
    git(root, ["checkout", "-b", "conflict"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "branch version\n");
    git(root, ["commit", "-am", "conflicting branch"]);
    git(root, ["checkout", "main"]);

    await expect(gitCheckout(root, "conflict", false)).resolves.toEqual({
      ok: true, branch: "conflict", error: null,
    });
    await expect(gitCheckout(root, "main", false)).resolves.toEqual({
      ok: true, branch: "main", error: null,
    });

    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty worktree\n");
    const failed = await gitCheckout(root, "conflict", false);
    expect(failed).toMatchObject({ ok: false, branch: "conflict" });
    expect(failed.error).toEqual(expect.any(String));
    expect(failed.error?.length).toBeGreaterThan(0);
  });

  test("checkout -b は dirty worktree を保持して成功する", async () => {
    const root = makeRepository();
    fs.appendFileSync(path.join(root, "tracked.txt"), "dirty\n");
    await expect(gitCheckout(root, "dirty-branch", true)).resolves.toEqual({
      ok: true, branch: "dirty-branch", error: null,
    });
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toContain("dirty");
  });

  test("discard は tracked の worktree 変更を復元する", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    await expect(gitDiscard(root, ["tracked.txt"])).resolves.toEqual({ ok: true, error: null });
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("one\n");
  });

  test("discard は staged と worktree の両方を HEAD へ復元する", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "staged\n");
    git(root, ["add", "tracked.txt"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "worktree\n");

    await expect(gitDiscard(root, ["tracked.txt"])).resolves.toEqual({ ok: true, error: null });
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("one\n");
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });

  test("discard は untracked ファイルとディレクトリを削除する", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "untracked.txt"), "new\n");
    fs.mkdirSync(path.join(root, "untracked-dir"));
    fs.writeFileSync(path.join(root, "untracked-dir", "nested.txt"), "new\n");
    await expect(gitDiscard(root, ["untracked.txt", "untracked-dir"])).resolves.toEqual({
      ok: true, error: null,
    });
    expect(fs.existsSync(path.join(root, "untracked.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "untracked-dir"))).toBe(false);
  });

  test("discard は staged rename を元のパスへ戻す", async () => {
    const root = makeRepository();
    git(root, ["mv", "tracked.txt", "renamed.txt"]);
    await expect(gitDiscard(root, ["renamed.txt"])).resolves.toEqual({ ok: true, error: null });
    expect(fs.existsSync(path.join(root, "renamed.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("one\n");
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });

  test("discard は tracked と untracked の混在選択を分類し直す", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    fs.writeFileSync(path.join(root, "untracked.txt"), "new\n");

    await expect(gitDiscard(root, ["tracked.txt", "untracked.txt"])).resolves.toEqual({
      ok: true, error: null,
    });
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(root, "untracked.txt"))).toBe(false);
  });

  test("init は main ブランチで初期化し、二重 init を拒否する", async () => {
    const root = makeTempDir("git-service-init");
    await expect(gitInit(root)).resolves.toEqual({ ok: true, error: null });
    expect(git(root, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe("main");
    const second = await gitInit(root);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("既に Git リポジトリ");
  });

  test("entry statuses は変更ファイルと配下変更のあるディレクトリへ badge を返す", async () => {
    const root = makeRepository();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "nested.txt"), "one\n");
    git(root, ["add", "src/nested.txt"]);
    git(root, ["commit", "-m", "add directory"]);
    fs.appendFileSync(path.join(root, "tracked.txt"), "two\n");
    fs.appendFileSync(path.join(root, "src", "nested.txt"), "two\n");

    const statuses = await gitEntryStatuses(root, ["tracked.txt", "src"]);
    expect(statuses).toEqual(new Map([["tracked.txt", "M"], ["src", "M"]]));
    await expect(gitEntryStatuses(path.join(root, "src"), ["nested.txt"])).resolves.toEqual(new Map([
      ["nested.txt", "M"],
    ]));
  });

  test("entry statuses は clean と非 repo で空 Map を返す", async () => {
    const root = makeRepository();
    await expect(gitEntryStatuses(root, ["tracked.txt"])).resolves.toEqual(new Map());
    const nonRepo = makeTempDir("git-service-entry-non-repo");
    await expect(gitEntryStatuses(nonRepo, ["a.txt"])).resolves.toEqual(new Map());
  });

  test("entry statuses は index より worktree 側を優先する", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "staged\n");
    git(root, ["add", "tracked.txt"]);
    fs.rmSync(path.join(root, "tracked.txt"));
    await expect(gitEntryStatuses(root, ["tracked.txt"])).resolves.toEqual(new Map([
      ["tracked.txt", "D"],
    ]));
  });

  test("非リポジトリは正常な isRepo:false / ok:false 応答にする", async () => {
    const root = makeTempDir("git-service-not-repo");
    await expect(gitStatus(root)).resolves.toEqual({
      isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [],
    });
    await expect(gitDiff(root)).resolves.toEqual({ isRepo: false, diff: "", truncated: false });
    await expect(gitLog(root)).resolves.toEqual({ isRepo: false, commits: [] });
    await expect(gitBranchList(root)).resolves.toEqual({ isRepo: false, branches: [] });
    await expect(gitCheckout(root, "main", false)).resolves.toMatchObject({ ok: false, branch: "main" });
    await expect(gitDiscard(root, ["a.txt"])).resolves.toMatchObject({ ok: false });
  });

  test("空の discard 対象を拒否する", async () => {
    await expect(gitDiscard(makeRepository(), [])).resolves.toMatchObject({ ok: false });
  });

  test("diff を200000文字で切り詰める", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), `one\n${"x".repeat(210_000)}\n`);
    const result = await gitDiff(root);
    expect(result.diff).toHaveLength(200_000);
    expect(result.truncated).toBe(true);
  });
});

describe("gitService worktree", () => {
  test("create は公式 branch・lock・exclude を作り、worktreeinclude の積集合だけをコピーする", async () => {
    const root = makeWorktreeRepository();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0));
    try {
      const first = await gitWorktreeCreate(root, "main");
      expect(first).toEqual({
        ok: true,
        branch: "worktree-20260713-120000",
        worktreePath: path.join(root, ".claude", "worktrees", "20260713-120000"),
        error: null,
      });
      expect(fs.realpathSync(first.worktreePath)).toBe(fs.realpathSync(path.join(
        root, ".claude", "worktrees", "20260713-120000",
      )));
      expect(git(root, ["branch", "--list", first.branch]).trim()).toContain(first.branch);
      expect(git(root, ["worktree", "list", "--porcelain"])).toContain(
        `worktree ${fs.realpathSync(first.worktreePath)}\nHEAD `,
      );
      expect(git(root, ["worktree", "list", "--porcelain"])).toContain("locked tailii-session");
      expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")
        .split(/\r?\n/).filter((line) => line === ".claude/worktrees/")).toHaveLength(1);
      expect(fs.readFileSync(path.join(first.worktreePath, "app.env"), "utf8")).toBe("TOKEN=test\n");
      expect(fs.readFileSync(path.join(
        first.worktreePath, "ignored-dir", "nested", "local.txt",
      ), "utf8")).toBe("local\n");
      expect(fs.readFileSync(path.join(first.worktreePath, "tracked.txt"), "utf8")).toBe("one\n");
      expect(fs.existsSync(path.join(first.worktreePath, "unignored.txt"))).toBe(false);
      expect(fs.existsSync(path.join(first.worktreePath, "ignored-only.bin"))).toBe(false);

      const second = await gitWorktreeCreate(root, "main");
      expect(second).toMatchObject({
        ok: true,
        branch: "worktree-20260713-120000-2",
        worktreePath: path.join(root, ".claude", "worktrees", "20260713-120000-2"),
        error: null,
      });
      expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")
        .split(/\r?\n/).filter((line) => line === ".claude/worktrees/")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("create は .worktreeinclude 不在なら ignored ファイルをコピーしない", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, ".gitignore"), "*.env\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "add ignore"]);
    fs.writeFileSync(path.join(root, "local.env"), "TOKEN=test\n");

    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    expect(fs.existsSync(path.join(created.worktreePath, "local.env"))).toBe(false);
  });

  test("create は worktreeinclude コピー失敗を best-effort にする", async () => {
    const root = makeRepository();
    fs.mkdirSync(path.join(root, ".worktreeinclude"));

    const created = await gitWorktreeCreate(root, "main");
    expect(created).toMatchObject({ ok: true, error: null });
    expect(fs.existsSync(created.worktreePath)).toBe(true);
  });

  test("create は非 repo と存在しない base を ok:false に正規化する", async () => {
    const nonRepo = fs.realpathSync(makeTempDir("git-worktree-non-repo"));
    await expect(gitWorktreeCreate(nonRepo, "main")).resolves.toMatchObject({
      ok: false, branch: "", worktreePath: "", error: expect.any(String),
    });

    const root = makeRepository();
    const missingBase = await gitWorktreeCreate(root, "does-not-exist");
    // 起点は名前を決める前に検証する（存在しない起点で worktree もブランチも作らない）。
    expect(missingBase).toMatchObject({ ok: false, branch: "", worktreePath: "", error: expect.stringContaining("does-not-exist") });
    expect(git(root, ["branch", "--list", "worktree-*"]).trim()).toBe("");
    expect(fs.existsSync(path.join(root, ".claude", "worktrees"))).toBe(false);

    const unborn = fs.realpathSync(makeTempDir("git-worktree-unborn"));
    git(unborn, ["init", "-b", "main"]);
    await expect(gitWorktreeCreate(unborn, "main")).resolves.toMatchObject({
      ok: false, branch: "", error: expect.any(String),
    });
  });

  test("isClean は直後のみ true で、未コミット変更と worktree 上の新規 commit は false", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);
    await expect(gitWorktreeIsClean(worktreePath)).resolves.toBe(true);

    fs.appendFileSync(path.join(worktreePath, "tracked.txt"), "dirty\n");
    await expect(gitWorktreeIsClean(worktreePath)).resolves.toBe(false);
    git(worktreePath, ["restore", "tracked.txt"]);
    fs.writeFileSync(path.join(worktreePath, "commit.txt"), "new\n");
    git(worktreePath, ["add", "commit.txt"]);
    git(worktreePath, ["commit", "-m", "worktree-only commit"]);
    await expect(gitWorktreeIsClean(worktreePath)).resolves.toBe(false);
  });

  test("remove は clean worktree と worktree- branch を削除して prune する", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);

    await expect(gitWorktreeRemove(worktreePath, false)).resolves.toEqual({ ok: true, error: null });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(`worktree ${worktreePath}\n`);
    const admin = path.join(root, ".git", "worktrees");
    expect(fs.existsSync(admin) ? fs.readdirSync(admin) : []).toEqual([]);
  });

  test("remove force は dirty worktree と worktree- branch を強制削除する", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.appendFileSync(path.join(worktreePath, "tracked.txt"), "dirty\n");

    await expect(gitWorktreeRemove(worktreePath, true)).resolves.toEqual({ ok: true, error: null });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(`worktree ${worktreePath}\n`);
  });

  test("remove 非 force は未 merge branch の削除失敗を返しつつ prune まで続ける", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.writeFileSync(path.join(worktreePath, "commit.txt"), "new\n");
    git(worktreePath, ["add", "commit.txt"]);
    git(worktreePath, ["commit", "-m", "unmerged worktree commit"]);

    const removed = await gitWorktreeRemove(worktreePath, false);
    expect(removed).toMatchObject({ ok: false, error: expect.any(String) });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch])).toContain(created.branch);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(`worktree ${worktreePath}\n`);
  });

  test("remove は後方互換の tailii/ branch も削除する", async () => {
    const root = makeRepository();
    const worktreePath = path.join(root, ".claude", "worktrees", "legacy-tailii-branch");
    git(root, ["worktree", "add", worktreePath, "-b", "tailii/legacy", "main"]);
    const realWorktreePath = fs.realpathSync(worktreePath);

    await expect(gitWorktreeRemove(realWorktreePath, false)).resolves.toEqual({ ok: true, error: null });
    expect(git(root, ["branch", "--list", "tailii/legacy"])).not.toContain("tailii/legacy");
  });

  test("remove は無関係な branch を削除しない", async () => {
    const root = makeRepository();
    const worktreePath = path.join(root, ".claude", "worktrees", "manual-safe-branch");
    git(root, ["worktree", "add", worktreePath, "-b", "feature/x", "main"]);
    const realWorktreePath = fs.realpathSync(worktreePath);

    await expect(gitWorktreeRemove(realWorktreePath, false)).resolves.toEqual({ ok: true, error: null });
    expect(git(root, ["branch", "--list", "feature/x"])).toContain("feature/x");
  });

  test("isTailiiWorktreePath は marker を含むパスだけを判定する", () => {
    expect(isTailiiWorktreePath("/repo/.claude/worktrees/20260713-120000")).toBe(true);
    expect(isTailiiWorktreePath("/repo/.claude/worktrees")).toBe(false);
    expect(isTailiiWorktreePath("/repo/worktrees/example")).toBe(false);
  });

  test("tailiiWorktreeRepoRoot は marker の手前を repo ルートとして返す", () => {
    expect(tailiiWorktreeRepoRoot("/Users/a/repo/.claude/worktrees/20260713-120000")).toBe(
      "/Users/a/repo",
    );
    expect(tailiiWorktreeRepoRoot("/repo/.claude/worktrees/x/nested/dir")).toBe("/repo");
    expect(tailiiWorktreeRepoRoot("/repo/.claude/worktrees")).toBeNull();
    expect(tailiiWorktreeRepoRoot("/repo/src")).toBeNull();
    expect(tailiiWorktreeRepoRoot("/.claude/worktrees/x")).toBeNull();
  });
});

describe("gitService worktree 堅牢化（worktree-hardening）", () => {
  test("parseWorktreeList は本体・ブランチ・detached・ロック理由を読む", () => {
    const parsed = parseWorktreeList([
      "worktree /repo", "HEAD aaa", "branch refs/heads/main", "",
      "worktree /repo/.claude/worktrees/a", "HEAD bbb", "branch refs/heads/worktree-a", "locked tailii-session", "",
      "worktree /repo/.claude/worktrees/b", "HEAD ccc", "detached", "locked", "",
    ].join("\n"));
    expect(parsed).toEqual([
      { path: "/repo", head: "aaa", branch: "main", bare: false, lockReason: null },
      { path: "/repo/.claude/worktrees/a", head: "bbb", branch: "worktree-a", bare: false, lockReason: "tailii-session" },
      { path: "/repo/.claude/worktrees/b", head: "ccc", branch: null, bare: false, lockReason: "" },
    ]);
  });

  test("除外設定の追記に失敗したら worktree とブランチを巻き戻して ok:false（項目4）", async () => {
    const root = makeRepository();
    // info を通常ファイルにして info/exclude を書けなくする。
    fs.rmSync(path.join(root, ".git", "info"), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, ".git", "info"), "not a directory\n");
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(false);
    expect(created.branch).toMatch(/^worktree-/);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(created.worktreePath);
  });

  test("旧版の作成者が同じ名前で作り終えていたら、相手の worktree とブランチに触れない（7周目1）", async () => {
    const root = makeRepository();
    const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const binDir = makeTempDir("git-worktree-fake-bin");
    const marker = path.join(binDir, "competed");
    // `worktree add <path> -b <branch> <base>` の直前に、フォルダを確保しない作成者が同じパス・
    // 同じブランチ名で作り終える（引数: -C <repo> worktree add <path> -b <branch> <base>）。
    fs.writeFileSync(path.join(binDir, "git"), [
      "#!/bin/sh",
      `if [ "$3" = worktree ] && [ "$4" = add ] && [ ! -e '${marker}' ]; then`,
      `  touch '${marker}'`,
      `  '${realGit}' -C "$2" worktree add "$5" -b "$7" "$8" >/dev/null 2>&1`,
      "fi",
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("PATH", `${binDir}:${process.env["PATH"] ?? ""}`);
    try {
      const created = await gitWorktreeCreate(root, "main");
      expect(created.ok).toBe(false);
      expect(fs.existsSync(marker)).toBe(true);
      const entries = parseWorktreeList(git(root, ["worktree", "list", "--porcelain"]));
      expect(entries).toHaveLength(2);
      const competitor = entries[1]!;
      expect(competitor.branch).toMatch(/^worktree-/);
      expect(fs.existsSync(path.join(competitor.path, "tracked.txt"))).toBe(true);
      expect(git(root, ["branch", "--list", competitor.branch!])).toContain(competitor.branch!);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("checkout 後のフックの中の git が別名で断っても、衝突と取り違えず巻き戻す（8周目）", async () => {
    const root = makeRepository();
    const hook = path.join(root, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\ngit branch main\nexit 1\n", { mode: 0o755 });
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(false);
    expect(git(root, ["branch", "--list", "worktree-*"]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")))
      .toHaveLength(1);
  });

  test("checkout 後のフックが File exists 等を出して失敗しても、衝突と取り違えず 1 組だけ巻き戻す（6周目1）", async () => {
    const root = makeRepository();
    const hook = path.join(root, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho 'mkdir: /x/cache: File exists' >&2\necho 'fatal: something already exists' >&2\nexit 1\n", { mode: 0o755 });
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(false);
    expect(git(root, ["branch", "--list", "worktree-*"]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")))
      .toHaveLength(1);
    const container = path.join(root, ".claude", "worktrees");
    expect(fs.existsSync(container) ? fs.readdirSync(container) : []).toEqual([]);
  });

  test("worktree add 自体が途中で失敗したら作りかけを巻き戻す（項目4・12）", async () => {
    const root = makeRepository();
    // checkout 後のフックが失敗すると add は失敗を返すが、作りかけの worktree とブランチが残る。
    const hook = path.join(root, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(false);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", "worktree-*"]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")))
      .toHaveLength(1);
  });

  test("push 済みのコミットは変更なし扱いで、非 force 削除でブランチも消える（項目6）", async () => {
    const root = makeRepository();
    const remote = fs.realpathSync(makeTempDir("git-worktree-remote"));
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "origin", "main"]);
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.writeFileSync(path.join(worktreePath, "pushed.txt"), "pushed\n");
    git(worktreePath, ["add", "pushed.txt"]);
    git(worktreePath, ["commit", "-m", "pushed commit"]);
    await expect(gitWorktreeChangeSummary(worktreePath)).resolves.toEqual({ uncommitted: 0, unmergedCommits: 1 });
    expect(await gitWorktreeIsClean(worktreePath)).toBe(false);

    git(worktreePath, ["push", "-q", "origin", `HEAD:refs/heads/${created.branch}`]);
    await expect(gitWorktreeChangeSummary(worktreePath)).resolves.toEqual({ uncommitted: 0, unmergedCommits: 0 });
    expect(await gitWorktreeIsClean(worktreePath)).toBe(true);
    await expect(gitWorktreeRemove(worktreePath, false)).resolves.toEqual({ ok: true, error: null });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch]).trim()).toBe("");
  });

  test("変更件数は未保存ファイル数と未マージのコミット数を数える（項目7）", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.writeFileSync(path.join(worktreePath, "c1.txt"), "1\n");
    git(worktreePath, ["add", "c1.txt"]);
    git(worktreePath, ["commit", "-m", "c1"]);
    fs.writeFileSync(path.join(worktreePath, "c2.txt"), "2\n");
    git(worktreePath, ["add", "c2.txt"]);
    git(worktreePath, ["commit", "-m", "c2"]);
    fs.appendFileSync(path.join(worktreePath, "tracked.txt"), "dirty\n");
    fs.mkdirSync(path.join(worktreePath, "newdir"));
    fs.writeFileSync(path.join(worktreePath, "newdir", "a.txt"), "a\n");
    fs.writeFileSync(path.join(worktreePath, "newdir", "b.txt"), "b\n");
    await expect(gitWorktreeChangeSummary(worktreePath)).resolves.toEqual({ uncommitted: 3, unmergedCommits: 2 });
  });

  test("削除は .claude/worktrees 配下の登録済み worktree 以外を拒否する（項目8）", async () => {
    const root = makeRepository();
    const manual = path.join(fs.realpathSync(makeTempDir("git-worktree-manual")), "manual");
    git(root, ["worktree", "add", manual, "-b", "manual-branch", "main"]);
    fs.appendFileSync(path.join(manual, "tracked.txt"), "unsaved\n");
    const rejected = await gitWorktreeRemove(manual, true);
    expect(rejected.ok).toBe(false);
    expect(fs.readFileSync(path.join(manual, "tracked.txt"), "utf8")).toContain("unsaved");

    await expect(gitWorktreeRemove(root, true)).resolves.toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(root, "tracked.txt"))).toBe(true);

    const created = await gitWorktreeCreate(root, "main");
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.mkdirSync(path.join(worktreePath, "sub"));
    await expect(gitWorktreeRemove(path.join(worktreePath, "sub"), true)).resolves.toMatchObject({ ok: false });
    expect(fs.existsSync(worktreePath)).toBe(true);

    // 未登録の（ただのディレクトリの）.claude/worktrees 配下も拒否する。
    const stray = path.join(root, ".claude", "worktrees", "stray");
    fs.mkdirSync(stray, { recursive: true });
    await expect(gitWorktreeRemove(stray, true)).resolves.toMatchObject({ ok: false });
    expect(fs.existsSync(stray)).toBe(true);
  });

  test("起点ブランチ名の - 始まりを拒否し、何も作らない（項目9）", async () => {
    const root = makeRepository();
    for (const base of ["--detach", "-b", "-", ""]) {
      const created = await gitWorktreeCreate(root, base);
      expect(created).toMatchObject({ ok: false, branch: "", worktreePath: "" });
    }
    expect(git(root, ["branch", "--list", "worktree-*"]).trim()).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")))
      .toHaveLength(1);
    // 実在するコミットを指す名前（ブランチ・タグ・コミット）は通す。
    git(root, ["tag", "v1"]);
    await expect(gitWorktreeCreate(root, "v1")).resolves.toMatchObject({ ok: true });
  });

  test("同じ秒の並行作成は両方成功し、別のブランチになる（項目10）", async () => {
    const root = makeRepository();
    const results = await Promise.all([
      gitWorktreeCreate(root, "main"), gitWorktreeCreate(root, "main"), gitWorktreeCreate(root, "main"),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    expect(new Set(results.map((result) => result.branch)).size).toBe(3);
    expect(new Set(results.map((result) => result.worktreePath)).size).toBe(3);
  });

  test("worktree の中から作っても本体ルート基準で作る（項目11）", async () => {
    const root = makeRepository();
    const first = await gitWorktreeCreate(root, "main");
    const firstPath = fs.realpathSync(first.worktreePath);
    fs.mkdirSync(path.join(firstPath, "src"));
    const nested = await gitWorktreeCreate(path.join(firstPath, "src"), "main");
    expect(nested.ok).toBe(true);
    expect(path.dirname(nested.worktreePath)).toBe(path.join(root, ".claude", "worktrees"));
    expect(fs.existsSync(path.join(firstPath, ".claude", "worktrees"))).toBe(false);
  });

  test("worktree add の失敗の分類: 今回のブランチ名・パスを名指しした fatal 行だけを衝突とみなす（5周目3・8周目）", () => {
    const branch = "worktree-20261111-120000";
    const wt = "/r/.claude/worktrees/20261111-120000";
    const classify = (stderr: string): string => classifyWorktreeAddFailure(stderr, branch, wt);
    expect(classify(`Preparing worktree (new branch '${branch}')\nfatal: a branch named '${branch}' already exists`))
      .toBe("branch-collision");
    expect(classify(`fatal: cannot lock ref 'refs/heads/${branch}': File exists.`)).toBe("branch-collision");
    expect(classify(`fatal: '${wt}' already exists`)).toBe("name-collision");
    // 古い git の文言（大文字始まり・末尾ピリオド）も同じに扱う。名前の大小違いは別物。
    expect(classify(`fatal: A branch named '${branch}' already exists.`)).toBe("branch-collision");
    expect(classify(`fatal: a branch named '${branch.toUpperCase()}' already exists`)).toBe("failure");
    expect(classify("error: hook 'post-checkout' failed")).toBe("failure");
    expect(classify("")).toBe("failure");
    // フックの出力に混ざった文言・別名を名指しした fatal 行は衝突ではない（6周目1・8周目）。
    expect(classify("mkdir: /x/cache: File exists\nln: link already exists")).toBe("failure");
    expect(classify("fatal: a branch named 'main' already exists")).toBe("failure");
    expect(classify("fatal: cannot lock ref 'refs/heads/foo': File exists.")).toBe("failure");
    expect(classify("fatal: '/x/y' already exists")).toBe("failure");
  });

  test("detached の非 force 削除は、どこにも無いコミットがあれば消さない（5周目1）", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    const worktreePath = fs.realpathSync(created.worktreePath);
    git(worktreePath, ["checkout", "-q", "--detach"]);
    fs.writeFileSync(path.join(worktreePath, "d.txt"), "d\n");
    git(worktreePath, ["add", "d.txt"]);
    git(worktreePath, ["commit", "-m", "detached only"]);
    const removed = await gitWorktreeRemove(worktreePath, false);
    expect(removed.ok).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, "d.txt"))).toBe(true);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain("locked tailii-session");
    // 二段階確認を経た force は利用者の明示なので消す。
    await expect(gitWorktreeRemove(worktreePath, true)).resolves.toMatchObject({ ok: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  test("管理対象の解決と一覧は .claude/worktrees 配下だけを返す", async () => {
    const root = makeRepository();
    const created = await gitWorktreeCreate(root, "main");
    const worktreePath = fs.realpathSync(created.worktreePath);
    const manual = path.join(fs.realpathSync(makeTempDir("git-worktree-manual-list")), "m");
    git(root, ["worktree", "add", manual, "-b", "manual-list", "main"]);
    const listed = await gitManagedWorktrees(worktreePath);
    expect(listed?.mainRoot).toBe(root);
    expect(listed?.worktrees.map((entry) => fs.realpathSync(entry.path))).toEqual([worktreePath]);
    expect(listed?.worktrees[0]).toMatchObject({ branch: created.branch, lockReason: "tailii-session" });
    fs.mkdirSync(path.join(worktreePath, "deep"));
    expect((await resolveManagedWorktreeForCwd(path.join(worktreePath, "deep")))?.mainRoot).toBe(root);
    expect(await resolveManagedWorktree(path.join(worktreePath, "deep"))).toBeNull();
    expect(await resolveManagedWorktree(manual)).toBeNull();
  });
});
