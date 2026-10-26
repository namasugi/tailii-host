// engineBackendUnavailable.test.ts — 片方の backend が答えられないとき（tmux の socket ファイルが無い等）の会話の
// 開き直しと、要求の処理が投げても engine（= アプリとの接続）を落とさないこと（独立検証 2026-10-26）。

import { describe, expect, test } from "vitest";
import { CompositeSessionBackend } from "../src/backend/sessionBackend.js";
import { HerdrSessionManager } from "../src/backend/herdr.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { RESUME_BLOCKED_BY_UNAVAILABLE_BACKEND } from "../src/engine/handlers/session.js";
import type { EngineLauncher } from "../src/engine/engine.js";
import { decodeControlMessage } from "../src/protocol.js";
import { writeHeartbeat } from "../src/sessions/heartbeat.js";
import { MockTmuxRunner, makeTempDir, makeTempStore, startEngine } from "./helpers.js";

/** tmux の socket ファイルが無いときの `tmux ls`（tmux 3.7 実測）。見えないだけでサーバが動いていることがある。 */
const ENOENT = {
  exitCode: 1, stdout: "", stderr: "error connecting to /private/tmp/tmux-502/default (No such file or directory)",
};
/** herdr の模型: `livePanes` の pane が生きていて、前面は claude。 */
function herdrRunner(livePanes: Array<{ pane_id: string; label: string }> = []) {
  return async (args: string[]) => {
    if (args[0] === "pane" && args[1] === "list") {
      return { exitCode: 0, stdout: JSON.stringify({ result: { panes: livePanes.map((pane) => ({ ...pane, tab_id: "w1:t1" })) } }), stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return { exitCode: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "claude", pid: 1 }] } } }), stderr: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
  };
}

function makeBackends(store = makeTempStore(), livePanes: Array<{ pane_id: string; label: string }> = []) {
  const tmux = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ENOENT).runner, store });
  const herdr = new HerdrSessionManager({ store, runner: herdrRunner(livePanes) });
  return { store, sessionManager: new CompositeSessionBackend({ tmux, herdr, store }) };
}

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

describe("片方の backend が答えられないとき", () => {
  test("listAvailable は答えた backend の分を返し、答えられなかった backend を unavailable に入れる", async () => {
    const { sessionManager } = makeBackends();
    await expect(sessionManager.list()).rejects.toThrow(/No such file or directory/);
    expect(await sessionManager.listAvailable()).toEqual({ sessions: [], unavailable: ["tmux"] });
  });

  test("herdr の会話は tmux が答えなくても開き直せる（engine を落とさない）", async () => {
    const { store, sessionManager } = makeBackends();
    store.put({ name: "s-herd0001", cwd: "/tmp/b", createdAt: 2, agent: "claude", backend: "herdr",
      herdrPaneId: "w1:p1", claudeSessionId: "conv-h" });
    const launched: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => { launched.push(name); return { exitCode: 0, errorText: "" }; };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher });
    let ended: string | null = null;
    engine.done.then(() => { ended = "resolved"; }, (error) => { ended = `rejected: ${String(error)}`; });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"cwd":"/tmp/b","id":"S1","name":"s-herd0001","resumeSessionId":"conv-h","type":"session_start","v":1}');
      // 起動へ進む（tmux 側の記録は無いので、二重起動の恐れは無い）。
      await expect.poll(() => launched, { timeout: 5_000 }).toEqual(["s-herd0001"]);
      expect(ended).toBeNull();
    } finally {
      await engine.teardown();
    }
  });

  test("この起動の後に tmux で動いていた会話は、tmux が答えないうちは開かない（二重に起動しない）", async () => {
    const { store, sessionManager } = makeBackends();
    // backend 欄の無い記録は tmux 扱い（後方互換）。この起動の後に作った記録なので、socket ファイルだけが消えて
    // 見えないまま、この会話の claude が動いていることがある。
    store.put({ name: "s-tmux0001", cwd: "/tmp/t", createdAt: nowSeconds(), agent: "claude", claudeSessionId: "conv-t" });
    const launched: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => { launched.push(name); return { exitCode: 0, errorText: "" }; };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"cwd":"/tmp/t","id":"S2","name":"s-new0002","resumeSessionId":"conv-t","type":"session_start","v":1}');
      expect(decodeControlMessage(await engine.lines.nextOfType("error"))).toMatchObject({
        type: "error", id: "S2", code: "tmux_error", message: RESUME_BLOCKED_BY_UNAVAILABLE_BACKEND,
      });
      expect(launched).toEqual([]);
    } finally {
      await engine.teardown();
    }
  });

  test("起動より前の古い tmux の記録だけなら開き直せる（hub が heartbeat を書き直していても）", async () => {
    // 独立検証 2026-10-26: 何か月も前に tmux で動かした記録が残っているだけで、その会話を開けなくなっていた（このマシンの
    // 実データで 124 会話）。また hub は処理中・設問を戻した会話の heartbeat を毎分書き直すので、heartbeat で判定すると、
    // 再起動の直前まで作業していた会話まで開けなくなっていた。起動より前の記録は、そのプロセスごと止まっている。
    for (const rewrittenByHub of [false, true]) {
      const { store, sessionManager } = makeBackends();
      store.put({ name: "cs-old00001", cwd: "/tmp/o", createdAt: 1, agent: "claude", claudeSessionId: "conv-old" });
      const heartbeatDir = makeTempDir("engine-unavailable-hb");
      if (rewrittenByHub) {
        writeHeartbeat(heartbeatDir, "cs-old00001", { ts: nowSeconds(), state: "active", event: "hub-processing" });
      }
      const launched: string[] = [];
      const launcher: EngineLauncher = async (_cwd, name) => { launched.push(name); return { exitCode: 0, errorText: "" }; };
      const engine = startEngine({ sessionManager, metadataStore: store, launcher, heartbeatDir });
      try {
        await engine.lines.nextOfType("channel_hello");
        engine.writeLine('{"cwd":"/tmp/o","id":"S4","name":"s-new0004","resumeSessionId":"conv-old","type":"session_start","v":1}');
        await expect.poll(() => launched, { timeout: 5_000 }).toEqual(["s-new0004"]);
      } finally {
        await engine.teardown();
      }
    }
  });

  test("herdr で動いている同じ会話があれば、tmux が答えなくても、この起動の後の tmux の記録があってもそれを使う", async () => {
    const { store, sessionManager } = makeBackends(makeTempStore(), [{ pane_id: "w1:p9", label: "s-herd0009" }]);
    store.put({ name: "cs-tmux0009", cwd: "/tmp/o", createdAt: nowSeconds(), agent: "claude", claudeSessionId: "conv-both" });
    store.put({ name: "s-herd0009", cwd: "/tmp/o", createdAt: nowSeconds(), agent: "claude", backend: "herdr",
      herdrPaneId: "w1:p9", claudeSessionId: "conv-both" });
    const launched: string[] = [];
    const launcher: EngineLauncher = async (_cwd, name) => { launched.push(name); return { exitCode: 0, errorText: "" }; };
    const engine = startEngine({ sessionManager, metadataStore: store, launcher });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"cwd":"/tmp/o","id":"S5","name":"cs-conv-both","resumeSessionId":"conv-both","type":"session_start","deferSubscribe":true,"v":1}');
      expect(decodeControlMessage(await engine.lines.nextOfType("session_list_response"))).toMatchObject({
        id: "S5", adoptedName: "s-herd0009",
      });
      expect(launched).toEqual([]);
    } finally {
      await engine.teardown();
    }
  });

  test("順番に処理する要求の処理が投げても、engine は落ちずにエラーで答え、次の要求を受け付ける", async () => {
    // listAvailable の無い backend（一覧が投げる）。以前は読み取りループごと終わって接続が切れていた。
    const store = makeTempStore();
    store.put({ name: "s-x", cwd: "/tmp/x", createdAt: 1, agent: "claude", claudeSessionId: "conv-x" });
    const sessionManager = new TmuxSessionManager({ runner: new MockTmuxRunner(() => ENOENT).runner, store });
    const launcher: EngineLauncher = async () => ({ exitCode: 0, errorText: "" });
    const engine = startEngine({ sessionManager, metadataStore: store, launcher });
    let ended: string | null = null;
    engine.done.then(() => { ended = "resolved"; }, (error) => { ended = `rejected: ${String(error)}`; });
    try {
      await engine.lines.nextOfType("channel_hello");
      engine.writeLine('{"cwd":"/tmp/x","id":"S3","name":"s-x","resumeSessionId":"conv-x","type":"session_start","v":1}');
      expect(decodeControlMessage(await engine.lines.nextOfType("error"))).toMatchObject({
        type: "error", id: "S3", code: "internal_error",
      });
      expect(ended).toBeNull();
      // 次の要求にも答える（読み取りループは生きている）。
      engine.writeLine('{"id":"L1","type":"session_list_request","v":1}');
      expect(decodeControlMessage(await engine.lines.nextOfType("error"))).toMatchObject({ id: "L1", code: "tmux_error" });
      expect(ended).toBeNull();
    } finally {
      await engine.teardown();
    }
  });
});
