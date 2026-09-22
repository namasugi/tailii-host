# pane フィクスチャ（無加工の生キャプチャ）

claude 2.1.278 の実機 TUI を tmux `capture-pane -p -e`（ANSI 付き・viewport のみ）で
そのまま採取したもの。**編集しないこと**: 空行や罫線を落とすと検出器が偽の緑になる
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

ダイアログの 2 枚は `extractClaudeInputBox` が本体の罫線ペアを入力欄と誤認し、
`inputBoxRealText` がカーソル行（`1. Yes` / 選択肢全文）を「未送信テキスト」として返す。
送信確定ループがこれを信じて Enter を撃つと選択肢を誤操作するため、
`claudeComposerBarVisible` でバーが見えているときだけ入力欄として扱う（再送の判定）。
一方「本文を打つかどうか」の門番は `screenShowsDialogFooter` の**積極判定**で行う:
バー非検出をダイアログ扱いにすると、未知のフレーム（起動直後・制限待ち等）で送信が
丸ごと不能になるため。見逃し側は従来動作に落ちるだけで済む。
