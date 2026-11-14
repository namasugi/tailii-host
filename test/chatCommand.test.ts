// chatCommand.test.ts — `tailii-host chat`（tailii-chat-cli）: Bot 向けの会話の開始・送信・状態

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT, runChat, type ChatDeps } from "../src/commands/chat/chatCommand.js";
import {
  folderAllowed,
  loadBotConfig,
  readReply,
  readTranscriptLines,
  requestDigest,
  type RequestRecord,
} from "../src/commands/chat/chatState.js";
import type { EngineConnection } from "../src/commands/chat/engineClient.js";
import type { ControlMessage } from "../src/protocol.js";
import { makeTempDir, makeTempStore } from "./helpers.js";

type Handler = (message: Record<string, unknown>) => ControlMessage;

function harness(options: {
  handler?: Handler;
  stdin?: string | null;
  isTty?: boolean;
  roots?: string[];
  allowAuto?: boolean;
  state?: ChatDeps["state"];
  transcript?: ChatDeps["transcript"];
} = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const records = new Map<string, RequestRecord>();
  let output = "";
  const attached: string[] = [];
  const engine: EngineConnection = {
    async request(message) {
      sent.push(message);
      return (options.handler ?? defaultHandler)(message);
    },
    close() {},
  };
  const deps: ChatDeps = {
    connect: async () => engine,
    readStdin: () => options.stdin ?? null,
    isTty: options.isTty ?? false,
    config: () => ({ allowedRoots: options.roots ?? [makeTempDir("chat-root")], permissionMode: "acceptEdits", allowAuto: options.allowAuto ?? false }),
    store: () => makeTempStore(),
    write: (text) => { output += text; },
    now: () => 1_000_000,
    sleep: async () => {},
    attach: (session) => { attached.push(session); return 0; },
    readRequest: (id) => records.get(id) ?? null,
    writeRequest: (record) => { records.set(record.requestId, record); },
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.transcript !== undefined ? { transcript: options.transcript } : {}),
  };
  return { deps, sent, records, attached, output: () => output, json: () => JSON.parse(output.trim()) as Record<string, unknown> };
}

const defaultHandler: Handler = (message) => {
  const id = String(message["id"]);
  if (message["type"] === "session_start") {
    return {
      type: "session_list_response", v: 2, id, adoptedName: String(message["name"]),
      sessions: [{ name: String(message["name"]), cwd: String(message["cwd"]), alive: true, providerSessionId: "conv-new" }],
    } as ControlMessage;
  }
  if (message["type"] === "chat_send") return { type: "chat_send_result", v: 2, id, status: "accepted" } as ControlMessage;
  if (message["type"] === "claude_session_list_request") {
    return {
      type: "claude_session_list_response", v: 2, id,
      claudeSessions: [
        { sessionId: "conv-live-1", cwd: "/w", title: "動いている会話", liveSessionName: "s-live" },
        { sessionId: "conv-stop-1", cwd: "/w", title: "止まっている会話" },
        { sessionId: "conv-else-1", cwd: "/w", title: "他所の会話", peerSessionName: "term-1" },
      ],
    } as ControlMessage;
  }
  throw new Error(`unexpected ${String(message["type"])}`);
};

describe("chat new", () => {
  test("Bot（--json）は依頼 ID から決まる名前で起動し、許可モード acceptEdits・最初の指示を送って記録する", async () => {
    const root = makeTempDir("chat-new");
    const h = harness({ stdin: "テストを直して\n", roots: [root] });
    const code = await runChat(["new", "--cwd", root, "--request-id", "r-1", "--json"], h.deps);
    expect(code).toBe(EXIT.ok);
    const start = h.sent.find((m) => m["type"] === "session_start")!;
    expect(start).toMatchObject({
      cwd: fs.realpathSync(root), name: `s-${requestDigest("r-1").slice(0, 8)}`, agentType: "claude",
      permissionMode: "acceptEdits", deferSubscribe: true,
    });
    expect(h.sent.find((m) => m["type"] === "chat_send")).toMatchObject({
      session: start["name"], text: "テストを直して", clientMessageId: `cli-${requestDigest("r-1").slice(0, 24)}`,
    });
    expect(h.json()).toMatchObject({ v: 1, ok: true, requestId: "r-1", conversationId: "conv-new" });
    expect(h.records.get("r-1")).toMatchObject({ conversationId: "conv-new", text: "テストを直して", sentAtMs: 1_000_000 });
  });

  test("同じ依頼 ID の打ち直しは起動も送信もしない", async () => {
    const root = makeTempDir("chat-new-dup");
    const h = harness({ stdin: "x", roots: [root] });
    await runChat(["new", "--cwd", root, "--request-id", "r-2", "--json"], h.deps);
    h.sent.length = 0;
    const code = await runChat(["new", "--cwd", root, "--request-id", "r-2", "--json"], h.deps);
    expect(code).toBe(EXIT.ok);
    expect(h.sent).toEqual([]);
  });

  test.each([
    { label: "依頼 ID なし", args: (root: string) => ["new", "--cwd", root, "--json"], code: EXIT.usage, err: "missing_request_id" },
    { label: "許可外のフォルダ", args: () => ["new", "--cwd", "/", "--request-id", "r", "--json"], code: EXIT.usage, err: "folder_not_allowed" },
    { label: "存在しないフォルダ", args: (root: string) => ["new", "--cwd", path.join(root, "nope"), "--request-id", "r", "--json"], code: EXIT.usage, err: "folder_not_allowed" },
    { label: "auto は許可が無い", args: (root: string) => ["new", "--cwd", root, "--request-id", "r", "--permission-mode", "auto", "--json"], code: EXIT.policy, err: "auto_not_allowed" },
    { label: "会話 ID を渡した", args: (root: string) => ["new", "conv-1234567", "--cwd", root, "--request-id", "r", "--json"], code: EXIT.usage, err: "unexpected_argument" },
  ])("使えない呼び方は起動しない: $label", async ({ args, code, err }) => {
    const root = makeTempDir("chat-new-bad");
    const h = harness({ stdin: "x", roots: [root] });
    expect(await runChat(args(root), h.deps)).toBe(code);
    expect(h.json()).toMatchObject({ ok: false, error: { code: err } });
    expect(h.sent).toEqual([]);
  });

  test("Bot の指示文が空なら使い方の誤り", async () => {
    const root = makeTempDir("chat-new-empty");
    const h = harness({ stdin: "  \n", roots: [root] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r", "--json"], h.deps)).toBe(EXIT.usage);
  });

  test("人が端末で打つと、指示文なしでも始めて画面を開く。--json なら開かない", async () => {
    const root = makeTempDir("chat-new-tty");
    const h = harness({ isTty: true, roots: [root] });
    expect(await runChat(["new", "--cwd", root], h.deps)).toBe(EXIT.ok);
    expect(h.attached).toHaveLength(1);
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
    expect(h.sent.find((m) => m["type"] === "session_start")?.["permissionMode"]).toBeUndefined();

    const bot = harness({ isTty: true, stdin: "x", roots: [root] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-tty", "--json"], bot.deps)).toBe(EXIT.ok);
    expect(bot.attached).toEqual([]);
  });
});

describe("chat send", () => {
  test("動いている会話へはそのまま送る", async () => {
    const h = harness({ stdin: "続けて" });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-1", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.some((m) => m["type"] === "session_start")).toBe(false);
    expect(h.sent.find((m) => m["type"] === "chat_send")).toMatchObject({ session: "s-live", text: "続けて" });
  });

  test("止まっている会話は peerCheck 付きで続きから起動して送る", async () => {
    const h = harness({ stdin: "続けて" });
    expect(await runChat(["send", "conv-stop-1", "--request-id", "s-2", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "session_start")).toMatchObject({ resumeSessionId: "conv-stop-1", peerCheck: true });
  });

  test("他所で動いていれば送らずに終了コード 4", async () => {
    const h = harness({
      stdin: "続けて",
      handler: (message) => message["type"] === "session_start"
        ? { type: "session_peer_conflict", v: 2, id: String(message["id"]), conversationId: "conv-stop-1", holder: "terminal",
            holderName: "work-1", busy: false, canTakeOver: true, token: "t" } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["send", "conv-stop-1", "--request-id", "s-3", "--json"], h.deps)).toBe(EXIT.elsewhere);
    expect(h.json()).toMatchObject({ ok: false, error: { code: "running_elsewhere" }, where: "terminal", canTakeOver: true });
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
  });

  test("見つからない会話は終了コード 3、送信の確定に失敗したら 6", async () => {
    const missing = harness({ stdin: "x" });
    expect(await runChat(["send", "conv-none-1", "--request-id", "s-4", "--json"], missing.deps)).toBe(EXIT.notFound);
    const failing = harness({
      stdin: "x",
      handler: (message) => message["type"] === "chat_send"
        ? { type: "chat_send_result", v: 2, id: String(message["id"]), status: "failed", error: "busy" } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-5", "--json"], failing.deps)).toBe(EXIT.retryLater);
    expect(failing.records.has("s-5")).toBe(false);
  });
});

describe("chat status", () => {
  function transcriptFile(lines: object[]): string {
    const dir = makeTempDir("chat-transcript");
    const file = path.join(dir, "conv.jsonl");
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    return file;
  }

  test("--after でその依頼への返答だけを返し、処理が終わっていれば complete", async () => {
    const file = transcriptFile([
      { type: "user", timestamp: "2026-11-15T00:00:00Z", message: { role: "user", content: "前の依頼" } },
      { type: "assistant", timestamp: "2026-11-15T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "前の返答" }] } },
      { type: "user", timestamp: new Date(1_000_500).toISOString(), message: { role: "user", content: "テストを直して" } },
      { type: "assistant", timestamp: new Date(1_000_600).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", timestamp: new Date(1_000_700).toISOString(), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", timestamp: new Date(1_000_800).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "直しました" }] } },
    ]);
    const h = harness({ state: () => "idle", transcript: () => ({ file, cwd: "/w" }) });
    h.records.set("r-9", { requestId: "r-9", kind: "send", conversationId: "conv-0009", session: "s", cwd: "/w", sentAtMs: 1_000_000, text: "テストを直して" });
    expect(await runChat(["status", "conv-0009", "--after", "r-9", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ ok: true, state: "idle", complete: true, received: true, reply: "直しました" });
  });

  test("処理中は complete=false のまま、--wait の期限で返す", async () => {
    const file = transcriptFile([{ type: "user", timestamp: new Date(1_000_500).toISOString(), message: { role: "user", content: "x" } }]);
    const h = harness({ state: () => "busy", transcript: () => ({ file, cwd: "/w" }) });
    expect(await runChat(["status", "conv-0009", "--wait", "0", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ state: "busy", complete: false, reply: null });
  });
});

describe("chatState", () => {
  test("bot.json: 既定はホームの中・acceptEdits・auto 不可。auto の既定は allowAuto が無ければ acceptEdits に落とす", () => {
    const file = path.join(makeTempDir("bot-config"), "bot.json");
    expect(loadBotConfig(file)).toMatchObject({ permissionMode: "acceptEdits", allowAuto: false });
    fs.writeFileSync(file, JSON.stringify({ allowedRoots: ["/srv/work"], permissionMode: "auto" }));
    expect(loadBotConfig(file)).toEqual({ allowedRoots: ["/srv/work"], permissionMode: "acceptEdits", allowAuto: false });
  });

  test("作業フォルダは実パスで許可範囲の中だけ（../ で外へ出られない）", () => {
    const root = makeTempDir("allowed");
    fs.mkdirSync(path.join(root, "a"));
    expect(folderAllowed(path.join(root, "a"), [root])).toBe(true);
    expect(folderAllowed(path.join(root, "a", ".."), [path.join(root, "a")])).toBe(false);
  });

  test("記録の読み取りはツールの結果・注入・メタ行を除く", () => {
    const dir = makeTempDir("transcript-lines");
    const file = path.join(dir, "c.jsonl");
    fs.writeFileSync(file, [
      { type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>" } },
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      { type: "user", message: { role: "user", content: "本当の発話" } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    expect(readTranscriptLines(file).map((line) => line.text)).toEqual(["本当の発話"]);
    expect(readReply([], { sentAtMs: 0, text: "x" })).toEqual({ found: false, reply: null });
  });
});
