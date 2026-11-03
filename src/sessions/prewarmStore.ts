// prewarmStore.ts
// tailii (TS host) — 新規会話の先行起動（session-prewarm）の記録。
//
// ドラフトで打ち始めた時点で iOS が `session_prewarm` を送り、host は送信時の `session_start` と同じ
// 起動パラメータで Claude を裏で起動しておく（Claude の起動は host 負荷しだいで 3〜10 秒以上かかり、
// 以前は送信ボタンを押してから起動していた）。後の `session_start` のパラメータが同じなら、起動済みの
// Claude（と、その `--session-id`）をそのまま採用する。
//
// 記録は SessionMetadataStore とは別ファイルに置く（`<sessions>/prewarm/<name>.json`）。メタは各所が
// 丸ごと書き直す（launch・タブ名の自動反映など）ので、同じファイルに印を足すと黙って消え、先行起動の
// まま使われなかった Claude を片付けられなくなる。

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDirectory0700 } from "../shared/paths.js";
import { defaultSessionsBase, validateSessionName } from "./sessionMetadataStore.js";

/**
 * 先行起動を使わずに残せる時間（秒）。最後の `session_prewarm` から過ぎたら reaper が閉じる
 * （アプリが落ちた・送らずに離れたのに取り消しが届かなかった等の取り残し）。
 */
export const PREWARM_TTL_SECONDS = 20 * 60;

/** 先行起動の起動パラメータ（`session_start` と照合する値の組）。 */
export interface PrewarmLaunchParams {
  cwd: string;
  baseDir?: string | undefined;
  title?: string | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  effort?: string | undefined;
  outputStyle?: string | undefined;
  todoTools?: boolean | undefined;
}

/**
 * 起動パラメータの照合キー。未指定（undefined）と空の扱いを揃え、キーの順序に依存しない文字列にする。
 * `session_start` 側は worktree / resume / codex の起動を照合対象にしない（先行起動はしない種類）。
 */
export function prewarmFingerprint(params: PrewarmLaunchParams): string {
  return JSON.stringify([
    params.cwd,
    params.baseDir ?? null,
    params.title ?? null,
    params.model ?? null,
    params.permissionMode ?? null,
    params.effort ?? null,
    params.outputStyle ?? null,
    params.todoTools === true,
  ]);
}

/** 1 件分の先行起動記録（時刻は Unix 秒）。 */
export interface PrewarmRecord {
  name: string;
  fingerprint: string;
  /** 先行起動した Claude の `--session-id`。採用時はこの id で tail を張る。 */
  claudeSessionId: string;
  createdAt: number;
  /** 最後に `session_prewarm` を受けた時刻（期限切れの起点）。 */
  touchedAt: number;
}

/** 先行起動記録の永続ストア（1 ファイル 1 会話）。テストは一時 dir を注入する。 */
export class PrewarmStore {
  private readonly base: string;

  constructor(base?: string) {
    this.base = base ?? path.join(defaultSessionsBase(), "prewarm");
  }

  put(record: PrewarmRecord): void {
    validateSessionName(record.name);
    ensureDirectory0700(this.base);
    const target = this.fileFor(record.name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
  }

  get(name: string): PrewarmRecord | null {
    try {
      validateSessionName(name);
      return decodeRecord(JSON.parse(fs.readFileSync(this.fileFor(name), "utf8")) as unknown);
    } catch {
      return null;
    }
  }

  remove(name: string): void {
    try {
      validateSessionName(name);
      fs.rmSync(this.fileFor(name), { force: true });
    } catch {
      // 消せなくても致命ではない（次の採用・期限切れで再判定する）。
    }
  }

  /** 先行起動中（未採用）の会話名。読めなければ空。 */
  names(): Set<string> {
    try {
      return new Set(
        fs.readdirSync(this.base)
          .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
          .map((entry) => entry.slice(0, -".json".length)),
      );
    } catch {
      return new Set();
    }
  }

  private fileFor(name: string): string {
    return path.join(this.base, `${name}.json`);
  }
}

function decodeRecord(raw: unknown): PrewarmRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj["name"] !== "string" || typeof obj["fingerprint"] !== "string" ||
    typeof obj["claudeSessionId"] !== "string" || typeof obj["createdAt"] !== "number" ||
    typeof obj["touchedAt"] !== "number"
  ) {
    return null;
  }
  return {
    name: obj["name"],
    fingerprint: obj["fingerprint"],
    claudeSessionId: obj["claudeSessionId"],
    createdAt: obj["createdAt"],
    touchedAt: obj["touchedAt"],
  };
}

/** 期限切れか（最後の `session_prewarm` から PREWARM_TTL_SECONDS を過ぎた）。 */
export function prewarmExpired(record: PrewarmRecord, nowSeconds: number, ttlSeconds = PREWARM_TTL_SECONDS): boolean {
  return nowSeconds - record.touchedAt >= ttlSeconds;
}
