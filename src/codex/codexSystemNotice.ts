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

/**
 * Codex 専用 system 注記だけを rollout/live occurrence 照合の対象にする。
 * 照合は本文ではなく streamId（出来事ごとの identity から作る）で行う。live と rollout は同じ出来事なら
 * 同じ streamId になる一方、「⏹️ 中断しました」のように本文が毎回同じ注記を本文で照合すると、履歴にある
 * 前の中断と新しい中断が同じものとみなされ、新しい方が配信済み扱いで落ちる（2026-10-23 レビューで再現）。
 */
export function codexSystemNoticeContentKey(payload: ControlMessage): string | null {
  if (payload.type !== "chat_output" || payload.role !== "system" ||
    !payload.streamId.startsWith(NOTICE_STREAM_PREFIX)) return null;
  return `system\u0000${payload.streamId}`;
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

/** rollout event_msg の利用者向け error / warning と、失敗・中断で終わった turn を表示用注記へ変換する。 */
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

  // 現行 Codex は error / stream_error / warning を rollout に保存しない（turn の終わりの task_complete /
  // turn_aborted は必ず保存する）。失敗した turn の理由は task_complete.error にしか残らないので、ここから
  // live の turn/completed（failed）と同じ注記を作る。開き直した履歴や、iPhone がつながっていない間に
  // 終わった turn でも理由が出る（実障害 2026-10-23: 自動圧縮が「Selected model is at capacity」で
  // 失敗して止まった会話に、Tailii では何も出ていなかった）。
  if (kind === "task_complete") {
    const error = asRecord(payload["error"]);
    const turnId = nonEmptyString(payload["turn_id"]);
    if (error === null || turnId === null) return null;
    return turnFailedNotice(turnId, turnErrorMessage(error));
  }
  if (kind === "turn_aborted") {
    const turnId = nonEmptyString(payload["turn_id"]);
    if (turnId === null) return null;
    // 目標のトークン予算で止まった turn は 🎯 目標注記（トークン予算に到達）が理由を示すので、
    // 中断の注記は出さない（TUI も中断ではなく予算到達として表示する）。
    if (payload["reason"] === "budget_limited") return null;
    return turnInterruptedNotice(turnId);
  }

  if (kind !== "error" && kind !== "stream_error" && kind !== "warning") return null;
  const message = noticeMessage(payload);
  if (message === null) return null;
  const turnId = nonEmptyString(payload["turn_id"]) ?? "unknown-turn";
  const attempt = nonNegativeInteger(payload["retry_attempt"]);
  const maxRetries = nonNegativeInteger(payload["max_retries"]);
  const retrying = kind === "stream_error" &&
    (maxRetries === null || attempt === null || attempt < maxRetries);
  const detail = clip(kind === "stream_error" ? withoutRetryCounter(message) : message, NOTICE_DETAIL_LIMIT);
  const text = kind === "warning"
    ? `⚠️ Codex 警告: ${detail}`
    : retrying
      ? `⚠️ Codex エラー（自動再試行中）: ${detail}`
      : `❌ Codex エラー: ${detail}`;
  // live（App Server の error / warning 通知）と同じ出来事は同じ identity にする（Hub と iOS は streamId で
  // 照合するので、形が違うと会話を開いている間や再走査で同じ注記が 2 行並ぶ）。
  // - 再試行中: live の error(willRetry) と同じ `turn-retry:<turnId>:<detail>`（回数を外して 1 行に畳む）
  // - 再試行なしのエラー: live の error / turn/completed failed と同じ `turn-error:<turnId>`
  // - 警告: live の warning と同じ `warning:<detail>`
  const identity = kind === "warning"
    ? `warning:${detail}`
    : retrying ? `turn-retry:${turnId}:${detail}` : `turn-error:${turnId}`;
  return notice(`rollout:${identity}`, identity, text);
}

export interface CodexAppServerSystemNoticeOptions {
  /**
   * 目標のトークン予算で止まった turn（`thread/goal/updated` の budgetLimited に付く turnId）。
   * App Server はこの止まり方も `turn/completed` の interrupted で知らせるので、中断の注記を出さない。
   */
  budgetLimitedTurnIds?: ReadonlySet<string>;
}

/** App Server の item 以外の error / warning 通知を表示用注記へ変換する。 */
export function codexAppServerSystemNotice(
  method: string,
  params: Record<string, unknown> | null,
  options: CodexAppServerSystemNoticeOptions = {},
): CodexSystemNotice | null {
  if (params === null) return null;

  if (method === "error") {
    const turnId = nonEmptyString(params["turnId"]) ?? "unknown-turn";
    const message = turnErrorMessage(params["error"]);
    const willRetry = params["willRetry"] === true;
    // 再試行中の本文は「Reconnecting... 2/5 — 原因」のように回数を含む。回数ごとに別注記に
    // なると 1 回の切断で 4〜5 行並ぶ（実障害 2026-10-21）ため、回数を外して turn × 原因で 1 行に畳む。
    const raw = message ?? "Codex でエラーが発生しました。";
    const detail = clip(willRetry ? withoutRetryCounter(raw) : raw, NOTICE_DETAIL_LIMIT);
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
    const status = turn?.["status"];
    if (status === "interrupted") {
      // 利用者の停止（iPhone の停止ボタン・端末の Esc）。App Server は止まった理由を渡さないので、
      // TUI と同じく予算到達の turn 以外はすべて中断として出す。turn id が無いと別の中断と
      // streamId が重なって後の中断が表示されなくなるため、その場合は出さない。
      const turnId = nonEmptyString(turn?.["id"]);
      if (turnId === null || options.budgetLimitedTurnIds?.has(turnId) === true) return null;
      return turnInterruptedNotice(turnId);
    }
    if (status !== "failed") return null;
    return turnFailedNotice(nonEmptyString(turn?.["id"]) ?? "unknown-turn", turnErrorMessage(turn?.["error"]));
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

/**
 * 非同期質問（codex-async-question）への回答を Codex へ届けられなかったときの注記（live 専用）。
 * - `expired`: 質問した turn が終わっていた（TUI と同じく締め切り。新しい turn は始めない）
 * - `uncertain`: 送ったが受理を確かめられなかった（timeout・切断。届いている可能性がある）
 * identity に質問の item id と種別を入れ、同じ質問への同じ失敗は 1 行にまとめる。
 */
export function codexAsyncAnswerFailedNotice(itemId: string, kind: "expired" | "uncertain"): CodexSystemNotice {
  const identity = `async-answer-failed:${kind}:${itemId}`;
  const text = kind === "expired"
    ? "⚠️ 質問した作業が終わっていたため、回答は Codex へ届きませんでした（必要ならメッセージで伝えてください）"
    : "⚠️ 質問への回答が Codex へ届いたか確認できませんでした（会話に回答が出ていなければメッセージで伝えてください）";
  return notice(identity, identity, text);
}

/**
 * 失敗で終わった turn の注記。live（App Server の `error` / `turn/completed` failed）と rollout
 * （task_complete.error）が同じ identity・本文になり、どちらから届いても 1 行にまとまる。
 */
function turnFailedNotice(turnId: string, message: string | null): CodexSystemNotice {
  const identity = `turn-error:${turnId}`;
  const detail = clip(message ?? "ターンを完了できませんでした。", NOTICE_DETAIL_LIMIT);
  return notice(identity, identity, `❌ Codex エラー: ${detail}`);
}

/**
 * 中断で終わった turn の注記（TUI の「■ Conversation interrupted」にあたる）。live の
 * `turn/completed` interrupted と rollout の turn_aborted が同じ identity・本文になる。
 */
function turnInterruptedNotice(turnId: string): CodexSystemNotice {
  const identity = `turn-interrupted:${turnId}`;
  return notice(identity, identity, "⏹️ 中断しました");
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

/**
 * Codex の再試行本文の先頭にある回数表記（`Reconnecting... 2/5`）を外す。
 * 回数しか無い本文は回数抜きの「Reconnecting...」を残す（空にしない）。
 */
function withoutRetryCounter(text: string): string {
  const stripped = text.replace(/^\s*Reconnecting\.\.\.\s*\d+\s*\/\s*\d+\s*(?:[—–-]\s*)?/u, "").trim();
  return stripped.length > 0 ? stripped : "Reconnecting...";
}

function noticeMessage(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyString(payload["message"]) ?? nonEmptyString(payload["content"]);
  if (direct !== null) return direct;
  return turnErrorMessage(payload["error"]);
}

function turnErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? readableErrorText(value) : null;
  const error = asRecord(value);
  if (error === null) return null;
  const rawMessage = nonEmptyString(error["message"]);
  const message = rawMessage === null ? null : readableErrorText(rawMessage);
  // live（App Server）は camelCase、rollout（Codex の event）は snake_case。どちらでも同じ本文にする。
  const additional = nonEmptyString(error["additionalDetails"]) ?? nonEmptyString(error["additional_details"]);
  if (message === null) return additional;
  if (additional === null || message.includes(additional)) return message;
  return `${message} — ${additional}`;
}

/**
 * API の 400 などで Codex がレスポンス本文の JSON をそのまま message にしたときは、中の説明文だけにする
 * （実測 0.163.0: `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"…"}}`）。
 * live と rollout はどちらもこの関数を通るので、本文は一致したまま。
 */
function readableErrorText(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return message;
  try {
    const parsed = asRecord(JSON.parse(trimmed));
    return nonEmptyString(asRecord(parsed?.["error"])?.["message"]) ??
      nonEmptyString(parsed?.["message"]) ??
      nonEmptyString(parsed?.["error"]) ??
      message;
  } catch {
    return message;
  }
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
