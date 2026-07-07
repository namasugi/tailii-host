// approvalPushNotifier.ts
// tailii (TS host) — 承認 push 統括（Mac-owned）
// Swift 版 ApprovalPushNotifier.swift の移植。
//
// hook の connect 不能契機に、時間上限内で APNs 送信を統括する（Task 2.3 / Req 2.1）:
//   1. config 読込 → 欠落なら skipped(no-config) ＋ pushSkipped 観測（6.4）。
//   2. device token 読込 → 欠落なら skipped(no-token) ＋ pushSkipped 観測（3.5）。
//   3. バースト抑制（7.2）: send-log.json を見て最小間隔（既定 30s）内の同一セッション向けは
//      skipped(rate-limited) ＋ pushSkipped 観測。
//   4. 最小 payload（tool·session·approvalId のみ。diff/cwd/秘密なし）を組む（2.3/6.5）。
//   5. JWT を取得（未設定/署名失敗は failed に畳む）。
//   6. 送信（+ ExpiredProviderToken 時の再署名・1回再試行 / Unregistered 時の token 削除）。
//   7. 成功 → pushSent 観測 → sent。失敗 → pushFailed 観測 → failed。
//
// gate 非阻害: config/token 欠落・署名失敗・送信失敗・timeLimit 超過のいずれでも例外を
// hook に伝播させず PushOutcome に畳む。timeLimit 内に完了しなければ failed(transport("timeout"))。
// 相互排他（7.1）は呼び出し側（connect 不能ブランチのみ呼ぶ）で担保する。
//
// ネットワーク・時刻は全て注入式（テストは実物を叩かない）。秘密・diff は payload/ログに載せない。

import { ApnsConfigStore } from "./apnsConfigStore.js";
import { APNsJWTProvider, type APNsJWTProviding } from "./apnsJwtProvider.js";
import { APNsSender, type ApnsSending, Http2HttpClient } from "./apnsSender.js";
import { DeviceTokenStore, type DeviceTokenStoring } from "./deviceTokenStore.js";
import { ObservationLog } from "./observationLog.js";
import { defaultApnsBase, type PushError, pushPayloadBody } from "./pushTypes.js";
import { SendLog } from "./sendLog.js";

// MARK: - リクエスト / 結果型

/** connect 不能契機に push 送信を求める1件のリクエスト（最小情報のみ, 2.3/6.5）。 */
export interface ApprovalPushRequest {
  approvalId: string;
  tool: string;
  session: string;
}

/** push 送信を見送った理由。 */
export type SkipReason = "no-config" | "no-token" | "rate-limited";

/** notify(...) の結果。送信可否に関わらず必ず返る（gate 非阻害）。 */
export type PushOutcome =
  | { kind: "sent" }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "failed"; reason: PushError };

// MARK: - PushObserving

/** push 統括が観測ログへ記録する契約（送信/見送り/失敗）。秘密・diff は運ばない（6.5）。 */
export interface PushObserving {
  recordSent(id: string, tool: string, session: string): void;
  recordSkipped(id: string, reason: string, session: string): void;
  recordFailed(id: string, reason: string, session: string): void;
}

/** ObservationLog を包む本番 PushObserving 実体。追記失敗は握り潰す（gate 非阻害）。 */
export class ObservationLogPushObserver implements PushObserving {
  private readonly log: ObservationLog;
  private readonly now: () => number;

  constructor(base?: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.log = new ObservationLog(base);
    this.now = now;
  }

  recordSent(id: string, tool: string, session: string): void {
    try {
      this.log.append({ kind: "pushSent", id, tool }, session, this.now());
    } catch {
      /* 副次作業のため無視 */
    }
  }

  recordSkipped(id: string, reason: string, session: string): void {
    try {
      this.log.append({ kind: "pushSkipped", id, reason }, session, this.now());
    } catch {
      /* 副次作業のため無視 */
    }
  }

  recordFailed(id: string, reason: string, session: string): void {
    try {
      this.log.append({ kind: "pushFailed", id, reason }, session, this.now());
    } catch {
      /* 副次作業のため無視 */
    }
  }
}

// MARK: - ApprovalPushNotifier

/** バースト抑制の既定最小間隔（秒）。同一セッションへこの間隔内の連続送信は間引く（7.2）。 */
export const DEFAULT_MIN_INTERVAL_SECONDS = 30;

/** apns-expiration の既定（秒）。awareness 用に数分。 */
export const DEFAULT_EXPIRATION_SECONDS = 300;

export interface ApprovalPushNotifierDeps {
  configStore: ApnsConfigStore;
  tokenStore: DeviceTokenStoring;
  jwtProvider: APNsJWTProviding;
  sender: ApnsSending;
  observer: PushObserving;
  /** send-log.json の base。省略時は `~/.tailii/apns`。 */
  sendLogBase?: string;
  /** バースト抑制の最小間隔（秒）。省略時 30s。 */
  minInterval?: number;
  /** apns-expiration（秒）。省略時 300s。 */
  expiration?: number;
  /** 現在時刻（Unix 秒）を返す関数。rate-limit の決定化に使う。 */
  now?: () => number;
}

/**
 * connect 不能契機に APNs 送信を統括する実体（バースト抑制・観測記録・gate 非阻害）。
 * 協力者は注入し、テストは mock/spy を差し込む。now / send-log base を注入して rate-limit を決定化する。
 */
export class ApprovalPushNotifier {
  private readonly configStore: ApnsConfigStore;
  private readonly tokenStore: DeviceTokenStoring;
  private readonly jwtProvider: APNsJWTProviding;
  private readonly sender: ApnsSending;
  private readonly observer: PushObserving;
  private readonly sendLog: SendLog;
  private readonly minInterval: number;
  private readonly expiration: number;
  private readonly now: () => number;

  constructor(deps: ApprovalPushNotifierDeps) {
    this.configStore = deps.configStore;
    this.tokenStore = deps.tokenStore;
    this.jwtProvider = deps.jwtProvider;
    this.sender = deps.sender;
    this.observer = deps.observer;
    this.sendLog = new SendLog(deps.sendLogBase);
    this.minInterval = deps.minInterval ?? DEFAULT_MIN_INTERVAL_SECONDS;
    this.expiration = deps.expiration ?? DEFAULT_EXPIRATION_SECONDS;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * connect 不能契機の送信を統括する。timeLimit 内で完了を試み、超過しても PushOutcome に
   * 畳んで返す（gate 非阻害）。
   */
  async notify(req: ApprovalPushRequest, timeLimitMs: number): Promise<PushOutcome> {
    const timeoutOutcome: PushOutcome = {
      kind: "failed",
      reason: { kind: "transport", detail: "timeout" },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PushOutcome>((resolve) => {
      timer = setTimeout(() => resolve(timeoutOutcome), Math.max(0, timeLimitMs));
    });
    try {
      return await Promise.race([this.performNotify(req), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** timeLimit を除いた送信本体。 */
  private async performNotify(req: ApprovalPushRequest): Promise<PushOutcome> {
    // 1. config 未設定 → skipped(no-config)（6.4）
    const config = this.configStore.load();
    if (config === null) {
      this.observer.recordSkipped(req.approvalId, "no-config", req.session);
      return { kind: "skipped", reason: "no-config" };
    }

    // 2. device token 未保存 → skipped(no-token)（3.5）
    const tokenRecord = this.tokenStore.load();
    if (tokenRecord === null) {
      this.observer.recordSkipped(req.approvalId, "no-token", req.session);
      return { kind: "skipped", reason: "no-token" };
    }

    // 3. バースト抑制（7.2）: 同一セッションへ最小間隔内の連続送信を間引く。
    const currentTime = this.now();
    const last = this.sendLog.lastSent(req.session);
    if (last !== null && currentTime - last < this.minInterval && currentTime >= last) {
      this.observer.recordSkipped(req.approvalId, "rate-limited", req.session);
      return { kind: "skipped", reason: "rate-limited" };
    }

    // 5. JWT を取得（未設定/署名失敗は failed に畳む）。
    let jwt: string;
    try {
      jwt = this.jwtProvider.currentToken();
    } catch {
      this.observer.recordFailed(req.approvalId, "jwt-unavailable", req.session);
      return { kind: "failed", reason: { kind: "transport", detail: "jwt-unavailable" } };
    }

    // 6. 送信（+ ExpiredProviderToken 時の再署名・1回再試行 / Unregistered 時の token 削除）。
    const result = await this.sendWithRetry(
      { approvalId: req.approvalId, tool: req.tool, session: req.session },
      tokenRecord,
      config.topic,
      jwt,
    );

    if (result.ok) {
      // 送信成功 → send-log 更新（次回のバースト抑制に効かせる）＋ pushSent 観測。
      this.sendLog.record(req.session, currentTime);
      this.observer.recordSent(req.approvalId, req.tool, req.session);
      return { kind: "sent" };
    }
    this.observer.recordFailed(req.approvalId, reasonCode(result.error), req.session);
    return { kind: "failed", reason: result.error };
  }

  /**
   * APNs へ送信し、ExpiredProviderToken 時は JWT 無効化 → 再署名 → 1回だけ再試行する（6.2）。
   * Unregistered 時は device token を削除する（6.3）。
   */
  private async sendWithRetry(
    req: ApprovalPushRequest,
    token: { token: string; environment: "production" | "sandbox" },
    topic: string,
    jwt: string,
  ): Promise<{ ok: true } | { ok: false; error: PushError }> {
    const first = await this.sender.send(this.makeRequest(req, token, topic, jwt));
    if (first.ok) return { ok: true };

    if (first.error.kind === "expiredProviderToken") {
      // JWT を無効化し再署名して1回だけ再試行（6.2）。
      this.jwtProvider.invalidate();
      let fresh: string;
      try {
        fresh = this.jwtProvider.currentToken();
      } catch {
        return { ok: false, error: { kind: "transport", detail: "jwt-unavailable" } };
      }
      const retried = await this.sender.send(this.makeRequest(req, token, topic, fresh));
      if (!retried.ok && retried.error.kind === "unregistered") {
        this.tokenStore.delete();
      }
      return retried;
    }

    if (first.error.kind === "unregistered") {
      // 宛先未登録 → token 削除し以後停止（6.3）。
      this.tokenStore.delete();
      return { ok: false, error: { kind: "unregistered" } };
    }

    return first;
  }

  /** payload と JWT から ApnsRequest を組み立てる。collapse-id は approvalId で一意化（7.2/7.3）。 */
  private makeRequest(
    req: ApprovalPushRequest,
    token: { token: string; environment: "production" | "sandbox" },
    topic: string,
    jwt: string,
  ) {
    return {
      host: token.environment,
      deviceToken: token.token,
      bearerJWT: jwt,
      topic,
      collapseId: req.approvalId,
      expiration: this.expiration,
      body: pushPayloadBody(req.approvalId, req.tool, req.session),
    };
  }
}

/** PushError を観測ログ用の短い理由コードへ写像する（秘密を出さない, 6.5）。 */
export function reasonCode(error: PushError): string {
  switch (error.kind) {
    case "expiredProviderToken":
      return "ExpiredProviderToken";
    case "unregistered":
      return "Unregistered";
    case "tooManyProviderTokenUpdates":
      return "TooManyProviderTokenUpdates";
    case "transport":
      return "transport";
    case "http":
      return `http-${error.status}`;
  }
}

// MARK: - 本番 push notifier ファクトリ

/**
 * connect 不能時に用いる本番 push notifier を構築する（Swift 版 makeProductionPushNotifier 相当）。
 *
 * ApnsConfigStore / DeviceTokenStore / APNsJWTProvider / APNsSender(Http2HttpClient) /
 * ObservationLogPushObserver を既定パス（`~/.tailii/apns`, ObservationLog 既定）で束ねる。
 * 実際に送るかは notifier 内部が config/token の有無で判断する（未設定なら送らず観測記録, 3.5/6.4）。
 *
 * 返り値は hook.ts の `ApprovalPushNotifier` 型（`(req, timeLimitMs) => Promise<void>`）に適合する
 * アダプタ。送信可否（PushOutcome）は deny 判断に影響しないため捨てる（観測は内部で完結）。
 */
export function makeProductionPushNotifier(): (
  request: ApprovalPushRequest,
  timeLimitMs: number,
) => Promise<void> {
  const configStore = new ApnsConfigStore(defaultApnsBase());
  const notifier = new ApprovalPushNotifier({
    configStore,
    tokenStore: new DeviceTokenStore(defaultApnsBase()),
    jwtProvider: new APNsJWTProvider(configStore, { base: defaultApnsBase() }),
    sender: new APNsSender(new Http2HttpClient()),
    observer: new ObservationLogPushObserver(),
    sendLogBase: defaultApnsBase(),
  });
  return async (request, timeLimitMs) => {
    await notifier.notify(request, timeLimitMs);
  };
}
