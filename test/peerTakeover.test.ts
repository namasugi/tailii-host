// peerTakeover.test.ts — 他所で動く同じ会話の Claude の分類・本人確認・終了（peer-takeover）

import { describe, expect, test } from "vitest";
import {
  classifyPeers,
  parseHerdrEnv,
  parseProcessTable,
  takeoverToken,
  tailiiSessionFromArgs,
  terminateTakeoverTarget,
  verifyTakeover,
  type PeerProbe,
  type PeerProcess,
  type TakeoverTarget,
} from "../src/services/peerTakeover.js";
import type { PeerSessionRecord } from "../src/services/peerSessions.js";

const CONV = "40efa4d9-f293-4b12-a1f8-73abb5e75023";
const START = "Sat Nov 14 07:36:50 2026";

function record(overrides: Partial<PeerSessionRecord> = {}): PeerSessionRecord {
  return {
    pid: 500, sessionId: CONV, cwd: "/w", name: "work-1", status: "idle", kind: "interactive", entrypoint: "cli",
    bridged: false, messagingSocketPath: null, startedAt: null, procStart: START, pidDomain: "darwin", version: "2.1.325",
    ...overrides,
  };
}

function proc(pid: number, ppid: number, comm: string, overrides: Partial<PeerProcess> = {}): PeerProcess {
  return { pid, ppid, uid: 501, tty: "ttys003", stat: "S+", startedUtc: START, comm, ...overrides };
}

/** 端末アプリ(100) → ログインシェル zsh(400) → claude(500) の典型形。 */
function probe(options: {
  records?: PeerSessionRecord[];
  procs?: PeerProcess[];
  args?: Record<number, string>;
  env?: Record<number, Record<string, string>>;
} = {}): PeerProbe {
  const procs = options.procs ?? [
    proc(100, 1, "Terminal", { tty: null, stat: "S" }),
    proc(400, 100, "zsh", { stat: "Ss" }),
    proc(500, 400, "claude"),
  ];
  const args: Record<number, string> = { 400: "-zsh", 500: "claude --resume x", ...options.args };
  return {
    processTable: async () => new Map(procs.map((p) => [p.pid, p])),
    args: async (pid) => args[pid] ?? null,
    herdrEnv: async (pid) => options.env?.[pid] ?? {},
    registry: () => options.records ?? [record()],
    uid: () => 501,
    pidDomain: () => "darwin",
  };
}

const noTailii = () => false;

describe("classifyPeers", () => {
  test("登録簿に無ければ none", async () => {
    expect(await classifyPeers(CONV, probe({ records: [] }), noTailii)).toEqual({ kind: "none" });
  });

  test("登録簿の残骸（pid が無い・別のプロセスに再利用されている）は数えない", async () => {
    expect(await classifyPeers(CONV, probe({ records: [record({ pid: 999 })] }), noTailii)).toEqual({ kind: "none" });
    const reused = [proc(400, 1, "zsh"), proc(500, 400, "vim", { startedUtc: "Sat Nov 14 09:00:00 2026" })];
    expect(await classifyPeers(CONV, probe({ procs: reused, records: [record()] }), noTailii)).toEqual({ kind: "none" });
  });

  test("Claude が動いているのに起動時刻で確かめられない（procStart なし・不一致）なら、終了させず並走の確認へ（レビュー指摘 1）", async () => {
    for (const procStart of [null, "Fri Nov 13 01:00:00 2026"]) {
      expect(await classifyPeers(CONV, probe({ records: [record({ procStart })] }), noTailii))
        .toMatchObject({ kind: "parallel", holder: "other" });
    }
  });

  test("起動時刻で確かめられなくても、Tailii 自身の Claude なら Tailii の名前で返す（2 周目 7）", async () => {
    const args = { 500: 'claude --settings {"command":"cli.js hook --session s-own"}' };
    expect(await classifyPeers(CONV, probe({ args, records: [record({ procStart: null })] }), (n) => n === "s-own"))
      .toMatchObject({ kind: "parallel", holder: "tailii", tailiiSession: "s-own" });
  });

  test("祖先がネイティブ版の Claude（版番号の名前）でも入れ子とみなす（レビュー指摘 7）", async () => {
    const procs = [proc(300, 1, "2.1.325"), proc(400, 300, "zsh"), proc(500, 400, "claude")];
    expect(await classifyPeers(CONV, probe({ procs }), noTailii)).toMatchObject({ kind: "parallel" });
  });

  test("普通のターミナルの対話シェルから起動した Claude は開き直しの対象", async () => {
    const result = await classifyPeers(CONV, probe(), noTailii);
    expect(result).toEqual({
      kind: "takeover",
      target: { pid: 500, procStart: START, conversationId: CONV, name: "work-1", busy: false, herdr: null },
    });
  });

  test("herdr のタブは、環境変数の手がかりを pane の前面で確かめたときだけ配置に使う", async () => {
    const env = { 500: { HERDR_SESSION: "default", HERDR_PANE_ID: "w2:p3" } };
    const verified = await classifyPeers(CONV, probe({ env }), noTailii, async (s, p, pid) =>
      s === "default" && p === "w2:p3" && pid === 500);
    expect(verified.kind === "takeover" && verified.target.herdr).toEqual({ session: "default", paneId: "w2:p3" });
    const unverified = await classifyPeers(CONV, probe({ env }), noTailii, async () => false);
    expect(unverified.kind === "takeover" && unverified.target.herdr).toBeNull();
  });

  test("Tailii が起動した Claude（引数のフック設定にセッション名）は終了させない", async () => {
    const args = { 500: 'claude --session-id x --settings {"hooks":{"command":"node cli.js hook --session s-abc"}}' };
    const result = await classifyPeers(CONV, probe({ args }), (name) => name === "s-abc");
    expect(result).toMatchObject({ kind: "parallel", holder: "tailii", tailiiSession: "s-abc" });
  });

  test("公式アプリ（Remote Control）につながっている・端末以外は並走の扱い", async () => {
    expect(await classifyPeers(CONV, probe({ records: [record({ bridged: true })] }), noTailii))
      .toMatchObject({ kind: "parallel", holder: "remote" });
    expect(await classifyPeers(CONV, probe({ records: [record({ entrypoint: "vscode" })] }), noTailii))
      .toMatchObject({ kind: "parallel", holder: "other" });
    expect(await classifyPeers(CONV, probe({ records: [record({ pidDomain: "linux" })] }), noTailii))
      .toMatchObject({ kind: "parallel", holder: "other" });
  });

  test.each([
    { label: "背景で実行中（前面でない）", procs: [proc(400, 1, "zsh"), proc(500, 400, "claude", { stat: "S" })] },
    { label: "Ctrl-Z で停止中", procs: [proc(400, 1, "zsh"), proc(500, 400, "claude", { stat: "T+" })] },
    { label: "端末が無い（nohup 等）", procs: [proc(400, 1, "zsh"), proc(500, 400, "claude", { tty: null })] },
    { label: "別のユーザー", procs: [proc(400, 1, "zsh"), proc(500, 400, "claude", { uid: 0 })] },
    { label: "親がシェルでない（他のアプリが抱えている）", procs: [proc(400, 1, "node"), proc(500, 400, "claude")] },
  ])("正の条件を満たさないものは開き直さない: $label", async ({ procs }) => {
    expect(await classifyPeers(CONV, probe({ procs }), noTailii)).toMatchObject({ kind: "parallel", holder: "other" });
  });

  test("親が -c で何かを実行しているシェル（タブのコマンドとして直接起動など）は対象外", async () => {
    expect(await classifyPeers(CONV, probe({ args: { 400: "/bin/zsh -lc claude" } }), noTailii))
      .toMatchObject({ kind: "parallel" });
  });

  test("祖先に Claude が居る（Claude が起動した入れ子の claude）は対象外", async () => {
    const procs = [proc(300, 1, "claude"), proc(400, 300, "zsh"), proc(500, 400, "claude")];
    expect(await classifyPeers(CONV, probe({ procs }), noTailii)).toMatchObject({ kind: "parallel" });
  });

  test("同じ会話が 2 か所で動いていれば判別不能（どちらも終了させない）", async () => {
    const records = [record(), record({ pid: 501 })];
    const procs = [proc(400, 1, "zsh"), proc(500, 400, "claude"), proc(501, 400, "claude")];
    expect(await classifyPeers(CONV, probe({ records, procs }), noTailii)).toMatchObject({ kind: "unknown" });
  });

  test("プロセス名が Claude でなければ判別不能。ネイティブ版の版番号の名前は Claude とみなす", async () => {
    const vim = [proc(400, 1, "zsh"), proc(500, 400, "vim")];
    expect(await classifyPeers(CONV, probe({ procs: vim }), noTailii)).toMatchObject({ kind: "unknown" });
    const native = [proc(400, 1, "zsh"), proc(500, 400, "2.1.325")];
    expect(await classifyPeers(CONV, probe({ procs: native }), noTailii)).toMatchObject({ kind: "takeover" });
  });
});

describe("確認用トークン", () => {
  const target: TakeoverTarget = { pid: 500, procStart: START, conversationId: CONV, name: "w", busy: false, herdr: null };

  test("同じ対象・期限内なら通る", () => {
    expect(verifyTakeover(takeoverToken(target, 1_000), target, false, 2_000)).toEqual({ ok: true });
  });

  test("別の対象・期限切れ・改ざん・処理中への変化は通さない", () => {
    const token = takeoverToken(target, 1_000);
    expect(verifyTakeover(token, { ...target, pid: 501 }, false, 2_000)).toEqual({ ok: false, reason: "changed" });
    expect(verifyTakeover(token, { ...target, procStart: "x" }, false, 2_000)).toEqual({ ok: false, reason: "changed" });
    expect(verifyTakeover(token, target, false, 1_000 + 10 * 60 * 1000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyTakeover(`${token}x`, target, false, 2_000)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTakeover(token, { ...target, busy: true }, false, 2_000)).toEqual({ ok: false, reason: "busy" });
    expect(verifyTakeover(token, { ...target, busy: true }, true, 2_000)).toEqual({ ok: true });
  });
});

describe("terminateTakeoverTarget", () => {
  const target: TakeoverTarget = { pid: 500, procStart: START, conversationId: CONV, name: "w", busy: false, herdr: null };

  test("pid だけに SIGTERM を送り、終わるのを待つ", async () => {
    const sent: [number, string][] = [];
    let alive = true;
    const ok = await terminateTakeoverTarget(target, {
      kill: (pid, signal) => { sent.push([pid, signal]); setTimeout(() => { alive = false; }, 20); },
      isAlive: () => alive,
      registryFile: () => "/nonexistent",
      pollMs: 5,
    });
    expect(ok).toBe(true);
    expect(sent).toEqual([[500, "SIGTERM"]]);
  });

  test("終わらなければ SIGKILL に上げず false", async () => {
    const sent: string[] = [];
    const ok = await terminateTakeoverTarget(target, {
      kill: (_pid, signal) => { sent.push(signal); },
      isAlive: () => true,
      timeoutMs: 30,
      pollMs: 5,
    });
    expect(ok).toBe(false);
    expect(sent).toEqual(["SIGTERM"]);
  });
});

describe("パーサ", () => {
  test("ps の表（lstart は 5 語・端末なしは null・ログインシェルの - を外す）", () => {
    const table = parseProcessTable([
      "  400   100   501 ttys003  Ss   Sat Nov 14 07:30:00 2026     -zsh",
      "  500   400   501 ttys003  S+   Sat Nov 14 07:36:50 2026     /Users/x/.local/bin/claude",
      "  600     1   501 ??       S    Sat Nov 14 07:36:50 2026     /Applications/Some App.app/Contents/MacOS/Some App",
    ].join("\n"));
    expect(table.get(400)).toMatchObject({ comm: "zsh", tty: "ttys003" });
    expect(table.get(500)).toMatchObject({ comm: "claude", stat: "S+", startedUtc: START });
    expect(table.get(600)).toMatchObject({ tty: null, comm: "Some App" });
  });

  test("環境変数の HERDR_ だけを拾う", () => {
    expect(parseHerdrEnv("claude --x HOME=/u HERDR_SESSION=default HERDR_PANE_ID=w2:p3 TERM=xterm"))
      .toEqual({ HERDR_SESSION: "default", HERDR_PANE_ID: "w2:p3" });
  });

  test("引数のフック設定から Tailii のセッション名（--session-id は無視）", () => {
    expect(tailiiSessionFromArgs('claude --session-id 1234 --settings {"command":"cli.js hook --session s-f5a5"}'))
      .toBe("s-f5a5");
    expect(tailiiSessionFromArgs("claude --session-id 1234")).toBeNull();
  });
});
