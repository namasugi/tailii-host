#!/usr/bin/env node
// set-version.mjs — リリース版番号を全パッケージへ一括反映する。
//
//   node scripts/set-version.mjs 0.1.2
//
// 更新対象（3つを常に一致させる。ずれると optionalDependencies が解決できず prebuilt が
// 配布されない）:
//   1. host-ts/package.json の version
//   2. host-ts/package.json の optionalDependencies["@tailii/quic-gw-darwin-*"] のピン
//   3. quic-gw/npm/darwin-{arm64,x64}/package.json の version
//
// 実行後は `npm install --package-lock-only` で lockfile を追従させてからコミット/タグする。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <semver>  (例: 0.1.2)");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.join(here, "..");

const PLATFORM_PACKAGES = [
  "@tailii/quic-gw-darwin-arm64",
  "@tailii/quic-gw-darwin-x64",
];
const PLATFORM_DIRS = ["darwin-arm64", "darwin-x64"];

// 1) + 2) main package。
const mainPath = path.join(hostRoot, "package.json");
const main = JSON.parse(fs.readFileSync(mainPath, "utf8"));
main.version = version;
main.optionalDependencies ??= {};
for (const name of PLATFORM_PACKAGES) {
  main.optionalDependencies[name] = version;
}
fs.writeFileSync(mainPath, JSON.stringify(main, null, 2) + "\n");
console.log(`tailii-host -> ${version} (+ optionalDependencies pins)`);

// 3) platform packages。
for (const dir of PLATFORM_DIRS) {
  const pkgPath = path.join(hostRoot, "quic-gw", "npm", dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`@tailii/quic-gw-${dir} -> ${version}`);
}

console.log("\n次: npm install --package-lock-only && git commit && git tag v" + version);
