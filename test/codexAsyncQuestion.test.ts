// Codex の非同期質問（request_user_input_async, codex-async-question）と stdin 承認（writeStdin）の単体テスト。

import { describe, expect, test } from "vitest";
import type { CodexAppServerThreadOptions } from "../src/codex/codexAppServer.js";
import { tagCodexItemTurn } from "../src/codex/codexAppServer.js";
import {
  CODEX_ASYNC_QUESTION_ID_PREFIX,
  codexAsyncQuestionId,
  codexAsyncQuestionItem,
  codexAsyncQuestionReplyDisplayText,
  codexAsyncQuestionReplyText,
} from "../src/codex/codexAsyncQuestion.js";
import {
  CODEX_WRITE_STDIN_TOOL_LABEL,
  CodexNativeTurnController,
  codexItemToChatOutput,
  codexWriteStdinApprovalSummary,
  splitShellWords,
  type CodexNativeApproval,
  type CodexThreadClient,
} from "../src/codex/codexNativeTurnController.js";

class FakeThread implements CodexThreadClient {
  readonly starts: { text: string }[] = [];
  readonly steers: { turnId: string; text: string }[] = [];
  steerError: Error | null = null;

  async startTurn(text: string): Promise<string> {
    this.starts.push({ text });
    return "turn-1";
  }

  async steerTurn(turnId: string, text: string): Promise<void> {
    this.steers.push({ turnId, text });
    if (this.steerError !== null) throw this.steerError;
  }

  async interruptTurn(): Promise<void> {}

  close(): void {}
}

/** 0.160 の App Server が流す非同期質問の item（id はツール呼び出しの call_id）。 */
function asyncItem(id: string, questions: { title: string; options: string[] | null }[]): Record<string, unknown> {
  return {
    type: "agentMessage", id, phase: "final_answer", memoryCitation: null, delivery: "async", questions,
    text: questions.map((q) => [q.title, ...(q.options ?? []).map((o) => `- ${o}`)].join("\n")).join("\n\n"),
  };
}

describe("codexAsyncQuestion（純ロジック）", () => {
  test("App Server / rollout の両方の形から質問を取り出し、非同期でないものは無視する", () => {
    expect(codexAsyncQuestionItem(asyncItem("call_1", [{ title: "どちら？", options: ["A", "B"] }])))
      .toEqual({ itemId: "call_1", questions: [{ index: 0, title: "どちら？", options: ["A", "B"] }] });
    // rollout（実機 2026-09-27 の形）。
    expect(codexAsyncQuestionItem({
      type: "AgentMessage", id: "call_lQg", phase: "final_answer", delivery: "async",
      content: [{ type: "Text", text: "Q\n- x" }],
      questions: [{ title: "Q", options: null }],
    })).toEqual({ itemId: "call_lQg", questions: [{ index: 0, title: "Q", options: [] }] });
    // 不正な要素を飛ばしても元の番号を保つ（質問 id の番号を TUI とずらさない）。
    expect(codexAsyncQuestionItem(asyncItem("call_2", [{ title: " ", options: null }, { title: "本物", options: null }]))
      ?.questions.map((q) => q.index)).toEqual([1]);
    expect(codexAsyncQuestionItem({ type: "agentMessage", id: "a", text: "普通の回答", phase: "final_answer" })).toBeNull();
    expect(codexAsyncQuestionItem({ type: "agentMessage", id: "a", delivery: "async", questions: [{ title: " " }] }))
      .toBeNull();
  });

  test("回答の封筒は TUI と同じ形（辞書順キー・質問 id は JSON 配列文字列）で、表示用には `> 質問` へ戻る", () => {
    expect(codexAsyncQuestionId("call_1", 0)).toBe('["request_user_input_async","call_1",0]');
    const text = codexAsyncQuestionReplyText([
      { itemId: "call_1", index: 0, title: "どちら？\n補足", answer: "A" },
      { itemId: "call_1", index: 1, title: "名前は？", answer: "foo" },
    ]);
    expect(text).toBe(
      "<send_user_message_question_reply>\n"
      + '[{"answer":"A","question":"どちら？ 補足","questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",0]"},'
      + '{"answer":"foo","question":"名前は？","questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",1]"}]\n'
      + "</send_user_message_question_reply>",
    );
    expect(codexAsyncQuestionReplyDisplayText(text)).toBe("> どちら？ 補足\n\nA\n\n> 名前は？\n\nfoo");
    // TUI のテストと同じ単体オブジェクト形 / IDE 文脈の前置き。
    expect(codexAsyncQuestionReplyDisplayText(
      '<send_user_message_question_reply>{"questionItemId":"one","question":"First?","answer":"Yes"}</send_user_message_question_reply>',
    )).toBe("> First?\n\nYes");
    expect(codexAsyncQuestionReplyDisplayText(
      "# Context from my IDE setup:\n…\n## My request for Codex:\n"
      + '<send_user_message_question_reply>[{"questionItemId":"one","question":"Q","answer":"A"}]</send_user_message_question_reply>',
    )).toBe("> Q\n\nA");
    // 引用・後続テキスト・空配列・壊れた JSON は封筒とみなさない。
    expect(codexAsyncQuestionReplyDisplayText("Quoted: <send_user_message_question_reply>{}</send_user_message_question_reply>"))
      .toBeNull();
    expect(codexAsyncQuestionReplyDisplayText("<send_user_message_question_reply>[]</send_user_message_question_reply>"))
      .toBeNull();
    expect(codexAsyncQuestionReplyDisplayText("<send_user_message_question_reply>[{]</send_user_message_question_reply>"))
      .toBeNull();
    expect(codexAsyncQuestionReplyDisplayText("普通の発話")).toBeNull();
  });

  test("質問文は 512 バイトで文字の途中を切らずに切り詰める", () => {
    const long = "あ".repeat(200); // 600 バイト
    const text = codexAsyncQuestionReplyText([{ itemId: "c", index: 0, title: long, answer: "x" }]);
    const display = codexAsyncQuestionReplyDisplayText(text)!;
    expect(display).toBe(`> ${"あ".repeat(170)}\n\nx`);
  });

  test("回答の封筒の userMessage は live でも `> 質問\\n\\n回答` で出す", () => {
    const envelope = codexAsyncQuestionReplyText([{ itemId: "call_1", index: 0, title: "どちら？", answer: "A" }]);
    expect(codexItemToChatOutput({ id: "u1", type: "userMessage", content: [{ type: "text", text: envelope }] }))
      .toEqual({ type: "chat_output", v: 1, streamId: "codex-item-u1", role: "user", text: "> どちら？\n\nA", eof: true });
  });
});

describe("CodexNativeTurnController: 非同期質問", () => {
  async function setup(options: {
    broker?: (approval: CodexNativeApproval) => void;
    initialItems?: Record<string, unknown>[];
    initialActiveTurnId?: string | null;
    startTurn?: boolean;
  } = {}) {
    const thread = Object.assign(new FakeThread(), {
      initialItems: options.initialItems ?? [],
      initialActiveTurnId: options.initialActiveTurnId ?? null,
    });
    let openOptions: CodexAppServerThreadOptions | null = null;
    const prompts: { session: string; id: string; questions: unknown[] }[] = [];
    const dismissed: string[] = [];
    const chats: { itemId: string; payload: unknown }[] = [];
    const controller = new CodexNativeTurnController({
      appServer: { openThread: async (opts) => { openOptions = opts; return thread; } },
      onQuestion: (event) => prompts.push(event),
      onQuestionDismiss: (_session, id) => dismissed.push(id),
      onChatItem: (event) => chats.push(event),
      asyncPromptNonce: "n",
      approvalBroker: async (approval) => {
        options.broker?.(approval);
        return "allow";
      },
    });
    if (options.startTurn === false) {
      await controller.subscribeSession({ session: "work", threadId: "thread-1", cwd: "/tmp/work" });
    } else {
      await controller.startTurn({ session: "work", threadId: "thread-1", cwd: "/tmp/work", text: "go" });
    }
    const notify = (method: string, params: Record<string, unknown>) =>
      openOptions!.onNotification?.({ method, params: { threadId: "thread-1", ...params } });
    return { thread, controller, prompts, dismissed, chats, notify, request: () => openOptions!.onServerRequest! };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const PROMPT_1 = "codex-async:thread-1:call_1#0:n-1";

  test("実行中の質問を止まらない設問（codex-async: 接頭辞）として出し、回答は封筒にして質問した turn へ steer する", async () => {
    const { thread, controller, prompts, dismissed, chats, notify } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "どちら？", options: ["A", "B"] }]) });
    // 本文は最終回答と同じ吹き出しで残る。
    expect(chats.map((c) => c.itemId)).toEqual(["call_1"]);
    expect(prompts).toEqual([{
      session: "work", id: PROMPT_1,
      questions: [{
        header: "Codex の質問", question: "どちら？", multiSelect: false,
        options: [{ label: "A", description: "" }, { label: "B", description: "" }],
      }],
    }]);
    expect(PROMPT_1.startsWith(CODEX_ASYNC_QUESTION_ID_PREFIX)).toBe(true);
    // 同じ item の再送で出し直さない。
    notify("item/completed", { item: asyncItem("call_1", [{ title: "どちら？", options: ["A", "B"] }]) });
    expect(prompts).toHaveLength(1);

    expect(controller.answerQuestion(PROMPT_1, [
      { questionIndex: 0, selectedOptionIndexes: [1], multiSelect: false },
    ])).toBe(true);
    expect(dismissed).toEqual([PROMPT_1]);
    await flush();
    expect(thread.starts.map((s) => s.text)).toEqual(["go"]);
    expect(thread.steers).toEqual([{
      turnId: "turn-1",
      text: codexAsyncQuestionReplyText([{ itemId: "call_1", index: 0, title: "どちら？", answer: "B" }]),
    }]);
    // 回答済みの id は二度受けない。
    expect(controller.answerQuestion(PROMPT_1, [])).toBe(false);
  });

  test("質問の並びが変わるたびに設問 id を変え、回答は提示した並びの item / 番号へ戻す", async () => {
    const { thread, controller, prompts, dismissed, notify } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "Q1", options: ["A"] }]) });
    notify("item/completed", { item: asyncItem("call_2", [{ title: "Q2", options: null }, { title: "Q3", options: ["x", "y"] }]) });
    const second = "codex-async:thread-1:call_1#0:n-2";
    expect(prompts.map((p) => p.id)).toEqual([PROMPT_1, second]);
    // 置き換えでは前の id の dismiss を送らない（hub は上書きし、iOS は前の設問と見比べて下書きを引き継ぐ）。
    expect(dismissed).toEqual([]);
    expect(prompts.at(-1)?.questions.map((q) => (q as { question: string }).question)).toEqual(["Q1", "Q2", "Q3"]);

    controller.answerQuestion(second, [
      { questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false },
      { questionIndex: 1, selectedOptionIndexes: [], otherText: " 自由記述 ", multiSelect: false },
      { questionIndex: 2, selectedOptionIndexes: [1], multiSelect: false },
    ]);
    await flush();
    expect(thread.steers.at(-1)?.text).toBe(codexAsyncQuestionReplyText([
      { itemId: "call_1", index: 0, title: "Q1", answer: "A" },
      { itemId: "call_2", index: 0, title: "Q2", answer: "自由記述" },
      { itemId: "call_2", index: 1, title: "Q3", answer: "y" },
    ]));
  });

  test("回答とすれ違って質問が追記されたら、古い id の回答は受けず、追記分も消さない", async () => {
    const { thread, controller, prompts, notify } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "Q1", options: ["A"] }]) });
    // iOS が 1 問のシートに答えて送った直後に 2 問目が届く（hub は新しい id へ置き換える）。
    notify("item/completed", { item: asyncItem("call_2", [{ title: "Q2", options: ["B"] }]) });
    expect(controller.answerQuestion(PROMPT_1, [
      { questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false },
    ])).toBe(false);
    await flush();
    expect(thread.steers).toEqual([]);
    // 2 問とも新しい id で答えられる。
    const current = prompts.at(-1)!;
    expect(current.questions).toHaveLength(2);
    expect(controller.answerQuestion(current.id, [
      { questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false },
      { questionIndex: 1, selectedOptionIndexes: [0], multiSelect: false },
    ])).toBe(true);
    await flush();
    expect(thread.steers.at(-1)?.text).toBe(codexAsyncQuestionReplyText([
      { itemId: "call_1", index: 0, title: "Q1", answer: "A" },
      { itemId: "call_2", index: 0, title: "Q2", answer: "B" },
    ]));
    // 回答の直後に届いた質問は新しい id。
    notify("item/completed", { item: asyncItem("call_3", [{ title: "Q3", options: ["C"] }]) });
    expect(prompts.at(-1)?.id).toBe("codex-async:thread-1:call_3#0:n-3");
  });

  test("他のクライアントが途中の質問に答えたら id を変え、iPhone の古い並びの回答を別の質問へ届けない", async () => {
    const { thread, controller, prompts, notify } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [
      { title: "Q1", options: ["a"] }, { title: "Q2", options: ["b"] }, { title: "Q3", options: ["c"] },
    ]) });
    const tuiReply = codexAsyncQuestionReplyText([{ itemId: "call_1", index: 1, title: "Q2", answer: "b" }]);
    notify("item/completed", { item: { id: "u9", type: "userMessage", content: [{ type: "text", text: tuiReply }] } });
    expect(prompts.at(-1)?.questions.map((q) => (q as { question: string }).question)).toEqual(["Q1", "Q3"]);
    expect(controller.answerQuestion(PROMPT_1, [
      { questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false },
      { questionIndex: 1, selectedOptionIndexes: [0], multiSelect: false },
      { questionIndex: 2, selectedOptionIndexes: [0], multiSelect: false },
    ])).toBe(false);
    await flush();
    expect(thread.steers).toEqual([]);
  });

  test("他のクライアント（TUI / デスクトップ）の回答で該当する質問を閉じ、二重回答を防ぐ", async () => {
    const { prompts, dismissed, notify } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "Q1", options: ["A"] }, { title: "Q2", options: ["B"] }]) });
    const tuiReply = codexAsyncQuestionReplyText([{ itemId: "call_1", index: 0, title: "Q1", answer: "A" }]);
    notify("item/completed", { item: { id: "u9", type: "userMessage", content: [{ type: "text", text: tuiReply }] } });
    // 1 問目が消え、残りの 1 問が新しい id で出し直される（置き換えなので前の id の dismiss は無い）。
    expect(dismissed).toEqual([]);
    expect(prompts.at(-1)?.id).toBe("codex-async:thread-1:call_1#1:n-2");
    expect(prompts.at(-1)?.questions).toHaveLength(1);
    // 旧デスクトップ形式（item id だけで指す）は item の全問を閉じる。
    const legacy = '<send_user_message_question_reply>[{"questionItemId":"call_1","question":"Q2","answer":"B"}]</send_user_message_question_reply>';
    notify("item/completed", { item: { id: "u10", type: "userMessage", content: [{ type: "text", text: legacy }] } });
    // 全問が外れたら設問を閉じる。
    expect(dismissed).toEqual(["codex-async:thread-1:call_1#1:n-2"]);
  });

  test("turn が終わると未回答の質問を締め切る（TUI と同じ）", async () => {
    const { prompts, dismissed, notify, controller } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "Q", options: ["A"] }]) });
    notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(prompts).toHaveLength(1);
    expect(dismissed).toEqual([PROMPT_1]);
    expect(controller.answerQuestion(PROMPT_1, [])).toBe(false);
  });

  test("接続を畳むと締め切り、状態も残さない", async () => {
    const { dismissed, notify, controller } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "Q", options: ["A"] }]) });
    controller.closeSession("work");
    expect(dismissed).toEqual([PROMPT_1]);
    expect(controller.answerQuestion(PROMPT_1, [])).toBe(false);
  });

  test("答えないと進まない設問の間は出さず、それが終わったら出し直す", async () => {
    const { controller, prompts, notify, request } = await setup();
    notify("item/completed", { item: asyncItem("call_1", [{ title: "Q", options: ["A"] }]) });
    const blocking = request()({
      id: "rpc-q1", method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "i", questions: [
        { id: "k", header: "H", question: "止まる設問", options: [{ label: "OK", description: "" }] },
      ] },
    });
    // 止まる設問の表示中に来た非同期質問は出さない（hub の未回答の設問を上書きしない）。
    notify("item/completed", { item: asyncItem("call_2", [{ title: "Q2", options: ["B"] }]) });
    expect(prompts.map((p) => p.id)).toEqual([PROMPT_1, "codex-question:thread-1:rpc-q1"]);
    controller.answerQuestion("codex-question:thread-1:rpc-q1", [
      { questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false },
    ]);
    await blocking;
    expect(prompts.at(-1)?.id).toBe("codex-async:thread-1:call_1#0:n-2");
    expect(prompts.at(-1)?.questions).toHaveLength(2);
  });

  test("回答が届かなかったとき: turn が替わっていれば締め切り、timeout・切断は「届いたか不明」と注記する", async () => {
    const first = await setup();
    first.thread.steerError = new Error("connection closed");
    first.notify("item/completed", { item: asyncItem("call_1", [{ title: "Q", options: ["A"] }]) });
    first.controller.answerQuestion(PROMPT_1, [{ questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false }]);
    await flush();
    expect((first.chats.at(-1)?.payload as { text: string }).text).toContain("届いたか確認できませんでした");

    const second = await setup();
    second.thread.steerError = new Error("expected active turn id turn-1 but found turn-2");
    second.notify("item/completed", { item: asyncItem("call_1", [{ title: "Q", options: ["A"] }]) });
    second.controller.answerQuestion(PROMPT_1, [{ questionIndex: 0, selectedOptionIndexes: [0], multiSelect: false }]);
    await flush();
    expect((second.chats.at(-1)?.payload as { text: string }).text).toContain("作業が終わっていた");
    // 新しい turn は始めない（hub の送信キューと turn/start を競合させない）。
    expect(second.thread.starts.map((s) => s.text)).toEqual(["go"]);
  });

  test("開いた時点で実行中の turn にある未回答の質問を復元し、回答済み・別 turn の分は出さない", async () => {
    const tagged = (item: Record<string, unknown>, turnId: string) => {
      tagCodexItemTurn(item, turnId);
      return item;
    };
    const answered = codexAsyncQuestionReplyText([{ itemId: "call_a", index: 0, title: "A?", answer: "x" }]);
    const { prompts } = await setup({
      startTurn: false,
      initialActiveTurnId: "turn-9",
      initialItems: [
        tagged(asyncItem("call_old", [{ title: "前の turn", options: null }]), "turn-8"),
        tagged(asyncItem("call_a", [{ title: "A?", options: null }]), "turn-9"),
        tagged({ id: "u1", type: "userMessage", content: [{ type: "text", text: answered }] }, "turn-9"),
        tagged(asyncItem("call_b", [{ title: "B?", options: ["1", "2"] }]), "turn-9"),
      ],
    });
    expect(prompts).toEqual([{
      session: "work", id: "codex-async:thread-1:call_b#0:n-1",
      questions: [{ header: "Codex の質問", question: "B?", multiSelect: false,
        options: [{ label: "1", description: "" }, { label: "2", description: "" }] }],
    }]);
  });

  test("stdin 承認は新しいコマンドの実行と見分けられる見出しと要約で出す", async () => {
    const approvals: CodexNativeApproval[] = [];
    const { request } = await setup({ broker: (approval) => approvals.push(approval) });
    await request()({
      id: 7, method: "item/commandExecution/requestApproval",
      params: {
        kind: "writeStdin", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", approvalId: "ap-1",
        command: "write_stdin --session-id 12 'yes\n'", cwd: "/tmp/work",
      },
    });
    await request()({
      id: 8, method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: "thread-1", turnId: "turn-1", itemId: "item-2", command: "npm test" },
    });
    expect(approvals.map((a) => [a.tool, a.summary])).toEqual([
      [CODEX_WRITE_STDIN_TOOL_LABEL, '実行中の端末 12 へ入力を送ります\n入力: "yes\\n"'],
      ["Bash", "npm test"],
    ]);
  });
});

describe("stdin 承認の要約", () => {
  test("shell の単語分割はクォートとエスケープを戻し、閉じていないクォートは null", () => {
    expect(splitShellWords("write_stdin --session-id 12 'y\n'")).toEqual(["write_stdin", "--session-id", "12", "y\n"]);
    expect(splitShellWords(`a "b \\"c\\" \\$d" e\\ f 'g'"'"'h'`)).toEqual(["a", 'b "c" $d', "e f", "g'h"]);
    expect(splitShellWords("'open")).toBeNull();
    expect(splitShellWords('"open')).toBeNull();
  });

  test("見た目を偽装できる文字（bidi・ゼロ幅・C1・行区切り）はエスケープし、長い入力は省略を明記する", () => {
    const tricky = `write_stdin --session-id 12 'a\u202eb\u0085c\u200b\u2028"q"\\x\n'`;
    expect(codexWriteStdinApprovalSummary(tricky, "r\u202e")).toBe(
      '実行中の端末 12 へ入力を送ります\n入力: "a\\u{202e}b\\u{85}c\\u{200b}\\u{2028}\\"q\\"\\\\x\\n"\n理由: r\\u{202e}',
    );
    const long = codexWriteStdinApprovalSummary(`write_stdin --session-id 1 ${"x".repeat(2005)}`, null);
    expect(long.endsWith('"…（残り 5 文字を省略）')).toBe(true);
  });

  test("読めない command は生のまま、理由があれば添える", () => {
    expect(codexWriteStdinApprovalSummary("weird", "needs input")).toBe("実行中の端末へ入力を送ります\nweird\n理由: needs input");
    expect(codexWriteStdinApprovalSummary(null, null)).toBe("実行中の端末へ入力を送ります");
  });
});
