// 起動口の引数判定だけを検証する。hub の実起動は hubDaemonCommand.test.ts で確認する。
import { afterEach, expect, it, vi } from "vitest";
import { delegateHubToGateway } from "../src/hub/gatewaySpawn.js";
import { claimHubStartup } from "../src/hub/hubStartup.js";
import { runHubCommand } from "../src/hub/hubDaemon.js";

vi.mock("../src/hub/gatewaySpawn.js", () => ({ delegateHubToGateway: vi.fn(async () => true) }));
vi.mock("../src/hub/hubStartup.js", async (original) => ({
  ...await original<typeof import("../src/hub/hubStartup.js")>(),
  claimHubStartup: vi.fn(async () => ({ kind: "busy", reason: "exclusive-held" })),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
it("GW の印を入口で一度だけ消費し、次の起動では委譲できる", async () => {
  vi.stubEnv("TAILII_HUB_VIA_GATEWAY", "1");
  expect(await runHubCommand([])).toBe(0);
  expect(process.env.TAILII_HUB_VIA_GATEWAY).toBeUndefined();
  expect(delegateHubToGateway).not.toHaveBeenCalled();
  expect(claimHubStartup).toHaveBeenCalledOnce();
  expect(await runHubCommand([])).toBe(0);
  expect(delegateHubToGateway).toHaveBeenCalledOnce();
});
it("引数なしだけを委譲する", async () => {
  expect(await runHubCommand([])).toBe(0);
  expect(delegateHubToGateway).toHaveBeenCalledOnce();
  expect(claimHubStartup).not.toHaveBeenCalled();
});
it.each([["--once"], ["--timeout-seconds", "30"], ["--interval-seconds", "60"]])("引数つきは元の起動経路へ進む: %j", async (...args) => {
  expect(await runHubCommand(args)).toBe(0);
  expect(delegateHubToGateway).not.toHaveBeenCalled();
  expect(claimHubStartup).toHaveBeenCalledOnce();
});
it("引数の検証も従来どおり行う", async () => {
  expect(await runHubCommand(["--timeout-seconds", "0"])).toBe(64);
  expect(delegateHubToGateway).not.toHaveBeenCalled();
  expect(claimHubStartup).not.toHaveBeenCalled();
});
