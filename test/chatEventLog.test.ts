import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ChatEventLog, readChatEvents } from "../src/hub/chatEventLog.js";
import { makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function logPath() {
  const dir = makeTempDir("chat-events");
  dirs.push(dir);
  return path.join(dir, "hub", "events.ndjson");
}

test("起動をまたいで通し番号を振り、ファイルと置き場の権限を絞る", () => {
  const file = logPath();
  const first = new ChatEventLog(file, { bootId: "123456789", now: () => 200 });
  first.append({ type: "hub_started", version: "1.2.3" });
  first.append({ type: "turn_started", session: "s-work", agent: "claude" });
  new ChatEventLog(file, { bootId: "abcdefgh9", now: () => 201 }).append({ type: "hub_started" });
  expect(readChatEvents(file, { limit: 10 }).events).toEqual([
    { v: 1, seq: 1, atMs: 200, boot: "12345678", type: "hub_started", version: "1.2.3" },
    { v: 1, seq: 2, atMs: 200, boot: "12345678", type: "turn_started", session: "s-work", agent: "claude" },
    { v: 1, seq: 3, atMs: 201, boot: "abcdefgh", type: "hub_started" },
  ]);
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test("回転をまたいで読めて、現在のファイルが空でも番号を引き継ぐ", () => {
  const file = logPath();
  const old = file.replace(".ndjson", ".1.ndjson");
  const options = { bootId: "12345678", now: () => 200, maxBytes: 240 };
  const writer = new ChatEventLog(file, options);
  for (let index = 0; index < 7; index++) writer.append({ type: "hub_started" });
  const all = readChatEvents(file, { limit: 20 });
  expect(all.events.map((event) => event.seq)).toEqual([4, 5, 6, 7]);
  expect(readChatEvents(file, { limit: 2 }).events.map((event) => event.seq)).toEqual([6, 7]);
  expect(readChatEvents(file, { after: { seq: 4, atMs: 200 }, limit: 2 }))
    .toMatchObject({ events: [{ seq: 5 }, { seq: 6 }], hasMore: true, gap: false, stale: false });
  expect(readChatEvents(file, { after: { seq: 3 }, limit: 20 })).toMatchObject({ gap: false, stale: false });
  expect(readChatEvents(file, { after: { seq: 2 }, limit: 20 })).toMatchObject({ gap: true, stale: false });
  expect(readChatEvents(file, { after: { seq: 4, atMs: 199 }, limit: 20 })).toMatchObject({ gap: true, stale: true });
  expect(readChatEvents(file, { after: { seq: 100 }, limit: 20 })).toMatchObject({ gap: true, stale: true });
  fs.renameSync(file, old);
  fs.writeFileSync(file, "");
  new ChatEventLog(file, options).append({ type: "hub_started" });
  expect(readChatEvents(file, { limit: 20 }).events.map((event) => event.seq)).toEqual([7, 8]);
});

test("壊れた行と書きかけの行を飛ばし、次の起動で書きかけを外して追記する", () => {
  const file = logPath();
  const options = { bootId: "12345678", now: () => 200 };
  const writer = new ChatEventLog(file, options);
  writer.append({ type: "hub_started", version: "狸".repeat(6000) });
  fs.appendFileSync(file, "{壊れた行}\n{\"v\":1,\"seq\":10,\"atMs\":200,\"boot\":\"x\",\"type\":\"turn_ended\"}\n");
  writer.append({ type: "turn_started", session: "s-work", agent: "claude" });
  const last = readChatEvents(file, { limit: 1 }).events[0]!;
  fs.appendFileSync(file, JSON.stringify({ ...last, seq: 3, body: "本文" }) + "\n");
  fs.appendFileSync(file, JSON.stringify({ ...last, seq: 99 }));
  expect(readChatEvents(file, { after: { seq: 1, atMs: 200 }, limit: 10 }))
    .toMatchObject({ events: [{ seq: 2 }, { seq: 3 }], gap: false });
  expect(readChatEvents(file, { limit: 1 }).events[0]).not.toHaveProperty("body");
  expect(readChatEvents(file, { limit: 10 }).events[0]).toMatchObject({ seq: 1, version: "狸".repeat(6000) });
  new ChatEventLog(file, options).append({ type: "hub_started" });
  expect(readChatEvents(file, { limit: 10 }).events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
});

test("書けない間の失敗は 1 回だけ知らせ、復旧後は通し番号を進める", () => {
  const file = logPath();
  const log = vi.fn();
  fs.writeFileSync(path.dirname(file), "置き場を作れない");
  const writer = new ChatEventLog(file, { bootId: "12345678", log });
  expect(() => writer.append({ type: "hub_started" })).not.toThrow();
  writer.append({ type: "hub_started" });
  expect(log).toHaveBeenCalledTimes(1);
  fs.unlinkSync(path.dirname(file));
  writer.append({ type: "hub_started" });
  expect(readChatEvents(file, { limit: 10 }).events).toMatchObject([{ seq: 1 }]);
  fs.renameSync(file, file + ".old");
  fs.mkdirSync(file);
  writer.append({ type: "hub_started" });
  writer.append({ type: "hub_started" });
  expect(log).toHaveBeenCalledTimes(2);
});

test("書き手を作っただけではファイルに触らず、2 つの書き手が交互に書いても番号が重ならない", () => {
  const file = logPath();
  const first = new ChatEventLog(file, { bootId: "aaaaaaaa", now: () => 300 });
  first.append({ type: "hub_started" });
  // 改行の無い書きかけ（別の書き手が書いている途中）を、作っただけの書き手が切り詰めない。
  fs.appendFileSync(file, "{\"v\":1");
  const sizeBefore = fs.statSync(file).size;
  const second = new ChatEventLog(file, { bootId: "bbbbbbbb", now: () => 301 });
  expect(fs.statSync(file).size).toBe(sizeBefore);
  fs.truncateSync(file, sizeBefore - 6);
  // 入れ替わりの途中: 前の hub がまだ書き、次の hub も書く。
  first.append({ type: "turn_started", session: "s-a", agent: "claude" });
  second.append({ type: "hub_started" });
  first.append({ type: "turn_started", session: "s-b", agent: "claude" });
  second.append({ type: "turn_started", session: "s-c", agent: "codex" });
  expect(readChatEvents(file, { limit: 10 }).events.map((event) => [event.seq, event.boot])).toEqual([
    [1, "aaaaaaaa"], [2, "aaaaaaaa"], [3, "bbbbbbbb"], [4, "aaaaaaaa"], [5, "bbbbbbbb"],
  ]);
});
