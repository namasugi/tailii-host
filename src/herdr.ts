// herdr.ts
// tailii (TS host) — herdr backend のセッション操作（list / reattach / kill / send / read）。
// TmuxSessionManager と同じ面（SessionBackend）を herdr CLI（socket API のフロント）で実装する。
//
// 実測済みの herdr 0.7.4 挙動（protocol 16。設計正本は docs/herdr-backend.md）:
// - 全 pane は専用 named session `tailii` に収容（全コマンドに `--session tailii` 前置）。
//   `agent start <name> --no-focus -- /bin/zsh -lc '<cmd>'` で pane 起動 → session 名タブへ分離。
// - `pane read --source recent-unwrapped --lines N` は tmux `capture-pane -J -S -N` 相当。
//   ただし出力リングが空の新規 pane では空文字を返すため visible へフォールバックする。
//   `--source visible` は viewport 全行を返し `--lines` を無視する（自前で末尾を切る）。
// - `pane send-keys` は Escape/Up/Down/Left/Right/Tab/Space/C-x 系のみ実用。
//   Enter は claude TUI(Ink) が submit と認識しないため生 CR を `send-text` で送る。
//   BTab（Shift+Tab）は不可 → 生シーケンス ESC [ Z を `pane send-text` で送る（cat -v 検証済み）。
// - `pane process-info` の foreground_processes[0].name が tmux `#{pane_current_command}` 相当。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
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

/**
 * Tailii セッション pane を収容する herdr named session。
 * ユーザーの default セッション（普段使いの herdr）を汚さないよう、Tailii は専用の
 * named session（別サーバー・別ソケット `~/.config/herdr/sessions/tailii/`）に全 pane を
 * 収容する。CLI は全操作に `--session tailii` を前置する（runner レベルで一元付与）。
 * まとめて消すときは `herdr session stop tailii` → `herdr session delete tailii`。
 */
export const HERDR_TAILII_SESSION = "tailii";

/** herdr が導入済みか（backend_get の可用性表示・backend_set の検証に使う）。 */
export function herdrInstalled(herdrPath: string = defaultHerdrPath()): boolean {
  try {
    fs.accessSync(herdrPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 実 herdr を起動する既定ランナー。herdr 非0 exit は throw せず結果で表現する。
 * `sessionName`（既定 tailii）を `--session` として全コマンドに前置する。
 */
export function processHerdrCommandRunner(
  herdrPath: string = defaultHerdrPath(),
  sessionName: string = HERDR_TAILII_SESSION,
): HerdrCommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        herdrPath,
        ["--session", sessionName, ...args],
        { maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
            // 実行ファイル起動自体の失敗（ENOENT 等）のみ throw（tmux ランナーと同じ境界）。
            reject(error);
            return;
          }
          const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
        },
      );
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

/**
 * Enter の生シーケンス（CR）。herdr の `send-keys Enter` は zsh 等の行編集では確定として
 * 効くが、claude TUI(Ink) は submit と認識しない（実測 2026-07-22: 注入本文が入力欄に
 * 残ったまま新規会話が始まらない）。Ink の return 判定は CR そのものを要求するため
 * `send-text` で生 `\r` を送る。
 */
const ENTER_SEQUENCE = "\r";

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

/** `agent get` stdout から agent_status を取り出す（判定不能は null）。 */
export function parseHerdrAgentStatus(stdout: string): string | null {
  const result = parseHerdrResult(stdout);
  const agent = result?.["agent"];
  if (typeof agent !== "object" || agent === null) return null;
  const status = (agent as Record<string, unknown>)["agent_status"];
  return typeof status === "string" ? status : null;
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
  /** sendTextSubmit の本文→CR 間隔 ms（実測 300ms 未満で CR が飲まれる。テスト注入用）。 */
  private readonly submitDelayMs: number;
  /** sendTextSubmit の CR→残留確認 間隔 ms（テスト注入用）。 */
  private readonly submitVerifyDelayMs: number;
  /** 注入前の claude 検出待ちの上限/間隔 ms（テスト注入用）。 */
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;

  constructor(options: {
    runner?: HerdrCommandRunner;
    store?: SessionMetadataStore;
    captureLines?: number;
    protocolVersion?: number;
    submitDelayMs?: number;
    submitVerifyDelayMs?: number;
    readyTimeoutMs?: number;
    readyPollMs?: number;
  } = {}) {
    this.runner = options.runner ?? processHerdrCommandRunner();
    this.store = options.store ?? new SessionMetadataStore();
    this.captureLines = options.captureLines ?? 50;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_V1;
    this.submitDelayMs = options.submitDelayMs ?? 600;
    this.submitVerifyDelayMs = options.submitVerifyDelayMs ?? 700;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.readyPollMs = options.readyPollMs ?? 300;
  }

  /**
   * herdr 担当（メタの backend=herdr）のセッションを name/cwd/alive で列挙する（name 昇順）。
   * tmux 側と異なり herdr pane は名前で自己申告しないため、メタデータが列挙の権威。
   * 生存は「記録済み pane ID が現存」または「pane label が session 名に一致」。
   */
  async list(): Promise<SessionInfo[]> {
    // herdr メタが皆無なら CLI を呼ばない（常時 Composite 構成でも純 tmux 環境に副作用ゼロ）。
    if (!this.store.all().some((meta) => meta.backend === "herdr")) return [];
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
        backend: "herdr",
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
    return { kind: "attached", info: { name, cwd, alive: true, backend: "herdr" }, recentOutput: recent };
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
   * 本文入力と送信確定を 1 操作で行う（chat 注入・kick 用, SessionBackend 共通面）。
   * 実測（2026-07-22, jsonl を ground truth に検証）:
   * - 本文+CR の単一 send-text は不成立（ペースト末尾の改行として除去され本文が残る）
   * - 分割送信でも claude TUI ブート直後は 600ms 間隔の CR すら飲まれる
   *   （アイドル時は 300ms 以上で成立。遅れて送る単発 CR は常に成立）
   * よって「本文 → CR → 入力欄を読んで残留確認 → 残っていれば CR 再送」の確認つき
   * リトライで確定させる。submit 済みの空入力への Enter は no-op なので二重送信は起きない。
   */
  async sendTextSubmit(name: string, text: string): Promise<void> {
    // ブート直後の注入は本文ごと TUI 初期化に破棄され得る（実測: 入力欄にも jsonl にも
    // 残らない）。herdr の claude 検出（agent_status が unknown を抜けるまで）を注入の
    // 準備完了ゲートにする。working（処理中の queue 入力）も注入可。判定不能は fail-open。
    await this.waitForAgentReady(name);
    await this.sendKeys(name, [text], true);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
      await this.sendKeys(name, ["Enter"]);
      await new Promise((resolve) => setTimeout(resolve, this.submitVerifyDelayMs));
      if (!(await this.inputBoxHasPendingText(name))) return;
    }
  }

  /** claude TUI の入力準備完了（herdr の agent 検出が unknown を抜ける）を待つ。 */
  private async waitForAgentReady(name: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        const result = await this.runner(["agent", "get", name]);
        if (result.exitCode === 0) {
          const status = parseHerdrAgentStatus(result.stdout);
          if (status !== null && status !== "unknown") return;
        }
      } catch {
        return; // herdr 不在等は fail-open（呼び出し側の送出エラーで顕在化させる）
      }
      if (Date.now() > deadline) return; // タイムアウトも fail-open
      await new Promise((resolve) => setTimeout(resolve, this.readyPollMs));
    }
  }

  /**
   * claude TUI の入力欄（画面末尾側の `❯` 行）に未送信テキストが残っているか。
   * 送信済みメッセージのエコーも `❯` で始まるため、**最後の** `❯` 行だけを見る。
   * 判定不能（読取失敗・`❯` 行なし）は false = 送信成立扱い（fail-open。
   * 誤リトライしても空入力 Enter の no-op で無害だが、無限再送はしない側に倒す）。
   */
  private async inputBoxHasPendingText(name: string): Promise<boolean> {
    try {
      const screen = await this.capturePane(name, { lines: 30 });
      const promptLines = screen
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("❯"));
      const last = promptLines[promptLines.length - 1];
      return last !== undefined && last.slice(1).trim().length > 0;
    } catch {
      return false;
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
      } else if (key === "Enter") {
        // Ink(claude TUI) の submit は CR 必須（send-keys Enter は不認識。上記実測）。
        args = ["pane", "send-text", target, ENTER_SEQUENCE];
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

  /**
   * tailii セッションの server を pane ゼロのときだけ停止する（reaper の空サーバー回収）。
   * tmux server の「セッションゼロで自動終了」に対応する挙動。launch 側に ensure（不在なら
   * detached 起動）があるため、停止しても次のセッション起動で自動復帰する。
   * ユーザーが tailii セッション内に手動 pane を作っていた場合は停止しない（pane 総数で判定）。
   */
  async stopServerIfEmpty(): Promise<void> {
    try {
      const result = await this.runner(["pane", "list"]);
      if (result.exitCode !== 0) return; // server 不在/不通 = 何もしない
      if (parseHerdrPaneList(result.stdout).length > 0) return;
      await this.runner(["server", "stop"]);
    } catch {
      // ENOENT 等（未導入環境）は無視。
    }
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
