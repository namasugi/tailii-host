// engineServe.test.ts — serve_list / serve_stop の Engine dispatch 統合検証
//
// engine はテストプロセス内で動くため serve_list は自 pid（= vitest）を除外する。
// ここでは wire の往復（id 相関・応答形）を検証し、列挙・停止の実体は
// serveService.test.ts が実ソケット/実子プロセスで検証する。

import { spawn } from "node:child_process";
import net from "node:net";
import { describe, expect, test } from "vitest";
import { decodeControlMessage } from "../src/protocol.js";
import { TmuxSessionManager } from "../src/tmux.js";
import { MockTmuxRunner, startEngine } from "./helpers.js";

describe("EngineControl — serve-list", () => {
  test("serve_list_request / serve_stop_request を wire 応答へ dispatch する", async () => {
    const manager = new TmuxSessionManager({
      runner: new MockTmuxRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })).runner,
    });
    const engine = startEngine({ sessionManager: manager });
    await engine.lines.nextOfType("channel_hello");

    // 子プロセスの listener を立てる（engine は自 pid を除外するため、
    // 一覧に必ず現れる別プロセスのサーバーを用意する）。
    const child = spawn(process.execPath, [
      "-e",
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("listen 待ちタイムアウト")), 10_000);
        child.stdout!.on("data", (chunk: Buffer) => {
          const value = Number(String(chunk).trim());
          if (Number.isInteger(value) && value > 0) {
            clearTimeout(timer);
            resolve(value);
          }
        });
        child.on("error", reject);
      });

      engine.writeLine(JSON.stringify({ type: "serve_list_request", v: 1, id: "sv" }));
      const listResponse = decodeControlMessage(await engine.lines.nextOfType("serve_list_response"));
      expect(listResponse).toMatchObject({
        type: "serve_list_response", id: "sv",
        servers: expect.arrayContaining([
          expect.objectContaining({ pid: child.pid, port, cwd: process.cwd() }),
        ]),
      });

      engine.writeLine(JSON.stringify({ type: "serve_stop_request", v: 1, id: "st", pid: child.pid, port }));
      expect(decodeControlMessage(await engine.lines.nextOfType("serve_stop_response"))).toEqual({
        type: "serve_stop_response", v: 2, id: "st", ok: true, error: null,
      });

      // 存在しない対象は ok=false で応答する（照合ガード）。
      engine.writeLine(JSON.stringify({ type: "serve_stop_request", v: 1, id: "st2", pid: child.pid, port }));
      expect(decodeControlMessage(await engine.lines.nextOfType("serve_stop_response"))).toMatchObject({
        type: "serve_stop_response", id: "st2", ok: false,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await engine.teardown();
    }
  }, 30_000);
});
