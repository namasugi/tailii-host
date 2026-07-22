// herdr.ts
// tailii (TS host) — herdr backend のセッション操作（list / reattach / kill / send / read）。
// TmuxSessionManager と同じ面（SessionBackend）を herdr CLI（socket API のフロント）で実装する。
//
// 実測済みの herdr 0.7.4 挙動（protocol 16）:
// - `agent start <name> --workspace <id> --no-focus -- /bin/zsh -lc '<cmd>'` で pane 起動
// - `pane read --source recent-unwrapped --lines N` は tmux `capture-pane -J -S -N` 相当。
//   ただし出力リングが空の新規 pane では空文字を返すため visible へフォールバックする。
//   `--source visible` は viewport 全行を返し `--lines` を無視する（自前で末尾を切る）。
// - `pane send-keys` は Enter/Escape/Up/Down/Left/Right/Tab/Space/C-x 系のみ受理。
//   BTab（Shift+Tab）は不可 → 生シーケンス ESC [ Z を `pane send-text` で送る（cat -v 検証済み）。
// - `pane process-info` の foreground_processes[0].name が tmux `#{pane_current_command}` 相当。

import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { PROTOCOL_V1, type ControlMessage, type SessionInfo } from "./protocol.js";
import {
  HERDR_PANE_ID_PATTERN,
  SessionMetadataStore,
  validateSessionName,
} from "./sessionMetadataStore.js";
import { paneCommandLooksLikeAgent, type CapturePaneOptions, type ReattachResult } from "./tmux.js";

/** herdr コマンド 1 回分の実行結果。 */
export interface HerdrCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** herdr コマンド実行の注入可能な抽象（テストはモックを注入する）。 */
export type HerdrCommandRunner = (args: string[]) => Promise<HerdrCommandResult>;

/** herdr 実行ファイルの既定絶対パス（SSH exec は非ログインシェルで PATH 外のため絶対指定）。 */
export function defaultHerdrPath(): string {
  return path.join(os.homedir(), ".local", "bin", "herdr");
}

/** Tailii セッション pane を収容する herdr workspace のラベル。 */
export const HERDR_TAILII_WORKSPACE_LABEL = "tailii";

/** 実 herdr を起動する既定ランナー。herdr 非0 exit は throw せず結果で表現する。 */
export function processHerdrCommandRunner(herdrPath: string = defaultHerdrPath()): HerdrCommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(herdrPath, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // 実行ファイル起動自体の失敗（ENOENT 等）のみ throw（tmux ランナーと同じ境界）。
          reject(error);
          return;
        }
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

/** HerdrSessionManager が投げる型付きエラー。 */
export class HerdrFailedError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`herdr ${args.join(" ")} failed (exit ${exitCode}): ${stderr}`);
    this.name = "HerdrFailedError";
  }
}

/** `pane send-keys` が受理する tmux 互換キー名（実測）。それ以外はテキスト送出へ写像する。 */
const HERDR_KEY_NAMES = new Set([
  "Enter",
  "Escape",
  "Up",
  "Down",
  "Left",
  "Right",
  "Tab",
  "Space",
]);

/** Shift+Tab の生シーケンス（herdr send-keys は BTab を受理しないため send-text で送る）。 */
const SHIFT_TAB_SEQUENCE = "\u001b[Z";

/** herdr CLI の JSON stdout から `result` を取り出す。JSON でない/エラー封筒は null。 */
export function parseHerdrResult(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const result = (parsed as Record<string, unknown>)["result"];
    if (typeof result !== "object" || result === null) return null;
    return result as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `pane list` の 1 pane 分。 */
export interface HerdrPane {
  paneId: string;
  label: string | null;
}

/** `pane list` stdout をパースする（形式不明は空配列）。 */
export function parseHerdrPaneList(stdout: string): HerdrPane[] {
  const result = parseHerdrResult(stdout);
  const panes = result?.["panes"];
  if (!Array.isArray(panes)) return [];
  const out: HerdrPane[] = [];
  for (const raw of panes) {
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj["pane_id"] !== "string") continue;
    out.push({
      paneId: obj["pane_id"],
      label: typeof obj["label"] === "string" ? obj["label"] : null,
    });
  }
  return out;
}

/** `workspace list` から label 一致の workspace_id を探す（不在は null）。 */
export function parseHerdrWorkspaceId(stdout: string, label: string): string | null {
  const result = parseHerdrResult(stdout);
  const workspaces = result?.["workspaces"];
  if (!Array.isArray(workspaces)) return null;
  for (const raw of workspaces) {
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (obj["label"] === label && typeof obj["workspace_id"] === "string") {
      return obj["workspace_id"];
    }
  }
  return null;
}

/** `workspace create` stdout から workspace_id を取り出す（失敗は null）。 */
export function parseHerdrCreatedWorkspaceId(stdout: string): string | null {
  const result = parseHerdrResult(stdout);
  const workspace = result?.["workspace"];
  if (typeof workspace !== "object" || workspace === null) return null;
  const id = (workspace as Record<string, unknown>)["workspace_id"];
  return typeof id === "string" ? id : null;
}

/** `agent start` stdout から pane_id を取り出す（失敗は null）。 */
export function parseHerdrStartedPaneId(stdout: string): string | null {
  const result = parseHerdrResult(stdout);
  const agent = result?.["agent"];
  if (typeof agent !== "object" || agent === null) return null;
  const id = (agent as Record<string, unknown>)["pane_id"];
  return typeof id === "string" && HERDR_PANE_ID_PATTERN.test(id) ? id : null;
}

/** `pane process-info` stdout から前面プロセス名を取り出す（判定不能は空文字）。 */
export function parseHerdrForegroundCommand(stdout: string): string {
  const result = parseHerdrResult(stdout);
  const info = result?.["process_info"];
  if (typeof info !== "object" || info === null) return "";
  const list = (info as Record<string, unknown>)["foreground_processes"];
  if (!Array.isArray(list) || list.length === 0) return "";
  const first = list[0];
  if (typeof first !== "object" || first === null) return "";
  const name = (first as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : "";
}

/** herdr backend のセッション list / reattach / kill / send / read とメタデータ統合。 */
export class HerdrSessionManager {
  private readonly runner: HerdrCommandRunner;
  readonly store: SessionMetadataStore;
  private readonly captureLines: number;
  private readonly protocolVersion: number;

  constructor(options: {
    runner?: HerdrCommandRunner;
    store?: SessionMetadataStore;
    captureLines?: number;
    protocolVersion?: number;
  } = {}) {
    this.runner = options.runner ?? processHerdrCommandRunner();
    this.store = options.store ?? new SessionMetadataStore();
    this.captureLines = options.captureLines ?? 50;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_V1;
  }

  /**
   * herdr 担当（メタの backend=herdr）のセッションを name/cwd/alive で列挙する（name 昇順）。
   * tmux 側と異なり herdr pane は名前で自己申告しないため、メタデータが列挙の権威。
   * 生存は「記録済み pane ID が現存」または「pane label が session 名に一致」。
   */
  async list(): Promise<SessionInfo[]> {
    const panes = await this.livePanes();
    const paneIds = new Set(panes.map((pane) => pane.paneId));
    const labels = new Set(panes.map((pane) => pane.label).filter((label) => label !== null));

    const infos: SessionInfo[] = [];
    for (const meta of this.store.all()) {
      if (meta.backend !== "herdr") continue;
      const agent = meta.agent ?? "claude";
      const providerSessionId =
        meta.providerSessionId ?? (agent === "claude" ? meta.claudeSessionId : undefined);
      const alive =
        (meta.herdrPaneId !== undefined && paneIds.has(meta.herdrPaneId)) || labels.has(meta.name);
      infos.push({
        name: meta.name,
        cwd: meta.cwd,
        alive,
        ...(meta.claudeSessionId !== undefined ? { claudeSessionId: meta.claudeSessionId } : {}),
        ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
        ...(providerSessionId !== undefined ? { providerSessionId } : {}),
      });
    }
    return infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 既存セッションへ reattach（生存: attached / 不在: session_not_found エラー封筒）。 */
  async reattach(name: string): Promise<ReattachResult> {
    validateSessionName(name);
    const pane = await this.findPane(name);
    if (pane === null) {
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
    // Claude が終了してシェルだけ残った pane は入力先として無効（tmux backend と同じ判定）。
    // herdr 起動は `zsh -lc '<cmd>'` で claude 終了と同時に pane が閉じるため通常は起きないが、
    // 想定外にシェルへ戻った pane を生存扱いすると --resume が起動しないため安全側で消す。
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

  /** pane 内のエージェント生存判定。herdr エラーや空出力は二重起動を避けて true に倒す。 */
  async agentProcessAlive(name: string): Promise<boolean> {
    validateSessionName(name);
    const target = await this.paneTarget(name);
    if (target === null) return true;
    try {
      const result = await this.runner(["pane", "process-info", "--pane", target]);
      if (result.exitCode !== 0) return true;
      const command = parseHerdrForegroundCommand(result.stdout);
      // zsh -lc 起動の実行中は前面が `zsh` に見える瞬間があるため、空/シェル名のみ死亡扱い。
      return paneCommandLooksLikeAgent(command);
    } catch {
      return true;
    }
  }

  /** 指定セッションの pane のみを閉じる（herdr pane close）。 */
  async kill(name: string): Promise<void> {
    validateSessionName(name);
    const target = await this.paneTarget(name);
    if (target === null) {
      throw new HerdrFailedError(["pane", "close", name], 1, "pane not found");
    }
    const args = ["pane", "close", target];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new HerdrFailedError(args, result.exitCode, result.stderr);
    }
  }

  /**
   * 指定セッションの pane へキー/テキストを送出する。
   * literal はテキスト送出。非 literal は herdr が受理するキー名のみ send-keys、
   * BTab は生 Shift+Tab シーケンス、その他（数字キー等）はテキストとして送る。
   */
  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    validateSessionName(name);
    if (keys.length === 0) return;
    const target = await this.paneTarget(name);
    if (target === null) {
      throw new HerdrFailedError(["pane", "send-keys", name], 1, "pane not found");
    }
    for (const key of keys) {
      let args: string[];
      if (literal) {
        args = ["pane", "send-text", target, key];
      } else if (key === "BTab") {
        args = ["pane", "send-text", target, SHIFT_TAB_SEQUENCE];
      } else if (HERDR_KEY_NAMES.has(key) || /^C-[a-z]$/.test(key)) {
        args = ["pane", "send-keys", target, key];
      } else {
        args = ["pane", "send-text", target, key];
      }
      const result = await this.runner(args);
      if (result.exitCode !== 0) {
        throw new HerdrFailedError(args, result.exitCode, result.stderr);
      }
    }
  }

  /**
   * pane 末尾 N 行を返す（tmux capture-pane 相当。末尾空行は削る）。
   * joinWrappedLines は herdr の recent-unwrapped（折返し結合済み出力リング）を使い、
   * リング未充填の新規 pane では visible（viewport 全行）へフォールバックする。
   */
  async capturePane(name: string, options: CapturePaneOptions = {}): Promise<string> {
    validateSessionName(name);
    const target = await this.paneTarget(name);
    if (target === null) {
      throw new HerdrFailedError(["pane", "read", name], 1, "pane not found");
    }
    const lines = options.lines ?? this.captureLines;
    if (options.joinWrappedLines ?? false) {
      const joined = await this.readPane(target, ["--source", "recent-unwrapped", "--lines", `${lines}`]);
      if (joined.length > 0) return joined;
    }
    const visible = await this.readPane(target, ["--source", "visible"]);
    const all = visible.split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  }

  private async readPane(target: string, sourceArgs: string[]): Promise<string> {
    const args = ["pane", "read", target, ...sourceArgs];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new HerdrFailedError(args, result.exitCode, result.stderr);
    }
    const lines = result.stdout.split("\n");
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /** 生存 pane の一覧。herdr server 未起動などの失敗は空集合として扱う（tmux `ls` と同じ流儀）。 */
  private async livePanes(): Promise<HerdrPane[]> {
    try {
      const result = await this.runner(["pane", "list"]);
      if (result.exitCode !== 0) return [];
      return parseHerdrPaneList(result.stdout);
    } catch {
      return [];
    }
  }

  /** セッション名の現存 pane を解決する（記録済み pane ID 優先、無ければ label 一致）。 */
  private async findPane(name: string): Promise<HerdrPane | null> {
    const panes = await this.livePanes();
    const recorded = this.store.get(name)?.herdrPaneId;
    if (recorded !== undefined) {
      const byId = panes.find((pane) => pane.paneId === recorded);
      if (byId !== undefined) return byId;
    }
    return panes.find((pane) => pane.label === name) ?? null;
  }

  /** 入出力 target の pane ID（現存しなければ null）。 */
  private async paneTarget(name: string): Promise<string | null> {
    return (await this.findPane(name))?.paneId ?? null;
  }
}
