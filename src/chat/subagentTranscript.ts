// subagentTranscript.ts
// サブエージェント transcript を全文表示向けの軽量な行へ変換する。

import * as fs from "node:fs";
import type { SubagentTranscriptEntry } from "../protocol.js";
import {
  rolloutPatchApplyActivities,
  rolloutResponseItemToolActivities,
} from "../codex/codexToolActivity.js";
import { isCompactSummaryRecord } from "../shared/compactSummary.js";
import { stripInjectedReminderBlocks, stripReminderTagBlocks } from "../shared/harnessReminder.js";
import { crossSessionOriginHint, crossSessionSenderLabel, presentCrossSessionMessage } from "../shared/crossSession.js";

const MAX_ENTRIES = 200;
const MAX_TOOL_TEXT = 1_000;
const MAX_TOOL_INPUT = 300;
/** サブエージェント自身の最終レポート送信（SubagentHandback ツール）を全文で載せるときの見出し。 */
const SUBAGENT_HANDBACK_REPORT_HEADING = "📨 最終レポート（親セッションへの hand-back）";

export interface SubagentTranscriptResult {
  entries: SubagentTranscriptEntry[];
  omitted: number;
}

/** 読めないファイルは空応答にする（要求元を待たせない）。 */
export function readSubagentTranscript(file: string | null): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    return parseSubagentTranscript(fs.readFileSync(file, "utf8"));
  } catch {
    return { entries: [], omitted: 0 };
  }
}

/** Codex sub-agent の rollout を全文表示向けの軽量な行へ変換する。 */
export function readCodexSubagentTranscript(file: string | null): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    return parseCodexSubagentTranscript(fs.readFileSync(file, "utf8"));
  } catch {
    return { entries: [], omitted: 0 };
  }
}

const MAX_OUTPUT_TAIL = 8_000;

/**
 * バックグラウンドコマンドの出力ファイル（プレーンテキスト）を末尾クランプで返す。
 * 先頭切り捨て時は omitted=1 で「省略あり」を明示する（行数は数えない）。
 */
export function readBackgroundOutput(file: string | null): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  let text: string;
  let ts: number | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtimeMs;
    ts = Number.isFinite(mtime) ? Math.floor(mtime) : undefined;
  } catch {
    return { entries: [], omitted: 0 };
  }
  const clamped = text.length > MAX_OUTPUT_TAIL;
  const tail = clamped ? text.slice(text.length - MAX_OUTPUT_TAIL) : text;
  if (tail.length === 0) return { entries: [], omitted: 0 };
  return {
    entries: [{
      role: "tool",
      text: tail,
      ...(ts === undefined ? {} : { ts }),
      kind: "tool_result",
    }],
    omitted: clamped ? 1 : 0,
  };
}

/**
 * fork サブエージェント（Claude Code 2.1.232〜, fork mode 既定 ON）の user 行から、harness の定型
 * 指示 `<fork-boilerplate>…</fork-boilerplate>` を外して指示本文だけを返す（TESTABLE, fork-subagent）。
 * 実測 2026-09-14 の形: boilerplate ブロック + 空行 + `Your directive: <本文>`。
 * boilerplate を含まない本文は null（通常の user 行）。
 */
export function presentForkDirective(raw: string): string | null {
  const open = raw.indexOf("<fork-boilerplate>");
  if (open < 0) return null;
  const closeTag = "</fork-boilerplate>";
  const close = raw.indexOf(closeTag, open);
  const rest = (close < 0 ? "" : raw.slice(close + closeTag.length)).trim();
  const directive = rest.replace(/^Your directive:\s*/u, "").trim();
  return directive.length > 0 ? `⑂ 分岐（fork）への指示\n\n${directive}` : "⑂ 分岐（fork）への指示";
}

export function parseSubagentTranscript(jsonl: string): SubagentTranscriptResult {
  const all: SubagentTranscriptEntry[] = [];
  // fork の transcript は親履歴を複製せず、先頭に参照レコード `fork-context-ref` を置き、その直後に
  // 親が fork を起こした Agent tool_use の写しが 1 行入る（実測 2026-09-14）。写しは fork 自身の
  // 行動ではないのでタイムラインから外す。
  let forkSpawnCopyPending = false;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record["type"] === "fork-context-ref") {
      forkSpawnCopyPending = true;
      continue;
    }
    const ts = parseTimestamp(record["timestamp"]);
    const message = object(record["message"]);
    const role = message?.["role"] ?? record["type"];
    if (role !== "user" && role !== "assistant") continue;
    // サブエージェント自身の文脈圧縮の要約（isCompactSummary の user 行）は行動ではない。
    if (isCompactSummaryRecord(record)) continue;
    const content = message?.["content"] ?? record["content"];
    if (forkSpawnCopyPending) {
      forkSpawnCopyPending = false;
      if (role === "assistant" && isAgentSpawnOnlyContent(content)) continue;
    }
    // harness 注入の <system-reminder>（user 行のリマインダ / assistant text 末尾の背景通知）は
    // 表示せず、user 行で届く通知封筒はコンパクトな 1 行に畳む。除去で空になった text は行にしない。
    const present = (raw: string): string => {
      // harness のバックグラウンドタスク通知（user 行で届く <task-notification> 封筒）は、
      // チャット面（iOS present()）と同じく生 XML を出さずコンパクトな 1 行に畳む。
      // 判定は strip 前の raw に対して封筒の形を要求する（タグに言及しただけの委任
      // プロンプトを潰さない。<system-reminder> に包まれた封筒も畳む）。
      if (role === "user" && isNotificationEnvelope(raw)) {
        const status = /<status>([^<]*)<\/status>/u.exec(raw)?.[1]?.trim() ?? "";
        return status === "" ? "⚙️ バックグラウンドタスク通知" : `⚙️ バックグラウンドタスク通知（${status}）`;
      }
      // fork の定型指示（<fork-boilerplate>）は harness の注入。指示本文だけを見せる。
      if (role === "user") {
        const directive = presentForkDirective(raw);
        if (directive !== null) return directive;
      }
      // 別セッション / 別エージェントからのメッセージ封筒（<cross-session-message> / <agent-message>）
      // は、封筒と harness の前置き/後置きを外して「⇄ 送信元名 より」+ 本文へ転写する（規則は
      // shared/crossSession.ts）。委任したサブエージェント（この会話から見た孫）の完了報告
      // （hand-back）は「⇄ サブエージェントの報告」+ レポート全文（hand-back 判定の権威は行の
      // origin.handback、無ければ本文の形）。
      if (role === "user") {
        const peer = presentCrossSessionMessage(raw, crossSessionOriginHint(record));
        if (peer !== null) {
          // ラベル本体は shared 側（hand-back は固定見出し）。ピアだけ「〜 より」を付ける。
          const label = `⇄ ${crossSessionSenderLabel(peer)}${peer.kind === "handback" ? "" : " より"}`;
          return peer.body === "" ? label : `${label}\n\n${peer.body}`;
        }
      }
      const text = role === "assistant" ? stripInjectedReminderBlocks(raw) : stripReminderTagBlocks(raw);
      // 除去した場合だけ、残った末尾の改行を落とす（触っていない本文はそのまま）。
      return text === raw ? raw : text.trimEnd();
    };
    if (typeof content === "string" && content) {
      const text = present(content);
      if (text.trim()) all.push(entry(role, text, ts));
    }
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      const block = object(rawBlock);
      if (block === null) continue;
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"]) {
        const text = present(block["text"]);
        if (text.trim()) all.push(entry(role, text, ts));
      }
      if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        // サブエージェント自身の最終レポート送信（SubagentHandback）は input.message がレポート全文。
        // 親会話面と同じ本文をここでも読めるよう、ツール入力の 300 文字スニペット（空白畳み）には
        // 潰さず、見出し付きの assistant 行として全文を載せる。
        const handback = role === "assistant" && block["name"] === "SubagentHandback"
          ? object(block["input"])?.["message"]
          : undefined;
        if (typeof handback === "string" && handback.trim()) {
          all.push(entry("assistant", `${SUBAGENT_HANDBACK_REPORT_HEADING}\n\n${handback.trim()}`, ts));
          continue;
        }
        const input = snippet(block["input"], MAX_TOOL_INPUT);
        all.push(entry(
          "tool", input ? `${block["name"]}: ${input}` : block["name"], ts, "tool_use",
        ));
      }
      if (block["type"] === "tool_result") {
        // 入れ子の Agent の最終レポートは tool_result で届く。そこにも停止境界の注入が付き得る。
        const raw = toolResultText(block["content"]);
        const stripped = stripInjectedReminderBlocks(raw);
        const result = stripped === raw ? raw : stripped.trimEnd();
        if (result.trim()) all.push(entry("tool", truncate(result, MAX_TOOL_TEXT), ts, "tool_result"));
      }
    }
  }
  const omitted = Math.max(0, all.length - MAX_ENTRIES);
  return { entries: all.slice(omitted), omitted };
}

/**
 * fork された Codex rollout には親の履歴も複製される。親→子の agent_message を境界にし、
 * それより後の子自身の発話・ツール実行だけを返す。
 */
export function parseCodexSubagentTranscript(jsonl: string): SubagentTranscriptResult {
  const records = jsonl.split(/\r?\n/).flatMap((line): Record<string, unknown>[] => {
    if (!line) return [];
    try {
      const value = JSON.parse(line) as unknown;
      return object(value) === null ? [] : [value as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const agentPath = codexAgentPath(records);
  let childHistoryStarted = false;
  const all: SubagentTranscriptEntry[] = [];

  for (const record of records) {
    const ts = parseTimestamp(record["timestamp"]);
    const recordType = record["type"];
    const payload = object(record["payload"]);
    if (payload === null) continue;

    if (recordType === "response_item" && payload["type"] === "agent_message" &&
      typeof payload["recipient"] === "string" &&
      (agentPath === null || payload["recipient"] === agentPath)) {
      childHistoryStarted = true;
      const task = interAgentPayloadText(payload["content"]);
      if (task !== null) all.push(entry("user", task, ts));
      continue;
    }
    if (!childHistoryStarted) continue;

    if (recordType === "event_msg") {
      if (payload["type"] === "agent_message" && typeof payload["message"] === "string" &&
        payload["message"].length > 0) {
        all.push(entry("assistant", payload["message"], ts));
      }
      for (const activity of rolloutPatchApplyActivities(payload)) {
        all.push(entry("tool", transcriptToolText(activity), ts, "tool_use"));
      }
      continue;
    }
    if (recordType !== "response_item") continue;

    const activities = rolloutResponseItemToolActivities(payload);
    for (const activity of activities) {
      all.push(entry("tool", transcriptToolText(activity), ts, "tool_use"));
    }
    if (activities.length === 0) {
      const genericTool = genericCodexToolText(payload);
      if (genericTool !== null) all.push(entry("tool", genericTool, ts, "tool_use"));
    }
    if (payload["type"] === "custom_tool_call_output" ||
      payload["type"] === "function_call_output") {
      const output = toolResultText(payload["output"]);
      if (output.length > 0) {
        all.push(entry("tool", truncate(output, MAX_TOOL_TEXT), ts, "tool_result"));
      }
    }
  }

  const omitted = Math.max(0, all.length - MAX_ENTRIES);
  return { entries: all.slice(omitted), omitted };
}

function codexAgentPath(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (record["type"] !== "session_meta") continue;
    const payload = object(record["payload"]);
    const source = object(payload?.["source"]);
    const subagent = object(source?.["subagent"] ?? source?.["subAgent"]);
    const spawn = object(subagent?.["thread_spawn"]);
    const path = spawn?.["agent_path"] ?? payload?.["agent_path"];
    if (typeof path === "string" && path.length > 0) return path;
  }
  return null;
}

function interAgentPayloadText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value.flatMap((raw): string[] => {
    const block = object(raw);
    return block?.["type"] === "input_text" && typeof block["text"] === "string"
      ? [block["text"]] : [];
  }).join("\n");
  const marker = "Payload:\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const payload = text.slice(markerIndex + marker.length).trim();
  return payload.length > 0 ? payload : null;
}

function transcriptToolText(activity: {
  name: string;
  label: string;
  command?: string;
  file?: string;
}): string {
  if (activity.command !== undefined) return `${activity.name}: ${activity.command}`;
  if (activity.file !== undefined) return `${activity.name}: ${activity.file}`;
  return activity.label;
}

function genericCodexToolText(payload: Record<string, unknown>): string | null {
  const kind = payload["type"];
  const name = payload["name"];
  if ((kind !== "custom_tool_call" && kind !== "function_call") ||
    typeof name !== "string" || name.length === 0) return null;
  // exec/apply_patch は専用カードまたは後続 patch_apply_end が詳細を表す。
  if (name === "exec" || name === "exec_command" || name === "update_plan" ||
    name === "apply_patch") return null;
  // collaboration payload は暗号化された長文を含む。会話履歴では操作名だけで十分。
  if (CODEX_COLLABORATION_TOOLS.has(name)) return name;
  const input = snippet(
    kind === "custom_tool_call" ? payload["input"] : payload["arguments"],
    MAX_TOOL_INPUT,
  );
  return input.length === 0 ? name : `${name}: ${input}`;
}

const CODEX_COLLABORATION_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
]);

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * harness のバックグラウンドタスク通知封筒か。`[SYSTEM NOTIFICATION` 前置、または
 * 「raw 先頭（<system-reminder> 包みは 1 枚めくった先頭）が `<task-notification>` 行 +
 * 閉じた `<task-id>`」を要求する（実測の封筒は全て先頭一致）。本文中でタグに言及した
 * だけの委任プロンプトや、封筒を丸ごと貼り込んだプロンプト（途中に現れる）には一致しない。
 */
function isNotificationEnvelope(raw: string): boolean {
  if (raw.startsWith("[SYSTEM NOTIFICATION")) return true;
  const head = raw.startsWith("<system-reminder>\n") ? raw.slice("<system-reminder>\n".length) : raw;
  return /^<task-notification>\r?\n/u.test(head) && /<task-id>[^<\n]+<\/task-id>/u.test(raw);
}

function entry(
  role: SubagentTranscriptEntry["role"],
  text: string,
  ts: number | undefined,
  kind?: SubagentTranscriptEntry["kind"],
): SubagentTranscriptEntry {
  return {
    role,
    text,
    ...(ts === undefined ? {} : { ts }),
    ...(kind === undefined ? {} : { kind }),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return snippet(value, MAX_TOOL_TEXT);
  return value.map((item) => {
    const block = object(item);
    return block !== null && typeof block["text"] === "string" ? block["text"] : "";
  }).filter(Boolean).join("\n");
}

function snippet(value: unknown, cap: number): string {
  if (value === undefined || value === null) return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return truncate(raw.replace(/\s+/g, " ").trim(), cap);
}

function truncate(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}…`;
}

/** content が「Agent ツール呼び出しのみ」か（fork 先頭の spawn 写し判定）。 */
function isAgentSpawnOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => {
    const rec = object(block);
    return rec !== null && rec["type"] === "tool_use" && rec["name"] === "Agent";
  });
}
