// conversationDelete.test.ts — 会話の完全削除（conversation-delete）の判定順序

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { SessionInfo } from "../src/protocol.js";
import {
  CONVERSATION_DELETE_MESSAGES,
  deleteConversation,
  type ConversationDeleteDeps,
} from "../src/sessions/conversationDelete.js";
import { makeTempDir } from "./helpers.js";

const ID = "78787878-9090-1212-3434-565656565656";

function writeRecord(dir: string, record: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, `${record["pid"] as number}.json`), JSON.stringify({
    sessionId: ID, cwd: "/tmp/proj", status: "idle", ...record,
  }));
}

function holder(name: string, backend: "tmux" | "herdr" = "tmux"): SessionInfo {
  return { name, cwd: "/tmp/proj", alive: true, agent: "claude", claudeSessionId: ID, backend };
}

/**
 * 既定の依存。pid は「kill されたセッションの claude だけ死ぬ」世界を模す
 * （killed に入った名前の pane の pid を死亡扱いにする）。
 */
function makeDeps(overrides: Partial<ConversationDeleteDeps> & {
  sessions?: SessionInfo[];
  paneOf?: Record<string, number>;
} = {}): ConversationDeleteDeps & { killed: string[]; deletedClaude: string[]; deletedCodex: string[] } {
  const killed: string[] = [];
  const deletedClaude: string[] = [];
  const deletedCodex: string[] = [];
  const sessions = overrides.sessions ?? [];
  const paneOf = overrides.paneOf ?? {};
  const deps: ConversationDeleteDeps = {
    sessionId: ID,
    agent: "claude",
    listSessions: async () => sessions.filter((info) => !killed.includes(info.name)),
    killSession: async (name) => {
      killed.push(name);
    },
    paneProcessIds: async (name) => (paneOf[name] !== undefined ? [paneOf[name]!] : null),
    claudeSessionsDir: makeTempDir("tailii-cd-registry"),
    deleteClaude: (id) => {
      deletedClaude.push(id);
      return [id];
    },
    deleteCodex: async (id) => {
      deletedCodex.push(id);
    },
    log: () => {},
    peerPidAlive: () => true,
    processAlive: async (pid) => !Object.entries(paneOf).some(([name, p]) => p === pid && killed.includes(name)),
    exitWaitMs: 300,
    exitPollMs: 10,
    ...overrides,
  };
  return Object.assign(deps, { killed, deletedClaude, deletedCodex });
}

describe("deleteConversation", () => {
  test("tmux 欄で Tailii のセッションと照合できた claude は終了を待ってから消す", async () => {
    const deps = makeDeps({ sessions: [holder("cs-a")], paneOf: { "cs-a": 4101 } });
    writeRecord(deps.claudeSessionsDir, { pid: 4101, name: "code-a", tmux: "cs-a:@1.%1" });

    expect(await deleteConversation(deps)).toBeNull();
    expect(deps.killed).toEqual(["cs-a"]);
    expect(deps.deletedClaude).toEqual([ID]);
  });

  test("herdr は pane の前面 pid で照合する（同一会話の第 2 インスタンスも全部終了）", async () => {
    const deps = makeDeps({
      sessions: [holder("s-1", "herdr"), holder("cs-2", "herdr")],
      paneOf: { "s-1": 4201, "cs-2": 4202 },
    });
    writeRecord(deps.claudeSessionsDir, { pid: 4201, name: "one" });
    writeRecord(deps.claudeSessionsDir, { pid: 4202, name: "two" });

    expect(await deleteConversation(deps)).toBeNull();
    expect(deps.killed).toEqual(["s-1", "cs-2"]);
    expect(deps.deletedClaude).toEqual([ID]);
  });

  test("Tailii 外の claude が 1 つでもいれば、Tailii 側も終了せずに断る", async () => {
    const deps = makeDeps({ sessions: [holder("cs-a")], paneOf: { "cs-a": 4301 } });
    writeRecord(deps.claudeSessionsDir, { pid: 4301, name: "code-a", tmux: "cs-a:@1.%1" });
    writeRecord(deps.claudeSessionsDir, { pid: 4302, name: "mac-terminal" });

    const result = await deleteConversation(deps);
    expect(result).toContain("Tailii 以外");
    expect(result).toContain("mac-terminal");
    expect(result).not.toContain("code-a");
    expect(deps.killed).toEqual([]);
    expect(deps.deletedClaude).toEqual([]);
  });

  test("照合できない（tmux 欄なし・pane pid も取れない）claude は Tailii 外として断る", async () => {
    const deps = makeDeps({ sessions: [holder("cs-a")] });
    writeRecord(deps.claudeSessionsDir, { pid: 4401, name: "unknown" });

    expect(await deleteConversation(deps)).toContain("Tailii 以外");
    expect(deps.killed).toEqual([]);
  });

  test("name / cwd / status の無い旧形式の記録も見落とさない（pid と sessionId だけで判定）", async () => {
    const deps = makeDeps();
    fs.writeFileSync(path.join(deps.claudeSessionsDir, "4471.json"), JSON.stringify({ pid: 4471, sessionId: ID }));

    expect(await deleteConversation(deps)).toContain("pid 4471");
    expect(deps.deletedClaude).toEqual([]);
  });

  test("登録簿の pid が死んでいれば Tailii 外の判定に含めない", async () => {
    const deps = makeDeps({ peerPidAlive: () => false });
    writeRecord(deps.claudeSessionsDir, { pid: 4451, name: "stale" });

    expect(await deleteConversation(deps)).toBeNull();
    expect(deps.deletedClaude).toEqual([ID]);
  });

  test("終了を待ちきれなければ消さずに断る", async () => {
    const deps = makeDeps({
      sessions: [holder("cs-a")],
      paneOf: { "cs-a": 4501 },
      processAlive: async () => true,
    });
    writeRecord(deps.claudeSessionsDir, { pid: 4501, name: "code-a", tmux: "cs-a:@1.%1" });

    expect(await deleteConversation(deps)).toBe(CONVERSATION_DELETE_MESSAGES.exitTimeout);
    expect(deps.killed).toEqual(["cs-a"]);
    expect(deps.deletedClaude).toEqual([]);
  });

  test("kill が失敗してもセッションが既に居なければ続行し、居続けるなら定型文で断る", async () => {
    const gone = makeDeps({ sessions: [holder("cs-a")] });
    gone.killSession = async (name) => {
      gone.killed.push(name);
      throw new Error("tmux kill-session -t cs-a failed (exit 1): can't find session");
    };
    expect(await deleteConversation(gone)).toBeNull();
    expect(gone.deletedClaude).toEqual([ID]);

    const stuck = makeDeps({ sessions: [holder("cs-a")] });
    stuck.killSession = async () => {
      throw new Error("tmux kill-session -t cs-a failed (exit 1)");
    };
    expect(await deleteConversation(stuck)).toBe(CONVERSATION_DELETE_MESSAGES.killFailed);
    expect(stuck.deletedClaude).toEqual([]);
  });

  test("Codex は収容中の Tailii セッションを終了してから thread を消す（登録簿は見ない）", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      agent: "codex",
      sessions: [{ name: "s-x", cwd: "/tmp", alive: true, agent: "codex", providerSessionId: ID }],
    });
    writeRecord(deps.claudeSessionsDir, { pid: 4601, name: "claude-same-id" });
    deps.killSession = async (name) => {
      order.push(`kill:${name}`);
    };
    deps.deleteCodex = vi.fn(async (id: string) => {
      order.push(`delete:${id}`);
    });

    expect(await deleteConversation(deps)).toBeNull();
    expect(order).toEqual(["kill:s-x", `delete:${ID}`]);
  });

  test("UUID でない id・扱えない agent は何もせず断る", async () => {
    const invalid = makeDeps({ sessionId: "../x" });
    expect(await deleteConversation(invalid)).toBe(CONVERSATION_DELETE_MESSAGES.invalidId);
    const noCodex = makeDeps({ agent: "codex", deleteCodex: null });
    expect(await deleteConversation(noCodex)).toBe(CONVERSATION_DELETE_MESSAGES.codexUnavailable);
    expect(noCodex.killed).toEqual([]);
  });
});
