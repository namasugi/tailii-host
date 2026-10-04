// listMemoFile.ts
// tailii (TS host) — 会話一覧の読み取りメモをディスクへ保存し、次の engine へ引き継ぐ（session-list-memo-persist）。
//
// engine は接続ごとの別プロセスなので、プロセス内のメモ（ClaudeSessionStore.infoMemo /
// CodexSessionStore.rolloutMemo）は接続のたびに空から始まり、接続直後の 1 回目の一覧は
// 全 transcript / rollout を同期で読み直していた（数百件で 3〜4 秒、その間 engine 全体が止まる）。
// メモをファイルへ書き出し、次の engine の最初の一覧で読み戻す。照合は従来どおりファイルごとの
// mtimeMs + size なので、変わったファイルだけ読み直される。
//
// 導出規則（注入 reminder の除去・プレビュー整形など）は host の版で変わるため、保存時の
// 指紋（package version + このモジュールの mtime）が違えば丸ごと捨てる。版を上げない dev の
// 再ビルドも tsc が全ファイルを出力し直すので mtime で捨てられる。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageVersion } from "../shared/version.js";

/** 保存形式の版（形式そのものを変えたら上げる）。 */
const FORMAT = 1;
/** 書き出し途中で engine が止まって残った一時ファイルを掃除するまでの猶予。 */
const STALE_TMP_MS = 60_000;

/** 既定の保存先ディレクトリ（`~/.tailii/cache`）。 */
export function defaultListMemoDir(): string {
  return path.join(os.homedir(), ".tailii", "cache");
}

/** 導出規則の指紋（host の版 + このモジュールの mtime）。 */
export function listMemoFingerprint(): string {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    // 取れなければ版だけで照合する。
  }
  return `${readPackageVersion() ?? "unknown"}|${mtimeMs}`;
}

interface MemoFileContent {
  format: number;
  fingerprint: string;
  /** メモ対象のルート（別ルートの一覧のメモを取り違えない）。 */
  root: string;
  entries: Record<string, unknown>;
}

/**
 * メモ 1 種類分の保存ファイル。読めない・壊れている・指紋や root が違うときは空として扱い、
 * 書き出しの失敗は握り潰す（一覧そのものは失敗させない。次回また全件読むだけ）。
 */
export class ListMemoFile {
  private readonly fingerprint: string;

  constructor(
    private readonly filePath: string,
    private readonly root: string,
    fingerprint: string = listMemoFingerprint(),
  ) {
    this.fingerprint = fingerprint;
  }

  /** 保存済みのエントリ（key = 対象ファイルのパス）。`isEntry` を満たさない値は捨てる。 */
  load<T>(isEntry: (value: unknown) => value is T): Map<string, T> {
    this.removeStaleTempFiles();
    const result = new Map<string, T>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return result;
    }
    if (typeof parsed !== "object" || parsed === null) return result;
    const content = parsed as Partial<MemoFileContent>;
    if (content.format !== FORMAT || content.fingerprint !== this.fingerprint || content.root !== this.root) {
      return result;
    }
    const entries = content.entries;
    if (typeof entries !== "object" || entries === null) return result;
    for (const [key, value] of Object.entries(entries)) {
      if (isEntry(value)) result.set(key, value);
    }
    return result;
  }

  /**
   * エントリを丸ごと書き出す。複数の engine（端末ごと）が同時に書きうるので、一時ファイルは
   * プロセスごとに分けて rename で置き換える（最後に書いた方が残る。照合は mtime + size なので
   * どちらが残っても誤った行は出ない）。
   */
  save(entries: Iterable<[string, unknown]>): void {
    const content: MemoFileContent = {
      format: FORMAT,
      fingerprint: this.fingerprint,
      root: this.root,
      entries: Object.fromEntries(entries),
    };
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      // 中身は会話のタイトル・最後の発話の抜粋・cwd（元の transcript と同じく本人だけが読める権限で置く）。
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 消せなくても一覧には影響しない。
      }
    }
  }

  /** 書き出しの途中で止まった engine の一時ファイル（`<名前>.<pid>.<乱数>.tmp`）を消す。 */
  private removeStaleTempFiles(): void {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const tmp = path.join(dir, name);
      try {
        // 他の engine が今まさに書いている一時ファイルは消さない。
        if (now - fs.statSync(tmp).mtimeMs < STALE_TMP_MS) continue;
        fs.rmSync(tmp, { force: true });
      } catch {
        // 消せなくても一覧には影響しない。
      }
    }
  }
}
