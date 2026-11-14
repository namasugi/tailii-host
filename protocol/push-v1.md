# push v1 — ワイヤー契約

設計の正本は [docs/push-notifications.md](../docs/push-notifications.md)。本書は host / iOS / リレーの 3 者が
別々に実装しても噛み合うように、**名前・符号化・値の範囲だけ**を固定する。ここに書いた名前と形は変えない。
変える必要が出たら実装を止めて管理者に戻す。

- golden: [push-v1.ndjson](push-v1.ndjson)(制御メッセージ)・[push-envelope-v1.json](push-envelope-v1.json)(暗号のテストベクタ)
- 定数: bundle id `com.namasugi.tailii` / Team ID `78D3QYXRJD` / App ID `78D3QYXRJD.com.namasugi.tailii`
- 符号化の呼び名: **b64u** = base64url・パディング無し。**b64** = 標準 base64(パディングあり)。**hex** = 小文字 16 進。

## 1. 制御メッセージ(iOS ⇄ host)

枠組み(NDJSON・`v`・`id` の付け方・未知フィールドの無視)は既存メッセージの流儀に合わせる。

| type | 向き | フィールド |
|---|---|---|
| `push_register` | iOS → host | `id`, `deviceId`(端末で生成して保持する UUID 文字列), `deviceName`, `deviceToken`(hex), `environment`(`production` \| `sandbox`), `bundleId`, `pushKey`(b64u・32 バイト), `relay?`(`{url, capability, expiresAt}`・`expiresAt` は epoch 秒), `prefs`(`{turnDone, question, approval, usageLimit, turnError, showBody}`・すべて bool) |
| `push_register_result` | host → iOS | `id`, `status`(`ok` \| `failed`), `transport`(`relay` \| `direct` \| `none`), `capabilityInvalid?`(true のときアプリは capability を取り直して再登録), `error?` |
| `push_unregister` | iOS → host | `id`, `deviceId` |
| `push_unregister_result` | host → iOS | `id`, `status`(`ok` \| `failed`) |
| `client_presence` | iOS → host | `deviceId`, `state`(`foreground` \| `background`)。応答なし |
| `presence_ping` | host → iOS | `id` |
| `presence_pong` | iOS → host | `id` |
| `channel_hello`(既存) | host → iOS | `push: 1` を足す。アプリはこれがある host にだけ `push_register` を送る |

決まり:

- アプリは **接続が成立するたび** に `client_presence` と `push_register` を送る(内容が前回と同じでも送る。host 側は冪等に上書き)。
- `relay` が無い `push_register` は正当(リレー未設定のビルド・シミュレータ)。host は `direct` を使えなければ `transport: "none"` を返す。
- `prefs` に無いキーは true 扱い(`showBody` も true)。
- host は `relay.url` が `https://` で始まらなければ `failed` を返す。

## 2. 暗号化した中身(host → 通知サービス拡張)

- 鍵: 32 バイト。鍵 id `k` = b64u(SHA-256(鍵) の先頭 8 バイト)。
- 方式: ChaCha20-Poly1305。nonce は 12 バイト乱数。AAD は UTF-8 の `tailii-push-v1:` + `k`。
- `tp` = `{"v":1, "k":<鍵 id>, "n":<b64u(nonce)>, "c":<b64u(暗号文 ‖ 16 バイトのタグ)>}`
- 平文は UTF-8 の JSON:

| キー | 型 | 内容 |
|---|---|---|
| `v` | number | 1 |
| `kind` | string | `turn_done` \| `question` \| `approval` \| `usage_limit` \| `turn_error` |
| `session` | string | セッション名(`s-…` / `cs-…`) |
| `title` | string | 通知の題名(会話タイトル。無ければ種別の定型文) |
| `body` | string | 通知の本文 |
| `id` | string? | 承認 id・設問 id など。無い種別は省略 |
| `ts` | number | epoch 秒 |
| `allow` | boolean? | 承認の通知(`kind: approval`)で、**`body` に操作の全体が省略なく入っているとき**だけ `true`。省略時は `false` として扱う(§6)。ほかの種別では付けない |

- `tp.c` は b64u で 3072 バイト以下。host は `body` を切り詰めて収める。
- host がどの接続先かは、アプリが「鍵 id → 接続先」を自分で引く(平文には入れない)。

## 3. APNs に載る形

リレー経路・直送経路とも同じ形にする。表示文言は固定で、呼び出し側からは指定できない。

```json
{
  "aps": {
    "alert": { "title": "Tailii", "body": "新しい通知があります" },
    "mutable-content": 1,
    "content-available": 1,
    "sound": "default",
    "interruption-level": "active"
  },
  "tp": { "v": 1, "k": "…", "n": "…", "c": "…" }
}
```

- ヘッダ: `apns-push-type: alert` / `apns-priority: 10` / `apns-topic: com.namasugi.tailii` / `apns-collapse-id`(64 バイト以下の ASCII)/ `apns-expiration`(**絶対時刻**の epoch 秒)。
- `content-available: 1` は通知を表示しつつアプリの背景起動を求める。起こすかは iOS 次第で、背景モードを持たない古い版のアプリは無視する。
- 通知サービス拡張は復号後、題名・本文・`threadIdentifier`(`k` + `:` + `session`)を書き込み、`userInfo` に `kind` / `session` / `id` / `k` を足す。復号できなければ何も書き換えない。

## 4. リレー API

すべて `POST`・`content-type: application/json`。失敗は `{"error": "<コード>"}`。
どの経路も、リレー内部の障害(保存先や秘密の取得失敗)では `503 unavailable` を返す(呼び出し側は 5xx として扱う)。

### `POST /v1/challenge`

- 入力: `{}`
- `200 {"challenge": "<不透明な文字列>", "expiresAt": <epoch 秒>}`(5 分有効・1 回の検証に使う)

### `POST /v1/installs`

- 入力: `{"keyId": <b64・DCAppAttestService が返す文字列そのまま>, "attestation": <b64>, "challenge": "…", "environment": "production" | "sandbox"}`
- アプリは `clientDataHash = SHA-256(UTF-8(challenge))` で `attestKey` を呼ぶ。
- `201 {"installId": "<不透明な文字列>"}`
- 失敗: `400 bad_request` / `401 invalid_challenge` / `401 invalid_attestation`

### `POST /v1/capabilities`

- 入力: `{"keyId": <b64>, "assertion": <b64>, "challenge": "…", "deviceToken": <hex>, "environment": "production" | "sandbox"}`
- アプリは `clientDataHash = SHA-256(UTF-8(challenge + "\n" + deviceToken + "\n" + environment))` で `generateAssertion` を呼ぶ。
- `200 {"capability": "<不透明な文字列>", "expiresAt": <epoch 秒>}`
- 失敗: `400 bad_request` / `401 invalid_challenge` / `401 invalid_assertion` / `404 unknown_install`(アプリは鍵を作り直して `/v1/installs` からやり直す)/ `409 environment_mismatch`

### `POST /v1/push`

- 入力: `{"capability": "…", "tp": {…}, "interruptionLevel": "active" | "time-sensitive" | "passive", "collapseId": "…", "expiration": <epoch 秒>}`
- `200 {"ok": true}`
- 失敗: `400 bad_request` / `401 invalid_capability`(期限切れを含む)/ `410 unregistered`(APNs が宛先を知らない)/ `413 payload_too_large` / `429 rate_limited` / `502 apns_error`(`{"error":"apns_error","status":<number>,"reason":"…"}`)

## 5. iOS の設定値

- リレーの URL はビルド設定 `PUSH_RELAY_URL`(Info.plist の `TailiiPushRelayURL`)。空ならリレー登録を飛ばし、`relay` 無しで `push_register` を送る。

## 6. 通知からの承認(v1.1)

承認の通知(`kind: approval`)に「許可」「拒否」のアクションを付け、アプリを開かずに回答できるようにする。
リレーが組み立てる `aps`(§3)は変えない。カテゴリは通知サービス拡張が復号後に設定する。

### カテゴリとアクション(iOS 内の識別子)

| カテゴリ | アクション | 付ける条件 |
|---|---|---|
| `tailii.approval` | `tailii.approval.allow`(許可・`authenticationRequired`)と `tailii.approval.deny`(拒否) | プッシュ通知で、`kind: approval`・平文の `allow` が `true`・端末の設定「通知に本文を出す」が ON、のすべてを満たすとき |
| `tailii.approval.denyOnly` | `tailii.approval.deny`(拒否)だけ | 上を満たさない承認の通知すべて(`allow` が無い・`false`、「通知に本文を出す」が OFF・設定を読めない、アプリ起動中に出すローカルの承認通知) |

**「許可」を付けてよいかは host が判定する**(`allow`)。通知の上で許可できるのは、利用者が通知の本文だけで、実行される操作の全体を確かめられる場合に限る。host は次のすべてを満たすときだけ `allow: true` にする:

- 対象はコマンドの実行(Bash)だけ。ファイルの書き込み・編集、ファイルの送信、外部ツールなど、通知の本文から中身が分からない操作は `false`。
- 本文に、**コマンドの全文と、実行する場所(作業ディレクトリ)**が入っている。本文の形は `Bash · <作業ディレクトリ> $ <コマンド>`(ホームディレクトリは `~` と書く)。作業ディレクトリが分からないときは `false`。
- コマンドは 1 行で、**表示できる ASCII 文字(0x20〜0x7E)だけ**から成る(見えない文字・紛らわしい文字・制御文字を含む場合は `false`。日本語のファイル名を含むコマンドも `false` になる)。
- 実行の仕方を変える指定が無い: サンドボックスを外す指定(`dangerouslyDisableSandbox`)・背景での実行(`run_in_background`)が有効なものは `false`。host が知らない入力の欄があるときも `false`(知っている欄は `command` `description` `timeout`。`description` と `timeout` は表示しないが、操作の内容を変えないので許す)。
- 本文を省略していない(作業ディレクトリとコマンドを合わせて 280 字以内)。暗号化の前後で `body` を切り詰めた場合も `false`。
- その端末の設定で本文を出す(`showBody`)。出さない端末には定型文を送るので `false`。

既知の制約: 通知(とアプリ内の承認の画面)に表示するのは、host の承認の hook が受け取った時点の入力である。同じ会話に、入力を書き換える別の hook(PreToolUse の `updatedInput`)が登録されている構成では、表示した内容と実際に実行される内容が一致することを host は保証できない。これは通知からの承認に固有の問題ではなく、アプリ内の承認と同じ条件である。

アプリは、表示する文字列から要約の有無を推測しない(`allow` だけを見る)。

どちらのアクションもアプリを前面に出さない。

### 流れ

0. その承認がアプリ内の承認の一覧にあり、その会話の承認チャネルがつながっているとき(アプリが前面のとき、背景に回って接続を保っている間)は、新しい接続を作らず、その承認チャネルから `approval_decision` を送る(手順 3 へ)。送れなかったら手順 1 へ進む。
1. アクションが押されたら、アプリは背景のまま、通知の鍵 id(`k`)から接続先を引き、その会話の承認チャネル(`serve --session <名前>`)を開く。engine は開かない。
2. **同じ承認 id の `approval_request` を受け取るまで待つ**(最大 20 秒。host の hook は、承認を届けられない間、承認チャネルへのつなぎ直しを続けていて、つながると同じ id で要求を送り直す)。要求が来なければ、決定を送らない(解決済みか期限切れ)。
3. `approval_decision`(既存。`{id, decision, reason?}`)を送る。
4. `approval_decision_result` を最大 3 秒待つ。

### `approval_decision_result`(host の hook → iOS。承認チャネル)

| フィールド | 内容 |
|---|---|
| `id` | 承認 id |
| `status` | `applied`(この決定で確定した)\| `stale`(その id の承認を待っていない。別の承認を待っている・既に確定した) |

- **host が返すのは `applied` だけ**: 承認チャネルの中継は、iPhone からの決定を接続中のすべての hook に配る(同じ会話で複数の承認を待っていることがある)。そのため、決定の id の持ち主の hook だけが `applied` を返し、ほかの hook は何も返さずに待ち続ける。`stale` は将来のための予約で、いまの host は送らない。
- **アプリの判定**: 決定を送ってから 3 秒の間に、その id の `applied` が 1 つでも来れば成功(`stale` が混ざっていても成功)。`stale` だけが来たら「もう処理されている」。**何も来なければ、成功とはみなさず、「送ったが、反映を確認できなかった」と利用者に知らせる**(接続が黙って切れていて届いていない場合と区別できないため。この行を返さない v1.1 より前の host では、反映されていてもこの知らせが出る)。
- 既存のアプリ(この行を知らない)は、未知の type として読み飛ばす。

### アプリ内の承認の状態(iOS の実装の決まり)

承認キューは承認ごとに状態を 1 つ持つ: **未回答 / 回答中(持ち主の印・経路 = 会話画面・通知・もう一度送る)/ 送信を始めたが反映を確認できていない / 解決済み(一覧から外す)**。

**一度でも決定の送信を始めた承認には、届いていなかったと分かるまで、同じ決定しか送らない。** 届いていなかった根拠は「新しい承認チャネルで、同じ id の `approval_request` が送り直された(host がまだ待っている)」ことだけとする。

- どの入口(会話画面のボタン・通知の手順 0・「もう一度送る」)も、**送信を始める前に**持ち主の印を取る。回答中の承認には、ほかの入口から決定を送らない(通知の手順 0 は、短い接続へも進まずに「送れませんでした。開いて確認してください」と知らせる)。`approval_decision_result` は、`applied` を待っている回答(通知・もう一度送る)のうち、送信を始めた回答にだけ記録する(同じ id で送信を始めた回答は必ず同じ決定なので、古い結果が混ざっても表示と実際は食い違わない)。
- 通知の回答が取り消された・上限に達したら(送信が戻らなくても)、その時点で回答を締めて印を外す。**送信を始めていれば「反映を確認できていない」にする**(チャネルに書けたかを確実に知れないため。未回答へは戻さない)。送信を始める前の取り消しと、送信がエラーで終わった(書けなかった)場合だけ未回答へ戻す。遅れて戻った古い送信は状態を変えない。
- 「もう一度送る」も、送信を含む全体を上限(10 秒)で覆う。上限に達したら、送信が戻らなくても締める(解決の知らせが来ていれば解決済み、それ以外は確認できていないへ戻してボタンを押せるようにする)。送り直しの最中でも「閉じる」は押せる(一覧から外し、遅れて届いた結果は捨てる)。
- 反映を確認できなかった承認は、未回答のカードから外して「確認できていない」カードに置く(後ろの未回答の承認を塞がない。未回答の承認を先に見せている間も、件数の小さな知らせを出す)。ボタンは「もう一度「許可/拒否」を送る」(同じ決定だけ。判定の規則は上と同じ)と「閉じる」。反対の決定は、会話画面からも通知からも送らない(通知の手順 0 は短い接続へも進まず、「送れませんでした。開いて確認してください」と知らせる)。
- `stale` だけ → 解決済み(カードを残さない)。待つ間に `remote_pending_cleared`(kind=approval・同じ id)が先に届いた → 解決済み(カードを作らない)。この場合、承認は終わったが、こちらの決定が使われたかは分からないので、通知では「この承認は終わりましたが、送った「許可」が使われたかは確認できませんでした。開いて確認してください。」と知らせる。確認できていない承認に解決の知らせが来れば消す。
- host が同じ id の `approval_request` を送り直したら(まだ待っている = 決定は届いていなかった)、確認できていない承認を未回答へ戻す(二重にしない。反対の決定も送れるようになる)。通知・もう一度送るで回答中に、回答を始めた後に張り直された新しいチャネルで同じ要求が来たら、送信が戻らなくてもその場で回答を締めて未回答へ戻す。切断(破棄)では、回答中のものも含めて消す。
