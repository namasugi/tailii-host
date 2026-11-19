// PermissionRequest と直前の PreToolUse を、別プロセス間で対応づける。

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { apiErrorAssistantKind, extractTurn, isClaudeInterruptMarker } from "../chat/transcriptTailer.js";
import { NdjsonLineSplitter } from "../shared/lineSplitter.js";
import { abortableSleep } from "../shared/sleep.js";
import {
  claudeComposerBarVisible, screenBusyButScrolledAway, screenInLoginFlow, screenShowsApprovalDialog,
  screenShowsCancellableChoice, screenShowsConfirmDialogFooter,
} from "../backend/tmux.js";

interface HookTool {
  sessionId?: string;
  agentId?: string;
  transcriptPath?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface TranscriptPosition {
  file: string;
  inode: number | null;
  offset: number;
}

interface PreToolUseRecord {
  toolUseId: string;
  approvalId: string;
  fingerprint: string;
  atMs: number;
  positions: TranscriptPosition[];
}

// 実測では PreToolUse と PermissionRequest は同じ秒だが、確認が順番待ちになると PermissionRequest は遅れうる。
// 記録はフックの外部の時間切れ（600 秒）まで残し、ツールが実行されたら PostToolUse で消す（forgetPreToolUse）。
// 短い期限で失効させると、同じ入力が並んだとき片方だけ失効して、残った別の呼び出しの記録を取り違える。
const RECORD_TTL_MS = 600_000;
// 同じ会話・同じエージェント・同じ入力で、これより古い記録は前の呼び出しの残り（確認なしで拒否された・PostToolUse が
// 出なかった）とみなして、新しい記録を残すときに消す。同じエージェントは、前のツール呼び出しが決着するまで次の
// 呼び出しを出さない。並行する呼び出し（1 つの応答の中の複数のツール）の PreToolUse はほぼ同時に走るので、この幅に収まる。
const SAME_INPUT_STALE_MS = 30_000;
// 画面（TUI）の確認ダイアログが消えたことの検知。ツールが終わるまで会話ログには何も書かれない（2.1.327 実測）ので、
// 端末で「Yes」を選んだ時間のかかるツールは、会話ログだけでは終わるまで拾えない。
const PANE_POLL_EVERY_TICKS = 8; // RESULT_POLL_MS × 8 = 2 秒
const PANE_CAPTURE_LIMIT_MS = 1500;
const PANE_MISSES_TO_SETTLE = 2;
const RESULT_POLL_MS = 250;
const INITIAL_TAIL_BYTES = 256 * 1024;
const READ_BUDGET_BYTES = 512 * 1024;
// 1 回の確認で読み進める回数の上限（合わせて 8 MiB）。追記に追い付いてから判定する: 大きな結果行の途中で止まると、
// 決着済みの承認への回答を「反映した」と返してしまう。
const READS_PER_CHECK = 16;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeOf(session: string, input: HookTool): string {
  return hash(JSON.stringify([session, input.sessionId, input.agentId]));
}

function fingerprintOf(input: HookTool): string {
  // JSON のオブジェクトのキー順は照合に影響させない。配列の順序と値はそのまま比べる。
  const canonical = JSON.stringify([input.toolName, input.toolInput], (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
  return hash(canonical);
}

function recordDir(base: string): string {
  return path.join(base, ".pre-tool-use");
}

function listRecords(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function unlink(file: string): boolean {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** tool_input 自体は保存せず、指紋・tool_use_id・会話ログの位置だけを記録する。 */
export function rememberPreToolUse(base: string, session: string, input: HookTool, toolUseId: string, approvalId: string): void {
  if (input.sessionId === undefined) return;
  const dir = recordDir(base);
  const atMs = Date.now();
  let fingerprint: string;
  try { fingerprint = fingerprintOf(input); } catch { return; }
  const scope = scopeOf(session, input);
  // 名前に会話・入力の指紋を入れ、ほかの記録を開かずに照合・掃除できるようにする。
  const name = `${atMs}-${scope}-${fingerprint}-${hash(toolUseId)}.json`;
  const temporary = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const old of listRecords(dir)) {
      const [at, oldScope, oldFingerprint] = old.split("-");
      const age = atMs - Number(at);
      if (age > RECORD_TTL_MS || (age > SAME_INPUT_STALE_MS && oldScope === scope && oldFingerprint === fingerprint)) {
        unlink(path.join(dir, old));
      }
    }
    const positions: TranscriptPosition[] = [];
    for (const { file } of transcriptFiles(input)) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) positions.push({ file, inode: stat.ino, offset: stat.size });
      } catch (error) {
        // 最初の追記で作られるログは、先頭から見る（結果の行が大きくても取りこぼさない）。
        if ((error as NodeJS.ErrnoException).code === "ENOENT") positions.push({ file, inode: null, offset: 0 });
      }
    }
    const record: PreToolUseRecord = { toolUseId, approvalId, fingerprint, atMs, positions };
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, path.join(dir, name));
  } catch {
    unlink(temporary);
  }
}

/** 同時に同一入力が並んだときは順序を推測しない。unlink に勝ったプロセスだけが記録を使う。 */
export function takePreToolUse(base: string, session: string, input: HookTool): PreToolUseRecord | null {
  if (input.sessionId === undefined) return null;
  const dir = recordDir(base);
  const scope = scopeOf(session, input);
  let fingerprint: string;
  try { fingerprint = fingerprintOf(input); } catch { return null; }
  const now = Date.now();
  let found: { file: string; record: PreToolUseRecord } | null = null;
  for (const name of listRecords(dir)) {
    const parts = name.split("-");
    if (!name.endsWith(".json") || parts[1] !== scope || parts[2] !== fingerprint) continue;
    const file = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as PreToolUseRecord;
      if (record.fingerprint !== fingerprint) continue;
      // 同じ入力の記録が 2 つ以上あれば、失効・破損したものも含めて順序を推測しない（取り違えない）。
      if (found !== null) return null;
      found = { file, record };
    } catch { /* 別のフックが消した、または読めない。 */ }
  }
  if (found === null) return null;
  const { record } = found;
  const usable = Number.isFinite(record.atMs) && record.atMs >= now - RECORD_TTL_MS && record.atMs <= now &&
    typeof record.toolUseId === "string" && typeof record.approvalId === "string" && Array.isArray(record.positions);
  return unlink(found.file) && usable ? record : null;
}

/** ツールが実行された（PostToolUse）ら、その呼び出しの記録は要らない。残すと後の同じ入力と紛れる。 */
export function forgetPreToolUse(base: string, toolUseId: string): void {
  const dir = recordDir(base);
  const suffix = `-${hash(toolUseId)}.json`;
  for (const name of listRecords(dir)) {
    if (name.endsWith(suffix)) unlink(path.join(dir, name));
  }
}

/** メインのパスが渡されたサブエージェントについては、既存の会話ログと同じ配置の子ログも見る。 */
function transcriptFiles(input: HookTool): { file: string; ownTurn: boolean }[] {
  const file = input.transcriptPath;
  if (file === undefined || !path.isAbsolute(file)) return [];
  if (input.agentId !== undefined && input.sessionId !== undefined && path.basename(file) === `${input.sessionId}.jsonl`) {
    const parent = { file, ownTurn: false };
    if (!/^[\w-]+$/.test(input.agentId)) return [parent];
    const child = path.join(file.slice(0, -".jsonl".length), "subagents", `agent-${input.agentId}.jsonl`);
    return [{ file: child, ownTurn: true }, parent];
  }
  return [{ file, ownTurn: true }];
}

/** 承認専用に末尾の追記を追う。既存の transcript 購読や hub、PostToolUse の発火に依存しない。 */
export function watchExternalApproval(
  input: HookTool,
  record: PreToolUseRecord | null,
  startedAtMs: number,
  /** 会話の画面（pane）の取得。渡すと、確認ダイアログが画面から消えたことも決着として拾う。 */
  paneCapture?: () => Promise<string | null>,
  /** 画面を見る間隔（会話ログを見る回数で数える。テスト用）。 */
  panePollEveryTicks: number = PANE_POLL_EVERY_TICKS,
) {
  const cursors = transcriptFiles(input).map(({ file, ownTurn }) => ({
    file, ownTurn, position: record?.positions.find((position) => position.file === file),
    splitter: new NdjsonLineSplitter(),
  }));
  const toolUseId = record?.toolUseId;
  const since = record?.atMs ?? startedAtMs;
  let settled = false;

  function check(): boolean {
    for (const cursor of cursors) {
      if (settled) break;
      let fd: number | undefined;
      try {
        fd = fs.openSync(cursor.file, "r");
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) continue;
        let position = cursor.position;
        if (position?.inode === null) position.inode = stat.ino;
        if (position === undefined || position.inode !== stat.ino || position.offset > stat.size) {
          position = { file: cursor.file, inode: stat.ino, offset: Math.max(0, stat.size - INITIAL_TAIL_BYTES) };
          cursor.position = position;
          cursor.splitter = new NdjsonLineSplitter();
        }
        for (let reads = 0; reads < READS_PER_CHECK && !settled; reads += 1) {
        const length = Math.min(READ_BUDGET_BYTES, stat.size - position.offset);
        if (length <= 0) break;
        const chunk = Buffer.allocUnsafe(length);
        const bytes = fs.readSync(fd, chunk, 0, length, position.offset);
        if (bytes <= 0) break;
        position.offset += bytes;
        cursor.splitter.push(chunk.subarray(0, bytes), (buffer) => {
          if (settled) return;
          const line = buffer.toString("utf8");
          if (toolUseId !== undefined && line.includes('"tool_result"') && line.includes(JSON.stringify(toolUseId)) &&
              extractTurn(line)?.toolResultIds.includes(toolUseId)) {
            settled = true; // 成功と拒否の両方。後者では PostToolUse が発火しない。
            return;
          }
          if (!cursor.ownTurn || (!line.includes('"turn_duration"') && !line.includes('"isApiErrorMessage"') &&
              !line.includes("[Request interrupted by user"))) return;
          try {
            const row = JSON.parse(line) as Record<string, unknown>;
            if (!(typeof row?.["timestamp"] === "string" && Date.parse(row["timestamp"]) >= since)) return;
            settled = (row["type"] === "system" && row["subtype"] === "turn_duration") ||
              apiErrorAssistantKind(line) !== null ||
              (row["type"] === "user" && isClaudeInterruptMarker(extractTurn(line)?.text ?? ""));
          } catch { /* 読み始めが行の途中だった。 */ }
        });
        }
      } catch { /* 未作成や一時的な読取失敗は次回の追記確認で再試行する。 */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return settled;
  }

  // 画面の確認ダイアログを一度見たあと、「確認が閉じた」と言える画面（入力欄が戻っている）が続いたら決着とみなす。
  // - 一度も見えていなければ使わない（判定できない形のダイアログで、待っている承認を取り下げない）。
  // - 入力欄が見えない画面（別のダイアログ・空の画面・再描画の途中）や、上へスクロールされた画面は、閉じた根拠に
  //   しない。取得の失敗・時間切れも同じ。どれも連続の数え直しになる。
  // - 前の取得が戻っていなければ、次の取得は始めない（応答しない端末に取得のコマンドを溜めない）。
  // 見誤って取り下げても、確認は画面に残り、フックが終われば転写カードで答えられる。
  let paneSeen = false;
  let paneClosedFrames = 0;
  let paneBusy = false;
  async function checkPane(signal: AbortSignal): Promise<void> {
    if (paneCapture === undefined || paneBusy) return;
    paneBusy = true;
    const capture = paneCapture().catch(() => null).finally(() => { paneBusy = false; });
    const limit = new AbortController();
    let text: string | null;
    try {
      text = await Promise.race([
        capture,
        abortableSleep(PANE_CAPTURE_LIMIT_MS, AbortSignal.any([limit.signal, signal])).then(() => null),
      ]);
    } finally {
      limit.abort();
    }
    if (signal.aborted) return;
    // ツール承認の形だけを「見た」とする（プレビュー配信が転写を抑える条件と同じ。設問・確認系・/login の
    // 方式選択は同じ `Esc to cancel` を持つが、ツール承認ではない）。
    const approval = text !== null && screenShowsApprovalDialog(text) && !screenShowsCancellableChoice(text) &&
      !screenShowsConfirmDialogFooter(text) && !screenInLoginFlow(text);
    if (approval) {
      paneSeen = true;
      paneClosedFrames = 0;
    } else if (text !== null && paneSeen && claudeComposerBarVisible(text) && !screenBusyButScrolledAway(text)) {
      paneClosedFrames += 1;
      if (paneClosedFrames >= PANE_MISSES_TO_SETTLE) settled = true;
    } else {
      paneClosedFrames = 0;
    }
  }

  return {
    check,
    async wait(signal: AbortSignal): Promise<boolean> {
      for (let tick = 1; !signal.aborted; tick += 1) {
        if (check()) return true;
        if (tick % Math.max(1, panePollEveryTicks) === 0) {
          await checkPane(signal);
          if (settled) return true;
        }
        await abortableSleep(RESULT_POLL_MS, signal);
      }
      return false;
    },
  };
}
