// hostVersions.ts
// tailii (TS host) — ホスト環境のバージョン情報（account-usage の「ホスト」カード）
//
// 使用量シートの最下部に出す 3 行:
//   - Tailii host  … 稼働中 dist の package.json version
//   - Claude Code  … `claude --version`（"2.1.220 (Claude Code)" → "2.1.220"）
//   - Codex CLI    … `codex --version`（"codex-cli 0.145.0" → "0.145.0"）
//
// 設計:
//   - バージョンは engine 稼働中に変わらない（変われば dist 差し替え = 再起動）ので
//     **プロセス内で 1 回だけ**取得して保持する。now 注入は不要。
//   - 子プロセスは timeout 3 秒。落ちた行は**省略**する（"取得失敗" を表示しない）。
//   - SSH 非対話シェル由来の PATH では `claude` / `codex` が解決できないため、
//     launch と同じ既知ディレクトリを前置する（officialApps と同じ既知の罠）。

import { execFile } from "node:child_process";
import * as os from "node:os";
import { defaultInjectedPath } from "../commands/launch.js";
import type { HostVersions } from "../protocol/messages.js";
import { readPackageVersion } from "../shared/version.js";

/** engine へ注入するフェッチャの型（テストは固定値/null を注入する）。 */
export type HostVersionsProvider = () => Promise<HostVersions | null>;

/** 各 `--version` 呼び出しに与える timeout（ms）。 */
export const HOST_VERSION_PROBE_TIMEOUT_MS = 3_000;

/** 子プロセス実行の注入点（テストは実バイナリを起動しない偽 exec を注入する）。 */
export type VersionExec = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

/**
 * `--version` 出力からバージョン文字列だけを取り出す（純ロジック, TESTABLE）。
 *
 * 各 CLI が付ける飾り（"(Claude Code)" / "codex-cli " 等）は捨て、最初に現れる
 * `x.y.z`（プレリリース接尾辞込み）を返す。数字列が見つからなければ 1 行目をそのまま返す
 * （将来フォーマットが変わっても「何か」は出せる）。
 */
export function parseCliVersion(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const line = raw.split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return undefined;
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(line);
  return match?.[0] ?? line;
}

/** 既定の exec（PATH を launch と揃えて前置し、timeout で必ず戻る）。 */
const defaultExec: VersionExec = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: os.homedir(),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          PATH: [defaultInjectedPath(), process.env["PATH"] ?? ""].filter(Boolean).join(":"),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        // 一部 CLI は version を stderr に出す。stdout が空なら stderr を見る。
        const out = String(stdout).trim();
        resolve(out.length > 0 ? out : String(stderr));
      },
    );
  });

export interface CollectHostVersionsOptions {
  exec?: VersionExec;
  packageVersion?: () => string | null;
  timeoutMs?: number;
}

/**
 * ホスト環境のバージョンを集める（キャッシュ無し。テストはここを直接叩く）。
 * 取れなかったフィールドは省略し、1 つも取れなければ null（= `host` を載せない）。
 */
export async function collectHostVersions(
  options: CollectHostVersionsOptions = {},
): Promise<HostVersions | null> {
  const exec = options.exec ?? defaultExec;
  const packageVersion = options.packageVersion ?? readPackageVersion;
  const timeoutMs = options.timeoutMs ?? HOST_VERSION_PROBE_TIMEOUT_MS;

  const [claudeRaw, codexRaw] = await Promise.all([
    exec("claude", ["--version"], timeoutMs).catch(() => null),
    exec("codex", ["--version"], timeoutMs).catch(() => null),
  ]);

  let host: string | null = null;
  try {
    host = packageVersion();
  } catch {
    host = null;
  }

  const versions: HostVersions = {
    ...(host !== null && host.length > 0 ? { hostVersion: host } : {}),
    ...withKey("claudeCliVersion", parseCliVersion(claudeRaw)),
    ...withKey("codexCliVersion", parseCliVersion(codexRaw)),
  };
  return Object.keys(versions).length === 0 ? null : versions;
}

function withKey(key: keyof HostVersions, value: string | undefined): Partial<HostVersions> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * プロセス内キャッシュ付きの取得（既定の provider）。
 * 進行中の呼び出しも共有するので、シート連打でも `--version` は 1 回しか走らない。
 * null（1 つも取れなかった）はキャッシュせず、次回また試す。
 */
let memo: Promise<HostVersions | null> | null = null;

export function fetchHostVersions(): Promise<HostVersions | null> {
  memo ??= collectHostVersions().then(
    (value) => {
      if (value === null) memo = null;
      return value;
    },
    () => {
      memo = null;
      return null;
    },
  );
  return memo;
}
