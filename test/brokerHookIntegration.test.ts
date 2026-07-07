// brokerHookIntegration.test.ts — Broker ↔ Hook 統合テスト
// Swift 版 BrokerHookIntegrationTests / BrokerMultiHookIntegrationTests の移植。
//
// Swift 版は実バイナリ・サブプロセスで検証するが、TS 版は単一プロセス・イベント駆動なので
// runBroker / runHookCore を in-process で駆動する（実 unix domain socket は本物を使う）。
// 実バイナリ経路（cli.ts の serve/hook 配線）は CLI スモークで別途確認する。
//
// 検証シナリオ:
//   1. allow/deny 往復（request 内容の中継含む）
//   2. 取り違え防止（5.4）: id=B の deny がブロードキャストされても hook A は無視
//   3. fan-in 行混線なし（4.2）: 約 8KB summary の同時送出
//   4. SSH 断（5.6）: 承認待ち中の broker stdin EOF で全 hook が EOF→deny
//   5. 無応答（5.5）: 各 hook の内部デッドラインで deny

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { runHookCore, type HookRunResult } from "../src/hook.js";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";
import { startBroker, waitForFile, type BrokerHarness } from "./socketHelpers.js";

function bashPreToolUse(command: string, cwd: string): Buffer {
  return Buffer.from(
    JSON.stringify({ session_id: "sess-int", tool_name: "Bash", tool_input: { command }, cwd }),
  );
}

function parseDecision(stdout: string): { decision: string; reason?: string } {
  const obj = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  const out: { decision: string; reason?: string } = {
    decision: obj.hookSpecificOutput.permissionDecision,
  };
  if (obj.hookSpecificOutput.permissionDecisionReason !== undefined) {
    out.reason = obj.hookSpecificOutput.permissionDecisionReason;
  }
  return out;
}

/** broker stdout（SSH 側）から approval_request を1行読み、(id, summary) を返す。 */
async function readApprovalRequest(
  harness: BrokerHarness,
  timeoutMs = 5000,
): Promise<{ id: string; summary: string }> {
  const line = await harness.outputLines.next(timeoutMs);
  const message = decodeControlMessage(line);
  if (message.type !== "approval_request") throw new Error(`approval_request ではない: ${line}`);
  return { id: message.id, summary: message.summary };
}

/** 2 hook 分の request を読み、summary の識別子で A/B に帰属させて id を返す。 */
async function readTwoRequests(
  harness: BrokerHarness,
  markerA: string,
  markerB: string,
): Promise<{ idA: string; idB: string }> {
  const first = await readApprovalRequest(harness);
  const second = await readApprovalRequest(harness);
  let idA: string | null = null;
  let idB: string | null = null;
  for (const request of [first, second]) {
    if (request.summary.includes(markerA)) idA = request.id;
    if (request.summary.includes(markerB)) idB = request.id;
  }
  if (idA === null || idB === null) throw new Error("A/B の request を識別できない");
  return { idA, idB };
}

/** approval_decision を iPhone 役として broker stdin へ書く。 */
function writeDecision(
  harness: BrokerHarness,
  id: string,
  decision: "allow" | "deny",
  reason?: string,
): void {
  const line = encodeControlMessage({
    type: "approval_decision",
    v: 1,
    id,
    decision,
    ...(reason !== undefined ? { reason } : {}),
  });
  harness.input.write(line + "\n");
}

/**
 * hook を起動して結果 Promise を返す（await しないこと）。
 * 呼び出し前に waitForFile で broker の listen 完了（socket ファイル出現）を待つ。
 */
function launchHook(
  harness: BrokerHarness,
  command: string,
  cwd: string,
  deadlineSeconds: number,
): Promise<HookRunResult> {
  return runHookCore({
    stdinData: bashPreToolUse(command, cwd),
    socketPath: harness.socketPath,
    deadlineSeconds,
    retryConnectIntervalSeconds: 0.05,
  });
}

/** broker を起動し、listen 完了まで待ってからハーネスを返す。 */
async function startBrokerReady(suffix: string): Promise<BrokerHarness> {
  const harness = startBroker(suffix);
  await waitForFile(harness.socketPath);
  return harness;
}

describe("Broker↔Hook 統合", () => {
  let harness: BrokerHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.teardown();
      fs.rmSync(harness.socketPath, { force: true });
      harness = null;
    }
  });

  it("allow: iPhone が allow を返すと hook が allow を出力（request 内容も検証）", async () => {
    harness = await startBrokerReady("int-allow");
    const hook = launchHook(harness, "echo hello", "/work/dir", 20);

    const request = await readApprovalRequest(harness);
    expect(request.summary).toBe("echo hello");
    writeDecision(harness, request.id, "allow");

    const { exitCode, stdout } = await hook;
    expect(exitCode).toBe(0);
    expect(parseDecision(stdout).decision).toBe("allow");
  });

  it("deny: iPhone が deny(理由付き) を返すと hook が deny を出力", async () => {
    harness = await startBrokerReady("int-deny");
    const hook = launchHook(harness, "rm -rf /", "/work", 20);

    const request = await readApprovalRequest(harness);
    writeDecision(harness, request.id, "deny", "Denied on iPhone");

    const parsed = parseDecision((await hook).stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("Denied on iPhone");
  });

  it("取り違え防止: id=B の deny がブロードキャストされても hook A は無視し、id=A の allow のみ受理（5.4）", async () => {
    harness = await startBrokerReady("int-mixup");
    const hookA = launchHook(harness, "echo TASK-A", "/work/a", 20);
    const hookB = launchHook(harness, "echo TASK-B", "/work/b", 20);

    const { idA, idB } = await readTwoRequests(harness, "TASK-A", "TASK-B");
    expect(idA).not.toBe(idB);

    // hook A の確定を観測するフラグ（他 id の決定で終了してはならない）。
    let aSettled = false;
    const hookAWatched = hookA.then((result) => {
      aSettled = true;
      return result;
    });

    // iPhone 役: 先に id=B を deny。Broker は非解釈で全 hook へブロードキャストする。
    writeDecision(harness, idB, "deny", "deny-for-B");

    const resultB = parseDecision((await hookB).stdout);
    expect(resultB.decision).toBe("deny");
    expect(resultB.reason).toBe("deny-for-B");

    // hook A は id=B の決定を無視して待機継続しているべき。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(aSettled, "hook A は他 id (B) の決定で終了してはならない（取り違え）").toBe(false);

    // 続いて id=A を allow → hook A のみ受理。
    writeDecision(harness, idA, "allow", "allow-for-A");
    const resultA = parseDecision((await hookAWatched).stdout);
    expect(resultA.decision).toBe("allow");
    expect(resultA.reason).toBe("allow-for-A");
  });

  it("fan-in: 2 hook が大きな行を同時送出しても SSH 側で行が混線しない（4.2）", async () => {
    harness = await startBrokerReady("int-fanin");
    const payloadA = "A-FANIN-" + "a".repeat(8000);
    const payloadB = "B-FANIN-" + "b".repeat(8000);
    const hookA = launchHook(harness, payloadA, "/work/a", 20);
    const hookB = launchHook(harness, payloadB, "/work/b", 20);

    const first = await readApprovalRequest(harness);
    const second = await readApprovalRequest(harness);
    expect(new Set([first.summary, second.summary])).toEqual(new Set([payloadA, payloadB]));

    const [idA, idB] =
      first.summary === payloadA ? [first.id, second.id] : [second.id, first.id];
    writeDecision(harness, idA, "allow");
    writeDecision(harness, idB, "allow");

    expect(parseDecision((await hookA).stdout).decision).toBe("allow");
    expect(parseDecision((await hookB).stdout).decision).toBe("allow");
  });

  it("切断: 承認待ち中の SSH 断（stdin EOF）で 2 hook とも EOF→deny に倒れる（5.6）", async () => {
    harness = await startBrokerReady("int-disc");
    const hookA = launchHook(harness, "echo DISC-A", "/work", 30);
    const hookB = launchHook(harness, "echo DISC-B", "/work", 30);

    // 両 hook の request が中継されて承認待ちに入ったことを確認してから切断する。
    await readTwoRequests(harness, "DISC-A", "DISC-B");
    harness.input.end();

    const resultA = parseDecision((await hookA).stdout);
    const resultB = parseDecision((await hookB).stdout);
    expect(resultA.decision).toBe("deny");
    expect(resultB.decision).toBe("deny");
    // deadline（30s）経路ではなく EOF 経路で確定したことを reason で確認する。
    expect(resultA.reason).toBe("iPhone disconnected");
    expect(resultB.reason).toBe("iPhone disconnected");
  });

  it("無応答: iPhone が応答しないとき 2 hook とも各自の内部デッドラインで deny に倒れる（5.5）", async () => {
    harness = await startBrokerReady("int-noresp");
    const hookA = launchHook(harness, "echo NORESP-A", "/work", 0.5);
    const hookB = launchHook(harness, "echo NORESP-B", "/work", 0.5);

    // 両 request の中継を確認するのみで、決定は一切返さない。
    await readTwoRequests(harness, "NORESP-A", "NORESP-B");

    const resultA = parseDecision((await hookA).stdout);
    const resultB = parseDecision((await hookB).stdout);
    expect(resultA.decision).toBe("deny");
    expect(resultB.decision).toBe("deny");
    // 切断ではなくデッドライン経路で確定したことを reason で確認する。
    expect(resultA.reason?.startsWith("No response within")).toBe(true);
    expect(resultB.reason?.startsWith("No response within")).toBe(true);
  });
});
