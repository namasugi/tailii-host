// hostVersions.ts
// tailii (TS host) — ホスト環境のバージョン情報（account-usage の「ホスト」カード）
//
// 使用量シートの最下部に出す 3 行:
//   - Tailii host  … 稼働中 dist の package.json version
//   - Claude Code  … `claude --version`（"2.1.220 (Claude Code)" → "2.1.220"）
//   - Codex CLI    … `codex --version`（"codex-cli 0.145.0" → "0.145.0"）
//
// 設計:
//   - CLI は engine 稼働中にも更新されるため、シートの更新ごとに再取得する。
//   - 子プロセスは timeout 3 秒。落ちた行は**省略**する（"取得失敗" を表示しない）。
//   - doctor は独立した上限時間を持ち、診断の遅延で使用量応答を失敗させない。
//   - SSH 非対話シェル由来の PATH では `claude` / `codex` が解決できないため、
//     launch と同じ既知ディレクトリを前置する（officialApps と同じ既知の罠）。

import { execFile } from "node:child_process";
import * as os from "node:os";
import { defaultInjectedPath } from "../commands/launch.js";
import { collectDoctorChecks, type DoctorCheck } from "../commands/doctor.js";
import type { HostVersions } from "../protocol/messages.js";
import { readPackageVersion } from "../shared/version.js";

/** engine へ注入するフェッチャの型（テストは固定値/null を注入する）。 */
export type HostVersionsProvider = () => Promise<HostVersions | null>;

/** 各 `--version` 呼び出しに与える timeout（ms）。 */
export const HOST_VERSION_PROBE_TIMEOUT_MS = 3_000;
/** iOS の account-usage request 上限（12秒）より十分短い診断待ち時間。 */
export const HOST_DIAGNOSTICS_TIMEOUT_MS = 5_000;

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

export interface FetchHostVersionsOptions {
  versions?: HostVersionsProvider;
  diagnostics?: () => Promise<DoctorCheck[]>;
  diagnosticsTimeoutMs?: number;
}

/** timeout 後も元 Promise の reject を捕捉し、未処理 rejection を残さない。 */
function resolveWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = promise.catch(() => fallback);
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, timeoutMs));
  });
  return Promise.race([guarded, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * バージョンと診断を並行取得する。CLI バージョンは更新直後の refresh へ反映し、
 * doctor が固まった場合は診断だけを省略して使用量・バージョン行を返す。
 */
export async function fetchHostVersions(
  options: FetchHostVersionsOptions = {},
): Promise<HostVersions | null> {
  const versionProvider = options.versions ?? collectHostVersions;
  const diagnosticsProvider = options.diagnostics ?? collectDoctorChecks;
  const diagnosticsTimeoutMs = options.diagnosticsTimeoutMs ?? HOST_DIAGNOSTICS_TIMEOUT_MS;
  const [versions, diagnostics] = await Promise.all([
    Promise.resolve().then(() => versionProvider()).catch(() => null),
    resolveWithin(
      Promise.resolve().then(() => diagnosticsProvider()),
      diagnosticsTimeoutMs,
      [],
    ),
  ]);
  if (versions === null && diagnostics.length === 0) return null;
  return {
    ...(versions ?? {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
