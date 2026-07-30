// livePill.test.ts — 会話一覧の「稼働中」ピル正確化（live-pill）
//
// Phase 1: claude_session_list_response へ生存セッションを host が join して同梱する。
//   旧実装は別 RPC（session_list_request, limit 5）+ iOS 側 join だったため、
//   ①生存 6 件以上で母集合から漏れる ②pull-to-refresh で更新されない ③一覧注視中の
//   外部死を拾えない、の 3 つの穴があった。
// Phase 2: hub の死亡遷移（retireSession）を一覧 watcher へ push し、iOS の再取得合図にする。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import {
  annotateLiveSessions,
  buildLiveSessionIndex,
  liveSessionFor,
} from "../src/sessions/liveSessionJoin.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { decodeHubServerLine } from "../src/hub/hubProtocol.js";
import { writeHeartbeat } from "../src/sessions/heartbeat.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import type { SessionInfo } from "../src/protocol.js";
import {
  MockTmuxRunner,
  makeTempDir,
  makeTempStore,
  ok,
  startEngine,
} from "./helpers.js";

function live(name: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { name, cwd: "/w", alive: true, providerSessionId: "conv-1", ...overrides };
}

describe("live-pill: 生存セッション join（決定性）", () => {
  const noCreatedAt = () => null;

  test("会話 id + agent で join し、一致しない行は素通し（= 停止中）", () => {
    const index = buildLiveSessionIndex(
      [live("cs-aaa", { providerSessionId: "conv-a" }),
        live("cs-bbb", { providerSessionId: "conv-b", agent: "codex", backend: "herdr" })],
      noCreatedAt,
    );
    const rows = annotateLiveSessions(
      [
        { sessionId: "conv-a", title: "claude 会話" },
        { sessionId: "conv-b", title: "codex 会話", agent: "codex" as const },
        { sessionId: "conv-c", title: "停止中" },
        // 会話 id は一致するが agent が違う → join しない（agent 混在の誤結合防止）。
        { sessionId: "conv-a", title: "同 id の codex", agent: "codex" as const },
      ],
      index,
    );
    expect(rows[0]).toMatchObject({ liveSessionName: "cs-aaa", liveSessionBackend: "tmux" });
    expect(rows[1]).toMatchObject({ liveSessionName: "cs-bbb", liveSessionBackend: "herdr" });
    expect(rows[2]).not.toHaveProperty("liveSessionName");
    expect(rows[3]).not.toHaveProperty("liveSessionName");
  });

  test("agent 省略は claude 相当に正規化して join する（両側）", () => {
    const index = buildLiveSessionIndex([live("cs-aaa", { agent: "claude" })], noCreatedAt);
    expect(annotateLiveSessions([{ sessionId: "conv-1" }], index)[0])
      .toMatchObject({ liveSessionName: "cs-aaa" });

    const indexWithoutAgent = buildLiveSessionIndex([live("cs-aaa")], noCreatedAt);
    expect(annotateLiveSessions([{ sessionId: "conv-1", agent: "claude" as const }], indexWithoutAgent)[0])
      .toMatchObject({ liveSessionName: "cs-aaa" });
  });

  test("会話 id は providerSessionId 優先・claudeSessionId フォールバック", () => {
    const index = buildLiveSessionIndex(
      [
        { name: "cs-provider", cwd: "/w", alive: true, providerSessionId: "conv-p", claudeSessionId: "conv-ignored" },
        { name: "cs-legacy", cwd: "/w", alive: true, claudeSessionId: "conv-l" },
      ],
      noCreatedAt,
    );
    expect(liveSessionFor(index, "conv-p")?.liveSessionName).toBe("cs-provider");
    expect(liveSessionFor(index, "conv-l")?.liveSessionName).toBe("cs-legacy");
    // providerSessionId がある行の claudeSessionId 側ではキーを作らない（重複 join の防止）。
    expect(liveSessionFor(index, "conv-ignored")).toBeUndefined();
  });

  test("停止セッション（alive=false）と会話 id 不明は母集合から除外する", () => {
    const index = buildLiveSessionIndex(
      [
        live("cs-dead", { alive: false }),
        { name: "cs-nameless", cwd: "/w", alive: true },
        { name: "cs-empty-id", cwd: "/w", alive: true, providerSessionId: "" },
      ],
      noCreatedAt,
    );
    expect(index.size).toBe(0);
  });

  test("複数 pane が同じ会話を掴んだら cs- 起点を優先する", () => {
    // createdAt は非 cs- 側の方が新しい（= 規則②では負ける）状況にして①の優先を確かめる。
    const createdAt = (name: string) => (name === "manual-old" ? 900 : 100);
    const index = buildLiveSessionIndex(
      [live("manual-old"), live("cs-app")],
      createdAt,
    );
    expect(liveSessionFor(index, "conv-1")?.liveSessionName).toBe("cs-app");
  });

  test("cs- 同士は createdAt 降順で選ぶ（メタ不明は最劣後）", () => {
    const createdAt = (name: string) =>
      name === "cs-new" ? 500 : name === "cs-old" ? 100 : null;
    const index = buildLiveSessionIndex(
      [live("cs-old"), live("cs-unknown"), live("cs-new")],
      createdAt,
    );
    expect(liveSessionFor(index, "conv-1")?.liveSessionName).toBe("cs-new");

    // createdAt が全て不明なら最終タイブレークの name 昇順で決定的になる。
    const tie = buildLiveSessionIndex([live("cs-z"), live("cs-a"), live("cs-m")], () => null);
    expect(liveSessionFor(tie, "conv-1")?.liveSessionName).toBe("cs-a");
  });

  test("createdAt 同値は name 昇順で決定的（入力順に依存しない）", () => {
    const createdAt = () => 42;
    const forward = buildLiveSessionIndex([live("cs-b"), live("cs-a")], createdAt);
    const reverse = buildLiveSessionIndex([live("cs-a"), live("cs-b")], createdAt);
    expect(liveSessionFor(forward, "conv-1")?.liveSessionName).toBe("cs-a");
    expect(liveSessionFor(reverse, "conv-1")?.liveSessionName).toBe("cs-a");
  });

  test("annotate は入力行を破壊しない（新オブジェクトを返す）", () => {
    const source = [{ sessionId: "conv-1", title: "t" }];
    const rows = annotateLiveSessions(source, buildLiveSessionIndex([live("cs-a")], noCreatedAt));
    expect(source[0]).not.toHaveProperty("liveSessionName");
    expect(rows[0]).toMatchObject({ sessionId: "conv-1", title: "t", liveSessionName: "cs-a" });
  });
});

/** projects ルートへ 1 会話分の jsonl を書き、その sessionId を返す。 */
function writeConversation(projects: string, slug: string, sessionId: string, title: string): void {
  const dir = path.join(projects, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `{"type":"user","cwd":"/tmp/proj","message":{"content":"${title}"}}\n`,
  );
}

describe("live-pill Phase 1: engine の一覧応答", () => {
  test("生存セッションを join して liveSessionsResolved=true を載せる", async () => {
    const projects = makeTempDir("tailii-live-pill");
    const liveId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const deadId = "66666666-8888-9999-aaaa-bbbbbbbbbbbb";
    writeConversation(projects, "-tmp-proj", liveId, "稼働中の会話");
    writeConversation(projects, "-tmp-proj", deadId, "停止中の会話");

    const store = makeTempStore();
    store.put({ name: "cs-live", cwd: "/tmp/proj", createdAt: 10, claudeSessionId: liveId });
    // 生存していない（tmux ls に出ない）メタは join されない = 停止中の確定。
    store.put({ name: "cs-dead", cwd: "/tmp/proj", createdAt: 5, claudeSessionId: deadId });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("cs-live\n") : ok("")));
    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }),
      metadataStore: store,
      claudeSessionStore: new ClaudeSessionStore(projects),
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"LP1","type":"claude_session_list_request","v":2}');
    const resp = await engine.lines.nextOfType("claude_session_list_response");

    expect(resp).toContain('"liveSessionsResolved":true');
    const rows = (JSON.parse(resp) as {
      claudeSessions: { sessionId: string; liveSessionName?: string; liveSessionBackend?: string }[];
    }).claudeSessions;
    expect(rows.find((row) => row.sessionId === liveId)).toMatchObject({
      liveSessionName: "cs-live", liveSessionBackend: "tmux",
    });
    expect(rows.find((row) => row.sessionId === deadId)).not.toHaveProperty("liveSessionName");
    await engine.teardown();
  });

  test("生存列挙に失敗したら annotate せず liveSessionsResolved も載せない", async () => {
    const projects = makeTempDir("tailii-live-pill-fail");
    const sessionId = "55555555-8888-9999-aaaa-bbbbbbbbbbbb";
    writeConversation(projects, "-tmp-proj", sessionId, "列挙不能");

    const store = makeTempStore();
    store.put({ name: "cs-live", cwd: "/tmp/proj", createdAt: 10, claudeSessionId: sessionId });
    // tmux ls が異常終了（サーバ未起動の既知文言ではない） → list() が throw する。
    const runner = new MockTmuxRunner((args) =>
      args[0] === "ls" ? { exitCode: 1, stdout: "", stderr: "boom" } : ok(""),
    );
    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }),
      metadataStore: store,
      claudeSessionStore: new ClaudeSessionStore(projects),
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"LP2","type":"claude_session_list_request","v":2}');
    const resp = await engine.lines.nextOfType("claude_session_list_response");

    // 嘘の resolved で「全部停止中」を描かせない（iOS は従来 join へフォールバックする）。
    expect(resp).not.toContain("liveSessionsResolved");
    expect(resp).not.toContain("liveSessionName");
    expect(resp).toContain(`"sessionId":"${sessionId}"`);
    await engine.teardown();
  });
});

describe("live-pill Phase 2: hub の死亡 push", () => {
  function makeHub(dirPrefix: string, options: {
    runner?: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    heartbeatDir?: string;
    now?: () => number;
  } = {}) {
    return new SessionHub({
      runner: options.runner ?? (async () => ok("")),
      heartbeatDir: options.heartbeatDir ?? makeTempDir(dirPrefix),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1800,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  function watch(hub: SessionHub): { client: object; received: unknown[] } {
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "session_preview_watch", enabled: true }));
    return { client, received };
  }

  const livenessOf = (received: unknown[]) =>
    received.filter((message) => (message as { type?: string }).type === "conversation_liveness");

  test("engine 発 kill（session_retire）で watcher へ死亡を送る", () => {
    const hub = makeHub("hub-live-pill-kill");
    const { client, received } = watch(hub);
    hub.handleClientMessage(client, JSON.stringify({
      type: "conversation_subscribe", session: "cs-work", afterSeq: 0, preview: true,
    }));
    received.length = 0;
    hub.handleClientMessage(client, JSON.stringify({ type: "session_retire", session: "cs-work" }));
    expect(livenessOf(received)).toEqual([
      { type: "conversation_liveness", session: "cs-work", alive: false },
    ]);
  });

  test("watcher が居なければ送らない", () => {
    const hub = makeHub("hub-live-pill-nowatch");
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({
      type: "conversation_subscribe", session: "cs-work", afterSeq: 0, preview: true,
    }));
    hub.handleClientMessage(client, JSON.stringify({ type: "session_retire", session: "cs-work" }));
    expect(livenessOf(received)).toEqual([]);
  });

  test("actor 不在（購読も処理もない外部死）でも一覧は古くなるので送る", () => {
    const hub = makeHub("hub-live-pill-noactor");
    const { client, received } = watch(hub);
    hub.handleClientMessage(client, JSON.stringify({ type: "session_retire", session: "cs-never-seen" }));
    expect(livenessOf(received)).toEqual([
      { type: "conversation_liveness", session: "cs-never-seen", alive: false },
    ]);
  });

  test("tick の demote / reclaim（reaper 経路）でも送る", async () => {
    const heartbeatDir = makeTempDir("hub-live-pill-tick");
    const hub = makeHub("hub-live-pill-tick", {
      heartbeatDir,
      now: () => 100,
      // cs-work は tmux 生存だが pane はシェル（=agent 死亡 → demote）、cs-gone は tmux 消滅（reclaim）。
      runner: async (args) => {
        if (args[0] === "ls") return ok("cs-work\n");
        if (args[0] === "list-clients") return ok("");
        if (args[0] === "display-message") return ok("zsh\n");
        return ok("");
      },
    });
    for (const session of ["cs-work", "cs-gone"]) {
      writeHeartbeat(heartbeatDir, session, { ts: 90, state: "active", event: "hook" });
    }
    hub.restoreFromHeartbeats();
    const { received } = watch(hub);

    const result = await hub.tick();

    expect(result.demoted).toEqual(["cs-work"]);
    expect(result.reclaimed).toEqual(["cs-gone"]);
    expect(livenessOf(received)).toEqual([
      { type: "conversation_liveness", session: "cs-work", alive: false },
      { type: "conversation_liveness", session: "cs-gone", alive: false },
    ]);
  });
});

describe("live-pill Phase 2: engine の転送ゲート", () => {
  async function startWatchableEngine() {
    const runner = new MockTmuxRunner(() => ok(""));
    const hub = new SessionHub({
      runner: async () => ok(""),
      heartbeatDir: makeTempDir("hub-live-pill-engine"),
      metadataStore: makeTempStore(),
      timeoutSeconds: 1800,
    });
    const store = makeTempStore();
    const engine = startEngine({
      sessionManager: new TmuxSessionManager({ runner: runner.runner, store }),
      metadataStore: store,
      hub,
    });
    await engine.lines.nextOfType("channel_hello");
    return { engine, hub };
  }

  test("watch 有効中は session_liveness_event を iOS へ書き出す", async () => {
    const { engine, hub } = await startWatchableEngine();
    engine.writeLine('{"enabled":true,"type":"session_preview_watch","v":2}');
    // engine → hub の watch 登録が届いてから死亡させる。
    await new Promise((resolve) => setTimeout(resolve, 50));
    hub.handleClientMessage({}, JSON.stringify({ type: "session_retire", session: "cs-work" }));

    const line = await engine.lines.nextOfType("session_liveness_event");
    expect(JSON.parse(line)).toEqual({
      type: "session_liveness_event", v: 2, session: "cs-work", alive: false,
    });
    await engine.teardown();
  });

  test("watch 無効なら送らない", async () => {
    const { engine, hub } = await startWatchableEngine();
    hub.handleClientMessage({}, JSON.stringify({ type: "session_retire", session: "cs-work" }));
    // 後続の観測可能な応答が先に来ることで「送られていない」を確定させる。
    engine.writeLine('{"id":"PING","type":"usage_request","v":2}');
    const line = await engine.lines.next();
    expect(line).not.toContain("session_liveness_event");
    await engine.teardown();
  });
});
