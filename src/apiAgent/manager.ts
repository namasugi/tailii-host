// apiAgent/manager.ts
// API 作業（Agent SDK で 1 ターンずつ実行する Claude 会話）の hub 側の制御。所有者は hub。
//
// - 1 ターン = 1 作業プロセス = 1 回の `query()`。新規は `sessionId: 会話id`、2 ターン目以降は `resume: 会話id`。
// - 処理中に届いた発話は貯めて、ターンが終わったら次のターンとしてまとめて送る。中断したら送らずに返す
//   （`restoredTexts`。入力欄へ戻す。対話型 Claude Code の Esc と同じ扱い）。
// - 予算: 会話の累計が上限に達していれば始めない。1 ターンの上限は min(1 ターン上限, 残り) を SDK の
//   maxBudgetUsd に渡す（SDK はモデル呼び出しの後で判定するため、直後の 1 回分は超えうる。実測）。
// - 利用額: 結果の累計 − 開始前の JSONL の基準（ledger.ts）。結果を受け取れなかったターンは利用額未確認。
// - 承認は既存の承認カード（approval_request → 先着の調停）へ、設問は hub の設問カードへ写す。
// - キーが無い・認証が想定外なら止める。サブスクのログインへ切り替えない。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ApiAgentConfig,
  ApiAgentErrorCode,
  ApiAgentState,
  ApiAgentTurnOutcome,
  ControlMessage,
  Decision,
  QuestionAnswer,
  QuestionPromptQuestion,
  ToolDiff,
} from "../protocol/messages.js";
import { PROTOCOL_V2 } from "../protocol/messages.js";
import { claudeProjectSlug } from "../shared/paths.js";
import { ApiAgentRejectedError, validApiAgentConfig } from "./config.js";
import type { ApiAgentKeyError, ApiAgentKeyResolution } from "./keyEnvironment.js";
import {
  ApiAgentLedgerStore,
  readTranscriptCostBaseline,
  summarizeLedger,
  turnCostFromCumulative,
  type ApiAgentLedger,
} from "./ledger.js";
import { ApiAgentSessionStore } from "./sessionState.js";
import { isConversationUuid, type HubToWorker, type WorkerToHub } from "./workerProtocol.js";

export interface ApiAgentWorkerHandle {
  readonly pid: number | null;
  send(message: HubToWorker): void;
  onMessage(listener: (message: WorkerToHub) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface ApiAgentApprovalRequest {
  id: string;
  session: string;
  tool: string;
  summary: string;
  cwd: string;
  diff?: ToolDiff;
  /** ターンが終わったら（中断・終了）承認待ちをやめる。 */
  signal?: AbortSignal;
}

export type ApiAgentStatusMessage = Extract<ControlMessage, { type: "api_agent_status" }>;

export interface ApiAgentManagerOptions {
  spawnWorker: (env: NodeJS.ProcessEnv) => ApiAgentWorkerHandle;
  resolveKey: (config: ApiAgentConfig) => Promise<ApiAgentKeyResolution | ApiAgentKeyError>;
  /** 作業プロセスの env を組む（基本の変数 + 秘密）。 */
  workerEnvironment: (secretEnv: Record<string, string>) => NodeJS.ProcessEnv;
  /** この会話を掴んでいる生存プロセス（端末側・Tailii 外）。 */
  conversationHolders: (conversationId: string) => { pid: number; name: string }[];
  approval: (request: ApiAgentApprovalRequest) => Promise<Decision>;
  summarizeTool?: (toolName: string, input: Record<string, unknown>) => { summary: string; diff?: ToolDiff };
  onProcessing?: (session: string, state: "active" | "done") => void;
  onStatus?: (session: string, status: ApiAgentStatusMessage) => void;
  /** 設問カードを出せないとき（未設定）は AskUserQuestion を断る。 */
  onQuestion?: (event: { session: string; id: string; questions: QuestionPromptQuestion[] }) => void;
  onQuestionDismiss?: (session: string, id: string) => void;
  ledgerStore?: ApiAgentLedgerStore;
  sessionStore?: ApiAgentSessionStore;
  /** 会話の JSONL（既定 `~/.claude/projects/<slug>/<id>.jsonl`）。 */
  transcriptPath?: (cwd: string, conversationId: string) => string;
  /** JSONL があるか（新規の会話が書き始められたかの判定。既定は fs.existsSync）。 */
  transcriptExists?: (transcriptPath: string) => boolean;
  /** 導入済みの claude を使う場合の絶対パス（SDK を実行ファイル抜きで入れたとき）。 */
  claudeExecutable?: () => string | null;
  /** ターンを始める前の確認（SDK 未導入・版のずれ）。止める理由を返す。作業プロセスもキーも使う前に呼ぶ。 */
  preflight?: () => ApiAgentErrorCode | null;
  settingSources?: ("user" | "project" | "local")[];
  /** 中断の後、作業プロセスが終わらないときに強制終了するまでの猶予。 */
  interruptGraceMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface RunningTurn {
  turnId: string;
  worker: ApiAgentWorkerHandle;
  baselineUsd: number | null;
  authOk: boolean | null;
  result: Extract<WorkerToHub, { t: "result" }> | null;
  errorCode: Extract<WorkerToHub, { t: "error" }>["code"] | null;
  interrupted: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  questionIds: Set<string>;
  /** このターンの承認待ちの中止（ターンの終わりで abort）。 */
  abort: AbortController;
}

interface Conversation {
  session: string;
  conversationId: string;
  cwd: string;
  config: ApiAgentConfig;
  ledger: ApiAgentLedger;
  /** 既に会話（JSONL）があるか。true なら resume で続ける。 */
  started: boolean;
  queue: string[];
  running: RunningTurn | null;
  disposed: boolean;
  lastOutcome?: ApiAgentTurnOutcome;
  lastError?: ApiAgentErrorCode;
}

interface PendingQuestion {
  session: string;
  requestId: string;
  rawQuestions: unknown[];
  questions: QuestionPromptQuestion[];
  worker: ApiAgentWorkerHandle;
}

const QUESTION_ID_PREFIX = "api-agent-question-";

export class ApiAgentManager {
  private readonly conversations = new Map<string, Conversation>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly ledgerStore: ApiAgentLedgerStore;
  private readonly sessionStore: ApiAgentSessionStore;
  private readonly now: () => number;

  constructor(private readonly options: ApiAgentManagerOptions) {
    this.ledgerStore = options.ledgerStore ?? new ApiAgentLedgerStore();
    this.sessionStore = options.sessionStore ?? new ApiAgentSessionStore();
    this.now = options.now ?? Date.now;
  }

  /** hub 起動時: 開いていた会話を待機状態で戻す。前回のプロセスが残した running は利用額未確認へ。 */
  restore(): string[] {
    const restored: string[] = [];
    for (const record of this.sessionStore.all()) {
      if (this.conversations.has(record.name)) continue;
      const ledger = this.ledgerStore.load(record.conversationId);
      if (this.ledgerStore.settleOrphans(ledger, this.now())) this.saveLedger(ledger);
      this.conversations.set(record.name, {
        session: record.name, conversationId: record.conversationId, cwd: record.cwd, config: record.config,
        ledger, started: true, queue: [], running: null, disposed: false,
      });
      restored.push(record.name);
    }
    return restored;
  }

  /** 会話を開く（新規 / 既存の会話 id）。同じ会話 id を別のセッション名で開いていれば断る。 */
  open(session: string, request: { conversationId: string; cwd: string; config: ApiAgentConfig; resume: boolean }): void {
    if (!isConversationUuid(request.conversationId) || !path.isAbsolute(request.cwd) || !validApiAgentConfig(request.config)) {
      throw new ApiAgentRejectedError("invalid_config");
    }
    for (const other of this.conversations.values()) {
      if (other.session !== session && other.conversationId === request.conversationId) {
        throw new ApiAgentRejectedError("conversation_in_use");
      }
    }
    const existing = this.conversations.get(session);
    if (existing !== undefined) {
      if (existing.conversationId !== request.conversationId) throw new ApiAgentRejectedError("conversation_in_use");
      // 開いている会話の開き直し（一覧から開く・再接続）。設定は上書きしない（予算を上げた後に既定へ
      // 戻さない）。設定の変更は api_agent_configure だけで行う。
      this.emitStatus(existing);
      return;
    }
    const ledger = this.ledgerStore.load(request.conversationId);
    // 最後に使った実行経路を API 作業にする（一覧からの開き直しが API 作業になる）。
    const routeChanged = ledger.route !== "api";
    ledger.route = "api";
    if (this.ledgerStore.settleOrphans(ledger, this.now()) || routeChanged) this.saveLedger(ledger);
    const conversation: Conversation = {
      session, conversationId: request.conversationId, cwd: request.cwd, config: request.config,
      ledger, started: request.resume || ledger.turns.length > 0 || ledger.foldedTurns > 0,
      queue: [], running: null, disposed: false,
    };
    this.conversations.set(session, conversation);
    this.persistSession(conversation);
    this.emitStatus(conversation);
  }

  configure(session: string, config: ApiAgentConfig): void {
    const conversation = this.require(session);
    if (!validApiAgentConfig(config)) throw new ApiAgentRejectedError("invalid_config");
    conversation.config = config;
    conversation.lastError = undefined;
    this.persistSession(conversation);
    this.emitStatus(conversation);
    // 予算で止まっていた発話は、上限を上げたら続ける。
    if (conversation.running === null && conversation.queue.length > 0) void this.drain(conversation);
  }

  has(session: string): boolean { return this.conversations.has(session); }

  /**
   * 元へ戻すために閉じる。実行中のターンがあれば閉じずに "running"（先に止めるか終わるのを待ってもらう）。
   * 閉じたら最後に使った実行経路を端末にする（一覧からの開き直しが端末になる）。台帳は消さない。
   */
  close(session: string): "closed" | "running" | "not_open" {
    const conversation = this.conversations.get(session);
    if (conversation === undefined) return "not_open";
    if (conversation.running !== null) return "running";
    const { conversationId } = conversation;
    this.dispose(session);
    try { this.ledgerStore.setRoute(conversationId, "terminal"); } catch { /* 記録できなくても閉じたことは変わらない。 */ }
    return "closed";
  }
  isRunning(session: string): boolean { return this.conversations.get(session)?.running != null; }
  get hasTurnsInFlight(): boolean {
    for (const conversation of this.conversations.values()) if (conversation.running !== null) return true;
    return false;
  }
  conversationIdFor(session: string): string | null { return this.conversations.get(session)?.conversationId ?? null; }

  status(session: string): ApiAgentStatusMessage | null {
    const conversation = this.conversations.get(session);
    return conversation === undefined ? null : this.statusOf(conversation);
  }

  /**
   * 発話を受け付ける。待機中ならターンを始め、処理中なら次のターンへ回す。
   * 始められない（キー無し・予算到達・別の場所で使用中）ときは ApiAgentRejectedError（何も送っていない）。
   */
  async submit(session: string, text: string): Promise<"started" | "queued"> {
    const conversation = this.require(session);
    if (text.trim().length === 0) throw new ApiAgentRejectedError("invalid_config");
    if (conversation.running !== null) {
      conversation.queue.push(text);
      this.emitStatus(conversation);
      return "queued";
    }
    await this.startTurn(conversation, [text]);
    return "started";
  }

  /** 処理中のターンを止める。貯まっていた発話は送らずに返す。 */
  interrupt(session: string): boolean {
    const conversation = this.conversations.get(session);
    const running = conversation?.running;
    if (conversation === undefined || running == null) return false;
    if (!running.interrupted) {
      running.interrupted = true;
      try { running.worker.send({ t: "interrupt" }); } catch { /* 終了済み。 */ }
      running.killTimer = setTimeout(() => {
        try { running.worker.kill("SIGTERM"); } catch { /* 終了済み。 */ }
      }, this.options.interruptGraceMs ?? 10_000);
      running.killTimer.unref?.();
    }
    this.emitStatus(conversation);
    return true;
  }

  /** 終了（kill）。作業プロセスを止め、開いている記録を消す。台帳（利用額）は会話 id に残す。 */
  dispose(session: string): void {
    const conversation = this.conversations.get(session);
    if (conversation === undefined) return;
    conversation.disposed = true;
    conversation.queue = [];
    const running = conversation.running;
    if (running !== null) {
      running.interrupted = true;
      running.abort.abort();
      try { running.worker.send({ t: "interrupt" }); } catch { /* 終了済み。 */ }
      try { running.worker.kill("SIGTERM"); } catch { /* 終了済み。 */ }
    }
    this.conversations.delete(session);
    this.sessionStore.remove(session);
  }

  /** 設問への回答（hub の first-wins を通った勝者だけが呼ぶ）。 */
  answerQuestion(id: string, answers: QuestionAnswer[]): boolean {
    const pending = this.pendingQuestions.get(id);
    if (pending === undefined) return false;
    this.pendingQuestions.delete(id);
    const answerMap: Record<string, string> = {};
    for (const answer of answers) {
      const question = pending.questions[answer.questionIndex];
      if (question === undefined) continue;
      const labels = answer.selectedOptionIndexes
        .map((index) => question.options[index]?.label)
        .filter((label): label is string => typeof label === "string");
      const other = answer.otherText?.trim();
      const parts = other ? [...labels, other] : labels;
      if (parts.length > 0) answerMap[question.question] = parts.join(", ");
    }
    try {
      pending.worker.send({
        t: "permission_response", requestId: pending.requestId, behavior: "allow",
        updatedInput: { questions: pending.rawQuestions, answers: answerMap },
      });
    } catch {
      return false;
    }
    return true;
  }

  private require(session: string): Conversation {
    const conversation = this.conversations.get(session);
    if (conversation === undefined || conversation.disposed) throw new ApiAgentRejectedError("not_open");
    return conversation;
  }

  private async startTurn(conversation: Conversation, texts: string[]): Promise<void> {
    const { config } = conversation;
    const blocked = this.options.preflight?.() ?? null;
    if (blocked !== null) {
      conversation.lastError = blocked;
      this.emitStatus(conversation);
      throw new ApiAgentRejectedError(blocked);
    }
    const usage = summarizeLedger(conversation.ledger);
    const remaining = config.budget.conversationUsd - usage.totalUsd;
    if (remaining <= 0) {
      conversation.lastError = "budget_exhausted";
      this.emitStatus(conversation);
      throw new ApiAgentRejectedError("budget_exhausted");
    }
    const key = await this.options.resolveKey(config);
    if (typeof key === "string") {
      conversation.lastError = key;
      this.emitStatus(conversation);
      throw new ApiAgentRejectedError(key);
    }
    // await の間に終了された / 別の送信が先にターンを始めた。
    if (conversation.disposed) throw new ApiAgentRejectedError("not_open");
    if (conversation.running !== null) { conversation.queue.push(...texts); this.emitStatus(conversation); return; }
    if (this.options.conversationHolders(conversation.conversationId).length > 0) {
      conversation.lastError = "conversation_in_use";
      this.emitStatus(conversation);
      throw new ApiAgentRejectedError("conversation_in_use");
    }
    const transcript = (this.options.transcriptPath ?? defaultTranscriptPath)(conversation.cwd, conversation.conversationId);
    const baselineUsd = conversation.started ? readTranscriptCostBaseline(transcript) : 0;
    let worker: ApiAgentWorkerHandle;
    try {
      worker = this.options.spawnWorker(this.options.workerEnvironment(key.secretEnv));
    } catch {
      conversation.lastError = "worker_failed";
      this.emitStatus(conversation);
      throw new ApiAgentRejectedError("worker_failed");
    }
    const turnId = randomUUID();
    // 始める前に running で記録する（結果を受け取れなければ利用額未確認として残る）。
    conversation.ledger.turns.push({ id: turnId, startedAt: this.now(), status: "running" });
    this.saveLedger(conversation.ledger);
    const running: RunningTurn = {
      turnId, worker, baselineUsd, authOk: null, result: null, errorCode: null,
      interrupted: false, killTimer: null, questionIds: new Set(), abort: new AbortController(),
    };
    conversation.running = running;
    conversation.lastError = undefined;
    conversation.lastOutcome = undefined;
    worker.onMessage((message) => this.handleWorkerMessage(conversation, running, message));
    worker.onExit(() => this.finishTurn(conversation, running));
    const executable = this.options.claudeExecutable?.() ?? null;
    try {
      worker.send({
        t: "start", conversationId: conversation.conversationId, resume: conversation.started,
        cwd: conversation.cwd, prompt: texts.join("\n\n"), model: config.model,
        permissionMode: config.permissionMode, maxTurns: config.budget.maxTurns,
        maxBudgetUsd: Math.min(config.budget.turnUsd, remaining),
        settingSources: this.options.settingSources ?? ["user", "project", "local"],
        ...(executable !== null ? { claudeExecutable: executable } : {}),
      });
    } catch {
      try { worker.kill("SIGTERM"); } catch { /* 起動に失敗。 */ }
    }
    this.options.onProcessing?.(conversation.session, "active");
    this.emitStatus(conversation);
  }

  private handleWorkerMessage(conversation: Conversation, running: RunningTurn, message: WorkerToHub): void {
    if (conversation.running !== running) return;
    switch (message.t) {
      case "auth":
        running.authOk = message.ok;
        if (!message.ok) this.options.log?.(`api-agent 認証が想定外のため停止 session=${conversation.session} source=${message.apiKeySource ?? "none"}`);
        return;
      case "error":
        running.errorCode = message.code;
        return;
      case "result":
        running.result = message;
        return;
      case "permission_request":
        void this.handlePermission(conversation, running, message);
        return;
    }
  }

  private async handlePermission(
    conversation: Conversation, running: RunningTurn, request: Extract<WorkerToHub, { t: "permission_request" }>,
  ): Promise<void> {
    const respond = (behavior: "allow" | "deny", message?: string): void => {
      try {
        running.worker.send({ t: "permission_response", requestId: request.requestId, behavior, ...(message !== undefined ? { message } : {}) });
      } catch { /* 作業プロセスが終わった。 */ }
    };
    if (request.toolName === "AskUserQuestion") {
      const rawQuestions = Array.isArray(request.input["questions"]) ? request.input["questions"] as unknown[] : [];
      const questions = rawQuestions.map(toQuestion).filter((q): q is QuestionPromptQuestion => q !== null);
      if (this.options.onQuestion === undefined || questions.length === 0 || questions.length !== rawQuestions.length) {
        respond("deny", "この会話では選択式の質問に答えられません。質問せずに、分かる範囲で進めてください。");
        return;
      }
      const id = QUESTION_ID_PREFIX + request.requestId;
      this.pendingQuestions.set(id, { session: conversation.session, requestId: request.requestId, rawQuestions, questions, worker: running.worker });
      running.questionIds.add(id);
      this.options.onQuestion({ session: conversation.session, id, questions });
      return;
    }
    const described = (this.options.summarizeTool ?? defaultSummary)(request.toolName, request.input);
    let decision: Decision = "deny";
    try {
      decision = await this.options.approval({
        id: request.requestId, session: conversation.session, tool: request.toolName,
        summary: described.summary, cwd: conversation.cwd,
        ...(described.diff !== undefined ? { diff: described.diff } : {}),
        signal: running.abort.signal,
      });
    } catch {
      decision = "deny";
    }
    respond(decision, decision === "deny" ? "利用者が拒否しました。" : undefined);
  }

  private finishTurn(conversation: Conversation, running: RunningTurn): void {
    if (conversation.running !== running) return;
    if (running.killTimer !== null) clearTimeout(running.killTimer);
    running.abort.abort();
    conversation.running = null;
    for (const id of running.questionIds) {
      if (this.pendingQuestions.delete(id)) this.options.onQuestionDismiss?.(conversation.session, id);
    }
    const turn = conversation.ledger.turns.find((t) => t.id === running.turnId);
    const result = running.result;
    // モデルを呼んでいないことが確かな終わり方（認証が想定外・SDK 不在・開始の指示が不正）は台帳から外す。
    const noModelCall = result === null && (running.authOk === false || running.errorCode === "sdk_unavailable" ||
      running.errorCode === "invalid_start" || running.errorCode === "unexpected_auth");
    if (turn !== undefined) {
      turn.finishedAt = this.now();
      if (noModelCall) {
        conversation.ledger.turns = conversation.ledger.turns.filter((t) => t !== turn);
      } else if (result !== null && result.totalCostUsd !== null) {
        turn.status = "done";
        turn.costUsd = turnCostFromCumulative(result.totalCostUsd, running.baselineUsd);
        turn.subtype = result.subtype;
      } else {
        turn.status = "unconfirmed";
        if (result !== null) turn.subtype = result.subtype;
      }
      this.saveLedger(conversation.ledger);
    }
    // 2 ターン目以降を resume にするのは、SDK が会話の JSONL を書き始めた後だけ（新規の 1 ターン目が
    // モデルを呼ぶ前に失敗した会話を resume すると、会話が見つからず失敗する）。
    if (!conversation.started) {
      const transcript = (this.options.transcriptPath ?? defaultTranscriptPath)(conversation.cwd, conversation.conversationId);
      conversation.started = (this.options.transcriptExists ?? fs.existsSync)(transcript);
    }
    conversation.lastOutcome = outcomeOf(result, running);
    if (running.authOk === false || running.errorCode === "unexpected_auth") conversation.lastError = "unexpected_auth";
    else if (running.errorCode === "sdk_unavailable") conversation.lastError = "sdk_unavailable";
    else if (result === null && running.errorCode !== null) conversation.lastError = "worker_failed";
    if (conversation.disposed) return;
    this.options.onProcessing?.(conversation.session, "done");
    let restoredTexts: string[] | undefined;
    if (running.interrupted || conversation.lastError === "unexpected_auth" || conversation.lastError === "sdk_unavailable") {
      // 中断・止めるべき失敗の後は貯まっていた発話を送らずに返す（入力欄へ戻す）。
      if (conversation.queue.length > 0) restoredTexts = conversation.queue.splice(0);
    }
    this.emitStatus(conversation, restoredTexts);
    if (conversation.queue.length > 0) void this.drain(conversation);
  }

  private async drain(conversation: Conversation): Promise<void> {
    if (conversation.running !== null || conversation.disposed || conversation.queue.length === 0) return;
    const texts = conversation.queue.splice(0);
    try {
      await this.startTurn(conversation, texts);
    } catch (error) {
      // 始められなかった（予算到達など）。発話は捨てずに貯め直し、状態で知らせる（上限を上げれば続く）。
      if (!conversation.disposed && conversation.running === null) {
        conversation.queue.unshift(...texts);
        this.emitStatus(conversation);
      }
      this.options.log?.(`api-agent 持ち越しの発話を開始できず session=${conversation.session}: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  private statusOf(conversation: Conversation, restoredTexts?: string[]): ApiAgentStatusMessage {
    const state: ApiAgentState = conversation.running === null ? "idle" : conversation.running.interrupted ? "stopping" : "running";
    return {
      type: "api_agent_status", v: PROTOCOL_V2, session: conversation.session, state,
      model: conversation.config.model, budget: { ...conversation.config.budget },
      permissionMode: conversation.config.permissionMode,
      usage: summarizeLedger(conversation.ledger), queued: conversation.queue.length,
      ...(conversation.lastOutcome !== undefined ? { outcome: conversation.lastOutcome } : {}),
      ...(conversation.lastError !== undefined ? { error: conversation.lastError } : {}),
      ...(restoredTexts !== undefined && restoredTexts.length > 0 ? { restoredTexts } : {}),
    };
  }

  private emitStatus(conversation: Conversation, restoredTexts?: string[]): void {
    if (conversation.disposed) return;
    this.options.onStatus?.(conversation.session, this.statusOf(conversation, restoredTexts));
  }

  private persistSession(conversation: Conversation): void {
    try {
      this.sessionStore.put({
        name: conversation.session, conversationId: conversation.conversationId, cwd: conversation.cwd,
        config: conversation.config, openedAt: this.now(),
      });
    } catch (error) {
      this.options.log?.(`api-agent 会話の記録に失敗 session=${conversation.session}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }

  private saveLedger(ledger: ApiAgentLedger): void {
    try {
      this.ledgerStore.save(ledger);
    } catch (error) {
      this.options.log?.(`api-agent 台帳の保存に失敗: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }
}

function outcomeOf(result: Extract<WorkerToHub, { t: "result" }> | null, running: RunningTurn): ApiAgentTurnOutcome {
  if (result === null) return running.interrupted ? "interrupted" : running.errorCode !== null ? "failed" : "result_unknown";
  if (result.subtype === "success" && !result.isError) return "success";
  if (result.subtype === "error_max_budget_usd") return "turn_budget_reached";
  if (result.subtype === "error_max_turns") return "max_turns_reached";
  if (running.interrupted || result.subtype === "interrupted_before_start") return "interrupted";
  return "failed";
}

function toQuestion(raw: unknown): QuestionPromptQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["question"] !== "string" || !Array.isArray(obj["options"])) return null;
  const options = (obj["options"] as unknown[]).map((option) => {
    if (typeof option !== "object" || option === null) return null;
    const o = option as Record<string, unknown>;
    if (typeof o["label"] !== "string") return null;
    return {
      label: o["label"], description: typeof o["description"] === "string" ? o["description"] : "",
      ...(typeof o["preview"] === "string" ? { preview: o["preview"] } : {}),
    };
  });
  if (options.some((o) => o === null) || options.length === 0) return null;
  return {
    header: typeof obj["header"] === "string" ? obj["header"] : "",
    question: obj["question"],
    multiSelect: obj["multiSelect"] === true,
    options: options as QuestionPromptQuestion["options"],
  };
}

function defaultSummary(toolName: string): { summary: string; diff?: ToolDiff } {
  return { summary: `Run tool: ${toolName}` };
}

function defaultTranscriptPath(cwd: string, conversationId: string): string {
  return path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(cwd), `${conversationId}.jsonl`);
}
