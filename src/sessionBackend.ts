// sessionBackend.ts
// tailii (TS host) — セッション端末バックエンドの抽象（tmux / herdr）。
//
// 既定は従来どおり tmux。`~/.tailii/backend` に `herdr` と書くと、新規セッションを
// herdr（terminal workspace manager）の pane として起動する。切替後も既存 tmux
// セッションを操作できるよう、稼働系は Composite（メタデータの backend 欄で
// per-session ルーティング）で両バックエンドを併存させる。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrSessionManager } from "./herdr.js";
import type { SessionInfo, TerminalBackendKind } from "./protocol.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import {
  TmuxSessionManager,
  type CapturePaneOptions,
  type ReattachResult,
} from "./tmux.js";

/** セッションを収容する端末バックエンド種別（ワイヤーの TerminalBackendKind と同一）。 */
export type SessionBackendKind = TerminalBackendKind;

/**
 * セッション端末バックエンドの共通面。TmuxSessionManager の公開面をそのまま interface 化した。
 * 呼び出し側（engine / hub / hook）はこの面だけに依存する。
 */
export interface SessionBackend {
  readonly store: SessionMetadataStore;
  list(): Promise<SessionInfo[]>;
  reattach(name: string): Promise<ReattachResult>;
  kill(name: string): Promise<void>;
  sendKeys(name: string, keys: string[], literal?: boolean): Promise<void>;
  /**
   * 本文入力と送信確定（Enter）を 1 操作で行う（chat 注入・kick 用）。
   * tmux は従来どおり literal 送出 → 150ms → Enter。herdr は本文+CR を単一コールで送る
   * （分割すると Ink のペースト取り込み窓に CR が飲まれ送信されない。実測 2026-07-22）。
   */
  sendTextSubmit(name: string, text: string): Promise<void>;
  capturePane(name: string, options?: CapturePaneOptions): Promise<string>;
  agentProcessAlive(name: string): Promise<boolean>;
}

/** backend 設定ファイルの既定パス（`~/.tailii/backend`。`~/.tailii/agent` と同じ流儀）。 */
export function defaultBackendFilePath(): string {
  return path.join(os.homedir(), ".tailii", "backend");
}

/**
 * 新規セッションを起動するバックエンドを host 側設定から解決する。
 * ファイル内容が `herdr` なら herdr、それ以外/不在は tmux（完全後方互換）。
 * launch 毎に呼び直すことで、アプリ（backend_set）からの切替が engine 再起動なしで反映される。
 */
export function resolveSessionBackendKind(
  backendFilePath: string = defaultBackendFilePath(),
): SessionBackendKind {
  try {
    const value = fs.readFileSync(backendFilePath, "utf8").trim().toLowerCase();
    if (value === "herdr") return "herdr";
  } catch {
    // 不在/読取失敗は既定 tmux。
  }
  return "tmux";
}

/**
 * backend 設定を永続化する（backend_set の実体）。tmp+rename の atomic 書き込み。
 * `tmux` の明示書き込みも許す（不在と等価だが、切替 UI の状態を素直に映す）。
 */
export function writeSessionBackendKind(
  kind: SessionBackendKind,
  backendFilePath: string = defaultBackendFilePath(),
): void {
  fs.mkdirSync(path.dirname(backendFilePath), { recursive: true, mode: 0o700 });
  const tmp = backendFilePath + ".tmp";
  fs.writeFileSync(tmp, `${kind}\n`);
  fs.renameSync(tmp, backendFilePath);
}

/**
 * メタデータの backend 欄で tmux / herdr へ per-session ルーティングする合成バックエンド。
 * list は両方の和（各バックエンドが自分の担当メタだけを列挙するので重複しない）。
 * メタ未記録の名前は tmux 扱い（後方互換: 既存セッションはすべて tmux 由来）。
 */
export class CompositeSessionBackend implements SessionBackend {
  readonly store: SessionMetadataStore;
  private readonly tmux: SessionBackend;
  private readonly herdr: SessionBackend;

  constructor(options: {
    tmux: SessionBackend;
    herdr: SessionBackend;
    store: SessionMetadataStore;
  }) {
    this.tmux = options.tmux;
    this.herdr = options.herdr;
    this.store = options.store;
  }

  private backendFor(name: string): SessionBackend {
    return this.store.get(name)?.backend === "herdr" ? this.herdr : this.tmux;
  }

  async list(): Promise<SessionInfo[]> {
    const [tmuxInfos, herdrInfos] = await Promise.all([this.tmux.list(), this.herdr.list()]);
    // 名前空間はメタの backend 欄で分割済み（tmux 側は herdr メタを列挙しない）。
    // 万一の重複（メタ無し同名 pane 等）は tmux 優先で除く。
    const seen = new Set(tmuxInfos.map((info) => info.name));
    const merged = [...tmuxInfos, ...herdrInfos.filter((info) => !seen.has(info.name))];
    return merged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  reattach(name: string): Promise<ReattachResult> {
    return this.backendFor(name).reattach(name);
  }

  kill(name: string): Promise<void> {
    return this.backendFor(name).kill(name);
  }

  sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    return this.backendFor(name).sendKeys(name, keys, literal);
  }

  sendTextSubmit(name: string, text: string): Promise<void> {
    return this.backendFor(name).sendTextSubmit(name, text);
  }

  capturePane(name: string, options: CapturePaneOptions = {}): Promise<string> {
    return this.backendFor(name).capturePane(name, options);
  }

  agentProcessAlive(name: string): Promise<boolean> {
    return this.backendFor(name).agentProcessAlive(name);
  }
}

/**
 * 稼働バックエンドを構築する。常に Composite（per-session ルーティング）。
 * 設定が tmux でも herdr メタのセッションを操作でき、稼働中にアプリから backend_set で
 * 切り替えても engine/hub の再起動なしに両方のセッションへ届く。
 * herdr メタが 1 つも無ければ herdr 側 list は CLI を呼ばず空を返すため、
 * 純 tmux 環境（herdr 未導入含む）では従来と同じ挙動・コストになる。
 */
export function makeSessionBackend(options: { store: SessionMetadataStore }): SessionBackend {
  return new CompositeSessionBackend({
    tmux: new TmuxSessionManager({ store: options.store }),
    herdr: new HerdrSessionManager({ store: options.store }),
    store: options.store,
  });
}

/**
 * 単一セッション名からそのセッションの属するバックエンドを構築する（hook / kick 用の軽量経路）。
 * メタデータの backend 欄が権威。メタ無しは tmux。
 */
export function makeBackendForSession(
  session: string,
  store: SessionMetadataStore = new SessionMetadataStore(),
): SessionBackend {
  if (store.get(session)?.backend === "herdr") return new HerdrSessionManager({ store });
  return new TmuxSessionManager({ store });
}
