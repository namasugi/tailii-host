// quicGateway.ts — QUIC ゲートウェイ（tailii-quic-gw）の解決・資格情報・launchd 常駐
//
// 設計正本: docs/quic-transport.md（モノレポルート）。
// ゲートウェイ本体は Rust バイナリ（quic-gw/）。この module は host-ts 側の運用面
// （バイナリ解決 / 資格情報の生成読込 / launchd LaunchAgent の設置）だけを担う。
//
// - 資格情報（P-256 証明書 + 32byte トークン）の生成は Rust 側
//   `tailii-quic-gw credentials --json` に委譲する（Node に X.509 生成が無いため）。
// - ゲートウェイは launchd 常駐（KeepAlive）。SSH と違い、接続前に誰かが起こして
//   おく必要があるため（Mac 再起動後の初回接続で誰も居ない問題の回避）。

import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { findCommand } from "../commands/doctor.js";
import { defaultInjectedPath } from "../commands/launch.js";

/** launchd ジョブのラベル（plist ファイル名と対）。 */
export const QUIC_GW_LAUNCHD_LABEL = "com.tailii.quic-gw";

/** ゲートウェイの既定 UDP ポート（凍結定数、Rust 側 DEFAULT_PORT と一致）。 */
export const QUIC_GW_DEFAULT_PORT = 46853;

/** `tailii-quic-gw credentials --json` の出力。 */
export interface QuicCredentials {
  dir: string;
  /** SPKI SHA-256（base64）。iOS がピン検証に使う（payload v3 の quicPin）。 */
  spkiPin: string;
  /** 証明書 DER SHA-256（base64）。Rust 自己検証クライアント用。 */
  certPin: string;
  /** 32byte トークン（base64、payload v3 の quicToken）。 */
  token: string;
  port: number;
}

/** 資格情報ディレクトリ（Rust 側 default_credentials_dir と対）。 */
export function quicCredentialsDir(): string {
  return path.join(os.homedir(), ".tailii", "quic");
}

/** ゲートウェイの監査ログパス（launchd が stdout/stderr をここへ向ける）。 */
export function quicGatewayLogPath(): string {
  return path.join(os.homedir(), ".tailii", "quic-gw.log");
}

/**
 * launchd が起動する gateway バイナリの設置先（`~/.tailii/bin/tailii-quic-gw`）。
 *
 * 重要（実機で判明した罠）: launchd の LaunchAgent は `~/Documents` `~/Desktop`
 * `~/Downloads` 等の **TCC 保護フォルダにアクセスできない**。ビルド成果物や npm 配布物が
 * そうした場所にあると、launchd 起動時に dyld がバイナリを map できず **dyld 段階で無限
 * ストール**する（プロセスは生存するが bind に到達せず、ログも出ない）。Terminal 起動は
 * ユーザーの TCC 付与を継承するため成功し、差分に気付きにくい。回避のため、常駐用バイナリは
 * 必ず非 TCC 保護の隠しディレクトリ `~/.tailii/bin` へコピーしてから launchd に渡す。
 */
export function quicGatewayInstalledBinaryPath(): string {
  return path.join(os.homedir(), ".tailii", "bin", "tailii-quic-gw");
}

/**
 * gateway バイナリを非 TCC 保護の `~/.tailii/bin` へコピーして、その設置先パスを返す。
 * 内容が同一なら再コピーしない（mtime/サイズで判定）。常に実行ビットを立てる。
 */
export function installQuicGatewayBinary(sourcePath: string): string {
  const dest = quicGatewayInstalledBinaryPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const sourceStat = fs.statSync(sourcePath);
  let needCopy = true;
  try {
    const destStat = fs.statSync(dest);
    // サイズ一致 かつ コピー先が新しければ据え置き（cargo 再ビルドは mtime が進む）。
    needCopy = !(destStat.size === sourceStat.size && destStat.mtimeMs >= sourceStat.mtimeMs);
  } catch {
    needCopy = true;
  }
  if (needCopy) {
    fs.copyFileSync(sourcePath, dest);
  }
  fs.chmodSync(dest, 0o755);
  return dest;
}

/** LaunchAgent plist の設置先。 */
export function quicLaunchAgentPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${QUIC_GW_LAUNCHD_LABEL}.plist`);
}

// MARK: - バイナリ解決

/**
 * ゲートウェイバイナリを解決する。見つからなければ null（QUIC は任意機能なので
 * 呼び出し側は SSH-only で継続してよい）。
 *
 * 解決順:
 *   1. 環境変数 `TAILII_QUIC_GW`（明示上書き）
 *   2. npm prebuilt（optionalDependencies `@tailii/quic-gw-darwin-{arm64,x64}`）
 *   3. モノレポのローカル cargo ビルド（quic-gw/target/release/tailii-quic-gw）
 *   4. PATH
 */
export function resolveQuicGatewayBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env["TAILII_QUIC_GW"];
  if (explicit !== undefined && explicit !== "" && fs.existsSync(explicit)) return explicit;

  // 2) prebuilt npm package（配布時。未導入環境では解決失敗して次へ）。
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve(`@tailii/quic-gw-darwin-${arch}/package.json`));
    const candidate = path.join(pkgDir, "bin", "tailii-quic-gw");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // 未導入。次の解決先へ。
  }

  // 3) ローカル cargo ビルド（開発機）。dist/services/quicGateway.js → パッケージルート → quic-gw/。
  const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(pkgRoot, "quic-gw", "target", profile, "tailii-quic-gw");
    if (fs.existsSync(candidate)) return candidate;
  }

  // 4) PATH。
  return findCommand("tailii-quic-gw", env["PATH"] ?? "");
}

// MARK: - 資格情報（Rust 側に委譲）

/** コマンド実行子（テスト注入用）。stdout を返し、失敗は reject。 */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/**
 * 資格情報を生成（既存なら読込・冪等）して返す。
 * 実体は `tailii-quic-gw credentials --json --dir <dir>`。
 */
export async function ensureQuicCredentials(
  gatewayPath: string,
  dir: string = quicCredentialsDir(),
  runner: CommandRunner = defaultRunner,
): Promise<QuicCredentials> {
  const stdout = await runner(gatewayPath, ["credentials", "--json", "--dir", dir]);
  const parsed: unknown = JSON.parse(stdout.trim());
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof (parsed as QuicCredentials).spkiPin !== "string" ||
    typeof (parsed as QuicCredentials).token !== "string" ||
    typeof (parsed as QuicCredentials).port !== "number"
  ) {
    throw new Error(`tailii-quic-gw credentials --json の出力が不正です: ${stdout.trim()}`);
  }
  return parsed as QuicCredentials;
}

// MARK: - launchd LaunchAgent

/** XML テキストノードのエスケープ（plist 値に埋める文字列用）。 */
function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** `quicLaunchAgentPlist` に渡す解決済み絶対パス群。 */
export interface QuicLaunchAgentConfig {
  gatewayPath: string;
  logPath: string;
  /** 資格情報ディレクトリ（絶対パス）。`--dir` に明示的に渡す。 */
  credentialsDir: string;
  /** exec 子プロセスへ注入する PATH（launch.ts の defaultInjectedPath と同一）。 */
  injectedPath: string;
  /** ユーザーの HOME 絶対パス（EnvironmentVariables に設定）。 */
  home: string;
}

/**
 * LaunchAgent plist の内容（KeepAlive 常駐・監査ログは stdout/stderr リダイレクト）。
 *
 * 重要（実機で判明した罠）: macOS の GUI LaunchAgent は **HOME を継承しない**。
 * ゲートウェイは `~/.tailii/quic` の展開・`default_injected_path` の両方で HOME を読むため、
 * HOME 空だと資格情報ディレクトリが `/.tailii/quic` に化けて `create_dir_all` が失敗し、
 * serve が即終了 → KeepAlive 再起動ループに陥る。対策として:
 *   1. `EnvironmentVariables` に HOME を明示（gateway 本体 + exec 子プロセス双方に効く）。
 *   2. `--dir` / `--path` を **絶対パスで明示的に渡し**、HOME 展開へ依存しない（防御多重化）。
 */
export function quicLaunchAgentPlist(config: QuicLaunchAgentConfig): string {
  const args = [
    config.gatewayPath,
    "serve",
    "--dir",
    config.credentialsDir,
    "--path",
    config.injectedPath,
  ];
  const programArguments = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${QUIC_GW_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(config.home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(config.injectedPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * launchctl 実行子（テスト注入用）。exit 0 で resolve（stdout を返す）、非 0 は reject。
 * `print` の stdout は稼働状態の判定（`quicGatewayServiceState`）に使う。
 */
export type LaunchctlRunner = (args: string[]) => Promise<string | void>;

const defaultLaunchctl: LaunchctlRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("launchctl", args, { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/** `launchctl print` から読み取れる稼働状態（登録済みジョブのみ）。 */
export interface QuicGatewayRunState {
  /** `state = running` か。 */
  running: boolean;
  pid: number | null;
  /** 登録以来の起動回数（`runs = N`）。0 なら一度も spawn していない = launchd が保留中。 */
  runs: number | null;
  /** 直近の終了コード（`last exit code = N`）。未終了 `(never exited)` や不明は null。 */
  lastExitCode: number | null;
}

/** `launchctl print gui/<uid>/<label>` から読んだ常駐ジョブの状態。 */
export type QuicGatewayServiceState =
  | { loaded: false }
  | ({ loaded: true } & QuicGatewayRunState);

/**
 * `launchctl print` の出力から稼働状態を読む。
 * 見るのはトップレベルの `state = running` / `pid = N` / `runs = N` / `last exit code = N` 行だけ
 * （`state = not running` や endpoint 配下の `state = active` は一致しない。
 * 他の書式は macOS 版で揺れるため依存せず、読めない項目は null にする）。
 */
export function parseLaunchctlPrintState(output: string): QuicGatewayRunState {
  const num = (pattern: RegExp): number | null => {
    const m = pattern.exec(output);
    return m === null ? null : Number(m[1]);
  };
  return {
    running: /^\s*state = running\s*$/m.test(output),
    pid: num(/^\s*pid = (\d+)\s*$/m),
    runs: num(/^\s*runs = (\d+)\s*$/m),
    lastExitCode: num(/^\s*last exit code = (\d+)\s*$/m),
  };
}

export interface InstallLaunchAgentOptions {
  /** 解決済み gateway バイナリ（ビルド/配布物の場所。TCC 保護下でも可）。 */
  gatewayPath: string;
  plistPath?: string;
  logPath?: string;
  /** 資格情報ディレクトリ（絶対パス）。省略時 `quicCredentialsDir()`。 */
  credentialsDir?: string;
  /** exec 子プロセスの PATH。省略時 `defaultInjectedPath()`。 */
  injectedPath?: string;
  /** HOME 絶対パス。省略時 `os.homedir()`。 */
  home?: string;
  /**
   * launchd が実際に起動するバイナリパス（`gatewayPath` からのコピー先）。
   * 省略時 `~/.tailii/bin/tailii-quic-gw` へコピーする（TCC 回避）。テストで無効化可。
   */
  installBinary?: (gatewayPath: string) => string;
  uid?: number;
  launchctl?: LaunchctlRunner;
}

/** `installQuicLaunchAgent` の結果。登録は済んでいる前提で、起動を実確認できたかを返す。 */
export interface QuicLaunchAgentInstallResult {
  /** `launchctl print` が `state = running` を報告したか。 */
  running: boolean;
  pid: number | null;
}

/**
 * LaunchAgent を設置して（再）起動する（冪等）。
 * 既存ジョブは bootout してから bootstrap し、plist 更新を確実に反映する。
 * bootstrap 後に kickstart で起動を確定させ、`launchctl print` で稼働を実確認して返す。
 *
 * gateway バイナリは非 TCC 保護の `~/.tailii/bin` へコピーしてから launchd に渡す
 * （`installQuicGatewayBinary` 参照。TCC 保護フォルダ由来の dyld ストール回避）。
 */
export async function installQuicLaunchAgent(
  options: InstallLaunchAgentOptions,
): Promise<QuicLaunchAgentInstallResult> {
  const plistPath = options.plistPath ?? quicLaunchAgentPlistPath();
  const logPath = options.logPath ?? quicGatewayLogPath();
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const installBinary = options.installBinary ?? installQuicGatewayBinary;

  // TCC 保護フォルダ（~/Documents 等）から launchd 起動すると dyld がストールするため、
  // 常駐用バイナリは非保護の隠しディレクトリへコピーしてそこを起動する。
  const launchBinary = installBinary(options.gatewayPath);

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    quicLaunchAgentPlist({
      gatewayPath: launchBinary,
      logPath,
      credentialsDir: options.credentialsDir ?? quicCredentialsDir(),
      injectedPath: options.injectedPath ?? defaultInjectedPath(),
      home: options.home ?? os.homedir(),
    }),
    { mode: 0o644 },
  );

  // 既存ジョブは落としてから載せ直す（未登録の bootout 失敗は無視）。
  try {
    await launchctl(["bootout", `gui/${uid}/${QUIC_GW_LAUNCHD_LABEL}`]);
  } catch {
    // 未登録なら失敗するのが正常。
  }
  try {
    await launchctl(["bootstrap", `gui/${uid}`, plistPath]);
  } catch {
    // 旧 macOS / 非 GUI セッション向けフォールバック。
    await launchctl(["load", "-w", plistPath]);
  }

  // 実機で判明した罠（2026-09-18）: ログインセッションの launchd ドメインが
  // 「on-demand-only モード」（`launchctl print gui/<uid>` の `on-demand count` > 0。入る
  // きっかけは launchd がログに残さないため未特定。再ログイン / 再起動で解ける）に居ると、
  // RunAtLoad / KeepAlive による自動起動は "pending spawn, domain in on-demand-only mode"
  // で保留される。bootstrap 自体は成功扱いなので、setup 再実行で稼働中の gw を bootout
  // した直後に「登録済みなのに誰も居ない」状態になり、アプリは SSH に落ちたまま復帰しない。
  // kickstart は demand 起動なので保留を突き抜ける。稼働中なら no-op（`-k` は付けない:
  // 直前に spawn した正常系プロセスを殺して入れ替える無駄と競合を避ける）。
  try {
    await launchctl(["kickstart", `gui/${uid}/${QUIC_GW_LAUNCHD_LABEL}`]);
  } catch {
    // 失敗は直後の状態確認で「未起動」として呼び出し側に伝わる。
  }
  const state = await quicGatewayServiceState(uid, launchctl);
  return state.loaded ? { running: state.running, pid: state.pid } : { running: false, pid: null };
}

/** launchd ジョブの状態を読む（doctor / quic-info / setup 用・副作用なし）。 */
export async function quicGatewayServiceState(
  uid: number = process.getuid?.() ?? 501,
  launchctl: LaunchctlRunner = defaultLaunchctl,
): Promise<QuicGatewayServiceState> {
  let output: string | void;
  try {
    output = await launchctl(["print", `gui/${uid}/${QUIC_GW_LAUNCHD_LABEL}`]);
  } catch {
    return { loaded: false };
  }
  // stdout を返さない実行子（テスト注入）は「登録済み・稼働不明」として未起動側に倒す。
  if (typeof output !== "string") {
    return { loaded: true, running: false, pid: null, runs: null, lastExitCode: null };
  }
  return { loaded: true, ...parseLaunchctlPrintState(output) };
}

/** launchd ジョブが登録されているか（起動保留中でも true。稼働判定は `isQuicGatewayRunning`）。 */
export async function isQuicGatewayLoaded(
  uid: number = process.getuid?.() ?? 501,
  launchctl: LaunchctlRunner = defaultLaunchctl,
): Promise<boolean> {
  return (await quicGatewayServiceState(uid, launchctl)).loaded;
}

/**
 * launchd ジョブが実際に稼働しているか。登録済みでも launchd が起動を保留している間は false
 * （print は成功するため「登録済み」だけでは死んだゲートウェイを配ってしまう）。
 */
export async function isQuicGatewayRunning(
  uid: number = process.getuid?.() ?? 501,
  launchctl: LaunchctlRunner = defaultLaunchctl,
): Promise<boolean> {
  const state = await quicGatewayServiceState(uid, launchctl);
  return state.loaded && state.running;
}

// MARK: - quic-info（SSH ブートストラップ: iOS が exec 経由で資格情報を取得する）

/**
 * `tailii-host quic-info` の応答形状。iOS `QUICCredentialCache.parse` と契約整合。
 * mosh の「SSH で鍵を配って以後 UDP」と同じ構図 — SSH（認証済み暗号路）経由で
 * QUIC の接続情報を配布し、iOS が Keychain にキャッシュして次回以降 QUIC 先行する。
 * これにより payload v3 の QR 再ペアリング無しで既存端末が QUIC 化できる。
 */
export interface QuicInfoResult {
  available: boolean;
  /** available=false の理由（診断用。iOS は available だけ見る）。 */
  reason?: string;
  port?: number;
  pin?: string;
  token?: string;
}

/**
 * 証明書 PEM から SPKI SHA-256 ピン（base64）を計算する。
 * Rust 側 `Credentials::spki_pin()`（rcgen public_key_der のハッシュ）と同一値になる
 * （X.509 の SubjectPublicKeyInfo DER は同一バイト列のため）。
 */
export function computeSpkiPinFromCertPem(certPem: string): string {
  const cert = new X509Certificate(certPem);
  const spkiDer = cert.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spkiDer).digest("base64");
}

/**
 * ディスク上の資格情報（cert.pem / token）から quic-info の中身を読む。
 * ゲートウェイバイナリには依存しない（生成は setup / Rust 側の責務。ここは読むだけ）。
 */
export function readQuicCredentialsFromDisk(dir: string = quicCredentialsDir()): { pin: string; token: string } | null {
  try {
    const certPem = fs.readFileSync(path.join(dir, "cert.pem"), "utf8");
    const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
    if (token === "") return null;
    return { pin: computeSpkiPinFromCertPem(certPem), token };
  } catch {
    return null;
  }
}

/** quic-info の本体（テスト注入可能な純ロジック）。 */
export async function collectQuicInfo(options?: {
  dir?: string;
  /** 常駐が実際に稼働しているか（既定 `isQuicGatewayRunning`。登録済みだけでは不足）。 */
  isRunning?: () => Promise<boolean>;
}): Promise<QuicInfoResult> {
  const creds = readQuicCredentialsFromDisk(options?.dir ?? quicCredentialsDir());
  if (creds === null) {
    return { available: false, reason: "credentials-missing" };
  }
  const running = await (options?.isRunning ?? (() => isQuicGatewayRunning()))();
  if (!running) {
    // 稼働していないのに資格情報だけ配ると、クライアントが再接続のたびに
    // 死んだゲートウェイへ 1.5s の接続試行税を払う。配らない方が安全側。
    // 「登録済み（print 成功）」は launchd が起動を保留していても真になるため稼働状態で判定する。
    return { available: false, reason: "gateway-not-running" };
  }
  return { available: true, port: QUIC_GW_DEFAULT_PORT, pin: creds.pin, token: creds.token };
}

/** `tailii-host quic-info` エントリポイント。stdout に JSON 1 行を出す（常に exit 0）。 */
export async function runQuicInfoCommand(_argv: string[]): Promise<number> {
  const info = await collectQuicInfo();
  process.stdout.write(JSON.stringify(info) + "\n");
  return 0;
}
