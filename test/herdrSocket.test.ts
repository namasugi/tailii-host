// herdrSocket.test.ts — 実物を使わず、Unix socket 上で CLI 互換・再送境界・接続の独立性を確かめる。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { herdrSessionSocketPath, socketHerdrCommandRunner } from "../src/backend/herdrSocket.js";
import { defaultHerdrCommandRunner, HerdrSessionManager, herdrErrorCode, type HerdrCommandResult } from "../src/backend/herdr.js";
import { launchCore } from "../src/commands/launch.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
const PANE = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term1",
  focused: false, agent_status: "idle", revision: 1, label: "s-test" };
const TAB = { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "1", focused: false, pane_count: 1, agent_status: "idle" };
const WORKSPACE = { workspace_id: "w1", number: 1, label: "tailii", focused: false, pane_count: 1,
  tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" };
const PONG = { type: "pong", protocol: 22, version: "0.9.5" };
const CLI: HerdrCommandResult = { exitCode: 7, stdout: "cli stdout", stderr: "cli stderr" };
const fixtures: Array<{ dir: string; server: Server; sockets: Set<Socket>; timers: Set<NodeJS.Timeout> }> = [];
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync("/tmp/hs-"); dirs.push(dir); return dir; };
const send = (socket: Socket, request: Request, result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");

/** ping と操作は常に別接続。テストで EPERM を捕捉して成功扱いにはしない。 */
async function fakeServer(
  handler: (request: Request, socket: Socket, later: (fn: () => void, ms: number) => void) => void,
  options: { ping?: unknown; socketPath?: string; handlePing?: boolean } = {},
) {
  const dir = temp();
  const socketPath = options.socketPath ?? path.join(dir, "s");
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const requests: Request[] = [];
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(text.slice(0, end)) as Request;
      text = "";
      requests.push(request);
      if (request.method === "ping" && !options.handlePing) send(socket, request, options.ping ?? PONG);
      else handler(request, socket, later);
    });
  });
  fixtures.push({ dir, server, sockets, timers });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const cli = vi.fn(async (_args: string[], _timeoutMs: number) => CLI);
  const runner = socketHerdrCommandRunner(cli, { sessionName: "test", timeoutMs: 1_000, socketPath });
  return { runner, cli, socketPath, requests, sockets, server };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { server, sockets, timers } of fixtures.splice(0)) {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("herdr socket の選択と CLI fallback", () => {
  test("明示 session は環境の外側の socket より優先し、XDG_CONFIG_HOME に従う", () => {
    const env = { HOME: "/home/test", XDG_CONFIG_HOME: "/config", HERDR_SOCKET_PATH: "/wrong.sock", HERDR_SESSION: "wrong" };
    expect(herdrSessionSocketPath("tailii", env)).toBe("/config/herdr/sessions/tailii/herdr.sock");
    expect(herdrSessionSocketPath("default", env)).toBe("/config/herdr/herdr.sock");
    expect(herdrSessionSocketPath("test", { HOME: "/home/test" })).toBe("/home/test/.config/herdr/sessions/test/herdr.sock");
    expect(herdrSessionSocketPath("../wrong", env)).toBeNull();
  });

  test.each([["server", "stop"], ["server"], ["status"], ["--version"], ["pane", "list", "--unknown"],
    ["pane", "read", "w1:p1", "--lines", "-1"], ["pane", "read", "w1:p1", "--lines", "4294967296"],
    ["pane", "send-text", "w1:p1", "\0"], ["tab", "create", "--env", "wrong"]])("未対応の引数はそのまま CLI へ: %j", async (...args) => {
    const cli = vi.fn(async () => CLI);
    const run = socketHerdrCommandRunner(cli, { sessionName: "tailii", timeoutMs: 15_000,
      env: { TAILII_HERDR_TRANSPORT: "socket" }, socketPath: "/does/not/exist" });
    expect(await run(args)).toEqual(CLI);
    expect(cli).toHaveBeenCalledWith(args, expect.any(Number));
  });

  test.each([undefined, "cli", "", "other"])("socket を明示しない設定（%s）は実在する socket に接続せず CLI の結果を返す", async (transport) => {
    vi.stubEnv("TAILII_HERDR_TRANSPORT", transport);
    const f = await fakeServer((req, socket) => send(socket, req, { type: "pane_list", panes: [] }));
    const connected = vi.fn();
    f.server.on("connection", connected);
    expect(fs.statSync(f.socketPath).isSocket()).toBe(true);
    const args = ["pane", "list"];
    expect(await f.runner(args)).toEqual(CLI);
    expect(f.cli).toHaveBeenCalledOnce();
    expect(f.cli).toHaveBeenCalledWith(args, expect.any(Number));
    expect(connected).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  test.each([undefined, "cli", "", "other"])("既定 runner も socket を明示しない設定（%s）では実行ファイルへ session と引数をそのまま渡す", async (transport) => {
    vi.stubEnv("TAILII_HERDR_TRANSPORT", transport);
    const executable = path.join(temp(), "fake-herdr.mjs");
    fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const args = ["pane", "send-text", "w1:p1", "日本語\r\n"];
    const result = await defaultHerdrCommandRunner(executable, "disposable")(args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["--session", "disposable", ...args]);
    expect(result.stderr).toBe("");
  });

  test("socket 不在・接続拒否は元の CLI へ渡し、起動自体の例外は従来どおり伝える", async () => {
    vi.stubEnv("TAILII_HERDR_TRANSPORT", "socket");
    const cli = vi.fn(async () => CLI);
    const run = socketHerdrCommandRunner(cli, { sessionName: "tailii", timeoutMs: 300, socketPath: path.join(temp(), "missing") });
    expect(await run(["pane", "send-text", "w1:p1", "text"])).toEqual(CLI);
    expect(cli).toHaveBeenCalledOnce();
    const broken = socketHerdrCommandRunner(async () => { throw new Error("ENOENT"); },
      { sessionName: "tailii", timeoutMs: 300, socketPath: "/does/not/exist" });
    await expect(broken(["pane", "list"])).rejects.toThrow("ENOENT");
  });
});

const cases = [
  { args: ["pane", "list"], method: "pane.list", params: { workspace_id: null }, id: "cli:pane:list", result: { type: "pane_list", panes: [PANE] } },
  { args: ["tab", "list"], method: "tab.list", params: { workspace_id: null }, id: "cli:tab:list", result: { type: "tab_list", tabs: [TAB] } },
  { args: ["pane", "get", "w1:p1"], method: "pane.get", params: { pane_id: "w1:p1" }, id: "cli:pane:get", result: { type: "pane_info", pane: PANE } },
  { args: ["pane", "process-info", "--pane", "w1:p1"], method: "pane.process_info", params: { pane_id: "w1:p1" },
    id: "cli:pane:process_info", result: { type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 10, foreground_processes: [{ pid: 10, name: "zsh" }] } } },
  { args: ["pane", "rename", "w1:p1", "日本語 title"], method: "pane.rename", params: { pane_id: "w1:p1", label: "日本語 title" },
    id: "cli:pane:rename", result: { type: "pane_info", pane: { ...PANE, label: "日本語 title" } } },
  { args: ["tab", "rename", "w1:t1", "日本語 title"], method: "tab.rename", params: { tab_id: "w1:t1", label: "日本語 title" },
    id: "cli:tab:rename", result: { type: "tab_info", tab: { ...TAB, label: "日本語 title" } } },
  { args: ["pane", "close", "w1:p1"], method: "pane.close", params: { pane_id: "w1:p1" }, id: "cli:pane:close", result: { type: "ok" } },
  { args: ["pane", "send-text", "w1:p1", "a\n日本語\r\u001b[200~"], method: "pane.send_text", params: { pane_id: "w1:p1", text: "a\n日本語\r\u001b[200~" }, id: "cli:request", result: { type: "ok" }, empty: true },
  { args: ["pane", "send-keys", "w1:p1", "C-c"], method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["C-c"] }, id: "cli:request", result: { type: "ok" }, empty: true },
  { args: ["pane", "run", "w1:p1", "printf 'test'"], method: "pane.send_input", params: { pane_id: "w1:p1", text: "printf 'test'", keys: ["Enter"] }, id: "cli:request", result: { type: "ok" }, empty: true },
  { args: ["tab", "create", "--cwd", "/tmp/日本語", "--env", "PATH=/bin:a=b", "--no-focus"], method: "tab.create",
    params: { workspace_id: null, cwd: "/tmp/日本語", label: null, focus: false, env: { PATH: "/bin:a=b" } }, id: "cli:tab:create", result: { type: "tab_created", tab: TAB, root_pane: PANE } },
  { args: ["workspace", "create", "--cwd", "/tmp", "--env", "PATH=/bin", "--no-focus", "--label", "tailii"], method: "workspace.create",
    params: { source_workspace_id: null, cwd: "/tmp", label: "tailii", focus: false, env: { PATH: "/bin" } }, id: "cli:workspace:create",
    result: { type: "workspace_created", workspace: WORKSPACE, tab: TAB, root_pane: PANE } },
];

describe("偽 Unix socket との結合", () => {
  beforeEach(() => vi.stubEnv("TAILII_HERDR_TRANSPORT", "socket"));

  test.each(cases)("CLI の引数・JSON/空 stdout を再現する: $method", async ({ args, method, params, id, result, empty }) => {
    const f = await fakeServer((req, socket) => send(socket, req, result));
    const actual = await f.runner(args);
    expect(actual.exitCode).toBe(0);
    expect(actual.stderr).toBe("");
    if (empty) expect(actual.stdout).toBe("");
    else { expect(JSON.parse(actual.stdout)).toEqual({ id, result }); expect(actual.stdout.endsWith("\n")).toBe(true); }
    expect(f.requests.map((r) => r.method)).toEqual(["ping", method]);
    expect(f.requests[1]?.params).toEqual(params);
    expect(new Set(f.requests.map((r) => r.id)).size).toBe(2);
    expect(f.cli).not.toHaveBeenCalled();
  });

  test.each([[], ["--source", "visible"], ["--source", "recent-unwrapped", "--lines", "50"],
    ["--source", "visible", "--format", "ansi"]].map((flags) => ({ flags })))
  ("pane read は本文をそのまま出し、ANSI・改行を足さない: $flags", async ({ flags }) => {
    const text = "\u001b[2m提案🙂\u001b[0m\n末尾";
    const f = await fakeServer((req, socket) => {
      send(socket, req, { type: "pane_read", read: { ...PANE, ...req.params, text, truncated: false } });
    });
    expect(await f.runner(["pane", "read", "w1:p1", ...flags])).toEqual({ exitCode: 0, stdout: text, stderr: "" });
    const params = f.requests[1]?.params;
    expect(params?.strip_ansi).toBe(true);
    expect(params?.source).toBe(flags.includes("recent-unwrapped") ? "recent_unwrapped" : flags.length ? "visible" : "recent");
    expect(params?.format).toBe(flags.includes("ansi") ? "ansi" : "text");
    expect(params?.lines).toBe(flags.includes("50") ? 50 : null);
  });

  test.each([cases[0]!, cases[7]!, cases[10]!])("API エラーは exit 1 と stderr JSON に写る: $method", async ({ args, id }) => {
    const error = { code: "workspace_not_found", message: "workspace not found" };
    const f = await fakeServer((req, socket) => socket.end(JSON.stringify({ id: req.id, error }) + "\n"));
    const actual = await f.runner(args);
    expect(actual).toEqual({ exitCode: 1, stdout: "", stderr: `{"error":{"code":"workspace_not_found","message":"workspace not found"},"id":"${id}"}\n` });
    expect(herdrErrorCode(actual.stderr)).toBe("workspace_not_found");
    expect(f.cli).not.toHaveBeenCalled();
  });

  test.each([21, 23, null])("未確認の protocol %s は書き込み前に CLI へ戻す", async (protocol) => {
    const f = await fakeServer(() => { throw new Error("書き込みは禁止"); }, { ping: { ...PONG, protocol } });
    const args = ["pane", "send-text", "w1:p1", "text"];
    expect(await f.runner(args)).toEqual(CLI);
    expect(f.requests.map((r) => r.method)).toEqual(["ping"]);
    expect(f.cli).toHaveBeenCalledOnce();
  });

  test("不正な ping / 相関 id は書き込みを発行せず CLI へ戻す", async () => {
    const f = await fakeServer((_req, socket) => socket.end('{"id":"wrong","result":{"type":"pong","version":"0.9.5","protocol":22}}\n'), { handlePing: true });
    expect(await f.runner(["pane", "send-text", "w1:p1", "text"])).toEqual(CLI);
    expect(f.requests).toHaveLength(1);
  });

  test.each(["json", "id", "shape", "both", "error", "utf8"])("読み取りの不正応答 %s は CLI へ戻す", async (kind) => {
    const f = await fakeServer((req, socket) => {
      const responses: Record<string, string | Buffer> = {
        json: "{bad}\n", id: JSON.stringify({ id: "wrong", result: { type: "pane_list", panes: [] } }) + "\n",
        shape: JSON.stringify({ id: req.id, result: { type: "pane_list", panes: [{}] } }) + "\n",
        both: JSON.stringify({ id: req.id, result: {}, error: {} }) + "\n",
        error: JSON.stringify({ id: req.id, error: { code: 2 } }) + "\n", utf8: Buffer.from([0xff, 0x0a]),
      };
      socket.end(responses[kind]);
    });
    expect(await f.runner(["pane", "list"])).toEqual(CLI);
    expect(f.cli).toHaveBeenCalledOnce();
  });

  test.each(["disconnect", "timeout", "json", "id", "shape", "error"])("書き込み送出後の %s は再送しない", async (kind) => {
    const f = await fakeServer((req, socket) => {
      if (kind === "disconnect") socket.destroy();
      if (kind === "json") socket.end("invalid\n");
      if (kind === "id") socket.end('{"id":"wrong","result":{"type":"ok"}}\n');
      if (kind === "shape") send(socket, req, { type: "unrecognized" });
      if (kind === "error") socket.end(JSON.stringify({ id: req.id, error: { code: 1 } }) + "\n");
    });
    const run = socketHerdrCommandRunner(f.cli, { sessionName: "test", timeoutMs: 100, socketPath: f.socketPath });
    expect(await run(["pane", "send-text", "w1:p1", "text"])).toEqual({ exitCode: 1, stdout: "", stderr: "" });
    expect(f.requests.map((r) => r.method)).toEqual(["ping", "pane.send_text"]);
    expect(f.cli).not.toHaveBeenCalled();
  });

  test.each(cases.filter((c) => ["pane.rename", "tab.rename", "pane.close", "pane.send_keys", "pane.send_input", "tab.create", "workspace.create"].includes(c.method)))
  ("書き込みの各系統とも送出後の切断は再送しない: $method", async ({ args }) => {
    const f = await fakeServer((_req, socket) => socket.destroy());
    expect(await f.runner(args)).toEqual({ exitCode: 1, stdout: "", stderr: "" });
    expect(f.cli).not.toHaveBeenCalled();
  });

  test("応答が 16 MiB を超えたら打ち切り、読み取りは CLI に戻す", async () => {
    const f = await fakeServer((_req, socket) => socket.end(Buffer.alloc(16 * 1024 * 1024 + 1, 120)));
    const run = socketHerdrCommandRunner(f.cli, { sessionName: "test", timeoutMs: 5000, socketPath: f.socketPath });
    expect(await run(["pane", "list"])).toEqual(CLI);
    expect(f.cli).toHaveBeenCalledOnce();
  });

  test("操作接続の失敗は未送信なので、書き込みでも CLI へ戻す", async () => {
    const f = await fakeServer((req, socket) => {
      // サーバーの待受を閉じてから ping 応答を返す（既存接続だけは残る）。
      f.server.close();
      send(socket, req, PONG);
    }, { handlePing: true });
    expect(await f.runner(["pane", "send-text", "w1:p1", "text"])).toEqual(CLI);
    expect(f.requests).toHaveLength(1);
    expect(f.cli).toHaveBeenCalledOnce();
  });

  test("読み取り中の切断は残り予算で CLI へ戻す", async () => {
    const f = await fakeServer((_req, socket) => socket.destroy());
    expect(await f.runner(["pane", "list"])).toEqual(CLI);
    expect(f.cli.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(f.cli.mock.calls[0]?.[1]).toBeLessThanOrEqual(1000);
  });

  test("途中までの応答を送り続けても操作全体の時間切れを延長しない", async () => {
    const f = await fakeServer((_req, socket, later) => {
      socket.write("{"); later(() => socket.write('"id"'), 50);
    });
    const run = socketHerdrCommandRunner(f.cli, { sessionName: "test", timeoutMs: 100, socketPath: f.socketPath });
    const started = Date.now();
    expect((await run(["pane", "list"])).exitCode).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(85);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.cli).not.toHaveBeenCalled();
    await delay(10);
    expect(f.sockets.size).toBe(0);
  });

  test("ping が詰まったら CLI に残り予算を渡し、書き込みは socket へ送らない", async () => {
    const f = await fakeServer(() => {}, { handlePing: true });
    const run = socketHerdrCommandRunner(f.cli, { sessionName: "test", timeoutMs: 1500, socketPath: f.socketPath });
    expect(await run(["pane", "send-text", "w1:p1", "text"])).toEqual(CLI);
    expect(f.requests.map((r) => r.method)).toEqual(["ping"]);
    expect(f.cli.mock.calls[0]?.[1]).toBeLessThanOrEqual(500);
    expect(f.cli.mock.calls[0]?.[1]).toBeGreaterThan(0);
  });

  test("並行要求と分割 UTF-8 応答は別々の接続・id で対応し、接続を残さない", async () => {
    const f = await fakeServer((req, socket, later) => {
      const result = { type: "pane_info", pane: { ...PANE, pane_id: req.params.pane_id, label: `応答🙂:${req.params.pane_id}` } };
      const response = Buffer.from(JSON.stringify({ id: req.id, result }) + "\n");
      const split = response.indexOf(Buffer.from("🙂")) + 1;
      later(() => {
        socket.write(response.subarray(0, split));
        later(() => socket.end(response.subarray(split)), 1);
      }, Number(String(req.params.pane_id).split("p").at(-1)) % 7);
    });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.runner(["pane", "get", `w1:p${i + 1}`])));
    results.forEach((result, i) => {
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).result.pane.label).toBe(`応答🙂:w1:p${i + 1}`);
    });
    expect(new Set(f.requests.map((r) => r.id)).size).toBe(40);
    await delay(10);
    expect(f.sockets.size).toBe(0);
    expect(f.cli).not.toHaveBeenCalled();
  });

  test("同じ runner でサーバーの版変更と復帰を検出する（版をキャッシュしない）", async () => {
    let protocol = 22;
    const f = await fakeServer((req, socket) => send(socket, req,
      req.method === "ping" ? { ...PONG, protocol } : { type: "pane_list", panes: [] }), { handlePing: true });
    expect((await f.runner(["pane", "list"])).exitCode).toBe(0);
    protocol = 23;
    expect(await f.runner(["pane", "list"])).toEqual(CLI);
    protocol = 22;
    expect((await f.runner(["pane", "list"])).exitCode).toBe(0);
    expect(f.cli).toHaveBeenCalledOnce();
    expect(f.requests.filter((r) => r.method === "ping")).toHaveLength(3);
  });

  test("同じ runner は待受が消えた間は CLI に戻り、同じパスでの再起動後に再接続する", async () => {
    const handler = (req: Request, socket: Socket) => send(socket, req, { type: "pane_list", panes: [] });
    const f = await fakeServer(handler);
    expect((await f.runner(["pane", "list"])).exitCode).toBe(0);
    await new Promise<void>((resolve) => f.server.close(() => resolve()));
    expect(await f.runner(["pane", "list"])).toEqual(CLI);
    const replacement = await fakeServer(handler, { socketPath: f.socketPath });
    expect((await f.runner(["pane", "list"])).exitCode).toBe(0);
    expect(replacement.requests.map((r) => r.method)).toEqual(["ping", "pane.list"]);
    expect(f.cli).toHaveBeenCalledOnce();
  });

  test("socket 指定時は既定 manager と launch が herdr 実行ファイルなしで動く", async () => {
    const dir = temp();
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    const socketPath = herdrSessionSocketPath("tailii")!;
    const f = await fakeServer((req, socket) => {
      const result = req.method === "pane.list" ? { type: "pane_list", panes: [] }
        : req.method === "tab.list" ? { type: "tab_list", tabs: [] }
        : req.method === "tab.create" ? { type: "tab_created", tab: TAB, root_pane: PANE }
        : req.method === "pane.rename" ? { type: "pane_info", pane: { ...PANE, label: req.params.label } } : { type: "ok" };
      send(socket, req, result);
    }, { socketPath });
    expect((await defaultHerdrCommandRunner("/nonexistent/herdr")(["pane", "list"])).exitCode).toBe(0);
    const store = new SessionMetadataStore(path.join(dir, "metadata"));
    store.put({ name: "s-test", cwd: dir, createdAt: 1, backend: "herdr", herdrPaneId: "w1:p1" });
    expect(await new HerdrSessionManager({ store }).list()).toMatchObject([{ name: "s-test", alive: false, backend: "herdr" }]);
    const errors: string[] = [];
    expect(await launchCore({ dir, session: "s-new", baseDir: null, binaryPath: "/fake/tailii", tmuxPath: "/fake/tmux",
      herdrPath: "/nonexistent/herdr", backend: "herdr", innerCommand: "printf test", path: "/usr/bin:/bin", store,
      now: () => 42, errorSink: (message) => errors.push(message), claudeJsonPath: path.join(dir, "claude.json"),
      hookGlobalMarkerPath: path.join(dir, "marker"), herdrLaunchScriptDir: path.join(dir, "run"),
      spawnDetached: () => { throw new Error("サーバーは起動しない"); }, claudeVersion: () => null,
    })).toBe(0);
    expect(errors).toEqual([]);
    expect(store.get("s-new")?.herdrPaneId).toBe("w1:p1");
    expect(f.requests.filter((r) => r.method !== "ping").map((r) => r.method))
      .toEqual(["pane.list", "pane.list", "tab.list", "pane.list", "tab.create", "pane.rename", "pane.send_input"]);
  });
});
