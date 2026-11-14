// engineRelaySendTimeLimit.test.ts — engine relay への最善努力の送信は、試行の途中で止まっても上限（既定 250ms）で戻る
//
// relay が connect を完了しない・end（書き出し）を完了しない場合でも、socket を破棄して戻り、hook の出力・終了・
// 承認の結果を遅らせない・変えない（remote_pending_cleared を runHookCore の finally で送るため）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

/** relay の挙動の切り替え（パスごと）。指定の無いパスは本物の net.connect。 */
const stalls = new Map<string, "connect" | "end">();
const fakeSockets: { destroyed: boolean }[] = [];

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  const connect = (...args: unknown[]): unknown => {
    const path = args[0];
    const mode = typeof path === "string" ? stalls.get(path) : undefined;
    if (mode === undefined) return (actual.connect as (...a: unknown[]) => unknown)(...args);
    // 止まった relay の代わり: connect が来ない / end のコールバックが来ない socket。
    const fake = Object.assign(new EventEmitter(), {
      destroyed: false,
      end: (_data?: unknown, _cb?: () => void): void => { /* 書き出しが終わらない。 */ },
      destroy(): void { this.destroyed = true; },
      write: (): boolean => true,
      setEncoding: (): void => {},
      resume: (): void => {},
    });
    fakeSockets.push(fake);
    if (mode === "end") setTimeout(() => fake.emit("connect"), 5);
    return fake;
  };
  const patched = { ...actual, connect };
  return { ...patched, default: patched };
});

const { sendRemotePendingToEngine } = await import("../src/hub/engineRelaySocket.js");
const { runHookCore } = await import("../src/approval/hook.js");
const { tempSocketPath, canListenUnixSocket } = await import("./socketHelpers.js");

afterEach(() => {
  stalls.clear();
  fakeSockets.splice(0);
});

describe("engine relay への送信の厳密な上限", () => {
  for (const mode of ["connect", "end"] as const) {
    it(`${mode} が完了しない relay でも、上限で socket を破棄して戻る`, async () => {
      const relayPath = `/tmp/relay-stall-${mode}-${randomUUID().slice(0, 6)}.sock`;
      stalls.set(relayPath, mode);
      const startedAt = Date.now();
      await sendRemotePendingToEngine(
        { type: "remote_pending_cleared", v: 1, id: "x", session: "s", kind: "approval" }, relayPath, 120,
      );
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(600);
      expect(fakeSockets.length).toBeGreaterThan(0);
      expect(fakeSockets.every((s) => s.destroyed)).toBe(true);
    });
  }

  for (const mode of ["connect", "end"] as const) {
    it(`hook: relay の ${mode} が止まっても、つなぎ直しの期限切れの出口は上限で終わり、結果も変わらない`, async () => {
      if (!(await canListenUnixSocket())) return;
      const socketPath = tempSocketPath(`rst-${randomUUID().slice(0, 6)}`);
      fs.rmSync(socketPath, { force: true });
      const relayPath = `/tmp/relay-stall-hook-${randomUUID().slice(0, 6)}.sock`;
      stalls.set(relayPath, mode);
      const startedAt = Date.now();
      const result = await runHookCore({
        stdinData: Buffer.from(JSON.stringify({
          hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo stall" }, cwd: "/work", session_id: "s1",
        })),
        socketPath, deadlineSeconds: 0.4, session: "sess-stall", engineRelaySocketPath: relayPath,
        retryConnectIntervalSeconds: 0.05,
      });
      const elapsed = Date.now() - startedAt;
      const output = (JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      }).hookSpecificOutput;
      expect(output.permissionDecision).toBe("deny");
      expect(output.permissionDecisionReason).toContain("no reconnect within");
      // 処理中の知らせ・remote_pending は内部の期限の前、clear は後に、それぞれ 250ms で打ち切られる。
      // 期限 0.4s + clear 0.25s + 余裕（止まった試行が上限を持たなければ、ここで永久に戻らない）。
      expect(elapsed).toBeLessThan(2_000);
      expect(fakeSockets.every((s) => s.destroyed)).toBe(true);
    });
  }
});
