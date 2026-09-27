// cronSchedule.test.ts — セッション予約（session_crons）の次回発火時刻と heartbeat 記録への変換。
// schedule はローカルタイムゾーンの 5 フィールド cron（CronCreate のツール説明）なので、
// 期待値も new Date(年, 月, 日, 時, 分) のローカル時刻で組み立てる。

import { describe, expect, test } from "vitest";
import { nextCronFireMs, scheduledFromSessionCrons } from "../src/sessions/cronSchedule.js";

/** ローカル時刻（月は 1 始まり）。 */
function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

describe("nextCronFireMs", () => {
  test("日付まで固定した 1 回きりの予約はその時刻", () => {
    expect(nextCronFireMs("7 9 27 9 *", local(2026, 9, 27, 8, 29, 25))).toBe(local(2026, 9, 27, 9, 7));
  });

  test("ScheduleWakeup の日付 `*` 予約は Stop 時点から見た次の一致（当日）", () => {
    // 実測: 08:30 の /loop が `51 8 * * *`（recurring=false）として載った。
    expect(nextCronFireMs("51 8 * * *", local(2026, 9, 27, 8, 30, 35))).toBe(local(2026, 9, 27, 8, 51));
  });

  test("同じ分は含めず、過ぎていれば翌日", () => {
    expect(nextCronFireMs("51 8 * * *", local(2026, 9, 27, 8, 51, 10))).toBe(local(2026, 9, 28, 8, 51));
  });

  test("刻み・範囲・列挙・名前", () => {
    expect(nextCronFireMs("*/5 * * * *", local(2026, 9, 27, 8, 31))).toBe(local(2026, 9, 27, 8, 35));
    expect(nextCronFireMs("0 9-17/4 * * *", local(2026, 9, 27, 10, 0))).toBe(local(2026, 9, 27, 13, 0));
    expect(nextCronFireMs("15,45 * * * *", local(2026, 9, 27, 8, 20))).toBe(local(2026, 9, 27, 8, 45));
    // 2026-09-27 は日曜。次の月曜 9:00。
    expect(nextCronFireMs("0 9 * * MON", local(2026, 9, 27, 8, 0))).toBe(local(2026, 9, 28, 9, 0));
    expect(nextCronFireMs("0 0 1 JAN *", local(2026, 9, 27))).toBe(local(2027, 1, 1));
  });

  test("曜日の 7 は日曜。日と曜日が両方制限されていれば OR", () => {
    expect(nextCronFireMs("0 9 * * 7", local(2026, 9, 26, 12, 0))).toBe(local(2026, 9, 27, 9, 0));
    // 毎月 1 日 または 月曜 → 9/27(日) の次は 9/28(月)。
    expect(nextCronFireMs("0 9 1 * 1", local(2026, 9, 27, 12, 0))).toBe(local(2026, 9, 28, 9, 0));
  });

  test("`*/n` で始まる日・曜日は無制限扱い（Vixie cron と同じく AND）", () => {
    // 奇数日 かつ 月曜。2026-09-28(月) は偶数日なので不一致 → 10/5(月, 奇数日)。
    expect(nextCronFireMs("0 9 */2 * 1", local(2026, 9, 27, 12, 0))).toBe(local(2026, 10, 5, 9, 0));
  });

  test("うるう日は 4 年先まで探す", () => {
    expect(nextCronFireMs("0 0 29 2 *", local(2026, 9, 27))).toBe(local(2028, 2, 29));
  });

  test("解釈できない式・存在しない日付は null", () => {
    expect(nextCronFireMs("@daily", local(2026, 9, 27))).toBeNull();
    expect(nextCronFireMs("61 * * * *", local(2026, 9, 27))).toBeNull();
    expect(nextCronFireMs("0 9 * *", local(2026, 9, 27))).toBeNull();
    expect(nextCronFireMs("0 0 31 2 *", local(2026, 9, 27))).toBeNull();
  });
});

describe("scheduledFromSessionCrons", () => {
  const now = local(2026, 9, 27, 8, 30, 35);
  const nowTs = Math.floor(now / 1000);

  test("1 回きりは発火時刻を秒で確定し、繰り返しは最初に見た時刻を持つ", () => {
    expect(scheduledFromSessionCrons([
      { id: "a", schedule: "51 8 * * *", recurring: false, prompt: "/loop tick" },
      { id: "b", schedule: "*/5 * * * *", recurring: true, prompt: "check" },
    ], now, { sessionId: "sid-1" })).toEqual({
      atTs: nowTs,
      sessionId: "sid-1",
      oneShotTs: [local(2026, 9, 27, 8, 51) / 1000],
      recurring: [{ id: "b", firstSeenTs: nowTs }],
      unparsed: false,
    });
  });

  test("同じ会話の次の Stop では繰り返し予約の最初に見た時刻を引き継ぐ（7 日失効の起点）", () => {
    const first = scheduledFromSessionCrons([{ id: "b", schedule: "0 * * * *" }], now, { sessionId: "sid-1" })!;
    const later = now + 3 * 24 * 3600_000;
    const crons = [{ id: "b", schedule: "0 * * * *" }, { id: "c", schedule: "0 9 * * *" }];
    expect(scheduledFromSessionCrons(crons, later, { sessionId: "sid-1", previous: first })?.recurring).toEqual([
      { id: "b", firstSeenTs: nowTs },
      { id: "c", firstSeenTs: Math.floor(later / 1000) },
    ]);
    // /clear（同じプロセスで session id だけ変わる）は pid が同じなら引き継ぐ。
    const withPid = scheduledFromSessionCrons(crons, now, { pid: 10, sessionId: "sid-1" })!;
    expect(scheduledFromSessionCrons(crons, later, { pid: 10, sessionId: "sid-9", previous: withPid })?.recurring[0])
      .toEqual({ id: "b", firstSeenTs: nowTs });
    expect(scheduledFromSessionCrons(crons, later, { pid: 11, sessionId: "sid-1", previous: withPid })?.recurring[0])
      .toEqual({ id: "b", firstSeenTs: Math.floor(later / 1000) });
    // 別の会話（同じ pane で起動し直し）の記録は引き継がない。
    expect(scheduledFromSessionCrons(crons, later, { sessionId: "sid-2", previous: first })?.recurring[0])
      .toEqual({ id: "b", firstSeenTs: Math.floor(later / 1000) });
  });

  test("recurring 欠落は既定の繰り返し扱い、解釈不能な 1 回きりは unparsed", () => {
    expect(scheduledFromSessionCrons([{ id: "x", schedule: "0 9 * * *" }], now)?.recurring).toHaveLength(1);
    expect(scheduledFromSessionCrons([{ schedule: "@hourly", recurring: false }], now)).toEqual({
      atTs: nowTs,
      oneShotTs: [],
      recurring: [],
      unparsed: true,
    });
  });

  test("予約 0 件・欄なし（旧 CLI）・配列以外は null（記録を消す）", () => {
    expect(scheduledFromSessionCrons([], now)).toBeNull();
    expect(scheduledFromSessionCrons(undefined, now)).toBeNull();
    expect(scheduledFromSessionCrons({}, now)).toBeNull();
  });
});
