// claudeCodeW34.test.ts — Claude Code Week 33/34 追随の純ロジック（default-model / output-style /
// worktree-from-pr / todo-tools / fork-subagent / idle-notice / artifact-card / auto-continue）
import { describe, expect, it } from "vitest";
import { markClaudeDefaultModel, readClaudeDefaultModelSetting } from "../src/services/claudeModelCatalog.js";
import {
  claudeInnerCommand,
  claudeLaunchEnvPrefix,
  claudeWorktreeArgument,
  claudeWorktreeRecordCwd,
  mergeClaudeLaunchSettings,
  reconcileWorktreeRecordCwd,
} from "../src/commands/launch.js";
import { makeTempStore } from "./helpers.js";
import { pushPayloadBody } from "../src/push/pushTypes.js";
import { ApprovalPushNotifier } from "../src/push/approvalPushNotifier.js";
import { parseSubagentTranscript, presentForkDirective } from "../src/chat/subagentTranscript.js";
import { systemNoticeText } from "../src/shared/systemNotice.js";
import { extractTurn, extractToolActivities, TranscriptTailer, apiErrorAssistantKind } from "../src/chat/transcriptTailer.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODELS = [
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
  { id: "claude-opus-5", displayName: "Claude Opus 5" },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
];

describe("default-model: ANTHROPIC_DEFAULT_MODEL", () => {
  it("完全一致 id / alias（[1m] 接尾辞は無視）でファミリー先頭へ isDefault を立てる", () => {
    expect(markClaudeDefaultModel(MODELS, "claude-sonnet-5")[2]).toEqual({ ...MODELS[2], isDefault: true });
    expect(markClaudeDefaultModel(MODELS, "opus[1m]")[1]).toEqual({ ...MODELS[1], isDefault: true });
    expect(markClaudeDefaultModel(MODELS, "OPUS").filter((m) => m.isDefault).map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("設定なし・未知 alias（default / opusplan）・該当なしは一覧をそのまま返す", () => {
    expect(markClaudeDefaultModel(MODELS, null)).toEqual(MODELS);
    expect(markClaudeDefaultModel(MODELS, "default")).toEqual(MODELS);
    expect(markClaudeDefaultModel(MODELS, "claude-haiku-4-5")).toEqual(MODELS);
  });

  it("環境変数 → settings.json の env の順に読む（不正値は null）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-defmodel-"));
    try {
      const settings = path.join(dir, "settings.json");
      fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_DEFAULT_MODEL: "sonnet" } }));
      expect(readClaudeDefaultModelSetting({}, settings)).toBe("sonnet");
      expect(readClaudeDefaultModelSetting({ ANTHROPIC_DEFAULT_MODEL: "opus" }, settings)).toBe("opus");
      expect(readClaudeDefaultModelSetting({ ANTHROPIC_DEFAULT_MODEL: "bad value; rm" }, settings)).toBeNull();
      expect(readClaudeDefaultModelSetting({}, path.join(dir, "missing.json"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("output-style / worktree / todo-tools の起動合成", () => {
  it("--worktree は #番号 / 裸の番号 / PR・MR URL だけ通す", () => {
    expect(claudeWorktreeArgument("1234")).toBe("#1234");
    expect(claudeWorktreeArgument("#42")).toBe("#42");
    expect(claudeWorktreeArgument("https://github.com/o/r/pull/12")).toBe("https://github.com/o/r/pull/12");
    expect(claudeWorktreeArgument("https://gitlab.com/g/p/-/merge_requests/42")).toBe("https://gitlab.com/g/p/-/merge_requests/42");
    expect(claudeWorktreeArgument("feature-branch")).toBeNull();
    expect(claudeWorktreeArgument("https://example.com/x")).toBeNull();
    expect(claudeWorktreeArgument("'; rm -rf /")).toBeNull();
    expect(claudeInnerCommand({ worktree: "1234" })).toBe("claude --worktree '#1234'");
    expect(claudeInnerCommand({ model: "opus", worktree: "bad ref" })).toBe("claude --model opus");
  });

  it("--settings にフックと outputStyle を合成する（フック無効でも outputStyle だけ渡す）", () => {
    const hooks = JSON.stringify({ hooks: { Stop: [] } });
    expect(JSON.parse(mergeClaudeLaunchSettings(hooks, "Concise")!)).toEqual({ hooks: { Stop: [] }, outputStyle: "Concise" });
    expect(JSON.parse(mergeClaudeLaunchSettings(null, "Explanatory")!)).toEqual({ outputStyle: "Explanatory" });
    expect(mergeClaudeLaunchSettings(hooks, null)).toBe(hooks);
    expect(mergeClaudeLaunchSettings(null, null)).toBeNull();
    // 不正な名前（引用符）は捨てる。
    expect(mergeClaudeLaunchSettings(null, "x\"y")).toBeNull();
  });

  it("env 前置: todo-tools と ANTHROPIC_DEFAULT_MODEL（model フラグ付きでは付けない）", () => {
    expect(claudeLaunchEnvPrefix({ todoTools: true })).toBe("CLAUDE_CODE_ENABLE_TODO_TOOLS=1");
    expect(claudeLaunchEnvPrefix({ defaultModel: "opus[1m]" })).toBe("ANTHROPIC_DEFAULT_MODEL=opus[1m]");
    expect(claudeLaunchEnvPrefix({ defaultModel: "opus", hasModelFlag: true })).toBe("");
    expect(claudeLaunchEnvPrefix({ todoTools: true, defaultModel: "$(evil)" })).toBe("CLAUDE_CODE_ENABLE_TODO_TOOLS=1");
    expect(claudeLaunchEnvPrefix({})).toBe("");
  });
});

describe("fork-subagent: transcript の定型指示と spawn 写し", () => {
  const forkJsonl = [
    JSON.stringify({ type: "fork-context-ref", agentId: "a1", parentSessionId: "p", parentLastUuid: "u", contextLength: 329 }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-14T00:00:00.000Z", message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "probe", prompt: "x", subagent_type: "fork" } },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "" },
      { type: "text", text: "<fork-boilerplate>\nYou are a worker fork. Execute ONE directive, then stop.\n</fork-boilerplate>\n\nYour directive: テストを 3 件書いて" },
    ] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-14T00:00:02.000Z", message: { role: "assistant", content: [
      { type: "text", text: "書きました。" },
    ] } }),
  ].join("\n");

  it("先頭の Agent 写しを落とし、boilerplate を外した指示本文だけを user 行にする", () => {
    const { entries } = parseSubagentTranscript(forkJsonl);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[0]!.text).toBe("⑂ 分岐（fork）への指示\n\nテストを 3 件書いて");
    expect(entries[1]!.text).toBe("書きました。");
  });

  it("presentForkDirective は boilerplate 無しの本文に反応しない", () => {
    expect(presentForkDirective("普通の発話")).toBeNull();
    expect(presentForkDirective("<fork-boilerplate>x</fork-boilerplate>")).toBe("⑂ 分岐（fork）への指示");
  });

  it("fork-context-ref の直後が Agent 写しでなければ落とさない", () => {
    const jsonl = [
      JSON.stringify({ type: "fork-context-ref" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n");
    expect(parseSubagentTranscript(jsonl).entries.map((e) => e.text)).toEqual(["hi"]);
  });
});

describe("idle-notice: notify_when_idle の informational 行", () => {
  it("`<name> is idle` を ⇄ 注記へ、他の notice 級は従来どおり落とす", () => {
    const rec = { type: "system", subtype: "informational", level: "notice", content: "bay-39 is idle", isMeta: false };
    expect(systemNoticeText(rec)).toBe("⇄ bay-39 は待機状態になりました（別セッションからの通知）");
    expect(systemNoticeText({ ...rec, content: "bay-39 exited" })).toBeNull();
    expect(systemNoticeText({ ...rec, content: "something else" })).toBeNull();
    expect(systemNoticeText({ ...rec, level: "info" })).toBeNull();
  });
});

describe("artifact-card: Artifact ツールの tool_use と URL 後付け", () => {
  it("tool_use をカードへ（title 優先、file と description を載せる）", () => {
    const activities = extractToolActivities([
      { type: "tool_use", id: "toolu_a", name: "Artifact", input: {
        file_path: "/tmp/scratch/guide.html", title: "時短の手引き", description: "残業対策", favicon: "⏳",
      } },
    ]);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "toolu_a", name: "Artifact", label: "Artifact を公開 時短の手引き", file: "/tmp/scratch/guide.html",
      description: "残業対策",
    });
    expect(activities[0]!.url).toBeUndefined();
    const listed = extractToolActivities([{ type: "tool_use", id: "t2", name: "Artifact", input: { action: "list" } }]);
    expect(listed[0]!.label).toBe("Artifact list");
  });

  it("tool_result の `Published … at https://claude.ai/code/artifact/<id>` を artifactResults に拾う", () => {
    const line = JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text:
        "Published /tmp/scratch/guide.html at https://claude.ai/code/artifact/f8f47ed1-ecbf-4cb1-ac5c-ba5a2d60b173\n\nLive subscription: arming" }] },
    ] } });
    const turn = extractTurn(line);
    expect(turn?.artifactResults).toEqual([{ toolUseId: "toolu_a", url: "https://claude.ai/code/artifact/f8f47ed1-ecbf-4cb1-ac5c-ba5a2d60b173" }]);
  });

  it("tail で URL 付きの tool_activity が同じ id で再送される", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-artifact-"));
    try {
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, [
        JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-14T00:00:00.000Z", message: { role: "assistant", model: "claude-opus-5", content: [
          { type: "tool_use", id: "toolu_a", name: "Artifact", input: { file_path: "/tmp/g.html", title: "G" } },
        ] } }),
        JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "Published /tmp/g.html at https://claude.ai/code/artifact/abc-123" },
        ] } }),
      ].join("\n") + "\n");
      const tailer = new TranscriptTailer({ tailDeadlineMs: 200, pollIntervalMs: 10 });
      const activities: string[] = [];
      for await (const message of tailer.streamTranscript(file)) {
        if (message.type === "tool_activity") activities.push(`${message.activity.id}:${message.activity.url ?? "-"}`);
      }
      expect(activities).toEqual(["toolu_a:-", "toolu_a:https://claude.ai/code/artifact/abc-123"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("usage-limit-wait: rate_limit 後の isMeta 発話は自動再開注記へ", () => {
  const apiError = JSON.stringify({ type: "assistant", uuid: "e1", timestamp: "2026-09-14T00:00:00.000Z", isApiErrorMessage: true,
    error: "rate_limit", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 3pm" }] } });

  it("apiErrorAssistantKind はエラー種別を返す", () => {
    expect(apiErrorAssistantKind(apiError)).toBe("rate_limit");
    expect(apiErrorAssistantKind(JSON.stringify({ type: "assistant", isApiErrorMessage: true, message: { content: "x" } }))).toBe("");
    expect(apiErrorAssistantKind('{"type":"user"}')).toBeNull();
  });

  async function collect(lines: string[]): Promise<{ role: string; text: string }[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-autocont-"));
    try {
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, lines.join("\n") + "\n");
      const tailer = new TranscriptTailer({ tailDeadlineMs: 200, pollIntervalMs: 10 });
      const out: { role: string; text: string }[] = [];
      for await (const message of tailer.streamTranscript(file)) {
        if (message.type === "chat_output" && message.streamId.startsWith("pc:") === false) out.push({ role: message.role, text: message.text });
      }
      return out;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rate_limit の後の isMeta 発話は system 注記、本物の発話はそのまま", async () => {
    const meta = JSON.stringify({ type: "user", uuid: "m1", isMeta: true, timestamp: "2026-09-14T03:00:00.000Z",
      message: { role: "user", content: "Continue the task you were working on before the usage limit." } });
    const real = JSON.stringify({ type: "user", uuid: "r1", timestamp: "2026-09-14T03:01:00.000Z",
      message: { role: "user", content: "次はテストを書いて" } });
    const out = await collect([apiError, meta, real]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "system", "user"]);
    expect(out[1]!.text).toContain("自動再開");
    expect(out[2]!.text).toBe("次はテストを書いて");
  });

  it("畳んだ自動再開プロンプトでも turn_start ライフサイクルは出る（発話の観測は落とさない）", async () => {
    const meta = JSON.stringify({ type: "user", uuid: "m1", isMeta: true, timestamp: "2026-09-14T03:00:00.000Z",
      message: { role: "user", content: "Continue the task you were working on before the usage limit." } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-autocont-lc-"));
    try {
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, [apiError, meta].join("\n") + "\n");
      const tailer = new TranscriptTailer({ tailDeadlineMs: 200, pollIntervalMs: 10 });
      const events: unknown[] = [];
      tailer.setTurnLifecycleObserver((event) => events.push(event));
      for await (const _message of tailer.streamTranscript(file)) { /* drain */ }
      expect(events).toEqual([
        { kind: "api_error", atMs: Date.parse("2026-09-14T00:00:00.000Z"), errorKind: "rate_limit" },
        { kind: "turn_start", atMs: Date.parse("2026-09-14T03:00:00.000Z") },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("本物の発話が挟まると武装解除され、その後の isMeta 発話は畳まない / cross-session の起こしも畳まない", async () => {
    const real = JSON.stringify({ type: "user", uuid: "r1", timestamp: "2026-09-14T03:01:00.000Z", message: { role: "user", content: "別の指示" } });
    const meta = JSON.stringify({ type: "user", uuid: "m1", isMeta: true, timestamp: "2026-09-14T03:02:00.000Z", message: { role: "user", content: "Some meta prompt" } });
    const wake = JSON.stringify({ type: "user", uuid: "w1", isMeta: true, timestamp: "2026-09-14T03:03:00.000Z",
      message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from=\"uds:/x\" from-name=\"bay-3d\">hi</cross-session-message>" } });
    const out = await collect([apiError, real, meta]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    const out2 = await collect([apiError, wake]);
    expect(out2[1]!.role).toBe("user");
    // 2.1.273: 同一セッション内のエージェントからの封筒（<agent-message>）も畳まない。前置き行の判定に
    // 頼らずタグで除外できることを、前置き無しの裸の封筒が isMeta で届いた形で固定する。
    const handback = JSON.stringify({ type: "user", uuid: "h1", isMeta: true, timestamp: "2026-09-14T03:04:00.000Z",
      message: { role: "user", content: "<agent-message from=\"ae10c462719f9f472\">\n[Subagent hand-back] The report follows:\n  done\n</agent-message>" } });
    const out3 = await collect([apiError, handback]);
    expect(out3[1]!.role).toBe("user");
  });

  it("harness 由来の isMeta 行（idle 通知の起こし / system-reminder / task-notification）は畳まず、assistant が先に動いたら武装解除", async () => {
    const wake = JSON.stringify({ type: "user", uuid: "w1", isMeta: true, timestamp: "2026-09-14T03:00:00.000Z",
      message: { role: "user", content: "[Cross-session idle notice] \"bay-39\", which you asked to be notified about, is idle now." } });
    const reminder = JSON.stringify({ type: "user", uuid: "w2", isMeta: true, timestamp: "2026-09-14T03:00:01.000Z",
      message: { role: "user", content: "<system-reminder>\nnote\n</system-reminder>" } });
    const out = await collect([apiError, wake, reminder]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    // assistant が先に動いた（queued 発話の自動 dequeue）→ その後の isMeta 発話は畳まない。
    const assistant = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-14T03:00:02.000Z",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "continuing" }] } });
    const meta = JSON.stringify({ type: "user", uuid: "m1", isMeta: true, timestamp: "2026-09-14T03:00:03.000Z",
      message: { role: "user", content: "some meta prompt" } });
    const out2 = await collect([apiError, assistant, meta]);
    expect(out2.map((m) => m.role)).toEqual(["assistant", "assistant", "user"]);
  });

  it("制限到達から 12 時間を超えた isMeta 発話は畳まない（時間窓）", async () => {
    const late = JSON.stringify({ type: "user", uuid: "m1", isMeta: true, timestamp: "2026-09-15T00:00:00.000Z",
      message: { role: "user", content: "meta after a day" } });
    const out = await collect([apiError, late]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("server_error（529）の後の isMeta 発話は畳まない", async () => {
    const overloaded = JSON.stringify({ type: "assistant", uuid: "e2", timestamp: "2026-09-14T00:00:00.000Z", isApiErrorMessage: true,
      error: "server_error", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Overloaded" }] } });
    const meta = JSON.stringify({ type: "user", uuid: "m1", isMeta: true, timestamp: "2026-09-14T03:00:00.000Z", message: { role: "user", content: "meta" } });
    const out = await collect([overloaded, meta]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
  });
});

describe("usage-limit push: 文言と kind が payload に載る", () => {
  it("pushPayloadBody は alert / kind の差し替えを反映し、承認 push は従来どおり", () => {
    const usage = JSON.parse(pushPayloadBody("usage-limit-s-1-waiting-1", "usage-limit", "s-1",
      { title: "使用量制限", body: "3:45pm に自動再開します" }, "usage_limit").toString("utf8")) as Record<string, unknown>;
    expect(usage["kind"]).toBe("usage_limit");
    expect((usage["aps"] as Record<string, unknown>)["alert"]).toEqual({ body: "3:45pm に自動再開します", title: "使用量制限" });
    const approval = JSON.parse(pushPayloadBody("ap-1", "Bash", "s-1").toString("utf8")) as Record<string, unknown>;
    expect(approval["kind"]).toBeUndefined();
    expect((approval["aps"] as Record<string, unknown>)["alert"]).toEqual({ body: "Bash · s-1", title: "承認待ち" });
  });

  it("ApprovalPushNotifier は alert / kind を送信 body まで落とさず運ぶ", async () => {
    const bodies: string[] = [];
    const notifier = new ApprovalPushNotifier({
      configStore: { load: () => ({ topic: "com.example.app", keyId: "K", teamId: "T", host: "sandbox" as const }) } as never,
      tokenStore: { load: () => ({ token: "ab", environment: "sandbox" }), save: () => {}, clear: () => {} } as never,
      jwtProvider: { currentToken: () => "jwt", invalidate: () => {} } as never,
      sender: { send: async (request: { body: Buffer }) => { bodies.push(request.body.toString("utf8")); return { ok: true }; } } as never,
      observer: { recordSent: () => {}, recordSkipped: () => {}, recordFailed: () => {} },
      sendLogBase: fs.mkdtempSync(path.join(os.tmpdir(), "tailii-push-")),
    });
    const outcome = await notifier.notify({
      approvalId: "usage-limit-s-2-needs_enter-1", tool: "usage-limit", session: "s-2",
      kind: "usage_limit", alert: { title: "使用量制限", body: "続行できます" },
    }, 1000);
    expect(outcome).toEqual({ kind: "sent" });
    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(sent["kind"]).toBe("usage_limit");
    expect((sent["aps"] as Record<string, unknown>)["alert"]).toEqual({ body: "続行できます", title: "使用量制限" });
  });
});

describe("worktree-from-pr: メタデータ cwd は claude が作る worktree パス", () => {
  it("git 最上位 + .claude/worktrees/pr-<n>（git 不能なら null = 起動 dir を記録）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-wt-"));
    try {
      const top = "/Users/alice/repo";
      const gitRunner = async (_exe: string, args: string[]) =>
        args.includes("--show-toplevel") ? { exitCode: 0, stdout: `${top}\n` } : { exitCode: 1, stdout: "" };
      expect(await claudeWorktreeRecordCwd(dir, null, "#42", gitRunner)).toBe(`${top}/.claude/worktrees/pr-42`);
      expect(await claudeWorktreeRecordCwd(dir, null, "https://gitlab.com/g/p/-/merge_requests/7", gitRunner))
        .toBe(`${top}/.claude/worktrees/pr-7`);
      // git の最上位が取れなければ推測せず null（起動 dir を記録 = 従来動作）。
      const noGit = async () => ({ exitCode: 128, stdout: "" });
      expect(await claudeWorktreeRecordCwd(dir, null, "1234", noGit)).toBeNull();
      const gitMissing = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
      expect(await claudeWorktreeRecordCwd(dir, null, "1234", gitMissing)).toBeNull();
      expect(await claudeWorktreeRecordCwd(dir, null, null, gitRunner)).toBeNull();
      expect(await claudeWorktreeRecordCwd(dir, null, "feature", gitRunner)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worktree-from-pr: worktree が現れなければ cwd を起動 dir へ戻す", () => {
  it("出現すれば据え置き、出現しなければ書き戻す（記録が別値へ変わっていれば触らない）", async () => {
    const store = makeTempStore();
    store.put({ name: "cs-1", cwd: "/repo/.claude/worktrees/pr-42", createdAt: 1 });
    const logs: string[] = [];
    const noSleep = async () => {};
    // 現れた: 据え置き。
    expect(await reconcileWorktreeRecordCwd(store, "cs-1", "/repo/.claude/worktrees/pr-42", "/repo", (m) => logs.push(m), noSleep, () => true, 10, 1)).toBe(true);
    expect(store.get("cs-1")?.cwd).toBe("/repo/.claude/worktrees/pr-42");
    // 現れない: 起動 dir へ戻す（他のメタは保つ）。
    expect(await reconcileWorktreeRecordCwd(store, "cs-1", "/repo/.claude/worktrees/pr-42", "/repo", (m) => logs.push(m), noSleep, () => false, 10, 1)).toBe(false);
    expect(store.get("cs-1")?.cwd).toBe("/repo");
    expect(store.get("cs-1")?.createdAt).toBe(1);
    expect(logs.some((m) => m.includes("起動 dir へ戻しました"))).toBe(true);
    // 記録が既に別値（resume 等で更新済み）なら触らない。
    store.put({ name: "cs-1", cwd: "/elsewhere", createdAt: 1 });
    expect(await reconcileWorktreeRecordCwd(store, "cs-1", "/repo/.claude/worktrees/pr-42", "/repo", () => {}, noSleep, () => false, 10, 1)).toBe(false);
    expect(store.get("cs-1")?.cwd).toBe("/elsewhere");
  });
});

describe("golden: claude-code-w34-v1.ndjson", () => {
  const hostRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  it("全行が byte-exact でラウンドトリップする", () => {
    const text = readFileSync(join(hostRoot, "protocol", "claude-code-w34-v1.ndjson"), "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(7);
    for (const line of lines) {
      expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    }
    const start = decodeControlMessage(lines[0]!);
    expect(start).toMatchObject({ type: "session_start", outputStyle: "Concise", todoTools: true, worktree: "#1234" });
  });
});
