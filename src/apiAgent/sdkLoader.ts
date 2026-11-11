// apiAgent/sdkLoader.ts
// Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）を必要なときだけ読み込む。
//
// SDK は公開パッケージ（tailii-host）の依存に入れない。SDK 本体は約 5MB だが、既定の導入では
// 約 300MB の Claude Code 実行ファイルが付く。利用者が API 作業を使うと決めたときだけ
// `~/.tailii/api-agent/sdk` に入れてもらい（`npm install --prefix ~/.tailii/api-agent/sdk
// --omit=optional @anthropic-ai/claude-agent-sdk`）、実行ファイルは導入済みの `claude` を使う。
// hub / engine 本体はこのモジュールを読み込まない（作業プロセスだけが読む）。

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** 作業プロセスが使う SDK の最小の面（型定義 sdk.d.ts の該当部分だけを写す）。 */
export interface AgentSdkQuery extends AsyncIterable<Record<string, unknown>> {
  initializationResult(): Promise<{ account?: Record<string, unknown>; claude_code_version?: string }>;
  interrupt(): Promise<unknown>;
  close?(): void;
}
export interface AgentSdkModule {
  query(params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }): AgentSdkQuery;
}

export function defaultAgentSdkDir(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "api-agent", "sdk");
}

/** 探す場所（先勝ち）: 専用の導入先 → host 自身の依存解決。 */
export function agentSdkSearchRoots(home: string = os.homedir(), hostModuleUrl: string = import.meta.url): string[] {
  return [path.join(defaultAgentSdkDir(home), "package.json"), new URL(".", hostModuleUrl).pathname];
}

/** SDK の入口ファイルを探す。見つからなければ null。 */
export function resolveAgentSdkEntry(roots: string[] = agentSdkSearchRoots()): string | null {
  for (const root of roots) {
    try {
      return createRequire(root).resolve(AGENT_SDK_PACKAGE);
    } catch {
      // 次の候補へ。
    }
  }
  return null;
}

export async function loadAgentSdk(roots?: string[]): Promise<AgentSdkModule | null> {
  const entry = resolveAgentSdkEntry(roots);
  if (entry === null) return null;
  try {
    const module = await import(pathToFileURL(entry).href) as Partial<AgentSdkModule>;
    return typeof module.query === "function" ? module as AgentSdkModule : null;
  } catch {
    return null;
  }
}

/**
 * 導入済みの `claude` の絶対パス（SDK を実行ファイル抜きで入れたときに使う）。
 * hub は launchd / SSH 非対話の狭い PATH で動くので、既知の置き場所も探す。
 */
export function resolveInstalledClaude(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const dirs = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(env["PATH"] ?? "").split(":").filter((dir) => dir.startsWith("/")),
  ];
  for (const dir of [...new Set(dirs)]) {
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      // 次の候補へ。
    }
  }
  return null;
}

/** SDK の同梱実行ファイル（optional 依存）が入っているか。入っていなければ導入済みの claude を渡す。 */
export function agentSdkHasBundledExecutable(entry: string): boolean {
  const platformPackage = `${AGENT_SDK_PACKAGE}-${process.platform}-${process.arch}`;
  try {
    createRequire(entry).resolve(`${platformPackage}/package.json`);
    return true;
  } catch {
    return false;
  }
}
