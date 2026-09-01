// 別セッションからのメッセージ封筒（<cross-session-message …>）の転写。
//
// Claude Code のセッション間メッセージ（SendMessage）は、受信側 transcript へ 2 形で残る:
//   ① idle 起こし: user 行（isMeta）。前置き 1 行 "Another Claude session sent a message:" +
//      封筒 + 封筒の後ろに取り扱いガイダンスの英文段落。
//   ② ターン処理中: attachment(queued_command) の prompt（封筒のみ。前置き/後置きなし）。
// どちらも本文は
//   <cross-session-message from="uds:/…" from-name="bay-3d" from-mode="prompting">
//   本文…
//   </cross-session-message>
// の行構造。生 XML を表示へ出さないよう、from-name と本文だけを取り出す。
//
// 会話画面の転写は iOS 側 `ChatLogModel.crossSessionMessage()` が同じ規則で行う。本 helper は
// 一覧プレビュー/タイトル（claudeSessionStore）・会話検索（sessionSearch）・サブエージェント
// transcript ビューア（subagentTranscript）で共有する。判定の門番は harnessReminder と同じ流儀:
// 封筒が（既知の前置き行を除き）先頭から始まる場合だけ反応し、本文途中の言及・引用には
// 反応しない。行比較は行末の `\r` を除いた本体で行う（CRLF 耐性）。

const OPEN_PREFIX = "<cross-session-message";
const CLOSER = "</cross-session-message>";
/**
 * idle 起こし形（①）の前置き行。実測は "Another Claude session sent a message:"。
 * 文言はバージョンで揺れ得るため（reply 等）、"Another Claude …:" の 1 行として許容する。
 */
const WAKE_PREFIX = /^Another Claude .*:$/u;

export interface CrossSessionMessage {
  /** 送信元セッション名（`from-name` 属性）。属性なし/空は null。 */
  senderName: string | null;
  /** 封筒の中身（前後の空白は除去済み）。 */
  body: string;
}

/**
 * text が別セッションからのメッセージ封筒なら送信元名と本文を返す。封筒でなければ null。
 * 閉じタグが無い場合は末尾までを本文とする。封筒より後ろ（取り扱いガイダンス）は落とす。
 */
export function presentCrossSessionMessage(text: string): CrossSessionMessage | null {
  if (!text.includes(OPEN_PREFIX)) return null;
  const lines = text.split("\n");
  const core = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

  // 先頭の空行と（1 回だけ）前置き行を読み飛ばし、封筒の開始行へ到達するか確認する。
  let index = 0;
  let sawWakePrefix = false;
  while (index < lines.length) {
    const line = core(lines[index] ?? "").trim();
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
  const openLine = core(lines[index] ?? "").trim();
  if (!openLine.startsWith(OPEN_PREFIX) || !openLine.endsWith(">")) return null;
  // タグ名の直後は属性区切りか終端のみ（<cross-session-messages 等の別タグを誤検知しない）。
  const boundary = openLine.charAt(OPEN_PREFIX.length);
  if (boundary !== " " && boundary !== ">") return null;

  const name = / from-name="([^"]*)"/u.exec(openLine)?.[1] ?? "";
  const bodyLines: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (core(lines[cursor] ?? "").trim() === CLOSER) break;
    bodyLines.push(lines[cursor] ?? "");
  }
  return { senderName: name === "" ? null : name, body: bodyLines.join("\n").trim() };
}

/** 表示用の送信元ラベル（名前が無い封筒のフォールバック込み）。 */
export function crossSessionSenderLabel(message: CrossSessionMessage): string {
  return message.senderName ?? "別セッション";
}

/** 一覧プレビュー/タイトル/検索スニペット向けの転写（「⇄ 送信元名: 本文」。本文なしは名前だけ）。 */
export function crossSessionPreviewLine(message: CrossSessionMessage): string {
  const label = `⇄ ${crossSessionSenderLabel(message)}`;
  return message.body === "" ? label : `${label}: ${message.body}`;
}
