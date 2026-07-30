// liveSessionJoin.ts
// 会話一覧（claude_session_list_response）の各行へ「その会話を収容している生存セッション」を
// join する純関数群（live-pill）。
//
// 背景: iOS の「稼働中」ピルは以前、別 RPC（`session_list_request`, limit 5 ページング）の
// 結果とアプリ側 join で出していたため、生存セッションが 6 件以上あると母集合から漏れ、
// pull-to-refresh でも更新されず、一覧注視中の外部死も拾えなかった。host が一覧応答へ
// 同梱すれば、母集合の欠落も join のタイミングずれも原理的に消える。
//
// 同一会話を複数の生存セッションが掴んでいることは起こり得る（同一 session id の第 2
// インスタンス起動など）。返す名前は iOS の kill 対象になるため、選択は完全に決定的にする:
//   ① 名前が `cs-` で始まるもの（アプリが会話 id から起こした pane）を優先
//   ② メタデータの createdAt 降順（新しい方 = いま操作している側）
//   ③ 名前昇順（同値の最終タイブレーク）

import type { SessionInfo, TerminalBackendKind } from "../protocol.js";

/** 会話 1 行へ載せる生存セッション情報（live-pill）。 */
export interface LiveSessionAnnotation {
  liveSessionName: string;
  liveSessionBackend: TerminalBackendKind;
}

/**
 * join キー: agent と会話 id の対（agent 省略は claude 相当に正規化する）。
 * agent は enum（claude / codex）なので `::` 区切りで会話 id と衝突しない。
 */
function joinKey(conversationId: string, agent: string | undefined): string {
  return `${agent ?? "claude"}::${conversationId}`;
}

/** アプリ起点 pane（`cs-<会話id先頭>`）の命名規約。 */
function isAppOriginName(name: string): boolean {
  return name.startsWith("cs-");
}

/**
 * 生存セッション一覧を「agent + 会話 id」→ 代表 1 件へ畳む。
 *
 * @param liveSessions `SessionBackend.list()` の結果（alive でないものはここで除外する）。
 * @param createdAtOf セッション名 → メタデータの createdAt（Unix 秒）。不明は null。
 */
export function buildLiveSessionIndex(
  liveSessions: readonly SessionInfo[],
  createdAtOf: (name: string) => number | null,
): Map<string, LiveSessionAnnotation> {
  const candidates = new Map<string, SessionInfo[]>();
  for (const info of liveSessions) {
    if (!info.alive) continue;
    const conversationId = info.providerSessionId ?? info.claudeSessionId ?? null;
    if (conversationId === null || conversationId.length === 0) continue;
    const key = joinKey(conversationId, info.agent);
    const bucket = candidates.get(key);
    if (bucket === undefined) candidates.set(key, [info]);
    else bucket.push(info);
  }
  const index = new Map<string, LiveSessionAnnotation>();
  for (const [key, bucket] of candidates) {
    const chosen = [...bucket].sort((lhs, rhs) => {
      const lhsApp = isAppOriginName(lhs.name);
      const rhsApp = isAppOriginName(rhs.name);
      if (lhsApp !== rhsApp) return lhsApp ? -1 : 1;
      // createdAt 不明は最劣後（-Infinity 相当）に置く。
      const lhsCreated = createdAtOf(lhs.name) ?? Number.NEGATIVE_INFINITY;
      const rhsCreated = createdAtOf(rhs.name) ?? Number.NEGATIVE_INFINITY;
      if (lhsCreated !== rhsCreated) return rhsCreated - lhsCreated;
      return lhs.name < rhs.name ? -1 : lhs.name > rhs.name ? 1 : 0;
    })[0]!;
    index.set(key, {
      liveSessionName: chosen.name,
      // backend 未指定は後方互換で tmux 相当（session-backend の既存規約に合わせる）。
      liveSessionBackend: chosen.backend ?? "tmux",
    });
  }
  return index;
}

/** 会話一覧の各行へ生存セッションを join する（一致しない行は素通し = 停止中）。 */
export function annotateLiveSessions<T extends { sessionId: string; agent?: "claude" | "codex" }>(
  sessions: readonly T[],
  index: ReadonlyMap<string, LiveSessionAnnotation>,
): T[] {
  return sessions.map((row) => {
    const live = index.get(joinKey(row.sessionId, row.agent));
    return live === undefined ? row : { ...row, ...live };
  });
}

/** 生存セッション名の解決（テスト・呼び出し側の可読性用の薄いヘルパ）。 */
export function liveSessionFor(
  index: ReadonlyMap<string, LiveSessionAnnotation>,
  conversationId: string,
  agent?: "claude" | "codex",
): LiveSessionAnnotation | undefined {
  return index.get(joinKey(conversationId, agent));
}
