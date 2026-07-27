// engine/handlers/git.ts
// git ブラウズ/操作: status・diff・log・branch 一覧・checkout・discard・init・
// worktree 作成/削除。失敗は各 response の空/ok=false 形で返し error 封筒にしない。

import {
  gitBranchList,
  gitCheckout,
  gitDiff,
  gitDiscard,
  gitInit,
  gitLog,
  gitStatus,
  gitWorktreeCreate,
  gitWorktreeRemove,
} from "../../services/gitService.js";
import { engineDiag, type HandlerRegistry } from "../context.js";

export const gitHandlers: HandlerRegistry = {
  git_status_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
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
  },

  git_diff_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const response = await gitDiff(message.path, {
        file: message.file, staged: message.staged, commit: message.commit,
      });
      writer.write({ type: "git_diff_response", v, id: message.id, ...response });
    } catch (error) {
      engineDiag(`git_diff_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "git_diff_response", v, id: message.id, isRepo: false, diff: "", truncated: false });
    }
  },

  git_log_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const response = await gitLog(message.path, message.limit);
      writer.write({ type: "git_log_response", v, id: message.id, ...response });
    } catch (error) {
      engineDiag(`git_log_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "git_log_response", v, id: message.id, isRepo: false, commits: [] });
    }
  },

  git_branch_list_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const response = await gitBranchList(message.path);
      writer.write({ type: "git_branch_list_response", v, id: message.id, ...response });
    } catch (error) {
      engineDiag(`git_branch_list_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "git_branch_list_response", v, id: message.id, isRepo: false, branches: [] });
    }
  },

  git_checkout_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
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
  },

  git_discard_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const response = await gitDiscard(message.path, message.files);
      writer.write({ type: "git_discard_response", v, id: message.id, ...response });
    } catch (error) {
      engineDiag(`git_discard_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "git_discard_response", v, id: message.id, ok: false, error: String(error) });
    }
  },

  git_init_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const response = await gitInit(message.path);
      writer.write({ type: "git_init_response", v, id: message.id, ...response });
    } catch (error) {
      engineDiag(`git_init_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "git_init_response", v, id: message.id, ok: false, error: String(error) });
    }
  },

  git_worktree_create_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
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
  },

  git_worktree_remove_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    try {
      const response = await gitWorktreeRemove(message.path, message.force);
      writer.write({ type: "git_worktree_remove_response", v, id: message.id, ...response });
    } catch (error) {
      engineDiag(`git_worktree_remove_response 失敗 id=${message.id}: ${String(error)}`);
      writer.write({ type: "git_worktree_remove_response", v, id: message.id, ok: false, error: String(error) });
    }
  },
};
