// codexAppServer.ts
// Tailii host が共有 Codex App Server を再利用・起動し、thread ID を先に確定する最小クライアント。

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket, { type RawData } from "ws";
import { ensureDirectory0700 } from "../shared/paths.js";
import type { CodexCollaborationMode, CodexGoalInfo, CodexModelInfo } from "../protocol.js";
import {
  defaultCodexAppServerProcessControl,
  type CodexAppServerProcessControl,
} from "./codexAppServerProcess.js";

const THREAD_TITLE_MODEL = "gpt-5.6-luna";
const THREAD_TITLE_PROMPT_MAX_LENGTH = 2_000;
const THREAD_TITLE_MAX_LENGTH = 36;
const THREAD_TITLE_FALLBACK_MAX_LENGTH = 60;
const DEFAULT_TITLE_GENERATION_TIMEOUT_MS = 30_000;
/** thread/items/list の 1 ページ当たり件数（server は 1..100 に clamp する。turns/list は常に limit 1）。 */
const THREAD_HISTORY_PAGE_LIMIT = 100;
/** 履歴ページングの上限ページ数（100 件 × 2000 ページ）。cursor が進まない版でも無限ループしない。 */
const THREAD_HISTORY_MAX_PAGES = 2_000;
/** 全履歴の取得で送信経路を塞がないための総時間上限。超過時は別接続で制御を復旧する。 */
const THREAD_HISTORY_SNAPSHOT_TIMEOUT_MS = 3_000;
/** タイトル生成で最初の user prompt を探す上限ページ数（paginated の thread/items/list）。 */
const THREAD_TITLE_PROMPT_MAX_PAGES = 4;
const THREAD_TITLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: THREAD_TITLE_MAX_LENGTH },
    description: { type: "string", minLength: 1 },
  },
  required: ["title", "description"],
  additionalProperties: false,
} as const;
const THREAD_TITLE_CONFIG = {
  model_reasoning_effort: "low",
  "features.enable_fanout": false,
  "features.hooks": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.plugins": false,
  "features.tool_suggest": false,
  "features.apps": false,
  apps: {
    _default: {
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    },
  },
  web_search: "disabled",
} as const;

/** `thread/goal/set` / `clear` の `origin`（Codex 0.161+ の `ThreadGoalMutationOrigin`）。 */
const GOAL_MUTATION_ORIGIN_USER = "user";

/** `codex --version` の結果を使い回す時間。長寿命の hub でも CLI の更新に追従させる。 */
const DEFAULT_CLI_VERSION_TTL_MS = 60_000;
/**
 * 版ずれ daemon の入れ替えを「使用中」で保留した後、再判定するまでの間。最後の購読者が去った thread は
 * unload されるまで読み込まれたまま（=使用中）に見える。unload までの時間は codex の版で違い、0.153 以前は
 * 固定 30 分、0.154〜0.162 は既定 60 秒、0.163.0 から既定 1800 秒（`thread_unload_delay_secs`）。共有 daemon の
 * 全クライアントに効く設定なので Tailii からは変えない（0.163 の 1800 秒は multi-agent v2 の子の idle
 * cleanup のため。短くすると turn 前の thread が早く消える）。
 */
const STALE_SERVER_BUSY_RECHECK_MS = 30_000;
/** 入れ替えを試した後（成否問わず）・見送った後に、この process が再判定するまでの間。 */
const STALE_SERVER_RETRY_MS = 10 * 60_000;
/**
 * 同じ組み合わせ（旧版→CLI 版）の入れ替えを試した記録があれば、別 process も含めてこの間は繰り返さない
 * （見送りの記録は STALE_SERVER_RETRY_MS）。外部の監視が旧版を立て直す環境で止め続けないため。
 */
const STALE_SERVER_REPEAT_BACKOFF_MS = 6 * 60 * 60_000;
/** `ensureRunning` を通った呼び出しを「使用中」とみなす時間（thread/resume が終わるまでを覆う）。 */
const DAEMON_USE_MARKER_TTL_MS = 30_000;
/** 旧 daemon に SIGTERM を送ってから SIGKILL へ切り替えるまで。 */
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
/** SIGKILL 後に終了を待つ時間。 */
const KILL_WAIT_MS = 1_000;
/** 入れ替え直前の再確認までの間。開きかけの会話（thread/resume 中）を拾うため。 */
const DEFAULT_REPLACE_GRACE_MS = 250;
/**
 * startup lock がこれより古ければ、持ち主の pid が生きていても放棄済みとみなす
 * （pid の再利用・刺さった持ち主）。起動待ち 10 秒 + 停止待ち 4 秒より十分長くする。
 */
const STARTUP_LOCK_STALE_MS = 60_000;
/**
 * 印・記録・lock の経過時間がこれより負なら、時計が戻ったとみなして古いものとして扱う。ファイルの
 * 時刻はミリ秒未満まで持つので、作った直後は Date.now との差がわずかに負になる。それは新しい扱いにする。
 */
const CLOCK_ROLLBACK_TOLERANCE_MS = 5_000;

type ReplaceRecordResult =
  | "attempted"
  | "replaced"
  | "stop-failed"
  | "start-failed"
  | "version-mismatch"
  | "skipped";

export type CodexAppServerSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAppServerApprovalPolicy = "untrusted" | "on-request" | "never";

export interface CodexThreadStartOptions {
  cwd: string;
  model?: string | null;
  sandbox?: CodexAppServerSandbox | null;
}

export interface CodexThreadTitleGenerationOptions {
  threadId: string;
  cwd: string;
  prompt: string;
}

export type CodexThreadTitleSource = "model" | "promptFallback";

export interface CodexThreadTitleGenerationResult {
  title: string | null;
  source: CodexThreadTitleSource | null;
}

export type CodexAppServerRequestId = number | string;

export interface CodexAppServerNotification {
  method: string;
  params: unknown;
}

export interface CodexAppServerRequest extends CodexAppServerNotification {
  id: CodexAppServerRequestId;
}

export interface CodexAppServerThreadOptions {
  threadId: string;
  cwd?: string | null;
  onNotification?: (notification: CodexAppServerNotification) => void;
  onServerRequest?: (request: CodexAppServerRequest) => Promise<unknown>;
  onDisconnect?: (error: Error) => void;
}

/** テスト差し替え可能なApp Server 1接続分。 */
export interface CodexAppServerConnection {
  /** initialize 応答（`userAgent` 等）を返す。診断用で、void を返す実装でもよい。 */
  initialize(): Promise<unknown>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  onNotification(handler: (notification: CodexAppServerNotification) => void): () => void;
  onServerRequest(handler: (request: CodexAppServerRequest) => void): () => void;
  onDisconnect?(handler: (error: Error) => void): () => void;
  respond(id: CodexAppServerRequestId, result: unknown): void;
  respondError(id: CodexAppServerRequestId, code: number, message: string): void;
  close(): void;
}

export type CodexAppServerConnect = (
  socketPath: string,
  requestTimeoutMs?: number,
) => Promise<CodexAppServerConnection>;
export type CodexAppServerLaunch = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** Unix socket 上のWebSocketを使うJSON-RPC接続。 */
class WebSocketCodexAppServerConnection implements CodexAppServerConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<
    (notification: CodexAppServerNotification) => void
  >();
  private readonly serverRequestHandlers = new Set<(request: CodexAppServerRequest) => void>();
  private readonly disconnectHandlers = new Set<(error: Error) => void>();
  private disconnected = false;

  private constructor(private readonly socket: WebSocket, private readonly requestTimeoutMs: number) {
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => this.disconnect(new Error("Codex App Server connection closed")));
    socket.on("error", (error) => this.disconnect(error));
  }

  static connect(socketPath: string, requestTimeoutMs = 5_000): Promise<CodexAppServerConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://localhost/", {
        createConnection: () => net.createConnection(socketPath),
        // CodexのUnix control socketはWebSocket拡張を交渉しない。ws既定の
        // permessage-deflateを送るとRust側がhandshakeを拒否する。
        perMessageDeflate: false,
      });
      // handshake にも期限を切る。UNIX socket は listen backlog がある限りカーネルが接続を
      // 受理するため、app-server が「死んでいる」のではなく「応答不能（刺さっている）」場合は
      // open も error も発火せず Promise が永久に settle しない。これを直列 await する
      // engine の read loop と hub の tick ループが同時に止まる（request 側には期限があるのに
      // connect だけ素通しだった非対称の解消）。
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      const onError = (error: Error): void => {
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        socket.removeListener("open", onOpen);
        reject(error);
      };
      const onOpen = (): void => {
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        socket.removeListener("error", onError);
        resolve(new WebSocketCodexAppServerConnection(socket, requestTimeoutMs));
      };
      socket.once("error", onError);
      socket.once("open", onOpen);
      handshakeTimer = setTimeout(() => {
        socket.removeListener("open", onOpen);
        socket.removeListener("error", onError);
        // terminate は基底ソケットを破棄するため ECONNRESET 等の "error" を後追いで
        // 発火しうる。リスナー不在の EventEmitter "error" は throw になるので、
        // 捨てる先を必ず用意してから落とす。
        socket.on("error", () => {});
        socket.terminate();
        reject(new Error("Codex App Server handshake timed out"));
      }, requestTimeoutMs);
    });
  }

  async initialize(): Promise<unknown> {
    const response = await this.request("initialize", {
      clientInfo: { name: "tailii_host", title: "Tailii Host", version: "0.1.1" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", undefined);
    return response;
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }

  onNotification(handler: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: (request: CodexAppServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  respond(id: CodexAppServerRequestId, result: unknown): void {
    this.socket.send(JSON.stringify({ id, result }));
  }

  respondError(id: CodexAppServerRequestId, code: number, message: string): void {
    this.socket.send(JSON.stringify({ id, error: { code, message } }));
  }

  private notify(method: string, params: unknown): void {
    const message: Record<string, unknown> = { method };
    if (params !== undefined) message["params"] = params;
    this.socket.send(JSON.stringify(message));
  }

  private onMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    const id = message["id"];
    const method = message["method"];
    // 双方向 JSON-RPC では client request と server request の id 名前空間が別なので、
    // `method` の有無を先に見る。数値 id だけで response と判定すると衝突し得る。
    if (typeof method === "string") {
      const notification: CodexAppServerNotification = {
        method,
        params: message["params"],
      };
      if (typeof id === "number" || typeof id === "string") {
        for (const handler of this.serverRequestHandlers) handler({ ...notification, id });
      } else {
        for (const handler of this.notificationHandlers) handler(notification);
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message["error"];
    if (typeof error === "object" && error !== null) {
      const text = (error as Record<string, unknown>)["message"];
      pending.reject(new Error(typeof text === "string" ? text : "Codex App Server request failed"));
      return;
    }
    pending.resolve(message["result"]);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private disconnect(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.rejectPending(error);
    for (const handler of this.disconnectHandlers) handler(error);
  }
}

/** 1 thread を購読し、Tailii から turn を開始する長寿命 App Server 接続。 */
export class CodexAppServerThread {
  /** 読み取り専用の readiness 確認だけは、共有 App Server の一時的な混雑を自動回復する。 */
  // 初回5秒 + 再試行2秒に抑え、上位の15秒 Hub RPC に turn/start の予算を残す。
  private static readonly activeTurnReadMaxAttempts = 2;
  private static readonly activeTurnReadRetryTimeoutMs = 2_000;

  /** null=未判定、true=stable ID対応、false=旧App ServerなのでIDなしsteerへ固定。 */
  private supportsSteerClientUserMessageId: boolean | null = null;

  /**
   * thread の現在モデル / effort（購読応答と `thread/settings/updated` で追従）。collaboration mode の
   * `settings.model` は必須文字列で、違う値を渡すとその turn からモデルが切り替わってしまうため、
   * 実体（thread 設定）以外の推測値は使わない（codex-plan-mode）。
   */
  private currentModel: string | null;
  private currentEffort: string | null;
  /** この thread で最後に観測 / 送信した collaboration mode（server は turn をまたいで保持する）。 */
  private lastCollaborationMode: CodexCollaborationMode | null = null;
  /**
   * プランモードに入る直前の model / effort。plan の preset（`plan_mode_reasoning_effort` 等）が
   * `thread/settings/updated` 経由で currentModel / currentEffort を上書きするため、default へ戻る turn は
   * これを使って元の値へ戻す（戻さないと会話がずっと preset の effort のままになる）。
   */
  private settingsBeforePlan: { model: string | null; effort: string | null } | null = null;

  /** 現在の collaboration mode（controller が購読時の `pc:collab` 配信と steer 時の注記判定に使う）。 */
  get collaborationMode(): CodexCollaborationMode | null {
    return this.lastCollaborationMode;
  }

  /** plan 直前の model / effort（controller が接続をまたいで預かる）。 */
  get planRestoreSnapshot(): { model: string | null; effort: string | null } | null {
    return this.settingsBeforePlan;
  }

  seedPlanRestoreSnapshot(snapshot: { model: string | null; effort: string | null }): void {
    // resume 応答が「thread は default」と言っている（0.156+ の thread.collaborationMode）なら、離れている
    // 間に別クライアントが戻した後なので古い退避値で巻き戻さない。
    if (this.lastCollaborationMode === "default") return;
    this.settingsBeforePlan ??= snapshot;
  }
  /** `collaborationMode/list` の preset（mode ごとの model / effort 上書き）。接続ごとに 1 回だけ読む。 */
  private collaborationPresetsPromise: Promise<CodexCollaborationPresets> | null = null;

  constructor(
    readonly threadId: string,
    readonly initialItems: readonly Record<string, unknown>[],
    readonly initialActiveTurnId: string | null,
    /**
     * この接続で thread/resume と履歴スナップショットの読み取り（または作成元 bootstrap）が
     * 成功し、live 通知を受け取れるか。turn 履歴が未生成の新規 thread は false。呼び出し側は
     * 履歴取得がタイムアウトした場合も false。表示は rollout tail へフォールバックし、
     * この接続を live 本文の権威にしない（turn 操作と承認は接続を維持する）。
     */
    readonly liveSubscriptionReady: boolean,
    private readonly connection: CodexAppServerConnection,
    private readonly cwd: string | null,
    /** liveSubscriptionReady=false の理由（履歴読み取りの失敗文言）。ログ診断用。 */
    readonly liveSubscriptionError: string | null = null,
    /**
     * 購読時点で thread に設定されているモデル（thread/resume または作成元 thread/start の
     * 応答 `thread.model`）。null は応答に含まれない旧 App Server。Hub はこれを `pc:model`
     * として配信し、会話を開いていない間に変更されたモデルも開き直しで反映する。
     */
    readonly model: string | null = null,
    /** 購読時点の thread の reasoning effort（`thread.reasoningEffort`）。不明なら null。 */
    reasoningEffort: string | null = null,
    /** 購読時点の thread の collaboration mode（0.156+ の `thread.collaborationMode.mode`）。不明なら null。 */
    initialCollaborationMode: CodexCollaborationMode | null = null,
  ) {
    this.currentModel = model;
    this.currentEffort = reasoningEffort;
    this.lastCollaborationMode = initialCollaborationMode;
  }

  async startTurn(
    text: string,
    clientUserMessageId?: string | null,
    effort?: string | null,
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null,
    approvalPolicy?: CodexAppServerApprovalPolicy | null,
    collaborationMode?: CodexCollaborationMode | null,
  ): Promise<string> {
    if (text.length === 0) throw new Error("Codex turn text must not be empty");
    const inherited =
      sandbox === null || approvalPolicy === null
        ? await readCodexSecurityDefaults(this.connection, this.cwd)
        : null;
    const effectiveSandbox = sandbox === null ? inherited?.sandbox ?? null : sandbox;
    const effectiveApprovalPolicy =
      approvalPolicy === null ? inherited?.approvalPolicy ?? null : approvalPolicy;
    const effectiveApprovalsReviewer =
      approvalPolicy === null ? inherited?.approvalsReviewer ?? null : null;
    const hadPlanSnapshot = this.settingsBeforePlan !== null;
    const collaboration = collaborationMode
      ? await this.resolveCollaborationMode(collaborationMode, effort ?? null)
      : null;
    let response: unknown;
    try {
      response = await this.connection.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(effort ? { effort } : {}),
      ...(effectiveSandbox ? { sandboxPolicy: codexSandboxPolicy(effectiveSandbox) } : {}),
      ...(effectiveApprovalPolicy ? { approvalPolicy: effectiveApprovalPolicy } : {}),
      ...(effectiveApprovalsReviewer ? { approvalsReviewer: effectiveApprovalsReviewer } : {}),
      ...(collaboration !== null ? { collaborationMode: collaboration } : {}),
      });
    } catch (error) {
      // この呼び出しで作った退避値は、turn が始まらなかったなら捨てる（後日の default で古い effort へ
      // 巻き戻さない）。既にあった退避値は保つ。
      if (!hadPlanSnapshot) this.settingsBeforePlan = null;
      throw error;
    }
    const turnId = extractTurnId(response);
    if (turnId === null) throw new Error("Codex App Server turn/start response omitted turn.id");
    if (collaboration !== null && collaborationMode) {
      this.lastCollaborationMode = collaborationMode;
      if (collaborationMode === "default") this.settingsBeforePlan = null;
    }
    return turnId;
  }

  /**
   * `turn/start.collaborationMode` の実体を組み立てる（codex-plan-mode）。
   *
   * App Server の collaboration mode は「この turn 以降」thread 設定に残る（0.153.4 実測: turn/start 直後に
   * `thread/settings/updated` が `collaborationMode` 付きで届く）。iOS が指定した mode は毎 turn 明示して
   * 送り、TUI の `/plan` 等で thread 側が変わっていても iOS のトグルどおりに揃える。
   * - `settings.model` は必須。plan は preset の上書き → thread の現在モデルの順で、不明なら開始しない
   *   （推測値でモデルが切り替わる事故を避ける）。default は thread の現在モデルが不明なら「指定なし」
   *   （従来挙動）。分かっていれば毎回明示する: 接続を作り直した後（thread 接続は購読者ゼロで畳まれる）は
   *   直前の mode を覚えていないので、「plan からの復帰のときだけ送る」では plan に固着する。
   * - `settings.reasoning_effort` は iOS の明示 effort → thread の現在 effort → preset（plan は
   *   `plan_mode_reasoning_effort`）→ null（= server 既定。resume 応答の `reasoningEffort` が null の thread は
   *   実際に既定で動いているので忠実）。default へ戻るときは plan に入る直前の effort（settingsBeforePlan）を
   *   優先し、plan の preset が thread 設定へ書いた値を引きずらない。
   * - `developer_instructions: null` = その mode の組み込み指示（プランモードの規範文）を使う。
   */
  private async resolveCollaborationMode(
    mode: CodexCollaborationMode,
    explicitEffort: string | null,
  ): Promise<Record<string, unknown> | null> {
    const presets = await this.collaborationModePresets();
    if (mode === "plan") {
      const preset = presets.get("plan") ?? null;
      const model = preset?.model ?? this.currentModel;
      if (model === null) {
        throw new Error("Codex プランモードを開始できません: この会話の現在モデルが未確定です（開き直してから再送してください）");
      }
      // `??=`: 接続を作り直した直後は lastCollaborationMode が不明（null）で、controller が預けた退避値
      // （seed）を持っている。ここで代入すると plan 中の preset 値で seed を潰す。
      if (this.lastCollaborationMode !== "plan") {
        this.settingsBeforePlan ??= { model: this.currentModel, effort: this.currentEffort };
      }
      const reasoningEffort = explicitEffort ?? this.currentEffort ?? preset?.reasoningEffort ?? null;
      return { mode, settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null } };
    }
    const restored = this.settingsBeforePlan;
    const planPresetModel = presets.get("plan")?.model ?? null;
    // plan の preset がモデルを固定していて、その間に利用者がモデルを変えていない（現在値 = preset）なら
    // plan 前のモデルへ戻す。それ以外は thread の現在モデルをそのまま使う。
    const model = restored?.model !== null && restored?.model !== undefined &&
      planPresetModel !== null && this.currentModel === planPresetModel
      ? restored.model
      : this.currentModel;
    if (model === null) return null;
    const reasoningEffort = explicitEffort ?? (restored !== null ? restored.effort : this.currentEffort);
    return { mode, settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null } };
  }

  private collaborationModePresets(): Promise<CodexCollaborationPresets> {
    this.collaborationPresetsPromise ??= readCollaborationModePresets(this.connection)
      .catch(() => new Map<CodexCollaborationMode, CodexCollaborationPreset>());
    return this.collaborationPresetsPromise;
  }

  /**
   * `thread/settings/updated` の threadSettings を取り込む（モデル / effort / collaboration mode）。
   * 別クライアント（remote TUI）の変更もこの経路で追従する。
   */
  noteThreadSettings(settings: Record<string, unknown>): void {
    const mode = objectRecord(settings["collaborationMode"])?.["mode"];
    // TUI の `/plan` など別クライアントで plan に入った場合も、preset が上書きする前の値を退避する
    // （自分の turn/start 経由なら resolveCollaborationMode が先に退避済みで `??=` は何もしない）。
    if (mode === "plan" && this.lastCollaborationMode !== "plan") {
      this.settingsBeforePlan ??= { model: this.currentModel, effort: this.currentEffort };
    }
    const model = stringValue(settings["model"]);
    if (model !== null) this.currentModel = model;
    if (settings["effort"] === null) {
      this.currentEffort = null;
    } else {
      const effort = stringValue(settings["effort"]);
      if (effort !== null) this.currentEffort = effort;
    }
    if (mode === "plan" || mode === "default") {
      this.lastCollaborationMode = mode;
      // 別クライアントが default へ戻した後は thread の現在値が権威（古い退避値で戻さない）。
      if (mode === "default") this.settingsBeforePlan = null;
    }
  }

  /** `model/rerouted` 等、モデルだけが変わる通知の取り込み。 */
  noteModel(model: string): void {
    if (model.length > 0) this.currentModel = model;
  }

  /** 現在の目標（`thread/goal/get`）。無ければ null（codex-goal）。 */
  async goalGet(): Promise<CodexGoalInfo | null> {
    const response = objectRecord(
      await this.connection.request("thread/goal/get", { threadId: this.threadId }),
    );
    const goal = response?.["goal"];
    if (goal === null || goal === undefined) return null;
    const parsed = codexGoalFromWire(goal);
    if (parsed === null) throw new Error("Codex App Server thread/goal/get response was malformed");
    return parsed;
  }

  /**
   * 目標の作成 / 更新（`thread/goal/set`）。指定したフィールドだけを送る。
   * 呼び元はアプリの目標シート（利用者の明示操作）だけなので `origin: "user"` を付ける。Codex 0.161+ は
   * これが無い変更を利用者の指示としてモデルの履歴へ残さない。旧版は未知のフィールドとして無視する
   * （0.158 / 0.160 で実測）。
   */
  async goalSet(params: { objective?: string; status?: string; tokenBudget?: number }): Promise<CodexGoalInfo> {
    const response = objectRecord(await this.connection.request("thread/goal/set", {
      threadId: this.threadId,
      origin: GOAL_MUTATION_ORIGIN_USER,
      ...(params.objective !== undefined ? { objective: params.objective } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
    }));
    const parsed = codexGoalFromWire(response?.["goal"]);
    if (parsed === null) throw new Error("Codex App Server thread/goal/set response omitted goal");
    return parsed;
  }

  /** 目標の解除（`thread/goal/clear`）。goalSet と同じく利用者の明示操作として送る。 */
  async goalClear(): Promise<boolean> {
    const response = objectRecord(
      await this.connection.request("thread/goal/clear", {
        threadId: this.threadId, origin: GOAL_MUTATION_ORIGIN_USER,
      }),
    );
    return response?.["cleared"] === true;
  }

  async readActiveTurnId(): Promise<string | null | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // 最新 turn だけを読む（turn は直列なので、実行中なら必ず末尾）。全履歴 hydration
        // （thread/read includeTurns:true）は paginated thread で非推奨のため使わない。
        const turns = await listThreadTurns(this.connection, this.threadId, {
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
          all: false,
          timeoutMs: attempt === 1 ? undefined : CodexAppServerThread.activeTurnReadRetryTimeoutMs,
        });
        return activeTurnIdOfTurns(turns);
      } catch (error) {
        // thread/turns/list は副作用が無い。未 materialize thread の初回送信と
        // 別セッションの処理が共有 App Server 上で重なった場合のみ、
        // 5秒 timeout を有界リトライする。turn/start / turn/steer は受理済みか
        // 不明なため、この自動リトライの対象にしない。
        if (isRequestTimeout(error, "thread/turns/list")) {
          if (attempt >= CodexAppServerThread.activeTurnReadMaxAttempts) throw error;
          continue;
        }
        // 新規 thread の最初の turn 記録がまだ無い間は、idle とは断定できない。
        // controller は手元の ID を維持するか、初回 turn/start へ進む。判定は既知文言に加えて
        // thread メタデータの可読性（文言非依存）で行う。判定文言の網羅漏れで新規会話が
        // 全滅した実障害（2026-09-06）の再発防止。
        if (await confirmThreadHistoryUnavailable(this.connection, this.threadId, error)) {
          return undefined;
        }
        throw error;
      }
    }
  }

  /**
   * 親履歴で欠落する sub-agent の終端状態を、子 thread 自身から読み直す。
   * Thread の `model`（ロード中は現在の設定値、未ロードなら最後に永続化された値）も返し、
   * 再オープン時に spawn item へ model が無い版でも実行モデルを復元できるようにする。
   */
  async readThreadStatus(threadId: string): Promise<{
    status: unknown;
    timestampMs?: number;
    model?: string;
  } | undefined> {
    for (let attempt = 1; attempt <= CodexAppServerThread.activeTurnReadMaxAttempts; attempt += 1) {
      try {
        const response = objectRecord(await this.connection.request(
          "thread/read",
          { threadId, includeTurns: false },
          CodexAppServerThread.activeTurnReadRetryTimeoutMs,
        ));
        const thread = objectRecord(response?.["thread"]);
        if (thread === null || thread["status"] === undefined) return undefined;
        const timestampMs = codexTimestampMs(
          thread["createdAt"] ?? thread["updatedAt"] ?? thread["recencyAt"],
        );
        const model = thread["model"];
        return {
          status: thread["status"],
          ...(timestampMs === undefined ? {} : { timestampMs }),
          ...(typeof model === "string" && model.length > 0 ? { model } : {}),
        };
      } catch (error) {
        if (isRequestTimeout(error, "thread/read") &&
          attempt < CodexAppServerThread.activeTurnReadMaxAttempts) {
          continue;
        }
        // workflow snapshot の補完経路なので、子 rollout の一時的不在で親会話を開けなくしない。
        return undefined;
      }
    }
    return undefined;
  }

  async steerTurn(
    turnId: string,
    text: string,
    clientUserMessageId?: string | null,
  ): Promise<void> {
    if (text.length === 0) throw new Error("Codex turn text must not be empty");
    const params = {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      expectedTurnId: turnId,
    };
    if (!clientUserMessageId || this.supportsSteerClientUserMessageId === false) {
      await this.connection.request("turn/steer", params);
      return;
    }
    try {
      await this.connection.request("turn/steer", { ...params, clientUserMessageId });
      this.supportsSteerClientUserMessageId = true;
    } catch (error) {
      // codex-cli 0.144系にはこの additive field が無い。未知フィールド拒否だけは
      // 同じactive turnへIDなしで再試行し、別turnを開始するcontroller fallbackへ落とさない。
      // timeout/切断など「受理済みか不明」な失敗は再試行せず、そのまま上位へ返す。
      if (!isUnsupportedSteerClientUserMessageIdError(error)) throw error;
      await this.connection.request("turn/steer", params);
      this.supportsSteerClientUserMessageId = false;
    }
  }

  async interruptTurn(turnId: string): Promise<void> {
    await this.connection.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    });
  }

  close(): void {
    this.connection.close();
  }
}

function isUnsupportedSteerClientUserMessageIdError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message.includes("clientusermessageid")) return false;
  return [
    "unknown field",
    "unknown parameter",
    "unexpected field",
    "invalid params",
    "invalid parameter",
    "not supported",
    "unsupported",
  ].some((marker) => message.includes(marker));
}

function isRequestTimeout(error: unknown, method: string): boolean {
  return error instanceof Error &&
    error.message === `Codex App Server request timed out: ${method}`;
}

interface CodexSecurityDefaults {
  approvalPolicy: CodexAppServerApprovalPolicy | null;
  approvalsReviewer: "user" | "auto_review" | "guardian_subagent" | null;
  sandbox: CodexAppServerSandbox | null;
}

async function readCodexSecurityDefaults(
  connection: CodexAppServerConnection,
  cwd: string | null,
): Promise<CodexSecurityDefaults> {
  let rawResponse: unknown;
  try {
    rawResponse = await connection.request("config/read", {
      includeLayers: false,
      cwd,
    });
  } catch {
    // 旧 App Server や制限付きで起動された常駐プロセスでは、現在の thread 設定へ委ねる。
    return { approvalPolicy: null, approvalsReviewer: null, sandbox: null };
  }
  const response = objectRecord(rawResponse);
  const config = objectRecord(response?.["config"]);
  const rawApprovalPolicy = config?.["approval_policy"];
  const approvalPolicy =
    rawApprovalPolicy === "untrusted" ||
    rawApprovalPolicy === "on-request" ||
    rawApprovalPolicy === "never"
      ? rawApprovalPolicy
      : null;
  const reviewer = config?.["approvals_reviewer"];
  const approvalsReviewer =
    reviewer === "user" || reviewer === "auto_review" || reviewer === "guardian_subagent"
      ? reviewer
      : null;
  const rawSandbox = config?.["sandbox_mode"];
  const sandbox =
    rawSandbox === "read-only" ||
    rawSandbox === "workspace-write" ||
    rawSandbox === "danger-full-access"
      ? rawSandbox
      : null;
  return { approvalPolicy, approvalsReviewer, sandbox };
}

interface CodexCollaborationPreset {
  model: string | null;
  reasoningEffort: string | null;
}
type CodexCollaborationPresets = Map<CodexCollaborationMode, CodexCollaborationPreset>;

/**
 * `collaborationMode/list` の preset（0.153.4 実測: `{ name, mode, model: null, reasoning_effort }` の配列で
 * Plan は `plan_mode_reasoning_effort`、Default は null）。未対応の server は空。
 */
async function readCollaborationModePresets(
  connection: CodexAppServerConnection,
): Promise<CodexCollaborationPresets> {
  const response = objectRecord(await connection.request("collaborationMode/list", {}));
  const data = response?.["data"];
  const presets: CodexCollaborationPresets = new Map();
  if (!Array.isArray(data)) return presets;
  for (const entry of data) {
    const record = objectRecord(entry);
    const mode = record?.["mode"];
    if (record === null || (mode !== "plan" && mode !== "default")) continue;
    presets.set(mode, {
      model: stringValue(record["model"]),
      reasoningEffort: stringValue(record["reasoning_effort"]) ?? stringValue(record["reasoningEffort"]),
    });
  }
  return presets;
}

/** App Server ThreadGoal（camelCase wire）を Tailii の `CodexGoalInfo` へ。形が違えば null。 */
export function codexGoalFromWire(value: unknown): CodexGoalInfo | null {
  const raw = objectRecord(value);
  if (raw === null) return null;
  const threadId = stringValue(raw["threadId"]);
  const objective = typeof raw["objective"] === "string" ? raw["objective"] : null;
  const status = stringValue(raw["status"]);
  const tokensUsed = finiteNumber(raw["tokensUsed"]);
  const timeUsedSeconds = finiteNumber(raw["timeUsedSeconds"]);
  const createdAt = finiteNumber(raw["createdAt"]);
  const updatedAt = finiteNumber(raw["updatedAt"]);
  if (threadId === null || objective === null || status === null || tokensUsed === null ||
    timeUsedSeconds === null || createdAt === null || updatedAt === null) return null;
  const tokenBudget = finiteNumber(raw["tokenBudget"]);
  return {
    threadId, objective, status,
    ...(tokenBudget !== null ? { tokenBudget } : {}),
    tokensUsed, timeUsedSeconds, createdAt, updatedAt,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 利用者設定（config.toml 階層）の既定モデル。config/read の `config.model` で、TUI の
 * `/model` で保存した値も含む現在値を読む。未設定・旧 App Server・失敗時は null。
 */
async function readCodexConfiguredModel(connection: CodexAppServerConnection): Promise<string | null> {
  try {
    const response = objectRecord(await connection.request("config/read", { includeLayers: false }));
    return stringValue(objectRecord(response?.["config"])?.["model"]);
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function codexSandboxPolicy(sandbox: "read-only" | "workspace-write" | "danger-full-access"): Record<string, unknown> {
  switch (sandbox) {
    case "read-only": return { type: "readOnly", networkAccess: false };
    case "workspace-write": return {
      type: "workspaceWrite", writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
    case "danger-full-access": return { type: "dangerFullAccess" };
  }
}

export interface CodexAppServerManagerOptions {
  codexHome?: string;
  codexPath?: string;
  socketPath?: string;
  remoteEndpoint?: string;
  connect?: CodexAppServerConnect;
  launch?: CodexAppServerLaunch;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  titleGenerationTimeoutMs?: number;
  /** 診断ログ（daemon と CLI の版ずれ等）。 */
  log?: (message: string) => void;
  /** `codex --version` の代替（テスト用）。null は不明。 */
  cliVersion?: () => Promise<string | null>;
  /** `codex --version` の結果を使い回す時間（テスト用）。 */
  cliVersionTtlMs?: number;
  /** 版ずれ daemon の入れ替えで使うプロセス操作（テスト用）。 */
  processControl?: CodexAppServerProcessControl;
  /** 旧 daemon に SIGTERM を送ってから SIGKILL へ切り替えるまで（テスト用）。 */
  stopTimeoutMs?: number;
  /** 入れ替え直前の再確認までの間（テスト用）。 */
  replaceGraceMs?: number;
}

/** thread/list の公開スキーマから一覧表示に必要なフィールドだけを保持する。 */
export interface CodexAppServerThreadInfo {
  id: string;
  name: string | null;
  preview: string | null;
  updatedAt: number;
  cwd: string | null;
  source: unknown;
  parentThreadId: string | null;
}

export type CodexRemoteControlState = "disabled" | "connecting" | "connected" | "errored";

export interface CodexRemoteControlStatus {
  status: CodexRemoteControlState;
  hasEnvironment: boolean;
}

export interface CodexRemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  expiresAt: number;
}

/** 1 CODEX_HOMEにつき1つのApp Serverを共有し、論理threadを作成する。 */
export class CodexAppServerManager {
  readonly socketPath: string;
  readonly remoteEndpoint: string;

  private readonly codexHome: string;
  private readonly codexPath: string;
  private readonly connect: CodexAppServerConnect;
  private readonly launch: CodexAppServerLaunch;
  private readonly pollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly titleGenerationTimeoutMs: number;
  private readonly startupLockPath: string;
  /** `ensureRunning` を通った呼び出しが置く使用の印（1 呼び出し 1 ファイル）。 */
  private readonly useMarkerDir: string;
  /** 版ずれ daemon の入れ替えを試した記録（process をまたいで繰り返しを防ぐ）。 */
  private readonly replaceRecordPath: string;
  /** 最初の turn 前（rollout 未作成）の thread を生存させる作成元購読。openThread が引き継ぐ。 */
  private readonly bootstrapConnections = new Map<string, CodexAppServerConnection>();
  /** thread/start 応答の model。bootstrap 接続を引き継ぐ openThread が購読時のモデルとして返す。 */
  private readonly bootstrapThreadModels = new Map<string, string | null>();
  /** 作成元接続の thread/start 応答の reasoning effort（collaboration mode の settings に使う）。 */
  private readonly bootstrapThreadEfforts = new Map<string, string | null>();
  private readonly log: ((message: string) => void) | null;
  private readonly readCliVersion: () => Promise<string | null>;
  private readonly cliVersionTtlMs: number;
  private cliVersionCache: { value: Promise<string | null>; readAt: number } | null = null;
  /** 版ずれは同じ組み合わせにつき 1 回だけログする。 */
  private lastVersionMismatch: string | null = null;
  private readonly processControl: CodexAppServerProcessControl;
  /** 版ずれ daemon を入れ替えてよいか（テストが開発機の実物の daemon を止めないための切替）。 */
  private readonly replaceEnabled: boolean;
  private readonly stopTimeoutMs: number;
  private readonly replaceGraceMs: number;
  /**
   * 版ずれ daemon の入れ替えを次に判定してよい時刻（保留・失敗・入れ替え直後の連打を防ぐ）。
   * 組み合わせ（旧版→CLI 版）ごと。CLI が更新されて組み合わせが変われば、すぐ判定する。
   */
  private replaceGate: { pair: string; notBefore: number } | null = null;
  /** 入れ替えの保留・見送りは同じ内容につき 1 回だけログする。 */
  private lastReplaceNote: string | null = null;

  constructor(options: CodexAppServerManagerOptions = {}) {
    this.codexHome = options.codexHome ?? defaultAppServerCodexHome();
    this.codexPath = options.codexPath ?? "codex";
    this.socketPath =
      options.socketPath ?? path.join(this.codexHome, "app-server-control", "app-server-control.sock");
    this.remoteEndpoint = options.remoteEndpoint ?? "unix://";
    this.connect =
      options.connect ?? ((socketPath, requestTimeoutMs) =>
        WebSocketCodexAppServerConnection.connect(socketPath, requestTimeoutMs));
    this.launch = options.launch ?? defaultLaunch;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.titleGenerationTimeoutMs =
      options.titleGenerationTimeoutMs ?? DEFAULT_TITLE_GENERATION_TIMEOUT_MS;
    this.startupLockPath = path.join(path.dirname(this.socketPath), "tailii-start.lock");
    this.useMarkerDir = path.join(path.dirname(this.socketPath), "tailii-daemon-use");
    this.replaceRecordPath = path.join(path.dirname(this.socketPath), "tailii-replace.json");
    this.log = options.log ?? null;
    this.readCliVersion = options.cliVersion ?? (() => probeCodexCliVersion(this.codexPath));
    this.cliVersionTtlMs = options.cliVersionTtlMs ?? DEFAULT_CLI_VERSION_TTL_MS;
    this.processControl = options.processControl ?? defaultCodexAppServerProcessControl;
    // 実物のプロセス操作での入れ替えは `TAILII_CODEX_APP_SERVER_REPLACE=off` で止められる
    // （vitest.config.ts が設定する。テスト用の processControl を渡したときは常に有効）。
    this.replaceEnabled =
      options.processControl !== undefined || process.env["TAILII_CODEX_APP_SERVER_REPLACE"] !== "off";
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.replaceGraceMs = options.replaceGraceMs ?? DEFAULT_REPLACE_GRACE_MS;
  }

  /**
   * initialize 応答の `userAgent`（`<client>/<server 版> (...)`）から daemon の版を読み、
   * `codex --version` と食い違えばログに残す。共有 daemon は detached spawn で生き残るため、
   * codex 更新後も旧バイナリが App Server を提供し続ける（2026-07-23・2026-10-20 実障害）。
   * 入れ替えは `ensureRunning` が使用中でないときだけ行う（replaceStaleServerIfIdle）。
   */
  private noteServerVersion(initializeResponse: unknown): void {
    if (this.log === null) return;
    const serverVersion = extractServerVersion(initializeResponse);
    if (serverVersion === null) return;
    void this.currentCliVersion().then((cliVersion) => {
      if (cliVersion === null || cliVersion === serverVersion) return;
      const key = `${serverVersion}->${cliVersion}`;
      if (this.lastVersionMismatch === key) return;
      this.lastVersionMismatch = key;
      this.log?.(
        `Codex App Server daemon の版 ${serverVersion} が codex CLI ${cliVersion} と一致しない` +
        (compareVersions(serverVersion, cliVersion) < 0
          ? "（使用中でなければ、次の起動確認で今の CLI の daemon へ入れ替える）"
          : "（daemon の方が新しいので入れ替えない）"),
      );
    });
  }

  /** `codex --version` の数値版。TTL の間は前回の結果を使う。 */
  private currentCliVersion(): Promise<string | null> {
    const now = Date.now();
    if (this.cliVersionCache === null || now - this.cliVersionCache.readAt >= this.cliVersionTtlMs) {
      this.cliVersionCache = { value: this.readCliVersion().catch(() => null), readAt: now };
    }
    return this.cliVersionCache.value;
  }

  /**
   * serverを再利用または排他的に起動し、利用可能になるまで待つ。daemon が codex CLI より古く、
   * 使用中でなければ、今の CLI の daemon へ入れ替えてから返す。
   */
  async ensureRunning(): Promise<void> {
    // 入れ替える側へ「これから使う」と知らせる印は、lock を確かめる前に置く。入れ替える側は lock を
    // 取った後に印を読むので、lock を見ずに旧 daemon を使い始めた呼び出しは必ず印で見つかる。
    const useMarker = this.markDaemonUse();
    // 別の起動・入れ替えの最中なら、終わるまで待ってから確かめる（入れ替え直前の旧 daemon へ
    // 繋いで、直後に切られるのを避ける）。待っている間に印が古くならないよう、待った後に付け直す。
    await this.waitWhileStartupLocked();
    this.touchDaemonUse(useMarker);
    const serverVersion = await this.probeServerVersion();
    if (serverVersion !== undefined) {
      if (!(await this.replaceStaleServerIfIdle(serverVersion, useMarker))) return;
      // 旧 daemon を止めた・別の入れ替えを待った。起動していなければ下の通常起動に任せる。
      if (await this.probe()) return;
    }
    await this.launchExclusively();
  }

  /** startup lock を取って server を起動し、利用可能になるまで待つ。 */
  private async launchExclusively(): Promise<void> {
    ensureDirectory0700(path.dirname(this.startupLockPath));
    let lockFd: number | null = null;
    try {
      lockFd = this.acquireStartupLock();
      if (lockFd === null) {
        if (await this.waitUntilReady()) return;
        throw new Error("Codex App Server startup is already in progress but did not become ready");
      }

      // lock取得待ちの間に別processが起動済みかもしれないので再確認する。
      if (await this.probe()) return;
      await this.launchServer();
      if (!(await this.waitUntilReady())) {
        throw new Error("Codex App Server failed to become ready");
      }
    } finally {
      this.releaseStartupLock(lockFd);
    }
  }

  private async launchServer(): Promise<void> {
    await this.launch(
      this.codexPath,
      ["app-server", "--listen", this.remoteEndpoint],
      { ...process.env, CODEX_HOME: this.codexHome },
    );
  }

  /**
   * daemon が codex CLI より古ければ、使用中でないときだけ旧 daemon を止めて今の CLI で起動し直す。
   * 旧 daemon が残ると、モデル一覧（OpenAI は client の版ごとに返す）や App Server の機能が古いまま
   * 固定される（2026-10-20 実障害: 0.153.4 のまま 44 日）。daemon の方が新しい・同じなら触らない
   * （process ごとに codex の解決先が違っても版を往復させず、新しい方へ寄せるだけにする）。
   *
   * 「使用中」は次のどちらか。
   * - daemon の `thread/loaded/list` が空でない: remote TUI の接続中・hub の購読中・実行中 turn・
   *   承認待ち・作成直後の thread はどれも読み込まれている。TUI は長く動いた後の切断を再試行しない
   *   ため、止めると pane ごと消える。最後の購読者が去った thread も unload まで残るので、入れ替えは
   *   最後の利用から unload までの時間が過ぎた後になる（STALE_SERVER_BUSY_RECHECK_MS の注記）。
   * - 自分以外の呼び出しが直前（DAEMON_USE_MARKER_TTL_MS 以内）に `ensureRunning` を通った:
   *   thread を開いている途中（`thread/resume` が終わるまで一覧に出ない）を止めないため。
   *
   * 判定の途中で失敗したら（lock が取れない等）、稼働中の daemon をそのまま使う。記録が書けないだけなら
   * 入れ替えは続ける（繰り返しの抑止が process ごとの 10 分だけになる）。
   * 戻り値: true = daemon の状態が変わったかもしれない（呼び出し側が起動を確かめる）。false = そのまま使う。
   */
  private async replaceStaleServerIfIdle(
    serverVersion: string | null,
    useMarker: string | null,
  ): Promise<boolean> {
    if (!this.replaceEnabled || serverVersion === null) return false;
    const cliVersion = await this.currentCliVersion();
    if (cliVersion === null || compareVersions(serverVersion, cliVersion) >= 0) return false;
    const pair = `${serverVersion}->${cliVersion}`;
    if (this.replaceGate !== null && this.replaceGate.pair === pair && Date.now() < this.replaceGate.notBefore) {
      return false;
    }
    let lockFd: number | null = null;
    try {
      ensureDirectory0700(path.dirname(this.startupLockPath));
      lockFd = this.acquireStartupLock();
      if (lockFd === null) {
        // 別の起動・入れ替えの最中。終わるのを待ち、起動しているかは呼び出し側で確かめ直す。
        await this.waitWhileStartupLocked();
        this.touchDaemonUse(useMarker);
        return true;
      }
      return await this.replaceStaleServerLocked(cliVersion, useMarker);
    } catch (error) {
      this.log?.(`Codex App Server daemon ${pair}: 入れ替えの判定に失敗したので、今の daemon を使う（${String(error)}）`);
      this.setReplaceGate(pair, STALE_SERVER_RETRY_MS);
      // 止めた後の起動で失敗した可能性もあるので、呼び出し側に起動を確かめさせる。
      return true;
    } finally {
      this.releaseStartupLock(lockFd);
    }
  }

  private setReplaceGate(pair: string, delayMs: number): void {
    this.replaceGate = { pair, notBefore: Date.now() + delayMs };
  }

  private async replaceStaleServerLocked(cliVersion: string, useMarker: string | null): Promise<boolean> {
    const before = await this.inspectServer();
    // lock を待つ間に止まった（呼び出し側が起動する）・入れ替わった。
    if (before === null) return true;
    if (before.serverVersion === null || compareVersions(before.serverVersion, cliVersion) >= 0) return false;
    const pair = `${before.serverVersion}->${cliVersion}`;
    const label = `Codex App Server daemon ${before.serverVersion} → codex CLI ${cliVersion}`;
    // 同じ組み合わせを最近試した（別 process を含む）なら繰り返さない。外部の監視が旧版を立て直す・
    // 起動し直しても版が揃わない環境で、接続ごとに立つ engine が止め続けないため。
    const record = readReplaceRecord(this.replaceRecordPath);
    if (record !== null && record.pair === pair) {
      const backoffMs = record.result === "skipped" ? STALE_SERVER_RETRY_MS : STALE_SERVER_REPEAT_BACKOFF_MS;
      const age = Date.now() - record.at;
      if (isWithin(age, backoffMs)) {
        this.noteReplace(`${label}: 同じ入れ替えを最近試したので見送る（${record.result}）`);
        // 記録は毎回読み直す（短い間だけ読まない）。組み合わせが変われば記録に関係なく判定する。
        this.setReplaceGate(pair, Math.min(backoffMs - age, STALE_SERVER_RETRY_MS));
        return false;
      }
    }
    if (!this.idleForReplacement(before, useMarker, pair, label)) return false;

    const target = await this.findServerPid();
    if (typeof target === "string") {
      this.skipReplacement(pair, `${label}: 入れ替えを見送る（${target}）`);
      return false;
    }
    // 開きかけの会話を拾うため少し置いてから、止める直前にもう一度確かめる。
    if (this.replaceGraceMs > 0) await sleep(this.replaceGraceMs);
    const recheck = await this.inspectServer();
    if (recheck === null) return true;
    if (recheck.serverVersion !== before.serverVersion) return false;
    if (!this.idleForReplacement(recheck, useMarker, pair, label)) return false;

    // 止める前に記録する（止めた直後にこの process が落ちても、別 process が同じ入れ替えを繰り返さない）。
    this.writeReplaceRecord(pair, "attempted");
    this.setReplaceGate(pair, STALE_SERVER_RETRY_MS);
    if (!(await this.stopProcess(target.pid)) && (await this.probe())) {
      this.log?.(`${label}: 旧 daemon（pid ${target.pid}）が止まらないので入れ替えをやめた`);
      this.writeReplaceRecord(pair, "stop-failed");
      return false;
    }
    if (!(await this.probe())) {
      await this.launchServer();
      await this.waitUntilReady();
    }
    const after = await this.probeServerVersion();
    if (after === undefined) {
      this.log?.(`${label}: 旧 daemon（pid ${target.pid}）を止めたが、新しい daemon が起動しない`);
      this.writeReplaceRecord(pair, "start-failed");
    } else if (after !== cliVersion) {
      this.log?.(`${label}: 入れ替えたが daemon の版が ${after ?? "不明"} のまま`);
      this.writeReplaceRecord(pair, "version-mismatch");
    } else {
      this.lastReplaceNote = null;
      this.log?.(`${label}: 使用中でないので旧 daemon（pid ${target.pid}）を入れ替えた`);
      this.writeReplaceRecord(pair, "replaced");
    }
    return true;
  }

  /** 使用中でなければ true。保留・判定不能はログして再判定の時刻を決める。 */
  private idleForReplacement(
    state: { loadedThreadIds: string[] | null },
    useMarker: string | null,
    pair: string,
    label: string,
  ): boolean {
    if (state.loadedThreadIds === null) {
      this.skipReplacement(pair, `${label}: 読み込み中の会話を確かめられないので入れ替えを見送る`);
      return false;
    }
    const recentUse = this.recentDaemonUseByOthers(useMarker);
    const reasons = [
      ...(state.loadedThreadIds.length > 0 ? ["読み込み中の会話がある"] : []),
      ...(recentUse === true ? ["直前に別の処理が使い始めた"] : []),
      ...(recentUse === null ? ["使用の印を確かめられない"] : []),
    ];
    if (reasons.length === 0) return true;
    this.noteReplace(`${label}: ${reasons.join("・")}ので入れ替えを保留する`);
    this.setReplaceGate(pair, STALE_SERVER_BUSY_RECHECK_MS);
    return false;
  }

  /** 入れ替えを見送り、別 process も含めてしばらく同じ判定を繰り返さない。 */
  private skipReplacement(pair: string, message: string): void {
    this.noteReplace(message);
    this.writeReplaceRecord(pair, "skipped");
    this.setReplaceGate(pair, STALE_SERVER_RETRY_MS);
  }

  private noteReplace(message: string): void {
    if (this.lastReplaceNote === message) return;
    this.lastReplaceNote = message;
    this.log?.(message);
  }

  /** 入れ替えの記録（startup lock の下で読み書きする）。書けなくても入れ替えは続ける。 */
  private writeReplaceRecord(pair: string, result: ReplaceRecordResult): void {
    try {
      fs.writeFileSync(
        this.replaceRecordPath,
        JSON.stringify({ pair, result, at: Date.now(), pid: process.pid }),
        { mode: 0o600 },
      );
    } catch {
      // 記録が無い間は process ごとの再判定時刻だけが効く。
    }
  }

  /** これから daemon を使う印を置き、その名前を返す。古い印は掃除する。置けなくても使用は妨げない。 */
  private markDaemonUse(): string | null {
    const name = `${process.pid}-${randomUUID()}`;
    try {
      ensureDirectory0700(this.useMarkerDir);
      fs.writeFileSync(path.join(this.useMarkerDir, name), "", { mode: 0o600 });
    } catch {
      return null;
    }
    this.recentDaemonUseByOthers(name);
    return name;
  }

  /**
   * 自分以外の新しい使用の印（DAEMON_USE_MARKER_TTL_MS 以内）があれば true。古い印はついでに消す。
   * 印の置き場を読めなければ null（使用中かもしれない側へ倒す）。
   */
  private recentDaemonUseByOthers(ownMarker: string | null): boolean | null {
    let names: string[];
    try {
      names = fs.readdirSync(this.useMarkerDir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
    }
    const now = Date.now();
    let recent = false;
    for (const name of names) {
      if (name === ownMarker) continue;
      const markerPath = path.join(this.useMarkerDir, name);
      try {
        const age = now - fs.statSync(markerPath).mtimeMs;
        if (isWithin(age, DAEMON_USE_MARKER_TTL_MS)) recent = true;
        else fs.unlinkSync(markerPath);
      } catch {
        // 別の process が先に消した。
      }
    }
    return recent;
  }

  /** 使用の印の時刻を今に付け直す（lock を待った後。消えていれば置き直す）。 */
  private touchDaemonUse(useMarker: string | null): void {
    if (useMarker === null) return;
    const markerPath = path.join(this.useMarkerDir, useMarker);
    try {
      // 鮮度の判定（recentDaemonUseByOthers）と同じ Date.now の時計で付ける。
      const now = Date.now() / 1000;
      fs.utimesSync(markerPath, now, now);
    } catch {
      try {
        fs.writeFileSync(markerPath, "", { mode: 0o600 });
      } catch {
        // 置けなくても使用は妨げない。
      }
    }
  }

  /** 稼働中なら版と読み込み中の thread（取れなければ null）。停止中なら null。 */
  private async inspectServer(): Promise<
    { serverVersion: string | null; loadedThreadIds: string[] | null } | null
  > {
    const connected = await this.connectWithServerVersion();
    if (connected === null) return null;
    try {
      return {
        serverVersion: connected.serverVersion,
        loadedThreadIds: await listLoadedThreadIds(connected.connection),
      };
    } finally {
      connected.connection.close();
    }
  }

  /**
   * socket を開いている daemon の pid。Tailii 自身が起動する形（isOwnLaunchCommand）のプロセスが
   * 1 つだけのとき。codex 自身が管理する daemon（`~/.codex/packages/app-server-daemon/`）には
   * 触らない。違えば見送りの理由を返す。
   */
  private async findServerPid(): Promise<{ pid: number } | string> {
    const pids = await this.processControl.findSocketPids(this.socketPath);
    if (pids === null) return "socket を開いているプロセスを調べられない";
    const servers: number[] = [];
    for (const pid of pids) {
      if (pid === process.pid) continue;
      const command = await this.processControl.readCommand(pid);
      if (command === null) continue;
      if (command.includes("/packages/app-server-daemon/")) return "codex が管理する daemon";
      if (this.isOwnLaunchCommand(command)) servers.push(pid);
    }
    const [pid] = servers;
    if (servers.length !== 1 || pid === undefined) {
      return servers.length === 0 ? "daemon のプロセスが見つからない" : `daemon の候補が ${servers.length} 件ある`;
    }
    return { pid };
  }

  /** `launchServer` が起動する形のコマンドラインか（実行ファイルは codexPath か名前が codex）。 */
  private isOwnLaunchCommand(command: string): boolean {
    const suffix = ` app-server --listen ${this.remoteEndpoint}`;
    if (!command.endsWith(suffix)) return false;
    const executable = command.slice(0, -suffix.length);
    return executable === this.codexPath || path.basename(executable) === "codex";
  }

  /** SIGTERM → 待つ → まだ居れば SIGKILL → 待つ。止まったら true。 */
  private async stopProcess(pid: number): Promise<boolean> {
    if (!this.processControl.signal(pid, "SIGTERM")) return !this.processControl.isAlive(pid);
    if (await this.waitForExit(pid, this.stopTimeoutMs)) return true;
    this.processControl.signal(pid, "SIGKILL");
    return this.waitForExit(pid, KILL_WAIT_MS);
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processControl.isAlive(pid)) {
      if (Date.now() > deadline) return false;
      await sleep(this.pollIntervalMs);
    }
    return true;
  }

  /** 稼働中の server にだけ接続する。停止中・不達時は起動せず null を返す。 */
  async connectIfRunning(requestTimeoutMs = 2_000): Promise<CodexAppServerConnection | null> {
    return (await this.connectWithServerVersion(requestTimeoutMs))?.connection ?? null;
  }

  /** 稼働中の server に接続して initialize し、server の版（不明は null）と一緒に返す。停止中は null。 */
  private async connectWithServerVersion(
    requestTimeoutMs = 2_000,
  ): Promise<{ connection: CodexAppServerConnection; serverVersion: string | null } | null> {
    let connection: CodexAppServerConnection | null = null;
    try {
      connection = await this.connect(this.socketPath, requestTimeoutMs);
      const initializeResponse = await connection.initialize();
      this.noteServerVersion(initializeResponse);
      return { connection, serverVersion: extractServerVersion(initializeResponse) };
    } catch {
      connection?.close();
      return null;
    }
  }

  /** 稼働中の server から thread/list を最大200件取得する。停止中なら null。 */
  async listThreads(maxThreads = 200): Promise<CodexAppServerThreadInfo[] | null> {
    const connection = await this.connectIfRunning();
    if (connection === null) return null;
    try {
      const threads: CodexAppServerThreadInfo[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const limit = Math.min(100, maxThreads - threads.length);
        if (limit <= 0) break;
        const response = await connection.request("thread/list", {
          limit,
          sortKey: "updated_at",
          sortDirection: "desc",
          ...(cursor !== null ? { cursor } : {}),
        });
        const page = parseThreadListPage(response);
        threads.push(...page.data.slice(0, limit));
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error("Codex App Server thread/list cursor loop");
          seenCursors.add(cursor);
        }
      } while (cursor !== null && threads.length < maxThreads);
      return threads;
    } finally {
      connection.close();
    }
  }

  /**
   * Codex App Server の正式な会話名を設定する。
   *
   * loaded thread と persisted rollout の両方を同じ API で更新できる。
   * schema上は空文字もstringだが、実App Serverは `thread name must not be empty` で拒否する。
   */
  async setThreadName(threadId: string, name: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) {
      throw new Error("Codex thread id must not be empty");
    }
    if (name.trim().length === 0) {
      throw new Error("Codex thread name must not be empty");
    }
    await this.ensureRunning();
    const connection = await this.connect(this.socketPath);
    try {
      await connection.initialize();
      await connection.request("thread/name/set", {
        threadId: normalizedThreadId,
        name,
      });
    } finally {
      connection.close();
    }
  }

  /**
   * thread を完全に削除する（conversation-delete）。公式 `codex delete` と同じ App Server の
   * `thread/delete`（rollout と状態 DB の両方から消える）。停止中なら起動してから呼ぶ。
   * 既に無い thread は成功扱い（冪等）。
   */
  async deleteThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) {
      throw new Error("Codex thread id must not be empty");
    }
    await this.ensureRunning();
    const connection = await this.connect(this.socketPath);
    try {
      await connection.initialize();
      await connection.request("thread/delete", { threadId: normalizedThreadId });
    } catch (error) {
      // 既に無い thread（2 度目の削除・別経路で削除済み・存在しない id）は 0.158 実測で
      // `no rollout found for thread id …` が返る。削除の目的は達しているので成功扱い（冪等）。
      if (error instanceof Error && /no rollout found/i.test(error.message)) return;
      throw error;
    } finally {
      connection.close();
    }
  }

  /** 現在共有中の App Server から Remote Control 状態を読む。 */
  async remoteControlStatus(): Promise<CodexRemoteControlStatus | null> {
    return this.remoteControlRequest("remoteControl/status/read", {}, parseRemoteControlStatus);
  }

  /** 現在共有中の App Server 自体で Remote Control を有効化する。 */
  async enableRemoteControl(): Promise<CodexRemoteControlStatus | null> {
    return this.remoteControlRequest("remoteControl/enable", {}, parseRemoteControlStatus);
  }

  /** 現在共有中の App Server 自体で Remote Control を無効化する。 */
  async disableRemoteControl(): Promise<CodexRemoteControlStatus | null> {
    return this.remoteControlRequest("remoteControl/disable", {}, parseRemoteControlStatus);
  }

  /** 短命なペアリングコードを発行する。呼び出し側は URL 化後も永続化しない。 */
  async startRemoteControlPairing(): Promise<CodexRemoteControlPairing | null> {
    return this.remoteControlRequest(
      "remoteControl/pairing/start",
      { manualCode: true },
      parseRemoteControlPairing,
    );
  }

  /** 新規threadをApp Serverで作り、TUI起動前に安定IDを返す。 */
  async startThread(options: CodexThreadStartOptions): Promise<string> {
    if (!path.isAbsolute(options.cwd)) throw new Error("Codex thread cwd must be absolute");
    await this.ensureRunning();
    const connection = await this.connect(this.socketPath);
    let succeeded = false;
    try {
      await connection.initialize();
      const params: Record<string, unknown> = {
        cwd: options.cwd,
      };
      if (options.model) params["model"] = options.model;
      if (options.sandbox) params["sandbox"] = options.sandbox;
      const response = await connection.request("thread/start", params);
      const threadId = extractThreadId(response);
      if (threadId === null) throw new Error("Codex App Server thread/start response omitted thread.id");
      // turn が1件も無い thread は rollout がまだ存在せず、作成元購読を閉じると直後の
      // remote TUI/thread/resume が "no rollout found" になる。openThread まで保持して引き継ぐ。
      this.bootstrapConnections.get(threadId)?.close();
      this.bootstrapConnections.set(threadId, connection);
      this.bootstrapThreadModels.set(threadId, threadModel(response));
      this.bootstrapThreadEfforts.set(threadId, threadReasoningEffort(response));
      succeeded = true;
      return threadId;
    } finally {
      if (!succeeded) connection.close();
    }
  }

  /**
   * Codex Desktop と同じ短命 thread で初回 prompt の短いタイトルを生成し、対象 thread へ保存する。
   * `gpt-5.6-luna` を優先し、App Server が利用不能と判断した場合は既定モデルへ委ねる。
   */
  async generateThreadTitle(
    options: CodexThreadTitleGenerationOptions,
  ): Promise<CodexThreadTitleGenerationResult> {
    if (!path.isAbsolute(options.cwd)) throw new Error("Codex thread cwd must be absolute");

    await this.ensureRunning();
    const connection = await this.connect(this.socketPath);
    let ephemeralThreadId: string | null = null;
    try {
      await connection.initialize();
      const target = await readThreadTitleTarget(connection, options.threadId, options.prompt);
      if (target.name !== null) return { title: null, source: null };
      const prompt = target.prompt.trim().slice(0, THREAD_TITLE_PROMPT_MAX_LENGTH);
      if (prompt.length === 0) return { title: null, source: null };
      const fallbackTitle = normalizeFallbackThreadTitle(prompt);

      let generatedTitle: string | null = null;
      try {
        const response = await connection.request("thread/start", {
          model: THREAD_TITLE_MODEL,
          modelProvider: null,
          allowProviderModelFallback: true,
          cwd: options.cwd,
          approvalPolicy: "never",
          permissions: ":read-only",
          runtimeWorkspaceRoots: [],
          config: THREAD_TITLE_CONFIG,
          personality: null,
          ephemeral: true,
          threadSource: "system",
          experimentalRawEvents: false,
          dynamicTools: null,
          serviceTier: null,
        });
        ephemeralThreadId = extractThreadId(response);
        if (ephemeralThreadId === null) {
          throw new Error("Codex title thread/start response omitted thread.id");
        }
        generatedTitle = await runThreadTitleTurn(
          connection,
          ephemeralThreadId,
          buildThreadTitlePrompt(prompt),
          this.titleGenerationTimeoutMs,
        );
      } catch {
        // Desktop と同様、生成経路の失敗は初回 prompt の先頭60文字へフォールバックする。
      }

      const title = generatedTitle ?? fallbackTitle;
      const source: CodexThreadTitleSource =
        generatedTitle === null ? "promptFallback" : "model";
      // 生成中の手動 rename や別 client の命名を上書きしない。
      if (await readThreadName(connection, options.threadId) !== null) {
        return { title: null, source: null };
      }
      await connection.request("thread/name/set", {
        threadId: options.threadId,
        name: title,
      });
      return { title, source };
    } finally {
      if (ephemeralThreadId !== null) {
        try {
          await connection.request("thread/unsubscribe", { threadId: ephemeralThreadId });
        } catch {
          // 短命接続を閉じれば通常会話には影響しない。
        }
      }
      connection.close();
    }
  }

  /** ログイン中アカウントで利用可能なCodexモデルをApp Server APIから取得する。 */
  async listModels(): Promise<CodexModelInfo[]> {
    await this.ensureRunning();
    const connection = await this.connect(this.socketPath);
    try {
      await connection.initialize();
      const rawModels: Record<string, unknown>[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = await connection.request("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor !== null ? { cursor } : {}),
        });
        const page = parseModelListPage(response);
        rawModels.push(...page.data);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error("Codex App Server model/list cursor loop");
          seenCursors.add(cursor);
        }
      } while (cursor !== null);

      // model/list の isDefault は preset（サーバ側の推奨既定）で、利用者が config.toml に
      // 書いた model とは別物。thread/start に model を渡さない新規会話は config の model で
      // 起動するため、一覧に含まれる限りそちらを isDefault にして「既定」の表示と実体を揃える。
      const configuredDefault = await readCodexConfiguredModel(connection);
      const visibleModelIds = new Set(
        rawModels.flatMap((raw) => {
          if (raw["hidden"] === true) return [];
          const id = stringValue(raw["model"]) ?? stringValue(raw["id"]);
          return id === null ? [] : [id];
        }),
      );
      const effectiveDefault =
        configuredDefault !== null && visibleModelIds.has(configuredDefault) ? configuredDefault : null;

      // model/list がAPIキャッシュを更新した後に読む。App Serverの公開Model型には
      // context windowが無いため、同じCodex API応答の永続キャッシュから実効値を結合する。
      const cachedWindows = readModelContextWindows(path.join(this.codexHome, "models_cache.json"));
      const seenModels = new Set<string>();
      return rawModels.flatMap((raw): CodexModelInfo[] => {
        if (raw["hidden"] === true) return [];
        const model = stringValue(raw["model"]) ?? stringValue(raw["id"]);
        if (model === null || seenModels.has(model)) return [];
        seenModels.add(model);
        const directWindow = positiveInteger(raw["contextWindow"]);
        const contextWindow = directWindow ?? cachedWindows.get(model);
        const supportedReasoningEfforts = Array.isArray(raw["supportedReasoningEfforts"])
          ? raw["supportedReasoningEfforts"].flatMap((value) => {
              if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
              const effort = stringValue((value as Record<string, unknown>)["reasoningEffort"]);
              return effort === null ? [] : [effort];
            })
          : [];
        const defaultReasoningEffort = stringValue(raw["defaultReasoningEffort"]);
        return [{
          id: model,
          displayName: stringValue(raw["displayName"]) ?? model,
          description: stringValue(raw["description"]) ?? "",
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(defaultReasoningEffort !== null ? { defaultReasoningEffort } : {}),
          ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
          isDefault: effectiveDefault !== null ? model === effectiveDefault : raw["isDefault"] === true,
        }];
      });
    } finally {
      connection.close();
    }
  }

  /** 指定threadの後続turnで使うモデルをApp Serverの設定APIへ反映する。 */
  async setThreadModel(threadId: string, model: string): Promise<void> {
    if (threadId.length === 0) throw new Error("Codex thread ID must not be empty");
    if (model.length === 0) throw new Error("Codex model must not be empty");
    await this.ensureRunning();
    const connection = await this.connect(this.socketPath);
    try {
      await connection.initialize();
      await connection.request("thread/settings/update", { threadId, model });
    } finally {
      connection.close();
    }
  }

  /** 既存 thread を購読する長寿命接続を開く。turn と native approval はこの接続を流れる。 */
  async openThread(options: CodexAppServerThreadOptions): Promise<CodexAppServerThread> {
    await this.ensureRunning();
    return this.openThreadAttempt(options, null);
  }

  private async openThreadAttempt(
    options: CodexAppServerThreadOptions,
    historyTimeout: string | null,
  ): Promise<CodexAppServerThread> {
    const bootstrap = this.bootstrapConnections.get(options.threadId) ?? null;
    if (bootstrap !== null) this.bootstrapConnections.delete(options.threadId);
    // 作成元接続を引き継ぐ場合は thread/start 応答の model を購読時のモデルとして使う。
    let model: string | null =
      bootstrap !== null ? this.bootstrapThreadModels.get(options.threadId) ?? null : null;
    this.bootstrapThreadModels.delete(options.threadId);
    let reasoningEffort: string | null =
      bootstrap !== null ? this.bootstrapThreadEfforts.get(options.threadId) ?? null : null;
    this.bootstrapThreadEfforts.delete(options.threadId);
    let initialCollaborationMode: CodexCollaborationMode | null = null;
    const connection = bootstrap ?? (await this.connect(this.socketPath));
    const removeNotification = connection.onNotification((notification) => {
      options.onNotification?.(notification);
    });
    const removeServerRequest = connection.onServerRequest((request) => {
      const handler = options.onServerRequest;
      if (handler === undefined) {
        connection.respondError(request.id, -32601, `unsupported server request: ${request.method}`);
        return;
      }
      void handler(request).then(
        (result) => connection.respond(request.id, result),
        (error) => connection.respondError(request.id, -32000, String(error)),
      );
    });
    const removeDisconnect = connection.onDisconnect?.((error) => options.onDisconnect?.(error)) ?? (() => {});
    let resumedSuccessfully = false;
    try {
      let initialItems: Record<string, unknown>[] = [];
      let initialActiveTurnId: string | null = null;
      let liveSubscriptionReady = bootstrap !== null;
      let liveSubscriptionError: string | null = historyTimeout;
      if (bootstrap === null) {
        await connection.initialize();
        try {
          // 全履歴 hydration（excludeTurns:false）は paginated thread で非推奨（codex 0.153.4+ は
          // 呼び出した接続へ deprecationNotice を返す）。resume はメタデータだけにし、
          // Hub の rollout backfill と live 通知の境界に使う履歴 item と実行中 turn は
          // ページ API で読む（readThreadHistorySnapshot）。購読開始（resume）と履歴読み取りの
          // 間に完了した item は snapshot と live 通知の両方に現れるが、Hub は snapshot item を
          // rollout の occurrence と照合して 1 回だけ出す（flushCodexBuffer）。
          const resumed = await connection.request("thread/resume", {
            threadId: options.threadId,
            excludeTurns: true,
          });
          resumedSuccessfully = true;
          // thread の現在モデルは resume 応答が権威。履歴読み取りが失敗する未materialize
          // thread（turn 前）でも resume 自体は成立するため、snapshot より先に確定する。
          model = threadModel(resumed) ?? model;
          reasoningEffort = threadReasoningEffort(resumed) ?? reasoningEffort;
          initialCollaborationMode = threadCollaborationMode(resumed);
          if (historyTimeout === null) {
            const snapshot = await readThreadHistorySnapshotWithRetry(
              connection,
              options.threadId,
              threadHistoryMode(resumed),
            );
            initialItems = snapshot.items;
            initialActiveTurnId = snapshot.activeTurnId;
            liveSubscriptionReady = true;
          } else {
            // 大きい画像・tool 出力を含む履歴は、同じ socket の後続 RPC も塞ぐ。
            // 新しい接続で購読し直し、turn 状態だけ確認する。部分履歴を live の権威に
            // せず rollout fallback を使う。実行中なら controller が start ではなく steer する。
            initialActiveTurnId = activeTurnIdOfTurns(await listThreadTurns(connection, options.threadId, {
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
              all: false,
              timeoutMs: THREAD_METADATA_PROBE_TIMEOUT_MS,
            }));
          }
        } catch (error) {
          // thread/start から最初の user turn まで turn 履歴は未作成で、別接続からの
          // 履歴読み取りは "no rollout found" / "list_turns is not supported yet" になる。
          // ただし共有 App Server 内の live thread 自体は存在し、この接続から turn/start を
          // 直接送れば materialize できる。engine と Session Hub は別プロセスなので、
          // この場合だけ履歴ゼロとして接続を維持し、最初の turn/start へ進ませる
          // （resume 自体が成立していても live 権威にはせず、従来どおり rollout fallback）。
          // 判定は文言一致に加えてメタデータ読み取りの可否（文言非依存）で行う。
          if (!(await confirmThreadHistoryUnavailable(connection, options.threadId, error))) {
            throw error;
          }
          liveSubscriptionError = String(error);
          // 正常な turn 前（既知文言）と、materialize 済み thread の履歴読み取り失敗（要調査:
          // 会話を開くたびに rollout fallback へ落ち続ける）を hub.log で区別できるようにする。
          this.log?.(
            isUnmaterializedThreadError(error, options.threadId)
              ? `Codex thread ${options.threadId} は turn 前の未materialize（正常）: 履歴スナップショット無しで rollout fallback`
              : `Codex thread ${options.threadId} の履歴スナップショットを読めず rollout fallback（要調査）: ${liveSubscriptionError}`,
          );
        }
      }
      return new CodexAppServerThread(
        options.threadId,
        initialItems,
        initialActiveTurnId,
        liveSubscriptionReady,
        connection,
        options.cwd ?? null,
        liveSubscriptionError,
        model,
        reasoningEffort,
        initialCollaborationMode,
      );
    } catch (error) {
      removeNotification();
      removeServerRequest();
      removeDisconnect();
      connection.close();
      if (historyTimeout === null && resumedSuccessfully && (
        isRequestTimeout(error, "thread/items/list") ||
        isRequestTimeout(error, "thread/turns/list") ||
        isRequestTimeout(error, "thread/read")
      )) {
        this.log?.(
          `Codex thread ${options.threadId} の履歴取得がタイムアウト: ` +
          `新しい接続で turn 操作を復旧し、表示は rollout fallback へ移行: ${String(error)}`,
        );
        // 履歴の再取得・turn の再送はしない。新しい制御接続での復旧は 1 回だけ。
        return this.openThreadAttempt(options, String(error));
      }
      throw error;
    }
  }

  private async probe(): Promise<boolean> {
    const connection = await this.connectIfRunning();
    if (connection === null) return false;
    connection.close();
    return true;
  }

  /** 稼働中なら server の版（不明は null）、停止中なら undefined。 */
  private async probeServerVersion(): Promise<string | null | undefined> {
    const connected = await this.connectWithServerVersion();
    if (connected === null) return undefined;
    connected.connection.close();
    return connected.serverVersion;
  }

  private async remoteControlRequest<T>(
    method: string,
    params: Record<string, unknown>,
    parse: (value: unknown) => T | null,
  ): Promise<T | null> {
    try {
      await this.ensureRunning();
      const connection = await this.connectIfRunning(22_000);
      if (connection === null) return null;
      try {
        return parse(await connection.request(method, params));
      } finally {
        connection.close();
      }
    } catch {
      return null;
    }
  }

  private async waitUntilReady(): Promise<boolean> {
    const deadline = Date.now() + this.startupTimeoutMs;
    do {
      if (await this.probe()) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
    } while (Date.now() <= deadline);
    return false;
  }

  /**
   * lockが他の生存processに所有されていればnull。死んだowner・古すぎる（STARTUP_LOCK_STALE_MS 超）
   * lockは1回だけ回収する。
   */
  private acquireStartupLock(): number | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.startupLockPath, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return fd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (startupLockIsHeld(readStartupLock(this.startupLockPath))) return null;
        try {
          fs.unlinkSync(this.startupLockPath);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private releaseStartupLock(lockFd: number | null): void {
    if (lockFd === null) return;
    try {
      // 古い lock として別 process に回収された後なら、今のファイルはその持ち主のもの。消さない。
      const held = fs.fstatSync(lockFd);
      const current = fs.statSync(this.startupLockPath);
      if (held.ino === current.ino && held.dev === current.dev) fs.unlinkSync(this.startupLockPath);
    } catch {
      // 既に無い・読めない。
    }
    try {
      fs.closeSync(lockFd);
    } catch {
      // 無視。
    }
  }

  /**
   * 生きた process が持つ新しい startup lock（起動・入れ替えの最中）が外れるまで待つ。同じ process の
   * 別の呼び出しが持つ lock も待つ（lock を持つ処理自身は ensureRunning を呼ばないので詰まらない）。
   */
  private async waitWhileStartupLocked(): Promise<void> {
    const deadline = Date.now() + STARTUP_LOCK_STALE_MS;
    while (startupLockIsHeld(readStartupLock(this.startupLockPath))) {
      if (Date.now() > deadline) return;
      await sleep(this.pollIntervalMs);
    }
  }
}

async function readThreadName(
  connection: CodexAppServerConnection,
  threadId: string,
): Promise<string | null> {
  let response: Record<string, unknown> | null;
  try {
    response = objectRecord(await connection.request("thread/read", {
      threadId,
      includeTurns: false,
    }));
  } catch (error) {
    // turn/start が成功していても rollout の最初の行が flush されるまでは
    // thread/read が空ファイルとして失敗する。thread/list のメタデータはこの間も
    // name を返せるため、手動 rename の上書き防止を維持したまま命名を続行する。
    if (!isUnmaterializedThreadError(error, threadId)) throw error;
    return readThreadNameFromList(connection, threadId);
  }
  const thread = objectRecord(response?.["thread"]);
  if (thread === null) throw new Error("Codex App Server thread/read response omitted thread");
  const name = thread["name"];
  if (name === null || name === undefined) return null;
  if (typeof name !== "string") {
    throw new Error("Codex App Server thread/read returned an invalid thread name");
  }
  return name.trim().length > 0 ? name.trim() : null;
}

async function readThreadTitleTarget(
  connection: CodexAppServerConnection,
  threadId: string,
  fallbackPrompt: string,
): Promise<{ name: string | null; prompt: string }> {
  let response: unknown;
  try {
    // 名前はメタデータだけの read で読む（includeTurns:true は paginated thread で非推奨）。
    response = await connection.request("thread/read", {
      threadId,
      includeTurns: false,
    });
  } catch (error) {
    // 作成直後は初回 turn/start 応答後もしばらく rollout が空の場合がある。
    // controller から渡された最初の入力を使い、既存 name だけ thread/list で保護する。
    if (!(await confirmThreadHistoryUnavailable(connection, threadId, error))) throw error;
    return {
      name: await readThreadNameFromList(connection, threadId),
      prompt: fallbackPrompt,
    };
  }
  const record = objectRecord(response);
  const thread = objectRecord(record?.["thread"]);
  if (thread === null) throw new Error("Codex App Server thread/read response omitted thread");
  const rawName = thread["name"];
  if (rawName !== null && rawName !== undefined && typeof rawName !== "string") {
    throw new Error("Codex App Server thread/read returned an invalid thread name");
  }
  const name =
    typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : null;
  // 命名済みなら呼び出し側は生成しないので、履歴の読み取り（追加 RPC）はしない。
  if (name !== null) return { name, prompt: fallbackPrompt };
  // 最初の user prompt は保存済み履歴を権威にする（TUI attach / resume の競合で
  // controller の入力が後続メッセージになっていても、新規会話の命名を落とさない）。
  let firstUserPrompt: string | null = null;
  try {
    firstUserPrompt = await readFirstUserPrompt(connection, threadId, threadHistoryMode(response));
  } catch (error) {
    // 初回 turn/start 応答後も turn 履歴の flush までは読めない場合がある。
    if (!(await confirmThreadHistoryUnavailable(connection, threadId, error))) throw error;
  }
  return {
    name,
    prompt: firstUserPrompt ?? fallbackPrompt,
  };
}

async function readThreadNameFromList(
  connection: CodexAppServerConnection,
  threadId: string,
): Promise<string | null> {
  const page = parseThreadListPage(await connection.request("thread/list", {
    limit: 100,
    sortKey: "updated_at",
    sortDirection: "desc",
  }));
  const thread = page.data.find((candidate) => candidate.id === threadId);
  if (thread === undefined) {
    throw new Error(`Codex App Server thread/list omitted target thread ${threadId}`);
  }
  return thread.name;
}

function extractUserMessageText(item: Record<string, unknown>): string | null {
  if (item["type"] !== "userMessage") return null;
  const content = item["content"];
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((part) => {
    const record = objectRecord(part);
    if (record === null || record["type"] !== "text") return [];
    return typeof record["text"] === "string" ? [record["text"]] : [];
  }).join("\n").trim();
  return text.length > 0 ? text : null;
}

async function runThreadTitleTurn(
  connection: CodexAppServerConnection,
  threadId: string,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  let turnId: string | null = null;
  let responseText = "";
  let settled = false;
  let resolveCompletion: (title: string | null) => void = () => {};
  const completion = new Promise<string | null>((resolve) => {
    resolveCompletion = resolve;
  });
  const finish = (title: string | null): void => {
    if (settled) return;
    settled = true;
    resolveCompletion(title);
  };
  const removeNotification = connection.onNotification((notification) => {
    const params = objectRecord(notification.params);
    if (params?.["threadId"] !== threadId) return;
    const notificationTurnId =
      stringValue(params["turnId"]) ?? stringValue(objectRecord(params["turn"])?.["id"]);
    if (turnId !== null && notificationTurnId !== null && notificationTurnId !== turnId) return;

    if (notification.method === "turn/started") {
      if (notificationTurnId !== null) turnId = notificationTurnId;
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const delta = params["delta"];
      if (typeof delta === "string") responseText += delta;
      return;
    }
    if (notification.method === "item/completed") {
      const item = objectRecord(params["item"]);
      if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") {
        responseText = item["text"];
      }
      return;
    }
    if (notification.method === "error") {
      finish(null);
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = objectRecord(params["turn"]);
      finish(turn?.["status"] === "completed" ? parseThreadTitleResult(responseText) : null);
    }
  });
  const timer = setTimeout(() => {
    if (turnId !== null) {
      void connection.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    }
    finish(null);
  }, Math.max(1, timeoutMs));

  try {
    const response = await connection.request("turn/start", {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: null,
      approvalPolicy: null,
      permissions: ":read-only",
      runtimeWorkspaceRoots: [],
      model: null,
      effort: null,
      serviceTier: null,
      summary: "none",
      personality: null,
      outputSchema: THREAD_TITLE_OUTPUT_SCHEMA,
      collaborationMode: null,
    });
    turnId = extractTurnId(response);
    if (turnId === null) throw new Error("Codex title turn/start response omitted turn.id");
    return await completion;
  } finally {
    clearTimeout(timer);
    removeNotification();
  }
}

function buildThreadTitlePrompt(prompt: string): string {
  return [
    "You are a helpful assistant that creates a short UI title for a coding task.",
    `Return a concise title of at most ${THREAD_TITLE_MAX_LENGTH} characters and a compact, search-oriented description of at most 100 characters.`,
    "Write both the title and description in the same primary language as the user prompt.",
    "Do not translate them into another language. Preserve product names and identifiers in their original form.",
    "Start change requests with a precise action word appropriate to the user's language.",
    "Keep the title under five words when possible.",
    "Make questions clearly express their intent in the user's language.",
    "Reuse an explicit short title from the user when one is provided.",
    "Preserve ticket references such as ABC-123 verbatim.",
    "Do not use quotes, Markdown, formatting characters, or trailing punctuation.",
    "Do not answer the prompt or solve the task. Only produce the structured title and description.",
    "",
    "User prompt:",
    prompt,
  ].join("\n");
}

function parseThreadTitleResult(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  const result = objectRecord(parsed);
  const title = result?.["title"];
  const description = result?.["description"];
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > THREAD_TITLE_MAX_LENGTH ||
    typeof description !== "string" ||
    description.trim().length === 0
  ) {
    return null;
  }
  return sanitizeGeneratedThreadTitle(title);
}

function sanitizeGeneratedThreadTitle(raw: string): string | null {
  let title = raw
    .replaceAll("\r\n", "\n")
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim() ?? "";
  title = title.replace(/^title[:\s]+/i, "");
  title = title.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[.?!]+$/, "").trim();
  if (title.length === 0) return null;
  return title.length > THREAD_TITLE_MAX_LENGTH
    ? `${title.slice(0, THREAD_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

function normalizeFallbackThreadTitle(raw: string): string {
  const title = raw.replaceAll("\n", " ").replaceAll("\r", " ").trim();
  return title.slice(0, THREAD_TITLE_FALLBACK_MAX_LENGTH);
}

/**
 * codex 0.153.4+ の `historyMode: "paginated"` thread は、turn が 1 件も無い間
 * `thread/turns/list`（および全履歴 hydration の `thread/read includeTurns:true` /
 * `thread/resume excludeTurns:false`）を JSON-RPC -32601 でこの文言のまま拒否する
 * （thread id を含まない）。turn/start 自体は受理され、最初の turn 以降は成功する。
 */
const PAGINATED_THREAD_TURNS_UNAVAILABLE = "list_turns is not supported yet";

/**
 * thread/start 直後（最初の user turn 前）の読み取り失敗を、App Server の版ごとの文言から判定する。
 * - `no rollout found for thread id <id>`: rollout ファイル未作成
 * - `thread <id> is not materialized yet; <method> is unavailable before first user message`:
 *   method 部分は `includeTurns` / `thread/turns/list` など版で異なるため前方一致
 * - `failed to read session metadata ... is empty`: session_meta 行の flush 前
 * - `list_turns is not supported yet`: paginated thread の turn 前（0.153.4 実測）
 */
function isUnmaterializedThreadError(error: unknown, threadId: string): boolean {
  if (!(error instanceof Error)) return false;
  const { message } = error;
  if (message === `no rollout found for thread id ${threadId}`) return true;
  if (message.startsWith(`thread ${threadId} is not materialized yet;`)) return true;
  if (message === PAGINATED_THREAD_TURNS_UNAVAILABLE) return true;
  return message.includes(threadId) &&
    message.includes("failed to read session metadata") &&
    message.endsWith("is empty");
}

/** initialize 応答の userAgent `tailii_host/0.153.4 (...)` から server の数値版を取り出す。 */
function extractServerVersion(initializeResponse: unknown): string | null {
  const userAgent = objectRecord(initializeResponse)?.["userAgent"];
  if (typeof userAgent !== "string") return null;
  const match = /^[^\s/]+\/(\d+(?:\.\d+)+)/.exec(userAgent);
  return match?.[1] ?? null;
}

/** `codex --version`（例: `codex-cli 0.153.4`）の数値版。取れなければ null。 */
function probeCodexCliVersion(codexPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(codexPath, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(/\d+(?:\.\d+)+/.exec(String(stdout))?.[0] ?? null);
    });
  });
}

/** 文言非依存判定で使う、メタデータだけの thread/read の期限。 */
const THREAD_METADATA_PROBE_TIMEOUT_MS = 2_000;

/**
 * turn 履歴の読み取り（thread/turns/list。旧: thread/resume / thread/read includeTurns:true）の
 * 失敗が「turn 履歴が未生成・未対応」なのかを、エラー文言に依存せず判定する。
 *
 * 1. 既知の文言（isUnmaterializedThreadError）なら即 true。
 * 2. timeout は接続が刺さっている可能性があるため false（呼び出し側の有界リトライに委ねる）。
 * 3. それ以外は、メタデータだけの `thread/read includeTurns:false` を短い期限で試す。
 *    live thread は最初の turn 前でも（rollout 未作成でも）これに応答する一方、存在しない
 *    thread は `thread not loaded` 等で失敗する。応答があれば thread は App Server から
 *    見えており、履歴 hydration だけが不可＝turn/start へ進んでよい状態と判断する。
 *
 * App Server の文言は版ごとに変わる（no rollout found → not materialized yet →
 * list_turns is not supported yet）。文言の網羅漏れで新規会話が全滅しないための安全側判定。
 */
async function confirmThreadHistoryUnavailable(
  connection: CodexAppServerConnection,
  threadId: string,
  error: unknown,
): Promise<boolean> {
  if (isUnmaterializedThreadError(error, threadId)) return true;
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith("Codex App Server request timed out")) return false;
  try {
    const response = objectRecord(await connection.request(
      "thread/read",
      { threadId, includeTurns: false },
      THREAD_METADATA_PROBE_TIMEOUT_MS,
    ));
    const thread = objectRecord(response?.["thread"]);
    return thread !== null && thread["id"] === threadId;
  } catch {
    return false;
  }
}

function parseRemoteControlStatus(value: unknown): CodexRemoteControlStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (
    status !== "disabled" &&
    status !== "connecting" &&
    status !== "connected" &&
    status !== "errored"
  ) {
    return null;
  }
  const environmentId = record["environmentId"];
  if (environmentId !== null && environmentId !== undefined && typeof environmentId !== "string") {
    return null;
  }
  return {
    status,
    hasEnvironment: typeof environmentId === "string" && environmentId.length > 0,
  };
}

function parseRemoteControlPairing(value: unknown): CodexRemoteControlPairing | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pairingCode = record["pairingCode"];
  const manualPairingCode = record["manualPairingCode"];
  const environmentId = record["environmentId"];
  const expiresAt = record["expiresAt"];
  if (
    typeof pairingCode !== "string" ||
    pairingCode.length === 0 ||
    Buffer.byteLength(pairingCode, "utf8") > 2_048 ||
    (manualPairingCode !== null && typeof manualPairingCode !== "string") ||
    typeof environmentId !== "string" ||
    environmentId.length === 0 ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= 0
  ) {
    return null;
  }
  return {
    pairingCode,
    manualPairingCode,
    expiresAt: expiresAt as number,
  };
}

/** thread の履歴保存方式。0.153.4+ は応答の `thread.historyMode` で判別でき、旧版は欠落（legacy）。 */
type CodexThreadHistoryMode = "paginated" | "legacy";

/** thread/resume・thread/read 応答の `thread.historyMode`。欠落や未知の値は legacy 扱い。 */
function threadHistoryMode(response: unknown): CodexThreadHistoryMode {
  const thread = objectRecord(objectRecord(response)?.["thread"]);
  return thread?.["historyMode"] === "paginated" ? "paginated" : "legacy";
}

interface ThreadHistoryPageOptions {
  /** 1 ページの件数。server は 1..100 に clamp する。 */
  limit: number;
  sortDirection: "asc" | "desc";
  /** true なら nextCursor が尽きるまで続きのページも読む。 */
  all: boolean;
  timeoutMs?: number;
  /** 全ページで共有する期限。個別 RPC の期限だけでは長い履歴が送信を塞ぎ続ける。 */
  deadlineMs?: number;
}

interface ThreadTurnsListOptions extends ThreadHistoryPageOptions {
  itemsView: "notLoaded" | "summary" | "full";
}

/**
 * host 側で検出した応答形・上限の異常（data 欠落、未知の item 形、turns 欠落、ページ上限）。
 * server の一時障害ではなく恒久的なので、読み直しの対象にしない。
 */
class CodexHistoryShapeError extends Error {}

/**
 * cursor ページングの共通ループ。応答形が違う（data が配列でない）版は成功として扱わず throw する
 * （「履歴ゼロなのに live 権威」という誤った状態を作らない。呼び出し側は未 materialize 判定→
 * rollout fallback へ進む）。cursor が進まない・既出 cursor へ戻る（循環）・空ページ・上限ページ数・
 * `until` 成立で打ち切り、無限ループしない。壊れた cursor のページは取り込んだうえで打ち切る
 * （重複は呼び出し側が id で排除する）。
 */
async function pageThreadHistory(
  connection: CodexAppServerConnection,
  method: "thread/turns/list" | "thread/items/list",
  threadId: string,
  params: Record<string, unknown>,
  options: ThreadHistoryPageOptions,
  collect: (data: unknown[]) => void,
  until: () => boolean = () => false,
): Promise<void> {
  let cursor: string | null = null;
  const visited = new Set<string>();
  for (let page = 1; page <= THREAD_HISTORY_MAX_PAGES; page += 1) {
    const timeoutMs = historyRequestTimeout(method, options.deadlineMs, options.timeoutMs);
    const response = objectRecord(await connection.request(
      method,
      {
        threadId,
        limit: options.limit,
        sortDirection: options.sortDirection,
        ...params,
        ...(cursor === null ? {} : { cursor }),
      },
      timeoutMs,
    ));
    const data = response?.["data"];
    if (!Array.isArray(data)) {
      throw new CodexHistoryShapeError(
        `Codex App Server ${method} response omitted data for thread ${threadId}`,
      );
    }
    collect(data);
    const rawNext = response?.["nextCursor"];
    const next = typeof rawNext === "string" && rawNext.length > 0 ? rawNext : null;
    if (!options.all || next === null || visited.has(next) || data.length === 0 || until()) return;
    visited.add(next);
    cursor = next;
  }
  throw new CodexHistoryShapeError(
    `Codex App Server ${method} exceeded ${THREAD_HISTORY_MAX_PAGES} pages for thread ${threadId}`,
  );
}

function historyRequestTimeout(method: string, deadlineMs?: number, timeoutMs?: number): number | undefined {
  if (deadlineMs === undefined) return timeoutMs;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error(`Codex App Server request timed out: ${method}`);
  return Math.min(remaining, timeoutMs ?? remaining);
}

/** id 付き要素の重複（同じページを返し続ける壊れた cursor 等）を排除する。id 無しは常に採用。 */
function rememberId(seen: Set<string>, id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

/**
 * `thread/turns/list` で turn を読む。サポート下限の codex 0.144.5 から itemsView 付きで利用できる。
 * 用途は turn 状態の読み取り（desc, limit 1, notLoaded）に限る。履歴の hydration には使わない
 * （readThreadHistorySnapshot）: `itemsView:"full"` は server 側で「旧 client が thread/items/list へ
 * 移行するまでの互換経路」とされ、legacy thread の turns/list は itemsView に関わらず
 * リクエスト毎に rollout 全体を再生する（server 実装）。
 */
async function listThreadTurns(
  connection: CodexAppServerConnection,
  threadId: string,
  options: ThreadTurnsListOptions,
): Promise<Record<string, unknown>[]> {
  const turns: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  await pageThreadHistory(
    connection,
    "thread/turns/list",
    threadId,
    { itemsView: options.itemsView },
    options,
    (data) => {
      for (const turn of data) {
        const record = objectRecord(turn);
        if (record !== null && rememberId(seen, record["id"])) turns.push(record);
      }
    },
  );
  return turns;
}

/**
 * `thread/items/list`（paginated thread 専用。legacy thread は -32601 `not supported yet`）で
 * item を読む。応答の data は turn を跨いだ時系列順（asc）。0.153.4 は `{ turnId, item }` の
 * 封筒、サポート下限 0.144.5 の protocol は素の ThreadItem 配列なので両方を受け、どちらでもない
 * 形（非空ページで採用 0 件）は throw する（無言の空履歴で live 権威にしない）。
 * `until` が true を返した時点で続きのページを読まない。
 */
async function listThreadItems(
  connection: CodexAppServerConnection,
  threadId: string,
  options: ThreadHistoryPageOptions,
  until: (items: readonly Record<string, unknown>[], pages: number) => boolean = () => false,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let pages = 0;
  await pageThreadHistory(
    connection,
    "thread/items/list",
    threadId,
    {},
    options,
    (data) => {
      pages += 1;
      let accepted = 0;
      for (const entry of data) {
        const record = objectRecord(entry);
        const item = objectRecord(record?.["item"]) ??
          (typeof record?.["type"] === "string" ? record : null);
        if (item === null) continue;
        accepted += 1;
        // 0.153.4+ の `{turnId, item}` 封筒の turn 所属を残す（非同期質問の復元が実行中 turn の item を選ぶ）。
        if (item !== record) tagCodexItemTurn(item, record?.["turnId"]);
        if (rememberId(seen, item["id"])) items.push(item);
      }
      if (data.length > 0 && accepted === 0) {
        throw new CodexHistoryShapeError(
          `Codex App Server thread/items/list returned items of unknown shape for thread ${threadId}`,
        );
      }
    },
    () => until(items, pages),
  );
  return items;
}

/**
 * thread/read includeTurns:true 応答の `thread.turns`。protocol 上は常に配列（他の応答では空配列）
 * なので、欠落は応答形の違いとして throw する（無言の空履歴で live 権威にしない）。
 */
function turnsOfThreadResponse(response: unknown): Record<string, unknown>[] {
  const turns = objectRecord(objectRecord(response)?.["thread"])?.["turns"];
  if (!Array.isArray(turns)) {
    throw new CodexHistoryShapeError(
      "Codex App Server thread/read includeTurns:true response omitted thread.turns",
    );
  }
  return turns
    .map(objectRecord)
    .filter((turn): turn is Record<string, unknown> => turn !== null);
}

/**
 * 購読直後の履歴スナップショット（Hub の rollout backfill と live 通知の境界に使う item 列と、
 * 別 client が開始した実行中 turn）を、非推奨でない API だけで読む。
 * - paginated（codex 0.153.4+ の新規 thread）: server の案内どおり turn 状態は `thread/turns/list`
 *   （desc, limit 1, notLoaded）、item は `thread/items/list`（asc）で読む。turn 前は最初の
 *   `thread/turns/list` が `list_turns is not supported yet` で失敗し、呼び出し側が未 materialize
 *   判定へ進む。item 列は全履歴 hydration（server の paginated_thread_full_turns）と同じ
 *   （0.153.4 実測）。
 * - legacy（rollout 保存の旧 thread）: `thread/items/list` は未対応（-32601）。全履歴 hydration
 *   `thread/read includeTurns:true` は legacy では非推奨でなく（server の通知は paginated 限定）、
 *   rollout を 1 回再生するだけで済む。`thread/turns/list itemsView:full` はページ毎に rollout
 *   全体を再生する（server 実装）ため使わない。
 */
async function readThreadHistorySnapshot(
  connection: CodexAppServerConnection,
  threadId: string,
  historyMode: CodexThreadHistoryMode,
  deadlineMs: number,
): Promise<{ items: Record<string, unknown>[]; activeTurnId: string | null }> {
  if (historyMode === "paginated") {
    const latest = await listThreadTurns(connection, threadId, {
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
      all: false,
      deadlineMs,
    });
    const items = await listThreadItems(connection, threadId, {
      limit: THREAD_HISTORY_PAGE_LIMIT,
      sortDirection: "asc",
      all: true,
      deadlineMs,
    });
    return { items, activeTurnId: activeTurnIdOfTurns(latest) };
  }
  const turns = turnsOfThreadResponse(
    await connection.request(
      "thread/read", { threadId, includeTurns: true }, historyRequestTimeout("thread/read", deadlineMs),
    ),
  );
  return { items: itemsOfTurns(turns), activeTurnId: activeTurnIdOfTurns(turns) };
}

/**
 * 履歴スナップショットの読み取りを、ページング中の一時的な失敗（例: compaction で cursor の
 * anchor turn が消えた `invalid cursor`）に備えて 1 回だけやり直す。timeout（接続が刺さっている
 * 可能性）、未 materialize の既知文言（turn 前は何度読んでも同じ）、host 側で検出した応答形・
 * 上限の異常（恒久的）は再試行しない。
 */
async function readThreadHistorySnapshotWithRetry(
  connection: CodexAppServerConnection,
  threadId: string,
  historyMode: CodexThreadHistoryMode,
): Promise<{ items: Record<string, unknown>[]; activeTurnId: string | null }> {
  const deadlineMs = Date.now() + THREAD_HISTORY_SNAPSHOT_TIMEOUT_MS;
  try {
    return await readThreadHistorySnapshot(connection, threadId, historyMode, deadlineMs);
  } catch (error) {
    if (!(error instanceof Error) ||
      error instanceof CodexHistoryShapeError ||
      error.message.startsWith("Codex App Server request timed out") ||
      isUnmaterializedThreadError(error, threadId)) {
      throw error;
    }
    return readThreadHistorySnapshot(connection, threadId, historyMode, deadlineMs);
  }
}

/** 命名用に最初の user prompt を保存済み履歴から読む（無ければ null）。 */
async function readFirstUserPrompt(
  connection: CodexAppServerConnection,
  threadId: string,
  historyMode: CodexThreadHistoryMode,
): Promise<string | null> {
  if (historyMode === "legacy") {
    // legacy は rollout を 1 回で読む（readThreadHistorySnapshot と同じ理由）。全 turn を走査する。
    const response = await connection.request("thread/read", { threadId, includeTurns: true });
    return firstUserPromptOfItems(itemsOfTurns(turnsOfThreadResponse(response)));
  }
  // paginated は先頭から user prompt が見つかるまで（上限ページ数まで）読む。
  const items = await listThreadItems(
    connection,
    threadId,
    { limit: THREAD_HISTORY_PAGE_LIMIT, sortDirection: "asc", all: true },
    (collected, pages) =>
      pages >= THREAD_TITLE_PROMPT_MAX_PAGES || firstUserPromptOfItems(collected) !== null,
  );
  return firstUserPromptOfItems(items);
}

function firstUserPromptOfItems(items: readonly Record<string, unknown>[]): string | null {
  return items
    .map(extractUserMessageText)
    .find((value): value is string => value !== null && value.trim().length > 0) ?? null;
}

/** turn 一覧に含まれる item を時系列順に平坦化する。 */
function itemsOfTurns(turns: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const turn of turns) {
    const items = turn["items"];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const record = objectRecord(item);
      if (record === null) continue;
      tagCodexItemTurn(record, turn["id"]);
      result.push(record);
    }
  }
  return result;
}

/**
 * 履歴 item の turn 所属。wire / JSON には出ない（列挙されない symbol キー）ので、item を そのまま
 * 他所へ流しても形は変わらない。turn 所属が分からない item（旧形の items/list）は null。
 */
const CODEX_ITEM_TURN_ID = Symbol("codexItemTurnId");

export function tagCodexItemTurn(item: Record<string, unknown>, turnId: unknown): void {
  if (typeof turnId !== "string" || turnId.length === 0) return;
  Object.defineProperty(item, CODEX_ITEM_TURN_ID, { value: turnId, enumerable: false, configurable: true });
}

export function codexItemTurnId(item: Record<string, unknown>): string | null {
  const value = (item as Record<symbol, unknown>)[CODEX_ITEM_TURN_ID];
  return typeof value === "string" ? value : null;
}

/** turn 一覧から、別 client が開始した実行中 turn を復元する（末尾から最初の inProgress）。 */
function activeTurnIdOfTurns(turns: readonly Record<string, unknown>[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined || turn["status"] !== "inProgress") continue;
    const id = turn["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function defaultLaunch(executable: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(executable, args, { detached: true, env, stdio: "ignore" });
  child.once("error", () => {
    // readiness probeが最終的な構造化エラーを返すため、EventEmitterの未処理errorだけ防ぐ。
  });
  child.unref();
}

/** thread/start / thread/resume 応答の `thread.model`。無ければ null（旧 App Server）。 */
function threadModel(response: unknown): string | null {
  const thread = objectRecord(objectRecord(response)?.["thread"]);
  return stringValue(thread?.["model"]);
}

/** thread/resume 応答の `thread.collaborationMode.mode`（0.156+ で存在。無ければ null = 不明）。 */
function threadCollaborationMode(response: unknown): CodexCollaborationMode | null {
  const thread = objectRecord(objectRecord(response)?.["thread"]);
  const mode = objectRecord(thread?.["collaborationMode"])?.["mode"];
  return mode === "plan" || mode === "default" ? mode : null;
}

/** thread/start / thread/resume 応答の `thread.reasoningEffort`（0.153.x で存在。無ければ null）。 */
function threadReasoningEffort(response: unknown): string | null {
  const record = objectRecord(response);
  const thread = objectRecord(record?.["thread"]);
  // 応答 top-level の `reasoningEffort`（thread/start・resume の schema に併記）も代替として読む。
  return stringValue(thread?.["reasoningEffort"]) ?? stringValue(record?.["reasoningEffort"]);
}

function extractThreadId(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const thread = (response as Record<string, unknown>)["thread"];
  if (typeof thread !== "object" || thread === null) return null;
  const id = (thread as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function extractTurnId(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const turn = (response as Record<string, unknown>)["turn"];
  if (typeof turn !== "object" || turn === null) return null;
  const id = (turn as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function parseModelListPage(response: unknown): {
  data: Record<string, unknown>[];
  nextCursor: string | null;
} {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error("Codex App Server model/list response is not an object");
  }
  const record = response as Record<string, unknown>;
  const data = record["data"];
  if (!Array.isArray(data)) throw new Error("Codex App Server model/list response omitted data");
  const models = data.filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  if (models.length !== data.length) {
    throw new Error("Codex App Server model/list returned an invalid model");
  }
  const rawCursor = record["nextCursor"];
  if (rawCursor !== null && rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new Error("Codex App Server model/list returned an invalid cursor");
  }
  return { data: models, nextCursor: typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : null };
}

function parseThreadListPage(response: unknown): {
  data: CodexAppServerThreadInfo[];
  nextCursor: string | null;
} {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error("Codex App Server thread/list response is not an object");
  }
  const record = response as Record<string, unknown>;
  const rawData = record["data"];
  if (!Array.isArray(rawData)) throw new Error("Codex App Server thread/list response omitted data");
  const data = rawData.map((value): CodexAppServerThreadInfo => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Codex App Server thread/list returned an invalid thread");
    }
    const thread = value as Record<string, unknown>;
    const id = stringValue(thread["id"]);
    const updatedAt = thread["updatedAt"];
    if (id === null || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
      throw new Error("Codex App Server thread/list returned an invalid thread");
    }
    return {
      id,
      name: stringValue(thread["name"]),
      preview: stringValue(thread["preview"]),
      updatedAt: Math.floor(updatedAt),
      cwd: stringValue(thread["cwd"]),
      source: thread["source"],
      parentThreadId: stringValue(thread["parentThreadId"]),
    };
  });
  const rawCursor = record["nextCursor"];
  if (rawCursor !== null && rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new Error("Codex App Server thread/list returned an invalid cursor");
  }
  return { data, nextCursor: typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : null };
}

/** models_cacheのraw上限へ有効率を掛け、実行時token_countと同じ分母へ揃える。 */
function readModelContextWindows(cachePath: string): Map<string, number> {
  const result = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;
  const models = (parsed as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return result;
  for (const value of models) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const model = value as Record<string, unknown>;
    const slug = stringValue(model["slug"]);
    const rawWindow = positiveInteger(model["context_window"]);
    if (slug === null || rawWindow === undefined) continue;
    const percent = model["effective_context_window_percent"];
    const effective =
      typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100
        ? Math.floor(rawWindow * percent / 100)
        : rawWindow;
    if (effective > 0) result.set(slug, effective);
  }
  return result;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** App Server のUnix秒をprotocolのミリ秒へ揃える。将来ミリ秒値になっても二重変換しない。 */
function codexTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value < 10_000_000_000 ? value * 1_000 : value);
}

interface StartupLockInfo {
  /** 持ち主の pid。書き込み途中・壊れた lock は null。 */
  pid: number | null;
  /** lock の作成時刻（記録が無ければファイルの更新時刻）。 */
  createdAt: number;
}

/** startup lock の中身。lock が無ければ null。 */
function readStartupLock(lockPath: string): StartupLockInfo | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const pid = record["pid"];
    const createdAt = record["createdAt"];
    return {
      pid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : mtimeMs,
    };
  } catch {
    // 作成直後で pid がまだ書かれていない・壊れている。新しい間は持ち主がいるものとして扱う。
    return { pid: null, createdAt: mtimeMs };
  }
}

/**
 * lock が新しく、持ち主が生きている（pid 未記入の作成直後を含む）なら true。時計が戻って
 * 未来の時刻になった lock は古い lock として扱う。
 */
function startupLockIsHeld(lock: StartupLockInfo | null): boolean {
  if (lock === null) return false;
  if (!isWithin(Date.now() - lock.createdAt, STARTUP_LOCK_STALE_MS)) return false;
  return lock.pid === null || processIsAlive(lock.pid);
}

/** 経過時間 age が ttl 未満の「新しい」範囲か（時計が戻った分の負は古い扱い。CLOCK_ROLLBACK_TOLERANCE_MS）。 */
function isWithin(age: number, ttl: number): boolean {
  return age >= -CLOCK_ROLLBACK_TOLERANCE_MS && age < ttl;
}

/**
 * `CodexAppServerManager` の既定の CODEX_HOME。`TAILII_CODEX_APP_SERVER_HOME` で差し替え可
 * （テストの隔離用。開発機の実物の daemon・~/.codex に触れないため）。
 */
function defaultAppServerCodexHome(): string {
  const override = process.env["TAILII_CODEX_APP_SERVER_HOME"];
  if (override !== undefined && override.length > 0) return override;
  return path.join(os.homedir(), ".codex");
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 数値の版（`0.163.0`）を部分ごとに比べる。a が古ければ負、同じなら 0、新しければ正。 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface ReplaceRecord {
  pair: string;
  result: string;
  at: number;
}

function readReplaceRecord(recordPath: string): ReplaceRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const pair = record["pair"];
    const result = record["result"];
    const at = record["at"];
    if (typeof pair !== "string" || typeof result !== "string" || typeof at !== "number" || !Number.isFinite(at)) {
      return null;
    }
    return { pair, result, at };
  } catch {
    return null;
  }
}

/**
 * daemon がメモリに読み込んでいる thread（購読中・実行中・購読者が去って unload 待ち）。
 * `thread/loaded/list` は 0.145.0〜0.163.0 のバイナリで確認（サポート下限 0.144.5 は未確認）。
 * 取れない・形が違うなら null（入れ替えの判定では「使用中かもしれない」側へ倒す）。
 */
async function listLoadedThreadIds(connection: CodexAppServerConnection): Promise<string[] | null> {
  const ids: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 100; page += 1) {
      const response = objectRecord(
        await connection.request("thread/loaded/list", cursor !== null ? { cursor } : {}),
      );
      const data = response?.["data"];
      if (!Array.isArray(data) || !data.every((id): id is string => typeof id === "string")) return null;
      ids.push(...data);
      const next = response?.["nextCursor"];
      if (next === null || next === undefined) return ids;
      if (typeof next !== "string" || seenCursors.has(next)) return null;
      seenCursors.add(next);
      cursor = next;
    }
    return null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
