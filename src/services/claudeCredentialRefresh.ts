// claudeCredentialRefresh.ts
// SSH/headless 環境で Claude Code の credentials file を安全に自動更新する。
//
// refresh token はローテーションされるため、単純な POST + 上書きは禁止。
// Claude Code 2.1.220 と同じ 2 つの proper-lockfile 互換ロックを取り、ロック取得後に
// credentials を再読込してから refresh し、同一ディレクトリ内の一時ファイルから
// 原子的に置換する。credentials.json 自体は削除しない。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Claude Code の first-party OAuth token endpoint。 */
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";

/** Claude Code first-party OAuth client ID（Claude Code 2.1.220 と同値）。 */
export const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Claude Code と同じ「期限の5分前から更新対象」の猶予。 */
export const CLAUDE_OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1_000;

const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_LIMIT = 5;

export interface RefreshedClaudeCredential {
  accessToken: string;
  expiresAtMs: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export type OAuthTokenRequester = (url: string, init: RequestInit) => Promise<Response>;

export interface RefreshClaudeCredentialOptions {
  credentialsPath?: string;
  requester?: OAuthTokenRequester;
  now?: () => number;
  timeoutSeconds?: number;
}

interface HeldDirectoryLock {
  lockPath: string;
  dev: number;
  ino: number;
}

interface OAuthRecord extends Record<string, unknown> {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  refreshTokenExpiresAt?: unknown;
  scopes?: unknown;
  clientId?: unknown;
  subscriptionType?: unknown;
  rateLimitTier?: unknown;
}

interface ParsedCredentials {
  document: Record<string, unknown>;
  oauth: OAuthRecord;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  clientId: string;
}

export function defaultClaudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

/** Claude Code と同じ5分猶予で access token の更新要否を判定する。 */
export function shouldRefreshClaudeCredential(
  expiresAtMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  return expiresAtMs !== null && nowMs + CLAUDE_OAUTH_REFRESH_SKEW_MS >= expiresAtMs;
}

/**
 * credentials file の refresh token で access token を更新する。
 *
 * Keychain が使える通常環境では呼び出し側が Keychain を正本にする。この関数は
 * Keychain が使えない SSH/headless 環境専用で、成功時だけ同じ credentials file を
 * mode 0600 のまま原子的に更新する。
 */
export async function refreshClaudeCredentialFile(
  options: RefreshClaudeCredentialOptions = {},
): Promise<RefreshedClaudeCredential | null> {
  const credentialsPath = options.credentialsPath ?? defaultClaudeCredentialsPath();
  const requester = options.requester ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const timeoutSeconds = options.timeoutSeconds ?? 5;

  const initial = readCredentials(credentialsPath);
  if (initial === null) return null;

  let locks = await acquireOAuthRefreshLocks(path.dirname(credentialsPath));
  if (locks === null) return null;
  let stopHeartbeat = startLockHeartbeat(locks);

  try {
    // Claude Code / 別 engine が待機中に更新していれば、その結果を採用して POST しない。
    const current = readCredentials(credentialsPath);
    if (current === null) return null;
    if (current.accessToken !== initial.accessToken) return toRefreshedCredential(current.oauth);
    if (!ownsAllLocks(locks)) return null;

    const response = await requester(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: current.clientId,
        scope: current.scopes.join(" "),
      }),
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    if (response.status !== 200) return null;

    const payload = await response.json() as unknown;
    let mergeBase = current;
    let updated = mergeRefreshResponse(mergeBase, payload, now());
    if (updated === null) return null;

    if (!ownsAllLocks(locks)) {
      // refresh token を回した後にロックを失った場合は、そのまま上書きしない。
      // Claude Code と同様に再ロックして credentials を再読込し、兄弟更新を採用するか
      // 同じ refresh token のままなら自分の応答を安全に保存する。
      stopHeartbeat();
      releaseDirectoryLocks(locks);
      const reacquired = await acquireOAuthRefreshLocks(path.dirname(credentialsPath));
      if (reacquired === null) return null;
      locks = reacquired;
      stopHeartbeat = startLockHeartbeat(locks);

      const latest = readCredentials(credentialsPath);
      if (latest === null) return null;
      if (
        latest.refreshToken !== current.refreshToken ||
        latest.accessToken !== current.accessToken
      ) {
        return toRefreshedCredential(latest.oauth);
      }
      mergeBase = latest;
      updated = mergeRefreshResponse(mergeBase, payload, now());
      if (updated === null) return null;
    }

    if (!ownsAllLocks(locks)) return null;
    writeCredentialsAtomically(credentialsPath, updated.document);
    return updated.credential;
  } catch {
    return null;
  } finally {
    stopHeartbeat();
    releaseDirectoryLocks(locks);
  }
}

function readCredentials(credentialsPath: string): ParsedCredentials | null {
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const rawOauth = record["claudeAiOauth"];
  if (typeof rawOauth !== "object" || rawOauth === null || Array.isArray(rawOauth)) return null;
  const oauth = rawOauth as OAuthRecord;
  const accessToken = nonEmptyString(oauth.accessToken);
  const refreshToken = nonEmptyString(oauth.refreshToken);
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((scope): scope is string => nonEmptyString(scope) !== null)
    : [];
  if (accessToken === null || refreshToken === null || scopes.length === 0) return null;

  return {
    document: record,
    oauth,
    accessToken,
    refreshToken,
    scopes,
    clientId: nonEmptyString(oauth.clientId) ?? CLAUDE_CODE_OAUTH_CLIENT_ID,
  };
}

function mergeRefreshResponse(
  current: ParsedCredentials,
  payload: unknown,
  nowMs: number,
): { document: Record<string, unknown>; credential: RefreshedClaudeCredential } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const response = payload as Record<string, unknown>;
  const accessToken = nonEmptyString(response["access_token"]);
  const expiresIn = positiveFiniteNumber(response["expires_in"]);
  if (accessToken === null || expiresIn === null) return null;

  const refreshToken = nonEmptyString(response["refresh_token"]) ?? current.refreshToken;
  const responseScopes =
    typeof response["scope"] === "string"
      ? response["scope"].split(/\s+/).filter((scope) => scope.length > 0)
      : [];
  const scopes = responseScopes.length > 0 ? responseScopes : current.scopes;
  const expiresAtMs = nowMs + expiresIn * 1_000;
  const refreshExpiresIn = positiveFiniteNumber(response["refresh_token_expires_in"]);

  const oauth: OAuthRecord = {
    ...current.oauth,
    accessToken,
    refreshToken,
    expiresAt: expiresAtMs,
    scopes,
    ...(refreshExpiresIn !== null
      ? { refreshTokenExpiresAt: nowMs + refreshExpiresIn * 1_000 }
      : {}),
  };
  const document = { ...current.document, claudeAiOauth: oauth };
  return {
    document,
    credential: {
      accessToken,
      expiresAtMs,
      ...(nonEmptyString(oauth.subscriptionType) !== null
        ? { subscriptionType: nonEmptyString(oauth.subscriptionType)! }
        : {}),
      ...(nonEmptyString(oauth.rateLimitTier) !== null
        ? { rateLimitTier: nonEmptyString(oauth.rateLimitTier)! }
        : {}),
    },
  };
}

function toRefreshedCredential(oauth: OAuthRecord): RefreshedClaudeCredential | null {
  const accessToken = nonEmptyString(oauth.accessToken);
  const expiresAtMs =
    typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? oauth.expiresAt
      : null;
  if (accessToken === null || expiresAtMs === null) return null;
  const subscriptionType = nonEmptyString(oauth.subscriptionType);
  const rateLimitTier = nonEmptyString(oauth.rateLimitTier);
  return {
    accessToken,
    expiresAtMs,
    ...(subscriptionType !== null ? { subscriptionType } : {}),
    ...(rateLimitTier !== null ? { rateLimitTier } : {}),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Claude Code の proper-lockfile 設定と互換のディレクトリロックを同じ順で取る。
 * 新ロック: `<configDir>/.oauth_refresh.lock`
 * legacy ロック: `<real configDir>.lock`
 */
async function acquireOAuthRefreshLocks(configDir: string): Promise<HeldDirectoryLock[] | null> {
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  let realConfigDir: string;
  try {
    realConfigDir = fs.realpathSync(configDir);
  } catch {
    realConfigDir = configDir;
  }
  const lockPaths = [
    path.join(configDir, ".oauth_refresh.lock"),
    `${realConfigDir}.lock`,
  ];

  for (let attempt = 0; attempt <= LOCK_RETRY_LIMIT; attempt += 1) {
    const held: HeldDirectoryLock[] = [];
    let complete = true;
    for (const lockPath of lockPaths) {
      const lock = tryAcquireDirectoryLock(lockPath);
      if (lock === null) {
        complete = false;
        break;
      }
      held.push(lock);
    }
    if (complete) return held;
    releaseDirectoryLocks(held);
    if (attempt < LOCK_RETRY_LIMIT) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000 + Math.floor(Math.random() * 1_000));
      });
    }
  }
  return null;
}

function tryAcquireDirectoryLock(lockPath: string): HeldDirectoryLock | null {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    try {
      const stat = fs.statSync(lockPath);
      if (!stat.isDirectory() || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
      fs.rmdirSync(lockPath);
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch {
      return null;
    }
  }

  try {
    const stat = fs.statSync(lockPath);
    return { lockPath, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function startLockHeartbeat(locks: readonly HeldDirectoryLock[]): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    for (const lock of locks) {
      if (!stillOwnsLock(lock)) continue;
      try {
        fs.utimesSync(lock.lockPath, now, now);
      } catch {
        // ロック喪失は release 側でも inode 照合し、他プロセスのロックを消さない。
      }
    }
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

function releaseDirectoryLocks(locks: readonly HeldDirectoryLock[]): void {
  for (const lock of [...locks].reverse()) {
    if (!stillOwnsLock(lock)) continue;
    try {
      fs.rmdirSync(lock.lockPath);
    } catch {
      // 他プロセスによる回収・置換、または非空なら触らない。
    }
  }
}

function stillOwnsLock(lock: HeldDirectoryLock): boolean {
  try {
    const stat = fs.statSync(lock.lockPath);
    return stat.isDirectory() && stat.dev === lock.dev && stat.ino === lock.ino;
  } catch {
    return false;
  }
}

function ownsAllLocks(locks: readonly HeldDirectoryLock[]): boolean {
  return locks.length === 2 && locks.every(stillOwnsLock);
}

/** mode 0600 の同一ディレクトリ一時ファイルを書き、rename で原子的に置換する。 */
function writeCredentialsAtomically(
  credentialsPath: string,
  document: Record<string, unknown>,
): void {
  const dir = path.dirname(credentialsPath);
  const tempPath = path.join(
    dir,
    `.credentials.json.tailii-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(document)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, credentialsPath);
    fs.chmodSync(credentialsPath, 0o600);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 元のエラーを優先する。
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // rename 済み、または一時ファイル未生成。
    }
    throw error;
  }
}
