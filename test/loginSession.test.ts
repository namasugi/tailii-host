import { expect, it, vi } from "vitest";
import { loginSessionKind } from "../src/shared/loginSession.js";

it.each([
  [" Aqua\n", "screen"],
  ["Background\n", "other"],
  ["System", "other"],
  [" \t\n", "unknown"],
] as const)("managername の出力 %j を %s と判定する", async (stdout, kind) => {
  const run = vi.fn().mockResolvedValue({ stdout });
  await expect(loginSessionKind({ platform: "darwin", run })).resolves.toBe(kind);
  expect(run).toHaveBeenCalledExactlyOnceWith("/bin/launchctl", ["managername"], { timeout: 1_000 });
});

it.each([new Error("実行失敗"), { killed: true, signal: "SIGTERM" }])("実行失敗・時間切れは unknown", async (error) => {
  const run = vi.fn().mockRejectedValue(error);
  await expect(loginSessionKind({ platform: "darwin", run })).resolves.toBe("unknown");
});

it("darwin 以外では launchctl を実行しない", async () => {
  const run = vi.fn();
  await expect(loginSessionKind({ platform: "linux", run })).resolves.toBe("unknown");
  expect(run).not.toHaveBeenCalled();
});
