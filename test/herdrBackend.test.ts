// herdrBackend.test.ts — herdr backend（HerdrSessionManager / sessionBackend / launch herdr 経路）
// 実 herdr は起動しない（モックランナー / モック ProcessRunner）。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  HerdrFailedError,
  HerdrSessionManager,
  parseHerdrCreatedTabPaneId,
  parseHerdrForegroundCommand,
  parseHerdrPaneList,
  parseHerdrStartedPaneId,
  screenHasSelectionFooter,
  typedTextProbe,
  type HerdrCommandResult,
  type HerdrCommandRunner,
} from "../src/backend/herdr.js";
import { launchCore, type ProcessRunner } from "../src/commands/launch.js";
import {
  CompositeSessionBackend,
  makeBackendForSession,
  makeSessionBackend,
  resolveSessionBackendKind,
} from "../src/backend/sessionBackend.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";
import { extractClaudeInputBox, TmuxSessionManager } from "../src/backend/tmux.js";
import { makeTempDir, MockTmuxRunner, ok } from "./helpers.js";

/** 記録付きモック herdr ランナー。 */
class MockHerdrRunner {
  readonly recorded: string[][] = [];
  constructor(private readonly handler: (args: string[]) => HerdrCommandResult) {}

  get runner(): HerdrCommandRunner {
    return async (args) => {
      this.recorded.push(args);
      return this.handler(args);
    };
  }
}

function herdrOk(stdout: string): HerdrCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/** herdr `pane list` の JSON stdout を組み立てる。 */
function paneListJson(panes: { pane_id: string; label?: string; tab_id?: string }[]): string {
  return JSON.stringify({ id: "cli:pane:list", result: { type: "pane_list", panes } });
}

/** herdr `tab list` の JSON stdout を組み立てる。 */
function tabListJson(tabs: { tab_id: string; label: string }[]): string {
  return JSON.stringify({ id: "cli:tab:list", result: { type: "tab_list", tabs } });
}

/** herdr `pane process-info` の JSON stdout を組み立てる。 */
function processInfoJson(name: string): string {
  return JSON.stringify({
    id: "cli:pane:process_info",
    result: {
      type: "pane_process_info",
      process_info: { pane_id: "w9:p1", shell_pid: 1, foreground_processes: [{ name, pid: 1 }] },
    },
  });
}

function makeStore(): SessionMetadataStore {
  return new SessionMetadataStore(makeTempDir("herdr-backend-store"));
}

describe("resolveSessionBackendKind", () => {
  test("不在/不正は tmux、`herdr`（大文字・空白許容）は herdr", () => {
    const dir = makeTempDir("backend-kind");
    const file = path.join(dir, "backend");
    expect(resolveSessionBackendKind(file)).toBe("tmux");
    fs.writeFileSync(file, "garbage\n");
    expect(resolveSessionBackendKind(file)).toBe("tmux");
    fs.writeFileSync(file, " HERDR \n");
    expect(resolveSessionBackendKind(file)).toBe("herdr");
    fs.writeFileSync(file, "tmux\n");
    expect(resolveSessionBackendKind(file)).toBe("tmux");
  });
});

describe("SessionMetadataStore backend 欄", () => {
  test("backend / herdrPaneId を往復し、不正 pane ID は落とす", () => {
    const store = makeStore();
    store.put({ name: "s-h", cwd: "/tmp", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    expect(store.get("s-h")).toEqual({
      name: "s-h", cwd: "/tmp", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2",
    });
    // 手書き等で壊れた pane ID は decode で落とす（backend は残る）。
    const file = path.join((store as unknown as { base: string })["base"], "s-bad.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ name: "s-bad", cwd: "/tmp", createdAt: 2, backend: "herdr", herdrPaneId: "%5" }),
    );
    expect(store.get("s-bad")).toEqual({ name: "s-bad", cwd: "/tmp", createdAt: 2, backend: "herdr" });
  });
});

describe("herdr JSON パーサ", () => {
  test("pane list / agent start / process-info を読める", () => {
    expect(
      parseHerdrPaneList(
        paneListJson([{ pane_id: "w4:p2", label: "s-a", tab_id: "w4:t2" }, { pane_id: "w4:p3" }]),
      ),
    ).toEqual([
      { paneId: "w4:p2", label: "s-a", tabId: "w4:t2" },
      { paneId: "w4:p3", label: null, tabId: null },
    ]);
    expect(parseHerdrPaneList("not json")).toEqual([]);
    expect(
      parseHerdrStartedPaneId(
        JSON.stringify({ result: { type: "agent_started", agent: { pane_id: "w4:p2" } } }),
      ),
    ).toBe("w4:p2");
    expect(
      parseHerdrCreatedTabPaneId(
        JSON.stringify({
          result: {
            type: "tab_created",
            root_pane: { pane_id: "w4:p9", tab_id: "w4:t3" },
            tab: { tab_id: "w4:t3", label: "8" },
          },
        }),
      ),
    ).toBe("w4:p9");
    expect(parseHerdrCreatedTabPaneId(JSON.stringify({ result: { type: "tab_created" } }))).toBeNull();
    expect(parseHerdrCreatedTabPaneId("not json")).toBeNull();
    expect(parseHerdrForegroundCommand(processInfoJson("claude"))).toBe("claude");
    expect(parseHerdrForegroundCommand("{}")).toBe("");
  });
});

describe("HerdrSessionManager", () => {
  test("list は herdr メタだけを列挙し、pane ID/label 一致で alive を判定する", async () => {
    const store = makeStore();
    store.put({ name: "s-live", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    store.put({ name: "s-dead", cwd: "/b", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p9" });
    store.put({ name: "s-label", cwd: "/c", createdAt: 3, backend: "herdr" });
    store.put({ name: "s-tmux", cwd: "/d", createdAt: 4 }); // tmux メタは列挙しない
    const runner = new MockHerdrRunner(() =>
      herdrOk(paneListJson([{ pane_id: "w4:p2" }, { pane_id: "w4:p5", label: "s-label" }])),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    const infos = await manager.list();
    expect(infos.map((info) => [info.name, info.alive])).toEqual([
      ["s-dead", false],
      ["s-label", true],
      ["s-live", true],
    ]);
  });

  test("list は herdr server 不通（非0 exit）で全員 alive:false に倒す", async () => {
    const store = makeStore();
    store.put({ name: "s-x", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner(() => ({ exitCode: 1, stdout: "", stderr: "connect error" }));
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    expect((await manager.list()).map((info) => info.alive)).toEqual([false]);
  });

  test("sendKeys: literal はテキスト、既知キーは send-keys、BTab は生シーケンス、数字はテキスト", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) =>
      args[0] === "pane" && args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : herdrOk(""),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    await manager.sendKeys("s-a", ["hello world"], true);
    await manager.sendKeys("s-a", ["Enter"]);
    await manager.sendKeys("s-a", ["Down"]);
    await manager.sendKeys("s-a", ["BTab"]);
    await manager.sendKeys("s-a", ["1"]);
    const sends = runner.recorded.filter((args) => args[1]?.startsWith("send-"));
    expect(sends).toEqual([
      ["pane", "send-text", "w4:p2", "hello world"],
      // Enter は生 CR（send-keys Enter は Ink が submit と認識しない。実測 2026-07-22）。
      ["pane", "send-text", "w4:p2", "\r"],
      ["pane", "send-keys", "w4:p2", "Down"],
      ["pane", "send-text", "w4:p2", "\u001b[Z"],
      ["pane", "send-text", "w4:p2", "1"],
    ]);
  });

  test("list はタブラベルがセッション名/既定連番/自動適用値と異なるときだけ displayTitle を載せる（逆方向同期）", async () => {
    const store = makeStore();
    store.put({ name: "s-titled", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    store.put({ name: "s-plain", cwd: "/b", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p3" });
    store.put({ name: "s-default", cwd: "/c", createdAt: 3, backend: "herdr", herdrPaneId: "w4:p4" });
    // hub tick が自動適用したタイトル（meta.autoTabTitle と一致）は人為リネームではない。
    store.put({
      name: "s-auto", cwd: "/e", createdAt: 5, backend: "herdr", herdrPaneId: "w4:p5",
      autoTabTitle: "自動タイトル",
    });
    store.put({ name: "s-dead", cwd: "/d", createdAt: 4, backend: "herdr", herdrPaneId: "w4:p9" });
    const runner = new MockHerdrRunner((args) => {
      if (args[0] === "pane" && args[1] === "list") {
        return herdrOk(paneListJson([
          { pane_id: "w4:p2", label: "s-titled", tab_id: "w4:t2" },
          { pane_id: "w4:p3", label: "s-plain", tab_id: "w4:t3" },
          { pane_id: "w4:p4", label: "s-default", tab_id: "w4:t4" },
          { pane_id: "w4:p5", label: "s-auto", tab_id: "w4:t5" },
        ]));
      }
      if (args[0] === "tab" && args[1] === "list") {
        return herdrOk(tabListJson([
          { tab_id: "w4:t2", label: "認証バグの調査" },
          { tab_id: "w4:t3", label: "s-plain" },
          // 0.7.5 tab create の既定連番ラベル → 人為リネームではないので載せない。
          { tab_id: "w4:t4", label: "7" },
          { tab_id: "w4:t5", label: "自動タイトル" },
        ]));
      }
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    const infos = await manager.list();
    expect(infos.find((info) => info.name === "s-titled")?.displayTitle).toBe("認証バグの調査");
    expect(infos.find((info) => info.name === "s-plain")?.displayTitle).toBeUndefined();
    expect(infos.find((info) => info.name === "s-default")?.displayTitle).toBeUndefined();
    expect(infos.find((info) => info.name === "s-auto")?.displayTitle).toBeUndefined();
    expect(infos.find((info) => info.name === "s-dead")?.displayTitle).toBeUndefined();
  });

  test("tabInfoByName は生存 pane の name → タブ情報を返す", async () => {
    const store = makeStore();
    const runner = new MockHerdrRunner((args) => {
      if (args[0] === "pane" && args[1] === "list") {
        return herdrOk(paneListJson([
          { pane_id: "w4:p2", label: "s-a", tab_id: "w4:t2" },
          { pane_id: "w4:p3" }, // label 無しは含めない
        ]));
      }
      if (args[0] === "tab" && args[1] === "list") {
        return herdrOk(tabListJson([{ tab_id: "w4:t2", label: "タイトル" }]));
      }
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    expect(await manager.tabInfoByName()).toEqual(
      new Map([["s-a", { tabId: "w4:t2", label: "タイトル" }]]),
    );
  });

  test("setDisplayTitle: pane の tab を tab rename で書き換える（pane label は触らない）", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) =>
      args[0] === "pane" && args[1] === "list"
        ? herdrOk(paneListJson([{ pane_id: "w4:p2", label: "s-a", tab_id: "w4:t2" }]))
        : herdrOk(""),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    await manager.setDisplayTitle("s-a", " 認証バグの調査 ");
    expect(runner.recorded).toContainEqual(["tab", "rename", "w4:t2", "認証バグの調査"]);
    expect(runner.recorded.some((args) => args[0] === "pane" && args[1] === "rename")).toBe(false);
  });

  test("setDisplayTitle: 空/null はセッション名へ戻す", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) =>
      args[0] === "pane" && args[1] === "list"
        ? herdrOk(paneListJson([{ pane_id: "w4:p2", label: "s-a", tab_id: "w4:t2" }]))
        : herdrOk(""),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    await manager.setDisplayTitle("s-a", "");
    await manager.setDisplayTitle("s-a", null);
    expect(runner.recorded.filter((args) => args[0] === "tab")).toEqual([
      ["tab", "rename", "w4:t2", "s-a"],
      ["tab", "rename", "w4:t2", "s-a"],
    ]);
  });

  test("setDisplayTitle: pane 不在 / tab_id 不明（旧 herdr）は throw する", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const gone = new HerdrSessionManager({
      runner: new MockHerdrRunner(() => herdrOk(paneListJson([]))).runner,
      store,
    });
    await expect(gone.setDisplayTitle("s-a", "t")).rejects.toThrow(HerdrFailedError);
    const noTab = new HerdrSessionManager({
      runner: new MockHerdrRunner((args) =>
        args[0] === "pane" && args[1] === "list"
          ? herdrOk(paneListJson([{ pane_id: "w4:p2", label: "s-a" }]))
          : herdrOk(""),
      ).runner,
      store,
    });
    await expect(noTab.setDisplayTitle("s-a", "t")).rejects.toThrow(HerdrFailedError);
  });

  /** sendTextSubmit 検証用の pane 状態機械（send 内容で画面を遷移させ、read は現在画面を返す）。 */
  function makeSubmitHarness(options: {
    agentStatuses?: string[];
    /** send-text（本文）を反映しない回数（RC 切断 limbo の黙殺挙動）。 */
    swallowTextInputs?: number;
    /** 最初の CR を飲む回数（実測: 300ms 未満で CR が飲まれる挙動）。 */
    swallowEnters?: number;
    /** CR の結果ダイアログを開く（RC active 中の /remote-control）。 */
    openDialogOnEnter?: boolean;
    /** 初期状態でダイアログが開いている。 */
    dialogInitiallyOpen?: boolean;
    /** 初期状態で入力欄に残存テキストがある（中断で queued が書き戻された状態）。 */
    initialInput?: string;
    /** 初期状態でシェルモード（プロンプトが `!`）に入ったままになっている。 */
    initiallyShellMode?: boolean;
  } = {}) {
    const state = {
      input: options.initialInput ?? "",
      shellMode: options.initiallyShellMode ?? false,
      dialogOpen: options.dialogInitiallyOpen ?? false,
      swallowTextInputs: options.swallowTextInputs ?? 0,
      swallowEnters: options.swallowEnters ?? 0,
      statusReads: 0,
    };
    const dialogScreen = [
      "   Remote Control",
      "     Disconnect this session",
      "   ❯ Continue",
      "   Enter to select · Esc to continue",
    ].join("\n");
    const runner = new MockHerdrRunner((args) => {
      if (args[0] === "pane" && args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      // 0.7.5: 準備ゲートは `agent get <name>`（agent_not_found になる）ではなく
      // pane 解決 → `pane get` の agent_status を読む。
      if (args[0] === "pane" && args[1] === "get") {
        const statuses = options.agentStatuses ?? ["idle"];
        const status = statuses[Math.min(state.statusReads, statuses.length - 1)];
        state.statusReads += 1;
        return herdrOk(JSON.stringify({
          result: { pane: { pane_id: "w4:p2", agent_status: status } },
        }));
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { exitCode: 1, stdout: "", stderr: "agent target not found" };
      }
      if (args[0] === "pane" && args[1] === "send-keys" && args[3] === "Escape") {
        state.dialogOpen = false;
        return herdrOk("");
      }
      if (args[0] === "pane" && args[1] === "send-keys" && args[3] === "Backspace") {
        // 空入力の Backspace はシェルモード記号を消す（本文があれば 1 文字削る）。
        if (state.input.length > 0) state.input = state.input.slice(0, -1);
        else state.shellMode = false;
        return herdrOk("");
      }
      if (args[0] === "pane" && args[1] === "send-text" && args[3] === "\r") {
        if (state.swallowEnters > 0) {
          state.swallowEnters -= 1;
        } else if (options.openDialogOnEnter) {
          state.dialogOpen = true;
          state.input = "";
          state.shellMode = false;
        } else {
          state.input = "";
          state.shellMode = false;
        }
        return herdrOk("");
      }
      if (args[0] === "pane" && args[1] === "send-text") {
        if (state.dialogOpen || state.swallowTextInputs > 0) {
          if (state.swallowTextInputs > 0) state.swallowTextInputs -= 1;
          // ダイアログ/limbo は本文を反映しない。
        } else {
          // 空入力の先頭 `!` はモード記号として吸われ、本文には残らない（実測 2.1.220）。
          let typed = String(args[3]);
          if (state.input.length === 0 && !state.shellMode && typed.startsWith("!")) {
            state.shellMode = true;
            typed = typed.slice(1);
          }
          state.input += typed;
        }
        return herdrOk("");
      }
      if (args[0] === "pane" && args[1] === "read") {
        if (state.dialogOpen) return herdrOk(dialogScreen);
        const rule = "─".repeat(40);
        const sigil = state.shellMode ? "!" : "❯";
        const footer = state.shellMode ? "  ! for shell mode" : "  ⏸ manual mode on";
        return herdrOk(
          [`❯ 古いメッセージのエコー`, rule, `${sigil} ${state.input}`, rule, footer].join("\n"),
        );
      }
      return herdrOk("");
    });
    return { runner, state };
  }

  const submitSends = (runner: MockHerdrRunner) =>
    runner.recorded.filter((args) => args[1]?.startsWith("send-"));

  test("sendTextSubmit: 中断で書き戻された残存テキストは先に Enter で独立送信してから注入する", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness({ initialInput: "前回の本文" });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    await manager.sendTextSubmit("s-a", "今回の本文");
    // 残存 flush（独立メッセージとして送信）→ 本文 → CR。連結（"前回の本文今回の本文"）に
    // ならないこと（実機FB 2026-07-29: 停止→送信の二重表示）。
    expect(submitSends(runner)).toEqual([
      ["pane", "send-text", "w4:p2", "\r"],
      ["pane", "send-text", "w4:p2", "今回の本文"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
  });

  test("sendTextSubmit: 本文反映を検証し、CR が飲まれたら CR を再送する", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner, state } = makeSubmitHarness({
      agentStatuses: ["unknown", "idle"],
      swallowEnters: 1,
    });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    await manager.sendTextSubmit("s-a", "こんにちは");
    // agent 検出待ち(unknown→idle) → 本文 → CR（飲まれる） → CR 再送 → 空検知で終了。
    expect(state.statusReads).toBe(2);
    expect(submitSends(runner)).toEqual([
      ["pane", "send-text", "w4:p2", "こんにちは"],
      ["pane", "send-text", "w4:p2", "\r"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
  });

  test("sendTextSubmit: limbo 黙殺（本文が入力欄に入らない）は再投入し、回復しなければ throw する", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness({ swallowTextInputs: 99 });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    // 3 回とも反映されず throw（chat_send は uncertain となり silent loss を防ぐ）。
    await expect(manager.sendTextSubmit("s-a", "重要なメッセージ")).rejects.toThrow();
    expect(submitSends(runner)).toEqual([
      ["pane", "send-text", "w4:p2", "重要なメッセージ"],
      ["pane", "send-text", "w4:p2", "重要なメッセージ"],
      ["pane", "send-text", "w4:p2", "重要なメッセージ"],
    ]);
  });

  test("sendTextSubmit: limbo が明けたら再投入で回復し送信を完了する", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness({ swallowTextInputs: 1 });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    await manager.sendTextSubmit("s-a", "重要なメッセージ");
    expect(submitSends(runner)).toEqual([
      ["pane", "send-text", "w4:p2", "重要なメッセージ"],
      ["pane", "send-text", "w4:p2", "重要なメッセージ"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
  });

  test("sendTextSubmit: 送出が選択ダイアログを開いたら Enter を再送しない（誤 Continue 防止）", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness({ openDialogOnEnter: true });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    await manager.sendTextSubmit("s-a", "/remote-control");
    // ダイアログのカーソル行（❯ Continue）を未送信テキスト扱いして CR を再送しない。
    expect(submitSends(runner)).toEqual([
      ["pane", "send-text", "w4:p2", "/remote-control"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
  });

  test("selectionDialogVisible: 本文が「Enter to select」を引用しても偽陽性にしない（行頭照合）", () => {
    // 実フッター（行頭）は検出する。
    expect(screenHasSelectionFooter("   ❯ Continue\n   Enter to select · Esc to continue")).toBe(true);
    // チャット本文の引用（文中・箇条書き・かぎ括弧）は検出しない。
    expect(screenHasSelectionFooter("  - ダイアログ表示中（\"Enter to select\"）は再送しない")).toBe(false);
    expect(screenHasSelectionFooter("フッターに「Enter to select」が出ます")).toBe(false);
  });

  test("sendTextSubmit: 注入前にダイアログが開いていたら Esc で閉じてから本文を流す", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness({ dialogInitiallyOpen: true });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    await manager.sendTextSubmit("s-a", "こんにちは");
    expect(submitSends(runner)).toEqual([
      ["pane", "send-keys", "w4:p2", "Escape"],
      ["pane", "send-text", "w4:p2", "こんにちは"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
  });

  test("sendTextSubmit: シェルモード（先頭 `!`）は 1 回の注入で成立し重ね打ちしない", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner, state } = makeSubmitHarness();
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    // 先頭 `!` はモード記号に吸われ入力欄には `! ls -la` と描画される。旧実装は `❯` 行が
    // 消えるため反映検証が必ず失敗し、3 回重ね打ちしてから throw していた（実障害 2026-08-03）。
    await manager.sendTextSubmit("s-a", "!ls -la");
    expect(submitSends(runner)).toEqual([
      ["pane", "send-text", "w4:p2", "!ls -la"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
    expect(state.input).toBe("");
    expect(state.shellMode).toBe(false);
  });

  test("sendTextSubmit: シェルモードのまま残った入力欄は Backspace で通常入力へ戻してから注入する", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner, state } = makeSubmitHarness({ initiallyShellMode: true });
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });
    // 戻さずに注入すると通常メッセージがそのままシェルコマンドとして実行される。
    await manager.sendTextSubmit("s-a", "こんにちは");
    expect(submitSends(runner)).toEqual([
      ["pane", "send-keys", "w4:p2", "Backspace"],
      ["pane", "send-text", "w4:p2", "こんにちは"],
      ["pane", "send-text", "w4:p2", "\r"],
    ]);
    expect(state.shellMode).toBe(false);
  });

  test("sendTextSubmit: 入力欄判定は viewport 全体を読む（--lines で切らない）", async () => {
    // `--source visible` は viewport 全行を返す（--lines は無視される）。末尾 N 行へ
    // 切ると大きな端末で上罫線が窓外に出て入力欄を見失う（63 行端末で 26 行 /
    // 120 行端末で 55 行まで入力欄が伸びる実測）。
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness();
    const manager = new HerdrSessionManager({
      runner: runner.runner, store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });

    await manager.sendTextSubmit("s-a", "こんにちは");

    const reads = runner.recorded.filter((args) => args[0] === "pane" && args[1] === "read");
    expect(reads.length).toBeGreaterThan(0);
    for (const args of reads) {
      expect(args).toContain("--source");
      expect(args).toContain("visible");
      expect(args).not.toContain("--lines");
    }
  });

  test("sendTextSubmit: Backspace 送出が失敗してもシェルモード離脱は諦めて本文注入へ進む", async () => {
    // 補助操作のエラーを表に出すと「送信できない」原因が Backspace 失敗に見えてしまう。
    // 実エラーは続く send-text の失敗として顕在化させる（fail-open）。
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const { runner } = makeSubmitHarness({ initiallyShellMode: true });
    const manager = new HerdrSessionManager({
      // Backspace だけ失敗させ、他はハーネスへ委譲する。
      runner: async (args) => {
        if (args[1] === "send-keys" && args[3] === "Backspace") {
          return { exitCode: 1, stdout: "", stderr: "pane not found" };
        }
        return runner.runner(args);
      },
      store,
      submitDelayMs: 0, submitVerifyDelayMs: 0, inputRetryDelayMs: 0,
      readyTimeoutMs: 5000, readyPollMs: 0,
    });

    // throw せず本文注入まで進む（シェルモードのままなので TUI 側の実行結果は claude 任せ）。
    await expect(manager.sendTextSubmit("s-a", "こんにちは")).resolves.toBeUndefined();
    expect(runner.recorded.some((args) => args[1] === "send-text" && args[3] === "こんにちは")).toBe(true);
  });

  test("extractClaudeInputBox: 罫線に挟まれた領域だけを入力欄として読み、モード記号を分離する", () => {
    const rule = "─".repeat(40);
    const normal = [`❯ 過去のエコー`, rule, "❯ 未送信の本文", rule, "  ⏸ manual mode on"].join("\n");
    expect(extractClaudeInputBox(normal)).toEqual({ prompt: "❯", text: "未送信の本文" });
    // シェルモード: プロンプトが `!` になり、記号は本文に残らない。
    const shell = [`⏺ ok`, rule, "! ls -la", rule, "  ! for shell mode"].join("\n");
    expect(extractClaudeInputBox(shell)).toEqual({ prompt: "!", text: "ls -la" });
    // 名前付き会話は上罫線中央にタイトルが埋まる（全文字一致では外れる）。
    const titled = ["───── 会話タイトル ──", "❯ 本文", rule, "  ⏸ manual"].join("\n");
    expect(extractClaudeInputBox(titled)).toEqual({ prompt: "❯", text: "本文" });
    // 罫線が無い画面は最後の `❯` 行 1 行だけ（フッターを未送信本文と誤認しない）。
    expect(extractClaudeInputBox("❯ のこり\n  ⏸ manual mode on")).toEqual({
      prompt: "❯", text: "のこり",
    });
    expect(extractClaudeInputBox("何も無い画面")).toBeNull();
  });

  test("typedTextProbe: シェルモードの先頭 `!` は照合キーから落とす", () => {
    expect(typedTextProbe("!ls -la")).toBe("ls -la");
    expect(typedTextProbe("こんにちは")).toBe("こんにちは");
    expect(typedTextProbe("!")).toBeNull();
  });

  test("capturePane: joinWrappedLines は recent-unwrapped、空なら visible 末尾へフォールバック", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const visibleBody = ["l1", "l2", "l3", "l4", "", ""].join("\n");
    const runner = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      if (args.includes("recent-unwrapped")) return herdrOk("");
      if (args.includes("visible")) return herdrOk(visibleBody);
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    // recent が空 → visible の末尾 N 行（末尾空行は削る）。
    expect(await manager.capturePane("s-a", { lines: 2, joinWrappedLines: true })).toBe("l3\nl4");
    // 非 join は最初から visible。
    expect(await manager.capturePane("s-a", { lines: 3 })).toBe("l2\nl3\nl4");
    // recent に中身があればそのまま採用。
    const runner2 = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      if (args.includes("recent-unwrapped")) return herdrOk("recent-tail\n");
      return herdrOk(visibleBody);
    });
    const manager2 = new HerdrSessionManager({ runner: runner2.runner, store });
    expect(await manager2.capturePane("s-a", { lines: 2, joinWrappedLines: true })).toBe("recent-tail");
  });

  test("agentProcessAlive: claude は生存、シェルは死亡、herdr 失敗は安全側 true", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const make = (result: HerdrCommandResult): HerdrSessionManager =>
      new HerdrSessionManager({
        runner: new MockHerdrRunner((args) =>
          args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : result,
        ).runner,
        store,
      });
    expect(await make(herdrOk(processInfoJson("claude"))).agentProcessAlive("s-a")).toBe(true);
    expect(await make(herdrOk(processInfoJson("zsh"))).agentProcessAlive("s-a")).toBe(false);
    expect(await make({ exitCode: 1, stdout: "", stderr: "x" }).agentProcessAlive("s-a")).toBe(true);
  });

  test("reattach: pane 不在は session_not_found、シェル化 pane は掃除して再起動導線へ", async () => {
    const store = makeStore();
    store.put({ name: "s-gone", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p9" });
    store.put({ name: "s-stale", cwd: "/b", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2", label: "s-stale" }]));
      if (args[1] === "process-info") return herdrOk(processInfoJson("zsh"));
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });

    const gone = await manager.reattach("s-gone");
    expect(gone.kind).toBe("notFound");

    const stale = await manager.reattach("s-stale");
    expect(stale.kind).toBe("notFound");
    expect(runner.recorded).toContainEqual(["pane", "close", "w4:p2"]);
  });

  test("reattach: 生存 claude は attached で末尾出力を返す", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/work", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) => {
      if (args[1] === "list") return herdrOk(paneListJson([{ pane_id: "w4:p2" }]));
      if (args[1] === "process-info") return herdrOk(processInfoJson("claude"));
      if (args[1] === "read") return herdrOk("recent output\n");
      return herdrOk("");
    });
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    const result = await manager.reattach("s-a");
    expect(result).toEqual({
      kind: "attached",
      info: { name: "s-a", cwd: "/work", alive: true, backend: "herdr" },
      recentOutput: "recent output",
    });
  });

  test("stopServerIfEmpty: pane ゼロなら server stop、pane ありや server 不通は何もしない", async () => {
    const cases: { panes: { pane_id: string }[] | null; expectStop: boolean }[] = [
      { panes: [], expectStop: true },
      { panes: [{ pane_id: "w1:p1" }], expectStop: false },
      { panes: null, expectStop: false }, // server 不通(list 非0)
    ];
    for (const c of cases) {
      const runner = new MockHerdrRunner((args) => {
        if (args[1] === "list") {
          return c.panes === null
            ? { exitCode: 1, stdout: "", stderr: "connect error" }
            : herdrOk(paneListJson(c.panes));
        }
        return herdrOk("");
      });
      const manager = new HerdrSessionManager({ runner: runner.runner, store: makeStore() });
      await manager.stopServerIfEmpty();
      const stops = runner.recorded.filter((args) => args[0] === "server" && args[1] === "stop");
      expect(stops.length, JSON.stringify(c)).toBe(c.expectStop ? 1 : 0);
    }
  });

  test("kill: 記録済み pane を閉じる。pane 不在は HerdrFailedError", async () => {
    const store = makeStore();
    store.put({ name: "s-a", cwd: "/a", createdAt: 1, backend: "herdr", herdrPaneId: "w4:p2" });
    const runner = new MockHerdrRunner((args) =>
      args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : herdrOk(""),
    );
    const manager = new HerdrSessionManager({ runner: runner.runner, store });
    await manager.kill("s-a");
    expect(runner.recorded).toContainEqual(["pane", "close", "w4:p2"]);

    const emptyRunner = new MockHerdrRunner(() => herdrOk(paneListJson([])));
    const manager2 = new HerdrSessionManager({ runner: emptyRunner.runner, store });
    await expect(manager2.kill("s-a")).rejects.toBeInstanceOf(HerdrFailedError);
  });
});

describe("CompositeSessionBackend", () => {
  test("メタの backend 欄で tmux / herdr へルーティングし、list は和になる", async () => {
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1, tmuxPaneId: "%1" });
    store.put({ name: "s-h", cwd: "/h", createdAt: 2, backend: "herdr", herdrPaneId: "w4:p2" });
    const tmuxRunner: string[][] = [];
    const tmux = new TmuxSessionManager({
      runner: async (args) => {
        tmuxRunner.push(args);
        return args[0] === "ls" ? ok("s-t\n") : ok("");
      },
      store,
    });
    const herdrRunner = new MockHerdrRunner((args) =>
      args[1] === "list" ? herdrOk(paneListJson([{ pane_id: "w4:p2" }])) : herdrOk(""),
    );
    const herdr = new HerdrSessionManager({ runner: herdrRunner.runner, store });
    const composite = new CompositeSessionBackend({ tmux, herdr, store });

    const infos = await composite.list();
    expect(infos.map((info) => [info.name, info.alive])).toEqual([
      ["s-h", true],
      ["s-t", true],
    ]);

    // send は各 backend へルーティング（tmux 側は send-keys、herdr 側は pane send-text）。
    await composite.sendKeys("s-t", ["Enter"]);
    expect(tmuxRunner.some((args) => args[0] === "send-keys")).toBe(true);
    await composite.sendKeys("s-h", ["x"], true);
    expect(herdrRunner.recorded).toContainEqual(["pane", "send-text", "w4:p2", "x"]);
  });

  test("makeSessionBackend は常に Composite（設定に依らず per-session ルーティング）", () => {
    const store = makeStore();
    expect(makeSessionBackend({ store })).toBeInstanceOf(CompositeSessionBackend);
  });

  test("herdr list はメタ皆無なら CLI を呼ばず空を返す（純 tmux 環境の副作用ゼロ）", async () => {
    const store = makeStore();
    const calls: string[][] = [];
    const manager = new HerdrSessionManager({
      store,
      runner: (args) => {
        calls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    });
    expect(await manager.list()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("makeBackendForSession はメタの backend 欄で実装を選ぶ", () => {
    const store = makeStore();
    store.put({ name: "s-h", cwd: "/h", createdAt: 1, backend: "herdr" });
    store.put({ name: "s-t", cwd: "/t", createdAt: 2 });
    expect(makeBackendForSession("s-h", store)).toBeInstanceOf(HerdrSessionManager);
    expect(makeBackendForSession("s-t", store)).toBeInstanceOf(TmuxSessionManager);
    expect(makeBackendForSession("s-none", store)).toBeInstanceOf(TmuxSessionManager);
  });
});

describe("TmuxSessionManager と herdr メタの分離", () => {
  test("tmux list は backend=herdr のメタを列挙しない", async () => {
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1 });
    store.put({ name: "s-h", cwd: "/h", createdAt: 2, backend: "herdr" });
    const manager = new TmuxSessionManager({
      runner: async (args) => (args[0] === "ls" ? ok("") : ok("")),
      store,
    });
    expect((await manager.list()).map((info) => info.name)).toEqual(["s-t"]);
  });

  /** tmux backend の sendTextSubmit 検証用ハーネス（capture-pane が現在の入力欄を返す）。 */
  function makeTmuxSubmitHarness(options: { shellMode?: boolean; input?: string } = {}) {
    const state = { shellMode: options.shellMode ?? false, input: options.input ?? "" };
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") {
        const rule = "─".repeat(40);
        const sigil = state.shellMode ? "!" : "❯";
        const footer = state.shellMode ? "  ! for shell mode" : "  ⏸ manual mode on";
        return ok([rule, `${sigil} ${state.input}`, rule, footer].join("\n"));
      }
      if (args[0] === "send-keys" && args.includes("BSpace")) {
        if (state.input.length > 0) state.input = state.input.slice(0, -1);
        else state.shellMode = false;
        return ok("");
      }
      if (args[0] === "send-keys" && args.includes("Enter")) {
        state.input = "";
        state.shellMode = false;
        return ok("");
      }
      return ok("");
    });
    return { runner, state };
  }

  test("tmux sendTextSubmit: シェルモード残留は BSpace で通常入力へ戻してから注入する", async () => {
    // 戻さずに注入すると通常メッセージがそのままシェルコマンドとして実行される
    // （herdr 側 exitShellMode と同じ防御。tmux は既定 backend なので同様に必要）。
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1 });
    const { runner, state } = makeTmuxSubmitHarness({ shellMode: true });
    const manager = new TmuxSessionManager({ runner: runner.runner, store });

    await manager.sendTextSubmit("s-t", "こんにちは");

    expect(state.shellMode).toBe(false);
    expect(runner.recorded.filter((args) => args[0] === "send-keys")).toEqual([
      ["send-keys", "-t", "s-t", "BSpace"],
      ["send-keys", "-t", "s-t", "-l", "こんにちは"],
      ["send-keys", "-t", "s-t", "Enter"],
    ]);
  });

  test("tmux sendTextSubmit: 通常モードでは余計な BSpace を送らない", async () => {
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1 });
    const { runner } = makeTmuxSubmitHarness();
    const manager = new TmuxSessionManager({ runner: runner.runner, store });

    await manager.sendTextSubmit("s-t", "こんにちは");

    expect(runner.recorded.filter((args) => args[0] === "send-keys")).toEqual([
      ["send-keys", "-t", "s-t", "-l", "こんにちは"],
      ["send-keys", "-t", "s-t", "Enter"],
    ]);
  });

  test("tmux sendTextSubmit: BSpace 送出が失敗しても本文注入は続行する（fail-open）", () => {
    // 補助操作のエラーを表に出すと「送信できない」原因が BSpace 失敗に見えてしまう。
    // 実エラーは続く本文注入の send-keys 失敗として顕在化させる。
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1 });
    const rule = "─".repeat(40);
    const runner = new MockTmuxRunner((args) => {
      if (args[0] === "capture-pane") {
        return ok([rule, "! ", rule, "  ! for shell mode"].join("\n"));
      }
      if (args.includes("BSpace")) return { exitCode: 1, stdout: "", stderr: "pane not found" };
      return ok("");
    });
    const manager = new TmuxSessionManager({ runner: runner.runner, store });

    return expect(manager.sendTextSubmit("s-t", "こんにちは")).resolves.toBeUndefined();
  });

  test("extractClaudeInputBox: 大きな端末の巨大な入力欄でも全行を読み取る", () => {
    // 実測 2.1.220: 入力欄の最大高さは端末サイズにほぼ比例する（63 行端末で 26 行 /
    // 120 行端末で 55 行）。固定行数の窓で切ると大きな端末で上罫線が窓外に出て入力欄を
    // 見失い、本文を重ね打ちして送信失敗する。判定は viewport 全体に対して行う。
    const rule = "─".repeat(40);
    const body = Array.from({ length: 55 }, (_, i) =>
      i === 0 ? "❯ line01" : `line${String(i + 1).padStart(2, "0")}`);
    const footer = ["  ⏵⏵ auto mode on", "  ⧉ artifact", "  ⏺ main", "  ◯ agent-a"];
    const screen = ["過去の応答本文", rule, ...body, rule, ...footer].join("\n");

    const box = extractClaudeInputBox(screen);
    expect(box).not.toBeNull();
    expect(box?.text.split("\n").length).toBe(55);
    // 窓で切ると上罫線も `❯` 行も外れて入力欄を特定できない（固定行数が誤りである根拠）。
    expect(extractClaudeInputBox(screen.split("\n").slice(-50).join("\n"))).toBeNull();
  });

  test("入力欄判定は viewport 全体を capture する（末尾 N 行で切らない）", async () => {
    // tmux は `-S` を付けない = viewport のみ。付けるとスクロールバックを引くうえ、
    // 固定行数の窓は大きな端末で入力欄を取りこぼす。
    const store = makeStore();
    store.put({ name: "s-t", cwd: "/t", createdAt: 1 });
    const { runner } = makeTmuxSubmitHarness();
    const manager = new TmuxSessionManager({ runner: runner.runner, store });

    await manager.sendTextSubmit("s-t", "こんにちは");

    const captures = runner.recorded.filter((args) => args[0] === "capture-pane");
    expect(captures.length).toBeGreaterThan(0);
    for (const args of captures) {
      expect(args).toEqual(["capture-pane", "-p", "-t", "s-t"]);
      expect(args).not.toContain("-S");
    }
  });

  test("extractClaudeInputBox: 空入力時のプレースホルダは未送信テキストと数えない", () => {
    // 数えるとシェルモード離脱（空入力の Backspace）に入れず、次の通常メッセージが
    // シェルコマンドとして実行される（実機フレーム 2026-08-03 で確認）。
    const rule = "─".repeat(40);
    const queued = [rule, "! Press up to edit queued messages", rule, "  ! for shell mode"].join("\n");
    expect(extractClaudeInputBox(queued)).toEqual({ prompt: "!", text: "" });
    const fresh = [rule, '❯ Try "how does src/foo.ts work?"', rule, "  ⏸ manual"].join("\n");
    expect(extractClaudeInputBox(fresh)?.text).toBe("");
  });
});

describe("launchCore herdr backend", () => {
  /**
   * herdr 呼び出しを記録するモック ProcessRunner。
   * 実装は全コマンドに `--session tailii` を前置する。ここで前置を検証しつつ剥がし、
   * `recorded` にはコア引数（pane/agent/...）だけを積んで各テストの検証を単純に保つ。
   */
  function herdrProcessRunner(overrides?: {
    panes?: { pane_id: string; label?: string }[];
    processName?: string;
  }): { runner: ProcessRunner; recorded: { exe: string; args: string[] }[] } {
    const recorded: { exe: string; args: string[] }[] = [];
    const runner: ProcessRunner = async (exe, rawArgs) => {
      if (rawArgs[0] !== "--session" || rawArgs[1] !== "tailii") {
        return { exitCode: 9, stdout: "" }; // --session tailii 前置漏れを失敗として顕在化
      }
      const args = rawArgs.slice(2);
      recorded.push({ exe, args });
      if (args[0] === "pane" && args[1] === "list") {
        return { exitCode: 0, stdout: paneListJson(overrides?.panes ?? []) };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return { exitCode: 0, stdout: processInfoJson(overrides?.processName ?? "claude") };
      }
      if (args[0] === "tab" && args[1] === "create") {
        return { exitCode: 0, stdout: tabCreatedJson("w9:p7") };
      }
      return { exitCode: 0, stdout: "" };
    };
    return { runner, recorded };
  }

  /** herdr `tab create` の JSON stdout を組み立てる（0.7.5 実測形の要約）。 */
  function tabCreatedJson(paneId: string): string {
    return JSON.stringify({
      result: {
        type: "tab_created",
        root_pane: { pane_id: paneId, tab_id: "w9:t9" },
        tab: { tab_id: "w9:t9", label: "8", pane_count: 1 },
      },
    });
  }

  function launchOptions(dir: string, store: SessionMetadataStore, runner: ProcessRunner) {
    return {
      dir,
      session: "s-h",
      baseDir: null,
      binaryPath: "/usr/local/bin/tailii",
      tmuxPath: "/opt/homebrew/bin/tmux",
      herdrPath: "/Users/x/.local/bin/herdr",
      backend: "herdr" as const,
      innerCommand: "sleep 300",
      path: "/usr/bin:/bin",
      store,
      now: () => 42,
      errorSink: () => {},
      runner,
      ensurePollMs: 0,
      claudeJsonPath: path.join(makeTempDir("herdr-launch-claudejson"), ".claude.json"),
      hookGlobalMarkerPath: path.join(dir, "no-such-marker"),
    };
  }

  test("tab create → rename → pane run で起動し backend/herdrPaneId をメタへ権威記録する", async () => {
    const dir = makeTempDir("herdr-launch");
    const store = makeStore();
    const { runner, recorded } = herdrProcessRunner();

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);

    // tmux は一切呼ばない（すべて herdrPath 宛て）。
    expect(recorded.every((call) => call.exe === "/Users/x/.local/bin/herdr")).toBe(true);
    // tab create が cwd/PATH を運ぶ（0.7.5: agent start の pane 生成/cwd/env 指定は廃止）。
    const create = recorded.find((call) => call.args[0] === "tab" && call.args[1] === "create");
    expect(create?.args.slice(2)).toEqual([
      "--cwd", dir, "--env", "PATH=/usr/bin:/bin", "--no-focus",
    ]);
    // pane label = session 名（セッション解決の権威）。
    expect(recorded).toContainEqual(expect.objectContaining({
      args: ["pane", "rename", "w9:p7", "s-h"],
    }));
    // inner は単一文字列 + exec 前置（pane run はタイプ注入でクォート非保持のため。
    // --settings 合成込みで shell single-quote 包み）。
    const run = recorded.find((call) => call.args[0] === "pane" && call.args[1] === "run");
    expect(run?.args[2]).toBe("w9:p7");
    expect(run?.args[3]).toMatch(/^exec \/bin\/zsh -lc 'sleep 300 --settings /);
    expect(run?.args).toHaveLength(4);

    expect(store.get("s-h")).toEqual({
      name: "s-h",
      cwd: dir,
      createdAt: 42,
      backend: "herdr",
      herdrPaneId: "w9:p7",
    });
  });

  test("displayTitle 指定でもタブへラベルは付けない（タブ名同期撤去）", async () => {
    const dir = makeTempDir("herdr-launch-title");
    const store = makeStore();
    const { runner, recorded } = herdrProcessRunner();

    expect(
      await launchCore({ ...launchOptions(dir, store, runner), displayTitle: "認証バグの調査" }),
    ).toBe(0);
    expect(recorded.some((call) => call.args.includes("--label"))).toBe(false);
    // pane label（=セッション解決の権威）は session 名のまま。
    expect(recorded).toContainEqual(expect.objectContaining({
      args: ["pane", "rename", "w9:p7", "s-h"],
    }));
  });

  test("生存 pane があれば再起動せずメタだけ更新する", async () => {
    const dir = makeTempDir("herdr-launch-live");
    const store = makeStore();
    store.put({ name: "s-h", cwd: dir, createdAt: 1, backend: "herdr", herdrPaneId: "w9:p7" });
    const { runner, recorded } = herdrProcessRunner({
      panes: [{ pane_id: "w9:p7", label: "s-h" }],
      processName: "claude",
    });

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);
    expect(recorded.some((call) => call.args[0] === "tab" && call.args[1] === "create")).toBe(false);
    expect(store.get("s-h")?.herdrPaneId).toBe("w9:p7");
  });

  test("claude が終了しシェル化した pane は閉じて作り直す", async () => {
    const dir = makeTempDir("herdr-launch-stale");
    const store = makeStore();
    store.put({ name: "s-h", cwd: dir, createdAt: 1, backend: "herdr", herdrPaneId: "w9:p1" });
    const { runner, recorded } = herdrProcessRunner({
      panes: [{ pane_id: "w9:p1", label: "s-h" }],
      processName: "zsh",
    });

    expect(await launchCore(launchOptions(dir, store, runner))).toBe(0);
    expect(recorded).toContainEqual(
      expect.objectContaining({ args: ["pane", "close", "w9:p1"] }),
    );
    expect(recorded.some((call) => call.args[0] === "tab" && call.args[1] === "create")).toBe(true);
    expect(store.get("s-h")?.herdrPaneId).toBe("w9:p7");
  });

  test("tailii セッションサーバー不在なら detached 起動して待つ", async () => {
    const dir = makeTempDir("herdr-launch-ensure");
    const store = makeStore();
    const spawned: { exe: string; args: string[] }[] = [];
    let serverUp = false;
    const runner: ProcessRunner = async (_exe, rawArgs) => {
      const args = rawArgs[0] === "--session" ? rawArgs.slice(2) : rawArgs;
      if (args[0] === "pane" && args[1] === "list") {
        return serverUp
          ? { exitCode: 0, stdout: paneListJson([]) }
          : { exitCode: 1, stdout: "" };
      }
      if (args[0] === "tab" && args[1] === "create") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } }),
        };
      }
      return { exitCode: 0, stdout: "" };
    };

    const options = {
      ...launchOptions(dir, store, runner),
      spawnDetached: (exe: string, args: string[]) => {
        spawned.push({ exe, args });
        serverUp = true;
      },
    };
    expect(await launchCore(options)).toBe(0);
    expect(spawned).toEqual([
      { exe: "/Users/x/.local/bin/herdr", args: ["--session", "tailii", "server"] },
    ]);
    expect(store.get("s-h")?.herdrPaneId).toBe("w1:p1");
  });

  test("tab create 失敗は非0で返しメタを書かない", async () => {
    const dir = makeTempDir("herdr-launch-fail");
    const store = makeStore();
    const runner: ProcessRunner = async (_exe, rawArgs) => {
      const args = rawArgs[0] === "--session" ? rawArgs.slice(2) : rawArgs;
      if (args[0] === "pane" && args[1] === "list") return { exitCode: 0, stdout: paneListJson([]) };
      if (args[0] === "tab" && args[1] === "create") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "{}" };
    };
    expect(await launchCore(launchOptions(dir, store, runner))).toBe(1);
    expect(store.get("s-h")).toBeNull();
  });

  test("pane run 失敗は作った pane を閉じ、非0で返しメタを書かない", async () => {
    const dir = makeTempDir("herdr-launch-run-fail");
    const store = makeStore();
    const recorded: string[][] = [];
    const runner: ProcessRunner = async (_exe, rawArgs) => {
      const args = rawArgs[0] === "--session" ? rawArgs.slice(2) : rawArgs;
      recorded.push(args);
      if (args[0] === "pane" && args[1] === "list") return { exitCode: 0, stdout: paneListJson([]) };
      if (args[0] === "tab" && args[1] === "create") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: { root_pane: { pane_id: "w9:p7" } } }),
        };
      }
      if (args[0] === "pane" && args[1] === "run") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "{}" };
    };
    expect(await launchCore(launchOptions(dir, store, runner))).toBe(1);
    expect(recorded).toContainEqual(["pane", "close", "w9:p7"]);
    expect(store.get("s-h")).toBeNull();
  });
});
