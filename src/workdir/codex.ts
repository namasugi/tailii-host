// workdir/codex.ts
// Codex の会話の作業フォルダの変更（session-workdir-change）の差し込み口。
//
// 呼ばれる条件: 会話の記録が `agent === "codex"`（`executionRoute === "api"` ではない）で、枠の検証（実在する
// フォルダの実体パス・今と違う・hub の処理中でも設問待ちでもない・同じ会話の変更が進行中でない）を通ったとき。
// 枠は成功（`{ ok: true, cwd }`）の後に記録の cwd を書き換え、hub へ知らせて購読者へ `pc:cwd` を配る。ここでは
// 記録の書き換えと `pc:cwd` の配信をしない（types.ts の取り決め）。
//
// 移し方: hub 所有の App Server 接続（turn・承認と同じ購読）で `thread/settings/update {threadId, cwd}` を送り、
// その thread の `thread/settings/updated` が新しい cwd で届いたら確定（hub の codex_cwd_submit →
// CodexNativeTurnController.setCwd → CodexAppServerThread.setCwd）。0.167.2 の実測（2026-11-15）:
//   - 次のターンから新しいフォルダで動く（シェルの pwd・書き込み先・AGENTS.md が追従）。変更は rollout の
//     `thread_settings_applied` に残り、接続を閉じても・App Server を起動し直しても resume で引き継がれる
//   - 会話が読み込まれていなければ hub が resume で開いてから送る（resume には cwd を付けない: 付けると、購読者の
//     いない thread では保存済みの値を上書きし、購読者がいる thread では黙って無視される）
//   - ターンの実行中でも受け付けるが、実行中のターンは前のフォルダのまま動く（枠と hub の両方で busy として断る）
//   - 端末の Codex の画面（`codex resume --remote`）は状況行・`/pwd`・`!` のコマンドが新しいフォルダへ追従する。
//     `@` のファイル候補だけは画面のプロセスを起動したフォルダのまま（今回は直さない）
// 版が古く `cwd` を受け付けない App Server は、要求の拒否か「通知が来ず thread/read も変わらない」で unsupported。

import { randomUUID } from "node:crypto";
import type { HubServerMessage } from "../hub/hubProtocol.js";
import {
  WORKDIR_CHANGE_MESSAGES,
  workdirChangeFailure,
  type WorkdirChangeAdapter,
  type WorkdirChangeOutcome,
  type WorkdirChangeRequest,
} from "./types.js";
import type { SessionMeta } from "../sessions/sessionMetadataStore.js";

type CodexCwdResult = Extract<HubServerMessage, { type: "codex_cwd_result" }>;

/** 古い記録（thread id を持たない Codex の会話）。 */
const NO_THREAD_MESSAGE = "この会話の記録が古いため変更できません。開き直してからお試しください。";
const UNSUPPORTED_CODEX_MESSAGE = "この Codex では作業フォルダを変更できません。Codex を更新するとできるようになります。";
/** hub 側の確かめ（App Server の通知待ち 8 秒）と、thread を開く（resume・履歴の読み取り）時間を足した上限。 */
const MIN_HUB_TIMEOUT_MS = 30_000;

export const changeCodexWorkdir: WorkdirChangeAdapter = Object.assign(
  async (request: WorkdirChangeRequest): Promise<WorkdirChangeOutcome> => {
    const { session, meta, cwd, ctx } = request;
    const threadId = meta.providerSessionId;
    if (threadId === undefined || threadId.length === 0) return workdirChangeFailure("failed", NO_THREAD_MESSAGE);
    const id = randomUUID();
    let result: CodexCwdResult;
    try {
      result = await ctx.hubRpc<CodexCwdResult>(
        { type: "codex_cwd_submit", id, session, threadId, cwd: meta.cwd, targetCwd: cwd },
        id, Math.max(ctx.codexHubRpcTimeoutMs, MIN_HUB_TIMEOUT_MS),
      );
    } catch {
      // 時間切れでも hub 側で適用済みのことがある。そのときは hub が通知を拾って記録と `pc:cwd` を合わせる。
      return workdirChangeFailure("failed", "作業フォルダの変更を確かめられませんでした。少し待ってから会話を開き直してください。");
    }
    switch (result.status) {
      case "ok":
        return { ok: true, cwd: result.cwd ?? cwd };
      case "busy":
        return workdirChangeFailure("busy", WORKDIR_CHANGE_MESSAGES.busy);
      case "unsupported":
        return workdirChangeFailure("unsupported", UNSUPPORTED_CODEX_MESSAGE);
      case "failed":
        return workdirChangeFailure("failed", WORKDIR_CHANGE_MESSAGES.failed);
    }
  },
  {
    // thread id の無い古い記録は、処理中かどうかに関係なく変えられない（busy より先に返す）。
    precheck: (meta: SessionMeta): WorkdirChangeOutcome | null =>
      meta.providerSessionId === undefined || meta.providerSessionId.length === 0
        ? workdirChangeFailure("failed", NO_THREAD_MESSAGE)
        : null,
  },
);
