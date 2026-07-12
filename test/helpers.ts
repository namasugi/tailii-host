// helpers.ts — engine テスト共通ハーネス
// Swift 版 EngineTests のヘルパ（pipe FD + readLineOfType + MockTmuxRunner）の TS 対応。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { runEngine, type RunEngineOptions } from "../src/engine.js";
import { connectInProcessHub } from "../src/hubClient.js";
import { startEngineRelaySocket } from "../src/engineRelaySocket.js";
import { SessionHub } from "../src/sessionHub.js";
import { injectQuestionAnswers } from "../src/questionInjection.js";
import { SessionMetadataStore } from "../src/sessionMetadataStore.js";
import type { TmuxCommandResult, TmuxCommandRunner } from "../src/tmux.js";
import { ChatTailController } from "../src/chatTailController.js";
import { TranscriptTailer } from "../src/transcriptTailer.js";
import { LineWriter } from "../src/lineWriter.js";
import type { ControlMessage } from "../src/protocol.js";

/** 出力行の非同期キュー（タイムアウト付き読み出し）。 */
export class LineQueue {
  private queue: string[] = [];
  private waiters: ((line: string) => void)[] = [];

  push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.queue.push(line);
  }

  async next(timeoutMs = 5000): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onLine);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("LineQueue: timeout"));
      }, timeoutMs);
      const onLine = (line: string): void => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push(onLine);
    });
  }

  /** 指定 type の行を読むまで読み進める（channel_hello 等の先行行を読み飛ばす）。 */
  async nextOfType(type: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`LineQueue: timeout waiting for type ${type}`);
      const line = await this.next(remaining);
      if (line.includes(`"type":"${type}"`)) return line;
    }
  }
}

/** 記録付きモック tmux ランナー（Swift 版 MockTmuxRunner と対）。 */
export class MockTmuxRunner {
  readonly recorded: string[][] = [];
  constructor(private readonly handler: (args: string[]) => TmuxCommandResult) {}

  get runner(): TmuxCommandRunner {
    return async (args) => {
      this.recorded.push(args);
      return this.handler(args);
    };
  }
}

export function ok(stdout: string): TmuxCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/** runner に指定 args が記録されるまでポーリングで待つ。 */
export async function waitForCommand(
  runner: MockTmuxRunner,
  args: string[],
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const wanted = JSON.stringify(args);
  while (Date.now() < deadline) {
    if (runner.recorded.some((cmd) => JSON.stringify(cmd) === wanted)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** 一時ディレクトリを作って返す（テスト専用、prefix 付き）。 */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** テスト用の一時メタデータストア。 */
export function makeTempStore(): SessionMetadataStore {
  return new SessionMetadataStore(makeTempDir("tailii-engine-tests"));
}

/** engine を in-memory ストリームで駆動するハーネス。 */
export interface EngineHarness {
  writeLine(line: string): void;
  lines: LineQueue;
  /** input を EOF にして engine の完了を待つ（Swift 版 teardown と対）。 */
  teardown(): Promise<void>;
  done: Promise<void>;
}

export function startEngine(
  options: Omit<RunEngineOptions, "input" | "output"> & {
    planUsage?: RunEngineOptions["planUsage"];
    hub?: SessionHub;
    /** Session Hub の本物 tail factory を組むテスト用 projects root。 */
    chatTailProjectsRoot?: string;
  },
): EngineHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = new LineQueue();
  const rl = readline.createInterface({ input: output, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => lines.push(line));

  const { chatTailProjectsRoot, hub: injectedHub, ...engineOptions } = options;
  const callbackWriter = (write: (message: ControlMessage) => void): LineWriter => {
    const stream = new PassThrough();
    const reader = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    reader.on("line", (line) => write(JSON.parse(line) as ControlMessage));
    return new LineWriter(stream);
  };
  const hub = injectedHub ?? new SessionHub({
    runner: async () => ok(""),
    heartbeatDir: options.heartbeatDir ?? makeTempDir("hub-heartbeat"),
    metadataStore: options.metadataStore ?? makeTempStore(),
    timeoutSeconds: 1800,
    questionInjector: (answers, session) => injectQuestionAnswers(answers, session, options.sessionManager),
    ...(options.codexTurnController !== undefined && options.codexTurnController !== null ? {
      codexAppServerFactory: () => ({ openThread: async () => { throw new Error("unused test app server"); } }),
      codexTurnControllerFactory: () => options.codexTurnController!,
    } : options.codexAppServer !== undefined && options.codexAppServer !== null ? {
      codexAppServerFactory: () => options.codexAppServer!,
    } : {}),
    ...(chatTailProjectsRoot !== undefined ? {
      tailFactory: (write: (message: ControlMessage) => void) => new ChatTailController({
        writer: callbackWriter(write),
        tailer: options.transcriptTailer ?? new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true }),
        projectsRoot: chatTailProjectsRoot,
        imageService: options.imageService ?? null,
      }),
    } : {}),
  });
  // 移管前の relay 直送テストも、受信者は engine ではなく同じ Hub にする。
  const relayServer = options.engineRelaySocketPath
    ? startEngineRelaySocket({
        socketPath: options.engineRelaySocketPath,
        onMessage: (message) => hub.handleRelayMessage(message),
      })
    : Promise.resolve(null);
  const done = runEngine({
    input,
    output,
    engineRelaySocketPath: options.engineRelaySocketPath ?? null,
    // テストの既定はプラン使用状況なし（ネットワーク非依存）。個別テストで上書き可能。
    planUsage: options.planUsage ?? (async () => null),
    ...engineOptions,
    hubLink: options.hubLink ?? connectInProcessHub(hub),
  });
  // teardown 前に reject されても unhandled rejection にしない。
  done.catch(() => {});

  return {
    writeLine: (line) => input.write(line + "\n"),
    lines,
    done,
    teardown: async () => {
      input.end();
      await done.catch(() => {});
      await (await relayServer)?.close();
      rl.close();
    },
  };
}
