// apiAgent/config.ts
// API 作業の設定の検証と、利用者向けの文言（UI に「Mac」や端末バックエンド名を出さない）。

import type { ApiAgentConfig, ApiAgentErrorCode, ApiUsageCredential } from "../protocol/messages.js";
import { API_AGENT_PERMISSION_MODES, isApiAgentModel } from "./workerProtocol.js";

/** 1 ターンの上限の最大（USD）。誤入力で大きな額を使わないための天井。 */
export const API_AGENT_MAX_TURN_USD = 50;
/** 会話の累計上限の最大（USD）。 */
export const API_AGENT_MAX_CONVERSATION_USD = 500;
export const API_AGENT_MAX_TURNS_LIMIT = 200;

export function validApiAgentConfig(config: ApiAgentConfig): boolean {
  const { budget } = config;
  if (!isApiAgentModel(config.model)) return false;
  if (!API_AGENT_PERMISSION_MODES.includes(config.permissionMode)) return false;
  if (!(budget.turnUsd > 0 && budget.turnUsd <= API_AGENT_MAX_TURN_USD)) return false;
  if (!(budget.conversationUsd > 0 && budget.conversationUsd <= API_AGENT_MAX_CONVERSATION_USD)) return false;
  if (!Number.isInteger(budget.maxTurns) || budget.maxTurns < 1 || budget.maxTurns > API_AGENT_MAX_TURNS_LIMIT) return false;
  const source = config.keySource;
  if (source !== undefined && source.mode !== "automatic" && source.mode !== "file" && source.mode !== "environment") return false;
  if (source?.apiKey !== undefined) return false;
  return true;
}

function parseCredential(value: unknown): ApiUsageCredential | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const mode = obj["mode"];
  if (mode !== "automatic" && mode !== "file" && mode !== "environment") return null;
  if (obj["apiKey"] !== undefined) return null;
  for (const key of ["path", "environmentVariable", "workspaceId"]) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") return null;
  }
  return {
    mode,
    ...(typeof obj["path"] === "string" ? { path: obj["path"] } : {}),
    ...(typeof obj["environmentVariable"] === "string" ? { environmentVariable: obj["environmentVariable"] } : {}),
    ...(typeof obj["workspaceId"] === "string" ? { workspaceId: obj["workspaceId"] } : {}),
  };
}

/** 保存・内部プロトコルから設定を読み直す（型と値域を確かめる）。不正は null。 */
export function parseApiAgentConfig(value: unknown): ApiAgentConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const budget = obj["budget"];
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) return null;
  const b = budget as Record<string, unknown>;
  const keySource = parseCredential(obj["keySource"]);
  if (keySource === null || typeof obj["model"] !== "string" || typeof obj["permissionMode"] !== "string" ||
    typeof b["turnUsd"] !== "number" || typeof b["conversationUsd"] !== "number" || typeof b["maxTurns"] !== "number") return null;
  const config: ApiAgentConfig = {
    model: obj["model"],
    permissionMode: obj["permissionMode"] as ApiAgentConfig["permissionMode"],
    budget: { turnUsd: b["turnUsd"], conversationUsd: b["conversationUsd"], maxTurns: b["maxTurns"] },
    ...(keySource !== undefined ? { keySource } : {}),
  };
  return validApiAgentConfig(config) ? config : null;
}

export const API_AGENT_ERROR_MESSAGES: Record<ApiAgentErrorCode, string> = {
  no_api_key: "API キーが見つかりません。API 作業には Console の API キーを設定してください（定額プランのログインには切り替えません）。",
  unsupported_key_source: "このキーの取得元は API 作業では使えません。自動検出・ホスト上のファイル・環境変数から選んでください。",
  unexpected_auth: "API キー以外の認証で動こうとしたため、モデルを呼ぶ前に止めました。",
  budget_exhausted: "この会話の API 予算の上限に達しました。上限を上げると続けられます。",
  conversation_in_use: "この会話は別の場所で開かれているため、API 作業では実行できません。",
  sdk_unavailable: "API 作業に必要な Agent SDK がホストに入っていません。アプリで「準備する」を選ぶとホストに導入します。",
  sdk_version_mismatch: "ホストの Claude Code と Agent SDK の版が合いません。アプリで「準備する」を選ぶと合う版へ入れ直します（直らなければホストで `claude update` を実行してください）。",
  worker_failed: "API 作業を開始できませんでした。",
  not_open: "API 作業の会話が見つかりません。開き直してください。",
  invalid_config: "API 作業の設定が正しくありません。",
  terminal_busy: "この会話はいま処理中か、承認・質問への回答を待っています。止めるか終わるのを待ってから API キーで続けてください。",
  held_externally: "Tailii 以外（ターミナルや公式アプリ）でこの会話が実行中のため、API キーで続けられません。そちらを終了してからやり直してください。",
  terminal_stop_failed: "定額プラン側の会話を終えられなかったため、API キーで続けられませんでした。会話は今までどおり開き直せます。",
  turn_running: "API 作業のターンが実行中です。止めるか終わるのを待ってから戻してください。",
};

export class ApiAgentRejectedError extends Error {
  constructor(readonly code: ApiAgentErrorCode) {
    super(API_AGENT_ERROR_MESSAGES[code]);
    this.name = "ApiAgentRejectedError";
  }
}
