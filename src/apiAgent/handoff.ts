// apiAgent/handoff.ts
// 既存の会話（サブスクで動かしてきた Claude の会話）を API 作業へ引き継ぐ / 元へ戻すときの材料。
//
// 引き継ぎは同じ会話 id を SDK の `resume` で続ける（要約は作らない）。実測（2026-11-11）:
// - 対話型で作った会話を API キーで resume でき、別のモデル（haiku → sonnet）でも続く。逆（API キーで作った
//   会話をログインで再開）も続く。対話型へ戻した後も履歴の親子関係は切れず、/rewind の一覧に SDK のターンも並ぶ。
// - SDK のターンは既定ではファイルの控え（file-history）を残さず、/rewind で「No code restore」になる。
//   作業プロセスで `enableFileCheckpointing: true` を渡すと控えが残り、端末へ戻した後も巻き戻せる。
// - 初回は履歴全体が入力になる（別組織の API キーなのでサブスク側のプロンプトキャッシュは効かない）。
//   最後の応答の usage（input + cache_read + cache_creation）がその大きさの目安（実測 67.8k → 初回 69.7k）。
// - 対話型の会話も `cost-state`（サブスク分の名目額）を書く。API のターンの額は台帳の基準差し引きで求める。

import * as fs from "node:fs";
import type { ApiAgentPermissionMode } from "../protocol/messages.js";
import { claudeApiModelPrice } from "../services/claudeApiDelegate.js";

export interface HandoffContext {
  /** 最後の応答の文脈の大きさ（トークン）。履歴が無い・読めないときは null。 */
  contextTokens: number | null;
  /** 最後に記録された権限モード（`permission-mode` 行）。 */
  permissionMode: string | null;
  /** 最後の応答のモデル。 */
  model: string | null;
}

/** 会話の JSONL の末尾（最大 8MiB）から、引き継ぎの見積もりに使う値を読む。 */
export function readHandoffContext(transcriptPath: string, tailBytes = 8 * 1024 * 1024): HandoffContext {
  const result: HandoffContext = { contextTokens: null, permissionMode: null, model: null };
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && (result.contextTokens === null || result.permissionMode === null); i -= 1) {
      const line = lines[i]!;
      if (!line.includes("\"assistant\"") && !line.includes("\"permission-mode\"")) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (record["type"] === "permission-mode" && result.permissionMode === null && typeof record["permissionMode"] === "string") {
        result.permissionMode = record["permissionMode"];
      } else if (record["type"] === "assistant" && result.contextTokens === null) {
        const message = record["message"] as Record<string, unknown> | undefined;
        const usage = message?.["usage"] as Record<string, unknown> | undefined;
        if (usage === undefined) continue;
        const n = (key: string): number => typeof usage[key] === "number" ? usage[key] as number : 0;
        const tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if (tokens <= 0) continue;
        result.contextTokens = tokens;
        if (typeof message?.["model"] === "string") result.model = message["model"] as string;
      }
    }
  } catch {
    // 無い・読めない → null のまま。
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return result;
}

/** 初回の応答の上限の見込み（出力分の見積もり）。 */
const FIRST_TURN_OUTPUT_ALLOWANCE = 4_000;

/**
 * 引き継ぎ直後の初回の概算額（USD）。履歴全体をキャッシュ書き込み（入力単価の 1.25 倍）として数え、
 * 出力の見込みを足す。既存の「APIで実行」の料金表（claudeApiDelegate の DELEGATE_MODELS）を使う。
 * 料金が分からないモデルは null。多めの見積もり（実測では Claude Code の共通部分がキャッシュ読みになり、これより安い）。
 */
export function estimateFirstTurnUsd(contextTokens: number, model: string): number | null {
  const price = claudeApiModelPrice(model);
  if (price === undefined) return null;
  const usd = (contextTokens * price.input * 1.25 + FIRST_TURN_OUTPUT_ALLOWANCE * price.output) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * 今の会話の権限モードを引き継ぐ。広げない: 自動（auto）・全許可（bypassPermissions）や不明は確認あり（default）へ落とす。
 */
export function inheritPermissionMode(mode: string | null): ApiAgentPermissionMode {
  switch (mode) {
    case "acceptEdits": return "acceptEdits";
    case "plan": return "plan";
    case "dontAsk": return "dontAsk";
    default: return "default";
  }
}
