// apiAgent/sdkStatus.ts
// Agent SDK の導入状態と、SDK と導入済み claude の版の照合（doctor・`tailii api-agent status`・ターン前の確認）。
//
// SDK の package.json には対応する Claude Code の版（`claudeCodeVersion`）が入っている（0.3.322 → 2.1.322、実測）。
// 本体同梱なし（--omit=optional）で入れた SDK は導入済みの claude を使うので、claude がそれより古ければ
// 新しいオプションが通じない恐れがある → 始めない（sdk_version_mismatch）。claude が新しい分には動かす
// （CLI は旧い SDK の要求を受け付ける前提。外れたら作業プロセスの失敗として出る）。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { versionAtLeast } from "../shared/cliVersions.js";
import { agentSdkHasBundledExecutable, resolveAgentSdkEntry, resolveInstalledClaude } from "./sdkLoader.js";

export type AgentSdkCompatibility = "ok" | "not_installed" | "claude_missing" | "claude_older" | "unknown";

export interface AgentSdkStatus {
  installed: boolean;
  entry: string | null;
  sdkVersion: string | null;
  /** SDK が対応する Claude Code の版。 */
  claudeCodeVersion: string | null;
  bundledExecutable: boolean;
  installedClaude: string | null;
  installedClaudeVersion: string | null;
  compatibility: AgentSdkCompatibility;
}

/** SDK の入口から package.json を探して読む。 */
export function readAgentSdkPackage(entry: string): { version: string | null; claudeCodeVersion: string | null } {
  let dir = path.dirname(entry);
  for (let i = 0; i < 4; i += 1) {
    const file = path.join(dir, "package.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (raw["name"] === "@anthropic-ai/claude-agent-sdk") {
        return {
          version: typeof raw["version"] === "string" ? raw["version"] : null,
          claudeCodeVersion: typeof raw["claudeCodeVersion"] === "string" ? raw["claudeCodeVersion"] : null,
        };
      }
    } catch { /* 上の階層へ。 */ }
    dir = path.dirname(dir);
  }
  return { version: null, claudeCodeVersion: null };
}

const versionCache = new Map<string, { mtimeMs: number; version: string | null }>();

/** `claude --version` の数値版（実行ファイルの更新時刻ごとに 1 回だけ実行する）。 */
export function installedClaudeVersion(executable: string, run: (file: string) => string = defaultRun): string | null {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(executable).mtimeMs; } catch { return null; }
  const cached = versionCache.get(executable);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.version;
  let version: string | null = null;
  try {
    version = /\d+(?:\.\d+)+/.exec(run(executable))?.[0] ?? null;
  } catch {
    version = null;
  }
  versionCache.set(executable, { mtimeMs, version });
  return version;
}

function defaultRun(file: string): string {
  return execFileSync(file, ["--version"], { timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function compatibilityOf(status: Omit<AgentSdkStatus, "compatibility">): AgentSdkCompatibility {
  if (!status.installed) return "not_installed";
  if (status.bundledExecutable) return "ok";
  if (status.installedClaude === null) return "claude_missing";
  if (status.claudeCodeVersion === null || status.installedClaudeVersion === null) return "unknown";
  return versionAtLeast(status.installedClaudeVersion, status.claudeCodeVersion) === false ? "claude_older" : "ok";
}

export function agentSdkStatus(deps: {
  resolveEntry?: () => string | null;
  hasBundled?: (entry: string) => boolean;
  resolveClaude?: () => string | null;
  claudeVersion?: (executable: string) => string | null;
} = {}): AgentSdkStatus {
  const entry = (deps.resolveEntry ?? (() => resolveAgentSdkEntry()))();
  const pkg = entry === null ? { version: null, claudeCodeVersion: null } : readAgentSdkPackage(entry);
  const bundledExecutable = entry !== null && (deps.hasBundled ?? agentSdkHasBundledExecutable)(entry);
  // SDK が無いとき・本体同梱のときは導入済みの claude を調べない（`claude --version` を走らせない）。
  const installedClaude = entry === null || bundledExecutable ? null : (deps.resolveClaude ?? (() => resolveInstalledClaude()))();
  const base = {
    installed: entry !== null,
    entry,
    sdkVersion: pkg.version,
    claudeCodeVersion: pkg.claudeCodeVersion,
    bundledExecutable,
    installedClaude,
    installedClaudeVersion: installedClaude === null ? null : (deps.claudeVersion ?? installedClaudeVersion)(installedClaude),
  };
  return { ...base, compatibility: compatibilityOf(base) };
}

/** 状態の 1 行説明（doctor・コマンド用。UI へも出るので「Mac」や端末名を使わない）。 */
export function describeAgentSdkStatus(status: AgentSdkStatus): string {
  switch (status.compatibility) {
    case "not_installed":
      return "未導入（アプリで API 作業を始めると自動で準備されます）";
    case "claude_missing":
      return `SDK ${status.sdkVersion ?? "?"} は導入済みだが、使う claude が見つかりません`;
    case "claude_older":
      return `SDK ${status.sdkVersion ?? "?"} は claude ${status.claudeCodeVersion ?? "?"} 以上が必要（導入済み ${status.installedClaudeVersion ?? "?"}。入れ直しで直らなければ claude update）`;
    case "unknown":
      return `SDK ${status.sdkVersion ?? "?"}（claude の版を確認できません）`;
    case "ok":
      return status.bundledExecutable
        ? `SDK ${status.sdkVersion ?? "?"}（本体同梱）`
        : `SDK ${status.sdkVersion ?? "?"} + claude ${status.installedClaudeVersion ?? "?"}`;
  }
}
