// hubDaemonCommand.test.ts — hub daemon の入口（runHubCommand）の終了手順を、本番の配線ごと確かめる
// （graceful shutdown, 2026-10-26）。SessionHub / shutdownHub の単体テストだけでは、runHubCommand での受け渡し
// （mayStartTyping・startRestoredDrains・確認ダイアログの後処理・lock を外す順序）が抜けても気づけない（独立検証）。
//
// テストの HOME は空の一時ディレクトリ（vitest.config.ts）。herdr は偽物（test/fixtures/fake-herdr.mjs）を
// `<HOME>/.local/bin/herdr` に置き、tmux は一時ディレクトリのサーバ（TMUX_TMPDIR）を指すので、実物には触れない。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultChatReceiptsPath, defaultHubLockPath, readHubLock, runHubCommand } from "../src/hub/hubDaemon.js";
import { defaultHeartbeatDir, writeHeartbeat } from "../src/sessions/heartbeat.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";

const FAKE_HERDR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-herdr.mjs");
const SESSION = "s-exp00001";
const FAKE_ENV = [
  "FAKE_HERDR_LOG", "FAKE_HERDR_STATE", "FAKE_HERDR_STATUS", "FAKE_HERDR_TEXT_DELAY", "FAKE_HERDR_PROCESS_INFO_DELAY",
] as const;

/** hub を丸ごと起こすので、隔離した HOME でなければ走らせない（setupIsolation.ts に加えて二重に守る）。 */
function isolatedHome(): string {
  const home = os.homedir();
  if (!path.basename(home).startsWith("tlh-")) throw new Error(`テストの HOME が隔離されていません: ${home}`);
  return home;
}

function resetHubState(): void {
  const dir = path.join(isolatedHome(), ".tailii");
  for (const name of ["hub.lock", "hub", "sessions", "heartbeat", "run"]) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** 偽の herdr と、復元される queued の発話 1 件を用意する。戻り値は偽の herdr の呼び出し記録。 */
function setup(options: { status: string; textDelayMs: number; text: string; processInfoDelayMs?: number }): string {
  const home = isolatedHome();
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(FAKE_HERDR, path.join(bin, "herdr"));
  fs.chmodSync(path.join(bin, "herdr"), 0o755);
  const work = fs.mkdtempSync(path.join(home, "herdr-"));
  const log = path.join(work, "calls.log");
  process.env.FAKE_HERDR_LOG = log;
  process.env.FAKE_HERDR_STATE = path.join(work, "state.json");
  process.env.FAKE_HERDR_STATUS = options.status;
  process.env.FAKE_HERDR_TEXT_DELAY = String(options.textDelayMs);
  process.env.FAKE_HERDR_PROCESS_INFO_DELAY = String(options.processInfoDelayMs ?? 0);
  // reaper の 1 周は実物の tmux を呼ぶ。一時ディレクトリのサーバ（socket ファイルも無い = サーバ不在）を指すこと。
  const tmuxTmp = process.env.TMUX_TMPDIR;
  if (tmuxTmp === undefined || !tmuxTmp.startsWith(home)) throw new Error("TMUX_TMPDIR が隔離されていません");
  writeHeartbeat(defaultHeartbeatDir(), SESSION, { ts: Math.floor(Date.now() / 1000), state: "active", event: "test" });
  new SessionMetadataStore().put({ name: SESSION, cwd: home, createdAt: 1, agent: "claude", backend: "herdr", herdrPaneId: "w1:p1" });
  const receipts = defaultChatReceiptsPath();
  fs.mkdirSync(path.dirname(receipts), { recursive: true });
  fs.writeFileSync(receipts, JSON.stringify({ version: 1, sessions: { [SESSION]: {
    delivered: [],
    queued: [{ type: "chat_send", id: "q", session: SESSION, clientMessageId: "cm-1", text: options.text }],
    injecting: [], chatOrder: ["cm-1"], deliveredCodex: [], queuedCodex: [], startingCodex: [], codexOrder: [],
  } } }));
  return log;
}

const calls = (log: string): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []);
const persisted = () => JSON.parse(fs.readFileSync(defaultChatReceiptsPath(), "utf8")).sessions[SESSION] as {
  delivered: string[]; queued: Array<{ clientMessageId: string }>; injecting: unknown[];
};

/**
 * hub を起こす。SIGTERM は hub が登録した受け手だけを直接呼ぶ（`process.emit` だと、テストを動かしている
 * プロセスの他の受け手まで呼ぶ）。受け手は runHubCommand の最初の await の後で登録される。
 */
interface StartedHub { done: Promise<number>; settled: boolean; sigterm: () => Promise<void> }
/** テストが途中で落ちても、hub を動かしたまま次のテストへ進まない（afterEach が止める）。 */
const startedHubs: StartedHub[] = [];

function startHub(args: string[]): StartedHub {
  const before = new Set(process.listeners("SIGTERM"));
  const hub: StartedHub = {
    done: runHubCommand(args),
    settled: false,
    sigterm: async () => {
      await vi.waitFor(() => expect(process.listeners("SIGTERM").filter((fn) => !before.has(fn))).toHaveLength(1));
      const listener = process.listeners("SIGTERM").find((fn) => !before.has(fn)) as (signal: NodeJS.Signals) => void;
      listener("SIGTERM");
    },
  };
  void hub.done.finally(() => { hub.settled = true; });
  startedHubs.push(hub);
  return hub;
}

/** 偽の herdr と作業ファイルを消す（共有の一時 HOME に残すと、後のテストファイルの「既定の場所」が変わる）。 */
function removeFakeHerdr(): void {
  const home = isolatedHome();
  fs.rmSync(path.join(home, ".local", "bin", "herdr"), { force: true });
  for (const entry of fs.readdirSync(home)) {
    if (entry.startsWith("herdr-")) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  }
}

describe("runHubCommand の終了手順（graceful shutdown）", () => {
  const savedEnv = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of FAKE_ENV) savedEnv.set(key, process.env[key]);
    resetHubState();
  });
  afterEach(async () => {
    for (const hub of startedHubs.splice(0)) {
      if (hub.settled) continue;
      await hub.sigterm().catch(() => {});
      await Promise.race([hub.done, new Promise((resolve) => setTimeout(resolve, 25_000))]);
    }
    for (const key of FAKE_ENV) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeFakeHerdr();
    resetHubState();
  }, 30_000);

  test("復元した queue を socket を取ってから届け、打っている途中の SIGTERM では最後まで送ってから lock を外す", async () => {
    const log = setup({ status: "idle", textDelayMs: 1500, text: "hello" });
    const listenersBefore = process.listeners("SIGTERM").length;
    const hub = startHub(["--interval-seconds", "3600"]);
    // client が一人もつながっていなくても、復元した queue を届け始める（startRestoredDrains）。
    await vi.waitFor(() => expect(calls(log).some((line) => line.includes("TEXT-BEGIN"))).toBe(true), { timeout: 10_000 });
    await hub.sigterm();
    // 打っている途中で終了の合図を受けても、最後まで打って Enter を押す。その時点（この後も送信の確認で 0.7 秒は
    // 待つ）でも lock を持ったまま（次の hub が起動して、注入中の発話を配送不明として読まないように）。
    await vi.waitFor(() => expect(calls(log).some((line) => line.includes(" SUBMIT "))).toBe(true), { timeout: 10_000 });
    expect(readHubLock(defaultHubLockPath())?.pid).toBe(process.pid);
    expect(await hub.done).toBe(0);
    expect(fs.existsSync(defaultHubLockPath())).toBe(false);
    expect(process.listeners("SIGTERM")).toHaveLength(listenersBefore);
    expect(calls(log).filter((line) => line.includes(" SUBMIT "))).toHaveLength(1);
    expect(persisted().delivered).toContain("cm-1");
  }, 20_000);

  test("claude の起動を待っている注入は、終了を待たせずに見送って queued へ戻す", async () => {
    const log = setup({ status: "unknown", textDelayMs: 0, text: "起動中の会話へ" });
    const startedAt = Date.now();
    expect(await runHubCommand(["--once"])).toBe(0);
    // 起動待ち（最大 10 秒）・描画待ち（最大 20 秒）や、20 秒の上限まで待たない。
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(calls(log).some((line) => line.includes("send-text"))).toBe(false);
    expect(persisted().queued.map((message) => message.clientMessageId)).toEqual(["cm-1"]);
    expect(persisted().injecting).toEqual([]);
  }, 20_000);

  test("`/model` の確認ダイアログの承認（注入に続く後処理）を待ってから閉じる", async () => {
    const log = setup({ status: "idle", textDelayMs: 300, text: "/model opus" });
    const logs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      logs.push(String(chunk));
      return write(chunk);
    };
    try {
      const hub = startHub(["--interval-seconds", "3600"]);
      await vi.waitFor(() => expect(calls(log).some((line) => line.includes(" SUBMIT "))).toBe(true), { timeout: 10_000 });
      const terminatedAt = Date.now();
      await hub.sigterm();
      expect(await hub.done).toBe(0);
      // 偽の herdr は確認ダイアログを出さないので、承認は諦めるまで（約 4 秒）待つ。
      expect(Date.now() - terminatedAt).toBeGreaterThan(1_000);
      expect(logs.find((line) => line.includes("audit hub_shutdown_drain")) ?? "").toContain("followups=1");
    } finally {
      (process.stderr as unknown as { write: typeof write }).write = write;
    }
  }, 20_000);
});
