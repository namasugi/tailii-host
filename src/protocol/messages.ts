// protocol/messages.ts
// ワイヤー仕様の型定義: プロトコル版数・支援型・ControlMessage（タグ付き union）。
// 正本は root protocol/control-channel.md + golden フィクスチャ（goldenSync で同期検知）。

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
}

/** セッション一覧応答の 1 要素。 */
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
}

/** マシン内会話 1 件（claude=jsonl / codex=rollout）。 */
export interface ClaudeSessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt?: number;
  /** 会話を駆動するエージェント（claude=既定 / codex, agent-tag）。未指定は claude 相当。 */
  agent?: "claude" | "codex";
  /** 最終 user/assistant メッセージの 1 行スニペット（一覧プレビュー, list-preview）。 */
  lastMessage?: string;
}

/** session_search_response の 1 検索結果。 */
export interface SessionSearchResult {
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

/** AskUserQuestion の選択肢。 */
export interface QuestionOption {
  label: string;
  description: string;
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

export type ControlMessage =
  | { type: "channel_hello"; v: number; maxVersion: number; serverVersion?: string }
  | { type: "approval_request"; v: number; id: string; tool: string; summary: string; cwd: string; diff?: ToolDiff }
  | { type: "approval_decision"; v: number; id: string; decision: Decision; reason?: string }
  | { type: "remote_pending"; v: number; id: string; session: string; kind: RemotePendingKind; tool?: string; summary: string }
  | { type: "remote_pending_cleared"; v: number; id: string; session: string; kind: RemotePendingKind }
  | { type: "session_list_request"; v: number; id: string; limit?: number; cursor?: string }
  | { type: "session_list_response"; v: number; id: string; sessions: SessionInfo[]; nextCursor?: string; adoptedName?: string; worktreePath?: string; worktreeRemoved?: boolean; worktreeDirty?: boolean }
  | { type: "session_start"; v: number; id: string; cwd: string; name: string; baseDir?: string; resumeSessionId?: string; title?: string; agentType?: "claude" | "codex"; model?: string; permissionMode?: "default" | "acceptEdits" | "plan" | "auto"; codexModel?: string; codexSandbox?: "read-only" | "workspace-write" | "danger-full-access"; deferSubscribe?: boolean }
  | { type: "session_reattach"; v: number; id: string; name: string }
  | { type: "session_kill"; v: number; id: string; name: string }
  | { type: "session_idle_hint"; v: number; id: string; name: string }
  | { type: "codex_model_list_request"; v: number; id: string }
  | { type: "codex_model_list_response"; v: number; id: string; models: CodexModelInfo[] }
  | { type: "official_app_status_request"; v: number; id: string; session: string; provider: OfficialAppProvider }
  | ({ type: "official_app_status_response"; v: number; id: string } & OfficialAppStatus)
  | {
      type: "official_app_action_request"; v: number; id: string; session: string;
      provider: OfficialAppProvider; action: OfficialAppAction; automaticEnable: boolean; paired: boolean;
    }
  | ({ type: "official_app_action_response"; v: number; id: string } & OfficialAppActionResult)
  | { type: "codex_turn_start"; v: number; id: string; session: string; text: string; clientUserMessageId?: string; effort?: string; approvalPolicy?: "untrusted" | "on-request" | "never"; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; explicitRetry?: boolean }
  | { type: "codex_turn_start_result"; v: number; id: string; status: "started" | "duplicate" | "failed"; error?: string }
  | { type: "codex_turn_interrupt"; v: number; id: string; session: string }
  | { type: "session_processing_state"; v: number; session: string; active: boolean }
  | { type: "chat_send"; v: number; id: string; session: string; clientMessageId: string; text: string; explicitRetry?: boolean }
  | { type: "chat_send_result"; v: number; id: string; status: "accepted" | "duplicate" | "failed"; error?: string }
  | { type: "error"; v: number; id?: string; code: string; message: string }
  | { type: "image_available"; v: number; id: string; path: string; mime: string; thumbnail: string; width: number; height: number; relatedApprovalId?: string }
  | { type: "image_fetch_request"; v: number; id: string }
  | { type: "image_fetch_response"; v: number; id: string; seq: number; data: string; eof: boolean; mime: string }
  | { type: "subagent_transcript_request"; v: number; id: string; nodeId: string }
  | { type: "subagent_transcript_response"; v: number; id: string; nodeId: string; entries: SubagentTranscriptEntry[]; omitted: number }
  | { type: "chat_output"; v: number; streamId: string; role: ChatRole; text: string; eof: boolean }
  | { type: "tool_activity"; v: number; activity: ToolActivity }
  | { type: "session_chat_output"; v: number; session: string; serverSeq: number; streamId: string; role: ChatRole; text: string; eof: boolean }
  | { type: "session_tool_activity"; v: number; session: string; serverSeq: number; activity: ToolActivity }
  | { type: "subagent_node"; v: number; node: SubagentNode }
  | {
      type: "pane_preview"; v: number; session: string; seq: number; active: boolean; text: string;
      /** 省略時は従来の Claude ステータス表示。Codex のみ terminal capture を指定する。 */
      mode?: "codex_terminal";
    }
  | { type: "pane_choice_send"; v: number; id: string; session: string; key: string }
  | { type: "pane_choice_send_result"; v: number; id: string; ok: boolean; error: string | null }
  | { type: "pane_key_send"; v: number; id: string; session: string; key: string }
  | { type: "pane_key_send_result"; v: number; id: string; ok: boolean; error: string | null }
  | { type: "question_prompt"; v: number; id: string; questions: QuestionPromptQuestion[] }
  | { type: "question_answer"; v: number; id: string; session: string; answers: QuestionAnswer[] }
  | { type: "question_dismiss"; v: number; id: string }
  | { type: "usage_request"; v: number; id: string }
  | {
      type: "usage_response"; v: number; id: string;
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; turns: number;
      fiveHourUtilization?: number; fiveHourResetsAt?: string;
      sevenDayUtilization?: number; sevenDayResetsAt?: string;
      sevenDayFableUtilization?: number; sevenDayFableResetsAt?: string;
    }
  | { type: "mode_get"; v: number; id: string; session: string }
  | { type: "mode_set"; v: number; id: string; session: string; mode: string }
  | { type: "mode_set_response"; v: number; id: string; mode: string }
  | { type: "slash_list_request"; v: number; id: string; cwd?: string }
  | { type: "slash_list_response"; v: number; id: string; commands: SlashCommandInfo[] }
  | { type: "dir_list_request"; v: number; id: string; baseDir: string; partial: string }
  | { type: "dir_list_response"; v: number; id: string; entries: string[] }
  | { type: "browse_request"; v: number; id: string; path: string }
  | { type: "browse_response"; v: number; id: string; path: string; entries: string[] }
  | { type: "file_list_request"; v: number; id: string; path: string }
  | { type: "file_list_response"; v: number; id: string; path: string; entries: FileEntry[]; truncated: boolean }
  | { type: "file_read_request"; v: number; id: string; path: string }
  | ({ type: "file_read_response"; v: number; id: string } & FileReadResult)
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
  | { type: "claude_session_list_request"; v: number; id: string }
  | { type: "claude_session_list_response"; v: number; id: string; claudeSessions: ClaudeSessionInfo[] }
  | { type: "dir_create_request"; v: number; id: string; baseDir: string; relative: string }
  | { type: "dir_create_response"; v: number; id: string; path: string; ok: boolean }
  | { type: "session_search_request"; v: number; id: string; query: string; limit?: number }
  | { type: "session_search_response"; v: number; id: string; results: SessionSearchResult[] }
  | { type: "preview_open"; v: number; id: string; target: string }
  | { type: "preview_ready"; v: number; id: string; url: string }
  | { type: "preview_error"; v: number; id: string; message: string }
  | { type: "preview_close"; v: number; id: string }
  | { type: "serve_list_request"; v: number; id: string }
  | { type: "serve_list_response"; v: number; id: string; servers: ServeProcessInfo[] }
  | { type: "serve_stop_request"; v: number; id: string; pid: number; port: number }
  | { type: "serve_stop_response"; v: number; id: string; ok: boolean; error: string | null }
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
