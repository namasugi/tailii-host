// launch.ts
// tailii (TS host) — tmux 上での claude 起動（launchCore）と engine 用 launcher の組み立て
// Swift 版 Launch.swift の移植。
// 指定 dir で tmux 上に claude をデタッチ起動し、承認フックは起動時 `--settings '<json>'` で
// この起動プロセス限定に渡し（settings.json は書かない）、SessionMetadataStore に cwd を権威記録
// する。SSH exec は非ログインシェルのため PATH を明示注入する。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeHookLaunchSettings, installCodexHookSettings } from "./hookSettings.js";
import { isInsideBase, standardize, expandTilde } from "./paths.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import { DEFAULT_TMUX_PATH } from "./tmux.js";

/** tmux 内で起動する既定コマンド（claude TUI）。テストでは無害な値に差し替える。 */
export const DEFAULT_INNER_COMMAND = "claude";

/**
 * codex（OpenAI Codex CLI）モードの既定コマンド。
 * 承認統合は後続 Milestone のため、本スライスでは端末で承認応答できない前提で
 * `-a never -s workspace-write`（workspace 内サンドボックスで承認プロンプトを出さず自律実行）にする。
 */
export const DEFAULT_CODEX_COMMAND = "codex -a never -s workspace-write";

/**
 * codex の既存会話 resume 用フラグ（サブコマンド `resume <SESSION_ID>` に前置）。
 * `-a`/`-s` は resume サブコマンドでも有効（`codex resume --help` で確認済み, agent-tag）。
 * resume は cwd+mtime で rollout を解決する tail の性質上、厳密な per-session 追尾は保証しない
 * （同一 cwd の新しい rollout があるとそちらを追い得る。既知の制約）。
 */
export const CODEX_RESUME_FLAGS = "-a never -s workspace-write";

/** codex サンドボックスモード（承認モード相当。承認は PreToolUse フックでゲートするため -a は常に never）。 */
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** モデル slug の安全文字（コマンド注入防止。カタログ由来だが二重に検証する）。 */
const CODEX_MODEL_SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * codex 新規起動の inner コマンドを組み立てる（codex-input）。
 * 承認は PreToolUse フックでゲートするため `-a never` 固定。sandbox とモデルのみ可変にする。
 * @param model 省略/不正文字は無視（既定モデル）。
 * @param sandbox 省略時は workspace-write。
 */
export function codexInnerCommand(opts: { model?: string | null; sandbox?: CodexSandbox | null }): string {
  const sandbox: CodexSandbox = opts.sandbox ?? "workspace-write";
  let cmd = `codex -a never -s ${sandbox}`;
  if (opts.model && CODEX_MODEL_SAFE.test(opts.model)) cmd += ` -m ${opts.model}`;
  return cmd;
}

/** 起動対象エージェント種別（claude=既定 / codex=Codex CLI）。 */
export type LaunchAgent = "claude" | "codex";

/** SSH exec（非ログインシェル）向けに注入する PATH。 */
export function defaultInjectedPath(): string {
  return [
    "/opt/homebrew/bin",
    path.join(os.homedir(), ".local/bin"),
    // mise 管理ツール（例: codex）の解決用シムディレクトリ。非ログインシェルの SSH exec でも届くよう明示。
    path.join(os.homedir(), ".local/share/mise/shims"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

/**
 * `session_start` を launch へ橋渡しする注入可能な実行子（Swift 版 EngineLauncher と対）。
 * 返値は launch の終了コード（0 = 成功）と、失敗時に error 封筒へ載せる説明。
 */
export type EngineLauncher = (
  cwd: string,
  name: string,
  baseDir: string | null,
  resumeSessionId: string | null,
  /** 新規起動（resume なし）で claude の会話 id を固定する uuid（`--session-id`）。null なら claude 生成。 */
  newSessionId?: string | null,
  /** Claude の表示名（`claude --name`。会話名を付けた新規起動のみ, lazy-session）。null なら付与しない。 */
  title?: string | null,
) => Promise<{ exitCode: number; errorText: string }>;

/** シェル single-quote で安全に包む（内部の `'` は `'\''` へ）。tmux new に渡す inner コマンド用。 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 子プロセス実行の注入点（テストは実 tmux を起動しないモックを注入する）。 */
export type ProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number; stdout: string }>;

function defaultProcessRunner(): ProcessRunner {
  return (executable, args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
            reject(error);
            return;
          }
          const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ exitCode, stdout: String(stdout) });
        },
      );
    });
}

/** launch サブコマンドのエントリポイント（`--dir <path> --session <name>`）。 */
export async function runLaunchCommand(args: string[]): Promise<number> {
  let dirArg: string | null = null;
  let sessionArg: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--dir" && i + 1 < args.length) {
      dirArg = args[i + 1]!;
      i += 1;
    } else if (args[i] === "--session" && i + 1 < args.length) {
      sessionArg = args[i + 1]!;
      i += 1;
    }
  }
  if (!dirArg) {
    process.stderr.write("tailii launch: --dir <path> が必要です\n");
    return 2;
  }
  if (!sessionArg) {
    process.stderr.write("tailii launch: --session <name> が必要です\n");
    return 2;
  }
  return launchCore({
    dir: dirArg,
    session: sessionArg,
    baseDir: null,
    binaryPath: currentBinaryPath(),
    tmuxPath: DEFAULT_TMUX_PATH,
    innerCommand: DEFAULT_INNER_COMMAND,
    path: defaultInjectedPath(),
    store: new SessionMetadataStore(),
    now: () => Math.floor(Date.now() / 1000),
    errorSink: (message) => process.stderr.write(message),
  });
}

/**
 * `session_start` を `launchCore` へ橋渡しする EngineLauncher を組み立てる。
 * `store` は TmuxSessionManager と同一インスタンスを渡すこと（起動直後の一覧に cwd が反映されるように）。
 */
export function makeSessionLauncher(options: {
  store?: SessionMetadataStore;
  innerCommand?: string | null;
  tmuxPath?: string | null;
  runner?: ProcessRunner;
  /** 起動対象エージェント（既定 claude）。codex は claude 固有処理を行わない。 */
  agent?: LaunchAgent;
} = {}): EngineLauncher {
  const store = options.store ?? new SessionMetadataStore();
  const agent: LaunchAgent = options.agent ?? "claude";
  const inner =
    options.innerCommand ?? (agent === "codex" ? DEFAULT_CODEX_COMMAND : DEFAULT_INNER_COMMAND);
  const tmux = options.tmuxPath ?? DEFAULT_TMUX_PATH;
  const binary = currentBinaryPath();
  const runner = options.runner ?? defaultProcessRunner();
  return async (cwd, name, baseDir, resumeSessionId, newSessionId, title) => {
    let errorText = "";
    // resume: claude は `<inner> --resume <id>`。resume でない新規起動は
    // `<inner> --session-id <uuid>` で会話 id を固定し、host が tail 対象 jsonl を
    // 事前に確定できるようにする（同一 cwd の別会話ログの流入を防ぐ）。会話名を付けた
    // 新規起動は `--name '<title>'`（/resume ピッカー等に出る表示名, lazy-session）を添える。
    // codex はこれらの制御を持たないため従来どおり素の inner（resume 指定も本スライスでは無視）。
    let effectiveInner: string;
    if (agent === "claude") {
      if (resumeSessionId) {
        effectiveInner = `${inner} --resume ${resumeSessionId}`;
      } else if (newSessionId) {
        effectiveInner = `${inner} --session-id ${newSessionId}`;
        if (title) effectiveInner += ` --name ${shellSingleQuote(title)}`;
      } else {
        effectiveInner = inner;
      }
    } else if (resumeSessionId) {
      // codex は既存会話を `codex resume <SESSION_ID>` で継続する（agent-tag）。
      effectiveInner = `codex resume ${CODEX_RESUME_FLAGS} ${resumeSessionId}`;
    } else {
      effectiveInner = inner;
    }
    const exitCode = await launchCore({
      dir: cwd,
      session: name,
      baseDir,
      binaryPath: binary,
      tmuxPath: tmux,
      innerCommand: effectiveInner,
      path: defaultInjectedPath(),
      store,
      now: () => Math.floor(Date.now() / 1000),
      errorSink: (message) => {
        errorText += message;
      },
      runner,
      agent,
    });
    return { exitCode, errorText };
  };
}

/**
 * launch の純ロジック（プロセス起動とパス類を注入できるためテスト可能）。
 * 1. cwd 解決 + base 配下限定自動作成 → 2. フォルダ事前信頼 → 3. `--settings` へ承認フックを合成 →
 * 4. 死んだ同名セッション掃除 → 5. tmux デタッチ起動 → 6. cwd 権威記録。
 */
export async function launchCore(options: {
  dir: string;
  session: string;
  baseDir: string | null;
  binaryPath: string;
  tmuxPath: string;
  innerCommand: string;
  path: string;
  store: SessionMetadataStore;
  now: () => number;
  errorSink: (message: string) => void;
  runner?: ProcessRunner;
  /** 起動対象エージェント（既定 claude）。codex は claude 固有の事前信頼/フック注入を行わない。 */
  agent?: LaunchAgent;
  /** `~/.claude.json`（事前信頼記録）の場所。テスト注入用。省略時は実ホーム。 */
  claudeJsonPath?: string;
  /** フックのグローバル無効化マーカーの場所。テスト注入用（実マシンのマーカーに左右されない密閉性）。 */
  hookGlobalMarkerPath?: string;
}): Promise<number> {
  const { session, binaryPath, tmuxPath, store, now, errorSink } = options;
  const agent: LaunchAgent = options.agent ?? "claude";
  const runner = options.runner ?? defaultProcessRunner();

  // --- 1. cwd 解決 + base 配下限定自動作成 ---
  const dir = resolveWorkdir(options.dir, options.baseDir, errorSink);
  if (dir === null) return 1;

  // エージェント別の起動前準備。
  // claude: 「フォルダを信頼しますか?」の事前回避（~/.claude.json）と settings.json フック注入。
  // codex:  claude 固有処理は行わず、代わりに codex の信頼を `-c` オーバーライドで事前付与し、
  //         トラストダイアログを回避する（config.toml は書き換えない）。承認/フック統合は後続。
  let innerCommand = options.innerCommand;
  if (agent === "codex") {
    // 承認ゲート: プロジェクトローカル `.codex/hooks.json` に PreToolUse フックを導入し、
    // 自前フックなので `--dangerously-bypass-hook-trust` で信頼ハッシュ確認を省く。
    // 併せて `-c` で信頼を事前付与しトラストダイアログを回避（config.toml は書き換えない）。
    try {
      installCodexHookSettings({
        dir,
        binaryPath,
        session,
        ...(options.hookGlobalMarkerPath !== undefined && {
          globalMarkerPath: options.hookGlobalMarkerPath,
        }),
      });
    } catch (error) {
      errorSink(`tailii launch: .codex/hooks.json 書込失敗: ${String(error)}\n`);
      return 1;
    }
    innerCommand = `${innerCommand} -c projects."${dir}".trust_level="trusted" --dangerously-bypass-hook-trust`;
  } else {
    // --- 1.5. claude の初回「フォルダを信頼しますか?」プロンプトを事前回避する ---
    preTrustFolder(dir, options.claudeJsonPath);

    // --- 2. 承認フックを settings.json へは書かず、この起動限定で `--settings` 経由で渡す ---
    //   （settings.json に書くと同 dir の「tailii 非経由の通常 claude 起動」もフックを拾い、
    //     承認ブローカー不在で全ツールがハングするため。2026-07-07 ユーザー指摘の根治）
    const hookSettings = claudeHookLaunchSettings({
      dir,
      binaryPath,
      session,
      ...(options.hookGlobalMarkerPath !== undefined && {
        globalMarkerPath: options.hookGlobalMarkerPath,
      }),
    });
    if (hookSettings !== null) {
      innerCommand = `${innerCommand} --settings ${shellSingleQuote(hookSettings)}`;
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: options.path };
  const runTmux = async (args: string[]): Promise<{ code: number; out: string }> => {
    try {
      const result = await runner(tmuxPath, args, { env });
      return { code: result.exitCode, out: result.stdout };
    } catch {
      return { code: 127, out: "" };
    }
  };

  // --- 2.5. 既存の「死んだ」同名セッションを掃除する（同名再利用を可能にする） ---
  if ((await runTmux(["has-session", "-t", session])).code === 0) {
    const panes = await runTmux(["list-panes", "-t", session, "-F", "#{pane_dead}"]);
    const hasLive = panes.out.split("\n").some((line) => line.trim() === "0");
    if (!hasLive) {
      await runTmux(["kill-session", "-t", session]);
    }
  }

  // --- 3. tmux で claude をデタッチ起動 ---
  // まだ存在するなら生きた pane がある（claude 稼働中）＝再作成不要。
  // `-A` は付けない（sshd exec に TTY が無く attach 試行が非0終了するため）。
  const alreadyLive = (await runTmux(["has-session", "-t", session])).code === 0;
  if (!alreadyLive) {
    let status: number;
    try {
      const result = await runner(tmuxPath, ["new", "-d", "-s", session, innerCommand], {
        cwd: dir,
        env,
      });
      status = result.exitCode;
    } catch (error) {
      errorSink(`tailii launch: tmux 起動失敗 (${tmuxPath}): ${String(error)}\n`);
      return 1;
    }
    if (status !== 0) {
      errorSink(`tailii launch: tmux が非0終了 (${status})\n`);
      return status;
    }
  }

  // --- 4. cwd を権威記録（tmux は起動 cwd を安定に返さないため本ストアを権威とする） ---
  try {
    // agent は codex のときだけ記録する（claude セッションのメタ形式を従来どおり不変に保つ）。
    store.put({ name: session, cwd: dir, createdAt: now(), ...(agent === "codex" ? { agent } : {}) });
  } catch (error) {
    errorSink(`tailii launch: メタデータ保存失敗: ${String(error)}\n`);
    return 1;
  }

  return 0;
}

/**
 * `~/.claude.json` の `projects[<dir>].hasTrustDialogAccepted` を true にしておく。
 * claude は canonical パス（シンボリックリンク解決後）をキーに信頼を記録する。失敗は握り潰す。
 */
export function preTrustFolder(dir: string, claudeJsonPath?: string): void {
  try {
    const target = claudeJsonPath ?? path.join(os.homedir(), ".claude.json");
    let key: string;
    try {
      key = fs.realpathSync.native(dir);
    } catch {
      key = standardize(dir);
    }

    let root: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // 不在/壊れは空から作る。
    }
    const projects =
      typeof root["projects"] === "object" && root["projects"] !== null
        ? (root["projects"] as Record<string, unknown>)
        : {};
    const entry =
      typeof projects[key] === "object" && projects[key] !== null
        ? (projects[key] as Record<string, unknown>)
        : {};
    if (entry["hasTrustDialogAccepted"] === true) return; // 既に信頼済み

    entry["hasTrustDialogAccepted"] = true;
    projects[key] = entry;
    root["projects"] = projects;
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(root));
    fs.renameSync(tmp, target);
  } catch {
    // 失敗時は claude 側プロンプトへフォールバック。
  }
}

/**
 * cwd 入力を baseDir 基準で実パスへ解決し、baseDir 配下限定で未存在を自動作成する。
 * `/` 始まり → 絶対採用 / `~` 始まり → ホーム展開 / 相対（空含む）→ `baseDir/<入力>`。
 * `..` 脱出は拒否。不在 + 相対（= base 内側）のみ自動作成。失敗は errorSink へ出し null。
 */
export function resolveWorkdir(
  cwd: string,
  baseDir: string | null,
  errorSink: (message: string) => void,
): string | null {
  let resolved: string;
  let isRelative: boolean;

  if (cwd.startsWith("/")) {
    resolved = standardize(cwd);
    isRelative = false;
  } else if (cwd.startsWith("~")) {
    resolved = standardize(expandTilde(cwd));
    isRelative = false;
  } else {
    if (!baseDir) {
      errorSink(`tailii launch: 相対パスにはベースディレクトリの設定が必要です: '${cwd}'\n`);
      return null;
    }
    const joined = cwd === "" ? baseDir : baseDir + "/" + cwd;
    const candidate = standardize(joined);
    if (!isInsideBase(candidate, baseDir)) {
      errorSink(`tailii launch: 解決先がベースディレクトリの外側です: ${candidate}\n`);
      return null;
    }
    resolved = candidate;
    isRelative = true;
  }

  // 存在チェック。
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  if (stat !== null) {
    if (!stat.isDirectory()) {
      errorSink(`tailii launch: 作業ディレクトリがファイルです: ${resolved}\n`);
      return null;
    }
    return resolved;
  }

  // 不在: base 配下（相対）のみ自動作成。絶対/`~` の不在は作成せず error。
  if (!isRelative) {
    errorSink(`tailii launch: 作業ディレクトリが存在しません: ${resolved}\n`);
    return null;
  }
  try {
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  } catch (error) {
    errorSink(
      `tailii launch: 作業ディレクトリの作成に失敗しました: ${resolved}: ${String(error)}\n`,
    );
    return null;
  }
}

/** THIS 実行中エントリスクリプトの絶対パスを解決する（フック command 埋め込み用）。 */
export function currentBinaryPath(): string {
  const argv1 = process.argv[1];
  if (argv1 && argv1.length > 0) {
    return standardize(argv1);
  }
  return "tailii";
}
