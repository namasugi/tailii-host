// harness（Claude Code）が transcript へ注入する <system-reminder> ブロックの除去。
// 会話一覧プレビュー（claudeSessionStore）・会話検索スニペット（sessionSearch）・
// サブエージェント transcript ビューア（subagentTranscript）で共有する。会話画面の
// 転写は iOS 側 ChatLogModel.present() が行い、assistant 形（stripInjectedReminderBlocks）は
// 同じ規則。user 形は iOS（閉じ無しを末尾まで落とす）と違い、閉じタグまでの最短一致だけ。

const OPEN_TAG = "<system-reminder>";
/** 閉じ行。実測で `</security-reminder>` と閉じる不一致形があるため `</…reminder>` を許容する。 */
const CLOSER_LINE = /^<\/[a-z-]*reminder>$/u;

/**
 * user 行へ注入される `<system-reminder>…</system-reminder>`（リマインダ・記憶リコール等）を
 * 本文から除去する（閉じタグまでの最短一致。閉じが無い言及はそのまま残す）。
 */
export function stripReminderTagBlocks(text: string): string {
  if (!text.includes(OPEN_TAG)) return text;
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "");
}

/**
 * assistant text へ行頭形で追記される harness 注入ブロックを除去する（停止境界の背景通知注入、
 * Claude Code 2.1.251〜）。iOS `ChatLogModel.removingInjectedReminderBlocks` と同じ規則。
 *
 * 書式は `\n\n<system-reminder>\n…\n</system-reminder>\n`（同じ text ブロックに複数回現れ、
 * 間にモデルの続きの本文が挟まる）。行単位で走査し:
 * - 開始 = 行全体が `<system-reminder>` でその後に行が続く（行頭 + 直後改行）行。fence
 *   の内側は対象外（モデルが書式を例示したコードブロックを壊さない）。fence は CommonMark
 *   規則: 先頭 3 空白まで + 3 つ以上の ` または ~ で開き、同じ記号が開き以上の長さで
 *   続くだけの行で閉じる（4 連バッククォート内の ``` や ~~~ で閉じ誤らない）。
 *   バッククォート内や文中の言及は行頭でないので反応しない。
 * - 終了 = 行全体が `</…reminder>` の行。内側に同じ開始行があれば入れ子として数える
 *   （`<result>` に書式が引用されても閉じタグを取り違えない）。閉じが無ければ末尾まで
 *   （実測の不一致/欠落は末尾のみ）。
 * - ブロック前後の空行はまとめて落とし、前後に本文が残る場合だけ空行 1 つで区切る。
 *   それ以外の行（コードブロック内の空行等）は一切触らない。
 * - 各行の比較（開き/閉じ/fence/空行）は行末の `\r` を除いた本体で行い、出力には元の行を残す
 *   （CRLF 混在や Monitor が中継した `\r` 付き出力でも開き/閉じを見失わない）。
 */
export function stripInjectedReminderBlocks(text: string): string {
  if (!text.includes(`${OPEN_TAG}\n`) && !text.includes(`${OPEN_TAG}\r\n`)) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let openFence: { marker: string; length: number } | null = null;
  let depth = 0;
  let afterBlock = false;
  let removedAny = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const core = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (depth > 0) {
      if (core === OPEN_TAG) depth += 1;
      else if (CLOSER_LINE.test(core)) depth -= 1;
      continue;
    }
    if (openFence === null && core === OPEN_TAG && index + 1 < lines.length) {
      depth = 1;
      removedAny = true;
      while (kept.length > 0 && isBlankLine(kept[kept.length - 1] ?? "")) kept.pop();
      afterBlock = true;
      continue;
    }
    if (afterBlock) {
      if (isBlankLine(core)) continue;
      if (kept.length > 0) kept.push("");
      afterBlock = false;
    }
    const run = fenceRun(core);
    if (openFence !== null) {
      if (run !== null && run.marker === openFence.marker && run.length >= openFence.length && isBlankLine(run.rest)) {
        openFence = null;
      }
    } else if (run !== null) {
      openFence = { marker: run.marker, length: run.length };
    }
    kept.push(line);
  }
  return removedAny ? kept.join("\n") : text;
}

function isBlankLine(line: string): boolean {
  return /^[ \t\r]*$/u.test(line);
}

/**
 * Markdown の fence 記号列（先頭 3 空白まで + 3 つ以上の ` または ~）。無ければ null。
 * `rest` は記号列の後ろ（開き行なら info string、閉じ行なら空白のみ）。
 */
function fenceRun(line: string): { marker: string; length: number; rest: string } | null {
  // `.` は \r に一致しないため [\s\S] で「記号列の後ろ全部」を取る（iOS 側と同じ切り方）。
  const match = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/u.exec(line);
  if (match === null) return null;
  const run = match[1] ?? "";
  return { marker: run.charAt(0), length: run.length, rest: match[2] ?? "" };
}
