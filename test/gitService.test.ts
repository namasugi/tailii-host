// gitService.test.ts — 実 git リポジトリを使う Git サービス検証

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  gitBranchList,
  gitCheckout,
  gitDiff,
  gitDiscard,
  gitEntryStatuses,
  gitInit,
  gitLog,
  gitStatus,
  parsePorcelainV2,
} from "../src/gitService.js";
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
