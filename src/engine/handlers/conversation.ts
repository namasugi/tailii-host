// engine/handlers/conversation.ts
// 会話まわり: 本文送信（chat_send, Claude）・設問回答・サブエージェント履歴・
// 会話一覧（claude+codex マージ）・本文検索・画像オンデマンド配信。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HubServerMessage } from "../../hub/hubProtocol.js";
import { PROTOCOL_V2, type ControlMessage } from "../../protocol.js";
import {
  annotateLiveSessions,
  buildLiveSessionIndex,
} from "../../sessions/liveSessionJoin.js";
import { searchClaudeSessions } from "../../sessions/sessionSearch.js";
import { engineDiag, subscribeConversation, writeError, type HandlerRegistry } from "../context.js";

/** chat_send 経路の常時診断ログ（pending 固まり事案の事後解析用）。失敗しても本処理を妨げない。 */
function chatSendDiag(message: string): void {
  try {
    fs.appendFileSync(
      path.join(os.homedir(), ".tailii", "chat-send.log"),
      `[${new Date().toISOString()} pid=${process.pid}] ${message}\n`,
    );
  } catch {
    // 診断ログは best-effort。
  }
}

export const conversationHandlers: HandlerRegistry = {
  session_preview_watch: (message, ctx) => {
    // 一覧 Mission Control: 一覧表示中だけ有効化される。応答不要（冪等・再入場で再送）。
    ctx.listPreviewWatch.enabled = message.enabled;
    engineDiag(`session_preview_watch enabled=${message.enabled}`);
    ctx.hubLink.send({ type: "session_preview_watch", enabled: message.enabled });
  },

  chat_send: (message, ctx) => {
    const { writer, state, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    const meta = metadataStore?.get(message.session) ?? null;
    if (meta?.agent === "codex") {
      writeError(writer, v, message.id, "chat_send_unsupported", "Codex セッションは codex_turn_start を使用してください。");
      return;
    }
    // chat_send はチャット画面を前面表示した状態でしか届かない。engine 再生成や Hub 再起動の
    // 狭間で前面購読（preview=true）が失われたままだと、本文は background 購読の押し込みで
    // 進むのにライブビュー（pane_preview）だけ消灯し続ける。ここで前面購読を自己修復する。
    if (ctx.activeChatSession.name !== message.session) {
      chatSendDiag(
        `heal subscribe session=${message.session} previousActive=${ctx.activeChatSession.name ?? "nil"}`,
      );
      subscribeConversation(ctx, message.session);
    }
    // Hub は設問表示中、durable queue を保持したまま pane 注入可能になるまで応答を
    // 保留する。read loop 自体がこの RPC を await すると、後続 question_answer を読めず
    // 循環待ちになるため相関処理だけを非同期化する。ACK は注入完了の意味を維持する。
    // timeout は無限にしない: hub 側で応答が失われた場合にバブルが永遠に pending の
    // まま固まる（実障害）。アプリは durable Outbox + 同一 clientMessageId 再送で
    // 冪等に回復するため、長めの上限で失敗を返す方が安全。
    void (async () => {
      chatSendDiag(
        `recv id=${message.id} session=${message.session} cmid=${message.clientMessageId}`,
      );
      try {
        const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "chat_send_result" }>>(
          { type: "chat_send", id: message.id, session: message.session,
            clientMessageId: message.clientMessageId, text: message.text,
            ...(message.explicitRetry === true ? { explicitRetry: true } : {}) }, message.id, 90_000,
        );
        chatSendDiag(`result id=${result.id} status=${result.status}`);
        writer.write({ type: "chat_send_result", v, id: result.id, status: result.status,
          ...(result.error !== undefined ? { error: result.error } : {}) });
      } catch (error) {
        chatSendDiag(`failed id=${message.id} error=${String(error).slice(0, 120)}`);
        writeError(writer, v, message.id, "chat_send_failed", String(error));
      }
    })();
  },

  question_answer: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const requestId = randomUUID();
      const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "question_answer_result" }>>(
        { type: "question_answer_submit", id: requestId, session: message.session,
          questionId: message.id, answers: message.answers }, requestId, 2_000,
      );
      if (result.status === "accepted") {
        writer.write({ type: "remote_pending_cleared", v, id: message.id,
          session: message.session, kind: "question" });
      } else if (result.status === "already_resolved") {
        // 送信失敗（要リトライ）と区別できるコードで返す。iOS はこのコードでは
        // 設問シートを復元しない（他所で回答済みの正常系, question-answer-retry）。
        writeError(writer, v, message.id, "question_already_answered", "この設問は既に回答済みです。");
      } else {
        writeError(writer, v, message.id, "question_answer_failed",
          "設問が見つかりませんでした。時間をおいて再試行してください。");
      }
    } catch (error) {
      writeError(writer, v, message.id, "question_answer_failed", String(error));
    }
  },

  subagent_transcript_request: async (message, ctx) => {
    const { writer } = ctx;
    const session = ctx.activeChatSession.name;
    let result: Extract<ControlMessage, { type: "subagent_transcript_response" }> = {
      type: "subagent_transcript_response",
      v: PROTOCOL_V2,
      id: message.id,
      nodeId: message.nodeId,
      entries: [],
      omitted: 0,
    };
    if (session !== null) {
      try {
        const response = await ctx.hubRpc<Extract<HubServerMessage, {
          type: "conversation_subagent_transcript_response";
        }>>(
          {
            type: "conversation_subagent_transcript_request",
            id: message.id,
            session,
            nodeId: message.nodeId,
          },
          message.id,
          1_500,
        );
        result = response.payload;
      } catch {
        // Hub 不達・対象 tail 不在は空応答にして、iOS の 10 秒待ちを発生させない。
      }
    }
    try {
      writer.write(result);
    } catch (error) {
      process.stderr.write(`[tailii-host engine] subagent_transcript_response 書込失敗: ${String(error)}\n`);
    }
  },

  claude_session_list_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // 会話一覧: claude(jsonl) + codex(rollout) をマージし updatedAt 降順で返す（agent-tag）。
    // store 未注入時はその分を空一覧扱い（後方互換 — 会話機能なし）。
    engineDiag(`claude_session_list_request id=${message.id}`);
    const claudeSessions = ctx.claudeSessionStore?.list() ?? [];
    const codexSessions = ctx.codexSessionStore === null
      ? []
      : ctx.codexAppServer === null
        ? ctx.codexSessionStore.list()
        : await ctx.codexSessionStore.listWithAppServer(ctx.codexAppServer);
    const sessions = [...claudeSessions, ...codexSessions].sort((lhs, rhs) => {
      const l = lhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      const r = rhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
      if (l !== r) return r - l;
      return lhs.sessionId < rhs.sessionId ? -1 : lhs.sessionId > rhs.sessionId ? 1 : 0;
    });
    // live-pill: 生存セッションを 1 回だけ列挙し、会話 id + agent で各行へ join する。
    // 失敗時は annotate なしで返し、`liveSessionsResolved` も載せない（嘘の「全停止」を出さない）。
    let annotated = sessions;
    let liveResolved = false;
    try {
      const live = await ctx.sessionManager.list();
      const index = buildLiveSessionIndex(
        live, (name) => ctx.metadataStore?.get(name)?.createdAt ?? null,
      );
      annotated = annotateLiveSessions(sessions, index);
      liveResolved = true;
      engineDiag(`claude_session_list live join count=${index.size}`);
    } catch (error) {
      engineDiag(`claude_session_list live join 失敗: ${String(error)}`);
    }
    engineDiag(
      `claude_session_list_response id=${message.id} count=${sessions.length} liveResolved=${liveResolved}`,
    );
    try {
      writer.write({
        type: "claude_session_list_response", v, id: message.id, claudeSessions: annotated,
        ...(liveResolved ? { liveSessionsResolved: true } : {}),
      });
    } catch (error) {
      process.stderr.write(
        `[tailii-host engine] claude_session_list_response 書込失敗: ${String(error)}\n`,
      );
    }
  },

  session_search_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // Claude 会話本文検索。長時間 read loop を塞がないよう検索関数側で件数/時間/読取量を制限する。
    engineDiag(`session_search_request id=${message.id} query=${message.query}`);
    const response =
      ctx.claudeSessionStore !== null
        ? searchClaudeSessions(ctx.claudeSessionStore, message.query, { limit: message.limit })
        : { results: [], stats: { scannedFiles: 0, truncated: false } };
    engineDiag(
      `session_search_response id=${message.id} count=${response.results.length} scanned=${response.stats.scannedFiles} truncated=${response.stats.truncated}`,
    );
    try {
      writer.write({ type: "session_search_response", v, id: message.id, results: response.results });
    } catch (error) {
      process.stderr.write(
        `[tailii-host engine] session_search_response 書込失敗: ${String(error)}\n`,
      );
    }
  },

  image_fetch_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // 原本オンデマンド分割配信。index 逆引きし、分割 image_fetch_response を順に書く。
    if (ctx.imageService === null) {
      // 未注入時は画像を扱わない（後方互換）。要求元が沈黙で待たないよう error を返す。
      writeError(writer, v, message.id, "image_not_found", "画像機能は無効です。");
      return;
    }
    for (const response of ctx.imageService.fetch(message.id)) {
      try {
        writer.write(response);
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] image_fetch_response 書込失敗: ${String(error)}\n`,
        );
        break;
      }
    }
  },
};
