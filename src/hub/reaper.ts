// reaper.ts
// tailii (TS host) — tmux セッション自動掃除の判定ロジック。
//
// engine 内蔵の idle reaper は「engine(=SSH 接続)が生きている間しか回らない」「tracker が
// in-memory で再起動時に空」という構造穴があった。Session Hub daemon は engine から独立した
// detached プロセスとして動き、heartbeat ファイル(heartbeat.ts)を唯一の判定権威にして
// `now - ts >= timeout`(一律 1800 秒)で kill する。ただし当該 pane の子孫または同じ制御端末の
// TCP サーバーが LISTEN 中なら activity とみなし、巻き添え終了を防ぐ。
//
// state=active(処理中)の扱いはエージェントで異なる:
//   - claude: ターン中でも hook はツール実行中に沈黙する(長い1ツール呼びの間イベントが無い)
//     ため、pane のエージェントプロセス生存を確認できたら Hub が ts を bump 代行する。
//     プロセスが死んでいる(pane がシェルだけ)なら idle に書き換え → 30 分後に通常ルールで kill。
//   - codex: ターンは engine が駆動し engine と運命共同体。engine が 60 秒毎に bump するので、
//     bump が止まって timeout を超えた active は「死んだターン」→ そのまま kill してよい。
//     Hub は bump 代行しない(すると bump 停止=ターン死亡のシグナルが壊れる)。
//
// claude の idle が timeout を超えても、背景作業が残っていれば殺さない（Stop hook は背景の
// サブエージェント・シェル・予約が残っていても発火して idle になるため）:
//   - Claude Code 自身の状態ファイル `~/.claude/sessions/<pid>.json` の status が仕事中
//     （busy=背景サブエージェント等 / shell=背景シェル・Monitor / waiting=承認・ダイアログ待ち）なら bump。
//     完了通知に依存しない生の申告。同じ status のまま 24h を超えたら保護しない。照合は tmux=`tmux` 欄の
//     セッション名、herdr=pane の前面 pid（取れなければ、tmux 欄の無い生きた記録がちょうど 1 件の
//     ときだけ session id）。
//   - Stop hook が記録した予約（/loop・ScheduleWakeup・CronCreate）が未発火で、それを持つ Claude
//     プロセス（pid）が生きていれば bump。1 回きり=発火時刻+10 分（記録から 7 日上限）、繰り返し=最初に
//     見てから 7 日（Claude Code の自動失効）+最終発火の猶予、解釈不能=24h で保護を外す。
//
// 対象は tailii が作る `cs-*` / `s-*` セッションのみ。ユーザーの他の tmux セッションには触れない。
// heartbeat 未採番の生存セッション(過去の残骸)は「今を idle」として採番し、次周期から計時する。
// 対象セッションが 0 になったら自然終了する(次の engine 接続 / hook 発火で ensure され再起動)。

import { ApiAgentSessionStore } from "../apiAgent/sessionState.js";
import {
  bumpHeartbeat,
  type Heartbeat,
  type HeartbeatScheduled,
  listHeartbeatSessions,
  readHeartbeat,
  removeHeartbeat,
  writeHeartbeat,
} from "../sessions/heartbeat.js";
import { HerdrSessionManager, isDefaultHerdrTabLabel } from "../backend/herdr.js";
import { CodexSessionStore } from "../codex/codexSessionStore.js";
import type { SessionInfo } from "../protocol.js";
import { isAgentListener, processBelongsToPane, type LocalServerProcesses } from "./localServerProcesses.js";
import { SessionMetadataStore } from "../sessions/sessionMetadataStore.js";
import { PrewarmStore, prewarmExpired } from "../sessions/prewarmStore.js";
import { claudeTranscriptExists } from "../sessions/claudeTranscriptExists.js";
import { ClaudeSessionStore, transcriptTitle } from "../sessions/claudeSessionStore.js";
import { paneCommandLooksLikeAgent, tmuxServerAbsent, type TmuxCommandRunner } from "../backend/tmux.js";
import {
  type ClaudeLiveRecord,
  claudeProcessAlive,
  defaultClaudeSessionsDir,
  findClaudeLiveRecords,
  isClaudeWorking,
  readClaudeLiveRecordOf,
} from "../sessions/claudeLiveStatus.js";

/** 一律のアイドル timeout(秒)。idle/active(bump 停止)の両方に同じ値を使う。 */
export const REAPER_IDLE_TIMEOUT_SECONDS = 1800;

/** 巡回間隔(秒)。 */
export const REAPER_CHECK_INTERVAL_SECONDS = 60;

/**
 * Claude 自身が「仕事中（背景のサブエージェント・シェル等）」と申告している間の保護上限(秒)。
 * 申告が同じ status のまま固着しても、これを超えたら通常の計時へ戻す（永続保護にしない）。
 */
export const CLAUDE_WORKING_MAX_SECONDS = 24 * 3600;

/** 1 回きりの予約の発火時刻から、発火後のターンが始まるまでを待つ猶予(秒)。 */
export const SCHEDULED_ONE_SHOT_GRACE_SECONDS = 10 * 60;

/**
 * 予約による保護の上限(秒)。Claude Code は繰り返し予約を作成から 7 日で自動失効させる
 * （最後に 1 回発火してから消える）ので、繰り返しは最初に見た時刻から数える。
 * 1 回きりにも記録時刻から同じ上限を掛ける: ターン中に発火時刻を過ぎた予約は Stop の一覧に残り、
 * 「次の一致」が翌日（ScheduleWakeup の日付 `*`）や翌年（日付固定）になる。通常は Stop 直後に
 * 発火して次の Stop で消えるが、そのターンが中断・API エラーで Stop なく終わると記録が残り続けるため。
 */
export const SCHEDULED_MAX_SECONDS = 7 * 24 * 3600;

/** 繰り返し予約の失効前の最終発火を待つ猶予(秒)。繰り返しは最大 30 分遅れて発火する。 */
export const SCHEDULED_RECURRING_FINAL_GRACE_SECONDS = 40 * 60;

/** 解釈できない予約の保護期限(秒)。 */
export const SCHEDULED_UNPARSED_MAX_SECONDS = 24 * 3600;

/** Stop 時点の予約がまだ先に残っているか。 */
export function scheduledPending(scheduled: HeartbeatScheduled, now: number): boolean {
  if (scheduled.recurring.some((entry) =>
    now < entry.firstSeenTs + SCHEDULED_MAX_SECONDS + SCHEDULED_RECURRING_FINAL_GRACE_SECONDS)) return true;
  if (scheduled.unparsed && now < scheduled.atTs + SCHEDULED_UNPARSED_MAX_SECONDS) return true;
  if (now >= scheduled.atTs + SCHEDULED_MAX_SECONDS) return false;
  return scheduled.oneShotTs.some((fireTs) => now < fireTs + SCHEDULED_ONE_SHOT_GRACE_SECONDS);
}

/** tailii が管理する tmux セッション名(これ以外は絶対に触らない)。 */
export const TAILII_SESSION_PATTERN = /^(cs|s)-/;

/** herdr backend セッションの reaper 操作面（テストはモックを注入する）。 */
export interface HerdrReaperOps {
  list(): Promise<SessionInfo[]>;
  /**
   * 列挙できなかった場合に null を返す版（任意実装）。null=検出不能として heartbeat 回収を
   * 見送る。実装が無い ops は従来どおり `list()` の空集合を「0 件」として扱う。
   */
  listLive?(): Promise<SessionInfo[] | null>;
  agentProcessAlive(name: string): Promise<boolean>;
  /** pane の前面プロセスの pid 群（Claude の状態ファイル照合用, 任意実装）。取得不能は null。 */
  agentProcessIds?(name: string): Promise<number[] | null>;
  /** pane の起動プロセス（shell_pid）。サーバーの親子関係照合用。取得不能は null。 */
  paneProcessId?(name: string): Promise<number | null>;
  kill(name: string): Promise<void>;
  /** 生存 Tailii セッションが 0 のとき、pane ゼロの専用 server を停止する（任意実装）。 */
  stopServerIfEmpty?(): Promise<void>;
  /** 生存 pane の session 名 → タブ情報（session-title 自動タイトル同期用, 任意実装）。 */
  tabInfoByName?(): Promise<Map<string, { tabId: string; label: string | null }>>;
  /** タブラベルの書換（session-title, 任意実装）。 */
  setDisplayTitle?(name: string, title: string | null): Promise<void>;
}

/** API 作業の会話が開いているか（hub の記録 `~/.tailii/api-agent/sessions/<名前>.json` の有無）。 */
function defaultApiAgentSessionOpen(name: string): boolean {
  return new ApiAgentSessionStore().get(name) !== null;
}

export interface ReaperTickOptions {
  /** API 作業の会話が開いているか（テスト注入用。既定は hub の記録を読む）。 */
  apiAgentSessionOpen?: (name: string) => boolean;
  runner: TmuxCommandRunner;
  heartbeatDir: string;
  metadataStore: SessionMetadataStore;
  /**
   * 新規会話の先行起動の記録（session-prewarm）。使われないまま期限を過ぎた先行起動を閉じる。
   * 省略時は既定の場所（`~/.tailii/sessions/prewarm`）。null は扱わない。
   */
  prewarmStore?: PrewarmStore | null;
  timeoutSeconds: number;
  now: number;
  log?: (message: string) => void;
  /**
   * LISTEN 中のローカル開発サーバーとプロセスの親子関係。timeout 候補がある tick でだけ呼ぶ。
   * null は検出不能。サーバーなしの空集合とは区別し、回収を次 tick へ延期する。
   */
  listLocalServers?: () => Promise<LocalServerProcesses | null>;
  /**
   * herdr backend の操作面。省略時は herdr メタが存在するときだけ実 HerdrSessionManager を使う
   * （純 tmux 環境では herdr CLI を一切呼ばない）。null で herdr 巡回を無効化。
   */
  herdrOps?: HerdrReaperOps | null;
  /**
   * claude 会話タイトルの導出（session-title 自動タイトル同期用, テスト注入可）。
   * 省略時は transcript の明示タイトル（custom-title/ai-title）優先 → 最初のユーザー発話。
   */
  deriveClaudeTitle?: (claudeSessionId: string) => string | null;
  /**
   * Codex の正式な会話名（thread.name）の導出（session-title 自動タイトル同期用）。
   * 省略時はローカルの session_index.jsonl を巡回ごとに一度だけ読む。
   */
  deriveCodexTitle?: (threadId: string) => string | null | Promise<string | null>;
  /**
   * Claude Code がプロセスごとに書く状態ファイルの置き場（`~/.claude/sessions`）。
   * null で「Claude の仕事中申告」による保護を無効化。
   */
  claudeSessionsDir?: string | null;
  /** 状態ファイルの pid が生きているか（テスト注入可。既定は kill 0 + 起動時刻照合）。 */
  claudeProcessAlive?: (pid: number, procStart: string | null) => boolean | Promise<boolean>;
}

export interface ReaperTickResult {
  /** 巡回時点で生存していた tailii セッション数(kill 前)。0 なら daemon は自然終了してよい。 */
  liveCount: number;
  killed: string[];
  /** active のままプロセスだけ死んでいて idle へ降格したセッション。 */
  demoted: string[];
  /** 生存セッションが無く heartbeat 残骸を掃除したセッション。 */
  reclaimed: string[];
}

/** 生存中の tailii セッション名(`cs-*`/`s-*`)。tmux サーバ不在は空集合。 */
export async function liveTailiiSessions(runner: TmuxCommandRunner): Promise<string[]> {
  const result = await runner(["ls", "-F", "#{session_name}"]);
  if (result.exitCode !== 0) {
    if (tmuxServerAbsent(result.stdout + result.stderr)) return [];
    throw new Error(`tmux ls failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => TAILII_SESSION_PATTERN.test(name))
    .sort();
}

/** ターミナルクライアントが attach 中のセッション名集合。取得失敗は空集合(保護なしに倒す)。 */
export async function attachedSessions(runner: TmuxCommandRunner): Promise<Set<string>> {
  try {
    const result = await runner(["list-clients", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) return new Set();
    return new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.length > 0),
    );
  } catch {
    return new Set();
  }
}

/**
 * pane のエージェントプロセス生存判定。判定不能(tmux エラー等)は true(=保護、安全側)。
 * pane_current_command がシェル名なら claude/codex プロセスは終了している。
 */
export async function agentProcessAlive(
  runner: TmuxCommandRunner,
  name: string,
  metadataStore: SessionMetadataStore,
): Promise<boolean> {
  const target = metadataStore.get(name)?.tmuxPaneId ?? name;
  try {
    const result = await runner(["display-message", "-p", "-t", target, "#{pane_current_command}"]);
    if (result.exitCode !== 0) return true;
    return paneCommandLooksLikeAgent(result.stdout);
  } catch {
    return true;
  }
}

/**
 * herdr 巡回の既定 ops。herdr メタが 1 つも無ければ null（herdr CLI を呼ばない）。
 * kill は pane close 相当（HerdrSessionManager.kill）。
 */
function defaultHerdrReaperOps(metadataStore: SessionMetadataStore): HerdrReaperOps | null {
  if (!metadataStore.all().some((meta) => meta.backend === "herdr")) return null;
  return new HerdrSessionManager({ store: metadataStore });
}

/** 既定の claude 会話タイトル導出（明示タイトル優先 → 最初のユーザー発話, 一覧と同じ規則）。 */
function defaultDeriveClaudeTitle(claudeSessionId: string): string | null {
  const transcript = new ClaudeSessionStore().transcriptPath(claudeSessionId);
  if (transcript === null) return null;
  return transcriptTitle(transcript);
}

/** 巡回 1 回分。判定表は docs/architecture.md「セッション自動掃除」を参照。 */
export async function reaperTick(options: ReaperTickOptions): Promise<ReaperTickResult> {
  const { runner, heartbeatDir, metadataStore, timeoutSeconds, now } = options;
  const prewarmStore = options.prewarmStore === undefined ? new PrewarmStore() : options.prewarmStore;
  const log = options.log ?? (() => {});
  // 生存一覧の取得より前に回収候補を固定する。tmux / herdr の列挙やタイトル同期を await する間に
  // 始まった会話は、この tick の一覧には載らない。後から heartbeat を列挙すると、その新規会話まで
  // 消滅扱いして Hub のログ購読・ライブビュー・turn 接続を破棄してしまう。
  const heartbeatsAtStart = new Map(listHeartbeatSessions(heartbeatDir).map((name) =>
    [name, JSON.stringify(readHeartbeat(heartbeatDir, name))] as const));
  // 「tmux が答えられなかった」tick（サーバ不在以外の失敗: socket ファイルが無い・権限・タイムアウト等）では、
  // tmux の会話の回収だけを見送り、herdr の巡回は続ける（herdrUnavailable と対称）。以前は tick ごと投げて、
  // herdr の回収・空 server の停止・タブ名の同期まで止まっていた（実ログ 2026-08-05 に約 8 分）。
  let live: string[] = [];
  let tmuxUnavailable = false;
  try {
    live = await liveTailiiSessions(runner);
  } catch (error) {
    tmuxUnavailable = true;
    const hint = String(error).includes("No such file or directory")
      ? "（tmux の socket ファイルが見つからない。tmux サーバが動いていれば、サーバのプロセスへ SIGUSR1 を送ると作り直せる）"
      : "";
    log(`tmux 生存判定に失敗(tmux セッションの回収を延期): ${String(error)}${hint}`);
  }
  const attached = live.length > 0 ? await attachedSessions(runner) : new Set<string>();
  const killed: string[] = [];
  const demoted: string[] = [];
  const reclaimed: string[] = [];
  let localServersPromise: Promise<LocalServerProcesses | null> | null = null;
  let localServerUnavailableLogged = false;

  /** 同一 tick では lsof 結果を全セッションで共有する。検出失敗は null にして回収を延期。 */
  const localServers = (): Promise<LocalServerProcesses | null> => {
    if (localServersPromise === null) {
      localServersPromise = (options.listLocalServers?.() ?? Promise.resolve({ servers: [], parents: new Map() }))
        .catch((error: unknown) => {
          log(`local server 検出失敗(回収を延期): ${String(error)}`);
          localServerUnavailableLogged = true;
          return null;
        });
    }
    return localServersPromise;
  };

  const claudeSessionsDir =
    options.claudeSessionsDir !== undefined ? options.claudeSessionsDir : defaultClaudeSessionsDir();

  /**
   * timeout 超過の claude セッションを生かす理由（無ければ null）。
   *   - working-<status>: Claude の状態ファイルが仕事中（背景サブエージェント=busy / 背景シェル=shell /
   *     承認待ち=waiting）。完了通知に依存しない生の申告。status が 24h 変わらなければ保護しない。
   *   - scheduled: Stop 時点の予約（/loop・ScheduleWakeup・CronCreate）が未発火で、プロセスが生きている。
   */
  const claudeKeepAliveReason = async (
    name: string,
    heartbeat: Heartbeat,
    agentAlive: () => Promise<boolean>,
    claudeMatch: { paneProcessIds?: () => Promise<number[] | null>; useSessionId: boolean },
  ): Promise<string | null> => {
    const processAlive = options.claudeProcessAlive ?? claudeProcessAlive;
    let records: ClaudeLiveRecord[] = [];
    if (claudeSessionsDir !== null) {
      const meta = metadataStore.get(name);
      const claudeSessionId = claudeMatch.useSessionId ? meta?.providerSessionId ?? meta?.claudeSessionId : undefined;
      try {
        records = await findClaudeLiveRecords({
          dir: claudeSessionsDir,
          sessionName: name,
          ...(claudeMatch.paneProcessIds !== undefined ? { paneProcessIds: claudeMatch.paneProcessIds } : {}),
          ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
          processAlive,
        });
      } catch (error) {
        log(`claude 状態ファイル読取失敗(保護なしで継続): ${name}: ${String(error)}`);
      }
      for (const record of records) {
        if (!isClaudeWorking(record.status) || record.statusSinceMs === null) continue;
        // 時計の巻き戻り等で未来の時刻になっていたら上限を判定できないので信用しない。
        const age = now - record.statusSinceMs / 1_000;
        if (age > -300 && age < CLAUDE_WORKING_MAX_SECONDS) return `working-${record.status}`;
      }
    }
    const scheduled = heartbeat.scheduled;
    if (scheduled === undefined || !scheduledPending(scheduled, now)) return null;
    // 予約はそれを作ったプロセス内にしか無い。
    if (scheduled.pid !== undefined) {
      // 持ち主の pid が分かっていれば、その pid が（起動時刻まで一致して）生きていて pane にも
      // エージェントがいることを直接確かめる（状態ファイルの照合が外れても古い予約で新しい
      // プロセスを守らない）。
      if (records.some((record) => record.pid === scheduled.pid)) return "scheduled";
      const ownRecord = claudeSessionsDir !== null ? readClaudeLiveRecordOf(claudeSessionsDir, scheduled.pid) : null;
      const ownerAlive = await processAlive(scheduled.pid, ownRecord?.procStart ?? null);
      return ownerAlive && records.length === 0 && await agentAlive() ? "scheduled" : null;
    }
    // pid 不明（解決できなかった Stop）: session id で照合し、記録が無ければ pane の生存で代える。
    if (records.length > 0) {
      return records.some((record) => scheduled.sessionId === undefined || record.sessionId === scheduled.sessionId)
        ? "scheduled"
        : null;
    }
    return await agentAlive() ? "scheduled" : null;
  };

  /**
   * 1 セッション分の判定（tmux / herdr 共通）。heartbeat のルールは backend に依らない:
   * 未採番=adopt / attach 中=bump / claude active+alive=bump 代行 / active+dead=idle 降格 /
   * claude の背景作業・予約あり=bump / idle・codex active の timeout 超過=kill。
   */
  const judge = async (
    name: string,
    isAttached: boolean,
    agentAlive: () => Promise<boolean>,
    kill: () => Promise<void>,
    paneProcessIds: () => Promise<number[] | null>,
    claudeMatch: { paneProcessIds?: () => Promise<number[] | null>; useSessionId: boolean },
  ): Promise<void> => {
    // 先行起動（session-prewarm）のまま使われていない Claude は通常の計時に載せない。最後の
    // `session_prewarm` から期限を過ぎたら閉じる（送らずに離れた・アプリが落ちた等の取り残し）。
    // transcript があれば会話が始まっている（印の消し忘れ）ので、印だけ外して通常の規則へ戻す。
    // ターミナルから attach 中（人が見ている）なら閉じない（下の attach 保護と同じ扱い）。
    const prewarm = prewarmStore?.get(name) ?? null;
    if (prewarm !== null && prewarmStore != null) {
      const meta = metadataStore.get(name);
      if (meta !== null && claudeTranscriptExists(meta.cwd, prewarm.claudeSessionId)) {
        prewarmStore.remove(name);
      } else {
        if (isAttached || !prewarmExpired(prewarm, now)) return;
        // 閉じる直前に読み直す: その間に送信で採用された（記録が消えた）・再送で延びた会話は閉じない。
        // engine は期限の 2 分前から採用しないので、ここで期限切れのままなら採用とはすれ違わない。
        // 同じ先行起動（会話 id）のままのときだけ閉じる（読み直しの直後に engine がパラメータ変更で起動し直した
        // 新しい先行起動を閉じない）。
        const recheck = prewarmStore.get(name);
        if (recheck === null || recheck.claudeSessionId !== prewarm.claudeSessionId || !prewarmExpired(recheck, now)) {
          return;
        }
        await kill();
        prewarmStore.remove(name);
        removeHeartbeat(heartbeatDir, name);
        killed.push(name);
        log(`kill ${name} (prewarm unused ${now - prewarm.touchedAt}s)`);
        return;
      }
    }
    const heartbeat = readHeartbeat(heartbeatDir, name);
    if (heartbeat === null) {
      // 未採番(engine 再起動をまたいだ残骸等)。今を idle 起点として採番し次周期から計時。
      writeHeartbeat(heartbeatDir, name, { ts: now, state: "idle", event: "adopted" });
      log(`adopt ${name}`);
      return;
    }
    if (isAttached) {
      // ターミナルから attach 中 = 人間が使用中。hook/engine を経由しない利用でも殺さない。
      bumpHeartbeat(heartbeatDir, name, now, "daemon-client-attached");
      return;
    }
    const agent = metadataStore.get(name)?.agent ?? "claude";
    if (heartbeat.state === "active" && agent === "claude") {
      if (await agentAlive()) {
        // 処理中(ツール実行中は hook が沈黙する)。デーモンが ts を bump 代行して保護。
        bumpHeartbeat(heartbeatDir, name, now, "daemon-agent-alive", "active");
      } else {
        // active のままプロセスだけ死んだ(クラッシュ等)。idle へ倒して通常計時に載せる。
        // プロセスと一緒に予約（プロセス内にしか無い）も消えている。
        writeHeartbeat(heartbeatDir, name, { ts: now, state: "idle", event: "agent-process-dead", scheduled: null });
        demoted.push(name);
        log(`demote ${name} (agent process dead)`);
      }
      return;
    }
    // idle、および codex の active(bump 停止=ターン死亡)は一律 timeout で kill。
    if (now - heartbeat.ts < timeoutSeconds) return;
    // Stop hook は背景のサブエージェント・シェル・予約が残っていても発火して idle になる。
    // Claude 自身の申告（生の状態）と Stop 時点の予約を見て、背景作業ごと殺さない。
    if (agent === "claude") {
      const reason = await claudeKeepAliveReason(name, heartbeat, agentAlive, claudeMatch);
      if (reason !== null) {
        bumpHeartbeat(heartbeatDir, name, now, `daemon-claude-${reason}`);
        log(`protect ${name} (claude ${reason})`);
        return;
      }
    }
    // cwd 一致だけでは同じプロジェクトの全会話が延命されてしまう。pane の子孫または
    // 同じ制御端末のサーバーだけ保護する（別会話や別ターミナルのサーバーは無関係）。
    const servers = await localServers();
    // lsof 未導入・timeout 等を「サーバーなし」に倒すと、その瞬間に pane と server を
    // 破壊し得る。heartbeat は進めず次の 60 秒 tick で再検出する。
    if (servers === null) {
      if (!localServerUnavailableLogged) {
        log("local server 検出不能のため timeout セッション回収を延期");
        localServerUnavailableLogged = true;
      }
      return;
    }
    const candidates = servers.servers.filter((server) => !isAgentListener(server.command));
    if (candidates.length > 0) {
      const roots = await paneProcessIds().catch(() => null);
      const parents = servers.parents;
      // 親子関係・pane pid が取れないときは当該会話だけ延期し、heartbeat は進めない。
      if (parents === null || roots === null || roots.length === 0) {
        log(`local server 所有判定不能のため回収を延期: ${name}`);
        return;
      }
      const ownership = candidates.map((server) => ({
        server, owned: processBelongsToPane(server.pid, roots, parents, servers.terminals),
      }));
      const owned = ownership.find((entry) => entry.owned === true)?.server;
      if (owned !== undefined) {
        bumpHeartbeat(heartbeatDir, name, now, "daemon-local-server");
        log(`protect ${name} (local server pid=${owned.pid})`);
        return;
      }
      if (ownership.some((entry) => entry.owned === null)) {
        log(`local server 親子関係の途中欠落により回収を延期: ${name}`);
        return;
      }
    }
    // kill 直前に再読取して再判定する: tick 中に会話が再オープンされ engine が bump した
    // 直後のセッションを殺さない(読取→kill 間の競合窓を閉じる)。
    const recheck = readHeartbeat(heartbeatDir, name);
    if (recheck !== null && recheck.ts !== heartbeat.ts) return;
    await kill();
    removeHeartbeat(heartbeatDir, name);
    killed.push(name);
    log(`kill ${name} (state=${heartbeat.state} idle=${now - heartbeat.ts}s)`);
  };

  for (const name of live) {
    await judge(
      name,
      attached.has(name),
      () => agentProcessAlive(runner, name, metadataStore),
      async () => {
        const result = await runner(["kill-session", "-t", name]);
        if (result.exitCode !== 0) {
          log(`kill 失敗(掃除して継続): ${name}: ${result.stderr.trim()}`);
        }
      },
      async () => {
        const result = await runner(["list-panes", "-s", "-t", name, "-F", "#{pane_pid}"]);
        if (result.exitCode !== 0) return null;
        const pids = result.stdout.trim().split(/\s+/).map(Number);
        return pids.length > 0 && pids.every((pid) => Number.isInteger(pid) && pid > 0) ? pids : null;
      },
      // tmux 内の Claude は状態ファイルに `tmux` 欄（セッション名）を書くのでそれだけで照合する。
      // session id は同じ会話の複製インスタンス（Mac のターミナル等）と一致してしまうため使わない。
      { useSessionId: false },
    );
  }

  // --- herdr backend の巡回（tailii named session の pane）---
  // attach 保護は無し（herdr API にクライアント attach 情報が無い）。claude の
  // agent-alive bump 代行と heartbeat 計時は tmux と同一ルール。
  const herdrOps =
    options.herdrOps !== undefined ? options.herdrOps : defaultHerdrReaperOps(metadataStore);
  let herdrLive: string[] = [];
  // 「herdr が答えられなかった」tick では herdr セッションの回収を見送る（0 件と混同しない）。
  let herdrUnavailable = false;
  if (herdrOps !== null) {
    try {
      const listed = herdrOps.listLive !== undefined
        ? await herdrOps.listLive()
        : await herdrOps.list();
      if (listed === null) {
        herdrUnavailable = true;
        log("herdr 生存判定に失敗(回収を延期)");
      } else {
        herdrLive = listed
          .filter((info) => info.alive && TAILII_SESSION_PATTERN.test(info.name))
          .map((info) => info.name)
          .sort();
      }
    } catch (error) {
      herdrUnavailable = true;
      log(`herdr 生存判定に失敗(回収を延期): ${String(error)}`);
    }
    for (const name of herdrLive) {
      await judge(
        name,
        false,
        () => herdrOps.agentProcessAlive(name),
        async () => {
          try {
            await herdrOps.kill(name);
          } catch (error) {
            log(`kill 失敗(掃除して継続): ${name}: ${String(error)}`);
          }
        },
        async () => {
          const pid = await herdrOps.paneProcessId?.(name);
          return pid !== undefined && pid !== null ? [pid] : null;
        },
        // herdr は `tmux` 欄が無いので pane の前面 pid で照合し、取れないときだけ session id に頼る。
        {
          ...(herdrOps.agentProcessIds !== undefined
            ? { paneProcessIds: () => herdrOps.agentProcessIds!(name) }
            : {}),
          useSessionId: true,
        },
      );
    }
    // 生存 Tailii セッションが 0 なら空 server を回収する（tmux server の自動終了に対応）。
    // 判定は ops 側で pane 総数 0 のときだけ停止する（手動 pane があれば停止しない）。
    // 生存判定に失敗した tick は「0 件」ではないので停止を試みない。
    if (herdrLive.length === 0 && !herdrUnavailable) {
      await herdrOps.stopServerIfEmpty?.();
    }

    // --- 未命名タブへ会話タイトルを自動反映（session-title）---
    // タブラベルが未命名（null / 空 / セッション名 / 0.7.5 tab create の既定連番 "1"…）の
    // 生存セッションだけを対象に、Claude は transcript の会話タイトル（明示タイトル
    // custom-title/ai-title 優先）、Codex は session_index の正式名 thread_name をタブへ書く。
    // 命名済み（それ以外のラベル）は手動を優先して触らない。
    if (herdrLive.length > 0 &&
        herdrOps.tabInfoByName !== undefined && herdrOps.setDisplayTitle !== undefined) {
      const deriveClaudeTitle = options.deriveClaudeTitle ?? defaultDeriveClaudeTitle;
      let codexTitles: ReadonlyMap<string, string> | null = null;
      const deriveCodexTitle = options.deriveCodexTitle ?? ((threadId: string) => {
        // thread/list は会話が増えると 2 秒の時間制限を超えて全タブの同期が止まる。
        // 一覧と同じローカル索引から正式名だけ読み、古い生存会話も件数制限なく対象にする。
        codexTitles ??= new CodexSessionStore().providerTitles();
        return codexTitles.get(threadId) ?? null;
      });
      try {
        const tabInfo = await herdrOps.tabInfoByName();
        for (const name of herdrLive) {
          if (killed.includes(name)) continue;
          const meta = metadataStore.get(name);
          if (meta === null) continue;
          const agent = meta.agent ?? "claude";
          const providerSessionId =
            agent === "codex"
              ? meta.providerSessionId
              : meta.providerSessionId ?? meta.claudeSessionId;
          if (providerSessionId === undefined) continue;
          const info = tabInfo.get(name);
          if (info === undefined) continue;
          // 「ラベル==前回の自動適用値」も未命名扱い = ai-title の更新へ追随して再リネーム
          // する（追随しないと旧 ai-title がタブに固定され、iOS の逆方向取り込みが人為
          // リネームと誤認して override 化する）。
          const unnamed =
            info.label === null || info.label === "" || info.label === name ||
            isDefaultHerdrTabLabel(info.label) || info.label === meta.autoTabTitle;
          if (!unnamed) continue; // 命名済み（人為リネーム）は触らない
          let title: string | null;
          try {
            title =
              agent === "codex"
                ? await deriveCodexTitle(providerSessionId)
                : deriveClaudeTitle(providerSessionId);
          } catch (error) {
            log(`session-title 導出失敗(継続): ${name}: ${String(error)}`);
            continue;
          }
          if (title === null || title.length === 0) continue;
          if (info.label === title) {
            // ラベルは最新。自動適用の記録だけ追いつかせる（旧版からの移行時）。
            if (meta.autoTabTitle !== title) {
              try {
                metadataStore.put({ ...meta, autoTabTitle: title });
              } catch (error) {
                log(`session-title 記録失敗(継続): ${name}: ${String(error)}`);
              }
            }
            continue;
          }
          try {
            await herdrOps.setDisplayTitle(name, title);
            metadataStore.put({ ...meta, autoTabTitle: title });
            log(`session-title 自動反映: ${name} → ${title.slice(0, 30)}`);
          } catch (error) {
            log(`session-title 反映失敗(継続): ${name}: ${String(error)}`);
          }
        }
      } catch (error) {
        log(`session-title 巡回失敗(継続): ${String(error)}`);
      }
    }
  }

  // 生存セッションの無い heartbeat は残骸 → 掃除(メタデータ = cwd 権威記録は消さない)。
  // herdr 生存分も和に含める(含めないと herdr セッションの heartbeat を毎周期誤回収する)。
  const liveSet = new Set([...live, ...herdrLive]);
  for (const [name, initialHeartbeat] of heartbeatsAtStart) {
    if (!liveSet.has(name)) {
      // herdr の生存判定ができなかった tick では herdr backend のセッションを回収しない。
      // 一時的な CLI 失敗を「消滅」と誤判定すると、実行中の会話が retire され（queue 破棄・
      // 「Session disappeared」通知）、アプリ上は会話が消えたように見える。
      if (herdrUnavailable && metadataStore.get(name)?.backend === "herdr") continue;
      // 端末なしの会話（API 作業, api-agent）は pane を持たない。開いている間（hub の記録がある間）は
      // pane が無いことを「消滅」と読まない（読むと retire され、実行中のターンが止まる）。閉じた後に
      // 残った heartbeat は通常どおり回収する。
      if (metadataStore.get(name)?.executionRoute === "api" &&
        (options.apiAgentSessionOpen ?? defaultApiAgentSessionOpen)(name)) continue;
      // tmux の生存判定ができなかった tick では、herdr と分かっている会話以外（tmux・backend 不明）を回収しない。
      // socket ファイルだけが消えてサーバは動いている場合に、生きている会話を retire して送信待ちを捨てない。
      if (tmuxUnavailable && metadataStore.get(name)?.backend !== "herdr") continue;
      // 既存の名前でも巡回中に再開・更新されたものは次 tick の生存一覧で確認する。
      // ts だけでは同じ秒の state / event 更新を見落とすため、読んだ記録全体で照合する。
      if (JSON.stringify(readHeartbeat(heartbeatDir, name)) !== initialHeartbeat) continue;
      removeHeartbeat(heartbeatDir, name);
      reclaimed.push(name);
      log(`reclaim ${name} (session absent from backend snapshot)`);
    }
  }

  // tmux が答えられなかった tick は「生存 0」ではない（hub の自然終了の条件に使われる）。
  // 期限を過ぎた先行起動の記録のうち、生きた会話が無いもの（起動に失敗した・利用者が閉じた）を消す。
  // 生きているものは上の巡回で閉じている。どちらかの backend が答えられなかった tick では見送る。
  if (prewarmStore != null && !tmuxUnavailable && !herdrUnavailable) {
    const liveNames = new Set([...live, ...herdrLive]);
    for (const name of prewarmStore.names()) {
      if (liveNames.has(name)) continue;
      const record = prewarmStore.get(name);
      if (record === null || prewarmExpired(record, now)) prewarmStore.remove(name);
    }
  }
  return { liveCount: live.length + herdrLive.length + (tmuxUnavailable ? 1 : 0), killed, demoted, reclaimed };
}
