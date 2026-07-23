// engine.ts
// tailii (TS host) — engine サブコマンド実装（EngineControl）
// Swift 版 Engine.swift の移植。
//
// セッション横断制御チャネル。stdin/stdout（SSH exec の stdio）で NDJSON 制御メッセージを
// 送受信し、session_* を TmuxSessionManager に橋渡しする。承認 socket は経由しない
// （横断制御を承認中継から位相分離）。
//
// 責務:
//   - チャネル確立直後に channel_hello(maxVersion) を送出し、相手 hello 受信で
//     採用版 = min(双方 maxVersion) を決める（4.3）。
//   - session_list_request / session_reattach / session_kill / session_start /
//     session_idle_hint / usage / mode / image / dir / browse / claude-sessions の橋渡し。
//   - decode 失敗行は破棄（承認文脈でないので単に無視、クラッシュしない）。

import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { ChatAgent } from "./chatTailController.js";
import {
  CodexRolloutTailer,
  CONTEXT_STREAM_ID as CODEX_CONTEXT_STREAM_ID,
  CONTEXT_WINDOW_STREAM_ID as CODEX_CONTEXT_WINDOW_STREAM_ID,
  MODEL_STREAM_ID as CODEX_MODEL_STREAM_ID,
} from "./codexRolloutTailer.js";
import { CodexAppServerManager } from "./codexAppServer.js";
import {
  CodexNativeTurnController,
  type CodexTurnControllerRuntime,
} from "./codexNativeTurnController.js";
import { ClaudeSessionStore } from "./claudeSessionStore.js";
import { CodexSessionStore } from "./codexSessionStore.js";
import { dirChildren, dirCreate, dirList } from "./dirLister.js";
import { ensureHubDaemon } from "./hubDaemon.js";
import { connectHubSocket, type HubLink } from "./hubClient.js";
import type { HubClientMessage, HubServerMessage } from "./hubProtocol.js";
import { bumpHeartbeat, defaultHeartbeatDir } from "./heartbeat.js";
import { ImageService } from "./imageService.js";
import { fileList, fileRead } from "./fileService.js";
import {
  gitBranchList,
  gitCheckout,
  gitDiff,
  gitDiscard,
  gitEntryStatuses,
  gitInit,
  gitLog,
  gitStatus,
  gitWorktreeCreate,
  gitWorktreeIsClean,
  gitWorktreeRemove,
  gitWorktreeUnlock,
  isTailiiWorktreePath,
} from "./gitService.js";
import type { QuestionEventMessage, SessionProcessingMessage } from "./engineRelaySocket.js";
import { makeSessionLauncher, claudeInnerCommand, type EngineLauncher } from "./launch.js";
import { LineWriter } from "./lineWriter.js";
import { parsePermissionMode } from "./permissionMode.js";
import { fetchPlanUsage, type PlanUsageProvider } from "./planUsageFetcher.js";
import { PreviewServer } from "./previewServer.js";
import { listServeProcesses, stopServeProcess } from "./serveService.js";
import {
  decodeControlMessage,
  PROTOCOL_MAX_SUPPORTED,
  PROTOCOL_V1,
  PROTOCOL_V2,
  type ControlMessage,
  type QuestionPromptQuestion,
  type SessionInfo,
  type SlashCommandInfo,
} from "./protocol.js";
import { ownTranscriptActivityProvider } from "./sessionActivityProvider.js";
import { SessionListService } from "./sessionListService.js";
import { searchClaudeSessions } from "./sessionSearch.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import { abortableSleep, sleep } from "./sleep.js";
import { HISTORY_DONE_STREAM_ID, TranscriptTailer } from "./transcriptTailer.js";
import {
  makeSessionBackend,
  resolveSessionBackendKind,
  writeSessionBackendKind,
  type SessionBackend,
  type SessionBackendKind,
} from "./sessionBackend.js";
import { herdrInstalled } from "./herdr.js";
import { aggregateUsage, emptyUsageTotals } from "./usageAggregator.js";
import { aggregateCodexUsage, type CodexUsage } from "./codexUsage.js";
import { createStaleDistGuard, isStaleDist, readPackageVersion, type StaleDistGuard } from "./version.js";
import { canonicalPath, claudeProjectSlug } from "./paths.js";

function engineDiag(message: string): void {
  if (process.env["TAILII_DEBUG"] === "1") process.stderr.write(`[tailii-host engine] ${message}\n`);
}

// MARK: - エントリポイント（cli から呼ばれる）

/**
 * engine サブコマンドのエントリポイント。実 stdin/stdout を使って EngineControl を起動する。
 * 引数（省略可、統合テスト注入用）: --sessions-dir / --inner-command / --images-dir /
 * --transcript / --claude-projects-dir / --idle-timeout / --resume-command。
 */
/**
 * 既定エージェントを host 側設定から解決する（`--agent` 未指定時のフォールバック）。
 * `~/.tailii/agent` の内容が `codex` なら codex、それ以外/不在は claude。
 * これにより iOS を改修せず（engine 起動コマンドは `<binary> engine` のまま）codex に切替できる。
 */
export function resolveDefaultAgent(
  agentFilePath: string = path.join(os.homedir(), ".tailii", "agent"),
): ChatAgent {
  try {
    const value = fs.readFileSync(agentFilePath, "utf8").trim().toLowerCase();
    if (value === "codex") return "codex";
  } catch {
    // 不在/読取失敗は既定 claude。
  }
  return "claude";
}

export async function runEngineCommand(args: string[]): Promise<number> {
  process.stderr.write("[tailii-host engine] 起動（横断制御チャネル）\n");

  let sessionsDirArg: string | null = null;
  let innerCommandArg: string | null = null;
  let imagesDirArg: string | null = null;
  let transcriptArg: string | null = null;
  let claudeProjectsDirArg: string | null = null;
  let resumeCommandArg: string | null = null;
  // 既定エージェントは host 側設定ファイルで切替可能（iOS 改修不要のトグル）。
  // `--agent` フラグが渡ればそちらが優先する。
  let agentArg: ChatAgent = resolveDefaultAgent();
  for (let i = 0; i < args.length; i += 1) {
    const next = (): string | null => (i + 1 < args.length ? args[++i]! : null);
    switch (args[i]) {
      case "--sessions-dir":
        sessionsDirArg = next();
        break;
      case "--inner-command":
        innerCommandArg = next();
        break;
      case "--agent": {
        const raw = next();
        if (raw === "codex" || raw === "claude") agentArg = raw;
        break;
      }
      case "--images-dir":
        imagesDirArg = next();
        break;
      case "--transcript":
        transcriptArg = next();
        break;
      case "--claude-projects-dir":
        claudeProjectsDirArg = next();
        break;
      case "--resume-command":
        resumeCommandArg = next();
        break;
      default:
        break;
    }
  }

  // list と launch が同一の cwd 権威ストアを共有するよう、ここで1つだけ構築して両者へ渡す。
  const store = new SessionMetadataStore(sessionsDirArg ?? undefined);

  // 画像シーム: hook が投入した pending の drain と image_fetch_request の index 逆引き配信。
  const imageService = imagesDirArg
    ? new ImageService({
        pendingBase: path.join(imagesDirArg, "pending"),
        indexBase: path.join(imagesDirArg, "index"),
      })
    : new ImageService();

  // 会話出力シーム: --transcript 注入時だけ TranscriptTailer を構築する（後方互換）。
  const transcriptTailer = transcriptArg ? new TranscriptTailer({ tailIndefinitely: true }) : null;

  // claude 会話ルート（`~/.claude/projects`）。セッション連動 chat_output tail の解決基点。
  const claudeProjectsRoot =
    claudeProjectsDirArg ?? path.join(os.homedir(), ".claude", "projects");

  // 一覧整形（session-list-lifecycle）: updatedAt 付与・整列・ページング。
  // updatedAt の権威はセッション自身の会話 transcript（会話が無ければ最下位）。
  // 端末バックエンド（tmux / herdr）は設定ファイル or アプリ（backend_set）で切替可能。
  // 稼働系は常時 Composite（per-session ルーティング）なので、切替は再起動なしで
  // 「次に起動するセッション」から反映され、既存セッションは元のバックエンドで操作し続ける。
  const backendKind = resolveSessionBackendKind;
  const sessionManager = makeSessionBackend({ store });
  const claudeSessionStore = new ClaudeSessionStore(claudeProjectsRoot);
  const codexSessionStore = new CodexSessionStore();
  const sessionListService = new SessionListService(
    sessionManager,
    ownTranscriptActivityProvider({
      metadataStore: store,
      claudeStore: claudeSessionStore,
      codexStore: codexSessionStore,
    }),
  );

  // アイドルライフサイクル: kill 判定は Session Hub の周期 tick が担う。
  // engine は heartbeat（判定権威ファイル）の書き手 + Hub 常駐の保証だけを行う。
  ensureHubDaemon();
  // resume 再起動 launcher（kill 済みセッションを記録 cwd で claude --continue 再起動）。
  const resumeLauncher = makeSessionLauncher({
    store,
    innerCommand: resumeCommandArg ?? "claude --continue",
    agent: "claude",
    backend: backendKind,
  });
  // per-session: agentType=codex のセッション用に codex launcher / resume launcher を用意する。
  // codex は resume 未対応のため既定コマンドで新規起動する（新しい rollout を tail）。
  const codexAppServer = new CodexAppServerManager();
  const codexLauncher = makeSessionLauncher({
    store,
    agent: "codex",
    codexAppServer,
    backend: backendKind,
  });
  const codexResumeLauncher = makeSessionLauncher({
    store,
    agent: "codex",
    codexAppServer,
    backend: backendKind,
  });

  try {
    await runEngine({
      input: process.stdin,
      output: process.stdout,
      sessionManager,
      imageService,
      transcriptTailer,
      transcriptPath: transcriptArg,
      // launcher は常に claude 版。codex は codexLauncher で分岐する（per-session）。
      // agentType 未指定時にどちらへ倒すかは engine 内 defaultAgent(=agentArg) が決める。
      launcher: makeSessionLauncher({
        store,
        innerCommand: innerCommandArg,
        agent: "claude",
        backend: backendKind,
      }),
      backendKind,
      codexLauncher,
      sessionListService,
      metadataStore: store,
      resumeLauncher,
      codexResumeLauncher,
      claudeSessionStore,
      codexSessionStore,
      codexAppServer,
      agent: agentArg,
    });
    return 0;
  } catch (error) {
    process.stderr.write(`[tailii-host engine] 異常終了: ${String(error)}\n`);
    return 1;
  }
}

// MARK: - EngineControl コア (テスタブル)

export interface RunEngineOptions {
  /** "stdin" 側（iOS→Mac の制御要求が流れてくる）。 */
  input: Readable;
  /** "stdout" 側（Mac→iOS の応答を流す）。 */
  output: Writable;
  sessionManager: SessionBackend;
  /** 新規セッションの端末バックエンド解決子（既定 tmux 固定。per-session launcher 組立と backend_get/set に使う）。 */
  backendKind?: () => SessionBackendKind;
  /** backend_set の永続化先（テスト注入用。既定は `~/.tailii/backend` への書き込み）。 */
  backendWriter?: (kind: SessionBackendKind) => void;
  /** herdr 導入済み判定（テスト注入用。既定は実バイナリの存在検査）。 */
  herdrInstalledProbe?: () => boolean;
  /** 画像通知/取得の橋渡し（省略時は画像処理なし = 後方互換）。 */
  imageService?: ImageService | null;
  /** 会話出力キャプチャ（省略時は chat_output なし = 後方互換）。 */
  transcriptTailer?: TranscriptTailer | null;
  /** tail 対象の claude セッショントランスクリプト JSONL の絶対パス。 */
  transcriptPath?: string | null;
  /** session_start の橋渡し先。省略時（null）は error(launch_failed) を返す安全側既定。 */
  launcher?: EngineLauncher | null;
  /** codex セッション用 launcher（agentType=codex 時）。省略時は launcher にフォールバック。 */
  codexLauncher?: EngineLauncher | null;
  sessionListService?: SessionListService | null;
  metadataStore?: SessionMetadataStore | null;
  /** @deprecated heartbeat 書き込みは Hub が所有する。 */
  heartbeatDir?: string | null;
  /** @deprecated heartbeat tick は Hub が所有する。 */
  heartbeatTickSeconds?: number;
  resumeLauncher?: EngineLauncher | null;
  /** codex セッションの reattach 時 resume 用 launcher。省略時は resumeLauncher にフォールバック。 */
  codexResumeLauncher?: EngineLauncher | null;
  claudeSessionStore?: ClaudeSessionStore | null;
  /** codex 会話一覧の導出（agent-tag）。省略時は codex 会話を一覧に含めない（後方互換）。 */
  codexSessionStore?: CodexSessionStore | null;
  /** 対象エージェント（既定 claude）。codex は rollout tail を使う。 */
  agent?: ChatAgent;
  /** Codex turn/approval を同一 App Server 接続で扱う共有 runtime。 */
  codexAppServer?: CodexAppServerManager | null;
  /** テスト注入用の native turn controller。指定時は codexAppServer より優先する。 */
  codexTurnController?: CodexTurnControllerRuntime | null;
  /** 自分がサポートする最大版（既定 PROTOCOL_MAX_SUPPORTED）。 */
  maxVersion?: number;
  /** プラン使用状況の取得（既定は実 OAuth 使用量 API。テストは () => null を注入する）。 */
  planUsage?: PlanUsageProvider;
  /** slash_list のユーザーレベル探索ルート（既定は os.homedir()）。 */
  homeDir?: string;
  /** mode_get/mode_set の待機間隔（テストは短縮値を注入する）。 */
  modeTiming?: Partial<ModeTiming>;
  /** 起動時 package version と現在の package version を比較する stale 判定（テスト注入用）。 */
  staleDistGuard?: StaleDistGuard | null;
  /** stale dist 検出時の通知（CLI では return によりプロセス終了、テストは観測用）。 */
  onStaleDist?: () => void;
  /** @deprecated Hub 移管前のテスト互換。現在は使用しない。 */
  engineRelaySocketPath?: string | null;
  /** Session Hub link。省略時は daemon の hub.sock へ接続する。 */
  hubLink?: HubLink;
  /** Codex Hub start ACK の待機時間（テスト注入用、既定15秒）。 */
  codexHubRpcTimeoutMs?: number;
}

interface ModeTiming {
  getPollMs: number;
  getAttempts: number;
  setInitialPollMs: number;
  setInitialTimeoutMs: number;
  setChangePollMs: number;
  setChangeTimeoutMs: number;
}

const DEFAULT_MODE_TIMING: ModeTiming = {
  getPollMs: 250,
  getAttempts: 4,
  setInitialPollMs: 300,
  setInitialTimeoutMs: 10_000,
  setChangePollMs: 150,
  setChangeTimeoutMs: 1_500,
};

/**
 * EngineControl の本体。`input` から NDJSON 行を読み、session_* を `sessionManager` に
 * 橋渡しし、応答を `output` へ NDJSON 行で書く。EOF（input end）で正常終了する。
 */
export async function runEngine(options: RunEngineOptions): Promise<void> {
  const {
    sessionManager,
    backendKind = () => "tmux" as SessionBackendKind,
    backendWriter = writeSessionBackendKind,
    herdrInstalledProbe = herdrInstalled,
    imageService = null,
    transcriptTailer = null,
    transcriptPath = null,
    launcher = null,
    codexLauncher = null,
    sessionListService = null,
    metadataStore = null,
    resumeLauncher = null,
    codexResumeLauncher = null,
    claudeSessionStore = null,
    codexSessionStore = null,
    agent = "claude",
    codexAppServer = null,
    codexTurnController: injectedCodexTurnController = null,
    maxVersion = PROTOCOL_MAX_SUPPORTED,
    planUsage = () => fetchPlanUsage(),
    homeDir = os.homedir(),
    modeTiming = {},
    staleDistGuard = createStaleDistGuard(),
    onStaleDist = undefined,
    hubLink: injectedHubLink = undefined,
    codexHubRpcTimeoutMs = 15_000,
    heartbeatDir = defaultHeartbeatDir(),
  } = options;
  const resolvedModeTiming: ModeTiming = { ...DEFAULT_MODE_TIMING, ...modeTiming };
  const resolvedHeartbeatDir = heartbeatDir ?? defaultHeartbeatDir();
  const hubLink = injectedHubLink ?? connectHubSocket();

  // 出力の直列化（Node の Writable は書込順序を保証する）。
  const writer = new LineWriter(options.output);

  // 採用版（negotiated version）。相手 hello 受信で min を採る。
  const state: EngineState = {
    negotiatedVersion: maxVersion,
    ownMaxVersion: maxVersion,
    modeSetInFlight: new Set(),
  };

  const lifecycleAbort = new AbortController();
  const background: Promise<unknown>[] = [];
  const activeChatSession: { name: string | null } = { name: null };
  const lastServerSeq = new Map<string, number>();
  // socket close 時刻ではなく、engine channel へ最後に書き切った会話 event の時刻。
  // Hub 世代変更時の transcript backfill 境界として session ごとに保持する。
  const lastForwardedAtMs = new Map<string, number>();
  let hubBootId: string | null = null;
  // Hub ブロードキャストから作る接続ローカル read-model。
  const processingSessions = new Map<string, number>();
  // フォーカス外でも処理中の会話だけを購読し、一覧表示中のログキャッシュを更新する。
  // Hub 接続単位で上限を設け、異常な processing 通知でも購読を無制限に増やさない。
  const backgroundChatSessions = new Set<string>();
  // preview=false 中に iOS へ route できない event が来た場合、その直前 seq を保持する。
  // 後続 chat/tool を表示できても gap を飛び越えて checkpoint を進めず、前面復帰時に
  // Hub replay から image/subagent を含む連続区間を回収する。
  const backgroundReplayFloors = new Map<string, number>();
  // serverSeq=0 は transcript/rollout の履歴 backfill。完了マーカー前に Hub 世代が
  // 変わった場合は時刻境界を使わず全履歴を再開し、古い未配送行を落とさない。
  const historyBackfillSessions = new Set<string>();
  const backgroundUnwatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const unwatchBackgroundSession = (session: string): void => {
    const timer = backgroundUnwatchTimers.get(session);
    if (timer !== undefined) clearTimeout(timer);
    backgroundUnwatchTimers.delete(session);
    if (!backgroundChatSessions.delete(session)) return;
    if (activeChatSession.name !== session) {
      hubLink.send({ type: "conversation_unsubscribe", session });
    }
  };
  const watchBackgroundSession = (session: string, newerThanMs?: number, subscribe = true): void => {
    const timer = backgroundUnwatchTimers.get(session);
    if (timer !== undefined) clearTimeout(timer);
    backgroundUnwatchTimers.delete(session);
    if (activeChatSession.name === session) return;
    if (!backgroundChatSessions.has(session) && backgroundChatSessions.size >= 16) {
      const oldest = backgroundChatSessions.values().next().value as string | undefined;
      if (oldest !== undefined) unwatchBackgroundSession(oldest);
    }
    backgroundChatSessions.add(session);
    if (!subscribe) return;
    hubLink.send({
      type: "conversation_subscribe",
      session,
      ...(newerThanMs !== undefined
        ? { newerThanMs }
        : lastServerSeq.has(session) ? { afterSeq: lastServerSeq.get(session)! } : {}),
      preview: false,
    });
  };
  const finishWatchingBackgroundSession = (session: string): void => {
    if (activeChatSession.name === session || !backgroundChatSessions.has(session)) return;
    const previous = backgroundUnwatchTimers.get(session);
    if (previous !== undefined) clearTimeout(previous);
    // processing=done と transcript tail の最終 event は別経路なので、短い猶予を置いて
    // 最終 assistant/tool 出力を取りこぼさずキャッシュへ合流させる。
    const timer = setTimeout(() => unwatchBackgroundSession(session), 2_000);
    timer.unref();
    backgroundUnwatchTimers.set(session, timer);
  };
  let codexTurnController: CodexTurnControllerRuntime | null = injectedCodexTurnController;
  let previewServer: PreviewServer | null = null;

  try {
    // ---- 1. channel_hello を送出（確立直後）----
    const helloVersion = staleDistGuard?.startupVersion ?? readPackageVersion() ?? undefined;
    writer.write({
      type: "channel_hello",
      v: PROTOCOL_V1,
      maxVersion,
      ...(helloVersion !== undefined ? { serverVersion: helloVersion } : {}),
    });

    // ---- 1.5 画像 pending を drain し image_available を送出 ----
    if (imageService !== null) {
      for (const message of await imageService.drainPending()) {
        writer.write(message);
      }
    }

    // 設問の解決を iOS へ届ける（前面会話= question_dismiss / 別会話= remote_pending_cleared）。
    const dismissQuestion = (session: string, id: string): void => {
      const wire: ControlMessage =
        session === activeChatSession.name
          ? { type: "question_dismiss", v: PROTOCOL_V1, id }
          : { type: "remote_pending_cleared", v: PROTOCOL_V1, id, session, kind: "question" };
      try {
        writer.write(wire);
      } catch (error) {
        process.stderr.write(`[tailii-host engine] question dismiss 書込失敗: ${String(error)}\n`);
      }
    };

    // 設問イベントの反映（question-hook-relay）。前面会話ならネイティブ設問シート
    // （question_prompt）、別会話なら一覧バッジ（remote_pending kind=question）へ変換する。
    const handleQuestionEvent = (message: QuestionEventMessage): void => {
      if (message.event === "dismiss") {
        dismissQuestion(message.session, message.id);
        return;
      }
      const questions = message.questions ?? [];
      const first = questions[0];
      const wire: ControlMessage =
        message.session === activeChatSession.name
          ? { type: "question_prompt", v: PROTOCOL_V1, id: message.id, questions }
          : {
              type: "remote_pending",
              v: PROTOCOL_V1,
              id: message.id,
              session: message.session,
              kind: "question",
              summary: first?.question || first?.header || "Question prompt",
            };
      try {
        writer.write(wire);
      } catch (error) {
        process.stderr.write(`[tailii-host engine] question prompt 書込失敗: ${String(error)}\n`);
      }
    };

    // Hub ブロードキャストを接続ローカル read-model に反映する。
    const handleSessionProcessing = (message: SessionProcessingMessage): void => {
      const now = Math.floor(Date.now() / 1000);
      if (message.state === "active") {
        processingSessions.set(message.session, now);
        watchBackgroundSession(message.session);
      } else {
        processingSessions.delete(message.session);
        finishWatchingBackgroundSession(message.session);
      }
      writer.write({
        type: "session_processing_state",
        v: state.negotiatedVersion,
        session: message.session,
        active: message.state === "active",
      });
    };

    if (codexTurnController === null && codexAppServer !== null) {
      const writeCodexMarker = (session: string, streamId: string, text: string): void => {
        // chat_output には session ID が無いため、現在開いている会話だけへ流す。
        if (session !== activeChatSession.name) return;
        try {
          writer.write({
            type: "chat_output",
            v: state.negotiatedVersion,
            streamId,
            role: "system",
            text,
            eof: true,
          });
        } catch (error) {
          process.stderr.write(
            `[tailii-host engine] Codex model/context marker 書込失敗: ${String(error)}\n`,
          );
        }
      };
      codexTurnController = new CodexNativeTurnController({
        appServer: codexAppServer,
        onProcessing: (session, processingState) => {
          hubLink.send({
            type: "session_processing",
            session,
            state: processingState,
          });
        },
        onModel: (session, model) => {
          writeCodexMarker(session, CODEX_MODEL_STREAM_ID, model);
        },
        onTokenUsage: (session, totalTokens, contextWindow) => {
          writeCodexMarker(session, CODEX_CONTEXT_STREAM_ID, String(totalTokens));
          if (contextWindow !== null) {
            writeCodexMarker(
              session,
              CODEX_CONTEXT_WINDOW_STREAM_ID,
              String(contextWindow),
            );
          }
        },
        onQuestion: ({ session, id, questions }) => {
          handleQuestionEvent({ type: "question_event", session, event: "prompt", id, questions });
        },
        onQuestionDismiss: (session, id) => {
          handleQuestionEvent({ type: "question_event", session, event: "dismiss", id });
        },
      });
    }

    const rpcWaiters = new Map<string, (message: HubServerMessage) => void>();
    const rpcDisconnectFailures = new Map<string, () => void>();
    hubLink.onMessage = (message) => {
      if (message.type === "hub_hello_ack") return;
      if (message.type === "conversation_event") {
        let payload: ControlMessage | null = null;
        const isActive = message.session === activeChatSession.name;
        if (message.session === activeChatSession.name) {
          payload = message.payload;
        } else if (backgroundChatSessions.has(message.session)) {
          if (message.payload.type === "chat_output") {
            payload = {
              type: "session_chat_output",
              v: state.negotiatedVersion,
              session: message.session,
              serverSeq: message.serverSeq,
              streamId: message.payload.streamId,
              role: message.payload.role,
              text: message.payload.text,
              eof: message.payload.eof,
            };
          } else if (message.payload.type === "tool_activity") {
            payload = {
              type: "session_tool_activity",
              v: state.negotiatedVersion,
              session: message.session,
              serverSeq: message.serverSeq,
              activity: message.payload.activity,
            };
          } else if (!backgroundReplayFloors.has(message.session)) {
            const floor = lastServerSeq.get(message.session) ?? Math.max(0, message.serverSeq - 1);
            backgroundReplayFloors.set(message.session, floor);
            lastServerSeq.set(message.session, floor);
          }
        }
        if (payload === null) return;
        try {
          writer.write(payload);
          if (message.serverSeq === 0) {
            historyBackfillSessions.add(message.session);
            if ((payload.type === "chat_output" || payload.type === "session_chat_output") &&
              payload.streamId === HISTORY_DONE_STREAM_ID) {
              historyBackfillSessions.delete(message.session);
            }
          } else if (message.serverSeq > 0) {
            lastForwardedAtMs.set(message.session, Date.now());
            if (isActive) {
              lastServerSeq.set(message.session, message.serverSeq);
              backgroundReplayFloors.delete(message.session);
            } else if (!backgroundReplayFloors.has(message.session)) {
              lastServerSeq.set(message.session, message.serverSeq);
            }
          }
        }
        catch (error) { process.stderr.write(`[tailii-host engine] conversation_event 書込失敗: ${String(error)}\n`); }
        return;
      }
      if (message.type === "conversation_pane_preview") {
        if (message.session !== activeChatSession.name) return;
        try { writer.write(message.payload); }
        catch (error) { process.stderr.write(`[tailii-host engine] pane_preview 書込失敗: ${String(error)}\n`); }
        return;
      }
      if (message.type === "conversation_mode") {
        // tmux 側で切り替わった permission mode の現況通知（mode_set_response 形式）。
        if (message.session !== activeChatSession.name) return;
        try { writer.write({ ...message.payload, v: state.negotiatedVersion }); }
        catch (error) { process.stderr.write(`[tailii-host engine] mode_push 書込失敗: ${String(error)}\n`); }
        return;
      }
      if (message.type === "hub_state_response" || message.type === "question_answer_result" ||
        message.type === "input_claim_result" || message.type === "runtime_claim_result" ||
        message.type === "codex_turn_result" || message.type === "chat_send_result" ||
        message.type === "presence_response" ||
        message.type === "conversation_subagent_transcript_response") {
        rpcWaiters.get(message.id)?.(message);
        rpcWaiters.delete(message.id);
        rpcDisconnectFailures.delete(message.id);
      } else if (message.type === "session_processing") handleSessionProcessing(message);
      else if (message.type === "question_event") handleQuestionEvent(message);
      else {
        try { writer.write({ ...message, v: state.negotiatedVersion }); }
        catch (error) { process.stderr.write(`[tailii-host engine] remote_pending 書込失敗: ${String(error)}\n`); }
      }
    };
    const hubRpc = <T extends HubServerMessage>(request: HubClientMessage, id: string, timeoutMs: number): Promise<T> =>
      new Promise((resolve, reject) => {
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            rpcWaiters.delete(id);
            rpcDisconnectFailures.delete(id);
            reject(new Error("Session Hub RPC timeout"));
          }, timeoutMs)
          : null;
        rpcWaiters.set(id, (response) => {
          if (timer !== null) clearTimeout(timer);
          rpcDisconnectFailures.delete(id);
          resolve(response as T);
        });
        rpcDisconnectFailures.set(id, () => {
          if (timer !== null) clearTimeout(timer);
          rpcWaiters.delete(id);
          reject(new Error("Session Hub disconnected during RPC"));
        });
        hubLink.send(request);
      });
    hubLink.onReconnect = ({ bootId, disconnectedAtMs, processingSessions: processingSnapshot }) => {
      if (disconnectedAtMs !== null) {
        const failures = [...rpcDisconnectFailures.values()];
        rpcDisconnectFailures.clear();
        for (const fail of failures) fail();
      }
      const restarted = hubBootId !== null && hubBootId !== bootId;
      hubBootId = bootId;
      const requiresFullBackfill = restarted ? new Set(historyBackfillSessions) : new Set<string>();
      if (restarted) {
        // serverSeq は Hub 世代ローカル。現在未購読の会話も含め旧 checkpoint を全破棄し、
        // 後日 open した会話が新世代の同じ数値を誤って afterSeq として使わないようにする。
        lastServerSeq.clear();
        backgroundReplayFloors.clear();
        historyBackfillSessions.clear();
      }
      // hello snapshot を権威状態として扱う。切断中に完了した会話をローカル Map に
      // active のまま残すと、一覧の処理中表示と背景購読が永久に残ってしまう。ただし
      // processingSessions を送らない旧 Hub は「空」ではなく「snapshot 非対応」なので、
      // その場合は既知状態を維持してローリング更新中の誤った inactive 化を避ける。
      if (processingSnapshot !== undefined) {
        const snapshotSet = new Set(processingSnapshot);
        for (const session of [...processingSessions.keys()]) {
          if (snapshotSet.has(session)) continue;
          processingSessions.delete(session);
          finishWatchingBackgroundSession(session);
          writer.write({
            type: "session_processing_state",
            v: state.negotiatedVersion,
            session,
            active: false,
          });
        }
        for (const processingSession of processingSnapshot) {
          processingSessions.set(processingSession, Math.floor(Date.now() / 1_000));
          // この直後の sessions loop が再接続境界を揃えて一度だけ subscribe する。
          watchBackgroundSession(
            processingSession,
            restarted ? disconnectedAtMs ?? undefined : undefined,
            false,
          );
          writer.write({
            type: "session_processing_state",
            v: state.negotiatedVersion,
            session: processingSession,
            active: true,
          });
        }
      }
      const sessions = new Set(backgroundChatSessions);
      if (activeChatSession.name !== null) sessions.add(activeChatSession.name);
      for (const session of sessions) {
        const preview = session === activeChatSession.name;
        if (restarted) {
          // serverSeq は Hub プロセス内の採番なので世代を越えて比較できない。切断時刻以降だけを
          // transcript から backfill し、既表示本文の全履歴再送と停止中の追記欠落をともに避ける。
          // socket close は最後に engine channel へ配送できた event より大幅に遅れて観測され
          // うる。session ごとの最終成功時刻を権威境界にし、tail の書込→転送遅延ぶんだけ5秒
          // 重ねる。まだ一度も配送していない会話だけ close 時刻の1分 rewindへ fallbackする。
          const forwardedAtMs = lastForwardedAtMs.get(session);
          const backfillBoundary = requiresFullBackfill.has(session)
            ? undefined
            : forwardedAtMs !== undefined
              ? Math.max(0, forwardedAtMs - 5_000)
              : disconnectedAtMs !== null ? Math.max(0, disconnectedAtMs - 60_000) : undefined;
          hubLink.send({ type: "conversation_subscribe", session,
            ...(backfillBoundary !== undefined ? { newerThanMs: backfillBoundary } : {}), preview });
        } else {
          hubLink.send({ type: "conversation_subscribe", session,
            ...(lastServerSeq.has(session) ? { afterSeq: lastServerSeq.get(session)! } : {}), preview });
        }
      }
    };
    const requestHubState = (session: string): Promise<{ id: string; questions: QuestionPromptQuestion[] } | null> => {
      const id = randomUUID();
      return new Promise((resolve) => {
        rpcWaiters.set(id, (raw) => {
          const response = raw as Extract<HubServerMessage, { type: "hub_state_response" }>;
          if (response.processing) {
            processingSessions.set(session, Math.floor(Date.now() / 1000));
            watchBackgroundSession(session);
          } else {
            processingSessions.delete(session);
            finishWatchingBackgroundSession(session);
          }
          writer.write({
            type: "session_processing_state",
            v: state.negotiatedVersion,
            session,
            active: response.processing,
          });
          resolve(response.pendingQuestion);
        });
        hubLink.send({ type: "hub_state_request", id, session });
      });
    };
    // remoteQuestionMonitor は起動しない（question-hook-relay で陳腐化）。transcript には
    // 回答済みの設問しか現れなくなったため、monitor が出せるのは「回答直後の
    // remote_pending→cleared の一瞬のバッジ明滅」だけで有害無益。別会話の未回答設問の
    // バッジは hook relay の question_event（handleQuestionEvent）が正しく賄う。

    // ---- 1.6 会話出力 tail を開始し chat_output を engine チャネルへ逐次送出 ----
    if (transcriptTailer !== null && transcriptPath !== null) {
      background.push(
        (async () => {
          for await (const message of transcriptTailer.streamTranscript(
            transcriptPath,
            lifecycleAbort.signal,
          )) {
            if (lifecycleAbort.signal.aborted) break;
            try {
              writer.write(message);
            } catch (error) {
              process.stderr.write(
                `[tailii-host engine] chat_output 書込失敗: ${String(error)}\n`,
              );
              break;
            }
          }
        })(),
      );
    }

    // Web プレビュー: HTML ファイル配信用の loopback 静的サーバー（lazy、open まで待受なし）。
    previewServer = new PreviewServer();

    // ---- 2. 行読み取りループ ----
    engineDiag(`engine readLoop 開始 pid=${process.pid}`);
    const rl = readline.createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of rl) {
        const didProcessMessage = await handleLine(line, {
          writer,
          state,
          sessionManager,
          backendKind,
          backendWriter,
          herdrInstalledProbe,
          imageService,
          launcher,
          codexLauncher,
          sessionListService,
          metadataStore,
          hubLink,
          requestHubState,
          hubRpc,
          codexHubRpcTimeoutMs,
          heartbeatDir: resolvedHeartbeatDir,
          resumeLauncher,
          codexResumeLauncher,
          claudeSessionStore,
          codexSessionStore,
          planUsage,
          homeDir,
          modeTiming: resolvedModeTiming,
          defaultAgent: agent,
          activeChatSession,
          processingSessions,
          backgroundChatSessions,
          lastServerSeq,
          codexAppServer,
          codexTurnController,
          previewServer,
        });
        if (didProcessMessage && isStaleDist(staleDistGuard)) {
          process.stderr.write("[tailii-host engine] stale dist を検出、再起動のため終了\n");
          onStaleDist?.();
          break;
        }
      }
    } finally {
      rl.close();
    }
    engineDiag(`engine readLoop EOF（チャネル断）pid=${process.pid}`);
  } finally {
    // ---- 3. チャネル断で chat_output tail / reaper を確実に停止する（全経路） ----
    lifecycleAbort.abort();
    for (const timer of backgroundUnwatchTimers.values()) clearTimeout(timer);
    backgroundUnwatchTimers.clear();
    hubLink.close();
    codexTurnController?.close();
    await previewServer?.closeAll();
    await Promise.allSettled(background);
  }
}

// MARK: - 1 行の処理

interface EngineState {
  negotiatedVersion: number;
  ownMaxVersion: number;
  modeSetInFlight: Set<string>;
}

interface HandlerContext {
  writer: LineWriter;
  state: EngineState;
  sessionManager: SessionBackend;
  /** 新規セッションの端末バックエンド解決子（launch 毎に読む）。 */
  backendKind: () => SessionBackendKind;
  /** backend_set の永続化先。 */
  backendWriter: (kind: SessionBackendKind) => void;
  /** herdr 導入済み判定。 */
  herdrInstalledProbe: () => boolean;
  imageService: ImageService | null;
  launcher: EngineLauncher | null;
  /** codex セッション用 launcher（session_start の agentType=codex 時に使用）。 */
  codexLauncher: EngineLauncher | null;
  sessionListService: SessionListService | null;
  metadataStore: SessionMetadataStore | null;
  hubLink: HubLink;
  requestHubState: (session: string) => Promise<{ id: string; questions: QuestionPromptQuestion[] } | null>;
  hubRpc: <T extends HubServerMessage>(request: HubClientMessage, id: string, timeoutMs: number) => Promise<T>;
  codexHubRpcTimeoutMs: number;
  heartbeatDir: string;
  resumeLauncher: EngineLauncher | null;
  /** codex セッションの reattach 時 resume 用 launcher。 */
  codexResumeLauncher: EngineLauncher | null;
  claudeSessionStore: ClaudeSessionStore | null;
  /** codex 会話一覧の導出（agent-tag）。 */
  codexSessionStore: CodexSessionStore | null;
  planUsage: PlanUsageProvider;
  homeDir: string;
  modeTiming: ModeTiming;
  /** host 側の既定エージェント（session_start が agentType を指定しないときのフォールバック）。 */
  defaultAgent: ChatAgent;
  activeChatSession: { name: string | null };
  /** 処理中セッションの最終ハートビート（Unix 秒）。明示 kill 時に掃除する。 */
  processingSessions: Map<string, number>;
  /** 一覧・別画面でも差分同期を続けるフォーカス外会話。 */
  backgroundChatSessions: Set<string>;
  /** Hub 世代内で iOS へ連続配送済みの最後の conversation seq。 */
  lastServerSeq: Map<string, number>;
  /** Codex モデル一覧を取得する共有 App Server。 */
  codexAppServer: CodexAppServerManager | null;
  /** Codex native turn/approval 接続。 */
  codexTurnController: CodexTurnControllerRuntime | null;
  /** Web プレビュー用 loopback 静的ファイルサーバー。 */
  previewServer: PreviewServer;
}

/**
 * chat オープン/再オープン時、そのセッションに未回答の設問があれば question_prompt を再送する。
 * 未回答の間 transcript に tool_use 行が無く履歴再生では設問が復元されないため、engine の
 * 保持分から再掲する（question-hook-relay）。
 */
async function emitPendingQuestion(ctx: HandlerContext, session: string): Promise<void> {
  const pending = await ctx.requestHubState(session);
  if (pending === null) return;
  ctx.writer.write({
    type: "question_prompt",
    v: PROTOCOL_V1,
    id: pending.id,
    questions: pending.questions,
  });
}

function subscribeConversation(ctx: HandlerContext, session: string, newerThanMs?: number): void {
  const previous = ctx.activeChatSession.name;
  if (previous !== null && previous !== session) {
    if (ctx.processingSessions.has(previous)) {
      ctx.backgroundChatSessions.add(previous);
      ctx.hubLink.send({ type: "conversation_subscribe", session: previous, preview: false });
    } else {
      ctx.backgroundChatSessions.delete(previous);
      ctx.hubLink.send({ type: "conversation_unsubscribe", session: previous });
    }
  }
  ctx.activeChatSession.name = session;
  ctx.backgroundChatSessions.delete(session);
  ctx.hubLink.send({ type: "conversation_subscribe", session,
    ...(newerThanMs !== undefined
      ? { newerThanMs }
      : ctx.lastServerSeq.has(session) ? { afterSeq: ctx.lastServerSeq.get(session)! } : {}),
    preview: true });
}

/** prepare 中は購読を始めず、reaper が読む権威ファイルの idle deadline だけを即時に更新する。 */
function touchPreparedSession(ctx: HandlerContext, session: string): boolean {
  try {
    bumpHeartbeat(ctx.heartbeatDir, session, Date.now() / 1_000, "session-prepare");
    return true;
  } catch {
    // heartbeat を更新できないまま成功 ack を返すと、直後の reaper tick による kill を
    // クライアントが防げない。prepare 自体を構造化エラーとして失敗させる。
    return false;
  }
}

/** 通常オープンは購読を開始し、prepare は購読せず heartbeat だけを保護する。 */
async function activateOrTouchSession(
  ctx: HandlerContext,
  writer: LineWriter,
  version: number,
  requestId: string,
  session: string,
  shouldSubscribe: boolean,
  newerThanMs?: number,
): Promise<boolean> {
  if (shouldSubscribe) {
    subscribeConversation(ctx, session, newerThanMs);
    await emitPendingQuestion(ctx, session);
    return true;
  }
  if (touchPreparedSession(ctx, session)) return true;
  writeError(writer, version, requestId, "session_prepare_heartbeat_failed",
    "セッションの保護時刻を更新できませんでした。");
  return false;
}

async function claimRuntime(ctx: HandlerContext, session: string): Promise<"granted" | "held"> {
  const id = randomUUID();
  try {
    const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "runtime_claim_result" }>>(
      { type: "runtime_claim", id, session }, id, 1_500,
    );
    return result.status;
  } catch {
    // Hub 障害時は可用性を優先し、排他導入前と同じく engine 自身で起動を続行する。
    return "granted";
  }
}

async function waitForLiveSession(
  sessionManager: SessionBackend, predicate: (info: SessionInfo) => boolean,
): Promise<SessionInfo | null> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const found = (await sessionManager.list()).find((info) => info.alive && predicate(info));
    if (found !== undefined) return found;
    await sleep(500);
  }
  return null;
}

/** 1行（改行なし）をデコードし、メッセージ種別ごとに処理する。decode 失敗は破棄。 */
async function handleLine(rawLine: string, ctx: HandlerContext): Promise<boolean> {
  const trimmed = rawLine.replaceAll("\r", "");
  if (!trimmed) return false;

  let message: ControlMessage;
  try {
    message = decodeControlMessage(trimmed);
  } catch (error) {
    // 破棄（不正 JSON / 未知 type / 非対応版 / 必須欠落）。承認文脈でないので無視。
    engineDiag(
      `engine decode 失敗（行破棄）: ${String(error)} 生=${trimmed.slice(0, 120)}`,
    );
    process.stderr.write(`[tailii-host engine] decode 失敗、行破棄: ${String(error)}\n`);
    return false;
  }
  engineDiag(`engine 受信 type=${message.type}`);

  const { writer, state, sessionManager, metadataStore } = ctx;
  const v = state.negotiatedVersion;

  switch (message.type) {
    case "channel_hello": {
      // 採用版 = min(自分の maxVersion, 相手の maxVersion)（4.3）。
      state.negotiatedVersion = Math.min(state.ownMaxVersion, message.maxVersion);
      process.stderr.write(
        `[tailii-host engine] channel_hello negotiated v=${state.negotiatedVersion}\n`,
      );
      break;
    }

    case "session_list_request": {
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
      break;
    }

    case "session_reattach": {
      // 再アクティブ化（heartbeat 更新 = アイドル計時リセット）→ 生存なら即 reattach /
      // メタあり tmux 不在は記録 cwd で resume 再起動 → attached / メタ無しは従来の not_found。
      try {
        const result = await sessionManager.reattach(message.name);
        if (result.kind === "attached") {
          writeSessionListResponse(writer, v, message.id, [result.info], null);
          const meta = metadataStore?.get(message.name) ?? null;
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
              break;
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
              const info: SessionInfo = {
                name: message.name,
                cwd: meta.cwd,
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
      break;
    }

    case "session_kill": {
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
      break;
    }

    case "codex_model_list_request": {
      if (ctx.codexAppServer === null) {
        writeError(
          writer,
          v,
          message.id,
          "codex_app_server_unavailable",
          "Codex App Server が未構成です。",
        );
        break;
      }
      try {
        const models = await ctx.codexAppServer.listModels();
        writer.write({ type: "codex_model_list_response", v, id: message.id, models });
      } catch (error) {
        writeError(writer, v, message.id, "codex_model_list_failed", String(error));
      }
      break;
    }

    case "codex_turn_start": {
      const meta = metadataStore?.get(message.session) ?? null;
      const providerSessionId = meta?.providerSessionId ?? null;
      if (meta?.agent !== "codex" || providerSessionId === null) {
        writeError(
          writer,
          v,
          message.id,
          "codex_thread_not_found",
          `Codex App Server thread がセッション '${message.session}' に束縛されていません。`,
        );
        break;
      }
      try {
        try {
          const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "codex_turn_result" }>>(
            { type: "codex_turn_submit", id: message.id, session: message.session,
              text: message.text, clientUserMessageId: message.clientUserMessageId ?? message.id,
              effort: message.effort ?? null,
              approvalPolicy: message.approvalPolicy ?? null,
              sandbox: message.sandbox ?? null,
              threadId: providerSessionId, cwd: meta.cwd,
              ...(message.explicitRetry === true ? { explicitRetry: true } : {}) },
            message.id, ctx.codexHubRpcTimeoutMs,
          );
          writer.write({
            type: "codex_turn_start_result",
            v,
            id: result.id,
            status: result.status,
            ...(result.error !== undefined ? { error: result.error } : {}),
          });
          break;
        } catch (error) {
          // timeout は「未開始」と「開始済みだが ACK 消失」を区別できない。local controller
          // へ fail-open すると後者で二重 turn になるため、相関可能な failed を返して
          // durable outbox の同一 clientUserMessageId 再送へ委ねる。
          writer.write({
            type: "codex_turn_start_result",
            v,
            id: message.id,
            status: "failed",
            error: String(error),
          });
          break;
        }
      } catch (error) {
        writer.write({
          type: "codex_turn_start_result",
          v,
          id: message.id,
          status: "failed",
          error: String(error),
        });
      }
      break;
    }

    case "chat_send": {
      const meta = metadataStore?.get(message.session) ?? null;
      if (meta?.agent === "codex") {
        writeError(writer, v, message.id, "chat_send_unsupported", "Codex セッションは codex_turn_start を使用してください。");
        break;
      }
      // Hub は設問表示中、durable queue を保持したまま pane 注入可能になるまで応答を
      // 保留する。read loop 自体がこの RPC を await すると、後続 question_answer を読めず
      // 循環待ちになるため相関処理だけを非同期化する。ACK は注入完了の意味を維持する。
      void (async () => {
        try {
          const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "chat_send_result" }>>(
            { type: "chat_send", id: message.id, session: message.session,
              clientMessageId: message.clientMessageId, text: message.text,
              ...(message.explicitRetry === true ? { explicitRetry: true } : {}) }, message.id, 0,
          );
          writer.write({ type: "chat_send_result", v, id: result.id, status: result.status,
            ...(result.error !== undefined ? { error: result.error } : {}) });
        } catch (error) {
          writeError(writer, v, message.id, "chat_send_failed", String(error));
        }
      })();
      break;
    }

    case "codex_turn_interrupt": {
      const meta = metadataStore?.get(message.session) ?? null;
      const providerSessionId = meta?.providerSessionId ?? null;
      if (meta?.agent !== "codex" || providerSessionId === null) {
        writeError(
          writer,
          v,
          message.id,
          "codex_thread_not_found",
          `Codex App Server thread がセッション '${message.session}' に束縛されていません。`,
        );
        break;
      }
      // hub 所有 turn への fire-and-forget 中断。切断中は hubClient が破棄する。
      // 中断を再接続後まで queue すると、その時点の別 turn を誤って止めるため遅延配送しない。
      ctx.hubLink.send({
        type: "codex_turn_interrupt",
        id: message.id,
        session: message.session,
      });
      // 埋め込み Hub / 旧構成との互換用に、注入されたローカル controller にも試みる。
      // 現行の hub 所有構成では turn 未所有なので no-op。
      try {
        await ctx.codexTurnController?.interruptTurn?.(message.session);
      } catch (error) {
        writeError(writer, v, message.id, "codex_turn_interrupt_failed", String(error));
      }
      break;
    }

    case "session_idle_hint": {
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
      break;
    }

    case "session_start": {
      // session_start → launch() 結線。agentType でセッション毎に claude/codex を選ぶ
      //（未指定は host 既定 defaultAgent）。codex は agentType=codex 時の専用 launcher を使う。
      const sessionAgent: ChatAgent = message.agentType ?? ctx.defaultAgent;
      // claude 新規起動でモデル/permission mode 指定があれば、その flags（--model /
      // --permission-mode）を持つ launcher をその場で組む（起動前選択の反映）。
      // resume は元セッションの設定を継ぐため既定 launcher を使う。
      const perSessionClaudeLauncher =
        sessionAgent === "claude" &&
        message.resumeSessionId === undefined &&
        (message.model !== undefined || message.permissionMode !== undefined)
          ? makeSessionLauncher({
              ...(ctx.metadataStore !== null && { store: ctx.metadataStore }),
              agent: "claude",
              backend: ctx.backendKind,
              innerCommand: claudeInnerCommand({
                model: message.model ?? null,
                permissionMode: message.permissionMode ?? null,
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
          )) break;
          writeSessionListResponse(
            writer, v, message.id, shouldSubscribe ? aliases : [], null, liveAlias.name,
          );
          break;
        }
      }
      if (chosenLauncher === null) {
        // 未注入（テスト構成漏れ等）: 安全側 — 実起動せず構造化 error を返す。
        process.stderr.write("[tailii-host engine] session_start: launcher 未構成\n");
        writeError(writer, v, message.id, "launch_failed", "launch 機能が構成されていません。");
        break;
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
          )) break;
          if (shouldSubscribe) {
            try { writeSessionListResponse(writer, v, message.id, await sessionManager.list(), null, appeared.name); }
            catch { writeSessionListResponse(writer, v, message.id, [appeared], null, appeared.name); }
          } else {
            writeSessionListResponse(writer, v, message.id, [], null, appeared.name);
          }
        } else {
          writeError(writer, v, message.id, "launch_failed", "他の接続による会話の起動を確認できませんでした。");
        }
        break;
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
        )) break;
        // 成功: 現況一覧で応答する（kill と同じ疎通様式）。
        if (!shouldSubscribe) {
          writeSessionListResponse(writer, v, message.id, [], null, message.name);
          break;
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
      break;
    }

    case "usage_request": {
      // 開いている会話が codex なら常に codex 集計で応答する（rate_limits を含む, codex-input）。
      // 分岐は「rollout が解決済みか」ではなく「tail 中の会話が codex か」で行う。rollout 未解決でも
      // Claude の OAuth プラン使用量 API へは絶対に落とさない（codex 会話に Claude の状態が出る不具合
      // の防止, 2026-07-07 ユーザー指摘）。codex は OAuth プラン使用量非対応なので planUsage は使わない。
      const tailAgent = ctx.activeChatSession.name === null
        ? ctx.defaultAgent
        : metadataStore?.get(ctx.activeChatSession.name)?.agent ?? ctx.defaultAgent;
      if (tailAgent === "codex") {
        const currentMeta = ctx.activeChatSession.name === null ? null : metadataStore?.get(ctx.activeChatSession.name) ?? null;
        const codexRollout = currentMeta === null ? null : new CodexRolloutTailer().resolve(
          currentMeta.cwd, null, currentMeta.providerSessionId ?? null,
        );
        // rollout 未解決（起動直後等）は空集計で返す。Claude 分岐へは落とさない。
        const cu: CodexUsage =
          codexRollout !== null ? aggregateCodexUsage(codexRollout) : { ...emptyUsageTotals() };
        try {
          writer.write({
            type: "usage_response",
            v,
            id: message.id,
            inputTokens: cu.inputTokens,
            outputTokens: cu.outputTokens,
            cacheReadTokens: cu.cacheReadTokens,
            cacheCreationTokens: cu.cacheCreationTokens,
            turns: cu.turns,
            ...(cu.fiveHourUtilization !== undefined && { fiveHourUtilization: cu.fiveHourUtilization }),
            ...(cu.fiveHourResetsAt !== undefined && { fiveHourResetsAt: cu.fiveHourResetsAt }),
            ...(cu.sevenDayUtilization !== undefined && { sevenDayUtilization: cu.sevenDayUtilization }),
            ...(cu.sevenDayResetsAt !== undefined && { sevenDayResetsAt: cu.sevenDayResetsAt }),
          });
        } catch {
          // 書込失敗は握り潰す。
        }
        break;
      }
      // 使用量（claude）: プラン使用率（OAuth 使用量 API, ベストエフォート）+ tail 中会話の usage 合算。
      const currentMeta = ctx.activeChatSession.name === null ? null : metadataStore?.get(ctx.activeChatSession.name) ?? null;
      const transcript = currentMeta === null ? null : TranscriptTailer.resolveJsonl(
        path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(currentMeta.cwd)),
        currentMeta.providerSessionId ?? currentMeta.claudeSessionId ?? null,
        null,
      );
      const totals = transcript !== null ? aggregateUsage(transcript) : emptyUsageTotals();
      const plan = await ctx.planUsage();
      try {
        writer.write({
          type: "usage_response",
          v,
          id: message.id,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheCreationTokens: totals.cacheCreationTokens,
          turns: totals.turns,
          ...(plan?.fiveHourUtilization != null && { fiveHourUtilization: plan.fiveHourUtilization }),
          ...(plan?.fiveHourResetsAt != null && { fiveHourResetsAt: plan.fiveHourResetsAt }),
          ...(plan?.sevenDayUtilization != null && { sevenDayUtilization: plan.sevenDayUtilization }),
          ...(plan?.sevenDayResetsAt != null && { sevenDayResetsAt: plan.sevenDayResetsAt }),
          ...(plan?.sevenDayFableUtilization != null && {
            sevenDayFableUtilization: plan.sevenDayFableUtilization,
          }),
          ...(plan?.sevenDayFableResetsAt != null && {
            sevenDayFableResetsAt: plan.sevenDayFableResetsAt,
          }),
        });
      } catch {
        // 書込失敗は握り潰す（Swift 版 try? と同じ）。
      }
      break;
    }

    case "question_answer": {
      try {
        const requestId = randomUUID();
        const result = await ctx.hubRpc<Extract<HubServerMessage, { type: "question_answer_result" }>>(
          { type: "question_answer_submit", id: requestId, session: message.session,
            questionId: message.id, answers: message.answers }, requestId, 2_000,
        );
        if (result.status === "accepted") {
          writer.write({ type: "remote_pending_cleared", v, id: message.id,
            session: message.session, kind: "question" });
        } else {
          writeError(writer, v, message.id, "question_answer_failed", "この設問は既に回答済みです。");
        }
      } catch (error) {
        writeError(writer, v, message.id, "question_answer_failed", String(error));
      }
      break;
    }

    case "mode_get": {
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
      break;
    }

    case "mode_set": {
      // mode_set は dialog 待ちが長くなり得るため、read loop を塞がず detached で処理する。
      if (state.modeSetInFlight.has(message.session)) {
        writeError(writer, v, message.id, "mode_set_busy", "mode_set が実行中です。");
        break;
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
      break;
    }

    case "slash_list_request": {
      // セッション/プロジェクト由来の slash command 候補をベストエフォートで収集する。
      const commands = collectSlashCommands(ctx.homeDir, message.cwd);
      try {
        writer.write({ type: "slash_list_response", v, id: message.id, commands });
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] slash_list_response 書込失敗: ${String(error)}\n`,
        );
      }
      break;
    }

    case "image_fetch_request": {
      // 原本オンデマンド分割配信。index 逆引きし、分割 image_fetch_response を順に書く。
      if (ctx.imageService === null) {
        // 未注入時は画像を扱わない（後方互換）。要求元が沈黙で待たないよう error を返す。
        writeError(writer, v, message.id, "image_not_found", "画像機能は無効です。");
        break;
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
      break;
    }

    case "subagent_transcript_request": {
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
      break;
    }

    case "dir_list_request": {
      // ディレクトリ候補問い合わせ。base 外・不正・一致なしは空 entries（エラーにしない）。
      const entries = dirList(message.baseDir, message.partial);
      try {
        writer.write({ type: "dir_list_response", v, id: message.id, entries });
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] dir_list_response 書込失敗: ${String(error)}\n`,
        );
      }
      break;
    }

    case "browse_request": {
      // ディレクトリ非限定ブラウズ。不存在・読取不能は空 entries（エラーにしない）。
      engineDiag(`browse_request id=${message.id} path=${message.path}`);
      const entries = dirChildren(message.path);
      try {
        writer.write({ type: "browse_response", v, id: message.id, path: message.path, entries });
        engineDiag(`browse_response id=${message.id} entries=${entries.length}`);
      } catch (error) {
        engineDiag(`browse_response 書込失敗 id=${message.id}: ${String(error)}`);
        process.stderr.write(
          `[tailii-host engine] browse_response 書込失敗: ${String(error)}\n`,
        );
      }
      break;
    }

    case "file_list_request": {
      engineDiag(`file_list_request id=${message.id} path=${message.path}`);
      try {
        const response = fileList(message.path);
        let statuses = new Map<string, string>();
        try {
          statuses = await gitEntryStatuses(
            message.path,
            response.entries.map((entry) => entry.name),
          );
        } catch (error) {
          engineDiag(`file_list gitStatus badge 取得失敗 id=${message.id}: ${String(error)}`);
        }
        const entries = response.entries.map((entry) => {
          const gitStatus = statuses.get(entry.name);
          return gitStatus === undefined ? entry : { ...entry, gitStatus };
        });
        writer.write({ type: "file_list_response", v, id: message.id, ...response, entries });
      } catch (error) {
        engineDiag(`file_list_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({
          type: "file_list_response", v, id: message.id, path: message.path,
          entries: [], truncated: false,
        });
      }
      break;
    }

    case "file_read_request": {
      engineDiag(`file_read_request id=${message.id} path=${message.path}`);
      try {
        const response = await fileRead(message.path);
        writer.write({ type: "file_read_response", v, id: message.id, ...response });
      } catch (error) {
        writer.write({
          type: "file_read_response", v, id: message.id, path: message.path,
          kind: "error", size: 0, mtimeMs: 0, error: String(error),
        });
      }
      break;
    }

    case "git_status_request": {
      engineDiag(`git_status_request id=${message.id} path=${message.path}`);
      try {
        writer.write({ type: "git_status_response", v, id: message.id, ...await gitStatus(message.path) });
      } catch (error) {
        engineDiag(`git_status_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({
          type: "git_status_response", v, id: message.id, isRepo: false,
          branch: "", upstream: null, ahead: 0, behind: 0, files: [],
        });
      }
      break;
    }

    case "git_diff_request": {
      try {
        const response = await gitDiff(message.path, {
          file: message.file, staged: message.staged, commit: message.commit,
        });
        writer.write({ type: "git_diff_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_diff_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "git_diff_response", v, id: message.id, isRepo: false, diff: "", truncated: false });
      }
      break;
    }

    case "git_log_request": {
      try {
        const response = await gitLog(message.path, message.limit);
        writer.write({ type: "git_log_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_log_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "git_log_response", v, id: message.id, isRepo: false, commits: [] });
      }
      break;
    }

    case "git_branch_list_request": {
      try {
        const response = await gitBranchList(message.path);
        writer.write({ type: "git_branch_list_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_branch_list_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "git_branch_list_response", v, id: message.id, isRepo: false, branches: [] });
      }
      break;
    }

    case "git_checkout_request": {
      try {
        const response = await gitCheckout(message.path, message.branch, message.create);
        writer.write({ type: "git_checkout_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_checkout_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({
          type: "git_checkout_response", v, id: message.id,
          ok: false, branch: message.branch, error: String(error),
        });
      }
      break;
    }

    case "git_discard_request": {
      try {
        const response = await gitDiscard(message.path, message.files);
        writer.write({ type: "git_discard_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_discard_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "git_discard_response", v, id: message.id, ok: false, error: String(error) });
      }
      break;
    }

    case "git_init_request": {
      try {
        const response = await gitInit(message.path);
        writer.write({ type: "git_init_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_init_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "git_init_response", v, id: message.id, ok: false, error: String(error) });
      }
      break;
    }

    case "git_worktree_create_request": {
      try {
        const response = await gitWorktreeCreate(message.path, message.baseBranch);
        writer.write({ type: "git_worktree_create_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_worktree_create_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({
          type: "git_worktree_create_response", v, id: message.id,
          ok: false, branch: "", worktreePath: "", error: String(error),
        });
      }
      break;
    }

    case "git_worktree_remove_request": {
      try {
        const response = await gitWorktreeRemove(message.path, message.force);
        writer.write({ type: "git_worktree_remove_response", v, id: message.id, ...response });
      } catch (error) {
        engineDiag(`git_worktree_remove_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "git_worktree_remove_response", v, id: message.id, ok: false, error: String(error) });
      }
      break;
    }

    case "claude_session_list_request": {
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
      engineDiag(
        `claude_session_list_response id=${message.id} count=${sessions.length}`,
      );
      try {
        writer.write({
          type: "claude_session_list_response", v, id: message.id, claudeSessions: sessions,
        });
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] claude_session_list_response 書込失敗: ${String(error)}\n`,
        );
      }
      break;
    }

    case "session_search_request": {
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
      break;
    }

    case "dir_create_request": {
      // ディレクトリ作成。base 外/`..` 脱出は ok=false。
      const result = dirCreate(message.baseDir, message.relative);
      try {
        writer.write({
          type: "dir_create_response", v, id: message.id, path: result.path, ok: result.ok,
        });
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] dir_create_response 書込失敗: ${String(error)}\n`,
        );
      }
      break;
    }

    case "preview_open": {
      // Web プレビュー: HTML ファイルの loopback 静的配信を開始し、到達 URL を返す。
      // iOS はこの URL の port へ direct-tcpip トンネルを張って開く。
      try {
        const { url } = await ctx.previewServer.open(message.id, message.target);
        writer.write({ type: "preview_ready", v, id: message.id, url });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          writer.write({ type: "preview_error", v, id: message.id, message: detail });
        } catch (writeError) {
          process.stderr.write(
            `[tailii-host engine] preview_error 書込失敗: ${String(writeError)}\n`,
          );
        }
      }
      break;
    }

    case "preview_close": {
      await ctx.previewServer.close(message.id);
      break;
    }

    case "serve_list_request": {
      // Mac 上で LISTEN 中の開発サーバー一覧（serve-list）。engine 自身
      // （previewServer の loopback 静的サーバー含む）は除外する。
      engineDiag(`serve_list_request id=${message.id}`);
      try {
        const servers = await listServeProcesses({ excludePids: [process.pid], withTitles: true });
        writer.write({ type: "serve_list_response", v, id: message.id, servers });
      } catch (error) {
        engineDiag(`serve_list_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "serve_list_response", v, id: message.id, servers: [] });
      }
      break;
    }

    case "serve_stop_request": {
      // 開発サーバーの停止。pid+port の現在照合つき（pid 再利用の誤爆防止）。
      engineDiag(`serve_stop_request id=${message.id} pid=${message.pid} port=${message.port}`);
      try {
        const result = await stopServeProcess(message.pid, message.port);
        writer.write({ type: "serve_stop_response", v, id: message.id, ...result });
      } catch (error) {
        engineDiag(`serve_stop_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({ type: "serve_stop_response", v, id: message.id, ok: false, error: String(error) });
      }
      break;
    }

    case "backend_get_request": {
      // 端末バックエンド設定の読み取り（アプリ設定画面, session-backend）。
      engineDiag(`backend_get_request id=${message.id}`);
      writer.write({
        type: "backend_get_response",
        v,
        id: message.id,
        backend: ctx.backendKind(),
        herdrInstalled: ctx.herdrInstalledProbe(),
      });
      break;
    }

    case "backend_set_request": {
      // 端末バックエンド設定の書き込み。稼働系は常時 Composite なので再起動不要、
      // 「次に起動するセッション」から反映される。herdr 未導入時は書かずに失敗を返す。
      engineDiag(`backend_set_request id=${message.id} backend=${message.backend}`);
      if (message.backend === "herdr" && !ctx.herdrInstalledProbe()) {
        writer.write({
          type: "backend_set_response",
          v,
          id: message.id,
          ok: false,
          backend: ctx.backendKind(),
          error: "herdr が見つかりません（~/.local/bin/herdr）。導入後に切り替えてください。",
        });
        break;
      }
      try {
        ctx.backendWriter(message.backend);
        writer.write({
          type: "backend_set_response",
          v,
          id: message.id,
          ok: true,
          backend: message.backend,
          error: null,
        });
      } catch (error) {
        engineDiag(`backend_set_response 失敗 id=${message.id}: ${String(error)}`);
        writer.write({
          type: "backend_set_response",
          v,
          id: message.id,
          ok: false,
          backend: ctx.backendKind(),
          error: String(error),
        });
      }
      break;
    }

    default:
      // 承認2型・画像・chat_output などは engine 制御では処理しない（本タスク範囲外）。破棄。
      break;
  }
  return true;
}

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

interface SlashCandidate {
  command: SlashCommandInfo;
  priority: number;
}

/** slash_list_request 用に、ユーザー/プロジェクト/プラグインの skills と commands を収集する。 */
function collectSlashCommands(homeDir: string, cwd?: string): SlashCommandInfo[] {
  const byName = new Map<string, SlashCandidate>();
  const userClaude = path.join(homeDir, ".claude");
  const projectClaude = cwd === undefined ? null : path.join(cwd, ".claude");

  scanPluginCommands(userClaude, byName);
  scanSkillCommands(path.join(userClaude, "skills"), 2, byName);
  if (projectClaude !== null) scanSkillCommands(path.join(projectClaude, "skills"), 4, byName);
  scanMarkdownCommands(path.join(userClaude, "commands"), 1, byName);
  if (projectClaude !== null) scanMarkdownCommands(path.join(projectClaude, "commands"), 3, byName);

  return [...byName.values()]
    .map((entry) => entry.command)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

/** installed_plugins.json に登録されたプラグインの skills/commands を `/plugin:name` として読む。 */
function scanPluginCommands(claudeDir: string, byName: Map<string, SlashCandidate>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(claudeDir, "plugins", "installed_plugins.json"), "utf8"),
    );
  } catch {
    return;
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return;
  const disabled = readDisabledPlugins(claudeDir);
  for (const [key, installs] of Object.entries(plugins)) {
    if (disabled.has(key)) continue;
    const pluginName = key.split("@")[0] ?? "";
    if (pluginName === "" || !Array.isArray(installs)) continue;
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath !== "string") continue;
      scanSkillCommands(path.join(installPath, "skills"), 0, byName, `${pluginName}:`);
      scanMarkdownCommands(path.join(installPath, "commands"), 0, byName, `${pluginName}:`);
    }
  }
}

/** ~/.claude/settings.json の enabledPlugins で明示的に false のプラグインキー集合。 */
function readDisabledPlugins(claudeDir: string): Set<string> {
  const disabled = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  } catch {
    return disabled;
  }
  const enabled = (parsed as { enabledPlugins?: unknown } | null)?.enabledPlugins;
  if (typeof enabled !== "object" || enabled === null) return disabled;
  for (const [key, value] of Object.entries(enabled)) {
    if (value === false) disabled.add(key);
  }
  return disabled;
}

/** ~/.claude/skills/<name>/SKILL.md 形式のコマンド候補を読む（namePrefix はプラグイン名前空間用）。 */
function scanSkillCommands(
  root: string,
  priority: number,
  byName: Map<string, SlashCandidate>,
  namePrefix = "",
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const skillDir = path.join(root, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = fs.statSync(skillDir).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) continue;
    addSlashCandidate(
      byName,
      `/${namePrefix}${entry.name}`,
      path.join(skillDir, "SKILL.md"),
      priority,
    );
  }
}

/** ~/.claude/commands/<name>.md 形式のコマンド候補を読む（namePrefix はプラグイン名前空間用）。 */
function scanMarkdownCommands(
  root: string,
  priority: number,
  byName: Map<string, SlashCandidate>,
  namePrefix = "",
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    let isFile = entry.isFile();
    if (!isFile && entry.isSymbolicLink()) {
      try {
        isFile = fs.statSync(filePath).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!isFile) continue;
    addSlashCandidate(byName, `/${namePrefix}${entry.name.slice(0, -3)}`, filePath, priority);
  }
}

/** 既存候補より優先度が高いときだけ登録する（project 優先、同 scope では skills 優先）。 */
function addSlashCandidate(
  byName: Map<string, SlashCandidate>,
  name: string,
  filePath: string,
  priority: number,
): void {
  const existing = byName.get(name);
  if (existing !== undefined && existing.priority >= priority) return;
  byName.set(name, { priority, command: { name, summary: readMarkdownSummary(filePath) } });
}

/** YAML frontmatter の description 1 行だけを素朴に抜き出す。 */
function readMarkdownSummary(filePath: string): string {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return "";
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "---") break;
    const match = /^description:\s*(.*)$/.exec(line);
    if (match !== null) {
      return stripYamlQuotes(match[1] ?? "").slice(0, 120);
    }
  }
  return "";
}

/** description: "..." / '...' の外側だけ外す。 */
function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** session_list_response を書き出す（optional cursor / host 採用名は null なら省略）。 */
interface WorktreeResponseFields {
  worktreePath: string;
  worktreeRemoved?: boolean;
  worktreeDirty?: boolean;
}

function writeSessionListResponse(
  writer: LineWriter,
  v: number,
  id: string,
  sessions: SessionInfo[],
  nextCursor: string | null,
  adoptedName: string | null = null,
  worktree: WorktreeResponseFields | null = null,
): void {
  writer.write({
    type: "session_list_response",
    v,
    id,
    sessions,
    ...(nextCursor !== null && { nextCursor }),
    ...(adoptedName !== null && { adoptedName }),
    ...(worktree !== null && worktree),
  });
}

/** error 封筒を書き出す小ヘルパー。 */
function writeError(
  writer: LineWriter,
  v: number,
  id: string | undefined,
  code: string,
  message: string,
): void {
  try {
    writer.write({ type: "error", v, ...(id !== undefined && { id }), code, message });
  } catch (error) {
    process.stderr.write(`[tailii-host engine] error 送出失敗: ${String(error)}\n`);
  }
}
