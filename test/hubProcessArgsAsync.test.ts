import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { classifyHubProcessAsync, ownCliPath, readProcessArgsAsync } from "../src/hub/hubStartup.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFile: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(), existsSync: vi.fn(() => false),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
function withoutProc() {
  vi.spyOn(fs.promises, "readFile").mockRejectedValue(Object.assign(new Error("no proc"), { code: "ENOENT" }));

}
function reply(error: unknown, stdout: string) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: unknown, stdout: string) => void)(error, stdout);
    return {} as ReturnType<typeof execFile>;
  });
}
it("Linux の argv が読めれば ps を呼ばず、同期版と同じ規則で hub を判定する", async () => {
  vi.spyOn(fs.promises, "readFile").mockResolvedValue(`node\0${ownCliPath()}\0hub\0`);
  expect(await classifyHubProcessAsync(42)).toBe("hub");
  expect(execFile).not.toHaveBeenCalled();
});
it("ps を待っている間も他のイベントを処理できる", async () => {
  withoutProc();
  let finish!: (error: unknown, stdout: string) => void;
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    finish = args.at(-1) as typeof finish;
    return {} as ReturnType<typeof execFile>;
  });
  const pending = classifyHubProcessAsync(42);
  await new Promise((resolve) => setImmediate(resolve));
  expect(execFile).toHaveBeenCalledWith("ps", ["-o", "command=", "-p", "42"], expect.objectContaining({ timeout: 3_000 }), expect.any(Function));
  finish(null, `node ${ownCliPath()} hub\n`);
  expect(await pending).toBe("hub");
});
it.each([
  [null, "", "unknown"],
  [{ code: 1 }, "", "gone"],
  [{ code: "EPERM" }, "", "unknown"],
  [{ code: null, killed: true }, "", "unknown"],
  [{ code: 1 }, "partial", "unknown"],
])("ps の失敗・空出力を安全側へ分類する: %j", async (error, stdout, kind) => {
  withoutProc(); reply(error, stdout as string);
  expect(await readProcessArgsAsync(42)).toEqual({ kind });
});
