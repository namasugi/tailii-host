import { spawn, type SpawnOptions } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { defaultHerdrPath, envWithoutTmux, HERDR_TAILII_SESSION, isValidHerdrSessionName } from "../backend/herdr.js";
import { sleep } from "../shared/sleep.js";
import { resolveHubSpawnSocketPath } from "../shared/socketPath.js";
import { isSocketAlive } from "./hubStartup.js";

const MAX_LINE_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 1_000;
const SPAWN_DEDUP_MS = 5_000;

type SpawnReply =
  | { ok: true; pid?: number }
  | { ok: false; reason: "bad-request" | "not-screen-login" | "spawn-failed" };

/** 改行までの最初の 1 行だけを、バイト数と時間を制限して読む。 */
function readLine(socket: Socket, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const buffer = Buffer.alloc(MAX_LINE_BYTES);
    let bytes = 0;
    const timer = setTimeout(incomplete, timeoutMs);
    socket.once("end", incomplete);
    socket.once("close", incomplete);
    socket.once("error", incomplete);
    socket.on("data", onData);

    function incomplete(): void { finish(null); }
    function finish(line: string | null): void {
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(line);
    }
    function onData(chunk: Buffer): void {
      const newline = chunk.indexOf(0x0a);
      const length = newline < 0 ? chunk.length : newline;
      if (bytes + length > buffer.length) return incomplete();
      chunk.copy(buffer, bytes, 0, length);
      bytes += length;
      if (newline >= 0) finish(buffer.toString("utf8", 0, bytes));
    }
  });
}

function parseSpawnSession(line: string | null): string | null {
  if (line === null) return null;
  try {
    const request = JSON.parse(line) as { spawn?: unknown; session?: unknown } | null;
    if (request?.spawn !== "herdr-server" || Object.keys(request).some((key) => key !== "spawn" && key !== "session")) {
      return null;
    }
    if (!Object.hasOwn(request, "session")) return HERDR_TAILII_SESSION;
    return typeof request.session === "string" && isValidHerdrSessionName(request.session) ? request.session : null;
  } catch {
    return null;
  }
}

function spawnDetached(executable: string, args: string[], options: SpawnOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid!); // spawn が通知された子には pid がある。
    });
  });
}

export interface HerdrServerSpawnListener {
  close(): Promise<void>;
}

/** デスクトップ側のログインにいる hub が、指定された herdr サーバーを起こす。 */
export async function startHerdrServerSpawnSocket(options: {
  screenLogin: boolean;
  socketPath?: string;
  spawnDetached?: typeof spawnDetached;
  now?: () => number;
}): Promise<HerdrServerSpawnListener | null> {
  const socketPath = options.socketPath ?? resolveHubSpawnSocketPath();
  if (await isSocketAlive(socketPath)) return null;
  rmSync(socketPath, { force: true });

  const now = options.now ?? (() => performance.now());
  const recentSpawns = new Map<string, number>();
  const pendingSpawns = new Map<string, Promise<SpawnReply>>();
  async function startServer(session: string): Promise<SpawnReply> {
    if (!options.screenLogin) return { ok: false, reason: "not-screen-login" };
    const cutoff = now() - SPAWN_DEDUP_MS;
    for (const [name, at] of recentSpawns) {
      if (at <= cutoff) recentSpawns.delete(name);
    }
    if (recentSpawns.has(session)) return { ok: true };
    const pending = pendingSpawns.get(session);
    if (pending !== undefined) {
      const reply = await pending;
      return reply.ok ? { ok: true } : reply;
    }
    // 同じセッション宛ての依頼は、先に始めた起動の成否を待つ。
    const starting = Promise.resolve().then(async (): Promise<SpawnReply> => {
      try {
        const pid = await (options.spawnDetached ?? spawnDetached)(
          defaultHerdrPath(), ["--session", session, "server"],
          { detached: true, stdio: "ignore", env: envWithoutTmux(process.env) },
        );
        recentSpawns.set(session, now());
        return { ok: true, pid };
      } catch {
        return { ok: false, reason: "spawn-failed" };
      }
    }).finally(() => { pendingSpawns.delete(session); });
    pendingSpawns.set(session, starting);
    return starting;
  }

  const clients = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, async (socket) => {
    socket.on("error", () => {});
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    const session = parseSpawnSession(await readLine(socket, REQUEST_TIMEOUT_MS));
    if (socket.destroyed) return;
    const reply: SpawnReply = session === null
      ? { ok: false, reason: "bad-request" } : await startServer(session);
    if (socket.destroyed) return;
    socket.end(JSON.stringify(reply) + "\n");
    socket.destroySoon();
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= new Promise<void>((resolve, reject) => {
      for (const client of clients) client.destroy();
      // Node は listen で作成したソケットファイルも close で取り除く。
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return { close };
}

export type HerdrServerSpawnResult = "started" | "refused" | "unavailable";

/** hub の起動中は接続を取り直す。接続できたら 1 回の依頼と応答で終える。 */
export async function requestHerdrServerSpawn(session: string, options: {
  socketPath?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
} = {}): Promise<HerdrServerSpawnResult> {
  try {
    const socketPath = options.socketPath ?? resolveHubSpawnSocketPath();
    const request = JSON.stringify(session === HERDR_TAILII_SESSION
      ? { spawn: "herdr-server" } : { spawn: "herdr-server", session }) + "\n";
    const deadline = performance.now() + (options.timeoutMs ?? 3_000);
    for (let remaining = deadline - performance.now(); remaining > 0; remaining = deadline - performance.now()) {
      const socket = createConnection(socketPath);
      socket.on("error", () => {});
      let connected = false;
      socket.once("connect", () => {
        connected = true;
        socket.write(request);
      });
      const line = await readLine(socket, remaining);
      socket.destroy();
      if (connected) {
        if (line === null) return "unavailable";
        const reply = JSON.parse(line) as { ok?: unknown } | null;
        if (reply?.ok === true) return "started";
        if (reply?.ok === false) return "refused";
        return "unavailable";
      }
      const wait = Math.min(options.retryIntervalMs ?? 100, deadline - performance.now());
      if (wait <= 0) break;
      await sleep(wait);
    }
  } catch { /* パスや応答を読めない場合は従来の起動へ戻す。 */ }
  return "unavailable";
}
