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

import { runEngineCommand } from "./engine.js";
import { runLaunchCommand } from "./launch.js";
import { runServeCommand } from "./broker.js";
import { runHookCommand } from "./hook.js";
import { runKickCommand } from "./kick.js";
import { runPushTokenCommand } from "./pushTokenCommand.js";
import { runSetupCommand } from "./setup.js";
import { runDoctorCommand } from "./doctor.js";
import { runHubCommand } from "./hubDaemon.js";
import { runQuicInfoCommand } from "./quicGateway.js";
import { migrateLegacyHome } from "./legacyHomeMigration.js";

const PORTED: Record<string, (args: string[]) => Promise<number>> = {
  engine: runEngineCommand,
  launch: runLaunchCommand,
  serve: runServeCommand,
  hook: runHookCommand,
  kick: runKickCommand,
  "push-token": runPushTokenCommand,
  setup: runSetupCommand,
  doctor: runDoctorCommand,
  hub: runHubCommand,
  "quic-info": runQuicInfoCommand,
};

async function main(): Promise<number> {
  migrateLegacyHome();
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stderr.write(
      "usage: tailii <engine|serve|hook|launch|kick|push-token|setup|doctor|hub> [options]\n",
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
