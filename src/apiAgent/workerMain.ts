// apiAgent/workerMain.ts
// API 作業プロセスの入口。hub が `node <dist>/apiAgent/workerMain.js` で起動する（cli.ts を経由しない:
// engine / hub / tmux のモジュールを作業プロセスへ読み込まないため）。
// 標準入力 = hub からの NDJSON、標準出力 = hub への NDJSON。標準エラーには何も書かない。

import { loadAgentSdk } from "./sdkLoader.js";
import { readLines, runApiAgentWorker, writeWorkerMessage } from "./worker.js";
import { readPackageVersion } from "../shared/version.js";

const code = await runApiAgentWorker({
  lines: readLines(process.stdin),
  write: (message) => writeWorkerMessage(process.stdout, message),
  env: process.env,
  loadSdk: () => loadAgentSdk(),
  clientApp: `tailii-host/${readPackageVersion() ?? "unknown"}`,
}).catch(() => 70);
// 標準出力を書き切ってから終わる。
process.stdout.write("", () => process.exit(code));
