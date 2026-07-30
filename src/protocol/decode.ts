// protocol/decode.ts
// NDJSON 1 行 → ControlMessage のデコード。未知 type / 非対応版 / 必須欠落は
// ProtocolDecodeError（呼び出し元は安全側 = 破棄/deny に倒す）。

import {
  PROTOCOL_LEGACY,
  PROTOCOL_MAX_SUPPORTED,
  type ClaudeAccountUsage,
  type CodexAccountUsage,
  type ClaudeSessionInfo,
  type ClaudeModelInfo,
  type CodexModelInfo,
  type ControlMessage,
  type FileEntry,
  type GitBranchInfo,
  type GitCommitInfo,
  type GitStatusFile,
  type HostVersions,
  type OfficialAppProvider,
  type QuestionAnswer,
  type RemotePendingKind,
  type ServeProcessInfo,
  type SessionInfo,
  type SessionSearchResult,
  type SubagentNode,
  type SubagentTranscriptEntry,
  type TerminalBackendKind,
  type ToolActivity,
  type ToolActivityDiff,
  type ToolActivityTodo,
  type ToolDiff,
} from "./messages.js";
import {
  compact,
  optionalBoolean,
  optionalNullableString,
  optionalNumber,
  optionalString,
  ProtocolDecodeError,
  requireArray,
  requireBoolean,
  requireNumber,
  requireObject,
  requireString,
  requireStringArray,
  type Raw,
} from "./common.js";

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
      return compact({ type, v, maxVersion: requireNumber(raw, "maxVersion"), serverVersion: optionalString(raw, "serverVersion") });

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

    case "remote_pending": {
      const kind = requireRemotePendingKind(raw);
      return compact({
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        kind,
        tool: optionalString(raw, "tool"),
        summary: requireString(raw, "summary"),
      });
    }

    case "remote_pending_cleared":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        kind: requireRemotePendingKind(raw),
      };

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
            claudeSessionId: optionalString(obj, "claudeSessionId"),
            agent:
              optionalString(obj, "agent") === "codex"
                ? "codex"
                : optionalString(obj, "agent") === "claude"
                  ? "claude"
                  : undefined,
            providerSessionId: optionalString(obj, "providerSessionId"),
            // 未知値は未指定（= tmux 相当）へ倒す（後方互換）。
            backend: optionalString(obj, "backend") === "herdr" ? "herdr" : undefined,
            displayTitle: optionalString(obj, "displayTitle"),
          });
        }),
        nextCursor: optionalString(raw, "nextCursor"),
        adoptedName: optionalString(raw, "adoptedName"),
        worktreePath: optionalString(raw, "worktreePath"),
        worktreeRemoved: optionalBoolean(raw, "worktreeRemoved"),
        worktreeDirty: optionalBoolean(raw, "worktreeDirty"),
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
      // permissionMode は既知 4 値のみ採用（claude 新規起動の --permission-mode）。未知/未指定は
      // undefined（フラグ無し＝claude 既定）。
      const rawMode = optionalString(raw, "permissionMode");
      const permissionMode =
        rawMode === "default" || rawMode === "acceptEdits" || rawMode === "plan" || rawMode === "auto"
          ? rawMode
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
        model: optionalString(raw, "model"),
        permissionMode,
        codexModel: optionalString(raw, "codexModel"),
        codexSandbox,
        deferSubscribe: optionalBoolean(raw, "deferSubscribe"),
      });
    }

    case "session_reattach":
    case "session_kill":
    case "session_idle_hint":
      return { type, v, id: requireString(raw, "id"), name: requireString(raw, "name") };

    case "codex_model_list_request":
      return { type, v, id: requireString(raw, "id") };

    case "codex_model_list_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        models: requireArray(raw, "models").map((element) => {
          const obj = requireObject(element, "models");
          const contextWindow = optionalNumber(obj, "contextWindow");
          if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
            throw new ProtocolDecodeError("missing-field", "models.contextWindow");
          }
          return compact<CodexModelInfo>({
            id: requireString(obj, "id"),
            displayName: requireString(obj, "displayName"),
            description: requireString(obj, "description"),
            contextWindow,
            defaultReasoningEffort: optionalString(obj, "defaultReasoningEffort"),
            supportedReasoningEfforts:
              obj["supportedReasoningEfforts"] === undefined
                ? undefined
                : requireStringArray(obj, "supportedReasoningEfforts"),
            isDefault: requireBoolean(obj, "isDefault"),
          });
        }),
      };

    case "claude_model_list_request":
      return { type, v, id: requireString(raw, "id") };

    case "claude_model_list_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        models: requireArray(raw, "models").map((element): ClaudeModelInfo => {
          const obj = requireObject(element, "models");
          return {
            id: requireString(obj, "id"),
            displayName: requireString(obj, "displayName"),
          };
        }),
      };

    case "official_app_status_request":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        provider: decodeOfficialAppProvider(raw, "provider"),
      };

    case "official_app_status_response": {
      const state = requireString(raw, "state");
      if (state !== "active" && state !== "inactive" && state !== "unavailable") {
        throw new ProtocolDecodeError("missing-field", "state");
      }
      return compact({
        type, v,
        id: requireString(raw, "id"),
        provider: decodeOfficialAppProvider(raw, "provider"),
        version: optionalString(raw, "version"),
        state,
        canOpen: requireBoolean(raw, "canOpen"),
        canStart: requireBoolean(raw, "canStart"),
        launchUrl: optionalString(raw, "launchUrl"),
        unavailableReason: optionalString(raw, "unavailableReason"),
      });
    }

    case "official_app_action_request": {
      const action = requireString(raw, "action");
      if (action !== "open" && action !== "repair" && action !== "stop") {
        throw new ProtocolDecodeError("missing-field", "action");
      }
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        provider: decodeOfficialAppProvider(raw, "provider"),
        action,
        automaticEnable: requireBoolean(raw, "automaticEnable"),
        paired: requireBoolean(raw, "paired"),
      };
    }

    case "official_app_action_response": {
      const outcome = requireString(raw, "outcome");
      if (
        outcome !== "open" &&
        outcome !== "pair" &&
        outcome !== "stopped" &&
        outcome !== "unavailable"
      ) {
        throw new ProtocolDecodeError("missing-field", "outcome");
      }
      return compact({
        type, v,
        id: requireString(raw, "id"),
        provider: decodeOfficialAppProvider(raw, "provider"),
        outcome,
        launchUrl: optionalString(raw, "launchUrl"),
        manualPairingCode: optionalString(raw, "manualPairingCode"),
        expiresAt: optionalNumber(raw, "expiresAt"),
        unavailableReason: optionalString(raw, "unavailableReason"),
      });
    }

    case "codex_turn_start":
      const rawTurnSandbox = optionalString(raw, "sandbox");
      const sandbox = rawTurnSandbox === "read-only" || rawTurnSandbox === "workspace-write" || rawTurnSandbox === "danger-full-access"
        ? rawTurnSandbox : undefined;
      const rawApprovalPolicy = optionalString(raw, "approvalPolicy");
      const approvalPolicy =
        rawApprovalPolicy === "untrusted" || rawApprovalPolicy === "on-request" || rawApprovalPolicy === "never"
          ? rawApprovalPolicy
          : undefined;
      return compact({
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        text: requireString(raw, "text"),
        clientUserMessageId: optionalString(raw, "clientUserMessageId"),
        effort: optionalString(raw, "effort"),
        approvalPolicy,
        sandbox,
        explicitRetry: optionalBoolean(raw, "explicitRetry"),
      });

    case "codex_turn_start_result": {
      const status = requireString(raw, "status");
      if (status !== "started" && status !== "duplicate" && status !== "failed") {
        throw new ProtocolDecodeError("missing-field", "status");
      }
      return compact({ type, v, id: requireString(raw, "id"), status, error: optionalString(raw, "error") });
    }

    case "codex_turn_interrupt":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
      };

    case "session_processing_state":
      return {
        type, v,
        session: requireString(raw, "session"),
        active: requireBoolean(raw, "active"),
      };

    case "chat_send": {
      const text = requireString(raw, "text");
      if (text.length === 0) throw new ProtocolDecodeError("missing-field", "text");
      return compact({
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        clientMessageId: requireString(raw, "clientMessageId"),
        text,
        explicitRetry: optionalBoolean(raw, "explicitRetry"),
      });
    }

    case "chat_send_result": {
      const status = requireString(raw, "status");
      if (status !== "accepted" && status !== "duplicate" && status !== "failed") {
        throw new ProtocolDecodeError("missing-field", "status");
      }
      return compact({ type, v, id: requireString(raw, "id"), status, error: optionalString(raw, "error") });
    }

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
    case "account_usage_request":
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

    case "subagent_transcript_request":
      return { type, v, id: requireString(raw, "id"), nodeId: requireString(raw, "nodeId") };

    case "subagent_transcript_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        nodeId: requireString(raw, "nodeId"),
        entries: requireArray(raw, "entries").map((element) => {
          const entry = requireObject(element, "entries");
          const role = requireString(entry, "role");
          if (role !== "user" && role !== "assistant" && role !== "tool") {
            throw new ProtocolDecodeError("missing-field", "entries.role");
          }
          const rawKind = optionalString(entry, "kind");
          const kind = role === "tool" && (rawKind === "tool_use" || rawKind === "tool_result")
            ? rawKind : undefined;
          return compact<SubagentTranscriptEntry>({
            role,
            text: requireString(entry, "text"),
            ts: optionalNumber(entry, "ts"),
            kind,
          });
        }),
        omitted: requireNumber(raw, "omitted"),
      };

    case "chat_stream_alias":
      return {
        type, v,
        streamId: requireString(raw, "streamId"),
        aliasStreamIds: requireStringArray(raw, "aliasStreamIds"),
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

    case "session_chat_stream_alias":
      return {
        type, v,
        session: requireString(raw, "session"),
        serverSeq: requireNumber(raw, "serverSeq"),
        streamId: requireString(raw, "streamId"),
        aliasStreamIds: requireStringArray(raw, "aliasStreamIds"),
      };

    case "session_chat_output": {
      const role = requireString(raw, "role");
      if (role !== "assistant" && role !== "user" && role !== "system") {
        throw new ProtocolDecodeError("missing-field", "role");
      }
      return {
        type, v,
        session: requireString(raw, "session"),
        serverSeq: requireNumber(raw, "serverSeq"),
        streamId: requireString(raw, "streamId"),
        role,
        text: requireString(raw, "text"),
        eof: requireBoolean(raw, "eof"),
      };
    }

    case "tool_activity":
      return { type, v, activity: decodeToolActivity(raw) };

    case "session_tool_activity":
      return {
        type, v,
        session: requireString(raw, "session"),
        serverSeq: requireNumber(raw, "serverSeq"),
        activity: decodeToolActivity(raw),
      };

    case "subagent_node":
      return { type, v, node: decodeSubagentNode(raw) };

    case "pane_preview": {
      const mode = optionalString(raw, "mode");
      if (mode !== undefined && mode !== "codex_terminal") {
        throw new ProtocolDecodeError("missing-field", "mode");
      }
      return compact({
        type, v,
        session: requireString(raw, "session"),
        seq: requireNumber(raw, "seq"),
        active: requireBoolean(raw, "active"),
        text: requireString(raw, "text"),
        mode,
      });
    }

    case "session_preview_watch":
      return { type, v, enabled: requireBoolean(raw, "enabled") };

    case "session_liveness_event":
      return {
        type, v,
        session: requireString(raw, "session"),
        alive: requireBoolean(raw, "alive"),
      };

    case "pane_choice_send":
    case "pane_key_send":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        key: requireString(raw, "key"),
      };

    case "pane_choice_send_result":
    case "pane_key_send_result":
    case "session_title_set_result":
      return {
        type, v,
        id: requireString(raw, "id"),
        ok: requireBoolean(raw, "ok"),
        error: optionalNullableString(raw, "error") ?? null,
      };

    case "session_title_set":
      return {
        type, v,
        id: requireString(raw, "id"),
        session: requireString(raw, "session"),
        title: requireString(raw, "title"),
      };

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

    case "account_usage_response":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        claude: decodeClaudeAccountUsage(raw["claude"]),
        codex: decodeCodexAccountUsage(raw["codex"]),
        claudeError: optionalString(raw, "claudeError"),
        codexError: optionalString(raw, "codexError"),
        host: decodeHostVersions(raw["host"]),
        fetchedAt: optionalString(raw, "fetchedAt"),
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

    case "file_list_request":
    case "file_read_request":
    case "git_status_request":
    case "git_branch_list_request":
    case "git_init_request":
      return { type, v, id: requireString(raw, "id"), path: requireString(raw, "path") };

    case "git_worktree_create_request":
      return {
        type, v, id: requireString(raw, "id"), path: requireString(raw, "path"),
        baseBranch: requireString(raw, "baseBranch"),
      };

    case "git_worktree_remove_request":
      return {
        type, v, id: requireString(raw, "id"), path: requireString(raw, "path"),
        force: requireBoolean(raw, "force"),
      };

    case "file_list_response":
      return {
        type, v,
        id: requireString(raw, "id"), path: requireString(raw, "path"),
        entries: requireArray(raw, "entries").map((element): FileEntry => {
          const entry = requireObject(element, "entries");
          const kind = requireString(entry, "kind");
          if (kind !== "dir" && kind !== "file" && kind !== "symlink") {
            throw new ProtocolDecodeError("missing-field", "entries.kind");
          }
          return compact<FileEntry>({
            name: requireString(entry, "name"), kind,
            size: requireNumber(entry, "size"), mtimeMs: requireNumber(entry, "mtimeMs"),
            gitStatus: optionalString(entry, "gitStatus"),
          });
        }),
        truncated: requireBoolean(raw, "truncated"),
      };

    case "file_read_response": {
      const kind = requireString(raw, "kind");
      if (kind !== "text" && kind !== "image" && kind !== "binary" &&
        kind !== "tooLarge" && kind !== "error") {
        throw new ProtocolDecodeError("missing-field", "kind");
      }
      return compact({
        type, v,
        id: requireString(raw, "id"), path: requireString(raw, "path"), kind,
        size: requireNumber(raw, "size"), mtimeMs: requireNumber(raw, "mtimeMs"),
        content: optionalString(raw, "content"), truncated: optionalBoolean(raw, "truncated"),
        imageBase64: optionalString(raw, "imageBase64"), imageFormat: optionalString(raw, "imageFormat"),
        error: optionalString(raw, "error"),
      });
    }

    case "git_status_response":
      return compact({
        type, v,
        id: requireString(raw, "id"), isRepo: requireBoolean(raw, "isRepo"),
        branch: requireString(raw, "branch"), upstream: optionalNullableString(raw, "upstream") ?? null,
        ahead: requireNumber(raw, "ahead"), behind: requireNumber(raw, "behind"),
        files: requireArray(raw, "files").map((element): GitStatusFile => {
          const file = requireObject(element, "files");
          return {
            path: requireString(file, "path"), indexStatus: requireString(file, "indexStatus"),
            worktreeStatus: requireString(file, "worktreeStatus"),
            renamedFrom: optionalNullableString(file, "renamedFrom") ?? null,
          };
        }),
        repoRoot: optionalString(raw, "repoRoot"),
        diffAdditions: optionalNumber(raw, "diffAdditions"),
        diffDeletions: optionalNumber(raw, "diffDeletions"),
      });

    case "git_diff_request":
      return compact({
        type, v, id: requireString(raw, "id"), path: requireString(raw, "path"),
        file: optionalString(raw, "file"), staged: optionalBoolean(raw, "staged"),
        commit: optionalNullableString(raw, "commit"),
      });

    case "git_diff_response":
      return {
        type, v, id: requireString(raw, "id"), isRepo: requireBoolean(raw, "isRepo"),
        diff: requireString(raw, "diff"), truncated: requireBoolean(raw, "truncated"),
      };

    case "git_log_request":
      return compact({
        type, v, id: requireString(raw, "id"), path: requireString(raw, "path"),
        limit: optionalNumber(raw, "limit"),
      });

    case "git_log_response":
      return {
        type, v, id: requireString(raw, "id"), isRepo: requireBoolean(raw, "isRepo"),
        commits: requireArray(raw, "commits").map((element): GitCommitInfo => {
          const commit = requireObject(element, "commits");
          return {
            hash: requireString(commit, "hash"), shortHash: requireString(commit, "shortHash"),
            subject: requireString(commit, "subject"), authorName: requireString(commit, "authorName"),
            dateMs: requireNumber(commit, "dateMs"),
          };
        }),
      };

    case "git_branch_list_response":
      return {
        type, v, id: requireString(raw, "id"), isRepo: requireBoolean(raw, "isRepo"),
        branches: requireArray(raw, "branches").map((element): GitBranchInfo => {
          const branch = requireObject(element, "branches");
          return {
            name: requireString(branch, "name"), subject: requireString(branch, "subject"),
            dateMs: requireNumber(branch, "dateMs"), isCurrent: requireBoolean(branch, "isCurrent"),
            ahead: requireNumber(branch, "ahead"), behind: requireNumber(branch, "behind"),
          };
        }),
      };

    case "git_checkout_request":
      return {
        type, v, id: requireString(raw, "id"), path: requireString(raw, "path"),
        branch: requireString(raw, "branch"), create: requireBoolean(raw, "create"),
      };

    case "git_checkout_response":
      return {
        type, v, id: requireString(raw, "id"), ok: requireBoolean(raw, "ok"),
        branch: requireString(raw, "branch"),
        error: optionalNullableString(raw, "error") ?? null,
      };

    case "git_discard_request":
      return {
        type, v, id: requireString(raw, "id"), path: requireString(raw, "path"),
        files: requireStringArray(raw, "files"),
      };

    case "git_discard_response":
    case "git_init_response":
    case "git_worktree_remove_response":
      return {
        type, v, id: requireString(raw, "id"), ok: requireBoolean(raw, "ok"),
        error: optionalNullableString(raw, "error") ?? null,
      };

    case "git_worktree_create_response":
      return {
        type, v, id: requireString(raw, "id"), ok: requireBoolean(raw, "ok"),
        branch: requireString(raw, "branch"), worktreePath: requireString(raw, "worktreePath"),
        error: optionalNullableString(raw, "error") ?? null,
      };

    case "claude_session_list_response":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        claudeSessions: requireArray(raw, "claudeSessions").map((element) => {
          const obj = requireObject(element, "claudeSessions");
          const rawSessionAgent = optionalString(obj, "agent");
          const sessionAgent =
            rawSessionAgent === "codex" || rawSessionAgent === "claude" ? rawSessionAgent : undefined;
          // live-pill: 生存セッション名が権威。バックエンドは名前があるときの enum のみ採る。
          const liveSessionName = optionalString(obj, "liveSessionName");
          const rawLiveBackend = optionalString(obj, "liveSessionBackend");
          const liveSessionBackend =
            liveSessionName !== undefined && (rawLiveBackend === "tmux" || rawLiveBackend === "herdr")
              ? rawLiveBackend
              : undefined;
          return compact<ClaudeSessionInfo>({
            sessionId: requireString(obj, "sessionId"),
            cwd: requireString(obj, "cwd"),
            title: requireString(obj, "title"),
            updatedAt: optionalNumber(obj, "updatedAt"),
            agent: sessionAgent,
            lastMessage: optionalString(obj, "lastMessage"),
            liveSessionName,
            liveSessionBackend,
          });
        }),
        liveSessionsResolved: optionalBoolean(raw, "liveSessionsResolved"),
      });

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

    case "session_search_request":
      return compact({
        type, v,
        id: requireString(raw, "id"),
        query: requireString(raw, "query"),
        limit: optionalNumber(raw, "limit"),
      });

    case "session_search_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        results: requireArray(raw, "results").map((element) => {
          const obj = requireObject(element, "results");
          return compact<SessionSearchResult>({
            sessionId: requireString(obj, "sessionId"),
            title: requireString(obj, "title"),
            cwd: requireString(obj, "cwd"),
            snippet: requireString(obj, "snippet"),
            updatedAt: optionalNumber(obj, "updatedAt"),
          });
        }),
      };

    case "preview_open":
      return {
        type, v,
        id: requireString(raw, "id"),
        target: requireString(raw, "target"),
      };

    case "preview_ready":
      return {
        type, v,
        id: requireString(raw, "id"),
        url: requireString(raw, "url"),
      };

    case "preview_error":
      return {
        type, v,
        id: requireString(raw, "id"),
        message: requireString(raw, "message"),
      };

    case "preview_close":
      return {
        type, v,
        id: requireString(raw, "id"),
      };

    case "serve_list_request":
      return { type, v, id: requireString(raw, "id") };

    case "serve_list_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        servers: requireArray(raw, "servers").map((element) => {
          const obj = requireObject(element, "servers");
          return compact<ServeProcessInfo>({
            pid: requireNumber(obj, "pid"),
            port: requireNumber(obj, "port"),
            command: requireString(obj, "command"),
            commandLine: optionalString(obj, "commandLine"),
            cwd: optionalString(obj, "cwd"),
            title: optionalString(obj, "title"),
          });
        }),
      };

    case "serve_stop_request":
      return {
        type, v,
        id: requireString(raw, "id"),
        pid: requireNumber(raw, "pid"),
        port: requireNumber(raw, "port"),
      };

    case "serve_stop_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        ok: requireBoolean(raw, "ok"),
        error: optionalNullableString(raw, "error") ?? null,
      };

    case "backend_get_request":
      return { type, v, id: requireString(raw, "id") };

    case "backend_get_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        backend: requireBackendKind(raw),
        herdrInstalled: requireBoolean(raw, "herdrInstalled"),
      };

    case "backend_set_request":
      return {
        type, v,
        id: requireString(raw, "id"),
        backend: requireBackendKind(raw),
      };

    case "backend_set_response":
      return {
        type, v,
        id: requireString(raw, "id"),
        ok: requireBoolean(raw, "ok"),
        backend: requireBackendKind(raw),
        error: optionalNullableString(raw, "error") ?? null,
      };

    default:
      throw new ProtocolDecodeError("unknown-type", type);
  }
}

/** `account_usage_response.claude` を読む（欠落は undefined = 「Claude 側は載っていない」）。 */
function decodeClaudeAccountUsage(value: unknown): ClaudeAccountUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = requireObject(value, "claude");
  return compact<ClaudeAccountUsage>({
    fiveHourPercent: optionalNumber(obj, "fiveHourPercent"),
    fiveHourResetsAt: optionalString(obj, "fiveHourResetsAt"),
    sevenDayPercent: optionalNumber(obj, "sevenDayPercent"),
    sevenDayResetsAt: optionalString(obj, "sevenDayResetsAt"),
    premiumPercent: optionalNumber(obj, "premiumPercent"),
    premiumResetsAt: optionalString(obj, "premiumResetsAt"),
    plan: optionalString(obj, "plan"),
    rateLimitTier: optionalString(obj, "rateLimitTier"),
    account: optionalString(obj, "account"),
  });
}

/** `account_usage_response.host` を読む（欠落は undefined = 「ホスト情報は載っていない」）。 */
function decodeHostVersions(value: unknown): HostVersions | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = requireObject(value, "host");
  return compact<HostVersions>({
    hostVersion: optionalString(obj, "hostVersion"),
    claudeCliVersion: optionalString(obj, "claudeCliVersion"),
    codexCliVersion: optionalString(obj, "codexCliVersion"),
  });
}

/** `account_usage_response.codex` を読む（欠落は undefined = 「Codex 側は載っていない」）。 */
function decodeCodexAccountUsage(value: unknown): CodexAccountUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = requireObject(value, "codex");
  return compact<CodexAccountUsage>({
    planType: optionalString(obj, "planType"),
    fiveHourPercent: optionalNumber(obj, "fiveHourPercent"),
    fiveHourResetsAt: optionalString(obj, "fiveHourResetsAt"),
    weeklyPercent: optionalNumber(obj, "weeklyPercent"),
    weeklyResetsAt: optionalString(obj, "weeklyResetsAt"),
    account: optionalString(obj, "account"),
  });
}

function requireBackendKind(raw: Raw): TerminalBackendKind {
  const backend = requireString(raw, "backend");
  if (backend !== "tmux" && backend !== "herdr") {
    throw new ProtocolDecodeError("missing-field", "backend");
  }
  return backend;
}

function requireRemotePendingKind(raw: Raw): RemotePendingKind {
  const kind = requireString(raw, "kind");
  if (kind !== "approval" && kind !== "question") {
    throw new ProtocolDecodeError("missing-field", "kind");
  }
  return kind;
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
  const kind = optionalString(raw, "kind");
  if (kind !== undefined && kind !== "command") {
    throw new ProtocolDecodeError("missing-field", "kind");
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
    kind,
  });
}

function decodeOfficialAppProvider(raw: Raw, key: string): OfficialAppProvider {
  const provider = requireString(raw, key);
  if (provider !== "claude" && provider !== "codex") {
    throw new ProtocolDecodeError("missing-field", key);
  }
  return provider;
}
