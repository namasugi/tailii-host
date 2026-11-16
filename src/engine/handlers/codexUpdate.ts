import { CodexUpdater } from "../../codex/codexUpdater.js";
import type { HandlerRegistry } from "../context.js";

export function createCodexUpdateHandlers(updater = new CodexUpdater()): HandlerRegistry {
  return {
    codex_update_request: async (message, ctx) => {
      const update = await (message.action === "install" ? updater.install() : updater.check())
        .catch(() => ({ status: "unavailable" as const, canUpdate: false }));
      ctx.writer.write({ type: "codex_update_response", v: ctx.state.negotiatedVersion, id: message.id, update });
    },
  };
}

export const codexUpdateHandlers = createCodexUpdateHandlers();
