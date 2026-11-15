// chatCommand.test.ts — `tailii-host chat`（tailii-chat-cli）: Bot 向けの会話の開始・送信・状態

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT, runChat, type ChatDeps } from "../src/commands/chat/chatCommand.js";
import {
  acquireRequestLock,
  codexRolloutBusy,
  findCodexRollout,
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

test("明示した herdr セッションが動いていない起動失敗は、打ち直しを促さずに 5（第 2 段）", async () => {
  const root = makeTempDir("chat-placement-down");
  const h = harness({
    stdin: "x", roots: [root],
    handler: (message) => message["type"] === "session_start"
      ? { type: "error", v: 2, id: String(message["id"]), code: "launch_failed",
          message: "tailii launch: herdr セッション 'w' が動いていません。指定どおりに入れられないので起動していません\n" } as ControlMessage
      : defaultHandler(message),
  });
  expect(await runChat(["new", "--cwd", root, "--request-id", "r-down", "--herdr-session", "w", "--json"], h.deps)).toBe(EXIT.policy);
  expect(h.json()).toMatchObject({ error: { code: "placement_unavailable" } });
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
