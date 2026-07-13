// engineGitFileBrowser.test.ts — file/git 9 コマンドの Engine dispatch 統合検証

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { gitWorktreeCreate } from "../src/gitService.js";
import { decodeControlMessage } from "../src/protocol.js";
import { SessionMetadataStore } from "../src/sessionMetadataStore.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { MockTmuxRunner, makeTempDir, startEngine } from "./helpers.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

describe("EngineControl — file/git browser", () => {
  test("11の要求を対応する wire 応答へ dispatch する", async () => {
    // macOS の /tmp は /private への symlink で、repoRoot は実パスで返るため揃える。
    const root = fs.realpathSync(makeTempDir("engine-git-file"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Engine Test"]);
    git(root, ["config", "user.email", "engine@example.invalid"]);
    fs.writeFileSync(path.join(root, "a.txt"), "one\n");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");

    const manager = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner });
    const engine = startEngine({ sessionManager: manager });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(JSON.stringify({ type: "file_list_request", v: 1, id: "fl", path: root }));
    expect(decodeControlMessage(await engine.lines.nextOfType("file_list_response"))).toMatchObject({
      type: "file_list_response", id: "fl", path: root, truncated: false,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: "a.txt", kind: "file", gitStatus: "M" }),
      ]),
    });

    engine.writeLine(JSON.stringify({ type: "file_read_request", v: 1, id: "fr", path: path.join(root, "a.txt") }));
    expect(decodeControlMessage(await engine.lines.nextOfType("file_read_response"))).toMatchObject({
      type: "file_read_response", id: "fr", kind: "text", content: "one\ntwo\n",
    });

    engine.writeLine(JSON.stringify({ type: "git_status_request", v: 1, id: "gs", path: root }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_status_response"))).toMatchObject({
      type: "git_status_response", id: "gs", isRepo: true, branch: "main",
      repoRoot: root, diffAdditions: 1, diffDeletions: 0,
    });

    engine.writeLine(JSON.stringify({ type: "git_diff_request", v: 1, id: "gd", path: root, file: "a.txt", staged: false, commit: null }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_diff_response"))).toMatchObject({
      type: "git_diff_response", id: "gd", isRepo: true, diff: expect.stringContaining("+two"),
    });

    engine.writeLine(JSON.stringify({ type: "git_log_request", v: 1, id: "gl", path: root, limit: 10 }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_log_response"))).toMatchObject({
      type: "git_log_response", id: "gl", isRepo: true,
      commits: [expect.objectContaining({ subject: "initial" })],
    });

    engine.writeLine(JSON.stringify({ type: "git_branch_list_request", v: 1, id: "gb", path: root }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_branch_list_response"))).toMatchObject({
      type: "git_branch_list_response", id: "gb", isRepo: true,
      branches: [expect.objectContaining({ name: "main", isCurrent: true, ahead: 0, behind: 0 })],
    });

    engine.writeLine(JSON.stringify({
      type: "git_checkout_request", v: 1, id: "gk", path: root,
      branch: "engine-branch", create: true,
    }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_checkout_response"))).toEqual({
      type: "git_checkout_response", v: 2, id: "gk",
      ok: true, branch: "engine-branch", error: null,
    });

    engine.writeLine(JSON.stringify({ type: "git_discard_request", v: 1, id: "gx", path: root, files: ["a.txt"] }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_discard_response"))).toEqual({
      type: "git_discard_response", v: 2, id: "gx", ok: true, error: null,
    });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");

    const initialized = makeTempDir("engine-git-init");
    engine.writeLine(JSON.stringify({ type: "git_init_request", v: 1, id: "gi", path: initialized }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_init_response"))).toEqual({
      type: "git_init_response", v: 2, id: "gi", ok: true, error: null,
    });

    engine.writeLine(JSON.stringify({
      type: "git_worktree_create_request", v: 1, id: "gw1", path: root, baseBranch: "main",
    }));
    const createResponse = decodeControlMessage(await engine.lines.nextOfType("git_worktree_create_response"));
    expect(createResponse).toMatchObject({
      type: "git_worktree_create_response", v: 2, id: "gw1", ok: true,
      branch: expect.stringMatching(/^worktree-\d{8}-\d{6}$/), error: null,
    });
    if (createResponse.type !== "git_worktree_create_response") throw new Error("worktree create 応答型不一致");
    const worktreePath = fs.realpathSync(createResponse.worktreePath);

    engine.writeLine(JSON.stringify({
      type: "git_worktree_remove_request", v: 1, id: "gw2", path: worktreePath, force: false,
    }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_worktree_remove_response"))).toEqual({
      type: "git_worktree_remove_response", v: 2, id: "gw2", ok: true, error: null,
    });
    expect(fs.existsSync(worktreePath)).toBe(false);

    await engine.teardown();
  });

  test("session_kill は clean な Tailii worktree を自動削除する", async () => {
    const root = fs.realpathSync(makeTempDir("engine-kill-clean-worktree"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Engine Test"]);
    git(root, ["config", "user.email", "engine@example.invalid"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);

    const store = new SessionMetadataStore(makeTempDir("engine-kill-clean-store"));
    store.put({ name: "clean-worktree", cwd: worktreePath, createdAt: 1 });
    const runner = new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const manager = new TmuxSessionManager({ runner: runner.runner, store });
    const engine = startEngine({ sessionManager: manager, metadataStore: store });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(JSON.stringify({ type: "session_kill", v: 1, id: "wk-clean", name: "clean-worktree" }));
    const cleanResponse = decodeControlMessage(await engine.lines.nextOfType("session_list_response"));
    expect(cleanResponse).toMatchObject({
      type: "session_list_response", id: "wk-clean", worktreePath,
      worktreeRemoved: true,
    });
    expect(cleanResponse).not.toHaveProperty("worktreeDirty");
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch])).not.toContain(created.branch);

    await engine.teardown();
  });

  test("session_kill は dirty な Tailii worktree を unlock して保持する", async () => {
    const root = fs.realpathSync(makeTempDir("engine-kill-dirty-worktree"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Engine Test"]);
    git(root, ["config", "user.email", "engine@example.invalid"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);
    const created = await gitWorktreeCreate(root, "main");
    expect(created.ok).toBe(true);
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.appendFileSync(path.join(worktreePath, "tracked.txt"), "dirty\n");

    const store = new SessionMetadataStore(makeTempDir("engine-kill-dirty-store"));
    store.put({ name: "dirty-worktree", cwd: worktreePath, createdAt: 1 });
    const runner = new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const manager = new TmuxSessionManager({ runner: runner.runner, store });
    const engine = startEngine({ sessionManager: manager, metadataStore: store });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(JSON.stringify({ type: "session_kill", v: 1, id: "wk-dirty", name: "dirty-worktree" }));
    const dirtyResponse = decodeControlMessage(await engine.lines.nextOfType("session_list_response"));
    expect(dirtyResponse).toMatchObject({
      type: "session_list_response", id: "wk-dirty", worktreePath,
      worktreeDirty: true,
    });
    expect(dirtyResponse).not.toHaveProperty("worktreeRemoved");
    expect(fs.existsSync(worktreePath)).toBe(true);
    const worktreeList = execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const entry = worktreeList.split("\n\n").find((record) => record.includes(`worktree ${worktreePath}\n`));
    expect(entry).not.toContain("locked");
    expect(git(root, ["branch", "--list", created.branch])).toContain(created.branch);

    await engine.teardown();
  });
});
