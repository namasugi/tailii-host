// apnsJwtProvider.ts
// tailii (TS host) — ES256 JWT 署名＋再利用キャッシュ
// Swift 版 APNsJWTProvider.swift の移植。
//
// `.p8`（P256 秘密鍵）から APNs プロバイダ JWT を ES256 で署名する。
//   ヘッダ `{alg:"ES256", kid:<keyId>}`、クレーム `{iss:<teamId>, iat:<now>}` を
//   base64url（padding 無し）で符号化し、署名は `header.payload` に対する P256 ECDSA の
//   raw 64 バイト（r||s）を base64url 化する（DER ではなく raw 表現, Requirement 6.1）。
//
//   再利用キャッシュ: `~/.tailii/apns/jwt-cache.json`（`{jwt, issuedAt}`）。
//   再利用窓（既定 50 分）内は流用し、超過で再署名する（6.1 / 429 回避）。
//   invalidate() はキャッシュを破棄し次回再署名を強制する（ExpiredProviderToken 受領時, 6.2）。
//
// 署名は Node 組み込みの `node:crypto`（P256 ECDSA）で行い、外部 JWT ライブラリは不採用。
// `.p8` 秘密鍵はログに出さない（6.5）。鍵情報は ApnsConfigStore から取得する。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ApnsConfig, ApnsConfigStore } from "./apnsConfigStore.js";
import { defaultApnsBase, ensureApnsDirectory } from "./pushTypes.js";

/** 既定の再利用窓（秒）。50 分 = 3000 秒（毎時再発行の目安より短く保ち 429 を回避, 6.1）。 */
export const DEFAULT_JWT_REUSE_WINDOW_SECONDS = 3000;

/** JWT 生成／設定に関するエラー理由。 */
export type JWTCacheErrorReason = "config-missing" | "key-load-failed" | "encoding-failed";

/** JWT 生成／設定に関する型付きエラー（6.4）。 */
export class JWTCacheError extends Error {
  constructor(
    public readonly reason: JWTCacheErrorReason,
    detail = "",
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "JWTCacheError";
  }
}

/** APNs プロバイダ JWT の供給契約（再利用窓内はキャッシュ、超過で再署名）。 */
export interface APNsJWTProviding {
  /** 再利用窓内はキャッシュを返し、超過で ES256 再署名した JWT を返す（config 未設定は throw, 6.4）。 */
  currentToken(): string;
  /** キャッシュを無効化し、次回 currentToken() で再署名を強制する（6.2）。 */
  invalidate(): void;
}

interface JWTCacheEntry {
  jwt: string;
  issuedAt: number;
}

export interface APNsJWTProviderOptions {
  /** jwt-cache.json を保存する base ディレクトリ。省略時は `~/.tailii/apns`。 */
  base?: string;
  /** 再利用窓（秒）。省略時は 3000（50 分）。 */
  reuseWindow?: number;
  /** 現在時刻（Unix 秒）を返す関数。テストで決定化するため注入可能。 */
  now?: () => number;
}

/**
 * ES256 で APNs プロバイダ JWT を署名し、再利用窓内はファイルキャッシュを流用する実体。
 * キャッシュは `~/.tailii/apns/jwt-cache.json` に永続する（hook プロセスは短命かつ
 * 複数起動しうるため、跨プロセスで再利用が効く）。base / now / reuseWindow を注入できる。
 */
export class APNsJWTProvider implements APNsJWTProviding {
  private readonly configStore: ApnsConfigStore;
  private readonly base: string;
  private readonly reuseWindow: number;
  private readonly now: () => number;

  constructor(config: ApnsConfigStore, options: APNsJWTProviderOptions = {}) {
    this.configStore = config;
    this.base = options.base ?? defaultApnsBase();
    this.reuseWindow = options.reuseWindow ?? DEFAULT_JWT_REUSE_WINDOW_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private get cacheURL(): string {
    return path.join(this.base, "jwt-cache.json");
  }

  /** 再利用窓内はキャッシュを返し、超過で ES256 再署名する（Requirement 6.1）。 */
  currentToken(): string {
    const config = this.configStore.load();
    if (config === null) {
      // 未設定なら送信側が判別できるよう明示 throw（6.4）。
      throw new JWTCacheError("config-missing");
    }

    const currentTime = this.now();

    // 有効なキャッシュがあれば流用（跨インスタンス／跨プロセスでも効く）。
    const cached = this.loadCache();
    if (cached !== null && currentTime - cached.issuedAt < this.reuseWindow && currentTime >= cached.issuedAt) {
      return cached.jwt;
    }

    // 再署名して永続化。
    const jwt = this.sign(config, currentTime);
    this.saveCache({ jwt, issuedAt: currentTime });
    return jwt;
  }

  /** キャッシュファイルを削除し、次回 currentToken() で再署名を強制する（6.2）。 */
  invalidate(): void {
    try {
      fs.rmSync(this.cacheURL);
    } catch {
      // ファイル欠落など削除失敗は無視（次回は再署名できる）。
    }
  }

  // MARK: - 署名

  /** `.p8`（PKCS#8 PEM）を読み込み ES256 JWT を署名する。 */
  private sign(config: ApnsConfig, iat: number): string {
    const key = this.loadPrivateKey(config.keyPath);

    // header: {alg, kid} を辞書順で決定的に符号化。
    const header = { alg: "ES256", kid: config.keyId };
    // claims: {iat, iss}。iat は整数で載せる（辞書順で iat < iss）。
    const claims = { iat, iss: config.teamId };

    const signingInput = `${base64url(canonicalJSON(header))}.${base64url(canonicalJSON(claims))}`;

    // ES256: SHA256(header.payload) を P256 ECDSA 署名。raw 64 バイト(r||s)を用いる
    //（APNs/JWT では DER ではなく raw 表現が必須 → dsaEncoding: "ieee-p1363"）。
    let signature: Buffer;
    try {
      signature = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
        key,
        dsaEncoding: "ieee-p1363",
      });
    } catch (error) {
      throw new JWTCacheError("encoding-failed", String(error));
    }

    return `${signingInput}.${base64url(signature)}`;
  }

  /** `.p8`（PKCS#8 PEM）ファイルから P256 署名鍵を読み込む（秘密鍵は非ログ, 6.5）。 */
  private loadPrivateKey(keyPath: string): crypto.KeyObject {
    let pem: string;
    try {
      pem = fs.readFileSync(keyPath, "utf8");
    } catch {
      throw new JWTCacheError("key-load-failed", "鍵ファイル読込失敗");
    }
    try {
      return crypto.createPrivateKey({ key: pem, format: "pem" });
    } catch {
      throw new JWTCacheError("key-load-failed", "PKCS#8 PEM パース失敗");
    }
  }

  // MARK: - キャッシュ I/O

  /** jwt-cache.json を読み込む。欠落・不正 JSON なら `null`。 */
  private loadCache(): JWTCacheEntry | null {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.cacheURL, "utf8"));
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj["jwt"] !== "string" || typeof obj["issuedAt"] !== "number") return null;
    return { jwt: obj["jwt"], issuedAt: obj["issuedAt"] };
  }

  /** jwt-cache.json を 0600 で保存する（ディレクトリは 0700）。保存失敗は握り潰す。 */
  private saveCache(entry: JWTCacheEntry): void {
    try {
      ensureApnsDirectory(this.base);
      // 辞書順（issuedAt < jwt）で符号化（Swift 版 .sortedKeys と同一）。
      const payload = JSON.stringify({ issuedAt: entry.issuedAt, jwt: entry.jwt });
      fs.writeFileSync(this.cacheURL, payload, { mode: 0o600 });
      fs.chmodSync(this.cacheURL, 0o600);
    } catch {
      // 保存失敗は致命ではない（次回は再署名できる）。
    }
  }
}

/** base64url（padding 無し）符号化。`+`→`-`, `/`→`_`, `=` を除去。 */
function base64url(data: Buffer): string {
  return data.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 与えたオブジェクトを、キー辞書順で決定的に JSON 符号化した Buffer を返す。 */
function canonicalJSON(obj: Record<string, unknown>): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return Buffer.from(JSON.stringify(sorted), "utf8");
}
