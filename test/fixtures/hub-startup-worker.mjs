// hub-startup-worker.mjs — 別プロセスで hub の単一起動（claimHubStartup）を競わせる（hubStartup の実プロセステスト用）。
// 引数: <lockPath> <socketPath> <barrierDir> <name>
// 到達バリア: `<barrierDir>/ready-<name>` を書き、テストが `<barrierDir>/go` を置くまで待ってから一斉に取りに行く。
// 取れたら socket で listen して `won-<pid>` を書き、kill されるまで動き続ける。`<barrierDir>/stop` が置かれたら
// 終了の待ちに入り（`draining-<pid>`）、`<barrierDir>/release` が置かれたら排他を外して終わる。
// 取れなければ `lost-<pid>-<reason>` を書いて何も消さずに終わる。
// src/hub/hubStartup.ts は node: の組み込みだけに依存するので、Node 24 の型の除去でそのまま読み込める。
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { claimHubStartup } from "../../src/hub/hubStartup.ts";

const [lockPath, socketPath, barrierDir, name] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(path.join(barrierDir, `ready-${name}`), String(process.pid));
while (!fs.existsSync(path.join(barrierDir, "go"))) sleep(1);

const claim = await claimHubStartup({ lockPath, socketPath, version: "test" });
if (claim.kind !== "claimed") {
  fs.writeFileSync(path.join(barrierDir, `lost-${process.pid}-${claim.kind === "busy" ? claim.reason : claim.kind}`), "");
  process.exit(0);
}
const server = net.createServer((socket) => socket.end());
server.listen(socketPath, () => {
  fs.writeFileSync(path.join(barrierDir, `won-${process.pid}`), "");
});
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(barrierDir, "stop"))) return;
  clearInterval(timer);
  // graceful shutdown と同じ順: socket を閉じて名前を消す → （終了の待ち = 排他は持ったまま）→ lock を消す → 排他を外す。
  // socket を閉じた後の待ちの間は、排他だけが次の hub を締め出す（テストはこの間に競合相手を起動する）。
  server.close(() => {
    fs.rmSync(socketPath, { force: true });
    fs.writeFileSync(path.join(barrierDir, `draining-${process.pid}`), "");
    const release = setInterval(() => {
      if (!fs.existsSync(path.join(barrierDir, "release"))) return;
      clearInterval(release);
      fs.rmSync(lockPath, { force: true });
      claim.exclusive.release();
      process.exit(0);
    }, 10);
  });
}, 10);
