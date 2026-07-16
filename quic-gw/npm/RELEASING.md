# リリース手順（tailii-host + QUIC ゲートウェイ prebuilt）

QUIC ゲートウェイ（`tailii-quic-gw`）は Rust バイナリのため、macOS の 2 アーキテクチャ用
prebuilt を platform package（`@tailii/quic-gw-darwin-arm64` / `-x64`）として配布する。
`tailii-host` の `optionalDependencies` に入れてあり、npm が実行環境に一致する 1 つだけを
自動インストールする。`resolveQuicGatewayBinary()` がそれを解決する（無ければ cargo /
PATH フォールバック）。

## リリース

1. バージョンを一括更新（main version + optionalDependencies ピン + platform package）:

   ```sh
   node scripts/set-version.mjs 0.1.2
   npm install --package-lock-only   # lockfile を追従
   git commit -am "release: v0.1.2"
   git tag v0.1.2
   git push origin main --tags
   ```

2. タグ push で `.github/workflows/release.yml` が起動し:
   - 両 arch を `cargo build --release --target {aarch64,x86_64}-apple-darwin`
   - `scripts/stage-prebuilt.mjs` が platform package の `bin/` へ配置
   - `@tailii/quic-gw-darwin-*` → `tailii-host` の順に npm 公開（optionalDependencies が
     参照するため platform package を先に）

   前提: リポジトリ secrets `NPM_TOKEN`（`@tailii` スコープ + `tailii-host` の publish 権限）。

## ローカル確認

```sh
(cd quic-gw && cargo build --release --target aarch64-apple-darwin --target x86_64-apple-darwin)
node scripts/stage-prebuilt.mjs        # bin/ へ配置し version 同期
```

`bin/tailii-quic-gw` はビルド成果物のため git 管理しない（`.gitignore`）。npm publish は
`files: ["bin"]` によりディスク上の成果物を同梱する。
