// engineGitFileBrowser.test.ts — file/git 7 コマンドの Engine dispatch 統合検証

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { decodeControlMessage } from "../src/protocol.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { MockTmuxRunner, makeTempDir, startEngine } from "./helpers.js";

function git(root: string, args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}

describe("EngineControl — file/git browser", () => {
  test("7つの要求を対応する wire 応答へ dispatch する", async () => {
    const root = makeTempDir("engine-git-file");
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
    });

    engine.writeLine(JSON.stringify({ type: "file_read_request", v: 1, id: "fr", path: path.join(root, "a.txt") }));
    expect(decodeControlMessage(await engine.lines.nextOfType("file_read_response"))).toMatchObject({
      type: "file_read_response", id: "fr", kind: "text", content: "one\ntwo\n",
    });

    engine.writeLine(JSON.stringify({ type: "git_status_request", v: 1, id: "gs", path: root }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_status_response"))).toMatchObject({
      type: "git_status_response", id: "gs", isRepo: true, branch: "main",
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

    engine.writeLine(JSON.stringify({ type: "git_stage_request", v: 1, id: "ga", path: root, files: ["a.txt"], unstage: false }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_stage_response"))).toEqual({
      type: "git_stage_response", v: 2, id: "ga", ok: true, error: null,
    });

    engine.writeLine(JSON.stringify({ type: "git_commit_request", v: 1, id: "gc", path: root, message: "engine commit" }));
    expect(decodeControlMessage(await engine.lines.nextOfType("git_commit_response"))).toMatchObject({
      type: "git_commit_response", id: "gc", ok: true,
      hash: expect.stringMatching(/^[0-9a-f]+$/), error: null,
    });

    await engine.teardown();
  });
});
