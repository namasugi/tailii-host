// usageLimitWait.ts
// tailii (TS host) — Claude Code 2.1.234+ の「使用量制限の自動再開」待機フッターの転写
// （純ロジック, TESTABLE, usage-limit-wait）。iOS 側 `UsageLimitWaitParser` と同じ規則。
//
// CLI は claude.ai の使用量制限に当たると、ターンを終えて（transcript には `isApiErrorMessage`
// の合成 assistant 行 = api_error lifecycle）入力欄の下に待機表示を出し、リセット時刻に
// 固定プロンプトで作業を再開する（docs/interactive-mode「Wait for a usage limit to reset」）。
//
// 入力欄の下の待機表示は **2.1.284 から 2 行の組**（状態行 `limit-status` + 次の手 `limit-next`）。
// 2.1.289 の組み立て（バイナリ実読）:
//   - 待機中: `Usage limit reached · limit resets 3:45pm` / `Continuing automatically at 3:45pm · esc to cancel`
//     （時刻不明は `… when it resets · esc to cancel`。後ろに ` · /usage-credits to continue now` が続くことがある）
//   - 再開中: `Usage limit reached · limit resets 3:45pm` / `Continuing shortly · esc to cancel`
//   - Enter 待ち（30 分超のスリープ後）: `Your usage limit has reset` / `Press enter to continue`
// 2 行目だけでは本文の引用と区別できないので、**直上の非空行に `limit` があること**を組の条件にする
// （状態行は `Usage limit …` か、wrap-up 表示の `… limit resets …`）。
//
// 会話面に流れる通知行（1 行で完結。2.1.278 以前のフッターもこの形）:
//   - `Usage limit reached · continuing automatically at 3:45pm · esc to cancel`（待機中）
//   - `Usage limit reached again · continuing automatically at …`（再到達）
//   - `continuing shortly` / `Usage limit reset · continuing automatically` /
//     `Usage limit available again · continuing now`（再開中）
//   - `Your usage limit has reset · press enter to continue` / `Usage limit has reset · press enter to continue`（Enter 待ち）
//   - `Automatic continue stopped …` / `Automatic continue was turned off …`（停止）
//   - `Automatic continue cancelled · /rate-limit-options to re-arm`（利用者が Esc で取り消した）
// 取り消しの通知より上に残る古い待機通知を拾わないよう、取り消し行に当たったら探索を打ち切る。
// pane capture の末尾数行だけを見る（本文引用に反応しない）。ANSI は念のため剥がす。

export type UsageLimitWaitState =
  | { kind: "waiting"; resumeAt: string | null }
  | { kind: "resuming" }
  | { kind: "needs_enter" }
  | { kind: "stopped" };

/** フッター探索の行数（入力欄 + ショートカット行 + 待機行が収まる十分な幅）。 */
const FOOTER_SCAN_LINES = 16;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 入力欄の直上で見る通知行の数（停止 / 取り消しの通知は入力欄のすぐ上に追記される）。 */
const NOTICE_SCAN_LINES = 4;

/** 入力欄のプロンプト記号（backend/tmux.ts `INPUT_PROMPT_SIGILS` と同じ）。 */
const INPUT_PROMPT_SIGILS = ["❯", "›", "!"] as const;

/**
 * pane 全文から待機状態を読む。該当なしは null。
 *
 * 待機中・再開中・Enter 待ちは**入力欄の下罫線より下（フッター）だけ**から読む。会話面の通知行は
 * transcript に追記されてスクロールバックに残り続け、本文が待機表示を引用することもあるので、
 * フッター以外から読むと終わった待機のカードや「続行」ボタンが出る。会話面からは入力欄の直上
 * 数行の停止 / 取り消しの通知だけを読む。罫線はあるが入力欄の枠と確かめられない画面（承認・`/login`
 * などのダイアログ表示中）は待機と読まない。罫線が 1 本も無い画面は従来どおり末尾全体から読む。
 */
export function parseUsageLimitWait(paneText: string): UsageLimitWaitState | null {
  const screen = paneLines(paneText);
  const frame = findInputFrame(screen);
  if (frame === "no-rule") return parseLegacyTail(nonEmptyTail(screen));
  if (frame === null) return null;
  return parseUsageLimitFooter(nonEmpty(screen.slice(frame.bottom + 1)))
    ?? parseRecentNotices(noticeLinesAboveInput(screen, frame.top));
}

/**
 * 自動再開を取り消した（Esc）/ 走らなかった直後か（TESTABLE）: その通知が入力欄の**すぐ上の最後の項目**
 * のときだけ true（transcript に残った古い通知の後に会話が進んでいれば false）。取り消しの直後は
 * フッターの待機表示が消えるので、`parseUsageLimitWait` だけでは「制限待ちの Esc」と分からない
 * （prompt-cancelled 判定のスキップに使う）。入力欄の枠が見つからない画面は false。
 */
export function usageLimitAutoContinueCancelled(paneText: string): boolean {
  const screen = paneLines(paneText);
  const frame = findInputFrame(screen);
  if (frame === null || frame === "no-rule") return false;
  const nearest = noticeLinesAboveInput(screen, frame.top).at(-1);
  return nearest !== undefined && isCancelNotice(nearest.toLowerCase());
}

/**
 * 入力欄の下（フッター）の行から待機状態を読む（TESTABLE）。2.1.284+ の 2 行組は状態行が端末幅で
 * 折り返すので、2 行目の条件は「フッター内でそれより上の行に `limit` がある」で見る。2 行目の文言は
 * サーバー設定で変わり得る（`{when}` を含むテンプレート）ので、状態行の下の `esc to cancel` を含む行も
 * 待機中（時刻不明）とみなす。
 */
export function parseUsageLimitFooter(footer: readonly string[]): UsageLimitWaitState | null {
  for (let i = footer.length - 1; i >= 0; i -= 1) {
    const line = footer[i]!;
    const lower = line.toLowerCase();
    // 2.1.283 以前の 1 行フッター（停止はフッターには出ない）。
    const single = parseUsageLimitWaitLine(line);
    if (single !== null && single.kind !== "stopped") return single;
    const above = footer.slice(0, i).join(" ").toLowerCase();
    if (lower.startsWith("press enter to continue") && above.includes("usage limit")) return { kind: "needs_enter" };
    if (lower.startsWith("continuing automatically") && above.includes("limit")) {
      // `… at` で折り返して時刻が次の行へ送られたときだけ次の行を繋ぐ（下のフッター行を飲み込まない）。
      const next = footer[i + 1];
      const wrapped = /\bat$/i.test(line) && next !== undefined ? `${line} ${next}` : line;
      return { kind: "waiting", resumeAt: resumeTime(wrapped) };
    }
  }
  for (let i = footer.length - 1; i >= 0; i -= 1) {
    if (!footer[i]!.toLowerCase().includes("esc to cancel")) continue;
    if (footer.slice(0, i).join(" ").toLowerCase().includes("usage limit")) return { kind: "waiting", resumeAt: null };
  }
  return null;
}

/** ANSI を剥がし、行末の空白だけ落とした全行（字下げは入力欄の続き行の判定に使う）。 */
function paneLines(paneText: string): string[] {
  return paneText.split(/\r?\n/).map((line) => line.replace(ANSI_PATTERN, "").trimEnd());
}

function nonEmpty(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function nonEmptyTail(lines: readonly string[]): string[] {
  return nonEmpty(lines).slice(-FOOTER_SCAN_LINES);
}

/**
 * 入力欄の枠（上下の罫線）。末尾 FOOTER_SCAN_LINES 非空行のうち最後の「`─` / `━` だけの行」を下罫線とし、
 * そこから上へ字下げの続き行・空行を飛ばした行がプロンプト記号で始まり、その 1 つ上が罫線で終わる
 * 行（名前付きの会話はタイトルが埋まる）なら入力欄と認める（backend/tmux.ts `findFrameAbovePrompt` と
 * 同じ規則）。pane に罫線が 1 本も無ければ "no-rule"、罫線はあるが入力欄と確かめられなければ null。
 */
function findInputFrame(lines: readonly string[]): { top: number; bottom: number } | "no-rule" | null {
  let seen = 0;
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0 && seen < FOOTER_SCAN_LINES; index -= 1) {
    const text = lines[index]!.trim();
    if (text.length === 0) continue;
    seen += 1;
    if (isPureRuleLine(text)) {
      bottom = index;
      break;
    }
  }
  // 末尾に罫線が無くても、pane のどこかに罫線があれば旧規則へは戻さない（本文の長いダイアログの上罫線が
  // 窓から外れた画面を、末尾全体を読む旧規則で読むと差分本文の文言を待機と取り違える）。
  if (bottom < 0) return lines.some(isPureRuleLine) ? null : "no-rule";
  let index = bottom - 1;
  while (index >= 0 && /^(?: {2}|\s*$)/u.test(lines[index]!)) index -= 1;
  if (index < 1) return null;
  if (!INPUT_PROMPT_SIGILS.some((sigil) => lines[index]!.startsWith(sigil))) return null;
  return /[─━]\s*$/u.test(lines[index - 1]!) ? { top: index - 1, bottom } : null;
}

/** `─` / `━` だけの 8 字以上の行（入力欄の下罫線の形）。 */
function isPureRuleLine(line: string): boolean {
  const scalars = [...line.trim()];
  return scalars.length >= 8 && scalars.every((char) => char === "─" || char === "━");
}

/** 入力欄の上罫線より上の、直近の通知行（非空・下が新しい。pane 全体から探す）。 */
function noticeLinesAboveInput(lines: readonly string[], top: number): string[] {
  return nonEmpty(lines.slice(0, top)).slice(-NOTICE_SCAN_LINES);
}

/** 直近の通知行（下が新しい）から停止を読む。取り消し / 不発の通知、利用者の発話が先に来たら null。 */
function parseRecentNotices(notices: readonly string[]): UsageLimitWaitState | null {
  for (let i = notices.length - 1; i >= 0; i -= 1) {
    const line = notices[i]!;
    const lower = line.toLowerCase();
    if (isCancelNotice(lower)) return null;
    if (isStoppedNotice(lower)) return { kind: "stopped" };
    // 停止の後に利用者が発話した（transcript の発話行）なら、その停止は過去のもの。
    if (INPUT_PROMPT_SIGILS.some((sigil) => line.startsWith(sigil)) || line.startsWith(">")) return null;
  }
  return null;
}

/** 罫線が 1 本も無い画面の読み方（2.1.283 以前の規則 + 2 行組の直上 1 行条件）。 */
function parseLegacyTail(tail: readonly string[]): UsageLimitWaitState | null {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i]!;
    if (isCancelNotice(line.toLowerCase())) return null;
    const state = parseUsageLimitWaitLine(line) ?? parseUsageLimitNextLine(line, tail[i - 1] ?? null);
    if (state !== null) return state;
  }
  return null;
}

/**
 * 2.1.284+ の 2 行組の 2 行目（`limit-next`）を、直上の非空行（`limit-status`）と合わせて解釈する
 * （TESTABLE。入力欄の罫線が見つからない画面用）。直上に `limit` が無ければ本文の引用とみなして null。
 */
export function parseUsageLimitNextLine(line: string, above: string | null): UsageLimitWaitState | null {
  if (above === null || !above.toLowerCase().includes("limit")) return null;
  const lower = line.toLowerCase();
  if (lower.startsWith("press enter to continue") && above.toLowerCase().includes("usage limit")) {
    return { kind: "needs_enter" };
  }
  if (lower.startsWith("continuing automatically")) {
    return { kind: "waiting", resumeAt: resumeTime(line) };
  }
  return null;
}

/** 取り消し（Esc）/ 不発（自動再開が走らなかった）の通知。これより上の古い待機通知は読まない。 */
function isCancelNotice(lower: string): boolean {
  return lower.includes("automatic continue cancelled") || lower.includes("automatic continue did not run");
}

/** 停止の通知（連続到達 / 24 時間超 / 無効化）。 */
function isStoppedNotice(lower: string): boolean {
  return lower.includes("automatic continue stopped") || lower.includes("automatic continue was turned off");
}

/** `continuing automatically at <時刻>` の時刻表記（区切り `·` `•` `・` `|` か行末まで）。 */
function resumeTime(line: string): string | null {
  const at = /continuing automatically at\s+(.+?)(?:\s+[·•・|]\s*|\s*$)/i.exec(line);
  return at !== null ? at[1]!.trim() : null;
}

/** 1 行を待機状態へ解釈する（TESTABLE）。該当なしは null。 */
export function parseUsageLimitWaitLine(line: string): UsageLimitWaitState | null {
  const lower = line.toLowerCase();
  if (isStoppedNotice(lower)) return { kind: "stopped" };
  if (lower.includes("usage limit") && lower.includes("press enter to continue")) return { kind: "needs_enter" };
  if (lower.includes("usage limit reset") && lower.includes("continuing")) return { kind: "resuming" };
  if (lower.includes("usage limit available again") && lower.includes("continuing")) return { kind: "resuming" };
  if (lower.includes("continuing shortly")) return { kind: "resuming" };
  // 再到達の通知でリセット時刻を過ぎていると `continuing automatically shortly`（= 再開中）。
  if (lower.includes("continuing automatically shortly")) return { kind: "resuming" };
  if (lower.includes("usage limit") && lower.includes("continuing automatically")) {
    return { kind: "waiting", resumeAt: resumeTime(line) };
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
      return "使用量制限の自動再開が止まりました（/rate-limit-options で対処を選べます）";
  }
}
