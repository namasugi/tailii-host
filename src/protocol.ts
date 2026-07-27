// protocol.ts
// tailii (TS host) — NDJSON 制御チャネル v1 封筒定義とコーデック（facade）
//
// 実体は protocol/ 配下にドメイン分割されている:
//   protocol/messages.ts — プロトコル版数・支援型・ControlMessage union
//   protocol/decode.ts   — decodeControlMessage（NDJSON 行 → ControlMessage）
//   protocol/encode.ts   — encodeControlMessage（canonical NDJSON 出力）
//   protocol/common.ts   — ProtocolDecodeError・Raw フィールドヘルパ（内部共有）
// 既存 importer の互換のため、公開 API は本 facade から従来どおり輸出する。
//
// 本モジュール群は Swift 版 host/Sources/tailii-host-core/Protocol.swift の移植。
// 正本はリポジトリルートの golden フィクスチャ:
//   protocol/approval-protocol-v0.ndjson（v 欠落 = v0 レガシー互換）
//   protocol/approval-protocol-v1.ndjson（v:1 代表行）
// 全行が byte-exact でラウンドトリップすることをテストで保証する（移植の受け入れ網）。
//
// エンコード規約（Swift 版と同一）:
// - キーは辞書順ソート（JSONEncoder .sortedKeys 相当）・スラッシュ非エスケープ・Unicode 生出力
// - undefined（nil）フィールドは出力しない
// - v === 0（v0 レガシー）は `v` フィールドを出力しない
// - v >= 1 は `v` を出力する

export * from "./protocol/messages.js";
export { ProtocolDecodeError } from "./protocol/common.js";
export { decodeControlMessage } from "./protocol/decode.js";
export { encodeControlMessage } from "./protocol/encode.js";
