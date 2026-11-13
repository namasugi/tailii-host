import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as daemonClient from "../src/hub/hubDaemonClient.js";
import { connectHubSocket } from "../src/hub/hubClient.js";
import * as path from "node:path";
import type { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHubDaemon, ensureHubDaemonAsync } from "../src/hub/hubDaemonClient.js";
import { readPackageVersion } from "../src/shared/version.js";
import { makeTempDir } from "./helpers.js";

vi.mock("node:net", async (original) => ({
  ...await original<typeof import("node:net")>(), connect: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });
function setup(version: string | null = "old") {
  const dir = makeTempDir("hub-client"); const lockPath = path.join(dir, "hub.lock");
  const pid = 123456;
  fs.writeFileSync(lockPath, JSON.stringify({ pid, version }));
  const unref = vi.fn(); const spawnImpl = vi.fn(() => ({ unref }));
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const options = { lockPath, cliPath: "/test/cli.js", logPath: path.join(dir, "hub.log"), spawnImpl: spawnImpl as unknown as typeof spawn };
  return { pid, options, spawnImpl, kill, unref };
}

it("実体確認が保留の間は呼び手を止めず、SIGTERM も spawn もしない", async () => {
  const s = setup(); let finish!: (value: "hub") => void;
  const classifyProcess = () => new Promise<"hub">((resolve) => { finish = resolve; });
  const pending = ensureHubDaemonAsync({ ...s.options, classifyProcess });
  expect(s.kill.mock.calls.filter((c) => c[1] === "SIGTERM")).toEqual([]);
  expect(s.spawnImpl).not.toHaveBeenCalled();
  let otherWork = false; await Promise.resolve().then(() => { otherWork = true; });
  expect(otherWork).toBe(true);
  finish("hub"); await pending;
  expect(s.kill).toHaveBeenCalledWith(s.pid, "SIGTERM");
  expect(s.spawnImpl.mock.invocationCallOrder[0]).toBeGreaterThan(s.kill.mock.invocationCallOrder.at(-1)!);
  expect(s.unref).toHaveBeenCalledOnce();
});
it("実体が hub で同一版なら起動を抑止する", async () => {
  const s = setup(readPackageVersion());
  await ensureHubDaemonAsync({ ...s.options, classifyProcess: async () => "hub" });
  expect(s.spawnImpl).not.toHaveBeenCalled();
  expect(s.kill.mock.calls.filter((c) => c[1] === "SIGTERM")).toEqual([]);
});
it.each(["other", "unknown", "gone"] as const)("実体が %s なら終了要求を送らず排他に決着を任せる", async (identity) => {
  const s = setup();
  await ensureHubDaemonAsync({ ...s.options, classifyProcess: async () => identity });
  expect(s.kill.mock.calls.filter((c) => c[1] === "SIGTERM")).toEqual([]);
  expect(s.spawnImpl).toHaveBeenCalledOnce();
});
it.each([123457, 123456])("実体確認中の lock 所有者・版の変更に古い確認結果を適用しない: %s", async (pid) => {
  const s = setup();
  await ensureHubDaemonAsync({ ...s.options, classifyProcess: async () => {
    fs.writeFileSync(s.options.lockPath, JSON.stringify({ pid, version: "new-owner" }));
    return "hub";
  } });
  expect(s.kill.mock.calls.filter((c) => c[1] === "SIGTERM")).toEqual([]);
  expect(s.spawnImpl).toHaveBeenCalledOnce();
});
it("同期 API は従来どおり同じ呼び出し中に版違いを入れ替える", () => {
  const s = setup();
  ensureHubDaemon({ ...s.options, classifyProcess: () => "hub" });
  expect(s.kill).toHaveBeenCalledWith(s.pid, "SIGTERM");
  expect(s.spawnImpl).toHaveBeenCalledOnce();
});
it.each([false, true])("hook / engine の起動保証は子へ TMUX と GW の印を渡さない: async=%s", async (asyncMode) => {
  const s = setup(); vi.stubEnv("TMUX", "outer"); vi.stubEnv("TMUX_PANE", "%1");
  vi.stubEnv("TAILII_HUB_VIA_GATEWAY", "1");
  try {
    if (asyncMode) await ensureHubDaemonAsync({ ...s.options, classifyProcess: async () => "other" });
    else ensureHubDaemon({ ...s.options, classifyProcess: () => "other" });
    const env = (s.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(env.TMUX).toBeUndefined(); expect(env.TMUX_PANE).toBeUndefined();
    expect(env.TAILII_HUB_VIA_GATEWAY).toBeUndefined();
    expect(env.HOME).toBe(process.env.HOME);
  } finally { vi.unstubAllEnvs(); }
});

// 接続エラーの単体検証。実ソケット・遅い ps は hubDaemonClientProcess.test.ts で確認する。
function rejectConnections() {
  vi.mocked(net.connect).mockImplementation(() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = vi.fn(() => socket);
    queueMicrotask(() => { socket.emit("error", new Error("ECONNREFUSED")); socket.emit("close"); });
    return socket;
  });
}

it("接続失敗は close 完了後に通知し、起動保証を重複抑止した失敗も数える", async () => {
  vi.useFakeTimers();
  const sockets: EventEmitter[] = [];
  vi.mocked(net.connect).mockImplementation(() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = vi.fn(() => socket);
    sockets.push(socket);
    return socket;
  });
  let finish!: () => void;
  const ensureDaemon = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onConnectionFailure = vi.fn();
  const link = connectHubSocket({ socketPath: "/unused", ensureDaemon, onConnectionFailure });
  try {
    const first = new Error("first connection failed"), second = new Error("retry failed");
    sockets[0]!.emit("error", first);
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureDaemon).toHaveBeenCalledOnce();
    expect(onConnectionFailure).not.toHaveBeenCalled();
    sockets[0]!.emit("close");
    expect(onConnectionFailure.mock.calls).toEqual([[first]]);
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("error", second);
    expect(onConnectionFailure).toHaveBeenCalledOnce();
    sockets[1]!.emit("close");
    expect(onConnectionFailure.mock.calls).toEqual([[first], [second]]);
    expect(ensureDaemon).toHaveBeenCalledOnce();
  } finally { link.close(); finish?.(); }
});

it("接続エラー時の非同期起動保証が遅くても他の処理が進み、重ねて実行しない", async () => {
  vi.useFakeTimers(); rejectConnections();
  let finish!: () => void;
  vi.spyOn(daemonClient, "ensureHubDaemonAsync").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const link = connectHubSocket({ socketPath: "/unused" });
  try {
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    await vi.advanceTimersByTimeAsync(2_000);
    clearInterval(timer);
    expect(ticks).toBe(200);
    expect(net.connect).toHaveBeenCalledTimes(4);
    expect(ensureHubDaemonAsync).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ensureHubDaemonAsync).toHaveBeenCalledTimes(2);
  } finally { link.close(); finish?.(); }
});

it("起動保証の失敗を接続ループへ漏らさず、次のエラーで再試行する", async () => {
  vi.useFakeTimers(); rejectConnections();
  vi.spyOn(daemonClient, "ensureHubDaemonAsync").mockRejectedValue(new Error("ps failed"));
  const link = connectHubSocket({ socketPath: "/unused" });
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(ensureHubDaemonAsync).toHaveBeenCalledTimes(2);
  } finally { link.close(); }
});
