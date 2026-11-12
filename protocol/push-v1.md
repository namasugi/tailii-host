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
