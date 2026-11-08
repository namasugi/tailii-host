// setupIsolation.ts — 各テストファイルの前に走る（vitest.config.ts の setupFiles）。
// テストを開発機の実物（稼働中の tmux / herdr / hub・`~/.tailii`・`~/.claude.json`）から切り離す。

import * as os from "node:os";
import * as path from "node:path";

// 実物の tmux / herdr を指す環境変数を外す（tmux の中で走らせると `$TMUX` が開発者のサーバを指す。herdr の中なら
// HERDR_* が実物の herdr を指す）。テストが起こす子プロセスにも引き継がせない。
// 登録済みの実 API キーをテストや子プロセスへ引き継がない（Costs API の実照会も防ぐ）。
for (const key of ["OPENAI_ADMIN_KEY", "OPENAI_ADMIN_API_KEY", "OPENAI_API_KEY", "OPENAI_ORG_ID",
  "ANTHROPIC_ADMIN_KEY", "ANTHROPIC_ADMIN_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[key];
for (const key of Object.keys(process.env)) {
  if (key === "TMUX" || key === "TMUX_PANE" || key.startsWith("HERDR_")) delete process.env[key];
}

// HOME の隔離が効いているかを確かめる（効いていなければ、実物の hub の中継・lock・ログへ書きにいく）。
// vitest の pool が threads 系だと、worker の process.env.HOME は替わっても os.homedir() は実物を返す。
const home = os.homedir();
if (home !== process.env.HOME || !path.basename(home).startsWith("tlh-")) {
  throw new Error(
    `テストの HOME が隔離されていません（os.homedir()=${home}）。vitest.config.ts の pool: "forks" を外さないでください`,
  );
}
