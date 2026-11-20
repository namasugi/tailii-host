// commands/chat/agentGuide.ts
// `tailii-host agent-guide` が出す、AI エージェント（Bot）向けの使い方（tailii-chat-cli）。host に同梱するので版がずれない。

export const AGENT_GUIDE = `# tailii-host chat — AI エージェント向けの使い方

このホストの Tailii（iPhone から Claude Code を操作するアプリ）の会話を、コマンドで始める・続けを送る・結果を読む・過去の分を読む。
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
    起動先の明示（省略はアプリの設定）。選んだ herdr セッションが停止中なら起動する。
- chat status <conversationId> [--after <依頼ID>] [--wait <秒>] --json
    state（busy=処理中 / waiting_approval=ツールの承認待ち / waiting_answer=設問への答え待ち / waiting=その他の入力待ち /
    idle=待機 / not_running=止まっている）と reply（返答の文章）。model は直近の返答を作ったモデル（設定値ではないので、
    set-model の直後は次の返答まで前のモデルのまま）。waiting_approval / waiting_answer のときは waiting に中身が載る
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

- chat read <conversationId> [--last <件数> | --after <カーソル> | --before <カーソル>] [--limit <件数>] [--max-text <バイト>] --json
    会話の記録を必要な分だけ読む（読むだけ。会話を起動せず、止まっている会話や他所で動いている会話も読める）。指定が無ければ
    末尾 10 件（--last。上限 50）。messages は古い順で、1 件は人の発話 1 つか、エージェントの文章 1 かたまり（連続する文章は
    つなげずに並ぶ。ツールの実行・思考・背景タスクの通知・サブエージェントの報告は入らない）。seq は会話の中の位置。
    続きだけ読む: 前の応答の cursors.after を --after に渡す（新しい発話が無ければ messages は空で range は null）。
    遡る: cursors.before を --before に渡す。--after / --before の件数は --limit（既定 10・上限 50）。カーソルは <seq>:<atMs>
    で、seq だけでも渡せる（その場合は記録の組み替わりを確かめない）。
    hasMoreBefore / hasMoreAfter は返した範囲の前後に残りがあるか。total は全体の件数。全文を一度に返す指定は無い。
    応答は全体で 32 KiB まで、1 件の本文は 8 KiB まで（超えた分は切り、truncated: true と本来の textBytes が付く。その 1 件を
    --after <その手前の seq> --limit 1 --max-text 32768 で読み直せる）。上限に収まらない分は返さず hasMore… が true になる。
    inProgress: true はターンの途中（処理中・答え待ち）で、末尾の返答はまだ続くかもしれない（詳しい状態は chat status）。
    人の発話には source（出所）が付く。kind: cli = このコマンドから（requestId があればその依頼）/ app = 利用者が Tailii の
    アプリから / terminal = 端末の画面へ直接（Tailii の送信を通っていない）/ peer = 別の Claude のセッションから届いた（name）/
    system = 人の発話ではない記録（detail: interrupted = 利用者が処理を中断した・compact_summary = 圧縮で作られた要約・
    scheduled = 予約した再開のプロンプト）/
    unknown = 判定できない（entrypoint があれば、SDK やデスクトップアプリなど端末の画面ではない入口）。
    confidence: exact = その発話に結び付く記録がある / inferred = 送信の記録との時刻の突き合わせによる推定。Claude の会話の
    app は、host が届けた発話を記録し始めてからの分は exact、それより前の発話は inferred。terminal はいつも inferred。
    誰の指示かで扱いを変えるときは、inferred と unknown を確定として扱わない。
    エージェントの文章には、分かれば model（その文章を作ったモデル）が付く。
- chat search <conversationId> --query <語> [--context <件数>] [--limit <件数>] [--before <カーソル>] --json
    会話の記録から語を探す（部分一致。空白・全角と半角・大文字と小文字の違いは無視する。語は 1 つで、AND / OR は無い）。
    hits は一致した発話・文章のうち新しい方から --limit 件（既定 10・上限 50）を古い順に並べたもの。excerpt は一致した箇所の
    前後の抜粋（全文ではない）、matchCount はその中の一致の数、before / after は前後の要素（--context。既定 2・上限 5。
    本文は 1 KiB まで）。totalHits が hits より多ければ（hasMoreBefore: true）、cursors.before を --before に渡すと、より古い
    一致を取れる。全文や広い前後は、hits[].seq を使って chat read --after <seq - 1> / --before <seq + 1> で読む。
    空白や記号を含む語は --query を付けずに標準入力の 1 行目で渡す（コマンドラインに書くとシェルを通って壊れる）。

- chat models [--agent claude|codex] [--cwd <フォルダ>] [--refresh] --json
    使えるモデルの一覧（id・displayName。Codex は efforts も）。6 時間は控えを返す。--model にはこの id をそのまま渡す
    （opus などの別名は使えない）。allowedModels があれば Bot にはその中だけ返す（restricted: true）。
    isDefault: true は --model を省いたときに使われるモデル。フォルダの設定で変わるので、始めるフォルダを --cwd で渡す。
    どの行にも付かなければ既定を決められなかった（実際のモデルは最初の返答の後に chat status の model で分かる）。
- chat new … [--model <id>] [--effort <工数>]
    モデルと工数を選んで始める（省略はそのエージェントの既定）。一覧にないモデルは終了コード 2、allowedModels の外は 5。
    Claude の工数は low / medium / high / xhigh / max、Codex はそのモデルの efforts。modelValidated: false は一覧が取れず
    確かめられなかったこと（Claude だけ）。
- chat set-model <conversationId> --model <id> --request-id <ID> --json
    Claude の会話のモデルを変える（以後ずっと効く。止まっていれば続きから起動する。send には --model を付けられない）。利用者の
    「新しい会話の既定モデル」も変わる（savedAsDefault: true）ので、bot.json の allowSetModel が true のときだけ使える。処理中・
    答え待ちは終了コード 6（待機中になってから同じ依頼 ID で打ち直す）。終了コード 7（model_change_unconfirmed）は同じ依頼 ID で
    打ち直すと確かめだけをやり直す。終了コード 5（model_change_failed）はモデルが変わらなかったことが確定した（detail に理由）。
    superseded: true はこの後に別のモデルへ変えられている。Codex の会話は未対応。
- chat set-mode <conversationId> --permission-mode default|acceptEdits|plan|auto --request-id <ID> --json
    Bot が new で始めた Claude の会話の許可モードを、動いている途中で変える（止まっていれば続きから起動する）。auto は allowAuto が
    true のときだけ。処理中・答え待ちは終了コード 6（待機中になってから同じ依頼 ID で打ち直す）。changed: false は既にそのモード。
    終了コード 6 の mode_change_incomplete は変えきれなかった（元のモードのまま。同じ依頼 ID で打ち直す）。終了コード 5 の mode_change_failed は
    auto へ切り替えられない（元のモードのまま）、mode_change_blocked は元に戻せなかった（JSON の mode が今のモード）。どちらも人に伝える。
    Codex の会話は chat send --permission-mode を使う。
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

## 会話の見張り（chat watch）
- 会話を始めた後、返答が出そろったときや、設問・承認で止まったときに気づくための仕組み。始めた人や作業フォルダを問わず、
  会話 ID を指定して見張れる。continue は続きを進めるとき、notify はターンの終了・途中停止・削除・期限切れだけ知りたいとき。
- chat watch add <会話ID> --mode continue|notify [--ttl <分>] [--request-id <依頼ID>] [--read-cursor <カーソル>] [--note] --json
    見張りを登録する。依頼元や目的は、--note を付けて標準入力にメモとして渡す（上限 2000 文字。--note が無ければ標準入力は
    読まない）。メモは poll の応答にそのまま返るので、後で起こされたときに何の見張りかが分かる。同じ会話を登録し直すと期限を数え直し、
    未受領の変化を引き継ぐ。依頼 ID はその会話への記録があるもの。カーソルは read と同じ <seq>:<atMs> または <seq>。
- chat new … / chat send … --watch continue|notify [--watch-ttl <分>] --json  < 指示文
    受け付けられたら見張りを登録し、応答の watch に mode と expiresAtMs を返す。依頼 ID を控え、メモが無ければ指示文の冒頭を入れる。
    開いている見張りがある会話へ送ると、それまでに起こされた変化は受領済みになる（ack を兼ねる）。
    同じ依頼 ID の打ち直しでは、開いている見張りがあるときはその設定を使う。
- chat watch list [--all] --json
    開いている見張りを一覧にする。pending は未受領の変化の数。--all で閉じた見張りも表示する（30 日分）。
- chat watch update <会話ID> [--mode continue|notify] [--ttl <分>] [--note] --json
    モード・期限・メモ（--note を付けて標準入力で渡す）のうち指定したものを変え、未受領の変化を受領済みにする。
- chat watch remove <会話ID> --reason done|handed_over|boss_stop|other --json
    見張りを閉じる。done は目的を達成した、handed_over は利用者に引き継いだ、boss_stop は利用者の指示で止めた、other はその他。
- chat watch poll [--wait <秒>] --json
    フックなどから繰り返し呼び、wake: true のとき items を処理する。nextPollSec（処理中・入力待ち・未受領ありは 30、待機は 120、
    見張りなしは 300）秒後にまた呼ぶ。items[].note と reasons を見て次にすることを判断する。
    --wait は 0〜100 秒。変化が無ければ 1 秒おきに確認して、変化が出るか指定の時間まで待つ。
    source は、すべての見張りで出来事の履歴を使えたとき events+state、履歴が無いか、一部で状態だけを照合したとき state。
    - turn_ended: ターンが終わった。outcome は completed / interrupted / unknown。unknown は返答が増えないまま待機に戻ったことを示す。
      履歴が使えた見張りでは failed と短い error も返る。状態だけの照合では API エラーが completed になることがあり、エラーは返答本文で確かめる。
    - question: 設問への回答待ち。waiting.question に中身がある。
    - approval: 承認待ち。waiting.approvals に中身がある。
    - waiting_other: 画面での確認など、設問・承認以外の入力待ちが続いている。
    - usage_limit: 使用量制限の再開待ち。分かる場合は resumeAt に時刻がある。continue の見張りに返る。
    - human_activity: 利用者の操作。detail は message（アプリの発話。count と lastAtMs 付き）、approval（アプリの承認判断）、
      answer（アプリや端末での設問への回答）。端末への直接の発話は chat read の source で見分ける。
    - stopped_mid_turn: 処理中か入力待ちの Claude の会話が、新しい返答を残さず止まった。
    - deleted: 会話の記録が無くなり、見張りを閉じた。
    - expired: 期限切れで見張りを閉じた。unacked: true は未受領の変化が残っていた印。
    返答は chat status <会話ID> --after <lastRequestId> --json か、chat read <会話ID> --after <readCursor> --json で読む。
- chat watch ack <会話ID> --token <トークン> [--read-cursor <カーソル>] --json
    処理が済んだら items[].token を渡す。その番号までを受領済みにし、--read-cursor があれば読んだ位置を控える。
    未受領のまま 10 分たつと redelivery: true で起こし直す（3 回まで）。新しい変化が増えたときはすぐ起こす。
- 期限は既定 24 時間、上限 7 日（1〜10080 分）。期限切れと削除は 1 回起こしてから閉じる。closed.reason に理由が載る。
  会話を止めても見張りは続く。watch_busy（終了コード 6）は少し待って打ち直す。

## 出来事の履歴（chat events）
- chat events [--after <カーソル>] [--conversation <会話ID>] [--type <種別,種別>] [--limit <件数>] [--wait <秒>] --json
    hub が観測した出来事を調べる。ふだん会話の変化を待つときは chat watch poll を使う。
    省略時は末尾から 50 件を古い順で返す。--limit は 1〜200。--conversation は会話 ID または収容先の会話名で照合する。
    --type は hub_started、turn_started、turn_ended、question_asked、question_resolved、approval_requested、
    approval_resolved、message_delivered、usage_limit、session_ended をコンマで区切る。
    cursors.after の <seq>:<atMs> を次の --after に渡すと、その後から古い順に読める。hasMore は条件に合う残りがある印。
    --wait は --after と一緒に使い、0〜100 秒待つ。gap: true は間の履歴が消えたか、hub が起動し直した印。
    stale_cursor（終了コード 2）が出たら --after を付けずに取り直す。設問や返答の本文は chat status や chat read で確かめる。

## 承認できる人が居ないとき
- このコマンドが起動した会話（new・take-over など）で、iPhone のアプリがつながっておらず、通知を受ける端末も無く、Bot の承認も許されていなければ、
  ツールの承認は待たずに拒否され、Claude には「許可の要らない方法で進めるか、止めて報告する」と伝わる。

## 依頼 ID（--request-id）
- new / send / set-model / set-mode に必須。同じ依頼 ID で打ち直すと、同じ会話・同じ送信として扱われ二重にならない。終了コード 6・7 は同じ ID で打ち直す。
- 依頼ごとに新しい ID を使う（例: UUID）。

## 出力（--json）
- 標準出力に JSON 1 個: {"v":1,"ok":true,...} または {"v":1,"ok":false,"error":{"code","message","hint"}}。
- hint は次に打つべきコマンドや人に伝えること。

## 終了コード
- 0 成功（status が処理中でも 0。state を見る）
- 1 内部エラー
- 2 使い方の誤り・許可されていない作業フォルダ・指示文が空。read / search の stale_cursor は、カーソルが今の記録と合わない
  （記録が組み替わった・別の会話のカーソル）。chat read <会話ID> --last <件数> で取り直す。events の stale_cursor は --after を付けずに取り直す
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
  エラーの JSON に conversationId があれば chat status <会話ID> --after <依頼ID> の delivery で確かめられる（set-model / set-mode の依頼には使えない。同じ依頼 ID で打ち直す）。
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
