// reaper.ts
// tailii (TS host) — tmux セッション自動掃除の判定ロジック。
//
// engine 内蔵の idle reaper は「engine(=SSH 接続)が生きている間しか回らない」「tracker が
// in-memory で再起動時に空」という構造穴があった。Session Hub daemon は engine から独立した
// detached プロセスとして動き、heartbeat ファイル(heartbeat.ts)を唯一の判定権威にして
// `now - ts >= timeout`(一律 1800 秒)で kill する。
//
// state=active(処理中)の扱いはエージェントで異なる:
//   - claude: ターン中でも hook はツール実行中に沈黙する(長い1ツール呼びの間イベントが無い)
//     ため、pane のエージェントプロセス生存を確認できたら Hub が ts を bump 代行する。
//     プロセスが死んでいる(pane がシェルだけ)なら idle に書き換え → 30 分後に通常ルールで kill。
//   - codex: ターンは engine が駆動し engine と運命共同体。engine が 60 秒毎に bump するので、
//     bump が止まって timeout を超えた active は「死んだターン」→ そのまま kill してよい。
//     Hub は bump 代行しない(すると bump 停止=ターン死亡のシグナルが壊れる)。
//
// 対象は tailii が作る `cs-*` / `s-*` セッションのみ。ユーザーの他の tmux セッションには触れない。
// heartbeat 未採番の生存セッション(過去の残骸)は「今を idle」として採番し、次周期から計時する。
// 対象セッションが 0 になったら自然終了する(次の engine 接続 / hook 発火で ensure され再起動)。

import {
  bumpHeartbeat,
  listHeartbeatSessions,
  readHeartbeat,
  removeHeartbeat,
  writeHeartbeat,
} from "./heartbeat.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";
import { paneCommandLooksLikeAgent, type TmuxCommandRunner } from "./tmux.js";

/** 一律のアイドル timeout(秒)。idle/active(bump 停止)の両方に同じ値を使う。 */
export const REAPER_IDLE_TIMEOUT_SECONDS = 1800;

/** 巡回間隔(秒)。 */
export const REAPER_CHECK_INTERVAL_SECONDS = 60;

/** tailii が管理する tmux セッション名(これ以外は絶対に触らない)。 */
export const TAILII_SESSION_PATTERN = /^(cs|s)-/;

export interface ReaperTickOptions {
  runner: TmuxCommandRunner;
  heartbeatDir: string;
  metadataStore: SessionMetadataStore;
  timeoutSeconds: number;
  now: number;
  log?: (message: string) => void;
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
    const combined = (result.stdout + result.stderr).toLowerCase();
    if (combined.includes("no server running") || combined.includes("no sessions")) return [];
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

/** 巡回 1 回分。判定表は docs/architecture.md「セッション自動掃除」を参照。 */
export async function reaperTick(options: ReaperTickOptions): Promise<ReaperTickResult> {
  const { runner, heartbeatDir, metadataStore, timeoutSeconds, now } = options;
  const log = options.log ?? (() => {});
  const live = await liveTailiiSessions(runner);
  const attached = live.length > 0 ? await attachedSessions(runner) : new Set<string>();
  const killed: string[] = [];
  const demoted: string[] = [];
  const reclaimed: string[] = [];

  for (const name of live) {
    const heartbeat = readHeartbeat(heartbeatDir, name);
    if (heartbeat === null) {
      // 未採番(engine 再起動をまたいだ残骸等)。今を idle 起点として採番し次周期から計時。
      writeHeartbeat(heartbeatDir, name, { ts: now, state: "idle", event: "adopted" });
      log(`adopt ${name}`);
      continue;
    }
    if (attached.has(name)) {
      // ターミナルから attach 中 = 人間が使用中。hook/engine を経由しない利用でも殺さない。
      bumpHeartbeat(heartbeatDir, name, now, "daemon-client-attached");
      continue;
    }
    const agent = metadataStore.get(name)?.agent ?? "claude";
    if (heartbeat.state === "active" && agent === "claude") {
      if (await agentProcessAlive(runner, name, metadataStore)) {
        // 処理中(ツール実行中は hook が沈黙する)。デーモンが ts を bump 代行して保護。
        bumpHeartbeat(heartbeatDir, name, now, "daemon-agent-alive", "active");
      } else {
        // active のままプロセスだけ死んだ(クラッシュ等)。idle へ倒して通常計時に載せる。
        writeHeartbeat(heartbeatDir, name, { ts: now, state: "idle", event: "agent-process-dead" });
        demoted.push(name);
        log(`demote ${name} (agent process dead)`);
      }
      continue;
    }
    // idle、および codex の active(bump 停止=ターン死亡)は一律 timeout で kill。
    if (now - heartbeat.ts < timeoutSeconds) continue;
    // kill 直前に再読取して再判定する: tick 中に会話が再オープンされ engine が bump した
    // 直後のセッションを殺さない(読取→kill 間の競合窓を閉じる)。
    const recheck = readHeartbeat(heartbeatDir, name);
    if (recheck !== null && recheck.ts !== heartbeat.ts) continue;
    const result = await runner(["kill-session", "-t", name]);
    if (result.exitCode !== 0) {
      log(`kill 失敗(掃除して継続): ${name}: ${result.stderr.trim()}`);
    }
    removeHeartbeat(heartbeatDir, name);
    killed.push(name);
    log(`kill ${name} (state=${heartbeat.state} idle=${now - heartbeat.ts}s)`);
  }

  // 生存セッションの無い heartbeat は残骸 → 掃除(メタデータ = cwd 権威記録は消さない)。
  const liveSet = new Set(live);
  for (const name of listHeartbeatSessions(heartbeatDir)) {
    if (!liveSet.has(name)) {
      removeHeartbeat(heartbeatDir, name);
      reclaimed.push(name);
    }
  }

  return { liveCount: live.length, killed, demoted, reclaimed };
}
