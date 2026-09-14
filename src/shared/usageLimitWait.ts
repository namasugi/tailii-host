// usageLimitWait.ts
// tailii (TS host) — Claude Code 2.1.234+ の「使用量制限の自動再開」待機フッターの転写
// （純ロジック, TESTABLE, usage-limit-wait）。iOS 側 `UsageLimitWaitParser` と同じ規則。
//
// CLI は claude.ai の使用量制限に当たると、ターンを終えて（transcript には `isApiErrorMessage`
// の合成 assistant 行 = api_error lifecycle）入力欄の下に 1 行の待機表示を出し、リセット時刻に
// 固定プロンプトで作業を再開する（docs/interactive-mode「Wait for a usage limit to reset」）:
//   - `Usage limit reached · continuing automatically at 3:45pm · esc to cancel`（待機中）
//   - `continuing shortly` / `Usage limit reset · continuing automatically`（再開中）
//   - `Your usage limit has reset · press enter to continue`（30 分超のスリープ後。Enter 待ち）
//   - `Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again`
// pane capture の末尾数行だけを見る（本文引用に反応しない）。ANSI は念のため剥がす。

export type UsageLimitWaitState =
  | { kind: "waiting"; resumeAt: string | null }
  | { kind: "resuming" }
  | { kind: "needs_enter" }
  | { kind: "stopped" };

/** フッター探索の行数（入力欄 + ショートカット行 + 待機行が収まる十分な幅）。 */
const FOOTER_SCAN_LINES = 16;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** pane 全文から待機状態を読む。該当なしは null。 */
export function parseUsageLimitWait(paneText: string): UsageLimitWaitState | null {
  const lines = paneText
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_PATTERN, "").trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-FOOTER_SCAN_LINES);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const state = parseUsageLimitWaitLine(tail[i]!);
    if (state !== null) return state;
  }
  return null;
}

/** 1 行を待機状態へ解釈する（TESTABLE）。該当なしは null。 */
export function parseUsageLimitWaitLine(line: string): UsageLimitWaitState | null {
  const lower = line.toLowerCase();
  if (lower.includes("automatic continue stopped")) return { kind: "stopped" };
  if (lower.includes("usage limit") && lower.includes("press enter to continue")) return { kind: "needs_enter" };
  if (lower.includes("usage limit reset") && lower.includes("continuing")) return { kind: "resuming" };
  if (lower.includes("continuing shortly")) return { kind: "resuming" };
  if (lower.includes("usage limit") && lower.includes("continuing automatically")) {
    const at = /continuing automatically at\s+(.+?)(?:\s+[·•・|]\s*|\s*$)/i.exec(line);
    return { kind: "waiting", resumeAt: at !== null ? at[1]!.trim() : null };
  }
  return null;
}

/** 2 状態の同値判定（遷移検知用）。 */
export function sameUsageLimitWait(
  lhs: UsageLimitWaitState | null,
  rhs: UsageLimitWaitState | null,
): boolean {
  if (lhs === null || rhs === null) return lhs === rhs;
  if (lhs.kind !== rhs.kind) return false;
  if (lhs.kind === "waiting" && rhs.kind === "waiting") return lhs.resumeAt === rhs.resumeAt;
  return true;
}

/** 通知（push / 注記）向けの日本語 1 行。 */
export function describeUsageLimitWait(state: UsageLimitWaitState): string {
  switch (state.kind) {
    case "waiting":
      return state.resumeAt !== null
        ? `使用量制限に達しました。${state.resumeAt} に自動再開します`
        : "使用量制限に達しました。リセット後に自動再開します";
    case "resuming":
      return "使用量制限がリセットされ、作業を自動再開しています";
    case "needs_enter":
      return "使用量制限がリセットされました。続行するには「続行」を押してください";
    case "stopped":
      return "使用量制限に繰り返し達したため自動再開を停止しました（/rate-limit-options）";
  }
}
