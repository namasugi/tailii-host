// hostDisplayName.ts
// このホストの人間可読なマシン名（channel_hello の hostName）。
//
// iOS の接続先一覧が IP しか出せない問題への供給源。ユーザーが「マシン名」として
// 認識しているのは Finder / AirDrop に出る macOS の ComputerName（日本語可）なので、
// darwin では `scutil --get ComputerName` を第一候補にし、失敗時と他 OS は
// `os.hostname()` の `.local` 末尾を落として使う。
//
// 解決は engine 起動時に一度だけ（プロセス内で不変とみなす）。失敗しても hello の
// hostName を省略するだけで機能劣化はない（iOS 側は従来どおり IP 表示へフォールバック）。

import * as os from "node:os";
import { execFileSync } from "node:child_process";

/** テスト注入用の依存（既定は実環境）。 */
export interface HostDisplayNameDeps {
  platform: NodeJS.Platform;
  hostname: () => string;
  scutilComputerName: () => string;
}

const defaultDeps: HostDisplayNameDeps = {
  platform: process.platform,
  hostname: os.hostname,
  scutilComputerName: () =>
    execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2_000 }),
};

/** 実環境解決の結果キャッシュ（プロセス内不変。scutil exec を engine 起動毎に繰り返さない）。 */
let cachedDefault: { value: string | undefined } | null = null;

/**
 * マシン名を解決する。空しか得られなければ undefined（hello から hostName を省略する）。
 * 引数省略（実環境）は初回のみ解決してキャッシュする。
 */
export function resolveHostDisplayName(deps?: HostDisplayNameDeps): string | undefined {
  if (deps === undefined) {
    cachedDefault ??= { value: resolve(defaultDeps) };
    return cachedDefault.value;
  }
  return resolve(deps);
}

function resolve(deps: HostDisplayNameDeps): string | undefined {
  if (deps.platform === "darwin") {
    try {
      const name = deps.scutilComputerName().trim();
      if (name.length > 0) return name;
    } catch {
      // scutil 不在/失敗は hostname へフォールバック
    }
  }
  try {
    const name = deps.hostname().trim().replace(/\.local$/i, "");
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}
