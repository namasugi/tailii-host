# リリース手順（tailii-host + QUIC ゲートウェイ prebuilt）

QUIC ゲートウェイ（`tailii-quic-gw`）は Rust バイナリのため、macOS の 2 アーキテクチャ用
prebuilt を platform package（`@tailii/quic-gw-darwin-arm64` / `-x64`）として配布する。
`tailii-host` の `optionalDependencies` に入れてあり、npm が実行環境に一致する 1 つだけを
自動インストールする。`resolveQuicGatewayBinary()` がそれを解決する（無ければ cargo /
PATH フォールバック）。

## 第三者ライセンス表記（THIRD-PARTY-LICENSES.yml）

prebuilt は全 crate を静的リンクしたバイナリの再頒布なので、第三者ライセンス表記の同梱が
必要。正本は `quic-gw/THIRD-PARTY-LICENSES.yml`（git 管理）で、`stage-prebuilt.mjs` が
各 platform package へコピーし `files` で npm に同梱される。

**Rust 依存を追加・更新したら再生成する**（`cargo install cargo-bundle-licenses` が前提）:

```sh
cd quic-gw
cargo bundle-licenses --format yaml --output THIRD-PARTY-LICENSES.yml --previous THIRD-PARTY-LICENSES.yml
```

`--previous` は手動で補った本文を引き継ぐ。crate がライセンス本文を同梱していないと
`text: NOT FOUND` が残るので、**再生成後は `grep "NOT FOUND"` で確認し、あれば本文を手で
補ってからコミットする**（過去の該当: yasna / r-efi — MIT 本文を補い、他の選択肢は
「MIT で利用」の注記にした）。

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

`bin/tailii-quic-gw` と各 package へコピーされた `THIRD-PARTY-LICENSES.yml` はビルド成果物の
ため git 管理しない（`.gitignore`。ライセンスの正本は `quic-gw/` 直下のみコミット）。
npm publish は `files: ["bin", "THIRD-PARTY-LICENSES.yml"]` によりディスク上の成果物を同梱する。
