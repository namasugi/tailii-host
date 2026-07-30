// engineBackend.test.ts — backend_get / backend_set の Engine dispatch 統合検証
//
// 端末バックエンド設定（tmux / herdr）のワイヤー往復を検証する。
// 永続化と herdr 検出は注入（backendWriter / herdrInstalledProbe）で密閉し、
// 実ファイル `~/.tailii/backend` には触れない。

import { describe, expect, test } from "vitest";
import { decodeControlMessage } from "../src/protocol.js";
import type { SessionBackendKind } from "../src/backend/sessionBackend.js";
import { HerdrSessionManager } from "../src/backend/herdr.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { TmuxSessionManager } from "../src/backend/tmux.js";
import { makeTempDir, MockTmuxRunner, startEngine } from "./helpers.js";

function makeManager(): TmuxSessionManager {
  return new TmuxSessionManager({
    runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner,
  });
}

describe("EngineControl — backend get/set", () => {
  test("backend_get_request は現在値と herdr 可用性を返す", async () => {
    const engine = startEngine({
      sessionManager: makeManager(),
      backendKind: () => "herdr",
      herdrInstalledProbe: () => true,
    });
    await engine.lines.nextOfType("channel_hello");
    try {
      engine.writeLine(JSON.stringify({ type: "backend_get_request", v: 1, id: "bg" }));
      expect(decodeControlMessage(await engine.lines.nextOfType("backend_get_response"))).toMatchObject({
        type: "backend_get_response", id: "bg", backend: "herdr", herdrInstalled: true,
      });
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("backend_set_request は writer へ永続化し ok を返す", async () => {
    const written: SessionBackendKind[] = [];
    let current: SessionBackendKind = "tmux";
    const engine = startEngine({
      sessionManager: makeManager(),
      backendKind: () => current,
      backendWriter: (kind) => {
        written.push(kind);
        current = kind;
      },
      herdrInstalledProbe: () => true,
    });
    await engine.lines.nextOfType("channel_hello");
    try {
      engine.writeLine(JSON.stringify({ type: "backend_set_request", v: 1, id: "bs", backend: "herdr" }));
      expect(decodeControlMessage(await engine.lines.nextOfType("backend_set_response"))).toMatchObject({
        type: "backend_set_response", id: "bs", ok: true, backend: "herdr", error: null,
      });
      expect(written).toEqual(["herdr"]);

      // 切替後の get は新しい値を返す（launch 毎解決の資格）。
      engine.writeLine(JSON.stringify({ type: "backend_get_request", v: 1, id: "bg2" }));
      expect(decodeControlMessage(await engine.lines.nextOfType("backend_get_response"))).toMatchObject({
        id: "bg2", backend: "herdr",
      });
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("session_title_set は herdr タブを tab rename し ok を返す（session-title）", async () => {
    const store = new SessionMetadataStore(makeTempDir("engine-title-store"));
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const recorded: string[][] = [];
    const manager = new HerdrSessionManager({
      store,
      runner: async (args) => {
        recorded.push(args);
        if (args[0] === "pane" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              result: {
                type: "pane_list",
                panes: [{ pane_id: "w4:p2", label: "s-a", tab_id: "w4:t2" }],
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const engine = startEngine({ sessionManager: manager });
    await engine.lines.nextOfType("channel_hello");
    try {
      engine.writeLine(JSON.stringify({
        type: "session_title_set", v: 1, id: "st", session: "s-a", title: "認証バグの調査",
      }));
      expect(decodeControlMessage(await engine.lines.nextOfType("session_title_set_result"))).toMatchObject({
        type: "session_title_set_result", id: "st", ok: true, error: null,
      });
      expect(recorded).toContainEqual(["tab", "rename", "w4:t2", "認証バグの調査"]);

      // pane 不在は ok=false（best-effort。iOS 側は握り潰す）。
      engine.writeLine(JSON.stringify({
        type: "session_title_set", v: 1, id: "st2", session: "s-gone", title: "x",
      }));
      expect(decodeControlMessage(await engine.lines.nextOfType("session_title_set_result"))).toMatchObject({
        id: "st2", ok: false,
      });
    } finally {
      await engine.teardown();
    }
  }, 15_000);

  test("herdr 未導入で backend_set_request(herdr) は書かずに ok=false", async () => {
    const written: SessionBackendKind[] = [];
    const engine = startEngine({
      sessionManager: makeManager(),
      backendKind: () => "tmux",
      backendWriter: (kind) => written.push(kind),
      herdrInstalledProbe: () => false,
    });
    await engine.lines.nextOfType("channel_hello");
    try {
      engine.writeLine(JSON.stringify({ type: "backend_set_request", v: 1, id: "bs2", backend: "herdr" }));
      const response = decodeControlMessage(await engine.lines.nextOfType("backend_set_response"));
      expect(response).toMatchObject({ type: "backend_set_response", id: "bs2", ok: false, backend: "tmux" });
      expect((response as { error: string | null }).error).toContain("herdr");
      expect(written).toEqual([]);
    } finally {
      await engine.teardown();
    }
  }, 15_000);
});
