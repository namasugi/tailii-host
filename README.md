# tailii-host

Tailii is an iPhone app for controlling Claude Code and Codex sessions running on your own Mac.

`tailii-host` は、Tailii iPhone アプリと Mac 上の Claude Code / Codex セッションをつなぐホスト側ヘルパーです。Mac 側で `npx tailii-host setup` を実行してペアリングします。

## Requirements

- Node.js 20 以上
- macOS
- tmux
- `claude` CLI (Claude Code) がインストール済みでログイン済みであること
- Tailii iPhone アプリ

## Quick start

Mac で次のコマンドを実行します。

```sh
npx tailii-host setup
```

表示された QR コードを Tailii アプリで読み取るか、表示されたコードをアプリに入力してペアリングします。

## How it works

Tailii はサーバーレス構成で動作し、リレーサーバーは使いません。Mac への到達性は自宅 LAN や Tailscale など、ユーザー自身のネットワーク環境で確保します。

承認フローでは Claude Code の PreToolUse hook を使い、ツール実行を一時停止して構造化イベントを iPhone に転送します。ユーザーは iPhone アプリ上でネイティブに承認または拒否できます。セッションは tmux により維持されるため、接続が切れても継続できます。バックグラウンド通知は Mac から APNs に直接送信されます。

実行エンジンは、サブスクリプション認証済みの対話型 `claude` CLI です。Agent SDK やヘッドレス実行は使いません。

## Commands

- `setup`: メインのユーザー向けコマンドです。Mac と Tailii iPhone アプリをペアリングします。
- `engine`: Tailii が利用する実行エンジン関連の処理を行います。
- `serve`: Mac 側ホストのローカルサーバーを起動します。
- `hook`: Claude Code の hook から呼び出され、承認イベントを処理します。
- `launch`: tmux-backed セッションを起動します。
- `kick`: セッションやホスト側処理を再開・通知するために使われます。
- `push-token`: iPhone アプリのプッシュ通知トークンを登録します。

## License

MIT
