import { afterEach, describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExecLinker } from "../src/chat/codexExecLinker.js";
import { SubagentTailer } from "../src/chat/subagentTailer.js";
import { BACKGROUND_FAIR_WAIT_MS, BACKGROUND_WAIT_TIMEOUT_MS, KeyedLimiter, LoadShedSkippedError, nextStartAtMs, periodicWorkLimiter, probeExecFile, restAfterWorkMs } from "../src/shared/loadShed.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFile: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("load shedding", () => {
  test("購読解除で Codex の枠待ちを取消し、同じ tailer の次の会話をすぐ評価する", async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), "tail-cancel-"));
    for (const session of ["old", "new"]) writeFileSync(join(home, `${session}.jsonl`), JSON.stringify({
      cwd: home, timestamp: new Date().toISOString(), message: { role: "assistant", content: [
        { type: "tool_use", id: session, name: "Bash", input: { command: "codex exec -" } },
      ] },
    }) + "\n");
    const linker = new CodexExecLinker({ home, claudeSessionsDir: join(home, "registry") });
    const tailer = new SubagentTailer({ codexExecLinker: linker, probeSessionAlive: async () => true, pollIntervalMs: 10 });
    let release!: () => void;
    const busy = periodicWorkLimiter.run("busy", "background", () => new Promise<void>((resolve) => { release = resolve; }));
    const oldAbort = new AbortController(), nextAbort = new AbortController();
    const drain = async (session: string, signal: AbortSignal) => {
      for await (const _message of tailer.streamSession(join(home, `${session}.jsonl`), signal)) { /* 配信を継続する。 */ }
    };
    const old = drain("old", oldAbort.signal);
    let next: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(periodicWorkLimiter.waiting).toBe(1);
      oldAbort.abort(); await old;
      expect(periodicWorkLimiter.waiting).toBe(0);
      expect(linker.due()).toBe(true);
      next = drain("new", nextAbort.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(periodicWorkLimiter.waiting).toBe(1);
      vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
        (args.at(-1) as Function)(null, "", ""); return {} as ReturnType<typeof execFile>;
      });
      release(); await busy; await vi.advanceTimersByTimeAsync(0);
      expect(execFile).toHaveBeenCalledExactlyOnceWith("pgrep", ["-f", "new"], expect.any(Object), expect.any(Function));
    } finally {
      oldAbort.abort(); nextAbort.abort(); release(); await busy; await vi.advanceTimersByTimeAsync(0);
      await old; await next;
    }
  });
  test("Codex 評価を取消すと既定プローブの枠待ちが消え、次の会話だけが起動する", async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), "codex-cancel-"));
    const linker = new CodexExecLinker({ home, claudeSessionsDir: join(home, "registry") });
    let release!: () => void;
    const busy = periodicWorkLimiter.run("busy", "background", () => new Promise<void>((resolve) => { release = resolve; }));
    const ac = new AbortController();
    const input = { calls: [{ toolUseId: "call", owner: "root", command: "codex exec -", cwd: home, startMs: Date.now(), endMs: null }], sessionAlive: true };
    let next: Promise<unknown> | undefined;
    try {
      const old = linker.evaluate({ ...input, sessionId: "old", signal: ac.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(periodicWorkLimiter.waiting).toBe(1);
      ac.abort();
      expect(periodicWorkLimiter.waiting).toBe(0);
      expect(linker.due()).toBe(true);
      next = linker.evaluate({ ...input, sessionId: "new" });
      await vi.advanceTimersByTimeAsync(0);
      expect(periodicWorkLimiter.waiting).toBe(1);
      expect(await old).toBeNull();
      vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
        (args.at(-1) as Function)(null, "", ""); return {} as ReturnType<typeof execFile>;
      });
      release(); await busy; await vi.advanceTimersByTimeAsync(0);
      expect(await next).toEqual([]);
      expect(execFile).toHaveBeenCalledExactlyOnceWith("pgrep", ["-f", "new"], expect.any(Object), expect.any(Function));
    } finally { ac.abort(); release(); await busy; await vi.advanceTimersByTimeAsync(0); await next; }
  });
  test("前面が連続して埋まっていても、2 秒待った背景を次の空き枠へ通す", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 2 });
    const start = Date.now();
    const front = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
    const busy = [limiter.run("busy-a", "foreground", front), limiter.run("busy-b", "foreground", front)];
    const background = vi.fn(async () => { expect(Date.now() - start).toBe(BACKGROUND_FAIR_WAIT_MS); });
    const pending = limiter.run("background", "background", background);
    const fronts = Array.from({ length: 60 }, (_, i) => limiter.run(`front:${i}`, "foreground", front));
    await vi.advanceTimersByTimeAsync(BACKGROUND_FAIR_WAIT_MS - 1);
    expect(background).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(background).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await Promise.all([...busy, ...fronts, pending]);
    expect(limiter.running).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  test("背景の待機期限は置換で延長せず、期限切れの作業を後から起動しない", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 2 });
    let release!: () => void;
    const busy = limiter.run("busy", "background", () => new Promise<void>((resolve) => { release = resolve; }));
    const task = vi.fn(async () => {});
    const old = limiter.run("probe", "background", task);
    const superseded = expect(old).rejects.toMatchObject({ reason: "superseded" });
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAIT_TIMEOUT_MS - 1);
    const latest = limiter.run("probe", "background", task);
    const expired = expect(latest).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([superseded, expired]);
    expect(task).not.toHaveBeenCalled();
    expect(limiter.waiting).toBe(0);
    release(); await busy;
    await vi.advanceTimersByTimeAsync(0);
    expect(task).not.toHaveBeenCalled();
    expect(limiter.running).toBe(0);
  });

  test("期限切れのプローブは子を起こさず、生存不明のエラーとして返す", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const busy = periodicWorkLimiter.run("busy", "background", () => new Promise<void>((resolve) => { release = resolve; }));
    const callback = vi.fn();
    probeExecFile("lsof", ["/fake"], { timeout: 1000 }, callback);
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAIT_TIMEOUT_MS);
    expect(execFile).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }), "", "");
    release(); await busy;
    await vi.advanceTimersByTimeAsync(0);
  });

  test("待機中のプローブを取消すと、枠が空いても子を起こさず生存不明を返す", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const busy = periodicWorkLimiter.run("busy", "background", () => new Promise<void>((resolve) => { release = resolve; }));
    const ac = new AbortController(), callback = vi.fn();
    probeExecFile("pgrep", ["-f", "session"], { timeout: 1000, signal: ac.signal }, callback);
    ac.abort(); await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ reason: "aborted" }), "", "");
    expect(periodicWorkLimiter.waiting).toBe(0);
    release(); await busy; await vi.advanceTimersByTimeAsync(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  test("期限時点で前面だった待ちも、背景になったら見送り、実行しない", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 1 });
    let release!: () => void;
    const busy = limiter.run("busy", "foreground", () => new Promise<void>((resolve) => { release = resolve; }));
    let foreground = true;
    const task = vi.fn(async () => {});
    const waiting = limiter.run("dynamic", () => foreground ? "foreground" : "background", task);
    const expired = expect(waiting).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAIT_TIMEOUT_MS);
    expect(limiter.waiting).toBe(1);
    foreground = false;
    await vi.advanceTimersByTimeAsync(BACKGROUND_FAIR_WAIT_MS);
    await expired;
    release(); await busy;
    expect(task).not.toHaveBeenCalled();
    expect(limiter.waiting).toBe(0);
  });
  test("短い作業は元の間隔、長い作業は 3 倍休み、上限で止まる", () => {
    expect(restAfterWorkMs(250, 20, 5000)).toBe(250);
    expect(restAfterWorkMs(250, 100, 5000)).toBe(300);
    expect(restAfterWorkMs(250, 2000, 5000)).toBe(5000);
    expect(restAfterWorkMs(1000, 5000, 10000)).toBe(10000);
    expect(restAfterWorkMs(6000, 0, 5000)).toBe(6000);
    // tail 内の別周期プローブも、完了から基本間隔以上を休む。
    expect(nextStartAtMs(1000, 1020, 250, 5000)).toBe(1270);
    expect(nextStartAtMs(1000, 1100, 250, 5000)).toBe(1400);
    expect(nextStartAtMs(1000, 4000, 250, 5000)).toBe(9000);
  });

  test("同時 2 件を超えず、空いた枠は前面を優先する", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 2 });
    const starts: string[] = [];
    let active = 0;
    let maximum = 0;
    const task = (key: string) => async () => {
      starts.push(key);
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
    };
    const tasks = [
      limiter.run("a", "background", task("a")),
      limiter.run("b", "background", task("b")),
      limiter.run("back", "background", task("back")),
      limiter.run("front", "foreground", task("front")),
    ];
    expect(starts).toEqual(["a", "front"]);
    expect(limiter.waiting).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toEqual(["a", "front", "b"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toEqual(["a", "front", "b", "back"]);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(tasks);
    expect(maximum).toBe(2);
    expect(limiter.running).toBe(0);
  });

  test("背景 2 件が来ても 1 件だけ起動し、前面は背景の完了を待たず開始する", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const at = Date.now();
    const background = (name: string) => periodicWorkLimiter.run(name, "background", async () => {
      starts.push(name);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    });
    const first = background("probe:1"), second = background("probe:2");
    expect(starts).toEqual(["probe:1"]);
    const foreground = periodicWorkLimiter.run("preview:front", "foreground", async () => {
      starts.push("front");
      expect(Date.now() - at).toBe(0);
    });
    await foreground;
    expect(starts).toEqual(["probe:1", "front"]);
    expect(periodicWorkLimiter.running).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([first, second]);
    expect(starts).toEqual(["probe:1", "front", "probe:2"]);
  });

  test("同じ key は重ならず、待ちは最新 1 件だけ、停止した待ちは実行しない", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 2 });
    const starts: string[] = [];
    const first = limiter.run("same", "background", async () => {
      starts.push("first");
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const old = limiter.run("same", "background", async () => { starts.push("old"); });
    const skipped = expect(old).rejects.toMatchObject({ reason: "superseded" });
    const latest = limiter.run("same", "foreground", async () => { starts.push("latest"); });
    const ac = new AbortController();
    const cancelled = limiter.run("same", "foreground", async () => { starts.push("cancelled"); }, ac.signal);
    const superseded = expect(latest).rejects.toBeInstanceOf(LoadShedSkippedError);
    const aborted = expect(cancelled).rejects.toMatchObject({ reason: "aborted" });
    ac.abort();
    const last = limiter.run("same", "background", async () => { starts.push("last"); });
    expect(limiter.waiting).toBe(1);
    expect(starts).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, last, skipped, superseded, aborted]);
    expect(starts).toEqual(["first", "last"]);
  });

  test("待機中の前面昇格を読み直し、失敗した作業も枠を返す", async () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter({ maxConcurrent: 1 });
    const starts: string[] = [];
    const busy = limiter.run("busy", "background", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("capture failed");
    });
    const failed = expect(busy).rejects.toThrow("capture failed");
    let foreground = false;
    const back = limiter.run("back", "background", async () => { starts.push("back"); });
    const promoted = limiter.run("promoted", () => foreground ? "foreground" : "background", async () => {
      starts.push("promoted");
    });
    foreground = true;
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([failed, back, promoted]);
    expect(starts).toEqual(["promoted", "back"]);
    expect(limiter.running).toBe(0);
  });

  test("定期プローブも画面取得と同じ枠を使い、同じコマンドの古い待ちは生存不明にする", async () => {
    vi.useFakeTimers();
    const screen1 = periodicWorkLimiter.run("preview:a", "foreground", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const screen2 = periodicWorkLimiter.run("preview:b", "foreground", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const old = vi.fn();
    const latest = vi.fn();
    probeExecFile("lsof", ["-t", "--", "/fake/output"], { timeout: 10000 }, old);
    probeExecFile("lsof", ["-t", "--", "/fake/output"], { timeout: 10000 }, latest);
    await vi.advanceTimersByTimeAsync(0);
    expect(execFile).not.toHaveBeenCalled();
    expect(old).toHaveBeenCalledWith(expect.any(LoadShedSkippedError), "", "");
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      (args[3] as (error: null, stdout: string, stderr: string) => void)(null, "123\n", "");
      return {} as ReturnType<typeof execFile>;
    });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([screen1, screen2]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(null, "123\n", "");
    expect(periodicWorkLimiter.running).toBe(0);
  });
});
