// sessionListService.ts
// tailii (TS host) — セッション一覧の整列 + keyset ページング（session-list-lifecycle 1.x/2.x）
// Swift 版 SessionListService.swift の移植。
// (updatedAt desc, name asc) の安定順に整列し、不透明カーソルより後方を 1 ページ切り出す。

import type { SessionInfo } from "./protocol.js";
import type { SessionActivityProvider } from "./sessionActivityProvider.js";
import type { SessionBackend } from "./sessionBackend.js";

/** 1 ページ分の整列済みセッションと続き位置。 */
export interface SessionListPage {
  sessions: SessionInfo[];
  nextCursor: string | null;
}

/** limit 省略時の既定 1 ページ件数（要件 2.9）。 */
export const SESSION_LIST_DEFAULT_LIMIT = 5;

interface CursorKey {
  u: number;
  n: string;
}

/** `(updatedAt, name)` を base64url(JSON) の不透明トークンへ符号化する。 */
export function encodeSessionListCursor(updatedAt: number, name: string): string {
  // Swift 版 .sortedKeys と同じ `{"n":…,"u":…}` の正準形。
  const json = JSON.stringify({ n: name, u: updatedAt });
  return Buffer.from(json, "utf8").toString("base64url");
}

/** 不透明トークンを整列キーへ復号する。復号不能は null（呼び出し側は先頭ページ扱い）。 */
export function decodeSessionListCursor(token: string): CursorKey | null {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj["u"] !== "number" || typeof obj["n"] !== "string") return null;
    return { u: obj["u"], n: obj["n"] };
  } catch {
    return null;
  }
}

/** list を更新時間降順/名前昇順に整列し keyset ページングする純サービス。 */
export class SessionListService {
  constructor(
    private readonly sessionManager: SessionBackend,
    private readonly activityProvider: SessionActivityProvider,
  ) {}

  /** 更新時間降順/名前昇順で整列し、cursor より後方を limit 件返す。 */
  async page(limit: number | undefined, cursor: string | undefined): Promise<SessionListPage> {
    const raw = await this.sessionManager.list();

    // updatedAt を付与する（未解決は省略 = 比較上 0 で最下位）。
    // 権威は provider（セッション自身の会話 transcript の mtime = 最終会話時刻）。
    // tmux の活動時刻や cwd 共有の mtime は使わない: 前者は作成だけで最新になり、
    // 後者は同一 cwd の別セッションの会話を継承するため、どちらも
    // 「会話していないセッションが実会話より上に浮く」誤整列を生む。
    // Codex の activity provider は rollout 一覧を走査する。同一 cwd の複数メタは設計上
    // 同じ updatedAt 近似値になるため、1ページ生成中は cwd ごとに1回だけ解決する。
    // これが無いと過去セッション数に比例して同じ ~/.codex/sessions を再走査し、iOS の
    // 一覧更新を不必要に遅らせる。
    const codexActivityByCwd = new Map<string, number | null>();
    const annotated: SessionInfo[] = raw.map((info) => {
      if (info.updatedAt !== undefined) return info;
      let updatedAt: number | null;
      if (info.agent === "codex") {
        if (codexActivityByCwd.has(info.cwd)) {
          updatedAt = codexActivityByCwd.get(info.cwd) ?? null;
        } else {
          updatedAt = this.activityProvider(info);
          codexActivityByCwd.set(info.cwd, updatedAt);
        }
      } else {
        updatedAt = this.activityProvider(info);
      }
      return updatedAt === null ? { ...info } : { ...info, updatedAt };
    });

    // (updatedAt desc, name asc) の安定ソート。
    const sorted = annotated.slice().sort((lhs, rhs) => {
      const lu = lhs.updatedAt ?? 0;
      const ru = rhs.updatedAt ?? 0;
      if (lu !== ru) return ru - lu;
      return lhs.name < rhs.name ? -1 : lhs.name > rhs.name ? 1 : 0;
    });

    // keyset seek: cursor（末尾キー）より「後方」の先頭位置を求める。
    let startIndex = 0;
    if (cursor !== undefined) {
      const key = decodeSessionListCursor(cursor);
      if (key !== null) {
        const idx = sorted.findIndex((info) => isAfter(info, key));
        startIndex = idx === -1 ? sorted.length : idx;
      }
    }

    const effectiveLimit = Math.max(0, limit ?? SESSION_LIST_DEFAULT_LIMIT);
    const endIndex = Math.min(startIndex + effectiveLimit, sorted.length);
    const pageSessions = sorted.slice(startIndex, endIndex);

    const hasMore = endIndex < sorted.length;
    const last = pageSessions[pageSessions.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeSessionListCursor(last.updatedAt ?? 0, last.name)
        : null;

    return { sessions: pageSessions, nextCursor };
  }
}

/** 降順 seek における「後方」判定: `u < u0` または（`u == u0` かつ `n > n0`）。 */
function isAfter(info: SessionInfo, key: CursorKey): boolean {
  const u = info.updatedAt ?? 0;
  if (u !== key.u) return u < key.u;
  return info.name > key.n;
}
