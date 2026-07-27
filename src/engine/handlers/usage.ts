// engine/handlers/usage.ts
// 使用量応答: tail 中会話のエージェント種別で分岐する。codex は rollout 集計
// （rate_limits 含む）、claude は transcript 合算 + OAuth プラン使用量 API。

import * as os from "node:os";
import * as path from "node:path";
import { CodexRolloutTailer } from "../../codex/codexRolloutTailer.js";
import { aggregateCodexUsage, type CodexUsage } from "../../codex/codexUsage.js";
import { claudeProjectSlug } from "../../shared/paths.js";
import { aggregateUsage, emptyUsageTotals } from "../../services/usageAggregator.js";
import { TranscriptTailer } from "../../chat/transcriptTailer.js";
import type { HandlerRegistry } from "../context.js";

export const usageHandlers: HandlerRegistry = {
  usage_request: async (message, ctx) => {
    const { writer, state, metadataStore } = ctx;
    const v = state.negotiatedVersion;
    // 開いている会話が codex なら常に codex 集計で応答する（rate_limits を含む, codex-input）。
    // 分岐は「rollout が解決済みか」ではなく「tail 中の会話が codex か」で行う。rollout 未解決でも
    // Claude の OAuth プラン使用量 API へは絶対に落とさない（codex 会話に Claude の状態が出る不具合
    // の防止, 2026-07-07 ユーザー指摘）。codex は OAuth プラン使用量非対応なので planUsage は使わない。
    const tailAgent = ctx.activeChatSession.name === null
      ? ctx.defaultAgent
      : metadataStore?.get(ctx.activeChatSession.name)?.agent ?? ctx.defaultAgent;
    if (tailAgent === "codex") {
      const currentMeta = ctx.activeChatSession.name === null ? null : metadataStore?.get(ctx.activeChatSession.name) ?? null;
      const codexRollout = currentMeta === null ? null : new CodexRolloutTailer().resolve(
        currentMeta.cwd, null, currentMeta.providerSessionId ?? null,
      );
      // rollout 未解決（起動直後等）は空集計で返す。Claude 分岐へは落とさない。
      const cu: CodexUsage =
        codexRollout !== null ? aggregateCodexUsage(codexRollout) : { ...emptyUsageTotals() };
      try {
        writer.write({
          type: "usage_response",
          v,
          id: message.id,
          inputTokens: cu.inputTokens,
          outputTokens: cu.outputTokens,
          cacheReadTokens: cu.cacheReadTokens,
          cacheCreationTokens: cu.cacheCreationTokens,
          turns: cu.turns,
          ...(cu.fiveHourUtilization !== undefined && { fiveHourUtilization: cu.fiveHourUtilization }),
          ...(cu.fiveHourResetsAt !== undefined && { fiveHourResetsAt: cu.fiveHourResetsAt }),
          ...(cu.sevenDayUtilization !== undefined && { sevenDayUtilization: cu.sevenDayUtilization }),
          ...(cu.sevenDayResetsAt !== undefined && { sevenDayResetsAt: cu.sevenDayResetsAt }),
        });
      } catch {
        // 書込失敗は握り潰す。
      }
      return;
    }
    // 使用量（claude）: プラン使用率（OAuth 使用量 API, ベストエフォート）+ tail 中会話の usage 合算。
    const currentMeta = ctx.activeChatSession.name === null ? null : metadataStore?.get(ctx.activeChatSession.name) ?? null;
    const transcript = currentMeta === null ? null : TranscriptTailer.resolveJsonl(
      path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(currentMeta.cwd)),
      currentMeta.providerSessionId ?? currentMeta.claudeSessionId ?? null,
      null,
    );
    const totals = transcript !== null ? aggregateUsage(transcript) : emptyUsageTotals();
    const plan = await ctx.planUsage();
    try {
      writer.write({
        type: "usage_response",
        v,
        id: message.id,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        turns: totals.turns,
        ...(plan?.fiveHourUtilization != null && { fiveHourUtilization: plan.fiveHourUtilization }),
        ...(plan?.fiveHourResetsAt != null && { fiveHourResetsAt: plan.fiveHourResetsAt }),
        ...(plan?.sevenDayUtilization != null && { sevenDayUtilization: plan.sevenDayUtilization }),
        ...(plan?.sevenDayResetsAt != null && { sevenDayResetsAt: plan.sevenDayResetsAt }),
        ...(plan?.sevenDayFableUtilization != null && {
          sevenDayFableUtilization: plan.sevenDayFableUtilization,
        }),
        ...(plan?.sevenDayFableResetsAt != null && {
          sevenDayFableResetsAt: plan.sevenDayFableResetsAt,
        }),
      });
    } catch {
      // 書込失敗は握り潰す（Swift 版 try? と同じ）。
    }
  },
};
