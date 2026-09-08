// shared/clientBuild.ts — iOS クライアントのビルド番号の記録（host-auto-update）
//
// アプリは channel_hello に自分の `clientVersion`(CFBundleShortVersionString, 例 "1.0.0") と
// `clientBuild`(CFBundleVersion, 例 "4") を載せる。host はこのホストへ接続してきた
// 「最も新しいビルド番号」を ~/.tailii/host/client-build.json に記録し、次回以降の
// channel_hello で `latestClientBuild` として広告する。アプリは自分のビルド番号と比較し、
// より新しいビルドがこのホストを使った実績があれば「アプリを更新」を促す
// （TestFlight 配布ではマーケティング版 1.0.0 が据え置かれたままビルド番号だけ進むため、
// 版文字列ではなくビルド番号で判定する）。
//
// ビルド番号は Apple の規約どおり「ピリオド区切りの整数 1〜3 要素」だけを比較対象にする。
// それ以外（空・非数値）は記録も比較もしない（誤警報より沈黙）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClientBuildRecord {
  /** 記録時点で最も新しいビルド番号（CFBundleVersion）。 */
  latestClientBuild: string;
  /** そのビルドが名乗ったマーケティング版（表示用。比較には使わない）。 */
  clientVersion?: string;
  /** 記録した時刻（epoch ms）。 */
  tsMs: number;
}

/** 記録ファイルの既定パス（self-update の管理ルートと同じ ~/.tailii/host/ 配下）。 */
export function clientBuildRecordPath(): string {
  return path.join(os.homedir(), ".tailii", "host", "client-build.json");
}

/** "4" / "1.2.3" を整数タプルへ。Apple の CFBundleVersion 規約外は null。 */
export function parseBuildTuple(build: string): number[] | null {
  const parts = build.trim().split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,9}$/.test(part)) return null;
    numbers.push(Number.parseInt(part, 10));
  }
  return numbers;
}

/** ビルド番号の比較（欠けた要素は 0 とみなす）。どちらかが規約外なら null。 */
export function compareBuild(a: string, b: string): number | null {
  const left = parseBuildTuple(a);
  const right = parseBuildTuple(b);
  if (left === null || right === null) return null;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** 記録済みの最新クライアントビルドを読む（無い・壊れている・規約外は null）。 */
export function readLatestClientBuild(filePath: string = clientBuildRecordPath()): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<ClientBuildRecord>;
    if (typeof record.latestClientBuild !== "string") return null;
    return parseBuildTuple(record.latestClientBuild) === null ? null : record.latestClientBuild;
  } catch {
    return null;
  }
}

/**
 * hello で名乗られたクライアントビルドを記録する。既存より新しいときだけ書き換える
 * （古いビルドの接続で記録が後退しない = 「最も新しいビルド」の単調性）。
 * 記録は best-effort（失敗しても接続には影響させない）。
 * @returns 書き換えたら true。
 */
export function recordClientBuild(
  info: { clientBuild: string; clientVersion?: string },
  filePath: string = clientBuildRecordPath(),
  nowMs: number = Date.now(),
): boolean {
  if (parseBuildTuple(info.clientBuild) === null) return false;
  const current = readLatestClientBuild(filePath);
  if (current !== null && (compareBuild(info.clientBuild, current) ?? -1) <= 0) return false;
  const record: ClientBuildRecord = {
    latestClientBuild: info.clientBuild.trim(),
    ...(info.clientVersion !== undefined ? { clientVersion: info.clientVersion } : {}),
    tsMs: nowMs,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
