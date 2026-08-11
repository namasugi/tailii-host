// keychainMirror.ts
// tailii (TS host) — Keychain 資格情報のミラーキャッシュ（account-usage の SSH 文脈対策）
//
// 背景: engine は接続トランスポートによって異なる文脈で spawn される。
//   - QUIC: LaunchAgent(quic-gw) の子 = ログインユーザーの GUI audit session 内。
//     `launchctl asuser` で login Keychain を読める。
//   - SSH: sshd の子 = 別 audit session。非 root は `launchctl asuser` で GUI 側へ
//     移れず（"Could not switch to audit session"）、直接の `security` も失敗する。
// このため「QUIC では使用量が取れるのに SSH では取れない」非対称が生じる。
//
// 対策: Keychain 読取に成功した文脈（QUIC 接続の engine 等）が、読めた JSON を
// そのまま本ミラーへ書き残す。Keychain 不達の文脈（SSH 接続の engine）は、
// 有効期限内のミラーを第2候補として使う。
//
// 秘密の扱い: 内容は `~/.claude/.credentials.json` と同等の OAuth トークン。
// 同ファイルと同じく 0600 で保存し、ログ・ワイヤーへは決して載せない。
// ミラー由来のトークンは **refresh に使わない**（Keychain セッションの refresh token を
// 別プロセスが回すと、ローテーションで GUI 側 Claude Code のログインを壊すため）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** ミラーの既定パス（`~/.tailii/run/` は他のランタイム状態と同居）。 */
export function defaultKeychainMirrorPath(): string {
  return path.join(os.homedir(), ".tailii", "run", "claude-keychain-mirror.json");
}

/**
 * Keychain から読めた JSON をミラーへ書く（atomic・0600・内容不変ならスキップ）。
 * 失敗は握り潰す（ミラーは純粋なベストエフォート機能で、主経路を止めない）。
 */
export function writeKeychainMirror(
  rawJson: string,
  mirrorPath: string = defaultKeychainMirrorPath(),
): void {
  try {
    const normalized = rawJson.trim();
    try {
      if (fs.readFileSync(mirrorPath, "utf8") === normalized) return;
    } catch {
      // 未存在・読取不能なら新規書込へ進む。
    }
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${mirrorPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, normalized, { mode: 0o600 });
      fs.renameSync(tmpPath, mirrorPath);
    } finally {
      // rename 失敗時に秘密入り tmp をゴミとして残さない（成功時は既に消えている）。
      fs.rmSync(tmpPath, { force: true });
    }
  } catch {
    // ベストエフォート。
  }
}

/** ミラーを読む（無い・読めないときは null）。 */
export function readKeychainMirror(
  mirrorPath: string = defaultKeychainMirrorPath(),
): string | null {
  try {
    return fs.readFileSync(mirrorPath, "utf8");
  } catch {
    return null;
  }
}
