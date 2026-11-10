import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, mkdir, rename, unlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ApiFederationSelection { profile: string; configurationHash: string }
export interface ApiFederationProfile extends ApiFederationSelection {
  organizationId: string; federationRuleId: string; serviceAccountId?: string; workspaceId?: string;
}
export interface ApiFederationOptions { profiles: ApiFederationProfile[]; error?: string }
export interface ApiFederationStatus { authenticated: boolean; expiresAt?: number; error?: string }
export interface ApiFederationConfiguration {
  profile: string; organizationId: string; federationRuleId: string; serviceAccountId?: string;
  workspaceId?: string; identityTokenPath: string;
}
export type FederationErrorCode = "federation_not_configured" | "federation_profile_changed" | "federation_invalid_config"
  | "federation_identity_unavailable" | "federation_identity_expired" | "federation_auth_failed"
  | "federation_unavailable" | "federation_profile_exists";
export class FederationError extends Error {
  constructor(readonly code: FederationErrorCode) { super(code); }
}
type Token = { token: string; expiresAt: number; refreshAt: number; configurationHash: string };
type Profile = ApiFederationProfile & { identityTokenPath?: string; environmentToken: boolean };
const validName = (name: string): boolean => /^[A-Za-z0-9_.-]{1,80}$/.test(name) && name !== "." && name !== "..";
export function validFederationSelection(value: ApiFederationSelection): boolean {
  return (validName(value.profile) || value.profile === "@environment") && /^[a-f0-9]{64}$/.test(value.configurationHash);
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FederationError("federation_invalid_config");
  return value as Record<string, unknown>;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
// projected tokenのsymlinkは許すが、FIFO・無限ストリーム・巨大なファイルは読まない。
async function readBounded(path: string, limit: number, privateFile = false): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit || (privateFile && (stat.mode & 0o077) !== 0)) throw new Error("file");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size !== stat.size || size > limit) throw new Error("size");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await file.close(); }
}

/** 公式のoidc_federationプロファイルを明示選択して使う。APIキーやSubscription OAuthへ切り替えない。 */
export class ClaudeApiFederation {
  private readonly cache = new Map<string, Token>();
  constructor(private readonly options: {
    configDirectory?: string; cacheDirectory?: string; env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch; now?: () => number;
  } = {}) {}
  private get env(): NodeJS.ProcessEnv { return this.options.env ?? process.env; }
  private get configDirectory(): string { return this.options.configDirectory ?? this.env["ANTHROPIC_CONFIG_DIR"] ?? join(homedir(), ".config", "anthropic"); }
  private get cacheDirectory(): string { return this.options.cacheDirectory ?? join(homedir(), ".tailii", "api-federation"); }
  private now(): number { return this.options.now?.() ?? Date.now() / 1000; }

  async list(): Promise<ApiFederationOptions> {
    const profiles: ApiFederationProfile[] = [];
    let names: string[] = [];
    try { names = (await readdir(join(this.configDirectory, "configs"))).filter((name) => name.endsWith(".json")).slice(0, 64).map((name) => name.slice(0, -5)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { profiles, error: "federation_invalid_config" }; }
    if (this.env["ANTHROPIC_FEDERATION_RULE_ID"] && this.env["ANTHROPIC_ORGANIZATION_ID"]) names.unshift("@environment");
    for (const name of names) {
      try { profiles.push(this.publicProfile(await this.profile(name))); }
      catch { /* ほかの認証方式・壊れた設定・秘密を一覧へ流さない。 */ }
    }
    return { profiles: profiles.slice(0, 32) };
  }

  private publicProfile(value: Profile): ApiFederationProfile {
    const { profile, configurationHash, organizationId, federationRuleId, serviceAccountId, workspaceId } = value;
    return { profile, configurationHash, organizationId, federationRuleId, ...(serviceAccountId ? { serviceAccountId } : {}), ...(workspaceId ? { workspaceId } : {}) };
  }

  private async profile(name: string): Promise<Profile> {
    if (!validName(name) && name !== "@environment") throw new FederationError("federation_invalid_config");
    let raw: Record<string, unknown>;
    if (name === "@environment") raw = { authentication: { type: "oidc_federation" } };
    else {
      try { raw = record(JSON.parse(await readBounded(join(this.configDirectory, "configs", name + ".json"), 32_000))); }
      catch { throw new FederationError("federation_not_configured"); }
    }
    const auth = record(raw["authentication"]);
    if (auth["type"] !== "oidc_federation" || (raw["base_url"] !== undefined && raw["base_url"] !== "https://api.anthropic.com")) throw new FederationError("federation_invalid_config");
    const organizationId = text(raw["organization_id"]) ?? this.env["ANTHROPIC_ORGANIZATION_ID"];
    const federationRuleId = text(auth["federation_rule_id"]) ?? this.env["ANTHROPIC_FEDERATION_RULE_ID"];
    const serviceAccountId = text(auth["service_account_id"]) ?? this.env["ANTHROPIC_SERVICE_ACCOUNT_ID"];
    const workspaceId = text(raw["workspace_id"]) ?? this.env["ANTHROPIC_WORKSPACE_ID"];
    let identityTokenPath = this.env["ANTHROPIC_IDENTITY_TOKEN_FILE"];
    if (auth["identity_token"] !== undefined) {
      const identity = record(auth["identity_token"]);
      if (identity["source"] !== "file") throw new FederationError("federation_invalid_config");
      identityTokenPath = text(identity["path"]);
      if (!identityTokenPath) throw new FederationError("federation_invalid_config");
    }
    if (!organizationId || !/^[a-f0-9-]{36}$/i.test(organizationId) || !federationRuleId || !/^fdrl_[A-Za-z0-9]{1,128}$/.test(federationRuleId)
        || (serviceAccountId && !/^svac_[A-Za-z0-9]{1,128}$/.test(serviceAccountId))
        || (workspaceId && workspaceId !== "default" && !/^wrkspc_[A-Za-z0-9]{1,128}$/.test(workspaceId))
        || (identityTokenPath && (!isAbsolute(identityTokenPath) || identityTokenPath.length > 4096 || identityTokenPath.includes("\0")))
        || (!identityTokenPath && !this.env["ANTHROPIC_IDENTITY_TOKEN"])) throw new FederationError("federation_invalid_config");
    const normalized = { organizationId, federationRuleId, serviceAccountId, workspaceId, identityTokenPath, environmentToken: !identityTokenPath };
    return { profile: name, configurationHash: hash(JSON.stringify(normalized)), ...normalized };
  }

  async create(configuration: ApiFederationConfiguration): Promise<ApiFederationProfile> {
    if (!validName(configuration.profile) || !isAbsolute(configuration.identityTokenPath)
        || configuration.identityTokenPath.includes("\0") || configuration.identityTokenPath.length > 4096) throw new FederationError("federation_invalid_config");
    // 既存の公式プロファイルやactive_configは上書きしない。
    const data = { version: "1.0", organization_id: configuration.organizationId, workspace_id: configuration.workspaceId,
      base_url: "https://api.anthropic.com", authentication: { type: "oidc_federation", federation_rule_id: configuration.federationRuleId,
        service_account_id: configuration.serviceAccountId, identity_token: { source: "file", path: configuration.identityTokenPath } } };
    if (!/^[a-f0-9-]{36}$/i.test(configuration.organizationId) || !/^fdrl_[A-Za-z0-9]{1,128}$/.test(configuration.federationRuleId)
        || (configuration.serviceAccountId && !/^svac_[A-Za-z0-9]{1,128}$/.test(configuration.serviceAccountId))
        || (configuration.workspaceId && configuration.workspaceId !== "default" && !/^wrkspc_[A-Za-z0-9]{1,128}$/.test(configuration.workspaceId))) throw new FederationError("federation_invalid_config");
    const directory = join(this.configDirectory, "configs");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = await open(join(directory, configuration.profile + ".json"), "wx", 0o600);
      try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); } finally { await file.close(); }
    } catch (error) { throw new FederationError((error as NodeJS.ErrnoException).code === "EEXIST" ? "federation_profile_exists" : "federation_invalid_config"); }
    return this.publicProfile(await this.profile(configuration.profile));
  }

  async check(selection: ApiFederationSelection, signal: AbortSignal): Promise<ApiFederationStatus> {
    try { const token = await this.token(selection, signal); return { authenticated: true, expiresAt: token.expiresAt }; }
    catch (error) { return { authenticated: false, error: error instanceof FederationError ? error.code : "federation_unavailable" }; }
  }

  async token(selection: ApiFederationSelection, signal: AbortSignal): Promise<Token> {
    if (!validFederationSelection(selection)) throw new FederationError("federation_invalid_config");
    const profile = await this.profile(selection.profile);
    if (profile.configurationHash !== selection.configurationHash) throw new FederationError("federation_profile_changed");
    // 同じ設定に別名が付いていても、同じjtiを別々に交換しない。
    const key = profile.configurationHash;
    const existing = this.cache.get(key);
    if (existing && this.now() < existing.refreshAt && this.now() < existing.expiresAt - 30) return existing;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try { await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 }); }
    catch { throw new FederationError("federation_unavailable"); }
    const path = join(this.cacheDirectory, key + ".json");
    const lock = path + ".lock";
    let held = false;
    try {
      // 複数engineの同時交換で同じjtiを二重使用しない。ロックは待機中の中止でも解放する。
      while (!held) {
        timeout.throwIfAborted();
        try { const file = await open(lock, "wx", 0o600); held = true; try { await file.writeFile(String(process.pid)); } finally { await file.close(); } }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const pid = Number(await readBounded(lock, 32, true));
            if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") await unlink(lock); } }
            else if (Date.now() - (await stat(lock)).mtimeMs > 60_000) await unlink(lock);
          }
          catch { /* 現在のロックを勝手に奪わず、全体タイムアウトで止める。 */ }
          await delay(40, undefined, { signal: timeout });
        }
      }
      let cached = existing;
      try {
        const value = record(JSON.parse(await readBounded(path, 20_000, true)));
        if (value["configurationHash"] === profile.configurationHash && typeof value["token"] === "string" && /^[\x21-\x7e]{20,8192}$/.test(value["token"])
            && typeof value["expiresAt"] === "number" && Number.isFinite(value["expiresAt"]) && typeof value["refreshAt"] === "number" && Number.isFinite(value["refreshAt"])
            && value["expiresAt"] <= this.now() + 86_400 && value["refreshAt"] < value["expiresAt"]) cached = value as unknown as Token;
      } catch { /* 自分専用の短期トークンキャッシュが無い・古いときだけ交換する。 */ }
      if (cached && this.now() < cached.refreshAt && this.now() < cached.expiresAt - 30) { this.remember(key, cached); return cached; }
      let fresh: Token;
      try { fresh = await this.exchange(profile, timeout); }
      catch (error) {
        if (!signal.aborted && cached && this.now() < cached.expiresAt - 30) { this.remember(key, cached); return cached; }
        throw error;
      }
      this.remember(key, fresh);
      const temporary = path + "." + randomUUID();
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(fresh)); } finally { await file.close(); }
        await rename(temporary, path);
      } catch { /* 書き込めなくても、取得済みトークンはメモリ内で利用できる。 */ }
      finally { await unlink(temporary).catch(() => {}); }
      return fresh;
    } catch (error) { if (error instanceof FederationError) throw error; throw new FederationError("federation_unavailable"); }
    finally { if (held) await unlink(lock).catch(() => {}); }
  }
  private remember(key: string, value: Token): void { this.cache.set(key, value); if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!); }

  private async exchange(profile: Profile, signal: AbortSignal): Promise<Token> {
    let jwt: string;
    try { jwt = (profile.identityTokenPath ? await readBounded(profile.identityTokenPath, 16_384) : this.env["ANTHROPIC_IDENTITY_TOKEN"] ?? "").trim(); }
    catch { throw new FederationError("federation_identity_unavailable"); }
    if (jwt.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) throw new FederationError("federation_identity_unavailable");
    try {
      const payload = record(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")));
      if (typeof payload["exp"] !== "number" || !Number.isFinite(payload["exp"]) || payload["exp"] <= this.now() + 5) throw new FederationError("federation_identity_expired");
    } catch (error) { throw error instanceof FederationError ? error : new FederationError("federation_identity_unavailable"); }
    const response = await (this.options.fetcher ?? fetch)("https://api.anthropic.com/v1/oauth/token", {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20,oidc-federation-2026-04-01" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt,
        federation_rule_id: profile.federationRuleId, organization_id: profile.organizationId,
        ...(profile.serviceAccountId ? { service_account_id: profile.serviceAccountId } : {}), ...(profile.workspaceId ? { workspace_id: profile.workspaceId } : {}) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new FederationError([400, 401, 403].includes(response.status) ? "federation_auth_failed" : "federation_unavailable"); }
    const reader = response.body?.getReader(); if (!reader) throw new FederationError("federation_auth_failed");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 20_000) throw new FederationError("federation_auth_failed"); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    let raw: Record<string, unknown>;
    try { raw = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw new FederationError("federation_auth_failed"); }
    const token = raw["access_token"]; const lifetime = raw["expires_in"];
    if (typeof token !== "string" || !/^[\x21-\x7e]{20,8192}$/.test(token) || typeof lifetime !== "number" || !Number.isSafeInteger(lifetime)
        || lifetime < 60 || lifetime > 86_400 || String(raw["token_type"]).toLowerCase() !== "bearer") throw new FederationError("federation_auth_failed");
    const now = this.now();
    return { token, expiresAt: now + lifetime, refreshAt: now + lifetime - Math.min(120, Math.max(30, lifetime / 5)), configurationHash: profile.configurationHash };
  }
}
export const claudeApiFederation = new ClaudeApiFederation();
