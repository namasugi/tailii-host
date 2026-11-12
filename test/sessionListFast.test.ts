import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { ClaudeSessionStore, lastConversationTimestamp, scanTranscriptTail } from "../src/sessions/claudeSessionStore.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { ListMemoFile } from "../src/sessions/listMemoFile.js";
import { ownTranscriptActivityProvider } from "../src/sessions/sessionActivityProvider.js";
import { SessionListService } from "../src/sessions/sessionListService.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import type { SessionBackend } from "../src/backend/sessionBackend.js";
import type { SessionInfo } from "../src/protocol.js";
import { claudeProjectSlug, standardize } from "../src/shared/paths.js";
import { makeTempDir, MockTmuxRunner, ok } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

function rollout(home: string, id: string, cwd: string, seconds: number, options: {
  compressed?: boolean; background?: boolean; empty?: boolean; day?: string;
} = {}): string {
  const dir = path.join(home, "sessions", options.day ?? "2026/01/01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl${options.compressed ? ".zst" : ""}`);
  const content = JSON.stringify({ type: "session_meta", payload: {
    id, cwd, source: options.background ? "exec" : "cli", timestamp: "2026-01-01T00:00:00Z",
  } }) + "\n" + (options.empty ? "" : JSON.stringify({ type: "event_msg", payload: {
    type: "user_message", message: "hello", images: [],
  } }) + "\n");
  fs.writeFileSync(file, options.compressed ? zlib.zstdCompressSync(Buffer.from(content)) : content);
  fs.utimesSync(file, seconds, seconds);
  return file;
}

function transcript(root: string, cwd: string, id: string, seconds: number | null): string {
  const dir = path.join(root, claudeProjectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, seconds === null ? '{"type":"last-prompt"}\n' : conversation(seconds));
  return file;
}

function conversation(seconds: number): string {
  return JSON.stringify({ type: "user", cwd: "/a", timestamp: new Date(seconds * 1000).toISOString(),
    message: { content: "hello" } }) + "\n";
}

function memo(file: string, root: string): ListMemoFile {
  return new ListMemoFile(file, root, "resume-fast-test");
}

function backend(raw: SessionInfo[]): SessionBackend {
  return { list: async () => raw } as SessionBackend;
}

describe("稼働一覧の Codex activity", () => {
  test("異なる cwd も page 内の列挙は 1 回。直後の会話一覧はディレクトリ列挙を再利用する", async () => {
    const home = makeTempDir("fast-codex");
    const a = rollout(home, "a", "/a", 100);
    rollout(home, "b", "/b", 200);
    const codex = new CodexSessionStore(home);
    const metadata = new SessionMetadataStore(makeTempDir("fast-meta"));
    const raw: SessionInfo[] = ["a", "b", "a2"].map((name) => {
      const cwd = name === "b" ? "/b" : "/a";
      metadata.put({ name, cwd, agent: "codex", createdAt: 0 });
      return { name, cwd, agent: "codex", alive: true };
    });
    const scan = vi.spyOn(codex as unknown as { listRolloutsAsync: (...args: unknown[]) => Promise<unknown> }, "listRolloutsAsync");
    const readDirectory = vi.spyOn(fs.promises, "readdir");
    const service = new SessionListService(backend(raw), ownTranscriptActivityProvider({
      metadataStore: metadata, codexStore: codex, claudeStore: new ClaudeSessionStore(makeTempDir("fast-claude")),
    }));
    expect((await service.page(5, undefined)).sessions.map((s) => [s.name, s.updatedAt]))
      .toEqual([["b", 200], ["a", 100], ["a2", 100]]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(readDirectory).toHaveBeenCalledTimes(4);
    expect(codex.list()).toHaveLength(2);

    fs.appendFileSync(a, '{"type":"event_msg"}\n');
    fs.utimesSync(a, 500, 500);
    expect((await service.page(5, undefined)).sessions.map((s) => s.updatedAt)).toEqual([500, 500, 200]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(readDirectory).toHaveBeenCalledTimes(4);
  });

  test("保存メモのある別 cwd・バックグラウンドの stat は省き、古い日付の追記は検出する", async () => {
    const home = makeTempDir("fast-codex-scope");
    const old = rollout(home, "old", "/a", 100);
    const compressed = rollout(home, "compressed", "/a", 200, { compressed: true });
    const unrelated = rollout(home, "other", "/other", 300);
    const background = rollout(home, "exec", "/a", 400, { background: true });
    const memoPath = path.join(makeTempDir("fast-memo"), "codex.json");
    new CodexSessionStore(home, undefined, { memoFile: memo(memoPath, home) }).list();
    const store = new CodexSessionStore(home, undefined, { memoFile: memo(memoPath, home) });
    const stat = vi.spyOn(fs.promises, "stat");
    expect(await store.latestActivity("/a")).toBe(200);
    expect(stat.mock.calls.map(([file]) => file)).toContain(old);
    expect(stat.mock.calls.map(([file]) => file)).toContain(compressed);
    expect(stat.mock.calls.map(([file]) => file)).not.toContain(unrelated);
    expect(stat.mock.calls.map(([file]) => file)).not.toContain(background);
    fs.appendFileSync(old, '{"type":"event_msg"}\n');
    fs.utimesSync(old, 900, 900);
    expect(await store.latestActivity("/a")).toBe(900);
    fs.utimesSync(compressed, 1000, 1000);
    expect(await store.latestActivity("/a")).toBe(1000);
    fs.unlinkSync(compressed);
    expect(await store.latestActivity("/a")).toBe(900);
    rollout(home, "new", "/a", 1200, { day: "2026/11/12" });
    expect(await store.latestActivity("/a")).toBe(1200);
  });

  test("空・background・重複 ID・子 cwd・上限は list(cwd) と同じ扱い", async () => {
    const home = makeTempDir("fast-codex-equivalence");
    rollout(home, "old", "/a", 100);
    rollout(home, "same", "/a", 200);
    rollout(home, "same", "/b", 300, { day: "2026/02/01" });
    rollout(home, "empty", "/a", 600, { empty: true });
    rollout(home, "exec", "/a", 700, { background: true });
    rollout(home, "child", "/a/child", 800);
    for (const limit of [0, 1, 2, Infinity]) {
      const store = new CodexSessionStore(home, limit);
      for (const cwd of ["/a", "/b", "/missing"]) {
        const values = store.list(cwd).filter((info) => standardize(info.cwd) === cwd)
          .flatMap((info) => info.updatedAt === undefined ? [] : [info.updatedAt]);
        expect(await store.latestActivity(cwd)).toBe(values.length ? Math.max(...values) : null);
      }
    }
  });

  test("メモの無い新しいコピーも別 cwd の同 ID と比較し、同時に別の cwd が来ても取りこぼさない", async () => {
    const home = makeTempDir("fast-codex-copy");
    rollout(home, "same", "/b", 500);
    const store = new CodexSessionStore(home);
    store.list();
    rollout(home, "same", "/a", 100, { day: "2026/02/01" });
    const pending = store.latestActivity("/a");
    await Promise.resolve();
    expect(await store.latestActivity("/b")).toBe(500);
    expect(await pending).toBeNull();
  });
});

describe("Claude の保存先と最終会話時刻", () => {
  test("複数 ID の fallback は全 slug を 1 回だけ確認し、次の要求で移設を検出する", async () => {
    const root = makeTempDir("fast-claude-batch");
    transcript(root, "/a", "one", null);
    const body = transcript(root, "/b", "one", 100);
    transcript(root, "/b", "two", 200);
    const store = new ClaudeSessionStore(root);
    const readdir = vi.spyOn(fs.promises, "readdir");
    expect(await Promise.all([
      store.transcriptActivity("one", "/a"), store.transcriptActivity("two", "/missing"),
      store.transcriptActivity("absent", "/missing"),
    ])).toEqual([100, 200, null]);
    expect(readdir).toHaveBeenCalledTimes(3); // projects + 2 slugs（ID ごとには歩かない）
    readdir.mockClear();
    expect(await store.transcriptActivity("one", "/a")).toBe(100);
    expect(readdir).not.toHaveBeenCalled();
    fs.unlinkSync(body);
    transcript(root, "/c", "one", 300);
    expect(await store.transcriptActivity("one", "/a")).toBe(300);
  });

  test("activity の cwd fast path も全 slug を列挙しない", async () => {
    const root = makeTempDir("fast-claude-direct");
    transcript(root, "/a", "sid", 100);
    const readdir = vi.spyOn(fs.promises, "readdir");
    expect(await new ClaudeSessionStore(root).transcriptActivity("sid", "/a")).toBe(100);
    expect(readdir).not.toHaveBeenCalled();
  });

  test("cwd の slug に本体があれば projects の readdir 権限は不要", () => {
    const root = makeTempDir("fast-claude-path");
    const file = transcript(root, "/a", "sid", 100);
    const store = new ClaudeSessionStore(root);
    fs.chmodSync(root, 0o111);
    try { expect(store.transcriptPath("sid", "/a")).toBe(file); }
    finally { fs.chmodSync(root, 0o755); }
  });

  test("hint が不在・状態行だけなら本体へ落ち、移設・削除にも追随する", () => {
    const root = makeTempDir("fast-claude-fallback");
    transcript(root, "/a", "sid", null);
    const body = transcript(root, "/b", "sid", 100);
    const store = new ClaudeSessionStore(root);
    expect(store.transcriptPath("sid", "/missing")).toBe(body);
    expect(store.transcriptPath("sid", "/a")).toBe(body);
    fs.unlinkSync(body);
    const moved = transcript(root, "/c", "sid", 200);
    expect(store.transcriptPath("sid", "/a")).toBe(moved);
    fs.unlinkSync(moved);
    expect(store.transcriptPath("sid", "/a")).toBe(path.join(root, claudeProjectSlug("/a"), "sid.jsonl"));
  });

  test("mtime・size が同じなら時刻を読み直さず、状態行追記では進まず、発話追記で進む", () => {
    const root = makeTempDir("fast-claude-activity");
    const file = transcript(root, "/a", "sid", 100);
    const store = new ClaudeSessionStore(root);
    expect(store.lastConversationTimestamp(file)).toBe(100);
    fs.chmodSync(file, 0o000);
    try { expect(store.lastConversationTimestamp(file)).toBe(100); }
    finally { fs.chmodSync(file, 0o644); }
    fs.appendFileSync(file, '{"type":"queue-operation","timestamp":"2030-01-01T00:00:00Z"}\n');
    expect(store.lastConversationTimestamp(file)).toBe(100);
    fs.appendFileSync(file, conversation(300));
    expect(store.lastConversationTimestamp(file)).toBe(300);
    fs.unlinkSync(file);
    expect(store.lastConversationTimestamp(file)).toBeNull();
  });

  test("次の engine は保存済み一覧メモを使い、追記されたら読み直す", () => {
    const root = makeTempDir("fast-claude-persist");
    const file = transcript(root, "/a", "sid", 100);
    const memoPath = path.join(makeTempDir("fast-memo"), "claude.json");
    new ClaudeSessionStore(root, { memoFile: memo(memoPath, root) }).list();
    const store = new ClaudeSessionStore(root, { memoFile: memo(memoPath, root) });
    fs.chmodSync(file, 0o000);
    try { expect(store.lastConversationTimestamp(file)).toBe(100); }
    finally { fs.chmodSync(file, 0o644); }
    fs.appendFileSync(file, conversation(200));
    expect(store.lastConversationTimestamp(file)).toBe(200);
  });

  test.each(["text", "tool-result", "state-only", "large-state", "large-message"])(
    "時刻専用読取は従来の末尾スキャンと同じ (%s)", (kind) => {
      const file = path.join(makeTempDir("fast-tail"), "sid.jsonl");
      const content = kind === "state-only" ? '{"type":"mode"}\n'
        : kind === "tool-result" ? JSON.stringify({ type: "user", timestamp: new Date(100000).toISOString(),
          message: { content: [{ type: "tool_result", content: "ok" }] } }) + "\n"
        : conversation(100) + (kind === "large-state" ? JSON.stringify({ type: "mode", data: "x".repeat(300000) }) + "\n"
          : kind === "large-message" ? JSON.stringify({ type: "assistant", timestamp: new Date(200000).toISOString(),
            message: { content: "x".repeat(20000) } }) + "\n" : "");
      fs.writeFileSync(file, content);
      expect(lastConversationTimestamp(file)).toBe(scanTranscriptTail(file).updatedAt);
    },
  );
});

describe("一覧のメタ全読み", () => {
  test("全メタの内容・順序は同じ。並行要求は 1 回にまとめ、変更分だけ読む", async () => {
    const root = makeTempDir("fast-metadata");
    const store = new SessionMetadataStore(root);
    store.put({ name: "a", cwd: "/a", createdAt: 0 });
    store.put({ name: "b", cwd: "/b", createdAt: 0, backend: "herdr" });
    fs.writeFileSync(path.join(root, "broken.json"), "{");
    const expected = store.all();
    const readdir = vi.spyOn(fs.promises, "readdir");
    const read = vi.spyOn(fs.promises, "readFile");
    expect(await Promise.all([store.allAsync(), store.allAsync(), store.allAsync()]))
      .toEqual([expected, expected, expected]);
    expect(readdir).toHaveBeenCalledTimes(1);
    read.mockClear();
    const second = await store.allAsync();
    expect(read.mock.calls.map(([file]) => file)).toEqual([path.join(root, "broken.json")]);
    second[0]!.cwd = "/mutated";
    expect(store.get("a")?.cwd).toBe("/a");
    store.put({ name: "a", cwd: "/new", createdAt: 0 });
    fs.unlinkSync(path.join(root, "b.json"));
    expect(await store.allAsync()).toEqual(store.all());
  });

  test("tmux 一覧は終了済みメタを残し、同期 all() は呼ばない", async () => {
    const store = new SessionMetadataStore(makeTempDir("fast-tmux-meta"));
    store.put({ name: "dead", cwd: "/dead", createdAt: 0 });
    store.put({ name: "live", cwd: "/live", createdAt: 0 });
    const all = vi.spyOn(store, "all");
    const runner = new MockTmuxRunner(() => ok("live\n"));
    const manager = new TmuxSessionManager({ store, runner: runner.runner });
    expect((await manager.list()).map((s) => [s.name, s.alive])).toEqual([["dead", false], ["live", true]]);
    expect(all).not.toHaveBeenCalled();
  });
});

test("同じ入力で旧 provider と全ページの内容・updatedAt・並び・cursor が一致する", async () => {
  const metadata = new SessionMetadataStore(makeTempDir("fast-order-meta"));
  const root = makeTempDir("fast-order-claude");
  const home = makeTempDir("fast-order-codex");
  const claude = new ClaudeSessionStore(root);
  const codex = new CodexSessionStore(home);
  transcript(root, "/a", "body", 100);
  transcript(root, "/a", "stub", null);
  transcript(root, "/elsewhere", "stub", 200);
  rollout(home, "a", "/a", 200);
  rollout(home, "b", "/b", 300);
  const raw: SessionInfo[] = [
    { name: "claude", cwd: "/a", alive: true, claudeSessionId: "body" },
    { name: "stub", cwd: "/a", alive: false, claudeSessionId: "stub" },
    { name: "codex-a", cwd: "/a", alive: true, agent: "codex" },
    { name: "codex-b", cwd: "/b", alive: true, agent: "codex" },
    { name: "none", cwd: "/a", alive: true },
    { name: "provided", cwd: "/a", alive: false, updatedAt: 250 },
    { name: "unrecorded", cwd: "/a", alive: true },
  ];
  for (const info of raw.slice(0, -1)) metadata.put({ ...info, createdAt: 0 });
  const oldProvider = (info: SessionInfo): number | null => {
    const meta = metadata.get(info.name);
    if (!meta) return null;
    if (meta.agent === "codex") {
      const cwd = standardize(meta.cwd);
      const times = codex.list(cwd).filter((row) => standardize(row.cwd) === cwd)
        .flatMap((row) => row.updatedAt === undefined ? [] : [row.updatedAt]);
      return times.length ? Math.max(...times) : null;
    }
    if (!meta.claudeSessionId) return null;
    const file = claude.transcriptPath(meta.claudeSessionId);
    return file === null ? null : scanTranscriptTail(file).updatedAt;
  };
  const old = new SessionListService(backend(raw), oldProvider);
  const current = new SessionListService(backend(raw), ownTranscriptActivityProvider({
    metadataStore: metadata, claudeStore: claude, codexStore: codex,
  }));
  for (const limit of [0, 1, 2, 5, 20, undefined]) {
    let cursor: string | undefined;
    do {
      const expected = await old.page(limit, cursor);
      expect(await current.page(limit, cursor)).toEqual(expected);
      cursor = expected.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(await current.page(limit, "invalid")).toEqual(await old.page(limit, "invalid"));
  }
});
