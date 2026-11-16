import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CLIUpdater, installedWithin, type CLIUpdaterOptions } from "./cliUpdater.js";

export interface ClaudeUpdaterOptions extends CLIUpdaterOptions {
  configHome?: string;
  dataHome?: string;
  managedSettingsPath?: string;
}

export class ClaudeUpdater extends CLIUpdater {
  constructor(options: ClaudeUpdaterOptions = {}) {
    const configHome = options.configHome ?? process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
    const dataHome = options.dataHome ?? process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share");
    const managed = options.managedSettingsPath ?? (process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json");
    // 手動更新も既存のチャネルと管理者の更新禁止を尊重する。設定ファイルは書き換えない。
    const settings = (): { channel: "stable" | "latest"; blocked: boolean } => {
      let channel: "stable" | "latest" = "latest";
      let blocked = /^(1|true)$/i.test(process.env["DISABLE_UPDATES"] ?? "");
      for (const file of [path.join(configHome, "settings.json"), managed]) {
        try {
          const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
            autoUpdatesChannel?: unknown; env?: { DISABLE_UPDATES?: unknown };
          };
          if (value.autoUpdatesChannel === "stable" || value.autoUpdatesChannel === "latest") channel = value.autoUpdatesChannel;
          if (/^(1|true)$/i.test(String(value.env?.DISABLE_UPDATES ?? ""))) blocked = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") blocked = true;
        }
      }
      return { channel, blocked };
    };
    super({
      commandName: "claude", displayName: "Claude Code", workerCommand: "claude-update-worker",
      versionPattern: /^(\S+)\s+\(Claude Code\)$/, env: { DISABLE_AUTOUPDATER: "1" },
      supports: (command) => !settings().blocked && installedWithin(command, path.join(dataHome, "claude", "versions")),
      releaseCacheKey: () => `release-${settings().channel}.json`,
      latest: async () => {
        const response = await fetch(`https://downloads.claude.ai/claude-code-releases/${settings().channel}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("release lookup failed");
        return (await response.text()).trim();
      },
    }, options);
  }
}

export async function runClaudeUpdateWorker(token: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("invalid update job");
  await new ClaudeUpdater().runWorker(token);
}
