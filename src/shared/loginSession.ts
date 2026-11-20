import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type LoginSessionKind = "screen" | "other" | "unknown";

const execFileAsync = promisify(execFile);

/** このプロセスが画面のログインに属しているかを調べる。 */
export async function loginSessionKind(options: {
  platform?: NodeJS.Platform;
  run?: (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
} = {}): Promise<LoginSessionKind> {
  if ((options.platform ?? process.platform) !== "darwin") return "unknown";
  try {
    const { stdout } = await (options.run ?? execFileAsync)("/bin/launchctl", ["managername"], { timeout: 1_000 });
    const manager = stdout.trim();
    if (manager === "") return "unknown";
    return manager === "Aqua" ? "screen" : "other";
  } catch {
    return "unknown";
  }
}
