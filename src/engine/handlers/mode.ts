// engine/handlers/mode.ts
// pane TUI との相互作用: permission mode の読み取り/切替（BTab 巡回）と、
// Codex TUI 番号付きダイアログへの選択返送（pane_choice_send）。

import { parsePermissionMode } from "../../shared/permissionMode.js";
import { sleep } from "../../shared/sleep.js";
import type { SessionBackend } from "../../backend/sessionBackend.js";
import { engineDiag, writeError, type HandlerRegistry, type ModeTiming } from "../context.js";

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

};

/** pane から mode が判定できるまで、指定回数だけ短く待つ。 */
async function waitForPermissionMode(
  sessionManager: SessionBackend,
  session: string,
  attempts: number,
  intervalMs: number,
): Promise<string | null> {
  for (let i = 0; i < attempts; i += 1) {
    const mode = parsePermissionMode(await sessionManager.capturePane(session));
    if (mode !== null) return mode;
    if (i < attempts - 1) await sleep(intervalMs);
  }
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
  const initialDeadline = Date.now() + timing.setInitialTimeoutMs;
  while (Date.now() <= initialDeadline) {
    current = parsePermissionMode(await sessionManager.capturePane(session));
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
