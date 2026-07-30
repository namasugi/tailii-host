// accountIdentity.ts
// tailii (TS host) — 「どのアカウントの使用量か」の表示用 ID（account-usage）
//
// 使用量シートの各カードに、ログイン中アカウントを**マスク済み**で 1 行出すための取得層。
//
// 秘密の扱い（この層の存在理由）:
//   - 生の email はここから外へ出さない。**マスクは host 側で行い、ワイヤーへは
//     `a***@example.com` 形式のマスク済み文字列しか載せない**（ログにも生値を出さない）。
//   - Codex 側は id_token（JWT）を読むが、トークン文字列そのものはワイヤー・ログへ載せない。
//     署名検証はしない — CLI 自身が管理するローカルファイルの、表示専用の読み取りなので
//     「改竄されていたら表示が変わるだけ」で済む（mocovia と同じ割り切り）。
//
// 取得元:
//   - Claude … `claude auth status --json` の `email`（2.1.220 実測。キーは camelCase で
//     `loggedIn` / `authMethod` / `apiProvider` / `email` / `subscriptionType`）。
//   - Codex  … `~/.codex/auth.json` の `tokens.id_token` の claims `email`。
//
// アカウント切替はまれなので、hostVersions と同じ**プロセス内キャッシュ**で 1 回だけ取る。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultInjectedPath } from "../commands/launch.js";

/** 使用量カードへ出すマスク済みアカウント（取れなかった側は省略）。 */
export interface AccountIdentities {
  claude?: string;
  codex?: string;
}

/** engine へ注入するフェッチャの型（テストは固定値を注入する）。 */
export type AccountIdentityProvider = () => Promise<AccountIdentities>;

/** `claude auth status --json` に与える timeout（ms）。 */
export const ACCOUNT_IDENTITY_TIMEOUT_MS = 3_000;

/** `~/.codex/auth.json` の読み込み上限（バイト）。異常に大きいファイルは読まない。 */
export const CODEX_AUTH_MAX_BYTES = 256 * 1024;

/** 子プロセス実行の注入点（テストは実 CLI を起動しない偽 exec を注入する）。 */
export type AccountExec = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

/**
 * email をマスクする（純ロジック, TESTABLE）。`alice@example.com` → `a***@example.com`。
 *
 * local part が空・`@` が無い/複数・domain が空や制御文字入りなど不正形は **undefined**
 * （＝「載せない」）。マスクできない値をそのまま出すくらいなら、行ごと出さない。
 */
export function maskEmail(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const email = raw.trim();
  const at = email.indexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain.length === 0 || domain.length > 128) return undefined;
  if (domain.includes("@")) return undefined;
  // 制御文字・空白を含む domain は表示に載せない（ログ・UI の汚染防止）。
  if ([...domain].some(isUnsafeLabelChar)) return undefined;
  const first = [...local][0];
  if (first === undefined) return undefined;
  return `${first}***@${domain}`;
}

/** domain ラベルに現れてはいけない文字（制御文字・空白）。 */
function isUnsafeLabelChar(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x20 || code === 0x7f;
}

/**
 * JWT（id_token）の payload から `email` claim を取り出す（純ロジック, TESTABLE）。
 * 署名は検証しない（表示専用）。形が違えば undefined。
 */
export function emailFromIdToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null) return undefined;
    const email = (claims as Record<string, unknown>)["email"];
    return typeof email === "string" && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `claude auth status --json` の出力から email を取り出す（純ロジック, TESTABLE）。
 * `loggedIn: false` は「アカウント無し」なので undefined。
 */
export function emailFromClaudeAuthStatus(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (rec["loggedIn"] === false) return undefined;
    const email = rec["email"];
    return typeof email === "string" && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/** 既定の exec（PATH を launch と揃え、timeout で必ず戻る）。 */
const defaultExec: AccountExec = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: os.homedir(),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          PATH: [defaultInjectedPath(), process.env["PATH"] ?? ""].filter(Boolean).join(":"),
        },
      },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });

/** `~/.codex/auth.json` を読む既定実装（サイズ上限付き。読めなければ null）。 */
function readCodexAuthFile(authPath: string): string | null {
  try {
    const stat = fs.statSync(authPath);
    if (!stat.isFile() || stat.size > CODEX_AUTH_MAX_BYTES) return null;
    return fs.readFileSync(authPath, "utf8");
  } catch {
    return null;
  }
}

/** `auth.json` 本文から Codex アカウントの email を取り出す（純ロジック, TESTABLE）。 */
export function emailFromCodexAuthJson(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const tokens = (parsed as Record<string, unknown>)["tokens"];
    if (typeof tokens !== "object" || tokens === null) return undefined;
    return emailFromIdToken((tokens as Record<string, unknown>)["id_token"]);
  } catch {
    return undefined;
  }
}

export interface CollectAccountIdentitiesOptions {
  exec?: AccountExec;
  /** `~/.codex/auth.json` の本文を返す読み取り（テストは fixture を注入する）。 */
  readCodexAuth?: () => string | null;
  timeoutMs?: number;
}

/**
 * 両 agent のマスク済みアカウントを集める（キャッシュ無し。テストはここを直接叩く）。
 * 取れなかった側は省略する。生 email はここから外へ出ない。
 */
export async function collectAccountIdentities(
  options: CollectAccountIdentitiesOptions = {},
): Promise<AccountIdentities> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? ACCOUNT_IDENTITY_TIMEOUT_MS;
  const readAuth =
    options.readCodexAuth ??
    ((): string | null => readCodexAuthFile(path.join(os.homedir(), ".codex", "auth.json")));

  const [claudeRaw, codexRaw] = await Promise.all([
    exec("claude", ["auth", "status", "--json"], timeoutMs).catch(() => null),
    Promise.resolve().then(readAuth).catch(() => null),
  ]);

  const claude = maskEmail(emailFromClaudeAuthStatus(claudeRaw));
  const codex = maskEmail(emailFromCodexAuthJson(codexRaw));
  return {
    ...(claude !== undefined ? { claude } : {}),
    ...(codex !== undefined ? { codex } : {}),
  };
}

/**
 * プロセス内キャッシュ付きの取得（既定の provider）。
 * アカウント切替はまれなので、`claude auth status`（子プロセス）は 1 回だけ走らせる。
 * 片方も取れなかった（空）ときはキャッシュせず、次回また試す。
 */
let memo: Promise<AccountIdentities> | null = null;

export function fetchAccountIdentities(): Promise<AccountIdentities> {
  memo ??= collectAccountIdentities().then(
    (value) => {
      if (Object.keys(value).length === 0) memo = null;
      return value;
    },
    () => {
      memo = null;
      return {};
    },
  );
  return memo;
}
