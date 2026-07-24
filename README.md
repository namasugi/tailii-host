<p align="center">
  <img src="https://raw.githubusercontent.com/namasugi/tailii-host/main/assets/tailii-logo.png" alt="Tailii" width="480">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tailii-host"><img src="https://img.shields.io/npm/v/tailii-host" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license MIT"></a>
</p>

# tailii-host

Tailii is an iPhone app for controlling Claude Code and Codex sessions running on your own machine.

`tailii-host` は、Tailii iPhone アプリとホストマシン上の Claude Code / Codex セッションをつなぐホスト側ヘルパーです。ホスト側で `npx tailii-host setup` を実行してペアリングします。

## Requirements

- Node.js 20 以上
- macOS または Linux(開発・検証は macOS 中心)
- tmux(任意で herdr — セッション収容先をアプリ設定から herdr に切り替えられます)
- SSH サーバーが有効であること(macOS では「リモートログイン」を ON)
- `claude` CLI (Claude Code) がインストール済みでログイン済みであること(Codex を使う場合は `codex` CLI)
- Tailii iPhone アプリ

## Quick start

ホストマシンで次のコマンドを実行します。

```sh
npx tailii-host setup
```

表示された QR コードを Tailii アプリで読み取るか、表示されたコードをアプリに入力してペアリングします。

`setup` は、アプリが SSH 経由で実行するランチャー(`~/.local/bin/tailii-host`)を自動生成し、あわせて環境診断(tmux / claude CLI / SSH サーバー)を表示します。診断だけを再実行するには:

```sh
npx tailii-host doctor
```

## How it works

Tailii はサーバーレス構成で動作し、リレーサーバーは使いません。ホストへの到達性は自宅 LAN や Tailscale など、ユーザー自身のネットワーク環境で確保します。

接続は SSH が基本です。macOS ホストでは、これに加えて QUIC ゲートウェイ(Rust / quinn)を launchd に常駐させ、Wi-Fi ↔ モバイル回線の切り替えやスリープ復帰をまたいでも会話が切れない、mosh 的なトランスポートとして利用できます。QUIC が使えない環境では自動的に SSH へフォールバックします。ゲートウェイの prebuilt バイナリは optionalDependencies(`@tailii/quic-gw-darwin-arm64` / `@tailii/quic-gw-darwin-x64`)として配布され、`setup` が設置から常駐化まで行います。

承認フローでは Claude Code の PreToolUse hook を使い、ツール実行を一時停止して構造化イベントを iPhone に転送します。ユーザーは iPhone アプリ上でネイティブに承認または拒否できます。セッションは tmux(または herdr)により維持されるため、接続が切れても継続できます。

接続中の出来事は iPhone 側のローカル通知で知らせます。バックグラウンド push 通知は現在準備中の実験的機能で、既定では無効です(ホスト側に APNs 設定が無い場合、送信は行われません)。

実行エンジンは、サブスクリプション認証済みの対話型 `claude` CLI(および `codex` CLI)です。Agent SDK やヘッドレス実行は使いません。

## Commands

- `setup`: メインのユーザー向けコマンドです。ホストと Tailii iPhone アプリをペアリングします。
- `doctor`: 環境診断(tmux / claude CLI / SSH サーバー / ランチャー)を実行します。
- `engine`: Tailii が利用する実行エンジン関連の処理を行います。
- `serve`: ホスト側のローカルサーバーを起動します。
- `hook`: Claude Code の hook から呼び出され、承認イベントを処理します。
- `launch`: 端末バックエンド(tmux 既定 / herdr 任意)上にセッションを起動します。
- `kick`: セッションやホスト側処理を再開・通知するために使われます。
- `push-token`: iPhone アプリのプッシュ通知トークンを登録します。
- `hub`: 会話状態・出力配信・入力調停とアイドルなセッション(tmux / herdr)の自動掃除を担う常駐デーモンです。engine 起動時や hook から自動起動されるため、通常は手動実行不要です。
- `quic-info`: QUIC ゲートウェイの接続情報(ポート・証明書ピン・トークン)を出力します。アプリが SSH 経由で取得するために使う内部コマンドです。

## License

MIT
