// macOS の TCC 許可を更新後も維持するための固定コード署名。
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const QUIC_GW_SIGNING_IDENTIFIER = "com.tailii.quic-gw";

/** 公開の証明書名 / SHA-1 セレクタだけを保存する。秘密鍵は Keychain から出さない。 */
export function quicGatewaySigningIdentityPath(): string {
  return path.join(os.homedir(), ".tailii", "quic-signing-identity");
}

export interface QuicGatewaySigningOptions {
  platform?: NodeJS.Platform;
  /** ローカルビルドの署名に使う証明書。省略時は設定ファイルを読む。 */
  identity?: string;
  /** codesign 実行子（テスト注入用）。stdout / stderr を合わせて返す。 */
  codesign?: (args: string[]) => string;
}

function runCodesign(args: string[]): string {
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  if (result.status !== 0) throw new Error(output.trim() || "codesign failed");
  return output;
}

function configuredIdentity(): string | undefined {
  try {
    return fs.readFileSync(quicGatewaySigningIdentityPath(), "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function hasStableIdentity(description: string): boolean {
  return description.split("\n").includes(`Identifier=${QUIC_GW_SIGNING_IDENTIFIER}`) &&
    /^Authority=.+$/m.test(description);
}

/**
 * コピーした候補をローカル証明書で署名し、既設バイナリと同じ DR に適合することを確認。
 * 証明書署名へ移行済みなら、ad-hoc 配布物や別署名による許可の破壊を上書き前に拒否する。
 * 初回の ad-hoc → 証明書署名の移行では macOS 側のアクセス許可を登録し直す必要がある。
 */
export function prepareQuicGatewaySignature(
  candidate: string,
  installed: string,
  options: QuicGatewaySigningOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "darwin") return;
  const codesign = options.codesign ?? runCodesign;
  const identity = options.identity ?? configuredIdentity();
  if (identity !== undefined) {
    if (!identity.trim() || identity === "-") {
      throw new Error("QUIC の固定署名には Apple のコード署名証明書を指定してください。");
    }
    codesign([
      "--force", "--sign", identity, "--identifier", QUIC_GW_SIGNING_IDENTIFIER,
      "--timestamp=none", candidate,
    ]);
    codesign(["--verify", "--strict", candidate]);
    if (!hasStableIdentity(codesign(["-d", "--verbose=2", candidate]))) {
      throw new Error("QUIC バイナリの証明書署名と固定識別子を確認できませんでした。");
    }
  }

  if (!fs.existsSync(installed)) return;
  let previous: string;
  try {
    previous = codesign(["-d", "-r-", "--verbose=2", installed]);
  } catch (error) {
    // 未署名の従来インストールだけを許容し、調査不能なら上書きしない。
    if (error instanceof Error && /code object is not signed at all/.test(error.message)) return;
    throw error;
  }
  if (!hasStableIdentity(previous)) return;
  const requirement = /^designated => (.+)$/m.exec(previous)?.[1];
  if (requirement === undefined) throw new Error("既設 QUIC バイナリの署名条件を取得できません。");
  try {
    // '=' が無いと codesign は DR 本文をファイル名として解釈する。
    codesign(["--verify", "--strict", "-R", `=${requirement}`, candidate]);
  } catch (error) {
    throw new Error(
      "QUIC 更新の署名が既設バイナリと一致しません。アクセス許可を維持するため既設版を残しました。" +
      ` ローカル署名証明書の設定: ${quicGatewaySigningIdentityPath()}`,
      { cause: error },
    );
  }
}
