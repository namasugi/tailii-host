// agentLaunchPriority.test.ts — 起動経路全体の組み立てを確認する。実 CLI / 端末サーバーは起動しない。
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  codexRemoteResumeCommand, herdrPaneRunCommand, makeSessionLauncher, runLaunchCommand,
  type ProcessRunner,
} from "../src/commands/launch.js";
import { defaultLaunch as launchCodexAppServerDetached } from "../src/codex/codexAppServer.js";
import { spawnApiAgentWorker } from "../src/apiAgent/workerProcess.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import type { AgentClampProbe } from "../src/shared/agentPriority.js";

const policy = vi.hoisted(() => ({ clamp: [] as string[] }));
vi.mock("../src/shared/agentPriority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shared/agentPriority.js")>();
  return {
    ...actual,
    agentClampArgv: () => [...policy.clamp],
    agentClampShellPrefix: (clamp: readonly string[] = policy.clamp) => actual.agentClampShellPrefix(clamp),
  };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(), spawn: vi.fn(),
}));
const { agentClampArgv, withAgentClampShellCommand } = await vi.importActual<typeof import("../src/shared/agentPriority.js")>(
  "../src/shared/agentPriority.js",
);
const CLAMP = ["/usr/sbin/taskpolicy", "-c", "utility"];
const PREFIX = CLAMP.join(" ") + " ";
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-priority-"));

beforeEach(() => {
  policy.clamp = [...CLAMP];
  vi.stubEnv("ANTHROPIC_DEFAULT_MODEL", "sonnet");
  vi.mocked(spawn).mockImplementation(() => { throw new Error("unexpected spawn"); });
  vi.mocked(execFile).mockImplementation(() => { throw new Error("unexpected execFile"); });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

/** 実環境を読まず、helper の判定結果を各起動経路へ渡す。 */
const modes: { name: string; probe: AgentClampProbe; enabled: boolean }[] = [
  { name: "macOS", probe: { platform: "darwin", env: {}, isExecutable: () => true }, enabled: true },
  { name: "Linux", probe: { platform: "linux", env: {}, isExecutable: () => true }, enabled: false },
  { name: "taskpolicy 不在", probe: { platform: "darwin", env: {}, isExecutable: () => false }, enabled: false },
  { name: "off", probe: { platform: "darwin", env: { TAILII_AGENT_CLAMP: "off" }, isExecutable: () => true }, enabled: false },
];

/** サーバーの存在・stale pane を再現し、制御コマンドと pane 起動を記録する。 */
function terminal(backend: "tmux" | "herdr", stale = false) {
  const calls: { exe: string; args: string[] }[] = [];
  let existing = stale;
  const runner: ProcessRunner = async (exe, args) => {
    calls.push({ exe, args });
    const a = backend === "herdr" ? args.slice(2) : args;
    let stdout = "";
    let exitCode = 0;
    if (backend === "tmux") {
      if (a[0] === "has-session") exitCode = existing ? 0 : 1;
      if (a[0] === "list-panes") stdout = "0\n";
      if (a.includes("#{pane_current_command}")) stdout = "zsh\n";
      if (a[0] === "kill-session") existing = false;
    } else {
      if (a[0] === "pane" && a[1] === "list") stdout = JSON.stringify({ result: {
        panes: existing ? [{ pane_id: "w1:p1", label: "s-priority" }] : [],
      } });
      if (a[1] === "process-info") stdout = JSON.stringify({ result: {
        process_info: { foreground_processes: [{ name: "zsh", pid: 100 }] },
      } });
      if (a[1] === "close") existing = false;
      if (a[0] === "tab" && a[1] === "create") stdout = JSON.stringify({ result: {
        root_pane: { pane_id: "w1:p2" },
      } });
    }
    return { exitCode, stdout };
  };
  const inner = (): string => {
    if (backend === "tmux") return calls.find((c) => c.args[0] === "new")!.args[4]!;
    const command = calls.find((c) => c.args[3] === "run")!.args[5]!;
    if (command.includes("/bin/zsh -l '")) {
      return fs.readFileSync(path.join(os.homedir(), ".tailii/run/herdr-launch-s-priority.zsh"), "utf8");
    }
    return command;
  };
  return { runner, calls, inner };
}

const titles = ["API (v2)", "UI & API", "日本語 '引用' \"二重引用\" & (確認)"];

test.each(["tmux", "herdr"] as const)("%s: host が追加するタイトルは新規・resume・continue の固定判定に混ぜない", async (backend) => {
  for (const title of titles) {
    for (const kind of ["new", "resume", "continue"]) {
      const t = terminal(backend);
      const launcher = makeSessionLauncher({ backend, runner: t.runner, store: new SessionMetadataStore(tempDir()),
        innerCommand: kind === "continue" ? "claude --continue" : undefined, agentClamp: CLAMP });
      expect((await launcher(tempDir(), "s-priority", null, kind === "resume" ? "session-id" : null,
        kind === "new" ? "11111111-2222-3333-4444-555555555555" : null, title)).exitCode).toBe(0);
      expect(t.inner()).toContain(`${PREFIX}claude`);
      if (kind === "new") expect(t.inner()).toContain(" --name ");
    }
    for (const resume of [null, "thread-existing"]) {
      const t = terminal(backend);
      const appServer = { remoteEndpoint: "unix:///tmp/fake.sock", startThread: async () => "thread-new", ensureRunning: async () => {} };
      const launcher = makeSessionLauncher({ agent: "codex", backend, runner: t.runner, codexAppServer: appServer,
        store: new SessionMetadataStore(tempDir()), agentClamp: CLAMP });
      expect((await launcher(tempDir(), "s-priority", null, resume, null, title)).exitCode).toBe(0);
      expect(t.inner()).toContain(`${PREFIX}codex resume --remote unix:///tmp/fake.sock --no-alt-screen ${resume ?? "thread-new"}`);
    }
  }
});

// 実 /bin/sh、偽 taskpolicy・偽 CLI を使うため sandbox 外で実行する。
test.each(["claude-new", "claude-resume", "claude-continue", "codex-new", "codex-resume"])("実シェル: %s は記号つきタイトルでも固定と引数を保つ", async (kind) => {
  for (const title of titles) {
    const dir = tempDir(), policyLog = path.join(dir, "policy.log"), policyPath = path.join(dir, "taskpolicy");
    fs.writeFileSync(policyPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$POLICY_LOG"\nshift 2\nexec "$@"\n', { mode: 0o700 });
    for (const cli of ["claude", "codex"]) fs.writeFileSync(path.join(dir, cli), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "find"), '#!/bin/sh\necho found\n', { mode: 0o700 });
    const agent = kind.startsWith("codex") ? "codex" : "claude";
    const t = terminal("tmux");
    const appServer = { remoteEndpoint: "unix:///tmp/fake.sock", startThread: async () => "thread-new", ensureRunning: async () => {} };
    const launcher = makeSessionLauncher({ agent, backend: "tmux", runner: t.runner, store: new SessionMetadataStore(tempDir()),
      innerCommand: kind === "claude-continue" ? "claude --continue" : undefined,
      codexAppServer: appServer, agentClamp: [policyPath, "-c", "utility"] });
    expect((await launcher(dir, "s-priority", null, kind.endsWith("resume") ? "session-id" : null,
      kind === "claude-new" ? "11111111-2222-3333-4444-555555555555" : null, title)).exitCode).toBe(0);
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => real.execFile("/bin/sh", ["-c", t.inner()], {
      env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, POLICY_LOG: policyLog }, timeout: 5000,
    }, (error, out) => error ? reject(error) : resolve(String(out))));
    const args = stdout.trimEnd().split("\n");
    expect(fs.readFileSync(policyLog, "utf8").trimEnd().split("\n")).toEqual(["-c", "utility", agent, ...args]);
    if (kind === "claude-new") expect(args.slice(0, 4)).toEqual(["--session-id", "11111111-2222-3333-4444-555555555555", "--name", title]);
    else if (kind === "claude-resume") expect(args.slice(0, 2)).toEqual(["--resume", "session-id"]);
    else if (kind === "claude-continue") expect(args[0]).toBe("--continue");
    else expect(args).toEqual(["resume", "--remote", "unix:///tmp/fake.sock", "--no-alt-screen", kind.endsWith("resume") ? "session-id" : "thread-new"]);
  }
});

test.each(["tmux", "herdr"] as const)("%s: 先頭代入つきのカスタム新規・resume・continue を保持する", async (backend) => {
  for (const command of ["FOO=bar BAR=baz claude", "FOO='bar baz' claude", "FOO=bar exec claude", "FOO=bar command claude"]) {
    for (const kind of ["new", "resume", "continue"]) {
      const t = terminal(backend);
      const launcher = makeSessionLauncher({ backend, runner: t.runner, store: new SessionMetadataStore(tempDir()),
        innerCommand: command + (kind === "continue" ? " --continue" : ""), agentClamp: CLAMP });
      expect((await launcher(tempDir(), "s-priority", null, kind === "resume" ? "session-id" : null)).exitCode).toBe(0);
      const inner = t.inner();
      if (command.includes("'") || command.includes(" command ")) {
        expect(inner).toContain(command);
        expect(inner).not.toContain("taskpolicy");
      } else if (command.includes(" exec ")) expect(inner).toContain(`FOO=bar exec ${PREFIX}claude`);
      else expect(inner).toContain(`FOO=bar BAR=baz ${PREFIX}claude`);
      if (kind === "resume") expect(inner).toContain("claude --resume session-id");
      if (kind === "continue") expect(inner).toContain("claude --continue");
    }
  }
});

// 実 /bin/sh と偽 taskpolicy・偽エージェントを使うため sandbox 外で実行する。
test.each(["new", "resume", "continue"])("実シェル: 先頭代入つきの %s が環境と引数を保って起動する", async (kind) => {
  for (const mode of ["plain", "quoted", "exec", "command"]) {
    const quoted = mode === "quoted", clamped = mode === "plain" || mode === "exec";
    const dir = tempDir(), policyLog = path.join(dir, "policy.log");
    fs.writeFileSync(path.join(dir, "taskpolicy"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$POLICY_LOG"\nshift 2\nexec "$@"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "fake-agent"), '#!/bin/sh\nprintf "%s|%s\\n" "$FOO" "$BAR"\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const t = terminal("tmux");
    const launcher = makeSessionLauncher({ backend: "tmux", runner: t.runner, store: new SessionMetadataStore(tempDir()),
      innerCommand: `${quoted ? "FOO='bar baz'" : "FOO=bar"} BAR=qux ${mode === "exec" || mode === "command" ? mode + " " : ""}fake-agent${kind === "continue" ? " --continue" : ""}`,
      agentClamp: [path.join(dir, "taskpolicy"), "-c", "utility"] });
    expect((await launcher(dir, "s-priority", null, kind === "resume" ? "session-id" : null)).exitCode).toBe(0);
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => real.execFile("/bin/sh", ["-c", t.inner()], {
      env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, POLICY_LOG: policyLog }, timeout: 5000,
    }, (error, out) => error ? reject(error) : resolve(String(out))));
    expect(stdout.split("\n")[0]).toBe(`${quoted ? "bar baz" : "bar"}|qux`);
    const agentArgs = stdout.trimEnd().split("\n").slice(1);
    const requestedArgs = kind === "resume" ? ["--resume", "session-id"] : kind === "continue" ? ["--continue"] : [];
    expect(agentArgs.slice(0, requestedArgs.length)).toEqual(requestedArgs);
    expect(fs.existsSync(policyLog)).toBe(clamped);
    if (clamped) expect(fs.readFileSync(policyLog, "utf8").trimEnd().split("\n"))
      .toEqual(["-c", "utility", "fake-agent", ...agentArgs]);
  }
});

test("実シェル: 組み込み・予約語・複合コマンドは元のまま実行できる", async () => {
  const dir = tempDir(), policyLog = path.join(dir, "policy.log"), policyPath = path.join(dir, "taskpolicy");
  fs.writeFileSync(policyPath, '#!/bin/sh\necho unexpected > "$POLICY_LOG"\nexit 97\n', { mode: 0o700 });
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  for (const command of ["FOO=bar printf '%s' ok", "if true; then printf '%s' ok; fi", "{ printf '%s' ok; }"]) {
    const wrapped = withAgentClampShellCommand(command, [policyPath, "-c", "utility"]);
    expect(wrapped).toBe(command);
    const stdout = await new Promise<string>((resolve, reject) => real.execFile("/bin/sh", ["-c", wrapped], {
      env: { HOME: dir, PATH: "/usr/bin:/bin", POLICY_LOG: policyLog }, timeout: 5000,
    }, (error, out) => error ? reject(error) : resolve(String(out))));
    expect(stdout).toBe("ok");
    expect(fs.existsSync(policyLog)).toBe(false);
  }
});

describe.each(modes)("エージェント起動: $name", ({ probe, enabled }) => {
  test.each(["tmux", "herdr"] as const)("%s: Claude 新規・resume・continue と stale pane の起動し直し", async (backend) => {
    policy.clamp = agentClampArgv(probe);
    for (const kind of ["new", "resume", "continue"] as const) {
      const t = terminal(backend, kind === "resume");
      const launcher = makeSessionLauncher({
        backend, runner: t.runner, store: new SessionMetadataStore(tempDir()),
        innerCommand: kind === "continue" ? "claude --continue" : "claude --model opus",
      });
      const result = await launcher(tempDir(), "s-priority", null,
        kind === "resume" ? "session-id" : null,
        kind === "new" ? "11111111-2222-3333-4444-555555555555" : null,
        null, { todoTools: true });
      expect(result.exitCode).toBe(0);
      const inner = t.inner();
      if (enabled) expect(inner).toContain(`${PREFIX}claude`);
      else expect(inner).not.toContain("taskpolicy");
      expect(inner).toContain("CLAUDE_CODE_ENABLE_TODO_TOOLS=1");
      expect(inner).toContain("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=1000000000 ");
      if (kind === "resume") {
        expect(inner).toContain("claude --model opus --resume session-id");
        expect(t.calls.some((c) => c.args.includes(backend === "tmux" ? "kill-session" : "close"))).toBe(true);
      }
      if (kind === "continue") expect(inner).toContain("claude --continue");
      // クライアント自身を taskpolicy 経由で起動していない。
      expect(t.calls.every((c) => !c.exe.includes("taskpolicy"))).toBe(true);
    }
  });

  test.each(["tmux", "herdr"] as const)("%s: Codex 新規 / resume と再試行ループ", async (backend) => {
    policy.clamp = agentClampArgv(probe);
    for (const resume of [null, "thread-existing"]) {
      const t = terminal(backend);
      const appServer = { remoteEndpoint: "unix:///tmp/fake.sock",
        startThread: vi.fn(async () => "thread-new"), ensureRunning: vi.fn(async () => {}) };
      const launcher = makeSessionLauncher({
        agent: "codex", backend, runner: t.runner, codexAppServer: appServer,
        store: new SessionMetadataStore(tempDir()),
      });
      expect((await launcher(tempDir(), "s-priority", null, resume)).exitCode).toBe(0);
      const inner = t.inner();
      expect(inner).toContain("while ! find ");
      expect(inner).toContain(`s=$(date +%s); ${enabled ? PREFIX : ""}codex resume --remote unix:///tmp/fake.sock --no-alt-screen ${resume ?? "thread-new"}; rc=$?;`);
      if (!enabled) expect(inner).not.toContain("taskpolicy");
      expect(t.calls.every((c) => !c.exe.includes("taskpolicy"))).toBe(true);
      expect(appServer.startThread).toHaveBeenCalledTimes(resume === null ? 1 : 0);
      expect(appServer.ensureRunning).toHaveBeenCalledTimes(resume === null ? 0 : 1);
    }
  });

  test("tailii launch の直接起動", async () => {
    policy.clamp = agentClampArgv(probe);
    const calls: { file: string; args: string[] }[] = [];
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], _opts: unknown, done: Function) => {
      calls.push({ file, args });
      done(args[0] === "has-session" ? { code: 1 } : null, "", "");
      return {};
    }) as typeof execFile);
    expect(await runLaunchCommand(["--dir", tempDir(), "--session", "priority-direct"])).toBe(0);
    const inner = calls.find((c) => c.args[0] === "new")!.args[4]!;
    expect(inner.startsWith(`${enabled ? PREFIX : ""}claude`)).toBe(true);
    expect(calls.every((c) => !c.file.includes("taskpolicy"))).toBe(true);
  });

  test("Codex App Server daemon と API worker の spawn", () => {
    policy.clamp = agentClampArgv(probe);
    const child = Object.assign(new EventEmitter(), {
      pid: 123, stdout: new PassThrough(), stdin: new PassThrough(), unref: vi.fn(), kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const env = { HOME: "/fake/home", PATH: "/bin" };
    launchCodexAppServerDetached("/path with spaces/codex", ["app-server", "--listen", "unix://"], env);
    expect(spawn).toHaveBeenLastCalledWith(
      enabled ? CLAMP[0] : "/path with spaces/codex",
      [...(enabled ? ["-c", "utility", "/path with spaces/codex"] : []), "app-server", "--listen", "unix://"],
      { detached: true, env, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    const worker = spawnApiAgentWorker(env, { nodePath: "/path with spaces/node", entry: "/worker entry.js" });
    expect(spawn).toHaveBeenLastCalledWith(
      enabled ? CLAMP[0] : "/path with spaces/node",
      [...(enabled ? ["-c", "utility", "/path with spaces/node"] : []), "/worker entry.js"],
      { env, cwd: "/fake/home", stdio: ["pipe", "pipe", "ignore"] },
    );
    expect(worker.pid).toBe(123);
    expect(vi.mocked(spawn).mock.calls.at(-1)![2]!.env).toBe(env);
  });
});

test("herdr の短い直接コマンド / 長い起動スクリプトのどちらにも接頭辞を保持する", () => {
  const command = `${PREFIX}claude --resume session-id`;
  expect(herdrPaneRunCommand(command, "short", tempDir())).toContain(command);
  const dir = tempDir();
  const long = `${command} --settings '${"x".repeat(1000)}'`;
  const run = herdrPaneRunCommand(long, "long", dir);
  expect(run).not.toContain("taskpolicy");
  expect(fs.readFileSync(path.join(dir, "herdr-launch-long.zsh"), "utf8")).toBe(`rm -f -- "$0"\n${long}\n`);
});

test("utility 固定を明示的に空に差し替えた Codex 再試行コマンドは従来のまま", () => {
  const command = codexRemoteResumeCommand("codex", "thread-id", "unix://", []);
  expect(command).toContain("s=$(date +%s); codex resume --remote unix:// --no-alt-screen thread-id; rc=$?;");
  expect(command).not.toContain("taskpolicy");
});

test("herdr サーバーの起動には接頭辞を付けない", async () => {
  const t = terminal("herdr");
  let first = true;
  const child = { unref: vi.fn() };
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const runner: ProcessRunner = async (exe, args, options) => {
    if (first && args[3] === "list") { first = false; return { exitCode: 1, stdout: "" }; }
    return t.runner(exe, args, options);
  };
  const launcher = makeSessionLauncher({
    backend: "herdr", herdrPath: "/fake/herdr", runner, store: new SessionMetadataStore(tempDir()),
  });
  expect((await launcher(tempDir(), "s-priority", null, null)).exitCode).toBe(0);
  expect(spawn).toHaveBeenCalledExactlyOnceWith("/fake/herdr", ["--session", "tailii", "server"], {
    detached: true, stdio: "ignore",
  });
  expect(t.inner()).toContain(`${PREFIX}claude`);
});

test.each(["/bin/sh", "/bin/zsh"].filter((shell) => fs.existsSync(shell)))(
  "%s: 偽 CLI で再試行を実行し、毎回の起動に固定がかかることを確認する", async (shell) => {
    const dir = tempDir();
    const scripts = {
      // 実 taskpolicy は呼ばない。引数を記録して同じ pid のまま偽 codex に exec する。
      taskpolicy: 'printf "%s\\n" "$*" >> "$POLICY_LOG"\nshift 2\nexec "$@"\n',
      find: 'echo found\n',
      sleep: 'exit 0\n',
      codex: 'if [ ! -f "$CODEX_MARKER" ]; then touch "$CODEX_MARKER"; exit 1; fi\nexit 0\n',
    };
    for (const [name, source] of Object.entries(scripts)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${source}`, { mode: 0o700 });
    }
    const command = codexRemoteResumeCommand("codex", "thread-retry", "unix://", [path.join(dir, "taskpolicy"), "-c", "utility"]);
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    await new Promise<void>((resolve, reject) => real.execFile(shell, ["-f", "-c", command], {
      env: { HOME: dir, ZDOTDIR: dir, PATH: `${dir}:/usr/bin:/bin`, POLICY_LOG: path.join(dir, "policy.log"), CODEX_MARKER: path.join(dir, "marker") },
      timeout: 5000,
    }, (error) => error ? reject(error) : resolve()));
    expect(fs.readFileSync(path.join(dir, "policy.log"), "utf8").trim().split("\n")).toEqual([
      "-c utility codex resume --remote unix:// --no-alt-screen thread-retry",
      "-c utility codex resume --remote unix:// --no-alt-screen thread-retry",
    ]);
  },
);
