// codexAppServerReplace.test.ts — 版ずれ daemon の入れ替え（使用中でないときだけ）のテスト

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CodexAppServerManager,
  compareVersions,
  type CodexAppServerConnection,
} from "../src/codex/codexAppServer.js";
import {
  parseLsofSocketPids,
  parseProcNetUnixInodes,
  socketPathCandidates,
  type CodexAppServerProcessControl,
} from "../src/codex/codexAppServerProcess.js";
import { makeTempDir } from "./helpers.js";

/** 共有 daemon 1 つ分の状態。connect / launch / signal がこれを読み書きする。 */
class FakeDaemon {
  alive = true;
  pid = 4100;
  loaded: string[] = [];
  /** 指定時は thread/loaded/list をこのページ列で返す（cursor は `p<番号>`）。 */
  loadedPages: Array<{ data: string[]; nextCursor: string | null }> | null = null;
  loadedListError: Error | null = null;
  /** thread/loaded/list の n 回目（1 始まり）の応答を作る直前に呼ぶ。 */
  beforeLoadedList: ((call: number) => void) | null = null;
  readonly methods: string[] = [];
  private loadedListCalls = 0;

  constructor(public version: string | null) {}

  loadedList(params: unknown): unknown {
    this.loadedListCalls += 1;
    this.beforeLoadedList?.(this.loadedListCalls);
    if (this.loadedListError !== null) throw this.loadedListError;
    if (this.loadedPages !== null) {
      const cursor = (params as { cursor?: string } | undefined)?.cursor;
      const index = cursor === undefined ? 0 : Number(cursor.slice(1)) - 1;
      return this.loadedPages[index] ?? { data: [], nextCursor: null };
    }
    return { data: [...this.loaded], nextCursor: null };
  }

  count(method: string): number {
    return this.methods.filter((recorded) => recorded === method).length;
  }
}

class FakeDaemonConnection implements CodexAppServerConnection {
  constructor(private readonly daemon: FakeDaemon) {}

  async initialize(): Promise<unknown> {
    const version = this.daemon.version;
    return version === null ? {} : { userAgent: `tailii_host/${version} (Mac OS 26.5; arm64) unknown` };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.daemon.methods.push(method);
    if (method === "thread/loaded/list") return this.daemon.loadedList(params);
    return {};
  }

  onNotification(): () => void {
    return () => {};
  }

  onServerRequest(): () => void {
    return () => {};
  }

  respond(): void {}

  respondError(): void {}

  close(): void {}
}

interface HarnessOptions {
  serverVersion?: string | null;
  cliVersion?: string | null;
  /** 別 process に見立てた 2 つ目の manager と共有する。 */
  daemon?: FakeDaemon;
  codexHome?: string;
  /** socket を開いている pid の一覧を固定する（既定は生きている daemon の pid）。 */
  socketPids?: number[] | null;
  /** 全 pid のコマンドラインを固定する（既定は daemon の pid だけ Tailii が起動する形）。 */
  command?: string | null;
  /** daemon を止めるシグナル（既定は SIGTERM で止まる）。 */
  dieOn?: NodeJS.Signals[];
  /** 起動し直した daemon が名乗る版（既定は CLI の版）。 */
  launchVersion?: string;
  /** launch の中で呼ぶ（別 process の割り込みを再現する）。 */
  onLaunch?: () => void;
  /** `codex --version` を読むたびに呼ぶ（別 process の割り込みを再現する）。 */
  onCliVersionRead?: () => void;
  cliVersionTtlMs?: number;
  replaceGraceMs?: number;
}

function harness(options: HarnessOptions = {}) {
  const daemon = options.daemon ?? new FakeDaemon(options.serverVersion === undefined ? "0.158.0" : options.serverVersion);
  let cliVersion = options.cliVersion === undefined ? "0.163.0" : options.cliVersion;
  let cliReads = 0;
  const logs: string[] = [];
  const signals: Array<[number, NodeJS.Signals]> = [];
  const launches: string[][] = [];
  const dieOn = options.dieOn ?? ["SIGTERM"];
  const codexHome = options.codexHome ?? makeTempDir("codex-app-server-replace");
  const processControl: CodexAppServerProcessControl = {
    findSocketPids: async () => {
      if (options.socketPids !== undefined) return options.socketPids;
      return daemon.alive ? [daemon.pid] : [];
    },
    readCommand: async (pid) => {
      if (options.command !== undefined) return options.command;
      return pid === daemon.pid ? "codex app-server --listen unix://" : null;
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid !== daemon.pid || !daemon.alive) return false;
      if (dieOn.includes(signal)) daemon.alive = false;
      return true;
    },
    isAlive: (pid) => pid === daemon.pid && daemon.alive,
  };
  const manager = new CodexAppServerManager({
    codexHome,
    connect: async () => {
      if (!daemon.alive) throw new Error("not running");
      return new FakeDaemonConnection(daemon);
    },
    launch: (executable, args) => {
      launches.push([executable, ...args]);
      options.onLaunch?.();
      daemon.alive = true;
      daemon.pid += 1;
      daemon.version = options.launchVersion ?? cliVersion;
      daemon.loaded = [];
    },
    cliVersion: async () => {
      cliReads += 1;
      options.onCliVersionRead?.();
      return cliVersion;
    },
    cliVersionTtlMs: options.cliVersionTtlMs ?? 60_000,
    log: (message) => logs.push(message),
    processControl,
    pollIntervalMs: 1,
    startupTimeoutMs: 200,
    stopTimeoutMs: 30,
    replaceGraceMs: options.replaceGraceMs ?? 0,
  });
  const controlDir = path.join(codexHome, "app-server-control");
  return {
    manager,
    daemon,
    codexHome,
    logs,
    signals,
    launches,
    lockPath: path.join(controlDir, "tailii-start.lock"),
    useMarkerDir: path.join(controlDir, "tailii-daemon-use"),
    recordPath: path.join(controlDir, "tailii-replace.json"),
    setCliVersion: (version: string | null) => {
      cliVersion = version;
    },
    cliReads: () => cliReads,
  };
}

/** 別の呼び出しの使用の印を置く（ageMs 前に置かれたことにする）。 */
function writeUseMarker(dir: string, name: string, ageMs: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, name);
  fs.writeFileSync(markerPath, "");
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(markerPath, at, at);
  return markerPath;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodexAppServerManager の版ずれ daemon 入れ替え", () => {
  test("daemon が CLI より古く使用中でなければ、旧 daemon を止めて今の CLI で起動し直す", async () => {
    const h = harness();
    const oldPid = h.daemon.pid;

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([[oldPid, "SIGTERM"]]);
    expect(h.launches).toEqual([["codex", "app-server", "--listen", "unix://"]]);
    expect(h.daemon.alive).toBe(true);
    expect(h.daemon.version).toBe("0.163.0");
    // 判定と、止める直前の再確認の 2 回。
    expect(h.daemon.count("thread/loaded/list")).toBe(2);
    expect(h.logs.some((log) => log.includes("0.158.0 → codex CLI 0.163.0") && log.includes("入れ替えた"))).toBe(true);
    const record = JSON.parse(fs.readFileSync(h.recordPath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ pair: "0.158.0->0.163.0", result: "replaced" });
  });

  test("読み込み中の会話があれば止めず、保留のログは 1 回。少し後に判定し直して入れ替える", async () => {
    const h = harness();
    h.daemon.loaded = ["thread-remote-tui"];

    await h.manager.ensureRunning();
    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toEqual([]);
    // 2 回目は再判定の時刻前なので会話の一覧を読みにいかない。
    expect(h.daemon.count("thread/loaded/list")).toBe(1);
    expect(h.logs.filter((log) => log.includes("保留"))).toHaveLength(1);

    // 会話が閉じて unload された後（再判定の 30 秒後。ここまでの使用の印も期限切れ）に入れ替える。
    h.daemon.loaded = [];
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
    await h.manager.ensureRunning();

    expect(h.signals).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.version).toBe("0.163.0");
  });

  test("読み込み中の会話は 2 ページ目以降も見る（nextCursor を辿る）", async () => {
    const h = harness();
    h.daemon.loadedPages = [{ data: [], nextCursor: "p2" }, { data: ["thread-on-page-2"], nextCursor: null }];

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.logs.some((log) => log.includes("読み込み中の会話がある"))).toBe(true);
  });

  test("止める直前の再確認で会話が読み込まれていたら止めない", async () => {
    const h = harness({ replaceGraceMs: 1 });
    h.daemon.beforeLoadedList = (call) => {
      if (call === 2) h.daemon.loaded = ["thread-opening"];
    };

    await h.manager.ensureRunning();

    expect(h.daemon.count("thread/loaded/list")).toBe(2);
    expect(h.signals).toEqual([]);
    expect(h.launches).toEqual([]);
    expect(h.daemon.alive).toBe(true);
  });

  test("止める直前の再確認で daemon の版が変わっていたら（別の入れ替えが済んだ）止めない", async () => {
    const h = harness();
    h.daemon.beforeLoadedList = (call) => {
      if (call === 1) h.daemon.version = "0.163.0";
    };

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toEqual([]);
  });

  test("別の呼び出しが直前に使い始めていたら（開きかけの会話）止めない", async () => {
    const h = harness();
    writeUseMarker(h.useMarkerDir, "999-opening-thread", 1_000);

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toEqual([]);
    expect(h.logs.some((log) => log.includes("直前に別の処理が使い始めた"))).toBe(true);
  });

  test("期限切れの使用の印は入れ替えを止めず、掃除される", async () => {
    const h = harness();
    const stale = writeUseMarker(h.useMarkerDir, "999-finished", 40_000);

    await h.manager.ensureRunning();

    expect(h.signals).toHaveLength(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  test("同じ process の別の呼び出しの印も使用中として扱う", async () => {
    const shared = harness();
    const sibling = harness({ daemon: shared.daemon, codexHome: shared.codexHome, cliVersion: "0.158.0" });

    // 版が揃って見える呼び出し（例: CLI の版のキャッシュが古い hub）が先に daemon を使い始める。
    await sibling.manager.ensureRunning();
    await shared.manager.ensureRunning();

    expect(shared.signals).toEqual([]);
    expect(shared.launches).toEqual([]);
  });

  test.each([
    { name: "版が揃っている", serverVersion: "0.163.0", cliVersion: "0.163.0" },
    { name: "daemon の方が新しい", serverVersion: "0.164.0", cliVersion: "0.163.0" },
    { name: "daemon の版が分からない", serverVersion: null, cliVersion: "0.163.0" },
    { name: "CLI の版が分からない", serverVersion: "0.158.0", cliVersion: null },
  ])("$name なら会話の確認もせず何もしない", async ({ serverVersion, cliVersion }) => {
    const h = harness({ serverVersion, cliVersion });

    await h.manager.ensureRunning();

    expect(h.daemon.count("thread/loaded/list")).toBe(0);
    expect(h.signals).toEqual([]);
    expect(h.launches).toEqual([]);
  });

  test("daemon の方が新しい版ずれはログに「入れ替えない」と残す", async () => {
    const h = harness({ serverVersion: "0.164.0", cliVersion: "0.163.0" });

    await h.manager.ensureRunning();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.logs.some((log) => log.includes("0.164.0") && log.includes("daemon の方が新しいので入れ替えない"))).toBe(true);
  });

  test("読み込み中の会話を確かめられなければ止めない（判定できないものは使用中とみなす）", async () => {
    const h = harness();
    h.daemon.loadedListError = new Error("Codex App Server request timed out: thread/loaded/list");

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toEqual([]);
    expect(h.logs.some((log) => log.includes("確かめられない"))).toBe(true);
  });

  test.each([
    { name: "socket を開いているプロセスを調べられない", socketPids: null, reason: "調べられない" },
    { name: "socket を開いているプロセスが居ない", socketPids: [], reason: "見つからない" },
    { name: "app-server ではない", command: "/usr/bin/python3 server.py", reason: "見つからない" },
    {
      name: "Tailii が起動する形ではない（余分な引数）",
      command: "codex app-server --listen unix:// --analytics-default-enabled",
      reason: "見つからない",
    },
    {
      name: "codex が管理する daemon",
      command: "/Users/me/.codex/packages/app-server-daemon/current/bin/codex app-server --listen unix://",
      reason: "codex が管理する daemon",
    },
    {
      name: "候補が 2 つある",
      socketPids: [4100, 4999],
      command: "codex app-server --listen unix://",
      reason: "候補が 2 件",
    },
  ] satisfies Array<{ name: string; socketPids?: number[] | null; command?: string; reason: string }>)(
    "止める相手が確かでなければ止めない: $name",
    async ({ socketPids, command, reason }) => {
      const h = harness({
        ...(socketPids !== undefined ? { socketPids } : {}),
        ...(command !== undefined ? { command } : {}),
      });

      await h.manager.ensureRunning();

      expect(h.signals).toEqual([]);
      expect(h.launches).toEqual([]);
      expect(h.logs.some((log) => log.includes("見送る") && log.includes(reason))).toBe(true);
    },
  );

  test("-c 付きで起動した daemon は Tailii の形ではないので止めない", async () => {
    const h = harness({ command: "codex app-server -c features.code_mode_host=true --listen unix://" });

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.logs.some((log) => log.includes("見つからない"))).toBe(true);
  });

  test("実行ファイルがフルパスの codex でも Tailii が起動する形なら止める", async () => {
    const h = harness({ command: "/opt/homebrew/bin/codex app-server --listen unix://" });

    await h.manager.ensureRunning();

    expect(h.signals).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
  });

  test("自分の process は止める相手に数えない", async () => {
    // FakeDaemon の最初の pid は 4100。全 pid が Tailii の起動する形に見えても、自分は除く。
    const h = harness({ command: "codex app-server --listen unix://", socketPids: [process.pid, 4100] });

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([[4100, "SIGTERM"]]);
  });

  test("SIGTERM で止まらなければ SIGKILL で止めてから起動し直す", async () => {
    const h = harness({ dieOn: ["SIGKILL"] });
    const oldPid = h.daemon.pid;

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([[oldPid, "SIGTERM"], [oldPid, "SIGKILL"]]);
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.version).toBe("0.163.0");
  });

  test("止まらなかった旧 daemon が応答し続けるなら、起動し直さずそのまま使う", async () => {
    const h = harness({ dieOn: [] });

    await h.manager.ensureRunning();

    expect(h.signals.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.launches).toEqual([]);
    expect(h.daemon.alive).toBe(true);
    expect(h.logs.some((log) => log.includes("止まらない"))).toBe(true);
    expect(h.logs.some((log) => log.includes("のまま"))).toBe(false);
  });

  test("入れ替えても版が揃わなければ、別 process（接続ごとの engine）も同じ入れ替えを繰り返さない", async () => {
    const first = harness({ launchVersion: "0.158.0" });

    await first.manager.ensureRunning();
    await first.manager.ensureRunning();

    expect(first.signals).toHaveLength(1);
    expect(first.launches).toHaveLength(1);
    expect(first.logs.some((log) => log.includes("0.158.0 のまま"))).toBe(true);

    // 次の接続の engine（新しい process = 新しい manager）。
    const next = harness({ daemon: first.daemon, codexHome: first.codexHome });
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
    await next.manager.ensureRunning();

    expect(next.signals).toEqual([]);
    expect(next.launches).toEqual([]);
    expect(next.logs.some((log) => log.includes("最近試した"))).toBe(true);
  });

  test("別の組み合わせの記録は入れ替えを止めない", async () => {
    const h = harness();
    fs.mkdirSync(path.dirname(h.recordPath), { recursive: true });
    fs.writeFileSync(h.recordPath, JSON.stringify({ pair: "0.150.0->0.163.0", result: "version-mismatch", at: Date.now() }));

    await h.manager.ensureRunning();

    expect(h.signals).toHaveLength(1);
  });

  test("試した記録は 6 時間（2 時間前なら止める・7 時間前なら試す）", async () => {
    const recent = harness();
    fs.mkdirSync(path.dirname(recent.recordPath), { recursive: true });
    fs.writeFileSync(recent.recordPath, JSON.stringify({
      pair: "0.158.0->0.163.0", result: "version-mismatch", at: Date.now() - 2 * 60 * 60_000,
    }));
    await recent.manager.ensureRunning();
    expect(recent.signals).toEqual([]);

    const old = harness();
    fs.mkdirSync(path.dirname(old.recordPath), { recursive: true });
    fs.writeFileSync(old.recordPath, JSON.stringify({
      pair: "0.158.0->0.163.0", result: "version-mismatch", at: Date.now() - 7 * 60 * 60_000,
    }));
    await old.manager.ensureRunning();
    expect(old.signals).toHaveLength(1);
  });

  test("見送った記録は別 process にも 10 分だけ効く（10 分を過ぎたら試す）", async () => {
    const first = harness({ socketPids: [] });
    await first.manager.ensureRunning();
    expect(first.logs.some((log) => log.includes("見つからない"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(first.recordPath, "utf8"))).toMatchObject({ result: "skipped" });

    const realNow = Date.now.bind(Date);
    const soon = harness({ daemon: first.daemon, codexHome: first.codexHome });
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
    await soon.manager.ensureRunning();
    expect(soon.signals).toEqual([]);
    expect(soon.logs.some((log) => log.includes("最近試した"))).toBe(true);

    vi.restoreAllMocks();
    const later = harness({ daemon: first.daemon, codexHome: first.codexHome });
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11 * 60_000);
    await later.manager.ensureRunning();
    expect(later.signals).toHaveLength(1);
  });

  test("記録で見送った後でも、CLI が更新されて組み合わせが変われば同じ process ですぐ判定する", async () => {
    const h = harness({ cliVersionTtlMs: 0 });
    fs.mkdirSync(path.dirname(h.recordPath), { recursive: true });
    fs.writeFileSync(h.recordPath, JSON.stringify({ pair: "0.158.0->0.163.0", result: "version-mismatch", at: Date.now() }));

    await h.manager.ensureRunning();
    expect(h.signals).toEqual([]);

    h.setCliVersion("0.164.0");
    // 1 回目の呼び出しの使用の印だけを期限切れにする（組み合わせごとの保留は 10 分あっても効かないこと）。
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
    await h.manager.ensureRunning();

    expect(h.signals).toHaveLength(1);
    expect(h.daemon.version).toBe("0.164.0");
  });

  test("使用の印は 30 秒有効（10 秒前の印でも止めない）", async () => {
    const h = harness();
    writeUseMarker(h.useMarkerDir, "999-recent", 10_000);

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
  });

  test("使用の印の置き場を読めなければ使用中とみなす", async () => {
    const h = harness();
    fs.mkdirSync(h.useMarkerDir, { recursive: true });
    fs.chmodSync(h.useMarkerDir, 0o000);
    try {
      await h.manager.ensureRunning();
    } finally {
      fs.chmodSync(h.useMarkerDir, 0o700);
    }

    expect(h.signals).toEqual([]);
    expect(h.logs.some((log) => log.includes("使用の印を確かめられない"))).toBe(true);
  });

  test("置いた直後の印（ファイル時刻が Date.now よりわずかに先）は新しい印として扱う", async () => {
    const h = harness();
    writeUseMarker(h.useMarkerDir, "999-just-now", -500);

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
  });

  test("時計が戻って未来の時刻になった印は古い印として扱う", async () => {
    const h = harness();
    const future = writeUseMarker(h.useMarkerDir, "999-future", -60 * 60_000);

    await h.manager.ensureRunning();

    expect(h.signals).toHaveLength(1);
    expect(fs.existsSync(future)).toBe(false);
  });

  test("時計が戻って未来の時刻になった startup lock は持ち主が生きていても待たない", async () => {
    const h = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0" });
    fs.mkdirSync(path.dirname(h.lockPath), { recursive: true });
    fs.writeFileSync(h.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() + 60 * 60_000 }));
    const started = Date.now();

    await h.manager.ensureRunning();

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("lock を待った呼び出しは、待った後に使用の印を付け直す（待ちで印が古くならない）", async () => {
    const waiter = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0" });
    fs.mkdirSync(path.dirname(waiter.lockPath), { recursive: true });
    fs.writeFileSync(waiter.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const waiting = waiter.manager.ensureRunning();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 30 秒以上待ったことにしてから lock を外す。
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
    fs.unlinkSync(waiter.lockPath);
    await waiting;

    // 直後に、新しい CLI を見た別の process が入れ替えを判定する。
    const replacer = harness({ daemon: waiter.daemon, codexHome: waiter.codexHome, cliVersion: "0.164.0" });
    await replacer.manager.ensureRunning();

    expect(replacer.signals).toEqual([]);
    expect(replacer.logs.some((log) => log.includes("直前に別の処理が使い始めた"))).toBe(true);
  });

  test("入れ替えようとして lock を待った呼び出しも、待った後に使用の印を付け直す", async () => {
    let interrupted = false;
    const realNow = Date.now.bind(Date);
    const waiter = harness({
      // 版を確かめた直後に別 process が lock を取り、30 秒を超えて持ってから外す（daemon はそのまま）。
      onCliVersionRead: () => {
        if (interrupted) return;
        interrupted = true;
        fs.mkdirSync(path.dirname(waiter.lockPath), { recursive: true });
        fs.writeFileSync(waiter.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        setTimeout(() => {
          vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
          fs.unlinkSync(waiter.lockPath);
        }, 30);
      },
    });

    await waiter.manager.ensureRunning();
    expect(waiter.signals).toEqual([]);

    // 直後に、さらに新しい CLI を見た別の process が入れ替えを判定する。
    const replacer = harness({ daemon: waiter.daemon, codexHome: waiter.codexHome, cliVersion: "0.164.0" });
    await replacer.manager.ensureRunning();

    expect(replacer.signals).toEqual([]);
    expect(replacer.logs.some((log) => log.includes("直前に別の処理が使い始めた"))).toBe(true);
  });

  test("lock が取れないなど判定の途中で失敗しても、動いている daemon をそのまま使う", async () => {
    const h = harness();
    const controlDir = path.dirname(h.lockPath);
    fs.mkdirSync(controlDir, { recursive: true });
    fs.chmodSync(controlDir, 0o500);
    try {
      await expect(h.manager.ensureRunning()).resolves.toBeUndefined();
    } finally {
      fs.chmodSync(controlDir, 0o700);
    }

    expect(h.signals).toEqual([]);
    expect(h.daemon.alive).toBe(true);
    expect(h.logs.some((log) => log.includes("入れ替えの判定に失敗"))).toBe(true);
  });

  test("既定の CODEX_HOME は TAILII_CODEX_APP_SERVER_HOME で差し替わる（テストが実物の ~/.codex に触れない）", () => {
    expect(process.env["TAILII_CODEX_APP_SERVER_HOME"]).toBe("/nonexistent/tailii-test/codex-home");
    expect(new CodexAppServerManager().socketPath).toBe(
      "/nonexistent/tailii-test/codex-home/app-server-control/app-server-control.sock",
    );
  });

  test("CLI の版は TTL ごとに読み直す（長寿命の hub でも codex の更新に追従する）", async () => {
    const fresh = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0", cliVersionTtlMs: 0 });
    await fresh.manager.ensureRunning();
    fresh.setCliVersion("0.164.0");
    // 1 回目の呼び出しの使用の印が期限切れになってから（印は呼び出しの終わりを知らない）。
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
    await fresh.manager.ensureRunning();
    expect(fresh.signals).toHaveLength(1);
    expect(fresh.daemon.version).toBe("0.164.0");
    vi.restoreAllMocks();

    const cached = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0", cliVersionTtlMs: 60_000 });
    await cached.manager.ensureRunning();
    cached.setCliVersion("0.164.0");
    await cached.manager.ensureRunning();
    expect(cached.signals).toEqual([]);
    expect(cached.cliReads()).toBe(1);
  });

  test("別の起動・入れ替えの最中（新しい startup lock）は、外れるまで待ってから確かめる", async () => {
    const h = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0" });
    fs.mkdirSync(path.dirname(h.lockPath), { recursive: true });
    fs.writeFileSync(h.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    let released = false;
    setTimeout(() => {
      released = true;
      fs.unlinkSync(h.lockPath);
    }, 40);

    await h.manager.ensureRunning();

    expect(released).toBe(true);
    expect(h.daemon.count("thread/loaded/list")).toBe(0);
  });

  test("使用の印は lock を待つ前に置く（lock を見落として使い始めた呼び出しも、入れ替える側から見える）", async () => {
    const h = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0" });
    fs.mkdirSync(path.dirname(h.lockPath), { recursive: true });
    fs.writeFileSync(h.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    const running = h.manager.ensureRunning();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // lock が外れるのを待っている間に、もう印が置かれている。
    expect(fs.readdirSync(h.useMarkerDir)).toHaveLength(1);
    fs.unlinkSync(h.lockPath);
    await running;
  });

  test("pid がまだ書かれていない作成直後の startup lock も、外れるまで待つ", async () => {
    const h = harness({ serverVersion: "0.163.0", cliVersion: "0.163.0" });
    fs.mkdirSync(path.dirname(h.lockPath), { recursive: true });
    fs.writeFileSync(h.lockPath, "");
    let released = false;
    setTimeout(() => {
      released = true;
      fs.unlinkSync(h.lockPath);
    }, 40);

    await h.manager.ensureRunning();

    expect(released).toBe(true);
  });

  test("入れ替えようとして別 process の lock に当たったら、外れた後に起動を確かめ直す", async () => {
    let interrupted = false;
    const h = harness({
      // 版を確かめた直後に、別 process が lock を取って旧 daemon を止める（新しい daemon は起動できない）。
      onCliVersionRead: () => {
        if (interrupted) return;
        interrupted = true;
        fs.mkdirSync(path.dirname(h.lockPath), { recursive: true });
        fs.writeFileSync(h.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        setTimeout(() => {
          h.daemon.alive = false;
          fs.unlinkSync(h.lockPath);
        }, 40);
      },
    });

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.alive).toBe(true);
  });

  test("lock を取るまでに daemon が止まっていたら、止めずに起動し直す", async () => {
    let stopped = false;
    const h = harness({
      // 版を確かめた直後に daemon が自分で落ちる（入れ替えの lock を取る前）。
      onCliVersionRead: () => {
        if (stopped) return;
        stopped = true;
        h.daemon.alive = false;
      },
    });

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.alive).toBe(true);
  });

  test("止める直前の再確認までに daemon が止まっていたら、止めずに起動し直す", async () => {
    const h = harness({ replaceGraceMs: 40 });
    h.daemon.beforeLoadedList = (call) => {
      // 1 回目の確認の後、250ms 待ち（ここでは 40ms）の間に daemon が落ちる。
      if (call === 1) setTimeout(() => { h.daemon.alive = false; }, 5);
    };

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.alive).toBe(true);
  });

  test("古い startup lock は持ち主の pid が生きていても待たず、入れ替えで回収する", async () => {
    const h = harness();
    fs.mkdirSync(path.dirname(h.lockPath), { recursive: true });
    fs.writeFileSync(h.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 120_000 }));
    const started = Date.now();

    await h.manager.ensureRunning();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.signals).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
    expect(fs.existsSync(h.lockPath)).toBe(false);
  });

  test("自分の lock が回収されて別の持ち主の lock に替わっていたら、それは消さない", async () => {
    const h = harness({
      onLaunch: () => {
        // 起動中に「古い lock」として別 process に回収され、新しい lock が作られた。
        fs.unlinkSync(h.lockPath);
        fs.writeFileSync(h.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      },
    });
    h.daemon.alive = false;

    await h.manager.ensureRunning();

    expect(h.launches).toHaveLength(1);
    expect(fs.existsSync(h.lockPath)).toBe(true);
  });

  test("実物のプロセス操作は TAILII_CODEX_APP_SERVER_REPLACE=off で入れ替えない（テストが開発機の daemon を止めない）", async () => {
    expect(process.env["TAILII_CODEX_APP_SERVER_REPLACE"]).toBe("off");
    const daemon = new FakeDaemon("0.158.0");
    const manager = new CodexAppServerManager({
      codexHome: makeTempDir("codex-app-server-replace-off"),
      connect: async () => new FakeDaemonConnection(daemon),
      launch: () => {
        throw new Error("must not launch");
      },
      cliVersion: async () => "0.163.0",
      pollIntervalMs: 1,
    });

    await manager.ensureRunning();

    expect(daemon.count("thread/loaded/list")).toBe(0);
    expect(daemon.alive).toBe(true);
  });

  test("停止中の daemon は従来どおり起動する（入れ替え判定は通らない）", async () => {
    const h = harness();
    h.daemon.alive = false;

    await h.manager.ensureRunning();

    expect(h.signals).toEqual([]);
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.count("thread/loaded/list")).toBe(0);
  });
});

describe("compareVersions", () => {
  test.each([
    ["0.153.4", "0.158.0", -1],
    ["0.163.0", "0.163", 0],
    ["0.164.0", "0.163.9", 1],
    ["1.0", "0.999.999", 1],
    ["0.9.0", "0.10.0", -1],
  ] as const)("%s と %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe("codexAppServerProcess", () => {
  test("lsof -F pn の出力から socket の名前が一致する pid だけを拾う", () => {
    const output = [
      "p591",
      "f3",
      "n->0x8f88627045cf7719",
      "p86615",
      "f7",
      "n->0x203c2af89426c81",
      "f29",
      "n/private/tmp/codex-daemon-502/c7bbe4f8",
      "p700",
      "f4",
      // 前方一致だけの別名は拾わない。
      "n/private/tmp/codex-daemon-502/c7bbe4f8.lock",
      "p701",
      "f5",
      // Linux の lsof は名前の後ろに type= を付ける。
      "n/home/me/.codex/app-server-control/app-server-control.sock type=STREAM",
      "",
    ].join("\n");

    expect(parseLsofSocketPids(output, [
      "/Users/me/.codex/app-server-control/app-server-control.sock",
      "/private/tmp/codex-daemon-502/c7bbe4f8",
    ])).toEqual([86615]);
    expect(parseLsofSocketPids(output, ["/home/me/.codex/app-server-control/app-server-control.sock"])).toEqual([701]);
  });

  test("/proc/net/unix からパスが一致する socket の inode を拾う", () => {
    const content = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 23456 /tmp/codex-daemon-1000/abc",
      "0000000000000000: 00000003 00000000 00000000 0001 03 23457 /tmp/codex-daemon-1000/abc",
      "0000000000000000: 00000002 00000000 00010000 0001 01 23458 /run/other.sock",
      "0000000000000000: 00000003 00000000 00000000 0001 03 23459",
      "",
    ].join("\n");

    expect(parseProcNetUnixInodes(content, ["/tmp/codex-daemon-1000/abc"])).toEqual(["23456", "23457"]);
  });

  test("socket の候補名は symlink の先と実体のパスを含む", () => {
    const dir = makeTempDir("codex-socket-candidates");
    const target = path.join(dir, "real-socket");
    fs.writeFileSync(target, "");
    const link = path.join(dir, "app-server-control.sock");
    fs.symlinkSync(target, link);

    const candidates = socketPathCandidates(link);

    expect(candidates).toContain(link);
    expect(candidates).toContain(target);
    expect(candidates).toContain(fs.realpathSync(target));
    expect(socketPathCandidates(path.join(dir, "missing.sock"))).toEqual([path.join(dir, "missing.sock")]);
  });
});
