// 初回ページは iOS の 10 秒より先に止め、全履歴へのフォールバックと重ねない。
export const LATEST_HISTORY_PAGE_TIMEOUT_MS = 9_000;
export const LATEST_HISTORY_PAGE_RPC_TIMEOUT_MS = 9_500;
// 遡るページの既存の待ち時間は保つ（iOS は 25 秒）。
export const OLDER_HISTORY_PAGE_TIMEOUT_MS = 20_000;
export const OLDER_HISTORY_PAGE_RPC_TIMEOUT_MS = 22_000;
