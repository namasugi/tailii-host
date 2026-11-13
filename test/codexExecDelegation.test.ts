// codexExecDelegation.test.ts — Claude の Bash から `codex exec` で呼ばれた Codex の見せ方（codex-exec-delegation）。
// 正本は docs/codex-exec-delegation.md。golden は protocol/codex-exec-delegation-v1.ndjson（root の protocol/ と byte 一致）。

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  candidateWorkDirs,
  CodexExecLinker,
  CodexExecLinkStore,
  ExecRolloutIndex,
  invokesCodex,
  isCodexExecCommand,
  matchByRules,
  parsePsOutput,
  pickOriginBash,
  requestLabel,
  type BashCall,
  type CodexExecLink,
} from "../src/chat/codexExecLinker.js";
import { SubagentTailer, type ProcessProbeExec } from "../src/chat/subagentTailer.js";
import { parseCodexExecTranscript, readCodexExecTranscript } from "../src/chat/subagentTranscript.js";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { decodeControlMessage, encodeControlMessage, type ControlMessage, type SubagentNode } from "../src/protocol.js";
import { makeTempDir } from "./helpers.js";
import { periodicWorkLimiter } from "../src/shared/loadShed.js";

const hostRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// MARK: - フィクスチャ

/** ローカル時刻で `rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl` の名前と日付フォルダを作る。 */
function rolloutLocation(sessionsRoot: string, startMs: number, id: string): string {
  const d = new Date(startMs);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const dir = path.join(sessionsRoot, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const name = `rollout-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${id}.jsonl`;
  return path.join(dir, name);
}

interface RolloutSpec {
  id: string;
  cwd: string;
  startMs: number;
  source?: unknown;
  request?: string | null;
  /** 旧形式（event_msg/user_message）で依頼文を書く。 */
  legacyUserMessage?: boolean;
  terminal?: "complete" | "aborted" | null;
  model?: string;
  effort?: string;
  compressed?: boolean;
  /** 依頼文の後、終わりの行の前に足す行。 */
  body?: Record<string, unknown>[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rolloutLines(spec: RolloutSpec): Record<string, unknown>[] {
  const t = spec.startMs;
  const lines: Record<string, unknown>[] = [
    {
      timestamp: iso(t + 900), type: "session_meta",
      payload: { id: spec.id, timestamp: iso(t), cwd: spec.cwd, originator: "codex_exec", cli_version: "0.167.0", source: spec.source ?? "exec" },
    },
    { timestamp: iso(t + 901), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: iso(t + 1000), type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] } },
    { timestamp: iso(t + 1001), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }] } },
    {
      timestamp: iso(t + 1002), type: "turn_context",
      payload: { cwd: spec.cwd, model: spec.model ?? "gpt-6.1-sol", effort: spec.effort ?? "xhigh" },
    },
  ];
  if (spec.request !== null) {
    const request = spec.request ?? "羽根を描いて";
    lines.push({ timestamp: iso(t + 1010), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: request }] } });
    lines.push(spec.legacyUserMessage === true
      ? { timestamp: iso(t + 1011), type: "event_msg", payload: { type: "user_message", message: request } }
      : {
        timestamp: iso(t + 1011), type: "event_msg",
        payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: request }] } },
      });
  }
  lines.push(...(spec.body ?? []));
  if (spec.terminal === "complete") {
    lines.push({ timestamp: iso(t + 60_000), type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } });
  } else if (spec.terminal === "aborted") {
    lines.push({ timestamp: iso(t + 60_000), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } });
  }
  return lines;
}

function writeRollout(codexHome: string, spec: RolloutSpec): string {
  const file = rolloutLocation(path.join(codexHome, "sessions"), spec.startMs, spec.id);
  const text = rolloutLines({ terminal: "complete", ...spec }).map((line) => JSON.stringify(line)).join("\n") + "\n";
  if (spec.compressed === true) {
    fs.writeFileSync(`${file}.zst`, zlib.zstdCompressSync(Buffer.from(text)));
    return `${file}.zst`;
  }
  fs.writeFileSync(file, text);
  return file;
}

const assistantText = (t: number, text: string): Record<string, unknown> => ({
  timestamp: iso(t), type: "response_item",
  payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] },
});
const execCall = (t: number, callId: string, cmd: string): Record<string, unknown> => ({
  timestamp: iso(t), type: "response_item",
  payload: { type: "custom_tool_call", call_id: callId, name: "exec", input: `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}}); text(r.output);` },
});
const execOutput = (t: number, callId: string, text: string): Record<string, unknown> => ({
  timestamp: iso(t), type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text }] },
});

/** Claude の記録の Bash（tool_use + tool_result）。 */
function bashLines(spec: {
  id: string; command: string; cwd: string; startMs: number; endMs?: number | null; background?: boolean; agentId?: string;
}): Record<string, unknown>[] {
  const base = spec.agentId === undefined ? {} : { agentId: spec.agentId, isSidechain: true };
  const lines: Record<string, unknown>[] = [{
    ...base,
    cwd: spec.cwd,
    timestamp: iso(spec.startMs),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: spec.id, name: "Bash", input: { command: spec.command, ...(spec.background === true ? { run_in_background: true } : {}) } }],
    },
  }];
  if (spec.endMs !== null && spec.endMs !== undefined) {
    lines.push({
      ...base,
      cwd: spec.cwd,
      timestamp: iso(spec.endMs),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: spec.id, content: "ok" }] },
    });
  }
  return lines;
}

/** 偽の ps / pgrep / lsof。表に無いコマンドは「判定不能」（exit 99）。 */
function fakeExec(table: {
  pgrep?: (args: string[]) => string | null;
  ps?: () => string | null;
  /** undefined を返すと「判定不能」。 */
  lsof?: (args: string[]) => string | null | undefined;
}): { exec: ProcessProbeExec; calls: string[] } {
  const calls: string[] = [];
  const exec: ProcessProbeExec = (cmd, args, callback) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const lsof = table.lsof;
    const pgrep = table.pgrep;
    const handler = cmd === "pgrep" ? (pgrep === undefined ? undefined : (): string | null => pgrep(args)) : cmd === "ps" ? table.ps
      : cmd === "lsof" && lsof !== undefined ? (): string | null | undefined => lsof(args) : undefined;
    const out = handler === undefined ? undefined : handler();
    if (out === undefined) {
      callback(Object.assign(new Error("unavailable"), { code: 99 }), "");
    } else if (out === null) {
      callback(Object.assign(new Error("no match"), { code: 1 }), "");
    } else {
      callback(null, out);
    }
  };
  return { exec, calls };
}

/** ps の 1 行（lstart はローカル時刻）。 */
function psRow(pid: number, ppid: number, pgid: number, startMs: number, command: string): string {
  const d = new Date(startMs);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const lstart = `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
  return `${String(pid).padStart(5, " ")} ${String(ppid).padStart(5, " ")} ${String(pgid).padStart(5, " ")} ${lstart}     ${command}`;
}

async function collectNodes(tailer: SubagentTailer, main: string): Promise<SubagentNode[]> {
  const nodes: SubagentNode[] = [];
  for await (const message of tailer.streamSession(main)) {
    if (message.type === "subagent_node" && message.node.kind === "codex_exec") nodes.push(message.node);
  }
  return nodes;
}

const T0 = Date.parse("2026-11-10T10:00:00.000Z");

// MARK: - 対象の Bash

describe("invokesCodex（対象の Bash）", () => {
  test("引用符の外の単語 codex を対象にする", () => {
    expect(invokesCodex("codex exec --skip-git-repo-check - < p.txt > log 2>&1")).toBe(true);
    expect(invokesCodex("for f in a b; do codex exec - < $f.prompt.txt > $f.log 2>&1 & done; wait")).toBe(true);
    expect(invokesCodex("cd /x && /opt/homebrew/bin/codex exec \"hi\"")).toBe(true);
    expect(invokesCodex("OUT=$(codex exec -)")).toBe(true);
    expect(invokesCodex("nohup codex exec - < p.txt &")).toBe(true);
  });

  test("引用符の中にしか codex が無い監視・検索のコマンドは対象外", () => {
    expect(invokesCodex("pgrep -f \"codex exec\" | wc -l")).toBe(false);
    expect(invokesCodex("ps aux | grep 'codex exec'")).toBe(false);
    expect(invokesCodex("until ! pgrep -f \"codex exec\" >/dev/null; do sleep 10; done")).toBe(false);
    expect(invokesCodex("echo done # codex exec")).toBe(false);
    expect(invokesCodex("ls ~/.codex/sessions")).toBe(false);
    expect(invokesCodex("node codex-companion.mjs status")).toBe(false);
  });

  test("引数として codex を取るだけの監視コマンド・ヒアドキュメントの本文は対象外", () => {
    expect(invokesCodex("pgrep -fl codex")).toBe(false);
    expect(invokesCodex("which codex")).toBe(false);
    expect(invokesCodex("cat > run.sh <<'EOF'\ncodex exec - < p.txt\nEOF\nchmod +x run.sh")).toBe(false);
  });
});

describe("candidateWorkDirs（作業フォルダの候補）", () => {
  test("行の cwd・cd（絶対 / ~ / 相対）・-C / --cd を候補にし、変数の cd 以降は不明", () => {
    const home = makeTempDir("cx-home");
    const repo = path.join(home, "repo");
    fs.mkdirSync(path.join(repo, "tools"), { recursive: true });
    const real = (p: string): string => fs.realpathSync(p);
    expect(candidateWorkDirs("codex exec -", repo, home)).toEqual([real(repo)]);
    expect(candidateWorkDirs("cd ~/repo/tools && codex exec -", "/", home)).toContain(real(path.join(repo, "tools")));
    expect(candidateWorkDirs("cd tools && codex exec -", repo, home)).toContain(real(path.join(repo, "tools")));
    expect(candidateWorkDirs("codex exec -C ~/repo/tools -", "/", home)).toContain(real(path.join(repo, "tools")));
    expect(candidateWorkDirs("codex exec --cd=tools -", repo, home)).toContain(real(path.join(repo, "tools")));
    expect(candidateWorkDirs("cd \"$REPO\" && codex exec -C tools -", repo, home)).toEqual([real(repo)]);
  });

  test("symlink は解決して比べる", () => {
    const home = makeTempDir("cx-home-link");
    const target = path.join(home, "real-repo");
    fs.mkdirSync(target);
    const link = path.join(home, "link-repo");
    fs.symlinkSync(target, link);
    expect(candidateWorkDirs("codex exec -", link, home)).toEqual([fs.realpathSync(target)]);
  });
});

// MARK: - 記録だけの規則

describe("matchByRules（記録だけの規則）", () => {
  function setup(): { home: string; codexHome: string; repo: string; index: ExecRolloutIndex } {
    const home = makeTempDir("cx-rules");
    const codexHome = path.join(home, ".codex");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo, { recursive: true });
    return { home, codexHome, repo, index: new ExecRolloutIndex(codexHome, home) };
  }
  const call = (overrides: Partial<BashCall> & Pick<BashCall, "toolUseId">): BashCall => ({
    owner: "root", command: "codex exec - < p.txt", cwd: null, startMs: T0, endMs: T0 + 5_000, ...overrides,
  });

  test("時間の範囲は tool_use の時刻 〜 終わり + 10 秒（境界を含む）", () => {
    const { home, codexHome, repo, index } = setup();
    writeRollout(codexHome, { id: "r-at-start", cwd: repo, startMs: T0 });
    writeRollout(codexHome, { id: "r-before", cwd: repo, startMs: T0 - 1 });
    writeRollout(codexHome, { id: "r-at-tail", cwd: repo, startMs: T0 + 15_000 });
    writeRollout(codexHome, { id: "r-after", cwd: repo, startMs: T0 + 15_001 });
    const matches = matchByRules([call({ toolUseId: "b1", cwd: repo })], index, { nowMs: T0 + 3_600_000, home });
    expect(matches.map((m) => m.meta.id).sort()).toEqual(["r-at-start", "r-at-tail"]);
  });

  test("まだ終わっていない Bash は現在までを範囲にする", () => {
    const { home, codexHome, repo, index } = setup();
    writeRollout(codexHome, { id: "r-late", cwd: repo, startMs: T0 + 120_000 });
    const running = call({ toolUseId: "b1", cwd: repo, endMs: null });
    expect(matchByRules([running], index, { nowMs: T0 + 60_000, home })).toEqual([]);
    expect(matchByRules([running], index, { nowMs: T0 + 130_000, home }).map((m) => m.meta.id)).toEqual(["r-late"]);
  });

  test("作業フォルダ・source が違う記録、監視コマンドは付けない", () => {
    const { home, codexHome, repo, index } = setup();
    const other = path.join(home, "other");
    fs.mkdirSync(other);
    writeRollout(codexHome, { id: "r-other-cwd", cwd: other, startMs: T0 + 1_000 });
    writeRollout(codexHome, { id: "r-cli", cwd: repo, startMs: T0 + 1_000, source: "cli" });
    writeRollout(codexHome, { id: "r-subagent", cwd: repo, startMs: T0 + 1_000, source: { subagent: { thread_spawn: {} } } });
    expect(matchByRules([call({ toolUseId: "b1", cwd: repo })], index, { nowMs: T0 + 60_000, home })).toEqual([]);
    writeRollout(codexHome, { id: "r-ok", cwd: repo, startMs: T0 + 2_000 });
    const watcher = call({ toolUseId: "w1", cwd: repo, command: "pgrep -f \"codex exec\" | wc -l" });
    expect(matchByRules([watcher], index, { nowMs: T0 + 60_000, home })).toEqual([]);
  });

  test("cd / -C / ~ / symlink の作業フォルダでも当たる", () => {
    const { home, codexHome, repo, index } = setup();
    const tools = path.join(repo, "tools");
    fs.mkdirSync(tools);
    const link = path.join(home, "repo-link");
    fs.symlinkSync(repo, link);
    writeRollout(codexHome, { id: "r-tools", cwd: tools, startMs: T0 + 1_000 });
    writeRollout(codexHome, { id: "r-link", cwd: link, startMs: T0 + 2_000 });
    const matches = matchByRules([call({ toolUseId: "b1", cwd: "/", command: "cd ~/repo && codex exec -C tools - ; codex exec -" })], index, { nowMs: T0 + 60_000, home });
    expect(matches.map((m) => m.meta.id).sort()).toEqual(["r-link", "r-tools"]);
  });

  test("取り合いは開始が最も遅い Bash に付ける", () => {
    const { home, codexHome, repo, index } = setup();
    writeRollout(codexHome, { id: "r1", cwd: repo, startMs: T0 + 3_000 });
    const early = call({ toolUseId: "early", cwd: repo, startMs: T0, endMs: T0 + 60_000 });
    const late = call({ toolUseId: "late", cwd: repo, startMs: T0 + 2_000, endMs: T0 + 4_000 });
    expect(matchByRules([early, late], index, { nowMs: T0 + 120_000, home }).map((m) => [m.meta.id, m.toolUseId])).toEqual([["r1", "late"]]);
  });

  test("圧縮済み（.jsonl.zst）の記録も読む", () => {
    const { home, codexHome, repo, index } = setup();
    const file = writeRollout(codexHome, { id: "r-zst", cwd: repo, startMs: T0 + 1_000, compressed: true });
    const matches = matchByRules([call({ toolUseId: "b1", cwd: repo })], index, { nowMs: T0 + 60_000, home });
    expect(matches.map((m) => [m.meta.id, m.meta.path])).toEqual([["r-zst", file]]);
  });

  test("除外された記録（控えで別の会話のもの）は付けない", () => {
    const { home, codexHome, repo, index } = setup();
    writeRollout(codexHome, { id: "r1", cwd: repo, startMs: T0 + 1_000 });
    expect(matchByRules([call({ toolUseId: "b1", cwd: repo })], index, { nowMs: T0 + 60_000, home, excludedIds: new Set(["r1"]) })).toEqual([]);
  });
});

// MARK: - 状態

describe("CodexExecLinker の状態の判定", () => {
  test("プローブ中の同サイズ・mtime 更新でも終端行を読み直す", async () => {
    const home = makeTempDir("cx-rewritten-in-probe"), repo = path.join(home, "repo"); fs.mkdirSync(repo);
    const spec = { id: "live", cwd: repo, startMs: T0 + 1000 };
    const file = writeRollout(path.join(home, ".codex"), { ...spec, terminal: null });
    fs.appendFileSync(file, " ".repeat(2047) + "\n");
    const before = fs.statSync(file);
    let finish!: Parameters<ProcessProbeExec>[2];
    const linker = new CodexExecLinker({ home, now: () => T0 + 3_600_000, exec: (_cmd, _args, callback) => { finish = callback; } });
    const pending = linker.evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false });
    const completed = rolloutLines({ ...spec, terminal: "complete" }).map((line) => JSON.stringify(line)).join("\n") + "\n";
    fs.writeFileSync(file, completed + " ".repeat(before.size - Buffer.byteLength(completed) - 1) + "\n");
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    expect(fs.statSync(file).size).toBe(before.size);
    finish(Object.assign(new Error("no holder"), { code: 1 }), "");
    expect((await pending)?.[0]?.status).toBe("completed");
  });
  test.each(["complete", "aborted", "updated"] as const)("枠待ち中に記録が %s へ更新されたら、同じ評価で読み直す", async (terminal) => {
    vi.useFakeTimers();
    const home = makeTempDir("cx-finished-in-queue"), repo = path.join(home, "repo"); fs.mkdirSync(repo);
    const file = writeRollout(path.join(home, ".codex"), { id: "live", cwd: repo, startMs: T0 + 1000, terminal: null });
    let release!: () => void;
    const blocker = periodicWorkLimiter.run("busy-preview", "background", () => new Promise<void>((resolve) => { release = resolve; }));
    let probe: Promise<void> | undefined;
    const exec: ProcessProbeExec = (_cmd, _args, callback, signal) => {
      probe = periodicWorkLimiter.run("queued-lsof", "background", async () => {
        callback(Object.assign(new Error("no holder"), { code: 1 }), "");
      }, signal);
      void probe.catch((error) => callback(error, ""));
    };
    const linker = new CodexExecLinker({ home, exec, now: Date.now });
    const pending = linker.evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false });
    try {
      expect(periodicWorkLimiter.waiting).toBe(1);
      await vi.advanceTimersByTimeAsync(20_000);
      const ts = T0 + 80_000;
      fs.appendFileSync(file, JSON.stringify({ timestamp: iso(ts), type: "event_msg", payload: {
        type: terminal === "complete" ? "task_complete" : terminal === "aborted" ? "turn_aborted" : "task_started",
      } }) + "\n");
      release(); await blocker; await vi.advanceTimersByTimeAsync(0);
      const runs = await pending;
      expect(runs?.[0]).toMatchObject({ status: terminal === "complete" ? "completed" : terminal === "aborted" ? "error" : "running", lastTs: ts });
      // 長い休止中も最初から正しい状態を返しており、次の評価による訂正を必要としない。
      expect(linker.due()).toBe(false);
    } finally {
      release(); await blocker; await vi.advanceTimersByTimeAsync(0); await probe; await pending; vi.useRealTimers();
    }
  });
  test("reset 前の遅いプローブは新世代のキャッシュ・次回評価時刻を上書きしない", async () => {
    const home = makeTempDir("cx-generation"), repo = path.join(home, "repo"); fs.mkdirSync(repo);
    writeRollout(path.join(home, ".codex"), { id: "live", cwd: repo, startMs: T0 + 1000, terminal: null });
    let now = T0 + 3_600_000;
    const callbacks: Parameters<ProcessProbeExec>[2][] = [];
    const linker = new CodexExecLinker({ home, now: () => now,
      exec: (_cmd, _args, callback) => { callbacks.push(callback); } });
    const input = { calls: calls(repo), sessionAlive: false };
    const old = linker.evaluate({ ...input, sessionId: "old" });
    expect(callbacks).toHaveLength(1);
    linker.reset();
    now += 10_000;
    const next = linker.evaluate({ ...input, sessionId: "new" });
    expect(callbacks).toHaveLength(2);
    expect(await old).toBeNull();
    callbacks[1]!(null, "1234\n");
    expect((await next)?.[0]?.status).toBe("running");
    now += 2_000;
    expect(linker.due()).toBe(true);
    // 取消を無視した旧プローブが後から「死亡」を返しても、新世代の running を保つ。
    callbacks[0]!(Object.assign(new Error("no holder"), { code: 1 }), "");
    await Promise.resolve(); await Promise.resolve();
    expect(linker.due()).toBe(true);
    expect((await linker.evaluate({ ...input, sessionId: "new" }))?.[0]?.status).toBe("running");
    expect(callbacks).toHaveLength(2);
  });
  test("生存確認の古い待ちが置き換わっても、死亡扱いで登録簿を捨てない", async () => {
    const home = makeTempDir("cx-skipped-probe");
    const registryDir = path.join(home, "registry");
    fs.mkdirSync(registryDir);
    const registryPath = path.join(registryDir, "424242.json");
    const registry = JSON.stringify({
      pid: 424242, sessionId: "s", status: "busy",
    });
    fs.writeFileSync(registryPath, registry);
    const { exec, calls: execCalls } = fakeExec({
      ps: () => psRow(424242, 1, 424242, T0, "claude"),
    });
    const linker = new CodexExecLinker({
      home, codexHome: path.join(home, ".codex"), linksPath: path.join(home, "links.jsonl"),
      claudeSessionsDir: registryDir, exec, now: () => T0 + 3_600_000,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // 背景は同時 1 件までなので、1 件塞げば対象の生存確認は待ちに入る。
    const blocker = periodicWorkLimiter.run("busy-background", "background", () => gate);
    const replacementProbe = vi.fn(async () => true);
    let replacement: Promise<boolean> | undefined;
    try {
      expect(periodicWorkLimiter.running).toBe(1);
      expect(periodicWorkLimiter.waiting).toBe(0);
      const pending = linker.evaluate({ sessionId: "s", sessionAlive: true, calls: [{
        toolUseId: "b1", owner: "root", command: "codex exec -", cwd: home, startMs: T0, endMs: null,
      }] });
      expect(periodicWorkLimiter.waiting).toBe(1);
      // 古い確認だけを置き換え、実物の pid / ps は調べない。
      replacement = periodicWorkLimiter.run("claude-pid:424242", "background", replacementProbe);
      expect(periodicWorkLimiter.waiting).toBe(1);
      await pending;
      expect(replacementProbe).not.toHaveBeenCalled();
      expect(fs.readFileSync(registryPath, "utf8")).toBe(registry);
      expect(execCalls.some((command) => command.startsWith("ps "))).toBe(true);
      expect(execCalls.some((command) => command.startsWith("pgrep "))).toBe(false);
    } finally {
      release();
      await Promise.all([blocker, replacement]);
    }
    expect(replacementProbe).toHaveBeenCalledOnce();
    expect(periodicWorkLimiter.running).toBe(0);
    expect(periodicWorkLimiter.waiting).toBe(0);
  });

  test.each([
    { duration: 20, rest: 2000 },
    { duration: 1000, rest: 3000 },
    { duration: 20000, rest: 30000 },
  ])("定期評価は所要 $duration ms の後 $rest ms 休み、force でも重ねない", async ({ duration, rest }) => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 3_600_000);
    try {
      const home = makeTempDir("cx-load-shed");
      const repo = path.join(home, "repo");
      fs.mkdirSync(repo);
      writeRollout(path.join(home, ".codex"), { id: "live", cwd: repo, startMs: T0 + 1000, terminal: null });
      const exec: ProcessProbeExec = (_cmd, _args, callback) => {
        setTimeout(() => callback(null, "4242\n"), duration);
      };
      const linker = new CodexExecLinker({
        home, codexHome: path.join(home, ".codex"), linksPath: path.join(home, "links.jsonl"),
        exec, now: Date.now,
      });
      const input = { sessionId: "s", calls: calls(repo), sessionAlive: false };
      const pending = linker.evaluate(input);
      expect(linker.due()).toBe(false);
      expect(await linker.evaluate({ ...input, force: true })).toBeNull();
      await vi.advanceTimersByTimeAsync(duration);
      expect((await pending)?.[0]?.status).toBe("running");
      await vi.advanceTimersByTimeAsync(rest - 1);
      expect(linker.due()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(linker.due()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  function linkerFor(home: string, lsof: (args: string[]) => string | null | undefined): CodexExecLinker {
    const { exec } = fakeExec({ lsof });
    return new CodexExecLinker({ home, codexHome: path.join(home, ".codex"), linksPath: path.join(home, "links.jsonl"), exec, now: () => T0 + 3_600_000, intervalMs: 0 });
  }
  const calls = (repo: string): BashCall[] => [{ toolUseId: "b1", owner: "root", command: "codex exec -", cwd: repo, startMs: T0, endMs: T0 + 100_000 }];

  test("task_complete = 完了 / turn_aborted = 失敗", async () => {
    const home = makeTempDir("cx-status");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    writeRollout(path.join(home, ".codex"), { id: "done", cwd: repo, startMs: T0 + 1_000, terminal: "complete" });
    writeRollout(path.join(home, ".codex"), { id: "aborted", cwd: repo, startMs: T0 + 2_000, terminal: "aborted" });
    const runs = await linkerFor(home, () => null).evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false });
    expect(runs?.map((run) => [run.rolloutId, run.status])).toEqual([["done", "completed"], ["aborted", "error"]]);
  });

  test("終わりの行が無い: 開いているプロセスがいれば実行中（直近のツール付き）、いなければ失敗、確認できなければ実行中", async () => {
    const home = makeTempDir("cx-status-open");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    const file = writeRollout(path.join(home, ".codex"), {
      id: "live", cwd: repo, startMs: T0 + 1_000, terminal: null,
      body: [execCall(T0 + 5_000, "c1", "ls tools/out")],
    });
    const running = await linkerFor(home, (args) => (args[0] === "-t" && args[2] === file ? "4242\n" : null))
      .evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: true });
    expect(running?.[0]?.status).toBe("running");
    expect(running?.[0]?.activity?.command).toBe("ls tools/out");
    const failed = await linkerFor(home, () => null).evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false });
    expect(failed?.[0]?.status).toBe("error");
    expect(failed?.[0]?.activity).toBeNull();
    const unknown = await linkerFor(home, () => undefined).evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false });
    expect(unknown?.[0]?.status).toBe("running");
  });

  test("誰も開いていなかった記録は、伸びない限り lsof で見直さない", async () => {
    const home = makeTempDir("cx-status-cache");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    const file = writeRollout(path.join(home, ".codex"), { id: "dead", cwd: repo, startMs: T0 + 1_000, terminal: null });
    const clock = { now: T0 + 3_600_000 };
    const { exec, calls: execCalls } = fakeExec({ lsof: () => null });
    const linker = new CodexExecLinker({ home, codexHome: path.join(home, ".codex"), linksPath: path.join(home, "l.jsonl"), exec, now: () => clock.now, intervalMs: 0 });
    for (let i = 0; i < 3; i++) {
      clock.now += 60_000;
      expect((await linker.evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false }))?.[0]?.status).toBe("error");
    }
    expect(execCalls.filter((c) => c.startsWith("lsof -t"))).toHaveLength(1);
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: iso(T0 + 70_000), type: "event_msg", payload: { type: "task_complete" } })}\n`);
    expect((await linker.evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false }))?.[0]?.status).toBe("completed");
  });

  test("依頼文・モデル・工数・開始時刻を記録から読む", async () => {
    const home = makeTempDir("cx-status-meta");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    writeRollout(path.join(home, ".codex"), { id: "m1", cwd: repo, startMs: T0 + 1_000, request: "1行目\n2行目\n\n\n\n3行目", model: "gpt-6.1-sol", effort: "medium" });
    const runs = await linkerFor(home, () => null).evaluate({ sessionId: "s", calls: calls(repo), sessionAlive: false });
    expect(runs?.[0]).toMatchObject({
      nodeId: "codex-exec:m1", toolUseId: "b1", owner: "root", label: "1行目\n2行目\n\n3行目",
      model: "gpt-6.1-sol", effort: "medium", startMs: T0 + 1_000, lastTs: T0 + 61_000,
    });
    expect(requestLabel(null)).toBe("Codex への依頼");
    expect(requestLabel("あ".repeat(400))).toHaveLength(300);
  });
});

// MARK: - 作業の読み取り

describe("exec の記録の読み取り", () => {
  const spec = (overrides: Partial<RolloutSpec> = {}): RolloutSpec => ({
    id: "e1", cwd: "/repo", startMs: T0, request: "羽根のブレードを描いて保存して",
    body: [
      { timestamp: iso(T0 + 2_000), type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "確認します" }] } } },
      assistantText(T0 + 2_001, "確認します"),
      execCall(T0 + 3_000, "c1", "ls tools/out"),
      execOutput(T0 + 4_000, "c1", "cand_1.png"),
      assistantText(T0 + 50_000, "保存しました"),
    ],
    ...overrides,
  });
  const jsonl = (s: RolloutSpec): string => rolloutLines({ terminal: "complete", ...s }).map((line) => JSON.stringify(line)).join("\n") + "\n";

  test("最初の素の利用者発話から読み、依頼文を利用者側の行として出す（返事・ツールはそのまま）", () => {
    const result = parseCodexExecTranscript(jsonl(spec()));
    expect(result.omitted).toBe(0);
    expect(result.entries.map((e) => [e.role, e.kind ?? null, e.text])).toEqual([
      ["user", null, "羽根のブレードを描いて保存して"],
      ["assistant", null, "確認します"],
      ["tool", "tool_use", "Bash: ls tools/out"],
      ["tool", "tool_result", "cand_1.png"],
      ["assistant", null, "保存しました"],
    ]);
    expect(result.entries[0]!.ts).toBe(T0 + 1_011);
  });

  test("旧形式の event_msg/user_message からも読む", () => {
    const result = parseCodexExecTranscript(jsonl(spec({ legacyUserMessage: true })));
    expect(result.entries[0]).toMatchObject({ role: "user", text: "羽根のブレードを描いて保存して" });
    expect(result.entries.filter((e) => e.role === "user")).toHaveLength(1);
  });

  test("素の発話イベントが無い記録は、注入でない最初の利用者発話を依頼文にする", () => {
    const lines = rolloutLines({ ...spec(), terminal: "complete" })
      .filter((line) => !(line["type"] === "event_msg" && (line["payload"] as Record<string, unknown>)["type"] === "item_completed"));
    const result = parseCodexExecTranscript(lines.map((line) => JSON.stringify(line)).join("\n"));
    expect(result.entries.map((e) => e.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(result.entries[0]!.text).toBe("羽根のブレードを描いて保存して");
  });

  test("ページ送り: before より前の最大 200 件", () => {
    const body: Record<string, unknown>[] = [];
    for (let i = 0; i < 250; i++) body.push(assistantText(T0 + 2_000 + i, `m${i}`));
    const all = jsonl(spec({ body }));
    const latest = parseCodexExecTranscript(all);
    expect(latest.omitted).toBe(51);
    expect(latest.entries).toHaveLength(200);
    expect(latest.entries.at(-1)!.text).toBe("m249");
    const older = parseCodexExecTranscript(all, latest.omitted);
    expect(older.omitted).toBe(0);
    expect(older.entries[0]!.role).toBe("user");
    expect(older.entries).toHaveLength(51);
  });

  test("ファイル読みは結果を覚え、追記された分だけ読み足す（圧縮済みも読む）", () => {
    const dir = makeTempDir("cx-exec-transcript");
    const file = path.join(dir, "rollout-2026-11-10T19-00-00-e1.jsonl");
    const lines = rolloutLines({ ...spec({ body: [assistantText(T0 + 2_000, "途中")] }), terminal: null });
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n" + JSON.stringify(assistantText(T0 + 3_000, "書きかけ")).slice(0, 20));
    expect(readCodexExecTranscript(file).entries.map((e) => e.text)).toEqual(["羽根のブレードを描いて保存して", "途中"]);
    // 書きかけの行の続き + 新しい行。
    const rest = JSON.stringify(assistantText(T0 + 3_000, "書きかけ")).slice(20);
    fs.appendFileSync(file, `${rest}\n${JSON.stringify(execCall(T0 + 4_000, "c9", "echo hi"))}\n`);
    expect(readCodexExecTranscript(file).entries.map((e) => e.text)).toEqual([
      "羽根のブレードを描いて保存して", "途中", "書きかけ", "Bash: echo hi",
    ]);
    const zst = path.join(dir, "rollout-2026-11-10T19-00-00-e2.jsonl.zst");
    fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(jsonl(spec()))));
    expect(readCodexExecTranscript(zst).entries).toHaveLength(5);
    expect(readCodexExecTranscript(null)).toEqual({ entries: [], omitted: 0 });
    expect(readCodexExecTranscript(path.join(dir, "missing.jsonl"))).toEqual({ entries: [], omitted: 0 });
  });
});

// MARK: - 実行中の観測

describe("実行中の観測（ps / lsof）", () => {
  const SID = "11111111-2222-3333-4444-555555555555";

  test("isCodexExecCommand: exec だけを拾い、exec-server / app-server / 他の codex 系は除く", () => {
    expect(isCodexExecCommand("codex exec --skip-git-repo-check -c model_reasoning_effort=low -")).toBe(true);
    expect(isCodexExecCommand("/Users/me/.codex/packages/standalone/current/bin/codex -c x=y exec -")).toBe(true);
    expect(isCodexExecCommand("node /usr/local/bin/codex exec -")).toBe(true);
    expect(isCodexExecCommand("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c forced_login_method=\"chatgpt\" exec-server --concurrent-requests 32")).toBe(false);
    expect(isCodexExecCommand("codex app-server --listen stdio://")).toBe(false);
    expect(isCodexExecCommand("/x/bin/codex-code-mode-host")).toBe(false);
    expect(isCodexExecCommand("/bin/zsh -c codex exec -")).toBe(false);
  });

  test("parsePsOutput は lstart をローカル時刻で読む", () => {
    const rows = parsePsOutput(`${psRow(10, 1, 10, T0, "claude --resume abc")}\n${psRow(11, 10, 11, T0 + 2_000, "/bin/zsh -c eval 'x'")}\n`);
    expect(rows.map((row) => [row.pid, row.ppid, row.pgid, row.startMs, row.command])).toEqual([
      [10, 1, 10, T0, "claude --resume abc"],
      [11, 10, 11, T0 + 2_000, "/bin/zsh -c eval 'x'"],
    ]);
  });

  test("pickOriginBash: シェルの command に入っている Bash を優先し、無ければ動いている最も新しい Bash", () => {
    const calls: BashCall[] = [
      { toolUseId: "a", owner: "root", command: "./queue.sh", cwd: null, startMs: T0, endMs: null },
      { toolUseId: "b", owner: "root", command: "sleep 100", cwd: null, startMs: T0 + 300, endMs: null },
      { toolUseId: "old", owner: "root", command: "ls", cwd: null, startMs: T0 - 60_000, endMs: T0 - 50_000 },
    ];
    const shell = (command: string): Parameters<typeof pickOriginBash>[0] => ({ pid: 1, ppid: 0, pgid: 1, startMs: T0, command });
    expect(pickOriginBash(shell("/bin/zsh -c source snap.sh && eval './queue.sh' && pwd -P >| /tmp/x"), calls)).toBe("a");
    expect(pickOriginBash(shell("/bin/zsh -c something-else"), calls)).toBe("b");
    expect(pickOriginBash({ ...shell("x"), startMs: T0 - 120_000 }, calls)).toBeNull();
  });

  /** 観測のシナリオ: 時計と ps の中身をテストから進める。 */
  function scenario(): {
    home: string; repo: string; codexHome: string; linksPath: string; clock: { now: number };
    ps: { rows: string[] }; lsofRollouts: Map<number, string>; lsofCwds: Map<number, string>; linker: CodexExecLinker;
    registryDir: string; alivePids: Map<number, boolean>; aliveChecks: [number, string | null][]; pgrepCalls: () => number;
  } {
    const home = makeTempDir("cx-observe");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    const codexHome = path.join(home, ".codex");
    const linksPath = path.join(home, ".tailii", "codex-exec-links.jsonl");
    const clock = { now: T0 + 1_000 };
    const ps = { rows: [] as string[] };
    const lsofRollouts = new Map<number, string>();
    const lsofCwds = new Map<number, string>();
    // Claude の登録簿（`~/.claude/sessions/<pid>.json`）と、その pid の生存（起動時刻の一致込み）。
    const registryDir = path.join(home, ".claude", "sessions");
    fs.mkdirSync(registryDir, { recursive: true });
    const alivePids = new Map<number, boolean>();
    const aliveChecks: [number, string | null][] = [];
    const { exec, calls: execCalls } = fakeExec({
      // pgrep -f <id>: argv にその文字列を含むプロセスの pid。
      pgrep: (args) => {
        const pids = parsePsOutput(ps.rows.join("\n")).filter((row) => row.command.includes(args[1]!)).map((row) => row.pid);
        return pids.length > 0 ? `${pids.join("\n")}\n` : null;
      },
      ps: () => ps.rows.join("\n") + "\n",
      lsof: (args) => {
        if (args[0] === "-t") return null;
        if (args[0] === "-a") {
          const cwd = lsofCwds.get(Number(args[2]));
          return cwd === undefined ? null : `p${args[2]}\nfcwd\nn${cwd}\n`;
        }
        const pid = Number(args[1]);
        const file = lsofRollouts.get(pid);
        return file === undefined ? `p${pid}\nn/dev/null\n` : `p${pid}\nn/dev/null\nn${file}\n`;
      },
    });
    const linker = new CodexExecLinker({
      home, codexHome, linksPath, exec, now: () => clock.now, intervalMs: 0, claudeSessionsDir: registryDir,
      processAlive: (pid, procStart) => {
        aliveChecks.push([pid, procStart]);
        return alivePids.get(pid) ?? false;
      },
    });
    const pgrepCalls = (): number => execCalls.filter((call) => call.startsWith("pgrep ")).length;
    return { home, repo, codexHome, linksPath, clock, ps, lsofRollouts, lsofCwds, linker, registryDir, alivePids, aliveChecks, pgrepCalls };
  }

  test("切り離したスクリプトは、親のシェルが終わって付け替えられた後も起動元を保つ（規則では拾えない形）", async () => {
    const s = scenario();
    const calls: BashCall[] = [
      { toolUseId: "launch", owner: "root", command: "nohup ./queue.sh > q.log 2>&1 &", cwd: s.repo, startMs: T0, endMs: null },
    ];
    // 1 回目: Claude → Bash のシェル → queue.sh。
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, `claude --resume ${SID}`),
      psRow(200, 100, 200, T0, "/bin/zsh -c source snap.sh && eval 'nohup ./queue.sh > q.log 2>&1 &'"),
      psRow(201, 200, 200, T0, "/bin/bash ./queue.sh"),
    ];
    expect(await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true })).toEqual([]);
    // Bash は終わり、queue.sh は launchd へ付け替えられ、5 分後に codex exec を起動する（Bash の終わり + 10 秒より後）。
    calls[0]!.endMs = T0 + 500;
    const startMs = T0 + 300_000;
    const file = writeRollout(s.codexHome, { id: "queued", cwd: s.repo, startMs, terminal: null });
    s.clock.now = startMs + 3_000;
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, `claude --resume ${SID}`),
      psRow(201, 1, 200, T0, "/bin/bash ./queue.sh"),
      psRow(300, 201, 200, startMs, "codex exec --skip-git-repo-check -"),
    ];
    s.lsofRollouts.set(300, file);
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(runs?.map((run) => [run.nodeId, run.toolUseId, run.status])).toEqual([["codex-exec:queued", "launch", "running"]]);
    const links = new CodexExecLinkStore(s.linksPath).load();
    expect(links).toEqual([{ rolloutId: "queued", rolloutPath: file, claudeSessionId: SID, toolUseId: "launch", owner: "root", ts: startMs + 3_000 }]);
    // プロセスが終わった後も、控えから同じ Bash に付く（規則の範囲外でも）。
    s.ps.rows = [psRow(100, 1, 100, T0 - 600_000, `claude --resume ${SID}`)];
    s.lsofRollouts.clear();
    s.clock.now += 600_000;
    const later = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(later?.map((run) => [run.nodeId, run.toolUseId, run.status])).toEqual([["codex-exec:queued", "launch", "error"]]);
  });

  test("親が先に終わった子も、追跡済みシェルのプロセスグループで辿る", async () => {
    const s = scenario();
    const calls: BashCall[] = [{ toolUseId: "py", owner: "root", command: "python3 tools/pose_redo.py", cwd: s.repo, startMs: T0, endMs: null }];
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, `claude --resume ${SID}`),
      psRow(200, 100, 200, T0, "/bin/zsh -c eval 'python3 tools/pose_redo.py'"),
    ];
    await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    const startMs = T0 + 4_000;
    const file = writeRollout(s.codexHome, { id: "via-pgid", cwd: s.repo, startMs });
    s.clock.now = startMs + 2_000;
    // シェルも python も消え、codex exec だけが同じプロセスグループで残る。
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, `claude --resume ${SID}`),
      psRow(301, 1, 200, startMs, "codex exec -"),
    ];
    s.lsofRollouts.set(301, file);
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId])).toEqual([["via-pgid", "py"]]);
  });

  test("lsof で記録が見つからないときは、作業フォルダと開始時刻で 1 件に絞れたときだけ採る", async () => {
    const s = scenario();
    const calls: BashCall[] = [{ toolUseId: "py", owner: "root", command: "python3 run.py", cwd: s.repo, startMs: T0, endMs: null }];
    const startMs = T0 + 2_000;
    writeRollout(s.codexHome, { id: "by-cwd", cwd: s.repo, startMs: startMs + 800 });
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, `claude --resume ${SID}`),
      psRow(200, 100, 200, T0, "/bin/zsh -c eval 'python3 run.py'"),
      psRow(201, 200, 200, T0, "python3 run.py"),
      psRow(300, 201, 200, startMs, "codex exec -"),
    ];
    s.lsofCwds.set(300, s.repo);
    s.clock.now = startMs + 1_000;
    // 見え始めてすぐは lsof の結果を待つ。
    expect(await s.linker.evaluate({ sessionId: SID, calls: calls.map((c) => ({ ...c, command: "python3 run.py" })), sessionAlive: true }))
      .toEqual([]);
    s.clock.now = startMs + 7_000;
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId])).toEqual([["by-cwd", "py"]]);
  });

  /** 登録簿に 1 件書く（Claude 2.1.283+ の形）。 */
  function writeRegistry(dir: string, pid: number, sessionId: string, procStart = "Tue Nov 10 09:50:00 2026"): void {
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
      pid, sessionId, cwd: "/x", startedAt: T0 - 600_000, procStart, kind: "interactive", status: "busy", updatedAt: T0,
    }));
  }

  /** 素の claude（argv に id なし）が Bash → codex exec を起動した ps と、その記録。 */
  function launchViaPython(s: ReturnType<typeof scenario>, claudeCommand: string): { calls: BashCall[]; file: string } {
    const calls: BashCall[] = [{ toolUseId: "py", owner: "root", command: "python3 run.py", cwd: s.repo, startMs: T0, endMs: null }];
    const startMs = T0 + 2_000;
    const file = writeRollout(s.codexHome, { id: "via-registry", cwd: s.repo, startMs, terminal: null });
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, claudeCommand),
      psRow(200, 100, 200, T0, "/bin/zsh -c eval 'python3 run.py'"),
      psRow(201, 200, 200, T0, "python3 run.py"),
      psRow(300, 201, 200, startMs, "codex exec -"),
    ];
    s.lsofRollouts.set(300, file);
    s.clock.now = startMs + 1_500;
    return { calls, file };
  }

  test("登録簿の sessionId で Claude を引く（argv に id の無い素の claude でも観測できる）", async () => {
    const s = scenario();
    writeRegistry(s.registryDir, 100, SID);
    s.alivePids.set(100, true);
    const { calls } = launchViaPython(s, "claude --model claude-opus-5-5");
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId, run.status])).toEqual([["via-registry", "py", "running"]]);
    expect(new CodexExecLinkStore(s.linksPath).load().map((link) => [link.rolloutId, link.toolUseId, link.claudeSessionId]))
      .toEqual([["via-registry", "py", SID]]);
    // 生存は起動時刻込みで確かめ、登録簿で当たれば pgrep は使わない。
    expect(s.aliveChecks).toContainEqual([100, "Tue Nov 10 09:50:00 2026"]);
    expect(s.pgrepCalls()).toBe(0);
  });

  test("登録簿の pid が死んでいる・使い回されている（起動時刻が違う）ときは採らず、pgrep に落ちる", async () => {
    const s = scenario();
    writeRegistry(s.registryDir, 100, SID, "Mon Nov  9 01:00:00 2026");
    s.alivePids.set(100, false);
    // 登録簿だけなら素の claude（argv に id なし）は見つからない。
    const bare = launchViaPython(s, "claude --model claude-opus-5-5");
    expect(await s.linker.evaluate({ sessionId: SID, calls: bare.calls, sessionAlive: true })).toEqual([]);
    expect(s.pgrepCalls()).toBe(1);
    expect(fs.existsSync(s.linksPath)).toBe(false);
  });

  test("登録簿に記録が無ければ pgrep -f <セッション id> に落ちる（argv の形も確かめる）", async () => {
    const s = scenario();
    const { calls } = launchViaPython(s, `claude --resume ${SID}`);
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId])).toEqual([["via-registry", "py"]]);
    expect(s.pgrepCalls()).toBe(1);
  });

  test("/clear 後（登録簿の sessionId と argv の id が違う）: 新しい会話に付き、古い id の会話には付けない", async () => {
    const OLD = "99999999-8888-7777-6666-555555555555";
    const s = scenario();
    writeRegistry(s.registryDir, 100, SID);
    s.alivePids.set(100, true);
    const { calls } = launchViaPython(s, `claude --resume ${OLD}`);
    // 古い id の会話（argv には残っている）: pgrep は 100 を返すが、登録簿で別の会話と分かるので採らない。
    expect(await s.linker.evaluate({ sessionId: OLD, calls, sessionAlive: true })).toEqual([]);
    expect(fs.existsSync(s.linksPath)).toBe(false);
    // 新しい id の会話（登録簿）: 付く（観測は 2 秒に 1 回までなので時計を進める）。
    s.clock.now += 2_000;
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true });
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId])).toEqual([["via-registry", "py"]]);
  });

  test("起動直後のシェルは、文面の一致する Bash が記録に現れるまで起動元を決めない（先に動いていた別の Bash に固定しない）", async () => {
    const s = scenario();
    writeRegistry(s.registryDir, 100, SID);
    s.alivePids.set(100, true);
    // 先に背景で動いている別の Bash（監視スクリプト）。
    const watcher: BashCall = { toolUseId: "watcher", owner: "root", command: "node watch.mjs t.jsonl l.jsonl 150", cwd: s.repo, startMs: T0 - 6_000, endMs: null };
    const launcher: BashCall = { toolUseId: "launcher", owner: "root", command: "sleep 1; python3 run.py", cwd: s.repo, startMs: T0, endMs: null };
    const startMs = T0 + 1_500;
    const file = writeRollout(s.codexHome, { id: "raced", cwd: s.repo, startMs, terminal: null });
    s.ps.rows = [
      psRow(100, 1, 100, T0 - 600_000, "claude --model x"),
      psRow(150, 100, 150, T0 - 6_000, "/bin/zsh -c eval 'node watch.mjs t.jsonl l.jsonl 150'"),
      psRow(200, 100, 200, T0, "/bin/zsh -c source snap.sh && eval 'sleep 1; python3 run.py' && pwd -P >| /tmp/x"),
      psRow(201, 200, 200, startMs, "python3 run.py"),
      psRow(300, 201, 200, startMs, "codex exec -"),
    ];
    s.lsofRollouts.set(300, file);
    s.clock.now = startMs + 500;
    // launcher の tool_use 行をまだ読んでいない時点: 起動元を決めない（watcher にしない）。
    expect(await s.linker.evaluate({ sessionId: SID, calls: [watcher], sessionAlive: true })).toEqual([]);
    expect(fs.existsSync(s.linksPath)).toBe(false);
    s.clock.now += 2_000;
    const runs = await s.linker.evaluate({ sessionId: SID, calls: [watcher, launcher], sessionAlive: true });
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId])).toEqual([["raced", "launcher"]]);
  });

  test("argv にセッション id が無い（Claude が見つからない）ときは何もせず規則に任せる", async () => {
    const s = scenario();
    const calls: BashCall[] = [{ toolUseId: "b", owner: "root", command: "python3 run.py", cwd: s.repo, startMs: T0, endMs: null }];
    s.ps.rows = [psRow(300, 1, 300, T0 + 1_000, "codex exec -")];
    expect(await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: true })).toEqual([]);
    expect(fs.existsSync(s.linksPath)).toBe(false);
  });

  test("控えは規則より優先し、別の会話の控えにある記録は規則で当たっても付けない", async () => {
    const s = scenario();
    const mine = writeRollout(s.codexHome, { id: "mine", cwd: s.repo, startMs: T0 + 3_000 });
    writeRollout(s.codexHome, { id: "theirs", cwd: s.repo, startMs: T0 + 4_000 });
    const store = new CodexExecLinkStore(s.linksPath, () => T0);
    store.append({ rolloutId: "mine", rolloutPath: mine, claudeSessionId: SID, toolUseId: "first", owner: "root", ts: T0 });
    store.append({ rolloutId: "theirs", rolloutPath: "/x", claudeSessionId: "other-session", toolUseId: "zzz", owner: "root", ts: T0 });
    const calls: BashCall[] = [
      { toolUseId: "first", owner: "root", command: "codex exec -", cwd: s.repo, startMs: T0, endMs: T0 + 20_000 },
      { toolUseId: "second", owner: "root", command: "codex exec -", cwd: s.repo, startMs: T0 + 1_000, endMs: T0 + 20_000 },
    ];
    s.clock.now = T0 + 3_600_000;
    const runs = await s.linker.evaluate({ sessionId: SID, calls, sessionAlive: false });
    // 規則なら開始の遅い "second" に付くが、控えの "first" が勝つ。"theirs" は付けない。
    expect(runs?.map((run) => [run.rolloutId, run.toolUseId])).toEqual([["mine", "first"]]);
  });

  test("控えは 30 日より古い行を書き込み時に落とす", () => {
    const dir = makeTempDir("cx-links");
    const file = path.join(dir, "links.jsonl");
    const now = T0;
    const old: CodexExecLink = { rolloutId: "old", rolloutPath: "/o", claudeSessionId: "s", toolUseId: "t", owner: "root", ts: now - 31 * 24 * 3600 * 1000 };
    fs.writeFileSync(file, `${JSON.stringify(old)}\nnot json\n`);
    const store = new CodexExecLinkStore(file, () => now);
    store.append({ ...old, rolloutId: "new", ts: now });
    expect(store.load().map((link) => link.rolloutId)).toEqual(["new"]);
  });
});

// MARK: - tailer からノードとして流す

describe("SubagentTailer: Codex の実行をノードとして流す", () => {
  function setup(name: string): { home: string; repo: string; codexHome: string; project: string; linker: () => CodexExecLinker } {
    const home = makeTempDir(name);
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    const codexHome = path.join(home, ".codex");
    const project = path.join(home, "project");
    fs.mkdirSync(project);
    const { exec } = fakeExec({ lsof: () => null });
    const linker = (): CodexExecLinker => new CodexExecLinker({
      home, codexHome, linksPath: path.join(home, "links.jsonl"), exec, intervalMs: 0,
    });
    return { home, repo, codexHome, project, linker };
  }

  test("1 つの Bash の並走する実行を 1 件ずつ、表のとおりの値で流す（開き直しても同じノードを流し直す）", async () => {
    const { repo, codexHome, project, linker } = setup("cx-tailer");
    const sid = "aaaaaaaa-0000-0000-0000-000000000001";
    const main = path.join(project, `${sid}.jsonl`);
    const command = "for j in a b; do codex exec --skip-git-repo-check - < $j.prompt.txt > $j.log 2>&1 & done; wait";
    fs.writeFileSync(main, [
      ...bashLines({ id: "toolu_par", command, cwd: repo, startMs: T0, endMs: T0 + 120_000 }),
      ...bashLines({ id: "toolu_watch", command: "pgrep -f \"codex exec\" | wc -l", cwd: repo, startMs: T0 + 5_000, endMs: T0 + 5_100 }),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeRollout(codexHome, { id: "run-a", cwd: repo, startMs: T0 + 1_000, request: "a の依頼", model: "gpt-6.1-sol", effort: "xhigh" });
    writeRollout(codexHome, { id: "run-b", cwd: repo, startMs: T0 + 1_050, request: "b の依頼", terminal: "aborted" });

    const options = { tailIndefinitely: false, probeSessionAlive: () => Promise.resolve(false), probeOutputOpen: () => Promise.resolve(null) };
    const tailer = new SubagentTailer({ ...options, codexExecLinker: linker() });
    const nodes = await collectNodes(tailer, main);
    expect(nodes).toEqual([
      {
        nodeId: "codex-exec:run-a", toolUseId: "toolu_par", parentNodeId: "root", agentType: "Codex", label: "a の依頼",
        depth: 1, status: "completed", currentActivity: null, ts: T0 + 61_000, kind: "codex_exec", startTs: T0 + 1_000,
        model: "gpt-6.1-sol", effort: "xhigh",
      },
      {
        nodeId: "codex-exec:run-b", toolUseId: "toolu_par", parentNodeId: "root", agentType: "Codex", label: "b の依頼",
        depth: 1, status: "error", currentActivity: null, ts: T0 + 61_050, kind: "codex_exec", startTs: T0 + 1_050,
        model: "gpt-6.1-sol", effort: "xhigh",
      },
    ]);
    expect(tailer.codexExecRolloutPath("codex-exec:run-a")).toMatch(/run-a\.jsonl$/);
    // 過去の会話を開き直す（新しい tailer）: 終わった実行のノードも同じ値で流し直す。
    const reopened = await collectNodes(new SubagentTailer({ ...options, codexExecLinker: linker() }), main);
    expect(reopened).toEqual(nodes);
  });

  test("サブエージェントの中の Bash は、そのサブエージェントを持ち主・深さ +1 で流す", async () => {
    const { repo, codexHome, project, linker } = setup("cx-tailer-sub");
    const sid = "aaaaaaaa-0000-0000-0000-000000000002";
    const main = path.join(project, `${sid}.jsonl`);
    const subagents = path.join(project, sid, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(main, JSON.stringify({
      timestamp: iso(T0 - 10_000), cwd: repo,
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "委任" } }] },
    }) + "\n");
    fs.writeFileSync(path.join(subagents, "agent-ag1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "委任", toolUseId: "toolu_agent", spawnDepth: 1 }));
    fs.writeFileSync(path.join(subagents, "agent-ag1.jsonl"),
      bashLines({ id: "toolu_sub_bash", command: "codex exec - < p.txt", cwd: repo, startMs: T0, endMs: T0 + 90_000, agentId: "ag1" })
        .map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeRollout(codexHome, { id: "run-sub", cwd: repo, startMs: T0 + 500 });
    const nodes = await collectNodes(new SubagentTailer({
      tailIndefinitely: false, probeSessionAlive: () => Promise.resolve(false), codexExecLinker: linker(),
    }), main);
    expect(nodes.map((node) => [node.nodeId, node.toolUseId, node.parentNodeId, node.depth])).toEqual([
      ["codex-exec:run-sub", "toolu_sub_bash", "ag1", 2],
    ]);
  });

  test("背景の Bash は完了通知の時刻 + 10 秒までを範囲にする", async () => {
    const { repo, codexHome, project, linker } = setup("cx-tailer-bg");
    const sid = "aaaaaaaa-0000-0000-0000-000000000003";
    const main = path.join(project, `${sid}.jsonl`);
    fs.writeFileSync(main, [
      { cwd: repo, timestamp: iso(T0), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "./batch.sh; codex exec - < last.txt", run_in_background: true } }] } },
      { cwd: repo, timestamp: iso(T0 + 100), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: bgx1. Output is being written to: /tmp/tasks/bgx1.output" }] } },
      { cwd: repo, timestamp: iso(T0 + 600_000), message: { role: "user", content: "<task-notification>\n<task-id>bgx1</task-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeRollout(codexHome, { id: "run-bg", cwd: repo, startMs: T0 + 590_000 });
    writeRollout(codexHome, { id: "run-too-late", cwd: repo, startMs: T0 + 611_000 });
    const nodes = await collectNodes(new SubagentTailer({
      tailIndefinitely: false, probeSessionAlive: () => Promise.resolve(false), probeOutputOpen: () => Promise.resolve(null), codexExecLinker: linker(),
    }), main);
    expect(nodes.map((node) => [node.nodeId, node.toolUseId])).toEqual([["codex-exec:run-bg", "toolu_bg"]]);
  });

  test("ノードの toolUseId は同じ Bash の tool_activity.id と一致する（iOS のカードの突き合わせ）", async () => {
    const { TranscriptTailer } = await import("../src/chat/transcriptTailer.js");
    const { repo, codexHome, project, linker } = setup("cx-tailer-join");
    const sid = "aaaaaaaa-0000-0000-0000-000000000004";
    const main = path.join(project, `${sid}.jsonl`);
    fs.writeFileSync(main, bashLines({ id: "toolu_join", command: "codex exec - < p.txt", cwd: repo, startMs: T0, endMs: T0 + 30_000 })
      .map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeRollout(codexHome, { id: "run-join", cwd: repo, startMs: T0 + 1_000 });
    const nodes = await collectNodes(new SubagentTailer({ tailIndefinitely: false, probeSessionAlive: () => Promise.resolve(false), codexExecLinker: linker() }), main);
    const activityIds: string[] = [];
    for await (const message of new TranscriptTailer({ tailIndefinitely: false }).streamTranscript(main)) {
      if (message.type === "tool_activity") activityIds.push(message.activity.id);
    }
    expect(nodes.map((node) => node.toolUseId)).toEqual(["toolu_join"]);
    expect(activityIds).toContain("toolu_join");
  });
});

// MARK: - 会話一覧には出さない

describe("exec 由来の記録は Codex の会話一覧・検索・件数のどれにも出ない", () => {
  test("list / list(cwd) / listForSearch / transcriptPath", () => {
    const home = makeTempDir("cx-list");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    writeRollout(home, { id: "exec-run", cwd: repo, startMs: T0 + 10_000 });
    writeRollout(home, { id: "exec-zst", cwd: repo, startMs: T0 + 20_000, compressed: true });
    writeRollout(home, { id: "interactive", cwd: repo, startMs: T0, source: "cli", request: "普通の会話", legacyUserMessage: true });
    const store = new CodexSessionStore(home);
    expect(store.list().map((info) => info.sessionId)).toEqual(["interactive"]);
    expect(store.list(repo).map((info) => info.sessionId)).toEqual(["interactive"]);
    expect(store.listForSearch().map((info) => info.sessionId)).toEqual(["interactive"]);
    expect(store.transcriptPath("exec-run")).toBeNull();
    expect(store.transcriptPath("exec-zst")).toBeNull();
  });
});

// MARK: - golden

describe("golden: codex-exec-delegation-v1.ndjson", () => {
  const lines = fs.readFileSync(path.join(hostRoot, "protocol", "codex-exec-delegation-v1.ndjson"), "utf8")
    .split("\n").filter((line) => line.length > 0);

  test("全行が byte-exact でラウンドトリップし、kind codex_exec を復号する", () => {
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    const nodes = lines.map((line) => decodeControlMessage(line))
      .filter((message): message is Extract<ControlMessage, { type: "subagent_node" }> => message.type === "subagent_node");
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    for (const message of nodes) {
      expect(message.node.kind).toBe("codex_exec");
      expect(message.node.agentType).toBe("Codex");
      expect(message.node.nodeId.startsWith("codex-exec:")).toBe(true);
    }
  });

  test("未知の kind は不正のまま", () => {
    const line = lines[0]!.replace("\"kind\":\"codex_exec\"", "\"kind\":\"something_else\"");
    expect(() => decodeControlMessage(line)).toThrow();
  });
});

