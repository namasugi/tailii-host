// version.ts
// tailii host の package.json version と stale dist 判定。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function findPackageJson(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const PACKAGE_JSON_PATH = findPackageJson(path.dirname(fileURLToPath(import.meta.url)));

/** 現在の dist が属する package.json の version を読む。読めない場合は null。 */
export function readPackageVersion(): string | null {
  if (PACKAGE_JSON_PATH === null) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface StaleDistGuard {
  readonly startupVersion: string | null;
  readonly currentVersion: () => string | null;
}

/** 起動時 version を固定し、以後の接続時にディスク上の version と比較する。 */
export function createStaleDistGuard(
  currentVersion: () => string | null = readPackageVersion,
): StaleDistGuard {
  return {
    startupVersion: currentVersion(),
    currentVersion,
  };
}

/** package.json version が起動時から変わっていれば stale とみなす。 */
export function isStaleDist(guard: StaleDistGuard | null): boolean {
  if (guard === null || guard.startupVersion === null) return false;
  const current = guard.currentVersion();
  return current !== null && current !== guard.startupVersion;
}
