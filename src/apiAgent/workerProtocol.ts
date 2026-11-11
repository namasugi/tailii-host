// apiAgent/workerProtocol.ts
// hub ↔ API 作業プロセス（Agent SDK を読み込む子プロセス）の NDJSON。iOS のワイヤーではない（内部専用）。
//
// 1 プロセス = 1 ターン。hub が `start` を 1 回送り、作業プロセスは `result` か `error` を返して終わる。
// API キーはこのプロトコルに載せない（子プロセスの環境変数だけで渡す）。

import type { ApiAgentPermissionMode } from "../protocol/messages.js";
export type { ApiAgentPermissionMode };

export const API_AGENT_PERMISSION_MODES: readonly ApiAgentPermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk"];

export interface WorkerStartCommand {
  t: "start";
  /** Claude の会話 id（UUID）。新規は SDK の `sessionId`、再開は `resume` に渡す。 */
  conversationId: string;
  resume: boolean;
  cwd: string;
  prompt: string;
  model: string;
  permissionMode: ApiAgentPermissionMode;
  maxTurns: number;
  /** このターンで使ってよい概算額（USD）。SDK の `maxBudgetUsd`。 */
  maxBudgetUsd: number;
  /** 読み込む設定（CLAUDE.md・許可ルール・スキル）。Tailii のフック設定は渡さない。 */
  settingSources: ("user" | "project" | "local")[];
  /** 導入済みの claude を使う場合の絶対パス。省略は SDK 同梱の実行ファイル。 */
  claudeExecutable?: string;
}

export interface WorkerPermissionResponse {
  t: "permission_response";
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
  /** allow のときに SDK へ返す入力（設問の回答など）。省略は元の入力のまま。 */
  updatedInput?: Record<string, unknown>;
}

export interface WorkerInterruptCommand { t: "interrupt" }

export type HubToWorker = WorkerStartCommand | WorkerPermissionResponse | WorkerInterruptCommand;

/** 認証の判定（モデルを呼ぶ前）。`ok=false` なら作業プロセスはプロンプトを送らずに終わる。 */
export interface WorkerAuthEvent {
  t: "auth";
  ok: boolean;
  apiKeySource: string | null;
  apiProvider: string | null;
  cliVersion: string | null;
}

export interface WorkerPermissionRequest {
  t: "permission_request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface WorkerResultEvent {
  t: "result";
  subtype: string;
  isError: boolean;
  /** SDK の `total_cost_usd`（再開した会話では以前の分を含む累計）。 */
  totalCostUsd: number | null;
  numTurns: number | null;
  sessionId: string | null;
  terminalReason: string | null;
}

export type WorkerErrorCode =
  | "sdk_unavailable"
  | "unexpected_auth"
  | "invalid_start"
  | "query_failed";

export interface WorkerErrorEvent {
  t: "error";
  code: WorkerErrorCode;
}

export type WorkerToHub = WorkerAuthEvent | WorkerPermissionRequest | WorkerResultEvent | WorkerErrorEvent;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function str(value: unknown): string | null { return typeof value === "string" ? value : null; }
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isConversationUuid(value: string): boolean { return UUID.test(value); }
export function isApiAgentModel(value: string): boolean { return MODEL.test(value); }

/** hub → 作業プロセスの 1 行を検証して読む。不正は null。 */
export function decodeHubToWorker(line: string): HubToWorker | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  const obj = record(raw);
  if (obj === null) return null;
  if (obj["t"] === "interrupt") return { t: "interrupt" };
  if (obj["t"] === "permission_response") {
    const requestId = str(obj["requestId"]);
    const behavior = obj["behavior"];
    if (requestId === null || (behavior !== "allow" && behavior !== "deny")) return null;
    const message = str(obj["message"]);
    const updatedInput = record(obj["updatedInput"]);
    return {
      t: "permission_response", requestId, behavior,
      ...(message !== null ? { message } : {}),
      ...(updatedInput !== null ? { updatedInput } : {}),
    };
  }
  if (obj["t"] !== "start") return null;
  const conversationId = str(obj["conversationId"]);
  const cwd = str(obj["cwd"]);
  const prompt = str(obj["prompt"]);
  const model = str(obj["model"]);
  const permissionMode = obj["permissionMode"];
  const maxTurns = finiteNumber(obj["maxTurns"]);
  const maxBudgetUsd = finiteNumber(obj["maxBudgetUsd"]);
  const settingSources = obj["settingSources"];
  const claudeExecutable = str(obj["claudeExecutable"]);
  if (conversationId === null || !UUID.test(conversationId)) return null;
  if (cwd === null || !cwd.startsWith("/")) return null;
  if (prompt === null || prompt.length === 0) return null;
  if (model === null || !MODEL.test(model)) return null;
  if (!API_AGENT_PERMISSION_MODES.includes(permissionMode as ApiAgentPermissionMode)) return null;
  if (maxTurns === null || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) return null;
  if (maxBudgetUsd === null || maxBudgetUsd <= 0 || maxBudgetUsd > 1000) return null;
  if (!Array.isArray(settingSources) || settingSources.some((s) => s !== "user" && s !== "project" && s !== "local")) return null;
  if (typeof obj["resume"] !== "boolean") return null;
  if (claudeExecutable !== null && !claudeExecutable.startsWith("/")) return null;
  return {
    t: "start", conversationId, resume: obj["resume"], cwd, prompt, model,
    permissionMode: permissionMode as ApiAgentPermissionMode, maxTurns, maxBudgetUsd,
    settingSources: [...new Set(settingSources as ("user" | "project" | "local")[])],
    ...(claudeExecutable !== null ? { claudeExecutable } : {}),
  };
}

/** 作業プロセス → hub の 1 行を検証して読む。不正は null。 */
export function decodeWorkerToHub(line: string): WorkerToHub | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  const obj = record(raw);
  if (obj === null) return null;
  switch (obj["t"]) {
    case "auth":
      if (typeof obj["ok"] !== "boolean") return null;
      return { t: "auth", ok: obj["ok"], apiKeySource: str(obj["apiKeySource"]), apiProvider: str(obj["apiProvider"]), cliVersion: str(obj["cliVersion"]) };
    case "permission_request": {
      const requestId = str(obj["requestId"]);
      const toolName = str(obj["toolName"]);
      const input = record(obj["input"]);
      if (requestId === null || toolName === null || input === null) return null;
      return { t: "permission_request", requestId, toolName, input };
    }
    case "result": {
      const subtype = str(obj["subtype"]);
      if (subtype === null || typeof obj["isError"] !== "boolean") return null;
      const numTurns = finiteNumber(obj["numTurns"]);
      return {
        t: "result", subtype, isError: obj["isError"],
        totalCostUsd: finiteNumber(obj["totalCostUsd"]),
        numTurns: numTurns !== null && Number.isInteger(numTurns) ? numTurns : null,
        sessionId: str(obj["sessionId"]), terminalReason: str(obj["terminalReason"]),
      };
    }
    case "error": {
      const code = obj["code"];
      if (code !== "sdk_unavailable" && code !== "unexpected_auth" && code !== "invalid_start" && code !== "query_failed") return null;
      return { t: "error", code };
    }
    default:
      return null;
  }
}

export function encodeWorkerLine(message: HubToWorker | WorkerToHub): string {
  return JSON.stringify(message) + "\n";
}
