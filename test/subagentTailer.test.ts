// subagentTailer.test.ts — サブエージェント進捗ツリー tail テスト

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import { SubagentTailer } from "../src/chat/subagentTailer.js";
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
    const tailer = new SubagentTailer({ pollIntervalMs: 10 });
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
    const tailer = new SubagentTailer({ pollIntervalMs: 10 });
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
    const tailer = new SubagentTailer({ pollIntervalMs: 10, probeOutputOpen: () => Promise.resolve(true) });
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
    const tailer = new SubagentTailer({
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
    const tailer = new SubagentTailer({
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
    const tailer = new SubagentTailer({
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
    const tailer = new SubagentTailer({
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
    const tailer = new SubagentTailer({ pollIntervalMs: 10 });
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
