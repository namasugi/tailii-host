// toolDenial.test.ts — 実行されなかった / 中断されたツール呼び出し（tool-denial, 2026-10-11 の CLI 追随）
// 拒否 / 中断で終わったツール呼び出しのカードへ理由を後付けする（Claude Code の toolDenialKind）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractToolActivities, extractTurn, notRunToolLabel, TranscriptTailer } from "../src/chat/transcriptTailer.js";
import {
  decodeControlMessage, encodeControlMessage, isToolDenialKind, TOOL_DENIAL_KINDS,
} from "../src/protocol.js";

const hostRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function assistantToolUse(uuid: string, id: string, command: string): string {
  return JSON.stringify({ type: "assistant", uuid, timestamp: "2026-10-11T00:00:00.000Z", message: {
    role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
  } });
}

function toolResult(
  uuid: string, id: string, options: { isError?: boolean; kind?: unknown; text?: string } = {},
): string {
  return JSON.stringify({
    type: "user", uuid, timestamp: "2026-10-11T00:00:01.000Z",
    ...(options.kind !== undefined ? { toolDenialKind: options.kind } : {}),
    message: { role: "user", content: [{
      type: "tool_result", tool_use_id: id, content: options.text ?? "result",
      ...(options.isError === true ? { is_error: true } : {}),
    }] },
  });
}

async function streamCards(lines: string[]): Promise<{ id: string; label: string; denial: string | undefined }[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-tool-denial-"));
  try {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const tailer = new TranscriptTailer({ tailDeadlineMs: 200, pollIntervalMs: 10 });
    const cards: { id: string; label: string; denial: string | undefined }[] = [];
    for await (const message of tailer.streamTranscript(file)) {
      if (message.type !== "tool_activity") continue;
      cards.push({ id: message.activity.id, label: message.activity.label, denial: message.activity.denial });
    }
    return cards;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function streamActivities(lines: string[]): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-tool-denial-"));
  try {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const tailer = new TranscriptTailer({ tailDeadlineMs: 200, pollIntervalMs: 10 });
    const activities: string[] = [];
    for await (const message of tailer.streamTranscript(file)) {
      if (message.type === "tool_activity") activities.push(`${message.activity.id}:${message.activity.denial ?? "-"}`);
    }
    return activities;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("tool-denial: 拒否 / 中断で終わったツール呼び出し", () => {
  it("既知の区分だけを toolDenialKind として読む", () => {
    for (const kind of TOOL_DENIAL_KINDS) expect(isToolDenialKind(kind)).toBe(true);
    for (const kind of ["", "automode", "USER-REJECTED", null, undefined, 1, {}]) {
      expect(isToolDenialKind(kind)).toBe(false);
    }
  });

  it("行の toolDenialKind とエラーの tool_result から toolDenials を拾う", () => {
    expect(extractTurn(toolResult("u1", "toolu_a", { isError: true, kind: "automode-unavailable" }))?.toolDenials)
      .toEqual([{ toolUseId: "toolu_a", kind: "automode-unavailable" }]);
  });

  it("成功した結果・区分の無いエラー・未知の区分には印を付けない", () => {
    // 区分が付いていても、エラーでない tool_result は実行されている。
    expect(extractTurn(toolResult("u1", "toolu_a", { kind: "user-rejected" }))?.toolDenials).toBeUndefined();
    // 実行して失敗しただけのエラー（区分なし）は「実行されなかった」ではない。
    expect(extractTurn(toolResult("u2", "toolu_a", { isError: true }))?.toolDenials).toBeUndefined();
    expect(extractTurn(toolResult("u3", "toolu_a", { isError: true, kind: "someday-new-kind" }))?.toolDenials)
      .toBeUndefined();
    expect(extractTurn(toolResult("u4", "toolu_a", { isError: true, kind: 1 }))?.toolDenials).toBeUndefined();
  });

  it("tail で理由付きの tool_activity が同じ id で再送される（成功した呼び出しは再送しない）", async () => {
    expect(await streamActivities([
      assistantToolUse("a1", "toolu_ok", "ls"),
      toolResult("u1", "toolu_ok"),
      assistantToolUse("a2", "toolu_auto", "npm publish"),
      toolResult("u2", "toolu_auto", { isError: true, kind: "automode-unavailable" }),
      assistantToolUse("a3", "toolu_fail", "false"),
      toolResult("u3", "toolu_fail", { isError: true }),
      assistantToolUse("a4", "toolu_rej", "rm -rf build"),
      toolResult("u4", "toolu_rej", { isError: true, kind: "user-rejected" }),
    ])).toEqual([
      "toolu_ok:-",
      "toolu_auto:-", "toolu_auto:automode-unavailable",
      "toolu_fail:-",
      "toolu_rej:-", "toolu_rej:user-rejected",
    ]);
  });

  it("札を付ける再送は、済んだ形のラベル（実行済み … 等）を言い換える", async () => {
    expect(await streamCards([
      assistantToolUse("a1", "toolu_rej", "rm -rf build"),
      toolResult("u1", "toolu_rej", { isError: true, kind: "permission-rule" }),
    ])).toEqual([
      { id: "toolu_rej", label: "実行済み rm -rf build", denial: undefined },
      { id: "toolu_rej", label: "実行 rm -rf build", denial: "permission-rule" },
    ]);
  });

  it("makeToolActivity が出す済んだ形のラベルは、どのツールでも言い換えられる", () => {
    const labelOf = (name: string, input: Record<string, unknown>): string =>
      extractToolActivities([{ type: "tool_use", id: "t", name, input }])[0]!.label;
    const cases: [string, Record<string, unknown>, string][] = [
      ["Bash", { command: "ls" }, "実行 "],
      ["Edit", { file_path: "/p/a.swift", old_string: "a", new_string: "b" }, "編集 "],
      ["Write", { file_path: "/p/a.swift", content: "x" }, "作成 "],
      ["Read", { file_path: "/p/a.swift" }, "読み取り "],
      ["Grep", { pattern: "x" }, "検索 "],
      ["Skill", { skill: "deploy" }, "実行 "],
      ["WebFetch", { url: "https://example.com" }, "実行 "],
    ];
    for (const [name, input, prefix] of cases) {
      const label = labelOf(name, input);
      const rewritten = notRunToolLabel(label);
      expect(rewritten, `${name}: ${label}`).not.toMatch(/済み|既読|しました/);
      expect(rewritten.startsWith(prefix), `${name}: ${label} → ${rewritten}`).toBe(true);
    }
    expect(notRunToolLabel(labelOf("TodoWrite", { todos: [{ content: "a", status: "pending" }] }))).toBe("Todoを更新");
    // iOS が公開カードの判定に使う接頭辞と、済んだ形ではないラベルは変えない。
    const publish = labelOf("Artifact", { file_path: "/tmp/g.html", title: "G" });
    expect(publish.startsWith("Artifact を公開")).toBe(true);
    expect(notRunToolLabel(publish)).toBe(publish);
    const send = labelOf("SendUserFile", { files: ["/tmp/a.pdf"] });
    expect(notRunToolLabel(send)).toBe(send);
  });

  it("結果待ちのカードは 64 件までで、溢れた最古のぶんには札を付けない", async () => {
    const ids = Array.from({ length: 70 }, (_, index) => `toolu_many_${String(index).padStart(2, "0")}`);
    const parallel = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-10-11T00:00:00.000Z", message: {
      role: "assistant", model: "claude-opus-5-5",
      content: ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: id } })),
    } });
    const cards = await streamCards([
      parallel,
      ...ids.map((id, index) => toolResult(`u${index}`, id, { isError: true, kind: "cancelled" })),
    ]);
    const denied = cards.filter((card) => card.denial !== undefined).map((card) => card.id);
    expect(denied).toEqual(ids.slice(6));
  });

  it("並列呼び出しは結果の届いたものだけに印が付き、結果が 2 度届いても再送は 1 回", async () => {
    const parallel = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-10-11T00:00:00.000Z", message: {
      role: "assistant", model: "claude-opus-5-5", content: [
        { type: "tool_use", id: "toolu_p1", name: "Bash", input: { command: "one" } },
        { type: "tool_use", id: "toolu_p2", name: "Bash", input: { command: "two" } },
      ],
    } });
    expect(await streamActivities([
      parallel,
      toolResult("u1", "toolu_p2", { isError: true, kind: "permission-rule" }),
      toolResult("u2", "toolu_p1"),
      // 同じ tool_use への結果がもう一度現れても（再開時の合成行など）、カードは待ち行列から外れている。
      toolResult("u3", "toolu_p2", { isError: true, kind: "interrupted" }),
    ])).toEqual(["toolu_p1:-", "toolu_p2:-", "toolu_p2:permission-rule"]);
  });

  it("対応する tool_use が無い結果（窓の外）は何も送らない", async () => {
    expect(await streamActivities([
      toolResult("u1", "toolu_unknown", { isError: true, kind: "user-rejected" }),
    ])).toEqual([]);
  });

  it("未知の denial は復号で捨て、カード自体は残す", () => {
    const decoded = decodeControlMessage(JSON.stringify({
      type: "tool_activity", v: 1, id: "t1", name: "Bash", label: "実行 ls", denial: "someday-new-kind",
    }));
    expect(decoded).toMatchObject({ type: "tool_activity", activity: { id: "t1" } });
    expect((decoded as { activity: { denial?: string } }).activity.denial).toBeUndefined();
  });
});

describe("golden: tool-denial-v1.ndjson", () => {
  const read = (name: string): string[] =>
    fs.readFileSync(path.join(hostRoot, "protocol", name), "utf8").split("\n").filter((line) => line.length > 0);

  it("全行が byte-exact でラウンドトリップし、denial を復号する", () => {
    const lines = read("tool-denial-v1.ndjson");
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(encodeControlMessage(decodeControlMessage(line))).toBe(line);
    expect(lines.map((line) => (decodeControlMessage(line) as { activity: { denial?: string } }).activity.denial))
      .toEqual(["automode-unavailable", "user-rejected", "permission-rule", "interrupted"]);
  });
});
