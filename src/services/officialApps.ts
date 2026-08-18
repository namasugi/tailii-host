// officialApps.ts
// tailii host — Claude / ChatGPT 公式アプリ連携の固定コマンドアダプタ。
//
// クライアントから実行ファイル・argv・URL・任意文字列は受け取らない。provider と
// open/repair/stop の型付き操作だけを受け、現行の検証済み CLI 出力だけを解釈する。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { SessionBackend } from "../backend/sessionBackend.js";
import { defaultInjectedPath } from "../commands/launch.js";
import {
  MINIMUM_CLAUDE_CLI_VERSION,
  MINIMUM_CODEX_CLI_VERSION,
  versionAtLeast,
} from "../shared/cliVersions.js";

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
  /**
   * この会話の Claude transcript（`~/.claude/projects/<slug>/<uuid>.jsonl`）。
   * Remote Control の URL は pane 文面ではなく transcript の bridge_status 行を
   * 権威とする（チャット本文が activation 文言を引用しても誤検出しないため）。
   */
  claudeTranscriptPath: string | null;
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
  claudeReconnectGraceMs?: number;
  /** 実行証跡ゼロが続いたときの再注入間隔（RC 切断直後の limbo 対策）。 */
  claudeReinjectAfterMs?: number;
  /** 公式アプリ経路の常時診断ログ（null で無効。engine は ~/.tailii/official-app.log を渡す）。 */
  diagnosticLogPath?: string | null;
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
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_FRESH_SKEW_MS = 5_000;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_PAIRING_CODE_BYTES = 2_048;
const PROVIDER_COMMAND_TIMEOUT_MS = 22_000;
const CLAUDE_AUTH_TIMEOUT_MS = 5_000;
// 公式アプリ連携に必要な最低 CLI バージョンは shared/cliVersions.ts（doctor と共有）。
// CLI は自動更新されるため完全一致の許可リストは更新の度に「対応する公式 CLI の
// バージョンを確認できませんでした」で停止していた（2.1.220 → 2.1.234 で再発）。
// 以降は下限のみゲートし、新しい版は実行時検証（claude: pane マーカー + transcript
// bridge_status + timeout、codex: remote-control JSON の strict parse）に委ねる。
// 実機検証済みの版は VERIFIED_* に残し、未検証版で動いたときは診断ログに明記して
// drift 調査の起点にする。
const VERIFIED_CLAUDE_VERSIONS = new Set(["2.1.215", "2.1.218", "2.1.220", "2.1.234"]);
const VERIFIED_CODEX_VERSIONS = new Set(["0.144.5", "0.145.0"]);

// Remote Control が active と CLI が認識している最中に /remote-control を再実行すると、
// 2.1.220 はバナーではなく modal dialog（Disconnect / Show QR / Continue）を開き、
// Enter/Esc を受けるまで pane を塞ぎ続ける（自動では閉じない）。iPhone からは不可視の
// ため、検出したら Esc で閉じて dialog 内の URL を採用する。
const CLAUDE_DIALOG_URL_PREFIX = "This session is available in the Claude mobile app and at ";
const CLAUDE_DIALOG_DISCONNECT_LABEL = "Disconnect this session";

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
  private readonly claudeReconnectGraceMs: number;
  private readonly claudeReinjectAfterMs: number;
  private readonly diagnosticLogPath: string | null;
  private readonly codexRemoteControl: CodexRemoteControlClient | null;
  private readonly unverifiedVersionLogged = new Set<string>();

  constructor(options: OfficialAppsOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.codexPath = options.codexPath ?? "codex";
    this.runCommand = options.commandRunner ?? runFixedCommand;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.actionLockPath =
      options.actionLockPath ?? path.join(os.homedir(), ".tailii", "official-app-action.lock");
    this.claudePollIntervalMs = options.claudePollIntervalMs ?? 250;
    // アーカイブ後の再接続はバナー再表示まで 10-15 秒かかることを実測済み。
    this.claudeStartTimeoutMs = options.claudeStartTimeoutMs ?? 20_000;
    this.claudeReconnectGraceMs = options.claudeReconnectGraceMs ?? 5_000;
    this.claudeReinjectAfterMs = options.claudeReinjectAfterMs ?? 6_000;
    this.diagnosticLogPath = options.diagnosticLogPath ?? null;
    this.codexRemoteControl = options.codexRemoteControl ?? null;
  }

  /** 障害調査用の常時ログ。失敗時にどの分岐で落ちたかを事後特定できるようにする。 */
  private diag(message: string): void {
    if (this.diagnosticLogPath === null) return;
    try {
      fs.appendFileSync(
        this.diagnosticLogPath,
        `[${new Date().toISOString()}] ${message}\n`,
      );
    } catch {
      // 診断ログは本処理を妨げない。
    }
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
        this.diag(`perform cli unavailable provider=${context.provider}`);
        return unavailableResult(context.provider, "official_cli_unavailable");
      }
      if (context.provider === "claude") {
        if (action === "stop") {
          return this.stopClaude(context);
        }
        const authReason = await this.claudeAuthReason();
        if (authReason !== null) {
          this.diag(`perform auth reason=${authReason}`);
          return unavailableResult("claude", authReason);
        }
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
    const version =
      provider === "claude"
        ? text.endsWith(" (Claude Code)")
          ? text.slice(0, -" (Claude Code)".length)
          : null
        : text.startsWith("codex-cli ")
          ? text.slice("codex-cli ".length)
          : null;
    if (version === null || !isSupportedCliVersion(provider, version)) return null;
    const verified = provider === "claude" ? VERIFIED_CLAUDE_VERSIONS : VERIFIED_CODEX_VERSIONS;
    if (!verified.has(version) && !this.unverifiedVersionLogged.has(`${provider}:${version}`)) {
      this.unverifiedVersionLogged.add(`${provider}:${version}`);
      this.diag(`provider version unverified provider=${provider} version=${version}`);
    }
    return version;
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
    const dialogUrl = paneText === null ? null : extractClaudeRemoteDialogUrl(paneText);
    const active =
      dialogUrl !== null || (paneText !== null && statusBarShowsRemoteControl(paneText));
    if (active) {
      const launchUrl =
        lastTranscriptRemoteControlEntry(context.claudeTranscriptPath)?.url ??
        dialogUrl ??
        (paneText === null ? null : extractBannerClaudeUrl(paneText));
      return {
        provider: "claude",
        version,
        state: "active",
        canOpen: true,
        canStart: false,
        ...(launchUrl !== null ? { launchUrl } : {}),
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
    this.diag(
      `perform start session=${context.session} paneBytes=${
        before === null ? "null" : Buffer.byteLength(before, "utf8")
      } transcript=${context.claudeTranscriptPath ?? "none"} canInject=${context.canInjectClaudeCommand}`,
    );
    const staleDialog = before === null ? null : extractClaudeRemoteDialogUrl(before);
    if (staleDialog !== null) {
      await this.dismissClaudeRemoteDialog(context);
      this.diag(`perform open via stale dialog session=${context.session}`);
      return openResult("claude", staleDialog);
    }
    if (before !== null && statusBarShowsRemoteControl(before)) {
      const url =
        lastTranscriptRemoteControlEntry(context.claudeTranscriptPath)?.url ??
        extractBannerClaudeUrl(before);
      if (url !== null) {
        this.diag(`perform open via pre-check /rc session=${context.session}`);
        return openResult("claude", url);
      }
      // active なのに URL 不明（transcript 欠落・バナー窓外）: 注入すると CLI は
      // dialog を開くので、poll 側の dialog 経路で URL を回収できる。
      this.diag(`perform /rc lit but url unknown session=${context.session}`);
    }
    if (!context.canInjectClaudeCommand) {
      this.diag(`perform busy session=${context.session}`);
      return unavailableResult("claude", "claude_agent_busy");
    }
    try {
      await context.sessionManager.sendTextSubmit(context.session, "/remote-control");
    } catch (error) {
      this.diag(`perform inject failed session=${context.session} error=${String(error).slice(0, 120)}`);
      return unavailableResult("claude", "claude_start_failed");
    }
    this.diag(`perform injected session=${context.session}`);

    const injectedAtMs = Date.now();
    const deadline = injectedAtMs + this.claudeStartTimeoutMs;
    let injectionAttempts = 1;
    // transcript は stat(size/mtime) が変わったときだけ読み直す（8MiB 窓を 250ms
    // 毎に全読みしない）。実行証跡（local_command 記録）の有無も同じ stat ゲートで
    // 更新し、一度 true になったら固定する（記録は消えない）。
    let cachedEntry: TranscriptRemoteControlEntry | null = null;
    let cachedStamp = "";
    let commandRecordSeen = false;
    const currentTranscriptEntry = (): TranscriptRemoteControlEntry | null => {
      if (context.claudeTranscriptPath === null) return null;
      let stamp: string;
      try {
        const stat = fs.statSync(context.claudeTranscriptPath);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return null;
      }
      if (stamp !== cachedStamp) {
        cachedEntry = lastTranscriptRemoteControlEntry(context.claudeTranscriptPath);
        if (!commandRecordSeen) {
          commandRecordSeen = transcriptHasRemoteControlCommandSince(
            context.claudeTranscriptPath,
            injectedAtMs - TRANSCRIPT_FRESH_SKEW_MS,
          );
        }
        cachedStamp = stamp;
      }
      return cachedEntry;
    };
    let latestText = "";
    let paneMisses = 0;
    do {
      await delay(this.claudePollIntervalMs);
      const paneText = await captureOfficialPane(context.sessionManager, context.session);
      // transcript の bridge_status は pane 取得の成否と独立に判定する（pane が
      // 一時的に読めない状態が続いても activation 成功を取りこぼさない）。
      const entry = currentTranscriptEntry();
      // 新規 activation は bridge_status を追記する。注入以降の行だけを新規成功と
      // みなす（TRANSCRIPT_FRESH_SKEW_MS は書込タイムスタンプとの許容ずれ）。
      if (
        entry !== null &&
        entry.atMs !== null &&
        entry.atMs >= injectedAtMs - TRANSCRIPT_FRESH_SKEW_MS
      ) {
        this.diag(`perform open via fresh bridge_status session=${context.session}`);
        return openResult("claude", entry.url);
      }
      if (paneText === null) {
        paneMisses += 1;
        // pane が読めないまま grace を超えたら、既知 URL を最善手として返す
        // （capture 障害で 20 秒待って失敗にするより回復性を優先）。
        if (entry !== null && Date.now() - injectedAtMs > this.claudeReconnectGraceMs) {
          this.diag(
            `perform open via known URL (pane unreadable x${paneMisses}) session=${context.session}`,
          );
          return openResult("claude", entry.url);
        }
        continue;
      }
      latestText = paneText;
      // 会話がアーカイブされた直後は CLI がまだ active 扱いのため、注入した
      // /remote-control が dialog になる。閉じて URL を返す（再接続は CLI 側が担う）。
      const dialogUrl = extractClaudeRemoteDialogUrl(paneText);
      if (dialogUrl !== null) {
        await this.dismissClaudeRemoteDialog(context);
        this.diag(`perform open via dialog session=${context.session}`);
        return openResult("claude", dialogUrl);
      }
      // 同一プロセスの再接続は bridge_status を追記しない（実測）。/rc 点灯を
      // 確認できたら既知 URL（同一プロセスで不変）を返す。新規行の追記を先に
      // 拾えるよう、注入直後の grace 期間は entry 追記待ちを優先する。
      if (
        entry !== null &&
        statusBarShowsRemoteControl(paneText) &&
        Date.now() - injectedAtMs > this.claudeReconnectGraceMs
      ) {
        this.diag(`perform open via /rc + known URL session=${context.session}`);
        return openResult("claude", entry.url);
      }
      if (entry === null) {
        const bannerUrl = extractBannerClaudeUrl(paneText);
        if (bannerUrl !== null) {
          this.diag(`perform open via banner session=${context.session}`);
          return openResult("claude", bannerUrl);
        }
      }
      const reason = classifyClaudeFailure(paneText);
      if (reason !== null) {
        this.diag(`perform failure marker=${reason} session=${context.session}`);
        return unavailableResult("claude", reason);
      }
      // RC 切断直後の limbo では注入テキストが入力欄エコーごと黙殺される（実測:
      // record も pane 変化も残らない）。実行証跡（local_command 記録）が出ないまま
      // 時間が経ったら、limbo が明けた前提で再注入する（少し待てば成功する挙動を
      // 手動の押し直しからホスト内リトライへ移す）。claude が処理中（ユーザーが
      // 並行してメッセージを送った等）の再注入は、queued 化してターン後に意図せず
      // 実行されるため見送る。
      if (
        injectionAttempts < 3 &&
        Date.now() - injectedAtMs > this.claudeReinjectAfterMs * injectionAttempts &&
        !commandRecordSeen &&
        !statusBarShowsProcessing(paneText)
      ) {
        injectionAttempts += 1;
        this.diag(`perform reinject attempt=${injectionAttempts} session=${context.session}`);
        try {
          await context.sessionManager.sendTextSubmit(context.session, "/remote-control");
        } catch {
          // 再注入失敗は poll 継続（最終的に timeout で報告する）。
        }
      }
    } while (Date.now() <= deadline);
    this.diag(
      `perform timeout session=${context.session} paneMisses=${paneMisses} ` +
        `transcript=${context.claudeTranscriptPath ?? "none"} lastPaneBytes=${Buffer.byteLength(latestText, "utf8")}`,
    );
    return unavailableResult(
      "claude",
      classifyClaudeFailure(latestText) ?? "claude_start_failed",
    );
  }

  /**
   * Remote Control の切断。2.1.220 の `/remote-control` はトグルではなく、active 中の
   * 再実行で dialog（Disconnect / Show QR / Continue, カーソルは Continue）を開く。
   * dialog を出して Up Up + Enter で「Disconnect this session」を選択し、ステータス
   * バーの `/rc` 消灯で成功を検証する（実測 2026-07-27）。
   */
  private async stopClaude(
    context: OfficialAppRuntimeContext,
  ): Promise<OfficialAppActionResult> {
    const before = await captureOfficialPane(context.sessionManager, context.session);
    this.diag(
      `stop start session=${context.session} paneBytes=${
        before === null ? "null" : Buffer.byteLength(before, "utf8")
      }`,
    );
    let dialogVisible = before !== null && extractClaudeRemoteDialogUrl(before) !== null;
    if (!dialogVisible) {
      if (before === null || !statusBarShowsRemoteControl(before)) {
        this.diag(`stop already off session=${context.session}`);
        return { provider: "claude", outcome: "stopped" };
      }
      if (!context.canInjectClaudeCommand) {
        return unavailableResult("claude", "claude_agent_busy");
      }
      try {
        await context.sessionManager.sendTextSubmit(context.session, "/remote-control");
      } catch {
        return unavailableResult("claude", "claude_stop_failed");
      }
      // dialog が開くのを待つ。
      const dialogDeadline = Date.now() + Math.min(8_000, this.claudeStartTimeoutMs);
      while (Date.now() <= dialogDeadline) {
        await delay(this.claudePollIntervalMs);
        const paneText = await captureOfficialPane(context.sessionManager, context.session);
        if (paneText !== null && extractClaudeRemoteDialogUrl(paneText) !== null) {
          dialogVisible = true;
          break;
        }
      }
      if (!dialogVisible) {
        this.diag(`stop dialog never appeared session=${context.session}`);
        return unavailableResult("claude", "claude_stop_failed");
      }
    }
    try {
      await context.sessionManager.sendKeys(context.session, ["Up", "Up", "Enter"]);
    } catch {
      await this.dismissClaudeRemoteDialog(context);
      return unavailableResult("claude", "claude_stop_failed");
    }
    const offDeadline = Date.now() + Math.min(8_000, this.claudeStartTimeoutMs);
    while (Date.now() <= offDeadline) {
      await delay(this.claudePollIntervalMs);
      const paneText = await captureOfficialPane(context.sessionManager, context.session);
      if (
        paneText !== null &&
        !statusBarShowsRemoteControl(paneText) &&
        extractClaudeRemoteDialogUrl(paneText) === null
      ) {
        this.diag(`stop confirmed session=${context.session}`);
        return { provider: "claude", outcome: "stopped" };
      }
    }
    // dialog が残っている可能性に備えて閉じ、失敗として報告する。
    await this.dismissClaudeRemoteDialog(context);
    this.diag(`stop verify timeout session=${context.session}`);
    return unavailableResult("claude", "claude_stop_failed");
  }

  private async dismissClaudeRemoteDialog(context: OfficialAppRuntimeContext): Promise<void> {
    try {
      await context.sessionManager.sendKeys(context.session, ["Escape"]);
    } catch {
      // 閉じられなくても open は返す。次回 perform 時に再検出して再試行する。
    }
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
    // 再接続時のバナーは新規行ではなく「初回 activation の位置」に復元される
    // （実測）。長い会話でも拾えるよう窓を広めに取る（MAX_OUTPUT_BYTES 内）。
    const text = await sessionManager.capturePane(session, {
      lines: 600,
      joinWrappedLines: true,
    });
    return Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES ? text : null;
  } catch {
    return null;
  }
}

/** 最低バージョン以上なら対応（上限なし。新版は実行時検証に委ねる）。形式外は非対応。 */
export function isSupportedCliVersion(provider: OfficialAppProvider, version: string): boolean {
  const minimum = provider === "claude" ? MINIMUM_CLAUDE_CLI_VERSION : MINIMUM_CODEX_CLI_VERSION;
  return versionAtLeast(version, minimum) === true;
}

/**
 * pane 最下部のステータスバーに `/rc` インジケータが点灯しているか。
 * バナー文言はチャット本文の引用（デバッグ表示・ユーザーの貼り付け）で偽陽性に
 * なり得るのに対し、末尾行の TUI クロームは本文が占有できないため活性判定の権威。
 */
export function statusBarShowsRemoteControl(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  // 入力プロンプト行（❯ で始まる）は下書きに `/rc` と打たれ得るため除外する。
  return lines
    .slice(-3)
    .some((line) => !line.trim().startsWith("❯") && /(^|\s)\/rc$/u.test(line));
}

/**
 * pane 最下部のステータスバーが処理中（`esc to interrupt`）を示しているか。
 * アイドル時のバー（`? for shortcuts`）には現れない実測差分を使う。
 * 本文引用対策として末尾 3 行だけを見る。
 */
export function statusBarShowsProcessing(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return lines
    .slice(-3)
    .some((line) => !line.trim().startsWith("❯") && line.includes("esc to interrupt"));
}

export interface TranscriptRemoteControlEntry {
  url: string;
  atMs: number | null;
}

/**
 * transcript 末尾から最新の bridge_status（Remote Control activation）行を読む。
 * CLI 自身が書く構造化行なので、pane と違い本文引用による偽陽性がない。
 * URL は同一 CLI プロセス内の再接続で不変（実測）のため、最後の 1 件が現在値。
 */
function readTranscriptTail(transcriptPath: string): string | null {
  try {
    const size = fs.statSync(transcriptPath).size;
    // activation は会話冒頭側にあり得る。巨大 tool 出力で末尾から遠のくため
    // 窓は広めに取る（この取りこぼしを 256KiB で実際に踏んだ）。
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 注入以降に /remote-control の実行記録（local_command）が書かれたか。
 * RC 切断直後の limbo では typed 入力が入力欄エコーごと黙殺される（実測）ため、
 * 「注入したのに実行証跡が無い」ことの検出に使う（再注入の判断材料）。
 */
export function transcriptHasRemoteControlCommandSince(
  transcriptPath: string | null,
  sinceMs: number,
): boolean {
  if (transcriptPath === null) return false;
  const tail = readTranscriptTail(transcriptPath);
  if (tail === null) return false;
  for (const line of tail.split("\n").reverse()) {
    if (!line.includes('"local_command"') || !line.includes("/remote-control")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["subtype"] !== "local_command") continue;
    const content = typeof entry["content"] === "string" ? entry["content"] : "";
    if (!content.includes("<command-name>/remote-control</command-name>")) continue;
    const timestamp = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;
    if (!Number.isNaN(timestamp) && timestamp >= sinceMs) return true;
  }
  return false;
}

export function lastTranscriptRemoteControlEntry(
  transcriptPath: string | null,
): TranscriptRemoteControlEntry | null {
  if (transcriptPath === null) return null;
  const tail = readTranscriptTail(transcriptPath);
  if (tail === null) return null;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.includes('"bridge_status"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["subtype"] !== "bridge_status") continue;
    const content = typeof entry["content"] === "string" ? entry["content"] : "";
    if (!content.includes("/remote-control is active")) continue;
    const at = content.indexOf(CLAUDE_SESSION_PREFIX);
    if (at < 0) continue;
    const raw = content.slice(at).split(/\s/u, 1)[0] ?? "";
    const candidate = raw.endsWith(".") ? raw.slice(0, -1) : raw;
    if (!validClaudeUrl(candidate)) continue;
    const timestamp = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;
    return { url: candidate, atMs: Number.isNaN(timestamp) ? null : timestamp };
  }
  return null;
}

/**
 * pane から activation バナーの URL を拾う最終フォールバック。行頭（trim 後）が
 * activation 文言で始まる行だけを banner とみなし、同一行 or 直後行の URL を採る。
 * 本文引用への完全な耐性はないため、transcript(bridge_status) が引けない場合のみ使う。
 */
export function extractBannerClaudeUrl(text: string): string | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (
      !trimmed.startsWith("/remote-control is active") &&
      !trimmed.startsWith("Remote Control is active")
    ) {
      continue;
    }
    const sameLineAt = trimmed.indexOf(CLAUDE_SESSION_PREFIX);
    if (sameLineAt >= 0) {
      const candidate = trimmed.slice(sameLineAt).split(/\s/u, 1)[0] ?? "";
      if (validClaudeUrl(candidate)) return candidate;
    }
    for (let next = index + 1; next < Math.min(lines.length, index + 3); next += 1) {
      const nextTrimmed = (lines[next] ?? "").trim();
      if (nextTrimmed === "") continue;
      if (!nextTrimmed.startsWith(CLAUDE_SESSION_PREFIX)) break;
      const candidate = nextTrimmed.split(/\s/u, 1)[0] ?? "";
      if (validClaudeUrl(candidate)) return candidate;
      break;
    }
  }
  return null;
}

export function extractClaudeRemoteDialogUrl(text: string): string | null {
  // チャット本文がダイアログ文言を引用しただけの偽陽性を避けるため、substring では
  // なく trim 後の行単位で照合する（実ダイアログは各要素が行頭に独立して並ぶ）。
  const lines = text.split("\n").map((line) => line.trim());
  if (!lines.some((line) => line === CLAUDE_DIALOG_DISCONNECT_LABEL)) return null;
  if (!lines.some((line) => line.startsWith("Enter to select"))) return null;
  const urlLine = [...lines]
    .reverse()
    .find((line) => line.startsWith(CLAUDE_DIALOG_URL_PREFIX));
  if (urlLine === undefined) return null;
  const raw = urlLine.slice(CLAUDE_DIALOG_URL_PREFIX.length).split(/\s/u, 1)[0] ?? "";
  const candidate = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  return validClaudeUrl(candidate) ? candidate : null;
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
      // SSH 経由で spawn された engine は非ログインシェルの PATH（~/.local/bin 等を
      // 含まない）を継承し、`claude` 解決に失敗して official_cli_unavailable になる
      // （QUIC gw 経由は --path 注入済みで成功する、という transport 依存の実障害）。
      // launch と同じ既知ディレクトリを前置して両 transport で解決を揃える。
      env: {
        ...process.env,
        PATH: [defaultInjectedPath(), process.env["PATH"] ?? ""].filter(Boolean).join(":"),
      },
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
