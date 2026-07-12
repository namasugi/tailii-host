// gitService.test.ts — 実 git リポジトリを使う Git サービス検証

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  gitCommit, gitDiff, gitLog, gitStage, gitStatus, parsePorcelainV2,
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
    ].join("\n"));
    expect(parsed).toEqual({
      branch: "main", upstream: "origin/main", ahead: 2, behind: 3,
      files: [
        { path: "src/a.ts", indexStatus: "M", worktreeStatus: ".", renamedFrom: null },
        { path: "path with spaces.txt", indexStatus: ".", worktreeStatus: "M", renamedFrom: null },
        { path: "new.ts", indexStatus: "R", worktreeStatus: ".", renamedFrom: "old.ts" },
        { path: "new.txt", indexStatus: "?", worktreeStatus: "?", renamedFrom: null },
      ],
    });
  });
});

describe("gitService", () => {
  test("status/diff/stage/unstage/commit/log を一連で処理する", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(root, "new.txt"), "new\n");

    const status = await gitStatus(root);
    expect(status).toMatchObject({ isRepo: true, branch: "main", ahead: 0, behind: 0 });
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", indexStatus: ".", worktreeStatus: "M" }),
      expect.objectContaining({ path: "new.txt", indexStatus: "?", worktreeStatus: "?" }),
    ]));
    await expect(gitDiff(root, { file: "tracked.txt" })).resolves.toMatchObject({
      isRepo: true, diff: expect.stringContaining("+two"), truncated: false,
    });

    await expect(gitStage(root, ["tracked.txt", "new.txt"])).resolves.toEqual({ ok: true, error: null });
    await expect(gitDiff(root, { staged: true })).resolves.toMatchObject({ diff: expect.stringContaining("new.txt") });
    await expect(gitStage(root, ["new.txt"], true)).resolves.toEqual({ ok: true, error: null });
    await expect(gitStage(root, ["new.txt"])).resolves.toEqual({ ok: true, error: null });

    const committed = await gitCommit(root, "second commit");
    expect(committed).toMatchObject({ ok: true, hash: expect.stringMatching(/^[0-9a-f]+$/), error: null });
    const log = await gitLog(root, 1);
    expect(log.isRepo).toBe(true);
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]).toMatchObject({ subject: "second commit", authorName: "Tailii Test" });
    await expect(gitDiff(root, { commit: committed.hash })).resolves.toMatchObject({
      isRepo: true, diff: expect.stringContaining("second commit"),
    });
  });

  test("非リポジトリは正常な isRepo:false / ok:false 応答にする", async () => {
    const root = fs.mkdtempSync("/private/tmp/tailii-git-not-repo-");
    await expect(gitStatus(root)).resolves.toMatchObject({ isRepo: false, files: [] });
    await expect(gitDiff(root)).resolves.toEqual({ isRepo: false, diff: "", truncated: false });
    await expect(gitLog(root)).resolves.toEqual({ isRepo: false, commits: [] });
    await expect(gitStage(root, ["a"])).resolves.toMatchObject({ ok: false });
    await expect(gitCommit(root, "message")).resolves.toMatchObject({ ok: false, hash: null });
  });

  test("diff を200000文字で切り詰める", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, "tracked.txt"), `one\n${"x".repeat(210_000)}\n`);
    const result = await gitDiff(root);
    expect(result.diff).toHaveLength(200_000);
    expect(result.truncated).toBe(true);
  });
});
