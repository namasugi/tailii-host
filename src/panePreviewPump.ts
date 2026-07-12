// panePreviewPump.ts
// tailii (TS host) — foreground tmux pane のライブプレビュー配信。

import type { LineWriter } from "./lineWriter.js";
import { parsePermissionMode } from "./permissionMode.js";
import { PROTOCOL_V2 } from "./protocol.js";
import { abortableSleep } from "./sleep.js";

export type PanePreviewCapture = (session: string) => Promise<string>;
export type PanePreviewMode = "claude_status" | "codex_terminal";

export interface PanePreviewPumpOptions {
  writer: LineWriter;
  capture: PanePreviewCapture;
  /** pane capture のポーリング間隔（ms）。既定 250ms。 */
  pollIntervalMs?: number;
  /** 変化停止後に inactive を送るまでの閾値（ms）。既定 2.5s。 */
  quietThresholdMs?: number;
  /** negotiated protocol version。未指定は v2。 */
  protocolVersion?: () => number;
  /**
   * Claude TUI の permission mode が変わったとき（と pump 開始後の初回判定時）に呼ばれる。
   * tmux 側の Shift+Tab 切替をクライアント表示へ反映するための通知で、
   * claude_status モードのときだけ判定する（codex に permission mode は無い）。
   */
  onPermissionMode?: (mode: string) => void;
}

/** tmux pane の画面内容が変化したときだけ pane_preview を流す。 */
export class PanePreviewPump {
  private readonly writer: LineWriter;
  private readonly capture: PanePreviewCapture;
  private readonly pollIntervalMs: number;
  private readonly quietThresholdMs: number;
  private readonly protocolVersion: () => number;
  private abortController: AbortController | null = null;
  private task: Promise<void> | null = null;
  private seq = 0;
  private lastText: string | null = null;
  private lastChangeAt = 0;
  private lastEmitAt = 0;
  private pendingText: string | null = null;
  private hasEmitted = false;
  private active = false;
  private inactiveSent = false;
  private session: string | null = null;
  private mode: PanePreviewMode = "claude_status";
  private readonly onPermissionMode: ((mode: string) => void) | null;
  private lastPermissionMode: string | null = null;
  private static readonly minEmitIntervalMs = 500;

  constructor(options: PanePreviewPumpOptions) {
    this.writer = options.writer;
    this.capture = options.capture;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.quietThresholdMs = options.quietThresholdMs ?? 2500;
    this.protocolVersion = options.protocolVersion ?? (() => PROTOCOL_V2);
    this.onPermissionMode = options.onPermissionMode ?? null;
  }

  /** 対象セッションの preview を開始/切替する。同一セッションの二重 start は無視する。 */
  start(session: string, mode: PanePreviewMode = "claude_status"): void {
    if (this.session === session && this.mode === mode && this.task !== null) return;
    this.stop();
    this.session = session;
    this.mode = mode;
    this.lastPermissionMode = null;
    this.lastText = null;
    this.lastChangeAt = 0;
    this.lastEmitAt = 0;
    this.pendingText = null;
    this.hasEmitted = false;
    this.active = false;
    this.inactiveSent = false;
    const ac = new AbortController();
    this.abortController = ac;
    this.task = this.run(session, mode, ac.signal);
    this.task.catch(() => {});
  }

  /** preview を停止する。active 中なら UI 側の表示を消すため inactive を一度だけ流す。 */
  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.task = null;
    if (this.session !== null && this.active && !this.inactiveSent) {
      this.emit(this.session, false, "");
    }
    this.session = null;
    this.mode = "claude_status";
    this.lastPermissionMode = null;
    this.lastText = null;
    this.lastChangeAt = 0;
    this.lastEmitAt = 0;
    this.pendingText = null;
    this.hasEmitted = false;
    this.active = false;
    this.inactiveSent = false;
  }

  private async run(session: string, mode: PanePreviewMode, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let text: string | null = null;
      try {
        text = await this.capture(session);
      } catch (error) {
        process.stderr.write(`[tailii-host engine] pane_preview capture 失敗: ${String(error)}\n`);
      }

      if (text !== null && mode === "claude_status" && this.onPermissionMode !== null) {
        // ダイアログ表示中は null（判定不能）になるため、直前の確定値を保持して揺れを抑える。
        const permissionMode = parsePermissionMode(text);
        if (permissionMode !== null && permissionMode !== this.lastPermissionMode) {
          this.lastPermissionMode = permissionMode;
          this.onPermissionMode(permissionMode);
        }
      }

      const now = Date.now();
      if (text !== null && text !== this.lastText) {
        if (this.lastText === null) {
          this.lastText = text;
          // Claude は従来どおり初回を基準フレームとして黙って保持する。
          // Codex は接続時点ですでに turn が進行中の場合があるため、初回 capture も送り、
          // iOS 側で現在の処理中ステータスだけを抽出する。
          if (mode === "codex_terminal" && text.trim().length > 0) {
            this.lastChangeAt = now;
            this.inactiveSent = false;
            this.queueActive(session, text, now, mode);
          }
        } else {
          this.lastText = text;
          this.lastChangeAt = now;
          this.inactiveSent = false;
          this.queueActive(session, text, now, mode);
        }
      }

      if (
        this.pendingText !== null &&
        now - this.lastEmitAt >= PanePreviewPump.minEmitIntervalMs
      ) {
        this.emitActive(session, this.pendingText, now, mode);
      } else if (
        this.active &&
        !this.inactiveSent &&
        this.hasEmitted &&
        this.lastChangeAt > 0 &&
        now - this.lastChangeAt >= this.quietThresholdMs
      ) {
        this.emit(session, false, "");
        this.inactiveSent = true;
        this.active = false;
      }

      await abortableSleep(this.pollIntervalMs, signal);
    }
  }

  private queueActive(session: string, text: string, now: number, mode: PanePreviewMode): void {
    if (!this.hasEmitted || now - this.lastEmitAt >= PanePreviewPump.minEmitIntervalMs) {
      this.emitActive(session, text, now, mode);
      return;
    }
    this.pendingText = text;
  }

  private emitActive(session: string, text: string, now: number, mode: PanePreviewMode): void {
    this.pendingText = null;
    this.lastEmitAt = now;
    this.active = true;
    this.inactiveSent = false;
    this.emit(session, true, text, mode);
  }

  private emit(
    session: string,
    active: boolean,
    text: string,
    mode: PanePreviewMode = this.mode,
  ): void {
    const v = this.protocolVersion();
    if (v < PROTOCOL_V2) return;
    this.seq += 1;
    this.hasEmitted = true;
    this.writer.write({
      type: "pane_preview",
      v,
      session,
      seq: this.seq,
      active,
      text,
      ...(mode === "codex_terminal" ? { mode } : {}),
    });
  }
}
