// pushDispatcher.ts
// tailii (TS host) — プッシュ通知の送るかどうかの判断と送信（hub 内で動く）
//
// 設計 docs/push-notifications.md §5・§6・§9。流れ:
//   イベント → 種別ごとの設定（prefs）→ 間引き（種別 × 会話 30 秒）→ 在席判定 → 端末ごとに暗号化 → 送信
// - turn_done は 3 秒待ってから送る。その間に処理中へ戻ったら送らない（`scheduleTurnDone` / `cancelTurnDone`）。
// - 410 → 端末の記録を消す。401 → capability に無効の印（次の push_register_result で capabilityInvalid）。
// - 在席: 前面と申告した接続がある端末には presence_ping を送り 2 秒以内の pong を待つ（§6 の表）。
// hook が hub に届かないときは、同じクラスを hook プロセスで在席情報なしに動かす。
//
// 時刻・タイマー・送信・在席は注入できる（テストは決定的に動かす）。秘密はログ・観測に出さない。

import * as crypto from "node:crypto";
import { type ApnsConfig, ApnsConfigStore } from "./apnsConfigStore.js";
import { APNsJWTProvider, type APNsJWTProviding } from "./apnsJwtProvider.js";
import { APNsSender, Http2HttpClient } from "./apnsSender.js";
import { defaultApnsBase } from "./pushTypes.js";
import {
  defaultPushBase,
  normalizeDeviceId,
  type PushDeviceRecord,
  PushDeviceStore,
  type PushPrefs,
} from "./pushDeviceStore.js";
import { clipChars, decodePushKey, type PushKind, type PushPlaintext, sealPushContent } from "./pushEnvelope.js";
import { PushLastResultStore, type PushLastResult, PushSendLog } from "./pushStateFiles.js";
import {
  choosePushTransport,
  DirectTransport,
  FetchJsonPoster,
  type JsonPoster,
  type PushInterruptionLevel,
  type PushSendResult,
  type PushTransport,
  RelayTransport,
} from "./pushTransport.js";
import { ObservationLog } from "../shared/observationLog.js";

// MARK: - 種別ごとの定数

/** 種別 → 端末の prefs キー。 */
export const PUSH_PREF_FOR_KIND: Record<PushKind, keyof PushPrefs> = {
  turn_done: "turnDone",
  question: "question",
  approval: "approval",
  usage_limit: "usageLimit",
  turn_error: "turnError",
};

/** 割り込みの強さ（設計 §5）。 */
export const PUSH_INTERRUPTION_FOR_KIND: Record<PushKind, PushInterruptionLevel> = {
  turn_done: "active",
  question: "time-sensitive",
  approval: "time-sensitive",
  usage_limit: "active",
  turn_error: "active",
};

/** 有効期限（秒）。承認は hook の待機 540 秒に合わせて 10 分（設計 §5）。 */
export const PUSH_TTL_SECONDS_FOR_KIND: Record<PushKind, number> = {
  turn_done: 3600,
  question: 3600,
  approval: 600,
  usage_limit: 3600,
  turn_error: 3600,
};

/** 会話タイトルが取れないときの題名（種別の定型文）。 */
export const PUSH_FALLBACK_TITLE: Record<PushKind, string> = {
  turn_done: "作業が終わりました",
  question: "質問があります",
  approval: "承認待ち",
  usage_limit: "使用量制限",
  turn_error: "エラーで止まりました",
};

/** 本文を出さない端末・要約が取れないときの本文（種別の定型文）。 */
export const PUSH_FALLBACK_BODY: Record<PushKind, string> = {
  turn_done: "作業が完了しました",
  question: "回答を待っています",
  approval: "ツールの実行の承認を待っています",
  usage_limit: "使用量制限の状況が変わりました",
  turn_error: "エラーで作業が止まりました",
};

const TITLE_MAX_CHARS = 80;
const BODY_MAX_CHARS = 300;

/** 既定の間引き間隔（秒）。同じ種別・同じ会話へこの間隔内の連続送信は見送る。 */
export const PUSH_MIN_INTERVAL_SECONDS = 30;
/** turn_done を送るまでの待ち（ms）。 */
export const TURN_DONE_DELAY_MS = 3_000;
/** presence_ping の応答を待つ上限（ms）。 */
export const PRESENCE_PING_TIMEOUT_MS = 2_000;

/** `apns-collapse-id`: SHA-256(session + kind) の先頭（承認だけは approvalId 単位）。 */
export function pushCollapseId(kind: PushKind, session: string, id?: string): string {
  const seed = kind === "approval" && id !== undefined ? `approval:${id}` : session + kind;
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
}

// MARK: - 型

/** 送信の依頼 1 件。 */
export interface PushEventInput {
  kind: PushKind;
  session: string;
  /** 承認 id・設問 id など（平文の `id`。承認では collapse-id にも使う）。 */
  id?: string;
  /** 要約（本文を出す端末にだけ使う）。関数なら送る端末があるときだけ評価する。null は定型文。 */
  body?: string | null | (() => string | null);
  /** 観測ログ用のツール名（承認）。 */
  tool?: string;
  /**
   * 送る直前（在席確認の後）にもう一度確かめる前提（まだ処理中でない・設問がまだ出ている等）。
   * false なら送らない（在席確認の待ち最大 2 秒の間に状況が変わった通知を出さない）。
   */
  stillValid?: () => boolean;
  /**
   * 承認の本文が操作の全体を省略なく含む（hook・API 作業の橋渡しが要約を作った時点で決めた印）。true で、かつ端末が
   * 本文を出し、送る本文が 1 文字も切られていないときだけ、平文に `allow: true` を付ける（push v1.1 §6）。
   */
  bodyComplete?: boolean;
}

export type PresenceState = "foreground" | "background";

/** 在席判定に使う 1 接続分の情報（hub が組み立てる）。 */
export interface PushPresenceConnection {
  /** 接続の同一性（在席確認の後に最新の申告を引き直すのに使う）。省略時は接続ごとに別物とみなす。 */
  key?: unknown;
  /** 正規化済み（大文字）の deviceId。 */
  deviceId: string;
  state: PresenceState;
  /** その会話を前面で表示中か。 */
  viewing: boolean;
  /** presence_ping を送り、timeoutMs 以内に pong が返れば true。 */
  ping(timeoutMs: number): Promise<boolean>;
}

export interface PushPresenceSource {
  connections(session: string): PushPresenceConnection[];
}

export type PushOutcomeStatus = "sent" | "skipped" | "failed";

export interface PushDeviceOutcome {
  deviceId: string;
  status: PushOutcomeStatus;
  reason: string;
  transport?: "relay" | "direct";
}

export interface PushDispatchOutcome {
  status: PushOutcomeStatus;
  reason?: string;
  devices: PushDeviceOutcome[];
}

/** 観測ログの記録先（秘密・本文は渡さない）。 */
export interface PushDispatchObserver {
  recordSent(kind: PushKind, id: string, tool: string, session: string): void;
  recordSkipped(kind: PushKind, id: string, reason: string, session: string): void;
  recordFailed(kind: PushKind, id: string, reason: string, session: string): void;
}

/** 端末ストアのうち dispatcher が使う部分。 */
export type PushDeviceStorePort = Pick<PushDeviceStore, "list" | "deleteIfRevision" | "markCapabilityInvalid"> &
  Partial<Pick<PushDeviceStore, "refreshState">>;

export interface PushDispatcherOptions {
  store: PushDeviceStorePort;
  loadApnsConfig: () => ApnsConfig | null;
  /** 選んだ経路の送信器を作る。作れなければ null（その端末は failed）。 */
  createTransport: (choice: "relay" | "direct", device: PushDeviceRecord, config: ApnsConfig | null) => PushTransport | null;
  /** 種別 × 会話の間引き。送信前に原子的に権利を取り、送れなければ戻す（プロセス間で共有する）。 */
  sendLog?: Pick<PushSendLog, "lastSent" | "record">;
  lastResult?: Pick<PushLastResultStore, "save">;
  observer?: PushDispatchObserver;
  titleFor?: (session: string) => string | null;
  presence?: PushPresenceSource | null;
  nowMs?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  pingTimeoutMs?: number;
  turnDoneDelayMs?: number;
  minIntervalSeconds?: number;
  log?: (message: string) => void;
}

// MARK: - PushDispatcher

export class PushDispatcher {
  private readonly options: PushDispatcherOptions;
  private presence: PushPresenceSource | null;
  private readonly nowMs: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly pendingTurnDone = new Map<string, unknown>();
  /** 会話ごとの完了通知の世代。取り消しのたびに進め、満了後の送信途中でも取り消しを効かせる。 */
  private readonly turnDoneGeneration = new Map<string, number>();
  /** 送信中の「種別 × 会話」。並走した同じ通知は、最新の 1 件だけ保留して先行の処理の後に評価し直す。 */
  private readonly inFlight = new Set<string>();
  private readonly queued = new Map<string, { event: PushEventInput; resolve: (outcome: PushDispatchOutcome) => void }>();
  /** dispose 後は新しい通知を受け付けず、進行中の送信も次の試行の前に止める。 */
  private closed = false;

  constructor(options: PushDispatcherOptions) {
    this.options = options;
    this.presence = options.presence ?? null;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** hub が自分の接続一覧を在席の情報源として差し込む。 */
  setPresence(presence: PushPresenceSource | null): void {
    this.presence = presence;
  }

  /** 完了通知を 3 秒後に送る予約（同じ会話の予約は置き換える）。`isStillDone` が false なら送らない。 */
  scheduleTurnDone(
    session: string,
    options: { isStillDone: () => boolean; body?: () => string | null; id?: string },
  ): void {
    this.cancelTurnDone(session);
    if (this.closed) return;
    // 完了通知を受ける端末が無ければ予約もしない（transcript を読む手間を省く）。
    if (!this.hasAnyDeviceFor("turn_done")) return;
    const generation = this.turnDoneGeneration.get(session) ?? 0;
    const stillValid = (): boolean => {
      if ((this.turnDoneGeneration.get(session) ?? 0) !== generation) return false;
      try { return options.isStillDone(); } catch { return false; }
    };
    const handle = this.setTimer(() => {
      if (this.pendingTurnDone.get(session) !== handle) return;
      this.pendingTurnDone.delete(session);
      if (!stillValid()) {
        this.options.log?.(`push turn_done 見送り(処理再開) session=${session}`);
        return;
      }
      void this.notify({
        kind: "turn_done",
        session,
        // 在席確認（最大 2 秒）の後にも、処理中へ戻っていない・取り消されていないことを確かめる。
        stillValid,
        ...(options.id !== undefined ? { id: options.id } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
      }).catch(() => { /* notify は投げないが念のため。 */ });
    }, this.options.turnDoneDelayMs ?? TURN_DONE_DELAY_MS);
    this.pendingTurnDone.set(session, handle);
  }

  /** 予約中の完了通知を取り消す（処理中へ戻った・中断・エラー）。 */
  cancelTurnDone(session: string): void {
    this.turnDoneGeneration.set(session, (this.turnDoneGeneration.get(session) ?? 0) + 1);
    const handle = this.pendingTurnDone.get(session);
    if (handle === undefined) return;
    this.pendingTurnDone.delete(session);
    this.clearTimer(handle);
  }

  hasPendingTurnDone(session: string): boolean {
    return this.pendingTurnDone.has(session);
  }

  /**
   * 終了（hub の close）。予約を捨て、保留中の通知を見送りとして解き、以後の通知は受け付けない。
   * 進行中の送信は、次の送信の試行の前の有効性確認で止まる（既に出た要求は取り消せない）。
   */
  dispose(): void {
    this.closed = true;
    for (const handle of this.pendingTurnDone.values()) this.clearTimer(handle);
    this.pendingTurnDone.clear();
    for (const queued of this.queued.values()) queued.resolve({ status: "skipped", reason: "closed", devices: [] });
    this.queued.clear();
  }

  /** その種別を受ける端末が 1 台でもあるか。 */
  hasAnyDeviceFor(kind: PushKind): boolean {
    try {
      const pref = PUSH_PREF_FOR_KIND[kind];
      return this.options.store.list().some((device) => device.prefs[pref]);
    } catch {
      return false;
    }
  }

  /**
   * 1 件の通知を判断して送る。例外は投げず結果に畳む（呼び手の処理を阻害しない）。
   * 同じ種別・同じ会話の処理が進行中なら最新の 1 件だけ保留し、先行の処理が終わってから評価し直す
   * （設問の差し替えで、先行の q1 が在席確認中に片付いて q2 が出た場合に q2 を落とさない）。
   * 保留中にさらに新しいものが来たら、古い保留は superseded として見送る。
   */
  notify(event: PushEventInput): Promise<PushDispatchOutcome> {
    if (this.closed) return Promise.resolve({ status: "skipped", reason: "closed", devices: [] });
    const flightKey = `${event.kind}:${event.session}`;
    if (this.inFlight.has(flightKey)) {
      return new Promise((resolve) => {
        const previous = this.queued.get(flightKey);
        if (previous !== undefined) {
          const superseded: PushDispatchOutcome = { status: "skipped", reason: "superseded", devices: [] };
          this.record(previous.event, previous.event.id ?? previous.event.kind, superseded, undefined);
          previous.resolve(superseded);
        }
        this.queued.set(flightKey, { event, resolve });
      });
    }
    this.inFlight.add(flightKey);
    return this.notifyNow(event).finally(() => {
      this.inFlight.delete(flightKey);
      const next = this.queued.get(flightKey);
      if (next !== undefined && !this.closed) {
        this.queued.delete(flightKey);
        void this.notify(next.event).then(next.resolve);
      }
    });
  }

  private async notifyNow(event: PushEventInput): Promise<PushDispatchOutcome> {
    const observationId = event.id ?? event.kind;
    let outcome: PushDispatchOutcome;
    let transport: "relay" | "direct" | undefined;
    try {
      outcome = await this.dispatch(event);
      // 送れた経路（無ければ試した経路）を doctor に残す。
      transport = outcome.devices.find((device) => device.status === "sent")?.transport ??
        outcome.devices.find((device) => device.transport !== undefined)?.transport;
    } catch (error) {
      this.options.log?.(`push 送信の内部エラー kind=${event.kind} session=${event.session}: ${error instanceof Error ? error.name : "error"}`);
      outcome = { status: "failed", reason: "internal-error", devices: [] };
    }
    this.record(event, observationId, outcome, transport);
    return outcome;
  }

  private async dispatch(event: PushEventInput): Promise<PushDispatchOutcome> {
    const nowSeconds = Math.floor(this.nowMs() / 1000);
    const devices = this.options.store.list();
    if (devices.length === 0) return { status: "skipped", reason: "no-device", devices: [] };
    const pref = PUSH_PREF_FOR_KIND[event.kind];
    const wanted = devices.filter((device) => device.prefs[pref]);
    if (wanted.length === 0) return { status: "skipped", reason: "prefs-off", devices: [] };

    const minInterval = this.options.minIntervalSeconds ?? PUSH_MIN_INTERVAL_SECONDS;
    if (!this.stillValid(event)) return { status: "skipped", reason: "stale", devices: [] };
    // 間引き。同じ種別・会話の並走は notify の保留で 1 本ずつになり、記録は hub だけが持つ（プロセス間の排他は不要）。
    const last = this.options.sendLog?.lastSent(event.kind, event.session) ?? null;
    if (last !== null && nowSeconds >= last && nowSeconds - last < minInterval) {
      return { status: "skipped", reason: "rate-limited", devices: [] };
    }
    {
      const decisions = await this.presenceDecisions(wanted, event.session);
      const deviceOutcomes: PushDeviceOutcome[] = [];
      const targets: PushDeviceRecord[] = [];
      wanted.forEach((device, index) => {
        const decision = decisions[index]!;
        if (decision === "push") targets.push(device);
        else deviceOutcomes.push({ deviceId: device.deviceId, status: "skipped", reason: decision });
      });
      if (targets.length === 0) {
        return { status: "skipped", reason: deviceOutcomes[0]?.reason ?? "present", devices: deviceOutcomes };
      }
      // 在席確認を待つ間に前提が崩れた（処理が再開した・設問が片付いた等）なら送らない。
      if (!this.stillValid(event)) return { status: "skipped", reason: "stale", devices: deviceOutcomes };

      const title = this.resolveTitle(event);
      const body = targets.some((device) => device.prefs.showBody) ? this.resolveBody(event) : null;
      // 通知の上で許可してよい本文か（承認・作った時点の印・dispatcher の整形で 1 文字も変わっていない）。
      const bodyAllowsApproval = event.kind === "approval" && event.bodyComplete === true &&
        typeof event.body === "string" && body !== null && body === event.body;
      const config = this.safeLoadApnsConfig();
      const sent = await Promise.all(targets.map((device) =>
        this.sendToDevice(device, event, title, body, config, nowSeconds, bodyAllowsApproval)));
      deviceOutcomes.push(...sent);
      if (sent.some((result) => result.status === "sent")) {
        this.options.sendLog?.record(event.kind, event.session, Math.floor(this.nowMs() / 1000));
        return { status: "sent", devices: deviceOutcomes };
      }
      const failed = sent.find((result) => result.status === "failed");
      if (failed !== undefined) return { status: "failed", reason: failed.reason, devices: deviceOutcomes };
      return { status: "skipped", reason: sent[0]?.reason ?? "no-transport", devices: deviceOutcomes };
    }
  }

  private stillValid(event: PushEventInput): boolean {
    // 終了後（dispose）は何も送らない（進行中の送信の再試行も止める）。
    if (this.closed) return false;
    if (event.stillValid === undefined) return true;
    try { return event.stillValid(); } catch { return false; }
  }

  /**
   * 端末ごとの在席判定（設計 §6）。
   * - 前面の接続が無い（背景と申告済み・接続なし）→ push
   * - 前面の接続はあるが presence_ping に 2 秒で応えない → 不在とみなして push
   * - 応えた前面の接続がその会話を表示中 → client-viewing（何もしない）
   * - 応えた前面の接続が別の画面 → client-foreground（接続内のイベントでアプリがローカル通知を出す）
   * 全端末の ping をまとめて待ち、待ち終わった後に 1 回だけ接続一覧を引き直して全端末の判断を確定する
   * （先に応えた接続が、他の端末の応答待ちの間に背景を申告した・切れた場合に、古い応答で在席扱いにしない）。
   */
  private async presenceDecisions(devices: PushDeviceRecord[], session: string): Promise<("push" | "client-viewing" | "client-foreground")[]> {
    const connections = this.safeConnections(session);
    const timeoutMs = this.options.pingTimeoutMs ?? PRESENCE_PING_TIMEOUT_MS;
    const foregroundByDevice = devices.map((device) => {
      const deviceId = normalizeDeviceId(device.deviceId);
      return connections.filter((connection) => connection.deviceId === deviceId && connection.state === "foreground");
    });
    const answeredByDevice = await Promise.all(foregroundByDevice.map(async (foreground) => {
      const alive = await Promise.all(foreground.map((connection) => connection.ping(timeoutMs).catch(() => false)));
      return foreground.filter((_, index) => alive[index] === true);
    }));
    if (answeredByDevice.every((answered) => answered.length === 0)) return devices.map(() => "push");
    const latest = this.safeConnections(session);
    return devices.map((device, index) => {
      const deviceId = normalizeDeviceId(device.deviceId);
      const live = answeredByDevice[index]!
        .map((connection) => latest.find((candidate) => connection.key !== undefined && candidate.key === connection.key))
        .filter((connection): connection is PushPresenceConnection =>
          connection !== undefined && connection.deviceId === deviceId && connection.state === "foreground");
      if (live.length === 0) return "push";
      return live.some((connection) => connection.viewing) ? "client-viewing" : "client-foreground";
    });
  }

  private safeConnections(session: string): PushPresenceConnection[] {
    try {
      return this.presence?.connections(session) ?? [];
    } catch {
      return [];
    }
  }

  private async sendToDevice(
    snapshot: PushDeviceRecord,
    event: PushEventInput,
    title: string,
    body: string | null,
    config: ApnsConfig | null,
    nowSeconds: number,
    bodyAllowsApproval = false,
  ): Promise<PushDeviceOutcome> {
    // 在席確認の待ち（最大 2 秒）の間に登録解除・設定変更・鍵の更新があったかもしれない。送る直前の最新の記録で
    // 組み立て直す（登録が無い・その種別を切った → 送らない。本文を切った → 定型文。鍵・capability → 新しい値）。
    const latest = this.latestDevice(snapshot);
    if (latest === "unreadable") return { deviceId: snapshot.deviceId, status: "skipped", reason: "device-unreadable" };
    if (latest === null) return { deviceId: snapshot.deviceId, status: "skipped", reason: "unregistered" };
    const device = latest;
    if (!device.prefs[PUSH_PREF_FOR_KIND[event.kind]]) return { deviceId: device.deviceId, status: "skipped", reason: "prefs-off" };
    const choice = choosePushTransport(device, config, nowSeconds);
    if (choice === "none") {
      const reason = device.relay?.invalid === true
        ? "capability-invalid"
        : device.relay !== undefined && device.relay.expiresAt <= nowSeconds ? "capability-expired" : "no-transport";
      return { deviceId: device.deviceId, status: "skipped", reason };
    }
    const key = decodePushKey(device.pushKey);
    if (key === null) return { deviceId: device.deviceId, status: "failed", reason: "push-key-invalid" };
    const transport = this.options.createTransport(choice, device, config);
    if (transport === null) return { deviceId: device.deviceId, status: "failed", reason: "transport-unavailable", transport: choice };
    const plaintext: PushPlaintext = {
      kind: event.kind,
      session: event.session,
      title,
      body: device.prefs.showBody && body !== null ? body : PUSH_FALLBACK_BODY[event.kind],
      ...(event.id !== undefined ? { id: event.id } : {}),
      // 本文を出さない端末には定型文を送るので許可させない。暗号化の前の切り詰めでも外れる（pushEnvelope）。
      ...(bodyAllowsApproval && device.prefs.showBody && body !== null ? { allow: true } : {}),
      ts: nowSeconds,
    };
    let result: PushSendResult;
    try {
      result = await transport.send({
        tp: sealPushContent(key, plaintext),
        interruptionLevel: PUSH_INTERRUPTION_FOR_KIND[event.kind],
        collapseId: pushCollapseId(event.kind, event.session, event.id),
        expiration: nowSeconds + PUSH_TTL_SECONDS_FOR_KIND[event.kind],
        // 各送信の試行（再試行を含む）の直前にも前提と端末の最新の記録を確かめる。組み立てた後に登録・設定・鍵が
        // 変わっていたら、その試行は中止する（利用者が切った設定に反して古い内容で送らない）。
        isStillValid: () => this.stillValid(event) && this.deliveryUnchanged(device, event.kind, choice, config),
      });
    } catch {
      result = { status: "failed", detail: "transport-exception" };
    }
    if (result.status === "ok") return { deviceId: device.deviceId, status: "sent", reason: result.detail, transport: choice };
    if (result.status === "cancelled") return { deviceId: device.deviceId, status: "skipped", reason: "stale", transport: choice };
    if (result.status === "unregistered") {
      // 宛先が消えた（アプリ削除・token 失効）。記録を消して以後送らない。
      // 送信を始めた時点の版のままのときだけ消す（送信中に再登録された記録は消さない）。
      if (this.options.store.deleteIfRevision(device.deviceId, device.revision)) {
        this.options.log?.(`push 宛先消滅のため端末記録を削除 transport=${choice}`);
      }
    } else if (result.status === "invalid_capability" && choice === "relay" && device.relay !== undefined) {
      // capability が無効。印を付け、次の push_register_result で取り直しを促す。
      // 送信を始めた時点の版・capability のままのときだけ印を付ける（送信中の再登録を潰さない）。
      if (this.options.store.markCapabilityInvalid(device.deviceId, device.relay.capability, device.revision)) {
        this.options.log?.("push capability 無効の印を付けた");
      }
    }
    return { deviceId: device.deviceId, status: "failed", reason: result.detail, transport: choice };
  }

  /**
   * 端末の最新の記録。ファイルが無ければ null、読めなければ "unreadable"（その試行は中止。メモリの記録は残る）。
   * ストアが読み直しに対応していなければ一覧を取った時点の記録。
   */
  private latestDevice(device: PushDeviceRecord): PushDeviceRecord | null | "unreadable" {
    const refreshState = this.options.store.refreshState;
    if (refreshState === undefined) return device;
    try {
      const state = refreshState.call(this.options.store, device.deviceId);
      if (state.state === "present") return state.record;
      return state.state === "absent" ? null : "unreadable";
    } catch {
      return "unreadable";
    }
  }

  /**
   * 組み立てに使った記録と、送る内容を左右する欄が同じままか。revision は比べない（接続のたびの同じ内容の
   * 再登録で revision だけ変わっても、必要な再試行を止めない。revision は 410 / 401 から登録を守る用途だけ）。
   */
  private deliveryUnchanged(used: PushDeviceRecord, kind: PushKind, choice: "relay" | "direct", config: ApnsConfig | null): boolean {
    const latest = this.latestDevice(used);
    if (latest === null || latest === "unreadable") return false;
    // 経路の有効性も今の時刻で確かめ直す（capability の期限切れ・無効の印で経路が無くなっていれば送らない）。
    if (choosePushTransport(latest, config, Math.floor(this.nowMs() / 1000)) !== choice) return false;
    return latest.prefs[PUSH_PREF_FOR_KIND[kind]] && latest.prefs.showBody === used.prefs.showBody &&
      latest.pushKey === used.pushKey && latest.deviceToken === used.deviceToken &&
      latest.environment === used.environment && latest.bundleId === used.bundleId &&
      latest.relay?.capability === used.relay?.capability && latest.relay?.url === used.relay?.url &&
      latest.relay?.invalid === used.relay?.invalid;
  }

  private resolveTitle(event: PushEventInput): string {
    let title: string | null = null;
    try {
      title = this.options.titleFor?.(event.session) ?? null;
    } catch {
      title = null;
    }
    const trimmed = title?.replace(/\s+/gu, " ").trim() ?? "";
    return trimmed.length > 0 ? clipChars(trimmed, TITLE_MAX_CHARS) : PUSH_FALLBACK_TITLE[event.kind];
  }

  private resolveBody(event: PushEventInput): string | null {
    let body: string | null | undefined;
    try {
      body = typeof event.body === "function" ? event.body() : event.body;
    } catch {
      body = null;
    }
    const trimmed = body?.trim() ?? "";
    return trimmed.length > 0 ? clipChars(trimmed, BODY_MAX_CHARS) : null;
  }

  private safeLoadApnsConfig(): ApnsConfig | null {
    try {
      return this.options.loadApnsConfig();
    } catch {
      return null;
    }
  }

  private record(
    event: PushEventInput,
    observationId: string,
    outcome: PushDispatchOutcome,
    transport: "relay" | "direct" | undefined,
  ): void {
    const reason = outcome.reason ?? (outcome.status === "sent" ? "sent" : "unknown");
    try {
      if (outcome.status === "sent") this.options.observer?.recordSent(event.kind, observationId, event.tool ?? event.kind, event.session);
      else if (outcome.status === "skipped") this.options.observer?.recordSkipped(event.kind, observationId, reason, event.session);
      else this.options.observer?.recordFailed(event.kind, observationId, reason, event.session);
    } catch {
      // 観測は副次作業。
    }
    // 端末が無い・設定で切っている間の見送りは doctor の「最後の送信結果」を上書きしない（実際の送信の結果を残す）。
    if (outcome.status === "skipped" && (reason === "no-device" || reason === "prefs-off")) return;
    const last: PushLastResult = {
      at: Math.floor(this.nowMs() / 1000),
      kind: event.kind,
      status: outcome.status,
      ...(outcome.status !== "sent" ? { reason } : {}),
      ...(transport !== undefined ? { transport } : {}),
    };
    try { this.options.lastResult?.save(last); } catch { /* doctor 用。 */ }
    this.options.log?.(
      `push ${outcome.status} kind=${event.kind} session=${event.session}` +
        (outcome.status !== "sent" ? ` reason=${reason}` : "") +
        (transport !== undefined ? ` transport=${transport}` : "") +
        ` devices=${outcome.devices.length}`,
    );
  }
}

// MARK: - 観測ログ

/** ObservationLog へ kind 付きで記録する本番の観測先。追記失敗は握り潰す。 */
export class ObservationLogPushDispatchObserver implements PushDispatchObserver {
  private readonly log: ObservationLog;
  private readonly now: () => number;

  constructor(base?: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.log = new ObservationLog(base);
    this.now = now;
  }

  recordSent(kind: PushKind, id: string, tool: string, session: string): void {
    try { this.log.append({ kind: "pushSent", id, tool, pushKind: kind }, session, this.now()); } catch { /* 副次作業。 */ }
  }

  recordSkipped(kind: PushKind, id: string, reason: string, session: string): void {
    try { this.log.append({ kind: "pushSkipped", id, reason, pushKind: kind }, session, this.now()); } catch { /* 副次作業。 */ }
  }

  recordFailed(kind: PushKind, id: string, reason: string, session: string): void {
    try { this.log.append({ kind: "pushFailed", id, reason, pushKind: kind }, session, this.now()); } catch { /* 副次作業。 */ }
  }
}

// MARK: - 本番の組み立て

export interface ProductionPushDispatcherOptions {
  titleFor?: (session: string) => string | null;
  presence?: PushPresenceSource | null;
  log?: (message: string) => void;
  /** リレーへの 1 回の要求の上限（ms）。既定 8000。hook のフォールバックは短くする。 */
  relayTimeoutMs?: number;
  /** テスト用の差し替え（既定 `~/.tailii/push` / `~/.tailii/apns`）。 */
  pushBase?: string;
  apnsBase?: string;
  /** hub が持つ端末記録（hub は登録の処理と共有する）。省略時は新しく読み込む。 */
  store?: PushDeviceStore;
  /** リレーへの HTTP（テスト注入用。既定は fetch）。 */
  poster?: JsonPoster;
  /**
   * hook の自前送信（hub が居ないときだけ）。端末記録は読むだけで、401 / 410 を受けても触れない（次に hub が
   * 送るときに同じ応答を受けて片付く）。間引きの記録・最後の送信結果も書かない（書き手は hub だけ）。
   */
  readOnly?: boolean;
}

/** 既定パスと本番の送信器で dispatcher を組み立てる（hub daemon と hook のフォールバックが使う）。 */
export function createProductionPushDispatcher(options: ProductionPushDispatcherOptions = {}): PushDispatcher {
  const pushBase = options.pushBase ?? defaultPushBase();
  const apnsBase = options.apnsBase ?? defaultApnsBase();
  const configStore = new ApnsConfigStore(apnsBase);
  let jwtProvider: APNsJWTProviding | null = null;
  const poster = options.poster ?? new FetchJsonPoster();
  const store = options.store ?? new PushDeviceStore({ base: pushBase, legacyApnsBase: apnsBase });
  const readOnly = options.readOnly === true;
  return new PushDispatcher({
    store: readOnly
      ? { list: () => store.list(), refreshState: (deviceId: string) => store.refreshState(deviceId), deleteIfRevision: () => false, markCapabilityInvalid: () => false }
      : store,
    loadApnsConfig: () => configStore.load(),
    createTransport: (choice, device, config) => {
      if (choice === "relay") {
        return device.relay === undefined
          ? null
          : new RelayTransport(device.relay.url, device.relay.capability, poster,
            options.relayTimeoutMs !== undefined ? { timeoutMs: options.relayTimeoutMs } : {});
      }
      if (config === null) return null;
      jwtProvider ??= new APNsJWTProvider(configStore, { base: apnsBase });
      return new DirectTransport(new APNsSender(new Http2HttpClient()), jwtProvider, config.topic, device);
    },
    ...(readOnly ? {} : { sendLog: new PushSendLog(pushBase), lastResult: new PushLastResultStore(pushBase) }),
    observer: new ObservationLogPushDispatchObserver(),
    ...(options.titleFor !== undefined ? { titleFor: options.titleFor } : {}),
    ...(options.presence !== undefined ? { presence: options.presence } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
}
