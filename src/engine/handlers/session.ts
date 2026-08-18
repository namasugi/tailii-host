// engine/handlers/session.ts
// セッションライフサイクル: 一覧・reattach（resume 再起動含む）・kill（worktree 掃除含む）・
// 新規/再開起動（session_start）・離脱（session_idle_hint）。

import { randomUUID } from "node:crypto";
import type { ChatAgent } from "../../chat/chatTailController.js";
import {
  gitWorktreeIsClean,
  gitWorktreeRemove,
  gitWorktreeUnlock,
  isTailiiWorktreePath,
} from "../../services/gitService.js";
import { makeSessionLauncher, claudeInnerCommand } from "../../commands/launch.js";
import type { SessionInfo } from "../../protocol.js";
import {
  activateOrTouchSession,
  claimRuntime,
  emitPendingQuestion,
  engineDiag,
  subscribeConversation,
  waitForLiveSession,
  writeError,
  writeSessionListResponse,
  type HandlerRegistry,
  type WorktreeResponseFields,
} from "../context.js";

export const sessionHandlers: HandlerRegistry = {
  session_list_request: async (message, ctx) => {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // ページング応答。service 未注入時は従来の全件 list にフォールバックする（後方互換）。
    try {
      if (ctx.sessionListService !== null) {
        const page = await ctx.sessionListService.page(message.limit, message.cursor);
        writeSessionListResponse(writer, v, message.id, page.sessions, page.nextCursor);
      } else {
        const sessions = await sessionManager.list();
        writeSessionListResponse(writer, v, message.id, sessions, null);
      }
    } catch (error) {
      writeError(writer, v, message.id, "tmux_error", String(error));
    }
  },

  session_reattach: async (message, ctx) => {
    const { writer, state, sessionManager, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    // 再アクティブ化（heartbeat 更新 = アイドル計時リセット）→ 生存なら即 reattach /
    // メタあり tmux 不在は記録 cwd で resume 再起動 → attached / メタ無しは従来の not_found。
    try {
      const result = await sessionManager.reattach(message.name);
      if (result.kind === "attached") {
        writeSessionListResponse(writer, v, message.id, [result.info], null);
        subscribeConversation(ctx, message.name);
        await emitPendingQuestion(ctx, message.name);
      } else {
        const meta = metadataStore?.get(message.name) ?? null;
        if (ctx.resumeLauncher !== null && meta !== null) {
          // codex セッションは codex 用 resume launcher で再起動する。
          const reAgent = meta.agent ?? ctx.defaultAgent;
          const providerSessionId = meta.providerSessionId ?? meta.claudeSessionId ?? null;
          // claude で会話 id が記録済みなら通常 launcher の `--resume <id>` で同一会話を
          // 厳密に再開する（resumeLauncher の `--continue` は cwd の最新会話を拾うため、
          // 別会話を再開して tail 束縛と食い違い得る）。id 未記録の旧メタは従来経路。
          const strictClaudeResume =
            reAgent === "claude" && providerSessionId !== null && ctx.launcher !== null;
          const chosenResume =
            reAgent === "codex"
              ? (ctx.codexResumeLauncher ?? ctx.resumeLauncher)
              : strictClaudeResume
                ? ctx.launcher!
                : ctx.resumeLauncher;
          const claim = await claimRuntime(ctx, message.name);
          if (claim === "held") {
            const appeared = await waitForLiveSession(sessionManager, (info) => info.name === message.name);
            if (appeared !== null) {
              writeSessionListResponse(writer, v, message.id, [appeared], null);
              subscribeConversation(ctx, message.name);
              await emitPendingQuestion(ctx, message.name);
            } else {
              writeError(writer, v, message.id, "launch_failed", "他の接続による会話の起動を確認できませんでした。");
            }
            return;
          }
          let res;
          try {
            res = await chosenResume(
              meta.cwd, message.name, null,
              reAgent === "codex" || strictClaudeResume ? providerSessionId : null,
            );
          } finally {
            ctx.hubLink.send({ type: "runtime_claim_release", session: message.name });
          }
          if (res.exitCode === 0) {
            // launcher は worktree 削除済み resume で cwd を repo ルートへ振り替え得る
            // （deleted-worktree-resume）ため、応答は起動後の権威記録 cwd を返す。
            const launchedCwd = metadataStore?.get(message.name)?.cwd ?? meta.cwd;
            const info: SessionInfo = {
              name: message.name,
              cwd: launchedCwd,
              alive: true,
              ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
              ...(providerSessionId !== null ? { providerSessionId } : {}),
              ...(meta.claudeSessionId !== undefined
                ? { claudeSessionId: meta.claudeSessionId }
                : {}),
            };
            writeSessionListResponse(writer, v, message.id, [info], null);
            subscribeConversation(ctx, message.name);
            await emitPendingQuestion(ctx, message.name);
          } else {
            const m = res.errorText || `resume 失敗 (exit ${res.exitCode})`;
            writeError(writer, v, message.id, "launch_failed", m);
          }
        } else if (result.error.type === "error") {
          writeError(writer, v, message.id, result.error.code, result.error.message);
        } else {
          writeError(
            writer, v, message.id,
            "session_not_found", `セッション '${message.name}' は存在しません。`,
          );
        }
      }
    } catch (error) {
      writeError(writer, v, message.id, "tmux_error", String(error));
    }
  },

  session_kill: async (message, ctx) => {
    const { writer, state, sessionManager, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    try {
      // cwd の権威は tmux の現在位置ではなく永続 SessionMetadataStore。
      const killedCwd = metadataStore?.get(message.name)?.cwd ?? null;
      // 明示 kill はユーザー意思なので処理中保護より優先する（保護記録も掃除）。
      ctx.processingSessions.delete(message.name);
      ctx.backgroundChatSessions.delete(message.name);
      ctx.hubLink.send({ type: "conversation_unsubscribe", session: message.name });
      ctx.codexTurnController?.closeSession(message.name);
      // kill する会話を tail 中なら止める（生かしたままだと再オープンの open() が
      // 「同一会話 tail 中」でスキップし、履歴が再生されず空表示になる）。
      if (ctx.activeChatSession.name === message.name) {
        ctx.activeChatSession.name = null;
      }
      await sessionManager.kill(message.name);
      // kill 成功後だけ Hub の actor / durable queue / delivered receipt を廃棄する。
      // 同名セッションを後日作り直しても、旧会話の queued 入力を注入させない。
      ctx.hubLink.send({ type: "session_retire", session: message.name });
      let worktreeResponse: WorktreeResponseFields | null = null;
      if (killedCwd !== null && isTailiiWorktreePath(killedCwd)) {
        worktreeResponse = { worktreePath: killedCwd };
        try {
          if (await gitWorktreeIsClean(killedCwd)) {
            const removed = await gitWorktreeRemove(killedCwd, false);
            if (removed.ok) {
              worktreeResponse.worktreeRemoved = true;
            } else {
              engineDiag(`session_kill worktree 削除失敗 path=${killedCwd}: ${removed.error ?? "unknown"}`);
            }
          } else {
            engineDiag(`session_kill worktree dirty または clean 判定不能のため保持 path=${killedCwd}`);
            worktreeResponse.worktreeDirty = true;
            const unlocked = await gitWorktreeUnlock(killedCwd);
            if (!unlocked.ok) {
              engineDiag(`session_kill worktree unlock 失敗 path=${killedCwd}: ${unlocked.error ?? "unknown"}`);
            }
          }
        } catch (error) {
          // worktree の判定・掃除は fail-open。ユーザーが要求した tmux kill の成功を覆さない。
          engineDiag(`session_kill worktree 掃除失敗 path=${killedCwd}: ${String(error)}`);
        }
      }
      // kill 成功は list 応答（現況一覧）で返す（疎通確認）。
      let sessions: SessionInfo[] = [];
      try {
        sessions = await sessionManager.list();
      } catch {
        sessions = [];
      }
      writeSessionListResponse(writer, v, message.id, sessions, null, null, worktreeResponse);
    } catch (error) {
      writeError(writer, v, message.id, "tmux_error", String(error));
    }
  },

  session_idle_hint: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // アイドル起点を更新する（chat 離脱, 要件 4.2）。以後 reaper daemon が timeout 超過で kill する。
    // state は保持（bump）: 処理中（active）に離脱しても idle へ降格させない — state の権威は
    // hook / turn controller のライフサイクル通知であり、離脱はただの計時リセット。
    if (ctx.activeChatSession.name === message.name) {
      ctx.activeChatSession.name = null;
      if (ctx.processingSessions.has(message.name)) {
        ctx.backgroundChatSessions.add(message.name);
        ctx.hubLink.send({ type: "conversation_subscribe", session: message.name, preview: false });
      } else {
        ctx.hubLink.send({ type: "conversation_unsubscribe", session: message.name });
      }
      // 未回答の設問を残して離脱した → 一覧バッジへ引き継ぐ（question-hook-relay）。
      const pending = await ctx.requestHubState(message.name);
      if (pending !== null) {
        const first = pending.questions[0];
        writer.write({
          type: "remote_pending",
          v,
          id: pending.id,
          session: message.name,
          kind: "question",
          summary: first?.question || first?.header || "Question prompt",
        });
      }
    }
    // focus の有無にかかわらず、指定 session の離脱時刻を Hub に記録する。
    ctx.hubLink.send({ type: "conversation_unsubscribe", session: message.name });
  },

  session_title_set: async (message, ctx) => {
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    // 会話カスタムタイトルの端末表示追随（session-title）: herdr はタブラベルへ反映、
    // tmux は no-op（SessionBackend が backend 毎に吸収）。空 title は解除=セッション名へ戻す。
    engineDiag(`session_title_set id=${message.id} session=${message.session} title=${message.title.slice(0, 40)}`);
    try {
      await sessionManager.setDisplayTitle(message.session, message.title);
      writer.write({ type: "session_title_set_result", v, id: message.id, ok: true, error: null });
    } catch (error) {
      engineDiag(`session_title_set 失敗 id=${message.id}: ${String(error)}`);
      writer.write({
        type: "session_title_set_result", v, id: message.id, ok: false, error: String(error),
      });
    }
  },

  session_start: async (message, ctx) => {
    const { writer, state, sessionManager, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    // session_start → launch() 結線。agentType でセッション毎に claude/codex を選ぶ
    //（未指定は host 既定 defaultAgent）。codex は agentType=codex 時の専用 launcher を使う。
    const sessionAgent: ChatAgent = message.agentType ?? ctx.defaultAgent;
    // claude 新規起動でモデル/permission mode/effort 指定があれば、その flags（--model /
    // --permission-mode / --effort）を持つ launcher をその場で組む（起動前選択の反映）。
    // resume は元セッションの設定を継ぐため既定 launcher を使う。
    const perSessionClaudeLauncher =
      sessionAgent === "claude" &&
      message.resumeSessionId === undefined &&
      (message.model !== undefined || message.permissionMode !== undefined ||
        message.effort !== undefined)
        ? makeSessionLauncher({
            ...(ctx.metadataStore !== null && { store: ctx.metadataStore }),
            agent: "claude",
            backend: ctx.backendKind,
            innerCommand: claudeInnerCommand({
              model: message.model ?? null,
              permissionMode: message.permissionMode ?? null,
              effort: message.effort ?? null,
            }),
          })
        : null;
    const chosenLauncher =
      sessionAgent === "codex"
        ? (ctx.codexLauncher ?? ctx.launcher)
        : (perSessionClaudeLauncher ?? ctx.launcher);
    const resumeSessionId = message.resumeSessionId ?? null;
    const shouldSubscribe = message.deferSubscribe !== true;
    if (resumeSessionId !== null && metadataStore !== null) {
      const aliases = await sessionManager.list();
      const liveAliases = aliases.filter((info) => {
        if (!info.alive || info.name === message.name) return false;
        const aliasAgent = info.agent ?? "claude";
        return aliasAgent === sessionAgent && info.providerSessionId === resumeSessionId;
      });
      let liveAlias: SessionInfo | undefined;
      for (const candidate of liveAliases) {
        // Claude の tmux が残っていても pane がシェルだけなら再利用不能。launcher の
        // --resume 経路へ進める。Codex は App Server 駆動なので tmux TUI の状態に依存しない。
        if (sessionAgent === "codex" || await sessionManager.agentProcessAlive(candidate.name)) {
          liveAlias = candidate;
          break;
        }
      }
      if (liveAlias !== undefined) {
        engineDiag(
          `session_start resume alias reuse existing=${liveAlias.name} requested=${message.name} providerSessionId=${resumeSessionId}`,
        );
        // 通常再開はここで購読してアクティブ化する。prepare は正しい serve が開くまで遅延する。
        if (!await activateOrTouchSession(
          ctx, writer, v, message.id, liveAlias.name, shouldSubscribe,
        )) return;
        writeSessionListResponse(
          writer, v, message.id, shouldSubscribe ? aliases : [liveAlias], null, liveAlias.name,
        );
        return;
      }
    }
    if (chosenLauncher === null) {
      // 未注入（テスト構成漏れ等）: 安全側 — 実起動せず構造化 error を返す。
      process.stderr.write("[tailii-host engine] session_start: launcher 未構成\n");
      writeError(writer, v, message.id, "launch_failed", "launch 機能が構成されていません。");
      return;
    }
    const runtimeClaim = await claimRuntime(ctx, message.name);
    if (runtimeClaim === "held") {
      const appeared = await waitForLiveSession(sessionManager, (info) => {
        if (resumeSessionId === null) return info.name === message.name;
        return (info.agent ?? "claude") === sessionAgent && info.providerSessionId === resumeSessionId;
      });
      if (appeared !== null) {
        if (!await activateOrTouchSession(
          ctx, writer, v, message.id, appeared.name, shouldSubscribe,
        )) return;
        if (shouldSubscribe) {
          try { writeSessionListResponse(writer, v, message.id, await sessionManager.list(), null, appeared.name); }
          catch { writeSessionListResponse(writer, v, message.id, [appeared], null, appeared.name); }
        } else {
          writeSessionListResponse(writer, v, message.id, [appeared], null, appeared.name);
        }
      } else {
        writeError(writer, v, message.id, "launch_failed", "他の接続による会話の起動を確認できませんでした。");
      }
      return;
    }
    // 新規起動は host 生成の session-id で claude を起動し（`--session-id <uuid>`）、
    // 会話 jsonl 名を事前に確定させる。tail はその id の jsonl だけを追うため、同一 cwd に
    // 別の稼働セッションがあっても、そのログが新セッションへ流れ込まない（取り違え防止）。
    const newSessionId =
      sessionAgent === "claude" && resumeSessionId === null ? randomUUID() : null;
    // codex は session-id 固定を持たず mtime で rollout を解決するため、新規起動は
    // 「起動時刻より後に更新された rollout」に限定する（古い rollout の流入防止）。
    // claude は preferred=newSessionId で厳密束縛するため newerThanMs は効かない（無害）。
    const launchedAtMs = Date.now();
    engineDiag(
      `session_start launcher 呼出前 cwd=${message.cwd} name=${message.name} resume=${resumeSessionId ?? "nil"} newId=${newSessionId ?? "nil"}`,
    );
    let result;
    try {
      result = await chosenLauncher(
        message.cwd, message.name, message.baseDir ?? null, resumeSessionId, newSessionId,
        message.title ?? null,
        sessionAgent === "codex"
          ? {
              codexModel: message.codexModel ?? null,
              codexSandbox: message.codexSandbox ?? null,
            }
          : undefined,
      );
    } finally {
      ctx.hubLink.send({ type: "runtime_claim_release", session: message.name });
    }
    engineDiag(
      `session_start launcher 結果 exit=${result.exitCode} err=${result.errorText.slice(0, 100)}`,
    );
    if (result.exitCode === 0) {
      const providerSessionId =
        result.providerSessionId ?? resumeSessionId ?? newSessionId;
      // cwd は launcher が権威記録した解決後 cwd（メタ）を優先。
      // 通常起動/再開はここで購読してアクティブ化する。prepare は reattach まで遅延する。
      // tail は確定した会話 id（resume=既存 id / 新規=生成 id）だけを追う。newerThanMs は
      // codex（mtime 解決）の新規起動でのみ効き、claude は preferred で厳密束縛される。
      if (!await activateOrTouchSession(
        ctx, writer, v, message.id, message.name, shouldSubscribe,
        providerSessionId === null && resumeSessionId === null ? launchedAtMs : undefined,
      )) return;
      // 成功: 現況一覧で応答する（kill と同じ疎通様式）。
      if (!shouldSubscribe) {
        // prepare 応答にも採用 session 1 件を載せ、iOS が reattach 前から実 backend を
        // 観測できるようにする。購読は引き続き開始しない（sessions は状態スナップショットのみ）。
        let adopted: SessionInfo | undefined;
        try {
          adopted = (await sessionManager.list()).find((info) => info.name === message.name);
        } catch {
          // launcher 成功後の一覧取得失敗は、下のメタデータ由来 1 件へ縮退する。
        }
        if (adopted === undefined) {
          const meta = metadataStore?.get(message.name) ?? null;
          adopted = {
            name: message.name,
            cwd: meta?.cwd ?? message.cwd,
            alive: true,
            ...(meta?.backend === "herdr" ? { backend: "herdr" as const } : {}),
            ...(meta?.claudeSessionId !== undefined
              ? { claudeSessionId: meta.claudeSessionId }
              : {}),
            ...(meta?.agent !== undefined ? { agent: meta.agent } : {}),
            ...(meta?.providerSessionId !== undefined
              ? { providerSessionId: meta.providerSessionId }
              : {}),
          };
        }
        writeSessionListResponse(writer, v, message.id, [adopted], null, message.name);
        return;
      }
      try {
        const sessions = await sessionManager.list();
        writeSessionListResponse(writer, v, message.id, sessions, null, message.name);
      } catch {
        // 起動自体は成功しているため、一覧取得失敗時は当該セッション単独で応答する。
        try {
          writeSessionListResponse(
            writer, v, message.id,
            [{ name: message.name, cwd: message.cwd, alive: true }], null, message.name,
          );
        } catch {
          // 書込失敗は握り潰す（Swift 版 try? と同じ）。
        }
      }
    } else {
      const m = result.errorText || `launch 失敗 (exit ${result.exitCode})`;
      writeError(writer, v, message.id, "launch_failed", m);
    }
  },
};
