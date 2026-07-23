// codexToolActivity.ts
// tailii (TS host) — codex のコマンド実行 / ファイル変更 / プラン更新を tool_activity へ写像する。
//
// 生成元は 2 系統あり、同一イベントが両方に現れる:
//   - live: App Server の item/completed（commandExecution / fileChange）と turn/plan/updated
//   - rollout: response_item（custom_tool_call "exec" / function_call "exec_command" /
//     "update_plan"）と event_msg patch_apply_end
// SessionHub は chatContentKey の occurrence count で live / rollout を照合するため、
// 両系統が「同じイベントから同じ ToolActivity（同じ content key）」を作ることが要件。
// このモジュールに builder を集約し、正規化（shell ラッパー剥がし・status の snake_case 化）を
// 両系統で共有する。id は系統間で一致しない（live: exec-uuid / rollout: call_id）ため
// content key には含めない。
//
// 実形式の正本（2026-07-23, codex-cli 0.145 で採取）:
//   - live commandExecution.command = `/bin/zsh -lc '<cmd>'`（unifiedExecStartup ラップ）
//   - rollout custom_tool_call "exec" の input = JS で `tools.exec_command({"cmd":"<cmd>",…})`
//   - fileChange は live item.id == rollout patch_apply_end.call_id、diff 文字列も一致
//     （add は生 content / update は unified diff hunk）
//   - plan status は live "inProgress"（camel）/ rollout "in_progress"（snake）

import * as path from "node:path";
import {
  PROTOCOL_V1,
  type ControlMessage,
  type ToolActivity,
  type ToolActivityDiff,
  type ToolActivityTodo,
} from "./protocol.js";

// transcriptTailer（claude 側）と同じキャップ値。iOS 表示の前提を揃える。
const MAX_COMMAND_CHARACTERS = 8_000;
const MAX_DIFF_FIELD_CHARACTERS = 24_000;
const MAX_TODO_ITEMS = 50;
const MAX_TODO_CONTENT_CHARACTERS = 300;

/** codex の変更 1 件の正規化表現（live changes[] / rollout patch_apply_end changes の共通形）。 */
export interface CodexFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  /** add は生 content、update は unified diff hunk。delete は null のことがある。 */
  diff: string | null;
  movePath: string | null;
}

/** codex プラン（update_plan / turn/plan/updated）の 1 ステップ。 */
export interface CodexPlanStep {
  step: string;
  status: string;
}

/** tool_activity 封筒を作る（hub の publish 経路へそのまま流せる形）。 */
export function toolActivityMessage(activity: ToolActivity): ControlMessage {
  return { type: "tool_activity", v: PROTOCOL_V1, activity };
}

// MARK: - builder（live / rollout 共通）

/** コマンド実行カード。rawCommand は shell ラッパーを剥がしてから渡す必要はない（内部で正規化）。 */
export function codexCommandActivity(id: string, rawCommand: string): ToolActivity {
  const command = normalizeShellCommand(rawCommand);
  const commandCap = cap(command, MAX_COMMAND_CHARACTERS);
  const activity: ToolActivity = {
    id,
    name: "Bash",
    label: `実行済み ${commandPrefix(commandCap.value ?? "")}`,
    commandTruncated: commandCap.truncated,
    descriptionTruncated: false,
  };
  if (commandCap.value !== null && commandCap.value.length > 0) activity.command = commandCap.value;
  return activity;
}

/**
 * ファイル変更カード（changes 1 件 = 1 カード）。id は先頭変更が `idBase`、以降 `idBase#n`。
 * live の fileChange item と rollout の patch_apply_end は同じ changes 並びを持つため、
 * この規則で id も系統間で一致する。
 */
export function codexFileChangeActivities(idBase: string, changes: CodexFileChange[]): ToolActivity[] {
  return changes.map((change, index) => {
    const id = index === 0 ? idBase : `${idBase}#${index}`;
    const base = path.basename(change.path);
    const display = base.length === 0 ? change.path : base;
    if (change.kind === "add") {
      const newCap = cap(change.diff, MAX_DIFF_FIELD_CHARACTERS);
      const diff: ToolActivityDiff = { oldStringTruncated: false, newStringTruncated: newCap.truncated };
      if (newCap.value !== null) diff.newString = newCap.value;
      return {
        id,
        name: "Write",
        label: `作成済み ${display}`,
        file: change.path,
        addedLines: countLines(change.diff),
        removedLines: 0,
        diff,
        commandTruncated: false,
        descriptionTruncated: false,
      };
    }
    if (change.kind === "delete") {
      return {
        id,
        name: "Edit",
        label: `削除済み ${display}`,
        file: change.path,
        commandTruncated: false,
        descriptionTruncated: false,
      };
    }
    const split = splitUnifiedDiff(change.diff ?? "");
    const oldCap = cap(split.oldText, MAX_DIFF_FIELD_CHARACTERS);
    const newCap = cap(split.newText, MAX_DIFF_FIELD_CHARACTERS);
    const diff: ToolActivityDiff = {
      oldStringTruncated: oldCap.truncated,
      newStringTruncated: newCap.truncated,
    };
    if (oldCap.value !== null) diff.oldString = oldCap.value;
    if (newCap.value !== null) diff.newString = newCap.value;
    const activity: ToolActivity = {
      id,
      name: "Edit",
      label: `編集済み ${display}`,
      file: change.path,
      addedLines: split.added,
      removedLines: split.removed,
      diff,
      commandTruncated: false,
      descriptionTruncated: false,
    };
    return activity;
  });
}

/** プラン更新カード（Claude の TodoWrite と同じ表示系へ載せる）。 */
export function codexPlanActivity(id: string, steps: CodexPlanStep[]): ToolActivity {
  const todos: ToolActivityTodo[] = steps.slice(0, MAX_TODO_ITEMS).flatMap((item) => {
    const content = item.step.trim();
    if (content.length === 0) return [];
    return [{
      content: cap(content, MAX_TODO_CONTENT_CHARACTERS).value ?? content,
      status: normalizePlanStatus(item.status),
    }];
  });
  const activity: ToolActivity = {
    id,
    name: "TodoWrite",
    label: "プランを更新しました",
    commandTruncated: false,
    descriptionTruncated: false,
  };
  if (todos.length > 0) activity.todos = todos;
  return activity;
}

/**
 * live / rollout 照合用の content key。id は系統間で一致しないため含めない。
 * diff 本文は add（content）/ update（unified diff）とも系統間で一致するが、キーは
 * 行数サマリで代表させて、キャップ切り詰めの影響を受けないようにする。
 */
export function toolActivityContentKey(activity: ToolActivity): string {
  const todos = (activity.todos ?? []).map((todo) => `${todo.content}=${todo.status}`).join("");
  return [
    "tool",
    activity.name,
    activity.label,
    activity.command ?? "",
    activity.file ?? "",
    String(activity.addedLines ?? ""),
    String(activity.removedLines ?? ""),
    todos,
  ].join("\u0000");
}

// MARK: - live（App Server item）→ ToolActivity

/**
 * item/completed の item から tool_activity 群を作る。
 * commandExecution: declined（承認拒否で未実行）以外を表示する。
 * fileChange: 適用済み（completed）のみ。rollout 側の patch_apply_end(success) と対になる。
 */
export function codexItemToolActivities(item: Record<string, unknown>): ToolActivity[] {
  const id = item["id"];
  const type = item["type"];
  if (typeof id !== "string" || id.length === 0) return [];
  if (type === "commandExecution") {
    const command = item["command"];
    const status = item["status"];
    if (typeof command !== "string" || command.length === 0) return [];
    if (status !== "completed" && status !== "failed") return [];
    return [codexCommandActivity(id, command)];
  }
  if (type === "fileChange") {
    if (item["status"] !== "completed") return [];
    const changes = parseLiveFileChanges(item["changes"]);
    return codexFileChangeActivities(id, changes);
  }
  return [];
}

function parseLiveFileChanges(value: unknown): CodexFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const changePath = record?.["path"];
    if (typeof changePath !== "string" || changePath.length === 0) return [];
    const kindRecord = asRecord(record?.["kind"]);
    const kindType = kindRecord?.["type"];
    const kind = kindType === "add" || kindType === "delete" ? kindType : "update";
    const diff = typeof record?.["diff"] === "string" ? (record["diff"] as string) : null;
    const movePath = typeof kindRecord?.["move_path"] === "string" ? (kindRecord["move_path"] as string) : null;
    return [{ path: changePath, kind, diff, movePath }];
  });
}

/** turn/plan/updated の params からプランカードを作る（plan が空なら null）。 */
export function codexPlanUpdateActivity(id: string, params: Record<string, unknown>): ToolActivity | null {
  const steps = parsePlanSteps(params["plan"]);
  if (steps.length === 0) return null;
  return codexPlanActivity(id, steps);
}

// MARK: - rollout（response_item / event_msg）→ ToolActivity

/**
 * rollout の response_item payload から tool_activity 群を作る。
 * - custom_tool_call "exec": JS 入力から `tools.exec_command({cmd})` を抽出（複数可）。
 *   `tools.apply_patch` は patch_apply_end 側で表示するためここでは作らない。
 *   どちらも抽出できない JS は「スクリプト実行」1 カードにする（live 側とキーが一致しない
 *   可能性を許容 — 再接続の再走査でだけ重複しうる既知の限界）。
 * - function_call "exec_command": arguments JSON の cmd を使う（旧ハーネス互換）。
 * - function_call "update_plan": arguments JSON の plan をプランカードへ。
 */
export function rolloutResponseItemToolActivities(payload: Record<string, unknown>): ToolActivity[] {
  const kind = payload["type"];
  const name = payload["name"];
  const idBase = firstString(payload["call_id"], payload["id"]) ?? null;
  if (idBase === null) return [];
  if (kind === "custom_tool_call" && name === "exec") {
    const input = payload["input"];
    if (typeof input !== "string" || input.length === 0) return [];
    const commands = extractExecCommands(input);
    if (commands.length > 0) {
      return commands.map((command, index) =>
        codexCommandActivity(index === 0 ? idBase : `${idBase}#${index}`, command));
    }
    if (containsApplyPatch(input)) return [];
    return [codexCommandActivity(idBase, input)];
  }
  if (kind === "function_call" && name === "exec_command") {
    const args = parseJsonRecord(payload["arguments"]);
    const cmd = args?.["cmd"];
    if (typeof cmd !== "string" || cmd.length === 0) return [];
    return [codexCommandActivity(idBase, cmd)];
  }
  if (kind === "function_call" && name === "update_plan") {
    const args = parseJsonRecord(payload["arguments"]);
    const steps = parsePlanSteps(args?.["plan"]);
    if (steps.length === 0) return [];
    return [codexPlanActivity(idBase, steps)];
  }
  return [];
}

/**
 * rollout の event_msg patch_apply_end からファイル変更カードを作る。
 * changes はパス→種別のマップで、live の fileChange item と同一の並び・内容を持つ。
 * success=false（適用失敗）は live 側も completed にならないため作らない。
 */
export function rolloutPatchApplyActivities(payload: Record<string, unknown>): ToolActivity[] {
  if (payload["success"] !== true) return [];
  const callId = firstString(payload["call_id"]);
  const changesRecord = asRecord(payload["changes"]);
  if (callId === null || changesRecord === null) return [];
  const changes: CodexFileChange[] = [];
  for (const [changePath, rawChange] of Object.entries(changesRecord)) {
    const change = asRecord(rawChange);
    if (change === null) continue;
    const kindType = change["type"];
    const kind = kindType === "add" || kindType === "delete" ? kindType : "update";
    const diff =
      typeof change["unified_diff"] === "string"
        ? (change["unified_diff"] as string)
        : typeof change["content"] === "string"
          ? (change["content"] as string)
          : null;
    const movePath = typeof change["move_path"] === "string" ? (change["move_path"] as string) : null;
    changes.push({ path: changePath, kind, diff, movePath });
  }
  return codexFileChangeActivities(callId, changes);
}

// MARK: - 正規化ヘルパ

/**
 * unifiedExecStartup の shell ラッパー（`/bin/zsh -lc '<cmd>'` 等）を剥がす。
 * rollout 側は生コマンドのまま記録されるため、両系統をこの関数で同じ文字列に揃える。
 */
export function normalizeShellCommand(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+'([\s\S]*)'$/.exec(trimmed);
  const inner = match?.[1];
  if (inner === undefined) return trimmed;
  return inner.replaceAll("'\\''", "'");
}

/**
 * unified exec の JS 入力から `tools.exec_command({...cmd...})` のコマンド文字列を列挙する。
 * 入力はモデル生成の JS なのでキーはクォート有無どちらもあり得る。cmd の値が
 * 文字列リテラル（JSON 互換のダブルクォート）で書かれている呼び出しだけを抽出する。
 */
export function extractExecCommands(input: string): string[] {
  // 呼び出しごとに探索区間を「次の exec_command 呼び出しの手前」までに区切る。
  // 区切らないと cmd が文字列リテラルでない呼び出しが、後続呼び出しの cmd を
  // 横取りして同じコマンドを二重に数えてしまう。
  const callPattern = /tools\s*\.\s*exec_command\s*\(/g;
  const segmentStarts: number[] = [];
  const callStarts: number[] = [];
  let call: RegExpExecArray | null;
  while ((call = callPattern.exec(input)) !== null) {
    callStarts.push(call.index);
    segmentStarts.push(call.index + call[0].length);
  }
  const commands: string[] = [];
  segmentStarts.forEach((start, index) => {
    const end = index + 1 < callStarts.length ? callStarts[index + 1]! : input.length;
    const segment = input.slice(start, end);
    const cmdLiteral = /(?:"cmd"|'cmd'|\bcmd)\s*:\s*("(?:[^"\\]|\\[\s\S])*")/.exec(segment)?.[1];
    if (cmdLiteral === undefined) return;
    try {
      const value: unknown = JSON.parse(cmdLiteral);
      if (typeof value === "string" && value.length > 0) commands.push(value);
    } catch {
      // モデル生成 JS の破損リテラルは黙って読み飛ばす。
    }
  });
  return commands;
}

/** JS 入力が apply_patch 呼び出しを含むか（patch_apply_end 側で表示するため exec カードを抑止）。 */
export function containsApplyPatch(input: string): boolean {
  return /tools\s*\.\s*apply_patch\s*\(/.test(input);
}

/** live "inProgress"（camel）と rollout "in_progress"（snake）を Claude 互換の snake へ揃える。 */
function normalizePlanStatus(status: string): string {
  if (status === "inProgress") return "in_progress";
  return status;
}

function parsePlanSteps(value: unknown): CodexPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const step = record?.["step"];
    if (typeof step !== "string" || step.length === 0) return [];
    const status = typeof record?.["status"] === "string" ? (record["status"] as string) : "pending";
    return [{ step, status }];
  });
}

/** unified diff hunk 群を old/new テキストへ分解し、増減行数を数える。 */
function splitUnifiedDiff(diff: string): { oldText: string | null; newText: string | null; added: number; removed: number } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) continue;
    // `\ No newline at end of file` マーカー。内容行なら先頭に空白が付くため素の `\` は
    // マーカーだけで、old/new どちらのテキストにも数えない。
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      added += 1;
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      removed += 1;
    } else {
      const body = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(body);
      newLines.push(body);
    }
  }
  // 末尾の空行（diff 終端の改行由来）は表示ノイズなので落とす。
  while (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") oldLines.pop();
  while (newLines.length > 0 && newLines[newLines.length - 1] === "") newLines.pop();
  return {
    oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
    newText: newLines.length > 0 ? newLines.join("\n") : null,
    added,
    removed,
  };
}

function countLines(text: string | null): number {
  if (text === null || text.length === 0) return 0;
  const withoutTrailing = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (withoutTrailing.length === 0) return 0;
  return withoutTrailing.split("\n").length;
}

function commandPrefix(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "コマンド";
  return trimmed.length > 80 ? trimmed.slice(0, 80) + "..." : trimmed;
}

function cap(text: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (text === null) return { value: null, truncated: false };
  if (text.length <= limit) return { value: text, truncated: false };
  return { value: text.slice(0, limit), truncated: true };
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
