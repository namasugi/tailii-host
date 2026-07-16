# @tailii/quic-gw-darwin-\*

macOS 向け prebuilt `tailii-quic-gw` バイナリを配布する platform package 群
（[napi-rs](https://napi.rs/) / esbuild と同じパターン）。

- `@tailii/quic-gw-darwin-arm64` — Apple Silicon (arm64)
- `@tailii/quic-gw-darwin-x64` — Intel (x64)

各パッケージは `os` / `cpu` フィールドで対象を絞り込むため、npm は実行環境に一致する
1 つだけをインストールする。`tailii-host` の `optionalDependencies` に入っており、
`resolveQuicGatewayBinary()` が `@tailii/quic-gw-darwin-<arch>/bin/tailii-quic-gw` を解決する。

**手で編集しない。** `bin/tailii-quic-gw` は CI（`.github/workflows/release.yml`）が
`scripts/stage-prebuilt.mjs` 経由でビルド成果物から配置する。ローカルでの動作確認は
モノレポの `quic-gw/target/release/` からの cargo フォールバックが担う。

QUIC ゲートウェイ本体の設計・ワイヤー仕様は本体リポの `docs/quic-transport.md` を参照。
