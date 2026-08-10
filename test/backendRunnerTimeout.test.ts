// backendRunnerTimeout.test.ts — tmux / herdr ランナーが応答しないコマンドで詰まらないこと。
//
// 両ランナーは engine の read loop（`await handleLine` の直列処理）と hub の tick ループから
// 直接 await される。無期限に待つと「以後 iOS からの全メッセージを読まない」「巡回が全停止」
// が同時に起き、会話も一覧も更新されなくなる（今回直した `requestHubState` と同型のクラス）。
// 実 tmux/herdr を wedge させる代わりに、引数を無視して待ち続けるスクリプトで同じ形を作る。

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { processTmuxCommandRunner } from "../src/backend/tmux.js";
import { processHerdrCommandRunner } from "../src/backend/herdr.js";
import { makeTempDir } from "./helpers.js";

const TIMEOUT_MS = 300;

/** 引数を一切見ずにぶら下がる実行ファイル（wedge した tmux / herdr の代役）。 */
function makeHangingExecutable(): string {
  const file = path.join(makeTempDir("backend-runner-timeout"), "hang.sh");
  fs.writeFileSync(file, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  return file;
}

describe("backend ランナーのタイムアウト", () => {
  test("tmux ランナーは応答しないコマンドを有限時間で失敗として返す", async () => {
    const runner = processTmuxCommandRunner(makeHangingExecutable(), TIMEOUT_MS);
    const started = Date.now();
    const result = await runner(["ls", "-F", "#{session_name}"]);
    const elapsed = Date.now() - started;

    // 即死ではなく「タイムアウトまで待って打ち切った」ことを確かめる（テストの空振り防止）。
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(5_000);
    // 起動自体は成功しているので throw ではなく「非 0 終了」として返る。
    // liveTailiiSessions はこれを "no server running" 以外の失敗として throw し、
    // hub の tick が catch して liveCount=1 で継続する（セッションを誤って回収しない）。
    expect(result.exitCode).not.toBe(0);
  });

  test("herdr ランナーは応答しないコマンドを有限時間で失敗として返す", async () => {
    const runner = processHerdrCommandRunner(makeHangingExecutable(), "tailii", TIMEOUT_MS);
    const started = Date.now();
    const result = await runner(["pane", "list"]);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(5_000);
    expect(result.exitCode).not.toBe(0);
  });

  test("起動できない実行ファイルは従来どおり throw する（境界を変えていない）", async () => {
    const runner = processTmuxCommandRunner("/nonexistent/tmux", TIMEOUT_MS);
    await expect(runner(["ls"])).rejects.toThrow();
  });
});
