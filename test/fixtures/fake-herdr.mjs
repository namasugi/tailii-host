#!/usr/bin/env node
// fake-herdr.mjs — 状態を持つ偽の herdr CLI（test/hubDaemonCommand.test.ts 用）。実物の herdr には一切つながらない。
// Tailii の pane を 1 つ（"s-exp00001" = w1:p1）だけ持ち、入力欄の文字と送信を FAKE_HERDR_STATE（JSON）に残す。
//   FAKE_HERDR_LOG                    呼ばれた引数と TEXT-BEGIN / TEXT-APPLIED / SUBMIT を 1 行ずつ追記するファイル
//   FAKE_HERDR_STATE                  入力欄の状態（JSON）
//   FAKE_HERDR_STATUS                 `pane get` の agent_status（既定 "idle"。"unknown" = claude の起動中）
//   FAKE_HERDR_TEXT_DELAY             本文の send-text を入力欄へ入れる前に待つ ms（注入を実行中のまま保つ）
//   FAKE_HERDR_PROCESS_INFO_DELAY     `pane process-info` を返す前に待つ ms（reaper の 1 周を遅らせる）
import * as fs from "node:fs";

const logPath = process.env.FAKE_HERDR_LOG;
const statePath = process.env.FAKE_HERDR_STATE;
const args = process.argv.slice(2);
const rest = args[0] === "--session" ? args.slice(2) : args;
const log = (line) => { if (logPath) fs.appendFileSync(logPath, `${Date.now()} ${line}\n`); };
log(rest.map((arg) => JSON.stringify(arg)).join(" "));
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { input: "", submits: [] }; }
};
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (object) => { process.stdout.write(JSON.stringify(object)); process.exit(0); };
const busyWait = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* CLI の呼び出しを実行中のまま保つ */ } };
const frame = (input) => {
  const rule = "─".repeat(40);
  const rendered = input.split("\n").map((line, index) => (index === 0 ? `❯ ${line}` : `  ${line}`)).join("\n");
  return ["❯ 古いメッセージのエコー", rule, rendered, rule, "  ⏸ manual mode on"].join("\n");
};

const [group, command] = rest;
if (group === "pane" && command === "list") {
  out({ result: { panes: [{ pane_id: "w1:p1", label: "s-exp00001", tab_id: "w1:t1" }] } });
}
if (group === "pane" && command === "get") {
  out({ result: { pane: { pane_id: "w1:p1", agent_status: process.env.FAKE_HERDR_STATUS ?? "idle" } } });
}
if (group === "pane" && command === "read") {
  process.stdout.write(`${frame(readState().input)}\n`);
  process.exit(0);
}
if (group === "pane" && command === "process-info") {
  busyWait(Number(process.env.FAKE_HERDR_PROCESS_INFO_DELAY ?? "0"));
  out({ result: { process_info: { foreground_process_group_id: 999999, foreground_processes: [{ name: "claude", pid: 999999 }] } } });
}
if (group === "pane" && (command === "send-text" || command === "send-keys")) {
  const state = readState();
  for (let payload of rest.slice(3)) {
    if (payload === "\r" || payload === "Enter") {
      if (state.input.length > 0) {
        state.submits.push(state.input);
        log(`SUBMIT ${JSON.stringify(state.input)}`);
      }
      state.input = "";
    } else if (payload === "\u0015") {
      state.input = "";
    } else if (payload === "Escape" || payload === "Backspace") {
      // この pane では何もしない
    } else {
      const delay = Number(process.env.FAKE_HERDR_TEXT_DELAY ?? "0");
      if (delay > 0) {
        log(`TEXT-BEGIN ${JSON.stringify(payload)}`);
        busyWait(delay);
      }
      payload = payload.replace(/\u001b\[200~|\u001b\[201~/g, "");
      state.input += payload;
      log(`TEXT-APPLIED ${JSON.stringify(payload)}`);
    }
  }
  writeState(state);
  out({ result: {} });
}
if (group === "tab" && command === "list") out({ result: { tabs: [{ tab_id: "w1:t1", label: "s-exp00001" }] } });
out({ result: {} });
