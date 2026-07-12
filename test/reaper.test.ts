// reaper.test.ts — tmux セッション自動掃除判定の単体テスト
// 判定表: idle かつ timeout 超過 → kill / claude active はプロセス生存で bump 代行 /
// codex active は bump 停止(ts stale)= 死んだターンとして kill / 未採番は adopt。

import { describe, expect, test } from "vitest";
import { readHeartbeat, writeHeartbeat, listHeartbeatSessions } from "../src/heartbeat.js";
import {
  REAPER_IDLE_TIMEOUT_SECONDS,
  reaperTick,
} from "../src/reaper.js";
import { MockTmuxRunner, makeTempDir, makeTempStore, ok } from "./helpers.js";

const TIMEOUT = REAPER_IDLE_TIMEOUT_SECONDS;
const NOW = 1_000_000;

/** ls が指定セッションを返し、それ以外は成功空応答のモック。 */
function runnerWithSessions(
  live: string[],
  paneCommand = "node",
): MockTmuxRunner {
  return new MockTmuxRunner((args) => {
    if (args[0] === "ls") return ok(live.map((n) => `${n}\n`).join(""));
    if (args[0] === "display-message") return ok(`${paneCommand}\n`);
    return ok("");
  });
}

function killed(runner: MockTmuxRunner): string[] {
  return runner.recorded
    .filter((cmd) => cmd[0] === "kill-session")
    .map((cmd) => cmd[2]!)
    .sort();
}

describe("reaperTick", () => {
  test("idle かつ timeout 超過のセッションだけ kill し heartbeat も掃除する（旧 4.3）", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-old", "cs-fresh"]);
    writeHeartbeat(dir, "cs-old", { ts: NOW - TIMEOUT, state: "idle" });
    writeHeartbeat(dir, "cs-fresh", { ts: NOW - 10, state: "idle" });

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.killed).toEqual(["cs-old"]);
    expect(killed(runner)).toEqual(["cs-old"]);
    expect(readHeartbeat(dir, "cs-old")).toBeNull();
    expect(readHeartbeat(dir, "cs-fresh")).not.toBeNull();
  });

  test("未採番の生存セッションは「今を idle」で採番し kill しない（過去の残骸の回収）", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-orphaned"]);

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.killed).toEqual([]);
    expect(killed(runner)).toEqual([]);
    expect(readHeartbeat(dir, "cs-orphaned")).toEqual({ ts: NOW, state: "idle", event: "adopted" });

    // 次周期: timeout 経過後は通常ルールで kill される。
    const later = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW + TIMEOUT,
    });
    expect(later.killed).toEqual(["cs-orphaned"]);
  });

  test("tailii 以外の tmux セッションには一切触れない", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["main", "dev-server", "csx-notours"]);

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.liveCount).toBe(0);
    expect(killed(runner)).toEqual([]);
    expect(listHeartbeatSessions(dir)).toEqual([]);
  });

  test("claude の active はプロセス生存中なら bump 代行され kill されない（長い1ツール実行の保護）", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-busy"], "node");
    // hook の最終 heartbeat が timeout 超過 = 30 分超の1ツール呼びの最中。
    writeHeartbeat(dir, "cs-busy", { ts: NOW - TIMEOUT * 2, state: "active", event: "PreToolUse" });

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.killed).toEqual([]);
    expect(killed(runner)).toEqual([]);
    expect(readHeartbeat(dir, "cs-busy")).toEqual({
      ts: NOW,
      state: "active",
      event: "daemon-agent-alive",
    });
  });

  test("claude の active でもプロセスが死んでいれば idle へ降格し、timeout 後に kill される", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-crashed"], "zsh");
    writeHeartbeat(dir, "cs-crashed", { ts: NOW - TIMEOUT * 2, state: "active", event: "PreToolUse" });

    const first = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });
    // 即 kill はしない（30 分の猶予を与える）。
    expect(first.killed).toEqual([]);
    expect(readHeartbeat(dir, "cs-crashed")).toEqual({
      ts: NOW,
      state: "idle",
      event: "agent-process-dead",
    });

    const second = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW + TIMEOUT,
    });
    expect(second.killed).toEqual(["cs-crashed"]);
  });

  test("codex の active は bump 停止（ts stale）= 死んだターンとして kill、fresh なら生かす", async () => {
    const dir = makeTempDir("reaper");
    const store = makeTempStore();
    store.put({ name: "cs-cdx-dead", cwd: "/tmp/a", createdAt: 0, agent: "codex" });
    store.put({ name: "cs-cdx-live", cwd: "/tmp/b", createdAt: 0, agent: "codex" });
    const runner = runnerWithSessions(["cs-cdx-dead", "cs-cdx-live"], "node");
    // dead: engine ごと死んで bump が止まった active / live: engine tick が bump し続けている。
    writeHeartbeat(dir, "cs-cdx-dead", { ts: NOW - TIMEOUT, state: "active", event: "engine-tick" });
    writeHeartbeat(dir, "cs-cdx-live", { ts: NOW - 30, state: "active", event: "engine-tick" });

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    // codex に pane 生存チェックの bump 代行はしない（display-message を呼ばない）。
    expect(runner.recorded.some((cmd) => cmd[0] === "display-message")).toBe(false);
    expect(result.killed).toEqual(["cs-cdx-dead"]);
    expect(readHeartbeat(dir, "cs-cdx-live")?.ts).toBe(NOW - 30);
  });

  test("ターミナル attach 中のセッションは期限超過でも bump 保護される", async () => {
    const dir = makeTempDir("reaper");
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("cs-attached\ncs-detached\n");
      if (args[0] === "list-clients") return ok("cs-attached\n");
      if (args[0] === "display-message") return ok("zsh\n");
      return ok("");
    });
    writeHeartbeat(dir, "cs-attached", { ts: NOW - TIMEOUT * 2, state: "idle" });
    writeHeartbeat(dir, "cs-detached", { ts: NOW - TIMEOUT * 2, state: "idle" });

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.killed).toEqual(["cs-detached"]);
    expect(readHeartbeat(dir, "cs-attached")).toEqual({
      ts: NOW,
      state: "idle",
      event: "daemon-client-attached",
    });
  });

  test("生存セッションの無い heartbeat 残骸は掃除する", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-alive"]);
    writeHeartbeat(dir, "cs-alive", { ts: NOW, state: "idle" });
    writeHeartbeat(dir, "cs-gone", { ts: NOW, state: "idle" });

    await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(listHeartbeatSessions(dir)).toEqual(["cs-alive"]);
  });

  test("tmux サーバ不在は liveCount 0（daemon の自然終了条件）", async () => {
    const dir = makeTempDir("reaper");
    const runner = new MockTmuxRunner(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "no server running on /tmp/tmux-501/default",
    }));

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.liveCount).toBe(0);
    expect(result.killed).toEqual([]);
  });

  test("kill 失敗（既に不在等）でも heartbeat を掃除して継続する", async () => {
    const dir = makeTempDir("reaper");
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("cs-old\n");
      if (args[0] === "kill-session") return { exitCode: 1, stdout: "", stderr: "can't find session" };
      return ok("");
    });
    writeHeartbeat(dir, "cs-old", { ts: NOW - TIMEOUT, state: "idle" });

    const result = await reaperTick({
      runner: runner.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.killed).toEqual(["cs-old"]);
    expect(readHeartbeat(dir, "cs-old")).toBeNull();
  });
});
