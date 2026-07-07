// vitest.config.ts — テストは必ず直列で実行する（プロジェクト規約）。
// tmux/ファイルシステム/pipe を使う統合テストが並走すると相互干渉するため、
// ファイル並列とファイル内並行の両方を無効化する。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15_000,
  },
});
