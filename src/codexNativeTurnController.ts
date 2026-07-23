// Codex App Server の長寿命 thread 接続、native approval、turn/start を Tailii へ結線する。

import * as net from "node:net";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerThreadOptions,
} from "./codexAppServer.js";
import {
  decodeControlMessage,
  encodeControlMessage,
  PROTOCOL_V1,
  type Decision,
  type QuestionAnswer,
  type QuestionPromptQuestion,
} from "./protocol.js";
import type { ControlMessage } from "./protocol.js";
import { resolveSocketPath } from "./socketPath.js";
import { sleep } from "./sleep.js";
import {
  codexItemToolActivities,
  codexPlanUpdateActivity,
  toolActivityContentKey,
  toolActivityMessage,
} from "./codexToolActivity.js";

export interface CodexNativeApproval {
  id: string;
  session: string;
  tool: string;
  summary: string;
  cwd: string;
}

export type CodexApprovalBroker = (approval: CodexNativeApproval) => Promise<Decision>;

export interface CodexNativeTurnControllerOptions {
  appServer: CodexAppServerThreadRuntime;
  approvalBroker?: CodexApprovalBroker;
  onProcessing?: (session: string, state: "active" | "done") => void;
  onModel?: (session: string, model: string) => void;
  onTokenUsage?: (
    session: string,
    totalTokens: number,
    contextWindow: number | null,
  ) => void;
  onQuestion?: (event: {
    session: string;
    id: string;
    questions: QuestionPromptQuestion[];
  }) => void;
  onQuestionDismiss?: (session: string, id: string) => void;
  onChatItem?: (event: { session: string; itemId: string; payload: ControlMessage }) => void;
  onDisconnect?: (session: string, error: Error) => void;
}

export interface CodexTurnControllerRuntime {
  subscribeSession?(options: {
    session: string;
    threadId: string;
    cwd: string;
  }): Promise<CodexSubscriptionSnapshot>;
  startTurn(options: {
    session: string;
    threadId: string;
    cwd: string;
    text: string;
    clientUserMessageId?: string | null;
    effort?: string | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
    approvalPolicy?: CodexAppServerApprovalPolicy | null;
  }): Promise<string>;
  interruptTurn?(session: string): Promise<void>;
  closeSession(session: string): void;
  close(): void;
  answerQuestion?(id: string, answers: QuestionAnswer[]): boolean;
}

export interface CodexThreadClient {
  readonly initialItems?: readonly Record<string, unknown>[];
  readonly initialActiveTurnId?: string | null;
  startTurn(
    text: string,
    clientUserMessageId?: string | null,
    effort?: string | null,
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null,
    approvalPolicy?: CodexAppServerApprovalPolicy | null,
  ): Promise<string>;
  steerTurn(turnId: string, text: string): Promise<void>;
  interruptTurn(turnId: string): Promise<void>;
  close(): void;
}

export interface CodexSubscriptionSnapshot {
  itemIds: ReadonlySet<string>;
  contentCounts: ReadonlyMap<string, number>;
}

export interface CodexAppServerThreadRuntime {
  openThread(options: CodexAppServerThreadOptions): Promise<CodexThreadClient>;
}

interface OpenThread {
  threadId: string;
  cwd: string;
  thread: CodexThreadClient;
  items: Map<string, Record<string, unknown>>;
  activeTurnId: string | null;
  /** turn/plan/updated へ振る連番（通知に item id が無いため dedup 用 id を合成する）。 */
  planSeq: number;
}

interface PendingUserInput {
  session: string;
  threadId: string;
  questions: Record<string, unknown>[];
  resolve: (response: unknown) => void;
}

/**
 * Tailii から開始した Codex turn を同じ App Server 接続で保持する。
 * server-initiated approval は既存 per-session serve socket へ渡すため、Codex hook は不要。
 */
export class CodexNativeTurnController implements CodexTurnControllerRuntime {
  private readonly appServer: CodexAppServerThreadRuntime;
  private readonly approvalBroker: CodexApprovalBroker;
  private readonly onProcessing: (session: string, state: "active" | "done") => void;
  private readonly onModel: NonNullable<CodexNativeTurnControllerOptions["onModel"]>;
  private readonly onTokenUsage: NonNullable<
    CodexNativeTurnControllerOptions["onTokenUsage"]
  >;
  private readonly onQuestion: NonNullable<CodexNativeTurnControllerOptions["onQuestion"]>;
  private readonly onQuestionDismiss: NonNullable<
    CodexNativeTurnControllerOptions["onQuestionDismiss"]
  >;
  private readonly onChatItem: NonNullable<CodexNativeTurnControllerOptions["onChatItem"]>;
  private readonly onDisconnect: NonNullable<CodexNativeTurnControllerOptions["onDisconnect"]>;
  private readonly open = new Map<string, OpenThread>();
  private readonly pendingUserInput = new Map<string, PendingUserInput>();

  constructor(options: CodexNativeTurnControllerOptions) {
    this.appServer = options.appServer;
    this.approvalBroker = options.approvalBroker ?? requestCodexApprovalViaBroker;
    this.onProcessing = options.onProcessing ?? (() => {});
    this.onModel = options.onModel ?? (() => {});
    this.onTokenUsage = options.onTokenUsage ?? (() => {});
    this.onQuestion = options.onQuestion ?? (() => {});
    this.onQuestionDismiss = options.onQuestionDismiss ?? (() => {});
    this.onChatItem = options.onChatItem ?? (() => {});
    this.onDisconnect = options.onDisconnect ?? (() => {});
  }

  async subscribeSession(options: {
    session: string;
    threadId: string;
    cwd: string;
  }): Promise<CodexSubscriptionSnapshot> {
    const opened = await this.threadFor(options.session, options.threadId, options.cwd);
    const itemIds = new Set<string>();
    const contentCounts = new Map<string, number>();
    for (const item of opened.thread.initialItems ?? []) {
      const id = item["id"];
      if (typeof id === "string" && id.length > 0) itemIds.add(id);
      const payload = codexItemToChatOutput(item);
      const key = payload === null ? null : chatContentKey(payload);
      if (key !== null) contentCounts.set(key, (contentCounts.get(key) ?? 0) + 1);
    }
    return { itemIds, contentCounts };
  }

  async startTurn(options: {
    session: string;
    threadId: string;
    cwd: string;
    text: string;
    clientUserMessageId?: string | null;
    effort?: string | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
    approvalPolicy?: CodexAppServerApprovalPolicy | null;
  }): Promise<string> {
    const opened = await this.threadFor(options.session, options.threadId, options.cwd);
    this.onProcessing(options.session, "active");
    try {
      const activeTurnId = opened.activeTurnId;
      if (activeTurnId !== null) {
        try {
          await opened.thread.steerTurn(activeTurnId, options.text);
          return activeTurnId;
        } catch {
          // turn 完了直後など steer と競合した場合は、新しい turn を開始する。
        }
      }
      const turnId = await opened.thread.startTurn(
        options.text,
        options.clientUserMessageId,
        options.effort,
        options.sandbox,
        options.approvalPolicy,
      );
      opened.activeTurnId = turnId;
      return turnId;
    } catch (error) {
      this.onProcessing(options.session, "done");
      throw error;
    }
  }

  async interruptTurn(session: string): Promise<void> {
    const opened = this.open.get(session);
    if (opened === undefined || opened.activeTurnId === null) return;
    await opened.thread.interruptTurn(opened.activeTurnId);
  }

  closeSession(session: string): void {
    const opened = this.open.get(session);
    if (opened === undefined) return;
    this.open.delete(session);
    opened.thread.close();
    this.resolvePendingQuestionsForSession(session);
    this.onProcessing(session, "done");
  }

  close(): void {
    for (const session of [...this.open.keys()]) this.closeSession(session);
  }

  /** iOS の既存 QuestionPromptSheet 回答を native requestUserInput response へ戻す。 */
  answerQuestion(id: string, answers: QuestionAnswer[]): boolean {
    const pending = this.pendingUserInput.get(id);
    if (pending === undefined) return false;
    this.pendingUserInput.delete(id);
    const wireAnswers: Record<string, { answers: string[] }> = {};
    for (const answer of answers) {
      const question = pending.questions[answer.questionIndex];
      if (question === undefined) continue;
      const questionId = question["id"];
      if (typeof questionId !== "string") continue;
      const rawOptions = Array.isArray(question["options"])
        ? question["options"].map(asRecord).filter((value): value is Record<string, unknown> => value !== null)
        : [];
      const values = answer.selectedOptionIndexes.flatMap((index) => {
        const label = rawOptions[index]?.["label"];
        return typeof label === "string" ? [label] : [];
      });
      const other = answer.otherText?.trim();
      if (other) values.push(other);
      wireAnswers[questionId] = { answers: values };
    }
    pending.resolve({ answers: wireAnswers });
    this.onQuestionDismiss(pending.session, id);
    return true;
  }

  private async threadFor(session: string, threadId: string, cwd: string): Promise<OpenThread> {
    const existing = this.open.get(session);
    if (existing?.threadId === threadId) return existing;
    if (existing !== undefined) this.closeSession(session);

    const items = new Map<string, Record<string, unknown>>();
    const bufferedNotifications: CodexAppServerNotification[] = [];
    let notificationTargetReady = false;
    const thread = await this.appServer.openThread({
      threadId,
      cwd,
      onNotification: (notification) => {
        if (!notificationTargetReady) {
          bufferedNotifications.push(notification);
          return;
        }
        this.handleNotification(session, threadId, items, notification);
      },
      onServerRequest: (request) => this.handleServerRequest(session, cwd, items, request),
      onDisconnect: (error) => {
        const current = this.open.get(session);
        if (current?.threadId !== threadId) return;
        this.open.delete(session);
        this.resolvePendingQuestionsForSession(session);
        this.onProcessing(session, "done");
        this.onDisconnect(session, error);
      },
    });
    const opened = {
      threadId,
      cwd,
      thread,
      items,
      activeTurnId: thread.initialActiveTurnId ?? null,
      planSeq: 0,
    };
    this.open.set(session, opened);
    notificationTargetReady = true;
    if (opened.activeTurnId !== null) this.onProcessing(session, "active");
    for (const notification of bufferedNotifications) {
      this.handleNotification(session, threadId, items, notification);
    }
    return opened;
  }

  private handleNotification(
    session: string,
    threadId: string,
    items: Map<string, Record<string, unknown>>,
    notification: CodexAppServerNotification,
  ): void {
    const params = asRecord(notification.params);
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = asRecord(params?.["item"]);
      const id = item?.["id"];
      if (item !== null && typeof id === "string") items.set(id, item);
      if (notification.method === "item/completed" && item !== null && typeof id === "string") {
        const payload = codexItemToChatOutput(item);
        if (payload !== null) this.onChatItem({ session, itemId: id, payload });
        // コマンド実行 / ファイル変更は tool_activity カードとして別 itemId で流す
        // （同一 item から chat 本文と tool カードの両方が出ることは無いが、dedup 集合を分ける）。
        codexItemToolActivities(item).forEach((activity, index) => {
          this.onChatItem({
            session,
            itemId: `${id}#tool-${index}`,
            payload: toolActivityMessage(activity),
          });
        });
      }
    }
    if (notification.method === "turn/plan/updated" && params !== null) {
      const current = this.open.get(session);
      if (current?.threadId === threadId) {
        const turnId = typeof params["turnId"] === "string" ? params["turnId"] : "turn";
        const itemId = `plan:${turnId}:${current.planSeq}`;
        const activity = codexPlanUpdateActivity(itemId, params);
        if (activity !== null) {
          current.planSeq += 1;
          this.onChatItem({ session, itemId, payload: toolActivityMessage(activity) });
        }
      }
    }
    if (notification.method === "turn/started") {
      const current = this.open.get(session);
      const startedTurn = asRecord(params?.["turn"])?.["id"];
      if (current?.threadId === threadId && typeof startedTurn === "string" && startedTurn.length > 0) {
        current.activeTurnId = startedTurn;
      }
      this.onProcessing(session, "active");
    }
    if (notification.method === "turn/completed") {
      const current = this.open.get(session);
      const completedTurn = asRecord(params?.["turn"])?.["id"];
      if (current?.threadId === threadId &&
        (typeof completedTurn !== "string" || current.activeTurnId === completedTurn)) {
        current.activeTurnId = null;
      }
      this.onProcessing(session, "done");
      this.resolvePendingQuestionsForSession(session);
    }
    if (notification.method === "thread/settings/updated") {
      const settings = asRecord(params?.["threadSettings"]);
      const model = settings?.["model"];
      if (typeof model === "string" && model.length > 0) this.onModel(session, model);
    }
    if (notification.method === "model/rerouted" && params?.["threadId"] === threadId) {
      const model = params["toModel"];
      if (typeof model === "string" && model.length > 0) this.onModel(session, model);
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params?.["tokenUsage"]);
      const last = asRecord(tokenUsage?.["last"]);
      const contextTokens = nonNegativeInteger(last?.["totalTokens"]);
      if (contextTokens !== null) {
        this.onTokenUsage(
          session,
          contextTokens,
          positiveInteger(tokenUsage?.["modelContextWindow"]),
        );
      }
    }
  }

  private async handleServerRequest(
    session: string,
    fallbackCwd: string,
    items: Map<string, Record<string, unknown>>,
    request: CodexAppServerRequest,
  ): Promise<unknown> {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      const params = asRecord(request.params) ?? {};
      const itemId = typeof params["itemId"] === "string" ? params["itemId"] : "unknown";
      const item = items.get(itemId);
      const command = typeof params["command"] === "string" ? params["command"] : null;
      const reason = typeof params["reason"] === "string" ? params["reason"] : null;
      const cwd = typeof params["cwd"] === "string" ? params["cwd"] : fallbackCwd;
      const isCommand = request.method === "item/commandExecution/requestApproval";
      const summary = isCommand
        ? (command ?? reason ?? "コマンドの実行を許可しますか？")
        : fileChangeSummary(item, reason);
      const decision = await this.approvalBroker({
        id: `codex:${String(params["threadId"] ?? "thread")}:${String(request.id)}`,
        session,
        tool: isCommand ? "Bash" : "Edit",
        summary,
        cwd,
      });
      return { decision: decision === "allow" ? "accept" : "decline" };
    }

    if (request.method === "item/tool/requestUserInput") {
      const params = asRecord(request.params) ?? {};
      const threadId = typeof params["threadId"] === "string" ? params["threadId"] : "thread";
      const rawQuestions = Array.isArray(params["questions"])
        ? params["questions"].map(asRecord).filter((value): value is Record<string, unknown> => value !== null)
        : [];
      const id = `codex-question:${threadId}:${String(request.id)}`;
      const questions: QuestionPromptQuestion[] = rawQuestions.map((question) => ({
        header: typeof question["header"] === "string" ? question["header"] : "質問",
        question: typeof question["question"] === "string" ? question["question"] : "入力してください",
        multiSelect: false,
        options: Array.isArray(question["options"])
          ? question["options"].flatMap((option) => {
              const record = asRecord(option);
              const label = record?.["label"];
              if (typeof label !== "string") return [];
              return [{
                label,
                description:
                  typeof record?.["description"] === "string" ? record["description"] : "",
              }];
            })
          : [],
      }));
      this.onQuestion({ session, id, questions });
      return new Promise((resolve) => {
        this.pendingUserInput.set(id, {
          session,
          threadId,
          questions: rawQuestions,
          resolve,
        });
      });
    }
    if (request.method === "currentTime/read") {
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    }
    throw new Error(`unsupported Codex App Server request: ${request.method}`);
  }

  private resolvePendingQuestionsForSession(session: string): void {
    for (const [id, pending] of this.pendingUserInput) {
      if (pending.session !== session) continue;
      this.pendingUserInput.delete(id);
      pending.resolve({ answers: {} });
      this.onQuestionDismiss(session, id);
    }
  }
}

/** rollout の event_msg(user_message / agent_message) と同じ表示範囲へ写像する。 */
export function codexItemToChatOutput(item: Record<string, unknown>): ControlMessage | null {
  const id = item["id"];
  const type = item["type"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (type === "userMessage") {
    const content = item["content"];
    if (!Array.isArray(content)) return null;
    const text = content.flatMap((part) => {
      const record = asRecord(part);
      return record?.["type"] === "text" && typeof record["text"] === "string"
        ? [record["text"] as string]
        : [];
    }).join("\n");
    if (text.length === 0) return null;
    return { type: "chat_output", v: PROTOCOL_V1, streamId: `codex-item-${id}`,
      role: "user", text, eof: true };
  }
  if (type === "agentMessage") {
    const phase = item["phase"];
    if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") return null;
    const text = item["text"];
    if (typeof text !== "string" || text.length === 0) return null;
    return { type: "chat_output", v: PROTOCOL_V1, streamId: `codex-item-${id}`,
      role: "assistant", text, eof: true };
  }
  return null;
}

export function chatContentKey(payload: ControlMessage): string | null {
  // tool_activity は live（App Server item）と rollout（response_item / patch_apply_end）の
  // 両系統から同じ内容で生成される。id は系統間で一致しないため内容キーで照合する。
  if (payload.type === "tool_activity") {
    return toolActivityContentKey(payload.activity);
  }
  if (payload.type !== "chat_output" || (payload.role !== "user" && payload.role !== "assistant")) {
    return null;
  }
  return `${payload.role}\u0000${payload.text}`;
}

/** App Server approval を既存 iPhone serve channel へ流し、同じ id の決定だけを待つ。 */
export async function requestCodexApprovalViaBroker(
  approval: CodexNativeApproval,
  options: { connectTimeoutMs?: number; decisionTimeoutMs?: number } = {},
): Promise<Decision> {
  const socketPath = resolveSocketPath(approval.session);
  const connectDeadline = Date.now() + (options.connectTimeoutMs ?? 10_000);
  let socket: net.Socket | null = null;
  do {
    socket = await connectSocket(socketPath);
    if (socket !== null) break;
    await sleep(200);
  } while (Date.now() <= connectDeadline);
  if (socket === null) return "deny";

  const request = encodeControlMessage({
    type: "approval_request",
    v: PROTOCOL_V1,
    id: approval.id,
    tool: approval.tool,
    summary: approval.summary,
    cwd: approval.cwd,
  });
  return new Promise<Decision>((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (decision: Decision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => finish("deny"), options.decisionTimeoutMs ?? 540_000);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).replaceAll("\r", "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = decodeControlMessage(line);
          if (message.type === "approval_decision" && message.id === approval.id) {
            finish(message.decision);
            return;
          }
        } catch {
          // channel_hello 以外の壊れた行も無視し、正しい決定を待つ。
        }
      }
    });
    socket.once("error", () => finish("deny"));
    socket.once("close", () => finish("deny"));
    socket.write(request + "\n");
  });
}

function connectSocket(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      resolve(socket);
    });
    socket.once("error", () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(null);
    });
  });
}

function fileChangeSummary(item: Record<string, unknown> | undefined, reason: string | null): string {
  const changes = item?.["changes"];
  if (Array.isArray(changes)) {
    const paths = changes
      .map((change) => asRecord(change)?.["path"])
      .filter((value): value is string => typeof value === "string")
      .slice(0, 4);
    if (paths.length > 0) return `ファイル変更: ${paths.join(", ")}`;
  }
  return reason ?? "ファイルの変更を許可しますか？";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const integer = nonNegativeInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}
