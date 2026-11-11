// hookPush.test.ts — hook の承認 push（hub へ push_request・届かないときだけ自分で送る, push v1）

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  approvalNotificationBody,
  makeHookPushNotifier,
  makeMacAttachedProbe,
  requestHubPush,
  runHookCore,
} from "../src/approval/hook.js";
import { startEngineRelaySocket, type EngineRelayMessage } from "../src/hub/engineRelaySocket.js";
import { readHeartbeat } from "../src/sessions/heartbeat.js";
import { decodeHubClientLine, encodeHubMessage, type HubClientMessage } from "../src/hub/hubProtocol.js";
import { createProductionPushDispatcher, type PushDispatcher } from "../src/push/pushDispatcher.js";
import { PushDeviceStore } from "../src/push/pushDeviceStore.js";
import { DEVICE_ID, sampleDevice } from "./pushTestHelpers.js";
import { makeTempDir, ok } from "./helpers.js";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function socketPath(): string {
  return path.join(os.tmpdir(), `hp-${randomUUID().slice(0, 8)}.sock`);
}

/** push_request に決めた status で答える偽 hub。受けた行を記録する。 */
async function fakeHub(status: "accepted" | "unavailable" | null): Promise<{ path: string; received: HubClientMessage[] }> {
  const target = socketPath();
  const received: HubClientMessage[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = decodeHubClientLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message === null) return;
      received.push(message);
      if (message.type === "push_request" && status !== null) {
        socket.write(encodeHubMessage({ type: "push_request_result", id: message.id, status }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(target, resolve));
  servers.push(server);
  return { path: target, received };
}

const request = { approvalId: "ap-1", tool: "Bash", session: "cs-work", summary: "rm -rf build\nnpm test" };

describe("hook の承認 push", () => {
  it("hub に接続して要求を書き込めたら、応答が無くても・送信器が無いと言われても自分では送らない", async () => {
    for (const status of ["accepted", null, "unavailable"] as const) {
      const hub = await fakeHub(status);
      const local = vi.fn();
      await makeHookPushNotifier({ hubSocketPath: hub.path, hubRequestTimeoutMs: 100, localDispatcher: () => ({ notify: local }) as unknown as PushDispatcher })(request, 5000);
      expect(local).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(hub.received).toHaveLength(1));
      const sent = hub.received[0]!;
      if (sent.type !== "push_request") throw new Error("unreachable");
      expect(sent.event).toEqual({ kind: "approval", session: "cs-work", id: "ap-1", tool: "Bash", body: "Bash · rm -rf build npm test" });
    }
  });

  it("hub に接続できない（居ない）ときだけ同じ dispatcher を自分で動かす", async () => {
    const local = vi.fn(async () => ({ status: "sent", devices: [] }));
    await makeHookPushNotifier({
      hubSocketPath: socketPath(), hubRequestTimeoutMs: 100,
      localDispatcher: () => ({ notify: local }) as unknown as PushDispatcher,
    })(request, 5000);
    expect(local).toHaveBeenCalledOnce();
    expect(local.mock.calls[0]![0]).toMatchObject({ kind: "approval", id: "ap-1", session: "cs-work" });
  });

  it("requestHubPush は hub の応答を待たない・存在しない socket では unreachable（例外を投げない）", async () => {
    const missing = socketPath();
    expect(fs.existsSync(missing)).toBe(false);
    expect(await requestHubPush({ kind: "approval", session: "s" }, missing, 100)).toBe("unreachable");
    const silent = await fakeHub(null);
    const started = Date.now();
    expect(await requestHubPush({ kind: "approval", session: "s" }, silent.path, 5_000)).toBe("delivered");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("hook の自前送信は何も書かない（401 / 410 を受けても端末記録・間引き・最後の送信結果に触れない）", async () => {
    for (const status of [401, 410, 200]) {
      const pushBase = makeTempDir("hook-readonly");
      const apnsBase = makeTempDir("hook-readonly-apns");
      new PushDeviceStore({ base: pushBase, legacyApnsBase: apnsBase }).save(sampleDevice());
      const before = fs.readFileSync(path.join(pushBase, "devices", `${DEVICE_ID}.json`), "utf8");
      const listing = () => fs.readdirSync(pushBase).sort();
      const filesBefore = listing();
      const dispatcher = createProductionPushDispatcher({
        pushBase, apnsBase, readOnly: true,
        poster: { post: async () => ({ ok: true, status, body: "{}" }) },
      });
      await dispatcher.notify({ kind: "approval", session: "cs-work", id: "ap-1" });
      await dispatcher.notify({ kind: "approval", session: "cs-work", id: "ap-1" });
      expect(fs.readFileSync(path.join(pushBase, "devices", `${DEVICE_ID}.json`), "utf8")).toBe(before);
      expect(listing()).toEqual(filesBefore);
    }
  });

  it("本文は `ツール名 · 要約`（要約が無ければツール名だけ）", () => {
    expect(approvalNotificationBody({ approvalId: "a", tool: "Edit", session: "s" })).toBe("Edit");
    expect(approvalNotificationBody({ approvalId: "a", tool: "Edit", session: "s", summary: "x".repeat(400) }))
      .toBe(`Edit · ${"x".repeat(280)}…`);
  });

  it("本番の presence probe は Mac の端末に attach 中だけ抑える（hub の購読者数は見ない）", async () => {
    const attached = makeMacAttachedProbe(async (args) => (args[0] === "list-clients" ? ok("cs-work\n") : ok("")));
    const detached = makeMacAttachedProbe(async () => ok(""));
    expect(await attached("cs-work")).toBe("mac-attached");
    expect(await detached("cs-work")).toBeNull();
  });
});

describe("hook の StopFailure（push v1 修正 4）", () => {
  async function runStopFailure(input: Record<string, unknown>) {
    const relayPath = socketPath();
    const received: EngineRelayMessage[] = [];
    const relay = await startEngineRelaySocket({ socketPath: relayPath, onMessage: (message) => received.push(message) });
    const heartbeatDir = makeTempDir("hook-stopfailure-hb");
    try {
      const result = await runHookCore({
        stdinData: Buffer.from(JSON.stringify(input)),
        socketPath: null,
        deadlineSeconds: 1,
        session: "cs-work",
        engineRelaySocketPath: relayPath,
        heartbeatDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { result, received, heartbeat: readHeartbeat(heartbeatDir, "cs-work") };
    } finally {
      await relay?.close();
    }
  }

  it("実物（2.1.322）の入力の形から処理完了 + エラー種別を hub へ中継し、無出力で終わる", async () => {
    const { result, received, heartbeat } = await runStopFailure({
      session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: "/work", permission_mode: "default",
      hook_event_name: "StopFailure", error: "server_error", error_details: "529 Overloaded", last_assistant_message: "",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "session_processing", session: "cs-work", state: "done", event: "StopFailure", error: "server_error" });
    expect(heartbeat?.state).toBe("idle");
  });

  it("サブエージェント・内部の複製（agent_id 付き）の StopFailure は扱わない・不正なエラー種別は落とす", async () => {
    const sub = await runStopFailure({ hook_event_name: "StopFailure", error: "server_error", agent_id: "a1", agent_type: "general" });
    expect(sub.result).toEqual({ exitCode: 0, stdout: "" });
    expect(sub.received).toHaveLength(0);
    const odd = await runStopFailure({ hook_event_name: "StopFailure", error: "Bad Value!" });
    expect(odd.received[0]).toMatchObject({ event: "StopFailure" });
    expect(odd.received[0]).not.toHaveProperty("error");
  });
});
