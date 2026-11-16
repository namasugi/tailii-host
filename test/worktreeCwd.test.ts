// ワークツリーを片付けた会話の一覧・開き直し・会話中のフォルダ通知を揃える。
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveConversationPlacement } from "../src/apiAgent/transcriptPlacement.js";
import { ChatTailController } from "../src/chat/chatTailController.js";
import { SubagentTailer } from "../src/chat/subagentTailer.js";
import { TranscriptTailer, type ClaudeTurnLifecycleEvent } from "../src/chat/transcriptTailer.js";
import { rescueMissingWorktreeCwd } from "../src/commands/launch.js";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { settleWorktreeAfterKill } from "../src/engine/worktreeJanitor.js";
import { gitHandlers } from "../src/engine/handlers/git.js";
import type { HandlerContext } from "../src/engine/context.js";
import { decodeHubServerLine, type HubServerMessage } from "../src/hub/hubProtocol.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { gitStatus, gitWorktreeCreate, gitWorktreeRemove } from "../src/services/gitService.js";
import { ClaudeSessionStore } from "../src/sessions/claudeSessionStore.js";
import { moveClaudeTranscript } from "../src/sessions/claudeTranscriptLocator.js";
import { claudeProjectSlug, missingWorktreeFallback } from "../src/shared/paths.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";

const ID = "8636fd09-97d8-48d0-b69b-47adc144cfa8";
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const user = (cwd: string) => line({ type: "user", cwd, sessionId: ID,
  timestamp: "2026-11-16T00:00:00.000Z", message: { role: "user", content: "作業を続ける" } });

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function repository(branch = "main") {
  const root = fs.realpathSync(makeTempDir("worktree-cwd"));
  git(root, "init", "-b", branch);
  git(root, "config", "user.name", "Tailii Test");
  git(root, "config", "user.email", "tailii@example.invalid");
  fs.writeFileSync(path.join(root, "f.txt"), "one\n");
  git(root, "add", "f.txt");
  git(root, "commit", "-m", "initial");
  const created = await gitWorktreeCreate(root, branch);
  expect(created.ok).toBe(true);
  return { root, worktree: fs.realpathSync(created.worktreePath), branch: created.branch };
}

function transcript(projects: string, cwd: string, body = user(cwd)): string {
  const file = path.join(projects, claudeProjectSlug(cwd), `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe("削除済みワークツリーの会話", () => {
  test("終了時の自動削除後、メモ済みの一覧も本体へ戻り、開き直しても同じブランチを使う", async () => {
    const { root, worktree } = await repository("develop");
    const projects = makeTempDir("worktree-cwd-projects");
    const file = transcript(projects, worktree);
    const store = new ClaudeSessionStore(projects);
    const registry = makeTempDir("worktree-cwd-registry");
    vi.stubEnv("TAILII_CLAUDE_SESSIONS_DIR", registry);
    try {
      const before = store.list();
      expect(before[0]?.cwd).toBe(worktree);
      const ctx = { sessionManager: { list: async () => [] }, metadataStore: null,
        claudeSessionStore: store, codexSessionStore: null } as unknown as HandlerContext;
      expect(await settleWorktreeAfterKill(ctx, { name: "work", cwd: worktree, conversationId: ID }))
        .toMatchObject({ worktreeRemoved: true });
      expect(store.list()[0]).toEqual({ ...before[0], cwd: root });
      expect(store.list(worktree)).toEqual([]);
      expect(fs.existsSync(file)).toBe(true, "一覧取得ではログを移さない");
      expect(rescueMissingWorktreeCwd({ cwd: worktree, claudeSessionId: ID, projectsDir: projects })).toBe(root);
      expect(store.list()[0]?.cwd).toBe(root);
      expect(await gitStatus(root)).toMatchObject({ isRepo: true, branch: "develop" });
      expect(store.transcriptPath(ID, root)).toBe(path.join(projects, claudeProjectSlug(root), `${ID}.jsonl`));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("強制削除後も本体へ戻る。削除せず保持したワークツリーは表示を保つ", async () => {
    const { root, worktree } = await repository();
    const projects = makeTempDir("worktree-cwd-dirty-projects");
    transcript(projects, worktree);
    const conversations = new ClaudeSessionStore(projects);
    fs.appendFileSync(path.join(worktree, "f.txt"), "pending\n");
    expect((await gitWorktreeRemove(worktree, false)).ok).toBe(false);
    expect(conversations.list()[0]?.cwd).toBe(worktree);
    expect((await gitWorktreeRemove(worktree, true)).ok).toBe(true);
    expect(conversations.list()[0]?.cwd).toBe(root);
  });

  test("Codex のメモ済み rollout も削除の前後で切り替わり、同じ場所の再作成も検出する", async () => {
    const { root, worktree } = await repository();
    const home = makeTempDir("worktree-cwd-codex");
    const dir = path.join(home, "sessions", "2026", "11", "16");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-11-16T00-00-00-${ID}.jsonl`),
      line({ type: "session_meta", payload: { id: ID, cwd: worktree } }) +
      line({ type: "event_msg", payload: { type: "user_message", message: "hi" } }));
    const store = new CodexSessionStore(home);
    expect(store.list()[0]?.cwd).toBe(worktree);
    expect(await store.latestActivity(worktree)).not.toBeNull();
    expect((await gitWorktreeRemove(worktree, false)).ok).toBe(true);
    expect(store.list()[0]?.cwd).toBe(root);
    expect(store.list(worktree)).toEqual([]);
    expect(await store.latestActivity(root)).not.toBeNull();
    expect(await store.latestActivity(worktree)).toBeNull();
    git(root, "worktree", "add", worktree, "-b", "recreated", "main");
    expect(store.list()[0]?.cwd).toBe(worktree);
  });

  test.each([false, true])("API 作業も削除後は本体で再開する（記録を先に更新済み: %s）", async (alreadyUpdated) => {
    const { root, worktree } = await repository();
    const projects = makeTempDir("worktree-cwd-api-projects");
    transcript(projects, worktree);
    expect((await gitWorktreeRemove(worktree, false)).ok).toBe(true);
    const placement = resolveConversationPlacement(ID, alreadyUpdated ? root : worktree, { projectsDir: projects });
    expect(placement.cwd).toBe(root);
    expect(placement.launchCwd).toBe(root);
    expect(placement.transcriptPath).toBe(path.join(projects, claudeProjectSlug(root), `${ID}.jsonl`));
    expect(new ClaudeSessionStore(projects).list()[0]?.cwd).toBe(root);
  });

  test("消えた普通のフォルダ・生きている worktree 内の消えたサブフォルダは本体へ振り替えない", async () => {
    const { root, worktree } = await repository();
    expect(missingWorktreeFallback(path.join(root, "gone"))).toBeNull();
    expect(missingWorktreeFallback(path.join(worktree, "gone"))).toBeNull();
    expect(missingWorktreeFallback("relative/.claude/worktrees/gone")).toBeNull();
    expect(missingWorktreeFallback("/missing-repo/.claude/worktrees/gone")).toBeNull();
  });

  test("入れ子の子 worktree を削除したら親へ、親も削除したら本体へ戻す", async () => {
    const { root, worktree, branch } = await repository();
    const nested = path.join(worktree, ".claude/worktrees/child");
    git(root, "worktree", "add", nested, "-b", "nested-child", "main");
    expect(missingWorktreeFallback(nested)).toBeNull();
    git(root, "worktree", "remove", nested);
    expect(missingWorktreeFallback(nested)).toBe(worktree);
    expect((await gitStatus(missingWorktreeFallback(nested)!)).branch).toBe(branch);
    expect((await gitWorktreeRemove(worktree, false)).ok).toBe(true);
    expect(missingWorktreeFallback(nested)).toBe(root);
  });

  test("アプリからの削除は、停止中の開いた会話にもすぐ戻り先を通知する", async () => {
    const { root, worktree } = await repository();
    const metadata = makeTempStore();
    metadata.put({ name: "work", cwd: worktree, createdAt: 0, claudeSessionId: ID });
    const sent: unknown[] = [];
    const responses: unknown[] = [];
    const ctx = { metadataStore: metadata, state: { negotiatedVersion: 2 },
      writer: { write: (message: unknown) => responses.push(message) },
      hubLink: { send: (message: unknown) => sent.push(message) },
    } as unknown as HandlerContext;
    await gitHandlers.git_worktree_remove_request!({
      type: "git_worktree_remove_request", v: 2, id: "remove", path: worktree, force: false,
    } as never, ctx);
    expect(responses).toContainEqual(expect.objectContaining({ type: "git_worktree_remove_response", ok: true }));
    expect(metadata.get("work")?.cwd).toBe(root);
    expect(sent).toContainEqual(expect.objectContaining({ type: "session_cwd_set", session: "work", cwd: root }));
  });
});

function cwdEvents(received: HubServerMessage[]): string[] {
  return received.flatMap((message) => message.type === "conversation_event" &&
    message.payload.type === "chat_output" && message.payload.streamId === "pc:cwd" ? [message.payload.text] : []);
}

describe("会話中のワークツリーとブランチ", () => {
  test("フォルダだけの削除でもターン終了で本体を通知し、古い移動通知で削除済みパスへ戻さない", async () => {
    const { root, worktree } = await repository();
    const metadata = makeTempStore();
    metadata.put({ name: "work", cwd: worktree, createdAt: 0, claudeSessionId: ID });
    const received: HubServerMessage[] = [];
    let lifecycle: ((event: ClaudeTurnLifecycleEvent) => void) | undefined;
    let replayDone: (() => void) | undefined;
    const hub = new SessionHub({ runner: async () => ok(""), metadataStore: metadata,
      heartbeatDir: makeTempDir("worktree-cwd-done-hb"), timeoutSeconds: 1800,
      tailFactory: (write, _codex, onClaudeTurnLifecycle) => ({
        open() {
          lifecycle = onClaudeTurnLifecycle;
          replayDone = () => write({ type: "chat_output", v: 1,
            streamId: "pc:history-done", role: "system", text: "0", eof: true });
        },
        stop() {},
      }),
    });
    const client = {};
    hub.registerClient(client, (raw) => {
      const message = decodeHubServerLine(raw);
      if (message !== null) received.push(message);
    });
    const send = (message: Record<string, unknown>) => hub.handleClientMessage(client, JSON.stringify(message));
    try {
      send({ type: "conversation_subscribe", session: "work" });
      replayDone!();
      expect(cwdEvents(received)).toEqual([worktree]);
      send({ type: "session_processing", session: "work", state: "active", event: "UserPromptSubmit" });
      expect((await gitWorktreeRemove(worktree, false)).ok).toBe(true);
      send({ type: "session_processing", session: "work", state: "done", event: "Stop" });
      expect(cwdEvents(received)).toEqual([worktree, root]);
      expect(metadata.get("work")?.cwd).toBe(root);
      lifecycle!({ kind: "relocated", atMs: Date.now(), cwd: worktree, live: true });
      expect(cwdEvents(received)).toEqual([worktree, root]);
      expect((await gitStatus(metadata.get("work")!.cwd)).branch).toBe("main");
    } finally {
      send({ type: "conversation_unsubscribe", session: "work" });
      hub.unregisterClient(client);
    }
  });

  test("親の開始・終了に追従し、子だけのワークツリーでは親のブランチを変えない", async () => {
    const { root, worktree, branch } = await repository();
    const projects = path.join(os.homedir(), ".claude", "projects");
    transcript(projects, root, user(root) + line({ type: "assistant", sessionId: ID,
      timestamp: "2026-11-16T00:00:01.000Z", message: { role: "assistant", content: [
        { type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "子の作業", isolation: "worktree" } },
      ] } }));
    const metadata = makeTempStore();
    metadata.put({ name: "work", cwd: root, createdAt: 0, claudeSessionId: ID });
    const received: HubServerMessage[] = [];
    const hub = new SessionHub({ runner: async () => ok(""), metadataStore: metadata,
      heartbeatDir: makeTempDir("worktree-cwd-hb"), timeoutSeconds: 1800,
      tailFactory: (write, _codex, onClaudeTurnLifecycle) => new ChatTailController({
        writer: { write }, projectsRoot: projects, protocolVersion: () => 2,
        tailer: new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true, pollIntervalMs: 10 }),
        subagentTailer: new SubagentTailer({ pollIntervalMs: 10, probeSessionAlive: async () => true, codexExecLinker: null }),
        onClaudeTurnLifecycle,
      }),
    });
    const client = {};
    hub.registerClient(client, (raw) => {
      const message = decodeHubServerLine(raw);
      if (message !== null) received.push(message);
    });
    const send = (message: Record<string, unknown>) => hub.handleClientMessage(client, JSON.stringify(message));
    try {
      send({ type: "conversation_subscribe", session: "work" });
      await vi.waitFor(() => expect(cwdEvents(received).at(-1)).toBe(root));
      const childDir = path.join(projects, claudeProjectSlug(root), ID, "subagents");
      fs.mkdirSync(childDir, { recursive: true });
      fs.writeFileSync(path.join(childDir, "agent-child.meta.json"), JSON.stringify({
        agentType: "general-purpose", description: "子の作業", toolUseId: "toolu_child", spawnDepth: 1,
      }));
      fs.writeFileSync(path.join(childDir, "agent-child.jsonl"),
        line({ type: "relocated", sessionId: ID, relocatedCwd: worktree }) +
        line({ type: "user", agentId: "child", isSidechain: true, cwd: worktree,
          timestamp: "2026-11-16T00:00:02.000Z", message: { role: "user", content: "子の作業" } }));
      await vi.waitFor(() => expect(received.some((m) => m.type === "conversation_event" &&
        m.payload.type === "subagent_node" && m.payload.node.nodeId === "child")).toBe(true));
      expect(cwdEvents(received)).toEqual([root]);
      expect(metadata.get("work")?.cwd).toBe(root);
      expect((await gitStatus(metadata.get("work")!.cwd)).branch).toBe("main");

      // 親自身が EnterWorktree / ExitWorktree で移るときの実際のログ移動を再現する。
      expect(moveClaudeTranscript({ conversationId: ID, fromCwd: root, toCwd: worktree, projectsDir: projects }).status).toBe("moved");
      await vi.waitFor(() => expect(cwdEvents(received).at(-1)).toBe(worktree));
      expect((await gitStatus(metadata.get("work")!.cwd)).branch).toBe(branch);
      expect(moveClaudeTranscript({ conversationId: ID, fromCwd: worktree, toCwd: root, projectsDir: projects }).status).toBe("moved");
      expect((await gitWorktreeRemove(worktree, false)).ok).toBe(true);
      await vi.waitFor(() => expect(cwdEvents(received).at(-1)).toBe(root));
      expect((await gitStatus(metadata.get("work")!.cwd)).branch).toBe("main");
      expect(new ClaudeSessionStore(projects).list().find((row) => row.sessionId === ID)?.cwd).toBe(root);
    } finally {
      send({ type: "conversation_unsubscribe", session: "work" });
      hub.unregisterClient(client);
      fs.rmSync(path.join(projects, claudeProjectSlug(root), `${ID}.jsonl`), { force: true });
      fs.rmSync(path.join(projects, claudeProjectSlug(root), ID), { force: true, recursive: true });
    }
  });
});
