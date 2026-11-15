// workdir/claudeTerminal.ts
// Claude（端末で動く Claude Code）の会話の作業フォルダの変更（session-workdir-change）。
//
// 端末の Claude が動いているとき: Claude Code の `/cd <絶対パス>` を、ほかのスラッシュコマンドと同じ送信経路
// （sessionManager.sendTextSubmit。`/remote-control` の注入と同じ）で打ち、会話ログに移動が記録されたのを確かめて
// から成功を返す。2.1.325 の実測（2026-11-15）:
//   - `/cd` は会話を終えずに作業フォルダを移す。会話 id は変わらない。会話ログと付帯フォルダ（`<slug>/<id>/`）を移動先の
//     slug へ rename し、`{"type":"relocated","relocatedCwd":…}` と「Moved to …」の local_command 行を書く。移動先の
//     CLAUDE.md・プロジェクト設定（権限・フック）・MCP・スキルは読み直される（Claude への注記で確認）。設定由来の環境変数は
//     前のフォルダの分が残る（Claude Code の仕様）。Tailii のフックは `--settings` で渡しているので移動後も効く。
//   - 引数は行の残り全部（引用符は外さない。空白入りのパスもそのまま書く）。`~` と相対パスも解決するが、Tailii は
//     実体の絶対パスだけを送る。前後の空白は Claude が切り落とすので、そういう名前のフォルダは扱わない。
//   - 信頼していないフォルダでは移動前に確認の画面（既定の選択は「No, stay put」）が出る。動いている Claude は
//     `~/.claude.json` を読み直さないので、事前に信頼済みにしても出る（2026-11-15 実測）。Tailii は「Yes, move here」で
//     受け入れる。プロジェクトの MCP の承認・親フォルダ経由の信頼での権限規則の確認は、移動した後に出る（Esc で閉じる。
//     どちらも既定の安全な側）。キーを送るのは、画面の構造で `/cd` の画面と見分けられたときだけ。見分けられない画面
//     （MCP が複数・文言の違う版・ほかの承認や設問）には何も送らず、確認系の画面（`Enter to confirm`）が残るなら
//     failed で返して利用者に確認を頼む（その画面への打ち込みは送信の門番が断る）。
//   - ターンの実行中に打つと送信待ちに入り、ターンの後に実行される（枠が busy で断るので打たない）。
//   - 1 回も発話していない会話でも移る（会話ログはその場で移動先の slug に作られる）。
//   - 失敗（見つからない・フォルダでない等）は `<local-command-stdout>…` の user 行として会話ログに書かれる。
//
// 端末の Claude が動いていないとき（止まった会話・reaper が畳んだ会話）: 会話ログを移し（relocated 行を書き足す）、
// 次に開いたとき新しいフォルダで `--resume` される。
//
// 端末を終えて `--resume` で起動し直す方式は採らない（背景のコマンド・サブエージェント・Remote Control の接続が切れ、
// 起動に数秒かかる。`/cd` で同じことが会話を止めずにでき、受け身の追従（hub が relocated 行を拾う）とも同じ経路になる）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionBackend } from "../backend/sessionBackend.js";
import { claudeComposerBarVisible, inputBoxRealText, screenShowsConfirmDialogFooter, screenShowsDialogFooter } from "../backend/tmux.js";
import { preTrustFolder } from "../commands/launch.js";
import { classifyClaudeConversationHolders } from "../sessions/conversationDelete.js";
import { locateClaudeTranscript, moveClaudeTranscript, relocatedCwdOf } from "../sessions/claudeTranscriptLocator.js";
import { defaultPeerSessionsDir } from "../services/peerSessions.js";
import { findTrailingClaudeVersion, readObservedClaudeVersion } from "../shared/claudeVersionRecord.js";
import { versionAtLeast } from "../shared/cliVersions.js";
import { canonicalPath } from "../shared/paths.js";
import { WORKDIR_CHANGE_MESSAGES, workdirChangeFailure, type WorkdirChangeAdapter, type WorkdirChangeOutcome } from "./types.js";

export interface ClaudeWorkdirDeps {
  /** `~/.claude/projects`（テスト注入用）。 */
  projectsDir?: string;
  /** Claude の登録簿（`~/.claude/sessions`）。 */
  claudeSessionsDir: string;
  peerPidAlive?: (pid: number) => boolean;
  /** 移動先を信頼済みにする（`~/.claude.json`）。 */
  preTrust: (dir: string) => void;
  /** 会話ログを見に行く間隔と、移動を待つ上限。 */
  pollMs: number;
  timeoutMs: number;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** 会話ログから版が分からないときの、hub が観測した Claude Code の版。 */
  observedClaudeVersion: () => string | null;
}

/** `/cd` を実物で確かめた最も古い Claude Code の版（2026-11-15）。 */
export const MINIMUM_CD_CLAUDE_VERSION = "2.1.325";

export function defaultClaudeWorkdirDeps(): ClaudeWorkdirDeps {
  return {
    claudeSessionsDir: defaultPeerSessionsDir(),
    preTrust: (dir) => preTrustFolder(dir),
    pollMs: 200,
    timeoutMs: 15_000,
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => process.stderr.write(`[tailii-host workdir] ${message}\n`),
    observedClaudeVersion: () => readObservedClaudeVersion(),
  };
}

/** 会話ログの失敗行の時刻の許容ずれ（打つ前に書かれた古い行を拾わない）。 */
const RECORD_SKEW_MS = 5_000;

export function createClaudeTerminalWorkdirAdapter(overrides: Partial<ClaudeWorkdirDeps> = {}): WorkdirChangeAdapter {
  return async (request) => {
    const deps = { ...defaultClaudeWorkdirDeps(), ...overrides };
    const { session, meta, cwd, ctx } = request;
    const conversationId = meta.providerSessionId ?? meta.claudeSessionId;
    if (conversationId === undefined || conversationId.length === 0) {
      return workdirChangeFailure("failed", "この会話の記録が古いため変更できません。開き直してからお試しください。");
    }
    // `/cd` は引数の前後の空白を切り落とす（実測）。その名前のフォルダへは正しく移せない。
    if (cwd !== cwd.trim()) return workdirChangeFailure("invalid_cwd", "名前の前後に空白があるフォルダには変更できません。");

    const sessions = await ctx.sessionManager.list();
    const alive = sessions.some((info) => info.name === session && info.alive);
    const holders = await classifyClaudeConversationHolders({
      sessionId: conversationId,
      listSessions: async () => sessions,
      paneProcessIds: (name) => ctx.sessionManager.agentProcessIds?.(name) ?? Promise.resolve(null),
      claudeSessionsDir: deps.claudeSessionsDir,
      ...(deps.peerPidAlive !== undefined ? { peerPidAlive: deps.peerPidAlive } : {}),
    });
    if (holders.external.length > 0) {
      return workdirChangeFailure("busy",
        `Tailii 以外（ターミナルや公式アプリ）でこの会話が実行中のため変更できません（${holders.external.join(", ")}）。`);
    }
    const projects = deps.projectsDir !== undefined ? { projectsDir: deps.projectsDir } : {};
    if (!alive) {
      // 別の Tailii の画面（同じ会話の第 2 インスタンス）が動かしている間は、会話ログを動かさない。
      if (holders.tailii.length > 0) return workdirChangeFailure("busy", WORKDIR_CHANGE_MESSAGES.busy);
      return moveStoppedConversation(conversationId, meta.cwd, cwd, projects, deps);
    }
    const runningVersion = registryVersion(deps.claudeSessionsDir, conversationId, holders.tailii);
    return changeViaCd(session, conversationId, meta.cwd, cwd, request.ctx.sessionManager, runningVersion, projects, deps);
  };
}

/** 会話を掴んでいる Tailii の Claude の版（登録簿 `~/.claude/sessions/<pid>.json` の `version`。2.1.3xx 実測）。 */
function registryVersion(dir: string, conversationId: string, pids: readonly number[]): string | null {
  for (const pid of pids) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8")) as Record<string, unknown>;
      if (record["sessionId"] === conversationId && typeof record["version"] === "string") return record["version"];
    } catch {
      // 読めない記録は飛ばす。
    }
  }
  return null;
}

/** 端末の Claude が動いていない会話: 会話ログを移す（次に開くとき新しいフォルダで resume される）。 */
function moveStoppedConversation(
  conversationId: string, fromCwd: string, toCwd: string, projects: { projectsDir?: string }, deps: ClaudeWorkdirDeps,
): WorkdirChangeOutcome {
  const moved = moveClaudeTranscript({ conversationId, toCwd, fromCwd, ...projects });
  switch (moved.status) {
    case "moved":
    case "in_place":
    case "absent":
      deps.log(`止まっている会話の作業フォルダを変更 conversation=${conversationId} ${fromCwd} → ${toCwd} (${moved.status})`);
      return { ok: true, cwd: toCwd };
    case "conflict":
      return workdirChangeFailure("failed", "移動先のフォルダに同じ会話の記録が既にあるため変更できません。");
    case "failed":
      deps.log(`会話ログを移せませんでした conversation=${conversationId}: ${moved.error}`);
      return workdirChangeFailure("failed", "会話の記録を移せませんでした。");
  }
}

/** 端末の操作（`/cd` を打つ・画面を読む・確認の画面のキー）。 */
type CdTerminal = Pick<SessionBackend, "sendTextSubmit" | "sendKeys" | "captureVisibleAnsi"> &
  Partial<Pick<SessionBackend, "clearInputBox">>;

/**
 * 端末の Claude へ `/cd` を打ち、会話ログで移動を確かめる。`/cd` が出す確認の画面（2.1.325 実測 2026-11-15）には、
 * **画面の構造で `/cd` のものと見分けられ、`/cd` を打った後に新しく現れたときだけ**キーを送る。見分けられない画面
 * （ほかの承認・設問・知らない画面）には何も送らない（本物の承認や設問は既存の転写で利用者に届く）:
 *   - 移る前の「Moving to a new directory」（信頼していないフォルダ。動いている Claude は `~/.claude.json` を読み直さない
 *     ので、事前の信頼では消えない）: 利用者がアプリでフォルダを選んで確かめているので「Yes, move here」で受け入れる
 *     （会話の開始で Tailii がそのフォルダを信頼済みにするのと同じ扱い）。カーソルが「No, stay put」なら Down、
 *     「Yes, move here」にあると確かめた直後だけ Enter。
 *   - 移った後の画面（プロジェクトの MCP の承認・親フォルダ経由の信頼で権限規則を適用するかの確認）: Esc で閉じる。
 *     Esc はどちらも既定の安全な側（MCP は使わない・権限規則は適用しない）。残すと次の送信の文字が画面に飲まれる（実測）。
 * 成功は「Moved to」の完了行（確認の画面を閉じた後に書かれる）で確定する。relocated 行（移動の時点で書かれる）だけの
 * ときは、確認の画面が出ない状態がしばらく続いたのを確かめてから返す。
 */
async function changeViaCd(
  session: string,
  conversationId: string,
  fromCwd: string,
  toCwd: string,
  terminal: CdTerminal,
  runningVersion: string | null,
  projects: { projectsDir?: string },
  deps: ClaudeWorkdirDeps,
): Promise<WorkdirChangeOutcome> {
  const before = locateClaudeTranscript(conversationId, fromCwd, projects);
  // `/cd` を実物で確かめたのは 2.1.325。古い Claude は知らないコマンドを発話としてモデルへ回すことがある
  // （`cmd_unknown_model_fallback`）ので、版が分からないときも打たない。版は動いている Claude の登録簿 →
  // 会話ログの末尾 → hub が観測した版の順に見る。
  const version = runningVersion ?? (before === null ? null : findTrailingClaudeVersion(before.path)) ?? deps.observedClaudeVersion();
  const supported = versionAtLeast(version, MINIMUM_CD_CLAUDE_VERSION);
  if (supported !== true) {
    return workdirChangeFailure("unsupported", version === null
      ? "端末の Claude Code の版が分からないため変更できません。会話を一度送ってからお試しください。"
      : `Claude Code を ${MINIMUM_CD_CLAUDE_VERSION} 以降に更新すると、作業フォルダを変更できます（今は ${version}）。`);
  }
  // 次に起動し直したときの確認を省く（動いている Claude には効かない。下の確認の画面の受け入れで扱う）。
  deps.preTrust(toCwd);
  const baseline = before === null ? 0 : fileSize(before.path);
  // 打つ前に出ていた画面には反応しない（打った後に新しく現れたものだけ）。
  const beforeScreen = await captureScreen(terminal, session);
  const preexisting = beforeScreen === null ? null : classifyCdDialog(beforeScreen, toCwd);
  const injectedAtMs = deps.nowMs();
  // 送信確定ループへ「会話ログに `/cd` の結果（移動・完了・失敗）が書かれたら成立」と渡す。`/cd` は発話として残らず、
  // 移った後の入力欄の見え方で画面の判定が確定しないことがある（herdr で撃ち直しを最後まで繰り返し、「Moved to」の
  // 後も約 5 秒待っていた）。書かれた時点で抜けるので、それ以上 Enter は撃たれない（返した後にキーが遅れて入らない）。
  // 書かれていなければ従来どおり画面で確かめ、Enter の取りこぼしは撃ち直す。
  const cdRecorded = (): boolean => {
    const located = locateClaudeTranscript(conversationId, toCwd, projects);
    return located !== null && readCdProgress(located.path, baseline, toCwd, injectedAtMs).state !== "pending";
  };
  try {
    await terminal.sendTextSubmit(session, `/cd ${toCwd}`, {
      confirmSubmitted: cdRecorded,
      onSubmitVerdicts: (verdicts) => deps.log(`/cd の送信確定の判定 session=${session} verdicts=${verdicts.join(",") || "-"}`),
    });
    deps.log(`/cd を送りました session=${session} elapsedMs=${deps.nowMs() - injectedAtMs}`);
  } catch (error) {
    const rejected = error instanceof Error && error.name === "ChatInjectionRejectedError";
    deps.log(`/cd を送れませんでした session=${session}: ${String(error)}`);
    return rejected
      ? workdirChangeFailure("busy", error.message)
      : workdirChangeFailure("failed", "端末の Claude へ送れませんでした。");
  }
  const confirmBefore = beforeScreen !== null && confirmDialogVisible(beforeScreen);
  // 打つ前に入力欄（ボトムバー）が見えていたなら、「入力欄へ戻ったか」で落ち着いたかを見る（確認の画面の文言に頼らない。
  // 知らない文言の画面（実物: MCP が 2 つのときの `Space to select · Esc to reject all`）でもすり抜けない）。
  const barBefore = beforeScreen !== null && claudeComposerBarVisible(beforeScreen);
  /** 入力欄へ戻っていて、確認の画面が出ていない。 */
  const backAtComposer = (screen: string | null): boolean => {
    if (screen === null) return false;
    if (classifyCdDialog(screen, toCwd) !== null || screenShowsDialogFooter(screen) || confirmDialogVisible(screen)) return false;
    return barBefore ? claudeComposerBarVisible(screen) : true;
  };
  /**
   * 返す前の後始末: `/cd` の画面だと構造で見分けられた画面が残っていれば、同じ画面と確かめて Esc で閉じる（3 種類とも
   * Esc は安全な側: 移動しない・MCP を使わない・権限規則を適用しない）。見分けられない確認の画面（フッター
   * `Enter to confirm`）が新しく残っているなら、成功にせず failed で返す（押さえを放した後の送信はその画面に打ち込まれる
   * ので門番が断るが、利用者に画面の確認を頼む）。実際に移動が済んでいれば、記録は relocated 行の追従で合う。
   */
  const settle = async (outcome: WorkdirChangeOutcome): Promise<WorkdirChangeOutcome> => {
    let last = await captureScreen(terminal, session);
    // 入力欄へ戻っていれば（ふつうの成功）、この 1 回の取り込みだけで返す（待ちを入れない）。
    if (last !== null && backAtComposer(last)) return outcome;
    for (let closes = 0; closes < 2 && last !== null; closes += 1) {
      const recognized = classifyCdDialog(last, toCwd);
      if (recognized === null) break;
      const again = await captureScreen(terminal, session);
      if ((again === null ? null : classifyCdDialog(again, toCwd))?.kind !== recognized.kind) {
        last = again;
        break;
      }
      deps.log(`/cd の確認の画面を返す前に閉じます session=${session} dialog=${recognized.kind}`);
      await terminal.sendKeys(session, ["Escape"]).catch(() => {});
      await deps.sleep(SETTLE_AFTER_ESCAPE_MS);
      last = await captureScreen(terminal, session);
    }
    // 描き直しの途中のフレームを見誤らないよう、入力欄へ戻ったのを確かめられるまで少し読み直す。
    for (let reread = 0; reread < SETTLE_REREADS && last !== null && !backAtComposer(last); reread += 1) {
      await deps.sleep(SETTLE_REREAD_MS);
      last = await captureScreen(terminal, session);
    }
    if (last === null) return outcome;
    const leftOver = barBefore ? !backAtComposer(last) : confirmDialogVisible(last) && !confirmBefore;
    if (leftOver) {
      deps.log(`/cd の後に見分けられない画面が残っています session=${session}`);
      return workdirChangeFailure("failed", DIALOG_LEFT_MESSAGE);
    }
    return outcome;
  };
  const deadline = injectedAtMs + deps.timeoutMs;
  let downs = 0;
  let enters = 0;
  let escapes = 0;
  let calmSinceMs: number | null = null;
  for (;;) {
    const located = locateClaudeTranscript(conversationId, toCwd, projects);
    const progress = located === null ? { state: "pending" as const } : readCdProgress(located.path, baseline, toCwd, injectedAtMs);
    if (progress.state === "done" && !progress.outcome.ok) {
      deps.log(`/cd の結果 session=${session} error=${progress.outcome.error}`);
      return settle(progress.outcome);
    }
    const screen = await captureScreen(terminal, session);
    const recognized = screen === null ? null : classifyCdDialog(screen, toCwd);
    const fresh = recognized !== null && recognized.kind !== preexisting?.kind ? recognized : null;
    const relocated = progress.state === "relocated" || progress.state === "done";
    // 完了行（「Moved to」）が書かれ、`/cd` の確認の画面がもう無ければ確定。見分けられない画面が出ていても触らない。
    if (progress.state === "done" && fresh === null) {
      deps.log(`/cd の結果 session=${session} ok=true elapsedMs=${deps.nowMs() - injectedAtMs}`);
      return settle(progress.outcome);
    }
    if (fresh?.kind === "trust" && !relocated) {
      if (fresh.cursor === "no" && downs < 2) {
        // Down の直前にもう一度、同じ画面でカーソルが「No, stay put」にあることを確かめる（入力欄の Down は履歴を呼び戻す）。
        const again = await captureScreen(terminal, session);
        const confirm = again === null ? null : classifyCdDialog(again, toCwd);
        if (confirm?.kind === "trust" && confirm.cursor === "no") {
          downs += 1;
          await terminal.sendKeys(session, ["Down"]).catch(() => {});
          await deps.sleep(TRUST_DIALOG_KEY_GAP_MS);
        }
      } else if (fresh.cursor === "yes" && enters < 2) {
        // Enter の直前にもう一度、同じ画面でカーソルが「Yes, move here」にあることを確かめる。
        const again = await captureScreen(terminal, session);
        const confirm = again === null ? null : classifyCdDialog(again, toCwd);
        if (confirm?.kind === "trust" && confirm.cursor === "yes") {
          enters += 1;
          deps.log(`/cd の移動先を信頼して移ります session=${session}`);
          await terminal.sendKeys(session, ["Enter"]).catch(() => {});
        }
      }
    } else if ((fresh?.kind === "mcp" || fresh?.kind === "grants") && relocated && escapes < 2) {
      // Esc の直前にもう一度、同じ画面が出ていることを確かめる（閉じた後の Esc は入力欄で巻き戻しのメニューを開く）。
      const again = await captureScreen(terminal, session);
      const confirm = again === null ? null : classifyCdDialog(again, toCwd);
      if (confirm?.kind === fresh.kind) {
        escapes += 1;
        deps.log(`/cd の後の確認の画面を閉じます session=${session} dialog=${fresh.kind}`);
        await terminal.sendKeys(session, ["Escape"]).catch(() => {});
      }
    }
    // relocated 行だけ（完了行がまだ）: 移った後の確認の画面が描かれる前かもしれない。確認の画面が出ていない状態が
    // しばらく続いたら成功とする（完了行が書かれない版・書き遅れへの備え）。
    if (progress.state === "relocated") {
      if (!backAtComposer(screen)) calmSinceMs = null;
      else {
        calmSinceMs ??= deps.nowMs();
        if (deps.nowMs() - calmSinceMs >= RELOCATED_CALM_MS) {
          deps.log(`/cd で移動 session=${session} cwd=${progress.cwd}`);
          return settle({ ok: true, cwd: progress.cwd });
        }
      }
    }
    if (deps.nowMs() >= deadline) {
      // 時間切れ: 見分けた画面だけ閉じ（settle）、見分けられない画面には触らない。
      deps.log(`/cd の移動を確かめられませんでした session=${session} to=${toCwd} dialog=${recognized?.kind ?? "none"}`);
      if (progress.state === "relocated") return settle({ ok: true, cwd: progress.cwd });
      if (progress.state === "done") return settle(progress.outcome);
      // `/cd` が入力欄に残ったまま（Enter を取りこぼした）なら消す。残すと、押さえを放した後の利用者の送信で
      // 一緒に送られたり、残り物として扱われたりする。
      if (screen !== null && (inputBoxRealText(screen) ?? "").trimStart().startsWith("/cd ")) {
        deps.log(`/cd が入力欄に残っているので消します session=${session}`);
        await terminal.clearInputBox?.(session).catch(() => false);
      }
      return settle(workdirChangeFailure("failed", "作業フォルダの変更を確かめられませんでした。会話の画面で端末の様子を確かめてください。"));
    }
    await deps.sleep(deps.pollMs);
  }
}

/** 確認の画面のキーを受け付けない時間の余裕（画面が出た直後の Enter は誤操作として捨てられる。実測で 0.5 秒後は通った）。 */
const TRUST_DIALOG_KEY_GAP_MS = 600;
/** relocated 行だけのとき、確認の画面が出ない状態がこれだけ続いたら成功とする。 */
const RELOCATED_CALM_MS = 1_500;

async function captureScreen(terminal: CdTerminal, session: string): Promise<string | null> {
  try {
    // 今の画面（viewport）を読む（送信の門番と同じ取り込み）。herdr の `capturePane(joinWrappedLines)` は出力の
    // 記録（recent-unwrapped）で、描き直し前の古い画面（閉じた確認の画面・バーの無い途中のフレーム）が残って見え、
    // 「入力欄へ戻ったか」が遅れて満たされた（成功まで約 6 秒延びた）うえ、閉じた画面へ Esc を 2 回送っていた。
    return await terminal.captureVisibleAnsi(session);
  } catch {
    return null;
  }
}

/** Esc で閉じた後、画面が描き直されるのを待つ時間。 */
const SETTLE_AFTER_ESCAPE_MS = 300;
/** 返す前に入力欄へ戻ったかを読み直す回数と間隔。 */
const SETTLE_REREADS = 3;
const SETTLE_REREAD_MS = 200;
/** 見分けられない確認の画面が残ったときの補足（端末の種類や「Mac」は出さない）。 */
const DIALOG_LEFT_MESSAGE = "作業フォルダの変更のあとに端末で確認の画面が出ています。会話の画面で確認の内容を確かめてください。";

/** 画面の最下部に確認系ダイアログのフッター（行頭が `Enter to confirm`）が出ているか（送信の門番と同じ判定）。 */
function confirmDialogVisible(screen: string): boolean {
  return screenShowsConfirmDialogFooter(screen);
}

/** `/cd` の確認の画面（2.1.325 実測）。`cursor` は「移る前の確認」でカーソルのある選択肢。 */
export type CdDialog =
  | { kind: "trust"; cursor: "no" | "yes" }
  | { kind: "grants" }
  | { kind: "mcp" };

/** 確認の画面の最下行（行頭から。実測 2.1.325）。 */
const CD_DIALOG_FOOTER = "Enter to confirm · Esc to cancel";
/** MCP が 2 つ以上のときの承認の画面の最下行（実測 2.1.325。Esc は「全部拒否」）。 */
const CD_MCP_MULTI_FOOTER = "Space to select · Esc to reject all";
/** 下に続いてよい常駐の行（エージェントの欄・背景作業の行。`tmux.ts` の isTrailingTuiLine と同じ記号）。 */
const TRAILING_TUI_GLYPHS = new Set([0x29c9, 0x23fa, 0x25ef, 0x25cf]);
/** 題の行を探す範囲（選択肢の上の説明・警告・案内の行数の上限）。 */
const TITLE_SEARCH_LINES = 25;

/**
 * 画面の一番下のまとまりが `/cd` の確認の画面か（画面の構造で見分ける。本文中の同じ文字列では当たらない）:
 * フッター `Enter to confirm · Esc to cancel` が最下行（下に常駐の行だけ続いてよい）で、そのすぐ上に決まった選択肢の
 * 行が決まった順に並び、さらに上に題の行がある。「移る前の確認」と「権限規則の確認」は、題の次の行（折り返しを
 * つないだもの）が移動先のパスであることも確かめる。どれにも当たらなければ null。
 */
export function classifyCdDialog(screen: string, toCwd: string): CdDialog | null {
  // eslint-disable-next-line no-control-regex
  const lines = screen.split("\n").map((line) => line.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "").trim())
    .filter((line) => line !== "");
  let footer = lines.length - 1;
  while (footer >= 0 && TRAILING_TUI_GLYPHS.has(lines[footer]!.codePointAt(0) ?? 0)) footer -= 1;
  if (footer < 2 || (lines[footer] !== CD_DIALOG_FOOTER && lines[footer] !== CD_MCP_MULTI_FOOTER)) return null;
  const option = (index: number): { text: string; focused: boolean } | null => {
    const line = lines[index];
    if (line === undefined) return null;
    return line.startsWith("❯") ? { text: line.slice(1).trim(), focused: true } : { text: line, focused: false };
  };
  const titleIndex = (title: (line: string) => boolean, below: number): number => {
    for (let i = below; i >= Math.max(0, below - TITLE_SEARCH_LINES); i--) if (title(lines[i]!)) return i;
    return -1;
  };
  // 題の次の行から、折り返された（狭い画面では Ink が行を分ける。実測 60 桁）パスをつないで移動先と照らす。
  // 行の境目の空白は trim で消えるので、空白を除いて比べる。
  const pathFollows = (index: number): boolean => {
    const home = os.homedir();
    const squash = (text: string): string => text.replace(/\s+/gu, "");
    const targets = [toCwd, ...(toCwd.startsWith(`${home}/`) ? [`~${toCwd.slice(home.length)}`] : [])].map(squash);
    let joined = "";
    for (let i = index + 1; i <= Math.min(index + 8, footer - 1); i++) {
      joined += squash(lines[i]!);
      if (targets.includes(joined)) return true;
      if (!targets.some((target) => target.startsWith(joined))) return false;
    }
    return false;
  };
  const yes = option(footer - 1);
  const no = option(footer - 2);
  // 移る前の確認: [No, stay put][Yes, move here][フッター]。
  if (no?.text === "No, stay put" && yes?.text === "Yes, move here" && no.focused !== yes.focused) {
    const title = titleIndex((line) => line === "Moving to a new directory:", footer - 3);
    return title >= 0 && pathFollows(title) ? { kind: "trust", cursor: yes.focused ? "yes" : "no" } : null;
  }
  // 権限規則の確認（移った後）: [No, keep them off][Yes, trust it and apply them][フッター]。
  if (no?.text === "No, keep them off" && yes?.text === "Yes, trust it and apply them" && no.focused !== yes.focused) {
    const title = titleIndex((line) => line === "Now in a new directory:", footer - 3);
    return title >= 0 && pathFollows(title) ? { kind: "grants" } : null;
  }
  // MCP の承認（移った後, MCP が 2 つ以上。実物 2.1.325）: 題 `N new MCP servers found in this project`、選択肢
  // `[✔] <名前>` が 1 つ以上、`Enable selected`、フッター `Space to select · Esc to reject all`。カーソル（❯）は 1 つだけ。
  if (lines[footer] === CD_MCP_MULTI_FOOTER) {
    const enable = option(footer - 1);
    if (enable?.text !== "Enable selected") return null;
    let first = footer - 1;
    while (first - 1 >= 0 && /^\[.?\]\s+\S/u.test(option(first - 1)!.text)) first -= 1;
    if (first === footer - 1) return null;
    let focused = 0;
    for (let i = first; i <= footer - 1; i++) if (option(i)!.focused) focused += 1;
    if (focused !== 1) return null;
    const title = titleIndex((line) => /^\d+ new MCP servers found in this project$/u.test(line), first - 1);
    return title >= 0 ? { kind: "mcp" } : null;
  }
  if (lines[footer] !== CD_DIALOG_FOOTER) return null;
  // MCP の承認（移った後, MCP が 1 つ）: [Use this MCP server][Use this and all future …][Continue without …][フッター]。
  const mcp = [option(footer - 3), option(footer - 2), option(footer - 1)];
  if (mcp[0]?.text === "Use this MCP server" &&
    mcp[1]?.text === "Use this and all future MCP servers in this project" &&
    mcp[2]?.text === "Continue without using this MCP server" &&
    mcp.filter((entry) => entry?.focused === true).length === 1) {
    const title = titleIndex((line) => line.startsWith("New MCP server found in this project: "), footer - 4);
    return title >= 0 ? { kind: "mcp" } : null;
  }
  return null;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * `/cd` を打った後に会話ログへ書き足された行から結果を読む（`baseline` バイト目から。会話ログは rename で移っても
 * 同じ中身なので位置はそのまま使える）。まだ分からなければ null。
 */
export function readCdVerdict(file: string, baseline: number, toCwd: string, injectedAtMs: number): WorkdirChangeOutcome | null {
  const progress = readCdProgress(file, baseline, toCwd, injectedAtMs);
  if (progress.state === "done") return progress.outcome;
  return progress.state === "relocated" ? { ok: true, cwd: progress.cwd } : null;
}

/**
 * `/cd` の進み具合: `relocated` = 移動した（relocated 行。移った後の確認の画面がまだ出ているかもしれない）/ `done` =
 * 完了の出力（「Moved to」・失敗・「Already in」）/ `pending` = まだ何も無い。
 */
type CdProgress =
  | { state: "pending" }
  | { state: "relocated"; cwd: string }
  | { state: "done"; outcome: WorkdirChangeOutcome };

function readCdProgress(file: string, baseline: number, toCwd: string, injectedAtMs: number): CdProgress {
  let content: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = size >= baseline ? baseline : 0;
      const buf = Buffer.alloc(size - start);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { state: "pending" };
  }
  const target = canonicalPath(toCwd);
  let relocatedTo: string | null = null;
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    const relocated = relocatedCwdOf(line);
    if (relocated !== null) {
      if (canonicalPath(relocated) === target) relocatedTo = relocated;
      continue;
    }
    if (!line.includes("local-command-stdout")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const output = localCommandStdout(record);
    if (output === null) continue;
    if (record["type"] === "system" && output.startsWith("Moved to ") && mentionsPath(output, toCwd)) {
      return { state: "done", outcome: { ok: true, cwd: relocatedTo ?? toCwd } };
    }
    if (record["type"] !== "user") continue;
    const atMs = typeof record["timestamp"] === "string" ? Date.parse(record["timestamp"]) : Number.NaN;
    if (Number.isFinite(atMs) && atMs < injectedAtMs - RECORD_SKEW_MS) continue;
    const failure = cdFailure(output, toCwd);
    if (failure !== null) return { state: "done", outcome: failure };
  }
  return relocatedTo === null ? { state: "pending" } : { state: "relocated", cwd: relocatedTo };
}

/** 出力が `dir` を指しているか（Claude はホーム配下を `~/…` と短く書くことがある）。 */
function mentionsPath(output: string, dir: string): boolean {
  if (output.includes(dir)) return true;
  const home = os.homedir();
  return dir.startsWith(`${home}/`) && output.includes(`~${dir.slice(home.length)}`);
}

/** local_command の出力本文（`<local-command-stdout>…</local-command-stdout>` の中、装飾の制御文字を除く）。 */
function localCommandStdout(record: Record<string, unknown>): string | null {
  let content: unknown = record["content"];
  if (record["type"] === "user") {
    const message = record["message"];
    content = typeof message === "object" && message !== null ? (message as Record<string, unknown>)["content"] : null;
  }
  if (typeof content !== "string") return null;
  const match = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content);
  if (match === null) return null;
  // eslint-disable-next-line no-control-regex
  return (match[1] ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim();
}

/** `/cd` の失敗の出力（2.1.325 の文言）。関係ない出力は null。 */
function cdFailure(output: string, toCwd: string): WorkdirChangeOutcome | null {
  if (output.startsWith("Already in ")) return { ok: true, cwd: toCwd };
  // 古い Claude（`/cd` を知らない）。版が分からず打ったときの保険。
  if (output.startsWith("Unknown command: /cd") || output.startsWith("Unknown skill: cd")) {
    return workdirChangeFailure("unsupported", `Claude Code を ${MINIMUM_CD_CLAUDE_VERSION} 以降に更新すると、作業フォルダを変更できます。`);
  }
  if (output.startsWith("Couldn't find a directory at ") || output.includes(" is not a directory.")) {
    return workdirChangeFailure("invalid_cwd", "端末の Claude がフォルダを見つけられませんでした。");
  }
  if (output.startsWith("Staying in ")) {
    return workdirChangeFailure("failed", "端末の Claude の確認で移動が取り消されました。");
  }
  if (output.startsWith("Couldn't move to ")) {
    return workdirChangeFailure("failed", "端末の Claude が作業フォルダを移せませんでした。");
  }
  if (output.startsWith("Usage: /cd")) return workdirChangeFailure("failed", WORKDIR_CHANGE_MESSAGES.failed);
  return null;
}

export const changeClaudeTerminalWorkdir: WorkdirChangeAdapter = createClaudeTerminalWorkdirAdapter();
