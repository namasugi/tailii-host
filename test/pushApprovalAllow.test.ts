// pushApprovalAllow.test.ts — 通知の上で「許可」してよいかの印（平文の allow, push v1.1 §6）
//
// host は、承認の本文が操作の全体を省略なく含むときだけ allow: true を付ける。判定は要約を作った時点の印から通し、
// 本文の文字列から後で推測しない。端末が本文を出さない・本文を切り詰めた場合は付けない。

import { describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { approvalNotification, describeToolForApproval, makeHookPushNotifier, runHookCore } from "../src/approval/hook.js";
import { requestApiAgentApproval } from "../src/apiAgent/approvalBridge.js";
import { decodeHubClientLine, type HubPushEvent } from "../src/hub/hubProtocol.js";
import { createProductionPushDispatcher, PushDispatcher } from "../src/push/pushDispatcher.js";
import { decodePushKey, encodePushPlaintext, fitPushPlaintext, openPushTp, type PushTp } from "../src/push/pushEnvelope.js";
import { PushDeviceStore, resolvePushPrefs } from "../src/push/pushDeviceStore.js";
import { SessionHub } from "../src/hub/sessionHub.js";
import { apiAgentApprovalPushNotifier } from "../src/hub/hubDaemon.js";
import { makeTempDir, makeTempStore, ok } from "./helpers.js";
import { MemoryDeviceStore, PUSH_KEY, RecordingTransport, sampleDevice } from "./pushTestHelpers.js";
import { tempSocketPath } from "./socketHelpers.js";

const key = decodePushKey(PUSH_KEY)!;

describe("入力を見たその場で、許可してよい形の要約を作る（Bash・作業ディレクトリ・ASCII・実行の指定）", () => {
  const home = "/Users/u";
  const allow = (input: Record<string, unknown>, cwd: string | undefined = "/Users/u/proj") =>
    describeToolForApproval("Bash", input, cwd, home).allowSummary;

  it("短い ASCII のコマンド + 作業ディレクトリ → `<作業ディレクトリ> $ <コマンド>`（ホームは ~）", () => {
    expect(describeToolForApproval("Bash", { command: "ls -la" }, "/Users/u/proj", home))
      .toEqual({ summary: "ls -la", allowSummary: "~/proj $ ls -la" });
    expect(allow({ command: "ls" }, "/Users/u")).toBe("~ $ ls");
    expect(allow({ command: "ls" }, "/tmp/work dir")).toBe("/tmp/work dir $ ls");
    // description / timeout は表示しないが許す。run_in_background: false も許す。
    expect(allow({ command: "npm test", description: "テストを実行", timeout: 60000, run_in_background: false, dangerouslyDisableSandbox: false }))
      .toBe("~/proj $ npm test");
  });

  it("許可させない: 作業ディレクトリが無い・相対・$ を含む / サンドボックス外・背景実行 / 未知の欄 / ASCII 以外 / 複数行・連続空白", () => {
    expect(describeToolForApproval("Bash", { command: "ls" }, undefined, home).allowSummary).toBeNull();
    expect(allow({ command: "ls" }, "")).toBeNull();
    expect(allow({ command: "ls" }, "proj")).toBeNull();
    expect(allow({ command: "ls" }, "/tmp/x $ rm -rf ~")).toBeNull();
    expect(allow({ command: "./deploy.sh", dangerouslyDisableSandbox: true })).toBeNull();
    expect(allow({ command: "./deploy.sh", run_in_background: true })).toBeNull();
    expect(allow({ command: "ls", run_in_background: "false" })).toBeNull();
    expect(allow({ command: "ls", future_option: 1 })).toBeNull();
    expect(allow({ command: "ls", timeout: "60" })).toBeNull();
    expect(allow({ command: "cat 資料.txt" })).toBeNull();
    expect(allow({ command: "rm a\u034Fb" })).toBeNull(); // 不可視の結合文字（U+034F）
    expect(allow({ command: "rm \u0430.txt" })).toBeNull(); // キリル文字の а（同形異字）
    expect(allow({ command: "ls" }, "/Users/u/資料")).toBeNull();
    expect(allow({ command: "echo a\nrm -rf /" })).toBeNull();
    expect(allow({ command: "echo 'a  b'" })).toBeNull();
    expect(allow({ command: "ls " })).toBeNull();
    expect(describeToolForApproval("Write", { file_path: "/a", content: "x" }, "/w", home).allowSummary).toBeNull();
    expect(describeToolForApproval("Edit", { file_path: "/a", old_string: "x", new_string: "y" }, "/w", home).allowSummary).toBeNull();
    expect(describeToolForApproval("SendUserFile", { files: ["/a/b.png"] }, "/w", home).allowSummary).toBeNull();
    expect(describeToolForApproval("mcp__x__y", { a: 1 }, "/w", home)).toEqual({ summary: "Run tool: mcp__x__y", allowSummary: null });
    expect(describeToolForApproval("Bash", {}, "/w", home)).toEqual({ summary: "Run a Bash command", allowSummary: null });
  });

  it("通知本文: 許可してよい形なら `Bash · <作業ディレクトリ> $ <コマンド>` で complete。完成した本文で 280 字を判定し、超えたら従来の形に戻す", () => {
    expect(approvalNotification({ approvalId: "a", tool: "Bash", session: "s", summary: "ls -la", allowSummary: "~/proj $ ls -la" }))
      .toEqual({ body: "Bash · ~/proj $ ls -la", complete: true });
    // 境界: 完成した本文（`Bash · ` の 7 字を含む）がちょうど 280 字なら許可、281 字なら従来の形。
    const at = (bodyChars: number) => {
      const command = "x".repeat(bodyChars - "Bash · /w $ ".length);
      return approvalNotification({ approvalId: "a", tool: "Bash", session: "s", summary: command, allowSummary: `/w $ ${command}` });
    };
    expect([...at(280).body].length).toBe(280);
    expect(at(280).complete).toBe(true);
    expect(at(281).complete).toBe(false);
    expect(at(281).body.startsWith("Bash · /w $")).toBe(false);
    // allowSummary 単体は 280 字以内でも、本文にすると超える（以前は 7 字超過で許可できた）。
    const nearly = `/w $ ${"y".repeat(275)}`;
    expect([...nearly].length).toBe(280);
    expect(approvalNotification({ approvalId: "a", tool: "Bash", session: "s", summary: "y".repeat(275), allowSummary: nearly }).complete).toBe(false);
    expect(approvalNotification({ approvalId: "a", tool: "Bash", session: "s", summary: `echo ${"x".repeat(300)}` }).complete).toBe(false);
    expect(approvalNotification({ approvalId: "a", tool: "Bash", session: "s", summary: "   " })).toEqual({ body: "Bash", complete: false });
    expect(approvalNotification({ approvalId: "a", tool: "Bash", session: "s", summary: "ls -la" })).toEqual({ body: "Bash · ls -la", complete: false });
    expect(approvalNotification({ approvalId: "a", tool: "A · B", session: "s" })).toEqual({ body: "A · B", complete: false });
    // Bash 以外の名前で許可の要約が来ても許可させない。
    expect(approvalNotification({ approvalId: "a", tool: "Write", session: "s", summary: "x", allowSummary: "~ $ ls" }).complete).toBe(false);
  });
});

function setup(devices = [sampleDevice()]) {
  const transport = new RecordingTransport("relay");
  const dispatcher = new PushDispatcher({ store: new MemoryDeviceStore(devices), loadApnsConfig: () => null, createTransport: () => transport });
  const opened = () => transport.requests.map((request) => JSON.parse(openPushTp(key, request.tp)!) as Record<string, unknown>);
  return { dispatcher, transport, opened };
}

describe("dispatcher: 端末ごとの段と切り詰め", () => {
  it("承認・印あり・本文を出す端末 → allow: true。本文を出さない端末 → 定型文で allow なし", async () => {
    const h = setup([sampleDevice(), sampleDevice({ deviceId: "11111111-2222-3333-4444-555555555555", prefs: resolvePushPrefs({ showBody: false }) })]);
    await h.dispatcher.notify({ kind: "approval", session: "s", id: "ap", body: "Bash · ls -la", bodyComplete: true });
    const plaintexts = h.opened();
    expect(plaintexts.find((p) => p["body"] === "Bash · ls -la")).toMatchObject({ allow: true });
    const hidden = plaintexts.find((p) => p["body"] !== "Bash · ls -la")!;
    expect(hidden["body"]).toBe("ツールの実行の承認を待っています");
    expect(hidden).not.toHaveProperty("allow");
  });

  it("印なし・承認以外の種別・dispatcher の上限で本文を切った → allow なし", async () => {
    const noMark = setup();
    await noMark.dispatcher.notify({ kind: "approval", session: "s", id: "ap", body: "Bash · ls" });
    expect(noMark.opened()[0]).not.toHaveProperty("allow");
    const otherKind = setup();
    await otherKind.dispatcher.notify({ kind: "question", session: "s", body: "q", bodyComplete: true });
    expect(otherKind.opened()[0]).not.toHaveProperty("allow");
    const clipped = setup();
    await clipped.dispatcher.notify({ kind: "approval", session: "s", id: "ap", body: `Bash · ${"x".repeat(400)}`, bodyComplete: true });
    expect(clipped.opened()[0]).not.toHaveProperty("allow");
  });

  it("暗号化の前に本文を切り詰めたら allow を外す。allow の無い平文は golden と同じ形のまま", () => {
    const fitted = fitPushPlaintext({ kind: "approval", session: "s", title: "t", body: "あ".repeat(3000), id: "a", allow: true, ts: 1 });
    expect(fitted).not.toHaveProperty("allow");
    expect(fitPushPlaintext({ kind: "approval", session: "s", title: "t", body: "Bash · ls", id: "a", allow: true, ts: 1 }))
      .toMatchObject({ allow: true });
    expect(encodePushPlaintext({ kind: "approval", session: "s", title: "t", body: "b", id: "a", allow: true, ts: 1 }))
      .toBe('{"v":1,"kind":"approval","session":"s","title":"t","body":"b","id":"a","allow":true,"ts":1}');
    expect(encodePushPlaintext({ kind: "approval", session: "s", title: "t", body: "b", id: "a", ts: 1 })).not.toContain("allow");
  });
});

describe("hub 経由・hook の自前送信・API 作業で同じ結果", () => {
  function hubWith() {
    const h = setup();
    const hub = new SessionHub({ runner: async () => ok(""), heartbeatDir: makeTempDir("allow-hub"), metadataStore: makeTempStore(),
      timeoutSeconds: 1800, pushDispatcher: h.dispatcher });
    const hook = {};
    hub.registerClient(hook, () => {});
    return { ...h, hub, hook };
  }

  it("hub 経由: 印つきの push_request は allow: true。欄の無い古い hook の依頼は allow なし（拒否だけ）", async () => {
    const withMark = hubWith();
    withMark.hub.handleClientMessage(withMark.hook, JSON.stringify({ type: "push_request", id: "r",
      event: { kind: "approval", session: "s", id: "ap-1", body: "Bash · ls -la", bodyComplete: true } }));
    await vi.waitFor(() => expect(withMark.opened()).toHaveLength(1));
    expect(withMark.opened()[0]).toMatchObject({ allow: true });
    const old = hubWith();
    old.hub.handleClientMessage(old.hook, JSON.stringify({ type: "push_request", id: "r",
      event: { kind: "approval", session: "s", id: "ap-2", body: "Bash · ls -la" } }));
    await vi.waitFor(() => expect(old.opened()).toHaveLength(1));
    expect(old.opened()[0]).not.toHaveProperty("allow");
  });

  it("hub の内部メッセージ: 承認以外・上限で切った本文の bodyComplete は落とす", () => {
    const decode = (event: Record<string, unknown>) => {
      const message = decodeHubClientLine(JSON.stringify({ type: "push_request", id: "r", event }));
      return message?.type === "push_request" ? message.event : null;
    };
    expect(decode({ kind: "approval", session: "s", body: "Bash · ls", bodyComplete: true })?.bodyComplete).toBe(true);
    expect(decode({ kind: "question", session: "s", body: "q", bodyComplete: true })).not.toHaveProperty("bodyComplete");
    expect(decode({ kind: "approval", session: "s", body: "x".repeat(3000), bodyComplete: true })).not.toHaveProperty("bodyComplete");
    expect(decode({ kind: "approval", session: "s", body: "b", bodyComplete: "yes" })).not.toHaveProperty("bodyComplete");
  });

  it("hook: 短い Bash の承認は印つきで hub へ渡し、hub が居ないときの自前送信でも allow: true", async () => {
    // hook が通知を作るところまで（runHookCore → notifier へ summaryComplete が渡る）。
    const notifier = vi.fn(async () => {});
    await runHookCore({
      stdinData: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: "/w", session_id: "x" })),
      socketPath: tempSocketPath(`allow-missing-${randomUUID().slice(0, 6)}`), deadlineSeconds: 0.3, session: "s",
      engineRelaySocketPath: null, retryConnectIntervalSeconds: 0.05, notifier,
    });
    expect(notifier.mock.calls[0]![0]).toMatchObject({ tool: "Bash", summary: "ls -la", allowSummary: "/w $ ls -la" });

    // hub へ渡す event に印が乗る。
    const received: HubPushEvent[] = [];
    const socketPath = tempSocketPath(`allow-hub-${randomUUID().slice(0, 6)}`);
    const server = net.createServer((socket) => socket.on("data", (chunk) => {
      const message = decodeHubClientLine(chunk.toString("utf8").trim());
      if (message?.type === "push_request") received.push(message.event);
    }));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await makeHookPushNotifier({ hubSocketPath: socketPath })({ approvalId: "ap", tool: "Bash", session: "s", summary: "ls -la", allowSummary: "/w $ ls -la" }, 5000);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({ kind: "approval", body: "Bash · /w $ ls -la", bodyComplete: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // hub が居ないときの自前送信（記録を読むだけの dispatcher）でも同じ平文になる。
    const pushBase = makeTempDir("allow-local");
    const apnsBase = makeTempDir("allow-local-apns");
    new PushDeviceStore({ base: pushBase, legacyApnsBase: apnsBase }).save(sampleDevice());
    const bodies: string[] = [];
    await makeHookPushNotifier({
      hubSocketPath: path.join(pushBase, "no-hub.sock"), hubRequestTimeoutMs: 100,
      localDispatcher: () => createProductionPushDispatcher({ pushBase, apnsBase, readOnly: true,
        poster: { post: async (_url, body) => { bodies.push(body); return { ok: true, status: 200, body: "{}" }; } } }),
    })({ approvalId: "ap", tool: "Bash", session: "s", summary: "ls -la", allowSummary: "/w $ ls -la" }, 5000);
    const tp = (JSON.parse(bodies[0]!) as { tp: PushTp }).tp;
    expect(JSON.parse(openPushTp(key, tp)!)).toMatchObject({ kind: "approval", body: "Bash · /w $ ls -la", allow: true });
  });

  it("API 作業の承認: 短い ASCII のコマンドで cwd があっても、hubDaemon の配線まで通して allow（bodyComplete）が付かない", async () => {
    const notifier = vi.fn();
    const controller = new AbortController();
    const pending = requestApiAgentApproval(
      { id: "api-1", session: "s", tool: "Bash", summary: "ls -la", cwd: "/w", signal: controller.signal },
      { socketPathFor: () => tempSocketPath(`allow-api-${randomUUID().slice(0, 6)}`), notifier, retryIntervalMs: 20, connectTimeoutMs: 50 },
    );
    await vi.waitFor(() => expect(notifier).toHaveBeenCalled());
    controller.abort();
    await pending;
    expect(notifier.mock.calls[0]![0]).toEqual({ approvalId: "api-1", tool: "Bash", session: "s", summary: "ls -la" });
    // hubDaemon の最後の配線: 依頼に許可の要約が紛れ込んでいても使わない。
    const requested: HubPushEvent[] = [];
    const wire = apiAgentApprovalPushNotifier({ requestPush: (event) => { requested.push(event); return true; } });
    wire(notifier.mock.calls[0]![0]);
    wire({ approvalId: "api-2", tool: "Bash", session: "s", summary: "ls -la", allowSummary: "/w $ ls -la" } as Parameters<typeof wire>[0]);
    expect(requested).toEqual([
      { kind: "approval", session: "s", id: "api-1", tool: "Bash", body: "Bash · ls -la" },
      { kind: "approval", session: "s", id: "api-2", tool: "Bash", body: "Bash · ls -la" },
    ]);
    // dispatcher まで通しても allow は付かない。
    const h = setup();
    await h.dispatcher.notify(requested[0]!);
    expect(h.opened()[0]).not.toHaveProperty("allow");
  });
});
