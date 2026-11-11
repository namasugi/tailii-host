// apiAgent/defaults.ts
// hub が使う実物の依存（キーの取得元・作業プロセス・承認カード・登録簿）を組む。

import { buildDiff, buildSummary } from "../approval/hook.js";
import { requestApiAgentApproval } from "./approvalBridge.js";
import { apiExecutionEnvironment, hostApiKey } from "../services/apiDelegateHostKeys.js";
import { conversationHolders } from "./exclusivity.js";
import { apiAgentWorkerEnvironment, resolveApiAgentKey } from "./keyEnvironment.js";
import { ApiAgentManager, type ApiAgentManagerOptions } from "./manager.js";
import { agentSdkHasBundledExecutable, resolveAgentSdkEntry, resolveInstalledClaude } from "./sdkLoader.js";
import { agentSdkStatus } from "./sdkStatus.js";
import type { ApiAgentErrorCode } from "../protocol/messages.js";

/** ターン前の確認: SDK が無ければ sdk_unavailable、使う claude が SDK の想定より古ければ sdk_version_mismatch。 */
export function defaultApiAgentPreflight(status = agentSdkStatus()): ApiAgentErrorCode | null {
  switch (status.compatibility) {
    case "not_installed": return "sdk_unavailable";
    case "claude_missing": return "sdk_unavailable";
    case "claude_older": return "sdk_version_mismatch";
    default: return null;
  }
}
import { spawnApiAgentWorker } from "./workerProcess.js";

/** SDK を実行ファイル抜きで入れていれば、導入済みの claude を使わせる。同梱があれば SDK に任せる。 */
export function defaultClaudeExecutable(): string | null {
  const entry = resolveAgentSdkEntry();
  if (entry !== null && agentSdkHasBundledExecutable(entry)) return null;
  return resolveInstalledClaude();
}

export function createDefaultApiAgentManager(
  overrides: Partial<ApiAgentManagerOptions> & Pick<ApiAgentManagerOptions, "onProcessing" | "onStatus">,
): ApiAgentManager {
  return new ApiAgentManager({
    spawnWorker: (env) => spawnApiAgentWorker(env),
    resolveKey: (config) => resolveApiAgentKey(config.keySource, { hostApiKey, executionEnvironment: apiExecutionEnvironment }),
    workerEnvironment: (secretEnv) => apiAgentWorkerEnvironment(process.env, secretEnv),
    conversationHolders: (conversationId) => conversationHolders(conversationId),
    approval: (request) => requestApiAgentApproval(request),
    summarizeTool: (toolName, input) => {
      const diff = buildDiff(toolName, input);
      return { summary: buildSummary(toolName, input), ...(diff !== undefined ? { diff } : {}) };
    },
    claudeExecutable: defaultClaudeExecutable,
    preflight: () => defaultApiAgentPreflight(),
    ...overrides,
  });
}
