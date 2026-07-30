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
import type { ChatAgent } from "../chat/chatTailController.js";
import {
  CodexRolloutTailer,
  CONTEXT_STREAM_ID as CODEX_CONTEXT_STREAM_ID,
  CONTEXT_WINDOW_STREAM_ID as CODEX_CONTEXT_WINDOW_STREAM_ID,
  MODEL_STREAM_ID as CODEX_MODEL_STREAM_ID,
} from "../codex/codexRolloutTailer.js";
import { CodexAppServerManager } from "../codex/codexAppServer.js";
import {
  CodexNativeTurnController,
  type CodexTurnControllerRuntime,
} from "../codex/codexNativeTurnController.js";
import { ClaudeSessionStore } from "../sessions/claudeSessionStore.js";
import { CodexSessionStore } from "../codex/codexSessionStore.js";
import { ensureHubDaemon } from "../hub/hubDaemon.js";
import { connectHubSocket, type HubLink } from "../hub/hubClient.js";
import type { HubClientMessage, HubServerMessage } from "../hub/hubProtocol.js";
import { defaultHeartbeatDir } from "../sessions/heartbeat.js";
import { ImageService } from "../chat/imageService.js";
import type { QuestionEventMessage, SessionProcessingMessage } from "../hub/engineRelaySocket.js";
import { makeSessionLauncher, type EngineLauncher } from "../commands/launch.js";
import { LineWriter } from "../shared/lineWriter.js";
import { fetchClaudeModelList, type ClaudeModelListProvider } from "../services/claudeModelCatalog.js";
import { fetchPlanUsage, type PlanUsageProvider } from "../services/planUsageFetcher.js";
import { PreviewServer } from "../services/previewServer.js";
import {
  decodeControlMessage,
  PROTOCOL_MAX_SUPPORTED,
  PROTOCOL_V1,
  type ControlMessage,
  type QuestionPromptQuestion,
} from "../protocol.js";
import { ownTranscriptActivityProvider } from "../sessions/sessionActivityProvider.js";
import { SessionListService } from "../sessions/sessionListService.js";
import { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import { OfficialAppsService } from "../services/officialApps.js";
import { HISTORY_DONE_STREAM_ID, TranscriptTailer } from "../chat/transcriptTailer.js";
import {
  makeSessionBackend,
  resolveSessionBackendKind,
  writeSessionBackendKind,
  type SessionBackend,
  type SessionBackendKind,
} from "../backend/sessionBackend.js";
import { herdrInstalled } from "../backend/herdr.js";
import { createStaleDistGuard, isStaleDist, readPackageVersion, type StaleDistGuard } from "../shared/version.js";
import {
  DEFAULT_MODE_TIMING,
  engineDiag,
  type EngineState,
  type HandlerContext,
  type ModeTiming,
} from "./context.js";
import { ENGINE_HANDLERS } from "./handlers/index.js";

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
    claudeProjectsDir: claudeProjectsRoot,
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
        claudeProjectsDir: claudeProjectsRoot,
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
      officialApps: new OfficialAppsService({
        codexRemoteControl: codexAppServer,
        diagnosticLogPath: path.join(os.homedir(), ".tailii", "official-app.log"),
      }),
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
  /** Claude / ChatGPT 公式アプリ連携。null は機能無効、未指定は固定コマンド実装。 */
  officialApps?: OfficialAppsService | null;
  /** テスト注入用の native turn controller。指定時は codexAppServer より優先する。 */
  codexTurnController?: CodexTurnControllerRuntime | null;
  /** 自分がサポートする最大版（既定 PROTOCOL_MAX_SUPPORTED）。 */
  maxVersion?: number;
  /** プラン使用状況の取得（既定は実 OAuth 使用量 API。テストは () => null を注入する）。 */
  planUsage?: PlanUsageProvider;
  /** Claude モデル一覧の取得（既定は実 Models API。テストは固定値/null を注入する）。 */
  claudeModelList?: ClaudeModelListProvider;
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
    officialApps = new OfficialAppsService(),
    codexTurnController: injectedCodexTurnController = null,
    maxVersion = PROTOCOL_MAX_SUPPORTED,
    planUsage = () => fetchPlanUsage(),
    claudeModelList = () => fetchClaudeModelList(),
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
  // 一覧 Mission Control の watch 状態。hub 再接続を跨いで再送するため engine 側でも保持する。
  const listPreviewWatch = { enabled: false };
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
        // 前面会話は常時。他会話は一覧 Mission Control の watch 有効中のみ（iOS は
        // payload の session フィールドで一覧カードへルーティングする）。
        if (message.session !== activeChatSession.name && !listPreviewWatch.enabled) return;
        try { writer.write(message.payload); }
        catch (error) { process.stderr.write(`[tailii-host engine] pane_preview 書込失敗: ${String(error)}\n`); }
        return;
      }
      if (message.type === "conversation_liveness") {
        // live-pill Phase 2: 一覧 watch 中のみ「稼働中ピルを外して一覧を取り直せ」を送る。
        // 前面会話の例外は要らない（チャット面は自身の生存を別経路で知る）。
        if (!listPreviewWatch.enabled) return;
        try {
          writer.write({
            type: "session_liveness_event", v: state.negotiatedVersion,
            session: message.session, alive: message.alive,
          });
        } catch (error) {
          process.stderr.write(`[tailii-host engine] session_liveness_event 書込失敗: ${String(error)}\n`);
        }
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
        // リンク不調で RPC が破棄された場合は待たずに即時失敗させる（chat_send が
        // 黙って消えて応答が永遠に返らず、アプリのバブルが pending のまま固まる実障害）。
        if (!hubLink.send(request)) {
          if (timer !== null) clearTimeout(timer);
          rpcWaiters.delete(id);
          rpcDisconnectFailures.delete(id);
          reject(new Error("Session Hub link unavailable"));
        }
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
      // 一覧 watch は hub 側 client 状態なので、再接続（hub 再起動含む）ごとに再送する。
      if (listPreviewWatch.enabled) {
        hubLink.send({ type: "session_preview_watch", enabled: true });
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
          claudeModelList,
          homeDir,
          modeTiming: resolvedModeTiming,
          defaultAgent: agent,
          activeChatSession,
          listPreviewWatch,
          processingSessions,
          backgroundChatSessions,
          lastServerSeq,
          codexAppServer,
          codexTurnController,
          officialApps,
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

/** 1行（改行なし）をデコードし、type に対応するドメインハンドラへ dispatch する。decode 失敗は破棄。 */
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

  // 承認2型・画像・chat_output など registry 外の type は engine 制御では処理しない（破棄）。
  const handler = ENGINE_HANDLERS[message.type] as
    | ((m: ControlMessage, c: HandlerContext) => void | Promise<void>)
    | undefined;
  if (handler !== undefined) await handler(message, ctx);
  return true;
}
