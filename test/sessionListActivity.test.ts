// sessionListActivity.test.ts
// tmux の per-session `#{session_activity}` を updatedAt(Unix 秒)に反映し、同一 cwd でも
// セッション個別の最終活動時刻で整列することの回帰テスト（session-list ordering fix）。
// 従来は updatedAt を cwd 単位（共有トランスクリプト mtime）で解決していたため、同じ作業
// ディレクトリの全セッションが同値になり最近使用順が壊れ、最新セッションが一覧から埋もれた。
import { describe, expect, test } from "vitest";
import { SessionListService } from "../src/sessionListService.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { MockTmuxRunner, makeTempStore, ok } from "./helpers.js";

describe("session list activity ordering", () => {
  // 同一 cwd の3セッション。tmux 活動時刻はバラバラ。
  function makeManager(lsOutput: string): TmuxSessionManager {
    const store = makeTempStore();
    for (const name of ["cs-a", "cs-b", "cs-c"]) {
      store.put({ name, cwd: "/same/project", createdAt: 0 });
    }
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok(lsOutput) : ok("")));
    return new TmuxSessionManager({ runner: runner.runner, store });
  }

  test("list() は #{session_activity} を updatedAt(秒) に反映する", async () => {
    const mgr = makeManager("cs-a 300\ncs-b 100\ncs-c 200\n");
    const infos = await mgr.list();
    const byName = Object.fromEntries(infos.map((i) => [i.name, i.updatedAt]));
    expect(byName["cs-a"]).toBe(300);
    expect(byName["cs-b"]).toBe(100);
    expect(byName["cs-c"]).toBe(200);
  });

  test("同一 cwd でも tmux 活動時刻で整列（provider の共有値に依存しない）", async () => {
    const mgr = makeManager("cs-a 300\ncs-b 100\ncs-c 200\n");
    // provider は全セッション同値を返す“バグ再現”。tmux 由来が優先されるべき。
    const service = new SessionListService(mgr, () => 999);
    const page = await service.page(10, undefined);
    expect(page.sessions.map((s) => s.name)).toEqual(["cs-a", "cs-c", "cs-b"]); // 300,200,100 desc
  });

  test("活動時刻が無い出力（name のみ）は provider にフォールバック", async () => {
    const mgr = makeManager("cs-a\ncs-b\ncs-c\n");
    const activity: Record<string, number> = { "cs-a": 10, "cs-b": 20, "cs-c": 30 };
    const service = new SessionListService(mgr, (info) => activity[info.name] ?? null);
    const page = await service.page(10, undefined);
    expect(page.sessions.map((s) => s.name)).toEqual(["cs-c", "cs-b", "cs-a"]); // 30,20,10 desc via provider
  });
});
