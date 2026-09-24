// codexSystemNotice.ts
// tailii (TS host) — Codex App Server / rollout の利用者向けエラー・警告を
// chat_output(system) へ正規化する。live と rollout の二重経路は同じ streamId / 本文を
// 作り、Session Hub と iOS の双方で冪等に扱えるようにする。

import { createHash } from "node:crypto";
import { PROTOCOL_V1, type CodexGoalInfo, type ControlMessage } from "../protocol.js";

const NOTICE_STREAM_PREFIX = "codex-notice-";
const NOTICE_DETAIL_LIMIT = 240;
const NOTICE_NAME_LIMIT = 80;
const DEPRECATION_LOG_LIMIT = 400;

export interface CodexSystemNotice {
  /** App Server live item の重複排除キー。ThreadItem 由来なら生の item id を使う。 */
  itemId: string;
  payload: Extract<ControlMessage, { type: "chat_output" }>;
}

/** Codex 専用 system 注記だけを rollout/live occurrence 照合の対象にする。 */
export function codexSystemNoticeContentKey(payload: ControlMessage): string | null {
  if (payload.type !== "chat_output" || payload.role !== "system" ||
    !payload.streamId.startsWith(NOTICE_STREAM_PREFIX)) return null;
  return `system\u0000${payload.text}`;
}

/** App Server item/completed の mcpToolCall 失敗を表示用注記へ変換する。 */
export function codexMcpItemErrorNotice(
  item: Record<string, unknown>,
): CodexSystemNotice | null {
  if (item["type"] !== "mcpToolCall") return null;
  const id = nonEmptyString(item["id"]);
  if (id === null) return null;
  const error = asRecord(item["error"]);
  const errorMessage = nonEmptyString(error?.["message"]);
  if (item["status"] !== "failed" && errorMessage === null) return null;
  return notice(
    id,
    `mcp:${id}`,
    mcpErrorText(item["server"], item["tool"], errorMessage),
  );
}

/** rollout event_msg の利用者向け error / warning を表示用注記へ変換する。 */
export function codexRolloutSystemNotice(
  payload: Record<string, unknown>,
): CodexSystemNotice | null {
  const kind = payload["type"];
  if (kind === "mcp_tool_call_end") {
    const id = nonEmptyString(payload["call_id"]);
    if (id === null) return null;
    const result = asRecord(payload["result"]);
    if (result === null) return null;
    const transportError = nonEmptyString(result["Err"]);
    const toolResult = asRecord(result["Ok"]);
    const toolReportedError = toolResult?.["isError"] === true || toolResult?.["is_error"] === true;
    if (transportError === null && !toolReportedError) return null;
    const invocation = asRecord(payload["invocation"]);
    const detail = transportError ?? textContent(toolResult?.["content"]);
    return notice(
      id,
      `mcp:${id}`,
      mcpErrorText(invocation?.["server"], invocation?.["tool"], detail),
    );
  }

  if (kind !== "error" && kind !== "stream_error" && kind !== "warning") return null;
  const message = noticeMessage(payload);
  if (message === null) return null;
  const turnId = nonEmptyString(payload["turn_id"]) ?? "unknown-turn";
  const attempt = nonNegativeInteger(payload["retry_attempt"]);
  const maxRetries = nonNegativeInteger(payload["max_retries"]);
  const retrying = kind === "stream_error" &&
    (maxRetries === null || attempt === null || attempt < maxRetries);
  const detail = clip(message, NOTICE_DETAIL_LIMIT);
  const text = kind === "warning"
    ? `⚠️ Codex 警告: ${detail}`
    : retrying
      ? `⚠️ Codex エラー（自動再試行中）: ${detail}`
      : `❌ Codex エラー: ${detail}`;
  // 同じ stream_error の再試行は 1 件へ畳み、上限到達（retrying=false）だけ別注記にする。
  // retry attempt を ID に含めると 502 × 10 回のような一時障害で会話が埋まってしまう。
  const identity = `${String(kind)}:${turnId}:${retrying ? "retrying" : "terminal"}:${detail}`;
  return notice(`rollout:${identity}`, identity, text);
}

/** App Server の item 以外の error / warning 通知を表示用注記へ変換する。 */
export function codexAppServerSystemNotice(
  method: string,
  params: Record<string, unknown> | null,
): CodexSystemNotice | null {
  if (params === null) return null;

  if (method === "error") {
    const turnId = nonEmptyString(params["turnId"]) ?? "unknown-turn";
    const message = turnErrorMessage(params["error"]);
    const willRetry = params["willRetry"] === true;
    const detail = clip(message ?? "Codex でエラーが発生しました。", NOTICE_DETAIL_LIMIT);
    return willRetry
      ? notice(
        `turn-retry:${turnId}:${detail}`,
        `turn-retry:${turnId}:${detail}`,
        `⚠️ Codex エラー（自動再試行中）: ${detail}`,
      )
      : notice(
        `turn-error:${turnId}`,
        `turn-error:${turnId}`,
        `❌ Codex エラー: ${detail}`,
      );
  }

  if (method === "turn/completed") {
    const turn = asRecord(params["turn"]);
    if (turn?.["status"] !== "failed") return null;
    const turnId = nonEmptyString(turn["id"]) ?? "unknown-turn";
    const detail = clip(
      turnErrorMessage(turn["error"]) ?? "ターンを完了できませんでした。",
      NOTICE_DETAIL_LIMIT,
    );
    return notice(
      `turn-error:${turnId}`,
      `turn-error:${turnId}`,
      `❌ Codex エラー: ${detail}`,
    );
  }

  if (method === "mcpServer/startupStatus/updated") {
    if (params["status"] !== "failed") return null;
    const name = clip(nonEmptyString(params["name"]) ?? "不明", NOTICE_NAME_LIMIT);
    const detail = nonEmptyString(params["error"])
      ?? (params["failureReason"] === "reauthenticationRequired"
        ? "再認証が必要です。"
        : "起動できませんでした。");
    const text = `❌ MCP サーバー「${name}」の起動に失敗しました: ${clip(detail, NOTICE_DETAIL_LIMIT)}`;
    return notice(`mcp-startup:${name}:${detail}`, `mcp-startup:${name}:${detail}`, text);
  }

  if (method === "mcpServer/oauthLogin/completed" && params["success"] === false) {
    const name = clip(nonEmptyString(params["name"]) ?? "不明", NOTICE_NAME_LIMIT);
    const detail = clip(nonEmptyString(params["error"]) ?? "ログインできませんでした。", NOTICE_DETAIL_LIMIT);
    return notice(
      `mcp-login:${name}:${detail}`,
      `mcp-login:${name}:${detail}`,
      `❌ MCP サーバー「${name}」のログインに失敗しました: ${detail}`,
    );
  }

  if (method === "warning" || method === "guardianWarning") {
    const message = nonEmptyString(params["message"]);
    if (message === null) return null;
    const detail = clip(message, NOTICE_DETAIL_LIMIT);
    const label = method === "guardianWarning" ? "Codex セキュリティ警告" : "Codex 警告";
    return notice(`${method}:${detail}`, `${method}:${detail}`, `⚠️ ${label}: ${detail}`);
  }

  // deprecationNotice には 2 系統ある: (a) client（Tailii host）の API 利用への通知（呼び出した
  // 接続だけに届く。実障害 2026-09-06: 「⚠️ Codex 非推奨機能: Full-history hydration is deprecated
  // for paginated threads…」がチャットに出た）、(b) config.toml の旧 feature 利用への通知（session
  // 開始時に配信）。どちらも動作は継続する情報通知で、(a) は利用者に無関係、(b) も会話の場で
  // 対処するものではないため chat へは流さず、codexDeprecationNoticeLogLine で hub.log へ記録する
  // （configWarning は設定の問題そのものを伝えるので従来どおり注記）。
  if (method === "configWarning") {
    const summary = nonEmptyString(params["summary"]);
    if (summary === null) return null;
    const details = nonEmptyString(params["details"]);
    const body = clip(details === null ? summary : `${summary} — ${details}`, NOTICE_DETAIL_LIMIT);
    return notice(`${method}:${body}`, `${method}:${body}`, `⚠️ Codex 設定警告: ${body}`);
  }

  return null;
}

// MARK: - 目標（codex-goal）

/** 目標状態の利用者向けラベル（iOS のバナーと同じ語）。未知の状態はそのまま返す。 */
export function codexGoalStatusLabel(status: string): string {
  switch (status) {
    case "active": return "追求中";
    case "paused": return "一時停止";
    case "blocked": return "行き詰まり";
    case "usageLimited": return "使用量上限で停止";
    case "budgetLimited": return "トークン予算に到達";
    case "complete": return "達成";
    default: return status;
  }
}

/**
 * 目標の状態 / 内容が変わったときだけ注記を出すための照合キー（tokensUsed 等の進捗更新では変えない）。
 * live（thread/goal/updated）と rollout（event_msg thread_goal_updated）の両系統で同じ規則を使う。
 */
export function codexGoalNoticeKey(goal: CodexGoalInfo | null): string {
  // createdAt を含めるのは、解除 → 同文で再設定した目標を「新しい目標」として再び注記するため
  // （streamId が同じだと iOS が既出行として捨てる）。同じ goal は live / rollout とも同じ createdAt。
  return goal === null ? "cleared" : `${goal.createdAt}\u0000${goal.status}\u0000${goal.objective}`;
}

/**
 * 目標の設定 / 状態変化の注記（🎯 目標（追求中）: …）。
 * streamId の identity には `updatedAt` も入れる: 一時停止 → 再開のように同じ状態へ戻る注記が最初の注記と
 * 同じ streamId になると、iOS が既出行として捨てて「状態が変わったときだけ注記する」が崩れるため。
 * live と rollout は同じ変化イベント（同じ updatedAt）から注記を作るので identity は一致する。
 */
export function codexGoalNotice(goal: CodexGoalInfo): CodexSystemNotice {
  const identity = `goal:${goal.createdAt}:${goal.updatedAt}:${goal.status}:${goal.objective}`;
  return notice(
    identity,
    identity,
    `🎯 目標（${codexGoalStatusLabel(goal.status)}）: ${clip(goal.objective, NOTICE_DETAIL_LIMIT)}`,
  );
}

/** 目標解除の注記。identity に直前の目標の createdAt を入れ、解除 → 再設定 → 解除の 2 回目も表示させる。 */
export function codexGoalClearedNotice(previousCreatedAt: number | null): CodexSystemNotice {
  const identity = `goal:cleared:${previousCreatedAt ?? "unknown"}`;
  return notice(identity, identity, "🎯 目標を解除しました");
}

/**
 * 実行中 turn への送信（turn/steer）は collaboration mode を変えられない。iOS のトグルと違う mode の turn が
 * 走っている間に送った場合の注記（次の turn から反映される）。
 */
export function codexCollaborationModeSteerNotice(
  requested: "plan" | "default",
  turnId: string,
): CodexSystemNotice {
  const identity = `collab-steer:${turnId}:${requested}`;
  const label = requested === "plan" ? "プランモード" : "通常モード";
  return notice(
    identity,
    identity,
    `⚠️ 実行中の turn には${label}を反映できません。今の応答が終わってからの送信で切り替わります。`,
  );
}

/** App Server `deprecationNotice` を診断ログ 1 行へ正規化する。表示用ではない。 */
export function codexDeprecationNoticeLogLine(
  params: Record<string, unknown> | null,
): string | null {
  if (params === null) return null;
  const summary = nonEmptyString(params["summary"]);
  if (summary === null) return null;
  const details = nonEmptyString(params["details"]);
  const body = clip(details === null ? summary : `${summary} — ${details}`, DEPRECATION_LOG_LIMIT);
  return `Codex App Server 非推奨通知（利用者には表示しない）: ${body}`;
}

function mcpErrorText(serverValue: unknown, toolValue: unknown, detailValue: string | null): string {
  const server = clip(nonEmptyString(serverValue) ?? "不明", NOTICE_NAME_LIMIT);
  const tool = clip(nonEmptyString(toolValue) ?? "不明", NOTICE_NAME_LIMIT);
  const detail = clip(detailValue ?? "ツールがエラーを返しました。", NOTICE_DETAIL_LIMIT);
  return `❌ MCP「${server} / ${tool}」エラー: ${detail}`;
}

function notice(itemId: string, identity: string, text: string): CodexSystemNotice {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return {
    itemId,
    payload: {
      type: "chat_output",
      v: PROTOCOL_V1,
      streamId: `${NOTICE_STREAM_PREFIX}${digest}`,
      role: "system",
      text,
      eof: true,
    },
  };
}

function noticeMessage(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyString(payload["message"]) ?? nonEmptyString(payload["content"]);
  if (direct !== null) return direct;
  return turnErrorMessage(payload["error"]);
}

function turnErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  const error = asRecord(value);
  if (error === null) return null;
  const message = nonEmptyString(error["message"]);
  const additional = nonEmptyString(error["additionalDetails"]);
  if (message === null) return additional;
  if (additional === null || message.includes(additional)) return message;
  return `${message} — ${additional}`;
}

function textContent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((entry): string[] => {
    if (typeof entry === "string" && entry.trim().length > 0) return [entry];
    const record = asRecord(entry);
    const text = nonEmptyString(record?.["text"]);
    return text === null ? [] : [text];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/** 改行を 1 段落へ畳み、Unicode scalar 単位で切り詰める。 */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  const characters = [...flat];
  return characters.length <= limit ? flat : characters.slice(0, limit).join("") + "…";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
