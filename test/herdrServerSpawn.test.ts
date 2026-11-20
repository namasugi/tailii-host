import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultHerdrPath } from "../src/backend/herdr.js";
import { requestHerdrServerSpawn, startHerdrServerSpawnSocket } from "../src/hub/herdrServerSpawn.js";
import { sleep } from "../src/shared/sleep.js";
import { resolveHubSpawnSocketPath } from "../src/shared/socketPath.js";
import { connectUnixClient, SocketLineReader, startListener } from "./socketHelpers.js";

const request = '{"spawn":"herdr-server"}';
let directory: string;
let socketPath: string;
let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ths-"));
  socketPath = resolveHubSpawnSocketPath(join(directory, "run"));
});

afterEach(async () => {
  try { await cleanup?.(); } finally {
    cleanup = undefined;
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function listen(options: Partial<Parameters<typeof startHerdrServerSpawnSocket>[0]> = {}) {
  const spawnDetached = vi.fn().mockResolvedValue(41);
  const server = await startHerdrServerSpawnSocket({ socketPath, screenLogin: true, spawnDetached, ...options });
  if (server === null) throw new Error("新しい起動口が listen できませんでした");
  cleanup = () => server.close();
  return { server, spawnDetached };
}

async function sendRaw(input: string) {
  const socket = await connectUnixClient(socketPath);
  const reader = new SocketLineReader(socket);
  try {
    socket.end(input);
    const reply = JSON.parse(await reader.nextLine(2_000));
    await reader.waitForEOF(2_000);
    return reply;
  } finally { socket.destroy(); }
}

it("固定の依頼を受け、既定パスの tailii サーバーを環境から TMUX を外して起動する", async () => {
  vi.stubEnv("TMUX", "外側のソケット");
  vi.stubEnv("TMUX_PANE", "%17");
  const { spawnDetached } = await listen();
  expect(socketPath).toBe(join(directory, "run", "hub-spawn.sock"));
  expect(statSync(join(directory, "run")).mode & 0o777).toBe(0o700);
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  const padding = " ".repeat(4096 - Buffer.byteLength(request));
  expect(await sendRaw(`${padding}${request}\n${request}\n`)).toEqual({ ok: true, pid: 41 });
  expect(spawnDetached).toHaveBeenCalledExactlyOnceWith(defaultHerdrPath(), ["--session", "tailii", "server"], {
    detached: true, stdio: "ignore", env: expect.objectContaining({ HOME: process.env.HOME }),
  });
  const env = spawnDetached.mock.calls[0]?.[2].env;
  expect(env).not.toHaveProperty("TMUX");
  expect(env).not.toHaveProperty("TMUX_PANE");
});

it("別の依頼、余分な項目、壊れた JSON、未完の行、4096 バイト超を断る", async () => {
  const { spawnDetached } = await listen();
  for (const line of [
    '{"spawn":"hub"}\n',
    '{"spawn":"herdr-server","session":"default","path":"/opt/bin/herdr"}\n',
    '{"spawn":\n',
    'null\n',
    request,
    `${" ".repeat(4097 - Buffer.byteLength(request))}${request}\n`,
  ]) {
    expect(await sendRaw(line)).toEqual({ ok: false, reason: "bad-request" });
  }
  expect(spawnDetached).not.toHaveBeenCalled();
});

it("改行が届かない接続は約 1 秒で断って閉じる", async () => {
  const { spawnDetached } = await listen();
  const socket = await connectUnixClient(socketPath);
  const reader = new SocketLineReader(socket);
  try {
    const start = performance.now();
    socket.write(request);
    expect(JSON.parse(await reader.nextLine(2_000))).toEqual({ ok: false, reason: "bad-request" });
    expect(performance.now() - start).toBeGreaterThanOrEqual(850);
    await reader.waitForEOF(1_000);
    expect(spawnDetached).not.toHaveBeenCalled();
  } finally { socket.destroy(); }
});

it("画面のログイン以外の hub は起動せずに断り、クライアントは再試行しない", async () => {
  const { spawnDetached } = await listen({ screenLogin: false });
  expect(await sendRaw(request + "\n")).toEqual({ ok: false, reason: "not-screen-login" });
  const start = performance.now();
  expect(await requestHerdrServerSpawn({ socketPath, timeoutMs: 2_000 })).toBe("refused");
  expect(performance.now() - start).toBeLessThan(1_000);
  expect(spawnDetached).not.toHaveBeenCalled();
});

it("起動に失敗したときは断り、次の依頼で起動を試せる", async () => {
  const spawnDetached = vi.fn().mockRejectedValueOnce(new Error("起動失敗")).mockResolvedValueOnce(41);
  await listen({ spawnDetached });
  expect(await sendRaw(request + "\n")).toEqual({ ok: false, reason: "spawn-failed" });
  expect(await requestHerdrServerSpawn({ socketPath })).toBe("started");
  expect(spawnDetached).toHaveBeenCalledTimes(2);
});

it("依頼を送った接続が応答前に切れても、次の依頼に答える", async () => {
  const spawnResult = Promise.withResolvers<number>();
  const spawnDetached = vi.fn(() => spawnResult.promise);
  await listen({ spawnDetached });
  const socket = await connectUnixClient(socketPath);
  try {
    socket.write(request + "\n");
    await vi.waitFor(() => expect(spawnDetached).toHaveBeenCalledTimes(1));
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
    spawnResult.resolve(41);
    expect(await requestHerdrServerSpawn({ socketPath })).toBe("started");
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  } finally {
    socket.destroy();
    spawnResult.resolve(41);
  }
});

it("並行した依頼と直前 5 秒以内の依頼では同じ起動を使う", async () => {
  let now = 0;
  const spawnDetached = vi.fn(async () => { await sleep(30); return 41; });
  await listen({ now: () => now, spawnDetached });
  const replies = await Promise.all([sendRaw(request + "\n"), sendRaw(request + "\n")]);
  expect(replies).toEqual(expect.arrayContaining([{ ok: true, pid: 41 }, { ok: true }]));
  now = 4_999;
  expect(await sendRaw(request + "\n")).toEqual({ ok: true });
  expect(spawnDetached).toHaveBeenCalledTimes(1);
  now = 5_001;
  expect(await sendRaw(request + "\n")).toEqual({ ok: true, pid: 41 });
  expect(spawnDetached).toHaveBeenCalledTimes(2);
});

it("生きているソケットは引き継がず、close で接続とファイルを閉じる", async () => {
  const { server } = await listen();
  expect(await startHerdrServerSpawnSocket({ socketPath, screenLogin: false })).toBeNull();
  expect(await requestHerdrServerSpawn({ socketPath })).toBe("started");
  const socket = await connectUnixClient(socketPath);
  try {
    const reader = new SocketLineReader(socket);
    await server.close();
    await reader.waitForEOF(1_000);
    expect(existsSync(socketPath)).toBe(false);
  } finally { socket.destroy(); }
});

it("停止したプロセスが残したソケットを取り除いて listen する", async () => {
  const child = spawnSync(process.execPath, ["-e", `
    require("node:net").createServer().listen(process.argv[1], () => process.exit(0));
  `, socketPath], { encoding: "utf8", timeout: 2_000 });
  expect(child.status, child.stderr).toBe(0);
  expect(statSync(socketPath).isSocket()).toBe(true);
  await listen();
  expect(await requestHerdrServerSpawn({ socketPath })).toBe("started");
});

it("クライアントは最初にソケットが無くても listen 開始までつなぎ直す", async () => {
  const pending = requestHerdrServerSpawn({ socketPath, timeoutMs: 1_000, retryIntervalMs: 20 });
  await sleep(70);
  await listen();
  expect(await pending).toBe("started");
});

it("接続できないときは合計の上限まで待って unavailable を返す", async () => {
  const start = performance.now();
  expect(await requestHerdrServerSpawn({ socketPath, timeoutMs: 120, retryIntervalMs: 20 })).toBe("unavailable");
  const elapsed = performance.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(100);
  expect(elapsed).toBeLessThan(1_000);
});

it.each([undefined, "?\n"])("応答が読めなければ期限内に unavailable を返す（応答 %j）", async (reply) => {
  const fake = await startListener(socketPath);
  cleanup = () => fake.close();
  const start = performance.now();
  const pending = requestHerdrServerSpawn({ socketPath, timeoutMs: 150, retryIntervalMs: 20 });
  const socket = await fake.nextConnection(1_000);
  const reader = new SocketLineReader(socket);
  expect(await reader.nextLine(1_000)).toBe(request);
  if (reply !== undefined) socket.end(reply);
  expect(await pending).toBe("unavailable");
  const elapsed = performance.now() - start;
  if (reply === undefined) expect(elapsed).toBeGreaterThanOrEqual(130);
  expect(elapsed).toBeLessThan(1_000);
});
