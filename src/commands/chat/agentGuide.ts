// commands/chat/agentGuide.ts
// `tailii-host agent-guide` が出す、AI エージェント（Bot）向けの使い方（tailii-chat-cli）。host に同梱するので版がずれない。

export const AGENT_GUIDE = `# tailii-host chat — AI エージェント向けの使い方

このホストの Tailii（iPhone から Claude Code を操作するアプリ）の会話を、コマンドで始める・続けを送る・結果を読む。
始めた会話は利用者の iPhone の Tailii にもそのまま出て、利用者が続きを引き取れる。

## 呼び方
- SSH なら絶対パスで: ssh <host> ~/.local/bin/tailii-host chat <動詞> ...
- Bot は必ず --json を付ける（付けないと、端末があるとき会話の画面を開いて戻らない）。
- 指示文は標準入力で渡す（コマンドラインに書かない。シェルを通って壊れる）。

## 動詞
- chat list [--live] --json
    会話の一覧。conversationId / agent / title / cwd / updatedAtMs / where（tailii=Tailii で動作中・elsewhere=Tailii の外で動作中・none=止まっている）。
- chat new --cwd <フォルダ> --request-id <ID> [--title <名前>] [--permission-mode default|acceptEdits|plan] --json  < 指示文
    新しい Claude の会話を始めて最初の指示を送る。指示が Claude に受け付けられた時点で返る（返答の完了は待たない）。
- chat send <conversationId> --request-id <ID> --json  < 指示文
    続きを送る。止まっていれば Tailii で続きから起動してから送る。他所（利用者の端末など）で動いていれば送らずに終了コード 4。
- chat status <conversationId> [--after <依頼ID>] [--wait <秒>] --json
    state（busy=処理中 / idle=待機 / not_running=止まっている）と reply（返答の文章）。--after でその依頼への返答だけを返す。
    --wait で処理が終わるまで最大その秒数（上限 100）待つ。complete=true なら返答は出そろっている。

## 依頼 ID（--request-id）
- new / send に必須。同じ依頼 ID で打ち直すと、同じ会話・同じ送信として扱われ二重にならない（時間切れのときは同じ ID で打ち直す）。
- 依頼ごとに新しい ID を使う（例: UUID）。

## 出力（--json）
- 標準出力に JSON 1 個: {"v":1,"ok":true,...} または {"v":1,"ok":false,"error":{"code","message","hint"}}。
- hint は次に打つべきコマンドや人に伝えること。

## 終了コード
- 0 成功（status が処理中でも 0。state を見る）
- 1 内部エラー
- 2 使い方の誤り・許可されていない作業フォルダ・指示文が空
- 3 会話が見つからない（chat list で確かめる）
- 4 他所で動いている（送っていない）。人に伝える
- 5 方針で不可
- 6 今はできない（起動中・送信の確定に失敗）。少し待って同じ依頼 ID で打ち直す
- 7 時間切れで状態不明。同じ依頼 ID で打ち直すか status で確かめる
- 127 tailii-host が無い（このホストに Tailii が入っていない）

## 守ること
- 作業フォルダは ~/.tailii/bot.json の allowedRoots（既定はホームの中）だけ。フォルダは自動で作らない。
- 許可モードの既定は acceptEdits（編集と読み取りは進み、それ以外のツールは利用者の承認が要る）。auto は利用者が bot.json で
  allowAuto を true にしたときだけ使える。承認が要る操作は、利用者が iPhone で答えるまで止まる。
- Tailii の会話への送信・状態の確認は必ずこのコマンドで行う。herdr / tmux へ直接キーを送らない（読むだけは可）。
- 他所で動いている会話を終了させて引き取る操作は、Bot には既定で許されていない。終了コード 4 なら人に伝える。
`;
