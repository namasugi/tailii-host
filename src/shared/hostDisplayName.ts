// hostDisplayName.ts
// このホストの人間可読なマシン名（channel_hello の hostName）。
//
// iOS の接続先一覧が IP しか出せない問題への供給源。ユーザーが「マシン名」として
// 認識しているのは Finder / AirDrop に出る macOS の ComputerName（日本語可）なので、
// darwin では `scutil --get ComputerName` を第一候補にし、失敗時と他 OS は
// `os.hostname()` の `.local` 末尾を落として使う。
//
// 保存済みの名前は engine 起動時に即座に採用し、裏で取り直して次の接続へ引き継ぐ。失敗しても hello の
// hostName を省略するだけで機能劣化はない（iOS 側は従来どおり IP 表示へフォールバック）。

import * as os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDirectory0700 } from "./paths.js";

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
    cachedDefault ??= { value: resolveCachedHostDisplayName() };
    return cachedDefault.value;
  }
  return resolve(deps);
}

export interface HostDisplayNameCacheOptions {
  cachePath?: string;
  deps?: HostDisplayNameDeps;
  refresh?: () => Promise<string | undefined>;
}

/** キャッシュは小さな JSON を atomic rename で置き換え、途中終了・同時接続でも壊さない。 */
function saveName(cachePath: string, name: string): void {
  const temporary = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    ensureDirectory0700(path.dirname(cachePath));
    fs.writeFileSync(temporary, JSON.stringify({ format: 1, name }), { mode: 0o600 });
    fs.renameSync(temporary, cachePath);
  } catch { /* 保存できなくても hello 自体は通常どおり送る。 */ }
  finally { try { fs.unlinkSync(temporary); } catch { /* rename 済み・不在。 */ } }
}

/** プロセスをまたぐ表示名キャッシュ。初回・破損時だけ従来の同期解決へ戻る。 */
export function resolveCachedHostDisplayName(options: HostDisplayNameCacheOptions = {}): string | undefined {
  const cachePath = options.cachePath ?? path.join(os.homedir(), ".tailii", "cache", "host-display-name.json");
  const deps = options.deps ?? defaultDeps;
  let cached: string | undefined;
  try {
    if (fs.statSync(cachePath).size <= 4096) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { format?: unknown; name?: unknown };
      if (parsed.format === 1 && typeof parsed.name === "string" && parsed.name.trim().length > 0) cached = parsed.name.trim();
    }
  } catch { /* 不在・破損は同期解決で修復する。 */ }
  if (cached === undefined) {
    const name = resolve(deps);
    if (name !== undefined) saveName(cachePath, name);
    return name;
  }
  // 同期の scutil を再び呼ばない。更新結果は次の engine の hello から使う。
  void Promise.resolve().then(options.refresh ?? (() => resolveAsync(deps))).then((name) => {
    if (name !== undefined && name !== cached) saveName(cachePath, name);
  }).catch(() => {});
  return cached;
}

async function resolveAsync(deps: HostDisplayNameDeps): Promise<string | undefined> {
  if (deps.platform === "darwin") {
    const name = await new Promise<string | undefined>((resolve) => {
      execFile("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => {
        resolve(!error && stdout.trim().length > 0 ? stdout.trim() : undefined);
      });
    });
    if (name !== undefined) return name;
  }
  return resolve({ ...deps, platform: "linux" });
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
