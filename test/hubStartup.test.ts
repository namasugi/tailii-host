// hubStartup.test.ts — hub の単一起動を実プロセスで競わせる（OS が解放する排他, node:sqlite）
//
// 10 個以上を到達バリアで揃えて同時に起動し、hub として動き出すのがちょうど 1 つであること。持ち主を kill -9 した直後
// （socket と lock のファイルが残ったまま）でも、ちょうど 1 つが引き継ぐこと。持ち主が終了の待ち（graceful shutdown）の
// 間は次が起動を見送り、終われば引き継ぐこと。HOME は隔離済み、lock と socket は一時ディレクトリに置く。

import { afterEach, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHubExclusiveLock, claimHubStartup, HubExclusiveLockError, hubExclusiveLockPath } from "../src/hub/hubStartup.js";
import { defaultHubLockPath, runHubCommand } from "../src/hub/hubDaemon.js";

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hub-startup-worker.mjs");
const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** 子プロセスを止めて終了を待ってから、一時ディレクトリを全部消す（隔離 HOME の外なので自分で片付ける）。 */
afterEach(async () => {
  const running = children.splice(0);
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(running.map(exited));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** macOS の unix socket は 104 バイトまでなので、短いパスの一時ディレクトリを使う（後で消す）。 */
function shortDir(prefix = "hs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** count 個の worker を起動し、全員がバリアに着いてから一斉に始めさせる。 */
async function race(count: number, lockPath: string, socketPath: string): Promise<{ barrier: string; won: () => string[]; lost: () => string[] }> {
  const barrier = shortDir("hb-");
  for (let index = 0; index < count; index += 1) {
    // 下限の Node 22.13 では `.ts` の型の除去が既定で無効なので明示する（24 では既定で有効・指定しても同じ）。
    children.push(spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", worker, lockPath, socketPath, barrier, String(index)], { stdio: "ignore" }));
  }
  const entries = () => fs.readdirSync(barrier);
  await waitFor(() => entries().filter((name) => name.startsWith("ready-")).length === count);
  fs.writeFileSync(path.join(barrier, "go"), "");
  await waitFor(() => entries().filter((name) => name.startsWith("won-") || name.startsWith("lost-")).length === count);
  return {
    barrier,
    won: () => entries().filter((name) => name.startsWith("won-")),
    lost: () => entries().filter((name) => name.startsWith("lost-")),
  };
}

function connectable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

function pidOf(entry: string): number {
  return Number(entry.split("-")[1]);
}

describe("hub の単一起動（実プロセス・node:sqlite の排他）", () => {
  it("12 個を同時に起動して、hub として動き出すのはちょうど 1 つ（5 回繰り返す）", async () => {
    for (let round = 0; round < 5; round += 1) {
      const dir = shortDir();
      const lockPath = path.join(dir, "hub.lock");
      const socketPath = path.join(dir, "h.sock");
      const result = await race(12, lockPath, socketPath);
      expect(result.won()).toHaveLength(1);
      expect(result.lost()).toHaveLength(11);
      expect(result.lost().every((name) => name.endsWith("exclusive-held"))).toBe(true);
      expect(await connectable(socketPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(pidOf(result.won()[0]!));
      const running = children.splice(0);
      for (const child of running) child.kill("SIGKILL");
      await Promise.all(running.map(exited));
    }
  }, 120_000);

  it("持ち主を kill -9 した直後（socket と lock のファイルが残る）でも、同時に起動した 12 個のうちちょうど 1 つが引き継ぐ", async () => {
    const dir = shortDir();
    const lockPath = path.join(dir, "hub.lock");
    const socketPath = path.join(dir, "h.sock");
    const first = await race(1, lockPath, socketPath);
    expect(first.won()).toHaveLength(1);
    const owner = children.find((child) => child.pid === pidOf(first.won()[0]!))!;
    owner.kill("SIGKILL");
    await waitFor(() => owner.signalCode !== null);
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    for (let round = 0; round < 3; round += 1) {
      const result = await race(12, lockPath, socketPath);
      expect(result.won()).toHaveLength(1);
      expect(await connectable(socketPath)).toBe(true);
      // 取り出した全部の子プロセス（勝者も敗者も）の終了を待ってから次へ進む。
      const running = children.splice(0);
      for (const child of running) child.kill("SIGKILL");
      await Promise.all(running.map(exited));
    }
  }, 120_000);

  it("持ち主が終了の待ち（socket を閉じた後・排他の解放前）に入った間は次が起動を見送り（何も消さない）、解放後に引き継ぐ", async () => {
    const dir = shortDir();
    const lockPath = path.join(dir, "hub.lock");
    const socketPath = path.join(dir, "h.sock");
    const first = await race(1, lockPath, socketPath);
    const ownerPid = pidOf(first.won()[0]!);
    // 終了の待ちに入った合図（socket は閉じて名前も消えた。排他と lock は持ったまま）。
    fs.writeFileSync(path.join(first.barrier, "stop"), "");
    await waitFor(() => fs.existsSync(path.join(first.barrier, `draining-${ownerPid}`)));
    expect(fs.existsSync(socketPath)).toBe(false);
    const during = await race(6, lockPath, socketPath);
    expect(during.won()).toHaveLength(0);
    expect(during.lost().every((name) => name.endsWith("exclusive-held"))).toBe(true);
    // 負けた側は lock を消していない。
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(ownerPid);
    // 解除のバリア → 持ち主が lock を消して排他を外す → 次が引き継ぐ。
    fs.writeFileSync(path.join(first.barrier, "release"), "");
    await waitFor(() => !fs.existsSync(lockPath));
    const after = await race(6, lockPath, socketPath);
    expect(after.won()).toHaveLength(1);
  }, 60_000);
});

describe("claimHubStartup（同じプロセス内）", () => {
  it("排他を持っている間は busy、解放後は取れる。従来版の hub が socket で応答していれば排他を返して退く", async () => {
    const dir = shortDir();
    const lockPath = path.join(dir, "hub.lock");
    const socketPath = path.join(dir, "h.sock");
    const first = await claimHubStartup({ lockPath, socketPath, version: "1" });
    expect(first.kind).toBe("claimed");
    expect(await claimHubStartup({ lockPath, socketPath, version: "1" })).toEqual({ kind: "busy", reason: "exclusive-held" });
    if (first.kind === "claimed") first.exclusive.release();
    // 排他を使わない従来版の hub が動いている（socket が応答する）。
    const legacy = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => legacy.listen(socketPath, resolve));
    try {
      expect(await claimHubStartup({ lockPath, socketPath, version: "1" })).toEqual({ kind: "busy", reason: "socket-alive" });
      // 退いた側は排他を返している。
      const again = acquireHubExclusiveLock(hubExclusiveLockPath(lockPath));
      expect(again).not.toBeNull();
      expect(again).not.toBe("unsupported");
      if (again !== null && again !== "unsupported") again.release();
    } finally {
      await new Promise<void>((resolve) => legacy.close(() => resolve()));
    }
  });
});

describe("5 周目: 移行中の従来版 hub・保存先の障害", () => {
  it("F2: hub.lock に生きている別の pid（listen 前の従来版）があれば、socket が応答し始めたら退く（その socket を消さない）", async () => {
    const dir = shortDir();
    const lockPath = path.join(dir, "hub.lock");
    const socketPath = path.join(dir, "h.sock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const legacy = net.createServer((socket) => socket.end());
    const listenLater = setTimeout(() => legacy.listen(socketPath), 150);
    try {
      const claim = await claimHubStartup({
        lockPath, socketPath, version: "new", isPidAlive: (pid) => pid === 999_999,
        legacyOwnerWaitMs: 3_000, legacyOwnerPollMs: 20,
      });
      expect(claim).toEqual({ kind: "busy", reason: "socket-alive" });
      expect(await connectable(socketPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(999_999);
    } finally {
      clearTimeout(listenLater);
      await new Promise<void>((resolve) => legacy.close(() => resolve()));
    }
  });

  it("F2: 従来版が応答しないまま待ちの上限を過ぎたら引き継ぐ（固まった従来版に永久に譲らない）", async () => {
    const dir = shortDir();
    const lockPath = path.join(dir, "hub.lock");
    const socketPath = path.join(dir, "h.sock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const started = Date.now();
    const claim = await claimHubStartup({
      lockPath, socketPath, version: "new", isPidAlive: (pid) => pid === 999_999,
      legacyOwnerWaitMs: 200, legacyOwnerPollMs: 20,
    });
    expect(claim.kind).toBe("claimed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    if (claim.kind === "claimed") claim.exclusive.release();
  });

  it("F8: 排他の DB が壊れている（SQLite ではない）と、既存の hub と誤診せず障害として投げる。DB ファイルは消さない", async () => {
    const dir = shortDir();
    const lockPath = path.join(dir, "hub.lock");
    fs.writeFileSync(hubExclusiveLockPath(lockPath), "this is not a sqlite database".repeat(100));
    await expect(claimHubStartup({ lockPath, socketPath: path.join(dir, "h.sock"), version: "1" }))
      .rejects.toBeInstanceOf(HubExclusiveLockError);
    expect(fs.readFileSync(hubExclusiveLockPath(lockPath), "utf8")).toContain("this is not a sqlite database");
  });

  it("F8: runHubCommand は保存先の障害を理由つきで記録して失敗終了する（1）", async () => {
    const home = os.homedir();
    if (!path.basename(home).startsWith("tlh-")) throw new Error("HOME が隔離されていません");
    const dbPath = hubExclusiveLockPath(defaultHubLockPath());
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const existed = fs.existsSync(dbPath);
    const saved = existed ? fs.readFileSync(dbPath) : null;
    fs.writeFileSync(dbPath, "broken".repeat(200));
    const logs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => { logs.push(String(chunk)); return true; };
    try {
      expect(await runHubCommand(["--once"])).toBe(1);
    } finally {
      (process.stderr as unknown as { write: typeof write }).write = write;
      if (saved !== null) fs.writeFileSync(dbPath, saved);
      else fs.rmSync(dbPath, { force: true });
    }
    expect(logs.join("")).toContain("hub の排他ロックを取れないため終了(失敗)");
  });
});

describe("6 周目: 応答しない従来版 hub を時間切れだけで追い越さない（R1）", () => {
  const base = (dir: string) => ({
    lockPath: path.join(dir, "hub.lock"), socketPath: path.join(dir, "h.sock"), version: "new",
    legacyOwnerWaitMs: 100, legacyOwnerPollMs: 10, legacyOwnerTerminateWaitMs: 1_000,
  });

  it("待ちの上限を過ぎても、実体が hub なら終了を要求し、待つ間に再開して listen したら退く（socket を消さない）", async () => {
    const dir = shortDir();
    const options = base(dir);
    fs.writeFileSync(options.lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const terminated: number[] = [];
    const legacy = net.createServer((socket) => socket.end());
    // 3 秒（ここでは 100ms）を超えて止まっていた従来版が 300ms 後に再開して listen する。終了の要求は無視する。
    const resume = setTimeout(() => legacy.listen(options.socketPath), 300);
    try {
      const claim = await claimHubStartup({
        ...options, isPidAlive: () => true, classifyProcess: () => "hub", sendTerminate: (pid) => terminated.push(pid),
      });
      expect(claim).toEqual({ kind: "busy", reason: "socket-alive" });
      expect(terminated).toEqual([999_999]);
      expect(await connectable(options.socketPath)).toBe(true);
    } finally {
      clearTimeout(resume);
      await new Promise<void>((resolve) => legacy.close(() => resolve()));
    }
  });

  it("実体が hub なら終了を要求し、終了を確かめてから引き継ぐ", async () => {
    const dir = shortDir();
    const options = base(dir);
    fs.writeFileSync(options.lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    let alive = true;
    const claim = await claimHubStartup({
      ...options, isPidAlive: (pid) => pid === 999_999 && alive, classifyProcess: () => "hub",
      sendTerminate: () => { setTimeout(() => { alive = false; }, 50); },
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "claimed") claim.exclusive.release();
  });

  it("終了の要求にも応じなければ起動を諦める（failed）。実体が hub でない pid（再利用）には何も送らずに引き継ぐ", async () => {
    const stuck = shortDir();
    const stuckOptions = base(stuck);
    fs.writeFileSync(stuckOptions.lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const failed = await claimHubStartup({
      ...stuckOptions, legacyOwnerTerminateWaitMs: 100, isPidAlive: () => true, classifyProcess: () => "hub", sendTerminate: () => {},
    });
    expect(failed).toEqual({ kind: "failed", reason: "legacy-owner-unresponsive", pid: 999_999 });
    // 諦めた側は排他を返している（次の起動で取り直せる）。
    const again = acquireHubExclusiveLock(hubExclusiveLockPath(stuckOptions.lockPath));
    expect(again).not.toBeNull();
    if (again !== null && again !== "unsupported") again.release();

    const reused = shortDir();
    const reusedOptions = base(reused);
    fs.writeFileSync(reusedOptions.lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const terminated: number[] = [];
    const claim = await claimHubStartup({
      ...reusedOptions, isPidAlive: () => true, classifyProcess: () => "other", sendTerminate: (pid) => terminated.push(pid),
    });
    expect(claim.kind).toBe("claimed");
    expect(terminated).toEqual([]);
    if (claim.kind === "claimed") claim.exclusive.release();
  });
});

describe("7 周目: 旧所有者の実体を確認できないときは引き継がない（②・③）", () => {
  const base = (dir: string) => ({
    lockPath: path.join(dir, "hub.lock"), socketPath: path.join(dir, "h.sock"), version: "new",
    legacyOwnerWaitMs: 150, legacyOwnerPollMs: 10, legacyOwnerTerminateWaitMs: 200,
  });

  it("②: 生きている旧 pid が hub か確認できない（ps の失敗等）なら、SIGTERM も引き継ぎもせず failed", async () => {
    const dir = shortDir();
    const options = base(dir);
    fs.writeFileSync(options.lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const terminated: number[] = [];
    const claim = await claimHubStartup({
      ...options, isPidAlive: () => true, classifyProcess: () => "unknown", sendTerminate: (pid) => terminated.push(pid),
    });
    expect(claim).toEqual({ kind: "failed", reason: "owner-unverifiable", pid: 999_999 });
    expect(terminated).toEqual([]);
    expect(JSON.parse(fs.readFileSync(options.lockPath, "utf8")).pid).toBe(999_999);
  });

  it("③: 待つ間に lock が読めなくなっても、旧 pid が生きている限り終了したとはみなさない", async () => {
    const dir = shortDir();
    const options = base(dir);
    fs.writeFileSync(options.lockPath, JSON.stringify({ pid: 999_999, version: "old" }));
    const breakLock = setTimeout(() => fs.chmodSync(options.lockPath, 0o000), 20);
    try {
      const claim = await claimHubStartup({ ...options, isPidAlive: () => true, classifyProcess: () => "unknown" });
      expect(claim).toEqual({ kind: "failed", reason: "owner-unverifiable", pid: 999_999 });
    } finally {
      clearTimeout(breakLock);
      fs.chmodSync(options.lockPath, 0o600);
    }
  });
});
