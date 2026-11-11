// apiAgent/worker.ts
// API 作業プロセスの本体（1 プロセス = 1 ターン = 1 回の Agent SDK `query()`）。
//
// - API キーは自分の環境変数（ANTHROPIC_API_KEY）からだけ受け取り、SDK の子プロセスの env へ渡す。
//   引数・標準出力・ログへは出さない。
// - モデルを呼ぶ前に `initializationResult()` の認証元を確かめ、API キー以外（サブスクのログイン等）なら
//   プロンプトを送らずに終わる（実測 2026-11-11: キーありは apiKeySource="ANTHROPIC_API_KEY"、
//   ログインのみは apiKeySource 欄なし + subscriptionType あり）。
// - 承認・設問（canUseTool）は hub へ問い合わせ、答えが来るまで待つ。

import { randomUUID } from "node:crypto";
import { apiAgentChildEnvironment } from "./keyEnvironment.js";
import type { AgentSdkModule, AgentSdkQuery } from "./sdkLoader.js";
import {
  decodeHubToWorker,
  encodeWorkerLine,
  type WorkerPermissionResponse,
  type WorkerStartCommand,
  type WorkerToHub,
} from "./workerProtocol.js";

export interface ApiAgentWorkerIo {
  /** hub からの行（改行なし）。終わり = hub が居なくなった。 */
  lines: AsyncIterable<string>;
  write: (message: WorkerToHub) => void;
  env: NodeJS.ProcessEnv;
  loadSdk: () => Promise<AgentSdkModule | null>;
  /** User-Agent に載せる識別子（`tailii-host/<版>`）。 */
  clientApp?: string;
}

/** モデルを呼ぶ前の認証判定。API キー（環境変数）・Anthropic 直結だけを通す。 */
export function acceptableAgentAuth(account: Record<string, unknown> | undefined): boolean {
  if (account === undefined) return false;
  const provider = account["apiProvider"];
  return account["apiKeySource"] === "ANTHROPIC_API_KEY" && (provider === undefined || provider === "firstParty");
}

class InputQueue implements AsyncIterable<Record<string, unknown>> {
  private readonly items: Record<string, unknown>[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(text: string): void {
    this.items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
    this.wake?.();
  }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

export async function runApiAgentWorker(io: ApiAgentWorkerIo): Promise<number> {
  const iterator = io.lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  const start = first.done === true ? null : decodeHubToWorker(first.value);
  if (start === null || start.t !== "start") {
    io.write({ t: "error", code: "invalid_start" });
    return 2;
  }
  if (!io.env["ANTHROPIC_API_KEY"]) {
    // hub はキー無しで起動しない。念のためここでも止める（ログインへ切り替えない）。
    io.write({ t: "auth", ok: false, apiKeySource: null, apiProvider: null, cliVersion: null });
    io.write({ t: "error", code: "unexpected_auth" });
    return 3;
  }
  const sdk = await io.loadSdk();
  if (sdk === null) {
    io.write({ t: "error", code: "sdk_unavailable" });
    return 4;
  }
  return runTurn(sdk, start, iterator, io);
}

async function runTurn(
  sdk: AgentSdkModule,
  start: WorkerStartCommand,
  iterator: AsyncIterator<string>,
  io: ApiAgentWorkerIo,
): Promise<number> {
  const input = new InputQueue();
  const waiting = new Map<string, (response: WorkerPermissionResponse) => void>();
  let query: AgentSdkQuery;
  try {
    query = sdk.query({
      prompt: input,
      options: {
        cwd: start.cwd,
        model: start.model,
        permissionMode: start.permissionMode,
        maxTurns: start.maxTurns,
        maxBudgetUsd: start.maxBudgetUsd,
        settingSources: start.settingSources,
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        env: apiAgentChildEnvironment(io.env, io.clientApp),
        // ファイルの控えを残す（端末へ戻した後も /rewind でコードを巻き戻せる。既定では SDK のターンが
        // 「No code restore」になる。実測 2026-11-11）。
        enableFileCheckpointing: true,
        ...(start.resume ? { resume: start.conversationId } : { sessionId: start.conversationId }),
        ...(start.claudeExecutable !== undefined ? { pathToClaudeCodeExecutable: start.claudeExecutable } : {}),
        // SDK の子プロセスの標準エラーは捨てる（環境由来の情報を hub のログへ持ち込まない）。
        stderr: () => undefined,
        canUseTool: (toolName: string, toolInput: Record<string, unknown>, options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            const requestId = randomUUID();
            const onAbort = (): void => {
              waiting.delete(requestId);
              resolve({ behavior: "deny", message: "中止されました。" });
            };
            if (options.signal.aborted) { onAbort(); return; }
            options.signal.addEventListener("abort", onAbort, { once: true });
            waiting.set(requestId, (response) => {
              options.signal.removeEventListener("abort", onAbort);
              waiting.delete(requestId);
              resolve(response.behavior === "allow"
                ? { behavior: "allow", updatedInput: response.updatedInput ?? toolInput }
                : { behavior: "deny", message: response.message ?? "利用者が拒否しました。" });
            });
            io.write({ t: "permission_request", requestId, toolName, input: toolInput });
          }),
      },
    });
  } catch {
    io.write({ t: "error", code: "query_failed" });
    return 5;
  }

  let interrupted = false;
  // hub からの後続の指示（承認の答え・中断）。hub が居なくなったら中断する。
  const control = (async () => {
    while (true) {
      const next = await iterator.next();
      if (next.done === true) break;
      const command = decodeHubToWorker(next.value);
      if (command === null) continue;
      if (command.t === "permission_response") waiting.get(command.requestId)?.(command);
      else if (command.t === "interrupt" && !interrupted) {
        interrupted = true;
        query.interrupt().catch(() => undefined);
      }
    }
    if (!interrupted) {
      interrupted = true;
      query.interrupt().catch(() => undefined);
      input.close();
    }
  })();
  void control;

  let init: Awaited<ReturnType<AgentSdkQuery["initializationResult"]>>;
  try {
    init = await query.initializationResult();
  } catch {
    io.write({ t: "error", code: "query_failed" });
    input.close();
    query.close?.();
    return 5;
  }
  const account = init.account;
  const ok = acceptableAgentAuth(account);
  io.write({
    t: "auth", ok,
    apiKeySource: typeof account?.["apiKeySource"] === "string" ? account["apiKeySource"] as string : null,
    apiProvider: typeof account?.["apiProvider"] === "string" ? account["apiProvider"] as string : null,
    cliVersion: typeof init.claude_code_version === "string" ? init.claude_code_version : null,
  });
  if (!ok) {
    // プロンプトは 1 つも送っていない（モデルは呼ばれない）。
    io.write({ t: "error", code: "unexpected_auth" });
    input.close();
    query.close?.();
    return 3;
  }
  if (interrupted) {
    input.close();
    query.close?.();
    io.write({ t: "result", subtype: "interrupted_before_start", isError: true, totalCostUsd: null, numTurns: 0, sessionId: null, terminalReason: "aborted_before_prompt" });
    return 0;
  }

  input.push(start.prompt);
  let sawResult = false;
  try {
    for await (const message of query) {
      if (message["type"] !== "result") continue;
      sawResult = true;
      io.write({
        t: "result",
        subtype: typeof message["subtype"] === "string" ? message["subtype"] : "unknown",
        isError: message["is_error"] === true,
        totalCostUsd: typeof message["total_cost_usd"] === "number" && Number.isFinite(message["total_cost_usd"])
          ? message["total_cost_usd"] : null,
        numTurns: typeof message["num_turns"] === "number" ? message["num_turns"] : null,
        sessionId: typeof message["session_id"] === "string" ? message["session_id"] : null,
        terminalReason: typeof message["terminal_reason"] === "string" ? message["terminal_reason"] : null,
      });
      // 1 ターンで終える（結果の後に来る提案などは待たない）。
      input.close();
    }
  } catch {
    // 失敗の結果（中断・予算到達）の後、SDK は「error result を返した」として例外を投げる（実測）。
    // 結果を受け取れていればそれが正。受け取れていなければ失敗として返す。
    if (!sawResult) io.write({ t: "error", code: "query_failed" });
  } finally {
    for (const resolve of waiting.values()) resolve({ t: "permission_response", requestId: "", behavior: "deny", message: "ターンが終わりました。" });
    input.close();
    query.close?.();
  }
  return sawResult ? 0 : 5;
}

/** stdin を行単位で読む（作業プロセスの実体用）。 */
export async function* readLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

export function writeWorkerMessage(stream: NodeJS.WritableStream, message: WorkerToHub): void {
  stream.write(encodeWorkerLine(message));
}
