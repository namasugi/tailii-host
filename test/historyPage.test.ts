import { describe, expect, it } from "vitest";
import type { ControlMessage } from "../src/protocol.js";
import { sliceHistoryPage } from "../src/hub/historyPage.js";

const text = (streamId: string, role: "user" | "assistant" | "system" = "assistant"): ControlMessage =>
  ({ type: "chat_output", v: 1, streamId, role, text: streamId, eof: true });
const tool = (id: string): ControlMessage =>
  ({ type: "tool_activity", v: 1, activity: { id, name: "Bash", label: id, commandTruncated: false, descriptionTruncated: false } });
const alias = (streamId: string, aliasStreamIds: string[]): ControlMessage =>
  ({ type: "chat_stream_alias", v: 1, streamId, aliasStreamIds });
const image = (id: string): ControlMessage =>
  ({ type: "image_available", v: 1, id, path: `/tmp/${id}.png`, mime: "image/png", thumbnail: "", width: 1, height: 1 });
const ids = (events: ControlMessage[]): string[] => events.map((event) => {
  switch (event.type) {
    case "chat_output": return event.streamId;
    case "tool_activity": return `tool:${event.activity.id}`;
    case "chat_stream_alias": return `alias:${event.streamId}`;
    case "image_available": return `image:${event.id}`;
    default: return event.type;
  }
});

describe("sliceHistoryPage（history-page）", () => {
  const history: ControlMessage[] = [
    text("pc:history-begin", "system"),
    text("u1", "user"), text("a1"),
    tool("t1"), tool("t2"), image("read-t2"),
    alias("u2", ["client-u2"]), text("u2", "user"),
    text("pc:model", "system"),
    text("a2"), tool("t3"),
  ];

  it("最新のページは末尾から limit 行ぶん（連続ツールは 1 行・現在値のマーカーは最後の値だけ末尾に添える）", () => {
    const withOldModel = [text("pc:model", "system"), ...history];
    const page = sliceHistoryPage(withOldModel, null, 3);
    expect(ids(page.events)).toEqual(["alias:u2", "u2", "a2", "tool:t3", "pc:model"]);
    expect(page.events.filter((e) => e.type === "chat_output" && e.streamId === "pc:model")).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.anchorFound).toBe(true);
  });

  it("遡るページは終端の行より前の limit 行ぶん（画像は直前の行に付く・マーカーは載せない）", () => {
    const page = sliceHistoryPage(history, { streamId: "u2" }, 2);
    expect(ids(page.events)).toEqual(["a1", "tool:t1", "tool:t2", "image:read-t2"]);
    expect(page.hasMore).toBe(true);
    const oldest = sliceHistoryPage(history, { streamId: "a1" }, 5);
    expect(ids(oldest.events)).toEqual(["u1"]);
    expect(oldest.hasMore).toBe(false);
  });

  it("stream 別名・ツール id でも終端を引ける", () => {
    expect(ids(sliceHistoryPage(history, { streamId: "client-u2" }, 1).events)).toEqual(["tool:t1", "tool:t2", "image:read-t2"]);
    expect(ids(sliceHistoryPage(history, { toolId: "t3" }, 1).events)).toEqual(["a2"]);
  });

  it("終端が見つからなければ空（anchorFound=false）", () => {
    expect(sliceHistoryPage(history, { streamId: "missing" }, 5)).toEqual({ events: [], hasMore: false, anchorFound: false });
  });

  it("ツールの更新は元のカードと同じページで渡す（前のページの更新は載せず、このページのツールは最終内容を添える）", () => {
    const updatedTool = (id: string, label: string): ControlMessage =>
      ({ type: "tool_activity", v: 1, activity: { id, name: "Skill", label, commandTruncated: false, descriptionTruncated: false } });
    const all = [text("a1"), updatedTool("s1", "初回"), text("a2"), text("a3"), updatedTool("s1", "本文付き"), text("a4")];
    const newest = sliceHistoryPage(all, null, 2);
    expect(ids(newest.events)).toEqual(["a3", "a4"]);
    const older = sliceHistoryPage(all, { streamId: "a3" }, 2);
    expect(ids(older.events)).toEqual(["tool:s1", "a2", "tool:s1"]);
    expect(older.events.at(-1)).toMatchObject({ activity: { label: "本文付き" } });
  });

  it("既出 id のツール（後着の内容更新）は新しい行に数えない", () => {
    const updated = [text("a1"), tool("t1"), text("a2"), tool("t1")];
    const page = sliceHistoryPage(updated, null, 1);
    // 元のカードは前のページ。更新はこのページに載せず、前のページに最終内容として添える。
    expect(ids(page.events)).toEqual(["a2"]);
    expect(ids(sliceHistoryPage(updated, { streamId: "a2" }, 1).events)).toEqual(["tool:t1", "tool:t1"]);
  });
});
