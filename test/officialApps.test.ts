import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  OfficialAppsService,
  extractBannerClaudeUrl,
  extractClaudeRemoteDialogUrl,
  isSupportedCliVersion,
  lastTranscriptRemoteControlEntry,
  parseCodexPairing,
  parseCodexStart,
  statusBarShowsRemoteControl,
  validClaudeUrl,
  type OfficialCommandRunner,
} from "../src/services/officialApps.js";
import type { SessionBackend } from "../src/backend/sessionBackend.js";
import { SessionMetadataStore } from "../src/sessions/sessionMetadataStore.js";

class FakeBackend implements SessionBackend {
  readonly store: SessionMetadataStore;
  pane = "";
  paneAfterSubmit =
    "Remote Control is active\nhttps://claude.ai/code/session_123\n";
  readonly submitted: string[] = [];
  readonly sentKeys: string[][] = [];

  constructor(base: string) {
    this.store = new SessionMetadataStore(join(base, "sessions"));
  }

  async list() {
    return [{ name: "s", cwd: "/tmp", alive: true }];
  }

  async reattach() {
    return { kind: "missing" as const };
  }

  async kill() {}

  /** sendKeys（Enter を含む選択操作）後に pane を遷移させる場合に設定する。 */
  paneAfterEnterKeys: string | null = null;

  async sendKeys(_name: string, keys: string[]) {
    this.sentKeys.push(keys);
    if (keys.includes("Enter") && this.paneAfterEnterKeys !== null) {
      this.pane = this.paneAfterEnterKeys;
    }
  }

  /** RC 切断直後 limbo の黙殺挙動を再現: 先頭 N 回の注入は pane に反映しない。 */
  swallowSubmits = 0;

  async sendTextSubmit(_name: string, text: string) {
    this.submitted.push(text);
    if (this.swallowSubmits > 0) {
      this.swallowSubmits -= 1;
      return;
    }
    this.pane = this.paneAfterSubmit;
  }

  async capturePane() {
    return this.pane;
  }

  async agentProcessAlive() {
    return true;
  }
}

// claude 2.1.220 実機採取: ステータスバー（active 時は右端に /rc が点灯）。
const RC_ON_BAR =
  "  ⏸ manual mode on · ? for shortcuts · ← for agents                                    /rc";
// アイドル時のバー（実採取）。処理中は `· esc to interrupt` が加わる（処理中ガードの判定材料）。
const RC_OFF_BAR = "  ⏵⏵ auto mode on (shift+tab to cycle)";

// チャット本文に activation 文言が引用されている pane（デバッグ表示・貼り付け等）。
// 実際に本障害を起こした自己汚染パターン。
const QUOTED_ACTIVATION_LINES = [
  "  139 2026-07-27T02:14:24.610Z bridge_status | /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_stale",
  "  ❯ /remote-control",
];

function writeTranscript(base: string, entries: { tsIso: string; url: string }[]): string {
  const transcriptPath = join(base, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    entries
      .map((entry) =>
        JSON.stringify({
          type: "system",
          subtype: "bridge_status",
          timestamp: entry.tsIso,
          content: `/remote-control is active · Continue here, on your phone, or at ${entry.url}`,
        }),
      )
      .join("\n") + "\n",
  );
  return transcriptPath;
}

// claude 2.1.220 実機採取: active 中の /remote-control 再実行が開く modal dialog。
const CLAUDE_REMOTE_DIALOG = [
  "❯ /remote-control",
  "   Remote Control",
  "   This session is available in the Claude mobile app and at https://claude.ai/code/session_01Ufxtxn.",
  "     Disconnect this session",
  "     Show QR code  Scan with your phone to open this session",
  "   ❯ Continue",
  "   Enter to select · Esc to continue",
].join("\n");

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const value = mkdtempSync(join(tmpdir(), "tailii-official-apps-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function commandRunner(
  outputs: Record<string, { success: boolean; stdout: string; stderr?: string }>,
): OfficialCommandRunner {
  return vi.fn(async (executable, args) => {
    const key = `${executable} ${args.join(" ")}`;
    const value = outputs[key];
    return value === undefined ? null : { ...value, stderr: value.stderr ?? "" };
  });
}

function claudeAuth(): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "person@example.com",
    orgId: "org_1",
    orgName: "Example",
    subscriptionType: "max",
  });
}

function codexStart(): string {
  return JSON.stringify({
    mode: "daemon",
    status: "connected",
    serverName: "Codex",
    environmentId: null,
    timedOut: false,
    daemon: {
      status: "alreadyRunning",
      backend: "local",
      pid: 123,
      managedCodexPath: "/tmp/codex",
      managedCodexVersion: "0.145.0",
      socketPath: "/tmp/codex.sock",
      cliVersion: "0.145.0",
      appServerVersion: "0.145.0",
    },
  });
}

describe("Claude 公式アプリ URL", () => {
  test("banner は行頭一致のみ: 同一行 URL と直後行 URL を採用し、本文中の引用は拒否する", () => {
    // 2.1.220 実機形式（同一行）。
    expect(
      extractBannerClaudeUrl(
        [
          "  /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_current",
          "❯",
        ].join("\n"),
      ),
    ).toBe("https://claude.ai/code/session_current");
    // 旧形式（直後行）。
    expect(
      extractBannerClaudeUrl(
        ["Remote Control is active", "https://claude.ai/code/session_next"].join("\n"),
      ),
    ).toBe("https://claude.ai/code/session_next");
    // 本文中の引用（行頭が別テキスト）は banner とみなさない。
    expect(extractBannerClaudeUrl(QUOTED_ACTIVATION_LINES.join("\n"))).toBeNull();
  });

  test("transcript の bridge_status は最後の 1 件を採用し末尾ピリオドを除く", () => {
    const base = temporaryDirectory();
    const transcriptPath = writeTranscript(base, [
      { tsIso: "2026-07-26T00:00:00.000Z", url: "https://claude.ai/code/session_old" },
      { tsIso: "2026-07-27T02:14:24.610Z", url: "https://claude.ai/code/session_new" },
    ]);
    expect(lastTranscriptRemoteControlEntry(transcriptPath)).toEqual({
      url: "https://claude.ai/code/session_new",
      atMs: Date.parse("2026-07-27T02:14:24.610Z"),
    });
    expect(lastTranscriptRemoteControlEntry(join(base, "missing.jsonl"))).toBeNull();
    expect(lastTranscriptRemoteControlEntry(null)).toBeNull();
    // bridge_status 以外の行（本文が activation 文言をエスケープ込みで引用するなど）は無視する。
    const noisy = join(base, "noisy.jsonl");
    writeFileSync(
      noisy,
      [
        JSON.stringify({
          type: "user",
          subtype: "tool_result",
          content:
            '{\\"subtype\\":\\"bridge_status\\"} /remote-control is active · at https://claude.ai/code/session_quoted',
        }),
        "not json at all",
      ].join("\n") + "\n",
    );
    expect(lastTranscriptRemoteControlEntry(noisy)).toBeNull();
  });

  test("Remote Control dialog から末尾ピリオドを除いた URL を抽出する", () => {
    expect(extractClaudeRemoteDialogUrl(CLAUDE_REMOTE_DIALOG)).toBe(
      "https://claude.ai/code/session_01Ufxtxn",
    );
    // Disconnect ラベルが無い（dialog が開いていない）テキストからは抽出しない。
    expect(
      extractClaudeRemoteDialogUrl(
        "This session is available in the Claude mobile app and at https://claude.ai/code/session_x.",
      ),
    ).toBeNull();
    expect(extractClaudeRemoteDialogUrl("Disconnect this session")).toBeNull();
    // チャット本文がダイアログ文言を文中で引用しただけでは抽出しない（行頭照合）。
    expect(
      extractClaudeRemoteDialogUrl(
        [
          "ダイアログには「Disconnect this session」と「Enter to select」が出ます。",
          "URL は This session is available in the Claude mobile app and at https://claude.ai/code/session_quoted. の形式です。",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("host・path・query の別名を許さない", () => {
    expect(validClaudeUrl("https://claude.ai/code/abc-_123")).toBe(true);
    expect(validClaudeUrl("https://evil.example/code/abc")).toBe(false);
    expect(validClaudeUrl("https://claude.ai/code/abc?next=evil")).toBe(false);
    expect(validClaudeUrl("https://claude.ai/code/a/b")).toBe(false);
  });
});

describe("OfficialAppsService", () => {
  test("Claude idle 時だけ固定 /remote-control を注入して URL を返す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const runner = commandRunner({
      "claude --version": { success: true, stdout: "2.1.218 (Claude Code)\n" },
      "claude auth status --json": { success: true, stdout: claudeAuth() },
    });
    const service = new OfficialAppsService({
      commandRunner: runner,
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 20,
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );

    expect(backend.submitted).toEqual(["/remote-control"]);
    expect(result).toMatchObject({
      provider: "claude",
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_123",
    });
  });

  test("Claude dialog が既に開いていれば Esc で閉じて URL を返し、注入しない", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = CLAUDE_REMOTE_DIALOG;
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 20,
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );

    expect(backend.submitted).toEqual([]);
    expect(backend.sentKeys).toEqual([["Escape"]]);
    expect(result).toMatchObject({
      provider: "claude",
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_01Ufxtxn",
    });
  });

  test("アーカイブ直後: 注入後に dialog が開いたら Esc で閉じて URL を返す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.paneAfterSubmit = CLAUDE_REMOTE_DIALOG;
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 20,
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );

    expect(backend.submitted).toEqual(["/remote-control"]);
    expect(backend.sentKeys).toEqual([["Escape"]]);
    expect(result).toMatchObject({
      provider: "claude",
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_01Ufxtxn",
    });
  });

  test("statusBarShowsRemoteControl は末尾ステータスバーの /rc だけを活性とみなす", () => {
    expect(statusBarShowsRemoteControl(["conversation text", "❯", RC_ON_BAR].join("\n"))).toBe(
      true,
    );
    expect(statusBarShowsRemoteControl(["conversation text", "❯", RC_OFF_BAR].join("\n"))).toBe(
      false,
    );
    // 本文中の引用（上方の行）では点灯扱いにしない。
    expect(
      statusBarShowsRemoteControl(
        [...QUOTED_ACTIVATION_LINES, "more text", "even more", "❯", RC_OFF_BAR].join("\n"),
      ),
    ).toBe(false);
    // 入力欄の下書き `❯ /rc` は点灯扱いにしない。
    expect(statusBarShowsRemoteControl(["text", "❯ /rc", RC_OFF_BAR].join("\n"))).toBe(false);
  });

  test("本文に activation 引用があっても /rc 消灯なら active と誤検出しない（自己汚染回帰）", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = [...QUOTED_ACTIVATION_LINES, "❯", RC_OFF_BAR].join("\n");
    backend.paneAfterSubmit = [
      "/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_fresh",
      "❯",
      RC_ON_BAR,
    ].join("\n");
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 50,
      claudeReconnectGraceMs: 5,
    });

    const status = await service.status({
      session: "s",
      provider: "claude",
      sessionManager: backend,
      canInjectClaudeCommand: true,
      canMutateCodexDaemon: true,
      claudeTranscriptPath: null,
    });
    // 引用 URL(session_stale) を active として返さず、再起動可能と報告する。
    expect(status).toMatchObject({ state: "inactive", canStart: true });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );
    expect(backend.submitted).toEqual(["/remote-control"]);
    expect(result).toMatchObject({
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_fresh",
    });
  });

  test("/rc 点灯中は transcript の bridge_status URL を権威として返す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = [...QUOTED_ACTIVATION_LINES, "❯", RC_ON_BAR].join("\n");
    const transcriptPath = writeTranscript(base, [
      { tsIso: "2026-07-27T02:14:24.610Z", url: "https://claude.ai/code/session_real" },
    ]);
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
    });
    const context = {
      session: "s",
      provider: "claude" as const,
      sessionManager: backend,
      canInjectClaudeCommand: true,
      canMutateCodexDaemon: true,
      claudeTranscriptPath: transcriptPath,
    };

    const status = await service.status(context);
    expect(status).toMatchObject({
      state: "active",
      canOpen: true,
      launchUrl: "https://claude.ai/code/session_real",
    });

    const result = await service.perform(context, "open", true, false);
    expect(backend.submitted).toEqual([]);
    expect(result).toMatchObject({
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_real",
    });
  });

  test("アーカイブ後の再接続: bridge_status 追記なしでも /rc 点灯を確認して既知 URL を返す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = ["❯ /remote-control", "❯", RC_OFF_BAR].join("\n");
    // 再接続: バナーは窓外・bridge_status 追記なし・/rc だけ点灯する。
    backend.paneAfterSubmit = ["❯ /remote-control", "❯", RC_ON_BAR].join("\n");
    const transcriptPath = writeTranscript(base, [
      { tsIso: "2026-07-27T02:14:24.610Z", url: "https://claude.ai/code/session_known" },
    ]);
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 500,
      claudeReconnectGraceMs: 10,
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: transcriptPath,
      },
      "open",
      true,
      false,
    );
    expect(backend.submitted).toEqual(["/remote-control"]);
    expect(result).toMatchObject({
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_known",
    });
  });

  test("limbo 黙殺: 実行証跡が出ないまま経過したら /remote-control を再注入する", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = ["❯", RC_OFF_BAR].join("\n");
    // 1 回目の注入は黙殺（RC 切断直後の limbo 実測挙動）。2 回目で activation。
    backend.swallowSubmits = 1;
    backend.paneAfterSubmit = [
      "/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_retry",
      "❯",
      RC_ON_BAR,
    ].join("\n");
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 200,
      claudeReconnectGraceMs: 5,
      claudeReinjectAfterMs: 10,
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );

    expect(backend.submitted).toEqual(["/remote-control", "/remote-control"]);
    expect(result).toMatchObject({
      outcome: "open",
      launchUrl: "https://claude.ai/code/session_retry",
    });
  });

  test("limbo 再注入は処理中（esc to interrupt バー）の pane では見送る", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const processingBar =
      "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
    backend.pane = ["❯", processingBar].join("\n");
    backend.paneAfterSubmit = ["❯", processingBar].join("\n");
    // 注入は常に黙殺される想定（並行メッセージで処理中になったケース）。
    backend.swallowSubmits = 99;
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 100,
      claudeReinjectAfterMs: 10,
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );

    // 再注入せず（queued 化による意図しない後実行を防ぐ）、初回注入のみで timeout。
    expect(backend.submitted).toEqual(["/remote-control"]);
    expect(result).toMatchObject({
      outcome: "unavailable",
      unavailableReason: "claude_start_failed",
    });
  });

  test("stop: /rc 消灯なら何もせず stopped を返す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = ["❯", RC_OFF_BAR].join("\n");
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 50,
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "stop",
      true,
      false,
    );
    expect(result).toMatchObject({ provider: "claude", outcome: "stopped" });
    expect(backend.submitted).toEqual([]);
    expect(backend.sentKeys).toEqual([]);
  });

  test("stop: /rc 点灯中は dialog を開いて Disconnect を選択し、消灯を検証する", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = ["❯", RC_ON_BAR].join("\n");
    backend.paneAfterSubmit = CLAUDE_REMOTE_DIALOG;
    backend.paneAfterEnterKeys = ["❯", RC_OFF_BAR].join("\n");
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 100,
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "stop",
      true,
      false,
    );
    expect(result).toMatchObject({ provider: "claude", outcome: "stopped" });
    expect(backend.submitted).toEqual(["/remote-control"]);
    expect(backend.sentKeys).toEqual([["Up", "Up", "Enter"]]);
  });

  test("stop: 切断を検証できなければ Esc で閉じて claude_stop_failed", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    backend.pane = ["❯", RC_ON_BAR].join("\n");
    backend.paneAfterSubmit = CLAUDE_REMOTE_DIALOG;
    // Enter 後も dialog のまま（切断失敗）。
    backend.paneAfterEnterKeys = CLAUDE_REMOTE_DIALOG;
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.220 (Claude Code)\n" },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 30,
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "stop",
      true,
      false,
    );
    expect(result).toMatchObject({
      outcome: "unavailable",
      unavailableReason: "claude_stop_failed",
    });
    expect(backend.sentKeys).toEqual([["Up", "Up", "Enter"], ["Escape"]]);
  });

  test("CLI バージョンは下限のみゲート: 新しい版は許可し、下限未満・形式外は拒否する", () => {
    // 完全一致リストは CLI 自動更新の度に「対応 CLI を確認できない」で止まった（2.1.234 で再発）。
    expect(isSupportedCliVersion("claude", "2.1.215")).toBe(true);
    expect(isSupportedCliVersion("claude", "2.1.234")).toBe(true);
    expect(isSupportedCliVersion("claude", "2.1.999")).toBe(true);
    expect(isSupportedCliVersion("claude", "2.2.0")).toBe(true);
    expect(isSupportedCliVersion("claude", "3.0.0")).toBe(true);
    expect(isSupportedCliVersion("claude", "2.1.214")).toBe(false);
    expect(isSupportedCliVersion("claude", "2.0.999")).toBe(false);
    expect(isSupportedCliVersion("claude", "1.9.9")).toBe(false);
    expect(isSupportedCliVersion("claude", "2.1")).toBe(false);
    expect(isSupportedCliVersion("claude", "latest")).toBe(false);
    expect(isSupportedCliVersion("codex", "0.144.5")).toBe(true);
    expect(isSupportedCliVersion("codex", "0.146.0")).toBe(true);
    expect(isSupportedCliVersion("codex", "0.144.4")).toBe(false);
    expect(isSupportedCliVersion("claude", "2.1.240-beta.1")).toBe(true);
  });

  test("未検証の新しい Claude CLI でも perform は進み、診断ログに unverified を残す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const diagnosticLogPath = join(base, "official-app.log");
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.999 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
      claudePollIntervalMs: 1,
      claudeStartTimeoutMs: 20,
      diagnosticLogPath,
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );
    expect(result).toMatchObject({ provider: "claude", outcome: "open" });
    expect(readFileSync(diagnosticLogPath, "utf8")).toContain(
      "provider version unverified provider=claude version=2.1.999",
    );
  });

  test("下限未満の Claude CLI は official_cli_unavailable で止める", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.200 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );
    expect(result.unavailableReason).toBe("official_cli_unavailable");
    expect(backend.submitted).toEqual([]);
  });

  test("Claude busy 中は pane へ入力しない", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const service = new OfficialAppsService({
      commandRunner: commandRunner({
        "claude --version": { success: true, stdout: "2.1.218 (Claude Code)\n" },
        "claude auth status --json": { success: true, stdout: claudeAuth() },
      }),
      actionLockPath: join(base, "action.lock"),
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "claude",
        sessionManager: backend,
        canInjectClaudeCommand: false,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      false,
    );
    expect(result.unavailableReason).toBe("claude_agent_busy");
    expect(backend.submitted).toEqual([]);
  });

  test("Codex は固定 start/pair のみを実行し、期限付き手入力コードを返す", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const now = 1_900_000_000;
    const runner = commandRunner({
      "codex --version": { success: true, stdout: "codex-cli 0.145.0\n" },
      "codex remote-control start --json": { success: true, stdout: codexStart() },
      "codex remote-control pair --json": {
        success: true,
        stdout: JSON.stringify({
          pairingCode: "opaque-secret",
          manualPairingCode: "ABCD-EFGH",
          environmentId: "env_1",
          expiresAt: now + 300,
        }),
      },
    });
    const service = new OfficialAppsService({
      commandRunner: runner,
      now: () => now,
      actionLockPath: join(base, "action.lock"),
    });
    const result = await service.perform(
      {
        session: "s",
        provider: "codex",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "repair",
      true,
      false,
    );
    expect(result).toEqual({
      provider: "codex",
      outcome: "pair",
      launchUrl: "https://chatgpt.com/codex/pair?pairing_code=opaque-secret",
      manualPairingCode: "ABCD-EFGH",
      expiresAt: now + 300,
    });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  test("Codex は共有 App Server RPC を優先し、daemon CLI と競合しない", async () => {
    const base = temporaryDirectory();
    const backend = new FakeBackend(base);
    const now = 1_900_000_000;
    const runner = commandRunner({
      "codex --version": { success: true, stdout: "codex-cli 0.145.0\n" },
    });
    const calls: string[] = [];
    const service = new OfficialAppsService({
      commandRunner: runner,
      now: () => now,
      actionLockPath: join(base, "action.lock"),
      codexRemoteControl: {
        remoteControlStatus: async () => ({ status: "errored", hasEnvironment: true }),
        enableRemoteControl: async () => {
          calls.push("enable");
          return { status: "errored", hasEnvironment: true };
        },
        disableRemoteControl: async () => {
          calls.push("disable");
          return { status: "disabled", hasEnvironment: true };
        },
        startRemoteControlPairing: async () => {
          calls.push("pair");
          return {
            pairingCode: "opaque/secret+value==",
            manualPairingCode:
              calls.filter((call) => call === "pair").length === 1 ? "ABCD-EFGH" : null,
            expiresAt: now + 600,
          };
        },
      },
    });

    const result = await service.perform(
      {
        session: "s",
        provider: "codex",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "repair",
      true,
      false,
    );

    expect(result).toEqual({
      provider: "codex",
      outcome: "pair",
      launchUrl:
        "https://chatgpt.com/codex/pair?pairing_code=opaque%2Fsecret%2Bvalue%3D%3D",
      manualPairingCode: "ABCD-EFGH",
      expiresAt: now + 600,
    });

    const open = await service.perform(
      {
        session: "s",
        provider: "codex",
        sessionManager: backend,
        canInjectClaudeCommand: true,
        canMutateCodexDaemon: true,
        claudeTranscriptPath: null,
      },
      "open",
      true,
      true,
    );
    expect(open).toEqual({
      provider: "codex",
      outcome: "open",
      launchUrl:
        "https://chatgpt.com/codex/pair?pairing_code=opaque%2Fsecret%2Bvalue%3D%3D",
    });
    expect(calls).toEqual(["enable", "pair", "enable", "pair"]);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("Codex JSON fail closed", () => {
  test("未知フィールドや不正コードを拒否する", () => {
    const start = JSON.parse(codexStart()) as Record<string, unknown>;
    start["unexpected"] = true;
    expect(parseCodexStart(JSON.stringify(start))).toBeNull();
    expect(
      parseCodexPairing(
        JSON.stringify({
          pairingCode: "secret",
          manualPairingCode: "code with spaces",
          environmentId: "env_1",
          expiresAt: 1_900_000_300,
        }),
      ),
    ).toBeNull();
  });
});
