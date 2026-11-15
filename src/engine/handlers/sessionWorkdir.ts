// engine/handlers/sessionWorkdir.ts
// 開いている会話の作業フォルダを途中で変える（session-workdir-change）の枠。
//
// 要求 `session_workdir_change {session, cwd}` → 応答 `session_workdir_change_result {ok, cwd | error, message?}`。
// 枠がやること（差し込み口との取り決めは workdir/types.ts）:
//   1. 記録（metadata）の有無 → not_found。同じ会話の変更が進行中 → busy
//   2. 変更先の検証（workdir/validate.ts）→ invalid_cwd
//   3. 今と同じフォルダなら何もせず成功
//   4. 種類の振り分け（API 作業 / Codex / Claude 端末）。差し込み口の precheck（任意）があれば呼ぶ
//   5. hub で会話を押さえる（同じ会話の変更の進行中・処理中・設問や承認の待ち・送信待ち・打ち込み中・始まりかけの
//      Codex のターン → busy。押さえている間 hub は送信・ターンの開始を待たせる）
//   6. 差し込み口を呼び、成功したら記録の cwd を書き換え、hub へ知らせて購読者へ `pc:cwd` を配り、押さえを放す
// 会話の種類ごとの処理は workdir/claudeTerminal.ts・codex.ts・apiAgent.ts（後続の担当はそのファイルだけを触る）。

import { randomUUID } from "node:crypto";
import type { HubServerMessage } from "../../hub/hubProtocol.js";
import type { ControlMessage } from "../../protocol.js";
import type { SessionMeta } from "../../sessions/sessionMetadataStore.js";
import { changeApiAgentWorkdir } from "../../workdir/apiAgent.js";
import { changeClaudeTerminalWorkdir } from "../../workdir/claudeTerminal.js";
import { changeCodexWorkdir } from "../../workdir/codex.js";
import {
  WORKDIR_CHANGE_MESSAGES,
  workdirChangeFailure,
  type WorkdirChangeAdapter,
  type WorkdirChangeKind,
  type WorkdirChangeOutcome,
} from "../../workdir/types.js";
import { validateWorkdirTarget } from "../../workdir/validate.js";
import { canonicalPath } from "../../shared/paths.js";
import { engineDiag, type HandlerContext, type HandlerRegistry } from "../context.js";

type ChangeMessage = Extract<ControlMessage, { type: "session_workdir_change" }>;
type ChangeResult = Extract<ControlMessage, { type: "session_workdir_change_result" }>;
type BeginResult = Extract<HubServerMessage, { type: "workdir_change_begin_result" }>;

/** 種類ごとの差し込み口（テストで差し替える）。 */
export type WorkdirChangeAdapters = Record<WorkdirChangeKind, WorkdirChangeAdapter>;

export const DEFAULT_WORKDIR_CHANGE_ADAPTERS: WorkdirChangeAdapters = {
  claude_terminal: changeClaudeTerminalWorkdir,
  codex: changeCodexWorkdir,
  api_agent: changeApiAgentWorkdir,
};

/** 記録から振り分けの種類を決める。 */
export function workdirChangeKind(meta: SessionMeta): WorkdirChangeKind {
  if (meta.executionRoute === "api") return "api_agent";
  if (meta.agent === "codex") return "codex";
  return "claude_terminal";
}

/** 同じ会話の変更を重ねない（engine プロセス内。engine をまたぐ排他は hub の押さえ）。 */
const inFlight = new Set<string>();

/**
 * hub で会話を押さえる（同じ会話の変更の進行中・ターンの実行中・設問や承認の待ち・送信待ち・打ち込み中・始まりかけの
 * Codex のターンなら断られる）。押さえている間、hub は送信・今すぐ送信・Codex のターンの開始を待たせる。
 * 押さえたら token、断られたら失敗の結果。hub に聞けないときは安全側（処理中かもしれない）に倒す。
 */
async function beginWorkdirChange(ctx: HandlerContext, session: string): Promise<{ token: string } | WorkdirChangeOutcome> {
  if (ctx.processingSessions.has(session)) return workdirChangeFailure("busy", WORKDIR_CHANGE_MESSAGES.busy);
  // token は engine が作る。依頼が時間切れ・失敗しても、この token で end を送る（hub が依頼を後から処理して押さえを
  // 与えても、end が先に届いていれば与えない。届いた後の begin でも hub は放す）。
  const token = randomUUID();
  let begun: BeginResult;
  try {
    const id = randomUUID();
    begun = await ctx.hubRpc<BeginResult>({ type: "workdir_change_begin", id, session, token }, id, 3_000);
  } catch {
    endWorkdirChange(ctx, session, token);
    return workdirChangeFailure("busy", WORKDIR_CHANGE_MESSAGES.busy);
  }
  if (begun.status === "granted") return { token };
  return workdirChangeFailure("busy", begun.status === "in_flight" ? WORKDIR_CHANGE_MESSAGES.inFlight : WORKDIR_CHANGE_MESSAGES.busy);
}

function endWorkdirChange(ctx: HandlerContext, session: string, token: string): void {
  try {
    ctx.hubLink.send({ type: "workdir_change_end", session, token });
  } catch (error) {
    // 放せなくても hub は期限か切断で放す。
    engineDiag(`workdir 押さえの解放失敗 session=${session}: ${String(error)}`);
  }
}

/** 成功の後: 記録の cwd を書き換え、hub へ知らせて購読者へ `pc:cwd` を配る（hub が居なくても記録は残す）。 */
async function commitWorkdir(ctx: HandlerContext, session: string, cwd: string): Promise<void> {
  const store = ctx.metadataStore;
  const latest = store?.get(session) ?? null;
  if (store !== null && latest !== null && latest.cwd !== cwd) {
    try {
      store.put({ ...latest, cwd });
    } catch (error) {
      engineDiag(`workdir 記録の更新失敗 session=${session}: ${String(error)}`);
    }
  }
  try {
    const id = randomUUID();
    await ctx.hubRpc({ type: "session_cwd_set", id, session, cwd }, id, 3_000);
  } catch (error) {
    // 購読者への通知は次の購読（履歴の後の `pc:cwd`）で追いつく。
    engineDiag(`workdir hub への通知失敗 session=${session}: ${String(error)}`);
  }
}

export async function changeSessionWorkdir(
  message: ChangeMessage,
  ctx: HandlerContext,
  adapters: WorkdirChangeAdapters = DEFAULT_WORKDIR_CHANGE_ADAPTERS,
): Promise<ChangeResult> {
  const v = ctx.state.negotiatedVersion;
  const result = (outcome: WorkdirChangeOutcome): ChangeResult => outcome.ok
    ? { type: "session_workdir_change_result", v, id: message.id, ok: true, cwd: outcome.cwd }
    : {
      type: "session_workdir_change_result", v, id: message.id, ok: false, error: outcome.error,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    };

  const meta = ctx.metadataStore?.get(message.session) ?? null;
  if (meta === null) return result(workdirChangeFailure("not_found", WORKDIR_CHANGE_MESSAGES.notFound));
  if (inFlight.has(message.session)) return result(workdirChangeFailure("busy", WORKDIR_CHANGE_MESSAGES.inFlight));
  inFlight.add(message.session);
  try {
    const validated = validateWorkdirTarget(message.cwd);
    if (!validated.ok) return result(workdirChangeFailure("invalid_cwd", validated.message));
    if (canonicalPath(meta.cwd) === validated.cwd) return result({ ok: true, cwd: meta.cwd });
    const kind = workdirChangeKind(meta);
    const precheck = adapters[kind].precheck?.(meta) ?? null;
    if (precheck !== null) return result(precheck);
    const begun = await beginWorkdirChange(ctx, message.session);
    if (!("token" in begun)) return result(begun);
    let outcome: WorkdirChangeOutcome;
    try {
      // 押さえた後の最新の記録で動かす（押さえる前に別の変更が確定していることがある）。
      const current = ctx.metadataStore?.get(message.session) ?? meta;
      if (canonicalPath(current.cwd) === validated.cwd) {
        outcome = { ok: true, cwd: current.cwd };
      } else {
        try {
          outcome = await adapters[kind]({ session: message.session, meta: current, cwd: validated.cwd, requestedCwd: message.cwd, ctx });
        } catch (error) {
          engineDiag(`workdir 変更失敗 session=${message.session} kind=${kind}: ${String(error)}`);
          outcome = workdirChangeFailure("failed", WORKDIR_CHANGE_MESSAGES.failed);
        }
        if (outcome.ok) await commitWorkdir(ctx, message.session, outcome.cwd);
      }
    } finally {
      // 記録と通知の後に放す（放した直後に流れる送信が、新しいフォルダの会話へ入るように）。
      endWorkdirChange(ctx, message.session, begun.token);
    }
    engineDiag(`workdir 変更 session=${message.session} kind=${kind} ok=${outcome.ok}${outcome.ok ? "" : ` error=${outcome.error}`}`);
    return result(outcome);
  } finally {
    inFlight.delete(message.session);
  }
}

export const sessionWorkdirHandlers: HandlerRegistry = {
  // 端末への送信と移動の確認（数秒）を含むので read loop を塞がない。
  session_workdir_change: (message, ctx) => {
    ctx.trackBackground((async () => {
      let response: ChangeResult;
      try {
        response = await changeSessionWorkdir(message, ctx);
      } catch (error) {
        engineDiag(`workdir 変更失敗: ${String(error)}`);
        response = { type: "session_workdir_change_result", v: ctx.state.negotiatedVersion, id: message.id, ok: false,
          error: "failed", message: WORKDIR_CHANGE_MESSAGES.failed };
      }
      ctx.writer.write(response);
    })());
  },
};
