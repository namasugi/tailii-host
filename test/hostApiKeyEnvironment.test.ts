import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApiKeyEnvironmentResolver, readLoginShellApiEnvironment } from "../src/services/hostApiKeyEnvironment.js";

const directories: string[] = [];
const key = "sk-proj-shell-test-only-not-a-live-secret";
function shellHome(contents: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "tailii-api-env-")); directories.push(home);
  const zsh = existsSync("/bin/zsh");
  writeFileSync(join(home, zsh ? ".zshrc" : ".bash_profile"), contents);
  return { HOME: home, ZDOTDIR: home, SHELL: zsh ? "/bin/zsh" : "/bin/bash", PATH: "/usr/bin:/bin" };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("SSH / QUIC engine のAPI用シェル環境補完", () => {
  it("非継承のexportを対話ログイン設定から必要な名前だけ読み、起動時の出力を返さない", async () => {
    const env = shellHome(`printf 'startup noise\\n'\nprintf 'private diagnostic\\n' >&2\nexport OPENAI_API_KEY='${key}'\nexport TEAM_API_KEY='${key}'\nexport UNRELATED_SECRET='test-only-unrequested'\nUNEXPORTED_KEY='test-only-unexported'\n`);
    const result = await readLoginShellApiEnvironment(["OPENAI_API_KEY", "TEAM_API_KEY", "UNEXPORTED_KEY", "MISSING"], { env });
    expect(result).toEqual({ OPENAI_API_KEY: key, TEAM_API_KEY: key });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("起動設定が止まっても上限時間で終了し、部分出力やエラー本文を採用しない", async () => {
    const env = shellHome(`printf 'partial sensitive test output'\nsleep 30\nexport OPENAI_API_KEY='${key}'\n`);
    const started = Date.now();
    expect(await readLoginShellApiEnvironment(["OPENAI_API_KEY"], { env, timeoutMs: 100 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("大量の起動時出力・異常終了・不正なシェル名では値を採用しない", async () => {
    for (const contents of ["printf '%140000s' x\n", "exit 7\n"]) {
      const env = shellHome(contents + `export OPENAI_API_KEY='${key}'\n`);
      expect(await readLoginShellApiEnvironment(["OPENAI_API_KEY"], { env })).toEqual({});
    }
    expect(await readLoginShellApiEnvironment(["OPENAI_API_KEY"], { env: { SHELL: "/bin/not-a-shell" } })).toEqual({});
  });

  it("継承済みの値と意図した空値を優先し、不正な変数名を実行しない", async () => {
    const env = { OPENAI_API_KEY: key, TEAM_KEY: "" };
    const read = vi.fn();
    const resolve = createHostApiKeyEnvironmentResolver({ env, read });
    expect(await resolve(["OPENAI_API_KEY", "TEAM_KEY", "$(printenv)"])).toEqual(env);
    expect(read).not.toHaveBeenCalled();
  });

  it("同時要求を一度の照会にまとめ、更新期限後には設定変更・削除を反映する", async () => {
    let time = 100, shellValue: string | undefined = key;
    const env: NodeJS.ProcessEnv = {};
    const read = vi.fn(async (names: readonly string[]) => Object.fromEntries(names.flatMap((name) => shellValue === undefined ? [] : [[name, shellValue]])));
    const resolve = createHostApiKeyEnvironmentResolver({ env, read, now: () => time, cacheMs: 50 });
    const [openai, claude] = await Promise.all([resolve(["OPENAI_API_KEY"]), resolve(["ANTHROPIC_API_KEY"])]);
    expect(openai.OPENAI_API_KEY).toBe(key); expect(claude.ANTHROPIC_API_KEY).toBe(key);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    await resolve(["OPENAI_API_KEY"]); expect(read).toHaveBeenCalledOnce();
    env.OPENAI_API_KEY = "inherited-test-value";
    expect((await resolve(["OPENAI_API_KEY"])).OPENAI_API_KEY).toBe("inherited-test-value");
    delete env.OPENAI_API_KEY; time += 51; shellValue = undefined;
    expect((await resolve(["OPENAI_API_KEY"])).OPENAI_API_KEY).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    expect(env).toEqual({});
  });

  it("失敗を短時間共有し、次の照会で復旧できる。例外や要求外の変数は返さない", async () => {
    let time = 0;
    const read = vi.fn().mockRejectedValueOnce(new Error("test-only-sensitive-error"))
      .mockResolvedValue({ OPENAI_API_KEY: key, OTHER_KEY: "test-only-unrequested" });
    const resolve = createHostApiKeyEnvironmentResolver({ env: {}, read, now: () => time });
    expect(await resolve(["OPENAI_API_KEY"])).toEqual({});
    expect(await resolve(["OPENAI_API_KEY"])).toEqual({});
    expect(read).toHaveBeenCalledOnce();
    time = 5_001;
    expect(await resolve(["OPENAI_API_KEY"])).toEqual({ OPENAI_API_KEY: key });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
