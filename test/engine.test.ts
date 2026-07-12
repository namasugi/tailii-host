// engine.test.ts — EngineControl（engine サブコマンド）テスト
// Swift 版 EngineTests.swift の移植。in-memory ストリームで入力行を流し込み、出力行を検証する。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  CodexAppServerManager,
  type CodexAppServerThreadOptions,
} from "../src/codexAppServer.js";
import { ImageService } from "../src/imageService.js";
import {
  sendQuestionEventToEngine,
  sendRemotePendingToEngine,
  sendSessionProcessingToEngine,
} from "../src/engineRelaySocket.js";
import type { EngineLauncher } from "../src/launch.js";
import type { CodexTurnControllerRuntime } from "../src/codexNativeTurnController.js";
import type { HubLink } from "../src/hubClient.js";
import { ClaudeSessionStore } from "../src/claudeSessionStore.js";
import { decodeControlMessage } from "../src/protocol.js";
import { readHeartbeat } from "../src/heartbeat.js";
import { TranscriptTailer } from "../src/transcriptTailer.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { SessionHub } from "../src/sessionHub.js";
import { injectQuestionAnswers } from "../src/questionInjection.js";
import { readPackageVersion } from "../src/version.js";
import {
  MockTmuxRunner,
  makeTempDir,
  makeTempStore,
  ok,
  startEngine,
  waitForCommand,
} from "./helpers.js";
import { canListenUnixSocket, tempSocketPath } from "./socketHelpers.js";

function makeManager(runner: MockTmuxRunner, store = makeTempStore()): TmuxSessionManager {
  return new TmuxSessionManager({ runner: runner.runner, store });
}

function makeQuestionHub(manager: TmuxSessionManager, id: string): SessionHub {
  const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("question-hub"),
    metadataStore: manager.store, timeoutSeconds: 1800,
    questionInjector: (answers, session) => injectQuestionAnswers(answers, session, manager) });
  hub.handleRelayMessage({ type: "question_event", session: "work", event: "prompt", id,
    questions: [{ header: "h", question: "q", options: [], multiSelect: false }] });
  return hub;
}

describe("EngineControl — 横断制御チャネル", () => {
  test("再オープン時と live 更新で現在会話の処理中状態を iOS へ同期する", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 1, agent: "claude" });
    const hub = new SessionHub({
      runner: async () => ok(""),
      heartbeatDir: makeTempDir("processing-state-hub"),
      metadataStore: store,
      timeoutSeconds: 1_800,
    });
    hub.handleRelayMessage({ type: "session_processing", session: "work", state: "active" });
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("work\n") : ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      hub,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"open","name":"work","type":"session_reattach","v":2}');
    await engine.lines.nextOfType("session_list_response");
    expect(decodeControlMessage(
      await engine.lines.nextOfType("session_processing_state"),
    )).toEqual({
      type: "session_processing_state", v: 2, session: "work", active: true,
    });

    hub.handleRelayMessage({ type: "session_processing", session: "work", state: "done" });
    expect(decodeControlMessage(
      await engine.lines.nextOfType("session_processing_state"),
    )).toEqual({
      type: "session_processing_state", v: 2, session: "work", active: false,
    });
    await engine.teardown();
  });

  test("subagent transcript 全文要求を現在会話の Hub tail へ中継する", async () => {
    const store = makeTempStore();
    store.put({
      name: "work",
      cwd: "/tmp/work",
      createdAt: 1,
      agent: "claude",
      providerSessionId: "provider-1",
    });
    const transcript = vi.fn(() => ({
      entries: [
        { role: "user" as const, text: "調査して", ts: 1_000 },
        { role: "assistant" as const, text: "完了しました", ts: 2_000 },
      ],
      omitted: 3,
    }));
    const tail: import("../src/sessionHub.js").HubTail = {
      open: vi.fn(),
      stop: vi.fn(),
      subagentTranscript: transcript,
    };
    const hub = new SessionHub({
      runner: async () => ok(""),
      heartbeatDir: makeTempDir("subagent-transcript-hub"),
      metadataStore: store,
      timeoutSeconds: 1_800,
      tailFactory: () => tail,
    });
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("work\n") : ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      hub,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"open","name":"work","type":"session_reattach","v":2}');
    await engine.lines.nextOfType("session_list_response");
    engine.writeLine(
      '{"id":"transcript-1","nodeId":"agent-a","type":"subagent_transcript_request","v":2}',
    );

    expect(decodeControlMessage(
      await engine.lines.nextOfType("subagent_transcript_response"),
    )).toEqual({
      type: "subagent_transcript_response",
      v: 2,
      id: "transcript-1",
      nodeId: "agent-a",
      entries: [
        { role: "user", text: "調査して", ts: 1_000 },
        { role: "assistant", text: "完了しました", ts: 2_000 },
      ],
      omitted: 3,
    });
    expect(transcript).toHaveBeenCalledWith("agent-a");
    await engine.teardown();
  });

  test("Hub 世代変更時は旧 afterSeq を捨て、切断時刻から再購読する", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 1, agent: "claude",
      providerSessionId: "provider-1" });
    const sent: unknown[] = [];
    const hubLink: HubLink = {
      onMessage: null, onReconnect: null,
      send(message) {
        sent.push(message);
        if (message.type === "hub_state_request") queueMicrotask(() => hubLink.onMessage?.({
          type: "hub_state_response", id: message.id, session: message.session,
          pendingQuestion: null, processing: false,
        }));
      },
      close: vi.fn(),
    };
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("work\n") : ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner, store), metadataStore: store, hubLink });
    await engine.lines.nextOfType("channel_hello");
    hubLink.onReconnect?.({ bootId: "boot-a", disconnectedAtMs: null });
    engine.writeLine('{"id":"open","name":"work","type":"session_reattach","v":2}');
    await engine.lines.nextOfType("session_list_response");
    hubLink.onMessage?.({ type: "conversation_event", session: "work", serverSeq: 7,
      payload: { type: "chat_output", v: 1, streamId: "visible", role: "assistant", text: "visible", eof: true } });
    await engine.lines.nextOfType("chat_output");

    sent.length = 0;
    hubLink.onReconnect?.({ bootId: "boot-a", disconnectedAtMs: 1_000 });
    expect(sent).toContainEqual({
      type: "conversation_subscribe", session: "work", afterSeq: 7, preview: true,
    });

    sent.length = 0;
    hubLink.onReconnect?.({ bootId: "boot-b", disconnectedAtMs: 2_000 });
    expect(sent).toEqual([{
      type: "conversation_subscribe", session: "work", newerThanMs: 2_000, preview: true,
    }]);
    await engine.teardown();
  });

  test("chat_send を Hub へ転送し結果を中継する", async () => {
    const sent: unknown[] = [];
    const hubLink: HubLink = {
      onMessage: null, onReconnect: null,
      send(message) {
        sent.push(message);
        if (message.type === "chat_send") {
          queueMicrotask(() => hubLink.onMessage?.({
            type: "chat_send_result", id: message.id, status: "accepted",
          }));
        }
      },
      close: vi.fn(),
    };
    const engine = startEngine({ sessionManager: makeManager(new MockTmuxRunner(() => ok(""))), hubLink });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"clientMessageId":"client-1","id":"send-1","session":"work","text":"hello","type":"chat_send","v":2}');
    expect(decodeControlMessage(await engine.lines.nextOfType("chat_send_result"))).toMatchObject({
      type: "chat_send_result", id: "send-1", status: "accepted",
    });
    expect(sent).toContainEqual({ type: "chat_send", id: "send-1", session: "work",
      clientMessageId: "client-1", text: "hello" });
    await engine.teardown();
  });

  test("chat_send は Hub timeout 時に tmux へ fail-open 注入する", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const unavailableHub: HubLink = { onMessage: null, onReconnect: null, send: vi.fn(), close: vi.fn() };
    const engine = startEngine({ sessionManager: makeManager(runner), hubLink: unavailableHub });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"clientMessageId":"client-1","id":"send-1","session":"work","text":"hello","type":"chat_send","v":2}');
    expect(decodeControlMessage(await engine.lines.nextOfType("chat_send_result", 3_000))).toMatchObject({
      type: "chat_send_result", id: "send-1", status: "accepted",
    });
    // pane ID 未登録の store では paneTarget がセッション名へフォールバックする（tmux.ts）。
    expect(runner.recorded).toContainEqual(["send-keys", "-t", "work", "-l", "hello"]);
    expect(runner.recorded).toContainEqual(["send-keys", "-t", "work", "Enter"]);
    await engine.teardown();
  });

  test("codex セッションの chat_send は unsupported", async () => {
    const store = makeTempStore();
    store.put({ name: "codex-work", cwd: "/tmp/codex-work", createdAt: 1, agent: "codex" });
    const engine = startEngine({ sessionManager: makeManager(new MockTmuxRunner(() => ok("")), store),
      metadataStore: store });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"clientMessageId":"client-1","id":"send-1","session":"codex-work","text":"hello","type":"chat_send","v":2}');
    expect(decodeControlMessage(await engine.lines.nextOfType("error"))).toMatchObject({
      type: "error", id: "send-1", code: "chat_send_unsupported",
    });
    await engine.teardown();
  });

  // MARK: 1. channel_hello 交換

  test("engine は確立直後に channel_hello を送出し、相手 hello 受信後に採用版を決める", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    const hello = await engine.lines.nextOfType("channel_hello");
    expect(hello).toContain('"maxVersion":2');
    // serverVersion は package.json の実バージョンを載せる(ハードコードすると bump で壊れる)。
    expect(hello).toContain(`"serverVersion":"${readPackageVersion()}"`);
    expect(hello).toContain('"v":1');

    engine.writeLine('{"maxVersion":1,"type":"channel_hello","v":1}');
    await engine.teardown();
  });

  test("engine relay socket で受けた remote_pending を engine チャネルへ流す", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-remote-pending");
    fs.rmSync(relayPath, { force: true });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      engineRelaySocketPath: relayPath,
    });
    await engine.lines.nextOfType("channel_hello");

    await sendRemotePendingToEngine({
      type: "remote_pending",
      v: 1,
      id: "a1",
      session: "other",
      kind: "approval",
      tool: "Bash",
      summary: "Bash: echo hi",
    }, relayPath);

    expect(await engine.lines.nextOfType("remote_pending")).toBe(
      '{"id":"a1","kind":"approval","session":"other","summary":"Bash: echo hi","tool":"Bash","type":"remote_pending","v":2}',
    );
    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  test("tail 由来の question_prompt/question_dismiss は転送しない（回答済みの残骸のため）", async () => {
    // Claude Code は設問が未回答の間 transcript に tool_use 行を書かないため、transcript に
    // 現れる設問は常に回答済み。履歴 replay で流すと hook relay 由来の現行シートを
    // 上書き・消灯してしまう（再オープン時にモーダルが一瞬出て消えるバグの再発防止）。
    const projectsRoot = makeTempDir("tailii-question-projects");
    const cwd = makeTempDir("tailii-question-cwd");
    const slug = fs.realpathSync.native(cwd).replaceAll("/", "-");
    const projectDir = path.join(projectsRoot, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, "qsess.jsonl");
    // 回答済みの設問（tool_use + tool_result）を含む履歴。
    fs.writeFileSync(transcriptPath, [
      '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u0"}',
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_q_hist",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "どちらにしますか?",
                header: "選択",
                multiSelect: false,
                options: [{ label: "A", description: "前者" }],
              }],
            },
          }],
        },
        uuid: "a1",
      }),
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_q_hist","content":"answered"}]},"uuid":"u1"}',
      '{"message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"uuid":"a2"}',
    ].join("\n") + "\n");

    const store = makeTempStore();
    store.put({ name: "conv", cwd, createdAt: 1, agent: "claude", claudeSessionId: "qsess" });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("conv\n") : ok("")));
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      chatTailProjectsRoot: projectsRoot,
    });
    await engine.lines.nextOfType("channel_hello");

    // chat を開くと履歴 replay が走る。replay 完了（pc:history-done）までの全行を検分し、
    // question_prompt / question_dismiss が 1 行も転送されないことを確認する
    // （replay では設問イベントは history-done より前に現れるはずの位置関係）。
    engine.writeLine('{"id":"r1","name":"conv","type":"session_reattach","v":1}');
    for (;;) {
      const line = await engine.lines.next(5000);
      expect(line).not.toContain('"type":"question_prompt"');
      expect(line).not.toContain('"type":"question_dismiss"');
      if (line.includes("pc:history-done")) break;
    }

    await engine.teardown();
  });

  test("hook relay の question_event: 前面会話は question_prompt/question_dismiss として届ける", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-question-active");
    fs.rmSync(relayPath, { force: true });
    const store = makeTempStore();
    store.put({ name: "conv", cwd: "/tmp/conv", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("conv\n") : ok("")));
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      engineRelaySocketPath: relayPath,
    });
    await engine.lines.nextOfType("channel_hello");

    // chat を開いて conv を前面会話にする。
    engine.writeLine('{"id":"r1","name":"conv","type":"session_reattach","v":1}');
    await engine.lines.nextOfType("session_list_response");

    await sendQuestionEventToEngine({
      type: "question_event",
      session: "conv",
      event: "prompt",
      id: "toolu_qa",
      questions: [{
        header: "選択",
        question: "どっち?",
        multiSelect: false,
        options: [{ label: "A", description: "前者" }],
      }],
    }, relayPath);
    const prompt = await engine.lines.nextOfType("question_prompt");
    expect(prompt).toContain('"id":"toolu_qa"');
    expect(prompt).toContain("どっち?");

    await sendQuestionEventToEngine(
      { type: "question_event", session: "conv", event: "dismiss", id: "toolu_qa" },
      relayPath,
    );
    expect(await engine.lines.nextOfType("question_dismiss")).toContain('"id":"toolu_qa"');

    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  test("hook relay の question_event: 別会話は remote_pending(kind=question)/cleared に変換する", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-question-remote");
    fs.rmSync(relayPath, { force: true });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      engineRelaySocketPath: relayPath,
    });
    await engine.lines.nextOfType("channel_hello");

    await sendQuestionEventToEngine({
      type: "question_event",
      session: "other",
      event: "prompt",
      id: "toolu_qb",
      questions: [{ header: "選択", question: "どちらに?", multiSelect: false, options: [] }],
    }, relayPath);
    const pending = await engine.lines.nextOfType("remote_pending");
    expect(pending).toContain('"kind":"question"');
    expect(pending).toContain('"session":"other"');
    expect(pending).toContain("どちらに?");

    await sendQuestionEventToEngine(
      { type: "question_event", session: "other", event: "dismiss", id: "toolu_qb" },
      relayPath,
    );
    const cleared = await engine.lines.nextOfType("remote_pending_cleared");
    expect(cleared).toContain('"id":"toolu_qb"');
    expect(cleared).toContain('"kind":"question"');

    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  test("未回答の設問は chat 再オープン（session_reattach）で question_prompt を再送する", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-question-reopen");
    fs.rmSync(relayPath, { force: true });
    const store = makeTempStore();
    store.put({ name: "conv", cwd: "/tmp/conv", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("conv\n") : ok("")));
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      engineRelaySocketPath: relayPath,
    });
    await engine.lines.nextOfType("channel_hello");

    // 開いていない状態で設問到着 → 一覧バッジ（remote_pending）になる。
    await sendQuestionEventToEngine({
      type: "question_event",
      session: "conv",
      event: "prompt",
      id: "toolu_qc",
      questions: [{ header: "選択", question: "再送テスト?", multiSelect: false, options: [] }],
    }, relayPath);
    await engine.lines.nextOfType("remote_pending");

    // chat を開くと保持中の設問が question_prompt で再送される（transcript には無いため）。
    engine.writeLine('{"id":"r2","name":"conv","type":"session_reattach","v":1}');
    const prompt = await engine.lines.nextOfType("question_prompt");
    expect(prompt).toContain('"id":"toolu_qc"');
    expect(prompt).toContain("再送テスト?");

    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  test("Stop（session_processing done）で未回答の設問を掃除して閉じる", async () => {
    if (!(await canListenUnixSocket())) return;
    const relayPath = tempSocketPath("engine-question-stop");
    fs.rmSync(relayPath, { force: true });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      engineRelaySocketPath: relayPath,
    });
    await engine.lines.nextOfType("channel_hello");

    await sendQuestionEventToEngine({
      type: "question_event",
      session: "other",
      event: "prompt",
      id: "toolu_qd",
      questions: [{ header: "選択", question: "中断?", multiSelect: false, options: [] }],
    }, relayPath);
    await engine.lines.nextOfType("remote_pending");

    // Esc 中断等 = PostToolUse dismiss 無しでターン終了 → Stop 通知で掃除される。
    await sendSessionProcessingToEngine({ type: "session_processing", session: "other", state: "done" }, relayPath);
    const cleared = await engine.lines.nextOfType("remote_pending_cleared");
    expect(cleared).toContain('"id":"toolu_qd"');

    await engine.teardown();
    fs.rmSync(relayPath, { force: true });
  });

  test("engine はメッセージ処理後に stale dist を検出し、応答を書き終えてから終了する", async () => {
    const store = makeTempStore();
    store.put({ name: "alpha", cwd: "/tmp/alpha", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("alpha\n") : ok("")));
    let currentVersion = "0.1.0";
    let staleNotified = false;
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      staleDistGuard: { startupVersion: "0.1.0", currentVersion: () => currentVersion },
      onStaleDist: () => {
        staleNotified = true;
      },
    });

    expect(await engine.lines.nextOfType("channel_hello")).toBe(
      '{"maxVersion":2,"serverVersion":"0.1.0","type":"channel_hello","v":1}',
    );
    currentVersion = "0.2.0";
    engine.writeLine('{"id":"L-stale","type":"session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L-stale"');
    expect(resp).toContain('"name":"alpha"');
    await engine.done;
    expect(staleNotified).toBe(true);
    await engine.teardown();
  });

  // MARK: 2. session_list_request → session_list_response

  test("session_list_request に session_list_response を返す（list 橋渡し）", async () => {
    const store = makeTempStore();
    store.put({ name: "alpha", cwd: "/tmp/alpha", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("alpha\n") : ok("")));
    const engine = startEngine({ sessionManager: makeManager(runner, store) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"L1","type":"session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L1"');
    expect(resp).toContain('"name":"alpha"');
    expect(resp).toContain('"cwd":"/tmp/alpha"');
    expect(resp).toContain('"alive":true');

    await engine.teardown();
  });

  // MARK: 3. session_reattach（不在） → error(session_not_found)

  test("不在 session_reattach に error(session_not_found) を返す", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"R1","name":"ghost","type":"session_reattach","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"session_not_found"');

    await engine.teardown();
  });

  // MARK: 4. session_kill → tmux kill-session

  test("session_kill で tmux kill-session -t <name> が発行される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"K1","name":"doomed","type":"session_kill","v":1}');

    expect(await waitForCommand(runner, ["kill-session", "-t", "doomed"])).toBe(true);

    await engine.teardown();
  });

  test("session_kill 後の再オープン（別 tmux 名で resume）でも履歴が再生される", async () => {
    // kill が tail を止めないと、再オープンの open() が「同一会話 tail 中」でスキップして
    // 履歴を再生せず、tmux 名の変化でクライアントキャッシュも外れて空表示になる（根治の回帰テスト）。
    const projectsRoot = makeTempDir("tailii-kill-reopen-projects");
    const cwd = makeTempDir("tailii-kill-reopen-cwd");
    const slug = fs.realpathSync.native(cwd).replaceAll("/", "-");
    const projectDir = path.join(projectsRoot, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "convkill.jsonl"),
      '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u0"}\n',
    );

    const store = makeTempStore();
    store.put({ name: "alias-kill", cwd, createdAt: 1, agent: "claude", claudeSessionId: "convkill" });
    let killed = false;
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "kill-session") {
        killed = true;
        return ok("");
      }
      if (args[0] === "ls") return killed ? ok("") : ok("alias-kill\n");
      return ok("");
    });
    const launcher: EngineLauncher = async (dir, name, _base, resumeSessionId) => {
      store.put({
        name, cwd: dir, createdAt: 2, agent: "claude",
        ...(resumeSessionId !== null ? { claudeSessionId: resumeSessionId } : {}),
      });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      launcher,
      // transcriptTailer は注入しない: engine 既定（tail 継続 + 履歴完了マーカー）が
      // 本番の tail スキップ条件（currentPump 生存）を再現する。
      chatTailProjectsRoot: projectsRoot,
    });

    await engine.lines.nextOfType("channel_hello");
    // 1. 生存中の別名（alias-kill）で開く: 履歴が再生される（マーカーまで待って再生完了を確定）。
    engine.writeLine(
      `{"cwd":"${cwd}","id":"S-k1","name":"alias-kill","resumeSessionId":"convkill","type":"session_start","v":1}`,
    );
    expect(await engine.lines.nextOfType("chat_output")).toContain("hi");
    expect(await engine.lines.nextOfType("chat_output")).toContain("pc:history-done");

    // 2. kill（kill 要求への現況一覧応答まで読み進める。S-k1 への一覧応答が
    //    tail 出力より後に並ぶことがあるため、id 一致まで読む）。
    engine.writeLine('{"id":"K-k1","name":"alias-kill","type":"session_kill","v":1}');
    let killResp = await engine.lines.nextOfType("session_list_response");
    if (!killResp.includes('"id":"K-k1"')) {
      killResp = await engine.lines.nextOfType("session_list_response");
    }
    expect(killResp).toContain('"id":"K-k1"');

    // 3. 再オープン: 生存セッションが無いので tmux 名は cs-<id> に変わる。tail が
    //    kill で停止済みなら再 tail され、履歴（hi）がもう一度再生される。
    engine.writeLine(
      `{"cwd":"${cwd}","id":"S-k2","name":"cs-convkill","resumeSessionId":"convkill","type":"session_start","v":1}`,
    );
    expect(await engine.lines.nextOfType("chat_output")).toContain("hi");

    await engine.teardown();
  });

  // MARK: 5. session_start → launcher 結線

  test("session_start が launcher へ橋渡しされ、成功で session_list_response が返る", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("fresh\n") : ok("")));
    const recorded: string[][] = [];
    const launcher: EngineLauncher = async (cwd, name) => {
      recorded.push([cwd, name]);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({ sessionManager: makeManager(runner, store), launcher });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/tmp/fresh-dir","id":"S1","name":"fresh","type":"session_start","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"S1"');
    expect(resp).toContain('"name":"fresh"');
    expect(resp).toContain('"cwd":"/tmp/fresh-dir"');
    expect(resp).toContain('"alive":true');
    expect(recorded).toEqual([["/tmp/fresh-dir", "fresh"]]);

    await engine.teardown();
  });

  // MARK: 5b. session_start の per-session agent ルーティング（claude/codex）

  test("agentType でセッション毎に claude/codex launcher を選ぶ（未指定は defaultAgent）", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("s\n") : ok("")));
    const claudeHits: string[] = [];
    const codexHits: string[] = [];
    const mk = (sink: string[]): EngineLauncher => async (cwd, name) => {
      sink.push(name);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      launcher: mk(claudeHits),
      codexLauncher: mk(codexHits),
      // host 既定は claude。未指定 agentType は claude へ倒れる。
      agent: "claude",
    });

    await engine.lines.nextOfType("channel_hello");
    // 1) agentType=codex → codexLauncher
    engine.writeLine('{"cwd":"/tmp/a","id":"S1","name":"cdx","type":"session_start","v":1,"agentType":"codex"}');
    await engine.lines.nextOfType("session_list_response");
    // 2) agentType=claude → claude launcher
    engine.writeLine('{"cwd":"/tmp/a","id":"S2","name":"cla","type":"session_start","v":1,"agentType":"claude"}');
    await engine.lines.nextOfType("session_list_response");
    // 3) 未指定 → defaultAgent(claude)
    engine.writeLine('{"cwd":"/tmp/a","id":"S3","name":"def","type":"session_start","v":1}');
    await engine.lines.nextOfType("session_list_response");

    expect(codexHits).toEqual(["cdx"]);
    expect(claudeHits).toEqual(["cla", "def"]);

    await engine.teardown();
  });

  test("defaultAgent=codex のとき agentType 未指定は codexLauncher へ倒れる", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("s\n") : ok("")));
    const claudeHits: string[] = [];
    const codexHits: string[] = [];
    const mk = (sink: string[]): EngineLauncher => async (cwd, name) => {
      sink.push(name);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      launcher: mk(claudeHits),
      codexLauncher: mk(codexHits),
      agent: "codex",
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/tmp/a","id":"S1","name":"def","type":"session_start","v":1}');
    await engine.lines.nextOfType("session_list_response");

    expect(codexHits).toEqual(["def"]);
    expect(claudeHits).toEqual([]);

    await engine.teardown();
  });

  test("session_start（resume なし）は生成 session-id と会話名 title を launcher へ渡す（流入防止 + lazy-session）", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("fresh\n") : ok("")));
    const args: (string | null | undefined)[][] = [];
    const launcher: EngineLauncher = async (cwd, name, baseDir, resumeSessionId, newSessionId, title) => {
      args.push([cwd, name, baseDir, resumeSessionId, newSessionId, title]);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({ sessionManager: makeManager(runner, store), launcher });

    await engine.lines.nextOfType("channel_hello");
    // 新規(会話名あり) / 新規(会話名なし) / resume の 3 起動を投入する。
    engine.writeLine(
      '{"cwd":"/tmp/fresh-dir","id":"S1","name":"n1","title":"My Chat","type":"session_start","v":1}',
    );
    await engine.lines.nextOfType("session_list_response");
    engine.writeLine('{"cwd":"/tmp/fresh-dir","id":"S1b","name":"n1b","type":"session_start","v":1}');
    await engine.lines.nextOfType("session_list_response");
    engine.writeLine(
      '{"cwd":"/tmp/fresh-dir","id":"S2","name":"n2","resumeSessionId":"keep-me","type":"session_start","v":1}',
    );
    await engine.lines.nextOfType("session_list_response");

    // 新規(会話名あり): resumeSessionId=null、newSessionId は生成 uuid、title は会話名を転送。
    const named = args.find((a) => a[1] === "n1")!;
    expect(named[3]).toBeNull();
    expect(named[4]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(named[5]).toBe("My Chat");
    // 新規(会話名なし): title は null（--name を付けない）。
    const unnamed = args.find((a) => a[1] === "n1b")!;
    expect(unnamed[4]).toMatch(/^[0-9a-f]{8}-/i);
    expect(unnamed[5]).toBeNull();
    // resume 起動: 既存 id を使い、生成 id も title も渡さない。
    const resumed = args.find((a) => a[1] === "n2")!;
    expect(resumed[3]).toBe("keep-me");
    expect(resumed[4]).toBeNull();
    expect(resumed[5]).toBeNull();

    await engine.teardown();
  });

  test("session_start resume は同じ claudeSessionId の生存セッション名を返し、rename せず二重起動しない", async () => {
    const store = makeTempStore();
    const sessionId = "f622acb5-1111-2222-3333-444444444444";
    store.put({ name: "s-c0de7369", cwd: "/tmp/fresh-dir", createdAt: 7, claudeSessionId: sessionId });
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("s-c0de7369\n");
      return ok("");
    });
    const launcherCalls: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => {
      launcherCalls.push(name);
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      launcher,
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      `{"cwd":"/tmp/fresh-dir","id":"S-resume","name":"cs-f622acb5","resumeSessionId":"${sessionId}","type":"session_start","v":1}`,
    );

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"S-resume"');
    expect(resp).toContain('"adoptedName":"s-c0de7369"');
    expect(resp).toContain('"name":"s-c0de7369"');
    expect(resp).toContain(`"claudeSessionId":"${sessionId}"`);
    expect(resp).not.toContain('"name":"cs-f622acb5"');
    expect(runner.recorded).not.toContainEqual(["rename-session", "-t", "s-c0de7369", "cs-f622acb5"]);
    expect(launcherCalls).toEqual([]);
    expect(store.get("s-c0de7369")?.claudeSessionId).toBe(sessionId);
    expect(store.get("cs-f622acb5")).toBeNull();

    await engine.teardown();
  });

  test("session_start prepare は採用名を返し、reattach 前には会話購読しない", async () => {
    const store = makeTempStore();
    const heartbeatDir = makeTempDir("prepare-heartbeat");
    const sessionId = "f622acb5-1111-2222-3333-444444444444";
    store.put({ name: "s-c0de7369", cwd: "/tmp/fresh-dir", createdAt: 7,
      claudeSessionId: sessionId });
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("s-c0de7369\n") : ok(""));
    const sent: unknown[] = [];
    const hubLink: HubLink = {
      onMessage: null, onReconnect: null,
      send: (message) => { sent.push(message); },
      close: vi.fn(),
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store), metadataStore: store, heartbeatDir, hubLink,
      launcher: async () => ({ exitCode: 0, errorText: "" }),
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(
      `{"cwd":"/tmp/fresh-dir","deferSubscribe":true,"id":"S-prepare","name":"cs-f622acb5","resumeSessionId":"${sessionId}","type":"session_start","v":2}`,
    );

    const response = decodeControlMessage(
      await engine.lines.nextOfType("session_list_response"),
    );
    expect(response).toMatchObject({
      type: "session_list_response", id: "S-prepare", adoptedName: "s-c0de7369",
    });
    if (response.type !== "session_list_response") throw new Error("unexpected response");
    expect(response.sessions).toEqual([]);
    expect(readHeartbeat(heartbeatDir, "s-c0de7369")).toMatchObject({
      state: "idle", event: "session-prepare",
    });
    expect(sent.filter((message) =>
      (message as { type?: string }).type === "conversation_subscribe",
    )).toEqual([]);
    await engine.teardown();
  });

  test("session_start prepare は Hub RPC を待たず heartbeat を直接更新する", async () => {
    const store = makeTempStore();
    const heartbeatDir = makeTempDir("prepare-heartbeat-direct");
    const sessionId = "f622acb5-1111-2222-3333-444444444444";
    store.put({ name: "s-live", cwd: "/tmp/work", createdAt: 7, claudeSessionId: sessionId });
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("s-live\n") : ok(""));
    const unavailableHub: HubLink = {
      onMessage: null, onReconnect: null, send: vi.fn(), close: vi.fn(),
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store), metadataStore: store,
      heartbeatDir, hubLink: unavailableHub,
      launcher: async () => ({ exitCode: 0, errorText: "" }),
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      `{"cwd":"/tmp/work","deferSubscribe":true,"id":"S-fallback","name":"cs-f622acb5","resumeSessionId":"${sessionId}","type":"session_start","v":2}`,
    );

    await engine.lines.nextOfType("session_list_response", 2_000);
    expect(readHeartbeat(heartbeatDir, "s-live")).toMatchObject({
      state: "idle", event: "session-prepare",
    });
    expect(unavailableHub.send).not.toHaveBeenCalled();
    await engine.teardown();
  });

  test("session_start prepare は直接 heartbeat が失敗したら error を返す", async () => {
    const store = makeTempStore();
    const root = makeTempDir("prepare-heartbeat-total-failure");
    const invalidHeartbeatDir = path.join(root, "not-a-directory");
    fs.writeFileSync(invalidHeartbeatDir, "file");
    const sessionId = "f622acb5-1111-2222-3333-444444444444";
    store.put({ name: "s-live", cwd: "/tmp/work", createdAt: 7, claudeSessionId: sessionId });
    const runner = new MockTmuxRunner((args) => args[0] === "ls" ? ok("s-live\n") : ok(""));
    const hubLink: HubLink = {
      onMessage: null, onReconnect: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    const testHub = new SessionHub({
      runner: async () => ok(""), heartbeatDir: makeTempDir("prepare-unused-hub"),
      metadataStore: store, timeoutSeconds: 1800,
    });
    const engine = startEngine({
      sessionManager: makeManager(runner, store), metadataStore: store,
      heartbeatDir: invalidHeartbeatDir, hubLink, hub: testHub,
      launcher: async () => ({ exitCode: 0, errorText: "" }),
    });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      `{"cwd":"/tmp/work","deferSubscribe":true,"id":"S-total-failure","name":"cs-f622acb5","resumeSessionId":"${sessionId}","type":"session_start","v":2}`,
    );

    const response = decodeControlMessage(await engine.lines.nextOfType("error", 2_000));
    expect(response).toMatchObject({
      type: "error", id: "S-total-failure", code: "session_prepare_heartbeat_failed",
    });
    await engine.teardown();
  });

  test("session_start resume は同じ会話の tmux がシェルだけなら再利用せず launcher を呼ぶ", async () => {
    const store = makeTempStore();
    const sessionId = "deadbeef-1111-2222-3333-444444444444";
    store.put({ name: "s-old", cwd: "/tmp/work", createdAt: 7, claudeSessionId: sessionId });
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("s-old\n");
      if (args[0] === "display-message") return ok("zsh\n");
      return ok("");
    });
    const launcherCalls: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => {
      launcherCalls.push(name);
      return { exitCode: 0, errorText: "", providerSessionId: sessionId };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store), metadataStore: store, launcher,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(
      `{"cwd":"/tmp/work","id":"S-dead","name":"cs-deadbeef","resumeSessionId":"${sessionId}","type":"session_start","v":1}`,
    );
    await engine.lines.nextOfType("session_list_response");

    expect(launcherCalls).toEqual(["cs-deadbeef"]);
    await engine.teardown();
  });

  test("session_reattach attached は保存済み claudeSessionId を chat tail の preferred に渡す", async () => {
    const store = makeTempStore();
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 1, claudeSessionId: "sid-work" });
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "ls") return ok("work\n");
      if (args[0] === "capture-pane") return ok("");
      return ok("");
    });
    const spy = vi.spyOn(TranscriptTailer, "resolveJsonl").mockReturnValue(null);
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      chatTailProjectsRoot: makeTempDir("reattach-tail-attached"),
      transcriptTailer: new TranscriptTailer(),
    });

    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"id":"R-tail-1","name":"work","type":"session_reattach","v":1}');
      await engine.lines.nextOfType("session_list_response");

      expect(spy.mock.calls.some((call) => call[1] === "sid-work")).toBe(true);
    } finally {
      spy.mockRestore();
      await engine.teardown();
    }
  });

  test("session_reattach resume は保存済み claudeSessionId を chat tail の preferred に渡す", async () => {
    const store = makeTempStore();
    store.put({ name: "resumed", cwd: "/tmp/resumed", createdAt: 1, claudeSessionId: "sid-resumed" });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("") : ok("")));
    const resume: EngineLauncher = async () => ({ exitCode: 0, errorText: "" });
    const spy = vi.spyOn(TranscriptTailer, "resolveJsonl").mockReturnValue(null);
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      resumeLauncher: resume,
      chatTailProjectsRoot: makeTempDir("reattach-tail-resume"),
      transcriptTailer: new TranscriptTailer(),
    });

    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"id":"R-tail-2","name":"resumed","type":"session_reattach","v":1}');
      await engine.lines.nextOfType("session_list_response");

      expect(spy.mock.calls.some((call) => call[1] === "sid-resumed")).toBe(true);
    } finally {
      spy.mockRestore();
      await engine.teardown();
    }
  });

  test("session_reattach resume: claudeSessionId 記録済みなら launcher の --resume 経路で厳密再開する", async () => {
    const store = makeTempStore();
    store.put({ name: "strict", cwd: "/tmp/strict", createdAt: 1, claudeSessionId: "sid-strict" });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("") : ok("")));
    // 通常 launcher（`claude --resume <id>` 相当）と `--continue` 相当の resumeLauncher を
    // 両方注入し、id 記録済みセッションでは前者が resumeSessionId 付きで選ばれることを確認する。
    const launcherCalls: Array<string | null> = [];
    const launcher: EngineLauncher = async (_cwd, _name, _base, resumeSessionId) => {
      launcherCalls.push(resumeSessionId);
      return { exitCode: 0, errorText: "" };
    };
    let continueResumeCalled = false;
    const resume: EngineLauncher = async () => {
      continueResumeCalled = true;
      return { exitCode: 0, errorText: "" };
    };
    const spy = vi.spyOn(TranscriptTailer, "resolveJsonl").mockReturnValue(null);
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      launcher,
      resumeLauncher: resume,
      chatTailProjectsRoot: makeTempDir("reattach-strict-resume"),
      transcriptTailer: new TranscriptTailer(),
    });

    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"id":"R-strict","name":"strict","type":"session_reattach","v":1}');
      await engine.lines.nextOfType("session_list_response");

      expect(launcherCalls).toEqual(["sid-strict"]);
      expect(continueResumeCalled).toBe(false);
    } finally {
      spy.mockRestore();
      await engine.teardown();
    }
  });

  test("launcher 失敗（非0 exit）で error(launch_failed) が返る", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const launcher: EngineLauncher = async () => ({
      exitCode: 1,
      errorText: "tailii-host launch: 作業ディレクトリが存在しません",
    });
    const engine = startEngine({ sessionManager: makeManager(runner), launcher });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/nope","id":"S2","name":"bad","type":"session_start","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"launch_failed"');
    expect(err).toContain('"id":"S2"');
    expect(err).toContain("作業ディレクトリが存在しません");

    // engine は継続稼働している（後続 list が処理される）。
    engine.writeLine('{"id":"L2","type":"session_list_request","v":1}');
    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L2"');

    await engine.teardown();
  });

  test("launcher 未注入の session_start は error(launch_failed)（安全側: 実 claude を起動しない）", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/tmp","id":"S3","name":"new","type":"session_start","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"launch_failed"');
    expect(err).toContain('"id":"S3"');

    // launcher 不在でも tmux 起動系コマンドは一切発行されない。
    const launchedTmux = runner.recorded.some(
      (cmd) => cmd[0] === "new-session" || cmd[0] === "new",
    );
    expect(launchedTmux).toBe(false);

    await engine.teardown();
  });

  test("codex_turn_start は metadata の provider thread へ App Server turn を開始する", async () => {
    const store = makeTempStore();
    store.put({
      name: "codex-work",
      cwd: "/tmp/codex-work",
      createdAt: 1,
      agent: "codex",
      providerSessionId: "thread-123",
    });
    const startTurn = vi.fn(async () => "turn-1");
    const close = vi.fn();
    const controller: CodexTurnControllerRuntime = {
      startTurn,
      closeSession: vi.fn(),
      close,
    };
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      codexTurnController: controller,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(
      '{"clientUserMessageId":"client-1","effort":"xhigh","id":"req-1","session":"codex-work","text":"run tests","type":"codex_turn_start","v":2}',
    );
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        session: "codex-work",
        threadId: "thread-123",
        cwd: "/tmp/codex-work",
        text: "run tests",
        clientUserMessageId: "client-1",
        effort: "xhigh",
        sandbox: null,
      });
    });

    await engine.teardown();
    expect(close).toHaveBeenCalledOnce();
  });

  test("codex_turn_start の同じ request id 再送は turn を1回だけ実行する", async () => {
    const store = makeTempStore();
    store.put({ name: "codex-work", cwd: "/tmp/codex-work", createdAt: 1,
      agent: "codex", providerSessionId: "thread-123" });
    const startTurn = vi.fn(async () => "turn-1");
    const controller: CodexTurnControllerRuntime = { startTurn, closeSession: vi.fn(), close: vi.fn() };
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner, store), metadataStore: store,
      codexTurnController: controller });
    await engine.lines.nextOfType("channel_hello");
    const line = '{"id":"same","session":"codex-work","text":"run","type":"codex_turn_start","v":2}';
    engine.writeLine(line); engine.writeLine(line);
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(startTurn).toHaveBeenCalledOnce();
    await engine.teardown();
  });

  test("codex_turn_start は Hub RPC timeout 時に engine controller へ fail-open する", async () => {
    const store = makeTempStore();
    store.put({ name: "codex-work", cwd: "/tmp/codex-work", createdAt: 1,
      agent: "codex", providerSessionId: "thread-123" });
    const startTurn = vi.fn(async () => "fallback-turn");
    const controller: CodexTurnControllerRuntime = {
      startTurn, closeSession: vi.fn(), close: vi.fn(),
    };
    const sent: unknown[] = [];
    const unavailableHub: HubLink = {
      onMessage: null, onReconnect: null,
      send: (message) => { sent.push(message); },
      close: vi.fn(),
    };
    const engine = startEngine({ sessionManager: makeManager(new MockTmuxRunner(() => ok("")), store),
      metadataStore: store, codexTurnController: controller, hubLink: unavailableHub });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"fallback","session":"codex-work","text":"run","type":"codex_turn_start","v":2}');
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(sent).toContainEqual(expect.objectContaining({ type: "codex_turn_submit", id: "fallback",
      threadId: "thread-123", clientUserMessageId: "fallback" }));
    await engine.teardown();
  });

  test("codex_turn_interrupt は Hub へ fire-and-forget 転送しつつローカル controller にも中断を試みる", async () => {
    const store = makeTempStore();
    store.put({ name: "codex-work", cwd: "/tmp/codex-work", createdAt: 1,
      agent: "codex", providerSessionId: "thread-123" });
    const interruptTurn = vi.fn(async () => {});
    const controller: CodexTurnControllerRuntime = {
      startTurn: vi.fn(async () => "turn-1"), interruptTurn, closeSession: vi.fn(), close: vi.fn(),
    };
    const sent: unknown[] = [];
    const hubLink: HubLink = {
      onMessage: null, onReconnect: null,
      send: (message) => { sent.push(message); },
      close: vi.fn(),
    };
    const engine = startEngine({ sessionManager: makeManager(new MockTmuxRunner(() => ok("")), store),
      metadataStore: store, codexTurnController: controller, hubLink });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      '{"id":"interrupt-1","session":"codex-work","type":"codex_turn_interrupt","v":2}',
    );
    await vi.waitFor(() => expect(sent).toContainEqual({
      type: "codex_turn_interrupt", id: "interrupt-1", session: "codex-work",
    }));
    // hub 断中の fail-open turn は engine ローカル controller しか止められないため、
    // 常に両方へ中断を試みる（未所有側は no-op）。
    await vi.waitFor(() => expect(interruptTurn).toHaveBeenCalledWith("codex-work"));
    await engine.teardown();
  });

  test("Hub App Server のモデルと token usage 通知を conversation_event marker へ変換する", async () => {
    const store = makeTempStore();
    store.put({
      name: "codex-work",
      cwd: "/tmp/codex-work",
      createdAt: 1,
      agent: "codex",
      providerSessionId: "thread-123",
    });
    const runner = new MockTmuxRunner((args) =>
      args[0] === "ls" ? ok("codex-work\n") : ok(""),
    );
    const manager = new CodexAppServerManager();
    let openOptions: CodexAppServerThreadOptions | null = null;
    vi.spyOn(manager, "openThread").mockImplementation(async (options) => {
      openOptions = options;
      return {
        threadId: options.threadId,
        startTurn: async () => "turn-1",
        interruptTurn: async () => {},
        close: () => {},
      };
    });
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      metadataStore: store,
      codexAppServer: manager,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"open-1","name":"codex-work","type":"session_reattach","v":2}');
    await engine.lines.nextOfType("session_list_response");
    engine.writeLine(
      '{"id":"turn-1","session":"codex-work","text":"run","type":"codex_turn_start","v":2}',
    );
    await vi.waitFor(() => expect(openOptions).not.toBeNull());

    openOptions?.onNotification?.({
      method: "thread/settings/updated",
      params: { threadSettings: { model: "gpt-5.6-sol" } },
    });
    openOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { totalTokens: 987_654 },
          last: { totalTokens: 12_345 },
          modelContextWindow: 353_400,
        },
      },
    });

    expect(decodeControlMessage(await engine.lines.nextOfType("chat_output"))).toMatchObject({
      streamId: "pc:model",
      text: "gpt-5.6-sol",
    });
    expect(decodeControlMessage(await engine.lines.nextOfType("chat_output"))).toMatchObject({
      streamId: "pc:context",
      text: "12345",
    });
    expect(decodeControlMessage(await engine.lines.nextOfType("chat_output"))).toMatchObject({
      streamId: "pc:context-window",
      text: "353400",
    });

    await engine.teardown();
  });

  test("codex_model_list_request は共有 App Server の動的モデル一覧を返す", async () => {
    const manager = new CodexAppServerManager();
    const listModels = vi.spyOn(manager, "listModels").mockResolvedValue([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        contextWindow: 353_400,
        isDefault: true,
      },
    ]);
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      codexAppServer: manager,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"models-1","type":"codex_model_list_request","v":2}');

    expect(await engine.lines.nextOfType("codex_model_list_response")).toBe(
      '{"id":"models-1","models":[{"contextWindow":353400,"description":"Latest frontier agentic coding model.","displayName":"GPT-5.6-Sol","id":"gpt-5.6-sol","isDefault":true}],"type":"codex_model_list_response","v":2}',
    );
    expect(listModels).toHaveBeenCalledOnce();
    await engine.teardown();
  });

  test("codex_model_list_request の App Server 失敗は error を返す", async () => {
    const manager = new CodexAppServerManager();
    vi.spyOn(manager, "listModels").mockRejectedValue(new Error("model/list unavailable"));
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      codexAppServer: manager,
    });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"models-2","type":"codex_model_list_request","v":2}');

    const error = await engine.lines.nextOfType("error");
    expect(decodeControlMessage(error)).toEqual({
      type: "error",
      v: 2,
      id: "models-2",
      code: "codex_model_list_failed",
      message: "Error: model/list unavailable",
    });
    await engine.teardown();
  });

  test("codex_model_list_request は App Server 未構成時に error を返す", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"models-3","type":"codex_model_list_request","v":2}');

    const error = await engine.lines.nextOfType("error");
    expect(decodeControlMessage(error)).toEqual({
      type: "error",
      v: 2,
      id: "models-3",
      code: "codex_app_server_unavailable",
      message: "Codex App Server が未構成です。",
    });
    await engine.teardown();
  });

  // MARK: 6. decode 失敗行は破棄（クラッシュしない）

  test("decode 不能な行は破棄され、以降のメッセージは処理される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine("this is not json");
    engine.writeLine('{"id":"L3","type":"session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L3"');

    await engine.teardown();
  });

  // MARK: question_answer → tmux send-keys 変換

  test("question_answer の already_resolved は既存 error 封筒で返す", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const manager = makeManager(runner);
    const hub = makeQuestionHub(manager, "answered");
    const winner = {};
    hub.registerClient(winner, () => {});
    hub.handleClientMessage(winner, JSON.stringify({ type: "question_answer_submit", id: "winner",
      session: "work", questionId: "answered", answers: [] }));
    const engine = startEngine({ sessionManager: manager, hub });
    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"answers":[],"id":"answered","session":"work","type":"question_answer","v":1}');
    expect(decodeControlMessage(await engine.lines.nextOfType("error"))).toMatchObject({
      id: "answered", code: "question_answer_failed", message: "この設問は既に回答済みです。",
    });
    await engine.teardown();
  });

  test("question_answer: 複数の単一選択は各回答後にレビューを Submit する", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const manager = makeManager(runner);
    const engine = startEngine({ sessionManager: manager, hub: makeQuestionHub(manager, "Q1") });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      '{"answers":[{"multiSelect":false,"questionIndex":0,"selectedOptionIndexes":[1]},{"multiSelect":false,"otherText":"custom","questionIndex":1,"selectedOptionIndexes":[2]}],"id":"Q1","session":"work","type":"question_answer","v":1}',
    );

    // 単一選択: 数字キーのみで即確定（Enter は送らない）。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "2"])).toBe(true);
    // Other（Type something.）: 行の数字キー → literal 入力 → Enter。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "3"])).toBe(true);
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "-l", "custom"])).toBe(true);
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "Enter"])).toBe(true);
    // 2 問以上は最終問も単一選択でもレビュー画面へ進むため、Submit answers の 1 が必要。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "1"])).toBe(true);
    // Enter は Other 確定の1回だけ。
    const enterCount = runner.recorded.filter(
      (cmd) => JSON.stringify(cmd) === JSON.stringify(["send-keys", "-t", "work", "Enter"]),
    ).length;
    expect(enterCount).toBe(1);

    await engine.teardown();
  });

  test("question_answer: 1問だけの単一選択は数字キーで即確定しレビュー送信しない", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const manager = makeManager(runner);
    const engine = startEngine({ sessionManager: manager, hub: makeQuestionHub(manager, "Q-single") });

    await engine.lines.nextOfType("channel_hello");
    const before = runner.recorded.length;
    engine.writeLine(
      '{"answers":[{"multiSelect":false,"questionIndex":0,"selectedOptionIndexes":[1]}],"id":"Q-single","session":"work","type":"question_answer","v":1}',
    );

    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "2"])).toBe(true);
    await engine.lines.nextOfType("remote_pending_cleared");
    const keys = runner.recorded
      .slice(before)
      .filter((cmd) => cmd[0] === "send-keys")
      .map((cmd) => cmd.slice(3));
    expect(keys).toEqual([["2"]]);

    await engine.teardown();
  });

  test("question_answer: multiSelect は ↓/Space トグル + Right + レビュー確定（1）に変換される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const manager = makeManager(runner);
    const engine = startEngine({ sessionManager: manager, hub: makeQuestionHub(manager, "Q2") });

    await engine.lines.nextOfType("channel_hello");
    const before = runner.recorded.length;
    engine.writeLine(
      '{"answers":[{"multiSelect":true,"questionIndex":0,"selectedOptionIndexes":[0,2]}],"id":"Q2","session":"work","type":"question_answer","v":1}',
    );

    // 最後の「1」（Submit answers）が届くまで待つ。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "1"])).toBe(true);

    // index0 を Space、↓↓ で index2 へ移動し Space、Right でレビュー、1 で確定。
    // multiSelect は数字キーでトグルできないため、数字トグル（"3" 等）や Enter は送らない。
    const keys = runner.recorded
      .slice(before)
      .filter((cmd) => cmd[0] === "send-keys")
      .map((cmd) => cmd.slice(3));
    expect(keys).toEqual([["Space"], ["Down"], ["Down"], ["Space"], ["Right"], ["1"]]);

    await engine.teardown();
  });

  // MARK: 画像ハーネス

  function makeImageRoot(): { root: string; pending: string; index: string } {
    const root = makeTempDir("tailii-engine-image-tests");
    return {
      root,
      pending: path.join(root, "pending"),
      index: path.join(root, "index"),
    };
  }

  function writeIndexedBlob(id: string, bytes: number, ext: string, index: string): string {
    const srcDir = path.join(path.dirname(index), "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const data = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 1) data[i] = i & 0xff;
    const blob = path.join(srcDir, `${id}.${ext}`);
    fs.writeFileSync(blob, data);
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, `${id}.json`), JSON.stringify({ id, path: blob }));
    return blob;
  }

  // MARK: 7. image_fetch_request → 分割 image_fetch_response

  test("image_fetch_request で原本が複数 seq の image_fetch_response に分割され eof で終端する", async () => {
    const img = makeImageRoot();
    writeIndexedBlob("fetch-big", 32 * 1024 + 5000, "png", img.index);
    const imageService = new ImageService({ pendingBase: img.pending, indexBase: img.index });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), imageService });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"fetch-big","type":"image_fetch_request","v":1}');

    const responses: string[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const line = await engine.lines.next();
      if (line.includes('"type":"image_fetch_response"')) {
        responses.push(line);
        if (line.includes('"eof":true')) break;
      }
    }

    expect(responses.length).toBeGreaterThanOrEqual(2);
    expect(responses[0]).toContain('"seq":0');
    expect(responses[responses.length - 1]).toContain('"eof":true');
    expect(responses.slice(0, -1).every((line) => line.includes('"eof":false'))).toBe(true);

    await engine.teardown();
  });

  // MARK: 8. 不在 id → error(image_not_found)

  test("不在 id の image_fetch_request は error(image_not_found) を返す", async () => {
    const img = makeImageRoot();
    const imageService = new ImageService({ pendingBase: img.pending, indexBase: img.index });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), imageService });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"nope","type":"image_fetch_request","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"image_not_found"');
    expect(err).toContain('"id":"nope"');

    await engine.teardown();
  });

  // MARK: 9. image_available を engine チャネルへ送出（drainPending）

  test("チャネル確立時に pending を drain し image_available を engine チャネルへ送出する", async () => {
    const img = makeImageRoot();
    // 実 PNG を pending に投入（drainPending がサムネ生成し image_available を出す）。
    const srcDir = path.join(img.root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const png = path.join(srcDir, "avail.png");
    // 1x1 の有効な PNG（sips で読める最小フィクスチャ）。
    fs.writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    fs.mkdirSync(img.pending, { recursive: true });
    fs.writeFileSync(
      path.join(img.pending, "entry.json"),
      JSON.stringify({ imageId: "avail-1", path: png }),
    );
    const imageService = new ImageService({ pendingBase: img.pending, indexBase: img.index });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), imageService });

    const avail = await engine.lines.nextOfType("image_available");
    expect(avail).toContain('"id":"avail-1"');
    expect(avail).toContain(`"path":"${png}"`);

    await engine.teardown();
  });

  // MARK: 10. imageService 未注入時は従来どおり（後方互換）

  test("imageService 未注入でも session_list は従来どおり処理される（後方互換）", async () => {
    const store = makeTempStore();
    store.put({ name: "beta", cwd: "/tmp/beta", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("beta\n") : ok("")));
    const engine = startEngine({ sessionManager: makeManager(runner, store) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"L9","type":"session_list_request","v":1}');
    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L9"');
    expect(resp).toContain('"name":"beta"');

    await engine.teardown();
  });

  // MARK: 11. chat_output を engine チャネルへ送出（TranscriptTailer 注入, 9.1/9.2/9.3）

  test("transcriptTailer 注入時、assistant/user ターンの chat_output が engine FD へ送出される", async () => {
    // 代表 JSONL を一時ファイルに用意（秘密を thinking.signature に混ぜて非漏洩も検証）。
    const secret = "SECRET_KEY_ENGINE_9F8E7D";
    const contents =
      '{"type":"user","message":{"role":"user","content":"やあ"},"uuid":"e-u1"}\n' +
      `{"message":{"role":"assistant","content":[{"type":"thinking","thinking":"z","signature":"${secret}"},{"type":"text","text":"どうも"}]},"uuid":"e-a1"}\n`;
    const dir = makeTempDir("tailii-engine-transcript");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, contents);

    const runner = new MockTmuxRunner(() => ok(""));
    const tailer = new TranscriptTailer({ pollIntervalMs: 20, tailDeadlineMs: 2000 });
    const engine = startEngine({
      sessionManager: makeManager(runner),
      transcriptTailer: tailer,
      transcriptPath: transcript,
    });

    const first = await engine.lines.nextOfType("chat_output");
    const second = await engine.lines.nextOfType("chat_output");

    expect(first).toContain('"role":"user"');
    expect(first).toContain('"streamId":"e-u1"');
    expect(first).toContain('"eof":true');
    expect(second).toContain('"role":"assistant"');
    expect(second).toContain('"streamId":"e-a1"');
    // 9.3: 秘密は chat_output に現れない。
    expect(first).not.toContain(secret);
    expect(second).not.toContain(secret);

    await engine.teardown();
  });

  // MARK: 11b. チャネル断（EOF）で chatPump が確実に停止し runEngine が有界時間で完了する

  test("チャネル断（EOF）で無期限 tail の chatPump が停止し runEngine が有界時間で完了する", async () => {
    const dir = makeTempDir("tailii-engine-cancel");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"やあ"},"uuid":"cx-u1"}\n');

    const runner = new MockTmuxRunner(() => ok(""));
    // 無期限 tail: 停止が漏れると EOF 後も永久に回る（= runEngine が完了しない）。
    const tailer = new TranscriptTailer({ pollIntervalMs: 20, tailIndefinitely: true });
    const engine = startEngine({
      sessionManager: makeManager(runner),
      transcriptTailer: tailer,
      transcriptPath: transcript,
    });

    const first = await engine.lines.nextOfType("chat_output");
    expect(first).toContain('"streamId":"cx-u1"');

    // チャネル断（EOF）→ readLoop 終了 → chatPump abort → runEngine 完了（有界待ち）。
    const completed = await Promise.race([
      engine.teardown().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    expect(completed).toBe(true);
  });

  // MARK: 12. transcriptTailer 未注入時は従来どおり（後方互換）

  test("transcriptTailer 未注入でも session_list は従来どおり処理される（後方互換）", async () => {
    const store = makeTempStore();
    store.put({ name: "gamma", cwd: "/tmp/gamma", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("gamma\n") : ok("")));
    const engine = startEngine({ sessionManager: makeManager(runner, store) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"T12","type":"session_list_request","v":1}');
    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"T12"');
    expect(resp).toContain('"name":"gamma"');

    await engine.teardown();
  });

  // MARK: 13. browse_request → browse_response（dir-picker 1.1 結線）

  test("browse_request に絶対パス直下のサブディレクトリ名で browse_response を返す", async () => {
    const dir = makeTempDir("tailii-browse-tests");
    fs.mkdirSync(path.join(dir, "dev"));
    fs.mkdirSync(path.join(dir, "Documents"));

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(`{"id":"B1","path":"${dir}","type":"browse_request","v":1}`);

    const resp = await engine.lines.nextOfType("browse_response");
    expect(resp).toContain('"id":"B1"');
    expect(resp).toContain(`"path":"${dir}"`);
    expect(resp).toContain('"entries":["Documents","dev"]');

    await engine.teardown();
  });

  // MARK: claude-sessions: claude_session_list_request → claude_session_list_response

  test("claude_session_list_request に claude_session_list_response を返す（store 橋渡し）", async () => {
    const projects = makeTempDir("tailii-cs-engine");
    const slugDir = path.join(projects, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "77777777-8888-9999-aaaa-bbbbbbbbbbbb.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","message":{"content":"エンジン越し会話"}}\n',
    );

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      claudeSessionStore: new ClaudeSessionStore(projects),
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"CS1","type":"claude_session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("claude_session_list_response");
    expect(resp).toContain('"id":"CS1"');
    expect(resp).toContain('"sessionId":"77777777-8888-9999-aaaa-bbbbbbbbbbbb"');
    expect(resp).toContain('"cwd":"/tmp/proj"');
    expect(resp).toContain('"title":"エンジン越し会話"');

    await engine.teardown();
  });

  // MARK: session_search_request → session_search_response

  test("session_search_request に本文検索結果を返す（store 橋渡し）", async () => {
    const projects = makeTempDir("tailii-search-engine");
    const slugDir = path.join(projects, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "99999999-8888-7777-6666-555555555555.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","message":{"content":"検索タイトル"}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"本文に Approval keyword が含まれる"}]}}\n',
    );

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      claudeSessionStore: new ClaudeSessionStore(projects),
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"SS1","query":"approval","type":"session_search_request","v":2}');

    const resp = await engine.lines.nextOfType("session_search_response");
    expect(resp).toContain('"id":"SS1"');
    expect(resp).toContain('"sessionId":"99999999-8888-7777-6666-555555555555"');
    expect(resp).toContain('"snippet":"本文に Approval keyword が含まれる"');
    expect(resp).toContain('"title":"検索タイトル"');

    await engine.teardown();
  });

  // MARK: dir-create: dir_create_request → dir_create_response

  test("dir_create_request で base 配下に作成し ok=true を返す", async () => {
    const base = makeTempDir("tailii-dc-engine");
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      `{"baseDir":"${base}","id":"DC1","relative":"created","type":"dir_create_request","v":1}`,
    );

    const resp = await engine.lines.nextOfType("dir_create_response");
    expect(resp).toContain('"id":"DC1"');
    expect(resp).toContain('"ok":true');
    expect(fs.statSync(path.join(base, "created")).isDirectory()).toBe(true);

    await engine.teardown();
  });

  // MARK: web-preview: preview_open → preview_ready / preview_error

  test("preview_open で loopback 静的サーバーが立ち preview_ready を返す（close で解放）", async () => {
    const dir = makeTempDir("tailii-preview-engine");
    fs.writeFileSync(path.join(dir, "index.html"), "<p>preview</p>");
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      `{"id":"PV1","target":"${path.join(dir, "index.html")}","type":"preview_open","v":2}`,
    );

    const ready = await engine.lines.nextOfType("preview_ready");
    expect(ready).toContain('"id":"PV1"');
    const url = JSON.parse(ready).url as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{32}\/index\.html$/);
    const response = await fetch(url);
    expect(response.status).toBe(200);

    engine.writeLine('{"id":"PV1","type":"preview_close","v":2}');
    // close 後は接続拒否になる（ポーリングで確定を待つ）。
    await expect.poll(async () => fetch(url).then(() => "alive", () => "closed")).toBe("closed");

    await engine.teardown();
  });

  test("preview_open の不正 target には preview_error を返す", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"PV2","target":"/tmp/nonexistent-tailii.html","type":"preview_open","v":2}');

    const error = await engine.lines.nextOfType("preview_error");
    expect(error).toContain('"id":"PV2"');
    expect(error).toContain("not-found");

    await engine.teardown();
  });

  // MARK: slash_list_request

  function writeMd(filePath: string, description: string | null): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body =
      description === null
        ? "# command\n"
        : `---\ndescription: ${description}\n---\n# command\n`;
    fs.writeFileSync(filePath, body);
  }

  test("slash_list_request は skills/commands を収集し summary・dedupe・sort を適用する", async () => {
    const home = makeTempDir("tailii-slash-home");
    const cwd = makeTempDir("tailii-slash-cwd");
    writeMd(path.join(home, ".claude", "skills", "alpha", "SKILL.md"), "user skill");
    writeMd(path.join(home, ".claude", "skills", "dupe", "SKILL.md"), "user skill old");
    writeMd(path.join(home, ".claude", "commands", "beta.md"), "user command");
    writeMd(path.join(home, ".claude", "commands", "empty.md"), null);
    writeMd(path.join(cwd, ".claude", "skills", "dupe", "SKILL.md"), "project skill wins");
    writeMd(path.join(cwd, ".claude", "commands", "alpha.md"), "project command wins");
    writeMd(path.join(cwd, ".claude", "commands", "gamma.md"), "project command");

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), homeDir: home });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(`{"cwd":${JSON.stringify(cwd)},"id":"SL1","type":"slash_list_request","v":1}`);
    const line = await engine.lines.nextOfType("slash_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "slash_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.commands).toEqual([
      { name: "/alpha", summary: "project command wins" },
      { name: "/beta", summary: "user command" },
      { name: "/dupe", summary: "project skill wins" },
      { name: "/empty", summary: "" },
      { name: "/gamma", summary: "project command" },
    ]);

    await engine.teardown();
  });

  test("slash_list_request は symlink の skill directory と command file も辿る", async () => {
    const home = makeTempDir("tailii-slash-symlink-home");
    const source = makeTempDir("tailii-slash-symlink-source");
    writeMd(path.join(source, "linked-skill", "SKILL.md"), "linked skill");
    writeMd(path.join(source, "linked-command.md"), "linked command");
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
    fs.symlinkSync(
      path.join(source, "linked-skill"),
      path.join(home, ".claude", "skills", "linked-skill"),
      "dir",
    );
    fs.symlinkSync(
      path.join(source, "linked-command.md"),
      path.join(home, ".claude", "commands", "linked-command.md"),
      "file",
    );

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), homeDir: home });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"SL2","type":"slash_list_request","v":1}');
    const line = await engine.lines.nextOfType("slash_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "slash_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.commands).toEqual([
      { name: "/linked-command", summary: "linked command" },
      { name: "/linked-skill", summary: "linked skill" },
    ]);

    await engine.teardown();
  });

  test("slash_list_request は installed plugin の skills/commands を /plugin:name で収集する", async () => {
    const home = makeTempDir("tailii-slash-plugin-home");
    const cache = makeTempDir("tailii-slash-plugin-cache");
    writeMd(path.join(cache, "alpha", "skills", "run", "SKILL.md"), "plugin skill");
    writeMd(path.join(cache, "alpha", "commands", "fix.md"), "plugin command");
    writeMd(path.join(cache, "beta", "skills", "run", "SKILL.md"), "disabled plugin skill");
    fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "alpha@market": [{ scope: "user", installPath: path.join(cache, "alpha") }],
          "beta@market": [{ scope: "user", installPath: path.join(cache, "beta") }],
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "alpha@market": true, "beta@market": false } }),
    );

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), homeDir: home });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"SL3","type":"slash_list_request","v":1}');
    const line = await engine.lines.nextOfType("slash_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "slash_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.commands).toEqual([
      { name: "/alpha:fix", summary: "plugin command" },
      { name: "/alpha:run", summary: "plugin skill" },
    ]);

    await engine.teardown();
  });
});
