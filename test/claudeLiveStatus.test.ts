// claudeLiveStatus.test.ts — Claude Code の `~/.claude/sessions/<pid>.json` の読取と照合。
// フィクスチャは 2.1.283 の実ファイルの形（パスは公開用に伏せる）。

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claudePidOfHook,
  claudeProcessAlive,
  defaultClaudeSessionsDir,
  findClaudeLiveRecords,
  findClaudeLiveRecord,
  parseClaudeLiveRecord,
} from "../src/sessions/claudeLiveStatus.js";
import { makeTempDir } from "./helpers.js";

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({
    pid: 64632,
    sessionId: "95e31012-d73e-4df4-b022-018f31b63e55",
    cwd: "/Users/alice/project",
    startedAt: 1790465366194,
    procStart: "Sat Sep 26 23:29:25 2026",
    version: "2.1.283",
    kind: "interactive",
    entrypoint: "cli",
    tmux: "cs-abc:@0.%0",
    status: "idle",
    updatedAt: 1790465366241,
    statusUpdatedAt: 1790465366241,
    ...fields,
  });
}

function writeRecords(dir: string, records: Record<string, string>): void {
  for (const [name, content] of Object.entries(records)) fs.writeFileSync(path.join(dir, name), content);
}

describe("parseClaudeLiveRecord", () => {
  test("実ファイルの形を読む", () => {
    expect(parseClaudeLiveRecord(record({ status: "shell", statusUpdatedAt: 1790465400000 }))).toEqual({
      pid: 64632,
      sessionId: "95e31012-d73e-4df4-b022-018f31b63e55",
      status: "shell",
      statusSinceMs: 1790465400000,
      tmux: "cs-abc:@0.%0",
      procStart: "Sat Sep 26 23:29:25 2026",
    });
  });

  test("未知の status・pid 欠落・壊れた JSON は null（保護しない側）", () => {
    expect(parseClaudeLiveRecord(record({ status: "sleeping" }))).toBeNull();
    expect(parseClaudeLiveRecord(record({ pid: undefined }))).toBeNull();
    expect(parseClaudeLiveRecord("{")).toBeNull();
  });

  test("statusUpdatedAt が無い版は updatedAt を起点にする", () => {
    expect(parseClaudeLiveRecord(record({ statusUpdatedAt: undefined }))?.statusSinceMs).toBe(1790465366241);
  });
});

describe("findClaudeLiveRecord", () => {
  test("tmux 欄のセッション名で照合し、死んだ pid の残骸は無視する", async () => {
    const dir = makeTempDir("claude-sessions");
    writeRecords(dir, {
      "100.json": record({ pid: 100, tmux: "cs-abc:@0.%0", status: "busy" }),
      "200.json": record({ pid: 200, tmux: "cs-abcd:@1.%3", status: "busy" }),
      "300.json": record({ pid: 300, tmux: "cs-other:@2.%5", status: "shell" }),
      "notes.txt": "ignored",
    });
    const alive = new Set([200, 300]);
    const processAlive = (pid: number): boolean => alive.has(pid);

    // cs-abc の記録（pid 100）は死んでいる。prefix の似た cs-abcd を取り違えない。
    expect(await findClaudeLiveRecord({ dir, sessionName: "cs-abc", processAlive })).toBeNull();
    expect((await findClaudeLiveRecord({ dir, sessionName: "cs-other", processAlive }))?.status).toBe("shell");
  });

  test("tmux 欄が当たればそれだけを見る（同じ session id の別インスタンスの仕事中を拾わない）", async () => {
    const dir = makeTempDir("claude-sessions");
    writeRecords(dir, {
      "100.json": record({ pid: 100, tmux: "cs-dup:@0.%0", sessionId: "sid-1", status: "idle" }),
      "200.json": record({ pid: 200, tmux: undefined, sessionId: "sid-1", status: "shell" }),
    });
    const processAlive = (): boolean => true;

    const found = await findClaudeLiveRecord({ dir, sessionName: "cs-dup", claudeSessionId: "sid-1", processAlive });
    expect(found?.pid).toBe(100);
  });

  test("tmux 欄が無いときは pane の前面 pid で確定し、一致しなくても session id へ落ちない", async () => {
    const dir = makeTempDir("claude-sessions");
    writeRecords(dir, {
      "100.json": record({ pid: 100, tmux: undefined, sessionId: "sid-1", status: "idle" }),
      "200.json": record({ pid: 200, tmux: undefined, sessionId: "sid-1", status: "busy" }),
    });
    const processAlive = (): boolean => true;
    const find = (pids: number[] | null) => findClaudeLiveRecord({
      dir, sessionName: "s-herdr", paneProcessIds: async () => pids, claudeSessionId: "sid-1", processAlive,
    });

    expect((await find([100, 7]))?.pid).toBe(100);
    // 取れたが一致しない = この pane の Claude ではない。複製（200 busy）を拾わない。
    expect(await find([55])).toBeNull();
    // 取れない → session id。生きた一致が 2 件（複製がいる）は曖昧なので null。
    expect(await find(null)).toBeNull();
  });

  test("session id の段は tmux 欄の無い生きた記録がちょうど 1 件のときだけ採用する", async () => {
    const dir = makeTempDir("claude-sessions");
    writeRecords(dir, {
      "200.json": record({ pid: 200, tmux: undefined, sessionId: "sid-1", status: "busy" }),
      "300.json": record({ pid: 300, tmux: "main:@1.%4", sessionId: "sid-1", status: "busy" }),
      "400.json": record({ pid: 400, tmux: undefined, sessionId: "sid-1", status: "idle" }),
    });
    const found = await findClaudeLiveRecord({
      dir, sessionName: "s-herdr", paneProcessIds: async () => null, claudeSessionId: "sid-1",
      processAlive: (pid) => pid !== 400,
    });
    expect(found?.pid).toBe(200);
  });

  test("pid の段は tmux 欄を誤記した記録も拾い、記録が 0 件なら pane に問い合わせない", async () => {
    const dir = makeTempDir("claude-sessions");
    // TMUX を持つ herdr server 配下の Claude は外側の tmux pane 名を書いてしまう。
    writeRecords(dir, { "300.json": record({ pid: 300, tmux: "main:@1.%4", status: "busy" }) });
    const found = await findClaudeLiveRecord({
      dir, sessionName: "s-herdr", paneProcessIds: async () => [300], processAlive: () => true,
    });
    expect(found?.pid).toBe(300);

    let asked = false;
    expect(await findClaudeLiveRecord({
      dir: makeTempDir("claude-sessions-empty"), sessionName: "s-herdr",
      paneProcessIds: async () => { asked = true; return [300]; }, processAlive: () => true,
    })).toBeNull();
    expect(asked).toBe(false);
  });

  test("同じ tmux セッションに Claude が複数いれば全件返す（teammate の分割 pane 等）", async () => {
    const dir = makeTempDir("claude-sessions");
    writeRecords(dir, {
      "72209.json": record({ pid: 72209, tmux: "cs-x:@0.%0", status: "idle" }),
      "100500.json": record({ pid: 100500, tmux: "cs-x:@0.%3", status: "idle" }),
    });
    const found = await findClaudeLiveRecords({ dir, sessionName: "cs-x", processAlive: () => true });
    expect(found.map((r) => r.pid).sort((x, y) => x - y)).toEqual([72209, 100500]);
  });

  test("置き場が無ければ null", async () => {
    expect(await findClaudeLiveRecord({ dir: "/nonexistent/claude/sessions", sessionName: "cs-x" })).toBeNull();
  });
});

describe("claudePidOfHook", () => {
  test("親 pid に起動時刻まで一致する状態ファイルがあれば親（Claude は hook を直接子として起動する）", () => {
    const dir = makeTempDir("claude-sessions");
    expect(claudePidOfHook(dir)).toBeUndefined();
    const lstart = (pid: number): string => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    }).trim();
    // 異常終了した旧 Claude の残骸（pid だけ重なり起動時刻が違う）は持ち主にしない。
    fs.writeFileSync(path.join(dir, `${process.ppid}.json`),
      record({ pid: process.ppid, procStart: "Thu Jan  1 00:00:00 1970" }));
    expect(claudePidOfHook(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, `${process.ppid}.json`), record({ pid: process.ppid, procStart: lstart(process.ppid) }));
    expect(claudePidOfHook(dir)).toBe(process.ppid);
  });

  test("置き場は TAILII_CLAUDE_SESSIONS_DIR → CLAUDE_CONFIG_DIR/sessions → ~/.claude/sessions", () => {
    const saved = { t: process.env["TAILII_CLAUDE_SESSIONS_DIR"], c: process.env["CLAUDE_CONFIG_DIR"] };
    try {
      process.env["TAILII_CLAUDE_SESSIONS_DIR"] = "/x/override";
      process.env["CLAUDE_CONFIG_DIR"] = "/x/config";
      expect(defaultClaudeSessionsDir()).toBe("/x/override");
      delete process.env["TAILII_CLAUDE_SESSIONS_DIR"];
      expect(defaultClaudeSessionsDir()).toBe(path.join("/x/config", "sessions"));
      process.env["CLAUDE_CONFIG_DIR"] = "";
      expect(defaultClaudeSessionsDir()).toBe(path.join(os.homedir(), ".claude", "sessions"));
    } finally {
      if (saved.t === undefined) delete process.env["TAILII_CLAUDE_SESSIONS_DIR"];
      else process.env["TAILII_CLAUDE_SESSIONS_DIR"] = saved.t;
      if (saved.c === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = saved.c;
    }
  });
});

describe("claudeProcessAlive", () => {
  test("自プロセスは生存、起動時刻が食い違えば別プロセス（pid 再利用）とみなす", async () => {
    expect(await claudeProcessAlive(process.pid, null)).toBe(true);
    // Claude Code の procStart は UTC の `ps -o lstart=` と同じ書式。
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    }).trim();
    expect(await claudeProcessAlive(process.pid, lstart)).toBe(true);
    expect(await claudeProcessAlive(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
  });

  test("存在しない pid は死亡", async () => {
    expect(await claudeProcessAlive(2 ** 22 + 12345, null)).toBe(false);
  });
});
