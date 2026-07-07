// setup.ts
// tailii (TS host) — setup サブコマンド実装
// Swift スクリプト scripts/poc-host-setup.swift の移植（Moshi `host setup` 相当）。
//
// このホストでペアごとの ed25519 鍵を生成し、公開鍵を authorized_keys に登録、
// {host, port, user, 秘密鍵PEM}（+ v2 では sessionName/sessionCwd）を
// ペアリング payload として発行する。iPhone アプリはこれを QR スキャン / クリップボード貼付で取り込む。
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
//   --code                後方互換の無効フラグ（通常モードが常に直接入力サーバも起動するため）。
//   --emit-payload        副作用なし検証モード。keygen/QR/ファイル操作を行わず payload JSON を stdout に出すだけ。
//                         既存の鍵があれば読むが無くても擬似値で継続。
//
// 注意: 秘密鍵を payload に載せるため、表示した QR は信頼できる端末でのみスキャンすること。
//       リモートログイン(ON)が前提。公開鍵の authorized_keys 登録を行う。
//
// Swift 版との差分:
//   - QR は macOS 限定の PNG+open ではなく、ゼロ依存 `qrcode-terminal` でターミナルに直接描画する
//     （`npx` 実行・SSH 越しでもスキャン可能。クロスプラットフォーム）。
//   - LAN IP 検出は `ipconfig getifaddr` ではなく `os.networkInterfaces()`（en0/en1 優先、非内部 IPv4）。
//   - payload の JSON は Swift JSONEncoder `.prettyPrinted + .sortedKeys` と byte 一致で符号化する
//     （2スペース字下げ・`" : "` 区切り・キー辞書順・`/`→`\/` エスケープ）。golden 契約を維持。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import qrcode from "qrcode-terminal";
import { runPairingResponder } from "./pairingCode.js";

// MARK: - ペアリング payload の byte-exact 符号化

/** ペアリング payload の入力（v は sessionName の有無で 2/1 が決まる）。 */
export interface PairingPayloadInput {
  host: string;
  port: number;
  user: string;
  /** 秘密鍵 PEM 全文。 */
  key: string;
  /** 指定で v2。 */
  sessionName?: string;
  /** v2 のみ。未指定なら JSON から省略される。 */
  sessionCwd?: string;
}

/**
 * ペアリング payload を Swift `JSONEncoder`（`.prettyPrinted + .sortedKeys`）と byte 一致で符号化する。
 * 末尾改行は含めない（呼び出し側が付与）。golden `protocol/pairing-payload-v{1,2}.json` と契約整合。
 */
export function encodePairingPayload(input: PairingPayloadInput): string {
  const obj: Record<string, string | number> = {
    host: input.host,
    key: input.key,
    port: input.port,
    user: input.user,
    v: input.sessionName !== undefined ? 2 : 1,
  };
  if (input.sessionName !== undefined) {
    obj["sessionName"] = input.sessionName;
    // v2 でも cwd 未指定なら Swift の optional=nil と同じく JSON から省略する。
    if (input.sessionCwd !== undefined) obj["sessionCwd"] = input.sessionCwd;
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

  // --- 1) 鍵ペアを用意（無ければ生成） ---
  let keypair: EnsureKeypairResult;
  try {
    keypair = ensureKeypair(base, sshKeygenEd25519);
  } catch (error) {
    process.stderr.write(`鍵生成に失敗: ${String(error)}\n`);
    return 1;
  }
  process.stdout.write(
    keypair.status === "generated"
      ? "ed25519 鍵を生成しました。\n"
      : `既存の鍵を再利用: ${path.join(base, "poc_id_ed25519")}\n`,
  );

  // --- 2) 公開鍵を authorized_keys に登録 ---
  const sshDir = path.join(os.homedir(), ".ssh");
  try {
    const result = registerAuthorizedKey(sshDir, keypair.publicKeyLine);
    process.stdout.write(
      result === "added" ? "公開鍵を authorized_keys に登録しました。\n" : "公開鍵は登録済みです。\n",
    );
  } catch (error) {
    process.stderr.write(`authorized_keys 登録に失敗: ${String(error)}\n`);
    return 1;
  }

  // --- 3) ペアリング payload を構築（v1/v2） ---
  // 接続先は自動選定（Tailscale があれば優先・無ければ LAN）。--host で明示上書きも可。
  // ユーザーは経路（Tailscale か LAN か）を意識しなくてよい。
  const lanIP = args.host ?? detectPreferredIP();
  if (lanIP === "") {
    process.stderr.write("接続先 IP を取得できません（ネットワーク未接続?）\n");
  }
  const json = encodePairingPayload({
    host: lanIP,
    port: 22,
    user: username,
    key: keypair.privateKeyPem,
    ...(args.sessionName !== undefined ? { sessionName: args.sessionName } : {}),
    ...(args.sessionCwd !== undefined ? { sessionCwd: args.sessionCwd } : {}),
  });

  // --- 4) QR（スキャン用）を表示 ---
  const qr = await renderTerminalQR(json);
  const versionLine =
    args.sessionName !== undefined
      ? `  version : v2 (session)\n  session : ${args.sessionName}\n  cwd     : ${args.sessionCwd ?? "(未指定)"}`
      : "  version : v1";
  process.stdout.write(
    "\n================ ① QR でペアリング ================\n" +
      `${versionLine}\n` +
      `  host : ${lanIP}\n` +
      `  user : ${username}\n` +
      `  port : 22\n` +
      "  iPhone の TailiiPoC →「ペアリング」→「QR をスキャン」で下の QR を読む\n" +
      "  ※ 秘密鍵が含まれます。信頼できる端末でのみ取り込んでください\n" +
      "==================================================\n\n" +
      `${qr}\n`,
  );

  // --- 5) 直接入力（host:port + 6桁コード）用サーバを起動して待受 ---
  // 同じ setup で QR と直接入力の両方を提供する（コマンドを分けない）。
  // QR を使った場合はこの待受は不要なので Ctrl-C で終了してよい。
  return runCodePairingServer({
    payloadJSON: json,
    lanIP,
    sessionName: args.sessionName,
    sessionCwd: args.sessionCwd,
  });
}

/** payload をターミナル QR 文字列へ描画する（ゼロ依存 qrcode-terminal, small=密度重視）。 */
function renderTerminalQR(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (qr: string) => resolve(qr));
  });
}

interface CodePairingServerOptions {
  payloadJSON: string;
  lanIP: string;
  sessionName?: string;
  sessionCwd?: string;
}

async function runCodePairingServer(options: CodePairingServerOptions): Promise<number> {
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
    process.stderr.write(`直接入力サーバの起動に失敗: ${String(error)}\n`);
    return 1;
  }

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const host = options.lanIP === "" ? "0.0.0.0" : options.lanIP;
  process.stdout.write(
    "\n============ ② 直接入力でペアリング ============\n" +
      `  接続先 : ${host}:${port}\n` +
      "  iPhone の TailiiPoC →「ペアリング」→「直接入力」に上の host:port を入力\n" +
      "  → 接続すると両側に 6桁コードが出るので、一致を確認して承認\n" +
      "  （QR で済ませた場合はこの待受は不要 — Ctrl-C で終了してください）\n" +
      "================================================\n",
  );

  try {
    const socket = await acceptOneConnection(server, 300_000);
    if (socket === null) {
      // QR で完了済みのことも多いので、時間切れはエラー扱いにしない。
      process.stdout.write("直接入力の待受を終了しました（QR を使った場合は問題ありません）。\n");
      return 0;
    }

    server.close();
    const result = await runPairingResponder(
      { readable: socket, writable: socket },
      {
        payloadJSON: options.payloadJSON,
        displaySAS: (code) => process.stdout.write(`ペアリングコード: ${code}\n`),
      },
    );

    if (result.status === "paired") {
      process.stdout.write("ペアリングが完了しました。\n");
      return 0;
    }
    process.stderr.write(`ペアリングを中止しました: ${result.reason}\n`);
    return 1;
  } finally {
    await closeServer(server);
  }
}

function acceptOneConnection(server: net.Server, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.off("connection", onConnection);
      resolve(null);
    }, timeoutMs);
    const onConnection = (socket: net.Socket): void => {
      clearTimeout(timer);
      server.off("connection", onConnection);
      resolve(socket);
    };
    server.on("connection", onConnection);
  });
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
