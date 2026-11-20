# 送信待ちメッセージの状態

engine は `channel_hello.pendingMessageState: 1` でこの通知への対応を知らせる。
既存のメッセージの必須フィールドやプロトコル版は変わらない。

## `pending_message_state`（hub → engine → アプリ）

`session` と `clientMessageId` で発話を特定する。`kind` は `chat`（Claude と API 作業の
`chat_send`）または `codex`（`codex_turn_start` の `clientUserMessageId`）。

| `state` | hub の状態 |
| --- | --- |
| `held` | 注入・開始前のキューにあり、`pending_message_delete` で削除できる |
| `started` | 注入（起動待ちを含む）または turn 開始に入った。同時に届いた削除には `processing` を返す |
| `finished` | キューの監視を終了した。受理・失敗・削除・会話の終了のいずれでも、これまでの表示用の状態を捨てる |

受付または同じ ID の waiter 合流直後に drain を試み、発話がキューに残ったときに `held` を送る。
注入の見送りや開始前の受理記録の書き込み失敗でキューに戻したときも送る。通知はその発話の waiter の
client と、下記の照会を申し込んだ client に限る。受付のまま注入・開始する発話の waiter には通知しない。
削除要求を実際に処理するときは、hub が従来どおり現在の状態を確認する。

## 復元した Outbox の照会

`chat_receipt_query` に任意の `watchPendingMessage: true` を付けると、該当の発話がキューまたは
注入・開始中にある場合、hub は現在の `held` / `started` を `pending_message_state` として照会元に返す。
その通知は通常の `chat_receipt_query_result` の前に送る。以後も状態通知を同じ順序のストリームで届ける。
送信 RPC の waiter や入力 journal の項目は追加しない。配送不明・配送済み・削除済み・未知の ID の照会は、
従来の相関応答だけを返す。`watchPendingMessage` を省略した照会も従来どおり。

`finished` が届いたら表示用の状態だけを捨てる。配送不明の復元行が残っていれば「再送」で片付けられる。
Claude の先頭の配送不明行に対する従来の受領の照会は、履歴の再送が終わってから行う。
送信 RPC の応答待ちの行は `chat_send_result` で確定する。

engine と hub のリンクが切断したとき、engine は `pending_message_state_reset {available: false}` を送る。
hub の初回 hello と再接続の hello が成立したときは `available: true` を送る。
アプリは切断時に現在の表示用の状態を捨て、`available: true` で照会し直す。アプリと engine の切断・会話の切り替えでも
表示用の状態を捨てる。追加フィールドを知らない受信側はそのフィールドを無視し、追加メッセージを知らない
受信側は該当行を破棄できる。ゴールデンフィクスチャは
[chat-receipt-query-v1.ndjson](chat-receipt-query-v1.ndjson) と [forward-compat-v1.ndjson](forward-compat-v1.ndjson)。
