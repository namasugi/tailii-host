// pushTransport.ts
// tailii (TS host) — プッシュ通知の送信経路（relay / direct）
//
// 設計 docs/push-notifications.md §9、契約 protocol/push-v1.md §3・§4。
//   - relay: 発行者のリレー（AWS Lambda）へ HTTPS POST `/v1/push`。5xx とタイムアウトは 1 秒後に 1 回だけ再試行。
//   - direct: self-build 用。`~/.tailii/apns` の .p8 で署名して APNs へ直送する（既存 APNsSender + JWT を包む）。
//     payload はリレーと同じ暗号化した形（契約 §3）。
// 選び方: `~/.tailii/apns/config.json` があり topic が端末の bundle id と一致 → direct。それ以外で有効な
// capability があれば relay。どちらも無ければ送らない。
//
// capability / device token / JWT はログ・結果の detail に載せない。HTTP は注入してテストで実通信しない。

import type { ApnsConfig } from "./apnsConfigStore.js";
import type { APNsJWTProviding } from "./apnsJwtProvider.js";
import type { ApnsSending } from "./apnsSender.js";
import type { PushDeviceRecord } from "./pushDeviceStore.js";
import type { PushTp } from "./pushEnvelope.js";

export type PushInterruptionLevel = "active" | "time-sensitive" | "passive";

/** 1 端末宛ての送信要求（暗号化済み）。 */
export interface PushSendRequest {
  tp: PushTp;
  interruptionLevel: PushInterruptionLevel;
  /** 64 バイト以下の ASCII。 */
  collapseId: string;
  /** 絶対時刻の epoch 秒（APNs の apns-expiration）。 */
  expiration: number;
  /** 各送信の試行（再試行を含む）の直前に確かめる。false なら送らず `cancelled`。 */
  isStillValid?: () => boolean;
}

/**
 * 送信結果。`detail` は観測ログ・doctor 用の短いコードだけ（秘密を含めない）。
 * - unregistered: 宛先が消えた（410）→ 端末の記録を消す
 * - invalid_capability: リレーの capability が無効（401）→ 無効の印を付ける
 */
export type PushSendStatus =
  | "ok"
  | "unregistered"
  | "invalid_capability"
  | "rate_limited"
  | "payload_too_large"
  | "bad_request"
  | "cancelled"
  | "failed";

export interface PushSendResult {
  status: PushSendStatus;
  detail: string;
}

export interface PushTransport {
  readonly kind: "relay" | "direct";
  send(request: PushSendRequest): Promise<PushSendResult>;
}

// MARK: - 経路の選択

export type PushTransportChoice = "relay" | "direct" | "none";

/** 端末に使える経路（設計 §9 の選び方）。`nowSeconds` を渡すと期限切れの capability を使わない。 */
export function choosePushTransport(
  device: Pick<PushDeviceRecord, "bundleId" | "relay">,
  apnsConfig: ApnsConfig | null,
  nowSeconds?: number,
): PushTransportChoice {
  if (apnsConfig !== null && apnsConfig.topic === device.bundleId) return "direct";
  const relay = device.relay;
  if (relay === undefined || relay.invalid === true) return "none";
  if (nowSeconds !== undefined && relay.expiresAt <= nowSeconds) return "none";
  return "relay";
}

// MARK: - APNs payload（契約 §3）

/** 呼び出し側から表示文言は指定しない（固定文言。通知サービス拡張が復号して書き換える）。 */
export const PUSH_FALLBACK_ALERT = { title: "Tailii", body: "新しい通知があります" } as const;

/** 契約 §3 の APNs payload（キーは辞書順）。direct 経路が使う。 */
export function apnsPayloadBody(tp: PushTp, interruptionLevel: PushInterruptionLevel): Buffer {
  const payload = {
    aps: {
      alert: { body: PUSH_FALLBACK_ALERT.body, title: PUSH_FALLBACK_ALERT.title },
      "content-available": 1,
      "interruption-level": interruptionLevel,
      "mutable-content": 1,
      sound: "default",
    },
    tp: { c: tp.c, k: tp.k, n: tp.n, v: tp.v },
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

// MARK: - relay

/** JSON POST の結果。転送層の失敗はタイムアウトとそれ以外を分ける（再試行の判断に使う）。 */
export type JsonPostResult =
  | { ok: true; status: number; body: string }
  | { ok: false; error: "timeout" | "network" };

export interface JsonPoster {
  post(url: string, body: string, timeoutMs: number): Promise<JsonPostResult>;
}

/** 本番の JsonPoster（Node 組み込み fetch。HTTPS 以外は送らない）。 */
export class FetchJsonPoster implements JsonPoster {
  async post(url: string, body: string, timeoutMs: number): Promise<JsonPostResult> {
    if (!url.startsWith("https://")) return { ok: false, error: "network" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      return { ok: true, status: response.status, body: text };
    } catch {
      return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface RelayTransportOptions {
  /** 1 回の要求の上限（ms）。既定 8000。 */
  timeoutMs?: number;
  /** 再試行までの待ち（ms）。既定 1000。 */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** リレー URL（https のみ）から `/v1/push` の URL を作る。不正なら null。 */
export function relayPushUrl(baseUrl: string): string | null {
  if (!baseUrl.startsWith("https://")) return null;
  try {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (base.protocol !== "https:") return null;
    return new URL("v1/push", base).toString();
  } catch {
    return null;
  }
}

export class RelayTransport implements PushTransport {
  readonly kind = "relay" as const;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly relayUrl: string,
    private readonly capability: string,
    private readonly poster: JsonPoster,
    options: RelayTransportOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async send(request: PushSendRequest): Promise<PushSendResult> {
    const url = relayPushUrl(this.relayUrl);
    if (url === null) return { status: "bad_request", detail: "relay-url-invalid" };
    const body = JSON.stringify({
      capability: this.capability,
      collapseId: request.collapseId,
      expiration: request.expiration,
      interruptionLevel: request.interruptionLevel,
      tp: { c: request.tp.c, k: request.tp.k, n: request.tp.n, v: request.tp.v },
    });
    if (!stillValid(request)) return CANCELLED;
    const first = await this.poster.post(url, body, this.timeoutMs);
    if (!shouldRetry(first)) return mapRelayResponse(first);
    await this.sleep(this.retryDelayMs);
    // 待つ間に取り消された通知（次のターンが始まった・設問が片付いた等）は再試行で送らない。
    if (!stillValid(request)) return CANCELLED;
    return mapRelayResponse(await this.poster.post(url, body, this.timeoutMs));
  }
}

const CANCELLED: PushSendResult = { status: "cancelled", detail: "cancelled" };

function stillValid(request: PushSendRequest): boolean {
  if (request.isStillValid === undefined) return true;
  try { return request.isStillValid(); } catch { return false; }
}

/** 5xx とタイムアウトだけ 1 回再試行する（設計 §9）。 */
function shouldRetry(result: JsonPostResult): boolean {
  if (!result.ok) return result.error === "timeout";
  return result.status >= 500 && result.status <= 599;
}

/** 契約 §4 のステータスを写像する。 */
export function mapRelayResponse(result: JsonPostResult): PushSendResult {
  if (!result.ok) return { status: "failed", detail: `relay-${result.error}` };
  switch (result.status) {
    case 200:
      return { status: "ok", detail: "relay-200" };
    case 400:
      return { status: "bad_request", detail: "relay-400" };
    case 401:
      return { status: "invalid_capability", detail: "relay-401" };
    case 410:
      return { status: "unregistered", detail: "relay-410" };
    case 413:
      return { status: "payload_too_large", detail: "relay-413" };
    case 429:
      return { status: "rate_limited", detail: "relay-429" };
    case 502: {
      const apnsStatus = parseApnsErrorStatus(result.body);
      return { status: "failed", detail: apnsStatus === null ? "relay-502" : `relay-502-apns-${apnsStatus}` };
    }
    default:
      return { status: "failed", detail: `relay-${result.status}` };
  }
}

function parseApnsErrorStatus(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const status = (parsed as Record<string, unknown>)["status"];
      if (typeof status === "number" && Number.isInteger(status)) return status;
    }
  } catch {
    // 本文が読めなくても 502 として扱う。
  }
  return null;
}

// MARK: - direct

export class DirectTransport implements PushTransport {
  readonly kind = "direct" as const;

  constructor(
    private readonly sender: ApnsSending,
    private readonly jwtProvider: APNsJWTProviding,
    private readonly topic: string,
    private readonly device: Pick<PushDeviceRecord, "deviceToken" | "environment">,
  ) {}

  async send(request: PushSendRequest): Promise<PushSendResult> {
    let jwt: string;
    try {
      jwt = this.jwtProvider.currentToken();
    } catch {
      return { status: "failed", detail: "jwt-unavailable" };
    }
    if (!stillValid(request)) return CANCELLED;
    const first = await this.sendOnce(request, jwt);
    if (first.ok || first.error.kind !== "expiredProviderToken") return mapApnsResult(first);
    if (!stillValid(request)) return CANCELLED;
    // JWT 失効: 作り直して 1 回だけ再試行する。
    this.jwtProvider.invalidate();
    try {
      jwt = this.jwtProvider.currentToken();
    } catch {
      return { status: "failed", detail: "jwt-unavailable" };
    }
    return mapApnsResult(await this.sendOnce(request, jwt));
  }

  private sendOnce(request: PushSendRequest, jwt: string): ReturnType<ApnsSending["send"]> {
    return this.sender.send({
      host: this.device.environment,
      deviceToken: this.device.deviceToken,
      bearerJWT: jwt,
      topic: this.topic,
      collapseId: request.collapseId,
      expiration: request.expiration,
      body: apnsPayloadBody(request.tp, request.interruptionLevel),
    });
  }
}

function mapApnsResult(result: Awaited<ReturnType<ApnsSending["send"]>>): PushSendResult {
  if (result.ok) return { status: "ok", detail: "apns-200" };
  const error = result.error;
  switch (error.kind) {
    case "unregistered":
      return { status: "unregistered", detail: "apns-unregistered" };
    case "expiredProviderToken":
      return { status: "failed", detail: "apns-expired-provider-token" };
    case "tooManyProviderTokenUpdates":
      return { status: "rate_limited", detail: "apns-429" };
    case "transport":
      return { status: "failed", detail: "apns-transport" };
    case "http":
      if (error.status === 413) return { status: "payload_too_large", detail: "apns-413" };
      if (error.status === 400) return { status: "bad_request", detail: "apns-400" };
      return { status: "failed", detail: `apns-${error.status}` };
  }
}
