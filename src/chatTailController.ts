// chatTailController.ts
// tailii (TS host) — セッション連動の会話出力 tail 制御
// Swift 版 ChatTailController.swift の移植。
// セッションを開いた（session_reattach / session_start）タイミングで transcript を解決して
// tail し、生成された chat_output を engine チャネル（LineWriter）へ流す。新しいセッションを
// 開いたら前の tail を止めて切り替える。engine チャネル断で stop()。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LineWriter } from "./lineWriter.js";
import type { ImageService } from "./imageService.js";
import { TranscriptTailer } from "./transcriptTailer.js";
import { SubagentTailer } from "./subagentTailer.js";
import {
  readSubagentTranscript,
  type SubagentTranscriptResult,
} from "./subagentTranscript.js";
import { CodexRolloutTailer } from "./codexRolloutTailer.js";
import { canonicalPath } from "./paths.js";

/** tail 対象エージェント種別（claude=既定 / codex=Codex CLI）。 */
export type ChatAgent = "claude" | "codex";

/** セッション連動で transcript を tail し chat_output を engine チャネルへ流す制御子。 */
export class ChatTailController {
  private readonly writer: LineWriter;
  private readonly tailer: TranscriptTailer;
  private readonly subagentTailer: SubagentTailer;
  private readonly projectsRoot: string;
  /** チャット添付（user 発話の `@"path"` / Tailii upload path）のサムネ発行に使う。 */
  private readonly imageService: ImageService | null;
  /** subagent_node の送出可否を判断する negotiated protocol version。 */
  private readonly protocolVersion: () => number;
  /** 既定エージェント（open で明示指定が無いときのフォールバック）。 */
  private readonly agent: ChatAgent;
  /** 現在 open 中のセッションのエージェント（open 毎に確定。per-session 切替に対応）。 */
  private openAgent: ChatAgent;
  /** codex モードの rollout tailer（agent==="codex" のときのみ使用）。 */
  private readonly codexTailer: CodexRolloutTailer;

  private abortController: AbortController | null = null;
  private currentPump: Promise<void> | null = null;
  private currentSubagentPump: Promise<void> | null = null;
  /** 現在 tail 中の解決入力（usage 集計が同じ規則で対象 jsonl を解決するために保持）。 */
  private currentDir: string | null = null;
  private currentPreferred: string | null = null;
  private currentNewerThanMs: number | null = null;
  /** open 時点で解決できた tail 対象 jsonl（同一会話への張り直しスキップ判定に使う）。 */
  private currentResolvedPath: string | null = null;

  constructor(options: {
    writer: LineWriter;
    tailer: TranscriptTailer;
    subagentTailer?: SubagentTailer;
    projectsRoot: string;
    imageService?: ImageService | null;
    protocolVersion?: () => number;
    agent?: ChatAgent;
    codexTailer?: CodexRolloutTailer;
  }) {
    this.writer = options.writer;
    this.tailer = options.tailer;
    this.subagentTailer = options.subagentTailer ?? new SubagentTailer();
    this.projectsRoot = options.projectsRoot;
    this.imageService = options.imageService ?? null;
    this.protocolVersion = options.protocolVersion ?? (() => 1);
    this.agent = options.agent ?? "claude";
    this.openAgent = this.agent;
    this.codexTailer =
      options.codexTailer ?? new CodexRolloutTailer({ tailIndefinitely: true, emitReplayDoneMarker: true });
  }

  /** 全文取得要求向けに、現在の subagent transcript パスを解決する。 */
  subagentTranscriptPath(nodeId: string): string | null {
    return this.subagentTailer.jsonlPath(nodeId);
  }

  /** Hub からのオンデマンド要求に、現在 tail 中のノード全文を返す。 */
  subagentTranscript(nodeId: string): SubagentTranscriptResult {
    return readSubagentTranscript(this.subagentTranscriptPath(nodeId));
  }

  /**
   * `cwd` からそのセッションの project dir を解決し、transcript tail を開始/切替する。
   * 同一会話（解決先 jsonl が同じ）への張り直しはスキップする。
   */
  open(
    cwd: string,
    preferredSessionId: string | null,
    newerThanMs: number | null = null,
    agent: ChatAgent = this.agent,
  ): void {
    if (!cwd) {
      ChatTailController.diag("open skipped: empty cwd");
      return;
    }
    this.openAgent = agent;
    if (agent === "codex") {
      this.openCodex(cwd, preferredSessionId, newerThanMs);
      return;
    }
    // claude はシンボリックリンクを解決した canonical パスで project slug を作る
    //（例 /tmp → /private/tmp）。tail も同じく解決してから slug 化する。
    const canonicalCwd = canonicalPath(cwd);
    const slug = canonicalCwd.replaceAll("/", "-");
    const dir = path.join(this.projectsRoot, slug);
    const dirExists = fs.existsSync(dir);
    ChatTailController.diag(
      `open cwd=${cwd} preferred=${preferredSessionId ?? "nil"} dir=${dir} dirExists=${dirExists}`,
    );

    const resolvedNow = TranscriptTailer.resolveJsonl(dir, preferredSessionId, newerThanMs);
    if (resolvedNow !== null && this.currentPump !== null && resolvedNow === this.currentResolvedPath) {
      ChatTailController.diag(`open skipped: same conversation already tailing (${resolvedNow})`);
      return;
    }

    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    this.currentDir = dir;
    this.currentPreferred = preferredSessionId;
    this.currentNewerThanMs = newerThanMs;
    this.currentResolvedPath = resolvedNow;

    const { writer, tailer, subagentTailer, imageService, protocolVersion } = this;
    this.currentPump = (async () => {
      ChatTailController.diag(
        `tail task started for dir=${dir} newerThan=${newerThanMs === null ? "nil" : String(newerThanMs)}`,
      );
      let count = 0;
      try {
        for await (const message of tailer.streamProjectDir(
          dir,
          preferredSessionId,
          newerThanMs,
          ac.signal,
        )) {
          if (ac.signal.aborted) {
            ChatTailController.diag(`tail cancelled (emitted ${count})`);
            break;
          }
          // AskUserQuestion のライフサイクルは hook relay（question_event → engine）が唯一の
          // ソース。Claude Code は設問が未回答の間 transcript に tool_use 行を書かない
          // （v2.1.206 実測）ため、tail に現れる question_prompt/question_dismiss は常に
          // 「回答済みの残骸」であり、履歴 replay や回答時 flush のたびに現行の設問シートを
          // 上書き・消灯してしまう（再オープン時にモーダルが一瞬出て消えるバグ）。転送しない。
          if (message.type === "question_prompt" || message.type === "question_dismiss") {
            continue;
          }
          count += 1;
          if (count <= 3 || count % 25 === 0) ChatTailController.diag(`emit chat_output #${count}`);
          try {
            writer.write(message);
            // user 発話中の添付画像（@"path" / Tailii upload path）は
            // サムネ（image_available）を後続で発行し、
            // iOS にインライン表示させる（chat-attachments）。id は決定的（att-<streamId>-<n>）。
            if (imageService !== null && message.type === "chat_output" && message.role === "user") {
              const paths = ChatTailController.attachmentImagePaths(message.text);
              for (let n = 0; n < paths.length; n += 1) {
                const available = await imageService.makeAvailable(
                  paths[n]!,
                  `att-${message.streamId}-${n}`,
                );
                if (available !== null) writer.write(available);
              }
            }
            // Read ツールで画像ファイルを読んだら、そのサムネ（image_available）を後続で発行し
            // iOS にインライン表示させる（既存 chat-attachments と同じ描画経路を再利用）。
            // id は tool_use id 由来で決定的（read-<id>）→ 再 tail/再オープンでも二重挿入されない。
            if (imageService !== null && message.type === "tool_activity") {
              const readPath = ChatTailController.readImagePath(message.activity);
              if (readPath !== null) {
                const available = await imageService.makeAvailable(
                  readPath,
                  `read-${message.activity.id}`,
                );
                if (available !== null) writer.write(available);
              }
            }
          } catch (error) {
            ChatTailController.diag(`write failed at #${count}: ${String(error)}`);
            process.stderr.write(
              `[tailii-host engine] chat_output 書込失敗（tail 停止）: ${String(error)}\n`,
            );
            break;
          }
        }
      } finally {
        ChatTailController.diag(`tail stream ended (emitted ${count})`);
      }
    })();

    this.currentSubagentPump = (async () => {
      try {
        for await (const message of subagentTailer.streamProjectDir(
          dir,
          preferredSessionId,
          newerThanMs,
          ac.signal,
        )) {
          if (ac.signal.aborted) break;
          if (protocolVersion() < 2) continue;
          try {
            writer.write(message);
          } catch (error) {
            ChatTailController.diag(`subagent_node 書込失敗: ${String(error)}`);
            process.stderr.write(
              `[tailii-host engine] subagent_node 書込失敗（tail 停止）: ${String(error)}\n`,
            );
            break;
          }
        }
      } finally {
        ChatTailController.diag("subagent tail stream ended");
      }
    })();
  }

  /**
   * codex モードの tail 開始/切替。claude の slug/subagent/添付は使わず、
   * cwd から rollout を解決して chat_output を流す。同一 rollout への張り直しはスキップする。
   */
  private openCodex(
    cwd: string,
    preferredSessionId: string | null,
    newerThanMs: number | null,
  ): void {
    const resolvedNow = this.codexTailer.resolve(cwd, newerThanMs, preferredSessionId);
    if (resolvedNow !== null && this.currentPump !== null && resolvedNow === this.currentResolvedPath) {
      ChatTailController.diag(`openCodex skipped: same rollout already tailing (${resolvedNow})`);
      return;
    }

    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    this.currentDir = cwd;
    this.currentPreferred = preferredSessionId;
    this.currentNewerThanMs = newerThanMs;
    this.currentResolvedPath = resolvedNow;
    this.currentSubagentPump = null;

    const { writer, codexTailer } = this;
    ChatTailController.diag(
      `openCodex cwd=${cwd} preferred=${preferredSessionId ?? "nil"} newerThan=${newerThanMs === null ? "nil" : String(newerThanMs)} resolved=${resolvedNow ?? "nil"}`,
    );
    this.currentPump = (async () => {
      let count = 0;
      try {
        for await (const message of codexTailer.streamForCwd(
          cwd,
          newerThanMs,
          ac.signal,
          preferredSessionId,
        )) {
          if (ac.signal.aborted) break;
          count += 1;
          if (count <= 3 || count % 25 === 0) ChatTailController.diag(`emit codex chat_output #${count}`);
          try {
            writer.write(message);
          } catch (error) {
            ChatTailController.diag(`codex write failed at #${count}: ${String(error)}`);
            break;
          }
        }
      } finally {
        ChatTailController.diag(`codex tail stream ended (emitted ${count})`);
      }
    })();
  }

  /** 画像として扱う拡張子集合（小文字・ドットなし）。添付検出と Read サムネ判定で共有。 */
  private static readonly IMAGE_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif",
  ]);

  /**
   * user 発話テキストから添付「画像」ファイルの絶対パスを抽出する（chat-attachments, TESTABLE）。
   * `@"/path with space.png"`（引用形式）、`@/path/to/file.png`（非引用）に加え、
   * iOS の添付チップが本文へ合成する裸の `~/.tailii/uploads/<name>` も対象にする。
   * 裸パスは Tailii 管理配下に限定し、通常本文の任意の画像パスを添付と誤認しない。
   */
  static attachmentImagePaths(text: string): string[] {
    const paths: string[] = [];
    for (const match of text.matchAll(/@"(\/[^"]+)"/g)) {
      if (match[1] !== undefined) paths.push(match[1]);
    }
    for (const match of text.matchAll(/@(\/[^\s"]+)/g)) {
      if (match[1] !== undefined) paths.push(match[1]);
    }
    // MessageInputBar.composeOutgoing は upload 済みパスを @ なしで本文先頭へ置く。
    // ファイル名は iOS 側で安全な文字へ正規化済みなので、空白/引用符を境界に抽出できる。
    for (const match of text.matchAll(
      /(?:^|[\s"])(\/(?:[^\s"]*\/)?\.tailii\/uploads\/[^\s"]+)/g,
    )) {
      if (match[1] !== undefined) paths.push(match[1]);
    }
    const seen = new Set<string>();
    return paths.filter((p) => {
      const ext = path.extname(p).slice(1).toLowerCase();
      if (!ChatTailController.IMAGE_EXTENSIONS.has(ext)) return false;
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
  }

  /**
   * Read ツールの tool_activity が「画像ファイル」を対象にしているとき、その絶対パスを返す
   * （chat-inline-read-image, TESTABLE）。Read 以外・パス無し・非画像拡張子は null。
   */
  static readImagePath(activity: { name: string; file?: string }): string | null {
    if (activity.name !== "Read") return null;
    const file = activity.file;
    if (typeof file !== "string" || file.length === 0) return null;
    const ext = path.extname(file).slice(1).toLowerCase();
    return ChatTailController.IMAGE_EXTENSIONS.has(ext) ? file : null;
  }

  /** 現在 tail 中の会話 jsonl の絶対パスを解決して返す（usage 集計用）。未開始・未出現は null。 */
  currentTranscriptPath(): string | null {
    if (this.currentDir === null) return null;
    // codex の usage 集計は claude 用パーサと非互換のため対象外（null）。open 中の agent で判定。
    if (this.openAgent === "codex") return null;
    return TranscriptTailer.resolveJsonl(
      this.currentDir,
      this.currentPreferred,
      this.currentNewerThanMs,
    );
  }

  /**
   * 現在 tail 中の codex rollout の絶対パス（usage 集計用, codex-input）。
   * codex で tail 中かつ rollout 解決済みのときのみ返す。それ以外（claude/未解決）は null。
   */
  currentCodexRolloutPath(): string | null {
    if (this.openAgent !== "codex") return null;
    return this.currentResolvedPath;
  }

  /**
   * 現在 open 中の tail エージェント種別（usage/status の分岐用）。
   *
   * usage_request は「rollout が解決済みか」ではなく「開いている会話が codex か」で分岐する必要がある。
   * codex 会話で rollout 未解決のときに claude 分岐へ落ちると、Claude の OAuth プラン使用量
   * （＝Claude の状態）が codex 会話に表示されてしまうため（2026-07-07 ユーザー指摘）。
   */
  currentAgent(): ChatAgent {
    return this.openAgent;
  }

  /**
   * kill された tmux セッションのメタから、その会話を tail 中なら tail を停止する。
   *
   * tail を生かしたままだと、次の再オープン（session_start）の `open()` が
   * 「同一会話を tail 中」としてスキップして履歴を再生しない。kill 後の再オープンは
   * tmux 名が変わり得る（生存別名 → `cs-<id>`）ためクライアントのキャッシュも外れ、
   * 何も表示されなくなる。kill の全経路（session_kill / idle reaper / 処理完了時 kill）
   * から呼ぶこと。
   */
  stopIfSession(meta: { cwd: string; agent?: ChatAgent; claudeSessionId?: string } | null): void {
    if (meta === null || this.currentPump === null) return;
    if (this.openAgent === "codex") {
      // codex は会話 id 束縛を持たないため cwd 一致で判定する（openCodex の解決単位）。
      if (meta.agent === "codex" && meta.cwd === this.currentDir) {
        ChatTailController.diag(`stopIfSession: codex tail 停止 cwd=${meta.cwd}`);
        this.stop();
      }
      return;
    }
    if (meta.claudeSessionId !== undefined && meta.claudeSessionId === this.currentPreferred) {
      ChatTailController.diag(`stopIfSession: claude tail 停止 claudeSessionId=${meta.claudeSessionId}`);
      this.stop();
    }
  }

  /** tail を停止する（engine チャネル断）。 */
  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.currentPump = null;
    this.currentSubagentPump = null;
    this.currentDir = null;
    this.currentPreferred = null;
    this.currentNewerThanMs = null;
    this.currentResolvedPath = null;
  }

  /** 診断ログ（`~/.tailii/engine-tail.log` に追記）。失敗は握り潰す。 */
  static diag(message: string): void {
    try {
      const dir = path.join(os.homedir(), ".tailii");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "engine-tail.log"), `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // 診断ログの失敗は無視。
    }
  }
}
