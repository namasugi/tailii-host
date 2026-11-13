import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyHubProcessAsync } from "../src/hub/hubStartup.js";
import { readPackageVersion } from "../src/shared/version.js";
import { makeTempDir } from "./helpers.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { delegateHubToGateway as delegate, type GatewaySpawnOptions } from "../src/hub/gatewaySpawn.js";
import { shimContent } from "../src/commands/doctor.js";

// 委譲プロトコルの単体テスト。実ソケットの結合テストは gatewaySpawn.test.ts に残す。
vi.mock("node:net", () => ({ createConnection: vi.fn() }));
vi.mock("../src/hub/hubStartup.js", async (original) => ({
  ...await original<typeof import("../src/hub/hubStartup.js")>(), classifyHubProcessAsync: vi.fn(async () => "other"),
}));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
let shimPath: string, cliPath: string;
beforeEach(() => {
  const dir = makeTempDir("gateway shim's ");
  cliPath = path.join(dir, "cli.js"); shimPath = path.join(dir, "tailii-host");
  fs.writeFileSync(cliPath, "// fixture\n");
  fs.writeFileSync(shimPath, shimContent(process.execPath, cliPath));
});
function delegateHubToGateway(options: GatewaySpawnOptions = {}) {
  return delegate({ shimPath, cliPath, ...options });
}

it.each(["same", "symlink", "other", "missing", "unknown"])("シムの参照先を実体パスで確かめてから移動を頼む: %s", async (kind) => {
  fakeSocket();
  const log = vi.fn();
  if (kind === "missing") fs.unlinkSync(shimPath);
  if (kind === "unknown") fs.writeFileSync(shimPath, '#!/bin/sh\nexec node "$@"\n');
  if (kind === "other" || kind === "symlink") {
    const target = path.join(path.dirname(cliPath), "other cli.js");
    if (kind === "symlink") fs.symlinkSync(cliPath, target);
    else fs.writeFileSync(target, "// other version\n");
    fs.writeFileSync(shimPath, shimContent(process.execPath, target));
  }
  const same = kind === "same" || kind === "symlink";
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => true, log })).toBe(same);
  expect(createConnection).toHaveBeenCalledTimes(same ? 1 : 0);
  expect(log).toHaveBeenCalledTimes(same ? 0 : 1);
  if (!same) expect(log).toHaveBeenCalledWith(expect.stringContaining(kind === "other"
    ? "別の cli.js" : kind === "missing" ? "読めない" : "生成形式"));
});

function manualShim(nodePath: string, target: string): string {
  // 開発機の shim.sample.txt と同じ構成。実物のシムには触れず、パスをテスト用に置き換える。
  return [
    "#!/bin/sh",
    "# tailii-host — Tailii host (TypeScript / host-ts) launcher.",
    "# host はコンパイル済みバイナリではなく TS。node は SSH 非対話シェルの PATH に",
    "# 乗らないため mise の node 絶対パスで dist/cli.js を起動するだけの薄いシム。",
    "# shim 経由にすると mise のグローバル設定 (~/.config/mise/config.toml) の",
    "# node バージョンへ自動追従する(バージョン直書きだと Node 更新時に取り残される)。",
    `NODE=${nodePath}`,
    `TS_CLI=${target}`,
    'exec "$NODE" "$TS_CLI" "$@"',
    "",
  ].join("\n");
}

it("手動管理のサンプルと同じシムでも現行 cli.js への移動を頼む", async () => {
  cliPath = path.join(makeTempDir("gateway-manual"), "cli.js");
  fs.writeFileSync(cliPath, "// fixture\n");
  fs.writeFileSync(shimPath, manualShim(process.execPath, cliPath));
  const socket = fakeSocket(), log = vi.fn();
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => true, log })).toBe(true);
  expect(createConnection).toHaveBeenCalledOnce();
  expect(socket.write).toHaveBeenCalledExactlyOnceWith('{"spawn":"hub"}\n');
  expect(log).not.toHaveBeenCalled();
});

it.each([
  { name: "コメント・空行の位置と任意の変数名", body: (node: string, cli: string) =>
    `#!/bin/sh\n\n  # before\n_ENTRY_2="${cli}"\n\n# between\n_RUNTIME_1="${node}"\n# before exec\nexec "$_RUNTIME_1" "$_ENTRY_2" "$@"\n# after exec\n\n` },
  { name: "bash と二重引用符つきの代入", body: (node: string, cli: string) =>
    `#!/bin/bash\nNODE="${node}"\nTS_CLI="${cli}"\nexec "$NODE" "$TS_CLI" "$@"\n` },
  { name: "env sh と単一引用符つきの代入", body: (node: string, cli: string) =>
    `#!/usr/bin/env sh\nNODE='${node}'\nTS_CLI='${cli}'\nexec "$NODE" "$TS_CLI" "$@"\n` },
  { name: "env bash と直接の CLI パス", body: (node: string, cli: string) =>
    `#!/usr/bin/env bash\nNODE="${node}"\nexec "$NODE" "${cli}" "$@"` },
])("単純な手動シムを読む: $name", async ({ body }) => {
  cliPath = path.join(makeTempDir("gateway manual"), "cli.js");
  fs.writeFileSync(cliPath, "// fixture\n");
  fs.writeFileSync(shimPath, body(process.execPath, cliPath));
  fakeSocket();
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => true })).toBe(true);
  expect(createConnection).toHaveBeenCalledOnce();
});

it("手動シムの exec に未引用の絶対 CLI パスを直接書ける", async () => {
  cliPath = path.join(makeTempDir("gateway-manual"), "cli.js");
  fs.writeFileSync(cliPath, "// fixture\n");
  fs.writeFileSync(shimPath, `#!/bin/sh\nNODE=${process.execPath}\nexec "$NODE" ${cliPath} "$@"\n`);
  fakeSocket();
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => true })).toBe(true);
  expect(createConnection).toHaveBeenCalledOnce();
});

it.each(["double", "single"])("手動シムの %s 引用符内の文字をパスとして正確に読む", async (quote) => {
  cliPath = path.join(makeTempDir("gateway manual"), 'cli"\\entry.js');
  fs.writeFileSync(cliPath, "// fixture\n");
  const literal = (value: string) => quote === "double" ? `"${value.replace(/["\\]/g, '\\$&')}"` : `'${value}'`;
  fs.writeFileSync(shimPath, `#!/bin/sh\nNODE=${literal(process.execPath)}\nTS_CLI=${literal(cliPath)}\nexec "$NODE" "$TS_CLI" "$@"\n`);
  fakeSocket();
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => true })).toBe(true);
  expect(createConnection).toHaveBeenCalledOnce();
});

it.each(["symlink", "other"])("手動シムの CLI パスも実体パスで比較する: %s", async (kind) => {
  const target = path.join(makeTempDir("gateway-manual-target"), "cli.js");
  if (kind === "symlink") fs.symlinkSync(cliPath, target);
  else fs.writeFileSync(target, "// other version\n");
  fs.writeFileSync(shimPath, manualShim(process.execPath, target));
  fakeSocket();
  const log = vi.fn();
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => true, log })).toBe(kind === "symlink");
  expect(createConnection).toHaveBeenCalledTimes(kind === "symlink" ? 1 : 0);
  if (kind === "other") expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("別の cli.js"));
});

it.each([
  { name: "コマンド置換", change: (body: string) => body.replace('NODE="', 'NODE="/tmp/$(printf node)/') },
  { name: "変数展開", change: (body: string) => body.replace('TS_CLI="', 'TS_CLI="/tmp/${HOME}/') },
  { name: "単一引用符内の変数展開", change: (body: string) => body.replace('NODE="', "NODE='/tmp/${HOME}").replace('"\nTS_CLI=', "'\nTS_CLI=") },
  { name: "バッククォート", change: (body: string) => body.replace('NODE="', 'NODE="/tmp/`printf node`/') },
  { name: "代入のセミコロン", change: (body: string) => body.replace('\nTS_CLI=', '; TS_CLI=') },
  { name: "exec のセミコロン", change: (body: string) => body.replace(' "$@"', ' "$@"; echo extra') },
  { name: "&&", change: (body: string) => body.replace('\nexec ', ' && exec ') },
  { name: "複数の exec", change: (body: string) => body + 'exec "$NODE" "$TS_CLI" "$@"\n' },
  { name: "代入の重複", change: (body: string) => body.replace('\nexec ', '\nNODE=/tmp/other-node\nexec ') },
  { name: "未使用の代入のコマンド置換", change: (body: string) => body.replace('\nexec ', '\nEXTRA=/tmp/$(printf extra)\nexec ') },
  { name: "条件分岐", change: (body: string) => body.replace('\nexec ', '\nif true; then\nexec ') + 'fi\n' },
  { name: "未定義の変数", change: (body: string) => body.replace('exec "$NODE"', 'exec "$UNKNOWN"') },
  { name: "未定義の CLI 変数", change: (body: string) => body.replace('"$TS_CLI"', '"$UNKNOWN"') },
  { name: "exec 内の変数展開", change: (body: string) => body.replace('"$TS_CLI"', '"${TS_CLI}"') },
  { name: "相対パス", change: (body: string) => body.replace('NODE="', 'NODE="relative/') },
  { name: "未引用の glob", change: (body: string) => body.replace(/NODE=.*\n/, 'NODE=/tmp/*/node\n') },
  { name: "引用符の連結", change: (body: string) => body.replace('NODE="', 'NODE="/tmp""') },
  { name: "リダイレクト", change: (body: string) => body.replace(' "$@"', ' "$@" >/tmp/log') },
  { name: "パイプ", change: (body: string) => body.replace(' "$@"', ' "$@" | cat') },
  { name: "余分な引数", change: (body: string) => body.replace(' "$@"', ' --extra "$@"') },
  { name: "exec 後の代入", change: (body: string) => body + 'EXTRA=/tmp/extra\n' },
])("展開や複合構文を含む手動シムは依頼前に見送る: $name", async ({ change }) => {
  const body = `#!/bin/sh\nNODE="${process.execPath}"\nTS_CLI="${cliPath}"\nexec "$NODE" "$TS_CLI" "$@"\n`;
  fs.writeFileSync(shimPath, change(body));
  fakeSocket();
  const log = vi.fn(), hasConfirmedHub = vi.fn(() => true);
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub, log })).toBe(false);
  expect(createConnection).not.toHaveBeenCalled();
  expect(hasConfirmedHub).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("生成形式"));
});

it.each(["directory", "oversize"])("シムが通常の小さなファイルでなければ読む前に見送る: %s", async (kind) => {
  const log = vi.fn();
  if (kind === "directory") { fs.unlinkSync(shimPath); fs.mkdirSync(shimPath); }
  else fs.writeFileSync(shimPath, "x".repeat(64 * 1024 + 1));
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, log })).toBe(false);
  expect(createConnection).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(kind === "directory" ? "通常ファイル" : "64KiB"));
});

it("シムの非同期読み取りが止まっても期限で自己起動へ戻る", async () => {
  vi.useFakeTimers();
  vi.spyOn(fs.promises, "open").mockImplementation(() => new Promise(() => {}));
  const log = vi.fn();
  const result = delegateHubToGateway({ platform: "darwin", env: {}, log });
  await vi.advanceTimersByTimeAsync(300);
  expect(await result).toBe(false);
  expect(createConnection).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("読み取りが時間切れ"));
});

function fakeSocket(reply = '{"ok":true}\n') {
  const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: () => void; setEncoding: () => void };
  socket.write = vi.fn(() => queueMicrotask(() => socket.emit("data", reply)));
  socket.destroy = () => { socket.emit("close"); };
  socket.setEncoding = () => {};
  vi.mocked(createConnection).mockImplementation(() => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as Socket;
  });
  return socket;
}

it.each([
  { platform: "linux" as const, env: {} },
  { platform: "darwin" as const, env: { TAILII_HUB_VIA_GATEWAY: "1" } },
  { platform: "darwin" as const, env: {}, args: ["--once"] },
  { platform: "darwin" as const, env: {}, args: ["--interval-seconds", "60"] },
])("印あり・darwin 以外・引数つきは gateway に依頼しない: %j", async (options) => {
  expect(await delegateHubToGateway(options)).toBe(false);
  expect(createConnection).not.toHaveBeenCalled();
});

it("ACK だけでは終了せず、後継 lock の確認まで短い間隔で待つ", async () => {
  const socket = fakeSocket();
  let now = 0;
  const hasConfirmedHub = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub, now: () => now, sleep })).toBe(true);
  expect(socket.write).toHaveBeenCalledWith('{"spawn":"hub"}\n');
  expect(sleep.mock.calls).toEqual([[50], [50]]);
});

it("後継 lock が無ければ既定の 5 秒で自己起動へ戻る", async () => {
  fakeSocket();
  let now = 0;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub: () => false, now: () => now, sleep })).toBe(false);
  expect(now).toBe(5_000);
  expect(sleep).toHaveBeenCalledTimes(100);
});

it("不正 ACK では後継 lock を待たずに自己起動へ戻る", async () => {
  fakeSocket('{"ok":false}\n');
  const hasConfirmedHub = vi.fn();
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, hasConfirmedHub })).toBe(false);
  expect(hasConfirmedHub).not.toHaveBeenCalled();
});

it.each([
  { reply: '{"ok":true,"pid":123456}\n', pid: 123456, version: "old", identity: "other", expected: false },
  { reply: '{"ok":true,"pid":123456}\n', pid: 123456, version: "current", identity: "other", expected: true },
  { reply: '{"ok":true,"pid":123456}\n', pid: 123455, version: "old", identity: "hub", expected: false },
  { reply: '{"ok":true,"pid":123456}\n', pid: 123455, version: "current", identity: "hub", expected: true },
  { reply: '{"ok":true}\n', pid: 123455, version: "old", identity: "hub", expected: false },
  { reply: '{"ok":true}\n', pid: 123455, version: "current", identity: "hub", expected: true },
  { reply: '{"ok":true}\n', pid: 123455, version: "current", identity: "other", expected: false },
  { reply: '{"ok":true}\n', pid: 123455, version: "current", identity: "unknown", expected: false },
  { reply: '{"ok":true,"pid":0}\n', pid: 123455, version: "old", identity: "hub", expected: false },
  { reply: '{"ok":true,"pid":123456}\n', pid: process.pid, version: "current", identity: "hub", expected: false },
])("要求の子でも現行版だけを採用し、pid が違えば実体も確かめる: %j", async ({ reply, pid, version, identity, expected }) => {
  fakeSocket(reply);
  const lockPath = path.join(makeTempDir("gateway-lock"), "hub.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid, version: version === "current" ? readPackageVersion() : version }));
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(classifyHubProcessAsync).mockResolvedValue(identity as "hub" | "other" | "unknown");
  let now = 0;
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, lockPath, now: () => now, sleep: async (ms) => { now += ms; } })).toBe(expected);
  expect(now).toBe(expected || pid === 123456 ? 0 : 5_000);
  if (pid === 123456) expect(classifyHubProcessAsync).not.toHaveBeenCalled();
});

it.each(["old-shim-version", null])("依頼後に版 %s の lock が現れたら、直後に自己起動側へ戻る", async (version) => {
  fakeSocket('{"ok":true,"pid":123456}\n');
  const lockPath = path.join(makeTempDir("gateway-old-shim"), "hub.lock");
  vi.spyOn(process, "kill").mockReturnValue(true);
  let now = 0;
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 123456, version }));
  });
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, lockPath, now: () => now, sleep })).toBe(false);
  expect(now).toBe(50);
  expect(sleep).toHaveBeenCalledOnce();
  expect(classifyHubProcessAsync).not.toHaveBeenCalled();
});

it("ACK の pid が死んでいれば採用しない", async () => {
  fakeSocket('{"ok":true,"pid":123456}\n');
  const lockPath = path.join(makeTempDir("gateway-dead"), "hub.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 123456, version: readPackageVersion() }));
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  let now = 0;
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, lockPath, now: () => now, sleep: async (ms) => { now += ms; } })).toBe(false);
  expect(now).toBe(5_000);
});

it("実体確認の間に lock が変われば古い結果を採用しない", async () => {
  fakeSocket();
  const lockPath = path.join(makeTempDir("gateway-changed"), "hub.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 123456, version: readPackageVersion() }));
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(classifyHubProcessAsync).mockImplementation(async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: readPackageVersion() }));
    return "hub";
  });
  let now = 0;
  expect(await delegateHubToGateway({ platform: "darwin", env: {}, lockPath, now: () => now, sleep: async (ms) => { now += ms; } })).toBe(false);
});

it("実体確認が返らなくても待ち時間は最大 5 秒", async () => {
  fakeSocket();
  let started = false, ready!: () => void;
  const afterShimRead = new Promise<void>((resolve) => { ready = resolve; });
  const result = delegateHubToGateway({ platform: "darwin", env: {},
    hasConfirmedHub: () => new Promise(() => {}), now: () => {
      // シムの実ファイル読み取り後にだけ時計を差し替え、後継確認の 5 秒を検証する。
      if (!started) { started = true; vi.useFakeTimers(); ready(); }
      return Date.now();
    },
  });
  await afterShimRead;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toBe(false);
});
