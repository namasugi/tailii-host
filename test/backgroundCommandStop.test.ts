import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseLsofWriters,
  parsePsPgids,
  stopBackgroundCommandProcess,
  type BackgroundCommandStopDeps,
} from "../src/chat/backgroundCommandStop.js";
import { fileBackgroundStopRecords } from "../src/chat/backgroundStopRecords.js";

type FakeDeps = BackgroundCommandStopDeps & { killed: [number, string][]; alive: Set<number> };

/**
 * 偽のプロセス表。writers は書き込み元、alive は生きている対象（負の数 = グループ）。
 * dieOn: 対象ごとに、どのシグナルで消えるか（無ければ消えない）。
 */
function fakeDeps(options: {
  writers: { pid: number; pgid: number }[];
  alive: number[];
  dieOn?: Record<number, "SIGTERM" | "SIGKILL">;
  fileExists?: boolean;
}): FakeDeps {
  const killed: [number, string][] = [];
  const alive = new Set(options.alive);
  let now = 0;
  return {
    killed,
    alive,
    fileExists: () => options.fileExists ?? true,
    listWriters: async () => options.writers,
    kill: (target, signal) => {
      killed.push([target, signal]);
      const dies = options.dieOn?.[target];
      if (dies === signal || (dies === "SIGTERM" && signal === "SIGKILL")) alive.delete(target);
    },
    exists: (target) => alive.has(target),
    sleep: async (ms) => { now += ms; },
    selfPid: 5000,
    selfPgid: async () => 5000,
    get now() { return now; },
  } as FakeDeps;
}

/** 偽の時計で猶予を進める（sleep のたびに Date.now() を進める）。 */
async function withFakeClock<T>(run: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
  let now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return await run((ms) => { now += ms; });
  } finally {
    Date.now = realNow;
  }
}

describe("backgroundCommandStop", () => {
  test("lsof -F pa の出力から書き込み用（w/u）の保持者だけを読む", () => {
    expect(parseLsofWriters("p92957\nf1\naw\nf2\naw\np92958\nf1\naw\np5771\nf25\nar\np7\nf3\nau\n"))
      .toEqual([92957, 92958, 7]);
    expect(parsePsPgids("92957 92957\n 92958 92957\n")).toEqual([
      { pid: 92957, pgid: 92957 }, { pid: 92958, pgid: 92957 },
    ]);
  });

  test("先頭が書き込み元のグループはグループごと SIGTERM し、グループが消えたら stopped（SIGTERM の直前に onSignal）", async () => {
    const deps = fakeDeps({
      writers: [{ pid: 100, pgid: 100 }, { pid: 101, pgid: 100 }], alive: [-100], dieOn: { [-100]: "SIGTERM" },
    });
    const signalled: number[] = [];
    const result = await stopBackgroundCommandProcess("/tmp/t/x.output", {
      onSignal: (atMs) => { signalled.push(atMs); expect(deps.killed).toEqual([]); },
    }, deps);
    expect(result.status).toBe("stopped");
    expect(signalled).toHaveLength(1);
    expect(deps.killed).toEqual([[-100, "SIGTERM"]]);
  });

  test("書き込み元が消えてもグループの誰かが残っていれば待ち、残りへ SIGKILL を送る（SIGTERM を無視する孫）", async () => {
    // 先頭は SIGTERM で終わる（書き込み元は 0 になる）が、出力を別のファイルへ向けた孫が SIGTERM を
    // 無視してグループに残る。グループが消えるまで stopped にしない。
    await withFakeClock(async (advance) => {
      const deps = fakeDeps({ writers: [{ pid: 100, pgid: 100 }], alive: [-100], dieOn: { [-100]: "SIGKILL" } });
      deps.sleep = async (ms) => { advance(ms); };
      const result = await stopBackgroundCommandProcess("/tmp/t/x.output", {}, deps);
      expect(deps.killed).toEqual([[-100, "SIGTERM"], [-100, "SIGKILL"]]);
      expect(result.status).toBe("stopped");
    });
  });

  test("SIGKILL でも残れば failed（onSignal は呼ばれている＝呼び出し側が記録を外す）", async () => {
    await withFakeClock(async (advance) => {
      const deps = fakeDeps({ writers: [{ pid: 300, pgid: 300 }], alive: [-300] });
      deps.sleep = async (ms) => { advance(ms); };
      let signalled = false;
      const result = await stopBackgroundCommandProcess("/tmp/t/x.output", { onSignal: () => { signalled = true; } }, deps);
      expect(result).toMatchObject({ status: "failed" });
      expect(signalled).toBe(true);
    });
  });

  test("先頭が書き込み元でないグループ（claude 本体と同じグループ等）は止めず、書き込み元だけを止める", async () => {
    const deps = fakeDeps({ writers: [{ pid: 201, pgid: 200 }], alive: [201, -200], dieOn: { 201: "SIGTERM" } });
    expect((await stopBackgroundCommandProcess("/tmp/t/x.output", {}, deps)).status).toBe("stopped");
    expect(deps.killed).toEqual([[201, "SIGTERM"]]);
  });

  test("host 自身・host のグループ・pid 1 以下は止めない", async () => {
    // 5001 は host のグループに属するので、グループではなく 5001 だけが対象になる。
    const sameGroup = fakeDeps({ writers: [{ pid: 5001, pgid: 5000 }], alive: [5001], dieOn: { 5001: "SIGTERM" } });
    expect((await stopBackgroundCommandProcess("/tmp/t/x.output", {}, sameGroup)).status).toBe("stopped");
    expect(sameGroup.killed).toEqual([[5001, "SIGTERM"]]);
    const onlySelf = fakeDeps({ writers: [{ pid: 5000, pgid: 5000 }, { pid: 1, pgid: 1 }], alive: [5000] });
    expect((await stopBackgroundCommandProcess("/tmp/t/x.output", {}, onlySelf)).status).toBe("not_running");
    expect(onlySelf.killed).toEqual([]);
  });

  test("書き込み元がいなければ not_running、出力ファイルが無ければ not_found、調べられなければ failed（どれも送らない）", async () => {
    let signalled = false;
    const onSignal = (): void => { signalled = true; };
    expect((await stopBackgroundCommandProcess("/tmp/t/x.output", { onSignal }, fakeDeps({ writers: [], alive: [] }))).status)
      .toBe("not_running");
    expect((await stopBackgroundCommandProcess(null, { onSignal }, fakeDeps({ writers: [], alive: [] }))).status)
      .toBe("not_found");
    // 出力ファイルが消されている（lsof はパスで探せないので「保持者なし」に見える）→ not_running にしない。
    const deleted = fakeDeps({ writers: [], alive: [], fileExists: false });
    expect((await stopBackgroundCommandProcess("/tmp/t/x.output", { onSignal }, deleted)).status).toBe("not_found");
    const unknown = fakeDeps({ writers: [], alive: [] });
    unknown.listWriters = async () => null;
    expect(await stopBackgroundCommandProcess("/tmp/t/x.output", { onSignal }, unknown)).toMatchObject({ status: "failed" });
    expect(signalled).toBe(false);
  });

  describe("実プロセス", () => {
    function setupDir(): { dir: string; output: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-stop-"));
      const output = path.join(dir, "btest.output");
      fs.writeFileSync(output, "");
      return { dir, output };
    }

    test("出力ファイルへ書くグループ（sh と子の sleep）を止め、読むだけのプロセスは残す", async () => {
      const { dir, output } = setupDir();
      // CLI と同じく、新しいプロセスグループの先頭（sh）と子（sleep）が出力ファイルを書き込み用に開く。
      const group = spawn("/bin/sh", ["-c", "sleep 60; echo done"], {
        detached: true, stdio: ["ignore", fs.openSync(output, "a"), fs.openSync(output, "a")],
      });
      // 出力ファイルを読むだけのプロセス（別グループ）。止めてはいけない。
      const reader = spawn("/bin/sh", ["-c", `exec 3<"${output}"; sleep 60`], { detached: true, stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await stopBackgroundCommandProcess(output)).status).toBe("stopped");
        expect(() => process.kill(-group.pid!, 0)).toThrow();
        expect(() => process.kill(reader.pid!, 0)).not.toThrow();
        expect((await stopBackgroundCommandProcess(output)).status).toBe("not_running");
      } finally {
        try { process.kill(-group.pid!, "SIGKILL"); } catch { /* 停止済み */ }
        try { process.kill(-reader.pid!, "SIGKILL"); } catch { /* 停止済み */ }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    test("SIGTERM を無視して出力を別ファイルへ向けた孫もグループごと止める（SIGKILL まで進む）", async () => {
      const { dir, output } = setupDir();
      const own = path.join(dir, "own.log");
      // 孫: SIGTERM を無視し、出力を自分のログへ向ける（出力ファイルの書き込み元ではなくなる）。
      const group = spawn("/bin/sh", ["-c", `sh -c 'trap "" TERM; exec >"${own}" 2>&1; sleep 60' & sleep 60`], {
        detached: true, stdio: ["ignore", fs.openSync(output, "a"), fs.openSync(output, "a")],
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await stopBackgroundCommandProcess(output)).status).toBe("stopped");
        expect(() => process.kill(-group.pid!, 0)).toThrow();
      } finally {
        try { process.kill(-group.pid!, "SIGKILL"); } catch { /* 停止済み */ }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  });
});

describe("backgroundStopRecords（ファイル）", () => {
  test("書いた記録を別インスタンス（hub の再起動相当）で読め、消せる。古い記録は捨てる", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-stop-records-"));
    const file = path.join(dir, "host", "background-command-stops.json");
    try {
      const now = 1_800_000_000_000;
      const first = fileBackgroundStopRecords(file, () => now);
      first.set("bold", now - 31 * 24 * 60 * 60 * 1000);
      first.set("b1", now - 1000);
      const second = fileBackgroundStopRecords(file, () => now);
      expect(second.get("b1")).toBe(now - 1000);
      expect(second.get("bold")).toBeNull();
      second.delete("b1");
      expect(fileBackgroundStopRecords(file, () => now).get("b1")).toBeNull();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("壊れたファイルは空として扱う", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-stop-records-bad-"));
    const file = path.join(dir, "stops.json");
    fs.writeFileSync(file, "{not json");
    try {
      expect(fileBackgroundStopRecords(file).get("b1")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
