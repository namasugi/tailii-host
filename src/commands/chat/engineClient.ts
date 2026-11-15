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
  /** stdin を閉じて engine が自分で終わるのを待つ（最大 2 秒。終わらなければ SIGTERM）。 */
  close(): Promise<void>;
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
  const exitWaiters = new Set<() => void>();
  let exited = false;
  const markExited = (): void => {
    if (exited) return;
    exited = true;
    // 待っている要求は時間切れまで待たせずに終わらせる（レビュー指摘 A10）。
    for (const waiter of [...exitWaiters]) waiter();
  };
  // 出力を読み切ってから終わりとみなす（`exit` は標準出力の最後の行より先に来ることがあり、届いた結果を捨てうる）。
  child.on("close", markExited);
  // 起動の失敗・終わった後の書き込み（EPIPE）で未捕捉の例外にしない。
  child.on("error", markExited);
  child.stdin?.on("error", () => {});
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
      const cleanup = (): void => {
        clearTimeout(timer);
        listeners.delete(listener);
        exitWaiters.delete(onExit);
      };
      const timer = setTimeout(() => { cleanup(); reject(new EngineTimeoutError(what)); }, timeoutMs);
      const listener = (message: ControlMessage): void => {
        if (!match(message)) return;
        cleanup();
        resolve(message);
      };
      const onExit = (): void => { cleanup(); reject(new EngineTimeoutError(`${what}（engine が終了しました）`)); };
      listeners.add(listener);
      exitWaiters.add(onExit);
      if (exited) onExit();
    });
  const write = (message: Record<string, unknown>): void => {
    if (exited) return;
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
    async close() {
      try { child.stdin!.end(); } catch { /* 既に閉じている */ }
      if (!exited) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { if (!exited) child.kill("SIGTERM"); resolve(); }, 2_000);
          exitWaiters.add(() => { clearTimeout(timer); resolve(); });
        });
      }
      rl.close();
    },
  };
}
