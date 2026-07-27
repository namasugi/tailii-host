// permissionMode.ts
// tailii (TS host) — Claude Code TUI の permission mode 判定（mode-picker）
// Swift 版 PermissionMode.swift の移植。
// TUI は Shift+Tab（BTab）で default → acceptEdits → plan → auto → default … を循環する。

/** プロトコルで扱うモード値。 */
export const KNOWN_MODES = ["default", "acceptEdits", "plan", "auto"] as const;

/**
 * pane 表示テキストから現在の permission mode を判定する（純ロジック）。
 * モードマーカーは入力欄直下のステータス行に出る。サブエージェント一覧が
 * その下に展開されるため、可視範囲末尾から明示的な TUI ステータス行を探す。
 * ダイアログ・処理中・再描画中はモード行が消えるため、判定不能として null を返す。
 * マーカーが無い画面を default とみなすと、auto 中の処理表示を確認モードと誤通知する。
 */
export function parsePermissionMode(paneText: string): string | null {
  const visibleLines = paneText
    .split("\n")
    .filter((line) => line.trim().length > 0);

  // モーダルの操作ヒントより下にも main + subagent 行が並ぶことがある。
  // モード行と同じ可視範囲で先に検出し、背後の古いモード行を採用しない。
  const statusLines = visibleLines.slice(-32);
  if (
    statusLines.some(
      (line) =>
        line.includes("to select") ||
        line.includes("to navigate") ||
        line.includes("to confirm") ||
        line.includes("to cancel"),
    )
  ) {
    return null;
  }

  // Claude はモード行の下に main + subagent 行を最大複数件表示する。
  // 会話本文の同じ語を拾わないよう、TUI 固有の行頭グリフと操作ヒントを必須にする。
  for (let i = statusLines.length - 1; i >= 0; i -= 1) {
    const line = statusLines[i]!.trimStart();
    const isTuiStatus = line.startsWith("⏵⏵") || line.startsWith("⏸");
    if (!isTuiStatus) continue;
    if (line.includes("accept edits on") && line.includes("shift+tab to cycle")) {
      return "acceptEdits";
    }
    if (line.includes("plan mode on") && line.includes("shift+tab to cycle")) return "plan";
    if (line.includes("auto mode on") && line.includes("shift+tab to cycle")) return "auto";
    if (line.includes("manual mode on")) return "default";
  }

  // Claude Code 2.1.207+ は default を "manual mode on" と明示する。
  // 旧版の idle prompt は単独の "? for shortcuts" だけなので後方互換で扱う。
  // agent/interrupt のヒントと同居する場合は active 画面なので default とみなさない。
  if (visibleLines.at(-1)?.trim() === "? for shortcuts") return "default";
  return null;
}
