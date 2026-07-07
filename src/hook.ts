// hook.ts
// tailii (TS host) — hook サブコマンド実装（Swift 版 Hook.swift の移植）
//
// Claude Code の PreToolUse / PostToolUse フック。stdin JSON の `hook_event_name` で分岐する。
//
// PreToolUse（ツール実行の唯一のゲート意思決定点）:
//   summary と構造化 diff（Write=create+全文 / Edit=edit+old/new）を生成し、
//   unix domain socket クライアントとして broker（=iPhone）へ approval_request（一意 id）を
//   送り、内部デッドライン内に approval_decision を受信して permissionDecision を stdout 出力。
//   決定はブロードキャストされるため自 id のみ受理する（5.4）。tool_input のパスが
//   画像拡張子なら pending キューへレコードを書く（リサイズせず＝デッドライン非影響）。
//
// connect 不能（アプリ背景/未起動）ブランチ:
//   即 deny せず背景 push（notifier 注入時のみ・このブランチのみ, 相互排他 7.1）→
//   内部デッドライン内で同一 SocketPath へ retry-connect（8.1）。接続できたら残り予算で
//   送出＋決定待ち（8.2）。デッドライン到達で安全側 deny（8.3）。
//
// PostToolUse（別呼び出し、ゲートしない）: ObservationLog に監査追記して exit 0（5.8）。
//
// 既定は常に deny（安全側）。connect 失敗・stdin 解析不能・id 不一致・非対応 v・
// undecodable 行・EOF・デッドラインのいずれでも deny を出力する。

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { makeProductionPushNotifier } from "./approvalPushNotifier.js";
import { ObservationLog, defaultObservationBase } from "./observationLog.js";
import { resolveSocketPath } from "./socketPath.js";
import { sleep } from "./sleep.js";
import {
  PROTOCOL_V1,
  decodeControlMessage,
  encodeControlMessage,
  type ToolDiff,
} from "./protocol.js";

// MARK: - 定数

/**
 * hook 内部デッドラインの既定値（秒）。settings の外部タイムアウト
 * （hookSettings.HOOK_EXTERNAL_TIMEOUT_SECONDS = 600）より**厳密に小さく**保つこと。
 * この順序により hook は外部打切り前に必ず permissionDecision（無応答時は deny）を
 * 出力でき、fall-through を回避する（Req 5.7、HookTimeoutOrderingTests が検証）。
 * connect 不能時は背景 push で気づかせたうえで、人間が通知タップ→cold launch→
 * SSH 再接続→承認判断を完了できる猶予を与える（90→540 に延長, Req 8.4）。
 */
export const HOOK_INTERNAL_DEADLINE_SECONDS = 540;

/** connect 不能時の retry-connect ポーリング間隔の既定値（秒）。 */
export const HOOK_RETRY_CONNECT_INTERVAL_SECONDS = 1.0;

/** pending 投入対象とする画像拡張子（小文字, 8.5）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"]);

/** hook の画像 pending キュー既定ベース（`~/.tailii/images/pending`）。 */
export function defaultImagesPendingBase(): string {
  return path.join(os.homedir(), ".tailii", "images", "pending");
}

// MARK: - 背景 push 注入点

/** connect 不能時に送る最小 push リクエスト（diff/秘密なし, 2.3）。 */
export interface ApprovalPushRequest {
  approvalId: string;
  tool: string;
  session: string;
}

/**
 * 背景 push 統括の注入点（Swift 版 ApprovalPushNotifying 相当）。
 * 送信可否は deny 判断に影響しない（結果は捨てる）。本番実装は push-token 移植時に配線する。
 */
export type ApprovalPushNotifier = (
  request: ApprovalPushRequest,
  timeLimitMs: number,
) => Promise<void>;

// MARK: - テスタブルコア

export interface RunHookOptions {
  stdinData: Buffer;
  /** 接続する unix socket パス。null は接続不能と同義（PreToolUse は即 deny）。 */
  socketPath: string | null;
  /** 内部デッドライン（秒）。 */
  deadlineSeconds: number;
  /** セッション名（ObservationLog / push のキー）。既定 "default"。 */
  session?: string;
  /** ObservationLog のベース（注入）。省略時は監査追記をスキップ。 */
  observationBase?: string;
  /** 画像 pending キューのベース（注入）。省略時は pending 投入をスキップ。 */
  imagesPendingBase?: string;
  /** connect 不能時に背景 push を送る notifier。省略時は push を試みない。 */
  notifier?: ApprovalPushNotifier;
  /** push 送信部の時間上限（ms）。gate 非阻害のためこの時間で打ち切る。既定 5000。 */
  notifierTimeLimitMs?: number;
  /** connect 不能ブランチでの retry-connect ポーリング間隔（秒）。既定 1.0。 */
  retryConnectIntervalSeconds?: number;
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
}

/** hook の本体（テスタブル・完全版）。stdin JSON の `hook_event_name` で分岐する。 */
export async function runHookCore(options: RunHookOptions): Promise<HookRunResult> {
  const session = options.session ?? "default";
  const deadlineSeconds = options.deadlineSeconds;
  const retryIntervalSeconds =
    options.retryConnectIntervalSeconds ?? HOOK_RETRY_CONNECT_INTERVAL_SECONDS;
  const parsed = parsePreToolUse(options.stdinData);

  // --- 0. hook_event_name で分岐 ---
  if (parsed.eventName === "PostToolUse") {
    return runPostToolUse(parsed, session, options.observationBase);
  }

  // === 以降 PreToolUse（既定） ===
  const summary = buildSummary(parsed.toolName, parsed.toolInput);
  const diff = buildDiff(parsed.toolName, parsed.toolInput);

  // 単一の内部デッドライン。push→retry-connect→send→waitForDecision の全フェーズが
  // この 1 本の予算を共有する（Req 8.1）。
  const deadlineAtMs = Date.now() + deadlineSeconds * 1000;

  if (options.socketPath === null) {
    // socket パス未決定は接続不能と同義。retry-connect の余地もないため即 deny。
    return deny("iPhone unavailable (no socket path)");
  }

  const socket = await connectUnixSocket(options.socketPath);
  if (socket) {
    // 接続済み（アプリ前面）。従来経路をそのまま実行する（push しない, 7.1）。
    return sendRequestAndReflect(socket, parsed, summary, diff, options, deadlineAtMs);
  }

  // === connect 不能ブランチ（Req 2.1 / 8.1〜8.3） ===
  if (options.notifier) {
    await sendBackgroundPush(
      options.notifier,
      { approvalId: randomUUID(), tool: parsed.toolName, session },
      options.notifierTimeLimitMs ?? 5000,
    );
  }

  const reconnected = await retryConnect(options.socketPath, deadlineAtMs, retryIntervalSeconds);
  if (reconnected) {
    return sendRequestAndReflect(reconnected, parsed, summary, diff, options, deadlineAtMs);
  }

  // 内部デッドライン内に一度も再接続できなかった → 安全側 deny（8.3）。
  return deny(`iPhone unavailable (no reconnect within ${Math.round(deadlineSeconds)}s)`);
}

// MARK: - approval_request 送出＋決定反映（connect 成功／再接続で共有）

async function sendRequestAndReflect(
  socket: net.Socket,
  parsed: ParsedPreToolUse,
  summary: string,
  diff: ToolDiff | undefined,
  options: RunHookOptions,
  deadlineAtMs: number,
): Promise<HookRunResult> {
  try {
    const requestId = randomUUID();

    // 画像パス検出 → pending キュー投入（非ブロッキング・リサイズなし, 8.1/8.2/8.5）。
    if (options.imagesPendingBase !== undefined) {
      enqueuePendingImages(parsed.toolInput, requestId, options.imagesPendingBase);
    }

    const encoded = encodeControlMessage({
      type: "approval_request",
      v: PROTOCOL_V1,
      id: requestId,
      tool: parsed.toolName,
      summary,
      cwd: parsed.cwd,
      ...(diff !== undefined ? { diff } : {}),
    });
    try {
      socket.write(encoded + "\n");
    } catch {
      return deny("iPhone disconnected (write failed)");
    }

    // 残りデッドライン内で approval_decision を待つ（自 id のみ受理, 5.4）。
    const outcome = await waitForDecision(socket, requestId, deadlineAtMs);
    switch (outcome.kind) {
      case "allow":
        return allow(outcome.reason ?? "Approved on iPhone");
      case "deny":
        return deny(outcome.reason ?? "Denied on iPhone");
      case "timeout":
        return deny(`No response within ${Math.round(options.deadlineSeconds)}s`);
      case "disconnected":
        return deny("iPhone disconnected");
    }
  } finally {
    socket.destroy();
  }
}

// MARK: - 決定待機

type DecisionOutcome =
  | { kind: "allow" | "deny"; reason?: string }
  | { kind: "timeout" }
  | { kind: "disconnected" };

/**
 * デッドライン内で approval_decision を1行ずつ受信し、id が一致する有効決定を待つ。
 * id 不一致・undecodable・非対応 v の行はスキップして読み続ける（残り時間内）。
 * EOF/エラー → disconnected。デッドライン超過 → timeout。
 */
function waitForDecision(
  socket: net.Socket,
  expectedId: string,
  deadlineAtMs: number,
): Promise<DecisionOutcome> {
  return new Promise((resolve) => {
    const remaining = deadlineAtMs - Date.now();
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;

    const settle = (outcome: DecisionOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onDisconnect);
      socket.removeListener("error", onDisconnect);
      socket.removeListener("close", onDisconnect);
      resolve(outcome);
    };

    const onData = (chunk: Buffer): void => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let idx: number;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        const outcome = evaluateLine(line, expectedId);
        if (outcome !== null) {
          settle(outcome);
          return;
        }
      }
    };
    const onDisconnect = (): void => settle({ kind: "disconnected" });

    const timer = setTimeout(() => settle({ kind: "timeout" }), Math.max(0, remaining));
    if (remaining <= 0) {
      // デッドライン超過 → 即 timeout（安全側 deny）。
      settle({ kind: "timeout" });
      return;
    }
    socket.on("data", onData);
    socket.once("end", onDisconnect);
    socket.once("error", onDisconnect);
    socket.once("close", onDisconnect);
  });
}

/**
 * 受信した1行を評価する。id 一致の approval_decision → DecisionOutcome。
 * それ以外（id 不一致・型不一致・デコード失敗・空行）→ null（無視して読み続ける）。
 */
function evaluateLine(line: Buffer, expectedId: string): DecisionOutcome | null {
  // 末尾 CR 除去（NDJSON は \n 区切りだが CRLF 耐性のため）。
  const trimmed =
    line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
  if (trimmed.length === 0) return null;

  let message;
  try {
    message = decodeControlMessage(trimmed);
  } catch {
    return null;
  }
  if (message.type !== "approval_decision") return null;
  if (message.id !== expectedId) return null;
  return message.reason !== undefined
    ? { kind: message.decision, reason: message.reason }
    : { kind: message.decision };
}

// MARK: - unix socket クライアント / retry-connect

/** unix domain socket に接続し、接続済み socket を返す。失敗時は null（→ 安全側 deny）。 */
function connectUnixSocket(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      // 決定待機中の error は waitForDecision が disconnected として扱う。
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * 内部デッドライン内で同一 unix socket パスへ再接続を試行する（8.1）。
 * 接続できた socket を返す。デッドライン到達まで一度も接続できなければ null（8.3）。
 */
async function retryConnect(
  socketPath: string,
  deadlineAtMs: number,
  intervalSeconds: number,
): Promise<net.Socket | null> {
  const intervalMs = Math.max(0, Math.min(intervalSeconds, 3600) * 1000);
  for (;;) {
    const socket = await connectUnixSocket(socketPath);
    if (socket) return socket;
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(intervalMs, remaining));
  }
}

// MARK: - 背景 push 送出（connect 不能ブランチのみ）

/** 背景 push を送出する。timeLimit で打ち切り、成否は deny 判断に影響しない。 */
async function sendBackgroundPush(
  notifier: ApprovalPushNotifier,
  request: ApprovalPushRequest,
  timeLimitMs: number,
): Promise<void> {
  await Promise.race([notifier(request, timeLimitMs).catch(() => {}), sleep(timeLimitMs)]);
}

// MARK: - PostToolUse 監査（5.8）

function runPostToolUse(
  parsed: ParsedPreToolUse,
  session: string,
  observationBase: string | undefined,
): HookRunResult {
  if (observationBase === undefined) {
    // 監査ベース未注入時は追記できないが、PostToolUse は失敗させない（exit 0）。
    return { exitCode: 0, stdout: "{}" };
  }
  const log = new ObservationLog(observationBase);
  // 決定は tool_response の permissionDecision（無ければ実行済み=allow とみなす）。
  const decision = parsed.postDecision ?? "allow";
  try {
    log.append(
      { kind: "toolExecuted", id: parsed.toolUseId, tool: parsed.toolName, decision },
      session,
      Math.floor(Date.now() / 1000),
    );
  } catch {
    // 監査追記失敗でも PostToolUse は失敗させない。
  }
  return { exitCode: 0, stdout: "{}" };
}

// MARK: - 画像 pending 投入（8.1/8.2/8.5）

/** tool_input のパスが画像拡張子なら pending へ `{imageId, path, relatedApprovalId}` を書く。 */
function enqueuePendingImages(
  toolInput: Record<string, unknown>,
  relatedApprovalId: string,
  base: string,
): void {
  const paths = imagePaths(toolInput);
  if (paths.length === 0) return;
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch {
    // ディレクトリ作成失敗は握り潰す（承認を阻害しない）。
  }
  for (const imagePath of paths) {
    const imageId = randomUUID();
    // キーは辞書順（imageId < path < relatedApprovalId）— Swift 版 .sortedKeys と同一。
    const record = { imageId, path: imagePath, relatedApprovalId };
    try {
      fs.writeFileSync(path.join(base, `${imageId}.json`), JSON.stringify(record));
    } catch {
      // 書き込み失敗は握り潰す（承認を阻害しない）。
    }
  }
}

/** tool_input から画像拡張子を持つパス文字列を抽出する（8.5）。 */
function imagePaths(toolInput: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = toolInput[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const ext = path.extname(value).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) result.push(value);
  }
  return result;
}

// MARK: - summary / diff 生成（6.2/6.3）

/** tool_input から1行の summary を生成する。 */
function buildSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": {
      const command = toolInput["command"];
      if (typeof command === "string" && command.length > 0) return oneLine(command);
      return "Run a Bash command";
    }
    case "Write": {
      const filePath = toolInput["file_path"];
      if (typeof filePath === "string" && filePath.length > 0) return `Write file: ${filePath}`;
      return "Write a file";
    }
    case "Edit": {
      const filePath = toolInput["file_path"];
      if (typeof filePath === "string" && filePath.length > 0) return `Edit file: ${filePath}`;
      return "Edit a file";
    }
    default:
      return `Run tool: ${toolName}`;
  }
}

/** 文字列を1行に正規化する（改行を空白へ畳み込み、前後空白を除去）。 */
function oneLine(s: string): string {
  return s.replaceAll("\n", " ").replaceAll("\r", " ").trim();
}

/** tool_input から構造化 diff を生成する（Write=create+全文 / Edit=edit+old/new / 他は undefined）。 */
function buildDiff(toolName: string, toolInput: Record<string, unknown>): ToolDiff | undefined {
  const filePath = toolInput["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) return undefined;
  switch (toolName) {
    case "Write": {
      const content = toolInput["content"];
      return { kind: "create", path: filePath, newText: typeof content === "string" ? content : "" };
    }
    case "Edit": {
      const oldString = toolInput["old_string"];
      const newString = toolInput["new_string"];
      return {
        kind: "edit",
        path: filePath,
        oldString: typeof oldString === "string" ? oldString : "",
        newString: typeof newString === "string" ? newString : "",
      };
    }
    default:
      return undefined;
  }
}

// MARK: - stdin パース

interface ParsedPreToolUse {
  eventName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  /** 監査 id（`tool_use_id` があれば優先、無ければ `session_id`）。秘密ではない。 */
  toolUseId: string;
  /** PostToolUse の tool_response 内 permissionDecision（あれば）。 */
  postDecision?: string;
}

/** フック JSON を寛容にパースする。欠落フィールドは安全な既定値で補う。 */
function parsePreToolUse(data: Buffer): ParsedPreToolUse {
  const parsed: ParsedPreToolUse = {
    eventName: "PreToolUse",
    toolName: "Unknown",
    toolInput: {},
    cwd: "",
    toolUseId: "",
  };
  if (data.length === 0) return parsed;
  let obj: unknown;
  try {
    obj = JSON.parse(data.toString("utf8"));
  } catch {
    return parsed;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return parsed;
  const raw = obj as Record<string, unknown>;
  if (typeof raw["hook_event_name"] === "string") parsed.eventName = raw["hook_event_name"];
  if (typeof raw["tool_name"] === "string") parsed.toolName = raw["tool_name"];
  const toolInput = raw["tool_input"];
  if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
    parsed.toolInput = toolInput as Record<string, unknown>;
  }
  if (typeof raw["cwd"] === "string") parsed.cwd = raw["cwd"];
  if (typeof raw["tool_use_id"] === "string" && raw["tool_use_id"].length > 0) {
    parsed.toolUseId = raw["tool_use_id"];
  } else if (typeof raw["session_id"] === "string") {
    parsed.toolUseId = raw["session_id"];
  }
  const response = raw["tool_response"];
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const decision = (response as Record<string, unknown>)["permissionDecision"];
    if (typeof decision === "string") parsed.postDecision = decision;
  }
  return parsed;
}

// MARK: - permissionDecision 出力契約

/**
 * 出力契約（stdout, exit 0）:
 * `{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *    "permissionDecision": "allow"|"deny", "permissionDecisionReason": "<reason>" } }`
 * キーは辞書順（Swift 版 .sortedKeys と同一の並び）。
 */
function decisionJson(permission: "allow" | "deny", reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: permission,
      permissionDecisionReason: reason,
    },
  });
}

function allow(reason: string): HookRunResult {
  return { exitCode: 0, stdout: decisionJson("allow", reason) };
}

function deny(reason: string): HookRunResult {
  return { exitCode: 0, stdout: decisionJson("deny", reason) };
}

// MARK: - CLI エントリポイント

/**
 * hook サブコマンドのエントリポイント。
 * 引数: `--socket <path>` | `--session <name>` | `--deadline <seconds>` |
 * `--retry-interval <seconds>` | `--images-dir <path>`。
 * 常に exit 0（Claude Code は stdout の JSON を読む）。
 *
 * connect 不能ブランチでは本番 ApprovalPushNotifier を注入し、背景 push で気づかせる
 * （相互排他 7.1 は runHookCore が担保）。実際に送るかは notifier が config/token の有無で
 * 判断する（未設定なら送らず観測記録, 3.5/6.4）。送信可否は deny 判断に影響しない。
 */
export async function runHookCommand(args: string[]): Promise<number> {
  let socketArg: string | null = null;
  let sessionArg: string | null = null;
  let imagesDirArg: string | null = null;
  let deadlineSeconds = HOOK_INTERNAL_DEADLINE_SECONDS;
  let retryIntervalSeconds = HOOK_RETRY_CONNECT_INTERVAL_SECONDS;
  // codex モード: codex は PreToolUse フックの permissionDecision で "allow"/"ask" を
  // 「unsupported」として拒否し、有効なのは "deny"（またはコード2）だけ。よって
  // 承認（allow）時は decision JSON を出さず exit 0 無出力＝続行にし、拒否時のみ deny JSON を出す。
  // 承認ゲートは codex がフック完了を同期ブロックで待つ性質で成立する（既定 timeout 600s > 内部 540s）。
  let agent: "claude" | "codex" = "claude";

  for (let i = 0; i < args.length; i += 1) {
    const next = (): string | null => (i + 1 < args.length ? args[++i]! : null);
    switch (args[i]) {
      case "--socket":
        socketArg = next();
        break;
      case "--session":
        sessionArg = next();
        break;
      case "--agent": {
        const raw = next();
        if (raw === "codex" || raw === "claude") agent = raw;
        break;
      }
      case "--deadline": {
        const raw = next();
        const value = raw === null ? Number.NaN : Number.parseFloat(raw);
        if (Number.isFinite(value)) deadlineSeconds = value;
        break;
      }
      case "--retry-interval": {
        const raw = next();
        const value = raw === null ? Number.NaN : Number.parseFloat(raw);
        if (Number.isFinite(value)) retryIntervalSeconds = value;
        break;
      }
      case "--images-dir":
        imagesDirArg = next();
        break;
      default:
        break;
    }
  }

  let socketPath: string | null = null;
  if (socketArg !== null) {
    socketPath = socketArg;
  } else if (sessionArg !== null) {
    try {
      socketPath = resolveSocketPath(sessionArg);
    } catch {
      socketPath = null;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const { exitCode, stdout } = await runHookCore({
    stdinData: Buffer.concat(chunks),
    socketPath,
    deadlineSeconds,
    session: sessionArg ?? "default",
    observationBase: defaultObservationBase(),
    imagesPendingBase:
      imagesDirArg !== null ? path.join(imagesDirArg, "pending") : defaultImagesPendingBase(),
    notifier: makeProductionPushNotifier(),
    retryConnectIntervalSeconds: retryIntervalSeconds,
  });
  const out = hookStdoutForAgent(agent, stdout);
  if (out !== null) process.stdout.write(out + "\n");
  return exitCode;
}

/**
 * エージェント別にフックが実際に stdout へ書く文字列を決める（TESTABLE）。
 * claude: 生成した decision JSON をそのまま出す。
 * codex : allow/ask を「unsupported」として拒否するため、承認（allow 決定）時は無出力（null）で
 *         exit 0 続行にする。拒否（deny）や監査出力はそのまま出す（deny JSON は codex も解釈する）。
 */
export function hookStdoutForAgent(agent: "claude" | "codex", stdout: string): string | null {
  if (agent === "codex" && stdout.includes('"permissionDecision":"allow"')) {
    return null;
  }
  return stdout;
}
