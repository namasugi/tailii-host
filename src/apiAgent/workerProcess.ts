// apiAgent/workerProcess.ts
// API 作業プロセスを起動する（hub 側）。`node <dist>/apiAgent/workerMain.js` を子プロセスとして起動し、
// 標準入出力の NDJSON で制御する。env は呼び出し側が組んだもの（キーはここだけ）をそのまま渡し、
// 親の env は継承しない。標準エラーは捨てる（秘密を含みうる出力をログへ持ち込まない）。
//
// 作業プロセスは hub の子だが、中で動くのはエージェント（Agent SDK とその claude・ツールの実行）なので、
// utility の優先度に固定して起動する（agent-priority。hub の優先度を引き継がせない）。taskpolicy は node を
// exec するため、pid・標準入出力・終了コードは付けないときと同じ。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentClampArgv, withAgentClamp } from "../shared/agentPriority.js";
import type { ApiAgentWorkerHandle } from "./manager.js";
import { decodeWorkerToHub, encodeWorkerLine, type WorkerToHub } from "./workerProtocol.js";

export function defaultWorkerEntry(): string {
  return fileURLToPath(new URL("./workerMain.js", import.meta.url));
}

/**
 * 作業プロセスの起動コマンド（純ロジック, TESTABLE）。utility に固定する接頭辞を node の前に足す。
 * 固定しない環境（macOS 以外・taskpolicy 不在・`TAILII_AGENT_CLAMP=off`）では node をそのまま起動する。
 */
export function apiAgentWorkerCommand(
  options: { entry?: string; nodePath?: string; agentClamp?: readonly string[] } = {},
): { executable: string; args: string[] } {
  return withAgentClamp(
    options.nodePath ?? process.execPath,
    [options.entry ?? defaultWorkerEntry()],
    options.agentClamp ?? agentClampArgv(),
  );
}

export function spawnApiAgentWorker(
  env: NodeJS.ProcessEnv,
  options: { entry?: string; nodePath?: string; cwd?: string; agentClamp?: readonly string[] } = {},
): ApiAgentWorkerHandle {
  const command = apiAgentWorkerCommand(options);
  const child = spawn(command.executable, command.args, {
    env,
    cwd: options.cwd ?? env["HOME"] ?? "/",
    stdio: ["pipe", "pipe", "ignore"],
  });
  const messageListeners: ((message: WorkerToHub) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];
  let buffer = "";
  let exited = false;
  let exitCode: number | null = null;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = decodeWorkerToHub(line);
      if (message !== null) for (const listener of messageListeners) listener(message);
    }
    // 異常に長い行は捨てる（作業プロセスは短い制御行しか書かない）。
    if (buffer.length > 1024 * 1024) buffer = "";
  });
  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const listener of exitListeners) listener(code);
  };
  // `exit` は標準出力を読み切る前に来ることがある。結果の行を取りこぼさないよう `close` で終わりとする。
  child.once("close", (code) => finish(code));
  child.once("error", () => finish(null));
  child.stdin?.on("error", () => undefined);
  return {
    get pid() { return child.pid ?? null; },
    send(message) {
      if (exited || child.stdin === null || child.stdin.destroyed) throw new Error("worker exited");
      child.stdin.write(encodeWorkerLine(message));
    },
    onMessage(listener) { messageListeners.push(listener); },
    onExit(listener) {
      if (exited) { listener(exitCode); return; }
      exitListeners.push(listener);
    },
    kill(signal = "SIGTERM") {
      if (!exited) child.kill(signal);
    },
  };
}
