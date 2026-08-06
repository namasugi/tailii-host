// herdr.ts
// tailii (TS host) — herdr backend のセッション操作（list / reattach / kill / send / read）。
// TmuxSessionManager と同じ面（SessionBackend）を herdr CLI（socket API のフロント）で実装する。
//
// 実測済みの herdr 0.7.5 挙動（設計正本は docs/herdr-backend.md）:
// - 全 pane は専用 named session `tailii` に収容（全コマンドに `--session tailii` 前置）。
//   起動は `tab create --cwd --env --no-focus`（root_pane.pane_id が新 pane）→ `pane rename`
//   → `pane run <id> "exec /bin/zsh -lc '<cmd>'"`。0.7.5 で `agent start` から pane 生成
//   /cwd/env 指定が廃止されたため（旧: agent start 一発で pane 起動）。
//   `pane run` はタイプ注入で argv のクォートを保持しない → コマンドは単一文字列で渡す。
//   exec 前置によりコマンド終了と同時に pane が閉じる（旧 agent start と同義・stale shell なし）。
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
import { PROTOCOL_V1, type ControlMessage, type SessionInfo } from "../protocol.js";
import {
  HERDR_PANE_ID_PATTERN,
  SessionMetadataStore,
  validateSessionName,
} from "../sessions/sessionMetadataStore.js";
import {
  extractClaudeInputBox,
  inputBoxIsShellMode,
  paneCommandLooksLikeAgent,
  type CapturePaneOptions,
  type ClaudeInputBox,
  type ReattachResult,
} from "./tmux.js";

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
  // シェルモード離脱（空入力の `!` を消す）に使う。テキスト送出へ落ちると
  // 「Backspace」の 9 文字がそのまま入力欄へ打ち込まれるので必ずキー名で送る。
  "Backspace",
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
/**
 * Ctrl-U（kill-line）の生制御文字。herdr の send-keys は `C-u` をキー名として
 * 受け付けない（実測: unsupported key）ため、Enter(CR) と同じく send-text で流す。
 * claude TUI では「行末尾のテキスト → その改行」の順に消える（実測 2.1.220:
 * `AAA\nBBB\nCCC` へ C-u 連打で CCC→改行→BBB→…と 2N-1 回で必ず空になる。
 * 空 composer への C-u は完全に no-op で、処理中の agent にも干渉しない）。
 */
const KILL_LINE_SEQUENCE = "\u0015";

/**
 * 画面に選択ダイアログのフッター行があるか。チャット本文が「Enter to select」を
 * 引用しただけの偽陽性（誤 Esc・再送スキップの実害）を避けるため、substring では
 * なく trim 後にフッター文言で始まる行だけをダイアログとみなす。
 */
export function screenHasSelectionFooter(screen: string): boolean {
  return screen
    .split("\n")
    .some((line) => line.trim().startsWith("Enter to select"));
}

/**
 * 入力反映検証に使う probe（本文の**末尾側**）。検証不能な本文（空など）は null。
 *
 * 末尾側なのは composer の表示特性のため: 入力が表示高を超えると composer は下へ
 * スクロールし**先頭行が窓外へ消える**（実測 2.1.220: 10行ペーストで先頭4行が
 * capture から消失）。カーソルは常に末尾にあるので、末尾側の probe だけが
 * 「見えている範囲」との照合を保証できる（先頭24字の旧 probe は多行/長文で
 * 構造的に偽陰性 → 再投入 → 本文二重化の温床だった）。
 *
 * 先頭 `!`（シェルモード）は claude TUI がモード記号として吸い上げ、入力欄本文には
 * 残らない（`!ls -la` は `! ls -la` と描画される）。単一行本文では照合キーからも
 * 落とさないと末尾24字に `!` が含まれるとき反映検証が失敗する。
 */
export function typedTextProbe(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) return null;
  const body =
    lines.length === 1 && lastLine.startsWith("!") ? lastLine.slice(1).trim() : lastLine;
  if (body.length === 0) return null;
  return body.slice(-24);
}

/**
 * 入力欄テキストに probe が反映されているか（折り返し非依存）。
 * extractClaudeInputBox は表示行を trim + "\n" 連結で返すため、probe が入力欄の
 * 行折り返しをまたぐと生の includes は絶対に一致しない（全角24字=48桁 > 内幅で必発）。
 * この偽陰性が「反映済み本文の再投入 = 初回送信の本文二重化」の根因だった（実機5件）。
 * 空白類（折り返しの改行・trim 痕・全角空白含む）を両辺から除去して照合する。
 */
export function inputBoxTextIncludesProbe(boxText: string, probe: string): boolean {
  const strip = (value: string): string => value.replace(/\s+/g, "");
  const needle = strip(probe);
  if (needle.length === 0) return false;
  return strip(boxText).includes(needle);
}

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
  /** pane を収容するタブ ID（タブラベル書換=session-title に使う。旧形式は null）。 */
  tabId: string | null;
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
      tabId: typeof obj["tab_id"] === "string" ? obj["tab_id"] : null,
    });
  }
  return out;
}

/**
 * herdr 0.7.5 の `tab create` が自動付与する既定タブラベル（連番文字列 "1"/"2"…）か。
 * 既定ラベルは「未命名」として扱う: hub tick の自動タイトルは上書きしてよく、
 * 逆方向同期（displayTitle）は人為リネームと誤認して会話タイトルへ取り込んではならない。
 */
export function isDefaultHerdrTabLabel(label: string): boolean {
  return /^\d+$/.test(label);
}

/** `tab list` stdout を tab_id → label のマップにパースする（形式不明は空マップ）。 */
export function parseHerdrTabLabels(stdout: string): Map<string, string> {
  const result = parseHerdrResult(stdout);
  const tabs = result?.["tabs"];
  const out = new Map<string, string>();
  if (!Array.isArray(tabs)) return out;
  for (const raw of tabs) {
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj["tab_id"] === "string" && typeof obj["label"] === "string") {
      out.set(obj["tab_id"], obj["label"]);
    }
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

/** `tab create` stdout から root pane の pane_id を取り出す（失敗は null）。 */
export function parseHerdrCreatedTabPaneId(stdout: string): string | null {
  const result = parseHerdrResult(stdout);
  const rootPane = result?.["root_pane"];
  if (typeof rootPane !== "object" || rootPane === null) return null;
  const id = (rootPane as Record<string, unknown>)["pane_id"];
  return typeof id === "string" && HERDR_PANE_ID_PATTERN.test(id) ? id : null;
}

/**
 * `pane get` stdout から agent_status を取り出す（判定不能は null）。
 * 0.7.5 では `agent get <name>` が使えない（agent レジストリは herdr の自動検出のみで
 * Tailii のセッション名を知らず agent_not_found になる）ため、pane 単位の status を読む。
 */
export function parseHerdrPaneAgentStatus(stdout: string): string | null {
  const result = parseHerdrResult(stdout);
  const pane = result?.["pane"];
  if (typeof pane !== "object" || pane === null) return null;
  const status = (pane as Record<string, unknown>)["agent_status"];
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
  /** 入力欄へ本文が反映されなかったときの再投入間隔 ms（RC 切断 limbo 対策）。 */
  private readonly inputRetryDelayMs: number;
  /** clearInputBox の C-u 1回ごとの反映待ち ms（実測レイテンシ 9〜27ms。テスト注入用）。 */
  private readonly clearKeyDelayMs: number;
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
    inputRetryDelayMs?: number;
    clearKeyDelayMs?: number;
    readyTimeoutMs?: number;
    readyPollMs?: number;
  } = {}) {
    this.runner = options.runner ?? processHerdrCommandRunner();
    this.store = options.store ?? new SessionMetadataStore();
    this.captureLines = options.captureLines ?? 50;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_V1;
    this.submitDelayMs = options.submitDelayMs ?? 600;
    this.submitVerifyDelayMs = options.submitVerifyDelayMs ?? 700;
    this.inputRetryDelayMs = options.inputRetryDelayMs ?? 1_500;
    this.clearKeyDelayMs = options.clearKeyDelayMs ?? 150;
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
    // タブラベル（Mac 側リネーム含む会話タイトル表示）を name→label で引けるようにする
    // （session-title 逆方向同期: セッション名と異なるラベルを displayTitle として載せる）。
    const tabLabels = await this.tabLabels();

    const infos: SessionInfo[] = [];
    for (const meta of this.store.all()) {
      if (meta.backend !== "herdr") continue;
      const agent = meta.agent ?? "claude";
      const providerSessionId =
        meta.providerSessionId ?? (agent === "claude" ? meta.claudeSessionId : undefined);
      const alive =
        (meta.herdrPaneId !== undefined && paneIds.has(meta.herdrPaneId)) || labels.has(meta.name);
      const pane =
        (meta.herdrPaneId !== undefined
          ? panes.find((candidate) => candidate.paneId === meta.herdrPaneId)
          : undefined) ?? panes.find((candidate) => candidate.label === meta.name);
      const tabLabel = pane?.tabId != null ? tabLabels.get(pane.tabId) : undefined;
      // 自動適用ラベル（hub tick が書いた値 = meta.autoTabTitle）と既定連番は人為リネーム
      // ではないため displayTitle に載せない（iOS が override として誤取り込みしないため）。
      const displayTitle =
        alive && tabLabel !== undefined && tabLabel !== meta.name && tabLabel.length > 0 &&
        !isDefaultHerdrTabLabel(tabLabel) && tabLabel !== meta.autoTabTitle
          ? tabLabel
          : undefined;
      infos.push({
        name: meta.name,
        cwd: meta.cwd,
        alive,
        backend: "herdr",
        ...(meta.claudeSessionId !== undefined ? { claudeSessionId: meta.claudeSessionId } : {}),
        ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
        ...(providerSessionId !== undefined ? { providerSessionId } : {}),
        ...(displayTitle !== undefined ? { displayTitle } : {}),
      });
    }
    return infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * 生存 pane の session 名 → { tabId, tabLabel } を返す（session-title の自動タイトル同期用）。
   * pane label（= セッション解決の権威）が無い pane・タブ不明の pane は含めない。
   */
  async tabInfoByName(): Promise<Map<string, { tabId: string; label: string | null }>> {
    const panes = await this.livePanes();
    const tabs = await this.tabLabels();
    const out = new Map<string, { tabId: string; label: string | null }>();
    for (const pane of panes) {
      if (pane.label === null || pane.tabId === null) continue;
      out.set(pane.label, { tabId: pane.tabId, label: tabs.get(pane.tabId) ?? null });
    }
    return out;
  }

  /** `tab list` を tab_id → label で読む（失敗は空マップ = displayTitle 無しに倒す）。 */
  private async tabLabels(): Promise<Map<string, string>> {
    try {
      const result = await this.runner(["tab", "list"]);
      if (result.exitCode !== 0) return new Map();
      return parseHerdrTabLabels(result.stdout);
    } catch {
      return new Map();
    }
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

  /**
   * 会話カスタムタイトルの端末表示追随（session-title）: pane を収容するタブのラベルを
   * 書き換える（`tab rename`）。pane の label はセッション解決の権威（findPane の
   * fallback / list の生存判定）なので触らない。title 空/null は解除=セッション名へ戻す
   * （未命名扱いになり hub tick の自動タイトルが再適用される）。
   */
  async setDisplayTitle(name: string, title: string | null): Promise<void> {
    validateSessionName(name);
    const pane = await this.findPane(name);
    if (pane === null) {
      throw new HerdrFailedError(["tab", "rename", name], 1, "pane not found");
    }
    if (pane.tabId === null) {
      throw new HerdrFailedError(["tab", "rename", name], 1, "tab id unavailable");
    }
    const trimmed = title?.trim() ?? "";
    const label = trimmed.length > 0 ? trimmed : name;
    const args = ["tab", "rename", pane.tabId, label];
    const result = await this.runner(args);
    if (result.exitCode !== 0) {
      throw new HerdrFailedError(args, result.exitCode, result.stderr);
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
    // 選択ダイアログ（/remote-control 等）が開いたままだと本文がダイアログに食われる。
    // 注入前に Esc で閉じてから入力欄へ流す（Mac 側で手動 Esc するのと同じ操作）。
    if (await this.selectionDialogVisible(name)) {
      await this.sendKeys(name, ["Escape"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // 中断（停止）直後は claude が queued メッセージを入力欄へ書き戻す。残存したまま
    // 注入すると今回の本文がその後ろへ連結され 1 メッセージとして送信される（実機FB
    // 2026-07-29: 停止→送信で「前回本文+今回本文」の連結バブルが二重表示）。残存は先に
    // Enter で独立メッセージとして送信し切ってから注入する（アプリの楽観バブルとも一致
    // する）。空入力への Enter は no-op なので、誤検出しても無害。
    if (await this.inputBoxHasPendingText(name)) {
      await this.sendKeys(name, ["Enter"]);
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
    }
    // 前回の注入が途中で終わった等でシェルモード（プロンプト `!`）に入ったままの入力欄へ
    // 注入すると、本文がそのままシェルコマンドとして実行される。空入力の Backspace で
    // モード記号を消して通常入力へ戻してから注入する（`!` 始まりの本文は注入時に自分で
    // シェルモードへ入るので、常に通常モードから始めるのが決定的で安全）。
    await this.exitShellMode(name);
    // Remote Control 切断直後の limbo では typed 入力が入力欄に一切入らず破棄される
    // （実測 2026-07-28: 通常メッセージが本文ごと消失し、旧実装は「入力欄に残っていない
    // = 送信成立」と誤判定して配送済みレシートを発行 → silent loss）。本文が入力欄へ
    // 反映されたことを検証し、反映されなければ間隔を置いて再投入、最終的に throw して
    // chat_send を uncertain（アプリの明示再送）へ倒す。
    const probe = typedTextProbe(text);
    let typed = probe === null;
    for (let attempt = 0; attempt < 3 && !typed; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.inputRetryDelayMs));
        // 反映検証の偽陰性時にクリアせず再投入すると、前回分と連結され 1 メッセージの
        // 本文が二重になる（初回送信の本文二重化・実機5件）。再投入前に必ず入力欄を
        // 空にし、空にできたと確信できなければ再投入を諦めて throw（明示再送）へ倒す。
        if (!(await this.clearInputBox(name))) break;
        // クリアがシェルモード記号だけを残すことがある（実測: `!echo ...` へ C-u 1回で
        // `!` プロンプトの空入力になる）。常に通常モードから再投入する既存方針に合わせる。
        await this.exitShellMode(name);
      }
      await this.sendKeys(name, [text], true);
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
      if (await this.inputBoxContainsText(name, probe as string)) {
        typed = true;
        break;
      }
      // 描画遅延での誤判定 → 再投入で本文が二重になるのを避けるため、少し待って再確認。
      await new Promise((resolve) => setTimeout(resolve, this.submitVerifyDelayMs));
      if (await this.inputBoxContainsText(name, probe as string)) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      // 残骸（自分の投入分）を残したまま throw すると、アプリの明示再送時に冒頭の
      // Enter flush が残骸を独立メッセージとして送ってしまう（幽霊バブル）。
      // best-effort で掃除してから throw する（掃除できない場合もそのまま throw）。
      await this.clearInputBox(name);
      throw new HerdrFailedError(
        ["pane", "send-text", name],
        1,
        "typed text did not reach the input box (RC limbo / ダイアログ表示中 / 入力欄不可視のいずれか)",
      );
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
      await this.sendKeys(name, ["Enter"]);
      await new Promise((resolve) => setTimeout(resolve, this.submitVerifyDelayMs));
      // 送出した本文が選択ダイアログを開いた場合（RC active 中の /remote-control 等）、
      // ダイアログのカーソル行（❯ Continue）を未送信テキストと誤認して Enter を再送すると
      // 選択肢を誤操作してダイアログを閉じてしまう（実障害: 転写カードが一瞬で消える）。
      // ダイアログ表示中は送信成立として扱い、以降の操作は転写カード側に任せる。
      if (await this.selectionDialogVisible(name)) return;
      if (!(await this.inputBoxHasPendingText(name))) return;
    }
  }

  /**
   * 入力欄に probe テキストが反映されているか。
   * ペイン履歴の同文エコー（同一メッセージの再送時など）を誤って「入力済み」と
   * 判定しないよう、走査範囲を入力欄（末尾の罫線に挟まれた領域）に限定する。
   * 判定不能は false。
   */
  private async inputBoxContainsText(name: string, probe: string): Promise<boolean> {
    try {
      const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
      return box !== null && inputBoxTextIncludesProbe(box.text, probe);
    } catch {
      return false;
    }
  }

  /**
   * 入力欄を空にする（反映検証が偽陰性だったときの再投入前クリア／throw 前の残骸掃除）。
   * C-u(kill-line) のみを繰り返す（実測: 2N-1 回で必ず空になる。Backspace は本文の
   * 実文字を削るため使わない）。空にできたら true。次の場合は false を返し、呼び出し側は
   * 再投入を諦める:
   * - 選択/承認ダイアログ表示中（本文側の罫線を入力欄と誤認して C-u を撃ち込むと
   *   既存の誤 Esc/誤 Continue と同型の実害になるため、書き込み自体をしない）
   * - 入力欄が見えない（罫線が窓外・描画崩れ・capture 失敗）
   * - 上限回数で空にならない（1回150ms×15回=2.25s。iOS の chat_send ACK 予算 18s の
   *   内側で速やかに諦めて明示再送へ倒す）
   *
   * トレードオフ（意図的な設計判断）: 中断直後に claude が queued 本文を composer へ
   * 書き戻すタイミングと重なると、そのテキストも C-u で消える（receipt なしの破棄）。
   * 再投入前クリアを省くと「本文二重化」という別のデータ破損になるため、注入経路では
   * 「重複より欠落」を選ぶ（残存の主経路は sendTextSubmit 冒頭の Enter flush が先に守る）。
   */
  private async clearInputBox(name: string): Promise<boolean> {
    try {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        // ダイアログ判定は selectionDialogVisible（末尾30行窓）に揃える。全画面を
        // 走査すると、チャット本文に残る閉じたダイアログの転写（「Enter to select」行）を
        // 誤検出して、クリアできる場面でも常に諦めてしまう（08-03 の窓設計と同じ理由）。
        if (await this.selectionDialogVisible(name)) return false;
        const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
        if (box === null) return false;
        if (box.text.replace(/\s+/g, "").length === 0) return true;
        await this.sendKeys(name, [KILL_LINE_SEQUENCE], true);
        await new Promise((resolve) => setTimeout(resolve, this.clearKeyDelayMs));
      }
      // 上限到達時も最後の C-u の結果は未観測なので、最終状態を見てから判定する。
      const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
      return box !== null && box.text.replace(/\s+/g, "").length === 0;
    } catch {
      return false;
    }
  }

  /**
   * 入力欄がシェルモード（プロンプト `!`）なら Backspace でモード記号を消し、通常入力へ戻す。
   * 本文が残っている状態では呼ばない（呼び出し元が Enter で送信し切ってから使う）。
   *
   * 判定不能・herdr エラーは no-op（fail-open）。pane 不在などの実エラーはここで throw せず、
   * 続く本文注入の `send-text` 失敗として顕在化させる（この補助操作のエラーを表に出すと
   * 「送信できない」原因が Backspace 送出の失敗に見えてしまう）。
   */
  private async exitShellMode(name: string): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
        if (!inputBoxIsShellMode(box) || (box?.text.length ?? 0) > 0) return;
        await this.sendKeys(name, ["Backspace"]);
        await new Promise((resolve) => setTimeout(resolve, this.submitVerifyDelayMs));
      }
    } catch {
      // no-op（fail-open）
    }
  }

  /**
   * claude TUI の選択ダイアログ（`Enter to select` フッター）が表示中か。判定不能は false。
   *
   * 窓は入力欄判定より狭い 30 行に据え置く（ダイアログのフッターは画面最下部にあるので
   * 広げる必要が無い一方、閉じたダイアログの転写が viewport に残っていると誤検出し、
   * 不要な Esc で入力欄の打ちかけを「送信されないまま」消してしまう）。
   */
  private async selectionDialogVisible(name: string): Promise<boolean> {
    try {
      return screenHasSelectionFooter(await this.capturePane(name, { lines: 30 }));
    } catch {
      return false;
    }
  }

  /**
   * claude TUI の入力準備完了（herdr の agent 検出が unknown を抜ける）を待つ。
   * 0.7.5 で `agent get <name>` は常に agent_not_found（レジストリが herdr 自動検出のみで
   * セッション名を知らない）になり、旧実装は毎送信 10s のタイムアウト空回りになっていた
   * （実機FB 2026-07-30: 送信後の pending / ライブビュー点灯が遅い）。pane を解決して
   * `pane get` の agent_status を読む。pane 不在は即 fail-open（後続 sendKeys が
   * pane not found で正しく失敗する）。
   */
  private async waitForAgentReady(name: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        const target = await this.paneTarget(name);
        if (target === null) return;
        const result = await this.runner(["pane", "get", target]);
        if (result.exitCode === 0) {
          const status = parseHerdrPaneAgentStatus(result.stdout);
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
   * claude TUI の入力欄に未送信テキストが残っているか。
   * 送信済みメッセージのエコーも `❯` で始まるため、入力欄（末尾の罫線に挟まれた領域）
   * だけを見る。判定不能（読取失敗・入力欄を特定できない）は false = 送信成立扱い
   * （fail-open。誤リトライしても空入力 Enter の no-op で無害だが、無限再送はしない側に倒す）。
   */
  private async inputBoxHasPendingText(name: string): Promise<boolean> {
    try {
      const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
      return box !== null && box.text.length > 0;
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

  /**
   * 入力欄判定用に **viewport 全体**を取る（末尾 N 行で切らない）。
   *
   * claude TUI の入力欄の最大高さは端末サイズにほぼ比例する（実測 2.1.220:
   * 63 行端末で 26 行 / 120 行端末で 55 行）。固定行数の窓では大きな端末で上罫線が
   * 窓外に出て入力欄を見失い、本文を 3 回重ね打ちして送信失敗する。窓を広く取っても
   * `extractClaudeInputBox` は罫線で入力欄を切り出すので過検出にはならない。
   * `--source visible` は viewport 全行を返す（`--lines` は無視される）。
   */
  private async captureVisibleScreen(name: string): Promise<string> {
    validateSessionName(name);
    const target = await this.paneTarget(name);
    if (target === null) {
      throw new HerdrFailedError(["pane", "read", name], 1, "pane not found");
    }
    return this.readPane(target, ["--source", "visible"]);
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
