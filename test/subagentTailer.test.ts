// subagentTailer.test.ts — サブエージェント進捗ツリー tail テスト

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import { defaultProbeSessionAlive, SubagentTailer, type ProcessProbeExec } from "../src/chat/subagentTailer.js";
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

/** 背景コマンドの spawn（tool_use + 起動 ack）だけを書いた main transcript を作る。 */
function writeBgSpawn(
  main: string,
  toolUseId: string,
  taskId: string,
  outputPath: string,
  timestamp = "2026-07-28T07:41:51.866Z",
): void {
  fs.writeFileSync(
    main,
    [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: toolUseId,
            name: "Bash",
            input: { command: "npm test", run_in_background: true, description: "背景コマンド" },
          }],
        },
        timestamp,
      }),
      JSON.stringify({
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath}. You will be notified when it completes.`,
          }],
        },
        timestamp,
      }),
    ].join("\n") + "\n",
  );
}

// 各テストは実 pgrep に依存しないようセッション生存プローブを固定する（既定=生存）。
const aliveSession = {
  probeSessionAlive: (): Promise<boolean | null> => Promise.resolve(true),
};

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
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
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
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
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
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
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

  test("バックグラウンド起動の即時 ack では完了させず task-notification で完了する", async () => {
    const project = makeTempDir("subagent-tailer-async");
    const sessionId = "44444444-5555-6666-7777-888888888888";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    const childJsonl = path.join(subagents, "agent-bg1.jsonl");
    fs.mkdirSync(subagents, { recursive: true });

    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_async", name: "Agent", input: { description: "BG agent" } },
            ],
          },
          timestamp: "2026-07-28T07:12:07.088Z",
        }),
        // バックグラウンド起動: spawn 直後に届く ack。終了信号ではない。
        JSON.stringify({
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_async",
              content: "Async agent launched successfully. agentId: bg1 …",
            }],
          },
          timestamp: "2026-07-28T07:12:07.328Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-bg1.meta.json"),
      JSON.stringify({
        agentType: "Explore",
        description: "BG agent",
        toolUseId: "toolu_async",
        spawnDepth: 1,
      }),
    );
    fs.writeFileSync(
      childJsonl,
      JSON.stringify({
        agentId: "bg1",
        isSidechain: true,
        message: { role: "user", content: "start" },
        timestamp: "2026-07-28T07:12:08.000Z",
      }) + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({
      node: { nodeId: "bg1", status: "running" },
    });
    // ack を読み終えた後も completed が湧かないこと（nextWithin は孤児 next() が
    // 後続 emission を飲むため、テスト末尾でのみ使える）。
    expect(await nextWithin(gen, 50)).toBeNull();
    ac.abort();
  });

  test("task-notification で完了し resume 追記で running へ戻り再通知で再完了する", async () => {
    const project = makeTempDir("subagent-tailer-async-notify");
    const sessionId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    const childJsonl = path.join(subagents, "agent-bg2.jsonl");
    fs.mkdirSync(subagents, { recursive: true });

    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_async2", name: "Agent", input: { description: "BG agent" } },
            ],
          },
          timestamp: "2026-07-28T07:12:07.088Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_async2",
              content: "Async agent launched successfully. agentId: bg2 …",
            }],
          },
          timestamp: "2026-07-28T07:12:07.328Z",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>bg2</task-id>\n<status>completed</status>\n<summary>Agent \"BG agent\" finished</summary>\n</task-notification>",
          },
          timestamp: "2026-07-28T07:18:38.435Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-bg2.meta.json"),
      JSON.stringify({
        agentType: "Explore",
        description: "BG agent",
        toolUseId: "toolu_async2",
        spawnDepth: 1,
      }),
    );
    fs.writeFileSync(
      childJsonl,
      JSON.stringify({
        agentId: "bg2",
        isSidechain: true,
        message: { role: "user", content: "start" },
        timestamp: "2026-07-28T07:12:08.000Z",
      }) + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);

    const completed = await nextOfType(gen, "subagent_node");
    expect(completed).toMatchObject({
      node: {
        nodeId: "bg2",
        status: "completed",
        ts: Date.parse("2026-07-28T07:18:38.435Z"),
      },
    });

    // SendMessage による resume: 通知より新しい行が subagent transcript に追記されたら running へ戻る。
    fs.appendFileSync(
      childJsonl,
      JSON.stringify({
        agentId: "bg2",
        isSidechain: true,
        message: { role: "user", content: "follow-up" },
        timestamp: "2026-07-28T07:20:00.000Z",
      }) + "\n",
    );
    const resumed = await nextOfType(gen, "subagent_node");
    expect(resumed).toMatchObject({ node: { nodeId: "bg2", status: "running" } });

    fs.appendFileSync(
      main,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>bg2</task-id>\n<status>completed</status>\n<summary>Agent \"BG agent\" finished</summary>\n</task-notification>",
        },
        timestamp: "2026-07-28T07:21:00.000Z",
      }) + "\n",
    );
    const completedAgain = await nextOfType(gen, "subagent_node");
    expect(completedAgain).toMatchObject({
      node: {
        nodeId: "bg2",
        status: "completed",
        ts: Date.parse("2026-07-28T07:21:00.000Z"),
      },
    });
    ac.abort();
  });

  test("バックグラウンドコマンドを kind=command ノードとして送出し exit code で完了/エラーを分ける", async () => {
    const project = makeTempDir("subagent-tailer-bg-command");
    const sessionId = "55555555-6666-7777-8888-999999999999";
    const main = path.join(project, `${sessionId}.jsonl`);
    fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });

    const outputPath = path.join(project, "tasks", "btask1.output");
    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "toolu_bg_cmd",
              name: "Bash",
              input: { command: "npm test", run_in_background: true, description: "host 全テスト実行" },
            }],
          },
          timestamp: "2026-07-28T07:41:51.866Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_bg_cmd",
              content: `Command running in background with ID: btask1. Output is being written to: ${outputPath}. You will be notified when it completes.`,
            }],
          },
          timestamp: "2026-07-28T07:41:52.000Z",
        }),
      ].join("\n") + "\n",
    );

    const ac = new AbortController();
    // 実 lsof の孤児判定に巻き込まれないよう、常に「生存」を返す。
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10, probeOutputOpen: () => Promise.resolve(true) });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({
      node: {
        nodeId: "btask1",
        toolUseId: "toolu_bg_cmd",
        parentNodeId: "root",
        agentType: "Bash",
        label: "host 全テスト実行",
        depth: 1,
        status: "running",
        kind: "command",
        ts: Date.parse("2026-07-28T07:41:51.866Z"),
      },
    });
    expect(tailer.outputPath("btask1")).toBe(outputPath);

    fs.appendFileSync(
      main,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>btask1</task-id>\n<status>completed</status>\n<summary>Background command \"host 全テスト実行\" completed (exit code 2)</summary>\n</task-notification>",
        },
        timestamp: "2026-07-28T07:45:00.000Z",
      }) + "\n",
    );

    const finished = await nextOfType(gen, "subagent_node");
    expect(finished).toMatchObject({
      node: {
        nodeId: "btask1",
        status: "error",
        kind: "command",
        ts: Date.parse("2026-07-28T07:45:00.000Z"),
      },
    });
    ac.abort();
  });

  test("通知が消えた背景コマンドは output 非保持の孤児判定で完了へ落とす", async () => {
    const project = makeTempDir("subagent-tailer-bg-orphan");
    const sessionId = "88888888-9999-aaaa-bbbb-cccccccccccc";
    const main = path.join(project, `${sessionId}.jsonl`);
    fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });

    const outputPath = path.join(project, "tasks", "borphan1.output");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "done output\n");
    writeBgSpawn(main, "toolu_bg_orphan", "borphan1", outputPath);

    const ac = new AbortController();
    const probed: string[] = [];
    const tailer = new SubagentTailer({ ...aliveSession,
      pollIntervalMs: 10,
      orphanGraceMs: 0,
      orphanProbeIntervalMs: 0,
      probeOutputOpen: (filePath) => {
        probed.push(filePath);
        return Promise.resolve(false);
      },
    });
    const gen = tailer.streamSession(main, ac.signal);

    const finished = await nextOfType(gen, "subagent_node");
    expect(finished).toMatchObject({
      node: {
        nodeId: "borphan1",
        status: "completed",
        kind: "command",
        ts: Math.floor(fs.statSync(outputPath).mtimeMs),
      },
    });
    expect(probed).toContain(outputPath);
    ac.abort();
  });

  test("output を保持するプロセスがいる背景コマンドは孤児にせず running を維持する", async () => {
    const project = makeTempDir("subagent-tailer-bg-alive");
    const sessionId = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const main = path.join(project, `${sessionId}.jsonl`);
    fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });

    const outputPath = path.join(project, "tasks", "balive1.output");
    writeBgSpawn(main, "toolu_bg_alive", "balive1", outputPath);

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession,
      pollIntervalMs: 10,
      orphanGraceMs: 0,
      orphanProbeIntervalMs: 0,
      probeOutputOpen: () => Promise.resolve(true),
    });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "balive1", status: "running", kind: "command" } });
    expect(await nextWithin(gen, 50)).toBeNull();
    ac.abort();
  });

  test("孤児判定が不能(null)なら安全側で running を維持する", async () => {
    const project = makeTempDir("subagent-tailer-bg-unknown");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const main = path.join(project, `${sessionId}.jsonl`);
    fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });

    const outputPath = path.join(project, "tasks", "bunknown1.output");
    writeBgSpawn(main, "toolu_bg_unknown", "bunknown1", outputPath);

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession,
      pollIntervalMs: 10,
      orphanGraceMs: 0,
      orphanProbeIntervalMs: 0,
      probeOutputOpen: () => Promise.resolve(null),
    });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "bunknown1", status: "running", kind: "command" } });
    expect(await nextWithin(gen, 50)).toBeNull();
    ac.abort();
  });

  test("起動猶予中の背景コマンドは孤児プローブの対象にしない", async () => {
    const project = makeTempDir("subagent-tailer-bg-grace");
    const sessionId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const main = path.join(project, `${sessionId}.jsonl`);
    fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });

    const outputPath = path.join(project, "tasks", "bgrace1.output");
    // 直近の起動として扱わせる（transcript ts を現在時刻にする）。
    writeBgSpawn(main, "toolu_bg_grace", "bgrace1", outputPath, new Date().toISOString());

    const ac = new AbortController();
    const probed: string[] = [];
    const tailer = new SubagentTailer({ ...aliveSession,
      pollIntervalMs: 10,
      orphanGraceMs: 60_000,
      orphanProbeIntervalMs: 0,
      probeOutputOpen: (filePath) => {
        probed.push(filePath);
        return Promise.resolve(false);
      },
    });
    const gen = tailer.streamSession(main, ac.signal);

    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "bgrace1", status: "running", kind: "command" } });
    expect(await nextWithin(gen, 50)).toBeNull();
    expect(probed).toEqual([]);
    ac.abort();
  });

  test("toolUseId なしの forked-skill 親も追跡し、その transcript 内の孫を解決する", async () => {
    const project = makeTempDir("subagent-tailer-forked-skill");
    const sessionId = "ffffffff-0000-1111-2222-333333333333";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });

    // /code-review 型: meta に toolUseId がなく name を持つ forked-skill 親。
    // 親を tail しないと、親 transcript 内の孫の spawn/通知が全て見えなくなる。
    fs.writeFileSync(
      main,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>fparent</task-id>\n<status>completed</status>\n<summary>Agent \"/code-review\" finished</summary>\n</task-notification>",
        },
        timestamp: "2026-08-10T10:10:00.000Z",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-fparent.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "/code-review --fix", name: "code-review", spawnDepth: 1 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-fparent.jsonl"),
      [
        JSON.stringify({
          agentId: "fparent",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_fc", name: "Agent", input: { description: "Finder" } }],
          },
          timestamp: "2026-08-10T10:01:00.000Z",
        }),
        JSON.stringify({
          agentId: "fparent",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_fc", content: "Async agent launched successfully. agentId: fchild …" }],
          },
          timestamp: "2026-08-10T10:01:01.000Z",
        }),
        // 孫の通知は親 transcript に届いている（正常系）。
        JSON.stringify({
          agentId: "fparent",
          isSidechain: true,
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>fchild</task-id>\n<status>completed</status>\n<summary>Agent \"Finder\" finished</summary>\n</task-notification>",
          },
          timestamp: "2026-08-10T10:08:00.000Z",
        }),
        JSON.stringify({
          agentId: "fparent",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "親の最終レポート" }] },
          timestamp: "2026-08-10T10:09:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-fchild.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Finder", toolUseId: "toolu_fc", spawnDepth: 2 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-fchild.jsonl"),
      [
        JSON.stringify({
          agentId: "fchild",
          isSidechain: true,
          message: { role: "user", content: "start" },
          timestamp: "2026-08-10T10:01:02.000Z",
        }),
        JSON.stringify({
          agentId: "fchild",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "孫の最終レポート" }] },
          timestamp: "2026-08-10T10:07:00.000Z",
        }),
      ].join("\n") + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);

    const seen = new Map<string, { status: string; parent: string | null; toolUseId: string }>();
    while (!seen.has("fparent") || !seen.has("fchild")
      || seen.get("fparent")?.status !== "completed" || seen.get("fchild")?.status !== "completed") {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type !== "subagent_node") continue;
      seen.set(message.node.nodeId, {
        status: message.node.status,
        parent: message.node.parentNodeId ?? null,
        toolUseId: message.node.toolUseId,
      });
    }
    // 親: main の通知で完了。ワイヤ互換のため toolUseId は空文字。
    expect(seen.get("fparent")).toMatchObject({ status: "completed", parent: "root", toolUseId: "" });
    // 孫: 親 transcript 内の通知で完了し、親子関係も解決される。
    expect(seen.get("fchild")).toMatchObject({ status: "completed", parent: "fparent", toolUseId: "toolu_fc" });
    ac.abort();
  });

  test("親が先に終端した孫の背景エージェントは通知なしでも孤児判定で完了へ落とす", async () => {
    const project = makeTempDir("subagent-tailer-agent-orphan");
    const sessionId = "cccccccc-dddd-eeee-ffff-000000000000";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });

    // main → 親(bg) → 孫(bg)。孫の通知は親 transcript に投函されるが、
    // 親が孫より先に終端したため永遠に届かない。
    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_op", name: "Agent", input: { description: "Parent" } }],
          },
          timestamp: "2026-08-10T07:00:00.000Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_op", content: "Async agent launched successfully. agentId: oparent …" }],
          },
          timestamp: "2026-08-10T07:00:01.000Z",
        }),
        // 親自身の完了通知は main に届いている。
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>oparent</task-id>\n<status>completed</status>\n<summary>Agent \"Parent\" finished</summary>\n</task-notification>",
          },
          timestamp: "2026-08-10T07:10:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-oparent.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "Parent", toolUseId: "toolu_op", spawnDepth: 1 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-oparent.jsonl"),
      [
        JSON.stringify({
          agentId: "oparent",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_oc", name: "Agent", input: { description: "Grandchild" } }],
          },
          timestamp: "2026-08-10T07:01:00.000Z",
        }),
        JSON.stringify({
          agentId: "oparent",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_oc", content: "Async agent launched successfully. agentId: ochild …" }],
          },
          timestamp: "2026-08-10T07:01:01.000Z",
        }),
        JSON.stringify({
          agentId: "oparent",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "親の最終レポート" }] },
          timestamp: "2026-08-10T07:09:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-ochild.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Grandchild", toolUseId: "toolu_oc", spawnDepth: 2 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-ochild.jsonl"),
      [
        JSON.stringify({
          agentId: "ochild",
          isSidechain: true,
          message: { role: "user", content: "start" },
          timestamp: "2026-08-10T07:01:02.000Z",
        }),
        JSON.stringify({
          agentId: "ochild",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "孫の最終レポート" }] },
          timestamp: "2026-08-10T07:12:00.000Z",
        }),
      ].join("\n") + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10, agentOrphanGraceMs: 0 });
    const gen = tailer.streamSession(main, ac.signal);

    // 孫は通知が来ないまま孤児判定で completed へ settle される（ts=自 transcript の最終行）。
    for (;;) {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type !== "subagent_node" || message.node.nodeId !== "ochild") continue;
      if (message.node.status === "running") continue;
      expect(message).toMatchObject({
        node: {
          nodeId: "ochild",
          parentNodeId: "oparent",
          status: "completed",
          ts: Date.parse("2026-08-10T07:12:00.000Z"),
        },
      });
      break;
    }
    ac.abort();
  });

  test("親が終端しても running の孫が残る背景エージェントは孤児にしない", async () => {
    const project = makeTempDir("subagent-tailer-agent-orphan-hold");
    const sessionId = "dddddddd-eeee-ffff-0000-111111111111";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });

    // main → 親(bg, 通知済み=終端) → 子(bg, 最終レポート済みだが自分の孫がまだ running)。
    // 子は自分の孫の通知で再開されうるため settle してはいけない。
    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_hp", name: "Agent", input: { description: "Parent" } }],
          },
          timestamp: "2026-08-10T08:00:00.000Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_hp", content: "Async agent launched successfully. agentId: hparent …" }],
          },
          timestamp: "2026-08-10T08:00:01.000Z",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>hparent</task-id>\n<status>completed</status>\n<summary>Agent \"Parent\" finished</summary>\n</task-notification>",
          },
          timestamp: "2026-08-10T08:10:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-hparent.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "Parent", toolUseId: "toolu_hp", spawnDepth: 1 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-hparent.jsonl"),
      [
        JSON.stringify({
          agentId: "hparent",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_hc", name: "Agent", input: { description: "Child" } }],
          },
          timestamp: "2026-08-10T08:01:00.000Z",
        }),
        JSON.stringify({
          agentId: "hparent",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_hc", content: "Async agent launched successfully. agentId: hchild …" }],
          },
          timestamp: "2026-08-10T08:01:01.000Z",
        }),
        JSON.stringify({
          agentId: "hparent",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "親の最終レポート" }] },
          timestamp: "2026-08-10T08:09:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-hchild.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Child", toolUseId: "toolu_hc", spawnDepth: 2 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-hchild.jsonl"),
      [
        JSON.stringify({
          agentId: "hchild",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_hg", name: "Agent", input: { description: "Grandchild" } }],
          },
          timestamp: "2026-08-10T08:02:00.000Z",
        }),
        JSON.stringify({
          agentId: "hchild",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_hg", content: "Async agent launched successfully. agentId: hgrand …" }],
          },
          timestamp: "2026-08-10T08:02:01.000Z",
        }),
        JSON.stringify({
          agentId: "hchild",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "子の最終レポート(孫待ち)" }] },
          timestamp: "2026-08-10T08:08:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    // 孫: 起動直後のまま（最終レポートなし= running）。
    fs.writeFileSync(
      path.join(subagents, "agent-hgrand.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Grandchild", toolUseId: "toolu_hg", spawnDepth: 3 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-hgrand.jsonl"),
      JSON.stringify({
        agentId: "hgrand",
        isSidechain: true,
        message: { role: "user", content: "start" },
        timestamp: "2026-08-10T08:02:02.000Z",
      }) + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10, agentOrphanGraceMs: 0 });
    const gen = tailer.streamSession(main, ac.signal);

    // 初期 emission (hparent completed / hchild running / hgrand running) を回収。
    const seen = new Map<string, string>();
    while (seen.size < 3) {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type === "subagent_node") seen.set(message.node.nodeId, message.node.status);
    }
    expect(seen.get("hparent")).toBe("completed");
    expect(seen.get("hchild")).toBe("running");
    expect(seen.get("hgrand")).toBe("running");
    // hgrand が running な限り hchild は settle されない
    // （hgrand 自身も最終レポートがないため settle 対象外）。
    expect(await nextWithin(gen, 100)).toBeNull();
    ac.abort();
  });

  test("孤児 settle 後に本物の通知が届いたらそちらの ts/status を優先する", async () => {
    const project = makeTempDir("subagent-tailer-agent-orphan-late");
    const sessionId = "eeeeeeee-ffff-0000-1111-222222222222";
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });

    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_lp", name: "Agent", input: { description: "Parent" } }],
          },
          timestamp: "2026-08-10T09:00:00.000Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_lp", content: "Async agent launched successfully. agentId: lparent …" }],
          },
          timestamp: "2026-08-10T09:00:01.000Z",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>lparent</task-id>\n<status>completed</status>\n<summary>Agent \"Parent\" finished</summary>\n</task-notification>",
          },
          timestamp: "2026-08-10T09:10:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-lparent.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "Parent", toolUseId: "toolu_lp", spawnDepth: 1 }),
    );
    const parentJsonl = path.join(subagents, "agent-lparent.jsonl");
    fs.writeFileSync(
      parentJsonl,
      [
        JSON.stringify({
          agentId: "lparent",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_lc", name: "Agent", input: { description: "Grandchild" } }],
          },
          timestamp: "2026-08-10T09:01:00.000Z",
        }),
        JSON.stringify({
          agentId: "lparent",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_lc", content: "Async agent launched successfully. agentId: lchild …" }],
          },
          timestamp: "2026-08-10T09:01:01.000Z",
        }),
        JSON.stringify({
          agentId: "lparent",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "親の最終レポート" }] },
          timestamp: "2026-08-10T09:09:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-lchild.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Grandchild", toolUseId: "toolu_lc", spawnDepth: 2 }),
    );
    fs.writeFileSync(
      path.join(subagents, "agent-lchild.jsonl"),
      [
        JSON.stringify({
          agentId: "lchild",
          isSidechain: true,
          message: { role: "user", content: "start" },
          timestamp: "2026-08-10T09:01:02.000Z",
        }),
        JSON.stringify({
          agentId: "lchild",
          isSidechain: true,
          message: { role: "assistant", content: [{ type: "text", text: "孫の最終レポート" }] },
          timestamp: "2026-08-10T09:12:00.000Z",
        }),
      ].join("\n") + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10, agentOrphanGraceMs: 0 });
    const gen = tailer.streamSession(main, ac.signal);

    for (;;) {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type !== "subagent_node" || message.node.nodeId !== "lchild") continue;
      if (message.node.status === "completed") break;
    }

    // 親が resume され、遅配の本物の通知が親 transcript に投函された。
    fs.appendFileSync(
      parentJsonl,
      JSON.stringify({
        agentId: "lparent",
        isSidechain: true,
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>lchild</task-id>\n<status>completed</status>\n<summary>Agent \"Grandchild\" finished</summary>\n</task-notification>",
        },
        timestamp: "2026-08-10T09:20:00.000Z",
      }) + "\n",
    );

    // 通知の追記で親自身は resume 扱い(running)の emission が先に流れるため、
    // lchild の更新だけを待つ。
    for (;;) {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type !== "subagent_node" || message.node.nodeId !== "lchild") continue;
      expect(message).toMatchObject({
        node: {
          nodeId: "lchild",
          status: "completed",
          ts: Date.parse("2026-08-10T09:20:00.000Z"),
        },
      });
      break;
    }
    ac.abort();
  });

  test("TaskStop で停止されたバックグラウンドコマンドは通知なしでも完了へ落とす", async () => {
    const project = makeTempDir("subagent-tailer-bg-stop");
    const sessionId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const main = path.join(project, `${sessionId}.jsonl`);
    fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });

    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "toolu_bg_stop",
              name: "Bash",
              input: { command: "sleep 9999", run_in_background: true, description: "復帰待ちループ" },
            }],
          },
          timestamp: "2026-07-29T01:00:00.000Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_bg_stop",
              content: "Command running in background with ID: bstop1. Output is being written to: /tmp/bstop1.output.",
            }],
          },
          timestamp: "2026-07-29T01:00:01.000Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_taskstop",
              content: "{\"message\":\"Successfully stopped task: bstop1 (sleep 9999)\",\"task_id\":\"bstop1\"}",
            }],
          },
          timestamp: "2026-07-29T01:05:00.000Z",
        }),
      ].join("\n") + "\n",
    );

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);

    const finished = await nextOfType(gen, "subagent_node");
    expect(finished).toMatchObject({
      node: {
        nodeId: "bstop1",
        status: "completed",
        kind: "command",
        ts: Date.parse("2026-07-29T01:05:00.000Z"),
      },
    });
    ac.abort();
  });
});

// エージェント孤児判定（通知が配達されえない背景エージェントの settle）の網羅テスト。
describe("SubagentTailer agent orphan", () => {
  interface AgentFixture {
    id: string;
    meta: Record<string, unknown>;
    lines: Record<string, unknown>[];
  }

  /** main + サブエージェント群のフィクスチャを書き出し、main の path を返す。 */
  function writeSession(
    name: string,
    sessionId: string,
    mainLines: Record<string, unknown>[],
    agents: AgentFixture[],
  ): string {
    const project = makeTempDir(name);
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(main, mainLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    for (const agent of agents) {
      fs.writeFileSync(path.join(subagents, `agent-${agent.id}.meta.json`), JSON.stringify(agent.meta));
      fs.writeFileSync(
        path.join(subagents, `agent-${agent.id}.jsonl`),
        agent.lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
    }
    return main;
  }

  const spawnLine = (toolUseId: string, description: string, ts: string): Record<string, unknown> => ({
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description } }],
    },
    timestamp: ts,
  });
  const ackLine = (toolUseId: string, agentId: string, ts: string): Record<string, unknown> => ({
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `Async agent launched successfully. agentId: ${agentId} …`,
      }],
    },
    timestamp: ts,
  });
  const finalLine = (agentId: string, text: string, ts: string): Record<string, unknown> => ({
    agentId,
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts,
  });
  const rootIdleLine = (ts: string): Record<string, unknown> => ({
    message: { role: "assistant", content: [{ type: "text", text: "背景で待つ" }] },
    timestamp: ts,
  });

  /** 各ノードの最新 status が期待に一致するまで emission を回収する。 */
  async function collectUntil(
    gen: AsyncGenerator<ControlMessage, void, void>,
    expected: Record<string, string>,
  ): Promise<void> {
    const seen = new Map<string, string>();
    while (Object.keys(expected).some((id) => seen.get(id) !== expected[id])) {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type === "subagent_node") seen.set(message.node.nodeId, message.node.status);
    }
  }

  test("root 起動の深さ1背景エージェントも、rootがターン中でなければ孤児 settle する", async () => {
    const main = writeSession("agent-orphan-root", "00000000-0000-0000-0000-000000000001", [
      spawnLine("toolu_r1", "BG worker", "2026-08-10T11:00:00.000Z"),
      ackLine("toolu_r1", "rworker", "2026-08-10T11:00:01.000Z"),
      rootIdleLine("2026-08-10T11:00:02.000Z"),
    ], [{
      id: "rworker",
      meta: { agentType: "Explore", description: "BG worker", toolUseId: "toolu_r1", spawnDepth: 1 },
      lines: [finalLine("rworker", "最終レポート", "2026-08-10T11:05:00.000Z")],
    }]);

    const ac = new AbortController();
    // セッション死亡確定 + 猶予は transcript 時刻起点: 過去データなら grace>0 でも即 settle できる。
    const tailer = new SubagentTailer({
      probeSessionAlive: () => Promise.resolve(false),
      pollIntervalMs: 10,
      agentOrphanGraceMs: 60_000,
    });
    const gen = tailer.streamSession(main, ac.signal);
    await collectUntil(gen, { rworker: "completed" });
    ac.abort();
  });

  test("セッション生存中は root 起動の背景エージェントを settle しない(SendMessage 待機の保護)", async () => {
    const main = writeSession("agent-orphan-root-busy", "00000000-0000-0000-0000-000000000002", [
      spawnLine("toolu_r2", "BG worker", "2026-08-10T11:00:00.000Z"),
      ackLine("toolu_r2", "rbusy", "2026-08-10T11:00:01.000Z"),
      rootIdleLine("2026-08-10T11:00:02.000Z"),
    ], [{
      id: "rbusy",
      meta: { agentType: "Explore", description: "BG worker", toolUseId: "toolu_r2", spawnDepth: 1 },
      // 中間レポートを出して追送を待っている「生きた」エージェントと区別できない形。
      lines: [finalLine("rbusy", "中間レポート", "2026-08-10T11:05:00.000Z")],
    }]);

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10, agentOrphanGraceMs: 0 });
    const gen = tailer.streamSession(main, ac.signal);
    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "rbusy", status: "running" } });
    expect(await nextWithin(gen, 100)).toBeNull();
    ac.abort();
  });

  test("生存不明(プローブ null)でも root 起動は settle しない", async () => {
    const main = writeSession("agent-orphan-root-unknown", "00000000-0000-0000-0000-000000000007", [
      spawnLine("toolu_r3", "BG worker", "2026-08-10T11:00:00.000Z"),
      ackLine("toolu_r3", "runknown", "2026-08-10T11:00:01.000Z"),
    ], [{
      id: "runknown",
      meta: { agentType: "Explore", description: "BG worker", toolUseId: "toolu_r3", spawnDepth: 1 },
      lines: [finalLine("runknown", "最終レポート", "2026-08-10T11:05:00.000Z")],
    }]);

    const ac = new AbortController();
    const tailer = new SubagentTailer({
      probeSessionAlive: () => Promise.resolve(null),
      pollIntervalMs: 10,
      agentOrphanGraceMs: 0,
    });
    const gen = tailer.streamSession(main, ac.signal);
    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "runknown", status: "running" } });
    expect(await nextWithin(gen, 100)).toBeNull();
    ac.abort();
  });

  test("死亡セッションでは通知が全滅した forked-skill 親子も一括で settle する", async () => {
    // main → forked 親(toolUseIdなし) → 子(bg)。通知はどこにも届いていない。
    const main = writeSession("agent-orphan-forked-chain", "00000000-0000-0000-0000-000000000003", [
      rootIdleLine("2026-08-10T12:00:00.000Z"),
    ], [
      {
        id: "fkparent",
        meta: { agentType: "general-purpose", description: "/code-review --fix", name: "code-review", spawnDepth: 1 },
        lines: [
          spawnLine("toolu_fk1", "Finder", "2026-08-10T12:01:00.000Z"),
          ackLine("toolu_fk1", "fkchild", "2026-08-10T12:01:01.000Z"),
          finalLine("fkparent", "親の最終レポート", "2026-08-10T12:09:00.000Z"),
        ],
      },
      {
        id: "fkchild",
        meta: { agentType: "Explore", description: "Finder", toolUseId: "toolu_fk1", parentAgentId: "fkparent", spawnDepth: 2 },
        lines: [finalLine("fkchild", "子の最終レポート", "2026-08-10T12:07:00.000Z")],
      },
    ]);

    const ac = new AbortController();
    const tailer = new SubagentTailer({
      probeSessionAlive: () => Promise.resolve(false),
      pollIntervalMs: 10,
      agentOrphanGraceMs: 0,
    });
    const gen = tailer.streamSession(main, ac.signal);
    await collectUntil(gen, { fkparent: "completed", fkchild: "completed" });
    ac.abort();
  });

  test("meta の stoppedByUser を後追いで検知して完了へ落とす", async () => {
    const main = writeSession("agent-orphan-stopped", "00000000-0000-0000-0000-000000000004", [
      spawnLine("toolu_st", "Stopped worker", "2026-08-10T13:00:00.000Z"),
      ackLine("toolu_st", "stworker", "2026-08-10T13:00:01.000Z"),
    ], [{
      id: "stworker",
      meta: { agentType: "Explore", description: "Stopped worker", toolUseId: "toolu_st", spawnDepth: 1 },
      // 停止されたエージェント: 最後の行は tool_use のまま(最終レポートなし)。
      lines: [{
        agentId: "stworker",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "sleep 999" } }],
        },
        timestamp: "2026-08-10T13:01:00.000Z",
      }],
    }]);

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10 });
    const gen = tailer.streamSession(main, ac.signal);
    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "stworker", status: "running" } });

    // TaskStop 相当: ハーネスが meta に stoppedByUser を刻む(mtime 変化で再読込される)。
    await sleep(15);
    const metaPath = path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents", "agent-stworker.meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({
      agentType: "Explore",
      description: "Stopped worker",
      toolUseId: "toolu_st",
      spawnDepth: 1,
      stoppedByUser: true,
    }));
    await collectUntil(gen, { stworker: "completed" });
    ac.abort();
  });

  test("死亡セッションでも静止時間が猶予未満のノードは settle しない", async () => {
    const now = new Date().toISOString();
    const main = writeSession("agent-orphan-grace", "00000000-0000-0000-0000-000000000005", [
      spawnLine("toolu_gr", "Fresh worker", now),
      ackLine("toolu_gr", "grworker", now),
    ], [{
      id: "grworker",
      meta: { agentType: "Explore", description: "Fresh worker", toolUseId: "toolu_gr", spawnDepth: 1 },
      lines: [finalLine("grworker", "たった今の最終レポート", now)],
    }]);

    const ac = new AbortController();
    const tailer = new SubagentTailer({
      probeSessionAlive: () => Promise.resolve(false),
      pollIntervalMs: 10,
      agentOrphanGraceMs: 60_000,
    });
    const gen = tailer.streamSession(main, ac.signal);
    const running = await nextOfType(gen, "subagent_node");
    expect(running).toMatchObject({ node: { nodeId: "grworker", status: "running" } });
    expect(await nextWithin(gen, 100)).toBeNull();
    ac.abort();
  });

  test("settle 後に user 行(再開注入)が届いたら running へ戻り、以後は候補にしない", async () => {
    // 生存セッションの終端アンカー経由: 親は通知で終端済み → 孫が孤児 settle される。
    const main = writeSession("agent-orphan-rollback", "00000000-0000-0000-0000-000000000006", [
      spawnLine("toolu_rbp", "Rollback parent", "2026-08-10T14:00:00.000Z"),
      ackLine("toolu_rbp", "rbparent", "2026-08-10T14:00:01.000Z"),
      {
        type: "user",
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>rbparent</task-id>\n<status>completed</status>\n<summary>Agent \"Rollback parent\" finished</summary>\n</task-notification>",
        },
        timestamp: "2026-08-10T14:06:00.000Z",
      },
    ], [
      {
        id: "rbparent",
        meta: { agentType: "general-purpose", description: "Rollback parent", toolUseId: "toolu_rbp", spawnDepth: 1 },
        lines: [
          spawnLine("toolu_rb", "Rollback worker", "2026-08-10T14:01:00.000Z"),
          ackLine("toolu_rb", "rbworker", "2026-08-10T14:01:01.000Z"),
          finalLine("rbparent", "親の最終レポート", "2026-08-10T14:05:30.000Z"),
        ],
      },
      {
        id: "rbworker",
        meta: { agentType: "Explore", description: "Rollback worker", toolUseId: "toolu_rb", parentAgentId: "rbparent", spawnDepth: 2 },
        lines: [finalLine("rbworker", "最終レポート", "2026-08-10T14:05:00.000Z")],
      },
    ]);

    const ac = new AbortController();
    const tailer = new SubagentTailer({ ...aliveSession, pollIntervalMs: 10, agentOrphanGraceMs: 0 });
    const gen = tailer.streamSession(main, ac.signal);
    await collectUntil(gen, { rbworker: "completed" });

    // SendMessage 相当の user 行が subagent transcript に追記された。
    const childJsonl = path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents", "agent-rbworker.jsonl");
    fs.appendFileSync(
      childJsonl,
      JSON.stringify({
        agentId: "rbworker",
        isSidechain: true,
        message: { role: "user", content: "follow-up" },
        timestamp: "2026-08-10T14:10:00.000Z",
      }) + "\n",
    );
    await collectUntil(gen, { rbworker: "running" });
    // 最後の行が user 行(長考中)の間は、猶予0でも再 settle しない。
    expect(await nextWithin(gen, 100)).toBeNull();
    ac.abort();
  });
});

// 死亡セッション sweep の状態区別・誤判定からの回復・既定プローブの分岐。
describe("SubagentTailer session liveness", () => {
  const writeAgentSession = (
    name: string,
    sessionId: string,
    finalReport: boolean,
  ): { main: string; childJsonl: string } => {
    const project = makeTempDir(name);
    const main = path.join(project, `${sessionId}.jsonl`);
    const subagents = path.join(project, sessionId, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(
      main,
      [
        JSON.stringify({
          cwd: "/tmp/liveness-project",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_lv", name: "Agent", input: { description: "Worker" } }],
          },
          timestamp: "2026-08-10T15:00:00.000Z",
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_lv",
              content: "Async agent launched successfully. agentId: lvworker …",
            }],
          },
          timestamp: "2026-08-10T15:00:01.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(subagents, "agent-lvworker.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Worker", toolUseId: "toolu_lv", spawnDepth: 1 }),
    );
    const childJsonl = path.join(subagents, "agent-lvworker.jsonl");
    const lastLine = finalReport
      ? {
        agentId: "lvworker",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "最終レポート" }] },
        timestamp: "2026-08-10T15:05:00.000Z",
      }
      : {
        agentId: "lvworker",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_wip", name: "Bash", input: { command: "npm test" } }],
        },
        timestamp: "2026-08-10T15:05:00.000Z",
      };
    fs.writeFileSync(childJsonl, JSON.stringify(lastLine) + "\n");
    return { main, childJsonl };
  };

  test("死亡 sweep は最終レポート済み=completed / tool_use のまま=error(中断) に分ける", async () => {
    const done = writeAgentSession("liveness-sweep-done", "00000000-0000-0000-0000-000000000010", true);
    const wip = writeAgentSession("liveness-sweep-wip", "00000000-0000-0000-0000-000000000011", false);

    for (const [fixture, expected] of [[done, "completed"], [wip, "error"]] as const) {
      const ac = new AbortController();
      const tailer = new SubagentTailer({
        probeSessionAlive: () => Promise.resolve(false),
        pollIntervalMs: 10,
        agentOrphanGraceMs: 0,
      });
      const gen = tailer.streamSession(fixture.main, ac.signal);
      for (;;) {
        const message = await nextOfType(gen, "subagent_node");
        if (message.type !== "subagent_node" || message.node.status === "running") continue;
        expect(message.node.status).toBe(expected);
        break;
      }
      ac.abort();
    }
  });

  test("死亡判定が生存へ転じたら sweep マークを破棄して running へ戻す", async () => {
    const fixture = writeAgentSession("liveness-recover", "00000000-0000-0000-0000-000000000012", false);
    const answers: (boolean | null)[] = [false];
    const ac = new AbortController();
    const tailer = new SubagentTailer({
      // 1回目だけ死亡確定、その後は生存。
      probeSessionAlive: () => Promise.resolve(answers.shift() ?? true),
      pollIntervalMs: 10,
      agentOrphanGraceMs: 0,
      orphanProbeIntervalMs: 0,
    });
    const gen = tailer.streamSession(fixture.main, ac.signal);
    const statuses: string[] = [];
    // 初回 tick で即 sweep(error) → 次のプローブで生存 → 回復して running。
    while (statuses.length < 2) {
      const message = await nextOfType(gen, "subagent_node");
      if (message.type !== "subagent_node") continue;
      if (statuses.at(-1) !== message.node.status) statuses.push(message.node.status);
    }
    expect(statuses).toEqual(["error", "running"]);
    ac.abort();
  });

  test("defaultProbeSessionAlive の分岐: argv一致/静止/最近更新/活動不明/プローブ不能", async () => {
    interface ExecSpec {
      error: number | string | null;
      out?: string;
    }
    const fake = (argvProbe: ExecSpec): ProcessProbeExec =>
      (_cmd, _args, callback) => {
        if (argvProbe.error === null) {
          callback(null, argvProbe.out ?? "");
        } else {
          const error = new Error(`exit ${argvProbe.error}`) as Error & { code?: unknown };
          error.code = argvProbe.error;
          callback(error, argvProbe.out ?? "");
        }
      };
    const staleMs = 60_000;
    const oldTs = Date.now() - 120_000;
    const freshTs = Date.now() - 1_000;

    // argv 一致 → 生存確定(静止時間は見ない)。
    await expect(defaultProbeSessionAlive("sid", oldTs, staleMs, fake({ error: null, out: "1234\n" }))).resolves.toBe(true);
    // argv 不一致 + transcript 静止 → 死亡確定。
    await expect(defaultProbeSessionAlive("sid", oldTs, staleMs, fake({ error: 1 }))).resolves.toBe(false);
    // argv 不一致 + transcript が最近更新 → 不明(生存扱い)。
    await expect(defaultProbeSessionAlive("sid", freshTs, staleMs, fake({ error: 1 }))).resolves.toBe(null);
    // argv 不一致 + 活動時刻不明 → 不明(生存扱い)。
    await expect(defaultProbeSessionAlive("sid", null, staleMs, fake({ error: 1 }))).resolves.toBe(null);
    // pgrep 不能(ENOENT) → 不明(生存扱い)。
    await expect(defaultProbeSessionAlive("sid", oldTs, staleMs, fake({ error: "ENOENT" }))).resolves.toBe(null);
  });
});
