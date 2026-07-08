// sessionMetadataStore.ts
// tailii (TS host) — セッションメタデータ（cwd 権威記録）
// Swift 版 SessionMetadataStore.swift の移植。
// セッション名 → 作業ディレクトリ / 作成時刻を <base>/<name>.json に put/get/all で読み書きする。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";

/** 1 セッション分のメタデータ（createdAt は Unix 秒）。 */
export interface SessionMeta {
  name: string;
  cwd: string;
  createdAt: number;
  /** そのセッションを駆動するエージェント（claude=既定 / codex）。未記録は claude 相当。 */
  agent?: "claude" | "codex";
  /** Claude の会話 JSONL 名に対応する session-id。未記録は従来どおり最新 JSONL 解決へ戻す。 */
  claudeSessionId?: string;
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
        ...(meta.claudeSessionId !== undefined ? { claudeSessionId: meta.claudeSessionId } : {}),
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        name: meta.name,
      },
    );
    const target = this.fileFor(meta.name);
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
      const raw = JSON.parse(fs.readFileSync(this.fileFor(name), "utf8")) as unknown;
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
  return {
    name: obj["name"],
    cwd: obj["cwd"],
    createdAt: obj["createdAt"],
    ...(agent !== undefined ? { agent } : {}),
    ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
  };
}
