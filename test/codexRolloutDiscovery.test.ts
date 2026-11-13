import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexRolloutTailer } from "../src/codex/codexRolloutTailer.js";
import { makeTempDir } from "./helpers.js";

// 実ファイルは読む。stat / open の回数だけ記録し、別 ID を解析しないことを確かめる。
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, statSync: vi.fn(fs.statSync), openSync: vi.fn(fs.openSync) };
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });
const wanted = "01a1aa69-1559-7093-a856-66d910b2e646";
const other = "01a1aac2-cbca-7160-baf7-995a75a90c2c";
const name = (id: string) => `rollout-2026-11-05T15-32-55-${id}.jsonl`;
function put(root: string, date: string, filename: string, id: string, cwd: string) {
  const file = path.join(root, date, filename); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n"); return file;
}
function clearIo() { vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.statSync).mockClear(); }

it("既知 ID では別 ID の平文・圧縮ファイルを stat / open しない", () => {
  const root = makeTempDir("rollout-select"); const cwd = makeTempDir("rollout-cwd");
  const skip = put(root, "2026/11/05", name(other), other, cwd);
  fs.writeFileSync(skip + ".zst", "compressed");
  const match = put(root, "2026/11/04", name(wanted), wanted, cwd); clearIo();
  expect(CodexRolloutTailer.resolveRollout(cwd, root, Date.now() + 1000, wanted)).toBe(match);
  expect(fs.statSync).toHaveBeenCalledTimes(1);
  expect(fs.openSync).toHaveBeenCalledTimes(1);
  expect(fs.openSync).toHaveBeenCalledWith(match, "r");
});

it("名前で一致しても session_meta の ID と cwd を確認する", () => {
  const root = makeTempDir("rollout-verify"); const cwd = makeTempDir("rollout-cwd");
  put(root, "2026/11/05", name(wanted), other, cwd);
  put(root, "2026/11/06", name(wanted), wanted, "/other");
  const alias = put(root, "moved", "renamed.jsonl", wanted, cwd);
  expect(CodexRolloutTailer.resolveRollout(cwd, root, null, wanted)).toBe(alias);
});

it("旧名・改名ファイルは従来の先頭解析へ戻り、ID なしでは全体の最新を選ぶ", () => {
  const root = makeTempDir("rollout-legacy"); const cwd = makeTempDir("rollout-cwd");
  const alias = put(root, "old", "rollout-old.jsonl", wanted, cwd);
  const newer = put(root, "new", name(other), other, cwd);
  fs.utimesSync(alias, 1, 1); fs.utimesSync(newer, 2, 2);
  expect(CodexRolloutTailer.resolveRollout(cwd, root, null, wanted)).toBe(alias);
  expect(CodexRolloutTailer.resolveRollout(cwd, root)).toBe(newer);
});

it("重複は mtime 最新を選び、移動・圧縮・平文への復元を次の探索に反映する", () => {
  const root = makeTempDir("rollout-move"); const cwd = makeTempDir("rollout-cwd");
  const first = put(root, "2026/11/04", name(wanted), wanted, cwd);
  const second = put(root, "2026/11/05", name(wanted), wanted, cwd);
  fs.utimesSync(first, 1, 1); fs.utimesSync(second, 2, 2);
  expect(CodexRolloutTailer.resolveRollout(cwd, root, null, wanted)).toBe(second);
  const moved = path.join(root, "archive", name(wanted)); fs.mkdirSync(path.dirname(moved)); fs.renameSync(second, moved);
  expect(CodexRolloutTailer.resolveRollout(cwd, root, null, wanted)).toBe(moved);
  fs.unlinkSync(first); fs.renameSync(moved, moved + ".zst");
  // tail は平文だけを扱う既存の契約。圧縮ファイルを JSONL として開かない。
  clearIo(); expect(CodexRolloutTailer.resolveRollout(cwd, root, null, wanted)).toBeNull();
  expect(fs.openSync).not.toHaveBeenCalled();
  fs.renameSync(moved + ".zst", moved);
  expect(CodexRolloutTailer.resolveRollout(cwd, root, null, wanted)).toBe(moved);
});

it("未発見の探索は 50ms から倍々で最大 1 秒に抑え、出現後は直ちに読む", async () => {
  vi.useFakeTimers(); const root = makeTempDir("rollout-backoff"); const cwd = makeTempDir("rollout-cwd");
  const resolve = vi.spyOn(CodexRolloutTailer, "resolveRollout");
  const abort = new AbortController(); const tailer = new CodexRolloutTailer({ sessionsRoot: root, tailIndefinitely: true });
  const stream = tailer.streamForCwd(cwd, null, abort.signal, wanted); const next = stream.next();
  for (const [ms, calls] of [[0, 1], [50, 2], [100, 3], [200, 4], [400, 5], [800, 6], [1000, 7]] as const) {
    await vi.advanceTimersByTimeAsync(ms); expect(resolve).toHaveBeenCalledTimes(calls);
  }
  const match = put(root, "2026/11/05", name(wanted), wanted, cwd);
  fs.appendFileSync(match, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "appeared" } }) + "\n");
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await next).value).toMatchObject({ type: "chat_output", text: "appeared" });
  abort.abort(); await stream.return();
});

it("探索の待機は有限期限を超えず、abort でも即座に終了する", async () => {
  vi.useFakeTimers(); const root = makeTempDir("rollout-deadline");
  const finite = new CodexRolloutTailer({ sessionsRoot: root, tailDeadlineMs: 120 });
  const next = finite.streamForCwd(root).next(); await vi.advanceTimersByTimeAsync(120);
  expect(await next).toEqual({ done: true, value: undefined });
  const abort = new AbortController();
  const infinite = new CodexRolloutTailer({ sessionsRoot: root, tailIndefinitely: true });
  const stopped = infinite.streamForCwd(root, null, abort.signal).next();
  abort.abort(); expect(await stopped).toEqual({ done: true, value: undefined });
});
