// sessionPrewarm.test.ts — 新規会話の先行起動（session-prewarm）
// ドラフトで打ち始めた時点の session_prewarm で Claude を裏で起動し、送信時の session_start が同じ起動
// パラメータなら起動済みの Claude を採用する（Claude の起動待ちを送信後に払わない）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { EngineLauncher } from "../src/commands/launch.js";
import { decodeControlMessage } from "../src/protocol.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { PrewarmStore, prewarmExpired, prewarmFingerprint } from "../src/sessions/prewarmStore.js";
import { claudeTranscriptExists } from "../src/sessions/claudeTranscriptExists.js";
import { claudeProjectSlug } from "../src/shared/paths.js";
import { MockTmuxRunner, makeTempDir, makeTempStore, ok, startEngine } from "./helpers.js";

/** tmux の生存セッション・前面コマンドを模した最小の世界。 */
function makeWorld(options: { killFails?: boolean } = {}) {
  const store = makeTempStore();
  const live = new Set<string>();
  const runner = new MockTmuxRunner((args) => {
    if (args[0] === "ls") return ok([...live].map((name) => `${name}\n`).join(""));
    // 実物と同じく、無いセッションでも display-message の失敗は「生きている」に倒される。
    if (args[0] === "display-message") return live.has(args[3] ?? "") ? ok("claude\n") : { exitCode: 1, stdout: "", stderr: "can't find" };
    if (args[0] === "kill-session") {
      if (options.killFails) return { exitCode: 1, stdout: "", stderr: "timeout" };
      live.delete(args[2] ?? "");
      return ok("");
    }
    return ok("");
  });
  const manager = new TmuxSessionManager({ runner: runner.runner, store });
  const launches: Array<{ name: string; newSessionId: string | null | undefined; title: string | null | undefined }> = [];
  const launcher: EngineLauncher = async (cwd, name, _baseDir, _resume, newSessionId, title) => {
    launches.push({ name, newSessionId, title });
    live.add(name);
    store.put({ name, cwd, createdAt: Math.floor(Date.now() / 1_000), ...(newSessionId ? { claudeSessionId: newSessionId } : {}) });
    return { exitCode: 0, errorText: "" };
  };
  // 既定の場所（隔離された HOME の下）: 一覧の非表示もこの場所を読む。
  const prewarmStore = new PrewarmStore();
  return { store, live, runner, manager, launches, launcher, prewarmStore };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// モデル・モード・effort を付けると engine が本物の起動処理を組む（既存仕様）ので、テストは会話名・出力
// スタイル等の launcher 引数で起動パラメータの違いを作る。
const PREWARM = (name: string, extra = ""): string =>
  `{"cwd":"/tmp/pw","id":"P-${name}","name":"${name}"${extra},"type":"session_prewarm","v":1}`;
const START = (name: string, extra = ""): string =>
  `{"cwd":"/tmp/pw","id":"S-${name}","name":"${name}"${extra},"type":"session_start","v":1}`;

describe("session-prewarm", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    const store = new PrewarmStore();
    for (const name of cleanup.splice(0)) store.remove(name);
  });

  test("先行起動した Claude を、同じパラメータの session_start がそのまま採用する（起動し直さない）", async () => {
    const world = makeWorld();
    cleanup.push("s-pw0001");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(PREWARM("s-pw0001", ',"title":"件名","todoTools":true'));
    expect(await waitFor(() => world.launches.length === 1 && world.prewarmStore.get("s-pw0001") !== null)).toBe(true);
    const prewarmedId = world.launches[0]!.newSessionId;
    expect(prewarmedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.launches[0]!.title).toBe("件名");

    engine.writeLine(START("s-pw0001", ',"title":"件名","todoTools":true'));
    const response = decodeControlMessage(await engine.lines.nextOfType("session_list_response"));
    if (response.type !== "session_list_response") throw new Error(response.type);
    expect(response.adoptedName).toBe("s-pw0001");
    expect(response.sessions.map((info) => info.name)).toContain("s-pw0001");
    // 起動し直していない・会話 id は先行起動のもの・先行起動の印は外れている。
    expect(world.launches).toHaveLength(1);
    expect(world.store.get("s-pw0001")?.claudeSessionId).toBe(prewarmedId);
    expect(world.prewarmStore.get("s-pw0001")).toBeNull();
    expect(world.runner.recorded.some((args) => args[0] === "kill-session")).toBe(false);

    await engine.teardown();
  });

  test("パラメータが変わった session_start は先行起動を閉じて起動し直す", async () => {
    const world = makeWorld();
    cleanup.push("s-pw0002");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(PREWARM("s-pw0002"));
    expect(await waitFor(() => world.prewarmStore.get("s-pw0002") !== null)).toBe(true);
    engine.writeLine(START("s-pw0002", ',"title":"あとで付けた名前"'));
    await engine.lines.nextOfType("session_list_response");

    expect(world.runner.recorded).toContainEqual(["kill-session", "-t", "s-pw0002"]);
    expect(world.launches).toHaveLength(2);
    expect(world.launches[1]!.newSessionId).not.toBe(world.launches[0]!.newSessionId);
    expect(world.store.get("s-pw0002")?.claudeSessionId).toBe(world.launches[1]!.newSessionId);
    expect(world.prewarmStore.get("s-pw0002")).toBeNull();

    await engine.teardown();
  });

  test("先行起動の直後（起動の途中）に来た session_start も、起動を待ってから採用する", async () => {
    const world = makeWorld();
    cleanup.push("s-pw0003");
    let releaseLaunch!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const slowLauncher: EngineLauncher = async (...args) => {
      await gate;
      return world.launcher(...args);
    };
    const engine = startEngine({
      sessionManager: world.manager, launcher: slowLauncher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(PREWARM("s-pw0003"));
    expect(await waitFor(() => world.prewarmStore.get("s-pw0003") !== null)).toBe(true);
    engine.writeLine(START("s-pw0003"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLaunch();
    const response = decodeControlMessage(await engine.lines.nextOfType("session_list_response"));
    if (response.type !== "session_list_response") throw new Error(response.type);
    expect(response.adoptedName).toBe("s-pw0003");
    expect(world.launches).toHaveLength(1);

    await engine.teardown();
  });

  test("同じパラメータの再送は起動し直さない／取り消しで閉じる", async () => {
    const world = makeWorld();
    cleanup.push("s-pw0004");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(PREWARM("s-pw0004"));
    expect(await waitFor(() => world.prewarmStore.get("s-pw0004") !== null)).toBe(true);
    engine.writeLine(PREWARM("s-pw0004"));
    // 一覧要求を挟んで、2 回目の処理が終わるのを待つ（同じ会話名の処理は直列）。
    engine.writeLine('{"id":"L1","type":"session_list_request","v":1}');
    const list = decodeControlMessage(await engine.lines.nextOfType("session_list_response"));
    if (list.type !== "session_list_response") throw new Error(list.type);
    // 先行起動中の会話はアプリの一覧に出さない。
    expect(list.sessions.map((info) => info.name)).not.toContain("s-pw0004");
    expect(world.launches).toHaveLength(1);

    engine.writeLine('{"id":"C1","name":"s-pw0004","type":"session_prewarm_cancel","v":1}');
    expect(await waitFor(() => world.prewarmStore.get("s-pw0004") === null)).toBe(true);
    expect(world.runner.recorded).toContainEqual(["kill-session", "-t", "s-pw0004"]);

    await engine.teardown();
  });

  test("先行起動の記録が無い同名の生きた会話には触らない", async () => {
    const world = makeWorld();
    world.store.put({ name: "s-real0001", cwd: "/tmp/pw", createdAt: 1, claudeSessionId: "11111111-1111-1111-1111-111111111111" });
    world.live.add("s-real0001");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(PREWARM("s-real0001"));
    engine.writeLine('{"id":"C2","name":"s-real0001","type":"session_prewarm_cancel","v":1}');
    engine.writeLine('{"id":"L2","type":"session_list_request","v":1}');
    await engine.lines.nextOfType("session_list_response");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(world.launches).toHaveLength(0);
    expect(world.prewarmStore.get("s-real0001")).toBeNull();
    expect(world.runner.recorded.some((args) => args[0] === "kill-session")).toBe(false);

    await engine.teardown();
  });
});

describe("session-prewarm（レビュー指摘の回帰）", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    const store = new PrewarmStore();
    for (const name of cleanup.splice(0)) store.remove(name);
  });

  test("送信前に Claude ごと消えた先行起動は採用せず、起動し直す", async () => {
    const world = makeWorld();
    cleanup.push("s-pw0101");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(PREWARM("s-pw0101"));
    expect(await waitFor(() => world.prewarmStore.get("s-pw0101") !== null && world.live.has("s-pw0101"))).toBe(true);
    world.live.delete("s-pw0101"); // 起動直後のクラッシュ・サーバ再起動など

    engine.writeLine(START("s-pw0101"));
    const response = decodeControlMessage(await engine.lines.nextOfType("session_list_response"));
    if (response.type !== "session_list_response") throw new Error(response.type);
    expect(response.sessions.map((info) => info.name)).toContain("s-pw0101");
    expect(world.launches).toHaveLength(2);
    expect(world.store.get("s-pw0101")?.claudeSessionId).toBe(world.launches[1]!.newSessionId);

    await engine.teardown();
  });

  test("パラメータ違いの先行起動を閉じられないときは起動せずに失敗を返し、記録を残す", async () => {
    const world = makeWorld({ killFails: true });
    cleanup.push("s-pw0102");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(PREWARM("s-pw0102"));
    expect(await waitFor(() => world.prewarmStore.get("s-pw0102") !== null && world.launches.length === 1)).toBe(true);

    engine.writeLine(START("s-pw0102", ',"title":"別の名前"'));
    const error = JSON.parse(await engine.lines.nextOfType("error")) as { code: string; id: string };
    expect(error).toMatchObject({ id: "S-s-pw0102", code: "launch_failed" });
    expect(world.launches).toHaveLength(1);
    expect(world.prewarmStore.get("s-pw0102")).not.toBeNull();

    await engine.teardown();
  });

  test("期限の間際の先行起動は採用しない（reaper とすれ違わない）", async () => {
    const world = makeWorld();
    cleanup.push("s-pw0103");
    const engine = startEngine({
      sessionManager: world.manager, launcher: world.launcher, metadataStore: world.store, prewarmStore: world.prewarmStore,
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(PREWARM("s-pw0103"));
    expect(await waitFor(() => world.prewarmStore.get("s-pw0103") !== null && world.launches.length === 1)).toBe(true);
    const record = world.prewarmStore.get("s-pw0103")!;
    const { PREWARM_TTL_SECONDS } = await import("../src/sessions/prewarmStore.js");
    const old = Math.floor(Date.now() / 1_000) - PREWARM_TTL_SECONDS + 60;
    world.prewarmStore.put({ ...record, touchedAt: old });

    engine.writeLine(START("s-pw0103"));
    await engine.lines.nextOfType("session_list_response");
    expect(world.runner.recorded).toContainEqual(["kill-session", "-t", "s-pw0103"]);
    expect(world.launches).toHaveLength(2);

    await engine.teardown();
  });
});

describe("prewarmStore", () => {
  test("照合キーは未指定と既定の書き方の揺れを吸収し、値の違いは区別する", () => {
    const base = { cwd: "/w", permissionMode: "default" };
    expect(prewarmFingerprint({ ...base, model: undefined, todoTools: false }))
      .toBe(prewarmFingerprint(base));
    expect(prewarmFingerprint({ ...base, model: "opus" })).not.toBe(prewarmFingerprint(base));
    expect(prewarmFingerprint({ ...base, title: "a" })).not.toBe(prewarmFingerprint(base));
    expect(prewarmFingerprint({ ...base, todoTools: true })).not.toBe(prewarmFingerprint(base));
  });

  test("put/get/remove/names と期限切れ", () => {
    const store = new PrewarmStore(makeTempDir("prewarm-store"));
    store.put({ name: "s-a", fingerprint: "f", claudeSessionId: "x", createdAt: 100, touchedAt: 100 });
    expect(store.get("s-a")?.fingerprint).toBe("f");
    expect([...store.names()]).toEqual(["s-a"]);
    expect(prewarmExpired(store.get("s-a")!, 100 + 60, 120)).toBe(false);
    expect(prewarmExpired(store.get("s-a")!, 100 + 120, 120)).toBe(true);
    store.remove("s-a");
    expect(store.get("s-a")).toBeNull();
    expect(store.names().size).toBe(0);
  });

  test("transcript の有無（先行起動が使われたかの裏付け）", () => {
    const root = makeTempDir("projects");
    const id = "22222222-2222-2222-2222-222222222222";
    expect(claudeTranscriptExists("/tmp/pw", id, root)).toBe(false);
    const dir = path.join(root, claudeProjectSlug("/tmp/pw"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), "{}\n");
    expect(claudeTranscriptExists("/tmp/pw", id, root)).toBe(true);
    expect(claudeTranscriptExists("/tmp/pw", "../../etc/passwd", root)).toBe(false);
    void os;
  });
});

describe("reaper と先行起動", () => {
  test("使われないまま期限を過ぎた先行起動だけ閉じ、使われた（transcript がある）ものは印だけ外す", async () => {
    const { reaperTick } = await import("../src/hub/reaper.js");
    const { writeHeartbeat, readHeartbeat } = await import("../src/sessions/heartbeat.js");
    const { PREWARM_TTL_SECONDS } = await import("../src/sessions/prewarmStore.js");
    const NOW = 2_000_000;
    const heartbeatDir = makeTempDir("prewarm-reaper-hb");
    const store = makeTempStore();
    const prewarmStore = new PrewarmStore(makeTempDir("prewarm-reaper"));
    const live = ["s-pwold", "s-pwnew", "s-pwused"];
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok(live.map((name) => `${name}\n`).join(""));
      if (args[0] === "display-message") return ok("claude\n");
      return ok("");
    });
    const usedId = "33333333-3333-3333-3333-333333333333";
    for (const name of live) {
      store.put({ name, cwd: "/tmp/pw-reaper", createdAt: 1 });
      // 通常の規則なら回収される古い idle（先行起動中はこの計時に載せない）。
      writeHeartbeat(heartbeatDir, name, { ts: NOW - 100_000, state: "idle" });
    }
    prewarmStore.put({ name: "s-pwold", fingerprint: "f", claudeSessionId: "44444444-4444-4444-4444-444444444444",
      createdAt: NOW - PREWARM_TTL_SECONDS - 5, touchedAt: NOW - PREWARM_TTL_SECONDS - 5 });
    prewarmStore.put({ name: "s-pwnew", fingerprint: "f", claudeSessionId: "55555555-5555-5555-5555-555555555555",
      createdAt: NOW - 60, touchedAt: NOW - 60 });
    prewarmStore.put({ name: "s-pwused", fingerprint: "f", claudeSessionId: usedId,
      createdAt: NOW - PREWARM_TTL_SECONDS - 5, touchedAt: NOW - PREWARM_TTL_SECONDS - 5 });
    // 会話が始まった先行起動（印の消し忘れ）: transcript がある。heartbeat は新しくして通常規則でも残す。
    const projects = path.join(os.homedir(), ".claude", "projects", claudeProjectSlug("/tmp/pw-reaper"));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${usedId}.jsonl`), "{}\n");
    writeHeartbeat(heartbeatDir, "s-pwused", { ts: NOW - 10, state: "idle" });

    const result = await reaperTick({
      runner: runner.runner, heartbeatDir, metadataStore: store, timeoutSeconds: 1_800, now: NOW,
      herdrOps: null, prewarmStore,
    });

    expect(result.killed).toEqual(["s-pwold"]);
    expect(prewarmStore.get("s-pwold")).toBeNull();
    expect(readHeartbeat(heartbeatDir, "s-pwold")).toBeNull();
    // 期限内の先行起動は、古い heartbeat でも閉じない。
    expect(prewarmStore.get("s-pwnew")).not.toBeNull();
    expect(readHeartbeat(heartbeatDir, "s-pwnew")).not.toBeNull();
    // 使われた先行起動は閉じずに印だけ外す。
    expect(prewarmStore.get("s-pwused")).toBeNull();
    expect(runner.recorded).not.toContainEqual(["kill-session", "-t", "s-pwused"]);
  });
});
