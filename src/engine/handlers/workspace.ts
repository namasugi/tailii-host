// engine/handlers/workspace.ts
// 作業ディレクトリまわり: slash コマンド候補・ディレクトリ候補/ブラウズ/作成・
// ファイル一覧（git バッジ付き）/読み取り。

import { dirCanCreate, dirChildren, dirCreate, dirList } from "../../services/dirLister.js";
import { fileFetch, fileList, fileRead } from "../../services/fileService.js";
import { gitEntryStatuses } from "../../services/gitService.js";
import { engineDiag, type HandlerRegistry } from "../context.js";
import { collectSlashCommands } from "../slashCommands.js";

/** 配信中の file_fetch（要求 id → 中止フラグ）。file_fetch_cancel で立て、配信ループが次チャンクで見る。 */
const activeFileFetches = new Map<string, { cancelled: boolean }>();

export const workspaceHandlers: HandlerRegistry = {
  slash_list_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // セッション/プロジェクト由来の slash command 候補をベストエフォートで収集する。
    const commands = collectSlashCommands(ctx.homeDir, message.cwd);
    try {
      writer.write({ type: "slash_list_response", v, id: message.id, commands });
    } catch (error) {
      process.stderr.write(
        `[tailii-host engine] slash_list_response 書込失敗: ${String(error)}\n`,
      );
    }
  },

  dir_list_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // ディレクトリ候補問い合わせ。base 外・不正・一致なしは空 entries（エラーにしない）。
    const entries = dirList(message.baseDir, message.partial);
    try {
      writer.write({ type: "dir_list_response", v, id: message.id, entries });
    } catch (error) {
      process.stderr.write(
        `[tailii-host engine] dir_list_response 書込失敗: ${String(error)}\n`,
      );
    }
  },

  browse_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // ディレクトリ非限定ブラウズ。不存在・読取不能は空 entries（エラーにしない）。
    engineDiag(`browse_request id=${message.id} path=${message.path}`);
    const entries = dirChildren(message.path);
    try {
      writer.write({
        type: "browse_response", v, id: message.id, path: message.path, entries,
        canCreateDirectory: dirCanCreate(message.path),
      });
      engineDiag(`browse_response id=${message.id} entries=${entries.length}`);
    } catch (error) {
      engineDiag(`browse_response 書込失敗 id=${message.id}: ${String(error)}`);
      process.stderr.write(
        `[tailii-host engine] browse_response 書込失敗: ${String(error)}\n`,
      );
    }
  },

  dir_create_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    // ディレクトリ作成。base 外/`..` 脱出は ok=false。
    const result = dirCreate(message.baseDir, message.relative);
    try {
      writer.write({
        type: "dir_create_response", v, id: message.id, path: result.path, ok: result.ok,
        error: result.error,
      });
    } catch (error) {
      process.stderr.write(
        `[tailii-host engine] dir_create_response 書込失敗: ${String(error)}\n`,
      );
    }
  },

  file_list_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
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
  },

  file_fetch_request: (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
    engineDiag(`file_fetch_request id=${message.id} path=${message.path}`);
    // 同一 id の再要求は前回を打ち切ってから始める（重複配信で seq が混ざるのを防ぐ）。
    const previous = activeFileFetches.get(message.id);
    if (previous !== undefined) previous.cancelled = true;
    const control = { cancelled: false };
    activeFileFetches.set(message.id, control);
    // 読み取りループは engine の read loop（handleLine を直列 await）を塞がないよう
    // 待たずに走らせる。中止要求（file_fetch_cancel）は並行して届く。
    void (async () => {
      try {
        for await (const chunk of fileFetch(message.path, { isCancelled: () => control.cancelled })) {
          if (control.cancelled) break;
          await writer.writeWithBackpressure({ type: "file_fetch_response", v, id: message.id, ...chunk });
        }
      } catch (error) {
        process.stderr.write(
          `[tailii-host engine] file_fetch_response 書込失敗 id=${message.id}: ${String(error)}\n`,
        );
      } finally {
        if (activeFileFetches.get(message.id) === control) activeFileFetches.delete(message.id);
      }
    })();
  },

  file_fetch_cancel: (message) => {
    engineDiag(`file_fetch_cancel id=${message.id}`);
    const control = activeFileFetches.get(message.id);
    if (control !== undefined) control.cancelled = true;
  },

  file_read_request: async (message, ctx) => {
    const { writer, state } = ctx;
    const v = state.negotiatedVersion;
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
  },
};
