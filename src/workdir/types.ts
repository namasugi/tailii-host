// workdir/types.ts
// 開いている会話の作業フォルダを途中で変える（session-workdir-change）の共通の型。
//
// 枠（engine/handlers/sessionWorkdir.ts）と会話の種類ごとの差し込み口（このフォルダの claudeTerminal.ts /
// codex.ts / apiAgent.ts）の取り決め:
//
//   枠がやること（差し込み口はやらない）:
//     1. 要求の形・会話の記録（metadata）の有無（not_found）・同じ会話への同時の変更（busy）
//     2. 作業フォルダの検証（validate.ts: 絶対パス・存在・フォルダ・開ける。実体パスへ解決）→ invalid_cwd
//     3. 今と同じフォルダなら何もせず成功
//     4. 種類の振り分け（記録の executionRoute === "api" → apiAgent / agent === "codex" → codex / それ以外 → Claude 端末）
//        差し込み口が `precheck` を持てば、ここで呼ぶ（不可ならその結果を返す。busy より先）
//     5. hub で会話を押さえる（workdir_change_begin）。同じ会話の変更の進行中（engine をまたいでも）・ターンの実行中・
//        設問や承認の待ち・送信待ち・打ち込み中・始まりかけの Codex のターンなら busy。押さえている間、hub は送信の注入・
//        今すぐ送信・Codex のターンの開始を待たせる（差し込み口は入れ違いを気にせず端末や thread を操作できる）
//     6. 差し込み口を呼び、成功したら記録の cwd を書き換え、hub へ知らせて購読者へ `pc:cwd` を配り、押さえを放す
//
//   差し込み口がやること:
//     - その種類で実際に作業フォルダを移す（エージェントへの指示・会話ログの移動・起動し直し等）
//     - 種類に固有の busy 判定（枠の判定に足りない分）
//     - 実際に有効になった絶対パスを `{ ok: true, cwd }` で返す（枠はこの値で記録と `pc:cwd` を揃える）
//     - 記録の書き換えと `pc:cwd` の配信はしない（枠が成功の後に 1 回だけやる）

import type { HandlerContext } from "../engine/context.js";
import type { SessionWorkdirChangeError } from "../protocol.js";
import type { SessionMeta } from "../sessions/sessionMetadataStore.js";

/** 差し込み口へ渡す要求。 */
export interface WorkdirChangeRequest {
  /** Tailii の会話名（`session_workdir_change.session`）。 */
  session: string;
  /** 変更前の会話の記録。 */
  meta: SessionMeta;
  /** 移す先（枠が検証済み: 実在するフォルダの実体パス）。 */
  cwd: string;
  /** アプリが送ってきたままの値（表示や記録に使わない。診断用）。 */
  requestedCwd: string;
  ctx: HandlerContext;
}

export type WorkdirChangeOutcome =
  | { ok: true; cwd: string }
  | { ok: false; error: SessionWorkdirChangeError; message?: string };

/** 会話の種類ごとの差し込み口。 */
export interface WorkdirChangeAdapter {
  (request: WorkdirChangeRequest): Promise<WorkdirChangeOutcome>;
  /**
   * 任意。枠が busy 判定より前に呼ぶ（記録だけで判断できる不可を先に返す。例: この種類・版では変えられない →
   * unsupported）。続けてよければ null。
   */
  precheck?: (meta: SessionMeta) => WorkdirChangeOutcome | null;
}

/** 振り分けの種類。 */
export type WorkdirChangeKind = "claude_terminal" | "codex" | "api_agent";

/** 利用者へ返す決まり文句（`message`）。 */
export const WORKDIR_CHANGE_MESSAGES = {
  notFound: "会話が見つかりません。",
  busy: "処理が終わってから変更できます",
  inFlight: "作業フォルダを変更しています。終わってからもう一度お試しください。",
  unsupported: "この会話では作業フォルダを変更できません。",
  failed: "作業フォルダを変更できませんでした。",
} as const;

export function workdirChangeFailure(error: SessionWorkdirChangeError, message?: string): WorkdirChangeOutcome {
  return { ok: false, error, ...(message !== undefined ? { message } : {}) };
}
