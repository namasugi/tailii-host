// codexAppServer.ts
// Tailii host が共有 Codex App Server を再利用・起動し、thread ID を先に確定する最小クライアント。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket, { type RawData } from "ws";
import { ensureDirectory0700 } from "./paths.js";
import type { CodexModelInfo } from "./protocol.js";

export type CodexAppServerSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAppServerApprovalPolicy = "untrusted" | "on-request" | "never";

export interface CodexThreadStartOptions {
  cwd: string;
  model?: string | null;
  sandbox?: CodexAppServerSandbox | null;
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
  initialize(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
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
      const onError = (error: Error): void => {
        socket.removeListener("open", onOpen);
        reject(error);
      };
      const onOpen = (): void => {
        socket.removeListener("error", onError);
        resolve(new WebSocketCodexAppServerConnection(socket, requestTimeoutMs));
      };
      socket.once("error", onError);
      socket.once("open", onOpen);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "tailii_host", title: "Tailii Host", version: "0.1.1" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", undefined);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
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
  constructor(
    readonly threadId: string,
    readonly initialItems: readonly Record<string, unknown>[],
    readonly initialActiveTurnId: string | null,
    /**
     * この接続で thread/resume（または作成元 bootstrap）が成功し、live 通知を受け取れるか。
     * rollout 未生成の新規 thread は resume に失敗するため false。呼び出し側は初回 turn の
     * 表示を rollout tail へフォールバックし、通知が来ない接続を live 権威にしない。
     */
    readonly liveSubscriptionReady: boolean,
    private readonly connection: CodexAppServerConnection,
    private readonly cwd: string | null,
  ) {}

  async startTurn(
    text: string,
    clientUserMessageId?: string | null,
    effort?: string | null,
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null,
    approvalPolicy?: CodexAppServerApprovalPolicy | null,
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
    const response = await this.connection.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(effort ? { effort } : {}),
      ...(effectiveSandbox ? { sandboxPolicy: codexSandboxPolicy(effectiveSandbox) } : {}),
      ...(effectiveApprovalPolicy ? { approvalPolicy: effectiveApprovalPolicy } : {}),
      ...(effectiveApprovalsReviewer ? { approvalsReviewer: effectiveApprovalsReviewer } : {}),
    });
    const turnId = extractTurnId(response);
    if (turnId === null) throw new Error("Codex App Server turn/start response omitted turn.id");
    return turnId;
  }

  async steerTurn(turnId: string, text: string): Promise<void> {
    if (text.length === 0) throw new Error("Codex turn text must not be empty");
    await this.connection.request("turn/steer", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      expectedTurnId: turnId,
    });
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
  private readonly startupLockPath: string;
  /** 最初の turn 前（rollout 未作成）の thread を生存させる作成元購読。openThread が引き継ぐ。 */
  private readonly bootstrapConnections = new Map<string, CodexAppServerConnection>();

  constructor(options: CodexAppServerManagerOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
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
    this.startupLockPath = path.join(path.dirname(this.socketPath), "tailii-start.lock");
  }

  /** serverを再利用または排他的に起動し、利用可能になるまで待つ。 */
  async ensureRunning(): Promise<void> {
    if (await this.probe()) return;

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
      await this.launch(
        this.codexPath,
        ["app-server", "--listen", this.remoteEndpoint],
        { ...process.env, CODEX_HOME: this.codexHome },
      );
      if (!(await this.waitUntilReady())) {
        throw new Error("Codex App Server failed to become ready");
      }
    } finally {
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd);
        } catch {
          // 無視。
        }
        try {
          fs.unlinkSync(this.startupLockPath);
        } catch {
          // 無視。
        }
      }
    }
  }

  /** 稼働中の server にだけ接続する。停止中・不達時は起動せず null を返す。 */
  async connectIfRunning(requestTimeoutMs = 2_000): Promise<CodexAppServerConnection | null> {
    let connection: CodexAppServerConnection | null = null;
    try {
      connection = await this.connect(this.socketPath, requestTimeoutMs);
      await connection.initialize();
      return connection;
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
      succeeded = true;
      return threadId;
    } finally {
      if (!succeeded) connection.close();
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
          isDefault: raw["isDefault"] === true,
        }];
      });
    } finally {
      connection.close();
    }
  }

  /** 既存 thread を購読する長寿命接続を開く。turn と native approval はこの接続を流れる。 */
  async openThread(options: CodexAppServerThreadOptions): Promise<CodexAppServerThread> {
    await this.ensureRunning();
    const bootstrap = this.bootstrapConnections.get(options.threadId) ?? null;
    if (bootstrap !== null) this.bootstrapConnections.delete(options.threadId);
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
    try {
      let initialItems: Record<string, unknown>[] = [];
      let initialActiveTurnId: string | null = null;
      let liveSubscriptionReady = bootstrap !== null;
      if (bootstrap === null) {
        await connection.initialize();
        try {
          const response = await connection.request("thread/resume", {
            threadId: options.threadId,
            // Hub の rollout backfill と live 通知の厳密な境界に履歴 item ID を使う。
            excludeTurns: false,
          });
          initialItems = extractThreadItems(response);
          initialActiveTurnId = extractActiveTurnId(response);
          liveSubscriptionReady = true;
        } catch (error) {
          // thread/start から最初の user turn まで rollout は未作成で、別接続からの
          // thread/resume は "no rollout found" になる。ただし共有 App Server 内の
          // live thread 自体は存在し、この接続から turn/start を直接送れば materialize
          // できる。engine と Session Hub は別プロセスなので、この場合だけ履歴ゼロとして
          // 接続を維持し、最初の turn/start へ進ませる。
          if (!isUnmaterializedThreadError(error, options.threadId)) throw error;
        }
      }
      return new CodexAppServerThread(
        options.threadId,
        initialItems,
        initialActiveTurnId,
        liveSubscriptionReady,
        connection,
        options.cwd ?? null,
      );
    } catch (error) {
      removeNotification();
      removeServerRequest();
      removeDisconnect();
      connection.close();
      throw error;
    }
  }

  private async probe(): Promise<boolean> {
    const connection = await this.connectIfRunning();
    if (connection === null) return false;
    connection.close();
    return true;
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

  /** lockが他の生存processに所有されていればnull。死んだownerのlockは1回だけ回収する。 */
  private acquireStartupLock(): number | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.startupLockPath, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return fd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const ownerPid = readLockPid(this.startupLockPath);
        if (ownerPid !== null && processIsAlive(ownerPid)) return null;
        try {
          fs.unlinkSync(this.startupLockPath);
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

function isUnmaterializedThreadError(error: unknown, threadId: string): boolean {
  return error instanceof Error &&
    error.message === `no rollout found for thread id ${threadId}`;
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

function extractThreadItems(response: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  if (typeof response !== "object" || response === null) return result;
  const thread = (response as Record<string, unknown>)["thread"];
  if (typeof thread !== "object" || thread === null) return result;
  const turns = (thread as Record<string, unknown>)["turns"];
  if (!Array.isArray(turns)) return result;
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null) continue;
    const items = (turn as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      result.push(item as Record<string, unknown>);
    }
  }
  return result;
}

/** thread/resume が返す turn 一覧から、別 client が開始した実行中 turn を復元する。 */
function extractActiveTurnId(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const thread = (response as Record<string, unknown>)["thread"];
  if (typeof thread !== "object" || thread === null) return null;
  const turns = (thread as Record<string, unknown>)["turns"];
  if (!Array.isArray(turns)) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) continue;
    const record = turn as Record<string, unknown>;
    if (record["status"] !== "inProgress") continue;
    const id = record["id"];
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

function readLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const pid = (parsed as Record<string, unknown>)["pid"];
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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
