// apiAgentBackend.ts
// tailii (TS host) — 端末なしの会話（API 作業, api-agent）の SessionBackend。
//
// 端末（pane）を持たないので、キー送信・画面取得・ログインコード等は非対応（空 / false / 例外）。
// 「生存」は hub が開いている記録（`~/.tailii/api-agent/sessions/<名前>.json`）の有無で判定する。
// ターンの実行・中断・廃棄の権威は hub の ApiAgentManager。engine 側では送信・中断の手段を渡さず、
// hub 側（hubDaemon）では manager へつなぐ。

import { PROTOCOL_V1, type SessionInfo } from "../protocol.js";
import { ApiAgentSessionStore } from "../apiAgent/sessionState.js";
import type { SessionMeta, SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import type { SessionBackend } from "./sessionBackend.js";
import type { CapturePaneOptions, ReattachResult, SendQueuedNowOutcome, SendTextSubmitOptions } from "./tmux.js";

export class ApiAgentUnsupportedError extends Error {
  constructor(operation: string) {
    super(`この会話（API 作業）では ${operation} を使えません。`);
    this.name = "ApiAgentUnsupportedError";
  }
}

export function isApiAgentMeta(meta: SessionMeta | null | undefined): boolean {
  return meta?.executionRoute === "api";
}

export interface ApiAgentBackendOptions {
  store: SessionMetadataStore;
  sessions?: ApiAgentSessionStore;
  /** 発話を API 作業へ渡す（hub 側だけ）。 */
  submit?: (name: string, text: string) => Promise<void>;
  /** 終了（hub 側は manager.dispose。engine 側は記録を消すだけで、hub は session_retire で廃棄する）。 */
  dispose?: (name: string) => void;
  protocolVersion?: number;
}

export class ApiAgentSessionBackend implements SessionBackend {
  readonly store: SessionMetadataStore;
  private readonly sessions: ApiAgentSessionStore;

  constructor(private readonly options: ApiAgentBackendOptions) {
    this.store = options.store;
    this.sessions = options.sessions ?? new ApiAgentSessionStore();
  }

  private infoFor(meta: SessionMeta): SessionInfo {
    const conversationId = meta.providerSessionId ?? meta.claudeSessionId;
    return {
      name: meta.name,
      cwd: meta.cwd,
      alive: this.sessions.get(meta.name) !== null,
      agent: "claude",
      executionRoute: "api",
      ...(meta.claudeSessionId !== undefined ? { claudeSessionId: meta.claudeSessionId } : {}),
      ...(conversationId !== undefined ? { providerSessionId: conversationId } : {}),
    };
  }

  async list(): Promise<SessionInfo[]> {
    return (await this.store.allAsync()).filter(isApiAgentMeta).map((meta) => this.infoFor(meta));
  }

  async reattach(name: string): Promise<ReattachResult> {
    const meta = this.store.get(name);
    if (meta === null || !isApiAgentMeta(meta) || this.sessions.get(name) === null) {
      return {
        kind: "notFound",
        error: {
          type: "error", v: this.options.protocolVersion ?? PROTOCOL_V1, code: "session_not_found",
          message: `セッション '${name}' は存在しません。新規に起動できます。`,
        },
      };
    }
    return { kind: "attached", info: this.infoFor(meta), recentOutput: "" };
  }

  async kill(name: string): Promise<void> {
    if (this.options.dispose !== undefined) this.options.dispose(name);
    else this.sessions.remove(name);
  }

  async sendKeys(): Promise<void> { throw new ApiAgentUnsupportedError("キー送信"); }

  async sendTextSubmit(name: string, text: string, _options?: SendTextSubmitOptions): Promise<void> {
    if (this.options.submit === undefined) throw new ApiAgentUnsupportedError("この経路の送信");
    await this.options.submit(name, text);
  }

  async sendQueuedNow(): Promise<SendQueuedNowOutcome> { return { status: "nothing_queued" }; }
  async clearInputBox(): Promise<boolean> { return false; }
  async sendLoginCode(): Promise<void> { throw new ApiAgentUnsupportedError("ログインコードの入力"); }
  async capturePane(_name: string, _options?: CapturePaneOptions): Promise<string> { return ""; }
  async captureVisibleAnsi(): Promise<string> { return ""; }
  async agentProcessAlive(name: string): Promise<boolean> { return this.sessions.get(name) !== null; }
  async agentProcessIds(): Promise<number[] | null> { return null; }
  async setDisplayTitle(): Promise<void> { /* 端末のタブが無い。 */ }
}
