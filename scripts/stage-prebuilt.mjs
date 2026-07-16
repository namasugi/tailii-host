#!/usr/bin/env node
// stage-prebuilt.mjs — cargo ビルド成果物を platform package の bin/ へ配置し、
// version を main package(tailii-host)に揃える。
//
// CI（.github/workflows/release.yml）から呼ぶが、ローカルでも実行して配置構造を検証できる:
//   node scripts/stage-prebuilt.mjs            # 両 arch を target/<triple>/release から配置
//   node scripts/stage-prebuilt.mjs arm64      # 指定 arch だけ配置
//
// 各 platform package の bin/tailii-quic-gw に実行ビットを立てて配置する。
// version は host-ts/package.json の version へ同期する（optionalDependencies と一致させる）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.join(here, "..");

const TARGETS = {
  arm64: { triple: "aarch64-apple-darwin", pkg: "darwin-arm64" },
  x64: { triple: "x86_64-apple-darwin", pkg: "darwin-x64" },
};

const version = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).version;

const requested = process.argv.slice(2);
const arches = requested.length > 0 ? requested : Object.keys(TARGETS);

for (const arch of arches) {
  const target = TARGETS[arch];
  if (target === undefined) {
    console.error(`unknown arch: ${arch} (expected: ${Object.keys(TARGETS).join(" | ")})`);
    process.exit(2);
  }
  const source = path.join(hostRoot, "quic-gw", "target", target.triple, "release", "tailii-quic-gw");
  if (!fs.existsSync(source)) {
    console.error(
      `missing build artifact: ${source}\n` +
        `  build it first: (cd quic-gw && cargo build --release --target ${target.triple})`,
    );
    process.exit(1);
  }
  const pkgDir = path.join(hostRoot, "quic-gw", "npm", target.pkg);
  const binDir = path.join(pkgDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, "tailii-quic-gw");
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);

  // version を main package に揃える。
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  pkgJson.version = version;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

  console.log(`staged @tailii/quic-gw-${target.pkg}@${version} <- ${target.triple}`);
}
