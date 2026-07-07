// apnsSender.ts
// tailii (TS host) — APNs HTTP/2 送信・応答写像
// Swift 版 APNsSender.swift の移植。
//
// 保存済み JWT / device token 宛に APNs へ HTTP/2 で直送する。
//   `POST https://{host}/3/device/{deviceToken}` に、ヘッダ
//     `authorization: bearer <jwt>`, `apns-topic: <topic>`, `apns-push-type: alert`,
//     `apns-priority: 10`, `apns-expiration: <int>`, `apns-collapse-id: <collapseId>`
//   を載せ、最小 payload の本文を POST する（Requirement 2.2, 7.3）。
//
//   応答写像（Requirement 6.2, 6.3）:
//     200                                     → success
//     403 reason=ExpiredProviderToken         → expiredProviderToken（JWT 再発行, 6.2）
//     410 / 400 BadDeviceToken                → unregistered（宛先削除・停止, 6.3）
//     429 (TooManyProviderTokenUpdates)       → tooManyProviderTokenUpdates
//     その他非200                             → http(status, reason)
//     転送層失敗（ネットワーク/timeout）        → transport(String)
//
// HTTP クライアントは注入（HTTPPosting）。テストは canned (status, body) を返す mock を注入し、
// 本番は `node:http2` を用いる Http2HttpClient を注入する（Node の fetch は HTTP/2 非対応）。
// 秘密（JWT/token）はログに出さない（6.5）。

import * as http2 from "node:http2";
import { type ApnsHost, apnsSendHost, type PushError } from "./pushTypes.js";

/** HTTP POST の結果（成功時は status+body、転送層失敗時は error）。 */
export type HttpPostResult =
  | { ok: true; status: number; body: Buffer }
  | { ok: false; error: Error };

/** APNs への HTTP POST を抽象化する注入可能クライアント契約。 */
export interface HTTPPosting {
  post(url: string, headers: Record<string, string>, body: Buffer): Promise<HttpPostResult>;
}

/** APNs リクエスト1件分の宛先・認証・トピック・dedup・期限・本文。 */
export interface ApnsRequest {
  /** 送信先環境（production / sandbox）。送信ホスト選択に使う。 */
  host: ApnsHost;
  /** 宛先 device token（hex）。URL パスに用いる。 */
  deviceToken: string;
  /** `authorization: bearer <jwt>` に用いる APNs プロバイダ JWT。 */
  bearerJWT: string;
  /** `apns-topic`（= bundle id）。 */
  topic: string;
  /** `apns-collapse-id`（= approvalId）。同一承認の重複表示を抑止する（7.2/7.3）。 */
  collapseId: string;
  /** `apns-expiration`（Unix 秒 or 相対秒。awareness 用に数分）。 */
  expiration: number;
  /** リクエスト本文（aps + 最小カスタムキー）。 */
  body: Buffer;
}

/** APNs 送信の結果（200 なら ok、それ以外は写像した PushError）。 */
export type ApnsSendResult = { ok: true } | { ok: false; error: PushError };

/** APNs 送信の契約。応答を PushError に写像する。 */
export interface ApnsSending {
  send(req: ApnsRequest): Promise<ApnsSendResult>;
}

/**
 * 注入した HTTPPosting で APNs へ POST し、応答を PushError へ写像する実体。
 * URL・method・ヘッダ組み立てと応答分類のみを担い、実 I/O と HTTP/2 は注入クライアントに委譲する。
 */
export class APNsSender implements ApnsSending {
  constructor(private readonly client: HTTPPosting) {}

  async send(req: ApnsRequest): Promise<ApnsSendResult> {
    // URL: https://{host}/3/device/{deviceToken}
    const url = `https://${apnsSendHost(req.host)}/3/device/${req.deviceToken}`;

    // 必須ヘッダ一式。
    const headers: Record<string, string> = {
      authorization: `bearer ${req.bearerJWT}`,
      "apns-topic": req.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(req.expiration),
      "apns-collapse-id": req.collapseId,
    };

    const result = await this.client.post(url, headers, req.body);
    if (!result.ok) {
      // 転送層の失敗（ネットワーク / timeout）。
      return { ok: false, error: { kind: "transport", detail: result.error.message } };
    }
    return mapResponse(result.status, result.body);
  }
}

/**
 * HTTP ステータスとレスポンス本文（`{"reason":"..."}`）を ApnsSendResult に写像する。
 * - 200 → ok / 403 ExpiredProviderToken → expiredProviderToken /
 *   410・400 BadDeviceToken → unregistered / 429 → tooManyProviderTokenUpdates /
 *   その他 → http(status, reason)。
 */
export function mapResponse(status: number, body: Buffer): ApnsSendResult {
  if (status === 200) return { ok: true };

  const reason = parseReason(body);

  if (status === 403 && reason === "ExpiredProviderToken") {
    return { ok: false, error: { kind: "expiredProviderToken" } };
  }
  if (status === 410) {
    // 410 は宛先未登録（Unregistered）。reason 有無に関わらず宛先除外。
    return { ok: false, error: { kind: "unregistered" } };
  }
  if (status === 400 && reason === "BadDeviceToken") {
    return { ok: false, error: { kind: "unregistered" } };
  }
  if (status === 429) {
    // TooManyProviderTokenUpdates（reason 有無に関わらず）。
    return { ok: false, error: { kind: "tooManyProviderTokenUpdates" } };
  }
  return { ok: false, error: { kind: "http", status, reason } };
}

/** APNs エラー JSON（`{"reason":"..."}`）から reason を取り出す（不能・欠落時は空文字）。 */
function parseReason(body: Buffer): string {
  try {
    const obj = JSON.parse(body.toString("utf8")) as unknown;
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      const reason = (obj as Record<string, unknown>)["reason"];
      if (typeof reason === "string") return reason;
    }
  } catch {
    // パース不能 → 空文字（分類は status に委ねる）。
  }
  return "";
}

/**
 * `node:http2` を用いる本番 HTTPPosting 実体。
 * https 宛の APNs は HTTP/2 が必須のため、Node の fetch（HTTP/1.1 のみ）ではなく
 * http2.connect で送る。テストではネットワークに触れないよう mock を注入し、本実体は実機/E2E で用いる。
 */
export class Http2HttpClient implements HTTPPosting {
  /** リクエストごとの時間上限（ms）。到達で転送層失敗に畳む。 */
  private readonly requestTimeoutMs: number;

  constructor(requestTimeoutMs = 10_000) {
    this.requestTimeoutMs = requestTimeoutMs;
  }

  post(url: string, headers: Record<string, string>, body: Buffer): Promise<HttpPostResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: HttpPostResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }

      const session = http2.connect(parsed.origin);
      session.on("error", (error) => {
        finish({ ok: false, error });
        session.close();
      });

      const req = session.request({
        ":method": "POST",
        ":path": parsed.pathname + parsed.search,
        ...headers,
      });
      req.setTimeout(this.requestTimeoutMs, () => {
        finish({ ok: false, error: new Error("APNs request timeout") });
        req.close(http2.constants.NGHTTP2_CANCEL);
        session.close();
      });

      let status = 0;
      req.on("response", (responseHeaders) => {
        status = Number(responseHeaders[":status"]) || 0;
      });
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        finish({ ok: true, status, body: Buffer.concat(chunks) });
        session.close();
      });
      req.on("error", (error) => {
        finish({ ok: false, error });
        session.close();
      });

      req.end(body);
    });
  }
}
