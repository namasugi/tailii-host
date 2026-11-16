// Codex standalone用。排他・進捗・復旧は共通CLI updaterが担う。
import * as os from "node:os";
import * as path from "node:path";
import { CLIUpdater, installedWithin, type CLIUpdaterOptions } from "../updates/cliUpdater.js";

export interface CodexUpdaterOptions extends Omit<CLIUpdaterOptions, "resolveCommand"> {
  codexHome?: string;
  resolveCodex?: () => string | null;
}

export class CodexUpdater extends CLIUpdater {
  constructor(options: CodexUpdaterOptions = {}) {
    const home = options.codexHome ?? process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
    super({
      commandName: "codex", displayName: "Codex", workerCommand: "codex-update-worker",
      versionPattern: /^codex-cli\s+(\S+)\s*$/, env: { CODEX_NON_INTERACTIVE: "1" },
      supports: (command) => installedWithin(command, path.join(home, "packages", "standalone", "releases")),
      latest: async () => {
        const response = await fetch("https://registry.npmjs.org/@openai/codex/latest", {
          signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("release lookup failed");
        const data = await response.json() as { version?: unknown };
        if (typeof data.version !== "string") throw new Error("invalid release version");
        return data.version;
      },
    }, { ...options, resolveCommand: options.resolveCodex });
  }
}

export async function runCodexUpdateWorker(token: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("invalid update job");
  await new CodexUpdater().runWorker(token);
}
