// cwdMarker.ts
// tailii (TS host) — 会話の作業フォルダの通知マーカー `pc:cwd`（session-workdir-change）。
//
// `pc:model` と同じ形の chat_output（role=system, eof=true, text = 作業フォルダの絶対パス）。hub が会話の購読者へ配る:
//   - 作業フォルダが変わったとき（session_workdir_change・利用者の `/cd`・Claude の EnterWorktree / ExitWorktree・
//     ほかのクライアントでの変更）
//   - 購読の開始時、履歴の読み込みが終わった後に今の値を 1 回（アプリが古い値を持っていても揃うように）
// 古いアプリは知らない `pc:*` を通常の system の行として表示する（最初の取り決めの前提は誤りだった）。そのため engine は、
// channel_hello で `workdirChange`（今は 1）を名乗ったアプリの接続にだけ送る（engine.ts の conversation_event の転送）。

import { PROTOCOL_V1, type ControlMessage } from "../protocol.js";

export const CWD_STREAM_ID = "pc:cwd";

export function cwdMarker(cwd: string): Extract<ControlMessage, { type: "chat_output" }> {
  return { type: "chat_output", v: PROTOCOL_V1, streamId: CWD_STREAM_ID, role: "system", text: cwd, eof: true };
}
