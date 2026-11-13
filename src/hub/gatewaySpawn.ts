// gatewaySpawn.ts — hub の排他を取る前に、ゲートウェイの系統での起動を依頼する。
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { constants, promises as fs, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultHubLockPath, readHubLock, pidAlive } from "./hubDaemonClient.js";
import { classifyHubProcessAsync } from "./hubStartup.js";
import { readPackageVersion } from "../shared/version.js";

export interface GatewaySpawnOptions {
  args?: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  hubWaitMs?: number;
  pollIntervalMs?: number;
  lockPath?: string;
  shimPath?: string;
  cliPath?: string;
  shimReadTimeoutMs?: number;
  log?: (message: string) => void;
  hasConfirmedHub?: (expectedPid: number | null) => boolean | "version-mismatch" | Promise<boolean | "version-mismatch">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_SHIM_BYTES = 64 * 1024;

/** 展開を含まない単独の絶対パスだけを読む。シェルとして評価・実行しない。 */
function literalShimPath(word: string): string | null {
  let value: string;
  if (/^'[^'$`\r\n]*'$/.test(word)) value = word.slice(1, -1);
  else if (/^"(?:[^"$`\\\r\n]|\\[^$`\r\n])*"$/.test(word)) {
    // 二重引用符内では、引用符とバックスラッシュに対するエスケープだけを外す。
    value = word.slice(1, -1).replace(/\\(["\\])/g, "$1");
  } else if (/^\/[^\s"'$`\\;&|<>(){}\[\]*?~#]*$/.test(word)) value = word;
  else return null;
  return value.startsWith("/") ? value : null;
}

/** setup の固定形式と、単純なパス代入 + exec だけの手動シムを読む。 */
function shimCliPath(text: string): string | null {
  if (text.includes("\0")) return null;
  const [header, ...lines] = text.split("\n");
  if (!/^#!(?:\/bin\/(?:sh|bash)|\/usr\/bin\/env (?:sh|bash))$/.test(header ?? "")) return null;
  const statements = lines.map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((line) => line !== "" && !line.startsWith("#"));
  const execLine = statements.pop();
  if (execLine === undefined) return null;
  const variables = new Map<string, string>();
  for (const statement of statements) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(statement);
    if (assignment === null || variables.has(assignment[1]!)) return null;
    const value = literalShimPath(assignment[2]!);
    if (value === null) return null;
    variables.set(assignment[1]!, value);
  }
  // 単独の語を 2 個と "$@" だけ許す。連結した引用符・リダイレクト・追加コマンドは許さない。
  const word = String.raw`(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|'[^'\r\n]*'|[^ \t]+)`;
  const command = new RegExp(`^exec[ \\t]+(${word})[ \\t]+(${word})[ \\t]+"\\$@"$`).exec(execLine);
  if (command === null) return null;
  const resolve = (argument: string): string | null => {
    const reference = /^"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(argument);
    return reference === null ? literalShimPath(argument) : variables.get(reference[1]!) ?? null;
  };
  if (resolve(command[1]!) === null) return null;
  return resolve(command[2]!);
}

async function readShim(shimPath: string): Promise<{ text: string } | { reason: string }> {
  try {
    // FIFO への差し替えも open で待たない。開いた fd 自体を調べ、通常ファイルだけを読む。
    const file = await fs.open(shimPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { reason: "シムが通常ファイルではない" };
      if (stat.size > MAX_SHIM_BYTES) return { reason: "シムのサイズが 64KiB を超える" };
      const buffer = Buffer.alloc(MAX_SHIM_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_SHIM_BYTES) return { reason: "シムのサイズが 64KiB を超える" };
      return { text: buffer.subarray(0, bytesRead).toString("utf8") };
    } finally { await file.close(); }
  } catch { return { reason: "シムを読めない" }; }
}

/** ACK と現行版の後継 hub の生存が確認できたときだけ true。接続不能・版違い・時間切れは自己起動へ戻す。 */
export async function delegateHubToGateway(options: GatewaySpawnOptions = {}): Promise<boolean> {
  if ((options.args?.length ?? 0) > 0 || (options.platform ?? process.platform) !== "darwin" ||
      (options.env ?? process.env)["TAILII_HUB_VIA_GATEWAY"] === "1") return false;
  const shimPath = options.shimPath ?? join(homedir(), ".local", "bin", "tailii-host");
  let reason: string | null = null;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // setup の固定形式と、単純な手動シムだけを読む。シェルとして評価・実行しない。
    const result = await Promise.race([
      readShim(shimPath),
      new Promise<{ reason: string }>((resolve) => {
        readTimer = setTimeout(() => resolve({ reason: "シムの読み取りが時間切れ" }), options.shimReadTimeoutMs ?? 300);
      }),
    ]);
    if ("reason" in result) {
      reason = result.reason;
    } else {
      const target = shimCliPath(result.text);
      if (target === null) reason = "シムの生成形式を確認できない";
      else if (realpathSync(target) !== realpathSync(options.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url)))) {
        reason = "シムが別の cli.js を指している";
      }
    }
  } catch { reason = "シムまたは cli.js の実体を読めない"; }
  finally { clearTimeout(readTimer); }
  if (reason !== null) {
    (options.log ?? ((message) => process.stderr.write(`[tailii-hub] ${message}\n`)))(`GW への hub 移動を見送る: ${reason} (${shimPath})`);
    return false;
  }
  const acknowledged = await new Promise<{ pid: number | null } | null>((resolve) => {
    const socket = createConnection(options.socketPath ?? join(homedir(), ".tailii", "run", "gw-spawn.sock"));
    let done = false;
    let input = "";
    const connectTimer = setTimeout(() => finish(null), options.connectTimeoutMs ?? 300);
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 1_000);
    function finish(ack: { pid: number | null } | null): void {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(timer);
      socket.destroy();
      resolve(ack);
    }
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      socket.write('{"spawn":"hub"}\n');
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 4096) return finish(null);
      const end = input.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(input.slice(0, end));
        finish(reply?.ok === true ? {
          pid: Number.isSafeInteger(reply.pid) && reply.pid > 0 ? reply.pid : null,
        } : null);
      } catch { finish(null); }
    });
  }).catch(() => null);
  if (!acknowledged) return false;
  const hasConfirmedHub = options.hasConfirmedHub ?? (async (expectedPid: number | null) => {
    const lockPath = options.lockPath ?? defaultHubLockPath();
    const lock = readHubLock(lockPath);
    if (lock === null || lock.pid === process.pid) return false;
    const version = readPackageVersion();
    if (lock.pid === expectedPid) {
      // GW が起こした pid 自体なので ps は省く。依頼中の更新にも備えて版は再確認する。
      // 版違いなら待たずに自己起動側へ戻し、移動成功としては終了しない。
      if (version === null || lock.version !== version) return "version-mismatch" as const;
      return pidAlive(lock.pid);
    }
    // 重複要求で起動した子が排他を取れない場合や、pid の無い旧 GW は現行版の実体も確かめる。
    if (!pidAlive(lock.pid) || version === null || lock.version !== version || await classifyHubProcessAsync(lock.pid) !== "hub") return false;
    const current = readHubLock(lockPath);
    return current?.pid === lock.pid && current.version === version && pidAlive(lock.pid);
  });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.hubWaitMs ?? 5_000);
  for (;;) {
    // ps の確認中にも期限を守る。遅れて返った結果は採用しない。
    const remainingForCheck = deadline - now();
    if (remainingForCheck <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const confirmed = await Promise.race([
        Promise.resolve().then(() => hasConfirmedHub(acknowledged.pid)),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remainingForCheck); }),
      ]);
      if (confirmed === "version-mismatch") return false;
      if (confirmed === true) return true;
    } catch { /* 実体を確認できなければ期限まで再試行する。 */ }
    finally { clearTimeout(timer); }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(options.pollIntervalMs ?? 50, remaining));
  }
}
