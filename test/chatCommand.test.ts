// chatCommand.test.ts — `tailii-host chat`（tailii-chat-cli）: Bot 向けの会話の開始・送信・状態

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT, runChat, type ChatDeps } from "../src/commands/chat/chatCommand.js";
import {
  acquireRequestLock,
  codexRolloutBusy,
  findCodexRollout,
  findModelCommandResult,
  folderAllowed,
  readCodexRolloutLines,
  loadBotConfig,
  readReply,
  readTranscriptLines,
  requestDigest,
  type RequestRecord,
} from "../src/commands/chat/chatState.js";
import { EngineTimeoutError, type EngineConnection } from "../src/commands/chat/engineClient.js";
import { readApprovalDecision, removePendingApproval, writePendingApproval } from "../src/approval/approvalMailbox.js";
import type { ControlMessage } from "../src/protocol.js";
import { makeTempDir, makeTempStore } from "./helpers.js";

type Handler = (message: Record<string, unknown>) => ControlMessage;

function harness(options: {
  handler?: Handler;
  stdin?: string | null;
  isTty?: boolean;
  roots?: string[];
  allowAuto?: boolean;
  allowApprove?: boolean;
  allowTakeOver?: boolean;
  state?: ChatDeps["state"];
  transcript?: ChatDeps["transcript"];
} = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const records = new Map<string, RequestRecord>();
  const locks = new Set<string>();
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
    config: () => ({ allowedRoots: options.roots ?? ["/"], permissionMode: "acceptEdits", allowAuto: options.allowAuto ?? false,
      allowApprove: options.allowApprove ?? false, allowTakeOver: options.allowTakeOver ?? false }),
    store: () => makeTempStore(),
    write: (text) => { output += text; },
    now: () => 1_000_000,
    sleep: async () => {},
    attach: (session) => { attached.push(session); return 0; },
    readRequest: (id) => records.get(id) ?? null,
    writeRequest: (record) => { records.set(record.requestId, record); },
    lockRequest: (id) => {
      if (locks.has(id)) return null;
      locks.add(id);
      return () => { locks.delete(id); };
    },
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.transcript !== undefined ? { transcript: options.transcript } : {}),
  };
  return { deps, sent, records, locks, attached, output: () => output, json: () => JSON.parse(output.trim()) as Record<string, unknown> };
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
  // 受領の照会の既定は保留中（hub がまだ送信を持っている）。
  if (message["type"] === "chat_receipt_query") return { type: "chat_receipt_query_result", v: 2, id, status: "pending" } as ControlMessage;
  if (message["type"] === "session_alive_query") {
    // 止まっている会話名は s-dead だけ。ほかは動いている。
    return { type: "session_alive_query_result", v: 2, id, name: String(message["name"]),
      alive: message["name"] !== "s-dead" } as ControlMessage;
  }
  if (message["type"] === "claude_session_list_request") {
    return {
      type: "claude_session_list_response", v: 2, id,
      claudeSessions: [
        { sessionId: "conv-live-1", cwd: "/tmp", title: "動いている会話", liveSessionName: "s-live" },
        { sessionId: "conv-stop-1", cwd: "/tmp", title: "止まっている会話" },
        { sessionId: "conv-else-1", cwd: "/tmp", title: "他所の会話", peerSessionName: "term-1" },
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
      cwd: fs.realpathSync(root), name: `s-cli${requestDigest("r-1").slice(0, 16)}`, agentType: "claude",
      permissionMode: "acceptEdits", deferSubscribe: true,
    });
    expect(h.sent.find((m) => m["type"] === "chat_send")).toMatchObject({
      session: start["name"], text: "テストを直して", clientMessageId: `cli-${requestDigest("r-1").slice(0, 24)}`,
    });
    expect(h.json()).toMatchObject({ v: 1, ok: true, requestId: "r-1", conversationId: "conv-new" });
    expect(h.records.get("r-1")).toMatchObject({ conversationId: "conv-new", text: "テストを直して", sentAtMs: 1_000_000, state: "sent" });
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
    // 届いたか分からないので状態不明（7）。記録は送信未確定（started）で残し、status --after で確かめられる（指摘 A3・A4）。
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-5", "--json"], failing.deps)).toBe(EXIT.timeout);
    expect(failing.records.get("s-5")?.state).toBe("started");
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
    expect(loadBotConfig(file)).toEqual({
      allowedRoots: ["/srv/work"], permissionMode: "acceptEdits", allowAuto: false, allowApprove: false, allowTakeOver: false,
      allowSetModel: false,
    });
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

describe("レビュー指摘の再発防止", () => {
  test("送信に失敗した new を同じ依頼 ID で打ち直すと、起動し直さず同じ会話・同じ送信 ID・最初の時刻で送る（A1・A3）", async () => {
    const root = makeTempDir("chat-retry");
    let fail = true;
    let now = 1_000_000;
    const h = harness({
      stdin: "x", roots: [root],
      handler: (message) => message["type"] === "chat_send" && fail
        ? { type: "chat_send_result", v: 2, id: String(message["id"]), status: "failed" } as ControlMessage
        : defaultHandler(message),
    });
    h.deps.now = () => now;
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-retry", "--json"], h.deps)).toBe(EXIT.timeout);
    fail = false;
    now = 1_060_000;
    h.sent.length = 0;
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-retry", "--json"], h.deps)).toBe(EXIT.ok);
    // 打ち直しの前に受領の照会を引き、hub がまだ持っていれば（pending）一覧を引かずに同じ会話名へ送る（4 周目 中1・6 周目 低4）。
    expect(h.sent.map((m) => m["type"])).toEqual(["chat_receipt_query", "chat_send"]);
    expect(h.records.get("r-retry")).toMatchObject({ state: "sent", sentAtMs: 1_000_000, conversationId: "conv-new" });
  });

  test("依頼 ID の使い回し（別の種類・別のフォルダ・別の本文）は送らずに使い方の誤り（A5）", async () => {
    const root = makeTempDir("chat-reuse");
    const h = harness({ stdin: "x", roots: [root] });
    await runChat(["new", "--cwd", root, "--request-id", "r-same", "--json"], h.deps);
    h.sent.length = 0;
    expect(await runChat(["send", "conv-live-1", "--request-id", "r-same", "--json"], h.deps)).toBe(EXIT.usage);
    const other = harness({ stdin: "y", roots: [root] });
    other.records.set("r-same", h.records.get("r-same")!);
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-same", "--json"], other.deps)).toBe(EXIT.usage);
    expect(h.sent).toEqual([]);
  });

  test("承認・設問の入力待ち（waiting）は完了にしない（A6）", async () => {
    const dir = makeTempDir("chat-waiting");
    const file = path.join(dir, "c.jsonl");
    fs.writeFileSync(file, [
      { type: "user", timestamp: new Date(1_000_500).toISOString(), message: { role: "user", content: "x" } },
      { type: "assistant", timestamp: new Date(1_000_600).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "途中" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    const h = harness({ state: () => "waiting", transcript: () => ({ file, cwd: "/w" }) });
    expect(await runChat(["status", "conv-0009", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ state: "waiting", complete: false });
  });

  test("端末が無ければ --json が無くても Bot として扱う（auto の制限・依頼 ID 必須。A7）", async () => {
    const root = makeTempDir("chat-no-tty");
    const h = harness({ stdin: "x", roots: [root], isTty: false });
    expect(await runChat(["new", "--cwd", root, "--permission-mode", "auto", "--request-id", "r"], h.deps)).toBe(EXIT.policy);
    expect(await runChat(["new", "--cwd", root], h.deps)).toBe(EXIT.usage);
    expect(h.sent).toEqual([]);
  });

  test("send も許可外の作業フォルダの会話には送らない（A7）", async () => {
    const h = harness({ stdin: "x", roots: [makeTempDir("chat-elsewhere-root")] });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-root", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
  });

  test("長い指示文はファイルに書き出して参照を送る（A8）", async () => {
    const root = makeTempDir("chat-long");
    const longDir = makeTempDir("chat-long-dir");
    const prompt = Array.from({ length: 60 }, (_, i) => `行 ${i}`).join("\n");
    const h = harness({ stdin: prompt, roots: [root] });
    h.deps.longTextDir = longDir;
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-long", "--json"], h.deps)).toBe(EXIT.ok);
    const text = String(h.sent.find((m) => m["type"] === "chat_send")?.["text"]);
    const file = text.slice(text.lastIndexOf(": ") + 2);
    expect(file.startsWith(longDir)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(prompt);
  });

  test("起動の応答に採用した名前の行が無ければ、別の会話の ID を返さずにエラー（A11）", async () => {
    const root = makeTempDir("chat-no-row");
    const h = harness({
      stdin: "x", roots: [root],
      handler: (message) => message["type"] === "session_start"
        ? { type: "session_list_response", v: 2, id: String(message["id"]), adoptedName: String(message["name"]),
            sessions: [{ name: "s-other", cwd: "/w", alive: true, providerSessionId: "conv-other" }] } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-row", "--json"], h.deps)).toBe(EXIT.internal);
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
  });
});

describe("2 周目レビューの再発防止", () => {
  test("届いたか分からない new の失敗にも会話 ID と会話名を載せ、案内は同じ依頼 ID の打ち直し（1・2）", async () => {
    const root = makeTempDir("chat-unknown");
    const h = harness({
      stdin: "x", roots: [root],
      handler: (message) => message["type"] === "chat_send"
        ? { type: "error", v: 2, id: String(message["id"]), code: "chat_send_failed", message: "hub timeout" } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-u", "--json"], h.deps)).toBe(EXIT.timeout);
    const out = h.json() as { error: { code: string; hint: string }; conversationId: string; session: string };
    expect(out.error.code).toBe("delivery_unknown");
    expect(out.conversationId).toBe("conv-new");
    expect(out.error.hint).toContain("同じ依頼 ID");
    expect(out.error.hint).not.toContain("新しい依頼 ID で送る");
  });

  test("hub が明示の再送を求めたら人に回す（新しい ID を送らせない。5）", async () => {
    const h = harness({
      stdin: "x",
      handler: (message) => message["type"] === "chat_send"
        ? { type: "chat_send_result", v: 2, id: String(message["id"]), status: "failed",
            error: "Previous tmux injection outcome is uncertain; explicit retry is required" } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-h", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "needs_human" } });
  });

  test("送信未確定の依頼は hub の受領照会で配送状態を返す（保留中は received=false・delivery=pending。1）", async () => {
    const dir = makeTempDir("chat-pending");
    const file = path.join(dir, "c.jsonl");
    fs.writeFileSync(file, "");
    const h = harness({ state: () => "waiting", transcript: () => ({ file, cwd: "/w" }) });
    h.deps.receipt = async () => "pending";
    h.records.set("r-p", { requestId: "r-p", kind: "send", conversationId: "conv-0009", session: "s", cwd: "/w",
      sentAtMs: 1_000_000, text: "x", state: "started" });
    expect(await runChat(["status", "conv-0009", "--after", "r-p", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ received: false, delivery: "pending", complete: false });
  });

  test("止まっている会話でも返答が出そろっていれば complete（3）", async () => {
    const dir = makeTempDir("chat-stopped");
    const file = path.join(dir, "c.jsonl");
    fs.writeFileSync(file, [
      { type: "user", timestamp: new Date(1_000_500).toISOString(), message: { role: "user", content: "x" } },
      { type: "assistant", timestamp: new Date(1_000_600).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "済み" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    const h = harness({ state: () => "not_running", transcript: () => ({ file, cwd: "/w" }) });
    expect(await runChat(["status", "conv-0009", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ complete: true, reply: "済み" });
  });

  test("起動を頼んだだけの記録（starting）の打ち直しは、起動済みの会話 id があれば起動し直さない（4）", async () => {
    const root = makeTempDir("chat-starting");
    const store = makeTempStore();
    const h = harness({ stdin: "x", roots: [root] });
    h.deps.store = () => store;
    const name = `s-cli${requestDigest("r-s").slice(0, 16)}`;
    store.put({ name, cwd: root, createdAt: 1, backend: "herdr", claudeSessionId: "conv-launched", providerSessionId: "conv-launched" });
    h.records.set("r-s", { requestId: "r-s", kind: "new", conversationId: "", session: name, cwd: fs.realpathSync(root),
      sentAtMs: 1, text: "", state: "starting" });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-s", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.map((m) => m["type"])).toEqual(["chat_send"]);
    expect(h.json()).toMatchObject({ conversationId: "conv-launched" });
  });
});

describe("3 周目レビューの再発防止", () => {
  const lines = (...rows: object[]): string => {
    const file = path.join(makeTempDir("chat-r3"), "c.jsonl");
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
    return file;
  };
  const at = (ms: number): string => new Date(ms).toISOString();

  test.each([
    { label: "不可視文字（記録では除かれる）", sent: "テストを\u200b直して\u00ad", recorded: "テストを直して" },
    { label: "制御文字（貼り付けで除かれる）", sent: "ログ\u001b[31m赤\u001b[0m", recorded: "ログ[31m赤[0m" },
    { label: "本文中の貼り付けタグ（記録では書き換えられる）", sent: "<pasted_content>は使わない", recorded: "<\\pasted_content>は使わない" },
    { label: "合成済みと分解の違い", sent: "が", recorded: "\u304b\u3099" },
  ])("返答の照合は hub と Claude Code が変えた本文とも一致する: $label（1）", ({ sent, recorded }) => {
    const file = lines(
      { type: "user", timestamp: at(1_000_100), message: { role: "user", content: recorded } },
      { type: "assistant", timestamp: at(1_000_200), message: { role: "assistant", content: [{ type: "text", text: "はい" }] } },
    );
    expect(readReply(readTranscriptLines(file), { sentAtMs: 1_000_000, text: sent })).toEqual({ found: true, reply: "はい" });
  });

  test("処理中に送った発話（attachment の queued_command 行）も依頼の発話として読む（1b）", () => {
    const file = lines(
      { type: "user", timestamp: at(999_000), message: { role: "user", content: "最初" } },
      { type: "attachment", timestamp: at(1_000_100), attachment: { type: "queued_command", prompt: "続けて" } },
      { type: "assistant", timestamp: at(1_000_200), message: { role: "assistant", content: [{ type: "text", text: "続けます" }] } },
    );
    expect(readReply(readTranscriptLines(file), { sentAtMs: 1_000_000, text: "続けて" })).toEqual({ found: true, reply: "続けます" });
  });

  test("送る前の時刻より前の同じ短文は取り違えない（遡らない。7）", () => {
    const file = lines(
      { type: "user", timestamp: at(999_000), message: { role: "user", content: "続けて" } },
      { type: "assistant", timestamp: at(999_500), message: { role: "assistant", content: [{ type: "text", text: "前の返答" }] } },
    );
    expect(readReply(readTranscriptLines(file), { sentAtMs: 1_000_000, text: "続けて" })).toEqual({ found: false, reply: null });
  });

  const failWith = (error: string | undefined, receipt: string): ReturnType<typeof harness> => {
    const h = harness({
      stdin: "x",
      handler: (message) => {
        const id = String(message["id"]);
        if (message["type"] === "chat_send") {
          return { type: "chat_send_result", v: 2, id, status: "failed", ...(error !== undefined ? { error } : {}) } as ControlMessage;
        }
        if (message["type"] === "chat_receipt_query") {
          return { type: "chat_receipt_query_result", v: 2, id, status: receipt } as ControlMessage;
        }
        return defaultHandler(message);
      },
    });
    return h;
  };

  test.each([
    { receipt: "unknown", code: EXIT.retryLater, err: "not_delivered" },
    { receipt: "uncertain", code: EXIT.policy, err: "needs_human" },
    { receipt: "deleted", code: EXIT.policy, err: "message_deleted" },
    { receipt: "pending", code: EXIT.timeout, err: "delivery_unknown" },
  ])("hub の送信の失敗は受領の照会で分ける: $receipt（5）", async ({ receipt, code, err }) => {
    const h = failWith("dialog is open", receipt);
    expect(await runChat(["send", "conv-live-1", "--request-id", `s-${receipt}`, "--json"], h.deps)).toBe(code);
    expect(h.json()).toMatchObject({ ok: false, error: { code: err }, conversationId: "conv-live-1" });
  });

  test("needs_human の案内は実際に解ける操作（会話の終了と開き直し）を示す（2）", async () => {
    const h = failWith("Previous tmux injection outcome is uncertain; explicit retry is required", "uncertain");
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-hh", "--json"], h.deps)).toBe(EXIT.policy);
    const hint = (h.json() as { error: { hint: string } }).error.hint;
    expect(hint).toContain("終了");
    expect(hint).not.toContain("再送するか取り消す");
  });

  test("status は届いたか分からない送信で止まっていることを needsHuman で返す（2）", async () => {
    const file = lines();
    const h = harness({ state: () => "idle", transcript: () => ({ file, cwd: "/w" }) });
    h.deps.receipt = async () => "uncertain";
    h.records.set("r-un", { requestId: "r-un", kind: "send", conversationId: "conv-0009", session: "s", cwd: "/w",
      sentAtMs: 1_000_000, text: "x", state: "started" });
    expect(await runChat(["status", "conv-0009", "--after", "r-un", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ delivery: "uncertain", needsHuman: true });
  });

  test("同じ依頼 ID のコマンドが実行中なら、起動も送信もせずに終了コード 6（3）", async () => {
    const root = makeTempDir("chat-locked");
    const h = harness({ stdin: "x", roots: [root] });
    h.locks.add("r-lock");
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-lock", "--json"], h.deps)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "request_in_progress" } });
    expect(h.sent).toEqual([]);
    expect(await runChat(["send", "conv-live-1", "--request-id", "r-lock", "--json"], h.deps)).toBe(EXIT.retryLater);
    expect(h.sent).toEqual([]);
    h.locks.clear();
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-lock", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.locks.size).toBe(0);
  });

  test("依頼の排他: 2 本目は取れず、持ち主の居ない錠は取り直せる（3）", () => {
    const dir = makeTempDir("chat-lockfile");
    const release = acquireRequestLock("r-x", dir);
    expect(release).not.toBeNull();
    expect(acquireRequestLock("r-x", dir)).toBeNull();
    release!();
    expect(acquireRequestLock("r-x", dir)).not.toBeNull();
    const stale = path.join(dir, `${requestDigest("r-y").slice(0, 32)}.lock`);
    fs.writeFileSync(stale, JSON.stringify({ pid: 2_147_483_000, atMs: Date.now() }));
    expect(acquireRequestLock("r-y", dir)).not.toBeNull();
  });

  test("state の無い旧形式の記録は送信済みとして扱い、new を打ち直しても起動も送信もしない（6）", async () => {
    const root = makeTempDir("chat-legacy");
    const h = harness({ stdin: "x", roots: [root] });
    h.records.set("r-old", { requestId: "r-old", kind: "new", conversationId: "conv-old-1", session: "s-cliold",
      cwd: fs.realpathSync(root), sentAtMs: 1, text: "x" });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-old", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent).toEqual([]);
    expect(h.json()).toMatchObject({ duplicate: true, conversationId: "conv-old-1" });
  });

  test("起動の時間切れは会話名を返し、起動途中の依頼の status は打ち直しを案内する（小）", async () => {
    const root = makeTempDir("chat-start-timeout");
    const h = harness({
      stdin: "x", roots: [root],
      handler: (message) => {
        if (message["type"] === "session_start") throw new EngineTimeoutError("session_start");
        return defaultHandler(message);
      },
    });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-st", "--json"], h.deps)).toBe(EXIT.timeout);
    expect(h.json()).toMatchObject({ error: { code: "start_timeout" }, requestId: "r-st",
      session: `s-cli${requestDigest("r-st").slice(0, 16)}` });
    const s = harness();
    s.records.set("r-st", h.records.get("r-st")!);
    expect(await runChat(["status", "conv-0009", "--after", "r-st", "--json"], s.deps)).toBe(EXIT.notFound);
    expect(s.json()).toMatchObject({ error: { code: "request_not_started" } });
  });
});

describe("4 周目レビューの再発防止", () => {
  const startedRecord = (session: string): RequestRecord => ({
    requestId: "r-rev", kind: "send", conversationId: "conv-stop-1", session, cwd: "/tmp", sentAtMs: 1, text: "x",
    textHash: undefined, state: "started",
  });

  const reviveHarness = (receipt: string) => harness({
    stdin: "x",
    handler: (message) => {
      const id = String(message["id"]);
      if (message["type"] === "chat_receipt_query") {
        return { type: "chat_receipt_query_result", v: 2, id, status: receipt } as ControlMessage;
      }
      if (message["type"] === "session_start") {
        return { type: "session_list_response", v: 2, id, adoptedName: String(message["name"]),
          sessions: [{ name: String(message["name"]), cwd: "/tmp", alive: true, providerSessionId: "conv-stop-1" }] } as ControlMessage;
      }
      return defaultHandler(message);
    },
  });

  test("送信未確定の打ち直しで記録の会話が終わっていたら、続きから起動してその会話名へ送る（中1）", async () => {
    const h = reviveHarness("unknown");
    const record = startedRecord("s-dead");
    delete record.textHash;
    h.records.set("r-rev", record);
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r-rev", "--json"], h.deps)).toBe(EXIT.ok);
    const start = h.sent.find((m) => m["type"] === "session_start")!;
    expect(start).toMatchObject({ resumeSessionId: "conv-stop-1", peerCheck: true });
    expect(h.sent.find((m) => m["type"] === "chat_send")).toMatchObject({ session: start["name"] });
    expect(h.records.get("r-rev")).toMatchObject({ session: start["name"], state: "sent", sentAtMs: 1 });
  });

  test("終わった会話への前の送信が届いていたら、起動も送信もせずに送信済みにする（中1）", async () => {
    const h = reviveHarness("delivered");
    const record = startedRecord("s-dead");
    delete record.textHash;
    h.records.set("r-rev", record);
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r-rev", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.map((m) => m["type"])).toEqual(["chat_receipt_query"]);
    expect(h.records.get("r-rev")?.state).toBe("sent");
  });

  test("記録の会話がまだ動いていれば、そのまま送る（中1）", async () => {
    const h = reviveHarness("unknown");
    const record = { ...startedRecord("s-live"), conversationId: "conv-live-1" };
    delete record.textHash;
    h.records.set("r-rev", record);
    expect(await runChat(["send", "conv-live-1", "--request-id", "r-rev", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.map((m) => m["type"])).toEqual(["chat_receipt_query", "claude_session_list_request", "chat_send"]);
  });

  test("届ける前に会話が終わった失敗は 6・conversation_ended（中1）", async () => {
    const h = harness({
      stdin: "x",
      handler: (message) => {
        const id = String(message["id"]);
        if (message["type"] === "chat_send") {
          return { type: "chat_send_result", v: 2, id, status: "failed", error: "session retired before delivery completed" } as ControlMessage;
        }
        if (message["type"] === "chat_receipt_query") return { type: "chat_receipt_query_result", v: 2, id, status: "unknown" } as ControlMessage;
        return defaultHandler(message);
      },
    });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-end", "--json"], h.deps)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "conversation_ended" } });
  });

  test("前の送信の後ろで止まっている送信は、時間切れの後に人に回す（中2）", async () => {
    const h = harness({
      stdin: "x",
      handler: (message) => {
        const id = String(message["id"]);
        if (message["type"] === "chat_send") throw new EngineTimeoutError("chat_send");
        if (message["type"] === "chat_receipt_query") {
          return { type: "chat_receipt_query_result", v: 2, id, status: "pending", blocked: true } as ControlMessage;
        }
        return defaultHandler(message);
      },
    });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-blk", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "needs_human" }, conversationId: "conv-live-1" });
  });

  test("status は blocked を needsHuman で返す（中2）", async () => {
    const file = path.join(makeTempDir("chat-blocked"), "c.jsonl");
    fs.writeFileSync(file, "");
    const h = harness({ state: () => "idle", transcript: () => ({ file, cwd: "/w" }) });
    h.deps.receipt = async () => "blocked";
    h.records.set("r-b", { requestId: "r-b", kind: "send", conversationId: "conv-0009", session: "s", cwd: "/w",
      sentAtMs: 1_000_000, text: "x", state: "started" });
    expect(await runChat(["status", "conv-0009", "--after", "r-b", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ delivery: "blocked", needsHuman: true });
  });
});

describe("5 周目レビューの再発防止", () => {
  const transcriptWith = (text: string | null): ChatDeps["transcript"] => {
    const file = path.join(makeTempDir("chat-r5"), "c.jsonl");
    fs.writeFileSync(file, text === null ? "" : JSON.stringify(
      { type: "user", timestamp: new Date(5_000).toISOString(), message: { role: "user", content: text } }));
    return () => ({ file, cwd: "/tmp" });
  };
  const deadRecord = (extra: Partial<RequestRecord> = {}): RequestRecord => ({
    requestId: "r5", kind: "send", conversationId: "conv-stop-1", session: "s-dead", cwd: "/tmp", sentAtMs: 1_000, text: "やって",
    state: "started", ...extra,
  });
  const withReceipt = (receipt: string | "throw", transcript: ChatDeps["transcript"]) => harness({
    stdin: "やって", transcript,
    handler: (message) => {
      const id = String(message["id"]);
      if (message["type"] === "chat_receipt_query") {
        if (receipt === "throw") throw new EngineTimeoutError("chat_receipt_query");
        return { type: "chat_receipt_query_result", v: 2, id, status: receipt } as ControlMessage;
      }
      return defaultHandler(message);
    },
  });

  test("会話が終わって照会が unknown でも、会話の記録に発話があれば届いた扱いで送り直さない（1）", async () => {
    const h = withReceipt("unknown", transcriptWith("やって"));
    h.records.set("r5", deadRecord());
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r5", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.some((m) => m["type"] === "chat_send" || m["type"] === "session_start")).toBe(false);
    expect(h.records.get("r5")?.state).toBe("sent");
  });

  test("人に回した依頼の打ち直しは、記録に無ければ人に回したまま・送らない（1）", async () => {
    const h = withReceipt("unknown", transcriptWith(null));
    h.records.set("r5", deadRecord({ needsHuman: true }));
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r5", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "needs_human" } });
    expect(h.sent.some((m) => m["type"] === "chat_send" || m["type"] === "session_start")).toBe(false);
  });

  test("needs_human を返した依頼は記録に印を残し、status も人に回す（1）", async () => {
    const h = harness({
      stdin: "x",
      handler: (message) => message["type"] === "chat_send"
        ? { type: "chat_send_result", v: 2, id: String(message["id"]), status: "failed",
            error: "Previous tmux injection outcome is uncertain; explicit retry is required" } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["send", "conv-live-1", "--request-id", "r5h", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.records.get("r5h")).toMatchObject({ state: "started", needsHuman: true });
  });

  test.each([
    { receipt: "throw", code: EXIT.timeout, err: "delivery_unknown" },
    { receipt: "uncertain", code: EXIT.policy, err: "needs_human" },
    { receipt: "blocked", code: EXIT.policy, err: "needs_human" },
  ])("会話が終わっていても照会が $receipt なら起動し直して送らない（2）", async ({ receipt, code, err }) => {
    const h = withReceipt(receipt === "blocked" ? "pending" : receipt, transcriptWith(null));
    if (receipt === "blocked") {
      h.deps.connect = async () => ({
        async request(message) {
          h.sent.push(message);
          if (message["type"] === "chat_receipt_query") {
            return { type: "chat_receipt_query_result", v: 2, id: String(message["id"]), status: "pending", blocked: true } as ControlMessage;
          }
          return defaultHandler(message);
        },
        async close() {},
      });
    }
    h.records.set("r5", deadRecord());
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r5", "--json"], h.deps)).toBe(code);
    expect(h.json()).toMatchObject({ error: { code: err } });
    expect(h.sent.some((m) => m["type"] === "chat_send" || m["type"] === "session_start")).toBe(false);
  });

  test("照会が pending なら起動し直さず、記録の会話名へ送って合流する（2）", async () => {
    const h = withReceipt("pending", transcriptWith(null));
    h.records.set("r5", deadRecord());
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r5", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.some((m) => m["type"] === "session_start")).toBe(false);
    expect(h.sent.find((m) => m["type"] === "chat_send")).toMatchObject({ session: "s-dead" });
  });

  test("new の最初の指示が届く前に会話が終わったら、新しい依頼 ID でのやり直しを案内する（3）", async () => {
    const root = makeTempDir("chat-r5-new");
    const h = withReceipt("unknown", () => null);
    h.records.set("r5n", { requestId: "r5n", kind: "new", conversationId: "conv-gone-1", session: "s-dead",
      cwd: fs.realpathSync(root), sentAtMs: 1_000, text: "x", state: "started" });
    h.deps.readStdin = () => "x";
    expect(await runChat(["new", "--cwd", root, "--request-id", "r5n", "--json"], h.deps)).toBe(EXIT.notFound);
    expect(h.json()).toMatchObject({ error: { code: "conversation_ended_before_start" } });
    expect(h.sent.some((m) => m["type"] === "chat_send" || m["type"] === "session_start")).toBe(false);
  });
});

describe("6 周目レビューの再発防止", () => {
  test("照会が engine の error 応答なら照会できなかった扱い（7）で、送り直さない（低2）", async () => {
    const h = harness({
      stdin: "x",
      handler: (message) => message["type"] === "chat_receipt_query"
        ? { type: "error", v: 2, id: String(message["id"]), code: "chat_receipt_query_failed", message: "hub down" } as ControlMessage
        : defaultHandler(message),
    });
    h.records.set("r6", { requestId: "r6", kind: "send", conversationId: "conv-stop-1", session: "s-dead", cwd: "/tmp",
      sentAtMs: 1, text: "x", state: "started" });
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r6", "--json"], h.deps)).toBe(EXIT.timeout);
    expect(h.json()).toMatchObject({ error: { code: "delivery_unknown" }, conversationId: "conv-stop-1" });
    expect(h.sent.some((m) => m["type"] === "chat_send" || m["type"] === "session_start")).toBe(false);
  });

  test("打ち直しで照会が uncertain なら記録に人に回した印を残す（低3）", async () => {
    const h = harness({
      stdin: "x",
      handler: (message) => message["type"] === "chat_receipt_query"
        ? { type: "chat_receipt_query_result", v: 2, id: String(message["id"]), status: "uncertain" } as ControlMessage
        : defaultHandler(message),
    });
    h.records.set("r6u", { requestId: "r6u", kind: "send", conversationId: "conv-stop-1", session: "s-dead", cwd: "/tmp",
      sentAtMs: 1, text: "x", state: "started" });
    expect(await runChat(["send", "conv-stop-1", "--request-id", "r6u", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.records.get("r6u")).toMatchObject({ needsHuman: true, state: "started" });
  });
});

describe("第 2 段: 承認・設問・開き直し・画面・起動先", () => {
  const CONV = "conv-p2-0001";
  const SESSION = "s-cli0123456789abcdef";
  const questionReply = (id: string, session: string, questionId = "toolu_q1", multiSelect = false) => ({
    type: "chat_pending_query_result", v: 2, id, session, processing: true,
    question: { id: questionId, questions: [{ header: "方針", question: "どちらにしますか", multiSelect,
      options: [{ label: "A", description: "前者" }, { label: "B", description: "" }, { label: "C", description: "" }] }] },
  }) as ControlMessage;

  function p2Harness(options: { handler?: Handler; state?: ChatDeps["state"]; allowApprove?: boolean; allowTakeOver?: boolean;
    isTty?: boolean } = {}) {
    const store = makeTempStore();
    store.put({ name: SESSION, cwd: "/tmp", createdAt: 1, backend: "herdr", claudeSessionId: CONV, providerSessionId: CONV });
    const file = path.join(makeTempDir("p2-transcript"), "c.jsonl");
    fs.writeFileSync(file, "");
    const h = harness({
      handler: options.handler ?? defaultHandler, state: options.state ?? (() => "waiting"),
      transcript: () => ({ file, cwd: "/tmp" }),
      ...(options.allowApprove !== undefined ? { allowApprove: options.allowApprove } : {}),
      ...(options.allowTakeOver !== undefined ? { allowTakeOver: options.allowTakeOver } : {}),
      ...(options.isTty !== undefined ? { isTty: options.isTty } : {}),
    });
    h.deps.store = () => store;
    h.deps.approvalsBase = makeTempDir("p2-approvals");
    h.deps.botStarted = (id) => id === CONV;
    return { ...h, store };
  }

  test("status は待っている承認を waiting_approval で返し、--wait でも待たずに返す", async () => {
    const h = p2Harness({ state: () => "busy" });
    writePendingApproval({ id: "ap-1", session: SESSION, tool: "Bash", summary: "rm -rf build", cwd: "/tmp", atMs: 1,
      pid: process.pid }, h.deps.approvalsBase!);
    expect(await runChat(["status", CONV, "--wait", "60", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ state: "waiting_approval", complete: false,
      waiting: { approvals: [{ approvalId: "ap-1", tool: "Bash", summary: "rm -rf build" }] } });
  });

  test("status は答え待ちの設問を waiting_answer で、番号付きの選択肢と一緒に返す", async () => {
    const h = p2Harness({
      handler: (message) => message["type"] === "chat_pending_query"
        ? questionReply(String(message["id"]), String(message["session"])) : defaultHandler(message),
    });
    expect(await runChat(["status", CONV, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ state: "waiting_answer", waiting: { question: { questionId: "toolu_q1",
      questions: [{ number: 1, multiSelect: false, options: [{ choice: 1, label: "A", description: "前者" }, { choice: 2, label: "B" }, { choice: 3 }] }] } } });
  });

  test("answer は番号を 0 始まりの回答にして送り、受理（remote_pending_cleared）で成功", async () => {
    const h = p2Harness({
      handler: (message) => {
        if (message["type"] === "chat_pending_query") return questionReply(String(message["id"]), String(message["session"]), "toolu_q1", true);
        if (message["type"] === "question_answer") {
          return { type: "remote_pending_cleared", v: 2, id: "toolu_q1", session: SESSION, kind: "question" } as ControlMessage;
        }
        return defaultHandler(message);
      },
    });
    expect(await runChat(["answer", CONV, "toolu_q1", "--choice", "1,3", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "question_answer")).toMatchObject({
      id: "toolu_q1", session: SESSION,
      answers: [{ questionIndex: 0, selectedOptionIndexes: [0, 2], multiSelect: true }],
    });
    expect(h.json()).toMatchObject({ ok: true, answered: true });
  });

  test.each([
    { label: "範囲外の番号", args: ["--choice", "4"], err: "bad_choice" },
    { label: "1 つしか選べない設問に 2 つ", args: ["--choice", "1,2"], err: "single_choice" },
    { label: "答えが無い", args: [], err: "missing_choice" },
  ])("answer の誤った選択は送らない: $label", async ({ args, err }) => {
    const h = p2Harness({
      handler: (message) => message["type"] === "chat_pending_query"
        ? questionReply(String(message["id"]), String(message["session"])) : defaultHandler(message),
    });
    expect(await runChat(["answer", CONV, "toolu_q1", ...args, "--json"], h.deps)).toBe(EXIT.usage);
    expect(h.json()).toMatchObject({ error: { code: err } });
    expect(h.sent.some((m) => m["type"] === "question_answer")).toBe(false);
  });

  test.each([
    { label: "1 つだけ選ぶ設問のその他", multi: false, args: ["--other", "紫"], selected: [3] },
    { label: "複数選べる設問の選択とその他", multi: true, args: ["--choice", "1,3", "--other", "紫"], selected: [0, 2, 3] },
  ])("answer の --other はアプリと同じく、その他の行の番号を足して送る: $label", async ({ multi, args, selected }) => {
    const h = p2Harness({
      handler: (message) => {
        if (message["type"] === "chat_pending_query") return questionReply(String(message["id"]), String(message["session"]), "toolu_q1", multi);
        if (message["type"] === "question_answer") {
          return { type: "remote_pending_cleared", v: 2, id: "toolu_q1", session: SESSION, kind: "question" } as ControlMessage;
        }
        return defaultHandler(message);
      },
    });
    expect(await runChat(["answer", CONV, "toolu_q1", ...args, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "question_answer")).toMatchObject({
      answers: [{ questionIndex: 0, selectedOptionIndexes: selected, otherText: "紫", multiSelect: multi }],
    });
  });

  test("1 つだけ選ぶ設問で選択とその他を一緒に送らない", async () => {
    const h = p2Harness({
      handler: (message) => message["type"] === "chat_pending_query"
        ? questionReply(String(message["id"]), String(message["session"])) : defaultHandler(message),
    });
    expect(await runChat(["answer", CONV, "toolu_q1", "--choice", "2", "--other", "紫", "--json"], h.deps)).toBe(EXIT.usage);
    expect(h.json()).toMatchObject({ error: { code: "choice_with_other" } });
    expect(h.sent.some((m) => m["type"] === "question_answer")).toBe(false);
  });

  test("Bot の許可は許可された作業フォルダの中の承認だけ", async () => {
    const h = p2Harness({ allowApprove: true });
    h.deps.config = () => ({ allowedRoots: [makeTempDir("p2-root")], permissionMode: "acceptEdits", allowAuto: false,
      allowApprove: true, allowTakeOver: false });
    writePendingApproval({ id: "ap-6", session: SESSION, tool: "Bash", summary: "x", cwd: "/tmp", atMs: 1, pid: process.pid },
      h.deps.approvalsBase!);
    expect(await runChat(["approve", CONV, "ap-6", "allow", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "folder_not_allowed" } });
  });

  test("Bot は自分が始めていない会話の設問に答えられない・待っていない設問は 3", async () => {
    const h = p2Harness();
    h.deps.botStarted = () => false;
    expect(await runChat(["answer", CONV, "toolu_q1", "--choice", "1", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "answer_not_allowed" } });
    const g = p2Harness({
      handler: (message) => message["type"] === "chat_pending_query"
        ? { type: "chat_pending_query_result", v: 2, id: String(message["id"]), session: SESSION, processing: false } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["answer", CONV, "toolu_q1", "--choice", "1", "--json"], g.deps)).toBe(EXIT.notFound);
    expect(g.json()).toMatchObject({ error: { code: "question_not_found" } });
  });

  test("approve: Bot の許可は bot.json で許したときだけ。拒否はいつでも置ける", async () => {
    const h = p2Harness();
    writePendingApproval({ id: "ap-2", session: SESSION, tool: "Bash", summary: "x", cwd: "/tmp", atMs: 1, pid: process.pid },
      h.deps.approvalsBase!);
    expect(await runChat(["approve", CONV, "ap-2", "allow", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "approve_not_allowed" } });
    expect(readApprovalDecision(SESSION, "ap-2", h.deps.approvalsBase!)).toBeNull();
    const d = p2Harness();
    d.deps.approvalsBase = h.deps.approvalsBase!;
    expect(await runChat(["approve", CONV, "ap-2", "deny", "--reason", "危ない", "--json"], d.deps)).toBe(EXIT.ok);
    expect(readApprovalDecision(SESSION, "ap-2", d.deps.approvalsBase)).toMatchObject({ decision: "deny", reason: "危ない", by: "cli" });
    expect(d.json()).toMatchObject({ approvalId: "ap-2", decision: "deny", applied: false });
  });

  test("approve: 許されていれば許可を置き、フックが片付けたら applied。別の会話の承認・無い承認は 3", async () => {
    const h = p2Harness({ allowApprove: true });
    const base = h.deps.approvalsBase!;
    writePendingApproval({ id: "ap-3", session: SESSION, tool: "Bash", summary: "x", cwd: "/tmp", atMs: 1, pid: process.pid }, base);
    h.deps.sleep = async () => { removePendingApproval(SESSION, "ap-3", base, { decision: "allow", by: "cli" }); };
    expect(await runChat(["approve", CONV, "ap-3", "allow", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ decision: "allow", applied: true });
    // アプリが先に逆の答えを返したら、その決定を返す。
    const raced = p2Harness({ allowApprove: true });
    const racedBase = raced.deps.approvalsBase!;
    writePendingApproval({ id: "ap-5", session: SESSION, tool: "Bash", summary: "x", cwd: "/tmp", atMs: 1, pid: process.pid }, racedBase);
    raced.deps.sleep = async () => { removePendingApproval(SESSION, "ap-5", racedBase, { decision: "deny", by: "app" }); };
    expect(await runChat(["approve", CONV, "ap-5", "allow", "--json"], raced.deps)).toBe(EXIT.ok);
    expect(raced.json()).toMatchObject({ decision: "deny", applied: false, decidedBy: "app" });
    const other = p2Harness({ allowApprove: true });
    writePendingApproval({ id: "ap-4", session: "s-other-1", tool: "Bash", summary: "x", cwd: "/tmp", atMs: 1, pid: process.pid },
      other.deps.approvalsBase!);
    expect(await runChat(["approve", CONV, "ap-4", "allow", "--json"], other.deps)).toBe(EXIT.notFound);
    expect(await runChat(["approve", CONV, "nope", "deny", "--json"], other.deps)).toBe(EXIT.notFound);
  });

  const peerHandler = (check: Record<string, unknown>): Handler => (message) => {
    const id = String(message["id"]);
    if (message["type"] === "session_peer_check") {
      return { type: "session_peer_check_response", v: 2, id, conversationId: CONV, ...check } as ControlMessage;
    }
    if (message["type"] === "claude_session_list_request") {
      return { type: "claude_session_list_response", v: 2, id,
        claudeSessions: [{ sessionId: CONV, cwd: "/tmp", title: "端末の会話", peerSessionName: "term-1" }] } as ControlMessage;
    }
    if (message["type"] === "session_start") {
      return { type: "session_list_response", v: 2, id, adoptedName: String(message["name"]),
        sessions: [{ name: String(message["name"]), cwd: "/tmp", alive: true, providerSessionId: CONV }] } as ControlMessage;
    }
    return defaultHandler(message);
  };

  test("take-over: Bot は bot.json で許したときだけ・中断はさせない", async () => {
    const h = p2Harness({ handler: peerHandler({ clear: false, holder: "terminal", busy: false, canTakeOver: true, token: "tok" }) });
    expect(await runChat(["take-over", CONV, "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "take_over_not_allowed" } });
    const i = p2Harness({ allowTakeOver: true, handler: peerHandler({ clear: false, holder: "terminal", busy: true, canTakeOver: true, token: "tok" }) });
    expect(await runChat(["take-over", CONV, "--interrupt", "--json"], i.deps)).toBe(EXIT.policy);
    const b = p2Harness({ allowTakeOver: true, handler: peerHandler({ clear: false, holder: "terminal", busy: true, canTakeOver: true, token: "tok" }) });
    expect(await runChat(["take-over", CONV, "--json"], b.deps)).toBe(EXIT.elsewhere);
    expect(b.json()).toMatchObject({ error: { code: "busy_elsewhere" } });
    expect(b.sent.some((m) => m["type"] === "session_start")).toBe(false);
  });

  test("take-over: 許されていて相手が待機中なら、確認のトークンで開き直す", async () => {
    const h = p2Harness({ allowTakeOver: true,
      handler: peerHandler({ clear: false, holder: "terminal", busy: false, canTakeOver: true, token: "tok-1" }) });
    expect(await runChat(["take-over", CONV, "--json"], h.deps)).toBe(EXIT.ok);
    const start = h.sent.find((m) => m["type"] === "session_start")!;
    expect(start).toMatchObject({ resumeSessionId: CONV, peerCheck: true, takeOver: { token: "tok-1" } });
    expect(String(start["name"])).toMatch(/^s-cli[0-9a-f]{16}$/);
    expect(h.json()).toMatchObject({ tookOver: true, session: start["name"] });
  });

  test("take-over: 人は確かめてから（いいえなら開き直さない）。開き直せない相手は 4", async () => {
    const h = p2Harness({ isTty: true, handler: peerHandler({ clear: false, holder: "terminal", busy: false, canTakeOver: true, token: "t" }) });
    h.deps.confirm = () => false;
    expect(await runChat(["take-over", CONV], h.deps)).toBe(EXIT.ok);
    expect(h.sent.some((m) => m["type"] === "session_start")).toBe(false);
    const r = p2Harness({ allowTakeOver: true, handler: peerHandler({ clear: false, holder: "remote", busy: false, canTakeOver: false }) });
    expect(await runChat(["take-over", CONV, "--json"], r.deps)).toBe(EXIT.elsewhere);
    expect(r.json()).toMatchObject({ error: { code: "cannot_take_over" }, where: "remote" });
  });

  test("attach は人向け（Bot は使えない）。動いている会話はその画面を開く", async () => {
    const h = p2Harness();
    expect(await runChat(["attach", "conv-live-1", "--json"], h.deps)).toBe(EXIT.usage);
    const t = harness({ isTty: true });
    expect(await runChat(["attach", "conv-live-1"], t.deps)).toBe(0);
    expect(t.attached).toEqual(["s-live"]);
  });

  test("new の起動先の明示を session_start に載せる（--herdr-session だけなら herdr）。食い違う指定は 2", async () => {
    const root = makeTempDir("chat-placement");
    const h = harness({ stdin: "x", roots: [root] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-pl", "--herdr-session", "work", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "session_start")).toMatchObject({ backend: "herdr", herdrSession: "work" });
    const bad = harness({ stdin: "x", roots: [root] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-pl2", "--backend", "tmux", "--herdr-session", "w", "--json"],
      bad.deps)).toBe(EXIT.usage);
    expect(bad.json()).toMatchObject({ error: { code: "conflicting_placement" } });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-pl3", "--backend", "screen", "--json"], bad.deps)).toBe(EXIT.usage);
  });
});

test("明示した herdr セッションを起動できなければ、同じ依頼 ID での再試行を案内する", async () => {
  const root = makeTempDir("chat-placement-down");
  const h = harness({
    stdin: "x", roots: [root],
    handler: (message) => message["type"] === "session_start"
      ? { type: "error", v: 2, id: String(message["id"]), code: "launch_failed",
          message: "tailii launch: herdr セッション 'w' を起動できませんでした\n" } as ControlMessage
      : defaultHandler(message),
  });
  expect(await runChat(["new", "--cwd", root, "--request-id", "r-down", "--herdr-session", "w", "--json"], h.deps)).toBe(EXIT.retryLater);
  expect(h.json()).toMatchObject({ error: { code: "launch_failed", hint: "少し待って同じ依頼 ID で打ち直す" } });
});

describe("Codex の会話（tailii-host chat の Codex 対応）", () => {
  const THREAD = "01a1d3d3-c29e-7ac0-801f-3ac8e55bd2c7";
  const at = (ms: number): string => new Date(ms).toISOString();
  const event = (ms: number, payload: Record<string, unknown>) => ({ timestamp: at(ms), type: "event_msg", payload });
  const rollout = (rows: object[]): string => {
    const dir = path.join(makeTempDir("codex-home"), "sessions", "2026", "11", "15");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-11-15T00-00-00-${THREAD}.jsonl`);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
    return file;
  };
  const userItem = (ms: number, text: string, clientId?: string) => event(ms, { type: "item_completed",
    item: { type: "UserMessage", content: [{ type: "text", text }], ...(clientId !== undefined ? { client_id: clientId } : {}) } });
  const agentItem = (ms: number, text: string, phase = "final_answer") => event(ms, { type: "item_completed",
    item: { type: "AgentMessage", content: [{ type: "Text", text }], phase } });

  test("rollout の発話（新旧の形）と処理中を読み、送った id（client_id）で依頼の発話を探す", () => {
    const file = rollout([
      event(1_000, { type: "user_message", message: "旧形式の発話" }),
      event(1_100, { type: "agent_message", message: "旧形式の返答" }),
      event(2_000, { type: "task_started" }),
      userItem(2_100, "同じ本文", "cli-other"),
      agentItem(2_200, "別の返答"),
      event(2_300, { type: "task_complete" }),
      event(3_000, { type: "task_started" }),
      userItem(3_100, "同じ本文", "cli-mine"),
      agentItem(3_150, "考え中", "analysis"),
      agentItem(3_200, "返答です", "commentary"),
    ]);
    const lines = readCodexRolloutLines(file);
    expect(lines.map((line) => `${line.role}:${line.text}`)).toEqual([
      "user:旧形式の発話", "assistant:旧形式の返答", "user:同じ本文", "assistant:別の返答", "user:同じ本文", "assistant:返答です",
    ]);
    expect(readReply(lines, { sentAtMs: 0, text: "同じ本文", clientId: "cli-mine" })).toEqual({ found: true, reply: "返答です" });
    expect(codexRolloutBusy(file)).toBe(true);
    expect(findCodexRollout(THREAD, path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(file))))))).toBe(file);
  });

  test("new --agent codex: Codex で起動し、Bot の許可モードを sandbox と承認の方針にして codex_turn_start で送る", async () => {
    const root = makeTempDir("chat-codex-new");
    const h = harness({
      stdin: "テストを直して", roots: [root],
      handler: (message) => message["type"] === "codex_turn_start"
        ? { type: "codex_turn_start_result", v: 2, id: String(message["id"]), status: "started" } as ControlMessage
        : defaultHandler(message),
    });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-cx", "--agent", "codex", "--json"], h.deps)).toBe(EXIT.ok);
    const start = h.sent.find((m) => m["type"] === "session_start")!;
    expect(start).toMatchObject({ agentType: "codex", codexSandbox: "workspace-write" });
    expect(start).not.toHaveProperty("permissionMode");
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({
      session: start["name"], text: "テストを直して", clientUserMessageId: `cli-${requestDigest("r-cx").slice(0, 24)}`,
      approvalPolicy: "on-request", sandbox: "workspace-write",
    });
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
    expect(h.records.get("r-cx")).toMatchObject({ agent: "codex", state: "sent",
      codexTurn: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
    expect(h.json()).toMatchObject({ agent: "codex", conversationId: "conv-new" });
  });

  test("send は Codex の会話に codex_turn_start で送り、hub の失敗は受領の照会で分ける", async () => {
    const codexList = (id: string) => ({ type: "claude_session_list_response", v: 2, id,
      claudeSessions: [{ sessionId: THREAD, agent: "codex", cwd: "/tmp", title: "Codex", liveSessionName: "s-codex" }] }) as ControlMessage;
    const ok = harness({
      stdin: "続けて",
      handler: (message) => {
        const id = String(message["id"]);
        if (message["type"] === "claude_session_list_request") return codexList(id);
        if (message["type"] === "codex_turn_start") return { type: "codex_turn_start_result", v: 2, id, status: "duplicate" } as ControlMessage;
        return defaultHandler(message);
      },
    });
    expect(await runChat(["send", THREAD, "--request-id", "s-cx", "--json"], ok.deps)).toBe(EXIT.ok);
    expect(ok.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ session: "s-codex", approvalPolicy: "on-request" });
    const failed = harness({
      stdin: "続けて",
      handler: (message) => {
        const id = String(message["id"]);
        if (message["type"] === "claude_session_list_request") return codexList(id);
        if (message["type"] === "codex_turn_start") {
          return { type: "codex_turn_start_result", v: 2, id, status: "failed",
            error: "Previous Codex turn/start outcome is uncertain; explicit retry is required" } as ControlMessage;
        }
        return defaultHandler(message);
      },
    });
    expect(await runChat(["send", THREAD, "--request-id", "s-cx2", "--json"], failed.deps)).toBe(EXIT.policy);
    expect(failed.json()).toMatchObject({ error: { code: "needs_human" } });
  });

  test("status は Codex の rollout で処理中と返答を読み、処理中の設問は hub に聞いて waiting_answer", async () => {
    const store = makeTempStore();
    store.put({ name: "s-codex", cwd: "/tmp", createdAt: 1, agent: "codex", providerSessionId: THREAD });
    const done = rollout([
      event(1_000_100, { type: "task_started" }),
      userItem(1_000_200, "続けて", `cli-${requestDigest("s-cx3").slice(0, 24)}`),
      agentItem(1_000_300, "終わりました"),
      event(1_000_400, { type: "task_complete" }),
    ]);
    const h = harness();
    h.deps.store = () => store;
    h.deps.codexRollout = () => done;
    h.records.set("s-cx3", { requestId: "s-cx3", kind: "send", conversationId: THREAD, session: "s-codex", cwd: "/tmp",
      sentAtMs: 1_000_000, text: "書き換わった本文", state: "sent", agent: "codex" });
    expect(await runChat(["status", THREAD, "--after", "s-cx3", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ agent: "codex", state: "idle", complete: true, received: true, reply: "終わりました" });

    const busy = rollout([event(1_000_100, { type: "task_started" })]);
    const q = harness({
      handler: (message) => message["type"] === "chat_pending_query"
        ? { type: "chat_pending_query_result", v: 2, id: String(message["id"]), session: "s-codex", processing: true,
            question: { id: "codex-question:t:1", questions: [{ header: "h", question: "どれ？", multiSelect: false,
              options: [{ label: "A", description: "" }] }] } } as ControlMessage
        : defaultHandler(message),
    });
    q.deps.store = () => store;
    q.deps.codexRollout = () => busy;
    expect(await runChat(["status", THREAD, "--json"], q.deps)).toBe(EXIT.ok);
    expect(q.json()).toMatchObject({ agent: "codex", state: "waiting_answer",
      waiting: { question: { questionId: "codex-question:t:1" } } });
  });

  test("--agent の誤りは 2", async () => {
    const root = makeTempDir("chat-codex-bad");
    const h = harness({ stdin: "x", roots: [root] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "r-ag", "--agent", "gemini", "--json"], h.deps)).toBe(EXIT.usage);
    expect(h.json()).toMatchObject({ error: { code: "bad_agent" } });
  });
});

test("Codex の new の送信の打ち直し: 記録（rollout）がまだ無くても会話名が動いていれば、その会話名へ送る", async () => {
  const root = makeTempDir("chat-codex-retry");
  const h = harness({
    stdin: "x", roots: [root],
    handler: (message) => {
      const id = String(message["id"]);
      if (message["type"] === "chat_receipt_query") return { type: "chat_receipt_query_result", v: 2, id, status: "unknown" } as ControlMessage;
      if (message["type"] === "codex_turn_start") return { type: "codex_turn_start_result", v: 2, id, status: "started" } as ControlMessage;
      return defaultHandler(message);
    },
  });
  h.deps.codexRollout = () => null;
  const session = `s-cli${requestDigest("r-cxr").slice(0, 16)}`;
  h.records.set("r-cxr", { requestId: "r-cxr", kind: "new", conversationId: "thread-fresh-1", session, cwd: fs.realpathSync(root),
    sentAtMs: 1, text: "x", state: "started", agent: "codex", codexTurn: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
  expect(await runChat(["new", "--cwd", root, "--request-id", "r-cxr", "--agent", "codex", "--json"], h.deps)).toBe(EXIT.ok);
  expect(h.sent.map((m) => m["type"])).toEqual(["chat_receipt_query", "claude_session_list_request", "session_alive_query", "codex_turn_start"]);
  expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ session, approvalPolicy: "on-request" });
});

describe("Fable レビューの再発防止（Codex）", () => {
  const THREAD = "01a1d3d3-c29e-7ac0-801f-3ac8e55bd2c8";
  const codexList = (id: string) => ({ type: "claude_session_list_response", v: 2, id,
    claudeSessions: [{ sessionId: THREAD, agent: "codex", cwd: "/tmp", title: "Codex", liveSessionName: "s-codex" }] }) as ControlMessage;
  const codexHandler: Handler = (message) => {
    const id = String(message["id"]);
    if (message["type"] === "claude_session_list_request") return codexList(id);
    if (message["type"] === "codex_turn_start") return { type: "codex_turn_start_result", v: 2, id, status: "started" } as ControlMessage;
    return defaultHandler(message);
  };

  test("Codex の send は、その会話を始めた new の方針を引き継ぐ（bot.json の既定で緩めない。中2）", async () => {
    const dir = makeTempDir("p-requests");
    fs.writeFileSync(path.join(dir, `${requestDigest("r-orig").slice(0, 32)}.json`), JSON.stringify({
      requestId: "r-orig", kind: "new", conversationId: THREAD, session: "s-codex", cwd: "/tmp", sentAtMs: 1, text: "x",
      state: "sent", agent: "codex", codexTurn: { approvalPolicy: "untrusted", sandbox: "workspace-write", collaborationMode: "default" },
    }));
    const h = harness({ stdin: "続けて", handler: codexHandler });
    h.deps.requestsDir = dir;
    expect(await runChat(["send", THREAD, "--request-id", "s-inh", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ approvalPolicy: "untrusted", collaborationMode: "default" });
  });

  test("Codex の send は --permission-mode でモードを変えられ（プランから戻す）、Claude の send は受け取らない（中2）", async () => {
    const h = harness({ stdin: "実装して", handler: codexHandler });
    h.deps.requestsDir = makeTempDir("p-requests-empty");
    expect(await runChat(["send", THREAD, "--request-id", "s-pm", "--permission-mode", "acceptEdits", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ approvalPolicy: "on-request", collaborationMode: "default" });
    const c = harness({ stdin: "x" });
    expect(await runChat(["send", "conv-live-1", "--request-id", "s-pmc", "--permission-mode", "plan", "--json"], c.deps)).toBe(EXIT.usage);
    expect(c.json()).toMatchObject({ error: { code: "unexpected_permission_mode" } });
  });

  test("返答の照合で、送信 id で見つからないときの本文の照合は、別の送信 id の発話を拾わない（低3）", () => {
    const lines = [
      { role: "user" as const, text: "続けて", atMs: 2_000, clientId: "cli-other" },
      { role: "assistant" as const, text: "別の返答", atMs: 2_100 },
    ];
    expect(readReply(lines, { sentAtMs: 1_000, text: "続けて", clientId: "cli-mine" })).toEqual({ found: false, reply: null });
  });

  test("Codex の status は、会話名が止まっていれば not_running（低1）", async () => {
    const store = makeTempStore();
    store.put({ name: "s-dead", cwd: "/tmp", createdAt: 1, agent: "codex", providerSessionId: THREAD });
    const dir = path.join(makeTempDir("codex-home2"), "sessions", "2026", "11", "15");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-x-${THREAD}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(5).toISOString(), type: "event_msg",
      payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "済" }], phase: "final_answer" } } }));
    const h = harness();
    h.deps.store = () => store;
    h.deps.codexRollout = () => file;
    expect(await runChat(["status", THREAD, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ agent: "codex", state: "not_running" });
  });
});

describe("Fable 確かめの再発防止（Codex）", () => {
  const THREAD = "01a1d3d3-c29e-7ac0-801f-3ac8e55bd2c9";
  const handler: Handler = (message) => {
    const id = String(message["id"]);
    if (message["type"] === "claude_session_list_request") {
      return { type: "claude_session_list_response", v: 2, id,
        claudeSessions: [{ sessionId: THREAD, agent: "codex", cwd: "/tmp", title: "Codex", liveSessionName: "s-codex" }] } as ControlMessage;
    }
    if (message["type"] === "codex_turn_start") return { type: "codex_turn_start_result", v: 2, id, status: "started" } as ControlMessage;
    return defaultHandler(message);
  };
  const record = (requestId: string, kind: "new" | "send", sentAtMs: number, codexTurn: object) => ({
    requestId, kind, conversationId: THREAD, session: "s-codex", cwd: "/tmp", sentAtMs, text: "x", state: "sent", agent: "codex", codexTurn,
  });

  test("send の方針は直近の依頼から引き継ぐ（プランから戻した後にまたプランへ戻らない。低3）", async () => {
    const dir = makeTempDir("p-req-latest");
    const write = (r: { requestId: string }) =>
      fs.writeFileSync(path.join(dir, `${requestDigest(r.requestId).slice(0, 32)}.json`), JSON.stringify(r));
    write(record("r-a", "new", 1, { approvalPolicy: "on-request", sandbox: "workspace-write", collaborationMode: "plan" }));
    write(record("r-b", "send", 2, { approvalPolicy: "on-request", sandbox: "workspace-write", collaborationMode: "default" }));
    const h = harness({ stdin: "続けて", handler });
    h.deps.requestsDir = dir;
    expect(await runChat(["send", THREAD, "--request-id", "r-c", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ collaborationMode: "default" });
  });

  test("引き継いだ方針が auto（never）でも、Bot に allowAuto が無ければ使わない（低4）", async () => {
    const dir = makeTempDir("p-req-auto");
    fs.writeFileSync(path.join(dir, `${requestDigest("r-auto").slice(0, 32)}.json`),
      JSON.stringify(record("r-auto", "new", 1, { approvalPolicy: "never", sandbox: "workspace-write", collaborationMode: "default" })));
    const h = harness({ stdin: "続けて", handler });
    h.deps.requestsDir = dir;
    expect(await runChat(["send", THREAD, "--request-id", "r-d", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ approvalPolicy: "on-request" });
  });
});

test("Codex の最初の送信の打ち直しで thread が失われていたら、新しい依頼 ID での new を案内する（3）", async () => {
  const THREAD = "01a1d3d3-c29e-7ac0-801f-3ac8e55bd2ca";
  const h = harness({
    stdin: "x",
    handler: (message) => {
      const id = String(message["id"]);
      if (message["type"] === "claude_session_list_request") {
        return { type: "claude_session_list_response", v: 2, id,
          claudeSessions: [{ sessionId: THREAD, agent: "codex", cwd: "/tmp", title: "Codex", liveSessionName: "s-codex" }] } as ControlMessage;
      }
      if (message["type"] === "codex_turn_start") {
        return { type: "codex_turn_start_result", v: 2, id, status: "failed",
          error: `CodexTurnNotStartedError: no rollout found for thread id ${THREAD}` } as ControlMessage;
      }
      if (message["type"] === "chat_receipt_query") return { type: "chat_receipt_query_result", v: 2, id, status: "unknown" } as ControlMessage;
      return defaultHandler(message);
    },
  });
  h.deps.requestsDir = makeTempDir("p-req-lost");
  expect(await runChat(["send", THREAD, "--request-id", "s-lost", "--json"], h.deps)).toBe(EXIT.notFound);
  expect(h.json()).toMatchObject({ error: { code: "conversation_ended_before_start" } });
});

describe("モデルの選択", () => {
  const CONV = "conv-model-0001";
  const SESSION = "s-model-1";
  const claudeModels = [{ id: "claude-opus-5-5", displayName: "Opus" }, { id: "claude-haiku-5-5", displayName: "Haiku" }];
  const codexModels = [
    { id: "gpt-a", displayName: "A", description: "", isDefault: true, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
    { id: "gpt-b", displayName: "B", description: "", isDefault: false },
  ];
  const listHandler = (next: Handler = defaultHandler): Handler => (message) => {
    const id = String(message["id"]);
    if (message["type"] === "claude_model_list_request") return { type: "claude_model_list_response", v: 2, id, models: claudeModels } as ControlMessage;
    if (message["type"] === "codex_model_list_request") return { type: "codex_model_list_response", v: 2, id, models: codexModels } as ControlMessage;
    if (message["type"] === "codex_turn_start") return { type: "codex_turn_start_result", v: 2, id, status: "started" } as ControlMessage;
    return next(message);
  };
  const modelHarness = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness({ handler: listHandler(), ...options });
    h.deps.modelCacheDir = makeTempDir("model-cache");
    return h;
  };
  const withConfig = (h: ReturnType<typeof harness>, extra: Record<string, unknown>) => {
    const base = h.deps.config();
    h.deps.config = () => ({ ...base, ...extra });
  };

  test("models は一覧を返し、6 時間は控えを使う（外部 API を連打しない）。--refresh で引き直す", async () => {
    const h = modelHarness();
    expect(await runChat(["models", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ agent: "claude", source: "live", models: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }] });
    const again = modelHarness();
    again.deps.modelCacheDir = h.deps.modelCacheDir!;
    expect(await runChat(["models", "--json"], again.deps)).toBe(EXIT.ok);
    expect(again.json()).toMatchObject({ source: "cache" });
    expect(again.sent).toEqual([]);
    const refreshed = modelHarness();
    refreshed.deps.modelCacheDir = h.deps.modelCacheDir!;
    expect(await runChat(["models", "--refresh", "--json"], refreshed.deps)).toBe(EXIT.ok);
    expect(refreshed.sent.map((m) => m["type"])).toEqual(["claude_model_list_request"]);
  });

  test("models: Codex は工数も返す。allowedModels があれば Bot にはその中だけ。取れなければ 6", async () => {
    const h = modelHarness();
    withConfig(h, { allowedModels: ["gpt-b"] });
    expect(await runChat(["models", "--agent", "codex", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ restricted: true, models: [{ id: "gpt-b" }] });
    const c = modelHarness();
    expect(await runChat(["models", "--agent", "codex", "--json"], c.deps)).toBe(EXIT.ok);
    expect(c.json()).toMatchObject({ models: [{ id: "gpt-a", efforts: ["low", "high"], defaultEffort: "low" }, { id: "gpt-b" }] });
    const down = modelHarness({ handler: (message) => ({ type: "error", v: 2, id: String(message["id"]), code: "x", message: "down" }) as ControlMessage });
    expect(await runChat(["models", "--json"], down.deps)).toBe(EXIT.retryLater);
    expect(down.json()).toMatchObject({ error: { code: "model_list_unavailable" } });
  });

  test("new --model --effort: Claude は起動フラグで渡し、記録と結果に載せる", async () => {
    const root = makeTempDir("model-new");
    const h = modelHarness({ stdin: "x", roots: [root] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-1", "--model", "claude-haiku-5-5", "--effort", "high", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "session_start")).toMatchObject({ model: "claude-haiku-5-5", effort: "high" });
    expect(h.records.get("m-1")).toMatchObject({ model: "claude-haiku-5-5", effort: "high", state: "sent" });
    expect(h.json()).toMatchObject({ model: "claude-haiku-5-5", effort: "high" });
  });

  test("new --agent codex: モデルは codexModel、工数は最初の turn に載せる", async () => {
    const root = makeTempDir("model-new-codex");
    const h = modelHarness({ stdin: "x", roots: [root] });
    expect(await runChat(["new", "--agent", "codex", "--cwd", root, "--request-id", "m-2", "--model", "gpt-a", "--effort", "high", "--json"], h.deps)).toBe(EXIT.ok);
    const start = h.sent.find((m) => m["type"] === "session_start")!;
    expect(start).toMatchObject({ codexModel: "gpt-a" });
    expect(start).not.toHaveProperty("model");
    expect(start).not.toHaveProperty("effort");
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ effort: "high" });
  });

  test.each([
    { label: "文字が不正（[1m]）", agent: "claude", extra: ["--model", "claude-opus-5-5[1m]"], code: EXIT.usage, err: "bad_model" },
    { label: "先頭がハイフン", agent: "claude", extra: ["--model", "-x"], code: EXIT.usage, err: "bad_model" },
    { label: "別名", agent: "claude", extra: ["--model", "opus"], code: EXIT.usage, err: "unknown_model" },
    { label: "Claude の工数の誤り", agent: "claude", extra: ["--effort", "ultra"], code: EXIT.usage, err: "bad_effort" },
    { label: "Codex のそのモデルで使えない工数", agent: "codex", extra: ["--model", "gpt-a", "--effort", "max"], code: EXIT.usage, err: "bad_effort" },
    { label: "Codex の工数の欄が無いモデル", agent: "codex", extra: ["--model", "gpt-b", "--effort", "low"], code: EXIT.usage, err: "bad_effort" },
  ])("送る前に断る（起動しない）: $label", async ({ agent, extra, code, err }) => {
    const root = makeTempDir("model-bad");
    const h = modelHarness({ stdin: "x", roots: [root] });
    expect(await runChat(["new", "--agent", agent, "--cwd", root, "--request-id", "m-bad", ...extra, "--json"], h.deps)).toBe(code);
    expect(h.json()).toMatchObject({ error: { code: err } });
    expect(h.sent.some((m) => m["type"] === "session_start")).toBe(false);
  });

  test("allowedModels: 外は 5、中は一覧を見ずに通す（一覧に無い古い ID も書けば使える）", async () => {
    const root = makeTempDir("model-allowed");
    const h = modelHarness({ stdin: "x", roots: [root] });
    withConfig(h, { allowedModels: ["claude-old-1"] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-a1", "--model", "claude-opus-5-5", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "model_not_allowed" } });
    const ok = modelHarness({ stdin: "x", roots: [root] });
    withConfig(ok, { allowedModels: ["claude-old-1"] });
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-a2", "--model", "claude-old-1", "--json"], ok.deps)).toBe(EXIT.ok);
    expect(ok.sent.some((m) => m["type"] === "claude_model_list_request")).toBe(false);
  });

  test("一覧が取れないとき: Claude は文字の検査だけで通して modelValidated: false、Codex は 6", async () => {
    const root = makeTempDir("model-nolist");
    const failing = (message: Record<string, unknown>): ControlMessage => String(message["type"]).endsWith("_model_list_request")
      ? { type: "error", v: 2, id: String(message["id"]), code: "x", message: "down" } as ControlMessage : listHandler()(message);
    const h = modelHarness({ stdin: "x", roots: [root], handler: failing });
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-n1", "--model", "claude-new-9", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ model: "claude-new-9", modelValidated: false });
    const c = modelHarness({ stdin: "x", roots: [root], handler: failing });
    expect(await runChat(["new", "--agent", "codex", "--cwd", root, "--request-id", "m-n2", "--model", "gpt-a", "--json"], c.deps)).toBe(EXIT.retryLater);
    expect(c.json()).toMatchObject({ error: { code: "model_list_unavailable" } });
  });

  test("同じ依頼 ID でモデルが違えば使い回しとして断る", async () => {
    const root = makeTempDir("model-reuse");
    const h = modelHarness({ stdin: "x", roots: [root] });
    await runChat(["new", "--cwd", root, "--request-id", "m-r", "--model", "claude-opus-5-5", "--json"], h.deps);
    const again = modelHarness({ stdin: "x", roots: [root] });
    again.records.set("m-r", h.records.get("m-r")!);
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-r", "--model", "claude-haiku-5-5", "--json"], again.deps)).toBe(EXIT.usage);
    expect(again.json()).toMatchObject({ error: { code: "request_id_reused" } });
  });

  test("send は --model を受け取らず set-model を案内する", async () => {
    const h = modelHarness({ stdin: "x" });
    expect(await runChat(["send", "conv-live-1", "--request-id", "m-s", "--model", "claude-opus-5-5", "--json"], h.deps)).toBe(EXIT.usage);
    expect(h.json()).toMatchObject({ error: { code: "use_set_model" } });
    expect(h.sent).toEqual([]);
  });

  test("status は直近の返答のモデルを返す（<synthetic> は除く）", async () => {
    const file = path.join(makeTempDir("model-status"), "c.jsonl");
    fs.writeFileSync(file, [
      { type: "assistant", timestamp: new Date(1).toISOString(), message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "a" }] } },
      { type: "assistant", timestamp: new Date(2).toISOString(), message: { model: "<synthetic>", content: [{ type: "text", text: "b" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    const h = modelHarness({ state: () => "idle", transcript: () => ({ file, cwd: "/w" }) });
    expect(await runChat(["status", CONV, "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ model: "claude-haiku-5-5" });
  });

  const commandLines = (model: string, atMs: number, stdout: string | null) => [
    { type: "user", timestamp: new Date(atMs).toISOString(), message: { role: "user",
      content: `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>${model}</command-args>` } },
    ...(stdout !== null ? [{ type: "user", timestamp: new Date(atMs).toISOString(), message: { role: "user",
      content: `<local-command-stdout>${stdout}</local-command-stdout>` } }] : []),
  ];
  const setModelHarness = (lines: object[], options: { state?: ChatDeps["state"]; list?: object } = {}) => {
    const file = path.join(makeTempDir("set-model"), "c.jsonl");
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const h = modelHarness({
      state: options.state ?? (() => "idle"), transcript: () => ({ file, cwd: "/tmp" }),
      handler: listHandler((message) => {
        const id = String(message["id"]);
        if (message["type"] === "claude_session_list_request") {
          return { type: "claude_session_list_response", v: 2, id,
            claudeSessions: [{ sessionId: CONV, cwd: "/tmp", title: "t", liveSessionName: SESSION, ...(options.list ?? {}) }] } as ControlMessage;
        }
        return defaultHandler(message);
      }),
    });
    withConfig(h, { allowSetModel: true });
    return { h, file };
  };
  const OK = "Set model to `Haiku 5.5` and saved as your default for new sessions";

  test("set-model: /model を送り、会話の記録で効いたことを確かめて返す", async () => {
    const { h } = setModelHarness(commandLines("claude-haiku-5-5", 1_000_100, OK));
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-1", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "chat_send")).toMatchObject({ session: SESSION, text: "/model claude-haiku-5-5" });
    expect(h.json()).toMatchObject({ applied: true, model: "claude-haiku-5-5", savedAsDefault: true, detail: OK });
    expect(h.records.get("sm-1")).toMatchObject({ kind: "set-model", model: "claude-haiku-5-5", state: "sent" });
  });

  test("set-model: Bot は allowSetModel が無ければ断る（既定は不可）", async () => {
    const { h } = setModelHarness([]);
    withConfig(h, { allowSetModel: false });
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-2", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "set_model_not_allowed" } });
    expect(h.sent).toEqual([]);
  });

  test.each(["busy", "waiting"] as const)("set-model: 会話が %s の間は送らずに 6", async (state) => {
    const { h } = setModelHarness([], { state: () => state });
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-3", "--json"], h.deps)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "conversation_busy" } });
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
  });

  test("set-model: API 作業の会話は断る", async () => {
    const { h } = setModelHarness([], { list: { executionRoute: "api" } });
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-4", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "unsupported_route" } });
  });

  test("set-model: 記録に結果が出なければ 7。打ち直しは送り直さず確かめだけをやり直す", async () => {
    const { h, file } = setModelHarness([]);
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-5", "--json"], h.deps)).toBe(EXIT.timeout);
    expect(h.json()).toMatchObject({ error: { code: "model_change_unconfirmed" } });
    expect(h.records.get("sm-5")?.state).toBe("sent");
    fs.writeFileSync(file, commandLines("claude-haiku-5-5", 1_000_100, OK).map((line) => JSON.stringify(line)).join("\n"));
    const retry = setModelHarness([]).h;
    retry.deps.transcript = () => ({ file, cwd: "/tmp" });
    retry.records.set("sm-5", h.records.get("sm-5")!);
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-5", "--json"], retry.deps)).toBe(EXIT.ok);
    expect(retry.sent.some((m) => m["type"] === "chat_send")).toBe(false);
  });

  test("set-model: 結果が成功の文言でなければ確定した失敗（5）で、打ち直しを促さない", async () => {
    const { h } = setModelHarness(commandLines("claude-haiku-5-5", 1_000_100, "Kept model as `Opus 5.5`"));
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-f", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "model_change_failed" }, detail: "Kept model as `Opus 5.5`" });
  });

  test("set-model: ターンの途中に実行された /model の記録（system / local_command の行）も読む", async () => {
    const at = new Date(1_000_100).toISOString();
    const { h } = setModelHarness([
      { type: "system", subtype: "local_command", timestamp: at,
        content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-haiku-5-5</command-args>" },
      { type: "system", subtype: "local_command", timestamp: at, content: `<local-command-stdout>${OK}</local-command-stdout>` },
    ]);
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-s", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ applied: true, savedAsDefault: true });
  });

  test("結果の照合: 次のコマンドの出力は自分の結果にしない。後に別のモデルへ変えられたら superseded", () => {
    const file = path.join(makeTempDir("model-result"), "c.jsonl");
    const write = (lines: object[]) => fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const other = { type: "user", timestamp: new Date(1_000_200).toISOString(), message: { role: "user", content: "<command-name>/cost</command-name>" } };
    const otherOut = { type: "user", timestamp: new Date(1_000_200).toISOString(), message: { role: "user", content: "<local-command-stdout>Set model to `x`</local-command-stdout>" } };
    write([...commandLines("claude-haiku-5-5", 1_000_100, null), other, otherOut]);
    expect(findModelCommandResult(file, 1_000_000, "claude-haiku-5-5")).toEqual({ detail: null, superseded: false });
    write([...commandLines("claude-haiku-5-5", 1_000_100, OK), ...commandLines("claude-opus-5-5", 1_000_300, "Set model to `Opus 5.5`")]);
    expect(findModelCommandResult(file, 1_000_000, "claude-haiku-5-5")).toEqual({ detail: OK, superseded: true });
    expect(findModelCommandResult(file, 1_000_200, "claude-haiku-5-5")).toBeNull();
  });

  test("set-model: 送信が未確定の打ち直しでも、会話が処理中なら送らずに 6（記録は started のまま）", async () => {
    const { h } = setModelHarness([], { state: () => "busy" });
    h.records.set("sm-b", { requestId: "sm-b", kind: "set-model", conversationId: CONV, session: SESSION, cwd: "/tmp",
      sentAtMs: 1_000_000, text: "/model claude-haiku-5-5", model: "claude-haiku-5-5", state: "started" });
    const base = h.deps.connect;
    h.deps.connect = async () => {
      const engine = await base();
      return { ...engine, request: async (message, match, timeout) => message["type"] === "chat_receipt_query"
        ? { type: "chat_receipt_query_result", v: 2, id: String(message["id"]), status: "unknown" } as ControlMessage
        : engine.request(message, match, timeout) };
    };
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-b", "--json"], h.deps)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "conversation_busy" } });
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
    expect(h.records.get("sm-b")?.state).toBe("started");
  });

  test("set-model: 届いたか分からない失敗の案内に status --after を出さない", async () => {
    const { h } = setModelHarness([]);
    const base = h.deps.connect;
    h.deps.connect = async () => {
      const engine = await base();
      return { ...engine, request: async (message, match, timeout) => message["type"] === "chat_send"
        ? { type: "error", v: 2, id: String(message["id"]), code: "chat_send_failed", message: "hub timeout" } as ControlMessage
        : engine.request(message, match, timeout) };
    };
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-h", "--json"], h.deps)).toBe(EXIT.timeout);
    expect((h.json() as { error: { hint: string } }).error.hint).not.toContain("--after");
  });

  test("allowedModels: Codex は中にあっても一覧と照らす。配列でない書き間違いは何も許さない", async () => {
    const root = makeTempDir("model-allowed-codex");
    const h = modelHarness({ stdin: "x", roots: [root] });
    withConfig(h, { allowedModels: ["claude-opus-5-5"] });
    expect(await runChat(["new", "--agent", "codex", "--cwd", root, "--request-id", "m-c1", "--model", "claude-opus-5-5", "--json"], h.deps)).toBe(EXIT.usage);
    expect(h.json()).toMatchObject({ error: { code: "unknown_model" } });
    const file = path.join(makeTempDir("bot-models"), "bot.json");
    fs.writeFileSync(file, JSON.stringify({ allowedModels: "claude-opus-5-5" }));
    expect(loadBotConfig(file).allowedModels).toEqual([]);
  });

  test("控え: 無いモデルは 1 回だけ取り直す。古い控えしか無いときは確かめられなかったと返す。壊れた・未来の控えは使わない", async () => {
    const root = makeTempDir("model-cache-cases");
    const writeCache = (dir: string, fetchedAtMs: number, models: unknown[]) =>
      fs.writeFileSync(path.join(dir, "models-claude.json"), JSON.stringify({ fetchedAtMs, models }));
    const miss = modelHarness({ stdin: "x", roots: [root] });
    writeCache(miss.deps.modelCacheDir!, 1_000_000, [{ id: "claude-opus-5-5", displayName: "Opus" }]);
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-k1", "--model", "claude-haiku-5-5", "--json"], miss.deps)).toBe(EXIT.ok);
    expect(miss.sent.filter((m) => m["type"] === "claude_model_list_request")).toHaveLength(1);

    const down = (message: Record<string, unknown>): ControlMessage => message["type"] === "claude_model_list_request"
      ? { type: "error", v: 2, id: String(message["id"]), code: "x", message: "down" } as ControlMessage : listHandler()(message);
    const stale = modelHarness({ stdin: "x", roots: [root], handler: down });
    writeCache(stale.deps.modelCacheDir!, 1, [{ id: "claude-opus-5-5", displayName: "Opus" }]);
    expect(await runChat(["new", "--cwd", root, "--request-id", "m-k2", "--model", "claude-new-9", "--json"], stale.deps)).toBe(EXIT.ok);
    expect(stale.json()).toMatchObject({ model: "claude-new-9", modelValidated: false });

    for (const [fetchedAtMs, models] of [[1_000_000, [null]], [9_000_000_000, [{ id: "claude-opus-5-5", displayName: "Opus" }]]] as const) {
      const h = modelHarness();
      writeCache(h.deps.modelCacheDir!, fetchedAtMs, [...models]);
      expect(await runChat(["models", "--json"], h.deps)).toBe(EXIT.ok);
      expect(h.json()).toMatchObject({ source: "live" });
    }
  });

  test("set-model: 送信が未確定の打ち直しは、コマンドの行があれば届いた扱いで送り直さない", async () => {
    const { h } = setModelHarness(commandLines("claude-haiku-5-5", 1_000_100, OK));
    h.records.set("sm-6", { requestId: "sm-6", kind: "set-model", conversationId: CONV, session: "s-dead", cwd: "/tmp",
      sentAtMs: 1_000_000, text: "/model claude-haiku-5-5", model: "claude-haiku-5-5", state: "started" });
    const base = h.deps.connect;
    h.deps.connect = async () => {
      const engine = await base();
      return { ...engine, request: async (message, match, timeout) => message["type"] === "chat_receipt_query"
        ? { type: "chat_receipt_query_result", v: 2, id: String(message["id"]), status: "unknown" } as ControlMessage
        : engine.request(message, match, timeout) };
    };
    expect(await runChat(["set-model", CONV, "--model", "claude-haiku-5-5", "--request-id", "sm-6", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.some((m) => m["type"] === "chat_send")).toBe(false);
    expect(h.records.get("sm-6")?.state).toBe("sent");
  });

  test("set-model: Codex の会話は未対応。status --after に set-model の依頼は使えない", async () => {
    const store = makeTempStore();
    store.put({ name: "s-cx", cwd: "/tmp", createdAt: 1, agent: "codex", providerSessionId: CONV });
    const { h } = setModelHarness([]);
    h.deps.store = () => store;
    expect(await runChat(["set-model", CONV, "--model", "gpt-a", "--request-id", "sm-7", "--json"], h.deps)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "unsupported_agent" } });
    const s = setModelHarness([]).h;
    s.records.set("sm-8", { requestId: "sm-8", kind: "set-model", conversationId: CONV, session: SESSION, cwd: "/tmp", sentAtMs: 1, text: "/model x", state: "sent" });
    expect(await runChat(["status", CONV, "--after", "sm-8", "--json"], s.deps)).toBe(EXIT.usage);
    expect(s.json()).toMatchObject({ error: { code: "request_has_no_reply" } });
  });
});

describe("chat models の既定の印", () => {
  const claudeModels = [
    { id: "claude-opus-5-5", displayName: "Opus" }, { id: "claude-haiku-5-5", displayName: "Haiku", isDefault: true },
  ];
  const codexModels = [
    { id: "gpt-a", displayName: "A", description: "", isDefault: true, supportedReasoningEfforts: ["low"] },
    { id: "gpt-b", displayName: "B", description: "", isDefault: false, supportedReasoningEfforts: ["low", "high"] },
  ];
  const listHandler: Handler = (message) => {
    const id = String(message["id"]);
    if (message["type"] === "claude_model_list_request") return { type: "claude_model_list_response", v: 2, id, models: claudeModels } as ControlMessage;
    if (message["type"] === "codex_model_list_request") return { type: "codex_model_list_response", v: 2, id, models: codexModels } as ControlMessage;
    if (message["type"] === "codex_turn_start") return { type: "codex_turn_start_result", v: 2, id, status: "started" } as ControlMessage;
    return defaultHandler(message);
  };
  const setup = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness({ handler: listHandler, ...options });
    const home = makeTempDir("models-home");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".codex"));
    h.deps.modelCacheDir = makeTempDir("models-cache");
    h.deps.defaultModelContext = { home, env: {}, claudeManagedDir: path.join(home, "managed"), codexHome: path.join(home, ".codex"),
      codexManagedConfig: path.join(home, "none.toml") };
    return { h, home };
  };
  const rows = (h: ReturnType<typeof harness>) => (h.json() as { models: Array<{ id: string; isDefault?: boolean }> }).models;

  test("engine の印は使わず、設定の既定の 1 行だけに印を付ける。控えには印を書かない", async () => {
    const { h, home } = setup();
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus-5-5" }));
    expect(await runChat(["models", "--json"], h.deps)).toBe(EXIT.ok);
    expect(rows(h)).toEqual([{ id: "claude-opus-5-5", displayName: "Opus", isDefault: true }, { id: "claude-haiku-5-5", displayName: "Haiku" }]);
    const cache = JSON.parse(fs.readFileSync(path.join(h.deps.modelCacheDir!, "models-claude.json"), "utf8")) as { models: object[] };
    expect(JSON.stringify(cache.models)).not.toContain("isDefault");
  });

  test("決められなければどの行にも印を付けない。古い控えの印も持ち越さない", async () => {
    const { h } = setup();
    fs.writeFileSync(path.join(h.deps.modelCacheDir!, "models-claude.json"), JSON.stringify({ fetchedAtMs: 1_000_000, models: claudeModels }));
    expect(await runChat(["models", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ source: "cache" });
    expect(rows(h).some((row) => row.isDefault === true)).toBe(false);
  });

  test("--cwd のフォルダの設定で印が変わる。許可外・無いフォルダは 2", async () => {
    const root = makeTempDir("models-cwd");
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ model: "claude-haiku-5-5" }));
    const { h, home } = setup({ roots: [root] });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus-5-5" }));
    expect(await runChat(["models", "--cwd", root, "--json"], h.deps)).toBe(EXIT.ok);
    expect(rows(h).find((row) => row.isDefault === true)?.id).toBe("claude-haiku-5-5");
    const bad = setup({ roots: [root] }).h;
    expect(await runChat(["models", "--cwd", path.join(root, "nope"), "--json"], bad.deps)).toBe(EXIT.usage);
    expect(bad.json()).toMatchObject({ error: { code: "folder_not_allowed" } });
  });

  test("allowedModels で既定の行が消えれば印も出ない", async () => {
    const { h, home } = setup();
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus-5-5" }));
    const base = h.deps.config();
    h.deps.config = () => ({ ...base, allowedModels: ["claude-haiku-5-5"] });
    expect(await runChat(["models", "--json"], h.deps)).toBe(EXIT.ok);
    expect(rows(h)).toEqual([{ id: "claude-haiku-5-5", displayName: "Haiku" }]);
  });

  test("Codex の --effort だけ: 設定の既定のモデルの工数で確かめ、決められなければ 2", async () => {
    const root = makeTempDir("models-effort");
    const { h, home } = setup({ stdin: "x", roots: [root] });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-b"\n');
    expect(await runChat(["new", "--agent", "codex", "--cwd", root, "--request-id", "de-1", "--effort", "high", "--json"], h.deps)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "codex_turn_start")).toMatchObject({ effort: "high" });
    const unknown = setup({ stdin: "x", roots: [root] }).h;
    expect(await runChat(["new", "--agent", "codex", "--cwd", root, "--request-id", "de-2", "--effort", "low", "--json"], unknown.deps)).toBe(EXIT.usage);
    expect(unknown.json()).toMatchObject({ error: { code: "effort_needs_model" } });
    expect(unknown.sent.some((m) => m["type"] === "session_start")).toBe(false);
  });
});

describe("chat set-mode", () => {
  const CONV = "conv-mode-0001";
  const SESSION = "s-mode-1";
  type ModeReply = string | { error: string } | "timeout";
  /** `gets` / `sets` は mode_get / mode_set の応答を順に返す。 */
  const modeHarness = (options: { gets?: ModeReply[]; sets?: ModeReply[]; state?: ChatDeps["state"]; list?: object; allowAuto?: boolean } = {}) => {
    const gets = [...(options.gets ?? ["acceptEdits"])];
    const sets = [...(options.sets ?? ["auto"])];
    const answer = (id: string, reply: ModeReply): ControlMessage => {
      if (reply === "timeout") throw new EngineTimeoutError("mode");
      if (typeof reply !== "string") return { type: "error", v: 2, id, code: reply.error, message: reply.error } as ControlMessage;
      return { type: "mode_set_response", v: 2, id, mode: reply } as ControlMessage;
    };
    const h = harness({
      state: options.state ?? (() => "idle"), allowAuto: options.allowAuto ?? true,
      handler: (message) => {
        const id = String(message["id"]);
        if (message["type"] === "claude_session_list_request") {
          return { type: "claude_session_list_response", v: 2, id,
            claudeSessions: [{ sessionId: CONV, cwd: "/tmp", title: "t", liveSessionName: SESSION, ...(options.list ?? {}) }] } as ControlMessage;
        }
        if (message["type"] === "mode_get") return answer(id, gets.shift() ?? "acceptEdits");
        if (message["type"] === "mode_set") return answer(id, sets.shift() ?? "auto");
        if (message["type"] === "session_start") {
          return { type: "session_list_response", v: 2, id, adoptedName: String(message["name"]),
            sessions: [{ name: String(message["name"]), cwd: "/tmp", alive: true, providerSessionId: CONV }] } as ControlMessage;
        }
        return defaultHandler(message);
      },
    });
    h.deps.botStarted = (id) => id === CONV;
    h.deps.approvalsBase = makeTempDir("mode-approvals");
    return h;
  };
  const run = (h: ReturnType<typeof harness>, mode = "auto", id = "sm-1") =>
    runChat(["set-mode", CONV, "--permission-mode", mode, "--request-id", id, "--json"], h.deps);
  const types = (h: ReturnType<typeof harness>) => h.sent.map((m) => m["type"]);

  test("今のモードを読んでから変え、応答のモードで確かめて記録する", async () => {
    const h = modeHarness();
    expect(await run(h)).toBe(EXIT.ok);
    expect(h.sent.find((m) => m["type"] === "mode_set")).toMatchObject({ session: SESSION, mode: "auto" });
    expect(h.json()).toMatchObject({ permissionMode: "auto", previousMode: "acceptEdits", changed: true, session: SESSION });
    expect(h.records.get("sm-1")).toMatchObject({ kind: "set-mode", mode: "auto", state: "sent" });
  });

  test("既に同じモードならキーを打たない", async () => {
    const h = modeHarness({ gets: ["auto"] });
    expect(await run(h)).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ changed: false, previousMode: "auto" });
    expect(types(h)).not.toContain("mode_set");
  });

  test.each([
    { label: "--permission-mode が無い", args: [] as string[], code: EXIT.usage, err: "missing_permission_mode" },
    { label: "知らないモード", args: ["--permission-mode", "yolo"], code: EXIT.usage, err: "bad_permission_mode" },
  ])("engine を開く前に断る: $label", async ({ args, code, err }) => {
    const h = modeHarness();
    expect(await runChat(["set-mode", CONV, ...args, "--request-id", "sm-u", "--json"], h.deps)).toBe(code);
    expect(h.json()).toMatchObject({ error: { code: err } });
    expect(h.sent).toEqual([]);
  });

  test("auto は allowAuto が要る。Bot が始めていない会話は変えられない", async () => {
    const noAuto = modeHarness({ allowAuto: false });
    expect(await run(noAuto)).toBe(EXIT.policy);
    expect(noAuto.json()).toMatchObject({ error: { code: "auto_not_allowed" } });
    const other = modeHarness();
    other.deps.botStarted = () => false;
    expect(await run(other)).toBe(EXIT.policy);
    expect(other.json()).toMatchObject({ error: { code: "set_mode_not_allowed" } });
    expect(other.sent).toEqual([]);
  });

  test.each([
    { label: "Codex", list: { agent: "codex" }, code: EXIT.policy, err: "unsupported_agent" },
    { label: "API 作業", list: { executionRoute: "api" }, code: EXIT.policy, err: "unsupported_route" },
  ])("対象外の会話は断る: $label", async ({ list, code, err }) => {
    const h = modeHarness({ list });
    expect(await run(h)).toBe(code);
    expect(h.json()).toMatchObject({ error: { code: err } });
    expect(types(h)).not.toContain("mode_set");
  });

  test("見つからない会話は 3、許可外のフォルダは 5", async () => {
    const missing = modeHarness({ list: { sessionId: "conv-other-1" } });
    expect(await run(missing)).toBe(EXIT.notFound);
    const outside = modeHarness();
    const base = outside.deps.config();
    outside.deps.config = () => ({ ...base, allowedRoots: [makeTempDir("mode-root")] });
    expect(await run(outside)).toBe(EXIT.policy);
    expect(outside.json()).toMatchObject({ error: { code: "folder_not_allowed" } });
  });

  test.each(["busy", "waiting"] as const)("会話が %s の間はキーを打たずに 6", async (state) => {
    const h = modeHarness({ state: () => state });
    expect(await run(h)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "conversation_busy" } });
    expect(types(h)).not.toContain("mode_get");
  });

  test("承認待ちの間もキーを打たない", async () => {
    const h = modeHarness();
    const store = makeTempStore();
    store.put({ name: SESSION, cwd: "/tmp", createdAt: 1, backend: "herdr", claudeSessionId: CONV, providerSessionId: CONV });
    h.deps.store = () => store;
    writePendingApproval({ id: "ap-m", session: SESSION, tool: "Bash", summary: "x", cwd: "/tmp", atMs: 1, pid: process.pid }, h.deps.approvalsBase!);
    expect(await run(h)).toBe(EXIT.retryLater);
    expect(types(h)).not.toContain("mode_set");
  });

  test("止まっている会話は続きから起動してから変える", async () => {
    const h = modeHarness({ list: { liveSessionName: undefined } });
    expect(await run(h)).toBe(EXIT.ok);
    const start = h.sent.find((m) => m["type"] === "session_start")!;
    expect(start).toMatchObject({ resumeSessionId: CONV, peerCheck: true });
    expect(h.sent.find((m) => m["type"] === "mode_set")).toMatchObject({ session: start["name"] });
  });

  test("今のモードを読めなければキーを打たずに 6", async () => {
    const h = modeHarness({ gets: [{ error: "mode_unavailable" }] });
    expect(await run(h)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "mode_unavailable" } });
    expect(types(h)).not.toContain("mode_set");
    expect(h.records.get("sm-1")?.state).toBe("started");
  });

  test("目的のモードへ届かなければ元のモードへ戻して 5", async () => {
    const h = modeHarness({ sets: ["plan", "acceptEdits"] });
    expect(await run(h)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "mode_change_failed" }, mode: "acceptEdits" });
    expect(h.sent.filter((m) => m["type"] === "mode_set").map((m) => m["mode"])).toEqual(["auto", "acceptEdits"]);
    expect(h.records.get("sm-1")?.state).toBe("started");
  });

  test.each([
    { label: "別のモードで止まった", sets: ["plan", "default"] as ModeReply[], mode: "default" },
    { label: "戻す要求が失敗した", sets: ["plan", { error: "mode_unavailable" }] as ModeReply[], mode: "plan" },
  ])("元のモードへ戻せなければ人に回す: $label", async ({ sets, mode }) => {
    const h = modeHarness({ sets });
    expect(await run(h)).toBe(EXIT.policy);
    expect(h.json()).toMatchObject({ error: { code: "mode_change_blocked" }, mode });
  });

  test.each([
    { reply: { error: "mode_set_busy" } as ModeReply, code: EXIT.retryLater, err: "mode_set_busy" },
    { reply: { error: "mode_unavailable" } as ModeReply, code: EXIT.retryLater, err: "mode_unavailable" },
  ])("キーを打つ前に断られたら確かめずに 6: $err", async ({ reply, code, err }) => {
    const h = modeHarness({ sets: [reply] });
    expect(await run(h)).toBe(code);
    expect(h.json()).toMatchObject({ error: { code: err } });
    expect(types(h).filter((type) => type === "mode_get")).toHaveLength(1);
    expect(h.records.get("sm-1")?.state).toBe("started");
  });

  describe.each([
    { label: "mode_set_failed", reply: { error: "mode_set_failed" } as ModeReply, err: "mode_set_failed" },
    { label: "時間切れ", reply: "timeout" as ModeReply, err: "timeout" },
  ])("変更が途中で失敗した: $label", ({ reply, err }) => {
    test("元のモードのままなら 6 で打ち直せる", async () => {
      const h = modeHarness({ sets: [reply] });
      expect(await run(h)).toBe(EXIT.retryLater);
      expect(h.json()).toMatchObject({ error: { code: "mode_change_incomplete" }, mode: "acceptEdits" });
      expect(h.records.get("sm-1")?.state).toBe("started");
    });

    test("目的のモードに届いていれば成功として記録する", async () => {
      const h = modeHarness({ gets: ["acceptEdits", "auto"], sets: [reply] });
      expect(await run(h)).toBe(EXIT.ok);
      expect(h.json()).toMatchObject({ permissionMode: "auto", changed: true });
      expect(h.records.get("sm-1")?.state).toBe("sent");
    });

    test("途中のモードに残っていれば元へ戻す", async () => {
      const h = modeHarness({ gets: ["plan", "auto"], sets: [reply, "plan"] });
      expect(await run(h, "default")).toBe(EXIT.retryLater);
      expect(h.json()).toMatchObject({ error: { code: "mode_change_incomplete" }, mode: "plan" });
      expect(h.sent.filter((m) => m["type"] === "mode_set").map((m) => m["mode"])).toEqual(["default", "plan"]);
    });

    test("許していない auto に残って戻せなければ、今のモードを載せて人に回す", async () => {
      const h = modeHarness({ allowAuto: false, gets: ["plan", "auto"], sets: [reply, { error: "mode_unavailable" }] });
      expect(await run(h, "default")).toBe(EXIT.policy);
      expect(h.json()).toMatchObject({ error: { code: "mode_change_blocked" }, mode: "auto" });
    });

    test("今のモードを読めなければ 7", async () => {
      const h = modeHarness({ gets: ["acceptEdits", "timeout"], sets: [reply] });
      expect(await run(h)).toBe(EXIT.timeout);
      expect(h.json()).toMatchObject({ error: { code: err } });
      expect(h.records.get("sm-1")?.state).toBe("started");
    });
  });

  test("auto 以外で別のモードに止まったら、元へ戻して 6（読み損ね）", async () => {
    const h = modeHarness({ gets: ["default"], sets: ["acceptEdits", "default"] });
    expect(await run(h, "plan")).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "mode_change_incomplete" }, mode: "default" });
    expect(h.sent.filter((m) => m["type"] === "mode_set").map((m) => m["mode"])).toEqual(["plan", "default"]);
  });

  test("一度も動かなかったら戻す要求を出さずに 6", async () => {
    const h = modeHarness({ gets: ["default"], sets: ["default"] });
    expect(await run(h, "plan")).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "mode_change_incomplete" } });
    expect(types(h).filter((type) => type === "mode_set")).toHaveLength(1);
  });

  test("起動した会話は、今のモードを読めるまで待つ", async () => {
    const h = modeHarness({ list: { liveSessionName: undefined }, gets: [{ error: "mode_unavailable" }, "timeout", "acceptEdits"] });
    expect(await run(h)).toBe(EXIT.ok);
    expect(types(h).filter((type) => type === "mode_get")).toHaveLength(3);
    expect(h.json()).toMatchObject({ permissionMode: "auto", changed: true });
  });

  test("起動した会話でも、読めないまま待ち切ればキーを打たずに 6", async () => {
    const h = modeHarness({ list: { liveSessionName: undefined }, gets: Array<ModeReply>(12).fill({ error: "mode_unavailable" }) });
    expect(await run(h)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "mode_unavailable" } });
    expect(types(h).filter((type) => type === "mode_get")).toHaveLength(12);
    expect(types(h)).not.toContain("mode_set");
  });

  test("一覧に出ていなくても、起動の後に処理中と分かればキーを打たない", async () => {
    const h = modeHarness({ list: { liveSessionName: undefined }, state: () => "busy" });
    expect(await run(h)).toBe(EXIT.retryLater);
    expect(h.json()).toMatchObject({ error: { code: "conversation_busy" } });
    expect(types(h)).not.toContain("mode_get");
  });

  test("started の打ち直しは、まだ変わっていなければ実際に変える", async () => {
    const h = modeHarness({ gets: ["acceptEdits"], sets: ["auto"] });
    h.records.set("sm-s", { requestId: "sm-s", kind: "set-mode", conversationId: CONV, session: SESSION, cwd: "/tmp", sentAtMs: 5, text: "", mode: "auto", state: "started" });
    expect(await run(h, "auto", "sm-s")).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ changed: true });
    expect(h.records.get("sm-s")).toMatchObject({ state: "sent", sentAtMs: 5 });
  });

  test("時間切れの打ち直しは今のモードから確かめ直し、最初の時刻を変えない", async () => {
    const h = modeHarness({ gets: ["auto"] });
    h.records.set("sm-r", { requestId: "sm-r", kind: "set-mode", conversationId: CONV, session: SESSION, cwd: "/tmp", sentAtMs: 5, text: "", mode: "auto", state: "started" });
    expect(await run(h, "auto", "sm-r")).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ changed: false });
    expect(h.records.get("sm-r")).toMatchObject({ state: "sent", sentAtMs: 5 });
  });

  test("済んだ依頼の打ち直しは engine を開かず、後の変更を巻き戻さない", async () => {
    const h = modeHarness();
    h.records.set("sm-d", { requestId: "sm-d", kind: "set-mode", conversationId: CONV, session: SESSION, cwd: "/tmp", sentAtMs: 1, text: "", mode: "auto", state: "sent" });
    expect(await run(h, "auto", "sm-d")).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ duplicate: true, permissionMode: "auto" });
    expect(h.sent).toEqual([]);
  });

  test("依頼 ID の使い回し（モード違い・会話違い）は 2。status --after には使えない", async () => {
    const h = modeHarness();
    h.records.set("sm-x", { requestId: "sm-x", kind: "set-mode", conversationId: CONV, session: SESSION, cwd: "/tmp", sentAtMs: 1, text: "", mode: "plan", state: "sent" });
    expect(await run(h, "auto", "sm-x")).toBe(EXIT.usage);
    expect(h.json()).toMatchObject({ error: { code: "request_id_reused" } });
    const other = modeHarness();
    other.records.set("sm-y", { requestId: "sm-y", kind: "set-mode", conversationId: "conv-other-2", session: SESSION, cwd: "/tmp", sentAtMs: 1, text: "", mode: "auto", state: "sent" });
    expect(await run(other, "auto", "sm-y")).toBe(EXIT.usage);
    const status = modeHarness();
    status.records.set("sm-z", { requestId: "sm-z", kind: "set-mode", conversationId: CONV, session: SESSION, cwd: "/tmp", sentAtMs: 1, text: "", mode: "auto", state: "sent" });
    expect(await runChat(["status", CONV, "--after", "sm-z", "--json"], status.deps)).toBe(EXIT.usage);
    expect(status.json()).toMatchObject({ error: { code: "request_has_no_reply" } });
  });
});
