// tmux.ts
// tailii (TS host) — tmux セッションの list / reattach / kill / send-keys / capture-pane
// Swift 版 TmuxSessionManager.swift の移植。
// 生存集合は `tmux ls -F '#{session_name}'`、cwd は SessionMetadataStore を権威とする。

import { execFile } from "node:child_process";
import { PROTOCOL_V1, type ControlMessage, type SessionInfo } from "../protocol.js";
import { SessionMetadataStore, validateSessionName } from "../sessions/sessionMetadataStore.js";

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

/**
 * claude TUI 入力欄の先頭に付くモード記号。
 * - `❯`(276F) / `›`(203A): 通常入力
 * - `!`: シェルモード（空入力の先頭 `!` が記号として吸われ、本文には残らない）
 *
 * 実測 2.1.220: `#` はモード記号ではなく本文の一部（`❯ #メモ` と描画される）。
 */
const INPUT_PROMPT_SIGILS = ["❯", "›", "!"] as const;

/** claude TUI 入力欄の状態（プロンプト記号と未送信本文）。 */
export interface ClaudeInputBox {
  /** 先頭のモード記号。記号なしで本文だけの行なら空文字。 */
  prompt: string;
  /** 未送信本文（記号と前後空白を除いたもの）。空なら入力欄は空。 */
  text: string;
}

/** 入力欄がシェルモード（プロンプトが `!`）か。 */
export function inputBoxIsShellMode(box: ClaudeInputBox | null): boolean {
  return box?.prompt === "!";
}

/** 行が入力欄の水平罫線（`────…`）か。名前付き会話は上罫線中央にタイトルが埋まる。 */
function isInputBoxRuleLine(line: string): boolean {
  const scalars = [...line];
  if (scalars.length < 3) return false;
  let leading = 0;
  for (const ch of scalars) {
    if (ch === "─" || ch === "━") leading += 1;
    else break;
  }
  if (leading === scalars.length) return true;
  if (leading < 3) return false;
  let trailing = 0;
  for (const ch of [...scalars].reverse()) {
    if (ch === "─" || ch === "━") trailing += 1;
    else break;
  }
  return trailing >= 2;
}

/**
 * 画面から claude TUI の入力欄を取り出す（TESTABLE）。
 *
 * 入力欄は末尾側の 2 本の水平罫線に挟まれた領域。`❯` 行だけを探す旧実装は
 * シェルモード（プロンプトが `!` になる）で入力欄を見失い、注入検証が必ず失敗
 * → 本文を 3 回重ね打ちして入力欄を壊し、送信失敗として throw していた
 * （実障害 2026-08-03: `!` 始まりの送信が HerdrFailedError）。
 * 罫線が見つからない画面は最後の `❯` 行 **1 行だけ**へフォールバックする
 * （旧 `inputBoxHasPendingText` と同じ判定なので退行しない）。
 * 判定不能は null（呼び出し側は fail-open 材料として扱う）。
 *
 * **前提**: 選択ダイアログ表示中は本文側の罫線ペア（`──── Planning: … ────` 等）を
 * 入力欄と誤認しうる。注入前にダイアログを閉じるのは呼び出し側の責務
 * （`sendTextSubmit` が `selectionDialogVisible` → Esc で担保）。
 */
export function extractClaudeInputBox(screen: string): ClaudeInputBox | null {
  const lines = screen.split("\n").map((line) => line.trim());
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine(lines[index] ?? "")) {
      bottom = index;
      break;
    }
  }
  let top = -1;
  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (isInputBoxRuleLine(lines[index] ?? "")) {
      top = index;
      break;
    }
  }
  if (top >= 0 && bottom > top) return splitInputPrompt(lines.slice(top + 1, bottom));
  // 罫線が無い画面は最後の `❯` 行 1 行だけを入力欄とみなす（下の行まで含めると
  // フッターを未送信テキストと誤認して送信確定ループが終わらない）。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").startsWith("❯")) return splitInputPrompt([lines[index] ?? ""]);
  }
  return null;
}

/**
 * 入力が空のとき claude TUI が入力欄へ薄字で出すプレースホルダ（実測 2.1.220）。
 * 未送信テキストと誤認すると、シェルモード離脱（空入力の Backspace）に入れず
 * 通常メッセージがシェルコマンドとして実行される（実機フレーム 2026-08-03）。
 *
 * 割り切り: 薄字かどうかは capture では判別できないため文言一致で判定する。
 * ユーザーが偶然この文言だけを打つと「空」と誤判定するが、その場合の実害は
 * 残留 flush の Enter が飛ばないこと（次の注入で本文が連結される）に留まる。
 */
function isInputPlaceholder(text: string): boolean {
  if (text === "Press up to edit queued messages") return true;
  if (text.startsWith('Try "') && text.endsWith('"')) return true;
  return text.startsWith("Message @") && text.endsWith("…");
}

/** 入力欄の行群を「モード記号 + 本文」へ分解する。 */
function splitInputPrompt(bodyLines: string[]): ClaudeInputBox {
  const body = [...bodyLines];
  const first = body[0] ?? "";
  const sigil = INPUT_PROMPT_SIGILS.find((s) => first.startsWith(s));
  if (sigil !== undefined) body[0] = first.slice(sigil.length);
  const text = body.join("\n").trim();
  return { prompt: sigil ?? "", text: isInputPlaceholder(text) ? "" : text };
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

  /**
   * 会話カスタムタイトルの端末表示追随（session-title）。tmux はセッション名自体が
   * 識別子（rename は全経路の解決を壊す）のため no-op。
   */
  async setDisplayTitle(name: string, _title: string | null): Promise<void> {
    validateSessionName(name);
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
    // 中断（停止）直後は claude が queued メッセージを入力欄へ書き戻す。残存したまま
    // 注入すると今回の本文がその後ろへ連結され 1 メッセージになる（実機FB 2026-07-29）。
    // 残存は先に Enter で独立メッセージとして送信し切ってから注入する。空入力への
    // Enter は no-op なので誤検出は無害（herdr 側 sendTextSubmit と同じ防御）。
    if (await this.inputBoxHasPendingText(name)) {
      await this.sendKeys(name, ["Enter"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // 入力欄がシェルモード（プロンプト `!`）のまま残っていると、注入した通常メッセージが
    // そのままシェルコマンドとして実行される。空入力の Backspace（tmux キー名は BSpace）で
    // 記号を消して通常入力へ戻す。`!` 始まりの本文は注入時に自分でシェルモードへ入るので、
    // 常に通常モードから始めるのが決定的で安全（herdr 側 exitShellMode と同じ防御）。
    await this.exitShellMode(name);
    await this.sendKeys(name, [text], true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.sendKeys(name, ["Enter"]);
  }

  /**
   * 入力欄がシェルモードなら BSpace で通常入力へ戻す。判定不能・tmux エラーは no-op
   * （fail-open。この補助操作のエラーを表に出すと「送信できない」原因が BSpace 送出の
   * 失敗に見えてしまうので、実エラーは続く本文注入の send-keys 失敗として顕在化させる）。
   */
  private async exitShellMode(name: string): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
        if (!inputBoxIsShellMode(box) || (box?.text.length ?? 0) > 0) return;
        await this.sendKeys(name, ["BSpace"]);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } catch {
      // no-op（fail-open）
    }
  }

  /** 入力欄に未送信テキストが残っているか。判定不能は false。 */
  private async inputBoxHasPendingText(name: string): Promise<boolean> {
    try {
      const box = extractClaudeInputBox(await this.captureVisibleScreen(name));
      return box !== null && box.text.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 入力欄判定用に **viewport 全体**を取る（末尾 N 行で切らない）。
   *
   * claude TUI の入力欄の最大高さは端末サイズにほぼ比例する（実測 2.1.220:
   * 63 行端末で 26 行 / 120 行端末で 55 行）。固定行数の窓では大きな端末で上罫線が
   * 窓外に出て入力欄を見失い、本文を重ね打ちして送信失敗する。窓を広く取っても
   * `extractClaudeInputBox` は罫線で入力欄を切り出すので過検出にはならない。
   * tmux は `-S` を付けなければ viewport のみ（履歴を引かない）。
   */
  private async captureVisibleScreen(name: string): Promise<string> {
    const args = ["capture-pane", "-p", "-t", this.paneTarget(name)];
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
