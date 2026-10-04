// readFailures.ts
// tailii (TS host) — 会話ファイルの読み取りが I/O エラーで失敗した回数（session-list-memo-persist）。
//
// 一覧の導出（transcript / rollout の先頭・末尾の読み取り）は失敗しても例外を出さず、劣化した結果
// （id 先頭のタイトル・プレビューなし・メタ不明）を返す。その結果を mtime + size で覚えると、
// 一時的な失敗（EMFILE・EIO・権限）が直ってもファイルが変わらない限り劣化したまま残り、メモを
// ディスクへ引き継ぐと engine を作り直しても直らない。導出の前後でこの回数を比べ、増えていたら
// メモに入れない。導出は同期処理なので、前後の差はその導出の分だけになる。

let failures = 0;

/** 読み取りの例外を記録する。中身の問題（JSON の構文エラーなど）は数えない。 */
export function noteReadFailure(error: unknown): void {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    failures += 1;
  }
}

/** これまでの I/O エラーの回数（前後の差だけを使う）。 */
export function readFailureCount(): number {
  return failures;
}
