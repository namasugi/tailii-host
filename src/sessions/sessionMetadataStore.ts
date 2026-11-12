// sessionMetadataStore.ts
// tailii (TS host) — セッションメタデータ（cwd 権威記録）
// Swift 版 SessionMetadataStore.swift の移植。
// セッション名 → 作業ディレクトリ / 作成時刻を <base>/<name>.json に put/get/all で読み書きする。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "../shared/paths.js";
import { mapConcurrent } from "./mapConcurrent.js";

/** 1 セッション分のメタデータ（createdAt は Unix 秒）。 */
export interface SessionMeta {
  name: string;
  cwd: string;
  createdAt: number;
  /** そのセッションを駆動するエージェント（claude=既定 / codex）。未記録は claude 相当。 */
  agent?: "claude" | "codex";
  /** Claude の会話 JSONL 名に対応する session-id。未記録は従来どおり最新 JSONL 解決へ戻す。 */
  claudeSessionId?: string;
  /** provider 共通の論理会話 ID。Claude UUID / Codex thread ID を同じ欄で扱う。 */
  providerSessionId?: string;
  /** runtime を収容する tmux pane の安定 ID（`%N`）。未記録時は session 名へフォールバック。 */
  tmuxPaneId?: string;
  /** セッションを収容する端末バックエンド。未記録は tmux 相当（後方互換）。 */
  backend?: "tmux" | "herdr";
  /** herdr backend のときの pane ID（`w<N>:p<id>`）。herdr への入出力 target。 */
  herdrPaneId?: string;
  /**
   * hub tick がタブへ自動適用した会話タイトル（session-title）。
   * 「ラベル==この値」のタブは自動命名のままとみなし、ai-title の更新へ追随して
   * 再リネームする。人為リネーム（それ以外のラベル）とを区別する権威。
   */
  autoTabTitle?: string;
  /**
   * 実行経路（api-agent）。`api` = 端末を作らず hub が Agent SDK で 1 ターンずつ動かす会話。
   * 未記録は端末（tmux / herdr）。`backend` 欄は書かない（旧 host は tmux 扱いにして pane 不在と見る）。
   */
  executionRoute?: "api";
}

/** session 名が安全でないときに投げる型付きエラー。 */
export class InvalidSessionNameError extends Error {
  constructor(name: string) {
    super(`invalid session name: ${name}`);
    this.name = "InvalidSessionNameError";
  }
}

/** session 名の安全性を検証する（空 / null バイト / `/` / `.`・`..` を拒否）。 */
export function validateSessionName(name: string): void {
  if (name.length === 0) throw new InvalidSessionNameError(name);
  if (name.includes("\0")) throw new InvalidSessionNameError(name);
  if (name.includes("/")) throw new InvalidSessionNameError(name);
  if (name === "." || name === "..") throw new InvalidSessionNameError(name);
}

/** デフォルトのベースディレクトリ（`~/.tailii/sessions`）。 */
export function defaultSessionsBase(): string {
  return path.join(os.homedir(), ".tailii", "sessions");
}

/**
 * セッションメタデータの永続ストア（cwd 権威記録）。
 * 1 ファイル 1 セッション（`<base>/<name>.json`）。テストは一時 dir を注入する。
 */
export class SessionMetadataStore {
  private readonly base: string;
  private readonly readMemo = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; meta: SessionMeta | null }>();
  private readingAll: Promise<SessionMeta[]> | null = null;

  constructor(base?: string) {
    this.base = base ?? defaultSessionsBase();
  }

  /** セッションメタデータを保存する（同一 name は上書き）。 */
  put(meta: SessionMeta): void {
    validateSessionName(meta.name);
    ensureDirectory0700(this.base);
    const payload = JSON.stringify(
      // sortedKeys 相当。任意キーは指定時のみ書く（後方互換: 未指定は従来どおりのキー構成）。
      {
        ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
        ...(meta.autoTabTitle !== undefined ? { autoTabTitle: meta.autoTabTitle } : {}),
        ...(meta.backend !== undefined ? { backend: meta.backend } : {}),
        ...(meta.claudeSessionId !== undefined ? { claudeSessionId: meta.claudeSessionId } : {}),
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        ...(meta.executionRoute !== undefined ? { executionRoute: meta.executionRoute } : {}),
        ...(meta.herdrPaneId !== undefined ? { herdrPaneId: meta.herdrPaneId } : {}),
        name: meta.name,
        ...(meta.providerSessionId !== undefined ? { providerSessionId: meta.providerSessionId } : {}),
        ...(meta.tmuxPaneId !== undefined ? { tmuxPaneId: meta.tmuxPaneId } : {}),
      },
    );
    const target = this.fileFor(meta.name);
    this.readMemo.delete(target);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, target); // atomic 相当
  }

  /** 指定 name のメタデータ。存在しない / 読めない場合は null（throw しない設計）。 */
  get(name: string): SessionMeta | null {
    try {
      validateSessionName(name);
    } catch {
      return null;
    }
    try {
      const file = this.fileFor(name);
      const hit = this.readMemo.get(file);
      if (hit !== undefined) {
        const stat = fs.statSync(file);
        if (hit.mtimeMs === stat.mtimeMs && hit.ctimeMs === stat.ctimeMs && hit.size === stat.size) {
          return hit.meta === null ? null : { ...hit.meta };
        }
      }
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return decodeMeta(raw);
    } catch {
      return null;
    }
  }

  /** 保存済みの全メタデータ（壊れたファイルは無視、順序不定）。 */
  all(): SessionMeta[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.base);
    } catch {
      return [];
    }
    const result: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.base, entry), "utf8")) as unknown;
        const meta = decodeMeta(raw);
        if (meta) result.push(meta);
      } catch {
        // 壊れたファイルは無視して全体を落とさない。
      }
    }
    return result;
  }

  /**
   * 一覧は終了済みメタも含むので全件が必要。同期の全読みを避け、Composite の並行した
   * tmux/herdr/api の要求は 1 回の読み取りへまとめる。内容はファイルごとの stat で再検証する。
   */
  async allAsync(): Promise<SessionMeta[]> {
    if (this.readingAll === null) {
      this.readingAll = this.readAllAsync();
    }
    const pending = this.readingAll;
    try {
      return (await pending).map((meta) => ({ ...meta }));
    } finally {
      if (this.readingAll === pending) this.readingAll = null;
    }
  }

  private async readAllAsync(): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.base);
    } catch {
      return [];
    }
    const files = entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
      .map((entry) => path.join(this.base, entry));
    const seen = new Set(files);
    for (const file of this.readMemo.keys()) if (!seen.has(file)) this.readMemo.delete(file);
    const metas = await mapConcurrent(files, async (file) => {
      try {
        const stat = await fs.promises.stat(file);
        const hit = this.readMemo.get(file);
        if (hit?.mtimeMs === stat.mtimeMs && hit.ctimeMs === stat.ctimeMs && hit.size === stat.size) return hit.meta;
        const meta = decodeMeta(JSON.parse(await fs.promises.readFile(file, "utf8")));
        this.readMemo.set(file, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, meta });
        return meta;
      } catch {
        this.readMemo.delete(file);
        return null;
      }
    });
    return metas.filter((meta): meta is SessionMeta => meta !== null);
  }

  /** provider + 会話 ID から現在の tmux メタデータを逆引きする。 */
  findByProviderSessionId(agent: "claude" | "codex", providerSessionId: string): SessionMeta | null {
    for (const meta of this.all()) {
      const metaAgent = meta.agent ?? "claude";
      if (metaAgent !== agent) continue;
      const id = meta.providerSessionId ?? (metaAgent === "claude" ? meta.claudeSessionId : undefined);
      if (id === providerSessionId) return meta;
    }
    return null;
  }

  private fileFor(name: string): string {
    return path.join(this.base, `${name}.json`);
  }
}

function decodeMeta(raw: unknown): SessionMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj["name"] !== "string" ||
    typeof obj["cwd"] !== "string" ||
    typeof obj["createdAt"] !== "number"
  ) {
    return null;
  }
  const agent = obj["agent"] === "codex" || obj["agent"] === "claude" ? obj["agent"] : undefined;
  const claudeSessionId =
    typeof obj["claudeSessionId"] === "string" ? obj["claudeSessionId"] : undefined;
  const providerSessionId =
    typeof obj["providerSessionId"] === "string" ? obj["providerSessionId"] : undefined;
  const tmuxPaneId =
    typeof obj["tmuxPaneId"] === "string" && /^%\d+$/.test(obj["tmuxPaneId"])
      ? obj["tmuxPaneId"]
      : undefined;
  const backend = obj["backend"] === "herdr" || obj["backend"] === "tmux" ? obj["backend"] : undefined;
  const herdrPaneId =
    typeof obj["herdrPaneId"] === "string" && HERDR_PANE_ID_PATTERN.test(obj["herdrPaneId"])
      ? obj["herdrPaneId"]
      : undefined;
  const autoTabTitle =
    typeof obj["autoTabTitle"] === "string" && obj["autoTabTitle"].length > 0
      ? obj["autoTabTitle"]
      : undefined;
  const executionRoute = obj["executionRoute"] === "api" ? "api" as const : undefined;
  return {
    name: obj["name"],
    cwd: obj["cwd"],
    createdAt: obj["createdAt"],
    ...(executionRoute !== undefined ? { executionRoute } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
    ...(providerSessionId !== undefined ? { providerSessionId } : {}),
    ...(tmuxPaneId !== undefined ? { tmuxPaneId } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(herdrPaneId !== undefined ? { herdrPaneId } : {}),
    ...(autoTabTitle !== undefined ? { autoTabTitle } : {}),
  };
}

/** herdr pane ID の形式（例 `w4:p2`。実測で英数字混在の pane 連番あり）。 */
export const HERDR_PANE_ID_PATTERN = /^w\d+:p[A-Za-z0-9]+$/;
