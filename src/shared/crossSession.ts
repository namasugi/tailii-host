// 別セッション / 別エージェントからのメッセージ封筒の転写。
//
// Claude Code のエージェント間メッセージ（SendMessage・サブエージェントの完了報告）は、受信側
// transcript へ 2 形で残る:
//   ① idle 起こし: user 行（isMeta）。前置き 1 行 "Another Claude session sent a message:"
//      （"… while you were working:" 等の揺れあり）+ 封筒 + 封筒の後ろに取り扱いガイダンスの英文段落。
//   ② ターン処理中: attachment(queued_command) の prompt（封筒のみ。前置き/後置きなし）。
// 封筒のタグは 2 種（2.1.273 実測）:
//   <cross-session-message from="uds:/…" from-name="bay-3d" from-mode="prompting">   … 別セッション間
//   <agent-message from="general-purpose">                                            … 同一セッション内の
//                                                                                      サブエージェント/チームメイト
// どちらも「開始タグ 1 行 / 本文 / 閉じタグ 1 行（column 0）」の行構造。生 XML を表示へ出さないよう、
// 送信元名と本文だけを取り出す。1 行完結形（`<tag …>本文</tag>`）も受理する。
//
// `<agent-message>` の本文が `[Subagent hand-back]` で始まり定型前置き行（"… The report follows:"）を
// 持つものは、委任したサブエージェントの最終レポートの自動配送（hand-back）。前置き行の後にレポート
// 全行が 2 空白でインデントされて続く。`kind: "handback"` で区別し、body には前置きとインデントを外した
// レポート全文を入れる（表示側は「サブエージェントの報告」として本文ごと見せる。レポートは親 transcript
// ではこの封筒にしか残らないので、畳んで隠してはいけない）。
//
// hand-back 判定の権威は user 行の `origin:{kind:"peer", handback:true}`（実測）。host の消費側は
// `crossSessionOriginHint()` でそれを渡す。本文の形だけで判定する経路（iOS のチャット面・origin の無い
// 行）は「マーカー + 定型前置き行」の両方を要求し、片方だけ（文言ドリフト / 本文をマーカーで始めた
// ピア）はピアとして全文を見せる側へ倒す（隠す側には倒さない）。
//
// 会話画面の転写は iOS 側 `ChatLogModel.crossSessionMessage()` が同じ規則で行う。本 helper は
// 一覧プレビュー/タイトル（claudeSessionStore）・会話検索（sessionSearch）・サブエージェント
// transcript ビューア（subagentTranscript）で共有する。判定の門番は harnessReminder と同じ流儀:
// 封筒が（既知の前置き行を除き）先頭から始まる場合だけ反応し、本文途中の言及・引用には
// 反応しない。行比較は行末の `\r` を除いた本体で行う（CRLF 耐性）。閉じタグは column 0 の行だけ
// （harness がレポート全行を 2 空白でインデントするのは、まさに column 0 の枠線風の行を本文で偽造
// させないためなので、インデントされた同文は本文として残す）。

/** 封筒として受理するタグ名（開始行は `<タグ名` + 空白か `>`）。 */
const ENVELOPE_TAGS = ["cross-session-message", "agent-message"] as const;
type EnvelopeTag = (typeof ENVELOPE_TAGS)[number];
/**
 * idle 起こし形（①）の前置き行。実測は "Another Claude session sent a message:" と
 * "Another Claude session sent a message while you were working:"。文言はバージョンで揺れ得るため
 * "Another Claude …:" の 1 行として許容する。
 */
const WAKE_PREFIX = /^Another Claude .*:$/u;
/** サブエージェント完了報告（hand-back）の本文先頭マーカー。 */
const HANDBACK_MARKER = "[Subagent hand-back]";
/** hand-back の定型前置き行の末尾。この行の次からがレポート本文（各行 2 空白インデント）。 */
const HANDBACK_REPORT_FOLLOWS = "The report follows:";
/** hand-back のレポート各行に harness が付けるインデント。 */
const HANDBACK_INDENT = "  ";

/** サブエージェントの完了報告（hand-back）の見出し（チャット面のカードヘッダ / 一覧・検索・サブエージェント表示で共通）。 */
export const SUBAGENT_HANDBACK_LABEL = "サブエージェントの報告";

export interface CrossSessionMessage {
  /**
   * `peer` = 別セッション / 同一セッション内の別エージェントからの発話（ピアカードで表示）。
   * `handback` = 委任したサブエージェントの最終レポートの自動配送（「サブエージェントの報告」カード）。
   */
  kind: "peer" | "handback";
  /** 送信元の名前（`from-name` 属性。無ければ `<agent-message>` の `from` 属性）。属性なし/空は null。 */
  senderName: string | null;
  /** 封筒の中身（前後の空白は除去済み）。hand-back は前置きとインデントを外したレポート全文。 */
  body: string;
}

/**
 * transcript の user 行から hand-back 判定の権威値を取り出す: `origin.kind === "peer"` の行は
 * `origin.handback === true` かどうか（真偽が確定）。origin が無い / peer でない行は undefined
 * （本文の形で判定する）。
 */
export function crossSessionOriginHint(record: Record<string, unknown>): boolean | undefined {
  const origin = record["origin"];
  if (typeof origin !== "object" || origin === null) return undefined;
  const fields = origin as Record<string, unknown>;
  if (fields["kind"] !== "peer") return undefined;
  return fields["handback"] === true;
}

/**
 * text が別セッション / 別エージェントからのメッセージ封筒なら送信元名と本文を返す。封筒でなければ
 * null。閉じタグが無い場合は末尾までを本文とする。封筒より後ろ（取り扱いガイダンス）は落とす。
 * `handbackHint` は `crossSessionOriginHint()` の権威値（与えられれば本文の形より優先）。
 */
export function presentCrossSessionMessage(text: string, handbackHint?: boolean): CrossSessionMessage | null {
  if (!ENVELOPE_TAGS.some((tag) => text.includes(`<${tag}`))) return null;
  const lines = text.split("\n").map(unfold);

  // 先頭の空行と（1 回だけ）前置き行を読み飛ばし、封筒の開始行へ到達するか確認する。
  let index = 0;
  let sawWakePrefix = false;
  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    if (line === "") {
      index += 1;
      continue;
    }
    if (!sawWakePrefix && WAKE_PREFIX.test(line)) {
      sawWakePrefix = true;
      index += 1;
      continue;
    }
    break;
  }
  const open = parseOpenLine((lines[index] ?? "").trim());
  if (open === null) return null;

  const fromName = attributeValue("from-name", open.openTag);
  // `<cross-session-message>` の from は uds ソケットパスなので名前には使わない。
  const name = fromName ?? (open.tag === "agent-message" ? attributeValue("from", open.openTag) : null);
  const bodyLines: string[] = [];
  if (open.inlineBody !== null) {
    bodyLines.push(open.inlineBody);
  } else {
    const closer = `</${open.tag}>`;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      // 閉じタグは column 0 の行だけ（インデントされた同文は本文）。行末の空白は許容する。
      if (line.trimEnd() === closer) break;
      bodyLines.push(line);
    }
  }
  const handback = handbackHint ?? (open.tag === "agent-message" && looksLikeHandback(bodyLines));
  if (handback) return { kind: "handback", senderName: name, body: handbackReport(bodyLines) };
  return { kind: "peer", senderName: name, body: bodyLines.join("\n").trim() };
}

/** 行末の `\r` を除いた行本体（CRLF 耐性）。 */
function unfold(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

interface OpenLine {
  tag: EnvelopeTag;
  /** 開始タグそのもの（`<tag …>`）。属性はここから取る。 */
  openTag: string;
  /** 1 行完結形（`<tag …>本文</tag>`）の本文。複数行形は null。 */
  inlineBody: string | null;
}

/**
 * 開始行を解釈する。受理タグの開始タグ（`<タグ名` の直後は属性区切りか終端のみ）で、行が開始タグ
 * で終わる（複数行形）か、開始タグの直後から同じタグの閉じタグで終わる（1 行完結形）場合だけ受理。
 * 開始タグの後に閉じタグ無しで本文が続く行（タグに言及しただけの発話 `<tag> の表示を直して` 等）は
 * 封筒ではない。
 */
function parseOpenLine(line: string): OpenLine | null {
  for (const tag of ENVELOPE_TAGS) {
    const prefix = `<${tag}`;
    if (!line.startsWith(prefix)) continue;
    // タグ名の直後は属性区切りか終端のみ（<cross-session-messages 等の別タグを誤検知しない）。
    const boundary = line.charAt(prefix.length);
    if (boundary !== " " && boundary !== ">") continue;
    const end = openTagEnd(line, prefix.length);
    if (end < 0) return null;
    const openTag = line.slice(0, end + 1);
    const rest = line.slice(end + 1);
    if (rest === "") return { tag, openTag, inlineBody: null };
    const closer = `</${tag}>`;
    if (!rest.endsWith(closer)) return null;
    return { tag, openTag, inlineBody: rest.slice(0, rest.length - closer.length) };
  }
  return null;
}

/** 開始タグの終端 `>` の位置（属性値の "…" 内の `>` は読み飛ばす）。無ければ -1。 */
function openTagEnd(line: string, from: number): number {
  let quoted = false;
  for (let i = from; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (ch === '"') quoted = !quoted;
    else if (ch === ">" && !quoted) return i;
  }
  return -1;
}

/** 開始タグから ` name="value"` 形の属性値を取り出す（無し/空は null）。 */
function attributeValue(name: string, openTag: string): string | null {
  const value = new RegExp(` ${name}="([^"]*)"`, "u").exec(openTag)?.[1] ?? "";
  return value === "" ? null : value;
}

/** 本文の最初の非空行の添字（無ければ -1）。 */
function firstContentLine(bodyLines: string[]): number {
  return bodyLines.findIndex((line) => line.trim() !== "");
}

/** first 行以降で定型前置き行（"… The report follows:" で終わる行）の添字（無ければ -1）。 */
function reportFollowsLine(bodyLines: string[], first: number): number {
  if (first < 0) return -1;
  const offset = bodyLines.slice(first).findIndex((line) => line.trimEnd().endsWith(HANDBACK_REPORT_FOLLOWS));
  return offset < 0 ? -1 : first + offset;
}

/**
 * 本文の形だけからの hand-back 判定（iOS と同じ規則）: 先頭行がマーカーで始まり、かつ定型前置き行が
 * ある。マーカーだけ（定型行なし = 文言ドリフト、またはマーカーで本文を始めたピア）はピアとして全文を
 * 見せる。
 */
function looksLikeHandback(bodyLines: string[]): boolean {
  const first = firstContentLine(bodyLines);
  if (first < 0 || !(bodyLines[first] ?? "").trimStart().startsWith(HANDBACK_MARKER)) return false;
  return reportFollowsLine(bodyLines, first) >= 0;
}

/**
 * hand-back 封筒の中身からレポート全文を取り出す: 定型前置き行までを落とし、残る各行の先頭インデント
 * （2 空白）を外す。前置き行が無ければマーカー行だけを落とし、マーカーも無ければ（権威値で hand-back と
 * 分かっているが本文の形が違う場合）全行を使う。
 */
function handbackReport(bodyLines: string[]): string {
  const first = firstContentLine(bodyLines);
  const follows = reportFollowsLine(bodyLines, first);
  let start = 0;
  if (follows >= 0) start = follows + 1;
  else if (first >= 0 && (bodyLines[first] ?? "").trimStart().startsWith(HANDBACK_MARKER)) start = first + 1;
  return bodyLines
    .slice(start)
    .map((line) => (line.startsWith(HANDBACK_INDENT) ? line.slice(HANDBACK_INDENT.length) : line))
    .join("\n")
    .trim();
}

/** 表示用の送信元ラベル（hand-back は固定の見出し。名前が無い封筒のフォールバック込み）。 */
export function crossSessionSenderLabel(message: CrossSessionMessage): string {
  if (message.kind === "handback") return SUBAGENT_HANDBACK_LABEL;
  return message.senderName ?? "別セッション";
}

/** 一覧プレビュー/タイトル/検索スニペット向けの転写（「⇄ 送信元名: 本文」。本文なしは名前だけ）。 */
export function crossSessionPreviewLine(message: CrossSessionMessage): string {
  const label = `⇄ ${crossSessionSenderLabel(message)}`;
  return message.body === "" ? label : `${label}: ${message.body}`;
}
