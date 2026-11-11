// apiAgentManager.test.ts — API 作業の hub 側の制御（ターン・持ち越し・中断・予算・利用額・承認・設問・排他）。
// 作業プロセスは偽物（実 API・実 SDK は使わない）。

import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiAgentManager, type ApiAgentStatusMessage, type ApiAgentWorkerHandle } from "../src/apiAgent/manager.js";
import { ApiAgentLedgerStore } from "../src/apiAgent/ledger.js";
import { ApiAgentSessionStore } from "../src/apiAgent/sessionState.js";
import { ApiAgentRejectedError } from "../src/apiAgent/config.js";
import type { HubToWorker, WorkerToHub } from "../src/apiAgent/workerProtocol.js";
import type { ApiAgentConfig, QuestionPromptQuestion } from "../src/protocol.js";
import { makeTempDir } from "./helpers.js";

const CONV = "7b2c6a3f-ba60-45fd-89ae-cba51afaf7dc";
const KEY = "sk-ant-api03-" + "x".repeat(40);
const CONFIG: ApiAgentConfig = { model: "claude-haiku-5-5", permissionMode: "default", budget: { turnUsd: 0.5, conversationUsd: 1, maxTurns: 10 } };

class FakeWorker implements ApiAgentWorkerHandle {
  pid = 4242;
  sent: HubToWorker[] = [];
  killed: string[] = [];
  private messageListeners: ((m: WorkerToHub) => void)[] = [];
  private exitListeners: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv) {}
  send(message: HubToWorker): void { this.sent.push(message); }
  onMessage(listener: (m: WorkerToHub) => void): void { this.messageListeners.push(listener); }
  onExit(listener: (c: number | null) => void): void { this.exitListeners.push(listener); }
  kill(signal = "SIGTERM"): void { this.killed.push(signal); }
  emit(message: WorkerToHub): void { for (const l of this.messageListeners) l(message); }
  exit(code: number | null = 0): void { for (const l of this.exitListeners) l(code); }
  get start() { return this.sent.find((m) => m.t === "start") as Extract<HubToWorker, { t: "start" }>; }
  succeed(totalCostUsd: number | null, subtype = "success"): void {
    this.emit({ t: "auth", ok: true, apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty", cliVersion: "2.1.322" });
    this.emit({ t: "result", subtype, isError: subtype !== "success", totalCostUsd, numTurns: 1, sessionId: CONV, terminalReason: "completed" });
    this.exit(0);
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof ApiAgentManager>[0]> = {}) {
  const dir = makeTempDir("api-agent-manager");
  const transcriptDir = path.join(dir, "projects");
  fs.mkdirSync(transcriptDir);
  const workers: FakeWorker[] = [];
  const statuses: ApiAgentStatusMessage[] = [];
  const processing: string[] = [];
  const questions: { session: string; id: string; questions: QuestionPromptQuestion[] }[] = [];
  const dismissed: string[] = [];
  const approvals: unknown[] = [];
  let holders: { pid: number; name: string }[] = [];
  let key: string | null = KEY;
  const ledgerStore = new ApiAgentLedgerStore(path.join(dir, "ledger"));
  const sessionStore = new ApiAgentSessionStore(path.join(dir, "sessions"));
  const manager = new ApiAgentManager({
    spawnWorker: (env) => { const w = new FakeWorker(env); workers.push(w); return w; },
    resolveKey: async () => key === null ? "no_api_key" : { secretEnv: { ANTHROPIC_API_KEY: key } },
    workerEnvironment: (secretEnv) => ({ HOME: "/h", ...secretEnv }),
    conversationHolders: () => holders,
    approval: async (request) => { approvals.push(request); return "allow"; },
    summarizeTool: (toolName, input) => ({ summary: `${toolName}:${String(input["file_path"] ?? "")}` }),
    onProcessing: (session, state) => processing.push(`${session}:${state}`),
    onStatus: (_session, status) => statuses.push(status),
    onQuestion: (event) => questions.push(event),
    onQuestionDismiss: (_session, id) => dismissed.push(id),
    ledgerStore, sessionStore,
    transcriptPath: (_cwd, id) => path.join(transcriptDir, `${id}.jsonl`),
    interruptGraceMs: 50,
    ...overrides,
  });
  return {
    manager, workers, statuses, processing, questions, dismissed, approvals, ledgerStore, sessionStore, transcriptDir,
    setHolders: (h: typeof holders) => { holders = h; },
    setKey: (k: string | null) => { key = k; },
    writeTranscript: (cost: number) => fs.writeFileSync(path.join(transcriptDir, `${CONV}.jsonl`),
      JSON.stringify({ type: "cost-state", totalCostUSD: cost }) + "\n"),
    last: () => statuses.at(-1)!,
  };
}

describe("ApiAgentManager", () => {
  test("新規の会話: 1 ターン目は sessionId で始め、結果の額を台帳へ。2 ターン目は resume", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: false });
    expect(await t.manager.submit("cs-a", "hello")).toBe("started");
    const first = t.workers[0]!;
    expect(first.env["ANTHROPIC_API_KEY"]).toBe(KEY);
    expect(first.start).toMatchObject({ conversationId: CONV, resume: false, prompt: "hello", model: "claude-haiku-5-5", maxBudgetUsd: 0.5, maxTurns: 10, permissionMode: "default" });
    expect(t.processing).toEqual(["cs-a:active"]);
    expect(t.last()).toMatchObject({ state: "running", queued: 0 });
    t.writeTranscript(0.0019);
    first.succeed(0.0019);
    expect(t.processing).toEqual(["cs-a:active", "cs-a:done"]);
    expect(t.last()).toMatchObject({ state: "idle", outcome: "success", usage: { totalUsd: 0.0019, turns: 1, unconfirmedTurns: 0, lastTurnUsd: 0.0019 } });

    await t.manager.submit("cs-a", "next");
    const second = t.workers[1]!;
    expect(second.start).toMatchObject({ resume: true });
    // 結果の累計（再開は以前の分を含む）− 基準（JSONL の cost-state）= このターンの額。
    second.succeed(0.0026);
    expect(t.last().usage).toEqual({ totalUsd: 0.0026, turns: 2, unconfirmedTurns: 0, lastTurnUsd: 0.0007 });
    // 状態にもログにもキーは載らない。
    expect(JSON.stringify(t.statuses)).not.toContain(KEY);
    expect(fs.readFileSync(path.join(t.ledgerStore.directory, `${CONV}.json`), "utf8")).not.toContain(KEY);
  });

  test("処理中の発話は次のターンへまとめて持ち越す", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "one");
    expect(await t.manager.submit("cs-a", "two")).toBe("queued");
    expect(await t.manager.submit("cs-a", "three")).toBe("queued");
    expect(t.last()).toMatchObject({ state: "running", queued: 2 });
    t.workers[0]!.succeed(0.01);
    await vi.waitFor(() => expect(t.workers).toHaveLength(2));
    expect(t.workers[1]!.start.prompt).toBe("two\n\nthree");
    expect(t.last()).toMatchObject({ state: "running", queued: 0 });
  });

  test("中断: interrupt を送り、終わらなければ強制終了。貯まっていた発話は送らずに返す", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "long");
    await t.manager.submit("cs-a", "later");
    expect(t.manager.interrupt("cs-a")).toBe(true);
    const worker = t.workers[0]!;
    expect(worker.sent.at(-1)).toEqual({ t: "interrupt" });
    expect(t.last().state).toBe("stopping");
    await vi.waitFor(() => expect(worker.killed).toEqual(["SIGTERM"]));
    worker.emit({ t: "result", subtype: "error_during_execution", isError: true, totalCostUsd: 0.0001, numTurns: 2, sessionId: CONV, terminalReason: "aborted_streaming" });
    worker.exit(null);
    expect(t.last()).toMatchObject({ state: "idle", outcome: "interrupted", queued: 0, restoredTexts: ["later"], usage: { totalUsd: 0.0001 } });
    expect(t.workers).toHaveLength(1);
    expect(t.manager.interrupt("cs-a")).toBe(false);
  });

  test("結果を受け取れずに終わったターンは利用額未確認（合計に足さない）", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "x");
    t.workers[0]!.emit({ t: "auth", ok: true, apiKeySource: "ANTHROPIC_API_KEY", apiProvider: null, cliVersion: null });
    t.workers[0]!.exit(1);
    expect(t.last()).toMatchObject({ outcome: "result_unknown", usage: { totalUsd: 0, turns: 1, unconfirmedTurns: 1 } });
  });

  test("認証が想定外ならモデルを呼んでいないので台帳に残さず、unexpected_auth で止める", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "x");
    await t.manager.submit("cs-a", "queued");
    t.workers[0]!.emit({ t: "auth", ok: false, apiKeySource: null, apiProvider: "firstParty", cliVersion: null });
    t.workers[0]!.emit({ t: "error", code: "unexpected_auth" });
    t.workers[0]!.exit(3);
    expect(t.last()).toMatchObject({ error: "unexpected_auth", usage: { turns: 0, unconfirmedTurns: 0 }, restoredTexts: ["queued"] });
    expect(t.workers).toHaveLength(1);
  });

  test("キーが無ければ作業プロセスを起動せずに断る（no_api_key）", async () => {
    const t = setup();
    t.setKey(null);
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: false });
    await expect(t.manager.submit("cs-a", "x")).rejects.toMatchObject({ code: "no_api_key" });
    expect(t.workers).toHaveLength(0);
    expect(t.last().error).toBe("no_api_key");
  });

  test("ターン前の確認（SDK 未導入・版のずれ）で止める。作業プロセスもキーも使わない", async () => {
    const t = setup({ preflight: () => "sdk_version_mismatch" });
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: false });
    await expect(t.manager.submit("cs-a", "x")).rejects.toMatchObject({ code: "sdk_version_mismatch" });
    expect(t.workers).toHaveLength(0);
    expect(t.last().error).toBe("sdk_version_mismatch");
  });

  test("開いている会話の開き直しでは設定を上書きしない（変更は configure だけ）", () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: false });
    t.manager.configure("cs-a", { ...CONFIG, budget: { ...CONFIG.budget, conversationUsd: 9 } });
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    expect(t.last().budget.conversationUsd).toBe(9);
  });

  test("予算: 1 ターンの上限は min(1 ターン上限, 残り)。累計が上限に達したら始めない。上限を上げると持ち越しを続ける", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "a");
    t.workers[0]!.succeed(0.8);
    t.writeTranscript(0.8);
    await t.manager.submit("cs-a", "b");
    expect(t.workers[1]!.start.maxBudgetUsd).toBeCloseTo(0.2, 6);
    // SDK の上限はモデル呼び出しの後で判定するので、直後の 1 回分は超えうる（実測）。
    t.workers[1]!.succeed(1.05, "error_max_budget_usd");
    expect(t.last()).toMatchObject({ outcome: "turn_budget_reached", usage: { totalUsd: 1.05 } });
    await expect(t.manager.submit("cs-a", "c")).rejects.toBeInstanceOf(ApiAgentRejectedError);
    expect(t.last().error).toBe("budget_exhausted");
    expect(t.workers).toHaveLength(2);
    t.manager.configure("cs-a", { ...CONFIG, budget: { ...CONFIG.budget, conversationUsd: 3 } });
    expect(t.last().error).toBeUndefined();
  });

  test("同じ会話を端末側・Tailii 外で開いていれば断る（conversation_in_use）。別名で同じ会話 id も断る", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    expect(() => t.manager.open("cs-b", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true })).toThrow(ApiAgentRejectedError);
    t.setHolders([{ pid: 1, name: "code0630" }]);
    await expect(t.manager.submit("cs-a", "x")).rejects.toMatchObject({ code: "conversation_in_use" });
    expect(t.workers).toHaveLength(0);
  });

  test("承認: Write は既存の承認カードへ（要約付き）。答えを作業プロセスへ返す", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "x");
    const worker = t.workers[0]!;
    worker.emit({ t: "permission_request", requestId: "r1", toolName: "Write", input: { file_path: "/tmp/w/a.txt", content: "hi" } });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toEqual({ t: "permission_response", requestId: "r1", behavior: "allow" }));
    expect(t.approvals).toEqual([expect.objectContaining({ id: "r1", session: "cs-a", tool: "Write", summary: "Write:/tmp/w/a.txt", cwd: "/tmp/w" })]);
    // ターンが終わったら承認待ちを中止する（保留中の承認が残らない）。
    const signal = (t.approvals[0] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    worker.succeed(0.01);
    expect(signal.aborted).toBe(true);
  });

  test("設問: AskUserQuestion を設問カードへ写し、回答を { questions, answers } で返す。ターンが終われば片付ける", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "x");
    const worker = t.workers[0]!;
    const raw = [{ question: "色は？", header: "Color", options: [{ label: "赤", description: "a" }, { label: "青", description: "b" }], multiSelect: true }];
    worker.emit({ t: "permission_request", requestId: "q1", toolName: "AskUserQuestion", input: { questions: raw } });
    await vi.waitFor(() => expect(t.questions).toHaveLength(1));
    const event = t.questions[0]!;
    expect(event.questions).toEqual([{ header: "Color", question: "色は？", multiSelect: true, options: [{ label: "赤", description: "a" }, { label: "青", description: "b" }] }]);
    expect(t.manager.answerQuestion(event.id, [{ questionIndex: 0, selectedOptionIndexes: [0, 1], otherText: "緑", multiSelect: true }])).toBe(true);
    expect(worker.sent.at(-1)).toEqual({ t: "permission_response", requestId: "q1", behavior: "allow", updatedInput: { questions: raw, answers: { "色は？": "赤, 青, 緑" } } });
    expect(t.manager.answerQuestion(event.id, [])).toBe(false);

    worker.emit({ t: "permission_request", requestId: "q2", toolName: "AskUserQuestion", input: { questions: raw } });
    await vi.waitFor(() => expect(t.questions).toHaveLength(2));
    worker.succeed(0.01);
    expect(t.dismissed).toEqual([t.questions[1]!.id]);
  });

  test("設問カードが無い構成では AskUserQuestion を断る", async () => {
    const t = setup({ onQuestion: undefined });
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "x");
    t.workers[0]!.emit({ t: "permission_request", requestId: "q1", toolName: "AskUserQuestion", input: { questions: [{ question: "?", options: [{ label: "a" }] }] } });
    await vi.waitFor(() => expect(t.workers[0]!.sent.at(-1)).toMatchObject({ t: "permission_response", requestId: "q1", behavior: "deny" }));
  });

  test("終了: 作業プロセスを止め、開いている記録を消す（台帳は残す）。再起動後は記録から待機状態で戻す", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: true });
    t.manager.open("cs-b", { conversationId: "11111111-2222-4333-8444-555555555555", cwd: "/tmp/w", config: CONFIG, resume: true });
    await t.manager.submit("cs-a", "x");
    t.manager.dispose("cs-a");
    expect(t.workers[0]!.killed).toEqual(["SIGTERM"]);
    expect(t.sessionStore.get("cs-a")).toBeNull();
    expect(t.manager.has("cs-a")).toBe(false);
    await expect(t.manager.submit("cs-a", "y")).rejects.toMatchObject({ code: "not_open" });

    // hub の再起動: 前回 running のまま残ったターンは利用額未確認へ。
    await t.manager.submit("cs-b", "z");
    const restarted = setup();
    const again = new ApiAgentManager({
      ...({} as never),
      spawnWorker: () => { throw new Error("unused"); },
      resolveKey: async () => "no_api_key",
      workerEnvironment: () => ({}),
      conversationHolders: () => [],
      approval: async () => "deny",
      ledgerStore: t.ledgerStore, sessionStore: t.sessionStore,
      onStatus: (_s, status) => restarted.statuses.push(status),
    });
    expect(again.restore()).toEqual(["cs-b"]);
    expect(again.status("cs-b")).toMatchObject({ state: "idle", usage: { turns: 1, unconfirmedTurns: 1 } });
  });

  test("新規の会話で 1 ターン目が JSONL を書く前に失敗したら、次も resume にしない", async () => {
    const t = setup();
    t.manager.open("cs-a", { conversationId: CONV, cwd: "/tmp/w", config: CONFIG, resume: false });
    await t.manager.submit("cs-a", "x");
    t.workers[0]!.emit({ t: "error", code: "query_failed" });
    t.workers[0]!.exit(5);
    await t.manager.submit("cs-a", "y");
    expect(t.workers[1]!.start.resume).toBe(false);
  });
});
