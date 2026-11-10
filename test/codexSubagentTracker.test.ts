// codexSubagentTracker.test.ts — Codex の subAgentActivity の kind とノード状態
import { describe, expect, it } from "vitest";
import { CodexSubagentTracker } from "../src/codex/codexSubagentTracker.js";

const activity = (kind: string, id = `activity-${kind}`): Record<string, unknown> => ({
  id, type: "subAgentActivity", kind, agentThreadId: "child", agentPath: "/root/investigate",
});

describe("CodexSubagentTracker: subAgentActivity の kind", () => {
  it("completed（子の turn が終わった）は完了にし、続きの依頼（interacted）でまた動き出す", () => {
    const tracker = new CodexSubagentTracker("root");
    expect(tracker.ingestItem(activity("started"), 1)[0]?.status).toBe("running");
    expect(tracker.ingestItem(activity("completed"), 2)[0]?.status).toBe("completed");
    // 同じ子へ親が続きの依頼を送る（Codex は子を使い回す）。
    expect(tracker.ingestItem(activity("interacted", "followup-1"), 3)[0]?.status).toBe("running");
    expect(tracker.ingestItem(activity("completed", "done-2"), 4)[0]?.status).toBe("completed");
  });

  it("子 thread の status が idle になった後に completed が届いても実行中へ戻さない", () => {
    const tracker = new CodexSubagentTracker("root");
    tracker.ingestItem(activity("started"), 1);
    expect(tracker.ingestThreadStatus("child", { type: "idle" }, 2)[0]?.status).toBe("completed");
    // 状態が変わらないので更新は出ない（＝完了のまま）。
    expect(tracker.ingestItem(activity("completed"), 3)).toEqual([]);
  });

  it("エラーで終わった子は、終わりの通知でエラーを消さない", () => {
    const tracker = new CodexSubagentTracker("root");
    tracker.ingestItem(activity("started"), 1);
    expect(tracker.ingestThreadStatus("child", { type: "systemError" }, 2)[0]?.status).toBe("error");
    expect(tracker.ingestItem(activity("completed"), 3)).toEqual([]);
    expect(tracker.ingestItem(activity("interrupted"), 4)).toEqual([]);
  });
});
