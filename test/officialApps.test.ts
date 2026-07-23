import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  OfficialAppsService,
  extractActiveClaudeUrl,
  parseCodexPairing,
  parseCodexStart,
  validClaudeUrl,
  type OfficialCommandRunner,
} from "../src/officialApps.js";
import type { SessionBackend } from "../src/sessionBackend.js";
import { SessionMetadataStore } from "../src/sessionMetadataStore.js";

class FakeBackend implements SessionBackend {
  readonly store: SessionMetadataStore;
  pane = "";
  readonly submitted: string[] = [];

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

  async sendKeys() {}

  async sendTextSubmit(_name: string, text: string) {
    this.submitted.push(text);
    this.pane =
      "Remote Control is active\nhttps://claude.ai/code/session_123\n";
  }

  async capturePane() {
    return this.pane;
  }

  async agentProcessAlive() {
    return true;
  }
}

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
  test("active marker より後の完全一致 URL だけを採用する", () => {
    expect(
      extractActiveClaudeUrl(
        "https://claude.ai/code/old\nRemote Control is active\nhttps://claude.ai/code/new_1",
      ),
    ).toBe("https://claude.ai/code/new_1");
    expect(
      extractActiveClaudeUrl(
        "Remote Control is active\nhttps://claude.ai/code/new\nRemote Control disconnected",
      ),
    ).toBeNull();
  });

  test("Claude 2.1.218 の現行成功表示から URL を採用する", () => {
    expect(
      extractActiveClaudeUrl(
        [
          "/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_current",
          "❯",
          "auto mode on · /rc active",
        ].join("\n"),
      ),
    ).toBe("https://claude.ai/code/session_current");
  });

  test("停止後の古い URL を後続の active 表示だけで再利用しない", () => {
    expect(
      extractActiveClaudeUrl(
        [
          "Remote Control is active",
          "https://claude.ai/code/session_old",
          "Remote Control disconnected",
          "/rc active",
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
