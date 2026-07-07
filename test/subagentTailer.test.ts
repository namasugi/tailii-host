// subagentTailer.test.ts — サブエージェント進捗ツリー tail テスト

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import { SubagentTailer } from "../src/subagentTailer.js";
import { makeTempDir } from "./helpers.js";

async function nextOfType(
  gen: AsyncGenerator<ControlMessage, void, void>,
  type: string,
): Promise<ControlMessage> {
  for (;;) {
    const next = await gen.next();
    if (next.done) throw new Error(`type ${type} が流れないまま終了`);
    if (next.value.type === type) return next.value;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function nextWithin(
  gen: AsyncGenerator<ControlMessage, void, void>,
  ms: number,
): Promise<ControlMessage | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  const next = gen.next().then((item) => item.value ?? null);
  return await Promise.race([next, timeout]);
}

describe("SubagentTailer", () => {
  test("meta spawn と親 transcript の tool_result から running→completed を送出する", async () => {
    const project = makeTempDir("subagent-tailer");
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });

    fs.writeFileSync(
      main,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_parent", name: "Agent", input: { description: "Food" } },
          ],
        },
        timestamp: "2026-07-03T02:18:18.000Z",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-child.meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        description: "Search food mechanics specs",
        toolUseId: "toolu_parent",
        spawnDepth: 1,
      }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-child.jsonl"),
      JSON.stringify({
        agentId: "child",
        isSidechain: true,
        message: { role: "user", content: "start" },
        timestamp: "2026-07-03T02:18:21.453Z",
      }) + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({
      type: "subagent_node",
      v: 2,
      node: {
        nodeId: "child",
        toolUseId: "toolu_parent",
        parentNodeId: "root",
        status: "running",
        ts: Date.parse("2026-07-03T02:18:21.453Z"),
      },
    });

    fs.appendFileSync(
      main,
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_parent", content: "done" }],
        },
        timestamp: "2026-07-03T02:20:00.000Z",
      }) + "\n",
    );

    const completed = await nextOfType(gen, "subagent_node");
    expect(completed).toMatchObject({
      type: "subagent_node",
      node: {
        nodeId: "child",
        parentNodeId: "root",
        status: "completed",
        ts: Date.parse("2026-07-03T02:20:00.000Z"),
      },
    });
    ac.abort();
  });

  test("tail 中に追加された meta/jsonl と追記 tool_result から重複なく completed へ進む", async () => {
    const project = makeTempDir("subagent-tailer-incremental");
    const sessionId = "22222222-3333-4444-5555-666666666666";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });

    fs.writeFileSync(
      main,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_incremental", name: "Agent", input: { description: "Incremental" } },
          ],
        },
        timestamp: "2026-07-03T02:18:18.000Z",
      }) + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);
    await sleep(25);

    fs.writeFileSync(
      path.join(subagents, "agent-incremental.meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        description: "Incremental child",
        toolUseId: "toolu_incremental",
        spawnDepth: 1,
      }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-incremental.jsonl"),
      JSON.stringify({
        agentId: "incremental",
        isSidechain: true,
        message: { role: "user", content: "start" },
        timestamp: "2026-07-03T02:18:22.000Z",
      }) + "\n",
    );

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({
      type: "subagent_node",
      node: {
        nodeId: "incremental",
        toolUseId: "toolu_incremental",
        parentNodeId: "root",
        status: "running",
        ts: Date.parse("2026-07-03T02:18:22.000Z"),
      },
    });

    const filler = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }] },
        timestamp: "2026-07-03T02:19:00.000Z",
      }),
    ).join("\n");
    fs.appendFileSync(main, `${filler}\n`);
    await sleep(25);
    fs.appendFileSync(
      main,
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_incremental", content: "done" }],
        },
        timestamp: "2026-07-03T02:20:30.000Z",
      }) + "\n",
    );

    const completed = await nextOfType(gen, "subagent_node");
    expect(completed).toMatchObject({
      type: "subagent_node",
      node: {
        nodeId: "incremental",
        parentNodeId: "root",
        status: "completed",
        ts: Date.parse("2026-07-03T02:20:30.000Z"),
      },
    });
    expect(await nextWithin(gen, 50)).toBeNull();
    ac.abort();
  });

  test("subagent jsonl の追記 tool_use で currentActivity を更新し完了時に消す", async () => {
    const project = makeTempDir("subagent-tailer-activity");
    const sessionId = "33333333-4444-5555-6666-777777777777";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    const childJsonl = path.join(subagents, "agent-activity.jsonl");
    fs.mkdirSync(subagents, { recursive: true });

    fs.writeFileSync(
      main,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_activity", name: "Agent", input: { description: "Activity" } },
          ],
        },
        timestamp: "2026-07-03T02:18:18.000Z",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-activity.meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        description: "Run tests",
        toolUseId: "toolu_activity",
        spawnDepth: 1,
      }),
    );
    fs.writeFileSync(
      childJsonl,
      JSON.stringify({
        agentId: "activity",
        isSidechain: true,
        message: { role: "user", content: "start" },
        timestamp: "2026-07-03T02:18:21.000Z",
      }) + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({
      type: "subagent_node",
      node: {
        nodeId: "activity",
        status: "running",
        currentActivity: null,
      },
    });

    fs.appendFileSync(
      childJsonl,
      JSON.stringify({
        agentId: "activity",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_bash",
              name: "Bash",
              input: { command: "npm test", description: "Run host tests" },
            },
          ],
        },
        timestamp: "2026-07-03T02:18:30.000Z",
      }) + "\n",
    );

    const active = await nextOfType(gen, "subagent_node");
    expect(active).toMatchObject({
      type: "subagent_node",
      node: {
        nodeId: "activity",
        status: "running",
        currentActivity: "Bash: npm test",
      },
    });

    fs.appendFileSync(
      main,
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_activity", content: "done" }],
        },
        timestamp: "2026-07-03T02:20:00.000Z",
      }) + "\n",
    );

    const completed = await nextOfType(gen, "subagent_node");
    expect(completed).toMatchObject({
      type: "subagent_node",
      node: {
        nodeId: "activity",
        status: "completed",
        currentActivity: null,
      },
    });
    ac.abort();
  });
});
