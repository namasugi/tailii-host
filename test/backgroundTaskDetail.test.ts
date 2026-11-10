// backgroundTaskDetail.test.ts — バックグラウンドタスク表示の拡張（background-task-detail）の wire 往復。
// 正本は protocol/background-task-detail-v1.ndjson（root の protocol/ と byte 一致）。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeControlMessage, encodeControlMessage } from "../src/protocol.js";

const hostRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("golden: background-task-detail-v1.ndjson", () => {
  const lines = fs.readFileSync(path.join(hostRoot, "protocol", "background-task-detail-v1.ndjson"), "utf8")
    .split("\n").filter((line) => line.length > 0);

  it("全行が byte-exact でラウンドトリップする（hub 中継で command / exitCode / startTs を落とさない）", () => {
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
  });

  it("command / exitCode / startTs を復号する", () => {
    const nodes = lines.map((line) => (decodeControlMessage(line) as {
      node: { command?: string; exitCode?: number; startTs?: number };
    }).node);
    expect(nodes.map((node) => node.command)).toEqual(["cd /Users/me/app && npm run dev -- --port 3000", "npm test", undefined]);
    expect(nodes.map((node) => node.exitCode)).toEqual([undefined, 1, undefined]);
    expect(nodes.map((node) => node.startTs)).toEqual([1791681600000, 1791681600000, 1791681590000]);
  });
});
