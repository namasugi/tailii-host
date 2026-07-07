// protocol.ts
// tailii (TS host) — NDJSON 制御チャネル v1 封筒定義とコーデック
//
// 本ファイルは Swift 版 host/Sources/tailii-host-core/Protocol.swift の移植。
// 正本はリポジトリルートの golden フィクスチャ:
//   protocol/approval-protocol-v0.ndjson（v 欠落 = v0 レガシー互換）
//   protocol/approval-protocol-v1.ndjson（v:1 代表行）
// 全行が byte-exact でラウンドトリップすることをテストで保証する（移植の受け入れ網）。
//
// エンコード規約（Swift 版と同一）:
// - キーは辞書順ソート（JSONEncoder .sortedKeys 相当）・スラッシュ非エスケープ・Unicode 生出力
// - undefined（nil）フィールドは出力しない
// - v === 0（v0 レガシー）は `v` フィールドを出力しない
// - v >= 1 は `v` を出力する

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
}

/** マシン内会話 1 件（claude=jsonl / codex=rollout）。 */
export interface ClaudeSessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt?: number;
  /** 会話を駆動するエージェント（claude=既定 / codex, agent-tag）。未指定は claude 相当。 */
  agent?: "claude" | "codex";
}

/** slash_list_response の 1 コマンド候補。 */
export interface SlashCommandInfo {
  name: string;
  summary: string;
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
export type Decision = "allow" | "deny";

export type ControlMessage =
  | { type: "channel_hello"; v: number; maxVersion: number }
  | { type: "approval_request"; v: number; id: string; tool: string; summary: string; cwd: string; diff?: ToolDiff }
  | { type: "approval_decision"; v: number; id: string; decision: Decision; reason?: string }
  | { type: "session_list_request"; v: number; id: string; limit?: number; cursor?: string }
  | { type: "session_list_response"; v: number; id: string; sessions: SessionInfo[]; nextCursor?: string }
  | { type: "session_start"; v: number; id: string; cwd: string; name: string; baseDir?: string; resumeSessionId?: string; title?: string; agentType?: "claude" | "codex"; codexModel?: string; codexSandbox?: "read-only" | "workspace-write" | "danger-full-access" }
  | { type: "session_reattach"; v: number; id: string; name: string }
  | { type: "session_kill"; v: number; id: string; name: string }
  | { type: "session_idle_hint"; v: number; id: string; name: string }
  | { type: "error"; v: number; id?: string; code: string; message: string }
  | { type: "image_available"; v: number; id: string; path: string; mime: string; thumbnail: string; width: number; height: number; relatedApprovalId?: string }
  | { type: "image_fetch_request"; v: number; id: string }
  | { type: "image_fetch_response"; v: number; id: string; seq: number; data: string; eof: boolean; mime: string }
  | { type: "chat_output"; v: number; streamId: string; role: ChatRole; text: string; eof: boolean }
  | { type: "tool_activity"; v: number; activity: ToolActivity }
  | { type: "subagent_node"; v: number; node: SubagentNode }
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
  | { type: "claude_session_list_request"; v: number; id: string }
  | { type: "claude_session_list_response"; v: number; id: string; claudeSessions: ClaudeSessionInfo[] }
  | { type: "dir_create_request"; v: number; id: string; baseDir: string; relative: string }
  | { type: "dir_create_response"; v: number; id: string; path: string; ok: boolean };

export type ControlMessageType = ControlMessage["type"];

// MARK: - デコードエラー

/** decode が投げる型付きエラー。呼び出し元は「決定未取得」として安全側（deny）に倒す。 */
export class ProtocolDecodeError extends Error {
  constructor(
    public readonly reason:
      | "invalid-json"
      | "missing-type"
      | "unknown-type"
      | "unsupported-version"
      | "legacy-unsupported-type"
      | "missing-field",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "ProtocolDecodeError";
  }
}

// MARK: - フィールド取り出しヘルパ

type Raw = Record<string, unknown>;

function requireString(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw new ProtocolDecodeError("missing-field", key);
  return value;
}

function optionalString(raw: Raw, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNullableString(raw: Raw, key: string): string | null | undefined {
  const value = raw[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function requireNumber(raw: Raw, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolDecodeError("missing-field", key);
  }
  return value;
}

function optionalNumber(raw: Raw, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireBoolean(raw: Raw, key: string): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") throw new ProtocolDecodeError("missing-field", key);
  return value;
}

function optionalBoolean(raw: Raw, key: string): boolean | undefined {
  const value = raw[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireObject(value: unknown, key: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolDecodeError("missing-field", key);
  }
  return value as Raw;
}

function requireArray(raw: Raw, key: string): unknown[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw new ProtocolDecodeError("missing-field", key);
  return value;
}

function requireStringArray(raw: Raw, key: string): string[] {
  return requireArray(raw, key).map((element) => {
    if (typeof element !== "string") throw new ProtocolDecodeError("missing-field", key);
    return element;
  });
}

/** undefined 値のキーを持たないオブジェクトを組み立てる（exactOptionalPropertyTypes 対応）。 */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// MARK: - decode

/** NDJSON 1 行（改行なし）を `ControlMessage` へデコードする。失敗は `ProtocolDecodeError`。 */
export function decodeControlMessage(line: string | Buffer): ControlMessage {
  const text = typeof line === "string" ? line : line.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolDecodeError("invalid-json", text.slice(0, 80));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolDecodeError("invalid-json", "not an object");
  }
  const raw = parsed as Raw;
  const type = raw["type"];
  if (typeof type !== "string") throw new ProtocolDecodeError("missing-type", text.slice(0, 80));

  // v 欠落 = v0 レガシー（承認 2 型のみ復元。他は破棄 = throw）。
  const rawV = raw["v"];
  const v = typeof rawV === "number" ? rawV : PROTOCOL_LEGACY;
  if (v > PROTOCOL_MAX_SUPPORTED) throw new ProtocolDecodeError("unsupported-version", String(v));
  if (v === PROTOCOL_LEGACY && type !== "approval_request" && type !== "approval_decision") {
    throw new ProtocolDecodeError("legacy-unsupported-type", type);
  }

  switch (type) {
    case "channel_hello":
      return { type, v, maxVersion: requireNumber(raw, "maxVersion") };

    case "approval_request":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        tool: requireString(raw, "tool"),
        summary: requireString(raw, "summary"),
        cwd: requireString(raw, "cwd"),
        diff: decodeToolDiff(raw["diff"]),
      });

    case "approval_decision": {
      const decision = requireString(raw, "decision");
      if (decision !== "allow" && decision !== "deny") {
        throw new ProtocolDecodeError("missing-field", "decision");
      }
      return compact({
        type, v,
        id: requireString(raw, "id"),
        decision,
        reason: optionalString(raw, "reason"),
      });
    }

    case "session_list_request":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        limit: optionalNumber(raw, "limit"),
        cursor: optionalString(raw, "cursor"),
      });

    case "session_list_response":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        sessions: requireArray(raw, "sessions").map((element) => {
          const obj = requireObject(element, "sessions");
          return compact<SessionInfo>({
            name: requireString(obj, "name"),
            cwd: requireString(obj, "cwd"),
            alive: requireBoolean(obj, "alive"),
            updatedAt: optionalNumber(obj, "updatedAt"),
          });
        }),
        nextCursor: optionalString(raw, "nextCursor"),
      });

    case "session_start": {
      // agentType は "claude"|"codex" のみ採用。未知値/未指定は undefined（host 側既定に委ねる）。
      const rawAgent = optionalString(raw, "agentType");
      const agentType = rawAgent === "codex" || rawAgent === "claude" ? rawAgent : undefined;
      // codexSandbox は既知 3 値のみ採用（codex-input）。未知/未指定は undefined（host 既定）。
      const rawSandbox = optionalString(raw, "codexSandbox");
      const codexSandbox =
        rawSandbox === "read-only" || rawSandbox === "workspace-write" || rawSandbox === "danger-full-access"
          ? rawSandbox
          : undefined;
      return compact({
        type, v,
        id: requireString(raw, "id"),
        cwd: requireString(raw, "cwd"),
        name: requireString(raw, "name"),
        baseDir: optionalString(raw, "baseDir"),
        resumeSessionId: optionalString(raw, "resumeSessionId"),
        title: optionalString(raw, "title"),
        agentType,
        codexModel: optionalString(raw, "codexModel"),
        codexSandbox,
      });
    }

    case "session_reattach":
    case "session_kill":
    case "session_idle_hint":
      return { type, v, id: requireString(raw, "id"), name: requireString(raw, "name") };

    case "error":
      return compact({
        type, v,
        id: optionalString(raw, "id"),
        code: requireString(raw, "code"),
        message: requireString(raw, "message"),
      });

    case "image_available":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        path: requireString(raw, "path"),
        mime: requireString(raw, "mime"),
        thumbnail: requireString(raw, "thumbnail"),
        width: requireNumber(raw, "width"),
        height: requireNumber(raw, "height"),
        relatedApprovalId: optionalString(raw, "relatedApprovalId"),
      });

    case "image_fetch_request":
    case "usage_request":
    case "question_dismiss":
    case "claude_session_list_request":
      return { type, v, id: requireString(raw, "id") };

    case "image_fetch_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        seq: requireNumber(raw, "seq"),
        data: requireString(raw, "data"),
        eof: requireBoolean(raw, "eof"),
        mime: requireString(raw, "mime"),
      };

    case "chat_output": {
      const role = requireString(raw, "role");
      if (role !== "assistant" && role !== "user" && role !== "system") {
        throw new ProtocolDecodeError("missing-field", "role");
      }
      return {
        type, v,
        streamId: requireString(raw, "streamId"),
        role,
        text: requireString(raw, "text"),
        eof: requireBoolean(raw, "eof"),
      };
    }

    case "tool_activity":
      return { type, v, activity: decodeToolActivity(raw) };

    case "subagent_node":
      return { type, v, node: decodeSubagentNode(raw) };

    case "question_prompt":
      return {
        type, v,
        id: requireString(raw, "id"),
        questions: requireArray(raw, "questions").map((element) => {
          const obj = requireObject(element, "questions");
          return {
            header: requireString(obj, "header"),
            question: requireString(obj, "question"),
            multiSelect: requireBoolean(obj, "multiSelect"),
            options: requireArray(obj, "options").map((option) => {
              const optionObj = requireObject(option, "options");
              return {
                label: requireString(optionObj, "label"),
                description: requireString(optionObj, "description"),
              };
            }),
          };
        }),
      };

    case "question_answer":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        answers: requireArray(raw, "answers").map((element) => {
          const obj = requireObject(element, "answers");
          return compact<QuestionAnswer>({
            questionIndex: requireNumber(obj, "questionIndex"),
            selectedOptionIndexes: requireArray(obj, "selectedOptionIndexes").map((index) => {
              if (typeof index !== "number") throw new ProtocolDecodeError("missing-field", "selectedOptionIndexes");
              return index;
            }),
            otherText: optionalString(obj, "otherText"),
            multiSelect: optionalBoolean(obj, "multiSelect") ?? false,
          });
        }),
      };

    case "usage_response":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        inputTokens: requireNumber(raw, "inputTokens"),
        outputTokens: requireNumber(raw, "outputTokens"),
        cacheReadTokens: requireNumber(raw, "cacheReadTokens"),
        cacheCreationTokens: requireNumber(raw, "cacheCreationTokens"),
        turns: requireNumber(raw, "turns"),
        fiveHourUtilization: optionalNumber(raw, "fiveHourUtilization"),
        fiveHourResetsAt: optionalString(raw, "fiveHourResetsAt"),
        sevenDayUtilization: optionalNumber(raw, "sevenDayUtilization"),
        sevenDayResetsAt: optionalString(raw, "sevenDayResetsAt"),
        sevenDayFableUtilization: optionalNumber(raw, "sevenDayFableUtilization"),
        sevenDayFableResetsAt: optionalString(raw, "sevenDayFableResetsAt"),
      });

    case "mode_get":
      return { type, v, id: requireString(raw, "id"), session: requireString(raw, "session") };

    case "mode_set":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        mode: requireString(raw, "mode"),
      };

    case "mode_set_response":
      return { type, v, id: requireString(raw, "id"), mode: requireString(raw, "mode") };

    case "slash_list_request":
      return compact({ type, v, id: requireString(raw, "id"), cwd: optionalString(raw, "cwd") });

    case "slash_list_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        commands: requireArray(raw, "commands").map((element) => {
          const obj = requireObject(element, "commands");
          return {
            name: requireString(obj, "name"),
            summary: requireString(obj, "summary"),
          };
        }),
      };

    case "dir_list_request":
      return {
        type, v,
        id: requireString(raw, "id"),
        baseDir: requireString(raw, "baseDir"),
        partial: requireString(raw, "partial"),
      };

    case "dir_list_response":
      return { type, v, id: requireString(raw, "id"), entries: requireStringArray(raw, "entries") };

    case "browse_request":
      return { type, v, id: requireString(raw, "id"), path: requireString(raw, "path") };

    case "browse_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        path: requireString(raw, "path"),
        entries: requireStringArray(raw, "entries"),
      };

    case "claude_session_list_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        claudeSessions: requireArray(raw, "claudeSessions").map((element) => {
          const obj = requireObject(element, "claudeSessions");
          const rawSessionAgent = optionalString(obj, "agent");
          const sessionAgent =
            rawSessionAgent === "codex" || rawSessionAgent === "claude" ? rawSessionAgent : undefined;
          return compact<ClaudeSessionInfo>({
            sessionId: requireString(obj, "sessionId"),
            cwd: requireString(obj, "cwd"),
            title: requireString(obj, "title"),
            updatedAt: optionalNumber(obj, "updatedAt"),
            agent: sessionAgent,
          });
        }),
      };

    case "dir_create_request":
      return {
        type, v,
        id: requireString(raw, "id"),
        baseDir: requireString(raw, "baseDir"),
        relative: requireString(raw, "relative"),
      };

    case "dir_create_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        path: requireString(raw, "path"),
        ok: requireBoolean(raw, "ok"),
      };

    default:
      throw new ProtocolDecodeError("unknown-type", type);
  }
}

function decodeToolDiff(value: unknown): ToolDiff | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = requireObject(value, "diff");
  const kind = requireString(obj, "kind");
  if (kind !== "create" && kind !== "edit") throw new ProtocolDecodeError("missing-field", "diff.kind");
  return compact<ToolDiff>({
    kind,
    path: requireString(obj, "path"),
    newText: optionalString(obj, "newText"),
    oldString: optionalString(obj, "oldString"),
    newString: optionalString(obj, "newString"),
  });
}

function decodeToolActivity(raw: Raw): ToolActivity {
  const diffValue = raw["diff"];
  let diff: ToolActivityDiff | undefined;
  if (diffValue !== undefined && diffValue !== null) {
    const obj = requireObject(diffValue, "diff");
    diff = compact<ToolActivityDiff>({
      oldString: optionalString(obj, "oldString"),
      newString: optionalString(obj, "newString"),
      oldStringTruncated: optionalBoolean(obj, "oldStringTruncated") ?? false,
      newStringTruncated: optionalBoolean(obj, "newStringTruncated") ?? false,
    });
  }
  const todosValue = raw["todos"];
  let todos: ToolActivityTodo[] | undefined;
  if (todosValue !== undefined && todosValue !== null) {
    if (!Array.isArray(todosValue)) throw new ProtocolDecodeError("missing-field", "todos");
    todos = todosValue.map((element) => {
      const obj = requireObject(element, "todos");
      return { content: requireString(obj, "content"), status: requireString(obj, "status") };
    });
  }
  return compact<ToolActivity>({
    id: requireString(raw, "id"),
    name: requireString(raw, "name"),
    label: requireString(raw, "label"),
    file: optionalString(raw, "file"),
    addedLines: optionalNumber(raw, "addedLines"),
    removedLines: optionalNumber(raw, "removedLines"),
    diff,
    command: optionalString(raw, "command"),
    commandTruncated: optionalBoolean(raw, "commandTruncated") ?? false,
    description: optionalString(raw, "description"),
    descriptionTruncated: optionalBoolean(raw, "descriptionTruncated") ?? false,
    todos,
  });
}

function decodeSubagentNode(raw: Raw): SubagentNode {
  const status = requireString(raw, "status");
  if (status !== "running" && status !== "completed" && status !== "error") {
    throw new ProtocolDecodeError("missing-field", "status");
  }
  return compact<SubagentNode>({
    nodeId: requireString(raw, "nodeId"),
    toolUseId: requireString(raw, "toolUseId"),
    parentNodeId: optionalNullableString(raw, "parentNodeId"),
    agentType: requireString(raw, "agentType"),
    label: requireString(raw, "label"),
    depth: requireNumber(raw, "depth"),
    status,
    currentActivity: optionalNullableString(raw, "currentActivity"),
    ts: requireNumber(raw, "ts"),
  });
}

// MARK: - encode

/** `ControlMessage` を canonical NDJSON 1 行（改行なし）へエンコードする。 */
export function encodeControlMessage(message: ControlMessage): string {
  return JSON.stringify(canonicalize(wireObject(message)));
}

/** 型ごとの wire オブジェクトを組み立てる（v0 は v キーを持たない）。 */
function wireObject(message: ControlMessage): Raw {
  const out: Raw = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === "v" || key === "activity" || key === "node" || value === undefined) continue;
    out[key] = value;
  }
  if (message.v !== PROTOCOL_LEGACY) out["v"] = message.v;

  if (message.type === "tool_activity") {
    const activity = message.activity;
    out["id"] = activity.id;
    out["name"] = activity.name;
    out["label"] = activity.label;
    if (activity.file !== undefined) out["file"] = activity.file;
    if (activity.addedLines !== undefined) out["addedLines"] = activity.addedLines;
    if (activity.removedLines !== undefined) out["removedLines"] = activity.removedLines;
    if (activity.diff !== undefined) {
      const diff: Raw = {
        oldStringTruncated: activity.diff.oldStringTruncated,
        newStringTruncated: activity.diff.newStringTruncated,
      };
      if (activity.diff.oldString !== undefined) diff["oldString"] = activity.diff.oldString;
      if (activity.diff.newString !== undefined) diff["newString"] = activity.diff.newString;
      out["diff"] = diff;
    }
    if (activity.command !== undefined) {
      out["command"] = activity.command;
      out["commandTruncated"] = activity.commandTruncated;
    }
    if (activity.description !== undefined) {
      out["description"] = activity.description;
      out["descriptionTruncated"] = activity.descriptionTruncated;
    }
    if (activity.todos !== undefined) out["todos"] = activity.todos;
  }

  if (message.type === "subagent_node") {
    const node = message.node;
    out["agentType"] = node.agentType;
    if (node.currentActivity !== undefined) out["currentActivity"] = node.currentActivity;
    out["depth"] = node.depth;
    out["label"] = node.label;
    out["nodeId"] = node.nodeId;
    if (node.parentNodeId !== undefined) out["parentNodeId"] = node.parentNodeId;
    out["status"] = node.status;
    out["toolUseId"] = node.toolUseId;
    out["ts"] = node.ts;
  }

  return out;
}

/** オブジェクトのキーを再帰的に辞書順へ並べ替える（JSONEncoder .sortedKeys 相当）。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const sorted: Raw = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Raw)[key];
      if (inner !== undefined) sorted[key] = canonicalize(inner);
    }
    return sorted;
  }
  return value;
}
