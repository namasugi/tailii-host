// launch.test.ts — launchCore / resolveWorkdir / HookSettings のテスト
// Swift 版 LaunchTests / HookSettingsTests の要点を移植する（実 tmux は起動しない）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeHookLaunchSettings } from "../src/hookSettings.js";
import {
  DEFAULT_CODEX_COMMAND,
  codexInnerCommand,
  launchCore,
  makeSessionLauncher,
  resolveWorkdir,
  shellSingleQuote,
  type ProcessRunner,
} from "../src/launch.js";
import { SessionMetadataStore } from "../src/sessionMetadataStore.js";
import { makeTempDir } from "./helpers.js";

/** tmux 呼び出しを記録するモックランナー。 */
function mockRunner(
  handler?: (exe: string, args: string[]) => { exitCode: number; stdout: string },
): { runner: ProcessRunner; recorded: { exe: string; args: string[]; cwd?: string }[] } {
  const recorded: { exe: string; args: string[]; cwd?: string }[] = [];
  const runner: ProcessRunner = async (exe, args, options) => {
    recorded.push({ exe, args, cwd: options.cwd });
    return handler?.(exe, args) ?? { exitCode: args[0] === "has-session" ? 1 : 0, stdout: "" };
  };
  return { runner, recorded };
}

describe("resolveWorkdir", () => {
  test("絶対パスはそのまま採用（存在必須）", () => {
    const dir = makeTempDir("resolve-abs");
    const errors: string[] = [];
    expect(resolveWorkdir(dir, null, (m) => errors.push(m))).toBe(dir);
    expect(resolveWorkdir("/nope-not-exist", null, (m) => errors.push(m))).toBeNull();
    expect(errors.some((m) => m.includes("存在しません"))).toBe(true);
  });

  test("相対パスは baseDir 配下へ解決し、不在なら自動作成する", () => {
    const base = makeTempDir("resolve-rel");
    const errors: string[] = [];
    const resolved = resolveWorkdir("newdir/sub", base, (m) => errors.push(m));
    expect(resolved).toBe(path.join(base, "newdir", "sub"));
    expect(fs.statSync(resolved!).isDirectory()).toBe(true);
  });

  test("`..` 脱出と baseDir 未設定はエラー", () => {
    const base = makeTempDir("resolve-escape");
    const errors: string[] = [];
    expect(resolveWorkdir("../outside", base, (m) => errors.push(m))).toBeNull();
    expect(resolveWorkdir("relative", null, (m) => errors.push(m))).toBeNull();
  });

  test("既存だがファイルはエラー", () => {
    const base = makeTempDir("resolve-file");
    fs.writeFileSync(path.join(base, "f"), "x");
    const errors: string[] = [];
    expect(resolveWorkdir(path.join(base, "f"), null, (m) => errors.push(m))).toBeNull();
    expect(errors.some((m) => m.includes("ファイルです"))).toBe(true);
  });
});

describe("launchCore", () => {
  test("tmux new -d で起動し cwd をメタデータへ権威記録する", async () => {
    const dir = makeTempDir("launch-ok");
    const store = new SessionMetadataStore(makeTempDir("launch-store"));
    const { runner, recorded } = mockRunner();
    const errors: string[] = [];

    const code = await launchCore({
      dir,
      session: "work",
      baseDir: null,
      binaryPath: "/usr/local/bin/tailii",
      tmuxPath: "/opt/homebrew/bin/tmux",
      innerCommand: "sleep 300",
      path: "/usr/bin:/bin",
      store,
      now: () => 42,
      errorSink: (m) => errors.push(m),
      runner,
      claudeJsonPath: path.join(makeTempDir("launch-claudejson"), ".claude.json"),
      hookGlobalMarkerPath: path.join(dir, "no-such-marker"),
    });

    expect(code).toBe(0);
    const newCall = recorded.find((c) => c.args[0] === "new");
    expect(newCall?.args.slice(0, 4)).toEqual(["new", "-d", "-s", "work"]);
    // 承認フックは settings.json へ書かず、この起動限定に `--settings '<json>'` で渡す。
    expect(newCall?.args[4]).toMatch(/^sleep 300 --settings /);
    expect(newCall?.args[4]).toContain("hook --session work");
    expect(newCall?.cwd).toBe(dir);
    expect(store.get("work")).toEqual({ name: "work", cwd: dir, createdAt: 42 });
    // リポジトリの settings.json は汚さない（書き込まれない）。
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  test("dir 不在は非0で失敗し、tmux もメタ保存もしない", async () => {
    const store = new SessionMetadataStore(makeTempDir("launch-store2"));
    const { runner, recorded } = mockRunner();
    const errors: string[] = [];

    const code = await launchCore({
      dir: "/nope-not-exist",
      session: "bad",
      baseDir: null,
      binaryPath: "/bin/x",
      tmuxPath: "/opt/homebrew/bin/tmux",
      innerCommand: "sleep 300",
      path: "/usr/bin:/bin",
      store,
      now: () => 0,
      errorSink: (m) => errors.push(m),
      runner,
    });

    expect(code).toBe(1);
    expect(recorded).toEqual([]);
    expect(store.get("bad")).toBeNull();
    expect(errors.some((m) => m.includes("存在しません"))).toBe(true);
  });

  test("生きた同名セッションが既に居れば tmux new をスキップして成功する", async () => {
    const dir = makeTempDir("launch-live");
    const store = new SessionMetadataStore(makeTempDir("launch-store3"));
    const { runner, recorded } = mockRunner((_exe, args) => {
      if (args[0] === "has-session") return { exitCode: 0, stdout: "" };
      if (args[0] === "list-panes") return { exitCode: 0, stdout: "0\n" }; // 生きた pane あり
      return { exitCode: 0, stdout: "" };
    });

    const code = await launchCore({
      dir,
      session: "live",
      baseDir: null,
      binaryPath: "/bin/x",
      tmuxPath: "/opt/homebrew/bin/tmux",
      innerCommand: "sleep 300",
      path: "/usr/bin:/bin",
      store,
      now: () => 1,
      errorSink: () => {},
      runner,
      claudeJsonPath: path.join(makeTempDir("launch-claudejson2"), ".claude.json"),
      hookGlobalMarkerPath: path.join(dir, "no-such-marker"),
    });

    expect(code).toBe(0);
    expect(recorded.some((c) => c.args[0] === "new")).toBe(false);
    expect(recorded.some((c) => c.args[0] === "kill-session")).toBe(false);
    expect(store.get("live")?.cwd).toBe(dir);
  });

  test("死んだ同名セッション（生きた pane なし）は kill してから作り直す", async () => {
    const dir = makeTempDir("launch-dead");
    const store = new SessionMetadataStore(makeTempDir("launch-store4"));
    let killed = false;
    const { runner, recorded } = mockRunner((_exe, args) => {
      if (args[0] === "has-session") return { exitCode: killed ? 1 : 0, stdout: "" };
      if (args[0] === "list-panes") return { exitCode: 0, stdout: "1\n" }; // dead pane のみ
      if (args[0] === "kill-session") {
        killed = true;
        return { exitCode: 0, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    });

    const code = await launchCore({
      dir,
      session: "zombie",
      baseDir: null,
      binaryPath: "/bin/x",
      tmuxPath: "/opt/homebrew/bin/tmux",
      innerCommand: "sleep 300",
      path: "/usr/bin:/bin",
      store,
      now: () => 1,
      errorSink: () => {},
      runner,
      claudeJsonPath: path.join(makeTempDir("launch-claudejson3"), ".claude.json"),
      hookGlobalMarkerPath: path.join(dir, "no-such-marker"),
    });

    expect(code).toBe(0);
    expect(recorded.some((c) => c.args[0] === "kill-session")).toBe(true);
    expect(recorded.some((c) => c.args[0] === "new")).toBe(true);
  });
});

describe("claudeHookLaunchSettings", () => {
  test("PreToolUse/PostToolUse を持つ JSON を返し、ファイルは書かない", () => {
    const dir = makeTempDir("hooks-json");
    const json = claudeHookLaunchSettings({
      dir,
      binaryPath: "/usr/local/bin/tailii",
      session: "work",
      globalMarkerPath: path.join(dir, "no-such-marker"),
    });
    expect(json).not.toBeNull();
    const settings = JSON.parse(json!) as { hooks: Record<string, unknown> };
    // 副作用なし: settings.json を書かない（リポジトリを汚さない）。
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const list = settings.hooks[event] as { hooks: { command: string; timeout: number }[] }[];
      expect(list).toHaveLength(1);
      expect(list[0]?.hooks[0]?.command).toBe("/usr/local/bin/tailii hook --session work");
      expect(list[0]?.hooks[0]?.timeout).toBe(600);
    }
  });

  test(".tailii-nohook マーカーがある dir は null（フック無し）", () => {
    const dir = makeTempDir("hooks-nohook");
    fs.writeFileSync(path.join(dir, ".tailii-nohook"), "");
    const json = claudeHookLaunchSettings({
      dir,
      binaryPath: "/bin/pc",
      session: "s",
      globalMarkerPath: path.join(dir, "no-such-marker"),
    });
    expect(json).toBeNull();
  });

  test("グローバルマーカーがあれば null（全ディレクトリでフック無し）", () => {
    const dir = makeTempDir("hooks-global");
    const marker = path.join(dir, "nohook-marker");
    fs.writeFileSync(marker, "");
    const json = claudeHookLaunchSettings({ dir, binaryPath: "/bin/pc", session: "s", globalMarkerPath: marker });
    expect(json).toBeNull();
  });
});

describe("launchCore（codex モード）", () => {
  test("codex: 信頼を -c で事前付与し、claude 固有の settings.json/.claude.json を書かない", async () => {
    const dir = makeTempDir("launch-codex");
    const store = new SessionMetadataStore(makeTempDir("launch-codex-store"));
    const { runner, recorded } = mockRunner();
    const claudeJsonPath = path.join(makeTempDir("launch-codex-cj"), ".claude.json");
    const errors: string[] = [];

    const code = await launchCore({
      dir,
      session: "cdx",
      baseDir: null,
      binaryPath: "/usr/local/bin/tailii",
      tmuxPath: "/opt/homebrew/bin/tmux",
      innerCommand: "codex -a never -s workspace-write",
      path: "/usr/bin:/bin",
      store,
      now: () => 7,
      errorSink: (m) => errors.push(m),
      runner,
      agent: "codex",
      claudeJsonPath,
      hookGlobalMarkerPath: path.join(dir, "no-such-marker"),
    });

    expect(code).toBe(0);
    const newCall = recorded.find((c) => c.args[0] === "new");
    // 信頼オーバーライド + フック信頼バイパスが innerCommand に付与されている。
    expect(newCall?.args[4]).toBe(
      `codex -a never -s workspace-write -c projects."${dir}".trust_level="trusted" --dangerously-bypass-hook-trust`,
    );
    expect(newCall?.cwd).toBe(dir);
    // codex セッションは metadata に agent="codex" を記録する（per-session tail/resume 判別用）。
    expect(store.get("cdx")).toEqual({ name: "cdx", cwd: dir, createdAt: 7, agent: "codex" });
    // claude 固有のフック/事前信頼ファイルは書かれない。
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(claudeJsonPath)).toBe(false);
    // codex 用の承認フックが .codex/hooks.json に導入される（PreToolUse, --agent codex）。
    const codexHooks = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
    const pre = codexHooks.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain("hook --session cdx --agent codex");
    expect(pre.map((e) => e.matcher)).toEqual(expect.arrayContaining(["Bash", "Write|Edit"]));
  });

  test("makeSessionLauncher(agent=codex): resume なしの新規起動は既定コマンド", async () => {
    const dir = makeTempDir("launch-codex-def");
    const store = new SessionMetadataStore(makeTempDir("launch-codex-def-store"));
    const { runner, recorded } = mockRunner();
    const launcher = makeSessionLauncher({ store, agent: "codex", runner });

    // resumeSessionId=null（新規起動）は DEFAULT_CODEX_COMMAND を使う。
    const { exitCode } = await launcher(dir, "cdx2", null, null);
    expect(exitCode).toBe(0);
    const newCall = recorded.find((c) => c.args[0] === "new");
    // DEFAULT_CODEX_COMMAND + 信頼オーバーライド + フック信頼バイパス。resume は付かない。
    expect(newCall?.args[4]).toBe(
      `${DEFAULT_CODEX_COMMAND} -c projects."${dir}".trust_level="trusted" --dangerously-bypass-hook-trust`,
    );
    expect(newCall?.args[4]).not.toContain("codex resume");
  });

  test("makeSessionLauncher(agent=codex): resume 指定は `codex resume <id>` で継続する（agent-tag）", async () => {
    const dir = makeTempDir("launch-codex-res");
    const store = new SessionMetadataStore(makeTempDir("launch-codex-res-store"));
    const { runner, recorded } = mockRunner();
    const launcher = makeSessionLauncher({ store, agent: "codex", runner });

    const { exitCode } = await launcher(dir, "cdx3", null, "abc-123");
    expect(exitCode).toBe(0);
    const newCall = recorded.find((c) => c.args[0] === "new");
    // `codex resume -a never -s workspace-write <id>` + 信頼オーバーライド + フック信頼バイパス。
    expect(newCall?.args[4]).toBe(
      `codex resume -a never -s workspace-write abc-123 -c projects."${dir}".trust_level="trusted" --dangerously-bypass-hook-trust`,
    );
  });
});

describe("codexInnerCommand", () => {
  test("既定（未指定）は -a never -s workspace-write、モデルは付かない", () => {
    expect(codexInnerCommand({})).toBe("codex -a never -s workspace-write");
  });

  test("サンドボックスとモデルを指定するとフラグに反映する", () => {
    expect(codexInnerCommand({ model: "gpt-5.4", sandbox: "read-only" })).toBe(
      "codex -a never -s read-only -m gpt-5.4",
    );
    expect(codexInnerCommand({ sandbox: "danger-full-access" })).toBe(
      "codex -a never -s danger-full-access",
    );
  });

  test("不正な文字を含むモデル slug は無視する（コマンド注入防止）", () => {
    expect(codexInnerCommand({ model: "gpt; rm -rf /" })).toBe("codex -a never -s workspace-write");
    expect(codexInnerCommand({ model: "" })).toBe("codex -a never -s workspace-write");
  });
});

describe("shellSingleQuote", () => {
  test("single-quote で包み、内部の ' を '\\'' へエスケープする", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
    expect(shellSingleQuote("a b")).toBe("'a b'");
    expect(shellSingleQuote("Bob's")).toBe("'Bob'\\''s'");
    expect(shellSingleQuote("日本語のタイトル")).toBe("'日本語のタイトル'");
  });
});

describe("makeSessionLauncher: claude --session-id / --name の合成（lazy-session）", () => {
  // makeSessionLauncher → launchCore は preTrustFolder で実 ~/.claude.json を触るため、
  // スナップショット＆復元で密閉性を保つ（本テストスイートは singleFork 直列実行）。
  async function withClaudeJsonRestored<T>(fn: () => Promise<T>): Promise<T> {
    const claudeJson = path.join(os.homedir(), ".claude.json");
    let backup: string | null = null;
    try {
      backup = fs.readFileSync(claudeJson, "utf8");
    } catch {
      backup = null;
    }
    try {
      return await fn();
    } finally {
      if (backup !== null) fs.writeFileSync(claudeJson, backup);
    }
  }

  const UUID = "11111111-2222-3333-4444-555555555555";

  test("新規(会話名あり)は --session-id と --name '<title>' を付ける", async () => {
    await withClaudeJsonRestored(async () => {
      const dir = makeTempDir("launcher-name");
      const store = new SessionMetadataStore(makeTempDir("launcher-name-store"));
      const { runner, recorded } = mockRunner();
      const launcher = makeSessionLauncher({ store, innerCommand: "claude", runner });
      await launcher(dir, "s-1", null, null, UUID, "Bob's chat");
      const inner = recorded.find((c) => c.args[0] === "new")?.args[4];
      // 末尾に承認フックの `--settings '<json>'` が続くため前方一致で検証する。
      expect(inner).toContain(`claude --session-id ${UUID} --name 'Bob'\\''s chat'`);
    });
  });

  test("新規(会話名なし)は --session-id のみ（--name は付けない）", async () => {
    await withClaudeJsonRestored(async () => {
      const dir = makeTempDir("launcher-noname");
      const store = new SessionMetadataStore(makeTempDir("launcher-noname-store"));
      const { runner, recorded } = mockRunner();
      const launcher = makeSessionLauncher({ store, innerCommand: "claude", runner });
      await launcher(dir, "s-2", null, null, UUID, null);
      const inner = recorded.find((c) => c.args[0] === "new")?.args[4];
      expect(inner).toContain(`claude --session-id ${UUID}`);
      expect(inner).not.toContain("--name");
    });
  });

  test("resume は --resume のみ（--session-id/--name は付けない）", async () => {
    await withClaudeJsonRestored(async () => {
      const dir = makeTempDir("launcher-resume");
      const store = new SessionMetadataStore(makeTempDir("launcher-resume-store"));
      const { runner, recorded } = mockRunner();
      const launcher = makeSessionLauncher({ store, innerCommand: "claude", runner });
      // resume 時は title を渡しても付与しない。
      await launcher(dir, "s-3", null, "resume-id", null, "無視される名前");
      const inner = recorded.find((c) => c.args[0] === "new")?.args[4];
      expect(inner).toContain("claude --resume resume-id");
      expect(inner).not.toContain("--name");
      expect(inner).not.toContain("--session-id");
    });
  });

  test("codex は --name を付けない（session-id 制御を持たない）", async () => {
    await withClaudeJsonRestored(async () => {
      const dir = makeTempDir("launcher-codex-name");
      const store = new SessionMetadataStore(makeTempDir("launcher-codex-name-store"));
      const { runner, recorded } = mockRunner();
      const launcher = makeSessionLauncher({ store, agent: "codex", runner });
      await launcher(dir, "cdx", null, null, UUID, "会話名");
      const inner = recorded.find((c) => c.args[0] === "new")?.args[4];
      expect(inner).not.toContain("--name");
      expect(inner).not.toContain("--session-id");
    });
  });
});
