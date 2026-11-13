// Unix ソケットを実際に待ち受けるため sandbox 外で実行する。
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { delegateHubToGateway } from "../src/hub/gatewaySpawn.js";
import { shimContent } from "../src/commands/doctor.js";

function shimOptions(dir: string) {
  const cliPath = join(dir, "cli.js"), shimPath = join(dir, "tailii-host");
  writeFileSync(cliPath, "// fixture\n"); writeFileSync(shimPath, shimContent(process.execPath, cliPath));
  return { cliPath, shimPath };
}

let directory: string | undefined;
let server: Server | undefined;
const clients = new Set<Socket>();
afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
async function fake(reply?: string) {
  // macOS の sockaddr_un に収まる短い名前。
  directory = mkdtempSync(join(tmpdir(), "tgs-"));
  const socketPath = join(directory, "g.sock");
  const requests: string[] = [];
  server = createServer((socket) => {
    clients.add(socket); socket.on("close", () => clients.delete(socket));
    socket.on("data", (chunk) => { requests.push(String(chunk)); if (reply !== undefined) socket.end(reply); });
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socketPath, resolve); });
  return { socketPath, ...shimOptions(directory), platform: "darwin" as const, env: {}, hasConfirmedHub: () => true, requests };
}
it.each([null, 123456])("ACK の pid=%s を後継 hub の確認へ渡してから gateway へ移る", async (pid) => {
  const options = await fake(JSON.stringify({ ok: true, ...(pid === null ? {} : { pid }) }) + "\n");
  let received: number | null | undefined;
  expect(await delegateHubToGateway({ ...options, hasConfirmedHub: (expectedPid) => {
    received = expectedPid; return true;
  } })).toBe(true);
  expect(received).toBe(pid);
  expect(options.requests).toEqual(['{"spawn":"hub"}\n']);
});
it.each(['{"ok":false}\n', 'oops\n', '{"ok":1}\n', '', '{"ok":true}'])("失敗応答・不完全な応答では自分が hub になる: %s", async (reply) => {
  expect(await delegateHubToGateway(await fake(reply))).toBe(false);
});
it("ソケットなしでは自分が hub になる", async () => {
  directory = mkdtempSync(join(tmpdir(), "tgs-"));
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, ...shimOptions(directory), socketPath: join(directory, "missing") })).toBe(false);
});
it("接続後の時間切れでは自分が hub になる", async () => {
  const options = await fake();
  const at = Date.now();
  expect(await delegateHubToGateway({ ...options, timeoutMs: 80 })).toBe(false);
  expect(Date.now() - at).toBeLessThan(1_000);
});
it.each([{ platform: "linux" as const, env: {} }, { platform: "darwin" as const, env: { TAILII_HUB_VIA_GATEWAY: "1" } }])("印あり・darwin 以外は socket へ接続しない", async (guard) => {
  const options = await fake('{"ok":true}\n');
  expect(await delegateHubToGateway({ ...options, ...guard })).toBe(false);
  expect(options.requests).toEqual([]);
});

it("ACK 後に後継 hub が立たなければ自分が hub になる", async () => {
  const options = await fake('{"ok":true}\n');
  expect(await delegateHubToGateway({ ...options, hasConfirmedHub: () => false, hubWaitMs: 80 })).toBe(false);
  expect(options.requests).toEqual(['{"spawn":"hub"}\n']);
});

it.each([false, true])("FIFO またはその symlink のシムでも待たずに自己起動へ戻る: symlink=%s", (symlink) => {
  directory = mkdtempSync(join(tmpdir(), "tgf-"));
  const options = shimOptions(directory), fifo = join(directory, "fifo");
  execFileSync("mkfifo", [fifo]);
  if (symlink) { unlinkSync(options.shimPath); symlinkSync(fifo, options.shimPath); }
  else options.shimPath = fifo;
  const module = pathToFileURL(fileURLToPath(new URL("../dist/hub/gatewaySpawn.js", import.meta.url))).href;
  // 退行時に同期 read で固まっても、テスト自身は child の期限で停止できる。
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { delegateHubToGateway } from ${JSON.stringify(module)};
    console.log(await delegateHubToGateway(${JSON.stringify({ ...options, platform: "darwin", env: {} })}));
  `], { encoding: "utf8", timeout: 3000, env: process.env });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("false");
  expect(result.stderr).toContain("通常ファイルではない");
});
