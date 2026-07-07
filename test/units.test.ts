// units.test.ts — 純ロジック/値型サービスの単体テスト
// Swift 版 PermissionModeTests / SessionListServiceTests / DirListerTests / UsageAggregatorTests /
// PlanUsageFetcherTests / SessionMetadataStoreTests / SessionIdleTrackerTests /
// TmuxSessionManagerTests / ClaudeSessionStoreTests の要点を移植する。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { ChatTailController } from "../src/chatTailController.js";
import { ClaudeSessionStore, cwdFromSlug } from "../src/claudeSessionStore.js";
import { dirChildren, dirCreate, dirList } from "../src/dirLister.js";
import { parsePermissionMode } from "../src/permissionMode.js";
import { extractCredential, orderCandidates, parsePlanUsage } from "../src/planUsageFetcher.js";
import { SessionIdleTracker } from "../src/sessionIdleTracker.js";
import {
  SessionListService,
  decodeSessionListCursor,
  encodeSessionListCursor,
} from "../src/sessionListService.js";
import { SessionMetadataStore } from "../src/sessionMetadataStore.js";
import { resolveDefaultAgent } from "../src/engine.js";
import { TmuxFailedError, TmuxSessionManager } from "../src/tmux.js";
import { aggregateUsage } from "../src/usageAggregator.js";
import { MockTmuxRunner, makeTempDir, makeTempStore, ok } from "./helpers.js";

// MARK: - resolveDefaultAgent（host 側エージェント切替）

describe("resolveDefaultAgent", () => {
  test("ファイル内容 codex → codex、その他/不在は claude", () => {
    const dir = makeTempDir("agent-file");
    const p = path.join(dir, "agent");
    fs.writeFileSync(p, "codex\n");
    expect(resolveDefaultAgent(p)).toBe("codex");
    fs.writeFileSync(p, "  CODEX  ");
    expect(resolveDefaultAgent(p)).toBe("codex");
    fs.writeFileSync(p, "claude");
    expect(resolveDefaultAgent(p)).toBe("claude");
    fs.writeFileSync(p, "gpt");
    expect(resolveDefaultAgent(p)).toBe("claude");
    expect(resolveDefaultAgent(path.join(dir, "nope"))).toBe("claude");
  });
});

// MARK: - PermissionModeDetector

describe("parsePermissionMode", () => {
  test("末尾4行のマーカーからモードを判定する", () => {
    expect(parsePermissionMode("本文\n⏵⏵ accept edits on (shift+tab to cycle)")).toBe("acceptEdits");
    expect(parsePermissionMode("本文\n⏸ plan mode on (shift+tab to cycle)")).toBe("plan");
    expect(parsePermissionMode("本文\n⏵⏵ auto mode on (shift+tab to cycle)")).toBe("auto");
    expect(parsePermissionMode("本文\n? for shortcuts")).toBe("default");
    expect(parsePermissionMode("処理中\n...· esc to interrupt · ← for agents")).toBe("default");
  });

  test("会話本文に同じ語があっても末尾4行しか見ない", () => {
    const pane = ["plan mode on の説明", "a", "b", "c", "d", "? for shortcuts"].join("\n");
    expect(parsePermissionMode(pane)).toBe("default");
  });

  test("ダイアログヒント行だけがあるときは判定不能として null を返す", () => {
    expect(parsePermissionMode("本文\nEnter to select · ↑/↓ to navigate · Esc to cancel")).toBeNull();
    expect(parsePermissionMode("本文\nEnter to confirm · Esc to cancel")).toBeNull();
  });
});

// MARK: - SessionListService（整列 + keyset ページング）

describe("SessionListService", () => {
  function makeService(
    metas: { name: string; cwd: string }[],
    live: string[],
    updatedAt: Record<string, number>,
  ): SessionListService {
    const store = makeTempStore();
    for (const m of metas) store.put({ ...m, createdAt: 0 });
    const runner = new MockTmuxRunner((args) =>
      args[0] === "ls" ? ok(live.join("\n") + "\n") : ok(""),
    );
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    return new SessionListService(mgr, (info) => updatedAt[info.name] ?? null);
  }

  test("(updatedAt desc, name asc) で整列し limit 件 + nextCursor を返す", async () => {
    const names = ["a", "b", "c", "d"];
    const service = makeService(
      names.map((n) => ({ name: n, cwd: `/tmp/${n}` })),
      names,
      { a: 10, b: 30, c: 30, d: 0 },
    );
    const page1 = await service.page(2, undefined);
    expect(page1.sessions.map((s) => s.name)).toEqual(["b", "c"]); // 30 同値は name 昇順
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await service.page(2, page1.nextCursor!);
    expect(page2.sessions.map((s) => s.name)).toEqual(["a", "d"]);
    expect(page2.nextCursor).toBeNull(); // 続きなしは省略
  });

  test("復号不能な cursor は先頭ページ扱い（安全側）", async () => {
    const service = makeService([{ name: "x", cwd: "/tmp/x" }], ["x"], {});
    const page = await service.page(5, "!!!not-a-cursor!!!");
    expect(page.sessions.map((s) => s.name)).toEqual(["x"]);
  });

  test("cursor は base64url(JSON) を往復できる", () => {
    const token = encodeSessionListCursor(1234, "セッション/名");
    expect(decodeSessionListCursor(token)).toEqual({ u: 1234, n: "セッション/名" });
  });
});

// MARK: - DirLister

describe("DirLister", () => {
  test("prefix 一致のサブディレクトリのみ返す（ファイル除外・ソート済み）", () => {
    const base = makeTempDir("dirlister");
    fs.mkdirSync(path.join(base, "foo"));
    fs.mkdirSync(path.join(base, "foobar"));
    fs.mkdirSync(path.join(base, "zzz"));
    fs.writeFileSync(path.join(base, "foofile"), "x");
    expect(dirList(base, "fo")).toEqual(["foo", "foobar"]);
  });

  test("隠し dir は prefix が `.` 始まりのときのみ含める", () => {
    const base = makeTempDir("dirlister-hidden");
    fs.mkdirSync(path.join(base, ".git"));
    fs.mkdirSync(path.join(base, "src"));
    expect(dirList(base, "")).toEqual(["src"]);
    expect(dirList(base, ".g")).toEqual([".git"]);
  });

  test("絶対/~/`..` 脱出は空配列", () => {
    const base = makeTempDir("dirlister-escape");
    expect(dirList(base, "/etc")).toEqual([]);
    expect(dirList(base, "~/x")).toEqual([]);
    expect(dirList(base, "../")).toEqual([]);
  });

  test("dirCreate は base 配下のみ作成し、脱出は ok=false", () => {
    const base = makeTempDir("dircreate");
    const okResult = dirCreate(base, "a/b");
    expect(okResult.ok).toBe(true);
    expect(fs.statSync(path.join(base, "a", "b")).isDirectory()).toBe(true);
    // 冪等
    expect(dirCreate(base, "a/b").ok).toBe(true);
    expect(dirCreate(base, "../escape").ok).toBe(false);
    expect(dirCreate(base, "/abs").ok).toBe(false);
    expect(dirCreate(base, "  ").ok).toBe(false);
  });

  test("dirChildren は隠し dir とファイルを除外してソートで返す", () => {
    const base = makeTempDir("dirchildren");
    fs.mkdirSync(path.join(base, "dev"));
    fs.mkdirSync(path.join(base, "Documents"));
    fs.mkdirSync(path.join(base, ".hidden"));
    fs.writeFileSync(path.join(base, "file.txt"), "x");
    expect(dirChildren(base)).toEqual(["Documents", "dev"]);
    expect(dirChildren(path.join(base, "nope"))).toEqual([]);
  });
});

// MARK: - UsageAggregator

describe("aggregateUsage", () => {
  test("assistant 行の usage を合算し、非対象行はスキップする", () => {
    const dir = makeTempDir("usage");
    const p = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      p,
      [
        '{"message":{"role":"assistant","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}}',
        '{"message":{"role":"user","usage":{"input_tokens":999}}}',
        "garbage line",
        '{"message":{"role":"assistant","usage":{"input_tokens":1,"output_tokens":2}}}',
        '{"message":{"role":"assistant"}}',
      ].join("\n") + "\n",
    );
    expect(aggregateUsage(p)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      turns: 2,
    });
  });

  test("ファイル不在は全 0", () => {
    expect(aggregateUsage("/nope/nothing.jsonl").turns).toBe(0);
  });
});

// MARK: - PlanUsageFetcher（純ロジック）

describe("PlanUsageFetcher", () => {
  test("代表形式（five_hour/seven_day）をパースする", () => {
    const usage = parsePlanUsage({
      five_hour: { utilization: 23, resets_at: "2026-07-06T12:00:00Z" },
      seven_day: { utilization: 65.4, resets_at: "2026-07-09T00:00:00Z" },
    });
    expect(usage).toEqual({
      fiveHourUtilization: 23,
      fiveHourResetsAt: "2026-07-06T12:00:00Z",
      sevenDayUtilization: 65,
      sevenDayResetsAt: "2026-07-09T00:00:00Z",
      sevenDayFableUtilization: null,
      sevenDayFableResetsAt: null,
    });
  });

  test("上位モデル週間枠は limits[] の weekly_scoped にフォールバックする", () => {
    const usage = parsePlanUsage({
      five_hour: { utilization: 1 },
      limits: [
        { kind: "other", percent: 99 },
        { kind: "weekly_scoped", percent: 42, resets_at: "2026-07-10T00:00:00Z" },
      ],
    });
    expect(usage?.sevenDayFableUtilization).toBe(42);
    expect(usage?.sevenDayFableResetsAt).toBe("2026-07-10T00:00:00Z");
  });

  test("どの枠も無ければ null", () => {
    expect(parsePlanUsage({})).toBeNull();
    expect(parsePlanUsage("not-an-object")).toBeNull();
  });

  test("orderCandidates は期限内を先・期限切れを後・重複除去", () => {
    const now = 1000;
    expect(
      orderCandidates(
        [
          { token: "expired", expiresAtMs: 500 },
          { token: "valid1", expiresAtMs: 2000 },
          { token: "noexp", expiresAtMs: null },
          { token: "valid1", expiresAtMs: 3000 },
        ],
        now,
      ),
    ).toEqual(["valid1", "noexp", "expired"]);
  });

  test("extractCredential は claudeAiOauth.accessToken を取り出す（末尾改行トリム）", () => {
    const cred = extractCredential(
      '{"claudeAiOauth":{"accessToken":"tok-1","expiresAt":123456}}\n',
    );
    expect(cred).toEqual({ token: "tok-1", expiresAtMs: 123456 });
    expect(extractCredential('{"claudeAiOauth":{"accessToken":""}}')).toBeNull();
    expect(extractCredential("not json")).toBeNull();
  });
});

// MARK: - SessionMetadataStore

describe("SessionMetadataStore", () => {
  test("put/get 往復と all 列挙（壊れたファイルは無視）", () => {
    const base = makeTempDir("metastore");
    const store = new SessionMetadataStore(base);
    store.put({ name: "work", cwd: "/tmp/work", createdAt: 42 });
    expect(store.get("work")).toEqual({ name: "work", cwd: "/tmp/work", createdAt: 42 });
    fs.writeFileSync(path.join(base, "broken.json"), "{{{");
    expect(store.all()).toEqual([{ name: "work", cwd: "/tmp/work", createdAt: 42 }]);
  });

  test("不正名は put が throw、get は null", () => {
    const store = new SessionMetadataStore(makeTempDir("metastore-bad"));
    expect(() => store.put({ name: "a/b", cwd: "/x", createdAt: 0 })).toThrow();
    expect(() => store.put({ name: "..", cwd: "/x", createdAt: 0 })).toThrow();
    expect(store.get("a/b")).toBeNull();
    expect(store.get("nope")).toBeNull();
  });

  test("agent フィールドの往復（codex は記録、claude/未指定は従来形式のまま）", () => {
    const store = new SessionMetadataStore(makeTempDir("metastore-agent"));
    // codex は agent を記録する。
    store.put({ name: "cdx", cwd: "/tmp/c", createdAt: 1, agent: "codex" });
    expect(store.get("cdx")).toEqual({ name: "cdx", cwd: "/tmp/c", createdAt: 1, agent: "codex" });
    // agent 未指定は従来どおり agent キー無し（後方互換）。
    store.put({ name: "cla", cwd: "/tmp/l", createdAt: 2 });
    expect(store.get("cla")).toEqual({ name: "cla", cwd: "/tmp/l", createdAt: 2 });
  });
});

// MARK: - SessionIdleTracker

describe("SessionIdleTracker", () => {
  test("markIdle → expired、markActive/remove で解除", () => {
    const tracker = new SessionIdleTracker(60);
    tracker.markIdle("a", 100);
    tracker.markIdle("b", 150);
    expect(tracker.expired(160)).toEqual(["a"]);
    expect(tracker.expired(210)).toEqual(["a", "b"]);
    tracker.markActive("a");
    expect(tracker.expired(210)).toEqual(["b"]);
    tracker.remove("b");
    expect(tracker.expired(1000)).toEqual([]);
  });
});

// MARK: - TmuxSessionManager

describe("TmuxSessionManager", () => {
  test("list は tmux 生存集合とメタデータを統合する（メタのみは alive:false）", async () => {
    const store = makeTempStore();
    store.put({ name: "dead", cwd: "/tmp/dead", createdAt: 0 });
    store.put({ name: "live", cwd: "/tmp/live", createdAt: 0 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("live\nunknown\n") : ok("")));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });
    expect(await mgr.list()).toEqual([
      { name: "dead", cwd: "/tmp/dead", alive: false },
      { name: "live", cwd: "/tmp/live", alive: true },
      { name: "unknown", cwd: "", alive: true },
    ]);
  });

  test("`no server running` は空集合として扱う（エラーにしない）", async () => {
    const runner = new MockTmuxRunner((args) =>
      args[0] === "ls"
        ? { exitCode: 1, stdout: "", stderr: "no server running on /tmp/tmux-501/default" }
        : ok(""),
    );
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    expect(await mgr.list()).toEqual([]);
  });

  test("kill の非0終了は TmuxFailedError", async () => {
    const runner = new MockTmuxRunner(() => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    await expect(mgr.kill("x")).rejects.toBeInstanceOf(TmuxFailedError);
  });

  test("capturePane は末尾の空行を削る", async () => {
    const runner = new MockTmuxRunner((args) =>
      args[0] === "capture-pane" ? ok("a\nb\n\n  \n") : ok(""),
    );
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    expect(await mgr.capturePane("s")).toBe("a\nb");
  });

  test("不正セッション名は tmux を呼ばず拒否する", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    await expect(mgr.kill("a/b")).rejects.toThrow();
    expect(runner.recorded).toEqual([]);
  });
});

// MARK: - ClaudeSessionStore

describe("ClaudeSessionStore", () => {
  test("jsonl から sessionId/cwd/title/updatedAt を導出し updatedAt 降順で返す", () => {
    const root = makeTempDir("claude-sessions");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    const oldFile = path.join(slugDir, "aaaaaaaa-0000-0000-0000-000000000000.jsonl");
    const newFile = path.join(slugDir, "bbbbbbbb-0000-0000-0000-000000000000.jsonl");
    fs.writeFileSync(oldFile, '{"type":"user","cwd":"/tmp/proj","message":{"content":"古い会話"}}\n');
    fs.writeFileSync(newFile, '{"type":"user","cwd":"/tmp/proj","message":{"content":"新しい会話"}}\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, past, past);

    const list = new ClaudeSessionStore(root).list();
    expect(list.map((s) => s.title)).toEqual(["新しい会話", "古い会話"]);
    expect(list[0]?.cwd).toBe("/tmp/proj");
    expect(list[0]?.sessionId).toBe("bbbbbbbb-0000-0000-0000-000000000000");
    expect(list[0]?.updatedAt).toBeGreaterThan(0);
  });

  test("cwd 行が無ければ slug から復元し、title は sessionId 先頭8字", () => {
    const root = makeTempDir("claude-sessions-fallback");
    const slugDir = path.join(root, "-Users-me-dev");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "cccccccc-1111.jsonl"), '{"type":"system"}\n');
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.cwd).toBe("/Users/me/dev");
    expect(list[0]?.title).toBe("cccccccc");
  });

  test("`<command-…>` 始まりの user 行はタイトルに採用しない", () => {
    const root = makeTempDir("claude-sessions-cmd");
    const slugDir = path.join(root, "-tmp-x");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "dddddddd-2222.jsonl"),
      '{"type":"user","cwd":"/tmp/x","message":{"content":"<command-name>/foo</command-name>"}}\n' +
        '{"type":"user","message":{"content":"実際の質問"}}\n',
    );
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("実際の質問");
  });

  test("cwdFromSlug は lossy 復元（空は /）", () => {
    expect(cwdFromSlug("-Users-me-dev")).toBe("/Users/me/dev");
    expect(cwdFromSlug("")).toBe("/");
  });
});

// MARK: - ChatTailController（添付抽出の純ロジック）

describe("ChatTailController.attachmentImagePaths", () => {
  test("引用形式・非引用形式の画像パスを重複なく抽出する（画像拡張子のみ）", () => {
    const text =
      '見て @"/tmp/my photo.png" と @/tmp/shot.jpeg と @/tmp/doc.pdf と @"/tmp/my photo.png"';
    expect(ChatTailController.attachmentImagePaths(text)).toEqual([
      "/tmp/my photo.png",
      "/tmp/shot.jpeg",
    ]);
  });

  test("@ が無ければ空", () => {
    expect(ChatTailController.attachmentImagePaths("画像なし")).toEqual([]);
  });
});

describe("ChatTailController.readImagePath", () => {
  test("Read ツールで画像拡張子ならパスを返す（大文字拡張子も許容）", () => {
    expect(ChatTailController.readImagePath({ name: "Read", file: "/tmp/shot.png" })).toBe(
      "/tmp/shot.png",
    );
    expect(ChatTailController.readImagePath({ name: "Read", file: "/tmp/A.JPEG" })).toBe(
      "/tmp/A.JPEG",
    );
  });

  test("Read でも非画像拡張子・パス無しは null", () => {
    expect(ChatTailController.readImagePath({ name: "Read", file: "/tmp/main.ts" })).toBeNull();
    expect(ChatTailController.readImagePath({ name: "Read", file: "/tmp/noext" })).toBeNull();
    expect(ChatTailController.readImagePath({ name: "Read" })).toBeNull();
    expect(ChatTailController.readImagePath({ name: "Read", file: "" })).toBeNull();
  });

  test("Read 以外のツールは画像でも null（Edit/Write のインライン化を避ける）", () => {
    expect(ChatTailController.readImagePath({ name: "Write", file: "/tmp/out.png" })).toBeNull();
    expect(ChatTailController.readImagePath({ name: "Edit", file: "/tmp/out.png" })).toBeNull();
    expect(ChatTailController.readImagePath({ name: "Glob", file: "/tmp/out.png" })).toBeNull();
  });
});
