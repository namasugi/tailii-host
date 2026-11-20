import { expect, it } from "vitest";
import { herdrRestartCommand } from "../src/backend/herdr.js";
import { herdrServerLoginDoctorCheck, parseHerdrServerPids } from "../src/commands/doctor.js";

it("引数なしと名前付きのサーバーだけを指定セッションから拾う", () => {
  const listing = [
    " PID COMMAND",
    " -1 herdr server",
    "  0 herdr server",
    " 11 /bin/sh -c /opt/bin/herdr server",
    " 12 /opt/bin/herdr --session tailii server stop",
    " 13 /opt/bin/herdr --session tailii pane list",
    " 14 /opt/bin/not-herdr --session tailii server",
    " 15 /opt/bin/herdr --session ignored server",
    " 16 /opt/bin/herdr server ",
    " 17 /opt/bin/herdr --session tailii server",
    " 18 /opt/bin/herdr --session project.test_1 server",
  ].join("\n");
  expect(parseHerdrServerPids(listing, ["default", "tailii", "project.test_1"])).toEqual(
    new Map([["default", 16], ["tailii", 17], ["project.test_1", 18]]),
  );
  expect(parseHerdrServerPids(listing, ["tailii", "tailii"])).toEqual(new Map([["tailii", 17]]));
  expect(parseHerdrServerPids(listing, ["missing"]).size).toBe(0);
});

it("明示された default、パスなしの herdr、空白を含む既知の実行パスを拾う", () => {
  const listing = "41 herdr --session default server\n42 /opt/herdr tools/bin/herdr --session tailii server\n";
  expect(parseHerdrServerPids(listing, ["default", "tailii"], "/opt/herdr tools/bin/herdr")).toEqual(
    new Map([["default", 41], ["tailii", 42]]),
  );
});

it.each(["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])("%s があれば tailii の起動元と再起動手順を表示する", (variable) => {
  const check = herdrServerLoginDoctorCheck("tailii", `/opt/bin/herdr --session tailii server\t${variable}=example PATH=/usr/bin`);
  expect(check).toEqual({
    id: "herdr-server-login-tailii",
    label: "herdr サーバーの起動元(tailii)",
    ok: false,
    required: false,
    detail: expect.stringContaining("ログイン鍵束を使えず、実機向けの署名や鍵束に保存した資格情報を利用できません"),
    remediation: `${herdrRestartCommand("tailii")}（実行中の herdr 会話は終了します。次に会話を開くとデスクトップ側のログインで起動し直します）`,
  });
  expect(check?.detail).not.toContain("example");
});

it.each(["default", "project.test_1"])("利用者のセッション %s も起動し直す手順を案内する", (session) => {
  const check = herdrServerLoginDoctorCheck(session, "herdr server SSH_TTY=/dev/ttys001");
  expect(check?.id).toBe(`herdr-server-login-${session}`);
  expect(check?.label).toBe(`herdr サーバーの起動元(${session})`);
  expect(check?.remediation).toBe(
    `herdr session stop ${session}（実行中の herdr 会話は終了します。次に会話を開くとデスクトップ側のログインで起動し直します）`,
  );
});

it.each([
  null, "", "herdr server PATH=/usr/bin", "herdr server NOT_SSH_TTY=value OTHER=SSH_CONNECTION=value SSH_CLIENT",
])(
  "SSH の環境変数が確認できなければ診断行を出さない（%j）",
  (output) => expect(herdrServerLoginDoctorCheck("tailii", output)).toBeNull(),
);
