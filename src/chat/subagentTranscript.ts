// subagentTranscript.ts
// サブエージェント transcript を全文表示向けの軽量な行へ変換する。

import * as fs from "node:fs";
import type { SubagentTranscriptEntry } from "../protocol.js";
import {
  rolloutPatchApplyActivities,
  rolloutResponseItemToolActivities,
} from "../codex/codexToolActivity.js";
import { isVisibleCodexMessagePhase } from "../codex/codexMessagePhase.js";
import { isCompressedRollout, readCompressedRollout } from "../codex/rolloutFile.js";
import { userMessageItemText } from "./codexExecLinker.js";
import { isCompactSummaryRecord } from "../shared/compactSummary.js";
import { isNonMessageRecordType } from "../shared/transcriptRecord.js";
import { narrationText } from "../shared/narration.js";
import { stripInjectedReminderBlocks, stripReminderTagBlocks } from "../shared/harnessReminder.js";
import { crossSessionOriginHint, crossSessionSenderLabel, presentCrossSessionMessage } from "../shared/crossSession.js";

const MAX_ENTRIES = 200;

/**
 * 全件のうち `before`（通し番号, 省略時は末尾）より前の最大 MAX_ENTRIES 件を返す（agent-conversation-paging）。
 * `omitted` は返した先頭の通し番号（= それより前の件数）。transcript は追記のみなので通し番号は安定する。
 */
export function transcriptPage(all: SubagentTranscriptEntry[], before?: number): SubagentTranscriptResult {
  const end = before === undefined ? all.length : Math.max(0, Math.min(before, all.length));
  const start = Math.max(0, end - MAX_ENTRIES);
  return { entries: all.slice(start, end), omitted: start };
}
const MAX_TOOL_TEXT = 1_000;
const MAX_TOOL_INPUT = 300;
/** サブエージェント自身の最終レポート送信（SubagentHandback ツール）を全文で載せるときの見出し。 */
const SUBAGENT_HANDBACK_REPORT_HEADING = "📨 最終レポート（親セッションへの hand-back）";

export interface SubagentTranscriptResult {
  entries: SubagentTranscriptEntry[];
  omitted: number;
}

/** 読めないファイルは空応答にする（要求元を待たせない）。 */
export function readSubagentTranscript(file: string | null, before?: number): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    return parseSubagentTranscript(fs.readFileSync(file, "utf8"), before);
  } catch {
    return { entries: [], omitted: 0 };
  }
}

/** Codex sub-agent の rollout を全文表示向けの軽量な行へ変換する。 */
export function readCodexSubagentTranscript(file: string | null, before?: number): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    return parseCodexSubagentTranscript(fs.readFileSync(file, "utf8"), before);
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
  // 切り出しの先頭がサロゲートペアの後半なら 1 つ後ろから（孤立サロゲートで iOS が応答ごと復号に失敗しないように）。
  let start = clamped ? text.length - MAX_OUTPUT_TAIL : 0;
  if (start > 0) {
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  }
  const tail = text.slice(start);
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

export function parseSubagentTranscript(jsonl: string, before?: number): SubagentTranscriptResult {
  const all: SubagentTranscriptEntry[] = [];
  // fork の transcript は親履歴を複製せず、先頭に参照レコード `fork-context-ref` を置き、その直後に
  // 親が fork を起こした Agent tool_use の写しが 1 行入る（実測 2026-09-14）。写しは fork 自身の
  // 行動ではないのでタイムラインから外す。
  let forkSpawnCopyPending = false;
  // 落とした spawn 写しの tool_use id。直後の結果の写し（「Fork started — that fork is you.」/ 旧形の空）も落とす。
  const forkSpawnCopyIds = new Set<string>();
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
    // 2.1.300+ の `api-request-blob`（role 付きの複製行）は行動ではない（二重表示になる）。
    if (isNonMessageRecordType(record["type"])) continue;
    const role = message?.["role"] ?? record["type"];
    if (role !== "user" && role !== "assistant") continue;
    // サブエージェント自身の文脈圧縮の要約（isCompactSummary の user 行）は行動ではない。
    if (isCompactSummaryRecord(record)) continue;
    const content = message?.["content"] ?? record["content"];
    if (forkSpawnCopyPending) {
      forkSpawnCopyPending = false;
      if (role === "assistant" && isAgentSpawnOnlyContent(content)) {
        for (const block of content as unknown[]) {
          const id = object(block)?.["id"];
          if (typeof id === "string") forkSpawnCopyIds.add(id);
        }
        continue;
      }
    }
    // harness 注入の <system-reminder>（user 行のリマインダ / assistant text 末尾の背景通知）は
    // 表示せず、user 行で届く通知封筒はコンパクトな 1 行に畳む。除去で空になった text は行にしない。
    const present = (raw: string): string => {
      // harness のバックグラウンドタスク通知（user 行で届く <task-notification> 封筒）は、
      // チャット面（iOS present()）と同じく生 XML を出さずコンパクトな 1 行に畳む。
      // 判定は strip 前の raw に対して封筒の形を要求する（タグに言及しただけの委任
      // プロンプトを潰さない。<system-reminder> に包まれた封筒も畳む）。
      // CLI と同じく <summary>（何が終わったか）を出し、無ければ状態だけの 1 行。
      if (role === "user" && isNotificationEnvelope(raw)) {
        const summary = taskNotificationSummary(raw);
        if (summary !== null) return `⚙️ ${summary}`;
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
      // origin.handback、無ければ本文の形）。別セッションの待機通知は「⇄ 名前 が待機状態になりました」。
      if (role === "user") {
        const peer = presentCrossSessionMessage(raw, crossSessionOriginHint(record));
        if (peer !== null) {
          // ラベル本体は shared 側（hand-back / 待機通知は固定見出し）。ピアだけ「〜 より」を付ける。
          const label = `⇄ ${crossSessionSenderLabel(peer)}${peer.kind === "peer" ? " より" : ""}`;
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
      // thinking ブロックとして記録された途中経過の発話（narration）。CLI は text と同じく発話として出す。
      const narration = role === "assistant" ? narrationText(block) : null;
      if (narration !== null) {
        const text = present(narration);
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
      if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string"
        && forkSpawnCopyIds.has(block["tool_use_id"])) {
        continue;
      }
      if (block["type"] === "tool_result") {
        // 入れ子の Agent の最終レポートは tool_result で届く。そこにも停止境界の注入が付き得る。
        const raw = toolResultText(block["content"]);
        const stripped = stripInjectedReminderBlocks(raw);
        const result = stripped === raw ? raw : stripped.trimEnd();
        // テキストの無い結果（画像を読んだ・ツール定義を読み込んだ等）も 1 行にする。省くと、iOS の会話画面が
        // 結果を呼び出し順に付けるときに 1 つずつずれる（agent-conversation）。
        const text = result.trim() ? truncate(result, MAX_TOOL_TEXT) : emptyToolResultLabel(block["content"]);
        all.push(entry("tool", text, ts, "tool_result"));
      }
    }
  }
  return transcriptPage(all, before);
}

/**
 * fork された Codex rollout には親の履歴も複製される。親→子の agent_message を境界にし、
 * それより後の子自身の発話・ツール実行だけを返す。
 *
 * 子の発話は `response_item/message`（assistant）から読む。現行 Codex（0.16x）は子の rollout に
 * `event_msg/agent_message` を書かない。旧形式は event_msg の直後に同じ本文の response_item が続くので、
 * その写しだけを重ねない（同じ本文の発言が続く正当なケースは潰さない）。
 * 親や他のエージェントから届く依頼は本文が暗号化されている（`encrypted_content`）。読めないときは
 * 依頼の区切りだけを出す（同じ子に続けて別の依頼が来るので、どこからが次の依頼か分かるように）。
 */
export function parseCodexSubagentTranscript(jsonl: string, before?: number): SubagentTranscriptResult {
  const records = parseJsonlRecords(jsonl);
  const parser = new CodexRolloutEntryParser("subagent", codexAgentPath(records));
  for (const record of records) parser.consume(record);
  return transcriptPage(parser.entries, before);
}

/**
 * Claude の Bash から `codex exec` で起動した Codex の記録（`source: exec`）を全文表示向けの行へ変換する
 * （codex-exec-delegation）。最初の素の利用者発話（`event_msg/item_completed` の UserMessage、旧形式は
 * `event_msg/user_message`）から読み始め、それを利用者側の行として出す。返事とツールの読み方は sub-agent と同じ。
 */
export function parseCodexExecTranscript(jsonl: string, before?: number): SubagentTranscriptResult {
  const parser = new CodexRolloutEntryParser("exec", null);
  for (const record of parseJsonlRecords(jsonl)) parser.consume(record);
  return transcriptPage(parser.entries, before);
}

/** 解析結果の覚え（パスごと。サイズ・更新時刻が同じなら読み直さず、伸びただけなら追記分だけ読む）。 */
interface ExecTranscriptCacheEntry {
  size: number;
  mtimeMs: number;
  position: number;
  partial: Buffer;
  parser: CodexRolloutEntryParser;
}
const EXEC_TRANSCRIPT_CACHE_LIMIT = 8;
const EXEC_COMPRESSED_LIMIT_BYTES = 64 * 1024 * 1024;
const execTranscriptCache = new Map<string, ExecTranscriptCacheEntry>();

/**
 * `exec` の記録を読んでページを返す。画像生成を含む記録は数 MB になり、engine → hub の問い合わせは 1.5 秒で
 * 切れるので、解析結果を「パス・サイズ・更新時刻」で覚え、ページ送りのたびに読み直さない（実行中は追記分だけ読む）。
 */
export function readCodexExecTranscript(file: string | null, before?: number): SubagentTranscriptResult {
  if (file === null) return { entries: [], omitted: 0 };
  try {
    const stat = fs.statSync(file);
    let cached = execTranscriptCache.get(file);
    if (cached !== undefined && (cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs)) {
      // 縮んだ・圧縮済み（書き換えはしない）なら作り直す。伸びただけなら続きから読む。
      if (stat.size < cached.position || isCompressedRollout(file)) cached = undefined;
    }
    if (cached === undefined) {
      cached = { size: -1, mtimeMs: -1, position: 0, partial: Buffer.alloc(0), parser: new CodexRolloutEntryParser("exec", null) };
    }
    if (cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      if (isCompressedRollout(file)) {
        const data = readCompressedRollout(file, EXEC_COMPRESSED_LIMIT_BYTES);
        if (data === null) return { entries: [], omitted: 0 };
        consumeExecChunk(cached, data, true);
      } else {
        const fd = fs.openSync(file, "r");
        try {
          const chunk = Buffer.alloc(1024 * 1024);
          for (;;) {
            const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, cached.position);
            if (bytesRead === 0) break;
            cached.position += bytesRead;
            consumeExecChunk(cached, chunk.subarray(0, bytesRead), false);
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      cached.size = stat.size;
      cached.mtimeMs = stat.mtimeMs;
    }
    // 最近使った順に保つ（古いものから捨てる）。
    execTranscriptCache.delete(file);
    execTranscriptCache.set(file, cached);
    while (execTranscriptCache.size > EXEC_TRANSCRIPT_CACHE_LIMIT) {
      const oldest = execTranscriptCache.keys().next().value;
      if (oldest === undefined) break;
      execTranscriptCache.delete(oldest);
    }
    return transcriptPage(cached.parser.entries, before);
  } catch {
    return { entries: [], omitted: 0 };
  }
}

function consumeExecChunk(entry: ExecTranscriptCacheEntry, data: Buffer, complete: boolean): void {
  let buffer = entry.partial.length > 0 ? Buffer.concat([entry.partial, data]) : data;
  let offset = 0;
  for (;;) {
    const nl = buffer.indexOf(0x0a, offset);
    if (nl < 0) break;
    consumeExecLine(entry.parser, buffer.subarray(offset, nl));
    offset = nl + 1;
  }
  buffer = buffer.subarray(offset);
  if (complete) {
    if (buffer.length > 0) consumeExecLine(entry.parser, buffer);
    entry.partial = Buffer.alloc(0);
  } else {
    entry.partial = Buffer.from(buffer);
  }
}

function consumeExecLine(parser: CodexRolloutEntryParser, line: Buffer): void {
  if (line.length === 0) return;
  try {
    const value = JSON.parse(line.toString("utf8")) as unknown;
    const record = object(value);
    if (record !== null) parser.consume(record);
  } catch {
    // 壊れた行は飛ばす。
  }
}

function parseJsonlRecords(jsonl: string): Record<string, unknown>[] {
  return jsonl.split(/\r?\n/).flatMap((line): Record<string, unknown>[] => {
    if (!line) return [];
    try {
      const value = JSON.parse(line) as unknown;
      return object(value) === null ? [] : [value as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/**
 * Codex の記録を 1 行ずつ受けて表示用の行を積む。
 *   - "subagent": 親→子の agent_message を境界にし、それより後の子自身の発話・ツール実行だけ。
 *   - "exec": 最初の素の利用者発話から（それを利用者側の行として出す）。以後の利用者発話（`exec resume`）も出す。
 */
class CodexRolloutEntryParser {
  readonly entries: SubagentTranscriptEntry[] = [];
  private started = false;
  // 最後に読んだ旧形式 event_msg/agent_message の本文。次の response_item が同文の写しかの判定に使う。
  private eventAssistantText: string | null = null;
  // exec で素の発話イベントが無い記録の代わり: 注入でない最初の response_item の利用者発話。
  private pendingExecRequest: { text: string; ts: number | undefined } | null = null;

  constructor(private readonly mode: "subagent" | "exec", private readonly agentPath: string | null) {}

  consume(record: Record<string, unknown>): void {
    const all = this.entries;
    const ts = parseTimestamp(record["timestamp"]);
    const recordType = record["type"];
    const payload = object(record["payload"]);
    if (payload === null) return;

    if (this.mode === "subagent" && recordType === "response_item" && payload["type"] === "agent_message" &&
      typeof payload["recipient"] === "string" &&
      (this.agentPath === null || payload["recipient"] === this.agentPath)) {
      this.started = true;
      const task = interAgentPayloadText(payload["content"]) ?? interAgentPlaceholder(payload, this.agentPath);
      if (task !== null) all.push(entry("user", task, ts));
      return;
    }
    if (this.mode === "exec" && recordType === "event_msg") {
      const request = payload["type"] === "user_message" && typeof payload["message"] === "string"
        && payload["message"].trim().length > 0
        ? payload["message"]
        : payload["type"] === "item_completed" ? userMessageItemText(payload["item"]) : null;
      if (request !== null) {
        this.started = true;
        this.pendingExecRequest = null;
        all.push(entry("user", request, ts));
        return;
      }
    }
    if (!this.started) {
      if (this.mode !== "exec" || recordType !== "response_item") return;
      if (payload["type"] === "message" && payload["role"] === "user") {
        const text = interAgentPayloadText(payload["content"]) === null ? userInputText(payload["content"]) : null;
        if (this.pendingExecRequest === null && text !== null && !isInjectedCodexContext(text)) {
          this.pendingExecRequest = { text, ts };
        }
        return;
      }
      const codexActed = (payload["type"] === "message" && payload["role"] === "assistant")
        || payload["type"] === "custom_tool_call" || payload["type"] === "function_call";
      if (!codexActed) return;
      // 素の発話イベントを書かない記録: Codex が動き出した時点から読み、控えた依頼文を先に出す。
      this.started = true;
      if (this.pendingExecRequest !== null) {
        all.push(entry("user", this.pendingExecRequest.text, this.pendingExecRequest.ts));
        this.pendingExecRequest = null;
      }
    }

    if (recordType === "event_msg") {
      if (payload["type"] === "agent_message" && typeof payload["message"] === "string" &&
        payload["message"].length > 0) {
        all.push(entry("assistant", payload["message"], ts));
        this.eventAssistantText = payload["message"];
      }
      for (const activity of rolloutPatchApplyActivities(payload)) {
        all.push(entry("tool", transcriptToolText(activity), ts, "tool_use"));
      }
      return;
    }
    if (recordType !== "response_item") return;
    const pendingEventText = this.eventAssistantText;
    this.eventAssistantText = null;

    const message = codexAssistantMessageText(payload);
    if (message !== null) {
      // 旧形式は event_msg の直後に同じ本文の response_item が続く。その写しだけを重ねない。
      if (message !== pendingEventText) all.push(entry("assistant", message, ts));
      return;
    }

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
}

/** `response_item/message`（user）の input_text を連結する。 */
function userInputText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((raw): string[] => {
    const block = object(raw);
    return block?.["type"] === "input_text" && typeof block["text"] === "string" ? [block["text"]] : [];
  }).join("\n");
  return text.trim().length > 0 ? text : null;
}

/** Codex が利用者発話として差し込む文脈（AGENTS.md・環境情報など）か。 */
function isInjectedCodexContext(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith("<") || head.startsWith("# AGENTS.md instructions");
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

/** `response_item/message`（assistant）のうち会話に出す区分の本文。 */
function codexAssistantMessageText(payload: Record<string, unknown>): string | null {
  if (payload["type"] !== "message" || payload["role"] !== "assistant") return null;
  if (!isVisibleCodexMessagePhase(payload["phase"])) return null;
  const content = payload["content"];
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((raw): string[] => {
    const block = object(raw);
    return block?.["type"] === "output_text" && typeof block["text"] === "string" ? [block["text"]] : [];
  }).join("\n");
  return text.length > 0 ? text : null;
}

/**
 * 本文を読めない依頼（暗号化）の区切り。`Message Type: NEW_TASK` は新しい依頼、それ以外は途中の連絡。
 * 送り手が親（自分の 1 つ上）でなければ送り手の名前を添える。
 */
function interAgentPlaceholder(payload: Record<string, unknown>, agentPath: string | null): string | null {
  const content = payload["content"];
  if (!Array.isArray(content)) return null;
  // 暗号化された本文があるときだけ区切りにする（平文だけで目印の無い依頼は従来どおり出さない）。
  if (!content.some((raw) => object(raw)?.["type"] === "encrypted_content")) return null;
  const header = content.flatMap((raw): string[] => {
    const block = object(raw);
    return block?.["type"] === "input_text" && typeof block["text"] === "string" ? [block["text"]] : [];
  }).join("\n");
  const isNewTask = /^Message Type:\s*NEW_TASK\s*$/mu.test(header);
  const author = typeof payload["author"] === "string" && payload["author"].length > 0
    ? payload["author"] : (/^Sender:[ \t]*(\S+)[ \t]*$/mu.exec(header)?.[1] ?? null);
  // 自分の位置が分からないときは親かどうか判断できないので、名前は添えない。
  const parentPath = agentPath !== null && agentPath.includes("/")
    ? agentPath.slice(0, agentPath.lastIndexOf("/")) : null;
  const senderName = author !== null && parentPath !== null && author !== parentPath
    ? author.slice(author.lastIndexOf("/") + 1) : null;
  const title = isNewTask ? "📩 新しい依頼" : "📩 追加の連絡";
  const from = senderName !== null && senderName.length > 0 ? `（${senderName} から）` : "";
  return `${title}${from}\n\n内容は暗号化されていて表示できません。`;
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

/**
 * 通知封筒の `<summary>` を 1 行の表示文にする（無い・空なら null。iOS の
 * ChatLogModel.taskNotificationSummary と同じ規則）。`<em>` は引用符へ、その他のタグは除去し、
 * XML 実体参照を戻して空白を 1 つに詰め、200 字を超える分は「…」で切る。
 */
function taskNotificationSummary(raw: string): string | null {
  const inner = /<summary>([\s\S]*?)<\/summary>/u.exec(raw)?.[1];
  if (inner === undefined) return null;
  const text = inner
    .replace(/<\/?em>/gu, "\"")
    .replace(/<\/?[A-Za-z][^<>]*>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return null;
  const chars = Array.from(text);
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}…` : text;
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

/** テキストを持たないツール結果の代わりの 1 行（中身の種類だけを示す）。 */
export function emptyToolResultLabel(value: unknown): string {
  const blocks = Array.isArray(value) ? value.map(object).filter((block) => block !== null) : [];
  const images = blocks.filter((block) => block["type"] === "image").length;
  if (images > 0) return images === 1 ? "（画像）" : `（画像 ${images} 枚）`;
  const references = blocks.filter((block) => block["type"] === "tool_reference").length;
  if (references > 0) return `（ツールの定義 ${references} 件を読み込み）`;
  return "（結果なし）";
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
