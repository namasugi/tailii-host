// engine/handlers/index.ts
// 全ドメインのハンドラを 1 つの registry に合成する。handleLine（engine.ts）は
// decode 済み ControlMessage の type でここから引く。1 type = 1 ハンドラ
// （重複キーは後勝ちになるため、追加時は既存ドメインとの重複に注意）。

import type { HandlerRegistry } from "../context.js";
import { claudeModelHandlers } from "./claudeModels.js";
import { codexHandlers } from "./codex.js";
import { conversationHandlers } from "./conversation.js";
import { coreHandlers } from "./core.js";
import { gitHandlers } from "./git.js";
import { modeHandlers } from "./mode.js";
import { officialAppHandlers } from "./officialApps.js";
import { previewHandlers } from "./preview.js";
import { sessionHandlers } from "./session.js";
import { usageHandlers } from "./usage.js";
import { workspaceHandlers } from "./workspace.js";

export const ENGINE_HANDLERS: HandlerRegistry = {
  ...coreHandlers,
  ...sessionHandlers,
  ...conversationHandlers,
  ...codexHandlers,
  ...claudeModelHandlers,
  ...officialAppHandlers,
  ...modeHandlers,
  ...usageHandlers,
  ...workspaceHandlers,
  ...gitHandlers,
  ...previewHandlers,
};
