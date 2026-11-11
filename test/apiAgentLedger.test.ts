// apiAgentLedger.test.ts — API 作業の利用額の台帳・キーの受け渡し・会話の記録のテスト。

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ApiAgentLedgerStore,
  emptyLedger,
  readTranscriptCostBaseline,
  summarizeLedger,
  turnCostFromCumulative,
} from "../src/apiAgent/ledger.js";
import { apiAgentWorkerEnvironment, resolveApiAgentKey } from "../src/apiAgent/keyEnvironment.js";
import { ApiAgentSessionStore } from "../src/apiAgent/sessionState.js";
import { parseApiAgentConfig, validApiAgentConfig } from "../src/apiAgent/config.js";
import { conversationHolders } from "../src/apiAgent/exclusivity.js";
import { makeTempDir } from "./helpers.js";

const CONV = "7b2c6a3f-ba60-45fd-89ae-cba51afaf7dc";
const USR_KEY = "sk-ant-usr01-" + "y".repeat(40);
const API_KEY = "sk-ant-api03-" + "x".repeat(40);
const CONFIG = { model: "claude-haiku-5-5", permissionMode: "default" as const, budget: { turnUsd: 0.5, conversationUsd: 5, maxTurns: 20 } };

describe("台帳", () => {
  test("cost-state の最後の totalCostUSD を基準にする（無ければ 0、ファイルが無ければ 0）", () => {
    const dir = makeTempDir("api-agent-baseline");
    const file = path.join(dir, `${CONV}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", message: { role: "user", content: "x" } }),
      JSON.stringify({ type: "cost-state", totalCostUSD: 0.0019 }),
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "cost-state", totalCostUSD: 0.0026 }),
      JSON.stringify({ type: "ai-title", aiTitle: "t" }),
    ].join("\n") + "\n");
    expect(readTranscriptCostBaseline(file)).toBe(0.0026);
    expect(readTranscriptCostBaseline(path.join(dir, "none.jsonl"))).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ type: "user" }) + "\n");
    expect(readTranscriptCostBaseline(file)).toBe(0);
  });

  test("ターンの額 = 結果の累計 − 基準（実測: 新規 0.001924 → 再開 0.002605 は差分 0.000681）", () => {
    expect(turnCostFromCumulative(0.001924, 0)).toBe(0.001924);
    expect(turnCostFromCumulative(0.00260507, 0.001923575)).toBe(0.000681);
    // 数え直し（累計が基準より小さい）は結果の値そのもの。基準不明も同じ。
    expect(turnCostFromCumulative(0.0004, 0.0026)).toBe(0.0004);
    expect(turnCostFromCumulative(0.0004, null)).toBe(0.0004);
  });

  test("集計: 結果を受け取れたターンだけ合計し、未確認は件数で分ける", () => {
    const ledger = emptyLedger(CONV);
    ledger.turns.push({ id: "a", startedAt: 1, status: "done", costUsd: 0.1 });
    ledger.turns.push({ id: "b", startedAt: 2, status: "unconfirmed" });
    ledger.turns.push({ id: "c", startedAt: 3, status: "done", costUsd: 0.25 });
    ledger.turns.push({ id: "d", startedAt: 4, status: "running" });
    expect(summarizeLedger(ledger)).toEqual({ totalUsd: 0.35, turns: 4, unconfirmedTurns: 1, lastTurnUsd: 0.25 });
  });

  test("保存・読み直し。前回のプロセスが残した running は利用額未確認へ。行数の上限を超えたら畳む", () => {
    const store = new ApiAgentLedgerStore(makeTempDir("api-agent-ledger"));
    const ledger = emptyLedger(CONV);
    for (let i = 0; i < 205; i += 1) ledger.turns.push({ id: `t${i}`, startedAt: i, status: i === 0 ? "unconfirmed" : "done", costUsd: i === 0 ? undefined : 0.01 });
    ledger.turns.push({ id: "live", startedAt: 999, status: "running" });
    store.save(ledger);
    const loaded = store.load(CONV);
    expect(loaded.turns.length).toBe(200);
    expect(loaded.foldedTurns).toBe(6);
    expect(loaded.foldedUnconfirmed).toBe(1);
    expect(store.settleOrphans(loaded, 1000)).toBe(true);
    expect(loaded.turns.at(-1)).toMatchObject({ id: "live", status: "unconfirmed", finishedAt: 1000 });
    const summary = summarizeLedger(loaded);
    expect(summary.turns).toBe(206);
    expect(summary.unconfirmedTurns).toBe(2);
    expect(summary.totalUsd).toBeCloseTo(2.04, 6);
    const stat = fs.statSync(path.join(store.directory, `${CONV}.json`));
    expect(stat.mode & 0o077).toBe(0);
  });

  test("会話 id 以外のファイル名は使わない", () => {
    const store = new ApiAgentLedgerStore(makeTempDir("api-agent-ledger-bad"));
    expect(() => store.save(emptyLedger("../../etc/passwd"))).toThrow();
  });
});

describe("キーの受け渡し", () => {
  const deps = (key: string | undefined) => ({
    hostApiKey: () => key,
    executionEnvironment: async () => ({}),
  });

  test("キーが無ければ no_api_key（別の認証へ切り替えない）", async () => {
    expect(await resolveApiAgentKey(undefined, deps(undefined))).toBe("no_api_key");
  });

  test("custom（端末からキー本体）・disabled は使わない", async () => {
    expect(await resolveApiAgentKey({ mode: "custom", apiKey: API_KEY }, deps(API_KEY))).toBe("unsupported_key_source");
    expect(await resolveApiAgentKey({ mode: "disabled" }, deps(API_KEY))).toBe("unsupported_key_source");
  });

  test("個人用キーにワークスペース ID があれば ANTHROPIC_CUSTOM_HEADERS で anthropic-workspace-id を付ける", async () => {
    expect(await resolveApiAgentKey({ mode: "automatic", workspaceId: "wrkspc_abc" }, deps(USR_KEY)))
      .toEqual({ secretEnv: { ANTHROPIC_API_KEY: USR_KEY, ANTHROPIC_CUSTOM_HEADERS: "anthropic-workspace-id: wrkspc_abc" } });
    // ワークスペースキーには付けない。
    expect(await resolveApiAgentKey({ mode: "automatic", workspaceId: "wrkspc_abc" }, deps(API_KEY)))
      .toEqual({ secretEnv: { ANTHROPIC_API_KEY: API_KEY } });
    expect(await resolveApiAgentKey({ mode: "automatic", workspaceId: "bad id" }, deps(USR_KEY))).toBe("unsupported_key_source");
  });

  test("作業プロセスの env: 許可した変数 + 秘密だけ。親の CLAUDE_CODE_* 等は渡さない。PATH は補う", () => {
    const env = apiAgentWorkerEnvironment(
      { HOME: "/Users/x", PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", ANTHROPIC_AUTH_TOKEN: "t", SECRET: "v" },
      { ANTHROPIC_API_KEY: API_KEY },
    );
    expect(env["HOME"]).toBe("/Users/x");
    expect(env["ANTHROPIC_API_KEY"]).toBe(API_KEY);
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["SECRET"]).toBeUndefined();
    expect(env["PATH"]!.split(":")[0]).toBe("/usr/bin");
    expect(env["PATH"]).toContain("/opt/homebrew/bin");
  });
});

describe("設定と会話の記録", () => {
  test("設定の値域（bypassPermissions・キー本体・上限超過は不可）", () => {
    expect(validApiAgentConfig(CONFIG)).toBe(true);
    expect(validApiAgentConfig({ ...CONFIG, permissionMode: "bypassPermissions" as never })).toBe(false);
    expect(validApiAgentConfig({ ...CONFIG, budget: { ...CONFIG.budget, turnUsd: 0 } })).toBe(false);
    expect(validApiAgentConfig({ ...CONFIG, budget: { ...CONFIG.budget, conversationUsd: 10_000 } })).toBe(false);
    expect(validApiAgentConfig({ ...CONFIG, budget: { ...CONFIG.budget, maxTurns: 1.5 } })).toBe(false);
    expect(parseApiAgentConfig({ ...CONFIG, keySource: { mode: "custom", apiKey: API_KEY } })).toBeNull();
    expect(parseApiAgentConfig({ ...CONFIG, keySource: { mode: "file", path: "~/k" } })).toEqual({ ...CONFIG, keySource: { mode: "file", path: "~/k" } });
  });

  test("会話の記録は 0600 で書き、読めないものは無視する", () => {
    const store = new ApiAgentSessionStore(makeTempDir("api-agent-sessions"));
    store.put({ name: "cs-a", conversationId: CONV, cwd: "/tmp/w", config: CONFIG, openedAt: 1 });
    fs.writeFileSync(path.join(store.directory, "broken.json"), "{");
    expect(store.all()).toEqual([{ name: "cs-a", conversationId: CONV, cwd: "/tmp/w", config: CONFIG, openedAt: 1 }]);
    expect(fs.statSync(path.join(store.directory, "cs-a.json")).mode & 0o077).toBe(0);
    expect(JSON.stringify(store.get("cs-a"))).not.toContain("sk-ant");
    store.remove("cs-a");
    expect(store.get("cs-a")).toBeNull();
  });

  test("登録簿で会話を掴んでいる生存プロセスを見つける", () => {
    const dir = makeTempDir("api-agent-peers");
    fs.writeFileSync(path.join(dir, "111.json"), JSON.stringify({ pid: 111, sessionId: CONV, name: "code0630" }));
    fs.writeFileSync(path.join(dir, "222.json"), JSON.stringify({ pid: 222, sessionId: CONV }));
    fs.writeFileSync(path.join(dir, "333.json"), JSON.stringify({ pid: 333, sessionId: "other" }));
    const alive = (pid: number) => pid !== 222;
    expect(conversationHolders(CONV, { dir, isPidAlive: alive })).toEqual([{ pid: 111, name: "code0630" }]);
    expect(conversationHolders(CONV, { dir, isPidAlive: alive, excludePids: new Set([111]) })).toEqual([]);
  });
});
