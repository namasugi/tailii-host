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
    const metas = this.store.all();

    const cwdByName = new Map<string, string>();
    const claudeSessionIdByName = new Map<string, string>();
    for (const meta of metas) {
      cwdByName.set(meta.name, meta.cwd);
      if (meta.claudeSessionId !== undefined) claudeSessionIdByName.set(meta.name, meta.claudeSessionId);
    }

    const names = new Set<string>(alive);
    for (const meta of metas) names.add(meta.name);

    const infos: SessionInfo[] = [...names].map((name) => ({
      name,
      cwd: cwdByName.get(name) ?? "",
      alive: alive.has(name),
      ...(claudeSessionIdByName.has(name) ? { claudeSessionId: claudeSessionIdByName.get(name)! } : {}),
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
    const cwd = this.store.get(name)?.cwd ?? "";
    const recent = await this.capturePane(name);
    return { kind: "attached", info: { name, cwd, alive: true }, recentOutput: recent };
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

  /** 指定セッションの pane へ tmux send-keys を発行する（literal は -l）。 */
  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    validateSessionName(name);
    if (keys.length === 0) return;
    const args = ["send-keys", "-t", name];
    if (literal) args.push("-l");
    args.push(...keys);
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new TmuxFailedError(args, result.exitCode, result.stderr);
    }
  }

  /** `capture-pane -p -t <name> -S -<N>` で末尾 N 行のペイン内容を返す（末尾空行は削る）。 */
  async capturePane(name: string): Promise<string> {
    const args = ["capture-pane", "-p", "-t", name, "-S", `-${this.captureLines}`];
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
