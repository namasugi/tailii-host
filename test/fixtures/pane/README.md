# pane フィクスチャ（無加工の生キャプチャ）

claude 2.1.278（`question-dialog-multi` / `question-declined` / `queued-*` は 2.1.283）の実機 TUI を
tmux `capture-pane -p -e`（ANSI 付き・viewport のみ）でそのまま採取したもの
（`queued-herdr` だけは herdr 0.7.5 の `pane read --source visible --format ansi`）。**編集しないこと**: 空行や罫線を落とすと検出器が偽の緑になる
（2026-07-28 の実障害。空行を `awk 'NF'` で落としたフィクスチャで 2 周分の調査を浪費した）。

| ファイル | 状態 | ボトムバー |
| --- | --- | --- |
| `idle.ansi` | 送信成立後のアイドル | `⏸ manual mode on · ? for shortcuts · ← for agents` |
| `typed.ansi` | 本文を打った直後（未送信） | `⏸ manual mode on`（本文があると定型句が消える） |
| `invisible-hold.ansi` | 不可視文字の確認待ち（2.1.277+。1 回目の Enter 後） | `⏸ manual mode on` |
| `shell-mode.ansi` | シェルモード（入力欄の先頭 `!`。本文あり） | `! for shell mode`（**モード記号を持たない**） |
| `accept-edits.ansi` | acceptEdits モード（入力欄は空） | `⏵⏵ accept edits on (shift+tab to cycle) · ← for agents` |
| `processing.ansi` | 応答生成中（本文は送信済み・入力欄は空） | `⏸ manual mode on · esc to interrupt · ← for agents` |
| `question-dialog.ansi` | AskUserQuestion の設問ダイアログ | `Enter to select · ↑/↓ to navigate · Esc to cancel` |
| `approval-dialog.ansi` | ツール承認ダイアログ（Write） | `Esc to cancel · Tab to amend` |
| `question-dialog-multi.ansi` | AskUserQuestion の複数設問（タブ付き） | `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` |
| `question-declined.ansi` | 上の設問を Esc で閉じた直後（`User declined to answer questions`・入力欄は空） | `⏵⏵ auto mode on (shift+tab to cycle) · ← for agents` |
| `approval-safety-artifact.ansi` | 2.1.283・hook が allow を返しても残る安全確認（作業フォルダ外への Artifact 保存。理由の引用枠 `│` が選択肢と同じ深さ） | `Esc to cancel · Tab to amend` |
| `approval-cursor-moved.ansi` | 2.1.283・Edit の承認でカーソルを 2 番目へ動かした画面（フッターから `· Tab to amend` が消える。2 番目の選択肢は折り返す） | `Esc to cancel` |
| `queued-tool.ansi` | ツールの実行中に送った発話が CLI のキューで待っている（1 件） | `⏸ manual mode on · esc to interrupt · ← for agents` |
| `queued-streaming-multi.ansi` | 応答の生成中にキュー済み 2 件（スピナー行が無い） | `⏸ manual mode on · 1 monitor · esc to interrupt · ← for agents · ↓ to manage` |
| `queued-wrapped.ansi` | 添付のパスで始まる長い発話（2 桁字下げで折り返す） | `⏸ manual mode on · esc to interrupt · ← for agents` |
| `queued-herdr.ansi` | herdr で採取したキュー済み 1 件（ヒントが `ctrl+enter to send now`） | `⏸ manual mode on · esc to interrupt · ← for agents` |
| `queued-with-draft.ansi` | キュー済み 1 件 + 入力欄に未送信の下書き | `⏸ manual mode on` |
| `queued-paste-hint.ansi` | 貼り付け扱いの長文（924 字）を送った直後。キュー済み 1 件 | **`paste again to expand`**（バーの位置が案内に替わる。十数秒続く） |
| `queued-paste-hint-draft.ansi` | 同上 + 入力欄に未送信の下書き | `paste again to expand` |
| `typed-paste-placeholder.ansi` | 1 行 1000 字を貼り付けた直後（2.1.284）。入力欄は `[Pasted text #16]` | `paste again to expand` |
| `pasted-multiline.ansi` | 30 行 1665 字を括弧付きで貼り付けた直後。入力欄は `[Pasted text #20 +29 lines]` | `paste again to expand` |
| `pasted-restored.ansi` | 貼り付けた発話を送り、出力の前に中断した直後。`[Pasted text #22]` として書き戻される | `paste again to expand` |
| `pasted-inline-multiline.ansi` | 30 行 1665 字を小分けの括弧付き貼り付け（1 行ずつ）で渡した直後。入力欄には本文がそのまま入り、末尾側が映る | `⏸ manual mode on` |
| `pasted-inline-tabs.ansi` | 120 行のタブ入りコードを同じ方法で渡した直後。タブは空白 4 個になっている | `⏸ manual mode on` |
| `pasted-inline-ascii.ansi` | 1 行 1200 字を 500 字ずつの括弧付き貼り付けで渡した直後 | `⏸ manual mode on` |
| `pasted-inline-partial.ansi` | 30 行のうち 11 行まで渡した時点（途中まで入った形） | `⏸ manual mode on` |
| `pasted-inline-truncated.ansi` | 1 行 10520 字を小分けの貼り付けで渡した直後。入力欄は「先頭 500 字 + `[...Truncated text #102 +0 lines...]` + 10000 字目以降」 | `⏸ manual mode on` |
| `pasted-inline-truncated-lines.ansi` | 200 行 10509 字を同じ方法で渡した直後。置き換えの表示は映っている範囲の上にあり、末尾の行だけが映る | `⏸ manual mode on` |
| `named-idle.ansi` / `named-idle-herdr.ansi` | 名前付きの会話（`/rename` 済み）の待機中。上の罫線にタイトルが右寄せで埋まり、**行末の罫線は 1 個だけ**（`────…──── chk12-title ─`）。tmux / herdr | `⏸ manual mode on · ? for shortcuts · ← for agents` |
| `named-history.ansi` | 名前付きの会話で、履歴に `❯` の行や応答が見えている待機中（入力欄は空） | 同上 |
| `named-long-idle.ansi` / `named-long-truncated.ansi` / `named-long-history.ansi` | タイトルの長い名前付きの会話の待機中。上の罫線は `─ <タイトル> ─`（行頭の罫線 1 個）/ ` <タイトル>… ─`（切り詰め。行頭は空白）/ 履歴が見えている画面 | `⏸ manual mode on · ? for shortcuts · ← for agents` |
| `named-long-draft-statusline.ansi` | タイトルの長い会話で、入力欄に下書き `mac draft line` があり、下に statusLine の行 `  ───── haiku │ main ─` が出ている | `⏸ manual mode on` |
| `named-shell.ansi` | 名前付きの会話（タイトル `fox`。2.1.285）で、シェルモードのまま入力欄が空。プロンプトは `!` | `! for shell mode` |
| `named-shifted-history-rule.ansi` / `named-long-shifted-history-rule.ansi` | 肌色付きの絵文字（✌🏽）を含む発話の後で tmux の画面が崩れた形（2.1.285）。下の枠が消え、その位置に空の `❯` が出る。履歴に行頭（0 桁目）から罫線で始まる行 `─────── tail` が見えている。タイトルは `fox` / pane の幅より長いタイトル | `⏸ manual mode on · ? for shortcuts · ← for agents` |
| `named-long-history-rule.ansi` / `named-long-history-rule-draft.ansi` | タイトルの長い会話（2.1.285）で、履歴に行頭（0 桁目）から罫線で始まる行 `─────── tail` が見えている（`/rename` の控えの折り返し。続きの行は字下げされない）。入力欄は空 / 3 行の下書き（空行と、罫線で始まる行を含む） | `⏸ manual mode on · ← for agents` / `⏸ manual mode on` |
| `named-pasted-rule-line.ansi` / `named-pasted-multiline.ansi` | 名前付きの会話で、罫線だけの行を含む 3 行 / 30 行を小分けの貼り付けで渡した直後 | `⏸ manual mode on` |
| `pasted-inline-rule-line.ansi` | 罫線だけの行を含む 3 行（`…X` / `──────────` / `以上`）を小分けの貼り付けで渡した直後。入力欄の中の罫線の行は字下げされている（枠の罫線は行頭から始まる） | `⏸ manual mode on` |
| `pasted-inline-shifted.ansi` | 肌色付きの ✌🏽 を含む発話を表示して tmux の画面が崩れた後に、30 行を小分けの貼り付けで渡した直後。入力欄が 1 行ずれ、下の罫線の位置に空の `❯` が 2 行出る。本文は入力欄に入っているが、入力欄として読めない（`unknown`） | （モード行が出ない） |
| `typed-as-paste.ansi` | 1200 字を括弧なしで 1 回で打った直後（直前の貼り付けの案内が出ていた）。先頭の 1022 字は入力欄に入らず、残り 178 字だけが本文 | `paste again to expand` |
| `queued-sent.ansi` | 「今すぐ送信」の直後（ヒントが消え、実行中だったシェルが背景へ回った） | `⏸ manual mode on · 1 shell · esc to interrupt · ← for agents · ↓ to manage` |
| `fullscreen-busy.ansi` | fullscreen 表示（`tui: "fullscreen"`, 2.1.285）でシェルの実行中。最新位置を見ている（スピナーが見える） | `⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents` |
| `fullscreen-scrolled-busy.ansi` | 同じ実行中に PgUp で上へスクロールした画面。スピナーは画面外で、スクロール領域の最下行（過去のターンの `✻ Cogitated for 5s …`）の中央に案内 `Jump to bottom: fn+↓ to scroll` が重なる（背景が無いので、長い行なら案内の左右に下の本文が残る）。処理中でも画面は変わらない | 同上 |
| `fullscreen-scrolled-idle.ansi` | スクロールしたまま処理が終わった画面。案内は `1 new message: fn+↓ to scroll` に変わる | `⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents` |

キュー済みの 7 枚（chat-send-now）は、発話の直下に `ctrl+x ctrl+s to send now`
（herdr は `ctrl+enter to send now`）のヒント行が出る。入力欄は空でも薄字のプレースホルダー
`Press up to edit queued messages` が入る（実テキストには数えない）。

ダイアログの 2 枚は `extractClaudeInputBox` が本体の罫線ペアを入力欄と誤認し、
`inputBoxRealText` がカーソル行（`1. Yes` / 選択肢全文）を「未送信テキスト」として返す。
送信確定ループがこれを信じて Enter を撃つと選択肢を誤操作するため、
`claudeComposerBarVisible` でバーが見えているときだけ入力欄として扱う（再送の判定）。
一方「本文を打つかどうか」の門番は `screenShowsDialogFooter` の**積極判定**で行う:
バー非検出をダイアログ扱いにすると、未知のフレーム（起動直後・制限待ち等）で送信が
丸ごと不能になるため。見逃し側は従来動作に落ちるだけで済む。
