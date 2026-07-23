// engineLifecycle.test.ts — Engine アイドルライフサイクル / ページング結線テスト
// Swift 版 EngineLifecycleTests.swift の移植（session-list-lifecycle 2.3/3.3）。

import * as fs from "node:fs";
import { describe, expect, test } from "vitest";
import { sendSessionProcessingToEngine } from "../src/engineRelaySocket.js";
import { readHeartbeat, writeHeartbeat, type Heartbeat } from "../src/heartbeat.js";
import type { EngineLauncher } from "../src/launch.js";
import { decodeControlMessage } from "../src/protocol.js";
import { SessionListService } from "../src/sessionListService.js";
import { SessionHub } from "../src/sessionHub.js";
import { TmuxSessionManager } from "../src/tmux.js";
import {
  MockTmuxRunner,
  makeTempDir,
  makeTempStore,
  ok,
  startEngine,
  waitForCommand,
} from "./helpers.js";
import { canListenUnixSocket, tempSocketPath } from "./socketHelpers.js";

// 更新時刻を全て未解決（null）にする provider → 並びは名前昇順で決定的。
const unresolvedProvider = (): null => null;

/** heartbeat ファイルが条件を満たすまでポーリングで待つ。 */
async function waitForHeartbeat(
  dir: string,
  session: string,
  predicate: (heartbeat: Heartbeat) => boolean,
  timeoutMs = 5000,
): Promise<Heartbeat | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const heartbeat = readHeartbeat(dir, session);
    if (heartbeat !== null && predicate(heartbeat)) return heartbeat;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

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

  test("session_idle_hint で heartbeat にアイドル起点が記録される（4.2）", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const heartbeatDir = makeTempDir("heartbeat");

    const engine = startEngine({ sessionManager: mgr, heartbeatDir });
    await engine.lines.nextOfType("channel_hello");

    const before = Math.floor(Date.now() / 1000);
    engine.writeLine('{"id":"H1","name":"work","type":"session_idle_hint","v":1}');

    // 離脱は計時リセット（bump）。未採番なら idle として作られ、ts は今。
    const heartbeat = await waitForHeartbeat(heartbeatDir, "work", (hb) => hb.ts >= before);
    expect(heartbeat?.state).toBe("idle");
    expect(heartbeat?.event).toBe("chat-leave");

    await engine.teardown();
  });

  test("session_idle_hint は処理中（active）の state を idle へ降格させない", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const heartbeatDir = makeTempDir("heartbeat");
    // 処理中に chat を離脱した状況: hook が書いた active が残っている。
    writeHeartbeat(heartbeatDir, "work", { ts: 100, state: "active", event: "PreToolUse" });

    const engine = startEngine({ sessionManager: mgr, heartbeatDir });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"H1b","name":"work","type":"session_idle_hint","v":1}');

    const heartbeat = await waitForHeartbeat(heartbeatDir, "work", (hb) => hb.ts > 100);
    expect(heartbeat?.state).toBe("active");

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

    const heartbeatDir = makeTempDir("heartbeat");
    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      heartbeatDir,
      resumeLauncher: resume,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"R1","name":"work","type":"session_reattach","v":1}');
    const line = await engine.lines.nextOfType("session_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "session_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.id).toBe("R1");
    expect(msg.sessions.map((s) => s.name)).toEqual(["work"]);
    expect(resumeCalls).toEqual([]);
    // 再アクティブ化 = heartbeat 更新（reaper daemon の計時リセット）。
    expect(readHeartbeat(heartbeatDir, "work")?.event).toBe("chat-open");

    await engine.teardown();
  });

  test("tmux が生存しても Claude が終了してシェルだけなら resume 再起動する", async () => {
    const store = makeTempStore();
    store.put({ name: "shell-only", cwd: "/tmp/shell-only", createdAt: 0,
      providerSessionId: "conversation-shell" });
    let killed = false;
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok(killed ? "" : "shell-only\n");
      if (args[0] === "display-message") return ok("zsh\n");
      if (args[0] === "kill-session") killed = true;
      return ok("");
    });
    const resumeCalls: string[][] = [];
    const resume: EngineLauncher = async (cwd, name, _base, resumeSessionId) => {
      resumeCalls.push([cwd, name, resumeSessionId ?? ""]);
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }),
      metadataStore: store,
      launcher: resume,
      resumeLauncher: resume,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"R-shell","name":"shell-only","type":"session_reattach","v":1}');
    await engine.lines.nextOfType("session_list_response");

    expect(runner.recorded).toContainEqual(["kill-session", "-t", "shell-only"]);
    expect(resumeCalls).toEqual([["/tmp/shell-only", "shell-only", "conversation-shell"]]);
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
      resumeLauncher: resume,
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
      resumeLauncher: resume,
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

  // MARK: 6. 処理中/処理完了の heartbeat 反映（session_processing → reaper daemon の判定権威）

  test("session_processing active/done が heartbeat の state に反映される", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-processing");
    fs.rmSync(relayPath, { force: true });
    const store = makeTempStore();
    store.put({ name: "busy1", cwd: "/tmp/busy1", createdAt: 0 });
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    const heartbeatDir = makeTempDir("heartbeat");

    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      heartbeatDir,
      engineRelaySocketPath: relayPath,
    });
    await engine.lines.nextOfType("channel_hello");

    // 処理開始（hook / codex turn controller 相当）→ active。
    await sendSessionProcessingToEngine(
      { type: "session_processing", session: "busy1", state: "active" },
      relayPath,
    );
    const active = await waitForHeartbeat(heartbeatDir, "busy1", (hb) => hb.state === "active");
    expect(active?.event).toBe("hub-processing");

    // 処理完了 → idle（以後 reaper daemon が timeout 計時する）。
    await sendSessionProcessingToEngine(
      { type: "session_processing", session: "busy1", state: "done" },
      relayPath,
    );
    const idle = await waitForHeartbeat(heartbeatDir, "busy1", (hb) => hb.state === "idle");
    expect(idle?.event).toBe("hub-processing-done");
    // engine 自身は kill しない（kill は reaper daemon の責務）。
    const killArgs = JSON.stringify(["kill-session", "-t", "busy1"]);
    expect(runner.recorded.some((cmd) => JSON.stringify(cmd) === killArgs)).toBe(false);

    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  // MARK: 6.3. 表示中/処理中セッションの定期 bump（reaper daemon への生存通知）

  test("開いている会話と処理中セッションは定期 tick で heartbeat が bump される", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-tick");
    fs.rmSync(relayPath, { force: true });
    const store = makeTempStore();
    store.put({ name: "s-work", cwd: "/tmp/s-work", createdAt: 0 });
    store.put({ name: "s-turn", cwd: "/tmp/s-turn", createdAt: 0, agent: "codex" });
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("s-work\ns-turn\n");
      if (args[0] === "capture-pane") return ok("hi\n");
      return ok("");
    });
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    const heartbeatDir = makeTempDir("heartbeat");
    const hub = new SessionHub({
      runner: runner.runner,
      heartbeatDir,
      metadataStore: store,
      timeoutSeconds: 1800,
    });

    const engine = startEngine({
      sessionManager: mgr,
      metadataStore: store,
      heartbeatDir,
      engineRelaySocketPath: relayPath,
      hub,
    });
    await engine.lines.nextOfType("channel_hello");

    // 会話を開く（activeChatSession = s-work）。
    engine.writeLine('{"id":"R9","name":"s-work","type":"session_reattach","v":1}');
    await engine.lines.nextOfType("session_list_response");
    const opened = readHeartbeat(heartbeatDir, "s-work");
    expect(opened).not.toBeNull();

    // 処理中セッション（chat 非表示）も tick の bump 対象。
    await sendSessionProcessingToEngine(
      { type: "session_processing", session: "s-turn", state: "active" },
      relayPath,
    );
    const turnStart = await waitForHeartbeat(heartbeatDir, "s-turn", (hb) => hb.state === "active");
    expect(turnStart).not.toBeNull();

    // 周期実行者である Hub を明示 tick し、双方の state を保持したまま bump する。
    await hub.tick();
    expect(readHeartbeat(heartbeatDir, "s-work")).toMatchObject({ event: "hub-tick" });
    expect(readHeartbeat(heartbeatDir, "s-turn")).toMatchObject({ event: "hub-processing", state: "active" });

    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  // MARK: 6.5. resume 再開は heartbeat を更新する（stale 起点による会話中 kill の根治）

  test("session_start(resume) は stale な heartbeat を更新する（再開直後の reaper kill 防止）", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("cs-res1\n") : ok("")));
    const launcher: EngineLauncher = async (cwd, name) => {
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const heartbeatDir = makeTempDir("heartbeat");
    // 前回離脱時の idle 起点が 30 分以上前のまま残っている状況を再現する。
    writeHeartbeat(heartbeatDir, "cs-res1", { ts: 0, state: "idle", event: "chat-leave" });

    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }),
      metadataStore: store,
      launcher,
      heartbeatDir,
    });
    await engine.lines.nextOfType("channel_hello");

    const before = Math.floor(Date.now() / 1000);
    engine.writeLine(
      '{"cwd":"/tmp/res1","id":"SR1","name":"cs-res1","resumeSessionId":"sid-res1","type":"session_start","v":1}',
    );
    await engine.lines.nextOfType("session_list_response");

    // 再開成功で heartbeat の ts が更新されている（reaper daemon の次 tick で殺されない）。
    const heartbeat = readHeartbeat(heartbeatDir, "cs-res1");
    expect(heartbeat).not.toBeNull();
    expect(heartbeat!.ts).toBeGreaterThanOrEqual(before);

    await engine.teardown();
  });

  test("session_start resume の生存エイリアス再利用も heartbeat を更新する", async () => {
    const store = makeTempStore();
    const sessionId = "f622acb5-1111-2222-3333-444444444444";
    store.put({ name: "s-alias", cwd: "/tmp/alias", createdAt: 7, claudeSessionId: sessionId });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("s-alias\n") : ok("")));
    const launcher: EngineLauncher = async () => ({ exitCode: 0, errorText: "" });
    const heartbeatDir = makeTempDir("heartbeat");
    writeHeartbeat(heartbeatDir, "s-alias", { ts: 0, state: "idle", event: "chat-leave" });

    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }),
      metadataStore: store,
      launcher,
      heartbeatDir,
    });
    await engine.lines.nextOfType("channel_hello");

    const before = Math.floor(Date.now() / 1000);
    engine.writeLine(
      `{"cwd":"/tmp/alias","id":"SR2","name":"cs-f622acb5","resumeSessionId":"${sessionId}","type":"session_start","v":1}`,
    );
    await engine.lines.nextOfType("session_list_response");

    const heartbeat = readHeartbeat(heartbeatDir, "s-alias");
    expect(heartbeat).not.toBeNull();
    expect(heartbeat!.ts).toBeGreaterThanOrEqual(before);

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

  test("mode_get は subagent 一覧の上にあるモードマーカーを返す", async () => {
    const pane = [
      "会話本文",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage",
      "⏺ main",
      "◯ Explore agent-1",
      "◯ Explore agent-2",
      "◯ Explore agent-3",
      "◯ Explore agent-4",
    ].join("\n");
    const runner = new MockTmuxRunner((args) =>
      args[0] === "capture-pane" ? ok(pane) : ok("")
    );
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({ sessionManager: mgr });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M1-subagents","session":"work","type":"mode_get","v":1}');
    const resp = await engine.lines.nextOfType("mode_set_response");
    expect(resp).toContain('"id":"M1-subagents"');
    expect(resp).toContain('"mode":"auto"');

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

  // MARK: 追加: pane_choice_send（Codex TUI 番号ダイアログの選択返送）

  test("pane_choice_send は番号キー（literal）と Enter を pane へ注入し ok を返す", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({ sessionManager: mgr });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"PC1","key":"2","session":"work","type":"pane_choice_send","v":1}');
    const resp = await engine.lines.nextOfType("pane_choice_send_result");
    expect(resp).toContain('"id":"PC1"');
    expect(resp).toContain('"ok":true');
    const recorded = runner.recorded.map((cmd) => JSON.stringify(cmd));
    expect(recorded).toContain(JSON.stringify(["send-keys", "-t", "work", "-l", "2"]));
    expect(recorded).toContain(JSON.stringify(["send-keys", "-t", "work", "Enter"]));

    await engine.teardown();
  });

  test("pane_choice_send は数字以外の key を拒否し注入しない", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    const engine = startEngine({ sessionManager: mgr });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(
      '{"id":"PC2","key":"rm -rf","session":"work","type":"pane_choice_send","v":1}',
    );
    const resp = await engine.lines.nextOfType("pane_choice_send_result");
    expect(resp).toContain('"id":"PC2"');
    expect(resp).toContain('"ok":false');
    const sendKeyCalls = runner.recorded.filter((cmd) => cmd[0] === "send-keys");
    expect(sendKeyCalls).toEqual([]);

    await engine.teardown();
  });

  test("mode_set は BTab 後の再描画中を default と誤認せず明示マーカーまで待つ", async () => {
    const panes = [
      "⏸ manual mode on · ? for shortcuts\n",
      "画面を再描画中\n",
      "⏵⏵ accept edits on (shift+tab to cycle)\n",
      "Puttering…\n… · esc to interrupt · ← for agents\n",
      "⏸ plan mode on (shift+tab to cycle)\n",
      "画面を再描画中\n",
      "⏵⏵ auto mode on (shift+tab to cycle)\n",
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
      modeTiming: { setChangePollMs: 1, setChangeTimeoutMs: 30 },
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"M2-redraw","mode":"auto","session":"work","type":"mode_set","v":1}');
    const resp = await engine.lines.nextOfType("mode_set_response");
    expect(resp).toContain('"id":"M2-redraw"');
    expect(resp).toContain('"mode":"auto"');
    const btabCount = runner.recorded.filter(
      (cmd) => JSON.stringify(cmd) === JSON.stringify(["send-keys", "-t", "work", "BTab"]),
    ).length;
    expect(btabCount).toBe(3);

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
