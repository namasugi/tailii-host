// engine/handlers/mode.ts
// pane TUI との相互作用: permission mode の読み取り/切替（BTab 巡回）と、
// Codex TUI 番号付きダイアログへの選択返送（pane_choice_send）。

import { parsePermissionMode } from "../../shared/permissionMode.js";
import { sleep } from "../../shared/sleep.js";
import type { SessionBackend } from "../../backend/sessionBackend.js";
import { inputBoxRealText, inputBoxTextMatchesRecordedPrompt, loginCodeErrorMessage } from "../../backend/tmux.js";
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

  login_code_send: async (message, ctx) => {
    // 結果確定まで最大 ~10s 待つ（OAuth 交換の待ち）。engine の read loop は handler を直列 await
    // するため、ここで待つと chat_send / interrupt / pane_preview が全部止まる。起動だけして
    // 応答は非同期に write する（writer は直列化済み）。
    void runLoginCodeSend(message, ctx);
  },
};

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
      realText = inputBoxRealText(await sessionManager.captureVisibleAnsi(session));
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
