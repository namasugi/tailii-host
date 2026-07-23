// codexToolActivity.test.ts — codex tool_activity 写像（live/rollout 両系統）のテスト。
// フィクスチャは 2026-07-23 に codex-cli 0.145 の実セッション（App Server プローブ +
// 同一セッションの rollout）から採取した実形式に基づく。

import { describe, expect, test } from "vitest";
import {
  codexCommandActivity,
  codexFileChangeActivities,
  codexItemToolActivities,
  codexPlanActivity,
  codexPlanUpdateActivity,
  containsApplyPatch,
  extractExecCommands,
  normalizeShellCommand,
  rolloutPatchApplyActivities,
  rolloutResponseItemToolActivities,
  toolActivityContentKey,
} from "../src/codexToolActivity.js";

describe("normalizeShellCommand", () => {
  test("unifiedExecStartup の shell ラッパーを剥がす", () => {
    expect(normalizeShellCommand("/bin/zsh -lc 'echo tailii-probe && ls'"))
      .toBe("echo tailii-probe && ls");
    expect(normalizeShellCommand("bash -lc 'npm test'")).toBe("npm test");
  });

  test("ラッパー内のシングルクォートエスケープを復元する", () => {
    expect(normalizeShellCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
  });

  test("ラッパーなしのコマンドはそのまま", () => {
    expect(normalizeShellCommand("npm run build")).toBe("npm run build");
  });
});

describe("extractExecCommands", () => {
  test("JSON 形式の引数から cmd を抽出する（実採取形式）", () => {
    const input = 'const r = await tools.exec_command({"cmd":"echo tailii-probe && ls",' +
      '"workdir":"/tmp/work","yield_time_ms":10000,"max_output_tokens":2000});\ntext(r);\n';
    expect(extractExecCommands(input)).toEqual(["echo tailii-probe && ls"]);
  });

  test("クォートなしキー（JS オブジェクトリテラル）も抽出する", () => {
    const input = 'const r = await tools.exec_command({\n  cmd: "cat README.md",\n  workdir: "/tmp",\n});';
    expect(extractExecCommands(input)).toEqual(["cat README.md"]);
  });

  test("複数呼び出しは順に列挙する", () => {
    const input = 'await tools.exec_command({"cmd":"ls"}); await tools.exec_command({"cmd":"pwd"});';
    expect(extractExecCommands(input)).toEqual(["ls", "pwd"]);
  });

  test("cmd が文字列リテラルでない呼び出しは読み飛ばす", () => {
    expect(extractExecCommands("await tools.exec_command({cmd: variable});")).toEqual([]);
  });

  test("cmd 非リテラルの呼び出しが後続呼び出しの cmd を横取りしない", () => {
    const input = 'await tools.exec_command({cmd: variable}); await tools.exec_command({"cmd":"pwd"});';
    expect(extractExecCommands(input)).toEqual(["pwd"]);
  });
});

describe("rolloutResponseItemToolActivities", () => {
  test("custom_tool_call exec はコマンドカードにする", () => {
    const activities = rolloutResponseItemToolActivities({
      type: "custom_tool_call",
      id: "ctc_1",
      status: "completed",
      call_id: "call_j09",
      name: "exec",
      input: 'const r = await tools.exec_command({"cmd":"echo tailii-probe && ls","workdir":"/w"});\ntext(r);\n',
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "call_j09",
      name: "Bash",
      label: "実行済み echo tailii-probe && ls",
      command: "echo tailii-probe && ls",
    });
  });

  test("apply_patch を含む exec はカードを作らない（patch_apply_end 側で表示）", () => {
    const input = 'const patch = "*** Begin Patch\\n*** Add File: probe.txt\\n+alpha\\n*** End Patch";\n' +
      "text(await tools.apply_patch(patch));\n";
    expect(containsApplyPatch(input)).toBe(true);
    expect(rolloutResponseItemToolActivities({
      type: "custom_tool_call", call_id: "call_58", name: "exec", input,
    })).toEqual([]);
  });

  test("cmd 抽出も apply_patch もない JS はスクリプト全文のコマンドカードにする", () => {
    const input = "const files = await tools.read_dir('/tmp');\ntext(files);";
    const activities = rolloutResponseItemToolActivities({
      type: "custom_tool_call", call_id: "call_x", name: "exec", input,
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]?.command).toBe(input);
  });

  test("function_call exec_command（旧ハーネス）は arguments JSON の cmd を使う", () => {
    const activities = rolloutResponseItemToolActivities({
      type: "function_call",
      name: "exec_command",
      call_id: "call_kv",
      arguments: '{"cmd": "sed -n \'1,10p\' SKILL.md", "yield_time_ms": 10000}',
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ id: "call_kv", command: "sed -n '1,10p' SKILL.md" });
  });

  test("function_call update_plan はプランカードにする", () => {
    const activities = rolloutResponseItemToolActivities({
      type: "function_call",
      name: "update_plan",
      call_id: "call_plan",
      arguments: JSON.stringify({
        explanation: "…",
        plan: [
          { step: "フックを直す", status: "in_progress" },
          { step: "テスト追加", status: "pending" },
        ],
      }),
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "call_plan",
      name: "TodoWrite",
      label: "プランを更新しました",
      todos: [
        { content: "フックを直す", status: "in_progress" },
        { content: "テスト追加", status: "pending" },
      ],
    });
  });

  test("wait など対象外の function_call は無視する", () => {
    expect(rolloutResponseItemToolActivities({
      type: "function_call", name: "wait", call_id: "call_w", arguments: "{}",
    })).toEqual([]);
  });
});

describe("rolloutPatchApplyActivities", () => {
  test("add は作成カード（content を新規テキストとして持つ）", () => {
    const activities = rolloutPatchApplyActivities({
      type: "patch_apply_end",
      call_id: "exec-3c81",
      success: true,
      changes: { "/w/probe.txt": { type: "add", content: "alpha\nbeta\ngamma\n" } },
      status: "completed",
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "exec-3c81",
      name: "Write",
      label: "作成済み probe.txt",
      file: "/w/probe.txt",
      addedLines: 3,
      removedLines: 0,
    });
    expect(activities[0]?.diff?.newString).toBe("alpha\nbeta\ngamma\n");
  });

  test("update は編集カード（unified diff を old/new へ分解）", () => {
    const activities = rolloutPatchApplyActivities({
      type: "patch_apply_end",
      call_id: "exec-ff61",
      success: true,
      changes: {
        "/w/probe.txt": {
          type: "update",
          unified_diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
          move_path: null,
        },
      },
      status: "completed",
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "exec-ff61",
      name: "Edit",
      label: "編集済み probe.txt",
      addedLines: 1,
      removedLines: 1,
    });
    expect(activities[0]?.diff?.oldString).toBe("alpha\nbeta\ngamma");
    expect(activities[0]?.diff?.newString).toBe("alpha\nBETA\ngamma");
  });

  test("`\\ No newline at end of file` マーカーは diff 本文にも行数にも数えない", () => {
    const activities = rolloutPatchApplyActivities({
      type: "patch_apply_end",
      call_id: "exec-nn",
      success: true,
      changes: {
        "/w/x.txt": {
          type: "update",
          unified_diff: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
          move_path: null,
        },
      },
      status: "completed",
    });
    expect(activities[0]).toMatchObject({ addedLines: 1, removedLines: 1 });
    expect(activities[0]?.diff?.oldString).toBe("old");
    expect(activities[0]?.diff?.newString).toBe("new");
  });

  test("適用失敗（success=false）はカードを作らない", () => {
    expect(rolloutPatchApplyActivities({
      type: "patch_apply_end", call_id: "exec-x", success: false, changes: {}, status: "failed",
    })).toEqual([]);
  });
});

describe("codexItemToolActivities（live App Server item）", () => {
  test("commandExecution completed は shell ラッパーを剥がしたコマンドカードにする", () => {
    const activities = codexItemToolActivities({
      type: "commandExecution",
      id: "exec-35c7",
      command: "/bin/zsh -lc 'echo tailii-probe && ls'",
      cwd: "/w",
      source: "unifiedExecStartup",
      status: "completed",
      aggregatedOutput: "tailii-probe\n",
      exitCode: 0,
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "exec-35c7",
      name: "Bash",
      command: "echo tailii-probe && ls",
    });
  });

  test("inProgress / declined のコマンドはカードにしない", () => {
    expect(codexItemToolActivities({
      type: "commandExecution", id: "e1", command: "ls", status: "inProgress",
    })).toEqual([]);
    expect(codexItemToolActivities({
      type: "commandExecution", id: "e2", command: "rm -rf /", status: "declined",
    })).toEqual([]);
  });

  test("fileChange completed は変更ごとのカードにする", () => {
    const activities = codexItemToolActivities({
      type: "fileChange",
      id: "exec-ff61",
      status: "completed",
      changes: [
        { path: "/w/probe.txt", kind: { type: "update", move_path: null },
          diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n" },
        { path: "/w/new.txt", kind: { type: "add" }, diff: "one\ntwo\n" },
      ],
    });
    expect(activities.map((a) => [a.id, a.name, a.label])).toEqual([
      ["exec-ff61", "Edit", "編集済み probe.txt"],
      ["exec-ff61#1", "Write", "作成済み new.txt"],
    ]);
  });

  test("fileChange inProgress はカードにしない", () => {
    expect(codexItemToolActivities({
      type: "fileChange", id: "f1", status: "inProgress", changes: [],
    })).toEqual([]);
  });
});

describe("content key の live / rollout 対称性", () => {
  test("コマンド実行: live item と rollout custom_tool_call が同じキーになる", () => {
    const live = codexItemToolActivities({
      type: "commandExecution",
      id: "exec-35c7",
      command: "/bin/zsh -lc 'echo tailii-probe && ls'",
      status: "completed",
    })[0]!;
    const rollout = rolloutResponseItemToolActivities({
      type: "custom_tool_call",
      call_id: "call_j09",
      name: "exec",
      input: 'const r = await tools.exec_command({"cmd":"echo tailii-probe && ls","workdir":"/w"});\ntext(r);\n',
    })[0]!;
    expect(live.id).not.toBe(rollout.id);
    expect(toolActivityContentKey(live)).toBe(toolActivityContentKey(rollout));
  });

  test("ファイル変更: live fileChange と rollout patch_apply_end が同じキー・同じ id になる", () => {
    const live = codexItemToolActivities({
      type: "fileChange",
      id: "exec-ff61",
      status: "completed",
      changes: [{ path: "/w/probe.txt", kind: { type: "update", move_path: null },
        diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n" }],
    })[0]!;
    const rollout = rolloutPatchApplyActivities({
      type: "patch_apply_end",
      call_id: "exec-ff61",
      success: true,
      changes: { "/w/probe.txt": { type: "update",
        unified_diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n", move_path: null } },
      status: "completed",
    })[0]!;
    expect(live.id).toBe(rollout.id);
    expect(toolActivityContentKey(live)).toBe(toolActivityContentKey(rollout));
  });

  test("プラン: live（camelCase status）と rollout（snake_case）が同じキーになる", () => {
    const live = codexPlanUpdateActivity("plan:turn-1:0", {
      threadId: "t",
      turnId: "turn-1",
      plan: [
        { step: "フックを直す", status: "inProgress" },
        { step: "テスト追加", status: "pending" },
      ],
    })!;
    const rollout = rolloutResponseItemToolActivities({
      type: "function_call",
      name: "update_plan",
      call_id: "call_plan",
      arguments: JSON.stringify({
        plan: [
          { step: "フックを直す", status: "in_progress" },
          { step: "テスト追加", status: "pending" },
        ],
      }),
    })[0]!;
    expect(toolActivityContentKey(live)).toBe(toolActivityContentKey(rollout));
  });

  test("異なるコマンドはキーが衝突しない", () => {
    const a = codexCommandActivity("id-a", "ls");
    const b = codexCommandActivity("id-b", "pwd");
    expect(toolActivityContentKey(a)).not.toBe(toolActivityContentKey(b));
  });
});

describe("codexPlanActivity / codexFileChangeActivities の細部", () => {
  test("空ステップのプランは todos を持たない", () => {
    const activity = codexPlanActivity("p1", []);
    expect(activity.todos).toBeUndefined();
  });

  test("delete はファイル名だけの削除カードにする", () => {
    const activities = codexFileChangeActivities("c1", [
      { path: "/w/old.txt", kind: "delete", diff: null, movePath: null },
    ]);
    expect(activities[0]).toMatchObject({ name: "Edit", label: "削除済み old.txt", file: "/w/old.txt" });
  });
});
