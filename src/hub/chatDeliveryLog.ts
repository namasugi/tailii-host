// hub/chatDeliveryLog.ts
// hub が会話へ届けた発話の記録（`~/.tailii/hub/chat-deliveries.ndjson`）。届けるたびに 1 行を追記し、消さない。
//
// 用途: `tailii-host chat read / search` が、会話の記録の発話が「hub の送信で届いたもの（アプリか `tailii-host chat`）」かを
// 確かめる。Claude の会話の記録には送信 ID が残らないので、本文のハッシュで結び付ける（Codex は rollout の `client_id`）。
//
// 配送済みの台帳（`chat-receipts.json`）とは別にする: あちらは二重送信の防止用で、30 日・件数の上限で消える。出所の記録は
// 過去の会話を読むときにも使うので消さない。1 件は約 200 バイト（1 日 100 件ほどの実績で、1 年に約 8 MB）。
// 本文そのものは残さない（照合用にそろえた本文のハッシュだけ）。

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeTextForPaste } from "../backend/tmux.js";
import { normalizeForTextMatch } from "../shared/invisibleText.js";
import { unwrapPastedContent } from "../shared/pastedContent.js";
import { ensureDirectory0700 } from "../shared/paths.js";

/** 届けた発話 1 件。 */
export interface ChatDeliveryRecord {
  v: 1;
  /** 届けたのを確かめた時刻（epoch ms）。会話の記録の発話の時刻は、ふつうこの直前。 */
  atMs: number;
  /** 届けた先の Tailii の会話名。 */
  session: string;
  /** その時点で会話名が収容していた会話 ID（分かるときだけ。始めたばかりの会話はまだ無いことがある）。 */
  conversationId?: string;
  agent: "claude" | "codex";
  /**
   * 送り手が付けた送信 ID（`chat_send.clientMessageId` / `codex_turn_start.clientUserMessageId`）。
   * `cli-…` は `tailii-host chat`、それ以外はアプリ。
   */
  clientMessageId: string;
  /** 届けた本文を照合用にそろえたもののハッシュ（`utteranceDigest`）。 */
  textHash: string;
}

export function defaultChatDeliveryLogPath(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "hub", "chat-deliveries.ndjson");
}

/**
 * 照合用の正規化。記録に残る本文は、送った本文から hub と Claude Code が変えたもの（制御文字を落とす・貼り付けの包み・
 * 不可視文字を除く）なので、両辺を同じ形にそろえてから空白を除いて比べる。
 */
export function normalizeUtteranceForMatch(text: string): string {
  return normalizeForTextMatch(unwrapPastedContent(normalizeTextForPaste(text)).normalize("NFC"));
}

/** 照合用にそろえた本文のハッシュ（送った本文と、記録に残った本文で同じ値になる）。 */
export function utteranceDigest(text: string): string {
  return createHash("sha256").update(normalizeUtteranceForMatch(text)).digest("hex").slice(0, 32);
}

/** 1 件を追記する（1 行の JSON。置き場が無ければ作る）。失敗は投げる（呼び出し側が握る）。 */
export function appendChatDelivery(file: string, record: ChatDeliveryRecord): void {
  ensureDirectory0700(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** 記録の 1 行を読む。形が違えば null。 */
export function parseChatDeliveryLine(line: string): ChatDeliveryRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record["v"] !== 1 || typeof record["atMs"] !== "number" || typeof record["session"] !== "string" ||
    (record["agent"] !== "claude" && record["agent"] !== "codex") ||
    typeof record["clientMessageId"] !== "string" || typeof record["textHash"] !== "string") return null;
  return {
    v: 1, atMs: record["atMs"], session: record["session"], agent: record["agent"],
    clientMessageId: record["clientMessageId"], textHash: record["textHash"],
    ...(typeof record["conversationId"] === "string" && record["conversationId"].length > 0
      ? { conversationId: record["conversationId"] } : {}),
  };
}
