// tmux.ts
// tailii (TS host) — tmux セッションの list / reattach / kill / send-keys / capture-pane
// Swift 版 TmuxSessionManager.swift の移植。
// 生存集合は `tmux ls -F '#{session_name}'`、cwd は SessionMetadataStore を権威とする。

import { execFile } from "node:child_process";
import { PROTOCOL_V1, type ControlMessage, type SessionInfo } from "./protocol.js";
import { SessionMetadataStore, validateSessionName } from "./sessionMetadataStore.js";

/** tmux コマンド 1 回分の実行結果。 */
export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** tmux コマンド実行の注入可能な抽象（テストはモックを注入する）。 */
export type TmuxCommandRunner = (args: string[]) => Promise<TmuxCommandResult>;

/** tmux 実行ファイルの既定絶対パス（PATH 外のため絶対指定）。 */
export const DEFAULT_TMUX_PATH = "/opt/homebrew/bin/tmux";

/** pane_current_command がこの集合なら、Claude 本体は終了してシェルだけが残っている。 */
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "dash", "fish", "tcsh", "csh", "ksh", "login"]);

/** tmux の pane_current_command がエージェント実行中に見えるか。空文字は判定不能なので安全側。 */
export function paneCommandLooksLikeAgent(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized.length === 0 || !SHELL_COMMANDS.has(normalized);
}

export interface CapturePaneOptions {
  /** 取得する末尾行数。未指定なら manager 既定値。 */
  lines?: number;
  /** 折り返し行を結合する（tmux capture-pane -J）。 */
  joinWrappedLines?: boolean;
}

/** 実 tmux を絶対パスで起動する既定ランナー。tmux 非0 exit は throw せず結果で表現する。 */
export function processTmuxCommandRunner(tmuxPath: string = DEFAULT_TMUX_PATH): TmuxCommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(tmuxPath, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // 実行ファイル起動自体の失敗（ENOENT 等）のみ throw（Swift 版と同じ境界）。
          reject(error);
          return;
        }
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

/** TmuxSessionManager が投げる型付きエラー。 */
export class TmuxFailedError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr}`);
    this.name = "TmuxFailedError";
  }
}

/** reattach の型付き結果。 */
export type ReattachResult =
  | { kind: "attached"; info: SessionInfo; recentOutput: string }
  | { kind: "notFound"; error: ControlMessage };

/** tmux セッションの list / reattach / kill とメタデータ統合。 */
export class TmuxSessionManager {
  private readonly runner: TmuxCommandRunner;
  readonly store: SessionMetadataStore;
  private readonly captureLines: number;
  private readonly protocolVersion: number;

  constructor(options: {
    runner?: TmuxCommandRunner;
    store?: SessionMetadataStore;
    captureLines?: number;
    protocolVersion?: number;
  } = {}) {
    this.runner = options.runner ?? processTmuxCommandRunner();
    this.store = options.store ?? new SessionMetadataStore();
    this.captureLines = options.captureLines ?? 50;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_V1;
  }

  /**
   * 現存する各セッションを name/cwd/alive で列挙する（name 昇順、メタのみは alive:false）。
   * updatedAt はここでは付与しない。tmux `#{session_activity}` はセッション作成自体を「活動」
   * として刻むため、会話ゼロの新規セッションが実会話より上に浮く。整列時刻の権威は
   * SessionActivityProvider（セッション自身の transcript mtime）に一本化する。
   */
  async list(): Promise<SessionInfo[]> {
    const alive = await this.liveSessionNames();
    // herdr backend のメタは HerdrSessionManager が列挙する（Composite で和を取る）。
    const metas = this.store.all().filter((meta) => meta.backend !== "herdr");

    const cwdByName = new Map<string, string>();
    const claudeSessionIdByName = new Map<string, string>();
    const providerSessionIdByName = new Map<string, string>();
    const agentByName = new Map<string, "claude" | "codex">();
    for (const meta of metas) {
      cwdByName.set(meta.name, meta.cwd);
      if (meta.claudeSessionId !== undefined) claudeSessionIdByName.set(meta.name, meta.claudeSessionId);
      const agent = meta.agent ?? "claude";
      if (meta.agent !== undefined) agentByName.set(meta.name, meta.agent);
      const providerSessionId = meta.providerSessionId ?? (agent === "claude" ? meta.claudeSessionId : undefined);
      if (providerSessionId !== undefined) providerSessionIdByName.set(meta.name, providerSessionId);
    }

    const names = new Set<string>(alive);
    for (const meta of metas) names.add(meta.name);

    const infos: SessionInfo[] = [...names].map((name) => ({
      name,
      cwd: cwdByName.get(name) ?? "",
      alive: alive.has(name),
      ...(claudeSessionIdByName.has(name) ? { claudeSessionId: claudeSessionIdByName.get(name)! } : {}),
      ...(agentByName.has(name) ? { agent: agentByName.get(name)! } : {}),
      ...(providerSessionIdByName.has(name)
        ? { providerSessionId: providerSessionIdByName.get(name)! }
        : {}),
    }));
    return infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 既存セッションへ reattach（生存: attached / 不在: session_not_found エラー封筒）。 */
  async reattach(name: string): Promise<ReattachResult> {
    validateSessionName(name);
    const aliveNames = await this.liveSessionNames();
    if (!aliveNames.has(name)) {
      return {
        kind: "notFound",
        error: {
          type: "error",
          v: this.protocolVersion,
          code: "session_not_found",
          message: `セッション '${name}' は存在しません。新規に起動できます。`,
        },
      };
    }
    // Claude が終了してシェルだけ残った tmux は、存在していても入力先としては無効。
    // stale session を消して notFound と同じ再開経路へ流し、engine に --resume 起動させる。
    // Codex のターンは App Server が駆動し、TUI が shell command に見える待機期間もあるため除外する。
    if ((this.store.get(name)?.agent ?? "claude") === "claude" && !(await this.agentProcessAlive(name))) {
      await this.kill(name);
      return {
        kind: "notFound",
        error: {
          type: "error",
          v: this.protocolVersion,
          code: "session_not_found",
          message: `セッション '${name}' のエージェントを再起動します。`,
        },
      };
    }
    const cwd = this.store.get(name)?.cwd ?? "";
    const recent = await this.capturePane(name);
    return { kind: "attached", info: { name, cwd, alive: true }, recentOutput: recent };
  }

  /** pane 内のエージェント生存判定。tmux エラーや空出力は二重起動を避けて true に倒す。 */
  async agentProcessAlive(name: string): Promise<boolean> {
    validateSessionName(name);
    try {
      const result = await this.runner([
        "display-message", "-p", "-t", this.paneTarget(name), "#{pane_current_command}",
      ]);
      if (result.exitCode !== 0) return true;
      return paneCommandLooksLikeAgent(result.stdout);
    } catch {
      return true;
    }
  }

  /** 指定セッションのみを終了する（tmux kill-session -t <name>）。 */
  async kill(name: string): Promise<void> {
    validateSessionName(name);
    const args = ["kill-session", "-t", name];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
  }

  /**
   * 本文入力と送信確定を 1 操作で行う（chat 注入・kick 用, SessionBackend 共通面）。
   * literal 送出 → 150ms（Ink 再描画待ち）→ Enter。
   */
  async sendTextSubmit(name: string, text: string): Promise<void> {
    await this.sendKeys(name, [text], true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.sendKeys(name, ["Enter"]);
  }

  /** 指定セッションの pane へ tmux send-keys を発行する（literal は -l）。 */
  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    validateSessionName(name);
    if (keys.length === 0) return;
    const args = ["send-keys", "-t", this.paneTarget(name)];
    if (literal) args.push("-l");
    args.push(...keys);
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
  }

  /** `capture-pane -p -t <name> -S -<N>` で末尾 N 行のペイン内容を返す（末尾空行は削る）。 */
  async capturePane(name: string, options: CapturePaneOptions = {}): Promise<string> {
    const args = ["capture-pane", "-p"];
    if (options.joinWrappedLines ?? false) args.push("-J");
    args.push("-t", this.paneTarget(name), "-S", `-${options.lines ?? this.captureLines}`);
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
    const lines = result.stdout.split("\n");
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /** pane ID が記録済みなら `%N` を使い、旧メタデータでは session 名へ戻す。 */
  private paneTarget(name: string): string {
    validateSessionName(name);
    return this.store.get(name)?.tmuxPaneId ?? name;
  }

  /** `tmux ls` の生存セッション名集合。サーバ未起動 = 空集合として扱う。 */
  private async liveSessionNames(): Promise<Set<string>> {
    const args = ["ls", "-F", "#{session_name}"];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      const combined = (result.stdout + result.stderr).toLowerCase();
      if (combined.includes("no server running") || combined.includes("no sessions")) {
        return new Set();
      }
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
    const out = new Set<string>();
    for (const raw of result.stdout.split("\n")) {
      const line = raw.trim();
      if (line.length > 0) out.add(line);
    }
    return out;
  }
}
