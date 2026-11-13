#!/usr/bin/env node
// cli.ts — tailii ホスト CLI エントリ（Swift 版 Dispatcher の移植先）
//
// サブコマンド（Swift 版と同一の面 + setup を統合）:
//   engine        横断制御チャネル（セッション一覧/起動/モード/使用量/tool_activity 中継 …）
//   serve         承認チャネル（--session <name>）
//   hook          Claude Code hook 受け口（承認要求の投入）
//   launch        tmux セッション起動
//   kick          承認待ちの起床
//   push-token    APNs デバイストークン登録
//   setup         ペアリング（鍵生成 + QR / ペアリングコード受け渡し）
//   hub           Session Hub daemon
//
// 移植は protocol → engine → serve/hook → launch/setup の順に段階的に行う。
// 未移植サブコマンドは明示エラーで落ちる（黙って別挙動をしない）。

import { migrateLegacyHome } from "./commands/legacyHomeMigration.js";
import { readPackageVersion } from "./shared/version.js";

// hook / serve の短命プロセスでは、使うサブコマンドの依存だけを読み込む。
const PORTED: Record<string, (args: string[]) => Promise<number>> = {
  "engine": async (args) => (await import("./engine/engine.js")).runEngineCommand(args),
  "launch": async (args) => (await import("./commands/launch.js")).runLaunchCommand(args),
  "serve": async (args) => (await import("./approval/broker.js")).runServeCommand(args),
  "hook": async (args) => (await import("./approval/hook.js")).runHookCommand(args),
  "kick": async (args) => (await import("./commands/kick.js")).runKickCommand(args),
  "push-token": async (args) => (await import("./commands/pushTokenCommand.js")).runPushTokenCommand(args),
  "setup": async (args) => (await import("./commands/setup.js")).runSetupCommand(args),
  "doctor": async (args) => (await import("./commands/doctor.js")).runDoctorCommand(args),
  "hub": async (args) => (await import("./hub/hubDaemon.js")).runHubCommand(args),
  "quic-info": async (args) => (await import("./services/quicGateway.js")).runQuicInfoCommand(args),
  "self-update": async (args) => (await import("./commands/selfUpdate.js")).runSelfUpdateCommand(args),
  "api-agent": async (args) => (await import("./commands/apiAgentCommand.js")).runApiAgentCommand(args),
};

async function main(): Promise<number> {
  if (process.argv[2] === "standby") {
    const { runStandbyCommand } = await import("./commands/standby.js");
    return runStandbyCommand(main);
  }
  migrateLegacyHome();
  const [subcommand, ...rest] = process.argv.slice(2);
  // `--version` の出力形式（version 文字列 + 改行のみ）は self-update のスモークテストが
  // 新旧バージョンをまたいで依存する凍結契約。変更しないこと。
  if (subcommand === "--version" || subcommand === "-v") {
    process.stdout.write(`${readPackageVersion() ?? "unknown"}\n`);
    return 0;
  }
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stderr.write(
      "usage: tailii <engine|serve|standby|hook|launch|kick|push-token|setup|doctor|hub|self-update|api-agent> [options]\n",
    );
    return 64;
  }
  const handler = PORTED[subcommand];
  if (!handler) {
    process.stderr.write(
      `tailii: subcommand '${subcommand}' は TypeScript 版に未移植です。` +
        `当面は Swift 版 (tailii-host) を使用してください。\n`,
    );
    return 69;
  }
  return handler(rest);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`tailii: ${String(error)}\n`);
    process.exit(70);
  },
);
