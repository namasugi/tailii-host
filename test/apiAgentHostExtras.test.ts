// apiAgentHostExtras.test.ts — API 作業の残り課題: 承認の保留・SDK の導入と版の照合・heartbeat・一覧の印・状態の添付。

import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { requestApiAgentApproval } from "../src/apiAgent/approvalBridge.js";
import { compatibilityOf, agentSdkStatus, readAgentSdkPackage, installedClaudeVersion } from "../src/apiAgent/sdkStatus.js";
import { agentSdkDoctorCheck } from "../src/commands/doctor.js";
import { defaultApiAgentPreflight } from "../src/apiAgent/defaults.js";
import { apiAgentWorkerEnvironment, apiAgentChildEnvironment } from "../src/apiAgent/keyEnvironment.js";
import { buildLiveSessionIndex, annotateLiveSessions } from "../src/sessions/liveSessionJoin.js";
import { ApiAgentLedgerStore, emptyLedger } from "../src/apiAgent/ledger.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { SessionHub, type ApiAgentHubRuntime } from "../src/hub/sessionHub.js";
import { decodeHubServerLine } from "../src/hub/hubProtocol.js";
import { listHeartbeatSessions, writeHeartbeat, readHeartbeat } from "../src/sessions/heartbeat.js";
import type { RemotePendingMessage } from "../src/hub/engineRelaySocket.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const CONV = "7b2c6a3f-ba60-45fd-89ae-cba51afaf7dc";

/** serve の代わり: approval_request を受けたら決定を返す unix socket。 */
function fakeServe(socketPath: string, decide: (id: string) => "allow" | "deny" | "close") {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const message = decodeControlMessage(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.type !== "approval_request") return;
      received.push(message.id);
      const decision = decide(message.id);
      if (decision === "close") { socket.destroy(); return; }
      socket.write(encodeControlMessage({ type: "approval_decision", v: 1, id: message.id, decision }) + "\n");
    });
  });
  return { received, listen: () => new Promise<void>((resolve) => server.listen(socketPath, resolve)), close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function shortSocketPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aa-")), name);
}

describe("承認の保留（端末がつながっていないとき）", () => {
  test("つながっていればそのまま承認カードへ出し、決定を返す（一覧の待ちは出さない）", async () => {
    const socketPath = shortSocketPath("s.sock");
    const serve = fakeServe(socketPath, () => "allow");
    await serve.listen();
    const published: RemotePendingMessage[] = [];
    const decision = await requestApiAgentApproval(
      { id: "a1", session: "cs-a", tool: "Write", summary: "Write file: /w/a", cwd: "/w" },
      { socketPathFor: () => socketPath, publishPending: (m) => published.push(m) },
    );
    expect(decision).toBe("allow");
    expect(serve.received).toEqual(["a1"]);
    expect(published).toEqual([]);
    await serve.close();
  });

  test("つながらなければ一覧の「承認待ち」と push を出して待ち、つながり直したら同じ id で送り直す", async () => {
    const socketPath = shortSocketPath("s.sock");
    const published: RemotePendingMessage[] = [];
    const pushes: string[] = [];
    const pending = requestApiAgentApproval(
      { id: "a2", session: "cs-a", tool: "Bash", summary: "npm test", cwd: "/w" },
      {
        socketPathFor: () => socketPath, publishPending: (m) => published.push(m), retryIntervalMs: 20, connectTimeoutMs: 50,
        notifier: async (request) => { pushes.push(request.approvalId); }, hasSubscribers: () => false,
      },
    );
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toEqual({ type: "remote_pending", v: 1, id: "a2", session: "cs-a", kind: "approval", tool: "Bash", summary: "npm test" });
    expect(pushes).toEqual(["a2"]);
    const serve = fakeServe(socketPath, () => "deny");
    await serve.listen();
    expect(await pending).toBe("deny");
    expect(serve.received).toEqual(["a2"]);
    expect(published.at(-1)).toEqual({ type: "remote_pending_cleared", v: 1, id: "a2", session: "cs-a", kind: "approval" });
    await serve.close();
  });

  test("会話を見ている端末がいれば push は送らない。決定待ち中に切れたら保留へ戻る", async () => {
    const socketPath = shortSocketPath("s.sock");
    let first = true;
    const serve = fakeServe(socketPath, () => { if (first) { first = false; return "close"; } return "allow"; });
    await serve.listen();
    const published: RemotePendingMessage[] = [];
    const pushes: string[] = [];
    const decision = await requestApiAgentApproval(
      { id: "a3", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
      { socketPathFor: () => socketPath, publishPending: (m) => published.push(m), retryIntervalMs: 20,
        notifier: async (r) => { pushes.push(r.approvalId); }, hasSubscribers: () => true },
    );
    expect(decision).toBe("allow");
    expect(serve.received).toEqual(["a3", "a3"]);
    expect(pushes).toEqual([]);
    expect(published.map((m) => m.type)).toEqual(["remote_pending", "remote_pending_cleared"]);
    await serve.close();
  });

  test("ターンが終わったら（中止）・期限が来たら拒否し、一覧の待ちを片付ける", async () => {
    const controller = new AbortController();
    const published: RemotePendingMessage[] = [];
    const pending = requestApiAgentApproval(
      { id: "a4", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w", signal: controller.signal },
      { socketPathFor: () => shortSocketPath("none.sock"), publishPending: (m) => published.push(m), retryIntervalMs: 20, connectTimeoutMs: 20 },
    );
    await vi.waitFor(() => expect(published).toHaveLength(1));
    controller.abort();
    expect(await pending).toBe("deny");
    expect(published.at(-1)?.type).toBe("remote_pending_cleared");

    let clock = 0;
    const expired = await requestApiAgentApproval(
      { id: "a5", session: "cs-a", tool: "Bash", summary: "x", cwd: "/w" },
      { socketPathFor: () => shortSocketPath("none.sock"), retryIntervalMs: 5, connectTimeoutMs: 5, deadlineMs: 100, now: () => (clock += 60) },
    );
    expect(expired).toBe("deny");
  });
});

describe("SDK の導入と版の照合", () => {
  function fakeSdk(dir: string, claudeCodeVersion: string, bundled: boolean) {
    const pkg = path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.322", claudeCodeVersion, main: "sdk.mjs" }));
    fs.writeFileSync(path.join(pkg, "sdk.mjs"), "export function query() {}\n");
    return { entry: path.join(pkg, "sdk.mjs"), bundled };
  }

  test("package.json の claudeCodeVersion と導入済み claude の版を比べる", () => {
    const sdk = fakeSdk(makeTempDir("aa-sdk"), "2.1.322", false);
    expect(readAgentSdkPackage(sdk.entry)).toEqual({ version: "0.3.322", claudeCodeVersion: "2.1.322" });
    const status = (claudeVersion: string | null, claudePath: string | null = "/x/claude") => agentSdkStatus({
      resolveEntry: () => sdk.entry, hasBundled: () => false, resolveClaude: () => claudePath, claudeVersion: () => claudeVersion,
    });
    expect(status("2.1.322").compatibility).toBe("ok");
    expect(status("2.1.330").compatibility).toBe("ok");
    expect(status("2.1.300").compatibility).toBe("claude_older");
    expect(status(null).compatibility).toBe("unknown");
    expect(status(null, null).compatibility).toBe("claude_missing");
    expect(agentSdkStatus({ resolveEntry: () => null }).compatibility).toBe("not_installed");
    expect(compatibilityOf({ installed: true, entry: "x", sdkVersion: "1", claudeCodeVersion: "9.9.9", bundledExecutable: true, installedClaude: null, installedClaudeVersion: null })).toBe("ok");
  });

  test("ターン前の確認: 未導入は sdk_unavailable、claude が古いと sdk_version_mismatch", () => {
    const base = { installed: true, entry: "x", sdkVersion: "0.3.322", claudeCodeVersion: "2.1.322", bundledExecutable: false, installedClaude: "/c", installedClaudeVersion: "2.1.322" };
    expect(defaultApiAgentPreflight({ ...base, compatibility: "ok" })).toBeNull();
    expect(defaultApiAgentPreflight({ ...base, compatibility: "not_installed" })).toBe("sdk_unavailable");
    expect(defaultApiAgentPreflight({ ...base, compatibility: "claude_missing" })).toBe("sdk_unavailable");
    expect(defaultApiAgentPreflight({ ...base, compatibility: "claude_older" })).toBe("sdk_version_mismatch");
  });

  test("doctor の項目（任意・対処つき・文言に端末名を出さない）", () => {
    const check = agentSdkDoctorCheck({ installed: false, entry: null, sdkVersion: null, claudeCodeVersion: null, bundledExecutable: false, installedClaude: null, installedClaudeVersion: null, compatibility: "not_installed" });
    expect(check).toMatchObject({ id: "api-agent-sdk", ok: false, required: false, remediation: "tailii api-agent install" });
    expect(check.detail).not.toMatch(/Mac|tmux|herdr/);
  });

  test("claude --version は実行ファイルの更新時刻ごとに 1 回だけ", () => {
    const file = path.join(makeTempDir("aa-claude"), "claude");
    fs.writeFileSync(file, "#!/bin/sh\n");
    let calls = 0;
    const run = () => { calls += 1; return "2.1.322 (Claude Code)\n"; };
    expect(installedClaudeVersion(file, run)).toBe("2.1.322");
    expect(installedClaudeVersion(file, run)).toBe("2.1.322");
    expect(calls).toBe(1);
  });

});

describe("利用者のフックと環境", () => {
  test("herdr の状態フック等が読む HERDR_* は作業プロセス・SDK の子へ渡さない（端末なしの会話で herdr の状態を書かない）", () => {
    const env = apiAgentWorkerEnvironment({ HOME: "/h", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1", TMUX: "/tmp/tmux", TMUX_PANE: "%1" }, { ANTHROPIC_API_KEY: "k" });
    for (const name of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "TMUX", "TMUX_PANE"]) expect(env[name]).toBeUndefined();
    const child = apiAgentChildEnvironment({ ...env, HERDR_ENV: "1" });
    expect(child["HERDR_ENV"]).toBeUndefined();
  });
});

describe("一覧の印・状態の添付・heartbeat", () => {
  test("生存中の API 作業は backend を名乗らず executionRoute を載せる", () => {
    const index = buildLiveSessionIndex([
      { name: "cs-api", cwd: "/w", alive: true, agent: "claude", providerSessionId: CONV, executionRoute: "api" },
      { name: "cs-term", cwd: "/w", alive: true, agent: "claude", providerSessionId: "other", backend: "herdr" },
    ], () => 1);
    const rows = annotateLiveSessions([{ sessionId: CONV, agent: "claude" as const }, { sessionId: "other", agent: "claude" as const }], index);
    expect(rows[0]).toEqual({ sessionId: CONV, agent: "claude", liveSessionName: "cs-api", executionRoute: "api" });
    expect(rows[1]).toEqual({ sessionId: "other", agent: "claude", liveSessionName: "cs-term", liveSessionBackend: "herdr" });
  });

  test("台帳の有無（停止中の API 作業の会話の印）", () => {
    const store = new ApiAgentLedgerStore(makeTempDir("aa-ledger-exists"));
    expect(store.exists(CONV)).toBe(false);
    store.save(emptyLedger(CONV));
    expect(store.exists(CONV)).toBe(true);
    expect(store.exists("../x")).toBe(false);
  });

  function fakeRuntime(statusSessions: string[]): ApiAgentHubRuntime {
    return {
      restore: () => [], open: () => undefined, configure: () => undefined, submit: async () => "started",
      interrupt: () => false, dispose: () => undefined, answerQuestion: () => false, has: () => true,
      status: (session) => statusSessions.includes(session) ? { type: "api_agent_status", v: 2, session, state: "idle", model: "m",
        budget: { turnUsd: 1, conversationUsd: 2, maxTurns: 3 }, usage: { totalUsd: 0.1, turns: 1, unconfirmedTurns: 0 }, queued: 0 } : null,
      hasTurnsInFlight: false,
    };
  }

  test("購読したら API 作業の現在の状態を添える（hub の再起動後でも最新値が届く）", () => {
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("aa-hub-sub"), metadataStore: makeTempStore(),
      timeoutSeconds: 1800, apiAgentFactory: () => fakeRuntime(["cs-api"]) });
    const client = {};
    const received: unknown[] = [];
    hub.registerClient(client, (line) => received.push(decodeHubServerLine(line)));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "cs-api" }));
    hub.handleClientMessage(client, JSON.stringify({ type: "conversation_subscribe", session: "cs-term" }));
    const events = received.filter((m) => (m as { type: string }).type === "conversation_event") as { session: string; serverSeq: number; payload: { type: string } }[];
    expect(events.filter((e) => e.payload.type === "api_agent_status").map((e) => [e.session, e.serverSeq])).toEqual([["cs-api", 0]]);
  });

  test("終了で API 作業の heartbeat を消す。再起動で API 作業の active を処理中に戻さない", () => {
    const heartbeatDir = makeTempDir("aa-hub-hb");
    const metadataStore = makeTempStore();
    metadataStore.put({ name: "cs-api", cwd: "/w", createdAt: 1, agent: "claude", claudeSessionId: CONV, executionRoute: "api" });
    writeHeartbeat(heartbeatDir, "cs-api", { ts: 100, state: "active", event: "hub-processing" });
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir, metadataStore, timeoutSeconds: 1800, now: () => 120,
      apiAgentFactory: () => fakeRuntime([]) });
    hub.restoreFromHeartbeats();
    expect(hub.actors.get("cs-api")?.processingSince ?? null).toBeNull();
    expect(readHeartbeat(heartbeatDir, "cs-api")?.state).toBe("active");
    const client = {};
    hub.registerClient(client, () => undefined);
    hub.handleClientMessage(client, JSON.stringify({ type: "session_retire", session: "cs-api" }));
    expect(listHeartbeatSessions(heartbeatDir)).toEqual([]);
  });
});
