// codexUsage.test.ts — codex rollout の token_count → usage 集計のテスト（codex-input）

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { aggregateCodexUsage } from "../src/codexUsage.js";
import { makeTempDir } from "./helpers.js";

function tokenCountLine(opts: {
  input: number;
  output: number;
  cached: number;
  total: number;
  window?: number;
  primaryPct?: number;
  primaryResets?: number;
  secondaryPct?: number;
  secondaryResets?: number;
}): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: opts.input,
          output_tokens: opts.output,
          cached_input_tokens: opts.cached,
          total_tokens: opts.total,
        },
        ...(opts.window !== undefined && { model_context_window: opts.window }),
      },
      ...((opts.primaryPct !== undefined || opts.secondaryPct !== undefined) && {
        rate_limits: {
          ...(opts.primaryPct !== undefined && {
            primary: { used_percent: opts.primaryPct, window_minutes: 300, resets_at: opts.primaryResets },
          }),
          ...(opts.secondaryPct !== undefined && {
            secondary: { used_percent: opts.secondaryPct, window_minutes: 10080, resets_at: opts.secondaryResets },
          }),
        },
      }),
    },
  });
}

function writeRolloutFile(lines: string[]): string {
  const dir = makeTempDir("codex-usage");
  const p = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("aggregateCodexUsage", () => {
  test("末尾の token_count から usage と rate_limits を集計する", () => {
    const p = writeRolloutFile([
      JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/w" } }),
      tokenCountLine({ input: 100, output: 10, cached: 50, total: 160 }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
      tokenCountLine({
        input: 193130,
        output: 1861,
        cached: 163200,
        total: 194991,
        window: 258400,
        primaryPct: 4,
        primaryResets: 1783056714,
        secondaryPct: 9,
        secondaryResets: 1783419988,
      }),
    ]);

    const u = aggregateCodexUsage(p);
    // 直近（末尾）の token_count が採用される。
    expect(u.inputTokens).toBe(193130);
    expect(u.outputTokens).toBe(1861);
    expect(u.cacheReadTokens).toBe(163200);
    expect(u.cacheCreationTokens).toBe(0);
    expect(u.contextWindow).toBe(258400);
    expect(u.fiveHourUtilization).toBe(4);
    expect(u.sevenDayUtilization).toBe(9);
    expect(u.fiveHourResetsAt).toBe(new Date(1783056714 * 1000).toISOString());
    expect(u.sevenDayResetsAt).toBe(new Date(1783419988 * 1000).toISOString());
  });

  test("token_count が無ければ空集計（全 0）", () => {
    const p = writeRolloutFile([
      JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/w" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
    ]);
    const u = aggregateCodexUsage(p);
    expect(u).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 });
    expect(u.fiveHourUtilization).toBeUndefined();
  });

  test("読めないパスは空集計", () => {
    expect(aggregateCodexUsage("/no/such/rollout.jsonl")).toMatchObject({ inputTokens: 0 });
  });
});
