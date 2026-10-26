// globalSetupHome.ts — vitest.config.ts が実行ごとに作るテスト用の HOME を、走り終えたら消す。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export default function setup(): () => void {
  return () => {
    const home = process.env.TAILII_TEST_HOME_DIR;
    if (home === undefined || !path.basename(home).startsWith("tlh-")) return;
    // 一時ディレクトリの直下に作ったものだけを消す（取り違えて別の場所を消さない）。
    const parent = fs.realpathSync(path.dirname(home));
    if (parent !== fs.realpathSync(os.tmpdir())) return;
    fs.rmSync(home, { recursive: true, force: true });
  };
}
