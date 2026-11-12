// apiAgentWorker.test.ts — API 作業プロセス（Agent SDK を読む側）のテスト。SDK は偽物に差し替え、実 API は呼ばない。

import { describe, expect, test } from "vitest";
import { acceptableAgentAuth, runApiAgentWorker } from "../src/apiAgent/worker.js";
import type { AgentSdkModule, AgentSdkQuery } from "../src/apiAgent/sdkLoader.js";
import { decodeHubToWorker, decodeWorkerToHub, type HubToWorker, type WorkerToHub } from "../src/apiAgent/workerProtocol.js";
import { apiAgentChildEnvironment } from "../src/apiAgent/keyEnvironment.js";

const CONV = "7b2c6a3f-ba60-45fd-89ae-cba51afaf7dc";
const KEY = "sk-ant-api03-" + "x".repeat(40);

function start(overrides: Partial<Extract<HubToWorker, { t: "start" }>> = {}): string {
  return JSON.stringify({
    t: "start", conversationId: CONV, resume: false, cwd: "/tmp/work", prompt: "hello", model: "claude-haiku-5-5",
    permissionMode: "default", maxTurns: 3, maxBudgetUsd: 0.5, settingSources: ["project"], ...overrides,
  });
}

/** 行を後から足せる入力。 */
class Lines implements AsyncIterable<string> {
  private items: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(line: string): void { this.items.push(line); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

interface FakeScript {
  account: Record<string, unknown>;
  /** プロンプトを受け取ったら返すメッセージ。canUseTool を呼ぶ関数も書ける。 */
  onPrompt?: (prompt: string, canUseTool: (name: string, input: Record<string, unknown>) => Promise<unknown>) => AsyncGenerator<Record<string, unknown>>;
  throwAfterResult?: boolean;
}

function fakeSdk(script: FakeScript) {
  const seen: { options?: Record<string, unknown>; prompts: string[]; interrupted: number } = { prompts: [], interrupted: 0 };
  const sdk: AgentSdkModule = {
    query({ prompt, options }) {
      seen.options = options;
      const canUseTool = options["canUseTool"] as (name: string, input: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>;
      const controller = new AbortController();
      const q: AgentSdkQuery = {
        async initializationResult() { return { account: script.account, claude_code_version: "2.1.322" }; },
        async interrupt() { seen.interrupted += 1; controller.abort(); return undefined; },
        close() { /* noop */ },
        async *[Symbol.asyncIterator]() {
          for await (const message of prompt) {
            const text = String((message["message"] as Record<string, unknown>)["content"]);
            seen.prompts.push(text);
            if (script.onPrompt) {
              for await (const out of script.onPrompt(text, (name, input) => canUseTool(name, input, { signal: controller.signal }))) yield out;
            }
            if (script.throwAfterResult) throw new Error("Claude Code returned an error result: x");
          }
        },
      };
      return q;
    },
  };
  return { sdk, seen };
}

async function runWith(script: FakeScript, env: NodeJS.ProcessEnv, opts: { onWrite?: (m: WorkerToHub, lines: Lines) => void; startLine?: string } = {}) {
  const lines = new Lines();
  const out: WorkerToHub[] = [];
  const { sdk, seen } = fakeSdk(script);
  lines.push(opts.startLine ?? start());
  const code = await runApiAgentWorker({
    lines, env, loadSdk: async () => sdk, clientApp: "tailii-host/test",
    write: (message) => {
      // 往復の形でも読めること（実プロセスは NDJSON で書く）。
      expect(decodeWorkerToHub(JSON.stringify(message))).toEqual(message);
      out.push(message);
      opts.onWrite?.(message, lines);
    },
  });
  lines.close();
  return { code, out, seen };
}

describe("acceptableAgentAuth", () => {
  test("API キー（環境変数）・Anthropic 直結だけを通す", () => {
    expect(acceptableAgentAuth({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty", tokenSource: "claude.ai" })).toBe(true);
    // 実測: ログインのみは apiKeySource 欄が無く subscriptionType がある。
    expect(acceptableAgentAuth({ subscriptionType: "Claude Ultra", apiProvider: "firstParty" })).toBe(false);
    expect(acceptableAgentAuth({ apiKeySource: "apiKeyHelper", apiProvider: "firstParty" })).toBe(false);
    expect(acceptableAgentAuth({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "bedrock" })).toBe(false);
    expect(acceptableAgentAuth(undefined)).toBe(false);
  });
});

describe("runApiAgentWorker", () => {
  test("auto は SDK に同名で渡し、判断できない操作の canUseTool を残す", async () => {
    const { code, seen } = await runWith({
      account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
      async *onPrompt(_prompt, canUseTool) {
        expect(await canUseTool("Bash", { command: "test-command" })).toEqual({ behavior: "allow", updatedInput: { command: "test-command" } });
        yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, num_turns: 1, session_id: CONV };
      },
    }, { ANTHROPIC_API_KEY: KEY }, {
      startLine: start({ permissionMode: "auto", resume: true }),
      onWrite(message, lines) {
        if (message.t === "permission_request") lines.push(JSON.stringify({
          t: "permission_response", requestId: message.requestId, behavior: "allow",
        }));
      },
    });
    expect(code).toBe(0);
    expect(seen.options!["permissionMode"]).toBe("auto");
    expect(seen.options!["resume"]).toBe(CONV);
    expect(seen.options!["allowDangerouslySkipPermissions"]).toBeUndefined();
  });

  test("成功: 認証を確かめてからプロンプトを送り、結果をそのまま返す。新規は sessionId で会話 id を固定する", async () => {
    const { code, out, seen } = await runWith({
      account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
      async *onPrompt() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
        yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0019, num_turns: 1, session_id: CONV, terminal_reason: "completed" };
      },
    }, { ANTHROPIC_API_KEY: KEY, PATH: "/usr/bin", HOME: "/Users/x", CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret", ANTHROPIC_BASE_URL: "https://evil" });
    expect(code).toBe(0);
    expect(out).toEqual([
      { t: "auth", ok: true, apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty", cliVersion: "2.1.322" },
      { t: "result", subtype: "success", isError: false, totalCostUsd: 0.0019, numTurns: 1, sessionId: CONV, terminalReason: "completed" },
    ]);
    expect(seen.prompts).toEqual(["hello"]);
    const options = seen.options!;
    expect(options["sessionId"]).toBe(CONV);
    expect(options["resume"]).toBeUndefined();
    expect(options["model"]).toBe("claude-haiku-5-5");
    expect(options["maxBudgetUsd"]).toBe(0.5);
    expect(options["maxTurns"]).toBe(3);
    expect(options["permissionMode"]).toBe("default");
    expect(options["settingSources"]).toEqual(["project"]);
    expect(options["enableFileCheckpointing"]).toBe(true);
    // 子の env は選び直す: キーは渡し、親の Claude Code 用の変数・接続先の上書きは渡さない。
    const env = options["env"] as Record<string, string>;
    expect(env["ANTHROPIC_API_KEY"]).toBe(KEY);
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toBe("tailii-host/test");
    // 出力（hub への行）にキーは載らない。
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  test("再開は resume に会話 id を渡す", async () => {
    const { seen } = await runWith({
      account: { apiKeySource: "ANTHROPIC_API_KEY" },
      async *onPrompt() { yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0026 }; },
    }, { ANTHROPIC_API_KEY: KEY }, { startLine: start({ resume: true }) });
    expect(seen.options!["resume"]).toBe(CONV);
    expect(seen.options!["sessionId"]).toBeUndefined();
  });

  test("認証が想定外（サブスクのログイン）ならプロンプトを 1 つも送らずに終わる", async () => {
    const { code, out, seen } = await runWith({
      account: { subscriptionType: "Claude Ultra", apiProvider: "firstParty", email: "a@example.com" },
      async *onPrompt() { yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 1 }; },
    }, { ANTHROPIC_API_KEY: KEY });
    expect(code).toBe(3);
    expect(seen.prompts).toEqual([]);
    expect(out).toEqual([
      { t: "auth", ok: false, apiKeySource: null, apiProvider: "firstParty", cliVersion: "2.1.322" },
      { t: "error", code: "unexpected_auth" },
    ]);
    // アカウントのメールアドレス等は hub へ返さない。
    expect(JSON.stringify(out)).not.toContain("example.com");
  });

  test("キーが env に無ければ SDK を読まずに止める（ログインへ切り替えない）", async () => {
    let loaded = false;
    const lines = new Lines();
    lines.push(start());
    const out: WorkerToHub[] = [];
    const code = await runApiAgentWorker({ lines, env: {}, write: (m) => out.push(m), loadSdk: async () => { loaded = true; return null; } });
    expect(code).toBe(3);
    expect(loaded).toBe(false);
    expect(out.at(-1)).toEqual({ t: "error", code: "unexpected_auth" });
  });

  test("SDK が入っていなければ sdk_unavailable", async () => {
    const lines = new Lines();
    lines.push(start());
    const out: WorkerToHub[] = [];
    const code = await runApiAgentWorker({ lines, env: { ANTHROPIC_API_KEY: KEY }, write: (m) => out.push(m), loadSdk: async () => null });
    expect(code).toBe(4);
    expect(out).toEqual([{ t: "error", code: "sdk_unavailable" }]);
  });

  test("最初の行が start でなければ invalid_start", async () => {
    const lines = new Lines();
    lines.push(JSON.stringify({ t: "interrupt" }));
    const out: WorkerToHub[] = [];
    await runApiAgentWorker({ lines, env: { ANTHROPIC_API_KEY: KEY }, write: (m) => out.push(m), loadSdk: async () => null });
    expect(out).toEqual([{ t: "error", code: "invalid_start" }]);
  });

  test("canUseTool は hub へ問い合わせ、答え（allow / deny・updatedInput）を SDK へ返す", async () => {
    const decisions: unknown[] = [];
    const { out } = await runWith({
      account: { apiKeySource: "ANTHROPIC_API_KEY" },
      async *onPrompt(_prompt, canUseTool) {
        decisions.push(await canUseTool("Write", { file_path: "/tmp/a.txt", content: "hi" }));
        decisions.push(await canUseTool("AskUserQuestion", { questions: [{ question: "色は？" }] }));
        yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.001 };
      },
    }, { ANTHROPIC_API_KEY: KEY }, {
      onWrite: (message, lines) => {
        if (message.t !== "permission_request") return;
        if (message.toolName === "Write") lines.push(JSON.stringify({ t: "permission_response", requestId: message.requestId, behavior: "deny", message: "やめて" }));
        else lines.push(JSON.stringify({ t: "permission_response", requestId: message.requestId, behavior: "allow", updatedInput: { questions: [], answers: { "色は？": "青" } } }));
      },
    });
    expect(out.filter((m) => m.t === "permission_request").map((m) => (m as { toolName: string }).toolName)).toEqual(["Write", "AskUserQuestion"]);
    expect(decisions).toEqual([
      { behavior: "deny", message: "やめて" },
      { behavior: "allow", updatedInput: { questions: [], answers: { "色は？": "青" } } },
    ]);
  });

  test("中断の指示は query.interrupt() へ渡す。失敗の結果の後に SDK が投げる例外は失敗にしない（実測）", async () => {
    const { code, out, seen } = await runWith({
      account: { apiKeySource: "ANTHROPIC_API_KEY" },
      throwAfterResult: true,
      async *onPrompt() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0.0001276, terminal_reason: "aborted_streaming" };
      },
    }, { ANTHROPIC_API_KEY: KEY }, {
      onWrite: (message, lines) => { if (message.t === "auth") lines.push(JSON.stringify({ t: "interrupt" })); },
    });
    expect(code).toBe(0);
    expect(seen.interrupted).toBe(1);
    expect(out.at(-1)).toEqual({ t: "result", subtype: "error_during_execution", isError: true, totalCostUsd: 0.0001276, numTurns: null, sessionId: null, terminalReason: "aborted_streaming" });
    expect(out.some((m) => m.t === "error")).toBe(false);
  });
});

describe("workerProtocol", () => {
  test("start の検証: 会話 id・作業フォルダ・権限モード・予算の値域", () => {
    expect(decodeHubToWorker(start())).not.toBeNull();
    expect(decodeHubToWorker(start({ conversationId: "../etc" }))).toBeNull();
    expect(decodeHubToWorker(start({ cwd: "relative" }))).toBeNull();
    expect(decodeHubToWorker(start({ permissionMode: "bypassPermissions" as never }))).toBeNull();
    expect(decodeHubToWorker(start({ maxBudgetUsd: 0 }))).toBeNull();
    expect(decodeHubToWorker(start({ maxTurns: 0 }))).toBeNull();
    expect(decodeHubToWorker(start({ claudeExecutable: "claude" }))).toBeNull();
    expect(decodeHubToWorker("not json")).toBeNull();
  });

  test("作業プロセス → hub の不正な行は捨てる", () => {
    expect(decodeWorkerToHub(JSON.stringify({ t: "error", code: "whatever" }))).toBeNull();
    expect(decodeWorkerToHub(JSON.stringify({ t: "result", subtype: "success" }))).toBeNull();
    expect(decodeWorkerToHub(JSON.stringify({ t: "permission_request", requestId: "r", toolName: "Bash", input: [] }))).toBeNull();
  });

  test("子プロセスの env は許可した変数だけ", () => {
    const env = apiAgentChildEnvironment({ HOME: "/h", PATH: "/bin", ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: "t", NODE_OPTIONS: "--require x" });
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", ANTHROPIC_API_KEY: KEY });
  });
});
