// agentPriority.test.ts — OS / taskpolicy / env の判定は差し替え、実 taskpolicy は起動しない。
import * as fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  agentClampArgv, agentClampShellPrefix, resetAgentClampProbe, TASKPOLICY_PATH, withAgentClamp, withAgentClampShellCommand,
} from "../src/shared/agentPriority.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, accessSync: vi.fn() };
});

const CLAMP = [TASKPOLICY_PATH, "-c", "utility"];
afterEach(() => {
  resetAgentClampProbe();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("agentClampArgv", () => {
  test("darwin で実行可能な taskpolicy があれば utility に固定する", () => {
    const probe = vi.fn(() => true);
    expect(agentClampArgv({ platform: "darwin", env: {}, isExecutable: probe })).toEqual(CLAMP);
    expect(probe).toHaveBeenCalledWith(TASKPOLICY_PATH);
  });

  test("macOS 以外・off では存在確認もしない", () => {
    const probe = vi.fn(() => true);
    expect(agentClampArgv({ platform: "linux", env: {}, isExecutable: probe })).toEqual([]);
    expect(agentClampArgv({ platform: "win32", env: {}, isExecutable: probe })).toEqual([]);
    expect(agentClampArgv({ platform: "darwin", env: { TAILII_AGENT_CLAMP: "off" }, isExecutable: probe })).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  test("taskpolicy 不在・実行不可は固定しない。注入した判定はキャッシュしない", () => {
    const probe = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(agentClampArgv({ platform: "darwin", env: {}, isExecutable: probe })).toEqual([]);
    expect(agentClampArgv({ platform: "darwin", env: {}, isExecutable: probe })).toEqual(CLAMP);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])("実物の実行可否 %s はプロセス内で一度だけ調べ、env は起動ごとに読む", (executable) => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      if (!executable) throw new Error("EACCES");
    });
    const expected = executable ? CLAMP : [];
    expect(agentClampArgv({ platform: "darwin", env: {} })).toEqual(expected);
    expect(agentClampArgv({ platform: "darwin", env: {} })).toEqual(expected);
    vi.stubEnv("TAILII_AGENT_CLAMP", "off");
    expect(agentClampArgv({ platform: "darwin" })).toEqual([]);
    vi.stubEnv("TAILII_AGENT_CLAMP", "on");
    expect(agentClampArgv({ platform: "darwin" })).toEqual(expected);
    expect(fs.accessSync).toHaveBeenCalledExactlyOnceWith(TASKPOLICY_PATH, fs.constants.X_OK);
  });

  test("off 以外の値は無効化しない", () => {
    for (const value of ["on", "0", "OFF", " off "]) {
      expect(agentClampArgv({ platform: "darwin", env: { TAILII_AGENT_CLAMP: value }, isExecutable: () => true })).toEqual(CLAMP);
    }
  });
});

describe("接頭辞の組み立て", () => {
  test.each([
    ["FOO=bar claude", "FOO=bar /usr/sbin/taskpolicy -c utility claude"],
    ["FOO=bar EMPTY= OTHER=a=b claude --continue", "FOO=bar EMPTY= OTHER=a=b /usr/sbin/taskpolicy -c utility claude --continue"],
    ["  FOO=bar\tclaude", "  FOO=bar\t/usr/sbin/taskpolicy -c utility claude"],
    ["FOO=bar exec claude --continue", "FOO=bar exec /usr/sbin/taskpolicy -c utility claude --continue"],
    ["exec claude", "exec /usr/sbin/taskpolicy -c utility claude"],
  ])("先頭の代入を接頭辞より前に保持する: %s", (command, expected) => {
    expect(withAgentClampShellCommand(command, CLAMP)).toBe(expected);
    expect(withAgentClampShellCommand(command, [])).toBe(command);
  });

  test.each(["FOO='bar baz' claude", 'FOO="bar" claude', "FOO=bar BAZ='x y' claude", "FOO=$(echo bar) claude", "FOO=bar\\ baz claude", "FOO=bar; claude", "FOO=bar"])(
    "安全に切り分けられない代入には接頭辞を付けない: %s", (command) => {
      expect(withAgentClampShellCommand(command, CLAMP)).toBe(command);
    },
  );
  test.each(["FOO=bar command claude", "FOO=bar exec -a custom claude", "exec", "exec exec claude",
    "FOO=bar :", "echo ok", "printf ok", "if true; then claude; fi", "{ claude; }", "(claude)",
    "worker () { claude; }", "claude && echo ok", "claude | cat", '"$CLI" --continue'])(
    "組み込み・予約語・複合構文などを実行ファイルとして渡さない: %s", (command) => {
      expect(withAgentClampShellCommand(command, CLAMP)).toBe(command);
    },
  );
  test("spawn の executable / args へ付与し、空なら同じコマンドになる", () => {
    const args = ["app-server", "--listen", "unix://"];
    expect(withAgentClamp("/my codex", args, CLAMP)).toEqual({
      executable: TASKPOLICY_PATH, args: ["-c", "utility", "/my codex", ...args],
    });
    expect(withAgentClamp("/my codex", args, [])).toEqual({ executable: "/my codex", args });
    expect(args).toEqual(["app-server", "--listen", "unix://"]);
  });

  test("シェル用は末尾空白を含み、空なら空文字になる", () => {
    expect(agentClampShellPrefix(CLAMP)).toBe("/usr/sbin/taskpolicy -c utility ");
    expect(agentClampShellPrefix([])).toBe("");
  });
});
