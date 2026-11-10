import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeApiFederation, type ApiFederationConfiguration } from "../src/services/claudeApiFederation.js";
import { runClaudeApiDelegate } from "../src/services/claudeApiDelegate.js";
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from "../src/protocol.js";

let directory: string;
let now: number;
let config: ApiFederationConfiguration;
const signal = () => new AbortController().signal;
const jwt = (value: number, id = "first"): string => [Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url"),
  Buffer.from(JSON.stringify({ iss: "https://idp.example.test", exp: value + 3600, jti: id })).toString("base64url"), "testsignature"].join(".");
const response = (token = "test-short-lived-access-token-first") => Response.json({ access_token: token, token_type: "Bearer", expires_in: 1800 });
function service(fetcher: typeof fetch = vi.fn()) { return new ClaudeApiFederation({ configDirectory: join(directory, "config"), cacheDirectory: join(directory, "cache"), env: {}, fetcher, now: () => now }); }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tailii-wif-")); now = 1_800_000_000;
  config = { profile: "tailii", organizationId: "00000000-0000-0000-0000-000000000001", federationRuleId: "fdrl_test", serviceAccountId: "svac_test", workspaceId: "wrkspc_test", identityTokenPath: join(directory, "identity.jwt") };
  await writeFile(config.identityTokenPath, jwt(now));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Claude APIのIDフェデレーション", () => {
  it("一覧にはプロファイルの識別情報だけを載せ、秘密を読んだり認証要求を送ったりしない", async () => {
    const fetcher = vi.fn(); const auth = service(fetcher);
    const profile = await auth.create(config);
    const list = await auth.list();
    expect(list.profiles).toEqual([profile]);
    expect(JSON.stringify(list)).not.toContain(jwt(now));
    expect(JSON.stringify(list)).not.toContain(config.identityTokenPath);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await stat(join(directory, "config", "configs", "tailii.json")).then((s) => s.mode & 0o777)).toBe(0o600);
  });

  it("選んだ組織・ルール・ワークスペースのJWTを固定エンドポイントで交換し、短期トークンを再利用する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()); const auth = service(fetcher);
    const profile = await auth.create(config);
    const checked = await auth.check(profile, signal());
    expect(checked).toEqual({ authenticated: true, expiresAt: now + 1800 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(request.redirect).toBe("error");
    expect(request.headers).not.toHaveProperty("x-api-key");
    expect(JSON.parse(request.body)).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt(now),
      organization_id: config.organizationId, federation_rule_id: config.federationRuleId, service_account_id: config.serviceAccountId, workspace_id: config.workspaceId });
    expect(JSON.stringify(checked)).not.toContain("access-token");
    await auth.token(profile, signal());
    // engineを作り直しても、同じjtiを再交換せず保護済みの専用キャッシュを読む。
    await service(fetcher).token(profile, signal());
    const alias = await auth.create({ ...config, profile: "same-settings" });
    await service(fetcher).token(alias, signal());
    expect(fetcher).toHaveBeenCalledOnce();
    const cache = (await readdir(join(directory, "cache"))).find((name) => name.endsWith(".json"))!;
    expect((await stat(join(directory, "cache", cache))).mode & 0o777).toBe(0o600);
  });

  it("期限前の更新でIDトークンファイルを読み直し、同時実行の交換を1回にする", async () => {
    const fetcher = vi.fn().mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return response(); });
    const first = service(fetcher); const profile = await first.create(config);
    await Promise.all([first.token(profile, signal()), service(fetcher).token(profile, signal())]);
    expect(fetcher).toHaveBeenCalledOnce();
    now += 1700;
    await writeFile(config.identityTokenPath, jwt(now, "rotated"));
    await first.token(profile, signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).assertion).toBe(jwt(now, "rotated"));
  });

  it("プロファイルの組織が変更されたら、別組織のトークンへ自動で切り替えない", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()); const auth = service(fetcher);
    const selected = await auth.create(config);
    await auth.token(selected, signal());
    const path = join(directory, "config", "configs", "tailii.json");
    const changed = JSON.parse(await readFile(path, "utf8")); changed.organization_id = "00000000-0000-0000-0000-000000000002";
    await writeFile(path, JSON.stringify(changed));
    await expect(auth.token(selected, signal())).rejects.toMatchObject({ code: "federation_profile_changed" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("APIキーなしで計数・生成を行い、各POSTにはBearerだけを付ける", async () => {
    const exchange = vi.fn().mockResolvedValueOnce(response()); const auth = service(exchange);
    const selection = await auth.create(config);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ input_tokens: 50 })).mockResolvedValueOnce(Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "回答" }], usage: { input_tokens: 50, output_tokens: 10 }, stop_reason: "end_turn" }));
    const result = await runClaudeApiDelegate({ apiKey: "", federation: selection, model: "claude-sonnet-5-5", prompt: "依頼", context: "", budgetCents: 50 }, signal(), fetcher, auth);
    expect(result.text).toBe("回答");
    expect(exchange).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) {
      expect(options.headers.authorization).toBe("Bearer test-short-lived-access-token-first");
      expect(options.headers).not.toHaveProperty("x-api-key");
      expect(options.body).not.toContain("access-token");
    }
  });

  it("認証失敗・期限切れ・未設定で、APIキーやSubscription認証へフォールバックしない", async () => {
    const exchange = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "sensitive-body" } }, { status: 401 }));
    const auth = service(exchange); const selection = await auth.create(config); const fetcher = vi.fn();
    await expect(runClaudeApiDelegate({ apiKey: "", federation: selection, model: "claude-sonnet-5-5", prompt: "依頼", context: "", budgetCents: 50 }, signal(), fetcher, auth)).rejects.toMatchObject({ code: "federation_auth_failed", message: "federation_auth_failed" });
    expect(fetcher).not.toHaveBeenCalled(); expect(exchange).toHaveBeenCalledOnce();
    await writeFile(config.identityTokenPath, jwt(now - 4000));
    expect(await auth.check(selection, signal())).toEqual({ authenticated: false, error: "federation_identity_expired" });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("プロファイルの上書きとパストラバーサル、別のAPIホストを拒否する", async () => {
    const auth = service(); const profile = await auth.create(config);
    await expect(auth.create(config)).rejects.toMatchObject({ code: "federation_profile_exists" });
    await expect(auth.create({ ...config, profile: "../escape" })).rejects.toMatchObject({ code: "federation_invalid_config" });
    await expect(auth.token({ ...profile, profile: "../escape" }, signal())).rejects.toMatchObject({ code: "federation_invalid_config" });
    const path = join(directory, "config", "configs", "tailii.json");
    const changed = JSON.parse(await readFile(path, "utf8")); changed.base_url = "https://attacker.example.test";
    await writeFile(path, JSON.stringify(changed));
    expect((await auth.list()).profiles).toEqual([]);
  });

  it("iPhoneへ返す設定・認証結果と、キーを含まない選択をワイヤーで往復できる", async () => {
    const auth = service(); const profile = await auth.create(config);
    const messages: ControlMessage[] = [
      { type: "api_delegate_options_response", v: 1, id: "options", supported: true, federation: { profiles: [profile] } },
      { type: "api_federation_check_request", v: 1, id: "check", selection: { profile: profile.profile, configurationHash: profile.configurationHash } },
      { type: "api_federation_check_response", v: 1, id: "check", status: { authenticated: true, expiresAt: now + 1800 } },
      { type: "api_federation_create_request", v: 1, id: "create", configuration: config },
      { type: "api_federation_create_response", v: 1, id: "create", profile },
    ];
    for (const message of messages) expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });
});
