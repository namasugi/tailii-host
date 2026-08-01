import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_SKEW_MS,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  refreshClaudeCredentialFile,
  shouldRefreshClaudeCredential,
  type OAuthTokenRequester,
} from "../src/services/claudeCredentialRefresh.js";
import { makeTempDir } from "./helpers.js";

const NOW_MS = 1_800_000_000_000;

function writeCredentials(configDir: string): string {
  fs.mkdirSync(configDir, { recursive: true });
  const credentialsPath = path.join(configDir, ".credentials.json");
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({
      preservedTopLevel: true,
      claudeAiOauth: {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        expiresAt: NOW_MS - 1,
        refreshTokenExpiresAt: NOW_MS + 10_000,
        scopes: ["user:profile", "user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        preservedOauthField: "keep",
      },
    }),
    { mode: 0o600 },
  );
  return credentialsPath;
}

describe("Claude credentials file refresh", () => {
  it("期限5分前から更新対象にする", () => {
    expect(shouldRefreshClaudeCredential(null, NOW_MS)).toBe(false);
    expect(shouldRefreshClaudeCredential(NOW_MS + CLAUDE_OAUTH_REFRESH_SKEW_MS + 1, NOW_MS))
      .toBe(false);
    expect(shouldRefreshClaudeCredential(NOW_MS + CLAUDE_OAUTH_REFRESH_SKEW_MS, NOW_MS))
      .toBe(true);
    expect(shouldRefreshClaudeCredential(NOW_MS - 1, NOW_MS)).toBe(true);
  });

  it("Claude Code 互換ロック下で refresh token を回し、credentials を原子的に更新する", async () => {
    const base = makeTempDir("claude-refresh");
    const configDir = path.join(base, ".claude");
    const credentialsPath = writeCredentials(configDir);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const requester: OAuthTokenRequester = async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3_600,
          refresh_token_expires_in: 86_400,
          scope: "user:profile user:inference",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      refreshClaudeCredentialFile({
        credentialsPath,
        requester,
        now: () => NOW_MS,
      }),
    ).resolves.toEqual({
      accessToken: "access-new",
      expiresAtMs: NOW_MS + 3_600_000,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CLAUDE_OAUTH_TOKEN_ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
      client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
      scope: "user:profile user:inference",
    });

    const stored = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    expect(stored).toMatchObject({
      preservedTopLevel: true,
      claudeAiOauth: {
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiresAt: NOW_MS + 3_600_000,
        refreshTokenExpiresAt: NOW_MS + 86_400_000,
        scopes: ["user:profile", "user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        preservedOauthField: "keep",
      },
    });
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(configDir, ".oauth_refresh.lock"))).toBe(false);
    expect(fs.existsSync(`${fs.realpathSync(configDir)}.lock`)).toBe(false);
  });

  it("token endpoint が失敗したら credentials を一切変更しない", async () => {
    const base = makeTempDir("claude-refresh-fail");
    const credentialsPath = writeCredentials(path.join(base, ".claude"));
    const before = fs.readFileSync(credentialsPath);

    const result = await refreshClaudeCredentialFile({
      credentialsPath,
      requester: async () => new Response("unauthorized", { status: 401 }),
      now: () => NOW_MS,
    });

    expect(result).toBeNull();
    expect(fs.readFileSync(credentialsPath)).toEqual(before);
  });

  it("POST中にロックを失って兄弟更新が入ったら兄弟 credentials を採用して上書きしない", async () => {
    const base = makeTempDir("claude-refresh-compromised");
    const configDir = path.join(base, ".claude");
    const credentialsPath = writeCredentials(configDir);

    const result = await refreshClaudeCredentialFile({
      credentialsPath,
      requester: async () => {
        fs.rmdirSync(path.join(configDir, ".oauth_refresh.lock"));
        fs.rmdirSync(`${fs.realpathSync(configDir)}.lock`);
        fs.writeFileSync(
          credentialsPath,
          JSON.stringify({
            preservedTopLevel: true,
            claudeAiOauth: {
              accessToken: "access-sibling",
              refreshToken: "refresh-sibling",
              expiresAt: NOW_MS + 7_200_000,
              scopes: ["user:profile", "user:inference"],
              subscriptionType: "max",
            },
          }),
          { mode: 0o600 },
        );
        return new Response(
          JSON.stringify({
            access_token: "access-ours",
            refresh_token: "refresh-ours",
            expires_in: 3_600,
            scope: "user:profile user:inference",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      now: () => NOW_MS,
    });

    expect(result).toEqual({
      accessToken: "access-sibling",
      expiresAtMs: NOW_MS + 7_200_000,
      subscriptionType: "max",
    });
    const stored = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    expect(stored.claudeAiOauth.accessToken).toBe("access-sibling");
    expect(stored.claudeAiOauth.refreshToken).toBe("refresh-sibling");
  });

  it("refresh token または scopes が無い file は更新しない", async () => {
    const base = makeTempDir("claude-refresh-missing");
    const configDir = path.join(base, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const credentialsPath = path.join(configDir, ".credentials.json");
    fs.writeFileSync(
      credentialsPath,
      '{"claudeAiOauth":{"accessToken":"access-old","expiresAt":1}}\n',
      { mode: 0o600 },
    );
    let called = false;

    const result = await refreshClaudeCredentialFile({
      credentialsPath,
      requester: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});
