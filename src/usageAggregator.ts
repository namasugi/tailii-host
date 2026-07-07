// usageAggregator.ts
// tailii (TS host) — 会話トランスクリプト（JSONL）からのトークン使用量集計
// Swift 版 UsageAggregator.swift の移植。
// assistant 行の `message.usage` を合算する。解釈できない行・usage の無い行はスキップ。

import * as fs from "node:fs";

/** 集計結果（全フィールド合算値）。 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** usage を持つ assistant ターン数。 */
  turns: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0 };
}

/** `transcriptPath` の JSONL を頭から読み、assistant 行の usage を合算する（不在は全 0）。 */
export function aggregateUsage(transcriptPath: string): UsageTotals {
  const totals = emptyUsageTotals();
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return totals;
  }
  for (const line of content.split("\n")) {
    accumulate(line, totals);
  }
  return totals;
}

function accumulate(line: string, totals: UsageTotals): void {
  if (!line) return;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof obj !== "object" || obj === null) return;
  const message = (obj as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return;
  const msg = message as Record<string, unknown>;
  if (msg["role"] !== "assistant") return;
  const usage = msg["usage"];
  if (typeof usage !== "object" || usage === null) return;
  const u = usage as Record<string, unknown>;
  totals.inputTokens += numberOrZero(u["input_tokens"]);
  totals.outputTokens += numberOrZero(u["output_tokens"]);
  totals.cacheReadTokens += numberOrZero(u["cache_read_input_tokens"]);
  totals.cacheCreationTokens += numberOrZero(u["cache_creation_input_tokens"]);
  totals.turns += 1;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
