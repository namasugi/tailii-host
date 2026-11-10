import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";

const SHELL_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_VALUE_BYTES = 8192;
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
type EnvironmentReader = (names: readonly string[]) => Promise<NodeJS.ProcessEnv>;

function loginShell(env: NodeJS.ProcessEnv): string | undefined {
  let configured: string | undefined;
  try { configured = userInfo().shell || undefined; } catch { /* OS の既定へ。 */ }
  const shell = env["SHELL"] || configured || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return isAbsolute(shell) && ["zsh", "bash", "sh", "dash", "ksh", "fish"].includes(basename(shell)) ? shell : undefined;
}
function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/**
 * SSH exec / launchd に継承されない、利用者のログイン・対話シェルの変数を必要な名前だけ読む。
 * 値は専用 stdout pipe の中だけを通る。引数・ファイル・ログ・process.env には書かない。
 */
export async function readLoginShellApiEnvironment(names: readonly string[], options: {
  env?: NodeJS.ProcessEnv; timeoutMs?: number;
} = {}): Promise<NodeJS.ProcessEnv> {
  const env = options.env ?? process.env;
  const requested = [...new Set(names.filter((name) => VALID_NAME.test(name)))].slice(0, 16);
  const shell = loginShell(env);
  if (!shell || requested.length === 0) return {};
  const marker = "__TAILII_API_ENV_" + randomUUID() + "__";
  // シェルにキーを展開させない。絶対パスの Node が自分の環境から読むため、xtrace にも値が出ない。
  const program = `const values = Object.create(null); for (const name of ${JSON.stringify(requested)}) { const value = process.env[name]; if (typeof value === "string" && Buffer.byteLength(value) <= ${MAX_VALUE_BYTES}) values[name] = value; } process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(values) + ${JSON.stringify(marker)});`;
  return new Promise((resolve) => {
    let settled = false;
    let chunks: Buffer[] = [];
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: NodeJS.ProcessEnv): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chunks = [];
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-ilc", "exec " + quote(process.execPath) + " -e " + quote(program)], {
        env, cwd: env["HOME"] || homedir(), detached: true, stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { finish({}); return; }
    const stop = (): void => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch { /* 既に終了。 */ }
      }
      child.stdout?.destroy();
      finish({});
    };
    timer = setTimeout(stop, options.timeoutMs ?? SHELL_TIMEOUT_MS);
    child.once("error", () => finish({}));
    child.stdout?.on("data", (data: Buffer) => {
      if (settled) return;
      bytes += data.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop(); return; }
      chunks.push(data);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish({}); return; }
      try {
        // .zshrc 等の通常出力を NDJSON へ混ぜず、フレームの外は捨てる。
        const output = Buffer.concat(chunks).toString("utf8");
        const end = output.lastIndexOf(marker), start = output.lastIndexOf(marker, end - 1);
        const raw: unknown = start < 0 || end <= start ? undefined : JSON.parse(output.slice(start + marker.length, end));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { finish({}); return; }
        const values: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
        for (const name of requested) {
          const value = (raw as Record<string, unknown>)[name];
          if (typeof value === "string" && Buffer.byteLength(value) <= MAX_VALUE_BYTES) values[name] = value;
        }
        finish(values);
      } catch { finish({}); }
    });
  });
}

/** 同時の照会をまとめ、短時間だけメモリに保持する。継承済みの値（空値も含む）は常に優先する。 */
export function createHostApiKeyEnvironmentResolver(options: {
  env?: NodeJS.ProcessEnv; read?: EnvironmentReader; now?: () => number; cacheMs?: number;
} = {}): EnvironmentReader {
  const cache = new Map<string, { value: string | undefined; expires: number }>();
  const pending = new Map<string, Promise<void>>();
  const now = options.now ?? Date.now;
  let queued: { names: Set<string>; promise: Promise<void> } | undefined;
  function schedule(names: string[]): Promise<void> {
    if (!queued) {
      const batch = { names: new Set<string>(), promise: Promise.resolve() };
      batch.promise = Promise.resolve().then(async () => {
        queued = undefined;
        const requested = [...batch.names];
        let values: NodeJS.ProcessEnv = {};
        try { values = await (options.read ?? ((names) => readLoginShellApiEnvironment(names, { env: options.env })))(requested); } catch { /* 内容をログへ出さない。 */ }
        for (const name of requested) {
          const value = Object.hasOwn(values, name) && typeof values[name] === "string" ? values[name] : undefined;
          const ttl = value === undefined ? Math.min(options.cacheMs ?? 30_000, 5_000) : options.cacheMs ?? 30_000;
          cache.set(name, { value, expires: now() + ttl });
          pending.delete(name);
        }
        while (cache.size > 128) cache.delete(cache.keys().next().value!);
      });
      queued = batch;
    }
    for (const name of names) { queued.names.add(name); pending.set(name, queued.promise); }
    return queued.promise;
  }
  return async (names) => {
    const env = options.env ?? process.env;
    const requested = [...new Set(names.filter((name) => VALID_NAME.test(name)))].slice(0, 16);
    const missing: string[] = [], waits = new Set<Promise<void>>();
    for (const name of requested) {
      if (Object.hasOwn(env, name)) continue;
      const running = pending.get(name);
      if (running) waits.add(running);
      else if ((cache.get(name)?.expires ?? 0) <= now()) missing.push(name);
    }
    if (missing.length) waits.add(schedule(missing));
    await Promise.all(waits);
    const result = { ...env };
    for (const name of requested) {
      const value = cache.get(name)?.value;
      if (!Object.hasOwn(env, name) && value !== undefined) result[name] = value;
    }
    return result;
  };
}

export const hostApiKeyEnvironment = createHostApiKeyEnvironmentResolver();
