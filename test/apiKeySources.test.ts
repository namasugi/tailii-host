import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiDelegateKeyStore, apiDelegateKeyStore } from "../src/services/apiDelegateKeyStore.js";
import { hostApiKey } from "../src/services/apiDelegateHostKeys.js";
import { resolveApiKeySource } from "../src/services/apiKeySource.js";
import { createApiDelegateHandlers } from "../src/engine/handlers/apiDelegate.js";
import { createClaudeApiUsageProvider } from "../src/services/claudeApiUsage.js";
import { createOpenAIApiUsageProvider } from "../src/services/openaiApiUsage.js";
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from "../src/protocol.js";
import type { HandlerContext } from "../src/engine/context.js";

const directories: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), "api-key-sources-")); directories.push(path); return path; }
const personal = "sk-ant-usr-test-only-not-a-real-secret";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("ホストで共通管理するAPIキーの取得元", () => {
  it("登録キーを専用の0700/0600領域に保存し、再起動後も読み出せるが上書きしない", () => {
    const path = join(temporary(), "keys"), store = new ApiDelegateKeyStore(path);
    store.create("claude", personal);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, "claude")).mode & 0o777).toBe(0o600);
    expect(new ApiDelegateKeyStore(path).load("claude")).toBe(personal);
    expect(() => store.create("claude", "sk-ant-usr-another-test-only-secret")).toThrow();
    expect(readFileSync(join(path, "claude"), "utf8")).toBe(personal);
    chmodSync(join(path, "claude"), 0o644);
    expect(store.load("claude")).toBeUndefined();
  });

  it("登録先のsymlinkと管理キー・OAuthトークンを拒否する", () => {
    const path = temporary(), target = join(path, "target");
    const store = new ApiDelegateKeyStore(target);
    for (const key of ["sk-ant-admin01-test-only-secret", "sk-ant-oat01-test-only-secret"]) expect(() => store.create("claude", key)).toThrow("invalid_key");
    const link = join(path, "link"); symlinkSync(path, link);
    expect(() => new ApiDelegateKeyStore(link).create("claude", personal)).toThrow("host_key_store_unavailable");
  });

  it("ファイルと任意の環境変数を読み、未検出・不正な指定では自動検出へ戻らない", () => {
    const path = join(temporary(), "key.txt"); writeFileSync(path, personal + "\n");
    expect(resolveApiKeySource({ mode: "file", path }, {})).toBe(personal);
    expect(hostApiKey("claude", {}, { mode: "file", path })).toBe(personal);
    expect(hostApiKey("claude", { TEAM_CLAUDE_KEY: personal }, { mode: "environment", environmentVariable: "TEAM_CLAUDE_KEY" })).toBe(personal);
    for (const source of [{ mode: "file", path: "/missing/key" }, { mode: "environment", environmentVariable: "MISSING" }, { mode: "disabled" }] as const) {
      expect(hostApiKey("claude", { ANTHROPIC_API_KEY: personal }, source)).toBeUndefined();
    }
    writeFileSync(path, "x".repeat(8193)); expect(resolveApiKeySource({ mode: "file", path }, {})).toBeUndefined();
    expect(resolveApiKeySource({ mode: "file", path: "relative/key" }, {})).toBeUndefined();
    expect(resolveApiKeySource({ mode: "environment", environmentVariable: "$(printenv)" }, {})).toBeUndefined();
  });

  it("キー登録の応答には成功可否だけを返し、推論を実行しない", async () => {
    const store = new ApiDelegateKeyStore(join(temporary(), "keys"));
    vi.spyOn(apiDelegateKeyStore, "create").mockImplementation((provider, key) => store.create(provider, key));
    vi.spyOn(apiDelegateKeyStore, "load").mockImplementation((provider) => store.load(provider));
    vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("CLAUDE_CONFIG_DIR", temporary());
    const run = vi.fn(), replies: ControlMessage[] = [];
    const ctx = { state: { negotiatedVersion: 1 }, writer: { write: (message: ControlMessage) => replies.push(message) } } as unknown as HandlerContext;
    const handler = createApiDelegateHandlers(run).api_delegate_key_register_request!;
    const message = { type: "api_delegate_key_register_request", v: 1, id: "register", provider: "claude", apiKey: personal } as const;
    await handler(message, ctx); await handler(message, ctx);
    expect(replies[0]).toMatchObject({ success: true });
    expect(replies[1]).toMatchObject({ success: false, error: "host_key_exists" });
    expect(JSON.stringify(replies)).not.toContain(personal);
    expect(run).not.toHaveBeenCalled();
    expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });

  it("利用額照会も指定したホスト環境変数を使い、キーの値を返さない", async () => {
    const now = () => new Date("2026-11-10T12:00:00Z");
    const claudeFetch = vi.fn().mockResolvedValue(Response.json({ data: [], has_more: false }));
    const openaiFetch = vi.fn().mockResolvedValue(Response.json({ data: [], has_more: false }));
    const claude = createClaudeApiUsageProvider({ env: { TEAM_COST_KEY: "sk-ant-admin01-test-only-secret" }, now, fetch: claudeFetch });
    const openai = createOpenAIApiUsageProvider({ env: { TEAM_COST_KEY: "sk-admin-test-only-secret-value" }, now, fetch: openaiFetch });
    const source = { mode: "environment", environmentVariable: "TEAM_COST_KEY" } as const;
    expect(await claude(source)).toHaveProperty("value.cost", "0");
    expect(await openai(source)).toHaveProperty("value.cost", "0");
    expect(await claude({ ...source, environmentVariable: "MISSING" })).toEqual({ error: "key_required" });
    expect(claudeFetch).toHaveBeenCalledOnce(); expect(openaiFetch).toHaveBeenCalledOnce();
  });
});
