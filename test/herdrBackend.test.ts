// herdrBackend.test.ts — herdr backend（HerdrSessionManager / sessionBackend / launch herdr 経路）
// 実 herdr は起動しない（モックランナー / モック ProcessRunner）。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  HerdrFailedError,
  HerdrSessionManager,
  parseHerdrForegroundCommand,
  parseHerdrPaneList,
  parseHerdrStartedPaneId,
  type HerdrCommandResult,
  type HerdrCommandRunner,
} from "../src/herdr.js";
import { launchCore, type ProcessRunner } from "../src/launch.js";
import {
  CompositeSessionBackend,
  makeBackendForSession,
  makeSessionBackend,
  resolveSessionBackendKind,
} from "../src/sessionBackend.js";
import { SessionMetadataStore } from "../src/sessionMetadataStore.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { makeTempDir, ok } from "./helpers.js";

/** 記録付きモック herdr ランナー。 */
class MockHerdrRunner {
  readonly recorded: string[][] = [];
  constructor(private readonly handler: (args: string[]) => HerdrCommandResult) {}

  get runner(): HerdrCommandRunner {
    return async (args) => {
      this.recorded.push(args);
      return this.handler(args);
    };
  }
}

function herdrOk(stdout: string): HerdrCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/** herdr `pane list` の JSON stdout を組み立てる。 */
function paneListJson(panes: { pane_id: string; label?: string }[]): string {
  return JSON.stringify({ id: "cli:pane:list", result: { type: "pane_list", panes } });
}

/** herdr `pane process-info` の JSON stdout を組み立てる。 */
function processInfoJson(name: string): string {
  return JSON.stringify({
    id: "cli:pane:process_info",
    result: {
      type: "pane_process_info",
      process_info: { pane_id: "w9:p1", shell_pid: 1, foreground_processes: [{ name, pid: 1 }] },
    },
  });
}

function makeStore(): SessionMetadataStore {
  return new SessionMetadataStore(makeTempDir("herdr-backend-store"));
}

describe("resolveSessionBackendKind", () => {
  test("不在/不正は tmux、`herdr`（大文字・空白許容）は herdr", () => {
    const dir = makeTempDir("backend-kind");
    const file = path.join(dir, "backend");
    expect(resolveSessionBackendKind(file)).toBe("tmux");
    fs.writeFileSync(file, "garbage\n");
    expect(resolveSessionBackendKind(file)).toBe("tmux");
    fs.writeFileSync(file, " HERDR \n");
    expect(resolveSessionBackendKind(file)).toBe("herdr");
    fs.writeFileSync(file, "tmux\n");
    expect(resolveSessionBackendKind(file)).toBe("tmux");
  });
});

describe("SessionMetadataStore backend 欄", () => {
  test("backend / herdrPaneId を往復し、不正 pane ID は落とす", () => {
    const store = makeStore();
    store.put({ name: "s-h", cwd: "/tmp", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    expect(store.get("s-h")).toEqual({
      name: "s-h", cwd: "/tmp", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2",
    });
    // 手書き等で壊れた pane ID は decode で落とす（backend は残る）。
    const file = path.join((store as unknown as { base: string })["base"], "s-bad.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ name: "s-bad", cwd: "/tmp", createdAt: 2, backend: "herdr", herdrPaneId: "%5" }),
    );
    expect(store.get("s-bad")).toEqual({ name: "s-bad", cwd: "/tmp", createdAt: 2, backend: "herdr" });
  });
});

describe("herdr JSON パーサ", () => {
  test("pane list / agent start / process-info を読める", () => {
    expect(parseHerdrPaneList(paneListJson([{ pane_id: "w4:p2", label: "s-a" }, { pane_id: "w4:p3" }])))
      .toEqual([{ paneId: "w4:p2", label: "s-a" }, { paneId: "w4:p3", label: null }]);
    expect(parseHerdrPaneList("not json")).toEqual([]);
    expect(
      parseHerdrStartedPaneId(
        JSON.stringify({ result: { type: "agent_started", agent: { pane_id: "w4:p2" } } }),
      ),
    ).toBe("w4:p2");
    expect(parseHerdrForegroundCommand(processInfoJson("claude"))).toBe("claude");
    expect(parseHerdrForegroundCommand("{}")).toBe("");
  });
});

describe("HerdrSessionManager", () => {
  test("list は herdr メタだけを列挙し、pane ID/label 一致で alive を判定する", async () => {
    const store = makeStore();
    store.put({ name: "s-live", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    store.put({ name: "s-dead", cwd: "/b", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p9" });
    store.put({ name: "s-label", cwd: "/c", createdAt: 3, backend: "herdr" });
    store.put({ name: "s-tmux", cwd: "/d", createdAt: 4 }); // tmux メタは列挙しない
    const runner = new MockHerdrRunner(() =>
      herdrOk(paneListJson([{ pane_id: "w4:p2" }, { pane_id: "w4:p5", label: "s-label" }])),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    const infos = await manager.list();
    expect(infos.map((info) => [info.name, info.alive])).toEqual([
      ["s-dead", false],
      ["s-label", true],
      ["s-live", true],
    ]);
  });

  test("list は herdr server 不通（非0 exit）で全員 alive:false に倒す", async () => {
    const store = makeStore();
    store.put({ name: "s-x", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner(() => ({ exitCode: 1, stdout: "", stderr: "connect error" }));
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    expect((await manager.list()).map((info) => info.alive)).toEqual([false]);
  });

  test("sendKeys: literal はテキスト、既知キーは send-keys、BTab は生シーケンス、数字はテキスト", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) =>
      args[0] === "pane" && args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : herdrOk(""),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    await manager.sendKeys("s-a", ["hello world"], true);
    await manager.sendKeys("s-a", ["Enter"]);
    await manager.sendKeys("s-a", ["BTab"]);
    await manager.sendKeys("s-a", ["1"]);
    const sends = runner.recorded.filter((args) => args[1]?.startsWith("send-"));
    expect(sends).toEqual([
      ["pane", "send-text", "w4:p2", "hello world"],
      ["pane", "send-keys", "w4:p2", "Enter"],
      ["pane", "send-text", "w4:p2", "\u001b[Z"],
      ["pane", "send-text", "w4:p2", "1"],
    ]);
  });

  test("capturePane: joinWrappedLines は recent-unwrapped、空なら visible 末尾へフォールバック", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const visibleBody = ["l1", "l2", "l3", "l4", "", ""].join("\n");
    const runner = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      if (args.includes("recent-unwrapped")) return herdrOk("");
      if (args.includes("visible")) return herdrOk(visibleBody);
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    // recent が空 → visible の末尾 N 行（末尾空行は削る）。
    expect(await manager.capturePane("s-a", { lines: 2, joinWrappedLines: true })).toBe("l3\nl4");
    // 非 join は最初から visible。
    expect(await manager.capturePane("s-a", { lines: 3 })).toBe("l2\nl3\nl4");
    // recent に中身があればそのまま採用。
    const runner2 = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      if (args.includes("recent-unwrapped")) return herdrOk("recent-tail\n");
      return herdrOk(visibleBody);
    });
    const manager2 = new HerdrSessionManager({ runner: runner2.runner, store });
    expect(await manager2.capturePane("s-a", { lines: 2, joinWrappedLines: true })).toBe("recent-tail");
  });

  test("agentProcessAlive: claude は生存、シェルは死亡、herdr 失敗は安全側 true", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const make = (result: HerdrCommandResult): HerdrSessionManager =>
      new HerdrSessionManager({
        runner: new MockHerdrRunner((args) =>
          args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : result,
        ).runner,
        store,
      });
    expect(await make(herdrOk(processInfoJson("claude"))).agentProcessAlive("s-a")).toBe(true);
    expect(await make(herdrOk(processInfoJson("zsh"))).agentProcessAlive("s-a")).toBe(false);
    expect(await make({ exitCode: 1, stdout: "", stderr: "x" }).agentProcessAlive("s-a")).toBe(true);
  });

  test("reattach: pane 不在は session_not_found、シェル化 pane は掃除して再起動導線へ", async () => {
    const store = makeStore();
    store.put({ name: "s-gone", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p9" });
    store.put({ name: "s-stale", cwd: "/b", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2", label: "s-stale" }]));
      if (args[1] === "process-info") return herdrOk(processInfoJson("zsh"));
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });

    const gone = await manager.reattach("s-gone");
    expect(gone.kind).toBe("notFound");

    const stale = await manager.reattach("s-stale");
    expect(stale.kind).toBe("notFound");
    expect(runner.recorded).toContainEqual(["pane", "close", "w4:p2"]);
  });

  test("reattach: 生存 claude は attached で末尾出力を返す", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/work", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      if (args[1] === "process-info") return herdrOk(processInfoJson("claude"));
      if (args[1] === "read") return herdrOk("recent output\n");
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    const result = await manager.reattach("s-a");
    expect(result).toEqual({
      kind: "attached",
      info: { name: "s-a", cwd: "/work", alive: true },
      recentOutput: "recent output",
    });
  });

  test("kill: 記録済み pane を閉じる。pane 不在は HerdrFailedError", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) =>
      args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : herdrOk(""),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    await manager.kill("s-a");
    expect(runner.recorded).toContainEqual(["pane", "close", "w4:p2"]);

    const emptyRunner = new MockHerdrRunner(() => herdrOk(paneListJson([])));
    const manager2 = new HerdrSessionManager({ runner: emptyRunner.runner, store });
    await expect(manager2.kill("s-a")).rejects.toBeInstanceOf(HerdrFailedError);
  });
});

describe("CompositeSessionBackend", () => {
  test("メタの backend 欄で tmux / herdr へルーティングし、list は和になる", async () => {
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1, tmuxPaneId: "%1" });
    store.put({ name: "s-h", cwd: "/h", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p2" });
    const tmuxRunner: string[][] = [];
    const tmux = new TmuxSessionManager({
      runner: async (args) => {
        tmuxRunner.push(args);
        return args[0] === "ls" ? ok("s-t\n") : ok("");
      },
      store,
    });
    const herdrRunner = new MockHerdrRunner((args) =>
      args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : herdrOk(""),
    );
    const herdr = new HerdrSessionManager({ runner: herdrRunner.runner, store });
    const composite = new CompositeSessionBackend({ tmux, herdr, store });

    const infos = await composite.list();
    expect(infos.map((info) => [info.name, info.alive])).toEqual([
      ["s-h", true],
      ["s-t", true],
    ]);

    // send は各 backend へルーティング（tmux 側は send-keys、herdr 側は pane send-text）。
    await composite.sendKeys("s-t", ["Enter"]);
    expect(tmuxRunner.some((args) => args[0] === "send-keys")).toBe(true);
    await composite.sendKeys("s-h", ["x"], true);
    expect(herdrRunner.recorded).toContainEqual(["pane", "send-text", "w4:p2", "x"]);
  });

  test("makeSessionBackend: tmux 設定は素の TmuxSessionManager、herdr 設定は Composite", () => {
    const store = makeStore();
    expect(makeSessionBackend({ kind: "tmux", store })).toBeInstanceOf(TmuxSessionManager);
    expect(makeSessionBackend({ kind: "herdr", store })).toBeInstanceOf(CompositeSessionBackend);
  });

  test("makeBackendForSession はメタの backend 欄で実装を選ぶ", () => {
    const store = makeStore();
    store.put({ name: "s-h", cwd: "/h", createdAt: 1, backend: "herdr" });
    store.put({ name: "s-t", cwd: "/t", createdAt: 2 });
    expect(makeBackendForSession("s-h", store)).toBeInstanceOf(HerdrSessionManager);
    expect(makeBackendForSession("s-t", store)).toBeInstanceOf(TmuxSessionManager);
    expect(makeBackendForSession("s-none", store)).toBeInstanceOf(TmuxSessionManager);
  });
});

describe("TmuxSessionManager と herdr メタの分離", () => {
  test("tmux list は backend=herdr のメタを列挙しない", async () => {
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1 });
    store.put({ name: "s-h", cwd: "/h", createdAt: 2, backend: "herdr" });
    const manager = new TmuxSessionManager({
      runner: async (args) => (args[0] === "ls" ? ok("") : ok("")),
      store,
    });
    expect((await manager.list()).map((info) => info.name)).toEqual(["s-t"]);
  });
});

describe("launchCore herdr backend", () => {
  /** herdr 呼び出しを記録するモック ProcessRunner。 */
  function herdrProcessRunner(overrides?: {
    panes?: { pane_id: string; label?: string }[];
    processName?: string;
  }): { runner: ProcessRunner; recorded: { exe: string; args: string[] }[] } {
    const recorded: { exe: string; args: string[] }[] = [];
    const runner: ProcessRunner = async (exe, args) => {
      recorded.push({ exe, args });
      if (args[0] === "pane" && args[1] === "list") {
        return { exitCode: 0, stdout: paneListJson(overrides?.panes ?? []) };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return { exitCode: 0, stdout: processInfoJson(overrides?.processName ?? "claude") };
      }
      if (args[0] === "workspace" && args[1] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            result: { type: "workspace_list", workspaces: [{ workspace_id: "w9", label: "tailii" }] },
          }),
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: { type: "agent_started", agent: { pane_id: "w9:p7" } } }),
        };
      }
      return { exitCode: 0, stdout: "" };
    };
    return { runner, recorded };
  }

  function launchOptions(dir: string, store: SessionMetadataStore, runner: ProcessRunner) {
    return {
      dir,
      session: "s-h",
      baseDir: null,
      binaryPath: "/usr/local/bin/tailii",
      tmuxPath: "/opt/homebrew/bin/tmux",
      herdrPath: "/Users/x/.local/bin/herdr",
      backend: "herdr" as const,
      innerCommand: "sleep 300",
      path: "/usr/bin:/bin",
      store,
      now: () => 42,
      errorSink: () => {},
      runner,
      claudeJsonPath: path.join(makeTempDir("herdr-launch-claudejson"), ".claude.json"),
      hookGlobalMarkerPath: path.join(dir, "no-such-marker"),
    };
  }

  test("agent start で起動し backend/herdrPaneId をメタへ権威記録する", async () => {
    const dir = makeTempDir("herdr-launch");
    const store = makeStore();
    const { runner, recorded } = herdrProcessRunner();

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);

    // tmux は一切呼ばない（すべて herdrPath 宛て）。
    expect(recorded.every((call) => call.exe === "/Users/x/.local/bin/herdr")).toBe(true);
    const start = recorded.find((call) => call.args[0] === "agent" && call.args[1] === "start");
    expect(start?.args.slice(2, 5)).toEqual(["s-h", "--cwd", dir]);
    expect(start?.args).toContain("--no-focus");
    expect(start?.args.join(" ")).toContain("--env PATH=/usr/bin:/bin");
    // inner は zsh -lc へそのまま渡す（--settings 合成込み）。
    const dashDash = start!.args.indexOf("--");
    expect(start!.args.slice(dashDash + 1, dashDash + 3)).toEqual(["/bin/zsh", "-lc"]);
    expect(start!.args[dashDash + 3]).toMatch(/^sleep 300 --settings /);
    // 専用タブへ分離。
    expect(recorded.some((call) => call.args[0] === "pane" && call.args[1] === "move")).toBe(true);

    expect(store.get("s-h")).toEqual({
      name: "s-h",
      cwd: dir,
      createdAt: 42,
      backend: "herdr",
      herdrPaneId: "w9:p7",
    });
  });

  test("生存 pane があれば再起動せずメタだけ更新する", async () => {
    const dir = makeTempDir("herdr-launch-live");
    const store = makeStore();
    store.put({ name: "s-h", cwd: dir, createdAt: 1, backend: "herdr", herdrPaneId: "w9:p7" });
    const { runner, recorded } = herdrProcessRunner({
      panes: [{ pane_id: "w9:p7", label: "s-h" }],
      processName: "claude",
    });

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);
    expect(recorded.some((call) => call.args[1] === "start")).toBe(false);
    expect(store.get("s-h")?.herdrPaneId).toBe("w9:p7");
  });

  test("claude が終了しシェル化した pane は閉じて作り直す", async () => {
    const dir = makeTempDir("herdr-launch-stale");
    const store = makeStore();
    store.put({ name: "s-h", cwd: dir, createdAt: 1, backend: "herdr", herdrPaneId: "w9:p1" });
    const { runner, recorded } = herdrProcessRunner({
      panes: [{ pane_id: "w9:p1", label: "s-h" }],
      processName: "zsh",
    });

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);
    expect(recorded).toContainEqual(
      expect.objectContaining({ args: ["pane", "close", "w9:p1"] }),
    );
    expect(recorded.some((call) => call.args[1] === "start")).toBe(true);
    expect(store.get("s-h")?.herdrPaneId).toBe("w9:p7");
  });

  test("workspace 不在なら作成してから起動する", async () => {
    const dir = makeTempDir("herdr-launch-ws");
    const store = makeStore();
    const recorded: { exe: string; args: string[] }[] = [];
    const runner: ProcessRunner = async (exe, args) => {
      recorded.push({ exe, args });
      if (args[0] === "pane" && args[1] === "list") return { exitCode: 0, stdout: paneListJson([]) };
      if (args[0] === "workspace" && args[1] === "list") {
        return { exitCode: 0, stdout: JSON.stringify({ result: { workspaces: [] } }) };
      }
      if (args[0] === "workspace" && args[1] === "create") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: { workspace: { workspace_id: "w10" } } }),
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: { agent: { pane_id: "w10:p2" } } }),
        };
      }
      return { exitCode: 0, stdout: "" };
    };

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);
    const createIdx = recorded.findIndex((call) => call.args[1] === "create");
    const startIdx = recorded.findIndex((call) => call.args[1] === "start");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(createIdx);
    const start = recorded[startIdx]!;
    expect(start.args).toContain("--workspace");
    expect(start.args[start.args.indexOf("--workspace") + 1]).toBe("w10");
  });

  test("agent start 失敗は非0で返しメタを書かない", async () => {
    const dir = makeTempDir("herdr-launch-fail");
    const store = makeStore();
    const runner: ProcessRunner = async (_exe, args) => {
      if (args[0] === "pane" && args[1] === "list") return { exitCode: 0, stdout: paneListJson([]) };
      if (args[0] === "agent" && args[1] === "start") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "{}" };
    };
    expect(await launchCore(launchOptions(dir, store, runner))).toBe(1);
    expect(store.get("s-h")).toBeNull();
  });
});
