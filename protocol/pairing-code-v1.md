# Tailii ペアリングコード方式 v1（LAN 鍵受け渡し）

Mac が 6 桁コードを表示し、iPhone がそのコードで LAN 越しにペアリング payload
（ed25519 秘密鍵込み）を安全に受け取るためのプロトコル。QR/クリップボードの置き換え。

**このドキュメントが正**。host-ts 側実装（responder = Mac）と将来の iOS 側実装（initiator = iPhone）は
これに厳密に従う。ペアリング payload の中身（JSON）は既存 `pairing-payload-v{1,2}.json` と byte 一致で不変。

## 脅威モデルと設計根拠

- QR 方式は秘密鍵を「画面」経由でのみ渡し、ネットワークに一切流さなかった。コード方式は秘密鍵を
  **LAN に流す**ため、盗聴・MITM への耐性が必須。
- 6 桁コード単体（≈20bit）を対称鍵にすると、受動盗聴者が暗号文をオフライン総当り（10^6）できてしまう。
  よって **X25519 ECDH で共有鍵を確立**し、6 桁コードは **SAS（Short Authentication String, 共有鍵から導出）**
  として MITM 検知に使う（Bluetooth numeric comparison / ZRTP と同型）。
- 能動 MITM が SAS 衝突を適応的に作るのを防ぐため、**initiator は自分の一時公開鍵を先にコミット**してから
  responder が公開鍵を開示する（commitment）。これにより MITM 成功確率 ≈ 2^-20/試行。
- **単発試行**: 1 回のペアリングセッションで確認失敗（コード不一致 / MAC 不一致 / commitment 不一致 / timeout）
  したら、そのセッションを破棄し responder を終了する（再試行は `setup --code` を再実行 = 新しい ECDH）。
  online 総当りを与えない。

## 役割

- **responder = Mac（host-ts, 本実装対象）**: TCP を LAN で listen し、SAS を端末に表示し、確認成功後に
  payload を AEAD 暗号化して送る。
- **initiator = iPhone（将来）**: mDNS で Mac を発見 → TCP 接続 → コミット → 人間が Mac の 6 桁を入力 →
  SAS 照合 → 確認 → payload を復号。

（responder は listen 中に接続先 `host:port` と 6 桁コードを端末表示するので、IP:port を知っていれば
mDNS 無しでも接続できる。mDNS/Bonjour 広告は下記「mDNS 発見」で規定＝IP 手入力を不要にする発見レイヤ。）

## mDNS 発見（Bonjour, 手入力を不要にする発見レイヤ）

responder（Mac）は `setup --code` で TCP を bind した後、そのポートを **mDNS/DNS-SD** で LAN に広告する。
initiator（iPhone）は同サービスをブラウズし、見つけた Mac をタップ → 解決した `host:port` へ上記ハンドシェイクで接続する。
**mDNS はあくまで「発見」だけ。認証・秘密受け渡しは上記 6 桁 SAS ハンドシェイクが全責任を負う**（mDNS の応答は信用しない）。

### サービス定義（両実装が厳密に一致させる）
- サービス型: `_pocketclaude-pair._tcp`（ドメイン `local.`）。完全名 `_pocketclaude-pair._tcp.local.`。
- インスタンス名（ラベル）: 人間可読な表示名。Mac のコンピュータ名（`os.hostname()` の `.local` を除いた短縮名）。
  例 `Namasugi-MBP`。iPhone のリストにこの名前が出る。DNS-SD ラベルとして UTF-8・`.`/制御文字は避ける。
- ポート: `setup --code` が実際に bind した TCP ポート（bind 後に確定する動的値）。
- TXT レコード: `v=1` のみ（プロトコル版。将来 additive）。**秘密・鍵・SAS は絶対に載せない**。
- ホスト名/A: SRV の target は `<hostname>.local.`、その A レコードで LAN IPv4（`detectLanIP()`）を返す。

### 広告する DNS リソースレコード（応答）
- PTR: `_pocketclaude-pair._tcp.local.` → `<label>._pocketclaude-pair._tcp.local.`
- SRV: `<label>._pocketclaude-pair._tcp.local.` → priority 0, weight 0, port `<bound port>`, target `<hostname>.local.`
- TXT: `<label>._pocketclaude-pair._tcp.local.` → `["v=1"]`（各文字列は長さ前置）
- A:   `<hostname>.local.` → `<LAN IPv4>`
- TTL は 120 秒。

### responder（host-ts）の挙動
- multicast group `224.0.0.251:5353`（IPv4）に join（`node:dgram`, `reuseAddr`）。
- 起動時に上記 4 レコードを載せた**非請求応答（unsolicited response, QR=1, AA=1）**を multicast で 2 回送る（RFC 6762 §8.3、~1s 間隔）。
- 受信クエリに応答: サービス型への PTR 質問、または自インスタンスの SRV/TXT/A 質問に対し該当 RR を返す。
  （name compression は任意。非圧縮でも valid。iOS mDNSResponder は非圧縮を受理する。）
- `setup --code` が接続を受理 / セッション終了 / プロセス終了時に広告を停止する。停止時は PTR に **goodbye（TTL=0）** を送る（任意・推奨）。
- IPv6 は本 v1 では扱わない（IPv4 のみ）。Windows/WSL2 は multicast 制約で発見が効かない場合あり（手入力にフォールバック）。

### initiator（iOS）の挙動
- `NWBrowser`（`NWBrowserDescriptor.bonjour(type: "_pocketclaude-pair._tcp", domain: nil)`）でブラウズし、
  発見された `NWBrowser.Result`（endpoint=service）を一覧表示（表示名 = インスタンス名）。
- ユーザーがタップ → その endpoint を `NWConnection` で解決し `host:port` を得て、既存 `runPairingInitiator` を実行。
  （既存の host:port 手入力パスも残す＝mDNS が効かない環境のフォールバック。）
- `Info.plist` に `NSBonjourServices = ["_pocketclaude-pair._tcp"]` を追加（無いと iOS はブラウズを拒否）。
  ローカルネットワーク許可は既存 `NSLocalNetworkUsageDescription` で足りる。

## 暗号プリミティブ（すべて `node:crypto`・ゼロ依存）

- 鍵合意: X25519。`crypto.generateKeyPairSync("x25519")` / `crypto.diffieHellman({privateKey, publicKey})`（→ 32B）。
  - 生 32B 公開鍵 ↔ KeyObject 変換は SPKI 前置 `302a300506032b656e032100`（12B）を使う:
    - raw→pub: `crypto.createPublicKey({key: Buffer.concat([PREFIX, raw32]), format:"der", type:"spki"})`
    - pub→raw: `pub.export({type:"spki",format:"der"}).subarray(12)`
- KDF: HKDF-SHA256。`crypto.hkdfSync("sha256", ikm, salt, info, len)`（戻りは ArrayBuffer → Buffer 化）。
- AEAD: AES-256-GCM。`createCipheriv("aes-256-gcm", key32, iv12)` + `getAuthTag()`（16B）。
- MAC: HMAC-SHA256。`crypto.createHmac("sha256", key)`。
- 乱数: `crypto.randomBytes` / `crypto.randomInt`。

## 鍵導出（transcript バインド）

ECDH 共有鍵 `Z`（32B）確立後、salt = SHA256(`commit || E_m_pub || E_i_pub`)（transcript ハッシュ, 32B）を使い:

```
K_sas     = HKDF(Z, salt, "pocketclaude-pair-v1 sas",     4)   // → 6 桁 SAS
K_confirm = HKDF(Z, salt, "pocketclaude-pair-v1 confirm", 32)  // → 確認 MAC 鍵
K_data    = HKDF(Z, salt, "pocketclaude-pair-v1 data",    32)  // → payload AEAD 鍵
```

- SAS（6 桁）: `String(Buffer(K_sas).readUInt32BE(0) % 1_000_000).padStart(6, "0")`。
- 確認 MAC: `HMAC(K_confirm, "pocketclaude-pair-v1 initiator-confirm")`（32B, initiator→responder）。
- payload 暗号: `AES-256-GCM(K_data, iv=randomBytes(12), plaintext = 既存 pairing payload JSON の UTF-8)`。

## ワイヤ形式

- トランスポート: TCP。1 メッセージ = 1 行の NDJSON（`\n` 区切り）。バイナリは base64（std, padding あり）文字列。
- 全メッセージに `t`（型）を持たせる。未知/不正 → 即座に接続破棄（安全側 abort）。

### メッセージ列（正常系）

1. initiator → responder `hello`:
   `{ "t":"hello", "v":1, "commit":"<base64 SHA256(E_i_pub_raw32)>" }`
2. responder → initiator `server_key`:
   `{ "t":"server_key", "v":1, "epk":"<base64 E_m_pub_raw32>" }`
3. initiator → responder `reveal`:
   `{ "t":"reveal", "epk":"<base64 E_i_pub_raw32>" }`
   - responder は `SHA256(E_i_pub_raw32) === commit` を検証（不一致 → abort）。
   - 両者 `Z = ECDH`、salt、K_sas/K_confirm/K_data を導出。
   - responder は SAS を**端末表示**（`ペアリングコード: 123456`）。
4. （人間が Mac の 6 桁を iPhone に入力。initiator は自分の SAS' と照合し、一致時のみ確認送信。）
   initiator → responder `confirm`:
   `{ "t":"confirm", "mac":"<base64 HMAC(K_confirm, 'pocketclaude-pair-v1 initiator-confirm')>" }`
   - responder は自分の K_confirm で MAC を再計算し**定数時間比較**（`crypto.timingSafeEqual`）。不一致 → abort。
5. responder → initiator `payload`:
   `{ "t":"payload", "iv":"<base64 12B>", "ct":"<base64 ciphertext>", "tag":"<base64 16B GCM tag>" }`
   - initiator は K_data で復号 → 既存 pairing payload JSON を得る。
6. responder は送信後に接続を閉じ、正常終了（exit 0）。

### 異常系（すべて安全側 = payload を送らず abord）

- `hello.v !== 1` / 未知 `t` / base64 長不正（epk≠32B, commit≠32B, mac≠32B）→ abort。
- commitment 不一致（`SHA256(reveal.epk) !== hello.commit`）→ abort。
- 確認 MAC 不一致（コード誤り or MITM で Z が食い違う）→ abort。**payload は絶対に送らない**。
- タイムアウト（既定: 接続待ち 120s、接続後の各ステップ 30s）→ abort。
- 接続は 1 本のみ受け付け、完了/abort でセッション終了（online 総当り防止）。

## host-ts 実装（本タスクのスコープ）

### 追加/変更ファイル
- `src/pairingCode.ts`（新規）: responder のプロトコル状態機械 + 暗号。
- `src/setup.ts`（既存）から `ensureKeypair` / `registerAuthorizedKey` / `sshKeygenEd25519` /
  `encodePairingPayload` / `detectLanIP` を再利用（payload 構築は既存関数で・byte 契約不変）。
- `src/cli.ts` の `setup` に `--code` モードを追加（または `runSetupCommand` 内で分岐）。

### API 形（テスト容易性のため I/O 注入式）
- `runPairingResponder(stream, deps): Promise<PairingResult>`
  - `stream`: `{ readable, writable }`（`Duplex` 相当）。**テストは in-memory の対でハンドシェイクを駆動し、
    実ソケット不要**にする。
  - `deps`: `{ payloadJSON: string, displaySAS: (code:string)=>void, now?, randomBytes?, timeoutMs? }`。
    - `payloadJSON`: 送る pairing payload（`encodePairingPayload(...)` の結果）。
    - `displaySAS`: responder が SAS を出す先（本番=端末表示、テスト=キャプチャ）。
  - 返り値 `PairingResult`: `{ status:"paired" } | { status:"aborted", reason:string }`。
- CLI: `setup --code [--session <name> [--session-cwd <cwd>]]`
  - `ensureKeypair`（無ければ keygen）+ `registerAuthorizedKey` を実施（既存 setup と同じ副作用）。
  - `encodePairingPayload({host: detectLanIP(), port:22, user, key: pem, session...})` で payload を作る。
  - TCP server を LAN（`0.0.0.0` の適当な空きポート or 既定ポート）で listen、`host:port` と待機を端末表示。
  - 接続受理 → `runPairingResponder(socket, {payloadJSON, displaySAS: 端末表示})` を実行。
  - 完了/abort でサーバを閉じ、対応する exit code（paired=0, aborted=非0）で終了。

### テスト（`test/pairingCode.test.ts`, vitest, **直列**, ゼロ依存 node:crypto）
in-test の「iPhone」= initiator ピアを同じ暗号で実装し、in-memory stream の対で responder と往復させる。
- happy path: 正しい 6 桁を入力 → initiator が確認 → responder が payload 送出 → initiator が復号し、
  `payloadJSON` と一致（`status:"paired"`）。
- wrong code: initiator が Mac の SAS と違う 6 桁で照合失敗を模倣し確認を送らない/誤 MAC を送る →
  responder は payload を送らず `aborted`。**payload がストリームに一切現れないことを assert**。
- MITM 模倣: responder が受け取る `reveal.epk` を別の鍵にすり替え（Z 食い違い）→ SAS/confirm 不一致で
  `aborted`、payload 非送出。
- commitment 不一致: `reveal.epk` が `hello.commit` と異なる → `aborted`。
- タイムアウト: 各ステップ無応答で `aborted`（短い timeoutMs 注入で決定化）。
- 変換ユーティリティ（raw↔pub, SAS 導出, KDF）の単体。

## codex 実装時の制約（必読）

- **テストは必ず直列**（`vitest.config.ts` の fileParallelism 無効を変えない）。
  実行は `cd host-ts && npx tsc --noEmit && npx vitest run`。
- **swift / tmux には一切触れない**（サンドボックスで tmux 拒否 → 無限ハングの実績あり）。本タスクは host-ts のみ。
- **ゼロ依存**（`node:crypto`/`node:net` 標準のみ。npm 追加禁止）。ESM/NodeNext/strict、`noUncheckedIndexedAccess` 準拠。
- 既存 `encodePairingPayload` の **byte 契約を壊さない**（golden `pairing-payload-v{1,2}.json`）。
- 秘密（Z/鍵/payload/private key）はログ・エラーメッセージに出さない。
- 定数時間比較は `crypto.timingSafeEqual`。長さ不一致は比較前に弾く（timingSafeEqual は長さ違いで throw）。
