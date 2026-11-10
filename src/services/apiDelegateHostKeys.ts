import type { ClaudeApiDelegateRequest } from "./claudeApiDelegate.js";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiDelegateKeyStore, validDelegateApiKey } from "./apiDelegateKeyStore.js";
import { resolveApiKeySource } from "./apiKeySource.js";
import type { ApiUsageCredential, ApiUsageCredentials } from "../protocol/messages.js";

export interface ApiDelegateHostKeys { claude: boolean; openai: boolean; supportsRegistration?: boolean; supportsKeySources?: boolean }
function configuredKey(provider: "claude" | "openai", env: NodeJS.ProcessEnv): string | undefined {
  let fd: number | undefined;
  try {
    const file = provider === "claude" ? join(env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "settings.json")
      : join(env["TAILII_CODEX_APP_SERVER_HOME"] || join(homedir(), ".codex"), "auth.json");
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd); if (!info.isFile() || info.size > 1_048_576) return undefined;
    const buffer = Buffer.alloc(info.size + 1); let size = 0;
    while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    if (size !== info.size) return undefined;
    const raw = JSON.parse(buffer.subarray(0, size).toString("utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    if (provider === "openai") return raw["auth_mode"] === "apikey" && typeof raw["OPENAI_API_KEY"] === "string" ? raw["OPENAI_API_KEY"] : undefined;
    const configured = raw["env"] as Record<string, unknown> | undefined;
    return configured && typeof configured["ANTHROPIC_API_KEY"] === "string" ? configured["ANTHROPIC_API_KEY"] : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function hostApiKey(provider: "claude" | "openai", env: NodeJS.ProcessEnv = process.env, source?: ApiUsageCredential): string | undefined {
  const value = source && source.mode !== "automatic" ? resolveApiKeySource(source, env)
    : (env[provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] || configuredKey(provider, env) || apiDelegateKeyStore.load(provider))?.trim();
  if (!value) return undefined;
  return validDelegateApiKey(provider, value) ? value : undefined;
}
export function apiDelegateHostKeys(env: NodeJS.ProcessEnv = process.env, sources?: ApiUsageCredentials): ApiDelegateHostKeys {
  return { claude: hostApiKey("claude", env, sources?.claudeExecution) !== undefined, openai: hostApiKey("openai", env, sources?.openaiExecution) !== undefined };
}
export function resolvedHostApiRequest(request: ClaudeApiDelegateRequest, provider: "claude" | "openai"): ClaudeApiDelegateRequest | undefined {
  if (!request.useHostApiKey) return request;
  if (request.apiKey !== "" || request.federation) return undefined;
  const key = hostApiKey(provider, process.env, request.keySource);
  return key ? { ...request, apiKey: key, useHostApiKey: false } : undefined;
}
