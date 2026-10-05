// engine/handlers/mode.ts
// pane TUI との相互作用: permission mode の読み取り/切替（BTab 巡回）と、
// Codex TUI 番号付きダイアログへの選択返送（pane_choice_send）。

import { parsePermissionMode } from "../../shared/permissionMode.js";
import { parseUsageLimitWait, usageLimitAutoContinueCancelled } from "../../shared/usageLimitWait.js";
import { sleep } from "../../shared/sleep.js";
import type { SessionBackend } from "../../backend/sessionBackend.js";
import {
  classifySubmitFrame, inputBoxRealText, inputBoxResidueText, inputBoxTextMatchesRecordedPrompt, inputResidueExcerpt,
  loginCodeErrorMessage, type SubmitFrameVerdict,
} from "../../backend/tmux.js";
import { findTrailingUserPromptText } from "../../chat/transcriptTailer.js";
import type { ControlMessage } from "../../protocol.js";
import {
  engineDiag,
  writeError,
  type HandlerContext,
  type HandlerRegistry,
  type ModeTiming,
} from "../context.js";

export const modeHandlers: HandlerRegistry = {
  mode_get: async (message, ctx) => {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // 現在の permission mode を pane 表示から判定して返す（dialog 中は短く再試行）。
    try {
      const mode = await waitForPermissionMode(
        sessionManager,
        message.session,
        ctx.modeTiming.getAttempts,
        ctx.modeTiming.getPollMs,
      );
      if (mode === null) {
        writeError(
          writer, v, message.id,
          "mode_unavailable", "ダイアログ表示中のためモードを判定できません",
        );
      } else {
        writer.write({ type: "mode_set_response", v, id: message.id, mode });
      }
    } catch (error) {
      writeError(writer, v, message.id, "mode_get_failed", String(error));
    }
  },

  mode_set: (message, ctx) => {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // mode_set は dialog 待ちが長くなり得るため、read loop を塞がず detached で処理する。
    if (state.modeSetInFlight.has(message.session)) {
      writeError(writer, v, message.id, "mode_set_busy", "mode_set が実行中です。");
      return;
    }
    state.modeSetInFlight.add(message.session);
    void (async () => {
      try {
        const result = await setPermissionMode(
          sessionManager,
          message.session,
          message.mode,
          ctx.modeTiming,
        );
        if (result.kind === "unavailable") {
          writeError(writer, v, message.id, "mode_unavailable", "ダイアログ表示中のためモードを判定できません");
        } else if (result.mode === null) {
          writeError(writer, v, message.id, "mode_set_failed", "permission mode の切替に失敗しました。");
        } else {
          writer.write({ type: "mode_set_response", v, id: message.id, mode: result.mode });
        }
      } catch (error) {
        writeError(writer, v, message.id, "mode_set_failed", String(error));
      } finally {
        state.modeSetInFlight.delete(message.session);
      }
    })();
  },

  pane_choice_send: async (message, ctx) => {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // Codex TUI の番号付きダイアログ（CLI 更新確認・フック信頼確認など）への選択返送。
    // iOS の PTY(tmux attach) 束縛は herdr セッションでは効かないため、SessionBackend
    // 経由で pane へ番号キー + Enter を注入する（tmux / herdr 両対応）。
    engineDiag(`pane_choice_send id=${message.id} session=${message.session} key=${message.key}`);
    if (!/^\d{1,3}$/.test(message.key)) {
      writer.write({
        type: "pane_choice_send_result", v, id: message.id,
        ok: false, error: `不正な選択キーです: ${message.key}`,
      });
      return;
    }
    try {
      await sessionManager.sendKeys(message.session, [message.key], true);
      // ダイアログの再描画を待ってから確定する（連続注入の取りこぼし防止。
      // 番号キーだけで確定するダイアログでは、遅れて届く Enter は入力欄への
      // 空 submit となり no-op）。
      await sleep(120);
      await sessionManager.sendKeys(message.session, ["Enter"]);
      writer.write({ type: "pane_choice_send_result", v, id: message.id, ok: true, error: null });
    } catch (error) {
      engineDiag(`pane_choice_send 失敗 id=${message.id}: ${String(error)}`);
      writer.write({
        type: "pane_choice_send_result", v, id: message.id, ok: false, error: String(error),
      });
    }
  },

  pane_key_send: async (message, ctx) => {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // 制御キー（中断 C-c 等）の pane 注入。iOS の PTY(tmux attach) 束縛は herdr
    // セッションでは attach 失敗後の生シェルに吸われて claude へ届かないため、
    // pane_choice_send と同じく SessionBackend 経由で注入する（tmux / herdr 両対応）。
    engineDiag(`pane_key_send id=${message.id} session=${message.session} key=${message.key}`);
    if (!PANE_KEY_ALLOWLIST.has(message.key)) {
      writer.write({
        type: "pane_key_send_result", v, id: message.id,
        ok: false, error: `不正なキーです: ${message.key}`,
      });
      return;
    }
    try {
      await sessionManager.sendKeys(message.session, [message.key]);
      writer.write({ type: "pane_key_send_result", v, id: message.id, ok: true, error: null });
    } catch (error) {
      engineDiag(`pane_key_send 失敗 id=${message.id}: ${String(error)}`);
      writer.write({
        type: "pane_key_send_result", v, id: message.id, ok: false, error: String(error),
      });
      return;
    }
    // 中断キーの後は、claude が入力欄へ書き戻した「配送済みだが未処理の発話」を検出する
    // （prompt-cancelled）。結果を待たずに応答を返す（中断の ACK を遅らせない）。
    if (INTERRUPT_KEYS.has(message.key)) {
      void detectCancelledPrompt(ctx, message.session).catch((error: unknown) => {
        engineDiag(`prompt-cancelled 検出失敗 session=${message.session}: ${String(error)}`);
      });
    }
  },

  input_residue_action: async (message, ctx) => {
    // 入力欄に残った文字（input-residue）を送る / 消す。read loop を塞がないよう detached で処理する
    // （消去は入力欄が空になるまで C-u を数回打って確かめるため数百 ms かかる）。
    ctx.trackBackground(runInputResidueAction(message, ctx));
  },

  login_code_send: async (message, ctx) => {
    // 結果確定まで最大 ~10s 待つ（OAuth 交換の待ち）。engine の read loop は handler を直列 await
    // するため、ここで待つと chat_send / interrupt / pane_preview が全部止まる。起動だけして
    // 応答は非同期に write する（writer は直列化済み）。
    void runLoginCodeSend(message, ctx);
  },
};

/** 残留文字の送信後、入力欄から消えたかを読み直す間隔（ms）。 */
const INPUT_RESIDUE_SUBMIT_SETTLE_MS = 400;
/** 1 回の Enter の後に読み直す回数（`/clear` 等は再描画が遅いことがあるので 1 回で判断しない）。 */
const INPUT_RESIDUE_SUBMIT_POLLS = 3;
/** 入力欄の残り文字が見えなかったときに読み直すまでの待ち（ms）。 */
const INPUT_RESIDUE_REREAD_MS = 200;
/** 送信の Enter を打つ上限（2.1.277+ は不可視文字を含む本文の 1 回目の Enter を確認待ちで保留する）。 */
const INPUT_RESIDUE_SUBMIT_ATTEMPTS = 2;

/**
 * input_residue_action の実体。いまの入力欄の実テキスト（薄字の提案を除く）がアプリの見た文字と
 * 同じときだけ操作する。消えていれば `input_residue_gone`、変わっていれば `input_residue_changed` で
 * 何もしない（打ち足された入力・別経路で送られた入力を巻き込まない）。
 */
async function runInputResidueAction(
  message: Extract<ControlMessage, { type: "input_residue_action" }>,
  ctx: HandlerContext,
): Promise<void> {
  const { writer, state, sessionManager } = ctx;
  const v = state.negotiatedVersion;
  const reply = (ok: boolean, error: string | null): void => {
    writer.write({ type: "input_residue_action_result", v, id: message.id, ok, error });
  };
  // pump が知らせたのと同じ判定・同じ抜粋で読み直す（選択ダイアログの本文を入力欄の文字と取り違えない）。
  const readResidue = async (): Promise<string> =>
    inputResidueExcerpt(inputBoxResidueText(await sessionManager.captureVisibleAnsi(message.session)));
  try {
    let current = await readResidue();
    if (current === "") {
      // ボトムバーの位置に一時的な案内が出ていただけのフレームで「消えた」と答えない（アプリはバナーを
      // 下げ、pump は同じ文字を知らせ直さない）。少し待って 1 回だけ読み直す。
      await sleep(INPUT_RESIDUE_REREAD_MS);
      current = await readResidue();
    }
    if (current === "") {
      reply(false, "input_residue_gone");
      return;
    }
    if (current !== message.text) {
      reply(false, "input_residue_changed");
      return;
    }
    if (message.action === "submit") {
      // 送れたかは送信確定ループと同じ判定（`classifySubmitFrame`）で確かめる。「文字が変わった」を送信と
      // 読むと、2.1.277+ の不可視文字の確認待ち（不可視文字だけ除いた本文を残して 2 回目の Enter を待つ）を
      // 送信成立と取り違える（ok を返すとアプリはバナーを下げて処理中表示を張る）。
      // - submitted（バーが見えて入力欄が空）/ dialog（コマンドが選択画面を開いた・承認が出た）= 成立。
      //   dialog へは決して Enter を撃たない。
      // - pending（文字が残っている）: 元と違う文字なら確認待ちなのですぐ次の Enter、同じなら再描画を待つ。
      // - unknown（バーもダイアログも判別できない）: 待って読み直す。最後まで判別できなければ次の Enter は
      //   撃たずに不明と返す（送信確定ループと同じ規則。フッターを知らないダイアログ＝`Enter to confirm` の
      //   確認等も unknown になり、そこへの Enter は選択肢を勝手に確定する）。
      // `/` で始まる本文は 1 回だけ打つ: `/model` 等は選択画面を開くので、再描画が遅れて古い画面を読むと
      // 2 回目の Enter が開いた選択画面の選択肢を確定してしまう（不可視文字の確認待ちはコマンドには無い）。
      const attempts = message.text.startsWith("/") ? 1 : INPUT_RESIDUE_SUBMIT_ATTEMPTS;
      let verdict: SubmitFrameVerdict = "pending";
      for (let attempt = 0; attempt < attempts && verdict !== "submitted" && verdict !== "dialog"; attempt += 1) {
        await sessionManager.sendKeys(message.session, ["Enter"]);
        for (let poll = 0; poll < INPUT_RESIDUE_SUBMIT_POLLS; poll += 1) {
          await sleep(INPUT_RESIDUE_SUBMIT_SETTLE_MS);
          const ansi = await sessionManager.captureVisibleAnsi(message.session);
          verdict = classifySubmitFrame(ansi);
          if (verdict === "submitted" || verdict === "dialog") break;
          if (verdict === "pending" && inputResidueExcerpt(inputBoxResidueText(ansi)) !== message.text) break;
        }
        if (verdict === "unknown") break;
      }
      if (verdict === "unknown") {
        reply(false, "input_residue_unconfirmed");
        return;
      }
      if (verdict === "pending") {
        reply(false, "input_residue_not_submitted");
        return;
      }
    } else if (!(await sessionManager.clearInputBox(message.session))) {
      reply(false, "input_residue_clear_failed");
      return;
    }
    reply(true, null);
  } catch (error) {
    engineDiag(`input_residue_action 失敗 id=${message.id}: ${String(error)}`);
    reply(false, String(error));
  }
}

async function runLoginCodeSend(
  message: Extract<ControlMessage, { type: "login_code_send" }>,
  ctx: HandlerContext,
): Promise<void> {
  {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // `/login` の OAuth コードをコード入力待ちの画面へ渡す（login-code）。通常の chat 注入は
    // 入力欄検証・C-u クリアでコード欄を壊すため、backend の専用経路（literal + Enter）で送る。
    // コードは一度きりの認可コードなので diag ログには長さだけ載せる。
    engineDiag(
      `login_code_send id=${message.id} session=${message.session} len=${message.code.length}`,
    );
    if (!LOGIN_CODE_PATTERN.test(message.code)) {
      writer.write({
        type: "login_code_send_result", v, id: message.id,
        ok: false, error: "ログインコードの形式が不正です",
      });
      return;
    }
    try {
      await sessionManager.sendLoginCode(message.session, message.code);
      writer.write({ type: "login_code_send_result", v, id: message.id, ok: true, error: null });
    } catch (error) {
      // backend の生エラー（tmux の args 等）はコード本文を含みうるので、ログにも応答にも
      // 利用者向け文言だけを載せる。
      const text = loginCodeErrorMessage(error);
      engineDiag(`login_code_send 失敗 id=${message.id}: ${text}`);
      writer.write({ type: "login_code_send_result", v, id: message.id, ok: false, error: text });
    }
  }
}

/**
 * login_code_send が受理するコード形式。書式は Claude Code 側の仕様（手動コールバックの
 * `<code>#<state>`）で host が握っていないため文字種を狭めず、literal 送出で危険な
 * 空白・改行・制御文字（ESC 等）だけを落とす（印字可能 ASCII のみ、512 文字以内）。
 */
const LOGIN_CODE_PATTERN = /^[\x21-\x7e]{1,512}$/;

/** 中断として扱うキー（書き戻し検出の対象）。Up/Down/Enter はダイアログ操作なので対象外。 */
const INTERRUPT_KEYS = new Set(["C-c", "Escape"]);

/**
 * 中断キー注入後の書き戻し検出（prompt-cancelled）。
 *
 * Claude Code 2.1.263 は出力が始まる前に中断（C-c / Esc）されると、中断した発話本文を入力欄へ
 * 書き戻す（transcript には user 行が残り、マーカーは書かれない。queued 発話がある中断や出力後の
 * 中断は書き戻さない — sandbox 実測 2026-09-08）。利用者から見ると「送ったはずの文が処理されて
 * いない」状態なので、host が検出して iOS へ `chat_prompt_cancelled` を送り（バブルを「中断で
 * 未処理」+ 再送へ）、入力欄は C-u で空にする（次の注入で連結・重複しないように。Mac 側での
 * 再編集は iOS の再送で代替する）。hub には処理完了を伝える（この中断は Stop hook もマーカーも
 * 無く、hub の処理中状態が残る）。
 *
 * 判定は transcript 末尾の直近の発話本文との同文照合（sendTextSubmit の restored-prompt-discard と
 * 同じ規則）。別文（Mac 側の下書き等）は触らない。codex 会話は App Server 経路なので対象外。
 * 入力欄が見えるまで cancelDetectTimeoutMs までポーリングし、空のままなら何もしない。
 */
async function detectCancelledPrompt(ctx: HandlerContext, session: string): Promise<void> {
  const { writer, state, sessionManager, metadataStore, modeTiming } = ctx;
  const meta = metadataStore?.get(session) ?? null;
  if (meta === null || meta.agent === "codex") return;
  const transcriptPath = ctx.transcriptPathFor(meta);
  if (transcriptPath === null) return;
  const deadline = Date.now() + modeTiming.cancelDetectTimeoutMs;
  let pending = "";
  for (;;) {
    await sleep(modeTiming.cancelDetectPollMs);
    let realText: string | null = null;
    try {
      const capture = await sessionManager.captureVisibleAnsi(session);
      // 使用量制限の待機中（usage-limit-wait）の Esc は「自動再開の取り消し」であって中断ではない。
      // 入力欄に書き戻された発話を消したり prompt-cancelled を流したりしない。
      if (parseUsageLimitWait(capture) !== null || usageLimitAutoContinueCancelled(capture)) {
        engineDiag(`prompt-cancelled 判定スキップ（制限待ちの取り消し） session=${session}`);
        return;
      }
      realText = inputBoxRealText(capture);
    } catch {
      realText = null;
    }
    if (realText !== null && realText.replace(/\s+/g, "").length > 0) {
      pending = realText;
      break;
    }
    if (Date.now() >= deadline) return;
  }
  const recorded = findTrailingUserPromptText(transcriptPath);
  if (recorded === null || !inputBoxTextMatchesRecordedPrompt(pending, recorded)) {
    engineDiag(`prompt-cancelled 対象外の残存 session=${session}（記録本文と別文 or 記録なし）`);
    return;
  }
  const cleared = await sessionManager.clearInputBox(session);
  engineDiag(`prompt-cancelled session=${session} cleared=${cleared} chars=${recorded.length}`);
  // 入力欄を空にできなくても通知はする（次の注入時に restored-prompt-discard が破棄する）。
  writer.write({ type: "chat_prompt_cancelled", v: state.negotiatedVersion, session, text: recorded });
  ctx.hubLink.send({ type: "session_processing", session, state: "done", event: "prompt-cancelled", atMs: Date.now() });
}

/**
 * pane_key_send が受理する制御キー（tmux 互換キー名）。テキスト注入経路には使わせない。
 * Up/Down/Enter は Claude TUI の選択ダイアログ（/remote-control 等）の転写カードから
 * カーソル移動 + 確定を返すために使う（pane-menu 転写, 2026-07-28）。
 */
const PANE_KEY_ALLOWLIST = new Set(["C-c", "Escape", "Up", "Down", "Enter"]);

/**
 * pane から mode が判定できるまで、指定回数だけ短く待つ。
 *
 * capture の失敗は「まだ判定できない」として次の試行へ進む: 新規セッションでは
 * アプリの楽観オープン（mode_get）が launch のメタデータ記録より先に届き、
 * backend 未記録 → tmux フォールバック → pane 不在で capture が throw する
 * （mode-get-race, 2026-08-03）。メタが書かれれば次試行が正しい backend へ乗る。
 * 一度も capture できずに終わったときだけ、最後の失敗を投げて実障害として返す。
 */
async function waitForPermissionMode(
  sessionManager: SessionBackend,
  session: string,
  attempts: number,
  intervalMs: number,
): Promise<string | null> {
  let captured = false;
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const mode = parsePermissionMode(await sessionManager.capturePane(session));
      captured = true;
      if (mode !== null) return mode;
    } catch (error) {
      lastError = error;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  if (!captured && lastError !== null) throw lastError;
  return null;
}

/** mode_set の実体。dialog が閉じるのを待ち、BTab 後は実際に変化した mode だけを採用する。 */
async function setPermissionMode(
  sessionManager: SessionBackend,
  session: string,
  target: string,
  timing: ModeTiming,
): Promise<{ kind: "ok"; mode: string | null } | { kind: "unavailable" }> {
  let current: string | null = null;
  let captureFailureLogged = false;
  const initialDeadline = Date.now() + timing.setInitialTimeoutMs;
  while (Date.now() <= initialDeadline) {
    try {
      current = parsePermissionMode(await sessionManager.capturePane(session));
    } catch (error) {
      // 起動直後はメタ未記録で capture が失敗し得る（mode-get-race）。deadline まで待つ。
      // 実死亡セッションだと deadline まで失敗し続けて unavailable になるため、
      // 実因（pane 不在等）を診断ログへ一度だけ残す。
      if (!captureFailureLogged) {
        captureFailureLogged = true;
        engineDiag(`mode_set capture 失敗（リトライ継続） session=${session}: ${String(error)}`);
      }
      current = null;
    }
    if (current !== null) break;
    await sleep(timing.setInitialPollMs);
  }
  if (current === null) return { kind: "unavailable" };
  if (current === target) return { kind: "ok", mode: target };

  for (let i = 0; i < 4 && current !== target; i += 1) {
    const before: string = current;
    await sessionManager.sendKeys(session, ["BTab"]);
    const changeDeadline = Date.now() + timing.setChangeTimeoutMs;
    let changed = false;
    while (Date.now() <= changeDeadline) {
      const next = parsePermissionMode(await sessionManager.capturePane(session));
      // BTab 直後はステータス行が一瞬消える。判定不能を失敗や default とせず、
      // 明示的な次モードが描画されるまで待つ。
      if (next !== null && next !== before) {
        current = next;
        changed = true;
        break;
      }
      await sleep(timing.setChangePollMs);
    }
    if (!changed) break;
  }
  return { kind: "ok", mode: current };
}
