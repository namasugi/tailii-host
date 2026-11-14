// commands/chat/engineClient.ts
// `tailii-host chat` が engine を子プロセスとして起動し、アプリと同じ NDJSON で話す（tailii-chat-cli）。
// 会話の起動・送信はアプリと同じ経路（別名の再利用・runtime claim・peer check・hub の送信確定）を通す。

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { decodeControlMessage, type ControlMessage } from "../../protocol.js";

/** engine との 1 本の接続。 */
export interface EngineConnection {
  /** 要求を送り、`match` に当たる応答（または同じ id の error）を待つ。 */
  request(message: Record<string, unknown>, match: (reply: ControlMessage) => boolean, timeoutMs: number): Promise<ControlMessage>;
  close(): void;
}

export class EngineTimeoutError extends Error {
  constructor(what: string) {
    super(`engine の応答がありません（${what}）`);
    this.name = "EngineTimeoutError";
  }
}

/** 同じ host の `tailii engine` を子プロセスで起動してつなぐ。 */
export async function connectEngine(options: { argv?: string[]; helloTimeoutMs?: number } = {}): Promise<EngineConnection> {
  const argv = options.argv ?? [process.argv[1] ?? "", "engine"];
  const child: ChildProcess = spawn(process.execPath, argv, { stdio: ["pipe", "pipe", "ignore"] });
  const listeners = new Set<(message: ControlMessage) => void>();
  let exited = false;
  child.on("exit", () => { exited = true; });
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    let message: ControlMessage;
    try {
      message = decodeControlMessage(line);
    } catch {
      return; // 知らない型・壊れた行は読み飛ばす（engine の通知は多い）。
    }
    for (const listener of [...listeners]) listener(message);
  });

  const waitFor = (match: (message: ControlMessage) => boolean, timeoutMs: number, what: string): Promise<ControlMessage> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new EngineTimeoutError(what)); }, timeoutMs);
      const listener = (message: ControlMessage): void => {
        if (!match(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      listeners.add(listener);
      if (exited) {
        clearTimeout(timer);
        listeners.delete(listener);
        reject(new EngineTimeoutError(`${what}（engine が終了しました）`));
      }
    });
  const write = (message: Record<string, unknown>): void => {
    child.stdin!.write(`${JSON.stringify(message)}\n`);
  };

  await waitFor((message) => message.type === "channel_hello", options.helloTimeoutMs ?? 20_000, "接続");
  // 画面を持たない相手として名乗る（会話の購読・在席の申告をしない）。clientBuild は送らない（自動更新の判断に混ぜない）。
  write({ type: "channel_hello", v: 1, maxVersion: 2, clientKind: "cli" });

  return {
    request(message, match, timeoutMs) {
      const id = message["id"];
      const reply = waitFor(
        (incoming) => match(incoming) || (incoming.type === "error" && "id" in incoming && incoming.id === id),
        timeoutMs,
        String(message["type"] ?? "要求"),
      );
      write(message);
      return reply;
    },
    close() {
      rl.close();
      try { child.stdin!.end(); } catch { /* 既に閉じている */ }
      setTimeout(() => { if (!exited) child.kill("SIGTERM"); }, 2_000).unref();
    },
  };
}
