// herdrSocket.ts — herdr 0.9.5（protocol 22）の CLI と同じ結果を返す socket ランナー。
// 対応表と出力変換の根拠: 同版の src/cli{,/pane,/runtime,/tab,/workspace}.rs と API schema。
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import type { HerdrCommandResult, HerdrCommandRunner } from "./herdr.js";

const SUPPORTED_PROTOCOL = 22;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// 不通の ping だけで全予算を使わず、サーバー起動等を担う CLI に時間を残す。
const PROBE_TIMEOUT_MS = 1_000;
type ObjectValue = Record<string, unknown>;
type Call = {
  method: string;
  params: ObjectValue;
  cliId: string;
  output: "json" | "text" | "empty";
  writes: boolean;
};

/** 明示した --session が HERDR_SOCKET_PATH / HERDR_SESSION より優先する（session.rs）。 */
export function herdrSessionSocketPath(sessionName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // Unix の安定版のパスを扱う。Windows の named pipe は CLI に任せる。
  if (process.platform === "win32" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionName)) return null;
  const configDir = env.XDG_CONFIG_HOME !== undefined ? path.join(env.XDG_CONFIG_HOME, "herdr")
    : env.HOME !== undefined ? path.join(env.HOME, ".config", "herdr") : path.join(os.tmpdir(), "herdr");
  return sessionName === "default"
    ? path.join(configDir, "herdr.sock")
    : path.join(configDir, "sessions", sessionName, "herdr.sock");
}

/** host が発行する形だけを受け付ける。未知の引数・CLI 固有処理は変更せず CLI へ戻す。 */
function mapCall(args: string[]): Call | null {
  if (args.some((arg) => arg.includes("\0") || arg === "--help" || arg === "-h")) return null;
  const [group, command, target, payload] = args;
  const call = (method: string, params: ObjectValue, writes = false, output: Call["output"] = "json",
    cliId = `cli:${group}:${command}`): Call => ({ method, params, writes, output, cliId });
  if ((group === "pane" || group === "tab") && command === "list" && args.length === 2) {
    return call(`${group}.list`, { workspace_id: null });
  }
  if (group === "pane" && command === "get" && target !== undefined && args.length === 3) {
    return call("pane.get", { pane_id: target });
  }
  if (group === "pane" && command === "process-info" && target === "--pane" && payload !== undefined && args.length === 4) {
    return call("pane.process_info", { pane_id: payload }, false, "json", "cli:pane:process_info");
  }
  if (group === "pane" && command === "close" && target !== undefined && args.length === 3) {
    return call("pane.close", { pane_id: target }, true);
  }
  if (group === "pane" && command === "rename" && target !== undefined && payload !== undefined && args.length === 4) {
    return call("pane.rename", { pane_id: target, label: payload === "--clear" ? null : payload }, true);
  }
  if (group === "tab" && command === "rename" && target !== undefined && payload !== undefined && args.length === 4) {
    return call("tab.rename", { tab_id: target, label: payload }, true);
  }
  if (group === "pane" && target !== undefined && payload !== undefined && args.length === 4) {
    if (command === "send-text") return call("pane.send_text", { pane_id: target, text: payload }, true, "empty", "cli:request");
    if (command === "send-keys") return call("pane.send_keys", { pane_id: target, keys: [payload] }, true, "empty", "cli:request");
    if (command === "run") return call("pane.send_input", { pane_id: target, text: payload, keys: ["Enter"] }, true, "empty", "cli:request");
  }
  if (group === "pane" && command === "read" && target !== undefined && !target.startsWith("-")) {
    const params: ObjectValue = { pane_id: target, source: "recent", lines: null, format: "text", strip_ansi: true };
    const seen = new Set<string>();
    for (let i = 3; i < args.length; i += 2) {
      const flag = args[i]!;
      const value = args[i + 1];
      if (value === undefined || seen.has(flag)) return null;
      seen.add(flag);
      if (flag === "--source" && ["visible", "recent", "recent-unwrapped", "detection"].includes(value)) {
        params.source = value.replace("-", "_");
      } else if (flag === "--format" && ["text", "ansi"].includes(value)) {
        params.format = value;
      } else if (flag === "--lines" && /^\d+$/.test(value) && Number(value) <= 0xffff_ffff) {
        params.lines = Number(value);
      } else return null;
    }
    return call("pane.read", params, false, "text");
  }
  if ((group === "tab" || group === "workspace") && command === "create") {
    const params: ObjectValue = { cwd: null, focus: false, label: null, env: {} };
    params[group === "tab" ? "workspace_id" : "source_workspace_id"] = null;
    const env: Record<string, string> = Object.create(null);
    const seen = new Set<string>();
    for (let i = 2; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === "--no-focus") { params.focus = false; continue; }
      if (!["--cwd", "--label", "--env"].includes(flag)) return null;
      const value = args[++i];
      if (value === undefined || (flag !== "--env" && seen.has(flag))) return null;
      seen.add(flag);
      if (flag === "--env") {
        const equal = value.indexOf("=");
        if (equal <= 0 || value.slice(0, equal).includes("\0") || value.slice(equal + 1).includes("\0")) return null;
        env[value.slice(0, equal)] = value.slice(equal + 1);
      } else params[flag.slice(2)] = value;
    }
    params.env = env;
    return call(`${group}.create`, params, true);
  }
  // server stop は応答後に API / client socket の停止まで待つため CLI に残す。
  return null;
}

const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: ObjectValue, keys: string[]): boolean => keys.every((key) => typeof value[key] === "string");
const uint = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const status = (value: unknown): boolean => ["idle", "working", "blocked", "done", "unknown"].includes(value as string);
const nullableString = (value: unknown): boolean => value === undefined || value === null || typeof value === "string";
function pane(value: unknown): value is ObjectValue {
  return object(value) && strings(value, ["pane_id", "terminal_id", "workspace_id", "tab_id"])
    && typeof value.focused === "boolean" && status(value.agent_status) && uint(value.revision)
    && nullableString(value.label);
}
function tab(value: unknown): value is ObjectValue {
  return object(value) && strings(value, ["tab_id", "workspace_id", "label"])
    && typeof value.focused === "boolean" && status(value.agent_status) && uint(value.number) && uint(value.pane_count);
}
function workspace(value: unknown): boolean {
  return object(value) && strings(value, ["workspace_id", "label", "active_tab_id"])
    && typeof value.focused === "boolean" && status(value.agent_status)
    && [value.number, value.pane_count, value.tab_count].every(uint);
}
function expectedResult(call: Call, result: ObjectValue): boolean {
  switch (call.method) {
    case "pane.list": return result.type === "pane_list" && Array.isArray(result.panes) && result.panes.every(pane);
    case "tab.list": return result.type === "tab_list" && Array.isArray(result.tabs) && result.tabs.every(tab);
    case "pane.get":
    case "pane.rename": return result.type === "pane_info" && pane(result.pane) && result.pane.pane_id === call.params.pane_id;
    case "tab.rename": return result.type === "tab_info" && tab(result.tab) && result.tab.tab_id === call.params.tab_id;
    case "tab.create": return result.type === "tab_created" && tab(result.tab) && pane(result.root_pane)
      && result.tab.tab_id === result.root_pane.tab_id && result.tab.workspace_id === result.root_pane.workspace_id;
    case "workspace.create": return result.type === "workspace_created" && object(result.workspace) && workspace(result.workspace)
      && tab(result.tab) && pane(result.root_pane) && result.tab.tab_id === result.root_pane.tab_id
      && result.workspace.workspace_id === result.tab.workspace_id && result.workspace.workspace_id === result.root_pane.workspace_id;
    case "pane.process_info": {
      const info = result.process_info;
      return result.type === "pane_process_info" && object(info) && info.pane_id === call.params.pane_id
        && [info.shell_pid, info.foreground_process_group_id].every((v) => v === undefined || v === null || uint(v))
        && (info.foreground_processes === undefined || (Array.isArray(info.foreground_processes)
          && info.foreground_processes.every((v) => object(v) && uint(v.pid) && typeof v.name === "string")));
    }
    case "pane.read": {
      const read = result.read;
      return result.type === "pane_read" && object(read) && strings(read, ["pane_id", "workspace_id", "tab_id", "text"])
        && read.pane_id === call.params.pane_id && read.source === call.params.source && read.format === call.params.format
        && uint(read.revision) && typeof read.truncated === "boolean";
    }
    default: return result.type === "ok";
  }
}

class SocketFailure extends Error {
  constructor(readonly sent: boolean) { super("herdr socket response unavailable"); }
}

/** 1 要求 1 接続。送出を試みた後は、write callback が失敗しても未配送とは断定しない。 */
function request(socketPath: string, method: string, params: ObjectValue, timeoutMs: number): Promise<ObjectValue> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const wire = JSON.stringify({ id, method, params }) + "\n";
    let socket: ReturnType<typeof createConnection>;
    try { socket = createConnection(socketPath); }
    catch { reject(new SocketFailure(false)); return; }
    let sent = false;
    let finished = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (value?: ObjectValue) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (value) resolve(value); else reject(new SocketFailure(sent));
    };
    const timer = setTimeout(() => finish(), Math.max(1, timeoutMs));
    socket.once("connect", () => {
      if (finished) return;
      sent = true;
      socket.write(wire, (error) => { if (error) finish(); });
    });
    socket.on("error", () => finish());
    socket.once("close", () => finish());
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) { finish(); return; }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      try {
        const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), (_key, value) => {
          // u64 等を丸めた JSON を CLI と同値として返さない。
          if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("unsafe integer");
          return value;
        });
        if (!object(response) || response.id !== id || ("error" in response) === ("result" in response)) { finish(); return; }
        finish(response);
      } catch { finish(); }
    });
  });
}

/** serde_json::Value と同じキー順で、CLI の JSON 行と固定 id を復元する。 */
function cliJson(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sorted(v[key])])) : v;
  return JSON.stringify(sorted(value)) + "\n";
}
const failed = (): HerdrCommandResult => ({ exitCode: 1, stdout: "", stderr: "" });

/** CLI へ渡す残り時間も同じ操作の上限に含める（0ms = execFile の無期限指定を渡さない）。 */
export function socketHerdrCommandRunner(
  cli: (args: string[], timeoutMs: number) => Promise<HerdrCommandResult>,
  options: { sessionName: string; timeoutMs: number; env?: NodeJS.ProcessEnv; socketPath?: string },
): HerdrCommandRunner {
  return async (args) => {
    const started = performance.now();
    const remaining = () => Math.ceil(options.timeoutMs - (performance.now() - started));
    const fallback = () => {
      const budget = remaining();
      return budget > 0 ? cli(args, budget) : Promise.resolve(failed());
    };
    const env = options.env ?? process.env;
    const call = mapCall(args);
    const socketPath = options.socketPath ?? herdrSessionSocketPath(options.sessionName, env);
    if (env.TAILII_HERDR_TRANSPORT === "cli" || !call || socketPath === null) return fallback();
    try {
      // 版はキャッシュしない。サーバーを再起動・更新しても次の操作で必ず再確認する。
      const response = await request(socketPath, "ping", {}, Math.min(PROBE_TIMEOUT_MS, remaining()));
      if (!object(response.result) || response.result.type !== "pong" || response.result.protocol !== SUPPORTED_PROTOCOL
        || typeof response.result.version !== "string") return fallback();
    } catch { return fallback(); }
    if (remaining() <= 0) return failed();
    let response: ObjectValue;
    try {
      response = await request(socketPath, call.method, call.params, remaining());
    } catch (error) {
      if (call.writes && (!(error instanceof SocketFailure) || error.sent)) return failed();
      return fallback();
    }
    if (object(response.error) && strings(response.error, ["code", "message"])) {
      return { exitCode: 1, stdout: "", stderr: cliJson({ ...response, id: call.cliId }) };
    }
    if (!object(response.result) || !expectedResult(call, response.result)) {
      // 書き込みの応答が壊れた場合も、適用済みの可能性があるので CLI で再送しない。
      return call.writes ? failed() : fallback();
    }
    const stdout = call.output === "empty" ? "" : call.output === "text"
      ? (response.result.read as ObjectValue).text as string : cliJson({ ...response, id: call.cliId });
    return { exitCode: 0, stdout, stderr: "" };
  };
}
