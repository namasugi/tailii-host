// setup.ts
// tailii (TS host) — setup サブコマンド実装
// Swift スクリプト scripts/poc-host-setup.swift の移植（Moshi `host setup` 相当）。
//
// ペアリングの提供コマンド。QR には「接続先 + ワンタイム PSK」だけを載せ（spec v1.1 ブートストラップ）、
// スキャン後は pairing-code プロトコル（TCP）で iPhone 生成の公開鍵を authorized_keys へ登録する
// （client-key enrollment・秘密鍵はワイヤに載せない）。旧アプリの直接入力向けには従来どおり
// ホスト側 ed25519 鍵を用意し、key あり payload（v1/2/3）へフォールバックする。
//
// 使い方:  tailii setup
//          tailii setup --session <name> [--session-cwd <cwd>]
//          tailii setup --emit-payload [--session <name> [--session-cwd <cwd>]]
//
//   通常モード（フラグ無し）は QR（①スキャン用）を表示し、続けて直接入力（②host:port + 6桁コード）
//   の待受サーバを起動する。ユーザーは同じ 1 コマンドで QR / 直接入力のどちらでもペアリングできる。
//   接続先 IP は自動選定（Tailscale があれば優先・無ければ LAN）で、経路を意識しなくてよい。
//
//   --session <name>      tmux セッション名。指定で payload v2（無指定は従来 v1）。
//   --session-cwd <cwd>   tmux セッションの作業ディレクトリ（任意、v2 のみ有効）。
//   --host <ip>           接続先ホストを明示上書き（自動選定を使わない場合のみ）。通常は不要。
//   --no-quic             QUIC ゲートウェイの設置（launchd の載せ直し）を飛ばし、SSH のみでペアリングする。
//                         稼働中のゲートウェイ（= 接続中の端末）を落とさずに別端末を追加したいとき用。
//   --code                後方互換の無効フラグ（通常モードが常に直接入力サーバも起動するため）。
//   --emit-payload        副作用なし検証モード。keygen/QR/ファイル操作を行わず payload JSON を stdout に出すだけ。
//                         既存の鍵があれば読むが無くても擬似値で継続。
//
// 注意: リモートログイン(ON)が前提。公開鍵の authorized_keys 登録を行う。
//       QR は setup 実行中のみ有効（ワンタイム PSK）。--emit-payload の byte 契約は legacy（key あり）のまま。
//
// Swift 版との差分:
//   - QR は macOS 限定の PNG+open ではなく、ゼロ依存 `qrcode-terminal` でターミナルに直接描画する
//     （`npx` 実行・SSH 越しでもスキャン可能。クロスプラットフォーム）。
//   - LAN IP 検出は `ipconfig getifaddr` ではなく `os.networkInterfaces()`（en0/en1 優先、非内部 IPv4）。
//   - payload の JSON は Swift JSONEncoder `.prettyPrinted + .sortedKeys` と byte 一致で符号化する
//     （2スペース字下げ・`" : "` 区切り・キー辞書順・`/`→`\/` エスケープ）。golden 契約を維持。

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import qrcode from "qrcode-terminal";
import { DEFAULT_SAS_TTL_MS, SAS_EXPIRED_REASON, runPairingResponder } from "./pairingCode.js";
import { StatusLine, formatRemaining } from "./statusLine.js";
import {
  collectDoctorChecks,
  defaultShimBinDir,
  ensureHostShim,
  formatDoctorChecks,
  resolveOwnCliPath,
} from "./doctor.js";
import {
  ensureQuicCredentials,
  installQuicLaunchAgent,
  resolveQuicGatewayBinary,
} from "../services/quicGateway.js";

// MARK: - ペアリング payload の byte-exact 符号化

/** payload v3 の QUIC 接続情報（3 点セットで載せる。部分的な指定は型で禁止）。 */
export interface QuicPayloadFields {
  /** ゲートウェイの UDP ポート。 */
  port: number;
  /** SPKI SHA-256 ピン（base64）。 */
  pin: string;
  /** 32byte トークン（base64）。 */
  token: string;
}

/** ペアリング payload の入力（key あり: v は quic > sessionName の順で 3/2/1。key なし: 常に v4）。 */
export interface PairingPayloadInput {
  host: string;
  port: number;
  user: string;
  /** 秘密鍵 PEM 全文。省略で payload v4（client-key enrollment 用・鍵転送なし）。 */
  key?: string;
  /** 指定で v2 以上。 */
  sessionName?: string;
  /** v2 以上のみ。未指定なら JSON から省略される。 */
  sessionCwd?: string;
  /** 指定で v3（QUIC トランスポート対応アプリ向け）。 */
  quic?: QuicPayloadFields;
}

/**
 * ペアリング payload を Swift `JSONEncoder`（`.prettyPrinted + .sortedKeys`）と byte 一致で符号化する。
 * 末尾改行は含めない（呼び出し側が付与）。golden `protocol/pairing-payload-v{1,2,3,4}.json` と契約整合。
 */
export function encodePairingPayload(input: PairingPayloadInput): string {
  const obj: Record<string, string | number> = {
    host: input.host,
    port: input.port,
    user: input.user,
    v: input.key === undefined ? 4 : input.quic !== undefined ? 3 : input.sessionName !== undefined ? 2 : 1,
  };
  if (input.key !== undefined) obj["key"] = input.key;
  if (input.sessionName !== undefined) {
    obj["sessionName"] = input.sessionName;
    // v2 でも cwd 未指定なら Swift の optional=nil と同じく JSON から省略する。
    if (input.sessionCwd !== undefined) obj["sessionCwd"] = input.sessionCwd;
  }
  if (input.quic !== undefined) {
    // フィールド名は凍結対象（docs/quic-transport.md「凍結対象」）。
    obj["quicPort"] = input.quic.port;
    obj["quicPin"] = input.quic.pin;
    obj["quicToken"] = input.quic.token;
  }

  // sortedKeys: キーを辞書順に並べ、prettyPrinted（2スペース字下げ・" : " 区切り）で整形する。
  const lines = Object.keys(obj)
    .sort()
    .map((key) => {
      const value = obj[key]!;
      const encoded = typeof value === "number" ? String(value) : swiftJSONString(value);
      return `  ${swiftJSONString(key)} : ${encoded}`;
    });
  return `{\n${lines.join(",\n")}\n}`;
}

/**
 * 文字列を Swift `JSONEncoder` と同じ規則で JSON 文字列リテラルへ符号化する。
 * 標準 JSON エスケープに加え、Swift 既定と同様に `/` を `\/` にエスケープする。
 * （JSON.stringify の出力に裸の `/` はエスケープ列として現れないため、全置換で安全）。
 */
function swiftJSONString(value: string): string {
  return JSON.stringify(value).replaceAll("/", "\\/");
}

// MARK: - LAN IP 検出

/**
 * LAN の IPv4 アドレスを検出する（en0 → en1 → 最初の非内部 IPv4 の順）。取得不能なら空文字。
 * Swift 版の `ipconfig getifaddr en0/en1` 相当をクロスプラットフォームに一般化したもの。
 */
export function detectLanIP(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const pick = (name: string): string | undefined =>
    (interfaces[name] ?? []).find((addr) => addr.family === "IPv4" && !addr.internal)?.address;
  const preferred = pick("en0") ?? pick("en1");
  if (preferred !== undefined) return preferred;
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "";
}

/**
 * Tailscale の IPv4（CGNAT レンジ `100.64.0.0/10`）を検出する。無ければ空文字。
 * Tailscale は自身に 100.64.0.0〜100.127.255.255 のアドレスを割り当てる。
 */
export function detectTailscaleIP(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const octets = addr.address.split(".").map(Number);
      // 100.64.0.0/10: 第1オクテット=100 かつ 第2オクテット 64〜127。
      if (octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127) {
        return addr.address;
      }
    }
  }
  return "";
}

/**
 * ペアリングに使う「最も繋がりやすい」ホストを自動選定する。
 * Tailscale が上がっていればその IP（tailnet の全端末から到達可・LAN 外でも成立）を優先し、
 * 無ければ LAN IP へフォールバックする。ユーザーが経路（Tailscale か LAN か）を意識せずに済む。
 */
export function detectPreferredIP(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  return detectTailscaleIP(interfaces) || detectLanIP(interfaces);
}

// MARK: - authorized_keys 登録（テスタブル）

/** authorized_keys 登録の結果。 */
export type AuthorizedKeyResult = "added" | "already-present";

/**
 * 公開鍵行を `<sshDir>/authorized_keys` に登録する（既存なら何もしない）。
 * ディレクトリは 0700、ファイルは 0600 で保存する（Swift 版パリティ）。
 *
 * @param sshDir `~/.ssh` 相当のディレクトリ（テストは一時 dir を注入）。
 * @param pubLine 登録する公開鍵行（前後空白は呼び出し側で trim 済み想定）。
 */
export function registerAuthorizedKey(sshDir: string, pubLine: string): AuthorizedKeyResult {
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const authKeys = path.join(sshDir, "authorized_keys");
  let existing = "";
  try {
    existing = fs.readFileSync(authKeys, "utf8");
  } catch {
    existing = "";
  }
  if (existing.includes(pubLine)) return "already-present";
  if (existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
  existing += pubLine + "\n";
  fs.writeFileSync(authKeys, existing, { mode: 0o600 });
  fs.chmodSync(authKeys, 0o600);
  return "added";
}

// MARK: - 鍵ペアの用意（テスタブル・keygen 注入式）

/** 鍵ペア用意の結果。 */
export interface EnsureKeypairResult {
  status: "generated" | "reused";
  /** 秘密鍵 PEM 全文。 */
  privateKeyPem: string;
  /** 公開鍵行（trim 済み）。 */
  publicKeyLine: string;
}

/**
 * `<base>/poc_id_ed25519{,.pub}` の鍵ペアを用意する。無ければ `keygen` を呼んで生成する。
 * base は 0700 で作成する。テストは `keygen` にダミー鍵書き出しを注入して ssh-keygen を回避できる。
 *
 * @param base `~/.tailii` 相当のディレクトリ。
 * @param keygen 鍵が無いとき `keyPath` に ed25519 鍵ペア（keyPath と keyPath+".pub"）を生成する関数。
 */
export function ensureKeypair(base: string, keygen: (keyPath: string) => void): EnsureKeypairResult {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const keyPath = path.join(base, "poc_id_ed25519");
  const pubPath = `${keyPath}.pub`;

  let status: "generated" | "reused";
  if (fs.existsSync(keyPath)) {
    status = "reused";
  } else {
    keygen(keyPath);
    status = "generated";
  }

  const privateKeyPem = fs.readFileSync(keyPath, "utf8");
  const publicKeyLine = fs.readFileSync(pubPath, "utf8").trim();
  return { status, privateKeyPem, publicKeyLine };
}

/** 実 `ssh-keygen` で ed25519 鍵ペアを生成する（本番 keygen）。 */
export function sshKeygenEd25519(keyPath: string): void {
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "TailiiPoC", "-f", keyPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// MARK: - emit-payload（副作用なし・byte-exact 契約）

export interface EmitPayloadOptions {
  /** `~/.tailii` 相当のディレクトリ。 */
  base: string;
  username: string;
  lanIP: string;
  sessionName?: string;
  sessionCwd?: string;
}

/**
 * `--emit-payload` の純ロジック。副作用なしで payload JSON（末尾改行なし）を返す。
 * 既存の秘密鍵があれば読み、無ければ Swift 版と同じ擬似値で継続する（形状検査が目的）。
 */
export function emitPayloadJSON(options: EmitPayloadOptions): string {
  const keyPath = path.join(options.base, "poc_id_ed25519");
  let pem: string;
  try {
    pem = fs.readFileSync(keyPath, "utf8");
  } catch {
    pem = "<no-private-key-emit-payload-mode>";
  }
  return encodePairingPayload({
    host: options.lanIP,
    port: 22,
    user: options.username,
    key: pem,
    ...(options.sessionName !== undefined ? { sessionName: options.sessionName } : {}),
    ...(options.sessionCwd !== undefined ? { sessionCwd: options.sessionCwd } : {}),
  });
}

// MARK: - CLI エントリポイント

interface SetupArgs {
  emitPayload: boolean;
  code: boolean;
  sessionName?: string;
  sessionCwd?: string;
  /** payload / 待受表示に使うホストを明示指定（Tailscale IP など）。未指定なら detectLanIP()。 */
  host?: string;
  /** QUIC ゲートウェイの設置を飛ばす（稼働中のゲートウェイを載せ直さない）。 */
  skipQuic?: boolean;
}

function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { emitPayload: false, code: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--emit-payload":
        args.emitPayload = true;
        break;
      case "--code":
        args.code = true;
        break;
      case "--host":
        if (i + 1 < argv.length) args.host = argv[++i];
        break;
      case "--no-quic":
        args.skipQuic = true;
        break;
      case "--session":
        if (i + 1 < argv.length) args.sessionName = argv[++i];
        break;
      case "--session-cwd":
        if (i + 1 < argv.length) args.sessionCwd = argv[++i];
        break;
      default:
        process.stderr.write(`不明な引数を無視: ${argv[i]}\n`);
        break;
    }
  }
  return args;
}

/**
 * setup サブコマンドの CLI エントリポイント。
 *
 * `--emit-payload`: 副作用なしで payload JSON を stdout に出力（byte-exact 契約）。
 * 通常モード: ed25519 鍵生成（無ければ）→ authorized_keys 登録 → payload をターミナル QR ＋ JSON で表示。
 * `--code`: 同じ副作用の後、TCP で pairing-code v1 responder を 1 回だけ実行する。
 */
export async function runSetupCommand(argv: string[]): Promise<number> {
  const args = parseSetupArgs(argv);
  const base = path.join(os.homedir(), ".tailii");
  const username = os.userInfo().username;

  // --- 検証モード（--emit-payload）: 副作用なしで payload JSON を出すだけ ---
  if (args.emitPayload) {
    const json = emitPayloadJSON({
      base,
      username,
      lanIP: args.host ?? detectPreferredIP(),
      ...(args.sessionName !== undefined ? { sessionName: args.sessionName } : {}),
      ...(args.sessionCwd !== undefined ? { sessionCwd: args.sessionCwd } : {}),
    });
    process.stdout.write(json + "\n");
    return 0;
  }

  // --- 1) ホストシムを生成 + 環境診断 ---
  // 注: ホスト側 ed25519 鍵の生成・authorized_keys 登録はここでは行わない。
  //     新アプリは自分で鍵を作り公開鍵だけを登録させる（spec v1.1）ので、ホスト生成の秘密鍵は
  //     旧アプリが直接入力で来たときだけ必要になる。使わない秘密鍵をディスクに残さないため、
  //     生成・登録は legacy フォールバックが実際に発生する瞬間まで遅延させる（下記 ensureLegacyPayload）。
  // iPhone は SSH 非対話シェルから ~/.local/bin/tailii-host を exec する。
  // node が PATH に無い環境でも動くよう、node 絶対パス固定のシムを自動生成する。
  try {
    const shim = ensureHostShim(defaultShimBinDir(), process.execPath, resolveOwnCliPath());
    const shimPath = path.join(defaultShimBinDir(), "tailii-host");
    if (shim === "skipped-foreign") {
      process.stderr.write(
        `注意: ${shimPath} は手動管理のファイルのため上書きしませんでした。\n` +
          `      アプリはこのパスを実行します。内容が正しいか確認してください。\n`,
      );
    } else if (shim !== "unchanged") {
      process.stdout.write(`ホストシムを${shim === "created" ? "生成" : "更新"}しました: ${shimPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`ホストシムの生成に失敗: ${String(error)}\n`);
    return 1;
  }
  const checks = await collectDoctorChecks();
  process.stdout.write("環境診断:\n" + formatDoctorChecks(checks) + "\n");
  const failedRequired = checks.filter((c) => c.required && !c.ok);
  if (failedRequired.length > 0) {
    process.stderr.write(
      `注意: 必須項目 ${failedRequired.length} 件が未充足です(ペアリング自体は続行できます)。\n`,
    );
  }

  // --- 2.7) QUIC ゲートウェイ（任意機能）: 資格情報生成 + launchd 常駐 ---
  // 失敗しても SSH-only でペアリングを続行する（QUIC は優先経路であって必須ではない）。
  // --no-quic: 稼働中のゲートウェイを bootout/bootstrap で載せ直さない（接続中の端末を落とさない）。
  // payload に quic を載せないので、新端末は SSH のみで繋ぐ（後から quic-info で取得できる）。
  const quic = args.skipQuic
    ? (process.stdout.write("QUIC ゲートウェイ: --no-quic のため設置を飛ばします（SSH のみでペアリングします）。\n"), null)
    : await setupQuicGateway();

  // --- 3) ペアリング payload を構築 ---
  // 接続先は自動選定（Tailscale があれば優先・無ければ LAN）。--host で明示上書きも可。
  // ユーザーは経路（Tailscale か LAN か）を意識しなくてよい。
  // legacy（key あり v1/2/3）は旧アプリの直接入力フォールバック用。
  // enrollment（key なし v4）は新アプリ用 — 秘密鍵はワイヤに載せない（spec v1.1）。
  const lanIP = args.host ?? detectPreferredIP();
  if (lanIP === "") {
    process.stderr.write("接続先 IP を取得できません（ネットワーク未接続?）\n");
  }
  const commonPayloadFields = {
    host: lanIP,
    port: 22,
    user: username,
    ...(args.sessionName !== undefined ? { sessionName: args.sessionName } : {}),
    ...(args.sessionCwd !== undefined ? { sessionCwd: args.sessionCwd } : {}),
    ...(quic !== null ? { quic } : {}),
  };
  const noKeyPayloadJSON = encodePairingPayload(commonPayloadFields);
  /**
   * legacy（key あり）payload を必要になった瞬間に用意する。
   * ホスト側 ed25519 鍵の生成と authorized_keys 登録もここで初めて行うので、
   * 新アプリだけを使う環境にはホスト生成の秘密鍵が一切残らない。
   */
  const ensureLegacyPayload = (): string => {
    const keypair = ensureKeypair(base, sshKeygenEd25519);
    process.stdout.write(
      keypair.status === "generated"
        ? "旧アプリ向けにホスト側 ed25519 鍵を生成しました。\n"
        : `旧アプリ向けに既存のホスト側鍵を再利用: ${path.join(base, "poc_id_ed25519")}\n`,
    );
    const registered = registerAuthorizedKey(path.join(os.homedir(), ".ssh"), keypair.publicKeyLine);
    process.stdout.write(
      registered === "added"
        ? "ホスト側公開鍵を authorized_keys に登録しました。\n"
        : "ホスト側公開鍵は登録済みです。\n",
    );
    return encodePairingPayload({ ...commonPayloadFields, key: keypair.privateKeyPem });
  };

  // --- 4) ペアリング待受サーバを先に bind（QR に bind 後の port を載せるため順序が必要） ---
  const server = net.createServer();
  server.maxConnections = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    process.stderr.write(`ペアリング待受サーバの起動に失敗: ${String(error)}\n`);
    return 1;
  }
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : 0;

  // --- 5) QR（ブートストラップ）を表示 ---
  // QR には秘密を含む payload ではなく「接続先 + ワンタイム PSK」だけを載せる（spec v1.1）。
  // スキャン後、アプリは下記サーバへ TCP 接続して公開鍵登録（enrollment）まで自動で行う。
  const psk = crypto.randomBytes(32);
  const bootstrapJSON = JSON.stringify({
    pair: "code-v1",
    host: lanIP,
    port: boundPort,
    psk: psk.toString("base64"),
  });
  const qr = await renderTerminalQR(bootstrapJSON);
  const sessionLine =
    args.sessionName !== undefined
      ? `  session : ${args.sessionName}\n  cwd     : ${args.sessionCwd ?? "(未指定)"}\n`
      : "";
  const quicLine = quic !== null ? `  quic    : udp/${quic.port}（SSH フォールバック付き）\n` : "";
  process.stdout.write(
    "\n================ ① QR でペアリング ================\n" +
      `  host : ${lanIP}\n` +
      `  user : ${username}\n` +
      sessionLine +
      quicLine +
      "  iPhone の Tailii →「ペアリング」→「QR をスキャン」で下の QR を読む\n" +
      "  ※ QR はこのコマンドの実行中のみ有効です（秘密鍵は含まれません。\n" +
      "     iPhone 側で生成した公開鍵をこの Mac に登録します）\n" +
      "==================================================\n\n" +
      `${qr}\n`,
  );

  // --- 6) 直接入力（host:port + 6桁コード）の案内を出し、同じサーバで両モードを待受 ---
  // QR スキャン客は psk 付き hello、直接入力客は psk なし hello（SAS 照合）で到着する。
  return runCodePairingServer(server, {
    payloadJSON: ensureLegacyPayload,
    payloadJSONNoKey: noKeyPayloadJSON,
    psk,
    registerClientKey: (line) => {
      const result = registerAuthorizedKey(path.join(os.homedir(), ".ssh"), line);
      process.stdout.write(
        result === "added"
          ? "iPhone の公開鍵を authorized_keys に登録しました。\n"
          : "iPhone の公開鍵は登録済みです。\n",
      );
    },
    lanIP,
    port: boundPort,
  });
}

/**
 * QUIC ゲートウェイの用意（任意機能・失敗しても null で SSH-only 続行）。
 * 資格情報の生成（冪等）→ launchd LaunchAgent 設置（冪等）→ payload v3 用の 3 点セットを返す。
 */
async function setupQuicGateway(): Promise<QuicPayloadFields | null> {
  const gatewayPath = resolveQuicGatewayBinary();
  if (gatewayPath === null) {
    process.stdout.write(
      "QUIC ゲートウェイ: バイナリ未検出のためスキップ（SSH のみでペアリングします）。\n",
    );
    return null;
  }
  try {
    const creds = await ensureQuicCredentials(gatewayPath);
    const installed = await installQuicLaunchAgent({ gatewayPath });
    if (!installed.running) {
      // 登録はできたが動いていない（launchd ドメインの on-demand-only モードで起動が保留、
      // または起動直後に終了）。動いていないゲートウェイの接続情報を QR に載せても新端末が
      // 接続毎に 1.5s の試行税を払うだけなので配らない（quic-info と同じ安全側）。
      // 復旧後は SSH ブートストラップ（quic-info）で配る。
      process.stderr.write(
        "QUIC ゲートウェイ: 常駐を登録しましたが起動を確認できませんでした（SSH のみで続行します）。\n"
        + "  確認: tailii doctor / 起動: launchctl kickstart gui/$(id -u)/com.tailii.quic-gw"
        + " / ログ: ~/.tailii/quic-gw.log\n",
      );
      return null;
    }
    process.stdout.write(
      `QUIC ゲートウェイ: 常駐を設置しました（udp/${creds.port}, pin=${creds.spkiPin}`
      + `${installed.pid === null ? "" : `, pid=${installed.pid}`}）。\n`,
    );
    return { port: creds.port, pin: creds.spkiPin, token: creds.token };
  } catch (error) {
    process.stderr.write(
      `QUIC ゲートウェイの設置に失敗（SSH のみで続行します）: ${String(error)}\n`,
    );
    return null;
  }
}

/** payload をターミナル QR 文字列へ描画する（ゼロ依存 qrcode-terminal, small=密度重視）。 */
function renderTerminalQR(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (qr: string) => resolve(qr));
  });
}

interface CodePairingServerOptions {
  /** legacy（key あり）payload の遅延ビルダ。旧アプリ・enrollment 不成立時にだけ評価される。 */
  payloadJSON: () => string;
  /** enrollment 成立時に送る key なし payload（v4）。 */
  payloadJSONNoKey: string;
  /** QR ブートストラップのワンタイム PSK（32B）。 */
  psk: Buffer;
  /** 検証済みクライアント公開鍵行の登録副作用。 */
  registerClientKey: (publicKeyLine: string) => void;
  lanIP: string;
  port: number;
  /** テスト用の時間注入。省略時は本番値（待受 600s / SAS 60s / 各ステップ 30s）。 */
  timing?: CodePairingServerTiming;
  /** 出力先（テスト用）。省略時は process.stdout / stderr。 */
  out?: CodePairingServerOutput;
}

export interface CodePairingServerTiming {
  /** 接続を待ち続ける総時間。失敗・期限切れ後も、この枠内なら次の接続を受ける。 */
  waitTotalMs: number;
  /** 6 桁コードの有効期限（server_key.ttl として iPhone にも通知）。 */
  sasTtlMs: number;
  /** 機械的な各ステップの応答待ち。 */
  stepTimeoutMs?: number;
  /** 1 回の setup で受理する接続数の上限（spec v1.2「試行回数の上限」）。 */
  maxAttempts?: number;
}

/**
 * 1 回の setup で受理する接続数の上限。
 * 待受を継続すると、能動 MITM がホスト側で鍵交換だけを高速に回し（reveal 前に自分側の SAS を
 * 計算できるので 1 接続 = RTT 1 回）、iPhone 側に出ている 6 桁と衝突する鍵（2^-20/回）を探せる。
 * 回数を小さく抑えて「実質単発試行」（≤ 5×2^-20）を保ちつつ、人間の再発行 2〜3 回は許す。
 */
const DEFAULT_PAIRING_MAX_ATTEMPTS = 5;

export interface CodePairingServerOutput {
  stdout: { isTTY?: boolean; write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const DEFAULT_PAIRING_WAIT_TOTAL_MS = 600_000;

/**
 * bind 済みサーバで QR（psk）/ 直接入力（SAS）両モードのペアリングを受理する。
 * 成立するまで（総待受時間と接続回数上限の範囲で）接続を受け続ける: コード期限切れや失敗で
 * 接続が閉じても待受は残るので、iPhone 側の「コードを再発行」（= 再接続）だけでやり直せる。
 * 待受中とコード表示中は残り時間をカウントダウンで見せる（「勝手に終わった」に見せない）。
 */
export async function runCodePairingServer(server: net.Server, options: CodePairingServerOptions): Promise<number> {
  const host = options.lanIP === "" ? "0.0.0.0" : options.lanIP;
  const out: CodePairingServerOutput = options.out ?? { stdout: process.stdout, stderr: process.stderr };
  const waitTotalMs = options.timing?.waitTotalMs ?? DEFAULT_PAIRING_WAIT_TOTAL_MS;
  const sasTtlMs = options.timing?.sasTtlMs ?? DEFAULT_SAS_TTL_MS;
  const maxAttempts = options.timing?.maxAttempts ?? DEFAULT_PAIRING_MAX_ATTEMPTS;
  out.stdout.write(
    "\n============ ② 直接入力でペアリング ============\n" +
      `  接続先 : ${host}:${options.port}\n` +
      "  iPhone の Tailii →「ペアリング」→「直接入力」に上の host:port を入力\n" +
      "  → 接続すると両側に 6桁コードが出るので、一致を確認して承認\n" +
      `  → 6桁コードは表示から ${Math.round(sasTtlMs / 1000)} 秒有効。切れたら iPhone で「コードを再発行」\n` +
      "  （QR をスキャンした場合は何もしなくてよい — 自動で完了します）\n" +
      "================================================\n",
  );

  // 'connection' は常時受けてキューに積む（responder 実行中〜次の待受登録の隙間に届いた接続を
  // 取りこぼさないため）。maxConnections=1 なので同時 2 本目は Node が drop する。
  const inbox = new ConnectionInbox(server);
  const deadline = Date.now() + waitTotalMs;
  try {
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > maxAttempts) {
        out.stdout.write(
          `ペアリングの待受を終了しました（接続 ${maxAttempts} 回の上限）。再実行してください。\n`,
        );
        return 1;
      }
      const remaining = deadline - Date.now();
      const waitLine = new StatusLine(out.stdout);
      waitLine.start(() => `待受中…（残り ${formatRemaining(deadline - Date.now())}、Ctrl-C で終了）`);
      const socket = remaining > 0 ? await inbox.next(remaining) : null;
      if (socket === null) {
        waitLine.stop(
          `ペアリングの待受を終了しました（${formatRemaining(waitTotalMs)} 経過）。再実行してください。`,
        );
        return 0;
      }
      waitLine.stop(`iPhone から接続がありました（${attempt}/${maxAttempts} 回目）。`);

      // SAS 行はコードと残り時間を毎秒書き換える。confirm が通ったら（= registerClientKey /
      // legacy payload 生成の直前）行を確定させ、以降の通常出力が同じ行に混ざらないようにする。
      const sasLine = new StatusLine(out.stdout);
      let sasCode = "";
      let sasDeadline = 0;
      const settleSAS = (): void => {
        if (sasCode !== "") sasLine.stop(`ペアリングコード: ${sasCode}  （確認済み）`);
      };
      const result = await runPairingResponder(
        { readable: socket, writable: socket },
        {
          payloadJSON: () => {
            settleSAS();
            return options.payloadJSON();
          },
          payloadJSONNoKey: options.payloadJSONNoKey,
          psk: options.psk,
          registerClientKey: (line) => {
            settleSAS();
            options.registerClientKey(line);
          },
          sasTtlMs,
          ...(options.timing?.stepTimeoutMs !== undefined ? { timeoutMs: options.timing.stepTimeoutMs } : {}),
          displaySAS: (code) => {
            sasCode = code;
            sasDeadline = Date.now() + sasTtlMs;
            sasLine.start(() => `ペアリングコード: ${code}  （残り ${formatRemaining(sasDeadline - Date.now())}）`);
          },
        },
      );

      if (result.status === "paired") {
        settleSAS();
        out.stdout.write(
          result.clientKeyLine !== undefined
            ? "ペアリングが完了しました（iPhone 生成の鍵を登録・秘密鍵転送なし）。\n"
            : "ペアリングが完了しました。\n",
        );
        return 0;
      }
      const continues = attempt < maxAttempts;
      const tail = continues ? "" : "（接続回数の上限に達したため終了します）";
      if (result.reason === SAS_EXPIRED_REASON) {
        sasLine.stop(
          `ペアリングコード: ${sasCode}  は期限切れになりました。` +
            (continues ? "iPhone で「コードを再発行」を押すと新しいコードが出ます。" : tail),
        );
      } else {
        sasLine.stop();
        out.stderr.write(`ペアリングを中止しました: ${result.reason}${continues ? "（引き続き待ち受けます）" : tail}\n`);
      }
    }
  } finally {
    inbox.dispose();
    await closeServer(server);
  }
}

/** 'connection' を常時受けてキューに積み、`next()` で 1 本ずつ取り出す（待受の隙間の取りこぼし防止）。 */
class ConnectionInbox {
  private readonly queue: net.Socket[] = [];
  private waiter: ((socket: net.Socket | null) => void) | null = null;
  private readonly onConnection = (socket: net.Socket): void => {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(socket);
    } else {
      this.queue.push(socket);
    }
  };

  constructor(private readonly server: net.Server) {
    server.on("connection", this.onConnection);
  }

  /** 次の接続を返す。timeoutMs 以内に来なければ null。既に相手が去ったキュー内ソケットは読み飛ばす。 */
  next(timeoutMs: number): Promise<net.Socket | null> {
    while (this.queue.length > 0) {
      const socket = this.queue.shift()!;
      if (!socket.destroyed) return Promise.resolve(socket);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === onSocket) this.waiter = null;
        resolve(null);
      }, timeoutMs);
      const onSocket = (socket: net.Socket | null): void => {
        clearTimeout(timer);
        resolve(socket);
      };
      this.waiter = onSocket;
    });
  }

  dispose(): void {
    this.server.off("connection", this.onConnection);
    for (const socket of this.queue) socket.destroy();
    this.queue.length = 0;
    this.waiter = null;
  }
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
