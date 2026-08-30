// units.test.ts — 純ロジック/値型サービスの単体テスト
// Swift 版 PermissionModeTests / SessionListServiceTests / DirListerTests / UsageAggregatorTests /
// PlanUsageFetcherTests / SessionMetadataStoreTests / HeartbeatTests /
// TmuxSessionManagerTests / ClaudeSessionStoreTests の要点を移植する。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { ChatTailController } from "../src/chat/chatTailController.js";
import { ClaudeSessionStore, cwdFromSlug, transcriptTitle } from "../src/sessions/claudeSessionStore.js";
import { dirCanCreate, dirChildren, dirCreate, dirList } from "../src/services/dirLister.js";
import { parsePermissionMode } from "../src/shared/permissionMode.js";
import { resolveHostDisplayName } from "../src/shared/hostDisplayName.js";
import {
  credentialFromKeychain,
  credentialFromKeychainMirror,
  extractCredential,
  orderCandidates,
  parseMaskedClaudeProfile,
  parsePlanUsage,
  resolveClaudeOAuth,
  withClaudeOAuthCredential,
  type CredentialCommandRunner,
} from "../src/services/planUsageFetcher.js";
import { readKeychainMirror, writeKeychainMirror } from "../src/services/keychainMirror.js";
import {
  bumpHeartbeat,
  listHeartbeatSessions,
  readHeartbeat,
  removeHeartbeat,
  writeHeartbeat,
} from "../src/sessions/heartbeat.js";
import { searchClaudeSessions } from "../src/sessions/sessionSearch.js";
import { stripInjectedReminderBlocks, stripReminderTagBlocks } from "../src/shared/harnessReminder.js";
import {
  SessionListService,
  decodeSessionListCursor,
  encodeSessionListCursor,
} from "../src/sessions/sessionListService.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { resolveDefaultAgent } from "../src/engine/engine.js";
import {
  loginCodeScreenState,
  screenHasLoginCodePrompt,
  screenInLoginFlow,
  submitLoginCode,
  TmuxFailedError,
  TmuxSessionManager,
} from "../src/backend/tmux.js";
import { aggregateUsage } from "../src/services/usageAggregator.js";
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
  test("明示的な TUI ステータス行からモードを判定する", () => {
    expect(parsePermissionMode("本文\n⏵⏵ accept edits on (shift+tab to cycle)")).toBe("acceptEdits");
    expect(parsePermissionMode("本文\n⏸ plan mode on (shift+tab to cycle)")).toBe("plan");
    expect(parsePermissionMode("本文\n⏵⏵ auto mode on (shift+tab to cycle)")).toBe("auto");
    expect(parsePermissionMode("本文\n⏸ manual mode on · ? for shortcuts")).toBe("default");
    expect(parsePermissionMode("本文\n? for shortcuts")).toBe("default");
    expect(parsePermissionMode("処理中\n...· esc to interrupt · ← for agents")).toBeNull();
    expect(parsePermissionMode("本文だけでステータス行がまだ無い")).toBeNull();
  });

  test("サブエージェント一覧で末尾4行から押し出されたモード行も検出する", () => {
    const pane = [
      "本文",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage",
      "  ⏺ main",
      "  ◯ Explore agent-1",
      "  ◯ Explore agent-2",
      "  ◯ Explore agent-3",
      "  ◯ Explore agent-4",
    ].join("\n");
    expect(parsePermissionMode(pane)).toBe("auto");
  });

  test("会話本文のモード語や active ヒントを default と誤認しない", () => {
    expect(parsePermissionMode("本文\nplan mode on の説明\n続き")).toBeNull();
    expect(
      parsePermissionMode("処理中\n? for shortcuts · esc to interrupt · ← for agents"),
    ).toBeNull();
    expect(parsePermissionMode("本文\n? for shortcuts")).toBe("default");
  });

  test("ダイアログヒント行だけがあるときは判定不能として null を返す", () => {
    expect(parsePermissionMode("本文\nEnter to select · ↑/↓ to navigate · Esc to cancel")).toBeNull();
    expect(parsePermissionMode("本文\nEnter to confirm · Esc to cancel")).toBeNull();
  });

  test("ダイアログの下にサブエージェント一覧があっても背後のモードを返さない", () => {
    const pane = [
      "⏵⏵ auto mode on (shift+tab to cycle)",
      "Enter to confirm · Esc to cancel",
      "⏺ main",
      "◯ Explore agent-1",
      "◯ Explore agent-2",
      "◯ Explore agent-3",
      "◯ Explore agent-4",
    ].join("\n");
    expect(parsePermissionMode(pane)).toBeNull();
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
    expect(dirCreate(base, "../escape")).toMatchObject({ ok: false, error: "invalid_path" });
    expect(dirCreate(base, "/abs")).toMatchObject({ ok: false, error: "invalid_path" });
    expect(dirCreate(base, "  ")).toMatchObject({ ok: false, error: "invalid_path" });
    expect(dirCreate(base, "~project").ok).toBe(true);
    expect(fs.statSync(path.join(base, "~project")).isDirectory()).toBe(true);
  });

  test("dirCreate は base 外を指す symlink 経由の作成を拒否する", () => {
    const root = makeTempDir("dircreate-symlink-escape");
    const base = path.join(root, "base");
    const outside = path.join(root, "outside");
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(base, "link"));

    expect(dirCreate(base, "link/escaped")).toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    expect(fs.existsSync(path.join(outside, "escaped"))).toBe(false);
  });

  test("dirCreate は base 内を指す symlink と symlink 自体を base にした作成を許可する", () => {
    const root = makeTempDir("dircreate-symlink-inside");
    const base = path.join(root, "base");
    const inside = path.join(base, "inside");
    const alias = path.join(root, "base-alias");
    fs.mkdirSync(inside, { recursive: true });
    fs.symlinkSync(inside, path.join(base, "inside-link"));
    fs.symlinkSync(base, alias);

    expect(dirCreate(base, "inside-link/child").ok).toBe(true);
    expect(fs.statSync(path.join(inside, "child")).isDirectory()).toBe(true);
    expect(dirCreate(alias, "alias-child").ok).toBe(true);
    expect(fs.statSync(path.join(base, "alias-child")).isDirectory()).toBe(true);
  });

  test("dirCreate は作成先の状態を区別し、dirCanCreate は事前権限を返す", () => {
    const base = makeTempDir("dircreate-state");
    const file = path.join(base, "file");
    fs.writeFileSync(file, "x");

    expect(dirCanCreate(base)).toBe(true);
    expect(dirCanCreate(path.join(base, "missing"))).toBe(false);
    expect(dirCreate(file, "child")).toMatchObject({
      ok: false,
      error: "parent_not_directory",
    });
  });

  test.skipIf(process.getuid?.() === 0)(
    "dirCreate は書込み不可ディレクトリを permission_denied で拒否する",
    () => {
      const base = makeTempDir("dircreate-permission");
      fs.chmodSync(base, 0o555);
      try {
        expect(dirCanCreate(base)).toBe(false);
        expect(dirCreate(base, "child")).toMatchObject({
          ok: false,
          error: "permission_denied",
        });
      } finally {
        fs.chmodSync(base, 0o755);
      }
    },
  );

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
      // プラン情報は使用量 API 応答には無い（credentials 由来で後付けされる）。
      subscriptionType: null,
      rateLimitTier: null,
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

  test("profile は同じ token の email を host 側でマスクして返す", () => {
    expect(parseMaskedClaudeProfile({ account: { email: "alice@example.com" } }))
      .toBe("a***@example.com");
    expect(parseMaskedClaudeProfile({ account: { email_address: "bob@example.com" } }))
      .toBe("b***@example.com");
    expect(parseMaskedClaudeProfile({ account: {} })).toBeNull();
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

  test("extractCredential は subscriptionType / rateLimitTier も拾う（無ければ省略）", () => {
    expect(
      extractCredential(
        '{"claudeAiOauth":{"accessToken":"tok-1","expiresAt":1,' +
          '"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}',
      ),
    ).toEqual({
      token: "tok-1",
      expiresAtMs: 1,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    // 空文字は「無い」と同じ扱い（キーごと省略する）。
    expect(
      extractCredential('{"claudeAiOauth":{"accessToken":"tok-2","subscriptionType":""}}'),
    ).toEqual({ token: "tok-2", expiresAtMs: null });
  });

  test("QUIC/SSH 共通で login session の Keychain を最初に読む", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: CredentialCommandRunner = async (executable, args) => {
      calls.push([executable, args]);
      return '{"claudeAiOauth":{"accessToken":"shared","expiresAt":2000}}';
    };

    await expect(credentialFromKeychain(runner, 502)).resolves.toEqual({
      token: "shared",
      expiresAtMs: 2000,
    });
    expect(calls).toEqual([
      [
        "/bin/launchctl",
        [
          "asuser",
          "502",
          "/usr/bin/security",
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ],
      ],
    ]);
  });

  test("GUI session が無ければ現在の namespace で Keychain を再試行する", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: CredentialCommandRunner = async (executable, args) => {
      calls.push([executable, args]);
      if (executable === "/bin/launchctl") return null;
      return (
        '{"claudeAiOauth":{"accessToken":"direct","expiresAt":3000,' +
        '"subscriptionType":"max"}}'
      );
    };

    await expect(credentialFromKeychain(runner, 502)).resolves.toEqual({
      token: "direct",
      expiresAtMs: 3000,
      subscriptionType: "max",
    });
    expect(calls).toEqual([
      [
        "/bin/launchctl",
        [
          "asuser",
          "502",
          "/usr/bin/security",
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ],
      ],
      [
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      ],
    ]);
  });

  test("Keychain が両経路で読めなければ null（credentials file fallback を許可）", async () => {
    const runner: CredentialCommandRunner = async () => null;
    await expect(credentialFromKeychain(runner, 502)).resolves.toBeNull();
  });

  test("expiresAt が無くても file token の401後に一度だけ refresh して再試行する", async () => {
    const attempted: string[] = [];
    let refreshCalls = 0;
    const resolved = await withClaudeOAuthCredential(
      async (token) => {
        attempted.push(token);
        return token === "old"
          ? { kind: "unauthorized" as const }
          : { kind: "success" as const, value: "ok" };
      },
      {
        candidates: [{ token: "old", expiresAtMs: null, source: "file" }],
        refreshFile: async () => {
          refreshCalls += 1;
          return { accessToken: "new", expiresAtMs: 9_999, subscriptionType: "max" };
        },
        now: () => 1_000,
      },
    );

    expect(attempted).toEqual(["old", "new"]);
    expect(refreshCalls).toBe(1);
    expect(resolved).toEqual({
      value: "ok",
      credential: { token: "new", expiresAtMs: 9_999, subscriptionType: "max" },
    });
  });

  test("resolveClaudeOAuth: 候補ゼロは no_credentials、全候補 401 は unauthorized に分類する", async () => {
    const none = await resolveClaudeOAuth(
      async () => ({ kind: "success" as const, value: 1 }),
      { candidates: [], now: () => 1_000 },
    );
    expect(none).toEqual({ resolution: null, failure: "no_credentials" });

    const unauthorized = await resolveClaudeOAuth(
      async () => ({ kind: "unauthorized" as const }),
      {
        candidates: [
          { token: "kc", expiresAtMs: 0, source: "keychain" },
          { token: "file", expiresAtMs: 0, source: "file" },
        ],
        refreshFile: async () => null,
        now: () => 1_000,
      },
    );
    expect(unauthorized).toEqual({ resolution: null, failure: "unauthorized" });
  });

  test("resolveClaudeOAuth: 通信断が 1 件でも混じれば failure（ログイン切れと断定しない）", async () => {
    const outcome = await resolveClaudeOAuth(
      async (token) =>
        token === "kc" ? { kind: "unauthorized" as const } : { kind: "failure" as const },
      {
        candidates: [
          { token: "kc", expiresAtMs: 9_999, source: "keychain" },
          { token: "file", expiresAtMs: 9_999, source: "file" },
        ],
        refreshFile: async () => null,
        now: () => 1_000,
      },
    );
    expect(outcome).toEqual({ resolution: null, failure: "failure" });
  });

  test("resolveClaudeOAuth: 成功時は resolution を返し failure は null", async () => {
    const outcome = await resolveClaudeOAuth(
      async () => ({ kind: "success" as const, value: "ok" }),
      { candidates: [{ token: "kc", expiresAtMs: 9_999, source: "keychain" }], now: () => 1_000 },
    );
    expect(outcome).toEqual({
      resolution: { value: "ok", credential: { token: "kc", expiresAtMs: 9_999 } },
      failure: null,
    });
  });

  test("Keychain/file が同じ失効 token でも refresh 可能な file 候補を残す", async () => {
    let refreshCalls = 0;
    const resolved = await withClaudeOAuthCredential(
      async (token) => token === "same-old"
        ? { kind: "unauthorized" as const }
        : { kind: "success" as const, value: "renewed" },
      {
        candidates: [
          { token: "same-old", expiresAtMs: null, source: "keychain" },
          { token: "same-old", expiresAtMs: null, source: "file" },
        ],
        refreshFile: async () => {
          refreshCalls += 1;
          return { accessToken: "same-new", expiresAtMs: 9_999 };
        },
        now: () => 1_000,
      },
    );

    expect(refreshCalls).toBe(1);
    expect(resolved?.value).toBe("renewed");
    expect(resolved?.credential.token).toBe("same-new");
  });

  test("期限前 refresh が失敗してもAPIの401後にもう一度だけ更新を試す", async () => {
    let refreshCalls = 0;
    const attempted: string[] = [];
    const resolved = await withClaudeOAuthCredential(
      async (token) => {
        attempted.push(token);
        return token === "renewed"
          ? { kind: "success" as const, value: 1 }
          : { kind: "unauthorized" as const };
      },
      {
        candidates: [{ token: "expired", expiresAtMs: 500, source: "file" }],
        refreshFile: async () => {
          refreshCalls += 1;
          return refreshCalls === 1
            ? null
            : { accessToken: "renewed", expiresAtMs: 5_000 };
        },
        now: () => 1_000,
      },
    );

    expect(refreshCalls).toBe(2);
    expect(attempted).toEqual(["expired", "renewed"]);
    expect(resolved?.value).toBe(1);
  });

  test("Keychain ミラー: 有効期限内だけ候補になり、期限切れ・期限不明・壊れは捨てる", () => {
    const valid = '{"claudeAiOauth":{"accessToken":"mir","expiresAt":5000,"subscriptionType":"max"}}';
    expect(credentialFromKeychainMirror(1_000, () => valid)).toEqual({
      token: "mir",
      expiresAtMs: 5_000,
      subscriptionType: "max",
    });
    // 期限切れ: refresh に使えない読取専用コピーなので候補にしない。
    expect(credentialFromKeychainMirror(6_000, () => valid)).toBeNull();
    // 期限不明: 新鮮さを判定できないミラーは信用しない。
    expect(
      credentialFromKeychainMirror(1_000, () => '{"claudeAiOauth":{"accessToken":"m"}}'),
    ).toBeNull();
    expect(credentialFromKeychainMirror(1_000, () => "{{{")).toBeNull();
    expect(credentialFromKeychainMirror(1_000, () => null)).toBeNull();
  });

  test("keychainMirror の write/read 往復（0600・trim・内容不変スキップ）", () => {
    const dir = makeTempDir("keychain-mirror");
    const mirrorPath = path.join(dir, "nested", "mirror.json");
    const json = '{"claudeAiOauth":{"accessToken":"m","expiresAt":1}}';

    writeKeychainMirror(json + "\n", mirrorPath);
    expect(readKeychainMirror(mirrorPath)).toBe(json);
    expect(fs.statSync(mirrorPath).mode & 0o777).toBe(0o600);

    // 内容不変なら書き直さない（mtime 据え置き = churn しない）。
    const before = fs.statSync(mirrorPath).mtimeMs;
    writeKeychainMirror(json, mirrorPath);
    expect(fs.statSync(mirrorPath).mtimeMs).toBe(before);

    expect(readKeychainMirror(path.join(dir, "missing.json"))).toBeNull();
  });

  test("Keychain 系候補が有効なら file の期限切れ refresh は裏で行い応答を待たせない", async () => {
    let refreshCalls = 0;
    let refreshResolve: (() => void) | null = null;
    const attempted: string[] = [];
    const resolved = await withClaudeOAuthCredential(
      async (token) => {
        attempted.push(token);
        return { kind: "success" as const, value: "ok" };
      },
      {
        candidates: [
          { token: "kc-valid", expiresAtMs: 9_000, source: "keychain" },
          { token: "file-expired", expiresAtMs: 500, source: "file" },
        ],
        refreshFile: () =>
          new Promise((resolve) => {
            refreshCalls += 1;
            refreshResolve = () => resolve({ accessToken: "healed", expiresAtMs: 9_999 });
          }),
        now: () => 1_000,
      },
    );

    // refresh の完了を待たずに Keychain 候補で応答している（延命は裏で走行中）。
    expect(resolved?.value).toBe("ok");
    expect(resolved?.credential.token).toBe("kc-valid");
    expect(attempted).toEqual(["kc-valid"]);
    expect(refreshCalls).toBe(1);
    refreshResolve?.();
  });

  test("Keychain 系候補も期限切れなら file refresh を待ってから試行する", async () => {
    const attempted: string[] = [];
    const resolved = await withClaudeOAuthCredential(
      async (token) => {
        attempted.push(token);
        return token === "healed"
          ? { kind: "success" as const, value: "ok" }
          : { kind: "failure" as const };
      },
      {
        candidates: [
          { token: "mirror-expired", expiresAtMs: 700, source: "keychain-mirror" },
          { token: "file-expired", expiresAtMs: 500, source: "file" },
        ],
        refreshFile: async () => ({ accessToken: "healed", expiresAtMs: 9_999 }),
        now: () => 1_000,
      },
    );

    expect(resolved?.value).toBe("ok");
    expect(attempted[0]).toBe("healed");
  });

  test("401以外の失敗では refresh token を回さない", async () => {
    let refreshCalls = 0;
    const resolved = await withClaudeOAuthCredential(
      async () => ({ kind: "failure" as const }),
      {
        candidates: [{ token: "valid", expiresAtMs: 5_000_000, source: "file" }],
        refreshFile: async () => {
          refreshCalls += 1;
          return { accessToken: "unused", expiresAtMs: 9_999 };
        },
        now: () => 1_000,
      },
    );

    expect(resolved).toBeNull();
    expect(refreshCalls).toBe(0);
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

  test("claudeSessionId フィールドの往復と旧形式メタの後方互換", () => {
    const base = makeTempDir("metastore-claude-session");
    const store = new SessionMetadataStore(base);
    store.put({ name: "cla", cwd: "/tmp/l", createdAt: 2, claudeSessionId: "sid-1" });
    expect(fs.readFileSync(path.join(base, "cla.json"), "utf8")).toBe(
      '{"claudeSessionId":"sid-1","createdAt":2,"cwd":"/tmp/l","name":"cla"}',
    );
    expect(store.get("cla")).toEqual({
      name: "cla",
      cwd: "/tmp/l",
      createdAt: 2,
      claudeSessionId: "sid-1",
    });

    fs.writeFileSync(path.join(base, "old.json"), '{"createdAt":3,"cwd":"/tmp/old","name":"old"}');
    expect(store.get("old")).toEqual({ name: "old", cwd: "/tmp/old", createdAt: 3 });
  });

  test("providerSessionId と tmuxPaneId を往復し、provider + id で逆引きできる", () => {
    const store = new SessionMetadataStore(makeTempDir("metastore-provider-session"));
    store.put({
      name: "cdx",
      cwd: "/tmp/codex",
      createdAt: 4,
      agent: "codex",
      providerSessionId: "thread-123",
      tmuxPaneId: "%42",
    });

    expect(store.get("cdx")).toEqual({
      name: "cdx",
      cwd: "/tmp/codex",
      createdAt: 4,
      agent: "codex",
      providerSessionId: "thread-123",
      tmuxPaneId: "%42",
    });
    expect(store.findByProviderSessionId("codex", "thread-123")?.name).toBe("cdx");
    expect(store.findByProviderSessionId("claude", "thread-123")).toBeNull();
  });
});

// MARK: - Heartbeat（reaper daemon の判定権威ファイル）

describe("Heartbeat", () => {
  test("write → read 往復（内容の ts が正、event 付き）", () => {
    const dir = makeTempDir("heartbeat");
    writeHeartbeat(dir, "cs-a", { ts: 100, state: "active", event: "PreToolUse" });
    expect(readHeartbeat(dir, "cs-a")).toEqual({ ts: 100, state: "active", event: "PreToolUse" });
  });

  test("不在・壊れたファイルは null（呼び手が採番する）", () => {
    const dir = makeTempDir("heartbeat");
    expect(readHeartbeat(dir, "cs-none")).toBeNull();
    fs.writeFileSync(path.join(dir, "cs-broken"), "not json");
    expect(readHeartbeat(dir, "cs-broken")).toBeNull();
    fs.writeFileSync(path.join(dir, "cs-badstate"), JSON.stringify({ ts: 1, state: "??" }));
    expect(readHeartbeat(dir, "cs-badstate")).toBeNull();
  });

  test("bump は ts のみ更新し state を保持する（不在時は fallback）", () => {
    const dir = makeTempDir("heartbeat");
    writeHeartbeat(dir, "cs-a", { ts: 100, state: "active", event: "PreToolUse" });
    bumpHeartbeat(dir, "cs-a", 200, "engine-tick");
    expect(readHeartbeat(dir, "cs-a")).toEqual({ ts: 200, state: "active", event: "engine-tick" });
    bumpHeartbeat(dir, "cs-new", 300, "chat-open");
    expect(readHeartbeat(dir, "cs-new")).toEqual({ ts: 300, state: "idle", event: "chat-open" });
  });

  test("remove と list（tmp 残骸は list から除外）", () => {
    const dir = makeTempDir("heartbeat");
    writeHeartbeat(dir, "cs-a", { ts: 1, state: "idle" });
    writeHeartbeat(dir, "cs-b", { ts: 2, state: "idle" });
    fs.writeFileSync(path.join(dir, "cs-c.tmp-999"), "{}");
    expect(listHeartbeatSessions(dir)).toEqual(["cs-a", "cs-b"]);
    removeHeartbeat(dir, "cs-a");
    removeHeartbeat(dir, "cs-a"); // 二重削除は無害
    expect(listHeartbeatSessions(dir)).toEqual(["cs-b"]);
  });

  test("セッション名の検証（パス外書き込み拒否）", () => {
    const dir = makeTempDir("heartbeat");
    expect(() => writeHeartbeat(dir, "../evil", { ts: 1, state: "idle" })).toThrow();
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

  test("capturePane は折り返し行結合と取得行数を指定できる", async () => {
    const runner = new MockTmuxRunner(() => ok("joined\n"));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store: makeTempStore() });
    expect(await mgr.capturePane("s", { lines: 60, joinWrappedLines: true })).toBe("joined");
    expect(runner.recorded[0]).toEqual(["capture-pane", "-p", "-J", "-t", "s", "-S", "-60"]);
  });

  test("sendKeys/capturePane は記録済み tmux pane ID を直接 target にする", async () => {
    const store = makeTempStore();
    store.put({
      name: "s",
      cwd: "/tmp/s",
      createdAt: 0,
      tmuxPaneId: "%9",
    });
    const runner = new MockTmuxRunner(() => ok("pane\n"));
    const mgr = new TmuxSessionManager({ runner: runner.runner, store });

    await mgr.sendKeys("s", ["hello"], true);
    await mgr.capturePane("s", { lines: 10 });

    expect(runner.recorded[0]).toEqual(["send-keys", "-t", "%9", "-l", "--", "hello"]);
    expect(runner.recorded[1]).toEqual(["capture-pane", "-p", "-t", "%9", "-S", "-10"]);
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
    // updatedAt の権威はエントリの timestamp。mtime は逆転させて非依存を検証する。
    fs.writeFileSync(
      oldFile,
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"古い会話"}}\n',
    );
    fs.writeFileSync(
      newFile,
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-06-01T00:00:00Z","message":{"content":"新しい会話"}}\n',
    );
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(oldFile, future, future);

    const list = new ClaudeSessionStore(root).list();
    expect(list.map((s) => s.title)).toEqual(["新しい会話", "古い会話"]);
    expect(list[0]?.cwd).toBe("/tmp/proj");
    expect(list[0]?.sessionId).toBe("bbbbbbbb-0000-0000-0000-000000000000");
    expect(list[0]?.updatedAt).toBe(Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000));
  });

  test("resume の状態行追記（timestamp 無し）では updatedAt が動かない", () => {
    const root = makeTempDir("claude-sessions-reopen");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "aaaaaaaa-4444.jsonl");
    fs.writeFileSync(
      file,
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"会話"}}\n' +
        // `claude --resume` が開くだけで追記する状態行（mtime が進む実挙動の再現）。
        '{"type":"last-prompt"}\n{"type":"mode","mode":"normal"}\n{"type":"permission-mode"}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.updatedAt).toBe(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000));
  });

  test("状態行のみ（会話ゼロ）の transcript は updatedAt なしで最下位", () => {
    const root = makeTempDir("claude-sessions-empty");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "aaaaaaaa-5555.jsonl"),
      '{"type":"mode","mode":"normal"}\n{"type":"permission-mode"}\n',
    );
    fs.writeFileSync(
      path.join(slugDir, "bbbbbbbb-5555.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"実会話"}}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list.map((s) => s.sessionId)).toEqual(["bbbbbbbb-5555", "aaaaaaaa-5555"]);
    expect(list[1]?.updatedAt).toBeUndefined();
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

  test("lastMessage は最後の user/assistant テキストを ~80 字で返す（tool_result/状態行は skip）", () => {
    const root = makeTempDir("claude-sessions-preview");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "ffffffff-6666.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の質問"}}\n' +
        '{"type":"assistant","timestamp":"2026-01-01T00:01:00Z","message":{"content":[{"type":"thinking","thinking":"内心"},{"type":"text","text":"修正が完了しました。\\nテストも緑です。"}]}}\n' +
        // 末尾側: テキストを持たない行（tool_result のみの user 行 / 状態行）は skip される。
        '{"type":"user","timestamp":"2026-01-01T00:02:00Z","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"ok"}]}]}}\n' +
        '{"type":"mode","mode":"normal"}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.lastMessage).toBe("修正が完了しました。 テストも緑です。");
    expect(list[0]?.title).toBe("最初の質問");
    expect(list[0]?.updatedAt).toBe(Math.floor(Date.parse("2026-01-01T00:02:00Z") / 1000));
  });

  test("シェルモード記録は実行行を `!cmd` へ戻し、出力行（stdout/stderr）は採用しない", () => {
    const root = makeTempDir("claude-sessions-bash");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "iiiiiiii-9999.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"<bash-input>ls -la</bash-input>"}}\n' +
        '{"type":"user","timestamp":"2026-01-01T00:01:00Z","message":{"content":"<bash-stdout>total 0</bash-stdout><bash-stderr></bash-stderr>"}}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.lastMessage).toBe("!ls -la");
    expect(list[0]?.title).toBe("!ls -la");
  });

  test("harness 注入の task-notification / system-reminder / 画像寸法ノートは lastMessage に採用しない", () => {
    const root = makeTempDir("claude-sessions-harness");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "jjjjjjjj-1010.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"<system-reminder>\\nリマインダ\\n</system-reminder>\\n実際の質問"}}\n' +
        '{"type":"assistant","timestamp":"2026-01-01T00:01:00Z","message":{"content":[{"type":"text","text":"最後の実応答"}]}}\n' +
        '{"type":"user","timestamp":"2026-01-01T00:02:00Z","message":{"content":"[Image: original 1260x2736, displayed at 921x2000.]"}}\n' +
        '{"type":"user","timestamp":"2026-01-01T00:03:00Z","message":{"content":"<system-reminder>\\nだけ\\n</system-reminder>"}}\n' +
        '{"type":"user","timestamp":"2026-01-01T00:04:00Z","message":{"content":"<task-notification>\\n<task-id>a6cbe86f</task-id>\\n<status>completed</status>\\n</task-notification>"}}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.lastMessage).toBe("最後の実応答");
    expect(list[0]?.title).toBe("実際の質問");
    expect(list[0]?.updatedAt).toBe(Math.floor(Date.parse("2026-01-01T00:04:00Z") / 1000));
  });

  test("assistant text 末尾へ追記された harness 注入（停止境界の背景通知）は lastMessage から除去する", () => {
    const root = makeTempDir("claude-sessions-assistant-reminder");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    // 実データ形（2.1.251）: 本文 + "\n\n<system-reminder>\n…<task-notification>…<result>…</system-reminder>\n"
    const injected =
      "\\n\\n<system-reminder>\\nAgent a917aa8b1463e31d4 completed. Read the result at /tmp/a917.output — do not paste any of the output verbatim into your reply.\\n\\n" +
      "<task-notification>\\n<task-id>a917aa8b1463e31d4</task-id>\\n<status>completed</status>\\n<result>\\n# REFUTE — v1.2\\n</result>\\n</task-notification>\\n</system-reminder>\\n";
    fs.writeFileSync(
      path.join(slugDir, "kkkkkkkk-1111.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"実際の質問"}}\n' +
        // 本文 + 注入ブロック → 本文だけを採用する。
        `{"type":"assistant","timestamp":"2026-01-01T00:01:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Both checkers are running; I'll loop.${injected}"}]}}\n` +
        // 注入ブロックだけの text → 採用せず前の実応答へ遡る。
        '{"type":"assistant","timestamp":"2026-01-01T00:02:00Z","message":{"role":"assistant","content":[{"type":"text","text":"<system-reminder>\\nMonitor event:\\nprogress\\n</system-reminder>\\n"}]}}\n' +
        // 本文中の引用（行頭でない）には反応しない。
        '{"type":"assistant","timestamp":"2026-01-01T00:03:00Z","message":{"role":"assistant","content":[{"type":"text","text":"- `<system-reminder>…</system-reminder>` ブロックを除去"}]}}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.lastMessage).toBe("- `<system-reminder>…</system-reminder>` ブロックを除去");
    expect(list[0]?.title).toBe("実際の質問");

    // 末尾が注入だけの応答なら、本文付きの応答（注入は除去済み）へ遡る。
    const root2 = makeTempDir("claude-sessions-assistant-reminder-only");
    const slugDir2 = path.join(root2, "-tmp-proj2");
    fs.mkdirSync(slugDir2, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir2, "kkkkkkkk-2222.jsonl"),
      '{"type":"user","cwd":"/tmp/proj2","timestamp":"2026-01-01T00:00:00Z","message":{"content":"実際の質問"}}\n' +
        `{"type":"assistant","timestamp":"2026-01-01T00:01:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Both checkers are running; I'll loop.${injected}"}]}}\n` +
        '{"type":"assistant","timestamp":"2026-01-01T00:02:00Z","message":{"role":"assistant","content":[{"type":"text","text":"<system-reminder>\\nMonitor event:\\nprogress\\n</system-reminder>\\n"}]}}\n',
    );
    const list2 = new ClaudeSessionStore(root2).list();
    expect(list2[0]?.lastMessage).toBe("Both checkers are running; I'll loop.");
  });

  test("注入されたスキル本文は lastMessage/title に採用せず前後の実発話へ遡る", () => {
    const root = makeTempDir("claude-sessions-skill");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "hhhhhhhh-8888.jsonl"),
      // 先頭: slash 起動形式（"Base directory…" 前置）→ title に採用しない。
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","isMeta":true,"message":{"content":[{"type":"text","text":"Base directory for this skill: /tmp/s\\n\\n# S\\n\\nスキル本文"}]}}\n' +
        '{"type":"user","timestamp":"2026-01-01T00:01:00Z","message":{"content":"実際の質問"}}\n' +
        '{"type":"assistant","timestamp":"2026-01-01T00:02:00Z","message":{"content":[{"type":"text","text":"最後の実応答"}]}}\n' +
        // 末尾: Skill ツール起動形式（前置なし, isMeta+sourceToolUseID）→ lastMessage に採用しない。
        '{"type":"user","timestamp":"2026-01-01T00:03:00Z","isMeta":true,"sourceToolUseID":"toolu_01","message":{"content":[{"type":"text","text":"前置なしのスキル本文"}]}}\n',
    );
    const list = new ClaudeSessionStore(root).list();
    expect(list[0]?.lastMessage).toBe("最後の実応答");
    expect(list[0]?.title).toBe("実際の質問");
  });

  test("custom-title エントリ（/rename・hook 由来）が導出タイトルより優先される", () => {
    const root = makeTempDir("claude-sessions-custom-title");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "iiiiiiii-9999.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"長い最初の発話がそのままタイトルになってしまう従来挙動の確認用テキスト"}}\n' +
        '{"type":"custom-title","customTitle":"短い名前","sessionId":"iiiiiiii-9999"}\n',
    );
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("短い名前");
  });

  test("custom-title は後勝ちで、解除（空文字）なら ai-title → 導出タイトルへ戻る", () => {
    const root = makeTempDir("claude-sessions-title-order");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    const renamed = path.join(slugDir, "jjjjjjjj-9999.jsonl");
    fs.writeFileSync(
      renamed,
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の発話"}}\n' +
        '{"type":"custom-title","customTitle":"旧名","sessionId":"jjjjjjjj-9999"}\n' +
        '{"type":"custom-title","customTitle":"新名","sessionId":"jjjjjjjj-9999"}\n',
    );
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("新名");

    // 解除エントリ: ai-title があればそちら、無ければ従来導出へ。
    fs.appendFileSync(renamed, '{"type":"custom-title","customTitle":"","sessionId":"jjjjjjjj-9999"}\n');
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("最初の発話");
    fs.appendFileSync(renamed, '{"type":"ai-title","aiTitle":"AI生成タイトル","sessionId":"jjjjjjjj-9999"}\n');
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("AI生成タイトル");
  });

  test("ai-title は custom-title が無いときのフォールバックとして使われる", () => {
    const root = makeTempDir("claude-sessions-ai-title");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "kkkkkkkk-9999.jsonl"),
      '{"type":"ai-title","aiTitle":"要約タイトル","sessionId":"kkkkkkkk-9999"}\n' +
        '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の発話"}}\n' +
        '{"type":"custom-title","customTitle":"ユーザー命名","sessionId":"kkkkkkkk-9999"}\n',
    );
    // custom-title があれば ai-title より優先。
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("ユーザー命名");
  });

  test("hasProviderTitle は明示タイトル（ai-title/custom-title）の有無を表す（title-refresh）", () => {
    const root = makeTempDir("claude-sessions-has-provider-title");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "nnnnnnnn-9999.jsonl");
    // 会話直後: 最初の発話だけ = 仮タイトル。iOS はここで打ち切らない。
    fs.writeFileSync(
      file,
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の発話"}}\n',
    );
    expect(new ClaudeSessionStore(root).list()[0]?.hasProviderTitle).toBe(false);

    // CLI が AI タイトルを書いた時点で true。
    fs.appendFileSync(file, '{"type":"ai-title","aiTitle":"AI生成タイトル","sessionId":"nnnnnnnn-9999"}\n');
    const withAiTitle = new ClaudeSessionStore(root).list()[0];
    expect(withAiTitle?.hasProviderTitle).toBe(true);
    expect(withAiTitle?.title).toBe("AI生成タイトル");
  });

  test("同一 sessionId が複数 slug に在っても会話本体の側 1 行へ畳む（duplicate-transcript）", () => {
    const root = makeTempDir("claude-sessions-duplicate");
    const worktreeSlug = path.join(root, "-tmp-proj--claude-worktrees-1");
    const repoSlug = path.join(root, "-tmp-proj");
    fs.mkdirSync(worktreeSlug, { recursive: true });
    fs.mkdirSync(repoSlug, { recursive: true });
    // worktree 削除後 resume で本体は repo ルートへ移設され、worktree 側には状態行だけ残る。
    fs.writeFileSync(
      path.join(worktreeSlug, "oooooooo-9999.jsonl"),
      '{"type":"ai-title","aiTitle":"残骸のタイトル","sessionId":"oooooooo-9999"}\n' +
        '{"type":"mode","mode":"normal","sessionId":"oooooooo-9999"}\n',
    );
    fs.writeFileSync(
      path.join(repoSlug, "oooooooo-9999.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の発話"}}\n' +
        '{"type":"ai-title","aiTitle":"本体のタイトル","sessionId":"oooooooo-9999"}\n',
    );

    const list = new ClaudeSessionStore(root).list();
    expect(list.length).toBe(1);
    expect(list[0]?.cwd).toBe("/tmp/proj");
    expect(list[0]?.title).toBe("本体のタイトル");
    // 残骸ではなく本体の jsonl を返す（検索・タブ名同期・再移設の対象）。
    expect(new ClaudeSessionStore(root).transcriptPath("oooooooo-9999"))
      .toBe(path.join(repoSlug, "oooooooo-9999.jsonl"));
  });

  test("末尾直近数行より上に埋まった custom-title も深掘りで拾う（早期打ち切りの補完）", () => {
    const root = makeTempDir("claude-sessions-title-deep");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "mmmmmmmm-9999.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の発話"}}\n' +
        '{"type":"custom-title","customTitle":"埋まった命名","sessionId":"mmmmmmmm-9999"}\n' +
        // この2行で updatedAt/lastMessage が即確定し後方スキャンが打ち切られる。
        '{"type":"user","timestamp":"2026-01-01T00:01:00Z","message":{"content":"続きの質問"}}\n' +
        '{"type":"assistant","timestamp":"2026-01-01T00:02:00Z","message":{"content":[{"type":"text","text":"応答"}]}}\n',
    );
    expect(new ClaudeSessionStore(root).list()[0]?.title).toBe("埋まった命名");
  });

  test("transcriptTitle は明示タイトル優先で 1 発解決する（herdr タブ同期用）", () => {
    const root = makeTempDir("claude-sessions-title-helper");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "llllllll-9999.jsonl");
    fs.writeFileSync(
      file,
      '{"type":"user","cwd":"/tmp/proj","timestamp":"2026-01-01T00:00:00Z","message":{"content":"最初の発話"}}\n',
    );
    expect(transcriptTitle(file)).toBe("最初の発話");
    fs.appendFileSync(file, '{"type":"custom-title","customTitle":"命名済み","sessionId":"llllllll-9999"}\n');
    expect(transcriptTitle(file)).toBe("命名済み");
  });

  test("lastMessage が無い（状態行のみ）transcript では省略される", () => {
    const root = makeTempDir("claude-sessions-preview-none");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "gggggggg-7777.jsonl"), '{"type":"mode","mode":"normal"}\n');
    expect(new ClaudeSessionStore(root).list()[0]?.lastMessage).toBeUndefined();
  });

  test("cwdFromSlug は lossy 復元（空は /）", () => {
    expect(cwdFromSlug("-Users-me-dev")).toBe("/Users/me/dev");
    expect(cwdFromSlug("")).toBe("/");
  });

  test("transcriptPath は projects root から会話 jsonl を探す", () => {
    const root = makeTempDir("claude-sessions-path");
    const slugDir = path.join(root, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "eeeeeeee-3333.jsonl");
    fs.writeFileSync(file, '{"type":"user","message":{"content":"x"}}\n');
    expect(new ClaudeSessionStore(root).transcriptPath("eeeeeeee-3333")).toBe(file);
    expect(new ClaudeSessionStore(root).transcriptPath("missing")).toBeNull();
  });
});

// MARK: - session_search

describe("harnessReminder", () => {
  const injected = "<system-reminder>\nAgent x completed.\n\n<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<result>\n# report\n</result>\n</task-notification>\n</system-reminder>\n";

  test("assistant text 末尾の注入ブロックを落とし、前の空行も残さない", () => {
    expect(stripInjectedReminderBlocks(`本文。\n\n${injected}`)).toBe("本文。");
  });

  test("複数ブロックの間の本文を段落区切り 1 つで保つ", () => {
    const text = `A\n\n<system-reminder>\nMonitor event:\nx\n</system-reminder>\n\nB\n\n<system-reminder>\nMonitor event:\ny\n</system-reminder>\n`;
    expect(stripInjectedReminderBlocks(text)).toBe("A\n\nB");
  });

  test("<result> に同じ書式が引用されても入れ子として外側まで落とす", () => {
    const text = "本文。\n\n<system-reminder>\nAgent x completed.\n<task-notification>\n<result>\n引用:\n<system-reminder>\nこの形\n</system-reminder>\nです。\n</result>\n</task-notification>\n</system-reminder>\n\n続き。";
    expect(stripInjectedReminderBlocks(text)).toBe("本文。\n\n続き。");
  });

  test("不一致の閉じ行 </security-reminder> でも閉じ、閉じが無ければ末尾まで落とす", () => {
    expect(stripInjectedReminderBlocks("前。\n\n<system-reminder>\nAgent y completed.\n</security-reminder>\n後。")).toBe("前。\n\n後。");
    expect(stripInjectedReminderBlocks("前。\n\n<system-reminder>\nAgent z completed.\n<result>\n切れた")).toBe("前。");
  });

  test("fence 内の例示・文中の引用・行末の開きタグには反応せず、本文の空行も触らない", () => {
    const fenced = "書式:\n\n```\n<system-reminder>\nMonitor event:\nx\n</system-reminder>\n```\n\n以上。";
    expect(stripInjectedReminderBlocks(`${fenced}\n\n${injected}`)).toBe(fenced);
    const quoted = "- `<system-reminder>…</system-reminder>` ブロックを除去";
    expect(stripInjectedReminderBlocks(quoted)).toBe(quoted);
    expect(stripInjectedReminderBlocks("末尾に開きタグだけ\n<system-reminder>")).toBe("末尾に開きタグだけ\n<system-reminder>");
    const body = "見出し\n\n\n\n```\nl1\n\n\n\nl2\n```";
    expect(stripInjectedReminderBlocks(`${body}\n\n\n${injected}\n\n末尾。\n`)).toBe(`${body}\n\n末尾。\n`);
  });

  test("ブロック内の \\r 付き行（Monitor 中継の進捗バー等）でも閉じ行を見失わず続きを残す", () => {
    const text = "監視中です。\n\n<system-reminder>\nMonitor event:\n[####  ] 40%\r\n</system-reminder>\n\nビルドが通りました。";
    expect(stripInjectedReminderBlocks(text)).toBe("監視中です。\n\nビルドが通りました。");
    expect(stripInjectedReminderBlocks("前\r\n\n<system-reminder>\nx\n</system-reminder>\n後")).toBe("前\r\n\n後");
  });

  test("CRLF で書かれた注入ブロックも本体で比較して除去し、\\r 付きの fence 行も fence として扱う", () => {
    expect(stripInjectedReminderBlocks("a\r\n\r\n<system-reminder>\r\nnote\r\n</system-reminder>\r\n\r\ncontinuation")).toBe("a\r\n\ncontinuation");
    const fenced = "```\r\n<system-reminder>\nx\ny";
    expect(stripInjectedReminderBlocks(fenced)).toBe(fenced);
  });

  test("fence は CommonMark 規則で追う（4 連内の ``` は閉じない / ~~~ は ``` を閉じない / 閉じ行の info string 不可）", () => {
    const nested = "書式:\n\n````\n```\n````\n\n続き。";
    expect(stripInjectedReminderBlocks(`${nested}\n\n${injected}`)).toBe(nested);
    const cross = "```\ncode\n~~~\nmore\n```\n\n以上。";
    expect(stripInjectedReminderBlocks(`${cross}\n\n${injected}`)).toBe(cross);
    const info = "```swift\nlet a = 1\n```\n\n以上。";
    expect(stripInjectedReminderBlocks(`${info}\n\n${injected}`)).toBe(info);
    // 開いたままの fence の後ろは対象外（停止境界ではモデルの fence は閉じている前提）。
    const unclosed = "```\ncode";
    expect(stripInjectedReminderBlocks(`${unclosed}\n\n${injected}`)).toBe(`${unclosed}\n\n${injected}`);
  });

  test("注入だけの text は空になり、user 形の <system-reminder> は最短一致で落とす", () => {
    expect(stripInjectedReminderBlocks(injected)).toBe("");
    expect(stripReminderTagBlocks("質問<system-reminder>\nメモ\n</system-reminder>です")).toBe("質問です");
    expect(stripReminderTagBlocks("<system-reminder> の言及だけ")).toBe("<system-reminder> の言及だけ");
  });
});

describe("searchClaudeSessions", () => {
  test("harness 注入（assistant 末尾の背景通知 / user のリマインダ）は検索対象にもスニペットにも出さない", () => {
    const root = makeTempDir("session-search-reminder");
    const slug = path.join(root, "-tmp-proj");
    fs.mkdirSync(slug, { recursive: true });
    fs.writeFileSync(
      path.join(slug, "rrrrrrrr-search.jsonl"),
      [
        JSON.stringify({ type: "user", cwd: "/tmp/proj", timestamp: "2026-01-01T00:00:00Z", message: { content: "調べて<system-reminder>\nリマインダ needle-user\n</system-reminder>" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "本文 needle-body\n\n<system-reminder>\nAgent x completed.\n<task-notification>\n<result>\nneedle-injected\n</result>\n</task-notification>\n</system-reminder>\n" }] } }),
      ].join("\n") + "\n",
    );
    const store = new ClaudeSessionStore(root);

    expect(searchClaudeSessions(store, "needle-injected").results).toEqual([]);
    expect(searchClaudeSessions(store, "needle-user").results).toEqual([]);
    const hit = searchClaudeSessions(store, "needle-body").results;
    expect(hit).toHaveLength(1);
    expect(hit[0]?.snippet).toBe("本文 needle-body");
  });

  test("注入ブロックや段落区切りを挟んだ複数語クエリも空白 1 つに畳んで照合する", () => {
    const root = makeTempDir("session-search-spacing");
    const slug = path.join(root, "-tmp-proj");
    fs.mkdirSync(slug, { recursive: true });
    fs.writeFileSync(
      path.join(slug, "ssssssss-search.jsonl"),
      [
        JSON.stringify({ type: "user", cwd: "/tmp/proj", timestamp: "2026-01-01T00:00:00Z", message: { content: "質問" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", content: [
          { type: "text", text: "前半 alpha\n\n<system-reminder>\nMonitor event:\nx\n</system-reminder>\n\nbeta 後半" },
          { type: "text", text: "<system-reminder>\nMonitor event:\ny\n</system-reminder>\n" },
          { type: "text", text: "gamma" },
        ] } }),
      ].join("\n") + "\n",
    );
    const hit = searchClaudeSessions(new ClaudeSessionStore(root), "alpha beta").results;
    expect(hit).toHaveLength(1);
    expect(hit[0]?.snippet).toBe("前半 alpha beta 後半 gamma");
    // クエリ側も同じ正規化: 全角スペース / 連続空白で区切っても同じヒット。
    expect(searchClaudeSessions(new ClaudeSessionStore(root), "alpha\u3000beta").results).toHaveLength(1);
    expect(searchClaudeSessions(new ClaudeSessionStore(root), "  alpha   beta ").results).toHaveLength(1);
  });

  test("全角スペースで区切られた本文も、半角/全角どちらのクエリでもヒットする", () => {
    const root = makeTempDir("session-search-ideographic-space");
    const slug = path.join(root, "-tmp-proj");
    fs.mkdirSync(slug, { recursive: true });
    fs.writeFileSync(
      path.join(slug, "iiiiiiii-search.jsonl"),
      JSON.stringify({ type: "user", cwd: "/tmp/proj", timestamp: "2026-01-01T00:00:00Z", message: { content: "マスコット\u3000しっぽ を直して" } }) + "\n",
    );
    const store = new ClaudeSessionStore(root);
    expect(searchClaudeSessions(store, "マスコット\u3000しっぽ").results).toHaveLength(1);
    expect(searchClaudeSessions(store, "マスコット しっぽ").results).toHaveLength(1);
  });

  test("user/assistant 本文を大文字小文字無視で検索し snippet 付きで updatedAt 降順に返す", () => {
    const root = makeTempDir("session-search");
    const slugA = path.join(root, "-Users-alice-proj-a");
    const slugB = path.join(root, "-Users-alice-proj-b");
    fs.mkdirSync(slugA, { recursive: true });
    fs.mkdirSync(slugB, { recursive: true });
    const oldFile = path.join(slugA, "aaaaaaaa-search.jsonl");
    const newFile = path.join(slugB, "bbbbbbbb-search.jsonl");
    fs.writeFileSync(
      oldFile,
      [
        JSON.stringify({ type: "user", cwd: "/Users/alice/proj-a", timestamp: "2026-01-01T00:00:00Z", message: { content: "Please inspect Approval flow" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:01:00Z", message: { content: [{ type: "tool_use", input: "Approval hidden" }] } }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      newFile,
      [
        JSON.stringify({ type: "assistant", cwd: "/Users/alice/proj-b", timestamp: "2026-06-01T00:00:00Z", message: { content: [{ type: "text", text: "The approval search path is ready" }] } }),
        JSON.stringify({ type: "tool_result", message: { content: "approval should not count" } }),
      ].join("\n") + "\n",
    );

    const response = searchClaudeSessions(new ClaudeSessionStore(root), "approval", { limit: 10 });

    expect(response.results.map((r) => r.sessionId)).toEqual(["bbbbbbbb-search", "aaaaaaaa-search"]);
    expect(response.results[0]?.snippet).toContain("approval search path");
    expect(response.results[1]?.title).toBe("Please inspect Approval flow");
    expect(response.stats.truncated).toBe(false);
  });

  test("limit・fileCountLimit・timeBudget で打ち切る", () => {
    const root = makeTempDir("session-search-limits");
    const slug = path.join(root, "-tmp-proj");
    fs.mkdirSync(slug, { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(
        path.join(slug, `s${i}.jsonl`),
        JSON.stringify({ type: "user", cwd: "/tmp/proj", message: { content: `needle ${i}` } }) + "\n",
      );
    }

    const limited = searchClaudeSessions(new ClaudeSessionStore(root), "needle", { limit: 1 });
    expect(limited.results).toHaveLength(1);

    const fileCapped = searchClaudeSessions(new ClaudeSessionStore(root), "needle", { fileCountLimit: 1 });
    expect(fileCapped.stats.truncated).toBe(true);
    expect(fileCapped.stats.scannedFiles).toBe(1);

    let now = 1000;
    const timed = searchClaudeSessions(new ClaudeSessionStore(root), "needle", {
      nowMs: () => {
        now += 1000;
        return now;
      },
      timeBudgetMs: 1,
    });
    expect(timed.stats.truncated).toBe(true);
  });
});

// MARK: - ChatTailController（添付抽出の純ロジック）

describe("ChatTailController.attachmentImagePaths", () => {
  test("引用・非引用・Tailii upload 形式の画像パスを重複なく抽出する", () => {
    const text =
      '見て @"/tmp/my photo.png" と @/tmp/shot.jpeg と @/tmp/doc.pdf と ' +
      '/Users/alice/.tailii/uploads/img-ABCD1234.jpg と @"/tmp/my photo.png"';
    expect(ChatTailController.attachmentImagePaths(text)).toEqual([
      "/tmp/my photo.png",
      "/tmp/shot.jpeg",
      "/Users/alice/.tailii/uploads/img-ABCD1234.jpg",
    ]);
  });

  test("通常の裸画像パスは添付と誤認しない", () => {
    expect(ChatTailController.attachmentImagePaths("参照 /tmp/diagram.png")).toEqual([]);
  });

  test("画像パスが無ければ空", () => {
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

describe("resolveHostDisplayName", () => {
  test("darwin は scutil ComputerName を第一候補にする（日本語・空白可）", () => {
    expect(
      resolveHostDisplayName({
        platform: "darwin",
        hostname: () => "alices-mac-mini.local",
        scutilComputerName: () => "アリスの Mac mini\n",
      }),
    ).toBe("アリスの Mac mini");
  });

  test("darwin で scutil 失敗時は hostname の .local を落としてフォールバックする", () => {
    expect(
      resolveHostDisplayName({
        platform: "darwin",
        hostname: () => "alices-mac-mini.local",
        scutilComputerName: () => {
          throw new Error("scutil not found");
        },
      }),
    ).toBe("alices-mac-mini");
  });

  test("linux は hostname を使う（.local 無しはそのまま）", () => {
    expect(
      resolveHostDisplayName({
        platform: "linux",
        hostname: () => "build-server",
        scutilComputerName: () => "unused",
      }),
    ).toBe("build-server");
  });

  test("空しか得られなければ undefined（hello から hostName を省略）", () => {
    expect(
      resolveHostDisplayName({
        platform: "linux",
        hostname: () => "  ",
        scutilComputerName: () => "unused",
      }),
    ).toBeUndefined();
  });
});

describe("login-code 画面判定 / submitLoginCode（仮想時計）", () => {
  const promptScreen = [
    "❯ /login",
    "  Login",
    "  Browser didn't open? Use the url below to sign in (c to copy)",
    "https://claude.com/cai/oauth/authorize?code=true",
    "  Paste code here if prompted >",
    "  Esc to cancel",
  ].join("\n");
  const echoed = (code: string) =>
    promptScreen.replace("  Paste code here if prompted >", `  Paste code here if prompted > ****${code.slice(-6)}`);
  const retryScreen = "  Login\n  OAuth error: Request failed with status code 400\n  Press Enter to retry.\n  Esc to cancel";
  const methodScreen = "  Login\n  Select login method:\n  ❯ 1. Claude account with subscription\n    2. Anthropic Console account\n  Esc to cancel";
  const acceptedScreen = "  ⎿  Login successful\n────────\n❯ \n────────\n  ⏸ manual mode on";
  const pendingScreen = "  Login\n  Signing in…\n  Esc to cancel";

  test("本文の引用（フッター無し / 末尾から遠い）では /login フロー中と判定しない", () => {
    const quoted = "⏺ /login の画面では\n  Select login method:\n  と出て、下に Paste code here if prompted と表示されます\n" +
      "❯ \n  ⏸ manual mode on";
    expect(screenInLoginFlow(quoted)).toBe(false);
    expect(screenHasLoginCodePrompt(quoted)).toBe(false);
    const stale = promptScreen + "\n" + "⏺ 本文\n".repeat(14) + "❯ \n  ⏸ manual mode on";
    expect(screenInLoginFlow(stale)).toBe(false);
    expect(screenInLoginFlow(methodScreen)).toBe(true);
    expect(screenInLoginFlow(retryScreen)).toBe(true);
  });

  test("受理は陽性証拠（Login successful / 入力欄の罫線ペア）でだけ判定し、方式選択や交換中は受理にしない", () => {
    expect(loginCodeScreenState(acceptedScreen)).toBe("accepted");
    expect(loginCodeScreenState("────────\n❯ \n────────\n  ⏸ manual mode on")).toBe("accepted");
    expect(loginCodeScreenState(methodScreen)).toBe("method");
    expect(loginCodeScreenState(pendingScreen)).toBe("pending");
    expect(loginCodeScreenState(retryScreen)).toBe("retry");
    expect(loginCodeScreenState(promptScreen)).toBe("prompt");
  });

  /** 仮想時計 + 画面シナリオで submitLoginCode を直接回す。 */
  function makeOps(frames: string[], options: { swallowEnters?: number } = {}) {
    let clock = 0;
    let swallow = options.swallowEnters ?? 0;
    let cursor = 0;
    let typed = "";
    let entered = false;
    const sent: string[] = [];
    const ops = {
      capture: async () => {
        if (!entered) return typed.length > 0 ? echoed(typed) : promptScreen;
        const frame = frames[Math.min(cursor, frames.length - 1)] ?? pendingScreen;
        cursor += 1;
        return frame;
      },
      sendLiteral: async (text: string) => { typed += text; sent.push(`literal:${text}`); },
      sendEnter: async () => {
        sent.push("enter");
        if (swallow > 0) swallow -= 1;
        else entered = true;
      },
      delayMs: 0,
      pollMs: 0,
      settleMs: 1_000,
      now: () => { clock += 400; return clock; },
    };
    return { ops, sent };
  }

  test("retry は settle 窓内なら CR を追加で撃たずに理由つきで throw", async () => {
    const { ops, sent } = makeOps([pendingScreen, retryScreen]);
    await expect(submitLoginCode("AbC#123", ops)).rejects.toThrow(/status code 400/);
    expect(sent).toEqual(["literal:AbC#123", "enter"]);
  });

  test("CR が飲まれてコード欄が残るときだけ settle 後に CR を再送し、受理で終える", async () => {
    // 1 発目の CR は飲まれる（画面は prompt のまま）→ settle 経過 → 再キャプチャ prompt → 2 発目 → 受理。
    const { ops, sent } = makeOps([acceptedScreen], { swallowEnters: 1 });
    await submitLoginCode("AbC#123", ops);
    expect(sent).toEqual(["literal:AbC#123", "enter", "enter"]);
  });

  test("交換中（pending）が settle×2 を超えても確定しなければ throw し、方式選択へ戻れば別の理由で throw", async () => {
    const { ops } = makeOps([pendingScreen]);
    await expect(submitLoginCode("AbC#123", ops)).rejects.toThrow(/確認できませんでした/);
    const back = makeOps([pendingScreen, methodScreen]);
    await expect(submitLoginCode("AbC#123", back.ops)).rejects.toThrow(/方式選択に戻りました/);
    expect(back.sent.filter((entry) => entry === "enter")).toHaveLength(1);
  });
});

describe("login-code 成功後の継続待ち（Login successful. Press Enter to continue…）", () => {
  const continueScreen = "❯ /login\n──────\n  Login\n  Logged in as n***@example.com\n  Login successful. Press Enter to continue…";
  const acceptedScreen = "  ⎿  Login successful\n────────\n❯ \n────────\n  ⏸ manual mode on";
  const promptScreen = "  Login\nhttps://claude.com/cai/oauth/authorize?code=true\n  Paste code here if prompted >\n  Esc to cancel";

  test("継続待ちは continue に分類され、chat 注入の門番にも掛かる", () => {
    expect(loginCodeScreenState(continueScreen)).toBe("continue");
    expect(screenInLoginFlow(continueScreen)).toBe(true);
    // 完了後の transcript 行（⎿ Login successful）+ 入力欄は accepted。
    expect(loginCodeScreenState(acceptedScreen)).toBe("accepted");
  });

  test("submitLoginCode: 継続待ちを Enter で閉じて入力欄へ戻れば受理（失敗にしない）", async () => {
    const sent: string[] = [];
    let clock = 0;
    let phase = 0; // 0=prompt(echo) 1=continue 2=accepted
    let typed = "";
    const ops = {
      capture: async () => {
        if (phase === 0) return typed.length > 0
          ? promptScreen.replace("  Paste code here if prompted >", `  Paste code here if prompted > ****${typed.slice(-6)}`)
          : promptScreen;
        return phase === 1 ? continueScreen : acceptedScreen;
      },
      sendLiteral: async (text: string) => { typed += text; sent.push(`literal:${text}`); },
      sendEnter: async () => { sent.push("enter"); phase += 1; },
      delayMs: 0, pollMs: 0, settleMs: 1_000,
      now: () => { clock += 400; return clock; },
    };
    await submitLoginCode("AbC#123", ops);
    // コード確定の Enter + 継続待ちを閉じる Enter。
    expect(sent).toEqual(["literal:AbC#123", "enter", "enter"]);
  });
});
