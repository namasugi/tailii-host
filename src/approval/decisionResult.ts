// decisionResult.ts
// tailii (TS host) — 承認の決定の反映結果を、承認チャネルへ 1 行返す（push v1.1 §6 の approval_decision_result）
//
// 通知のボタンから承認・拒否したアプリは、決定を送った後にこの行を最大 3 秒待ち、確定したかを知る（来なければ
// 「送れた」ことをもって成功として扱う）。返信は最善努力で、書き込みに失敗しても決定の反映は止めない。
//
// 返すのは `applied`（自分が待っていた id の決定で確定した）だけ。承認チャネルの中継（serve, broker.ts）は
// iPhone からの行を接続中の全 hook へ配るので、同じ会話で別の承認を待っている hook にも他人の決定が届く。
// そこで `stale` を返すと、アプリは持ち主の `applied` より先に他人の `stale` を受け取りうる（確定したのに失敗と
// 表示する）。持ち主が既に居ない「確定した後に届いた決定」には誰も応えず、アプリは 3 秒の待ちの後に従来どおり扱う。

import type * as net from "node:net";
import { encodeControlMessage, PROTOCOL_V1 } from "../protocol.js";

/** 決定を受け取った接続へ反映結果を 1 行書く（失敗は握り潰す）。 */
export function replyDecisionApplied(socket: Pick<net.Socket, "write" | "on">, id: string): void {
  // 決定を待つ側は確定の後で error の受け手を外す。相手が先に閉じていて書き込みが後から失敗しても、
  // 受け手の無い error で hook ごと落ちないようにする。
  socket.on("error", () => {});
  try {
    socket.write(encodeControlMessage({ type: "approval_decision_result", v: PROTOCOL_V1, id, status: "applied" }) + "\n");
  } catch {
    // 返信は最善努力。決定の反映は呼び手が続ける。
  }
}

/**
 * 接続を閉じる。返信がまだ OS へ渡り切っていなければ（通常は unix socket への小さな書き込みは即座に渡る）、
 * end で送り切ってから短い猶予の後に破棄する。決定の反映（hook の出力・終了）はこれを待たない。
 */
export function closeAfterReply(socket: net.Socket): void {
  socket.on("error", () => {});
  if (socket.destroyed || socket.writableLength === 0) {
    socket.destroy();
    return;
  }
  socket.end();
  const timer = setTimeout(() => socket.destroy(), 200);
  timer.unref?.();
}
