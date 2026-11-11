// apiAgent/keyEnvironment.ts
// API 作業プロセスへ渡す環境変数を組む。
//
// - キーは既存の「API 実行用の取得元」（apiDelegateHostKeys / apiKeySource）から読む。
//   明示した取得元で見つからなければ止め、別のキー・サブスクのログインへ切り替えない。
// - 子プロセスへは許可した変数だけを渡す。親（hub / Claude Code 内）の CLAUDE_CODE_* や
//   ANTHROPIC_AUTH_TOKEN・ANTHROPIC_BASE_URL 等は渡さない（認証元・接続先を変えさせない）。
// - 個人用キー（sk-ant-usr…）にワークスペース ID が指定されていれば、Claude Code が読む
//   `ANTHROPIC_CUSTOM_HEADERS`（`Name: Value` 形式）で `anthropic-workspace-id` を付ける。
//   （公式 env-vars: ANTHROPIC_CUSTOM_HEADERS は v2.1.227 以降。ANTHROPIC_WORKSPACE_ID は
//   ワークロード ID フェデレーション専用でキーには効かない。）

import * as os from "node:os";
import * as nodePath from "node:path";
import type { ApiUsageCredential } from "../protocol/messages.js";

/**
 * SSH 非対話・launchd の狭い PATH を補う（commands/launch.ts の defaultInjectedPath と同じ並び）。
 * 作業プロセスに launch.ts（tmux / Codex を読み込む）を持ち込まないよう、ここに写す。
 */
function injectedPath(): string[] {
  return [
    "/opt/homebrew/bin",
    nodePath.join(os.homedir(), ".local/bin"),
    nodePath.join(os.homedir(), ".local/share/mise/shims"),
    "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
}

/** 作業プロセスへそのまま引き継ぐ変数（値は環境由来・秘密でないもの）。 */
const PASS_THROUGH = [
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "TZ",
  "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR",
] as const;

const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9_-]{1,128}$/;

export type ApiAgentKeyError = "no_api_key" | "unsupported_key_source";

export interface ApiAgentKeyResolution {
  /** 作業プロセスにだけ追加する変数（キーと任意のヘッダ）。ログ・ファイルへ書かない。 */
  secretEnv: Record<string, string>;
}

/** 作業プロセスの env（基本の変数 + 秘密）。PATH は SSH 非対話でも claude / git が見つかるよう補う。 */
export function apiAgentWorkerEnvironment(
  base: NodeJS.ProcessEnv,
  secretEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASS_THROUGH) {
    const value = base[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  const path = [...new Set([...(base["PATH"] ?? "").split(":"), ...injectedPath()].filter((p) => p.startsWith("/")))];
  env["PATH"] = path.join(":");
  for (const [name, value] of Object.entries(secretEnv)) env[name] = value;
  return env;
}

/** 作業プロセス → SDK の子プロセス（claude）へ渡す env。作業プロセスの env から再度選び直す。 */
export function apiAgentChildEnvironment(env: NodeJS.ProcessEnv, clientApp?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...PASS_THROUGH, "PATH", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS"]) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  if (clientApp !== undefined && /^[A-Za-z0-9._/-]{1,64}$/.test(clientApp)) out["CLAUDE_AGENT_SDK_CLIENT_APP"] = clientApp;
  return out;
}

/**
 * API 作業用のキーを解決する。`custom`（端末からキー本体を送る旧形式）と `disabled` は使わない。
 * 見つからなければ null（呼び出し側は no_api_key で止める）。
 */
export async function resolveApiAgentKey(
  source: ApiUsageCredential | undefined,
  deps: {
    hostApiKey: (provider: "claude", env: NodeJS.ProcessEnv, source?: ApiUsageCredential) => string | undefined;
    executionEnvironment: (provider: "claude", source?: ApiUsageCredential) => Promise<NodeJS.ProcessEnv>;
  },
): Promise<ApiAgentKeyResolution | ApiAgentKeyError> {
  if (source !== undefined && (source.mode === "custom" || source.mode === "disabled")) return "unsupported_key_source";
  if (source?.workspaceId !== undefined && !WORKSPACE_ID.test(source.workspaceId)) return "unsupported_key_source";
  let key: string | undefined;
  try {
    key = deps.hostApiKey("claude", await deps.executionEnvironment("claude", source), source);
  } catch {
    key = undefined;
  }
  if (key === undefined) return "no_api_key";
  const secretEnv: Record<string, string> = { ANTHROPIC_API_KEY: key };
  if (source?.workspaceId !== undefined && key.startsWith("sk-ant-usr")) {
    secretEnv["ANTHROPIC_CUSTOM_HEADERS"] = `anthropic-workspace-id: ${source.workspaceId}`;
  }
  return { secretEnv };
}
