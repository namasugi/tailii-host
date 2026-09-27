// reaper.test.ts — tmux セッション自動掃除判定の単体テスト
// 判定表: idle かつ timeout 超過 → kill / claude active はプロセス生存で bump 代行 /
// codex active は bump 停止(ts stale)= 死んだターンとして kill / 未採番は adopt。

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type HeartbeatScheduled,
  readHeartbeat,
  writeHeartbeat,
  listHeartbeatSessions,
} from "../src/sessions/heartbeat.js";
import {
  CLAUDE_WORKING_MAX_SECONDS,
  type HerdrReaperOps,
  REAPER_IDLE_TIMEOUT_SECONDS,
  SCHEDULED_MAX_SECONDS,
  SCHEDULED_ONE_SHOT_GRACE_SECONDS,
  SCHEDULED_RECURRING_FINAL_GRACE_SECONDS,
  SCHEDULED_UNPARSED_MAX_SECONDS,
  reaperTick,
  scheduledPending,
  serverCwdBelongsToSession,
} from "../src/hub/reaper.js";
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
  test("server cwd はセッション cwd 自身・子孫・symlink 実体を含み prefix sibling を除外する", () => {
    const root = makeTempDir("reaper-cwd-match");
    const project = path.join(root, "site");
    const frontend = path.join(project, "packages", "frontend");
    const alias = path.join(root, "site-alias");
    fs.mkdirSync(frontend, { recursive: true });
    fs.symlinkSync(project, alias, "dir");

    expect(serverCwdBelongsToSession(project, project)).toBe(true);
    expect(serverCwdBelongsToSession(project, frontend)).toBe(true);
    expect(serverCwdBelongsToSession(alias, frontend)).toBe(true);
    expect(serverCwdBelongsToSession(project, path.join(root, "site-other"))).toBe(false);
    expect(serverCwdBelongsToSession(frontend, project)).toBe(false);
  });

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

describe("reaperTick herdr backend", () => {
  /** herdr 操作面のモック（kill 記録つき）。 */
  function herdrOpsWith(options: {
    names: string[];
    agentAlive?: boolean;
  }): { ops: import("../src/hub/reaper.js").HerdrReaperOps; killedNames: string[] } {
    const killedNames: string[] = [];
    return {
      killedNames,
      ops: {
        list: async () =>
          options.names.map((name) => ({ name, cwd: "/w", alive: true, backend: "herdr" as const })),
        agentProcessAlive: async () => options.agentAlive ?? true,
        kill: async (name) => {
          killedNames.push(name);
        },
      },
    };
  }

  // herdr が答えられなかった tick を「セッション 0 件」と混同すると、生存中の会話を
  // 「消滅」と誤判定して heartbeat を回収し、retire（queue 破棄・Session disappeared 通知）
  // まで走る。アプリ上は実行中の会話が突然消える。
  test("herdr の生存判定に失敗した tick は herdr セッションを回収しない", async () => {
    const dir = makeTempDir("reaper-herdr-unavailable");
    const tmux = runnerWithSessions([]);
    const store = makeTempStore();
    store.put({ name: "s-herdr", cwd: "/w", createdAt: 1, backend: "herdr" });
    writeHeartbeat(dir, "s-herdr", { ts: NOW - 10, state: "idle" });
    // 素性の分からない残骸（メタ無し）は従来どおり回収する。
    writeHeartbeat(dir, "s-orphan", { ts: NOW - 10, state: "idle" });
    let stopServerCalls = 0;

    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: {
        list: async () => [],
        listLive: async () => null, // 検出不能（CLI タイムアウト / server 再起動中）
        agentProcessAlive: async () => true,
        kill: async () => {},
        stopServerIfEmpty: async () => { stopServerCalls += 1; },
      },
    });

    expect(result.reclaimed).toEqual(["s-orphan"]);
    expect(readHeartbeat(dir, "s-herdr")).not.toBeNull();
    // 「0 件」ではないので空 server 停止も試みない。
    expect(stopServerCalls).toBe(0);
  });

  test("listLive が空配列を返す tick は従来どおり回収する（0 件と検出不能を取り違えない）", async () => {
    const dir = makeTempDir("reaper-herdr-empty");
    const tmux = runnerWithSessions([]);
    const store = makeTempStore();
    store.put({ name: "s-herdr", cwd: "/w", createdAt: 1, backend: "herdr" });
    writeHeartbeat(dir, "s-herdr", { ts: NOW - 10, state: "idle" });

    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: {
        list: async () => [],
        listLive: async () => [],
        agentProcessAlive: async () => true,
        kill: async () => {},
      },
    });

    expect(result.reclaimed).toEqual(["s-herdr"]);
  });

  test("未命名タブへClaude/Codexの会話タイトルを自動反映し、命名済み/導出不能は触らない（session-title）", async () => {
    const dir = makeTempDir("reaper-herdr-title");
    const tmux = runnerWithSessions([]);
    const store = makeTempStore();
    store.put({ name: "s-unnamed", cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: "conv-1" });
    store.put({ name: "s-empty", cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: "conv-4" });
    store.put({ name: "s-default", cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: "conv-5" });
    store.put({ name: "s-named", cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: "conv-2" });
    // ラベル==前回の自動適用値 → ai-title の更新に追随して再リネームする（stale 追随）。
    store.put({
      name: "s-stale", cwd: "/w", createdAt: 1, backend: "herdr",
      claudeSessionId: "conv-6", autoTabTitle: "旧AIタイトル",
    });
    store.put({ name: "s-codex", cwd: "/w", createdAt: 1, backend: "herdr", agent: "codex", providerSessionId: "th-1" });
    store.put({ name: "s-notitle", cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: "conv-3" });
    const names = ["s-codex", "s-default", "s-empty", "s-named", "s-notitle", "s-stale", "s-unnamed"];
    for (const name of names) writeHeartbeat(dir, name, { ts: NOW - 10, state: "idle" });
    const renamed: [string, string | null][] = [];
    const derivedCodexThreadIDs: string[] = [];
    const ops: import("../src/hub/reaper.js").HerdrReaperOps = {
      list: async () =>
        names.map((name) => ({ name, cwd: "/w", alive: true, backend: "herdr" as const })),
      agentProcessAlive: async () => true,
      kill: async () => {},
      tabInfoByName: async () =>
        new Map([
          ["s-unnamed", { tabId: "w1:t1", label: "s-unnamed" }],
          // 空ラベル・0.7.5 tab create の既定連番ラベルも未命名として取り込む。
          ["s-empty", { tabId: "w1:t5", label: "" }],
          ["s-default", { tabId: "w1:t6", label: "12" }],
          ["s-named", { tabId: "w1:t2", label: "認証バグの調査" }],
          ["s-stale", { tabId: "w1:t7", label: "旧AIタイトル" }],
          ["s-codex", { tabId: "w1:t3", label: "s-codex" }],
          ["s-notitle", { tabId: "w1:t4", label: "s-notitle" }],
        ]),
      setDisplayTitle: async (name, title) => {
        renamed.push([name, title]);
      },
    };

    await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
      deriveClaudeTitle: (sessionId) =>
        sessionId === "conv-1" ? "最初の発話タイトル"
          : sessionId === "conv-4" ? "空ラベル側"
          : sessionId === "conv-5" ? "連番ラベル側"
          : sessionId === "conv-6" ? "新AIタイトル" : null,
      deriveCodexTitle: async (threadId) => {
        derivedCodexThreadIDs.push(threadId);
        return threadId === "th-1" ? "Codex正式タイトル" : null;
      },
    });

    // 未命名（ラベル==セッション名 / 空 / 既定連番 / 前回の自動適用値）かつタイトル導出可の
    // Claude/Codexへ反映される。人為リネーム（s-named）は触らない。
    expect(renamed).toEqual([
      ["s-codex", "Codex正式タイトル"],
      ["s-default", "連番ラベル側"],
      ["s-empty", "空ラベル側"],
      ["s-stale", "新AIタイトル"],
      ["s-unnamed", "最初の発話タイトル"],
    ]);
    expect(derivedCodexThreadIDs).toEqual(["th-1"]);
    // 自動適用値はメタデータへ記録され、次周期の追随判定の権威になる。
    expect(store.get("s-codex")?.autoTabTitle).toBe("Codex正式タイトル");
    expect(store.get("s-unnamed")?.autoTabTitle).toBe("最初の発話タイトル");
    expect(store.get("s-stale")?.autoTabTitle).toBe("新AIタイトル");
    expect(store.get("s-named")?.autoTabTitle).toBeUndefined();
  });

  test("herdr セッションも idle timeout 超過で pane close(kill) される", async () => {
    const dir = makeTempDir("reaper-herdr");
    const tmux = runnerWithSessions([]);
    const { ops, killedNames } = herdrOpsWith({ names: ["s-hold", "s-hfresh"] });
    writeHeartbeat(dir, "s-hold", { ts: NOW - TIMEOUT, state: "idle" });
    writeHeartbeat(dir, "s-hfresh", { ts: NOW - 10, state: "idle" });

    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
    });

    expect(result.killed).toEqual(["s-hold"]);
    expect(killedNames).toEqual(["s-hold"]);
    expect(readHeartbeat(dir, "s-hold")).toBeNull();
    expect(readHeartbeat(dir, "s-hfresh")).not.toBeNull();
    expect(result.liveCount).toBe(2);
  });

  test("同じプロジェクト配下のローカルサーバーが LISTEN 中なら herdr pane を回収しない", async () => {
    const dir = makeTempDir("reaper-herdr-server-protect");
    const tmux = runnerWithSessions([]);
    const store = makeTempStore();
    store.put({ name: "s-preview", cwd: "/work/site", createdAt: 1, backend: "herdr" });
    const { ops, killedNames } = herdrOpsWith({ names: ["s-preview"] });
    writeHeartbeat(dir, "s-preview", { ts: NOW - TIMEOUT, state: "idle" });
    let detections = 0;

    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
      listLocalServerCwds: async () => {
        detections += 1;
        return new Set(["/work/site/frontend"]);
      },
    });

    expect(result.killed).toEqual([]);
    expect(killedNames).toEqual([]);
    expect(detections).toBe(1);
    expect(readHeartbeat(dir, "s-preview")).toEqual({
      ts: NOW,
      state: "idle",
      event: "daemon-local-server",
    });
  });

  test("fresh セッションだけならローカルサーバー検出を呼ばない", async () => {
    const dir = makeTempDir("reaper-server-protect-lazy");
    const tmux = runnerWithSessions([]);
    const { ops } = herdrOpsWith({ names: ["s-fresh"] });
    writeHeartbeat(dir, "s-fresh", { ts: NOW - 10, state: "idle" });
    let detections = 0;

    await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
      listLocalServerCwds: async () => {
        detections += 1;
        return new Set();
      },
    });

    expect(detections).toBe(0);
  });

  test("ローカルサーバー検出不能なら回収せず、heartbeat を進めず次 tick で再試行する", async () => {
    const dir = makeTempDir("reaper-server-detection-unavailable");
    const tmux = runnerWithSessions([]);
    const store = makeTempStore();
    store.put({ name: "s-preview", cwd: "/work/site", createdAt: 1, backend: "herdr" });
    const { ops, killedNames } = herdrOpsWith({ names: ["s-preview"] });
    const stale = { ts: NOW - TIMEOUT, state: "idle" as const };
    writeHeartbeat(dir, "s-preview", stale);
    let detectionAvailable = false;
    let detections = 0;
    const listLocalServerCwds = async (): Promise<ReadonlySet<string> | null> => {
      detections += 1;
      return detectionAvailable ? new Set() : null;
    };

    const deferred = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
      listLocalServerCwds,
    });

    expect(deferred.killed).toEqual([]);
    expect(killedNames).toEqual([]);
    expect(readHeartbeat(dir, "s-preview")).toEqual(stale);

    detectionAvailable = true;
    const retried = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: store,
      timeoutSeconds: TIMEOUT,
      now: NOW + 60,
      herdrOps: ops,
      listLocalServerCwds,
    });

    expect(retried.killed).toEqual(["s-preview"]);
    expect(killedNames).toEqual(["s-preview"]);
    expect(detections).toBe(2);
  });

  test("herdr claude active はプロセス生存で bump 代行され kill されない", async () => {
    const dir = makeTempDir("reaper-herdr-active");
    const tmux = runnerWithSessions([]);
    const { ops, killedNames } = herdrOpsWith({ names: ["s-hbusy"], agentAlive: true });
    writeHeartbeat(dir, "s-hbusy", { ts: NOW - TIMEOUT * 2, state: "active" });

    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
    });

    expect(result.killed).toEqual([]);
    expect(killedNames).toEqual([]);
    expect(readHeartbeat(dir, "s-hbusy")?.ts).toBe(NOW);
  });

  test("生存中の herdr セッションの heartbeat は残骸回収されない（tmux 生存集合との和）", async () => {
    const dir = makeTempDir("reaper-herdr-reclaim");
    const tmux = runnerWithSessions([]);
    const { ops } = herdrOpsWith({ names: ["s-halive"] });
    writeHeartbeat(dir, "s-halive", { ts: NOW - 10, state: "idle" });
    writeHeartbeat(dir, "s-gone", { ts: NOW - 10, state: "idle" });

    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
      herdrOps: ops,
    });

    expect(result.reclaimed).toEqual(["s-gone"]);
    expect(readHeartbeat(dir, "s-halive")).not.toBeNull();
  });

  test("生存 herdr セッション 0 なら空 server を回収し、生存中は停止しない", async () => {
    const dir = makeTempDir("reaper-herdr-server");
    const tmux = runnerWithSessions([]);
    let stopped = 0;
    const makeOps = (names: string[]): import("../src/hub/reaper.js").HerdrReaperOps => ({
      list: async () =>
        names.map((name) => ({ name, cwd: "/w", alive: true, backend: "herdr" as const })),
      agentProcessAlive: async () => true,
      kill: async () => {},
      stopServerIfEmpty: async () => {
        stopped += 1;
      },
    });
    const base = {
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    };

    await reaperTick({ ...base, herdrOps: makeOps(["s-h1"]) });
    expect(stopped).toBe(0);

    await reaperTick({ ...base, herdrOps: makeOps([]) });
    expect(stopped).toBe(1);
  });

  test("herdr メタ皆無の既定では herdr 巡回を行わない（純 tmux 環境）", async () => {
    const dir = makeTempDir("reaper-herdr-none");
    const tmux = runnerWithSessions(["cs-t"]);
    writeHeartbeat(dir, "cs-t", { ts: NOW - 10, state: "idle" });

    // herdrOps を省略 = 既定解決。メタに herdr が無いので herdr CLI は組み立てられない
    //（実 HerdrSessionManager が構築されると ENOENT throw で fail-soft だが、ここでは
    //  既定 null になることを liveCount が tmux 分のみである事実で確認する）。
    const result = await reaperTick({
      runner: tmux.runner,
      heartbeatDir: dir,
      metadataStore: makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: NOW,
    });

    expect(result.liveCount).toBe(1);
    expect(result.killed).toEqual([]);
  });
});

describe("reaperTick claude の背景作業の保護", () => {
  const NOW_MS = NOW * 1000;

  /** Claude Code の状態ファイル置き場（`<pid>.json` を並べる）。 */
  function claudeSessionsDir(...records: Record<string, unknown>[]): string {
    const dir = makeTempDir("claude-sessions");
    for (const fields of records) {
      const pid = typeof fields["pid"] === "number" ? fields["pid"] : 4242;
      fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
        pid,
        sessionId: "sid-1",
        procStart: "Sat Sep 26 23:29:25 2026",
        status: "idle",
        updatedAt: NOW_MS - 60_000,
        statusUpdatedAt: NOW_MS - 60_000,
        ...fields,
      }));
    }
    return dir;
  }

  function oneShot(fireTs: number, fields: Partial<HeartbeatScheduled> = {}): HeartbeatScheduled {
    return { atTs: NOW - TIMEOUT, sessionId: "sid-1", oneShotTs: [fireTs], recurring: [], unparsed: false, ...fields };
  }

  async function tick(options: {
    dir: string;
    runner: MockTmuxRunner;
    sessionsDir: string | null;
    alivePids?: number[];
    now?: number;
    store?: ReturnType<typeof makeTempStore>;
    herdrOps?: HerdrReaperOps | null;
  }) {
    const alive = new Set(options.alivePids ?? [4242]);
    return reaperTick({
      runner: options.runner.runner,
      heartbeatDir: options.dir,
      metadataStore: options.store ?? makeTempStore(),
      timeoutSeconds: TIMEOUT,
      now: options.now ?? NOW,
      claudeSessionsDir: options.sessionsDir,
      claudeProcessAlive: (pid) => alive.has(pid),
      herdrOps: options.herdrOps ?? null,
    });
  }

  test("Stop 後の idle でも背景サブエージェント中（busy）なら bump して kill しない", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-bg"]);
    writeHeartbeat(dir, "cs-bg", { ts: NOW - TIMEOUT, state: "idle", event: "Stop" });
    const sessionsDir = claudeSessionsDir({ tmux: "cs-bg:@0.%1", status: "busy" });

    const result = await tick({ dir, runner, sessionsDir });

    expect(result.killed).toEqual([]);
    expect(readHeartbeat(dir, "cs-bg")).toEqual({ ts: NOW, state: "idle", event: "daemon-claude-working-busy" });
  });

  test("背景シェル（shell）・承認待ち（waiting）も保護し、idle なら従来どおり kill", async () => {
    for (const [status, expectKilled] of [["shell", false], ["waiting", false], ["idle", true]] as const) {
      const dir = makeTempDir("reaper");
      const runner = runnerWithSessions(["cs-bg"]);
      writeHeartbeat(dir, "cs-bg", { ts: NOW - TIMEOUT, state: "idle" });
      const sessionsDir = claudeSessionsDir({ tmux: "cs-bg:@0.%1", status });

      const result = await tick({ dir, runner, sessionsDir });

      expect(result.killed).toEqual(expectKilled ? ["cs-bg"] : []);
    }
  });

  test("状態ファイルの pid が死んでいる（異常終了の残骸）なら保護しない", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-bg"]);
    writeHeartbeat(dir, "cs-bg", { ts: NOW - TIMEOUT, state: "idle" });
    const sessionsDir = claudeSessionsDir({ tmux: "cs-bg:@0.%1", status: "busy" });

    const result = await tick({ dir, runner, sessionsDir, alivePids: [] });

    expect(result.killed).toEqual(["cs-bg"]);
  });

  test("同じ status のまま 24 時間を超えた申告・未来時刻の申告は信用しない", async () => {
    for (const statusUpdatedAt of [NOW_MS - CLAUDE_WORKING_MAX_SECONDS * 1000, NOW_MS + 3600_000]) {
      const dir = makeTempDir("reaper");
      const runner = runnerWithSessions(["cs-bg"]);
      writeHeartbeat(dir, "cs-bg", { ts: NOW - TIMEOUT, state: "idle" });
      const sessionsDir = claudeSessionsDir({ tmux: "cs-bg:@0.%1", status: "busy", statusUpdatedAt });

      const result = await tick({ dir, runner, sessionsDir });

      expect(result.killed).toEqual(["cs-bg"]);
    }
  });

  test("codex セッションは Claude の申告を見ない", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-codex"]);
    const store = makeTempStore();
    store.put({ name: "cs-codex", cwd: "/work", createdAt: NOW - 10_000, agent: "codex" });
    writeHeartbeat(dir, "cs-codex", { ts: NOW - TIMEOUT, state: "idle" });
    const sessionsDir = claudeSessionsDir({ tmux: "cs-codex:@0.%1", status: "busy" });

    const result = await tick({ dir, runner, sessionsDir, store });

    expect(result.killed).toEqual(["cs-codex"]);
  });

  test("tmux は session id で照合しない: 同じ会話の複製インスタンス（Mac のターミナル）の仕事中で守らない", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-dup"]);
    const store = makeTempStore();
    store.put({ name: "cs-dup", cwd: "/work", createdAt: NOW - 10_000, claudeSessionId: "sid-1" });
    writeHeartbeat(dir, "cs-dup", { ts: NOW - TIMEOUT, state: "idle" });
    const sessionsDir = claudeSessionsDir(
      { pid: 100, tmux: "cs-dup:@0.%1", status: "idle" },
      { pid: 200, status: "shell" },
      { pid: 300, tmux: "main:@1.%4", status: "busy" },
    );

    const result = await tick({ dir, runner, sessionsDir, store, alivePids: [100, 200, 300] });

    expect(result.killed).toEqual(["cs-dup"]);
  });

  /** herdr の操作面（前面 pid 取得つき）。 */
  function herdrOps(name: string, pids: number[] | null | undefined): { ops: HerdrReaperOps; killed: string[] } {
    const killedNames: string[] = [];
    return {
      killed: killedNames,
      ops: {
        list: async () => [{ name, cwd: "/w", alive: true, backend: "herdr" as const }],
        agentProcessAlive: async () => true,
        ...(pids !== undefined ? { agentProcessIds: async () => pids } : {}),
        kill: async (target) => {
          killedNames.push(target);
        },
      },
    };
  }

  test("herdr は pane の前面 pid で照合し、同じ session id の別インスタンスを見ない", async () => {
    const store = makeTempStore();
    store.put({ name: "s-h", cwd: "/w", createdAt: NOW - 10_000, backend: "herdr", claudeSessionId: "sid-1" });
    const sessionsDir = claudeSessionsDir(
      { pid: 100, status: "idle" },
      { pid: 200, status: "busy" },
    );
    // [55] = 取れたが一致しない → 同じ session id の複製（200 busy）へ落ちず回収する。
    for (const [pids, expectKilled] of [[[100, 55], true], [[200], false], [[55], true]] as const) {
      const dir = makeTempDir("reaper");
      writeHeartbeat(dir, "s-h", { ts: NOW - TIMEOUT, state: "idle" });
      const { ops, killed: killedNames } = herdrOps("s-h", [...pids]);

      await tick({ dir, runner: runnerWithSessions([]), sessionsDir, store, alivePids: [100, 200], herdrOps: ops });

      expect(killedNames).toEqual(expectKilled ? ["s-h"] : []);
    }
  });

  test("herdr で前面 pid が取れないときだけ session id（tmux 欄の無い記録）に頼る", async () => {
    const store = makeTempStore();
    store.put({ name: "s-h", cwd: "/w", createdAt: NOW - 10_000, backend: "herdr", claudeSessionId: "sid-1" });
    const sessionsDir = claudeSessionsDir({ pid: 200, status: "shell" });
    const dir = makeTempDir("reaper");
    writeHeartbeat(dir, "s-h", { ts: NOW - TIMEOUT, state: "idle" });
    const { ops, killed: killedNames } = herdrOps("s-h", null);

    await tick({ dir, runner: runnerWithSessions([]), sessionsDir, store, alivePids: [200], herdrOps: ops });

    expect(killedNames).toEqual([]);
  });

  test("1 回きりの予約は発火時刻 + 猶予まで保護し、過ぎたら通常どおり kill", async () => {
    const scheduled = oneShot(NOW + 600);
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-loop"]);
    writeHeartbeat(dir, "cs-loop", { ts: NOW - TIMEOUT, state: "idle", scheduled });

    const first = await tick({ dir, runner, sessionsDir: null });
    expect(first.killed).toEqual([]);
    // bump しても予約の記録は保持する。
    expect(readHeartbeat(dir, "cs-loop")).toEqual({
      ts: NOW, state: "idle", event: "daemon-claude-scheduled", scheduled,
    });

    // 発火せず（ターンも Stop も来ず）猶予を過ぎた → 最後の bump から timeout 後に kill。
    const later = NOW + 600 + SCHEDULED_ONE_SHOT_GRACE_SECONDS;
    writeHeartbeat(dir, "cs-loop", { ts: later - TIMEOUT, state: "idle" });
    const second = await tick({ dir, runner, sessionsDir: null, now: later });
    expect(second.killed).toEqual(["cs-loop"]);
  });

  test("予約があってもエージェントプロセスが死んでいれば保護しない（予約はプロセス内にしか無い）", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-loop"], "zsh");
    writeHeartbeat(dir, "cs-loop", { ts: NOW - TIMEOUT, state: "idle", scheduled: oneShot(NOW + 600) });

    const result = await tick({ dir, runner, sessionsDir: null });

    expect(result.killed).toEqual(["cs-loop"]);
  });

  test("同じ pane で別の会話が起動し直されていたら、古い会話の予約では守らない", async () => {
    for (const [liveSessionId, expectKilled] of [["sid-new", true], ["sid-1", false]] as const) {
      const dir = makeTempDir("reaper");
      const runner = runnerWithSessions(["cs-loop"]);
      writeHeartbeat(dir, "cs-loop", { ts: NOW - TIMEOUT, state: "idle", scheduled: oneShot(NOW + 600) });
      const sessionsDir = claudeSessionsDir({ tmux: "cs-loop:@0.%1", status: "idle", sessionId: liveSessionId });

      const result = await tick({ dir, runner, sessionsDir });

      expect(result.killed).toEqual(expectKilled ? ["cs-loop"] : []);
    }
  });

  test("予約の持ち主は pid で照合する（/clear で session id が変わっても予約は残る）", async () => {
    for (const [livePid, expectKilled] of [[4242, false], [5151, true]] as const) {
      const dir = makeTempDir("reaper");
      const runner = runnerWithSessions(["cs-loop"]);
      writeHeartbeat(dir, "cs-loop", {
        ts: NOW - TIMEOUT, state: "idle", scheduled: oneShot(NOW + 600, { pid: 4242, sessionId: "sid-before-clear" }),
      });
      const sessionsDir = claudeSessionsDir({ pid: livePid, tmux: "cs-loop:@0.%1", sessionId: "sid-after-clear" });

      const result = await tick({ dir, runner, sessionsDir, alivePids: [livePid] });

      expect(result.killed).toEqual(expectKilled ? ["cs-loop"] : []);
    }
  });

  test("同じ tmux セッションに teammate の Claude がいても、予約の持ち主（リーダー）を見つけて守る", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-team"]);
    writeHeartbeat(dir, "cs-team", { ts: NOW - TIMEOUT, state: "idle", scheduled: oneShot(NOW + 600, { pid: 72209 }) });
    // 辞書順では teammate（100500）が先に並ぶ。
    const sessionsDir = claudeSessionsDir(
      { pid: 72209, tmux: "cs-team:@0.%0" },
      { pid: 100500, tmux: "cs-team:@0.%3" },
    );

    const result = await tick({ dir, runner, sessionsDir, alivePids: [72209, 100500] });

    expect(result.killed).toEqual([]);
  });

  test("予約の pid が分かっていれば、状態ファイルの照合が外れても持ち主の生存を直接確かめる", async () => {
    // 照合が外れる = 置き場の食い違い等で当該セッションの記録が 0 件。
    for (const [alivePids, expectKilled] of [[[4242], false], [[], true]] as const) {
      const dir = makeTempDir("reaper");
      const runner = runnerWithSessions(["cs-loop"]);
      writeHeartbeat(dir, "cs-loop", { ts: NOW - TIMEOUT, state: "idle", scheduled: oneShot(NOW + 600, { pid: 4242 }) });

      const result = await tick({ dir, runner, sessionsDir: makeTempDir("claude-sessions-empty"), alivePids: [...alivePids] });

      expect(result.killed).toEqual(expectKilled ? ["cs-loop"] : []);
    }
  });

  test("エージェントプロセスの死亡で idle へ降格するとき、予約の記録も消す", async () => {
    const dir = makeTempDir("reaper");
    const runner = runnerWithSessions(["cs-crash"], "zsh");
    writeHeartbeat(dir, "cs-crash", { ts: NOW - TIMEOUT, state: "active", scheduled: oneShot(NOW + 600) });

    const result = await tick({ dir, runner, sessionsDir: null });

    expect(result.demoted).toEqual(["cs-crash"]);
    expect(readHeartbeat(dir, "cs-crash")?.scheduled).toBeUndefined();
  });

  test("繰り返し予約は最初に見てから 7 日 + 最終発火の猶予、1 回きりも記録から 7 日、解釈不能は 24 時間", () => {
    const base = { atTs: NOW, oneShotTs: [], recurring: [], unparsed: false };
    const recurring = { ...base, recurring: [{ id: "c1", firstSeenTs: NOW - 3600 }] };
    const recurringEnd = NOW - 3600 + SCHEDULED_MAX_SECONDS + SCHEDULED_RECURRING_FINAL_GRACE_SECONDS;
    // Stop のたびに atTs が進んでも、失効は最初に見た時刻から数える。
    expect(scheduledPending({ ...recurring, atTs: recurringEnd - 10 }, recurringEnd - 1)).toBe(true);
    expect(scheduledPending({ ...recurring, atTs: recurringEnd - 10 }, recurringEnd)).toBe(false);
    expect(scheduledPending({ ...base, unparsed: true }, NOW + SCHEDULED_UNPARSED_MAX_SECONDS - 1)).toBe(true);
    expect(scheduledPending({ ...base, unparsed: true }, NOW + SCHEDULED_UNPARSED_MAX_SECONDS)).toBe(false);
    expect(scheduledPending(base, NOW)).toBe(false);
    // 期限切れの 1 回きりが翌年の一致として記録されても、記録から 7 日で保護を外す。
    const farOneShot = { ...base, oneShotTs: [NOW + 365 * 24 * 3600] };
    expect(scheduledPending(farOneShot, NOW + SCHEDULED_MAX_SECONDS - 1)).toBe(true);
    expect(scheduledPending(farOneShot, NOW + SCHEDULED_MAX_SECONDS)).toBe(false);
  });

  test("hub の処理完了書込（scheduled 未指定）は Stop hook の予約記録を消さない", () => {
    const dir = makeTempDir("reaper");
    const scheduled = oneShot(NOW + 600);
    writeHeartbeat(dir, "cs-keep", { ts: NOW, state: "idle", event: "Stop", scheduled });
    writeHeartbeat(dir, "cs-keep", { ts: NOW + 1, state: "idle", event: "hub-processing-done" });
    expect(readHeartbeat(dir, "cs-keep")?.scheduled).toEqual(scheduled);
    // Stop hook が予約なし（null）を書いたら消える。
    writeHeartbeat(dir, "cs-keep", { ts: NOW + 2, state: "idle", event: "Stop", scheduled: null });
    expect(readHeartbeat(dir, "cs-keep")?.scheduled).toBeUndefined();
  });
});
