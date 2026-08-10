// codexAppServerHandshake.test.ts — 応答しない app-server に対する handshake の打ち切り。
//
// UNIX socket は listen backlog がある限りカーネルが接続を受理するため、app-server が
// 「死んだ」のではなく「刺さった」場合は WebSocket の open も error も発火しない。期限が
// 無いと、これを直列 await する engine の read loop と hub の tick が同時に止まる。
//
// さらに: 打ち切りの `terminate()` は CONNECTING 中の abortHandshake 経由で次 tick に
// "error" を emit する。リスナー不在の EventEmitter "error" は throw になるため、
// 「刺さった app-server を検出した瞬間に host プロセスが落ちる」という最悪の退行になりうる。
// このテストは reject するだけでなく、その後もプロセスが生き残ることを固定する
// （uncaughtException が起きれば vitest が unhandled error として落とす）。

import { afterEach, describe, expect, test } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import { CodexAppServerManager } from "../src/codex/codexAppServer.js";
import { makeTempDir } from "./helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let server: net.Server | null = null;
let accepted: net.Socket[] = [];

afterEach(async () => {
  const current = server;
  const sockets = accepted;
  server = null;
  accepted = [];
  // 応答を返さない設計なので接続が残る。破棄しないと close() が完了しない。
  for (const socket of sockets) socket.destroy();
  if (current !== null) await new Promise<void>((resolve) => current.close(() => resolve()));
});

/** accept はするが Upgrade 応答を返さない = 応答不能な app-server。 */
async function startWedgedSocket(): Promise<string> {
  const socketPath = path.join(makeTempDir("codex-handshake"), "wedged.sock");
  const created = net.createServer((socket) => { accepted.push(socket); });
  server = created;
  await new Promise<void>((resolve) => created.listen(socketPath, () => resolve()));
  return socketPath;
}

describe("Codex App Server handshake", () => {
  test("応答しない app-server は有限時間で諦め、プロセスを落とさない", async () => {
    const socketPath = await startWedgedSocket();
    const manager = new CodexAppServerManager({ socketPath });

    const started = Date.now();
    const connection = await manager.connectIfRunning(400);
    const elapsed = Date.now() - started;

    expect(connection).toBeNull();
    // 即失敗ではなく「期限まで待って打ち切った」ことを確かめる（テストの空振り防止）。
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5_000);

    // terminate 由来の "error" は次 tick 以降に届く。捨て先が無いと uncaughtException になる。
    await sleep(300);
  });

  test("socket が存在しなければ即 null（従来どおり）", async () => {
    const manager = new CodexAppServerManager({
      socketPath: path.join(makeTempDir("codex-handshake-missing"), "absent.sock"),
    });
    expect(await manager.connectIfRunning(400)).toBeNull();
  });
});
