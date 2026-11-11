// commands/apiAgentCommand.ts
// `tailii api-agent <status|install|uninstall>` — API 作業（Agent SDK）の手動の確認・入れ直し・削除。
//
// 通常は手で打たなくてよい: `tailii setup`・自己更新の後（導入済みのときだけ）・アプリで API 作業を始めるときに
// 自動で準備する（apiAgent/sdkInstaller.ts）。このコマンドは失敗時の詳しい理由の確認と、手動の入れ直し用に残す。

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultAgentSdkDir } from "../apiAgent/sdkLoader.js";
import { agentSdkStatus, describeAgentSdkStatus, type AgentSdkStatus } from "../apiAgent/sdkStatus.js";
import { installAgentSdkAtomic, type SdkInstallDeps } from "../apiAgent/sdkInstaller.js";

export { matchingSdkVersionCandidate, resolveNpm } from "../apiAgent/sdkInstaller.js";

/** SDK を導入する（手動・setup 共通。一時フォルダへ入れてから置き換える）。 */
export async function installAgentSdk(deps: SdkInstallDeps = {}): Promise<{ ok: boolean; spec: string; message: string }> {
  const result = await installAgentSdkAtomic(deps);
  if (result.ok) return { ok: true, spec: result.version, message: `Agent SDK ${result.version} を ${result.dir} に導入しました。` };
  if (result.error === "busy") return { ok: false, spec: "", message: "別の導入が進行中です。終わってからもう一度お試しください。" };
  return { ok: false, spec: "", message: result.detail !== undefined ? `${result.message}（${result.detail}）` : result.message };
}

export function uninstallAgentSdk(dir: string = defaultAgentSdkDir()): boolean {
  // 決まった導入先だけを消す（それ以外のパスは受け付けない）。
  if (path.basename(dir) !== "sdk" || path.basename(path.dirname(dir)) !== "api-agent") return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function formatAgentSdkStatus(status: AgentSdkStatus): string {
  return [
    `Agent SDK: ${describeAgentSdkStatus(status)}`,
    `  導入先: ${status.entry ?? defaultAgentSdkDir()}`,
    ...(status.installedClaude !== null ? [`  使う claude: ${status.installedClaude}`] : []),
  ].join("\n");
}

export async function runApiAgentCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "status") {
    process.stdout.write(formatAgentSdkStatus(agentSdkStatus()) + "\n");
    return 0;
  }
  if (sub === "install") {
    const versionIndex = rest.indexOf("--version");
    const version = versionIndex >= 0 ? rest[versionIndex + 1] : undefined;
    const result = await installAgentSdk({
      ...(version !== undefined ? { version } : {}),
      log: (line) => process.stdout.write(line + "\n"),
      onPhase: (phase) => process.stdout.write(`  ${phaseLabel(phase)}\n`),
    });
    process.stdout.write(result.message + "\n");
    if (result.ok) process.stdout.write(formatAgentSdkStatus(agentSdkStatus()) + "\n");
    return result.ok ? 0 : 1;
  }
  if (sub === "uninstall") {
    uninstallAgentSdk();
    process.stdout.write(`${defaultAgentSdkDir()} を削除しました。\n`);
    return 0;
  }
  process.stderr.write("usage: tailii api-agent <status|install [--version <版>]|uninstall>\n");
  return 64;
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case "resolving": return "版を確かめています…";
    case "downloading": return "ダウンロードしています（1 分ほどかかることがあります）…";
    case "verifying": return "取得したパッケージを確かめています…";
    case "switching": return "仕上げています…";
    default: return "準備しています…";
  }
}
