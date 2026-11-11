// protocol/messages.ts
// ワイヤー仕様の型定義: プロトコル版数・支援型・ControlMessage（タグ付き union）。
// 正本は root protocol/control-channel.md + golden フィクスチャ（goldenSync で同期検知）。
import type { ClaudeApiDelegateRequest, ClaudeApiDelegateResult } from "../services/claudeApiDelegate.js";
import type { ApiFederationSelection, ApiFederationOptions, ApiFederationStatus, ApiFederationConfiguration, ApiFederationProfile } from "../services/claudeApiFederation.js";
import type { ApiDelegateHostKeys } from "../services/apiDelegateHostKeys.js";
import type { ApiClaudeModelsSelection, ApiClaudeModelsResult } from "../services/claudeApiModels.js";

export const PROTOCOL_LEGACY = 0;
export const PROTOCOL_V1 = 1;
export const PROTOCOL_V2 = 2;
export const PROTOCOL_MAX_SUPPORTED = 2;

// MARK: - 支援型

/** 承認要求に含まれる編集差分の構造化表現。 */
export interface ToolDiff {
  kind: "create" | "edit";
  path: string;
  newText?: string;
  oldString?: string;
  newString?: string;
}

/** tool_activity の差分詳細（キャップ済み old/new と切り詰めフラグ）。 */
export interface ToolActivityDiff {
  oldString?: string;
  newString?: string;
  oldStringTruncated: boolean;
  newStringTruncated: boolean;
}

/** TodoWrite の 1 項目。 */
export interface ToolActivityTodo {
  content: string;
  status: string;
}

/**
 * ツール呼び出しが実行されなかった / 最後まで走らなかった理由（Claude Code transcript の
 * tool_result 行に付く `toolDenialKind` の値そのまま, tool-denial）。
 * - `user-rejected`: 利用者が承認ダイアログで断った。
 * - `permission-rule`: 許可ルール / hook が拒否した。
 * - `automode-blocked`: auto mode の判定が危険とみなした。
 * - `automode-unavailable`: auto mode の判定が得られなかった（公式 CLI は薄い「Not run」行, 2.1.296）。
 * - `automode-parsing-error`: auto mode の判定を読み取れなかった。
 * - `interrupted` / `cancelled`: 実行中の中断 / 取り消し。
 */
export const TOOL_DENIAL_KINDS = [
  "user-rejected", "permission-rule", "automode-blocked", "automode-unavailable",
  "automode-parsing-error", "interrupted", "cancelled",
] as const;
export type ToolDenialKind = (typeof TOOL_DENIAL_KINDS)[number];

export function isToolDenialKind(value: unknown): value is ToolDenialKind {
  return typeof value === "string" && (TOOL_DENIAL_KINDS as readonly string[]).includes(value);
}

/** Claude Code transcript の tool_use を chat timeline に表示するための構造化通知。 */
export interface ToolActivity {
  id: string;
  name: string;
  label: string;
  file?: string;
  addedLines?: number;
  removedLines?: number;
  diff?: ToolActivityDiff;
  command?: string;
  commandTruncated: boolean;
  description?: string;
  descriptionTruncated: boolean;
  todos?: ToolActivityTodo[];
  /** SendUserFile が利用者へ渡したファイルの絶対パス一覧（他ツールは省略, additive, file-download）。 */
  files?: string[];
  /** Artifact ツールが公開したページの URL（tool_result から後付け, additive, artifact-card）。 */
  url?: string;
  /** 実行されなかった / 中断された理由（tool_result から後付け, additive, tool-denial）。成功時は省略。 */
  denial?: ToolDenialKind;
  /** MCP 操作の結果（additive）。接続失敗と操作失敗・結果未確認を区別する。 */
  outcome?: "completed" | "unverified" | "failed" | "connection_failed";
}

export type SubagentNodeStatus = "running" | "completed" | "error";

/** サブエージェント（workflow）進捗ツリーのノード状態通知。 */
export interface SubagentNode {
  nodeId: string;
  toolUseId: string;
  parentNodeId?: string | null;
  agentType: string;
  label: string;
  depth: number;
  status: SubagentNodeStatus;
  currentActivity?: string | null;
  ts: number;
  /** "command" = バックグラウンドコマンド（Bash run_in_background）。省略時はエージェント。 */
  kind?: "command";
  /**
   * 実行モデルの slug（Claude: サブエージェント transcript の assistant 行 `message.model` /
   * Codex: 子 thread の `model`、無ければ spawnAgent の `model`）。判明するまで省略。
   */
  model?: string | null;
  /**
   * 実行時の工数（Claude: サブエージェント transcript の assistant 行 `effort` / Codex 0.162+:
   * `subAgentActivity.reasoningEffort`。値は CLI のものそのまま, additive, subagent-effort）。判明するまで省略。
   */
  effort?: string | null;
  /** バックグラウンドコマンドの command 全文（上限 4000 字, additive, background-task-detail）。エージェントは省略。 */
  command?: string;
  /** バックグラウンドコマンドの終了コード（完了通知の `exit code N`, additive）。不明・実行中・利用者停止は省略。 */
  exitCode?: number;
  /** 開始時刻 epoch ms（additive）。`ts` は終端後に終了時刻へ変わるため所要時間の計算用に別に持つ。 */
  startTs?: number;
}

/** セッション一覧応答の 1 要素。 */
/** Git 画面のワークツリー一覧の 1 件（git_worktree_list_response）。 */
export interface GitWorktreeListItem {
  path: string;
  /** ブランチ名（detached は null）。 */
  branch: string | null;
  /** 未保存の変更か未マージのコミットがある（判定できないときも true）。 */
  hasChanges: boolean;
  /** 稼働中のセッションか会話一覧の会話が使っている（判定できないときも true）。 */
  inUse: boolean;
  /** 登録は残っているがフォルダが見つからない（省略 = 見つかる）。 */
  missing?: boolean;
  uncommittedCount?: number;
  unmergedCommitCount?: number;
}

export interface SessionInfo {
  name: string;
  cwd: string;
  alive: boolean;
  updatedAt?: number;
  /** Claude の会話 JSONL 名に対応する session-id。既知の live session 再利用に使う。 */
  claudeSessionId?: string;
  /** 会話 provider。未指定は後方互換で claude 相当。 */
  agent?: "claude" | "codex";
  /** provider 共通の論理会話 ID。live runtime の再利用キー。 */
  providerSessionId?: string;
  /** セッションを収容する端末バックエンド。未指定は後方互換で tmux 相当（session-backend）。 */
  backend?: TerminalBackendKind;
  /**
   * 端末側の表示タイトル（session-title 逆方向同期）。herdr のタブラベルがセッション名と
   * 異なるとき（アプリ/Mac どちらかでの命名済み）だけ載る。tmux は常に未指定。
   */
  displayTitle?: string;
}

/** マシン内会話 1 件（claude=jsonl / codex=rollout）。 */
export interface ClaudeSessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt?: number;
  /** 会話を駆動するエージェント（claude=既定 / codex, agent-tag）。未指定は claude 相当。 */
  agent?: "claude" | "codex";
  /**
   * provider の正式タイトルが設定済みか（Codex=App Server の thread.name、
   * Claude=transcript の custom-title/ai-title）。旧 host では未指定（＝不明）。
   */
  hasProviderTitle?: boolean;
  /** 最終 user/assistant メッセージの 1 行スニペット（一覧プレビュー, list-preview）。 */
  lastMessage?: string;
  /**
   * この会話を収容している生存セッション名（live-pill）。生存セッションが在るときのみ載る。
   * `liveSessionsResolved` が true の応答では **不在 = 停止中の確定** を意味する。
   * 複数 pane が同じ会話を掴んでいる場合の選択規則は docs/resilient-chat-sync.md §7.4。
   */
  liveSessionName?: string;
  /** `liveSessionName` を収容する端末バックエンド（live-pill）。liveSessionName と同時にのみ載る。 */
  liveSessionBackend?: TerminalBackendKind;
  /**
   * Tailii 管理外の生存 CLI インスタンス（Mac の端末 / `claude remote-control` が同じ会話を掴んでいる）
   * のセッション名（`~/.claude/sessions` の登録簿, peer-live）。Tailii の pane が無い行にだけ載る。
   * 開くと第 2 インスタンスが並走するため、iOS は確認を挟む。
   */
  peerSessionName?: string;
  /** `peerSessionName` の CLI が Remote Control（公式アプリ / claude.ai）にも繋がっているか。 */
  peerBridged?: boolean;
}

/** session_search_response の 1 検索結果。 */
export interface SessionSearchResult {
  /** 一覧に未取得の会話を正しい CLI で開くための種別（旧 host は省略）。 */
  agent?: string;
  sessionId: string;
  title: string;
  cwd: string;
  snippet: string;
  updatedAt?: number;
}

/** serve_list_response の 1 サーバー（Mac 上で LISTEN 中の開発サーバー, serve-list）。 */
export interface ServeProcessInfo {
  pid: number;
  port: number;
  /** プロセス名（lsof の COMMAND 列）。 */
  command: string;
  /** フルコマンドライン（表示用。長いものは切り詰め済み）。 */
  commandLine?: string;
  /** プロセスの作業ディレクトリ（会話 workdir とのグルーピング判定に使う）。 */
  cwd?: string;
  /** 配信中ページの HTML `<title>`（host が HTTP GET で取得。HTML でない/応答なしは省略）。 */
  title?: string;
}

/** peer_session_list_response の 1 件（同じマシンで生きている Claude Code セッション, peer-sessions）。 */
export interface PeerSessionInfo {
  /** cross-session messaging の宛先名（`@名前` / SendMessage の `to`）。 */
  name: string;
  cwd: string;
  /** Claude の会話 id（iOS は開いている会話自身を候補から除く）。 */
  sessionId: string;
  /** `busy` | `idle`（不明は省略）。 */
  status?: string;
  /** Remote Control（公式アプリ / claude.ai）にも繋がっているか。 */
  bridged?: boolean;
}

/** slash_list_response の 1 コマンド候補。 */
export interface SlashCommandInfo {
  name: string;
  summary: string;
}

/** file_list_response の 1 エントリ。 */
export interface FileEntry {
  name: string;
  kind: "dir" | "file" | "symlink";
  size: number;
  mtimeMs: number;
  gitStatus?: string;
}

/** file_read_response のサービス内部表現。 */
export interface FileReadResult {
  path: string;
  kind: "text" | "image" | "binary" | "tooLarge" | "error";
  size: number;
  mtimeMs: number;
  content?: string;
  truncated?: boolean;
  imageBase64?: string;
  imageFormat?: string;
  error?: string;
}

/** file_fetch_response の 1 チャンク（サービス内部表現）。 */
export interface FileFetchChunk {
  seq: number;
  data: string;
  eof: boolean;
  /** 原本の MIME（推定）。error 時は省略。 */
  mime?: string;
  /** 原本のファイル名（保存名の既定）。error 時は省略。 */
  name?: string;
  /** 原本の総バイト数（進捗表示用）。error 時は省略。 */
  size?: number;
  /** 取得失敗の理由。付くときは eof:true・data 空。 */
  error?: string;
  /**
   * 途中から読む取り出し（`file_fetch_request.offset`）の開始位置。各チャンクに付ける。
   * iPhone はこれが無いと「古い host が頭から送っている」とみなして中止する。
   */
  offset?: number;
}

/** git_status_response の変更ファイル 1 件。 */
export interface GitStatusFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  renamedFrom: string | null;
}

/** git_log_response のコミット 1 件。 */
export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  dateMs: number;
}

/** git_branch_list_response のローカルブランチ 1 件。 */
export interface GitBranchInfo {
  name: string;
  subject: string;
  dateMs: number;
  isCurrent: boolean;
  ahead: number;
  behind: number;
}

/** Codex App Server `model/list` を iOS のモデル選択へ渡すための 1 要素。 */
export interface CodexModelInfo {
  id: string;
  displayName: string;
  description: string;
  /** Codex が会話へ割り当てる実効コンテキスト窓。取得不能時は省略。 */
  contextWindow?: number;
  /** モデル既定の reasoning effort。 */
  defaultReasoningEffort?: string;
  /** モデルが受理する reasoning effort（速い→高性能の順）。 */
  supportedReasoningEfforts?: string[];
  isDefault: boolean;
}

/**
 * Codex の collaboration mode（App Server `turn/start.collaborationMode` の `mode`）。
 * `plan` はプランモード（変更せず `<proposed_plan>` を出す）、`default` は通常実行（codex-plan-mode）。
 */
export type CodexCollaborationMode = "plan" | "default";

/**
 * Codex thread の目標（App Server `thread/goal/*` の `ThreadGoal`, codex-goal）。
 * 状態は `active` | `paused` | `blocked` | `usageLimited` | `budgetLimited` | `complete`。
 * 時刻は Unix 秒。`tokenBudget` は未設定なら省略。
 */
export interface CodexGoalInfo {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** `codex_goal_request` の操作種別。`set` は objective / status / tokenBudget の指定分だけを更新する。 */
export type CodexGoalAction = "get" | "set" | "clear";

/** Anthropic Models API `/v1/models` を iOS のモデル選択へ渡すための 1 要素。 */
export interface ClaudeModelInfo {
  /** `/model <id>` / `--model` に渡す値（例: claude-sonnet-5）。 */
  id: string;
  /** API の display_name（例: "Claude Sonnet 5"。表示整形は iOS 側）。 */
  displayName: string;
  /**
   * `ANTHROPIC_DEFAULT_MODEL`（環境変数 / ~/.claude/settings.json の env）が指す「model を渡さずに
   * 起動したとき実際に使われるモデル」なら true（additive, default-model）。設定が無ければ省略。
   */
  isDefault?: boolean;
}

/** AskUserQuestion の選択肢。 */
export interface QuestionOption {
  label: string;
  description: string;
  /**
   * 選択肢のプレビュー本文（AskUserQuestion の `option.preview`）。
   * これを持つ単一選択の設問は TUI が preview レイアウトで描く（Other 行が無く、
   * 自由記述は Notes 欄が受ける）ので、iOS 側の「その他」も同じ意味へ寄せる。
   */
  preview?: string;
}

/** AskUserQuestion の質問 1 件。 */
export interface QuestionPromptQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** AskUserQuestion の回答 1 件。 */
export interface QuestionAnswer {
  questionIndex: number;
  selectedOptionIndexes: number[];
  otherText?: string;
  /** 対象質問が multiSelect か（TUI 注入方式の選択に使う。旧形式欠落は false）。 */
  multiSelect: boolean;
}

// MARK: - ControlMessage（タグ付き union）

export type ChatRole = "assistant" | "user" | "system";
export type SubagentTranscriptRole = "assistant" | "user" | "tool";
export type SubagentTranscriptKind = "tool_use" | "tool_result";
export interface SubagentTranscriptEntry {
  role: SubagentTranscriptRole;
  text: string;
  ts?: number;
  kind?: SubagentTranscriptKind;
}
export type Decision = "allow" | "deny";
export type RemotePendingKind = "approval" | "question";

/**
 * host_update_response.status:
 *   started     — updater を起動した(完了は再接続後の channel_hello.serverVersion で確認する)
 *   already     — 既に目標版(冪等成功)
 *   in_progress — 別の更新が進行中(冪等成功扱い)
 *   unsupported — 自動更新の対象外(dev インストール / 手動管理シム)
 *   error       — 起動前検証で拒否(ダウングレード等。詳細は error)
 */
export type HostUpdateStatus = "started" | "already" | "in_progress" | "unsupported" | "error";

/** 背景同期の境界ヒント 1 件（`background_sync_hints`）。`newerThanMs` は host 時刻の epoch ms。 */
export interface BackgroundSyncHint {
  session: string;
  newerThanMs: number;
}

/** `background_sync_hints.sessions` の上限（iOS の上限と同じ）。超えた分は decode で捨てる。 */
export const BACKGROUND_SYNC_HINTS_MAX = 256;

/** 一覧の「待ち」ピルの snapshot 1 件（`remote_pending_snapshot.items`）。`remote_pending` の kind 以外の中身。 */
export interface RemotePendingSnapshotItem {
  id: string;
  session: string;
  tool?: string;
  summary: string;
}

/** `remote_pending_snapshot.items` の上限（iOS の上限と同じ）。超えた分は decode で捨てる。 */
export const REMOTE_PENDING_SNAPSHOT_MAX = 256;

/**
 * background_command_stop_response.status（バックグラウンドタスク一覧からの背景コマンドの停止）:
 *   stopped     — 出力ファイルを書いていたプロセス（グループ）を止めた
 *   not_running — もう動いていなかった（書き込み元がいない）
 *   not_found   — その会話の背景コマンドとして見つからない（出力ファイル不明・Codex 会話等）
 *   failed      — 調べられない／止まらなかった（詳細は error）
 */
export type BackgroundCommandStopStatus = "stopped" | "not_running" | "not_found" | "failed";

/**
 * subagent_control_request.action（subagent-control, バックグラウンドタスクからのエージェント操作）:
 *   stop_all — 会話の背景エージェントを全部止める（Claude: TUI の `chat:killAgents` = Ctrl+X Ctrl+K を 2 回 /
 *              Codex: 実行中の子 thread の turn を全部 interrupt）
 *   stop     — 1 体止める（Codex のみ。Claude は iOS が会話本体へ TaskStop を頼む）
 *   message  — 1 体へ追加の指示（Codex のみ。Claude は iOS が会話本体へ SendMessage を頼む）
 */
export type SubagentControlAction = "stop_all" | "stop" | "message";
/** ok / not_running（止める相手がいない）/ unsupported（この会話では host で扱わない）/ failed（詳細は error）。 */
export type SubagentControlStatus = "ok" | "not_running" | "unsupported" | "failed";

export function isSubagentControlAction(value: unknown): value is SubagentControlAction {
  return value === "stop_all" || value === "stop" || value === "message";
}

export function isSubagentControlStatus(value: unknown): value is SubagentControlStatus {
  return value === "ok" || value === "not_running" || value === "unsupported" || value === "failed";
}

export function isBackgroundCommandStopStatus(value: unknown): value is BackgroundCommandStopStatus {
  return value === "stopped" || value === "not_running" || value === "not_found" || value === "failed";
}
export type OfficialAppProvider = "claude" | "codex";
export type OfficialAppAction = "open" | "repair" | "stop";
export type OfficialAppState = "active" | "inactive" | "unavailable";
export type OfficialAppOutcome = "open" | "pair" | "stopped" | "unavailable";

export interface OfficialAppStatus {
  provider: OfficialAppProvider;
  version?: string;
  state: OfficialAppState;
  canOpen: boolean;
  canStart: boolean;
  launchUrl?: string;
  unavailableReason?: string;
}

export interface OfficialAppActionResult {
  provider: OfficialAppProvider;
  outcome: OfficialAppOutcome;
  launchUrl?: string;
  manualPairingCode?: string;
  expiresAt?: number;
  unavailableReason?: string;
}

/** Claude が返す請求期間の追加利用額。金額は通貨の最小単位のまま運ぶ。 */
export interface ClaudeExtraUsage {
  isEnabled?: boolean;
  usedCredits?: string;
  monthlyLimit?: string;
  currency?: string;
  decimalPlaces?: number;
}

/**
 * アカウント全体の使用枠・追加利用額の Claude 側。欠落は不明、0 ではない。
 * `premium*` は上位モデルの週次枠、`*ResetsAt` は ISO 8601。
 * `plan` / `rateLimitTier` は認証情報の生値で、現行名への写像は表示側が持つ。
 */
export interface ClaudeAccountUsage {
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  premiumPercent?: number;
  premiumResetsAt?: string;
  extraUsage?: ClaudeExtraUsage;
  /** 契約種別の生値（"max" / "pro" 等。credentials の `subscriptionType`）。 */
  plan?: string;
  /** レート制限ティアの生値（"default_claude_max_20x" 等）。旧識別子から現行名を導く。 */
  rateLimitTier?: string;
  /**
   * ログイン中アカウントの**マスク済み**表示（"a***@example.com"）。
   * 生 email は host 内で捨て、ワイヤーへはマスク済み文字列しか載せない。
   */
  account?: string;
  /**
   * 付与済みの利用枠リセット権（Claude Code の `/limit-reset` で使う）。
   * 欠落は不明（取得不可・対象外）、空配列は「使えるリセット権なし」。
   */
  limitResets?: ClaudeLimitReset[];
  /** 最新を取れず前回値を載せているときだけ付く（1 時間以内に取れた値に限る）。 */
  stale?: ClaudeUsageStale;
}

/** 前回値を載せている理由と、その値の取得時刻（ISO 8601）。 */
export interface ClaudeUsageStale {
  /** "rate_limited"（問い合わせ過多）| "unavailable"（通信断・API 異常）。未知の値もそのまま運ぶ。 */
  reason: string;
  fetchedAt: string;
  /** 問い合わせを再開する予定時刻（429 のときだけ）。 */
  retryAt?: string;
}

/** 利用枠リセット権 1 件（使用量 API の `cedar_ember.grants[]` 由来）。 */
export interface ClaudeLimitReset {
  /** 種類の生値: "fable" | "session" | "weekly" | "full"（未知の値も運び、表示側が汎用表示する）。 */
  kind: string;
  /** 残り回数（1 以上）。 */
  remaining: number;
  /** 付与回数。 */
  total?: number;
  /** 使用期限（ISO 8601）。 */
  expiresAt?: string;
  /** 今すぐ使えるか（一時停止中・他の枠で塞がれている間は false）。 */
  usableNow?: boolean;
}

/** Codex の追加クレジット。API Platform の無料・購入済み API 残高とは別枠。 */
export interface CodexCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  /** 単位はクレジット。小数精度を保持し、USD と解釈しない。 */
  balance?: string;
}

/** 登録済み管理キーの組織全体の API 利用額。無料枠の消費内訳・残高とは別。 */
export interface OpenAIApiUsage {
  month: string;
  cost: string;
  currency: string;
  fetchedAt: string;
}

/** キーの取得元。新クライアントはパス・環境変数名だけを送る。 */
export interface ApiUsageCredential {
  mode: "automatic" | "custom" | "disabled" | "file" | "environment";
  apiKey?: string;
  path?: string;
  environmentVariable?: string;
  workspaceId?: string;
}
export interface ApiUsageCredentials {
  openai?: ApiUsageCredential;
  claude?: ApiUsageCredential;
  openaiExecution?: ApiUsageCredential;
  claudeExecution?: ApiUsageCredential;
}

/** 月内の Codex 追加クレジット消費（符号付き調整を含む）。UTC の暦月。 */
export interface CodexMonthlyCredits {
  month: string;
  credits: string;
  fetchedAt: string;
}

/**
 * アカウント全体の使用枠・残高（`account_usage_response`）の Codex 側。
 * App Server `account/rateLimits/read` 由来。`planType` は生値のまま運ぶ。
 */
export interface CodexAccountUsage {
  planType?: string;
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  weeklyPercent?: number;
  weeklyResetsAt?: string;
  credits?: CodexCredits;
  monthlyCredits?: CodexMonthlyCredits;
  monthlyCreditsError?: string;
  /** 獲得した利用枠リセットの残り回数。金額や無料 API クレジットではない。 */
  rateLimitResetCreditsAvailable?: number;
  /** ログイン中アカウントの**マスク済み**表示（`ClaudeAccountUsage.account` と同じ規約）。 */
  account?: string;
}

/** ホスト上で実行した `tailii doctor` 相当の 1 項目。 */
export interface HostDiagnosticCheck {
  /** 表示名と独立した安定識別子。 */
  id: string;
  label: string;
  ok: boolean;
  /** false の失敗は任意機能の未導入など、情報提供として扱う。 */
  required: boolean;
  detail: string;
  /** ホスト側で行う対処（実行コマンド、または設定画面の経路）。 */
  remediation?: string;
}

/**
 * ホスト環境の情報（`account_usage_response.host`, account-usage）。
 *
 * 全フィールド optional — 取得できたものだけ載せる。旧 host は `diagnostics` を送らないため、
 * iOS はバージョン行だけでも表示できる後方互換形を維持する。
 */
export interface HostVersions {
  /** tailii host（package.json version）。 */
  hostVersion?: string;
  /** `claude --version` 由来。 */
  claudeCliVersion?: string;
  /** `codex --version` 由来。 */
  codexCliVersion?: string;
  /** `tailii doctor` 相当の診断結果。 */
  diagnostics?: HostDiagnosticCheck[];
}

export type ControlMessage =
  /**
   * チャネル確立直後のバージョン交換。iOS→host は `clientVersion`(CFBundleShortVersionString) /
   * `clientBuild`(CFBundleVersion) を名乗り、host→iOS は `serverVersion` / `hostName` / `managed` /
   * `updateError` に加え、このホストへ接続した最も新しいアプリビルド `latestClientBuild` を広告する
   * （アプリ側の「より新しいビルドがある」判定に使う, host-auto-update）。
   */
  | { type: "channel_hello"; v: number; maxVersion: number; serverVersion?: string; hostName?: string; managed?: boolean; updateError?: string; clientVersion?: string; clientBuild?: string; latestClientBuild?: string }
  | { type: "host_update_request"; v: number; id: string; version: string; integrity?: string }
  | { type: "host_update_response"; v: number; id: string; status: HostUpdateStatus; error?: string | null }
  /**
   * `agentId` / `agentType`（additive, subagent-control）: サブエージェントが求めた承認なら、その id（Claude は hook の
   * `agent_id`、Codex は子 thread の id = subagent_node の nodeId）と種類。会話本体の承認は省略。
   */
  | { type: "approval_request"; v: number; id: string; tool: string; summary: string; cwd: string; diff?: ToolDiff; agentId?: string; agentType?: string }
  | { type: "approval_decision"; v: number; id: string; decision: Decision; reason?: string }
  | { type: "remote_pending"; v: number; id: string; session: string; kind: RemotePendingKind; tool?: string; summary: string }
  | { type: "remote_pending_cleared"; v: number; id: string; session: string; kind: RemotePendingKind }
  /**
   * 一覧の「待ち」ピルの snapshot（Mac→iOS, pending-question-snapshot）。engine が接続・Hub への再接続の
   * たびに、その kind で今待っている会話を全部送る。iOS はその kind のピルを丸ごと置き換える（載っていない
   * 会話のピルは消す）。待ちの解除（`remote_pending_cleared` / `question_dismiss`）は接続中にしか届かず、
   * 切断中に片付いた分のピルが残り続けるため、これで揃え直す。旧アプリは未知 type として捨てる。
   */
  | { type: "remote_pending_snapshot"; v: number; kind: RemotePendingKind; items: RemotePendingSnapshotItem[] }
  | { type: "session_list_request"; v: number; id: string; limit?: number; cursor?: string }
  | { type: "session_list_response"; v: number; id: string; sessions: SessionInfo[]; nextCursor?: string; adoptedName?: string; worktreePath?: string; worktreeRemoved?: boolean; worktreeDirty?: boolean; worktreeUncommittedCount?: number; worktreeUnmergedCommitCount?: number }
  | { type: "session_start"; v: number; id: string; cwd: string; name: string; baseDir?: string; resumeSessionId?: string; title?: string; agentType?: "claude" | "codex"; model?: string; permissionMode?: "default" | "acceptEdits" | "plan" | "auto"; effort?: "low" | "medium" | "high" | "xhigh" | "max"; codexModel?: string; codexSandbox?: "read-only" | "workspace-write" | "danger-full-access"; deferSubscribe?: boolean; outputStyle?: string; worktree?: string; todoTools?: boolean }
  /**
   * 会話の開き直し（iOS→host）。`newerThanMs` はキャッシュ済みログが追いついていた時刻（epoch ms,
   * reattach-since）。指定時は全履歴を頭から再送せず、この時刻より後の行だけを送る（古い順）。
   */
  | { type: "session_reattach"; v: number; id: string; name: string; newerThanMs?: number }
  | { type: "session_kill"; v: number; id: string; name: string }
  /**
   * 新規会話（Claude）の先行起動（session-prewarm）。ドラフトで打ち始めた時点で、送信時の session_start と
   * 同じ起動パラメータで Claude を裏で起動しておく。後の session_start が同じパラメータなら起動済みの
   * Claude をそのまま採用する。応答は無い（旧 host は未知 type を捨てる）。
   */
  | { type: "session_prewarm"; v: number; id: string; cwd: string; name: string; baseDir?: string; title?: string; model?: string; permissionMode?: "default" | "acceptEdits" | "plan" | "auto"; effort?: "low" | "medium" | "high" | "xhigh" | "max"; outputStyle?: string; todoTools?: boolean }
  /** 先行起動の取り消し（送らずにドラフトを離れた）。先行起動のまま使われていないものだけ閉じる。応答は無い。 */
  | { type: "session_prewarm_cancel"; v: number; id: string; name: string }
  | { type: "session_idle_hint"; v: number; id: string; name: string }
  | { type: "codex_model_list_request"; v: number; id: string }
  | { type: "codex_model_list_response"; v: number; id: string; models: CodexModelInfo[] }
  | { type: "codex_model_set_request"; v: number; id: string; session: string; model: string }
  | { type: "codex_model_set_response"; v: number; id: string; model: string; status: "updated" | "failed"; error?: string }
  | { type: "claude_model_list_request"; v: number; id: string }
  | { type: "claude_model_list_response"; v: number; id: string; models: ClaudeModelInfo[] }
  | { type: "official_app_status_request"; v: number; id: string; session: string; provider: OfficialAppProvider }
  | ({ type: "official_app_status_response"; v: number; id: string } & OfficialAppStatus)
  | {
      type: "official_app_action_request"; v: number; id: string; session: string;
      provider: OfficialAppProvider; action: OfficialAppAction; automaticEnable: boolean; paired: boolean;
    }
  | ({ type: "official_app_action_response"; v: number; id: string } & OfficialAppActionResult)
  | { type: "codex_turn_start"; v: number; id: string; session: string; text: string; clientUserMessageId?: string; effort?: string; approvalPolicy?: "untrusted" | "on-request" | "never"; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; explicitRetry?: boolean; collaborationMode?: CodexCollaborationMode }
  | { type: "codex_turn_start_result"; v: number; id: string; status: "started" | "duplicate" | "failed"; error?: string }
  | { type: "codex_turn_interrupt"; v: number; id: string; session: string }
  /**
   * Codex thread の目標を読む / 設定する / 解除する（iOS→Mac, codex-goal）。App Server の
   * `thread/goal/get|set|clear` へ写像する。`set` は指定したフィールドだけを更新する
   * （objective 省略で status だけの一時停止 / 再開、tokenBudget はトークン予算）。
   */
  | { type: "codex_goal_request"; v: number; id: string; session: string; action: CodexGoalAction; objective?: string; status?: string; tokenBudget?: number }
  /** `codex_goal_request` の結果（Mac→iOS）。`goal` は get / set 後の現在値（無ければ省略）。 */
  | { type: "codex_goal_response"; v: number; id: string; status: "ok" | "failed"; goal?: CodexGoalInfo; cleared?: boolean; error?: string }
  /**
   * 目標の現在値（Mac→iOS, 会話 stream に載る）。App Server の `thread/goal/updated` / `cleared`
   * と会話オープン時の読み取りから配る。`goal` 省略 = 目標なし。
   */
  | { type: "codex_goal_state"; v: number; session: string; goal?: CodexGoalInfo }
  | { type: "session_processing_state"; v: number; session: string; active: boolean }
  | {
      type: "chat_send"; v: number; id: string; session: string; clientMessageId: string; text: string;
      explicitRetry?: boolean;
      /**
       * この設問（`question_prompt` の id）に答えずに送る（chat-cancel-choice）。host は未回答の設問が
       * この id のときだけ、設問を Esc で閉じてから本文を送る。省略 / 別の設問 = 従来どおり回答まで保留。
       */
      cancelQuestionId?: string;
    }
  | { type: "chat_send_result"; v: number; id: string; status: "accepted" | "duplicate" | "failed"; error?: string }
  | { type: "pending_message_delete"; v: number; id: string; session: string; clientMessageId: string; kind: "chat" | "codex" }
  | { type: "pending_message_delete_result"; v: number; id: string; status: "deleted" | "not_found" | "processing" | "failed"; error?: string }
  /**
   * Claude 発話（`chat_send` の clientMessageId）の配送状態を、何も登録せずに照会する（iOS→host,
   * restored-receipt-probe）。`chat_send` と違い、未知の ID を新規として注入しない。iOS は ACK を
   * 取りこぼしたまま復元された配送不明の Outbox を、delivered / deleted のときだけ解決する。
   */
  | { type: "chat_receipt_query"; v: number; id: string; session: string; clientMessageId: string }
  | { type: "chat_receipt_query_result"; v: number; id: string; status: "delivered" | "deleted" | "uncertain" | "pending" | "unknown" }
  /**
   * 処理中の Claude が CLI 側のキューに溜めている発話を、今すぐ届ける（iOS→host, chat-send-now）。
   * CLI の `chat:sendNow`（ctrl+enter / ctrl+x ctrl+s）と同じ操作。実行中のツールは背景へ回り、
   * 応答の生成中ならそのターンを打ち切って、キュー済みの発話が届く。
   */
  | { type: "chat_send_now"; v: number; id: string; session: string }
  /**
   * `chat_send_now` の結果（host→iOS）。
   * - `sent`: キーを送り、キューの表示が消えたのを確かめた。
   * - `nothing_queued`: キュー済みの発話が画面に無い（1 キーも送っていない）。
   * - `blocked`: いまは送れない（ダイアログの表示中・入力欄に下書きがある等。1 キーも送っていない）。
   * - `failed`: キーは送ったが、届いたことを確かめられなかった / 送出に失敗した。
   */
  | { type: "chat_send_now_result"; v: number; id: string; status: "sent" | "nothing_queued" | "blocked" | "failed"; error?: string }
  | { type: "error"; v: number; id?: string; code: string; message: string }
  | { type: "image_available"; v: number; id: string; path: string; mime: string; thumbnail: string; width: number; height: number; relatedApprovalId?: string }
  /**
   * 画像原本の取得要求（iOS→host）。`maxPixelSize` は全画面表示に要る長辺の上限（px, image-fetch-display）。
   * 指定があれば host は長辺をそこまで縮めた HEIC を返す（縮めても軽くならないときは原本）。
   * 省略時・旧クライアントは従来どおり原本をそのまま返す。
   */
  | { type: "image_fetch_request"; v: number; id: string; maxPixelSize?: number }
  | { type: "image_fetch_response"; v: number; id: string; seq: number; data: string; eof: boolean; mime: string }
  /**
   * `before`（additive, agent-conversation-paging）: この位置（全件の通し番号）より前の 200 件を返す。
   * 省略時は最新の 200 件。応答の `omitted` は返した先頭の通し番号（= それより前の件数）。
   */
  | { type: "subagent_transcript_request"; v: number; id: string; nodeId: string; before?: number }
  /**
   * 会話履歴のページ取得（iOS→host, history-page）。`beforeStreamId` / `beforeToolId` の行より前の
   * 最後の `limit` 行ぶんを返す（どちらも無ければ最新のページ）。キャッシュの無い会話の初回表示と、
   * キャッシュより古い過去を遡るときに使う。
   */
  | { type: "history_page_request"; v: number; id: string; name: string; beforeStreamId?: string; beforeToolId?: string; limit: number }
  /**
   * 履歴ページ（host→iOS）。`lines` は全履歴の再送と同じ ControlMessage の wire 行（古い順）。
   * `hostNowMs` は読み始めた host の時刻（初回表示はここから少し巻き戻した `session_reattach.newerThanMs`
   * で続きを購読する）。
   */
  | { type: "history_page_response"; v: number; id: string; lines: string[]; hasMore: boolean; hostNowMs: number; anchorMissing?: boolean }
  | { type: "subagent_transcript_response"; v: number; id: string; nodeId: string; entries: SubagentTranscriptEntry[]; omitted: number }
  /** 同一 chat item の履歴/live stream ID 対応。直後の chat_output より先に配送する。 */
  | { type: "chat_stream_alias"; v: number; streamId: string; aliasStreamIds: string[] }
  | { type: "chat_output"; v: number; streamId: string; role: ChatRole; text: string; eof: boolean }
  | { type: "tool_activity"; v: number; activity: ToolActivity }
  | { type: "session_chat_stream_alias"; v: number; session: string; serverSeq: number; streamId: string; aliasStreamIds: string[] }
  | { type: "session_chat_output"; v: number; session: string; serverSeq: number; streamId: string; role: ChatRole; text: string; eof: boolean }
  | { type: "session_tool_activity"; v: number; session: string; serverSeq: number; activity: ToolActivity }
  | { type: "subagent_node"; v: number; node: SubagentNode }
  | {
      type: "pane_preview"; v: number; session: string; seq: number; active: boolean; text: string;
      /** 省略時は従来の Claude ステータス表示。Codex のみ terminal capture を指定する。 */
      mode?: "codex_terminal";
    }
  /**
   * claude TUI のプロンプト提案（空入力に薄字で出る次の一手）を前面会話へ配信する（host→iOS,
   * prompt-suggestion-chip）。`text` 空文字は提案なし（チップを隠す）。foreground 購読者にだけ届く。
   */
  | { type: "input_suggestion"; v: number; session: string; text: string }
  /**
   * 会話が待機中なのに claude TUI の入力欄へ未送信の文字（薄字の提案・プレースホルダーではない実テキスト）が
   * 残ったまま静止している（host→iOS, input-residue）。設問の回答キーが入力欄へ落ちた・端末で打ちかけた等で
   * 会話が止まって見えるのを、アプリで気づけるようにする。`text` 空文字は解消（表示を消す）。
   */
  | { type: "input_residue"; v: number; session: string; text: string }
  /**
   * 入力欄に残った文字（input_residue）の始末（iOS→host）。`submit` = Enter で送る / `clear` = 消す。
   * `text` はアプリが見た残留文字で、host はいまの入力欄が同じときだけ操作する（打ち足された・既に
   * 送られた入力を巻き込まない）。
   */
  | { type: "input_residue_action"; v: number; id: string; session: string; action: "submit" | "clear"; text: string }
  | { type: "input_residue_action_result"; v: number; id: string; ok: boolean; error: string | null }
  /** 一覧 Mission Control: 有効な間、処理中会話すべての pane_preview を配信する（iOS→host）。 */
  | { type: "session_preview_watch"; v: number; enabled: boolean }
  /**
   * セッションの死亡通知（host→iOS, live-pill Phase 2）。一覧 watch 有効中のクライアントにだけ
   * 送る「一覧を取り直せ」の合図。誕生イベントは出さない（`alive` は常に false）。
   */
  | { type: "session_liveness_event"; v: number; session: string; alive: boolean }
  | { type: "pane_choice_send"; v: number; id: string; session: string; key: string }
  | { type: "pane_choice_send_result"; v: number; id: string; ok: boolean; error: string | null }
  | { type: "pane_key_send"; v: number; id: string; session: string; key: string }
  | { type: "pane_key_send_result"; v: number; id: string; ok: boolean; error: string | null }
  /**
   * 中断（pane_key_send C-c / Escape）で claude が入力欄へ書き戻した「配送済みだが未処理の発話」を
   * host が検出・破棄したことの通知（host→iOS, prompt-cancelled）。`text` は transcript に記録済みの
   * 発話本文（iOS は同文の直近 user バブルを「中断で未処理」+ 再送に切り替える）。
   */
  | { type: "chat_prompt_cancelled"; v: number; session: string; text: string }
  /**
   * `/login` の OAuth コード送出要求（iOS→host, login-code）。転写カードのコード欄から、
   * 通常の chat 注入（入力欄検証・C-u クリアつき）を通さず、コード入力待ちの画面へ
   * literal + Enter で渡す。host はコード入力待ちでなければ ok=false で拒否する。
   */
  | { type: "login_code_send"; v: number; id: string; session: string; code: string }
  | { type: "login_code_send_result"; v: number; id: string; ok: boolean; error: string | null }
  /** 会話カスタムタイトルの端末表示追随（iOS→host, session-title）。空 title は解除=セッション名へ戻す。 */
  | { type: "session_title_set"; v: number; id: string; session: string; title: string }
  | { type: "session_title_set_result"; v: number; id: string; ok: boolean; error: string | null }
  /** Codex App Server の正式な thread.name を設定する。空 title はApp Serverが拒否する。 */
  | { type: "codex_thread_title_set"; v: number; id: string; threadId: string; title: string }
  | { type: "codex_thread_title_set_result"; v: number; id: string; ok: boolean; error: string | null }
  /**
   * 会話をホストから完全に削除する（iOS→host, conversation-delete）。host は会話を収容中の
   * Tailii セッションを終了し、Claude は会話記録ファイル、Codex は App Server `thread/delete` で消す。
   * Tailii 外（Mac の端末など）で実行中なら ok=false で拒否する。対象が既に無いのは ok=true。
   */
  | { type: "conversation_delete"; v: number; id: string; sessionId: string; agent: "claude" | "codex" }
  | { type: "conversation_delete_result"; v: number; id: string; ok: boolean; error: string | null; worktreePath?: string; worktreeRemoved?: boolean; worktreeDirty?: boolean; worktreeUncommittedCount?: number; worktreeUnmergedCommitCount?: number }
  | { type: "question_prompt"; v: number; id: string; questions: QuestionPromptQuestion[] }
  | { type: "question_answer"; v: number; id: string; session: string; answers: QuestionAnswer[] }
  | { type: "question_dismiss"; v: number; id: string }
  | {
      type: "usage_request"; v: number; id: string;
      /** ドラフト等、active session が無い画面の取得先。欠落は host が現行 session から解決する。 */
      agentType?: "claude" | "codex";
    }
  | {
      type: "usage_response"; v: number; id: string;
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; turns: number;
      fiveHourUtilization?: number; fiveHourResetsAt?: string;
      sevenDayUtilization?: number; sevenDayResetsAt?: string;
      sevenDayFableUtilization?: number; sevenDayFableResetsAt?: string;
    }
  /** アカウント使用量の要求（iOS→Mac, account-usage）。session 非依存 — 一覧からも呼べる。 */
  | { type: "api_usage_options_request"; v: number; id: string }
  | { type: "api_usage_options_response"; v: number; id: string; supported: boolean }
  | { type: "api_delegate_options_request"; v: number; id: string; keySources?: ApiUsageCredentials; claudeModels?: ApiClaudeModelsSelection }
  | { type: "api_delegate_key_register_request"; v: number; id: string; provider: "claude" | "openai"; apiKey: string }
  | { type: "api_delegate_key_register_response"; v: number; id: string; success: boolean; error?: string }
  | { type: "api_delegate_options_response"; v: number; id: string; supported: boolean; supportsAttachments?: boolean; supportsHistory?: boolean; supportsOpenAI?: boolean; federation?: ApiFederationOptions; hostApiKeys?: ApiDelegateHostKeys; claudeModels?: ApiClaudeModelsResult }
  | { type: "api_federation_check_request"; v: number; id: string; selection: ApiFederationSelection }
  | { type: "api_federation_check_response"; v: number; id: string; status: ApiFederationStatus }
  | { type: "api_federation_create_request"; v: number; id: string; configuration: ApiFederationConfiguration }
  | { type: "api_federation_create_response"; v: number; id: string; profile?: ApiFederationProfile; error?: string }
  | { type: "api_delegate_request"; v: number; id: string; request: ClaudeApiDelegateRequest }
  | { type: "api_delegate_response"; v: number; id: string; result?: ClaudeApiDelegateResult; error?: string }
  | { type: "api_delegate_cancel"; v: number; id: string }
  | { type: "account_usage_request"; v: number; id: string; apiCredentials?: ApiUsageCredentials }
  /**
   * アカウント使用量の応答（Mac→iOS, account-usage）。
   *
   * agent ごとに独立: 取得できた側だけ `claude`/`codex` を載せ、失敗した側は
   * オブジェクトを省略して `claudeError`/`codexError` に理由文を入れる（片側失敗でも
   * もう片側は表示できる）。`fetchedAt` は載せた値のうち最も古い取得時刻（ISO 8601）。
   * `host` は agent と独立したホスト環境のバージョン情報（取れなければ省略）。
   */
  | {
      type: "account_usage_response"; v: number; id: string;
      claude?: ClaudeAccountUsage; codex?: CodexAccountUsage;
      claudeError?: string; codexError?: string;
      openaiApi?: OpenAIApiUsage; openaiApiError?: string;
      claudeApi?: OpenAIApiUsage; claudeApiError?: string;
      host?: HostVersions;
      fetchedAt?: string;
    }
  | { type: "mode_get"; v: number; id: string; session: string }
  | { type: "mode_set"; v: number; id: string; session: string; mode: string }
  | { type: "mode_set_response"; v: number; id: string; mode: string }
  | { type: "slash_list_request"; v: number; id: string; cwd?: string }
  | { type: "slash_list_response"; v: number; id: string; commands: SlashCommandInfo[] }
  | { type: "peer_session_list_request"; v: number; id: string }
  | { type: "peer_session_list_response"; v: number; id: string; peers: PeerSessionInfo[] }
  | { type: "dir_list_request"; v: number; id: string; baseDir: string; partial: string }
  | { type: "dir_list_response"; v: number; id: string; entries: string[] }
  | { type: "browse_request"; v: number; id: string; path: string }
  | { type: "browse_response"; v: number; id: string; path: string; entries: string[]; canCreateDirectory?: boolean }
  | { type: "file_list_request"; v: number; id: string; path: string }
  | { type: "file_list_response"; v: number; id: string; path: string; entries: FileEntry[]; truncated: boolean }
  | { type: "file_read_request"; v: number; id: string; path: string }
  | ({ type: "file_read_response"; v: number; id: string } & FileReadResult)
  /** 名前検索（iOS→Mac, file-search）。`path` は検索起点の絶対ディレクトリ。`limit` は省略可（既定 200）。 */
  | { type: "file_search_request"; v: number; id: string; path: string; query: string; limit?: number }
  /** 名前検索応答（Mac→iOS）。`entries[].name` は `path` からの相対パス。 */
  | { type: "file_search_response"; v: number; id: string; path: string; query: string; entries: FileEntry[]; truncated: boolean }
  /** ファイル原本のダウンロード要求（iOS→Mac, file-download）。`path` は絶対パス。 */
  /** `offset` を付けると原本のその位置から末尾までを配る（受信しながらの再生で末尾の索引を先に取り寄せる）。 */
  | { type: "file_fetch_request"; v: number; id: string; path: string; offset?: number }
  /** ダウンロードの中止（iOS→Mac）。以降のチャンク配信を打ち切る。 */
  | { type: "file_fetch_cancel"; v: number; id: string }
  /** 原本の分割配信（Mac→iOS）。`seq` 昇順・最終チャンクで `eof:true`。失敗は `error` 付き単一チャンク。 */
  | ({ type: "file_fetch_response"; v: number; id: string } & FileFetchChunk)
  | { type: "git_status_request"; v: number; id: string; path: string }
  | { type: "git_status_response"; v: number; id: string; isRepo: boolean; branch: string; upstream: string | null; ahead: number; behind: number; files: GitStatusFile[]; repoRoot?: string; diffAdditions?: number; diffDeletions?: number }
  | { type: "git_diff_request"; v: number; id: string; path: string; file?: string; staged?: boolean; commit?: string | null }
  | { type: "git_diff_response"; v: number; id: string; isRepo: boolean; diff: string; truncated: boolean }
  | { type: "git_log_request"; v: number; id: string; path: string; limit?: number }
  | { type: "git_log_response"; v: number; id: string; isRepo: boolean; commits: GitCommitInfo[] }
  | { type: "git_branch_list_request"; v: number; id: string; path: string }
  | { type: "git_branch_list_response"; v: number; id: string; isRepo: boolean; branches: GitBranchInfo[] }
  | { type: "git_checkout_request"; v: number; id: string; path: string; branch: string; create: boolean }
  | { type: "git_checkout_response"; v: number; id: string; ok: boolean; branch: string; error: string | null }
  | { type: "git_discard_request"; v: number; id: string; path: string; files: string[] }
  | { type: "git_discard_response"; v: number; id: string; ok: boolean; error: string | null }
  | { type: "git_init_request"; v: number; id: string; path: string }
  | { type: "git_init_response"; v: number; id: string; ok: boolean; error: string | null }
  | { type: "git_worktree_create_request"; v: number; id: string; path: string; baseBranch: string }
  | { type: "git_worktree_create_response"; v: number; id: string; ok: boolean; branch: string; worktreePath: string; error: string | null }
  | { type: "git_worktree_remove_request"; v: number; id: string; path: string; force: boolean }
  | { type: "git_worktree_remove_response"; v: number; id: string; ok: boolean; error: string | null }
  | { type: "git_worktree_list_request"; v: number; id: string; path: string }
  | { type: "git_worktree_list_response"; v: number; id: string; isRepo: boolean; worktrees: GitWorktreeListItem[]; removedPaths?: string[] }
  | { type: "claude_session_list_request"; v: number; id: string }
  | {
      type: "claude_session_list_response"; v: number; id: string; claudeSessions: ClaudeSessionInfo[];
      /**
       * 生存セッションの join 済みを表す新旧判別マーカー（live-pill, additive）。
       * 新 host は join できたときだけ常に true を載せ、旧 host は載せない。
       * true のとき各行の `liveSessionName` 不在は「停止中の確定」を意味し、
       * 不在のとき iOS は従来の `session_list_request` との join へフォールバックする。
       */
      liveSessionsResolved?: boolean;
    }
  | { type: "dir_create_request"; v: number; id: string; baseDir: string; relative: string }
  | { type: "dir_create_response"; v: number; id: string; path: string; ok: boolean; error?: string }
  /** agents省略は全種別、[]は0件。cwdは完全一致＋worktreeのrepo正規化。いずれもlimitより前に適用。 */
  | { type: "session_search_request"; v: number; id: string; query: string; limit?: number; agents?: ("claude" | "codex")[]; cwd?: string }
  /** complete:false は累積の途中結果。省略/true は完了。supportsFilters:trueだけが絞込後limitを保証する。 */
  | { type: "session_search_response"; v: number; id: string; results: SessionSearchResult[]; complete?: boolean; supportsFilters?: boolean }
  | { type: "preview_open"; v: number; id: string; target: string }
  | { type: "preview_ready"; v: number; id: string; url: string }
  | { type: "preview_error"; v: number; id: string; message: string }
  | { type: "preview_close"; v: number; id: string }
  | { type: "serve_list_request"; v: number; id: string }
  | { type: "serve_list_response"; v: number; id: string; servers: ServeProcessInfo[] }
  | { type: "serve_stop_request"; v: number; id: string; pid: number; port: number }
  | { type: "serve_stop_response"; v: number; id: string; ok: boolean; error: string | null }
  /**
   * 背景同期の境界ヒント（iOS→Mac, background-sync-hints）。engine を張り直した直後に iOS が
   * 手元の会話ログごとに「この時刻以降だけ送ればよい」を伝える。応答は無い。
   */
  | { type: "background_sync_hints"; v: number; sessions: BackgroundSyncHint[] }
  /**
   * 会話ごとの動いているエージェント数（Mac→iOS, session-agent-count）。会話一覧の「エージェント N」。
   * `replace: true` は接続直後の全件（載っていない会話は 0）。旧アプリは未知 type として捨てる。
   */
  | { type: "session_agent_counts"; v: number; items: { session: string; running: number }[]; replace?: boolean }
  /** バックグラウンドタスクからのエージェント操作（前面の会話, subagent-control）。 */
  | { type: "subagent_control_request"; v: number; id: string; action: SubagentControlAction; nodeId?: string; text?: string }
  | { type: "subagent_control_response"; v: number; id: string; status: SubagentControlStatus; error?: string }
  /** バックグラウンドタスク一覧から背景コマンドを止める（前面の会話。nodeId = taskId）。 */
  | { type: "background_command_stop_request"; v: number; id: string; nodeId: string }
  | {
      type: "background_command_stop_response";
      v: number;
      id: string;
      nodeId: string;
      status: BackgroundCommandStopStatus;
      error?: string;
    }
  | { type: "backend_get_request"; v: number; id: string }
  | {
      type: "backend_get_response";
      v: number;
      id: string;
      backend: TerminalBackendKind;
      /** herdr バイナリが host に導入済みか（切替 UI の可用性表示）。 */
      herdrInstalled: boolean;
    }
  | { type: "backend_set_request"; v: number; id: string; backend: TerminalBackendKind }
  | {
      type: "backend_set_response";
      v: number;
      id: string;
      ok: boolean;
      backend: TerminalBackendKind;
      error: string | null;
    };

/** セッションを収容する端末バックエンド種別（backend_get/set, session-backend）。 */
export type TerminalBackendKind = "tmux" | "herdr";

export type ControlMessageType = ControlMessage["type"];
