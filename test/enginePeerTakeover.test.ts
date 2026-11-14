// enginePeerTakeover.test.ts — 既存の会話を開く前の、他所で動く同じ会話の確かめと開き直し（peer-takeover）の結線

import { describe, expect, test } from "vitest";
import { CompositeSessionBackend } from "../src/backend/sessionBackend.js";
import { HerdrSessionManager } from "../src/backend/herdr.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import type { EngineLauncher } from "../src/engine/engine.js";
import { PEER_RUNNING_MESSAGE } from "../src/engine/handlers/session.js";
import { decodeControlMessage } from "../src/protocol.js";
import type { PeerProbe, PeerProcess, TakeoverTarget } from "../src/services/peerTakeover.js";
import type { PeerSessionRecord } from "../src/services/peerSessions.js";
import { MockTmuxRunner, makeTempStore, startEngine } from "./helpers.js";

const CONV = "conv-peer-1";
const START = "Sat Nov 14 07:36:50 2026";

/** 普通のターミナルの対話シェル(400)から起動した Claude(500) が CONV を開いている。 */
function terminalPeer(options: { busy?: boolean; gone?: () => boolean; terminated?: TakeoverTarget[] } = {}): PeerProbe {
  const record: PeerSessionRecord = {
    pid: 500, sessionId: CONV, cwd: "/w", name: "work-1", status: options.busy ? "busy" : "idle",
    kind: "interactive", entrypoint: "cli", bridged: false, messagingSocketPath: null, startedAt: null,
    procStart: START, pidDomain: "darwin", version: "2.1.325",
  };
  const procs: PeerProcess[] = [
    { pid: 400, ppid: 1, uid: 501, tty: "ttys003", stat: "Ss", startedUtc: START, comm: "zsh" },
    { pid: 500, ppid: 400, uid: 501, tty: "ttys003", stat: "S+", startedUtc: START, comm: "claude" },
  ];
  return {
    processTable: async () => new Map(procs.filter((p) => !(p.pid === 500 && options.gone?.())).map((p) => [p.pid, p])),
    args: async (pid) => (pid === 400 ? "-zsh" : "claude --resume conv-peer-1"),
    herdrEnv: async () => ({}),
    registry: () => (options.gone?.() ? [] : [record]),
    uid: () => 501,
    pidDomain: () => "darwin",
    terminate: async (target) => { options.terminated?.push(target); return true; },
  };
}

function backends() {
  const store = makeTempStore();
  const tmux = new TmuxSessionManager({
    runner: new MockTmuxRunner(() => ({ exitCode: 1, stdout: "", stderr: "no server running on /tmp/tmux-1/default" })).runner,
    store,
  });
  const herdr = new HerdrSessionManager({ store, runner: async () => ({ exitCode: 0, stdout: '{"result":{"panes":[]}}', stderr: "" }) });
  return { store, sessionManager: new CompositeSessionBackend({ tmux, herdr, store }) };
}

const startLine = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "session_start", v: 1, id, cwd: "/w", name: "s-peer0001", resumeSessionId: CONV, deferSubscribe: true, ...extra,
});

describe("session_start の peer check", () => {
  test("他所で動いていれば起動せずに確認を求め、トークン付きの送り直しで終了させてから起動する", async () => {
    const { store, sessionManager } = backends();
    const terminated: TakeoverTarget[] = [];
    let gone = false;
    const peerProbe = terminalPeer({ terminated, gone: () => gone });
    const launches: Array<{ name: string; takeover: boolean }> = [];
    const launcher: EngineLauncher = async (_cwd, name, _base, _resume, _new, _title, options) => {
      launches.push({ name, takeover: options?.takeover != null });
      // launcher は pane を作った後で terminate を呼ぶ。
      if (options?.takeover != null && !await options.takeover.terminate()) {
        return { exitCode: 1, errorText: "terminate failed" };
      }
      gone = true;
      store.put({ name, cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: CONV });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher, peerProbe });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine(startLine("S1", { peerCheck: true }));
      const conflict = decodeControlMessage(await engine.lines.nextOfType("session_peer_conflict"));
      expect(conflict).toMatchObject({
        type: "session_peer_conflict", id: "S1", conversationId: CONV, holder: "terminal", holderName: "work-1",
        busy: false, canTakeOver: true,
      });
      expect(launches).toEqual([]);

      const token = (conflict as { token: string }).token;
      engine.writeLine(startLine("S2", { peerCheck: true, takeOver: { token } }));
      await expect.poll(() => launches, { timeout: 5_000 }).toEqual([{ name: "s-peer0001", takeover: true }]);
      expect(terminated.map((t) => t.pid)).toEqual([500]);
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("旧アプリ（peerCheck なし）と並走の同意（allowParallel）は確かめずに起動する", async () => {
    for (const extra of [{}, { peerCheck: true, allowParallel: true }]) {
      const { store, sessionManager } = backends();
      const launched: string[] = [];
      const launcher: EngineLauncher = async (_cwd, name) => {
        launched.push(name);
        store.put({ name, cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: CONV });
        return { exitCode: 0, errorText: "" };
      };
      const engine = startEngine({ sessionManager, metadataStore: store, launcher, peerProbe: terminalPeer() });
      try {
        await engine.lines.nextOfType("channel_hello");
        engine.writeLine(startLine("S1", extra));
        await expect.poll(() => launched, { timeout: 5_000 }).toEqual(["s-peer0001"]);
      } finally {
        await engine.teardown();
      }
    }
  }, 15_000);

  test("処理中に変わった相手は、中断の同意が無ければ終了させず確かめ直しを求める", async () => {
    const { store, sessionManager } = backends();
    let busy = false;
    const idleProbe = terminalPeer();
    const probe: PeerProbe = { ...idleProbe, registry: () => idleProbe.registry().map((r) => ({ ...r, status: busy ? "busy" : "idle" })) };
    const launched: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => { launched.push(name); return { exitCode: 0, errorText: "" }; };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher, peerProbe: probe });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine(startLine("S1", { peerCheck: true }));
      const first = decodeControlMessage(await engine.lines.nextOfType("session_peer_conflict")) as { token: string };
      busy = true;
      engine.writeLine(startLine("S2", { peerCheck: true, takeOver: { token: first.token } }));
      const again = decodeControlMessage(await engine.lines.nextOfType("session_peer_conflict"));
      expect(again).toMatchObject({ id: "S2", busy: true, canTakeOver: true });
      expect((again as { reason?: string }).reason).toContain("処理中");
      expect(launched).toEqual([]);
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("公式アプリにつながっている相手は開き直せず、並走の確認だけ求める", async () => {
    const { store, sessionManager } = backends();
    const base = terminalPeer();
    const probe: PeerProbe = { ...base, registry: () => base.registry().map((r) => ({ ...r, bridged: true })) };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher: async () => ({ exitCode: 0, errorText: "" }), peerProbe: probe });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine(startLine("S1", { peerCheck: true }));
      expect(decodeControlMessage(await engine.lines.nextOfType("session_peer_conflict")))
        .toMatchObject({ holder: "remote", canTakeOver: false });
    } finally {
      await engine.teardown();
    }
  }, 15_000);
});

describe("この会話の Tailii のセッション自身が掴んでいるとき", () => {
  /** Tailii が起動した Claude（引数のフック設定に s-own）が CONV を掴んでいる。 */
  function ownTailii(): PeerProbe {
    const base = terminalPeer();
    return { ...base, args: async (pid) => (pid === 400 ? "-zsh" : 'claude --settings {"command":"cli.js hook --session s-own"}') };
  }

  test.each([
    { label: "開こうとしている名前そのもの", requested: "s-own" },
    { label: "別の名前でも、メタがこの会話を記録している", requested: "s-other1" },
  ])("確認せずに開く: $label（2026-11-14 実機: 開いている会話を開けなくなった）", async ({ requested }) => {
    const { store, sessionManager } = backends();
    store.put({ name: "s-own", cwd: "/w", createdAt: 1, backend: "herdr", herdrPaneId: "w1:p1", claudeSessionId: CONV, providerSessionId: CONV });
    const launched: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => {
      launched.push(name);
      store.put({ name, cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: CONV });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher, peerProbe: ownTailii() });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine(JSON.stringify({
        type: "session_start", v: 1, id: "S1", cwd: "/w", name: requested, resumeSessionId: CONV, deferSubscribe: true, peerCheck: true,
      }));
      await expect.poll(() => launched, { timeout: 5_000 }).toEqual([requested]);
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("Tailii の別の会話の中で /resume された（メタの会話が違う）なら確認を求める", async () => {
    const { store, sessionManager } = backends();
    store.put({ name: "s-own", cwd: "/w", createdAt: 1, backend: "herdr", claudeSessionId: "conv-else", providerSessionId: "conv-else" });
    const engine = startEngine({ sessionManager, metadataStore: store, launcher: async () => ({ exitCode: 0, errorText: "" }), peerProbe: ownTailii() });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine(startLine("S1", { peerCheck: true }));
      expect(decodeControlMessage(await engine.lines.nextOfType("session_peer_conflict")))
        .toMatchObject({ holder: "tailii", canTakeOver: false });
    } finally {
      await engine.teardown();
    }
  }, 15_000);
});

describe("session_reattach の自動再起動", () => {
  test("pane が無くても、他所で同じ会話が動いていれば再起動しない", async () => {
    const { store, sessionManager } = backends();
    store.put({ name: "s-gone0001", cwd: "/w", createdAt: 1, backend: "herdr", herdrPaneId: "w1:p1", claudeSessionId: CONV });
    const launched: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => { launched.push(name); return { exitCode: 0, errorText: "" }; };
    const engine = startEngine({
      sessionManager, metadataStore: store, launcher, resumeLauncher: launcher, peerProbe: terminalPeer(),
    });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"id":"R1","name":"s-gone0001","type":"session_reattach","v":1}');
      expect(decodeControlMessage(await engine.lines.nextOfType("error")))
        .toMatchObject({ id: "R1", code: "peer_running", message: PEER_RUNNING_MESSAGE });
      expect(launched).toEqual([]);
    } finally {
      await engine.teardown();
    }
  }, 15_000);
});
