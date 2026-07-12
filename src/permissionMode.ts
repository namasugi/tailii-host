// permissionMode.ts
// tailii (TS host) — Claude Code TUI の permission mode 判定（mode-picker）
// Swift 版 PermissionMode.swift の移植。
// TUI は Shift+Tab（BTab）で default → acceptEdits → plan → auto → default … を循環する。

/** プロトコルで扱うモード値。 */
export const KNOWN_MODES = ["default", "acceptEdits", "plan", "auto"] as const;

/**
 * pane 表示テキストから現在の permission mode を判定する（純ロジック）。
 * モードマーカーは入力欄直下のステータス行に出るため、誤検知を避けて末尾4行のみを見る。
 * ダイアログ・処理中・再描画中はモード行が消えるため、判定不能として null を返す。
 * マーカーが無い画面を default とみなすと、auto 中の処理表示を確認モードと誤通知する。
 */
export function parsePermissionMode(paneText: string): string | null {
  const tailLines = paneText
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-4);
  const tail = tailLines.join("\n");
  if (
    tailLines.some(
      (line) =>
        line.includes("to select") ||
        line.includes("to navigate") ||
        line.includes("to confirm") ||
        line.includes("to cancel"),
    )
  ) {
    return null;
  }
  if (tail.includes("accept edits on")) return "acceptEdits";
  if (tail.includes("plan mode on")) return "plan";
  if (tail.includes("auto mode on")) return "auto";
  // Claude Code 2.1.207+ は default を "manual mode on" と明示する。
  // 旧版の idle prompt は "? for shortcuts" だけなので後方互換で扱う。
  if (tail.includes("manual mode on")) return "default";
  if (tailLines.some((line) => line.includes("? for shortcuts"))) return "default";
  return null;
}
