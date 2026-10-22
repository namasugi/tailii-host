// codexSystemNotice.test.ts — Codex の error / warning を system 注記へ正規化する純ロジック。

import { describe, expect, test } from "vitest";
import {
  codexAppServerSystemNotice,
  codexDeprecationNoticeLogLine,
  codexGoalClearedNotice,
  codexGoalNotice,
  codexGoalNoticeKey,
  codexGoalStatusLabel,
  codexMcpItemErrorNotice,
  codexRolloutSystemNotice,
  codexSystemNoticeContentKey,
} from "../src/codex/codexSystemNotice.js";

describe("codexSystemNotice", () => {
  test("live / rollout の同じ MCP 失敗を同じ streamId と本文へ正規化する", () => {
    const live = codexMcpItemErrorNotice({
      type: "mcpToolCall",
      id: "call-1",
      server: "drive",
      tool: "search",
      status: "failed",
      error: { message: "permission denied" },
    });
    const rollout = codexRolloutSystemNotice({
      type: "mcp_tool_call_end",
      call_id: "call-1",
      invocation: { server: "drive", tool: "search", arguments: {} },
      result: { Err: "permission denied" },
    });

    expect(live).not.toBeNull();
    expect(rollout).not.toBeNull();
    expect(live?.itemId).toBe("call-1");
    expect(rollout?.itemId).toBe("call-1");
    expect(live?.payload).toEqual(rollout?.payload);
    expect(live?.payload).toMatchObject({
      role: "system",
      text: "❌ MCP「drive / search」エラー: permission denied",
      eof: true,
    });
    // 照合キーは streamId（出来事ごと）。live と rollout の同じ出来事は同じキーになる。
    expect(codexSystemNoticeContentKey(live!.payload)).toBe(`system\u0000${live!.payload.streamId}`);
    expect(codexSystemNoticeContentKey(rollout!.payload)).toBe(codexSystemNoticeContentKey(live!.payload));
  });

  test("MCP の isError content を表示し、成功は表示しない", () => {
    const failed = codexRolloutSystemNotice({
      type: "mcp_tool_call_end",
      call_id: "call-2",
      invocation: { server: "calendar", tool: "create" },
      result: { Ok: { isError: true, content: [{ type: "text", text: "invalid date" }] } },
    });
    const succeeded = codexRolloutSystemNotice({
      type: "mcp_tool_call_end",
      call_id: "call-3",
      invocation: { server: "calendar", tool: "list" },
      result: { Ok: { isError: false, content: [{ type: "text", text: "ok" }] } },
    });

    expect(failed?.payload.text).toBe("❌ MCP「calendar / create」エラー: invalid date");
    expect(succeeded).toBeNull();
    expect(codexMcpItemErrorNotice({
      type: "mcpToolCall", id: "call-4", server: "x", tool: "y", status: "completed",
      error: null,
    })).toBeNull();
  });

  test("App Server のターンエラー、警告、MCP 起動失敗を注記にする", () => {
    expect(codexAppServerSystemNotice("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: { message: "connection lost", additionalDetails: null },
    })?.payload.text).toBe("⚠️ Codex エラー（自動再試行中）: connection lost");

    expect(codexAppServerSystemNotice("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", error: { message: "retry exhausted" } },
    })?.payload.text).toBe("❌ Codex エラー: retry exhausted");

    expect(codexAppServerSystemNotice("warning", {
      threadId: "thread-1", message: "context is nearly full",
    })?.payload.text).toBe("⚠️ Codex 警告: context is nearly full");

    expect(codexAppServerSystemNotice("mcpServer/startupStatus/updated", {
      threadId: "thread-1", name: "notion", status: "failed", error: "handshake failed",
      failureReason: null,
    })?.payload.text).toBe("❌ MCP サーバー「notion」の起動に失敗しました: handshake failed");
  });

  test("deprecationNotice は利用者向け注記にせず、診断ログ 1 行へ正規化する", () => {
    // codex 0.153.4 が全履歴 hydration を呼んだ接続へ返す通知（実障害 2026-09-06 でチャットに出た）。
    const params = {
      summary: "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, " +
        "then page with `thread/turns/list` and `thread/items/list`.",
      details: null,
    };
    expect(codexAppServerSystemNotice("deprecationNotice", params)).toBeNull();
    expect(codexDeprecationNoticeLogLine(params)).toBe(
      "Codex App Server 非推奨通知（利用者には表示しない）: Full-history hydration is deprecated for " +
      "paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.",
    );
    expect(codexDeprecationNoticeLogLine({ summary: "legacy feature", details: "use x\ninstead" }))
      .toBe("Codex App Server 非推奨通知（利用者には表示しない）: legacy feature — use x instead");
    expect(codexDeprecationNoticeLogLine({ summary: "  ", details: "x" })).toBeNull();
    expect(codexDeprecationNoticeLogLine(null)).toBeNull();
    // ログ 1 行の上限（400 文字）で切る。
    expect(codexDeprecationNoticeLogLine({ summary: "x".repeat(500), details: null }))
      .toBe(`Codex App Server 非推奨通知（利用者には表示しない）: ${"x".repeat(400)}…`);
    // config の問題は利用者が直せるので従来どおり注記にする。
    expect(codexAppServerSystemNotice("configWarning", {
      summary: "unknown key `foo`", details: "in ~/.codex/config.toml",
    })?.payload.text).toBe("⚠️ Codex 設定警告: unknown key `foo` — in ~/.codex/config.toml");
  });

  test("同じ stream error の自動再試行は同じ streamId へ畳み、上限到達は別注記にする", () => {
    const retry1 = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "gateway timeout",
      retry_attempt: 1, max_retries: 3,
    });
    const retry2 = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "gateway timeout",
      retry_attempt: 2, max_retries: 3,
    });
    const terminal = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "gateway timeout",
      retry_attempt: 3, max_retries: 3,
    });

    expect(retry1?.payload.streamId).toBe(retry2?.payload.streamId);
    expect(retry1?.payload.streamId).not.toBe(terminal?.payload.streamId);
    expect(terminal?.payload.text).toBe("❌ Codex エラー: gateway timeout");
  });

  test("App Server の再試行は回数表記（Reconnecting... n/m）を外して turn × 原因で 1 行に畳む", () => {
    // 実障害 2026-10-21: websocket 切断の再試行 2/5〜5/5 が 4 行並んだ。
    const cause = "stream disconnected before completion: websocket closed by server before response.completed";
    const retries = [2, 3, 4, 5].map((n) => codexAppServerSystemNotice("error", {
      threadId: "thread-1", turnId: "turn-1", willRetry: true,
      error: { message: `Reconnecting... ${n}/5`, additionalDetails: cause },
    }));
    expect(new Set(retries.map((notice) => notice?.itemId)).size).toBe(1);
    expect(new Set(retries.map((notice) => notice?.payload.streamId)).size).toBe(1);
    expect(retries[0]?.payload.text).toBe(`⚠️ Codex エラー（自動再試行中）: ${cause}`);
    // 別 turn・別原因は別注記のまま。
    const otherTurn = codexAppServerSystemNotice("error", {
      threadId: "thread-1", turnId: "turn-2", willRetry: true,
      error: { message: "Reconnecting... 2/5", additionalDetails: cause },
    });
    expect(otherTurn?.payload.streamId).not.toBe(retries[0]?.payload.streamId);
    // 回数しか無い本文も空にはしない。
    expect(codexAppServerSystemNotice("error", {
      turnId: "turn-3", willRetry: true, error: { message: "Reconnecting... 1/5" },
    })?.payload.text).toBe("⚠️ Codex エラー（自動再試行中）: Reconnecting...");
    // 再試行でないエラー本文は手を加えない。
    expect(codexAppServerSystemNotice("error", {
      turnId: "turn-4", willRetry: false, error: { message: "Reconnecting... 5/5" },
    })?.payload.text).toBe("❌ Codex エラー: Reconnecting... 5/5");
    // rollout の stream_error も同じく回数を外して畳む。
    const r2 = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: `Reconnecting... 2/5 — ${cause}`,
      retry_attempt: 2, max_retries: 5,
    });
    const r3 = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: `Reconnecting... 3/5 — ${cause}`,
      retry_attempt: 3, max_retries: 5,
    });
    expect(r2?.payload.streamId).toBe(r3?.payload.streamId);
    expect(r2?.payload.text).toBe(`⚠️ Codex エラー（自動再試行中）: ${cause}`);
  });

  test("失敗で終わった turn は live（error / turn/completed failed）と rollout（task_complete.error）で同じ注記になる", () => {
    // 実障害 2026-10-23: 現行 Codex は error を rollout に保存せず、自動圧縮の失敗は task_complete.error に
    // しか残らなかった（Tailii には何も出なかった）。
    const message = "Error running remote compact task: Selected model is at capacity. Please try a different model.";
    const rollout = codexRolloutSystemNotice({
      type: "task_complete", root_turn_id: "turn-1", turn_id: "turn-1", last_agent_message: null,
      error: { message, codex_error_info: "server_overloaded" },
      started_at: 1792680032, completed_at: 1792681445, duration_ms: 1412963,
    });
    const liveCompleted = codexAppServerSystemNotice("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1", status: "failed", items: [],
        error: { message, codexErrorInfo: "serverOverloaded", additionalDetails: null },
      },
    });
    const liveError = codexAppServerSystemNotice("error", {
      threadId: "thread-1", turnId: "turn-1", willRetry: false,
      error: { message, codexErrorInfo: "serverOverloaded", additionalDetails: null },
    });

    expect(rollout?.payload.text).toBe(`❌ Codex エラー: ${message}`);
    expect(rollout?.payload).toEqual(liveCompleted?.payload);
    expect(rollout?.payload).toEqual(liveError?.payload);
    expect(rollout?.itemId).toBe(liveCompleted?.itemId);
    expect(codexSystemNoticeContentKey(rollout!.payload)).toBe(codexSystemNoticeContentKey(liveCompleted!.payload));
    // 429 の再試行上限のような構造化された codex_error_info でも本文を出す。
    expect(codexRolloutSystemNotice({
      type: "task_complete", turn_id: "turn-2", last_agent_message: null,
      error: {
        message: "exceeded retry limit, last status: 429 Too Many Requests",
        codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
      },
    })?.payload.text).toBe("❌ Codex エラー: exceeded retry limit, last status: 429 Too Many Requests");
    // API の 400 で本文の JSON がそのまま message に入るとき（0.163.0 実測）は、中の説明文だけを出す。
    const rawJson = JSON.stringify({
      type: "error", status: 400,
      error: { type: "invalid_request_error", message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." },
    });
    const readable = "❌ Codex エラー: The 'gpt-x' model is not supported when using Codex with a ChatGPT account.";
    expect(codexAppServerSystemNotice("error", {
      threadId: "thread-1", turnId: "turn-json", willRetry: false,
      error: { message: rawJson, codexErrorInfo: "other", additionalDetails: null },
    })?.payload.text).toBe(readable);
    expect(codexRolloutSystemNotice({
      type: "task_complete", turn_id: "turn-json", error: { message: rawJson, codex_error_info: "other" },
    })?.payload.text).toBe(readable);
    // 詳細は live（additionalDetails）でも rollout（additional_details）でも同じ本文に入る。
    const withDetails = codexAppServerSystemNotice("turn/completed", {
      turn: { id: "turn-details", status: "failed", error: { message: "stream failed", additionalDetails: "HTTP 502" } },
    });
    expect(withDetails?.payload.text).toBe("❌ Codex エラー: stream failed — HTTP 502");
    expect(codexRolloutSystemNotice({
      type: "task_complete", turn_id: "turn-details", error: { message: "stream failed", additional_details: "HTTP 502" },
    })?.payload).toEqual(withDetails?.payload);
    // JSON でない・説明文の無い JSON はそのまま。
    expect(codexAppServerSystemNotice("turn/completed", {
      turn: { id: "turn-brace", status: "failed", error: { message: "{not json" } },
    })?.payload.text).toBe("❌ Codex エラー: {not json");
    expect(codexAppServerSystemNotice("turn/completed", {
      turn: { id: "turn-brace", status: "failed", error: { message: "{\"status\":500}" } },
    })?.payload.text).toBe("❌ Codex エラー: {\"status\":500}");
    // 成功した turn・turn id の無い行は出さない。
    expect(codexRolloutSystemNotice({ type: "task_complete", turn_id: "turn-3", last_agent_message: "完了" })).toBeNull();
    expect(codexRolloutSystemNotice({ type: "task_complete", turn_id: "turn-3", error: null })).toBeNull();
    expect(codexRolloutSystemNotice({ type: "task_complete", error: { message } })).toBeNull();
  });

  test("中断で終わった turn は live（turn/completed interrupted）と rollout（turn_aborted）で同じ注記になる", () => {
    const rollout = codexRolloutSystemNotice({
      type: "turn_aborted", root_turn_id: "turn-1", turn_id: "turn-1", reason: "interrupted",
      started_at: 1792685258, completed_at: 1792685337, duration_ms: 78313,
    });
    const live = codexAppServerSystemNotice("turn/completed", {
      threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [], error: null },
    });

    expect(rollout?.payload).toMatchObject({ role: "system", text: "⏹️ 中断しました", eof: true });
    expect(rollout?.payload).toEqual(live?.payload);
    expect(rollout?.itemId).toBe(live?.itemId);
    // 中断ごとに別の行（同じ streamId だと iOS が後の中断を既出として読み飛ばす）。失敗の注記とも別。
    // 本文は毎回同じなので、hub の照合キーも本文ではなく streamId で分ける（前の中断と取り違えない）。
    const another = codexRolloutSystemNotice({ type: "turn_aborted", turn_id: "turn-2", reason: "interrupted" });
    expect(another?.payload.streamId).not.toBe(rollout?.payload.streamId);
    expect(another?.payload.text).toBe(rollout?.payload.text);
    expect(codexSystemNoticeContentKey(another!.payload)).not.toBe(codexSystemNoticeContentKey(rollout!.payload));
    expect(codexAppServerSystemNotice("turn/completed", {
      turn: { id: "turn-1", status: "failed" },
    })?.payload.streamId).not.toBe(live?.payload.streamId);
    // /compact の開始で止められた turn（replaced）も TUI と同じく中断として出す。
    expect(codexRolloutSystemNotice({ type: "turn_aborted", turn_id: "turn-3", reason: "replaced" })?.payload.text)
      .toBe("⏹️ 中断しました");
    // 正常完了・処理中は出さない。turn id の無い中断は出さない（別の中断と streamId が重なるため）。
    expect(codexAppServerSystemNotice("turn/completed", { turn: { id: "turn-4", status: "completed" } })).toBeNull();
    expect(codexAppServerSystemNotice("turn/completed", { turn: { id: "turn-4", status: "inProgress" } })).toBeNull();
    expect(codexAppServerSystemNotice("turn/completed", { turn: { status: "interrupted" } })).toBeNull();
    expect(codexRolloutSystemNotice({ type: "turn_aborted", reason: "interrupted" })).toBeNull();
  });

  test("目標のトークン予算で止まった turn には中断の注記を出さない（🎯 注記が理由を示す）", () => {
    expect(codexRolloutSystemNotice({ type: "turn_aborted", turn_id: "turn-1", reason: "budget_limited" }))
      .toBeNull();
    const budgetLimitedTurnIds = new Set(["turn-1"]);
    expect(codexAppServerSystemNotice("turn/completed", {
      threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" },
    }, { budgetLimitedTurnIds })).toBeNull();
    // 別の turn の中断は出す。
    expect(codexAppServerSystemNotice("turn/completed", {
      threadId: "thread-1", turn: { id: "turn-2", status: "interrupted" },
    }, { budgetLimitedTurnIds })?.payload.text).toBe("⏹️ 中断しました");
  });

  test("rollout に残った error / stream_error / warning は live の同じ出来事と同じ streamId になる（照合キーで 1 行に畳める）", () => {
    // 再試行中: live の error(willRetry) と rollout の stream_error（上限未満）。
    const liveRetry = codexAppServerSystemNotice("error", {
      turnId: "turn-1", willRetry: true, error: { message: "Reconnecting... 2/5 — stream disconnected" },
    });
    const rolloutRetry = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-1", message: "Reconnecting... 3/5 — stream disconnected",
      retry_attempt: 3, max_retries: 5,
    });
    expect(rolloutRetry?.payload.streamId).toBe(liveRetry?.payload.streamId);
    expect(codexSystemNoticeContentKey(rolloutRetry!.payload)).toBe(codexSystemNoticeContentKey(liveRetry!.payload));

    // 再試行なしのエラー: live の error(willRetry:false) / turn/completed failed と rollout の error。
    const liveError = codexAppServerSystemNotice("error", {
      turnId: "turn-2", willRetry: false, error: { message: "model at capacity" },
    });
    const rolloutError = codexRolloutSystemNotice({ type: "error", turn_id: "turn-2", message: "model at capacity" });
    const rolloutTerminalStream = codexRolloutSystemNotice({
      type: "stream_error", turn_id: "turn-2", message: "stream disconnected", retry_attempt: 5, max_retries: 5,
    });
    expect(rolloutError?.payload.streamId).toBe(liveError?.payload.streamId);
    expect(rolloutTerminalStream?.payload.streamId).toBe(liveError?.payload.streamId);
    expect(rolloutError?.payload.text).toBe(liveError?.payload.text);

    // 警告: live の warning と rollout の warning。
    const liveWarning = codexAppServerSystemNotice("warning", { message: "approaching usage limit" });
    const rolloutWarning = codexRolloutSystemNotice({ type: "warning", turn_id: "turn-3", message: "approaching usage limit" });
    expect(rolloutWarning?.payload.streamId).toBe(liveWarning?.payload.streamId);
    expect(rolloutWarning?.payload.text).toBe(liveWarning?.payload.text);

    // 別の turn の同文エラーは別の注記のまま（本文で照合して取り違えない）。
    const otherTurn = codexRolloutSystemNotice({ type: "error", turn_id: "turn-9", message: "model at capacity" });
    expect(otherTurn?.payload.streamId).not.toBe(rolloutError?.payload.streamId);
  });

  test("長い詳細は改行を畳んで上限で切る", () => {
    const notice = codexAppServerSystemNotice("warning", {
      message: "first\n" + "x".repeat(500),
    });
    expect(notice?.payload.text).not.toContain("\n");
    expect(notice?.payload.text).toContain("…");
    expect([...(notice?.payload.text ?? "")].length).toBeLessThan(280);
  });
});

describe("codexSystemNotice goal（codex-goal）", () => {
  test("目標注記は状態ラベル付きで、進捗だけの更新は同じ streamId / 照合キーになる", () => {
    const goal = {
      threadId: "t", objective: "ベンチ整備", status: "blocked",
      tokensUsed: 1, timeUsedSeconds: 2, createdAt: 3, updatedAt: 4,
    };
    const first = codexGoalNotice(goal);
    // 同じ変化イベント（同じ updatedAt）から作る live / rollout の注記は同じ streamId になる。
    expect(first.payload.streamId).toBe(codexGoalNotice({ ...goal }).payload.streamId);
    expect(first.payload.text).toBe("🎯 目標（行き詰まり）: ベンチ整備");
    // 照合キーは進捗（tokensUsed / updatedAt）では変わらず、状態が変わると変わる。
    expect(codexGoalNoticeKey(goal)).toBe(codexGoalNoticeKey({ ...goal, tokensUsed: 99, updatedAt: 5 }));
    expect(codexGoalNoticeKey(goal)).not.toBe(codexGoalNoticeKey({ ...goal, status: "active" }));
    // 一時停止 → 再開のように同じ状態へ戻る注記は別の streamId（iOS の既出照合で捨てられない）。
    const resumed = codexGoalNotice({ ...goal, status: "active", updatedAt: 9 });
    expect(resumed.payload.streamId).not.toBe(codexGoalNotice({ ...goal, status: "active", updatedAt: 2 }).payload.streamId);
    expect(codexGoalNoticeKey(null)).toBe("cleared");
    expect(codexGoalClearedNotice(3).payload.text).toBe("🎯 目標を解除しました");
    // 解除 → 再設定 → 解除の 2 回目は直前の目標の createdAt で区別する。
    expect(codexGoalClearedNotice(3).payload.streamId).not.toBe(codexGoalClearedNotice(7).payload.streamId);
    expect(codexGoalStatusLabel("usageLimited")).toBe("使用量上限で停止");
    expect(codexGoalStatusLabel("mystery")).toBe("mystery");
    expect(codexSystemNoticeContentKey(first.payload)).toBe(`system\u0000${first.payload.streamId}`);
  });
});
