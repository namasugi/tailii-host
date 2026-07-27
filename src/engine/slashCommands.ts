// engine/slashCommands.ts
// slash_list_request 用のコマンド候補収集。ユーザー/プロジェクトの skills・commands と
// installed_plugins.json 登録プラグイン（enabledPlugins で無効化されたものは除外）を走査する。

import * as fs from "node:fs";
import * as path from "node:path";
import type { SlashCommandInfo } from "../protocol.js";

interface SlashCandidate {
  command: SlashCommandInfo;
  priority: number;
}

/** slash_list_request 用に、ユーザー/プロジェクト/プラグインの skills と commands を収集する。 */
export function collectSlashCommands(homeDir: string, cwd?: string): SlashCommandInfo[] {
  const byName = new Map<string, SlashCandidate>();
  const userClaude = path.join(homeDir, ".claude");
  const projectClaude = cwd === undefined ? null : path.join(cwd, ".claude");

  scanPluginCommands(userClaude, byName);
  scanSkillCommands(path.join(userClaude, "skills"), 2, byName);
  if (projectClaude !== null) scanSkillCommands(path.join(projectClaude, "skills"), 4, byName);
  scanMarkdownCommands(path.join(userClaude, "commands"), 1, byName);
  if (projectClaude !== null) scanMarkdownCommands(path.join(projectClaude, "commands"), 3, byName);

  return [...byName.values()]
    .map((entry) => entry.command)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

/** installed_plugins.json に登録されたプラグインの skills/commands を `/plugin:name` として読む。 */
function scanPluginCommands(claudeDir: string, byName: Map<string, SlashCandidate>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(claudeDir, "plugins", "installed_plugins.json"), "utf8"),
    );
  } catch {
    return;
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return;
  const disabled = readDisabledPlugins(claudeDir);
  for (const [key, installs] of Object.entries(plugins)) {
    if (disabled.has(key)) continue;
    const pluginName = key.split("@")[0] ?? "";
    if (pluginName === "" || !Array.isArray(installs)) continue;
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath !== "string") continue;
      scanSkillCommands(path.join(installPath, "skills"), 0, byName, `${pluginName}:`);
      scanMarkdownCommands(path.join(installPath, "commands"), 0, byName, `${pluginName}:`);
    }
  }
}

/** ~/.claude/settings.json の enabledPlugins で明示的に false のプラグインキー集合。 */
function readDisabledPlugins(claudeDir: string): Set<string> {
  const disabled = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  } catch {
    return disabled;
  }
  const enabled = (parsed as { enabledPlugins?: unknown } | null)?.enabledPlugins;
  if (typeof enabled !== "object" || enabled === null) return disabled;
  for (const [key, value] of Object.entries(enabled)) {
    if (value === false) disabled.add(key);
  }
  return disabled;
}

/** ~/.claude/skills/<name>/SKILL.md 形式のコマンド候補を読む（namePrefix はプラグイン名前空間用）。 */
function scanSkillCommands(
  root: string,
  priority: number,
  byName: Map<string, SlashCandidate>,
  namePrefix = "",
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const skillDir = path.join(root, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = fs.statSync(skillDir).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) continue;
    addSlashCandidate(
      byName,
      `/${namePrefix}${entry.name}`,
      path.join(skillDir, "SKILL.md"),
      priority,
    );
  }
}

/** ~/.claude/commands/<name>.md 形式のコマンド候補を読む（namePrefix はプラグイン名前空間用）。 */
function scanMarkdownCommands(
  root: string,
  priority: number,
  byName: Map<string, SlashCandidate>,
  namePrefix = "",
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    let isFile = entry.isFile();
    if (!isFile && entry.isSymbolicLink()) {
      try {
        isFile = fs.statSync(filePath).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!isFile) continue;
    addSlashCandidate(byName, `/${namePrefix}${entry.name.slice(0, -3)}`, filePath, priority);
  }
}

/** 既存候補より優先度が高いときだけ登録する（project 優先、同 scope では skills 優先）。 */
function addSlashCandidate(
  byName: Map<string, SlashCandidate>,
  name: string,
  filePath: string,
  priority: number,
): void {
  const existing = byName.get(name);
  if (existing !== undefined && existing.priority >= priority) return;
  byName.set(name, { priority, command: { name, summary: readMarkdownSummary(filePath) } });
}

/** YAML frontmatter の description 1 行だけを素朴に抜き出す。 */
function readMarkdownSummary(filePath: string): string {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return "";
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "---") break;
    const match = /^description:\s*(.*)$/.exec(line);
    if (match !== null) {
      return stripYamlQuotes(match[1] ?? "").slice(0, 120);
    }
  }
  return "";
}

/** description: "..." / '...' の外側だけ外す。 */
function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
