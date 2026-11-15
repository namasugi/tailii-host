// commands/chat/agentGuide.ts
// `tailii-host agent-guide` が出す、AI エージェント（Bot）向けの使い方（tailii-chat-cli）。host に同梱するので版がずれない。

export const AGENT_GUIDE = `# tailii-host chat — AI エージェント向けの使い方

このホストの Tailii（iPhone から Claude Code を操作するアプリ）の会話を、コマンドで始める・続けを送る・結果を読む。
始めた会話は利用者の iPhone の Tailii にもそのまま出て、利用者が続きを引き取れる。

## 呼び方
- SSH なら絶対パスで: ssh <host> ~/.local/bin/tailii-host chat <動詞> ...
- Bot は必ず --json を付ける（付けないと、端末があるとき会話の画面を開いて戻らない）。端末が無い呼び出しは --json が無くても
  Bot として扱う（依頼 ID 必須・auto の制限）。
- 指示文は標準入力で渡す（コマンドラインに書かない。シェルを通って壊れる）。長い指示文（8 KiB 超か 40 行超）はホスト側で
  ファイルに書き出し、その参照を Claude に送る。

## 動詞
- chat list [--live] --json
    会話の一覧。conversationId / agent / title / cwd / updatedAtMs / where（tailii=Tailii で動作中・elsewhere=Tailii の外で動作中・none=止まっている）。
- chat new --cwd <フォルダ> --request-id <ID> [--title <名前>] [--permission-mode default|acceptEdits|plan] --json  < 指示文
    新しい Claude の会話を始めて最初の指示を送る。指示が Claude に受け付けられた時点で返る（返答の完了は待たない）。
- chat send <conversationId> --request-id <ID> --json  < 指示文
    続きを送る。止まっていれば Tailii で続きから起動してから送る。Claude の会話が他所（利用者の端末など）で動いていれば
    送らずに終了コード 4。Codex の会話は --permission-mode でその送信の方針を変えられる（省略は直前にこのコマンドで送った
    ときと同じ。プランモードから戻すときは一度 acceptEdits などを指定する。auto は allowAuto が無ければ使わない）。
- chat new … --agent codex
    Claude の代わりに Codex で始める（省略は Claude）。以降の send / status / answer / approve は会話 ID だけで同じように使える。
    Codex は sandbox が作業フォルダの中だけ書ける workspace-write で、許可モードを承認の方針に当てる（default=untrusted /
    acceptEdits=on-request / plan=on-request＋プランモード / auto=never）。take-over は Codex では使えない。
- chat new … [--backend herdr|tmux] [--herdr-session <名前>]
    起動先の明示（省略はアプリの設定）。明示した herdr セッションが動いていなければ、振り替えずに失敗する。
- chat status <conversationId> [--after <依頼ID>] [--wait <秒>] --json
    state（busy=処理中 / waiting_approval=ツールの承認待ち / waiting_answer=設問への答え待ち / waiting=その他の入力待ち /
    idle=待機 / not_running=止まっている）と reply（返答の文章）。waiting_approval / waiting_answer のときは waiting に中身が載る
    （approvals[].approvalId・tool・summary / question.questionId と questions[].options[].choice）。答え待ちは --wait でも待たずに返る。
    --after でその依頼への返答だけを返す。received はその依頼が会話に届いたか、delivery は配送状態
    （delivered=届いた / pending=保留中（設問の表示中など）/ blocked=前の送信が止まっていて流れない /
    uncertain=届いたか不明で止まっている / deleted=取り消された / unknown）。
    --wait で処理が終わるまで最大その秒数（上限 100）待つ。complete=true（idle で返答あり）なら返答は出そろっている。
    答え待ちは、利用者が iPhone で答えるか、下の answer / approve で答えるまで進まない。
    delivery ごとにすること: delivered → 返答を待つ / pending → state が waiting なら人に伝える。そうでなければ少し待って
    もう一度 status / uncertain・blocked（needsHuman: true。blocked は前の送信が止まっていて、この送信も流れない）→ 人に
    伝える（この会話には送らない）/ deleted → 送り直すなら人に確かめてから
    新しい依頼 ID で / unknown → 同じ依頼 ID で送り直す。

- chat answer <conversationId> <設問ID> --choice <番号> [--other <文>] --json
    設問に答える（Bot が new で始めた会話だけ）。番号は 1 から。複数選択は 1,3、設問が複数なら設問ごとに ; で区切る（1;2）。
    --other は設問が 1 つのときの自由記述（「その他」）。1 つだけ選ぶ設問では --choice と --other のどちらか一方。
- chat approve <conversationId> <承認ID> allow|deny [--reason <理由>] --json
    ツールの承認に答える。deny はいつでもできる。allow は利用者が ~/.tailii/bot.json の allowApprove を true にしたときだけで、
    作業フォルダが allowedRoots の中の承認だけ。applied=true ならこの決定で決まった（false で decidedBy があれば、先に
    利用者が答えた。decision がその決定）。--reason は Claude に伝わる理由（Codex には許可か拒否だけが伝わる）。
- chat take-over <conversationId> --json
    Tailii の外（利用者の端末など）で動いている会話を終了させて Tailii で開き直す。bot.json の allowTakeOver が true で、
    相手が待機中のときだけ（処理中は終了コード 4）。

## 承認できる人が居ないとき
- このコマンドが起動した会話（new・take-over など）で、iPhone のアプリがつながっておらず、通知を受ける端末も無く、Bot の承認も許されていなければ、
  ツールの承認は待たずに拒否され、Claude には「許可の要らない方法で進めるか、止めて報告する」と伝わる。

## 依頼 ID（--request-id）
- new / send に必須。同じ依頼 ID で打ち直すと、同じ会話・同じ送信として扱われ二重にならない。終了コード 6・7 は同じ ID で打ち直す。
- 依頼ごとに新しい ID を使う（例: UUID）。

## 出力（--json）
- 標準出力に JSON 1 個: {"v":1,"ok":true,...} または {"v":1,"ok":false,"error":{"code","message","hint"}}。
- hint は次に打つべきコマンドや人に伝えること。

## 終了コード
- 0 成功（status が処理中でも 0。state を見る）
- 1 内部エラー
- 2 使い方の誤り・許可されていない作業フォルダ・指示文が空
- 3 会話が見つからない（chat list で確かめる）。code が conversation_ended_before_start なら、new の最初の指示が届く前に
  会話が終わった。新しい依頼 ID で new をやり直す
- 4 他所で動いている（送っていない）。人に伝える
- 5 方針で不可。code が needs_human なら、送信が届いたか分からない状態で会話の送信が止まっている（利用者がアプリで
  会話を終了して開き直すまで、この会話には送れない）。同じ依頼 ID で打ち直しても送り直さない（届いていたかは人が
  会話の画面で確かめ、届いていなければ新しい依頼 ID で送る）。message_deleted なら利用者が取り消した。どちらも人に伝える
- 6 今はできない（起動中・同じ依頼 ID のコマンドが実行中・送信を断られた＝届いていない など）。少し待って同じ依頼 ID で
  打ち直す。同じ理由で何度も断られるなら人に伝える
- 7 送信が届いたか分からない（時間切れ・結果不明）。同じ依頼 ID で打ち直す（保留中の送信に合流し、届いていれば duplicate）。
  新しい依頼 ID で送り直さない（二重になる）。設問の表示中は、送信は利用者が答えるまで保留される。
  エラーの JSON に conversationId があれば chat status <会話ID> --after <依頼ID> の delivery で確かめられる。
  new の起動の時間切れ（start_timeout）は会話 ID がまだ無い。同じ依頼 ID で new を打ち直す（新しい ID だと会話がもう 1 つ始まる）
- 127 tailii-host が無い（このホストに Tailii が入っていない）

## 守ること
- 作業フォルダは ~/.tailii/bot.json の allowedRoots（既定はホームの中）だけ（new も send も）。フォルダは自動で作らない。
- 依頼 ID は依頼ごとに新しくする。別の依頼（別の会話・別の本文）に使い回すと終了コード 2。
- 許可モードの既定は acceptEdits（編集と読み取りは進み、それ以外のツールは利用者の承認が要る）。auto は利用者が bot.json で
  allowAuto を true にしたときだけ使える。承認が要る操作は、利用者が iPhone で答えるまで止まる。
- Tailii の会話への送信・状態の確認は必ずこのコマンドで行う。herdr / tmux へ直接キーを送らない（読むだけは可）。
- 他所で動いている会話を終了させて引き取る操作（take-over）は、Bot には既定で許されていない。終了コード 4 なら人に伝える。
- 承認の allow・take-over は利用者が bot.json で許したときだけ。許されていない操作は試さない（終了コード 5）。
`;
