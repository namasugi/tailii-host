// pushReview2.test.ts — レビュー指摘（登録解除の失敗・受付上限・再試行の取り消し・間引きの記録・Claude の版の観測）

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PushSendLog } from "../src/push/pushStateFiles.js";
import { PushDeviceStore } from "../src/push/pushDeviceStore.js";
import { handlePushRegister, handlePushUnregister } from "../src/push/pushRegistration.js";
import { decodeControlMessage, type ControlMessage } from "../src/protocol.js";
import { RelayTransport, type JsonPostResult, type JsonPoster } from "../src/push/pushTransport.js";
import { ClaudeVersionRecorder, findTrailingClaudeVersion, readObservedClaudeVersion } from "../src/shared/claudeVersionRecord.js";
import { makeTempDir } from "./helpers.js";
import { DEVICE_ID, sampleDevice } from "./pushTestHelpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("レビュー⑪: 登録解除の失敗を成功と返さない", () => {
  it("もともと無い → absent（成功扱い）、消せない → failed", () => {
    const base = makeTempDir("push-unregister");
    const store = new PushDeviceStore({ base, legacyApnsBase: makeTempDir("push-legacy") });
    expect(store.delete(DEVICE_ID)).toBe("absent");
    store.save(sampleDevice());
    expect(store.delete(DEVICE_ID)).toBe("deleted");
    // 記録の位置にディレクトリがある（unlink できない）。
    expect(handlePushUnregister(DEVICE_ID, store)).toBe("ok");
    fs.mkdirSync(path.join(base, "devices", `${DEVICE_ID}.json`));
    expect(store.delete(DEVICE_ID)).toBe("failed");
    expect(handlePushUnregister(DEVICE_ID, store)).toBe("failed");
    expect(store.delete("../x")).toBe("failed");
    expect(handlePushUnregister("../x", store)).toBe("failed");
  });
});

describe("レビュー⑫: 登録の受付をリレーと揃える", () => {
  const golden = fs.readFileSync(path.join(here, "..", "protocol", "push-v1.ndjson"), "utf8").split("\n").filter(Boolean);
  const register = (): Extract<ControlMessage, { type: "push_register" }> => {
    const message = decodeControlMessage(golden[0]!);
    if (message.type !== "push_register") throw new Error("unreachable");
    return message;
  };
  const stores = () => ({ store: new PushDeviceStore({ base: makeTempDir("push-limits"), legacyApnsBase: makeTempDir("push-legacy") }) });

  it("capability は 2048 バイト以内・印字可能な ASCII（golden の不透明な値は通る）", () => {
    expect(handlePushRegister(register(), stores()).status).toBe("ok");
    const relay = register().relay!;
    expect(handlePushRegister({ ...register(), relay: { ...relay, capability: "a".repeat(2048) } }, stores()).status).toBe("ok");
    for (const capability of ["a".repeat(2049), "あ".repeat(700), "has space", "tab\tx"]) {
      expect(handlePushRegister({ ...register(), relay: { ...relay, capability } }, stores()).status).toBe("failed");
    }
  });

  it("device token は小文字 16 進・偶数桁（リレーと同じ）", () => {
    expect(handlePushRegister({ ...register(), deviceToken: "0a1b2c3d4e5f607" }, stores()).status).toBe("failed");
    expect(handlePushRegister({ ...register(), deviceToken: "0A1B2C3D4E5F6071" }, stores()).status).toBe("failed");
    expect(handlePushRegister({ ...register(), deviceToken: "0a1b2c3d4e5f6071" }, stores()).status).toBe("ok");
  });
});

describe("レビュー⑥: リレーの再試行の前に有効性を確かめる", () => {
  it("初回 503 → 待つ間に取り消された通知は再試行で送らない", async () => {
    let valid = true;
    const calls: string[] = [];
    const poster: JsonPoster = {
      post: async (url): Promise<JsonPostResult> => { calls.push(url); return { ok: true, status: 503, body: "" }; },
    };
    const transport = new RelayTransport("https://relay.example", "cap", poster, { sleep: async () => { valid = false; } });
    const result = await transport.send({
      tp: { v: 1, k: "k", n: "n", c: "c" }, interruptionLevel: "active", collapseId: "c", expiration: 1,
      isStillValid: () => valid,
    });
    expect(result).toEqual({ status: "cancelled", detail: "cancelled" });
    expect(calls).toHaveLength(1);
  });
});


describe("間引きの記録（hub だけが書く）", () => {
  it("送信済みの時刻は後退しない・旧形式（sent / sending）の sent も読む", () => {
    const base = makeTempDir("send-log-monotonic");
    const log = new PushSendLog(base);
    log.record("turn_done", "s", 2_000);
    log.record("turn_done", "s", 1_000);
    expect(log.lastSent("turn_done", "s")).toBe(2_000);
    expect(new PushSendLog(base).lastSent("turn_done", "s")).toBe(2_000);
    const legacy = makeTempDir("send-log-legacy");
    fs.writeFileSync(path.join(legacy, "send-log.json"), JSON.stringify({ sent: { "question:s": 100 }, sending: {} }));
    expect(new PushSendLog(legacy).lastSent("question", "s")).toBe(100);
  });
});

describe("設計変更 B: Claude の版は transcript で観測する", () => {
  it("transcript 末尾の最後の行の version を読み、変わったときだけ記録する（下がっても最新に従う）", () => {
    const dir = makeTempDir("claude-version");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "user", version: "2.1.300", message: { content: "a" } }),
      JSON.stringify({ type: "assistant", version: "2.1.322", message: { content: [] } }),
      "{broken",
    ].join("\n") + "\n");
    expect(findTrailingClaudeVersion(transcript)).toBe("2.1.322");
    expect(findTrailingClaudeVersion(path.join(dir, "missing.jsonl"))).toBeNull();
    const file = path.join(dir, "record.json");
    expect(readObservedClaudeVersion(file)).toBeNull();
    const recorder = new ClaudeVersionRecorder(file);
    recorder.observe("2.1.322");
    expect(readObservedClaudeVersion(file)).toBe("2.1.322");
    const mtime = fs.statSync(file).mtimeMs;
    recorder.observe("2.1.322");
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    recorder.observe("2.1.318");
    expect(readObservedClaudeVersion(file)).toBe("2.1.318");
    recorder.observe("not a version");
    expect(readObservedClaudeVersion(file)).toBe("2.1.318");
  });
});
