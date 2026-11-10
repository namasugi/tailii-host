import type { ApiUsageCredential } from "../protocol/messages.js";
import { DelegateError, claudeApiModelPrice } from "./claudeApiDelegate.js";
import { apiExecutionEnvironment, hostApiKey } from "./apiDelegateHostKeys.js";
import { claudeApiFederation, FederationError, validFederationSelection,
  type ApiFederationSelection } from "./claudeApiFederation.js";

export interface ApiClaudeModel { id: string; name: string; priceKnown: boolean }
export interface ApiClaudeModelsResult { models: ApiClaudeModel[]; error?: string }
export interface ApiClaudeModelsSelection {
  useHostApiKey?: boolean;
  keySource?: ApiUsageCredential;
  federation?: ApiFederationSelection;
}

export const CLAUDE_API_MODELS_TIMEOUT_MS = 12_000;
const ENDPOINT = "https://api.anthropic.com/v1/models";
const MAX_MODELS = 1000;
const MAX_PAGES = 10;
const MAX_BYTES = 2 * 1024 * 1024;
const validID = (value: unknown): value is string => typeof value === "string" && value.length <= 200
  && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:-]/.test(value);

interface Dependencies {
  fetcher?: typeof fetch;
  executionEnvironment?: typeof apiExecutionEnvironment;
  keyProvider?: typeof hostApiKey;
  federation?: Pick<typeof claudeApiFederation, "token">;
}

/** API会話で選んだ認証だけで一覧を取得する。Claude Code OAuthや他のキーへ切り替えない。 */
export async function fetchClaudeApiModels(
  selection: ApiClaudeModelsSelection,
  signal: AbortSignal = new AbortController().signal,
  dependencies: Dependencies = {},
): Promise<ApiClaudeModelsResult> {
  const timeout = AbortSignal.timeout(CLAUDE_API_MODELS_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    return await abortable(loadModels(selection, combined, dependencies), combined);
  } catch (error) {
    // APIのエラー本文・例外本文・認証値をクライアントやログへ返さない。
    return { models: [], error: signal.aborted ? "cancelled" : timeout.aborted ? "timeout"
      : error instanceof DelegateError || error instanceof FederationError ? error.code : "unavailable" };
  }
}

async function loadModels(selection: ApiClaudeModelsSelection, signal: AbortSignal, dependencies: Dependencies): Promise<ApiClaudeModelsResult> {
  signal.throwIfAborted();
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (selection.federation) {
    if (selection.useHostApiKey === true || selection.keySource !== undefined || !validFederationSelection(selection.federation)) {
      throw new DelegateError("invalid_request");
    }
    const token = await (dependencies.federation ?? claudeApiFederation).token(selection.federation, signal);
    headers["authorization"] = `Bearer ${token.token}`;
  } else {
    if (selection.useHostApiKey !== true) throw new DelegateError("invalid_request");
    const workspace = selection.keySource?.workspaceId;
    if (workspace !== undefined && (!/^wrkspc_[A-Za-z0-9_-]{1,128}$/.test(workspace) || /\s/.test(workspace))) {
      throw new DelegateError("invalid_request");
    }
    const environment = await (dependencies.executionEnvironment ?? apiExecutionEnvironment)("claude", selection.keySource);
    signal.throwIfAborted();
    const key = (dependencies.keyProvider ?? hostApiKey)("claude", environment, selection.keySource);
    if (!key) throw new DelegateError("host_key_unavailable");
    headers["x-api-key"] = key;
    if (workspace) headers["anthropic-workspace-id"] = workspace;
  }
  signal.throwIfAborted();
  const models = new Map<string, ApiClaudeModel>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let totalBytes = 0;
  let receivedModels = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    signal.throwIfAborted();
    const url = new URL(ENDPOINT);
    url.searchParams.set("limit", "100");
    if (cursor !== undefined) url.searchParams.set("after_id", cursor);
    const response = await (dependencies.fetcher ?? fetch)(url.toString(), { method: "GET", redirect: "error", headers, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DelegateError(response.status === 401 || response.status === 403
        ? (selection.federation ? "federation_auth_failed" : "auth_failed")
        : response.status === 429 ? "rate_limited" : "unavailable");
    }
    const body = await readPage(response, MAX_BYTES - totalBytes);
    totalBytes += body.bytes;
    const raw = record(body.value);
    if (!Array.isArray(raw["data"]) || typeof raw["has_more"] !== "boolean") throw new DelegateError("invalid_response");
    receivedModels += raw["data"].length;
    if (receivedModels > MAX_MODELS) throw new DelegateError("invalid_response");
    for (const item of raw["data"]) {
      const model = record(item);
      const id = model["id"], name = model["display_name"];
      if (!validID(id) || typeof name !== "string" || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) {
        throw new DelegateError("invalid_response");
      }
      if (!models.has(id)) models.set(id, { id, name, priceKnown: claudeApiModelPrice(id) !== undefined });
    }
    if (!raw["has_more"]) return { models: [...models.values()] };
    const next = raw["last_id"];
    if (!validID(next) || seenCursors.has(next)) throw new DelegateError("invalid_response");
    seenCursors.add(next);
    cursor = next;
  }
  // 途中の一覧を完全な一覧として表示しない。
  throw new DelegateError("invalid_response");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DelegateError("invalid_response");
  return value as Record<string, unknown>;
}

async function readPage(response: Response, remainingBytes: number): Promise<{ value: unknown; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new DelegateError("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > remainingBytes) throw new DelegateError("invalid_response");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, bytes }; }
  catch { throw new DelegateError("invalid_response"); }
}

/** シェル環境取得など、AbortSignalを受け取れない認証解決も全体期限内に返す。 */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new DelegateError("cancelled"));
    if (signal.aborted) { pending.catch(() => {}); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
