// engine/handlers/session.ts
// セッションライフサイクル: 一覧・reattach（resume 再起動含む）・kill（worktree 掃除含む）・
// 新規/再開起動（session_start）・離脱（session_idle_hint）。

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { ChatAgent } from "../../chat/chatTailController.js";
import {
  beginWorktreeLaunch,
  rollbackFailedLaunchWorktree,
  settleWorktreeAfterKill,
} from "../worktreeJanitor.js";
import { makeSessionLauncher, claudeInnerCommand } from "../../commands/launch.js";
import type { ControlMessage, SessionInfo } from "../../protocol.js";
import {
  activateOrTouchSession,
  claimRuntime,
  demoteToBackgroundSubscription,
  emitPendingQuestion,
  engineDiag,
  sessionInfoFromMeta,
  subscribeConversation,
  waitForLiveSession,
  writeError,
  writeSessionListResponse,
  type HandlerContext,
  type HandlerRegistry,
  type WorktreeResponseFields,
} from "../context.js";
import { isNonBlockingQuestionId } from "../../codex/codexAsyncQuestion.js";
import { questionPendingSummary } from "../remotePendingQuestions.js";
import type { SessionBackendKind } from "../../backend/sessionBackend.js";
import type { SessionMeta } from "../../sessions/sessionMetadataStore.js";
import { PREWARM_TTL_SECONDS, prewarmExpired, prewarmFingerprint } from "../../sessions/prewarmStore.js";
import { claudeTranscriptExists } from "../../sessions/claudeTranscriptExists.js";
import { startApiAgentSession } from "./apiAgent.js";
import { ApiAgentLedgerStore } from "../../apiAgent/ledger.js";

/** 会話を開き直せなかった（答えられない backend で動いている可能性がある）ときの文言。backend 名は出さない。 */
export const RESUME_BLOCKED_BY_UNAVAILABLE_BACKEND =
  "ホスト側の端末が応答しないため、この会話を開けませんでした（ホストで動いている可能性があり、二重に起動しないよう止めました）。";

/**
 * 答えられなかった backend で、この会話（同じエージェント・同じ provider の会話 id）が動いている可能性があるか。
 * その backend の Tailii セッションの記録のうち、この起動の後に作られたもの（`createdAt`）があれば「ある」。見えない
 * だけで動いていることがある（tmux の socket ファイルだけが消えた等）。起動より前の記録は、そのプロセスごと止まって
 * いる（tmux サーバも herdr の pane も再起動を越えない。tmux は起動のたびに createdAt を書き直し、herdr は pane を
 * 作った時刻を保つ）ので数えない（独立検証 2026-10-26: 起動前の古い tmux の記録が残っているだけで、その会話を開け
 * なくなっていた）。heartbeat では判定しない: hub が処理中・設問を戻した会話の heartbeat を毎分書き直すので、
 * 再起動で止まった会話まで「起動後に動いている」に見える（同 6 周目）。メタの backend 欄が無い記録は tmux 扱い
 * （CompositeSessionBackend と同じ後方互換）。
 */
export function conversationMayRunOn(
  metas: SessionMeta[], unavailable: SessionBackendKind[], agent: ChatAgent, providerSessionId: string,
  bootedAtSeconds: number,
): boolean {
  return metas.some((meta) =>
    unavailable.includes(meta.backend ?? "tmux") &&
    (meta.agent ?? "claude") === agent &&
    (meta.providerSessionId ?? meta.claudeSessionId) === providerSessionId &&
    meta.createdAt >= bootedAtSeconds);
}

/**
 * 会話名ごとの起動の直列化（session-prewarm）。hub の runtime claim は同じ接続（engine）からの要求を
 * 再入で通すので、同じ接続から続けて来る `session_prewarm` と `session_start` を排他できない。
 * 先行起動の途中に送信が来ても、起動を終えて記録が揃ってから採用を判断する。
 */
const launchLocks = new Map<string, Promise<void>>();
async function withLaunchLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  const previous = launchLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  launchLocks.set(name, chained);
  await previous;
  try {
    return await body();
  } finally {
    release();
    if (launchLocks.get(name) === chained) launchLocks.delete(name);
  }
}

/** claude 新規起動の launcher を選ぶ（モデル等の起動フラグがあればその場で組む。session_start / prewarm 共通）。 */
function claudeLauncherFor(
  ctx: HandlerContext,
  flags: { model?: string | undefined; permissionMode?: string | undefined; effort?: string | undefined; worktree?: string | undefined },
): HandlerContext["launcher"] {
  if (flags.model === undefined && flags.permissionMode === undefined &&
      flags.effort === undefined && flags.worktree === undefined) {
    return ctx.launcher;
  }
  return makeSessionLauncher({
    ...(ctx.metadataStore !== null && { store: ctx.metadataStore }),
    agent: "claude",
    backend: ctx.backendKind,
    innerCommand: claudeInnerCommand({
      model: flags.model ?? null,
      permissionMode: flags.permissionMode ?? null,
      effort: flags.effort ?? null,
      worktree: flags.worktree ?? null,
    }),
  });
}

/** 起動の途中の先行起動を待って採用へ回すときの上限（pane 作成は通常 1 秒未満）。 */
const PREWARM_CLAIM_WAIT_MS = 8_000;
/** 採用を打ち切る、期限（PREWARM_TTL_SECONDS）の手前の余裕（秒）。reaper の tick（60 秒）より長く取る。 */
const PREWARM_ADOPT_MARGIN_SECONDS = 120;

/** runtime claim が空くまで待って取る（取れなければ held）。 */
async function waitForRuntimeClaim(ctx: HandlerContext, name: string): Promise<"granted" | "held"> {
  const deadline = Date.now() + PREWARM_CLAIM_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await claimRuntime(ctx, name) === "granted") return "granted";
  }
  return "held";
}

/**
 * 先行起動の会話が、いま一覧に生きていて Claude が動いているか（session-prewarm）。
 * `agentProcessAlive` だけでは足りない: セッション・pane が**無い**ときも true を返す（二重起動を避ける
 * 既存の規約）。送信前に Claude ごと消えた先行起動を「採用」すると、起動しないまま無い会話を返す。
 * 一覧を取れなければ `unknown`（呼び出し側が安全側へ倒す）。
 */
async function prewarmSessionLive(ctx: HandlerContext, name: string): Promise<"live" | "gone" | "unknown"> {
  let listed: boolean;
  try {
    if (ctx.sessionManager.listAvailable !== undefined) {
      // 答えなかった backend があっても、この会話の backend が答えていれば判定できる（tmux の socket ファイルが
      // 消える障害は数分続く。一覧ごと「判定不能」にすると、その間この名前で送れなくなる）。
      const available = await ctx.sessionManager.listAvailable();
      const backend = ctx.metadataStore?.get(name)?.backend ?? "tmux";
      if (available.unavailable.includes(backend)) return "unknown";
      listed = available.sessions.some((info) => info.name === name && info.alive);
    } else {
      listed = (await ctx.sessionManager.list()).some((info) => info.name === name && info.alive);
    }
  } catch {
    return "unknown";
  }
  if (!listed) return "gone";
  return await ctx.sessionManager.agentProcessAlive(name).catch(() => false) ? "live" : "gone";
}

/**
 * 先行起動を閉じて記録を消す（使われなかった・パラメータが変わった・取り消された）。
 * 閉じられたか、もともと無かったら true。**閉じられずに残っている**ときは false で、記録も残す
 * （同じ名前で起動し直すと既存の pane を再利用し、新しく採番した会話 id と実際に動いている Claude の id が
 * 食い違う。記録を残せば、次の要求でもう一度閉じにいく）。
 */
async function discardPrewarm(ctx: HandlerContext, name: string, reason: string): Promise<boolean> {
  try {
    await ctx.sessionManager.kill(name);
  } catch (error) {
    // 既に無い（起動に失敗した・利用者が閉じた）なら閉じられたのと同じ。残っていれば失敗。
    if (await prewarmSessionLive(ctx, name) !== "gone") {
      engineDiag(`session_prewarm 閉じられず name=${name} reason=${reason}: ${String(error)}`);
      return false;
    }
  }
  ctx.prewarmStore?.remove(name);
  engineDiag(`session_prewarm 破棄 name=${name} reason=${reason}`);
  return true;
}

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
    // iPhone の時計が host より進んでいると、起点が未来になり共有 tail が新着まで捨て続ける（全購読者）。
    // host の現在時刻で頭打ちにする（reattach-since）。
    const reattachSince = (newerThanMs: number | undefined): number | undefined =>
      newerThanMs === undefined ? undefined : Math.min(newerThanMs, Date.now());
    const { writer, state, sessionManager, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    // 再アクティブ化（heartbeat 更新 = アイドル計時リセット）→ 生存なら即 reattach /
    // メタあり tmux 不在は記録 cwd で resume 再起動 → attached / メタ無しは従来の not_found。
    try {
      const result = await sessionManager.reattach(message.name);
      if (result.kind === "attached") {
        writeSessionListResponse(writer, v, message.id, [result.info], null);
        subscribeConversation(ctx, message.name, reattachSince(message.newerThanMs));
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
              subscribeConversation(ctx, message.name, reattachSince(message.newerThanMs));
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
            // （deleted-worktree-resume）ため、応答は起動後の権威記録メタ（cwd / backend /
            // 会話 id）から組む。backend を欠くと iOS が herdr 会話を tmux 表示する。
            const info = sessionInfoFromMeta(metadataStore, message.name, meta.cwd);
            writeSessionListResponse(writer, v, message.id, [info], null);
            subscribeConversation(ctx, message.name, reattachSince(message.newerThanMs));
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
    const { writer, state, sessionManager } = ctx;
    const v = state.negotiatedVersion;
    try {
      const worktreeResponse = await killSessionForUser(ctx, message.name);
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
        // 背景購読へ降格（engine 本体の閉包経由: LRU 上限・冪等購読・猶予タイマー取消を 1 箇所に集約）。
        demoteToBackgroundSubscription(ctx, message.name);
      } else {
        ctx.hubLink.send({ type: "conversation_unsubscribe", session: message.name });
      }
      // 未回答の設問を残して離脱した → 一覧バッジへ引き継ぐ（question-hook-relay）。
      const pending = await ctx.requestHubState(message.name);
      // turn を止めない設問（Codex の非同期質問）は「あなたの番」のバッジにしない（作業中表示が消える）。
      if (pending !== null && !isNonBlockingQuestionId(pending.id)) {
        writer.write({
          type: "remote_pending",
          v,
          id: pending.id,
          session: message.name,
          kind: "question",
          summary: questionPendingSummary(pending.questions),
        });
      }
    }
    // focus の有無にかかわらず、指定 session の離脱時刻を Hub に記録する。ただし処理中会話を背景
    // 購読へ降格した直後（または hub_state で処理中と判り watch した直後）は送らない: Hub の
    // unsubscribe は購読自体を落とすため、engine の backgroundChatSessions と Hub の購読が食い違い、
    // 次の hook で再購読 → 全履歴 backfill を繰り返す嵐の一因になっていた（2026-09-07）。
    if (!ctx.backgroundChatSessions.has(message.name)) {
      ctx.hubLink.send({ type: "conversation_unsubscribe", session: message.name });
    }
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
    // 端末なしの会話（API 作業, api-agent）。pane は作らず、hub の ApiAgentManager に開かせる。
    if (message.executionRoute === "api") {
      await withLaunchLock(message.name, () => startApiAgentSession(message, ctx));
      return;
    }
    const { writer, state, sessionManager, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    // session_start → launch() 結線。agentType でセッション毎に claude/codex を選ぶ
    //（未指定は host 既定 defaultAgent）。codex は agentType=codex 時の専用 launcher を使う。
    const sessionAgent: ChatAgent = message.agentType ?? ctx.defaultAgent;
    // claude 新規起動でモデル/permission mode/effort 指定があれば、その flags（--model /
    // --permission-mode / --effort）を持つ launcher をその場で組む（起動前選択の反映）。
    // resume は元セッションの設定を継ぐため既定 launcher を使う。
    const perSessionClaudeLauncher =
      sessionAgent === "claude" && message.resumeSessionId === undefined
        ? claudeLauncherFor(ctx, message)
        : null;
    const chosenLauncher =
      sessionAgent === "codex"
        ? (ctx.codexLauncher ?? ctx.launcher)
        : (perSessionClaudeLauncher ?? ctx.launcher);
    const resumeSessionId = message.resumeSessionId ?? null;
    const shouldSubscribe = message.deferSubscribe !== true;
    if (resumeSessionId !== null && metadataStore !== null) {
      // 片方の backend が答えられなくても（tmux の socket ファイルが無い等）、答えた方で同じ会話を探す。以前は一覧ごと
      // 投げ、engine の読み取りループまで落ちて接続が切れていた（独立検証 2026-10-26）。
      const listed = sessionManager.listAvailable !== undefined
        ? await sessionManager.listAvailable()
        : { sessions: await sessionManager.list(), unavailable: [] };
      const aliases = listed.sessions;
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
      // 答えた backend に動いている同じ会話が無い。答えられなかった backend に、この起動の後に動いていた記録があれば、
      // 見えないだけで動いている可能性がある（socket ファイルだけが消えた tmux 等）ので起動しない（二重になる）。
      if (listed.unavailable.length > 0 && conversationMayRunOn(
        metadataStore.all(), listed.unavailable, sessionAgent, resumeSessionId, Date.now() / 1_000 - os.uptime(),
      )) {
        engineDiag(
          `session_start resume 見送り（backend 応答なし: ${listed.unavailable.join(",")}） providerSessionId=${resumeSessionId}`,
        );
        writeError(writer, v, message.id, "tmux_error", RESUME_BLOCKED_BY_UNAVAILABLE_BACKEND);
        return;
      }
    }
    if (chosenLauncher === null) {
      // 未注入（テスト構成漏れ等）: 安全側 — 実起動せず構造化 error を返す。
      process.stderr.write("[tailii-host engine] session_start: launcher 未構成\n");
      writeError(writer, v, message.id, "launch_failed", "launch 機能が構成されていません。");
      return;
    }
    await withLaunchLock(message.name, () => startUnderLock(message, ctx, {
      sessionAgent, chosenLauncher, resumeSessionId, shouldSubscribe,
    }));
  },

  session_prewarm: async (message, ctx) => {
    // 新規会話（Claude）の先行起動（session-prewarm）。応答は無い（iOS は送りっぱなし）。
    const { sessionManager, metadataStore, prewarmStore } = ctx;
    if (prewarmStore === null || metadataStore === null) return;
    await withLaunchLock(message.name, async () => {
      const fingerprint = prewarmFingerprint(message);
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const existing = prewarmStore.get(message.name);
      if (existing === null) {
        // 先行起動の記録が無い同名の会話（実在の会話）には触らない。
        const meta = metadataStore.get(message.name);
        if (meta !== null) {
          const id = meta.providerSessionId ?? meta.claudeSessionId;
          const used = id !== undefined && claudeTranscriptExists(meta.cwd, id);
          if (used || await prewarmSessionLive(ctx, message.name) !== "gone") {
            engineDiag(`session_prewarm 見送り（同名の会話あり） name=${message.name}`);
            return;
          }
        }
      } else if (existing.fingerprint === fingerprint && await prewarmSessionLive(ctx, message.name) === "live") {
        // 同じ起動パラメータで先行起動済み。期限だけ延ばす。
        prewarmStore.put({ ...existing, touchedAt: nowSeconds });
        return;
      } else {
        // パラメータが変わった（モデル・モード・会話名等）か、起動済みの Claude が居ない。閉じて起動し直す。
        if (!await discardPrewarm(ctx, message.name, existing.fingerprint === fingerprint ? "dead" : "params-changed")) {
          return;
        }
      }
      const launcher = claudeLauncherFor(ctx, message);
      if (launcher === null) return;
      if (await claimRuntime(ctx, message.name) === "held") {
        // 別の接続が同じ名前を起動中（送信の session_start 等）。先行起動はしない。
        engineDiag(`session_prewarm 見送り（起動中） name=${message.name}`);
        return;
      }
      const claudeSessionId = randomUUID();
      // 記録は起動の前に書く: 起動の途中で別の接続の session_start が来ても先行起動だと分かる。
      prewarmStore.put({
        name: message.name, fingerprint, claudeSessionId, createdAt: nowSeconds, touchedAt: nowSeconds,
      });
      let launched = false;
      try {
        const result = await launcher(
          message.cwd, message.name, message.baseDir ?? null, null, claudeSessionId,
          message.title ?? null,
          message.outputStyle !== undefined || message.todoTools === true
            ? { outputStyle: message.outputStyle ?? null, todoTools: message.todoTools === true, worktree: null }
            : undefined,
        );
        launched = result.exitCode === 0;
        engineDiag(
          `session_prewarm 起動 name=${message.name} exit=${result.exitCode} id=${claudeSessionId}` +
            (launched ? "" : ` err=${result.errorText.slice(0, 100)}`),
        );
      } catch (error) {
        engineDiag(`session_prewarm 起動失敗 name=${message.name}: ${String(error)}`);
      } finally {
        ctx.hubLink.send({ type: "runtime_claim_release", session: message.name });
        if (!launched) prewarmStore.remove(message.name);
      }
    });
  },

  session_prewarm_cancel: async (message, ctx) => {
    // 送らずにドラフトを離れた（session-prewarm）。先行起動のまま使われていないものだけ閉じる。
    const { prewarmStore, metadataStore } = ctx;
    if (prewarmStore === null) return;
    await withLaunchLock(message.name, async () => {
      const record = prewarmStore.get(message.name);
      if (record === null) return;
      const cwd = metadataStore?.get(message.name)?.cwd ?? null;
      if (cwd !== null && claudeTranscriptExists(cwd, record.claudeSessionId)) {
        // 会話が始まっている（記録の消し忘れ）。閉じずに記録だけ消す。
        prewarmStore.remove(message.name);
        return;
      }
      await discardPrewarm(ctx, message.name, "cancelled");
    });
  },
};

type SessionStartMessage = Extract<ControlMessage, { type: "session_start" }>;

/** 起動（または先行起動の採用）が成立した session_start へ、現況一覧で応答する。 */
async function writeLaunchedResponse(
  ctx: HandlerContext,
  message: SessionStartMessage,
  shouldSubscribe: boolean,
): Promise<void> {
  const { writer, state, sessionManager, metadataStore } = ctx;
  const v = state.negotiatedVersion;
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
      adopted = sessionInfoFromMeta(metadataStore, message.name, message.cwd);
    }
    writeSessionListResponse(writer, v, message.id, [adopted], null, message.name);
    return;
  }
  try {
    const sessions = await sessionManager.list();
    writeSessionListResponse(writer, v, message.id, sessions, null, message.name);
  } catch {
    // 起動自体は成功しているため、一覧取得失敗時は当該セッション単独で応答する
    // （backend はメタから明示する）。
    try {
      writeSessionListResponse(
        writer, v, message.id,
        [sessionInfoFromMeta(metadataStore, message.name, message.cwd)], null, message.name,
      );
    } catch {
      // 書込失敗は握り潰す（Swift 版 try? と同じ）。
    }
  }
}

/** session_start の起動部分（会話名ごとの直列化の内側で走る, session-prewarm）。 */
async function startUnderLock(
  message: SessionStartMessage,
  ctx: HandlerContext,
  plan: {
    sessionAgent: ChatAgent;
    chosenLauncher: NonNullable<HandlerContext["launcher"]>;
    resumeSessionId: string | null;
    shouldSubscribe: boolean;
  },
): Promise<void> {
  const { writer, state, sessionManager, metadataStore } = ctx;
  const v = state.negotiatedVersion;
  const { sessionAgent, chosenLauncher, resumeSessionId, shouldSubscribe } = plan;
  let runtimeClaim = await claimRuntime(ctx, message.name);
  if (runtimeClaim === "held" && resumeSessionId === null && ctx.prewarmStore?.get(message.name) != null) {
    // 別の接続（再接続前の engine 等）がこの名前を先行起動している最中。現れた会話をそのまま使うと、
    // 起動パラメータ（モード・モデル・会話名）を照合せずに採用してしまう。起動を終えて claim が空くのを
    // 待ち、下の照合つきの採用へ進む。
    runtimeClaim = await waitForRuntimeClaim(ctx, message.name);
    if (runtimeClaim === "held") {
      // 下の「現れるのを待って使う」へは進まない（照合なしの採用になる。session_start は直列処理なので、
      // さらに待つと別の会話への送信まで ACK 予算を超えて待たせる）。
      writeError(writer, v, message.id, "launch_failed",
        "他の接続による会話の起動準備が終わりませんでした。もう一度送信してください。");
      return;
    }
  }
  if (runtimeClaim === "held") {
    const appeared = await waitForLiveSession(sessionManager, (info) => {
      if (resumeSessionId === null) return info.name === message.name;
      return (info.agent ?? "claude") === sessionAgent && info.providerSessionId === resumeSessionId;
    });
    if (appeared !== null) {
      // 別の接続の先行起動（session-prewarm）が起動中だった。その Claude をこの会話として使うので、
      // 先行起動の印を外す（残すと一覧に出ず、期限切れで閉じられる）。
      if (resumeSessionId === null) ctx.prewarmStore?.remove(message.name);
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
  // 先行起動（session-prewarm）の採用: ドラフトで打ち始めた時点で同じ起動パラメータの Claude を
  // 裏で起動済みなら、それをこの会話として使う（送信してから Claude の起動を待たない）。
  // パラメータが違う・Claude が居ない先行起動は閉じてから従来どおり起動する（同じ名前の pane を
  // 再利用すると、新しく採番した会話 id と実際に動いている Claude の id が食い違う）。
  const prewarm = resumeSessionId === null ? ctx.prewarmStore?.get(message.name) ?? null : null;
  if (prewarm !== null) {
    let adopted = false;
    try {
      const meta = metadataStore?.get(message.name) ?? null;
      adopted = sessionAgent === "claude" && message.worktree === undefined &&
        prewarm.fingerprint === prewarmFingerprint(message) &&
        (meta?.claudeSessionId ?? meta?.providerSessionId) === prewarm.claudeSessionId &&
        // 期限の間際は採用しない（reaper は engine の直列化の外で期限切れを閉じる。採用と閉じるが
        // すれ違って採用直後の会話を閉じないよう、reaper の期限より手前で打ち切る）。
        !prewarmExpired(prewarm, Math.floor(Date.now() / 1_000), PREWARM_TTL_SECONDS - PREWARM_ADOPT_MARGIN_SECONDS) &&
        await prewarmSessionLive(ctx, message.name) === "live";
      if (adopted) {
        ctx.prewarmStore?.remove(message.name);
        engineDiag(
          `session_start 先行起動を採用 name=${message.name} id=${prewarm.claudeSessionId} ` +
            `先行=${Math.max(0, Math.floor(Date.now() / 1_000) - prewarm.createdAt)}s`,
        );
      } else if (!await discardPrewarm(ctx, message.name, "start-mismatch")) {
        // 閉じられないまま起動すると既存の pane を再利用して会話 id が食い違う（出力の出ない会話になる）。
        ctx.hubLink.send({ type: "runtime_claim_release", session: message.name });
        writeError(writer, v, message.id, "launch_failed",
          "前の起動準備を片付けられませんでした。もう一度送信してください。");
        return;
      }
    } finally {
      if (adopted) ctx.hubLink.send({ type: "runtime_claim_release", session: message.name });
    }
    if (adopted) {
      if (!await activateOrTouchSession(ctx, writer, v, message.id, message.name, shouldSubscribe)) return;
      await writeLaunchedResponse(ctx, message, shouldSubscribe);
      return;
    }
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
  // 起動中の cwd は掃除・巻き戻しの対象にしない（同じ worktree へ並行して起動する場合の保護）。
  const releaseLaunch = beginWorktreeLaunch(message.cwd);
  try {
    result = await chosenLauncher(
      message.cwd, message.name, message.baseDir ?? null, resumeSessionId, newSessionId,
      message.title ?? null,
      sessionAgent === "codex"
        ? {
            codexModel: message.codexModel ?? null,
            codexSandbox: message.codexSandbox ?? null,
          }
        : message.outputStyle !== undefined || message.todoTools === true || message.worktree !== undefined
          ? {
              // 出力スタイル（新規起動の `--settings`）・Task/Todo ツール env（新規 / resume 共通）・
              // PR/MR worktree（メタデータ cwd の記録先, worktree-from-pr）。
              outputStyle: message.outputStyle ?? null,
              todoTools: message.todoTools === true,
              worktree: message.worktree ?? null,
            }
          : undefined,
    );
  } catch (error) {
    releaseLaunch();
    await rollbackLaunchWorktree(ctx, message, resumeSessionId);
    throw error;
  } finally {
    releaseLaunch();
    ctx.hubLink.send({ type: "runtime_claim_release", session: message.name });
  }
  engineDiag(
    `session_start launcher 結果 exit=${result.exitCode} err=${result.errorText.slice(0, 100)}`,
  );
  if (result.exitCode === 0) {
    // API 作業を使ったことがある会話を端末で再開した → 最後の実行経路を端末にする（一覧からの開き直しを端末にする。
    // 台帳＝利用額の記録は消さない。台帳が無い会話には何も書かない, api-agent-handoff）。
    if (resumeSessionId !== null && sessionAgent === "claude") {
      try { new ApiAgentLedgerStore().setRoute(resumeSessionId, "terminal"); } catch { /* 一覧の印だけの問題。 */ }
    }
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
    await writeLaunchedResponse(ctx, message, shouldSubscribe);
  } else {
    const m = result.errorText || `launch 失敗 (exit ${result.exitCode})`;
    await rollbackLaunchWorktree(ctx, message, resumeSessionId);
    writeError(writer, v, message.id, "launch_failed", m);
  }
}

/**
 * 新規起動に失敗したとき、ドラフトが今作った worktree を巻き戻す（再送のたびに増えないように）。
 * resume や PR / MR worktree（claude 自身が作る）は対象外。判定は worktreeJanitor が安全側で行う。
 */
async function rollbackLaunchWorktree(
  ctx: HandlerContext,
  message: Extract<ControlMessage, { type: "session_start" }>,
  resumeSessionId: string | null,
): Promise<void> {
  if (resumeSessionId !== null || message.worktree !== undefined) return;
  await rollbackFailedLaunchWorktree(ctx, message.cwd);
}

/**
 * 利用者の明示操作によるセッション終了（session_kill / conversation_delete 共用）。
 * 端末の kill に失敗したら throw する。Tailii 作成の worktree は clean なら掃除する（fail-open）。
 */
export async function killSessionForUser(
  ctx: HandlerContext,
  name: string,
  /**
   * `tailiiWorktreesOnly`: Tailii が作った worktree だけを片付け対象にする（会話の完全削除）。
   * `keepWorktree`: 作業フォルダ（worktree）を消さない。API 作業への引き継ぎ・元へ戻すでは
   * 同じ作業フォルダで会話を続けるので、変更なしの worktree の自動削除を走らせない（api-agent-handoff）。
   */
  options: { tailiiWorktreesOnly?: boolean; keepWorktree?: boolean } = {},
): Promise<WorktreeResponseFields | null> {
  const { sessionManager, metadataStore } = ctx;
  // cwd の権威は tmux の現在位置ではなく永続 SessionMetadataStore。
  const killedMeta = metadataStore?.get(name) ?? null;
  const killedCwd = killedMeta?.cwd ?? null;
  const killedConversationId = killedMeta?.providerSessionId ?? killedMeta?.claudeSessionId ?? null;
  // 明示 kill はユーザー意思なので処理中保護より優先する（保護記録も掃除）。
  ctx.processingSessions.delete(name);
  ctx.backgroundChatSessions.delete(name);
  ctx.hubLink.send({ type: "conversation_unsubscribe", session: name });
  ctx.codexTurnController?.closeSession(name);
  // kill する会話を tail 中なら止める（生かしたままだと再オープンの open() が
  // 「同一会話 tail 中」でスキップし、履歴が再生されず空表示になる）。
  if (ctx.activeChatSession.name === name) {
    ctx.activeChatSession.name = null;
  }
  await sessionManager.kill(name);
  // kill 成功後だけ Hub の actor / durable queue / delivered receipt を廃棄する。
  // 同名セッションを後日作り直しても、旧会話の queued 入力を注入させない。
  ctx.hubLink.send({ type: "session_retire", session: name });
  if (options.keepWorktree === true) return null;
  if (killedCwd === null) return null;
  try {
    return await settleWorktreeAfterKill(
      ctx, { name, cwd: killedCwd, conversationId: killedConversationId },
      { tailiiOnly: options.tailiiWorktreesOnly === true },
    );
  } catch (error) {
    // worktree の判定・掃除は fail-open。ユーザーが要求した kill の成功を覆さない。
    engineDiag(`session_kill worktree 掃除失敗 path=${killedCwd}: ${String(error)}`);
    return { worktreePath: killedCwd };
  }
}
