// pushTokenCommand.ts
// tailii (TS host) — push-token サブコマンド実装
// Swift 版 PushTokenCommand.swift の移植。
//
// iOS が APNs 登録で得た device token を SSH exec 経由で Mac に受け渡す
// （`tailii push-token`）。stdin から1行 JSON `{token, environment, bundleId, updatedAt}`
// を読み、検証（token=hex / environment=production|sandbox / 必須フィールド存在）後に
// DeviceTokenStore.save で `~/.tailii/apns/device-token.json` に永続化する（3.2/3.3）。
//
// 妥当 JSON → exit 0、不正入力 → 非0 exit + stderr メッセージ、書き込みは行わない。
// token 変化時は上書きで置換される（3.4）。device token は秘匿値として stdout に出さない。

import { DeviceTokenStore, type DeviceTokenStoring } from "./deviceTokenStore.js";
import { isApnsHost } from "./pushTypes.js";

/**
 * push-token の純ロジック。DeviceTokenStore を注入できるためテスト可能。
 * stdin バイト列を JSON として解釈し、token(非空 hex) / environment / bundleId / updatedAt を
 * 検証してから store.save する。いずれか不正なら書き込まず errorSink にメッセージを出して非0。
 */
export function pushTokenCore(
  stdinData: Buffer,
  store: DeviceTokenStoring,
  errorSink: (message: string) => void = (m) => process.stderr.write(m),
): number {
  // --- JSON を辞書として解釈 ---
  let obj: unknown;
  try {
    obj = JSON.parse(stdinData.toString("utf8"));
  } catch {
    errorSink("tailii push-token: stdin が有効な JSON オブジェクトではありません\n");
    return 1;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    errorSink("tailii push-token: stdin が有効な JSON オブジェクトではありません\n");
    return 1;
  }
  const dict = obj as Record<string, unknown>;

  // --- token: 非空 hex 文字列 ---
  const token = dict["token"];
  if (typeof token !== "string" || token.length === 0) {
    errorSink("tailii push-token: 'token' が欠落または空です\n");
    return 1;
  }
  if (!/^[0-9a-fA-F]+$/.test(token)) {
    errorSink("tailii push-token: 'token' は hex 文字列である必要があります\n");
    return 1;
  }

  // --- environment: production | sandbox ---
  const environment = dict["environment"];
  if (typeof environment !== "string") {
    errorSink("tailii push-token: 'environment' が欠落しています\n");
    return 1;
  }
  if (!isApnsHost(environment)) {
    errorSink(
      "tailii push-token: 'environment' は production|sandbox のいずれかである必要があります\n",
    );
    return 1;
  }

  // --- bundleId: 非空文字列 ---
  const bundleId = dict["bundleId"];
  if (typeof bundleId !== "string" || bundleId.length === 0) {
    errorSink("tailii push-token: 'bundleId' が欠落または空です\n");
    return 1;
  }

  // --- updatedAt: 整数（epoch 秒） ---
  const updatedAtRaw = dict["updatedAt"];
  if (typeof updatedAtRaw !== "number" || !Number.isFinite(updatedAtRaw)) {
    errorSink("tailii push-token: 'updatedAt' が欠落または数値ではありません\n");
    return 1;
  }
  const updatedAt = Math.trunc(updatedAtRaw);

  // --- 保存（同一パス上書き＝token 置換, 3.4）。token は stdout に出さない（6.5 パリティ） ---
  try {
    store.save({ token, environment, bundleId, updatedAt });
  } catch (error) {
    errorSink(`tailii push-token: device token の保存に失敗しました: ${String(error)}\n`);
    return 1;
  }

  return 0;
}

/** push-token サブコマンドの CLI エントリポイント。stdin を全読みして pushTokenCore へ渡す。 */
export async function runPushTokenCommand(_args: string[]): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return pushTokenCore(Buffer.concat(chunks), new DeviceTokenStore());
}
