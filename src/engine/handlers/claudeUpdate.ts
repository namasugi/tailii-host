import { ClaudeUpdater } from "../../updates/claudeUpdater.js";
import type { HandlerRegistry } from "../context.js";

export function createClaudeUpdateHandlers(updater = new ClaudeUpdater()): HandlerRegistry {
  return {
    claude_update_request: async (message, ctx) => {
      const update = await (message.action === "install" ? updater.install() : updater.check())
        .catch(() => ({ status: "unavailable" as const, canUpdate: false }));
      ctx.writer.write({ type: "claude_update_response", v: ctx.state.negotiatedVersion, id: message.id, update });
    },
  };
}

export const claudeUpdateHandlers = createClaudeUpdateHandlers();
