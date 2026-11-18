// chatDefaultModel.test.ts — `chat models` の既定の印を決める設定の読み取り（tailii-chat-cli）

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  readTomlTopLevel,
  resolveClaudeDefaultModel,
  resolveCodexDefaultModel,
  type DefaultModelContext,
} from "../src/commands/chat/defaultModel.js";
import { makeTempDir } from "./helpers.js";

const claudeRows = [
  { id: "claude-fable-5-2", displayName: "Claude Fable 5.2" },
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
];
const codexRows = [{ id: "gpt-a", displayName: "A" }, { id: "gpt-b", displayName: "B" }];

function setup(env: NodeJS.ProcessEnv = {}) {
  const root = fs.realpathSync(makeTempDir("default-model"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work", "app");
  const managed = path.join(root, "managed");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const context: DefaultModelContext = {
    home, env, claudeManagedDir: managed, codexHome: path.join(home, ".codex"), codexManagedConfig: path.join(root, "codex-managed.toml"),
  };
  const json = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  return {
    root, home, cwd, managed, context,
    user: (value: unknown) => json(path.join(home, ".claude", "settings.json"), value),
    project: (value: unknown) => json(path.join(cwd, ".claude", "settings.json"), value),
    local: (value: unknown) => json(path.join(cwd, ".claude", "settings.local.json"), value),
    managedSettings: (value: unknown) => json(path.join(managed, "managed-settings.json"), value),
    claudeJson: (value: unknown) => json(path.join(home, ".claude.json"), value),
    codex: (text: string) => json(path.join(home, ".codex", "config.toml"), text),
    claude: (cwdArg: string | null) => resolveClaudeDefaultModel(claudeRows, cwdArg, context),
    codexDefault: (cwdArg: string | null) => resolveCodexDefaultModel(codexRows, cwdArg, context),
  };
}

describe("Claude の既定のモデル", () => {
  test("利用者の設定の model に印を付ける。--cwd なしはフォルダの設定を読まない", () => {
    const s = setup();
    s.user({ model: "claude-opus-5-5" });
    s.project({ model: "claude-fable-5-2" });
    expect(s.claude(null)).toEqual({ id: "claude-opus-5-5", reason: "user" });
  });

  test("優先順位は managed > local > project > user", () => {
    const s = setup();
    s.user({ model: "claude-opus-5-5" });
    s.project({ model: "claude-fable-5-2" });
    expect(s.claude(s.cwd)).toEqual({ id: "claude-fable-5-2", reason: "project" });
    s.local({ model: "claude-haiku-5-5" });
    expect(s.claude(s.cwd)).toEqual({ id: "claude-haiku-5-5", reason: "local" });
    s.managedSettings({ model: "claude-opus-5-5" });
    expect(s.claude(s.cwd)).toEqual({ id: "claude-opus-5-5", reason: "managed" });
  });

  test("[1m] 付きの値と、系統の別名を一覧の行へ写す", () => {
    const s = setup();
    s.user({ model: "claude-opus-5-5[1m]" });
    expect(s.claude(null).id).toBe("claude-opus-5-5");
    s.user({ model: "fable" });
    expect(s.claude(null).id).toBe("claude-fable-5-2");
  });

  test("系統の別名の指す先が環境で変えられていれば印なし", () => {
    const s = setup({ ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4" });
    s.user({ model: "opus" });
    expect(s.claude(null).id).toBeNull();
  });

  test.each([
    { label: "一覧に無い ID", settings: { model: "claude-old-1" } },
    { label: "default", settings: { model: "default" } },
    { label: "文字列でない model", settings: { model: 3 } },
    { label: "モデルの制限", settings: { model: "claude-opus-5-5", availableModels: ["opus"] } },
    { label: "設定の env の ANTHROPIC_MODEL", settings: { model: "claude-opus-5-5", env: { ANTHROPIC_MODEL: "x" } } },
    { label: "壊れた JSON", settings: "{ broken" },
  ])("決められないときは印なし: $label", ({ settings }) => {
    const s = setup();
    s.user(settings);
    expect(s.claude(null).id).toBeNull();
  });

  test("環境の ANTHROPIC_MODEL・組織の既定があれば印なし", () => {
    const env = setup({ ANTHROPIC_MODEL: "claude-haiku-5-5" });
    env.user({ model: "claude-opus-5-5" });
    expect(env.claude(null).id).toBeNull();
    const org = setup();
    org.user({ model: "claude-opus-5-5" });
    org.claudeJson({ orgModelDefaultCache: { model: "x" } });
    expect(org.claude(null).id).toBeNull();
  });

  test("管理者の追加設定のフォルダがあれば印なし", () => {
    const s = setup();
    s.user({ model: "claude-opus-5-5" });
    fs.mkdirSync(path.join(s.managed, "managed-settings.d"));
    expect(s.claude(null).id).toBeNull();
  });

  test("model が無ければ ANTHROPIC_DEFAULT_MODEL。設定が何も無ければ印なし", () => {
    expect(setup().claude(null).id).toBeNull();
    const fromProcess = setup({ ANTHROPIC_DEFAULT_MODEL: "claude-haiku-5-5" });
    expect(fromProcess.claude(null)).toEqual({ id: "claude-haiku-5-5", reason: "env_default" });
    const fromUser = setup();
    fromUser.user({ env: { ANTHROPIC_DEFAULT_MODEL: "claude-fable-5-2" } });
    expect(fromUser.claude(null).id).toBe("claude-fable-5-2");
    const scoped = setup();
    scoped.project({ env: { ANTHROPIC_DEFAULT_MODEL: "claude-fable-5-2" } });
    expect(scoped.claude(scoped.cwd).id).toBeNull();
  });

  test("worktree では本体の根の settings.local.json も読み、食い違えば印なし", () => {
    const s = setup();
    const main = path.join(s.root, "main");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(path.join(main, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, ".git"), `gitdir: ${main}/.git/worktrees/wt\n`);
    fs.writeFileSync(path.join(main, ".claude", "settings.local.json"), JSON.stringify({ model: "claude-haiku-5-5" }));
    expect(s.claude(s.cwd)).toEqual({ id: "claude-haiku-5-5", reason: "local" });
    s.local({ model: "claude-opus-5-5" });
    expect(s.claude(s.cwd).id).toBeNull();
  });
});

describe("Codex の既定のモデル", () => {
  test("最上位の model に印を付ける（一重引用符・行末のコメントも読む）", () => {
    const s = setup();
    s.codex('model = "gpt-b" # 普段使い\n');
    expect(s.codexDefault(null)).toEqual({ id: "gpt-b", reason: "config" });
    s.codex("model = 'gpt-a'\n");
    expect(s.codexDefault(null).id).toBe("gpt-a");
  });

  test("複数行の配列の後ろの model を読み、テーブルの中の model は読まない", () => {
    const s = setup();
    s.codex('notify = [\n  "a",\n  "[b]",\n]\nmodel = "gpt-a"\n[profiles.x]\nmodel = "gpt-b"\n');
    expect(s.codexDefault(null).id).toBe("gpt-a");
    s.codex('[profiles.x]\nmodel = "gpt-b"\n');
    expect(s.codexDefault(null).id).toBeNull();
  });

  test.each([
    { label: "設定ファイルが無い", text: null },
    { label: "model が無い", text: 'approval_policy = "never"\n' },
    { label: "profile がある", text: 'model = "gpt-a"\nprofile = "work"\n' },
    { label: "複数行の文字列がある", text: 'x = """\nmodel = "gpt-b"\n"""\nmodel = "gpt-a"\n' },
    { label: "同じキーが重複", text: 'model = "gpt-a"\nmodel = "gpt-b"\n' },
    { label: "一覧に無いモデル", text: 'model = "gpt-hidden"\n' },
  ])("決められないときは印なし: $label", ({ text }) => {
    const s = setup();
    if (text !== null) s.codex(text);
    expect(s.codexDefault(null).id).toBeNull();
  });

  test("フォルダの .codex/config.toml に model があれば印なし。--cwd なしでは見ない", () => {
    const s = setup();
    s.codex('model = "gpt-a"\n');
    fs.mkdirSync(path.join(s.cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, ".codex", "config.toml"), 'model = "gpt-b"\n');
    expect(s.codexDefault(s.cwd).id).toBeNull();
    expect(s.codexDefault(null).id).toBe("gpt-a");
  });

  test("管理者の設定があれば印なし", () => {
    const s = setup();
    s.codex('model = "gpt-a"\n');
    fs.writeFileSync(s.context.codexManagedConfig, "");
    expect(s.codexDefault(null).id).toBeNull();
  });

  test("TOML の最上位の読み取り", () => {
    expect(readTomlTopLevel('a = [1, 2]\nmodel = "m"\n')).toEqual({ model: "m" });
    expect(readTomlTopLevel('"model" = "m"\n')).toBeNull();
    expect(readTomlTopLevel('model = "a\\"b"\n')).toBeNull();
  });
});

describe("レビューで見つかった読み違い", () => {
  test.each([
    { label: "配列の文字列の中の #", text: 'model = "gpt-a"\nnotify = ["say", "done #1"]\nprofile = "work"\n' },
    { label: "行末で閉じる複数行の配列", text: 'model = "gpt-a"\nnotify = ["say",\n  "done"]\nprofile = "work"\n' },
  ])("配列の後ろの profile を読み飛ばさない: $label", ({ text }) => {
    expect(readTomlTopLevel(text)).toEqual({ model: "gpt-a", profile: "work" });
  });

  test("テーブルの中の model を最上位として読まない", () => {
    const text = 'notify = ["say", "done #1"]\n[tools]\nlist = [\n  "a",\n]\n[profiles.work]\nmodel = "gpt-b"\n';
    expect(readTomlTopLevel(text)).toEqual({});
  });

  test("配列の中の括弧の文字は数えない", () => {
    expect(readTomlTopLevel('notify = ["]", "[",\n  "x"]\nmodel = "gpt-a"\n')).toEqual({ model: "gpt-a" });
  });

  test.each([
    { label: "閉じない配列", text: 'notify = [\n  "a",\nmodel = "gpt-a"\n' },
    { label: "閉じない文字列", text: 'notify = "a\nmodel = "gpt-a"\n' },
    { label: "代入でない行", text: 'something\nmodel = "gpt-a"\n' },
  ])("読めない形は null: $label", ({ text }) => {
    expect(readTomlTopLevel(text)).toBeNull();
  });

  test("CLAUDE_CONFIG_DIR があれば印を付けない", () => {
    const s = setup({ CLAUDE_CONFIG_DIR: "/somewhere/else" });
    s.user({ model: "claude-opus-5-5" });
    expect(s.claude(null)).toEqual({ id: null, reason: "none:config_dir" });
  });

  test("ANTHROPIC_DEFAULT_MODEL が環境と user の env で食い違えば印を付けない", () => {
    const s = setup({ ANTHROPIC_DEFAULT_MODEL: "claude-opus-5-5" });
    s.user({ env: { ANTHROPIC_DEFAULT_MODEL: "claude-fable-5-2" } });
    expect(s.claude(null)).toEqual({ id: null, reason: "none:default_env_conflict" });
  });

  test("worktree の .git が相対パスでも本体の settings.local.json を読む", () => {
    const s = setup();
    const main = path.join(s.root, "work", "main");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "app"), { recursive: true });
    fs.mkdirSync(path.join(main, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(main, ".claude", "settings.local.json"), JSON.stringify({ model: "claude-fable-5-2" }));
    fs.writeFileSync(path.join(s.cwd, ".git"), "gitdir: ../main/.git/worktrees/app\n");
    s.user({ model: "claude-opus-5-5" });
    expect(s.claude(s.cwd)).toEqual({ id: "claude-fable-5-2", reason: "local" });
  });

  test("親フォルダの .codex/config.toml の model があれば印を付けない", () => {
    const s = setup();
    s.codex('model = "gpt-a"\n');
    const parent = path.dirname(s.cwd);
    fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
    fs.mkdirSync(path.join(parent, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(parent, ".codex", "config.toml"), 'model = "gpt-b"\n');
    expect(s.codexDefault(s.cwd)).toEqual({ id: null, reason: "none:project_config" });
  });
});
