import { expect, it, vi } from "vitest";
import { ensureHerdrTailiiServerStarted } from "../src/commands/launch.js";

it("darwin 以外ではログインの判定を省いて自分で起こす", async () => {
  const loginKind = vi.fn();
  const ensureHub = vi.fn();
  const requestSpawn = vi.fn();
  const spawnLocal = vi.fn();
  await ensureHerdrTailiiServerStarted({ herdrSession: "tailii", platform: "linux", loginKind, ensureHub, requestSpawn, spawnLocal });
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
  await ensureHerdrTailiiServerStarted({ herdrSession: "tailii", platform: "darwin", loginKind, ensureHub, requestSpawn, spawnLocal });
  expect(loginKind).toHaveBeenCalledTimes(1);
  expect(ensureHub).not.toHaveBeenCalled();
  expect(requestSpawn).not.toHaveBeenCalled();
  expect(spawnLocal).toHaveBeenCalledTimes(1);
});

it("専用セッション以外ではログインの判定を省いて自分で起こす", async () => {
  const loginKind = vi.fn().mockResolvedValue("other");
  const ensureHub = vi.fn();
  const requestSpawn = vi.fn();
  const spawnLocal = vi.fn();
  await ensureHerdrTailiiServerStarted({ herdrSession: "default", platform: "darwin", loginKind, ensureHub, requestSpawn, spawnLocal });
  expect(loginKind).not.toHaveBeenCalled();
  expect(ensureHub).not.toHaveBeenCalled();
  expect(requestSpawn).not.toHaveBeenCalled();
  expect(spawnLocal).toHaveBeenCalledTimes(1);
});

it.each([
  ["other", "started"],
  ["unknown", "started"],
  ["other", "refused"],
  ["unknown", "unavailable"],
] as const)("画面側と確認できないときは hub の起動保証を待ってから頼む（%s、%s）", async (kind, result) => {
  const calls: string[] = [];
  await ensureHerdrTailiiServerStarted({
    herdrSession: "tailii",
    platform: "darwin",
    loginKind: async () => { calls.push("ログイン判定"); return kind; },
    ensureHub: async () => {
      await Promise.resolve();
      calls.push("hub の起動保証が完了");
    },
    requestSpawn: async () => { calls.push("起動依頼"); return result; },
    spawnLocal: () => { calls.push("自分で起動"); },
  });
  expect(calls).toEqual([
    "ログイン判定", "hub の起動保証が完了", "起動依頼",
    ...(result === "started" ? [] : ["自分で起動"]),
  ]);
});
