// clientBuild.test.ts — iOS クライアントのビルド番号の記録と比較（host-auto-update）

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareBuild,
  parseBuildTuple,
  readLatestClientBuild,
  recordClientBuild,
} from "../src/shared/clientBuild.js";

function tempRecordPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tailii-client-build-")), "nested", "client-build.json");
}

describe("clientBuild — 解析と比較", () => {
  it("Apple の CFBundleVersion 規約（整数 1〜3 要素）だけを受理する", () => {
    expect(parseBuildTuple("4")).toEqual([4]);
    expect(parseBuildTuple("1.2.3")).toEqual([1, 2, 3]);
    expect(parseBuildTuple(" 12 ")).toEqual([12]);
    expect(parseBuildTuple("")).toBeNull();
    expect(parseBuildTuple("1.2.3.4")).toBeNull();
    expect(parseBuildTuple("4b")).toBeNull();
    expect(parseBuildTuple("1..2")).toBeNull();
  });

  it("欠けた要素は 0 とみなして比較し、規約外は null", () => {
    expect(compareBuild("4", "3")).toBe(1);
    expect(compareBuild("3", "4")).toBe(-1);
    expect(compareBuild("4", "4.0")).toBe(0);
    expect(compareBuild("4.1", "4")).toBe(1);
    expect(compareBuild("10", "9")).toBe(1);
    expect(compareBuild("dev", "4")).toBeNull();
  });
});

describe("clientBuild — 記録", () => {
  it("初回は記録し、より新しいビルドだけで前進する（古い接続で後退しない）", () => {
    const filePath = tempRecordPath();
    expect(readLatestClientBuild(filePath)).toBeNull();

    expect(recordClientBuild({ clientBuild: "3", clientVersion: "1.0.0" }, filePath, 1_000)).toBe(true);
    expect(readLatestClientBuild(filePath)).toBe("3");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      latestClientBuild: "3", clientVersion: "1.0.0", tsMs: 1_000,
    });

    expect(recordClientBuild({ clientBuild: "2" }, filePath, 2_000)).toBe(false);
    expect(recordClientBuild({ clientBuild: "3" }, filePath, 3_000)).toBe(false);
    expect(readLatestClientBuild(filePath)).toBe("3");

    expect(recordClientBuild({ clientBuild: "4", clientVersion: "1.0.1" }, filePath, 4_000)).toBe(true);
    expect(readLatestClientBuild(filePath)).toBe("4");
  });

  it("規約外のビルド番号は記録せず、壊れた記録は null として読む", () => {
    const filePath = tempRecordPath();
    expect(recordClientBuild({ clientBuild: "dev" }, filePath)).toBe(false);
    expect(readLatestClientBuild(filePath)).toBeNull();

    recordClientBuild({ clientBuild: "5" }, filePath);
    writeFileSync(filePath, "{not json");
    expect(readLatestClientBuild(filePath)).toBeNull();
    writeFileSync(filePath, JSON.stringify({ latestClientBuild: "x.y" }));
    expect(readLatestClientBuild(filePath)).toBeNull();
    // 壊れた記録の上には普通に書ける。
    expect(recordClientBuild({ clientBuild: "6" }, filePath)).toBe(true);
    expect(readLatestClientBuild(filePath)).toBe("6");
  });
});
