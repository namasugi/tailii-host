// peerSessions.test.ts — `~/.claude/sessions` 登録簿の読取と会話一覧への注記（peer-sessions / peer-live）
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  annotatePeerSessions,
  listPeerSessions,
  parsePeerSessionRecord,
} from "../src/services/peerSessions.js";

const RECORD = {
  pid: 23402,
  sessionId: "40efa4d9-f293-4b12-a1f8-73abb5e75023",
  cwd: "/Users/alice/work",
  startedAt: 1789328831023,
  version: "2.1.270",
  kind: "interactive",
  entrypoint: "cli",
  messagingSocketPath: "/tmp/cc-socks/23402.sock",
  name: "work-d2",
  nameSource: "derived",
  status: "busy",
  bridgeSessionId: "session_01X",
};

describe("parsePeerSessionRecord", () => {
  it("実測形を読む（bridgeSessionId あり = Remote Control 接続中）", () => {
    expect(parsePeerSessionRecord(RECORD)).toEqual({
      pid: 23402,
      sessionId: RECORD.sessionId,
      cwd: "/Users/alice/work",
      name: "work-d2",
      status: "busy",
      kind: "interactive",
      entrypoint: "cli",
      bridged: true,
      messagingSocketPath: "/tmp/cc-socks/23402.sock",
      startedAt: 1789328831023,
    });
  });

  it("必須欠落・不正は null", () => {
    expect(parsePeerSessionRecord(null)).toBeNull();
    expect(parsePeerSessionRecord({ ...RECORD, pid: "x" })).toBeNull();
    expect(parsePeerSessionRecord({ ...RECORD, name: "" })).toBeNull();
    const { bridgeSessionId: _b, ...noBridge } = RECORD;
    expect(parsePeerSessionRecord(noBridge)?.bridged).toBe(false);
  });
});

describe("listPeerSessions", () => {
  it("生存 pid の登録簿だけを名前順で返し、壊れた JSON / .key / 死亡 pid は飛ばす", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-peers-"));
    try {
      fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ ...RECORD, pid: 1, name: "zeta" }));
      fs.writeFileSync(path.join(dir, "2.json"), JSON.stringify({ ...RECORD, pid: 2, name: "alpha", sessionId: "s2" }));
      fs.writeFileSync(path.join(dir, "3.json"), JSON.stringify({ ...RECORD, pid: 3, name: "dead", sessionId: "s3" }));
      fs.writeFileSync(path.join(dir, "4.json"), "{not json");
      fs.writeFileSync(path.join(dir, "1.abc.key"), "secret");
      const peers = listPeerSessions({ dir, isPidAlive: (pid) => pid !== 3 });
      expect(peers.map((p) => p.name)).toEqual(["alpha", "zeta"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ディレクトリが無ければ空", () => {
    expect(listPeerSessions({ dir: "/nonexistent/tailii-peers", isPidAlive: () => true })).toEqual([]);
  });
});

describe("annotatePeerSessions", () => {
  const peers = [
    parsePeerSessionRecord({ ...RECORD, pid: 10, name: "term-1", sessionId: "conv-a" })!,
    { ...parsePeerSessionRecord({ ...RECORD, pid: 11, name: "plain-2", sessionId: "conv-a" })!, bridged: false },
    { ...parsePeerSessionRecord({ ...RECORD, pid: 12, name: "cli-3", sessionId: "conv-b" })!, bridged: false },
  ];

  it("Tailii の pane を持つ行には付けず、外部 CLI が掴む行に名前と bridged を注記する", () => {
    const rows = [
      { sessionId: "conv-a", cwd: "/w", title: "a" },
      { sessionId: "conv-b", cwd: "/w", title: "b", liveSessionName: "cs-conv-b" },
      { sessionId: "conv-c", cwd: "/w", title: "c" },
      { sessionId: "conv-a", cwd: "/w", title: "codex", agent: "codex" as const },
    ];
    const out = annotatePeerSessions(rows, peers);
    // 複数 CLI が同じ会話を掴むときは Remote Control 接続を優先する。
    expect(out[0]).toEqual({ sessionId: "conv-a", cwd: "/w", title: "a", peerSessionName: "term-1", peerBridged: true });
    expect(out[1]).toEqual(rows[1]);
    expect(out[2]).toEqual(rows[2]);
    expect(out[3]).toEqual(rows[3]);
  });

  it("bridged でない外部 CLI は peerBridged を載せない", () => {
    const out = annotatePeerSessions([{ sessionId: "conv-b", cwd: "/w", title: "b" }], peers);
    expect(out[0]).toEqual({ sessionId: "conv-b", cwd: "/w", title: "b", peerSessionName: "cli-3" });
  });
});
