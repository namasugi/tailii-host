// backgroundStopRecords.ts
// iPhone から止めた背景コマンドの記録（taskId → 最初の SIGTERM を送った時刻）。
//
// 外から止めたコマンドは CLI の完了通知が「失敗（exit 143 等）」になるが、利用者の停止なので完了として
// 出す（subagentTailer）。tail（ChatTailController / SubagentTailer）は会話を閉じると捨てられ、開き
// 直しで transcript を頭から読み直すので、記録は tail より長く生きる場所に置く。hub では
// `~/.tailii/host/background-command-stops.json` に書き、hub の再起動後も同じ見え方にする。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory0700 } from "../shared/paths.js";

export interface BackgroundStopRecords {
  get(taskId: string): number | null;
  set(taskId: string, atMs: number): void;
  delete(taskId: string): void;
}

/** 古い記録は捨てる（taskId は一意。会話の保持期間より十分長く）。 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

/** プロセス内だけの記録（テスト・ファイルを使わない構成）。tail を作り直しても残る。 */
export function memoryBackgroundStopRecords(): BackgroundStopRecords {
  const map = new Map<string, number>();
  return {
    get: (taskId) => map.get(taskId) ?? null,
    set: (taskId, atMs) => { map.set(taskId, atMs); },
    delete: (taskId) => { map.delete(taskId); },
  };
}

let processRecords: BackgroundStopRecords | null = null;

/** 既定（SubagentTailer の省略時）: プロセス内で共有する記録。 */
export function processBackgroundStopRecords(): BackgroundStopRecords {
  processRecords ??= memoryBackgroundStopRecords();
  return processRecords;
}

export function defaultBackgroundStopRecordsPath(): string {
  return path.join(os.homedir(), ".tailii", "host", "background-command-stops.json");
}

/** ファイルに書く記録（hub 用）。読めない・壊れたファイルは空として扱う（表示が失敗に戻るだけ）。 */
export function fileBackgroundStopRecords(
  filePath: string = defaultBackgroundStopRecordsPath(),
  nowMs: () => number = Date.now,
): BackgroundStopRecords {
  let map: Map<string, number> | null = null;
  const load = (): Map<string, number> => {
    if (map !== null) return map;
    map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (typeof raw === "object" && raw !== null) {
        for (const [taskId, atMs] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof atMs === "number" && Number.isFinite(atMs)) map.set(taskId, atMs);
        }
      }
    } catch {
      // 無い・壊れている → 空。
    }
    return map;
  };
  const save = (): void => {
    const current = load();
    const cutoff = nowMs() - MAX_AGE_MS;
    const kept = [...current.entries()]
      .filter(([, atMs]) => atMs >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    map = new Map(kept);
    try {
      ensureDirectory0700(path.dirname(filePath));
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch {
      // 書けなくてもプロセス内の記録は効く（hub 再起動後に失敗表示へ戻るだけ）。
    }
  };
  return {
    get: (taskId) => load().get(taskId) ?? null,
    set: (taskId, atMs) => {
      load().set(taskId, atMs);
      save();
    },
    delete: (taskId) => {
      if (load().delete(taskId)) save();
    },
  };
}
