import { expect, it, vi } from "vitest";
import { ensureHerdrServerStarted } from "../src/commands/launch.js";

it("darwin 以外ではログインの判定を省いて自分で起こす", async () => {
  const loginKind = vi.fn();
  const ensureHub = vi.fn();
  const requestSpawn = vi.fn();
  const spawnLocal = vi.fn();
  await ensureHerdrServerStarted({ herdrSession: "default", platform: "linux", loginKind, ensureHub, requestSpawn, spawnLocal });
  expect(loginKind).not.toHaveBeenCalled();
  expect(ensureHub).not.toHaveBeenCalled();
  expect(requestSpawn).not.toHaveBeenCalled();
  expect(spawnLocal).toHaveBeenCalledTimes(1);
});

it("画面のログインでは自分で起こす", async () => {
  const loginKind = vi.fn().mockResolvedValue("screen");
  const ensureHub = vi.fn();
  const requestSpawn = vi.fn();
  const spawnLocal = vi.fn();
  await ensureHerdrServerStarted({ herdrSession: "work", platform: "darwin", loginKind, ensureHub, requestSpawn, spawnLocal });
  expect(loginKind).toHaveBeenCalledTimes(1);
  expect(ensureHub).not.toHaveBeenCalled();
  expect(requestSpawn).not.toHaveBeenCalled();
  expect(spawnLocal).toHaveBeenCalledTimes(1);
});

it.each([
  ["tailii", "other", "started"],
  ["default", "other", "started"],
  ["work", "unknown", "started"],
  ["work", "other", "refused"],
  ["work", "unknown", "unavailable"],
] as const)("画面側と確認できないときは hub へ収容先を渡す（%s、%s、%s）", async (herdrSession, kind, result) => {
  const calls: string[] = [];
  await ensureHerdrServerStarted({
    herdrSession,
    platform: "darwin",
    loginKind: async () => { calls.push("ログイン判定"); return kind; },
    ensureHub: async () => {
      await Promise.resolve();
      calls.push("hub の起動保証が完了");
    },
    requestSpawn: async (session) => { calls.push(`起動依頼 ${session}`); return result; },
    spawnLocal: () => { calls.push("自分で起動"); },
  });
  expect(calls).toEqual([
    "ログイン判定", "hub の起動保証が完了", `起動依頼 ${herdrSession}`,
    ...(result === "started" ? [] : ["自分で起動"]),
  ]);
});
