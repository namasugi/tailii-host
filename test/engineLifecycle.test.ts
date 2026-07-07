// engineLifecycle.test.ts — Engine アイドルライフサイクル / ページング結線テスト
// Swift 版 EngineLifecycleTests.swift の移植（session-list-lifecycle 2.3/3.3）。

import { describe, expect, test } from "vitest";
import type { EngineLauncher } from "../src/launch.js";
import { decodeControlMessage } from "../src/protocol.js";
import { SessionIdleTracker } from "../src/sessionIdleTracker.js";
import { SessionListService } from "../src/sessionListService.js";
import { TmuxSessionManager } from "../src/tmux.js";
import {
  MockTmuxRunner,
  makeTempDir,
  makeTempStore,
  ok,
  startEngine,
  waitForCommand,
} from "./helpers.js";

// 更新時刻を全て未解決（null）にする provider → 並びは名前昇順で決定的。
const unresolvedProvider = (): null => null;

describe("Engine — アイドルライフサイクル/ページング", () => {
  // MARK: 1. ページング応答

  test("session_list_request(limit) にページ応答（nextCursor 付き）を返す（2.1〜2.4）", async () => {
    const store = makeTempStore();
    const names = Array.from({ length: 7 }, (_, i) => `s${i + 1}`);
    for (const n of names) store.put({ name: n, cwd: `/tmp/${n}`, createdAt: 0 });
    const live = names.join("\n") + "\n";
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok(live) : ok("")));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    const service = new SessionListService(mgr, unresolvedProvider);

    const engine = startEngine({
      sessionManager: mgr,
      sessionListService: service,
      metadataStore: store,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"P1","limit":5,"type":"session_list_request","v":1}');
    const line = await engine.lines.nextOfType("session_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "session_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.id).toBe("P1");
    expect(msg.sessions).toHaveLength(5);
    expect(msg.sessions.map((s) => s.name)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(msg.nextCursor).toBeDefined();

    await engine.teardown();
  });

  // MARK: 2. idle_hint 記録

  test("session_idle_hint で tracker にアイドル起点が記録される（4.2）", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    // 大きな timeout・大きな reaper 間隔で「記録のみ」を観測（kill させない）。
    const tracker = new SessionIdleTracker(100_000);

    const engine = startEngine({
      sessionManager: mgr,
      idleTracker: tracker,
      reaperCheckIntervalSeconds: 3600,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"H1","name":"work","type":"session_idle_hint","v":1}');

    let recorded = false;
    for (let i = 0; i < 200; i += 1) {
      if (JSON.stringify(tracker.idleNames()) === JSON.stringify(["work"])) {
        recorded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(recorded).toBe(true);

    await engine.teardown();
  });

  // MARK: 3. reattach 生存 → 即 attached

  test("生存 session_reattach は即 attached 応答（4.4）", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 0 });
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("work\n");
      if (args[0] === "capture-pane") return ok("hi\n");
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    const resumeCalls: string[][] = [];
    const resume: EngineLauncher = async (cwd, name) => {
      resumeCalls.push([cwd, name]);
      return { exitCode: 0, errorText: "" };
    };

    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      idleTracker: new SessionIdleTracker(100_000),
      resumeLauncher: resume,
      reaperCheckIntervalSeconds: 3600,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"R1","name":"work","type":"session_reattach","v":1}');
    const line = await engine.lines.nextOfType("session_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "session_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.id).toBe("R1");
    expect(msg.sessions.map((s) => s.name)).toEqual(["work"]);
    expect(resumeCalls).toEqual([]);

    await engine.teardown();
  });

  // MARK: 4. reattach メタあり tmux 不在 → resume 再起動

  test("メタあり・tmux 不在の reattach は resume 再起動して attached（4.6）", async () => {
    const store = makeTempStore();
    store.put({ name: "resumed", cwd: "/tmp/resumed", createdAt: 0 });
    // tmux は空（kill 済み = 不在）。
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    const resumeCalls: { cwd: string; name: string }[] = [];
    const resume: EngineLauncher = async (cwd, name) => {
      resumeCalls.push({ cwd, name });
      return { exitCode: 0, errorText: "" };
    };

    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      idleTracker: new SessionIdleTracker(100_000),
      resumeLauncher: resume,
      reaperCheckIntervalSeconds: 3600,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"R2","name":"resumed","type":"session_reattach","v":1}');
    const line = await engine.lines.nextOfType("session_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "session_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.id).toBe("R2");
    expect(msg.sessions).toEqual([{ name: "resumed", cwd: "/tmp/resumed", alive: true }]);
    expect(resumeCalls.map((c) => c.name)).toEqual(["resumed"]);
    expect(resumeCalls[0]?.cwd).toBe("/tmp/resumed");

    await engine.teardown();
  });

  // MARK: 5. reattach メタ無し → not_found

  test("メタ無しの reattach は error(session_not_found)（従来挙動維持）", async () => {
    const store = makeTempStore(); // 空（メタ無し）
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    const resumeCalls: string[] = [];
    const resume: EngineLauncher = async (_cwd, name) => {
      resumeCalls.push(name);
      return { exitCode: 0, errorText: "" };
    };

    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      idleTracker: new SessionIdleTracker(100_000),
      resumeLauncher: resume,
      reaperCheckIntervalSeconds: 3600,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"R3","name":"ghost","type":"session_reattach","v":1}');
    const line = await engine.lines.nextOfType("error");
    const msg = decodeControlMessage(line);
    if (msg.type !== "error") throw new Error(`error 型でない: ${msg.type}`);
    expect(msg.code).toBe("session_not_found");
    expect(resumeCalls).toEqual([]);

    await engine.teardown();
  });

  // MARK: 6. reaper 経由の timeout kill

  test("idle_hint 後、timeout 到達で reaper が当該のみ kill する（4.3）", async () => {
    const store = makeTempStore();
    store.put({ name: "idle1", cwd: "/tmp/idle1", createdAt: 0 });
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    // timeout 0 → idle_hint 直後に期限切れ。短い reaper 間隔で速やかに kill。
    const tracker = new SessionIdleTracker(0);

    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      idleTracker: tracker,
      reaperCheckIntervalSeconds: 0.02,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"H2","name":"idle1","type":"session_idle_hint","v":1}');

    expect(await waitForCommand(runner, ["kill-session", "-t", "idle1"])).toBe(true);

    await engine.teardown();
  });

  // MARK: 追加: usage_request（planUsage 注入・ネットワーク非依存）

  test("usage_request に usage_response を返す（plan 系は注入値を反映）", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({
      sessionManager: mgr,
      planUsage: async () => ({
        fiveHourUtilization: 23,
        fiveHourResetsAt: "2026-07-06T12:00:00Z",
        sevenDayUtilization: 65,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
      }),
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"U1","type":"usage_request","v":1}');
    const line = await engine.lines.nextOfType("usage_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "usage_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.id).toBe("U1");
    expect(msg.inputTokens).toBe(0);
    expect(msg.turns).toBe(0);
    expect(msg.fiveHourUtilization).toBe(23);
    expect(msg.fiveHourResetsAt).toBe("2026-07-06T12:00:00Z");
    expect(msg.sevenDayUtilization).toBe(65);
    expect(msg.sevenDayResetsAt).toBeUndefined();
    expect(msg.sevenDayFableUtilization).toBeUndefined();

    await engine.teardown();
  });

  test("codex tail 中の usage_request は Claude プラン使用量を混ぜない（agent で分岐）", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    // 既定エージェントを codex にする（tail 未 open でも currentAgent は codex 相当に倒れる）。
    // planUsage を注入していても、codex 会話には Claude の OAuth プラン使用量を出してはいけない。
    const engine = startEngine({
      sessionManager: mgr,
      agent: "codex",
      planUsage: async () => ({
        fiveHourUtilization: 23,
        fiveHourResetsAt: "2026-07-06T12:00:00Z",
        sevenDayUtilization: 65,
        sevenDayResetsAt: null,
        sevenDayFableUtilization: null,
        sevenDayFableResetsAt: null,
      }),
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"U2","type":"usage_request","v":1}');
    const line = await engine.lines.nextOfType("usage_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "usage_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.id).toBe("U2");
    // codex 分岐: トークンは空集計、Claude プラン使用量（fiveHour/Fable）は一切載らない。
    expect(msg.inputTokens).toBe(0);
    expect(msg.fiveHourUtilization).toBeUndefined();
    expect(msg.sevenDayUtilization).toBeUndefined();
    expect(msg.sevenDayFableUtilization).toBeUndefined();

    await engine.teardown();
  });

  // MARK: 追加: mode_get / mode_set（pane 表示判定 + BTab 注入）

  test("mode_get は pane 末尾のモードマーカーから現在モードを返す", async () => {
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") return ok("会話本文\n⏸ plan mode on (shift+tab to cycle)\n");
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({ sessionManager: mgr });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M1","session":"work","type":"mode_get","v":1}');
    const resp = await engine.lines.nextOfType("mode_set_response");
    expect(resp).toContain('"id":"M1"');
    expect(resp).toContain('"mode":"plan"');

    await engine.teardown();
  });

  test("mode_set は目標モードまで BTab を注入し、実モードを返す", async () => {
    // capture-pane が呼ばれるたびにモードが1段進む TUI を模す（default → acceptEdits → plan）。
    const panes = [
      "? for shortcuts\n",
      "⏵⏵ accept edits on (shift+tab to cycle)\n",
      "⏸ plan mode on (shift+tab to cycle)\n",
    ];
    let captureCount = 0;
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") {
        const pane = panes[Math.min(captureCount, panes.length - 1)]!;
        captureCount += 1;
        return ok(pane);
      }
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({
      sessionManager: mgr,
      modeTiming: { setChangePollMs: 1, setChangeTimeoutMs: 20 },
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M2","mode":"plan","session":"work","type":"mode_set","v":1}');
    const resp = await engine.lines.nextOfType("mode_set_response");
    expect(resp).toContain('"id":"M2"');
    expect(resp).toContain('"mode":"plan"');
    const btabCount = runner.recorded.filter(
      (cmd) => JSON.stringify(cmd) === JSON.stringify(["send-keys", "-t", "work", "BTab"]),
    ).length;
    expect(btabCount).toBe(2);

    await engine.teardown();
  });

  test("mode_set はダイアログが閉じてマーカーが出るまで待って成功する", async () => {
    const panes = [
      "Enter to confirm · Esc to cancel\n",
      "Enter to select · ↑/↓ to navigate · Esc to cancel\n",
      "⏸ plan mode on (shift+tab to cycle)\n",
    ];
    let captureCount = 0;
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") {
        const pane = panes[Math.min(captureCount, panes.length - 1)]!;
        captureCount += 1;
        return ok(pane);
      }
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({
      sessionManager: mgr,
      modeTiming: { setInitialPollMs: 1, setInitialTimeoutMs: 50 },
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M3","mode":"plan","session":"work","type":"mode_set","v":1}');
    const resp = await engine.lines.nextOfType("mode_set_response");
    expect(resp).toContain('"id":"M3"');
    expect(resp).toContain('"mode":"plan"');
    const btabCount = runner.recorded.filter(
      (cmd) => JSON.stringify(cmd) === JSON.stringify(["send-keys", "-t", "work", "BTab"]),
    ).length;
    expect(btabCount).toBe(0);

    await engine.teardown();
  });

  test("mode_set はダイアログが続くと mode_unavailable を返す", async () => {
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") return ok("Enter to confirm · Esc to cancel\n");
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({
      sessionManager: mgr,
      modeTiming: { setInitialPollMs: 1, setInitialTimeoutMs: 10 },
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M4","mode":"plan","session":"work","type":"mode_set","v":1}');
    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"id":"M4"');
    expect(err).toContain('"code":"mode_unavailable"');

    await engine.teardown();
  });

  test("mode_set は BTab が飲まれて変化しない場合に実モードを返す", async () => {
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") return ok("? for shortcuts\n");
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({
      sessionManager: mgr,
      modeTiming: { setChangePollMs: 1, setChangeTimeoutMs: 10 },
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M5","mode":"plan","session":"work","type":"mode_set","v":1}');
    const resp = await engine.lines.nextOfType("mode_set_response");
    expect(resp).toContain('"id":"M5"');
    expect(resp).toContain('"mode":"default"');
    const btabCount = runner.recorded.filter(
      (cmd) => JSON.stringify(cmd) === JSON.stringify(["send-keys", "-t", "work", "BTab"]),
    ).length;
    expect(btabCount).toBe(1);

    await engine.teardown();
  });

  test("mode_set 実行中の同一 session 要求は mode_set_busy になる", async () => {
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") return ok("Enter to confirm · Esc to cancel\n");
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({
      sessionManager: mgr,
      modeTiming: { setInitialPollMs: 5, setInitialTimeoutMs: 50 },
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M6a","mode":"plan","session":"work","type":"mode_set","v":1}');
    engine.writeLine('{"id":"M6b","mode":"auto","session":"work","type":"mode_set","v":1}');
    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"id":"M6b"');
    expect(err).toContain('"code":"mode_set_busy"');

    await engine.teardown();
  });
});
