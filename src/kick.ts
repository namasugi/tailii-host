// kick.ts
// tailii (TS host) — kick サブコマンド実装（test-only）
// Swift 版 Kick.swift の移植。
//
// 稼働中の tmux セッションへ `send-keys ... Enter` でプロンプトを注入する。
// E2E（承認1往復）の再現専用であり、プロダクトの導線には出さない非機能（test-only, Req 7.3）。
// tmux は絶対パス指定（PATH 外のため）。

import { spawnSync } from "node:child_process";
import { makeBackendForSession } from "./sessionBackend.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import { DEFAULT_TMUX_PATH } from "./tmux.js";

/**
 * kick の純ロジック。tmux パスを注入できるためテスト可能。
 * `tmux send-keys -t <session> <prompt> Enter` を実行する。指定セッションが存在しない、
 * あるいは tmux が非0終了/起動失敗した場合は errorSink にメッセージを出して非0 を返す。
 */
export function kickCore(
  session: string,
  prompt: string,
  tmuxPath: string,
  errorSink: (message: string) => void,
): number {
  // prompt は単一引数として渡す（tmux 側で1つのリテラル文字列として送出）。
  // 末尾の `Enter` が改行を送り、対話入力を確定させる。
  const result = spawnSync(tmuxPath, ["send-keys", "-t", session, prompt, "Enter"], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  if (result.error) {
    errorSink(`tailii kick: tmux 起動失敗 (${tmuxPath}): ${result.error.message}\n`);
    return 1;
  }
  const status = result.status ?? 1;
  if (status !== 0) {
    // 非存在セッション等で send-keys は非0 終了する（tmux が stderr に理由を出す）。
    errorSink(
      `tailii kick: send-keys 失敗（セッション '${session}' が存在しない可能性）: tmux exit ${status}\n`,
    );
    return status;
  }
  return 0;
}

/** kick サブコマンドの CLI エントリポイント。`--session <name>` と `--prompt <text>` を要求する。 */
export async function runKickCommand(args: string[]): Promise<number> {
  let sessionArg: string | null = null;
  let promptArg: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const next = (): string | null => (i + 1 < args.length ? args[++i]! : null);
    switch (args[i]) {
      case "--session":
        sessionArg = next();
        break;
      case "--prompt":
        promptArg = next();
        break;
      default:
        break;
    }
  }

  if (sessionArg === null || sessionArg.length === 0) {
    process.stderr.write("tailii kick: --session <name> が必要です\n");
    return 2;
  }
  if (promptArg === null) {
    process.stderr.write("tailii kick: --prompt <text> が必要です\n");
    return 2;
  }

  // herdr backend のセッションは herdr pane へ送出する（メタデータの backend 欄で判定）。
  const store = new SessionMetadataStore();
  if (store.get(sessionArg)?.backend === "herdr") {
    try {
      const backend = makeBackendForSession(sessionArg, store);
      await backend.sendTextSubmit(sessionArg, promptArg);
      return 0;
    } catch (error) {
      process.stderr.write(`tailii kick: herdr 送出失敗: ${String(error)}\n`);
      return 1;
    }
  }

  return kickCore(sessionArg, promptArg, DEFAULT_TMUX_PATH, (m) => process.stderr.write(m));
}
