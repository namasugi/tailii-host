// apiAgent/setupStep.ts
// `tailii setup` の中の Agent SDK の準備（導入の契機 1）。失敗しても setup 全体は失敗させず、結果を 1 行で知らせる。
// 省くとき: `tailii setup --no-api-agent` か環境変数 `TAILII_SKIP_API_AGENT=1`。

import { agentSdkStatus, type AgentSdkStatus } from "./sdkStatus.js";
import { installAgentSdkAtomic, sdkNeedsInstall, type SdkInstallResult } from "./sdkInstaller.js";

export function shouldSkipApiAgentSetup(skipFlag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return skipFlag || env["TAILII_SKIP_API_AGENT"] === "1";
}

/** setup の 1 行（成功・失敗・省略・導入済み）。導入はここでだけ行う。 */
export async function runApiAgentSetupStep(options: {
  skip: boolean;
  write: (line: string) => void;
  status?: () => AgentSdkStatus;
  install?: () => Promise<SdkInstallResult | { ok: false; error: "busy" }>;
}): Promise<void> {
  if (options.skip) {
    options.write("Agent SDK（API 作業用）: 指定により準備を省きました（アプリで API 作業を始めるときに準備されます）。");
    return;
  }
  const status = (options.status ?? (() => agentSdkStatus()))();
  const need = sdkNeedsInstall(status);
  if (need === "none") {
    options.write(`Agent SDK（API 作業用）: 導入済みです（${status.sdkVersion ?? "?"}）。`);
    return;
  }
  if (need === "claude_missing") {
    options.write("Agent SDK（API 作業用）: Claude Code が見つからないため準備を省きました（API 作業を使うときに Claude Code が必要です）。");
    return;
  }
  let result: SdkInstallResult | { ok: false; error: "busy" };
  try {
    result = await (options.install ?? (() => installAgentSdkAtomic()))();
  } catch (error) {
    options.write(`Agent SDK（API 作業用）: 準備できませんでした（${String(error)}）。後で \`tailii api-agent install\` を実行できます。`);
    return;
  }
  if (result.ok) {
    options.write(`Agent SDK（API 作業用）: ${result.version} を準備しました。`);
  } else if (result.error === "busy") {
    options.write("Agent SDK（API 作業用）: 別の準備が進行中のため省きました。");
  } else {
    options.write(`Agent SDK（API 作業用）: 準備できませんでした。${result.message} 後で \`tailii api-agent install\` を実行できます。`);
  }
}
