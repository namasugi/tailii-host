// standby.ts — モジュールを読み込んだまま fd 3 の有効化を待つ。通常起動の副作用は ACK 後に限る。
import { fstatSync, statSync } from "node:fs";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { readPackageVersion } from "../shared/version.js";

const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

export function standbyFingerprint(file: string = cliPath): string | null {
  try {
    const stat = statSync(file);
    const version = readPackageVersion();
    return version === null ? null : `${stat.mtimeMs}|${stat.size}|${version}`;
  } catch {
    return null;
  }
}

const loadedFingerprint = standbyFingerprint();

export interface StandbyOptions {
  fresh(): boolean;
  activate(argv: string[]): Promise<number>;
  checkIntervalMs?: number;
}

/** 入出力は fd 3 と独立に注入できる。stdin/stdout は有効化されるまで参照しない。 */
export function waitForActivation(control: Duplex, options: StandbyOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    let done = false;
    let failed = false;
    let input = Buffer.alloc(0);
    const timer = setInterval(() => {
      if (!options.fresh()) finish();
    }, options.checkIntervalMs ?? 30_000);
    function finish(ack?: object, argv?: string[], exitCode = 0): void {
      if (done) return;
      done = true;
      clearInterval(timer);
      control.pause();
      const close = (): void => {
        control.once("close", () => {
          if (argv && !failed) Promise.resolve().then(() => options.activate(argv)).then(resolve, reject);
          else resolve(failed ? 1 : exitCode);
        });
        control.destroy();
      };
      if (ack) control.end(`${JSON.stringify(ack)}\n`, close);
      else close();
    }
    control.on("error", () => {
      failed = true;
      clearInterval(timer);
      done = true;
      control.destroy();
      resolve(1);
    });
    control.on("end", () => { if (!done) finish(); });
    control.on("close", () => { if (!done) { clearInterval(timer); done = true; resolve(1); } });
    control.on("data", (chunk: Buffer) => {
      if (done) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > 8192) return finish({ ok: false, reason: "bad_request" }, undefined, 1);
      const newline = input.indexOf(10);
      if (newline < 0) return;
      let argv: unknown;
      try { argv = JSON.parse(input.subarray(0, newline).toString("utf8"))?.activate?.argv; } catch { /* 不正な JSON は拒否。 */ }
      if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
          (argv[0] !== "engine" && argv[0] !== "serve")) {
        return finish({ ok: false, reason: "bad_request" }, undefined, 1);
      }
      if (!options.fresh()) return finish({ ok: false, reason: "stale" });
      finish({ ok: true }, argv);
    });
  });
}

export async function runStandbyCommand(activate: () => Promise<number>): Promise<number> {
  let control: Socket;
  try {
    if (!fstatSync(3).isSocket()) return 1;
    control = new Socket({ fd: 3, readable: true, writable: true });
  } catch {
    return 1;
  }
  // 有効化の受け付け前に温める。通常起動の副作用は各 run 関数を呼ぶまで起こさない。
  await Promise.all([import("../engine/engine.js"), import("../approval/broker.js")]);
  return waitForActivation(control, {
    fresh: () => loadedFingerprint !== null && standbyFingerprint() === loadedFingerprint,
    activate: async (argv) => {
      process.argv = [process.execPath, cliPath, ...argv];
      // GW は余白の引数も渡す。macOS/Linux の argv 領域長の制限内で通常起動と同じ ps 表示にする。
      process.title = process.argv.join(" ");
      return activate();
    },
  });
}
