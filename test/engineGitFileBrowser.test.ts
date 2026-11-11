// engineGitFileBrowser.test.ts — file/git 9 コマンドの Engine dispatch 統合検証

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { EngineLauncher } from "../src/commands/launch.js";
import { gitWorktreeCreate } from "../src/services/gitService.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { decodeControlMessage } from "../src/protocol.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
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

    engine.writeLine(JSON.stringify({ type: "file_search_request", v: 1, id: "fs", path: root, query: "a.t" }));
    expect(decodeControlMessage(await engine.lines.nextOfType("file_search_response"))).toMatchObject({
      type: "file_search_response", id: "fs", path: root, query: "a.t", truncated: false,
      entries: [expect.objectContaining({ name: "a.txt", kind: "file", size: 8 })],
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
      worktreeDirty: true, worktreeUncommittedCount: 1, worktreeUnmergedCommitCount: 0,
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

function makeEngineRepository(label: string): string {
  const root = fs.realpathSync(makeTempDir(label));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Engine Test"]);
  git(root, ["config", "user.email", "engine@example.invalid"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("EngineControl — worktree の片付け（worktree-janitor）", () => {
  test("git_worktree_list_request は一覧を git_worktree_list_response で返す", async () => {
    vi.stubEnv("TAILII_CLAUDE_SESSIONS_DIR", makeTempDir("engine-wt-list-registry"));
    const root = makeEngineRepository("engine-wt-list");
    const created = await gitWorktreeCreate(root, "main");
    const worktreePath = fs.realpathSync(created.worktreePath);
    fs.writeFileSync(path.join(worktreePath, "new.txt"), "x\n");
    const manager = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner });
    const engine = startEngine({
      sessionManager: manager, claudeSessionStore: new ClaudeSessionStore(makeTempDir("engine-wt-list-projects")),
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(JSON.stringify({ type: "git_worktree_list_request", v: 1, id: "wl", path: root }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_worktree_list_response"))).toEqual({
      type: "git_worktree_list_response", v: 2, id: "wl", isRepo: true,
      worktrees: [{
        path: worktreePath, branch: created.branch, hasChanges: true, inUse: false,
        uncommittedCount: 1, unmergedCommitCount: 0,
      }],
    });
    engine.writeLine(JSON.stringify({ type: "git_worktree_list_request", v: 1, id: "wl2", path: makeTempDir("engine-wt-nonrepo") }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_worktree_list_response"))).toEqual({
      type: "git_worktree_list_response", v: 2, id: "wl2", isRepo: false, worktrees: [],
    });
    // 範囲外のパスの削除要求は拒否する。
    engine.writeLine(JSON.stringify({ type: "git_worktree_remove_request", v: 1, id: "wr", path: root, force: true }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_worktree_remove_response"))).toMatchObject({
      type: "git_worktree_remove_response", id: "wr", ok: false,
    });
    expect(fs.existsSync(path.join(root, "tracked.txt"))).toBe(true);
    await engine.teardown();
    vi.unstubAllEnvs();
  });

  test("session_start が失敗したら今作った worktree を巻き戻す（項目3）", async () => {
    vi.stubEnv("TAILII_CLAUDE_SESSIONS_DIR", makeTempDir("engine-wt-start-registry"));
    const root = makeEngineRepository("engine-wt-start");
    const created = await gitWorktreeCreate(root, "main");
    const worktreePath = fs.realpathSync(created.worktreePath);
    const launcher: EngineLauncher = async () => ({ exitCode: 1, errorText: "起動に失敗しました" });
    const manager = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner });
    const engine = startEngine({
      sessionManager: manager, launcher,
      claudeSessionStore: new ClaudeSessionStore(makeTempDir("engine-wt-start-projects")),
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(JSON.stringify({ type: "session_start", v: 1, id: "ss", name: "cs-wt-fail", cwd: worktreePath }));
    expect(await engine.lines.nextOfType("error")).toContain('"code":"launch_failed"');
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, ["branch", "--list", created.branch]).trim()).toBe("");
    await engine.teardown();
    vi.unstubAllEnvs();
  });

  test("conversation_delete は会話の worktree を片付け、変更ありは件数を応答に載せる（項目2）", async () => {
    vi.stubEnv("TAILII_CLAUDE_SESSIONS_DIR", makeTempDir("engine-wt-delete-registry"));
    const root = makeEngineRepository("engine-wt-delete");
    const projects = makeTempDir("engine-wt-delete-projects");
    const writeConversation = (cwd: string, id: string): void => {
      const dir = path.join(projects, claudeProjectSlug(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`),
        `${JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T00:00:00.000Z", message: { content: "hi" } })}\n`);
    };
    const clean = await gitWorktreeCreate(root, "main");
    const cleanPath = fs.realpathSync(clean.worktreePath);
    const cleanId = "11111111-2222-3333-4444-555555555555";
    writeConversation(cleanPath, cleanId);
    const dirty = await gitWorktreeCreate(root, "main");
    const dirtyPath = fs.realpathSync(dirty.worktreePath);
    const dirtyId = "66666666-7777-8888-9999-000000000000";
    writeConversation(dirtyPath, dirtyId);
    fs.writeFileSync(path.join(dirtyPath, "c.txt"), "c\n");
    git(dirtyPath, ["add", "c.txt"]);
    git(dirtyPath, ["commit", "-m", "unmerged"]);

    const manager = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner });
    const engine = startEngine({ sessionManager: manager, claudeSessionStore: new ClaudeSessionStore(projects) });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(JSON.stringify({ type: "conversation_delete", v: 1, id: "cd-clean", sessionId: cleanId, agent: "claude" }));
    expect(decodeControlMessage(await engine.lines.nextOfType("conversation_delete_result"))).toEqual({
      type: "conversation_delete_result", v: 2, id: "cd-clean", ok: true, error: null,
      worktreePath: cleanPath, worktreeRemoved: true,
    });
    expect(fs.existsSync(cleanPath)).toBe(false);

    engine.writeLine(JSON.stringify({ type: "conversation_delete", v: 1, id: "cd-dirty", sessionId: dirtyId, agent: "claude" }));
    expect(decodeControlMessage(await engine.lines.nextOfType("conversation_delete_result"))).toEqual({
      type: "conversation_delete_result", v: 2, id: "cd-dirty", ok: true, error: null,
      worktreePath: dirtyPath, worktreeDirty: true, worktreeUncommittedCount: 0, worktreeUnmergedCommitCount: 1,
    });
    expect(fs.existsSync(dirtyPath)).toBe(true);
    await engine.teardown();
    vi.unstubAllEnvs();
  });
});

describe("EngineControl — file_fetch (file-download)", () => {
  test("file_fetch_request を分割 file_fetch_response に、失敗は error チャンクにする", async () => {
    const root = fs.realpathSync(makeTempDir("engine-file-fetch"));
    const body = Buffer.from("hello file download over ndjson");
    fs.writeFileSync(path.join(root, "doc.pdf"), body);

    const manager = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner });
    const engine = startEngine({ sessionManager: manager });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(JSON.stringify({ type: "file_fetch_request", v: 1, id: "ff", path: path.join(root, "doc.pdf") }));
    const first = decodeControlMessage(await engine.lines.nextOfType("file_fetch_response"));
    expect(first).toMatchObject({
      type: "file_fetch_response", id: "ff", seq: 0, eof: true,
      mime: "application/pdf", name: "doc.pdf", size: body.length,
    });
    if (first.type !== "file_fetch_response") throw new Error("unreachable");
    expect(Buffer.from(first.data, "base64").equals(body)).toBe(true);

    engine.writeLine(JSON.stringify({ type: "file_fetch_request", v: 1, id: "ffx", path: path.join(root, "missing.pdf") }));
    expect(decodeControlMessage(await engine.lines.nextOfType("file_fetch_response"))).toMatchObject({
      type: "file_fetch_response", id: "ffx", seq: 0, eof: true, data: "",
      error: expect.stringContaining("ENOENT"),
    });

    // offset 付きはその位置から末尾までを配り、各チャンクに offset を付ける（size は原本全体）。
    engine.writeLine(JSON.stringify({ type: "file_fetch_request", v: 1, id: "ffr", path: path.join(root, "doc.pdf"), offset: 6 }));
    const ranged = decodeControlMessage(await engine.lines.nextOfType("file_fetch_response"));
    expect(ranged).toMatchObject({ type: "file_fetch_response", id: "ffr", seq: 0, eof: true, offset: 6, size: body.length });
    if (ranged.type !== "file_fetch_response") throw new Error("unreachable");
    expect(Buffer.from(ranged.data, "base64").equals(body.subarray(6))).toBe(true);

    // 中止は無害（未知 id も含めて例外にしない）。
    engine.writeLine(JSON.stringify({ type: "file_fetch_cancel", v: 1, id: "ff" }));
    await engine.teardown();
  });
});
