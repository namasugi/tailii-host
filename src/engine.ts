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
import { ChatTailController, type ChatAgent } from "./chatTailController.js";
import { CodexRolloutTailer } from "./codexRolloutTailer.js";
import { ClaudeSessionStore } from "./claudeSessionStore.js";
import { CodexSessionStore } from "./codexSessionStore.js";
import { dirChildren, dirCreate, dirList } from "./dirLister.js";
import { runIdleReaper } from "./idleReaper.js";
import { ImageService } from "./imageService.js";
import { makeSessionLauncher, codexInnerCommand, type EngineLauncher } from "./launch.js";
import { LineWriter } from "./lineWriter.js";
import { parsePermissionMode } from "./permissionMode.js";
import { fetchPlanUsage, type PlanUsageProvider } from "./planUsageFetcher.js";
import {
  decodeControlMessage,
  PROTOCOL_MAX_SUPPORTED,
  PROTOCOL_V1,
  type ControlMessage,
  type QuestionAnswer,
  type SessionInfo,
  type SlashCommandInfo,
} from "./protocol.js";
import { claudeTranscriptActivityProvider } from "./sessionActivityProvider.js";
import { SessionIdleTracker } from "./sessionIdleTracker.js";
import { SessionListService } from "./sessionListService.js";
import { searchClaudeSessions } from "./sessionSearch.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import { sleep } from "./sleep.js";
import { TranscriptTailer } from "./transcriptTailer.js";
import { TmuxSessionManager } from "./tmux.js";
import { aggregateUsage, emptyUsageTotals } from "./usageAggregator.js";
import { aggregateCodexUsage, type CodexUsage } from "./codexUsage.js";
import { createStaleDistGuard, isStaleDist, readPackageVersion, type StaleDistGuard } from "./version.js";

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
  let idleTimeoutArg: number | null = null;
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
      case "--idle-timeout": {
        const raw = next();
        const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) idleTimeoutArg = parsed;
        break;
      }
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
  const sessionManager = new TmuxSessionManager({ store });
  const sessionListService = new SessionListService(
    sessionManager,
    claudeTranscriptActivityProvider(),
  );

  // アイドルライフサイクル: timeout は host 側設定（既定 30 分）。
  const idleTimeout = idleTimeoutArg ?? 1800;
  const idleTracker = new SessionIdleTracker(idleTimeout);
  const reaperInterval = Math.min(idleTimeout, 60);
  // resume 再起動 launcher（kill 済みセッションを記録 cwd で claude --continue 再起動）。
  const resumeLauncher = makeSessionLauncher({
    store,
    innerCommand: resumeCommandArg ?? "claude --continue",
    agent: "claude",
  });
  // per-session: agentType=codex のセッション用に codex launcher / resume launcher を用意する。
  // codex は resume 未対応のため既定コマンドで新規起動する（新しい rollout を tail）。
  const codexLauncher = makeSessionLauncher({ store, agent: "codex" });
  const codexResumeLauncher = makeSessionLauncher({ store, agent: "codex" });

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
      launcher: makeSessionLauncher({ store, innerCommand: innerCommandArg, agent: "claude" }),
      codexLauncher,
      sessionListService,
      metadataStore: store,
      idleTracker,
      resumeLauncher,
      codexResumeLauncher,
      claudeSessionStore: new ClaudeSessionStore(claudeProjectsRoot),
      codexSessionStore: new CodexSessionStore(),
      reaperCheckIntervalSeconds: reaperInterval,
      chatTailProjectsRoot: claudeProjectsRoot,
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
  sessionManager: TmuxSessionManager;
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
  idleTracker?: SessionIdleTracker | null;
  resumeLauncher?: EngineLauncher | null;
  /** codex セッションの reattach 時 resume 用 launcher。省略時は resumeLauncher にフォールバック。 */
  codexResumeLauncher?: EngineLauncher | null;
  claudeSessionStore?: ClaudeSessionStore | null;
  /** codex 会話一覧の導出（agent-tag）。省略時は codex 会話を一覧に含めない（後方互換）。 */
  codexSessionStore?: CodexSessionStore | null;
  reaperCheckIntervalSeconds?: number;
  /** セッション連動 chat_output tail の projects ルート（--transcript 指定時は使わない）。 */
  chatTailProjectsRoot?: string | null;
  /** 対象エージェント（既定 claude）。codex は rollout tail を使う。 */
  agent?: ChatAgent;
  /** codex モードの rollout tailer（テスト注入用。省略時は既定ルートで自動生成）。 */
  codexTailer?: CodexRolloutTailer;
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
    imageService = null,
    transcriptTailer = null,
    transcriptPath = null,
    launcher = null,
    codexLauncher = null,
    sessionListService = null,
    metadataStore = null,
    idleTracker = null,
    resumeLauncher = null,
    codexResumeLauncher = null,
    claudeSessionStore = null,
    codexSessionStore = null,
    reaperCheckIntervalSeconds = 60,
    chatTailProjectsRoot = null,
    agent = "claude",
    codexTailer = undefined,
    maxVersion = PROTOCOL_MAX_SUPPORTED,
    planUsage = () => fetchPlanUsage(),
    homeDir = os.homedir(),
    modeTiming = {},
    staleDistGuard = createStaleDistGuard(),
    onStaleDist = undefined,
  } = options;
  const resolvedModeTiming: ModeTiming = { ...DEFAULT_MODE_TIMING, ...modeTiming };

  // 出力の直列化（Node の Writable は書込順序を保証する）。
  const writer = new LineWriter(options.output);

  // 採用版（negotiated version）。相手 hello 受信で min を採る。
  const state: EngineState = {
    negotiatedVersion: maxVersion,
    ownMaxVersion: maxVersion,
    modeSetInFlight: new Set(),
  };

  // ---- セッション連動 chat_output tail（本番配線）----
  // `--transcript` 明示指定が無く projectsRoot が注入されたときだけ controller を構築する。
  const chatTailController =
    transcriptPath === null && chatTailProjectsRoot !== null
      ? new ChatTailController({
          writer,
          tailer:
            transcriptTailer ??
            new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true }),
          projectsRoot: chatTailProjectsRoot,
          imageService,
          protocolVersion: () => state.negotiatedVersion,
          agent,
          ...(codexTailer !== undefined && { codexTailer }),
        })
      : null;

  const lifecycleAbort = new AbortController();
  const background: Promise<unknown>[] = [];

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

    // ---- 1.7 アイドル reaper を常駐起動 ----
    if (idleTracker !== null) {
      background.push(
        runIdleReaper({
          tracker: idleTracker,
          sessionManager,
          checkIntervalSeconds: reaperCheckIntervalSeconds,
          signal: lifecycleAbort.signal,
        }),
      );
    }

    // ---- 2. 行読み取りループ ----
    ChatTailController.diag(`engine readLoop 開始 pid=${process.pid}`);
    const rl = readline.createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of rl) {
        const didProcessMessage = await handleLine(line, {
          writer,
          state,
          sessionManager,
          imageService,
          launcher,
          codexLauncher,
          sessionListService,
          metadataStore,
          idleTracker,
          resumeLauncher,
          codexResumeLauncher,
          claudeSessionStore,
          codexSessionStore,
          chatTailController,
          planUsage,
          homeDir,
          modeTiming: resolvedModeTiming,
          defaultAgent: agent,
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
    ChatTailController.diag(`engine readLoop EOF（チャネル断）pid=${process.pid}`);
  } finally {
    // ---- 3. チャネル断で chat_output tail / reaper を確実に停止する（全経路） ----
    lifecycleAbort.abort();
    chatTailController?.stop();
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
  sessionManager: TmuxSessionManager;
  imageService: ImageService | null;
  launcher: EngineLauncher | null;
  /** codex セッション用 launcher（session_start の agentType=codex 時に使用）。 */
  codexLauncher: EngineLauncher | null;
  sessionListService: SessionListService | null;
  metadataStore: SessionMetadataStore | null;
  idleTracker: SessionIdleTracker | null;
  resumeLauncher: EngineLauncher | null;
  /** codex セッションの reattach 時 resume 用 launcher。 */
  codexResumeLauncher: EngineLauncher | null;
  claudeSessionStore: ClaudeSessionStore | null;
  /** codex 会話一覧の導出（agent-tag）。 */
  codexSessionStore: CodexSessionStore | null;
  chatTailController: ChatTailController | null;
  planUsage: PlanUsageProvider;
  homeDir: string;
  modeTiming: ModeTiming;
  /** host 側の既定エージェント（session_start が agentType を指定しないときのフォールバック）。 */
  defaultAgent: ChatAgent;
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
    ChatTailController.diag(
      `engine decode 失敗（行破棄）: ${String(error)} 生=${trimmed.slice(0, 120)}`,
    );
    process.stderr.write(`[tailii-host engine] decode 失敗、行破棄: ${String(error)}\n`);
    return false;
  }
  ChatTailController.diag(`engine 受信 type=${message.type}`);

  const { writer, state, sessionManager, metadataStore, chatTailController } = ctx;
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
      // 再アクティブ化（アイドル計時解除）→ 生存なら即 reattach / メタあり tmux 不在は
      // 記録 cwd で resume 再起動 → attached / メタ無しは従来の not_found。
      ctx.idleTracker?.markActive(message.name);
      try {
        const result = await sessionManager.reattach(message.name);
        if (result.kind === "attached") {
          writeSessionListResponse(writer, v, message.id, [result.info], null);
          const meta = metadataStore?.get(message.name) ?? null;
          const openCwd = meta?.cwd ?? result.info.cwd;
          // セッション記録の agent（codex/claude）で tail mode を選ぶ。
          chatTailController?.open(
            openCwd,
            meta?.claudeSessionId ?? null,
            null,
            meta?.agent ?? ctx.defaultAgent,
          );
        } else {
          const meta = metadataStore?.get(message.name) ?? null;
          if (ctx.resumeLauncher !== null && meta !== null) {
            // codex セッションは codex 用 resume launcher で再起動する。
            const reAgent = meta.agent ?? ctx.defaultAgent;
            // claude で会話 id が記録済みなら通常 launcher の `--resume <id>` で同一会話を
            // 厳密に再開する（resumeLauncher の `--continue` は cwd の最新会話を拾うため、
            // 別会話を再開して tail 束縛と食い違い得る）。id 未記録の旧メタは従来経路。
            const strictClaudeResume =
              reAgent === "claude" && meta.claudeSessionId != null && ctx.launcher !== null;
            const chosenResume =
              reAgent === "codex"
                ? (ctx.codexResumeLauncher ?? ctx.resumeLauncher)
                : strictClaudeResume
                  ? ctx.launcher!
                  : ctx.resumeLauncher;
            const res = await chosenResume(
              meta.cwd, message.name, null,
              strictClaudeResume ? (meta.claudeSessionId ?? null) : null,
            );
            if (res.exitCode === 0) {
              const info: SessionInfo = { name: message.name, cwd: meta.cwd, alive: true };
              writeSessionListResponse(writer, v, message.id, [info], null);
              chatTailController?.open(meta.cwd, meta.claudeSessionId ?? null, null, reAgent);
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
        await sessionManager.kill(message.name);
        // kill 成功は list 応答（現況一覧）で返す（疎通確認）。
        let sessions: SessionInfo[] = [];
        try {
          sessions = await sessionManager.list();
        } catch {
          sessions = [];
        }
        writeSessionListResponse(writer, v, message.id, sessions, null);
      } catch (error) {
        writeError(writer, v, message.id, "tmux_error", String(error));
      }
      break;
    }

    case "session_idle_hint": {
      // アイドル起点を記録する（chat 離脱, 要件 4.2）。以後 reaper が timeout 超過で kill する。
      ctx.idleTracker?.markIdle(message.name, Math.floor(Date.now() / 1000));
      break;
    }

    case "session_start": {
      // session_start → launch() 結線。agentType でセッション毎に claude/codex を選ぶ
      //（未指定は host 既定 defaultAgent）。codex は agentType=codex 時の専用 launcher を使う。
      const sessionAgent: ChatAgent = message.agentType ?? ctx.defaultAgent;
      // codex 新規起動でモデル/サンドボックス指定があれば、その flags を持つ launcher をその場で組む
      //（codex-input）。resume は元セッションの設定を継ぐため既定 codexLauncher を使う。
      const perSessionCodexLauncher =
        sessionAgent === "codex" &&
        message.resumeSessionId === undefined &&
        (message.codexModel !== undefined || message.codexSandbox !== undefined)
          ? makeSessionLauncher({
              ...(ctx.metadataStore !== null && { store: ctx.metadataStore }),
              agent: "codex",
              innerCommand: codexInnerCommand({
                model: message.codexModel ?? null,
                sandbox: message.codexSandbox ?? null,
              }),
            })
          : null;
      const chosenLauncher =
        sessionAgent === "codex"
          ? (perSessionCodexLauncher ?? ctx.codexLauncher ?? ctx.launcher)
          : ctx.launcher;
      if (chosenLauncher === null) {
        // 未注入（テスト構成漏れ等）: 安全側 — 実起動せず構造化 error を返す。
        process.stderr.write("[tailii-host engine] session_start: launcher 未構成\n");
        writeError(writer, v, message.id, "launch_failed", "launch 機能が構成されていません。");
        break;
      }
      const resumeSessionId = message.resumeSessionId ?? null;
      // 新規起動は host 生成の session-id で claude を起動し（`--session-id <uuid>`）、
      // 会話 jsonl 名を事前に確定させる。tail はその id の jsonl だけを追うため、同一 cwd に
      // 別の稼働セッションがあっても、そのログが新セッションへ流れ込まない（取り違え防止）。
      const newSessionId = resumeSessionId === null ? randomUUID() : null;
      // codex は session-id 固定を持たず mtime で rollout を解決するため、新規起動は
      // 「起動時刻より後に更新された rollout」に限定する（古い rollout の流入防止）。
      // claude は preferred=newSessionId で厳密束縛するため newerThanMs は効かない（無害）。
      const launchedAtMs = Date.now();
      ChatTailController.diag(
        `session_start launcher 呼出前 cwd=${message.cwd} name=${message.name} resume=${resumeSessionId ?? "nil"} newId=${newSessionId ?? "nil"}`,
      );
      const result = await chosenLauncher(
        message.cwd, message.name, message.baseDir ?? null, resumeSessionId, newSessionId,
        message.title ?? null,
      );
      ChatTailController.diag(
        `session_start launcher 結果 exit=${result.exitCode} err=${result.errorText.slice(0, 100)} tailCtrl=${chatTailController === null ? "nil" : "ok"}`,
      );
      if (result.exitCode === 0) {
        // cwd は launcher が権威記録した解決後 cwd（メタ）を優先。
        const openCwd = metadataStore?.get(message.name)?.cwd ?? message.cwd;
        // tail は確定した会話 id（resume=既存 id / 新規=生成 id）だけを追う。newerThanMs は
        // codex（mtime 解決）の新規起動でのみ効き、claude は preferred で厳密束縛される。
        chatTailController?.open(
          openCwd, resumeSessionId ?? newSessionId, resumeSessionId === null ? launchedAtMs : null,
          sessionAgent,
        );
        // 成功: 現況一覧で応答する（kill と同じ疎通様式）。
        try {
          const sessions = await sessionManager.list();
          writeSessionListResponse(writer, v, message.id, sessions, null);
        } catch {
          // 起動自体は成功しているため、一覧取得失敗時は当該セッション単独で応答する。
          try {
            writeSessionListResponse(
              writer, v, message.id,
              [{ name: message.name, cwd: message.cwd, alive: true }], null,
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
      const tailAgent = chatTailController?.currentAgent() ?? ctx.defaultAgent;
      if (tailAgent === "codex") {
        const codexRollout = chatTailController?.currentCodexRolloutPath() ?? null;
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
      const transcript = chatTailController?.currentTranscriptPath() ?? null;
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
        await injectQuestionAnswers(message.answers, message.session, sessionManager);
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
      ChatTailController.diag(`browse_request id=${message.id} path=${message.path}`);
      const entries = dirChildren(message.path);
      try {
        writer.write({ type: "browse_response", v, id: message.id, path: message.path, entries });
        ChatTailController.diag(`browse_response id=${message.id} entries=${entries.length}`);
      } catch (error) {
        ChatTailController.diag(`browse_response 書込失敗 id=${message.id}: ${String(error)}`);
        process.stderr.write(
          `[tailii-host engine] browse_response 書込失敗: ${String(error)}\n`,
        );
      }
      break;
    }

    case "claude_session_list_request": {
      // 会話一覧: claude(jsonl) + codex(rollout) をマージし updatedAt 降順で返す（agent-tag）。
      // store 未注入時はその分を空一覧扱い（後方互換 — 会話機能なし）。
      ChatTailController.diag(`claude_session_list_request id=${message.id}`);
      const claudeSessions = ctx.claudeSessionStore?.list() ?? [];
      const codexSessions = ctx.codexSessionStore?.list() ?? [];
      const sessions = [...claudeSessions, ...codexSessions].sort((lhs, rhs) => {
        const l = lhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
        const r = rhs.updatedAt ?? Number.MIN_SAFE_INTEGER;
        if (l !== r) return r - l;
        return lhs.sessionId < rhs.sessionId ? -1 : lhs.sessionId > rhs.sessionId ? 1 : 0;
      });
      ChatTailController.diag(
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
      ChatTailController.diag(`session_search_request id=${message.id} query=${message.query}`);
      const response =
        ctx.claudeSessionStore !== null
          ? searchClaudeSessions(ctx.claudeSessionStore, message.query, { limit: message.limit })
          : { results: [], stats: { scannedFiles: 0, truncated: false } };
      ChatTailController.diag(
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

    default:
      // 承認2型・画像・chat_output などは engine 制御では処理しない（本タスク範囲外）。破棄。
      break;
  }
  return true;
}

/**
 * multiSelect のカーソル移動・トグル・入力の各キー送出の間に挟むウェイト（ms）。
 * 連続キーを一気に送ると TUI（Ink 再描画）が取りこぼすため、1 キーごとに待つ。
 */
const KEY_STEP_MS = 150;

/**
 * iOS の選択結果を Claude Code TUI の AskUserQuestion ダイアログへ送る。
 * 実 TUI の操作体系（2026-07-07 に tmux + 実 claude で再検証済み）:
 * - 単一選択 = 数字キー（1-based）で即確定（Enter は送らない — 誤爆防止）。
 * - 単一選択の Other = 数字キーで行がインライン入力欄化 → literal 入力 → Enter。空なら押さない。
 * - multiSelect = 数字キーは無反応。カーソル（先頭 index 0 から開始）を ↓ で対象行へ移動し
 *   Space でトグル → Right でレビュー → 最終問後に「1」Submit answers。
 *   Other 行は Space でチェック＆入力欄化 → literal 入力 → ↑ でテキスト欄を抜けてから Right。
 * - Other の synthetic index（= options.count）は選択肢中で最大の index になるため、
 *   otherText があるときは最大 index を Other 行とみなす。
 */
async function injectQuestionAnswers(
  answers: QuestionAnswer[],
  session: string,
  sessionManager: TmuxSessionManager,
): Promise<void> {
  const sorted = answers.slice().sort((a, b) => a.questionIndex - b.questionIndex);
  let needsReviewSubmit = false;
  for (let position = 0; position < sorted.length; position += 1) {
    const answer = sorted[position]!;
    const isLast = position === sorted.length - 1;
    const other = (answer.otherText ?? "").trim();
    let indexes = answer.selectedOptionIndexes.filter((i) => i >= 0).sort((a, b) => a - b);
    // otherText があるとき、最大 index は Other（Type something.）行。
    let otherIndex: number | null = null;
    if (other.length > 0 && indexes.length > 0) {
      otherIndex = indexes[indexes.length - 1]!;
      indexes = indexes.slice(0, -1);
    }
    if (answer.multiSelect) {
      // multiSelect は数字キーではトグルできない（実 TUI）。カーソルを ↓ で移動し Space でトグルする。
      // カーソルは先頭（index 0）から開始。indexes / otherIndex は昇順なので下方向のみで足りる。
      let cursor = 0;
      const moveTo = async (target: number): Promise<void> => {
        for (let n = cursor; n < target; n += 1) {
          await sessionManager.sendKeys(session, ["Down"]);
          await sleep(KEY_STEP_MS);
        }
        cursor = target;
      };
      for (const idx of indexes) {
        await moveTo(idx);
        await sessionManager.sendKeys(session, ["Space"]);
        await sleep(KEY_STEP_MS);
      }
      if (otherIndex !== null) {
        await moveTo(otherIndex);
        // Other 行を Space でチェックすると同時に入力欄がフォーカスされる。
        await sessionManager.sendKeys(session, ["Space"]);
        await sleep(KEY_STEP_MS);
        await sessionManager.sendKeys(session, [other], true);
        await sleep(KEY_STEP_MS);
        // テキスト欄にいると Right がタブ移動に効かないため、↑ で通常行へ退避してから進む。
        await sessionManager.sendKeys(session, ["Up"]);
        await sleep(KEY_STEP_MS);
        cursor = otherIndex - 1;
      }
      // レビュー（最終問）または次の質問タブへ進む。
      await sessionManager.sendKeys(session, ["Right"]);
      if (isLast) needsReviewSubmit = true;
    } else if (otherIndex !== null) {
      await sessionManager.sendKeys(session, [String(otherIndex + 1)]);
      await sessionManager.sendKeys(session, [other], true);
      await sessionManager.sendKeys(session, ["Enter"]);
    } else if (indexes.length > 0) {
      // 数字キーで即確定（Enter は送らない）。
      await sessionManager.sendKeys(session, [String(indexes[0]! + 1)]);
    }
    // TUI の再描画/タブ送りを待つ（連続注入の取りこぼし防止）。
    await sleep(200);
  }
  if (needsReviewSubmit) {
    // レビュー画面「Ready to submit your answers?」で 1. Submit answers を確定する。
    await sessionManager.sendKeys(session, ["1"]);
  }
}

/** pane から mode が判定できるまで、指定回数だけ短く待つ。 */
async function waitForPermissionMode(
  sessionManager: TmuxSessionManager,
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
  sessionManager: TmuxSessionManager,
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
      if (next === null) {
        current = null;
        break;
      }
      if (next !== before) {
        current = next;
        changed = true;
        break;
      }
      await sleep(timing.setChangePollMs);
    }
    if (current === null || !changed) break;
  }
  return { kind: "ok", mode: current };
}

interface SlashCandidate {
  command: SlashCommandInfo;
  priority: number;
}

/** slash_list_request 用に、ユーザー/プロジェクトの skills と commands を収集する。 */
function collectSlashCommands(homeDir: string, cwd?: string): SlashCommandInfo[] {
  const byName = new Map<string, SlashCandidate>();
  const userClaude = path.join(homeDir, ".claude");
  const projectClaude = cwd === undefined ? null : path.join(cwd, ".claude");

  scanSkillCommands(path.join(userClaude, "skills"), 2, byName);
  if (projectClaude !== null) scanSkillCommands(path.join(projectClaude, "skills"), 4, byName);
  scanMarkdownCommands(path.join(userClaude, "commands"), 1, byName);
  if (projectClaude !== null) scanMarkdownCommands(path.join(projectClaude, "commands"), 3, byName);

  return [...byName.values()]
    .map((entry) => entry.command)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

/** ~/.claude/skills/<name>/SKILL.md 形式のコマンド候補を読む。 */
function scanSkillCommands(
  root: string,
  priority: number,
  byName: Map<string, SlashCandidate>,
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
    addSlashCandidate(byName, `/${entry.name}`, path.join(skillDir, "SKILL.md"), priority);
  }
}

/** ~/.claude/commands/<name>.md 形式のコマンド候補を読む。 */
function scanMarkdownCommands(
  root: string,
  priority: number,
  byName: Map<string, SlashCandidate>,
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
    addSlashCandidate(byName, `/${entry.name.slice(0, -3)}`, filePath, priority);
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

/** session_list_response を書き出す小ヘルパー（nextCursor は null なら省略）。 */
function writeSessionListResponse(
  writer: LineWriter,
  v: number,
  id: string,
  sessions: SessionInfo[],
  nextCursor: string | null,
): void {
  writer.write({
    type: "session_list_response",
    v,
    id,
    sessions,
    ...(nextCursor !== null && { nextCursor }),
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
