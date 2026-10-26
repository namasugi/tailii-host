// vitest.config.ts — テストは必ず直列で実行する（プロジェクト規約）。
// tmux/ファイルシステム/pipe を使う統合テストが並走すると相互干渉するため、
// ファイル並列とファイル内並行の両方を無効化する。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

// テストの実行ごとに空の HOME を用意する（開発機の実物の `~/.tailii`・`~/.claude.json` に触れない）。以前は
// 既定のパスのままのテストが、稼働中の hub の中継へ実在しない会話の「処理中」・承認待ちを送り（hub の購読と
// iPhone へ届く）、`~/.tailii/chat-send.log` などへ書き、`~/.claude.json` を控えて書き戻し、hub の lock を
// 読んでいた（版が違うと ensureHubDaemon が稼働中の hub を止める）。2026-10-26 に実ログで確認。パスを個別に
// 差し替える方式は取りこぼすので、`os.homedir()` の基準そのものを替える。macOS の unix socket は 104 バイト
// までなので、短い名前にする（`<tmpdir>/tlh-XXXXXX/.tailii/run/engine-relay.sock`）。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-"));
// 実物の tmux サーバ（`/tmp/tmux-<uid>/default`）を使わせない。テストが tmux を起こすと、そのサーバは
// テストの HOME を環境に持つ。そこへ稼働中の host が会話を作ると、claude が別の HOME で起動しうる。
const tmuxTmpDir = path.join(testHome, "t");
fs.mkdirSync(tmuxTmpDir);
// 走り終えたら消す（test/globalSetupHome.ts。設定を読んだこのプロセスで動く）。
process.env.TAILII_TEST_HOME_DIR = testHome;

export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15_000,
    // HOME の隔離は子プロセス単位（forks）でしか効かない。threads 系では worker ごとの process.env は替わるが、
    // os.homedir() は実物を返す（独立検証 2026-10-26）。test/setupIsolation.ts が隔離を確かめる。
    pool: "forks",
    setupFiles: ["./test/setupIsolation.ts"],
    globalSetup: ["./test/globalSetupHome.ts"],
    env: {
      HOME: testHome,
      TMUX_TMPDIR: tmuxTmpDir,
      // reaper が開発機の実物 `~/.claude/sessions`（稼働中の Claude の状態）を読まないよう隔離する。
      // 既定の CodexAppServerManager が開発機の実物 `~/.codex`（daemon・lock・使用の印）に触れず、
      // 版ずれの入れ替えで実物の daemon を止めないよう隔離する。
      TAILII_CLAUDE_SESSIONS_DIR: "/nonexistent/tailii-test/claude-sessions",
      TAILII_CODEX_APP_SERVER_HOME: "/nonexistent/tailii-test/codex-home",
      TAILII_CODEX_APP_SERVER_REPLACE: "off",
    },
  },
});
