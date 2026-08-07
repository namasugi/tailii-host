// engineSelfUpdate.test.ts — host_update_request の Engine dispatch 検証
//
// updater の実起動(spawn)には至らない検証パスのみを叩く。開発ツリー上の実行は
// resolveInstallState が dev-install を返すため、upgrade 要求は unsupported で
// 止まり detached プロセスは発生しない（＝テストが実環境を書き換えない）。

import { describe, expect, test } from "vitest";
import { decodeControlMessage } from "../src/protocol.js";
import { readPackageVersion } from "../src/shared/version.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { MockTmuxRunner, startEngine } from "./helpers.js";

function makeManager(): TmuxSessionManager {
  return new TmuxSessionManager({
    runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner,
  });
}

describe("EngineControl — host_update_request", () => {
  test("channel_hello が managed フラグ(開発ツリーでは false)と serverVersion を広告する", async () => {
    const engine = startEngine({ sessionManager: makeManager() });
    try {
      const hello = decodeControlMessage(await engine.lines.nextOfType("channel_hello"));
      expect(hello).toMatchObject({ type: "channel_hello", managed: false });
      if (hello.type === "channel_hello") {
        expect(hello.serverVersion).toBe(readPackageVersion() ?? undefined);
      }
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("不正 version / 同版 / ダウングレード / dev-install を判定して応答する", async () => {
    const current = readPackageVersion();
    expect(current).not.toBeNull();
    const engine = startEngine({ sessionManager: makeManager() });
    await engine.lines.nextOfType("channel_hello");
    try {
      engine.writeLine(JSON.stringify({ type: "host_update_request", v: 1, id: "h1", version: "not-semver" }));
      expect(decodeControlMessage(await engine.lines.nextOfType("host_update_response"))).toMatchObject({
        id: "h1", status: "error",
      });

      engine.writeLine(JSON.stringify({ type: "host_update_request", v: 1, id: "h2", version: current }));
      expect(decodeControlMessage(await engine.lines.nextOfType("host_update_response"))).toMatchObject({
        id: "h2", status: "already", error: null,
      });

      engine.writeLine(JSON.stringify({ type: "host_update_request", v: 1, id: "h3", version: "0.0.1" }));
      expect(decodeControlMessage(await engine.lines.nextOfType("host_update_response"))).toMatchObject({
        id: "h3", status: "error",
      });

      // 開発ツリー（src/ が存在）では upgrade 要求は unsupported で止まる。
      engine.writeLine(JSON.stringify({ type: "host_update_request", v: 1, id: "h4", version: "99.99.99" }));
      expect(decodeControlMessage(await engine.lines.nextOfType("host_update_response"))).toMatchObject({
        id: "h4", status: "unsupported",
      });
    } finally {
      await engine.teardown();
    }
  }, 15_000);
});
