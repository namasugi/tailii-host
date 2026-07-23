// officialApps.ts
// tailii host — Claude / ChatGPT 公式アプリ連携の固定コマンドアダプタ。
//
// クライアントから実行ファイル・argv・URL・任意文字列は受け取らない。provider と
// open/repair/stop の型付き操作だけを受け、現行の検証済み CLI 出力だけを解釈する。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { SessionBackend } from "./sessionBackend.js";

export type OfficialAppProvider = "claude" | "codex";
export type OfficialAppAction = "open" | "repair" | "stop";
export type OfficialAppState = "active" | "inactive" | "unavailable";
export type OfficialAppOutcome = "open" | "pair" | "stopped" | "unavailable";

export interface OfficialAppStatus {
  provider: OfficialAppProvider;
  version?: string;
  state: OfficialAppState;
  canOpen: boolean;
  canStart: boolean;
  launchUrl?: string;
  unavailableReason?: string;
}

export interface OfficialAppActionResult {
  provider: OfficialAppProvider;
  outcome: OfficialAppOutcome;
  launchUrl?: string;
  manualPairingCode?: string;
  expiresAt?: number;
  unavailableReason?: string;
}

export interface OfficialAppRuntimeContext {
  session: string;
  provider: OfficialAppProvider;
  sessionManager: SessionBackend;
  /** Hub の処理中/設問状態をまとめた入力安全性。active URL の open 自体は busy 中も許可する。 */
  canInjectClaudeCommand: boolean;
  /** daemon 再起動で他会話の turn を切らないため、全 Codex turn が idle のときだけ true。 */
  canMutateCodexDaemon: boolean;
}

export interface OfficialCommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

export type OfficialCommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<OfficialCommandOutput | null>;

export interface OfficialAppsOptions {
  claudePath?: string;
  codexPath?: string;
  commandRunner?: OfficialCommandRunner;
  now?: () => number;
  actionLockPath?: string;
  claudePollIntervalMs?: number;
  claudeStartTimeoutMs?: number;
  codexRemoteControl?: CodexRemoteControlClient;
}

export interface CodexRemoteControlClient {
  remoteControlStatus(): Promise<CodexRemoteControlSnapshot | null>;
  enableRemoteControl(): Promise<CodexRemoteControlSnapshot | null>;
  disableRemoteControl(): Promise<CodexRemoteControlSnapshot | null>;
  startRemoteControlPairing(): Promise<CodexRemoteControlPairing | null>;
}

interface CodexRemoteControlSnapshot {
  status: "disabled" | "connecting" | "connected" | "errored";
  hasEnvironment: boolean;
}

interface CodexRemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  expiresAt: number;
}

const CLAUDE_SESSION_PREFIX = "https://claude.ai/code/";
const CHATGPT_CODEX_PAIR_URL = "https://chatgpt.com/codex/pair";
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_PAIRING_CODE_BYTES = 2_048;
const PROVIDER_COMMAND_TIMEOUT_MS = 22_000;
const CLAUDE_AUTH_TIMEOUT_MS = 5_000;
const SUPPORTED_CLAUDE_VERSIONS = new Set(["2.1.215", "2.1.218"]);
const SUPPORTED_CODEX_VERSIONS = new Set(["0.144.5", "0.145.0"]);

const CLAUDE_ACTIVE_MARKERS = [
  "Remote Control is active",
  "/remote-control is active",
  "/rc active",
] as const;
const CLAUDE_INACTIVE_MARKERS = [
  "Remote Control disconnected",
  "Remote Control is inactive",
  "Remote Control stopped",
  "Remote Control session ended",
  "Remote Control connection failed",
  "Remote Control requires a claude.ai subscription",
  "Remote Control requires a full-scope login token",
  "Unable to determine your organization for Remote Control eligibility",
  "Remote Control is not yet enabled for your account",
  "Couldn’t verify Remote Control eligibility",
  "Couldn't verify Remote Control eligibility",
  "Couldn’t verify your organization’s Remote Control policy",
  "Remote Control is only available when using Claude via api.anthropic.com",
  "Remote Control is disabled by your organization",
  "disableRemoteControl",
  "Remote credentials fetch failed",
  "Couldn’t reconnect to your Remote Control session",
  "Your organization requires Trusted Devices for Remote Control, but this device is not enrolled",
  "session expired for trusted-device check",
] as const;

const CLAUDE_FAILURES: readonly [string, string][] = [
  ["Remote Control requires a claude.ai subscription", "claude_subscription_required"],
  ["Remote Control requires a full-scope login token", "claude_full_scope_login_required"],
  [
    "Unable to determine your organization for Remote Control eligibility",
    "claude_auth_refresh_required",
  ],
  ["Remote Control is not yet enabled for your account", "claude_remote_not_enabled"],
  ["Couldn’t verify Remote Control eligibility", "claude_eligibility_check_failed"],
  ["Couldn't verify Remote Control eligibility", "claude_eligibility_check_failed"],
  [
    "Couldn’t verify your organization’s Remote Control policy",
    "claude_eligibility_check_failed",
  ],
  [
    "Remote Control is only available when using Claude via api.anthropic.com",
    "claude_api_endpoint_unsupported",
  ],
  ["Remote Control is disabled by your organization", "claude_remote_disabled_by_policy"],
  ["disableRemoteControl", "claude_remote_disabled_by_policy"],
  ["Remote credentials fetch failed", "claude_credentials_fetch_failed"],
  ["Couldn’t reconnect to your Remote Control session", "claude_reconnect_failed"],
  [
    "Your organization requires Trusted Devices for Remote Control, but this device is not enrolled",
    "claude_trusted_device_required",
  ],
  ["session expired for trusted-device check", "claude_auth_refresh_required"],
  ["workspace trust", "claude_workspace_trust_required"],
];

export class OfficialAppsService {
  private readonly claudePath: string;
  private readonly codexPath: string;
  private readonly runCommand: OfficialCommandRunner;
  private readonly now: () => number;
  private readonly actionLockPath: string;
  private readonly claudePollIntervalMs: number;
  private readonly claudeStartTimeoutMs: number;
  private readonly codexRemoteControl: CodexRemoteControlClient | null;

  constructor(options: OfficialAppsOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.codexPath = options.codexPath ?? "codex";
    this.runCommand = options.commandRunner ?? runFixedCommand;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.actionLockPath =
      options.actionLockPath ?? path.join(os.homedir(), ".tailii", "official-app-action.lock");
    this.claudePollIntervalMs = options.claudePollIntervalMs ?? 250;
    this.claudeStartTimeoutMs = options.claudeStartTimeoutMs ?? 12_000;
    this.codexRemoteControl = options.codexRemoteControl ?? null;
  }

  async status(context: OfficialAppRuntimeContext): Promise<OfficialAppStatus> {
    const version = await this.providerVersion(context.provider);
    if (version === null) return unavailableStatus(context.provider, "official_cli_unavailable");
    if (context.provider === "codex") {
      if (!context.canMutateCodexDaemon) {
        return unavailableStatus("codex", "codex_agent_busy", version);
      }
      if (this.codexRemoteControl !== null) {
        const status = await this.codexRemoteControl.remoteControlStatus();
        if (status === null) {
          return unavailableStatus("codex", "codex_app_server_remote_unavailable", version);
        }
        switch (status.status) {
          case "connected":
            return {
              provider: "codex",
              version,
              state: "active",
              canOpen: true,
              canStart: false,
            };
          case "disabled":
            return {
              provider: "codex",
              version,
              state: "inactive",
              canOpen: false,
              canStart: true,
            };
          case "connecting":
            return unavailableStatus("codex", "codex_remote_connecting", version);
          case "errored":
            return unavailableStatus("codex", "codex_remote_errored", version);
        }
      }
      return {
        provider: "codex",
        version,
        state: "inactive",
        canOpen: false,
        canStart: true,
      };
    }
    const authReason = await this.claudeAuthReason();
    if (authReason !== null) return unavailableStatus("claude", authReason, version);
    return this.claudeStatus(context, version);
  }

  async perform(
    context: OfficialAppRuntimeContext,
    action: OfficialAppAction,
    automaticEnable: boolean,
    paired: boolean,
  ): Promise<OfficialAppActionResult> {
    const release = this.acquireActionLock();
    if (release === null) {
      return unavailableResult(context.provider, "official_action_in_progress");
    }
    try {
      const version = await this.providerVersion(context.provider);
      if (version === null) {
        return unavailableResult(context.provider, "official_cli_unavailable");
      }
      if (context.provider === "claude") {
        if (action === "stop") {
          return unavailableResult("claude", "official_action_unsupported");
        }
        const authReason = await this.claudeAuthReason();
        if (authReason !== null) return unavailableResult("claude", authReason);
        return this.performClaude(context);
      }
      if (!context.canMutateCodexDaemon) {
        return unavailableResult("codex", "codex_agent_busy");
      }
      return this.performCodex(action, automaticEnable, paired);
    } finally {
      release();
    }
  }

  private async providerVersion(provider: OfficialAppProvider): Promise<string | null> {
    const executable = provider === "claude" ? this.claudePath : this.codexPath;
    const output = await this.runCommand(executable, ["--version"], CLAUDE_AUTH_TIMEOUT_MS);
    if (output?.success !== true) return null;
    const text = output.stdout.trim();
    if (provider === "claude") {
      const version = text.endsWith(" (Claude Code)")
        ? text.slice(0, -" (Claude Code)".length)
        : null;
      return version !== null && SUPPORTED_CLAUDE_VERSIONS.has(version) ? version : null;
    }
    const version = text.startsWith("codex-cli ") ? text.slice("codex-cli ".length) : null;
    return version !== null && SUPPORTED_CODEX_VERSIONS.has(version) ? version : null;
  }

  private async claudeAuthReason(): Promise<string | null> {
    const output = await this.runCommand(
      this.claudePath,
      ["auth", "status", "--json"],
      CLAUDE_AUTH_TIMEOUT_MS,
    );
    if (output?.success !== true) return "claude_auth_status_failed";
    const auth = parseClaudeAuth(output.stdout);
    if (auth === null) return "claude_auth_status_invalid";
    if (!auth.loggedIn) return "claude_login_required";
    if (auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty") {
      return "claude_subscription_login_required";
    }
    return null;
  }

  private async claudeStatus(
    context: OfficialAppRuntimeContext,
    version: string,
  ): Promise<OfficialAppStatus> {
    const paneText = await captureOfficialPane(context.sessionManager, context.session);
    const launchUrl = paneText === null ? null : extractActiveClaudeUrl(paneText);
    if (launchUrl !== null) {
      return {
        provider: "claude",
        version,
        state: "active",
        canOpen: true,
        canStart: false,
        launchUrl,
      };
    }
    if (context.canInjectClaudeCommand) {
      return {
        provider: "claude",
        version,
        state: "inactive",
        canOpen: false,
        canStart: true,
      };
    }
    return unavailableStatus("claude", "claude_agent_busy", version);
  }

  private async performClaude(
    context: OfficialAppRuntimeContext,
  ): Promise<OfficialAppActionResult> {
    const before = await captureOfficialPane(context.sessionManager, context.session);
    const active = before === null ? null : extractActiveClaudeUrl(before);
    if (active !== null) return openResult("claude", active);
    if (!context.canInjectClaudeCommand) {
      return unavailableResult("claude", "claude_agent_busy");
    }
    try {
      await context.sessionManager.sendTextSubmit(context.session, "/remote-control");
    } catch {
      return unavailableResult("claude", "claude_start_failed");
    }

    const deadline = Date.now() + this.claudeStartTimeoutMs;
    let latestText = "";
    do {
      await delay(this.claudePollIntervalMs);
      const paneText = await captureOfficialPane(context.sessionManager, context.session);
      if (paneText !== null) {
        latestText = paneText;
        const url = extractActiveClaudeUrl(paneText);
        if (url !== null) return openResult("claude", url);
        const reason = classifyClaudeFailure(paneText);
        if (reason !== null) return unavailableResult("claude", reason);
      }
    } while (Date.now() <= deadline);
    return unavailableResult(
      "claude",
      classifyClaudeFailure(latestText) ?? "claude_start_failed",
    );
  }

  private async performCodex(
    action: OfficialAppAction,
    automaticEnable: boolean,
    paired: boolean,
  ): Promise<OfficialAppActionResult> {
    if (this.codexRemoteControl !== null) {
      return this.performCodexViaAppServer(action, automaticEnable, paired);
    }
    if (action === "stop") {
      const stopped = await this.runCommand(
        this.codexPath,
        ["remote-control", "stop", "--json"],
        PROVIDER_COMMAND_TIMEOUT_MS,
      );
      return stopped?.success === true && parseCodexStop(stopped.stdout)
        ? { provider: "codex", outcome: "stopped" }
        : unavailableResult("codex", "codex_stop_failed");
    }
    if (!automaticEnable) {
      return unavailableResult("codex", "codex_automatic_enable_disabled");
    }

    const started = await this.runCommand(
      this.codexPath,
      ["remote-control", "start", "--json"],
      PROVIDER_COMMAND_TIMEOUT_MS,
    );
    const start = started?.success === true ? parseCodexStart(started.stdout) : null;
    if (start === null) return unavailableResult("codex", "codex_start_failed");
    if (start === "connecting") return unavailableResult("codex", "codex_remote_connecting");
    const pairedOutput = await this.runCommand(
      this.codexPath,
      ["remote-control", "pair", "--json"],
      PROVIDER_COMMAND_TIMEOUT_MS,
    );
    const pairing =
      pairedOutput?.success === true ? parseCodexPairing(pairedOutput.stdout) : null;
    if (pairing === null) return unavailableResult("codex", "codex_pair_failed");
    if (pairing.expiresAt <= this.now()) {
      return unavailableResult("codex", "codex_pair_expired");
    }
    const launchUrl = codexPairingLaunchUrl(pairing.pairingCode);
    if (launchUrl === null) {
      return unavailableResult("codex", "codex_pair_failed");
    }
    if (action === "open" && paired) return openResult("codex", launchUrl);
    if (pairing.manualPairingCode === null) {
      return unavailableResult("codex", "codex_manual_pair_unavailable");
    }
    return {
      provider: "codex",
      outcome: "pair",
      launchUrl,
      manualPairingCode: pairing.manualPairingCode,
      expiresAt: pairing.expiresAt,
    };
  }

  private async performCodexViaAppServer(
    action: OfficialAppAction,
    automaticEnable: boolean,
    paired: boolean,
  ): Promise<OfficialAppActionResult> {
    const remote = this.codexRemoteControl;
    if (remote === null) return unavailableResult("codex", "codex_app_server_remote_unavailable");
    if (action === "stop") {
      const stopped = await remote.disableRemoteControl();
      return stopped?.status === "disabled"
        ? { provider: "codex", outcome: "stopped" }
        : unavailableResult("codex", "codex_stop_failed");
    }
    if (!automaticEnable) {
      return unavailableResult("codex", "codex_automatic_enable_disabled");
    }

    const enabled = await remote.enableRemoteControl();
    if (enabled === null || enabled.status === "disabled") {
      return unavailableResult("codex", "codex_start_failed");
    }
    // errored は同じ enrollment の別 App Server が既に online の場合にも返る。この場合も
    // pairing artifact は同じ environment へ発行できるため、pair/open を阻害しない。
    const pairing = await remote.startRemoteControlPairing();
    if (pairing === null) return unavailableResult("codex", "codex_pair_failed");
    if (pairing.expiresAt <= this.now()) {
      return unavailableResult("codex", "codex_pair_expired");
    }
    const launchUrl = codexPairingLaunchUrl(pairing.pairingCode);
    if (launchUrl === null) {
      return unavailableResult("codex", "codex_pair_failed");
    }
    if (action === "open" && paired) return openResult("codex", launchUrl);
    const manual = pairing.manualPairingCode;
    if (
      manual === null ||
      Buffer.byteLength(manual, "utf8") > 64 ||
      !/^[A-Z0-9-]{4,64}$/u.test(manual)
    ) {
      return unavailableResult("codex", "codex_manual_pair_unavailable");
    }
    return {
      provider: "codex",
      outcome: "pair",
      launchUrl,
      manualPairingCode: manual,
      expiresAt: pairing.expiresAt,
    };
  }

  private acquireActionLock(): (() => void) | null {
    fs.mkdirSync(path.dirname(this.actionLockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.actionLockPath, "wx", 0o600);
        fs.writeFileSync(fd, `${process.pid}\n`);
        return () => {
          try {
            fs.closeSync(fd);
          } catch {
            // 既に閉じていても後続 unlink を試す。
          }
          try {
            fs.unlinkSync(this.actionLockPath);
          } catch {
            // プロセス終了時など、既に回収済みなら無視。
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
        const owner = readLockPid(this.actionLockPath);
        if (owner !== null && processIsAlive(owner)) return null;
        try {
          fs.unlinkSync(this.actionLockPath);
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

async function captureOfficialPane(
  sessionManager: SessionBackend,
  session: string,
): Promise<string | null> {
  try {
    const text = await sessionManager.capturePane(session, {
      lines: 200,
      joinWrappedLines: true,
    });
    return Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES ? text : null;
  } catch {
    return null;
  }
}

export function extractActiveClaudeUrl(text: string): string | null {
  const candidate = extractClaudeUrlCandidate(text);
  if (candidate === null) return null;
  // URL より後の status bar（例: `/rc active`）を activation marker として採ると、
  // その marker 以降だけを再検索して同じ行より前の URL を取りこぼす。URL 以前の
  // activation announcement と対応付け、後続の inactive marker がない場合だけ返す。
  const activeAt = latestIndex(text.slice(0, candidate.offset + 1), CLAUDE_ACTIVE_MARKERS);
  if (activeAt < 0) return null;
  const inactiveAt = latestIndex(text, CLAUDE_INACTIVE_MARKERS);
  if (inactiveAt > activeAt) return null;
  return candidate.url;
}

function extractClaudeUrlCandidate(text: string): { url: string; offset: number } | null {
  let offset = text.lastIndexOf(CLAUDE_SESSION_PREFIX);
  while (offset >= 0) {
    const candidate = text.slice(offset).split(/\s/u, 1)[0] ?? "";
    if (validClaudeUrl(candidate)) return { url: candidate, offset };
    offset = text.lastIndexOf(CLAUDE_SESSION_PREFIX, offset - 1);
  }
  return null;
}

export function validClaudeUrl(value: string): boolean {
  if (!value.startsWith(CLAUDE_SESSION_PREFIX)) return false;
  const identifier = value.slice(CLAUDE_SESSION_PREFIX.length);
  return (
    identifier.length > 0 &&
    Buffer.byteLength(identifier, "utf8") <= MAX_IDENTIFIER_BYTES &&
    /^[A-Za-z0-9_-]+$/u.test(identifier)
  );
}

export function classifyClaudeFailure(text: string): string | null {
  return CLAUDE_FAILURES.find(([needle]) => text.includes(needle))?.[1] ?? null;
}

interface ClaudeAuth {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
}

function parseClaudeAuth(text: string): ClaudeAuth | null {
  const value = parseStrictObject(text, [
    "loggedIn",
    "authMethod",
    "apiProvider",
    "email",
    "orgId",
    "orgName",
    "subscriptionType",
  ]);
  if (value === null) return null;
  if (
    typeof value["loggedIn"] !== "boolean" ||
    !boundedText(value["authMethod"]) ||
    !boundedText(value["apiProvider"]) ||
    !boundedText(value["email"], 512) ||
    !boundedText(value["orgId"], 512) ||
    !boundedText(value["orgName"], 512) ||
    !boundedText(value["subscriptionType"])
  ) {
    return null;
  }
  return {
    loggedIn: value["loggedIn"],
    authMethod: value["authMethod"],
    apiProvider: value["apiProvider"],
  };
}

type CodexConnectionStatus = "connected" | "connecting";

export function parseCodexStart(text: string): CodexConnectionStatus | null {
  const value = parseStrictObject(text, [
    "mode",
    "status",
    "serverName",
    "environmentId",
    "timedOut",
    "daemon",
  ]);
  if (value === null || value["mode"] !== "daemon") return null;
  const status = value["status"];
  if (status !== "connected" && status !== "connecting") return null;
  if (!boundedText(value["serverName"], 256)) return null;
  if (
    value["environmentId"] !== null &&
    value["environmentId"] !== undefined &&
    !boundedIdentifier(value["environmentId"])
  ) {
    return null;
  }
  if (typeof value["timedOut"] !== "boolean" || (status === "connected" && value["timedOut"])) {
    return null;
  }
  return validCodexDaemon(value["daemon"]) ? status : null;
}

function validCodexDaemon(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = value["status"];
  if (status === "bootstrapped") {
    if (
      !hasOnlyKeys(value, [
        "status",
        "backend",
        "autoUpdateEnabled",
        "remoteControlEnabled",
        "managedCodexPath",
        "managedCodexVersion",
        "socketPath",
        "cliVersion",
        "appServerVersion",
      ])
    ) {
      return false;
    }
    return (
      boundedText(value["backend"]) &&
      typeof value["autoUpdateEnabled"] === "boolean" &&
      value["remoteControlEnabled"] === true &&
      validCodexPaths(value["managedCodexPath"], value["socketPath"]) &&
      validOptionalText(value["managedCodexVersion"]) &&
      boundedText(value["cliVersion"]) &&
      boundedText(value["appServerVersion"])
    );
  }
  if (!["alreadyRunning", "started", "restarted", "running"].includes(String(status))) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      "status",
      "backend",
      "pid",
      "managedCodexPath",
      "managedCodexVersion",
      "socketPath",
      "cliVersion",
      "appServerVersion",
    ])
  ) {
    return false;
  }
  return (
    (value["backend"] === undefined || boundedText(value["backend"])) &&
    (value["pid"] === undefined ||
      (typeof value["pid"] === "number" && Number.isInteger(value["pid"]) && value["pid"] > 0)) &&
    validCodexPaths(value["managedCodexPath"], value["socketPath"]) &&
    validOptionalText(value["managedCodexVersion"]) &&
    validOptionalText(value["cliVersion"]) &&
    validOptionalText(value["appServerVersion"])
  );
}

interface CodexPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  expiresAt: number;
}

export function parseCodexPairing(text: string): CodexPairing | null {
  const value = parseStrictObject(text, [
    "pairingCode",
    "manualPairingCode",
    "environmentId",
    "expiresAt",
  ]);
  if (
    value === null ||
    !boundedSecret(value["pairingCode"], MAX_PAIRING_CODE_BYTES) ||
    !boundedIdentifier(value["environmentId"]) ||
    typeof value["expiresAt"] !== "number" ||
    !Number.isInteger(value["expiresAt"]) ||
    value["expiresAt"] <= 0
  ) {
    return null;
  }
  const code = value["manualPairingCode"];
  if (code !== null && code !== undefined) {
    if (typeof code !== "string" || !/^[A-Z0-9-]{4,64}$/u.test(code)) return null;
  }
  return {
    pairingCode: value["pairingCode"],
    manualPairingCode: typeof code === "string" ? code : null,
    expiresAt: value["expiresAt"],
  };
}

function codexPairingLaunchUrl(pairingCode: string): string | null {
  if (!boundedSecret(pairingCode, MAX_PAIRING_CODE_BYTES)) return null;
  const url = new URL(CHATGPT_CODEX_PAIR_URL);
  url.searchParams.set("pairing_code", pairingCode);
  return url.toString();
}

export function parseCodexStop(text: string): boolean {
  const value = parseStrictObject(text, [
    "status",
    "backend",
    "pid",
    "managedCodexPath",
    "managedCodexVersion",
    "socketPath",
    "cliVersion",
    "appServerVersion",
  ]);
  if (value === null || (value["status"] !== "stopped" && value["status"] !== "notRunning")) {
    return false;
  }
  return (
    (value["backend"] === undefined || boundedText(value["backend"])) &&
    (value["pid"] === undefined ||
      (typeof value["pid"] === "number" && Number.isInteger(value["pid"]) && value["pid"] > 0)) &&
    validCodexPaths(value["managedCodexPath"], value["socketPath"]) &&
    validOptionalText(value["managedCodexVersion"]) &&
    validOptionalText(value["cliVersion"]) &&
    validOptionalText(value["appServerVersion"])
  );
}

function parseStrictObject(text: string, keys: readonly string[]): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && hasOnlyKeys(value, keys) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    keys.every((key) => Object.hasOwn(value, key) || optionalCodexField(key));
}

function optionalCodexField(key: string): boolean {
  return [
    "environmentId",
    "backend",
    "pid",
    "managedCodexVersion",
    "cliVersion",
    "appServerVersion",
    "manualPairingCode",
  ].includes(key);
}

function validCodexPaths(binary: unknown, socket: unknown): boolean {
  return (
    typeof binary === "string" &&
    typeof socket === "string" &&
    path.isAbsolute(binary) &&
    path.isAbsolute(socket) &&
    Buffer.byteLength(binary, "utf8") <= 4_096 &&
    Buffer.byteLength(socket, "utf8") <= 4_096
  );
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
  );
}

function boundedText(value: unknown, maximum = MAX_IDENTIFIER_BYTES): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function validOptionalText(value: unknown): boolean {
  return value === null || value === undefined || boundedText(value);
}

function boundedSecret(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\s\u0000-\u001F\u007F]/u.test(value)
  );
}

function latestIndex(text: string, markers: readonly string[]): number {
  return markers.reduce((latest, marker) => Math.max(latest, text.lastIndexOf(marker)), -1);
}

function classifySpawnSuccess(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 0 && signal === null;
}

async function runFixedCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<OfficialCommandOutput | null> {
  return new Promise((resolve) => {
    let settled = false;
    let overflow = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(executable, [...args], {
      cwd: os.homedir(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (value: OfficialCommandOutput | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const next = current + chunk.length;
      if (next > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return next;
      }
      chunks.push(chunk);
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    child.once("error", () => finish(null));
    child.once("close", (code, signal) => {
      if (overflow) return finish(null);
      finish({
        success: classifySpawnSuccess(code, signal),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
  });
}

function readLockPid(lockPath: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function unavailableStatus(
  provider: OfficialAppProvider,
  reason: string,
  version?: string,
): OfficialAppStatus {
  return {
    provider,
    ...(version !== undefined ? { version } : {}),
    state: "unavailable",
    canOpen: false,
    canStart: false,
    unavailableReason: reason,
  };
}

function unavailableResult(
  provider: OfficialAppProvider,
  reason: string,
): OfficialAppActionResult {
  return { provider, outcome: "unavailable", unavailableReason: reason };
}

function openResult(
  provider: OfficialAppProvider,
  launchUrl: string,
): OfficialAppActionResult {
  return { provider, outcome: "open", launchUrl };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
