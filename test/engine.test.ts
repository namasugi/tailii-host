// engine.test.ts — EngineControl（engine サブコマンド）テスト
// Swift 版 EngineTests.swift の移植。in-memory ストリームで入力行を流し込み、出力行を検証する。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { ImageService } from "../src/imageService.js";
import type { EngineLauncher } from "../src/launch.js";
import { ClaudeSessionStore } from "../src/claudeSessionStore.js";
import { decodeControlMessage } from "../src/protocol.js";
import { TranscriptTailer } from "../src/transcriptTailer.js";
import { TmuxSessionManager } from "../src/tmux.js";
import {
  MockTmuxRunner,
  makeTempDir,
  makeTempStore,
  ok,
  startEngine,
  waitForCommand,
} from "./helpers.js";

function makeManager(runner: MockTmuxRunner, store = makeTempStore()): TmuxSessionManager {
  return new TmuxSessionManager({ runner: runner.runner, store });
}

describe("EngineControl — 横断制御チャネル", () => {
  // MARK: 1. channel_hello 交換

  test("engine は確立直後に channel_hello を送出し、相手 hello 受信後に採用版を決める", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    const hello = await engine.lines.nextOfType("channel_hello");
    expect(hello).toContain('"maxVersion":2');
    expect(hello).toContain('"v":1');

    engine.writeLine('{"maxVersion":1,"type":"channel_hello","v":1}');
    await engine.teardown();
  });

  // MARK: 2. session_list_request → session_list_response

  test("session_list_request に session_list_response を返す（list 橋渡し）", async () => {
    const store = makeTempStore();
    store.put({ name: "alpha", cwd: "/tmp/alpha", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("alpha\n") : ok("")));
    const engine = startEngine({ sessionManager: makeManager(runner, store) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"L1","type":"session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L1"');
    expect(resp).toContain('"name":"alpha"');
    expect(resp).toContain('"cwd":"/tmp/alpha"');
    expect(resp).toContain('"alive":true');

    await engine.teardown();
  });

  // MARK: 3. session_reattach（不在） → error(session_not_found)

  test("不在 session_reattach に error(session_not_found) を返す", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"R1","name":"ghost","type":"session_reattach","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"session_not_found"');

    await engine.teardown();
  });

  // MARK: 4. session_kill → tmux kill-session

  test("session_kill で tmux kill-session -t <name> が発行される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"K1","name":"doomed","type":"session_kill","v":1}');

    expect(await waitForCommand(runner, ["kill-session", "-t", "doomed"])).toBe(true);

    await engine.teardown();
  });

  // MARK: 5. session_start → launcher 結線

  test("session_start が launcher へ橋渡しされ、成功で session_list_response が返る", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("fresh\n") : ok("")));
    const recorded: string[][] = [];
    const launcher: EngineLauncher = async (cwd, name) => {
      recorded.push([cwd, name]);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({ sessionManager: makeManager(runner, store), launcher });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/tmp/fresh-dir","id":"S1","name":"fresh","type":"session_start","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"S1"');
    expect(resp).toContain('"name":"fresh"');
    expect(resp).toContain('"cwd":"/tmp/fresh-dir"');
    expect(resp).toContain('"alive":true');
    expect(recorded).toEqual([["/tmp/fresh-dir", "fresh"]]);

    await engine.teardown();
  });

  // MARK: 5b. session_start の per-session agent ルーティング（claude/codex）

  test("agentType でセッション毎に claude/codex launcher を選ぶ（未指定は defaultAgent）", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("s\n") : ok("")));
    const claudeHits: string[] = [];
    const codexHits: string[] = [];
    const mk = (sink: string[]): EngineLauncher => async (cwd, name) => {
      sink.push(name);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      launcher: mk(claudeHits),
      codexLauncher: mk(codexHits),
      // host 既定は claude。未指定 agentType は claude へ倒れる。
      agent: "claude",
    });

    await engine.lines.nextOfType("channel_hello");
    // 1) agentType=codex → codexLauncher
    engine.writeLine('{"cwd":"/tmp/a","id":"S1","name":"cdx","type":"session_start","v":1,"agentType":"codex"}');
    await engine.lines.nextOfType("session_list_response");
    // 2) agentType=claude → claude launcher
    engine.writeLine('{"cwd":"/tmp/a","id":"S2","name":"cla","type":"session_start","v":1,"agentType":"claude"}');
    await engine.lines.nextOfType("session_list_response");
    // 3) 未指定 → defaultAgent(claude)
    engine.writeLine('{"cwd":"/tmp/a","id":"S3","name":"def","type":"session_start","v":1}');
    await engine.lines.nextOfType("session_list_response");

    expect(codexHits).toEqual(["cdx"]);
    expect(claudeHits).toEqual(["cla", "def"]);

    await engine.teardown();
  });

  test("defaultAgent=codex のとき agentType 未指定は codexLauncher へ倒れる", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("s\n") : ok("")));
    const claudeHits: string[] = [];
    const codexHits: string[] = [];
    const mk = (sink: string[]): EngineLauncher => async (cwd, name) => {
      sink.push(name);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({
      sessionManager: makeManager(runner, store),
      launcher: mk(claudeHits),
      codexLauncher: mk(codexHits),
      agent: "codex",
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/tmp/a","id":"S1","name":"def","type":"session_start","v":1}');
    await engine.lines.nextOfType("session_list_response");

    expect(codexHits).toEqual(["def"]);
    expect(claudeHits).toEqual([]);

    await engine.teardown();
  });

  test("session_start（resume なし）は生成 session-id と会話名 title を launcher へ渡す（流入防止 + lazy-session）", async () => {
    const store = makeTempStore();
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("fresh\n") : ok("")));
    const args: (string | null | undefined)[][] = [];
    const launcher: EngineLauncher = async (cwd, name, baseDir, resumeSessionId, newSessionId, title) => {
      args.push([cwd, name, baseDir, resumeSessionId, newSessionId, title]);
      store.put({ name, cwd, createdAt: 7 });
      return { exitCode: 0, errorText: "" };
    };
    const engine = startEngine({ sessionManager: makeManager(runner, store), launcher });

    await engine.lines.nextOfType("channel_hello");
    // 新規(会話名あり) / 新規(会話名なし) / resume の 3 起動を投入する。
    engine.writeLine(
      '{"cwd":"/tmp/fresh-dir","id":"S1","name":"n1","title":"My Chat","type":"session_start","v":1}',
    );
    await engine.lines.nextOfType("session_list_response");
    engine.writeLine('{"cwd":"/tmp/fresh-dir","id":"S1b","name":"n1b","type":"session_start","v":1}');
    await engine.lines.nextOfType("session_list_response");
    engine.writeLine(
      '{"cwd":"/tmp/fresh-dir","id":"S2","name":"n2","resumeSessionId":"keep-me","type":"session_start","v":1}',
    );
    await engine.lines.nextOfType("session_list_response");

    // 新規(会話名あり): resumeSessionId=null、newSessionId は生成 uuid、title は会話名を転送。
    const named = args.find((a) => a[1] === "n1")!;
    expect(named[3]).toBeNull();
    expect(named[4]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(named[5]).toBe("My Chat");
    // 新規(会話名なし): title は null（--name を付けない）。
    const unnamed = args.find((a) => a[1] === "n1b")!;
    expect(unnamed[4]).toMatch(/^[0-9a-f]{8}-/i);
    expect(unnamed[5]).toBeNull();
    // resume 起動: 既存 id を使い、生成 id も title も渡さない。
    const resumed = args.find((a) => a[1] === "n2")!;
    expect(resumed[3]).toBe("keep-me");
    expect(resumed[4]).toBeNull();
    expect(resumed[5]).toBeNull();

    await engine.teardown();
  });

  test("launcher 失敗（非0 exit）で error(launch_failed) が返る", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const launcher: EngineLauncher = async () => ({
      exitCode: 1,
      errorText: "tailii-host launch: 作業ディレクトリが存在しません",
    });
    const engine = startEngine({ sessionManager: makeManager(runner), launcher });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/nope","id":"S2","name":"bad","type":"session_start","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"launch_failed"');
    expect(err).toContain('"id":"S2"');
    expect(err).toContain("作業ディレクトリが存在しません");

    // engine は継続稼働している（後続 list が処理される）。
    engine.writeLine('{"id":"L2","type":"session_list_request","v":1}');
    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L2"');

    await engine.teardown();
  });

  test("launcher 未注入の session_start は error(launch_failed)（安全側: 実 claude を起動しない）", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"cwd":"/tmp","id":"S3","name":"new","type":"session_start","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"launch_failed"');
    expect(err).toContain('"id":"S3"');

    // launcher 不在でも tmux 起動系コマンドは一切発行されない。
    const launchedTmux = runner.recorded.some(
      (cmd) => cmd[0] === "new-session" || cmd[0] === "new",
    );
    expect(launchedTmux).toBe(false);

    await engine.teardown();
  });

  // MARK: 6. decode 失敗行は破棄（クラッシュしない）

  test("decode 不能な行は破棄され、以降のメッセージは処理される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine("this is not json");
    engine.writeLine('{"id":"L3","type":"session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L3"');

    await engine.teardown();
  });

  // MARK: question_answer → tmux send-keys 変換

  test("question_answer は tmux send-keys へ変換される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      '{"answers":[{"multiSelect":false,"questionIndex":0,"selectedOptionIndexes":[1]},{"multiSelect":false,"otherText":"custom","questionIndex":1,"selectedOptionIndexes":[2]}],"id":"Q1","session":"work","type":"question_answer","v":1}',
    );

    // 単一選択: 数字キーのみで即確定（Enter は送らない）。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "2"])).toBe(true);
    // Other（Type something.）: 行の数字キー → literal 入力 → Enter。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "3"])).toBe(true);
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "-l", "custom"])).toBe(true);
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "Enter"])).toBe(true);
    // Enter は Other 確定の1回だけ。
    const enterCount = runner.recorded.filter(
      (cmd) => JSON.stringify(cmd) === JSON.stringify(["send-keys", "-t", "work", "Enter"]),
    ).length;
    expect(enterCount).toBe(1);

    await engine.teardown();
  });

  test("question_answer: multiSelect は ↓/Space トグル + Right + レビュー確定（1）に変換される", async () => {
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    const before = runner.recorded.length;
    engine.writeLine(
      '{"answers":[{"multiSelect":true,"questionIndex":0,"selectedOptionIndexes":[0,2]}],"id":"Q2","session":"work","type":"question_answer","v":1}',
    );

    // 最後の「1」（Submit answers）が届くまで待つ。
    expect(await waitForCommand(runner, ["send-keys", "-t", "work", "1"])).toBe(true);

    // index0 を Space、↓↓ で index2 へ移動し Space、Right でレビュー、1 で確定。
    // multiSelect は数字キーでトグルできないため、数字トグル（"3" 等）や Enter は送らない。
    const keys = runner.recorded
      .slice(before)
      .filter((cmd) => cmd[0] === "send-keys")
      .map((cmd) => cmd.slice(3));
    expect(keys).toEqual([["Space"], ["Down"], ["Down"], ["Space"], ["Right"], ["1"]]);

    await engine.teardown();
  });

  // MARK: 画像ハーネス

  function makeImageRoot(): { root: string; pending: string; index: string } {
    const root = makeTempDir("tailii-engine-image-tests");
    return {
      root,
      pending: path.join(root, "pending"),
      index: path.join(root, "index"),
    };
  }

  function writeIndexedBlob(id: string, bytes: number, ext: string, index: string): string {
    const srcDir = path.join(path.dirname(index), "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const data = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 1) data[i] = i & 0xff;
    const blob = path.join(srcDir, `${id}.${ext}`);
    fs.writeFileSync(blob, data);
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, `${id}.json`), JSON.stringify({ id, path: blob }));
    return blob;
  }

  // MARK: 7. image_fetch_request → 分割 image_fetch_response

  test("image_fetch_request で原本が複数 seq の image_fetch_response に分割され eof で終端する", async () => {
    const img = makeImageRoot();
    writeIndexedBlob("fetch-big", 32 * 1024 + 5000, "png", img.index);
    const imageService = new ImageService({ pendingBase: img.pending, indexBase: img.index });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), imageService });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"fetch-big","type":"image_fetch_request","v":1}');

    const responses: string[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const line = await engine.lines.next();
      if (line.includes('"type":"image_fetch_response"')) {
        responses.push(line);
        if (line.includes('"eof":true')) break;
      }
    }

    expect(responses.length).toBeGreaterThanOrEqual(2);
    expect(responses[0]).toContain('"seq":0');
    expect(responses[responses.length - 1]).toContain('"eof":true');
    expect(responses.slice(0, -1).every((line) => line.includes('"eof":false'))).toBe(true);

    await engine.teardown();
  });

  // MARK: 8. 不在 id → error(image_not_found)

  test("不在 id の image_fetch_request は error(image_not_found) を返す", async () => {
    const img = makeImageRoot();
    const imageService = new ImageService({ pendingBase: img.pending, indexBase: img.index });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), imageService });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"nope","type":"image_fetch_request","v":1}');

    const err = await engine.lines.nextOfType("error");
    expect(err).toContain('"code":"image_not_found"');
    expect(err).toContain('"id":"nope"');

    await engine.teardown();
  });

  // MARK: 9. image_available を engine チャネルへ送出（drainPending）

  test("チャネル確立時に pending を drain し image_available を engine チャネルへ送出する", async () => {
    const img = makeImageRoot();
    // 実 PNG を pending に投入（drainPending がサムネ生成し image_available を出す）。
    const srcDir = path.join(img.root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const png = path.join(srcDir, "avail.png");
    // 1x1 の有効な PNG（sips で読める最小フィクスチャ）。
    fs.writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    fs.mkdirSync(img.pending, { recursive: true });
    fs.writeFileSync(
      path.join(img.pending, "entry.json"),
      JSON.stringify({ imageId: "avail-1", path: png }),
    );
    const imageService = new ImageService({ pendingBase: img.pending, indexBase: img.index });
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), imageService });

    const avail = await engine.lines.nextOfType("image_available");
    expect(avail).toContain('"id":"avail-1"');
    expect(avail).toContain(`"path":"${png}"`);

    await engine.teardown();
  });

  // MARK: 10. imageService 未注入時は従来どおり（後方互換）

  test("imageService 未注入でも session_list は従来どおり処理される（後方互換）", async () => {
    const store = makeTempStore();
    store.put({ name: "beta", cwd: "/tmp/beta", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("beta\n") : ok("")));
    const engine = startEngine({ sessionManager: makeManager(runner, store) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"L9","type":"session_list_request","v":1}');
    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"L9"');
    expect(resp).toContain('"name":"beta"');

    await engine.teardown();
  });

  // MARK: 11. chat_output を engine チャネルへ送出（TranscriptTailer 注入, 9.1/9.2/9.3）

  test("transcriptTailer 注入時、assistant/user ターンの chat_output が engine FD へ送出される", async () => {
    // 代表 JSONL を一時ファイルに用意（秘密を thinking.signature に混ぜて非漏洩も検証）。
    const secret = "SECRET_KEY_ENGINE_9F8E7D";
    const contents =
      '{"type":"user","message":{"role":"user","content":"やあ"},"uuid":"e-u1"}\n' +
      `{"message":{"role":"assistant","content":[{"type":"thinking","thinking":"z","signature":"${secret}"},{"type":"text","text":"どうも"}]},"uuid":"e-a1"}\n`;
    const dir = makeTempDir("tailii-engine-transcript");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, contents);

    const runner = new MockTmuxRunner(() => ok(""));
    const tailer = new TranscriptTailer({ pollIntervalMs: 20, tailDeadlineMs: 2000 });
    const engine = startEngine({
      sessionManager: makeManager(runner),
      transcriptTailer: tailer,
      transcriptPath: transcript,
    });

    const first = await engine.lines.nextOfType("chat_output");
    const second = await engine.lines.nextOfType("chat_output");

    expect(first).toContain('"role":"user"');
    expect(first).toContain('"streamId":"e-u1"');
    expect(first).toContain('"eof":true');
    expect(second).toContain('"role":"assistant"');
    expect(second).toContain('"streamId":"e-a1"');
    // 9.3: 秘密は chat_output に現れない。
    expect(first).not.toContain(secret);
    expect(second).not.toContain(secret);

    await engine.teardown();
  });

  // MARK: 11b. チャネル断（EOF）で chatPump が確実に停止し runEngine が有界時間で完了する

  test("チャネル断（EOF）で無期限 tail の chatPump が停止し runEngine が有界時間で完了する", async () => {
    const dir = makeTempDir("tailii-engine-cancel");
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"やあ"},"uuid":"cx-u1"}\n');

    const runner = new MockTmuxRunner(() => ok(""));
    // 無期限 tail: 停止が漏れると EOF 後も永久に回る（= runEngine が完了しない）。
    const tailer = new TranscriptTailer({ pollIntervalMs: 20, tailIndefinitely: true });
    const engine = startEngine({
      sessionManager: makeManager(runner),
      transcriptTailer: tailer,
      transcriptPath: transcript,
    });

    const first = await engine.lines.nextOfType("chat_output");
    expect(first).toContain('"streamId":"cx-u1"');

    // チャネル断（EOF）→ readLoop 終了 → chatPump abort → runEngine 完了（有界待ち）。
    const completed = await Promise.race([
      engine.teardown().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    expect(completed).toBe(true);
  });

  // MARK: 12. transcriptTailer 未注入時は従来どおり（後方互換）

  test("transcriptTailer 未注入でも session_list は従来どおり処理される（後方互換）", async () => {
    const store = makeTempStore();
    store.put({ name: "gamma", cwd: "/tmp/gamma", createdAt: 1 });
    const runner = new MockTmuxRunner((args) => (args[0] === "ls" ? ok("gamma\n") : ok("")));
    const engine = startEngine({ sessionManager: makeManager(runner, store) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"T12","type":"session_list_request","v":1}');
    const resp = await engine.lines.nextOfType("session_list_response");
    expect(resp).toContain('"id":"T12"');
    expect(resp).toContain('"name":"gamma"');

    await engine.teardown();
  });

  // MARK: 13. browse_request → browse_response（dir-picker 1.1 結線）

  test("browse_request に絶対パス直下のサブディレクトリ名で browse_response を返す", async () => {
    const dir = makeTempDir("tailii-browse-tests");
    fs.mkdirSync(path.join(dir, "dev"));
    fs.mkdirSync(path.join(dir, "Documents"));

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(`{"id":"B1","path":"${dir}","type":"browse_request","v":1}`);

    const resp = await engine.lines.nextOfType("browse_response");
    expect(resp).toContain('"id":"B1"');
    expect(resp).toContain(`"path":"${dir}"`);
    expect(resp).toContain('"entries":["Documents","dev"]');

    await engine.teardown();
  });

  // MARK: claude-sessions: claude_session_list_request → claude_session_list_response

  test("claude_session_list_request に claude_session_list_response を返す（store 橋渡し）", async () => {
    const projects = makeTempDir("tailii-cs-engine");
    const slugDir = path.join(projects, "-tmp-proj");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, "77777777-8888-9999-aaaa-bbbbbbbbbbbb.jsonl"),
      '{"type":"user","cwd":"/tmp/proj","message":{"content":"エンジン越し会話"}}\n',
    );

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({
      sessionManager: makeManager(runner),
      claudeSessionStore: new ClaudeSessionStore(projects),
    });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine('{"id":"CS1","type":"claude_session_list_request","v":1}');

    const resp = await engine.lines.nextOfType("claude_session_list_response");
    expect(resp).toContain('"id":"CS1"');
    expect(resp).toContain('"sessionId":"77777777-8888-9999-aaaa-bbbbbbbbbbbb"');
    expect(resp).toContain('"cwd":"/tmp/proj"');
    expect(resp).toContain('"title":"エンジン越し会話"');

    await engine.teardown();
  });

  // MARK: dir-create: dir_create_request → dir_create_response

  test("dir_create_request で base 配下に作成し ok=true を返す", async () => {
    const base = makeTempDir("tailii-dc-engine");
    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner) });

    await engine.lines.nextOfType("channel_hello");
    engine.writeLine(
      `{"baseDir":"${base}","id":"DC1","relative":"created","type":"dir_create_request","v":1}`,
    );

    const resp = await engine.lines.nextOfType("dir_create_response");
    expect(resp).toContain('"id":"DC1"');
    expect(resp).toContain('"ok":true');
    expect(fs.statSync(path.join(base, "created")).isDirectory()).toBe(true);

    await engine.teardown();
  });

  // MARK: slash_list_request

  function writeMd(filePath: string, description: string | null): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body =
      description === null
        ? "# command\n"
        : `---\ndescription: ${description}\n---\n# command\n`;
    fs.writeFileSync(filePath, body);
  }

  test("slash_list_request は skills/commands を収集し summary・dedupe・sort を適用する", async () => {
    const home = makeTempDir("tailii-slash-home");
    const cwd = makeTempDir("tailii-slash-cwd");
    writeMd(path.join(home, ".claude", "skills", "alpha", "SKILL.md"), "user skill");
    writeMd(path.join(home, ".claude", "skills", "dupe", "SKILL.md"), "user skill old");
    writeMd(path.join(home, ".claude", "commands", "beta.md"), "user command");
    writeMd(path.join(home, ".claude", "commands", "empty.md"), null);
    writeMd(path.join(cwd, ".claude", "skills", "dupe", "SKILL.md"), "project skill wins");
    writeMd(path.join(cwd, ".claude", "commands", "alpha.md"), "project command wins");
    writeMd(path.join(cwd, ".claude", "commands", "gamma.md"), "project command");

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), homeDir: home });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine(`{"cwd":${JSON.stringify(cwd)},"id":"SL1","type":"slash_list_request","v":1}`);
    const line = await engine.lines.nextOfType("slash_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "slash_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.commands).toEqual([
      { name: "/alpha", summary: "project command wins" },
      { name: "/beta", summary: "user command" },
      { name: "/dupe", summary: "project skill wins" },
      { name: "/empty", summary: "" },
      { name: "/gamma", summary: "project command" },
    ]);

    await engine.teardown();
  });

  test("slash_list_request は symlink の skill directory と command file も辿る", async () => {
    const home = makeTempDir("tailii-slash-symlink-home");
    const source = makeTempDir("tailii-slash-symlink-source");
    writeMd(path.join(source, "linked-skill", "SKILL.md"), "linked skill");
    writeMd(path.join(source, "linked-command.md"), "linked command");
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
    fs.symlinkSync(
      path.join(source, "linked-skill"),
      path.join(home, ".claude", "skills", "linked-skill"),
      "dir",
    );
    fs.symlinkSync(
      path.join(source, "linked-command.md"),
      path.join(home, ".claude", "commands", "linked-command.md"),
      "file",
    );

    const runner = new MockTmuxRunner(() => ok(""));
    const engine = startEngine({ sessionManager: makeManager(runner), homeDir: home });
    await engine.lines.nextOfType("channel_hello");

    engine.writeLine('{"id":"SL2","type":"slash_list_request","v":1}');
    const line = await engine.lines.nextOfType("slash_list_response");
    const msg = decodeControlMessage(line);
    if (msg.type !== "slash_list_response") throw new Error(`応答型不一致: ${msg.type}`);
    expect(msg.commands).toEqual([
      { name: "/linked-command", summary: "linked command" },
      { name: "/linked-skill", summary: "linked skill" },
    ]);

    await engine.teardown();
  });
});
