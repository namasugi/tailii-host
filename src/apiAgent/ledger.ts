// apiAgent/ledger.ts
// API 作業の利用額の台帳（会話ごと）。`~/.tailii/api-agent/ledger/<会話id>.json`（0600）。
//
// - 1 ターン = 1 行。ターンを始める前に `running` で書き、結果を受け取ったら概算額で `done` にする。
//   結果を受け取れなかったターン（作業プロセスの異常終了・hub の再起動）は `unconfirmed`（利用額未確認）。
//   推測で 0 円や上限額を足さない（既存の API 画面と同じ扱い）。
// - SDK の `total_cost_usd` は再開した会話では以前の分も含む累計（実測 2026-11-11）。基準は会話の
//   JSONL に SDK が書く `cost-state` 行の最後の `totalCostUSD`（中断・予算到達でも書かれる、実測）。
//   ターンの額 = 結果の累計 − 開始前の基準。累計が基準より小さい（/clear 等で数え直し）ときは結果の値そのもの。
// - キー・本文は書かない。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isConversationUuid } from "./workerProtocol.js";

export type ApiAgentTurnStatus = "running" | "done" | "unconfirmed";

export interface ApiAgentLedgerTurn {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: ApiAgentTurnStatus;
  /** 概算額（USD）。done のときだけ。 */
  costUsd?: number;
  /** SDK の結果の種類（success / error_max_budget_usd / error_during_execution など）。 */
  subtype?: string;
}

export interface ApiAgentLedger {
  conversationId: string;
  turns: ApiAgentLedgerTurn[];
  /** 古いターンを畳んだ分（行数の上限を超えたとき）。 */
  foldedUsd: number;
  foldedTurns: number;
  foldedUnconfirmed: number;
  /**
   * 最後に使った実行経路（引き継ぎ / 元へ戻す）。一覧からの開き直しはこれに従う。"terminal" に戻した会話は
   * 今までどおり端末で開く（台帳＝利用額の記録は消さない）。旧形式（欄なし）は "api"。
   */
  route?: "api" | "terminal";
}

export interface ApiAgentUsageSummary {
  totalUsd: number;
  turns: number;
  unconfirmedTurns: number;
  lastTurnUsd?: number;
}

const MAX_TURN_ROWS = 200;

export function defaultApiAgentLedgerDir(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "api-agent", "ledger");
}

export function emptyLedger(conversationId: string): ApiAgentLedger {
  return { conversationId, turns: [], foldedUsd: 0, foldedTurns: 0, foldedUnconfirmed: 0 };
}

export function summarizeLedger(ledger: ApiAgentLedger): ApiAgentUsageSummary {
  let total = ledger.foldedUsd;
  let unconfirmed = ledger.foldedUnconfirmed;
  let last: number | undefined;
  for (const turn of ledger.turns) {
    if (turn.status === "done" && turn.costUsd !== undefined) { total += turn.costUsd; last = turn.costUsd; }
    else if (turn.status === "unconfirmed") unconfirmed += 1;
  }
  return {
    totalUsd: roundUsd(total),
    turns: ledger.foldedTurns + ledger.turns.length,
    unconfirmedTurns: unconfirmed,
    ...(last !== undefined ? { lastTurnUsd: roundUsd(last) } : {}),
  };
}

export function roundUsd(value: number): number { return Math.round(value * 1e6) / 1e6; }

/** ターンの額（USD）。基準不明（null）は結果の累計をそのまま使う。 */
export function turnCostFromCumulative(totalCostUsd: number, baselineUsd: number | null): number {
  if (baselineUsd === null || totalCostUsd + 1e-9 < baselineUsd) return Math.max(0, roundUsd(totalCostUsd));
  return Math.max(0, roundUsd(totalCostUsd - baselineUsd));
}

/**
 * JSONL の最後の `cost-state` の `totalCostUSD`（SDK が書く会話の累計）。無ければ 0、読めなければ null。
 * 末尾から最大 8MiB だけ読む（`cost-state` はターンの最後に書かれる）。
 */
export function readTranscriptCostBaseline(transcriptPath: string, tailBytes = 8 * 1024 * 1024): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (!line.includes("\"cost-state\"")) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record["type"] === "cost-state" && typeof record["totalCostUSD"] === "number" && Number.isFinite(record["totalCostUSD"])) {
          return record["totalCostUSD"];
        }
      } catch {
        // 途中で切れた先頭行など。
      }
    }
    return 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class ApiAgentLedgerStore {
  constructor(readonly directory: string = defaultApiAgentLedgerDir()) {}

  private fileFor(conversationId: string): string {
    if (!isConversationUuid(conversationId)) throw new Error("invalid conversation id");
    return path.join(this.directory, `${conversationId.toLowerCase()}.json`);
  }

  /** この会話に API 作業の台帳があるか（api-agent）。 */
  exists(conversationId: string): boolean {
    if (!isConversationUuid(conversationId)) return false;
    try { return fs.statSync(this.fileFor(conversationId)).isFile(); } catch { return false; }
  }

  /** 最後に使った実行経路。台帳が無ければ null（API 作業を使ったことが無い会話）。 */
  routeOf(conversationId: string): "api" | "terminal" | null {
    if (!this.exists(conversationId)) return null;
    return this.load(conversationId).route ?? "api";
  }

  /** 最後に使った実行経路を記録する。"terminal" は台帳がある会話だけ書く（API を使っていない会話に台帳を作らない）。 */
  setRoute(conversationId: string, route: "api" | "terminal"): void {
    if (route === "terminal" && !this.exists(conversationId)) return;
    const ledger = this.load(conversationId);
    if (ledger.route === route || (route === "api" && ledger.route === undefined && this.exists(conversationId))) return;
    ledger.route = route;
    this.save(ledger);
  }

  /** 読む。前回のプロセスが `running` のまま残したターンは利用額未確認へ移す。 */
  load(conversationId: string): ApiAgentLedger {
    let ledger = emptyLedger(conversationId);
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(conversationId), "utf8")) as unknown;
      ledger = decodeLedger(raw, conversationId) ?? ledger;
    } catch {
      // 無い・壊れている → 空。
    }
    return ledger;
  }

  /** 前回のプロセスが残した `running` を `unconfirmed` にする（hub 起動後に一度だけ）。 */
  settleOrphans(ledger: ApiAgentLedger, now: number): boolean {
    let changed = false;
    for (const turn of ledger.turns) {
      if (turn.status === "running") { turn.status = "unconfirmed"; turn.finishedAt = now; changed = true; }
    }
    return changed;
  }

  save(ledger: ApiAgentLedger): void {
    fold(ledger);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.fileFor(ledger.conversationId);
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
}

function fold(ledger: ApiAgentLedger): void {
  while (ledger.turns.length > MAX_TURN_ROWS) {
    const oldest = ledger.turns[0]!;
    if (oldest.status === "running") break;
    ledger.turns.shift();
    ledger.foldedTurns += 1;
    if (oldest.status === "done" && oldest.costUsd !== undefined) ledger.foldedUsd = roundUsd(ledger.foldedUsd + oldest.costUsd);
    else ledger.foldedUnconfirmed += 1;
  }
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function decodeLedger(raw: unknown, conversationId: string): ApiAgentLedger | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj["conversationId"] !== conversationId || !Array.isArray(obj["turns"])) return null;
  const turns: ApiAgentLedgerTurn[] = [];
  for (const item of obj["turns"]) {
    if (typeof item !== "object" || item === null) continue;
    const turn = item as Record<string, unknown>;
    const status = turn["status"];
    if (typeof turn["id"] !== "string" || typeof turn["startedAt"] !== "number" ||
      (status !== "running" && status !== "done" && status !== "unconfirmed")) continue;
    turns.push({
      id: turn["id"], startedAt: turn["startedAt"], status,
      ...(typeof turn["finishedAt"] === "number" ? { finishedAt: turn["finishedAt"] } : {}),
      ...(status === "done" && typeof turn["costUsd"] === "number" && Number.isFinite(turn["costUsd"]) && turn["costUsd"] >= 0
        ? { costUsd: turn["costUsd"] } : {}),
      ...(typeof turn["subtype"] === "string" ? { subtype: turn["subtype"] } : {}),
    });
  }
  return {
    conversationId, turns,
    foldedUsd: nonNegative(obj["foldedUsd"]),
    foldedTurns: Math.floor(nonNegative(obj["foldedTurns"])),
    foldedUnconfirmed: Math.floor(nonNegative(obj["foldedUnconfirmed"])),
    ...(obj["route"] === "api" || obj["route"] === "terminal" ? { route: obj["route"] } : {}),
  };
}
